/**
 * 「按用户预设导入/导出」的两条能力（2026-11-11）。
 *
 * ## 用户原话
 *
 * > 桌面端如果导入的是ST标准卡，用户又有自己的自定义规则，那么应该要直接
 * > 解析成用户的规则并且填入板块中，如果部分或全部解析失败，那么就原封不动
 * > 的放到对应板块中并且提示哪些地方导入失败，同样的，导出本地和上传到仓库
 * > 如果是标准ST格式，那应该也要映射后导出，如果无法映射应该弹窗说明并建议
 * > 用户导出为TXT。你看现在真卡按照用户自定义规则他告警。
 *
 * ## 这条判据钉的是「格式可配」这半边
 *
 * 他的平台规则要求初始场景出现 `^【初始场景[:：]】`、对话示例用 `用户：`
 * 说话人行。而代码把这两处都**写死**了：
 *
 * ```text
 *   @@情景                        → 他能改的只有"多条开场白分隔"
 *   {{user}}: 原样进板块           → 没有说话人映射
 * ```
 *
 * ⇒ 他的卡永远过不了自己的规则，且**没有任何配置能修好**。
 *
 * 「导入失败降级 + 提示」与「导出无法映射时弹窗」是另外两件事，还没做。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseStCard, stringifyStCard } from '../shared/dist/format/sillytavern-io.js';
import { renderChatExamples, parseChatExamples } from '../shared/dist/format/chat-examples-format.js';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** 一张最小的 V2 卡，只关心 mes_example / first_mes / scenario */
function makeCard(fields) {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '测试角色',
      description: '这是一段足够长的角色设定描述，用来通过最小长度检查，内容本身不参与本判据。',
      personality: '',
      mes_example: '',
      first_mes: '',
      scenario: '',
      ...fields,
    },
  };
}

/* ═══════════════════════════════════════════════════════════
   ① 情景段标题可配
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 初始场景的情景段标题要能按预设改（默认仍是 @@情景）', () => {
  const raw = makeCard({ first_mes: '开场白正文', scenario: '情景正文' });

  const plain = parseStCard(raw).card.blocks.find((b) => b.id === 'initial-scene')?.text ?? '';
  assert.match(plain, /@@情景/, '不给预设时必须仍是默认的 @@情景');
  assert.doesNotMatch(plain, /【初始场景/, '默认不该凭空出现自定义标签');

  const custom = parseStCard(raw, {
    greetingFormat: { separator: '\n\n---\n\n', labelMap: { scenario: '【初始场景：】' } },
  }).card.blocks.find((b) => b.id === 'initial-scene')?.text ?? '';

  assert.match(custom, /【初始场景：】/, '给了 labelMap.scenario 就要用预设那个');
  assert.doesNotMatch(custom, /@@情景/, '给了之后不该再出现默认标签');
});

test('★★★★ 自定义情景标签要能读回来（写进去还得认得出）', () => {
  /*
   * 只渲染不解析 = 数据只进不出。用户在板块里改完情景，导出时
   * 认不出那个自定义标签的话，`scenario` 会变成空串 —— 内容静默丢失。
   */
  const fmt = { separator: '\n\n---\n\n', labelMap: { scenario: '【初始场景：】' } };
  const raw = makeCard({ first_mes: '开场白正文', scenario: '情景正文' });

  const card = parseStCard(raw, { greetingFormat: fmt }).card;
  const scene = card.blocks.find((b) => b.id === 'initial-scene');
  assert.ok(scene !== undefined);

  /* 改一个字触发回写 */
  scene.text = scene.text.replace('情景正文', '改过的情景');
  scene.dirty = true;

  const out = JSON.parse(stringifyStCard(card, { greetingFormat: fmt }));
  assert.equal(out.data.scenario, '改过的情景', '自定义标签必须能反解回 scenario');
});

/* ═══════════════════════════════════════════════════════════
   ② 对话示例说话人可配（双向）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 对话示例的说话人写法要能双向映射', () => {
  const fmt = { separator: '', labelMap: { turn: '回合', user: '用户', char: '角色' } };

  const st = '{{user}}: 你好\n{{char}}: 你也好';
  const rendered = renderChatExamples(st, fmt);
  assert.equal(rendered, '用户： 你好\n角色： 你也好', '导入：渲染成用户平台的写法');

  const back = parseChatExamples(rendered, fmt);
  assert.equal(back, '{{user}}: 你好\n{{char}}: 你也好', '导出：反解回 ST 写法');
});

test('★★★★ 没配说话人时一个字节都不许动', () => {
  /*
   * 默认行为是 v0.1.9 已发布的逐字节行为 —— 老用户不该因为我们加了
   * 一个能力，导出结果就变了。
   */
  const st = '{{user}}: 你好\n{{char}}: 你也好';
  assert.equal(renderChatExamples(st, undefined), st);
  assert.equal(renderChatExamples(st, { separator: '' }), st);
  assert.equal(renderChatExamples(st, { separator: '', labelMap: { turn: '回合' } }), st);
  assert.equal(parseChatExamples(st, undefined), st);
});

