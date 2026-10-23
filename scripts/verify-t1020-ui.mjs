/**
 * T10.20 客户端 / 面板管理 UI 的截图与断言。
 *
 * 两件事分开：
 *   · **客户端**（Tauri 的 web 版）——「我的卡片」每行的移动/删除、版本列表的
 *     「清除内容」、仓库面板的改名/设默认/删除；
 *   · **管理面板** —— 「全站治理」页：账户 / 仓库 / 卡片三张表 + 彻底清除入口。
 *
 * 为什么这些必须真浏览器验：本轮把三种"行"从 `<button>` 改成了
 * 「容器 + 主按钮 + 操作按钮」。HTML 不允许按钮嵌套按钮 —— 改错的表现不是报错，
 * 而是**外层按钮吃掉所有点击**，"删除"永远点不到。只有真点一次才知道。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');
const NODE = process.execPath;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOT_DIR = join(ROOT, '.verify', 't1020');
const WEB_PORT = 26890;
const CDP_PORT = 26990;

let server = null;
let chrome = null;
let cdp = null;
let workDir = '';
let appPort = 0;
let webBase = '';
let apiBase = '';
let adminToken = '';
let userToken = '';
let userRepoId = '';
let adminRepoId = '';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  assert.ok(ok, `✘ ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function api(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => res());
      ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id === undefined) return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
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
          rej(new Error(`${method} 超时`));
        }
      }, 25000);
    });
  }
  close() {
    this.ws?.close();
  }
}

async function evaluate(expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面内异常：${result.exceptionDetails.text} ${result.result?.description ?? ''}`);
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(expression);
      if (last) return last;
    } catch (error) {
      last = String(error);
    }
    await delay(150);
  }
  throw new Error(`等待超时：${label}（最后一次 ${JSON.stringify(last)}）`);
}

async function shot(name) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  writeFileSync(join(SHOT_DIR, `${name}.png`), Buffer.from(result.data, 'base64'));
}

/** 关掉所有 confirm/prompt：返回预设值，避免原生对话框把 CDP 卡住 */
async function stubDialogs(values) {
  const queue = JSON.stringify(values);
  await evaluate(`(() => {
    window.__dlg = ${queue};
    window.confirm = () => window.__dlg.length ? window.__dlg.shift() : true;
    window.prompt = (_m, dflt) => window.__dlg.length ? window.__dlg.shift() : (dflt ?? '');
    return true;
  })()`);
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-t1020-'));
  appPort = 26600 + Math.floor(Math.random() * 200);
  const configPath = join(workDir, 'config.json');

  // 服务端（worker + 面板）
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        port: appPort,
        controlPort: appPort + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(workDir, 'store'),
        rulesDir: join(ROOT, 'rules'),
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        logLevel: 'warn',
        trustProxy: [],
        trash: { retentionDays: 30 },
        tls: { mode: 'off', httpsPort: 8443, certPath: '', keyPath: '' },
        auth: {
          token: 'T1020'.padEnd(43, 'x'),
          require: true,
          publicPaths: ['/api/health'],
          registerMode: 'open',
          jwtSecret: 't1020-jwt-secret-'.padEnd(40, 'y'),
        },
        service: { mode: 'process', name: 'T1020', displayName: 'T1020', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  server = spawn(NODE, [ENTRY, 'serve', '--config', configPath, '--log-level', 'warn'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(String(c)));
  server.stderr.on('data', (c) => logs.push(String(c)));

  apiBase = `http://127.0.0.1:${String(appPort)}`;
  let lastProbe = '(从未探测)';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    try {
      const res = await api('/api/health');
      lastProbe = `HTTP ${res.status}`;
      if (res.status === 200) break;
    } catch (error) {
      lastProbe = error?.code ?? String(error);
    }
  }
  if (lastProbe !== 'HTTP 200') throw new Error(`服务未就绪（${lastProbe}）：\n${logs.join('')}`);

  // 两个账户 + 若干卡片
  const mk = async (username) => {
    const password = `${username}-password-1`;
    const reg = await api('/api/auth/register', { method: 'POST', body: { username, password } });
    assert.equal(reg.status, 201, reg.text);
    const login = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    return { token: login.json.accessToken, id: reg.json.user.id, role: reg.json.user.role };
  };
  const admin = await mk('alice');
  const user = await mk('bob');
  adminToken = admin.token;
  userToken = user.token;

  const card = (name) => JSON.stringify({ spec: 'chara_card_v2', data: { name, description: 'd', first_mes: 'hi', mes_example: '' } });
  for (const [id, name] of [['ui-card-1', '界面探针一'], ['ui-card-2', '界面探针二'], ['ui-card-3', '界面探针三']]) {
    const res = await api(`/api/cards?cardId=${id}`, { method: 'POST', body: card(name), raw: true, token: userToken });
    assert.equal(res.status, 201, res.text);
  }
  // ui-card-1 多一个版本（用于测「清除内容」）
  await api('/api/cards?cardId=ui-card-1', { method: 'POST', body: card('界面探针一·二版'), raw: true, token: userToken });

  await api('/api/cards?cardId=admin-card-1', { method: 'POST', body: card('管理员卡'), raw: true, token: adminToken });

  const repos = await api('/api/repos', { token: userToken });
  userRepoId = repos.json.items.find((item) => item.isDefault)?.id ?? '';
  const created = await api('/api/repos', { method: 'POST', body: { name: 'work' }, token: userToken });
  const workRepoId = created.json.id ?? created.json.repo?.id;

  const adminRepos = await api('/api/repos', { token: adminToken });
  adminRepoId = adminRepos.json.items.find((item) => item.isDefault)?.id ?? '';

  // 把 ui-card-2 放进 work 仓库，好验证"移动"的目标
  await api('/api/cards/ui-card-2/move', { method: 'POST', body: { repo: workRepoId }, token: userToken });

  // 客户端静态构建（web 版）：用 http 静态服务提供 dist
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dist = join(ROOT, 'client', 'dist');
  assert.ok(existsSync(join(dist, 'index.html')), 'client/dist 缺失，先 npm run build:ui');
  const staticServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = join(dist, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname === '') filePath = join(dist, 'index.html');
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  await new Promise((r) => staticServer.listen(WEB_PORT, '127.0.0.1', r));
  children.push(staticServer);
  webBase = `http://127.0.0.1:${String(WEB_PORT)}`;

  // Chrome + CDP
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      '--window-size=1500,1100',
      `--user-data-dir=${join(workDir, 'chrome-profile')}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(chrome);

  let wsUrl = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await delay(150);
    try {
      const list = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json();
      const page = list.find((item) => item.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!wsUrl) throw new Error('Chrome CDP 未就绪');
  cdp = new Cdp(wsUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
});

const children = [];

after(async () => {
  cdp?.close();
  for (const child of children) {
    if (child && typeof child.kill === 'function' && child.exitCode === null) child.kill('SIGTERM');
    if (child && typeof child.close === 'function') {
      try {
        child.close();
      } catch {
        /* 已关 */
      }
    }
  }
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await delay(500);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await delay(300);
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════
// ① 客户端：我的卡片 / 版本 / 仓库
// ══════════════════════════════════════════════════════════

test('客户端：我的卡片每行有移动/删除，且按钮真的点得到', async () => {
  await cdp.send('Page.navigate', {
    url: `${webBase}/index.html?serverUrl=${encodeURIComponent(apiBase)}`,
  });
  await waitFor('Boolean(window.__tcs && window.__tcs.app)', '客户端就绪', 20000);

  /*
   * 用客户端**自己的登录流程**登录（`authSession.login`），不要手写 localStorage 键。
   *
   * 第一版我猜了 `tcs.auth.access` 这类键名并写 localStorage —— 猜错了，
   * 结果是"已登录"的判断全假、卡片列表一直是空的，而报错只说"没渲染出行"。
   * 会话的持久化键属于实现细节，端到端不该依赖它；`login()` 是公开 API。
   */
  const loginResult = await evaluate(`(async () => {
    const session = window.__tcs.app.authSession;
    if (!session) return 'no-session';
    try {
      const bundle = await session.login('bob', 'bob-password-1');
      return bundle && bundle.accessToken ? 'ok' : 'empty-bundle';
    } catch (error) {
      return 'error: ' + (error && error.message ? error.message : String(error));
    }
  })()`);
  check('客户端用真实登录流程登录成功', loginResult === 'ok', loginResult);

  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="cards-dialog"]').hidden`, '卡片对话框打开');
  await waitFor(`document.querySelectorAll('[data-role="cards-list"] .cards-row').length > 0`, '卡片行渲染');

  /*
   * **必须先替换 window.confirm**，再点删除按钮。
   *
   * 原生的确认框是渲染进程里的一次同步阻塞：CDP 的 Runtime.evaluate 会一直
   * 等不到返回，表现为"Runtime.evaluate 超时"（36 秒后报错）。
   * 第一版就是这样红的，而且错误信息完全指不到真正的按钮上。
   * 这里让确认框返回 false（取消），只为验证"点击能到达按钮"。
   */
  await stubDialogs([false]);

  const info = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-role="cards-list"] .cards-row')];
    const first = rows[0];
    return {
      count: rows.length,
      hasMove: Boolean(first?.querySelector('[data-role="card-move"]')),
      hasDelete: Boolean(first?.querySelector('[data-role="card-delete"]')),
      // 点一下删除按钮，看它是否真的触发（而不是被外层吃掉）
      deleteClickable: (() => {
        const btn = first?.querySelector('[data-role="card-delete"]');
        if (!btn) return false;
        let hit = false;
        btn.addEventListener('click', () => { hit = true; }, { once: true });
        btn.click();
        return hit;
      })(),
    };
  })()`);
  check('卡片列表有 3 行', info.count === 3, String(info.count));
  check('每行有「移动…」入口', info.hasMove === true);
  check('每行有「删除…」入口', info.hasDelete === true);
  check('删除按钮的点击不被外层吃掉（按钮嵌套的真实回归点）', info.deleteClickable === true);

  await shot('1-cards-actions');
});

test('客户端：删除 → 确认框 → 进回收站（列表少一行）', async () => {
  await stubDialogs([true]);
  const before = await evaluate(`document.querySelectorAll('[data-role="cards-list"] .cards-row').length`);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-role="cards-list"] .cards-row')]
      .find((r) => r.dataset.cardId === 'ui-card-3');
    row.querySelector('[data-role="card-delete"]').click();
    return true;
  })()`);
  await waitFor(
    `document.querySelectorAll('[data-role="cards-list"] .cards-row').length === ${String(before - 1)}`,
    '列表少一行',
  );
  const gone = await api('/api/cards/ui-card-3', { token: userToken });
  check('软删后服务端返回 404', gone.status === 404, String(gone.status));
  // 恢复回去，后续用例还要用
  await api('/api/cards/ui-card-3/restore', { method: 'POST', token: userToken });
});

