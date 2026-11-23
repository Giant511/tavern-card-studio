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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * 剥掉 XML 注释。
 *
 * ★ 必需（2026-11-22 实测）：这份 manifest 里的大段注释会**引用属性名本身**
 * 作为说明（例如"· `android:alwaysRetainTaskState="true"`"）。
 * 不剥注释的话，`assert.match` 匹配到注释就通过了 —— 而真的属性被删掉时
 * 判据依然绿，等于没守。
 *
 * 这个坑我是靠变异验证发现的：删掉真属性后两条判据仍全过，
 * 一查才发现匹配的是注释。
 */
const stripXmlComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '');

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

test('★★★★ 冷启动与回到前台都要调', () => {
  /*
   * 只调 `onCreate` 会漏掉一种情况：任务在后台期间被改了状态，
   * 而 Activity 没有重建（进程还在）。用户是从后台点回来时才发现的。
   *
   * `onResume` 是"用户正看着这个界面"的时刻，在那里修正最贴近预期。
   *
   * ★ 2026-11-22：入口从 `clearRecentsExclusion` 换成 `ensureRecentsVisible`
   *   （带重试的版本）。判据守的性质没变 —— 两处都要调。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /override fun onResume\(\)/, '要重写 onResume');
  assert.match(kt, /ensureRecentsVisible\("onCreate"\)/, 'onCreate 要调一次');
  assert.match(kt, /ensureRecentsVisible\("onResume"\)/, 'onResume 要再调一次');
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

/* ═══════════════════════════════════════════════════════════
   2026-11-22：0.2.1 那版没修好，补的一组
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 任务数为 0 时必须重试，不许静默放弃', () => {
  /*
   * ## 0.2.1 那版为什么没修好
   *
   * 用户原话：
   *
   * > 安装修复版本后很奇怪，退出后还是不在运行列表里面，但是我打开 vivo 系统的
   * > 隐私空间里面的软件后再上滑它就又有了
   *
   * `getAppTasks()` 查的是"本应用已存在的任务"。`onCreate` 时任务还在建立，
   * 加上 Tauri 初始化慢（要起 WebView），`onResume` 也常常还拿不到。
   * 拿不到就 `return` —— 一次都没设成，而日志里只有一行"任务数为 0"。
   *
   * "打开隐私空间再回来就有了"正好印证：隐私空间是另一个 Android 用户，
   * 来回切换会让本 Activity **销毁重建**，第二次 `onCreate` 时任务已存在。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('private fun ensureRecentsVisible');
  assert.ok(at > 0, '要有带重试的入口');
  const body = kt.slice(at, at + 1800);

  assert.match(body, /postDelayed/, '任务拿不到时要延迟重试');
  assert.match(body, /RECENTS_RETRY_DELAYS/, '重试间隔要有定义');
  /* 必须真的有"重试上限"，否则会无限循环 */
  assert.match(body, /recentsRetryIndex\s*>=\s*RECENTS_RETRY_DELAYS\.size/, '要有重试上限');
});

test('★★★★★ 切后台那一刻也要设：onUserLeaveHint 与 onPause', () => {
  /*
   * 任务是**在 Activity 停止之后**才归档进最近任务的。如果厂商 ROM
   * 在那一步重新套用启动 Intent 的标志，之前设的 false 会被覆盖。
   *
   * `onUserLeaveHint` 是 AOSP 里"用户主动离开（按 Home / 上滑）"的钩子，
   * 比 onPause 更贴近那一刻。
   *
   * `onPause` 覆盖非用户主动离开的路径（被来电/别的应用覆盖）。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /override fun onUserLeaveHint\(\)/, '要重写 onUserLeaveHint');
  assert.match(kt, /override fun onPause\(\)/, '要重写 onPause');
  assert.match(kt, /ensureRecentsVisible\("onUserLeaveHint"\)/, 'onUserLeaveHint 要调');
  assert.match(kt, /clearRecentsExclusion\("onPause"\)/, 'onPause 要调一次即时尝试');
});

test('★★★★ onUserLeaveHint 与 onPause 必须调 super', () => {
  /*
   * 不调 super 会有副作用：Activity / Tauri 内部依赖它做状态收尾。
   * 只借时机设置属性，不该改变生命周期语义。
   */
  const kt = strip(read(ACTIVITY));
  for (const name of ['onUserLeaveHint', 'onPause', 'onResume']) {
    const at = kt.indexOf(`override fun ${name}()`);
    assert.ok(at > 0, `找不到 ${name}`);
    const body = kt.slice(at, at + 220);
    assert.match(body, /super\.\w+\(\)/, `${name} 必须调 super`);
  }
});

