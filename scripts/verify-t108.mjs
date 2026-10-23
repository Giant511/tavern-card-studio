/**
 * T10.8 端到端：仓库联动 UI + 令牌申请 + 隔离提示自动消失。
 *
 * 验的是三条"只有真浏览器才看得见"的行为：
 *   ① 上传仓库下拉**预选默认仓库**（不是空着、也不是选第一个）；
 *   ② 申请令牌后原文**显示一次**，关闭面板后就不在了（不是"收起"，是清空）；
 *   ③ 服务端 `isolationEnforced: true` 时，卡片列表**不再显示**未隔离提示。
 *
 * 用法：node scripts/verify-t108.mjs
 * 前置：npm run build:ui（脚本会断言 dist 比源码新）
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, '.verify', 't108');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP_PORT = 9333;
const WEB_PORT = 8899;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

function assertFreshBuild() {
  const assets = join(REPO, 'client', 'dist', 'assets');
  const latestDist = Math.max(
    ...readdirSync(assets)
      .filter((name) => name.startsWith('main-') && name.endsWith('.js'))
      .map((name) => statSync(join(assets, name)).mtimeMs),
  );
  const newestSource = Math.max(
    ...['client/src/sync/repo-dialog.ts', 'client/src/sync/sync-dialog.ts', 'client/src/editor/app.ts'].map(
      (rel) => statSync(join(REPO, rel)).mtimeMs,
    ),
  );
  check('client/dist 比源码新（测的是本次构建）', latestDist >= newestSource,
    `dist=${new Date(latestDist).toISOString()} src=${new Date(newestSource).toISOString()}`);
  if (latestDist < newestSource) throw new Error('请先 npm run build:ui');
}

const work = mkdtempSync(join(tmpdir(), 'tcs-t108e2e-'));
const children = [];
const port = 20600 + Math.floor(Math.random() * 100);
const legacyToken = 't108e2e-legacy-token-aaaaaaaaaaaaaaaa';

const configPath = join(work, 'config.json');
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
      logLevel: 'error',
      auth: {
        token: legacyToken,
        require: true,
        publicPaths: ['/api/health'],
        registerMode: 'open',
        jwtSecret: 'unit-test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa',
      },
      tls: { mode: 'off', httpsPort: port + 1000, certPath: '', keyPath: '' },
      service: { mode: 'process', name: 'T108E', displayName: 'T108E', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const server = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${String(d)}`));

const base = `http://127.0.0.1:${String(port)}`;

async function waitHttp(url, timeoutMs = 20000) {
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

async function api(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
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

  check('服务端就绪', await waitHttp(`${base}/api/health`), base);

  // 账户 + 一张卡（归默认仓库），另建一个仓库用于验证"默认仓库预选"不是"选第一个"
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username: 'alice', password: 'alice-password-1' },
  });
  const aliceToken = reg.json?.accessToken ?? '';
  check('账户已创建', reg.status === 201 && aliceToken !== '', `status=${reg.status}`);

  // 先建一个名字排在默认仓库**前面**的仓库，确保"预选默认"与"选第一个"能区分
  const zRepo = await api('/api/repos', { method: 'POST', body: { name: 'aaa-other' }, token: aliceToken });
  check('额外仓库已创建（名字排在默认仓库之前）', zRepo.status === 201, `status=${zRepo.status}`);

  const cardJson = readFileSync(join(REPO, 'test', 'fixtures', 'sample-card.json'), 'utf8');
  const upload = await api('/api/cards?cardId=e2e-t108-card', {
    method: 'POST',
    body: cardJson,
    token: aliceToken,
    // 卡内容按**原始字节**发送：再 stringify 一次会把它变成带引号的字符串字面量
    raw: true,
  });
  check('账户上传一张卡到默认仓库', upload.status === 201,
    `repo=${upload.json?.card?.repoName ?? '?'}`);

  // 静态站点 + Chrome
  const staticServer = spawn('python', ['-m', 'http.server', String(WEB_PORT), '--bind', '127.0.0.1', '--directory', 'client/dist'], {
    cwd: REPO,
    stdio: 'ignore',
  });
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
      `http://127.0.0.1:${String(WEB_PORT)}/index.html?serverUrl=${encodeURIComponent(base)}`,
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
  const waitFor = async (expression, label, timeoutMs = 12000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await delay(150);
    }
    throw new Error(`等待超时：${label}`);
  };

  // ── 登录 ────────────────────────────────────────────────
  /*
   * 先等应用真的启动完再点。
   * 注意不能只等 `#btn-account[data-phase=anonymous]` —— 那是 HTML 里的初始值，
   * 页面一解析完就成立，此时 App 还没执行到 wireAccount()，
   * 点了按钮什么都不会发生（表现为"登录框打不开"的假故障）。
   */
  await waitFor(
    `(() => { const app = window.__tcs?.app; const s = document.querySelector('#status'); return !!app && !!s && !s.textContent.includes('初始化'); })()`,
    '应用启动完成',
  );
  await waitFor(`document.querySelector('#btn-account')?.dataset.phase === 'anonymous'`, '初始态');
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="auth-dialog"]').hidden`, '登录框');
  await evaluate(`(() => {
    const o = document.querySelector('[data-role="auth-dialog"]');
    o.querySelector('[data-role="auth-username"]').value = 'alice';
    o.querySelector('[data-role="auth-password"]').value = 'alice-password-1';
    o.querySelector('[data-role="auth-submit"]').click();
    return true;
  })()`);
  await waitFor(`document.querySelector('#btn-account').dataset.phase === 'authenticated'`, '登录成功', 15000);
  await waitFor(`document.querySelector('#conn-text').textContent === '已连接'`, '连接就绪', 15000);
  check('已以账户身份登录并连上服务端', true, '');

  // ── ① 隔离提示自动消失 ─────────────────────────────────
  await evaluate(`document.querySelector('#btn-account').click(), true`);
  await waitFor(`!document.querySelector('[data-role="cards-dialog"]').hidden`, '卡片面板');
  await waitFor(`document.querySelectorAll('[data-role="cards-list"] .cards-row').length > 0`, '列表有行');
  const cardsPanel = await evaluate(`(() => {
    const note = document.querySelector('[data-role="cards-note"]');
    const row = document.querySelector('[data-role="cards-list"] .cards-row');
    return {
      noteHidden: note.hidden,
      noteText: note.textContent.trim(),
      count: document.querySelector('[data-role="cards-count"]').textContent.trim(),
      repo: row.querySelector('.cards-row-repo').textContent.trim(),
    };
  })()`);
  check('服务端说已隔离 → 不再显示"未按账户过滤"提示', cardsPanel.noteHidden === true, cardsPanel.noteText || '(隐藏)');
  check('卡片行仍显示仓库列', cardsPanel.repo.length > 0, cardsPanel.repo);
  await shot('a-cards-no-isolation-note');
  await evaluate(`document.querySelector('[data-role="cards-dialog"] .icon-btn').click(), true`);
  await delay(200);

  // ── ② 上传仓库：预选默认仓库（而非第一个）────────────────
  const reposDetail = await api('/api/repos', { token: aliceToken });
  const defaultRepo = (reposDetail.json?.items ?? []).find((item) => item.isDefault);
  // 服务端把默认仓库排在最前，所以选第一个与选默认在顺序上无法区分。
  // 真正要证的是**选中项的 id 等于 isDefault 那个**（不是靠标签文字碰巧对上），
  // 以及顺序被打乱时仍然选默认——后者由单测 pickRepoId 覆盖（倒序数组）。
  check('对照条件成立：确实存在一个默认仓库', defaultRepo !== undefined, defaultRepo?.name ?? '(无)');

  // 上传面板的目标行来自**活动会话**：先开一张卡，否则目标行显示没有打开的角色卡，
  // 那样就验不到目标行显示所选仓库这一条（会误判成功能没做）。
  await evaluate(`(async () => {
    document.querySelector('#btn-new').click();
    await new Promise((r) => setTimeout(r, 350));
    const overlay = [...document.querySelectorAll('.modal-overlay')].find(
      (o) => !o.hidden && o.textContent.includes('新建角色卡'));
    const inputs = overlay.querySelectorAll('.input');
    inputs[0].value = '仓库联动测试卡';
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = 'e2e-t108-session';
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    [...overlay.querySelectorAll('.btn.primary')].pop().click();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);
  check('已打开一个本地会话（上传目标行才有内容）',
    (await evaluate(`document.querySelector('.tab.is-active')?.textContent.includes('仓库联动测试卡')`)) === true, '');

  await evaluate(`document.querySelector('#btn-upload').click(), true`);
  await waitFor(`!document.querySelector('[data-role="sync-target"]')?.closest('.modal-overlay').hidden`, '同步面板');
  await waitFor(`!document.querySelector('[data-role="upload-repo"]').closest('.sync-repo-row').hidden`, '仓库下拉出现');
  const repoSelect = await evaluate(`(() => {
    const select = document.querySelector('[data-role="upload-repo"]');
    const selected = select.selectedOptions[0];
    return {
      count: select.options.length,
      value: select.value,
      text: selected?.textContent ?? '',
      selectedName: selected?.dataset.repoName ?? '',
      labels: [...select.options].map((o) => o.textContent),
    };
  })()`);
  check('仓库下拉列出全部仓库', repoSelect.count === 2, JSON.stringify(repoSelect.labels));
  check('预选的是默认仓库（按 id 判定，不靠标签文字）', repoSelect.value === defaultRepo?.id,
    `selected=${repoSelect.value} default=${defaultRepo?.id ?? '?'}`);
  check('预选项的原始名字不含「（默认）」后缀', repoSelect.selectedName === defaultRepo?.name,
    `${repoSelect.selectedName} vs ${defaultRepo?.name ?? '?'}`);
  check('上传目标行显示所选仓库', 
    (await evaluate(`document.querySelector('.sync-target-repo')?.textContent ?? ''`)).length > 0,
    await evaluate(`document.querySelector('.sync-target-repo')?.textContent ?? ''`));
  await shot('b-upload-repo-preselected');

  // ── ③ 仓库与令牌面板：原文只显示一次 ─────────────────────
  await evaluate(`document.querySelector('[data-role="open-repos"]').click(), true`);
  await waitFor(`!document.querySelector('[data-role="repo-dialog"]').hidden`, '仓库面板');
  await waitFor(`document.querySelectorAll('[data-role="repo-list"] .repo-row').length === 2`, '仓库列表');
  const repoRowCount = await evaluate(`document.querySelectorAll('[data-role="repo-list"] .repo-row').length`);
  check('仓库面板列出两个仓库', repoRowCount === 2, String(repoRowCount));

  // 选默认仓库 → 勾读+写 → 签发
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-role="repo-list"] .repo-row')];
    const target = rows.find((r) => r.textContent.includes('默认')) ?? rows[0];
    target.click();
    return true;
  })()`);
  await delay(300);
  await evaluate(`(() => {
    document.querySelector('[data-role="token-name"]').value = 'E2E 令牌';
    document.querySelector('[data-role="token-scope-write"]').click();
    document.querySelector('[data-role="token-issue"]').click();
    return true;
  })()`);
  await waitFor(`!document.querySelector('[data-role="token-issued"]').hidden`, '签发结果出现', 15000);
  const issued = await evaluate(`(() => {
    const box = document.querySelector('[data-role="token-issued"]');
    const value = box.querySelector('[data-role="token-value"]').value;
    return {
      value,
      visible: !box.hidden,
      warn: box.querySelector('.token-issued-warn').textContent.trim(),
      hasCopy: box.querySelector('[data-role="token-copy"]') !== null,
      note: box.querySelector('[data-role="token-issued-note"]').textContent.trim(),
      listCount: document.querySelectorAll('[data-role="token-list"] .token-row').length,
    };
  })()`);
  check('签发后原文直接显示（不是"点一下才展开"）', issued.visible === true && issued.value.startsWith('tcr_'),
    `${issued.value.slice(0, 12)}… len=${String(issued.value.length)}`);
  check('有「只显示这一次」的醒目说明', /只显示这一次/.test(issued.warn), issued.warn.slice(0, 40));
  check('有复制按钮', issued.hasCopy === true, '');
  check('说明里带仓库/范围/有效期', /仓库：/.test(issued.note) && /范围：/.test(issued.note), issued.note.slice(0, 60));
  check('令牌列表只显示前缀（不重复显示原文）', issued.listCount === 1, `rows=${String(issued.listCount)}`);
  const listPrefixes = await evaluate(`[...document.querySelectorAll('[data-role="token-list"] .token-row-prefix')].map(n => n.textContent.trim())`);
  /*
   * 这条断言必须同时要求「有内容」与「不是原文」。
   * 上一版只判 `endsWith('…')`，而空前缀渲染出来正好是「…」——
   * 客户端读错了字段名（服务端叫 prefix、客户端读 tokenPrefix）也照样通过，
   * 直到看截图才发现列表里只剩一个省略号。
   */
  check(
    '列表里的前缀来自服务端且非空（不是空串、不是完整原文）',
    listPrefixes.length === 1 &&
      listPrefixes[0].replace('…', '').length > 4 &&
      // 前缀**理应**是原文的开头；要证的是它比原文短（没有泄露全文）
      issued.value.startsWith(listPrefixes[0].replace('…', '')) &&
      listPrefixes[0].replace('…', '').length < issued.value.length,
    JSON.stringify(listPrefixes),
  );
  await shot('c-token-issued-once');

  // 关面板 → 原文必须被清掉
  await evaluate(`document.querySelector('[data-role="repo-dialog"] .icon-btn').click(), true`);
  await delay(300);
  const afterClose = await evaluate(`(() => {
    const box = document.querySelector('[data-role="token-issued"]');
    return { hidden: box.hidden, value: box.querySelector('[data-role="token-value"]').value };
  })()`);
  check('关闭面板后原文被清空（不是只是收起）', afterClose.hidden === true && afterClose.value === '',
    `hidden=${String(afterClose.hidden)} len=${String(afterClose.value.length)}`);

  // 再打开一次：不能"恢复"上一次的原文
  await evaluate(`document.querySelector('[data-role="open-repos"]').click(), true`);
  await waitFor(`!document.querySelector('[data-role="repo-dialog"]').hidden`, '重开仓库面板');
  await delay(400);
  const reopened = await evaluate(`(() => {
    const box = document.querySelector('[data-role="token-issued"]');
    return { hidden: box.hidden, value: box.querySelector('[data-role="token-value"]').value };
  })()`);
  check('重新打开也拿不到原文（服务端只存哈希）', reopened.hidden === true && reopened.value === '',
    `hidden=${String(reopened.hidden)}`);

  // 吊销 → 状态变化
  await evaluate(`(() => {
    const btn = document.querySelector('[data-role="token-revoke"]');
    if (btn) btn.click();
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-role="token-list"] .token-row[data-state="revoked"]') !== null`, '吊销生效', 15000);
  check('吊销后行状态变为 revoked', true, '');
  await shot('d-token-revoked');

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
