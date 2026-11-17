//! 服务端同步用的 HTTP 通道（2026-11-17）。
//!
//! ## 这个模块解决什么
//!
//! Windows 客户端连自签证书的 https 服务端时，**webview 里的 fetch 直接失败**，
//! 而失败经浏览器翻译后只剩一句 `TypeError` —— 到界面上就是"地址不通、端口
//! 未开、或服务端未启动"（memory §105 的取证：8 ms/72 ms 快速失败，`curl -k`
//! 立刻 200）。用户被指向错误的方向（去查端口），而真正能做的事（确认风险后
//! 继续）根本没有出口。
//!
//! 根因是**webview 的证书校验无法配置**：它用系统的证书链，自签一律拒绝，
//! 也没有"只对这个 origin 放行"的开关。所以这类请求必须搬到 Rust。
//!
//! ## ★ 证书判定为什么用「两段探测」而不是匹配错误文案
//!
//! 跳过校验重试一次，能成功就是证书问题：
//!
//! ```text
//!   ① 正常校验请求
//!      成功                    → 返回结果
//!      失败且是 https          → ②
//!   ② 跳过校验再请求一次
//!      成功                    → kind = "cert"（已证实：只是证书不被信）
//!      失败                    → kind = "connect" / "timeout"（真连不上）
//! ```
//!
//! 为什么不解析错误字符串：Windows 走 schannel，底层是**系统错误消息**，
//! 中文系统上是中文（"无法建立到信任根颁发机构的证书链"）、英文系统上是英文
//! （"A certificate chain could not be built…"）。按关键词匹配必漏 ——
//! 而漏判的后果正是这个 bug 的原状（用户看到"连不上"却不知道可以继续）。
//!
//! 代价是失败路径多一次请求。只在失败时发生，正常连接一次都不多。
//!
//! ## 安全边界（这是个能被渲染层调用的通用 HTTP 客户端）
//!
//! ```text
//!   ① 只允许 http / https —— 挡掉 file:// 之类的本地读取
//!   ② allow_invalid_cert 只对 https 有意义；http 本来就没有证书
//!   ③ 响应体上限 64 MiB —— 指到一个大文件时不能把内存吃光
//!   ④ 不跟随重定向 —— 与 st_api 同一条纪律：
//!      跟随会把"未授权"变成"拿到一张 HTML 登录页"，错误更难查
//!   ⑤ 超时由调用方给，Rust 侧强制执行
//! ```
//!
//! ④⑤ 与 `st_api::build_client` 保持一致，两处的取舍理由相同。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::commands::base64_encode;
use crate::error::{ShellError, ShellResult};

/// 响应体上限。服务端把卡当不透明 blob 存，5 MB 的 PNG base64 后约 7 MB；
/// 64 MiB 留足余量，同时保证被指到大文件时不会把内存吃光。
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// 超时上限：调用方给得再大也不超过这个（防止一条请求挂死整个界面）
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHttpRequest {
    pub url: String,
    /// GET / POST / PUT / DELETE / PATCH / HEAD
    #[serde(default = "default_method")]
    pub method: String,
    /// 请求头。数组形式（`[[名, 值]]`）而不是对象：同名头可以重复，
    /// 而且不依赖 JSON 对象的键序。
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 请求体。文本即可 —— 同步的 body 就是卡 JSON 原文
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    /// 用户已确认风险、允许跳过证书校验
    #[serde(default)]
    pub allow_invalid_cert: bool,
    /// 只做证书探测、不返回 body 也行 —— 由调用方决定；
    /// 这里始终返回 body（一次请求拿全，避免多一次往返）
    #[serde(default)]
    pub want_base64: bool,
}

fn default_method() -> String {
    "GET".to_string()
}

