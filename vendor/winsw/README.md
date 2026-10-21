# vendor/winsw — 服务宿主（第三方二进制）

## 这是什么

`WinSW.NET4.exe`：把普通控制台程序包装成真正的 Windows 服务。

## 为什么必须有它

`node.exe` 不是服务宿主程序。它不会调用 `StartServiceCtrlDispatcher`，因此 SCM 永远收不到
`SERVICE_RUNNING`，服务状态停在 `Start Pending`。如果 MSI 用 `<ServiceInstall>` 直接把
node.exe 注册成服务，`msiexec` 会卡在

```
Please wait while Windows configures Tavern Card Studio Server
Time remaining: 2 seconds        ← 永远停在这里
```

**2026-10-21 实际踩过这个坑**，而且极具迷惑性：服务进程其实活着，8730（API）和 8731（控制面）
都在 `LISTENING`，看起来完全正常，只有 SCM 的状态是 `Start Pending`。

WinSW 作为面向 SCM 的进程负责：报告 RUNNING、捕获 stdout/stderr 到滚动日志、崩溃后重启子进程。

## 来源

| 项 | 值 |
|---|---|
| 项目 | https://github.com/winsw/winsw |
| 版本 | v2.12.0 |
| 文件 | `WinSW.NET4.exe` |
| 下载地址 | https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET4.exe |
| 字节数 | **852,480**（832 KiB） |
| sha256 | `923111c7142b3dc783a3c722b19b8a21bcb78222d7a136ac33f0ca8a29f4cb66` |
| 许可证 | MIT |
| PE 架构 | x86（0x014c，WOW64）— 服务宿主只需要启动 64 位 node.exe，位数无影响 |

校验：

```bash
sha256sum vendor/winsw/WinSW.NET4.exe
# 923111c7142b3dc783a3c722b19b8a21bcb78222d7a136ac33f0ca8a29f4cb66
```

## 为什么选 .NET4 变体而不是 v3

v2 的 .NET4 变体依赖 .NET Framework 4.x，体积 832 KiB；v3 是自包含的 .NET Core，x64 版约 12 MB。
Windows 10/11 内置 .NET Framework 4.8，所以 832 KiB 那个够用，且体积对安装包影响可忽略。

**前提**：目标机必须有 .NET Framework 4.0+。Win10/11 默认满足；若要在精简版 Server Core 上部署，
先确认一下（`Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full'`）。

## 配置必须是良构 XML（踩过的坑）

WinSW 用标准 XML 解析器读配置。**XML 注释里不能出现两个连续连字符**，也不能以单个连字符结尾 ——
换句话说，**不能用破折号画分隔线**：

```xml
<!-- 错误：整份配置会变成非法 XML -->
  Logs
  ----

<!-- 正确：用等号 -->
  Logs
  ====
```

失败表现极具误导性，值得单独记一笔：

1. WinSW 打印 `The configuration file cound not be loaded. XML 注释中不能包含"--"...`（`cound` 是它的拼写错误）；
2. 但它是在**初始化自己日志之前**就退出，所以 `logpath` 目录根本不会生成；
3. 作为服务运行时没有控制台，于是这条信息**完全看不到**；
4. 外面只剩事件日志 `7009 等待服务连接超时` 与 MSI 回滚 `1920`。

2026-10-21 因此连续失败两次。现在 `installer/build-msi.ps1` 会在打包前强制校验良构性，
`test/service-host.test.mjs` 也会覆盖。自查：

```bash
python -c "import xml.etree.ElementTree as ET; ET.parse('installer/ServiceHost.xml'); print('ok')"
```

## 配置文件

不是这个目录里的文件，而是 `installer/ServiceHost.xml`（MSI 会把它装成
`tcs-service-host.xml`）。路径用 `%BASE%`（宿主 exe 所在目录），所以不依赖构建机路径。

日志落在 `C:\ProgramData\TavernCardStudio\logs\`。**服务端首次启动生成的访问令牌只打印一次**，
在服务模式下没有控制台，那一行只能从日志里捞。
