# 服务端 MSI 安装失败：根因、修复与排障手册

> 发生时间：2026-10-21（同一问题有两次不同的失败表现，见 §1）
> 影响版本：`TavernCardStudioServer-0.1.0.msi`（两次修复前的构建）
> 修复后产物：`release/TavernCardStudioServer-0.1.0.msi`，**32,441,368 B / 30.94 MiB**，
> sha256 `77a0e254900101841b5a206561dc32490079075b52ea490ce36911095a8211a5`
>
> 注：MSI **不是逐字节可复现**的。连续两次构建体积几乎相同，但 sha256 不同
> （WiX 会写入构建时间戳）。所以体积可以当回归判据，哈希只能"发布时记录、随包分发"，
> 不能拿旧哈希去校验新构建。
> 真机验证时用的是同一份源码的稍早一次构建（体积同为 32,441,368 B，sha256 不同），
> 两者仅构建时间戳不同；正文记录的是**最终发布包**的哈希。

## 1. 症状：两次不同的表现，同一条故障链

### 1.1 第一次：安装界面永久卡住

```
Please wait while Windows configures Tavern Card Studio Server
Time remaining: 2 seconds          ← 永远 2 秒
```

进度条约 70%，取消也卡。**最容易误导人的是：服务其实活着。**

```
netstat:  127.0.0.1:8730  LISTENING  (API worker)
          127.0.0.1:8731  LISTENING  (supervisor 控制面)
tasklist: node.exe × 2，session 0
Get-Service TavernCardStudioServer → Status = StartPending
```

进程在跑、端口通、浏览器能打开面板——唯独 SCM 认为它没启动。
根因见 §2.1（node.exe 不是服务宿主）。

### 1.2 第二次：弹出"服务无法启动"

换成 WinSW 宿主后，症状从"卡住"变成**明确失败**（这本身是进展）：

```
Service 'Tavern Card Studio Server' (TavernCardStudioServer) failed to start.
Verify that you have sufficient privileges to start system services.
                                    [ Retry ]  [ Cancel ]
```

事件日志（`Get-WinEvent -LogName System -ProviderName 'Service Control Manager'`）：

```
[20:32:38] id=7000 错误  由于下列错误，Tavern Card Studio Server 服务启动失败:
                          服务没有及时响应启动或控制请求。
[20:32:38] id=7009 错误  等待 Tavern Card Studio Server 服务的连接超时(300000 毫秒)。
```

用户点 Retry 六次，事件每 5 秒一组——**每次都是进程瞬间退出、从未向 SCM 报到**。
MSI 以 **1603 / 1920** 回滚，安装目录被清空，但 `C:\ProgramData\TavernCardStudio`
（数据目录）保留。

关键判据：**`C:\ProgramData\TavernCardStudio\logs` 始终没有生成**。
WinSW 只要成功加载配置就会先建日志目录，没有目录就说明它死在加载阶段。
根因见 §2.2（XML 注释里的一行分隔线）。

## 2. 根因

### 2.1 主因：node.exe 不是服务宿主

`Product.wxs` 原来这样写：

```xml
<File Id="NodeExe" Source="$(var.StageDir)\node.exe" KeyPath="yes" />
<ServiceInstall ... Arguments="&quot;[INSTALLFOLDER]app\server\dist\index.js&quot; serve ..." />
```

MSI 会把这个组件的 KeyPath 文件（`node.exe`）当作服务的 `binPath`。于是 SCM 启动的是
`node.exe index.js serve ...`。

问题是 **node.exe 从不调用 `StartServiceCtrlDispatcher`**，不会向 SCM 报告 `SERVICE_RUNNING`。
SCM 只能一直等，服务状态卡在 `Start Pending`；而 MSI 里又有
`<ServiceControl Start="install" Wait="yes" />`，它会等 SCM 报告启动完成 —— 两边互等，永久挂起。

> 仓库里 `installer/install-service.ps1`、`tcs-service.ps1` 注释写着
> "supervisor 进程常驻，所以 SCM 会看到稳定进程"。**这个前提是错的**：
> 进程常驻 ≠ SCM 认为服务已启动，服务协议是显式 API，不是靠进程活着。

### 2.2 次因：WinSW v2 不接受配置文件参数

第一版修复把宿主换成 WinSW，但保留了 `Arguments="...\tcs-service-host.xml"`。实测直接报：

```
System.IO.FileNotFoundException: Unable to locate WinSW.NET4.[xml|yml] file within executable directory
```

WinSW v2 是**按文件名**在同目录找配置，不接受命令行给路径。所以：

