//! ST 聊天的 **Tauri 命令桥**（v0.1.7 / T15.5）。
//!
//! ## 这一层为什么必须存在（契约里漏画了一层）
//!
//! 契约 §6.1 的分层图长这样：
//!
//! ```text
//! client/src/chat/            ← UI
//! shared/src/st-adapter/      ← 类型 + 纯逻辑
//! client/src-tauri/src/st_api.rs  ← 真正的 HTTP
//! ```
//!
//! 但 `st_api.rs` 里只有 `StApi` 这个 **Rust 结构体** —— 渲染层的 `invoke()`
//! **够不到它**。中间缺的正是本文件：把 Rust 侧能力注册成 `#[tauri::command]`。
//!
//! 2026-10-30 与用户确认后补这一层（当时 T15.4 只交了 `st_api.rs` 原语）。
//!
//! ## 边界：只做传输 + 序列化，**不做业务判断**
//!
//! 契约 §9.7 写得很明确：
//!
//! > 只做 HTTP：连接、cookie、CSRF、403 恢复、JSON 编解码。
//! > 业务语义不放进来 —— 特别是 §3.3 的「这份聊天能不能保存」（`{}` / `[]` /
//! > 数组三态 + 是否在列表里交叉验证）。
//!
//! 所以这里**原样返回 ST 的响应文本**（`String`），三态判定由渲染层用
//! `shared` 的 `parseChatResponse` 做 —— 那里有单测、能跨端复用。
//! 如果在这一层判，"哪些聊天算空"就变成 Rust 与 TS 两份实现。
//!
//! ## 流式怎么跨 IPC
//!
//! Tauri 的 `invoke` 是"一问一答"，装不下持续推送。所以：
//!   · 命令本身**立刻返回**一个 `stream_id`；
//!   · 增量通过 `emit` 发事件（`tcs://st-stream`），事件带同一个 `stream_id`；
//!   · 取消走 `st_generate_abort(stream_id)` —— 因为 ST **没有 `/stop` 端点**
//!     （契约 §3.3.2 / Spike② 已钉），"停止"只能是断连。
//!
//! 为什么不用 Channel：Channel 需要前端创建并传进来，而"创建一个流"这件事
//! 本身要先有个 ID 才能和后续事件对上；先返回 ID 的模型更简单，也让
//! "abort 一个还没开始的流"这种情况有明确答案（查不到就返回 false）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::ShellError;
use crate::st_api::StApi;

/// 流式事件名。前端 `listen('tcs://st-stream', ...)`。
pub const STREAM_EVENT: &str = "tcs://st-stream";

/// 推给前端的一条流式事件。
///
/// ## ★ 只有 `Frame` 带内容 —— 而且它是**原始 payload**，不是解析后的文本
///
/// 契约 §4.2 列的四种后端形状（OpenAI 系 / Claude / Gemini …）差异，
/// 已经在 TS 侧 `shared/src/st-adapter/sse.ts` 的 `translateFrame` 里统一，
/// 并有契约测试（`test/st-adapter-*`）守着。
///
/// 如果这里也解析一份，就是**两份实现**：改一处忘另一处，表现为
/// "某个后端在 Rust 侧认得出、在测试里认不出"。所以这一层只把
/// SSE 的 payload 字符串原样转上去，语义留给唯一那份 TS 实现。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    /// 一个 SSE 事件的原始 payload（`data:` 之后的那段文本）
    Frame {
        /*
         * ★ 必须显式 rename（2026-11-01 修）。
         *
         * `rename_all = "camelCase"` 作用在**变体名**上（Frame → "frame"），
         * **不作用于字段名** —— 所以原来序列化出来是
         * `{"type":"frame","stream_id":1,"raw":"..."}`，
         * 而前端按 `payload.streamId` 读。
         *
         * 后果：`payload.streamId !== target[0]` 永远成立 →
         * **每一帧都被静默丢弃**，包括 `done`。
         * 现象是真机上"消息发出去了、ST 也回了、气泡一直是空的"，
         * 而且因为 done 也被丢，`done` promise 永不 resolve，
         * 面板永远停在 streaming 状态。
         *
         * 为什么单测抓不到：`test/stream.test.mjs` 直接喂 TS 形状的事件，
         * 从不经过 Rust 的序列化 —— 这是**跨语言契约**，两边各自"对"。
         */
        #[serde(rename = "streamId")]
        stream_id: u64,
        raw: String,
    },
    /// 正常结束
    Done {
        #[serde(rename = "streamId")]
        stream_id: u64,
    },
    /// 出错。这里带的是给开发者看的原始信息，界面文案由前端翻译
    Error {
        #[serde(rename = "streamId")]
        stream_id: u64,
        message: String,
    },
}

/// 一个正在跑的生成任务。
struct StreamHandle {
    /// `true` = 已被要求停止。生成循环每收到一段就查一次。
    ///
    /// 为什么用 `AtomicBool` 而不是 `JoinHandle::abort()`：
    /// abort 会在**任意指令边界**掐掉任务，包括正在写文件/写日志的中间态。
    /// 而这里只需要"下一段不要再推了"，协作式退出更安全，
    /// 也能保证最后一定发出一个 `done` 事件（否则前端会永远停在 streaming）。
    cancelled: Arc<AtomicU64>,
}

