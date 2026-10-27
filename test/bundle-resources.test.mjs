/**
 * 打包资源清单的完整性（v0.1.4 / T12.5）。
 *
 * ## 这个洞具体是什么
 *
 * `tauri.conf.json` 的 `bundle.resources` 是把文件塞进安装包的**唯一**声明处。
 * 漏一条的表现不是构建失败，而是**运行期缺文件**：
 *
 *   · `rules` 漏了 → 应用起不来（`RULES_DIR_MISSING`，症状明显，历史上踩过）；
 *   · `card-face-default.png` 漏了 → 应用正常启动、编辑正常、导出 JSON 正常，
 *     只有用户点「PNG 卡 → 默认卡面」时才报 `PATH_NOT_FOUND`。
 *
 * 后者是"只在某个功能的具体某一步"才炸的缺陷，装包自检与冒烟都抓不到。
 * 而且它**不会**被现有测试发现：`bundle-health` 只查前端 dist 的结构，
 * `pack-manifest` 只查 server 依赖，都不看 tauri resources。
 *
 * ## 为什么在这里断言"尺寸与无卡块"
 *
 * 断言资源**存在且是 768×1024、不含 tEXt 卡块**，等于同时证明：
 *   ① 打包路径指向的文件真的是那张图（不是被替换成了别的东西）；
 *   ② 它是一张干净的模板（带着卡块的模板会让每张导出的卡都继承旧数据）。
 *
 * 判据全部落在仓库内文件上，不需要跑 `tauri build`（那要几分钟且要 Windows SDK）。
 * 真实打进 MSI 的结果由 `npm run build:client` 的第 6/7 步（构建树内嵌 + 出厂件审计）负责。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readPngChunks } from '../shared/dist/png-card.js';

const ROOT = join(import.meta.dirname, '..');
const TAURI_CONF = join(ROOT, 'client/src-tauri/tauri.conf.json');
const FACE_SRC = join(ROOT, 'client/src-tauri/resources/card-face-default.png');

const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8'));

/** `bundle.resources` 支持「字符串」与「{ 源: 目标 }」两种写法，这里统一成 map */
function resourceMap(raw) {
  if (raw === undefined || raw === null) return new Map();
  if (Array.isArray(raw)) return new Map(raw.map((item) => [item, item]));
  return new Map(Object.entries(raw));
}

test('card-face-default.png 已声明进 bundle.resources（漏了只在"默认卡面"那一步炸）', () => {
  const resources = resourceMap(conf.bundle?.resources);
  const entry = [...resources.entries()].find(([, target]) => target === 'card-face-default.png');
  assert.notEqual(
    entry,
    undefined,
    'bundle.resources 里没有 card-face-default.png —— 装出来的客户端点「PNG 卡 → 默认卡面」会报 PATH_NOT_FOUND',
  );
  assert.equal(entry[0], 'resources/card-face-default.png', '源路径应当指向 src-tauri/resources 下的那张图');
});

test('资源声明的源文件真实存在（声明了但文件不在，tauri build 才报错，太晚）', () => {
  const resources = resourceMap(conf.bundle?.resources);
  for (const [source] of resources.entries()) {
    if (source.startsWith('../../')) continue; // 指向仓库根的规则目录，另有测试
    const absolute = join(ROOT, 'client/src-tauri', source);
    assert.ok(existsSync(absolute), `资源 ${source} 的源文件不存在：${absolute}`);
  }
  assert.ok(existsSync(FACE_SRC), '默认卡面源文件不见了');
});

test('默认卡面是合法 PNG，768×1024，且不含卡数据块', () => {
  const bytes = new Uint8Array(readFileSync(FACE_SRC));
  const chunks = readPngChunks(bytes); // 内部逐块校验 CRC

  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR');
  assert.notEqual(ihdr, undefined, '没有 IHDR，不是合法 PNG');
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  assert.equal(view.getUint32(0), 768, '默认卡面宽度变了 —— 导出后的卡面比例会跟着变');
  assert.equal(view.getUint32(4), 1024, '默认卡面高度变了');

  const cardTexts = chunks.filter((chunk) => {
    if (chunk.type !== 'tEXt') return false;
    const keyword = Buffer.from(chunk.data.subarray(0, chunk.data.indexOf(0))).toString('latin1');
    return keyword === 'ccv3' || keyword === 'chara';
  });
  assert.deepEqual(
    cardTexts.map((chunk) => chunk.type),
    [],
    '模板图里带了卡数据块 —— 每张导出的卡都会继承它，等于把别人的卡内容塞进用户的卡',
  );
});

test('rules 资源仍在清单里（删它会让应用起不来，这条防"顺手清理"）', () => {
  const resources = resourceMap(conf.bundle?.resources);
  assert.ok(
    [...resources.values()].includes('rules'),
    'bundle.resources 里没有 rules —— 客户端会因为找不到规则目录而起不来',
  );
});
