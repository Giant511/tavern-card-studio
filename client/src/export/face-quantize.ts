/**
 * 256 色调色板量化 + 8-bit indexed PNG 编码（v0.1.7 增补二，替代 pngquant）。
 *
 * ## 为什么自己写
 *
 * 需求写的是「512×512 PNG（pngquant 256 色）」。但 pngquant 是个**原生二进制**，
 * 客户端里没有、也不该为它塞一个 sidecar：Tauri 打进去要多一个平台相关的可执行
 * 文件，杀软误报和签名都是麻烦，而为了一张头像不值。
 *
 * 好在 pngquant 的核心并不神秘：**中位切分（median cut）+ indexed PNG**。
 * 两件事都在这里，纯计算、无 DOM，可以单测。
 *
 * ## 为什么不做抖动（dithering）
 *
 * pngquant 默认开 Floyd–Steinberg 抖动，本实现**刻意不做**：
 *
 *   · 抖动的作用是把量化误差摊成高频噪点，骗过人眼；但**噪点会显著降低 PNG 的
 *     压缩率** —— 在"体积有软上限"的场景里，这是拿字节数换观感；
 *   · 头像只有 512×512，色带（banding）在这个尺寸上不明显；
 *   · 抖动算法本身 O(像素 × 调色板) 才准（要逐像素找最近色），262144 × 256
 *     的距离计算在渲染线程上是肉眼可见的卡顿。
 *
 * 结论：不抖动换来更小的体积和更快的速度，代价是渐变区可能有轻微色带。
 * 这个取舍必须写进决策表 —— 否则以后有人"顺手补上抖动"，体积会莫名其妙变大。
 *
 * ## 编码为什么不依赖 `shared/src/png-card.ts` 的构建器
 *
 * 那个构建器是"在**已有 PNG** 的 chunk 里加 tEXt"（`buildPngCard`），
 * 它不做像素编码。本文件要做的是**从零产生**一个 indexed PNG，
 * 两者只共享 `crc32` 这一个底层函数。
 */

import { crc32 } from '../../../shared/src/png-card.ts';

/** 一次量化的结果 */
export interface QuantizeResult {
  /** 每个像素在调色板里的下标，长度 = width × height */
  indices: Uint8Array;
  /** 调色板，每 4 字节一个 RGBA；长度 = 色数 × 4 */
  palette: Uint8Array;
  /** 实际用到的色数 */
  colorCount: number;
}

/** 一个颜色盒子：像素下标区间 + RGB 包围盒 */
interface ColorBox {
  start: number;
  end: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
  /**
   * 还能不能切。
   *
   * 单色盒子（体积 0）或只剩一个像素的盒子切不开。**必须显式标记**：
   * 否则"挑体积最大的盒子"会反复挑中同一个切不开的盒子，
   * 而 `splitBox` 每次都返回 null ⇒ 死循环。第一版就是在这里写了两行
   * 自赋值的垃圾代码（既没标记也没退出），改成正正经经一个布尔字段。
   */
  splittable: boolean;
}

/**
 * 中位切分量化。
 *
 * `rgba` 是 `ImageData.data` 那种布局（每像素 4 字节）。
 * 类型写成 `Uint8ClampedArray | Uint8Array` 是因为 `ImageData.data` 是
 * **clamped** 那种（canvas 规范如此）—— 只接受 `Uint8Array` 会让调用方
 * 每次都要 `new Uint8Array(data)` 拷一份 26 万×4 的缓冲，纯属浪费。
 * 两者读起来一样（都只读、都按 0–255 取值），本函数不写回。
 *
 * 返回的 `indices` 可以直接喂给 {@link encodeIndexedPng}。
 *
 * 算法：把所有像素当成一个盒子，反复挑"优先级最高"的盒子沿最长轴从中位数切开，
 * 直到盒子数达到目标色数或无法再切。每个盒子取像素均值当代表色。
 */
export function quantizeMedianCut(
  rgba: Uint8Array | Uint8ClampedArray,
  maxColors: number,
): QuantizeResult {
  const pixelCount = Math.floor(rgba.length / 4);
  if (pixelCount === 0 || maxColors < 1) {
    return { indices: new Uint8Array(0), palette: new Uint8Array(0), colorCount: 0 };
  }

  /*
   * 把像素按 0xAARRGGBB 打包成一个 uint32 数组再排序，比"排序下标数组"
   * 少一层间接寻址。排序值是**打包后的整数**，切分时再解包读数 ——
   * 这样排序与比较都用原生 Uint32Array.prototype.sort，比自定义比较器快得多。
   */
  const packed = new Uint32Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const base = i * 4;
    const r = rgba[base] ?? 0;
    const g = rgba[base + 1] ?? 0;
    const b = rgba[base + 2] ?? 0;
    const a = rgba[base + 3] ?? 255;
    packed[i] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }

  const boxes: ColorBox[] = [makeBox(packed, 0, pixelCount)];

  while (boxes.length < maxColors) {
    // 挑**能切**且优先级最高的盒子
    let targetIndex = -1;
    let targetPriority = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box === undefined || !box.splittable) continue;
      const priority = boxPriority(box);
      if (priority > targetPriority) {
        targetPriority = priority;
        targetIndex = i;
      }
    }
    // 没有可切的盒子（颜色数已经少于目标）⇒ 停，不要造空盒子
    if (targetIndex < 0) break;

    const box = boxes[targetIndex];
    if (box === undefined) break;
    const split = splitBox(packed, box);
    if (split === null) {
      // 切不开：标记后继续找下一个，**不是 break** —— 别的盒子可能还能切
      boxes[targetIndex] = { ...box, splittable: false };
      continue;
    }
    boxes.splice(targetIndex, 1, split[0], split[1]);
  }

  return assignPalette(packed, boxes);
}

