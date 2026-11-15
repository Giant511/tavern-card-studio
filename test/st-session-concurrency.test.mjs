/**
 * ST 会话的并发安全（2026-11-11）。
 *
 * ## 用户报的
 *
 * > 安卓端有一个新问题，这个绝对不是 API 地址或者是秘钥的问题，
 * > 原生使用相同 API 和秘钥可以正常聊
 *
 * 截图里的错误：
 *
 * ```text
 *   /api/backends/chat-completions/generate 返回 403（已重试：true）
 * ```
 *
 * ## 真因：client 与 csrf 分属两个锁
 *
 * ```rust
 *   let csrf = self.csrf_or_connect().await?;        // 读到 session A 的 token
 *   let client = self.client.read().await.clone();   // 这两行之间可能已是 session B
 * ```
 *
 * 拿到"A 的 token + B 的 jar" ⇒ ST 的 csrf-sync 校验失败 ⇒ **403**。
 * 而 403 恢复又调 `connect()`，多线程各建一次会话、互相覆盖，
 * 于是**越重试越坏** —— `已重试：true` 仍然失败。
 *
 * 安卓端请求更密（生成 + token 计数 + 审计并发），桌面上串行得多，
 * 所以这个 bug 只在手机上必现。这也解释了"原生 ST 用同样密钥能聊"——
 * 原生是单线程发一个请求，不存在两个会话互相覆盖。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('★★★★★ client 与 csrf 必须在同一个锁里（否则永远 403）', () => {
  /*
   * 判据不是"有没有 Session 结构"——是**这两个字段不许再各自成锁**。
   *
   * 只要它们还是两个独立的 `RwLock`，"读 token"和"读 client"之间就有窗口，
   * 那个窗口就是 403 的来源。加多少重试都治不好，因为重试本身又会错位。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  assert.doesNotMatch(
    src,
    /client:\s*tokio::sync::RwLock<reqwest::Client>/,
    'client 不许单独成锁 —— 它必须与 csrf 同属一个 Session',
  );
  assert.doesNotMatch(
    src,
    /csrf:\s*tokio::sync::RwLock<Csrf>/,
    'csrf 不许单独成锁 —— 它必须与 client 同属一个 Session（同一代）',
  );
  assert.match(src, /session:\s*tokio::sync::RwLock<Session>/, '要有合并后的 session 锁');
  assert.match(src, /struct Session\s*\{[\s\S]{0,400}?client:\s*reqwest::Client[\s\S]{0,400}?csrf:\s*Csrf/, 'Session 里要同时含 client 与 csrf');
});

test('★★★★★ 一次读出 client 与 csrf，不许分两次读', () => {
  /*
   * `session_or_connect` 是唯一允许"拿两者"的入口，它一次读锁返回元组。
   * 若有人又写回 `self.session.read().await.client` 再单独读 csrf，
   * 那个窗口就又回来了。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  assert.match(
    src,
    /async fn session_or_connect\(&self\) -> Result<\(reqwest::Client, Csrf\), ShellError>/,
    '要有一次返回两者的入口',
  );

  /* send_post 必须用它，而不是自己读两次 */
  /*
   * ★ 必须带左括号定位（2026-11-11）。
   *
   * 写成 `indexOf('async fn send_post')` 时，它先匹配到
   * `async fn send_post_with_recovery` —— **前缀相同**，于是切出来的是
   * 另一个函数体，判据永远报"send_post 没有一次拿两者"。
   *
   * 这类"前缀匹配取错对象"在本项目已经犯过好几次，定位一律带括号。
   */
  const at = src.indexOf('async fn send_post(');
  assert.ok(at > 0, '找不到 send_post 定义');
  const body = src.slice(at, at + 700);
  assert.match(body, /session_or_connect\(\)/, 'send_post 要一次拿两者');
  assert.doesNotMatch(
    body,
    /self\.session\.read\(\)\.await\.client\.clone\(\)[\s\S]{0,200}self\.session\.read\(\)\.await\.csrf/,
    'send_post 不许分两次读锁',
  );
});

test('★★★★★ 403 恢复必须条件重连（并发时只重建一次）', () => {
  /*
   * 十个请求同时 403，若各自 `connect()`：
   *
   * ```text
   *   重建十次 → 每次丢掉前一次的 jar
   *   重试时"自己那代的 token"配"最新那代的 jar" → 仍然 403
   * ```
   *
   * 必须用 epoch 判断：拿锁后发现 epoch 变了 ⇒ 别人已替我连好，直接复用。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  assert.match(src, /async fn recover_forbidden\(&self\)/, '要有 403 恢复入口');
  assert.match(src, /async fn reconnect_if_epoch\(&self, seen: u64\)/, '条件重连要按 epoch 判断');
  assert.match(src, /epoch:\s*u64/, 'Session 要记 epoch');

  /* 403 恢复点不许再直接调 connect() */
  const forbiddenBlocks = [...src.matchAll(/StatusCode::FORBIDDEN\)\s*\{([\s\S]{0,400}?)\}/g)].map((m) => m[1] ?? '');
  for (const block of forbiddenBlocks) {
    assert.doesNotMatch(
      block,
      /self\.connect\(\)\.await/,
      '403 恢复里不许直接 connect() —— 并发时会重建 N 次，403 永不消失',
    );
  }
});

test('★★★★ 条件重连要真的判断 epoch（不是拿了锁就直接重建）', () => {
  /*
   * 只加锁不判断 = 还是重建 N 次，只是排队重建。判据要钉住那条 `!=`。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));
  const at = src.indexOf('async fn reconnect_if_epoch');
  assert.ok(at > 0, '找不到 reconnect_if_epoch');
  const body = src.slice(at, at + 900);

  assert.match(
    body,
    /if\s+self\.session\.read\(\)\.await\.epoch\s*!=\s*seen/,
    '拿锁后必须比较 epoch，相等才重建',
  );
  assert.match(body, /return Ok\(\(\)\)/, '别人已重连时直接返回，不重复重建');
});
