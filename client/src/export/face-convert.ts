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
export async function convertToPng(bytes: Uint8Array, fileName: string): Promise<ConvertedFace> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    throw new FaceConvertError(
      '当前环境不支持图片转码（需要浏览器的 canvas 能力）——请在桌面客户端里选择非 PNG 卡面',
    );
  }

  let bitmap: ImageBitmap;
  try {
    // 复制成独立 buffer：`bytes` 可能是某个大 Uint8Array 的视图，
    // Blob 会按视图长度拷贝，这里显式 slice 一次避免"传了 5MB 只用了 200KB"的误解
    const blob = new Blob([bytes.slice()], { type: guessMime(fileName) });
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new FaceConvertError(`这张图无法解码（${fileName}）—— 可能已损坏或不是图片`);
  }

  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  const size = scaledSize(originalWidth, originalHeight, FACE_MAX_EDGE);

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
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });
  if (blob === null) {
    throw new FaceConvertError('PNG 编码失败（图片可能过大）');
  }

  const converted = new Uint8Array(await blob.arrayBuffer());
  const ratio = faceScale(originalWidth, originalHeight, FACE_MAX_EDGE);
  const note =
    size.scaled === true
      ? `已把 ${fileName} 转为 PNG，并把长边从 ${String(Math.max(originalWidth, originalHeight))}px ` +
        `等比压到 ${String(FACE_MAX_EDGE)}px（比例 ${(ratio * 100).toFixed(1)}%）`
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
