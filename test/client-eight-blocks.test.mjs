/**
 * 6c：客户端八板块投影与懒渲染红线。
 *
 * 这个文件只守三件事，每一件都对应一次"加板块顺手把别处弄坏"的风险：
 *
 * 1. **客户端不再持有板块清单副本** —— 三份副本（`block-doc.ts` 两份 +
 *    `audit-panel.ts` 的筛选下拉）全部改成从 `BLOCK_IDS` / `BLOCK_DEFINITIONS` 派生。
 *    副本的失效方式很阴：不报错，只是新板块在编辑器里不出现、在审计筛选里选不到。
 * 2. **投影按板块形态分流** —— 文本块从 `card.blocks` 读，世界书走结构化路径
 *    （text 优先、回退 entries 渲染）。两条路径不能合并：世界书的 TEXT 是
 *    entries 的再渲染结果，从 blocks 里读会拿到空。
 * 3. **常驻 CM6 实例数恒为 2** —— 折叠即销毁编辑器，所以"默认展开几个"
 *    就是"常驻几个"。新增两块必须默认折叠。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BLOCK_IDS, parseStCard } from '@tcs/shared';

import {
  DEFAULT_EXPANDED_COUNT,
  EDITOR_BLOCK_IDS,
  TEXT_BLOCK_IDS,
  collectBlocks,
  defaultExpandedBlockIds,
  setBlockText,
} from '../client/src/editor/block-doc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(here, 'fixtures/sample-card.json'), 'utf8'));

function sampleCard() {
  return parseStCard(JSON.stringify(sample)).card;
}

// ---------------------------------------------------------------- 1. 清单派生

test('EDITOR_BLOCK_IDS 就是 BLOCK_IDS（顺序与内容都不得有副本）', () => {
  assert.deepEqual([...EDITOR_BLOCK_IDS], [...BLOCK_IDS]);
  assert.equal(EDITOR_BLOCK_IDS.length, 8);
});

test('TEXT_BLOCK_IDS = BLOCK_IDS 去掉世界书（结构化板块走另一条路径）', () => {
  assert.deepEqual(
    [...TEXT_BLOCK_IDS],
    BLOCK_IDS.filter((id) => id !== 'worldbook'),
  );
  assert.equal(TEXT_BLOCK_IDS.length, 7);
  assert.ok(!TEXT_BLOCK_IDS.includes('worldbook'));
});

test('客户端源码里不再出现硬编码的板块清单数组', () => {
  // 判据是"源码里是否有把多个板块 id 写在一起的字面量"，
  // 而不是"出现板块名字"—— 注释与单点判断（id === 'worldbook'）是合法的。
  const sources = ['client/src/editor/block-doc.ts', 'client/src/audit/audit-panel.ts'];
  for (const relative of sources) {
    const code = readFileSync(join(here, '..', relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const hardcoded = /\[\s*'basic'\s*,\s*'personality'/.test(code);
    assert.ok(!hardcoded, `${relative} 里还有硬编码的板块清单数组`);
  }
});

// ---------------------------------------------------------------- 2. 投影分流

test('collectBlocks 产出八项，顺序同 BLOCK_IDS', () => {
  const blocks = collectBlocks(sampleCard());
  assert.equal(blocks.length, 8);
  assert.deepEqual(blocks.map((block) => block.id), [...BLOCK_IDS]);
});

test('两个新板块从 card.blocks 读到文本（字段板块走文本路径）', () => {
  const raw = JSON.parse(JSON.stringify(sample));
  const data = raw.data ?? raw;
  data.first_mes = '开场白';
  // 样本卡自带 alternate_greetings，会按分隔行拼在 first_mes 后面 —— 先清空，
  // 否则断言看到的是「开场白 + --- + 备用开场白」而误以为首段取错。
  data.alternate_greetings = [];
  data.mes_example = '<START>\n{{user}}: 你好';
  const card = parseStCard(JSON.stringify(raw)).card;
  const blocks = collectBlocks(card);
  assert.equal(blocks.find((block) => block.id === 'initial-scene').text, '开场白');
  assert.equal(blocks.find((block) => block.id === 'chat-examples').text, '<START>\n{{user}}: 你好');
});

test('世界书仍走结构化路径：text 为空时按 entries 现场渲染（不与文本块合并）', () => {
  const card = sampleCard();
  // 人为清空 text，模拟"刚从 JSON 导入"的状态
  const withEntries = { ...card, worldbook: { ...card.worldbook, text: '' } };
  const blocks = collectBlocks(withEntries);
  const worldbook = blocks.find((block) => block.id === 'worldbook');
  assert.ok(worldbook.text.length > 0, 'text 为空时应回退到 entries 渲染');
  assert.equal(worldbook.missing, false, '世界书不该有"原文缺失"标记');
});

test('八个板块的 label 都来自 BLOCK_DEFINITIONS（不是空串或英文 id）', () => {
  const blocks = collectBlocks(sampleCard());
  for (const block of blocks) {
    assert.ok(block.label.length > 0, `${block.id} 没有中文标签`);
    assert.notEqual(block.label, block.id, `${block.id} 的标签退化成 id，说明定义表没取到`);
  }
});

// ---------------------------------------------------------------- 3. 懒渲染红线

test('常驻编辑器数恒为 2（这个常量不随板块总数变化）', () => {
  assert.equal(DEFAULT_EXPANDED_COUNT, 2);
});

test('默认展开的只有 basic + personality：两个新板块必须折叠', () => {
  const blocks = collectBlocks(sampleCard());
  const expanded = defaultExpandedBlockIds(blocks);
  assert.deepEqual(expanded, ['basic', 'personality']);
  assert.ok(!expanded.includes('chat-examples'), '对话示例必须默认折叠（懒渲染红线）');
  assert.ok(!expanded.includes('initial-scene'), '初始场景必须默认折叠（懒渲染红线）');
  assert.equal(expanded.length, 2, `常驻编辑器数应为 2，实际 ${String(expanded.length)}`);
});

test('板块总数变了但展开数不变（8 板块与 6 板块时都是 2）', () => {
  const eight = collectBlocks(sampleCard());
  const sixLike = eight.filter((block) => block.id !== 'chat-examples' && block.id !== 'initial-scene');
  assert.equal(defaultExpandedBlockIds(sixLike).length, 2);
  assert.equal(defaultExpandedBlockIds(eight).length, 2);
  assert.deepEqual(defaultExpandedBlockIds(sixLike), defaultExpandedBlockIds(eight));
});

// ---------------------------------------------------------------- 4. 编辑路径

test('编辑字段板块：文本写进 blocks 且置 dirty（导出时才会回写 residual）', () => {
  const card = sampleCard();
  const result = setBlockText(card, 'chat-examples', '<START>\n新示例');
  assert.equal(result.changed, true);
  const block = result.card.blocks.find((item) => item.id === 'chat-examples');
  assert.equal(block.text, '<START>\n新示例');
  assert.equal(block.dirty, true);
  // 原卡的 residual 此刻还不该变 —— 回写发生在序列化时
  assert.notEqual(result.card.residual.mesExample, '<START>\n新示例');
});

test('编辑文本相同时不置脏（避免每敲一次都重跑校验）', () => {
  const card = sampleCard();
  const block = card.blocks.find((item) => item.id === 'initial-scene');
  const result = setBlockText(card, 'initial-scene', block.text);
  assert.equal(result.changed, false);
  assert.equal(result.card, card);
});
