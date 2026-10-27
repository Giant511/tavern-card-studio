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
    read_text_impl(&target, limit)
}

/// 严格读文本的唯一实现（v0.1.5 / G5 抽出）。
///
/// 抽出来是为了让"预设库"与"用户选的文件"走**同一条**读取路径：
/// 严格 UTF-8（非法字节报 `NOT_UTF8` 而不是替换成 U+FFFD）、读后再量一次大小、
/// sha256 覆盖原始字节。两处各写一份，迟早一处松一处紧 ——
/// 而"预设读进来字符被替换掉了"这种问题几乎无法从现象反推。
fn read_text_impl(target: &Path, limit: u64) -> ShellResult<TextFile> {
    paths::ensure_readable_file(target, limit)?;

    let bytes = fs::read(target).map_err(|error| ShellError::io(target, error))?;
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
        path_display: paths::display_path(target),
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

/// 预设库路径：`<应用配置目录>/preset-library.json`。
///
/// **由 Rust 解析，渲染层无权指定** —— 与错误日志同一原则（见 `error_log_path`）：
/// 契约只暴露语义化能力（"读/写我的预设库"），不给"给我一个路径，随便写"。
/// 渲染层自己拼 `%APPDATA%\<identifier>\...` 的话，一旦 Tauri 的标识符或
/// 版本升级策略变化，表现是"预设又丢了"，而没人会想到去查路径。
fn preset_library_path(app: &AppHandle) -> Result<PathBuf, ShellError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| ShellError::Io {
            path: "<app_config_dir>".to_string(),
            message: error.to_string(),
        })?;
    Ok(config_dir.join("preset-library.json"))
}

/// 读用户预设库（v0.1.5 / G5）。
///
/// 文件不存在 → 返回 `None`，**不是错误**：首次运行本来就没有这个文件，
/// 让调用方去区分"没文件"与"读失败"只会多一条误导性的错误提示。
///
/// 读失败（权限 / 非 UTF-8 / 超大）仍报错 —— 那说明**有文件但读不动**，
/// 属于用户需要知道的异常。
#[tauri::command]
pub fn read_preset_library(app: AppHandle) -> ShellResult<Option<TextFile>> {
    let target = preset_library_path(&app)?;
    if !target.exists() {
        return Ok(None);
    }
    read_text_impl(&target, paths::MAX_TEXT_BYTES).map(Some)
}

/// 写用户预设库（v0.1.5 / G5）。原子写 + 写后回读自证。
///
/// 与文本保存**共用** `write_atomic_impl`：原子性、写前摘要断言、写后回读
/// 三条保证不可能在其中一条路径上退化。
///
/// 这里比 `write_file_atomic` 多做一件小事：**按需创建父目录**。
/// `app_config_dir` 在首次运行、或用户清过配置后可能不存在，而
/// `write_atomic_impl` 要求父目录已存在（对用户选定的保存路径，那个要求是对的 ——
/// 不该悄悄替用户建目录）。这里的目录是本应用的私有配置目录，创建它是本职。
#[tauri::command]
pub fn write_preset_library(
    app: AppHandle,
    text: String,
    expected_sha256: Option<String>,
) -> ShellResult<WriteReceipt> {
    let target = preset_library_path(&app)?;
    if let Some(parent) = target.parent() {
        if !parent.is_dir() {
            fs::create_dir_all(parent).map_err(|error| ShellError::io(parent, error))?;
        }
    }
    write_atomic_impl(
        &target.to_string_lossy(),
        text.into_bytes(),
        expected_sha256,
    )
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
// SillyTavern 联动（v0.1.5 / F15 · T13.1）
// ─────────────────────────────────────────────────────────────
//
// 这一组能力的共同点：**它们都碰本地其它程序**，所以每一条都刻意窄：
//   · `probe_paths` 只回答"存不存在、是文件还是目录"，不读内容、不列目录；
//   · `find_st_candidates` 只在用户主目录下找 `SillyTavern*` 这一族名字，
//     不接受路径参数，也没有"列任意目录"的能力；
//   · `spawn_detached` 只启动**已通过 ST 判据的目录**里的三个固定目标；
//   · `open_external` 只放行 http/https。
//
// 为什么探测与判定要分家（Rust 判存在，TS 判"算不算 ST"）：
// 判据（package.json 的 scripts.start / server.js）属于**业务规则**，需要矩阵单测，
// 而 Rust 侧这份代码没有测试宿主（`cargo test` 只能覆盖不依赖 AppHandle 的部分）。
// 所以 Rust 只做"能拿到的原始事实"，判断留给 `client/src/session/st-install.ts`。
// 唯一的例外是 `spawn_detached`：它必须**在真正拉起进程前**再验一次判据，
// 否则"前端传个任意目录 + start.bat"就能启动任意批处理 —— 那是最该防的口子。

/// 一次 `probe_paths` 允许的条数上限。
///
/// 没有上限的话，这条命令等于"批量探测整台机器上哪些路径存在"的扫描器。
/// 64 足够覆盖 ST 检测（实际用 2~10 条），又不至于变成侦察工具。
pub const MAX_PROBE_PATHS: usize = 64;

/// 允许被启动的目标（白名单，**写死**）。
///
/// 三个目标对应 ST 的两种启动方式：
///   · `start.bat`  —— 官方 Windows 入口（ST 1.12/1.13 都叫 `Start.bat`，
///                     大小写不一致，见 `resolve_child_script`）；
///   · `server.js` / `node.exe` —— 直接跑 `node server.js`，用于没有 bat
///                     或 bat 里带交互的环境。两者语义相同（都以 server.js
///                     为入口），保留两个名字是因为 UI 上"用 node 启动"
///                     与"用脚本启动"是两件用户看得懂的事。
///
/// 这份清单是 `spawn_detached` 的**唯一**依据：不在表里的一律拒绝，
/// 不做"看起来像不像可执行文件"的猜测。
pub const SPAWN_TARGETS: [&str; 3] = ["start.bat", "node.exe", "server.js"];

/// 路径探测结果（对应 client/src/contract/types.ts 的 PathProbe）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathProbe {
    pub path: String,
    /// `"file"` / `"dir"` / `"none"` —— **不读内容、不列目录**
    pub exists: String,
}

/// SillyTavern 候选目录（对应 StCandidates）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StCandidates {
    /// 用户主目录（展示用）；拿不到时为 null
    pub home: Option<String>,
    /// 候选目录的绝对路径（**可能不存在**，由前端逐条探测）
    pub dirs: Vec<String>,
}

