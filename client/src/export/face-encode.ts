/**
 * 卡面编码的**执行层**：canvas / ImageBitmap / CompressionStream。
 *
 * 纯决策在 `face-pipeline.ts`（可穷举测试），这里只负责"真编一次"。
 * 分开的理由：决策里最容易错的是"二分有没有找对质量""阶梯有没有跳档"，
 * 那两个用假编码器就能验；而这里最容易错的是浏览器行为（见下面三条注记），
 * 只能靠真环境跑。
 *
 * ## 三条浏览器行为注记（都踩过）
 *
 * 1. **`canvas.toBlob('image/webp')` 在不支持的引擎上会静默返回 PNG。**
 *    返回的 Blob 的 `type` 是 `image/png`，而字节数会**比原来的 PNG 还大**
 *    （又编了一次 + 没压）。所以每次 WebP 编码都必须验 `blob.type`，
 *    不是 webp 就当作"这台机器不支持"，退回 PNG 路径 —— 而不是拿 PNG
 *    字节冒充 WebP 上传，那会被服务端 250KB 拦下、错误信息还指向"图太大"。
 *
 * 2. **`quality` 只对有损格式有意义**，PNG 忽略它。传了也不报错，
 *    所以不能靠"传了 quality 就以为压小了"。
 *
 * 3. **`CompressionStream('deflate')` 输出的是 zlib 格式**（带 2 字节头 +
 *    adler32），正好是 PNG IDAT 要的；`deflate-raw` 才是裸流。
 *    用错那个，产出的 PNG 所有解码器都会报损坏。
 */

import {
  ST_AVATAR_COLORS,
  ST_AVATAR_EDGE,
  ST_AVATAR_WARN_BYTES,

  formatBytes,
} from './face-spec.ts';
import { planStoreFace, type FaceAttempt, type FacePipelineOutcome } from './face-pipeline.ts';
import { encodeIndexedPng, quantizeMedianCut } from './face-quantize.ts';

export class FaceEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaceEncodeError';
  }
}

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** 解码任意浏览器支持的图片。失败时给"这张图打不开"而不是底层异常。 */
export async function decodeImage(bytes: Uint8Array, fileName: string): Promise<DecodedImage> {
  if (typeof createImageBitmap !== 'function') {
    throw new FaceEncodeError('当前环境不支持图片解码（需要桌面客户端的 canvas 能力）');
  }
  try {
    const blob = new Blob([bytes.slice()], { type: guessMime(fileName) });
    const bitmap = await createImageBitmap(blob);
    return { bitmap, width: bitmap.width, height: bitmap.height };
  } catch {
    throw new FaceEncodeError(`这张图无法解码（${fileName}）—— 可能已损坏或不是图片`);
  }
}

/** 把位图画到指定长边的 canvas 上（不放大） */
export function renderScaled(decoded: DecodedImage, maxLongEdge: number | null): HTMLCanvasElement {
  const longEdge = Math.max(decoded.width, decoded.height);
  const scale = maxLongEdge === null || maxLongEdge >= longEdge ? 1 : maxLongEdge / longEdge;
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context === null) throw new FaceEncodeError('无法创建 canvas 上下文（显存不足？）');
  // 透明底：jpg 转过来时边缘不该出现黑边
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(decoded.bitmap, 0, 0, width, height);
  return canvas;
}

