//! 选一个 JSON 文件并读回内容（2026-11-03 / 预设导入）。
//!
//! ## 为什么放在 Rust 侧，而不是网页里的 `<input type="file">`
//!
//! 两条硬理由：
//!
//! 1. **仓库硬门**：渲染层只从 `src/contract` 取原生能力（见 memory §2 第 2 条
//!    「渲染层只从 `src/contract` 取原生能力（新增走 types → Rust → capabilities → docs/11）」）。
//!    `tauri-plugin-dialog` 已经在 Cargo / `lib.rs` 里注册过（桌面端一直在用），
//!    在 Rust 侧调用它**不需要**额外的 capability —— capability 管的是
//!    "JS 能不能直接 invoke 插件的命令"，而这里走的是我们自己的命令。
//!
//! 2. **读文件的规矩已经在 Rust 侧有一套**：UTF-8 严格解码（非法字节要报错，
//!    不许替换成 U+FFFD）、大小上限。走 `plugin-fs` 会把这两条规矩绕过去 ——
//!    那套权限模型是"路径白名单"，与本项目的取舍相反。
//!
//! ## 为什么返回三态
//!
//! 「用户取消」与「读文件失败」必须分开：取消是正常操作，弹红条会让人
//! 以为程序坏了；失败则必须说清原因。合成一个 `null` 就分不开。
//!
//! ## ★★★ Android 上选出来的**不是文件路径**，是 `content://` URI
//!
//! 2026-11-03 用户实测报错：
//!
//! > 这个文件没法按普通路径读取：URL is not a valid path
//!
//! 从 QQ 的 `Download` 目录选 `示例预设.json` 时必现。
//!
//! 真因：`tauri-plugin-dialog` 在 Android 上把 `uri.toString()` 原样交回来
//! （见插件 `DialogPlugin.kt` 的 `callResult.put("file", uri.toString())`），
//! 拿到的是 `content://com.android.providers.downloads.documents/document/xxx`。
//! 原来这里直接 `into_path()` ⇒ 失败 ⇒ 报上面那句话。
//!
//! ### 为什么不采用"申请所有文件访问权限"这个思路
//!
//! 用户建议过「第一次打开就申请所有文件的存储权限」。这条走不通，而且没必要：
//!
//! | 方案 | 代价 |
//! |---|---|
//! | `MANAGE_EXTERNAL_STORAGE`（所有文件访问） | **Android 11+ 才有**；敏感权限，要跳系统设置页手点；Google Play 只允许文件管理器等少数类别申请 |
//! | SAF（本文件的做法） | **Android 4.4 就有，全版本一致**；`content://` URI 自带一次性读授权，**零权限** |
//!
//! 用户担心的"不同手机系统的兼容性"恰恰是 SAF 最稳的地方 ——
//! 而 `MANAGE_EXTERNAL_STORAGE` 在 Android 10 及以下根本不存在。
//!
//! ### 怎么读
//!
//! `tauri-plugin-fs` 的 `Fs::open()` 在 **Android 上**会把 `content://` URI
//! 交给插件 `getFileDescriptor` 解析成 fd，再包成 `std::fs::File`；
//! **桌面端**则直接 `std::fs::OpenOptions::open(path)`。
//!
//! 同一个接口、两条平台实现 ⇒ 一处代码两端都对。
//! 这也是为什么不要自己写 JNI 调 `ContentResolver`：插件已经把这件事做对了。

use std::io::Read;

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

use crate::error::ShellError;

/// 预设文件的大小上限。
///
/// ST 的真实预设是几 KB（`Default.json` 约 2 KB）。取 1 MiB 是给
/// "带一堆自定义提示词的预设"留足余量 —— 再大的东西不可能是预设。
const MAX_PRESET_BYTES: u64 = 1024 * 1024;

/// 选文件的结果（与前端 `PickedJsonFile` 一一对应）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedJsonFile {
    ok: bool,
    /// 取消时为 true（且 `ok = false`）
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl PickedJsonFile {
    fn cancelled() -> Self {
        Self {
            ok: false,
            cancelled: Some(true),
            file_name: None,
            text: None,
            reason: None,
        }
    }

    fn failed(reason: String) -> Self {
        Self {
            ok: false,
            cancelled: None,
            file_name: None,
            text: None,
            reason: Some(reason),
        }
    }

    fn loaded(file_name: String, text: String) -> Self {
        Self {
            ok: true,
            cancelled: None,
            file_name: Some(file_name),
            text: Some(text),
            reason: None,
        }
    }
}

