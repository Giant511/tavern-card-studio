/**
 * P1-10 端到端判据：折叠 → 展开之后，撤销还要能撤回折叠前的编辑。
 *
 * ## 为什么需要这一条（`test/undo-survives-collapse.test.mjs` 不够吗）
 *
 * node 侧那 12 条验了三层：撤销栈确实在 `EditorState` 里（真 CodeMirror
 * state + mock target 驱动 `undo`）、复用决策、以及接线（静态）。
 *
 * 但有一环 node 验不了：`new EditorView({ state })` —— 把旧 state 交给一个
 * **新的 view** 到底行不行。它需要真实 DOM。这一条补的就是那一环。
 *
 * ## 判据（必须走真实 UI 入口，不许直接调 collapse/expand）
 *
 * ```text
 *   ① 点块头展开            → .cm-content 出现
 *   ② 真键盘输入 ZZTEST     → 文本含 ZZTEST（前提，否则后面无从谈起）
 *   ③ 点块头折叠            → .cm-content 消失（销毁生效，不是只 hidden）
 *   ④ 点块头展开            → .cm-content 回来
 *   ⑤ Ctrl+Z                → ZZTEST 消失，且内容回到导入时的样子
 * ```
 *
 * ③ 那条不能省：如果折叠只是 hidden、编辑器没销毁，那撤销本来就不会丢，
 * 这个探针会"通过"但什么也没证明。
 *
 * ## 阴性对照
 *
 * 修复前的行为是「⑤ 撤销后 ZZTEST 还在」。这个脚本如果在旧代码上跑，
 * 应当在 ⑤ 处红 —— 那正是它能证明修复有效的依据。
 *
 * ## 跑法
 *
 * ```bash
 * npm run build:ui
 * node scripts/verify-p110-undo.mjs
 * ```
 *
 * 退出码：0 全过 / 1 有判据失败 / 2 环境缺失
 */

import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'client', 'dist');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const WEB_PORT = 8913;
const CDP_PORT = 9478;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        `页面脚本报错：${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`,
      );
    }
    return r.result.value;
  }

  /** 发一次 Ctrl+Z（真键盘事件，走 CodeMirror 的 keymap） */
  async ctrlZ() {
    const base = { modifiers: 2, windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, code: 'KeyZ', key: 'z' };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}

const results = [];
const failures = [];

