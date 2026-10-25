/**
 * 高亮方案对三个板块的覆盖（v0.1.3 追加项二）。
 *
 * ## 三个板块此前各自缺什么
 *
 * | 板块 | 现象 | 原因 |
 * |---|---|---|
 * | `worldbook` | `@@ENTRY` / `keys:` / `@@CONTENT` / `@@END` 一个都没配色 | 编辑器里显示的是**世界书 TXT**，但方案里没有任何针对它的规则 |
 * | `chat-examples` | `<START>` 被染成"自定义宏"色 | 它是**分段标记**，被那条通用的 `<tag>` 规则顺手抓走了（priority 60 抢先） |
 * | `initial-scene` | 用 `~~~` 之类分隔时没有分隔线配色 | 通用 `hr-line` 只认 `-=*`，不认 `~` |
 *
 * 判据都用**同一段文本喂给多个 blockId** 再比对结果 —— 这样"appliesTo 真的
 * 起了过滤作用"才成立；若只测目标板块"有配色"，把 appliesTo 删掉也能过。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  compileHighlightRule,
  computeHighlightSpans,
  loadHighlightRules,
  parseHighlightRule,
  resolveHighlightRule,
} from '../shared/dist/index.js';

const RULES_DIR = join(import.meta.dirname, '..', 'rules');

function loadAll() {
  const inputs = readdirSync(join(RULES_DIR, 'highlight'))
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(RULES_DIR, 'highlight', name), 'utf8')));
  const { rules, errors } = loadHighlightRules(inputs);
  assert.deepEqual(errors, [], `内置高亮方案必须全部可加载：${JSON.stringify(errors)}`);
  return rules;
}

const DEFAULT = compileHighlightRule(resolveHighlightRule('default', loadAll()));

/** 某段文本在某个板块下命中的 scope 集合 */
function scopesFor(text, blockId) {
  return [...new Set(computeHighlightSpans(text, DEFAULT, { blockId }).map((span) => span.scope))].sort();
}

// ══════════════════════════════════════════════════════════
// 1. 三个板块各至少有一条具名规则
// ══════════════════════════════════════════════════════════

test('default 方案为三个板块各写了至少一条 appliesTo 具名规则', () => {
  const rules = DEFAULT.rules;
  for (const blockId of ['worldbook', 'initial-scene', 'chat-examples']) {
    const owned = rules.filter((rule) => (rule.appliesTo ?? []).includes(`block:${blockId}`));
    assert.ok(
      owned.length >= 1,
      `${blockId} 没有任何专用规则（appliesTo 里含 block:${blockId}）—— 这正是补这块的目的`,
    );
  }
});

test('世界书：条目开闭标记、正文标记、触发键行、条目名行各有规则', () => {
  const ids = DEFAULT.rules.map((rule) => rule.id);
  for (const id of [
    'worldbook-entry-open',
    'worldbook-entry-close',
    'worldbook-content-mark',
    'worldbook-trigger-keys',
    'worldbook-entry-name',
  ]) {
    assert.ok(ids.includes(id), `缺规则 ${id}`);
  }
});

// ══════════════════════════════════════════════════════════
// 2. appliesTo 真的在过滤（同一段文本，不同 blockId 结果不同）
// ══════════════════════════════════════════════════════════

const WORLDBOOK_TEXT = [
  '@@ENTRY 0',
  'name: 银座',
  'keys: 东京, 银座',
  '@@CONTENT',
  '正文一段',
  '@@END 0',
].join('\n');

test('世界书 TXT 的结构标记只在 worldbook 板块着色', () => {
  const inWorldbook = scopesFor(WORLDBOOK_TEXT, 'worldbook');
  assert.ok(inWorldbook.includes('heading'), `@@ENTRY 应归 heading：${JSON.stringify(inWorldbook)}`);
  assert.ok(inWorldbook.includes('attribute'), `keys 行应归 attribute：${JSON.stringify(inWorldbook)}`);
  assert.ok(inWorldbook.includes('subheading'), `@@CONTENT / name 应归 subheading：${JSON.stringify(inWorldbook)}`);
  assert.ok(inWorldbook.includes('separator'), `@@END 应归 separator：${JSON.stringify(inWorldbook)}`);

  // 同一段文本放到 basic 里：一个都不该出现（那说明 appliesTo 没生效）
  const inBasic = scopesFor(WORLDBOOK_TEXT, 'basic');
  assert.deepEqual(inBasic, [], `basic 下不该有任何着色，实际 ${JSON.stringify(inBasic)}`);
});