- `ServiceInstall` 不能有 `Arguments`
- 文件名配对必须严格：`tcs-service-host.exe` ↔ `tcs-service-host.xml`，改一个不改另一个就静默失效

### 2.3 第二个真因（导致第二次失败）：XML 注释里有连字符分隔线

`installer/ServiceHost.xml` 的开头注释里，我用连字符画了三条分隔线：

```
  Why this file exists
  --------------------      ← 非法
  Path tokens
  -----------
  Logs
  ----
```

**XML 规范禁止注释内出现两个连续连字符**，也禁止注释以单个连字符结尾。
于是整份文件不是合法 XML，WinSW 加载配置时的真实报错是：

```
The configuration file cound not be loaded.
XML 注释中不能包含"--"，并且"-"不能是最后一个字符。 第 6 行，位置 3。
```

（原文 `cound` 是 WinSW 自己的拼写错误，便于搜索定位。）

**这条报错在哪里能看到**：控制台。作为服务运行时没有控制台，所以什么都看不到 ——
WinSW 在初始化自己的日志*之前*就退出了，因此 `C:\ProgramData\TavernCardStudio\logs`
根本不会生成。这就是 §1.2 里那个判据的由来。

改成等号分隔线（`====`）即可，等号在 XML 注释里完全合法。

## 3. 修复

| 项 | 变更 |
|---|---|
| 新增 `vendor/winsw/WinSW.NET4.exe` | 832 KiB，WinSW v2.12.0，MIT，sha256 `923111c7…`（来源与校验见 `vendor/winsw/README.md`） |
| 新增 `installer/ServiceHost.xml` | WinSW 配置：`executable=%BASE%\node.exe`、参数、日志路径、崩溃重启 |
| `installer/Product.wxs` | 宿主 exe + xml 入包；`ServiceInstall` **去掉 Arguments**；组件 GUID 更换（KeyPath 变了） |
| `installer/build-msi.ps1` | 校验宿主与配置存在、校验宿主 sha256；传 `WinSwDir` / `ServiceHostConfig` 变量 |
| `installer/install-service.ps1`、`tcs-service.ps1` | **改为拒绝**把 node.exe 注册为服务，缺宿主直接报错并给操作指引 |
| `scripts/pack-server.mjs` | 绿色包也产出 `tcs-service-host.exe` + 同名 xml（数据目录用 `%BASE%\data`，与 MSI 的 ProgramData 区分） |
| `server/src/cli.ts` | `service install` **改为拒绝**直挂 node.exe（退出码 2）；binPath 指向宿主且不带参数 |
| `scripts/gen-wix-fragment.mjs` | 清单排除 `node.exe` / `tcs-service-host.exe` / `tcs-service-host.xml`，避免与 `ServiceComponent` 重复 |
| `installer/uninstall-service.ps1` | 卸载容错：`Stop-Service` 超时不再中断流程，改为强制结束该服务的进程树 + CIM 删服务 |
| `installer/ServiceHost.xml` | 注释里的连字符分隔线换成等号（XML 注释禁止连续连字符） |
| `installer/build-msi.ps1` | **构建期用 .NET XML 解析器校验配置良构性**，非法直接拒绝打包并给出原因 |
| `test/service-host.test.mjs` | 新增最小 XML 良构性检查（注释合法性 + 标签配对），并对检查器本身做自测 |
| 新增 `installer/repair-stuck-install.ps1` | 一次性清理卡住的安装并重装（需管理员） |

### 3.0 为什么第二版仍失败：我验证了错的那一份

第一版修复后我"验证通过"，但验的是**绿色包**的配置（`release/server/tcs-service-host.xml`，
由 `scripts/service-host-template.mjs` 生成），而**打进 MSI 的是另一份**
（`installer/ServiceHost.xml`）。两份只在数据目录上不同——但注释也不同：绿色包那份没有
连字符分隔线，MSI 那份有。

于是：手动跑绿色包 → 配置加载成功 → 我判定"修好了"；实际用户装 MSI → 配置非法 → 服务起不来。

**教训**：验证必须针对**将被打包的那一份**，而且要**从产物里解包出来验**，不能验源码目录或
另一条分支的产物。现在这条已固化为两个可执行检查：

1. `npm test` 里的良构性测试同时覆盖两份配置；
2. `build-msi.ps1` 在打包前解析 `installer/ServiceHost.xml`，非法即失败。

另外还有一个更省事的验证手段：`msiexec /a <msi> /qn TARGETDIR=<临时目录>` ——
**管理员安装解包**，不需要权限就能拿到 MSI 里的最终文件，然后直接运行/解析它们。
本轮就是靠它定位到问题的：解包后运行包内的 `tcs-service-host.exe`，控制台立刻打印出真实的加载错误。

