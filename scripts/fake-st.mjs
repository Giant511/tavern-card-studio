/**
 * 一个**最小的假 SillyTavern**（v0.1.6 / T14.1 的回归样本与排障工具）。
 *
 * 它存在的理由有三条，都不是"测试想省事"：
 *
 *   1. **真机上验证内嵌面板**时，用户不必先装一份真 ST（几百 MB、还要 Node 依赖）——
 *      起这个假 ST 就能验证"客户端 → 代理 → 页面加载 → WS 回显 → SSE 逐字"整条链路；
 *   2. **改端口链路（T14.7）**要有第二个端口上的"服务"，否则"改成 8001 还连得上"
 *      这件事证明不了（8001 上原本什么都没有）；
 *   3. 它是**故意不配合**的：不发任何 `Access-Control-Allow-*` 头。这正是真 ST 的行为，
 *      也是 F15 那次误报的场景 —— 假 ST 发 CORS 头会让"跨源被拦"这类缺陷永远测不出来。
 *
 * 用法：
 *   node scripts/fake-st.mjs                 # 监听 127.0.0.1:8000
 *   node scripts/fake-st.mjs --port 8001     # 换端口（验 T14.7 的改端口链路）
 *
 * 页面内容故意极简：一个能点的按钮（走 WS 回显）+ 一个流式输出的按钮（走 SSE）。
 * 页面**没有构建步骤**，也不依赖任何网络资源 —— 它要能被完全离线地打开。
 */

import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8000' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

const PORT = Number(values.port);
const HOST = values.host;

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Fake SillyTavern</title>
<style>
  body { font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; color: #1f2328; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
         background: #eef6ff; color: #0b62d6; border: 1px solid #c9d9fb; }
  button { margin: 6px 6px 0 0; padding: 5px 12px; font: inherit; border-radius: 6px;
           border: 1px solid #d0d7de; background: #fff; cursor: pointer; }
  pre { margin-top: 12px; padding: 10px 12px; background: #f6f8fa; border-radius: 6px;
        min-height: 60px; white-space: pre-wrap; font-size: 12.5px; }
</style>
</head>
<body>
  <span class="tag">fake ST · 不是真的 SillyTavern</span>
  <h1>页面已通过客户端内嵌代理加载</h1>
  <p>这一页能打开，说明「客户端 → 本地代理 → 目标端口」这条链路是通的。</p>
  <button id="ws">WS 回显</button>
  <button id="sse">SSE 流式</button>
  <pre id="out">（还没试）</pre>
<script>
  const out = document.getElementById('out');
  document.getElementById('ws').addEventListener('click', () => {
    out.textContent = 'WS 连接中…';
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => ws.send('hello-from-' + location.host);
    ws.onmessage = (event) => { out.textContent = 'WS 回显：' + event.data; ws.close(); };
    ws.onerror = () => { out.textContent = 'WS 失败（代理没把 upgrade 转过去）'; };
  });
  document.getElementById('sse').addEventListener('click', async () => {
    out.textContent = '';
    const response = await fetch('/api/stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // 逐块显示：如果代理整包缓冲，这里会"憋到最后一次性出现"
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out.textContent += decoder.decode(value, { stream: true });
    }
  });
</script>
</body>
</html>`;

/** 极简 WS：只做握手 + 文本回显（不解码分片，够证明"字节透传"） */
function upgradeToWebSocket(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  socket.on('data', (chunk) => {
    // 只认"客户端发来的、带掩码的文本帧"（opcode 0x1），其余原样丢掉
    if (chunk.length < 6 || (chunk[0] & 0x0f) !== 0x1) return;
    const masked = (chunk[1] & 0x80) !== 0;
    let length = chunk[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = chunk.readUInt16BE(2);
      offset = 4;
    }
    let payload;
    if (masked) {
      const mask = chunk.subarray(offset, offset + 4);
      payload = Buffer.from(chunk.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    } else {
      payload = chunk.subarray(offset, offset + length);
    }
    const body = Buffer.from(payload);
    const header = body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
    socket.write(Buffer.concat([header, body]));
  });
  socket.on('error', () => undefined);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${String(PORT)}`);

  if (url.pathname === '/api/stream') {
    // SSE：**故意分块慢发**。整包缓冲的代理会让这里"憋住"，
    // 所以它同时是"流式转发"的判据
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    let index = 0;
    const timer = setInterval(() => {
      index += 1;
      response.write(`data: chunk-${String(index)}\n\n`);
      if (index >= 5) {
        clearInterval(timer);
        response.end();
      }
    }, 120);
    request.on('close', () => clearInterval(timer));
    return;
  }

  if (url.pathname === '/api/echo') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(
      JSON.stringify({
        path: url.pathname,
        // 把 Host 回显出来：代理改写 Host 之后，这里应当显示 **ST 的** host:port
        host: request.headers.host ?? '',
        method: request.method ?? '',
      }),
    );
    return;
  }

  // 其余一律回页面：ST 的 `<base href="/">` 意味着所有相对路径都落在根上，
  // 假 ST 也照这个来（否则"页面能打开但资源 404"会被误当成代理的问题）
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(PAGE);
});

server.on('upgrade', (request, socket) => upgradeToWebSocket(request, socket));

server.listen(PORT, HOST, () => {
  /*
   * `--port 0` 让内核分配端口，然后把**实际端口**打在第一行。
   * 这是给自动化用的（`cargo test` 里那个端到端用例要读它）：
   * 写死端口会和"本机已经有个 ST 在 8000"打架，而那是最常见的现场。
   */
  const actual = server.address();
  const bound = typeof actual === 'object' && actual !== null ? actual.port : PORT;
  process.stdout.write(`假 ST 已在 http://${HOST}:${String(bound)} 启动（不发任何 CORS 头）\n`);
  process.stdout.write('  页面：GET /\n  WS：GET /ws\n  SSE：GET /api/stream\n  Host 回显：GET /api/echo\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
