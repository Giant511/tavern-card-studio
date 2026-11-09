/**
 * 角色卡封面生成（v0.1.8）—— 只用 canvas，不依赖 Tauri / 原生。
 *
 * ## 为什么需要它
 *
 * 角色卡是 **PNG 容器 + 内嵌卡数据**，所以每张卡都必须有一张图当底图。
 * 而 JSON 卡本身没有图。v0.1.7 的做法是统一塞一张内置默认卡面
 * （`card-face-default.png`），结果是：
 *
 * ```text
 *   所有 JSON 卡导入的卡   → 长得一模一样，只能靠名字区分
 *   所有仓库下载的卡       → 同上（它走的也是兜底卡面）
 * ```
 *
 * 选角色列表**是显示头像的**（`character-picker.ts` 的 `makeAvatar`），
 * 所以"全都一样"不是审美问题，是**认不出哪张是哪张**。
 *
 * ## 两种来源
 *
 * ```text
 *   faceFromImage  用户从相册选一张 → 居中裁方形 → 缩到 512 → PNG
 *   faceFromName   没有图 → 按卡名算颜色 + 画首字 → PNG
 * ```
 *
 * 后者是按用户 2026-11-09 的口径做的：「按卡名生成首字图」。
 * 同一个名字永远同一个颜色（哈希固定），不同名字颜色不同，
 * 这样列表里扫一眼就能区分。
 *
 * ## 为什么不用桌面端那条 `face-encode.ts`
 *
 * 那条管线是给**仓库存图**用的：要压到 250KB 以内，所以有 256 色量化
 * （`face-quantize.ts`）和 `deflateZlib`（依赖 `CompressionStream`）。
 * 卡面不需要那个限制 —— 角色卡本身就是几 MB 的图。硬拉那条管线会把
 * 量化器一起打进移动包，还可能因为 `CompressionStream` 缺席而整条走不通。
 *
 * 规格常量仍复用 `face-spec.ts` 的 `ST_AVATAR_EDGE`，保证与桌面端一致。
 */

import { ST_AVATAR_EDGE } from '../export/face-spec.ts';

/** 封面边长。与桌面端 ST 头像同规格（512×512） */
export const CARD_FACE_EDGE = ST_AVATAR_EDGE;

/**
 * 造 canvas 需要的最小 `doc` 能力。
 *
 * `DocLike.createElement` 返回 `ElLike`（没有 `getContext`），所以这里单独声明。
 * 不直接用全局 `document` 是为了能在测试里注入替身。
 */
export interface CanvasDoc {
  createElement(tag: 'canvas'): HTMLCanvasElement;
}

/** 生成不出来时抛这个，文案已面向用户 */
export class CardFaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardFaceError';
  }
}

function canvasOf(doc: CanvasDoc, edge: number): {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
} {
  const canvas = doc.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const context = canvas.getContext('2d');
  if (context === null) throw new CardFaceError('这台设备画不出图（canvas 上下文拿不到）');
  return { canvas, context };
}

/** canvas → PNG 字节 */
async function toPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => {
      resolve(value);
    }, 'image/png');
  });
  if (blob === null) throw new CardFaceError('封面图编码失败');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 把用户选的图片字节做成 512×512 的封面。
 *
 * 居中裁成正方形再缩放 —— 与桌面端 `renderSquare` 同一套做法。
 * 不这么做的话，768×1024 这类竖图会被拉成椭圆（本项目在圆角上踩过同类坑）。
 *
 * 小图会被放大，会有点糊，但那是用户自己选的图，不替他决定。
 */
