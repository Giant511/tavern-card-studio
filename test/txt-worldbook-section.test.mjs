/**
 * 导出/另存为 TXT 必须包含世界书段（v0.1.5 / G6）。
 *
 * ## 这个缺陷是怎么藏住的
 *
 * `shared/format/card-txt.ts` 的 `renderCardText` 一直正确输出世界书段，
 * 而它服务于 **TXT 卡导入**的对称路径。导出面板走的是
 * `client/export/export-card.ts::buildTxtExport` —— 那条函数只遍历
 * `description-segment` / `personality` / `field-backed` 三类，
 * 而世界书是 `structured`，于是**整段被跳过**。
 *
 * 两条路径各写一遍装配逻辑，缺陷只落在其中一条上；而且症状是"文件少了点内容"，
 * 不看仔细根本发现不了。所以这组断言直接打在 `buildTxtExport` 上。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildExportAsync, buildTxtExport } from '../client/src/export/export-card.ts';
import { loadPresets, parseStCard } from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');
const PRESET = loadPresets([
  JSON.parse(readFileSync(join(ROOT, 'rules/presets/default.json'), 'utf8')),
]).presets[0];

/** 一张带世界书的卡：两个条目 + 原文 */
function cardWithWorldbook(overrides = {}) {
  const base = parseStCard(
    JSON.parse(readFileSync(join(ROOT, 'test/fixtures/sample-card.json'), 'utf8')),
  ).card;
  const entries = [
    {
      id: 0,
      keys: ['测试'],
      content: '条目零正文',
      enabled: true,
      insertion_order: 100,
      name: '条目零',
      priority: 10,
    },
    {
      id: 1,
      keys: ['甲', '乙'],
      content: '条目一正文',
      enabled: true,
      insertion_order: 200,
      name: '条目一',
      priority: 10,
    },
  ];
  return {
    ...base,
    worldbook: {
      entries,
      text: '@@ENTRY 0\nname: 条目零\n@@CONTENT\n条目零正文\n@@END 0',
      dirty: true,
      raw: null,
      ...overrides,
    },
  };
}

test('TXT 含世界书标题与正文（原文优先）', () => {
  const txt = buildTxtExport(cardWithWorldbook(), PRESET).text;
  assert.ok(txt.includes('【世界书】'), 'TXT 丢了世界书段');
  assert.ok(txt.includes('条目零正文'), 'TXT 里有标题但没正文');
});

test('worldbook.text 为空时，从 entries 渲染出 @@ENTRY（不是整段消失）', () => {
  const txt = buildTxtExport(cardWithWorldbook({ text: '' }), PRESET).text;
  assert.ok(txt.includes('@@ENTRY 0'), 'worldbook.text 为空时没有回落到 entries');
  assert.ok(txt.includes('@@ENTRY 1'), '只渲染了第一条');
  assert.ok(txt.includes('条目一正文'));
});

test('世界书为空时不出空段（不留一个只有标题的【世界书】）', () => {
  const txt = buildTxtExport(
    cardWithWorldbook({ entries: [], text: '' }),
    PRESET,
  ).text;
  assert.ok(!txt.includes('【世界书】'), '空世界书不该留标题');
});

test('worldbook.includeHeading=false 时不带标题但正文仍在（README §4.3 的承诺）', () => {
  const preset = { ...PRESET, worldbook: { ...(PRESET.worldbook ?? {}), includeHeading: false } };
  const txt = buildTxtExport(cardWithWorldbook(), preset).text;
  assert.ok(!txt.includes('【世界书】'), 'includeHeading=false 时不该有标题');
  assert.ok(txt.includes('条目零正文'), '正文被一起弄丢了');
});

test('世界书段排在 blockOrder 指定的位置（不是永远最后）', () => {
  // 自定义顺序：把 worldbook 放到最前
  const order = PRESET.blockOrder.filter((id) => id !== 'worldbook');
  const preset = { ...PRESET, blockOrder: ['worldbook', ...order] };
  const txt = buildTxtExport(cardWithWorldbook(), preset).text;
  const wbAt = txt.indexOf('【世界书】');
  const basicAt = txt.indexOf('【基本信息】');
  assert.ok(wbAt >= 0 && basicAt >= 0, '两个段都要在');
  assert.ok(wbAt < basicAt, `世界书应排在最前，实际 worldbook@${wbAt} basic@${basicAt}`);
});

test('TXT 与「另存为」走同一条链路（buildExportAsync 的 txt 分支）', async () => {
  const card = cardWithWorldbook();
  const direct = buildTxtExport(card, PRESET).text;
  const viaAsync = (await buildExportAsync(card, PRESET, 'txt')).text;
  assert.equal(viaAsync, direct, '异步封装与直接调用产生了不同内容');
  assert.ok(viaAsync.includes('【世界书】'));
});

test('TXT 仍含世界书时不影响其它板块（回归护栏）', () => {
  const txt = buildTxtExport(cardWithWorldbook(), PRESET).text;
  for (const heading of ['【基本信息】', '【性格】']) {
    assert.ok(txt.includes(heading), `世界书加入后 ${heading} 丢了 —— 装配顺序被改坏`);
  }
});
