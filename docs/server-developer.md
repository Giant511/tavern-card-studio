# 服务端 API 对接文档

> 目标读者：想**自己对接** Tavern Card Studio 服务端的第三方开发者（写插件、做 CI、接自己的编辑器）。
> 本文自包含：不依赖仓库里任何未上传的开发文档，照本文就能把请求跑通。
> 运维命令（装服务、建账户、换令牌、看日志）见 [`server-cmd.md`](server-cmd.md)。
>
> 适用版本：**v0.1.2**。文中标注 `v0.1.2 新增` 的部分在老服务端上不存在，见 §9 兼容性。

---

## 1. 概览：两个端口、两种角色

服务端是**一个进程、两个监听端口**，内部再分成 supervisor（控制面）与 worker（数据面）：

| 端口 | 默认值 | 装的是什么 | 谁调用 |
|---|---|---|---|
| **API 端口**（`port`） | `8730` | 卡片 CRUD、版本、审计、仓库、令牌、认证 | 你的程序 |
| **面板端口**（`controlPort`） | `port + 1` → `8731` | 管理面板 HTML + 控制面 API（`/control/*`） | 浏览器 / 运维脚本 |

默认**两个端口都只绑 `127.0.0.1`**（`host` 与 `controlHost` 各自独立，默认都取回环）。

```
http://127.0.0.1:8730   ← 你的程序打这里
http://127.0.0.1:8731   ← 浏览器打开是管理面板
```

**要不要对外开？** 只开你需要的那一个，而且优先放在反向代理后面（见 §7.2）：

```jsonc
// config.json 片段
{
  "host": "0.0.0.0",          // API 开给局域网
  "controlHost": "127.0.0.1", // 面板仍然只给本机
  "port": 8730,
  "controlPort": 8731
}
```

两个配置项分开是有原因的：面板能改配置、能轮换令牌、能禁用账户，把它和 API 一起暴露出去，
等于把管理面交出去。`host` 开成非回环地址时，服务端会**强制要求鉴权**（`auth.require` 被强制为 `true`）。

**HTTPS 是第三个端口**（默认 `8443`），与 HTTP 并存，见 §7。

### 1.1 一次典型调用长什么样

```bash
curl -s http://127.0.0.1:8730/api/health
```

```json
{
  "status": "ok",
  "role": "worker",
  "version": "0.1.2",
  "apiVersion": "v1",
  "pid": 12345,
  "startedAt": "2026-10-24T12:00:00.000Z",
  "uptimeMs": 8123,
  "node": "v22.22.2",
  "authRequired": true
}
```

`/api/health` 是**唯一默认免鉴权**的路径（`auth.publicPaths` 可配）。用它做存活探测。

> **Windows 上的一个坑**：PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名，参数不兼容。
> 本文所有示例都是 curl 语法，在 PowerShell 里请写 **`curl.exe`**，不要写 `curl`。

---

## 2. 凭证体系

### 2.1 四种凭证对照

| 凭证 | 形态 | 带身份吗 | 权限范围 | 生命周期 | 怎么拿 |
|---|---|---|---|---|---|
| **全局令牌**（legacy） | 随机串（base64url） | 否 | **仅未归属卡片**（`owner_id = ''`） | 长期，`token rotate` 轮换 | `POST /api/token`（仅回环）／面板／`tcs-server token show` |
| **access token** | JWT HS256 | 是（账户） | 该账户**全部仓库** | 2 小时 | `POST /api/auth/login` |
| **refresh token** | opaque 串 | 会话 | 仅用于换新 access | 30 天，每次使用轮换 | 同 login 响应 |
| **仓库令牌** | `tcr_` + 43 字符 | 是（账户 + 单仓库） | `read` / `write` / `rollback` 三档 | 可设过期，可吊销 | `POST /api/repos/:id/tokens` |
| **无凭证** | — | 否 | **全部** | — | 仅当 `auth.require=false` **且**来源是回环 |

最后一行是**只有本机、且服务端关掉鉴权时**才成立的开发态。一旦 `host` 不是回环地址，
`auth.require` 会被强制为 `true`，这条路径不存在。

### 2.2 携带方式

三种都走**请求头**，不接受 `?token=` 查询参数（查询串会进访问日志、浏览器历史与 `Referer`）：

```http
Authorization: Bearer <token>
```

兼容写法（老客户端在用，仍然有效）：

```http
X-API-Token: <token>
```

同一请求两个头都给时以 `Authorization` 为准。**没有查询参数形式，别再试了。**

### 2.3 该用哪一种

```
写 CI / 脚本，只上传不说别的      → 仓库令牌（read + write）
写只读的展示页 / 备份工具          → 仓库令牌（read）
做完整的第三方编辑器              → 账户登录拿 access + refresh
运维脚本、修数据、看全站           → 全局令牌（但注意它只看未归属卡片）
```

**仓库令牌不能管理仓库或令牌本身**（否则一把泄露就能自我续期，吊销失去意义）。
要签发/吊销令牌，必须用**账户登录**（JWT）。

### 2.4 五种凭证看到的卡片不一样

所有卡片类接口（列表 / 详情 / 版本 / 原文 / diff / 回滚 / 删除 / 统计 / 事件）都在 SQL 里按凭证过滤：

| 凭证 | 可见卡片 |
|---|---|
| 账户登录（JWT） | `owner_id` = 本账户（全部仓库） |
| 仓库令牌 | 本账户 **且** 绑定仓库 |
| 全局令牌 | 仅 `owner_id = ''`（未归属） |
| 无凭证（回环 + 关闭鉴权） | 全部 |

`GET /api/stats` 会下发 `isolationEnforced: true` 与 `scope: {kind, repoId}`，
可以据此判断"服务端是否已按账户隔离"以及"我现在看到的是哪一片"。

---

## 3. 认证端点

### 3.1 取服务端策略（免鉴权）

```http
GET /api/auth/config
```

```json
{
  "registerMode": "closed",
  "accessTtlSeconds": 7200,
  "authRequired": true
}
```

`registerMode` 三档：`closed`（默认，谁都不能自助注册）/ `admin-only`（只有管理员能建号）/ `open`（任何人）。
**客户端应该在画出登录框之前先读它**，`closed` 时干脆不显示注册入口。
它刻意不告诉你"这台机器是否已经建过账户"——那是公网可探测的信息。

### 3.2 登录

```bash
curl.exe -s -X POST http://127.0.0.1:8730/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"..."}'
```

