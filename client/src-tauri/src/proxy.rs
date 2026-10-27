//! 本地回环反向代理（v0.1.6 / T14.1 / F2 F3，方案 A）
//!
//! # 它解决什么
//!
//! 把 SillyTavern 的页面嵌进客户端面板里。**不能**用 iframe 直连 + Tauri 自定义
//! 协议两条路，理由见 `release/T141-RISK-ASSESSMENT.md` 的 §1.2：
//! WebView2 的 `WebResourceRequested` 只能返回一个完整响应，既没有 WebSocket
//! upgrade 通路，也不能流式 —— 而 ST 的聊天补全就是 SSE。所以必须起一个真实的
//! TCP 监听器。
//!
//! # 形状（方案 A，需求里的 `/st/*` 前缀已被否掉）
//!
//! ```text
//! iframe.src = http://127.0.0.1:<内核分配>/        ← 根路径就是 ST 的根
//!        ↓ tokio 监听，只绑 127.0.0.1
//!        ↓ 目标 = client-config.json 的 stAddress（仅回环）
//! http://127.0.0.1:8000/<原样路径>
//! ```
//!
//! 前缀方案为什么不可行：ST 的 `public/index.html` 写了 `<base href="/">`，
//! 前端还有硬编码的 `fetch('/api/...')` —— 挂到 `/st/` 下，改 `<base>` 只修好
//! 相对路径，`/api/*` 照样跑出前缀。
//!
//! # 安全边界（三条，比"路径前缀"更硬）
//!
//! 1. **目标不可被调用方指定**：`st_proxy_start` 不接任何目标参数，目标由壳自己
//!    从配置读、再按回环白名单复核。渲染层（含被注入的脚本）无法让它指向别处。
//! 2. **只绑 `127.0.0.1`**：局域网与外部都不可达。
//! 3. **端口由内核分配 + 生命周期跟着面板**：面板关闭即停，进程退出强制回收，
//!    不写死端口、不多开打架、也不留孤儿监听。
//!
//! 论证：**攻击者绕过代理直连 ST 能做的事，走代理一样多，一点不多** ——
//! 这个端口到不了"用户配置的那一个本机 ST 地址"以外的任何主机。
//!
//! # WebSocket 为什么不用 tokio-tungstenite
//!
//! WS 在协议上是"HTTP upgrade 之后的双向字节流"。这里**完全不解析 WS 帧**：
//! 连接开头嗅到 `Upgrade: websocket` 就原样把请求头灌给 ST，之后
//! `copy_bidirectional` 两个方向对拷。半开连接、背压、关闭帧、ping/pong
//! 全部天然正确 —— 不解析帧，关闭语义就不会被代理打断。
//!
//! # 为什么一个连接只服务一个请求
//!
//! WS 嗅探必须在**连接的第一个字节**做（那时 socket 还是裸的）。如果允许
//! keep-alive 复用，就可能出现"第一个请求是普通 GET、第二个才是 upgrade"，
//! 而那时连接已经在 hyper 手里，拿不回裸 socket 了。代价是每个请求一次
//! TCP 连接 —— 本机回环上约几十微秒，页面加载感知不到。
//!
//! # 这个模块不认识 Tauri
//!
//! 命令层（`commands.rs` 的 `st_proxy_*`）负责 AppHandle / 状态 / 读配置；
//! 这里只做"给我一个目标，我起一个代理"。所以它可以被 `cargo test` 直接测，
//! 不需要起窗口。

use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION, HOST, LOCATION, SET_COOKIE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode, Version};
use hyper_util::rt::TokioIo;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::commands::{ST_DEFAULT_ADDRESS, PROBE_ALLOWED_HOSTS};

/// 代理**只绑这个地址**。写死而不是从配置取：靶机可以改，监听面不行。
const BIND_ADDR: &str = "127.0.0.1";

/// 连上游的超时。回环上"没人听"通常是立刻 RST，但 Windows 上被防火墙丢包时
/// 会静默等 —— 卡住整个页面请求比给个明确失败更糟。
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2000);

/// 嗅探 WS 时最多读这么多字节的请求头。ST 的请求头远小于它；
/// 超了就当普通 HTTP 交给 hyper（不至于把请求吞掉）。
const MAX_REQUEST_HEAD: usize = 16 * 1024;

/// 逐跳头（RFC 7230 §6.1）：**不能原样透传**。
///
/// 漏掉这条的症状很隐蔽：普通请求一切正常，只有 WS 握手偶发失败 ——
/// 因为 `Connection` / `Upgrade` 被两端各解释一次。
const HOP_BY_HOP: [&str; 8] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type ProxyBody = BoxBody<Bytes, BoxError>;

// ─────────────────────────────────────────────────────────────
// 地址解析（与 TS 侧 `session/st-address.ts` 逐字同源）
// ─────────────────────────────────────────────────────────────

/// 解析失败的四种原因，**字符串值与 TS 侧 `StAddressFailureReason` 一致**。
///
/// 两侧共用一份 fixture（`test/fixtures/st-address-cases.json`）做对拍：
/// 前端说"合法"、壳说"非法"的组合一旦存在，症状是"设置里存得进去，
/// 面板永远连不上"，而两边各自的单测都是绿的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressFailure {
    Empty,
    Format,
    NotLoopback,
    BadPort,
}

impl AddressFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            AddressFailure::Empty => "empty",
            AddressFailure::Format => "format",
            AddressFailure::NotLoopback => "not-loopback",
            AddressFailure::BadPort => "bad-port",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StTarget {
    /// 归一后的 host（小写、去掉 IPv6 方括号）
    pub host: String,
    pub port: u16,
    /// `host:port`（IPv6 带方括号）—— 用于改写 `Host` 头与写进错误页
    pub authority: String,
}

impl StTarget {
    pub fn base_url(&self) -> String {
        format!("http://{}", self.authority)
    }
}

fn with_brackets(host: &str) -> String {
    // IPv6 字面量在 URL / Host 头里必须带方括号，否则 `::1:8000` 里的最后一段
    // 会被当成端口
    if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// 解析 `host:port`，规则与 TS 的 `parseStAddress` **逐条对应**（见 fixture）。
///
/// 宽容只做"清理"不做"猜测"：允许首尾空白、`http://` 前缀、末尾斜杠；
/// `https://` 明确拒绝（ST 本机就是 http，静默当成 http 等于改了用户语义）。
pub fn parse_st_address(raw: &str) -> Result<StTarget, AddressFailure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AddressFailure::Empty);
    }

    let lowered = trimmed.to_ascii_lowercase();
    if lowered.starts_with("https://") {
        return Err(AddressFailure::Format);
    }
    let mut body = lowered
        .strip_prefix("http://")
        .unwrap_or(lowered.as_str())
        .to_string();
    while body.ends_with('/') {
        body.pop();
    }
    if body.contains('/') {
        return Err(AddressFailure::Format);
    }

    // 从**最后一个**冒号切：`::1:8000` 里前面的是 IPv6 的一部分
    let Some(colon) = body.rfind(':') else {
        return Err(AddressFailure::Format);
    };
    if colon == 0 {
        return Err(AddressFailure::Format);
    }

    let raw_host = body[..colon].trim();
    let raw_port = body[colon + 1..].trim();

    // 去掉 IPv6 的方括号（`[::1]` 是 URL 里的写法，白名单里存的是裸地址）
    let mut unbracketed = raw_host;
    if let Some(rest) = unbracketed.strip_prefix('[') {
        unbracketed = rest;
    }
    if let Some(rest) = unbracketed.strip_suffix(']') {
        unbracketed = rest;
    }
    let host = unbracketed.trim().to_string();

    // 白名单是**逐字比较**，不做 DNS 解析：`localhost.evil.com` / `127.0.0.1.nip.io`
    // 必须被拒；任何"解析后再看是不是回环"的做法都把边界交给了 hosts 文件与 DNS 投毒。
    if !PROBE_ALLOWED_HOSTS.contains(&host.as_str()) {
        return Err(AddressFailure::NotLoopback);
    }

    if raw_port.is_empty() || !raw_port.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AddressFailure::BadPort);
    }
    let Ok(port) = raw_port.parse::<u32>() else {
        return Err(AddressFailure::BadPort);
    };
    if !(1..=65535).contains(&port) {
        return Err(AddressFailure::BadPort);
    }

    let authority = format!("{}:{}", with_brackets(&host), port);
    Ok(StTarget {
        host,
        port: port as u16,
        authority,
    })
}

/// 配置值 → 目标；**空串 = 用默认值，非法值也回落默认值**（与 TS `resolveStAddress` 一致）。
///
/// 为什么非法值不报错：那块功能整体瘫掉的代价远大于"按默认值先跑起来"，
/// 而设置面板会把坏值标红让人改。
pub fn resolve_st_target(configured: Option<&str>) -> StTarget {
    let value = configured.unwrap_or("").trim();
    if !value.is_empty() {
        if let Ok(target) = parse_st_address(value) {
            return target;
        }
    }
    // 默认值自己不合法属于代码 bug，让它在任何一次调用上立刻炸出来
    parse_st_address(ST_DEFAULT_ADDRESS).expect("默认 ST 地址不合法")
}

// ─────────────────────────────────────────────────────────────
// 运行中的代理
// ─────────────────────────────────────────────────────────────

#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    /// 内核分配的端口（`baseUrl` 里也带着它，单列出来是给日志与断言用）
    pub port: u16,
    /// `http://127.0.0.1:<port>` —— 渲染层 iframe 的**唯一**合法来源
    pub base_url: String,
    /// 代理指向的 ST 地址（`host:port`），面板上如实显示
    pub target: String,
}

