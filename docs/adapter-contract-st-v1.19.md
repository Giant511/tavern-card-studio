# SillyTavern 1.19 适配器契约（v0.1.7 施工图）

> 本文是 T15.5（自研聊天面板）的动工许可，也是 T15.4（st-adapter + 契约测试）的断言来源。
> **未获用户确认功能边界之前，不写聊天面板 UI。**
>
> 所有结论都标了「文件:行号」，行号取自本机 ST 1.19.0 源码树（下文 §1 给出校验方法）。
> 行号会随 ST 升级漂移，所以 §8 的契约测试按**形状**断言，不按行号断言。

---

## 1. 被测版本与出处校验

| 项 | 值 |
|---|---|
| ST 版本 | `1.19.0`（`package.json` 的 `version`） |
| Node 要求 | `>= 20`（`package.json` 的 `engines`） |
| 源码树 | `SillyTavern/`（本机为 `D:\SillyTavern`，不在仓库内） |
| 校验命令 | `grep -m1 '"version"' package.json` → 应为 `"version": "1.19.0"` |

**契约测试第一件事就是把这一行读出来比对**。ST 升版而适配器没跟，测试必须先红，
而不是等到用户在手机上发现消息发不出去。

---

## 2. 连接与会话（所有调用的前提）

### 2.1 监听地址

`listen` 默认 `false`，此时**只绑 `127.0.0.1`**：

```js
// src/command-line.js:331
this.listen ? (isValid ? this.listenAddressIPv4 : '0.0.0.0') : '127.0.0.1'
```

移动端要求「只绑 127.0.0.1」，所以启动参数里**不要**传 `--listen`，
也不要写 `listenAddress.ipv4`。这一条是 T15.3 的硬约束，spike ① 必须实测确认
（`netstat` 只看得到 `127.0.0.1:8000`，看不到 `0.0.0.0:8000`）。

### 2.2 认证链

```text
GET  /csrf-token          → { token }        （src/server-main.js:192-196；未登录也可取）
POST /api/**              → 需 session cookie + X-CSRF-Token
```

| 项 | 值 | 出处 |
|---|---|---|
| CSRF header 名 | `X-CSRF-Token` | `src/server-main.js:177`（读 `req.headers['x-csrf-token']`） |
| session cookie | ST 的 `cookieSession`，`SameSite=Lax` | `src/server-main.js:156` |
| 关闭 CSRF 的开关 | `--disableCsrf` 或 `config.yaml` 的 `disableCsrfProtection` | `src/command-line.js:316` |

**移动端的关键抉择**：`SameSite=Lax` 在「App 内嵌 webview 里的 iframe」场景会失效
（v0.1.6 缺陷三已经踩过，见 `memory.md` §20）。但本版本走的是 **Rust 侧 HTTP**
（不是 webview 发起请求），cookie 由 Rust 的 cookie jar 直接持有并附在请求头里，
**不经过浏览器同源策略**，所以：

- ✅ 不需要再改 `SameSite=None`；
- ✅ 不需要 webview；
- ⚠️ 但 Rust 侧必须自己维护 cookie 过期（见 §7 陷阱 8）。

### 2.3 CSRF 的两条约束

1. token 与会话绑定：换 session 后旧 token 失效，必须重取。
2. 关闭 CSRF 时 `/csrf-token` 返回 `{token:"disabled"}`（`src/server-main.js:203-209`），
   适配器要能识别这个哨兵值，**不能把它当 token 发出去**。

---

## 3. 端点清单

### 3.1 角色

| 端点 | 方法 | 请求 | 响应 | 出处 |
|---|---|---|---|---|
| 角色列表 | `POST /api/characters/all` | 无 body | **裸数组**（不是 `{data:[]}`） | `src/endpoints/characters.js:1466`，`send(data)` 在 `:1472` |
| 单个角色 | `POST /api/characters/get` | `{avatar_url:"Name.png"}` | 完整角色对象（含 `json_data` 原始字符串） | `:1480`，404 在 `:1487` |
| 角色头像 | `GET /characters/<urlencoded Name.png>` | — | 图片字节 | `src/users.js:1214` |
| 头像缩略图 | `GET /thumbnail?type=avatar&file=<name>` | query | 图片字节 | `src/endpoints/thumbnails.js:248-253` |

角色对象里移动端要用的字段：

