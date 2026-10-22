/**
 * 角色卡 ID（F11）—— 纯逻辑，无 DOM / 无副作用。
 *
 * 这个 ID 是**用户指定的稳定标识**，用途只有一个：让服务端按它归档
 * （同 ID 追加版本、新 ID 新建卡片）。它和「服务端主键」不是一回事：
 * 主键由服务端在自己那边生成，而这个 ID 在创建卡片时就定了，之后永不改变
 * —— 改了 ID 就等于换了一张卡（F11.2）。
 *
 * 存放位置：`data.extensions.tcs.cardId`
 *   · `extensions` 是 SillyTavern 规范里给第三方工具放自定义数据的字段，
 *     写在这里不会干扰其他平台读取；
 *   · **不放进 `meta`** —— meta 的字段会直接映射到 ST JSON 的顶层键，
 *     加一个 `cardId` 会被当成规范外字段带出去。
 *
 * 为什么 ID 必须不可变：服务端靠它认卡。一旦允许改，同一个 ID 下就会混进
 * 两个不同角色的历史版本，回滚时会把内容回滚到"另一个角色"上去。
 * 所以这里只提供生成与校验，**不提供修改函数**。
 */

/** ID 允许的最大长度。够长以容纳有意义的命名，又不至于撑坏 URL 与文件路径。 */
export const CARD_ID_MAX_LENGTH = 64;

/** 在 ST JSON 里存放本工具元数据的命名空间 */
export const TCS_EXTENSION_KEY = 'tcs';

export type CardIdIssue =
  | 'empty'
  | 'too-long'
  | 'bad-char'
  | 'edge-hyphen'
  | 'no-alnum';

export interface CardIdCheck {
  ok: boolean;
  /** 归一化后的 ID（ok 为 false 时为空串） */
  id: string;
  /** 具体哪里不合法，用于在对话框里就地提示 */
  issue?: CardIdIssue;
  message?: string;
}

/**
 * 校验用户输入的 ID。
 *
 * 规则（对应 F11.2「非空、无空白、无路径非法字符」）：
 *   · 只允许 `A-Z a-z 0-9 -`。这一条同时覆盖了"无空白"与"无路径非法字符"
 *     —— 空格、`/ \ : * ? " < > |` 全都不在允许集里；
 *   · 首尾不能是连字符（`-abc` / `abc-` 看起来像被截断的残值）；
 *   · 必须至少含一个字母或数字（`---` 这种通不过）。
 *
 * 不做大小写归一：用户填 `Lin-Wanzhao-001` 就存原样。
 * 静默转小写会让「明明填的一样却提示 ID 不同」变成新的困惑来源。
 */
export function validateCardId(raw: string): CardIdCheck {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, id: '', issue: 'empty', message: '角色卡 ID 不能为空' };
  }
  if (trimmed.length > CARD_ID_MAX_LENGTH) {
    return {
      ok: false,
      id: '',
      issue: 'too-long',
      message: `角色卡 ID 最长 ${CARD_ID_MAX_LENGTH} 个字符（当前 ${trimmed.length} 个）`,
    };
  }
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) {
    // 指出第一个非法字符，比"格式不对"有用得多
    const bad = [...trimmed].find((ch) => !/[A-Za-z0-9-]/.test(ch));
    return {
      ok: false,
      id: '',
      issue: 'bad-char',
      message: `只能使用字母、数字、连字符（发现「${bad ?? '?'}」）`,
    };
  }
  if (trimmed.startsWith('-') || trimmed.endsWith('-')) {
    return { ok: false, id: '', issue: 'edge-hyphen', message: '首尾不能是连字符' };
  }
  if (!/[A-Za-z0-9]/.test(trimmed)) {
    return { ok: false, id: '', issue: 'no-alnum', message: '至少要有一个字母或数字' };
  }
  return { ok: true, id: trimmed };
}

/**
 * 把字符名 slug 化，用于自动生成 ID。
 *
 * 中文名 slug 化后往往是空串（`林晚照` 没有任何 ASCII 字母），
 * 这时退回 `card` —— 所以调用方一定要拼上随机后缀，否则多张中文名的卡会撞成同一个 ID。
 */
export function slugifyCardName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug === '' ? 'card' : slug;
}

/** 短随机后缀：4 位 36 进制，约 168 万种组合，足够避免同名卡相撞 */
export function randomCardIdSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/**
 * 自动生成 ID（F11.2「留空则客户端自动生成」）。
 *
 * 格式 `<slug>-<4位随机>`，例如 `lin-wanzhao-a3f9`。
 * 生成值要**在对话框里明示给用户**（需求原文），因为它是之后找卡唯一稳定的线索。
 */
