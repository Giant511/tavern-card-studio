/**
 * 阶段 3 测试：高亮规则加载（T3.1）/ 渲染（T3.2）/ 导入导出（T3.3）
 * 外加 T4.2 字段完整性两级语义的验证。
 *
 * 运行：node --test test/highlight.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseHighlightRule,
  loadHighlightRules,
  resolveHighlightRule,
  compileHighlightRule,
  computeHighlightSpans,
  tokenizeHighlight,
  renderInlineHtml,
  scopeCss,
  importHighlightRuleText,
  exportHighlightRuleText,
  applyHighlightRuleImport,
  parseStCard,
  validateCard,
  resolvePlatformRule,
  loadPlatformRules,
} from '../shared/dist/index.js';

const RULES_DIR = join(import.meta.dirname, '..', 'rules');

function readHighlightFiles() {
  return readdirSync(join(RULES_DIR, 'highlight'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(RULES_DIR, 'highlight', name), 'utf8')));
}

function loadAll() {
  const inputs = readHighlightFiles();
  const { rules, errors } = loadHighlightRules(inputs);
  assert.deepEqual(errors, [], `内置范例必须全部可加载：${JSON.stringify(errors)}`);
  return rules;
}

function compile(id) {
  return compileHighlightRule(resolveHighlightRule(id, loadAll()));
}

/** 构造一份可编译的临时规则集 */
function inlineRule(partial) {
  const base = {
    schemaVersion: 1,
    id: 'tmp',
    name: '临时',
    version: '1.0.0',
    theme: { foreground: '#222222', background: '#ffffff' },
    scopes: [{ id: 'a', label: 'A', color: '#ff0000' }, { id: 'b', label: 'B', color: '#0000ff' }],
    rules: [],
  };
  const parsed = parseHighlightRule({ ...base, ...partial });
  assert.deepEqual(parsed.errors, [], JSON.stringify(parsed.errors));
  return compileHighlightRule(resolveHighlightRule('tmp', [parsed.file]));
}

// ---------------------------------------------------------------- T3.1 加载与校验

test('T3.1 内置三份范例全部通过加载校验', () => {
  const rules = loadAll();
  assert.deepEqual(rules.map((rule) => rule.id).sort(), ['dark', 'default', 'minimal']);
  for (const rule of rules) {
    const parsed = parseHighlightRule(rule);
    assert.deepEqual(parsed.errors, [], `${rule.id}: ${JSON.stringify(parsed.errors)}`);
  }
});

test('T3.1 缺少 theme.foreground 时报错且不返回半成品', () => {
  const result = parseHighlightRule({
    schemaVersion: 1,
    id: 'bad',
    name: '坏',
    version: '1.0.0',
    theme: { background: '#ffffff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [],
  });
  assert.equal(result.file, null);
  assert.ok(result.errors.some((message) => message.includes('theme.foreground')));
});

test('T3.1 正则无法编译、scope 未定义、id 重复都会报错', () => {
  const badRegex = parseHighlightRule({
    schemaVersion: 1, id: 'x1', name: 'x', version: '1.0.0',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [{ id: 'r', scope: 'a', match: { type: 'regex', pattern: '([' } }],
  });
  assert.ok(badRegex.errors.some((message) => message.includes('正则无法编译')), JSON.stringify(badRegex.errors));

  const badScope = parseHighlightRule({
    schemaVersion: 1, id: 'x2', name: 'x', version: '1.0.0',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [{ id: 'r', scope: 'missing', match: { type: 'line-prefix', prefix: '## ' } }],
  });
  assert.ok(badScope.errors.some((message) => message.includes('未定义的 scope "missing"')), JSON.stringify(badScope.errors));

  const dupId = parseHighlightRule({
    schemaVersion: 1, id: 'x3', name: 'x', version: '1.0.0',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }, { id: 'a', label: 'A2', color: '#0f0' }],
    rules: [],
  });
  assert.ok(dupId.errors.some((message) => message.includes('id "a" 重复')), JSON.stringify(dupId.errors));
});

