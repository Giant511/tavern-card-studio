//! 壳错误模型。
//!
//! 设计要点：
//!   · 每个变体都映射到一个**封闭的** `code`，前端按 code 分支，不解析文案（文案会变）；
//!   · 序列化成 `{ code, message, details? }`，details 只放结构化字段（偏移、字节数、路径）；
//!   · 路径只用于**错误文案**，业务逻辑里一律 `PathBuf`，不拿 `String` 当路径用。

use std::path::Path;

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShellError {
    #[error("路径为空")]
    EmptyPath,

    #[error("路径必须是绝对路径：{path}")]
    PathNotAbsolute { path: String },

    #[error("目标不是常规文件：{path}")]
    NotAFile { path: String },

    #[error("文件不存在：{path}")]
    PathNotFound { path: String },

    #[error("文件过大：{size} 字节，上限 {limit} 字节")]
    TooLarge { size: u64, limit: u64 },

    #[error("不是合法的 UTF-8：首个非法字节偏移 {offset}")]
    NotUtf8 { offset: usize },

    #[error("扩展名不被允许：{name}")]
    ExtNotAllowed { name: String },

    #[error("摘要不一致：期望 {expected}，实际 {actual}")]
    DigestMismatch { expected: String, actual: String },

    #[error("找不到内置规则目录（已尝试 TCS_RULES_DIR、资源目录 rules/、仓库根 rules/）")]
    RulesDirMissing,

    #[error("未知的规则类别：{kind}（只接受 platforms / presets / highlight）")]
    UnknownRuleKind { kind: String },

    #[error("路径越界，不在规则目录内：{path}")]
    PathNotAllowed { path: String },

    /// 一次请求的路径数超过上限（F15 / T13.1）。
    ///
    /// 为什么要有上限：`probe_paths` 是唯一接受「一次多个任意绝对路径」的命令，
    /// 没有上限的话它可以被当成"批量探测整台机器的目录存不存在"的扫描器。
    /// 上限取 64 —— ST 检测实际只用 2~10 条。
    #[error("一次最多探测 {limit} 条路径，收到 {count} 条")]
    TooManyPaths { count: usize, limit: usize },

    /// 启动目标被白名单拒绝（F15 / T13.1）。
    ///
    /// 单独一个错误码而不是复用 `PATH_NOT_ALLOWED`：前端要能一眼区分
    /// "这个目录不是 SillyTavern"（`SPAWN_REJECTED`，属于预期内的用户状态）
    /// 与"路径越界"（`PATH_NOT_ALLOWED`，属于越权尝试）。
    #[error("拒绝启动：{reason}（目标 {target}）")]
    SpawnRejected { target: String, reason: String },

    /// 探测目标主机不在回环白名单内（v0.1.6 / T14.0）。
    ///
    /// 单独一个码而不是复用 `SPAWN_REJECTED`：前者是"这个地址不允许被探测"
    /// （配置被改坏的典型症状），后者是"这个目录不是 ST"。UI 要分别给话说 ——
    /// 前者要指引用户去看配置，后者要指引用户去选目录。
    #[error("只允许探测本机回环地址（{allowed}），收到：{host}")]
    ProbeHostNotAllowed { host: String, allowed: String },

    #[error("IO 失败（{path}）：{message}")]
    Io { path: String, message: String },

    /// 参数本身不合法（2026-11-03 / 预设导入）。
    ///
    /// 与 `Io` 分开：这不是"文件读写出错"，是"你给的内容不对"。
    /// UI 要给的下一步动作完全不同 —— 前者让用户重试，后者让用户换个文件或改输入。
    #[error("{message}")]
    Invalid { message: String },

    // ── ST 的 HTTP 层（T15.4）───────────────────────────────
    //
    // 四个变体对应四种**用户要做的动作完全不同**的情况：
    //   · StUnavailable —— ST 没起来 / 地址不通 → 去检查 ST 有没有启动
    //   · StForbidden   —— cookie 过期且重连重试后仍然 403 → 提示重新登录
    //   · StHttpStatus  —— 服务端明确报错（4xx/5xx）→ 把状态码与响应摘要带出去
    //   · StBadResponse —— 响应形状不是预期的 JSON → 契约可能变了（ST 升级）
    //
    // 合并成一句"ST 请求失败"会让用户无从下手，也让排查丢掉最有用的那个信息。
    /*
     * ★★★ 2026-11-09：文案里不许出现 SillyTavern / ST。
     *
     * ## 为什么这条特别要紧
     *
     * 这个 `Display` **会被序列化成 message 交给前端**，而前端的规则是
     *
     * ```ts
     *   message: message === '' ? '连不上聊天服务' : message
     * ```
     *
     * 也就是说 **Rust 给什么就显示什么**，前端那层"人话"兜底被完全绕过。
     * 用户报的就是「连不上 ST」——他从没见过 SillyTavern 这个词，
     * 看到只会以为是自己不懂的东西坏了。
     *
     * ## 为什么判据一直没抓到
     *
     * `no-internal-terms.test.mjs` 的 `UI_FILES` 全是 `.ts`，**从不扫 Rust**。
     * 判据扫的是"我以为的 UI 层"，不是"用户真能看到的每一处文案"。
     */
    #[error("连不上聊天服务：{detail}")]
    StUnavailable { detail: String },

    #[error("{path} 返回 403（已重试：{retried}）—— 通常是会话过期了")]
    StForbidden { path: String, retried: bool },

    #[error("{path} 返回 HTTP {status}：{detail}")]
    StHttpStatus {
        path: String,
        status: u16,
        detail: String,
    },

    #[error("{detail}")]
    StBadResponse { detail: String },
}

