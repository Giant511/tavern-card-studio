/**
 * 功能：把服务端返回的登录会话整理成界面能直接渲染的形状：设备名、元信息、排序。
 *
 * 注意事项：
 *   - 纯函数，不碰 DOM、不碰网络，除「当前时间」外不读别的东西，Node 里能直接跑；
 *   - 只给相对时间。不显示绝对时间，跨时区时用户会误判这是哪台设备；
 *   - `current` 由服务端判定，这里只把它排到第一行，不重新猜。
 *
 * 踩过的坑：无（首次实现）。
 */

/** 服务端 `/api/account/sessions` 的一条（字段与 `account-routes.ts` 的 DTO 一致） */
export interface AccountSessionLike {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string;
  userAgent: string;
  current: boolean;
}

/**
 * 浏览器家族。顺序有意义：Edge 的 UA 里同时含 `Chrome`，
 * 先判 Edge 才不会被认成 Chrome。
 */
const BROWSER_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg(?:e|A|iOS)?\//i, 'Edge'],
  [/OPR\/|Opera/i, 'Opera'],
  [/Firefox\//i, 'Firefox'],
  [/Chrome\//i, 'Chrome'],
  [/Safari\//i, 'Safari'],
];

const OS_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/Windows NT 10\.0/i, 'Windows'],
  [/Windows/i, 'Windows'],
  [/Android/i, 'Android'],
  [/iPhone|iPad|iPod/i, 'iOS'],
  [/Mac OS X|Macintosh/i, 'macOS'],
  [/Linux/i, 'Linux'],
];

/**
 * 把 User-Agent 压成「浏览器 · 系统」。
 *
 * 认不出就原样截断到 40 字符。一串看不懂的 UA 也比「未知设备」有用：
 * 用户至少能认出这是自己那台旧笔记本上的浏览器。
 */
export function summarizeUserAgent(userAgent: string): string {
  const text = (userAgent ?? '').trim();
  if (text === '') return '未知设备';

  let browser = '';
  for (const [pattern, name] of BROWSER_FAMILIES) {
    if (pattern.test(text)) {
      browser = name;
      break;
    }
  }

  let os = '';
  for (const [pattern, name] of OS_FAMILIES) {
    if (pattern.test(text)) {
      os = name;
      break;
    }
  }

  if (browser === '' && os === '') {
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  return [browser, os].filter((part) => part !== '').join(' · ');
}

/**
 * 「最近活动」的相对描述。
 *
 * 未来时间按「刚刚」处理。客户端和服务端时钟有偏差时，显示「3 分钟后」
 * 只会让人以为界面坏了。
 */
export function describeLastSeen(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '时间未知';

  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${String(minutes)} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} 小时前`;

  const days = Math.floor(hours / 24);
  return `${String(days)} 天前`;
}

/** 一行会话的主文案：设备名 + 元信息（IP / 最近活动） */
export function describeSession(
  item: AccountSessionLike,
  now: number = Date.now(),
): { title: string; meta: string } {
  const ip = (item.ip ?? '').trim();
  return {
    title: summarizeUserAgent(item.userAgent),
    meta: `${ip === '' ? 'IP 未知' : ip} · 最近活动 ${describeLastSeen(item.lastSeenAt, now)}`,
  };
}

/**
 * 当前设备排第一，其余按最近活动倒序。
 *
 * 不能只按 id 或登录时间排。用户打开面板，第一眼要找的是「我现在在哪台机器上」。
 */
export function sortSessions<T extends AccountSessionLike>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    const leftAt = Date.parse(left.lastSeenAt);
    const rightAt = Date.parse(right.lastSeenAt);
    return (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0);
  });
}
