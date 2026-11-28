/**
 * 移动端崩溃取证（2026-11-12）。
 *
 * ## 为什么需要这套判据
 *
 * 用户报：
 *
 * > 进入 APP 后过一段时间就会自动闪退，哪怕没有做任何操作也是如此
 *
 * 而我为了查它**连续猜了三次**：
 *
 * ```text
 *   猜内存泄漏  → 采样 263MB 稳定不动（263116 → 263116），错
 *   猜 ANR      → 主线程无阻塞迹象，无从证实
 *   猜前台服务  → specialUse 声明完整，看不出问题
 * ```
 *
 * 根子不在推理能力，在**没有现场**：logcat 要数据线、桌面版 crash-log 没接
 * 移动端、WebView 崩了之后 JS 里的一切都没了。
 *
 * 所以这一批的核心交付是「让下次崩能被看见」，判据也围绕它。
 */

import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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

/* ═══════════════════════════════════════════════════════════
   ① 取证必须真的装上
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 移动端入口要在 boot() 之前装崩溃取证', () => {
  /*
   * 顺序不能反：
   *
   * ```text
   *   ① 启动期崩溃也要抓到（那种最难看，往往零线索）
   *   ② 必须**先读**"上次怎么结束的"，再写本次 boot 记录
   * ```
   *
   * 反了的话，第一次报告的"上次退出"永远是"No record"。
   */
  const src = stripComments(read('client/src/mobile/main.ts'));

  const installAt = src.indexOf('installMobileDiagnostics()');
  assert.ok(installAt > 0, '入口里要真的调用 installMobileDiagnostics');

  const bootAt = src.indexOf('void boot()');
  assert.ok(bootAt > 0, '找不到 boot() 调用');
  assert.ok(installAt < bootAt, '取证安装必须早于 boot()');
});

test('★★★★★ 必须是同步写：崩溃那一刻只有同步来得及', () => {
  /*
   * 第一版落 localStorage（同步，但用户拿不到）。
   * 第二版改由原生 `StLog` 写文件，**仍然同步** —— 这一点不能变：
   *
   * ```text
   *   __ST_ENGINE__.log(...)   同步，调用返回时已在文件里   ✓
   *   Tauri invoke 写文件       异步，队列还没跑就崩了        ✗
   * ```
   *
   * 判据：JS 侧调桥必须是**直接调用**，不许包成 Promise/await 排队。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));

  assert.match(src, /bridge\.log\(level, tag/, '要直接同步调桥');
  assert.doesNotMatch(src, /invoke\(/, '不许用异步的 invoke');
  /* 兜底仍在，但只服务"桥刚注入前的几十毫秒" */
  assert.match(src, /localStorage/, '要保留 localStorage 作为桥就绪前的兜底');
});

test('★★★★★ 日志要落在用户无 root 能取到的目录', () => {
  /*
   * 用户原话：
   *
   * > 最好是放在用户无 root 时可以访问的目录，这样在应用反复崩溃时
   * > 也可以拿到APP日志
   *
   * `/data/data/<包名>/files` 拿不到 ⇒ 必须用 `getExternalFilesDir`。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLog.kt',
  ));

  /*
   * ★ 必须定位到 `init()` 里那一处，不能全局查字符串。
   *
   * 踩过：`exportToDownloads` 里也有一个 `getExternalFilesDir`，
   * 于是"把 init 改成私有目录"这个变异**判据照样绿** —— 假绿。
   * 判据要钉"书写日志的那个 base"，不是"文件里出现过这个词"。
   */
  const initAt = kt.indexOf('fun init(');
  assert.ok(initAt > 0, '找不到 init()');
  const initEnd = kt.indexOf('fun directory()', initAt);
  const initBody = kt.slice(initAt, initEnd < 0 ? initAt + 2000 : initEnd);
  assert.match(
    initBody,
    /val base = context\.getExternalFilesDir\(null\)/,
    'init 必须用外部目录（无 root 可取）',
  );

  /* 外部不可用才退回私有，且必须记下这件事 */
  assert.match(initBody, /外部存储不可用/, '退回私有目录时必须说清楚（否则下次又有人问为什么找不到）');
});

test('★★★★★ 大小上限要在 10–20MB 之间，且真的会轮转', () => {
  /*
   * 用户要求：
   *
   * > 严格限制异常日志的大小在10M-20M
   *
   * 实现取 16MB 总量（8 个文件 × 2MB），落在区间内且留了边界余量。
   *
   * 三条缺一不可：
   * ```text
   *   单文件上限   —— 否则一个巨型堆栈就吃光全部预算
   *   文件数上限   —— 否则轮转只增不减
   *   总量硬上限   —— 最后一道闸，超了从最旧删
   * ```
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLog.kt',
  );

  const limitMatch = /MAX_TOTAL_BYTES\s*=\s*(\d+)L?\s*\*\s*1024\s*\*\s*1024/.exec(kt);
  assert.ok(limitMatch !== null, '总量上限要写成 N * 1024 * 1024 的形式');
  const mb = Number(limitMatch[1]);
  assert.ok(mb >= 10 && mb <= 20, `总量上限要在 10–20MB，实际 ${String(mb)}MB`);

  assert.match(kt, /MAX_FILE_BYTES/, '要有单文件上限');
  assert.match(kt, /MAX_FILES/, '要有文件数上限');
  assert.match(kt, /enforceTotalLimitLocked/, '要有总量兜底检查');
  /* 超限删最旧的 —— 要查的是刚才那次崩溃，不是三天前的启动日志 */
  assert.match(kt, /file\.delete\(\)/, '超限要删文件');
});

