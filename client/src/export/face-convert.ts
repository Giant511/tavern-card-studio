/**
 * 卡面转码：非 PNG → PNG 容器（v0.1.4 / T12.5，需求 F4.3）。
 *
 * ## 为什么这里允许重新编码
 *
 * 决策 D1 的"零重编码"承诺只针对**PNG 图**：那是"这张 PNG 卡的像素不许动"。
 * 而用户主动挑一张 jpg / webp 当封面时，要把它放进 PNG 容器里，
 * 必然要解码再编码 —— 这是**用户明确要求的动作**，不是我们偷偷做的。
 *
 * 所以两类路径泾渭分明：
 *   · PNG 图 → `buildPngCard` 直接塞块，像素逐字节不变；
 *   · 其他格式 → 走这里，一次 canvas 重编码，并提示"已转为 PNG"。
 *
 * ## 为什么用 canvas 而不是引解码库
 *
 * WebView2 自带解码器，`createImageBitmap` 能吃 jpg/webp/png。
 * 引一个 wasm 解码库要多几 MB 产物体积，且要自己保证与浏览器行为一致。
 *
 * ## 4096 长边上限
 *
 * 不设上限的话，用户拿一张 12000×8000 的手机照片当封面，会得到一个
 * 几十 MB 的 PNG（canvas 的 PNG 编码对照片极不友好），导出与上传都会很难看。
 * 超过就等比压缩，**并且必须提示** —— 静默改尺寸是"用户以为没变"的那类错。
 */

import { scaledSize, faceScale, FACE_MAX_EDGE } from './face-library.ts';

export interface ConvertedFace {
  bytes: Uint8Array;
  /** 原始尺寸 */
  originalWidth: number;
  originalHeight: number;
  /** 转换后尺寸 */
  width: number;
  height: number;
  /** 是否做了等比压缩（true 时 UI 必须提示） */
  scaled: boolean;
  /** 给用户看的一句话 */
  note: string;
}

/** canvas 不可用时的明确错误（不要静默返回空字节） */
export class FaceConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceConvertError';
  }
}

/**
 * 把任意浏览器可解码的图片转成 PNG 容器。
 *
 * `mime` 只用于错误信息与提示文案（"已把 JPG 转为 PNG"），
 * 真正的格式判定交给浏览器解码器。
 */
export async function convertToPng(
  bytes: Uint8Array,
  fileName: string,
  /**
   * 长边上限（px）。缺省 4096 —— 桌面端导出的既有规格。
   *
   * ## 为什么调用方要能改小（2026-11-11）
   *
   * 安卓 WebView 上这条路径曾被怀疑跑不动：仓库下载一张有卡面的卡，
   * 拉图花了 13 秒（说明图确实到了），结果仍是首字封面 —— 转码抛错被吞。
   *
   * 4096×4096 的 canvas 是 **16M 像素 / 约 64MB**，再 PNG 编码一遍，
   * 手机 WebView 很容易在这里失败或假死。而卡面最终显示的地方（角色列表、
   * 聊天顶栏）最大也就几百 px —— **用 4096 是浪费，也是风险**。
   *
   * 所以把上限变成参数：桌面导出维持 4096（不改变既有产物），
   * 移动端下载用 1024。
   */
  maxEdge: number = FACE_MAX_EDGE,
): Promise<ConvertedFace> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new FaceConvertError(
      '当前环境不支持图片转码（需要浏览器的 canvas 能力）——请在桌面客户端里选择非 PNG 卡面',
    );
  }

  /*
   * 复制成独立 buffer：`bytes` 可能是某个大 Uint8Array 的视图，
   * Blob 会按视图长度拷贝，显式 slice 一次避免"传了 5MB 只用了 200KB"的误解。
   */
  const sourceBlob = new Blob([bytes.slice()], { type: guessMime(fileName) });

  /*
   * ★★★ 解码要两条路（2026-11-11）。
   *
   * ## 为什么要加 `<img>` 兜底
   *
   * 这里原来只有 `createImageBitmap(blob)`。它在桌面 WebView 上一直好使
   * （桌面端导出用的就是这条），但**安卓 WebView 从没验证过** ——
   * 而安卓上正好有一条新逻辑要用它（仓库下载把 webp 卡面转成 PNG 当底图）。
   *
   * 真机现象：下载一张有卡面的卡，耗时 13 秒（说明图确实拉下来了），
   * 最终却仍是首字封面 —— 转码抛错，而调用处又把它 catch 掉了，
   * 于是**整个过程一声不响地降级**。
   *
   * 两条路的意义：`createImageBitmap` 快但依赖新 API；
   * `<img>` + `decode()` 老得多、兼容性更好，而且 WebView 对 webp 的
   * `<img>`解码支持比 `createImageBitmap(Blob)` 更普遍。
   *
   * 顺序：先试快的，失败再走兼容路 —— 不改变桌面端行为。
   */
  let bitmap: ImageBitmap | HTMLImageElement;
  let decodeError = '';
  try {
    bitmap = await createImageBitmap(sourceBlob);
  } catch (first) {
    decodeError = first instanceof Error ? first.message : String(first);
    const image = document.createElement('img');
    try {
      bitmap = await decodeWithImgElement(image, sourceBlob);
    } catch (second) {
      const secondText = second instanceof Error ? second.message : String(second);
      throw new FaceConvertError(
        `这张图无法解码（${fileName}）：createImageBitmap 失败（${decodeError}），` +
          `<img> 兜底也失败（${secondText}）—— 可能已损坏，或不是 WebView 支持的图片格式`,
      );
    }
  }

  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const size = scaledSize(originalWidth, originalHeight, maxEdge);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    bitmap.close();
    throw new FaceConvertError('无法创建 canvas 上下文（显存不足？）');
  }

  // 透明底：jpg 没有 alpha，转成 PNG 后边缘不该出现黑边
  context.clearRect(0, 0, size.width, size.height);
  /* drawImage 要的是 CanvasImageSource，`<img>` 与 ImageBitmap 都能直接传 */
  context.drawImage(drawTarget(bitmap), 0, 0, size.width, size.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });
  if (blob === null) {
    throw new FaceConvertError('PNG 编码失败（图片可能过大）');
  }

  const converted = new Uint8Array(await blob.arrayBuffer());
  const ratio = faceScale(originalWidth, originalHeight, maxEdge);
  const note =
    size.scaled === true
      ? `已把 ${fileName} 转为 PNG，并把长边从 ${String(Math.max(originalWidth, originalHeight))}px ` +
        `等比压到 ${String(maxEdge)}px（比例 ${(ratio * 100).toFixed(1)}%）`
      : `已把 ${fileName} 转为 PNG（${String(originalWidth)}×${String(originalHeight)}，未缩放）`;

  return {
    bytes: converted,
    originalWidth,
    originalHeight,
    width: size.width,
    height: size.height,
    scaled: size.scaled,
    note,
  };
}

