/**
 * 「打开一张卡」的落点判据（2026-11-17，用户报）。
 *
 * ## 缺陷
 *
 * 旧行为：不管打开哪张卡，一律 `replaceCard` —— 把**当前标签**的内容整个换掉。
 * 于是"打开一张新卡"＝悄悄丢弃当前卡的内容，而用户并没有要求丢弃。
 *
 * 用户原话：
 *
 * > 点打开选择一张新的卡的时候会自动替换当前的卡的内容，打开应该检查是否与
 * > 已打开的卡名字相同，如果不同就创建新卡并导入，如果有相同的才覆盖替换，
 * > 这个仅限打开路径（不管是TXT、JSON、PNG）
 *
 * ## 这个文件守两层
 *
 * ```text
 * ① 判定逻辑（纯函数）—— 同名覆盖 / 异名新建 / 空名一律新建
 * ② 接线（静态）      —— 三条打开路径都必须走判定，不能有哪条漏回去直接 replaceCard
 * ```
 *
 * 第 ② 层不能省：判定写得再对，只要有一条路径没接上，那条路就还是覆盖。
 * 而且那种漏接**不报错、不崩**，只表现为"有些文件打开会吃掉当前卡"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { decideOpenTarget, nameKey } from '../client/src/session/open-target.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'client/src/editor/app.ts'), 'utf8');

/** 去掉注释再匹配 —— 否则解释规则的文字会被当成代码（踩过） */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SESSIONS = [
  { id: 's1', name: '西奥' },
  { id: 's2', name: '林晚照' },
];

/* ═══════════════════════════════════════════════════════════
   ① 判定逻辑
   ═══════════════════════════════════════════════════════════ */

test('★★★ 同名 → 覆盖那一个（这是用户要的唯一覆盖条件）', () => {
  const target = decideOpenTarget({
    incomingName: '林晚照',
    openSessions: SESSIONS,
    activeId: 's1',
  });
  assert.deepEqual(target, { kind: 'replace', sessionId: 's2', name: '林晚照' });
});

test('★★★ 名字不同 → 一律新建（不许动当前卡）', () => {
  const target = decideOpenTarget({
    incomingName: '凯特',
    openSessions: SESSIONS,
    activeId: 's1',
  });
  assert.equal(target.kind, 'create');
});

test('★★★ 零标签（没有任何已打开卡）→ 新建', () => {
  assert.equal(
    decideOpenTarget({ incomingName: '西奥', openSessions: [], activeId: null }).kind,
    'create',
  );
});

test('★★★ 待打开卡没有名字 → 新建（空名不参与同名匹配）', () => {
  /*
   * 空名字若参与匹配，会把「任何一张未命名卡」都判成同名 ⇒ 覆盖别人的内容。
   * 宁可多开一个标签（可关闭），也不能静默覆盖。
   */
  const unnamed = [{ id: 's1', name: '' }, { id: 's2', name: '西奥' }];
  for (const incomingName of ['', '   ', '\t\n']) {
    assert.equal(
      decideOpenTarget({ incomingName, openSessions: unnamed, activeId: 's1' }).kind,
      'create',
      `空名「${JSON.stringify(incomingName)}」不该匹配到未命名卡`,
    );
  }
});

test('★★ 同名多个时优先当前活动标签（否则"点了打开、界面没变"）', () => {
  const dup = [
    { id: 's1', name: '西奥' },
    { id: 's2', name: '西奥' },
    { id: 's3', name: '别的' },
  ];
  assert.deepEqual(decideOpenTarget({ incomingName: '西奥', openSessions: dup, activeId: 's2' }), {
    kind: 'replace',
    sessionId: 's2',
    name: '西奥',
  });
  // 当前活动不是同名之一 → 取第一个同名（标签顺序，可预期）
  assert.equal(
    decideOpenTarget({ incomingName: '西奥', openSessions: dup, activeId: 's3' }).sessionId,
    's1',
  );
});

test('★★ 比较用 trim，但不做大小写/全半角归一', () => {
  /*
   * 「名字相同」是用户能自己核对的判据。模糊匹配会让"看起来不一样的名字
   * 却互相覆盖"，而覆盖是不可撤销的。
   */
  assert.equal(
    decideOpenTarget({ incomingName: '  西奥  ', openSessions: SESSIONS, activeId: 's1' }).kind,
    'replace',
    '首尾空白应当忽略（用户复制粘贴带空格很常见）',
  );
  assert.equal(
    decideOpenTarget({ incomingName: 'Sio', openSessions: [{ id: 'x', name: 'sio' }], activeId: null }).kind,
    'create',
    '大小写不同就是不同名字',
  );
  assert.equal(
    decideOpenTarget({ incomingName: 'Ａ', openSessions: [{ id: 'x', name: 'A' }], activeId: null }).kind,
    'create',
    '全角与半角不同就是不同名字',
  );
});

test('nameKey：空值三种写法都归一成空串', () => {
  assert.equal(nameKey(null), '');
  assert.equal(nameKey(undefined), '');
  assert.equal(nameKey('  '), '');
  assert.equal(nameKey(' 西奥 '), '西奥');
});

/* ═══════════════════════════════════════════════════════════
   ② 接线：三条打开路径都必须走判定
   ═══════════════════════════════════════════════════════════ */

/** 取某个方法的函数体（按 `private ... 名字(` 定位到下一个同级 `\n  }`） */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `找不到方法：${signature}`);
  const rest = source.slice(start);
  const end = rest.indexOf('\n  }\n');
  assert.notEqual(end, -1, `方法 ${signature} 没有在预期位置结束`);
  return rest.slice(0, end);
}