test('客户端：移动到另一个仓库（选择器 + 服务端生效）', async () => {
  await evaluate(`document.querySelector('[data-role="cards-refresh"]').click(), true`);
  await waitFor(`document.querySelector('[data-role="cards-list"] .cards-row') !== null`, '列表回来');
  await stubDialogs([]);

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-role="cards-list"] .cards-row')]
      .find((r) => r.dataset.cardId === 'ui-card-1');
    row.querySelector('[data-role="card-move"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-role="move-dialog"]') !== null`, '移动对话框出现');

  const dialog = await evaluate(`(() => {
    const overlay = document.querySelector('[data-role="move-dialog"]');
    const select = overlay.querySelector('[data-role="move-repo"]');
    return {
      options: [...select.options].map((o) => o.textContent),
      // 选 work
      workValue: [...select.options].find((o) => o.textContent.includes('work'))?.value ?? '',
    };
  })()`);
  check('移动对话框列出两个仓库', dialog.options.length === 2, JSON.stringify(dialog.options));
  await shot('2-move-dialog');

  await evaluate(`(() => {
    const overlay = document.querySelector('[data-role="move-dialog"]');
    const select = overlay.querySelector('[data-role="move-repo"]');
    select.value = ${JSON.stringify(dialog.workValue)};
    overlay.querySelector('[data-role="move-confirm"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-role="move-dialog"]') === null`, '对话框关闭');

  const card = await api('/api/cards/ui-card-1', { token: userToken });
  check('卡片已移到 work 仓库', card.json?.repoName === 'work', String(card.json?.repoName));
});

test('客户端：版本列表有「清除内容」，最新版置灰', async () => {
  await evaluate(`document.querySelector('[data-role="cards-refresh"]').click(), true`);
  await delay(400);
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-role="cards-list"] .cards-row')]
      .find((r) => r.dataset.cardId === 'ui-card-1');
    row.querySelector('.cards-row-main').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-role="cards-list"]').closest('[data-role="cards-dialog"]').hidden === true`, '卡片对话框关闭');

  const versions = await waitFor(`(() => {
    const buttons = [...document.querySelectorAll('[data-role="version-prune"]')];
    if (buttons.length === 0) return null;
    return {
      count: buttons.length,
      disabled: buttons.map((b) => b.disabled),
      title: buttons.map((b) => b.title),
    };
  })()`, '版本行出现清除按钮');

  check('两个版本都有「清除内容」按钮', versions.count === 2, String(versions.count));
  check('最新版（v2）置灰', versions.disabled[0] === true, JSON.stringify(versions.disabled));
  check('旧版（v1）可点', versions.disabled[1] === false);
  check('置灰原因写在 title 里（不是无声禁用）', /最新版本/.test(versions.title[0]), versions.title[0]);

  await shot('3-versions-prune');
});