// ── v0.1.2：scope id 含点号必须被拒绝 ─────────────────────
//
// 背景（F6 附件诊断）：`applySchemeStyles` 把 scope id 直接拼进 CSS 类名，
// 而点号在 CSS 选择器里是"类的连接符"。id = `placeholder.char` 会生成
// `.tcs-hl-placeholder.char`，含义变成「同时具有两个类」，元素上却是单个类名
// `tcs-hl-placeholder.char` —— 永不匹配。整份方案的规则一条都不上色，
// 主题却照常生效，看起来像"导入成功但没反应"。
//
// 这组用例锁住三件事：报错（不是静默）、消息里有改名建议、合法 id 不受影响。

test('v0.1.2 scope id 含点号被拒绝，且给出改名建议', () => {
  const dotted = parseHighlightRule({
    schemaVersion: 1,
    id: 'dotted',
    name: '点号方案',
    version: '1.0.0',
    theme: { foreground: '#D4D4D4', background: '#1E1E1E' },
    scopes: [
      { id: 'placeholder.char', label: '角色占位符', color: '#4EC9B0' },
      { id: 'syntax.heading', label: '标题', color: '#C586C0' },
    ],
    rules: [],
  });

  assert.equal(dotted.file, null, '含点号的 scope id 必须让整份方案不被采用（避免半成品）');
  const dottedErrors = dotted.errors.filter((message) => message.includes('不能包含 .'));
  assert.equal(dottedErrors.length, 2, `两个含点号的 id 都要各报一条：${JSON.stringify(dotted.errors)}`);

  // 消息必须说清「为什么」和「改成什么」，否则用户只会看到"id 不合法"然后去猜
  assert.match(dottedErrors[0], /CSS 选择器/, '消息应解释点号为什么不行');
  assert.match(dottedErrors[0], /placeholder-char/, '消息应直接给出改名结果');
  assert.match(dottedErrors[1], /syntax-heading/, '第二条消息也要给出自己的改名结果');
});

test('v0.1.2 连字符/下划线/数字的 scope id 全部合法（不受收紧影响）', () => {
  const ok = parseHighlightRule({
    schemaVersion: 1,
    id: 'fine',
    name: '合法 id',
    version: '1.0.0',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [
      { id: 'placeholder-char', label: 'A', color: '#f00' },
      { id: 'syntax_heading', label: 'B', color: '#0f0' },
      { id: 'level2', label: 'C', color: '#00f' },
    ],
    rules: [],
  });
  assert.deepEqual(ok.errors, [], `连字符/下划线/数字应当放行：${JSON.stringify(ok.errors)}`);
  assert.equal(ok.file?.scopes.length, 3);
});

test('v0.1.2 内置三套方案的 scope id 均不含点号（收紧后无回归）', () => {
  for (const rule of loadAll()) {
    for (const scope of rule.scopes) {
      assert.equal(
        scope.id.includes('.'),
        false,
        `内置方案 ${rule.id} 的 scope "${scope.id}" 含点号，收紧校验后会失效`,
      );
    }
  }
});

test('v0.1.2 其它非法 id 仍报"id 不合法"，不与点号错误混淆', () => {
  const bad = parseHighlightRule({
    schemaVersion: 1,
    id: 'badshape',
    name: 'x',
    version: '1.0.0',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'Has Space', label: 'A', color: '#f00' }],
    rules: [],
  });
  assert.ok(
    bad.errors.some((message) => message.includes('id 不合法') && !message.includes('不能包含 .')),
    `大写与空格应当是"id 不合法"，不是点号那条：${JSON.stringify(bad.errors)}`,
  );
});

test('T3.1 extends 合并：lineage、theme 覆盖、scopes 继承、rules 追加', () => {
  const resolved = resolveHighlightRule('dark', loadAll());
  assert.deepEqual(resolved.lineage, ['default', 'dark']);
  assert.equal(resolved.theme.background, '#1c1f26');
  assert.equal(resolved.editor.fontSize, 15);
  assert.equal(resolved.editor.fontFamily, 'Sarasa Mono SC, Consolas, Menlo, monospace'); // 继承父级
  // 父级 11 个 scope 全部保留，其中 3 个被子级覆盖
  assert.equal(resolved.scopes.length, 11);
  assert.equal(resolved.scopes.find((scope) => scope.id === 'placeholder').color, '#ff9f7a');
  assert.equal(resolved.scopes.find((scope) => scope.id === 'heading').color, '#8ec7ff');
  assert.equal(resolved.scopes.find((scope) => scope.id === 'comment').color, '#8b8b8b'); // 未被覆盖
  /*
   * 父级规则数 + 子级 1 条。
   *
   * **不写死具体数字**：`default` 方案会随版本增删规则（v0.1.3 追加项二就
   * 为三个板块加了 7 条），写死 15 会让"加了一条合理规则"也变成测试红 ——
   * 那种红没人会去分辨"是真的坏了还是数字过时"，最后就是随手改数字。
   * 这里要证明的是**继承是追加**，所以取父级自身条数为基数。
   */
  const parentRules = loadAll().find((item) => item.id === 'default').rules.length;
  assert.equal(resolved.rules.length, parentRules + 1);
  assert.ok(resolved.rules.some((rule) => rule.id === 'todo-marker'));
  assert.ok(resolved.rules.some((rule) => rule.id === 'block-heading'));
});

