/**
 * PNG 卡的原图来源（v0.1.4 / T12.4–T12.5，决策 #165/#168）。
 *
 * ## 为什么"原图"必须挂在会话上
 *
 * 决策 D4：**PNG 导入的卡，导出时默认复用原图**。那张图是"这张卡的来源"，
 * 与 `cardId` / `filePath` 同一性质 —— 挂在 App 上就会在切标签时串卡：
 * 用户导出 B 卡，拿到的却是 A 卡的封面。这种错"看起来很正常"，
 * 直到有人发现两张卡的封面一样。
 *
 * 与 `CardSession.#worldbookSource` 同一个先例与同一条理由。
 *
 * ## 为什么存"完整字节"而不是解码后的 ImageData
 *
 * 存完整 PNG 字节 = 导出时 `buildPngCard(原图, 新 JSON, spec)` 直接可用，
 * **像素逐字节不变**（D1 的核心承诺）。若存 ImageData / canvas，
 * 导出就得重新编码 —— 调色板、gAMA、交错方式都会变，用户会发现"图变了一点"。
 *
 * 代价是内存：一张 5 MB 的图占 5 MB。可接受 —— 用户主动打开的，
 * 而且关闭标签就释放。
 */

import type { BinaryFile } from '../contract/types.ts';
import { PngCardError, parsePngCard, stripPngCardData, summarizePng } from '@tcs/shared';

/** 会话级"这张卡的来源图片" */
export interface PngSource {
  /** 完整 PNG 字节（**含**卡数据块；导出时由 buildPngCard 负责剥旧块） */
  bytes: Uint8Array;
  /** 来源文件路径（展示用；非 UTF-8 时为 null） */
  path: string | null;
  /** 这张图当初是从哪个 keyword 读出来的 —— 决定"保持原 spec"时的写法 */
  keyword: 'ccv3' | 'chara';
  /** 宽高（界面预览要显示"这张图是 768×1024"） */
  width: number;
  height: number;
}

/**
 * base64 → 字节，并核对契约里带回来的 `bytesLen` 与 `sha256`。
 *
 * 为什么要核对：base64 过 IPC 时若被截断/替换，`atob` 仍可能"成功"
 * （只要是 4 的倍数且字符合法），得到一段**长度不对但看起来合法**的字节。
 * 后面 `parsePngCard` 会报 CRC 错，但那时错误已经离根因很远了
 * （"CRC 校验失败"听起来像文件坏了，而不是传输坏了）。
 *
 * 长度检查是同步的、零成本；sha256 走 `crypto.subtle`（WebView2 与 Node 22 都有）。
 * 摘要失败不阻断 —— 那是"无法自证"，不是"确定损坏"，由调用方决定要不要提示。
 */
export async function decodeBinaryFile(file: BinaryFile): Promise<{
  bytes: Uint8Array;
  digestVerified: boolean;
}> {
  const clean = file.base64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  if (bytes.length !== file.bytesLen) {
    throw new PngCardError(
      'TRUNCATED',
      `读取到的字节数与契约声明不符（声明 ${String(file.bytesLen)}，实际 ${String(bytes.length)}）——` +
        '文件可能在读取过程中被改动',
    );
  }

  let digestVerified = false;
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined && typeof subtle.digest === 'function') {
    try {
      const digest = await subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      digestVerified = hex === file.sha256.toLowerCase();
    } catch {
      digestVerified = false;
    }
  }

  return { bytes, digestVerified };
}

/**
 * 把解析结果包成会话级 PngSource。
 *
 * `stripPngCardData` 只在**预览**时用（避免把几百 KB 的卡 base64 塞进缩略图），
 * 存的原图仍是完整字节 —— 那才是"复用原图"该有的语义。
 */
export function toPngSource(bytes: Uint8Array, path: string | null, keyword: 'ccv3' | 'chara'): PngSource {
  const summary = summarizePng(bytes);
  return {
    bytes,
    path,
    keyword,
    width: summary?.width ?? 0,
    height: summary?.height ?? 0,
  };
}

/** 只是预览用的 data URL：**剥掉**卡数据块，避免把正文塞进 <img> */
export function previewDataUrl(bytes: Uint8Array): string {
  let payload: Uint8Array;
  try {
    payload = stripPngCardData(bytes);
  } catch {
    payload = bytes;
  }
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < payload.length; index += CHUNK) {
    binary += String.fromCharCode(...payload.subarray(index, index + CHUNK));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * 读一张 PNG，判断它是卡还是纯图。
 *
 * 刻意不在这里建会话 / 改界面：这个函数要能在单测里直接喂字节。
 */
export function inspectPng(bytes: Uint8Array):
  | { kind: 'card'; keyword: 'ccv3' | 'chara'; json: unknown; jsonText: string }
  | { kind: 'bare'; note: string } {
  const result = parsePngCard(bytes);
  if (result.kind === 'bare') return { kind: 'bare', note: result.note };
  return {
    kind: 'card',
    keyword: result.keyword,
    json: result.json,
    jsonText: result.jsonText,
  };
}
