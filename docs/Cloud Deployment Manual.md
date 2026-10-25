# 云部署手册（Cloud Deployment Manual）

把 Tavern Card Studio 服务端放到一台能被公网（或其它网络）访问的机器上，
并在它前面架一个反向代理负责 HTTPS。

> **维护约定：本文件面向使用者，随仓库发布。**
> 任何影响部署行为的改动 —— 默认端口、`trustProxy` 语义、`/api/token` 的来源判定、
> 限速规则、上传体积上限、`tls.*` 配置形状、反代相关响应头 —— 都必须同步更新本文件，
> 与代码在同一次提交里。**不要等到发版再补**：反代配置写错的症状（见 §3）全都是
> "服务能用但行为诡异"，用户不会想到去翻更新日志。

---

## 0. 先做两个决定

### 0.1 谁来终止 TLS

| 拓扑 | 谁持有证书 | 业务侧 `tls.mode` | 适用 |
|---|---|---|---|
| **A. 反代终止**（本手册主线，推荐） | 反代（Caddy / nginx / Apache） | `off` | 有域名、想自动续期、想统一入口 |
| B. 服务端自持 | 服务端自己 | `selfsigned` 或 `custom` | 只有 IP、企业内网 CA、不方便加代理 |

拓扑 A 里 `tls.mode=off` 是**正确配置，不是疏忽**：明文只存在于
`代理 → 127.0.0.1:8730` 这一跳，从不经过网卡。**但前提是 `host` 必须是回环地址** ——
`host: "0.0.0.0"` + `tls.mode: "off"` 等于把明文接口直接挂到网上（面板会把这条警告升级成
「公网暴露风险」）。

### 0.2 用哪个反向代理

**三选一即可。** 下面三份配置功能等价，选你机器上已有的那个：

