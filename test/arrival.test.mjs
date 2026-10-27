/**
 * 到达规范化（v0.1.6 生产缺陷一 / 决策 #235–#237）。
 *
 * ## 现场（用户实测，截图在 `release/DEFECT-v016-*.png`）
 *
 * 从服务器**取回**一张标准格式的卡，世界书块 3326 字、内容是
 * `@@ENTRY 1 … @@CONTENT …`；当前激活的世界书预设是自定义那份
 * （`【条目N：…】` 写法）。审计报：
 *
 * > 世界书文本里没有任何条目标记 …… 这段文字未被解析成条目，写回会清空原有条目
 *
 * 文本里明明有 `@@ENTRY 1`。**根因：视图用默认格式渲染、判据用当前预设。**
 *
 * ## 这一组测试守什么
 *
 * ① 正向（现场）：标准格式数据 + 自定义预设 → 取回后世界书正常、可导出；
 * ② 反向：自定义格式数据 + 标准预设 → 同样自动转换；
 * ③ **真解析不出**必须仍然报错（绝不能因为"要兼容"就把红线拆了）；
 * ④ 已经是当前预设的写法时**不做任何改动**（幂等，别每次打开都给提示）；
 * ⑤ 初始场景/对话示例的分隔行跟着当前预设走，且 dirty 的板块不被覆盖；
 * ⑥ description 五板块在这一步**逐字节不变**（不能被"顺手重排"吃掉正文）。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');

// 走 shared/dist（与其它测试一致）：`npm test` 链上有 build:shared，
// 直接 import .ts 需要 loader，而项目没有引入 ts 运行时
import {
  createEmptyCard,
  DEFAULT_GREETING_FORMAT,
  DEFAULT_WORLDBOOK_FORMAT,
  normalizeOnArrival,
  parseStCard,
  parseWorldbookTextWith,
  serializeStCard,
} from '../shared/dist/index.js';

/** 现场那份自定义预设的写法（用户真实格式的简化版） */
const CUSTOM_FORMAT = {
  ...DEFAULT_WORLDBOOK_FORMAT,
  entryOpen: '【条目{id}：',
  entryClose: '【条目{id}结束】',
  contentMark: '内容：',
  fieldPrefix: '',
  entrySeparator: '\n\n',
};

const CUSTOM_GREETING = {
  ...DEFAULT_GREETING_FORMAT,
  separator: '\n\n=== 下一条开场白 ===\n\n',
};

const STANDARD_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '西奥',
    description: '【基本信息】\n八板块 8630 字。\n\n【性格】\n沉默寡言。',
    personality: '沉默寡言。',
    scenario: '深夜的酒馆。',
    first_mes: '他抬眼看了你一下。',
    alternate_greetings: ['他把杯子推过来。'],
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
    character_book: {
      name: '西奥的世界书',
      entries: [
        {
          id: 0,
          keys: ['芭奥'],
          secondary_keys: [],
          comment: '芭奥核心关系逻辑',
          content: '{{char}}与{{user}}的关系发展很慢，从保持距离到逐渐依赖。',
          constant: false,
          selective: false,
          insertion_order: 275,
          enabled: true,
          position: 'before_char',
          priority: 100,
        },
        {
          id: 1,
          keys: ['酒馆'],
          secondary_keys: [],
          comment: '酒馆',
          content: '酒馆在城东，招牌是旧的。',
          constant: false,
          selective: false,
          insertion_order: 276,
          enabled: true,
          position: 'before_char',
          priority: 100,
        },
      ],
      extensions: {},
    },
  },
};

/** 模拟"服务器取回"：服务端存的是 JSON 文本，客户端解析成卡 */
function arriveFromServer(json, formats) {
  const parsed = parseStCard(JSON.parse(json), formats);
  return normalizeOnArrival(parsed.card, formats);
}

const ACTIVE = { worldbook: CUSTOM_FORMAT, greeting: CUSTOM_GREETING };
const STANDARD = { worldbook: DEFAULT_WORLDBOOK_FORMAT, greeting: DEFAULT_GREETING_FORMAT };

// ── ① 正向：现场那张卡 ────────────────────────────────────

