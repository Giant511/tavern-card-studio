/**
 * 「幻梦AI」那套方言的判据（2026-11-17，用户真机反馈）。
 *
 * ## 守的是三件事
 *
 * ```text
 *   ① 对话示例：{{user}}: ↔ 用户：  双向映射（预设在，就会转）
 *   ② 初始场景：【第一条消息：】/【初始场景：】 段标题（规则要这两行）
 *   ③ 世界书：中文字段全角冒号 + ST 原生字段半角冒号，同一份文本都要认
 * ```
 *
 * ## 为什么这个文件不能省
 *
 * 三条**都不会报错**，只会静默地什么都不做：
 *
 * ```text
 *   ① 预设缺 labelMap.user ⇒ 一个字符都不转，板块里还是 {{user}}:，
 *      而用户的规则判「缺说话人行」—— 他看不出是预设没配
 *   ② 预设缺 labelMap.greeting ⇒ 段标题回落 @@开场白，规则永远不过
 *   ③ fieldSeparator 只给一个 ⇒ 另一半字段整行丢弃，条目名退化成
 *      「第 1 条」，还凭空多出一堆"没有关键词"的语义错误
 * ```
 *
 * 期望值全部**手写**自用户的真实卡（西奥.json）与真实预设，
 * 不用被测函数反算 —— 反算出来的"一致"什么也证明不了。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFieldPreset } from '../shared/dist/format/field-preset.js';
import {
  renderChatExamples,
  parseChatExamples,
} from '../shared/dist/format/chat-examples-format.js';
import {
  renderCompositeScene,
  parseCompositeScene,
} from '../shared/dist/format/composite-scene.js';
import { parseWorldbookPreset, resolveFieldSeparatorList } from '../shared/dist/format/worldbook-preset.js';
import { parseWorldbookTextWith, renderWorldbookTextWith } from '../shared/dist/format/worldbook.js';

// 用户「幻梦AI对话示例格式预设.json」（修好后）
const CHAT_PRESET = {
  schemaVersion: 1,
  id: 'huanmeng-chat-examples',
  name: '幻梦AI对话示例格式',
  version: '1.2.0',
  block: 'chat-examples',
  format: { separator: '', labelMap: { turn: '回合', user: '用户', char: '角色' } },
};

// 用户「幻梦AI初始场景格式预设.json」（修好后）
const SCENE_PRESET = {
  schemaVersion: 1,
  id: 'huanmeng-initial-scene',
  name: '幻梦AI初始场景格式',
  version: '1.2.0',
  block: 'initial-scene',
  format: {
    separator: '\n\n---\n\n',
    labelMap: {
      greeting: '【第一条消息：】',
      alternate: '【备用开场 {n}：】',
      scenario: '【初始场景：】',
    },
  },
};

// 用户「幻梦AI世界书格式预设.json」（修好后）
const WB_PRESET = {
  schemaVersion: 1,
  id: 'huanmeng-wb-preset',
  name: '幻梦AI世界书格式',
  version: '1.2.0',
  format: {
    entryOpen: '【条目{id}：',
    contentMark: '内容：',
    entryClose: '条目{id}结束',
    fieldOrder: [
      'name', 'keys', 'position', 'insertion_order', 'priority',
      'constant', 'enabled', 'selective', 'comment',
    ],
    labelMap: {
      name: '名称',
      keys: '关键词',
      insertion_order: '顺序',
      priority: '触发概率',
      position: '触发深度',
    },
    fieldSeparator: ['：', ': ', ':'],
    listSeparator: '，',
    entrySeparator: '\n\n',
  },
};

const chatFormat = () => parseFieldPreset(CHAT_PRESET, 'chat-examples').preset.format;
const sceneFormat = () => parseFieldPreset(SCENE_PRESET, 'initial-scene').preset.format;

// ── ① 对话示例的说话人映射 ─────────────────────────────────────

test('① 对话示例：导入时 {{user}}: → 用户：、{{char}}: → 角色：', () => {
  const st = [
    '对话示例1：日常陪伴',
    '{{user}}:(把咖啡推过去。)“你又把咖啡放凉了。”',
    '{{char}}:“(瞥了一眼杯子。)“少管我。”',
  ].join('\n');

  const rendered = renderChatExamples(st, chatFormat());
  assert.ok(rendered.includes('\n用户：'), '导入后应当是 用户：');
  assert.ok(rendered.includes('\n角色：'), '导入后应当是 角色：');
  assert.ok(!rendered.includes('{{user}}:'), '不该还在板块里留 {{user}}:');
});

test('① 对话示例：导出时 用户： → {{user}}:（成对，不留 ST 不认的写法）', () => {
  const platform = '对话示例1：日常陪伴\n用户：“我饿了。”\n角色：“那就吃。”';
  const back = parseChatExamples(platform, chatFormat());
  assert.ok(back.includes('\n{{user}}:'), '导出应还原成 {{user}}:');
  assert.ok(back.includes('\n{{char}}:'), '导出应还原成 {{char}}:');
  assert.ok(!/^\s*用户[:：]/m.test(back), '不许把 用户： 写进 mes_example（ST 整段读不到）');
  /*
   * 半角冒号是 ST 的约定：写成 `{{user}}：`（全角）时内置规则会报
   * `example-macro-halfwidth-colon`，而 ST 解析说话人也只认半角。
   */
  assert.ok(!back.includes('{{user}}：'), '占位符后必须是半角冒号');
});

