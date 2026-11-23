//! SillyTavern 的 HTTP 客户端（T15.4）。
//!
//! ## 为什么要 Rust 侧自己做 HTTP，而不是让 webview 发请求
//!
//! ST 的 session cookie 是 `SameSite=Lax`。在 App 内嵌 webview 里，顶层页面
//! （`tauri.localhost`）与 ST（`127.0.0.1:8000`）**跨站**，于是 Lax 的 cookie
//! 在 iframe / XHR 里**从不发送** —— v0.1.6 缺陷三就是这么来的（见 `memory.md` §20）。
//!
//! 走 Rust 侧 HTTP 时 cookie 由 `reqwest` 的 cookie jar 直接持有、直接写进请求头，
//! **不经过浏览器同源策略**，所以：
//!
//!   · ✅ 不需要把 ST 的 cookie 改成 `SameSite=None`；
//!   · ✅ 不需要 webview 参与；
//!   · ⚠️ 代价是 **cookie 的生命周期要 Rust 侧自己管** —— 这正是本文件的核心职责。
//!
//! ## 三条硬约束（都来自 `docs/adapter-contract-st-v1.19.md`）
//!
//! ### 1. CSRF 与会话绑定（§2.3-1）
//!
//! token 是**跟着 session 走的**：换了 session，旧 token 立刻失效。
//! 所以 token 不能当常量缓存，也不能"取一次用到底"。
//!
//! ### 2. `disabled` 是个哨兵值，不是 token（§2.3-2）
//!
//! 服务端关掉 CSRF 保护时，`/csrf-token` 返回 `{"token":"disabled"}`。
//! 把 `"disabled"` 当 token 发出去，服务端会因为"token 不为空但也不匹配"而拒绝 ——
//! 表现为关掉 CSRF 的部署**反而完全不能用**。必须识别并**不发这个头**。
//!
//! ### 3. cookie 过期后所有 POST 403（§7 陷阱 #8）
//!
//! 这是本文件存在的主要理由。ST 的 cookie 会过期，过期后**每个 POST 都返回 403**，
//! 而 403 的响应体通常没有可读原因。用户看到的是"突然发不出消息了"，
//! 重启 App 又好了（因为重新登录拿了新 cookie）—— 于是被当成偶发 bug。
//!
//! 处置：**检测 403 → 重新 `connect()` 一次 → 重试一次**，仍失败才报错。
//! 只重试**一次**：真 403（比如真的没权限）不能被无限重试掩盖。
//!
//! ## 不做什么
//!
//! 这里只做 HTTP 层：连接、cookie、CSRF、403 恢复、JSON 编解码。
//! 业务语义（"这份聊天能不能保存"这类判断，见契约 §3.3 三态）不在这层 ——
//! 放进来会让一个纯传输模块变成半个业务模块，测试也不好写。

/*
 * 暂时允许「未被使用」—— **带到期条件，不是永久静音**。
 *
 * T15.4 只交付 HTTP 层本身；调用方（命令层 / T15.5 的聊天面板）还没写，
 * 所以 `StApi` 及其方法暂时没有外部使用者，编译会报一堆 dead_code。
 *
 * 这些警告是**真的**（确实没人用），但不能靠删代码消掉 —— 交付物是这一层。
 * 所以显式 allow，并在这里写清什么时候必须删掉这行：
 *
 *   到期条件：T15.5 接入后，如果这行 allow 还在，说明要么接入没做全、
 *             要么这里留了死代码 —— 两者都该被看见，而不是被 allow 盖住。
 */
#![allow(dead_code)]

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ShellError;

/// 默认的 ST 地址。T15.3 里 ST 由壳拉起、绑 `127.0.0.1:<随机端口>`，
/// 8000 只是本地开发时的常见值。
pub const DEFAULT_BASE: &str = "http://127.0.0.1:8000";

/// CSRF 关闭时服务端返回的哨兵值。**不能当 token 用**（§2.3-2）。
const CSRF_DISABLED_SENTINEL: &str = "disabled";

/// CSRF 头名（`src/server-main.js:177`）
const CSRF_HEADER: &str = "X-CSRF-Token";

/// 普通请求的**总**超时（从发出到读完整个 body）。取 30 秒：
/// ST 的 `/api/characters/all` 会重新读盘，角色多的时候能到几秒；
/// 但也不该无限等 —— 卡住时必须能报错。
///
/// ★★★ 流式请求**不能**用这个值（2026-11-21）。
///
/// `ClientBuilder::timeout` 是**整个请求**的总时限，包含读完 body。
/// 而一次流式生成要几十秒到几分钟，用它必然在读流中途被掐断，
/// 报出来的就是 `error decoding response body`。
///
/// 真机日志对上了这一点：每次生成的落盘间隔都是 30.1 秒，一次不多一次不少。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 流式请求的「多久没收到新数据」上限（不是总时长）。
///
/// `read_timeout` 管的是**两次读到字节之间**的间隔，所以一次跑三分钟、
/// 只要上游一直在吐字就不会超时；而真挂死了（连接还在但不发数据）
/// 120 秒后仍然会报错，不会永远转圈。
///
/// 120 秒的依据：推理模型在出第一帧之前可能长时间静默（思考阶段），
/// 跨洋中转站的首字延迟也常见 30–60 秒。给到 120 秒，比"够用"再多一档。
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// 连接建立超时。两类请求共用 —— 连不上就该快速失败，不该等总超时。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// CSRF token 的三种状态。
///
/// 用三态而不是 `Option<String>`：`Disabled` 与"还没取过"是**完全不同的意思** ——
/// 前者要"不发头"，后者要"先去取"。合成 `None` 会让代码在关闭 CSRF 的部署上
/// 把 `None` 当成"取失败"，然后反复重试。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Csrf {
    /// 还没取过
    Unknown,
    /// 拿到了可用 token
    Token(String),
    /// 服务端关了 CSRF，**不要发这个头**
    Disabled,
}

/// 取哪一只 client。
///
/// 两只共享同一份 cookie jar，区别只在超时策略：
///
/// ```text
///   Plain   总超时 30s        —— 普通接口，卡住必须报错
///   Stream  无总超时 + 读超时  —— 流式生成，不能被总时长掐断
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClientKind {
    Plain,
    Stream,
}

