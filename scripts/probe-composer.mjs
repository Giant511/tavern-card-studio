/**
 * 取证：聊天页输入区（.nb-composer）为什么没有贴底。
 *
 * 只采集事实，不做判断 —— 输出每一项的 computed 值与矩形，
 * 让根因从数据里显出来，而不是我先猜一个再去凑证据。
 *
 * 用法：node scripts/probe-composer.mjs --port 20902 --http-port 20901
 */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', '20902'));
const HTTP_PORT = Number(arg('--http-port', '20901'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const connect = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new Cdp(ws)));
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 360,
  height: 800,
  deviceScaleFactor: 2,
  mobile: true,
});

const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  return r.result.value;
};

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/mobile.html` });
await sleep(1200);
for (let i = 0; i < 40; i += 1) {
  if ((await ev("document.body.dataset.appReady === 'true'")) === true) break;
  await sleep(100);
}

const dump = await ev(`(() => {
  const describe = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, missing: true };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      label,
      sel,
      rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) },
      display: cs.display,
      position: cs.position,
      flex: cs.flex,
      flexGrow: cs.flexGrow,
      minHeight: cs.minHeight,
      marginTop: cs.marginTop,
      marginBottom: cs.marginBottom,
      height: cs.height,
      alignItems: cs.alignItems,
      justifyContent: cs.justifyContent,
      parent: el.parentElement ? el.parentElement.className || el.parentElement.tagName : null,
      children: [...el.children].map((c) => ({
        cls: (c.className || c.tagName).toString().split(' ')[0],
        h: Math.round(c.getBoundingClientRect().height),
      })),
    };
  };
  return {
    viewport: { w: innerWidth, h: innerHeight },
    chain: [
      describe('.nb-app', '外壳'),
      describe('.nb-page', '页面'),
      describe('.nb-topbar', '顶栏'),
      describe('.nb-msglist', '消息列表'),
      describe('.nb-empty', '空状态'),
      describe('.nb-composer', '输入区'),
      describe('.nb-tabbar', 'Tab 栏'),
    ],
    /* 页面容器的直接子元素顺序与高度 —— 这是判断"谁占了空间"的关键 */
    pageChildren: (() => {
      const p = document.querySelector('.nb-page');
      if (!p) return null;
      return [...p.children].map((c) => ({
        cls: (c.className || c.tagName).toString(),
        h: Math.round(c.getBoundingClientRect().height),
        top: Math.round(c.getBoundingClientRect().top),
        flexGrow: getComputedStyle(c).flexGrow,
        display: getComputedStyle(c).display,
      }));
    })(),
  };
})()`);

console.log(JSON.stringify(dump, null, 1));
cdp.ws.close();
process.exit(0);