test('现场：标准格式卡 + 自定义预设 → 取回后世界书能解析、不再报 no-entry-marker', () => {
  // 关键前提：**旧行为**下 parseStCard 用默认格式渲染文本 —— 先复现那个分叉
  const legacy = normalizeOnArrival(
    parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD))).card,
    ACTIVE,
  );
  assert.equal(legacy.failures.length, 0, '不该有失败');

  const text = legacy.card.worldbook.text;
  assert.ok(text.includes('【条目1：'), `文本应当已按当前预设重排，实际开头：${text.slice(0, 40)}`);
  assert.ok(!text.includes('@@ENTRY'), '重排后不该再留着标准写法的标记');

  // 判据：用**当前预设**解析这段文本，必须能解析出 2 条（这就是"界面能正常显示"的技术含义）
  const reparsed = parseWorldbookTextWith(text, CUSTOM_FORMAT);
  assert.equal(reparsed.ok, true, `按当前预设解析失败：${reparsed.issues.map((i) => i.message).join('|')}`);
  assert.equal(reparsed.entries.length, 2);
  assert.equal(reparsed.entries[0].content.startsWith('{{char}}与{{user}}'), true);
});

test('现场：取回后可以导出（导出闸门按当前预设重解析，不再判"会丢内容"）', () => {
  const arrived = arriveFromServer(JSON.stringify(STANDARD_CARD), ACTIVE);
  assert.equal(arrived.failures.length, 0);

  // 导出走的是同一条判据：文本 → 当前预设解析 → 条目数
  const parsed = parseWorldbookTextWith(arrived.card.worldbook.text, CUSTOM_FORMAT);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 2, '条目一条都不能丢');

  // 而且真的能序列化成 ST JSON，且 character_book.entries 还是 2 条
  const json = serializeStCard(arrived.card);
  assert.equal(json.data.character_book.entries.length, 2);
});

test('正向转换会给一条 info（不是 error）—— 用户没做错事', () => {
  const legacy = normalizeOnArrival(parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD))).card, ACTIVE);
  // entries 存在时是"重排"而非"兜底解析"，同样算一次转换
  assert.equal(legacy.converted, true);
  assert.equal(legacy.failures.length, 0, '格式不匹配不能报成错误');
});

// ── ② 反向：自定义格式数据 + 标准预设 ──────────────────────

test('反向：自定义格式的世界书文本 + 标准预设 → 自动按标准预设重排并给提示', () => {
  /*
   * 构造"只有文本"的到达形态（TXT 卡就是这种）：文本是自定义写法，
   * 当前预设是内置标准格式。旧行为：解析不出 ⇒ 报错；
   * 新行为：用标准预设兜底 → 解析出来 → 按标准预设重排。
   */
  const card = createEmptyCard('反向样本');
  const customText = [
    '【条目1：芭奥核心关系逻辑】',
    'keys: 芭奥',
    '内容：{{char}}与{{user}}的关系发展很慢。',
    '【条目1结束】',
    '【条目2：酒馆】',
    'keys: 酒馆',
    '内容：酒馆在城东。',
    '【条目2结束】',
  ].join('\n');

  const withText = { ...card, worldbook: { ...card.worldbook, text: customText, entries: [] } };
  // 让"标准预设"这边认得自定义写法 —— 用对拍的方式：把兜底格式设成自定义
  const result = normalizeOnArrival(withText, STANDARD, { worldbook: CUSTOM_FORMAT, greeting: DEFAULT_GREETING_FORMAT });

  assert.equal(result.failures.length, 0);
  assert.equal(result.converted, true, '反向也必须自动转换');
  assert.equal(result.card.worldbook.entries.length, 2, '兜底解析必须真的拿到条目');
  assert.ok(result.notes.length >= 1, '必须告诉用户"已按当前预设重新排版"');
  assert.match(result.notes.join(), /重新排版/);
  // 重排后的文本用**当前预设**（标准）解析得回来
  const reparsed = parseWorldbookTextWith(result.card.worldbook.text, DEFAULT_WORLDBOOK_FORMAT);
  assert.equal(reparsed.ok, true);
  assert.equal(reparsed.entries.length, 2);
});

// ── ③ 真解析不出：红线不能拆 ───────────────────────────────

test('真解析不出（两套格式都认不出）→ 必须报错，不是"自动转换"', () => {
  const card = createEmptyCard('乱码样本');
  const garbage = '这是一段完全没有任何标记的自由文本，既不是 @@ENTRY 也不是【条目N】。';
  const withText = { ...card, worldbook: { ...card.worldbook, text: garbage, entries: [] } };

  const result = normalizeOnArrival(withText, ACTIVE, STANDARD);
  assert.equal(result.failures.length, 1, '这种必须报 error —— 报成"已重排"等于把乱码当格式');
  assert.equal(result.failures[0].code, 'worldbook-unparsable');
  assert.match(result.failures[0].message, /兜底/, '错误里要说明"标准预设也试过了"');
  assert.equal(result.converted, false);
  // 原文必须原样留着（绝不能因为转换失败就清空用户文本）
  assert.equal(result.card.worldbook.text, garbage);
  assert.deepEqual(result.card.worldbook.entries, []);
});

