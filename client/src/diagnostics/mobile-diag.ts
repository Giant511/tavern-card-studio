/**
 * 移动端的崩溃取证（2026-11-12）。
 *
 * ## 为什么要有这个文件
 *
 * 用户反馈：
 *
 * > 进入 APP 后过一段时间就会自动闪退，哪怕没有做任何操作也是如此
 *
 * 而**我们手上一条日志都没有**：
 *
 * ```text
 *   · logcat 只能靠数据线抓，用户做不到
 *   · 桌面版的 crash-log 落的是 Tauri 文件，移动端没接
 *   · WebView 崩了之后 JS 里的一切都没了
 * ```
 *
 * 于是只能靠猜 —— 我先猜内存泄漏（实测 263MB 稳定不动）、再猜 ANR、
 * 再猜前台服务被杀，全是猜。**猜不出来的问题，先解决"能不能看见"。**
 *
 * ## 2026-11-12 第二次改造：改由**原生**写文件
 *
 * 第一版落在 `localStorage`。它有两个致命问题：
 *
 * ```text
 *   ① 用户在手机上根本拿不到 —— 那只是 WebView 内部的一串字符串
 *   ② 配额只有 5MB，且渲染进程一死就再也读不出来
 * ```
 *
 * 用户的要求很明确：
 *
 * > 最好是放在用户无 root 时可以访问的目录，这样在应用反复崩溃时也可以拿到
 *
 * 所以真正的落盘交给原生 `StLog`（Kotlin）：
 *
 * ```text
 *   /sdcard/Android/data/<包名>/files/logs/app-00N-.log   ← 数据线可直取
 *   Download/tcs-log-<时间>.txt                          ← 导出（文件管理器可开）
 * ```
 *
 * 本文件因此退化成**薄转发层**：
 *
 * ```text
 *   桥可用      → __ST_ENGINE__.log(...)     原生同步写，崩了也在
 *   桥不可用    → localStorage 兜底          只有极早期（桥注入前）会走到这里
 * ```
 *
 * 保留兜底不是偷懒：`installMobileDiagnostics()` 在页面脚本刚开始执行时
 * 就跑，那一刻 `__ST_ENGINE__` 可能还没注入完。这几十毫秒里的错误
 * 恰恰是最难查的启动期错误，不能丢。
 *
 * ## 三件事
 *
 * ```text
 *   ① 全局异常     error / unhandledrejection → 记一条
 *   ② 心跳         每 15 秒写一次时间戳（同步、极便宜）
 *   ③ 异常退出检测 下次启动时对比"退出标记"
 * ```
 *
 * ③ 是重点：它能回答"到底是被系统杀了，还是 JS 崩了"——
 *
 * ```text
 *   有 exit 标记、无错误记录  → 正常退出（比如用户主动划掉）
 *   无 exit 标记、有心跳      → 进程被系统杀了（心跳停在被杀那一刻）
 *   无 exit 标记、最后一条是错误 → 真的崩了，而且知道崩在哪
 * ```
 */

const KEY_LOG = 'tcs.diag.log';
const KEY_SESSION = 'tcs.diag.session';
const KEY_CLEAN = 'tcs.diag.clean';
const KEY_BEAT = 'tcs.diag.beat';

/** 最多留多少条（每条几百字节，100 条约几十 KB，远低于配额） */
const MAX_ENTRIES = 100;
/** 单条消息/堆栈的截断长度（防止一条巨型堆栈吃掉整个配额） */
const MAX_MESSAGE = 800;
const MAX_STACK = 1600;
/** 心跳间隔 */
const BEAT_MS = 15_000;

export type DiagKind =
  | 'boot'
  | 'exit'
  | 'error'
  | 'unhandledrejection'
  | 'note'
  | 'engine';

export interface DiagEntry {
  /** 毫秒时间戳 */
  at: number;
  kind: DiagKind;
  message: string;
  stack?: string;
}