```json
{
  "user": { "id": "u_ab12", "username": "alice", "role": "admin", "status": "active" },
  "tokenType": "Bearer",
  "accessToken": "eyJhbGciOiJIUzI1NiIs…",
  "refreshToken": "rt_…",
  "accessExpiresAt": "2026-10-24T14:00:00.000Z",
  "refreshExpiresAt": "2026-11-23T12:00:00.000Z",
  "sessionId": "ses_…",
  "accessTtlSeconds": 7200,
  "refreshTtlSeconds": 2592000
}
```

| 状态 | code | 说明 |
|---|---|---|
| `400` | `BAD_REQUEST` | 缺 `username` / `password` |
| `401` | `INVALID_CREDENTIALS` | **用户不存在、密码错、账户锁定中，三者返回同一句话** |
| `429` | `TOO_MANY_REQUESTS` | 鉴权失败次数过多（见 §6.2） |

`INVALID_CREDENTIALS` 刻意不区分三种原因：分开就等于把账户存在性与锁定状态广播出去。

### 3.3 续期

```bash
curl.exe -s -X POST http://127.0.0.1:8730/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"rt_…"}'
```

响应形状与 login 相同。**refresh 每次使用都会轮换**：旧的那个立即失效，必须存下响应里的新值。
`401 INVALID_REFRESH_TOKEN` 表示不存在 / 已吊销 / 已过期（同样不区分），此时应回登录页。

### 3.4 注册

```http
POST /api/auth/register
{ "username": "bob", "password": "…" }
```

| 状态 | code | 说明 |
|---|---|---|
| `201` | — | 成功。`open` 模式下返回令牌；`admin-only` 模式下调用者是管理员时**只返回用户，不返回令牌**（拿到别人的会话是越权） |
| `403` | `REGISTRATION_CLOSED` | 服务端关了自助注册 |
| `400` | `REGISTRATION_REJECTED` | 用户名占用 / 用户名格式不合规 / 密码不合规，共用一码 |

第一个账户自动成为管理员（通常由 `tcs-server user migrate <名字>` 建，见 `server-cmd.md`）。

### 3.5 当前身份 / 登出 / 验证令牌

```bash
curl.exe -s http://127.0.0.1:8730/api/auth/me -H "Authorization: Bearer <token>"
```

```json
{ "via": "jwt", "role": "admin", "user": { "id": "u_ab12", "username": "alice", "role": "admin", "status": "active" } }
```

用全局令牌时如实返回 `{"via":"legacy","role":"admin","user":null}`（它没有账户身份，不编一个假用户）。

```http
POST /api/auth/logout        → { "ok": true }     # 吊销当前会话，立即生效
GET  /api/auth/verify        → { "ok": true, "auth": {...}, "server": {...} }   # 探活 + 验令牌
```

**登出是立即生效的**：会话状态落库，鉴权时每次查库，不靠令牌自然过期。

### 3.6 取全局令牌（仅回环）

```bash
curl.exe -s http://127.0.0.1:8730/api/token
```

这是"客户端首次连接本机服务端"的引导接口，让用户不用去翻日志找令牌。**两道门禁，缺一不可**：

1. **有效来源 IP 必须是回环**——令牌不得出本机；
2. **代理跳必须已登记**——只有 `trustProxy` 里写过的地址，才允许用 `X-Forwarded-For` 说明真实来源。

| 状态 | code | 含义 |
|---|---|---|
| `200` | — | `{ "token": "…", "authRequired": true, "server": {…} }` |
| `403` | `TOKEN_LOCAL_ONLY` | 来源不是回环（或被未登记的代理转发），`details` 带 `effectiveAddress` / `socketAddress` |
| `409` | `TOKEN_NOT_CONFIGURED` | 服务端根本没配令牌（配置被绕过规范化构造） |

> 这两条的历史值得知道：v0.1.2 之前只看 `socket.remoteAddress`，同机反向代理下它对**所有公网请求**
> 都是 `127.0.0.1`，于是任何人 `curl https://你的域名/api/token` 就能拿到全权令牌。
> 如果你的部署在反向代理后面，**必须**按 §7.2 登记代理地址。

---

## 4. 端点清单

约定：所有路径相对 `http://127.0.0.1:8730`。除标注「免鉴权」外都需要凭证。
`{id}` 是**卡片 ID**（见 §5），`{rev}` 是版本标识（序号 / 提交 sha / `latest`）。

### 4.1 全局

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/health` | 健康检查（**免鉴权**） |
| `GET` | `/api/auth/verify` | 验证令牌 + 服务端版本 |
| `GET` | `/api/token` | 取全局令牌（**仅回环**，见 §3.6） |
| `GET` | `/api/stats` | 卡片/版本/字节/blob 统计（按凭证过滤） |
| `GET` | `/api/events` | 最近操作事件（`?limit=` 默认 50，最大 500） |
| `GET` | `/api/platforms` | 平台规则列表 + 服务端默认 |
| `GET` | `/api/presets` | TXT 预设列表 + 服务端默认 |

`/api/events` 响应：

```json
{ "items": [
  { "id": 812, "at": "2026-10-24T12:31:02.114Z", "level": "info",
    "action": "card.delete", "cardId": "lin-wanzhao-0001",
    "detail": { "repo": "default" }, "actor": "alice", "ip": "10.0.0.5" }
] }
```

`actor` / `ip` 在老事件上是 `null`。**事件记录不随对象消失**：卡片被彻底清除后，
那条删除记录仍在事件流里（否则审计就没有意义了）。

`/api/stats` 关键字段：

```json
{
  "cards": 12, "versions": 47, "bytes": 913402, "blobs": 40,
  "uptimeMs": 8123, "version": "0.1.2",
  "config": { "port": 8730, "controlPort": 8731, "tlsMode": "off" },
  "tls": { "mode": "off", "fingerprint256": null },
  "isolationEnforced": true,
  "scope": { "kind": "owner", "repoId": null },
  "proxy": { "entries": 1, "trustedProxies": ["127.0.0.1"] }
}
```

### 4.2 卡片 CRUD

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/cards` | 列表（`?q=` 搜索、`limit` / `offset`、`?includeDeleted=true`） |
| `POST` | `/api/cards` | **上传（按 ID upsert）** |
| `GET` | `/api/cards/:id` | 详情 |
| `GET` | `/api/cards/:id/raw` | 原始字节 |
| `DELETE` | `/api/cards/:id` | **软删除**（进回收站） |
| `POST` | `/api/cards/:id/restore` | 从回收站恢复 |
| `POST` | `/api/cards/:id/purge` | 彻底清除（**仅管理员**，不可逆） |
| `POST` | `/api/cards/:id/move` | 移到另一仓库（`{"repo":"..."}`） |

#### 上传 `POST /api/cards`

请求体是**角色卡 JSON 的原始字节**（不是 multipart），元数据全在 query：

