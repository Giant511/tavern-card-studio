# 服务端运维命令（PowerShell）

Tavern Card Studio Server 的全部运维操作都在命令行完成：建账户、看/换令牌、
注册 Windows 服务、离线自检。**管理面板只做查看与配置，不提供这些操作** ——
所以面板进不去时（忘了密码、服务没起、端口被改），这条路仍然能用。

> 适用版本：0.1.2 及以后。命令面一旦变化，本文件必须同步（见文末「维护约定」）。

---

## 1. 先建立 `$tcs` 快捷方式（推荐）

所有命令都通过服务端自己的 CLI 执行。在**安装目录**打开 PowerShell：

```powershell
cd "C:\Program Files\Tavern Card Studio Server"

# $tcs 代表"服务端 CLI"：只用 node.exe + app\，任何 0.1.2 安装都有
$tcs = ".\node.exe", ".\app\server\dist\index.js",
       "--config", "C:\ProgramData\TavernCardStudio\config.json"
```

之后所有命令都写成：

```powershell
& $tcs <子命令> [参数]
```

`$tcs` 只在**当前这个 PowerShell 窗口**有效。关掉重开要重新定义一次。

**为什么用这个形态**：`node.exe` 和 `app\` 目录是任何安装包都会铺的；而
`tcs-server.cmd` / `start-server.cmd` 是后来才加进包里的脚本，**同一个版本号
再装一次不会替换已有文件**（Windows Installer 对相同版本只做维护），所以
老安装上可能没有它们。

### 1.1 两个脚本形态（新装才有）

如果你的安装目录里能看到这两个文件，可以更短：

| 形态 | 命令 | 前提 |
|---|---|---|
| A（推荐） | `& $tcs user list` | 任何 0.1.2 安装 |
| B | `.\tcs-server.cmd user list` | 较新的安装包才有；自带 `--config` |
| C | `.\start-server.cmd user list` | 较新的安装包才有；无参数时启动服务 |

**别敲裸 `tcs-server`** —— 安装目录里没有这个 exe，只会得到
「无法将"tcs-server"项识别为 cmdlet」。要么带 `.cmd`，要么用形态 A。

### 1.2 `--config` 为什么必须写

它指向**服务正在用的那份配置**。省掉的话，CLI 会按当前目录另算一个数据目录
（`<当前目录>\data\`），**等于在旁边新建一个空库** —— 症状是
「账户明明建好了，服务却说不存在」，而两处都不会报错。

配置文件的解析顺序（`.cmd` 脚本内部也是这个顺序）：

1. 环境变量 `TCS_CONFIG`（设了就用它，不再看别处）
2. 安装目录里存在 `install-layout.ini` → `%ProgramData%\TavernCardStudio\config.json`
3. 否则按绿色包处理 → `%HERE%\data\config.json`

`install-layout.ini` 只有 MSI 才会装。用它而不是"猜 `data\config.json` 存不存在"，
是因为那个文件绿色包跑过一次就会有、安装版被误跑一次也会生成，猜错就写进另一个库。

---

## 2. 命令总表

| 命令 | 用途 |
|---|---|
| `serve` | 启动服务（控制面 + 数据面）。默认命令 |
| `worker` | 只启动数据面 API |
| `config show` | 打印配置（token 打码）与配置路径 |
| `config path` | 只打印配置路径 |
| `token show` | 打印完整访问令牌 |
| `token rotate` | 重新生成访问令牌 |
| `service install` / `uninstall` | 注册 / 卸载 Windows 服务 |
| `service start` / `stop` / `restart` / `status` | 服务的启停与状态 |
| `user list` | 列出账户 |
| `user add` | 新建账户 |
| `user passwd` | 重设密码 |
| `user enable` / `disable` | 启用 / 禁用账户 |
| `user adopt` | 把无归属的历史卡片划给某个账户 |
| `user migrate` | 建首账户并接管历史卡片（升级必经） |
| `user repos` | 列出账户的仓库 |
| `user repos add` | 给账户新建仓库 |
| `version` | 版本信息 |
| `selfcheck` | 离线自检：真跑一遍运行时依赖 |
| `help` | 打印内置帮助 |

---

## 3. 账户相关

### 3.1 `user migrate` —— 从旧版升级、或全新安装时建第一个账户

**这是 v0.1.1 升上来的必经一步。** v0.1.2 起卡片按账户隔离，没有账户时
客户端登录不了（自助注册默认关闭），全局令牌也看不到已归属的卡片。

```powershell
& $tcs user migrate admin
```

提示 `首账户密码` 时输入（至少 8 个字符，不回显）。**密码只从标准输入读，
不接受命令行参数** —— 参数会进 shell 历史，也会出现在进程列表里。

它做的事：

1. 建账户（首账户自动是管理员）；
2. 把历史卡片接管进这个账户的默认仓库；
3. **动库之前先备份**（`VACUUM INTO`，含最新事务），备份在原库旁边，
   文件名形如 `state.db.pre-accounts-<时间戳>.bak`。

典型输出：

```
将创建首账户「admin」（管理员）并接管 12 张历史卡片。
原库会先自动备份（VACUUM INTO，含最新事务）。
首账户「admin」已创建（12 张历史卡片已接管）
原库已备份到 C:\ProgramData\TavernCardStudio\store\state.db.pre-accounts-<时间戳>.bak
```

- **全新安装**用同一条命令，只是「接管 0 张卡片」。
- **重复执行是安全的**：检测到已有账户时它只补默认仓库、把没归仓库的卡片入库。
- **不需要重启服务**：账户是每次请求现查库的。
- 想换个用户名就在命令里写：`& $tcs user migrate Gez`。

### 3.2 `user add` —— 再加一个账户

```powershell
& $tcs user add bob                    # 普通成员
& $tcs user add carol --role admin     # 管理员
```

提示 `设置密码` 时输入。**第一个账户无论 `--role` 写什么都会被设为管理员**
（否则建完没人能管理服务端），此时会额外打印一行说明。

### 3.3 `user list` —— 看账户现状

```powershell
& $tcs user list
```

输出：

```
用户名  角色   状态    创建时间                   最后登录
admin   admin  active  2026-10-23T11:20:31.000Z  2026-10-23T12:41:07.000Z
bob     user   active  2026-10-23T11:25:02.000Z  -
```

- 一个账户都没有时，它会直接提示「还没有任何账户。用 `tcs-server user add <用户名>`
  创建第一个（管理员）」——看到这句就说明库是空的（或路径选错了，见 §1.2）。
- 库里有无归属的历史卡片时，末尾会多一行 `注意：有 N 张卡片没有归属账户`。

### 3.4 `user passwd` —— 重设密码

```powershell
& $tcs user passwd bob
```

提示 `新密码`。改完该账户**已签发的会话全部失效**（密码变了就不再接受旧令牌），
这是忘了密码、或怀疑泄露时的标准处置。

### 3.5 `user enable` / `user disable` —— 停用而不删除

```powershell
& $tcs user disable bob
& $tcs user enable bob
```

禁用后该账户**登录直接被拒**，但它的卡片与仓库都保留。适合离职交接期。

### 3.6 `user adopt` —— 把无归属卡片划给某个账户

```powershell
& $tcs user adopt admin
```

把 `owner_id` 为空的历史卡片划给该账户，**同时入它的默认仓库**
（否则会出现「账户能看到、仓库令牌看不到」的中间态）。适合"当初没跑 migrate / 又
从旧备份里导回几张卡"的情况。

### 3.7 `user repos` / `user repos add` —— 看与建仓库

```powershell
& $tcs user repos                       # 默认看第一个账户
& $tcs user repos admin                 # 看指定账户
& $tcs user repos add admin work        # 给 admin 建一个叫 work 的仓库
```

输出：

```
账户「admin」的仓库：
  default（默认）  12 张卡片  3f2a…
  work             0 张卡片   9c1e…