/** localStorage 可能被禁用（隐私模式）或满了 —— 任何失败都不能反过来抛错 */
function safeGet(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch {
    /*
     * 配额满了：清掉日志再来一次。
     *
     * 宁可丢掉旧日志也要保证**当前这条**能落下 —— 正在崩的这一刻
     * 比十分钟前的那条有用得多。
     */
    try {
      globalThis.localStorage?.removeItem(KEY_LOG);
      globalThis.localStorage?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }
}

function clip(text: string, limit: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= limit ? one : `${one.slice(0, limit)}…`;
}

/** 读全部日志（读不到/坏数据一律当空，调用方不用处理异常） */
export function readDiagEntries(): DiagEntry[] {
  const raw = safeGet(KEY_LOG);
  if (raw === null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((one): one is DiagEntry => {
      if (one === null || typeof one !== 'object') return false;
      const rec = one as Record<string, unknown>;
      return typeof rec['at'] === 'number' && typeof rec['message'] === 'string';
    });
  } catch {
    return [];
  }
}

/**
 * 记一条。
 *
 * ## 为什么用"读-改-写"而不是追加
 *
 * localStorage 没有 append。而这里量很小（一次崩溃一条），
 * 读改写完全够用；换成 IndexedDB 反而在崩溃那一刻不可靠（异步）。
 */
export function diagRecord(kind: DiagKind, thrown: unknown, extraStack?: string): void {
  try {
    const { message, stack } = describeThrown(thrown);
    const flat = clip(message, MAX_MESSAGE);
    const trace = clip(stack === '' ? (extraStack ?? '') : stack, MAX_STACK);

    /*
     * ① 优先走原生（2026-11-12）。
     *
     * 原生写是**同步**的：调用返回时内容已经在文件里。这一点是整件事的
     * 关键 —— 下一行代码就可能崩溃，异步排队等于没写。
     */
    if (writeNative(kind, flat, trace)) return;

    /*
     * ② 桥还没就绪（页面刚开始执行的那几十毫秒）→ localStorage 兜底。
     *
     * 这段窗口很短，但里面的错误恰恰是最难查的启动期错误。
     * 下一次能写原生时，`flushLocalToNative()` 会把它们补上去。
     */
    const list = readDiagEntries();
    list.push({
      at: Date.now(),
      kind,
      message: flat,
      ...(trace === '' ? {} : { stack: trace }),
    });
    const kept = list.length > MAX_ENTRIES ? list.slice(list.length - MAX_ENTRIES) : list;
    safeSet(KEY_LOG, JSON.stringify(kept));
  } catch {
    /* 日志器自己绝不能抛 —— 否则它本身会变成新的错误源 */
  }
}

/** 原生桥里我们用到的那几个方法（类型收敛在这里，调用处不用重复断言） */
interface NativeLogBridge {
  log?: (level: string, tag: string, message: string) => void;
  logStatus?: () => string;
  logRead?: (maxBytes: number) => string;
  logExport?: () => string;
  logClear?: () => void;
}

function nativeBridge(): NativeLogBridge | null {
  const holder = globalThis as {
    __ST_ENGINE__?: NativeLogBridge;
  };
  const bridge = holder.__ST_ENGINE__;
  if (bridge === undefined || typeof bridge.log !== 'function') return null;
  return bridge;
}

/** 原生桥可用吗（界面要据此决定"日志在哪"怎么说） */
export function hasNativeLog(): boolean {
  return nativeBridge() !== null;
}

/**
 * 写一条到原生日志。返回是否成功。
 *
 * `kind` 映射到 Android 的 level：错误用 E，其余 I —— 保留 `tag` 前缀
 * 让读日志的人能一眼看出这条是 JS 侧来的。
 */
function writeNative(kind: DiagKind, message: string, stack: string): boolean {
  const bridge = nativeBridge();
  if (bridge?.log === undefined) return false;
  try {
    const level = kind === 'error' || kind === 'unhandledrejection' ? 'E' : 'I';
    const tag = `JS/${kind.toUpperCase()}`;
    bridge.log(level, tag, stack === '' ? message : `${message}\n${stack}`);
    return true;
  } catch {
    /* 桥调用本身可能抛（接口被移除、线程问题）—— 退回 localStorage */
    return false;
  }
}

/**
 * 把 localStorage 里残留的早期记录补进原生日志。
 *
 * 只在"桥刚就绪"那一刻调一次。补完就清空，避免下次重复写。
 */
export function flushLocalToNative(): void {
  if (nativeBridge() === null) return;
  const list = readDiagEntries();
  if (list.length === 0) return;
  for (const one of list) {
    writeNative(one.kind, `[补录 ${new Date(one.at).toLocaleTimeString('zh-CN')}] ${one.message}`, one.stack ?? '');
  }
  safeSet(KEY_LOG, '[]');
}

/** 记一条纯文本（不带异常对象），用于埋点式取证 */
export function diagNote(kind: DiagKind, message: string): void {
  diagRecord(kind, message);
}

/**
 * 把任意抛出物转成 (message, stack)。
 *
 * 与 `crash-log.ts` 里那个同源，但这里**不能 import 它** ——
 * 那个模块带着桌面版的会话摘要类型，移动端不需要那份依赖。
 * 重复十几行换取"零依赖"是划算的：这个文件要在最早的时机执行。
 */
export function describeThrown(value: unknown): { message: string; stack: string } {
  if (value === null) return { message: 'null', stack: '' };
  if (value === undefined) return { message: 'undefined', stack: '' };
  if (typeof value === 'string') return { message: value, stack: '' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { message: String(value), stack: '' };
  }
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack ?? '' };
  }
  const rec = value as Record<string, unknown>;
  const message =
    typeof rec['message'] === 'string'
      ? rec['message']
      : (() => {
          try {
            return JSON.stringify(value) ?? String(value);
          } catch {
            return String(value);
          }
        })();
  const stack = typeof rec['stack'] === 'string' ? rec['stack'] : '';
  return { message, stack };
}

