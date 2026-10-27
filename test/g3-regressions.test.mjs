/**
 * G3：三项线上缺陷的回归（v0.1.5）。
 *
 * 全部以用户提供的「西奥.json」为样本。三件事必须分开钉：
 *
 *   1. **legacy 误报**：标准 SillyTavern 卡的 `first_mes` / `mes_example` 是
 *      **顶层字段**，本来就不在 `description` 里。旧判据看的是 description 里的
 *      标题行，于是这类卡**全员**被报「旧格式卡片」。判据必须回到字段内容。
 *
 *   2. **世界书静默丢失**（红线）：用户把别处格式的世界书粘进面板 →
 *      解析 0 条但 `ok=true` → `entries` 被写回空数组 → 导出
 *      `character_book.entries = []`，2300 多字消失且无提示。
 *      三道防线：解析器报 error（不写回）/ 导出闸门硬阻断 / 多分隔符容错。
 *
 *   3. **TXT 导出世界书段**：`worldbook.includeHeading` 原来只被 schema 校验、
 *      从未被渲染读取（死参数）。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_WORLDBOOK_FORMAT,
  buildAuditReport,
  loadPresets,
  parseStCard,
  parseWorldbookText,
  parseWorldbookTextWith,
  presetAliasTable,
  renderCardText,
  renderWorldbookText,
} from '../shared/dist/index.js';
import { checkWorldbookExportSafety, evaluateExportGate } from '../client/src/export/export-card.ts';

const ROOT = join(import.meta.dirname, '..');
const XIAO_PATH = 'D:/Desktop/桌面文件/temp/西奥.json';

/** 用户样本。文件不在（CI/干净 clone）时跳过依赖它的用例 */
let xiaoRaw = null;
try {
  xiaoRaw = JSON.parse(readFileSync(XIAO_PATH, 'utf8'));
} catch {
  xiaoRaw = null;
}
const hasXiao = xiaoRaw !== null;

/** 加载内置 TXT 预设（与客户端同一条入口 `loadPresets`，不自己拼对象） */
function loadBuiltinPresets() {
  const dir = join(ROOT, 'rules/presets');
  const items = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
  return loadPresets(items).presets;
}

// ══════════════════════════════════════════════════════════
// 缺陷一：legacy 误报

test('缺陷一：西奥.json 两个字段都有内容 → 不得报 legacy', { skip: !hasXiao }, () => {
  const raw = xiaoRaw;
  assert.ok((raw.data.first_mes ?? '').length > 0, '样本的 first_mes 应当非空');
  assert.ok((raw.data.mes_example ?? '').length > 0, '样本的 mes_example 应当非空');

  for (const preset of loadBuiltinPresets()) {
    const parsed = parseStCard(raw, { preset });
    const report = buildAuditReport(parsed.card, { preset });
    const legacy = report.issues.filter((issue) => issue.id.startsWith('builtin:legacy-six-block'));
    assert.deepEqual(
      legacy,
      [],
      `预设 ${preset.id} 下仍报 legacy —— 标准 ST 卡的两板块本就不在 description 里，不能靠标题行判断`,
    );
  }
});

test('缺陷一：真正的六板块旧卡仍要报 legacy（防线不能被拆掉）', () => {
  /*
   * 造一张"六板块时代"的卡：description 已分块但没有新板块标题，
   * 且 first_mes / mes_example 都为空。这正是旧判据要抓的形态，
   * 修复后必须继续抓 —— 否则等于把一条诊断删掉了。
   */
  const sixBlock = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '旧卡',
      description: '【基本信息】\n姓名：旧卡\n\n【其他设定】\n只有六块。',
      personality: '安静',
      scenario: '场景',
      first_mes: '',
      mes_example: '',
    },
  };
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(sixBlock, { preset });
  const report = buildAuditReport(parsed.card, { preset });
  const legacy = report.issues.filter((issue) => issue.id.startsWith('builtin:legacy-six-block'));
  assert.equal(legacy.length, 1, '两个字段都空的六板块卡必须报 legacy');
  assert.equal(legacy[0].severity, 'info', 'legacy 只能是 info —— 历史卡片永远可审计');
});