test('★★★ JSON 打开路径走 openArrivedCard（不再直接 replaceCard）', () => {
  const openCard = stripComments(methodBody(APP, 'private async openCard(): Promise<void> {'));
  assert.match(openCard, /this\.openArrivedCard\(parsed\.card,\s*path\)/, 'JSON 打开必须走判定');
  assert.ok(
    !/this\.replaceCard\(parsed\.card\)/.test(openCard),
    '不许直接 replaceCard —— 那会把当前卡整个换掉（就是这次的 bug）',
  );
});

test('★★★ PNG 卡打开路径走 openArrivedCard（设封面的分支除外）', () => {
  const png = stripComments(methodBody(APP, 'private async openPngCard(path: string, cardsDir: string)'));
  assert.match(png, /this\.openArrivedCard\(parsed\.card,\s*path\)/, 'PNG 卡必须走判定');
  assert.ok(!/this\.replaceCard\(parsed\.card\)/.test(png), '不许直接 replaceCard');
  /*
   * 纯图片（bare）分支保持"设为当前卡封面"—— 那不是"打开一张卡"，
   * 而是一个针对当前卡的操作。用户说的"仅限打开路径"不包括它。
   */
  assert.match(png, /setPngSource/, '设封面那一路要保留');
});

test('★★★ TXT 打开路径走 openTextCard（它自己判同名）', () => {
  const openCard = stripComments(methodBody(APP, 'private async openCard(): Promise<void> {'));
  /*
   * 不用正则（`/\.txt$/i` 这种写法在正则字面量里会把 `/` 当成结束符）。
   * 判断顺序即可：`.txt` 分支必须出现在 `openTextCard(` 之前，且两者挨得近。
   */
  const txtBranch = openCard.indexOf('this.openTextCard(');
  assert.notEqual(txtBranch, -1, 'TXT 必须交给 openTextCard');
  const txtGuard = openCard.lastIndexOf('.txt', txtBranch);
  assert.notEqual(txtGuard, -1, 'openTextCard 前面应当先判扩展名');
  assert.ok(txtBranch - txtGuard < 160, '判完扩展名就该立刻转到 openTextCard');
});

test('★★★ openTextCard 自己判同名，并把结论交给导入', () => {
  const body = stripComments(
    methodBody(APP, 'private async openTextCard(fileName: string, text: string, dir: string)'),
  );
  assert.match(body, /decideOpenTarget\(/, 'TXT 的判定必须在打开路径内完成（卡名只能从文件名推）');
  assert.match(body, /deriveCardNameFromFile\(fileName\)/, 'TXT 的名字来自文件名');
  assert.match(body, /if \(target\.sessionId !== this\.activeId\) this\.activateSession\(/, '覆盖前要切到那张卡');
  assert.match(body, /createdSession = this\.createSessionFromFile\(fileName\)/, '异名时要先建空会话再导入');
});

test('★★★ openArrivedCard：覆盖前切标签 + 新建时沿用卡里的 cardId', () => {
  const body = stripComments(
    methodBody(APP, 'private async openArrivedCard('),
  );
  assert.match(body, /if \(target\.sessionId !== this\.activeId\) this\.activateSession\(/, '覆盖前要切过去');
  assert.match(
    body,
    /readCardIdFromCard\(named\) \?\? generateCardId\(name\)/,
    '卡里带 cardId 就沿用它（否则服务端历史会分叉）',
  );
});

test('★★★ 覆盖有未保存修改的同名卡必须先问（否则静默丢内容）', () => {
  /*
   * `replaceCard` 会 markSaved 清掉脏标记 —— 用户刚做的编辑就此消失。
   *
   * 旧版"打开即替换"本来就有这个洞，只是用户学会了先保存。现在覆盖只在
   * **同名**时发生，反倒更容易意外触发（以为在开新标签，结果撞上同名）。
   */
  const body = stripComments(methodBody(APP, 'private async openArrivedCard('));
  assert.match(body, /victim\.dirty/, '要先看目标标签是否有未保存修改');
  assert.match(body, /await this\.confirmOverwrite\(/, 'dirty 时必须走确认');
  assert.match(
    body,
    /return \{ mode: 'cancelled'/,
    '用户取消时要能中止（调用方据此不再清 PNG 来源等副作用）',
  );
});

test('★★ 取消覆盖时调用方不许继续做副作用（PNG 来源 / 状态栏）', () => {
  for (const sig of [
    'private async openCard(): Promise<void> {',
    'private async openPngCard(path: string, cardsDir: string)',
  ]) {
    const body = stripComments(methodBody(APP, sig));
    assert.match(
      body,
      /if \(placed\.mode === 'cancelled'\) return;/,
      `${sig} 必须在取消后立刻返回`,
    );
  }
});

test('★★ 导入 TXT 的内部函数不许自己改落点（避免两套判定）', () => {
  const body = stripComments(
    methodBody(APP, 'private async importCardTextFile(\n    fileName: string,'),
  );
  /*
   * `importCardTextFile` 是"把文本写进**当前**会话"的执行者。
   * 它若也去判同名，就会与 `openTextCard` 形成两套判定 —— 迟早分叉。
   */
  assert.ok(!/decideOpenTarget/.test(body), '落点判定只许在 openTextCard 一处');
  assert.match(body, /this\.session\.replaceCard\(this\.arriveCard\(decision\.card\)\)/, '它只负责写进当前卡');
});