test('★★★★ 销毁时要撤掉挂起的重试（否则泄漏 Activity）', () => {
  /*
   * 不撤的话 `Handler` 会持有已销毁的实例，Runnable 还会去调
   * `getSystemService` —— 泄漏一个 Activity，日志里也会出现
   * 「销毁之后还在设置任务」的怪记录。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('override fun onDestroy()');
  assert.ok(at > 0, '要有 onDestroy');
  const body = kt.slice(at, at + 2000);
  assert.match(body, /cancelRecentsRetry\(\)/, 'onDestroy 要撤掉重试');
  assert.match(body, /super\.onDestroy\(\)/, '要调 super');
});

test('★★★ 每个生命周期方法只许定义一次（overload 会编译不过）', () => {
  /*
   * 加钩子时最容易犯的错：文件里原本已经有 `onDestroy`，又加一个。
   * Kotlin 报 "conflicting overloads"，但那要等构建到一半才发现。
   */
  const kt = strip(read(ACTIVITY));
  for (const name of ['onCreate', 'onResume', 'onPause', 'onDestroy', 'onUserLeaveHint']) {
    const count = [...kt.matchAll(new RegExp(`override fun ${name}\\(`, 'g'))].length;
    assert.equal(count, 1, `${name} 定义了 ${String(count)} 次`);
  }
});

test('★★★ 设置成功要把任务数写进日志（判"到底设没设上"的唯一凭据）', () => {
  /*
   * 0.2.1 那版只有"任务数为 0"这一种日志，于是真机上分不清
   * "设成功了但 ROM 不认" 和 "根本没设"。现在两种都有明确记录。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('private fun clearRecentsExclusion');
  const body = kt.slice(at, at + 1200);
  assert.match(body, /StLog\.i\(\s*"RECENTS"/, '成功要记 info');
  assert.match(body, /StLog\.w\(\s*"RECENTS"/, '失败要记 warn');
  assert.match(body, /tasks\.size/, '要记设了几个任务');
});

/* ═══════════════════════════════════════════════════════════
   2026-11-22 第二轮：运行时设置成功了，但任务被重置
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ manifest 必须声明 alwaysRetainTaskState（主修）', () => {
  /*
   * ## 真机日志给出的结论
   *
   * 用户装上 0.2.1 的修复后仍不显示，而日志里是：
   *
   * ```text
   *   10:14:50.892 RECENTS: onUserLeaveHint：已确保 1 个任务不排除在最近任务之外
   *   10:14:50.966 LIFE: 退到后台
   *   10:14:52.973 BOOT: onDestroy（正常退出）
   * ```
   *
   * `setExcludeFromRecents(false)` 设成功了，但两秒后 **Activity 被销毁**。
   * 任务里没有活着的 Activity ⇒ 系统把任务从最近任务移除 ⇒ 卡片消失。
   *
   * 所以病灶不是"标志没设上"，而是"任务被系统重置"。
   * `android:alwaysRetainTaskState` 默认 **false**（允许系统重置任务栈），
   * 必须显式设成 true。
   */
  /* ★ 必须剥注释：注释里写了示例文字，会让这条判据永远通过 */
  const xml = stripXmlComments(read(MANIFEST));
  assert.match(
    xml,
    /android:alwaysRetainTaskState\s*=\s*"true"/,
    '不声明 true 时系统可以重置任务栈，任务一空就被移出最近任务',
  );
});

