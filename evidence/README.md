# T10.25 卸载端到端验收记录

> 状态：**PASS（27/27）**，2026-10-30 17:11–17:15，真机、管理员会话。
> 原始日志见同目录 `t10.25-result.txt` 与 `t10.25-uninstall-cleanup.txt`。

## 一、这次验了什么

`scripts/verify-uninstall-msi.ps1` 三条路径，每条都做**文件系统断言**，
不是"看安装程序没报错"。

| 路径 | 操作 | 判据 |
|---|---|---|
| A | 卸载带 `DELETEDATA=1` | 数据目录与安装目录都必须消失 |
| B | 卸载不带 | 数据仍在（`config.json` **逐字节未变**）、安装目录清空 |
| C | 安装目录里造 `data\` + `logs\` + `user-notes.txt` | 白名单内的清、白名单外的留 |

## 二、结果

```text
VERDICT=PASS PASSED=27 TOTAL=27
```

关键几条（原文摘录）：

```text
OK A 数据目录已删除 — C:\ProgramData\TavernCardStudio
OK A 安装目录已清空 — C:\Program Files\Tavern Card Studio Server
OK B 数据目录仍在 — C:\ProgramData\TavernCardStudio
OK B 数据内容未变 — config.json 逐字节一致
OK C 白名单外文件被保留 — user-notes.txt
OK C data 子目录被清 — data\
OK C logs 子目录被清 — logs\
```

## 三、第三方证据（比脚本自己的断言更硬）

路径 C 的清理动作会把判断写进 `%TEMP%\TavernCardStudio-uninstall-cleanup.log`。
那是 `tcs-server cleanup` **自己**写的记录，不是脚本推出来的结论：

```text
whitelisted leftovers:
  DELETED data                     10 B in 1 file(s)
  DELETED logs                     10 B in 1 file(s)

kept (not on the whitelist — listed for review, NOT deleted):
  KEPT    app                      25.4 MB (dir)
  KEPT    node.exe                 83.0 MB
  KEPT    user-notes.txt           12 B
  ...

summary: deleted 2 file(s) / 20 B in 2 item(s); kept 9 item(s); failed 0 item(s)
```

这一段的用处：文件系统断言只能证明"最终状态对"，
证明不了"清理走的是白名单规则" —— 万一是 MSI 把整个目录删了、
恰好也没留下 `data\`？那三条断言照样绿，但白名单其实没执行。
日志能分辨这两种情况，**也是唯一能验证"白名单外保留"这条规则本身的证据**。

## 四、这次跑之前修掉的问题（都有真实崩溃为证）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `state.db 正由另一进程使用` | MSI 装完会把服务端注册成服务并**立即启动**，持有 db 句柄 | 装完先停服务再造数据；写文件加 6×500ms 占用重试 |
| 2 | `Stop-TcsService 无法识别为 cmdlet` | 新增函数被塞在调用点**之后**，而 PS 按执行顺序创建函数 | 函数定义全部前移到「准备区」；纪律写成断言 `test/ps1-definition-order.test.mjs` |
| 3 | 重跑会**吃掉用户真实数据** | 上次崩在中途，数据目录里是脚本造的假数据；第 1 步会把它当"现有数据"备份，收尾再覆盖回去 | 新增 0.5 清遗留 + 0.6 识别假数据并从历史备份还原 |

第 3 条最危险：用户的 54 个真实文件当时只在旧的 `%TEMP%\tcs-t10.25-*` 里，
本次 0.6 段把它们还原回来了（日志：`OK 还原上次的真实数据 — 54 个文件`）。

## 五、一条被改掉的"绿而无用"断言

原先路径 A 有一条 `A 清理日志已产出`。它取到的是日志文件**头部**那行
（日志是追加写的，头部是 2026-10-24 的旧记录）：

```text
install dir : D://tmp//t1025-lab2//install      ← 几天前的调试路径
```

时间戳校验能通过（文件确实刚被写过），但**展示出来的证据是旧的** ——
人看日志会以为本次跑到了那个路径。

改法：

- 路径 A 改成**负向判据**「本次不应产生新的清理段落」。
  理由：勾删时 `DeleteDataDir` 先删掉 ProgramData，`CleanInstallResidue`
  要用的 `node.exe` 连安装目录一起被删了，所以 A 本来就产生不了日志。
  这条负向判据有真信息量 —— 它失败就说明 RemoveFiles 没按预期删干净。
- 路径 C 加上**从最后一次运行段落里**取的四条断言
  （`DELETED data` / `DELETED logs` / `KEPT user-notes.txt` / `failed 0 item`），
  并把 `summary:` 行原样打进日志。

## 六、复跑

```powershell
# 右键 scripts\run-as-admin.cmd → 以管理员身份运行
```

退出码：`0` 通过 / `1` 有断言失败 / `2` 非管理员 / `3` 停不掉服务。
四种情况的下一步动作不同，`run-as-admin.cmd` 会分别给出提示。

> 脚本跑前会**整份备份** `C:\ProgramData\TavernCardStudio`，跑完自动还原；
> 备份目录保留在 `%TEMP%\tcs-t10.25-<时间戳>\backup-before\` 供事后核对。