impl ClientKind {
    fn pick(self, session: &Session) -> reqwest::Client {
        match self {
            Self::Plain => session.client.clone(),
            Self::Stream => session.stream_client.clone(),
        }
    }
}

/// 一次流式请求是怎么结束的（2026-11-22）。
///
/// ## 为什么不能只返回 `bool`
///
/// 原来返回 `bool` 表示"是否被用户停止"。问题在于**连接被掐断与正常发完
/// 在字节流层面长得一模一样** —— 都是 `bytes_stream().next()` 返回 `None`。
///
/// ```text
///   上游正常发完：... data: [DONE] → 连接关闭
///   上游超时断流：... 半截正文    → 连接关闭     ← 两者在流层面无差别
/// ```
///
/// 而 TS 侧 `finalizeOutput` 只要看到一点正文就判成功，于是中转站超时
/// 被"吃"成了一条写了一半的回复 —— 用户看不到任何错误。
///
/// 所以必须把"有没有见过 `[DONE]`"带出去。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamOutcome {
    /// 用户点了停止（回调返回 false）
    pub stopped: bool,
    /// 见过 `[DONE]` —— 上游明确表示"发完了"
    ///
    /// `false` 且 `stopped == false` 时，说明连接在**没有结束标记**的情况下
    /// 结束。可能是上游超时、中转站断流，也可能是我们的读超时。
    /// 上层要据此判断"这条回复可能不完整"。
    ///
    /// ★ 有些后端不发 `[DONE]`，只发 `finish_reason`。那种情况这里也是
    ///   `false`，由 TS 侧结合 `finish_reason` 一起判定 —— 所以**不能**
    ///   单凭 `saw_done == false` 就报错。
    pub saw_done: bool,
}

/// `/csrf-token` 的响应体
#[derive(Debug, Deserialize)]
struct CsrfResponse {
    token: String,
}

/// ST 的 HTTP 客户端。
///
/// 内部持有 cookie jar，所以**同一个实例要复用**：每次新建 client 都会丢 cookie，
/// 等于每次请求都换会话，而换会话就要重取 CSRF —— 既慢又容易撞上 403 恢复路径。
pub struct StApi {
    base: String,
    /// **可替换**的 client。
    ///
    /// 为什么不是固定的 `reqwest::Client`：403 恢复要"重连"，而重连的正确含义是
    /// **丢掉旧 jar、用一份干净的 cookie 重新建会话**。
    ///
    /// 实测（2026-10-30，真 ST 1.19.0）发现的细节：ST 的 session cookie **名字带会话 id**
    /// （`session-e6f8a3d5` / `session-e6f8a3d5.sig`）。cookie 有效时同一个会话会**复用**同一个 id
    /// （连续三次 `connect()` 拿到完全相同的 token 与 cookie 名）；但会话失效后服务端会下发
    /// **新 id** 的 cookie —— 而两个不同名的 cookie 会在 jar 里**共存**，
    /// 请求头于是同时带上 `session-旧=…; session-新=…`，ST 取哪一个不可控。
    ///
    /// 那种情况下"重连后重试"可能仍然 403，看起来像恢复逻辑没生效。
    /// 重建 client 从根上消除这个可能：旧 jar 直接丢弃。
    /// ★★★ `client` 与 `csrf` 必须**同一代**，所以放在同一个锁里（2026-11-11 修）。
    ///
    /// 之前是两个独立 RwLock，于是 `send_post` 里这两行之间可以被别人插进来：
    ///
    /// ```text
    ///   let csrf = self.csrf_or_connect().await?;        // 读到 session A 的 token
    ///   let client = self.client.read().await.clone();   // ← 这里已经是 session B 了
    /// ```
    ///
    /// 结果：**拿 A 的 token 配 B 的 cookie jar ⇒ 永久 403**。
    ///
    /// 这不是理论风险。安卓上报的正是它：
    ///
    /// ```text
    ///   /api/backends/chat-completions/generate 返回 403（已重试：true）
    ///   同一 API、同一密钥，原生 ST 能聊
    /// ```
    ///
    /// `已重试：true` 是关键线索 —— 重试本身就又触发了一次并发错位，
    /// 所以越重试越坏。安卓端请求更密（生成 + token 计数 + 审计并发），
    /// 桌面上串行得多，所以手机上才明显。
    session: tokio::sync::RwLock<Session>,
    /// 重连的单飞锁（同一时刻只有一次 `connect` 真正在跑）
    connect_lock: tokio::sync::Mutex<()>,
}

/// 一次 ST 会话 = 一只带 jar 的 client + 与它配套的 CSRF 状态。
///
/// 把两者绑在一起，任何时刻读到的都一定是**同一代**。
struct Session {
    /// 普通请求用：有总超时，卡住就报错。
    client: reqwest::Client,
    /// 流式请求用：**没有总超时**，只限"多久没收到新数据"。
    ///
    /// 与 `client` 共享同一份 cookie jar（同一 `Arc<Jar>`）——
    /// 两个 client 各自的 jar 会让 CSRF 校验在对的那一只上失败，
    /// 而症状是"流式请求 403、普通请求正常"，极难查。
    stream_client: reqwest::Client,
    csrf: Csrf,
    /// 每次真正重连 +1。403 恢复用它判断"别人是不是已经替我重连过"
    epoch: u64,
}

