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

/// 二进制读取结果（对应 BinaryFile，v0.1.4 / T12.3）
///
/// 为什么是 base64 而不是 `Vec<u8>`：Tauri 的命令返回值要序列化成 JSON，
/// 5 MB 的 PNG 变成 `Vec<u8>` 就是 500 万个数（约 20 MB 文本），
/// IPC 与 `JSON.parse` 都要几秒；base64 只膨胀 33%。两侧都有现成实现。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFile {
    pub path_display: Option<String>,
    pub base64: String,
    pub bytes_len: u64,
    pub sha256: String,
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

/// 标准 base64 解码（RFC 4648）。**严格**：非字母表字符、长度非 4 倍数、
/// 填充位出现在中间，一律报错。
///
/// 为什么严格：这是**写盘**路径。宽松解码（跳过非法字符）会把一段被截断的
/// base64 静默解成"短一点的 PNG"，然后落盘、回读自证还通过（因为回读的是
/// 我们刚写的错字节）—— 用户得到一张打不开的图，且所有校验都是绿的。
/// 宁可在这里报错。
fn base64_decode(input: &str) -> ShellResult<Vec<u8>> {
    fn value_of(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let bad = |message: &str| ShellError::Io {
        path: "<base64>".to_string(),
        message: message.to_string(),
    };

    // 允许空白（有些工具折行写入），其余一律不许
    let filtered: Vec<u8> = input
        .bytes()
        .filter(|byte| !matches!(byte, b'\r' | b'\n' | b' ' | b'\t'))
        .collect();

    if filtered.len() % 4 != 0 {
        return Err(bad("base64 长度不是 4 的倍数（数据可能被截断）"));
    }

    let mut out: Vec<u8> = Vec::with_capacity(filtered.len() / 4 * 3);
    let chunks = filtered.len() / 4;
    for index in 0..chunks {
        let block = &filtered[index * 4..index * 4 + 4];
        let is_last = index + 1 == chunks;

        // 统计本块尾部的填充（只允许在**最后一块**出现）
        let padding = block.iter().filter(|byte| **byte == b'=').count();
        if padding > 0 && !is_last {
            return Err(bad("base64 填充符 '=' 出现在中间块"));
        }
        if padding > 2 {
            return Err(bad("base64 一个块里最多两个填充符"));
        }
        if padding > 0 && !block[4 - padding..].iter().all(|byte| *byte == b'=') {
            return Err(bad("base64 填充符位置不合法"));
        }
        if padding > 0 && block[..4 - padding].iter().any(|byte| *byte == b'=') {
            return Err(bad("base64 填充符位置不合法"));
        }

        let mut packed: u32 = 0;
        for slot in 0..4 {
            let raw = block[slot];
            let six = if raw == b'=' {
                0
            } else {
                value_of(raw).ok_or_else(|| bad("base64 含非法字符"))? as u32
            };
            packed = (packed << 6) | six;
        }

        out.push(((packed >> 16) & 0xff) as u8);
        if padding < 2 {
            out.push(((packed >> 8) & 0xff) as u8);
        }
        if padding < 1 {
            out.push((packed & 0xff) as u8);
        }
    }

    Ok(out)
}

/// 标准 base64 编码（RFC 4648，带 `=` 补位、不折行）。
///
/// 手写而不是引 `base64` crate：这里**只需要编码**（解码在渲染层用 `atob`），
/// 20 行无分支的实现，换来 Cargo 依赖表不动 —— MSI 离线构建时少一个要拉取的包，
/// 也少一个版本漂移点。正确性由 `test/contract-binary.test.mjs` 用 Node 的
/// `Buffer.toString('base64')` 逐例对拍（含 0/1/2 字节的补位边界）。
fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    // 每 3 字节 → 4 字符，向上取整后预留容量（避免反复 realloc 大图）
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut iter = input.chunks_exact(3);
    for chunk in &mut iter {
        let packed = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[((packed >> 18) & 0b11_1111) as usize] as char);
        out.push(ALPHABET[((packed >> 12) & 0b11_1111) as usize] as char);
        out.push(ALPHABET[((packed >> 6) & 0b11_1111) as usize] as char);
        out.push(ALPHABET[(packed & 0b11_1111) as usize] as char);
    }

    match iter.remainder() {
        [one] => {
            let packed = u32::from(*one) << 16;
            out.push(ALPHABET[((packed >> 18) & 0b11_1111) as usize] as char);
            out.push(ALPHABET[((packed >> 12) & 0b11_1111) as usize] as char);
            out.push('=');
            out.push('=');
        }
        [one, two] => {
            let packed = (u32::from(*one) << 16) | (u32::from(*two) << 8);
            out.push(ALPHABET[((packed >> 18) & 0b11_1111) as usize] as char);
            out.push(ALPHABET[((packed >> 12) & 0b11_1111) as usize] as char);
            out.push(ALPHABET[((packed >> 6) & 0b11_1111) as usize] as char);
            out.push('=');
        }
        _ => {}
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

/// 读内置默认卡面（v0.1.4 / T12.5）。
///
/// 为什么要有这条命令，而不是让渲染层自己拼资源路径：
///   · 资源目录在不同安装形态下不一样（MSI / 绿色包 / `tauri dev`），
///     这个差异只该由 Rust 侧的一份解析逻辑承担（`paths::default_face_path`）；
///   · 契约规则是"渲染层只拿语义化能力"：前端说"给我默认卡面"，
///     而不是"去读 $RESOURCE/card-face-default.png"。
///     后者一旦路径算错，表现是"默认卡面显示不出来"，而没人会去查资源目录。
///
/// 返回完整 PNG 字节（base64），与 `read_binary_file` 同形。
#[tauri::command]
pub fn read_default_face(app: AppHandle) -> ShellResult<BinaryFile> {
    read_binary_impl(&paths::default_face_path(&app)?)
}

/// 在系统文件管理器里打开一个**目录**（v0.1.4 / T12.5）。
///
/// 为什么不直接给渲染层 opener 插件权限（`opener:allow-open-path`）：
/// 那等于开放"用默认程序打开任意路径"—— 包括 `.exe` 和 `file://` URL。
/// 这里收窄成"只能开目录"，并且走自定义命令：
///   · 渲染层没有 IPC 级的 opener 权限（capabilities 至今未授予）；
///   · Rust 侧先校验"是绝对路径 + 确实是目录"，再调插件**的 Rust API**
///     （ACL 只拦 IPC 调用，Rust 内部调用不经过它）。
///
/// 需求 F5 要的"打开图库目录"因此是"打开一个文件夹"，
/// 不是"执行一个路径"。
#[tauri::command]
pub fn open_folder(app: AppHandle, path: String) -> ShellResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let target = paths::absolute_path(&path)?;
    if !target.is_dir() {
        return Err(ShellError::Io {
            path: target.display().to_string(),
            message: "不是目录".to_string(),
        });
    }
    app.opener()
        .open_path(target.display().to_string(), None::<&str>)
        .map_err(|error| ShellError::Io {
            path: target.display().to_string(),
            message: format!("打开目录失败：{error}"),
        })
}