test('对话示例：<START> 归 subheading，不再被当成自定义宏', () => {
  const text = '<START>\n{{user}}: 你好';
  const inExamples = scopesFor(text, 'chat-examples');
  assert.ok(inExamples.includes('subheading'), `<START> 应归 subheading：${JSON.stringify(inExamples)}`);
  assert.ok(
    !inExamples.includes('placeholder-custom'),
    `<START> 不该再被 custom-macro 抢走：${JSON.stringify(inExamples)}`,
  );
  // 占位符仍按既有 scope（需求要求"沿用现有 scope"）
  assert.ok(inExamples.includes('placeholder'), `{{user}} 应归 placeholder：${JSON.stringify(inExamples)}`);

  // basic 下没有 example-start-marker → <START> 仍走通用的自定义宏规则
  const inBasic = scopesFor(text, 'basic');
  assert.ok(inBasic.includes('placeholder-custom'), `basic 下 <START> 仍应被当作 <tag>：${JSON.stringify(inBasic)}`);
});

test('初始场景：~~~~ 这类分隔行只在 initial-scene 着色（通用 hr-line 不认 ~）', () => {
  const text = '第一段\n~~~\n第二段';
  assert.ok(
    scopesFor(text, 'initial-scene').includes('separator'),
    '~ 分隔行在 initial-scene 下应归 separator',
  );
  assert.deepEqual(scopesFor(text, 'basic'), [], 'basic 下不该因为 ~ 着色');

  // `---` 两边都着色（hr-line 是通用规则），这一步只是把"两条规则不打架"钉住
  const dash = '第一段\n---\n第二段';
  assert.ok(scopesFor(dash, 'initial-scene').includes('separator'));
  assert.ok(scopesFor(dash, 'basic').includes('separator'));
});

test('初始场景：占位符与对话引号沿用既有 scope', () => {
  const text = '{{char}} 说：「你好」{{user}}';
  const scopes = scopesFor(text, 'initial-scene');
  assert.ok(scopes.includes('placeholder'), JSON.stringify(scopes));
  assert.ok(scopes.includes('dialogue'), JSON.stringify(scopes));
});

// ══════════════════════════════════════════════════════════
// 3. 选择器合法值：Schema 与运行时都要认这三个板块
// ══════════════════════════════════════════════════════════

test('appliesTo 接受三个新板块（运行时不拒收）', () => {
  for (const blockId of ['worldbook', 'initial-scene', 'chat-examples']) {
    const result = parseHighlightRule({
      schemaVersion: 1,
      id: `probe-${blockId}`,
      name: 'probe',
      version: '1.0.0',
      extends: null,
      theme: { foreground: '#000', background: '#fff' },
      scopes: [{ id: 'heading', label: '标题', color: '#111' }],
      rules: [
        {
          id: 'r1',
          scope: 'heading',
          appliesTo: [`block:${blockId}`],
          match: { type: 'regex', pattern: '^x$' },
        },
      ],
    });
    assert.deepEqual(result.errors, [], `${blockId} 被拒收：${JSON.stringify(result.errors)}`);
  }
});

test('appliesTo 拒绝拼错的板块 id（不能静默不生效）', () => {
  const result = parseHighlightRule({
    schemaVersion: 1,
    id: 'probe-bad',
    name: 'probe',
    version: '1.0.0',
    extends: null,
    theme: { foreground: '#000', background: '#fff' },
    scopes: [{ id: 'heading', label: '标题', color: '#111' }],
    rules: [
      {
        id: 'r1',
        scope: 'heading',
        appliesTo: ['block:dialogue'],
        match: { type: 'regex', pattern: '^x$' },
      },
    ],
  });
  assert.ok(result.errors.length > 0, 'block:dialogue 不是板块 id（dialogue 是 scope），必须报错');
});