/// 命令桥的共享状态。
#[derive(Default)]
pub struct StChatState {
    /// 当前连接的 `StApi`。**必须复用同一个实例** —— 它持有 cookie jar，
    /// 每次新建都等于换会话（见 `st_api.rs` 的注释）。
    api: Mutex<Option<Arc<StApi>>>,
    streams: Mutex<HashMap<u64, StreamHandle>>,
    next_stream_id: AtomicU64,
}

impl StChatState {
    fn api(&self) -> Result<Arc<StApi>, ShellError> {
        let guard = self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.clone().ok_or(ShellError::StUnavailable {
            detail: "还没连上 SillyTavern。先点一次「连接」".to_string(),
        })
    }

    fn set_api(&self, api: Arc<StApi>) {
        let mut guard = self.api.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(api);
    }

    fn next_id(&self) -> u64 {
        self.next_stream_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn insert_stream(&self, id: u64, cancelled: Arc<AtomicU64>) {
        let mut guard = self.streams.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(id, StreamHandle { cancelled });
    }

    fn take_stream(&self, id: u64) -> Option<StreamHandle> {
        let mut guard = self.streams.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.remove(&id)
    }
}

// ── 连接 ────────────────────────────────────────────────────

/// 连接 ST：建会话 + 取 CSRF，并把这个实例留住给后续命令复用。
#[tauri::command]
pub async fn st_chat_connect(
    base_url: String,
    state: State<'_, StChatState>,
) -> Result<(), ShellError> {
    let api = Arc::new(StApi::new(base_url)?);
    api.connect().await?;
    state.set_api(api);
    Ok(())
}

/// 探活 + 版本。
///
/// 版本从 `/version` 读（契约 §1 用它校验被测版本）。读不到就给空串 ——
/// 探活本身成功才是主要的，版本只是附加信息。
#[tauri::command]
pub async fn st_chat_health(state: State<'_, StChatState>) -> Result<(bool, String), ShellError> {
    let api = match state.api.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    let Some(api) = api else {
        return Ok((false, String::new()));
    };
    if !api.probe().await {
        return Ok((false, String::new()));
    }
    let version = match api.post_json::<serde_json::Value>("/version", serde_json::json!({})).await {
        Ok(value) => value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        Err(_) => String::new(),
    };
    Ok((true, version))
}

// ── 角色与聊天 ──────────────────────────────────────────────
//
// 全部返回**原始 JSON 文本**（`String`）而不是强类型 Rust 结构：
// 契约 §5.3 要求"读进来再写回去逐字段不变"，而强类型 deserialize 会
// **丢掉没声明的字段**（除非用 `#[serde(flatten)]` 到处兜）。
// 把形状判断交给 `shared`（那里有 `parseChatResponse` 与 26 条契约测试），
// 这一层只负责"把字节搬过来"。

#[tauri::command]
pub async fn st_chat_characters(state: State<'_, StChatState>) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text("/api/characters/all", serde_json::json!({})).await
}

/// 删除角色（2026-11-04，第二十九批）。
///
/// ## `delete_chats` 是这次的关键
///
/// 用户要求：
///
/// > 选择角色时长按删除设备（是彻底删除并且 ST 内无该角色及其相关数据和聊天记录）
///
/// ST 的 `POST /api/characters/delete` **原生支持** `delete_chats: true`：
///
/// ```js
/// if (request.body.delete_chats == true) {
///     await fs.promises.rm(path.join(chats, sanitize(dir_name)),
///                          { recursive: true, force: true });
/// }
/// ```
///
/// 也就是**连整个聊天目录一起删**（不是只删卡片）。
///
/// ## 为什么不做成"先删卡片、再逐个删聊天"
///
/// 那样有两个问题：
/// 1. 两次请求之间失败 ⇒ 卡片没了、聊天还在（脏数据，而且用户再没有入口去删）
/// 2. 要自己遍历 `/api/characters/chats` 再逐条 `/api/chats/delete`，
///    循环里任何一条失败都得决定"继续还是中止"
///
/// ST 自己的删除就是一次调用做完，跟着它做最稳。
#[tauri::command]
pub async fn st_chat_character_delete(
    avatar: String,
    delete_chats: bool,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/characters/delete",
        serde_json::json!({
            "avatar_url": avatar,
            "delete_chats": delete_chats,
        }),
    )
    .await
}

/// 世界书列表（2026-11-04，第三十批）。
///
/// 用户要求实现「人设世界书」—— 让人设能指定一个世界书，只在那套人设
/// 生效时参与匹配。要选就得先能列出有什么，所以加这一条。
///
/// ST 的 `POST /api/worldinfo/list` 扫描 `worlds/` 目录下的 json，
/// 返回 `[{ uid, file_id, name, ... }]`。
#[tauri::command]
pub async fn st_chat_worldinfo_list(state: State<'_, StChatState>) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text("/api/worldinfo/list", serde_json::json!({})).await
}