/// 读二进制文件的唯一实现（任意路径 / 内置资源共用）
fn read_binary_impl(target: &Path) -> ShellResult<BinaryFile> {
    let limit = paths::MAX_TEXT_BYTES;
    paths::ensure_readable_file(target, limit)?;

    let bytes = fs::read(target).map_err(|error| ShellError::io(target, error))?;
    if bytes.len() as u64 > limit {
        return Err(ShellError::TooLarge {
            size: bytes.len() as u64,
            limit,
        });
    }

    Ok(BinaryFile {
        path_display: paths::display_path(target),
        base64: base64_encode(&bytes),
        bytes_len: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
    })
}

/// 读二进制文件（v0.1.4 / T12.3）：base64 + 字节数 + sha256。
///
/// 与 `read_text_exact` **同形**：同一条 `absolute_path` 校验、同一个默认上限
/// （64 MiB）、同一套错误枚举。差别只有两点：
///   · 返回 base64 而不是解码后的文本；
///   · **没有 `NOT_UTF8`** —— 二进制没有"非法字符"这回事，PNG 里出现任何字节
///     都合法。多加一个错误码会让调用方以为要处理它。
///
/// 这里刻意**不做内容嗅探**（不检查像不像 PNG）：契约层的职责是"原样搬运字节"，
/// 判断"这是不是一张 PNG 卡"属于 `shared/png-card`。混在一起会让
/// "读一张 5 MB 的 jpg 当卡面"这种合法用法被拒。
#[tauri::command]
pub fn read_binary_file(path: String, max_bytes: Option<u64>) -> ShellResult<BinaryFile> {
    let target = paths::absolute_path(&path)?;
    let limit = max_bytes.unwrap_or(paths::MAX_TEXT_BYTES);
    paths::ensure_readable_file(&target, limit)?;

    let bytes = fs::read(&target).map_err(|error| ShellError::io(&target, error))?;
    if bytes.len() as u64 > limit {
        return Err(ShellError::TooLarge {
            size: bytes.len() as u64,
            limit,
        });
    }

    Ok(BinaryFile {
        path_display: paths::display_path(&target),
        base64: base64_encode(&bytes),
        bytes_len: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
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
    write_atomic_impl(&path, text.into_bytes(), expected_sha256)
}

/// 原子写二进制（v0.1.4 / T12.5）：入参是 base64，落盘的是**解码后的原始字节**。
///
/// 与 `write_file_atomic` 共用同一个实现（`write_atomic_impl`），所以
/// 原子性、写前摘要断言、写后回读自证这三条**不可能**在其中一条路径上退化。
/// 复制一份实现是这里最该避免的事 —— 那份副本不会有人给它补测试。
///
/// 为什么入参是 base64 而不是 `Vec<u8>`：Tauri 会把 `Vec<u8>` 当作数字数组
/// 过 JSON，一张 5 MB 的 PNG 就是 500 万个数字（约 20 MB 文本），
/// 解析就要几秒；base64 只膨胀 33%。见 `read_binary_file` 的同一条理由。
#[tauri::command]
pub fn write_binary_file_atomic(
    path: String,
    base64: String,
    expected_sha256: Option<String>,
) -> ShellResult<WriteReceipt> {
    let bytes = base64_decode(&base64)?;
    write_atomic_impl(&path, bytes, expected_sha256)
}

/// 原子写的唯一实现（文本与二进制共用）
fn write_atomic_impl(
    path: &str,
    bytes: Vec<u8>,
    expected_sha256: Option<String>,
) -> ShellResult<WriteReceipt> {
    let target = paths::absolute_path(path)?;
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

// ─────────────────────────────────────────────────────────────
// 卡片目录（T9.8 / F4）
// ─────────────────────────────────────────────────────────────

/// 目录探测结果（对应 client/src/contract/types.ts 的 DirProbe）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirProbe {
    pub path: String,
    pub path_display: Option<String>,
    pub exists: bool,
    pub created: bool,
    pub writable: bool,
    pub reason: Option<String>,
}

/// 卡片目录扫描结果（对应 CardsDirScan）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardsDirScan {
    pub path_display: Option<String>,
    pub names: Vec<String>,
    pub truncated: bool,
}

/// 默认卡片目录：`<Documents>/TavernCardStudio/cards`。
///
/// 依次尝试：系统文档目录 → `USERPROFILE/Documents` → 应用配置目录。
/// 为什么不直接在 TS 侧拼字符串：拿 `Documents` 只有壳知道
/// （Windows 上它可能被重定向到 OneDrive，`%USERPROFILE%\Documents` 未必存在）。
#[tauri::command]
pub fn default_cards_dir(app: AppHandle) -> ShellResult<String> {
    let base = app
        .path()
        .document_dir()
        .ok()
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|home| home.join("Documents"))
        })
        .or_else(|| app.path().app_config_dir().ok());

    let base = base.ok_or_else(|| ShellError::EmptyPath)?;
    let dir = base.join("TavernCardStudio").join("cards");
    paths::display_path(&dir).ok_or_else(|| ShellError::PathNotAllowed {
        path: dir.display().to_string(),
    })
}