/// 启动回执（对应 SpawnReceipt）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnReceipt {
    pub pid: u32,
    /// 子进程输出的落点（诊断日志，同一目录下还有 client-error.log）
    pub log_path: Option<String>,
}

/// 探测一批路径的存在形态。
///
/// 为什么批量：ST 检测一次要问 2~10 条（候选目录的 package.json / server.js），
/// 逐条 IPC 会让面板打开时出现肉眼可见的延迟。
///
/// 为什么会话内不缓存：这东西的答案随时会变（用户正在装 ST），
/// 缓存只会让"装好了但界面还说没装"变成一个新的支持问题。
#[tauri::command]
pub fn probe_paths(paths: Vec<String>) -> ShellResult<Vec<PathProbe>> {
    if paths.len() > MAX_PROBE_PATHS {
        return Err(ShellError::TooManyPaths {
            count: paths.len(),
            limit: MAX_PROBE_PATHS,
        });
    }

    let mut out: Vec<PathProbe> = Vec::with_capacity(paths.len());
    for raw in paths {
        // 非绝对路径整批报错（而不是静默跳过）：调用方算错了路径，
        // 静默跳过会表现为"这些候选都不存在"，指向完全错误的方向。
        let target = paths::absolute_path(&raw)?;
        let exists = if target.is_dir() {
            "dir"
        } else if target.is_file() {
            "file"
        } else {
            // 含：不存在、无权限、符号链接断链、设备文件。
            // 探测不该因为其中一条失败就整批失败 —— 用户装机装到一半时
            // 半截目录很常见，那不是错误，是"还没装完"。
            "none"
        };
        out.push(PathProbe {
            path: raw,
            exists: exists.to_string(),
        });
    }

    Ok(out)
}

/// 列出 `SillyTavern*` 候选目录（**只扫用户主目录与各盘符根，不递归、不接受路径参数**）。
///
/// 标准位置 `%USERPROFILE%\SillyTavern` **无论存不存在都会出现在结果里**：
/// 它的作用是"让前端把标准位置也探一遍"，而不是"报告它存在"。
/// 少了这一条，"用户把 ST 装在默认位置"这种最常见的情况反而要靠猜。
///
/// ## 为什么要扫盘符根（2026-10-26 生产反馈追加）
///
/// 用户的 ST 装在 **`F:\SillyTavern`** —— 只扫 `%USERPROFILE%` 的话它永远扫不到，
/// 面板会报"未安装"，而用户明明正开着 ST 用得好好的（决策 #207 现场）。
/// 把 ST 放在空间最大的盘根目录是很常见的选择，所以盘符根必须看一眼。
///
/// 代价与边界：
///   · 只看根目录**下一层**、只认 `SillyTavern*` 前缀、只收目录 —— 不递归、不读内容；
///   · 盘符有上限（A–Z 最多 26 次 `read_dir`，不存在的盘会立刻返回），实测无感；
///   · 可移动盘未挂载时 `read_dir` 失败，**静默跳过**（那不是错误，是盘不在）。
#[tauri::command]
pub fn find_st_candidates(app: AppHandle) -> ShellResult<StCandidates> {
    let home = app.path().home_dir().ok();

    let mut dirs: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    // 闭包本身不需要 mut（它改的是捕获的 &mut 引用指向的数据）
    let push = |dirs: &mut Vec<String>, seen: &mut Vec<String>, path: PathBuf| {
        let key = path.display().to_string().to_ascii_lowercase();
        if seen.contains(&key) {
            return;
        }
        seen.push(key);
        if let Some(display) = paths::display_path(&path) {
            dirs.push(display);
        }
    };

    if let Some(home) = home.as_ref() {
        push(&mut dirs, &mut seen, home.join("SillyTavern"));
        // 1.13 起官方压缩包解压出的是 `SillyTavern-1.13.2` 这类带版本号的目录，
        // 也常见用户自己建的 `SillyTavern-test`。只按前缀匹配，不看别的名字。
        for path in collect_st_dirs(home) {
            push(&mut dirs, &mut seen, path);
        }
    }

    // 各盘符根（用户的 ST 可能装在任意盘 —— 现场就有一份在 F:\SillyTavern）
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        for path in collect_st_dirs(&root) {
            push(&mut dirs, &mut seen, path);
        }
    }

    dirs.sort();
    Ok(StCandidates {
        home: home.as_deref().and_then(paths::display_path),
        dirs,
    })
}

/// 列出某个目录**下一层**里名字以 `sillytavern` 开头的目录（大小写不敏感）。
///
/// 抽成独立函数是为了能单测：它决定"扫不扫得到用户的 ST"，而 `find_st_candidates`
/// 需要 `AppHandle`（cargo test 造不出来）。
///
/// 读不到目录（盘不存在 / 无权限 / 可移动盘没挂）返回空集，**不报错** ——
/// 那不是错误，是"这个位置没有"。
fn collect_st_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.to_ascii_lowercase().starts_with("sillytavern") {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        found.push(entry.path());
    }
    found.sort();
    found
}

/// ST 根的原始事实（判据由前端合成，见文件头说明）
struct StRootFacts {
    package_json: bool,
    start_script: bool,
    server_js: bool,
}

fn st_root_facts(dir: &Path) -> StRootFacts {
    let package_json_path = dir.join("package.json");
    let package_json = package_json_path.is_file();
    let mut start_script = false;
    if package_json {
        // 解析失败按"没有 start"处理：坏掉的 package.json 本来也跑不起来，
        // 而且这里只用于"要不要允许启动"的放行判断 —— 宁可拒绝。
        if let Ok(text) = fs::read_to_string(&package_json_path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                start_script = value
                    .get("scripts")
                    .and_then(|scripts| scripts.get("start"))
                    .map(|start| start.is_string())
                    .unwrap_or(false);
            }
        }
    }
    StRootFacts {
        package_json,
        start_script,
        server_js: dir.join("server.js").is_file(),
    }
}

/// 与前端 `judgeStInstall` 同一条判据：**package.json 存在 且（scripts.start 或 server.js）**。
fn looks_like_st_root(dir: &Path) -> bool {
    let facts = st_root_facts(dir);
    facts.package_json && (facts.start_script || facts.server_js)
}