export interface BootReport {
  /** 上一次会话有没有"正常退出"标记 */
  lastExitClean: boolean;
  /** 上一次心跳距今多久（毫秒）；没有心跳时 null */
  sinceLastBeatMs: number | null;
  /** 上次会话开始时间；第一次安装为 null */
  lastSessionAt: number | null;
}

/**
 * 开机自检：判断上次是怎么结束的。
 *
 * 必须在写本次 boot 记录**之前**调用（先读旧状态）。
 */
function inspectLastSession(): BootReport {
  const lastId = safeGet(KEY_SESSION);
  const clean = safeGet(KEY_CLEAN);
  const beatRaw = safeGet(KEY_BEAT);
  const beat = beatRaw === null ? Number.NaN : Number(beatRaw);
  const sessionRaw = safeGet(KEY_SESSION);
  /* session 里存 "id|at"，避免两个键 */
  const at = sessionRaw === null ? Number.NaN : Number(sessionRaw.split('|')[1] ?? Number.NaN);

  return {
    lastExitClean: lastId !== null && clean === lastId,
    sinceLastBeatMs: Number.isFinite(beat) ? Date.now() - beat : null,
    lastSessionAt: Number.isFinite(at) ? at : null,
  };
}

export interface MobileDiagHandle {
  /** 上一次是怎么退出的（用于在界面上说人话） */
  readonly boot: BootReport;
  /** 手动记一条 */
  note: (kind: DiagKind, message: string) => void;
  /** 卸载（测试用；正常运行时不需要） */
  dispose: () => void;
}

let installed = false;

/**
 * 安装全局取证。**要在入口最早处调用**，越早越能抓到启动期崩溃。
 *
 * 返回的对象里 `boot` 可以直接显示给用户（"上次是异常退出"）。
 */