| 方案 | 一句话 | 适合 |
|---|---|---|
| [Caddy](#21-caddy自动证书最省事) | 自动申请 + 自动续期 Let's Encrypt，配置十行 | 新机器、想少操心 |
| [nginx](#22-nginx--certbot) | 最常见，资料最多 | 已有 nginx、或公司有统一模板 |
| [Apache](#23-apache双-vhost) | 很多企业标准镜像自带 | 已有 Apache / 现有站点就在 Apache 上 |

> **不要同时挂两层代理**（比如 Caddy 转 nginx 再转服务端）。每多一跳，`X-Forwarded-For`
> 就多一段，而 `trustProxy` 只登记"直连服务端的那一跳"。两层都把对方登记进去会让
> 信任链变长，最左那段（客户端自己写的）就分不清真假了 —— 见 §3.3。

---

## 1. 服务端准备（三种代理都一样）

### 1.1 安装与目录

管理员权限运行 MSI（非管理员会话里 `msiexec /qn` 必定失败，这是设计如此）：

```powershell
msiexec /i TavernCardStudioServer-0.1.3.msi /qb
sc.exe query TavernCardStudioServer     # STATE 应为 RUNNING
```

安装后的位置（卸载不删数据）：

| 内容 | 路径 |
|---|---|
| 程序 + 自带 node | `C:\Program Files\Tavern Card Studio Server\` |
| 配置 | `C:\ProgramData\TavernCardStudio\config.json` |
| 数据（卡片 / 仓库 / `state.db`） | `C:\ProgramData\TavernCardStudio\store\` |
| 自签证书（仅拓扑 B） | `C:\ProgramData\TavernCardStudio\store\tls\` |
| 旧证书备份 | `C:\ProgramData\TavernCardStudio\store\certs-backup\` |
| 日志 | `C:\ProgramData\TavernCardStudio\logs\` |

### 1.2 让业务只听回环

```jsonc
{
  "port": 8730,                 // API（数据面）
  "controlPort": 8731,          // 管理面板（控制面）
  "host": "127.0.0.1",          // ← 反代是唯一入口，业务端口不出网卡
  "controlHost": "127.0.0.1",   // 面板也不必对外
  "tls": { "mode": "off" },     // 拓扑 A
  "trustProxy": ["127.0.0.1"],  // ← 必填，见 §3
  "auth": { "require": true, "registerMode": "admin-only" }
}
```

改完重启：`sc.exe stop TavernCardStudioServer` → `sc.exe start TavernCardStudioServer`。

> 也可以从面板（`http://127.0.0.1:8731` → 参数配置）改，多数项保存即生效。
> 但 `host` / `port` / `dataDir` 这类进程级参数要重启 worker，面板会说明。

### 1.3 第一个管理员

`registerMode` 决定"第一个账户从哪来"：

| 值 | 谁能注册 | 备注 |
|---|---|---|
| `closed`（默认） | 谁都不能，只能用命令行建 | 单人或固定小团队 |
| `admin-only` | 只有已登录管理员能加人 | **公网推荐** |
| `open` | 任何人 | 公网不建议；非回环监听时启动日志会警告 |

`admin-only` 的鸡生蛋问题用命令行解决（不依赖 HTTP，因此不受注册开关影响）：

```powershell
cd "C:\Program Files\Tavern Card Studio Server"
$tcs = ".\node.exe", ".\app\server\dist\index.js",
       "--config", "C:\ProgramData\TavernCardStudio\config.json"
& $tcs user add alice
```

- **第一个账户自动成为管理员**；
- 密码最短 8 字符，**只从标准输入读**（不走命令行参数，不进 shell 历史）；
- `--config` 不能省：省掉会按当前目录另算数据目录，等于在旁边新建一个空库。

完整命令见 [`server-cmd.md`](server-cmd.md)。

### 1.4 防火墙：只放通 80 / 443

```powershell
# Windows（云厂商安全组也要配，两层都要）
New-NetFirewallRule -DisplayName "TCS HTTP"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow
New-NetFirewallRule -DisplayName "TCS HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
# 业务端口明确拒绝从公网进入（它们只该被本机代理访问）
New-NetFirewallRule -DisplayName "TCS API loopback only" -Direction Inbound -Protocol TCP -LocalPort 8730,8731,8443 -Action Block
```

```bash
# Linux
ufw allow 80/tcp && ufw allow 443/tcp && ufw enable
```

在外网机器上自查（应当超时）：`curl -m 5 http://<公网IP>:8730/api/health`

---

## 2. 反向代理配置

三份配置统一约定：

- 域名占位 `cards.example.com`，换成你自己的；
- 上游固定 `127.0.0.1:8730`（API）；
- **都要显式挡掉 `/api/token`**，理由见 §3.2 事故二；
- 请求体上限放到 **40 MiB**（服务端 `maxUploadBytes` 默认 32 MiB，代理必须略大，
  否则客户端看到 413 而服务端日志里什么都没有）。

### 2.1 Caddy（自动证书，最省事）

```caddyfile
# /etc/caddy/Caddyfile
cards.example.com {
    encode zstd gzip

    # 全权令牌不得出本机。服务端自己也会按来源 IP 拒（配好 trustProxy 之后），
    # 这里再挡一道是纵深防御：万一 trustProxy 配错也不至于把令牌暴露到公网。
    @token path /api/token
    respond @token 403

    reverse_proxy 127.0.0.1:8730 {
        # 显式声明上游是 http（Caddy 默认会带 X-Forwarded-For / -Proto）
        header_up X-Forwarded-Proto {scheme}
    }
}
```

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

Caddy 自动申请并续期证书、自动做 HTTP→HTTPS 跳转。**80 端口必须放通**（ACME 校验用）。

### 2.2 nginx + certbot

```nginx
# /etc/nginx/conf.d/cards.conf
server {
    listen 80;
    server_name cards.example.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;                      # nginx < 1.25.1 请改成 `listen 443 ssl http2;`
    server_name cards.example.com;

    ssl_certificate     /etc/letsencrypt/live/cards.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cards.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # 全权令牌不得出本机（第二道闸，见 §3.2）
    location = /api/token { return 403; }

    client_max_body_size 40m;      # nginx 默认只有 1m，不改则任何真实角色卡都 413
    proxy_read_timeout   120s;     # 默认 60s，慢链路上传 32 MiB 会超时

    location / {
        proxy_pass         http://127.0.0.1:8730;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;  # ← 服务端靠这个还原来源
        proxy_set_header   X-Forwarded-Proto $scheme;                     # 可选（服务端当前不读）
    }
}
```

```bash
certbot --webroot -w /var/www/certbot -d cards.example.com
nginx -t && systemctl reload nginx
```

### 2.3 Apache（双 vhost）

Apache 的企业镜像常见，但它的默认行为与 nginx 差得比较多，**三个地方必须显式配**：
`ProxyPreserveHost`、`X-Forwarded-For`（默认已加但要知道从哪来）、以及 `/api/token` 的拒绝规则。

#### 2.3.1 启用模块

```bash
# Debian / Ubuntu
a2enmod ssl proxy proxy_http headers rewrite

# RHEL / Alma / Rocky：在 /etc/httpd/conf.modules.d/ 下确认这几行未被注释
# LoadModule ssl_module modules/mod_ssl.so
# LoadModule proxy_module modules/mod_proxy.so
# LoadModule proxy_http_module modules/mod_proxy_http.so
# LoadModule headers_module modules/mod_headers.so
# LoadModule rewrite_module modules/mod_rewrite.so
```

Windows 版 Apache 用 `LoadModule` 同样五条，`httpd.conf` 里改完 `httpd -t` 再重启。

#### 2.3.2 `:80` —— ACME 校验 + 跳 HTTPS

`/etc/apache2/sites-available/cards-80.conf`：

```apache
<VirtualHost *:80>
    ServerName cards.example.com

    # ACME HTTP-01 校验目录：certbot 往这里写文件，必须能公网读到。
    # 这一条**不能**被下面的跳转吃掉，否则签证书永远失败。
    Alias /.well-known/acme-challenge/ /var/www/certbot/.well-known/acme-challenge/
    <Directory "/var/www/certbot/.well-known/acme-challenge">
        Require all granted
    </Directory>

    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [END,NE,R=permanent]
</VirtualHost>
```

#### 2.3.3 `:443` —— 终止 TLS + 反代

`/etc/apache2/sites-available/cards-443.conf`：

```apache
<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName cards.example.com

    # ── TLS ──────────────────────────────────────────────
    SSLEngine on
    SSLCertificateFile    /etc/letsencrypt/live/cards.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/cards.example.com/privkey.pem
    SSLProtocol           -all +TLSv1.2 +TLSv1.3
    SSLHonorCipherOrder   off
    SSLSessionTickets     off

    # ── 全权令牌不得出本机（第二道闸，见 §3.2 事故二）──────
    # 用 Require all denied 而不是 RewriteRule …[F]：前者不受后续 rewrite 顺序影响，
    # 也不会因为漏了 [L] 而被后面的 ProxyPass 接走。
    <Location "/api/token">
        Require all denied
    </Location>

    # ── 反代 ─────────────────────────────────────────────
    ProxyPreserveHost On
    # mod_proxy 默认就是 On：会把 TCP 对端地址**追加**到 X-Forwarded-For 末尾。
    # 写出来是为了让读者知道这个头从哪来 —— 它是 trustProxy 唯一依赖的头。
    ProxyAddHeaders On
    # mod_proxy **不会**加 X-Forwarded-Proto，想要就自己写。
    # 服务端当前不读它（只按 X-Forwarded-For 还原来源），留作日志与将来使用。
    RequestHeader set X-Forwarded-Proto "https"

    # 请求体上限：服务端 maxUploadBytes 默认 32 MiB，这里留 40 MiB。
    # Apache 默认 0（不限），但很多企业模板会全局设一个较小的值，显式写更稳。
    LimitRequestBody 41943040

    # 上传大文件的超时；默认继承 Timeout（60s）在慢链路上不够
    ProxyTimeout 120

    ProxyPass        / http://127.0.0.1:8730/
    ProxyPassReverse / http://127.0.0.1:8730/
</VirtualHost>
</IfModule>
```

启用并签证书：

```bash
a2ensite cards-80 cards-443
apache2ctl configtest      # 必须 Syntax OK
systemctl reload apache2

certbot --webroot -w /var/www/certbot -d cards.example.com
# 之后 Apache 不会自动认新证书，重载一次
systemctl reload apache2
```

#### 2.3.4 Apache 特有的四个坑

| 现象 | 原因 | 处置 |
|---|---|---|
| 服务端日志里所有来源都是 `127.0.0.1`，限速/审计全失真 | `ProxyAddHeaders` 被关掉了（或走了 `mod_proxy_ajp` 等别的后端） | 确认 `ProxyAddHeaders On`；见 §3 |
| 客户端报 413，服务端日志干净 | 企业模板里全局 `LimitRequestBody` 比 32 MiB 小 | 在 `:443` vhost 里显式写 40 MiB |
| 上传到一半报 502 / 504 | `ProxyTimeout` 继承全局 `Timeout`（默认 60s） | 显式 `ProxyTimeout 120` |
| 换证书后仍是旧证书 | Apache 不会自动重读证书文件 | `systemctl reload apache2`（不是 restart，reload 即可） |

> **不需要为 WebSocket 做额外配置**：服务端的 API 是纯 HTTP（轮询），
> 没有 WebSocket 通道，所以 `mod_proxy_wstunnel` 与 `Upgrade` 头都可以不管。

---

## 3. `trustProxy`：反代部署唯一必做的一步

**漏了这一步，服务能跑，但会出现两种"看着像玄学"的故障。**

### 3.1 怎么填

```jsonc
// 同机反代（最常见）
"trustProxy": ["127.0.0.1"]

// 反代在另一台机器上
"trustProxy": ["10.0.0.12"]

// 一片网段（仅在代理地址不固定时使用，且必须是**你自己的**网段）
"trustProxy": ["10.0.0.0/24"]

// 前面还有 CDN，且 CDN 会重写来源：登记 CDN 的回源段
"trustProxy": ["203.0.113.0/24"]
```

面板「参数配置 → 网络 → 可信反向代理」是同一个字段（每行一个）。
**默认空数组＝不信任任何代理头**，有效来源恒等于 TCP 对端地址。

### 3.2 不配会怎样：两个真实事故

#### 事故一：一个人输错密码，全公司登录被锁

- **症状**：早上所有人登录都提示密码错误（或"尝试次数过多"），可密码明明是对的；
  等 10 分钟自己好了，然后又一次。开发者本机却一直正常。
- **机制**：登录失败限速是**按有效来源 IP 分桶**，5 次失败锁 10 分钟。`trustProxy` 为空时，
  有效来源 = TCP 对端 = 反代自己 = `127.0.0.1`。于是所有真实用户挤进**同一个桶**：
  任何一个人（或一个扫描器）打错 5 次，整个公司一起被锁。
- **判据**：日志里每条请求的来源都是 `127.0.0.1`；面板「总览 → 可信代理」的"已生效代理数"是 0。
- **修复**：`trustProxy: ["127.0.0.1"]`，保存即生效，无需重启。

#### 事故二：全权令牌从公网被取走（安全问题，不只是体验问题）

- **症状**：在任意一台外网机器上执行
  `curl https://cards.example.com/api/token` —— 期望 403，实际拿到 **200 + 令牌原文**。
- **机制**：`/api/token` 的判据是「有效来源必须是回环地址」，它发放的是 legacy
  **全权令牌**（能改配置、能看所有未归属卡片）。`trustProxy` 为空时，来自公网的请求
  经过同机反代后，TCP 对端是 `127.0.0.1` → 服务端**判定为"本机访问"** → 把令牌交出去。
- **后果**：拿到令牌等于拿到服务器管理权，且不会留下"异常登录"的痕迹（它不走登录）。
- **修复（两层，都要做）**：
  1. `trustProxy: ["127.0.0.1"]` —— 让服务端按真实公网 IP 判定；
  2. 代理层显式拒绝 `/api/token`（§2 的三份配置都有这一条）—— 纵深防御，
     防的是"下次有人又忘了配 trustProxy"。

> 这两条是同一类错误的两个面：**反代把"来源"抹平了，而服务端所有来源相关的判据都依赖它。**
> 只要经过反代，`trustProxy` 就不是可选项。

### 3.3 判定规则（配好之后）

| 请求形态 | 有效来源 IP | `/api/token` |
|---|---|---|
| 本机直连，无代理头 | 对端地址（`127.0.0.1`） | 200 |
| 经**已登记**代理，XFF 末段是公网地址 | 该公网地址 | 403（正确：令牌不得出本机） |
| 经**已登记**代理，XFF 末段是 `127.0.0.1` | `127.0.0.1` | 200（本机经代理访问） |
| 经**未登记**的代理 | 对端地址（代理自己） | 取决于代理地址 |
| 直连但自己伪造 `X-Forwarded-For` | 对端地址（头被忽略） | 按对端判定 |

规则是「**从右往左，取第一个不属于信任表的地址**」。所以客户端自己伪造 XFF 没用：
最右那段永远是最后一跳代理写上去的真实地址。

**不要把 `trustProxy` 填成 `0.0.0.0/0` 或整段公网**：链上所有跳都可信时，最左侧那段
（客户端自己写的）就无法与真实首跳区分 —— 这是信任模型的固有限制，不是实现缺陷。

### 3.4 怎么确认真的生效

1. 从外网访问一次站点（随便开个页面）；
2. 面板「总览 → 可信代理」：`已生效代理数` 应 ≥ 1（**0 就说明地址写错了**）；
3. 服务端日志里应出现**真实公网 IP**，不再是 `127.0.0.1`；
4. 从外网 `curl https://cards.example.com/api/token` 应返回 **403**。

---

## 4. 已知交互：反代 + `tls.mode=off` 时的明文横幅

**这是当前版本（v0.1.3）的已知不足，已登记为 v0.1.4 需求。**

### 4.1 会看到什么

反代终止 TLS、`tls.mode=off`、`host=127.0.0.1` 时，面板「传输安全」显示的是：

> ⚠ **明文传输，仅限可信网络**
> 当前 tls.mode=off，所有请求（含登录密码与访问令牌）以明文经过网络。
> API 监听 127.0.0.1（回环地址），只有本机能连上，风险可控。
> **若要给局域网或公网使用，请切换到 selfsigned 或 custom。**

### 4.2 为什么这句话在反代部署下是误导

- TLS 已经在代理上终止了，公网段是加密的；
- 明文只存在于 `代理 → 127.0.0.1:8730` 这一跳，不经过网卡；
- 所以最后那句"请切换到 selfsigned 或 custom"在这个拓扑下**是多余的建议** ——
  照着做会让服务端再持一张证书、多开一个 8443 端口，而客户端其实连的是代理。

横幅本身不算错（它描述的明文段确实存在），但**缺少"TLS 由反代终止"这个上下文**，
于是正确地报警、错误地指导。

### 4.3 v0.1.4 需求（已记录，未实现）

> **当 `trustProxy` 非空且 `tls.mode=off` 时，横幅文案改为「TLS 由反代终止」**，
> 说明"明文只存在于代理到回环这一跳"，并**不再**给出"切换到 selfsigned/custom"的建议。

两条实现约束（避免做成"前端特殊处理"）：

1. 判据必须落在服务端的横幅生成函数（当前是 `tlsSecurityBanners`）—— 面板只渲染
   服务端给的结构，前端各写一套必然漂移成"面板说反代终止、日志说明文传输"；
2. `trustProxy` **非空不等于真的生效**（可能地址写错）。文案要区分
   「已配置」与「已生效代理数 > 0」，否则会给人一种"配了就等于好了"的错觉
   （见 §3.4 的第 2 步）。

在这条实现之前，请按下面这段理解当前横幅：

> 看到「明文传输」不必惊慌，但要确认两件事 —— `host` 是 `127.0.0.1`，
> 且从外网 `curl http://<公网IP>:8730/api/health` 超时。

---

## 5. 客户端怎么连

客户端「设置 → 服务端地址」填 `https://cards.example.com`（**不要带 `/api`**），
然后**用账户登录**，不要填令牌：

| 凭证 | 能得到什么 | 用在哪 |
|---|---|---|
| 账户登录（用户名 + 密码） | 可续期的账户令牌，能看到自己的全部仓库 | 客户端日常使用（推荐） |
| 仓库令牌（`tcr_…`） | 只能看/写绑定那一个仓库，可按 scope 限制 | CI、脚本、临时给别人上传 |
| 全局令牌（legacy） | 多账户环境下只能看**未归属**卡片 | 服务端运维、面板 |

「一键连接（取令牌）」只在**同一台机器**上有效：它靠回环来源判定，
经反代来的请求会被 403 挡掉 —— 这是刻意设计，不是 bug。远程要令牌请到服务器上执行
`tcs-server token show`（见 [`server-cmd.md`](server-cmd.md)）。

---

## 6. 上线自查清单

按顺序过一遍，每条都能一条命令验证：

- [ ] `host` 是 `127.0.0.1`；外网 `curl http://<IP>:8730/api/health` **超时**
- [ ] `tls.mode` 与拓扑一致（反代 → `off`；自持 → `selfsigned`/`custom`）
- [ ] `trustProxy` 已填，且「已生效代理数」≥ 1（§3.4）
- [ ] 外网 `curl https://域名/api/token` → **403**（§3.2 事故二）
- [ ] `https://域名/api/health` → 200，证书链完整（`curl -vI` 无警告）
- [ ] 上传一张接近 32 MiB 的卡成功，不出现 413（§2 的请求体上限）
- [ ] `registerMode` 是 `admin-only`（或你确实要 `open` 并接受风险）
- [ ] 第一个管理员已创建，能登录并看到默认仓库
- [ ] 防火墙/安全组只放通 80、443
- [ ] 备份策略已确认（配置 + `store\` 目录；`custom` 拓扑还要备份证书与私钥）

---

## 7. 排障速查

| 现象 | 先查这里 |
|---|---|
| 客户端"一键连接"失败 | 正常：反代场景不可用，改用账户登录（§5） |
| 登录说密码错，但密码是对的 | `trustProxy` 漏配 → 限速全局化（§3.2 事故一） |
| `/api/token` 返回 200（外网） | 严重：`trustProxy` 漏配（§3.2 事故二），立即补配 + 代理层 deny |
| 上传 413 / 502 / 504 | 代理的请求体上限与超时（§2.3.4、§2.2 注） |
| 面板显示"明文传输"但已用 HTTPS 访问 | 反代拓扑下的已知文案问题（§4） |
| 换证书后浏览器仍报旧证书 | 代理没重载（Apache 必须 `reload`） |
| 日志里来源全是 `127.0.0.1` | 同上，`trustProxy` 或 `ProxyAddHeaders` |

---

## 8. 相关文档

- [`server-cmd.md`](server-cmd.md) —— 运维命令（建账户、看令牌、服务注册、离线自检）
- [`server-developer.md`](server-developer.md) —— 逐端点 API 说明、错误码、`cardId` 语义
- [README 的「开启 HTTPS（可选）」一节](../README.md) —— 拓扑 B（服务端自持证书）

---

*本文件随版本更新。最近核对：v0.1.3（2026-10-25）。*
