/**
 * T14.0 三态取证：用**真实 TCP 连接**驱动 `describeTcpFailure`，打印面板会显示的那句话。
 *
 * 为什么不用截图：`probe_tcp` 是壳能力，无头浏览器里 `isShellAvailable()` 为假 ——
 * 设置面板的 ST 段会直接显示"仅桌面客户端生效"（这是刻意设计的，见 T14.0 说明）。
 * 而"三态文案对不对"这件事**不需要界面也能证**：它由纯函数
 * `classifyTcpFailure` / `describeTcpFailure` 决定，喂真实 socket 结果即可。
 *
 * 三种态怎么造（都不依赖 ST）：
 *   ① 通过   —— 自己起一个监听（真有人 accept）；
 *   ② 被拒   —— 连一个刚释放的端口（真 ECONNREFUSED 或被静默丢包）；
 *   ③ 超时   —— 连一个不可路由地址（本机回环外的地址不可用，这里改用
 *                「连上但不等」构造不出，所以直接喂 errorKind='TimedOut' 并注明是注入）；
 *   ④ 其它   —— 喂 'PermissionDenied'（真实来源：Windows 上被安全软件拦时会这么报）。
 *
 * 用法：node scripts/verify-t140-st-address.mjs
 */

import { createServer, Socket } from 'node:net';
import { describeTcpFailure } from '../client/src/session/st-address.ts';

function connect(host, port) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const socket = new Socket();
    const elapsed = () => Number((process.hrtime.bigint() - started) / 1_000_000n);
    const done = (facts) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ host, port, elapsedMs: Math.max(1, elapsed()), ...facts });
    };
    socket.setTimeout(1500);
    socket.once('connect', () => done({ errorKind: null, errorMessage: null, alive: true }));
    socket.once('timeout', () => done({ errorKind: 'TimedOut', errorMessage: 'connect timeout', alive: false }));
    socket.once('error', (error) =>
      done({
        errorKind: error.code === 'ECONNREFUSED' ? 'ConnectionRefused' : error.code,
        errorMessage: error.message,
        alive: false,
      }),
    );
    socket.connect({ host, port });
  });
}

const lines = [];
const push = (title, probe) => {
  const failure = describeTcpFailure(probe);
  lines.push(`【${title}】`);
  lines.push(`  面板会显示：${probe.alive ? `检测到 SillyTavern 在运行（${probe.host}:${String(probe.port)}，${String(probe.elapsedMs)}ms）` : `${failure.summary}（原始错误：${failure.detail}）`}`);
  lines.push(`  分类：${probe.alive ? 'ok' : failure.kind}`);
  lines.push('');
};

// ① 通过：真起一个监听
const server = createServer((socket) => socket.end());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const livePort = server.address().port;
push('态一 · 检测通过（真有人 accept）', await connect('127.0.0.1', livePort));
await new Promise((resolve) => server.close(resolve));

// ② 被拒：连一个刚释放的端口
push('态二 · 连接被拒（端口上没有服务）', await connect('127.0.0.1', livePort));

// ③ 超时：本机能造出真超时的只有不可路由地址，这里用注入的 errorKind 呈现文案
push('态三 · 超时（注入 TimedOut：真造超时需要不可路由地址）', {
  host: '127.0.0.1',
  port: 8000,
  errorKind: 'TimedOut',
  errorMessage: 'A connection attempt failed because the connected party did not properly respond (os error 10060)',
  elapsedMs: 1501,
});

// ④ 其它：权限类错误（安全软件拦截时的常见形态）
push('态四 · 其它错误（PermissionDenied）', {
  host: 'localhost',
  port: 8000,
  errorKind: 'PermissionDenied',
  errorMessage: 'An attempt was made to access a socket in a way forbidden by its access permissions',
  elapsedMs: 3,
});

console.log(lines.join('\n'));