export function installMobileDiagnostics(): MobileDiagHandle {
  const boot = inspectLastSession();

  /* 先把"上次怎么退的"记下来 —— 这是最有用的一条上下文 */
  if (boot.lastSessionAt !== null) {
    if (!boot.lastExitClean) {
      const ago = boot.sinceLastBeatMs;
      const when =
        ago === null
          ? '没有心跳记录'
          : ago > 3_600_000
            ? `${String(Math.round(ago / 3_600_000))} 小时前`
            : ago > 60_000
              ? `${String(Math.round(ago / 60_000))} 分钟前`
              : `${String(Math.round(ago / 1000))} 秒前`;
      /*
       * 「上次没正常退出」是最关键的一条。
       *
       * 心跳停在什么时候，就能推断是什么时候出的事 —— 这比"用户说用了
       * 一会儿就退了"精确得多。若是瞬间崩，心跳离崩溃时刻非常近；
       * 若是被杀，心跳会停在后台被冻结的那一刻。
       *
       * ## ★★★ 但不许断言"非正常结束"（2026-11-15）
       *
       * 真机日志里这一条和原生那条**互相打脸**，相隔 4 秒：
       *
       * ```text
       *   20:05:10.701 I BOOT: onDestroy（正常退出）
       *   20:05:15.118 I JS/EXIT: 上次会话非正常结束（没有退出标记）
       * ```
       *
       * 原因：本标记靠 `pagehide` 落，而 **Android 的 WebView 在 Activity
       * 正常销毁时不会触发 `pagehide`**（它只在页面导航时来）。
       *
       * 也就是说"没有 `pagehide` 记录"**不能**推出"非正常结束" ——
       * 正常退出同样没有。原来的措辞把一个"我不知道"说成了"出事了"。
       *
       * ⇒ 现在只陈述**能确定的事**（没有上次的 pagehide、心跳停在何时），
       * 并指明**哪一条才是权威**（原生的 onDestroy 标记，那个已改成
       * 同步 `commit()`）。两条日志说法不一致时，读日志的人必须知道该信谁。
       */
      diagNote(
        'exit',
        `上次没有收到页面隐藏记录，最后一次心跳：${when}。` +
          '（安卓正常退出也不会触发 pagehide，所以这**不等于**异常退出；' +
          '判断退出方式看相邻的 BOOT 行。）',
      );
    } else {
      /*
       * 有 `pagehide` 记录 —— 只说明"页面被隐藏/卸载过"，**不说明是退出**。
       * 切后台、切 Tab、导航都会留下它。原来说「正常退出」同样是过度断言。
       */
      diagNote('exit', '上次收到过页面隐藏记录（可能是切后台或退出）。');
    }
  }

  /* 本次会话标记：id 用时间戳 + 随机，确保每次不同 */
  const sessionId = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
  safeSet(KEY_SESSION, `${sessionId}|${String(Date.now())}`);
  /* 清掉上一次的 clean 标记：不清的话"正常退出"会一直被当成这次的 */
  safeSet(KEY_CLEAN, '');
  safeSet(KEY_BEAT, String(Date.now()));

  /*
   * 把上一次（桥还没就绪时）留在 localStorage 的记录补进原生文件。
   *
   * 放在 boot 之后、装监听之前：此刻桥已注入，补录不会丢；
   * 而补录本身失败也不影响后续。
   */
  flushLocalToNative();

  diagNote('boot', `启动 v${String(readVersionTag())}`);

  const target = globalThis as {
    addEventListener?: (type: string, fn: (event: unknown) => void) => void;
    removeEventListener?: (type: string, fn: (event: unknown) => void) => void;
  };

  const onError = (event: unknown): void => {
    const e = event as { error?: unknown; message?: unknown };
    diagRecord('error', e.error ?? e.message ?? 'unknown error');
  };
  const onRejection = (event: unknown): void => {
    const e = event as { reason?: unknown };
    diagRecord('unhandledrejection', e.reason ?? 'unknown rejection');
  };

  if (!installed) {
    target.addEventListener?.('error', onError);
    target.addEventListener?.('unhandledrejection', onRejection);
    installed = true;
  }

  /* 心跳：进程被杀时它停在最后一刻，成为"死亡时间" */
  const beatTimer = globalThis.setInterval(() => {
    safeSet(KEY_BEAT, String(Date.now()));
  }, BEAT_MS);

  /*
   * 正常退出标记。
   *
   * 用 `pagehide` 而不是 `beforeunload`：移动端 WebView 里后者经常不触发。
   * `pagehide` 在"页面被销毁/进后台被回收"时都会来 —— 但**进程被强杀不会**，
   * 那正是我们想区分的情况。
   */
  const onHide = (): void => {
    safeSet(KEY_CLEAN, sessionId);
    safeSet(KEY_BEAT, String(Date.now()));
    diagNote('exit', '页面隐藏（pagehide）');
  };
  target.addEventListener?.('pagehide', onHide);

  return {
    boot,
    note: diagNote,
    dispose: () => {
      globalThis.clearInterval(beatTimer);
      target.removeEventListener?.('error', onError);
      target.removeEventListener?.('unhandledrejection', onRejection);
      target.removeEventListener?.('pagehide', onHide);
      installed = false;
    },
  };
}