/// 探测（并可选创建）卡片目录。
///
/// 可写性用**真实写入一个探针文件再删掉**来判断，不看属性位：
/// Windows 上只读属性、ACL 拒绝、网络盘掉线都会让"看起来可写"的目录写不进去，
/// 而属性位只能反映其中一部分。
#[tauri::command]
pub fn probe_cards_dir(path: String, create: Option<bool>) -> ShellResult<DirProbe> {
    let target = paths::absolute_path(&path)?;
    let want_create = create.unwrap_or(false);

    // 注意这里必须用 `exists()` 而不是 `is_dir()`：
    // 同名路径可能是一个**文件**，那时 `is_dir()` 也是 false，就会被当成
    // "目录不存在"去创建 —— 而 `create_dir_all` 必然失败，用户看到的
    // 原因变成「无法创建目录：文件已存在」，而不是更准确的「这里是个文件」。
    // 这个分支一开始写成 `else if !target.is_dir()` 是**死代码**，
    // 被 `probe_reports_file_in_the_way` 这条用例抓出来了。
    let existed = target.exists();
    let mut created = false;

    if existed && !target.is_dir() {
        return Ok(DirProbe {
            path: path.clone(),
            path_display: paths::display_path(&target),
            exists: true,
            created: false,
            writable: false,
            reason: Some("同名路径已存在，但它是一个文件而不是目录".to_string()),
        });
    }

    if !existed {
        if !want_create {
            return Ok(DirProbe {
                path: path.clone(),
                path_display: paths::display_path(&target),
                exists: false,
                created: false,
                writable: false,
                reason: Some("目录不存在".to_string()),
            });
        }
        if let Err(error) = fs::create_dir_all(&target) {
            // 创建失败就到此为止：把 OS 的原话带上，用户才知道是权限还是路径非法
            return Ok(DirProbe {
                path: path.clone(),
                path_display: paths::display_path(&target),
                exists: false,
                created: false,
                writable: false,
                reason: Some(format!("无法创建目录：{}", error)),
            });
        }
        created = true;
    }

    // 探针文件名带 pid：两个客户端实例同时探测不会互相踩
    let probe = target.join(format!(".tcs-write-probe-{}", std::process::id()));
    let writable = match fs::write(&probe, b"probe") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(error) => {
            return Ok(DirProbe {
                path: path.clone(),
                path_display: paths::display_path(&target),
                exists: existed,
                created,
                writable: false,
                reason: Some(format!("目录不可写：{}", error)),
            })
        }
    };

    Ok(DirProbe {
        path: path.clone(),
        path_display: paths::display_path(&target),
        exists: existed || created,
        created,
        writable,
        reason: None,
    })
}

