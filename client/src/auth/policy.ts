/**
 * 登录态的纯判断（T10.7）—— 不碰 DOM、不碰网络，便于单测。
 *
 * 单独成文件的原因：这些判断是"界面行为的规则"，写进对话框里就只能靠截图验；
 * 而"注册入口该不该出现""错误文案从哪来"恰恰是最需要被固定下来的两条规则。
 */

import type { AuthFailureCode, AuthPolicy, AuthUser, RegisterMode } from './auth-client.ts';
import type { AuthPhase } from './session.ts';

/**
 * 是否显示「注册」入口。
 *
 * 需求要求 closed 时**界面不显示**，而不是点了才报错 —— 后者等于拿用户当探测工具，
 * 而且会让人以为"注册功能坏了"。
 *
 * `admin-only` 是有条件显示：只有管理员登录后才有意义（管理员替人建号）。
 * 未登录时显示它，点了必然 403。
 */
export function shouldShowRegister(
  policy: AuthPolicy | null,
  user: AuthUser | null,
): boolean {
  if (policy === null) return false; // 取不到策略 → fail-closed
  switch (policy.registerMode) {
    case 'open':
      return true;
    case 'admin-only':
      return user !== null && user.role === 'admin';
    default:
      // 'closed' 以及任何未知值
      return false;
  }
}

/**
 * 注册模式的说明文案（登录框里那行小字）。
 *
 * 只描述**服务端当前策略**，不预测成败 —— 与"错误提示用服务端文案"同一原则：
 * 客户端不替服务端下结论。
 */
export function registerHint(mode: RegisterMode | null): string {
  switch (mode) {
    case 'open':
      return '本服务端开放自助注册：填好用户名与密码后可直接创建账户。';
    case 'admin-only':
      return '本服务端仅管理员可创建账户。请让管理员在「账户」里为你建号。';
    case 'closed':
      return '本服务端未开放自助注册。请让管理员用命令行 `tcs-server user add <用户名>` 创建账户。';
    default:
      return '正在读取服务端的注册策略…';
  }
}

/**
 * 认证失败的展示文案。
 *
 * **必须是服务端原话**：服务端刻意把「用户不存在 / 密码错 / 锁定中」压成同一句，
 * 客户端一旦按 code 分支翻译，就等于把这三种原因重新分开显示，枚举面在客户端重建。
 * 所以这里只做一件事：取 `displayMessage`，不做任何 code → 文案的映射。
 *
 * 用结构判断（`displayMessage` 是字符串）而不是 `instanceof AuthClientError`：
 * 这一层是纯逻辑，不该为了一个 `instanceof` 把网络层拉成运行时依赖。
 */
export function authErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { displayMessage?: unknown }).displayMessage;
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '操作失败（原因未知）';
}

function failureCode(error: unknown): AuthFailureCode | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? (code as AuthFailureCode) : null;
}

/** 只有网络类失败才值得提示"检查网络"，凭证类失败不能加这种暗示 */
export function isNetworkFailure(error: unknown): boolean {
  const code = failureCode(error);
  return code === 'NETWORK' || code === 'TIMEOUT';
}

/** 哪种失败值得自动弹登录框（凭证类），而不是只提示一句 */
export function isCredentialFailure(error: unknown): boolean {
  const code = failureCode(error);
  return code === 'BAD_CREDENTIALS' || code === 'FORBIDDEN' || code === 'REGISTER_CLOSED';
}

/** 顶栏账户按钮上的文字 */
export function phaseLabel(phase: AuthPhase, user: AuthUser | null): string {
  if (phase === 'expired') {
    return user ? `登录已过期（${user.username}）` : '登录已过期';
  }
  if (phase === 'authenticated' && user) {
    return user.role === 'admin' ? `${user.username}（管理员）` : user.username;
  }
  return '登录…';
}

/** 账户按钮的 title：说明当前状态与下一步动作 */
export function phaseTitle(phase: AuthPhase, user: AuthUser | null): string {
  if (phase === 'expired') return '登录已过期：点此重新登录（本地未保存的编辑不受影响）';
  if (phase === 'authenticated' && user) return `已登录：${user.username}。点此查看账户与卡片`;
  return '未登录：点此登录或注册账户';
}
