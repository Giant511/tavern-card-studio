/**
 * T9.14 端到端（第十二项）：F6「一键连接本机服务端」的真机分支验证。
 *
 * 两个分支都要走一遍，因为它们对应**完全不同的用户动作**：
 *   A. 失败分支 port-changed —— 本机真实状态：服务装在 192.168.1.203:8730，
 *      127.0.0.1:8731 面板通但 127.0.0.1:8730 不通。此时正确处置是"按面板上
 *      显示的地址手工填"，而不是"重装服务"。若报成 not-running，用户会去装服务。
 *   B. 成功分支 ok —— 127.0.0.1:8730 上有本版本服务时，应当一键取回令牌并落盘。
 *
 * 分工同前：浏览器由外部启动，本脚本只点按钮 + 断言 dataset。
 * 状态来源是 `document.body.dataset.localConnect`（`ok` / `fail:<kind>`），
 * 不靠读文案判断 —— 文案会改，分类是契约。
 *
 * 用法：node scripts/verify-f6.mjs [CDP 端口] [期望分支]
 *   期望分支：fail | ok（默认 fail）
 * 退出码：0 通过；1 失败
 */

const PORT = process.argv[2] ?? '9333';
const EXPECT = process.argv[3] ?? 'fail';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败：' + String(e.message ?? e))));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.method + ' 失败：' + JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
          return;
        }
        const list = this.handlers.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到 8899 的页面');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  };

  // 干净加载（避免上一轮写入的配置影响判断）
  await evaluate(`(() => { try { localStorage.clear(); } catch {} return true; })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`);
    if (ready) break;
    await sleep(200);
  }

  // ── 打开设置面板 ────────────────────────────────────────
  await evaluate(`document.querySelector('#btn-settings').click()`);
  let opened = false;
  for (let i = 0; i < 40; i += 1) {
    opened = await evaluate(`(() => [...document.querySelectorAll('.modal-overlay')].some(
      (o) => !o.hasAttribute('hidden') && o.textContent.includes('连接本机服务端')))()`);
    if (opened) break;
    await sleep(100);
  }
  check('设置面板可打开，且有一键连接入口', opened);

  // ── 点「连接本机服务端」 ────────────────────────────────
  const clicked = await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hasAttribute('hidden') && o.textContent.includes('连接本机服务端'));
    if (!overlay) return 'no-overlay';
    const btn = [...overlay.querySelectorAll('button')].find((b) => b.textContent.trim() === '连接本机服务端');
    if (!btn) return 'no-button';
    btn.click();
    return 'clicked';
  })()`);
  check('点到了一键连接按钮（真实按钮，不是直接调函数）', clicked === 'clicked', clicked);

  // 等 dataset 出现（探测 + 取令牌 + 落盘 + 两步校验，最长给 20s）
  let state = '';
  for (let i = 0; i < 100; i += 1) {
    state = await evaluate(`document.body.dataset.localConnect || ''`);
    if (state) break;
    await sleep(200);
  }
  check('一键连接给出了结论（不是一直转圈）', state !== '', state);

  const detail = await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hasAttribute('hidden'));
    const text = overlay ? overlay.innerText.replace(/\\s+/g, ' ') : '';
    return {
      kind: document.body.dataset.localConnect || '',
      steps: document.body.dataset.localSteps || '',
      tokenLength: document.body.dataset.localTokenLength || '',
      authRequired: document.body.dataset.localAuthRequired || '',
      persisted: document.body.dataset.localPersisted || '',
      serverVersion: document.body.dataset.localServerVersion || '',
      text: text.slice(0, 400),
    };
  })()`);

  if (EXPECT === 'ok') {
    check('结论为成功（ok）', detail.kind === 'ok', detail.kind);
    check('自动取到 32 字符令牌', detail.tokenLength === '32', detail.tokenLength);
    check('标注服务端要求鉴权', detail.authRequired === 'true', detail.authRequired);
    check('回填了服务端版本', detail.serverVersion !== '', detail.serverVersion);
    check('浏览器模式下如实标注未持久化（不谎报已保存）', detail.persisted === 'false', detail.persisted);
  } else {
    check('结论为失败，且分类可识别', detail.kind.startsWith('fail:'), detail.kind);
    const kind = detail.kind.replace('fail:', '');
    check(
      '失败分类属于已定义的 7 类',
      ['not-running', 'port-changed', 'not-local', 'token-denied', 'server-too-old', 'network', 'save-failed'].includes(kind),
      kind,
    );
    check('失败时给出至少 3 步可执行处置（不是只丢一句错误）', Number(detail.steps) >= 3, `${detail.steps} 步`);
    if (kind === 'port-changed') {
      check('port-changed 的说明覆盖了「监听地址被改」这种情况', /监听地址|局域网|网卡/.test(detail.text),
        detail.text.slice(0, 120));
    }
  }

  console.log(`\n面板文案：${detail.text}`);
  cdp.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