/// 列出卡片目录下的 `.json` 文件名（**不递归、不读内容**）。
///
/// 这个能力唯一的用途是「保存前看看有没有同名文件，别静默覆盖」。
/// 因此它返回的是名字而不是路径，也不下潜子目录 —— 能力范围与用途对齐，
/// 免得变成一个"任意目录列举器"。
#[tauri::command]
pub fn scan_cards_dir(
    path: String,
    limit: Option<usize>,
    extensions: Option<Vec<String>>,
) -> ShellResult<CardsDirScan> {
    let target = paths::absolute_path(&path)?;
    let cap = limit.unwrap_or(5000);

    /*
     * 扩展名白名单（v0.1.4 / T12.5）。
     *
     * 卡片目录用 `.json`；卡面图库用 `.png/.jpg/.jpeg/.webp`。**同一段扫描逻辑**
     * 而不是复制一份 `scan_face_dir`：那份副本迟早会在"不递归""遇到非 UTF-8
     * 文件名怎么办""截断标记"这些细节上与这里分叉，而分叉后没有任何测试会红。
     *
     * 规范化：统一小写、补前导点、去重。空数组按"什么都不匹配"处理 ——
     * 传空数组的人多半是算错了，回一个空列表比回全部文件安全。
     */
    let allowed: Vec<String> = match extensions {
        None => vec![".json".to_string()],
        Some(list) => {
            let mut normalized: Vec<String> = list
                .into_iter()
                .map(|item| {
                    let lowered = item.trim().to_ascii_lowercase();
                    if lowered.starts_with('.') {
                        lowered
                    } else {
                        format!(".{lowered}")
                    }
                })
                .filter(|item| item.len() > 1)
                .collect();
            normalized.sort();
            normalized.dedup();
            normalized
        }
    };

    if !target.is_dir() {
        // 目录还不存在不算错误：调用方紧接着会去创建它
        return Ok(CardsDirScan {
            path_display: paths::display_path(&target),
            names: Vec::new(),
            truncated: false,
        });
    }

    let entries = fs::read_dir(&target).map_err(|error| ShellError::io(&target, error))?;
    let mut names: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue, // 单个条目读不到不影响整体（权限/竞态）
        };
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue; // 非 UTF-8 文件名不参与重名判断（无法与用户输入比较）
        };
        let lowered = name.to_ascii_lowercase();
        if !allowed.iter().any(|suffix| lowered.ends_with(suffix.as_str())) {
            continue;
        }
        if names.len() >= cap {
            truncated = true;
            break;
        }
        names.push(name.to_string());
    }

    names.sort();
    Ok(CardsDirScan {
        path_display: paths::display_path(&target),
        names,
        truncated,
    })
}

