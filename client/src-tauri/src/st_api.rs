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

/// 请求超时。取 30 秒：ST 的 `/api/characters/all` 会重新读盘，
/// 角色多的时候能到几秒；但也不该无限等 —— 卡住时必须能报错。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
    client: tokio::sync::RwLock<reqwest::Client>,
    csrf: tokio::sync::RwLock<Csrf>,
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
        Ok(Self {
            base,
            client: tokio::sync::RwLock::new(build_client()?),
            csrf: tokio::sync::RwLock::new(Csrf::Unknown),
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
    pub async fn connect(&self) -> Result<(), ShellError> {
        /*
         * 先换一只**全新的 client**（= 丢掉旧 cookie jar），再取 token。
         *
         * 顺序不能反：如果先取 token 再换 client，拿到的是旧会话的 token，
         * 而新 client 的 jar 里没有对应 cookie → 第一个 POST 又是 403。
         *
         * 为什么整只换而不是"清 cookie"：reqwest 在 `cookie_store(true)` 时
         * 不暴露清空 jar 的 API。而且"新会话"的正确语义本来就是一份干净 jar。
         */
        {
            let mut client = self.client.write().await;
            *client = build_client()?;
        }
        *self.csrf.write().await = Csrf::Unknown;

        let client = self.client.read().await.clone();
        let response = client
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
        *self.csrf.write().await = next;
        Ok(())
    }

    /// 取当前 CSRF 状态；`Unknown` 时先 `connect()`。
    async fn csrf_or_connect(&self) -> Result<Csrf, ShellError> {
        {
            let current = self.csrf.read().await;
            if *current != Csrf::Unknown {
                return Ok(current.clone());
            }
        }
        self.connect().await?;
        Ok(self.csrf.read().await.clone())
    }

    /// 发一个 POST，并在需要时附上 CSRF 头。
    ///
    /// 不含 403 恢复逻辑 —— 那在 `post_json` 里。分开是为了让"怎么发"
    /// 与"失败了怎么办"各自可读。
    async fn send_post(&self, path: &str, body: &Value) -> Result<reqwest::Response, ShellError> {
        let csrf = self.csrf_or_connect().await?;
        let client = self.client.read().await.clone();
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

        let mut response = self.send_post(path, &body).await?;
        let mut recovered = false;

        if response.status() == reqwest::StatusCode::FORBIDDEN {
            // ★ 陷阱 #8：cookie 过期后所有 POST 403。
            //
            // 判据是 403（而不是 401）：ST 在 cookie 失效时仍然认为请求"有身份"，
            // 只是 CSRF/会话对不上，所以给 403 而不是 401。
            recovered = true;
            self.connect().await?;
            response = self.send_post(path, &body).await?;
        }

        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(ShellError::StForbidden {
                path: path.to_string(),
                retried: recovered,
            });
        }
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

        let mut response = self.send_post(path, &body).await?;
        let mut recovered = false;
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            recovered = true;
            self.connect().await?;
            response = self.send_post(path, &body).await?;
        }
        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(ShellError::StForbidden {
                path: path.to_string(),
                retried: recovered,
            });
        }
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

        let mut response = self.send_post(path, &body).await?;
        let mut recovered = false;
        if response.status() == reqwest::StatusCode::FORBIDDEN {
            recovered = true;
            self.connect().await?;
            response = self.send_post(path, &body).await?;
        }
        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(ShellError::StForbidden {
                path: path.to_string(),
                retried: recovered,
            });
        }
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
    /// ## 返回
    ///
    /// `Ok(finish_reason)` —— `finish_reason` 一般拿不到（要解析 payload 才知道），
    /// 所以通常返回 `None`；由 TS 侧从 `done` 事件里取。
    ///
    /// 回调返回 `bool`：`false` = 请停止（用户点了停止），本函数会立刻返回。
    pub async fn post_stream<F>(
        &self,
        path: &str,
        body: impl Serialize,
        mut on_payload: F,
    ) -> Result<bool, ShellError>
    where
        F: FnMut(&str) -> bool,
    {
        let body = serde_json::to_value(body).map_err(|error| ShellError::StBadResponse {
            detail: format!("请求体序列化失败：{error}"),
        })?;

        let mut response = self.send_post(path, &body).await?;

        if response.status() == reqwest::StatusCode::FORBIDDEN {
            // 与 post_json 同一套恢复：cookie 过期 → 重连 → 重试一次
            self.connect().await?;
            response = self.send_post(path, &body).await?;
        }

        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN {
            return Err(ShellError::StForbidden {
                path: path.to_string(),
                retried: true,
            });
        }
        if !status.is_success() {
            // 出错时响应体是 JSON/HTML（不是流），读全文便于给出有意义的报错。
            // 403 的响应体是 **HTML**（契约 §9.3），所以只截断、不当 JSON 解析。
            let text = response.text().await.unwrap_or_default();
            return Err(ShellError::StHttpStatus {
                path: path.to_string(),
                status: status.as_u16(),
                detail: truncate(&text, 300),
            });
        }

        let mut stream = response.bytes_stream();
        // 跨块的半行缓冲：一个 `data:` 行可能被 TCP 切成两半
        let mut pending = String::new();

        loop {
            let next = futures_util::StreamExt::next(&mut stream).await;
            let Some(chunk) = next else { break };
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    return Err(ShellError::StBadResponse {
                        detail: format!("读流失败：{error}"),
                    })
                }
            };

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
                    return Ok(false);
                }

                let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line.trim());
                if payload.is_empty() {
                    continue;
                }

                if !on_payload(payload) {
                    // 用户点了停止 —— 立刻返回，不再读后面的包
                    return Ok(true);
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

        Ok(false)
    }

    /// 探活：能不能连上 ST。
    ///
    /// 判据刻意用 `/csrf-token` 而不是根路径：根路径在 ST 未就绪时也可能返回
    /// 一张静态页（200），而 `/csrf-token` 是真正的接口 —— 它 200 才说明
    /// HTTP 服务确实起来了。
    pub async fn probe(&self) -> bool {
        let client = self.client.read().await.clone();
        match client.get(self.url("/csrf-token")).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }
}

/// 造一只 client。`connect()` 每次重连都会调它 —— 新 client = 新 jar。
fn build_client() -> Result<reqwest::Client, ShellError> {
    reqwest::Client::builder()
        // cookie_store 是这套方案的**前提**：cookie 由 jar 持有并自动附着，
        // 不依赖浏览器。少了它，所有 POST 都会 403（§2.2）。
        //
        // 实测佐证（2026-10-30）：**即使 CSRF 头完全正确**，只要没有 cookie，
        // ST 仍返回 403。所以 cookie jar 不是"顺手带上"，是能不能用的分界。
        .cookie_store(true)
        .timeout(REQUEST_TIMEOUT)
        // 不允许跟随重定向：ST 在未登录时可能 302 到登录页，
        // 跟随过去会把"没权限"变成"拿到一张 HTML 登录页"，
        // 错误信息会变成解析失败 —— 比直接报 403 更难查。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ShellError::StUnavailable {
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
        assert!(
            matches!(*api.csrf.read().await, Csrf::Token(_) | Csrf::Disabled),
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
        let foreign = match &*other.csrf.read().await {
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
        *api.csrf.write().await = Csrf::Token(foreign);

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
}
