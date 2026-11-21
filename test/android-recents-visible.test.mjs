/**
 * App 必须留在「最近任务」里（2026-11-21）。
 *
 * ## 用户报的现象
 *
 * ```text
 *   切到后台 → 上滑打开任务列表 → 看不到本 App 的卡片
 *   ⇒ 只能回桌面点图标才能重新进来
 * ```
 *
 * ## 成因
 *
 * 任务被打上了 `FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS`。这个标志我们没显式设过，
 * 但它会跟着**启动入口**进来：
 *
 * ```text
 *   ① 通知里的启动 Intent
 *      原实现用 `packageManager.getLaunchIntentForPackage(packageName)`，
 *      拿到的是**桌面启动器**那条 Intent。部分 ROM（同类机型 originOS6 /
 *      Android 16 有公开案例）会给它带上 EXCLUDE_FROM_RECENTS ——
 *      桌面把这种启动当作"跳板"，而不是"要留在后台的窗口"。
 *   ② 桌面图标本身
 *      少数 ROM 的启动跳板会把该标志一并带进主任务。
 * ```
 *
 * 标志一旦落到任务上就**一直有效**，之后从哪进都不显示 —— 直到任务重建。
 *
 * ## 两道防线（缺一不可）
 *
 * ```text
 *   ① 源头：通知的启动 Intent 显式构造（目标类写死、flag 自己指定、不带排除位）
 *   ② 兜底：Activity 里 setExcludeFromRecents(false)
 *      我们控制不了桌面传什么，但任务级开关能在自己进程里把结果改回来
 * ```
 *
 * ## 为什么判据要看源码文本
 *
 * gen/android 不入库（`tauri android init` 会重建），所以这两处改动**没法**
 * 在 Node 里跑起来验。判据只能钉"代码里有这个动作、且没有那两处危险写法"。
 * 真正的行为验证要真机（切后台 → 任务列表）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const MANIFEST = 'client/src-tauri/gen/android/app/src/main/AndroidManifest.xml';
const ACTIVITY = 'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt';
const SERVICE = 'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StService.kt';

test('★★★★★ manifest 不许把 MainActivity 排除出最近任务', () => {
  /*
   * 显式写 `excludeFromRecents="true"` 会让任务永远不出现在列表里。
   * 现在没写（默认 false），这条钉住"别哪天被模板或手滑加上"。
   */
  const xml = read(MANIFEST);
  assert.doesNotMatch(
    xml,
    /android:excludeFromRecents\s*=\s*"true"/,
    'MainActivity 被排除出最近任务 —— 切后台后就再也回不来了',
  );
});

test('★★★★★ Activity 必须主动把任务放回最近任务', () => {
  /*
   * 兜底防线。即使标志是桌面启动器带进来的，`setExcludeFromRecents(false)`
   * 也能在自己进程里改回来 —— 这是唯一能覆盖"别人传了坏 flag"的手段。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /setExcludeFromRecents\(\s*false\s*\)/, '要显式关掉排除');
  assert.match(kt, /appTasks/, '要通过 ActivityManager 拿本应用的任务');
});

test('★★★★ 两处都要调：冷启动与回到前台', () => {
  /*
   * 只调 `onCreate` 会漏掉一种情况：任务在后台期间被改了状态，
   * 而 Activity 没有重建（进程还在）。用户是从后台点回来时才发现的。
   *
   * `onResume` 是"用户正看着这个界面"的时刻，在那里修正最贴近预期。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /override fun onResume\(\)/, '要重写 onResume');
  assert.match(kt, /clearRecentsExclusion\("onCreate"\)/, 'onCreate 要调一次');
  assert.match(kt, /clearRecentsExclusion\("onResume"\)/, 'onResume 要再调一次');
});

test('★★★★ 通知的启动 Intent 不许用 getLaunchIntentForPackage', () => {
  /*
   * 两个理由：
   *
   * ```text
   *   ① 可能返回 null ⇒ PendingIntent.getActivity(..., null, ...) 抛 NPE，
   *      而这是在构建通知里 —— 抛了通知就不出来
   *   ② 拿到的是桌面启动器那条 Intent，部分 ROM 会带 EXCLUDE_FROM_RECENTS
   * ```
   */
  const svc = strip(read(SERVICE));
  assert.doesNotMatch(svc, /getLaunchIntentForPackage/, '改成显式构造');
});

test('★★★★ 通知启动 Intent 要显式指向 MainActivity 且不带排除位', () => {
  const svc = strip(read(SERVICE));
  const at = svc.indexOf('val openIntent = PendingIntent.getActivity');
  assert.ok(at > 0, '要能找到构建通知跳转的那段');
  const body = svc.slice(at, at + 1200);

  assert.match(body, /MainActivity::class\.java/, '目标类要写死');
  assert.match(body, /FLAG_ACTIVITY_NEW_TASK/, '从服务启动 Activity 必须带 NEW_TASK');
  assert.match(body, /FLAG_ACTIVITY_RESET_TASK_IF_NEEDED/, '要回到任务根');
  assert.doesNotMatch(body, /EXCLUDE_FROM_RECENTS/, '绝不许带排除位');
});

test('★★★ 失败时只记日志，不许让 App 起不来', () => {
  /*
   * 个别 ROM 上 `getAppTasks()` 会抛 SecurityException。
   * 任务列表是体验问题，启动是可用性问题 —— 前者绝不能拖死后者。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('private fun clearRecentsExclusion');
  assert.ok(at > 0, '方法要存在');
  const body = kt.slice(at, at + 900);
  assert.match(body, /catch\s*\(/, '要兜住异常');
  assert.doesNotMatch(body, /throw /, '不许往外抛');
});