// ─────────────────────────────────────────────────────────────
// 客户端错误日志（T10.26）
// ─────────────────────────────────────────────────────────────

/// 单条日志的字节上限（8 KiB）。
///
/// 为什么要截：一条 `window.onerror` 的堆栈可以很长（压缩后的 bundle 路径、
/// 递归调用链），而日志是**追加**写的 —— 一次失控的循环报错能把磁盘写满。
/// 8 KiB 足够放下真实堆栈（实测一屏 20 层左右约 2 KiB）。
pub const ERROR_LOG_MAX_ENTRY_BYTES: usize = 8 * 1024;

/// 日志文件轮转阈值（1 MiB）。超过就把当前文件改名成 `.1`（旧的 `.1` 直接覆盖）。
///
/// 为什么只留一份备份而不是按天分文件：这是**诊断**日志，用户平时不看它，
/// 只在出问题时要"最近那次崩溃"。留太多份的结果是谁也不会去清理，
/// 最后变成一个没人知道该不该删的目录。
pub const ERROR_LOG_ROTATE_BYTES: u64 = 1024 * 1024;

/// 客户端错误日志落点：`<应用配置目录>/logs/client-error.log`。
///
/// **由 Rust 解析，渲染层无权指定路径** —— 契约里第 2 条规则：只暴露语义化能力，
/// 不给"给我一个路径，随便写"。渲染层拿到的只有回执里的路径（用于展示）。
fn error_log_path(app: &AppHandle) -> Result<PathBuf, ShellError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| ShellError::Io {
            path: "<app_config_dir>".to_string(),
            message: error.to_string(),
        })?;
    Ok(config_dir.join("logs").join("client-error.log"))
}

