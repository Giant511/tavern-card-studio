//! 路径解析与校验。
//!
//! 硬规则（评审项）：
//!   · 内部一律 `PathBuf` / `&Path`，不把 `String` 当路径传递；
//!   · 只在**跨 IPC 边界**与**错误文案**处转字符串，且非 UTF-8 时返回 `None`
//!     而不是 `to_string_lossy()` —— 静默替换会让用户看到假路径；
//!   · 规则目录由 Rust 侧解析，前端无权指定（规避 dialog scope 递归问题）。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::ShellError;

/// 单个文本文件的默认体积上限（64 MiB）。
/// 与 server 的 `maxUploadBytes`（32 MiB）无关：这里防的是「读进内存爆掉」。
pub const MAX_TEXT_BYTES: u64 = 64 * 1024 * 1024;

/// 规则资产的三类子目录，与仓库 `rules/` 下结构一致。
pub const RULE_SUBDIRS: [&str; 3] = ["platforms", "presets", "highlight"];

/// 解析内置规则根目录。
///
/// 顺序：
///   1. 环境变量 `TCS_RULES_DIR`（运维/测试覆盖用）
///   2. 安装包资源目录 `resource_dir()/rules`（生产：`$RESOURCE/rules`）
///   3. 仓库根 `rules/`（仅开发期：`src-tauri/../../rules`）
///
/// 开发期为什么需要第 3 条：`tauri dev` 时 `resource_dir()` 指向
/// `target/debug`，bundler 并没有把 resources 拷进去，不做回退会直接起不来。
pub fn rules_root(app: &AppHandle) -> Result<PathBuf, ShellError> {
    if let Ok(raw) = std::env::var("TCS_RULES_DIR") {
        let candidate = PathBuf::from(raw);
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("rules");
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }

    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("rules");
    if dev.is_dir() {
        return Ok(dev);
    }

    Err(ShellError::RulesDirMissing)
}

/// 校验并返回绝对路径。不做 canonicalize（保存目标可能还不存在）。
pub fn absolute_path(raw: &str) -> Result<PathBuf, ShellError> {
    if raw.trim().is_empty() {
        return Err(ShellError::EmptyPath);
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(ShellError::PathNotAbsolute {
            path: raw.to_string(),
        });
    }
    Ok(path)
}

/// 读文件前的守卫：存在 + 是常规文件 + 不超限。
pub fn ensure_readable_file(path: &Path, max_bytes: u64) -> Result<u64, ShellError> {
    let metadata = std::fs::metadata(path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ShellError::PathNotFound {
            path: path.display().to_string(),
        },
        _ => ShellError::io(path, error),
    })?;

    if !metadata.is_file() {
        return Err(ShellError::NotAFile {
            path: path.display().to_string(),
        });
    }

    if metadata.len() > max_bytes {
        return Err(ShellError::TooLarge {
            size: metadata.len(),
            limit: max_bytes,
        });
    }

    Ok(metadata.len())
}

/// 跨 IPC 展示用的路径。非 UTF-8 返回 None（不损失信息，交给 UI 显示占位）。
pub fn display_path(path: &Path) -> Option<String> {
    path.to_str().map(str::to_string)
}

/// 规则文件名白名单校验：拒绝分隔符、`..`、NUL，防止穿越到规则目录之外。
pub fn ensure_plain_file_name(name: &str) -> Result<(), ShellError> {
    let unsafe_name = name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.contains('\0');
    if unsafe_name {
        return Err(ShellError::PathNotAllowed {
            path: name.to_string(),
        });
    }
    Ok(())
}

/// 规则文件必须是 `.json`（三类规则都是 JSON）。
pub fn ensure_json_extension(name: &str) -> Result<(), ShellError> {
    let is_json = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("json"))
        .unwrap_or(false);
    if is_json {
        Ok(())
    } else {
        Err(ShellError::ExtNotAllowed {
            name: name.to_string(),
        })
    }
}

/// 把 `kind` 映射到子目录名，并校验结果确实在 `RULE_SUBDIRS` 里。
pub fn rule_subdir(kind: &str) -> Result<&'static str, ShellError> {
    RULE_SUBDIRS
        .iter()
        .copied()
        .find(|dir| *dir == kind)
        .ok_or_else(|| ShellError::UnknownRuleKind {
            kind: kind.to_string(),
        })
}