test('T3.1 extends 指向不存在 / 成环时抛错，不静默降级', () => {
  const orphan = parseHighlightRule({
    schemaVersion: 1, id: 'orphan', name: '孤儿', version: '1.0.0', extends: 'nope',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }], rules: [],
  });
  assert.deepEqual(orphan.errors, []);
  assert.throws(() => resolveHighlightRule('orphan', [orphan.file]), /不存在/);

  const a = parseHighlightRule({
    schemaVersion: 1, id: 'ca', name: 'A', version: '1.0.0', extends: 'cb',
    theme: { foreground: '#000', background: '#fff' }, scopes: [{ id: 'a', label: 'A', color: '#f00' }], rules: [],
  }).file;
  const b = parseHighlightRule({
    schemaVersion: 1, id: 'cb', name: 'B', version: '1.0.0', extends: 'ca',
    theme: { foreground: '#000', background: '#fff' }, scopes: [{ id: 'a', label: 'A', color: '#f00' }], rules: [],
  }).file;
  assert.throws(() => resolveHighlightRule('ca', [a, b]), /环/);
});

test('T3.1 继承链里也找不到 scope 时，合并阶段报错', () => {
  const child = parseHighlightRule({
    schemaVersion: 1, id: 'ch', name: '子', version: '1.0.0', extends: 'minimal',
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [{ id: 'rr', scope: 'ghost', match: { type: 'line-prefix', prefix: '## ' } }],
  }).file;
  const minimal = JSON.parse(readFileSync(join(RULES_DIR, 'highlight', 'minimal.json'), 'utf8'));
  assert.throws(() => resolveHighlightRule('ch', [minimal, child]), /未定义的 scope "ghost"/);
});

// ---------------------------------------------------------------- T3.2 渲染

test('T3.2 delimiter-block 命中 {{char}} 整段', () => {
  const compiled = compile('default');
  const spans = computeHighlightSpans('她说：{{char}} 来了。', compiled);
  const hit = spans.find((span) => span.ruleId === 'char-placeholder');
  assert.ok(hit, JSON.stringify(spans));
  assert.equal('她说：{{char}} 来了。'.slice(hit.start, hit.end), '{{char}}');
});

test('T3.2 regex + wholeLine 把标题整行着色', () => {
  const compiled = compile('default');
  const text = '【基本信息】\n年龄 24';
  const spans = computeHighlightSpans(text, compiled);
  const heading = spans.find((span) => span.ruleId === 'block-heading');
  assert.ok(heading);
  assert.equal(heading.start, 0);
  assert.equal(heading.end, 6); // 「【基本信息】」六个字符，不含换行
});

test('T3.2 word-list 命中中文属性名，wholeWord 对拉丁词生效', () => {
  const compiled = compile('default');
  const spans = computeHighlightSpans('身高 168cm，体重 50kg', compiled, { blockId: 'basic' });
  const texts = spans.filter((span) => span.ruleId === 'profile-attribute').map((span) => '身高 168cm，体重 50kg'.slice(span.start, span.end));
  assert.deepEqual(texts, ['身高', '体重']);

  const latin = inlineRule({
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [{ id: 'word', scope: 'a', match: { type: 'word-list', words: ['art'], caseSensitive: false, wholeWord: true } }],
  });
  const text = 'art cart art';
  const hits = computeHighlightSpans(text, latin).map((span) => text.slice(span.start, span.end));
  assert.deepEqual(hits, ['art', 'art']); // cart 里的 art 被词边界挡掉
});

