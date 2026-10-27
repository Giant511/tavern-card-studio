# 客户端 MSI 的 WiX 模板（本项目已接管）

`main.wxs` 是 **Tauri 官方 WiX 模板的副本 + 本项目改动**，通过
`tauri.conf.json` 的 `bundle.windows.wix.template` 生效。

## 为什么接管模板

需求 F14.1（卸载时询问是否删除客户端配置）需要三样东西：一个 `Property`
（`DELETEDATA`）、一个 `CustomAction`（删目录）、一个 `Dialog`（复选框）。

第一版走的是 `bundle.windows.wix.fragmentPaths`（"只加一个片段，不动模板"），
**失败了，而且失败得非常安静**：

- `candle.exe` 编译片段成功，`uninstall-data.wixobj` 里 `DELETEDATA` / `DeleteDataDlg` /
  `DeleteClientDataDir` 符号齐全；
- `light.exe` 链接成功，退出码 0，无警告；
- 但反编译产出的 MSI，`Dialog` / `Property` / `CustomAction` 三张表里**一行都没有**。

根因：WiX 3 的 linker 只链接**被引用到的**片段。片段里的 `Component` 会因为
`componentRefs` 被拉进去，而单独声明的 `Property` / `CustomAction` / `UI`
没有任何引用者，于是整段被丢弃。Tauri 文档里 `fragmentPaths` 的用法也正是
"配合 `componentRefs` 补组件"，它天生补不了界面与自定义动作。

所以只剩两条路：接管 `template`，或者不做这个对话框。选了前者。

## 改了哪些地方

在模板副本里搜 `Tavern Card Studio 追加`，共三处：

1. `<Property Id="DELETEDATA" Secure="yes" />` —— **只声明不给值**，空值即"不勾选"；
2. `<CustomAction Id="DeleteClientDataDir" ...>` + 一条 `InstallExecuteSequence`
   （`Before="RemoveFiles"`，条件 `REMOVE="ALL" AND DELETEDATA=1`）；
3. `<UI>` 里的 `DeleteDataDlg` 对话框，以及把
   `MaintenanceTypeDlg` 的 **`RemoveButton`** 改道到它的那条 `Publish`（`Order="2"`）。

除此之外没有动 Tauri 原有的任何一行 —— 升级对齐时可以按这三处重新打补丁。

## 一个**配置**级的改动（v0.1.6，不在 wxs 里）

`tauri.conf.json` 里显式写了 `"wix": { "allowDowngrades": false }`。

Tauri 2 这个字段的默认值是 **true**（官方 schema 的 `WindowsConfig.allowDowngrades`），
于是渲染出来的模板走 `{{#if allow_downgrades}}` 分支：
`<MajorUpgrade AllowDowngrades="yes" />`，Upgrade 表只有一行 `VersionMin=0`、
`VersionMax` 留空 —— **装回旧版会被当成升级执行**，静默替换掉已装的新版。

对本项目这是危险的：0.1.6 起服务端数据库与客户端配置都往前走了，程序回退到旧版
却配着新结构的数据/配置，症状比"装不上"难查得多。改成 `false` 后走 else 分支：
`DowngradeErrorMessage="!(loc.DowngradeErrorMessage)"`（en-US 文案见 Tauri 的
`locale.wxl`），Upgrade 表变成 `VersionMax=<当前版本>` + 一行 OnlyDetect 的降级行。

判据不要只看源码：`msiexec` 的行为由 **MSI 里的 `Upgrade` 表**决定，
用 `WindowsInstaller.Installer` COM 读 `SELECT * FROM Upgrade` 才是硬证据
（本项目 v0.1.5 客户端实测 `Attributes=257`、`VersionMax` 空 = 允许降级）。

## 升级 Tauri 之后必须做的事

模板来自 `tauri-apps/tauri` 仓库的
`crates/tauri-bundler/src/bundle/windows/msi/main.wxs`（本次取的是 `dev` 分支，
对应 CLI 2.12.3）。升级 Tauri 时：

1. 重新下载上面那份模板，与原版做 diff，看有没有新增/改名的 `{{占位符}}`；
2. 把本文件里三处"追加"重新贴进新版模板；
3. **验收方式：反编译逐表比对**。不要只看"构建成功"——上面那次失败就是构建成功。
   把旧的合法产物和新产物都 `wix msi decompile`，比对 `File` / `Component` /
   `Shortcut` / `RegistryValue` / `Directory` / `Feature` 的**数量**，差异必须只等于
   本项目新增的那几项（1 个 CustomAction、1 个 Dialog、4 条 Publish、1 个 Property）。

```powershell
# 反编译任意 MSI（用服务端仓库里的 wix.exe，能读 WiX 3 产物）
.\.tools\wix\tools\net6.0\any\wix.exe msi decompile `
  "client\src-tauri\target\release\bundle\msi\Tavern Card Studio_0.1.2_x64_en-US.msi" `
  -o D:\tmp\client.wxs
```

## 已知边界

- **完成页文案没改**：`ExitDialog` 属于 WiX 的标准对话框集，正文是编译期就写进
  Dialog 表的字面量，改它要么改本地化文件（Tauri 不暴露这个入口），要么劫持
  Finish 按钮（它自带的 `EndDialog Return` 会先执行）。客户端因此把"配置目录在哪、
  不勾选就保留"写在**决策页本身**（`DeleteDataDlg`，即卸载前的最后一页）
  而不是完成页。服务端没有这个限制（自己的 wxs，`-loc` 覆盖 `ExitDialogDescription`）。
- **只删配置，不删卡片**：客户端的数据分两处 —— `%APPDATA%\com.taverncardstudio.client`
  （配置、令牌）与 `Documents\TavernCardStudio\cards`（用户的角色卡）。后者是用户文档，
  卸载程序不碰，对话框里明确写了这一点。
- `Directory` 用的是 `INSTALLDIR` 而不是 `SystemFolder`：Tauri 模板没有在 Directory 表里
  声明 `SystemFolder`，用了会 `LGHT0094 Unresolved reference`；命令行走 `[%ComSpec]`
  环境变量形式，绕开 Directory 表。