test('缺陷一：字段有内容但 description 无新标题 → 不报（内容优先于文本形态）', () => {
  // 用户手删了 description 里的两个标题行，但字段里有内容
  const card = {
    spec: 'chara_card_v2',
    data: {
      name: '只有四块标题',
      description: '【基本信息】\n姓名：x\n\n【其他设定】\n...',
      first_mes: '开场白有内容',
      mes_example: '<START>\n{{user}}: hi',
    },
  };
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(card, { preset });
  const report = buildAuditReport(parsed.card, { preset });
  assert.deepEqual(
    report.issues.filter((issue) => issue.id.startsWith('builtin:legacy-six-block')),
    [],
    '字段有内容就不是旧卡 —— 否则"文本里只有六块标题"会被误当成"没有这两块内容"',
  );
});

// ══════════════════════════════════════════════════════════
// 缺陷二：世界书静默丢失

/** 用户贴进面板的那份文本（格式是【条目N：…】/ 顺序：/ 内容：） */
const FOREIGN_TEXT = [
  '持续世界书',
  '【条目1：西奥核心关系逻辑】',
  '顺序：275',
  '触发概率：100',
  '内容：{{char}}与{{user}}的关系发展缓慢。',
  '【条目2：西奥成人规则】',
  '顺序：300',
  '内容：{{char}}是纯0／固定被动方。',
].join('\n');

test('缺陷二：外来格式文本必须报 error（否则 entries 会被清空）', () => {
  const result = parseWorldbookText(FOREIGN_TEXT);
  assert.equal(result.entries.length, 0, '这段文本确实解析不出条目');
  assert.equal(result.ok, false, 'ok 必须为 false —— 为 true 就会把 entries 写回成空数组');

  const errors = result.issues.filter((issue) => issue.severity === 'error');
  assert.equal(errors.length >= 1, true, '必须有 error 级问题');
  const noMarker = errors.find((issue) => issue.code === 'no-entry-marker');
  assert.notEqual(noMarker, undefined, '应报 no-entry-marker');
  assert.equal(noMarker.line, 1, '要指出从第几行开始就不对');
  assert.match(noMarker.message, /@@ENTRY/, '错误里必须写出正确的标记，否则用户不知道改成什么');
  assert.match(noMarker.message, /【条目/, '应指出检测到的外来格式');
});

test('缺陷二：空世界书仍是合法状态（不能因为加了防线就报错）', () => {
  for (const text of ['', '   \n  \n', '\n\n']) {
    const result = parseWorldbookText(text);
    assert.equal(result.ok, true, `空白文本 ${JSON.stringify(text)} 应当合法`);
    assert.equal(result.entries.length, 0);
    assert.deepEqual(result.issues, [], '空白文本不该产生任何 issue');
  }
});

test('缺陷二：合法世界书（有 @@ENTRY）不受影响', () => {
  const good = ['@@ENTRY 0', 'keys: 测试', '@@CONTENT', '正文', '@@END 0'].join('\n');
  const result = parseWorldbookText(good);
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].content, '正文');
});

test('缺陷二：导出闸门对"text 非空 + entries 空"硬阻断，且不允许绕过', () => {
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    { spec: 'chara_card_v2', data: { name: 'x', description: '【基本信息】\n姓名：x' } },
    { preset },
  );

  // 模拟用户粘贴外来格式后的状态：text 有内容，entries 为空
  const card = {
    ...parsed.card,
    worldbook: { ...parsed.card.worldbook, text: FOREIGN_TEXT, entries: [], dirty: true },
  };

  const reasons = checkWorldbookExportSafety(card);
  assert.equal(reasons.length, 1, '应给出恰好一条硬阻断原因');
  assert.match(reasons[0], /丢失/);
  assert.match(reasons[0], /@@ENTRY/);

  const gate = evaluateExportGate(null, card);
  assert.equal(gate.blocked, true);
  assert.equal(gate.hardBlock, true, '必须是硬阻断 —— 不能给"仍要导出"');
  assert.match(gate.message, /世界书条目未能解析/);
});