test('T3.2 line-prefix 只着色前缀本身', () => {
  const compiled = inlineRule({
    rules: [{ id: 'pfx', scope: 'a', match: { type: 'line-prefix', prefix: '## ' } }],
  });
  const text = '## 性格\n沉默';
  const spans = computeHighlightSpans(text, compiled);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), '## ');
});

test('T3.2 未闭合的 delimiter-block 只匹配到行尾', () => {
  const compiled = inlineRule({
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [{ id: 'delim', scope: 'a', match: { type: 'delimiter-block', open: '{{', close: '}}' } }],
  });
  const text = '开头 {{char 没闭合\n第二行';
  const spans = computeHighlightSpans(text, compiled);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), '{{char 没闭合');
});

test('T3.2 冲突消解：高 priority 胜出，同 priority 长匹配胜出', () => {
  const compiled = inlineRule({
    scopes: [
      { id: 'a', label: 'A', color: '#f00' },
      { id: 'b', label: 'B', color: '#00f' },
    ],
    rules: [
      { id: 'low-long', scope: 'a', priority: 10, match: { type: 'word-list', words: ['abcdef'], wholeWord: false } },
      { id: 'high-short', scope: 'b', priority: 20, match: { type: 'word-list', words: ['abc'], wholeWord: false } },
    ],
  });
  // priority 高者优先：abc 段被高优先级拿走，剩下的 def 仍归低优先级（区间占位只保护已占用部分）
  const spans = computeHighlightSpans('abcdef', compiled);
  assert.deepEqual(spans.map((span) => span.ruleId), ['high-short', 'low-long']);
  assert.equal('abcdef'.slice(spans[0].start, spans[0].end), 'abc');
  assert.equal('abcdef'.slice(spans[1].start, spans[1].end), 'def');

  const sameLevel = inlineRule({
    scopes: [
      { id: 'a', label: 'A', color: '#f00' },
      { id: 'b', label: 'B', color: '#00f' },
    ],
    rules: [
      { id: 'short', scope: 'a', priority: 5, match: { type: 'word-list', words: ['abc'], wholeWord: false } },
      { id: 'long', scope: 'b', priority: 5, match: { type: 'word-list', words: ['abcdef'], wholeWord: false } },
    ],
  });
  const spans2 = computeHighlightSpans('abcdef', sameLevel);
  assert.deepEqual(spans2.map((span) => span.ruleId), ['long']);
});

test('T3.2 输出区间互不重叠且按 start 升序', () => {
  const compiled = compile('default');
  const text = ['【基本信息】', '年龄 24，身高 168cm', '', '她说「{{char}} 你来了」（笑）', '', '---', '', '- 爱好：看书', '// 备注'].join('\n');
  const spans = computeHighlightSpans(text, compiled);
  assert.ok(spans.length >= 8, `命中过少：${spans.length}`);
  const rules = new Set(spans.map((span) => span.ruleId));
  for (const id of ['block-heading', 'char-placeholder', 'profile-attribute', 'hr-line', 'list-item', 'commented-note']) {
    assert.ok(rules.has(id), `未命中规则 ${id}：${[...rules].join(',')}`);
  }
  // 含占位符的对话：{{char}} 归 placeholder，前后两段仍归 dialogue（部分重叠保留未占用部分）
  assert.ok(rules.has('dialogue-cn-quote'), `对话规则未命中：${[...rules].join(',')}`);
  for (let i = 1; i < spans.length; i += 1) {
    assert.ok(spans[i].start >= spans[i - 1].end, `区间重叠：${JSON.stringify(spans[i - 1])} / ${JSON.stringify(spans[i])}`);
  }
});

test('T3.2 tokenize 拼接后与原文逐字相等', () => {
  const compiled = compile('default');
  const text = '【基本信息】\n{{char}} 说「你好」（挥手）\n**强调**\n身高 168';
  const segments = tokenizeHighlight(text, compiled);
  assert.equal(segments.map((segment) => segment.text).join(''), text);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, text.length);
  assert.ok(segments.some((segment) => segment.scope === 'placeholder'));
  assert.ok(segments.some((segment) => segment.scope === 'dialogue'));
  assert.ok(segments.some((segment) => segment.scope === 'action'));
  assert.ok(segments.some((segment) => segment.scope === 'emphasis'));
});