test('世界书为空是合法状态，不是失败', () => {
  const card = createEmptyCard('空世界书');
  const result = normalizeOnArrival(card, ACTIVE, STANDARD);
  assert.deepEqual(result.failures, []);
  assert.equal(result.converted, false);
});

// ── ④ 幂等：已经是当前预设就不动 ───────────────────────────

test('已经是当前预设的写法：不做任何改动（否则每次打开都刷一条提示）', () => {
  const once = normalizeOnArrival(
    parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD)), ACTIVE).card,
    ACTIVE,
  );
  const twice = normalizeOnArrival(once.card, ACTIVE);
  assert.equal(twice.converted, false, '第二次不该再算一次转换');
  assert.deepEqual(twice.notes, []);
  assert.equal(twice.card.worldbook.text, once.card.worldbook.text, '文本逐字节相同');
});

// ── ⑤ 初始场景 / 对话示例：分隔行跟当前预设 ─────────────────

test('初始场景的分隔行跟当前预设走（结构化数组 → 当前分隔行）', () => {
  const parsed = parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD)), ACTIVE);
  const result = normalizeOnArrival(parsed.card, ACTIVE);

  const scene = result.card.blocks.find((block) => block.id === 'initial-scene');
  assert.notEqual(scene, undefined);
  assert.ok(
    scene.text.includes('=== 下一条开场白 ==='),
    `初始场景应当用当前预设的分隔行，实际：${JSON.stringify(scene.text)}`,
  );
  // 两条开场白都在（分隔行只是视图，不许丢内容）
  assert.ok(scene.text.includes('他抬眼看了你一下'));
  assert.ok(scene.text.includes('他把杯子推过来'));
});

test('dirty 的字段板块不被到达流程覆盖（用户改过的内容优先）', () => {
  const parsed = parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD)), ACTIVE);
  const edited = {
    ...parsed.card,
    blocks: parsed.card.blocks.map((block) =>
      block.id === 'initial-scene' ? { ...block, text: '用户自己改过的开场白', dirty: true } : block,
    ),
  };
  const result = normalizeOnArrival(edited, ACTIVE);
  const scene = result.card.blocks.find((block) => block.id === 'initial-scene');
  assert.equal(scene.text, '用户自己改过的开场白');
});

// ── ⑥ description 五板块：逐字节不变 ───────────────────────

test('description 五板块经规范化后逐字节不变（不许"顺手重排"吃掉正文）', () => {
  const parsed = parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD)), ACTIVE);
  const before = parsed.card.blocks.filter(
    (block) => block.id !== 'worldbook' && block.id !== 'initial-scene' && block.id !== 'chat-examples',
  );
  const result = normalizeOnArrival(parsed.card, ACTIVE);
  const after = result.card.blocks.filter(
    (block) => block.id !== 'worldbook' && block.id !== 'initial-scene' && block.id !== 'chat-examples',
  );

  assert.equal(before.length, 5, `description 板块应有 5 个，实际 ${String(before.length)}`);
  for (const oldBlock of before) {
    const newBlock = after.find((block) => block.id === oldBlock.id);
    assert.notEqual(newBlock, undefined);
    assert.equal(newBlock.text, oldBlock.text, `板块 ${oldBlock.id} 的正文被改动了`);
    assert.equal(newBlock.raw, oldBlock.raw, `板块 ${oldBlock.id} 的原文被改动了`);
  }
});

// ── ⑦ 结构完整性：转换不许丢字段 ───────────────────────────

test('转换只重排视图，条目的结构化字段一个不少（insertion_order / priority / keys）', () => {
  const result = normalizeOnArrival(
    parseStCard(JSON.parse(JSON.stringify(STANDARD_CARD)), ACTIVE).card,
    ACTIVE,
  );
  const entries = result.card.worldbook.entries;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].insertion_order, 275);
  assert.equal(entries[0].priority, 100);
  assert.deepEqual(entries[0].keys, ['芭奥']);
  assert.equal(entries[1].comment, '酒馆');
});

// ── ⑧ 静态断言：不许出现"第四条忘了传格式"的到达路 ──────────