test('★★★★ 只转行首的说话人，正文里的同名引用不许动', () => {
  /*
   * ```text
   *   用户：我饿了              ← 说话人行，要转
   *   他说“用户：这个词…”        ← 正文引用，转了就是数据损坏
   * ```
   *
   * 这类损坏事后极难发现（内容看着还在，只是词变了）。
   */
  const fmt = { separator: '', labelMap: { user: '用户' } };
  const text = '用户：我饿了\n他说“用户：这个词是什么意思”';
  const out = parseChatExamples(text, fmt);
  /*
   * 注意断言里**没有空格**：原文 `用户：我饿了` 的冒号后本来就没空格，
   * 转换只替换"标记 + 冒号"那一段，不替用户加空格。
   * （我第一版期望写了 `{{user}}: 我饿了`，那是错的 —— 转换不该改排版。）
   */
  assert.equal(out, '{{user}}:我饿了\n他说“用户：这个词是什么意思”');
});

test('★★★ 标签自带冒号也接受（有人习惯写 用户：）', () => {
  const withColon = renderChatExamples('{{user}}: 嗨', { separator: '', labelMap: { user: '用户：' } });
  assert.equal(withColon, '用户： 嗨', '标签写成 用户： 时不该出现两个冒号');
  const back = parseChatExamples('用户： 嗨', { separator: '', labelMap: { user: '用户：' } });
  assert.equal(back, '{{user}}: 嗨');
});

/* ═══════════════════════════════════════════════════════════
   ③ 接线：预设必须真的传到导入/导出
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 导入与导出都必须拿到 chatExamplesFormat（漏了就是脏数据）', () => {
  /*
   * 能力做出来但没接线，等于没做。这条查的是**调用点**：
   *
   * ```text
   *   parseStCard 的每个调用点     → 要带 chatExamplesFormat
   *   buildExportAsync 的调用点    → 要带 chatExamplesFormat
   * ```
   *
   * 为什么单独钉：它不像类型错误会编译失败（参数是可选的），
   * 漏了只是**静默不生效**，而表现是"用户配了预设但界面没变"。
   */
  const app = read('client/src/editor/app.ts');

  /*
   * ## 两次写错这条判据，都因为"按行看"
   *
   * ```text
   *   第 1 版  matchAll(/parseStCard\(/g)        → 把注释里那句也算进去了
   *   第 2 版  逐行过滤                          → 参数写在**下一行**，
   *                                                于是每个真调用都被判成"没接线"
   * ```
   *
   * 正确做法：定位每个 `parseStCard(` 的位置，向后截一段**片段**再判断。
   * 跨行、跨参数都能覆盖。
   */
  const positions = [];
  let cursor = -1;
  while ((cursor = app.indexOf('parseStCard(', cursor + 1)) !== -1) positions.push(cursor);

  const missing = positions.filter((at) => {
    /* 前面同一行的开头是注释标记 ⇒ 这不是真调用 */
    const lineStart = app.lastIndexOf('\n', at) + 1;
    const prefix = app.slice(lineStart, at);
    if (prefix.trimStart().startsWith('*') || prefix.includes('//')) return false;
    /* 内置样例卡不需要用户格式 */
    const seg = app.slice(at, at + 400);
    if (seg.includes('sampleCardJson')) return false;
    return !seg.includes('chatExamplesFormat');
  });

  assert.deepEqual(
    missing.map((at) => app.slice(at, at + 60).split('\n')[0]),
    [],
    '这些 parseStCard 调用没带 chatExamplesFormat（配了预设也不生效）',
  );

  const explicit = [...app.matchAll(/chatExamplesFormat: this\.chatExamplesFormat\(\)/g)].length;
  assert.ok(explicit >= 4, `期望至少 4 处显式传参，实际 ${String(explicit)} 处`);

  assert.match(
    app,
    /buildExportAsync\([\s\S]{0,200}?this\.chatExamplesFormat\(\)/,
    'buildExportAsync 要给 chatExamplesFormat —— 否则导出时用户写法不会反解',
  );
});

test('★★★★ 导出链的三个函数都要透传（JSON / PNG / 统一入口）', () => {
  /*
   * `buildJsonExport` / `buildPngExport` / `buildExportAsync` 是三条独立的
   * 序列化路径。只改其中一条，另外两条就把 `用户：` 原样写进 `mes_example`
   * —— 而 ST 不认那种说话人写法，那段示例在 ST 里读不到。
   */
  const src = read('client/src/export/export-card.ts');
  const hits = [...src.matchAll(/chatExamplesFormat/g)].length;
  assert.ok(hits >= 6, `export-card.ts 里 chatExamplesFormat 只出现 ${String(hits)} 次，疑似漏了某条路径`);
});

test('★★★ 预设校验要放开 scenario / user / char 三个键', () => {
  /*
   * 校验表不放行，用户写进预设就报"未知角色" —— 能力等于没有。
   */
  const src = read('shared/src/format/field-preset.ts');
  assert.match(src, /'initial-scene':\s*\[[^\]]*'scenario'/, 'initial-scene 要允许 scenario');
  assert.match(src, /'chat-examples':\s*\[[^\]]*'user'/, 'chat-examples 要允许 user');
  assert.match(src, /'chat-examples':\s*\[[^\]]*'char'/, 'chat-examples 要允许 char');
});