| query | 说明 |
|---|---|
| `cardId` | 卡片 ID。给了就按它归档：已存在→追加版本，不存在→新建。也可用 `X-TCS-Card-Id` 头，**两处不一致直接 400** |
| `baseSeq` | 本会话上次上传拿到的 `seq`，用于判断分叉（可不传） |
| `message` | 版本消息，默认「初始版本」/「更新 vN」 |
| `author` | 版本作者，默认 `Tavern Card Studio` |
| `filename` | 原始文件名（只做记录） |
| `platform` / `preset` | 审计所用规则，缺省用服务端配置 |
| `includeStDefaults` | `false` 关闭「ST 缺省字段」info 提示 |

```bash
curl.exe -s -X POST "http://127.0.0.1:8730/api/cards?cardId=lin-wanzhao-0001&message=%E5%AF%BC%E5%85%A5%E5%88%9D%E7%89%88" \
  -H "Authorization: Bearer tcr_…" \
  -H "Content-Type: application/json" \
  --data-binary @lin-wanzhao.json
```

```json
{
  "cardId": "lin-wanzhao-0001",
  "seq": 1,
  "created": true,
  "warnings": [],
  "card": {
    "cardId": "lin-wanzhao-0001", "id": "lin-wanzhao-0001",
    "idSource": "client", "name": "林晚照", "spec": "v2", "specVersion": "2.0",
    "tags": ["日常", "治愈"],
    "createdAt": "2026-10-22T06:11:02.114Z",
    "versionCount": 1, "latestSeq": 1,
    "latest": { "seq": 1, "commit": "cd5997…", "sha256": "c3e85b…", "size": 3922,
                "message": "导入初版", "createdAt": "…" },
    "audit": { "sha256": "7acd…", "generatedAt": "…", "error": 0, "warning": 0, "info": 2, "exportable": true }
  },
  "version": { "seq": 1, "kind": "upload" }
}
```

**新建 `201` / 追加 `200`。** 响应头带 `Location`、`X-TCS-Card-Id`、`X-TCS-Card-Seq`、`X-TCS-Card-Created`。

`cardId` 与 `seq` 在**顶层**也重复了一遍：从嵌套结构里挖字段容易漏，漏了就静默变默认值。

| 状态 | code | 触发条件 |
|---|---|---|
| `400` | `BAD_CARD_ID` | 空串 / 非法字符 / 超 64 字符 / 首尾连字符 / query 与 header 不一致 |
| `400` | `BAD_REQUEST` | 请求体为空、`baseSeq` 非整数 |
| `409` | `CARD_DELETED` | 该 ID 被一张**软删**的卡占着（复用 ID 会把旧历史一起复活） |
| `413` | `PAYLOAD_TOO_LARGE` | 超过 `maxUploadBytes`（默认 32 MiB） |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | 用了 `multipart/form-data` |
| `422` | `CARD_PARSE_FAILED` | 非 UTF-8 / JSON 非法 / 不是角色卡；`details` 带行列号 |

`422` / `400` / `409` 时**不落任何数据**：不会产生卡片、blob 或 git 提交。

#### 分叉警告（`warnings`，不阻断写入）

| 情形 | `warnings` |
|---|---|
| `baseSeq` 与远端最新一致 | 空 |
| `baseSeq` ≠ 远端最新 | `FORK` |
| `baseSeq ≥ 1` 但远端没有这张卡 | `REMOTE_MISSING` |
| 未传 `baseSeq` | 空 |

```json
{ "code": "FORK",
  "message": "远端已有他人修改（最新 v4，你的基线是 v2），本次上传将产生分叉历史",
  "baseSeq": 2, "remoteLatestSeq": 4, "remoteLatestSha256": "ff31…" }
```

**警告而不拒绝是刻意的**：两个人从同一版各改各的很正常，拒绝会把内容堵在客户端。
真正的错误是"产生了分叉却不告诉用户"——所以请把 `warnings[].message` 直接展示给用户，别自己另写一套文案。

#### 列表 `GET /api/cards`

```bash
curl.exe -s "http://127.0.0.1:8730/api/cards?q=%E6%9E%97&limit=20&offset=0" \
  -H "Authorization: Bearer <token>"
```

```json
{ "total": 1, "limit": 20, "offset": 0, "items": [ { "id": "lin-wanzhao-0001", "name": "林晚照", "…": "…" } ] }
```

`limit` 默认 50、最大 500；`offset` 默认 0；响应带 `total`。

#### 删除 / 恢复 / 彻底清除

```bash
# 软删（进回收站，保留期内可恢复）
curl.exe -s -X DELETE http://127.0.0.1:8730/api/cards/lin-wanzhao-0001 -H "Authorization: Bearer <token>"

# 恢复
curl.exe -s -X POST http://127.0.0.1:8730/api/cards/lin-wanzhao-0001/restore -H "Authorization: Bearer <token>"

# 彻底清除（仅管理员，不可逆）
curl.exe -s -X POST http://127.0.0.1:8730/api/cards/lin-wanzhao-0001/purge -H "Authorization: Bearer <token>"
```

| 状态 | code | 说明 |
|---|---|---|
| `403` | `ADMIN_ONLY` | purge 或跨账户操作，但你不是管理员 |
| `404` | `NOT_FOUND` | 卡片不存在**或不属于你**（同形，见 §5.4） |
| `409` | `CARD_IN_TRASH` | 卡片在回收站里，恢复/purge 之外的写操作会被拒 |

保留期由 `trash.retentionDays` 决定（默认 30 天，`0` = 不自动清理，由清理任务物理删除）。