/// 读一本世界书的**全部内容**（2026-11-04，世界书管理）。
///
/// `name` 是列表里那个 `file_id`（不带 `.json`）。
///
/// 返回 ST 的原始结构：
///
/// ```json
/// { "entries": { "0": { "uid":0, "key":["..."], "content":"...", "comment":"..." }, ... } }
/// ```
///
/// ## 为什么走 Rust 而不是 `StBridge.httpRequest`
///
/// ST 的 `/api/*` 要 CSRF token（漏了就是 403 + 一整页 HTML），
/// 而 `st_api.rs` 已经实现了「取一次 token → 缓存 → 失效自动重取」。
/// 桥那边没有这套，硬发只会 403。
#[tauri::command]
pub async fn st_chat_worldinfo_get(
    name: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/worldinfo/get",
        serde_json::json!({ "name": name }),
    )
    .await
}

/// 写回一本世界书（整份覆盖）。
///
/// ST 的 `POST /api/worldinfo/edit` 形如 `{ "name": "...", "data": { entries: {...} } }`。
/// **必须整份传**：只传改动的那几条会把其余条目删掉（与预设写回同一个坑，§93）。
#[tauri::command]
pub async fn st_chat_worldinfo_edit(
    name: String,
    data: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    let parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|error| ShellError::Invalid {
            message: format!("世界书内容不是合法 JSON：{error}"),
        })?;
    api.post_text(
        "/api/worldinfo/edit",
        serde_json::json!({ "name": name, "data": parsed }),
    )
    .await
}

/// 导入一本世界书（内容是**整份 JSON 文本**）。
///
/// ST 的 `POST /api/worldinfo/import` 接受 `{ "name": ..., "data": <entries 对象> }`，
/// 落盘成 `worlds/<name>.json`。同名会覆盖 —— 所以前端必须先查重。
#[tauri::command]
pub async fn st_chat_worldinfo_import(
    name: String,
    data: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    let parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|error| ShellError::Invalid {
            message: format!("世界书内容不是合法 JSON：{error}"),
        })?;
    api.post_text(
        "/api/worldinfo/import",
        serde_json::json!({ "name": name, "data": parsed }),
    )
    .await
}

/// 删除一本世界书。`name` 是 `file_id`。
#[tauri::command]
pub async fn st_chat_worldinfo_delete(
    name: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/worldinfo/delete",
        serde_json::json!({ "name": name }),
    )
    .await
}

/// 读一个角色的**原始 PNG 字节**（2026-11-04，T15.2）。
///
/// ## 为什么不是"读 JSON"
///
/// 真机查证（`characters/` 目录）：
///
/// ```text
///   测试用-夜航小助手.png      788 KB     ← 只有 PNG，没有同名 .json
///   Seraphina/                          ← 目录里才是 .json
/// ```
///
/// 而 ST 的 `readCharacterData()` 是 `parse(inputFile, 'png')` ——
/// **数据从 PNG 的 `chara`/`ccv3` tEXt 块里读，.json 只是某些路径的副产物**。
///
/// 所以：
/// - **读**：拿 PNG 字节，前端用 `parsePngCard` 解出 JSON
/// - **写**：前端用 `buildPngCard` 生成新 PNG，再整字节写回
///
/// 走 .json 会读到过期的副本，或者根本读不到（像上面那张卡）。
#[tauri::command]
pub async fn st_chat_character_png(
    avatar: String,
    state: State<'_, StChatState>,
) -> Result<Vec<u8>, ShellError> {
    let api = state.api()?;
    /*
     * 用 ST 自己的导出接口而不是直接读文件：
     * 它会返回**去掉私有字段**的干净卡（`unsetPrivateFields`），
     * 而那正是"用户想看到/编辑的卡"。
     */
    api.post_bytes(
        "/api/characters/export",
        serde_json::json!({ "avatar_url": avatar, "format": "png" }),
    )
    .await
}