/**
 * 用 `<img>` 元素解码图片，返回等价的 ImageBitmap 形状（宽高 + 可画）。
 *
 * 为什么能当 `ImageBitmap` 用：`drawImage` 接受任何 `CanvasImageSource`，
 * 而 `HTMLImageElement` 就是其中之一。我们只需要 `width` / `height` /
 * 能被 `drawImage` / 能 `close`（img 没有 close，用可选判断）。
 */
async function decodeWithImgElement(
  image: HTMLImageElement,
  blob: Blob,
): Promise<ImageBitmap & { close: () => void }> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('img.onerror（格式不支持或数据损坏）'));
      image.src = url;
    });
    /*
     * `decode()` 只在部分内核里有，有就等它（保证可以立刻 drawImage），
     * 没有就用 onload 的结果 —— 两者都表示"已经可以画了"。
     */
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch {
        /* decode() 失败但 onload 成功时仍可画，不当作致命错误 */
      }
    }
    /*
     * 包一层：把 img 伪装成 ImageBitmap 的消费面。`close` 用空实现，
     * 因为下面的释放逻辑是 `URL.revokeObjectURL`（在 finally 里）。
     */
    const wrapped = {
      width: image.naturalWidth,
      height: image.naturalHeight,
      close: () => {},
    };
    /*
     * `drawImage` 要真的拿到 img —— 所以把 img 挂到这个包装对象上，
     * 由调用方用 `drawTarget()` 取出。
     */
    Object.defineProperty(wrapped, 'drawTarget', { value: image, enumerable: false });
    return wrapped as unknown as ImageBitmap & { close: () => void };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 从"可能是 ImageBitmap 也可能是 img 包装"的对象里取出能 drawImage 的东西 */
function drawTarget(source: ImageBitmap | HTMLImageElement): CanvasImageSource {
  const wrapped = source as unknown as { drawTarget?: CanvasImageSource };
  return wrapped.drawTarget ?? (source as unknown as CanvasImageSource);
}

function guessMime(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')) return 'image/jpeg';
  if (lowered.endsWith('.webp')) return 'image/webp';
  if (lowered.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

/** 读图片尺寸（不转码）。给"选中即预览（缩略图 + 文件名 + 尺寸）"用 */
export async function readImageSize(
  bytes: Uint8Array,
  fileName: string,
): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const blob = new Blob([bytes.slice()], { type: guessMime(fileName) });
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}