### 4.3 版本 / 历史 / 回滚 / diff

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/cards/:id/versions` | 版本历史（分页） |
| `POST` | `/api/cards/:id/versions` | 提交新版本（**原始字节**） |
| `GET` | `/api/cards/:id/versions/:rev` | 单个版本元数据 |
| `GET` | `/api/cards/:id/versions/:rev/raw` | 指定版本原始字节 |
| `POST` | `/api/cards/:id/versions/:seq/prune` | 清除某版本内容（元数据保留） |
| `GET` | `/api/cards/:id/diff` | 三层 diff |
| `POST` | `/api/cards/:id/rollback` | 回滚（**新建一个提交**，不是改写历史） |

#### 版本标识 `:rev` 的三种写法

| 写法 | 含义 |
|---|---|
| 省略或 `latest` | 最新版本 |
| 数字（`1`、`2`） | 版本**序号**，从 1 开始单调递增 |
| 提交 sha（≥4 位，可缩写） | Git 提交 id |

**数字有两种含义，服务端都试**：提交 sha 是十六进制，4 位前缀全由 0-9 组成的概率约 **15%**。
解析顺序是**先序号、后 sha 前缀**；两者都没有才 404 并在 `details.hint` 说明。
所以别假设"数字一定是序号"——要精确指定序号时，取值范围受该卡版本数限制。

#### 版本对象

```json
{
  "seq": 2, "commit": "a718200…", "sha256": "b6d27339…", "size": 3931,
  "message": "改名字", "author": "alice",
  "kind": "update",
  "parentCommit": "cd59976…", "createdAt": "2026-10-22T07:00:00.000Z",
  "audit": { "error": 0, "warning": 0, "info": 2, "exportable": true },
  "meta": {}
}
```

`kind` ∈ `upload` | `update` | `rollback` | `import`。
**`sha256` 永远是卡片字节的摘要**，Git 对象 id 在 `commit` 字段 —— 两者别混用。

#### diff 三层

```bash
curl.exe -s "http://127.0.0.1:8730/api/cards/lin-wanzhao-0001/diff?from=1&to=2" \
  -H "Authorization: Bearer <token>"
```

| 参数 | 说明 |
|---|---|
| `from` | 旧版本，缺省为 `to.seq - 1` |
| `to` | 新版本，缺省 `latest` |
| `include` | 逗号分隔 `bytes,lines,json`，缺省全给 |
| `context` | 行 diff 上下文行数，默认 3，最大 20 |

```json
{
  "from": { "seq": 1, "commit": "cd59976…", "sha256": "c3e8…" },
  "to":   { "seq": 2, "commit": "a718200…", "sha256": "b6d2…" },
  "identical": false,
  "bytes": { "identical": false, "sizeDelta": 9, "firstDiffOffset": 162,
             "commonPrefix": 162, "commonSuffix": 3760 },
  "lines": { "added": 2, "removed": 2, "oldLineCount": 68, "newLineCount": 68,
             "equalLinesButDifferentBytes": false,
             "hunks": [ { "header": "@@ -3,4 +3,4 @@",
                          "lines": [ { "kind": "del", "display": "    \"name\": \"林晚照\",", "oldLine": 4, "newLine": null },
                                     { "kind": "add", "display": "    \"name\": \"林晚照（改）\",", "oldLine": null, "newLine": 4 } ] } ] },
  "json": { "parsed": true, "changes": [ { "path": "data.name", "kind": "changed", "before": "林晚照", "after": "林晚照（改）" } ] }
}
```

三层各自的语义：

- **bytes** —— 唯一能回答「是否逐字节相同」的一层。只改了换行风格时行 diff 可能为空，
  它仍会给出 `identical: false` 与首个差异偏移；
- **lines** —— 按 `\n` 切分、**保留行尾**（`\r\n` 与 `\n` 视为不同内容），`display` 去掉行尾便于显示；
- **json** —— 解析后按 JSON 路径列字段改动，数组按索引比较；任一侧解析失败时 `parsed: false`，
  不影响另外两层。

#### 回滚

```bash
curl.exe -s -X POST http://127.0.0.1:8730/api/cards/lin-wanzhao-0001/rollback \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"to":1,"message":"回滚到初版"}'
```

回滚**新建一个提交**（`kind: "rollback"`），不改写历史 —— 所以回滚本身也能被回滚。
需要的范围是 `rollback`（不是 `write`）。

#### 清除某版本内容（prune）

```http
POST /api/cards/:id/versions/:seq/prune
```

元数据保留，正文与 `sha256` 置空。之后读原文/回滚返回 `409 VERSION_CONTENT_CLEARED`，
diff 显式标记「内容已清除」。**最新版本不可清除。**

### 4.4 审计

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/audit` | 审计任意字节（**不落库**） |
| `GET` | `/api/cards/:id/audit` | 某版本的审计快照（`?version=`、`?refresh=true`） |

```bash
curl.exe -s -X POST "http://127.0.0.1:8730/api/audit?platform=ccv2&preset=default" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  --data-binary @lin-wanzhao.json
```

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-21T05:41:51.120Z",
  "card": { "name": "林晚照", "spec": "v2", "specVersion": "2.0", "source": "upload" },
  "platformRule": { "id": "ccv2", "name": "Character Card V2", "version": "1.0.0", "lineage": ["sillytavern","ccv2"] },
  "presetId": "default",
  "wordCount": { "total": { "chars": 394, "charsNoSpace": 378, "cjk": 251, "words": 17, "totalWords": 268 } },
  "issues": [
    { "id": "…", "ruleId": "char-placeholder-suggested", "category": "platform-rule",
      "severity": "info", "message": "正文中未出现 {{char}} 占位符…",
      "location": { "blockId": "settings", "field": "description", "start": 0, "end": 40, "line": 1, "column": 1 } }
  ],
  "summary": { "error": 0, "warning": 0, "info": 2, "exportable": true },
  "byCategory": { "completeness": 0, "format": 1, "platform-rule": 1, "structure": 0, "worldbook": 0 }
}
```

`severity` ∈ `error` / `warning` / `info`；`summary.exportable === false` 表示有 `error` 级问题。
`POST /api/audit` 响应头带 `X-TCS-Audit-Source: ad-hoc` 与 `X-TCS-Card-Sha256`。

版本快照（`GET /api/cards/:id/audit`）：

- 默认读**提交时存储**的报告字节（`X-TCS-Audit-Source: snapshot`，`ETag` 为报告 sha256），
  重复读取逐字节一致 —— 可以用它做"审计结论没被事后改动"的证明；
- `?refresh=true` 用**当前规则**重新审计同一版本，返回 `recomputed` 与 `X-TCS-Audit-Snapshot`（原快照哈希），**不写回**；
- 该版本没有快照时 `404`，`details.auditError` 说明原因。

`v0.1.2` 起多了第五类 `worldbook`（世界书条目结构、id 缺失、触发键为空等）。

### 4.5 仓库

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/repos` | 列出**自己**的仓库 |
| `POST` | `/api/repos` | 新建（名字账户内唯一） |
| `PATCH` | `/api/repos/:id` | 改名 |
| `POST` | `/api/repos/:id/default` | 设为默认 |
| `DELETE` | `/api/repos/:id` | 删除（非空必须给 `transferTo`，见下） |

```bash
curl.exe -s http://127.0.0.1:8730/api/repos -H "Authorization: Bearer <jwt>"
```

```json
{ "items": [ { "id": "r_ab12", "name": "default", "description": "…", "isDefault": true,
               "createdAt": "…", "updatedAt": "…", "cardCount": 12 } ] }
```

管理员加 `?all=true` 可以看全部账户的仓库（每项多一个 `ownerId`）；非管理员带这个参数会 `403 ADMIN_ONLY`。