impl StApi {
    /// 建一个客户端。`base` 形如 `http://127.0.0.1:8001`。
    pub fn new(base: impl Into<String>) -> Result<Self, ShellError> {
        let base = base.into();
        let base = base.trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(ShellError::StUnavailable {
                detail: "ST 地址为空".to_string(),
            });
        }
        let (plain, stream) = build_client_pair()?;
        Ok(Self {
            base,
            session: tokio::sync::RwLock::new(Session {
                client: plain,
                stream_client: stream,
                csrf: Csrf::Unknown,
                epoch: 0,
            }),
            connect_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// 取 CSRF token 并缓存。
    ///
    /// 这是"建会话"的那一步：ST 的 cookieSession 会在响应里下发 session cookie，
    /// 由 cookie jar 收下；令牌与会话绑定，所以**每次重建会话都必须重取**。
    /// 强制重建会话：丢掉旧 jar、重新取 token。
    ///
    /// 适用于"我确定现在这份会话不可用"的场合（登录之后、用户点重试）。
    /// 403 恢复**不要**直接用它 —— 用 [reconnect_if_epoch]，它能在并发时
    /// 避免 N 个请求各重建一次。
    pub async fn connect(&self) -> Result<(), ShellError> {
        let _guard = self.connect_lock.lock().await;
        self.rebuild_locked().await.map(|_| ())
    }

    /// 拿锁之后真正重建。返回新的 epoch。
    ///
    /// ★ 调用方**必须**已持有 `connect_lock`。拆出来是为了让"强制重建"
    /// 与"条件重建"共用同一段逻辑，而不是各写一遍（那种重复必然分叉）。
    async fn rebuild_locked(&self) -> Result<u64, ShellError> {
        /*
         * 先换一只**全新的 client**（= 丢掉旧 cookie jar），再取 token。
         *
         * 顺序不能反：如果先取 token 再换 client，拿到的是旧会话的 token，
         * 而新 client 的 jar 里没有对应 cookie → 第一个 POST 又是 403。
         *
         * 为什么整只换而不是"清 cookie"：reqwest 在 `cookie_store(true)` 时
         * 不暴露清空 jar 的 API。而且"新会话"的正确语义本来就是一份干净 jar。
         */
        let (fresh, fresh_stream) = build_client_pair()?;
        let epoch = {
            let mut session = self.session.write().await;
            session.client = fresh.clone();
            session.stream_client = fresh_stream;
            session.csrf = Csrf::Unknown;
            session.epoch += 1;
            session.epoch
        };

        let response = fresh
            .get(self.url("/csrf-token"))
            .send()
            .await
            .map_err(|error| ShellError::StUnavailable {
                detail: format!("连不上 ST（{}）：{error}", self.base),
            })?;

        let status = response.status();
        if !status.is_success() {
            return Err(ShellError::StUnavailable {
                detail: format!("GET /csrf-token 返回 HTTP {}", status.as_u16()),
            });
        }

        let body: CsrfResponse = response
            .json()
            .await
            .map_err(|error| ShellError::StBadResponse {
                detail: format!("/csrf-token 响应不是 {{token}}：{error}"),
            })?;

        // ⚠️ 哨兵值判定必须在**缓存之前**：把它当 token 存下来，
        // 后面每个 POST 都会带一个叫 "disabled" 的令牌，服务端一律拒。
        let next = if body.token == CSRF_DISABLED_SENTINEL || body.token.is_empty() {
            Csrf::Disabled
        } else {
            Csrf::Token(body.token)
        };

        let mut session = self.session.write().await;
        if session.epoch == epoch {
            session.csrf = next;
        }
        Ok(epoch)
    }

    /// 条件重建：只有 epoch 仍是 `seen` 时才真重建。
    ///
    /// ## 这是"并发 403 只重建一次"的关键（2026-11-11）
    ///
    /// 十个请求同时 403，它们都记着同一个 `seen`。第一个拿到锁的重建了，
    /// epoch 变成 `seen+1`；后九个进来一看 epoch 变了 —— **说明别人已经
    /// 替我连好了**，直接返回、用那份新会话去重试。
    ///
    /// 不加这个判断，十个请求会重建十次，每次都把前一次的 jar 丢掉；
    /// 而 403 恢复的重试会拿着"自己那代的 token"去配"最新那代的 jar"，
    /// 于是 403 永不消失 —— 用户看到的就是「已重试：true」仍然失败。
    async fn reconnect_if_epoch(&self, seen: u64) -> Result<(), ShellError> {
        let _guard = self.connect_lock.lock().await;
        if self.session.read().await.epoch != seen {
            log::debug!(target: "st_api", "并发 403：别人已重连，复用其会话（epoch {seen}）");
            return Ok(());
        }
        self.rebuild_locked().await.map(|_| ())
    }

    /// 取**同一代**的 client 与 CSRF 状态；`Unknown` 时先 `connect()`。
    ///
    /// ★ 必须一次读出两者（2026-11-11）。分成两次读会拿到"这一代的 token +
    /// 下一代的 jar"，那正是 403 反复出现的根因 —— 见 `Session` 的注释。
    async fn session_or_connect(&self) -> Result<(reqwest::Client, Csrf), ShellError> {
        self.session_or_connect_with(ClientKind::Plain).await
    }

    /// 同 `session_or_connect`，但可以选择要哪一只 client。
    ///
    /// 流式请求必须用 `Stream`（没有总超时），否则长回复会在中途被掐断 ——
    /// 报出来的却是 `error decoding response body`，看上去像网络问题。
    async fn session_or_connect_with(
        &self,
        kind: ClientKind,
    ) -> Result<(reqwest::Client, Csrf), ShellError> {
        {
            let session = self.session.read().await;
            if session.csrf != Csrf::Unknown {
                return Ok((kind.pick(&session), session.csrf.clone()));
            }
        }
        /*
         * 记下 epoch 再条件重建：排队期间别人连好了就复用，
         * 不重复重建（首屏三个请求同时到，不该建三次会话）。
         */
        let seen = self.session.read().await.epoch;
        self.reconnect_if_epoch(seen).await?;
        let session = self.session.read().await;
        Ok((kind.pick(&session), session.csrf.clone()))
    }

    /// 403 恢复：条件重连，**并发时只重建一次**。
    ///
    /// 与 `connect()` 的区别就是那条 epoch 判断。为什么 403 恢复必须用它：
    ///
    /// ```text
    ///   十个请求同时 403
    ///     → 各自调 connect()  ⇒ 重建十次，每次都丢掉前一次的 jar
    ///     → 而重试时"自己那代的 token"配"最新那代的 jar" ⇒ 仍然 403
    ///   用户看到的就是「已重试：true」还是失败。
    /// ```
    ///
    /// 用这个：第一个重建，其余九个一看 epoch 变了就复用 —— 只重建一次，
    /// 且所有请求都用同一份新会话去重试。
    /// 判断一个 403 到底是**谁**给的。
    ///
    /// ## 为什么必须分清（2026-11-11 真机取证）
    ///
    /// 403 有两个完全不同的来源，处置相反：
    ///
    /// ```text
    ///   ST 自己的 CSRF/session 校验失败
    ///     → 重连 + 重试**有用**（换一份新会话就好了）
    ///
    ///   上游 API 服务商拒绝（额度不足 / key 无效 / 无权用该模型）
    ///     → 重连**没用**，重试**白花钱**（按次计费时这一下也算一次）
    /// ```
    ///
    /// 判据看 **body 形状**，不看状态码：
    ///
    /// ```text
    ///   ST 的 CSRF 失败  →  纯文本 "Invalid CSRF token. Please refresh the page and try again."
    ///   上游拒绝        →  JSON：{"error":{"message":"…","code":"…"}}
    /// ```
    ///
    /// ★ 判据不能只看"body 是不是 JSON"：ST 的 404/500 也可能回 JSON。
    ///   必须看 `error` 这一层里有没有 `message` 或 `code` —— 那是上游
    ///   （OpenAI 兼容格式）与 new-api 系中转站共有的形状。
    ///
    /// 返回 `None` = 判不出来（空 body、非 JSON、JSON 但不是错误形状），
    /// 此时按 **CSRF** 处理 —— 那是既有行为，保住旧路径不乱。
    fn classify_forbidden_body(body: &str) -> Option<(String, String)> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return None;
        }
        let Ok(json) = serde_json::from_str::<Value>(trimmed) else {
            return None;
        };
        let error = json.get("error")?;

        /*
         * 两种常见形状都收：
         *
         * ```json
         *   {"error": {"message": "账户额度不足。…", "code": "pre_consume_token_quota_failed"}}
         *   {"error": "invalid_api_key"}          ← OpenAI 老格式，直接是字符串
         * ```
         */
        if let Some(text) = error.as_str() {
            return Some((text.to_string(), String::new()));
        }
        let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("");
        let code = error.get("code").and_then(|v| v.as_str()).unwrap_or("");
        if message.is_empty() && code.is_empty() {
            return None;
        }
        Some((message.to_string(), code.to_string()))
    }