/// 把一条日志整理成可以落盘的形态：CRLF → LF、超长按**字符边界**截断、结尾补一个换行。
///
/// 单独抽出来是为了能测：按字节截断是最容易写错的那一步 ——
/// `text.truncate(n)` 在 n 落在多字节字符中间时会 **panic**（Rust 的 String
/// 要求始终是合法 UTF-8），而不是"截短一点"。真实堆栈里中文、emoji 都很常见，
/// 一次 panic 会让整个日志器失效。
fn normalize_error_log_entry(entry: &str) -> String {
    let mut text = entry.replace("\r\n", "\n");
    if text.len() > ERROR_LOG_MAX_ENTRY_BYTES {
        let mut cut = ERROR_LOG_MAX_ENTRY_BYTES;
        while cut > 0 && !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n... [entry truncated]");
    }
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// 追加一条客户端错误日志，返回文件路径（供「导出诊断日志」显示）。
///
/// 两个和"崩溃"直接相关的实现细节：
///
///   1. **每次 open + write + sync_all**，不留缓冲。渲染层在崩溃前调用本命令，
///      若走 BufWriter 或只 write 不 sync，最后那条恰恰是最需要的那条会丢。
///   2. **写入发生在命令返回之前**（同步 fs API）。异步排队等于把"崩溃前能不能
///      落盘"交给调度器决定。
#[tauri::command]
pub fn append_client_error_log(app: AppHandle, entry: String) -> ShellResult<String> {
    let target = error_log_path(&app)?;
    let text = normalize_error_log_entry(&entry);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| ShellError::io(parent, error))?;
    }

    // 轮转：先量再写，避免"写超了才发现"
    if let Ok(meta) = fs::metadata(&target) {
        if meta.len() > ERROR_LOG_ROTATE_BYTES {
            let backup = target.with_extension("log.1");
            // 覆盖旧备份失败不该拦住这次写入 —— 日志写不进去比留两份更糟
            let _ = fs::rename(&target, &backup);
        }
    }

    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|error| ShellError::io(&target, error))?;
    file.write_all(text.as_bytes())
        .map_err(|error| ShellError::io(&target, error))?;
    // 落到磁盘再看返回值：崩溃场景下"我写了但没刷盘"等于没写
    file.sync_all().map_err(|error| ShellError::io(&target, error))?;

    Ok(paths::display_path(&target).unwrap_or_else(|| "<非 UTF-8 路径>".to_string()))
}

