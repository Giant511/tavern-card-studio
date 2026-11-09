/**
 * 作者注释（Author's Note）—— 让它真的进上下文（2026-11-03，第二十七批）。
 *
 * ## 为什么需要这个文件
 *
 * 用户要求「先做作者注释」。而在此之前这一项是**只存 ST、不生效**的：
 *
 * ```text
 *   设置页能填 → 存进 extension_settings.note.default → 但拼请求时从不读它
 * ```
 *
 * 真机实测过 10 次（把注释设成"必须输出 BEHAVIOR-NOTE-ON"），一次都没出现。
 * 代码里也能看到：`note.default` 只出现在设置页的字段定义里。
 *
 * ## ST 的原始语义（`public/scripts/authors-note.js` 的 `setFloatingPrompt`）
 *
 * ```text
 *   lastMessageNumber = 用户消息条数
 *   if (interval === 1) lastMessageNumber = 1        // 间隔 1 = 每轮都插
 *   if (last <= 0 || interval <= 0) → 不插
 *   till = last >= interval ? last % interval : interval - last
 *   shouldAdd = (till === 0)
 * ```
 *
 * 默认值（ST 源码里的 `loadSettings`）：`depth = 4`、`interval = 1`、
 * `position = 1`（before）、`role = system`。
 *
 * ## 为什么要把判定抽成纯函数
 *
 * "每 N 轮插一次"这种规则最容易写错，而且错了**不报错**——
 * 表现只是"作者注释有时候生效有时候不生效"，极难归因。
 * 抽出来就能在 Node 里逐条断言。
 */

import type { PromptRole } from './prompt-config.js';

/** 作者注释的运行时配置 */
export interface AuthorNoteConfig {
  /** 注释正文。空串 = 不启用 */
  text: string;
  /** 插入深度：从末尾往前数第几条之前。ST 默认 4 */
  depth: number;
  /** 间隔：每 N 条用户消息插一次。ST 默认 1（每轮都插） */
  interval: number;
  /** 以什么身份插入。ST 默认 system */
  role: PromptRole;
}

/** ST 的默认值（抄自 `authors-note.js` 的 `loadSettings`） */
export const AUTHOR_NOTE_DEFAULTS = {
  depth: 4,
  interval: 1,
  role: 'system' as PromptRole,
} as const;

/** 深度上限（ST 的 `MAX_INJECTION_DEPTH`），防止用户填出离谱的值 */
const MAX_DEPTH = 100;

/** 把未知值收成一个安全整数，越界就退回默认 */
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 角色名 → PromptRole。ST 里存的是数字（0/1/2），也兼容字符串 */
function asRole(value: unknown): PromptRole {
  if (value === 1 || value === 'user') return 'user';
  if (value === 2 || value === 'assistant') return 'assistant';
  return 'system';
}

/**
 * 从 ST 的 `extension_settings.note` 解析出配置。
 *
 * ## 为什么允许缺字段
 *
 * ST 只在用户**手动改过**那一项时才把 `defaultDepth` 等写进 settings。
 * 没写过就是 `undefined` —— 此时必须退回 ST 的默认值，而不是当成 0。
 * 当成 0 的后果：`depth = 0` 会把注释插到最末尾，与用户预期完全相反。
 */
export function resolveAuthorNoteConfig(note: unknown): AuthorNoteConfig {
  if (note === null || typeof note !== 'object') {
    return { text: '', ...AUTHOR_NOTE_DEFAULTS };
  }
  const raw = note as Record<string, unknown>;

  return {
    text: typeof raw['default'] === 'string' ? raw['default'] : '',
    depth: asInt(raw['defaultDepth'], AUTHOR_NOTE_DEFAULTS.depth, 0, MAX_DEPTH),
    /*
     * 间隔下限是 **1**，不是 0。
     *
     * ST 里 `interval <= 0` 的意思是"禁用"。我们的界面上没有"禁用"这个
     * 开关（清空正文就等于不用），所以间隔收到 1 —— 避免出现
     * "填了注释却因为间隔是 0 从来不插"这种哑巴故障。
     */
    interval: asInt(raw['defaultInterval'], AUTHOR_NOTE_DEFAULTS.interval, 1, 1000),
    role: asRole(raw['defaultRole']),
  };
}

/**
 * 这一轮要不要插入作者注释。
 *
 * 逐行照搬 ST 的 `setFloatingPrompt`（含 `interval === 1` 的特例）。
 *
 * @param userMessageCount 当前历史里**用户**消息的条数
 * @param interval 每 N 轮插一次
 */
export function shouldInjectAuthorNote(userMessageCount: number, interval: number): boolean {
  if (interval <= 0) return false;

  /*
   * ★ 零条用户消息直接不插（2026-11-03）。
   *
   * 这一条**要放在 `interval === 1` 特例之前**。
   *
   * ST 的源码顺序是「先归一到 1，再判 `<= 0`」—— 于是
   * `(0 条消息, 间隔 1)` 在 ST 里会算出"要插"。那是因为 ST 只在
   * 生成时调它，那时必然已有 1 条用户消息，`0` 的情况不会出现。
   *
   * 我们这里多一层防护：万一将来有"预览上下文"之类的调用方在
   * 空对话上拼一次，不该凭空多出一条注释去占 token。
   * 判据：`test/author-note.test.mjs` 的「一条用户消息都没有时不插」。
   */
  if (userMessageCount <= 0) return false;

  let last = userMessageCount;
  /* ST 的特例：间隔 1 表示"每轮都插"，此时把计数归一成 1 */
  if (interval === 1) last = 1;

  const tillInsertion = last >= interval ? last % interval : interval - last;
  return tillInsertion === 0;
}
