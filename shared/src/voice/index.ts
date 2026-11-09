/**
 * 语音交互纯逻辑层（v0.1.7 / T15.6 终版）。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：模式定义、字面包裹、语音标记、滑动命中、振幅→柱高。
 * 不做：录音、真实 ASR 调用、密钥存储、DOM 渲染 —— 那些在客户端壳里。
 *
 * 与 `asr` / `st-adapter` 同一个分层理由：纯逻辑能在 Node 里跑单测，
 * 不需要麦克风、不需要真厂商 key、不需要 Android 设备。
 *
 * ## 四块的分工
 *
 * | 文件 | 职责 | 对应的验收项 |
 * |---|---|---|
 * | `types.ts` | 三模式与默认值 | 滑动未命中回落、会话记忆默认值 |
 * | `wrap.ts` | `wrapVoiceText` 字面包裹 | 三模式字面值 / 防双包裹 / 空文本拒绝 |
 * | `flag.ts` | `extra.tcs.voice` 挂载 | 标记随消息 round-trip |
 * | `gesture.ts` | 滑动命中测试 | 滑动选模式、未命中回落 |
 * | `waveform.ts` | 振幅 → 柱高、松手停帧 | 假振幅序列断言高度变化 |
 * | `confirm.ts` | 确认流状态机（含「取消=作废」） | 确认开关两态 |
 *
 * ## 与 `asr` 的关系：**两套独立配置，互不可见**
 *
 * `asr` 管"怎么把声音转成文字"（base_url + key + model，厂商模板表）；
 * 本层管"转出来的文字怎么变成一条消息"。
 * 前者是**外部服务凭据**，后者是**本地交互规则**。
 *
 * 这个边界不只是概念洁癖 —— 需求重申过「防接线合并」：
 * 两者的配置项、存储位置、读写时机都不同，改任一侧不该动另一侧（决策 #309）。
 */

export * from './types.js';
export * from './wrap.js';
export * from './flag.js';
export * from './gesture.js';
export * from './waveform.js';
export * from './bar-width.js';
export * from './confirm.js';
export * from './key-field.js';