/// 把 PNG 字节**原子写回**角色文件（2026-11-04，T15.2 阶段 B）。
///
/// ## 为什么不走 `/api/characters/edit`
///
/// 两道关卡都过不去：
///
/// 1. `/edit` 的 `if (request.body.ch_name === '')` 直接 400 ——
///    而阶段 B 验收明确要求"清空角色名后**保存照常**"（校验归审计）。
/// 2. `charaFormatData` 会把没传的字段写成 `''` / 默认值
///    （`_.set(char, 'data.xxx', data.xxx || '')`），少一个字段就丢一份用户数据。
///
/// `/edit-attribute` 也不行 —— 它显式拒绝 `field === 'json_data'`。
///
/// ## 所以直接写文件
///
/// 前端负责：
/// 1. 读原 PNG（`st_chat_character_png`）
/// 2. `buildPngCard` 把新 JSON 嵌进去（其余块逐字节原样保留）
/// 3. 把新字节交给这里，这里只做"原子落盘"一件事
///
/// `ST_DATA_DIR` 由 Android 侧在启动引擎时确定，走环境变量传进来；
/// 拿不到就报错而不是猜路径 —— 猜错会写到别处去。
#[tauri::command]
pub async fn st_chat_character_write_png(
    avatar: String,
    characters_dir: String,
    bytes: Vec<u8>,
    /*
     * 是否允许**新建**一张卡（2026-11-04，从仓库导入时用）。
     *
     * ## 为什么要有这个开关，而不是直接放开"文件必须存在"
     *
     * 这个命令有两个截然不同的用途：
     *
     * ```text
     *   改现有卡（编辑器写回）  → 文件必须已存在，否则一定是路径算错了
     *   导入一张新卡（仓库下载）→ 文件本来就该不存在
     * ```
     *
     * 默认 `None` 按 `false` 处理 —— **保持"只改现有"这个安全语义**。
     * 不传就没有创建能力，调用点看不出来就写不出新文件。
     *
     * ## 为什么 `allow_create` 时要求"文件必须不存在"
     *
     * 那样"新建"和"覆盖"是两个互斥的意图，谁都不会静默发生：
     *
     * ```text
     *   allow_create=false + 不存在  → 报错（路径算错了）
     *   allow_create=false + 存在    → 覆盖（用户就是要改这张）
     *   allow_create=true  + 不存在  → 新建（正常导入）
     *   allow_create=true  + 存在    → 报错（重名，不许悄悄顶掉别人的卡）
     * ```
     *
     * 最后一行是关键：调用方（`planCardImport`）已经做了去重，
     * 所以这里的"已存在"只可能是并发或 bug —— 报出来比覆盖安全。
     */
    allow_create: Option<bool>,
) -> Result<String, ShellError> {
    /*
     * `characters_dir` 由前端从 Android 注入的 `__ST_ENGINE__.status()` 里取，
     * 走参数而不是环境变量：
     *
     * · 环境变量要在进程启动前设好，而 Tauri 的 Rust 侧跟 Kotlin 侧
     *   不在同一套环境里 —— 设了也传不过来
     * · 参数是显式的：调用点看得见"写哪个目录"，出问题一眼能查
     *
     * 空串直接拒绝，不猜路径 —— 猜错会写到别的地方去。
     */
    let dir = characters_dir.trim();
    if dir.is_empty() {
        return Err(ShellError::Invalid {
            message: "拿不到角色目录，无法写回".to_string(),
        });
    }
    if !std::path::Path::new(dir).is_absolute() {
        return Err(ShellError::PathNotAbsolute { path: dir.to_string() });
    }

    /*
     * 防目录穿越：avatar 必须是**纯文件名**。
     *
     * 这个值来自前端（最终来自 ST 的列表接口），但写文件前必须自己再判一次 ——
     * 前端被注入一个 `../../x.png` 就能覆盖任意文件。
     */
    let name = avatar.trim();
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err(ShellError::StUnavailable { detail: format!("文件名不合法：{name}") });
    }
    if !name.to_ascii_lowercase().ends_with(".png") {
        return Err(ShellError::StUnavailable { detail: format!("只能写 .png：{name}") });
    }

    let target = std::path::Path::new(dir).join(name);
    let creating = allow_create.unwrap_or(false);
    if creating {
        if target.exists() {
            return Err(ShellError::StUnavailable {
                detail: format!("已经有一张同名卡片了：{name}"),
            });
        }
    } else if !target.exists() {
        return Err(ShellError::StUnavailable { detail: format!("角色文件不存在：{name}") });
    }

    /*
     * 原子写：先写临时文件再 rename。
     *
     * 直接 `fs::write` 中途失败会留下半截 PNG —— 而它**长得像一张正常的卡**
     * （有签名、缺 IEND），用户导入时才发现坏。ST 也会读到一个解析失败的角色。
     */
    let temp = target.with_extension("png.tmp");
    std::fs::write(&temp, &bytes)
        .map_err(|error| ShellError::Io { path: temp.display().to_string(), message: error.to_string() })?;
    std::fs::rename(&temp, &target)
        .map_err(|error| ShellError::Io { path: target.display().to_string(), message: error.to_string() })?;

    Ok(format!("已写入 {} 字节", bytes.len()))
}

#[tauri::command]
pub async fn st_chat_list(
    avatar: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text("/api/characters/chats", serde_json::json!({ "avatar_url": avatar }))
        .await
}

/// 读聊天。
///
/// `file_name` 是**带 `.jsonl`** 的那个 —— 契约陷阱 #3：get/save 用不带扩展名的
/// `file_name`，rename/delete 用带扩展名的 `file_id`。这个差别不在这里纠正，
/// 由调用方按端点传对；这里只把 ST 的规则照抄，不发明"自动补扩展名"。
#[tauri::command]
pub async fn st_chat_load(
    avatar: String,
    file_name: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/chats/get",
        serde_json::json!({
            "avatar_url": avatar,
            "file_name": file_name,
            "ch_name": "",
            "tail_message": serde_json::Value::Null,
        }),
    )
    .await
}

/// 保存聊天。**整份覆盖**（陷阱 #1）—— 调用方必须先把完整历史读出来再改。
#[tauri::command]
pub async fn st_chat_save(
    avatar: String,
    file_name: String,
    chat: Vec<serde_json::Value>,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    /*
     * ★ 这一行是**诊断用**，故意留在代码里（2026-11-01 第八批问题二）。
     *
     * 排查"聊天不保存"时，最需要知道的第一件事就是"这个命令到底有没有被调用"。
     * 而它之前**一行日志都没有** —— 于是前端"回调没触发"和"回调触发了但
     * 命令没到"在 logcat 里长得一模一样，只能靠猜。
     *
     * 留下的成本：每次保存打一行（一条聊天几行，可忽略）。
     * 换来的：以后任何"消息没存上"都能一句话定位到哪一层。
     */
    log::info!(
        target: "st_chat",
        "[st_chat_save] avatar={} file={} messages={}",
        avatar,
        file_name,
        chat.len()
    );

    let api = state.api()?;
    api.post_text(
        "/api/chats/save",
        serde_json::json!({
            "avatar_url": avatar,
            "file_name": file_name,
            "chat": chat,
        }),
    )
    .await
}