export async function faceFromImage(
  doc: CanvasDoc,
  bytes: Uint8Array,
  edge: number = CARD_FACE_EDGE,
): Promise<Uint8Array> {
  if (bytes.length === 0) throw new CardFaceError('这张图是空的');

  let bitmap: ImageBitmap;
  try {
    /*
     * 不用 `<img>` + `onload`：那要处理 URL 生命周期与 revoke，
     * 而且失败时只有一个 `error` 事件、拿不到原因。
     * `createImageBitmap` 能 catch 到具体错误。
     */
    bitmap = await createImageBitmap(new Blob([bytes.slice()]));
  } catch {
    /*
     * 最常见的原因：HEIC / HEIF（iPhone 拍的图）在这台设备的 WebView 里解不开。
     * 必须说清「换个格式」而不是「导入失败」—— 后者会让人以为卡坏了。
     */
    throw new CardFaceError('这张图读不出来。换一张 PNG 或 JPG 试试（iPhone 的 HEIC 可能不支持）');
  }

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side <= 0) throw new CardFaceError('这张图的尺寸是 0，没法用');

    const { canvas, context } = canvasOf(doc, edge);
    context.imageSmoothingEnabled = true;
    /* `high` 在老 WebView 上可能被忽略，但那只是糊一点，不影响结果 */
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      edge,
      edge,
    );
    return await toPngBytes(canvas);
  } finally {
    /* ImageBitmap 占的是原生内存，不释放会在连续导入时堆起来 */
    bitmap.close();
  }
}

/**
 * 从卡名取一个字当封面主体。
 *
 * 跳过空白与常见装饰标点 —— 名字叫「【测试】小明」时画「【」没有意义。
 */
export function initialOf(name: string): string {
  const chars = Array.from(name.trim());
  const skip = new Set(['【', '】', '「', '」', '『', '』', '(', ')', '[', ']', '《', '》', '·', '-', '_']);
  for (const ch of chars) {
    if (ch.trim() === '') continue;
    if (skip.has(ch)) continue;
    return ch;
  }
  /* 全是标点或空白：退回第一个字符，总比空图好 */
  return chars[0] ?? '?';
}

/**
 * 按名字算一个稳定的色相（0-359）。
 *
 * 同一个名字永远同一个颜色 —— 用户第二次导入同一张卡时封面不会突然换色，
 * 否则会以为导错了。不同名字落在不同色相上。
 *
 * 用 FNV-1a：短字符串上分布比简单求和均匀得多（`小明` 和 `小明明` 不会撞）。
 */
export function hueOf(name: string): number {
  let hash = 0x811c9dc5;
  for (const unit of new TextEncoder().encode(name)) {
    hash ^= unit;
    /* 乘 16777619 用移位避免 32 位溢出丢精度 */
    hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash % 360;
}

/**
 * 按卡名生成 512×512 的首字封面。
 *
 * 渐变底 + 白色首字。不用 `color-mix()` —— 那个在 Chrome 87 整条失效
 * （§126 的教训），直接给 `hsl()` 的确定值。
 */
export async function faceFromName(
  doc: CanvasDoc,
  name: string,
  edge: number = CARD_FACE_EDGE,
): Promise<Uint8Array> {
  const { canvas, context } = canvasOf(doc, edge);
  const hue = hueOf(name);

  const gradient = context.createLinearGradient(0, 0, edge, edge);
  gradient.addColorStop(0, `hsl(${String(hue)}, 68%, 58%)`);
  gradient.addColorStop(1, `hsl(${String((hue + 26) % 360)}, 64%, 44%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, edge, edge);

  const text = initialOf(name);
  /* 单字取 0.42 倍边长：再大就会贴边，再小显得空 */
  const fontSize = Math.round(edge * 0.42);
  context.fillStyle = 'rgb(255 255 255 / 96%)';
  context.font = `600 ${String(fontSize)}px system-ui, -apple-system, "Noto Sans SC", sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  /*
   * 纵向 -0.02 倍：`middle` 是按 em 盒算的，中文字形视觉重心略偏下，
   * 往上挪一点点看起来才是正中。
   */
  context.fillText(text, edge / 2, edge / 2 - edge * 0.02);

  return await toPngBytes(canvas);
}