**仓库令牌访问这个端点会 403**（`FORBIDDEN`）：它不该看到兄弟仓库的存在。

删除非空仓库必须指定转移目标，卡片（**含回收站里的**）全量转移、该仓库的令牌全部吊销后才删：

```bash
curl.exe -s -X DELETE "http://127.0.0.1:8730/api/repos/r_ab12" \
  -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
  -d '{"transferTo":"r_cd34"}'
```

| 状态 | code | 说明 |
|---|---|---|
| `409` | `NOT_EMPTY` | 非空且没给 `transferTo` |

默认仓库不给删（只能"转移默认"）。管理员可跨账户操作（审计里会写两条：转出 + 转入）。

### 4.6 令牌管理

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/api/repos/:id/tokens` | JWT | 列令牌（**只有前缀**） |
| `POST` | `/api/repos/:id/tokens` | JWT | 签发（**原文只返回这一次**） |
| `PATCH` | `/api/tokens/:id` | JWT | 改权限范围 |
| `DELETE` | `/api/tokens/:id` | JWT | 吊销 |

```bash
curl.exe -s -X POST http://127.0.0.1:8730/api/repos/r_ab12/tokens \
  -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
  -d '{"name":"CI 上传用","scopes":["read","write"],"expiresAt":"2027-01-01T00:00:00Z"}'
```

```json
{
  "token": "tcr_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  "tokenPrefix": "tcr_XXXXXXXX",
  "name": "CI 上传用",
  "repoId": "r_ab12", "repoName": "default",
  "scopes": ["read", "write"],
  "expiresAt": "2027-01-01T00:00:00.000Z",
  "note": "请立刻保存：令牌原文只显示这一次，之后无法再查看（服务端只存哈希）。"
}
```

**原文只出现这一次**，库里只有 sha256。丢了只能吊销重签。列表只回前缀（`tcr_ab12…`）用于辨认。

权限范围与操作的对应（**逐请求从库里读**，改小立即生效）：

| 操作 | 需要的范围 |
|---|---|
| 列表 / 详情 / 原文 / 历史 / diff / 审计 | `read` |
| 上传 / 追加版本 / 删除卡片 | `write` |
| 回滚 | `rollback` |

越权时 `403 FORBIDDEN`，`details` 会带上要求的范围与当前范围：

```json
{ "error": { "code": "FORBIDDEN",
  "message": "令牌缺少 write 权限（当前范围：read）：无法执行 write 操作",
  "details": { "requiredScope": "write", "tokenScopes": ["read"] } } }