```

排查「卡片进错仓库」时，这是第一手信息。**有卡片的仓库不能删**（面板里也一样）。

---

## 4. 令牌相关

### 4.1 三种令牌，先分清

| 令牌 | 怎么来 | 范围 | 用在哪 |
|---|---|---|---|
| **账户令牌** | 客户端登录换取，2 小时、自动续期 | 该账户的全部仓库 | 客户端正常使用 |
| **仓库令牌**（`tcr_…`） | 客户端「仓库与令牌」里申请 | 单个仓库，读/写/回滚可分别授权 | 给别人或别的工具用 |
| **全局令牌**（legacy） | 服务端首次启动自动生成 | **只有未归属账户的卡片** | 仅运维、或 ≤v0.1.1 的旧服务端 |

**迁移到账户之后，全局令牌看不到任何卡片** —— 卡都已归属账户。这是 0.1.2 的
有意降权，不是故障。

### 4.2 `token show` —— 取全局令牌原文

```powershell
& $tcs token show
```

只打印令牌本身，方便管道或复制。配置里还没有令牌时会提示用 `token rotate` 生成。

也可以从这三处拿到：面板「API 与令牌」页、配置文件 `auth.token` 字段、
或 `config show`（打码显示前后各 4 位）。

### 4.3 `token rotate` —— 换一个新的全局令牌

```powershell
& $tcs token rotate
```

新令牌写进配置文件并打印出来，**旧令牌立即作废**。运行中的 worker 需重启才生效：

```powershell
& $tcs service restart        # 注册成服务时
# 或面板「总览 → 重启」，或前台按 Ctrl+C 再重新 serve
```

客户端「设置 → 高级 · 兼容模式」里填过旧令牌的，要跟着换掉。

---

## 5. 配置相关

### 5.1 `config path` —— 搞清楚到底在用哪份配置

```powershell
& $tcs config path
```

排查「改了配置没生效」的第一步。它打印的就是本次命令实际加载的文件。

### 5.2 `config show` —— 看生效值（令牌打码）

```powershell
& $tcs config show
```

输出 JSON：`configPath`、`port`、`controlPort`、`host`、`controlHost`、`dataDir`、
`rulesDir`、`maxUploadBytes`、`logLevel`、`auth.token`（形如 `tcs_…a1b2`）、
`service`、以及拼好的 `panel` / `api` 地址。

需要明文令牌时用 `token show`。

---

## 6. 服务相关（Windows 服务）

服务名默认 `TavernCardStudioServer`，取自配置的 `service.name`。

```powershell
& $tcs service status          # 查状态（等价 sc query）
& $tcs service start
& $tcs service stop
& $tcs service restart         # 改完配置 / 换了令牌后用这个
& $tcs service install         # 注册为 Windows 服务
& $tcs service uninstall       # 停止并删除服务
& $tcs service install --dry-run   # 只打印将要执行的 sc 命令，不真做
```

**注册服务需要宿主程序。** `install` 会检查同目录下的
`tcs-service-host.exe` + `tcs-service-host.xml`（WinSW 宿主），找不到就拒绝并说明原因。
为什么不直接挂 `node.exe`：node 从不调用 `StartServiceCtrlDispatcher`，
服务会永久卡在 `Start Pending`，而进程其实活着、端口也在听 —— 看起来完全正常，
但安装程序会一直等它。

**用 MSI 装的机器上服务已经注册好了**，一般不需要碰这一组命令。

---

## 7. 启动与诊断

### 7.1 `serve` —— 前台启动（调试用）

```powershell
& $tcs serve
```

前台常驻。启动后先打印 banner：

```
Tavern Card Studio Server 0.1.2
管理面板：http://127.0.0.1:8731
API：http://127.0.0.1:8730/api
数据目录：C:\ProgramData\TavernCardStudio
服务运行中 · 按 Ctrl+C 停止（关掉这个窗口也会停止服务）
```

最后一行是刻意加的：前台运行时打完 banner 就只剩光标，很容易被当成"卡住了"。
**它确实在运行，按 Ctrl+C 才停。**

- `--no-worker` 只起控制面（面板），不起数据面。
- 面板地址和 API 地址是两个独立配置（`controlPort` / `port`），可以只把面板开给内网。

### 7.2 `worker` —— 只起数据面

```powershell
& $tcs worker
```

由服务管理器直接托管数据面时用，或排查"面板正常但 API 不通"时单独起一个。

### 7.3 `version` —— 版本信息

```powershell
& $tcs version
```

```
tcs-server 0.1.2 (node v22.22.2, win32/x64)
```

报障时请带上这一行。

### 7.4 `selfcheck` —— 离线自检运行时依赖

```powershell
& $tcs selfcheck --bundle-root "C:\Program Files\Tavern Card Studio Server\app"
```

**服务起不来（事件日志 1067、日志里 `Cannot find package`）时的第一条命令。**
它不读配置、不绑端口，随时可跑，并且**真的执行**依赖而不是只 import 一下：
算一次 Argon2id 哈希并验证、生成一张 ECDSA 证书、开一个内存 SQLite 库、
算一次 git 对象哈希。

```
Tavern Card Studio Server 0.1.2 自检（node v22.22.2，win32/x64）
要求依赖只从包内解析：C:\Program Files\Tavern Card Studio Server\app
[OK] @node-rs/argon2 —— 哈希与校验通过（$argon2id$v=19$m=1…）
    解析自 …\app\node_modules\@node-rs\argon2\index.js
