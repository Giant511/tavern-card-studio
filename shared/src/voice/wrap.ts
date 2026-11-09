/**
 * 语音文本的包裹（v0.1.7 / T15.6 终版）。
 *
 * 一句话：把 ASR 转写出来的裸文本，按用户选的模式套上一层**确定的**字面符号，
 * 让对面（ST 里的角色、读消息的人）能分辨"这是说的话 / 这是动作 / 这是消息"。
 *
 * ## 为什么用字面符号而不是给消息打标记
 *
 * 因为**包裹后的文本就是消息本体**。ST 那边零特殊处理 —— 它只是一条普通的
 * 用户消息，里面带着引号。任何"给消息附加类型让 ST 渲染成不同样式"的方案都
 * 要求改 ST 前端，而那不是我们能碰的（契约 §5.4：v1 不改 ST 前端）。
 *
 * ## 三模式的字面值
 *
 * | 模式 | 包裹后 |
 * |---|---|
 * | `speak` | `“文本”`（**中文弯引号** U+201C / U+201D） |
 * | `inner` | `(文本)` |
 * | `message` | `「文本」`（直角引号 U+300C / U+300D） |
 *
 * `speak` 必须用弯引号而不是 ASCII `"`：中文正文里直引号视觉上太窄、
 * 与字体不搭，而且容易与代码/JSON 里的引号混淆。这一条在测试里按
 * **码位**断言，不按字形 —— 否则「看起来像」的直引号也能通过。
 */

import { type VoiceMode, DEFAULT_VOICE_MODE } from './types.js';

/**
 * 每个模式接受的包裹符对。
 *
 * `inner` 有两对：半角 `()` 与全角 `（）`。原因是中文语境下 ASR 完全可能
 * 自己吐出全角括号（"（笑）"），那时再包一层半角就变成 `((笑))`。
 * 两者是**同一个语义包裹**，所以都算"已包裹"。
 */
const WRAPPER_PAIRS: Record<VoiceMode, ReadonlyArray<readonly [string, string]>> = {
  speak: [['\u201C', '\u201D']],
  inner: [
    ['(', ')'],
    ['\uFF08', '\uFF09'],
  ],
  message: [['\u300C', '\u300D']],
};

/** 主包裹符（渲染 chip 预览、拼文案时用第一个） */
const PRIMARY_PAIRS: Record<VoiceMode, readonly [string, string]> = {
  speak: ['\u201C', '\u201D'],
  inner: ['(', ')'],
  message: ['\u300C', '\u300D'],
};

/**
 * 这段文本是不是**已经被同类符号包过**了。
 *
 * 判据刻意收得很窄：**必须同时以该模式的开符开头、以闭符结尾**。
 *
 * 为什么不用"包含"：文本里出现一个引号太常见了（`他说“你好”`），
 * 用"包含"就会拒绝包裹，于是 `他说“你好”` 原样发出去，用户看到的
 * 是一条**没有语音标记**的消息 —— 比多重一层引号更糟。
 *
 * 窄判据的代价是：`“开头但没有结尾` 这种半残输入会被再包一层，得到
 * `““开头但没有结尾”`。这是可接受的 —— 它至少还是"一条说话"，
 * 而半残引号本来就是 ASR 的脏输出。
 */
export function isAlreadyWrapped(text: string, mode: VoiceMode): boolean {
  for (const [open, close] of WRAPPER_PAIRS[mode]) {
    // 单独一个字符的极端情况：`text === open` 不算已包裹（缺闭符）
    if (text.length <= open.length + close.length - 1) continue;
    if (text.startsWith(open) && text.endsWith(close)) return true;
  }
  return false;
}

/** 空文本 / 纯空白的判定。**这类输入不发送**（不是"发个空引号"）。 */
export function isBlankVoiceText(text: string): boolean {
  // 用 trim 而不是正则：中文全角空格 U+3000 也是 \s，trim 覆盖得到，
  // 而手写字符类很容易漏掉 U+3000 / U+00A0 这类。
  return text.trim().length === 0;
}

/** `wrapVoiceText` 的结果。用判别式而不是 `string | null`，把原因带出来。 */
export type WrapVoiceResult =
  | { ok: true; text: string; mode: VoiceMode; wrapped: boolean }
  | { ok: false; reason: 'blank' };

/**
 * 按模式包裹语音文本。
 *
 * `wrapped: false` 表示"识别到已有同类包裹，原样返回" —— 调用方据此可以
 * 在待确认条上提示"已是引用格式"，而不是让用户困惑于"我选了说话怎么没变"。
 *
 * 不做 trim：ASR 输出的首尾空白本身就该保留（用户在句尾的停顿是有意义的），
 * 而"纯空白不发送"由 `isBlankVoiceText` 单独判。
 */
export function wrapVoiceText(
  text: string,
  mode: VoiceMode = DEFAULT_VOICE_MODE,
): WrapVoiceResult {
  if (isBlankVoiceText(text)) {
    return { ok: false, reason: 'blank' };
  }
  if (isAlreadyWrapped(text, mode)) {
    return { ok: true, text, mode, wrapped: false };
  }
  const [open, close] = PRIMARY_PAIRS[mode];
  return { ok: true, text: `${open}${text}${close}`, mode, wrapped: true };
}

/**
 * 便捷包装：只要文本，不要结果对象。
 *
 * **空文本返回空串**（而不是抛错）。理由：调用链上游已经用
 * `isBlankVoiceText` 拦过一道，走到这里还空说明是异常路径；
 * 抛错会让一次"用户说话太轻没录到"变成崩溃，代价不对等。
 */
export function wrapVoiceTextOrEmpty(text: string, mode: VoiceMode = DEFAULT_VOICE_MODE): string {
  const result = wrapVoiceText(text, mode);
  return result.ok ? result.text : '';
}

/** 三模式的包裹符（UI 做 chip 预览、提示文案时用，别再自己写死一份） */
export function voiceWrapper(mode: VoiceMode): readonly [string, string] {
  return PRIMARY_PAIRS[mode];
}
