/**
 * 高亮方案「完全没反应」的浏览器侧实证（v0.1.2 任务二）。
 *
 * 要证明的因果链只有一条，但必须每一环都有实测：
 *   ① 方案导入成功（解析、校验都过）—— 所以不是"导入失败"；
 *   ② 生成的 CSS 选择器是 `.tcs-hl-placeholder.char`（未转义的点号）；
 *   ③ 元素上的 class 是单个类名 `tcs-hl-placeholder.char`；
 *   ④ CSS 选择器 `.a.b` 的语义是「同时有 a 和 b 两个类」→ 匹配不上 → computed color 仍是默认色；
 *   ⑤ 换成不带点号的 id 后，同一个元素立刻着色。
 *
 * 判据用 computed color 而不是"看起来有没有颜色"：截图会说谎（深色主题下相近色、
 * 抗锯齿都会让人误判），而 computed style 是浏览器实际求值结果。
 *
 * 用法：node scripts/verify-highlight-live.mjs [原版路径] [修正版路径]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPresets, parseStCard } from '../shared/dist/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'rules');
const PORT = 9333;
const BEFORE_PATH = process.argv[2] ?? 'D:/Desktop/通用高亮配置.json';
const AFTER_PATH = process.argv[3] ?? join(OUT, 'fixed-highlight.json');

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
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(String(e.data));
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
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(method + ' 超时'));
        }
      }, 25000);
    });
  }
  on(m, fn) {
    if (!this.handlers.has(m)) this.handlers.set(m, []);
    this.handlers.get(m).push(fn);
  }
  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const beforeText = readFileSync(BEFORE_PATH, 'utf8');
  const afterText = readFileSync(AFTER_PATH, 'utf8');

  const card = parseStCard(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8'))).card;
  const preset = loadPresets([JSON.parse(readFileSync(join(REPO, 'rules', 'presets', 'default.json'), 'utf8'))]).presets[0];
  void preset;

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到 8899 页面');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  };

  const shot = async (name, selector) => {
    const clip = await evaluate(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    const params = { format: 'png' };
    if (clip && clip.width > 10 && clip.height > 10) params.clip = { ...clip, scale: 1 };
    const r = await cdp.send('Page.captureScreenshot', params);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };

  // 干净加载 + 注入样例卡（浏览器里打不开本地文件）
  await evaluate(`(() => {
    const app = window.__tcs?.app;
    if (app && Array.isArray(app.sessions)) for (const s of app.sessions) s.markSaved(null);
    return true;
  })()`).catch(() => {});
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);
  for (let i = 0; i < 60; i += 1) {
    if (await evaluate(`(() => { const s = document.querySelector('#status'); return !!s && !s.textContent.includes('初始化'); })()`)) break;
    await sleep(200);
  }

  await evaluate(`document.querySelector('#btn-new').click()`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`)) break;
    await sleep(100);
  }
  await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = '高亮实测';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'hl-live-001';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    return true;
  })()`);
  await sleep(500);

  // 注入样例卡（含 {{char}} / {{user}} / 中文引号对话）。
  // 注意：replaceCard 只改会话数据，编辑器不会自己重建 —— 必须再调
  // reloadBlocksFromCard()，否则 .cm-content 是空的，页面上一个高亮 span 都不会有
  // （第一次跑就踩了：tcs-hl 数量 0，看起来像"高亮完全没反应"，其实是文本没进编辑器）。
  await evaluate(`(() => {
    const app = window.__tcs?.app;
    app.sessions[0].replaceCard(${JSON.stringify(card)});
    app.reloadBlocksFromCard();
    app.validate();
    return true;
  })()`);
  await sleep(900);
  await evaluate(`(() => {
    for (const head of document.querySelectorAll('.block .block-head')) {
      if (!head.closest('.block')?.classList.contains('expanded')) head.click();
    }
    return true;
  })()`);
  await sleep(1200);

  /** 读占位符 span 的 class 与计算色值 */
  const probeSpans = () => evaluate(`(() => {
    const spans = [...document.querySelectorAll('.tcs-hl')];
    const placeholder = spans.find((s) => s.className.includes('placeholder'));
    const style = document.querySelector('#tcs-scheme-style');
    const scopeRule = style ? (style.textContent || '').split('\\n').find((l) => l.includes('placeholder-char') || l.includes('placeholder.char')) : null;
    return {
      spanCount: spans.length,
      placeholder: placeholder ? {
        className: placeholder.className,
        text: placeholder.textContent,
        color: getComputedStyle(placeholder).color,
        fontWeight: getComputedStyle(placeholder).fontWeight,
      } : null,
      styleNodeExists: !!style,
      styleScopeRule: scopeRule ?? null,
      styleHead: style ? (style.textContent || '').split('\\n').slice(0, 3) : [],
      bodyBg: getComputedStyle(document.documentElement).getPropertyValue('--tcs-bg').trim(),
      bodyFg: getComputedStyle(document.documentElement).getPropertyValue('--tcs-fg').trim(),
    };
  })()`);

  // ── ① 导入原版：v0.1.2 起应当被**拒绝** ─────────────────
  //
  // 行为在 v0.1.2 变了：以前是"导入成功但完全不上色"（点号让 CSS 选择器
  // 永不匹配），现在是校验阶段直接拒绝并给出改名建议（决策 #43）。
  // 所以这里的断言从"导入成功、但没上色"改成"导入失败、且当前方案不受影响"。
  const importBefore = await evaluate(`(async () => {
    const app = window.__tcs?.app;
    const currentIdBefore = app.rules?.highlightId ?? null;
    const outcome = app.importHighlightText(${JSON.stringify(beforeText)});
    await new Promise((r) => setTimeout(r, 400));
    return {
      ok: !!outcome.ok,
      id: outcome.id ?? null,
      issues: (outcome.issues ?? []).map((i) => String(i.message ?? i)),
      currentIdBefore,
      currentIdAfter: app.rules?.highlightId ?? null,
      families: (app.rules?.highlightFiles ?? []).map((f) => f.id),
    };
  })()`);

  check('① 原版被拒绝（含点号的 scope id）', importBefore.ok === false, `ok=${String(importBefore.ok)}`);
  const dotIssue = (importBefore.issues ?? []).find((m) => m.includes('不能包含 .'));
  check('① 错误消息指明「scope id 不能包含 .」', !!dotIssue, JSON.stringify(importBefore.issues.slice(0, 2)));
  check('① 错误消息给出改名建议（点号换连字符）', !!dotIssue && /placeholder-char/.test(dotIssue),
    dotIssue ?? '(无)');
  check('① 被拒绝后当前方案不变（不留半成品）', importBefore.currentIdAfter === importBefore.currentIdBefore,
    `${importBefore.currentIdBefore} → ${importBefore.currentIdAfter}`);
  check('① 被拒绝的方案没有进入方案列表', !importBefore.families.includes('universal-highlight'),
    JSON.stringify(importBefore.families));

  await shot('hl-before', '#block-list');

  // ── ⑤ 导入修正版：应当成功并真正上色 ────────────────────
  const importAfter = await evaluate(`(async () => {
    const app = window.__tcs?.app;
    const outcome = app.importHighlightText(${JSON.stringify(afterText)});
    await new Promise((r) => setTimeout(r, 500));
    return { ok: !!outcome.ok, id: outcome.id ?? null, issues: (outcome.issues ?? []).map((i) => String(i.message ?? i)) };
  })()`);
  check('⑤ 修正版导入成功（9 个 scope 全部无点号）', importAfter.ok === true,
    `id=${importAfter.id} issues=${importAfter.issues.length}`);
  await sleep(800);

  const after = await probeSpans();
  check('⑤ 修正版选择器无点号', /\.tcs-hl-placeholder-char\s*\{/.test((after.styleHead ?? []).join('\n') + (after.styleScopeRule ?? '')),
    JSON.stringify(after.styleScopeRule));
  check('⑤ 元素 class 变成无点号形式', !!after.placeholder && after.placeholder.className.includes('tcs-hl-placeholder-char'),
    after.placeholder?.className ?? '(无占位符 span)');
  check('⑤ computed color = #4EC9B0（rgb(78, 201, 176)）—— 真正上色了',
    !!after.placeholder && after.placeholder.color === 'rgb(78, 201, 176)',
    after.placeholder?.color ?? '-');
  check('⑤ 加粗也生效（font-weight 600）',
    !!after.placeholder && (after.placeholder.fontWeight === '600' || after.placeholder.fontWeight === 'bold'),
    after.placeholder?.fontWeight ?? '-');
  await shot('hl-after', '#block-list');

  writeFileSync(join(OUT, 'highlight-live.json'), `${JSON.stringify({ at: new Date().toISOString(), importBefore, importAfter, after, results }, null, 2)}\n`, 'utf8');

  cdp.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