test('★★★★★ manifest 必须声明 autoRemoveFromRecents="false"', () => {
  /*
   * 默认也是 false，但厂商 ROM 常改默认值。显式写死，
   * 让"最后一个 Activity 结束后任务仍留在列表里"成为明确契约。
   */
  /* 同上：剥注释 */
  const xml = stripXmlComments(read(MANIFEST));
  assert.match(
    xml,
    /android:autoRemoveFromRecents\s*=\s*"false"/,
    '要显式声明，别依赖厂商默认值',
  );
});

test('★★★★ 这两个属性必须落在 MainActivity 上，不是 application 上', () => {
  /*
   * 它们只对**任务根 Activity** 有意义。写到 `<application>` 上是无效的，
   * 而 XML 不报错 —— 又是一处静默失效。
   */
  const xml = stripXmlComments(read(MANIFEST));
  const at = xml.indexOf('android:alwaysRetainTaskState');
  assert.ok(at > 0, '找不到该属性');
  /* 从属性位置往回找最近的 `<activity` 与 `<application`，取更近的那个 */
  const before = xml.slice(0, at);
  const lastActivity = before.lastIndexOf('<activity');
  const lastApplication = before.lastIndexOf('<application');
  assert.ok(lastActivity > lastApplication, '属性在 <application> 上，无效');
});