test('T3.2 appliesTo 只在指定板块生效', () => {
  const compiled = inlineRule({
    rules: [{ id: 'only-basic', scope: 'a', appliesTo: ['block:basic'], match: { type: 'word-list', words: ['关键词'] } }],
  });
  assert.equal(computeHighlightSpans('关键词', compiled, { blockId: 'basic' }).length, 1);
  assert.equal(computeHighlightSpans('关键词', compiled, { blockId: 'special' }).length, 0);
  assert.equal(computeHighlightSpans('关键词', compiled, {}).length, 1); // 缺省上下文不限制
});

test('T3.2 renderInlineHtml 转义 HTML 并带 scope class', () => {
  const compiled = compile('default');
  const html = renderInlineHtml('<BOT> & "x"', compiled, {}, { withWrapper: false });
  assert.ok(!html.includes('<BOT>'), html);
  assert.ok(html.includes('&lt;BOT&gt;'));
  assert.ok(html.includes('class="tcs-hl tcs-hl-placeholder-custom"'), html);
  assert.ok(html.includes('data-rule="custom-macro"'), html);

  const wrapped = renderInlineHtml('abc', compiled);
  assert.ok(wrapped.startsWith('<div class="tcs-highlight"'), wrapped);
  assert.ok(wrapped.includes('data-scheme="default"'), wrapped);
});

test('T3.2 真实卡片文本能被默认方案着色（placeholder / 属性 / 对话 / 标题）', () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sample-card.json'), 'utf8'));
  const { card } = parseStCard(raw);
  const compiled = compile('default');
  const scopes = new Set();
  for (const block of card.blocks) {
    // 板块正文不含标题行，标题单独用原始 description 验证
    for (const span of computeHighlightSpans(block.text, compiled, { blockId: block.id })) scopes.add(span.scope);
  }
  for (const span of computeHighlightSpans(raw.data.description, compiled)) scopes.add(span.scope);
  for (const expected of ['heading', 'placeholder', 'attribute', 'dialogue']) {
    assert.ok(scopes.has(expected), `缺少 scope ${expected}：${[...scopes].join(',')}`);
  }
});

test('T3.2 scopeCss 输出可预期的 CSS 声明', () => {
  assert.equal(
    scopeCss({ id: 'x', label: 'X', color: '#f00', backgroundColor: '#eee', bold: true, italic: true }),
    'color:#f00;background-color:#eee;font-weight:600;font-style:italic',
  );
});

// ---------------------------------------------------------------- T3.3 导入导出

test('T3.3 导出 → 导入 round-trip 深度相等', () => {
  const rules = loadAll();
  for (const rule of rules) {
    const text = exportHighlightRuleText(rule);
    const imported = importHighlightRuleText(text);
    assert.equal(imported.ok, true, `${rule.id}: ${JSON.stringify(imported.errors)}`);
    assert.deepEqual(imported.file, rule, `${rule.id} round-trip 不一致`);
  }
});

test('T3.3 导出字段顺序固定，便于版本 diff', () => {
  const minimal = loadAll().find((rule) => rule.id === 'minimal');
  const text = exportHighlightRuleText(minimal);
  const keys = Object.keys(JSON.parse(text));
  assert.deepEqual(keys, ['schemaVersion', 'id', 'name', 'version', 'description', 'extends', 'theme', 'scopes', 'rules', 'metadata']);
  const ruleKeys = Object.keys(JSON.parse(text).rules[0]);
  assert.deepEqual(ruleKeys, ['id', 'scope', 'priority', 'match']);
  assert.equal(Object.keys(JSON.parse(text).rules[0].match)[0], 'type');
  assert.ok(text.endsWith('\n'));
});

test('T3.3 导入失败保留当前方案（坏 JSON / scope 未定义）', () => {
  const current = resolveHighlightRule('default', loadAll());

  const broken = applyHighlightRuleImport(current, '{ "schemaVersion": 1, ');
  assert.equal(broken.ok, false);
  assert.equal(broken.replaced, false);
  assert.equal(broken.file, current);
  assert.ok(broken.errors.some((message) => message.includes('JSON 解析失败')), JSON.stringify(broken.errors));

  const badScope = applyHighlightRuleImport(
    current,
    JSON.stringify({
      schemaVersion: 1, id: 'z', name: 'z', version: '1.0.0',
      theme: { foreground: '#000', background: '#fff' },
      scopes: [{ id: 'a', label: 'A', color: '#f00' }],
      rules: [{ id: 'rr', scope: 'ghost', match: { type: 'line-prefix', prefix: '#' } }],
    }),
  );
  assert.equal(badScope.ok, false);
  assert.equal(badScope.file, current);
  assert.ok(badScope.errors.some((message) => message.includes('未定义的 scope')), JSON.stringify(badScope.errors));

  const ok = applyHighlightRuleImport(current, exportHighlightRuleText(loadAll().find((rule) => rule.id === 'minimal')));
  assert.equal(ok.ok, true);
  assert.equal(ok.replaced, true);
  assert.equal(ok.file.id, 'minimal');
});

