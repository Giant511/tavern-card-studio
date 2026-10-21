//! 自定义命令：契约里那 5 个原生能力。
//!
//! 只做「原生能力」，不含任何 UI 结构知识：
//! 输出是扁平的 DTO（camelCase），不含窗口、页面、组件概念。
//!
//! 为什么这 3 个能力不用官方插件直接做：
//!   · read_text_exact  —— plugin-fs 的 readTextFile 遇到非法字节会替换成 U+FFFD，
//!                          静默改写用户内容，与「逐字节可复现」冲突；
//!   · write_file_atomic —— plugin-fs 不保证 tmp+rename，进程被杀会留半截文件；
//!   · scan_rule_dir    —— 需要按 `name:size:mtime` 生成目录签名，与 server 的
//!                          registry.ts 同构，且**不接受路径参数**（见 paths.rs 说明）。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{ShellError, ShellResult};
use crate::paths;

/// 读取结果（对应 client/src/contract/types.ts 的 TextFile）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path_display: Option<String>,
    pub text: String,
    pub bytes_len: u64,
    pub sha256: String,
}

/// 写入回执（对应 WriteReceipt）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub path_display: Option<String>,
    pub bytes_written: u64,
    pub sha256: String,
    pub verified: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFileEntry {
    pub name: String,
    pub size: u64,
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub name: Option<String>,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDirScan {
    pub kind: String,
    pub root: Option<String>,
    pub signature: String,
    pub entries: Vec<RuleFileEntry>,
    pub skipped: Vec<SkippedEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub version: String,
    pub rules_root: Option<String>,
    pub mode: String,
}

// ─────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // 小写 hex，固定两位
        let _ = std::fmt::Write::write_fmt(&mut out, format_args!("{byte:02x}"));
    }
    out
}

/// 同一目录下的唯一临时文件名。用 pid + 单调纳秒，避免并发写撞名。
fn temp_sibling(target: &Path) -> ShellResult<PathBuf> {
    let parent = target.parent().ok_or_else(|| ShellError::PathNotAllowed {
        path: target.display().to_string(),
    })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let unique = Instant::now().elapsed().as_nanos();
    let name = format!(".tcs-{}-{}{}.tmp", std::process::id(), stamp, unique);
    Ok(parent.join(name))
}

/// 先写临时文件并 fsync，再 rename 覆盖目标。
///
/// 顺序不能反：直接写目标时，若中途失败用户会得到「半个角色卡」；
/// 而 rename 在同一卷上是原子的，读者要么看到旧文件，要么看到完整新文件。
fn write_via_temp(temp: &Path, target: &Path, bytes: &[u8]) -> ShellResult<()> {
    let mut file = File::create(temp).map_err(|error| ShellError::io(temp, error))?;
    file.write_all(bytes)
        .map_err(|error| ShellError::io(temp, error))?;
    // 落盘后再 rename，避免断电时 rename 成功但内容丢失
    file.sync_all()
        .map_err(|error| ShellError::io(temp, error))?;
    drop(file);
    fs::rename(temp, target).map_err(|error| ShellError::io(target, error))
}

// ─────────────────────────────────────────────────────────────
// 命令
// ─────────────────────────────────────────────────────────────

/// 自检：版本、规则根目录、debug/release。
#[tauri::command]
pub fn shell_info(app: AppHandle) -> ShellResult<ShellInfo> {
    Ok(ShellInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        rules_root: paths::rules_root(&app).ok().as_deref().and_then(paths::display_path),
        mode: if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "release".to_string()
        },
    })
}

/// 严格 UTF-8 读取。非法字节 → NOT_UTF8（带 offset），**绝不**替换成 U+FFFD。
#[tauri::command]
pub fn read_text_exact(path: String, max_bytes: Option<u64>) -> ShellResult<TextFile> {
    let target = paths::absolute_path(&path)?;
    let limit = max_bytes.unwrap_or(paths::MAX_TEXT_BYTES);
    paths::ensure_readable_file(&target, limit)?;

    let bytes = fs::read(&target).map_err(|error| ShellError::io(&target, error))?;
    // metadata 与 read 之间文件可能变大，读完再量一次
    if bytes.len() as u64 > limit {
        return Err(ShellError::TooLarge {
            size: bytes.len() as u64,
            limit,
        });
    }

    let sha256 = sha256_hex(&bytes);
    let bytes_len = bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(|error| ShellError::NotUtf8 {
        offset: error.utf8_error().valid_up_to(),
    })?;

    Ok(TextFile {
        path_display: paths::display_path(&target),
        text,
        bytes_len,
        sha256,
    })
}

