/**
 * 「新密钥写没写进去」必须能自证（2026-11-11）。
 *
 * ## 用户报的
 *
 * > 我知道为什么了，是我的新秘钥从来没有存进去，还是以前的那个旧的有限额的
 * > 秘钥……但是我现在尝试了多次，无法更新秘钥
 *
 * ## 真机取证（直读 ST 的 /api/secrets/read）
 *
 * ```json
 *   "api_key_custom": [
 *     { "id": "2882e35f-…", "value": "*******WPM", "label": "cli-test", "active": true }
 *   ]
 * ```
 *
 * **只有一条，label 是 `cli-test`** —— 那是我以前的探针脚本写的。
 * App 一次都没写进去过。
 *
 * ## 为什么界面一直说"已保存"
 *
 * 外壳的校验只问「`api_key_custom` 这个名字在不在」：
 *
 * ```text
 *   写入失败（或压根没被调用）
 *     → secretPresent() 返回 ['api_key_custom']   ← 旧的那条还在
 *     → 校验通过 → 显示"已保存"
 * ```
 *
 * **旧值把新值失败这件事盖住了。** 这是本项目"假成功"的第 N 次发作。
 *
 * ## 判据：写入前后比对 active 那条的 id
 *
 * key 的**值**读不回来（掩码），但 **id 会变**：
 *
 * ```text
 *   ST.writeSecret → 旧的全部 active=false，push 一条新 uuid active=true
 *   ⇒ id 不变 == 没写进去
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readShellImpl, readShellImplNoComments } from './lib/shell-source.mjs';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('★★★★★ 写入前后要比对 active secret 的 id（唯一可靠的证据）', () => {
  /*
   * 值读不回来，只能靠 id 变化。少了这一步，界面就只能靠"名字在不在"
   * 判断成功 —— 而那正是「改了多次、次次显示已保存、实际一次没进去」的原因。
   */
  const shell = readShellImplNoComments();

  const at = shell.indexOf('writeSecret: (key: string, value: string)');
  assert.ok(at > 0, '找不到 writer.writeSecret 定义');
  const body = shell.slice(at, at + 1800);

  assert.match(body, /secretActiveId\(key\)/, '要读写入前的 active id');
  const beforeCount = [...body.matchAll(/secretActiveId\(key\)/g)].length;
  assert.ok(beforeCount >= 2, `写入前后各读一次，实际 ${String(beforeCount)} 次`);

  assert.match(body, /after === before/, '要比较前后 id 是否相同');
  assert.match(body, /throw new Error/, 'id 没变必须抛错（否则又会显示"已保存"）');
});

test('★★★★★ Rust 侧要提供读 active id 的能力，且与 ST 同口径', () => {
  /*
   * ST 的 `readSecret()` 只认 `active: true` 那一条：
   *
   * ```js
   *   const activeSecret = secretArray.find(s => id ? s.id === id : s.active);
   *   return activeSecret?.value || '';
   * ```
   *
   * 所以判据也必须只认 active，而不是"数组非空就算有"。
   */
  const src = stripComments(read('client/src-tauri/src/st_chat.rs'));

  assert.match(src, /pub async fn st_chat_secret_active_id/, '要有读 active id 的命令');
  const at = src.indexOf('pub async fn st_chat_secret_active_id');
  const body = src.slice(at, at + 1400);

  assert.match(body, /"active"/, '要判 active 字段');
  /*
   * 正则要宽松一点：实际写法是 `.and_then(|v| v.as_bool()) == Some(true)`，
   * `as_bool()` 后面还跟着 `and_then` 的闭括号 —— 我第一版卡死在
   * `as_bool\(\)\s*==` 上，差一个 `)` 就匹配不到。
   */
  assert.match(body, /as_bool\(\)[\s\S]{0,12}Some\(true\)/, '只认 active === true');
  assert.match(body, /"id"/, '要取 id');

  /* 命令必须注册，否则前端 invoke 会报 not found */
  const lib = stripComments(read('client/src-tauri/src/lib.rs'));
  assert.match(lib, /st_chat_secret_active_id/, '命令要注册进 invoke_handler');
});

test('★★★★ label 没给时不许传空串（ST 的默认参数只在 undefined 时生效）', () => {
  /*
   * ST: `writeSecret(key, value, label = 'Unlabeled')`
   * JS 的默认参数**只在 undefined 时**生效。我们原来传 `unwrap_or_default()`
   * = `""`，于是存成 `label: ""`。
   *
   * 功能上不致命，但它让"这条是谁写的"变得不可辨认 —— 排查时我差点
   * 把探针写的 `cli-test` 当成 App 写的。
   */
  const src = stripComments(read('client/src-tauri/src/st_chat.rs'));
  const at = src.indexOf('pub async fn st_chat_secret_write');
  assert.ok(at > 0, '找不到 st_chat_secret_write');
  const body = src.slice(at, at + 1200);

  assert.doesNotMatch(
    body,
    /label\.unwrap_or_default\(\)/,
    '不许把 None 变成空串 —— 要么不传字段，要么传真实 label',
  );
});

test('★★★★ 前端要能拿到 secretActiveId（bridge 有这个方法）', () => {
  /*
   * 能力加了但 bridge 没暴露，等于没有。这条钉的是那一层转发。
   */
  const bridge = stripComments(read('client/src/chat/st-bridge.ts'));
  assert.match(bridge, /secretActiveId\(key: string\): Promise<string \| null>/, 'bridge 要有方法');
  assert.match(bridge, /'st_chat_secret_active_id'/, '要调对命令名');
});