test('缺陷二：世界书正常的卡不会被闸门误拦', () => {
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    {
      spec: 'chara_card_v2',
      data: {
        name: 'x',
        description: '【基本信息】\n姓名：x',
        character_book: {
          entries: [{ id: 0, keys: ['测试'], content: '正文', enabled: true, insertion_order: 100 }],
        },
      },
    },
    { preset },
  );
  assert.equal(parsed.card.worldbook.entries.length, 1);
  assert.deepEqual(checkWorldbookExportSafety(parsed.card), []);
});

test('缺陷二：**格式差异不是数据丢失** —— 用户原文与规范渲染不同也不许拦', () => {
  /*
   * 这条是截图当场抓出来的误拦。
   *
   * 第一版判据是 `text !== renderWorldbookText(entries)`，结果**格式完全正确**
   * 的卡也被硬拦住（对照组的截图里导出按钮一样是灰的）。原因很朴素：
   * 用户原文与"规范渲染"必然字形不同（字段写不写、字段顺序、缺省值表达），
   * 于是"不相等"恒成立。
   *
   * 判据必须回到"**能不能完整读回来**"：重新解析当前文本，没有 error 就没丢。
   * 下面这份文本故意写成"规范渲染一定不会产出"的样子（多余字段、非常规顺序），
   * 但它能被完整解析 —— 所以不该拦。
   */
  const text = [
    '@@ENTRY 0',
    'comment: 我自己的备注',
    'keys: 甲, 乙',
    'name: 条目一',
    'enabled: true',
    'insertion_order: 100',
    '@@CONTENT',
    '正文一',
    '@@END 0',
  ].join('\n');

  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    { spec: 'chara_card_v2', data: { name: 'x', description: '【基本信息】\n姓名：x' } },
    { preset },
  );
  const reparse = parseWorldbookText(text);
  assert.equal(reparse.ok, true, '样本自身必须能被完整解析');

  const card = {
    ...parsed.card,
    worldbook: { ...parsed.card.worldbook, text, entries: reparse.entries, dirty: true },
  };
  assert.deepEqual(
    checkWorldbookExportSafety(card),
    [],
    '能完整解析就不是数据丢失 —— 不许因为"和规范渲染长得不一样"就拦',
  );
});

test('缺陷二：部分条目损坏（缺 @@END）仍然要拦', () => {
  // 第二个条目缺 @@END：entries 只解析出 1 条，但文本里有 2 个条目标记
  const text = [
    '@@ENTRY 0',
    '@@CONTENT',
    '正文一',
    '@@END 0',
    '',
    '@@ENTRY 1',
    '@@CONTENT',
    '正文二',
  ].join('\n');
  const reparse = parseWorldbookText(text);
  assert.equal(reparse.ok, false, '缺 @@END 必须报 error');

  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    { spec: 'chara_card_v2', data: { name: 'x', description: '【基本信息】\n姓名：x' } },
    { preset },
  );
  const card = {
    ...parsed.card,
    worldbook: { ...parsed.card.worldbook, text, entries: reparse.entries, dirty: true },
  };
  const reasons = checkWorldbookExportSafety(card);
  assert.equal(reasons.length, 1, '部分损坏必须拦');
  assert.match(reasons[0], /无法解析/, '要说明是"解析不了"，不是"与规范不一致"');
  /*
   * 行号要说的是**条目从哪行开始**，不是"读到文件尾才发现"。
   * `missing-end` 的 `line` 是后者（第 8 行 = 文件结束），对定位没帮助 ——
   * 用户看到"第 8 行"只知道末尾有问题，不知道是哪个条目没闭合。
   */
  assert.match(reasons[0], /第 6 行开始/, '要指出出问题的条目起始行');
});

test('缺陷二：多分隔符——顿号与半角逗号都切开', () => {
  const text = [
    '@@ENTRY 0',
    'keys: 成人、性、做爱、上床、欲望',
    '@@CONTENT',
    '甲',
    '@@END 0',
    '',
    '@@ENTRY 1',
    'keys: 潮吹,射精,内射',
    '@@CONTENT',
    '乙',
    '@@END 1',
  ].join('\n');

  const before = parseWorldbookTextWith(text, { ...DEFAULT_WORLDBOOK_FORMAT, listSeparator: ', ' });
  assert.equal(before.entries[0].keys.length, 1, '旧行为：顿号那行整串当成 1 个关键词（缺陷）');

  const after = parseWorldbookTextWith(text, {
    ...DEFAULT_WORLDBOOK_FORMAT,
    listSeparator: ['、', ',', '，'],
  });
  assert.deepEqual(after.entries[0].keys, ['成人', '性', '做爱', '上床', '欲望']);
  assert.deepEqual(after.entries[1].keys, ['潮吹', '射精', '内射']);
});