```

### 4.7 控制面（面板端口）

这些挂在 **`controlPort`（默认 8731）**，不是 API 端口：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 管理面板 HTML |
| `GET` | `/control/status` | 服务 / 配置 / 进程状态 |
| `POST` | `/control/service/:action` | `start` / `stop` / `restart` |
| `GET` | `/control/config` | 读配置（令牌掩码） |
| `PUT` | `/control/config` | 改配置（落盘；部分需重启） |
| `POST` | `/control/token/rotate` | 轮换全局令牌并重启 worker |
| `POST` | `/control/token/reveal` | 显示当前全局令牌（本机管理用） |
| `GET` | `/control/logs` | worker stdout/stderr 尾部 |
| `GET` | `/control/accounts` | 账户列表（`?limit=`） |
| `POST` | `/control/accounts/:id/status` | 启用 / 禁用账户（`{"status":"active"\|"disabled"}`） |

`registerMode` 是**热生效**的：`PUT /control/config` 落盘后返回 `workerRestartRequired: false`，
worker 在**下一个请求**就按新策略判定。最后一个管理员不可被禁用（服务端拒绝并说明原因）。

---

## 5. `cardId` 语义

### 5.1 它是什么

`cardId` 是**用户/客户端指定的稳定标识**，唯一用途是让服务端按它归档：同 ID 追加版本、新 ID 新建卡片。
它和"服务端主键"不是一回事 —— 主键在服务端生成，`cardId` 在创建时就定了，**之后永不改变**。
改 ID 等于换了一张卡。

存放在卡数据的 **`data.extensions.tcs.cardId`**：

```json
{
  "spec": "chara_card_v2",
  "data": {
    "name": "林晚照",
    "extensions": { "tcs": { "cardId": "lin-wanzhao-0001" } }
  }
}
```

`extensions` 是 SillyTavern 规范里给第三方工具放自定义数据的字段，写这里不会干扰其他平台读卡。
**不要放进 `meta`** —— `meta` 的字段会直接映射到 ST JSON 顶层键，会被当成规范外字段带出去。

### 5.2 校验规则

- 只允许 `A-Z a-z 0-9 -`（这一条同时覆盖"无空白"与"无路径非法字符"）；
- 1–64 字符；
- 首尾不能是连字符（`-abc` / `abc-` 像被截断的残值）；
- 必须至少含一个字母或数字（`---` 不行）；
- **不做大小写归一**：填 `Lin-Wanzhao-001` 就存原样（静默转小写会让"明明填的一样"变成新的困惑源）。

不合法返回 `400 BAD_CARD_ID`，**不是**"没找到"——重试也一样，必须改 ID。

### 5.3 upsert 与分叉

`POST /api/cards` 是 **upsert**：带 `cardId` 时存在就追加、不存在就新建（`201` / `200` 区分）。
不带 `cardId` 时服务端发号（`<slug>-<6位hex>`，`idSource: "auto"`）——这是**旧客户端兼容路径**，
新程序一律请带 ID，否则你拿不到稳定标识。

`idSource` 三态：

| 值 | 含义 |
|---|---|
| `client` | 客户端指定（正常路径） |
| `auto` | 服务端发号（旧客户端上传） |
| `legacy` | v0.1.1 之前入库，老库升级时补的列默认值 |

遗留卡**读写都能用**：能列、能取详情、能看历史、能取原文、能回滚，也能用同一 ID 继续追加版本。
它们不需要迁移或改 ID —— `/api/cards/:id` 的语义本来就是"按 ID 寻址"。

分叉见 §4.2：`warnings` 里给 `FORK` / `REMOTE_MISSING`，**不阻断写入**。

### 5.4 「不存在」与「不属于我」是同一个 404

所有按凭证过滤的接口，看不到的对象与真的不存在的对象返回**完全相同的 404**，
响应体逐字节相同，没有第二条分支。

```json
{ "error": { "code": "NOT_FOUND", "message": "卡片不存在", "details": {} } }
```

**不要试图从状态码或文案上区分这两种情况**——那正是设计要防的：403 等于承认"这个 id 存在但不是你的"，
那就是一个卡片 id 枚举器（v0.1.2 安全修复 #3 就是这个）。

`403` 留给**与对象无关**的拒绝：`ADMIN_ONLY`（这件事只有管理员能做）、
`FORBIDDEN`（你的令牌范围不够，换个令牌就行）、`REGISTRATION_CLOSED`、`TOKEN_LOCAL_ONLY`。

这个区分对调用方有实际意义：
`403 ADMIN_ONLY` → 换令牌也没用，需要管理员；
`403 FORBIDDEN` → 权限档位不够，可以申请更大的令牌；
`404` → 要么真没有，要么不归你，两者你都不该继续试。

---

## 6. 错误、限速、分页

### 6.1 错误响应形状

```json
{ "error": { "code": "CARD_PARSE_FAILED", "message": "JSON 解析失败", "details": { "offset": 42, "line": 3, "column": 5 } } }
```

**按 `code` 分支，不要解析 `message`**（文案会改）。`details` 是可选对象，形状随 code 变化。

### 6.2 错误码总表

| code | HTTP | 说明 |
|---|---|---|
| `BAD_REQUEST` | 400 | 参数缺失 / 非法 |
| `BAD_CARD_ID` | 400 | 卡片 ID 不合法（改 ID 才行，重试无用） |
| `UNKNOWN_PLATFORM` | 400 | `platform` 不存在，`details.available` 列出可用 id |
| `UNKNOWN_PRESET` | 400 | `preset` 不存在 |
| `REGISTRATION_REJECTED` | 400 | 注册失败（用户名占用 / 格式或密码不合规，共用） |
| `UNAUTHORIZED` | 401 | 缺少或无效凭证 |
| `INVALID_CREDENTIALS` | 401 | 登录失败（用户不存在 / 密码错 / 锁定中，**同形**） |
| `INVALID_REFRESH_TOKEN` | 401 | refresh 失效（不存在 / 已吊销 / 已过期，同形） |
| `FORBIDDEN` | 403 | 凭证范围不够 |
| `ADMIN_ONLY` | 403 | 该操作仅管理员 |
| `ACCOUNT_DISABLED` | 403 | 密码正确但账户被禁用 |
| `REGISTRATION_CLOSED` | 403 | 服务端关闭了自助注册 |
| `TOKEN_LOCAL_ONLY` | 403 | 取令牌接口的来源不是回环 |
| `NOT_FOUND` | 404 | 不存在**或不属于你**（同形） |
| `NOT_EMPTY` | 409 | 目标非空（删仓库没给 `transferTo`） |
| `CARD_DELETED` | 409 | 该 ID 被一张软删的卡占着 |
| `CARD_IN_TRASH` | 409 | 卡片在回收站，写操作被拒 |
| `VERSION_CONTENT_CLEARED` | 409 | 版本内容已被 prune（不是"不存在"） |
| `TOKEN_NOT_CONFIGURED` | 409 | 服务端没配令牌 |
| `CONFLICT` | 409 | 通用冲突 |
| `PAYLOAD_TOO_LARGE` | 413 | 超过上传上限（默认 32 MiB） |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 用了 multipart |
| `CARD_PARSE_FAILED` | 422 | 字节不是合法角色卡，`details` 带解析位置 |
| `TOO_MANY_REQUESTS` | 429 | 鉴权失败次数过多，`details.retryAfterSeconds` |
| `INTERNAL` | 500 | 未预期错误（不回显堆栈） |
| `BLOB_CORRUPTED` | 500 | blob 缺失或摘要不符（存储层故障） |
| `SERVICE_UNAVAILABLE` | 503 | worker 未运行 |

### 6.3 限速：两套，别混为一谈

**① 登录失败（账户维度）** —— 同 IP **或** 同账户 **5 次失败 → 锁 10 分钟**：

- 失败计数的滑动窗口是 **15 分钟**：超过 15 分钟没再失败，计数从 1 重新算
  （"每天错一次"的正常用户永远不会被锁）；
- **锁定期间的失败不会延长锁定**——否则攻击者可以用持续尝试把别人的锁无限续期，
  变成针对合法用户的拒绝服务；
- 锁定期间仍然会做一次**完整的密码哈希**，所以响应耗时不泄露"你已经触发锁定了"；
- 锁状态**落库**，重启不清（重启恰好是攻击者最想要的效果）；
- 管理员着急可以手工解锁（`tcs-server` 的运维命令，见 `server-cmd.md`）。

**② 鉴权失败（IP 维度）** —— 同一 IP **5 分钟内 20 次无效凭证 → 阻断 5 分钟**，返回 `429`：

```json
{ "error": { "code": "TOO_MANY_REQUESTS", "message": "鉴权失败次数过多，请稍后再试",
             "details": { "retryAfterSeconds": 213 } } }
