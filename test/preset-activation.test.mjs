/**
 * 「导入后转换被冲掉」与「导入预设不生效」的判据（2026-11-17，用户报「实际导入还是不对」）。
 *
 * ## 守的是两条「前一步做对了、后一步冲掉」的链路
 *
 * ```text
 * ① 说话人写法
 *    parseStCard(chatExamplesFormat) 渲染出「用户：」        ← 对
 *    normalizeOnArrival 只拿到 greeting                     ← 少了 chatExamples
 *      └─ refreshFieldBlockViews(card, greeting)            ← 对话示例被按初始场景格式重算
 *         └─ renderChatExamples(text, undefined) 原样返回    ← 转换被撤销
 *    ⇒ 用户导入卡看到 {{user}}:，而导入那一层永远是对的（最难查那种）
 *
 * ② 导入预设不启用
 *    importFieldPreset 返回新数组、新对象                    ← 对
 *    this.greetingPresets = 新数组                          ← 候选列表更新了
 *    this.greetingPreset  →  仍指向被替换掉的旧对象           ← 生效项没更新
 *    ⇒ 格式一个字都没变，而界面只说「导入成功」
 * ```
 *
 * ## 为什么既有 `arrival.test.mjs` 没抓到
 *
 * 它只测世界书与开场白的重排，从没测过**对话示例的说话人**；
 * 也没测过"导入预设之后格式变没变"—— 那是 app.ts 的职责，而它没有对应判据。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { readEditorImplNoComments } from './lib/editor-source.mjs';

const ROOT = join(import.meta.dirname, '..');

import {
  createEmptyCard,
  DEFAULT_GREETING_FORMAT,
  DEFAULT_WORLDBOOK_FORMAT,
  normalizeOnArrival,
  parseStCard,
} from '../shared/dist/index.js';

/** 幻梦AI 那套：说话人写成「用户：」/「角色：」 */
const CHAT_FORMAT = {
  separator: '',
  labelMap: { turn: '回合', user: '用户', char: '角色' },
};

const ST_EXAMPLES = '对话示例1：午餐\n{{user}}:吃什么？\n{{char}}:都行。';

/** 一张卡，`mes_example` 是 ST 写法 */
function cardWithStExamples() {
  const card = createEmptyCard('示例说话人');
  return {
    ...card,
    residual: { ...card.residual, mesExample: ST_EXAMPLES },
  };
}

// ── ① 到达流程不许把转换冲掉 ──────────────────────────────────

test('★★★ 到达流程带 chatExamples 时，「用户：」不会被刷回「{{user}}:」', () => {
  // 前置：parseStCard 用 chatExamplesFormat 渲染（模拟导入那一刻）
  const parsed = parseStCard(
    { name: '示例说话人', description: '', mes_example: ST_EXAMPLES },
    { chatExamplesFormat: CHAT_FORMAT },
  ).card;
  const rendered = parsed.blocks.find((b) => b.id === 'chat-examples').text;
  assert.ok(rendered.includes('用户：'), '前置：导入那一刻应当已渲染成 用户：');

  // 再过一次到达流程（这就是"导入卡"实际走的路）
  const result = normalizeOnArrival(parsed, {
    worldbook: DEFAULT_WORLDBOOK_FORMAT,
    greeting: DEFAULT_GREETING_FORMAT,
    chatExamples: CHAT_FORMAT,
  });
  const after = result.card.blocks.find((b) => b.id === 'chat-examples').text;
  assert.ok(after.includes('用户：'), `到达流程后仍应是 用户：，实际开头：${after.slice(0, 40)}`);
  assert.ok(!/^\s*\{\{user\}\}\s*:/m.test(after), '不该退回 {{user}}:');
});

test('★★ 不传 chatExamples 时保持原文（没配置就不许动数据）', () => {
  const result = normalizeOnArrival(cardWithStExamples(), {
    worldbook: DEFAULT_WORLDBOOK_FORMAT,
    greeting: DEFAULT_GREETING_FORMAT,
  });
  const text = result.card.blocks.find((b) => b.id === 'chat-examples').text;
  /*
   * 这条守的是"没有 user/char 映射就不改数据"。
   * 若哪天有人把缺省改成"总是按 ST 写法转换"，存量卡的平台写法会被吃掉 ——
   * 那属于静默改数据，比缺功能严重。
   */
  assert.ok(text.includes('{{user}}:'), '没有映射时应当原样');
});

