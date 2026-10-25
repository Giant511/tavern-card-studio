/**
 * 字段板块预设（v0.1.3 追加项一）：初始场景 / 对话示例。
 *
 * ## 第一条是铁律
 *
 * `DEFAULT_GREETING_PRESET` / `DEFAULT_CHAT_EXAMPLES_PRESET` 必须让渲染结果与
 * v0.1.3 已发布的行为**逐字节相同**。与世界书预设同一条铁律：
 * **冻结的是 `default` 的参数值，不是"格式不可参数化"这件事。**
 * 所以这条测试的判据不能是"看起来一样"，必须是字符串全等，且判据里
 * **不出现** 期望字面量（否则改默认值时测试会跟着改，等于没钉住）。
 *
 * 做法：把冻结值当输入跑一遍既有函数（`renderGreetings`），断言与
 * "手工按 v0.1.3 的行为拼出来的字符串"相等 —— 手工那句写的是**语义**
 * （空行、---、空行），不是从常量里读的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  countExampleTurns,
  DEFAULT_CHAT_EXAMPLES_PRESET,
  DEFAULT_GREETING_FORMAT,
  DEFAULT_GREETING_PRESET,
  describeFieldPreset,
  effectiveGreetingFormat,
  parseFieldPreset,
  parseGreetings,
  renderGreetings,
} from '@tcs/shared';

// ══════════════════════════════════════════════════════════
// 1. 铁律：default 预设 = 冻结行为（逐字节）
// ══════════════════════════════════════════════════════════

test('铁律：初始场景 default 预设与 v0.1.3 冻结行为逐字节相同', () => {
  const fmt = DEFAULT_GREETING_PRESET.format;

  // 单条：**原样返回**（连首尾空白都不动）—— 存量卡的落点
  const single = '  你好，我是{{char}}。\n';
  assert.equal(
    renderGreetings(single, [], fmt),
    single,
    '单条开场白必须原样返回：任何 trim 都会让"导出再导入"产生 diff',
  );

  // 多条：空行 + --- + 空行 连接，不写任何标签
  const multi = renderGreetings('甲', ['乙', '丙'], fmt);
  assert.equal(multi, '甲\n\n---\n\n乙\n\n---\n\n丙');

  // 与冻结常量同源，不是"另抄一份恰好相等"
  assert.equal(fmt.separator, DEFAULT_GREETING_FORMAT.separator);
  assert.deepEqual(fmt.labelMap, {}, 'default 不许写标签行，否则导出的 TXT 会多出原文没有的行');
});

test('铁律：对话示例 default 预设不切分、不改写正文', () => {
  const fmt = DEFAULT_CHAT_EXAMPLES_PRESET.format;
  assert.equal(fmt.separator, '');
  assert.deepEqual(fmt.labelMap, {});
  assert.equal(
    countExampleTurns('{{char}}: 你好\n<START>\n{{user}}: 嗨', fmt),
    null,
    '没配置分隔符时必须返回 null（= 不统计），不能返回 1 —— 那是在编造一个轮数',
  );
});

test('铁律：往返（render → parse）一个字都不差', () => {
  const fmt = DEFAULT_GREETING_PRESET.format;
  const first = '第一段\n带换行';
  const alts = ['第二段', '第三段\n\n含空行'];
  const round = parseGreetings(renderGreetings(first, alts, fmt), fmt);
  assert.equal(round.firstMes, first);
  assert.deepEqual(round.alternateGreetings, alts);
  assert.equal(round.split, true);
});

test('铁律：没有分隔行时整段算 first_mes（存量卡兼容）', () => {
  const fmt = DEFAULT_GREETING_PRESET.format;
  // 正文里天然含一行 `---`（剧情分镜）—— 但那正是分隔符，会被切分。
  // 这条测试钉住的是"没有分隔行"的情形：多个换行但无 `---` 行。
  const text = '第一幕\n\n第二幕\n\n—— 旁白';
  const parsed = parseGreetings(text, fmt);
  assert.equal(parsed.split, false);
  assert.equal(parsed.firstMes, text);
  assert.deepEqual(parsed.alternateGreetings, []);
});

// ══════════════════════════════════════════════════════════
// 2. schema 校验 / unknown-keys / block 匹配
// ══════════════════════════════════════════════════════════

function basePreset(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'custom',
    name: '自定义',
    version: '1.0.0',
    block: 'initial-scene',
    format: { separator: '\n\n===\n\n', labelMap: {} },
    ...overrides,
  };
}

test('解析：合法预设通过并保留参数', () => {
  const r = parseFieldPreset(basePreset());
  assert.deepEqual(r.errors, []);
  assert.equal(r.preset?.format.separator, '\n\n===\n\n');
  assert.equal(r.preset?.block, 'initial-scene');
});

test('解析：schemaVersion / id / name / version 逐项校验', () => {
  assert.match(parseFieldPreset(basePreset({ schemaVersion: 2 })).errors.join(), /schemaVersion/);
  assert.match(parseFieldPreset(basePreset({ id: 'A' })).errors.join(), /id 不合法/);
  assert.match(parseFieldPreset(basePreset({ name: '  ' })).errors.join(), /name 不能为空/);
  assert.match(parseFieldPreset(basePreset({ version: '1.0' })).errors.join(), /x\.y\.z/);
});

test('解析：block 必须是两个新板块之一，且不能与导入入口不符', () => {
  assert.match(parseFieldPreset(basePreset({ block: 'basic' })).errors.join(), /block 必须是/);

  // 把「对话示例预设」导进「初始场景」那一栏 → 必须明确拒绝并说清原因
  const wrong = parseFieldPreset(
    basePreset({ block: 'chat-examples', format: { separator: '' } }),
    'initial-scene',
  );
  assert.equal(wrong.preset, null);
  assert.match(wrong.errors.join(), /不能导入到「初始场景」/);
});

test('解析：unknown-keys 是 warning（不阻断）并给出"是不是想写"建议', () => {
  const r = parseFieldPreset(
    basePreset({
      block: 'chat-examples',
      // `seperator` 拼错 —— 缺项会**回落到冻结默认值**（不是报错），
      // 所以这里必须靠 warning 才看得出来：否则用户改半天的分隔符根本没生效，
      // 而界面上一切正常。
      format: { seperator: '\n\n@@TURN\n\n', labelMap: {} },
      extraTop: 1,
    }),
    'chat-examples',
  );
  assert.deepEqual(r.errors, [], '未知键不阻断导入（前向兼容）');
  assert.ok(
    r.warnings.some((w) => w.includes('format.seperator') && w.includes('format.separator')),
    `拼写建议没给出来：${JSON.stringify(r.warnings)}`,
  );
  assert.ok(
    r.warnings.some((w) => w.includes('extraTop')),
    '顶层未知键也要报（哪怕它被忽略）',
  );
  // 关键：拼错的键**不生效**，分隔符仍是默认（空串 = 不切分）
  assert.equal(r.preset?.format.separator, '');
});

test('解析：separator 必须含换行且有一行识别标记', () => {
  assert.match(
    parseFieldPreset(basePreset({ format: { separator: '---', labelMap: {} } })).errors.join(),
    /必须含换行/,
  );
  assert.match(
    parseFieldPreset(basePreset({ format: { separator: '\n\n\n\n', labelMap: {} } })).errors.join(),
    /识别标记/,
  );
  // 初始场景不允许空分隔符；对话示例允许（= 不切分）
  assert.match(
    parseFieldPreset(basePreset({ format: { separator: '', labelMap: {} } })).errors.join(),
    /不能为空/,
  );
  assert.deepEqual(
    parseFieldPreset(
      basePreset({ block: 'chat-examples', format: { separator: '', labelMap: {} } }),
      'chat-examples',
    ).errors,
    [],
  );
});

test('解析：labelMap 的键受板块约束、标签不能与分隔标记同形', () => {
  const badRole = parseFieldPreset(
    basePreset({ format: { separator: '\n\n===\n\n', labelMap: { turn: '轮' } } }),
    'initial-scene',
  );
  assert.match(badRole.errors.join(), /未知角色 "turn"/);

  const collide = parseFieldPreset(
    basePreset({ format: { separator: '\n\n===\n\n', labelMap: { first: '===' } } }),
  );
  assert.match(collide.errors.join(), /与 separator 的识别标记/);

  const dup = parseFieldPreset(
    basePreset({ format: { separator: '\n\n===\n\n', labelMap: { first: '标签', alternate: '标签' } } }),
  );
  assert.match(dup.errors.join(), /同时给了 first 与 alternate/);
});

// ══════════════════════════════════════════════════════════
// 3. 带标签的写法：render 与 parse 必须成对
// ══════════════════════════════════════════════════════════

test('带标签的预设：渲染出标签行，解析按同一张表剥掉（往返无损）', () => {
  const { preset } = parseFieldPreset(
    basePreset({
      format: {
        separator: '\n\n===\n\n',
        labelMap: { first: '【开场白】', alternate: '【备用 {n}】' },
      },
    }),
  );
  assert.ok(preset);

  const rendered = renderGreetings('甲是谁', ['乙', '丙'], preset.format);
  assert.ok(rendered.includes('【开场白】\n甲是谁'), rendered);
  assert.ok(rendered.includes('【备用 1】\n乙'), rendered);
  assert.ok(rendered.includes('【备用 2】\n丙'), rendered);

  const parsed = parseGreetings(rendered, preset.format);
  assert.equal(parsed.firstMes, '甲是谁');
  assert.deepEqual(parsed.alternateGreetings, ['乙', '丙']);
});

test('带标签时，正文里恰好出现「【开场白】」这四个字不该被吃掉', () => {
  const { preset } = parseFieldPreset(
    basePreset({ format: { separator: '\n\n===\n\n', labelMap: { first: '【开场白】' } } }),
  );
  assert.ok(preset);
  // 标签只剥**段首那一行**；正文中间的同样文字原样保留
  const text = '【开场白】\n正文第一行\n【开场白】不是标签而是正文';
  const parsed = parseGreetings(text, preset.format);
  assert.equal(parsed.firstMes, '正文第一行\n【开场白】不是标签而是正文');
});

// ══════════════════════════════════════════════════════════
// 4. 生效优先级：专用预设 > TXT 预设的 greeting > 冻结
// ══════════════════════════════════════════════════════════

test('优先级：自定义初始场景预设覆盖 TXT 预设的 greeting.separator', () => {
  const { preset } = parseFieldPreset(basePreset({ id: 'mine', format: { separator: '\n\n===\n\n', labelMap: {} } }));
  assert.ok(preset);
  const eff = effectiveGreetingFormat(preset, { separator: '\n\n***\n\n' });
  assert.equal(eff.source, 'greeting-preset');
  assert.equal(eff.format.separator, '\n\n===\n\n');
});

test('优先级：内置默认不覆盖**值不同**的 TXT 预设 greeting（兼容 v0.1.3 早期写法）', () => {
  const eff = effectiveGreetingFormat(DEFAULT_GREETING_PRESET, { separator: '\n\n***\n\n' });
  assert.equal(eff.source, 'txt-preset');
  assert.equal(eff.format.separator, '\n\n***\n\n');
});

test('优先级：TXT 预设的值与当前一致时**不算接管**（来源要如实）', () => {
  /*
   * 内置 TXT 预设（default / divider / markdown）都写了 `greeting.separator`，
   * 值就等于冻结默认值。若按"有值就标 txt-preset"，面板会一直显示
   * 「生效分隔符来自 TXT 预设」—— 而用户选的是「标准初始场景（v0.1.3 冻结）」。
   * 值一样却说是另一个来源，是**说错了**，哪怕结果相同。
   */
  const eff = effectiveGreetingFormat(DEFAULT_GREETING_PRESET, {
    separator: DEFAULT_GREETING_FORMAT.separator,
  });
  assert.equal(eff.source, 'frozen', `同值时来源应如实为 frozen，实际 ${eff.source}`);

  // 值不同才是真的接管
  const taken = effectiveGreetingFormat(DEFAULT_GREETING_PRESET, { separator: '\n\n***\n\n' });
  assert.equal(taken.source, 'txt-preset');
  assert.equal(taken.format.separator, '\n\n***\n\n');

  // 自定义初始场景预设优先级最高（TXT 预设值再不同也覆盖不了它）
  const custom = parseFieldPreset(
    basePreset({ id: 'mine2', format: { separator: '\n\n===\n\n', labelMap: {} } }),
  ).preset;
  assert.ok(custom);
  const winner = effectiveGreetingFormat(custom, { separator: '\n\n***\n\n' });
  assert.equal(winner.source, 'greeting-preset');
  assert.equal(winner.format.separator, '\n\n===\n\n');
});