### 3.0.1 同一类错误的第二次：绿色包是旧的，MSI 装的是旧代码

配置修好后重打 MSI，随后解包**内容级检查**，发现包里根本没有本次修复：

```
包内 app/server/dist/config.js   → controlHost 命中 0 处
源码 server/dist/config.js       → controlHost 命中 6 处
绿色包 release/server/.../dist   → 时间 13:55（旧），源码 dist 是 21:21（新）
```

**根因在构建脚本**：`build-msi.ps1` 第 1 步只要看到 `release/server/node.exe` 存在就
"复用已有绿色包"，而 `npm run build:server` 生成的 dist 并不会自动同步进绿色包。
于是改了源码、编译通过、打包成功、退出码 0 —— 但安装包里是几小时前的代码。

这与 §3.0 是同一类错误：**验证/构建看了错的那一份产物**。
配置 XML 那次是"验了另一份配置"，这次是"打包用了另一份 dist"。

**已加固**（`installer/build-msi.ps1`）：

1. **时间链**：绿色包里的 `dist/index.js` 早于 `server/src/**/*.ts` 中最新文件 → 判定过期，强制重打；
2. **内容级**：`server/dist/config.js` 与 `app/server/dist/config.js` 的 sha256 必须相等，
   不等直接抛错并打印两边的哈希。

第 2 条是关键 —— 时间戳会因文件系统精度或手工复制失真，**内容比对才是硬证据**。
修好后重打，构建日志如实输出：

```
[1/4] Bundle is STALE: context.ts is newer than the bundled dist
Bundle content: dist/config.js matches the freshly built one
```

再次解包确认：`dist/config.js` 6 处、`public/index.html` 1 处、`public/app.js` 2 处、
`dist/context.js` 3 处 —— 修复完整进包。

### 3.1 为什么改了四个地方：同一个缺陷有四个出口

“把 node.exe 注册成服务”这件事在代码库里**有四个独立入口**，只修 MSI 等于没修干净：

| # | 入口 | 修复前 | 修复后 |
|---|---|---|---|
| 1 | MSI `Product.wxs` | `ServiceInstall` 直挂 node.exe | 挂 `tcs-service-host.exe` |
| 2 | `installer/install-service.ps1` | `New-Service -BinaryPathName "node.exe ..."` | 校验宿主存在，`BinaryPathName` 只写宿主 |
| 3 | `installer/tcs-service.ps1` | 同上 | 同上 |
| 4 | CLI `service install`（`server/src/cli.ts`） | `sc.exe create binPath= node.exe ...` | 找不到宿主就拒绝（退出码 2） |

四个入口**都改为"找不到宿主就报错"**，而不是"退回 node.exe"。理由是静默降级会造出
一个装不上也停不掉的僵尸服务，比直接失败更糟。

另外两处配套：

- **绿色包**也带宿主（否则方式 B/方式 4 在绿色包上没有可用二进制）；
- **卸载脚本**容错（旧格式服务 `Stop-Service` 会超时，原实现会抛异常导致删除走不到）。

为什么是 WinSW 而不是"注册表 Run 键"：服务端要开机即启、不依赖用户登录会话、无控制台窗口。
WinSW 体积 832 KiB（.NET Framework 4.x，Win10/11 自带 4.8），对安装包影响可忽略。

为什么不用 v3（自包含 .NET Core）：x64 版约 12 MB，收益只是免 .NET Framework 依赖。

## 4. 已验证的部分（无需管理员）

**① XML 良构性**（两次都验，第二次才是真的）：

```bash
python -c "import xml.etree.ElementTree as ET; print(ET.parse('installer/ServiceHost.xml').getroot().tag)"
# → service

# 修好前：FAIL ... XML 注释中不能包含"--"
```

`npm test` 里的 `test/service-host.test.mjs` 覆盖两份配置，并对检查器本身做自测
（喂一段带连字符分隔线的样本，必须判定为非法）。

**② 从产物解包后实际加载** —— 这是本轮定位问题的关键手段：

```powershell
msiexec /a "release\TavernCardStudioServer-0.1.0.msi" /qn TARGETDIR="$env:TEMP\tcs-verify-pkg"
# 然后直接跑解出来的宿主：它会用包内的 xml
& "$env:TEMP\tcs-verify-pkg\PFiles64\Tavern Card Studio Server\tcs-service-host.exe"
```

