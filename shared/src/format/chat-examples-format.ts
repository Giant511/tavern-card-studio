/**
 * 「对话示例」的说话人写法：`{{user}}:` ↔ 平台自定义写法（如 `用户：`）。
 *
 * ## 为什么需要
 *
 * 真机取证（2026-11-11）：用户的自定义平台规则要求
 *
 * ```text
 *   ^(用户|角色)[:：]     至少 2 轮
 * ```
 *
 * 而 ST 标准卡里是 `{{user}}:` / `{{char}}:`。于是：
 *
 * ```text
 *   卡是 ST 格式    → 内置规则通过，用户规则报错
 *   卡是用户格式    → 用户规则通过，内置规则报错
 * ```
 *
 * **两条规则互斥，没有一种卡能同时过。** 用户要的是"导入时按我的规则解析"——
 * 也就是把 ST 的写法**渲染成**他平台的写法，导出时再转回去。
 *
 * ## 为什么必须双向
 *
 * 只做导入方向：`{{user}}:` → `用户：`。用户在板块里编辑后导出，
 * `mes_example` 里就写进了 `用户：` —— 而 **ST 不认 `用户：` 当说话人标记**，
 * 那张卡在 ST 里就是坏的（整段读不到）。
 *
 * 所以渲染与解析必须成对。这条铁律与 `greeting-preset` 那条同源。
 *
 * ## 为什么只认行首
 *
 * ```text
 *   用户：我饿了               ← 说话人行，要转
 *   他说“用户：这个词…”         ← 正文里的引用，不能动
 * ```
 *
 * 按 `^` 锚定（允许前导空白），与内置规则的 pattern 保持同一口径。
 * 转全文会把正文里的引用一并改掉，那种数据损坏事后极难发现。
 */

import type { GreetingFormatParams } from './greeting-preset.js';

/** 说话人键 → 占位符。只支持这两个，与 ST 的宏一一对应。 */
const SPEAKER_TOKENS = {
  user: '{{user}}',
  char: '{{char}}',
} as const;

type SpeakerKey = keyof typeof SPEAKER_TOKENS;

/**
 * 取某个说话人的自定义写法（已剥掉末尾冒号）。
 *
 * 返回 `null` = 用户没配，保持占位符原样。
 *
 * 为什么剥冒号：预设里可能写 `'用户'` 也可能写 `'用户：'`（有人习惯带）。
 * 两种都接受，统一用全角冒号拼接 —— 中文语境下 `用户：` 才是常见写法，
 * 而规则 pattern 一般写成 `[:：]` 两种都认，所以用哪个都能过。
 */
function speakerLabel(key: SpeakerKey, format: GreetingFormatParams): string | null {
  const raw = format.labelMap?.[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/[:：]\s*$/, '');
  return trimmed === '' ? null : trimmed;
}

/**
 * 渲染：ST 原文 → 用户可编辑的写法。
 *
 * `{{user}}:` → `用户：`，`{{char}}:` → `角色：`。只动行首。
 */
export function renderChatExamples(
  text: string,
  format: GreetingFormatParams | undefined,
): string {
  if (format === undefined || text === '') return text;

  let out = text;
  for (const key of ['user', 'char'] as const) {
    const label = speakerLabel(key, format);
    if (label === null) continue;
    const token = SPEAKER_TOKENS[key];
    /*
     * 冒号三种形态都收：半角、全角、以及"没有冒号但有空白分隔"。
     *
     * 保留前导空白（缩进）与冒号后的内容，只替换"标记 + 冒号"这一段。
     * 用 `m` 而不是 `g` + `^`：`g` 只匹配第一处，`m` 让 `^` 认每一行行首。
     */
    out = out.replace(
      new RegExp(`^(\\s*)${escapeRegExp(token)}\\s*[:：]`, 'gm'),
      `$1${label}：`,
    );
    /* 没写冒号的写法（`{{user}} 你好`）不转 —— 那本来就不是合法说话人行 */
  }
  return out;
}

/**
 * 解析：用户写法 → ST 原文（渲染的逆运算）。
 *
 * `用户：` → `{{user}}:`，`角色：` → `{{char}}:`。只动行首。
 *
 * ★ 这一步在**导出**时跑。跑不到的话，`mes_example` 里会留下
 * `用户：` 这种 ST 不认的写法 —— 卡导进 ST 后整段对话示例读不到。
 */
export function parseChatExamples(
  text: string,
  format: GreetingFormatParams | undefined,
): string {
  if (format === undefined || text === '') return text;

  let out = text;
  for (const key of ['user', 'char'] as const) {
    const label = speakerLabel(key, format);
    if (label === null) continue;
    const token = SPEAKER_TOKENS[key];
    /*
     * 反向：`用户：` → `{{user}}:`。
     *
     * ★ 一定要用**半角**冒号写出占位符后面那个冒号 —— 这是 ST 的约定。
     *   写成全角 `{{user}}：` 时，内置规则 `example-macro-halfwidth-colon`
     *   会报"宏后面用了全角冒号"，而 ST 解析说话人也只认半角。
     */
    out = out.replace(
      new RegExp(`^(\\s*)${escapeRegExp(label)}\\s*[:：]`, 'gm'),
      `$1${token}:`,
    );
  }
  return out;
}

/** 正则转义（标签里可能出现 `[` `】` 这类字符） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 这段文本里有没有用户格式的说话人行。
 *
 * 给"导出时检查映射是否完整"用：如果板块里还剩 `用户：` 没被转成
 * `{{user}}:`，说明预设与正文不一致（用户改过标签但没改正文），
 * 那要提示而不是安静导出。
 */
export function countUserSpeakerLines(text: string, format: GreetingFormatParams | undefined): number {
  if (format === undefined || text === '') return 0;
  let count = 0;
  for (const key of ['user', 'char'] as const) {
    const label = speakerLabel(key, format);
    if (label === null) continue;
    const m = text.match(new RegExp(`^\\s*${escapeRegExp(label)}\\s*[:：]`, 'gm'));
    count += m?.length ?? 0;
  }
  return count;
}