test('★★★★★ 四类异常都要覆盖（JS 之外的尤其重要）', () => {
  /*
   * "任何异常都会向日志里面写入"（用户原话）。四类里三类在 JS 里抓不到：
   *
   * ```text
   *   JS error / unhandledrejection   页面内可抓
   *   Java 未捕获异常                   Thread.setDefaultUncaughtExceptionHandler
   *   引擎（node）崩溃                 子进程输出流
   *   渲染进程被系统回收               **完全没有 JS 回调**
   * ```
   *
   * 最后一类正是"不做任何操作也闪退"最可能的成因 —— 所以它必须有原生侧记录。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLog.kt',
  ));
  assert.match(kt, /setDefaultUncaughtExceptionHandler/, '要装 Java 未捕获异常处理器');
  assert.match(kt, /stackTraceToString/, '要记完整堆栈');

  const launcher = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));
  assert.match(launcher, /StLog\.e\("StNode"/, '引擎输出流里的错误要落盘');

  /* 渲染进程：桥里要有入口（MainActivity 拿到 onRenderProcessGone 时调） */
  const bridge = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  ));
  assert.match(bridge, /fun logRendererGone/, '要有渲染进程死亡的记录入口');
});

test('★★★★★ 导出不能让用户过权限弹窗', () => {
  /*
   * minSdk=24。若为导出申请 `WRITE_EXTERNAL_STORAGE`，用户会在首启看到
   * "允许访问照片和文件" —— 为了导日志不值得。
   *
   * 所以必须：
   * ```text
   *   API 29+  → MediaStore（零权限）
   *   API <29  → App 外部目录（旧系统文件管理器本来就能进）
   * ```
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLog.kt',
  );
  assert.match(kt, /MediaStore\.Downloads/, 'API 29+ 用 MediaStore');
  assert.match(kt, /VERSION_CODES\.Q/, '要按版本分支');

  const manifest = read('client/src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  assert.doesNotMatch(
    manifest,
    /WRITE_EXTERNAL_STORAGE/,
    '不许申请写外部存储权限（会让用户看到危险权限弹窗）',
  );
});

test('★★★★★ 日志器自己绝不能抛（否则它是新的崩溃源）', () => {
  /*
   * `diagRecord` 里每一步都可能抛：localStorage 被禁用、配额满、
   * 抛出来的东西没有 message 字段……任何一处抛出都会变成
   * `unhandledrejection`，而它又被这个日志器捕获 —— **自反馈**。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));

  /* 存储读写必须包在 try 里 */
  assert.match(src, /function safeGet[\s\S]{0,200}?try \{/, 'safeGet 要 try');
  assert.match(src, /function safeSet[\s\S]{0,200}?try \{/, 'safeSet 要 try');

  /* 配额满时先清再写 —— 正在崩的这条比十分钟前的有用 */
  assert.match(src, /removeItem\(KEY_LOG\)/, '配额满时要丢掉旧日志保住当前这条');
});

test('★★★★ 要环形限长（否则 localStorage 会被日志吃满）', () => {
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));
  assert.match(src, /MAX_ENTRIES/, '要有条数上限');
  assert.match(src, /slice\(list\.length - MAX_ENTRIES\)/, '超出要丢最旧的');
  assert.match(src, /MAX_MESSAGE/, '单条要截断（巨型堆栈会吃掉整个配额）');
});

/* ═══════════════════════════════════════════════════════════
   ② 异常退出检测（这是回答"闪退还是被杀"的关键）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 要有心跳 + 退出标记，才能区分"崩溃"和"被系统杀"', () => {
  /*
   * 三种结局必须可分：
   *
   * ```text
   *   有 exit 标记、无错误     → 正常退出
   *   无 exit 标记、有心跳     → 进程被杀（心跳停在那一刻）
   *   无 exit 标记、最后是错误 → 真崩了，且知道崩在哪
   * ```
   *
   * 没有心跳就只能知道"没正常退出"，分不出是崩溃还是被回收 ——
   * 而这两种的修法完全不同。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));

  assert.match(src, /KEY_BEAT/, '要有心跳键');
  assert.match(src, /setInterval/, '心跳要定时写');
  assert.match(src, /KEY_CLEAN/, '要有正常退出标记');
  assert.match(src, /pagehide/, '退出标记挂在 pagehide（beforeunload 在 WebView 里常不触发）');
  assert.match(src, /lastExitClean/, '要把结论算出来给界面用');
});

test('★★★★ 心跳要用同步写且不影响主线程', () => {
  /*
   * 心跳每 15 秒一次。如果它做重活（读全量日志、格式化），
   * 就会成为一个新的卡顿源 —— 为了取证反而拖慢 App 是本末倒置。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));

  const at = src.indexOf('const beatTimer');
  assert.ok(at > 0, '找不到心跳');
  const body = src.slice(at, at + 260);
  assert.match(body, /safeSet\(KEY_BEAT, String\(Date\.now\(\)\)\)/, '心跳只写一个时间戳');
});

/* ═══════════════════════════════════════════════════════════
   ③ 引擎状态也要留痕
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 引擎连不上要记，但只在状态变化时记', () => {
  /*
   * 「闪退」时引擎是死是活是最关键的变量，而原来完全看不到。
   *
   * 但 `ensureConnected` 在重试循环里每 2 秒调一次 —— 每次都记的话，
   * 100 条的环形日志几十秒就被它占满，真正有用的崩溃记录反而被挤掉。
   */
  const src = readShellImplNoComments();

  const at = src.indexOf('private async ensureConnected');
  assert.ok(at > 0, '找不到 ensureConnected');
  const body = src.slice(at, at + 2200);

  assert.match(body, /diagNote\('engine'/, '引擎连接状态要记一条');
  assert.match(body, /lastEngineState/, '要按状态变化去重');
  assert.match(body, /!== 'fail'/, '连续失败不重复记');
});

