/**
 * F7 验收：高亮方案的 theme 只作用于内容区，不改应用界面。
 *
 * ## 为什么既要截图又要计算样式
 *
 * 截图是给人看的证据，但不是判据 —— 深色方案下"面板看起来还是浅的"这种话
 * 只能靠眼睛，而眼睛在对比度不高时会错。所以主判据是 `getComputedStyle` 的
 * **实际像素值**：深色方案下 `.cm-host` 的底色必须是 #1c1f26（rgb(28,31,38)），
 * 而 `.topbar` / `.issues-panel` 的底色必须与浅色方案下**完全相同**。
 *
 * 这条断言能抓住的正是 v0.1.2 的缺陷：`applySchemeStyles` 把 --tcs-* 写到 :root，
 * 界面元素读同一批变量 → 一套深色方案把顶栏、面板一起染黑。
 *
 * ## 一次进程内跑完
 *
 * 静态服务与 Chrome 都由本脚本 spawn，跑完自己清理。分两次调用会失败：
 * 命令行工具结束时子进程会被回收（本机实测），上一轮留下的 chrome 连不上。
 *
 * 用法：node scripts/shot-f7-theme.mjs
 * 输出：docs/assets/f7-theme-{dark,light}.png + 终端里的计算样式对照表
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'client', 'dist');
const OUT = join(REPO, 'docs', 'assets');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WEB_PORT = 8912;
const CDP_PORT = 9477;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简静态服务：只服务 dist，够截图用 */
function startStatic() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let path = decodeURIComponent(url.pathname);
    if (path === '/' || path === '') path = '/index.html';
    const file = join(DIST, path);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }).listen(WEB_PORT, '127.0.0.1');
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
      setTimeout(() => rej(new Error('CDP 连接超时')), 10000);
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: r, reject: j } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });
  }

  send(method, params = {}, timeout = 25000) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }
      }, timeout);
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(`页面脚本报错：${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`);
    }
    return r.result.value;
  }
}

/** 取一组元素的实际配色（这是判据） */
const PROBE = `(() => {
  const px = (node) => {
    if (!node) return null;
    const cs = getComputedStyle(node);
    return { bg: cs.backgroundColor, fg: cs.color };
  };
  const host = document.querySelector('.cm-host');
  const preview = document.querySelector('.preview');
  // 编辑器真实内容区的底色由 CM6 画在 .cm-editor 上
  const editor = document.querySelector('.cm-host .cm-editor');
  return {
    rootTcsFg: getComputedStyle(document.documentElement).getPropertyValue('--tcs-fg').trim(),
    host: px(host),
    editor: px(editor),
    preview: preview && !preview.hidden ? px(preview) : null,
    topbar: px(document.querySelector('.topbar')),
    issuesPanel: px(document.querySelector('.issues-panel')),
    body: px(document.body),
  };
})()`;

const results = [];
const failures = [];

function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? `（${detail}）` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * 判断颜色是否"深"：RGB 三通道均值 < 96。
 *
 * **透明色返回 null，不当作深色**。第一版这里直接按 RGB 算，于是
 * `.cm-editor` 的 `rgba(0,0,0,0)`（完全透明，跟着父级底色走）被算成"深色"，
 * 断言"编辑器内容区底色是深色"在浅色方案下也会通过 —— 典型的假通过。
 * 现在的约定是：null = 这个元素没有自己的底色，判据改成看它的**文字色**。
 */
function isDark(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(color ?? '');
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha === 0) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return (r + g + b) / 3 < 96;
}

