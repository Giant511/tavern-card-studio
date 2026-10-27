/**
 * 渲染层全局异常捕获（v0.1.2 反馈项一 / T10.26）。
 *
 * 三条设计约束，都是"不做就会让这个功能白做"的那一类：
 *
 * 1. **绝不碰 fs**。落盘走契约 `appendClientErrorLog`（壳里做，见
 *    `client/src/contract/shell.ts` 的 C8）。渲染层只负责把一条记录**格式化**好。
 * 2. **绝不抛异常**。这段代码是异常处理链的最后一环，它自己抛出去会变成
 *    未捕获异常 → 又触发一次 `onerror` → 递归。所以所有外部调用都包在 try 里，
 *    失败只记在内存里（`stats.failures`）。
 * 3. **必须限速**。渲染循环里的一行错误可以每帧触发一次 `onerror`
 *    （一秒 60 条），几秒钟就把磁盘写满、把用户机器拖死 —— 而真正有用的信息
 *    只有前几条。这里用「每分钟 N 条 + 一条抑制说明」的令牌桶。
 *
 * 记录内容刻意**不含卡片正文**：只给"开了几个标签、活动卡的 ID"。
 * 日志会被用户导出并发给别人看，正文里有用户的创作内容，那是隐私。
 */

/** 一条错误记录所需的上下文（只取摘要，不含正文） */
export interface SessionSummary {
  /** 当前打开的标签数 */
  openCards: number;
  /** 活动卡的角色卡 ID；零标签时为 null */
  activeCardId: string | null;
}

export type CrashKind = 'error' | 'unhandledrejection';

export interface CrashEntryInput {
  kind: CrashKind;
  message: string;
  stack: string;
  session: SessionSummary;
  at: Date;
  /** 用户代理（浏览器/WebView 版本，排查兼容性问题时是第一手信息） */
  userAgent?: string;
}

/** 把任意抛出物转成 (message, stack)。字符串、对象、null 都要能处理。 */
export function describeThrown(value: unknown): { message: string; stack: string } {
  if (value instanceof Error) {
    return { message: value.message === '' ? value.name : `${value.name}: ${value.message}`, stack: value.stack ?? '' };
  }
  if (typeof value === 'string') return { message: value, stack: '' };
  if (value === null) return { message: 'null', stack: '' };
  if (value === undefined) return { message: 'undefined', stack: '' };
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: '' };
  } catch {
    // 循环引用、BigInt 之类会让 JSON.stringify 抛
    return { message: Object.prototype.toString.call(value), stack: '' };
  }
}

/**
 * 格式化一条日志。**纯函数**：同样的输入产生逐字节相同的输出，
 * 这样才能在测试里断言格式，而不是靠"看着像"。
 *
 * 为什么是这种形态而不是 JSON Lines：这是**给用户看的**诊断文件，
 * 用户导出后可能直接贴进工单。一行 title + 缩进堆栈比一整行 JSON 好读得多，
 * 而"能不能被脚本解析"在这里不是需求。
 */
