/**
 * 生成 Tauri 需要的图标（无第三方依赖：手写 PNG/ICO 编码）。
 *
 * 为什么自己生成：tauri icon 命令需要一张源图，而仓库里没有设计资源；
 * 引入 sharp/canvas 只为一个图标不值得。这里用 zlib 直接编码 PNG，
 * ICO 内嵌 PNG（Vista+ 支持），产物可直接被 WiX 打包使用。
 *
 * 运行：node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const OUT_DIR = join(import.meta.dirname, '..', 'src-tauri', 'icons');
const BASE = 512;

// ── 画图（在 BASE×BASE 上做，再降采样）────────────────────────
const ACCENT = [47, 111, 235];
const ACCENT_DARK = [30, 78, 175];
const PAPER = [255, 255, 255];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** 圆角矩形的有向距离（负值在内部） */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

function shade(x, y) {
  const s = BASE;
  const r = s * 0.22;

  // 背景圆角方块（带一点竖向渐变，避免纯色发平）
  const bg = roundedRectDistance(x, y, s / 2, s / 2, s / 2, s / 2, r);
  if (bg > 0) return null;
  const t = y / s;
  let color = mix(ACCENT, ACCENT_DARK, t * 0.55);

  // 一张"卡片"：白色圆角矩形
  const cardD = roundedRectDistance(x, y, s / 2, s / 2, s * 0.30, s * 0.34, s * 0.05);
  if (cardD <= 0) {
    color = PAPER;

    // 卡片上的三条"文本行"（用强调色，深浅区分层级）
    const lines = [
      { y: s * 0.40, h: s * 0.030, w: s * 0.34 },
      { y: s * 0.48, h: s * 0.026, w: s * 0.28 },
      { y: s * 0.56, h: s * 0.026, w: s * 0.32 },
    ];
    for (const line of lines) {
      const d = roundedRectDistance(x, y, s / 2, line.y, line.w / 2, line.h / 2, line.h / 2);
      if (d <= 0) color = mix(ACCENT, [255, 255, 255], 0.15);
    }

    // 底部一个小圆点（书名号的感觉）
    const dot = Math.hypot(x - s / 2, y - s * 0.66) - s * 0.035;
    if (dot <= 0) color = ACCENT;
  }

  return color;
}

/** 超采样渲染出 RGBA 像素 */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = BASE / size;
  const samples = scale > 2 ? 4 : 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          const color = shade(x, y);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            hits++;
          }
        }
      }
      const offset = (py * size + px) * 4;
      if (hits === 0) {
        pixels[offset + 3] = 0;
      } else {
        pixels[offset] = Math.round(r / hits);
        pixels[offset + 1] = Math.round(g / hits);
        pixels[offset + 2] = Math.round(b / hits);
        pixels[offset + 3] = Math.round((hits / (samples * samples)) * 255);
      }
    }
  }
  return pixels;
}

// ── PNG 编码 ────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前加 filter=0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 容器（内嵌 PNG） */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach(({ size, png }, index) => {
    const base = index * 16;
    entries[base] = size >= 256 ? 0 : size;
    entries[base + 1] = size >= 256 ? 0 : size;
    entries[base + 2] = 0;
    entries[base + 3] = 0;
    entries.writeUInt16LE(1, base + 4); // planes
    entries.writeUInt16LE(32, base + 6); // bit count
    entries.writeUInt32LE(png.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

// ── 产出 ────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { size: 32, name: '32x32.png' },
  { size: 128, name: '128x128.png' },
  { size: 256, name: '128x128@2x.png' },
  { size: 512, name: 'icon.png' },
];

const rendered = new Map();
for (const { size, name } of targets) {
  const png = encodePng(size, render(size));
  rendered.set(size, png);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`✔ ${name}  ${size}×${size}  ${png.length} B`);
}

// ICO：同时放 32/64/128/256，Windows 按 DPI 自选
const icoImages = [32, 64, 128, 256].map((size) => {
  const png = rendered.get(size) ?? encodePng(size, render(size));
  return { size, png };
});
const ico = encodeIco(icoImages);
writeFileSync(join(OUT_DIR, 'icon.ico'), ico);
console.log(`✔ icon.ico  ${icoImages.length} 帧  ${ico.length} B`);

console.log(`\n输出目录：${OUT_DIR}`);
console.log('图标需要入库：Tauri 构建期由 tauri-build / bundler 读取，不生成就会打包失败。');