```

**从 429 上你探测不到任何东西**：它只说明"这个 IP 最近拿着无效凭证撞了很多次"，
不区分你用的是不存在的 id 还是别人的 id（那些都是 404）。按 `retryAfterSeconds` 退避即可。

反代部署时这两个限速都按**真实 IP** 分桶 —— 前提是 `trustProxy` 登记过（见 §7.2）。
没登记时全世界的失败都会记在代理那一格上，5 次之后**所有人**被锁。

### 6.4 分页与时间

- 分页：`limit`（默认 50，最大 500）、`offset`（默认 0），响应带 `total`；
- 所有时间为 ISO 8601 UTC（`2026-10-21T05:37:18.070Z`）；
- 行号 / 列号 1-based，列按码点计。

---

## 7. TLS 与反向代理

### 7.1 三种模式

```jsonc
// config.json
{ "tls": { "mode": "off", "httpsPort": 8443, "certPath": "", "keyPath": "" } }
```

| 模式 | 行为 |
|---|---|
| `off`（默认） | 只走 HTTP。面板与登录页常驻明文警告 |
| `selfsigned` | 首次启动自动签发 ECDSA P-256 证书（365 天），临近过期自动续期并保留旧证书 |
| `custom` | 用你自带的 PEM 证书与私钥 |

**HTTPS 与 HTTP 并存，`httpsPort` 独立（默认 8443）。** 这是为了让客户端能先改地址验证、再决定要不要关掉 HTTP。

> **已知限制（v0.1.2）**：`tls.mode` 不是 `off` 时，**HTTP 端口仍然对外服务**，没有独立关闭开关。
> 公网部署必须用防火墙挡住 8730，或者让服务只监听 `127.0.0.1` 交给反向代理。
> 别假设"开了 HTTPS 就没明文了"。

`custom` 模式会校验证书与私钥是否匹配、是否已过期：不匹配 / 缺失 / 过期一律**拒绝启动**，不退回明文。

### 7.2 自签证书：先核对指纹

自签证书的 SAN 写死回环（`127.0.0.1`、`localhost`、机器名）。
**用公网 IP 直连自签证书会报 `ERR_TLS_CERT_ALTNAME_INVALID`** —— 需要域名 + `custom`，或者反向代理。

首次连接时按指纹核对（`GET /api/stats` 的 `tls.fingerprint256` 也是同一个值）：

```bash
openssl s_client -connect 127.0.0.1:8443 -servername localhost < /dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256
```

### 7.3 `trustProxy`：反代部署必须配

```jsonc
{ "trustProxy": ["127.0.0.1"] }
```

填**你自己代理的地址**（IP 或 CIDR，可多项）。

**为什么必须显式配**：服务端所有"按来源 IP 判定"的逻辑（`/api/token` 回环门禁、登录限速）
都建立在 `socket.remoteAddress` 上。同机反代下，公网请求在业务侧看到的对端是**代理自己**
（`127.0.0.1`），于是"只允许本机"对**所有公网请求**成立 —— 任何人 curl 一下就能拿到全权令牌。

三条判定规则：

1. **默认不信任任何代理头**（`trustProxy` 默认空）。空数组等价于"完全忽略 `X-Forwarded-For`"，
   有效 IP 恒等于 socket 地址。乐观默认（"同机就可信"）比不配更糟：出问题时所有证据都指向假来源；
2. **取「最右侧非信任条目」**。XFF 是追加语义 —— 最左边由客户端随便写（可伪造），
   每经过一跳代理在右边追加一条。从右往左跳过已登记的代理，第一个没登记的地址才是能负责的那个；
3. **对端不在 `trustProxy` 里就整个忽略代理头**。带着伪造的 XFF 直连服务端，
   有效 IP 仍是它自己的 socket 地址，伪造没有收益。

非法条目（含 `0.0.0.0/0` 这种全网信）会让**服务拒绝启动**，不静默忽略。

**怎么确认配对了**：`GET /api/stats` 的 `proxy` 有两个数 ——
`entries` 是配置条目数，`trustedProxies` 是**真正匹配上并改写过身份**的对端地址。
只有后者能回答"我的配置到底生效没有"；只看 `entries` 会在"写了但地址写错"时给你虚假的安心。

```json
{ "proxy": { "entries": 1, "trustedProxies": ["127.0.0.1"] } }
```

Nginx 侧记得传头：

```nginx
location / {
    proxy_pass http://127.0.0.1:8730;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
}
```

---

## 8. 数据格式

### 8.1 角色卡 JSON（SillyTavern）

服务端**不重序列化**你上传的字节：按不透明 blob 原样存储、原样返回。
所以你上传时的键序、缩进、转义都会原样保留，`sha256` 也是那份字节的摘要。

支持三种形态：

| 形态 | 识别依据 |
|---|---|
| V2 / V3（`spec: "chara_card_v2"/"chara_card_v3"`，内容在 `data`） | `spec` 字段 |
| 裸 V1（`name` / `description` 直接在顶层） | 无 `spec` 且有 V1 字段 |
| 整卡（含 `character_book`） | 有 `character_book` |

V2 的最小骨架：

```json
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "林晚照",
    "description": "……",
    "personality": "……",
    "scenario": "……",
    "first_mes": "……",
    "mes_example": "……",
    "creator_notes": "……",
    "system_prompt": "……",
    "post_history_instructions": "……",
    "alternate_greetings": [],
    "character_book": { "entries": [ { "keys": ["书店"], "content": "……", "enabled": true } ] },
    "tags": ["日常"],
    "creator": "alice",
    "character_version": "1.0",
    "extensions": { "tcs": { "cardId": "lin-wanzhao-0001" } }
  }
}
```

必填只有 `data.name`（平台规则可另加约束）。缺 ST 缺省字段会出 `info` 级问题，
不阻断；不想要这些提示就传 `includeStDefaults=false`。

**`extensions.tcs.cardId` 是本工具的命名空间**（§5.1）。你可以读写它，但改了 ID 就等于换了一张卡。

### 8.2 世界书条目

条目在 `data.character_book.entries[]`（或独立世界书 JSON 的 `entries[]`）：

```json
{ "id": 3, "keys": ["书店", "旧书"], "secondary_keys": ["林晚照"],
  "content": "……", "enabled": true, "insertion_order": 100,
  "case_sensitive": false, "selective": true, "constant": false,
  "position": "before_char", "depth": 4 }
```

审计侧的结构检查（v0.1.2）：条目 `id` 重复或缺失、`keys: []` 且非常驻、条目数、`depth` 越界等。
规则 id 形如 `mine:depth-range`，`issue.id` 里会拼上条目 id 以便定位。

### 8.3 TXT 世界书格式（可参数化）

标准格式（`default` 预设）长这样：

```
@@ENTRY 0
name: 书店
keys: 书店, 旧书
secondary_keys: 林晚照