    /// 发 POST；403 时**先判来源**，只有真 CSRF 失效才重连重试。
    ///
    /// ## 为什么不重试上游 403
    ///
    /// 用户的 API 是**按次计费**的（5 元 ≈ 200 次）。额度不足时上游回 403，
    /// 若我们按老逻辑"重连 + 重试一次"，那次重试**照样计费** ——
    /// 等于在用户已经欠费的情况下又刷了他一次。这不是性能问题，是钱。
    async fn send_post_with_recovery(
        &self,
        path: &str,
        body: &Value,
        kind: ClientKind,
    ) -> Result<reqwest::Response, ShellError> {
        let response = self.send_post(path, body, kind).await?;
        if response.status() != reqwest::StatusCode::FORBIDDEN {
            return Ok(response);
        }

        /* 403：先读 body 判来源。读掉之后这个 response 就废了，所以要重发。 */
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();

        if let Some((message, code)) = Self::classify_forbidden_body(&text) {
            /*
             * 上游拒绝：**立刻返回，不重连、不重试**。
             *
             * 带上 code 是为了让用户能拿去搜 / 问客服；
             * 服务商原话保留不改写 —— "账户额度不足。请检查额度或购买。"
             * 这句话比我们编的任何提示都准。
             */
            let detail = if code.is_empty() {
                message
            } else {
                format!("{message}（{code}）")
            };
            log::warn!(target: "st_api", "上游拒绝 {path}：{status} {detail}");
            return Err(ShellError::UpstreamRejected {
                path: path.to_string(),
                detail,
                status,
            });
        }

        /*
         * 判不出来 ⇒ 按 CSRF 失效处理（既有行为）。
         *
         * 这里刻意**不用**刚读掉的 response 去判断重试结果 ——
         * 它已经废了，必须重新发一次请求。
         */
        log::info!(target: "st_api", "403 判为会话失效（body 非上游错误形状），重连重试：{path}");
        self.recover_forbidden().await?;
        let retry = self.send_post(path, body, kind).await?;
        if retry.status() != reqwest::StatusCode::FORBIDDEN {
            return Ok(retry);
        }

        /* 重试后仍 403：再判一次，别把上游错误报成"会话过期" */
        let retry_status = retry.status().as_u16();
        let retry_text = retry.text().await.unwrap_or_default();
        if let Some((message, code)) = Self::classify_forbidden_body(&retry_text) {
            let detail = if code.is_empty() {
                message
            } else {
                format!("{message}（{code}）")
            };
            return Err(ShellError::UpstreamRejected {
                path: path.to_string(),
                detail,
                status: retry_status,
            });
        }
        Err(ShellError::StForbidden {
            path: path.to_string(),
            retried: true,
        })
    }

    async fn recover_forbidden(&self) -> Result<(), ShellError> {
        let seen = self.session.read().await.epoch;
        self.reconnect_if_epoch(seen).await
    }

    /// 发一个 POST，并在需要时附上 CSRF 头。
    ///
    /// 不含 403 恢复逻辑 —— 那在 `post_json` 里。分开是为了让"怎么发"
    /// 与"失败了怎么办"各自可读。
    ///
    /// `kind` 决定用哪只 client：流式调用方必须传 `Stream`，
    /// 否则长回复会被 30 秒总超时掐断（见 `REQUEST_TIMEOUT` 的注释）。
    async fn send_post(
        &self,
        path: &str,
        body: &Value,
        kind: ClientKind,
    ) -> Result<reqwest::Response, ShellError> {
        let (client, csrf) = self.session_or_connect_with(kind).await?;
        let mut request = client.post(self.url(path)).json(body);
        // 关闭 CSRF 的部署：**不发这个头**（发了反而被拒）
        if let Csrf::Token(token) = csrf {
            request = request.header(CSRF_HEADER, token);
        }
        request.send().await.map_err(|error| ShellError::StUnavailable {
            detail: format!("请求 {path} 失败：{error}"),
        })
    }