test('优先级：两者都没有 → 冻结默认值', () => {
  const eff = effectiveGreetingFormat(null, null);
  assert.equal(eff.source, 'frozen');
  assert.equal(eff.format.separator, DEFAULT_GREETING_FORMAT.separator);
});

// ══════════════════════════════════════════════════════════
// 5. 对话示例轮数 & 面板摘要
// ══════════════════════════════════════════════════════════

test('对话示例轮数：配置了分隔符才统计，且不改写正文', () => {
  const fmt = { separator: '\n\n@@TURN\n\n', labelMap: { turn: '轮' } };
  const text = '甲\n\n@@TURN\n\n乙\n\n@@TURN\n\n丙';
  assert.equal(countExampleTurns(text, fmt), 3);
  // 「不改写正文」：函数是纯的，输入字符串长度不变
  assert.equal(text.length, '甲\n\n@@TURN\n\n乙\n\n@@TURN\n\n丙'.length);
});

test('面板摘要：包含分隔符与标签，且不包含换行', () => {
  const { preset } = parseFieldPreset(
    basePreset({ format: { separator: '\n\n===\n\n', labelMap: { first: '【开场白】' } } }),
  );
  assert.ok(preset);
  const summary = describeFieldPreset(preset);
  assert.ok(summary.includes('==='), summary);
  assert.ok(summary.includes('first=【开场白】'), summary);
  assert.ok(!summary.includes('\n'), `摘要里不许有真换行：${JSON.stringify(summary)}`);
});

test('对话示例：设了分隔符但没给轮次标签 → 一条 warning（不是错误）', () => {
  const r = parseFieldPreset(
    basePreset({ block: 'chat-examples', format: { separator: '\n\n@@TURN\n\n', labelMap: {} } }),
    'chat-examples',
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /labelMap\.turn/);
});
