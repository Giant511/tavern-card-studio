/**
 * 聊天面板的纯逻辑层（v0.1.7 / T15.5）。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：swipe 切换、手势头判定、生成请求拼装、生成中状态机。
 * 不做：DOM、触摸事件、HTTP、流式连接 —— 那些在 `client/src/chat/` 与 Rust 侧。
 *
 * 与 `st-adapter` / `voice` 同一个分层理由：纯逻辑能在 Node 里跑单测，
 * 不需要真 ST、不需要浏览器、不需要触摸屏。
 *
 * ## 四块的分工
 *
 * | 文件 | 职责 | 对应验收 |
 * |---|---|---|
 * | `swipe.ts` | 候选切换，`mes` 与 `swipes[swipe_id]` 同步 | 左滑切候选 |
 * | `gesture.ts` | 起手位置决定手势归属 | 两条轨迹对拍（契约 §8.2） |
 * | `generate.ts` | 六后端源 + 采样参数随请求体 | API 连接页 / 决策 #269 |
 * | `stream.ts` | 流式四相位 + 打字机可断言 | 流式可见（陷阱 #10） |
 *
 * ## 与 `st-adapter` 的边界
 *
 * `st-adapter` 管「与 ST 说话的协议细节」（URL、SSE 帧、消息形状、上下文拼装）；
 * 本层管「聊天面板自己的交互语义」（滑到哪、切哪个候选、停在哪一步）。
 * 前者是协议，后者是交互 —— 混在一起会让"改一个手势"要去动协议代码。
 */

export * from './swipe.js';
export * from './opening.js';
export * from './gesture.js';
export * from './generate.js';
/*
 * 思考模式能力表（2026-11-07，P0）。
 *
 * 单独导出的理由：UI 层要读 `PROFILES` 来渲染"思考长度"滑杆、
 * 判断当前模型是否强制思考（置灰主开关）。让它从 `generate.js`
 * 间接可见不如显式导出 —— 依赖关系写清楚，改能力表时不用翻两层。
 */
export * from './reasoningProfiles.js';
export * from './stream.js';
export * from './scroll.js';
export * from './settings-schema.js';
export * from './sampling-bridge.js';
export * from './bridge-error.js';
export * from './engine-status.js';
export * from './character-list.js';
export * from './boot-wait.js';
export * from './presets.js';
export * from './select-placement.js';
export * from './prompt-config.js';
export * from './prompt-assemble.js';
export * from './token-budget.js';
export * from './prompt-toggle.js';
export * from './prompt-edit.js';
export * from './nav.js';
export * from './author-note.js';
export * from './api-persist.js';
export * from './persona.js';
