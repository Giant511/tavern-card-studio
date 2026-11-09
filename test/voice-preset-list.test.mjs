/**
 * 语音输入的服务商列表要与「API 连接」同一套形态（2026-11-05）。
 *
 * ## 用户要求
 *
 * > 语音输入里面的服务商的UI不对哈，做成API连接里面的那种就行
 *
 * ## 改之前是什么样
 *
 * 一个原生 `<select class="nb-input nb-select">` + 下面一堆"看不出属于谁"的
 * 共用输入框。而 API 连接是**竖排的行列表**，点一行就地展开它自己的配置，
 * 当前选中那行高亮。同一个 App 里两处"选服务商"长成两个样子。
 *
 * ## 这条判据守什么
 *
 * 1. 语音的服务商行与 API 连接**同类名**（`nb-listitem nb-src-item`）
 *    —— 不是"长得像"，是走同一套 CSS 规则（含刚做的抽屉形态）
 * 2. 每个模板都有对应的行，且带 `data-preset-id`
 * 3. 选中/展开分别用 `aria-pressed` / `aria-expanded`（与 API 连接同源，
 *    CSS 靠 `[aria-expanded='true']` 把它变成抽屉的上半截）
 * 4. 不再有 `<select>`：假控件比没控件更糟（界面上没有的东西，
 *    测试却在操作它）
 * 5. 字段只有**一份**节点，跟着展开的服务商走 —— 否则
 *    `byRole('asr-base-url')[0]` 会取到收起那个，"改了值但保存的不是它"
 *
 * 前四条是静态可查的；第 5 条由 `test/voice-settings-dom.test.mjs`
 * 的运行时断言 + 这里的"只有一个 fieldNodes 数组"共同守住。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁的写法） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const voice = stripComments(read('client/src/chat/voice-settings.ts'));
const api = stripComments(read('client/src/chat/api-page.ts'));

test('★★★ 服务商行必须与「API 连接」同类名（同一套 CSS，不是长得像）', () => {
  /*
   * 这条不是"风格偏好"。`nb-src-item` + `nb-acc-panel` 这一对类名绑着
   * 刚做完的抽屉规则：
   *
   * ```css
   *   .nb-src-item[aria-expanded='true'] { …下圆角归零… }
   *   .nb-src-item[aria-expanded='true'] + .nb-acc-panel { …同一圈边框… }
   * ```
   *
   * 用别的类名会得到"行是行、面板是面板"的两个块 —— 也就是用户说的
   * 「框只框了半截」。
   */
  assert.match(
    voice,
    /el\(doc,\s*'button',\s*'nb-listitem nb-src-item'\)/,
    '语音的服务商行要用 nb-listitem nb-src-item（与 api-page.ts 一致）',
  );
  assert.match(
    voice,
    /el\(doc,\s*'div',\s*'nb-acc-panel'\)/,
    '展开面板要用 nb-acc-panel（与 api-page.ts 一致）',
  );

  /* api-page 那侧也要还是这两个类名 —— 否则"一致"没有参照物 */
  assert.match(api, /'nb-listitem nb-src-item'/, 'api-page 的行类名变了，两边又分叉了');
  assert.match(api, /'nb-acc-panel'/, 'api-page 的面板类名变了');
});

