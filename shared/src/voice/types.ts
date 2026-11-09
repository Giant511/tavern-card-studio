/**
 * 语音交互的公共类型（v0.1.7 / T15.6 终版）。
 *
 * ## 三种模式的定位
 *
 * 用户在聊天面板按住麦克风时，上方浮起三个 chip 让他**用滑动选**模式：
 *
 * | 模式 | 字面包裹 | 语义 | 典型用法 |
 * |---|---|---|---|
 * | `speak` | `“…”` | 我说的话 | 角色扮演里"我"开口 |
 * | `inner` | `(…)` | 内心/动作 | 旁白、动作描写、心里想 |
 * | `message` | `「…」` | 消息 | 像发一条短信/微信那样引用 |
 *
 * ## 为什么模式是**确定的字面拼接**，不是让 LLM 分类
 *
 * 三条理由，按重要性排：
 *
 * 1. **可预测**。用户选了什么就得到什么，不存在"模型理解错了"这种
 *    无法申诉的失败。语音输入本来就是高频小动作，任何不确定性都会被放大。
 * 2. **零延迟**。拼接是本地字符串操作，不用等网络、不用花钱。
 * 3. **可测**。`wrapVoiceText` 是纯函数，三模式的期望值能写成字面断言
 *    （`test/voice-wrap.test.mjs`）。LLM 分类只能测"大概对"。
 *
 * 决策 #303。
 */

/** 三种语音模式。顺序即 chip 从左到右的显示顺序（最常用在最左，拇指最先够到）。 */
export const VOICE_MODES = ['speak', 'inner', 'message'] as const;

export type VoiceMode = (typeof VOICE_MODES)[number];

/**
 * 默认模式。
 *
 * 定成 `speak` 而不是"上次用的那个"：新会话、冷启动都从这里开始。
 * 最常用路径必须是**零额外动作**的那条 —— 见决策 #304。
 */
export const DEFAULT_VOICE_MODE: VoiceMode = 'speak';

/** chip 上显示的文字（emoji 由 UI 层拼，这里只要语义标签） */
export const VOICE_MODE_LABEL: Record<VoiceMode, string> = {
  speak: '说话',
  inner: '内心/动作',
  message: '消息',
};

/**
 * `spoken` 是给无障碍与日志用的英文标识。
 *
 * 不直接用中文当 key：日志、诊断导出、跨端（未来 iOS）都要认它，
 * 中文做标识符在 URL / 文件名 / shell 里都会踩坑。
 */
export const VOICE_MODE_ID: Record<VoiceMode, string> = {
  speak: 'speak',
  inner: 'inner',
  message: 'message',
};

/**
 * 是否是个合法模式。
 *
 * 用途是**读持久化/外部输入时收敛**，不是给内部代码做断言 ——
 * 内部代码拿到 `VoiceMode` 类型就不该再判。
 */
export function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && (VOICE_MODES as readonly string[]).includes(value);
}

/**
 * 把任意输入收敛成合法模式。
 *
 * 坏值一律回落 `DEFAULT_VOICE_MODE` 而不是报错：这个值来自配置与会话快照，
 * 可能被手改过或来自旧版本。为了一个显示模式把聊天面板拦下来，
 * 代价远大于"这次用错了模式"（用户看得见 chip，一秒就能改回来）。
 */
export function coerceVoiceMode(value: unknown): VoiceMode {
  return isVoiceMode(value) ? value : DEFAULT_VOICE_MODE;
}