/// 代理的连接计数（v0.1.6 真机缺陷二的决定性诊断）。
///
/// ## 为什么必须记这个
///
/// 现场是"TCP 探针通（ST 在听）+ iframe 拒绝连接"两件事同时为真。可能的原因有两条，
/// 而且**两条的修法完全不同**：
///
/// | 现象 | 含义 | 修法 |
/// |---|---|---|
/// | `accepted == 0` | 请求**从未到达壳**的监听端口（环境层拦了回环，或被代理工具吞掉） | 只能靠环境白名单/浏览器参数，壳内怎么改都没用 |
/// | `accepted > 0` | 流量到了壳里，问题在**转发链路**（上游、改写、头部） | 去查 `serve_connection` 那段 |
///
/// 没有这个数字，两边都只能靠猜 —— 而"猜"在本项目已经造成过两次误判
/// （F15 把 webview 网络层的问题判成 CORS；缺陷二先把死端口判成代理没起）。
///
/// 计数是**只增不减**的（代理实例生命周期内），所以"打开面板后重载四次"应当
/// 看到它涨到 4 以上（每次导航至少一个文档请求 + 若干资源请求）。
/// 面板自检用的探测路径。
///
/// 代理对它的处理是**直接 204，不转发给 ST**，并单独计数（`probe_hits`）。
///
/// ## 为什么不能只看累计的 `accepted`
///
/// `accepted` 是累计值：面板里的 iframe 每加载一次页面都会产生几十条连接，
/// 一次成功过之后就再也不是 0 了。用"accepted === 0"判断"请求没发出"，
/// 只在**全新代理**上成立一次 —— 之后任何流量都会让这个判据永远为假。
///
/// 2026-10-27 真机复发时就是这么撞上的：为了确认代理本身好吗，我从壳外
/// `curl` 了两次（都 200），于是 accepted 从 0 变 2；如果据此判定，
/// 用户的环境拦截就会被误报成"壳内转发故障"，方向全错。
///
/// 专用路径 + 独立计数把这件事变成**因果的一对一**：这个数字只可能由
/// webview 那次探测产生，多一个少一个都能直接说清。
pub const PROBE_PATH: &str = "/__tcs_probe__";

#[derive(Default)]
pub struct ProxyStats {
    /// 累计 accept 成功的连接数
    accepted: std::sync::atomic::AtomicU64,
    /// 累计收到自检探测的次数（只由 `PROBE_PATH` 产生，不受任何其他流量影响）
    probe_hits: std::sync::atomic::AtomicU64,
    /// 最近一条连接的来源（`ip:port`）；没有连接时为 `None`
    last_peer: std::sync::Mutex<Option<String>>,
    /// 最近一条连接被 accept 的时刻（Unix 毫秒）
    last_accepted_ms: std::sync::atomic::AtomicU64,
}

/// 计数的一次快照（回给渲染层）。
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatsSnapshot {
    pub accepted: u64,
    /// 收到过几次自检探测（`PROBE_PATH`）。渲染层用"探测前后之差"判定流量到没到壳
    pub probe_hits: u64,
    pub last_peer: Option<String>,
    pub last_accepted_ms: Option<u64>,
}

impl ProxyStats {
    fn record_accept(&self, peer: std::net::SocketAddr) {
        use std::sync::atomic::Ordering;
        self.accepted.fetch_add(1, Ordering::Relaxed);
        self.last_accepted_ms.store(now_ms(), Ordering::Relaxed);
        if let Ok(mut slot) = self.last_peer.lock() {
            *slot = Some(peer.to_string());
        }
    }

    fn record_probe(&self) {
        self.probe_hits
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ProxyStatsSnapshot {
        use std::sync::atomic::Ordering;
        let accepted = self.accepted.load(Ordering::Relaxed);
        let ms = self.last_accepted_ms.load(Ordering::Relaxed);
        ProxyStatsSnapshot {
            accepted,
            probe_hits: self.probe_hits.load(Ordering::Relaxed),
            last_peer: self.last_peer.lock().ok().and_then(|slot| slot.clone()),
            last_accepted_ms: if accepted == 0 { None } else { Some(ms) },
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// 代理的运行状态（渲染层刷新面板时用它决定要不要重新起）。
#[derive(Clone, serde::Serialize, serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub running: bool,
    /// accept 循环是否还活着。`running && !alive` = 记录在、端口已释放（最坏的那种分叉）
    pub alive: bool,
    /// 内核分配的端口；未运行时为 null
    pub port: Option<u16>,
    /// `http://127.0.0.1:<port>`；未运行时为 null（渲染层**只能**用它当 iframe src）
    pub base_url: Option<String>,
    /// 代理指向的 ST 地址；未运行时为 null
    pub target: Option<String>,
    /// 连接计数（决定性诊断，见 `ProxyStats`）：`accepted == 0` 说明流量没到壳
    pub stats: ProxyStatsSnapshot,
}

impl ProxyStatus {
    pub fn of(info: Option<(ProxyInfo, bool, ProxyStatsSnapshot)>) -> Self {
        match info {
            Some((info, alive, stats)) => Self {
                running: true,
                alive,
                port: Some(info.port),
                base_url: Some(info.base_url),
                target: Some(info.target),
                stats,
            },
            None => Self {
                running: false,
                alive: false,
                port: None,
                base_url: None,
                target: None,
                stats: ProxyStatsSnapshot::default(),
            },
        }
    }
}

/// 这个停止请求该不该作用在"当前这条记录"上（v0.1.6 生产缺陷追加）。
///
/// **为什么停止要带端口**：`st_proxy_stop` 原先是"take 走现在状态里那一条"。
/// 于是存在一条真实的时序 ——
///
/// ```text
/// 面板关 → stop 请求发出（还没执行）
/// 面板开 → start 执行，新代理占住了状态
/// stop 执行 → take 走的是**新**代理，把它杀了
/// ```
///
/// 结果是"面板开着、代理已经没了"：徽章（走 ST 探针）照样绿，iframe 指向一个
/// 没人听的端口。这正是现场截图的组合。让停止**说出自己要停哪个端口**，
/// 端口对不上就什么都不做 —— 迟到的停止请求于是变成无害的空操作。
pub fn should_stop(requested_port: Option<u16>, current_port: u16) -> bool {
    match requested_port {
        // 不指定端口 = 停当前这条（应用退出用；也是旧调用方的兼容路径）
        None => true,
        Some(port) => port == current_port,
    }
}

struct ProxyCtx {
    target: StTarget,
    /// 本代理自己的源，用于把 ST 的绝对跳转改写回来
    origin: String,
    /// 连接计数：`accepted == 0` 是"流量从未到达壳"的唯一硬证据
    stats: Arc<ProxyStats>,
}

pub struct RunningProxy {
    info: ProxyInfo,
    stats: Arc<ProxyStats>,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningProxy {
    /// 起一个代理。返回时**端口已经 bind 好**（所以 `info.port` 立刻可用）。
    pub async fn start(target: StTarget) -> std::io::Result<Self> {
        let listener = TcpListener::bind(format!("{BIND_ADDR}:0")).await?;
        let port = listener.local_addr()?.port();
        let origin = format!("http://{BIND_ADDR}:{port}");
        let stats = Arc::new(ProxyStats::default());
        let ctx = Arc::new(ProxyCtx {
            target: target.clone(),
            origin: origin.clone(),
            stats: stats.clone(),
        });
        let (stop, mut stop_rx) = tokio::sync::oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stop_rx => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, peer)) = accepted else {
                    // 单个连接 accept 失败（句柄耗尽 / 对端已断）不该让整个代理停摆
                    continue;
                };
                /*
                 * 每 accept 一条就记一次（v0.1.6 真机缺陷二）：
                 * 用户复现"拒绝连接"后，这一行是判断"流量到没到壳"的唯一依据。
                 * 0 条 = 从未到达（环境拦截）；有若干条 = 到了壳里，问题在转发。
                 */
                ctx.stats.record_accept(peer);
                log::info!("ST 代理接受连接：{peer}");
                let ctx = ctx.clone();
                tokio::spawn(async move { serve_connection(stream, ctx).await });
            }
            // listener 在这一行随作用域析构 —— 端口就是在这里释放的。
            // "不留孤儿监听"靠的就是这个顺序：stop → 循环退出 → drop listener。
            log::debug!("ST 代理已停止监听");
        });

        Ok(Self {
            info: ProxyInfo {
                port,
                base_url: origin,
                target: target.authority,
            },
            stats,
            stop,
            task,
        })
    }

    pub fn info(&self) -> ProxyInfo {
        self.info.clone()
    }

    /// 连接计数快照（诊断用；`accepted == 0` 说明流量从未到达壳）
    pub fn stats(&self) -> ProxyStatsSnapshot {
        self.stats.snapshot()
    }

    /// accept 循环还活着吗（v0.1.6 生产缺陷「探针通、代理端口没人听」）。
    ///
    /// **为什么需要它**：`ProxyState` 里存的是"我们以为在跑的代理"，而监听器
    /// 活在另一个 task 里。那个 task 一旦结束（panic、运行时被中断、任何一种
    /// 没人预料到的退出），端口就释放了，但状态里那条记录还在 ——
    /// 于是 `st_proxy_start` 会把一个**死端口**当成"已在运行"返回，
    /// 面板拿着它去设 iframe src，用户看到的就是 Chromium 的
    /// 「127.0.0.1 拒绝连接」，而徽章还写着"已连接"（徽章走的是 ST 探针，
    /// 与代理是两条完全独立的链路 —— 这个组合本身极具误导性）。
    ///
    /// `JoinHandle::is_finished()` 是唯一不用等、没有副作用的判据：
    /// 被 abort、panic、正常返回都为 true。
    pub fn is_alive(&self) -> bool {
        !self.task.is_finished()
    }

    /// 停掉并**等到监听端口真的释放**。
    ///
    /// 只发信号不等的话，调用方紧接着去 bind 同一个端口会偶发失败，
    /// 而那是最难查的一类"时好时坏"。
    pub async fn shutdown(self) {
        let _ = self.stop.send(());
        let _ = self.task.await;
    }
}