    /// POST 并解析成 `T`，带 **403 → 重连 → 重试一次** 的 cookie 恢复。
    ///
    /// 重试只做一次。理由：真 403（确实无权限）如果无限重试，
    /// 会把"权限问题"伪装成"卡住"，而用户看到的是一直的 loading。
    pub async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: impl Serialize,
    ) -> Result<T, ShellError> {
        let body = serde_json::to_value(body).map_err(|error| ShellError::StBadResponse {
            detail: format!("请求体序列化失败：{error}"),
        })?;

        /*
         * 403 的两种来源在这里分流（2026-11-11）：
         *
         * ```text
         *   上游服务商拒绝  → UpstreamRejected，不重试（重试要花钱）
         *   ST 会话失效     → 重连 + 重试一次
         * ```
         *
         * 分流逻辑在 `send_post_with_recovery` 里，四个调用点共用。
         */
        let response = self.send_post_with_recovery(path, &body, ClientKind::Plain).await?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(ShellError::StHttpStatus {
                path: path.to_string(),
                status: status.as_u16(),
                detail: truncate(&text, 300),
            });
        }

        response
            .json::<T>()
            .await
            .map_err(|error| ShellError::StBadResponse {
                detail: format!("{path} 的响应不是预期 JSON：{error}"),
            })
    }

    /// POST 并把原始文本读出来。给"响应形状不稳定"的端点用
    /// （比如 `/api/chats/get` 的 `{}` / `[]` / 数组三态，见陷阱 #4）。
    pub async fn post_text(&self, path: &str, body: impl Serialize) -> Result<String, ShellError> {
        let body = serde_json::to_value(body).map_err(|error| ShellError::StBadResponse {
            detail: format!("请求体序列化失败：{error}"),
        })?;

        let response = self.send_post_with_recovery(path, &body, ClientKind::Plain).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(ShellError::StHttpStatus {
                path: path.to_string(),
                status: status.as_u16(),
                detail: String::new(),
            });
        }
        response.text().await.map_err(|error| ShellError::StBadResponse {
            detail: format!("{path} 读响应体失败：{error}"),
        })
    }

    /// POST 并取**原始字节**（2026-11-04，T15.2）。
    ///
    /// 用于"下载文件"类接口：`/api/characters/export?format=png` 返回的是
    /// PNG 二进制，`post_text` 会尝试当 UTF-8 读，直接把图片读坏。
    ///
    /// 权限/重连语义与 `post_text` 完全一致（403 时重连一次再试）——
    /// 那套逻辑不该有两份。
    pub async fn post_bytes(&self, path: &str, body: impl Serialize) -> Result<Vec<u8>, ShellError> {
        let body = serde_json::to_value(body).map_err(|error| ShellError::StBadResponse {
            detail: format!("请求体序列化失败：{error}"),
        })?;

        let response = self.send_post_with_recovery(path, &body, ClientKind::Plain).await?;
        let status = response.status();
        if !status.is_success() {
            return Err(ShellError::StHttpStatus {
                path: path.to_string(),
                status: status.as_u16(),
                detail: String::new(),
            });
        }
        let bytes = response.bytes().await.map_err(|error| ShellError::StBadResponse {
            detail: format!("{path} 读响应体失败：{error}"),
        })?;
        Ok(bytes.to_vec())
    }

    /// 流式 POST：逐块读取响应体，按行切出 `data:` 的 payload 交给回调。
    ///
    /// ## 这一层**只分帧，不解析语义**
    ///
    /// 契约 §4.2 列了四种后端的流式事件形状（`choices[0].delta.content` /
    /// `delta.reasoning_content` / Claude 的 `content_block_delta` …）。
    /// 那些差异已经在 TS 侧由 `shared/src/st-adapter/sse.ts` 的 `translateFrame`
    /// 统一处理，并有契约测试守着。
    ///
    /// 如果这里也解析一份 JSON，就会出现**两份实现**：改一处忘另一处，
    /// 表现为"某个后端在 Rust 侧认得出、在测试里认不出"。所以这里只做
    /// "把一段字节流切成一行行的 payload"，原样交给调用方。
    ///
    /// ## 陷阱 #10：**不看 Content-Type**
    ///
    /// ST 的流式响应**没有** `Content-Type: text/event-stream`（契约 §4.1）。
    /// 所以这里既不检查 header、也不据 header 分支 —— 是不是流式，由调用方
    /// 发出去的 `stream: true` 决定。加了 header 判断的话，真 ST 上会永远
    /// 走非流式分支，而"看起来也拿到了内容"，非常难发现。
    ///
    /// ## 返回 `StreamOutcome` 而不是 `bool`（2026-11-22）
    ///
    /// ## 为什么必须区分"收到 [DONE]"与"连接断了"
    ///
    /// 用户报「中转站的错误捕捉不到了，显示不了」。
    ///
    /// 原来这里只返回 `bool`（是否被用户停止）。上游超时掐断连接时，
    /// `bytes_stream` 的 `next()` 返回 `None` —— 那和"正常发完"**一模一样**，
    /// 于是本函数返回 `Ok(false)`，上层当成正常结束。
    ///
    /// 而 TS 侧 `finalizeOutput` 只要看到一点正文就判成功，于是：
    ///
    /// ```text
    ///   中转站 1m49s 超时断流
    ///   ⇒ 我们收到半截正文，判"成功"
    ///   ⇒ 用户看到一条写了一半的回复，没有任何错误提示
    ///   ⇒ 而中转站后台明确记着"响应超时"
    /// ```
    ///
    /// 现在把"有没有见过 `[DONE]`"带出去，上层就能判"这条回复是否完整"。
    ///
    /// 回调返回 `bool`：`false` = 请停止（用户点了停止），本函数会立刻返回。
    pub async fn post_stream<F>(
        &self,
        path: &str,
        body: impl Serialize,
        mut on_payload: F,
    ) -> Result<StreamOutcome, ShellError>
    where
        F: FnMut(&str) -> bool,
    {
        let body = serde_json::to_value(body).map_err(|error| ShellError::StBadResponse {
            detail: format!("请求体序列化失败：{error}"),
        })?;

        /*
         * 与其它三个调用点共用同一套 403 分流（2026-11-11）。
         *
         * ★ 流式这条尤其要注意：上游 403 时**绝不能重试** ——
         *   那是一次真实的模型调用，按次计费时重试就是重复扣费。
         *
         * ★★★ 这里必须用 `ClientKind::Stream`（2026-11-21）。
         *   用 Plain 的话，30 秒总超时会在读流中途把连接掐断，
         *   报出来的是 `error decoding response body` —— 看上去像网络问题，
         *   实际是我们自己的超时。真机日志：每次生成都恰好 30.1 秒结束。
         */
        let response = self.send_post_with_recovery(path, &body, ClientKind::Stream).await?;

        let status = response.status();
        if !status.is_success() {
            // 出错时响应体是 JSON/HTML（不是流），读全文便于给出有意义的报错。
            // 403 已经在 `send_post_with_recovery` 里分流并读掉了，走不到这里。
            let text = response.text().await.unwrap_or_default();
            return Err(ShellError::StHttpStatus {
                path: path.to_string(),
                status: status.as_u16(),
                detail: summarize_error_body(&text),
            });
        }

        let mut stream = response.bytes_stream();
        // 跨块的半行缓冲：一个 `data:` 行可能被 TCP 切成两半
        let mut pending = String::new();
        /* 已收到多少字节 —— 出错时用来判断"是半路断的"还是"一个字节都没来" */
        let mut received: u64 = 0;

        loop {
            let next = futures_util::StreamExt::next(&mut stream).await;
            let Some(chunk) = next else { break };
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    /*
                     * 读流中断要**说清是哪一种**，否则用户只能看到
                     * `error decoding response body` 这种底层措辞，
                     * 而它指向的是"网络坏了"——真正常见的原因其实是别的。
                     *
                     * 三类分开：
                     *
                     * ```text
                     *   收到过数据   → 上游/中间层把连接断了（内容多半已经拿到一部分）
                     *   一个字节没到 → 连上了但对面不说话（超时 / 上游拒绝吐）
                     * ```
                     *
                     * 超时单独判：`is_timeout()` 为真时要明说"等了多久"，
                     * 因为那不是网速问题，是**上游一直没给新内容**。
                     */
                    let detail = if error.is_timeout() {
                        format!(
                            "上游 {} 秒没有返回新内容（已收到 {received} 字节）",
                            STREAM_READ_TIMEOUT.as_secs()
                        )
                    } else if received == 0 {
                        format!("连接已建立，但上游一个字节都没返回：{error}")
                    } else {
                        format!("上游中断了响应（已收到 {received} 字节）：{error}")
                    };
                    log::warn!(target: "st_api", "读流中断 {path}：{detail}");
                    return Err(ShellError::StBadResponse { detail });
                }
            };

            received += bytes.len() as u64;
            pending.push_str(&String::from_utf8_lossy(&bytes));

            // 按行处理完整行；最后一段不完整的留在 pending 里
            while let Some(newline) = pending.find('\n') {
                let line = pending[..newline].trim_end_matches('\r').to_string();
                pending.drain(..=newline);

                // 空行是 SSE 的事件分隔符，本身没有 payload
                if line.is_empty() {
                    continue;
                }
                // `[DONE]` 是老式 OpenAI 的结束标记
                if line.trim() == "data: [DONE]" || line.trim() == "[DONE]" {
                    return Ok(StreamOutcome {
                        stopped: false,
                        saw_done: true,
                    });
                }

                let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line.trim());
                if payload.is_empty() {
                    continue;
                }

                if !on_payload(payload) {
                    // 用户点了停止 —— 立刻返回，不再读后面的包
                    return Ok(StreamOutcome {
                        stopped: true,
                        saw_done: false,
                    });
                }
            }
        }

        // 收尾：流结束时 pending 里可能还有最后一行（没有换行符结尾）
        let tail = pending.trim();
        if !tail.is_empty() {
            let payload = tail.strip_prefix("data:").map(str::trim).unwrap_or(tail);
            if !payload.is_empty() {
                on_payload(payload);
            }
        }

        /*
         * 走到这里说明 `bytes_stream` 返回了 `None` —— 连接结束。
         *
         * ★ 但"连接结束"有两种，必须分开：
         *
         * ```text
         *   见过 [DONE]           ⇒ 上游正常发完（虽然上面会提前 return，这里是兜底）
         *   没见过 [DONE] 就 EOF  ⇒ 连接被掐断
         * ```
         *
         * 后者的来源不止一种：上游超时、中转站主动断、我们自己的读超时。
         * 在这里记为 `saw_done = false`，由上层结合 `finish_reason` 判断
         * "这条回复是否完整"。
         */
        Ok(StreamOutcome {
            stopped: false,
            saw_done: false,
        })
    }

    /// 探活：能不能连上 ST。
    ///
    /// 判据刻意用 `/csrf-token` 而不是根路径：根路径在 ST 未就绪时也可能返回
    /// 一张静态页（200），而 `/csrf-token` 是真正的接口 —— 它 200 才说明
    /// HTTP 服务确实起来了。
    pub async fn probe(&self) -> bool {
        let client = self.session.read().await.client.clone();
        match client.get(self.url("/csrf-token")).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }
}