test('① 对话示例：预设没给 user/char 时**一个字符都不动**（不是报错，是静默）', () => {
  const onlyTurn = parseFieldPreset(
    { ...CHAT_PRESET, format: { separator: '', labelMap: { turn: '回合' } } },
    'chat-examples',
  ).preset.format;
  const st = '{{user}}:你好\n{{char}}:好';
  assert.equal(renderChatExamples(st, onlyTurn), st);
});

test('① 只动行首：正文里引用「用户：」不该被改', () => {
  const text = '用户：“他在卡里写「用户：」这个词。”';
  const back = parseChatExamples(text, chatFormat());
  assert.ok(back.includes('「用户：」'), '正文中的引用必须原样保留');
});

// ── ② 初始场景的段标题 ─────────────────────────────────────────

test('② 初始场景：渲染出【第一条消息：】与【初始场景：】（规则要这两行）', () => {
  const out = renderCompositeScene(
    { firstMes: '开场白正文', alternateGreetings: [], scenario: '情景正文' },
    sceneFormat(),
  );
  assert.ok(out.startsWith('【第一条消息：】\n'), '首行必须是【第一条消息：】');
  assert.ok(out.includes('\n【初始场景：】\n'), '情景段标题必须是【初始场景：】');
  assert.ok(!out.includes('@@'), '不该再写出 @@ 标记（那是另一套方言）');
  /*
   * 段标题不能重复：`greeting` 给了【第一条消息：】时，`first` 就不能再给同一个 ——
   * 否则同一个标记出现两次，第二次会被留在正文里（解析只剥首行）。
   */
  assert.equal(out.split('【第一条消息：】').length - 1, 1, '标记只该出现一次');
});

test('② 初始场景：认得出老卡的 @开场白 / @场景（单 @ 与「场景」两种变体）', () => {
  const legacy = [
    '@开场白',
    '第一条消息:',
    '((({{char}}的视线在{{user}}身上停了片刻。)“你还没走?”',
    '',
    '@场景',
    '（夜里十点半，工作室已经结束营业。）',
  ].join('\n');
  const parsed = parseCompositeScene(legacy, sceneFormat());
  assert.equal(parsed.hasMarkers, true, '要认到段标题，否则标记会漏进 first_mes');
  assert.ok(parsed.firstMes.includes('你还没走'), '开场白进了 first_mes');
  assert.ok(parsed.scenario.includes('夜里十点半'), '情景段要切出来');
  assert.ok(!parsed.firstMes.includes('@场景'), '标记不许漏进正文');
});

test('② 初始场景：一个标记都没有时整段当开场白（存量卡兼容，不许改）', () => {
  const plain = '就是一段开场白\n第二行';
  const parsed = parseCompositeScene(plain, sceneFormat());
  assert.equal(parsed.hasMarkers, false);
  assert.equal(parsed.firstMes, plain, '没有标记时必须逐字节原样');
  assert.equal(parsed.scenario, '');
});

