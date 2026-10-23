// T10.4 冒烟：起一个真服务端，跑通 注册→登录→me→刷新→登出→吊销后失效
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const work = mkdtempSync(join(tmpdir(), 'tcs-t104-'));
const dataDir = join(work, 'store');
const configPath = join(work, 'config.json');
const port = 19210 + Math.floor(Math.random() * 200);
const token = 'smoke-global-token-0123456789abcdef';

writeFileSync(
  configPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      port,
      controlPort: port + 1,
      host: '127.0.0.1',
      controlHost: '127.0.0.1',
      dataDir,
      rulesDir: 'rules',
      defaultPlatformRule: 'sillytavern',
      defaultPreset: 'default',
      maxUploadBytes: 33554432,
      logLevel: 'warn',
      auth: { token, require: true, publicPaths: ['/api/health'], registerMode: 'open' },
      service: { mode: 'process', name: 'T104Smoke', displayName: 'T104', autoStart: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

const child = spawn(process.execPath, ['server/dist/index.js', 'worker', '--config', configPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

const base = `http://127.0.0.1:${port}`;
async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await delay(100);
  }
  throw new Error('服务端没起来');
}

async function call(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
};

try {
  await waitReady();

  const reg = await call('/api/auth/register', { method: 'POST', body: { username: 'owner', password: 'owner-password-1' } });
  check('注册成功', reg.status === 201 && !!reg.json?.accessToken, `status=${reg.status} code=${reg.json?.code ?? '-'}`);

  const dup = await call('/api/auth/register', { method: 'POST', body: { username: 'OWNER', password: 'other-password-1' } });
  check('重复用户名被拒（同码同文案）', dup.status === 400 && /无法完成注册/.test(dup.json?.error?.message ?? ''), `status=${dup.status} ${(dup.json?.error?.message ?? '').slice(0, 30)}`);

  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner-password-1' } });
  check('登录成功', login.status === 200 && !!login.json?.accessToken, `status=${login.status}`);

  const wrongPw = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong-password' } });
  const noUser = await call('/api/auth/login', { method: 'POST', body: { username: 'ghost-user', password: 'wrong-password' } });
  check('密码错与用户不存在逐字节相同', wrongPw.text === noUser.text && wrongPw.status === noUser.status, `${wrongPw.status} vs ${noUser.status}`);

  const me = await call('/api/auth/me', { auth: login.json.accessToken });
  check('/me 返回本人', me.status === 200 && me.json?.user?.username === 'owner', `status=${me.status}`);

  const legacy = await call('/api/auth/me', { auth: token });
  check('legacy 全局 token 仍可用', legacy.status === 200 && legacy.json?.via === 'legacy', `via=${legacy.json?.via}`);

  const refresh = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: login.json.refreshToken } });
  // 判据不看"令牌字符串是否不同"：同一秒内同一会话签出的 JWT，payload 完全一致，
  // 字符串自然相同 —— 那是正常的，不是缺陷。真正要证明的是"新令牌能用"。
  const refreshedMe = refresh.json?.accessToken
    ? await call('/api/auth/me', { auth: refresh.json.accessToken })
    : { status: 0 };
  check(
    'refresh 换到可用 access（且过期时间不早于旧令牌）',
    refresh.status === 200 &&
      refreshedMe.status === 200 &&
      new Date(refresh.json.accessExpiresAt).getTime() >= new Date(login.json.accessExpiresAt).getTime(),
    `status=${refresh.status} me=${refreshedMe.status}`,
  );

  const replay = await call('/api/auth/refresh', { method: 'POST', body: { refreshToken: login.json.refreshToken } });
  check('旧 refresh 用一次后失效（轮换生效）', replay.status === 401, `status=${replay.status}`);

  const logout = await call('/api/auth/logout', { method: 'POST', auth: refresh.json.accessToken });
  check('登出成功', logout.status === 200, `status=${logout.status}`);

  const afterLogout = await call('/api/auth/me', { auth: refresh.json.accessToken });
  check('登出后该 access token 立刻失效（吊销立即生效）', afterLogout.status === 401, `status=${afterLogout.status}`);

  const cards = await call('/api/cards');
  check('无凭证访问受保护接口被拒', cards.status === 401, `status=${cards.status}`);
} finally {
  child.kill();
  // 每次跑都留一个临时库在 %TEMP% 里会越积越多（实测跑几次就 3 个目录），
  // 这里自己收拾干净 —— 与"后台进程要显式停"是同一条纪律。
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
process.exit(failed.length === 0 ? 0 : 1);
