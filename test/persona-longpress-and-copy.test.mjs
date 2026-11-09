/**
 * 「改设定名字后点 Tab 弹出删除人设框」的判据（2026-11-07）。
 *
 * ## 用户报的
 *
 * > 设定页里面改完设定名字直接点击 tab 会直接提示是否删除人设
 *
 * ## 真因（真机探针 `.verify/probe-persona-longpress-delete.mjs` 已证实）
 *
 * 删除靠**长按 600ms**。而 `paint()` 会 `list.replaceChildren()` 把每一行
 * 销毁重建。于是：
 *
 * ```text
 *   手指按在行上            touchstart → 启动 600ms 计时器
 *   期间发生一次 paint       原来那一行被销毁
 *     （改名 change → apply → paint 正是这条）
 *   ⇒ 旧节点的 touchend 永远不会来
 *   ⇒ cancel() 不执行
 *   ⇒ 计时器到期 → askDelete() → 弹出「删除「X」？」
 * ```
 *
 * 探针对照结果：
 *
 * ```text
 *   按住 200ms 后松开（不重绘）        → 删除框 0 个 ✓
 *   按住 150ms 时触发一次 paint 再松开 → 删除框 1 个 ✗
 * ```
 *
 * ## 判据要钉什么
 *
 * 不能只钉"有没有 cancelAllLongPress 这个函数" —— 那只是写法。
 * 要钉的是**性质**：
 *
 * ```text
 *   A  重绘前必须清掉在途计时器（主动）
 *   B  计时器到期时必须校验那一行还在不在文档里（被动兜底）
 *   C  清理必须早于 replaceChildren（顺序）
 *   D  从集合里摘掉自己（避免集合无限增长）
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SRC = 'client/src/chat/persona-page.ts';

function read(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function stripComments(source) {
  return source
    /* CRLF 归一：`$` 前有 `\r` 会让行尾锚点永不匹配（本日踩过两次） */
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

const src = stripComments(read(SRC));

test('★★★★★ 重绘前必须清掉在途的长按计时器', () => {
  /*
   * 这是修法的"主动"那一半。没有它，每次 `paint()` 都会留下一个
   * 等到 600ms 才自我了断的孤儿计时器 —— 而它到期时会弹删除框。
   */
  assert.match(src, /const pendingLongPress = new Set<\(\) => void>\(\);/, '要有在途计时器集合');
  assert.match(src, /const cancelAllLongPress = \(\): void => \{/, '要有统一清理函数');

  const paintAt = src.indexOf('const paint = (): void => {');
  assert.ok(paintAt > 0, '找不到 paint');
  const paintBody = src.slice(paintAt, paintAt + 700);
  assert.match(paintBody, /cancelAllLongPress\(\);/, 'paint 开头要清计时器');
});

test('★★★★★ 清理必须**早于** replaceChildren（顺序反了就等于没清）', () => {
  /*
   * `replaceChildren()` 一执行，旧节点就脱离了 —— 之后再去 clearTimeout
   * 虽然也能取消，但那一刻 `touchend` 已经永远不会到，如果计时器恰好在
   * 这中间到期，照样会弹框。所以顺序必须是"先清、再销毁"。
   */
  const paintAt = src.indexOf('const paint = (): void => {');
  const paintBody = src.slice(paintAt, paintAt + 700);
  const cancelAt = paintBody.indexOf('cancelAllLongPress();');
  const replaceAt = paintBody.indexOf('list.replaceChildren();');
  assert.ok(cancelAt > 0, 'paint 里没有清理调用');
  assert.ok(replaceAt > 0, 'paint 里没有 replaceChildren');
  assert.ok(cancelAt < replaceAt, '先清计时器，再销毁节点');
});

test('★★★★★ 计时器到期时要校验那一行还在文档里（被动兜底）', () => {
  /*
   * 只有"主动清理"不够：将来若有人绕过 `paint()` 直接换 DOM，
   * 计时器又会变孤儿。到期时看一眼节点是否还在，是最省事的一道保险。
   */
  assert.match(src, /const stillConnected = \(node: unknown\): boolean/, '要有节点存活校验');

  /* 校验必须发生在 `askDelete` 之前，且不通过就 return */
  const askAt = src.indexOf('askDelete(one);');
  assert.ok(askAt > 0, '找不到 askDelete 调用');
  const before = src.slice(Math.max(0, askAt - 400), askAt);
  assert.match(before, /if \(!stillConnected\(row\)\) return;/, 'askDelete 之前必须校验并提前返回');
});

test('★★★ 拿不到 isConnected 时按"活着"处理（不许把功能整个废掉）', () => {
  /*
   * `ElLike` 没有 `isConnected`，这里靠断言读真实 DOM。若某个环境读不到，
   * 返回 false 会让**所有**长按删除失效 —— 那是比误弹框更严重的回归。
   *
   * ★★ 判据必须钉**那一整行**，不能只查"有没有 `return true`"。
   *   函数里有**两处**返回 true（node 为空 / 类型不是 boolean），
   *   第一版判据用 `assert.match(body, /return true;/)` —— 把第二处
   *   改成 `return false` 之后，第一处照样匹配，**变异溜过去了**。
   *   这是本日第 8 次"判据取错对象"（匹配范围太宽）。
   */
  const at = src.indexOf('const stillConnected');
  assert.ok(at > 0);
  const body = src.slice(at, at + 600);

  assert.match(
    body,
    /if \(typeof probe\.isConnected !== 'boolean'\) return true;/,
    '类型不是 boolean 时那**一行**必须返回 true（不能只查有没有 return true）',
  );
  /* 反证：确认这一行确实存在且不会退化成 false */
  assert.ok(
    !/isConnected !== 'boolean'\) return false;/.test(body),
    '这一行退化成 false 会废掉所有长按删除',
  );
});