// ── ③ 世界书：混排分隔符 ───────────────────────────────────────

const WB_TEXT = [
  '【条目0：',
  '关键词：',
  '触发深度: after_char',
  '顺序: 250',
  'secondary_keys:',
  'constant: false',
  'enabled: true',
  'selective: true',
  'comment: 西奥的人际关系',
  '内容：',
  '{{char}}身边固定的人际圈子包括：赫尔曼、戴恩。',
  '条目0结束',
].join('\n');

test('③ 世界书中英混排：全角（关键词：）与半角（constant: false）都要认', () => {
  const preset = parseWorldbookPreset(WB_PRESET);
  assert.deepEqual(preset.errors, []);
  const result = parseWorldbookTextWith(WB_TEXT, preset.preset.format);

  assert.deepEqual(result.issues, [], '不该有任何 unexpected-line');
  const entry = result.entries[0];
  assert.equal(entry.insertion_order, 250, '顺序（半角冒号）要读进来');
  assert.equal(entry.position, 'after_char', '触发深度（半角冒号）要读进来');
  assert.equal(entry.constant, false, 'constant 一个字都不能丢');
  assert.equal(entry.enabled, true);
  assert.equal(entry.selective, true);
  assert.ok(entry.content.includes('赫尔曼'), '正文要进来');
  assert.ok(!entry.content.includes('条目0结束'), '结束行不许漏进正文');
});

test('③ 条目名只写了 comment 时，用 comment 当 name（与 JSON 导入一致）', () => {
  const preset = parseWorldbookPreset(WB_PRESET);
  const entry = parseWorldbookTextWith(WB_TEXT, preset.preset.format).entries[0];
  assert.equal(entry.name, '西奥的人际关系', '否则界面显示「第 1 条」，审计还报缺名称');
  assert.equal(entry.comment, '西奥的人际关系', 'comment 原样保留');
});

test('③ 值里带中文冒号时不许切错行（comment: 备注：补充）', () => {
  const preset = parseWorldbookPreset(WB_PRESET);
  const text = [
    '【条目0：',
    'comment: 备注：补充说明',
    '内容：',
    '正文',
  ].join('\n');
  const entry = parseWorldbookTextWith(text, preset.preset.format).entries[0];
  /*
   * 若按"先出现的分隔符"切，全角冒号会把标签切成 `comment: 备注`，
   * 整行作废 —— 那正是这条要防的。
   */
  assert.equal(entry.comment, '备注：补充说明');
});

test('③ 写回只用第一个分隔符（输出格式必须唯一）', () => {
  const preset = parseWorldbookPreset(WB_PRESET);
  const result = parseWorldbookTextWith(WB_TEXT, preset.preset.format);
  const out = renderWorldbookTextWith(result.entries, preset.preset.format);
  assert.ok(out.includes('顺序：250'), '中文标签用第一个分隔符（全角）');
});

test('③ fieldSeparator 规范化：字符串/数组/坏值三态', () => {
  assert.deepEqual(resolveFieldSeparatorList(': '), [': ']);
  assert.deepEqual(resolveFieldSeparatorList(['：', ': ']), ['：', ': ']);
  assert.deepEqual(resolveFieldSeparatorList(undefined), [': '], '没给 → 冻结默认');
  assert.deepEqual(resolveFieldSeparatorList([]), [': '], '空数组 → 冻结默认');
  assert.deepEqual(resolveFieldSeparatorList(''), [': '], '空串 → 冻结默认');
});

test('③ 世界书预设：fieldSeparator 数组的校验（空数组/含空项都要报错）', () => {
  const bad = parseWorldbookPreset({
    ...WB_PRESET,
    format: { ...WB_PRESET.format, fieldSeparator: [] },
  });
  assert.ok(bad.errors.some((e) => e.includes('fieldSeparator')));
  const bad2 = parseWorldbookPreset({
    ...WB_PRESET,
    format: { ...WB_PRESET.format, fieldSeparator: ['：', ''] },
  });
  assert.ok(bad2.errors.some((e) => e.includes('fieldSeparator')));
});
