/**
 * 仓库令牌「连接入口」的校验（v0.1.3 / F5 后半）。
 *
 * ## 解决什么问题
 *
 * 仓库令牌一直能签发，但客户端**没有任何地方能用它**：登录要用户名密码，
 * 设置页的 legacy 令牌框吃的是服务端的全局 token，而 `tcr_` 开头的仓库令牌
 * 在界面上无处可粘。等于签出来只能手写 curl —— 需求说的"两套凭证路径"
 * 实际上只有一条能用。
 *
 * 这里给出服务端的判定，登录界面的第三个入口调它。
 *
 * ## 分类与「防枚举」的取舍（这段是这一批最需要解释的）
 *
 * 返回四类原因：格式错误 / 已吊销 / 已过期 / 无效。
 *
 * **「令牌不存在」与「无效」必须是同一句话**（需求明确要求）。
 * 原因是存在性是最敏感的信息：多一个分支就等于给攻击者一个
 * "这把令牌存不存在"的探针。
 *
 * 那为什么「已吊销」「已过期」可以单独说？因为它们**必须以"你手里已经有这把令牌"
 * 为前提**才能被观察到 —— 而令牌是 32 字节 CSPRNG（`randomBytes(32)` 的 base64url，
 * 256 位熵），猜不出来也枚举不了。也就是说：
 *
 *   · 攻击者**没有**令牌 → 他只能得到「无效」，与"不存在"完全同一句；
 *   · 攻击者**有**令牌 → 存在性对他已经不是秘密（他手上就是），
 *     此时告诉他"被吊销了"是**净收益**：否则他只会看到"无效"，
 *     然后去查是不是抄错了、是不是版本不对，白耗半天。
 *
 * 这个取舍与登录那条（用户名/密码错误一律同文案）并不冲突：登录的枚举面在
 * **账户**上，账户名是低熵、可批量试的；仓库令牌是高熵、不可枚举的。
 * 两条规则保护的对象不同，所以判据也不同。
 *
 * ## 另一条铁律
 *
 * 「不存在」「令牌有效但仓库没了」「令牌有效但账户被禁用」**一律归到 `invalid`**。
 * 前两条是同一个存在性面；第三条如果单独提示，等于告诉外面"这个令牌属于一个
 * 已被禁用的账户"，而令牌本身仍然不该被继续使用。
 */

import type { RepoStore, TokenScope, TokenStore } from '../storage/repos.js';
import { parseScopes } from '../storage/repos.js';

/** `tcr_` + 32 字节 base64url。长度固定 4 + 43 = 47 字符 */
const TOKEN_PATTERN = /^tcr_[A-Za-z0-9_-]{43}$/;

/**
 * 只做**格式**判断，不查库。
 *
 * 放在服务端而不是只放客户端：客户端的校验是"体验"，服务端的校验是"判据"。
 * 只靠客户端的话，任何绕过界面的调用方都会把畸形字符串打到查库路径上。
 */
export function looksLikeRepoToken(raw: string): boolean {
  return TOKEN_PATTERN.test(raw);
}

export type RepoTokenEntryFailure =
  /** 形态不对（没前缀、长度错、含非法字符）—— 不查库就能判，无泄露面 */
  | 'format'
  /** 令牌存在但已被吊销 */
  | 'revoked'
  /** 令牌存在但已过期 */
  | 'expired'
  /** 不存在 / 仓库已删 / 账户已禁用 —— 合并成一句，防枚举 */
  | 'invalid';

export interface RepoTokenEntrySuccess {
  ok: true;
  tokenId: string;
  repoId: string;
  repoName: string;
  scopes: TokenScope[];
  username: string;
  /** ISO 时间；null = 永不过期 */
  expiresAt: string | null;
  /** 上次使用时间（ISO），从未用过为 null —— 用于界面判断"这把令牌是不是第一次用" */
  lastUsedAt: string | null;
}