export function generateCardId(name: string): string {
  return composeCardId(name, randomCardIdSuffix());
}

/**
 * 用**固定的**后缀拼出 ID。
 *
 * 这是给"边输入边预览 ID"的场景用的：对话框里用户在名字框里打字时，
 * ID 会跟着变（slug 部分），但**后缀必须保持不变**。
 * 否则每敲一个字后缀就换一次，用户刚看到的 `card-be6p` 一转眼成了 `card-wrdj`，
 * 那个"生成值明示给用户"的要求就形同虚设 —— 明示了一个随手就变的值没有意义。
 */
export function composeCardId(name: string, suffix: string): string {
  const slug = slugifyCardName(name);
  // slug 可能已经占到 40 字符，加上后缀仍远小于上限
  return `${slug}-${suffix}`;
}

/**
 * 从卡数据里读出已有的 ID。
 *
 * 只读 `extensions.tcs.cardId`。返回 null 表示这张卡还没有 ID
 * （导入的外部 JSON 基本都是这种情况），由调用方决定何时生成并回填。
 *
 * 之所以容忍 `extensions` 整个缺失、以及 `tcs` 不是对象：
 * 导入的 JSON 来自各种来源，任何一层都可能不是预期形状，
 * 这里不能抛异常 —— 一张格式怪异的卡不该让整个打开流程失败。
 */
export function readCardIdFromCard(card: {
  passthrough?: { data?: Record<string, unknown> };
}): string | null {
  const data = card.passthrough?.data;
  if (!data || typeof data !== 'object') return null;

  const extensions = data['extensions'];
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) return null;

  const tcs = (extensions as Record<string, unknown>)[TCS_EXTENSION_KEY];
  if (!tcs || typeof tcs !== 'object' || Array.isArray(tcs)) return null;

  const value = (tcs as Record<string, unknown>)['cardId'];
  if (typeof value !== 'string') return null;

  // 读出来的值也要过一遍校验：手改过的 JSON 里可能是个非法 ID，
  // 直接拿去归档会在服务端造出一个以后无法寻址的卡片。
  const checked = validateCardId(value);
  return checked.ok ? checked.id : null;
}

/**
 * 把 ID 写进卡数据的 `data.extensions.tcs.cardId`，返回新对象。
 *
 * 不可变更新：不就地改传入的卡。`extensions` / `tcs` 已存在时保留其其它键
 * （用户或别的工具可能在这里放了东西，不能整块覆盖）。
 *
 * 这一层先写好，供 F11（T9.5）与按 ID 归档（T9.7）调用；
 * 当前 T9.1 只用它做往返测试。
 */
export function withCardId<T extends { passthrough?: { data?: Record<string, unknown> } }>(
  card: T,
  cardId: string,
): T {
  const checked = validateCardId(cardId);
  if (!checked.ok) {
    throw new Error(`角色卡 ID 不合法，无法写入：${checked.message ?? cardId}`);
  }

  const passthrough = card.passthrough ?? {};
  const data = (passthrough as { data?: Record<string, unknown> }).data ?? {};

  const prevExtensions = data['extensions'];
  const extensions =
    prevExtensions && typeof prevExtensions === 'object' && !Array.isArray(prevExtensions)
      ? { ...(prevExtensions as Record<string, unknown>) }
      : {};

  const prevTcs = extensions[TCS_EXTENSION_KEY];
  const tcs =
    prevTcs && typeof prevTcs === 'object' && !Array.isArray(prevTcs)
      ? { ...(prevTcs as Record<string, unknown>) }
      : {};

  tcs['cardId'] = checked.id;
  extensions[TCS_EXTENSION_KEY] = tcs;

  return {
    ...card,
    passthrough: {
      ...(passthrough as Record<string, unknown>),
      data: { ...data, extensions },
    },
  } as T;
}

/**
 * 在一组已打开的 ID 里检查重复，用于 F11.2「重复打开同 ID 的卡需提示该 ID 已打开」。
 *
 * 比较时忽略大小写：`Lin-001` 与 `lin-001` 在服务端会被当成两个不同的键
 * （我们不做归一），但对用户来说它们是同一张卡，提示一下更安全。
 * 这里只负责「提示」，不负责「拒绝」—— 是否允许并存由调用方决定。
 */
export function findDuplicateCardId(
  candidate: string,
  openIds: readonly string[],
): string | null {
  const target = candidate.trim().toLowerCase();
  if (target === '') return null;
  for (const id of openIds) {
    if (id.trim().toLowerCase() === target) return id;
  }
  return null;
}