// ─────────────────────────────────────────────────────────────
// 连接处理：先嗅 WS，再决定交给谁
// ─────────────────────────────────────────────────────────────

async fn serve_connection(mut stream: TcpStream, ctx: Arc<ProxyCtx>) {
    // 关 Nagle：SSE 逐字出现，40ms 的攒包延迟在这里完全没必要
    let _ = stream.set_nodelay(true);

    let mut buffer = vec![0u8; MAX_REQUEST_HEAD];
    let filled = match read_request_head(&mut stream, &mut buffer).await {
        Ok(filled) => filled,
        Err(error) => {
            log::debug!("ST 代理：读请求头失败：{error}");
            return;
        }
    };
    if filled == 0 {
        // 连上就断（健康检查 / 端口扫描）：正常现象，静默
        return;
    }
    let head = buffer[..filled].to_vec();

    if is_websocket_upgrade(&head) {
        relay_websocket(stream, head, ctx).await;
        return;
    }

    let io = TokioIo::new(PrefixedStream {
        prefix: head,
        offset: 0,
        inner: stream,
    });
    let service = service_fn(move |req: Request<Incoming>| {
        let ctx = ctx.clone();
        async move { Ok::<_, Infallible>(forward(req, ctx).await) }
    });

    /*
     * `keep_alive(false)` 是**正确性要求**，不只是省事：
     *
     * WS 嗅探只发生在连接的第一个字节上。若允许 keep-alive 复用，就可能出现
     * "第一个请求是普通 GET、第二个才是 upgrade" —— 那时连接已经在 hyper 手里，
     * 拿不回裸 socket，upgrade 只能失败。关掉复用让"一个连接 = 一个请求"，
     * 嗅探的前提才始终成立。
     *
     * 顺带解决两个真实缺陷（第一版就在这里红过）：405 与 503 都是我们自己造的
     * 响应，当初靠手写 `connection: close` 让客户端知道该收尾，结果漏掉了
     * `plain_response` 这一支 ⇒ 客户端读响应会一直等到超时（表现为"点了一下没反应"）。
     * 在 server 层统一关掉，就不存在"某个响应忘了加头"这种漏法。
     */
    if let Err(error) = http1::Builder::new()
        .keep_alive(false)
        .serve_connection(io, service)
        .await
    {
        // 浏览器取消请求（切页 / 关面板）会让这里报 IncompleteMessage —— 不是故障
        log::debug!("ST 代理：连接结束：{error}");
    }
}

/// 读请求头直到 `\r\n\r\n`（或填满缓冲）。返回读到的字节数。
///
/// 读到的字节**一个都不能丢**：请求体可能和头在同一个 TCP 段里到达，
/// 所以整段缓冲会原样交给下游（WS 直接转发，HTTP 走 `PrefixedStream` 喂给 hyper）。
async fn read_request_head(stream: &mut TcpStream, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0usize;
    while filled < buffer.len() {
        let read = stream.read(&mut buffer[filled..]).await?;
        if read == 0 {
            break;
        }
        let before = filled;
        filled += read;
        // 边界可能跨两次读，回退 3 字节再找
        let scan_from = before.saturating_sub(3);
        if find_head_end(&buffer[scan_from..filled]).is_some() {
            break;
        }
    }
    Ok(filled)
}

fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

/// 请求头里有没有 `Upgrade: websocket`（只看头部，不看请求体）。
///
/// 大小写不敏感；`Connection: Upgrade` 不单独作为判据 —— 只看 `Upgrade` 头，
/// 因为 WS 的定义就是它。
fn is_websocket_upgrade(head: &[u8]) -> bool {
    let end = find_head_end(head).map_or(head.len(), |index| index + 4);
    let text = String::from_utf8_lossy(&head[..end]);
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("upgrade")
            && value.to_ascii_lowercase().contains("websocket")
        {
            return true;
        }
    }
    false
}

/// WS：请求头原样灌给上游，之后两个方向字节对拷。
///
/// `copy_bidirectional` 免费给了四件事（见模块注释）：半开连接的半关闭、
/// 背压、关闭帧、ping/pong。我们**不解析帧**，所以不会打断任何一条。
async fn relay_websocket(mut client: TcpStream, head: Vec<u8>, ctx: Arc<ProxyCtx>) {
    let mut upstream = match connect_upstream(&ctx).await {
        Ok(stream) => stream,
        Err(error) => {
            // 这时还来得及给一条正经的 HTTP 响应（浏览器会把它当成握手失败的原因）
            let page = error_page(&ctx, &error);
            let bytes = page.into_bytes();
            let header = format!(
                "HTTP/1.1 503 Service Unavailable\r\ncontent-type: text/html; charset=utf-8\r\n\
                 content-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\
                 x-tcs-proxy-error: upstream-unreachable\r\n\r\n",
                bytes.len()
            );
            let _ = client.write_all(header.as_bytes()).await;
            let _ = client.write_all(&bytes).await;
            let _ = client.shutdown().await;
            return;
        }
    };
    let _ = upstream.set_nodelay(true);

    if let Err(error) = upstream.write_all(&head).await {
        log::warn!("ST 代理：WS 请求头没能写给上游：{error}");
        return;
    }

    match tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
        Ok((to_upstream, to_client)) => {
            log::debug!("ST 代理：WS 结束（上行 {to_upstream} B / 下行 {to_client} B）");
        }
        Err(error) => {
            // 对端重置（ST 重启 / 切换页面）是常态，不值得 warn
            log::debug!("ST 代理：WS 中断：{error}");
        }
    }
}

// ─────────────────────────────────────────────────────────────
// HTTP 转发
// ─────────────────────────────────────────────────────────────

async fn forward(req: Request<Incoming>, ctx: Arc<ProxyCtx>) -> Response<ProxyBody> {
    // CONNECT 会把这里变成通用隧道 —— 方案 A 的前提就是"不做通用代理"
    if req.method() == Method::CONNECT {
        return plain_response(StatusCode::METHOD_NOT_ALLOWED, "代理不接受 CONNECT 请求");
    }

    /*
     * 面板自检探测：**不转发给 ST**，直接应答并单独计数。
     *
     * 不转发是刻意的 —— 探测要回答的是"webview 的请求能不能到达壳"，
     * 与 ST 好不好无关。转发了的话，ST 挂掉会让探测失败，两种故障就混在一起了。
     */
    if req.uri().path() == PROBE_PATH {
        ctx.stats.record_probe();
        log::info!("ST 代理收到面板自检探测");
        return plain_response(StatusCode::OK, "tcs-probe-ok");
    }

    let upstream = match connect_upstream(&ctx).await {
        Ok(stream) => stream,
        Err(error) => return error_response(&ctx, &error),
    };
    let _ = upstream.set_nodelay(true);

    let (mut sender, connection) =
        match hyper::client::conn::http1::handshake::<_, Incoming>(TokioIo::new(upstream)).await {
            Ok(pair) => pair,
            Err(error) => {
                return error_response(&ctx, &UpstreamError::protocol(format!("与上游握手失败：{error}")))
            }
        };
    // 连接驱动必须有人 poll，否则响应体永远不会流动（症状是"请求发出去没回来"）
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            log::debug!("ST 代理：上游连接结束：{error}");
        }
    });

    let (parts, body) = req.into_parts();

    // 只取 path+query：绝对形式的请求行（`GET http://别的host/x`）在这里被削成路径，
    // 所以这个代理**不可能**被用来访问另一个主机。
    let path = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let Ok(uri) = path.parse::<hyper::Uri>() else {
        return plain_response(StatusCode::BAD_REQUEST, "请求 URI 不合法");
    };

    let request_drop = hop_by_hop(&parts.headers);
    let mut request_headers = forward_headers(&parts.headers, &request_drop);
    // Host 改写成**目标**：ST 看到的与"浏览器直接访问它"完全一致，
    // 它按 Host 生成的绝对 URL / 重定向也才指向它自己（下面再改写回来）
    if let Ok(value) = HeaderValue::from_str(&ctx.target.authority) {
        request_headers.insert(HOST, value);
    }

    let mut upstream_request = match Request::builder()
        .method(parts.method)
        .uri(uri)
        .version(Version::HTTP_11)
        .body(body)
    {
        Ok(request) => request,
        Err(error) => return plain_response(StatusCode::BAD_REQUEST, &error.to_string()),
    };
    *upstream_request.headers_mut() = request_headers;

    let response = match sender.send_request(upstream_request).await {
        Ok(response) => response,
        Err(error) => {
            return error_response(&ctx, &UpstreamError::protocol(format!("上游没有返回响应：{error}")))
        }
    };

    let (mut response_parts, response_body) = response.into_parts();
    let response_drop = hop_by_hop(&response_parts.headers);
    let mut response_headers = forward_headers(&response_parts.headers, &response_drop);
    rewrite_location(&mut response_headers, &ctx);
    strip_frame_blockers(&mut response_headers);
    relax_cookie_same_site(&mut response_headers);
    // 一个连接一个请求（见模块注释：WS 嗅探必须在连接开头的裸 socket 上做）
    response_headers.insert(CONNECTION, HeaderValue::from_static("close"));
    response_parts.headers = response_headers;

    Response::from_parts(
        response_parts,
        response_body
            .map_err(|error| -> BoxError { Box::new(error) })
            .boxed(),
    )
}

async fn connect_upstream(ctx: &ProxyCtx) -> Result<TcpStream, UpstreamError> {
    let started = Instant::now();
    let connect = TcpStream::connect((ctx.target.host.as_str(), ctx.target.port));
    match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(UpstreamError {
            kind: format!("{:?}", error.kind()),
            elapsed_ms: started.elapsed().as_millis(),
            message: error.to_string(),
        }),
        Err(_) => Err(UpstreamError {
            kind: "TimedOut".to_string(),
            elapsed_ms: started.elapsed().as_millis(),
            message: format!("{} 毫秒内没有回应", CONNECT_TIMEOUT.as_millis()),
        }),
    }
}