| 字段 | 含义 | 出处 |
|---|---|---|
| `name` | 显示名 | `src/endpoints/characters.js:370-395`（shallow 白名单） |
| `avatar` | **头像文件名，含 `.png`** —— 同时是聊天目录名 | `:413` |
| `chat` | 上次打开的聊天名（**无扩展名**） | `:370-395` |
| `json_data` | 原始卡 JSON 字符串（full 模式） | `:415` |

> ⚠️ `performance.lazyLoadCharacters` 为真时返回 shallow 对象，缺 `json_data`。
> 适配器取「卡详情」必须走 `/get`，不能拿列表项当详情用。

#### 3.1.1 推送新卡之后，ST 为什么"看不到"（F6，2026-10-29 补记）

需求补丁 v0.1.7 §F6 记了一条**容易反复踩**的行为，此前没有任何文档归档：

```text
推送 → 角色文件已经在磁盘上 → ST 的列表却还是旧的
```

原因是两条叠在一起：

| 环节 | 行为 |
|---|---|
| `POST /api/characters/all` 服务端 | **每次都重新读盘**（没有缓存） |
| ST 前端 `getCharacters()` | **内存缓存**，只在页面加载 / 用户主动操作时刷新 |
| ST 有没有文件 watch | **没有** —— 磁盘变了它不会自己知道 |

所以"推送成功"与"ST 界面里出现新卡"是**两件事**。后者需要额外触发一次刷新：

- 内嵌面板（v0.1.6 的 ST 面板）→ **reload 该 iframe**；
- 桌面端走"对话框打开浏览器"的路径时 → 用户手动点刷新即可。

> **适配器侧的含义**：`pushCard` 成功之后**不应**承诺"ST 里已经能看到"。
> 它只承诺"文件写成功"。要让它立刻可见，调用方得再调一次前端刷新
> （内嵌页面 reload），而那是壳/面板的职责，不是适配器的。
> 把这两件事混成一句"推送成功"是本节要防的错 ——
> 用户会以为是推送没生效，然后反复推，最后在 ST 里堆出一堆同名序号文件。

### 3.2 聊天 CRUD

> **命名陷阱先说**：ST 里没有 `/api/chats/list`。「按角色的聊天列表」挂在
> **characters** 路由下（`/api/characters/chats`），全局最近聊天在 `/api/chats/recent`。

| 用途 | 端点 | 请求 | 响应 | 出处 |
|---|---|---|---|---|
| 按角色的聊天列表 | `POST /api/characters/chats` | `{avatar_url, simple?, metadata?}` | `ChatInfo[]`（`simple=true` 时只有 `file_name`/`file_id`） | `src/endpoints/characters.js:1499`，simple 分支 `:1517-1519` |
| 全局最近聊天 | `POST /api/chats/recent` | `{max, pinned?, metadata?}` | `ChatInfo[]`，额外带 `avatar` 或 `group` | `src/endpoints/chats.js:1054`，附加字段 `:1139-1141` |
| 读聊天 | `POST /api/chats/get` | `{avatar_url, file_name}`（**无扩展名**） | 消息数组，`[0]` 是 header；**两种「没有」形状不同**（见陷阱 #4 修正） | `:596`，路径拼接 `:615-616` |
| 存聊天 | `POST /api/chats/save` | `{avatar_url, file_name, chat, force?}` | `{ok:true}` | `:545`，`send` 在 `:558` |
| 重命名 | `POST /api/chats/rename` | `{original_file, renamed_file, is_group?, avatar_url}`（**带 `.jsonl`**） | `{ok:true, sanitizedFileName}` | `:621`，返回 `:647` |
| 删除 | `POST /api/chats/delete` | `{chatfile, avatar_url}` | `{ok:true}` | `:654`，补扩展名 `:656-658` |
| 搜索 | `POST /api/chats/search` | `{query, avatar_url?, group_id?}` | 匹配数组 | `:949`，结果组装 `:1037-1044` |

`ChatInfo` 形状（`src/endpoints/chats.js:413-422`）：

```jsonc
{
  "file_id": "聊天名（无扩展名）",   // path.parse 得来 :394-395
  "file_name": "聊天名.jsonl",      // 带扩展名
  "file_size": "12.3 kB",           // 注意：是给人看的字符串，不是字节数
  "chat_items": 42,                 // 消息条数
  "mes": "最后一条消息内容",         // 截断过的预览
  "last_mes": 1730000000000,        // 时间戳
  "match": "...",                   // 仅搜索时
  "chat_metadata": {}               // 仅 metadata:true
}
```

