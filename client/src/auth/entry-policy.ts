/**
 * 入口状态（v0.1.2 追加任务：凭证门槛错序修复）。
 *
 * ## 这一层要解决的问题
 *
 * v0.1.2 的客户端把「令牌」当成了**连接的前置条件**：
 * `isSyncReady()` 要求 `tokenValid === true`，于是没填全局令牌时
 * 同步入口全灰、顶栏显示「鉴权未通过」，而登录/注册界面又挂在这套连接状态后面 ——
 * 结果就是「先有令牌才能登录」，顺序整个反了。
 *
 * 正确的分层是：
 *
 * | 层 | 由什么决定 | 说明 |
 * |---|---|---|
 * | **能不能开始** | 服务端地址是否配置 | 地址可达即可登录，**不需要任何令牌** |
 * | **能做哪些事** | 凭证（账户身份 / 仓库令牌 / legacy 令牌） | 令牌只决定范围，不决定入口 |
 *
 * `login` / `register` / `refresh` / `config` 四个端点在服务端本来就是免鉴权的
 * （见 `server/src/config.ts` 的 `publicPaths`），所以客户端这边把令牌当门槛
 * 纯属自己加的锁。
 *
 * ## 为什么这些判断要单独成文件
 *
 * 它们决定「按钮能不能点、面板显示哪句话」，而这类规则写进对话框里就只能靠截图验。
 * 这里全是纯函数，可以在 Node 里把状态矩阵跑遍（`test/entry-policy.test.mjs`）。
 */

import type { AuthPhase } from './session.ts';
import type { AuthUser } from './auth-client.ts';
import type { ProbeResult } from '../net/server-probe.ts';

/** 服务端地址处于哪种状态 */
export type ServerReach = 'no-server' | 'unreachable' | 'reachable';

/** 账户入口（登录/注册界面）该不该放行 */
export type AccountEntryState = 'no-server' | 'anonymous' | 'authenticated';

/**
 * 同步能力的状态。
 *
 * 注意这里**没有** `unreachable`：地址不通是"这次请求会失败"，
 * 不是"你不能进这个面板"。面板进去后能看到具体错误，比在门外弹一句
 * 「同步未就绪」有用得多 —— 后者正是本次要修的症状。
 */
export type SyncGateState = 'no-server' | 'need-login' | 'ready';

/** 地址是否已配置（只管"有没有"，不管"通不通"） */
export function hasServerUrl(serverUrl: string | null | undefined): boolean {
  return typeof serverUrl === 'string' && serverUrl.trim() !== '';
}

/**
 * 可达性。`probe === null` 表示"还没探测过"，归到 `unreachable` 只用于展示，
 * **绝不能拿它去拦入口** —— 那会让"刚打开客户端、探测还没回来"的几百毫秒里
 * 登录按钮点不动。
 */
export function resolveServerReach(
  serverUrl: string | null | undefined,
  probe: ProbeResult | null,
): ServerReach {
  if (!hasServerUrl(serverUrl)) return 'no-server';
  return probe?.reachable === true ? 'reachable' : 'unreachable';
}

/**
 * 账户入口状态。
 *
 * 只看两件事：地址有没有配、当前是不是已登录。
 * **不看令牌、不看探测结果** —— 这就是「令牌门槛从连接层下放到凭证层」的全部含义。
 */
export function resolveAccountEntry(
  serverUrl: string | null | undefined,
  phase: AuthPhase,
): AccountEntryState {
  if (!hasServerUrl(serverUrl)) return 'no-server';
  return phase === 'authenticated' ? 'authenticated' : 'anonymous';
}

/**
 * 能否打开登录/注册界面。
 *
 * 只有"连地址都没有"时不放行 —— 那种情况下登录请求必然失败，
 * 放行等于让用户填完用户名密码再看一句"尚未配置服务端地址"。
 * 地址有了就放行：通不通由登录请求自己回答，那是**凭证层**的事。
 */
export function canOpenAccount(entry: AccountEntryState): boolean {
  return entry !== 'no-server';
}

/**
 * 同步门槛。
 *
 * 判据是「有没有凭证」，不是「服务端通不通」：
 *   · 没地址 → 先去配置；
 *   · 有地址没凭证 → 登录后可同步（面板照样能打开，只是显示这句话）；
 *   · 有凭证 → 放行，请求失败由面板自己报错。
 *
 * `hasCredentials` 包含 legacy 全局令牌：≤v0.1.1 的服务端本来就只有它，
 * 兼容模式要能干活（见设置面板的「高级 · 兼容模式」）。
 */
export function resolveSyncGate(
  serverUrl: string | null | undefined,
  hasCredentials: boolean,
): SyncGateState {
  if (!hasServerUrl(serverUrl)) return 'no-server';
  return hasCredentials ? 'ready' : 'need-login';
}

/** 顶栏状态胶囊的文字 */
export function connectionLabel(
  serverUrl: string | null | undefined,
  probe: ProbeResult | null,
  phase: AuthPhase,
): { text: string; tone: 'on' | 'warn' | 'off' } {
  const reach = resolveServerReach(serverUrl, probe);
  if (reach === 'no-server') return { text: '未配置', tone: 'off' };
  if (reach === 'unreachable') return { text: '未连接', tone: 'off' };
  // 可达：区分"登录了"与"只是通了"。后者不是错误状态，别用红色吓人。
  return phase === 'authenticated'
    ? { text: '已连接', tone: 'on' }
    : { text: '已连接 · 未登录', tone: 'warn' };
}

/** 设置面板 / 顶栏里的身份行 */
export function identityLabel(phase: AuthPhase, user: AuthUser | null): string {
  if (phase === 'authenticated' && user !== null) {
    return `已登录：${user.username}（${user.role === 'admin' ? '管理员 · ' : ''}账户令牌）`;
  }
  if (phase === 'expired') {
    return user === null ? '登录已过期' : `登录已过期（${user.username}）`;
  }
  return '未登录';
}

/** 同步面板在非 ready 状态时的那句话 */
export function syncGateMessage(state: SyncGateState): string {
  switch (state) {
    case 'no-server':
      return '还没配置服务端地址：填好地址后即可登录并同步。';
    case 'need-login':
      // 需求原话：未登录时显示「登录后可同步」，而不是"未连接"
      return '登录后可同步。';
    default:
      return '';
  }
}

/**
 * 同步条上的提示语（顶栏下面那行）。
 *
 * 与 `syncGateMessage` 分开：那里是面板内的整句，这里是顶栏的短提示。
 */
export function syncHintText(
  gate: SyncGateState,
  cardCount: number | null | undefined,
): { text: string; tone: 'ok' | 'warn' } {
  if (gate === 'ready') {
    return {
      text:
        cardCount === null || cardCount === undefined
          ? '同步已就绪'
          : `同步已就绪 · 服务端现有 ${String(cardCount)} 张卡`,
      tone: 'ok',
    };
  }
  if (gate === 'need-login') return { text: '登录后可同步（编辑 / 审计 / 导出不受影响）', tone: 'warn' };
  return { text: '填好服务端地址后即可登录并同步（本地功能不受影响）', tone: 'warn' };
}
