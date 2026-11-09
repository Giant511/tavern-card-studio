/**
 * 实测存储体积：JSON 版本流 + 卡面×1 vs PNG 每版一份（v0.1.7 修订二验收项）。
 *
 * ## 量的是什么
 *
 * 用**真的** `BlobStore`（内容寻址 + 写盘）存 50 份 JSON + 1 张卡面，
 * 以及用**真的** `buildPngCard` 造 50 张嵌了对应 JSON 的 PNG，
 * 然后量两者的实际落盘占用。
 *
 * 不经过 `CardService`：那会牵进建卡 / 版本链 / 审计，而这里要回答的问题
 * 只有一个 —— **同一张封面被复制 50 份 vs 只存一份，差多少**。
 * 那个差距跟建卡流程无关，量 blob 目录就是判据本身。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore } from '../server/dist/storage/blobs.js';
import { buildPngCard } from '../shared/dist/index.js';

const VERSIONS = 50;
/* 卡面字节数由真实样本决定（见 PHOTO 的注释） */

/*
 * 用**真实的** PNG 当封面（assets 里的界面截图，700 KB 量级）。
 *
 * 为什么不用"1×1 的图 + 一堆填充字节"：那填充不是合法 PNG 结构，
 * `readPngChunks` 读到 IEND 就停了，后面的字节根本没进 blob ——
 * 第一次跑出来的数字是"50 张 PNG 只占 325 KB"，比本方案还小，
 * 完全反了。样本形态与声称的不一致，量出来的东西没有意义（memory §1）。
 */
const PHOTO = readFileSync(join(import.meta.dirname, '..', 'assets', 'face-02-library.png'));

/** 第 i 版的内容（每版不同，模拟真实编辑） */
function makeJson(i) {
  return JSON.stringify({
    spec: 'chara_card_v2',
    data: {
      name: '体积探针',
      description: '第 ' + String(i) + ' 版的描述。' + '设定内容'.repeat(400),
      first_mes: '你好',
      mes_example: '',
    },
  });
}

/**
 * 目录占用的 KB。
 *
 * **不用 `du`**：它在 Windows 上要走 cmd.exe，而 `spawnSync` 捕获输出会抛
 * EBUSY（本仓库 memory §4 记过这条）。纯 Node 递归虽然慢一点，但结果一样、
 * 且没有平台依赖。
 */
function duKb(path) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else total += statSync(full).size;
    }
  };
  walk(path);
  return Math.round(total / 1024);
}

function measure() {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-vol-'));
  try {
    /* ── 本方案：JSON 版本流 + 卡面×1 ── */
    const jsonStore = new BlobStore(join(dir, 'blobs'));
    const faceStore = new BlobStore(join(dir, 'faces'));
    let textTotal = 0;
    for (let i = 1; i <= VERSIONS; i += 1) {
      const bytes = Buffer.from(makeJson(i), 'utf8');
      textTotal += bytes.byteLength;
      jsonStore.put(bytes);
    }
    faceStore.put(PHOTO);

    /* ── 被否决的方案：每版一张 PNG（嵌的 JSON 变了 ⇒ 摘要必不同 ⇒ 去重不命中）── */
    const pngStore = new BlobStore(join(dir, 'png-versions'));
    let pngTotal = 0;
    for (let i = 1; i <= VERSIONS; i += 1) {
      const png = buildPngCard(PHOTO, makeJson(i), 'v2');
      pngTotal += png.byteLength;
      pngStore.put(png);
    }

    return {
      versions: VERSIONS,
      faceKb: Math.round(PHOTO.byteLength / 1024),
      textTotalKb: Math.round(textTotal / 1024),
      jsonBlobsKb: duKb(join(dir, 'blobs')),
      facesKb: duKb(join(dir, 'faces')),
      oursKb: duKb(join(dir, 'blobs')) + duKb(join(dir, 'faces')),
      pngKb: duKb(join(dir, 'png-versions')),
      pngTotalKb: Math.round(pngTotal / 1024),
      pngFiles: pngStore.stats().count,
      jsonFiles: jsonStore.stats().count,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const r = measure();
const mb = (kb) => (kb / 1024).toFixed(2);

console.log('版本数                          ' + String(r.versions));
console.log('单张卡面                        ' + String(r.faceKb) + ' KB');
console.log('50 版 JSON 原始字节             ' + String(r.textTotalKb) + ' KB');
console.log('');
console.log('【本方案】JSON 版本流 + 卡面×1');
console.log('  blobs/（50 份 JSON）           ' + String(r.jsonBlobsKb) + ' KB  (' + mb(r.jsonBlobsKb) + ' MB)');
console.log('  faces/（卡面 1 份）            ' + String(r.facesKb) + ' KB  (' + mb(r.facesKb) + ' MB)');
console.log('  合计                          ' + String(r.oursKb) + ' KB  (' + mb(r.oursKb) + ' MB)');
console.log('  实际落盘 blob 数               ' + String(r.jsonFiles) + '（等于版本数，因为每版内容都不同）');
console.log('');
console.log('【被否决】每版一张 PNG');
console.log('  50 张 PNG 落盘                 ' + String(r.pngKb) + ' KB  (' + mb(r.pngKb) + ' MB)');
console.log('  实际落盘 blob 数               ' + String(r.pngFiles) + '（去重一次都没命中）');
console.log('');
console.log('差距                            ' + (r.pngKb / r.oursKb).toFixed(1) + ' 倍');
console.log('');
console.log('结论：PNG 方案多出来的全部是「同一张封面的 50 份副本」——');
console.log('      PNG 里嵌的 JSON 每版都变，sha256 必然不同，内容寻址救不了它。');