**保存是全量覆盖**（`trySaveChat` `:532-543`，实现是 `JSON.stringify` 每行 `join('\n')`
再 `writeFileAtomicSync`）。移动端必须回传**完整数组含第 0 条 header**，
只发改动的消息会丢掉整段历史。

#### 3.2.1 「没有聊天」的两种形状（2026-10-29 契约测试实测纠正）

原文只写了 `{}`，**这是错的**。真 ST 1.19.0 实测：

| 情形 | 返回 | 源码依据 |
|---|---|---|
| 角色聊天**目录**不存在 | `{}`（并 `mkdirSync` 建目录） | `src/endpoints/chats.js:600-603` |
| 目录存在，但**文件**读不到 | **`[]`** | `getChatData`（`:576-590`），注释原文：*"If the chatFilePath cannot be read, this will return []"* |

**为什么这个差别是关键安全项**：`[]` 同时覆盖
「文件不存在」与「**文件存在但读失败**」两种情形。而 `/api/chats/save`
是整份覆盖 —— 若把 `[]` 当作「空聊天，可以安全写入」，
**用户的真实历史会在一次保存里消失，且不报错**。

所以适配器的处置是三态 + 交叉验证：

```text
{}       → missing（目录都没有，可以建）
[]       → empty  （读不到，**不等于**新聊天）
非空数组  → chat

empty + 该 file_id 出现在 /api/characters/chats 列表里 → **拒绝保存并报错**
empty + 不在列表里                                   → 视为新聊天，可以写
```

这条也解释了为什么契约测试要用**随机角色名**：用固定名字时，
第一次跑目录不存在（得到 `{}`），第二次跑目录已被上轮建成（得到 `[]`）——
同一份代码两次不同结果，是「测试依赖执行顺序」的典型形态。

header 形状（前端构造，`public/script.js:7428-7445`）：

```jsonc
{ "user_name": "unused", "character_name": "unused", "chat_metadata": {} }
```

`user_name` / `character_name` 字面量就是 `"unused"`，真正的用户名由服务端从
session 取（`src/endpoints/chats.js:547` 的 `request.user.profile.handle`）。

### 3.3 生成（核心）

| 项 | 值 | 出处 |
|---|---|---|
| 端点 | `POST /api/backends/chat-completions/generate` | 前缀 `src/server-startup.js:180` + 路由 `src/endpoints/backends/chat-completions.js:2242` |
| 文本补全旁路 | `POST /api/backends/text-completions/generate` | 前缀 `src/server-startup.js:176` + 路由 `text-completions.js:272` |
| 必需 header | `Content-Type: application/json`、`X-CSRF-Token`、cookie | 同 §2.2 |
| 停止生成 | **无独立端点**，abort 该 HTTP 请求即可 | 见下 |

**请求体**（只列移动端 v1 需要的；完整清单 `public/scripts/openai.js:2803-2828`）：

```jsonc
{
  "chat_completion_source": "openai",   // 后端分发键，见 §3.3.1
  "model": "gpt-4o-mini",
  "messages": [ { "role": "system", "content": "..." },
                { "role": "user",   "content": "..." } ],
  "stream": true,
  "temperature": 0.8, "top_p": 1, "max_tokens": 512,
  "presence_penalty": 0, "frequency_penalty": 0,
  "secret_id": "uuid（可选，多密钥时指定用哪一条）",
  "reverse_proxy": "https://... （可选）",
  "custom_url": "https://...",          // 仅 chat_completion_source=custom
  "chat_id": "聊天文件名"                // 供 ST 侧统计/缓存用
}
```

> **采样参数全在请求体**，服务端不读 `settings.json`
> （`chat-completions.js:2652-2669` 全部取 `request.body.*`；
> 该文件里 `grep settings` 只命中两处日志文案 `:1694`、`:2392`）。
> 所以「API 连接页」存的采样参数必须由**适配器每次带过去**，
> 不能指望 ST 记住 —— 这是 v1 的一个真实工作量，容易漏。

#### 3.3.1 后端分发键

`chat_completion_source` 的枚举（`src/constants.js:187-214`）：

```text
openai claude openrouter ai21 makersuite vertexai mistralai custom cohere
perplexity groq chutes electronhub nanogpt deepseek aimlapi xai pollinations
moonshot fireworks cometapi azure_openai zai siliconflow minimax workers_ai
```

分发逻辑两段：专用处理器（`chat-completions.js:2259-2273`）+ OpenAI 兼容族
if/else 链（`:2281-2597`）。未识别值 → `400 {error:true}`（`:2594-2596`）。

