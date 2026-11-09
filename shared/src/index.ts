/**
 * @tcs/shared 公共出口。
 * 阶段 0：模型与规则类型；阶段 1：ST JSON 解析/序列化、规则引擎、平台切换。
 */

export * from './model/json.js';
export * from './model/blocks.js';
export * from './model/repo-name.js';
export * from './repo/repo-target.js';
export * from './repo/card-import.js';
export * from './repo/embedded-worldbook.js';
export * from './chat/worldbook.js';
export * from './model/sillytavern.js';
export * from './model/unified-card.js';

export * from './text/count.js';

export * from './format/description.js';
export * from './format/greeting-preset.js';
export * from './format/field-preset.js';
export * from './format/field-blocks.js';
export * from './format/arrival.js';
// v0.1.7 / T15.5 消息正文渲染（零依赖，先转义再做标记）
export * from './format/message-md.js';
export * from './format/preset.js';
export * from './format/sillytavern-io.js';
export * from './format/worldbook.js';
export * from './format/worldbook-preset.js';
export * from './format/worldbook-io.js';
export * from './format/card-txt.js';
export * from './format/composite-scene.js';

// v0.1.4 / T12.2：PNG 卡的块级读写（纯 TS，零图像编解码）
export * from './png-card.js';

export * from './rules/platform-rule.js';
export * from './rules/highlight-rule.js';
export * from './rules/unknown-keys.js';
export * from './rules/rule-issue.js';
export * from './rules/platform-rule-parser.js';
export * from './rules/highlight-rule-parser.js';
export * from './rules/scopes.js';
export * from './rules/format-only-blocks.js';
export * from './rules/platform-rule-engine.js';
export * from './rules/worldbook-checks.js';
export * from './rules/platform-switch.js';

export * from './highlight/highlight-engine.js';
export * from './highlight/highlight-io.js';

export * from './audit/types.js';
export * from './audit/issue.js';
export * from './audit/word-count.js';
export * from './audit/st-defaults.js';
export * from './audit/format.js';
export * from './audit/report.js';

// v0.1.7 / T15.4：ST 内部 API 适配层（类型 + 纯逻辑，HTTP 在 Rust 侧）
export * from './st-adapter/index.js';

// v0.1.7 / T15.6：语音 BYO 的纯逻辑层（预设表 / 失败分流 / 模型列表）
export * from './asr/index.js';
// v0.1.7 / T15.6 语音交互纯逻辑（包裹 / 标记 / 滑动命中 / 波形）
export * from './voice/index.js';
// v0.1.7 / T15.5 聊天面板纯逻辑（swipe / 手势 / 生成 / 流式）
export * from './chat/index.js';
// v0.1.7 / T15.3 安卓端生命周期纯逻辑
export * from './android/index.js';
// v0.1.7 / T15.6 配置作用域（ASR 与语音偏好互不覆盖的强制点）
export * from './config-scopes.js';

// v0.1.7 / T15.4 决策 #270：世界书激活判定（审计与聊天共用的**唯一**一份）
export * from './rules/worldbook-activation.js';