test('★★★★ 长按启动时要登记，结束时/到期后要摘掉（集合不许无限增长）', () => {
  const startAt = src.indexOf('const start = (): void => {');
  assert.ok(startAt > 0, '找不到 start');
  const body = src.slice(startAt, startAt + 900);

  assert.match(body, /pendingLongPress\.add\(cancel\);/, '启动要登记');
  assert.match(body, /pendingLongPress\.delete\(cancel\);/, '到期后要摘掉');

  /* touchend 那条路也要摘 */
  const endAt = src.indexOf('const end = (): void => {');
  assert.ok(endAt > 0, '找不到 end（统一收尾）');
  const endBody = src.slice(endAt, endAt + 200);
  assert.match(endBody, /pendingLongPress\.delete\(cancel\);/, '收尾要摘掉');
});

test('★★★★ 「默认人设」文案要短（用户明确要求）', () => {
  /*
   * > 默认人设这个列表里面你就写默认或者默认人设就行
   *
   * 原来那 10 个字「不设人设（用默认名）」是全列表最长的一条，
   * 逼着面板按它算宽度、窄屏上还要换行。
   */
  const shell = stripComments(read('client/src/chat/shell.ts'));
  assert.match(shell, /label: '默认人设'/, '末位选项文案应是「默认人设」');
  assert.ok(
    !shell.includes('不设人设（用默认名）'),
    '旧的长文案不该还在（它会逼面板按 10 个字算宽度）',
  );
});

test('★★★ 文案必须同时说明"这是用默认名"（短，但别丢信息）', () => {
  /*
   * 短不等于含糊。用户看到「默认人设」应该能理解"就是不改名"。
   * 这里只钉它出现在"末位追加"的位置上，防止有人把它挪到别处
   * （比如当成某个真实人设的名字）。
   */
  const shell = stripComments(read('client/src/chat/shell.ts'));
  const at = shell.indexOf("label: '默认人设'");
  const before = shell.slice(Math.max(0, at - 300), at);
  assert.match(before, /value: ''/, '「默认人设」必须对应空值（= 不绑定任何人设）');
});