**v1 支持范围（2026-10-28 用户已确认，决策 #269）**：
`openai` / `custom` / `deepseek` / `openrouter` / `groq` / `claude`。

前五个都是 OpenAI 兼容或近似，流式解析共用一条路径；`claude` 形状不同，
单独一条解包分支（§4.3）。其余 19 个源（makersuite / vertexai / cohere /
mistralai / xai / moonshot / zai / siliconflow …）**不做**，用逃生门覆盖。

**实现纪律**：收到六个之外的值时**不许静默回退到 openai** —— 那会拿错厂商的
key 去发请求（可能拿 DeepSeek 的 key 打 OpenAI 的域名）。应当是明确的
「该后端暂未支持，请在高级功能里用原生界面」。


#### 3.3.2 停止生成

**没有 `/stop` 端点**。机制是「断开连接即取消」：

```js
// src/endpoints/backends/chat-completions.js:2630-2634
const controller = new AbortController();
request.socket.on('close', function () { controller.abort(); });
```

上游 fetch 带 `signal: controller.signal`（`:2684`）。所以移动端「停止」按钮
= abort 该 HTTP 请求，Rust 侧 `reqwest` 的 `Response` 被 drop 即触发断连。
**这一点必须在契约测试里钉住**：如果哪天 ST 改成"需要显式 stop"，这里会静默失效
（用户点停止、生成还在跑、账单还在涨）。

### 3.4 设置读写

| 端点 | 请求 | 响应 | 出处 |
|---|---|---|---|
| 读设置 | `POST /api/settings/get`，无 body | 大包裹对象，**`settings` 字段是 JSON 字符串** | `src/endpoints/settings.js:219`，放入响应 `:269` |
| 写设置 | `POST /api/settings/save`，**body 就是 settings 对象本身** | `{result:"ok"}` | `:206`，写盘 `:209`，响应 `:211` |

**三个必须知道的点**：

1. 读回来的 `settings` 是**字符串**，要二次 `JSON.parse`（`settings.js:223` 读的是
   `fs.readFileSync(..., 'utf8')`，`:269` 原样放入）。
2. 写是**整份覆盖、无 patch 语义**（`:209` 直接 `JSON.stringify(request.body)`）。
   改一个字段也必须先 GET 全量 → 改 → 整体 POST 回去，否则其它设置被清空。
   **这是最容易造成用户数据丢失的一处**，适配器里必须封成一个
   `mutateSettings(updater)` 单入口，禁止外部直接调 `/save`。
3. 异常时也返回 HTTP 200，错误在响应体里（`:211` 之后是 catch 分支）。
   所以判据是 `result === "ok"`，不是状态码。

### 3.5 密钥（API key 存储）

| 端点 | 请求 | 响应 | 出处 |
|---|---|---|---|
| 写 key | `POST /api/secrets/write` | `{key, value, label?}` → `{id}` | `src/endpoints/secrets.js:511`，返回 `:522` |
| 读 key（**脱敏**） | `POST /api/secrets/read`，无 body | `{ "<api_key_openai>": [{id, value:"*******abc", label, active}] }`，未配置为 `null` | `:529`，state 构造 `:343-368` |
| 取明文 | `POST /api/secrets/find` | `{key, id?}` → `{value}`；默认 403 | `:560`，403 在 `:568-571` |

脱敏规则（`:181-195`）：长度 ≤10 → `**********`（10 星）；>10 → `*******` + 末 3 字符。
只有 `allowKeysExposure` 或 `EXPORTABLE_KEYS`（仅 4 个 URL 类 key，
`:101-106`）才返回明文。

**移动端的正确姿势**：配置页**只写不读**。用户填了新 key 就 `write`，
显示状态只看 `active === true`，绝不尝试回显旧值 —— 回显必然是星号，
做成"编辑框预填"会让用户以为自己的 key 变成了 `*******abc`。

写新 key 会自动把同 key 的旧值 `active:false`（`:211`、`:217`），
所以"换 key"不需要先删。

### 3.6 媒体

| 用途 | URL 模板 | 出处 |
|---|---|---|
| 角色头像 | `GET /characters/<urlencoded Name.png>` | `src/users.js:1214` |
| 背景图 | `GET /backgrounds/<urlencoded name>` | `src/users.js:1213` |
| 人设头像 | `GET /User%20Avatars/<urlencoded>`（路径里字面量 `%20`） | `src/users.js:1215` |
| 缩略图 | `GET /thumbnail?type=avatar\|bg\|persona&file=<name>` | `src/endpoints/thumbnails.js:251-253` |