/**
 * 版本标签。
 *
 * ## 原来读 `__TCS_VERSION__`，而**没有人写它**（2026-11-22 修正）
 *
 * 那份诊断导出一直是 `版本：unknown`。用户第三次发日志时，我拿它判断
 * "这是哪个构建的包"——`unknown` 等于什么都没说，只能去数日志里有哪些
 * 诊断行反推，而反推错一次就会改错地方。
 *
 * ## 为什么不在这里 import `app-version.ts`
 *
 * 那个模块 `import clientPackage from '../../package.json'`，靠 **Vite**
 * 把 JSON 内联进来。而 Node 的 ESM 对 JSON import 要求 `with { type: 'json' }`，
 * 直接跑会 `ERR_IMPORT_ATTRIBUTE_MISSING` —— 本文件是被 DOM 判据
 * （`test/api-page-dom.test.mjs`）间接引入的，一 import 整份判据就崩。
 * `settings/about-info.ts` 的注释里早就写明了这一点，我这次又踩了一遍。
 *
 * ## 现在的做法：读全局，但**保证有写入方**
 *
 * `client/src/chat/shell.ts` 启动时写一次：
 * `globalThis.__TCS_VERSION__ = appVersion()`。
 *
 * 这样本文件保持零依赖（Node 里能独立跑），而那个全局不再是"没人管"的。
 * 判据 `test/mobile-crash-diag.test.mjs` 钉住"必须有写入方"。
 */
function readVersionTag(): string {
  const holder = globalThis as { __TCS_VERSION__?: unknown };
  return typeof holder.__TCS_VERSION__ === 'string' && holder.__TCS_VERSION__ !== ''
    ? holder.__TCS_VERSION__
    : '未知';
}

/**
 * 导出成可复制的文本（给用户看、给开发者看都够）。
 *
 * 顺序刻意是「结论在前」：用户截图时通常只截一屏，那一屏必须能回答
 * "上次怎么退的、崩在哪"。
 */