export interface RepoTokenEntryError {
  ok: false;
  reason: RepoTokenEntryFailure;
  status: number;
  /**
   * 与 `error.ts` 的 ErrorCode 逐字对应。
   *
   * 这里写成字面量联合而不是 `string`：路由层要把它直接传给 AppError，
   * 用 string 会编译失败（真实报错过一次），而用 `ErrorCode` 又会让本模块
   * 依赖整个错误码表 —— 它只可能产出这四个，显式列出更容易看出边界。
   */
  code: 'TOKEN_FORMAT_INVALID' | 'TOKEN_REVOKED' | 'TOKEN_EXPIRED' | 'TOKEN_INVALID';
  message: string;
  hint?: string;
}

export type RepoTokenEntryResult = RepoTokenEntrySuccess | RepoTokenEntryError;

export interface RepoTokenEntryDeps {
  tokens: TokenStore;
  repos: RepoStore;
  users: {
    findById(id: string): { id: string; username: string; status: string } | null;
  };
  now?: () => Date;
}

/**
 * 校验一把仓库令牌，给出「能不能用它进入单仓库模式」以及**为什么不能**。
 *
 * 顺序是刻意的：格式 → 查库 → 吊销 → 过期 → 仓库 → 账户。
 * 前两步之后每多一个分支都可能是信息泄露点，所以后三步的失败一律折叠成
 * `invalid` 同一句文案（见文件头）。
 */
export function verifyRepoTokenEntry(raw: string, deps: RepoTokenEntryDeps): RepoTokenEntryResult {
  if (!looksLikeRepoToken(raw)) {
    return {
      ok: false,
      reason: 'format',
      status: 400,
      code: 'TOKEN_FORMAT_INVALID',
      message: '令牌格式不对：应当是 tcr_ 开头的 47 个字符',
      hint: '检查是否漏复制、是否把「令牌前缀」当成了完整令牌（前缀只有 12 个字符）',
    };
  }

  const now = deps.now?.() ?? new Date();
  const row = deps.tokens.findByRaw(raw);

  // ── 以下三步用「不存在」与「无效」同一句文案 ──────────────
  //
  // 注意 row === null 这一支：**不能**返回"令牌不存在"。它与 invalid 必须
  // 逐字节相同，包括 hint —— 否则等于从 hint 里把答案漏出去。
  if (row === null) return invalidResult();

  // 吊销/过期放在存在性判断**之后**：先确认"这把是我们签的"，才谈得上状态。
  if (deps.tokens.isRevoked(row)) {
    return {
      ok: false,
      reason: 'revoked',
      status: 401,
      code: 'TOKEN_REVOKED',
      message: '此令牌已被吊销，不能再使用',
      hint: '请在签发它的客户端里重新签发一把，或用账户登录',
    };
  }
  if (deps.tokens.isExpired(row, now)) {
    return {
      ok: false,
      reason: 'expired',
      status: 401,
      code: 'TOKEN_EXPIRED',
      message: '此令牌已过期',
      hint: '请在签发它的客户端里重新签发一把，或用账户登录',
    };
  }

  const repo = deps.repos.findById(row.repo_id);
  if (repo === null) return invalidResult();
  // 令牌与仓库归属不一致 —— 正常路径不可能出现（签发时同源），
  // 但库里若被手工改过，这里必须挡住，而不是"按令牌算"越权到别人的仓库
  if (repo.owner_id !== row.owner_id) return invalidResult();

  const user = deps.users.findById(row.owner_id);
  if (user === null || user.status !== 'active') return invalidResult();

  const scopes = parseScopes(row.scopes);
  if (scopes.length === 0) {
    // 范围被收到空 = 事实上不可用。归到 invalid 而不是编一个新原因：
    // 对用户来说"这把令牌什么都做不了"，与"无效"是同一个处置。
    return invalidResult();
  }

  return {
    ok: true,
    tokenId: row.id,
    repoId: row.repo_id,
    repoName: repo.name,
    scopes,
    username: user.username,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * 「无效」的唯一文案。
 *
 * 抽成函数而不是字面量：一旦它被复制成两份，两处措辞会在某次改动里漂移，
 * 于是"不存在"与"无效"又能被区分开了 —— 这正是要防的东西。
 */
function invalidResult(): RepoTokenEntryError {
  return {
    ok: false,
    reason: 'invalid',
    status: 401,
    code: 'TOKEN_INVALID',
    message: '令牌无效',
    hint: '确认令牌完整复制（tcr_ 开头、共 47 个字符），且没有被吊销',
  };
}