修复前输出：`The configuration file cound not be loaded. XML 注释中不能包含"--"...`
修复后：无报错，`C:\ProgramData\TavernCardStudio\logs\tcs-service-host.wrapper.log`
被创建（内容 `Starting WinSW in service mode`，因为不在 SCM 之下所以随即退出，属正常）。

`msiexec /a` 是**管理员安装（解包）**，不需要管理员权限，却能拿到 MSI 里的最终文件 ——
以后验证"包里那份到底对不对"，优先用这个，别验源码目录。

**③ node 命令行本身可用**：

```
release/server/node.exe  app\server\dist\index.js serve --config <tmp>\config.json --rules-dir app\rules --port 18950
  → 127.0.0.1:18950 LISTENING (worker)
  → 127.0.0.1:18951 LISTENING (supervisor)
  → GET /api/health → {"status":"ok","role":"worker",...}
```

**④ 包结构**：反编译确认 `tcs-service-host.exe`、`tcs-service-host.xml` 各 1 个条目
（不重复），`ServiceInstall` 无 `Arguments`。

## 5. 真机验证结果（已完成）

修复后由用户在真机重新安装，**一次通过**。采集到的证据：

```
Get-CimInstance Win32_Service -Filter "Name='TavernCardStudioServer'"
  State      = Running
  ExitCode   = 0
  ProcessId  = 42264
  PathName   = "C:\Program Files\Tavern Card Studio Server\tcs-service-host.exe"   ← 宿主，不是 node.exe

netstat:
  127.0.0.1:8730 LISTENING pid=40616   (worker)
  127.0.0.1:8731 LISTENING pid=15592   (supervisor)

tasklist:
  tcs-service-host.exe  42264  Services   ← session 0，SCM 面向的进程
  node.exe              15592  Services   ← supervisor 子进程
  node.exe              40616  Services   ← worker 子进程

GET http://127.0.0.1:8730/api/health  → {"status":"ok","role":"worker","version":"0.1.0",...}
GET http://127.0.0.1:8731/            → HTTP 200
```

服务日志（`C:\ProgramData\TavernCardStudio\logs\tcs-service-host.wrapper.log`）完整记录了这条链：

```
20:45:51 INFO - Starting C:\Program Files\Tavern Card Studio Server\node.exe "...\index.js" serve --config "...\config.json" --rules-dir "...\app\rules"
20:45:51 INFO - Started process 15592
20:45:51 DEBUG - Forwarding logs of the process node to WinSW.SizeBasedRollingLogAppender
```

`tcs-service-host.out.log` 里的 node 输出确认端到端可用：

```json
{"event":"supervisor.listening","panel":"http://127.0.0.1:8731/","api":"http://127.0.0.1:8730","pid":15592}
{"event":"supervisor.worker.started","pid":40616}
```

**结论**：`State=Running` 意味着 SCM 真的收到了 `SERVICE_RUNNING` ——
这正是前两次失败时始终缺失的那一步。

### 5.1 过程中用到的自救脚本

如果再次遇到"装不上"，管理员 PowerShell 里跑：

```powershell
cd 'D:\Claw\代码开发\tavern-card-studio'
.\installer\repair-stuck-install.ps1
```

脚本做 7 件事：**解包自检配置良构性** → 杀残留 node（按 session 0 过滤，不会误杀其他 node）→
杀卡住的 msiexec → 删孤儿服务（用 CIM，因为 `sc.exe` 被策略拦）→ 删安装目录
（**保留 ProgramData 数据**）→ 静默装新 MSI → 等服务 Running 并按"日志目录是否生成"给出故障分类。

用 `-WhatIf` 可只打印动作不执行。

> 说明：本轮修复过程中，工具侧无法发起提权（当前会话 `isAdmin=False`，且
> `Start-Process -Verb RunAs` 拉起解释器会被安全策略拦），所以真机安装由用户执行。
> 这也是为什么 §4 里把"从产物解包后直接运行宿主"当作主要验证手段 —— 它不需要管理员。

## 6. 排障清单（下次遇到"装不上/起不来"）

按顺序查，前两条能定位大部分情况：

1. **`Get-WinEvent -LogName System -ProviderName 'Service Control Manager' -MaxEvents 20`**
   —— 看事件号与时刻：
   - `7009 等待服务连接超时` + `7000 服务没有及时响应` → 服务进程没向 SCM 报到
   - 若同一分钟内反复出现多组，说明每次都是**进程瞬间退出**，不是真的等超时
2. **`C:\ProgramData\TavernCardStudio\logs` 有没有生成** —— 这条最省时间：
   - **生成了** → WinSW 加载配置成功，问题在子进程（node 起不来），看 `tcs-service-host.err.log`
   - **没生成** → WinSW 死在**加载配置**阶段，八成是 XML 本身不合法
     （本轮就是注释里的连字符分隔线；XML 注释禁止连续连字符）
