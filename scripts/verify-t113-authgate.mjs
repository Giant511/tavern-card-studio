/**
 * v0.1.2 追加任务端到端：凭证门槛错序修复。
 *
 * 验收的是「顺序」，不是像素：
 *   ① **一个令牌都没有**时，登录/注册界面必须能打开（这是原来的生产缺陷）；
 *   ② `registerMode=closed` 时注册按钮隐藏，且直接打接口被服务端拒绝（REGISTRATION_CLOSED）；
 *   ③ 登录后设置面板身份行显示「已登录：alice（账户令牌）」；
 *   ④ legacy 全局令牌收在「高级 · 兼容模式」折叠区，**默认收起**；
 *   ⑤ 登录成功后自动预取「我的卡片」。
 *
 * 四个截图状态：未配置地址 / 已配置未登录 / 已登录 / legacy 兼容模式展开。
 *
 * 用法：node scripts/verify-t113-authgate.mjs
 * 前置：npm run build:ui（脚本会断言 dist 比源码新）
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 't113');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9341;
const WEB_PORT = 8891;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

const watched = [
  'client/src/auth/entry-policy.ts',
  'client/src/settings/settings-dialog.ts',
  'client/src/sync/sync-dialog.ts',
  'client/src/auth/login-dialog.ts',
  'client/src/editor/app.ts',
];

function assertFreshBuild() {
  const assets = join(REPO, 'client', 'dist', 'assets');
  const latestDist = Math.max(
    ...readdirSync(assets)
      .filter((name) => name.startsWith('main-') && name.endsWith('.js'))
      .map((name) => statSync(join(assets, name)).mtimeMs),
  );
  const newestSource = Math.max(...watched.map((rel) => statSync(join(REPO, rel)).mtimeMs));
  check(
    'client/dist 比源码新（测的是本次构建）',
    latestDist >= newestSource,
    `dist=${new Date(latestDist).toISOString()} src=${new Date(newestSource).toISOString()}`,
  );
  if (latestDist < newestSource) throw new Error('请先 npm run build:ui');
}

const work = mkdtempSync(join(tmpdir(), 'tcs-t113-'));
const children = [];
const port = 20800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${String(port)}`;
const legacyToken = 't113e2e-legacy-token-bbbbbbbbbbbbbbbb';
const configPath = join(work, 'config.json');

function writeConfig(registerMode) {
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        port,
        controlPort: port + 1,
        host: '127.0.0.1',
        controlHost: '127.0.0.1',
        dataDir: join(work, 'store'),
        rulesDir: 'rules',
        defaultPlatformRule: 'sillytavern',
        defaultPreset: 'default',
        maxUploadBytes: 33554432,
        logLevel: 'warn',
        trustProxy: [],
        auth: {
          token: legacyToken,
          require: true,
          publicPaths: ['/api/health'],
          registerMode,
          jwtSecret: 't113-e2e-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
        },
        tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
        service: { mode: 'process', name: 'T113E', displayName: 'T113E', autoStart: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function waitHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {
      /* 还没起 */
    }
    await delay(200);
  }
  return false;
}

function startServer() {
  const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`[srv] ${String(d)}`));
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), delay(5000)]);
}

