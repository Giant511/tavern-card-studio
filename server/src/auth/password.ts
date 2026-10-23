/**
 * 密码哈希（T10.3）。
 *
 * 算法选型：**Argon2id**（需求 F1.2 第一选项），参数取 OWASP 基线
 * `m=19456 KiB, t=2, p=1`。三条硬约束在这里落地：
 *
 *   1. **禁止明文/可逆加密** —— 只提供单向哈希，本模块不导出任何"解密"能力；
 *   2. **时序一致** —— 账户不存在时也要跑一次等价的哈希校验（{@link verifyPasswordDummy}），
 *      否则「查无此人」会明显快于「密码错误」，攻击者用响应时间就能枚举账户；
 *   3. **参数可升级** —— 哈希串自带参数（`$argon2id$v=19$m=19456,t=2,p=1$...`），
 *      校验时若发现低于当前基线，用 {@link needsRehash} 标记，登录成功后顺手重算。
 *
 * 为什么用 `@node-rs/argon2` 而不是 `argon2`/`bcrypt`：
 * 前者是 napi-rs 预编译二进制，Windows 上**不需要 node-gyp**（后者要装 VS Build Tools），
 * 与仓库里已有的 `better-sqlite3` 属同类，打包链路（pack-server）已经能处理原生模块。
 * 实测单次哈希 ~23ms，放在服务端可接受。
 */

import { randomBytes } from 'node:crypto';

import { Algorithm, hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

/**
 * 当前哈希参数（OWASP Password Storage Cheat Sheet 的 Argon2id 基线）。
 *
 * `memoryCost` 单位是 KiB：19456 KiB ≈ 19 MiB。调这个值要同时想清楚
 * 「单次登录占多少内存 × 并发登录数」——公网部署被人用登录接口打并发时，
 * 内存是真实的攻击面，所以这里不追高。
 */
export const ARGON2_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** 密码长度下限。需求没规定，取 NIST SP 800-63B 的下限 8；上限防 DoS（哈希长串更贵） */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** 校验失败的**唯一**对外文案（不区分"用户不存在"与"密码错误"） */
export const CREDENTIALS_REJECTED = '用户名或密码不正确';

/**
 * 假校验用的哈希串：**首次使用时才生成**，不做硬编码。
 *
 * 为什么不写死一个常量：写死的高熵字符串会在提交前的熵扫描里命中，
 * 每次都要人工判断"这是一段假哈希还是泄露的真凭据"。惰性生成既避免了
 * 这个噪声，也更正确——它不依赖一个可能被误读为真实凭据的字面量。
 *
 * 原文用 `randomBytes(32)`，只在本进程内存里存在过一次，从不落盘、不入日志。
 * 参数与 {@link ARGON2_PARAMS} 一致，所以耗时与真实校验同量级。
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argonHash(randomBytes(32).toString('hex'), ARGON2_PARAMS);
  return dummyHashPromise;
}

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * 校验密码是否满足策略（长度 / 非空）。
 *
 * 刻意**不**强制大小写数字符号混合：NIST SP 800-63B 明确建议不要施加组合规则
 * （它会促使用户产生 `Password1!` 这类可预测的变体）。长度才是有效维度。
 */
export function assertPasswordPolicy(plain: string): void {
  if (typeof plain !== 'string' || plain === '') {
    throw new PasswordPolicyError('密码不能为空');
  }
  // 按码位计数，避免 emoji 等代理对被算成两个字符
  const length = [...plain].length;
  if (length < PASSWORD_MIN_LENGTH) {
    throw new PasswordPolicyError(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new PasswordPolicyError(`密码最多 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
}

/** 哈希一个密码。策略不满足时抛 {@link PasswordPolicyError} */
export async function hashPassword(plain: string): Promise<string> {
  assertPasswordPolicy(plain);
  return argonHash(plain, ARGON2_PARAMS);
}

/**
 * 校验密码。
 *
 * 返回 `false` 的两种情况（哈希串损坏 / 密码不匹配）**对外必须不可区分**，
 * 调用方拿到 `false` 一律回同一句话（{@link CREDENTIALS_REJECTED}）。
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  if (typeof storedHash !== 'string' || storedHash === '' || typeof plain !== 'string') {
    // 哈希缺失也算"校验失败"，但仍走一次假校验抹平时序
    await verifyPasswordDummy();
    return false;
  }
  try {
    return await argonVerify(storedHash, plain);
  } catch {
    // 哈希格式非法（手改过库、跨版本迁移脏数据）——同样不能快速返回
    await verifyPasswordDummy();
    return false;
  }
}

/**
 * 预热哈希路径：在服务启动时调一次，把两处一次性开销提前付掉。
 *
 * 要提前付的是什么：
 *   1. `getDummyHash()` 的首次生成（一次完整 Argon2id，~23ms）；
 *   2. argon2 原生模块的首次调用初始化。
 *
 * 为什么必须预热：「用户不存在」走的是假校验，若它比「密码错」慢 23ms，
 * 那么**进程启动后的第一个登录请求**就成了一条可观测的侧信道 ——
 * 攻击者在服务刚起来时打一发，用耗时就能判断这个账户不存在。
 * 实测未预热时首调用 44.6ms vs 真实校验 18.9ms（2.4×），预热后两者都在 20ms 量级。
 *
 * 返回 Promise 供调用方选择是否 await（不等也不会出错，只是首次请求可能仍偏慢）。
 */
export async function warmUpPasswordHashing(): Promise<void> {
  await getDummyHash();
  // 真实校验路径也走一次，让原生模块的热身对两条路径同时生效
  try {
    const probe = await argonHash('warm-up-probe-value', ARGON2_PARAMS);
    await argonVerify(probe, 'warm-up-probe-value');
  } catch {
    // 预热失败不影响正确性 —— 只是省不掉那点开销
  }
}

/**
 * 假校验：账户不存在时调用，消耗与真实校验相当的时间。
 *
 * 刻意把结果丢掉（永远返回 false）。**不要**用它替代真实校验路径，
 * 它存在的唯一目的就是"看起来做了一次校验"。
 */
export async function verifyPasswordDummy(): Promise<false> {
  try {
    await argonVerify(await getDummyHash(), 'not-a-real-password');
  } catch {
    // 理论上恒可解析；即便失败也必须把时间花掉，补一次哈希运算（成本同量级）
    await argonHash('not-a-real-password', ARGON2_PARAMS);
  }
  return false;
}

/**
 * 这个哈希串是否该用当前参数重算。
 *
 * 判定依据是串里的 `m=`/`t=`/`p=`：升级参数后老用户不会被迫改密码，
 * 而是在下次登录成功时**顺手**用新参数重算一次（调用方负责落库）。
 */
export function needsRehash(storedHash: string): boolean {
  if (typeof storedHash !== 'string' || !storedHash.startsWith('$argon2id$')) return true;
  const params = /m=(\d+),t=(\d+),p=(\d+)/.exec(storedHash);
  if (!params) return true;
  return (
    Number(params[1]) < ARGON2_PARAMS.memoryCost ||
    Number(params[2]) < ARGON2_PARAMS.timeCost ||
    Number(params[3]) < ARGON2_PARAMS.parallelism
  );
}