struct UpstreamError {
    kind: String,
    elapsed_ms: u128,
    message: String,
}

impl UpstreamError {
    /// 握手 / 发送阶段的失败：连接已经建立，但 HTTP 层没走通
    fn protocol(message: String) -> Self {
        Self {
            kind: "Protocol".to_string(),
            elapsed_ms: 0,
            message,
        }
    }

    fn one_line(&self) -> String {
        format!("{} · {}ms · {}", self.kind, self.elapsed_ms, self.message)
    }

    /// 按错误类型给**不同的**第一条建议 —— 这三类用户要做的事完全不同
    fn hint(&self) -> &'static str {
        match self.kind.as_str() {
            "ConnectionRefused" => {
                "SillyTavern 没在跑，或者端口不对：先启动它（控制台会打印 Listening on …）"
            }
            "TimedOut" => {
                "连接超时：多半是系统代理 / 防火墙 / 安全软件拦住了本机回环连接 —— \
                 ST 自己可能正在跑"
            }
            _ => "连接失败：看下面这行原始错误，它比任何猜测都准",
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 头处理
// ─────────────────────────────────────────────────────────────

/// 逐跳头名单 = 固定八项 + `Connection` 里点名的那几个。
///
/// 后一半最容易被忘掉：`Connection: keep-alive, X-Foo` 意味着 `X-Foo` 也是逐跳的。
/// 漏掉不会立刻报错，而是"某些站点偶发握手失败"。
fn hop_by_hop(headers: &HeaderMap) -> Vec<HeaderName> {
    let mut names: Vec<HeaderName> = HOP_BY_HOP
        .iter()
        .map(|name| HeaderName::from_static(name))
        .collect();
    for value in headers.get_all(CONNECTION) {
        let Ok(text) = value.to_str() else { continue };
        for token in text.split(',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            if let Ok(name) = HeaderName::from_bytes(token.as_bytes()) {
                names.push(name);
            }
        }
    }
    names
}

fn forward_headers(source: &HeaderMap, drop: &[HeaderName]) -> HeaderMap {
    let mut out = HeaderMap::new();
    for (name, value) in source.iter() {
        if drop.contains(name) {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// 把 ST 自己源上的 `Location` 改写成本代理的源。
///
/// 不改写的话，一次 302 就把 iframe 带出了代理（浏览器直连 ST）—— 功能上"能用"，
/// 但下一页就不受代理管了，而这正是我们要它管的地方。
/// 把 ST 下发的 cookie 改成 `SameSite=None; Secure`（**v0.1.6 缺陷三的真因**）。
///
/// ## 不这样做，面板里的 ST 永远初始化不了
///
/// SillyTavern 的会话是 `cookieSession({ sameSite: 'lax', httpOnly: true })`，
/// CSRF token 也存在 session 里（`csrf-sync`，token 与 session 一一绑定）。
///
/// 而面板的结构是：
///
/// ```text
/// 顶层文档   http://tauri.localhost        ← 客户端自己
///   └ iframe http://127.0.0.1:<代理端口>   ← SillyTavern
/// ```
///
/// **两者属于不同的"站点"**（site = scheme + 可注册域；IP 与 `tauri.localhost`
/// 不是同一个站）。`SameSite=Lax` 的语义正是"跨站请求不发送"，于是：
///
/// 1. 浏览器**从不**把 session cookie 带进 iframe 里的任何请求；
/// 2. ST 每个请求都看成全新会话 → `/csrf-token` 发的 token 属于会话 A；
/// 3. 紧接着的 `POST /api/settings/get` 已是会话 B → token 对不上 → **403**；
/// 4. 前端显示「设置无法加载。请稍后再试。」
///
/// 实测（页面上直接打日志，不靠推断）：
///
/// | 组 | 请求里的 cookie | `POST /api/settings/get` |
/// |---|---|---|
/// | 只剥 XFO | 全程 `cookie=NO` | **403** |
/// | 再把 Set-Cookie 改成本函数的效果 | 从 `/csrf-token` 起 `cookie=yes` | **200** |
///
/// ## 为什么可以加 `Secure`
///
/// `SameSite=None` 按规范**必须**同时带 `Secure`，否则浏览器直接丢弃这个 cookie。
/// 而 `Secure` 通常要求 https —— 但**回环地址是可信源**：Chrome/WebView2 允许
/// `http://127.0.0.1` / `http://localhost` 读写 `Secure` cookie。这也是实测过的
/// （上表第二列就是这个组合跑出来的）。
///
/// ## 副作用与它的边界
///
/// 这个改写只在**我们自己的回环代理**里做，目标被 `parse_st_address` 限死为
/// 回环地址（见 `binds_loopback_only` 等测试）。cookie 是按 host 存的、不区分端口，
/// 所以改写后的 cookie 也是用户在浏览器里直连 ST 时用的那一份 —— 语义没变坏
/// （同一个 ST、同一个用户），只是从"仅同站发送"放宽到"跨站也发送"。
/// 这在一个只监听回环、只连一个固定上游的代理里是可接受的。
fn relax_cookie_same_site(headers: &mut HeaderMap) {
    let cookies: Vec<String> = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_string))
        .collect();
    if cookies.is_empty() {
        return;
    }

    let rewritten: Vec<HeaderValue> = cookies
        .iter()
        .filter_map(|cookie| {
            // 先去掉已有的 SameSite / Secure，避免出现 `SameSite=Lax; SameSite=None`
            // 这种既矛盾又依赖解析顺序的组合
            let kept: Vec<&str> = cookie
                .split(';')
                .map(str::trim)
                .filter(|part| {
                    if part.is_empty() {
                        return false;
                    }
                    let lower = part.to_ascii_lowercase();
                    !lower.starts_with("samesite=") && lower != "secure"
                })
                .collect();
            let rebuilt = format!("{}; SameSite=None; Secure", kept.join("; "));
            HeaderValue::from_str(&rebuilt).ok()
        })
        .collect();

    if rewritten.is_empty() {
        return;
    }
    headers.remove(SET_COOKIE);
    for value in rewritten {
        headers.append(SET_COOKIE, value);
    }
}

/// 抹掉"不许被嵌入"的响应头（**v0.1.6 真机缺陷二的真正原因**）。
///
/// ## 为什么必须剥
///
/// 面板是把 ST 放进 iframe 里显示的：父页面是 `http://tauri.localhost`（客户端自己），
/// 子文档是 `http://127.0.0.1:<代理端口>`。**两者不同源**，而 SillyTavern 的响应里带着
///
/// ```text
/// X-Frame-Options: SAMEORIGIN
/// ```
///
/// 浏览器据此判断"这个文档只许被同源页面嵌入"，于是**拒绝渲染**，错误页正是
/// 「`127.0.0.1` refused to connect」（中文界面写「127.0.0.1 拒绝连接」）。
///
/// ## 这条坑为什么骗了我们一整天
///
/// 那句话看起来像"连不上"，于是所有排查都往"连接"方向走：TCP 探针、accept 计数、
/// 环境代理、WFP 过滤……全都在验证**请求有没有到达**。而 `curl` 实测代理
/// 转发 734 837 字节、逐字节相同 —— 请求与响应**都完美**。
///
/// 问题在**响应头里一行策略**：它不影响"能不能连"，只影响"连上之后许不许显示"。
/// 判据选错了维度，于是结论全错。
///
/// 剥掉是安全的：这个响应只会被我们的 iframe 消费，而 XFO 的用意（防第三方站点
/// 嵌别人的页面）在这里恰好是要被豁免的那一种 —— 我们是用户自己的本机客户端。
///
/// ## `frame-ancestors` 一并处理
///
/// 与 XFO 等价、优先级更高的是 CSP 的 `frame-ancestors`。ST 现在没发 CSP，
/// 但它是可配置的东西（插件、反向代理都可能加上），所以这里一并剥 `frame-ancestors`
/// 指令 —— 只剥这一条，其余 CSP 指令原样保留（那些才管注入防护，不该动）。
fn strip_frame_blockers(headers: &mut HeaderMap) {
    headers.remove("x-frame-options");

    let mut updated: Vec<HeaderValue> = Vec::new();
    for value in headers.get_all("content-security-policy").iter() {
        let Ok(text) = value.to_str() else {
            // 非 UTF-8 的 CSP 头（基本不会出现）：保守起见整条丢掉，不让它拦住 iframe
            continue;
        };
        let kept: Vec<&str> = text
            .split(';')
            .map(str::trim)
            .filter(|directive| {
                !directive.is_empty() && !directive.to_ascii_lowercase().starts_with("frame-ancestors")
            })
            .collect();
        if kept.is_empty() {
            continue;
        }
        if let Ok(rebuilt) = HeaderValue::from_str(&kept.join("; ")) {
            updated.push(rebuilt);
        }
    }

    headers.remove("content-security-policy");
    for value in updated {
        headers.append("content-security-policy", value);
    }
}

fn rewrite_location(headers: &mut HeaderMap, ctx: &ProxyCtx) {
    let Some(value) = headers.get(LOCATION) else {
        return;
    };
    let Ok(text) = value.to_str() else { return };
    let lowered = text.to_ascii_lowercase();
    let target_prefix = format!("http://{}", ctx.target.authority.to_ascii_lowercase());
    if !lowered.starts_with(&target_prefix) {
        return;
    }
    let rest = &text[target_prefix.len()..];
    if let Ok(rewritten) = HeaderValue::from_str(&format!("{}{rest}", ctx.origin)) {
        headers.insert(LOCATION, rewritten);
    }
}

// ─────────────────────────────────────────────────────────────
// 响应体
// ─────────────────────────────────────────────────────────────

fn full_body(bytes: impl Into<Bytes>) -> ProxyBody {
    Full::new(bytes.into())
        .map_err(|never| -> BoxError { match never {} })
        .boxed()
}

fn plain_response(status: StatusCode, message: &str) -> Response<ProxyBody> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .header(CONNECTION, HeaderValue::from_static("close"))
        .body(full_body(Bytes::from(message.to_string())))
        .unwrap_or_else(|_| Response::new(full_body(Bytes::new())))
}

fn error_response(ctx: &ProxyCtx, error: &UpstreamError) -> Response<ProxyBody> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header(CONNECTION, HeaderValue::from_static("close"))
        // 错误页的轮询靠这个头判断"还是错误页"，所以它必须存在且不可缓存
        .header("x-tcs-proxy-error", "upstream-unreachable")
        // 错误页用内联脚本轮询，别给它任何外部资源的能力
        .header(
            "content-security-policy",
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        )
        .body(full_body(error_page(ctx, error)))
        .unwrap_or_else(|_| Response::new(full_body(Bytes::new())))
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// ST 没应答时的页面。
///
/// **不是死胡同**：每 2 秒用同源 `fetch('/')` 探一次，一旦应答里没有
/// `x-tcs-proxy-error`（也就是 ST 真的回了），就 `location.reload()` 回到原页面。
/// ST 启动时 webpack 要编译十几到几十秒，这段时间用户看到的是"正在等 ST"，
/// 而不是一块白屏 —— 白屏会被当成"客户端坏了"。
fn error_page(ctx: &ProxyCtx, error: &UpstreamError) -> String {
    let target = escape_html(&ctx.target.authority);
    let detail = escape_html(&error.one_line());
    let hint = escape_html(error.hint());
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>连不上 SillyTavern</title>
<style>
  html,body{{margin:0;height:100%;background:#f6f7f9;color:#1f2328;
    font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
  .wrap{{max-width:520px;margin:0 auto;padding:56px 24px}}
  .badge{{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;
    font-weight:600;color:#9a6700;background:#fff8e5;border:1px solid #f3d9a4}}
  h1{{font-size:17px;margin:14px 0 6px}}
  .target{{margin:0 0 2px;font-family:ui-monospace,Consolas,monospace;font-size:13px}}
  .detail{{margin:6px 0 18px;color:#57606a;font-family:ui-monospace,Consolas,monospace;
    font-size:11.5px;word-break:break-all}}
  ul{{margin:0 0 18px;padding-left:18px;color:#57606a}}
  li{{margin-bottom:4px}}
  .retry{{font-size:12px;color:#57606a}}
  button{{margin-top:12px;padding:6px 14px;border-radius:6px;border:1px solid #d0d7de;
    background:#fff;color:#1f2328;font:inherit;cursor:pointer}}
  button:hover{{background:#f3f4f6}}
</style>
</head>
<body>
<div class="wrap">
  <span class="badge">代理已就绪 · ST 未应答</span>
  <h1>连不上 SillyTavern</h1>
  <p class="target">{target}</p>
  <p class="detail">{detail}</p>
  <ul>
    <li>{hint}</li>
    <li>SillyTavern 正在启动时，它要先跑一遍 webpack 编译（十几秒到几十秒），稍等即可</li>
    <li>地址在「设置 → SillyTavern 地址」里改；本页会自动重试，ST 起来后自动刷新</li>
  </ul>
  <p class="retry">每 2 秒重试一次 · 已重试 <b id="n">0</b> 次</p>
  <button id="retry" type="button">立即重试</button>
</div>
<script>
(function () {{
  var count = 0, timer = null, busy = false;
  function paint() {{ document.getElementById('n').textContent = String(count); }}
  function schedule() {{ timer = setTimeout(ping, 2000); }}
  async function ping() {{
    if (busy) return;
    busy = true; count++; paint();
    try {{
      var response = await fetch('/', {{ cache: 'no-store' }});
      // 同源：头可读。带 x-tcs-proxy-error 说明还是我们自己那张错误页
      if (!response.headers.get('x-tcs-proxy-error')) {{
        busy = false;
        location.reload();
        return;
      }}
    }} catch (error) {{ /* 连代理都没应答：继续等 */ }}
    busy = false;
    schedule();
  }}
  document.getElementById('retry').addEventListener('click', function () {{
    clearTimeout(timer); ping();
  }});
  schedule();
}})();
</script>
</body>
</html>"#
    )
}

// ─────────────────────────────────────────────────────────────
// 前置一个已读缓冲的 TcpStream（把那几个字节还给 hyper）
// ─────────────────────────────────────────────────────────────

struct PrefixedStream {
    prefix: Vec<u8>,
    offset: usize,
    inner: TcpStream,
}

impl AsyncRead for PrefixedStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        if this.offset < this.prefix.len() {
            let remaining = &this.prefix[this.offset..];
            let take = remaining.len().min(buffer.remaining());
            buffer.put_slice(&remaining[..take]);
            this.offset += take;
            return std::task::Poll::Ready(Ok(()));
        }
        std::pin::Pin::new(&mut this.inner).poll_read(context, buffer)
    }
}

impl AsyncWrite for PrefixedStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_write(context, buffer)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_flush(context)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_shutdown(context)
    }
}

#[cfg(test)]
mod tests {
    //! 安全边界**先于**功能测试（需求 T14.1：代理是新增攻击面）。
    //!
    //! 造一个"最小上游"：一条 `TcpListener`，按脚本回固定字节。这样不需要
    //! ST，也不需要 Tauri —— 测的就是代理本身。

    use super::*;

    fn target(port: u16) -> StTarget {
        parse_st_address(&format!("127.0.0.1:{port}")).expect("测试地址必须合法")
    }

    /// 起一个只会"读一次请求头、回一段固定字节、然后关掉"的上游
    async fn one_shot_upstream(body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 4096];
                    let _ = stream.read(&mut buffer).await;
                    let _ = stream.write_all(body.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        port
    }

    /// 起一个"记录收到的请求头"的上游，回 200 + 固定体
    async fn recording_upstream(
        recorder: Arc<tokio::sync::Mutex<Vec<u8>>>,
    ) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let recorder = recorder.clone();
                tokio::spawn(async move {
                    let mut buffer = [0u8; 8192];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    recorder.lock().await.extend_from_slice(&buffer[..read]);
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                        .await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        port
    }

    // ── ⓪ 停止请求要不要生效（v0.1.6 生产缺陷二）────────────

    #[test]
    fn stop_only_affects_the_port_it_names() {
        // 端口一致 → 停（正常关面板）
        assert!(should_stop(Some(51234), 51234));
        // 端口不一致 → 空操作。这是**修复的核心**：迟到的停止请求
        // （用户在关/开之间快速点）不许杀掉后来新起的代理
        assert!(!should_stop(Some(51234), 51235));
        // 不指定端口 → 停当前这条（应用退出用；也是旧调用方的兼容路径）
        assert!(should_stop(None, 51234));
    }

    #[test]
    fn stop_with_zero_port_is_not_a_wildcard() {
        /*
         * `Some(0)` 必须当成"一个具体的、不可能存在的端口"，不能因为
         * "0 看着像空值"就退化成通配。渲染层在没起过代理时 `proxyPort`
         * 就是 0 —— 若它被当成通配，关一次面板会把别人的代理停掉。
         */
        assert!(!should_stop(Some(0), 51234));
    }

    // ── ① 目标只能是回环 ──────────────────────────────────

    #[test]
    fn address_rejects_non_loopback() {
        for raw in [
            "192.168.1.5:8000",
            "8.8.8.8:8000",
            "0.0.0.0:8000",
            "localhost.evil.com:8000",
            "127.0.0.1.nip.io:8000",
            "example.com:8000",
        ] {
            assert_eq!(
                parse_st_address(raw),
                Err(AddressFailure::NotLoopback),
                "{raw} 必须被拒：内嵌代理的目标只能是本机"
            );
        }
    }

    #[test]
    fn address_accepts_loopback_forms() {
        let cases = [
            ("127.0.0.1:8000", "127.0.0.1", 8000, "127.0.0.1:8000"),
            ("LOCALHOST:8001", "localhost", 8001, "localhost:8001"),
            (" http://127.0.0.1:8002/ ", "127.0.0.1", 8002, "127.0.0.1:8002"),
            ("[::1]:8003", "::1", 8003, "[::1]:8003"),
            ("::1:8004", "::1", 8004, "[::1]:8004"),
        ];
        for (raw, host, port, authority) in cases {
            let parsed = parse_st_address(raw).unwrap_or_else(|e| panic!("{raw} 应当合法：{e:?}"));
            assert_eq!((parsed.host.as_str(), parsed.port), (host, port), "{raw}");
            assert_eq!(parsed.authority, authority, "{raw}");
        }
    }

    #[test]
    fn address_reports_reason_like_typescript() {
        assert_eq!(parse_st_address(""), Err(AddressFailure::Empty));
        assert_eq!(parse_st_address("   "), Err(AddressFailure::Empty));
        assert_eq!(
            parse_st_address("https://127.0.0.1:8000"),
            Err(AddressFailure::Format)
        );
        assert_eq!(
            parse_st_address("127.0.0.1:8000/chat"),
            Err(AddressFailure::Format)
        );
        assert_eq!(parse_st_address("127.0.0.1"), Err(AddressFailure::Format));
        assert_eq!(parse_st_address(":8000"), Err(AddressFailure::Format));
        assert_eq!(parse_st_address("127.0.0.1:0"), Err(AddressFailure::BadPort));
        assert_eq!(
            parse_st_address("127.0.0.1:65536"),
            Err(AddressFailure::BadPort)
        );
        assert_eq!(parse_st_address("127.0.0.1:abc"), Err(AddressFailure::BadPort));
        assert_eq!(parse_st_address("127.0.0.1:"), Err(AddressFailure::BadPort));
    }

    /// **两侧对拍**：与 TS 的 `parseStAddress` 共用一份用例表。
    ///
    /// 这份 fixture 是为了钉住一种极难查的分叉：TS 认为合法（设置里存得进去）、
    /// Rust 认为非法（代理永远连不上），而两边各自的单测都是绿的。
    /// 所以规则只用一种写法描述，两个实现都只是它的执行者。
    #[test]
    fn matches_shared_address_fixture() {
        // 相对路径要数满三级：文件在 `client/src-tauri/src/`，fixture 在仓库根
        let raw = include_str!("../../../test/fixtures/st-address-cases.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture 必须是合法 JSON");

        let default = fixture["default"].as_str().expect("fixture 缺 default");
        assert_eq!(
            default, ST_DEFAULT_ADDRESS,
            "默认地址两侧分叉：fixture={default} / Rust={ST_DEFAULT_ADDRESS}"
        );

        let allowed: Vec<String> = fixture["allowedHosts"]
            .as_array()
            .expect("fixture 缺 allowedHosts")
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect();
        let mut rust_allowed: Vec<String> = PROBE_ALLOWED_HOSTS
            .iter()
            .map(|host| host.to_string())
            .collect();
        rust_allowed.sort();
        let mut fixture_allowed = allowed.clone();
        fixture_allowed.sort();
        assert_eq!(
            rust_allowed, fixture_allowed,
            "回环白名单两侧必须逐字一致"
        );

        let mut checked = 0usize;
        for case in fixture["cases"].as_array().expect("fixture 缺 cases") {
            let input = case["input"].as_str().expect("用例缺 input");
            let expected_ok = case["ok"].as_bool().expect("用例缺 ok");
            match parse_st_address(input) {
                Ok(parsed) => {
                    assert!(expected_ok, "Rust 认为「{input}」合法，fixture 说不合法");
                    assert_eq!(
                        parsed.host,
                        case["host"].as_str().unwrap_or_default(),
                        "「{input}」的 host 对不上"
                    );
                    assert_eq!(
                        u64::from(parsed.port),
                        case["port"].as_u64().unwrap_or_default(),
                        "「{input}」的 port 对不上"
                    );
                    // authority 是"写进 Host 头"的形态：IPv6 必须带方括号，
                    // 否则 `::1:8000` 的最后一段会被当成端口
                    if parsed.host.contains(':') {
                        assert!(
                            parsed.authority.starts_with('['),
                            "IPv6 的 authority 必须带方括号：{}",
                            parsed.authority
                        );
                    }
                    assert_eq!(parsed.base_url(), format!("http://{}", parsed.authority));
                }
                Err(failure) => {
                    assert!(!expected_ok, "Rust 认为「{input}」非法（{failure:?}），fixture 说合法");
                    assert_eq!(
                        failure.as_str(),
                        case["reason"].as_str().unwrap_or_default(),
                        "「{input}」的失败原因对不上（TS 侧看的是同一个字符串）"
                    );
                }
            }
            checked += 1;
        }
        assert!(checked >= 20, "用例太少（{checked} 条），对拍等于没做");
    }

    #[test]
    fn resolve_falls_back_to_default_for_bad_config() {
        // 空串与非法值都回落默认；这是"配置被手改坏也不该整块瘫掉"的判据
        for raw in [None, Some(""), Some("  "), Some("192.168.1.5:8000")] {
            let resolved = resolve_st_target(raw);
            assert_eq!(resolved.authority, "127.0.0.1:8000", "配置 {raw:?}");
        }
        // 合法的自定义端口要如实生效（T14.7 改端口全链路的前提）
        assert_eq!(
            resolve_st_target(Some("127.0.0.1:8001")).authority,
            "127.0.0.1:8001"
        );
    }

    // ── ② 只绑 127.0.0.1 ─────────────────────────────────

    #[tokio::test]
    async fn binds_loopback_only() {
        let upstream = one_shot_upstream("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();
        let info = proxy.info();
        assert!(info.base_url.starts_with("http://127.0.0.1:"), "基址必须写死回环");
        assert_eq!(info.target, format!("127.0.0.1:{upstream}"));

        // 端口上能连（回环）
        let connected = TcpStream::connect(("127.0.0.1", info.port)).await;
        assert!(connected.is_ok(), "回环应当能连上自己起的代理");
        drop(connected);

        // 换本机的非回环地址连同一个端口必须失败 —— 这就是"局域网不可达"的判据。
        // 注意：某些机器只有一个地址，拿不到就跳过（不把环境差异写成断言）。
        if let Some(lan) = first_non_loopback_ipv4() {
            let attempt = tokio::time::timeout(
                Duration::from_millis(800),
                TcpStream::connect((lan, info.port)),
            )
            .await;
            let refused = matches!(attempt, Ok(Err(_)) | Err(_));
            assert!(refused, "代理不该在非回环地址 {lan} 上可达");
        }

        proxy.shutdown().await;
    }

    fn first_non_loopback_ipv4() -> Option<std::net::Ipv4Addr> {
        // 不引入 `local-ip-address` 之类的 crate：借 UDP "connect" 一个外部地址
        // 只是为了问内核"你会用哪个源地址出去"，不会真的发包。
        let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        socket.connect("8.8.8.8:80").ok()?;
        match socket.local_addr().ok()? {
            std::net::SocketAddr::V4(addr) if !addr.ip().is_loopback() => Some(*addr.ip()),
            _ => None,
        }
    }

    // ── ③ 停止后端口释放，不留孤儿监听 ───────────────────

    #[tokio::test]
    async fn shutdown_releases_port() {
        let upstream = one_shot_upstream("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();
        let port = proxy.info().port;

        // 起的时候能连
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_ok());

        proxy.shutdown().await;

        // 停之后必须连不上：这就是"不留孤儿监听"的判据。
        // 紧接着重新 bind 同一个端口也必须成功 —— 端口是真释放了，
        // 而不只是"我们不再往里派发"。
        let after = TcpStream::connect(("127.0.0.1", port)).await;
        assert!(after.is_err(), "stop 之后端口不该再接受连接");
        let rebind = TcpListener::bind(format!("127.0.0.1:{port}")).await;
        assert!(rebind.is_ok(), "stop 之后端口应当可以被别人重新 bind");
    }

    // ── ④ 逐跳头剥离 + Host 改写 ─────────────────────────

    #[tokio::test]
    async fn strips_hop_by_hop_and_rewrites_host() {
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder.clone()).await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(
                b"GET /style.css HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\
                  Connection: keep-alive, X-Private\r\nX-Private: 1\r\n\
                  Keep-Alive: timeout=5\r\nUpgrade: h2c\r\nTE: trailers\r\n\
                  X-Keep: yes\r\nAccept: */*\r\n\r\n",
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut response))
            .await
            .unwrap();
        assert!(
            String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"),
            "应当转发上游的 200，实际：{}",
            String::from_utf8_lossy(&response)
        );

        let seen = String::from_utf8_lossy(&recorder.lock().await).to_string();
        let lowered = seen.to_ascii_lowercase();
        assert!(
            lowered.contains(&format!("host: 127.0.0.1:{upstream}")),
            "Host 必须改写成上游目标，实际：{seen}"
        );
        for banned in ["x-private", "keep-alive: timeout", "upgrade: h2c", "te: trailers"] {
            assert!(!lowered.contains(banned), "逐跳头 {banned} 不该被透传：{seen}");
        }
        assert!(lowered.contains("x-keep: yes"), "普通头要保留：{seen}");
        assert!(lowered.contains("accept: */*"), "普通头要保留：{seen}");

        proxy.shutdown().await;
    }

    // ── ⑤ 上游不可达 → 明确错误页（不是白屏、不是挂住）─────

    #[tokio::test]
    async fn unreachable_upstream_returns_error_page() {
        // 先占一个端口再关掉，拿到"确定没人听"的端口号
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = listener.local_addr().unwrap().port();
        drop(listener);

        let proxy = RunningProxy::start(target(dead)).await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();

        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .expect("代理不该挂住：上游不可达必须立刻给出响应");
        let text = String::from_utf8_lossy(&response).to_string();

        assert!(text.starts_with("HTTP/1.1 503"), "应当是 503：{text}");
        assert!(
            text.to_ascii_lowercase().contains("x-tcs-proxy-error: upstream-unreachable"),
            "错误页必须带标记头（错误页自己的轮询靠它判断）：{text}"
        );
        assert!(
            text.contains("连不上 SillyTavern"),
            "错误页要有可读的中文标题：{text}"
        );
        // 轮询脚本是"不白屏"的关键，缺了它就退化成一张静态错误图
        assert!(text.contains("location.reload"), "错误页要能自刷新：{text}");

        proxy.shutdown().await;
    }

    // ── ⑤b 连接计数（v0.1.6 真机缺陷二的决定性诊断）──────

    #[tokio::test]
    async fn accepted_counter_separates_environment_block_from_shell_bug() {
        /*
         * 这个计数器是"流量到没到壳"的唯一硬证据，所以它自己必须先被钉住：
         *   · 刚起好、没人连 → accepted == 0（"环境拦截"的判据）；
         *   · 连一条 → accepted >= 1（"到了壳里"的判据）。
         *
         * 为什么不能靠渲染层的 fetch 判断：那个 fetch 失败正是"被拦"的表现，
         * 拿它下结论是循环论证。
         */
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder).await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let fresh = proxy.stats();
        assert_eq!(fresh.accepted, 0, "刚起好、没人连时必须是 0");
        assert_eq!(fresh.last_peer, None, "没有连接就没有 last_peer");
        assert_eq!(fresh.last_accepted_ms, None);

        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;

        // accept 在连接建立时就记账，不依赖响应是否完成
        let after = proxy.stats();
        assert!(after.accepted >= 1, "连过一条之后 accepted 必须 >= 1，实际 {}", after.accepted);
        let peer = after.last_peer.expect("要有来源地址");
        assert!(peer.starts_with("127.0.0.1:"), "来源应当是回环，实际 {peer}");
        assert!(after.last_accepted_ms.is_some(), "要记下 accept 时刻");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn accepted_counter_is_per_proxy_instance() {
        // 换一个代理实例就要重新计数：否则"这次一条都没进来"会被上一次的数字掩盖
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder).await;
        let first = RunningProxy::start(target(upstream)).await.unwrap();
        TcpStream::connect(("127.0.0.1", first.info().port)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(first.stats().accepted >= 1);
        first.shutdown().await;

        let second = RunningProxy::start(target(upstream)).await.unwrap();
        assert_eq!(second.stats().accepted, 0, "新实例必须从 0 开始");
        second.shutdown().await;
    }

    // ── ⑤c 自检探测：那条"决定性诊断"自己的判据 ────────────

    #[tokio::test]
    async fn probe_path_is_answered_by_shell_and_never_forwarded() {
        /*
         * 探测要回答的是"webview 的请求能不能到达壳"，与 ST 好不好无关。
         *
         * 所以必须验证两件事：
         *   ① 探测请求**不转发**（上游 recorder 里不能出现它）——
         *      转发了的话，ST 挂掉会让探测失败，两种故障就把"环境拦截"和
         *      "ST 没开"混成一个症状；
         *   ② 探测被单独计数（`probe_hits`），与 `accepted` 分开。
         */
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder.clone()).await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(
                format!("GET {PROBE_PATH} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;
        let text = String::from_utf8_lossy(&response);

        assert!(text.starts_with("HTTP/1.1 200"), "探测应当直接 200，实际：{text}");
        assert!(text.contains("tcs-probe-ok"), "要有可辨认的响应体");

        // 上游**一条都没收到**
        let seen = recorder.lock().await.clone();
        assert!(
            seen.is_empty(),
            "探测被转发给上游了 —— ST 挂掉就会把\"环境拦截\"误报成\"壳内故障\"。收到：{}",
            String::from_utf8_lossy(&seen)
        );

        let stats = proxy.stats();
        assert_eq!(stats.probe_hits, 1, "探测要单独计数");
        assert!(stats.accepted >= 1, "探测也是一条连接，accepted 也该涨");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn normal_requests_do_not_touch_probe_counter() {
        /*
         * 反向：普通转发请求不许让 `probe_hits` 涨。
         *
         * 这条防的是"把计数挂在 accept 上"那种偷懒实现 —— 那样 iframe 正常加载
         * 一次就会让 probe_hits 涨几十，判据立刻失真（和用累计 accepted 一样的病）。
         */
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder).await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(b"GET /some/real/path HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await;

        let stats = proxy.stats();
        assert_eq!(stats.probe_hits, 0, "普通请求不许计入 probe_hits");
        assert!(stats.accepted >= 1, "但它仍然是一条 accept");

        proxy.shutdown().await;
    }

    // ── ⑤d 不许被嵌入的响应头必须剥掉（缺陷二的真正原因）──────

    /// 发一个请求、读完整响应（因为 `keep_alive(false)`，读到 EOF 即完）
    async fn request_text(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut buffer = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut buffer)).await;
        String::from_utf8_lossy(&buffer).to_string()
    }

    /// 只取响应头部分（`\r\n\r\n` 之前），转小写便于断言
    fn head_of(response: &str) -> String {
        response
            .split("\r\n\r\n")
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase()
    }

    #[tokio::test]
    async fn x_frame_options_is_stripped_so_the_pane_can_embed_st() {
        /*
         * 现场：iframe 里是「127.0.0.1 refused to connect」，而代理转发
         * 734 837 字节、与直连逐字节相同。请求与响应都没问题 ——
         * 问题在这一行响应头：
         *
         *     X-Frame-Options: SAMEORIGIN
         *
         * 父页面是 `http://tauri.localhost`，子文档是 `http://127.0.0.1:<port>`，
         * **不同源** ⇒ 浏览器拒绝渲染。它不影响"能不能连"，只影响"连上之后许不许显示"，
         * 所以所有往"连接"方向做的排查（TCP 探针、accept 计数、系统代理、WFP）
         * 全都是对的、也都是无关的。
         */
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\n\
             content-type: text/html; charset=UTF-8\r\n\
             x-frame-options: SAMEORIGIN\r\n\
             content-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let response = request_text(proxy.info().port, "/").await;
        let head = head_of(&response);

        assert!(
            !head.contains("x-frame-options"),
            "X-Frame-Options 必须剥掉，否则面板永远显示「127.0.0.1 拒绝连接」。实际头：\n{head}"
        );
        // 其余头必须原样保留 —— 剥的是策略，不是内容协商
        assert!(head.contains("content-type: text/html"), "content-type 不该被动");
        assert!(response.ends_with("ok"), "响应体必须完整");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn csp_frame_ancestors_is_stripped_but_other_directives_survive() {
        /*
         * 与 XFO 等价、优先级更高的是 CSP 的 `frame-ancestors`。
         * 只剥这一条指令：其余指令管的是注入防护，不该一起扔。
         */
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\n\
             content-type: text/html\r\n\
             content-security-policy: default-src 'self'; frame-ancestors 'none'; img-src *\r\n\
             content-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let head = head_of(&request_text(proxy.info().port, "/").await);

        assert!(!head.contains("frame-ancestors"), "frame-ancestors 必须剥掉：\n{head}");
        assert!(head.contains("default-src"), "其余 CSP 指令要保留：\n{head}");
        assert!(head.contains("img-src"), "其余 CSP 指令要保留：\n{head}");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn stripping_frame_blockers_does_not_invent_headers() {
        // 上游本来就没发这两个头 → 代理后也不该凭空多出空头
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let head = head_of(&request_text(proxy.info().port, "/").await);
        assert!(!head.contains("x-frame-options"));
        assert!(!head.contains("content-security-policy"));

        proxy.shutdown().await;
    }

    // ── ⑤e 会话 cookie 必须跨站可发（缺陷三的真因）──────────

    #[tokio::test]
    async fn session_cookie_becomes_cross_site_sendable() {
        /*
         * ST 的会话是 `cookieSession({ sameSite: 'lax' })`。面板的 iframe 与顶层文档
         * （`http://tauri.localhost`）**不同站**，Lax 的语义就是"跨站不发送" ⇒
         * 浏览器从不带 session cookie ⇒ ST 每个请求都是新会话 ⇒
         * `/csrf-token` 的 token 与 `POST /api/settings/get` 的会话对不上 ⇒ 403
         * ⇒ 页面显示「设置无法加载」。
         *
         * 实测（diag-proxy 日志）：只剥 XFO 时 `POST /api/settings/get cookie=NO -> 403`；
         * 把 Set-Cookie 改成 SameSite=None; Secure 后同一请求 `cookie=yes -> 200`。
         */
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\n\
             content-type: application/json\r\n\
             set-cookie: st_session=abc123; path=/; HttpOnly; SameSite=Lax\r\n\
             content-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let head = head_of(&request_text(proxy.info().port, "/").await);

        assert!(head.contains("set-cookie:"), "cookie 不能被扔掉：\n{head}");
        assert!(head.contains("st_session=abc123"), "cookie 的值必须原样保留：\n{head}");
        assert!(head.contains("samesite=none"), "必须放宽成 SameSite=None：\n{head}");
        assert!(head.contains("secure"), "SameSite=None 必须同时带 Secure，否则浏览器丢弃：\n{head}");
        // 旧的 Lax 必须被去掉，不能出现两个相互矛盾的 SameSite
        assert!(!head.contains("samesite=lax"), "旧的 SameSite 没清掉：\n{head}");
        // 其余属性要留着（Path / HttpOnly 丢了会让 cookie 作用域变宽或可被脚本读）
        assert!(head.contains("path=/"), "path 不该被动");
        assert!(head.contains("httponly"), "httponly 不该被动");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn multiple_set_cookie_headers_are_all_kept() {
        /*
         * 中途踩过的坑：`HeaderMap::insert` 会**覆盖**同名头。
         * 用 insert 改写 Set-Cookie 时，上游下发两条 cookie 只会留下最后一条 ——
         * 症状是"登录态时有时无"，极难查。所以这条盯的是"两条都在"。
         */
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\n\
             set-cookie: first=1; path=/; SameSite=Lax\r\n\
             set-cookie: second=2; path=/; SameSite=Strict\r\n\
             content-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let head = head_of(&request_text(proxy.info().port, "/").await);
        let count = head.matches("set-cookie:").count();
        assert_eq!(count, 2, "两条 Set-Cookie 都要在，实际 {count} 条：\n{head}");
        assert!(head.contains("first=1"), "第一条丢了：\n{head}");
        assert!(head.contains("second=2"), "第二条丢了：\n{head}");
        assert!(!head.contains("samesite=lax") && !head.contains("samesite=strict"), "旧值没清：\n{head}");

        proxy.shutdown().await;
    }

    #[tokio::test]
    async fn no_cookie_header_means_no_cookie_invented() {
        // 上游没发 cookie → 代理不许凭空造一个（否则会污染用户的浏览器存储）
        let upstream = one_shot_upstream(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\n\r\nok",
        )
        .await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();

        let head = head_of(&request_text(proxy.info().port, "/").await);
        assert!(!head.contains("set-cookie"), "不该凭空出现 Set-Cookie：\n{head}");

        proxy.shutdown().await;
    }

    // ── ⑥ 流式：不整包缓冲 ──────────────────────────────

    #[tokio::test]
    async fn streams_body_without_buffering() {
        // 上游先发头 + 第一段，停 300ms 再发第二段。
        // 如果代理整包缓冲，第一段要等到第二段之后才到 —— 那就抓到缺陷了。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer).await;
            let _ = stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\
                      transfer-encoding: chunked\r\n\r\n",
                )
                .await;
            let _ = stream.write_all(b"6\r\ndata:1\r\n").await;
            let _ = stream.flush().await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            let _ = stream.write_all(b"6\r\ndata:2\r\n0\r\n\r\n").await;
            let _ = stream.shutdown().await;
        });

        let proxy = RunningProxy::start(target(port)).await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream.write_all(b"GET /api/stream HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();

        let started = Instant::now();
        let mut first = [0u8; 1024];
        let read = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut first))
            .await
            .expect("首片应当很快到")
            .unwrap();
        let first_chunk_ms = started.elapsed().as_millis();
        let head_text = String::from_utf8_lossy(&first[..read]).to_string();
        assert!(
            head_text.contains("200") || head_text.contains("data:1"),
            "首片应当带着头或第一段数据：{head_text}"
        );
        assert!(
            first_chunk_ms < 250,
            "首片必须在 250ms 内到达（整包缓冲会让它等到 300ms 之后），实际 {first_chunk_ms}ms"
        );

        proxy.shutdown().await;
    }

    // ── ⑦ WS：字节透传（含 101 + 双向回显）──────────────

    #[tokio::test]
    async fn websocket_is_byte_transparent() {
        // 伪造上游：认出 upgrade 就回 101，之后把收到的东西原样写回（回显）
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).await.unwrap();
            let head = String::from_utf8_lossy(&buffer[..read]).to_string();
            assert!(
                head.to_ascii_lowercase().contains("upgrade: websocket"),
                "上游应当收到原始 upgrade 头"
            );
            let _ = stream
                .write_all(
                    b"HTTP/1.1 101 Switching Protocols\r\n\
                      upgrade: websocket\r\nconnection: Upgrade\r\n\
                      sec-websocket-accept: tcs-test\r\n\r\n",
                )
                .await;
            // 逐字节回显（不解析帧）
            let mut chunk = [0u8; 1024];
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if stream.write_all(&chunk[..n]).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let proxy = RunningProxy::start(target(port)).await.unwrap();
        let mut client = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        client
            .write_all(
                b"GET /api/websocket HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\n\
                  Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
                  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            )
            .await
            .unwrap();

        let mut handshake = [0u8; 1024];
        let read = tokio::time::timeout(Duration::from_secs(3), client.read(&mut handshake))
            .await
            .expect("握手不该超时")
            .unwrap();
        let text = String::from_utf8_lossy(&handshake[..read]).to_string();
        assert!(text.starts_with("HTTP/1.1 101"), "应当是 101：{text}");
        assert!(
            text.to_ascii_lowercase().contains("sec-websocket-accept: tcs-test"),
            "ST 的握手响应必须原样到浏览器（代理不重新计算 accept 值）：{text}"
        );

        // 双向透传：发一段"像 WS 帧"的字节，应当原样回来
        let payload: &[u8] = &[0x81, 0x05, b'h', b'e', b'l', b'l', b'o'];
        client.write_all(payload).await.unwrap();
        let mut echoed = [0u8; 16];
        let read = tokio::time::timeout(Duration::from_secs(3), client.read(&mut echoed))
            .await
            .expect("回显不该超时")
            .unwrap();
        assert_eq!(&echoed[..read], payload, "字节必须逐字节透传（不解析帧）");

        proxy.shutdown().await;
    }

    // ── ⑧ CONNECT 必须被拒（否则代理成通用隧道）──────────

    #[tokio::test]
    async fn connect_method_is_rejected() {
        let upstream = one_shot_upstream("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok").await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut response))
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&response).to_string();
        assert!(text.starts_with("HTTP/1.1 405"), "CONNECT 必须 405：{text}");
        proxy.shutdown().await;
    }

    // ── ⑨ 绝对形式请求行不能指定主机（防正向代理）────────

    #[tokio::test]
    async fn absolute_form_request_cannot_redirect_target() {
        let recorder = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let upstream = recording_upstream(recorder.clone()).await;
        let proxy = RunningProxy::start(target(upstream)).await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(b"GET http://evil.example/x HTTP/1.1\r\nHost: evil.example\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut response))
            .await
            .unwrap();

        let seen = String::from_utf8_lossy(&recorder.lock().await).to_string();
        // 请求行必须被削成 `/x`，Host 必须被改写成真实目标
        assert!(
            seen.starts_with("GET /x "),
            "绝对形式请求行只能取路径，实际：{seen}"
        );
        assert!(
            !seen.to_ascii_lowercase().contains("evil.example"),
            "Host 不能被调用方指定：{seen}"
        );
        proxy.shutdown().await;
    }

    // ── ⑨' 真端到端：Node 写的假 ST + 本代理 ───────────────
    //
    // 前面那些用例的"上游"是 tokio 现搓的字节桩，只证明"按我的理解转发正确"。
    // 这一条换成 `scripts/fake-st.mjs` —— 一个真的 Node http 服务（页面 + WS + SSE），
    // 于是"页面能加载 / Host 被改写 / WS 能握手"是同一个进程边界上过出来的，
    // 而不是我用同一套假设两头对齐。
    //
    // 没有 node 就跳过（不把"环境没有 node"写成失败）。
    #[tokio::test]
    async fn proxies_real_fake_st_from_node() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let script = root.join("scripts").join("fake-st.mjs");
        if !script.exists() {
            eprintln!("跳过：没找到 {}", script.display());
            return;
        }
        let node = std::env::var("TCS_NODE").unwrap_or_else(|_| "node".to_string());
        let mut child = match Command::new(&node)
            .arg(&script)
            .args(["--port", "0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                eprintln!("跳过：起不了 node（{error}）。可用 TCS_NODE 指定路径");
                return;
            }
        };

        // 假 ST 把实际端口打在 stdout 第一行
        let stdout = child.stdout.take().expect("stdout 被重定向过");
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let port = line
            .rsplit_once(':')
            .and_then(|(_, tail)| tail.split_whitespace().next())
            .and_then(|value| value.parse::<u16>().ok());

        let Some(port) = port else {
            let _ = child.kill();
            eprintln!("跳过：假 ST 没报出端口（{line:?}）");
            return;
        };

        let proxy = RunningProxy::start(target(port)).await.unwrap();
        let mut stream = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: placeholder\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .expect("页面加载不该超时");
        let text = String::from_utf8_lossy(&response).to_string();
        assert!(text.starts_with("HTTP/1.1 200"), "页面应当 200：{text}");
        assert!(
            text.contains("Fake SillyTavern"),
            "应当拿到假 ST 的页面（不是本代理的错误页）"
        );
        // 代理自己的标记头不该出现在正常响应里
        assert!(!text.to_ascii_lowercase().contains("x-tcs-proxy-error"));

        // Host 回显：代理必须把 Host 改写成 ST 的 host:port
        let mut echo = TcpStream::connect(("127.0.0.1", proxy.info().port))
            .await
            .unwrap();
        echo.write_all(b"GET /api/echo HTTP/1.1\r\nHost: placeholder\r\n\r\n")
            .await
            .unwrap();
        let mut echoed = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), echo.read_to_end(&mut echoed))
            .await
            .expect("echo 不该超时");
        let echoed_text = String::from_utf8_lossy(&echoed).to_string();
        assert!(
            echoed_text.contains(&format!("127.0.0.1:{port}")),
            "上游应当看到 ST 自己的 host:port，实际：{echoed_text}"
        );

        proxy.shutdown().await;
        let _ = child.kill();
        let _ = child.wait();
    }

    // ── ⑩ 头处理的单元判据 ──────────────────────────────

    #[test]
    fn connection_header_tokens_are_hop_by_hop() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, X-Foo"));
        let names = hop_by_hop(&headers);
        assert!(names.contains(&HeaderName::from_static("x-foo")));
        assert!(names.contains(&HeaderName::from_static("connection")));
        assert!(names.contains(&HeaderName::from_static("transfer-encoding")));
        assert!(!names.contains(&HeaderName::from_static("x-keep")));
    }