async function api(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    // raw：卡内容要按**原始字节**发。再 stringify 一次会把它变成带引号的字符串字面量，
    // 服务端解析出来就不是角色卡了（422）——verify-t108 踩过同一个坑。
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

async function main() {
  mkdirSync(OUT, { recursive: true });
  assertFreshBuild();

  // ── 准备数据：先用 open 建一个账户与一张卡，再切到 closed 重启 ──
  writeConfig('open');
  const first = startServer();
  check('服务端就绪（open 阶段）', await waitHttp(`${base}/api/health`), base);

  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  const aliceToken = reg.json?.accessToken ?? '';
  check('账户已创建（用于后面的登录）', reg.status === 201 && aliceToken !== '', `status=${String(reg.status)}`);

  const cardJson = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
  const upload = await api('/api/cards?cardId=e2e-t113-card', { method: 'POST', body: cardJson, token: aliceToken, raw: true });
  check('账户上传一张卡（用于验证登录后自动拉卡）', upload.status === 201, `status=${String(upload.status)}`);

  await stopServer(first);
  writeConfig('closed');
  startServer();
  check('服务端就绪（closed 阶段）', await waitHttp(`${base}/api/health`), base);

  // ── 浏览器 ─────────────────────────────────────────────
  const staticServer = spawn(
    'python',
    ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1', '--directory', 'client/dist'],
    { cwd: REPO, stdio: 'ignore' },
  );
  children.push(staticServer);
  check('静态站点就绪', await waitHttp(`http://127.0.0.1:${String(WEB_PORT)}/index.html`), `:${String(WEB_PORT)}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${join(work, 'chrome')}`,
      '--window-size=1440,1000',
      `http://127.0.0.1:${String(WEB_PORT)}/index.html`,
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
  const waitFor = async (expression, label, timeoutMs = 15000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await delay(150);
    }
    throw new Error(`等待超时：${label}`);
  };
  const waitApp = async () => {
    await waitFor(
      `(() => { const app = window.__tcs?.app; const s = document.querySelector('#status'); return !!app && !!s; })()`,
      '应用启动完成',
    );
    // 等自动探测跑完（否则读到的是初始状态）
    await delay(900);
  };

  // ── 状态①：未配置地址 ──────────────────────────────────
  await waitApp();
  const noServer = await evaluate(`(() => ({
    chip: document.querySelector('#conn-text').textContent,
    gate: document.body.dataset.syncGate,
  }))()`);
  check('① 未配置地址：胶囊显示「未配置」', noServer.chip === '未配置', noServer.chip);
  check('① 未配置地址：同步门槛为 no-server', noServer.gate === 'no-server', String(noServer.gate));

  // 点账户按钮 → 应该把用户送到设置页（而不是打开一个注定失败的登录框）
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="settings-dialog"]').hidden`, '设置面板');
  const noServerHint = await evaluate(`(() => ({
    settingsOpen: !document.querySelector('[data-role="settings-dialog"]').hidden,
    loginOpen: !document.querySelector('[data-role="auth-dialog"]').hidden,
    status: document.querySelector('#status').textContent,
  }))()`);
  check('① 未配置地址时点「登录」→ 打开设置面板（不是登录框）', noServerHint.settingsOpen && !noServerHint.loginOpen,
    `settings=${String(noServerHint.settingsOpen)} login=${String(noServerHint.loginOpen)}`);
  check('① 状态栏说明了原因', /地址/.test(noServerHint.status), noServerHint.status.slice(0, 60));
  await shot('1-no-server');
  await evaluate(`document.querySelector('[data-role="settings-dialog"]').hidden = true, true`);

  // ── 切到"有地址"的页面 ─────────────────────────────────
  const appUrl = `http://127.0.0.1:${String(WEB_PORT)}/index.html?serverUrl=${encodeURIComponent(base)}`;
  await cdp.send('Page.navigate', { url: appUrl });
  await delay(600);
  await waitApp();
  await waitFor(`document.body.dataset.syncGate === 'need-login'`, '门槛进入 need-login', 20000);

  // ── 状态②：已配置地址、未登录（**一个令牌都没有**）──────
  const anonymous = await evaluate(`(() => ({
    chip: document.querySelector('#conn-text').textContent,
    gate: document.body.dataset.syncGate,
    hint: document.querySelector('#sync-hint').textContent,
    syncDisabled: ['btn-upload','btn-history','btn-rollback'].map((id) => document.getElementById(id).disabled),
  }))()`);
  check('② 未登录：胶囊显示「已连接 · 未登录」', anonymous.chip === '已连接 · 未登录', anonymous.chip);
  check('② 未登录：同步提示是「登录后可同步」', /登录后可同步/.test(anonymous.hint), anonymous.hint);
  check('② 未登录：三个同步入口**不置灰**', anonymous.syncDisabled.every((d) => d === false),
    JSON.stringify(anonymous.syncDisabled));

  // 核心回归：没有任何令牌，登录框必须能打开
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, '登录框（无令牌时）', 10000);
  // 等策略真的回来了再断言注册按钮 —— 对话框是先可见、后拉 /api/auth/config 的。
  // 判据用提示语（它紧跟策略一起更新），而不是"等一个固定毫秒数"。
  await waitFor(
    `(() => { const h = document.querySelector('[data-role="auth-hint"]'); return h && !h.textContent.includes('正在读取'); })()`,
    '注册策略已到达',
    15000,
  );
  const loginOpen = await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    return {
      open: !o.hidden,
      registerHidden: o.querySelector('[data-role="auth-register"]').hidden,
      hint: o.querySelector('[data-role="auth-hint"]').textContent,
      submitDisabled: o.querySelector('[data-role="auth-submit"]').disabled,
    };
  })()`);
  check('② 没有任何令牌时登录界面能打开（本次核心回归）', loginOpen.open === true, 'open=true');
  check('② closed 模式：注册按钮隐藏', loginOpen.registerHidden === true, `hidden=${String(loginOpen.registerHidden)}`);
  check('② 登录按钮可用（地址已配置即可登录）', loginOpen.submitDisabled === false, `disabled=${String(loginOpen.submitDisabled)}`);
  await shot('2-configured-anonymous');

  // closed 的兜底：绕过界面直接打接口，服务端必须拒绝
  const closedProbe = await evaluate(`(async () => {
    const res = await fetch('${base}/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'mallory', password: 'mallory-password-1' }),
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, code: body?.error?.code ?? null };
  })()`);
  check('② 直接打注册接口被服务端拒绝（403 REGISTRATION_CLOSED）',
    closedProbe.status === 403 && closedProbe.code === 'REGISTRATION_CLOSED',
    `status=${String(closedProbe.status)} code=${String(closedProbe.code)}`);

  // 同步面板：未登录时说的是「登录后可同步」，不是"未连接"
  await evaluate(`(() => { document.querySelector('[data-role="auth-dialog"]').hidden = true; document.querySelector('#btn-upload').click(); return true; })()`);
  await waitFor(`(() => { const o = document.querySelector('.sync-status'); return o && o.textContent.includes('登录后可同步'); })()`, '同步面板文案');
  const syncPanel = await evaluate(`(() => ({
    status: document.querySelector('.sync-status').textContent,
    loginButtonHidden: document.querySelector('[data-role="sync-login"]').hidden,
    repoRowHeight: document.querySelector('.sync-repo-row')?.getBoundingClientRect().height ?? -1,
  }))()`);
  check('② 同步面板显示「登录后可同步」', /登录后可同步/.test(syncPanel.status), syncPanel.status);
  // 「上传到仓库」整行必须**视觉隐藏**（不只是 hidden 属性为真）。
  // 2026-10-23 截图发现：属性对了但 `.field-row{display:flex}` 把 hidden 盖掉了，
  // 于是未登录时那行一直显示着 —— 只读属性的断言抓不到这个，必须看像素。
  check('② 未登录时「上传到仓库」整行视觉隐藏', syncPanel.repoRowHeight === 0,
    `height=${String(syncPanel.repoRowHeight)}`);
  check('② 面板里有「登录…」入口', syncPanel.loginButtonHidden === false, `hidden=${String(syncPanel.loginButtonHidden)}`);
  await shot('3-sync-need-login');
  await evaluate(`(() => { const o = document.querySelector('.sync-status')?.closest('.modal-overlay'); if (o) o.hidden = true; return true; })()`);

  // ── 登录 ───────────────────────────────────────────────
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, '登录框');
  await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    o.querySelector('[data-role="auth-username"]').value = 'alice';
    o.querySelector('[data-role="auth-password"]').value = 'alice-password-1';
    o.querySelector('[data-role="auth-submit"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('#btn-account').dataset.phase === 'authenticated'`, '登录成功', 20000);
  check('账户登录成功', true, 'alice');
  await waitFor(`document.body.dataset.syncGate === 'ready'`, '门槛进入 ready', 20000);
  check('登录后同步门槛变为 ready', true, 'ready');

  // 第 4 条：登录成功即拉一次「我的卡片」
  await waitFor(`document.body.dataset.cardsPreloaded !== undefined`, '登录后自动预取卡片', 20000);
  const preloaded = await evaluate(`document.body.dataset.cardsPreloaded`);
  check('登录后自动预取「我的卡片」', Number(preloaded) >= 1, `cardsPreloaded=${String(preloaded)}`);

  // ── 状态③：已登录（设置面板身份行）──────────────────────
  await evaluate(`document.querySelector('#btn-settings').click(), true`);
  await waitFor(`!document.querySelector('[data-role="settings-dialog"]').hidden`, '设置面板');
  const identity = await evaluate(`(() => {
    const d = document.querySelector('[data-role="settings-dialog"]');
    return {
      text: d.querySelector('[data-role="settings-identity"]').textContent,
      phase: d.querySelector('[data-role="settings-identity"]').dataset.phase,
      action: d.querySelector('[data-role="settings-identity-action"]').textContent,
      advancedOpen: d.querySelector('[data-role="settings-advanced"]').open,
      legacyPresent: d.querySelector('[data-role="legacy-token"]') !== null,
    };
  })()`);
  // 注意：**首个账户必定是管理员**（服务端强制），所以真实文案是
  // 「已登录：alice（管理员 · 账户令牌）」。这里不把它删掉 —— 角色要显示：
  // registerMode=admin-only 时「注册入口显不显示」的判据就是这个角色，
  // 藏起来会让管理员看到"没有注册按钮"却不知道为什么。
  check('③ 设置面板身份行显示「已登录：alice（…账户令牌）」',
    /^已登录：alice（(管理员 · )?账户令牌）$/.test(identity.text), identity.text);
  check('③ 身份按钮变成「退出登录」', identity.action === '退出登录', identity.action);
  check('④ legacy 折叠区默认收起', identity.advancedOpen === false, `open=${String(identity.advancedOpen)}`);
  check('④ legacy 令牌输入仍在（兼容模式可填）', identity.legacyPresent === true, '');
  await shot('4-signed-in');

  // ── 状态④：legacy 兼容模式展开 ──────────────────────────
  await evaluate(`(() => {
    const d = document.querySelector('[data-role="settings-dialog"]');
    d.querySelector('[data-role="settings-advanced"]').open = true;
    return true;
  })()`);
  await delay(250);
  const expanded = await evaluate(`(() => {
    const d = document.querySelector('[data-role="settings-dialog"]');
    const details = d.querySelector('[data-role="settings-advanced"]');
    const hint = details.querySelector('.field-hint')?.textContent ?? '';
    return { open: details.open, hint, visible: details.getBoundingClientRect().height > 0 };
  })()`);
  check('④ 展开后可见，且注明仅用于 ≤v0.1.1', expanded.open && expanded.visible && /0\.1\.1/.test(expanded.hint),
    expanded.hint.slice(0, 60));
  await shot('5-legacy-expanded');

  check('页面无未捕获异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

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
      /* 已退出 */
    }
  }
  await delay(400);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* 占用时留给系统 */
  }
}
