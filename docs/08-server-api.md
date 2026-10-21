# 服务端 API 规范（阶段 5 · T5.1–T5.6）

> 适用版本：`tcs-server 0.1.0`，API `v1`。
> 本文与实际实现一一对应；请求/响应范例由 [`scripts/demo-server.mjs`](../scripts/demo-server.mjs) 对真实服务录制，
> 原始样本见 [`assets/api-examples.json`](assets/api-examples.json)，完整演示见 [`assets/server-demo.md`](assets/server-demo.md)。

---

## 1. 进程模型

服务端拆成两个进程，各自监听一个端口：

```
                    ┌──────────────────────────────────────────────┐
  浏览器 ──────────▶│ supervisor（控制面，controlPort 默认 8731）    │
                    │  · 管理面板静态页（server/public）             │
                    │  · /control/*  启停 / 配置 / 日志 / 令牌       │
                    │  · /api/* 反向代理 ───────────────────────┐   │
                    └───────────────────────────────────────────┼───┘
                                                                │
                    ┌───────────────────────────────────────────▼───┐
  Electron 客户端 ─▶│ worker（数据面，port 默认 8730）               │
                    │  · /api/*  CRUD / 版本 / diff / 回滚 / 审计     │
                    │  · SQLite 索引 + blob 仓库 + 每卡一个 Git 裸仓库 │
                    └───────────────────────────────────────────────┘
```

**为什么拆开**：需求要求面板能「启动 / 停止 / 重启后台服务」。如果面板跑在被停止的进程里，点「停止」后面板就再也回不来。拆开之后 worker 可被独立停止，面板仍在线，三个按钮才是真的可用。

- worker 由 supervisor 用 `process.execPath` 拉起（同一 Node 运行时），通过 IPC 发送 `shutdown` 做优雅退出；
- worker 意外崩溃时 supervisor 自动拉起（1 分钟内最多 3 次，超过则停在 `crashed` 并提示看日志）；
- `tcs-server worker` 可单独运行数据面（调试用），此时没有管理面板。

---

## 2. 两条硬约束的落地

### 2.1 上传字节按不透明 blob 存储，服务端绝不重序列化

| 环节 | 做法 |
|---|---|
| 接收 | `POST` 请求体直接读成 `Buffer`（`readRawBody`），**不支持 `multipart/form-data`**（返回 `415`）。元数据只从 query 取 |
| 落盘 | `sha256(bytes)` → `dataDir/blobs/<前2位>/<sha256>`，内容寻址、只写一次、读取时校验摘要 |
| 版本 | Git 裸仓库提交里放 `card.json` = 上传字节原样。写对象走 `writeBlob → writeTree → writeCommit → writeRef`，不经过工作区与 index |
| 解析 | `JSON.parse` + `parseStCard` **只用于**：生成卡片名/规范版本等索引字段、生成审计报告 |
| 读取 | `GET .../raw` 直接返回 blob 字节，附 `ETag`/`X-TCS-Sha256` |
| 对比 | `diff` 的字节层用两份 blob 的 sha256 与首个差异偏移；行层按原始字节切行（保留行尾） |

因此：**同一份字节上传两次，sha256 相同；回滚到某版本时，新版本字节与目标版本逐字节相等。**

代码位置：`server/src/storage/blobs.ts`、`server/src/storage/git-store.ts`、`server/src/storage/cards.ts`。

> 唯一被序列化的是**审计报告**（`JSON.stringify(report)`），它是服务端生成的新产物，不是卡片正文。

### 2.2 审计报告随版本快照存储

每次提交（上传 / 新版本 / 回滚）都会：

1. 用当时的平台规则与预设跑 `buildAuditReport`；
2. 把报告字节写入 blob，sha256 记在 `versions.audit_sha256`；
3. 同一份报告作为 `audit.json` 一起进入 Git 提交。

于是 `GET /api/cards/:id/audit?version=2` 返回的是**当时**的结论，而不是用今天的规则重新审判旧版本。需要按现行规则复核时用 `?refresh=true`，它只读重算、不覆盖快照。

---

## 3. 鉴权（T5.6）

- 所有 `/api/*` 与 `/control/*` 都需要 Bearer token，只有 `/api/health`、`/healthz` 与管理面板静态资源公开。
- 令牌在首次启动时随机生成并写入配置文件（`--config` 指定的路径，默认 `./data/config.json`）的 `auth.token`；可用 `tcs-server token show` 查看、`token rotate` 轮换。
- 支持两种请求头：
  ```
  Authorization: Bearer <token>
  X-API-Token: <token>
  ```