/// 在目录里按**大小写不敏感**找文件名（`Start.bat` 与 `start.bat` 是同一个文件）。
fn resolve_child_script(dir: &Path, wanted: &str) -> Option<PathBuf> {
    let direct = dir.join(wanted);
    if direct.is_file() {
        return Some(direct);
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.eq_ignore_ascii_case(wanted) && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

/// 子进程输出落点：`<应用配置目录>/logs/st-launch.log`。
///
/// 与 `client-error.log` **同一目录**（需求原话"记 client-error.log 同级诊断日志"），
/// 但不共用文件：一次启动的输出可能有几千行，混进错误日志会把
/// "最近那次崩溃"挤到翻不到的位置。
fn st_launch_log_path(app: &AppHandle) -> Result<PathBuf, ShellError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| ShellError::Io {
            path: "<app_config_dir>".to_string(),
            message: error.to_string(),
        })?;
    Ok(config_dir.join("logs").join("st-launch.log"))
}

/// 启动本地 SillyTavern（F15 / T13.4）。
///
/// 三条安全约束都在**这里**兜底，不依赖前端：
///   1. `cwd` 必须是绝对路径、确实存在、且是一个目录；
///   2. `cwd` **必须自己通过 ST 判据** —— 不是"前端说它是 ST 就算"。这条最关键：
///      没有它，任何目录放一个 `start.bat` 就能被这条命令拉起；
///   3. `cmd` 只能取 `SPAWN_TARGETS` 里的三个名字，且对应文件真的在那目录里。
///
/// 为什么捕获输出而不是让它开一个控制台窗口：开窗的话失败信息只存在于
/// 那个窗口里，用户关掉就没了，我们也没法把 ST 自己的报错贴到面板上。
/// 这里用 `CREATE_NO_WINDOW` + 重定向到 `st-launch.log`，失败时前端读这个文件
/// 就能把 ST 的原话显示出来（见 `SpawnReceipt.logPath`）。
///
/// 进程不等待、不 kill：ST 是长期运行的服务，壳退出后它也该继续活着。
#[tauri::command]
pub fn spawn_detached(app: AppHandle, cmd: String, cwd: String) -> ShellResult<SpawnReceipt> {
    use std::process::{Command, Stdio};

    let target_dir = paths::absolute_path(&cwd)?;
    let reject = |reason: &str| ShellError::SpawnRejected {
        target: target_dir.display().to_string(),
        reason: reason.to_string(),
    };

    if !target_dir.is_dir() {
        return Err(reject("该路径不存在或不是目录"));
    }

    let normalized = cmd.trim().to_ascii_lowercase();
    if !SPAWN_TARGETS.contains(&normalized.as_str()) {
        return Err(ShellError::SpawnRejected {
            target: cmd.clone(),
            reason: format!("只允许启动 {}", SPAWN_TARGETS.join(" / ")),
        });
    }

    if !looks_like_st_root(&target_dir) {
        return Err(reject(
            "该目录不像 SillyTavern（缺 package.json 的 scripts.start，或没有 server.js）",
        ));
    }

    let log_path = st_launch_log_path(&app)?;
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| ShellError::io(parent, error))?;
    }
    // 每次启动重写：留着上一次的输出会让"这次为什么失败"更难判断
    let stdout = File::create(&log_path).map_err(|error| ShellError::io(&log_path, error))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| ShellError::io(&log_path, error))?;

    let mut command = match normalized.as_str() {
        "start.bat" => {
            let script = resolve_child_script(&target_dir, "start.bat")
                .ok_or_else(|| reject("该目录里没有 start.bat / Start.bat"))?;
            let mut command = Command::new("cmd");
            // 用文件名而不是绝对路径：`Start.bat` 里的相对路径依赖 cwd，
            // 而 cwd 已经设成 ST 根目录了。
            command.arg("/C").arg(
                script
                    .file_name()
                    .ok_or_else(|| reject("start.bat 文件名非法"))?,
            );
            command
        }
        _ => {
            if !target_dir.join("server.js").is_file() {
                return Err(reject("该目录里没有 server.js"));
            }
            let mut command = Command::new("node.exe");
            command.arg("server.js");
            command
        }
    };

    command
        .current_dir(&target_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    // CREATE_NO_WINDOW：不弹黑框；输出已经重定向到日志文件
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            /*
             * 失败必须留痕（v0.1.5 生产反馈）。
             *
             * 线上那次：`st-launch.log` 是 **0 字节**、`client-error.log` 里一个字都没有，
             * 用户只看到一句"启动失败"—— 谁也说不清是缺 node、缺 bat 还是被拦。
             * 现在的顺序是：先写诊断（含 cmd、cwd、OS 原始错误），再返回错误。
             */
            let entry = format!(
                "[{}] spawn_detached FAILED cmd={} cwd={} error={}",
                now_iso8601(),
                normalized,
                target_dir.display(),
                error
            );
            let _ = append_error_log_impl(&app, &entry);
            return Err(ShellError::Io {
                path: target_dir.display().to_string(),
                message: format!("启动 {normalized} 失败：{error}"),
            });
        }
    };
    let pid = child.id();
    // 不 wait、不 kill：drop 掉 Child 后子进程继续运行（Windows 上不会连带终止）
    drop(child);

    // 诊断留痕：这一行是"某天 ST 起不来"时唯一能对上号的时间点
    let entry = format!(
        "[{}] spawn_detached cmd={} cwd={} pid={}",
        now_iso8601(),
        normalized,
        target_dir.display(),
        pid
    );
    // 日志写不进去不能拦住"已经启动成功"这件事 —— 尽力而为
    let _ = append_error_log_impl(&app, &entry);

    Ok(SpawnReceipt {
        pid,
        log_path: paths::display_path(&log_path),
    })
}

/// 解压回执（对应 `ExtractReceipt`）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReceipt {
    pub dest_path: Option<String>,
    /// 解压后目标目录是否已经像 ST（判据同 `looks_like_st_root`）
    pub has_st_structure: bool,
}