test('缺陷二：多分隔符时长的优先（", " 不被 "," 抢先切）', () => {
  const text = ['@@ENTRY 0', 'keys: alpha, beta,gamma', '@@CONTENT', 'x', '@@END 0'].join('\n');
  const result = parseWorldbookTextWith(text, {
    ...DEFAULT_WORLDBOOK_FORMAT,
    listSeparator: [',', ', '],
  });
  assert.deepEqual(
    result.entries[0].keys,
    ['alpha', 'beta', 'gamma'],
    '先匹配 ", " 才不会留下前导空格',
  );
});

test('缺陷二：写回只用第一个分隔符（输出唯一，不抖动）', () => {
  const entries = [
    { id: 0, keys: ['成人', '性'], content: 'x', enabled: true, insertion_order: 100 },
  ];
  const once = renderWorldbookText(entries);
  const twice = renderWorldbookText(entries);
  assert.equal(once, twice, '同一份数据两次渲染必须逐字节相同');
  assert.match(once, /keys: 成人, 性/, '默认分隔符是 ", "（带空格），不能被 trim 掉');
});

// ══════════════════════════════════════════════════════════
// 缺陷三：TXT 导出世界书段

test('缺陷三：TXT 导出含世界书段（entries 有内容时输出 @@ENTRY）', () => {
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    {
      spec: 'chara_card_v2',
      data: {
        name: 'x',
        description: '【基本信息】\n姓名：x',
        character_book: {
          entries: [{ id: 0, keys: ['k'], content: '世界书正文', enabled: true, insertion_order: 100 }],
        },
      },
    },
    { preset },
  );

  const text = renderCardText(parsed.card, preset);
  assert.match(text, /【世界书】/, '应有世界书标题');
  assert.match(text, /@@ENTRY 0/, '应有条目块');
  assert.match(text, /世界书正文/, '应有条目正文');
});

test('缺陷三：worldbook.includeHeading=false 时真的不输出标题（原来这是死参数）', () => {
  const base = loadBuiltinPresets()[0];
  const withHeading = { ...base, worldbook: { includeHeading: true } };
  const withoutHeading = { ...base, worldbook: { includeHeading: false } };

  const parsed = parseStCard(
    {
      spec: 'chara_card_v2',
      data: {
        name: 'x',
        description: '【基本信息】\n姓名：x',
        character_book: {
          entries: [{ id: 0, keys: ['k'], content: '正文A', enabled: true, insertion_order: 100 }],
        },
      },
    },
    { preset: base },
  );

  const yes = renderCardText(parsed.card, withHeading);
  const no = renderCardText(parsed.card, withoutHeading);

  assert.match(yes, /【世界书】/);
  assert.doesNotMatch(no, /【世界书】/, 'includeHeading=false 时标题必须消失');
  assert.match(no, /@@ENTRY 0/, '但条目内容不能跟着消失');
});

test('缺陷三：TXT 里的世界书内容优先用当前文本（用户改了还没解析成功时也不丢）', () => {
  const preset = loadBuiltinPresets()[0];
  const parsed = parseStCard(
    { spec: 'chara_card_v2', data: { name: 'x', description: '【基本信息】\n姓名：x' } },
    { preset },
  );
  const card = {
    ...parsed.card,
    worldbook: { ...parsed.card.worldbook, text: '@@ENTRY 9\n@@CONTENT\n用户手写的\n@@END 9', entries: [] },
  };
  const text = renderCardText(card, preset);
  assert.match(text, /用户手写的/, 'TXT 必须写用户当前看到的那段文本，而不是「上次解析成功的空条目」');
});

test('缺陷三：预设别名表与世界书段标题一致（防止改了标题但导出没跟着变）', () => {
  const preset = loadBuiltinPresets()[0];
  const aliases = presetAliasTable(preset);
  assert.equal(aliases['世界书'], 'worldbook', '【世界书】必须能被解析回 worldbook 板块');
});