/// 造一份新的 client 对（普通 + 流式），**共享同一份 cookie jar**。
///
/// ## 为什么要两只
///
/// `ClientBuilder::timeout` 是**整个请求**的总时限，包含读完 body。
/// 普通接口（角色列表、设置读写）用它合适：卡住必须能报错。
/// 流式生成不行 —— 一次几十秒到几分钟，总时限一定在中途把流掐断。
///
/// `read_timeout` 是另一回事：它限的是"两次读到字节之间"的间隔，
/// 正好对应"上游真挂了"这个要防的情况，而不会误伤长回复。
///
/// ## 为什么必须共享 jar
///
/// CSRF 令牌与会话 cookie 绑定。两只 client 各建一份 jar 的话，
/// 流式请求会带着**没有对应 cookie 的 token** → 403。
/// 而症状是"普通请求正常、只有流式 403"，最难查的那种。
fn build_client_pair() -> Result<(reqwest::Client, reqwest::Client), ShellError> {
    let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
    let plain = build_client_with(jar.clone(), Some(REQUEST_TIMEOUT))?;
    let stream = build_client_with(jar, None)?;
    Ok((plain, stream))
}

/// 造一只 client。`total_timeout` 为 `None` 时**不设总超时**（流式用）。
fn build_client_with(
    jar: std::sync::Arc<reqwest::cookie::Jar>,
    total_timeout: Option<Duration>,
) -> Result<reqwest::Client, ShellError> {
    let mut builder = reqwest::Client::builder()
        // cookie 由 jar 持有并自动附着，不依赖浏览器。少了它，所有 POST 都会 403（§2.2）。
        //
        // 实测佐证（2026-10-30）：**即使 CSRF 头完全正确**，只要没有 cookie，
        // ST 仍返回 403。所以 cookie jar 不是"顺手带上"，是能不能用的分界。
        //
        // 用 `cookie_provider` 而不是 `cookie_store(true)`：前者能让我们
        // **把同一份 jar 交给两只 client**（见 `build_client_pair` 的注释）。
        .cookie_provider(jar)
        .connect_timeout(CONNECT_TIMEOUT)
        // 不允许跟随重定向：ST 在未登录时可能 302 到登录页，
        // 跟随过去会把"没权限"变成"拿到一张 HTML 登录页"，
        // 错误信息会变成解析失败 —— 比直接报 403 更难查。
        .redirect(reqwest::redirect::Policy::none());

    builder = match total_timeout {
        Some(limit) => builder.timeout(limit),
        /*
         * 流式：不给总时限，只给"多久没数据"的时限。
         *
         * 两个都设的意义：没有 read_timeout 的话，上游挂死会让流永远不结束
         * （用户看到呼吸点一直转，只能杀进程）；设了它就还能报错。
         */
        None => builder.read_timeout(STREAM_READ_TIMEOUT),
    };

    builder.build().map_err(|error| ShellError::StUnavailable {
        detail: format!("构造 HTTP 客户端失败：{error}"),
    })
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…")
}