#[tauri::command]
pub async fn st_chat_rename(
    avatar: String,
    file_id: String,
    new_name: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/chats/rename",
        serde_json::json!({
            "avatar_url": avatar,
            "original_file": file_id,
            "renamed_file": new_name,
        }),
    )
    .await
}

#[tauri::command]
pub async fn st_chat_delete(
    avatar: String,
    file_id: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/chats/delete",
        serde_json::json!({ "avatar_url": avatar, "chatfile": file_id }),
    )
    .await
}

// ── 设置与密钥 ──────────────────────────────────────────────

#[tauri::command]
pub async fn st_chat_settings_get(state: State<'_, StChatState>) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text("/api/settings/get", serde_json::json!({})).await
}

/// 保存设置。**整份覆盖**（陷阱 #6）—— 调用方必须先 GET 再改再 POST，
/// 由 `shared` 的 `mutateSettings` 保证；这里不做 patch。
#[tauri::command]
pub async fn st_chat_settings_save(
    settings: serde_json::Value,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    /*
     * ★★★ body **就是 settings 对象本身**，不许包 `{ "settings": ... }`。
     *
     * 契约原文（`docs/adapter-contract-st-v1.19.md:270`）：
     *
     * > 写设置 | `POST /api/settings/save`，**body 就是 settings 对象本身**
     *
     * ## 包一层的后果（2026-11-03 实测，已造成真实数据损坏）
     *
     * ST 把这个 wrapper 当成 settings **整个写盘**，于是文件变成
     * `{ "settings": { ...原设置... } }`。而 ST 读的是**最外层** ——
     * `power_user`、`oai_settings` 等全被埋进下一层，对 ST 立刻不可见。
     *
     * 更糟的是它**每次保存都多套一层**：`parseSettingsEnvelope` 读回的是
     * 已被包过的对象，我们再包一次写回去 —— 真机上连存 7 次变成 7 层，
     * `power_user` 在第 7 层（实测 `ROOT.settings.settings…settings.power_user`）。
     *
     * 表面症状极轻：保存返回 `{result:"ok"}`、设置页读写都正常，
     * 只有**用户在 ST 里配的东西（人设、作者注释、UI 偏好）全部失效** ——
     * 而那时候没人会想到是"App 存设置"干的。
     */
    api.post_text("/api/settings/save", settings).await
}

/// 保存 / 导入一份**对话补全预设**（2026-11-03 / 任务 #259）。
///
/// ## 接口形态
///
/// ST 侧是 `POST /api/presets/save`，body：
///
/// ```json
/// { "apiId": "openai", "name": "我的预设", "preset": { ... } }
/// ```
///
/// 出自 `src/endpoints/presets.js`：`getPresetSettingsByAPI('openai')` 把
/// 这个名字映射到 `<user>/OpenAI Settings/<name>.json`，`name` 过
/// `sanitize-filename`。
///
/// ## 为什么 `preset_json` 是字符串而不是 `Value`
///
/// 让"解析"这件事只发生在**一个地方**：调用方（`shell.ts`）先 `JSON.parse`
/// 校验内容、再 `JSON.stringify` 交过来。这里若收 `Value`，就会多出一条
/// "Rust 也解析一遍"的路径 —— 两处解析对非法 JSON 的报错文案会不一致，
/// 而用户看到的应该是同一句人话。
///
/// 传 `{}` 也能成功（ST 不校验内容），所以**内容校验必须在前端做完**
/// （`validatePresetBody`）。
#[tauri::command]
pub async fn st_chat_preset_save(
    name: String,
    preset_json: String,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ShellError::Invalid {
            message: "预设名不能为空".to_string(),
        });
    }

    let preset: serde_json::Value = serde_json::from_str(&preset_json).map_err(|error| {
        ShellError::Invalid {
            message: format!("预设内容不是合法 JSON：{error}"),
        }
    })?;

    let body = serde_json::json!({
        "apiId": "openai",
        "name": trimmed,
        "preset": preset,
    });

    let text = api.post_text("/api/presets/save", body).await?;

    /*
     * ST 回的是 `{ "name": "<sanitize 过的名字>" }`。
     *
     * ★ 只把**名字**交回去，不把整个 JSON 丢给前端。
     *
     * 第一版直接返回原始文本，而前端拿它当名字用（`savedName = saved`）——
     * 于是"导入成功后切过去"会去切一个叫 `{"name":"我的预设"}` 的预设，
     * 必然失败。而失败提示会是"找不到名为 … 的预设"，看起来像 ST 的问题。
     *
     * ST 会对文件名做 `sanitize-filename`（中文保留，`/` `?` 等被替换），
     * 所以它回的名字可能与传入的不同 —— 必须用**它回的**那个。
     */
    let name = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("name").and_then(|one| one.as_str()).map(str::to_string))
        .unwrap_or(trimmed.to_string());

    Ok(name)
}

/// 写密钥。**写进去就读不回来**（契约 §3.5 的掩码）—— 所以界面上不许回显。
#[tauri::command]
pub async fn st_chat_secret_write(
    key: String,
    value: String,
    label: Option<String>,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/secrets/write",
        serde_json::json!({
            "key": key,
            "value": value,
            "label": label.unwrap_or_default(),
        }),
    )
    .await
}

