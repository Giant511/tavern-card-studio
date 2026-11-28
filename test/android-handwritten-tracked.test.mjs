/**
 * 安卓端"我们写的文件"必须在版本控制里（2026-11-24）。
 *
 * ## 为什么单独立一条
 *
 * `client/src-tauri/gen/android` 整体是 `tauri android init` 的生成目录，
 * 但里面有 **15 个文件是我们手写的**（不是模板产物）：
 *
 * ```text
 *   AndroidManifest.xml             竖屏锁定 + 任务保留三属性
 *   res/values/themes.xml           窗口底色（最近任务缩略图不露白）
 *   res/values/colors.xml           底色定义
 *   res/values-night/themes.xml     夜间版
 *   java/.../MainActivity.kt        1056 行
 *   java/.../stengine/*.kt          5 个引擎桥（StLauncher 966 行等）
 *   buildSrc/.../BuildTask.kt       构建参数
 *   buildSrc/.../RustPlugin.kt
 *   docs/android-user-guide.md      用户手册
 * ```
 *
 * `tauri android init --force` 会覆盖它们。**入库是唯一的恢复手段** ——
 * 不入库的话一次 --force 就永久丢失（报告 P1-6 指的就是这个）。
 *
 * ## 判据
 *
 * 用 `git ls-files` 查每个文件是否被跟踪：
 *
 * ```text
 *   少一个  ⇒ 有人"清理仓库"时把它删了，下次 --force 就找不回来
 *   全在    ⇒ 可以从任意提交恢复
 * ```
 *
 * ★ 只在有 `.git` 的目录里跑（源码 zip 解压出来的没有 git，无从判断）。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

/** 必须入库的手写文件（相对仓库根，正斜杠） */
const MUST_TRACK = [
  'client/src-tauri/gen/android/app/src/main/AndroidManifest.xml',
  'client/src-tauri/gen/android/app/src/main/res/values/themes.xml',
  'client/src-tauri/gen/android/app/src/main/res/values/colors.xml',
  'client/src-tauri/gen/android/app/src/main/res/values-night/themes.xml',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLog.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StService.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StUnpacker.kt',
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/TestCardCleaner.kt',
  'client/src-tauri/gen/android/buildSrc/src/main/java/com/taverncardstudio/client/kotlin/BuildTask.kt',
  'client/src-tauri/gen/android/buildSrc/src/main/java/com/taverncardstudio/client/kotlin/RustPlugin.kt',
  'client/src-tauri/gen/android/docs/android-user-guide.md',
];

function isTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('★★★★★ 手写 Kotlin 与资源文件必须在 git index 里', (t) => {
  if (!existsSync(join(ROOT, '.git'))) {
    t.skip('没有 .git（源码 zip 解压的目录），无从判断是否入库');
    return;
  }
  const missing = MUST_TRACK.filter((rel) => !isTracked(rel));
  assert.deepEqual(
    missing,
    [],
    `这些文件没入库 —— 一次 \`tauri android init --force\` 就会永久丢失：\n${missing.join('\n')}`,
  );
});

test('★★★★ 被保护的 Kotlin 文件确实有实质内容（不是空壳占位）', (t) => {
  /*
   * 光看"在 index 里"不够：如果有人把它替换成空文件，判据照样绿，
   * 而 --force 之后恢复出来的是空壳。这里按体量做一个粗网。
   *
   * 阈值**分级**（不能一刀切）：
   *
   * ```text
   *   BuildTask.kt / RustPlugin.kt   构建脚本胶水，几十行是正常的 → 30 行
   *   其余（MainActivity / StLauncher / St*）  几百上千行 → 200 行
   * ```
   *
   * 第一次写这条时统一取 200，结果 BuildTask.kt（75 行）被判成"掏空" ——
   * 判据自己的假设错了，不是文件有问题。
   *
   * ★ 读工作区文件而不是 `git show HEAD:` —— 本机 `execFileSync` 带 pipe
   *   会 EBUSY（memory §4 记过），而 readFileSync 没有这个问题。
   */
  if (!existsSync(join(ROOT, '.git'))) {
    t.skip('没有 .git');
    return;
  }
  const BUILD_GLUE = ['BuildTask.kt', 'RustPlugin.kt'];
  for (const rel of MUST_TRACK) {
    if (!rel.endsWith('.kt')) continue;
    const name = rel.split('/').pop();
    const minLines = BUILD_GLUE.includes(name) ? 30 : 200;
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const lines = text.split('\n').length;
    assert.ok(
      lines > minLines,
      `${rel} 只有 ${String(lines)} 行（预期 > ${String(minLines)}）—— 像是被替换成占位文件了`,
    );
  }
});
