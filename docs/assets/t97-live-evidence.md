# T9.7 按 ID 归档 · 真实服务端证据

> 记录时间：2026-10-22；服务端为本仓库 `server/dist` 构建，数据目录为一次性临时目录（`--data-dir` 指向 temp），
> 监听 `127.0.0.1:8730`（另一台已安装的 0.1.0 服务占用 `192.168.1.203:8730`，两者不冲突）。
> 所有请求都带 `Authorization: Bearer <token>`；`--noproxy '*'` 是为了避开本机 HTTP 代理。

## 1. 四条链路

### 1.1 按 ID 新建（201）

```http
POST /api/cards?cardId=lin-wanzhao-0001&message=初始版
Content-Type: application/json
<sample-card.json 原始字节>
```

```http
HTTP/1.1 201 Created
X-TCS-Card-Id: lin-wanzhao-0001
X-TCS-Card-Seq: 1
X-TCS-Card-Created: 1

cardId = lin-wanzhao-0001   seq = 1   created = true   warnings = []
card.idSource = client
```

### 1.2 同 ID 追加（200）

```http
POST /api/cards?cardId=lin-wanzhao-0001&baseSeq=1&message=v2
```

```http
HTTP/1.1 200 OK
X-TCS-Card-Id: lin-wanzhao-0001
X-TCS-Card-Seq: 2
X-TCS-Card-Created: 0

cardId = lin-wanzhao-0001   seq = 2   created = false   warnings = []
```

状态码区分「新建」与「追加」，但两者是**同一个端点**：不存在"先查再建"的窗口。

### 1.3 历史按 cardId 寻址

```http
GET /api/cards/lin-wanzhao-0001/versions
```

```
total = 2
  v2  update  v2
  v1  upload  初始版
```

### 1.4 回滚按 cardId 寻址（201，历史只增）

```http
POST /api/cards/lin-wanzhao-0001/rollback
{ "to": 1, "message": "回滚到 v1" }
```

```
new version seq = 3   kind = rollback
restoredFrom   seq = 1

历史 total = 3  ->  [3, 2, 1]

latest sha256 = c3e85b1571b207d7  3922 bytes
v1     sha256 = c3e85b1571b207d7  3922 bytes
逐字节相同: True
```

回滚不是"把指针挪回去"，而是以目标版本的原始字节**新建一个提交**，
所以历史三条都在，回滚后读到的字节与 v1 完全一致。

## 2. 遗留卡片读取兼容

v0.1.0 的客户端上传时不带卡 ID，服务端只能自己发号。用同一个请求复现：

```http
POST /api/cards?message=legacy        ← 不带 cardId
```

```
自动发号 ID = card-d2fa05
idSource    = auto
```

然后逐项验证它能被正常读写：

| 操作 | 结果 |
|---|---|
| `GET /api/cards?limit=10` | 列出 `card-d2fa05  auto  林晚照  v1` |
| `GET /api/cards/card-d2fa05` | `200` |
| `GET /api/cards/card-d2fa05/versions` | `200` |
| `POST /api/cards/card-d2fa05/rollback` | `201`（能回滚） |

同时列表里另一种来源的卡也在，可对照：

```
card-d2fa05              auto     林晚照        v1
lin-wanzhao-0001         client   林晚照        v3
```

**老库升级**（`id_source` 列的迁移）由 `test/card-id-archive.test.mjs` 最后一个用例覆盖：
手工造一个 v0.1.0 形态的库（没有 `id_source` 列）并插入一行，再用 `Db` 打开，
断言列被补出、老行取到的 `id_source === 'legacy'`。

## 3. 分叉警告（不阻断）

```http
POST /api/cards?cardId=fork-demo-0001&baseSeq=1&message=v-root
```

```
首次（基线 1，远端无卡）: seq=1 warnings=['REMOTE_MISSING']
```

远端没有这张卡却声明了基线 —— 说明历史不在这台服务器上（被硬删 / 换库 / ID 拼错），
仍按新卡写入，但给 `REMOTE_MISSING`。

```http
POST /api/cards?cardId=fork-demo-0001&baseSeq=1&message=v2-by-other   ← 另一个人，基线正确
```

```
seq=2 warnings=[]
```

```http
POST /api/cards?cardId=fork-demo-0001&baseSeq=1&message=v3-my-fork    ← 我的基线还停在 v1
```

```
seq=3  created=false
warning code    = FORK
warning message = 远端已有他人修改（最新 v2，你的基线是 v1），本次上传将产生分叉历史
baseSeq=1  remoteLatestSeq=2
```

**内容照样写入了 v3** —— 警告不等于拒绝。客户端把这个警告渲染成常驻黄条，
见 `docs/assets/t97-fork-warning.png`（同一屏里还能看到历史中的「另一个人改的」）。

## 4. 客户端侧证据（真实按钮 → 真实服务端）

用页面自身的 `fetch` 扮演"另一个人"，制造**真实的远端分叉**，不伪造 UI 状态：

```
T97C|status=已连接（服务端 0.1.0），token 有效
T97C|targets=card-j0mu base=
T97C|upload1 base=1 warn=none          ← 第一次上传，会话基线变成 v1
T97C|other seq=2 code=undefined        ← 另一个人传了 v2
T97C|fork bar hidden=false dataset=FORK ← 我再传，警告条出现
T97C|base-now=3                        ← 我的这次写入 v3，基线随之前进
```

列表文案（DOM 实测）：

```
本次会话 · card-zsh5 ｜ 林晚照 · card-iloe · v3 ｜ … ｜ 林晚照 · card-d2fa05（遗留 ID） · v2
```

非本会话卡片的回滚按钮：

```
olderRollbackDisabled=true
title=只能回滚当前会话所属的卡片；其他卡片的历史是只读的
```

## 5. 跑这些证据

服务端：

```bash
npm run build:server
./release/server/node.exe ./server/dist/index.js serve \
  --config <临时目录>/config.json --port 8730 --control-port 18981 \
  --host 127.0.0.1 --data-dir <临时目录>/store --rules-dir ./rules
```

自动化回归（不需要手工起服务，测试自己 spawn）：

```bash
node --test test/card-id-archive.test.mjs   # 15 例：按 ID 归档 / 分叉 / 遗留兼容 / 老库迁移
node --test test/export-sync.test.mjs       # 26 例：客户端 upsert 契约 / 旧服务端识别 / 列表字段
```
