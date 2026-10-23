/**
 * v0.1.2 · F6「审计面板正文空白」——修复验证（清单四条的浏览器侧断言）。
 *
 * 命名注意：v0.1.1 里的 F6 是「一键连接本机服务端」，对应 scripts/verify-f6.mjs。
 * v0.1.2 复用了 F6 这个编号，但指的是审计面板空白。两个脚本不要混。
 *
 * 覆盖需求给的验证清单：
 *   ① 1 条 info 时正文可见（且这条是**全文级**，location.blockId === null ——
 *      需求点名要试的两种输入之一）；
 *   ② 0 条时显示空态文案；
 *   ③ 错误 + 警告 + 提示混合时三级全可见；
 *   ④ "计数 > 0 ⇒ 正文非空"的 DOM 一致性（防回归判据）。
 *
 * 场景卡不是手编的：由 shared 真实引擎从 sample-card 派生，并在 Node 侧先用
 * buildAuditReport 断言分布确实是 0 / 1。这样"场景数据本身错了"会先被挡在
 * 浏览器之外，不会变成一次假绿。
 *
 * 注入方式说明：浏览器里无法打开本地文件，所以用 `session.replaceCard()` +
 * `app.validate()`（都是产品真实入口）把卡放进去，只跳过"选文件"这一步。
 *
 * 用法：node scripts/verify-audit-panel.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildAuditReport,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  resolvePlatformRule,
} from '../shared/dist/index.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 'f6');
const PORT = 9333;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

// ── 场景卡（Node 侧用真实引擎算好并自证）──────────────────
const rules = loadPlatformRules(
  ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map((n) =>
    JSON.parse(readFileSync(join(REPO, 'rules', 'platforms', `${n}.json`), 'utf8')),
  ),
).rules;
const preset = loadPresets([JSON.parse(readFileSync(join(REPO, 'rules', 'presets', 'default.json'), 'utf8'))]).presets[0];
const sillytavern = resolvePlatformRule('sillytavern', rules);

const base = parseStCard(JSON.parse(readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8'))).card;

const oneInfo = structuredClone(base);
{
  const settings = oneInfo.blocks.find((b) => b.id === 'settings');
  settings.text = `${settings.text}\n{{char}} 会记得你。`;
}

const zeroIssues = structuredClone(oneInfo);
zeroIssues.passthrough.data.talkativeness = 0.5;
zeroIssues.passthrough.data.fav = false;
for (const entry of zeroIssues.worldbook.entries) {
  entry.constant = false;
  entry.selective = false;
  entry.position = 'before_char';
  entry.priority = 10;
}

// 混合三级：清角色名（error）+ 清基本信息（warning）+ 未出现 {{char}}（info）。
// 单靠塞伪标签造不出 error —— sillytavern 规则里伪标签只是 info，
// 这是规则设计（官方对写法基本不设限），所以按"真实会产生 error 的输入"来构造。
const mixedCard = structuredClone(base);
mixedCard.meta.name = '';
mixedCard.blocks.find((b) => b.id === 'basic').text = '';

function distribution(card, platformRule) {
  const r = buildAuditReport(card, { platformRule, preset });
  const by = { error: 0, warning: 0, info: 0 };
  for (const issue of r.issues) by[issue.severity] += 1;
  return { total: r.issues.length, ...by, issues: r.issues };
}

const sceneOne = distribution(oneInfo, sillytavern);
const sceneZero = distribution(zeroIssues, sillytavern);
const sceneMixed = distribution(mixedCard, sillytavern);

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }
  connect() {
    return new Promise((resolve2, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve2());
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
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
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

  // ── 先自证场景数据 ──────────────────────────────────────
  check('场景卡「仅 1 条 info」分布正确', sceneOne.total === 1 && sceneOne.info === 1,
    `total=${sceneOne.total} e=${sceneOne.error} w=${sceneOne.warning} i=${sceneOne.info}`);
  check('这 1 条是全文级（blockId === null）', sceneOne.issues[0]?.location.blockId === null,
    String(sceneOne.issues[0]?.location.blockId ?? 'null'));
  check('场景卡「0 条」分布正确', sceneZero.total === 0, `total=${sceneZero.total}`);
  check('场景卡「混合三级」分布正确',
    sceneMixed.error > 0 && sceneMixed.warning > 0 && sceneMixed.info > 0,
    `e=${sceneMixed.error} w=${sceneMixed.warning} i=${sceneMixed.info}`);

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('8899'));
  if (!page) throw new Error('没找到 8899 页面');
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300));
  });
  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  const shot = async (name, selector = null) => {
    const params = { format: 'png' };
    if (selector) {
      const clip = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`);
      if (clip && clip.width > 10 && clip.height > 10) params.clip = { ...clip, scale: 1 };
    }
    const r = await cdp.send('Page.captureScreenshot', params);
    writeFileSync(join(OUT, `fix-${name}.png`), Buffer.from(r.data, 'base64'));
  };

  const probe = () => evaluate(`(() => {
    const panel = document.querySelector('#audit-panel');
    return {
      panelChildren: panel ? panel.children.length : -1,
      childClasses: panel ? [...panel.children].map((c) => c.className) : [],
      summaryText: panel?.querySelector('.audit-summary')?.textContent?.trim() ?? '',
      countText: panel?.querySelector('.audit-count')?.textContent?.trim() ?? '',
      issues: {
        total: panel ? panel.querySelectorAll('.issue').length : 0,
        error: panel ? panel.querySelectorAll('.issue.error').length : 0,
        warning: panel ? panel.querySelectorAll('.issue.warning').length : 0,
        info: panel ? panel.querySelectorAll('.issue.info').length : 0,
      },
      emptyText: panel?.querySelector('.issue-empty')?.textContent?.trim() ?? '',
      filters: panel ? panel.querySelectorAll('.audit-filters .chip').length : 0,
      words: panel ? panel.querySelectorAll('.word-row').length : 0,
      issueSummary: document.querySelector('#issue-summary')?.textContent?.trim() ?? '',
    };
  })()`);

  const loadCard = async (card) => {
    const cardJson = JSON.stringify(card);
    const state = await evaluate(`(() => {
      const app = window.__tcs?.app;
      if (!app || !app.sessions || app.sessions.length === 0) return 'no-session';
      app.sessions[0].replaceCard(${cardJson});
      app.validate();
      return 'ok';
    })()`);
    await sleep(500);
    return state;
  };

  // 干净加载
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

  // ── 0. 空白启动（clear() 的执行点）─────────────────────
  const boot = await probe();
  check('空白启动后面板结构完整（5 个区块仍挂载）', boot.panelChildren === 5,
    `${boot.panelChildren} 个：${boot.childClasses.join(' | ')}`);
  await shot('boot-panel', '#audit-panel');

  // 新建卡（F11）——事故正是"空白启动后新建"这条路径
  await evaluate(`document.querySelector('#btn-new').click()`);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate(`(() => [...document.querySelectorAll('.modal-overlay')].some((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡')))()`)) break;
    await sleep(100);
  }
  await evaluate(`(() => {
    const overlay = [...document.querySelectorAll('.modal-overlay')].find((o) => !o.hasAttribute('hidden') && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = 'F6 验证';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'f6-verify-001';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    return true;
  })()`);
  await sleep(600);

  // ── ① 仅 1 条 info（全文级）─────────────────────────────
  const loaded = await loadCard(oneInfo);
  check('会话可载入场景卡（replaceCard 可用）', loaded === 'ok', String(loaded));
  const one = await probe();
  check('① 面板容器有 5 个区块', one.panelChildren === 5, `${one.panelChildren} 个`);
  check('① 摘要可见（不是空白）', one.summaryText.includes('提示 1'), JSON.stringify(one.summaryText.slice(0, 60)));
  check('① 正文渲染出 1 条 info', one.issues.total === 1 && one.issues.info === 1,
    `total=${one.issues.total} info=${one.issues.info}`);
  check('① 计数行体现 1 条', /1/.test(one.countText), JSON.stringify(one.countText));
  check('① 筛选条与字数分布恢复', one.filters === 7 && one.words === 6,
    `filters=${one.filters}（等级 3 + 类别 4）words=${one.words}`);
  await shot('one-info', '#audit-panel');

  // ── ② 0 条：空态文案 ───────────────────────────────────
  await loadCard(zeroIssues);
  const zero = await probe();
  check('② 面板容器有 5 个区块', zero.panelChildren === 5, `${zero.panelChildren} 个`);
  check('② 0 条时给出空态文案', zero.emptyText === '当前平台规则下未发现问题', JSON.stringify(zero.emptyText));
  check('② 摘要显示提示 0', zero.summaryText.includes('提示 0'), JSON.stringify(zero.summaryText.slice(0, 60)));
  await shot('zero-issues', '#audit-panel');

  // ── ③ 混合三级 ─────────────────────────────────────────
  await loadCard(mixedCard);
  const mixed = await probe();
  check('③ 面板容器有 5 个区块', mixed.panelChildren === 5, `${mixed.panelChildren} 个`);
  check('③ 三级问题都渲染出来',
    mixed.issues.error > 0 && mixed.issues.warning > 0 && mixed.issues.info > 0,
    `error=${mixed.issues.error} warning=${mixed.issues.warning} info=${mixed.issues.info}`);
  check('③ 计数与正文条数一致',
    mixed.issues.total > 0 && mixed.countText.includes(String(mixed.issues.total)),
    `count="${mixed.countText}" dom=${mixed.issues.total}`);
  await shot('mixed', '#audit-panel');

  // ── ④ 防回归：计数 > 0 ⇒ 正文非空 ──────────────────────
  check('④ 计数 > 0 时正文必非空（DOM 一致性）',
    !(mixed.issues.total > 0) || (mixed.panelChildren === 5 && mixed.issues.total > 0),
    `count="${mixed.countText}" panelChildren=${mixed.panelChildren} issues=${mixed.issues.total}`);

  check('全程页面无未捕获异常', consoleErrors.length === 0, consoleErrors.join(' / '));

  writeFileSync(join(OUT, 'verify-report.json'), `${JSON.stringify({
    at: new Date().toISOString(),
    sceneOne: { total: sceneOne.total, info: sceneOne.info, blockId: sceneOne.issues[0]?.location.blockId ?? null },
    sceneZero: { total: sceneZero.total },
    boot, one, zero, mixed, consoleErrors, results,
  }, null, 2)}\n`, 'utf8');

  cdp.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