test('T3.3 导入带 BOM 的文本仍能解析', () => {
  const text = `\uFEFF${exportHighlightRuleText(loadAll().find((rule) => rule.id === 'minimal'))}`;
  const result = importHighlightRuleText(text);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.file.id, 'minimal');
});

// ---------------------------------------------------------------- T4.2 两级语义

test('T4.2 有 ST 缺省值的字段缺失只报 info；无缺省值的必填字段缺失报 error', () => {
  const ruleFile = {
    schemaVersion: 1,
    id: 'tt-default',
    name: '测试平台',
    version: '1.0.0',
    target: { spec: 'v2', specVersion: '2.0' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    fields: [
      { path: 'name', label: '角色名', required: true },
      { path: 'constant', label: '世界书条目开关', required: true, stDefault: true },
    ],
    rules: [],
  };
  const { rules } = loadPlatformRules([ruleFile]);
  const resolved = resolvePlatformRule('tt-default', rules);
  const { card } = parseStCard({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '', description: 'x', personality: '', first_mes: '', creator_notes: '', tags: [] },
  });
  const issues = validateCard(card, resolved);
  const byPath = new Map(issues.map((issue) => [issue.ruleId, issue]));

  const nameIssue = byPath.get('builtin:field-required:name');
  assert.ok(nameIssue, JSON.stringify(issues));
  assert.equal(nameIssue.severity, 'error');

  const constantIssue = byPath.get('builtin:field-required:constant');
  assert.ok(constantIssue, JSON.stringify(issues));
  assert.equal(constantIssue.severity, 'info');
  assert.ok(constantIssue.hint.includes('缺省值'));
});

test('回归：wholeLine 按命中最后字符定位行（跨行 \\s* 不吞掉上一行）', () => {
  // `^\s*(?:[-=_*]\s*){3,}$` 的 \s* 会吃掉上一行末尾的换行，
  // 若按 match.index 取行，得到的会是空区间（hr-line 曾因此完全不命中）。
  const compiled = inlineRule({
    scopes: [{ id: 'a', label: 'A', color: '#f00' }],
    rules: [
      { id: 'hr', scope: 'a', priority: 50, match: { type: 'regex', pattern: '^\\s*(?:[-=_*]\\s*){3,}$', flags: 'gm', wholeLine: true } },
    ],
  });
  const text = '上一行\n---\n下一行';
  const spans = computeHighlightSpans(text, compiled);
  assert.equal(spans.length, 1, JSON.stringify(spans));
  assert.equal(text.slice(spans[0].start, spans[0].end), '---');
  assert.equal(spans[0].start, 4); // 「上一行\n」之后
  assert.equal(spans[0].end, 7);   // 不含换行
});

test('确定性：同优先级同长度时先声明者胜（改声明顺序即改结果）', () => {
  const make = (rules) =>
    inlineRule({
      scopes: [
        { id: 'a', label: 'A', color: '#f00' },
        { id: 'b', label: 'B', color: '#00f' },
      ],
      rules,
    });
  const shared = { type: 'word-list', words: ['abc'], wholeWord: false };
  const firstWins = make([
    { id: 'first', scope: 'a', priority: 10, match: shared },
    { id: 'second', scope: 'b', priority: 10, match: shared },
  ]);
  const secondWins = make([
    { id: 'second', scope: 'b', priority: 10, match: shared },
    { id: 'first', scope: 'a', priority: 10, match: shared },
  ]);
  assert.deepEqual(computeHighlightSpans('abc', firstWins).map((span) => span.ruleId), ['first']);
  assert.deepEqual(computeHighlightSpans('abc', secondWins).map((span) => span.ruleId), ['second']);
  // 同一份规则重复计算，结果必须逐字节一致
  const again = computeHighlightSpans('abc', firstWins);
  assert.deepEqual(again, computeHighlightSpans('abc', firstWins));
});
