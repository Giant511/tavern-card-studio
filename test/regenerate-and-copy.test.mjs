/**
 * 真机两问（2026-11-09 深夜）。
 *
 * 用户原话：
 *
 * > 连不上ST的时候不能提示无法连接ST，还有就是如果删除了角色底端的回复，
 * > 点击重新生成就会出现回复异常，并且有报连不上ST
 *
 * 两条都要钉：
 *
 * ```text
 *   ① 用户界面不许出现 SillyTavern / ST 字样（文案红线 §23）
 *   ② 删掉底部回复后点"重新生成"，不许把更早的 assistant 弹出去
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { popLastAssistant } from '../shared/dist/chat/swipe.js';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/* ═══════════════════════════════════════════════════════════
   ① 文案：不许出现 SillyTavern / ST
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ Rust 的错误文案不许出现 SillyTavern', () => {
  /*
   * 用户报的那句「连不上 ST」来自 Rust：
   *
   * ```rust
   *   #[error("连不上 SillyTavern：{detail}")]
   *   StUnavailable { detail: String },
   * ```
   *
   * 这个 Display **会被序列化成 message 交给前端**，而前端的规则是
   * `message === '' ? 默认人话 : message` —— 也就是说 Rust 给什么就显示什么，
   * 前端那层"人话"兜底完全被绕过。
   *
   * ## 为什么判据一直没抓到
   *
   * `no-internal-terms.test.mjs` 的 `UI_FILES` 全是 `.ts`，**从不扫 Rust**。
   * 判据扫的是"我以为的 UI 层"，而不是"用户真能看到的每一处文案"。
   */
  const rs = read('client/src-tauri/src/error.rs');

  /*
   * 只看 `#[error(...)]` 属性 —— 那才是会被显示给用户的部分。
   * 注释里提到 SillyTavern 是允许的（解释背景需要它）。
   */
  const literals = [...rs.matchAll(/#\[error\("((?:[^"\\]|\\.)*)"\)\]/g)].map((m) => m[1] ?? '');
  assert.ok(literals.length > 0, '没读到任何 #[error] 文案');

  for (const text of literals) {
    assert.doesNotMatch(
      text,
      /SillyTavern/i,
      `面向用户的错误文案里出现 SillyTavern：${JSON.stringify(text)}`,
    );
    assert.doesNotMatch(
      text,
      /(?<![A-Za-z_])ST(?![A-Za-z_])/,
      `面向用户的错误文案里出现 ST：${JSON.stringify(text)}`,
    );
  }
});

test('★★★ Rust 的 ST 类错误要说人话（不是只把名字换掉）', () => {
  /*
   * 只是把 "SillyTavern" 换成 "聊天服务" 还不够 ——
   * 用户需要知道**下一步做什么**。所以三类错误都要能读出"这是哪一层的问题"。
   */
  const rs = read('client/src-tauri/src/error.rs');

  /* 连不上：要指向"服务没起来"这个可行动的方向 */
  assert.match(rs, /连不上聊天服务/, '要让用户知道是"聊天服务"没起来');

  /* 403：要说会话过期，而不是甩一个 "403" */
  const forbidden = /#\[error\("([^"]*403[^"]*)"\)\]/.exec(rs)?.[1] ?? '';
  assert.doesNotMatch(forbidden, /SillyTavern/i, '403 文案也不许出现 SillyTavern');
});

/* ═══════════════════════════════════════════════════════════
   ② 重新生成：不许弹出"不是最后一条"的 assistant
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 删掉底部回复后，重新生成不许再往前弹别的 assistant', () => {
  /*
   * 用户操作序列：
   *
   * ```text
   *   ① 删掉角色底端的回复（最后一条 assistant 没了）
   *   ② 点"重新生成"
   * ```
   *
   * 此时历史长这样（最后一条是 user）：
   *
   * ```text
   *   [0] user:      你好
   *   [1] assistant: 回复1
   *   [2] user:      再来        ← 没了回复，用户想重新生成这条的答复
   * ```
   *
   * 而 `popLastAssistant` 是"从末尾往前找第一条 assistant"，于是它弹走了
   * **[1] 回复1** —— 剩下：
   *
   * ```text
   *   [0] user: 你好
   *   [2] user: 再来
   * ```
   *
   * 两条连续的 user 消息发给上游 ⇒ 模型行为异常（很多接口不接受连续 user），
   * 界面上就是用户说的"回复异常"。而且历史被改坏了，之后保存也出问题。
   *
   * ## 正确语义
   *
   * 「重新生成」= **重做最后一轮**。它只有在"最后一条确实是 assistant"时
   * 才成立。最后一条是 user 时，用户想要的其实是"为这条 user 生成回复"，
   * 那不叫重新生成。
   */
  const history = [
    { is_user: true, mes: '你好' },
    { is_user: false, mes: '回复1' },
    { is_user: true, mes: '再来' },
  ];

  const popped = popLastAssistant(history);

  assert.equal(
    popped.target,
    null,
    '最后一条是 user 时不该弹出任何 assistant（否则会把更早那条弹走、留下连续 user）',
  );
  assert.deepEqual(popped.history, history, '没得弹时历史必须原样返回');
});

test('★★★★ 最后一条是 assistant 时，正常弹出它自己', () => {
  const history = [
    { is_user: true, mes: '你好' },
    { is_user: false, mes: '回复1' },
    { is_user: true, mes: '再来' },
    { is_user: false, mes: '回复2' },
  ];
  const popped = popLastAssistant(history);
  assert.equal(popped.target?.mes, '回复2', '要弹最后那条 assistant');
  assert.equal(popped.index, 3);
  assert.equal(popped.history.length, 3);
});

test('★★ 空历史 / 全 user 历史都不许抛', () => {
  assert.equal(popLastAssistant([]).target, null);
  const allUser = [{ is_user: true, mes: 'a' }, { is_user: true, mes: 'b' }];
  assert.equal(popLastAssistant(allUser).target, null);
  assert.deepEqual(popLastAssistant(allUser).history, allUser);
});

test('★★★ 删掉底部回复后，界面要给出正确的下一步提示', () => {
  /*
   * 既然不能弹更早那条，就得告诉用户"现在该干什么"。
   * 只说"还没有可以重新生成的内容"不够 —— 他刚删完，会以为坏了。
   */
  const panel = stripComments(read('client/src/chat/chat-panel.ts'));
  const at = panel.indexOf('async regenerate()');
  assert.ok(at > 0, '找不到 regenerate()');
  const body = panel.slice(at, at + 1200);

  /* 找不到 target 时必须有提示 */
  assert.match(body, /popped\.target === null/, '要判 target 为空');
  assert.match(body, /onNotify/, '要告诉用户为什么不行');
});