- 不接受 `?token=`（会进访问日志与浏览器历史）。
- 比较使用 sha256 + `timingSafeEqual`；同一 IP 5 分钟内失败 20 次将封禁 5 分钟（`429` + `Retry-After`）。
- 监听非回环地址（如 `0.0.0.0`）时，配置校验强制 `auth.require = true`，否则拒绝启动。

```http
GET /api/auth/verify
Authorization: Bearer <token>

HTTP/1.1 200 OK
{
  "ok": true,
  "auth": { "mode": "bearer-token", "required": true },
  "server": { "version": "0.1.0", "apiVersion": "v1", "pid": 12345 }
}
```

---

## 4. 通用约定

### 4.1 响应

- 成功：`application/json; charset=utf-8`，UTF-8，2 空格缩进（便于人读，也便于 diff）。
- 失败：统一形状
  ```json
  { "error": { "code": "CARD_PARSE_FAILED", "message": "JSON 解析失败", "details": { "offset": 42, "line": 3, "column": 5 } } }
  ```
- 原始字节接口（`raw`、`audit`）返回 `application/octet-stream` / `application/json` 的**原始内容**，不做二次包装。

### 4.2 版本标识

`version` / `rev` 参数接受三种写法：

| 写法 | 含义 |
|---|---|
| 省略或 `latest` | 最新版本 |
| 数字（`1`、`2`） | 版本序号，从 1 开始，同一张卡单调递增 |
| 提交 sha（≥4 位，可缩写） | Git 提交 id；在卡内唯一 |

### 4.3 分页

`limit`（默认 50，最大 500）、`offset`（默认 0）。列表响应带 `total`。

### 4.4 时间与字符

- 所有时间为 ISO 8601 UTC（`2026-10-21T05:37:18.070Z`）。
- 行号/列号均为 1-based，列按码点计（与阶段 4 审计报告一致）。

---

## 5. API 清单

| # | 方法 | 路径 | 说明 | 作用域 |
|---|---|---|---|---|
| 1 | `GET` | `/api/health` | 健康检查（免鉴权） | worker |
| 2 | `GET` | `/api/auth/verify` | 验证令牌 | worker |
| 3 | `GET` | `/api/stats` | 卡片/版本/字节/blob 统计 | worker |
| 4 | `GET` | `/api/events` | 最近操作事件 | worker |
| 5 | `GET` | `/api/platforms` | 平台规则列表 | worker |
| 6 | `GET` | `/api/presets` | TXT 预设列表 | worker |
| 7 | `GET` | `/api/cards` | 卡片列表（`q` 搜索、分页） | worker |
| 8 | `POST` | `/api/cards` | 上传新卡（原始字节） | worker |
| 9 | `GET` | `/api/cards/:id` | 卡片详情 | worker |
| 10 | `DELETE` | `/api/cards/:id` | 删除（默认软删，`?hard=true` 彻底删） | worker |
| 11 | `GET` | `/api/cards/:id/raw` | 下载原始字节 | worker |
| 12 | `GET` | `/api/cards/:id/versions` | 版本历史 | worker |
| 13 | `POST` | `/api/cards/:id/versions` | 提交新版本（原始字节） | worker |
| 14 | `GET` | `/api/cards/:id/versions/:rev` | 单个版本元数据 | worker |
| 15 | `GET` | `/api/cards/:id/versions/:rev/raw` | 指定版本原始字节 | worker |
| 16 | `GET` | `/api/cards/:id/diff` | 版本对比（字节/行/JSON 三层） | worker |
| 17 | `POST` | `/api/cards/:id/rollback` | 回滚（新建提交） | worker |
| 18 | `GET` | `/api/cards/:id/audit` | 审计快照（`?refresh=true` 重算） | worker |
| 19 | `POST` | `/api/audit` | 审计任意字节（不入库） | worker |
| 20 | `GET` | `/control/status` | 服务/配置/进程状态 | supervisor |
| 21 | `POST` | `/control/service/:action` | `start` / `stop` / `restart` | supervisor |
| 22 | `GET` | `/control/config` | 读取配置（token 掩码） | supervisor |
| 23 | `PUT` | `/control/config` | 修改配置（落盘，部分需重启） | supervisor |
| 24 | `POST` | `/control/token/rotate` | 轮换令牌并重启 worker | supervisor |
| 25 | `POST` | `/control/token/reveal` | 显示当前令牌（本机管理用） | supervisor |
| 26 | `GET` | `/control/logs` | worker stdout/stderr 尾部 | supervisor |
| 27 | `GET` | `/` | 管理面板 | supervisor |