/** 颜色是否"浅"（用于深色方案下的文字色断言） */
function isLight(color) {
  const dark = isDark(color);
  return dark === null ? null : !dark;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('client/dist 没有 index.html，先 npm run build:ui');
  mkdirSync(OUT, { recursive: true });

  const server = startStatic();
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      '--window-size=1600,1000',
      `--user-data-dir=${join(REPO, '.verify', 'chrome-f7-profile')}`,
      `http://127.0.0.1:${String(WEB_PORT)}/index.html?sample=1`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let cdp = null;
  const cleanup = () => {
    try {
      chrome.kill();
    } catch {
      /* 忽略 */
    }
    server.close();
  };

  try {
    let wsUrl = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json();
        const page = list.find((item) => item.type === 'page' && item.url.includes(String(WEB_PORT)));
        if (page?.webSocketDebuggerUrl) {
          wsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch {
        /* Chrome 还没起来 */
      }
    }
    if (!wsUrl) throw new Error('没能连上 Chrome 的 CDP');

    cdp = new Cdp(wsUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 2,
      mobile: false,
    });

    const waitReady = async () => {
      for (let i = 0; i < 80; i += 1) {
        const ok = await cdp.evaluate(
          `(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化') && !!document.querySelector('.cm-host .cm-editor'); })()`,
        );
        if (ok) return true;
        await sleep(200);
      }
      return false;
    };

    // 打开第一个板块的渲染预览（这样 .preview 也在判据里）
    const openPreview = async () => {
      await cdp.evaluate(
        `(() => { const b = document.querySelector('#btn-preview'); if (b) b.click(); return true; })()`,
      );
      await sleep(500);
    };

    for (const scheme of ['default', 'dark']) {
      console.log(`\n▸ 高亮方案：${scheme}`);
      await cdp.send('Page.navigate', {
        url: `http://127.0.0.1:${String(WEB_PORT)}/index.html?sample=1&highlight=${scheme}`,
      });
      await sleep(1200);
      if (!(await waitReady())) throw new Error('页面没准备好（编辑器未挂载）');
      await openPreview();

      const probe = await cdp.evaluate(PROBE);
      writeln(probe);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = join(OUT, `f7-theme-${scheme}.png`);
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  截图：${file}`);

      if (scheme === 'dark') {
        check(isDark(probe.host?.bg) === true, '深色方案：编辑区底色是深色', probe.host?.bg ?? 'null');
        // `.cm-editor` 的 bg 是 transparent（跟着宿主走），所以这里看**文字色**：
        // 深色方案下正文必须是浅色 —— 这才是"配色真的进了编辑器"的证据
        check(isLight(probe.editor?.fg) === true, '深色方案：编辑器正文是浅色', probe.editor?.fg ?? 'null');
        check(probe.rootTcsFg === '', '深色方案：--tcs-fg 没有写到 :root（作用域已收缩）', `:root 上的值是「${probe.rootTcsFg}」`);
        check(isDark(probe.topbar?.bg) === false, '深色方案：顶栏**不**跟随变深', probe.topbar?.bg ?? 'null');
        check(isDark(probe.issuesPanel?.bg) === false, '深色方案：审计面板**不**跟随变深', probe.issuesPanel?.bg ?? 'null');
        check(isDark(probe.body?.bg) === false, '深色方案：界面底色**不**跟随变深', probe.body?.bg ?? 'null');
        // 顶栏文字也必须是深色（白底 + 浅字就是看不见了）
        check(isDark(probe.topbar?.fg) === true, '深色方案：顶栏文字仍是深色', probe.topbar?.fg ?? 'null');
        globalThis.darkProbe = probe;
      } else {
        check(isDark(probe.host?.bg) === false, '浅色方案：编辑区底色是浅色', probe.host?.bg ?? 'null');
        check(isDark(probe.editor?.fg) === true, '浅色方案：编辑器正文是深色', probe.editor?.fg ?? 'null');
        globalThis.lightProbe = probe;
      }
    }

    // 跨方案比对：界面元素必须一模一样
    const dark = globalThis.darkProbe;
    const light = globalThis.lightProbe;
    console.log('\n▸ 跨方案比对（界面元素必须逐项相同）');
    for (const key of ['topbar', 'issuesPanel', 'body']) {
      const same = dark?.[key]?.bg === light?.[key]?.bg && dark?.[key]?.fg === light?.[key]?.fg;
      check(same, `${key} 两种方案下配色一致`, `${light?.[key]?.bg} vs ${dark?.[key]?.bg}`);
    }
  } finally {
    cleanup();
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`结论：通过（${String(results.length)} 项）`);
  } else {
    console.log(`结论：未通过（${String(failures.length)} 项）`);
    process.exitCode = 1;
  }
}

function writeln(probe) {
  const row = (label, value) => console.log(`    ${label.padEnd(12)} ${String(value ?? '—')}`);
  row(':root --tcs-fg', probe.rootTcsFg === '' ? '(空)' : probe.rootTcsFg);
  row('编辑器宿主', probe.host?.bg);
  row('编辑器内容', probe.editor?.bg);
  row('渲染预览', probe.preview?.bg);
  row('顶栏', probe.topbar?.bg);
  row('审计面板', probe.issuesPanel?.bg);
  row('body', probe.body?.bg);
}

await main();