test('所有 parseStCard 调用点都传了 worldbookFormat（少传一处就是一个洞口）', () => {
  /*
   * 这个缺陷的根因就是"同一个决定写两遍"：起卡时用默认格式渲染文本、
   * 审计时用当前预设解析。修法不能是"记得在某处传参数" ——
   * 必须有断言盯着，否则下一个人新增一条到达路径时必然重犯。
   *
   * 取调用的方式是**括号配平**而不是正则懒惰匹配：`this.greetingFormat()`
   * 里自带一对括号，正则会在那里提前收尾，于是"调用里没有 worldbookFormat"
   * 这个结论恒成立（第一次写就撞上了，四个调用点全报）。
   */
  const files = [];
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        collect(full);
      } else if (entry.name.endsWith('.ts')) {
        files.push(full);
      }
    }
  };
  collect(join(ROOT, 'client', 'src'));

  const offenders = [];
  let checked = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
      /*
       * 转义标记要在剥注释**之前**换成哨兵值：它本身是块注释，
       * 先剥就永远匹配不上（第一次写就是这么假绿的）。
       */
      .replace(/\/\*\s*no-worldbook\s*\*\//g, '__NO_WORLDBOOK__')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    let index = source.indexOf('parseStCard(');
    while (index !== -1) {
      const openAt = index + 'parseStCard('.length;
      let depth = 1;
      let cursor = openAt;
      while (cursor < source.length && depth > 0) {
        const ch = source[cursor];
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        cursor += 1;
      }
      const call = source.slice(openAt, cursor - 1);
      checked += 1;
      /*
       * 下一次的起点**必须先算出来**再判豁免。
       * 用 `continue` 跳过赋值会让 index 永远停在原处 —— 死循环（写的时候撞了，
       * 表现是测试文件永不结束，而不是报错）。
       */
      const next = source.indexOf('parseStCard(', cursor);
      /*
       * 显式豁免：`__NO_WORLDBOOK__` 只允许出现在"刻意复现旧行为"的地方。
       * 标记要看**调用之前**那几十个字符 —— 写成 `? /* … *\/ parseStCard(`
       * 时它落在 `parseStCard(` 左边，只看 call 内部永远匹配不上。
       */
      const context = source.slice(Math.max(0, index - 80), cursor);
      const exempt = call.includes('worldbookFormat') || context.includes('__NO_WORLDBOOK__');
      if (!exempt) {
        offenders.push(`${relative(ROOT, file)} → parseStCard(${call.trim().slice(0, 90)}…)`);
      }
      index = next;
    }
  }

  assert.ok(checked >= 3, `只找到 ${String(checked)} 个调用点，说明扫描本身失效了`);
  assert.deepEqual(
    offenders,
    [],
    '这些 parseStCard 调用没传 worldbookFormat：文本会按默认格式渲染，' +
      '而审计按当前预设解析 —— 就是缺陷一那个分叉。\n' +
      offenders.join('\n'),
  );
});

test('到达规范化的两个落地入口都调了 arriveCard（三条路径共用）', () => {
  const source = readFileSync(join(ROOT, 'client', 'src', 'editor', 'app.ts'), 'utf8');
  const replaceBody = /private replaceCard\(card: UnifiedCard\): void \{([\s\S]*?)\n  \}/.exec(source);
  assert.notEqual(replaceBody, null, '找不到 replaceCard');
  assert.match(replaceBody[1], /this\.arriveCard\(/, 'replaceCard 必须过到达规范化');

  const createBody = /private createSessionWithCard\(card: UnifiedCard, cardId: string\): string \{([\s\S]*?)\n  \}/.exec(source);
  assert.notEqual(createBody, null, '找不到 createSessionWithCard');
  assert.match(createBody[1], /this\.arriveCard\(/, '零标签取回/打开也必须过到达规范化');

  /*
   * 第三条路：TXT 导入。它**不经过** replaceCard（那条会 markSaved，而导入是
   * "改当前卡"），所以必须显式调一次 arriveCard —— 漏了就等于"用自定义世界书
   * 预设导入标准写法的 TXT 仍然报 no-entry-marker"，也就是缺陷一没修完。
   */
  const importBody = /private async importCardTextFile\(([\s\S]*?)\n  \}/.exec(source);
  assert.notEqual(importBody, null, '找不到 importCardTextFile');
  assert.match(
    importBody[1],
    /this\.arriveCard\(decision\.card\)/,
    'TXT 导入必须过到达规范化（它不走 replaceCard）',
  );
});