/// 把 ST 的 release zip 解压到目标目录（F15 / T13.3「一键安装」的 c 步）。
///
/// ## 为什么调系统 `tar.exe` 而不是引 `zip` crate
///
/// 解压 zip 需要 deflate 实现，Rust 标准库没有；引 `zip` 会连带 `flate2`
/// （以及它的一串构建依赖）。本项目刻意维持"依赖表不动"（base64 都是手写的），
/// 而 Windows 10 1803 起 `System32\tar.exe`（bsdtar）本来就能解 zip ——
/// Tauri 2 又要求 WebView2，等于要求 Win10+，这个前提本来就成立。
///
/// **必须用绝对路径** `%SystemRoot%\System32\tar.exe`：打包后的应用 PATH 与开发机
/// 不同，`Command::new("tar")` 可能解析到 Git 自带的 GNU tar（对 zip 支持不一），
/// 也可能解析不到 —— 那种失败极难从现象反推。
///
/// ## 沙箱边界
///
/// `dest_dir` **必须落在用户主目录下**。一键安装的功能是"装到我的 SillyTavern 目录"，
/// 没有任何正当理由往别处铺文件；这一条把"下载+解压"从"任意位置写文件"
/// 收窄成"只在用户家里装东西"。
#[tauri::command]
pub fn extract_zip_to(app: AppHandle, zip_path: String, dest_dir: String) -> ShellResult<ExtractReceipt> {
    use std::process::Command;

    let zip = paths::absolute_path(&zip_path)?;
    let dest = paths::absolute_path(&dest_dir)?;

    if !zip.is_file() {
        return Err(ShellError::PathNotFound {
            path: zip.display().to_string(),
        });
    }
    let is_zip = zip
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);
    if !is_zip {
        return Err(ShellError::ExtNotAllowed {
            name: zip.display().to_string(),
        });
    }

    let home = app.path().home_dir().map_err(|error| ShellError::Io {
        path: "<home_dir>".to_string(),
        message: error.to_string(),
    })?;
    // 用 canonicalize 比较：`C:\Users\x\..\Windows` 这类写法要能被拒掉
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.clone());
    if !dest.exists() {
        fs::create_dir_all(&dest).map_err(|error| ShellError::io(&dest, error))?;
    }
    let canonical_dest = dest.canonicalize().unwrap_or_else(|_| dest.clone());
    if !canonical_dest.starts_with(&canonical_home) {
        return Err(ShellError::PathNotAllowed {
            path: dest.display().to_string(),
        });
    }

    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let tar = PathBuf::from(system_root).join("System32").join("tar.exe");
    if !tar.is_file() {
        return Err(ShellError::Io {
            path: tar.display().to_string(),
            message: "系统里找不到 tar.exe（Windows 10 1803+ 自带）。请手动解压下载到的 zip，再点「重新检测」。"
                .to_string(),
        });
    }

    let output = Command::new(&tar)
        .arg("-x")
        .arg("-f")
        .arg(&zip)
        .arg("-C")
        .arg(&dest)
        .output()
        .map_err(|error| ShellError::io(&tar, error))?;

    if !output.status.success() {
        // 把 tar 自己的话带出去：解压失败的原因（空间不足/路径过长/zip 损坏）
        // 只有它知道，我们不能用"解压失败"盖掉
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: String = stderr.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(ShellError::Io {
            path: dest.display().to_string(),
            message: format!("解压失败（tar 退出码 {:?}）：{}", output.status.code(), tail.trim()),
        });
    }

    Ok(ExtractReceipt {
        dest_path: paths::display_path(&dest),
        has_st_structure: looks_like_st_root(&dest),
    })
}

/// 回环端口探测回执（对应 `PortProbe`）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProbe {
    pub alive: bool,
    pub host: String,
    pub port: u16,
    pub elapsed_ms: u64,
    /// `io::ErrorKind` 的可读名（`ConnectionRefused` / `TimedOut` / `PermissionDenied`…）
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

/// 单次 TCP 探测的超时（毫秒）。与 TS 侧 `ST_PROBE_TIMEOUT_MS` 同值。
pub const PORT_PROBE_TIMEOUT_MS: u64 = 1500;

/// 允许被探测的主机名（**只有回环**，小写比较）。
///
/// v0.1.6 / T14.0：探针从"端口写死 8000、主机写死 127.0.0.1"泛化成
/// `probe_tcp(host, port)`，因为 ST 的端口可配（`config.yaml` 的 `listenPort`），
/// 用户也可能多开。但**主机名仍然只能回环**，这条边界与 F0/D3 是同一条：
///
///   · 内嵌代理的目标只允许本机（`/st/*` 转发），探针是它的前置检查，
///     两者口径必须一致 —— 否则会出现"探针能测外网、代理却拒绝"的撕裂；
///   · 更实际的风险：配置文件（`client-config.json`）是普通 JSON，用户能被
///     诱导改成内网/外网地址；若探针接受任意 host，它就变成一台
///     **端口扫描器 + 内网连通性探测器**，而且是"客户端本机发出"的，
///     绕过了所有基于浏览器源的防护。
///
/// `localhost` 与 `::1` 也放行：用户会照着 ST 控制台的
/// `Go to: http://localhost:8000/` 抄，`localhost` 与 `127.0.0.1` 在这里等价。
pub const PROBE_ALLOWED_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// 默认 ST 地址（`host:port`）——**壳侧唯一来源**。
///
/// 与 TS 的 `contract/types.ts` 里的 `ST_DEFAULT_ADDRESS` 是同一个值，
/// 两侧靠 `test/fixtures/st-address-cases.json` 的 `default` 字段对拍：
/// 这个值一旦分叉，症状是"设置里显示 8000、代理却去连 8001"。
pub const ST_DEFAULT_ADDRESS: &str = "127.0.0.1:8000";

/// 规范化主机名并校验它在 [`PROBE_ALLOWED_HOSTS`] 内。
///
/// 只做**大小写与首尾空白**归一，不做 DNS 解析：
/// `localhost.evil.com` 这种必须被拒，而任何"解析后再看是不是回环"的做法都会
/// 把判断交给 DNS —— 那是可以被 hosts 文件与 DNS 投毒操纵的。
fn normalize_probe_host(raw: &str) -> Option<String> {
    let lowered = raw.trim().to_ascii_lowercase();
    // IPv6 字面量允许带方括号（`[::1]` 是 URL 里的常见写法）
    let bare = lowered
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(&lowered)
        .to_string();
    if PROBE_ALLOWED_HOSTS.contains(&bare.as_str()) {
        Some(bare)
    } else {
        None
    }
}