export function formatCrashEntry(input: CrashEntryInput): string {
  const lines: string[] = [];
  const stamp = input.at.toISOString();
  const head = input.message.split('\n')[0]?.slice(0, 300) ?? '';
  lines.push(`[${stamp}] ${input.kind.toUpperCase()} ${head}`);
  lines.push(`  session: openCards=${String(input.session.openCards)} activeCardId=${input.session.activeCardId ?? '(none)'}`);
  if (input.userAgent !== undefined && input.userAgent !== '') {
    lines.push(`  ua: ${input.userAgent}`);
  }
  const stack = input.stack.trim();
  if (stack !== '') {
    // 堆栈缩进两格：不加缩进的话，多行堆栈会把下一条记录的开头淹没
    for (const line of stack.split('\n')) lines.push(`  ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface CrashLoggerOptions {
  /** 落盘（生产走契约；测试注入数组） */
  write: (entry: string) => void | Promise<void>;
  now?: () => Date;
  /** 每分钟最多写多少条（默认 20）。超出的只计数，最后补一条说明。 */
  maxPerMinute?: number;
  userAgent?: string;
}

export interface CrashLoggerStats {
  /** 实际写出的条数 */
  written: number;
  /** 因限速被丢掉的条数 */
  suppressed: number;
  /** 写入失败次数（契约调用抛了） */
  failures: number;
}

export interface CrashLogger {
  /** 记录一条（永不抛） */
  record: (kind: CrashKind, thrown: unknown, session: SessionSummary) => void;
  stats: () => CrashLoggerStats;
}

const WINDOW_MS = 60_000;

/**
 * 创建限速日志器。
 *
 * 限速窗口是**滑动**的（保留最近一分钟内的时间戳），不是固定窗口 ——
 * 固定窗口在边界上会放过双倍流量，而这里的目标是"把洪泛压成可读的几条"。
 */
export function createCrashLogger(options: CrashLoggerOptions): CrashLogger {
  const now = options.now ?? (() => new Date());
  const limit = options.maxPerMinute ?? 20;
  const stamps: number[] = [];
  const stats: CrashLoggerStats = { written: 0, suppressed: 0, failures: 0 };

  const push = (entry: string): void => {
    try {
      const result = options.write(entry);
      // Promise 的拒绝要单独接住：不接就是新的 unhandledrejection，正好把这个
      // 日志器自己变成错误源（这类自反馈在"日志模块"里很常见）
      if (result !== undefined && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {
          stats.failures += 1;
        });
      }
    } catch {
      stats.failures += 1;
    }
  };

  return {
    record(kind, thrown, session) {
      try {
        const at = now();
        const time = at.getTime();
        while (stamps.length > 0 && time - stamps[0]! > WINDOW_MS) stamps.shift();

        const { message, stack } = describeThrown(thrown);
        if (stamps.length >= limit) {
          stats.suppressed += 1;
          // 只在"刚跨过阈值"时写一条说明，之后静默计数 —— 否则说明自己也会洪泛
          if (stats.suppressed === 1) {
            push(
              formatCrashEntry({
                kind,
                message: `日志限速：每分钟最多 ${String(limit)} 条，后续同类错误只计数不再写入（那条正说明可能存在错误循环）`,
                stack: '',
                session,
                at,
                ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
              }),
            );
            stats.written += 1;
          }
          return;
        }
        stamps.push(time);
        push(
          formatCrashEntry({
            kind,
            message,
            stack,
            session,
            at,
            ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
          }),
        );
        stats.written += 1;
      } catch {
        // 连格式化都失败（理论上不会）时什么都不做 —— 见文件头第 2 条
        stats.failures += 1;
      }
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * 装全局钩子。返回卸载函数（端到端脚本与测试要能摘掉，否则一个故意的
 * `throw` 会污染后面的用例）。
 *
 * `window.onerror` 用 `addEventListener('error')` 而不是直接赋值 `window.onerror`：
 * 赋值会**覆盖**别的模块（或调试工具）装的钩子，而监听器是叠加的。
 */
export function installGlobalErrorHandlers(
  logger: CrashLogger,
  session: () => SessionSummary,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const onError = (event: ErrorEvent): void => {
    const thrown = event.error ?? event.message;
    logger.record('error', thrown, safeSession(session));
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    logger.record('unhandledrejection', event.reason, safeSession(session));
  };

  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);
  return () => {
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}

/** 取会话摘要本身也可能抛（会话正在重建），那不能反过来变成新错误 */
function safeSession(session: () => SessionSummary): SessionSummary {
  try {
    return session();
  } catch {
    return { openCards: 0, activeCardId: null };
  }
}

// ────────────────────────────────────────────── 导出诊断

export interface DiagnosticsInput {
  /** client-error.log 的内容（读不到时给 null，导出文件里要写明而不是留空） */
  logText: string | null;
  /** 读日志时遇到的错误（可选） */
  logError?: string;
  appVersion: string;
  shellVersion: string;
  shellMode: string;
  /** 服务端连接状态一句话（复用顶栏那条，不另造一套措辞） */
  connection: string;
  authPhase: string;
  session: SessionSummary;
  now: Date;
  userAgent?: string;
}

/**
 * 组装「导出诊断日志」的文本。
 *
 * 顺序刻意是「结论在前、原始日志在后」：发回来的人通常只看前 30 行，
 * 而那 30 行必须能回答"什么版本、连的哪、崩的是哪张卡"。
 */
export function buildDiagnosticsText(input: DiagnosticsInput): string {
  const lines: string[] = [];
  lines.push('# Tavern Card Studio 诊断日志');
  lines.push('');
  lines.push(`导出时间：${input.now.toISOString()}`);
  lines.push(`应用版本：${input.appVersion}`);
  lines.push(`壳版本：${input.shellVersion}（${input.shellMode}）`);
  lines.push(`连接状态：${input.connection}`);
  lines.push(`登录状态：${input.authPhase}`);
  lines.push(`打开的标签：${String(input.session.openCards)}`);
  lines.push(`活动卡 ID：${input.session.activeCardId ?? '(none)'}`);
  if (input.userAgent !== undefined && input.userAgent !== '') lines.push(`UA：${input.userAgent}`);
  lines.push('');
  lines.push('## client-error.log');
  lines.push('');
  if (input.logText === null) {
    lines.push(`（读不到日志文件：${input.logError ?? '未知原因'}）`);
    lines.push('这是有信息量的结论：说明日志从未写入，或应用配置目录不可写。');
  } else if (input.logText.trim() === '') {
    lines.push('（日志为空：本次使用期间没有捕获到界面异常）');
  } else {
    // 原样贴，不重排：用户/开发者可能要靠行号对上堆栈
    lines.push(input.logText.replace(/\r\n/g, '\n').trimEnd());
  }
  lines.push('');
  return lines.join('\n');
}

/** 导出文件名：带时间戳，避免连续导出互相覆盖（用户常导出两三次对比） */
export function suggestDiagnosticsFileName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `tavern-card-studio-diagnostics-${stamp}.txt`;
}