/** 居中裁成正方形（ST 头像必须是正方形，非方图直接拉伸会变形） */
export function renderSquare(decoded: DecodedImage, edge: number): HTMLCanvasElement {
  const side = Math.min(decoded.width, decoded.height);
  const sx = (decoded.width - side) / 2;
  const sy = (decoded.height - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (context === null) throw new FaceEncodeError('无法创建 canvas 上下文（显存不足？）');
  context.clearRect(0, 0, edge, edge);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(decoded.bitmap, sx, sy, side, side, 0, 0, edge, edge);
  return canvas;
}

export type EncodedImage = { bytes: Uint8Array; mime: 'image/webp' | 'image/png' };

/** 编 WebP。**必须验返回 MIME**（见文件头注记 1）。 */
export async function encodeWebp(canvas: HTMLCanvasElement, quality: number): Promise<EncodedImage> {
  const blob = await toBlob(canvas, 'image/webp', quality / 100);
  if (blob === null) throw new FaceEncodeError('WebP 编码失败（图片可能过大）');
  if (blob.type !== 'image/webp') {
    /*
     * 引擎不支持 WebP：**退回 PNG 并明说**，不要拿 PNG 冒充 WebP。
     *
     * 这里选择抛错而不是静默降级：调用方（管线）会据此改走 PNG 分支，
     * 而 PNG 大概率进不了 250KB —— 用户需要知道"你这台机器压不到那么小"，
     * 而不是收到一个"图太大，换一张更简洁的"的误导文案。
     */
    throw new FaceEncodeError('这台机器的图形引擎不支持 WebP 编码，无法把卡面压到 250KB 以内');
  }
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/webp' };
}

/** 编 PNG（24-bit 或带 alpha），用于"平涂原图保留"与头像兜底 */
export async function encodePng(canvas: HTMLCanvasElement): Promise<EncodedImage> {
  const blob = await toBlob(canvas, 'image/png');
  if (blob === null) throw new FaceEncodeError('PNG 编码失败（图片可能过大）');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((value) => { resolve(value); }, type, quality);
  });
}

/** zlib 格式的 deflate（给 indexed PNG 的 IDAT 用） */
export async function deflateZlib(raw: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'function') {
    throw new FaceEncodeError('当前环境缺少压缩能力（CompressionStream），无法生成头像');
  }
  const stream = new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/* ───────────────────── 仓库卡面资产：跑完整管线 ───────────────────── */

export interface StoreFaceResult {
  /** 能否入库 */
  ok: boolean;
  /** 入库字节（ok 时非 null） */
  bytes: Uint8Array | null;
  mime: 'image/webp' | 'image/png' | null;
  width: number;
  height: number;
  /** 给用户看的一句话（含"压缩后约 X KB（原图 Y MB）"） */
  note: string;
  /** 原图字节数（给提示用） */
  originalBytes: number;
  /** 走了几次编码（调试与"是不是白跑了"用） */
  attempts: number;
}

/**
 * 把一张图压成可入库的卡面资产。
 *
 * 决策走 `planStoreFace`，这里只负责把每次 `yield` 的尝试真编出来、
 * 把字节数喂回去。
 *
 * ## 必须传原始字节（`original`），不只是长度
 *
 * 「平涂 PNG 已达标」那条路**一次都不编码**，直接返回原图 ——
 * 所以这里需要原图的字节本体。第一版只传了 `originalBytes`（一个数字），
 * 于是那条路走进了"循环从未进入"的分支、抛"内部状态异常"。
 * 实测触发条件很常见：**一张 200KB 的插画 PNG**。
 */