---

## 6. 卡片 CRUD（T5.1）

### 6.1 上传 `POST /api/cards`

请求体是**文件原始字节**，元数据全部在 query：

| query | 说明 |
|---|---|
| `message` | 版本消息，默认「初始版本」 |
| `author` | 版本作者，默认 `Tavern Card Studio` |
| `filename` | 原始文件名（只做记录） |
| `platform` / `preset` | 审计所用规则，缺省用服务端配置 |
| `includeStDefaults` | `false` 可关闭「ST 缺省字段」info 提示 |

```http
POST /api/cards?message=导入初版&author=演示脚本&filename=sample-card.json
Content-Type: application/json
Authorization: Bearer <token>

<sample-card.json 的原始字节>
```

```http
HTTP/1.1 201 Created
Location: /api/cards/card-23a4e7
X-TCS-Card-Id: card-23a4e7

{
  "card": {
    "id": "card-23a4e7",
    "name": "林晚照",
    "spec": "v2",
    "specVersion": "2.0",
    "tags": ["日常", "治愈", "书店"],
    "createdAt": "2026-10-21T05:41:50.812Z",
    "versionCount": 1,
    "latest": {
      "seq": 1,
      "commit": "cd5997673005df8473cd610f99756965d00f8110",
      "sha256": "c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68",
      "size": 3922,
      "message": "导入初版",
      "createdAt": "2026-10-21T05:41:50.812Z"
    },
    "audit": { "sha256": "7acd…", "generatedAt": "…", "error": 0, "warning": 0, "info": 2, "exportable": true }
  },
  "version": { "seq": 1, "kind": "upload", "…": "同 latest" }
}
```

失败情形：

| 状态 | code | 触发条件 |
|---|---|---|
| `400` | `BAD_REQUEST` | 请求体为空、`message` 超长等 |
| `413` | `PAYLOAD_TOO_LARGE` | 超过 `maxUploadBytes`（默认 32 MiB） |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | `multipart/form-data`（见 §2.1） |
| `422` | `CARD_PARSE_FAILED` | 非 UTF-8、JSON 非法、不是角色卡、结构错误；`details` 带行列 |

> 422 时**不落任何数据**：不会产生卡片、blob 或 git 提交。

### 6.2 列表 `GET /api/cards`

```http
GET /api/cards?q=林&limit=20&offset=0
Authorization: Bearer <token>

HTTP/1.1 200 OK
{
  "total": 1,
  "limit": 20,
  "offset": 0,
  "items": [
    {
      "id": "card-23a4e7",
      "name": "林晚照",
      "spec": "v2",
      "versionCount": 3,
      "updatedAt": "2026-10-21T05:41:51.402Z",
      "latest": { "seq": 3, "sha256": "c3e8…", "message": "回滚到初版（演示）" },
      "audit": { "error": 0, "warning": 0, "info": 2, "exportable": true, "generatedAt": "…", "sha256": "…" },
      "deletedAt": null
    }
  ]
}
```

`q` 同时匹配名称与 id；`includeDeleted=true` 可看到软删卡片。

### 6.3 原始字节 `GET /api/cards/:id/raw`

```http
GET /api/cards/card-23a4e7/raw?version=latest
Authorization: Bearer <token>

HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="card-23a4e7-v3.json"
ETag: "c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68"
X-TCS-Sha256: c3e85b1571b207d741fa55b80cc3d354a33bcb1cb1ee23e71aef26023d663b68
X-TCS-Size: 3922

<原始字节>
```

客户端可先比对 `X-TCS-Sha256` 再落盘；`?inline=1` 把 `Content-Disposition` 改为 `inline`。

### 6.4 删除 `DELETE /api/cards/:id`

- 默认**软删除**：`deleted_at` 置位，列表/详情/写操作返回 `404`，历史仍可恢复；
- `?hard=true`：删除 Git 裸仓库与索引记录（blob 作为内容寻址存储保留，供其他版本去重使用）。

