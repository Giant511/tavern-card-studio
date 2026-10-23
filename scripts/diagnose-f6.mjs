/**
 * F6 审计面板正文空白 —— 三件套定位（DOM 断言 + 控制台采集 + 截图）。
 *
 * 为什么不能只靠看截图：症状是"计数在、正文空"。计数来自 `#issue-summary`
 * （面板标题栏，在 `#audit-panel` 之外），正文来自 `AuditPanel` 内部的五个区块。
 * 只有分别断言这两处，才能区分三种可能：数据没算出来 / 渲染没被调用 /
 * 渲染写进了不在 DOM 里的节点。
 *
 * 用法：node scripts/diagnose-f6.mjs [阶段] [输出后缀]
 *   阶段：before | after（默认 before）
 * 产物：.verify/f6/<阶段>-*.png 与 .verify/f6/<阶段>-report.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'f6');
const PORT = 9333;
const STAGE = process.argv[2] ?? 'before';

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
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
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
      }, 25000);
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
  mkdirSync(OUT, { recursive: true });
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到 8899 页面');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Console.enable');

  // ── 控制台采集 ────────────────────────────────────────
  const consoleErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    consoleErrors.push({ level: p.type, text: String(text).slice(0, 400) });
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails ?? {};
    consoleErrors.push({
      level: 'exception',
      text: (d.exception?.description ?? d.text ?? 'unknown').slice(0, 600),
    });
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry ?? {};
    if (e.level === 'error') consoleErrors.push({ level: 'log', text: String(e.text ?? '').slice(0, 400) });
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  // 清场 + 强制重载（保证跑的是最新 dist，且没有上一轮残留的会话）
  await evaluate(`(() => {
    const app = window.__tcs?.app;
    if (app && Array.isArray(app.sessions)) for (const s of app.sessions) s.markSaved(null);
    return true;
  })()`).catch(() => {});
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`);
    if (ready) break;
    await sleep(200);
  }

  const probe = () => evaluate(`(() => {
    const panel = document.querySelector('#audit-panel');
    const kids = panel ? panel.children.length : -1;
    const q = (sel) => document.querySelectorAll(sel).length;
    const app = window.__tcs?.app;
    return {
      // 标题栏计数（在 #audit-panel 之外）
      issueSummary: document.querySelector('#issue-summary')?.textContent.trim() ?? '',
      stats: document.querySelector('#stats')?.textContent.trim() ?? '',
      status: document.querySelector('#status')?.textContent.trim() ?? '',
      // 面板容器
      panelChildren: kids,
      panelInnerHTMLLength: panel ? panel.innerHTML.length : -1,
      panelRect: panel ? { w: Math.round(panel.getBoundingClientRect().width), h: Math.round(panel.getBoundingClientRect().height) } : null,
      // 五个区块是否在文档里
      inDoc: {
        summary: q('.audit-summary'),
        filters: q('.audit-filters'),
        words: q('.audit-words'),
        list: q('.audit-list'),
        listHead: q('.audit-list-head'),
        issues: q('.issue'),
        emptyText: q('.issue-empty'),
      },
      // 数据层：app 里有没有报告
      reportIssues: app && app.report ? app.report.issues.length : null,
      reportSummary: app && app.report ? app.report.summary : null,
      sessionCount: app && Array.isArray(app.sessions) ? app.sessions.length : null,
    };
  })()`);

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, `${STAGE}-${name}.png`), Buffer.from(r.data, 'base64'));
  };

  // ── A. 空白启动（这一步会走 mountEmptyWorkspace → auditPanel.clear()）──
  const boot = await probe();
  await shot('boot');

  // ── B. 新建卡 + 让它产生审计结果 ────────────────────────
  await evaluate(`document.querySelector('#btn-new').click()`);
  for (let i = 0; i < 40; i += 1) {
    const open = await evaluate(`(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`);
    if (open) break;
    await sleep(100);
  }
  // 打开对话框再取消，确认这条路径不会额外破坏状态（需求要求排查渲染入口是否未被调用）
  await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = '审计面板复现';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'f6-repro-001';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    return true;
  })()`);
  await sleep(600);

  // 编辑内容 → 触发审计（给一段含 <BOT> 伪标签与缺 {{user}} 的文本，能产出 error/warning）
  await evaluate(`(() => {
    const head = document.querySelector('.block .block-head');
    if (head) head.click();
    return true;
  })()`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`!!document.querySelector('.cm-content')`)) break;
    await sleep(100);
  }
  await evaluate(`(() => {
    const content = document.querySelector('.cm-content');
    content.focus();
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: '\n<BOT> 你好，{{char}}。' });
  await sleep(1200); // 等 scheduleValidate(260) 跑完

  const afterEdit = await probe();
  await shot('after-new-card');

  // 面板区域单独截一张（1440×900，聚焦右栏）
  const clip = await evaluate(`(() => {
    const p = document.querySelector('#audit-panel');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  if (clip.width > 10 && clip.height > 10) {
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: false,
    });
    writeFileSync(join(OUT, `${STAGE}-panel-only.png`), Buffer.from(r.data, 'base64'));
  }

  const report = { stage: STAGE, at: new Date().toISOString(), boot, afterEdit, consoleErrors };
  writeFileSync(join(OUT, `${STAGE}-report.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  // ── 终端摘要 ─────────────────────────────────────────
  const line = (label, ok, detail) => console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ' —— ' + detail : ''}`);
  console.log('=== 空白启动（clear() 已执行）===');
  console.log('  #audit-panel 子节点数 =', boot.panelChildren, '| .audit-summary 在文档中 =', boot.inDoc.summary);
  console.log('\n=== 新建卡并编辑后 ===');
  line('顶栏/标题计数有内容', afterEdit.issueSummary !== '', `"${afterEdit.issueSummary}"`);
  line('数据层有审计报告', afterEdit.reportIssues !== null, `issues=${afterEdit.reportIssues}`);
  line('#audit-panel 容器非空', afterEdit.panelChildren > 0, `${afterEdit.panelChildren} 个子节点，innerHTML ${afterEdit.panelInnerHTMLLength} 字符`);
  line('.audit-summary 在文档中', afterEdit.inDoc.summary > 0, `${afterEdit.inDoc.summary} 个`);
  line('.audit-filters 在文档中', afterEdit.inDoc.filters > 0, `${afterEdit.inDoc.filters} 个`);
  line('.audit-list 在文档中', afterEdit.inDoc.list > 0, `${afterEdit.inDoc.list} 个`);
  console.log('\n=== 控制台 ===');
  if (consoleErrors.length === 0) console.log('  无 error / warning / exception');
  else for (const e of consoleErrors) console.log(`  [${e.level}] ${e.text.slice(0, 200)}`);

  cdp.close();
  const failed = ![afterEdit.panelChildren > 0, afterEdit.inDoc.summary > 0].every(Boolean);
  console.log(`\n结论：${failed ? '复现成功（正文区块不在 DOM 中）' : '未复现（正文正常）'}`);
  process.exit(0);
};

main().catch((err) => {
  console.error('✘ 诊断中断：' + String(err?.message ?? err));
  process.exit(1);
});