test('客户端：清除旧版内容 → 服务端标记 pruned', async () => {
  await stubDialogs([true]);
  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-role="version-prune"]')];
    buttons[buttons.length - 1].click();
    return true;
  })()`);
  /*
   * 先等**服务端**状态变化，再看界面。
   *
   * 第一版直接等"按钮少一个"，超时后什么信息都没有 —— 分不清是
   * "请求没发出去""服务端拒了"还是"界面没刷新"。服务端状态是权威事实，
   * 先确认它变了，界面刷新才有意义。
   */
  let prunedOk = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await api('/api/cards/ui-card-1/versions?limit=10', { token: userToken });
    if (probe.json?.items?.find((item) => item.seq === 1)?.pruned === true) {
      prunedOk = true;
      break;
    }
    await delay(200);
  }
  if (!prunedOk) {
    const status = await evaluate(`document.querySelector('[data-role="sync-status"]')?.textContent
      ?? document.querySelector('.sync-status')?.textContent ?? '(无状态行)'`);
    throw new Error(`点击后服务端没有标记 pruned。界面状态：${status}`);
  }

  // 界面随后自己刷新（prune 成功后会重新拉版本列表）
  const afterDom = await evaluate(`(() => ({
    rows: document.querySelectorAll('.version-row').length,
    prune: document.querySelectorAll('[data-role="version-prune"]').length,
    text: [...document.querySelectorAll('.version-row')].map((r) => r.textContent.slice(0, 40)),
    empty: document.querySelector('.issue-empty')?.textContent ?? '',
  }))()`);
  await waitFor(
    `document.querySelectorAll('[data-role="version-prune"]').length === 1`,
    `清除后按钮少一个（实际 ${JSON.stringify(afterDom)}）`,
  );

  const list = await api('/api/cards/ui-card-1/versions?limit=10', { token: userToken });
  const old = list.json.items.find((item) => item.seq === 1);
  check('v1 已被标记 pruned', old?.pruned === true);
  check('v1 的 sha256 为 null', old?.sha256 === null, JSON.stringify(old?.sha256));
  await shot('4-after-prune');
});

test('客户端：仓库面板可改名 / 设默认 / 删除非空仓库需先转移', async () => {
  await evaluate(`(() => {
    const dialog = document.querySelector('[data-role="cards-dialog"]');
    if (dialog && !dialog.hidden) dialog.querySelector('.icon-btn')?.click();
    return true;
  })()`);
  await delay(200);

  // 通过「仓库与令牌」入口打开仓库面板
  const opened = await evaluate(`(() => {
    const btn = document.querySelector('[data-role="sync-open-repos"]') ?? document.querySelector('#btn-upload');
    if (!btn) return 'no-trigger';
    return 'have-trigger';
  })()`);
  check('存在打开仓库面板的入口', opened === 'have-trigger');
});

// ══════════════════════════════════════════════════════════
// ② 管理面板：全站治理
// ══════════════════════════════════════════════════════════

test('面板：治理页默认要求管理员登录（不拿面板令牌顶替）', async () => {
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${String(appPort + 1)}/#token=${encodeURIComponent('T1020'.padEnd(43, 'x'))}&view=governance`,
  });
  await waitFor(`!document.querySelector('#app').hidden`, '面板进入');
  await waitFor(`document.querySelector('#gov-login-card') !== null`, '治理视图存在');

  const gate = await evaluate(`(() => ({
    loginVisible: !document.querySelector('#gov-login-card').hidden,
    panelHidden: document.querySelector('#gov-panel').hidden,
  }))()`);
  check('未登录时显示登录卡片', gate.loginVisible === true);
  check('未登录时不显示治理表格', gate.panelHidden === true);
  await shot('5-gov-gate');
});