/* ═══════════════════════════════════════════════════════════
   ④ 用户能取出来（否则等于没记）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 「我的」页要有诊断入口，且副标题就说结论', () => {
  /*
   * 这一条防的是本项目最反复的缺陷类型：**实现了但没接线**。
   *
   * 另外副标题必须直接写"上次异常结束" —— 用户不会为了看结论先展开面板，
   * 而这一条恰恰是他能对上"对，就是它崩了"的唯一信息。
   */
  const src = readShellImplNoComments();

  assert.match(src, /this\.renderDiagSection\(\)/, '要真的挂到「我的」页上');
  assert.match(src, /function renderDiagSection/, '要有这个方法');

  /*
   * ★ 取整个方法体，不用固定字符窗口（今天第六次因为窗口误红）。
   *   面板里加了"日志在哪"和"导出"之后，`diag-copy` 被推到了 2600 字符以外。
   */
  const at = src.indexOf('function renderDiagSection(host: SettingsHost)');
  assert.ok(at > 0, '找不到 renderDiagSection');
  const endA = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, endA < 0 ? src.length : endA);

  /*
   * ★★★ 2026-11-13 改判据：`上次**异常结束**` → `上次异常结束`。
   *
   * 原来这条断言里**带着 markdown 星号**，等于把这个缺陷当成了规格 ——
   * 真机上副标题显示成「上次**异常结束** · 共 0 条」，用户看到字面的星号
   * （`textContent` 不渲染 markdown）。用户截图报的就是这个。
   *
   * 判据意图没变（副标题必须直接写"上次异常结束"），只是不再钉星号。
   * 另有一条走查专门守"纯文本槽位里不许有 `**`"（nebula-walkthrough 走查 11）。
   */
  assert.match(body, /上次异常结束/, '副标题要说人话（异常结束）');
  assert.doesNotMatch(body, /上次\*\*异常结束\*\*/, '不许把 markdown 星号拼进副标题');
  assert.match(body, /buildDiagReport\(\)/, '要能导出成文本');
  assert.match(body, /data-role', 'diag-copy'/, '要有复制按钮');
});

