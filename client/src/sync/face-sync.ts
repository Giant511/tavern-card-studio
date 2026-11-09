/**
 * 上传卡面时的"要不要传"决策（v0.1.7 修订二）。
 *
 * ## 这里有三件事容易做错
 *
 * 1. **传什么字节**：`pngSource.bytes` 是**含卡数据块**的完整 PNG（导入时保留原图）。
 *    直接传它等于把 JSON 又存了一份 —— 而 JSON 已经在版本流里了，
 *    且这份副本会随每次换封面而扩散。所以先 `stripPngCardData` 掉 `chara`/`ccv3`，
 *    只上传**纯图**。取回时再用 `buildPngCard(纯图, 当时的 JSON)` 组装回去 ——
 *    这正是"PNG 组装推迟到推 ST / 导出那一刻"的落地。
 *
 * 2. **什么时候不传**：用户明确要求"卡面 hash 未变则只传 JSON"。
 *    判断依据是**客户端记的上次摘要**（`session.lastUploadedFaceSha`），
 *    不是"看起来一样"。图片字节里 PNG 的编码器版本、时间戳都能让两张
 *    视觉相同的图摘要不同 —— 但那种情况本来就该传（内容确实变了）。
 *
 * 3. **失败要不要影响上传**：**不影响**。卡面是资产，JSON 才是内容。
 *    卡面传失败时内容已经上去了，这时候把整个上传判失败会让用户
 *    "改了半天设定没保存"——而实际上保存了。所以这里只返回 `reason`，
 *    由调用方决定提示措辞。
 */

import { stripPngCardData } from '../../../shared/src/png-card.ts';

export interface FaceSyncInput {
  /** 当前卡的图源字节（含卡数据块）；null = 这张图没有图源 */
  pngBytes: Uint8Array | null;
  /**
   * **已经压好**的仓库资产（v0.1.7 增补二）。
   *
   * 给了它就走它，不再回看 `pngBytes` —— 因为压缩必须经过 canvas
   * （`face-encode.ts` 的 `buildStoreFace`），那是 DOM 能力，塞进这个纯逻辑
   * 模块会连带把它的可测试性毁掉。所以由调用方压好再传进来。
   *
   * 不给则退回旧路径：剥掉卡数据块后上传 PNG 原图。那条路只在
   * "压缩能力不可用"（老渲染层 / canvas 失败）时才会走到。
   */
  prepared?: { bytes: Uint8Array; mime: string } | null;
  /** 上次成功上传的卡面摘要；null = 还没传过 */
  lastUploadedSha: string | null;
  /** 注入的上传动作（便于测试；真实实现走 `uploadFace`） */
  upload: (bytes: Uint8Array, mime: string) => Promise<{ changed: boolean; sha256: string }>;
}

export interface FaceSyncOutcome {
  /** 这次真的发了请求吗 */
  attempted: boolean;
  /** 服务端最终认下的摘要（null = 这张卡没有卡面） */
  sha256: string | null;
  /** 给界面/日志的一句话；空串 = 无需说明 */
  note: string;
}

/** 卡面允许的 MIME。与 `server/src/storage/cards.ts` 的 `FACE_MIME_ALLOWED` 同源 */
const FACE_MIME = 'image/png';

/**
 * 需要时上传卡面。
 *
 * 返回的 `sha256` 应当写回 `session.noteFaceUploaded(...)`：
 * 即便这次没上传（摘要没变），也要保证会话里记的是"服务端当前那份"。
 */
export async function syncFaceAfterUpload(input: FaceSyncInput): Promise<FaceSyncOutcome> {
  const { pngBytes, prepared, lastUploadedSha, upload } = input;

  /*
   * 有压好的资产就直接用（增补二的主路径）。
   *
   * 它已经是**纯图**（WebP 或者平涂的 PNG 原样），不含卡数据块 ——
   * 所以我们只要算摘要、判断要不要传，不必再剥一次。
   */
  if (prepared !== undefined && prepared !== null && prepared.bytes.byteLength > 0) {
    return uploadIfChanged(prepared.bytes, prepared.mime, lastUploadedSha, upload);
  }

  /*
   * 没有图源：什么都不做，但**要清掉上次记的摘要** ——
   * 否则用户把图删了（换成无图卡）之后，会话里还记着旧摘要，
   * 下次他又加回同一张图时会被判"没变"而跳过上传，
   * 于是服务端留着旧图，本地显示新图，两边不一致。
   */
  if (pngBytes === null) {
    return { attempted: false, sha256: null, note: '' };
  }

  let stripped: Uint8Array;
  try {
    stripped = stripPngCardData(pngBytes);
  } catch {
    /*
     * 剥不掉（不是合法 PNG / 结构异常）时**不上传**而不是传原图：
     * 原图带着整份 JSON，传上去等于把内容存了两份，而且会随每次换封面扩散。
     * 记一句提示，让用户知道这次封面没存上。
     */
    return {
      attempted: false,
      sha256: lastUploadedSha,
      note: '卡面没能去卡数据块（图片结构异常），这次没有上传封面。',
    };
  }

  return uploadIfChanged(stripped, FACE_MIME, lastUploadedSha, upload);
}

/** 算摘要、判断"变没变"、需要时上传。两条入口（压好的 / 剥好的）共用。 */
async function uploadIfChanged(
  bytes: Uint8Array,
  mime: string,
  lastUploadedSha: string | null,
  upload: FaceSyncInput['upload'],
): Promise<FaceSyncOutcome> {
  const sha = await sha256Hex(bytes);
  if (sha === lastUploadedSha) {
    // 内容没变：只传了 JSON，这是常态路径，不需要给用户任何提示
    return { attempted: false, sha256: sha, note: '' };
  }

  try {
    const result = await upload(bytes, mime);
    /*
     * 服务端说 changed:false 有两种可能：
     *   · 它的摘要和我们算的一样（正常）；
     *   · 服务端裁剪过内容（不存在这种情况，它按原始字节存）。
     * 所以直接采用服务端返回的摘要 —— 那是"真正存下来的那份"。
     */
    return {
      attempted: true,
      sha256: result.sha256 === '' ? sha : result.sha256,
      note: '',
    };
  } catch (error) {
    // 卡面失败不上升到"上传失败"（见文件头第 3 条）
    return {
      attempted: true,
      sha256: lastUploadedSha,
      note: `卡片内容已保存，但封面没能上传：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 字节的 sha256（十六进制）。
 *
 * 用 WebCrypto：Tauri 渲染层（Chromium）与 Node 20+ 都有 `crypto.subtle`，
 * 与 `export-card.ts` 里算导出摘要用的是同一套。
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 复制成独立的 ArrayBuffer：subarray 视图的 byteOffset 会让 digest 算错
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