**GET 静态资源不需要 CSRF token**（csrf-sync 只保护非 GET），但仍需 cookie。

按需求文档 §二，媒体走 **v0.1.6 的 Rust 代理**加载（缩小用途继续服役），
适配器不直接提供图片字节，只提供 URL。

---

## 4. 流式协议（本项目最容易被写错的一节）

### 4.1 关键事实：服务端不设 `Content-Type`

```js
// src/util.js:745-746
to.statusCode = statusCode;
to.statusMessage = statusText;
```

`forwardFetchResponse` 只复制状态码与状态文本，**不复制也不设置 `Content-Type`**，
然后 `from.body.pipe(to)`（`:763-764`）把上游字节流原样透传。

结论：

- 响应头里**没有** `text/event-stream`；
- 客户端**不能**用 `Content-Type` 判断是否流式 —— 只能看自己请求里的 `stream: true`；
- 事件形状 = **上游厂商原生格式**，ST 不做任何归一化。

> 这一条如果按"标准 SSE"去想，会写成 `if (ct.includes('event-stream'))`，
> 然后在真机上永远走非流式分支 —— 表现是"能出字但一次性蹦出来、没有打字机效果"。
> 所以契约测试必须断言 `Content-Type` **缺失**时仍能正确解析。

### 4.2 各后端的流式事件形状

| `chat_completion_source` | 事件 | 终止 |
|---|---|---|
| openai / custom / openrouter / groq / deepseek / moonshot / zai 等 | `data: {"choices":[{"delta":{"content":"..."}}]}` | `data: [DONE]` |
| claude | `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}` | **无 `[DONE]`**，连接关闭即结束 |
| makersuite / vertexai | `data: {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}` | 无 `[DONE]` |
| cohere | `data: {"type":"content-delta","delta":{"message":{"content":{"text":"..."}}}}` | 无 `[DONE]` |

思维链在 `delta.reasoning_content` / `delta.reasoning`（OpenAI 兼容族）
或 Claude 的 `delta.thinking`。

ST 自己的前端解析实现可直接作为契约参照：
帧分割 `/r?n?r?n/` 与取 `data:` 字段在 `public/scripts/sse-stream.js:19`、`:41-43`、`:64`；
`[DONE]` 判断 `public/scripts/openai.js:3173`；
各源解包 `openai.js:3296`（OpenAI）、`:3228-3230`（Claude）、`:3246`（Google）、`:3248`（Cohere）。

### 4.3 非流式（`stream:false`）

| 源 | 形状 | 正文位置 |
|---|---|---|
| OpenAI 兼容族 | 上游 JSON 原样返回 | `choices[0].message.content` |
| claude | ST 重新包成 OAI 形状 | `choices[0].message.content`（原始块在 `content`） |
| makersuite / vertexai | 同上包装 | `choices[0].message.content`（原始在 `responseContent`） |

出处：`chat-completions.js:2700`（`response.send(json)`）、Claude 包装 `:438-439`、
Google 包装 `:784-785`；错误 `{error:{message}, quota_error}` `:2710`。

---

## 5. 功能边界清单（**需要用户确认**）

按需求文档 F3 的 v1 范围逐项判定：哪些是 ST 的**服务端接口**（可直接做）、
哪些是**前端拼装**（需适配或砍出 v1）。

### 5.1 可直接做（服务端有接口）

| v1 功能 | 依据 |
|---|---|
| 角色选择 | `POST /api/characters/all` |
| 聊天列表（新建/删除/重命名） | `/api/characters/chats` + `/api/chats/{rename,delete}` |
| 消息列表读取 | `/api/chats/get` |
| 发送 + 流式输出 | `/api/backends/chat-completions/generate`（`stream:true`） |
| 停止生成 | abort 请求（§3.3.2） |
| API 连接配置（后端/模型/key/采样） | `/api/secrets/write` + `/api/settings/save`（§3.4、§3.5） |
| 头像/背景 | 静态 URL（§3.6） |

### 5.2 需要前端拼装（ST 前端做的，服务端没有对应接口）