test('★★★★ 复制失败不许装作成功', () => {
  /*
   * `navigator.clipboard` 在 WebView 里可能不存在。
   * 那时如果仍然弹"已复制"，用户会去粘贴一个空剪贴板 ——
   * 比明确失败更浪费时间。
   */
  const src = readShellImplNoComments();

  /*
   * ★ 分两处查，不要用"diag-copy 之后 N 字符"的窗口 ——
   *   "长按"那句在 `selectDiagText` 方法体里，离按钮很远。
   *   （今天第五次因为固定窗口误红，见当天记忆。）
   */
  const copyAt = src.indexOf('diag-copy');
  assert.ok(copyAt > 0, '找不到复制按钮');

  /* 按钮的点击处理里要退到选中文本 */
  const copyBlock = src.slice(copyAt, src.indexOf('diag-clear', copyAt));
  assert.match(copyBlock, /selectDiagText/, '复制失败要退到"选中文本"');

  /* 而"长按"这句在兜底方法里 */
  const selAt = src.indexOf('function selectDiagText(host: SettingsHost');
  assert.ok(selAt > 0, '要有 selectDiagText');
  const selBody = src.slice(selAt, selAt + 1600);
  assert.match(selBody, /长按/, '要告诉用户接下来怎么做');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 引擎的 stderr 必须真的落到文件里
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 引擎输出要重定向进文件（实测：不经过我们的 pipe）', () => {
  /*
   * ## 实测发现
   *
   * 第一版靠 `redirectErrorStream(true)` + `drain(proc.inputStream)` 拿引擎输出。
   * 日志落盘后立刻看出它不工作：
   *
   * ```text
   *   logcat:  E nodejs : Error: Invalid package config …（完整堆栈）
   *   StLog:   W StNode: 子进程输出流结束（进程已退出）   ← 只有这一条
   * ```
   *
   * **Android 版 Node 把 stderr 直接写 logcat**（`__android_log_write`），
   * 根本不进 pipe。于是"引擎为什么崩"这条最关键的信息一条都拿不到。
   *
   * ⇒ 用 `sh -c 'exec node … >> engine-<port>.log 2>&1'` 改道。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));

  assert.match(kt, /\/system\/bin\/sh/, '要经 sh 才能做重定向');
  assert.match(kt, /2>&1/, 'stderr 要并进同一个文件');
  assert.match(kt, /engine-\$port\.log|engine-\$/, '引擎日志要按端口分文件');
});

test('★★★★★ 必须用 exec（否则 proc 是 sh，退出码就没有意义）', () => {
  /*
   * 不加 `exec`：`proc` 指向 sh，`exitValue()` 返回的是 sh 的退出码
   * （正常结束永远是 0，找不到命令是 127）—— 而"引擎退出码 1"
   * 恰恰是判断"模块加载失败"的关键。
   *
   * 加了 `exec`：sh 被 node 替换，PID 不变，`proc` 就是 node。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));

  assert.match(kt, /append\("exec "\)/, '命令要以 exec 开头');
});

test('★★★★ 引擎日志要单独限长（不能无限涨）', () => {
  /*
   * 引擎正常运行时也会持续输出。不限长的话，`logs/` 里会有一个
   * 无限增长的文件，把用户要求的 10–20MB 预算根本性地破坏掉。
   *
   * 留尾部而不是头部：启动失败时最有价值的是末尾那段堆栈。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );
  assert.match(kt, /MAX_ENGINE_LOG_BYTES/, '要有引擎日志上限');
  assert.match(kt, /trimEngineLog/, '要有裁剪实现');
  assert.match(kt, /raf\.seek\(file\.length\(\) - keep\)/, '要留尾部（末尾才是崩溃现场）');
});

test('★★★★ 退出码要等进程真的退出再取（别写"未知"）', () => {
  /*
   * 实测：输出流结束时 `exitValue()` 有时还抛 IllegalThreadStateException，
   * 于是日志里写"退出码 未知" —— 而 1 / 137 / 143 的区别决定了
   * "参数错"还是"被系统杀"，那是完全不同的排查方向。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));
  assert.match(kt, /proc\.waitFor\(2,/, '要等一下再取退出码');
  assert.match(kt, /137/, '要给出 137 的含义（SIGKILL）');
  assert.match(kt, /143/, '要给出 143 的含义（SIGTERM）');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 日志钩子：真跑一遍，不靠读源码
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 钩子必须真能抓到 console.error / 未捕获异常 / 退出码', () => {
  /*
   * ## 为什么这条要真跑
   *
   * 钩子是本项目少见的"必须靠运行时行为验证"的东西：
   *
   * ```text
   *   静态读源码   看不出 NODE_OPTIONS 有没有真的加载它
   *   静态读源码   看不出装了 handler 之后退出码会不会变
   * ```
   *
   * 而**退出码变化**这个坑我已经踩过一次：
   * 第一版 handler 里不 `process.exit(1)`，实测退出码从 1 变成 0，
   * 于是 `StLauncher` 那套"1=模块加载失败 / 137=被系统杀"的判读全废。
   *
   * 所以这里起一个真 node 跑一遍，断言三件事：
   * console.error 落盘 / 未捕获异常落盘 / 退出码仍是 1。
   */
  const dir = mkdtempSync(join(tmpdir(), 'tcs-hook-'));
  try {
    const hookSrc = join(ROOT, 'client/src-tauri/gen/android/app/src/main/assets/tcs-log-hook.cjs');
    const hook = join(dir, 'hook.cjs');
    copyFileSync(hookSrc, hook);

    const app = join(dir, 'boom.mjs');
    writeFileSync(
      app,
      'console.error("业务错误：连不上数据库");\n' +
        'setTimeout(() => { throw new Error("运行时炸了"); }, 30);\n',
      'utf8',
    );

    const logPath = join(dir, 'out.log');
    /*
     * ★ 这里用**命令行参数** `--require`，不用 `NODE_OPTIONS`。
     *
     * 不是偷懒，是因为 `mkdtempSync(tmpdir())` 在 Windows 上给出的是
     * `C://Users//...//hook.cjs`，而 `NODE_OPTIONS` 是空格分隔的参数串、
     * 反斜杠会被当转义 ⇒ 路径解析错 ⇒ 钩子没加载 ⇒ 这条判据永远红。
     *
     * 真机用的是 `NODE_OPTIONS`（Android 路径是 `/data/...`，无反斜杠，
     * 已在模拟器上实测加载成功）。这属于**平台差异**，不是接线错误 ——
     * 所以：
     *
     * ```text
     *   这条判据   验证"钩子本体能不能抓到东西"（用直接参数，跨平台稳定）
     *   下一条     静态验证 StLauncher 真的用 NODE_OPTIONS 挂上了它
     * ```
     */
    /*
     * ★★ `stdio: 'ignore'` 是必需的，不是为了省事。
     *
     * 用 `stdio: 'pipe'`（或 `encoding`，它隐含 pipe）时，Windows 上会报
     * **EBUSY**：`spawnSync ... node.exe EBUSY` —— 因为 spawn 的是**当前正在
     * 运行的同一个 node.exe**，管道句柄冲突。
     *
     * 这个坑本项目记过（`execFileSync` 同类问题），但那是以前的事，
     * 这里又踩了一次 ⇒ 不建管道，**只看产物**。
     *
     * 反正判据的核心就是"日志文件里有没有内容"，stdout 本来也用不上。
     */
    const result = spawnSync(process.execPath, ['--require', hook, app], {
      env: { ...process.env, TCS_ENGINE_LOG: logPath },
      stdio: 'ignore',
      timeout: 30_000,
    });

    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';

    assert.ok(
      log !== '',
      `钩子没写日志（spawn 状态 ${String(result.status)}，错误 ${String(result.error?.message ?? '无')}）`,
    );
    assert.match(log, /钩子已装载/, '要先留一条"装载了"的痕迹（否则分不清"没崩"和"钩子没生效"）');
    assert.match(log, /业务错误：连不上数据库/, 'console.error 要落盘');
    assert.match(log, /未捕获异常：Error: 运行时炸了/, '未捕获异常要落盘（带堆栈）');

    /*
     * 退出码必须仍是 1。
     *
     * 这是第一版的实际缺陷：装了 `uncaughtException` handler 后，
     * Node 不再执行"打印并退出 1"的默认流程 ⇒ 退出码变 0
     * ⇒ `StLauncher` 里"退出码 1 = 模块加载失败"的判读失效。
     */
    assert.equal(result.status, 1, '未捕获异常时退出码必须还是 1');
    assert.match(log, /code=1/, 'hook 自己也要记下退出码');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('★★★★ 钩子要同步写（崩溃那一刻来不及异步）', () => {
  /*
   * `fs.appendFileSync` 是刻意的：异步写的缓冲区还没刷出去，进程可能就死了 ——
   * 而那几行正是要看的。
   */
  const src = read('client/src-tauri/gen/android/app/src/main/assets/tcs-log-hook.cjs');
  assert.match(src, /appendFileSync/, '要用同步追加');
  assert.doesNotMatch(src, /createWriteStream/, '不许用流（异步，崩了会丢）');
});

test('★★★★ 钩子要有自己的大小上限（4MB，留尾部）', () => {
  /*
   * 引擎正常运行时 console.error 也会偶发。不设上限的话，
   * `logs/` 里会出现一个无限增长的文件，把用户的 10–20MB 预算撑破。
   */
  const src = read('client/src-tauri/gen/android/app/src/main/assets/tcs-log-hook.cjs');
  assert.match(src, /LIMIT_BYTES/, '要有上限常量');
  assert.match(src, /statSync\(LOG_PATH\)\.size/, '要检查当前大小');
});

test('★★★★★ StLauncher 必须用 NODE_OPTIONS 挂上钩子，且不带引号', () => {
  /*
   * 上一条验证"钩子本体"，这条验证"接线"。
   *
   * ## 为什么不能带引号
   *
   * 第一版写 `--require "<path>"`，结果同一份钩子：
   *
   * ```text
   *   手动跑（无引号）  → 日志正常
   *   测试里（有引号）  → 一条都没有
   * ```
   *
   * `NODE_OPTIONS` 没有可靠的转义规则，引号会被某些平台当成路径的一部分。
   * 所以反过来约束：**路径由我们决定，保证不含空格**。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));

  assert.match(kt, /NODE_OPTIONS/, '要设 NODE_OPTIONS');
  assert.match(kt, /--require \$\{hookFile\.absolutePath\}/, '要挂上钩子（不带引号）');
  assert.doesNotMatch(
    kt,
    /--require \\"\$\{hookFile/,
    '不许在 NODE_OPTIONS 里加引号（会被当成路径的一部分）',
  );
  assert.match(kt, /TCS_ENGINE_LOG/, '要把落点通过环境变量传给钩子');
  assert.match(kt, /assets\.open\("tcs-log-hook\.cjs"\)/, '钩子要从 assets 铺到 st 目录');
});

/* ═══════════════════════════════════════════════════════════
   ⑦ OOM 防护：单次大分配必须被挡住
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 桥接读响应必须有上限（不许 readBytes 全读）', () => {
  /*
   * ## 用户交上来的崩溃日志（荣耀90 REA-AN00 / Android 15）
   *
   * ```text
   *   java.lang.OutOfMemoryError:
   *     Failed to allocate a 211839248 byte allocation
   *     with 186493872 free bytes and 177MB until OOM,
   *     target footprint 402653184, growth limit 402653184
   * ```
   *
   * 换算：**一次要 202MB，只剩 178MB，上限 384MB ⇒ 已用 206MB**。
   *
   * 而 Tauri 在 Android 上把命令返回值交给 WebView 是拼一个 JS 字符串，
   * 那**一整个字符串就是一次 Java 堆分配**；Java 字符是 UTF-16，
   * 所以 100MB 的文本 = 200MB 单次分配。数字正好对上。
   *
   * 因此桥接里**任何"有多少读多少"都是隐患**。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  ));

  assert.match(kt, /MAX_RESPONSE_MB/, '要有响应上限');
  assert.match(kt, /readCapped\(/, '要有限量读取');
  assert.doesNotMatch(kt, /\?\.use \{ it\.readBytes\(\) \}/, '不许 readBytes 全读');
  assert.doesNotMatch(kt, /bufferedReader\(Charsets\.UTF_8\)\?\.use \{ it\.readText\(\) \}/, '不许 readText 全读');
});

test('★★★★★ 超限要报错而不是静默截断', () => {
  /*
   * 截断的 JSON 会在别处以更莫名其妙的方式失败（parse error 出现在
   * 完全无关的地方）。超限必须变成一条**能读懂的错误**。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  ));
  const at = kt.indexOf('val bytes = readCapped(stream)');
  assert.ok(at > 0, '找不到限量读取的调用点');
  const block = kt.slice(at, at + 900);
  assert.match(block, /if \(bytes == null\)/, '要判空');
  assert.match(block, /result\.put\("ok", false\)/, '要标失败');
  assert.match(block, /"error"/, '要给可读错误');
});

test('★★★★★ 每次响应都要记大小（崩溃前能看到最后一条）', () => {
  /*
   * 崩溃日志里只有"一次要 202MB"，**没有任何一条能对上"是哪个请求"** ——
   * 这是这次排查最缺的信息。记下来之后，下次看崩溃前最后那条 size= 即可。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  ));
  assert.match(kt, /StLog\.i\("BRIDGE", "响应 \$\{bytes\.size\} 字节/, '要记响应字节数');
});

test('★★★★★ Rust 侧回传前也要限量（进 Java 堆之前拦住）', () => {
  /*
   * Rust 没有 384MB 的堆上限，挡得住；等字符串进了 Java 就晚了 ——
   * 那时已经是那次 202MB 的单次分配。
   */
  const rs = read('client/src-tauri/src/st_chat.rs');
  assert.match(rs, /MAX_IPC_TEXT_MB/, '要有跨 IPC 回传上限');
  assert.match(rs, /fn capped_text\(/, '要有统一的限量函数');
  assert.match(rs, /capped_text\(text, "这份聊天记录"\)/, '读聊天这条路要套上');
});

test('★★★★ 开机要记堆预算（否则 OOM 只能反算）', () => {
  /*
   * `maxMemory()` 每台机不同（dalvik.vm.heapsize），而"开机剩多少"
   * 决定了一次大分配能不能过。不记这两行，下次还是只能对着
   * "target footprint 402653184" 反算。
   */
  const kt = read('client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt');
  assert.match(kt, /runtime\.maxMemory\(\)/, '要记堆上限');
  assert.match(kt, /StLog\.i\(\s*"MEM"/, '要用 MEM 这个 tag');
});

test('★★★★ 复用引擎必须留痕（否则"没有引擎日志"像缺陷）', () => {
  /*
   * 用户交上来的目录里只有一个 `app-001-.log`，没有 `engine-8000.log`。
   * 直觉会判成"引擎日志丢了"，实际是**复用了上次的实例、本次没起新进程**。
   *
   * "没有日志"本身是信息，但它长得像缺陷。所以要主动写一句。
   */
  const kt = stripComments(read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  ));
  const at = kt.indexOf('复用了上次的实例');
  assert.ok(at > 0, '找不到复用分支');
  const before = kt.slice(Math.max(0, at - 900), at);
  assert.match(before, /StLog\.i\(\s*"ENGINE",\s*"复用上次的引擎实例/, '复用要写进应用日志');
  assert.match(before, /不会产生新的引擎日志/, '要解释为什么没有引擎日志');
});

test('★★★★★ 日志路径必须独立成块（不许内联进说明文字）', () => {
  /*
   * ## 真机现场（2026-11-13，第二轮）
   *
   * 第一版把路径拼进说明文字：
   *
   * ```text
   *   日志文件：/storage/emulated/0/Android/data/com.taverncardstudio...（1 个文件…）
   * ```
   *
   * 然后给 `.nb-note` 加 `overflow-wrap`。红米那台上仍然显示成：
   *
   * ```text
   *   日志文
   *   件：/storage/emulated/0/Android/data/...
   * ```
   *
   * 换 `break-word` 也一样 —— **断行落点取决于 WebView 版本，不可预测**。
   *
   * ## 结论：不在排版引擎上赌，改结构
   *
   * ```text
   *   说明：日志文件（1 个文件，0.0 MB，上限 18 MB）：…
   *   路径：独立的 .nb-diag-path 块（等宽、可选中复制）
   * ```
   *
   * 附带好处：路径能长按复制了。
   */
  const src = readShellImplNoComments();

  assert.match(src, /'nb-diag-path'/, '路径要独立成块');
  assert.match(src, /pathEl\.textContent = status\.dir/, '路径要写进那个块');
  /*
   * ★ **必须真的挂到 DOM 上**（2026-11-13，变异抓到的漏判）。
   *
   * 我第一版只断言"创建了 pathEl 并赋了值"，把
   * `body.append(where, pathEl)` 改回 `body.append(where)` 之后判据**照样绿**
   * —— 元素建了但没挂，用户什么都看不到。这正是本项目最反复的缺陷
   * 类型「实现了但没接线」，判据必须落在**挂载**这一步。
   */
  assert.match(src, /body\.append\(where, pathEl\)/, '路径块必须真的挂上去');
  /*
   * ★ **必须真的挂到 DOM 上**（2026-11-13，变异抓到的漏判）。
   *
   * 我第一版只断言"创建了 pathEl 并赋了值"，把
   * `body.append(where, pathEl)` 改回 `body.append(where)` 之后判据**照样绿**
   * —— 元素建了但没挂，用户什么都看不到。这正是本项目最反复的缺陷
   * 类型「实现了但没接线」，判据必须落在**挂载**这一步。
   */
  assert.match(src, /body\.append\(where, pathEl\)/, '路径块必须真的挂上去');

  /*
   * 反过来说：说明文字里**不许**再出现 `${status.dir}`。
   * 否则两处都渲染一遍，而且内联那份还是会断错。
   */
  const at = src.indexOf('where.textContent =');
  assert.ok(at > 0, '找不到说明文字的赋值');
  /*
   * ★ 取到**语句结束**为止，不能take固定窗口 ——
   *   窗口会把下面那段注释也读进来，而注释里正好解释了 "status.dir"
   *   为什么被移走（今天就因为这个假红过一次，同 §93 一类错）。
   */
  const semi = src.indexOf(';', src.indexOf("'请用下面的「导出到下载目录」。'", at));
  const block = src.slice(at, semi < 0 ? at + 600 : semi);
  assert.doesNotMatch(block, /status\.dir/, '说明文字里不许再拼路径');
});

test('★★★★ 路径块要能逐字符断且可选中复制', () => {
  /*
   * 路径是**机器串**，没有"词"的概念 ⇒ 用 `break-all`（散文才用 break-word）。
   * 同时必须 `user-select: text`：一条 80 字符的路径，用户不该照着手打。
   */
  const css = read('client/src/chat/chat.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = css.indexOf('.nb-diag-path {');
  assert.ok(at > 0, '找不到 .nb-diag-path');
  const end = css.indexOf('\n}', at);
  const block = css.slice(at, end < 0 ? at + 900 : end);

  assert.match(block, /word-break:\s*(break-all|break-word)/, '要能断长路径');
  assert.match(block, /user-select:\s*text/, '要能长按选中（用户要复制路径）');
  assert.match(block, /font-family:[^;]*monospace/, '路径用等宽字体，字符对得齐');
});

/* ═══════════════════════════════════════════════════════════
   诊断日志不许自相矛盾（2026-11-15，真机日志抓到的）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 正常退出标记必须同步落盘（commit，不是 apply）', () => {
  /*
   * ## 现场：两条日志相隔 4 秒互相打脸
   *
   * ```text
   *   20:05:10.701 I BOOT: onDestroy（正常退出）
   *   20:05:14.778 E BOOT: 上次进程没有正常退出（未走到 onDestroy）
   * ```
   *
   * 原因：`onDestroy` 里用 `apply()` 写标记 —— 它**立刻改内存、异步写磁盘**。
   * 而 `onDestroy` 之后进程马上被回收，那次异步写很可能没落地。
   *
   * 这是所有"退出时写标记"的通病：**进程死亡与异步落盘在赛跑，
   * 通常进程先死。**
   *
   * 更要紧的不是这条日志错，而是它会**污染崩溃归因** ——
   * 真被系统杀掉时我们会以为"上次是正常退出的"，从而漏掉线索。
   */
  /*
   * ★ 必须去注释再比较位置（2026-11-15，这条判据自己先踩了）。
   *
   * 我在 `onDestroy` 的注释里贴了 `apply()` / `commit()` 的对比说明，
   * 于是 `indexOf('.commit()')` 命中的是**注释里**那个，位置在日志之前
   * ⇒ 判据假红。这和今天另外三处「注释被当成代码」是同一个形状。
   */
  const kt = stripComments(
    read('client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt'),
  );
  const at = kt.indexOf('override fun onDestroy()');
  assert.ok(at > 0, '找不到 onDestroy');
  /*
   * ★ 用 `super.onDestroy()` 定尾，不写固定长度（2026-11-22）。
   *
   * 原来是 `slice(at, at + 600)`。后来 `onDestroy` 里加了一段销毁取证日志，
   * `commit()` 被推到 600 字符之外 ⇒ 判据假红。
   * **判据不该假设函数有多长** —— 按语义边界切，别按字数切。
   */
  const endAt = kt.indexOf('super.onDestroy()', at);
  const body = kt.slice(at, endAt < 0 ? at + 2500 : endAt + 'super.onDestroy()'.length);

  assert.match(body, /KEY_CLEAN_EXIT, true\)\.commit\(\)/, '必须用 commit()（同步落盘）');
  assert.doesNotMatch(body, /KEY_CLEAN_EXIT, true\)\.apply\(\)/, '不许用 apply()（异步，会丢）');

  /*
   * 顺序也要紧：先落标记，再记日志。
   * 反过来会出现"日志说正常退出、标记没写进去"——正是这次的现场。
   */
  const commitAt = body.indexOf('.commit()');
  const logAt = body.indexOf('"onDestroy（正常退出）"');
  assert.ok(commitAt > 0 && logAt > 0, '两件事都要有');
  assert.ok(commitAt < logAt, '先落标记再记日志（先做副作用，再用日志确认）');
});

test('★★★★★ JS 侧不许断言"非正常结束"（它根本不知道）', () => {
  /*
   * 本标记靠 `pagehide` 落，而 **Android 的 WebView 在 Activity 正常销毁时
   * 不触发 `pagehide`**（它只在页面导航时来）。
   *
   * 所以"没有 pagehide 记录"**推不出**"非正常结束" ——
   * 正常退出同样没有。原措辞把一个"我不知道"说成了"出事了"，
   * 而且和原生那条权威结论直接冲突。
   *
   * 判据钉两件事：
   *
   * ```text
   *   ① 不许出现"非正常结束"这种断言
   *   ② 必须指明"不等于异常退出"+"看 BOOT 行"（告诉读日志的人该信谁）
   * ```
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));

  assert.doesNotMatch(src, /上次会话非正常结束/, '不许断言非正常结束');
  assert.doesNotMatch(src, /没有退出标记/, '不许把"没有标记"当成结论');

  assert.match(src, /不等于/, '要说明这条推不出异常退出');
  assert.match(src, /BOOT/, '要指出权威结论在哪（原生 onDestroy 那条）');
});

test('★★★★ 有 pagehide 记录也不许断言"正常退出"', () => {
  /*
   * `pagehide` 在切后台、切 Tab、导航时都会触发 —— 它只说明
   * "页面被隐藏过"，不说明是退出。原来那句「上次会话正常退出」同样是
   * 过度断言，会在真的被杀时误导归因。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));
  assert.doesNotMatch(src, /上次会话正常退出/, '不许断言正常退出');
  assert.match(src, /页面隐藏记录/, '改成陈述事实');
});

/* ═══════════════════════════════════════════════════════════
   2026-11-22：诊断导出必须能说出自己是哪个构建
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 诊断导出不许读一个没人注入的全局当版本', () => {
  /*
   * ## 现场
   *
   * 用户第三次发来的诊断导出，头部是：
   *
   * ```text
   *   版本：unknown
   * ```
   *
   * 而我要靠这一行判断"装的是哪个构建的包"。`unknown` 等于什么都没说，
   * 只能去数日志里有哪些诊断行反推 —— 而这一轮我一开始就差点反推错：
   * 那份日志缺少新加的诊断行，我先怀疑"修复没生效"，实际是装的是上一版。
   *
   * ## 根因
   *
   * `readVersionTag()` 读 `globalThis.__TCS_VERSION__`，
   * 而**全仓库没有任何地方给它赋值**（`grep __TCS_VERSION__` 只命中这一处）。
   *
   * 项目里本来就有 `settings/app-version.ts` 的 `appVersion()`，
   * 注释明确写着"设置页要显示它、**诊断导出要写它**、测试要断言它"。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));
  /* 不许退回英文 unknown —— 那是我看不出是哪个构建的直接原因 */
  assert.doesNotMatch(src, /'unknown'/, '不许退回 unknown');
  /* 读全局可以，但那个全局必须有写入方（下一条判据钉住） */
  assert.match(src, /'未知'/, '读不到时也要给一个人能看懂的值');
});

test('★★★★ 版本行仍然叫「版本：」并出现在报告里', () => {
  /*
   * 改实现不能把输出格式改了 —— 用户会截图，而我按这个前缀找。
   */
  const src = stripComments(read('client/src/diagnostics/mobile-diag.ts'));
  assert.match(src, /版本：\$\{/, '要保留「版本：」这一行');
});

test('★★★★★ @ts-ignore 那个全局必须有写入方（否则永远是未知）', () => {
  /*
   * ## 这条守的是"读一个没人写的全局"这个具体错误
   *
   * `readVersionTag()` 读 `globalThis.__TCS_VERSION__`。
   * 在此之前**全仓库没有一行给它赋值** —— 用户导出的诊断日志头部
   * 一直是 `版本：unknown`，而那正是我判断"装的是哪个构建"的唯一依据。
   *
   * 判据钉两件事：
   * ```text
   *   ① mobile-diag 里不许读一个不存在的名字（读的必须是被写过的）
   *   ② shell.ts 的构造函数里必须赋值
   * ```
   *
   * ★ 为什么不在 mobile-diag 里直接 import 版本模块：
   *   `settings/app-version.ts` 会 import package.json，靠 Vite 内联；
   *   Node ESM 要求 `with { type: 'json' }`，一 import 就让引入它的
   *   DOM 判据整体崩在 `ERR_IMPORT_ATTRIBUTE_MISSING`。
   */
  const diag = stripComments(read('client/src/diagnostics/mobile-diag.ts'));
  const shell = readShellImplNoComments();

  if (!diag.includes('__TCS_VERSION__')) return; // 将来改成别的方案就不约束了

  assert.match(
    shell,
    /__TCS_VERSION__\s*=\s*appVersion\(\)/,
    'shell.ts 的构造函数里必须给它赋值',
  );
  /* 赋值必须在构造函数里（构造完就可用），不能等到某个页面被打开 */
  const ctorAt = shell.indexOf('constructor(options: ShellOptions)');
  const assignAt = shell.indexOf('__TCS_VERSION__ = appVersion()');
  assert.ok(ctorAt >= 0 && assignAt > ctorAt, '赋值要在构造函数里');
});