/** 扫描区间，算出 RGB 包围盒 */
function makeBox(packed: Uint32Array, start: number, end: number): ColorBox {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (let i = start; i < end; i += 1) {
    const value = packed[i] ?? 0;
    const r = (value >>> 16) & 0xff;
    const g = (value >>> 8) & 0xff;
    const b = value & 0xff;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  const box: ColorBox = { start, end, rMin, rMax, gMin, gMax, bMin, bMax, splittable: false };
  /*
   * 能不能切：**有多个像素、且至少有一个通道跨度不为 0**。
   *
   * 刻意不用"体积 > 0"—— 见 `boxPriority` 的注释：单通道恒定的图（灰度、
   * 纯色底、线性渐变）体积恒为 0，用体积判会整张塌成 1 色。
   */
  box.splittable = end - start >= 2 && boxMaxSpan(box) > 0;
  return box;
}

/** 三通道里最大的跨度。这是"还能不能切"的真正判据。 */
function boxMaxSpan(box: ColorBox): number {
  return Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
}

/**
 * 选哪个盒子先切。
 *
 * ## 为什么不能用体积（这是第一版的真 bug）
 *
 * 经典 median cut 用"体积 = 三通道跨度之积"挑盒子。但**只要有一个通道恒定，
 * 体积就是 0**：
 *
 *   · 灰度图 / 黑白线稿 → r=g=b 恒等，三个跨度同时为 0？不，跨度为 255，
 *     但另外两个通道的跨度是 0 ⇒ 乘积 0；
 *   · 纯色背景的插画、只有 b 不变的线性渐变 ⇒ 乘积 0；
 *   · 最常见的一张"蓝底 + 渐变人像"封面 ⇒ b 通道跨度小而 r/g 有跨度，乘积很小。
 *
 * 一旦被当成"体积 0"，`splittable` 就为 false，整张图**塌成 1 色**。
 * 实测：一张 512×512 的蓝底渐变，量化结果 colorCount = 1，整个头像变成色块。
 *
 * ## 改成"像素数 × 最长跨度"
 *
 * 两个因素都要：
 *   · 像素数 —— 大块先切，避免为几百个像素的颜色浪费调色板；
 *   · 最长跨度 —— 色彩散布广的先切，这是量化误差的主要来源。
 *
 * `+1` 是为了让跨度为 0 的盒子仍然能按像素数排（正常不会走到，
 * 因为那类盒子 `splittable` 已经是 false）。
 */
function boxPriority(box: ColorBox): number {
  return (box.end - box.start) * (boxMaxSpan(box) + 1);
}

/**
 * 沿最长轴把盒子切成两半（按该轴的像素中位数）。
 *
 * ## 为什么用计数排序而不是 `Array.prototype.sort`
 *
 * 切分键是**单通道值，范围恒为 0–255** —— 这是个可以直接开 256 个桶的场景。
 * 第一版用 `Array.from({length}, (_,i)=>i).sort(比较器)`：每次切分都分配一个
 * 26 万元素的索引数组（512×512），还要走 26 万次 JS 比较器回调，而整张图要切
 * **255 次**。实测 512×512 量化要 350–550 ms，在用户点「换封面」时是能感觉到的卡顿。
 *
 * 换计数排序后是 O(n + 256)、零分配（除两个定长 typed array），
 * 且**天然稳定**（同值保持原顺序），测试可以断言确定的输出。
 */
function splitBox(packed: Uint32Array, box: ColorBox): [ColorBox, ColorBox] | null {
  const rSpan = box.rMax - box.rMin;
  const gSpan = box.gMax - box.gMin;
  const bSpan = box.bMax - box.bMin;

  let shift: number;
  if (rSpan >= gSpan && rSpan >= bSpan) shift = 16;
  else if (gSpan >= bSpan) shift = 8;
  else shift = 0;

  if ((shift === 16 ? rSpan : shift === 8 ? gSpan : bSpan) === 0) return null;

  const start = box.start;
  const count = box.end - box.start;

  // 计数：每个通道值有多少个像素
  const histogram = new Uint32Array(256);
  for (let i = start; i < box.end; i += 1) {
    const key = ((packed[i] ?? 0) >>> shift) & 0xff;
    histogram[key] = (histogram[key] ?? 0) + 1;
  }

  // 前缀和 ⇒ 每个桶的写入起点
  const cursor = new Uint32Array(256);
  let acc = 0;
  for (let v = 0; v < 256; v += 1) {
    cursor[v] = acc;
    acc += histogram[v] ?? 0;
  }

  // 稳定放置
  const sorted = new Uint32Array(count);
  for (let i = start; i < box.end; i += 1) {
    const value = packed[i] ?? 0;
    const key = (value >>> shift) & 0xff;
    const at = cursor[key] ?? 0;
    sorted[at] = value;
    cursor[key] = at + 1;
  }
  packed.set(sorted, start);

  const mid = start + (count >> 1);
  if (mid <= start || mid >= box.end) return null;
  return [makeBox(packed, start, mid), makeBox(packed, mid, box.end)];
}

/** 每个盒子取均值当代表色，并把每个像素映射到它所属盒子的下标 */
function assignPalette(packed: Uint32Array, boxes: readonly ColorBox[]): QuantizeResult {
  const palette = new Uint8Array(boxes.length * 4);
  const indices = new Uint8Array(packed.length);

  boxes.forEach((box, boxIndex) => {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let aSum = 0;
    const count = box.end - box.start;
    for (let i = box.start; i < box.end; i += 1) {
      const value = packed[i] ?? 0;
      aSum += (value >>> 24) & 0xff;
      rSum += (value >>> 16) & 0xff;
      gSum += (value >>> 8) & 0xff;
      bSum += value & 0xff;
      indices[i] = boxIndex;
    }
    const base = boxIndex * 4;
    palette[base] = Math.round(rSum / count);
    palette[base + 1] = Math.round(gSum / count);
    palette[base + 2] = Math.round(bSum / count);
    palette[base + 3] = Math.round(aSum / count);
  });

  return { indices, palette, colorCount: boxes.length };
}

/**
 * 产生一个 8-bit indexed PNG。
 *
 * `deflate` 必须输出 **zlib 格式**（带 2 字节头 + adler32），不是 raw deflate ——
 * PNG 的 IDAT 规定如此，喂 raw 进去解码器会直接报损坏。
 * 浏览器侧用 `CompressionStream('deflate')`（它输出的就是 zlib），
 * Node 侧用 `zlib.deflateSync`，两者行为一致。
 *
 * 为了不给 shared 引入浏览器依赖，deflate 作为参数注入。
 */
export async function encodeIndexedPng(
  width: number,
  height: number,
  quantized: QuantizeResult,
  deflate: (raw: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const { indices, palette, colorCount } = quantized;
  if (colorCount === 0 || width <= 0 || height <= 0) {
    throw new Error('没有可编码的像素（尺寸或调色板为空）');
  }

  /*
   * 扫描线：每行前面加一个 filter 字节（0 = None）。
   * 不用 Sub/Up 等过滤器是刻意的 —— 那要逐行比较，而 indexed 图本身已经很小，
   * 省下的字节抵不上复杂度和出错面。
   */
  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    raw.set(indices.subarray(y * width, (y + 1) * width), y * stride + 1);
  }

  const compressed = await deflate(raw);

  const chunks: Uint8Array[] = [PNG_SIGNATURE];

  // IHDR：bit depth 8、color type 3（indexed）、无隔行
  const ihdr = new Uint8Array(13);
  writeUint32(ihdr, 0, width);
  writeUint32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 3;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  chunks.push(buildChunk('IHDR', ihdr));

  // PLTE：只用前 colorCount 个颜色，RGB
  const plte = new Uint8Array(colorCount * 3);
  for (let i = 0; i < colorCount; i += 1) {
    plte[i * 3] = palette[i * 4] ?? 0;
    plte[i * 3 + 1] = palette[i * 4 + 1] ?? 0;
    plte[i * 3 + 2] = palette[i * 4 + 2] ?? 0;
  }
  chunks.push(buildChunk('PLTE', plte));

  /*
   * tRNS 只在**真的存在透明**时写。
   *
   * 无条件写一整个 256 字节全 255 的 tRNS 是常见错误：解码器没问题，
   * 但白白多 256 字节，而且会让"这张图有没有透明"这个信息再也看不出来。
   */
  const hasAlpha = paletteHasAlpha(palette, colorCount);
  if (hasAlpha) {
    const trns = new Uint8Array(colorCount);
    for (let i = 0; i < colorCount; i += 1) trns[i] = palette[i * 4 + 3] ?? 255;
    chunks.push(buildChunk('tRNS', trns));
  }

  chunks.push(buildChunk('IDAT', compressed));
  chunks.push(buildChunk('IEND', new Uint8Array(0)));

  return concat(chunks);
}

function paletteHasAlpha(palette: Uint8Array, colorCount: number): boolean {
  for (let i = 0; i < colorCount; i += 1) {
    if ((palette[i * 4 + 3] ?? 255) !== 255) return true;
  }
  return false;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // CRC 覆盖 type + data（**不含** length 那 4 字节）
  writeUint32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