export function buildDiagReport(now: Date = new Date()): string {
  const boot = inspectLastSession();
  const lines: string[] = [];

  lines.push('=== TCS 诊断日志 ===');
  lines.push(`导出时间：${now.toLocaleString('zh-CN')}`);
  lines.push(`版本：${readVersionTag()}`);
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  if (typeof ua === 'string' && ua !== '') lines.push(`WebView：${ua}`);

  /*
   * 日志文件在哪、有多大 —— 用户最常问的就是这两个（2026-11-12）。
   *
   * 明写路径的理由：他要用数据线去电脑上找文件，光说"已经记录了"
   * 等于让他自己猜。而 Android 11+ 的自带文件管理器进不去
   * `Android/data`，所以同时给出「导出到 Download」这条更省事的路。
   */
  const status = nativeStatus();
  if (status !== null) {
    lines.push(`日志目录：${status.dir}`);
    lines.push(
      `占用：${(status.totalBytes / 1024 / 1024).toFixed(1)} MB / 上限 ${(status.limitBytes / 1024 / 1024).toFixed(0)} MB（${String(status.fileCount)} 个文件）`,
    );
  } else {
    lines.push('日志目录：原生桥不可用（当前记录在 WebView 内部，重启会丢）');
  }
  lines.push('');

  lines.push('--- 结论 ---');
  lines.push(
    boot.lastExitClean
      ? '上次会话：正常退出'
      : '上次会话：非正常结束（可能是崩溃，也可能是被系统回收）',
  );
  if (boot.sinceLastBeatMs !== null) {
    lines.push(`最后一次心跳：${String(Math.round(boot.sinceLastBeatMs / 1000))} 秒前`);
  }
  /*
   * 这里的计数只针对**桥就绪前的兜底记录**（localStorage）。
   *
   * 完整的错误统计在原生日志里 —— JS 读进来的是已格式化的文本，
   * 再解析一遍统计数字不值得（读的人看的是内容，不是条数）。
   */
  const localEntries = readDiagEntries();
  lines.push(
    localEntries.length > 0
      ? `桥就绪前的兜底记录：${String(localEntries.length)} 条（完整日志见下方原生日志）`
      : '桥就绪前没有兜底记录',
  );
  lines.push('');

  /*
   * 明细**优先取原生文件**（2026-11-12）。
   *
   * 原生日志才有完整现场：Java 崩溃、Activity 前后台、引擎进程死亡
   * 都在里面。localStorage 里只剩"桥还没就绪那几十毫秒"的零星记录。
   *
   * 限 256KB：整份可能 16MB，一次性塞进 JS 会把 WebView 顶爆 ——
   * 那是"为了看日志而制造新的崩溃"。
   */
  const native = nativeRead(256 * 1024);
  if (native !== null && native !== '') {
    lines.push('--- 原生日志（最近 256KB）---');
    lines.push(native);
    const local = readDiagEntries();
    if (local.length > 0) {
      lines.push('');
      lines.push(`--- 桥就绪前的记录（${String(local.length)} 条）---`);
      for (const one of local) {
        lines.push(`[${new Date(one.at).toLocaleTimeString('zh-CN')}] ${one.kind.toUpperCase()}: ${one.message}`);
      }
    }
    return lines.join('\n');
  }

  /* 原生不可用（桌面/测试）→ 退回旧路径 */
  const entries = localEntries;
  lines.push('--- 明细（旧 → 新）---');
  for (const one of entries) {
    const time = new Date(one.at).toLocaleTimeString('zh-CN');
    lines.push(`[${time}] ${one.kind.toUpperCase()}: ${one.message}`);
    if (one.stack !== undefined && one.stack !== '') {
      lines.push(`    ${one.stack}`);
    }
  }
  if (entries.length === 0) lines.push('（没有记录）');

  return lines.join('\n');
}

/** 原生日志状态（拿不到返回 null） */
export interface NativeLogStatus {
  dir: string;
  totalBytes: number;
  fileCount: number;
  limitBytes: number;
}

export function nativeStatus(): NativeLogStatus | null {
  const bridge = nativeBridge();
  if (bridge?.logStatus === undefined) return null;
  try {
    const raw = bridge.logStatus();
    if (typeof raw !== 'string' || raw === '') return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const dir = typeof parsed['dir'] === 'string' ? parsed['dir'] : '';
    if (dir === '') return null;
    return {
      dir,
      totalBytes: typeof parsed['totalBytes'] === 'number' ? parsed['totalBytes'] : 0,
      fileCount: typeof parsed['fileCount'] === 'number' ? parsed['fileCount'] : 0,
      limitBytes: typeof parsed['limitBytes'] === 'number' ? parsed['limitBytes'] : 0,
    };
  } catch {
    return null;
  }
}

/** 读原生日志（拿不到返回 null） */
export function nativeRead(maxBytes: number): string | null {
  const bridge = nativeBridge();
  if (bridge?.logRead === undefined) return null;
  try {
    const text = bridge.logRead(maxBytes);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 导出到 `Download/`，返回文件名（失败返回空串）。
 *
 * 这是给用户最省事的一条路：Android 11+ 的文件管理器进不去
 * `Android/data`，而 `Download/` 谁都能开、也能长按直接分享。
 */
export function exportNativeLog(): string {
  const bridge = nativeBridge();
  if (bridge?.logExport === undefined) return '';
  try {
    const name = bridge.logExport();
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * 清空日志（用户主动操作）。
 *
 * 两处都清：原生日志文件 + localStorage 兜底。只清一处的话，
 * 用户会看到"点了清空但内容还在"（另一半还在）。
 */
export function clearDiagLog(): void {
  const bridge = nativeBridge();
  try {
    bridge?.logClear?.();
  } catch {
    /* 清不掉就让下面的 localStorage 清 —— 至少做到一半 */
  }
  safeSet(KEY_LOG, '[]');
  /* 清完记一条新的：日志文件不是空的，用户能确认"清空生效了" */
  diagNote('note', '日志已由用户清空');
}