function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail === '' ? '' : `（${detail}）`}`);
  if (!ok) failures.push(label);
}

/** 读第一个块的状态：文本、有没有编辑器 DOM */
const PROBE_STATE = `(() => {
  const section = document.querySelector('[data-block-id]');
  if (!section) return { error: '没有找到任何板块' };
  const lines = [...section.querySelectorAll('.cm-content .cm-line')];
  return {
    blockId: section.getAttribute('data-block-id'),
    expanded: section.classList.contains('expanded'),
    hasEditorDom: section.querySelector('.cm-content') !== null,
    text: lines.map((n) => n.textContent).join('\\n'),
    caret: section.querySelector('.caret')?.textContent ?? '',
  };
})()`;

async function main() {
  if (!existsSync(CHROME)) {
    console.log(`跳过：找不到 Chrome（${CHROME}）`);
    process.exit(2);
  }
  if (!existsSync(join(DIST, 'index.html'))) {
    console.log('跳过：client/dist 没有 index.html，先 npm run build:ui');
    process.exit(2);
  }

  const server = startStatic();
  const profile = join(process.env.TEMP ?? '.', `tcs-p110-${String(Date.now())}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--hide-scrollbars',
      '--window-size=1280,900',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp = null;
  try {
    let page = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json();
        page = list.find((t) => t.type === 'page') ?? null;
        if (page) break;
      } catch {
        /* 等 Chrome 起来 */
      }
    }
    if (!page) throw new Error('CDP 没起来');

    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // headless 默认"页面无焦点"，CodeMirror 的 focus 判定会受影响
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${String(WEB_PORT)}/index.html?sample=1` });
    await sleep(4000);

    // 等示例卡与板块渲染出来
    let ready = false;
    for (let i = 0; i < 40; i += 1) {
      const state = await cdp.evaluate(PROBE_STATE);
      if (state && state.error === undefined) {
        ready = true;
        break;
      }
      await sleep(250);
    }
    if (!ready) throw new Error('板块没渲染出来（示例卡没加载？）');

    console.log('\nP1-10 折叠后撤销 —— 端到端\n');

    const initial = await cdp.evaluate(PROBE_STATE);
    console.log(`  板块：${initial.blockId}（初始 expanded=${String(initial.expanded)}）`);

    /* ── ① 展开（点真实块头） ────────────────────────── */
    if (!initial.expanded) {
      await cdp.evaluate(`document.querySelector('[data-block-id] .block-head').click()`);
      await sleep(700);
    }
    const afterExpand = await cdp.evaluate(PROBE_STATE);
    check(afterExpand.hasEditorDom, '① 展开后有编辑器 DOM');

    /* ── ② 真键盘输入 ──────────────────────────────── */
    await cdp.evaluate(`(() => {
      const content = document.querySelector('[data-block-id] .cm-content');
      content.focus();
      return true;
    })()`);
    await sleep(200);
    await cdp.send('Input.insertText', { text: 'ZZTEST' });
    await sleep(500);

    const typed = await cdp.evaluate(PROBE_STATE);
    check(typed.text.includes('ZZTEST'), '② 输入生效（前提判据）', `含 ZZTEST=${String(typed.text.includes('ZZTEST'))}`);
    if (!typed.text.includes('ZZTEST')) {
      /*
       * 输入没进去就没法验撤销。这不算"修复失败"，但也不能算通过 ——
       * 明确报出来，别让后面的判据在空数据上跑出假绿。
       */
      console.log('\n结论：输入没进编辑器，后续判据无从验证。');
      process.exit(1);
    }

    /* ── ③ 折叠（点真实块头）→ 编辑器 DOM 必须消失 ──── */
    await cdp.evaluate(`document.querySelector('[data-block-id] .block-head').click()`);
    await sleep(600);
    const collapsed = await cdp.evaluate(PROBE_STATE);
    check(!collapsed.expanded, '③ 折叠后 expanded 变 false');
    check(
      !collapsed.hasEditorDom,
      '③ 折叠后编辑器 DOM 必须消失（真的销毁，不是 hidden）',
      `hasEditorDom=${String(collapsed.hasEditorDom)}`,
    );

    /* ── ④ 再展开 ────────────────────────────────── */
    await cdp.evaluate(`document.querySelector('[data-block-id] .block-head').click()`);
    await sleep(800);
    const reopened = await cdp.evaluate(PROBE_STATE);
    check(reopened.hasEditorDom, '④ 重新展开后编辑器回来');
    check(
      reopened.text.includes('ZZTEST'),
      '④ 展开后内容仍是折叠前那份（没有丢）',
      `含 ZZTEST=${String(reopened.text.includes('ZZTEST'))}`,
    );

    /* ── ⑤ Ctrl+Z（真键盘事件） ─────────────────────── */
    await cdp.evaluate(`document.querySelector('[data-block-id] .cm-content').focus()`);
    await sleep(200);
    await cdp.ctrlZ();
    await sleep(600);

    const undone = await cdp.evaluate(PROBE_STATE);
    check(
      !undone.text.includes('ZZTEST'),
      '★★★ ⑤ Ctrl+Z 撤回了折叠前打的字（P1-10 本体）',
      `含 ZZTEST=${String(undone.text.includes('ZZTEST'))}`,
    );
    check(
      undone.text === initial.text,
      '⑤ 撤销后与初始内容完全一致',
      undone.text === initial.text ? '' : `差 ${String(undone.text.length - initial.text.length)} 字符`,
    );

    /* ── 汇总 ───────────────────────────────────── */
    const passed = results.length - failures.length;
    console.log(`\n${String(passed)}/${String(results.length)} 通过`);
    if (failures.length > 0) {
      console.log(`失败：${failures.join(' / ')}`);
      process.exit(1);
    }
    process.exit(0);
  } finally {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
  }
}

await main();