3. **`Get-CimInstance Win32_Service -Filter "Name='<名>'"`** —— 看 `PathName` 指向谁。
   如果指向 `node.exe`/`python.exe` 这类解释器，就是 §2.1 那个坑。
4. **`netstat -ano | findstr 端口`** —— 端口在听但服务 StartPending，说明程序没问题，只是协议没对接。
5. **从产物解包直接试**（无需管理员，也不污染系统）：

   ```powershell
   msiexec /a <msi> /qn TARGETDIR="$env:TEMP\tcs-verify"
   & "$env:TEMP\tcs-verify\PFiles64\Tavern Card Studio Server\tcs-service-host.exe"
   ```

   配置有问题时它会在**控制台**直接打印真实原因 —— 服务模式下这条信息会丢掉，
   因为 WinSW 在初始化日志之前就退出了。
6. **安装日志**：`msiexec /i <msi> /l*v install.log`，搜 `Return value 3`（服务启动失败）
   和 `Error 1925`（权限不足）。**双击安装不产生日志**，排障时务必带 `/l*v`。

## 7. 同步修改过的交付材料

代码改了而文档不改，等于给下一个人挖坑 —— 尤其"服务怎么装"是部署文档里被反复照抄的段落。
本轮同步更新：

| 文件 | 改了什么 |
|---|---|
| `docs/09-server-deploy.md` §5.1 | 服务命令行改为宿主；加"不能用 node.exe"警告框；令牌改为从服务日志取；`ServiceInstall` 无 `Arguments` 的解释；验证片段补 `tcs-service-host` 检查 |
| `docs/09-server-deploy.md` §5.2 | 标明前置条件（目录里必须有宿主）；说明脚本会拒绝直挂 node.exe |
| `docs/09-server-deploy.md` §5.3 | dry-run 示例改为真实输出（binPath 指向宿主）；补拒绝场景与退出码 2 |
| `docs/09-server-deploy.md` §5.5（新增） | 服务日志三个文件的作用 + 四步排障顺序 |
| `docs/09-server-deploy.md` §5.6（新增） | **配置 XML 必须良构**：注释里不能有连续连字符，附构建期校验说明 |
| `docs/09-server-deploy.md` §6 | 手工 `wix build` 补 `-d WinSwDir` / `-d ServiceHostConfig`（缺了会编译失败） |
| `docs/17-release-delivery.md` §2.2 | 安装步骤改为 MSI 优先；说明服务由 WinSW 托管；令牌与日志取法 |
| `docs/17-release-delivery.md` §10 | 已知限制新增三条：服务依赖 .NET 4.x、宿主是第三方二进制、服务端 MSI 同样 perMachine |
| `README.md` 服务端命令段 | `pack:server` 说明带宿主；新增注册服务一行 + node.exe 不能当服务的警告 |
| `README.md` 决策表 | #23 补充第三个坑（XML 注释里的连续连字符会让配置加载失败） |
| `README.md` 发布检查清单 | 4b 增加"配置 XML 良构"与"构建期会拒绝非法 XML" |
| `vendor/winsw/README.md` | 补"配置必须是良构 XML"的警告与自查命令 |

**判断某份文档是否过时的快速方法**：搜 `sc.exe create` / `New-Service` / `binPath`，
如果后面跟的是 `node.exe`，那就是旧说明。

**判断配置是否会被 WinSW 拒绝的快速方法**：

```bash
python -c "import xml.etree.ElementTree as ET; ET.parse('installer/ServiceHost.xml'); print('ok')"
# 或（无 python 环境）：
node -e "const s=require('fs').readFileSync('installer/ServiceHost.xml','utf8');for(const m of s.matchAll(/<!--([\s\S]*?)-->/g))if(m[1].includes('--'))throw new Error('注释内含连续连字符');console.log('ok')"
```


## 8. 顺带发现的坑

**`sc.exe` 在工具环境里被安全策略禁用**（Program Blacklist）。所以任何清理脚本都不能依赖
`sc delete` / `sc query`，要改用 CIM：

```powershell
Get-CimInstance Win32_Service -Filter "Name='X'" | Remove-CimInstance
```

**`Add-Type` 也被禁用**，因此排障时不要写依赖 P/Invoke 的 PowerShell。

**`Start-Process -Verb RunAs` 只能拉起 `msiexec.exe` 这类非解释器**，拉 `powershell.exe` 会被拦。
需要提权的多步操作只能交给用户手动执行，或写成一个脚本让用户一次跑完。