fn default_timeout() -> u64 {
    6_000
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerHttpResponse {
    pub status: u16,
    /// `content-type` 原值（可能为空串）
    pub content_type: String,
    /// 文本响应体（UTF-8 解码，非文本时为 null）
    pub body_text: Option<String>,
    /// 二进制响应体的 base64（文本响应时为 null）
    pub body_base64: Option<String>,
    pub elapsed_ms: u64,
    /// 这次是否用了"跳过校验"（前端据此知道当前连接靠的是用户确认）
    pub insecure: bool,
}

/// 请求失败的形状。
///
/// 单独一个结构而不是直接抛 `ShellError`：两段探测需要分两次拿到错误来判断，
/// 最后才决定抛哪种。见 `classify`。
struct Failure {
    kind: &'static str,
    message: String,
}

/// 构造一只 client。
///
/// 每次请求新建 —— 同步服务端用的是 Bearer 令牌而不是 cookie，
/// 没有需要跨请求保持的会话状态，不值得为它维护连接池生命周期。
fn build(allow_invalid_cert: bool, timeout_ms: u64) -> ShellResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.min(MAX_TIMEOUT_MS)))
        // 不跟随重定向：与 st_api 同一条纪律（见模块头 ④）
        .redirect(reqwest::redirect::Policy::none());

    if allow_invalid_cert {
        // 只在"用户已确认风险"或"探测第二段"时走到这里。
        // 关掉的是**证书链校验**，不是加密 —— 通道仍然是 TLS 加密的，
        // 只是无法确认对面是谁。这正是自签证书的语义。
        builder = builder.danger_accept_invalid_certs(true);
    }

    builder.build().map_err(|error| ShellError::NetRequestFailed {
        kind: "other".to_string(),
        message: format!("构造 HTTP 客户端失败：{error}"),
        insecure_would_work: false,
    })
}

/// 发一次请求。成功返回响应，失败返回分类后的 `Failure`。
async fn send_once(
    request: &ServerHttpRequest,
    allow_invalid_cert: bool,
) -> Result<ServerHttpResponse, Failure> {
    let started = Instant::now();
    let client = match build(allow_invalid_cert, request.timeout_ms) {
        Ok(client) => client,
        Err(error) => {
            return Err(Failure {
                kind: "other",
                message: error.to_string(),
            })
        }
    };

    let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes()).map_err(
        |_| Failure {
            kind: "other",
            message: format!("不支持的请求方法：{}", request.method),
        },
    )?;

    let mut builder = client.request(method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(error) => {
            /*
             * 超时单独识别：`reqwest` 把超时包在 `is_timeout()` 里，
             * 而它同时也是 `is_connect()` 的一种 —— **先判 timeout**，
             * 否则超时会被说成"连不上"，用户会去查端口。
             */
            let kind = if error.is_timeout() {
                "timeout"
            } else if error.is_connect() {
                "connect"
            } else {
                /*
                 * 走到这里多半是 **TLS 握手失败**（自签证书就是这一类）。
                 * 但**不能据此断言是证书** —— 也可能是协议不匹配。
                 * 所以这里只报"握手/传输层失败"，让 `classify` 用第二段
                 * 探测去证实。
                 */
                "tls_or_transport"
            };
            let message = if kind == "timeout" {
                format!("请求超时（{} ms）", request.timeout_ms.min(MAX_TIMEOUT_MS))
            } else if kind == "connect" {
                "无法连接（地址不通、端口未开、或服务端未启动）".to_string()
            } else {
                /*
                 * ★ 这里**不**说"证书有问题"，只说发生了什么。
                 * 真正的结论由第二段探测给出 —— 猜错方向比不说更糟
                 * （用户会去装证书，而问题可能是协议）。
                 */
                format!("TLS 握手失败：{error}")
            };
            return Err(Failure { kind, message });
        }
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();

    /*
     * 读 body 带上限。
     *
     * `response.bytes()` 会一次性吃完全部内容 —— 被指到一个几百 MB 的文件时
     * 就是内存炸弹。`content_length` 有值时先拦一道，剩下的靠读完再判
     * （chunked 响应没有 content_length）。
     */
    if let Some(length) = response.content_length() {
        if length as usize > MAX_BODY_BYTES {
            return Err(Failure {
                kind: "other",
                message: format!("响应体过大：{length} 字节，上限 {MAX_BODY_BYTES}"),
            });
        }
    }

    let bytes = response.bytes().await.map_err(|error| Failure {
        kind: if error.is_timeout() { "timeout" } else { "other" },
        message: format!("读取响应失败：{error}"),
    })?;

    if bytes.len() > MAX_BODY_BYTES {
        return Err(Failure {
            kind: "other",
            message: format!("响应体过大：{} 字节，上限 {MAX_BODY_BYTES}", bytes.len()),
        });
    }

    /*
     * 文本还是二进制：看 content-type。
     *
     * `want_base64` 可以**强制**二进制（卡面图片那条路要字节，
     * 而有些服务端会把 PNG 标成 application/octet-stream —— 那也算"非文本"，
     * 所以下面这个判定对它是正确的）。反过来，`want_base64 = false` 但
     * content-type 是图片时仍然给 base64 —— 宁可多带一份也不让调用方拿不到。
     */
    let looks_text = content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript");

    let (body_text, body_base64) = if looks_text && !request.want_base64 {
        (Some(String::from_utf8_lossy(&bytes).to_string()), None)
    } else {
        (None, Some(base64_encode(&bytes)))
    };

    Ok(ServerHttpResponse {
        status,
        content_type,
        body_text,
        body_base64,
        elapsed_ms: started.elapsed().as_millis() as u64,
        insecure: allow_invalid_cert,
    })
}

