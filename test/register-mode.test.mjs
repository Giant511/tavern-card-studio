/**
 * F12 注册策略 UI 化（T10.17）。
 *
 * 三件事必须一起验证，缺一个就会留下"看起来生效、其实没有"的口子：
 *   ① 配置补丁接受 registerMode，且非法值不会把策略改成别的状态；
 *   ② 热生效：面板写文件后，**已在运行的 worker** 立刻按新策略判定
 *      （不是重启后生效 —— 两个进程不共享内存，这是最容易写错的地方）；
 *   ③ 面板本身：三个单选项、切到 open 必过确认框、"最近注册账户"只在开放时出现。
 *
 * ② 用真实进程验证：同一进程内改配置 → 立刻注册成功。纯函数测不出跨进程行为。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createDefaultConfig } from '../server/dist/config.js';
import { LiveRegisterMode } from '../server/dist/config-live.js';
import { applyConfigPatch } from '../server/dist/supervisor.js';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'server', 'dist', 'index.js');
const NODE = process.execPath;

// ══════════════════════════════════════════════════════════
// ① 配置补丁
// ══════════════════════════════════════════════════════════

const baseConfig = () => createDefaultConfig({ token: 'x'.repeat(32) });

test('补丁：三种合法值原样写入', () => {
  for (const mode of ['closed', 'open', 'admin-only']) {
    const next = applyConfigPatch(baseConfig(), { auth: { registerMode: mode } });
    assert.equal(next.auth.registerMode, mode);
  }
});

test('补丁：字段缺席＝保持原值（改个端口不会顺手把策略改回默认）', () => {
  const current = { ...baseConfig(), auth: { ...baseConfig().auth, registerMode: 'open' } };
  const next = applyConfigPatch(current, { port: 9001 });
  assert.equal(next.port, 9001);
  assert.equal(next.auth.registerMode, 'open', '未提交 registerMode 时必须保持');
});

test('补丁：非法值保持原值，不落到其它状态', () => {
  const current = { ...baseConfig(), auth: { ...baseConfig().auth, registerMode: 'admin-only' } };
  for (const bad of ['OPEN', 'true', '', null, 1, ['open']]) {
    const next = applyConfigPatch(current, { auth: { registerMode: bad } });
    assert.equal(next.auth.registerMode, 'admin-only', `非法值 ${JSON.stringify(bad)} 不应改策略`);
  }
});

// ══════════════════════════════════════════════════════════
// ② 热生效读取器（纯函数级）
// ══════════════════════════════════════════════════════════

test('热生效：文件变了就跟着变，且不需要重建实例', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-livemode-'));
  const file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ auth: { registerMode: 'closed' } }), 'utf8');
    const live = new LiveRegisterMode(file, 'closed');
    assert.equal(live.current(), 'closed');

    writeFileSync(file, JSON.stringify({ auth: { registerMode: 'open' } }), 'utf8');
    assert.equal(live.current(), 'open', '同一个实例必须读到新值');

    writeFileSync(file, JSON.stringify({ auth: { registerMode: 'admin-only' } }), 'utf8');
    assert.equal(live.current(), 'admin-only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('热生效：坏 JSON / 缺字段保持上一次的值（不要因为一次半写入就关门）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tcs-livemode2-'));
  const file = join(dir, 'config.json');
  try {
    writeFileSync(file, JSON.stringify({ auth: { registerMode: 'open' } }), 'utf8');
    const live = new LiveRegisterMode(file, 'closed');
    assert.equal(live.current(), 'open');

    writeFileSync(file, '{"auth": {"registerMode": "op', 'utf8'); // 写到一半
    assert.equal(live.current(), 'open', '解析失败必须保持旧值');
    assert.match(String(live.lastError), /解析失败/);

    writeFileSync(file, JSON.stringify({ auth: {} }), 'utf8');
    assert.equal(live.current(), 'open', '字段缺失也必须保持旧值');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('热生效：文件不存在时回落到构造时的值', () => {
  const live = new LiveRegisterMode(join(tmpdir(), 'does-not-exist-tcs.json'), 'admin-only');
  assert.equal(live.current(), 'admin-only');
});

// ══════════════════════════════════════════════════════════
// ③ 面板静态守卫
// ══════════════════════════════════════════════════════════

const html = readFileSync(join(ROOT, 'server', 'public', 'index.html'), 'utf8');
const panelJs = readFileSync(join(ROOT, 'server', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'server', 'public', 'styles.css'), 'utf8');

test('面板：三个单选项齐全，值与 registerMode 的枚举一致', () => {
  assert.match(html, /id="cfg-registerMode"/, '缺少注册策略区块');
  for (const mode of ['closed', 'admin-only', 'open']) {
    assert.ok(
      html.includes(`name="cfg-registerMode" value="${mode}"`),
      `缺少 ${mode} 这一档`,
    );
  }
  assert.match(html, /最近注册账户/, '开放态需要能看到最近注册的账户');
});

test('面板：切到「开放」必过确认框，且取消会退回原选择', () => {
  assert.match(panelJs, /function confirmOpenRegistration/, '缺少确认框');
  assert.match(panelJs, /确定要开放自助注册吗/, '确认框必须明确问一次');
  assert.match(panelJs, /建议只在内网使用/, '必须写出使用建议（内网 / 白名单）');
  assert.match(panelJs, /setRegisterMode\(state\.status/, '取消后必须退回上一个已保存的状态');
  assert.ok(
    panelJs.includes("input.value === 'open' && input.checked"),
    '必须只在"切到 open"时拦截，改回其它两档不该弹框',
  );
});

test('面板：保存时带上 registerMode，且开放态刷新账户列表', () => {
  assert.ok(
    panelJs.includes('registerMode: registerModeValue()'),
    '保存 payload 必须带 registerMode（否则改了配置却没保存）',
  );
  assert.ok(
    panelJs.includes("if (registerModeValue() === 'open') await loadRecentAccounts()"),
    '保存后若为开放态，必须刷新"最近注册账户"',
  );
  assert.match(panelJs, /\/control\/accounts\?limit=20/, '账户列表要读控制面接口');
  assert.match(panelJs, /\/status`, \{/, '禁用入口要调 status 接口');
});

test('面板：风险说明是常驻块，不是一闪而过的 toast', () => {
  assert.match(html, /id="regmode-open-warn"/, '缺少常驻风险块');
  assert.match(css, /\.warn-box\s*\{/, '缺少常驻警告块样式');
  assert.match(css, /\.data-table\s*\{/, '缺少账户表样式');
});

// ══════════════════════════════════════════════════════════
// ④ 真进程：改配置 → 不重启 → 立刻生效
// ══════════════════════════════════════════════════════════

let child = null;
let workDir = '';
let port = 0;
let configPath = '';

/**
 * 包一层瞬时错误重试。
 *
 * 全量并行跑时这套用例偶发 `read ECONNRESET`（单独跑 12/12 稳定）：
 * 本机同时起十来个服务进程，Windows 的 listen backlog 在高并发下会重置连接。
 * 这条用例要证的是"策略热更生效"，不是"TCP 在多负载下有多稳" ——
 * 所以只对 ECONNRESET 重试一次，其它错误照常抛出（别把真故障吞掉）。
 */