[OK] @peculiar/x509 —— 证书生成通过（-----BEGIN CERTIFICATE-----）
[OK] better-sqlite3 —— 内存库读写通过（ok）
[OK] isomorphic-git —— 对象哈希通过（0ba2153d4615…）
结论：通过（全部运行时依赖可用）
```

**`--bundle-root` 不能省。** 它约束"每个依赖都必须从这个目录里解析出来"。
少了它，绿色包放在仓库目录下时，缺的包会从上层 `node_modules` 被找到，
自检给出**假通过**；装到 `C:\Program Files` 之后立刻崩。

失败时每项会写明「从包外解析到了 … —— 产物缺这个包」，据此就知道缺哪个依赖。

---

## 8. 常用选项

| 选项 | 说明 |
|---|---|
| `--config <路径>` | 配置文件路径 |
| `--port <端口>` | API 端口（默认 8730） |
| `--control-port <端口>` | 管理面板端口（默认 `port + 1`） |
| `--host <地址>` | API 监听地址（默认 `127.0.0.1`；开给局域网填 `0.0.0.0`） |
| `--control-host <地址>` | 面板监听地址（默认 `127.0.0.1`，独立于 `--host`） |
| `--data-dir <路径>` | 数据目录（`blobs` / `repos` / `state.db`） |
| `--rules-dir <路径>` | 规则目录 |
| `--token <令牌>` | 指定访问令牌 |
| `--trust-proxy <列表>` | 可信反向代理，逗号分隔的 IP 或 CIDR（默认空＝不信任任何代理头） |
| `--log-level <级别>` | `debug` / `info` / `warn` / `error` |
| `--no-worker` | 只起控制面（配合 `serve`） |
| `--dry-run` | 只打印将要执行的 `sc` 命令（配合 `service *`） |
| `--service-mode <模式>` | 内部用：`process` / `windows-service`。由服务宿主与安装脚本传入，手动运行不要改 —— 内置帮助里没有列出它 |

选项写在子命令**前后都可以**（解析器扫全部参数，不看位置）。**命令行参数在后
则后生效** —— 这也是 `start-server.cmd` 把自己的默认值放在 `%*` 之前的原因。

### 8.1 环境变量

| 变量 | 作用 |
|---|---|
| `TCS_CONFIG` | 配置文件路径，优先级最高 |
| `TCS_DATA_DIR` | 数据目录（等价 `--data-dir`） |
| `TCS_RULES_DIR` | 规则目录（等价 `--rules-dir`） |
| `TCS_PASSWORD` | 非交互场景提供密码。**只给脚本用** —— 环境变量虽然不进 shell 历史，仍可能被同用户进程读到 |

---

## 9. 常见故障对照

| 现象 | 原因 | 处置 |
|---|---|---|
| `无法将"tcs-server"项识别为 cmdlet` | 敲了裸 `tcs-server`（没有这个 exe） | 用 `& $tcs …` 或 `.\tcs-server.cmd …` |
| `无法将"start-server.cmd"…识别` | 老安装上没有这个文件 | 见 §1；或强制重装（§10） |
| 账户建好了，服务说「用户不存在」 | `--config` 没写，写进了另一个库 | `& $tcs config path` 对一下；用 `user list` 确认账户在哪个库 |
| 登录被拒「未开放自助注册」 | `registerMode` 是 `closed` / `admin-only` | 用 `user add` 建账户，别走注册 |
| 迁移后客户端看不到卡 | 还在用全局令牌 | 换账户登录（§4.1） |
| `user migrate` 说「已有 N 个账户」 | 库已经迁移过了 | 正常；它只补默认仓库与未归仓库的卡片 |
| 服务起不来，事件日志 1067 | 产物缺运行时依赖 | `selfcheck`（§7.4） |
| `service install` 报「找不到服务宿主」 | 缺 `tcs-service-host.exe` / `.xml` | 用 MSI 安装；或按提示拷 WinSW 宿主 |
| 面板打不开、API 正常 | `controlHost` / `controlPort` 与预期不同 | `& $tcs config show` 看 `panel` 那一行 |
| 反代下取令牌一律 403、所有人一起被锁 | `trustProxy` 没登记代理地址 | 见「公网部署」文档 |

---

## 10. 装了新包但文件还是旧的

Windows Installer 对**相同版本号**的安装只做维护：校验、修复，**不会铺新文件、
也不替换无版本号的旧文件**。所以"重装了一遍却还是旧脚本 / 旧说明页"，
就是这个原因，不是安装失败。

强制重装（管理员 PowerShell）：

```
msiexec /i "C:\path\to\TavernCardStudioServer-0.1.2.msi" REINSTALL=ALL REINSTALLMODE=amus
```

- `REINSTALL=ALL` 要求重装所有功能；
- `REINSTALLMODE=amus` 里的 `a` 强制重装所有文件、`u` 用较新的版本覆盖 ——
  少写或写错等于没装。

装完用 `dir` 看文件时间，或直接 `& $tcs version` 确认版本号。

---

## 11. 安全须知

- **密码只从标准输入读**，任何命令都不接受 `--password` 参数 —— 命令行参数会进
  shell 历史，也会出现在进程列表里。
- **令牌是凭证**，不要贴进聊天、工单、截图。`token show` 的输出用完就清屏。
- `token rotate` 之后**旧令牌立即失效**，记得重启服务并更新客户端。
- **`trustProxy` 只填你自己的代理地址**，不要填 `0.0.0.0/0` 或 CDN 大段；
  写错或填 `/0` 会让服务**拒绝启动**（这是有意的 fail-closed）。
- 服务端日志不记录令牌与密码；排查时请贴 `config show`（已打码）而不是原始配置。

---

## 维护约定

- **本文件随版本更新。** 任何新增/改名/删除运维命令的改动，必须在同一个提交里
  更新本文件；否则 `npm test` 里的 `test/ops-doc.test.mjs` 会失败。
- 该守卫比对两处：`server/src/cli.ts` 的内置帮助（命令面的唯一来源）与本文件的
  命令表；同时校验 `.gitignore` 只放行本文件 —— `docs/` 其余内容不上传。
- 新增文档若需一并上传 GitHub，需显式在 `.gitignore` 里加 `!docs/<文件名>`
  并同步更新该守卫的允许清单。