// ─────────────────────────────────────────────────────────────
// 单元测试（只覆盖不依赖 AppHandle 的目录能力）
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 每次用独立临时目录，避免并行测试互相踩
    fn temp_dir(tag: &str) -> PathBuf {
        let unique = format!(
            "tcs-test-{}-{}-{:?}",
            tag,
            std::process::id(),
            Instant::now()
        );
        let dir = std::env::temp_dir().join(unique.replace([':', '.', ' '], "_"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn probe_creates_missing_dir_and_checks_writability() {
        let dir = temp_dir("probe-create");
        assert!(!dir.exists());

        let result = probe_cards_dir(dir.display().to_string(), Some(true)).expect("探测应成功");

        assert!(result.exists, "创建后应报告存在");
        assert!(result.created, "应标记为本次创建");
        assert!(result.writable, "新建目录应可写");
        assert!(result.reason.is_none());
        assert!(dir.is_dir(), "目录应真的被创建出来");

        // 探针文件必须删干净，不能留在用户的卡片目录里
        let leftovers: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            leftovers.is_empty(),
            "探针文件没删干净：{:?}",
            leftovers
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_without_create_reports_missing() {
        let dir = temp_dir("probe-missing");

        let result = probe_cards_dir(dir.display().to_string(), Some(false)).expect("探测应成功");

        assert!(!result.exists);
        assert!(!result.created);
        assert!(!result.writable);
        assert!(result.reason.is_some(), "缺失时应给出原因");
        assert!(!dir.exists(), "create=false 时不该真的建目录");
    }

    #[test]
    fn probe_reports_file_in_the_way() {
        let dir = temp_dir("probe-file");
        fs::create_dir_all(dir.parent().unwrap()).unwrap();
        fs::write(&dir, b"i am a file").unwrap();

        let result = probe_cards_dir(dir.display().to_string(), Some(true)).expect("探测应成功");

        assert!(result.exists, "同名路径确实存在");
        assert!(!result.created);
        assert!(!result.writable, "文件不是目录，不可写");
        assert!(result.reason.is_some());

        let _ = fs::remove_file(&dir);
    }

    #[test]
    fn scan_lists_only_json_files_sorted() {
        let dir = temp_dir("scan");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("b.json"), b"{}").unwrap();
        fs::write(dir.join("A.json"), b"{}").unwrap();
        fs::write(dir.join("note.txt"), b"x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("deep.json"), b"{}").unwrap();

        let scan = scan_cards_dir(dir.display().to_string(), None, None).expect("扫描应成功");

        assert_eq!(scan.names, vec!["A.json", "b.json"], "只列 .json、排序、不递归");
        assert!(!scan.truncated);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let dir = temp_dir("scan-missing");

        let scan = scan_cards_dir(dir.display().to_string(), None, None).expect("目录不存在不该报错");

        assert!(scan.names.is_empty());
        assert!(!scan.truncated);
    }

    #[test]
    fn error_log_entry_normalizes_newlines_and_trailing_newline() {
        // CRLF 统一成 LF：同一条日志在 Windows 与其它平台上应当逐字节相同，
        // 否则用户发回来的文件里会混着两种换行
        assert_eq!(normalize_error_log_entry("a\r\nb"), "a\nb\n");
        // 已经以换行结尾时不再补一个（补了就会在文件里出现空行）
        assert_eq!(normalize_error_log_entry("a\n"), "a\n");
    }

    #[test]
    fn error_log_entry_truncates_on_char_boundary() {
        // 每个汉字 3 字节：8 KiB 除不尽 3，硬截会在字符中间切。
        // 用超过上限的中文串触发截断，重点断言**不 panic 且仍是合法 UTF-8**。
        let long = "\u{9519}".repeat(ERROR_LOG_MAX_ENTRY_BYTES);
        let result = normalize_error_log_entry(&long);
        assert!(result.ends_with('\n'));
        assert!(result.contains("[entry truncated]"), "超长必须留可辨识的截断标记");
        assert!(result.trim_end().chars().count() > 0);
        assert!(result.len() <= ERROR_LOG_MAX_ENTRY_BYTES + 32, "截断后不该超过上限太多");
    }

    #[test]
    fn error_log_entry_keeps_short_text_intact() {
        let text = "[2026-10-24T00:00:00Z] ERROR boom\n  at foo";
        assert_eq!(normalize_error_log_entry(text), format!("{text}\n"));
    }
    #[test]
    fn scan_respects_limit() {
        let dir = temp_dir("scan-limit");
        fs::create_dir_all(&dir).unwrap();
        for index in 0..5 {
            fs::write(dir.join(format!("{index}.json")), b"{}").unwrap();
        }

        let scan = scan_cards_dir(dir.display().to_string(), Some(3), None).expect("扫描应成功");

        assert_eq!(scan.names.len(), 3);
        assert!(scan.truncated, "超过上限要明确标记截断");

        let _ = fs::remove_dir_all(&dir);
    }

    // ── base64 编码器（v0.1.4 / T12.3）───────────────────────
    //
    // 用手写实现换掉一个 Cargo 依赖，代价是必须自己证明它是对的。
    // 这里直接用 RFC 4648 §10 的**官方测试向量**：它们恰好覆盖了
    // 三种补位情况（0 / 1 / 2 个剩余字节），是最容易写错的地方。

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // (明文, 期望 base64) —— RFC 4648 §10 "Test Vectors"
        let cases: [(&[u8], &str); 7] = [
            (b"", ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ];
        for (input, expected) in cases {
            assert_eq!(
                base64_encode(input),
                expected,
                "base64 编码与 RFC 4648 向量不符（输入 {:?}）",
                String::from_utf8_lossy(input)
            );
        }
    }

    #[test]
    fn base64_never_wraps_lines() {
        // 长输入必须单行：折行的 base64 前端 atob 也能吃，但会让
        // "长度 = ⌈n/3⌉*4" 这条断言与 sha 对拍失效，多一个变量。
        let input = vec![0xab_u8; 4096];
        let encoded = base64_encode(&input);
        assert!(!encoded.contains('\n'), "base64 不许折行");
        // 4096 = 3*1365 + 1 → 尾部剩 1 字节：0xAB → 取 6 位得 42('q')，
        // 余下 2 位补零得 48('w')，再补 "=="，即 "qw=="
        assert_eq!(encoded.len(), 4096_usize.div_ceil(3) * 4);
        assert!(encoded.ends_with("qw=="), "尾部补位不对：…{}", &encoded[encoded.len() - 4..]);
    }

    #[test]
    fn base64_handles_all_byte_values() {
        // 全 256 个字节值走一遍：确保高位没有被符号扩展弄错
        // （Rust 的 u8→u32 是无符号提升，但手写位运算时很容易写成 i8）
        let input: Vec<u8> = (0..=255_u8).collect();
        let encoded = base64_encode(&input);
        // 256 = 3*85 + 1 → 最后 1 字节剩，补两个 =
        assert!(encoded.ends_with("=="), "256 字节应当补两个等号");
        assert_eq!(encoded.len(), 256_usize.div_ceil(3) * 4);
    }

    #[test]
    fn base64_roundtrip_is_lossless() {
        // 编解码必须互为逆运算：写 PNG 走的是 decode，读回来走 encode，
        // 只测其中一个方向等于只测了一半
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            b"f".to_vec(),
            b"fo".to_vec(),
            b"foobar".to_vec(),
            (0..=255_u8).collect(),
            (0..5000_u32).map(|index| (index % 251) as u8).collect(),
        ];
        for input in cases {
            let encoded = base64_encode(&input);
            let decoded = base64_decode(&encoded).expect("合法 base64 应当解码成功");
            assert_eq!(decoded, input, "编解码往返丢字节（长度 {}）", input.len());
        }
    }

    #[test]
    fn base64_decode_rejects_malformed() {
        // 写盘路径必须严格：宽松解码会把截断的数据写成"短一点的 PNG"，
        // 而回读自证仍然通过（回读的是刚写的错字节）
        for bad in ["Zm9vY", "Zm9v Ym9vY", "Zm=v", "Z!9v", "====", "Zm9vYg==="] {
            assert!(
                base64_decode(bad).is_err(),
                "非法 base64 应当被拒绝：{bad}"
            );
        }
        // 折行与空白是允许的（有些工具这么写）
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn scan_cards_dir_defaults_to_json_only() {
        // 默认行为不能变：既有调用（查重名、列卡片）都依赖"只回 .json"
        let dir = temp_dir("scan-ext-default");
        fs::create_dir_all(&dir).unwrap();
        for name in ["a.json", "b.png", "c.txt", "d.JSON"] {
            fs::write(dir.join(name), b"x").unwrap();
        }

        let scan = scan_cards_dir(dir.display().to_string(), None, None).expect("扫描应成功");
        let mut names = scan.names.clone();
        names.sort();
        assert_eq!(names, vec!["a.json", "d.JSON"], "默认只认 .json（大小写不敏感）");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_cards_dir_accepts_image_extensions() {
        // 卡面图库复用同一段扫描：扩展名可传，且大小写不敏感
        let dir = temp_dir("scan-ext-images");
        fs::create_dir_all(&dir).unwrap();
        for name in ["a.png", "b.PNG", "c.jpg", "d.webp", "e.json", "f.txt"] {
            fs::write(dir.join(name), b"x").unwrap();
        }

        let scan = scan_cards_dir(
            dir.display().to_string(),
            None,
            Some(vec!["PNG".to_string(), ".jpg".to_string(), "webp".to_string()]),
        )
        .expect("扫描应成功");
        let mut names = scan.names.clone();
        names.sort();
        assert_eq!(
            names,
            vec!["a.png", "b.PNG", "c.jpg", "d.webp"],
            "扩展名应当大小写不敏感、前导点可有可无"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