export async function buildStoreFace(
  decoded: DecodedImage,
  original: Uint8Array,
  originalIsPng: boolean,
): Promise<StoreFaceResult> {
  const originalBytes = original.byteLength;
  const plan = planStoreFace({
    originalIsPng,
    originalBytes,
    width: decoded.width,
    height: decoded.height,
  });

  let attempts = 0;
  let step = plan.next(0);

  /*
   * 先处理"一次都不编码"的结局。
   *
   * `keep-original` 是生成器**直接 return** 的（不 yield），所以进来时
   * `step.done` 已经是 true —— 这跟"循环跑完了"是同一个形状，
   * 但含义完全不同。必须在这里分开处理，否则会掉到函数末尾那个
   * "内部状态异常"的兜底里。
   */
  if (step.done) {
    const outcome: FacePipelineOutcome = step.value;
    if (outcome.kind === 'keep-original') {
      return {
        ok: true,
        bytes: original,
        mime: 'image/png',
        width: decoded.width,
        height: decoded.height,
        note: outcome.reason,
        originalBytes,
        attempts: 0,
      };
    }
    // rejected 不可能在零次尝试时出现（它至少要试到 900px/q90），真到了就是逻辑有洞
    return {
      ok: false,
      bytes: null,
      mime: null,
      width: decoded.width,
      height: decoded.height,
      note: outcome.reason,
      originalBytes,
      attempts: 0,
    };
  }

  while (!step.done) {
    const attempt: FaceAttempt = step.value;
    attempts += 1;

    const canvas = renderScaled(decoded, attempt.maxLongEdge);
    // PNG 分支目前只在"保留原图"里走到（那支不编码），但保留 attempt 的结构便于以后开
    const encoded =
      attempt.format === 'webp'
        ? await encodeWebp(canvas, attempt.quality)
        : await encodePng(canvas);

    step = plan.next(encoded.bytes.byteLength);

    if (step.done) {
      const outcome: FacePipelineOutcome = step.value;
      const originalMb = (originalBytes / 1024 / 1024).toFixed(1);

      if (outcome.kind === 'accepted') {
        return {
          ok: true,
          bytes: encoded.bytes,
          mime: encoded.mime,
          width: canvas.width,
          height: canvas.height,
          /*
           * 提示要**同时**说压缩后和原图 —— 只说"已压缩"用户不知道省了多少，
           * 只说原图大小他不知道现在多大。需求给的原话格式就是这个。
           */
          note: `压缩后约 ${formatBytes(encoded.bytes.byteLength)}（原图 ${originalMb} MB）✓ ${outcome.reason}`,
          originalBytes,
          attempts,
        };
      }

      return {
        ok: false,
        bytes: null,
        mime: null,
        width: canvas.width,
        height: canvas.height,
        note: outcome.reason,
        originalBytes,
        attempts,
      };
    }
  }

  // 生成器正常结束后不会到这里；真到了说明逻辑有洞，不能静默返回成功
  throw new FaceEncodeError('卡面压缩没有得出结论（内部状态异常）');
}

/* ───────────────────── ST 头像：512×512 PNG 256 色 ───────────────────── */

export interface StAvatarResult {
  bytes: Uint8Array;
  width: number;
  height: number;
  colorCount: number;
  /** 超过软上限时的一句提示；null = 正常 */
  warn: string | null;
}

/**
 * 从**仓库资产**（WebP 或 PNG）转出 ST 头像。
 *
 * 为什么必须从仓库资产转、不能复用上传前那份原图：两者可能已经不是同一张了
 * （用户换过封面、或别的设备改过）。仓库资产才是"当前这份卡面"的权威。
 */
export async function buildStAvatar(storeFaceBytes: Uint8Array): Promise<StAvatarResult> {
  const decoded = await decodeImage(storeFaceBytes, 'face.webp');
  try {
    const canvas = renderSquare(decoded, ST_AVATAR_EDGE);
    const context = canvas.getContext('2d');
    if (context === null) throw new FaceEncodeError('无法创建 canvas 上下文（显存不足？）');

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const quantized = quantizeMedianCut(imageData.data, ST_AVATAR_COLORS);
    const bytes = await encodeIndexedPng(canvas.width, canvas.height, quantized, deflateZlib);

    return {
      bytes,
      width: canvas.width,
      height: canvas.height,
      colorCount: quantized.colorCount,
      // 软上限：只提示，不拦 —— 头像不占仓库空间
      warn:
        bytes.byteLength > ST_AVATAR_WARN_BYTES
          ? `头像 ${formatBytes(bytes.byteLength)}，超过 ${formatBytes(ST_AVATAR_WARN_BYTES)} 的软上限（不影响使用）`
          : null,
    };
  } finally {
    decoded.bitmap.close();
  }
}

function guessMime(fileName: string): string {
  const lowered = fileName.toLowerCase();
  if (lowered.endsWith('.jpg') || lowered.endsWith('.jpeg')) return 'image/jpeg';
  if (lowered.endsWith('.webp')) return 'image/webp';
  if (lowered.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