/// 探测**回环地址**上某个端口有没有人 accept（v0.1.5 生产反馈追加；
/// v0.1.6 / T14.0 泛化为 `probe_tcp(host, port)`）。
///
/// ## 为什么这条判据必须在壳里，而不是在 webview 里 fetch
///
/// 线上实测：ST 已经在 `0.0.0.0:8000` 上跑，webview 里的 `fetch(no-cors)` 仍然
/// reject，面板报"没有应答"。而 ST 自己的访问日志里**从头到尾没有一条来自 webview
/// 的连接** —— 请求在浏览器网络层就没出去（系统代理 / 安全软件 / 本地网络权限都
/// 可能）。这一层跟"ST 有没有发 CORS 头"毫无关系，所以换 fetch 的写法解决不了。
///
/// TCP `connect` 不经过任何 HTTP 中间层：能连上 = 端口有人在听 = ST 活着。
/// 这正是需求要的那一个比特。
///
/// ## 边界（两条，都在壳侧，不接受调用方绕过）
///
///   1. `host` 必须是回环（见 [`PROBE_ALLOWED_HOSTS`]），否则报
///      `PROBE_HOST_NOT_ALLOWED` —— 所以它**不是**端口扫描器；
///   2. 端口范围 1–65535（`u16` 已经从类型上保证了上界，0 单独拒）。
///
/// 失败**不返回 Err**：连不上是正常结论（`alive: false` + `errorKind`），
/// 只有"参数不合法"才是 Err —— 那是调用方写错了，静默返回 false 会让人以为
/// "ST 没开"。
#[tauri::command]
pub fn probe_tcp(host: String, port: u16) -> ShellResult<PortProbe> {
    use std::net::{Shutdown, TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Some(normalized) = normalize_probe_host(&host) else {
        return Err(ShellError::ProbeHostNotAllowed {
            host,
            allowed: PROBE_ALLOWED_HOSTS.join(" / "),
        });
    };
    if port == 0 {
        return Err(ShellError::Io {
            path: format!("{normalized}:0"),
            message: "端口必须在 1–65535 之间".to_string(),
        });
    }

    let started = Instant::now();
    // 用 `to_socket_addrs` 而不是手拼 `SocketAddr`：`::1` 要按 IPv6 走，
    // 而 `localhost` 在本机可能同时解析出 v4/v6 两个地址。这里**只解析**上面
    // 已校验过的三个名字，解析结果不可能跑到别的机器上。
    let target = (normalized.as_str(), port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| addrs.next());

    let Some(addr) = target else {
        return Ok(PortProbe {
            alive: false,
            host: normalized,
            port,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error_kind: Some("AddrNotAvailable".to_string()),
            error_message: Some("这个主机名在本机解析不出地址".to_string()),
        });
    };

    match TcpStream::connect_timeout(&addr, Duration::from_millis(PORT_PROBE_TIMEOUT_MS)) {
        Ok(stream) => {
            // 立刻关掉：我们只要"能连上"这个事实，不在这条连接上收发任何数据
            let _ = stream.shutdown(Shutdown::Both);
            Ok(PortProbe {
                alive: true,
                host: normalized,
                port,
                elapsed_ms: started.elapsed().as_millis() as u64,
                error_kind: None,
                error_message: None,
            })
        }
        Err(error) => Ok(PortProbe {
            alive: false,
            host: normalized,
            port,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error_kind: Some(format!("{:?}", error.kind())),
            error_message: Some(error.to_string()),
        }),
    }
}

/// 打开一个**外部 URL**（F15 / T13.4、T13.5：推送完要打开 ST 页面）。
///
/// 只放行 `http://` / `https://`：`file://` 能打开本地任意文件（含 `.exe`），
/// `javascript:` / `data:` 在系统默认程序里也有各自的坑。这里不做"解析后再判断"
/// 的宽松处理 —— 前缀不匹配直接拒，越简单越不可能被绕过。
///
/// 控制字符与空白一律拒：这条命令的入参来自于"我们自己拼的 URL"，
/// 一旦出现换行/空格，说明上游拼接被污染了，此时拒绝比"帮他清理一下"安全。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> ShellResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();
    let allowed = lowered.starts_with("http://") || lowered.starts_with("https://");
    let polluted = trimmed.chars().any(|c| c.is_control() || c.is_whitespace());

    if !allowed || polluted {
        return Err(ShellError::ExtNotAllowed {
            name: trimmed.to_string(),
        });
    }

    app.opener()
        .open_url(trimmed.to_string(), None::<&str>)
        .map_err(|error| ShellError::Io {
            path: trimmed.to_string(),
            message: format!("打开链接失败：{error}"),
        })
}

/// 当前时间的 ISO-8601（秒精度）。
///
/// 不引 chrono / time 就是为了一个时间戳：这里把 UNIX 秒手工换算成
/// 年月日时分秒，只覆盖 1970..=9999，够用到本世纪结束。
fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // 从 1970-01-01 起按 400 年格里高利周期推进
    let mut year = 1970_i64;
    let mut remaining = days as i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lengths = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1_usize;
    for length in month_lengths {
        if remaining < length {
            break;
        }
        remaining -= length;
        month += 1;
    }

    format!(
        "{year:04}-{month:02}-{:02}T{hour:02}:{minute:02}:{second:02}Z",
        remaining + 1
    )
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
    append_error_log_impl(&app, &entry)
}