| 功能 | ST 前端怎么做的 | 移动端方案 |
|---|---|---|
| **消息上下文拼装** | 按「角色卡字段 + 世界书激活 + 历史消息 + 用户人设」在浏览器里算出 `messages` 数组（`public/script.js` 的 generate 流程） | **v1 必做**（决策 #270）。复用 `shared` 的板块拼装，不另写 |
| **世界书激活判定** | 前端按 keys/二次正则/常驻/概率算出激活条目 | **v1 必做**（决策 #270）。复用 `shared` 已有的世界书解析与规则层 |
| **swipe（重新生成并保留候选）** | 前端把候选存在消息对象的 `swipes` 数组 + `swipe_id` | 数据结构在消息对象里（见 §5.3），适配器只负责存回，不需要新接口 |
| **「继续」** | 把最后一条 assistant 消息作为 prefill 再请求 | 请求体拼装，无新接口 |
| **重新生成** | 弹出最后一条 assistant 消息后重发 | 同「继续」 |
| **Markdown 渲染 / 表情 / 宏替换** | 前端 `messageFormatting` | 移动端复用 v0.1.6 渲染管线（`shared` 里已有） |
| **聊天摘要/标题自动生成** | 前端调生成接口做摘要 | v1 可不做（列表显示角色名 + 时间） |

### 5.3 消息对象形状（swipe 与渲染都依赖它）

ST 的聊天文件是 JSONL，`[0]` 是 header，之后每条是消息对象。移动端必须能原样读写
这些字段（不能只保留 `role`/`content`，否则 swipes 与用户编辑记录会被抹掉）：

```jsonc
{
  "name": "角色名",
  "is_user": false,
  "is_system": false,
  "send_date": "2026-10-28T10:00:00.000Z",
  "mes": "消息正文",
  "extra": { },                    // 附加快照，必须原样保留
  "swipes": ["候选1", "候选2"],      // 重新生成的候选
  "swipe_id": 1,                    // 当前显示第几个
  "swipe_info": [ { "send_date": "...", "gen_started": "...", "gen_finished": "..." } ]
}
```

> **判据**：适配器读进来再写回去，除自己改动的字段外**必须逐字段不变**。
> 这条要写进契约测试 —— 否则用户切到手机聊几句，回桌面发现 swipes 全没了。

### 5.4 v1 明确不做（逃生门覆盖）

ST 角色编辑器、世界书编辑（客户端编辑器 + PNG 推送已覆盖）、extensions /
regex / 群组 / moving UI / 图片生成 / TTS。

---

## 6. st-adapter 接口设计草案

### 6.1 分层

```text
client/src/chat/            ← UI（v0.1.7 新增，夜航设计语言）
      ↓ 只依赖接口，不认识 HTTP
shared/src/st-adapter/      ← 类型 + 纯逻辑（URL 拼装、SSE 解析、消息对象归一）
      ↓
client/src-tauri/src/st_api.rs  ← 真正的 HTTP（reqwest + cookie jar + CSRF）
```

**为什么 HTTP 放 Rust 而不是渲染层**：需求文档 §二「App ↔ ST 内部 API 走 Rust HTTP
（CORS 免疫）」。且比 webview 多一层好处：cookie jar 由我们持有，
不受 `SameSite` 与浏览器同源策略影响（§2.2）。

### 6.2 渲染层看到的接口（草案，待确认）

```ts
export interface StAdapter {
  // 会话
  connect(baseUrl: string): Promise<StSession>;   // 探活 + 取 token
  health(): Promise<{ ok: boolean; version: string }>;

  // 角色与聊天
  listCharacters(): Promise<StCharacter[]>;
  listChats(avatar: string): Promise<StChatInfo[]>;
  loadChat(avatar: string, fileName: string): Promise<StChatMessage[]>;
  saveChat(avatar: string, fileName: string, messages: StChatMessage[]): Promise<void>;
  renameChat(avatar: string, from: string, to: string): Promise<string>;
  deleteChat(avatar: string, chatFile: string): Promise<void>;

  // 生成
  generate(req: StGenerateRequest, onEvent: (e: StStreamEvent) => void): Promise<StAbort>;
  // StAbort.abort() → 断连即取消（§3.3.2）

  // 设置与密钥
  readSettings(): Promise<StSettings>;                       // 已 parse 的对象
  mutateSettings(fn: (s: StSettings) => StSettings): Promise<void>;  // 唯一写入口
  writeSecret(key: StSecretKey, value: string, label?: string): Promise<void>;
}

export type StStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; message: string };
```

设计要点（每条都是为了把 §7 的陷阱挡在接口层）：

1. `mutateSettings(fn)` 是**唯一**写入口 → 内部自动 GET→改→POST，外部无法绕过导致清空。
2. `generate` 返回 `StAbort` 而不是提供 `stop()` → 语义上强制"取消 = 断连"。
3. 流式统一成 `StStreamEvent`，**把四种后端形状的差异关在适配器里** →
   UI 只认 `text` / `reasoning` / `done` / `error` 四种。