/// 原子写 + 摘要断言 + 回读校验。
///
/// `expected_sha256` 与传入文本的实际摘要不符时，一个字节都不写。
#[tauri::command]
pub fn write_file_atomic(
    path: String,
    text: String,
    expected_sha256: Option<String>,
) -> ShellResult<WriteReceipt> {
    let target = paths::absolute_path(&path)?;
    let bytes = text.into_bytes();
    let sha256 = sha256_hex(&bytes);

    if let Some(expected) = expected_sha256.as_deref() {
        if !expected.eq_ignore_ascii_case(&sha256) {
            return Err(ShellError::DigestMismatch {
                expected: expected.to_string(),
                actual: sha256,
            });
        }
    }

    let parent = target.parent().ok_or_else(|| ShellError::PathNotAllowed {
        path: target.display().to_string(),
    })?;
    if !parent.is_dir() {
        return Err(ShellError::Io {
            path: parent.display().to_string(),
            message: "父目录不存在或不是目录".to_string(),
        });
    }
    if target.exists() && !target.is_file() {
        return Err(ShellError::NotAFile {
            path: target.display().to_string(),
        });
    }

    let temp = temp_sibling(&target)?;
    if let Err(error) = write_via_temp(&temp, &target, &bytes) {
        // 临时文件可能残留，尽力清理但不掩盖原始错误
        let _ = fs::remove_file(&temp);
        return Err(error);
    }

    // 回读校验：防止「rename 成功但内容不是我们写的」
    let written = fs::read(&target).map_err(|error| ShellError::io(&target, error))?;
    let verified = written.len() == bytes.len() && sha256_hex(&written) == sha256;

    Ok(WriteReceipt {
        path_display: paths::display_path(&target),
        bytes_written: written.len() as u64,
        sha256,
        verified,
    })
}

/// 扫描内置规则目录，返回条目 + 目录签名。
///
/// **不接受路径**：目录由 paths::rules_root 解析。前端因此没有「指定任意目录」
/// 的能力，这从架构上规避了 dialog scope 递归扩张那类问题。
#[tauri::command]
pub fn scan_rule_dir(app: AppHandle, kind: String) -> ShellResult<RuleDirScan> {
    let subdir = paths::rule_subdir(&kind)?;
    let root = paths::rules_root(&app)?.join(subdir);

    let mut entries: Vec<RuleFileEntry> = Vec::new();
    let mut skipped: Vec<SkippedEntry> = Vec::new();

    let read_dir = fs::read_dir(&root).map_err(|error| ShellError::io(&root, error))?;
    for item in read_dir {
        let item = match item {
            Ok(value) => value,
            Err(error) => {
                skipped.push(SkippedEntry {
                    name: None,
                    reason: error.to_string(),
                });
                continue;
            }
        };

        let entry_path = item.path();
        let metadata = match item.metadata() {
            Ok(value) => value,
            Err(error) => {
                skipped.push(SkippedEntry {
                    name: paths::display_path(&entry_path),
                    reason: error.to_string(),
                });
                continue;
            }
        };

        if !metadata.is_file() {
            continue;
        }

        let is_json = entry_path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }

        // 文件名必须能无损转成 UTF-8，否则记入 skipped（规则文件由我们发布，正常不会发生）
        let Some(name) = entry_path.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            skipped.push(SkippedEntry {
                name: None,
                reason: "文件名不是合法 UTF-8".to_string(),
            });
            continue;
        };

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|delta| delta.as_millis() as u64)
            .unwrap_or(0);

        entries.push(RuleFileEntry {
            name,
            size: metadata.len(),
            mtime_ms,
        });
    }

    // 排序后拼签名，保证「同一份目录 → 同一串」
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    let signature = entries
        .iter()
        .map(|entry| format!("{}:{}:{};", entry.name, entry.size, entry.mtime_ms))
        .collect::<String>();

    Ok(RuleDirScan {
        kind,
        root: paths::display_path(&root),
        signature,
        entries,
        skipped,
    })
}

/// 读单个规则文件的文本。
///
/// 只接受 `kind` + 文件名：拒绝分隔符 / `..` / NUL，且 canonicalize 后必须仍在
/// 规则目录内（防符号链接穿越）。
#[tauri::command]
pub fn read_rule_text(
    app: AppHandle,
    kind: String,
    name: String,
    max_bytes: Option<u64>,
) -> ShellResult<TextFile> {
    let subdir = paths::rule_subdir(&kind)?;
    paths::ensure_plain_file_name(&name)?;
    paths::ensure_json_extension(&name)?;

    let root = paths::rules_root(&app)?.join(subdir);
    let candidate = root.join(&name);

    // canonicalize 会解析符号链接，必须确认解析后仍在 root 之下
    let canonical_root = root.canonicalize().map_err(|error| ShellError::io(&root, error))?;
    let canonical_file = candidate
        .canonicalize()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ShellError::PathNotFound {
                path: candidate.display().to_string(),
            },
            _ => ShellError::io(&candidate, error),
        })?;

    if !canonical_file.starts_with(&canonical_root) {
        return Err(ShellError::PathNotAllowed {
            path: name,
        });
    }

    let limit = max_bytes.unwrap_or(paths::MAX_TEXT_BYTES);
    paths::ensure_readable_file(&canonical_file, limit)?;

    let bytes = fs::read(&canonical_file).map_err(|error| ShellError::io(&canonical_file, error))?;
    if bytes.len() as u64 > limit {
        return Err(ShellError::TooLarge {
            size: bytes.len() as u64,
            limit,
        });
    }

    let sha256 = sha256_hex(&bytes);
    let bytes_len = bytes.len() as u64;
    let text = String::from_utf8(bytes).map_err(|error| ShellError::NotUtf8 {
        offset: error.utf8_error().valid_up_to(),
    })?;

    Ok(TextFile {
        path_display: paths::display_path(&canonical_file),
        text,
        bytes_len,
        sha256,
    })
}

// Manager trait 供 app.path() 使用；exe 目录诊断时也会用到
#[allow(dead_code)]
fn app_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}