```json
{ "deleted": true, "id": "card-23a4e7", "hard": false }
```

---

## 7. 版本控制（T5.2）

### 7.1 提交新版本 `POST /api/cards/:id/versions`

请求体同样是原始字节，query 同上传。返回 `201` + 版本对象（`kind: "update"`）。

```http
POST /api/cards/card-23a4e7/versions?message=调整叙述风格&author=演示脚本
Content-Type: application/json

<修改后的原始字节>
```

```json
{
  "seq": 2,
  "commit": "a718200…",
  "sha256": "b6d273…",
  "size": 3931,
  "message": "调整叙述风格",
  "author": "演示脚本",
  "kind": "update",
  "parentCommit": "cd59976…",
  "createdAt": "2026-10-21T05:41:50.980Z",
  "audit": { "sha256": "857446…", "generatedAt": "…", "error": 0, "warning": 0, "info": 2, "exportable": true },
  "auditError": null,
  "meta": {}
}
```

同一份字节也可以再提交一次：会产生新提交（历史如实记录），但 diff 判定 `identical: true`。服务端不会因为「内容没变」而拒绝提交，也不会偷偷合并。

### 7.2 历史 `GET /api/cards/:id/versions`

按 `seq` 倒序。每项含审计摘要与 `kind`（`upload` / `update` / `rollback`）。

### 7.3 三层 diff `GET /api/cards/:id/diff?from=1&to=2`

| 参数 | 说明 |
|---|---|
| `from` | 旧版本，缺省为 `to.seq - 1` |
| `to` | 新版本，缺省 `latest` |
| `include` | 逗号分隔：`bytes,lines,json`，缺省全给 |
| `context` | 行 diff 上下文行数，默认 3，最大 20 |

响应：

```json
{
  "from": { "seq": 1, "commit": "cd59976…", "sha256": "c3e8…" },
  "to":   { "seq": 2, "commit": "a718200…", "sha256": "b6d2…" },
  "identical": false,
  "bytes": {
    "identical": false,
    "fromSha256": "c3e85b15…",
    "toSha256": "b6d27339…",
    "fromSize": 3922,
    "toSize": 3931,
    "sizeDelta": 9,
    "firstDiffOffset": 162,
    "commonPrefix": 162,
    "commonSuffix": 3760
  },
  "lines": {
    "added": 2,
    "removed": 2,
    "truncated": false,
    "oldLineCount": 68,
    "newLineCount": 68,
    "equalLinesButDifferentBytes": false,
    "hunks": [
      {
        "oldStart": 3, "oldLines": 4, "newStart": 3, "newLines": 4,
        "header": "@@ -3,4 +3,4 @@",
        "lines": [
          { "kind": "context", "text": "  \"spec_version\": \"2.0\",\n", "display": "  \"spec_version\": \"2.0\",", "oldLine": 3, "newLine": 3 },
          { "kind": "del", "text": "    \"name\": \"林晚照\",\n", "display": "    \"name\": \"林晚照\",", "oldLine": 4, "newLine": null },
          { "kind": "add", "text": "    \"name\": \"林晚照（改）\",\n", "display": "    \"name\": \"林晚照（改）\",", "oldLine": null, "newLine": 4 }
        ]
      }
    ]
  },
  "json": {
    "parsed": true,
    "truncated": false,
    "changes": [
      { "path": "data.name", "kind": "changed", "before": "林晚照", "after": "林晚照（改）" },
      { "path": "data.extensions.depth_prompt.prompt", "kind": "changed", "before": "保持安静克制的叙述风格。", "after": "保持安静克制的叙述风格，句尾常用省略号。" }
    ]
  }
}
```

三层各自的语义：

- **bytes**：唯一能回答「是否逐字节相同」的一层。行 diff 为空的场景（例如只改了换行风格）它仍会指出 `identical: false` 与首个差异偏移；
- **lines**：按 `\n` 切分、**保留行尾**（`\r\n` 与 `\n` 会被视为不同行内容），`display` 去掉行尾便于显示；
- **json**：解析后按 JSON 路径列字段改动；数组按索引比较；任一侧解析失败时 `parsed: false`，不影响另外两层。

### 7.4 回滚 `POST /api/cards/:id/rollback`

