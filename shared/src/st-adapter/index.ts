/**
 * st-adapter 统一出口（v0.1.7 / T15.4）。
 *
 * ## 分层（契约 §6.1）
 *
 * ```text
 * client/src/chat/                 ← UI（夜航设计语言），只依赖接口，不认识 HTTP
 *        ↓
 * shared/src/st-adapter/           ← 本目录：类型 + 纯逻辑（URL 拼装 / SSE 解析 / 消息归一 / 上下文拼装）
 *        ↓
 * client/src-tauri/src/st_api.rs   ← 真正的 HTTP（reqwest + cookie jar + CSRF）
 * ```
 *
 * ## 为什么 HTTP 不在这一层
 *
 * 三个理由，每个都对应一类真实事故：
 *
 * 1. **CORS 免疫**：需求文档 §二要求 App↔ST 走 Rust HTTP。渲染层的 fetch 会被
 *    同源策略与 `SameSite=Lax` 拦住（v0.1.6 缺陷三已踩过）。
 * 2. **可测**：纯逻辑能在 Node 里跑单测，不需要起 ST 容器。契约测试只验形状，
 *    不需要浏览器。
 * 3. **cookie 归我们管**：Rust 侧持有 cookie jar，不受浏览器策略影响（契约 §2.2）。
 */

export * from './types.js';
export * from './endpoints.js';
export * from './sse.js';
export * from './messages.js';
export * from './settings.js';
export * from './context.js';
export * from './chat-file.js';