/// 把上游的错误响应体压成**一句能读的话**（2026-11-22）。
///
/// ## 为什么不能直接把 body 原样交出去
///
/// 中转站与各家 API 的 400/500 都是 JSON，原样塞进错误对象的结果是：
///
/// ```text
///   生成失败（400）：{"error":{"message":"This model's maximum context length
///   is 1048576 tokens. However, you requested 1049987 tokens (665987 in the m
/// ```
///
/// 三重损失：转义符占位置、外层结构毫无信息、**被截断在关键数字之前**。
/// 而那句话里的数字恰恰是用户唯一能据此调整的依据。
///
/// ## 认哪些形状（按覆盖率排序）
///
/// ```text
///   {"error":{"message":"…"}}       OpenAI / DeepSeek / 绝大多数中转站
///   {"error":"…"}                   有的网关直接给字符串
///   {"message":"…"}                 少数自研后台
///   {"error":{"code":"…"}}          只有码时退回原文，至少不丢东西
///   <html>…</html>                  502 页面，按纯文本截断
/// ```
fn summarize_error_body(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    /*
     * 只解析对象形态。数组/字符串等形状保持原样 ——
     * `serde_json` 能把 `"abc"` 也解析成功，那会把引号也带进文案里。
     */
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        // ① `error` 是对象且带 message
        if let Some(serde_json::Value::Object(inner)) = map.get("error") {
            if let Some(serde_json::Value::String(message)) = inner.get("message") {
                if !message.trim().is_empty() {
                    return truncate(message.trim(), 400);
                }
            }
            // 只有 code / type 时，组合成一句，别只说"失败了"
            let code = inner
                .get("code")
                .or_else(|| inner.get("type"))
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if !code.is_empty() {
                return format!("上游报错（{code}），没给具体说明");
            }
        }
        // ② `error` 直接是字符串
        if let Some(serde_json::Value::String(message)) = map.get("error") {
            if !message.trim().is_empty() {
                return truncate(message.trim(), 400);
            }
        }
        // ③ 顶层 `message`
        if let Some(serde_json::Value::String(message)) = map.get("message") {
            if !message.trim().is_empty() {
                return truncate(message.trim(), 400);
            }
        }
    }

    truncate(trimmed, 300)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_去掉尾部斜杠() {
        let api = StApi::new("http://127.0.0.1:8001/").unwrap();
        assert_eq!(api.base(), "http://127.0.0.1:8001");
    }

    #[test]
    fn 空地址直接报错() {
        assert!(StApi::new("").is_err());
    }

    #[test]
    fn csrf_三态互不相等() {
        // 这三态如果被合并成 Option，关闭 CSRF 的部署会被误判成"没取到"，
        // 然后反复重试。这条测试钉住"它们是不同的"。
        assert_ne!(Csrf::Unknown, Csrf::Disabled);
        assert_ne!(Csrf::Disabled, Csrf::Token("x".into()));
        assert_ne!(Csrf::Unknown, Csrf::Token("x".into()));
    }

    // ── 对真 ST 的契约测试 ─────────────────────────────────────────
    //
    // ## 为什么放在模块内（而不是 tests/ 下的 integration test）
    //
    // 403 恢复路径要**精确构造**一个中间状态：cookie 已失效、但手里还攥着
    // 一个旧的 CSRF token。这需要直接改私有字段 `csrf`，integration test
    // 看不到它。为了测试而把内部状态暴露成 pub，是拿生产 API 去换测试便利。
    //
    // ## 怎么跑
    //
    //   TCS_ST_TEST_BASE=http://127.0.0.1:8000 cargo test --lib live_ --
    //                                             --ignored --test-threads=1
    //
    // 不给 `TCS_ST_TEST_BASE` 时**直接过**（打印一行说明），不算失败：
    // 没起 ST 的机器上不该红 —— 但它也不会假装验过，所以打印得很显眼。
    //
    // `--test-threads=1` 是必要的：几条用例共用同一个 ST 实例，
    // 并行跑会互相干扰会话（本项目已因"测试并行踩共享状态"栽过一次）。

    fn live_base() -> Option<String> {
        std::env::var("TCS_ST_TEST_BASE").ok().filter(|v| !v.trim().is_empty())
    }

    #[tokio::test]
    #[ignore = "需要真 ST：设 TCS_ST_TEST_BASE 后加 --ignored 跑"]
    async fn live_connect_能拿到_token_且能发请求() {
        let Some(base) = live_base() else {
            println!("跳过：未设 TCS_ST_TEST_BASE");
            return;
        };
        let api = StApi::new(base).expect("建 client");

        // ① 建会话
        api.connect().await.expect("connect 应当成功");
        /*
         * `csrf` 从 v0.1.10 起并进 `session`（与 client 同一代，见 `Session` 的注释），
         * 这里跟着改成读 `session`。先取一份克隆再 `matches!`：guard 不能跨 await 持有。
         */
        let csrf = api.session.read().await.csrf.clone();
        assert!(
            matches!(csrf, Csrf::Token(_) | Csrf::Disabled),
            "connect 之后 CSRF 不该还是 Unknown"
        );

        // ② 真实请求（/api/settings/get 是只读的，不会污染数据）
        let settings: Value = api
            .post_json("/api/settings/get", serde_json::json!({}))
            .await
            .expect("带 cookie + token 的 POST 应当成功");
        assert!(
            settings.is_object(),
            "settings/get 应当返回对象，实际：{}",
            truncate(&settings.to_string(), 120)
        );
    }

    #[tokio::test]
    #[ignore = "需要真 ST"]
    async fn live_重建会话之后仍能发请求() {
        // 这条守的是"重连的正确语义"：**重建 client 必须同时重取 token**。
        // 若只换 client 不换 token，就会变成"新 jar 配旧 token" ——
        // 而实测已确认：token 与 cookie 不配套时 ST 一律 403。
        let Some(base) = live_base() else {
            println!("跳过：未设 TCS_ST_TEST_BASE");
            return;
        };
        let api = StApi::new(base).expect("建 client");
        api.connect().await.expect("首次 connect");

        let first: Value = api
            .post_json("/api/settings/get", serde_json::json!({}))
            .await
            .expect("首次请求应当成功");

        api.connect().await.expect("再次 connect（重建 client）");

        let second: Value = api
            .post_json("/api/settings/get", serde_json::json!({}))
            .await
            .expect("重建会话后仍应当成功");
        assert_eq!(
            first.is_object(),
            second.is_object(),
            "两次响应形状应当一致"
        );
    }

    #[tokio::test]
    #[ignore = "需要真 ST"]
    async fn live_403_后自动重连重试能恢复() {
        /*
         * 这条直接验陷阱 #8 的恢复路径。
         *
         * 构造方式（照着实测事实来）：
         *   实测已确认「CSRF 头**正确**但没有 cookie → 403」。
         *   所以：拿一个**别的实例**换来的有效 token，塞进一只干净 client，
         *   第一个 POST 必然 403；此时 post_json 内部应当
         *   connect() → 重取配套的 token+cookie → 重试 → 成功。
         *
         * 这正是线上"cookie 过期后突然发不出消息"的形状。
         */
        let Some(base) = live_base() else {
            println!("跳过：未设 TCS_ST_TEST_BASE");
            return;
        };

        // 先弄一个**有效的** token（来自另一只会话）
        let other = StApi::new(base.clone()).expect("建 client");
        other.connect().await.expect("取有效 token");
        let foreign = match &other.session.read().await.csrf {
            Csrf::Token(t) => t.clone(),
            Csrf::Disabled => {
                // 服务端关了 CSRF：没有"错 token"这个状态，本用例不适用
                println!("跳过：服务端关闭了 CSRF（token=disabled）");
                return;
            }
            Csrf::Unknown => panic!("connect 之后不该是 Unknown"),
        };

        // 新实例：jar 干净，但硬塞一个**不配套**的 token
        let api = StApi::new(base).expect("建 client");
        api.session.write().await.csrf = Csrf::Token(foreign);

        // 第一次会 403（token 不属于这只 client 的会话），内部应自动恢复
        let settings: Value = api
            .post_json("/api/settings/get", serde_json::json!({}))
            .await
            .expect("403 后应当自动重连并重试成功");
        assert!(settings.is_object(), "恢复后应当拿到正常响应");
    }

    #[tokio::test]
    #[ignore = "需要真 ST"]
    async fn live_probe_对活着的服务返回_true() {
        let Some(base) = live_base() else {
            println!("跳过：未设 TCS_ST_TEST_BASE");
            return;
        };
        let api = StApi::new(base).expect("建 client");
        assert!(api.probe().await, "ST 在跑时 probe 应当为 true");
    }

    #[tokio::test]
    async fn probe_对没人监听的端口返回_false() {
        // 这条不需要真 ST：挑一个几乎不可能有服务的端口。
        // 判据是"不 panic 且返回 false" —— probe 不能因为连不上就崩。
        let api = StApi::new("http://127.0.0.1:59999").expect("建 client");
        assert!(!api.probe().await);
    }

    #[tokio::test]
    async fn 连不上时_post_json_报_StUnavailable_而不是崩溃() {
        let api = StApi::new("http://127.0.0.1:59998").expect("建 client");
        let error = api
            .post_json::<Value>("/api/settings/get", serde_json::json!({}))
            .await
            .expect_err("连不上应当报错");
        assert_eq!(error.code(), "ST_UNAVAILABLE", "实际：{error}");
    }

    /* ── 上游错误正文压成一句话（2026-11-22） ── */

    #[test]
    fn 错误正文_抽出_error_message_并保留数字() {
        let body = r#"{"error":{"message":"This model's maximum context length is 1048576 tokens. However, you requested 1049987 tokens (665987 in the messages, 384000 in the completion).","type":"invalid_request_error"}}"#;
        let got = summarize_error_body(body);
        assert!(got.starts_with("This model's maximum context length"), "实际：{got}");
        assert!(got.contains("1049987"), "数字必须留着，用户靠它调参：{got}");
        assert!(!got.contains('{'), "外壳 JSON 不该出现在文案里：{got}");
    }

    #[test]
    fn 错误正文_error_是字符串也认() {
        let got = summarize_error_body(r#"{"error":"rate limited"}"#);
        assert_eq!(got, "rate limited");
    }

    #[test]
    fn 错误正文_顶层_message_也认() {
        let got = summarize_error_body(r#"{"message":"Key 已过期"}"#);
        assert_eq!(got, "Key 已过期");
    }

    #[test]
    fn 错误正文_只有_code_时给一句能读的() {
        let got = summarize_error_body(r#"{"error":{"code":"invalid_api_key"}}"#);
        assert!(got.contains("invalid_api_key"), "实际：{got}");
        assert!(got.starts_with("上游报错"), "实际：{got}");
    }

    #[test]
    fn 错误正文_纯文本原样截断() {
        let got = summarize_error_body("  502 Bad Gateway  ");
        assert_eq!(got, "502 Bad Gateway");
    }

    #[test]
    fn 错误正文_空响应不炸() {
        assert_eq!(summarize_error_body("   "), "");
    }
}
