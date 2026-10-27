/**
 * 「另存为 PNG」时的卡面解析（v0.1.5 / G6）。
 *
 * ## 与「导出」的区别
 *
 * 导出面板里用户可以挑图库里的任意一张；另存为不提供这一步（它只问格式）。
 * 所以这里按**卡自身的封面**取图，顺序固定：
 *
 *   1. 会话原图（PNG 卡导入的，像素逐字节不动 —— 零重编码）；
 *   2. 图库目录里上次记住的那张（`lastFaceChoice = lib:<名>`）；
 *   3. 内置默认卡面。
 *
 * 刻意**不给** `source`/`default` 之外的"浏览选择"：那是一次性动作，
 * 不该被一次"另存为"记住，也不该让用户以为下次保存还是那张图。
 *
 * ## 为什么单独成一个模块
 *
 * 三段回落 + 三种失败模式（无壳、文件没了、jpg 要转码）都是"选错了产物就不对"
 * 的分支，必须能单测。放在 App 里就只能靠界面点出来。
 */

import { isShellAvailable, readDefaultFace, type BinaryFile } from '../contract';
import { convertToPng } from '../export/face-convert';
import { decodeFaceChoice, faceLibraryDir, needsPngConversion, type FaceChoice } from '../export/face-library';

/** 解析所需的最小依赖（便于单测注入） */
export interface SaveFaceDeps {
  /** 会话原图字节（PNG 卡导入才有） */
  sourceBytes: () => Uint8Array | null;
  /** 角色卡目录（图库 = <cardsDir>/card-faces）；空串 = 未配置 */
  cardsDir: () => Promise<string>;
  /** 上次记住的卡面（`lib:<名>` / `source` / `default`）；null = 没记过 */
  remembered: () => string | null;
  /** 读图库里的一张（返回原始字节与文件名） */
  readLibraryFile: (path: string) => Promise<{ bytes: Uint8Array; fileName: string }>;
  /** 读内置默认卡面 */
  readDefault: () => Promise<Uint8Array>;
}

export interface ResolvedSaveFace {
  bytes: Uint8Array;
  /** 这张图是从哪来的（写进状态栏，用户才知道刚才用了哪张封面） */
  from: 'source' | 'library' | 'default';
  /** 图库那张的文件名（仅 from === 'library' 时有值） */
  fileName: string | null;
  /** 转码提示（jpg/webp → PNG，或长边被压缩） */
  note: string;
}

/**
 * 按固定顺序取卡面。**失败时说清是哪一步失败、用户能怎么办。**
 *
 * 返回 `null` 表示"当前环境做不了 PNG"（浏览器无壳），调用方应禁用该选项 ——
 * 而不是抛一个用户看不懂的错。
 */
export async function resolveSaveFace(deps: SaveFaceDeps): Promise<ResolvedSaveFace | null> {
  // ── 1. 会话原图 ──
  const source = deps.sourceBytes();
  if (source !== null) {
    return { bytes: source, from: 'source', fileName: null, note: '' };
  }

  // ── 2. 上次记住的图库那张 ──
  const remembered = decodeFaceChoice(deps.remembered());
  if (remembered?.kind === 'library') {
    const libraryHit = await tryLibrary(deps, remembered);
    if (libraryHit !== null) return libraryHit;
    /*
     * 记住的那张没了（被删/改名）—— 静默退回默认卡面，但**不抛错**：
     * 用户只是点了个「另存为」，不该被"你上次选的图不见了"拦住。
     * 状态栏会说清最后用了哪张（`from`）。
     */
  }

  // ── 3. 内置默认卡面 ──
  if (!isShellAvailable()) return null;
  return { bytes: await deps.readDefault(), from: 'default', fileName: null, note: '' };
}

async function tryLibrary(
  deps: SaveFaceDeps,
  choice: Extract<FaceChoice, { kind: 'library' }>,
): Promise<ResolvedSaveFace | null> {
  const cardsDir = await deps.cardsDir();
  if (cardsDir === '') return null;

  let file: { bytes: Uint8Array; fileName: string };
  try {
    file = await deps.readLibraryFile(`${faceLibraryDir(cardsDir)}/${choice.name}`);
  } catch {
    return null; // 文件不在了，交给下一级回落
  }

  if (!needsPngConversion(file.fileName)) {
    return { bytes: file.bytes, from: 'library', fileName: file.fileName, note: '' };
  }
  // jpg/webp 必须转码：PNG 卡的数据块要挂在一张**真 PNG** 上
  const converted = await convertToPng(file.bytes, file.fileName);
  return {
    bytes: converted.bytes,
    from: 'library',
    fileName: file.fileName,
    note:
      converted.width === converted.originalWidth && converted.height === converted.originalHeight
        ? `已把 ${file.fileName} 转为 PNG`
        : `已把 ${file.fileName} 转为 PNG，并等比压缩到 ${String(converted.width)}×${String(converted.height)}`,
  };
}

/** 契约返回的 base64 → 字节，并核对声明长度（与 face-picker 同一套校验） */
export async function decodeBinaryFile(binary: BinaryFile): Promise<Uint8Array> {
  const clean = binary.base64.replace(/\s/g, '');
  const raw = atob(clean);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (bytes.length !== binary.bytesLen) {
    throw new Error(`读取字节数与声明不符（${String(binary.bytesLen)} vs ${String(bytes.length)}）`);
  }
  return bytes;
}

/** App 用的真实实现：只做依赖绑定，逻辑全在上面 */
export function defaultSaveFaceDeps(input: {
  sourceBytes: () => Uint8Array | null;
  cardsDir: () => Promise<string>;
  remembered: () => string | null;
  readLibraryFile: (path: string) => Promise<{ bytes: Uint8Array; fileName: string }>;
}): SaveFaceDeps {
  return {
    ...input,
    readDefault: async () => decodeBinaryFile(await readDefaultFace()),
  };
}