@@CONTENT
这是正文，可以多行。
@@END 0
```

**「怎么写」是可配的**（格式预设），「写什么」是平台规则（语义轨）。格式预设能改的八项：

| 参数 | 默认 | 说明 |
|---|---|---|
| `entryOpen` | `@@ENTRY {id}` | 条目开标记，必须含 `{id}` |
| `contentMark` | `@@CONTENT` | 正文开始标记（整行匹配） |
| `entryClose` | `@@END {id}` | 条目闭标记，必须含 `{id}` |
| `fieldOrder` | `name, keys, secondary_keys, …` | 字段行顺序（**只影响写出**，解析认任意顺序） |
| `labelMap` | `{}` | 字段键 → TXT 标签文字（可写成中文「关键词:」） |
| `fieldSeparator` | `": "` | 字段名与值的分隔 |
| `listSeparator` | `", "` | 列表字段（`keys` / `secondary_keys`）的项分隔 |
| `entrySeparator` | 两个换行 | 条目之间 |

`default` 预设的输出与 v1.0 规范**逐字节相同**（有测试钉死）。想适配别的工具，
复制一份预设改参数即可，不用改代码。

> 注意这两种预设**不是同一层资产**，别找错地方：
> **世界书格式预设**住在客户端设置里（内置 `default` + 用户导入的 JSON），
> **不出现在服务端**，也不在 `rules/` 目录下 —— 服务端只在导入/导出 TXT 世界书时
> 消费客户端算好的结果。`rules/presets/*.json` 是**整卡 TXT 预设**（§8.4），
> 那个才是服务端 `GET /api/presets` 返回的东西。

### 8.4 TXT 整卡预设

整卡 TXT（把角色卡写成带标题的纯文本）用「TXT 预设」描述**标题怎么写、映射到哪个板块**：
标题行、字段标签、板块归属都在预设里。`GET /api/presets` 列出可用预设与默认 id，
上传时用 `?preset=` 指定。

**重要语义（v0.1.2）**：导入不再因"板块不全"失败。**原文零丢失**：

- 一个板块都没认出来 → 整篇原文**逐字节**进【其他设定】；
- 认出至少一个 → 未识别的片段（标题行 + 正文作为整体）按原序放进【其他设定】下方，
  前面加一行分隔符 `════════════ 以下内容为未识别的板块数据，请自行排版 ════════════`（只出现一次）；
- 首个标题之前的前言同样保留；世界书不参与搬运（走它自己的结构化解析）。

分隔符是格式标记，**幂等**：导出再导入不会多一个，也不会把片段重复叠一份。
如果你要写 TXT 生成器，`preset` 里描述的就是"怎么写"，别把这两条语义搞反。

---

## 9. 版本与兼容性

### 9.1 v0.1.1 → v0.1.2 变更点

| 项 | v0.1.1 | v0.1.2 |
|---|---|---|
| 身份 | 只有全局令牌 | + 账户（JWT access/refresh）+ 仓库令牌 |
| 全局令牌权限 | 全部卡片 | **仅未归属卡片**（`owner_id = ''`） |
| 归属不匹配 | `403` | **`404`**（与"不存在"逐字节相同） |
| 仓库令牌列仓库 | 能列全部（越权） | `403` |
| 权限校验 | 签发时一次 | **逐请求**（改小/吊销立即生效） |
| `DELETE` 物理删除 | `?hard=true` 任何写权限可用 | 仅管理员；正名 `POST /purge` |
| 删除 | 直接删 | 三层：软删 → 恢复 → `purge`；`prune` 清版本内容 |
| 认证端点 | 无 | `/api/auth/{config,login,refresh,register,logout,me}` |
| 仓库 / 令牌管理 | 无 | `/api/repos*`、`/api/tokens/:id` |
| 审计类别 | 四类 | + `worldbook`（第五类） |
| TXT 导入 | 严格模式失败即中止 | 原文零丢失（§8.4） |
| 世界书格式 | 写死 | 八参数可配（§8.3） |
| TLS | 无 | `off` / `selfsigned` / `custom`，独立 `httpsPort` |
| `trustProxy` | 无（同机反代漏洞） | 显式白名单 + 最右侧非信任条目 |

### 9.2 升级时要注意的三件事

1. **跑过 `user migrate` / `user adopt` 之后，全局令牌就看不到那些卡了**。
   它们归到了账户名下 —— 这是归属已明确的正确表现，不是故障。
   需要运维级访问时用 `user adopt`（有日志、有归属），不要放宽 scope。
2. **旧卡片是"未归属"状态**，只有全局令牌能看到。要么 `user adopt <用户名>` 一次划归，
   要么就用全局令牌继续操作（单账户环境行为不变）。
3. **同版本号的 MSI 不能靠"重装"来刷新文件**：Windows Installer 对相同 ProductVersion
   的 `/i` 只做维护安装，不会替换或新增文件。要刷新请用
   `msiexec /i <msi> REINSTALL=ALL REINSTALLMODE=amus`。

### 9.3 API 版本

`GET /api/health` 里的 `apiVersion` 目前是 **`"v1"`**（字符串，不是数字）。
破坏性变更会递增它；新增字段、新增端点不算破坏性变更（客户端应忽略不认识的字段）。
响应头里也带 `X-TCS-API-Version: v1`，可以只看头就判断。

---

## 10. 最小可跑通流程

从零到"上传一张卡并读回字节"，全程 curl：

```bash
API=http://127.0.0.1:8730

# 1) 探活（免鉴权）
curl.exe -s $API/api/health

# 2) 建号（首次；服务端上执行，见 server-cmd.md）
#    & $tcs user migrate admin

# 3) 登录拿 JWT
curl.exe -s -X POST $API/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"你的密码"}'
# → 记下 accessToken / refreshToken

# 4) 看自己有哪些仓库（拿到 repoId）
curl.exe -s $API/api/repos -H "Authorization: Bearer $ACCESS"

# 5) 签一把 CI 用的仓库令牌（原文只出现一次）
curl.exe -s -X POST $API/api/repos/$REPO/tokens \
  -H "Authorization: Bearer $ACCESS" -H "Content-Type: application/json" \
  -d '{"name":"CI","scopes":["read","write"]}'

# 6) 用仓库令牌上传（带 cardId → 不存在则新建 201）
curl.exe -s -X POST "$API/api/cards?cardId=lin-wanzhao-0001&message=初版" \
  -H "Authorization: Bearer $TCREPO" -H "Content-Type: application/json" \
  --data-binary @lin-wanzhao.json

# 7) 读回原始字节，确认与上传的逐字节相同
curl.exe -s "$API/api/cards/lin-wanzhao-0001/raw" -H "Authorization: Bearer $TCREPO" \
  -o roundtrip.json
sha256sum lin-wanzhao.json roundtrip.json   # 两个哈希应相同

# 8) 再传一次（同一 cardId）→ 200，追加一个版本
curl.exe -s -X POST "$API/api/cards?cardId=lin-wanzhao-0001&baseSeq=1" \
  -H "Authorization: Bearer $TCREPO" -H "Content-Type: application/json" \
  --data-binary @lin-wanzhao-v2.json

# 9) 看两层 diff
curl.exe -s "$API/api/cards/lin-wanzhao-0001/diff?from=1&to=2" -H "Authorization: Bearer $TCREPO"
```

第 7 步的哈希比对值得每次都做：它同时验证了"上传没被改写"和"下载没被转码"。
这是这个服务端最核心的承诺 —— **存取的是同一份字节**。

---

## 维护约定

本文与实现同版本演进：端点、错误码、限速参数一变，本文必须同提交更新。
`test/ops-doc.test.mjs` 会校验 `.gitignore` 的放行清单、命令文档与 CLI 命令面一致；
本文的端点清单以 `server/src/http/app.ts` 与 `server/src/http/auth-routes.ts` 的实际注册为准，
错误码以 `server/src/errors.ts` 的 `ErrorCode` 联合类型为准。

改动本文时的两条硬要求：

1. **示例必须能跑**。写 curl 示例时用真实存在的路径与字段名，别写"示意"—— 读者会照抄。
2. **别引用未上传的文档**。`docs/` 下只有 `server-cmd.md` 与本文会随仓库分发，
   其余都是本地开发文档，在 GitHub 上是 404。