test('★★★ 不再有 <select>（假控件比没控件更糟）', () => {
  assert.doesNotMatch(
    voice,
    /el\(doc,\s*'select'/,
    '语音页不该再有 <select> 服务商：界面上已经换成行列表，留着它只是给测试用的假控件',
  );
  assert.doesNotMatch(
    voice,
    /'preset-select'/,
    'preset-select 这个 data-role 应该消失了（换成 asr-preset-item）',
  );
});

test('★★★ 行与面板都要带 data-preset-id（否则量不出"哪一行对应哪个模板"）', () => {
  assert.match(voice, /button\.setAttribute\('data-preset-id',\s*preset\.id\)/);
  assert.match(voice, /panel\.setAttribute\('data-preset-id',\s*preset\.id\)/);
});

test('★★★ 选中与展开分别用 aria-pressed / aria-expanded', () => {
  /*
   * 两件事必须分开：
   *   `aria-pressed`  = 当前保存时要用的服务商
   *   `aria-expanded` = 现在展开着的是谁
   *
   * 绑在一起会出现"我收起一下看看别的，结果当前服务商被改了"。
   */
  assert.match(voice, /setAttribute\('aria-pressed',\s*String\(row\.id === currentPresetId\)\)/);
  assert.match(voice, /setAttribute\('aria-expanded',\s*String\(row\.id === expandedPresetId\)\)/);
});

test('★★★ 字段只有一份节点，跟着展开的服务商走', () => {
  /*
   * `mountFields` 必须**先清空所有面板**再搬。只清目标那个的话，
   * 上一次展开的那份还留在（隐藏的）面板里，`byRole(...)[0]` 取到旧的。
   */
  assert.match(voice, /const mountFields = \(panel: ElLike \| null\): void => \{/);
  assert.match(
    voice,
    /for \(const one of presetRows\) one\.panel\.replaceChildren\(\);/,
    '搬之前要清空**所有**面板（不只是目标那个）',
  );
  assert.match(voice, /for \(const node of fieldNodes\) panel\.append\(node\);/, '字段要搬进面板');

  /* fieldNodes 只应被赋值一次（两次就是"有两份字段"） */
  const assigns = [...voice.matchAll(/fieldNodes\s*=\s*\[/g)].length;
  assert.equal(assigns, 1, `fieldNodes 被赋值 ${String(assigns)} 次，只该有 1 处`);
});

test('★★ 点已展开的那一行是收起，且不许改选中', () => {
  /*
   * 与 api-page.ts 的手风琴语义一致（那里也有一条"点已展开项要收起"）。
   * 关键在"收起时 `currentPresetId` 不变" —— 否则用户只是收起面板看一眼，
   * 当前服务商就被悄悄改了。
   */
  assert.match(
    voice,
    /if \(expandedPresetId === preset\.id\) \{[\s\S]{0,200}?expandPreset\(null\);[\s\S]{0,80}?return;/,
    '点已展开的行应当只收起、直接 return（不再往下改 currentPresetId）',
  );
});

test('★★ 初始要展开当前服务商（进去就能看到它要填什么）', () => {
  assert.match(voice, /applyPreset\(currentPresetId\);/, '初始要按当前服务商同步模板值');
  assert.match(voice, /expandPreset\(currentPresetId\);/, '初始要展开当前服务商');
});

test('★★★ 面板里不许再重复一遍服务商说明（行副标题已经有了）', () => {
  /*
   * 真机截图里一眼看到的：行下写着「国内直连 · 中文最强」，
   * 展开面板里第一块**又是**「国内直连 · 中文最强」。
   *
   * 成因是历史残留：下拉时代 `preset.note` 需要一段独立文字（下拉只显示名字），
   * 改成行列表后它已经是副标题了，面板里那份就成了重复。
   * API 连接那边从来只有"行上有副标题、面板是字段"，所以照它删。
   */
  assert.doesNotMatch(
    voice,
    /fieldNodes\s*=\s*\[[\s\S]{0,120}?presetNote/,
    'presetNote 不该再被塞进面板（它会和行副标题重复）',
  );
  assert.doesNotMatch(
    voice,
    /presetNote\.textContent\s*=\s*preset\.note/,
    '不该再往面板里写 preset.note',
  );

  /* 行副标题必须还在（删面板那份 ≠ 删说明） */
  assert.match(voice, /hint\.textContent\s*=\s*preset\.note/, '服务商说明要留在行的副标题上');
});

test('★★ 保存时读的 presetId 来自状态变量，不是 DOM', () => {
  /*
   * 原来的 `read()` 读 `presetSelect.value`。select 没了，如果这里漏改，
   * 会变成 `undefined` 或残留旧值 —— 而 TypeScript 不一定报错
   * （取决于有没有 any）。所以显式钉一条。
   */
  assert.match(voice, /presetId:\s*currentPresetId,/, 'read() 里的 presetId 要来自 currentPresetId');
  assert.doesNotMatch(voice, /presetId:\s*\(presetSelect/, '不许再读 presetSelect');
});