/// 问 ST「哪些 secret **真的配了**」，返回 key 名列表（2026-11-07）。
///
/// ## 为什么需要它
///
/// 早先「这个源配没配 key」由 App 自己的 localStorage 标记决定。那标记
/// 有三种丢法：
///
/// ```text
///   ① 换版本 / 清缓存 / 重装
///   ② 用户直接在 ST 的原始界面配过（我们不知道）
///   ③ 保存 key 时 `stOk` 为假但 key 其实写进去了
/// ```
///
/// 用户真机报的就是这个：**配了 key，界面说"未配 key"**。
/// 而 ST 的 `secrets.json` 才是真相 —— `/api/secrets/read` 就是读它的入口。
///
/// ## 为什么只返回「key 名」，不返回 ST 的原始响应
///
/// `/api/secrets/read` 的每一项是 `{ id, value, label, active }`，
/// 其中 `value` 是**掩码后的**（`sk-…abcd`）。虽然已经脱敏，
/// 但把掩码片段传到 JS 层没有任何用途 —— 界面需要的只是"有没有"。
///
/// 所以这里在 Rust 侧就把结构压成 `Vec<String>`，前端拿不到任何 key 内容。
/// 少一个泄漏面，也省得前端解析一堆用不上的字段。
///
/// ## 判空的口径
///
/// ST 对没有的 key 返回 `null`，有的返回非空数组。
///
/// ★★★ **解析失败必须返回 `Err`，不能返回空列表。**
///
/// 早先这里写的是 `return Ok(Vec::new())`，理由是"保守"。但那是个错误：
/// 「空列表」在调用方看来等于**"一个都没配"** ⇒ 界面会把 6 个源全标成
/// 「未配 key」，而用户可能每个都配好了 —— 一个解析问题变成一片红标记，
/// 比不显示更糟，而且用户会以为自己的 key 被删了。
///
/// 返回 `Err` 之后，调用方 catch 住、**保持现有显示不变**。
/// "不知道"就该表现为"不知道"，不是"全都没有"。
#[tauri::command]
pub async fn st_chat_secret_present(state: State<'_, StChatState>) -> Result<Vec<String>, ShellError> {
    let api = state.api()?;
    let text = api.post_text("/api/secrets/read", serde_json::json!({})).await?;

    let root: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        ShellError::StBadResponse {
            detail: format!("secrets/read 返回的不是 JSON（{e}），可能是 ST 版本变了"),
        }
    })?;

    /*
     * ★★★ 判据必须是「ST 真的读得出来」，不是「这个键存在」（2026-11-09 修）。
     *
     * ## 用户报的
     *
     * > 我明明填了秘钥……报 Key 错误：Key 填错、过期或未设置 Bearer
     *
     * 而 App 界面上显示的是「已经配过了」。
     *
     * ## 真因：两处判断不同源
     *
     * ST 从 1.13 起把 secrets 存成**数组**，每条带 `active` 标记，
     * 而 `readSecret()` 只认 `active: true` 的那一条：
     *
     * ```js
     *   const activeSecret = secretArray.find(s => id ? s.id === id : s.active);
     *   return activeSecret?.value || '';        // ← 全都不 active 就返回空串
     * ```
     *
     * 而这里原来只判 `!value.is_null()` —— 数组非空就算"有 key"。
     * 于是 **数组里一条 active 都没有** 时：
     *
     * ```text
     *   App 说：已配置 ✓
     *   ST  读到：''（空字符串）
     *   请求带：Authorization: Bearer （空）
     *   上游说：未设置 Bearer
     * ```
     *
     * 这就是那条错误信息的完整来路。而且 ST 对 `custom` 源**不拦空 key**
     * （它的空 key 检查写的是 `source !== CUSTOM`），所以请求照样发出去，
     * 错误来自上游而不是 ST —— 更难归因。
     *
     * ## 修复后的判据
     *
     * 与 ST 的 `readSecret()` 完全一致：**数组里必须有一条 `active: true`**。
     * 顺带也处理旧格式（值是字符串）—— ST 那边同样读不出来，我们也算没有。
     */
    let mut present = Vec::new();
    if let Some(map) = root.as_object() {
        for (key, value) in map {
            let Some(items) = value.as_array() else {
                /* 旧格式（字符串）或 null：ST 的 readSecret 走不到它，算没有 */
                continue;
            };
            let usable = items
                .iter()
                .any(|item| item.get("active").and_then(|v| v.as_bool()).unwrap_or(false));
            if usable {
                present.push(key.clone());
            }
        }
    }
    Ok(present)
}

// ── 生成（流式）─────────────────────────────────────────────