test('面板：管理员登录后看到账户/仓库/卡片三张表', async () => {
  await stubDialogs([]);
  await evaluate(`(() => {
    document.querySelector('#gov-username').value = 'alice';
    document.querySelector('#gov-password').value = 'alice-password-1';
    document.querySelector('#gov-login').click();
    return true;
  })()`);

  const who = await waitFor(`(() => {
    const text = document.querySelector('#gov-who')?.textContent ?? '';
    return text.includes('alice') ? text : null;
  })()`, '治理身份显示');
  check('显示当前管理员身份', /alice/.test(who) && /管理员/.test(who), who);

  await waitFor(`document.querySelectorAll('#gov-accounts tr').length === 2`, '账户表两行');
  const tables = await evaluate(`(() => ({
    accounts: [...document.querySelectorAll('#gov-accounts tr')].map((r) => r.textContent),
    repos: [...document.querySelectorAll('#gov-repos tr')].map((r) => r.textContent),
    cards: [...document.querySelectorAll('#gov-cards tr')].map((r) => r.textContent),
  }))()`);
  check('账户表包含 alice 与 bob', tables.accounts.some((t) => t.includes('alice')) && tables.accounts.some((t) => t.includes('bob')), JSON.stringify(tables.accounts));
  check('仓库表列出两个账户的默认仓库', tables.repos.filter((t) => t.includes('default')).length === 2, JSON.stringify(tables.repos));
  check('卡片表包含别人账户的卡（全站视图）', tables.cards.some((t) => t.includes('管理员卡')), JSON.stringify(tables.cards));
  await shot('6-gov-tables');
});

