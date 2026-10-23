/**
 * T10.7 端到端验证：客户端登录 / 注册入口显隐 / 按账户卡片列表。
 *
 * 为什么必须进浏览器：这一轮的三条要求全是"界面行为"——
 *   · 错误提示用服务端统一文案（要看真实渲染出来的字符串）；
 *   · registerMode=closed 时界面**不显示**注册按钮（要看 DOM）；
 *   · 卡片列表显示 角色名 · cardId · 仓库 · vN（要看四列都渲染出来）。
 * 纯函数单测只能证明"决定"正确，证明不了"界面照做了"。
 *
 * 环境：本机没有壳（Tauri），所以用 `?serverUrl=` 兜底 —— 与既有
 * `?settings=1&serverUrl=…` 调试参数同源。壳里配置优先，走不到这条路径。
 *
 * 用法：node scripts/verify-t107.mjs
 * 前置：npm run build:ui（脚本会检查 dist 是否比源码新，旧了直接报错）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 't107');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9333;
const WEB_PORT = 8899;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

// ── 构建新鲜度（产物旧了就别测了，不然测的是上一版）─────────
function assertFreshBuild() {
  const dist = readdirSync(join(REPO, 'client', 'dist', 'assets'))
    .filter((name) => name.startsWith('main-') && name.endsWith('.js'))
    .map((name) => statSync(join(REPO, 'client', 'dist', 'assets', name)).mtimeMs);
  const latestDist = Math.max(...dist);
  const sources = ['client/src/editor/app.ts', 'client/src/auth/login-dialog.ts', 'client/src/sync/cards-dialog.ts'].map(
    (rel) => statSync(join(REPO, rel)).mtimeMs,
  );
  const newestSource = Math.max(...sources);
  check('client/dist 比源码新（测的是本次构建）', latestDist >= newestSource,
    `dist=${new Date(latestDist).toISOString()} src=${new Date(newestSource).toISOString()}`);
  if (latestDist < newestSource) {
    throw new Error('请先 npm run build:ui');
  }
}

// ── 服务端实例 ──────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'tcs-t107-'));
const children = [];

function writeConfig(dir, port, registerMode) {
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        port,
        controlPort: port + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(dir, 'store'),
        rulesDir: 'rules',
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        logLevel: 'warn',
        auth: {
          token: 't107-global-token-aaaaaaaaaaaaaaaaaaaaaaaa',
          require: true,
          publicPaths: ['/api/health'],
          registerMode,
          jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
        service: { mode: 'process', name: 'T107', displayName: 'T107', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return join(dir, 'config.json');
}

function startServer(configPath) {
  const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitHttp(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await delay(200);
  }
  return false;
}

async function call(base, path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && typeof body !== 'string') headers['Content-Type'] = 'application/json';
  else if (typeof body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
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

// ── CDP ────────────────────────────────────────────────────
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
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.id !== undefined) {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
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
          rej(new Error(`${method} 超时`));
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

const sleep = (ms) => delay(ms);

async function main() {
  mkdirSync(OUT, { recursive: true });
  assertFreshBuild();

  // 1) 两个服务端：open（可自助注册）与 closed（不显示注册入口）
  const openPort = 19600 + Math.floor(Math.random() * 100);
  const closedPort = openPort + 100;
  const openDir = join(work, 'open');
  const closedDir = join(work, 'closed');
  mkdirSync(openDir, { recursive: true });
  mkdirSync(closedDir, { recursive: true });
  startServer(writeConfig(openDir, openPort, 'open'));
  startServer(writeConfig(closedDir, closedPort, 'closed'));

  const openBase = `http://127.0.0.1:${String(openPort)}`;
  const closedBase = `http://127.0.0.1:${String(closedPort)}`;
  check('open 服务端就绪', await waitHttp(`${openBase}/api/health`), openBase);
  check('closed 服务端就绪', await waitHttp(`${closedBase}/api/health`), closedBase);

  // 2) 静态服务 + Chrome（都用 spawn，前面已有先例：本机 spawnSync 会 EBUSY）
  const staticServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1', '--directory', 'client/dist'], {
    cwd: REPO,
    stdio: 'ignore',
  });
  children.push(staticServer);
  check('静态站点就绪', await waitHttp(`http://127.0.0.1:${String(WEB_PORT)}/index.html`), `:${String(WEB_PORT)}`);

  const chromeDir = join(work, 'chrome');
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${chromeDir}`,
      '--window-size=1440,960',
      `http://127.0.0.1:${String(WEB_PORT)}/index.html?serverUrl=${encodeURIComponent(openBase)}`,
    ],
    { stdio: 'ignore' },
  );
  children.push(chrome);
  check('Chrome 调试端口就绪', await waitHttp(`http://127.0.0.1:${String(CDP_PORT)}/json/list`), `:${String(CDP_PORT)}`);

  const targets = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes(String(WEB_PORT)));
  if (!page) throw new Error('没找到页面目标');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push((p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '').slice(0, 300));
  });
  cdp.on('Page.javascriptDialogOpening', () => {
    // 一律「取消」：本脚本不测导出闸门，但别让原生弹框卡住页面
    cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
  });

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本报错：' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    }
    return r.result.value;
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  };

  const waitFor = async (expression, label, timeoutMs = 10000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(150);
    }
    throw new Error(`等待超时：${label}`);
  };

  // ── A. 初始状态 ─────────────────────────────────────────
  await waitFor(`document.querySelector('#btn-account')?.dataset.phase === 'anonymous'`, '账户按钮初始态');
  const initial = await evaluate(`(() => {
    const b = document.querySelector('#btn-account');
    return { text: b.textContent.trim(), phase: b.dataset.phase, title: b.title };
  })()`);
  check('A1 未登录时账户按钮显示「登录…」', initial.text === '登录…' && initial.phase === 'anonymous',
    `text=${initial.text} phase=${initial.phase}`);

  // ── B. 打开登录框：open 模式应显示注册入口 ───────────────
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, '登录框出现');
  await waitFor(`document.querySelector('[data-role="auth-hint"]').textContent.includes('自助注册')`, '策略已加载');
  const dialog = await evaluate(`(() => {
    const overlay = document.querySelector('[data-role="auth-dialog"]');
    const reg = overlay.querySelector('[data-role="auth-register"]');
    return {
      mode: overlay.dataset.mode,
      hint: overlay.querySelector('[data-role="auth-hint"]').textContent.trim(),
      registerHidden: reg.hidden,
      registerText: reg.textContent.trim(),
      errorHidden: overlay.querySelector('[data-role="auth-error"]').hidden,
    };
  })()`);
  check('B1 登录框以「登录」模式打开', dialog.mode === 'login', dialog.mode);
  check('B2 open 模式显示注册入口', dialog.registerHidden === false, dialog.registerText);
  check('B3 说明文案来自服务端策略', dialog.hint.includes('开放自助注册'), dialog.hint);
  await shot('b-login-dialog-open');

  // ── C. 错误密码：文案必须是服务端原话 ───────────────────
  // 先直接在 Node 侧建一个账户（走真实 API），再在界面里用错密码登录
  const registered = await call(openBase, '/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  check('C0 账户已创建（服务端 201）', registered.status === 201, `status=${registered.status}`);

  const wrongDirect = await call(openBase, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'definitely-wrong' },
  });
  const serverText = wrongDirect.json?.error?.message ?? '';
  check('C1 服务端对错误密码给出统一文案', wrongDirect.status === 401 && serverText !== '', serverText);

  await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    const u = o.querySelector('[data-role="auth-username"]');
    const p = o.querySelector('[data-role="auth-password"]');
    u.value = 'alice'; u.dispatchEvent(new Event('input', { bubbles: true }));
    p.value = 'definitely-wrong'; p.dispatchEvent(new Event('input', { bubbles: true }));
    o.querySelector('[data-role="auth-submit"]').click();
    return true;
  })()`);
  await waitFor(`!document.querySelector('[data-role="auth-error"]').hidden`, '错误提示出现');
  const shownError = await evaluate(`document.querySelector('[data-role="auth-error"]').textContent.trim()`);
  check('C2 界面错误文案与服务端逐字节一致（客户端不翻译）', shownError === serverText,
    `界面=「${shownError}」 服务端=「${serverText}」`);
  check('C3 客户端没附加推测性后缀（无括号补充、无"请检查"）',
    !/[（(]/.test(shownError) && !shownError.includes('请检查'), shownError);
  check('C4 登录失败后仍停在登录框（不是关掉）',
    (await evaluate(`!document.querySelector('[data-role="auth-dialog"]').hidden`)) === true, '');
  await shot('c-login-error');

  // ── D. 正确密码：登录成功，顶栏改文案 ───────────────────
  await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    const p = o.querySelector('[data-role="auth-password"]');
    p.value = 'alice-password-1'; p.dispatchEvent(new Event('input', { bubbles: true }));
    o.querySelector('[data-role="auth-submit"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-role="auth-dialog"]').hidden`, '登录框关闭');
  await waitFor(`document.querySelector('#btn-account').dataset.phase === 'authenticated'`, '登录态生效');
  const afterLogin = await evaluate(`(() => {
    const b = document.querySelector('#btn-account');
    return { text: b.textContent.trim(), phase: b.dataset.phase };
  })()`);
  check('D1 登录后顶栏显示用户名（首账户即管理员）', /alice/.test(afterLogin.text) && /管理员/.test(afterLogin.text),
    afterLogin.text);
  check('D2 phase = authenticated', afterLogin.phase === 'authenticated', afterLogin.phase);

  // 连接要等 autoProbe 跑完（登录后会自动重探一次）
  await waitFor(`document.querySelector('#conn-text').textContent === '已连接'`, '登录后连接就绪', 15000);
  check('D3 登录后顶栏连接状态变成「已连接」', true, '');

  // ── E. 按账户卡片列表：四列都要渲染出来 ─────────────────
  const tokens = (await call(openBase, '/api/auth/login', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  })).json;
  const cardJson = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
  const uploaded = await call(openBase, '/api/cards?cardId=t107-card-1', {
    method: 'POST',
    body: cardJson,
    token: tokens.accessToken,
  });
  check('E0 已用账户令牌上传一张卡', uploaded.status === 201 || uploaded.status === 200,
    `status=${uploaded.status} cardId=${uploaded.json?.cardId ?? '?'}`);

  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="cards-dialog"]').hidden`, '卡片列表出现');
  await waitFor(`document.querySelectorAll('[data-role="cards-list"] .cards-row').length > 0`, '列表有行');
  const rows = await evaluate(`(() => {
    const list = document.querySelector('[data-role="cards-list"]');
    const row = list.querySelector('.cards-row');
    return {
      count: list.querySelectorAll('.cards-row').length,
      countText: document.querySelector('[data-role="cards-count"]').textContent.trim(),
      name: row.querySelector('.cards-row-name').textContent.trim(),
      id: row.querySelector('.cards-row-id').textContent.trim(),
      repo: row.querySelector('.cards-row-repo').textContent.trim(),
      version: row.querySelector('.cards-row-version').textContent.trim(),
      note: document.querySelector('[data-role="cards-note"]').textContent.trim(),
      noteHidden: document.querySelector('[data-role="cards-note"]').hidden,
    };
  })()`);
  check('E1 列表有 1 行（服务端返回几条就显示几条）', rows.count === 1, rows.countText);
  check('E2 第二列是 cardId', rows.id === 't107-card-1', rows.id);
  check('E3 第三列是仓库名（默认仓库）', rows.repo === 'default', rows.repo);
  check('E4 第四列是版本号 vN', rows.version === 'v1', rows.version);
  check('E5 第一列是角色名', rows.name.length > 0, rows.name);
  check('E6 账户登录时如实提示"尚未按账户过滤"', rows.noteHidden === false && rows.note.includes('尚未按账户过滤'),
    rows.note);
  await shot('e-cards-list');

  // ── F. 令牌失效：回登录界面，但**本地编辑一个字都不丢** ──
  // 这是需求 2 里括号那半句的可验证形式：先造一个真实的本地会话（含未保存文本），
  // 再让令牌失效，看编辑器内容与标签还在不在。
  //
  // 这一步刻意**不关**「我的卡片」面板：真实场景里用户就是在面板里看到数据没了
  // 才发现登录过期。于是同时能验到两件事 —— 失败态不能画成"共 0 张"，
  // 以及登录框必须盖在上层（否则用户只看到面板数据空了，看不到为什么）。
  const created = await evaluate(`(async () => {
    document.querySelector('#btn-new').click();
    await new Promise((r) => setTimeout(r, 350));
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hidden && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = '过期测试卡';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 't107-expiry-card';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    await new Promise((r) => setTimeout(r, 600));
    const app = window.__tcs.app;
    app.sessions[0].setBlockText('basic', '这段是未保存的正文，登录过期不该丢');
    app.reloadBlocksFromCard();
    return {
      tabs: document.querySelectorAll('#tabbar-host .tab').length,
      label: document.querySelector('.tab.is-active')?.textContent.trim() ?? '',
      text: app.sessions[0].card.blocks.find((b) => b.id === 'basic').text,
    };
  })()`);
  check('F0 本地已有一个带未保存内容的会话', created.tabs === 1 && created.text.includes('登录过期不该丢'),
    `tabs=${String(created.tabs)} label=${created.label}`);

  // 把令牌改成失效值（真实 401，而不是"假装"），然后触发一次服务端请求
  await evaluate(`(() => {
    const app = window.__tcs.app;
    // 运行时这些是普通属性；这里刻意绕开界面，只为制造"令牌失效"这个状态
    app.authSession.state.accessToken = 't107-bogus-access';
    app.authSession.state.refreshToken = 't107-bogus-refresh';
    app.authSession.state.accessExpiresAt = Date.now() + 3600000;
    document.querySelector('#btn-account').click();
    return true;
  })()`);

  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, '回到登录界面', 15000);
  const expired = await evaluate(`(() => {
    const app = window.__tcs.app;
    const overlay = document.querySelector('[data-role="auth-dialog"]');
    return {
      phase: document.querySelector('#btn-account').dataset.phase,
      reason: overlay.querySelector('[data-role="auth-error"]').textContent.trim(),
      tabs: document.querySelectorAll('#tabbar-host .tab').length,
      label: document.querySelector('.tab.is-active')?.textContent.trim() ?? '',
      text: app.sessions[0]?.card.blocks.find((b) => b.id === 'basic').text ?? '',
      accessToken: app.authSession.accessToken,
    };
  })()`);
  check('F1 401 且续期失败 → 自动回到登录界面', expired.phase === 'expired', expired.phase);
  check('F2 登录界面写明原因（不是无声跳转）', /登录已过期|令牌无效/.test(expired.reason), expired.reason);
  check('F3 本地标签仍在', expired.tabs === 1 && expired.label.includes('过期测试卡'),
    `tabs=${String(expired.tabs)} label=${expired.label}`);
  check('F4 未保存正文一字未丢', expired.text.includes('登录过期不该丢'), expired.text);
  check('F5 失效令牌已被清掉（不会继续拿去请求）', expired.accessToken === '', `accessToken=${expired.accessToken}`);

  // 登录框必须浮在其它对话框之上：用命中测试而不是读 z-index —— 读数值只能证明
  // "写了 60"，命中测试才能证明"用户真能点到登录框"
  const stacking = await evaluate(`(() => {
    const overlay = document.querySelector('[data-role="auth-dialog"]');
    const panel = overlay.querySelector('.modal');
    const rect = panel.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
    return {
      topmost: !!hit && overlay.contains(hit),
      hitTag: hit ? hit.className || hit.tagName : '(null)',
      cardsOpen: !document.querySelector('[data-role="cards-dialog"]').hidden,
    };
  })()`);
  check('F6 登录框覆盖在其它对话框之上（用户能看到为什么回来了）', stacking.topmost === true,
    `命中=${stacking.hitTag} cardsOpen=${String(stacking.cardsOpen)}`);

  // 同一个时刻，卡片面板不能把"取不到"画成"没有卡"
  const notice = await evaluate(`(() => {
    const count = document.querySelector('[data-role="cards-count"]').textContent.trim();
    const empty = document.querySelector('[data-role="cards-empty"]')?.textContent.trim() ?? '';
    return { count, empty };
  })()`);
  check('F7 加载失败不画成「共 0 张」（失败态与空态分开）',
    notice.count !== '共 0 张' && /加载失败|未连接/.test(`${notice.count}${notice.empty}`),
    `count=${notice.count} empty=${notice.empty}`);
  await shot('f-expired-back-to-login');

  // ── F2. 重新登录后登出：同样不影响本地会话 ──────────────
  await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    o.querySelector('[data-role="auth-username"]').value = 'alice';
    o.querySelector('[data-role="auth-password"]').value = 'alice-password-1';
    o.querySelector('[data-role="auth-submit"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('#btn-account').dataset.phase === 'authenticated'`, '重新登录成功', 15000);

  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="cards-dialog"]').hidden`, '账户面板打开');
  await evaluate(`document.querySelector('[data-role="account-logout"]').click(), true`);
  await waitFor(`document.querySelector('#btn-account').dataset.phase === 'anonymous'`, '登出后回到未登录');
  const afterLogout = await evaluate(`(() => ({
    text: document.querySelector('#btn-account').textContent.trim(),
    tabs: document.querySelectorAll('#tabbar-host .tab').length,
  }))()`);
  check('F8 登出后按钮回到「登录…」', afterLogout.text === '登录…', afterLogout.text);
  check('F9 登出也不影响本地标签', afterLogout.tabs === 1, `tabs=${String(afterLogout.tabs)}`);

  // ── G. closed 模式：界面根本不显示注册入口 ──────────────
  await cdp.send('Page.navigate', {
    url: `http://127.0.0.1:${String(WEB_PORT)}/index.html?serverUrl=${encodeURIComponent(closedBase)}`,
  });
  await sleep(1500);
  await waitFor(`document.querySelector('#btn-account')?.dataset.phase === 'anonymous'`, 'closed 页就绪', 15000);
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, 'closed 登录框出现');
  await waitFor(`document.querySelector('[data-role="auth-hint"]').textContent.includes('未开放')`, 'closed 策略已加载');
  const closedDialog = await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    const reg = o.querySelector('[data-role="auth-register"]');
    return {
      hidden: reg.hidden,
      visibleInLayout: reg.offsetParent !== null,
      hint: o.querySelector('[data-role="auth-hint"]').textContent.trim(),
    };
  })()`);
  check('G1 closed 模式不显示注册按钮（DOM 上不可见）',
    closedDialog.hidden === true && closedDialog.visibleInLayout === false,
    `hidden=${String(closedDialog.hidden)} offsetParent=${String(closedDialog.visibleInLayout)}`);
  check('G2 closed 说明文案指向命令行建号', closedDialog.hint.includes('tcs-server user add'), closedDialog.hint);
  await shot('g-register-closed');

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  // ── 收尾 ────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(OUT, 'result.json'), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
  console.log(`\n${String(results.length - failed.length)}/${String(results.length)} 通过`);
  if (failed.length > 0) process.exitCode = 1;
  cdp.close();
}

try {
  await main();
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }
  await delay(400);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* 文件占用时留给系统清理 */
  }
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
}