/// 发起一次流式生成，**立刻返回 `stream_id`**；增量通过事件推给前端。
///
/// ## 为什么这里用裸 POST 而不是 `post_text`
///
/// `post_text` 会 `await` 到响应体读完 —— 那对整份 JSON 是对的，
/// 对 SSE 等于"等生成完才返回"，打字机效果就没了。
/// 所以这里自己拿 `reqwest` 的 byte stream，逐块解析后再 emit。
///
/// ## 陷阱 #10 在这里落地
///
/// **不看响应头**。ST 的流式响应没有 `Content-Type: text/event-stream`，
/// 所以"是不是流式"只由我们发出去的 `stream: true` 决定。
/// 见 `st_api.rs`：分帧逻辑不看 header，只看 body 里的 `data:` 行。
/// 建一个群聊（`POST /api/groups/create`）。
///
/// ## 为什么这个命令是 `st_chat_group_create` 而不是"转群聊"
///
/// "转换"是**产品层**的说法（把当前角色变成一个群），而 ST 的模型里
/// 群聊是独立实体、用独立的接口建。把"转换"硬塞进命令名会让 Rust 侧
/// 需要知道"当前角色"是什么 —— 那是前端的状态。
/// 所以命令只做一件事：按参数建群，返回 ST 给的群对象。
///
/// ## 为什么带一串默认字段
///
/// 真机实测（`.verify/probe-st-routes.sh`）：只发 `{}` 也能建成功，
/// 但建出来是 `{"name":"New Group","members":[],...}` 这种半成品 ——
/// 后续在 ST 里打开会因为缺字段而行为怪异。所以把已知字段都显式给上。
///
/// `avatar_url` 用 `null`：群聊没有卡片图，传空串 ST 会当成文件名去找。
#[tauri::command]
pub async fn st_chat_group_create(
    name: String,
    members: Vec<String>,
    state: State<'_, StChatState>,
) -> Result<String, ShellError> {
    let api = state.api()?;
    api.post_text(
        "/api/groups/create",
        serde_json::json!({
            "name": name,
            "members": members,
            "avatar_url": serde_json::Value::Null,
            "allow_self_responses": false,
            "activation_strategy": 0,
            "generation_mode": 0,
            "disabled_members": [],
            "fav": false,
            "chat_id": serde_json::Value::Null,
            "chats": [],
            "auto_mode_delay": 1,
            "generation_mode_join_prefix": "",
        }),
    )
    .await
}

#[tauri::command]
pub async fn st_chat_generate(
    request: serde_json::Value,
    app: AppHandle,
    state: State<'_, StChatState>,
) -> Result<u64, ShellError> {
    let api = state.api()?;

    /*
     * 诊断日志：把"前端到底交给了我们什么"打到 logcat。
     *
     * ## 为什么需要这一行
     *
     * 2026-11-01 排查"自定义接口发消息只留一个空气泡"时，链路是：
     *
     *   前端 buildGenerateRequest → Rust（这里）→ ST → 上游
     *
     * PC 侧直接打 ST（带 `custom_url`）能正常回复"好的呀"，
     * 而 App 内发出去 15 毫秒就结束 —— 差别只可能在**这一段**。
     *
     * 但前端侧抓不到：Tauri 2 把 `__TAURI_INTERNALS__.invoke` 定成
     * `writable:false, configurable:false`（实测描述符），
     * 页面里 hook 不住，所以"前端发出的请求体"无法从 JS 侧观察。
     *
     * 于是把观察点放在这一侧：这是请求离开 App 之前的最后一站。
     *
     * ## 不打敏感内容
     *
     * 只打"有没有 / 长度"，**不打 key、不打消息正文**
     * （key 在 secrets 里不经过这里，但消息正文会经过）。
     */
    {
        let source = request.get("chat_completion_source").and_then(|v| v.as_str()).unwrap_or("<缺失>");
        let model = request.get("model").and_then(|v| v.as_str()).unwrap_or("<缺失>");
        let custom_url = request.get("custom_url").and_then(|v| v.as_str()).unwrap_or("<缺失>");
        let msg_count = request
            .get("messages")
            .and_then(|v| v.as_array())
            .map_or(0, std::vec::Vec::len);
        /*
         * 额外打 `max_tokens`（2026-11-02）。
         *
         * 起因：`deepseek-v4-pro` 这类推理模型 302 帧全是思维链、正文 0 字，
         * 而 API 后台显示 `510 / 300` —— 预算被思考吃完了。
         *
         * 修的时候最怕的就是「界面改了、请求里没改」：那种情况下
         * 用户和开发者都会以为修了，实际上一个字都没变。
         * 把最终发出去的 `max_tokens` 打出来，就能一眼确认。
         *
         * 不打 key、不打消息正文（与上面同一条纪律）。
         */
        let max_tokens = request
            .get("max_tokens")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "<缺失>".to_string());
        log::info!(
            target: "st_generate",
            "generate: source={source} model_len={} custom_url={custom_url} messages={msg_count} max_tokens={max_tokens}",
            model.chars().count()
        );
    }

    let stream_id = state.next_id();
    let cancelled = Arc::new(AtomicU64::new(0));
    state.insert_stream(stream_id, cancelled.clone());

    // 后台跑，命令立刻返回 id —— 前端据此开始 listen
    tauri::async_runtime::spawn(async move {
        let app_for_emit = app.clone();
        let flag = cancelled.clone();

        /*
         * 帧计数（诊断用，2026-11-01）。
         *
         * 只打前 3 帧与总数 —— 打每一帧会把 logcat 刷满（一条回复几十帧），
         * 而排查时只需要知道"有没有帧、帧长什么样"。
         */
        let frames = Arc::new(AtomicU64::new(0));
        let frames_for_probe = frames.clone();

        let result = api
            .post_stream(
                "/api/backends/chat-completions/generate",
                &request,
                |payload| {
                    let n = frames_for_probe.fetch_add(1, Ordering::SeqCst);
                    if n < 3 {
                        log::info!(
                            target: "st_generate",
                            "frame#{n} len={} head={}",
                            payload.len(),
                            payload.chars().take(60).collect::<String>()
                        );
                    }
                    // 每个 payload 直接转给前端；返回 false = 用户点了停止
                    let emitted = app_for_emit.emit(
                        STREAM_EVENT,
                        StreamEvent::Frame {
                            stream_id,
                            raw: payload.to_string(),
                        },
                    );
                    if let Err(error) = emitted {
                        log::warn!(target: "st_generate", "emit frame 失败: {error}");
                    }
                    flag.load(Ordering::SeqCst) == 0
                },
            )
            .await;

        log::info!(
            target: "st_generate",
            "post_stream 结束：frames={} err={}",
            frames.load(Ordering::SeqCst),
            result.is_err()
        );

        match result {
            Ok(_stopped) => {
                /*
                 * 无论是自然结束还是被停止，**都要发 done**。
                 *
                 * 这是前端的"别再转了"信号：不发的话 UI 会永远停在
                 * streaming 状态，那个呼吸圆点一直在转，而用户看不出
                 * "其实已经停了"。
                 */
                log::info!(target: "st_generate", "emit done stream_id={stream_id}");
                let _ = app.emit(STREAM_EVENT, StreamEvent::Done { stream_id });
            }
            Err(error) => {
                let _ = app.emit(
                    STREAM_EVENT,
                    StreamEvent::Error {
                        stream_id,
                        message: error.to_string(),
                    },
                );
            }
        }

        // 无论成败都要清掉句柄，否则 map 会长大
        if let Some(state) = app.try_state::<StChatState>() {
            state.take_stream(stream_id);
        }
    });

    Ok(stream_id)
}

