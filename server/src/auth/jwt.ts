/**
 * JWT（HS256）签发与校验（T10.4）。
 *
 * 为什么自己实现而不引 `jsonwebtoken` / `jose`：
 *   · 服务端要打进 MSI 离线安装，依赖越少越好（与 router.ts 同一个理由）；
 *   · 我们只需要 HS256 一种算法、两种令牌，需求面窄到可以完整覆盖并有测试；
 *   · 第三方库的"算法混淆"类历史漏洞（`alg: none`、RS256→HS256 混用）
 *     在我们这里结构上不可能发生 —— **我们只接受 `alg === 'HS256'`**，
 *     并且不读 header 里的任何其它字段来做决策。
 *
 * 安全相关的一条**硬规则**：`verify` 只从 header 里取 `alg` 用于**拒绝**，
 * 绝不用它选择算法实现。任何 `alg` 不是 `HS256` 的令牌直接判失败。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  /** 用户 id */
  sub: string;
  /** 会话 id（吊销以会话为单位，见 sessions.ts） */
  sid: string;
  /** 角色快照。仅用于省一次查库做粗粒度判断；**权限判定仍以库里为准** */
  role: 'admin' | 'user';
  /** 签发时间（秒） */
  iat: number;
  /** 过期时间（秒） */
  exp: number;
}

export type JwtFailure =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid';

export interface JwtVerifyResult {
  ok: boolean;
  payload: JwtPayload | null;
  reason: JwtFailure | null;
}

function base64UrlEncode(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(signingInput: string, secret: string): string {
  return base64UrlEncode(createHmac('sha256', secret).update(signingInput, 'utf8').digest());
}

/**
 * 签发令牌。
 *
 * `ttlSeconds` 由调用方给出（access 2h / refresh 各自的策略在 auth/service.ts 里）。
 * 这里不提供默认值，避免"忘了传就用了某个意外时长"。
 */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body: JwtPayload = { ...payload, iat: nowSeconds, exp: nowSeconds + ttlSeconds };
  const bodyEncoded = base64UrlEncode(JSON.stringify(body));
  const signingInput = `${header}.${bodyEncoded}`;
  return `${signingInput}.${sign(signingInput, secret)}`;
}

/**
 * 校验令牌。
 *
 * 失败原因分得比较细（便于日志排查），但**对外一律返回同一句**
 * ——原因细到"签名错 vs 过期"就已经够攻击者用了，不该出现在 HTTP 响应里。
 */
export function verifyJwt(token: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): JwtVerifyResult {
  const fail = (reason: JwtFailure): JwtVerifyResult => ({ ok: false, payload: null, reason });

  if (typeof token !== 'string' || token === '') return fail('malformed');
  const parts = token.split('.');
  if (parts.length !== 3) return fail('malformed');
  const [headerEncoded, bodyEncoded, signature] = parts as [string, string, string];

  let header: unknown;
  try {
    header = JSON.parse(base64UrlDecode(headerEncoded).toString('utf8'));
  } catch {
    return fail('malformed');
  }
  // 只认 HS256。**不要**按 header 里声明的算法去选实现 —— 那正是算法混淆的来源。
  if (typeof header !== 'object' || header === null || (header as { alg?: unknown }).alg !== 'HS256') {
    return fail('unsupported_algorithm');
  }

  const expected = sign(`${headerEncoded}.${bodyEncoded}`, secret);
  const providedBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // 长度不等时 timingSafeEqual 会抛错，先比长度（长度本身不是秘密）
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return fail('bad_signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(bodyEncoded).toString('utf8'));
  } catch {
    return fail('malformed');
  }
  if (typeof payload !== 'object' || payload === null) return fail('malformed');

  const record = payload as Record<string, unknown>;
  if (typeof record['sub'] !== 'string' || record['sub'] === '') return fail('malformed');
  if (typeof record['sid'] !== 'string' || record['sid'] === '') return fail('malformed');
  if (typeof record['exp'] !== 'number' || !Number.isFinite(record['exp'])) return fail('malformed');
  const iat = typeof record['iat'] === 'number' ? record['iat'] : 0;
  if (nowSeconds >= record['exp']) return fail('expired');
  // 容忍 5 分钟时钟漂移：多机部署时客户端与服务端的时钟不一定完全同步，
  // 但 iat 在未来太多说明令牌来路可疑
  if (iat > nowSeconds + 300) return fail('not_yet_valid');

  return {
    ok: true,
    payload: {
      sub: record['sub'],
      sid: record['sid'],
      role: record['role'] === 'admin' ? 'admin' : 'user',
      iat,
      exp: record['exp'],
    },
    reason: null,
  };
}