async function request(path, options = {}, attempt = 0) {
  try {
    return await requestOnce(path, options);
  } catch (error) {
    if (attempt === 0 && error?.code === 'ECONNRESET') {
      await delay(120);
      return request(path, options, 1);
    }
    throw error;
  }
}

function requestOnce(path, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'tcs-f12-'));
  configPath = join(workDir, 'config.json');
  port = 26500 + Math.floor(Math.random() * 400);
  child = spawn(
    NODE,
    [
      ENTRY,
      'serve',
      '--config', configPath,
      '--port', String(port),
      '--control-port', String(port + 1),
      '--host', '127.0.0.1',
      '--control-host', '127.0.0.1',
      '--data-dir', join(workDir, 'store'),
      '--log-level', 'warn',
    ],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));

  let lastProbe = '(从未探测)';
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await delay(200);
    if (!existsSync(configPath)) {
      lastProbe = '配置文件尚未生成';
      continue;
    }
    try {
      const res = await request('/api/health');
      lastProbe = `HTTP ${res.status}`;
      if (res.status === 200) return;
    } catch (error) {
      lastProbe = error?.code ?? String(error);
    }
  }
  throw new Error(`服务未能就绪（最后一次探测 ${lastProbe}）：\n${logs.join('')}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await delay(500);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test('真进程：closed 下注册被拒，改配置为 open 后**同一进程**立刻可注册', async () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.auth.registerMode, 'closed', '默认必须是 closed');

  const denied = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'first-user', password: 'first-password-1' },
  });
  assert.equal(denied.status, 403, 'closed 下必须拒绝注册');
  assert.equal(denied.json?.error?.code, 'REGISTRATION_CLOSED');

  // 客户端看到的策略也必须一致
  const before = await request('/api/auth/config');
  assert.equal(before.json?.registerMode, 'closed', '客户端应看到 closed（不显示注册入口）');

  // ── 模拟管理面板保存：只改 auth.registerMode ──
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, auth: { ...config.auth, registerMode: 'open' } }, null, 2),
    'utf8',
  );

  // 不重启、不等待：下一个请求就该按新策略判定
  const allowed = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'second-user', password: 'second-password-1' },
  });
  assert.equal(allowed.status, 201, `改配置后应立即允许注册：${allowed.text}`);
  assert.equal(allowed.json?.user?.username, 'second-user');

  const afterConfig = await request('/api/auth/config');
  assert.equal(afterConfig.json?.registerMode, 'open', '/api/auth/config 必须同一时刻反映新策略');

  // 新账户能登录（注册链路真的通，不只是回执 201）
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { username: 'second-user', password: 'second-password-1' },
    token: config.auth.token,
  });
  assert.equal(login.status, 200, `新账户应能登录：${login.text}`);
  assert.ok(typeof login.json?.accessToken === 'string' && login.json.accessToken.length > 0);
});

test('真进程：再改回 closed，同一进程立刻拒绝（热更双向都有效）', async () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(
    configPath,
    JSON.stringify({ ...config, auth: { ...config.auth, registerMode: 'closed' } }, null, 2),
    'utf8',
  );
  const denied = await request('/api/auth/register', {
    method: 'POST',
    body: { username: 'third-user', password: 'third-password-1' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.json?.error?.code, 'REGISTRATION_CLOSED');
});
