/**
 * Cargo 依赖的**目标平台归属**判据（2026-11-18）。
 *
 * ## 守什么
 *
 * `client/src-tauri/Cargo.toml` 里有两个区段：
 *
 * ```text
 * [dependencies]                                   ← 所有目标（含 Android）
 * [target.'cfg(not(target_os = "android"))'.dependencies]  ← 仅桌面
 * ```
 *
 * 放错区段的后果不是"构建慢"，而是**安卓构建整体失败**：
 *
 * ```text
 *   error[E0433]: cannot find module or crate `tokio` in this scope
 *   --> src\proxy.rs:440
 *   共 39 个 error，横跨 proxy / st_api / st_chat / commands
 * ```
 *
 * ## 这个 bug 真实发生过（而且很难发现）
 *
 * `170b3f4`（2026-11-17 自签证书修复）**插入**了 target 区段标题，
 * 而 `bytes` / `futures-util` / `tokio` / `log` 四行恰好写在标题上方 ——
 * 于是被静默归入"仅桌面"。
 *
 * 为什么半个月没被发现：
 * - `git blame` 会把这四行归给它们**原本的提交**（内容没变），看不出移动
 * - `cargo check` 在 Windows 上完全正常（桌面目标不受影响）
 * - v0.1.10 及更早的 tag 不含那个提交 ⇒ 历史版本一直能打
 * - **只有主线 0.2.0 的安卓构建是坏的**，直到重建 APK 才暴露
 *
 * 所以这条判据盯的是"这四行在不在通用区"，而不是"能不能编译"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const CARGO = readFileSync(join(ROOT, 'client/src-tauri/Cargo.toml'), 'utf8');

/**
 * 把 Cargo.toml 按区段切开。
 *
 * 只认 `[区段名]` 行；`[[bin]]` 这种双括号不影响这里的判断，直接跳过。
 */
function sections(text) {
  const out = new Map();
  let current = '(top)';
  const buf = [];
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]$/.exec(line.trim());
    if (m !== null) {
      out.set(current, buf.join('\n'));
      current = m[1];
      buf.length = 0;
      continue;
    }
    buf.push(line);
  }
  out.set(current, buf.join('\n'));
  return out;
}

const SEC = sections(CARGO);
const GENERAL = SEC.get('dependencies') ?? '';
const NON_ANDROID = SEC.get('target.\'cfg(not(target_os = "android"))\'.dependencies') ?? '';

/** 取某个依赖在给定区段里的声明行（没有则 null） */
function depLine(section, name) {
  const re = new RegExp('^' + name.replace(/[-.]/g, '\\$&') + '\\s*=', 'm');
  const m = re.exec(section);
  if (m === null) return null;
  const start = m.index;
  const end = section.indexOf('\n', start);
  return section.slice(start, end < 0 ? section.length : end).trim();
}

test('★★★ 三个区段都存在（改名/挪位时这条会红）', () => {
  assert.ok(SEC.has('dependencies'), '缺少 [dependencies]');
  assert.ok(
    SEC.has('target.\'cfg(not(target_os = "android"))\'.dependencies'),
    '缺少非安卓 target 区段 —— 若是有意删除，请同时删掉这条判据并说明原因',
  );
});

test('★★★ tokio / bytes / futures-util / log 必须在通用区（安卓也要用）', () => {
  /*
   * 这四个是 proxy / st_api / st_chat / commands 的硬依赖，而**安卓端也需要
   * 这些模块**（安卓上 ST 跑在本机，聊天读写要走 Rust 侧的 HTTP）。
   * 它们不含任何平台专属特性，因此必须放在通用区。
   */
  for (const name of ['tokio', 'bytes', 'futures-util', 'log']) {
    assert.notEqual(
      depLine(GENERAL, name),
      null,
      name + ' 不在 [dependencies] 里 —— 安卓构建会报 `cannot find crate`',
    );
  }
});

test('★★★ native-tls 只许出现在非安卓区段', () => {
  /*
   * `native-tls` 在 Android 上会去找 OpenSSL，而交叉编译环境没有 ⇒ APK 打不出来。
   * 这正是把它分流的原因，别为了"省事"合并回通用区。
   */
  const generalReqwest = depLine(GENERAL, 'reqwest');
  assert.notEqual(generalReqwest, null, 'reqwest 应在通用区');
  assert.ok(
    !/native-tls/.test(generalReqwest),
    'reqwest 的通用声明里出现了 native-tls —— 安卓会因找不到 OpenSSL 而失败',
  );

  const desktopReqwest = depLine(NON_ANDROID, 'reqwest');
  assert.notEqual(desktopReqwest, null, 'reqwest 应在非安卓区段里再声明一次（带 native-tls）');
  assert.ok(/native-tls/.test(desktopReqwest), '非安卓区段的 reqwest 应带 native-tls');
});

test('★★ 非安卓区段里不许出现跨平台依赖（防止再次"吞并"）', () => {
  /*
   * 这次事故的形态就是"插了一个区段标题，把上方的行吞进来"。
   * 逐项检查：除了 reqwest，那个区段里不该有别的跨平台依赖。
   */
  const allowed = new Set(['reqwest']);
  const declared = [...NON_ANDROID.matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]);
  const strays = declared.filter((n) => !allowed.has(n));
  assert.deepEqual(
    strays,
    [],
    '这些依赖被放进"仅非安卓"区段，但它们是跨平台的：' +
      strays.join(', ') +
      '（安卓构建会找不到它们）',
  );
});

test('★★ 每个非安卓区段的依赖都是在通用区里已声明过的（只加 feature）', () => {
  /*
   * 正确用法：通用区声明一次（基础 features），非安卓区段再声明一次（加 native-tls）。
   * 若某依赖只出现在非安卓区段，那是"独占"，要显式确认它真的不需要进安卓。
   */
  const declared = [...NON_ANDROID.matchAll(/^([a-zA-Z0-9_-]+)\s*=/gm)].map((m) => m[1]);
  for (const name of declared) {
    assert.notEqual(
      depLine(GENERAL, name),
      null,
      name + ' 只在非安卓区段出现（通用区没有）—— 确认安卓是否真的不需要它',
    );
  }
});