impl ShellError {
    /// 稳定的机器可读码。**新增变体必须同步 client/src/contract/errors.ts**
    pub fn code(&self) -> &'static str {
        match self {
            Self::EmptyPath => "EMPTY_PATH",
            Self::PathNotAbsolute { .. } => "PATH_NOT_ABSOLUTE",
            Self::NotAFile { .. } => "NOT_A_FILE",
            Self::PathNotFound { .. } => "PATH_NOT_FOUND",
            Self::TooLarge { .. } => "TOO_LARGE",
            Self::NotUtf8 { .. } => "NOT_UTF8",
            Self::ExtNotAllowed { .. } => "EXT_NOT_ALLOWED",
            Self::DigestMismatch { .. } => "DIGEST_MISMATCH",
            Self::RulesDirMissing => "RULES_DIR_MISSING",
            Self::UnknownRuleKind { .. } => "UNKNOWN_RULE_KIND",
            Self::PathNotAllowed { .. } => "PATH_NOT_ALLOWED",
            Self::TooManyPaths { .. } => "TOO_MANY_PATHS",
            Self::SpawnRejected { .. } => "SPAWN_REJECTED",
            Self::ProbeHostNotAllowed { .. } => "PROBE_HOST_NOT_ALLOWED",
            Self::Io { .. } => "IO_ERROR",
            Self::Invalid { .. } => "INVALID_INPUT",
            Self::StUnavailable { .. } => "ST_UNAVAILABLE",
            Self::StForbidden { .. } => "ST_FORBIDDEN",
            Self::StHttpStatus { .. } => "ST_HTTP_STATUS",
            Self::StBadResponse { .. } => "ST_BAD_RESPONSE",
        }
    }

    /// 统一包装 IO 错误，带上出错的路径（便于排查，不参与业务判断）
    pub fn io(path: &Path, error: impl std::fmt::Display) -> Self {
        Self::Io {
            path: path.display().to_string(),
            message: error.to_string(),
        }
    }

    fn details(&self) -> Option<serde_json::Map<String, serde_json::Value>> {
        let mut map = serde_json::Map::new();
        match self {
            Self::PathNotAbsolute { path }
            | Self::NotAFile { path }
            | Self::PathNotFound { path }
            | Self::PathNotAllowed { path } => {
                map.insert("path".to_string(), path.clone().into());
            }
            Self::TooLarge { size, limit } => {
                map.insert("size".to_string(), (*size).into());
                map.insert("limit".to_string(), (*limit).into());
            }
            Self::NotUtf8 { offset } => {
                map.insert("offset".to_string(), (*offset).into());
            }
            Self::DigestMismatch { expected, actual } => {
                map.insert("expected".to_string(), expected.clone().into());
                map.insert("actual".to_string(), actual.clone().into());
            }
            Self::ExtNotAllowed { name } => {
                map.insert("name".to_string(), name.clone().into());
            }
            Self::TooManyPaths { count, limit } => {
                map.insert("count".to_string(), (*count).into());
                map.insert("limit".to_string(), (*limit).into());
            }
            Self::SpawnRejected { target, reason } => {
                map.insert("target".to_string(), target.clone().into());
                map.insert("reason".to_string(), reason.clone().into());
            }
            Self::ProbeHostNotAllowed { host, allowed } => {
                map.insert("host".to_string(), host.clone().into());
                map.insert("allowed".to_string(), allowed.clone().into());
            }
            Self::UnknownRuleKind { kind } => {
                map.insert("kind".to_string(), kind.clone().into());
            }
            Self::Io { path, .. } => {
                map.insert("path".to_string(), path.clone().into());
            }
            // ST 的四个变体：把"排查需要的那几个字段"结构化带出去。
            // 特别是 StForbidden 的 `retried` —— 界面要能区分
            // 「第一次就 403」与「重连重试后仍 403」，后者才是"真没权限/会话彻底失效"。
            Self::StUnavailable { detail } => {
                map.insert("detail".to_string(), detail.clone().into());
            }
            Self::StForbidden { path, retried } => {
                map.insert("path".to_string(), path.clone().into());
                map.insert("retried".to_string(), (*retried).into());
            }
            Self::StHttpStatus { path, status, .. } => {
                map.insert("path".to_string(), path.clone().into());
                map.insert("status".to_string(), (*status).into());
            }
            Self::StBadResponse { .. } => {}
            /*
             * `Invalid` 的 message 已经是一句给用户看的人话，
             * 序列化时会作为 `message` 一起带出去，不需要额外的 details。
             */
            Self::Invalid { .. } => {}
            Self::EmptyPath | Self::RulesDirMissing => return None,
        }
        Some(map)
    }
}

impl Serialize for ShellError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let has_details = self.details().is_some();
        let mut state = serializer.serialize_struct("ShellError", if has_details { 3 } else { 2 })?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        if let Some(details) = self.details() {
            state.serialize_field("details", &serde_json::Value::Object(details))?;
        }
        state.end()
    }
}

/// `tauri::command` 的返回值必须是 `Result<_, E: Serialize>`，
/// 这里给个显式别名，避免各命令签名漂移。
pub type ShellResult<T> = Result<T, ShellError>;
