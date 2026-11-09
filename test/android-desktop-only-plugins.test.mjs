/**
 * Android 构建守卫：桌面专属的 Tauri 插件必须条件编译掉（v0.1.7 / T15.3）。
 *
 * ## 这条测试是拿一次真实构建失败换来的
 *
 * 2026-10-30 首次构建 Android 时：
 *
 * ```text
 * error[E0425]: cannot find function `init` in crate `tauri_plugin_single_instance`
 *   --> src\lib.rs:17:47
 * error[E0433]: cannot find `Builder` in `tauri_plugin_window_state`
 *   --> src\lib.rs:25:44
 * ```
 *
 * 原因不是版本不对，而是这两个 crate **在 Android 目标下不导出这些 API** ——
 * 「单实例」「窗口位置记忆」在 Android 上没有对应概念。
 *
 * ## 为什么必须在 CI 里守
 *
 * 桌面端 `cargo check` **全绿**，只有真跑 Android 构建才会红。而 Android 构建
 * 一次十几分钟，没人会为了"加个插件"去跑它。所以用静态断言提前拦：
 * 不加 `#[cfg(not(target_os = "android"))]` 就在这条测试上失败，几秒钟出结果。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const LIB_RS = join(ROOT, 'client', 'src-tauri', 'src', 'lib.rs');

test('★ 桌面专属插件必须包在 cfg(not(target_os = "android")) 里', () => {
  const source = readFileSync(LIB_RS, 'utf8');

  /*
   * 已知在 Android 上不可用的插件（实测出来的）。
   *
   * 新增插件时若它也是桌面专属，往这里加一行 —— 这条测试会立刻告诉你
   * 有没有正确包 cfg。**不要等 Android 构建跑十几分钟才发现。**
   */
  const desktopOnly = ['tauri_plugin_single_instance', 'tauri_plugin_window_state'];

  for (const crate of desktopOnly) {
    const index = source.indexOf(`${crate}::`);
    assert.ok(index >= 0, `找不到 ${crate} 的注册（插件被移除了？那这条要同步删）`);

    /*
     * 判据：从注册点往前找最近的 `#[cfg(...)]` 或 `let builder` 之前的上下文，
     * 看看有没有 `target_os = "android"` 的否定形式。
     *
     * 用"往前 800 字符"而不是解析 AST：这个文件结构稳定，
     * 而解析 Rust AST 要引依赖（本项目零 Rust 测试依赖）。
     * 800 字符足够覆盖一个 cfg 属性 + 一段注释。
     */
    const before = source.slice(Math.max(0, index - 800), index);
    const guarded =
      /#\[cfg\(not\(target_os\s*=\s*"android"\)\)\]/.test(before) ||
      /#\[cfg\(not\(target_os="android"\)\)\]/.test(before);

    assert.equal(
      guarded,
      true,
      `${crate} 没有包 cfg(not(target_os = "android")) —— Android 构建会失败（E0425/E0433）`,
    );
  }
});

test('★ 桌面端行为不许被 cfg 改动影响（仍注册这两个插件）', () => {
  const source = readFileSync(LIB_RS, 'utf8');
  // 两个插件都要还在（不能因为"Android 用不了"就删掉桌面能力）
  assert.ok(source.includes('tauri_plugin_single_instance::init'), '桌面端的单实例锁被删掉了');
  assert.ok(source.includes('tauri_plugin_window_state::Builder'), '桌面端的窗口状态记忆被删掉了');
});