/// 检查 URL 方案。只放行 http / https。
///
/// 不校验 host：同步服务端本来就是用户**自己填的**地址（可以是内网 10.x），
/// 拒绝任意 host 会让这个功能不可用。与 `probe_tcp` 的白名单不是一回事 ——
/// 那条限制是因为"探针接受任意 host 就变成端口扫描器"，而这里的用途
/// 本来就是"连我指定的那台服务器"，用户填什么就连什么。
fn check_scheme(url: &str) -> ShellResult<()> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(());
    }
    Err(ShellError::NetRequestFailed {
        kind: "other".to_string(),
        message: format!("只支持 http 与 https 地址：{url}"),
        insecure_would_work: false,
    })
}

/// 发一次 HTTP 请求（桌面端同步 / 探测用）。
///
/// ## 两段探测（见模块头）
///
/// 第一段失败、且是 https 时，自动用"跳过校验"再试一次：
///
/// ```text
///   第二段成功  → 抛 kind="cert"，insecureWouldWork=true
///                 ⇒ 界面可以说"证书不受信任，确认风险后可继续"
///   第二段也失败 → 抛第一段的 kind（connect / timeout / tls_or_transport）
///                 ⇒ 界面该说"连不上"，不该提证书
/// ```
///
/// 注意第二段的成功结果**不直接返回**：用户还没确认风险，不能偷偷用
/// 不校验证书的通道把数据发出去。它只用来**定性**。
#[command]
pub async fn server_http_request(
    request: ServerHttpRequest,
) -> ShellResult<ServerHttpResponse> {
    check_scheme(&request.url)?;

    let is_https = request.url.trim().to_ascii_lowercase().starts_with("https://");

    /* 用户已确认风险：直接按他的意思走，不做第二段 */
    if request.allow_invalid_cert {
        return send_once(&request, true)
            .await
            .map_err(|failure| ShellError::NetRequestFailed {
                kind: failure.kind.to_string(),
                message: failure.message,
                insecure_would_work: false,
            });
    }

    match send_once(&request, false).await {
        Ok(response) => Ok(response),
        Err(first) => {
            if !is_https {
                return Err(ShellError::NetRequestFailed {
                    kind: first.kind.to_string(),
                    message: first.message,
                    insecure_would_work: false,
                });
            }

            /*
             * 第二段：跳过校验重试，只为定性。
             *
             * 超时就不重试了 —— 再等一个超时没有意义，
             * 而且会让用户觉得"点一下卡了很久"。
             */
            if first.kind == "timeout" {
                return Err(ShellError::NetRequestFailed {
                    kind: first.kind.to_string(),
                    message: first.message,
                    insecure_would_work: false,
                });
            }

            match send_once(&request, true).await {
                Ok(_) => Err(ShellError::NetRequestFailed {
                    kind: "cert".to_string(),
                    message: format!(
                        "这个服务器的证书没通过系统校验（多半是自签证书）。原始错误：{}",
                        first.message
                    ),
                    insecure_would_work: true,
                }),
                Err(_) => Err(ShellError::NetRequestFailed {
                    kind: first.kind.to_string(),
                    message: first.message,
                    insecure_would_work: false,
                }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /*
     * 真实自签证书的端到端验证（2026-11-17）。
     *
     * 这些用例需要本地有一个自签 https 服务（`.verify/tls-probe/serve.mjs`）。
     * **没起服务就跳过** —— 不让单测依赖外部进程，否则别人拉下代码
     * `cargo test` 就红，而他并不知道要先起那个脚本。
     *
     * 为什么值得单独写：整个修复的正确性全压在"两段探测能不能分辨
     * 证书问题与连不上"这一条上。判决逻辑错了，UI 再好也是错的方向。
     */
    use super::*;

    fn req(url: &str, allow_invalid_cert: bool) -> ServerHttpRequest {
        ServerHttpRequest {
            url: url.to_string(),
            method: "GET".to_string(),
            headers: vec![],
            body: None,
            timeout_ms: 4000,
            allow_invalid_cert,
            want_base64: false,
        }
    }

    async fn probe_alive(url: &str) -> bool {
        send_once(&req(url, true), true).await.is_ok()
    }

    #[tokio::test]
    async fn self_signed_cert_is_detected_as_cert() {
        let url = "https://127.0.0.1:8443/api/health";
        if !probe_alive(url).await {
            eprintln!("跳过：本地自签 https 服务没起（.verify/tls-probe/serve.mjs 8443）");
            return;
        }

        /* 不经用户确认：必须报 cert，并说明"跳过校验能成功" */
        let failure = server_http_request(req(url, false))
            .await
            .expect_err("自签证书必须失败");
        match failure {
            ShellError::NetRequestFailed {
                kind,
                insecure_would_work,
                ..
            } => {
                assert_eq!(kind, "cert", "必须判定为证书问题，实际：{kind}");
                assert!(insecure_would_work, "要告诉调用方：确认风险后能连上");
            }
            other => panic!("错误类型不对：{other}"),
        }
    }

    #[tokio::test]
    async fn user_confirmed_cert_succeeds() {
        let url = "https://127.0.0.1:8443/api/health";
        if !probe_alive(url).await {
            eprintln!("跳过：本地自签 https 服务没起");
            return;
        }

        let response = server_http_request(req(url, true))
            .await
            .expect("确认风险后应当能连上");
        assert_eq!(response.status, 200);
        assert!(response.insecure, "要标出这次用了跳过校验");
        let text = response.body_text.expect("JSON 响应应当按文本返回");
        assert!(text.contains("\"status\":\"ok\""), "body 不对：{text}");
    }

    #[tokio::test]
    async fn closed_port_is_connect_not_cert() {
        /*
         * 反向判据：端口没开时说"证书问题"会把用户引去装证书。
         * 这里用一个**几乎肯定没服务**的端口。
         */
        let failure = server_http_request(req("https://127.0.0.1:9/api/health", false))
            .await
            .expect_err("没服务必须失败");
        match failure {
            ShellError::NetRequestFailed {
                kind,
                insecure_would_work,
                ..
            } => {
                assert_ne!(kind, "cert", "端口没开不许报证书，实际：{kind}");
                assert!(!insecure_would_work, "连不上时不许承诺'确认后能连'");
            }
            other => panic!("错误类型不对：{other}"),
        }
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let failure = server_http_request(req("file:///C:/Windows/win.ini", false))
            .await
            .expect_err("file:// 必须被拒");
        assert!(matches!(failure, ShellError::NetRequestFailed { .. }));
    }
}