```http
POST /api/cards/card-23a4e7/rollback
Content-Type: application/json

{ "to": 1, "message": "回滚到初版（演示）" }
```

```json
{
  "version": { "seq": 3, "kind": "rollback", "sha256": "c3e85b15…", "meta": { "rollbackOf": 1, "rollbackCommit": "cd59976…" } },
  "restoredFrom": { "seq": 1, "commit": "cd59976…" }
}
```

语义：

1. 读取目标版本的 blob（校验 sha256）；
2. 以**相同字节**创建一个新提交，父提交是当前最新；
3. 不删除、不改写中间版本；`seq` 继续递增；
4. 写完后再次比对字节，不一致即报 `500 BLOB_CORRUPTED`（宁可失败也不写坏历史）。

因此 `GET /diff?from=1&to=3` 必然 `identical: true`，且 Git 里 `git diff v1 v3 -- card.json` 为空。

---

## 8. 审计（T5.3）

### 8.1 审计任意字节 `POST /api/audit`

请求体是卡片原始字节，**不落库**，适合客户端导出前自检或服务端预检。

```http
POST /api/audit?platform=ccv2&preset=default
Content-Type: application/json

<原始字节>
```

响应就是 `buildAuditReport` 的完整报告（与阶段 4 的 `AuditReport` 结构一致）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-21T05:41:51.120Z",
  "card": { "name": "林晚照", "spec": "v2", "specVersion": "2.0", "source": "upload" },
  "platformRule": { "id": "ccv2", "name": "Character Card V2", "version": "1.0.0", "lineage": ["sillytavern", "ccv2"] },
  "presetId": "default",
  "wordCount": {
    "blocks": [{ "blockId": "basic", "label": "基本信息", "chars": 63, "totalWords": 55, "empty": false, "missing": false }],
    "total": { "chars": 394, "charsNoSpace": 378, "cjk": 251, "words": 17, "totalWords": 268 },
    "byField": { "description": { "totalWords": 213 }, "personality": { "totalWords": 35 }, "character_book": { "totalWords": 20 } }
  },
  "issues": [
    {
      "id": "…",
      "ruleId": "char-placeholder-suggested",
      "category": "platform-rule",
      "severity": "info",
      "message": "正文中未出现 {{char}} 占位符…",
      "location": { "blockId": "settings", "field": "description", "start": 0, "end": 40, "line": 1, "column": 1 }
    }
  ],
  "summary": { "error": 0, "warning": 0, "info": 2, "exportable": true },
  "byCategory": { "completeness": 0, "format": 1, "platform-rule": 1, "structure": 0 }
}
```

响应头 `X-TCS-Audit-Source: ad-hoc`、`X-TCS-Card-Sha256: <sha256>`。

### 8.2 版本审计快照 `GET /api/cards/:id/audit?version=2`

- 默认读取**提交时存储**的报告字节（响应头 `X-TCS-Audit-Source: snapshot`、`X-TCS-Audit-For-Version: 2`、`ETag` 为报告 sha256）；
- 重复读取逐字节一致；
- `?refresh=true`：用当前规则重新审计同一版本，返回 `X-TCS-Audit-Source: recomputed` 与 `X-TCS-Audit-Snapshot`（原快照 sha256），**不写回**；
- 版本没有快照时返回 `404`，`details.auditError` 说明原因。

### 8.3 规则列表

`GET /api/platforms` / `GET /api/presets` 返回可用规则与默认 id；规则文件损坏时在 `errors` 里列出而不影响其他规则。

---

## 9. 控制面 API（T5.4）

> 这些接口由 supervisor 提供，端口为 `controlPort`（默认 `port + 1`）。

### 9.1 状态

```http
GET /control/status
Authorization: Bearer <token>
```

```json
{
  "role": "supervisor",
  "version": "0.1.0",
  "apiVersion": "v1",
  "pid": 12345,
  "node": "v22.22.2",
  "startedAt": "2026-10-21T05:41:49.000Z",
  "uptimeMs": 5200,
  "worker": {
    "state": "running",
    "pid": 12346,
    "startedAt": "2026-10-21T05:41:49.300Z",
    "uptimeMs": 4900,
    "restarts": 0,
    "lastExit": null,
    "lastError": null,
    "health": { "status": "ok", "version": "0.1.0", "uptimeMs": 4800 },
    "url": "http://127.0.0.1:8730"
  },
  "config": { "port": 8730, "controlPort": 8731, "host": "127.0.0.1", "controlHost": "127.0.0.1", "…": "…" },
  "paths": { "dataDir": "…", "configFile": "…", "logFile": "…", "workerLogFile": "…" },
  "urls": { "panel": "http://127.0.0.1:8731/", "api": "http://127.0.0.1:8730" }
}
```

`worker.state` ∈ `stopped` / `starting` / `running` / `stopping` / `crashed`。

### 9.2 启停

```http
POST /control/service/start
POST /control/service/stop
POST /control/service/restart
Authorization: Bearer <token>
```

返回 `{ "action": "stop", "worker": { "state": "stopped", … } }`。

- `stop` 先通过 IPC 让 worker 关 HTTP server、关 SQLite，再退出（5 秒不退则强制终止）；
- worker 停止期间，面板静态页仍可访问；`/api/*` 立即返回 `503 SERVICE_UNAVAILABLE`；
- `restart` = 优雅停止 + 重新拉起。

### 9.3 配置

```http
GET /control/config

PUT /control/config
Content-Type: application/json
{ "port": 8730, "controlPort": 8731, "host": "127.0.0.1", "controlHost": "127.0.0.1", "maxUploadBytes": 33554432, "logLevel": "info", "auth": { "require": true }, "service": { "mode": "windows-service", "autoStart": true } }
```

```json
{
  "config": { "…": "…", "auth": { "require": true, "tokenMasked": "AbCd…WxYz" } },
  "workerRestartRequired": true,
  "supervisorRestartRequired": false,
  "note": "数据面参数修改需要重启后台服务（面板「重启」按钮即可）"
}
```

- 只接受已知字段；非法值（如端口相同、端口越界、非回环且关闭鉴权）返回 `400`，原配置不变；
- `controlPort` / `controlHost` 变更需要重启 supervisor（Windows 服务：`sc.exe stop/start`）；
- `host` 只影响 worker（API），`controlHost` 只影响 supervisor（面板）。改一个不会连带改另一个。

#### `host` 与 `controlHost` 为什么必须分开

| 字段 | 影响的端口 | 谁来连 |
|---|---|---|
| `host` | `port`（8730，数据面 worker） | 客户端、局域网里的其他机器 |
| `controlHost` | `controlPort`（8731，控制面 supervisor） | 只应是你本机的浏览器 |

早先两者共用 `host`，导致一个真实的安全问题：**把 API 开给局域网，会连带把管理面板
也暴露出去**。面板的静态资源（`/`、`/app.js`、`/styles.css`）在 `PANEL_PUBLIC_PATHS` 里是
**免鉴权**的 —— 实测 `host=0.0.0.0` 时，从局域网 IP `GET http://<lan-ip>:8731/` 返回 **200**，
只有 `/control/*` 才要 token。虽然 token 挡住了真正的操作，但「管理界面出现在局域网」
本身就不该发生。

拆开之后默认行为是安全的：

```
host        = 0.0.0.0     →  netstat 显示 0.0.0.0:8730     局域网可访问 API
controlHost = 127.0.0.1   →  netstat 显示 127.0.0.1:8731   局域网连不上面板
```

`controlHost` 的缺省值**不跟随 `host`**：老配置（`host` 已是 `0.0.0.0`、没有这个键）
读进来时面板自动落到 `127.0.0.1`，升级即修复，不需要用户改配置 ——
这一点有回归测试钉住（`test/server-host-separation.test.mjs`）。

如果确实需要远程运维，把 `controlHost` 也设成非回环地址即可，但 `auth.require` 必须为 `true`，
否则启动会被拒绝（见 `assertSafeConfig`）。


### 9.4 令牌

```http
POST /control/token/rotate
Authorization: Bearer <token>

{ "token": "<新令牌，只显示这一次>", "worker": { "state": "running" } }
```

旧令牌立即失效，worker 自动重启以加载新配置。`POST /control/token/reveal` 返回当前令牌（面板「显示」按钮用）。

### 9.5 日志

`GET /control/logs?lines=300` 返回 supervisor 捕获的 worker stdout/stderr 尾部（内存环形缓冲，最多 2000 行）；完整日志在 `dataDir/logs/server.log` 与 `worker.out.log`。

---

## 10. 错误码

| code | HTTP | 说明 |
|---|---|---|
| `BAD_REQUEST` | 400 | 参数缺失/非法 |
| `UNAUTHORIZED` | 401 | 缺少或错误 token |
| `FORBIDDEN` | 403 | 预留（当前无多用户权限） |
| `NOT_FOUND` | 404 | 卡片/版本/接口不存在 |
| `GONE` | 410 | 预留（已彻底删除的卡片目前直接 404） |
| `CONFLICT` | 409 | 预留（如未来加并发写冲突检测） |
| `PAYLOAD_TOO_LARGE` | 413 | 超过上传上限 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | multipart 上传 |
| `TOO_MANY_REQUESTS` | 429 | 鉴权失败过多 |
| `CARD_PARSE_FAILED` | 422 | 字节不是合法角色卡；带解析位置 |
| `UNKNOWN_PLATFORM` | 400 | `platform` 不存在，`details.available` 列出可用 id |
| `UNKNOWN_PRESET` | 400 | `preset` 不存在 |
| `BLOB_CORRUPTED` | 500 | blob 缺失或摘要不符 |
| `SERVICE_UNAVAILABLE` | 503 | worker 未运行 |
| `INTERNAL` | 500 | 未预期错误（不泄露堆栈） |

---

## 11. 数据模型

```ts
interface CardSummary {
  id: string; name: string; spec: string; specVersion: string;
  creator: string; tags: string[]; sourceFilename: string;
  createdAt: string; updatedAt: string; deletedAt: string | null;
  versionCount: number;
  latest: { seq: number; commit: string; sha256: string; size: number; message: string; createdAt: string } | null;
  audit: { sha256: string; generatedAt: string; error: number; warning: number; info: number; exportable: boolean } | null;
  auditError: string | null;
}

interface Version {
  seq: number; commit: string; sha256: string; size: number;
  message: string; author: string; kind: 'upload' | 'update' | 'rollback' | 'import';
  parentCommit: string | null; createdAt: string;
  audit: { … } | null; auditError: string | null;
  meta: Record<string, unknown>;
}
```

`sha256` 始终是**卡片字节**的摘要（不是 Git blob id）；Git 对象 id 在 `commit` 字段。

---

## 12. 存储布局

```
<configDir>/
  config.json                 # 端口 / token / 服务名 / 数据目录…（位置由 --config 决定）

<dataDir>/                    # 默认 = <configDir>/store，由配置文件位置推导，与 cwd 无关
  state.db                    # SQLite：cards / versions / events
  blobs/<ab>/<sha256>         # 卡片字节 + 审计报告字节（内容寻址）
  repos/<cardId>.git/         # 标准 Git 裸仓库，每个提交含 card.json + audit.json
  logs/server.log             # supervisor / worker 结构化日志
  logs/worker.out.log         # worker stdout/stderr
  tmp/                        # 上传/审计临时文件
```

> `dataDir` 默认取「配置文件同级的 `store`」而不是 cwd：Windows 服务以 LocalSystem 启动时
> cwd 是 `C:\Windows\System32`，跟随 cwd 会把数据写进 System32。见 [docs/09 §5.1](09-server-deploy.md)。

备份时三者要一起：`blobs/`、`repos/`、`state.db`（含 `-wal`/`-shm`，建议先停服务或 `sqlite3 .backup`）。只要 `repos/` + `blobs/` 在，即使 `state.db` 丢失也能从 Git 重建索引（`repair` 子命令尚未实现，见 §13）。

---

## 13. 已知边界

- **不做内容合规校验**：审计范围严格按需求（字数、完整性、格式、平台规则），不做敏感内容判断。
- **单用户 / 单租户**：一个 token 即全部权限，没有账号体系与 RBAC。
- **无 TLS**：默认只听 `127.0.0.1`。需要跨机访问时请放在反向代理（Caddy/Nginx）后面并启用 HTTPS；此时必须开鉴权。
- **blob 不做 GC**：硬删除卡片不会删除 blob（可能被其他卡引用，且去重存储）。磁盘清理需离线脚本。
- **版本号只在单卡内唯一**：`seq` 是卡片内序号，不是全局版本号。
- **不自动修复**：审计只报告，不回写卡片；修复由客户端完成后再提交新版本。
- **超大文件**：diff 行级比较有 400 万单元格上限，超过后退化为「公共前后缀 + 中间整体替换」，并置 `lines.truncated: true`。
