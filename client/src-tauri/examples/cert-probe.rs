//! 真实自签证书的判决验证（2026-11-17）。
//!
//! ## 为什么是 example 而不是 `#[cfg(test)]`
//!
//! 本仓库**跑不了 `cargo test`**：release profile 设了 `panic = "abort"`，
//! 而 test harness 需要 unwind —— 上游 `serialize-to-javascript-impl` 之类的
//! proc-macro crate 会直接编译失败（报 `requires None lang_item`）。
//! 那是环境/配置问题，与证书这个功能无关，不该为了跑测试去改 profile
//! （`panic="abort"` 是体积决策，见 Cargo.toml 的注释）。
//!
//! 所以用 example：`cargo run --example cert-probe`，它调的是**同一份**
//! `server_http_request`，跑在同一个 tokio 运行时上。
//!
//! ## 前置
//!
//! ```bash
//! node ../../.verify/tls-probe/serve.mjs 8443    # 自动生成自签证书并起服务
//! cargo run --example cert-probe
//! ```
//!
//! 服务没起就打印"跳过"并返回 0 —— 不让它变成"必须先起服务"的硬依赖。

use tcs_shell_lib::server_http::{server_http_request, ServerHttpRequest};
use tcs_shell_lib::error::ShellError;

fn request(url: &str, allow_invalid_cert: bool) -> ServerHttpRequest {
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

#[tokio::main]
async fn main() {
    /*
     * 地址可从命令行给 —— 那样这个 example 也能用来验用户**自己的**服务器。
     * 不带参数时打本地自签探针。
     */
    let url: String = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "https://127.0.0.1:8443/api/health".to_string());
    let url = url.as_str();

    /* 前置检查：服务在不在（用"跳过校验"探一次，排除证书因素） */
    let alive = server_http_request(request(url, true)).await.is_ok();
    if !alive {
        println!("跳过：本地自签 https 服务没起（node ../../.verify/tls-probe/serve.mjs 8443）");
        return;
    }

    let mut failures = 0;

    /*
     * ① 不经确认 ⇒ 必须报 kind=cert，且承诺"确认后能连"
     *
     * 这条是整个修复的核心：它决定界面敢不敢给"继续"按钮。
     * 判错方向（说成 connect）就会把用户引去查端口。
     */
    match server_http_request(request(url, false)).await {
        Ok(_) => {
            println!("✗ ① 自签证书竟然通过了正常校验");
            failures += 1;
        }
        Err(ShellError::NetRequestFailed {
            kind,
            insecure_would_work,
            message,
        }) => {
            if kind == "cert" && insecure_would_work {
                println!("✓ ① 判定为证书问题，且确认后能连（kind={kind}）");
            } else {
                println!("✗ ① 判定不对：kind={kind} insecureWouldWork={insecure_would_work} msg={message}");
                failures += 1;
            }
        }
        Err(other) => {
            println!("✗ ① 错误类型不对：{other}");
            failures += 1;
        }
    }

    /* ② 用户确认后 ⇒ 真的能连上 200，且标出 insecure */
    match server_http_request(request(url, true)).await {
        Ok(response) => {
            if response.status == 200 && response.insecure {
                let body = response.body_text.unwrap_or_default();
                println!("✓ ② 确认后连上了 200，body={body}");
            } else {
                println!("✗ ② status={} insecure={}", response.status, response.insecure);
                failures += 1;
            }
        }
        Err(error) => {
            println!("✗ ② 确认后仍然失败：{error}");
            failures += 1;
        }
    }

    /*
     * ③ 反向：端口没开时不许报证书。
     *
     * 报 cert 会让用户去装证书，而那台机器上根本没有服务。
     *
     * 只在打本地探针时跑：换成用户自己的地址时，这条没有意义。
     */
    if !url.contains("127.0.0.1") {
        println!("· ③ 跳过（打的是外部地址，不验反向用例）");
    } else {
    match server_http_request(request("https://127.0.0.1:9/api/health", false)).await {
        Err(ShellError::NetRequestFailed { kind, insecure_would_work, .. }) => {
            if kind != "cert" && !insecure_would_work {
                println!("✓ ③ 端口没开报 {kind}（不是 cert，也不承诺能连）");
            } else {
                println!("✗ ③ 端口没开却报 cert / 承诺能连：kind={kind}");
                failures += 1;
            }
        }
        Ok(_) => {
            println!("✗ ③ 端口没开竟然成功");
            failures += 1;
        }
        Err(other) => {
            println!("✗ ③ 错误类型不对：{other}");
            failures += 1;
        }
    }
    }

    /* ④ 安全边界：file:// 必须被拒 */
    match server_http_request(request("file:///C:/Windows/win.ini", false)).await {
        Err(_) => println!("✓ ④ file:// 被拒"),
        Ok(_) => {
            println!("✗ ④ file:// 竟然放行了");
            failures += 1;
        }
    }

    println!();
    if failures == 0 {
        println!("全部通过");
    } else {
        println!("{failures} 项失败");
        std::process::exit(1);
    }
}