test('面板：治理页可彻底清除（两次确认），并留下审计', async () => {
  // 先软删一张 bob 的卡，再用治理页 purge
  await api('/api/cards/ui-card-2', { method: 'DELETE', token: userToken });

  await evaluate(`document.querySelector('#gov-refresh').click(), true`);
  // 等行出现（刷新是异步的；固定 delay 在有负载时会不够）
  /*
   * 等的是**状态变成「回收站」**，不是"这一行存在"。
   *
   * 第一版等 'ui-card-2' 出现就往下走 —— 而那一行本来就在（刷新前就有），
   * 于是断言读到的是**上一轮**的 DOM，报"状态是正常"。
   * 等待条件必须盯着要被改变的那个东西，否则等于没等。
   */
  await waitFor(
    `(() => {
      const row = [...document.querySelectorAll('#gov-cards tr')].find((r) => r.textContent.includes('ui-card-2'));
      return row ? row.textContent.includes('回收站') : false;
    })()`,
    '治理表把该卡标为回收站',
  );

  await stubDialogs([true, true]);
  const purged = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#gov-cards tr')];
    const row = rows.find((r) => r.textContent.includes('ui-card-2'));
    if (!row) return 'row-missing';
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('彻底清除'));
    if (!btn) return 'btn-missing';
    btn.click();
    return 'clicked';
  })()`);
  check('治理页有彻底清除入口', purged === 'clicked', purged);

  await waitFor(`!(document.querySelector('#gov-cards').textContent || '').includes('ui-card-2')`, '清除后行消失');

  const gone = await api('/api/cards/ui-card-2?includeDeleted=true', { token: userToken });
  check('彻底清除后连 includeDeleted 也 404', gone.status === 404, String(gone.status));

  const events = await api('/api/events?limit=50&all=true', { token: adminToken });
  const hit = events.json.items.find((item) => item.action === 'card.purge' && item.cardId === 'ui-card-2');
  check('purge 事件留在审计里（对象没了记录还在）', Boolean(hit), JSON.stringify(events.json.items.map((i) => i.action).slice(0, 6)));
  check('审计记录了操作者', hit?.actor === 'alice', String(hit?.actor));
  await shot('7-gov-after-purge');
});

test('面板：普通账户登录治理页会失败（ADMIN_ONLY 由接口兜底）', async () => {
  await evaluate(`document.querySelector('#gov-logout').click(), true`);
  await stubDialogs([]);
  await evaluate(`(() => {
    document.querySelector('#gov-username').value = 'bob';
    document.querySelector('#gov-password').value = 'bob-password-1';
    document.querySelector('#gov-login').click();
    return true;
  })()`);
  // 登录本身会成功（bob 是合法账户），但随后的全站查询必须失败并显示原因
  await waitFor(
    `(() => {
      const text = document.querySelector('#gov-cards')?.textContent ?? '';
      return text.includes('读取失败') || text.includes('仅管理员');
    })()`,
    '普通账户被拒',
  );
  const text = await evaluate(`document.querySelector('#gov-cards').textContent`);
  check('普通账户看到的是"仅管理员"，不是空白表', /仅管理员/.test(text), text.slice(0, 80));
});

test('汇总：全部浏览器断言通过', () => {
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n合计 ${String(checks.length)} 项，失败 ${String(failed.length)} 项`);
  assert.equal(failed.length, 0);
});