test('★★ 到达流程对开场白仍然生效（两个格式互补，不是替代）', () => {
  const parsed = parseStCard(
    { name: 'A', description: '', first_mes: '正文第一段' },
    { greetingFormat: { separator: '\n\n---\n\n', labelMap: { greeting: '【第一条消息：】' } } },
  ).card;
  assert.ok(
    parsed.blocks.find((b) => b.id === 'initial-scene').text.startsWith('【第一条消息：】'),
    '前置：导入时开场白段标题应是预设那个',
  );
  const result = normalizeOnArrival(parsed, {
    worldbook: DEFAULT_WORLDBOOK_FORMAT,
    greeting: { separator: '\n\n---\n\n', labelMap: { greeting: '【第一条消息：】' } },
    chatExamples: CHAT_FORMAT,
  });
  assert.ok(
    result.card.blocks.find((b) => b.id === 'initial-scene').text.includes('【第一条消息：】'),
    '加了 chatExamples 之后，开场白那一路不能坏',
  );
});

// ── ② 客户端两个入口必须把两个格式都传下去 ────────────────────

const APP_SOURCE = readEditorImplNoComments();

test('★★★ arriveCard 必须把对话示例格式传给到达流程（静态判据）', () => {
  /*
   * `arriveCard` 是三条到达路径（服务器取回 / 打开本地文件 / 导入 TXT）
   * 的唯一汇合点。少传一个参数就退回"转换被冲掉"，而且不报错。
   */
  /* 2026-11-24：arriveCard 搬到 landing.ts，形态与终点都变了。两种都认。 */
  const body =
    /private arriveCard\(card: UnifiedCard\): UnifiedCard \{([\s\S]*?)\n  \}/.exec(APP_SOURCE) ??
    /function arriveCard\(host: LandingHost, card: UnifiedCard\): UnifiedCard \{([\s\S]*?)\n\}/.exec(
      APP_SOURCE,
    );
  assert.notEqual(body, null, '找不到 arriveCard');
  assert.match(
    body[1],
    /chatExamples:\s*this\.chatExamplesFormat\(\)/,
    'arriveCard 必须传 chatExamples：否则导入卡时说话人转换会被刷回 ST 写法',
  );
});

test('★★★ selectFieldPreset 必须把对话示例格式传给视图重算（静态判据）', () => {
  /*
   * 这条路径就是"在下拉里选了一份预设" —— 用户判断"选了有没有反应"的唯一依据。
   * 只传 greeting 时，切换对话示例预设对板块文本毫无影响。
   */
  const body = /private selectFieldPreset\(block: FieldPresetBlock, id: string\): void \{([\s\S]*?)\n  \}/.exec(
    APP_SOURCE,
  );
  assert.notEqual(body, null, '找不到 selectFieldPreset');
  assert.match(
    body[1],
    /refreshFieldBlockViews\([\s\S]{0,200}this\.chatExamplesFormat\(\)/,
    'refreshFieldBlockViews 必须收到 chatExamplesFormat()，否则"选了但没反应"',
  );
});

test('★★★ 导入字段板块预设后必须启用它（静态判据）', () => {
  /*
   * 用户报「实际导入还是不对」的主因。导入只更新了候选数组，而"当前生效"
   * 是**对象引用**，仍指向被替换掉的旧对象 ⇒ 格式没变。
   * 修法是导入成功后走 `selectFieldPreset` —— 它把重指 / 重算视图 / 重检 /
   * 持久化 / 状态栏说明一次做全。
   */
  /*
   * 2026-11-24：函数搬到 import-actions.ts，形态从类方法变成
   * `export function importFieldPresetText(host, block, text)`。
   * 判据钉的是"导入成功后调了 selectFieldPreset"，与它写成方法还是函数无关。
   */
  const at = APP_SOURCE.indexOf('function importFieldPresetText(');
  assert.ok(at >= 0, '找不到 importFieldPresetText');
  const body = APP_SOURCE.slice(at, APP_SOURCE.indexOf('\nexport ', at + 10));
  assert.match(
    body,
    /this\.selectFieldPreset\(block,\s*outcome\.id\)/,
    '导入成功后必须 selectFieldPreset(block, outcome.id)，否则同 id 覆盖等于没做',
  );
});
