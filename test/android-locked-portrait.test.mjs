/**
 * 锁定竖屏（2026-11-20）。
 *
 * ## 用户报的现场
 *
 * 「APP 的应用场景一般是竖屏不是横屏，但是在我的手机上不锁定旋转，
 *   手机横过来就会自动变成横屏」。
 *
 * 之前 `AndroidManifest.xml` 里**根本没有** `android:screenOrientation`，
 * 于是走 Android 默认值 `unspecified` —— 跟随系统自动旋转。
 *
 * ## 为什么这条要有判据
 *
 * 这个修改落在 `client/src-tauri/gen/android/` 下，而 **`gen/` 在 .gitignore 里**
 * （由 `tauri android init` 生成）。也就是说：
 *
 * ```text
 *   直接改 manifest        ⇒ 下次 init / 换机器 ⇒ 改动凭空消失
 *   只有写进 fix-android-gen.py 才算真的修好
 * ```
 *
 * 所以判据盯的是**脚本**，不只是当时那个文件。只断言 manifest 的话，
 * 在干净检出的仓库上跑会因为文件不存在而失败；只断言脚本的话，
 * 又看不出"当下到底锁没锁"。两层都测。
 *
 * ## 为什么不是 `nosensor` / `user`
 *
 * ```text
 *   nosensor  忽略方向传感器，但**平板横置时仍是横的** —— 语义不对
 *   user      跟随用户系统的自动旋转开关 —— 用户正是因为系统那一档才转到横屏
 *   portrait  无论传感器、无论系统开关，永远是竖的 ← 这才是"锁定"
 * ```
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * ★ 用 `import.meta.dirname`，不要用 `new URL(import.meta.url).pathname`。
 *   后者对本项目的中文目录（`D:\Claw\代码开发\…`）会做百分号编码，
 *   于是 `D:\Claw\%E4%BB%A3%E7%A0%81…` 这种路径 ENOENT。
 */
const ROOT = join(import.meta.dirname, '..');
const FIXER = readFileSync(join(ROOT, 'scripts/fix-android-gen.py'), 'utf8');
const MANIFEST = join(
  ROOT,
  'client/src-tauri/gen/android/app/src/main/AndroidManifest.xml',
);

/* ═══════════════════════════════════════════════════════════
   ① 脚本层：修改必须可重放（这是唯一真正持久的修复位置）
   ═══════════════════════════════════════════════════════════ */

test('★★★ fix-android-gen.py 里有锁定竖屏的 patch 函数', () => {
  assert.match(
    FIXER,
    /def patch_locked_portrait\(check_only: bool\)/,
    '缺少 patch_locked_portrait —— 直接改 gen/ 会在下次 init 后丢失',
  );
});

test('★★★ 该函数必须真的被 main 调用（写了不调用 = 从未生效）', () => {
  /*
   * 这个项目踩过「函数写了没人调」的坑，所以判据要单独立一条：
   * 定义存在 ≠ 被执行。
   */
  assert.match(
    FIXER,
    /lines \+= patch_locked_portrait\(check_only\)/,
    'patch_locked_portrait 定义了但没在 main 里调用',
  );
});

test('★★★ 写的是 portrait，不是 nosensor / user / unspecified', () => {
  const fnBody = FIXER.slice(
    FIXER.indexOf('def patch_locked_portrait'),
    FIXER.indexOf('def patch_version_code_override'),
  );
  assert.ok(
    fnBody.includes('android:screenOrientation="portrait"'),
    'patch 里必须写入 portrait',
  );
  /* 反向：不许出现"看起来像锁定、实际没锁"的取值 */
  for (const wrong of ['nosensor', 'android:screenOrientation="user"', 'fullSensor']) {
    assert.ok(
      !fnBody.includes(`android:screenOrientation="${wrong}"`),
      `不该用 ${wrong} —— 它不是"锁竖屏"的语义`,
    );
  }
});

test('★★★ 幂等：已有 screenOrientation 时必须跳过，不许叠加', () => {
  /*
   * 这个脚本每次构建都会跑（build-android.sh 第 ⑥ 步）。
   * 不幂等的话，跑 N 次就会叠 N 行 portrait —— 而且 git diff 永远脏。
   */
  const fnBody = FIXER.slice(
    FIXER.indexOf('def patch_locked_portrait'),
    FIXER.indexOf('def patch_version_code_override'),
  );
  assert.match(
    fnBody,
    /if "android:screenOrientation=" in tag:\s*\n\s*return \["\[OK\]/,
    '缺少"已锁则跳过"的判定',
  );
});

test('★★ 只改 MainActivity，不许误伤别的 activity', () => {
  const fnBody = FIXER.slice(
    FIXER.indexOf('def patch_locked_portrait'),
    FIXER.indexOf('def patch_version_code_override'),
  );
  assert.match(
    fnBody,
    /<activity\\b\[\^>\]\*\\\.MainActivity\[\^>\]\*>/,
    '正则必须限定在 MainActivity 那个 <activity> 标签内',
  );
});

test('★★ check 模式要能报出"待修"（供 CI 与助手判断）', () => {
  const fnBody = FIXER.slice(
    FIXER.indexOf('def patch_locked_portrait'),
    FIXER.indexOf('def patch_version_code_override'),
  );
  assert.match(fnBody, /if check_only:\s*\n\s*return \[msg\]/, 'check_only 分支缺失');
  assert.match(fnBody, /msg = "\[修\] 锁定竖屏/, '待修消息必须以 [修] 开头');
});

/* ═══════════════════════════════════════════════════════════
   ② 文件层：当下这个 gen/ 到底锁没锁
   ═══════════════════════════════════════════════════════════ */

test('★★★ 当前 AndroidManifest 里 MainActivity 已锁竖屏', (t) => {
  if (!existsSync(MANIFEST)) {
    /*
     * 干净检出（没跑过 `tauri android init`）时 gen/ 不存在。
     * 这时不该红 —— 上面的脚本判据已经保证"下次 init 后会补上"。
     * 但必须**明确标注跳过**，不能静默通过。
     */
    t.skip('gen/android 不存在（未 init）—— 脚本层判据已覆盖');
    return;
  }

  const xml = readFileSync(MANIFEST, 'utf8');
  const match = /<activity\b[^>]*\.MainActivity[^>]*>/.exec(xml);
  assert.notEqual(match, null, '找不到 MainActivity 的 <activity> 标签');
  assert.match(
    match[0],
    /android:screenOrientation="portrait"/,
    'MainActivity 没有锁定竖屏 —— 手机横过来会变横屏',
  );
  /* 只允许一处，防叠加 */
  assert.equal(
    (xml.match(/android:screenOrientation=/g) ?? []).length,
    1,
    'screenOrientation 出现了多次（幂等失效，叠了）',
  );
});
