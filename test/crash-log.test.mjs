/**
 * 客户端异常日志（v0.1.2 反馈项一 / T10.26）的纯逻辑测试。
 *
 * 这一层的坏法全是"静默"的，所以每条都钉住一个具体后果：
 *   · 日志器自己抛异常 → 会变成新的未捕获异常 → 递归（`onerror` 自己触发自己）；
 *   · 不限速 → 渲染循环里的一行错误每秒写 60 条，几秒钟写满磁盘；
 *   · 把正文带进日志 → 用户导出后发出去，等于把创作内容发出去；
 *   · 诊断文件里版本/连接状态写"undefined" → 导出了也没人能用它排查。
 *
 * 落盘本身（壳里的 syscall）测不到 —— 本机 Node 无法 spawn 子进程，也不该在单测里
 * 真去写用户的配置目录。这里注入 `write`，断言的是"交给壳的那段文本"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDiagnosticsText,
  createCrashLogger,
  describeThrown,
  formatCrashEntry,
  installGlobalErrorHandlers,
  suggestDiagnosticsFileName,
} from '../client/src/diagnostics/crash-log.ts';

const SESSION = { openCards: 2, activeCardId: 'abc-123' };

test('describeThrown：Error / 字符串 / 对象 / null / 循环引用都能给出人话', () => {
  assert.match(describeThrown(new TypeError('boom')).message, /TypeError: boom/);
  assert.match(describeThrown(new TypeError('boom')).stack, /boom/);
  assert.equal(describeThrown('plain string').message, 'plain string');
  assert.equal(describeThrown(null).message, 'null');
  assert.equal(describeThrown(undefined).message, 'undefined');
  assert.equal(describeThrown({ code: 42 }).message, '{"code":42}');

  // 循环引用：JSON.stringify 会抛，不能让它把日志器带崩
  const cyclic = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => describeThrown(cyclic));
  assert.match(describeThrown(cyclic).message, /Object/);

  // 无消息的 Error 要退化成类型名，否则日志里就是一行空白
  assert.equal(describeThrown(new Error('')).message, 'Error');
});

test('formatCrashEntry：含时间、类型、会话摘要，且不含正文', () => {
  const text = formatCrashEntry({
    kind: 'error',
    message: 'Uncaught TypeError: x is undefined',
    stack: 'at foo (app.js:10:3)\nat bar (app.js:20:1)',
    session: SESSION,
    at: new Date('2026-10-24T03:04:05.000Z'),
    userAgent: 'WebView2/120',
  });

  assert.match(text, /^\[2026-10-24T03:04:05\.000Z\] ERROR Uncaught TypeError/);
  assert.match(text, /session: openCards=2 activeCardId=abc-123/);
  assert.match(text, /ua: WebView2\/120/);
  // 堆栈逐行缩进，避免多行堆栈把下一条记录的开头淹没
  assert.match(text, /\n {2}at foo \(app\.js:10:3\)/);
  assert.match(text, /\n {2}at bar/);
  assert.ok(text.endsWith('\n'), '每条记录要以换行结尾，否则下一条会粘上来');
});

test('formatCrashEntry：零标签时 activeCardId 写 (none)，不写 undefined', () => {
  const text = formatCrashEntry({
    kind: 'unhandledrejection',
    message: 'rejected',
    stack: '',
    session: { openCards: 0, activeCardId: null },
    at: new Date('2026-10-24T00:00:00Z'),
  });
  assert.match(text, /activeCardId=\(none\)/);
  assert.doesNotMatch(text, /undefined/);
  assert.doesNotMatch(text, /NaN/);
});

test('日志器：正常记录会交出文本，并统计条数', () => {
  const written = [];
  const logger = createCrashLogger({ write: (entry) => written.push(entry) });
  logger.record('error', new Error('first'), SESSION);
  logger.record('unhandledrejection', new Error('second'), SESSION);

  assert.equal(written.length, 2);
  assert.match(written[0], /ERROR Error: first/);
  assert.match(written[1], /UNHANDLEDREJECTION Error: second/);
  assert.deepEqual(logger.stats(), { written: 2, suppressed: 0, failures: 0 });
});

test('日志器：write 抛异常不能把调用方带崩（否则会递归触发 onerror）', () => {
  const logger = createCrashLogger({
    write: () => {
      throw new Error('disk full');
    },
  });
  assert.doesNotThrow(() => logger.record('error', new Error('boom'), SESSION));
  assert.equal(logger.stats().failures, 1);
});

test('日志器：write 返回 rejected Promise 也不能变成新的 unhandledrejection', async () => {
  const logger = createCrashLogger({ write: () => Promise.reject(new Error('ipc failed')) });
  logger.record('error', new Error('boom'), SESSION);
  // 让微任务跑完，再确认没有被抛出来
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logger.stats().failures, 1);
});

test('日志器：限速 —— 超过每分钟上限只写一条说明，之后只计数', () => {
  const written = [];
  const logger = createCrashLogger({
    write: (entry) => written.push(entry),
    maxPerMinute: 3,
    now: () => new Date('2026-10-24T00:00:00Z'),
  });

  for (let index = 0; index < 10; index += 1) logger.record('error', new Error(`e${String(index)}`), SESSION);

  // 3 条正常 + 1 条"已限速"说明
  assert.equal(written.length, 4);
  assert.match(written[3], /日志限速/);
  const stats = logger.stats();
  assert.equal(stats.written, 4);
  assert.equal(stats.suppressed, 7);
});

test('日志器：限速窗口滑过之后恢复记录', () => {
  const written = [];
  let clock = 0;
  const logger = createCrashLogger({
    write: (entry) => written.push(entry),
    maxPerMinute: 2,
    now: () => new Date(2026, 0, 1, 0, 0, 0, clock),
  });

  logger.record('error', new Error('a'), SESSION);
  logger.record('error', new Error('b'), SESSION);
  logger.record('error', new Error('c'), SESSION); // 被限速
  assert.equal(written.length, 3, '2 条正常 + 1 条限速说明');

  clock = 61_000; // 一分钟零一秒后
  logger.record('error', new Error('d'), SESSION);
  assert.equal(written.length, 4, '窗口滑过之后应恢复写入');
  assert.match(written[3], /Error: d/);
});

test('installGlobalErrorHandlers：装两个钩子，卸载函数能把它们摘干净', () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const written = [];
  const logger = createCrashLogger({ write: (entry) => written.push(entry) });

  const uninstall = installGlobalErrorHandlers(logger, () => SESSION, target);
  assert.deepEqual([...listeners.keys()].sort(), ['error', 'unhandledrejection']);

  listeners.get('error')({ error: new Error('sync boom'), message: 'x' });
  listeners.get('unhandledrejection')({ reason: new Error('async boom') });
  assert.equal(written.length, 2);

  uninstall();
  assert.equal(listeners.size, 0, '卸载后不该留下监听器');
});

test('installGlobalErrorHandlers：取会话摘要抛异常时退化成零标签，不影响记录', () => {
  const listeners = new Map();
  const target = {
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener() {},
  };
  const written = [];
  const logger = createCrashLogger({ write: (entry) => written.push(entry) });
  installGlobalErrorHandlers(
    logger,
    () => {
      throw new Error('session rebuilding');
    },
    target,
  );

  assert.doesNotThrow(() => listeners.get('error')({ error: new Error('x'), message: 'x' }));
  assert.match(written[0], /openCards=0 activeCardId=\(none\)/);
});

test('诊断文本：版本、连接状态、会话摘要都在，日志原样贴在后半段', () => {
  const text = buildDiagnosticsText({
    logText: '[2026-10-24T00:00:00.000Z] ERROR boom\n  at foo',
    appVersion: '0.1.2',
    shellVersion: '0.1.2',
    shellMode: 'release',
    connection: '已连接 · 未登录',
    authPhase: 'anonymous',
    session: SESSION,
    now: new Date('2026-10-24T03:00:00.000Z'),
    userAgent: 'WebView2/120',
  });

  assert.match(text, /# Tavern Card Studio 诊断日志/);
  assert.match(text, /应用版本：0\.1\.2/);
  assert.match(text, /壳版本：0\.1\.2（release）/);
  assert.match(text, /连接状态：已连接 · 未登录/);
  assert.match(text, /打开的标签：2/);
  assert.match(text, /活动卡 ID：abc-123/);
  assert.match(text, /## client-error\.log/);
  assert.match(text, /ERROR boom/);
});

test('诊断文本：日志读不到时写明原因，而不是留空', () => {
  const text = buildDiagnosticsText({
    logText: null,
    logError: '文件不存在',
    appVersion: '0.1.2',
    shellVersion: '0.1.2',
    shellMode: 'release',
    connection: '未配置',
    authPhase: 'anonymous',
    session: { openCards: 0, activeCardId: null },
    now: new Date('2026-10-24T03:00:00.000Z'),
  });
  assert.match(text, /读不到日志文件：文件不存在/);
  assert.match(text, /活动卡 ID：\(none\)/);
});

test('诊断文本：日志为空时说清"没有捕获到异常"，不要让人以为文件坏了', () => {
  const text = buildDiagnosticsText({
    logText: '   \n',
    appVersion: '0.1.2',
    shellVersion: 'x',
    shellMode: 'release',
    connection: '未连接',
    authPhase: 'anonymous',
    session: { openCards: 1, activeCardId: 'id' },
    now: new Date('2026-10-24T03:00:00.000Z'),
  });
  assert.match(text, /日志为空：本次使用期间没有捕获到界面异常/);
});

test('诊断文件名：带秒级时间戳，连续导出不会互相覆盖', () => {
  const a = suggestDiagnosticsFileName(new Date(2026, 9, 24, 3, 4, 5));
  const b = suggestDiagnosticsFileName(new Date(2026, 9, 24, 3, 4, 6));
  assert.equal(a, 'tavern-card-studio-diagnostics-20261024-030405.txt');
  assert.equal(b, 'tavern-card-studio-diagnostics-20261024-030406.txt');
  assert.notEqual(a, b);
  assert.match(a, /\.txt$/, '必须是 txt（需求要求导出单个 txt）');
});