    #[test]
    fn websocket_sniffing_only_looks_at_header() {
        assert!(is_websocket_upgrade(
            b"GET /x HTTP/1.1\r\nUpgrade: WebSocket\r\n\r\n"
        ));
        // 请求体里出现 "upgrade: websocket" 不算（只看头部）
        assert!(!is_websocket_upgrade(
            b"POST /x HTTP/1.1\r\ncontent-length: 20\r\n\r\nupgrade: websocket"
        ));
        assert!(!is_websocket_upgrade(b"GET /x HTTP/1.1\r\nHost: y\r\n\r\n"));
    }

    #[test]
    fn location_is_rewritten_into_proxy_origin() {
        let ctx = ProxyCtx {
            target: target(8000),
            origin: "http://127.0.0.1:5555".to_string(),
            stats: Arc::new(ProxyStats::default()),
        };
        let mut headers = HeaderMap::new();
        headers.insert(LOCATION, HeaderValue::from_static("http://127.0.0.1:8000/login"));
        rewrite_location(&mut headers, &ctx);
        assert_eq!(
            headers.get(LOCATION).unwrap().to_str().unwrap(),
            "http://127.0.0.1:5555/login"
        );

        // 外部跳转不动它（那不是我们的源）
        let mut other = HeaderMap::new();
        other.insert(LOCATION, HeaderValue::from_static("https://example.com/x"));
        rewrite_location(&mut other, &ctx);
        assert_eq!(
            other.get(LOCATION).unwrap().to_str().unwrap(),
            "https://example.com/x"
        );
    }

    #[test]
    fn error_page_escapes_and_polls() {
        let ctx = ProxyCtx {
            target: target(8000),
            origin: "http://127.0.0.1:5555".to_string(),
            stats: Arc::new(ProxyStats::default()),
        };
        let page = error_page(
            &ctx,
            &UpstreamError {
                kind: "ConnectionRefused".to_string(),
                elapsed_ms: 3,
                message: "<script>alert(1)</script>".to_string(),
            },
        );
        assert!(page.contains("127.0.0.1:8000"));
        assert!(!page.contains("<script>alert(1)</script>"), "错误文本必须转义");
        assert!(page.contains("&lt;script&gt;"));
        assert!(page.contains("x-tcs-proxy-error"), "轮询脚本要认得标记头");
    }
}