4. `readSettings` 返回已 parse 的对象（吃掉 §3.4 陷阱 1 的字符串）。

### 6.3 契约测试计划（T15.4）

- 起真 ST 1.19 容器（或本机 ST），逐端点断言**形状**（不是行号）；
- 断言项：
  1. `/api/characters/all` 是数组且元素有 `name`/`avatar`
  2. `/api/chats/get` 对不存在文件返回 `{}`（陷阱 4）
  3. `/api/settings/get` 的 `settings` 是**字符串**
  4. `/api/characters/all` 里 `avatar` 以 `.png` 结尾
  5. 流式响应**没有** `Content-Type: text/event-stream`（§4.1）—— 这条最反直觉，必须钉
  6. 消息对象 round-trip：读→写→读，`swipes`/`swipe_info` 逐字段不变
  7. ST 版本号 = `1.19.0`
- 版本号写进测试文件常量，升版时测试红 → 变成跟进清单。

---

## 7. 陷阱清单（写代码前读一遍）

| # | 陷阱 | 后果 | 规避 |
|---|---|---|---|
| 1 | `/api/chats/save` 是全量覆盖 | 只发改动 → 历史丢失 | 适配器只暴露「整份保存」 |
| 2 | 聊天目录名 = `avatar` 去 `.png`，不是角色名 | 角色改名后找不到旧聊天 | 始终用 `avatar` 字段，不要用 `name` 拼路径 |
| 3 | `file_name`（带 `.jsonl`）与 `file_id`（不带）双轨 | 传错 → 400 或建出怪文件 | 按端点分别用：get/save 用不带，rename/delete 用带 |
| 4 | **`/api/chats/get` 的「没有聊天」有两种形状**（2026-10-29 实测修正）：目录不存在 → `{}`（顺手 `mkdirSync`）；目录存在但文件读不到 → **`[]`**。两者都不返回 404 | 把 `{}` 或 `[]` 当「空聊天 → 可安全写入」 → **一次保存整份覆盖，真实历史丢失** | 三态判定（`missing` / `empty` / `chat`），`empty` 必须再按「是否出现在聊天列表里」交叉验证才允许保存（`canSaveOverEmpty`） |
| 5 | `settings` 是字符串 | 直接当对象用 → undefined | parse + 类型断言后再用 |
| 6 | `/api/settings/save` 无 patch | 只发一个字段 → 其它设置全清 | 只走 `mutateSettings` |
| 7 | 保存失败也返回 200 | 以为成功 | 判 `result === "ok"` / `ok === true` |
| 8 | cookie 过期后所有 POST 403 | 表现为"突然发不出消息" | 检测 403 → 重新 `connect()` 一次 → 重试一次，仍失败才报错 |
| 9 | `file_size` 是 `"12.3 kB"` 字符串 | 想排序/求和 → NaN | 需要字节数就自己 stat 或忽略 |
| 10 | 流式响应无 `Content-Type` | 永远走非流式分支 | 看请求参数判断，不看响应头 |

---

## 8. 已确认结论（2026-10-28）

阶段 0 的两个确认已完成。以下四条是 T15.4 / T15.5 的动工依据，**不再重复讨论**。

| # | 决策 | 取值 | 决策表 |
|---|---|---|---|
| 1 | v1 后端范围 | `openai` / `custom` / `deepseek` / `openrouter` / `groq` / `claude` 六个；其余用逃生门覆盖 | #269 |
| 2 | 世界书激活 | **纳入 v1**，复用 `shared` 已有的解析与规则层 | #270 |
| 3 | swipe / 继续 的 UI | **左滑切候选**；左缘 20px 起手才是返回（见设计册 §6） | #271 |
| 4 | 构建宿主 | 放行 WSL2，Ubuntu 里做交叉编译（用户操作安全中心） | #272 |

### 8.1 由 #2 派生出的开工顺序

「激活世界书」把 v1 的依赖方向改了：**`shared` 的世界书规则层必须在聊天面板之前就绪**。
所以 T15.5 的实际前置不只是本文，还包括：

1. 确认 `shared` 里世界书激活逻辑的**入口函数**（v0.1.6 的审计链路里已有一份，
   但它服务于「字数统计与规则校验」，未必直接产出 `messages` 片段）；
2. 若两者口径不同（审计要"全量参与统计"、聊天要"按激活状态筛选"），
   **必须让它们共用同一个激活判定函数**，不允许各写一套 —— 否则用户在编辑器里
   看到 12 条激活、聊天时只进去 9 条，而两边都"有测试"。

