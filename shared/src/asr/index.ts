/**
 * ASR（语音 BYO）纯逻辑层（v0.1.7 / T15.6）。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：预设表（数据）、失败文案（判据）、`/models` 的地址与解析。
 * 不做：录音、真实 HTTP、密钥存储 —— 那些在客户端壳里。
 *
 * 与 `st-adapter` 同一个分层理由：纯逻辑能在 Node 里跑单测，
 * 不需要麦克风、不需要真厂商 key、不需要 Android 设备。
 *
 * ## 一条贯穿本层的纪律
 *
 * **每一句给用户看的话，都必须能指导下一步动作。**
 * 「配置不可用」不合格（用户不知道该改什么）。
 * 这层的所有文案常量都是按这条写的，改动前先读 `errors.ts` 的分流表。
 */

export * from './preset-table.js';
export * from './errors.js';
export * from './models.js';
export * from './gradio.js';
export * from './gradio-verdict.js';