/// 打开系统的文件选择器，让用户挑一个 `.json` 并把内容读回来。
///
/// 返回的三态见 `PickedJsonFile`。**这个命令不判断"是不是合法预设"** ——
/// 那是 `shared` 的 `validatePresetBody` 的事，判据在那边有测试。
#[tauri::command]
pub async fn pick_json_file(app: AppHandle) -> Result<PickedJsonFile, ShellError> {
    /*
     * `blocking_pick_file` 不能在主线程上跑（插件文档明确写了）。
     *
     * Tauri 的 `#[tauri::command] async fn` 默认**不在主线程**执行，
     * 所以这里可以直接用。但为了保险起见把它放进 `spawn_blocking`：
     * 万一将来有人在同步命令里复用它，也不会卡住 UI ——
     * 卡住的表现是"点了导入，整个 App 冻住到用户选完文件"。
     */
    let app_for_pick = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app_for_pick
            .dialog()
            .file()
            .add_filter("SillyTavern 预设", &["json"])
            .add_filter("所有文件", &["*"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| ShellError::Invalid {
        message: format!("打开文件选择器失败：{error}"),
    })?;

    let Some(file_path) = picked else {
        return Ok(PickedJsonFile::cancelled());
    };

    /*
     * 文件名从 `FilePath` 取，**不要**从 `into_path()` 取。
     *
     * `content://` URI 的最后一段就是文件名（Downloads 提供者给的通常
     * 是 `document/1234`，那种情况退回显示"选中的文件"）。
     */
    let file_name = file_name_of(&file_path);

    /*
     * ★ 用 `Fs::open()` 而不是 `std::fs::read()`。
     *
     * 这是整个修复的核心：Android 上只有它能解析 `content://`
     * （见文件头那段说明）。桌面端它内部走 `std::fs`，行为不变。
     */
    let mut options = tauri_plugin_fs::OpenOptions::new();
    options.read(true);

    let mut file = app
        .fs()
        .open(file_path.clone(), options)
        .map_err(|error| ShellError::Invalid {
            message: format!(
                "打不开「{file_name}」：{error}。如果是网盘或聊天软件里的文件，先把它下载到手机本地再试。"
            ),
        })?;

    /*
     * 边读边限，**不依赖 `metadata().len()`**。
     *
     * Android 的虚拟文件（如网盘直连）常拿不到大小，`metadata()` 会返回 0
     * 或直接失败。先判大小再读的写法在那类文件上会误判成"0 字节"。
     * 用 `take()` 多读 1 字节来区分"刚好到上限"与"超了"。
     */
    let mut buffer = Vec::new();
    let read = file
        .by_ref()
        .take(MAX_PRESET_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|error| ShellError::Invalid {
            message: format!("读「{file_name}」时出错：{error}"),
        })?;

    if read as u64 > MAX_PRESET_BYTES {
        return Ok(PickedJsonFile::failed(format!(
            "「{file_name}」超过 1 MB 上限 —— 它不像是预设文件"
        )));
    }
    if buffer.is_empty() {
        return Ok(PickedJsonFile::failed(format!("「{file_name}」是空文件")));
    }

    /*
     * 严格 UTF-8。
     *
     * **不能**用 `from_utf8_lossy` —— 那会把非法字节替换成 U+FFFD，
     * 然后 `JSON.parse` 报"某行某列有非法字符"，而真正的原因（编码不对）
     * 被藏起来了。用户拿到的应该是一句"这个文件不是 UTF-8"。
     */
    let text = match String::from_utf8(buffer) {
        Ok(text) => text,
        Err(error) => {
            return Ok(PickedJsonFile::failed(format!(
                "「{file_name}」不是 UTF-8 编码的文本（第 {} 个字节开始不合法）。请用支持 UTF-8 的编辑器另存一份。",
                error.utf8_error().valid_up_to()
            )));
        }
    };

    Ok(PickedJsonFile::loaded(file_name, text))
}

/// 从 `FilePath` 里取一个**给用户看**的文件名。
///
/// ## ★★★ 这里踩过一个坑（2026-11-03 真机）
///
/// 第一版用 `url.path_segments().next_back()`。结果真机上导入成功后，
/// 预设下拉里显示的是 **`primary%3ADownl...`** —— 不是文件名。
///
/// 真因：Android 的 Downloads 提供者给的 URI 长这样：
///
/// ```text
///   content://com.android.providers.downloads.documents/document/primary%3ADownload%2FQQ%2F示例预设.json
/// ```
///
/// `primary%3ADownload%2FQQ%2F示例预设.json` 是**单个** path segment
/// （`/` 被编码成 `%2F`）。所以 `next_back()` 拿到的其实是正确的最后一段，
/// **但 `Url::path_segments()` 给的仍是百分号编码的原样**，
/// 而且更早一版我用的是 `next()`（第一个），于是拿到 `document` 前面的那段。
///
/// 现在的做法：
///   1. 取 `path_segments()` 的最后一段（`next_back`）；
///   2. **先 `percent_decode`**，把 `%3A` `%2F` 还原成 `:` `/`；
///   3. 再按 `/` 切一次取最后一段（还原后可能又出现 `/`）；
///   4. 兜底非空。
///
/// 第 3 步是关键：解码后 `primary:Download/QQ/示例预设.json` 里又有 `/` 了，
/// 不切一次就会把整串当文件名。
fn file_name_of(path: &tauri_plugin_fs::FilePath) -> String {
    use tauri_plugin_fs::FilePath;

    let fallback = "选中的文件".to_string();

    match path {
        FilePath::Path(p) => p
            .file_name()
            .map(|one| one.to_string_lossy().to_string())
            .filter(|one| !one.is_empty())
            .unwrap_or(fallback),
        FilePath::Url(url) => {
            let last_segment = url
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or("")
                .to_string();

            /*
             * 百分号解码。
             *
             * 不引第三方 crate：只需要处理 `%XX`，手写十来行比加一个依赖划算，
             * 而且这里**只需要文件名够用**，不需要完整 URI 语义。
             */
            let decoded = percent_decode(&last_segment);

            /* 解码后可能又有 `/`（`%2F` 还原出来的），再取最后一段 */
            let name = decoded.rsplit('/').next().unwrap_or("").trim().to_string();

            if name.is_empty() {
                fallback
            } else {
                name
            }
        }
    }
}

/// 把 `%XX` 还原成字节，再按 UTF-8 解释。
///
/// 非法的 `%` 序列（不足两位、不是十六进制）**原样保留** ——
/// 宁可显示一个带 `%` 的名字，也不要把用户文件名的字符吃掉。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    /// `percent_decode` 必须能还原 Android Downloads 给的那种 URI 段。
    ///
    /// 真机值（2026-11-03）：
    ///
    /// ```text
    ///   primary%3ADownload%2FQQ%2F示例预设.json
    ///     ↓ 解码
    ///   primary:Download/QQ/示例预设.json
    ///     ↓ 取最后一段
    ///   示例预设.json
    /// ```
    ///
    /// 中间**必须先解码再按 `/` 切**：不解码的话 `%2F` 不是分隔符，
    /// 整串会被当成文件名（真机就显示成 `primary%3ADownl...`）。
    #[test]
    fn decodes_android_download_uri_segment() {
        let decoded = percent_decode("primary%3ADownload%2FQQ%2F示例预设.json");
        assert_eq!(decoded, "primary:Download/QQ/示例预设.json");
        assert_eq!(decoded.rsplit('/').next(), Some("示例预设.json"));
    }

    /// 非法的 `%` 序列原样保留，不许把字符吃掉。
    #[test]
    fn keeps_invalid_percent_sequences() {
        assert_eq!(percent_decode("100%.json"), "100%.json");
        assert_eq!(percent_decode("a%zz.json"), "a%zz.json");
        /* 末尾只有一个 `%` 也不能越界 */
        assert_eq!(percent_decode("tail%"), "tail%");
    }

    /// 没有百分号的普通名字原样返回。
    #[test]
    fn plain_name_is_unchanged() {
        assert_eq!(percent_decode("示例预设.json"), "示例预设.json");
    }

    /// 中文的百分号编码要能正确还原（一个汉字 3 个 `%XX`）。
    #[test]
    fn decodes_utf8_chinese() {
        assert_eq!(percent_decode("%E7%A4%BA%E4%BE%8B"), "示例");
    }
}

#[cfg(test)]
mod name_tests {
    use super::percent_decode;

    /// 一个完整文件名（含中文、空格、括号）要能正确还原。
    #[test]
    fn decodes_full_filename_with_chinese_and_parens() {
        let raw = "%E7%A4%BA%E4%BE%8B%E9%A2%84%E8%AE%BE%20(1).json";
        assert_eq!(percent_decode(raw), "示例预设 (1).json");
    }
}
