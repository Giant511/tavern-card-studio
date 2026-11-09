/**
 * 验证 mobile.html 真的渲染了四 Tab 移动 UI（而不是桌面编辑器）。
 *
 * ## 为什么要这个脚本
 *
 * 2026-10-31 用户装完 APK 发现**打开是桌面编辑器**，根因是 T15.5 的 UI
 * 从来没接进入口（`chat/` 目录没有任何非 chat 文件 import 过）。
 *
 * 那次事故的问题是：**做完的 UI 没人验证"它是否在产物里"**。
 * 所以这里把判据钉在产物上：
 *   · `dist/mobile.html` 存在；
 *   · 打开它以后 DOM 里有 `.nb-tabbar` 且 4 个 `.nb-tab`；
 *   · **没有**桌面编辑器才有的东西（`.topbar` / `#audit-panel`）；
 *   · UA 是 Android 时打开 `index.html` 会跳到 `mobile.html`。
 *
 * 用法：node scripts/verify-mobile-entry.mjs --port 20901
 */

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const PORT = Number(arg('--port', '20902'));       // CDP 调试端口
const HTTP_PORT = Number(arg('--http-port', '20901')); // 静态服务端口
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
if (!page) {
  console.error('找不到可调试页面');
  process.exit(2);
}

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
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
  }
  return r.result.value;
};

const results = [];
const check = (ok, msg) => {
  results.push(`${ok ? '✔' : '✘'} ${msg}`);
  return ok;
};

/* ── ① 直接打开 mobile.html ── */

await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/mobile.html` });
await sleep(900);

let ready = false;
for (let i = 0; i < 40; i += 1) {
  if ((await ev("document.body.dataset.appReady === 'true'")) === true) {
    ready = true;
    break;
  }
  await sleep(100);
}
check(ready, 'mobile.html 完成挂载（body[data-app-ready=true]）');

const facts = await ev(`(() => {
  const tabs = [...document.querySelectorAll('.nb-tab')].map((b) => b.getAttribute('data-tab'));
  return {
    shell: document.body.dataset.shell ?? null,
    tabCount: tabs.length,
    tabs,
    hasTabbar: document.querySelector('.nb-tabbar') !== null,
    hasApp: document.querySelector('.nb-app') !== null,
    // 桌面编辑器专属：出现任何一个就说明走错了界面
    desktopTopbar: document.querySelector('header.topbar') !== null,
    desktopAudit: document.getElementById('audit-panel') !== null,
    desktopCardName: document.getElementById('card-name') !== null,
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120),
  };
})()`);

if (facts.__error) {
  console.error('页面求值失败：', facts.__error);
  process.exit(3);
}

check(facts.shell === 'mobile', `body data-shell = ${facts.shell}`);
check(facts.tabCount === 4, `Tab 数量 = ${facts.tabCount}（应为 4）`);
check(
  JSON.stringify(facts.tabs) === JSON.stringify(['chat', 'cards', 'repo', 'me']),
  `Tab 顺序 = ${JSON.stringify(facts.tabs)}`,
);
check(facts.hasTabbar, '有 .nb-tabbar');
check(!facts.desktopTopbar, '没有桌面编辑器顶栏（header.topbar）');
check(!facts.desktopAudit, '没有桌面审计面板（#audit-panel）');
check(!facts.desktopCardName, '没有桌面角色名控件（#card-name）');

/* ── ② 四 Tab 能切，且空状态有话说 ── */

const clickTab = (id) =>
  ev(`(() => {
    const b = document.querySelector('.nb-tab[data-tab="${id}"]');
    if (!b) return false;
    b.click();
    return true;
  })()`);

await clickTab('cards');
await sleep(200);
const cardsText = await ev("(document.querySelector('.nb-page')||{}).innerText ?? ''");
check(
  typeof cardsText === 'string' && cardsText.length > 0 && !/暂无数据/.test(cardsText),
  `「卡片」页有内容且不是"暂无数据"：${String(cardsText).replace(/\s+/g, ' ').slice(0, 50)}`,
);

await clickTab('me');
await sleep(200);
const meText = await ev("(document.querySelector('.nb-page')||{}).innerText ?? ''");
check(typeof meText === 'string' && meText.length > 0, `「我的」页有内容`);

/* ── ③ Android UA 打开 index.html 应跳到 mobile.html ── */

await cdp.send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (Linux; Android 11; Redmi Note 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  platform: 'Linux armv8l',
});
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
await sleep(1200);

const afterJump = await ev(`(() => ({
  path: location.pathname,
  shell: document.body.dataset.shell ?? null,
  hasTabbar: document.querySelector('.nb-tabbar') !== null,
}))()`);
check(
  afterJump.path.endsWith('/mobile.html'),
  `Android UA 打开 index.html 被重定向到 ${afterJump.path}`,
);
check(afterJump.hasTabbar === true, '重定向后确实是移动 UI');

/* ── ④ 桌面 UA 打开 index.html 不跳 ── */

await cdp.send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  platform: 'Win32',
});
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html` });
await sleep(1200);

const desk = await ev(`(() => ({
  path: location.pathname,
  hasTopbar: document.querySelector('header.topbar') !== null,
}))()`);
check(desk.path.endsWith('/index.html'), `桌面 UA 停在 ${desk.path}（不该跳）`);
check(desk.hasTopbar === true, '桌面 UA 拿到的是编辑器顶栏');

/* ── ④ 截四张图（每个 Tab 一张，验收要能看见长什么样）── */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = join(process.cwd(), 'assets', 'android');
mkdirSync(SHOT_DIR, { recursive: true });

// 回到移动端并恢复移动 UA
await cdp.send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (Linux; Android 11; Redmi Note 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  platform: 'Linux armv8l',
});
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/mobile.html` });
await sleep(900);

for (const [tab, name] of [
  ['chat', '10-mobile-chat'],
  ['cards', '11-mobile-cards'],
  ['repo', '12-mobile-repo'],
  ['me', '13-mobile-me'],
]) {
  await ev(`document.querySelector('.nb-tab[data-tab="${tab}"]')?.click()`);
  await sleep(350);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const p = join(SHOT_DIR, `${name}.png`);
  writeFileSync(p, Buffer.from(data, 'base64'));
  console.log(`  截图 ${p}`);
}

/* ── 输出 ── */

console.log(`\n移动端入口验收（${results.length} 项）`);
console.log('─'.repeat(56));
for (const line of results) console.log('  ' + line);

const failed = results.filter((l) => l.startsWith('✘')).length;
console.log('─'.repeat(56));
console.log(failed === 0 ? `全部通过（${results.length}/${results.length}）` : `${failed} 项失败`);

try {
  cdp.ws.close();
} catch {
  /* ignore */
}
process.exit(failed === 0 ? 0 : 1);