test('★★★★ onDestroy 要记三个诊断数字', () => {
  /*
   * `isFinishing` 区分 "有人调了 finish()" 与 "系统销毁"；
   * 剩余任务数说明任务是否已被移除；Intent 带排除位说明启动入口脏。
   *
   * 这三个数字是下一轮归因的唯一依据 —— 上一轮只有"任务数为 0"一种日志，
   * 分不清"设上了但 ROM 不认"和"根本没设"。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('override fun onDestroy()');
  const body = kt.slice(at, at + 1600);
  assert.match(body, /isFinishing/, '要记 isFinishing');
  assert.match(body, /appTasks\?\.size/, '要记剩余任务数');
  assert.match(body, /FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS/, '要记 Intent 是否带排除位');
});

test('★★★★★ fix-android-gen.py 必须能补回这两个属性', () => {
  /*
   * ## 为什么需要这条
   *
   * `AndroidManifest.xml` 是 **Tauri 生成的**，`tauri android init` 会重建它。
   * 只在 manifest 里加属性、不在生成脚本里守着的话，重跑一次 init 就丢，
   * 而现象会重新出现且不报任何错 —— 最难发现的那种。
   *
   * 判据钉三件事：函数存在、真的会写这两个属性、main() 里调用了它。
   */
  const py = read('scripts/fix-android-gen.py');
  assert.match(py, /def patch_retain_task_state\(/, '要有这个函数');
  assert.match(py, /alwaysRetainTaskState="true"/, '函数里要写这项');
  assert.match(py, /autoRemoveFromRecents="false"/, '函数里要写这项');
  /* 光有函数没调用等于没有 */
  assert.match(
    py,
    /lines \+= patch_retain_task_state\(check_only\)/,
    'main() 里要调用它',
  );
});

test('★★★★★ manifest 必须纳入版本控制', () => {
  /*
   * 判据落在**「它在 git index 里」**，不是「`.gitignore` 有没有放行规则」。
   *
   * 两者的差别是实质性的：
   *
   * ```text
   *   写了放行规则、但没 git add   ⇒ 旧判据绿，文件其实不在库里（假阴性）
   *   文件已跟踪、规则被删掉       ⇒ 旧判据红，但功能完全正常（假红）
   * ```
   *
   * 原因：已跟踪的文件不受 ignore 规则约束。放行规则只在**首次入库**那一次
   * 起作用，之后就是冗余的。目的只有一个 —— clone 下来能拿到这份 manifest。
   *
   * 不进库的后果：别人构建出的包没有竖屏锁定与任务保留配置，
   * 症状是「切到后台就找不到 App」，不报任何错。
   */
  if (!existsSync(join(ROOT, '.git'))) {
    /* 源码 zip 解压出来的目录没有 .git，无从判断；这类环境本来也不该跑这条 */
    return;
  }
  assert.equal(
    isTracked(MANIFEST),
    true,
    `${MANIFEST} 不在 git index 里 —— 别人 clone 后拿不到它，构建出的包会缺竖屏与任务保留配置`,
  );
});

/**
 * 这个路径是否在 git index 里（= 会被 clone 下来）。
 *
 * `--error-unmatch` 在未跟踪时返回非零，所以只看退出码就够。
 *
 * ★ `stdio` 必须是 `'ignore'`：本机 `stdio: 'pipe'` 起子进程会 EBUSY，
 *   而这个函数本来也不需要输出。
 */
function isTracked(rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel.split('\\').join('/')], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

test('★★★★ 还要显式声明 excludeFromRecents="false"', () => {
  /*
   * 默认就是 false，但厂商 ROM 会改默认值。显式写死比依赖默认可靠 ——
   * 与 `autoRemoveFromRecents` 同一条理由。
   */
  const xml = stripXmlComments(read(MANIFEST));
  assert.match(xml, /android:excludeFromRecents\s*=\s*"false"/, '要显式声明');
});

test('★★★★ 三项都在同一个 activity 标签上', () => {
  /*
   * 分散写会有一部分落在 `<application>` 或别的 activity 上 ——
   * 那些位置对这三个属性无效，而 XML 不报错。
   */
  const xml = stripXmlComments(read(MANIFEST));
  const m = /<activity\b[^>]*\.MainActivity[^>]*>/.exec(xml);
  assert.ok(m !== null, '找不到 MainActivity 标签');
  const tag = m[0];
  assert.match(tag, /android:alwaysRetainTaskState="true"/, '缺 alwaysRetainTaskState');
  assert.match(tag, /android:autoRemoveFromRecents="false"/, '缺 autoRemoveFromRecents');
  assert.match(tag, /android:excludeFromRecents="false"/, '缺 excludeFromRecents');
});

/* ═══════════════════════════════════════════════════════════
   2026-11-22 第三轮：日志必须自证版本，且能区分两种"消失"
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 启动日志必须记版本号（每份日志自证构建来源）', () => {
  /*
   * ## 为什么这条现在是硬要求
   *
   * 同一个问题报了三轮、发了三份日志，我三次都在猜「这是哪个构建的包」——
   * 靠"日志里有没有某条诊断行"反推。第三份日志我一开始就差点判错：
   * 它里面没有 `RECENTS: onDestroy` 那行，但那是因为装的是上一版，
   * 不是修复没生效。
   *
   * 三份日志里有两份无从判断版本，这个成本远高于记一行日志。
   * 现在每份日志开头都有 `版本 x.y.z（versionCode N）`。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('override fun onCreate(');
  assert.ok(at > 0, '找不到 onCreate');
  const body = kt.slice(at, at + 2000);
  assert.match(body, /BuildConfig\.VERSION_NAME/, '要记版本名');
  assert.match(body, /BuildConfig\.VERSION_CODE/, '要记版本号');
});

test('★★★★★ 版本日志必须在 StLog.init 之后', () => {
  /*
   * 顺序错了会静默丢：`StLog` 未初始化时调 `i()` 什么都不写，
   * 而 `onCreate` 的第一行就是 init —— 很容易把日志放在它前面。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('override fun onCreate(');
  const body = kt.slice(at, at + 1600);
  const initAt = body.indexOf('StLog.init(this)');
  const verAt = body.indexOf('BuildConfig.VERSION_NAME');
  assert.ok(initAt >= 0 && verAt >= 0, '两样都要有');
  assert.ok(initAt < verAt, '版本日志在 init 之前会写不进去');
});

test('★★★★★ 服务要记 onTaskRemoved（区分两种"消失"）', () => {
  /*
   * ## 这份判据守的是一次真实的误判风险
   *
   * 用户说「切到后台看不到」，但「打开系统隐私空间里的应用再回来就有了」。
   * 两者对应完全不同的原因：
   *
   * ```text
   *   A. AMS 真的把任务移除了     ⇒ 卡片不存在；切用户也不可能恢复
   *   B. 任务还在，只是启动器的    ⇒ 切用户会触发启动器重载，于是又显示
   *      最近任务界面没显示它
   * ```
   *
   * 用户的描述明显更像 B。但 B 在应用侧无法直接观测 —— 除非听
   * `onTaskRemoved`：
   *
   * ```text
   *   有这个回调的记录 ⇒ A
   *   没有             ⇒ B
   * ```
   *
   * 这是唯一能把两者分开的证据。
   */
  const svc = strip(read(SERVICE));
  assert.match(svc, /override fun onTaskRemoved\(/, '要重写 onTaskRemoved');
  const at = svc.indexOf('override fun onTaskRemoved(');
  const body = svc.slice(at, at + 800);
  assert.match(body, /StLog\.w\(\s*"RECENTS"/, '要记一条 RECENTS 日志');
  assert.match(body, /super\.onTaskRemoved\(/, '要调 super');
});

test('★★★★ onDestroy 诊断要含 isChangingConfigurations', () => {
  /*
   * 它区分"配置变更导致的临时重建"（正常）与"真被销毁"。
   * manifest 的 `configChanges` 已挡住大部分，若这里出现 true
   * 说明还有没挡住的项 —— 那本身就是线索。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('override fun onDestroy()');
  const body = kt.slice(at, at + 2000);
  assert.match(body, /isChangingConfigurations/, '要记配置变更标志');
});

/* ═══════════════════════════════════════════════════════════
   2026-11-22 第四轮：日志排除了前几种可能，改为推动界面刷新
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 要打印任务根 Intent 的排除位（唯一还能查的东西）', () => {
  /*
   * ## 第四份日志把这几种可能都排掉了
   *
   * ```text
   *   12:17:15.396 退到后台
   *   12:20:03.931 进入前台        ← 中间 2 分 48 秒
   * ```
   *
   * ```text
   *   · 没有 onDestroy      ⇒ Activity 一直活着
   *   · 没有 onTaskRemoved  ⇒ 任务没被 AMS 移除
   *   · 每次都有 "已确保 1 个任务不排除"  ⇒ getAppTasks 有任务、调用没抛
   *   · manifest 三项已在包里（aapt2 直接读的 APK）
   * ```
   *
   * 剩下唯一没验过的就是：`setExcludeFromRecents(false)` 到底有没有把
   * **任务根 Intent** 上的标志清掉。最近任务界面读的是
   * `RecentTaskInfo.baseIntent.flags`，而不是 Activity 自己收到的 intent。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /private fun describeTasks\(/, '要有这个诊断方法');
  const at = kt.indexOf('private fun describeTasks(');
  const body = kt.slice(at, at + 1200);
  assert.match(body, /baseIntent/, '要读任务根 Intent');
  assert.match(body, /FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS/, '要看排除位');
  assert.match(body, /numActivities/, '要记任务里有几个界面');
});

test('★★★★★ 要主动刷新任务卡片（标志已是 false 时 set 是空操作）', () => {
  /*
   * `setExcludeFromRecents(false)` 在值本来就是 false 时**不产生任何变更通知**，
   * 启动器因此一直不知道需要更新卡片。
   *
   * `setTaskDescription` 是唯一会影响"最近任务里卡片长什么样"的公开 API，
   * 系统在它被调用后会重建该卡片。
   */
  const kt = strip(read(ACTIVITY));
  assert.match(kt, /private fun refreshTaskCard\(/, '要有刷新方法');
  const at = kt.indexOf('private fun refreshTaskCard(');
  const body = kt.slice(at, at + 1200);
  assert.match(body, /setTaskDescription/, '要用它');
  assert.match(body, /ActivityManager\.TaskDescription/, '要造描述对象');
  /* 失败不许影响主流程 */
  assert.match(body, /catch\s*\(/, '要兜住异常');
});

test('★★★★ 刷新要在切后台前那三个时机都调', () => {
  /*
   * `onResume`（回到前台，卡片可能被别的东西改过）、
   * `onUserLeaveHint`（用户要离开，赶在归档前）、
   * `onPause`（兜住被覆盖的非主动离开）。
   */
  const kt = strip(read(ACTIVITY));
  for (const stage of ['onResume', 'onUserLeaveHint', 'onPause']) {
    assert.match(
      kt,
      new RegExp(`refreshTaskCard\\("${stage}"\\)`),
      `${stage} 要调一次`,
    );
  }
});

test('★★★★ manifest 要声明 roundIcon（圆形图标启动器缺图标可能整张卡片不画）', () => {
  /*
   * 用户明确说：上滑打开任务列表**什么都没有，连卡片都没有**，不是空白卡片。
   *
   * 到这一步应用侧能验的都验完了（第五份日志）：
   *
   * ```text
   *   id=10188 界面数=1 根Intent带排除位=false     ← 任务在、有界面、没排除
   *   onResume：已刷新任务卡片（label=…）          ← TaskDescription 成功
   *   manifest 三项 + aapt2 直读 APK               ← 都在包里
   * ```
   *
   * 剩下的都是"系统怎么画这张卡"。圆形图标启动器（vivo 用圆形遮罩）
   * 在缺 `roundIcon` 时会回落到 launcher 做遮罩，个别 ROM 上失败就整张跳过。
   */
  const xml = stripXmlComments(read(MANIFEST));
  assert.match(xml, /android:roundIcon="@mipmap\//, '要声明 roundIcon');
  assert.match(xml, /android:icon="@mipmap\//, '也要有普通 icon');
});

test('★★★★ roundIcon 指向的资源必须真的存在', () => {
  /*
   * 引用一个不存在的资源是**构建期**错误，但这里多一道保险：
   * 有人删资源忘了改 manifest 时能立刻发现。
   */
  const xml = stripXmlComments(read(MANIFEST));
  const m = /android:roundIcon="@mipmap\/([a-z0-9_]+)"/.exec(xml);
  assert.ok(m !== null, '找不到 roundIcon');
  const name = m[1];
  /* 至少密度桶里有一份 */
  const found = existsSync(
    join(ROOT, 'client/src-tauri/gen/android/app/src/main/res/mipmap-xxxhdpi', `${name}.png`),
  );
  assert.ok(found, `mipmap-xxxhdpi/${name}.png 不存在`);
});

test('★★★★ 前台服务启动要记通知权限状态', () => {
  /*
   * 第五份日志里**完全没有前台服务的记录**，而常驻通知 + 前台服务是
   * 这个 App 最特殊的地方，vivo 的后台管理恰好以激进著称。
   *
   * Android 13+ 没给通知权限时，前台服务的通知不显示 —— 服务仍活着
   * 但用户看不见，部分 ROM 会把这种状态的应用按"异常"处理。
   */
  const svc = strip(read(SERVICE));
  const at = svc.indexOf('private fun startForegroundCompat');
  assert.ok(at > 0, '找不到 startForegroundCompat');
  const body = svc.slice(at, at + 1800);
  assert.match(body, /StLog\.i\(\s*"SERVICE"/, '要记一条 SERVICE 日志');
  assert.match(body, /POST_NOTIFICATIONS/, '要看通知权限');
});

/* ═══════════════════════════════════════════════════════════
   2026-11-22 第五轮：卡片有了但一片空白
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 窗口背景必须是应用底色（否则缩略图露白）', () => {
  /*
   * ## 现场（用户截图）
   *
   * 重启手机后卡片终于出现了，但内容是一片白色：紫色顶栏 + 下面整块白。
   *
   * ## 真因
   *
   * `Theme.tcs_shell` 继承 Material3 DayNight，**没设 windowBackground**，
   * 亮色模式下窗口背景是白色。内容几乎全在 WebView 里，而 WebView 在
   * 最近任务缩略图里不一定被合成进去 —— 合成不上时露出的就是窗口背景。
   *
   * 所以看到的不是"没内容"，是"WebView 那层没进缩略图，露出白窗口"。
   */
  for (const rel of ['values/themes.xml', 'values-night/themes.xml']) {
    const p = `client/src-tauri/gen/android/app/src/main/res/${rel}`;
    const xml = stripXmlComments(read(p));
    assert.match(xml, /android:windowBackground/, `${rel} 要设 windowBackground`);
    assert.match(xml, /@color\/tcs_window_bg/, `${rel} 要引用 tcs_window_bg`);
  }
});

test('★★★★★ 窗口底色必须真的定义在 colors.xml 里', () => {
  /*
   * themes 引用 `@color/tcs_window_bg`，资源不存在是**构建期**错误。
   * 更要紧的是色值要与应用底色一致，否则卡片是一块无关的深色。
   */
  const p = 'client/src-tauri/gen/android/app/src/main/res/values/colors.xml';
  const xml = stripXmlComments(read(p));
  assert.match(xml, /name="tcs_window_bg"/, '要定义这个颜色');
  assert.match(xml, /#0c0a14/i, '色值要是应用底色 #0c0a14');
});

test('★★★★★ 不许再关掉最近任务的截图预览（那是上一轮的错判）', () => {
  /*
   * 上一轮我加了 `setRecentsScreenshotEnabled(false)`，理由是"WebView 截图
   * 可能失败会露白"。用户反馈证明这个判断错在哪：
   *
   * ```text
   *   卡片出现了，但一块纯色，完全没有 App 内容
   * ```
   *
   * 关掉截图之后系统**本来就不截内容** —— 那不是修好缩略图，是放弃缩略图。
   */
  const kt = strip(read(ACTIVITY));
  assert.doesNotMatch(kt, /setRecentsScreenshotEnabled\s*\(\s*false\s*\)/, '不许关截图');
});

test('★★★★ TaskDescription 要带应用底色（缩略图失败时的兜底）', () => {
  /*
   * 万一 WebView 仍然合成不上，卡片至少要是深色的、看起来像这个 App，
   * 而不是一块白板。
   */
  const kt = strip(read(ACTIVITY));
  const at = kt.indexOf('private fun refreshTaskCard(');
  const body = kt.slice(at, at + 1500);
  assert.match(body, /TaskDescription\([^)]*0xFF0C0A14/i, '要传底色');
});

test('★★★★★ 要请求通知权限（清单声明不等于已授权）', () => {
  /*
   * 真机日志第一次加 SERVICE 诊断就把这件事说清了：
   *
   * ```text
   *   SERVICE: 前台服务启动：通知权限=false SDK=36
   * ```
   *
   * 清单里 `POST_NOTIFICATIONS` 早就声明，但 Android 13+ 必须运行时请求。
   * 而**全仓库没有任何地方请求过它**。
   *
   * 后果不止"看不到通知"：部分 ROM 会把"有前台服务但通知不可见"的应用
   * 当成异常状态处理 —— 正是本次排查一直怀疑的那一类。
   */
  const kt = strip(read(ACTIVITY));
  const fnAt = kt.indexOf('private fun requestNotificationPermissionIfNeeded');
  const fnBody = kt.slice(fnAt, fnAt + 900);
  assert.match(fnBody, /POST_NOTIFICATIONS/, '要提到这个权限');
  assert.match(fnBody, /requestPermissions\(/, '要真的发起请求');
  assert.match(kt, /override fun onRequestPermissionsResult\(/, '要处理结果');
  /* 13 以下不需要运行时授权，要有版本判断 */
  const at = kt.indexOf('private fun requestNotificationPermissionIfNeeded');
  const body = kt.slice(at, at + 900);
  assert.match(body, /TIRAMISU|SDK_INT/, '要有版本判断');
});

test('★★★ Android 资源 XML 的注释里不许出现连续两个减号', () => {
  /*
   * ## 我踩的这个坑
   *
   * 我在 themes.xml 的注释里写了 CSS 变量名 `--nb-abyss`。
   * XML 规范禁止注释内含 `--`，aapt2 直接报
   * `SAXParseException: The string "--" is not permitted in comments`
   * —— **构建到资源打包那一步才失败**，前面几步全是绿的。
   *
   * 这条判据扫所有我们改过的资源文件，防止再犯。
   */
  const files = [
    'client/src-tauri/gen/android/app/src/main/res/values/themes.xml',
    'client/src-tauri/gen/android/app/src/main/res/values-night/themes.xml',
    'client/src-tauri/gen/android/app/src/main/res/values/colors.xml',
  ];
  for (const rel of files) {
    const raw = read(rel);
    for (const m of raw.matchAll(/<!--[\s\S]*?-->/g)) {
      const inner = m[0].slice(4, -3);
      assert.ok(
        !inner.includes('--'),
        `${rel} 的注释里有连续两个减号，aapt2 会报 SAXParseException`,
      );
    }
  }
});