/// 停止生成（= 断连）。
///
/// 返回 `true` = 找到了这个流并已标记取消；`false` = 它已经结束/不存在。
///
/// 前端拿到 `false` **不该报错** —— 它通常意味着"用户点停止时，回复刚好写完了"，
/// 那是正常竞态，不是故障。
#[tauri::command]
pub fn st_chat_abort(stream_id: u64, state: State<'_, StChatState>) -> bool {
    let guard = state
        .streams
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match guard.get(&stream_id) {
        Some(handle) => {
            // 置 1 表示"请停止"。生成循环每收到一段就查一次。
            handle.cancelled.store(1, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// 数一段文本有多少 token（走 ST 自己的分词器）。
///
/// ## 为什么要有这个命令
///
/// 上下文预算是硬上限：`openai_max_context - openai_max_tokens`。
/// 超了上游会 400（或静默截断，回复变糊）。要裁历史就必须先会数 token。
///
/// ST 前端用的是 `POST /api/tokenizers/openai/count?model=<模型>`，
/// body 是**消息数组** `[{ role, content }]`，回 `{ "token_count": N }`。
/// 服务端按模型名挑分词器（claude / llama3 / qwen2 / deepseek / gpt2 …），
/// 所以 `model` 必须带上 —— 不传会退到默认分词器，数字会偏。
///
/// ## 返回什么
///
/// 只回一个数字（`i64`）。不把原始 JSON 丢给前端 —— 那样前端要再解析一次，
/// 而两处解析对异常响应的处理必然不一致。
///
/// ## 失败时
///
/// 返回 `Err`，由前端**回退到估算**（`estimateTokens`，字节数 ÷ 3.35）。
/// 这里刻意**不**在 Rust 侧兜底成估算值：那会让"ST 连不上"和
/// "ST 说就是 100 token" 变成同一个返回值，而前者用户应该知道。
#[tauri::command]
pub async fn st_chat_count_tokens(
    model: String,
    messages: String,
    state: State<'_, StChatState>,
) -> Result<i64, ShellError> {
    let api = state.api()?;

    /*
     * body 必须是**数组**。传对象或字符串服务端会当成一条怪异输入，
     * 数出来的数字没有意义 —— 所以这里先校验形状，不符合就明确报错。
     */
    let parsed: serde_json::Value = serde_json::from_str(&messages).map_err(|error| {
        ShellError::Invalid {
            message: format!("要计数的消息不是合法 JSON：{error}"),
        }
    })?;
    if !parsed.is_array() {
        return Err(ShellError::Invalid {
            message: "要计数的消息必须是数组".to_string(),
        });
    }

    /*
     * `model` 走 query 参数。空模型名时也要能工作（ST 会退回默认分词器），
     * 所以不做非空校验 —— 与 ST 前端行为保持一致。
     */
    let path = format!(
        "/api/tokenizers/openai/count?model={}",
        urlencode(&model),
    );

    let text = api.post_text(&path, parsed).await?;

    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("token_count").and_then(serde_json::Value::as_i64))
        .ok_or_else(|| ShellError::StBadResponse {
            detail: format!("分词接口没返回 token_count：{}", text.chars().take(200).collect::<String>()),
        })
}

/// 把模型名编成可以放进 query 的形式。
///
/// 模型名里常见 `/` `:` `.`（如 `anthropic/claude-3.5-sonnet`），
/// 不编码会让 URL 解析错（`/` 会被当成路径分隔）。
/// 只保留 RFC 3986 的 unreserved 集合，其余一律 `%XX`。
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
