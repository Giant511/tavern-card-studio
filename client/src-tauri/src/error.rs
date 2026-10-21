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

    #[error("IO 失败（{path}）：{message}")]
    Io { path: String, message: String },
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
            Self::Io { .. } => "IO_ERROR",
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
            Self::UnknownRuleKind { kind } => {
                map.insert("kind".to_string(), kind.clone().into());
            }
            Self::Io { path, .. } => {
                map.insert("path".to_string(), path.clone().into());
            }
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