### 8.2 由 #3 派生出的手势优先级

```text
左缘 0–20px 起手右滑  →  返回（最高，任何页面都让位）
消息气泡内左滑         →  切 swipe 候选
气泡内右滑             →  不占用（留给系统返回手势的备选）
```

判据写在设计册 §6；T15.5 实现时必须实测「从气泡左缘起手」与「从屏幕左缘起手」
两种轨迹，确认不会被浏览器/系统手势抢走。

---

## 9. Rust 侧 HTTP 层（T15.4，2026-10-30 落地）

实现：`client/src-tauri/src/st_api.rs`。本节记的不是"契约内容"，而是
**写它的时候用真 ST 实测出来的四个事实** —— 这四条在文档别处没有，
而它们直接决定了代码怎么写。

### 9.1 实测环境

本机 `http://127.0.0.1:8000`，ST **1.19.0**（与决策 #260 钉死的版本一致）。

### 9.2 事实一：正确 token + 无 cookie = 403

| 发出去的东西 | 结果 |
|---|---|
| 带 cookie + 正确 `X-CSRF-Token` | **200** |
| 带 cookie + **错误** token | 403 |
| **无 cookie** + 正确 token | **403** |

第三条是重点：**光有 token 没用，必须有配套的 session cookie**。
所以 `cookie_store(true)` 不是"顺手带上"，是能不能用的分界；
`reqwest` 的默认特性里没有它，漏了会表现为"每次 POST 都失败"。

### 9.3 事实二：403 的响应体是 HTML，不是 JSON

```text
HTTP 403
<!DOCTYPE html>
<html lang="en">…<pre>Forbidden</pre>…
```

⇒ 必须**先判状态码再解析**。先 `json::<T>()` 会报
「响应不是预期 JSON」，而真实原因（会话失效）被这个假象盖住。

### 9.4 事实三：session cookie 的名字带会话 id，且会话失效后会换

```text
session-e6f8a3d5      = eyJjc3JmVG9rZW4iOi…
session-e6f8a3d5.sig  = eJzO4Uv1MM28…
```

- cookie 有效时**复用同一会话**：连续三次 `connect()` 拿到**完全相同**的 token 与 cookie 名；
- 无 cookie（或失效）时**新开会话**：token 与 cookie 名都换。

麻烦在于：**两个不同名的 cookie 会在 jar 里共存**，请求头于是同时带上
`session-旧=…; session-新=…`，ST 取哪一个不可控。

⇒ 所以 `connect()` 的实现是**整只重建 client**（丢弃旧 jar），而不是
"在同一个 jar 上再取一次 token"。后者会让旧 cookie 和新 cookie 一起发出去，
"重连后重试"可能仍然 403，看起来像恢复逻辑没生效。

> 这一条也解释了为什么单测容易假绿：单测每次新建 client，jar 天然干净；
> 只有长生命周期的实例子才会踩到 cookie 共存。

### 9.5 事实四：恢复路径成立（已验证）

```text
建会话（拿 token + cookie）           → POST 200
清空 jar（模拟 cookie 过期）           → POST 403   ← 线上「突然发不出消息」
重新 connect（新 token + 新 cookie）   → POST 200   ← 恢复成立
```

⇒ 「403 → `connect()` → 重试**一次**」这条路是对的。
只重试一次：真 403（确实无权限）不能被无限重试掩盖成"一直在转圈"。

### 9.6 测试怎么跑

```bash
# 本地用例（不需要 ST）
cargo test --lib -- st_api

# 对真 ST 的契约用例（3 条，标了 #[ignore]）
TCS_ST_TEST_BASE=http://127.0.0.1:8000 \
  cargo test --lib live_ -- --ignored --test-threads=1
```

`--test-threads=1` 不能省：几条用例共用同一个 ST 实例，并行会互相干扰会话。
未设 `TCS_ST_TEST_BASE` 时用例**打印一行说明后直接过** —— 没起 ST 的机器上
不该红，但它也不会假装验过。

### 9.7 这一层**不做**的事

只做 HTTP：连接、cookie、CSRF、403 恢复、JSON 编解码。

业务语义不放进来 —— 特别是 §3.3 的「这份聊天能不能保存」（`{}` / `[]` / 数组
三态 + 是否在列表里交叉验证）。放进来会让一个纯传输模块变成半个业务模块，
测试也不好写；而且那种判断一旦与传输层耦合，改其中一边都要动另一边。