/// 追加日志的唯一实现（v0.1.5 / F15 抽出）。
///
/// 抽出来是因为 `spawn_detached` 也要留痕（"某天 ST 起不来"时唯一能对上号的
/// 时间点），而它拿的是 `&AppHandle`。复制一份写入逻辑的话，轮转、截断、
/// fsync 这三条保证迟早会在一处松掉 —— 而日志恰恰是出问题时才被发现不靠谱的东西。
fn append_error_log_impl(app: &AppHandle, entry: &str) -> ShellResult<String> {
    let target = error_log_path(app)?;
    let text = normalize_error_log_entry(entry);

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
// 本地回环反向代理（v0.1.6 / T14.1 / F2 F3）
// ─────────────────────────────────────────────────────────────

/// 代理的进程内状态：至多一个（面板是单例，多开没有意义）。
///
/// `std::sync::Mutex` 而不是 tokio 的：**持锁区间里没有 await**
/// （起代理与停代理都是在锁外 await 完再进锁换值），所以不会阻塞运行时。
pub struct ProxyState(std::sync::Mutex<Option<crate::proxy::RunningProxy>>);

impl Default for ProxyState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

impl ProxyState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<crate::proxy::RunningProxy>> {
        // 中毒（某个持有者 panic）不该让整个面板永远起不来 —— 代理本身没有
        // 需要保持一致性的不变量，恢复数据继续用是安全的
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 从配置文件读 ST 地址（`stAddress`），读不到就是 `None`（= 用默认值）。
///
/// **为什么由壳自己读，而不是让渲染层传目标**（决策 #221）：目标是这个代理的
/// 唯一安全边界。渲染层一传参，边界就变成"渲染层说了算"，而被注入的脚本也在
/// 渲染层里 —— 那时候这个端口就是一台到任意主机的代理。
///
/// 注意这里**不校验**、只取字符串：校验在 `proxy::resolve_st_target` 里，
/// 与 TS 侧同一套规则（配 fixture 对拍）。读失败（文件不存在/坏 JSON）不是错误，
/// 首次运行本来就没有这个文件。
fn read_configured_st_address(app: &AppHandle) -> Option<String> {
    let config_dir = app.path().app_config_dir().ok()?;
    let text = fs::read_to_string(config_dir.join("client-config.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("stAddress")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

/// 起代理并把它的地址交给渲染层。
///
/// **不接受任何目标参数**：目标来自配置（见上）。重复调用返回**同一个端口** ——
/// 换端口会让 iframe 整页重载，用户会以为"面板坏了"。
///
/// **记录在、监听器已死时要重新起**（v0.1.6 生产缺陷）：否则会把一个死端口
/// 当成"已在运行"一直返回，面板永远打不开，而徽章（走 ST 探针）照样是绿的。
#[tauri::command]
pub async fn st_proxy_start(
    app: AppHandle,
    state: tauri::State<'_, ProxyState>,
) -> ShellResult<crate::proxy::ProxyInfo> {
    let stale_port = {
        let mut guard = state.lock();
        match guard.as_ref() {
            Some(running) if running.is_alive() => return Ok(running.info()),
            Some(running) => {
                // 死掉的记录：先摘掉再往下重新起。记下端口是为了让留痕能说清
                // "哪一条死了"，而不是只说"重启了一次"。
                let port = running.info().port;
                guard.take();
                Some(port)
            }
            None => None,
        }
    };
    if let Some(port) = stale_port {
        log::warn!("ST 代理的监听器已退出（端口 {port}），本次调用重新起一个");
    }

    let target = crate::proxy::resolve_st_target(read_configured_st_address(&app).as_deref());
    let started = crate::proxy::RunningProxy::start(target)
        .await
        .map_err(|error| ShellError::Io {
            path: "127.0.0.1:0".to_string(),
            message: format!("起本地代理失败：{error}"),
        })?;
    let info = started.info();

    /*
     * 抢位：锁里**只做替换，不 await**。
     *
     * `MutexGuard` 不是 Send，跨越 await 会让整个命令的 Future 不是 Send，
     * `generate_handler!` 直接编译失败。所以流程拆成"锁内决策 / 锁外收尾"：
     * 锁里只回答"是我占位，还是别人先占了"，await 放到锁外面。
     */
    let mut started = Some(started);
    let displaced = {
        let mut guard = state.lock();
        match guard.as_ref() {
            // 竞态：两次点击同时走到这里。后到的自己收掉，别把先到的挤掉 ——
            // 挤掉的那个 iframe 会一脸茫然地白屏
            Some(existing) => Some(existing.info()),
            None => {
                *guard = started.take();
                return Ok(info);
            }
        }
    };

    if let Some(started) = started.take() {
        started.shutdown().await;
    }
    Ok(displaced.unwrap_or(info))
}

/// 停代理并**等到端口真的释放**（面板关闭 / 应用退出时调用）。
///
/// `port` 是调用方**认为自己拥有的那个端口**。端口对不上就什么都不做 ——
/// 迟到的停止请求不该杀掉后来新起的代理（时序见 `proxy::should_stop` 的注释）。
/// 不传 = 停当前这条（应用退出走这条）。
#[tauri::command]
pub async fn st_proxy_stop(
    state: tauri::State<'_, ProxyState>,
    port: Option<u16>,
) -> ShellResult<()> {
    let (running, skipped) = {
        let mut guard = state.lock();
        let should = match guard.as_ref() {
            Some(existing) => crate::proxy::should_stop(port, existing.info().port),
            None => false,
        };
        if should {
            (guard.take(), None)
        } else {
            (None, guard.as_ref().map(|existing| existing.info().port))
        }
    };
    if let Some(current) = skipped {
        // 记一条：这条日志是"迟到的停止请求被正确忽略"的唯一证据
        log::info!("忽略了对端口 {current} 的停止请求（请求方持有的是 {port:?}）");
    }
    if let Some(running) = running {
        running.shutdown().await;
    }
    Ok(())
}

/// 代理现在什么状态（渲染层刷新面板时用它决定要不要重新起）。
#[tauri::command]
pub fn st_proxy_status(state: tauri::State<'_, ProxyState>) -> crate::proxy::ProxyStatus {
    let guard = state.lock();
    // `running` 与 `alive` 分别回答两件事：记录在不在、监听器还在不在
    crate::proxy::ProxyStatus::of(
        guard
            .as_ref()
            .map(|running| (running.info(), running.is_alive(), running.stats())),
    )
}

/// 应用退出时强制回收端口。
///
/// 进程退出本来会关掉所有 socket，所以这条**不是**为了"防止端口泄漏"，
/// 而是为了两件事：
///   1. 以后若加了"关到托盘"（窗口销毁但进程还在），端口不会继续开着；
///   2. 退出前把在途连接断干净，避免 ST 那边留一堆半开连接。
pub fn stop_proxy_blocking(app: &AppHandle) {
    let state = app.state::<ProxyState>();
    let running = {
        let mut guard = state.lock();
        guard.take()
    };
    let Some(running) = running else { return };
    // 已经在 tokio 运行时线程上时不能再 block_on（会 panic：Cannot start a
    // runtime from within a runtime）。这时只能交给运行时去收 —— 进程退出本身
    // 会关闭所有 socket，所以"端口回收"这件事两种路径都成立。
    if tokio::runtime::Handle::try_current().is_ok() {
        tauri::async_runtime::spawn(async move { running.shutdown().await });
    } else {
        tauri::async_runtime::block_on(running.shutdown());
    }
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

    // ── F15 / T13.1：ST 判据、启动白名单、路径探测 ──────────────
    //
    // 这三处是"放行"逻辑：放错了就是让任意目录里的批处理被拉起，
    // 或者让一个不像 ST 的目录通过检查后在启动时炸掉。所以判据必须有矩阵。

    /// 写一个最小 ST 结构，返回目录
    fn fake_st_root(tag: &str, package_json: Option<&str>, server_js: bool) -> PathBuf {
        let dir = temp_dir(tag);
        fs::create_dir_all(&dir).unwrap();
        if let Some(text) = package_json {
            fs::write(dir.join("package.json"), text).unwrap();
        }
        if server_js {
            fs::write(dir.join("server.js"), b"// noop\n").unwrap();
        }
        dir
    }

    #[test]
    fn st_criteria_matrix() {
        // 判据：package.json 存在 **且**（scripts.start 或 server.js 存在）
        let with_start = r#"{"scripts":{"start":"node server.js"}}"#;
        let without_start = r#"{"scripts":{"build":"tsc"}}"#;

        // ① 有 package.json + scripts.start → 是 ST（不要求 server.js）
        let dir = fake_st_root("st-start", Some(with_start), false);
        assert!(looks_like_st_root(&dir), "scripts.start 就够了");
        let _ = fs::remove_dir_all(&dir);

        // ② 有 package.json + server.js（没有 start）→ 是 ST
        let dir = fake_st_root("st-serverjs", Some(without_start), true);
        assert!(looks_like_st_root(&dir), "server.js 是第二条兼容判据");
        let _ = fs::remove_dir_all(&dir);

        // ③ 有 package.json，但既没 start 也没 server.js → 不是
        let dir = fake_st_root("st-neither", Some(without_start), false);
        assert!(!looks_like_st_root(&dir), "两个判据都不满足就不能放行");
        let _ = fs::remove_dir_all(&dir);

        // ④ 没有 package.json，只有 server.js → 不是（缺一半判据）
        let dir = fake_st_root("st-no-pkg", None, true);
        assert!(!looks_like_st_root(&dir), "没有 package.json 不算 ST");
        let _ = fs::remove_dir_all(&dir);

        // ⑤ package.json 是坏 JSON，但有 server.js → **算 ST**
        //
        // 这条一开始写成了"不该放行"，那是把判据当成了"package.json 可解析"。
        // 需求给的判据是"package.json 存在 且（scripts 含 start 或 server.js 存在）"——
        // 存在不等于可解析，而 `node server.js` 也确实跑得起来。
        // 修的是测试的期望值，不是实现（与"既有测试把缺陷写成期望值"相反的方向：
        // 这次是测试比需求更严）。
        let dir = fake_st_root("st-broken", Some("{not json"), true);
        assert!(
            looks_like_st_root(&dir),
            "server.js 在，就算 package.json 坏了也该放行"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn child_script_resolution_is_case_insensitive() {
        // ST 官方压缩包里是 `Start.bat`（大写 S），而白名单里写的是 `start.bat`。
        // Windows 的文件系统本身不区分大小写，所以 `join("start.bat").is_file()`
        // 已经能命中；真正要证明的是**命中的是磁盘上那个文件**，而不是一个
        // 看起来同名、实际由我们拼出来的路径。
        let dir = temp_dir("st-case");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("Start.bat"), b"@echo off\n").unwrap();

        let found = resolve_child_script(&dir, "start.bat").expect("大小写不该影响查找");
        // canonicalize 会把路径换成磁盘上的真实大小写（Windows 上还带 \\?\ 前缀），
        // 这是"两者是同一个文件"的直接证据 —— 比断言字符串相等可靠，
        // 因为断言字符串相等会随文件系统是否区分大小写而变（本机就不区分）。
        let real = fs::canonicalize(&found).expect("应当能解析到真实路径");
        assert_eq!(
            real.file_name().unwrap().to_string_lossy(),
            "Start.bat",
            "找到的应当是磁盘上那个真实名字"
        );
        assert!(resolve_child_script(&dir, "nothere.bat").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn spawn_whitelist_is_exactly_three_targets() {
        // 白名单是"启动任意程序"与"只启动 ST"之间的那道门，改动必须是有意的
        assert_eq!(SPAWN_TARGETS, ["start.bat", "node.exe", "server.js"]);
        for forbidden in [
            "powershell.exe",
            "cmd.exe",
            "..\\evil.bat",
            "C:\\Windows\\System32\\calc.exe",
            "start.bat & calc",
        ] {
            assert!(
                !SPAWN_TARGETS.contains(&forbidden),
                "{forbidden} 不该在白名单里"
            );
        }
    }

    #[test]
    fn probe_paths_reports_file_dir_and_none() {
        let dir = temp_dir("probe-paths");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("package.json");
        fs::write(&file, b"{}").unwrap();
        let missing = dir.join("nope.json");

        let result = probe_paths(vec![
            dir.display().to_string(),
            file.display().to_string(),
            missing.display().to_string(),
        ])
        .expect("探测应成功");

        assert_eq!(result[0].exists, "dir");
        assert_eq!(result[1].exists, "file");
        assert_eq!(result[2].exists, "none");
        // 原样回传：调用方要拿它去对上"我问的是哪一条"
        assert_eq!(result[2].path, missing.display().to_string());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn probe_paths_rejects_relative_and_oversized_batches() {
        assert!(probe_paths(vec!["relative/path".to_string()]).is_err(), "相对路径必须拒绝");

        let too_many: Vec<String> = (0..=MAX_PROBE_PATHS)
            .map(|index| format!("C:\\probe-{index}"))
            .collect();
        match probe_paths(too_many) {
            Err(ShellError::TooManyPaths { count, limit }) => {
                assert_eq!(count, MAX_PROBE_PATHS + 1);
                assert_eq!(limit, MAX_PROBE_PATHS);
            }
            other => panic!("超过上限应当报 TooManyPaths，实际 {other:?}"),
        }
    }

    // ── F15 生产反馈：回环端口探测 ──────────────────────────

    #[test]
    fn collect_st_dirs_matches_prefix_case_insensitively_and_dirs_only() {
        // 这条决定"扫不扫得到用户的 ST"：现场那份在 F:\SillyTavern，
        // 靠的就是盘符根上的前缀匹配。
        let root = temp_dir("st-collect");
        fs::create_dir_all(&root).unwrap();
        for name in ["SillyTavern", "sillytavern-1.13.2", "MySillyTavern", "SillyTavern-notes"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        // 同名但**是文件**的：不该被当成安装目录
        fs::write(root.join("SillyTavern.txt"), b"x").unwrap();

        let found = collect_st_dirs(&root);
        let names: Vec<String> = found
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().to_string())
            .collect();

        /*
         * `SillyTavern-notes` 会被收进来 —— 这是**刻意的**，不是漏洞：
         *
         * 收集阶段只按前缀筛，判断阶段（`looks_like_st_root`：package.json +
         * scripts.start/server.js）才决定它算不算 ST。如果收集阶段就猜"notes 不像 ST"，
         * 那 `SillyTavern-1.13.2`、`SillyTavern-test`、`SillyTavern 备份` 这些
         * 都得逐个加白名单，最后必然漏。
         *
         * 真正要挡的是两类：**不以该前缀开头的**（MySillyTavern）与**不是目录的**
         * （SillyTavern.txt）—— 那两类收进来纯属噪声。
         */
        assert_eq!(
            names,
            vec!["SillyTavern", "SillyTavern-notes", "sillytavern-1.13.2"],
            "前缀匹配 + 只收目录；MySillyTavern（前缀不符）与 SillyTavern.txt（是文件）都该排除"
        );
        assert!(
            !names.iter().any(|name| name.contains("My")),
            "MySillyTavern 不该出现在候选里"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn collect_st_dirs_returns_empty_for_missing_dir() {
        // 不存在的盘（可移动盘没挂）必须静默返回空集，不能报错打断整轮检测
        let missing = temp_dir("st-collect-missing");
        assert!(collect_st_dirs(&missing).is_empty());
    }

    // ── T14.0：回环 TCP 探针（probe_tcp）────────────────────

    /// 取一个"确定没人听"的回环端口：先绑再立刻释放。
    fn closed_loopback_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("应当能绑定回环端口");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    #[test]
    fn probe_tcp_detects_listening_socket() {
        // 真起一个监听（绑 0 端口让 OS 分配，避免撞上用户机器上真在跑的 8000）
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("应当能绑定回环端口");
        let port = listener.local_addr().unwrap().port();

        let result = probe_tcp("127.0.0.1".to_string(), port).expect("回环地址应当被放行");
        assert!(result.alive, "端口有人 listen 时必须判活着：{result:?}");
        assert_eq!(result.host, "127.0.0.1");
        assert_eq!(result.port, port);
        assert!(result.error_kind.is_none(), "成功时不该带错误类型");

        drop(listener);
    }

    #[test]
    fn probe_tcp_reports_not_listening_after_close() {
        let port = closed_loopback_port();
        let result = probe_tcp("127.0.0.1".to_string(), port).expect("回环地址应当被放行");
        assert!(!result.alive, "端口关掉后必须判没活着");

        /*
         * 期望的错误类型**不止一种**，这不是放宽，是实测结论：
         *
         * 本机（Windows，会话内）关掉的回环端口，收到的是 **TimedOut** 而不是
         * ConnectionRefused —— 即 SYN 被静默丢弃而不是回 RST（防火墙/安全软件
         * 常这么干）。第一版断言 `== ConnectionRefused` 因此红了。
         *
         * 对产品的含义：**不能把 TimedOut 当成"另一种故障"去引导用户**，
         * 它就是"没人应答"的一种现实形态；同时也说明超时兜底是必需的
         * （没有 timeout 这一条会挂满 21 秒的默认 TCP 重试）。
         */
        let kind = result.error_kind.as_deref();
        assert!(
            matches!(kind, Some("ConnectionRefused") | Some("TimedOut") | Some("HostUnreachable")),
            "关掉的端口应当报「没人听」那一类错误，实际：{result:?}"
        );
        assert!(result.error_message.is_some(), "要把 OS 原话带出去");
        assert!(
            result.elapsed_ms >= 1,
            "耗时字段要能反映「立刻被拒」与「卡到超时」的差别：{result:?}"
        );
    }

    #[test]
    fn probe_tcp_accepts_the_three_loopback_spellings() {
        // 用户会照着 ST 控制台的 `Go to: http://localhost:8000/` 抄地址，
        // 也有人在 URL 里写 `[::1]`。三种都该被认出是回环。
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("应当能绑定回环端口");
        let port = listener.local_addr().unwrap().port();

        for spelling in ["127.0.0.1", "localhost", "LOCALHOST", " 127.0.0.1 ", "[::1]"] {
            let result = probe_tcp(spelling.to_string(), port).unwrap_or_else(|error| {
                panic!("{spelling} 应当被当作回环放行，实际报错：{error}");
            });
            // `::1` 在只绑了 v4 回环的机器上连不上是正常的，这里**只断言没被拒**：
            // 被拒会走 Err（PROBE_HOST_NOT_ALLOWED），而合法性判断正是本用例要证的。
            assert_eq!(result.port, port);
            assert!(
                result.alive || result.error_kind.is_some(),
                "非 alive 时必须给出错误类型：{result:?}"
            );
        }

        drop(listener);
    }

    #[test]
    fn probe_tcp_rejects_non_loopback_hosts() {
        // 这是 v0.1.6 的安全边界：配置文件是普通 JSON，能被诱导改成内网/外网地址。
        // 探针若接受任意 host，就变成"客户端本机发出"的端口扫描器。
        for host in [
            "192.168.1.1",
            "10.0.0.5",
            "example.com",
            "localhost.evil.com",
            "127.0.0.1.nip.io",
            "",
            " ",
        ] {
            match probe_tcp(host.to_string(), 8000) {
                Err(ShellError::ProbeHostNotAllowed { host: echoed, .. }) => {
                    assert_eq!(echoed, host, "错误里要回显收到的原值，便于排查配置");
                }
                other => panic!("{host:?} 不该被放行，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn probe_tcp_rejects_port_zero() {
        // u16 已经卡住上界；0 是"没填"的常见误值，必须明确拒绝而不是当作 1
        assert!(probe_tcp("127.0.0.1".to_string(), 0).is_err());
    }

    #[test]
    fn normalize_probe_host_only_normalizes_case_and_brackets() {
        assert_eq!(normalize_probe_host("  127.0.0.1  ").as_deref(), Some("127.0.0.1"));
        assert_eq!(normalize_probe_host("LocalHost").as_deref(), Some("localhost"));
        assert_eq!(normalize_probe_host("[::1]").as_deref(), Some("::1"));
        // 不做 DNS 解析：带了域名后缀就不能因为"前面像回环"而放行
        assert_eq!(normalize_probe_host("127.0.0.1.evil.com"), None);
        assert_eq!(normalize_probe_host("::ffff:127.0.0.1"), None, "映射地址不在白名单里，宁可拒");
    }

    #[test]
    fn iso8601_formats_known_epoch() {
        // 引一个时间库为它增加构建依赖不值。范围断言足以抓住"月日算错"。
        let stamp = now_iso8601();
        let bytes = stamp.as_bytes();
        assert_eq!(bytes.len(), 20, "YYYY-MM-DDTHH:MM:SSZ 应当 20 个字符：{stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
        assert!(stamp.ends_with('Z'));
        let year: i32 = stamp[0..4].parse().expect("年份可解析");
        let month: u32 = stamp[5..7].parse().expect("月份可解析");
        let day: u32 = stamp[8..10].parse().expect("日期可解析");
        assert!((1970..=9999).contains(&year));
        assert!((1..=12).contains(&month));
        assert!((1..=31).contains(&day));
    }
}
