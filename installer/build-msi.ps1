# Build the Windows MSI installer (WiX Toolset v4/v5).
#
# WiX 4 起把 candle/light/heat 合并为单一的 `wix build`，并取消了 heat 的目录采集
# （需要额外装 HeatWave 扩展）。本项目改为用 scripts\gen-wix-fragment.mjs 自己遍历
# release\server 生成 AppFiles.wxs，因此构建机只需要一个 wix 可执行文件。
#
# 前置条件：
#   - WiX v4/v5。三种获取路径，脚本按顺序自动探测：
#       a) -WixPath 显式指定 wix.exe 完整路径
#       b) .tools\wix\wix.exe（把 nuget 包 wix 的工具目录解压到这里）
#       c) PATH 中的 wix
#     离线获取（推荐，构建机无需联网装 dotnet tool）：
#       curl -L -o wix.zip https://www.nuget.org/api/v2/package/wix/5.0.2
#       unzip wix.zip -d .tools\wix
#       # 可执行文件位于 .tools\wix\tools\net6.0\any\wix.exe
#   - 已执行 npm run build（server\dist 需要存在）。
#   - WiX UI 扩展（WixToolset.UI.wixext）：向导界面与卸载对话框依赖它。
#     已入库在 vendor\wixext\（755 KiB，来源与 sha256 见那里的 README），
#     所以离线构建不需要额外下载。若换版本，见该 README 的"更新方法"。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1 -Version 0.1.1 -Repack
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1 -WixPath 'C:\tools\wix\wix.exe'
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1 -WixExt 'C:\ext\WixToolset.UI.wixext.dll'
#
# 输出：release\TavernCardStudioServer-<version>.msi
# 该 MSI 安装服务端、注册 TavernCardStudioServer 自启动 Windows 服务，
# 数据目录固定在 C:\ProgramData\TavernCardStudio（卸载时询问是否删除，默认保留）。

[CmdletBinding()]
param(
  [string]$Version = '0.1.4',
  [string]$WixPath = '',
  [string]$WixExt = '',
  # 留空则在正文里解析（param 默认值阶段 $PSScriptRoot 可能为空，见下方说明）
  [string]$StageDir = '',
  [string]$OutDir = '',
  [switch]$Repack
)

$ErrorActionPreference = 'Stop'

# 不要在 param() 默认值里用 $PSScriptRoot：用 `powershell -File installer\build-msi.ps1`
# 调用时它在参数绑定阶段可能是空串（PS 5.1 实测），Split-Path -Parent '' 会直接抛错。
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repo = Split-Path -Parent $scriptDir
if ([string]::IsNullOrEmpty($StageDir)) { $StageDir = Join-Path $repo 'release\server' }
if ([string]::IsNullOrEmpty($OutDir)) { $OutDir = Join-Path $repo 'release' }

# 服务宿主（WinSW）。node.exe 不能直接当 Windows 服务，见 Product.wxs 里的说明。
# 两者都必须存在，否则打出来的 MSI 会在安装阶段卡在 Start Pending。
$winSwDir = Join-Path $repo 'vendor\winsw'
$winSwExe = Join-Path $winSwDir 'WinSW.NET4.exe'
$serviceHostConfig = Join-Path $scriptDir 'ServiceHost.xml'
if (-not (Test-Path -LiteralPath $winSwExe)) {
  throw "缺少服务宿主：$winSwExe。见 vendor\winsw\README.md（832 KiB，sha256 记在那里）。"
}
if (-not (Test-Path -LiteralPath $serviceHostConfig)) {
  throw "缺少服务配置：$serviceHostConfig"
}

# 第三方二进制入库后要能被验证，否则"我放了一份 winsw"无法自证。
$winSwExpectedSha = '923111c7142b3dc783a3c722b19b8a21bcb78222d7a136ac33f0ca8a29f4cb66'
$winSwActualSha = (Get-FileHash -LiteralPath $winSwExe -Algorithm SHA256).Hash.ToLower()
if ($winSwActualSha -ne $winSwExpectedSha) {
  throw "服务宿主哈希不符：期望 $winSwExpectedSha，实际 $winSwActualSha。若确实要升级 WinSW，请同时更新 vendor\winsw\README.md 与本行。"
}
Write-Host "Service host: vendor\winsw\WinSW.NET4.exe (sha256 verified)"

# 服务配置必须是良构 XML，否则打出来的包装不上，而且错误只在用户机器上暴露。
#
# 2026-10-21 的实际事故：ServiceHost.xml 的注释里有一行连字符分隔线，XML 规范禁止
# 注释内出现连续连字符，于是 WinSW 加载配置即失败 → 服务不向 SCM 报到 → 事件 7009 →
# MSI 回滚 1920。整条链上没有任何一步报"XML 非法"，只在安装时炸。
# 用 .NET 的 XML 解析器在构建期拦一道，几毫秒的成本换掉这类事故。
try {
  $null = [xml](Get-Content -LiteralPath $serviceHostConfig -Raw -Encoding UTF8)
  Write-Host "Service host config: well-formed XML"
} catch {
  throw "服务配置不是良构 XML，拒绝打包：$serviceHostConfig`n  $($_.Exception.Message)`n  （常见原因：注释里出现连续连字符，例如用破折号画分隔线）"
}
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw 'node.exe not found on PATH. Install Node.js >= 20.11 (or run the generator manually: node scripts/gen-wix-fragment.mjs).'
}
$node = $nodeCmd.Source

# WiX v4/v5 的 wix.exe 是 .NET 应用；若机器只装了更高版本的运行时，
# 用 roll-forward 让它跑起来（否则会报 framework not found）。
$env:DOTNET_ROLL_FORWARD = 'Major'

function Resolve-Wix {
  param([string]$Explicit)

  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { throw "wix.exe not found: $Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }

  # b) .tools\wix — 支持两种解压布局：整包解压（tools\net6.0\any）或只解压工具目录
  $candidates = @(
    (Join-Path $repo '.tools\wix\tools\net6.0\any\wix.exe'),
    (Join-Path $repo '.tools\wix\wix.exe'),
    (Join-Path $repo '.tools\wix\tools\net8.0\any\wix.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return (Resolve-Path -LiteralPath $candidate).Path }
  }

  # c) PATH
  $cmd = Get-Command wix -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  throw @'
wix.exe not found. Provide it in one of these ways:
  - installer\build-msi.ps1 -WixPath <path to wix.exe>
  - extract the WiX nuget package to .tools\wix  (wix.exe ends up in .tools\wix\tools\net6.0\any\)
  - install WiX v4/v5 and make sure `wix` is on PATH
Offline download:
  curl -L -o wix.zip https://www.nuget.org/api/v2/package/wix/5.0.2
  unzip wix.zip -d .tools\wix
'@
}

$wix = Resolve-Wix -Explicit $WixPath
Write-Host "WiX: $wix"
$wixVersionText = (& $wix --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'wix.exe is not runnable (check the .NET runtime)' }
Write-Host "WiX version: $wixVersionText"

# ------------------------------------------------- WiX UI 扩展（向导 + 卸载对话框）
#
# 为什么必须有它：v0.1.2 起卸载流程要问"要不要删数据"（F14.1），
# 而标准对话框集只有 WixUI_InstallDir 在 Remove 与 Ready 之间留了插页的位置
# （见 Product.wxs 里那段长注释）。没有这个扩展，Product.wxs 里的
# <ui:WixUI> 与 <Dialog> 会编译失败。
#
# 扩展已入库在 vendor\wixext\，所以离线构建不需要联网。仍然保留三个探测位置，
# 是为了让"想用自己那份扩展"的人不必改脚本。
$uiExtExpectedSha = '5ce7f958b6a2b57bcb98c19615c5a3da46976a6e78a6af055fdef99e9e9e8f06'

function Resolve-WixExt {
  param([string]$Explicit)

  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { throw "WiX UI 扩展不存在：$Explicit" }
    return (Resolve-Path -LiteralPath $Explicit).Path
  }

  $candidates = @()
  $vendored = Join-Path $repo 'vendor\wixext'
  if (Test-Path -LiteralPath $vendored) {
    $candidates += Get-ChildItem -LiteralPath $vendored -Filter '*.wixext*.dll' -File |
      Sort-Object Name -Descending | ForEach-Object { $_.FullName }
  }
  $tools = Join-Path $repo '.tools\wix-ext'
  if (Test-Path -LiteralPath $tools) {
    $candidates += Get-ChildItem -LiteralPath $tools -Filter '*.wixext*.dll' -Recurse -File |
      Sort-Object Name -Descending | ForEach-Object { $_.FullName }
  }
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  throw @'
WiX UI extension not found (needed for the uninstall dialog since v0.1.2).
Expected one of:
  - vendor\wixext\WixToolset.UI.wixext.<version>.dll   (vendored, preferred)
  - .tools\wix-ext\...\WixToolset.UI.wixext.dll
  - -WixExt <path to WixToolset.UI.wixext.dll>
Offline download (then unzip and take wixext5\WixToolset.UI.wixext.dll):
  curl -L -o ui.nupkg https://www.nuget.org/api/v2/package/WixToolset.UI.wixext/5.0.2
See vendor\wixext\README.md.
'@
}

$wixExt = Resolve-WixExt -Explicit $WixExt
$wixExtSha = (Get-FileHash -LiteralPath $wixExt -Algorithm SHA256).Hash.ToLower()
if ($wixExtSha -ne $uiExtExpectedSha) {
  throw @"
WiX UI 扩展哈希不符：期望 $uiExtExpectedSha
                     实际 $wixExtSha
  文件：$wixExt
第三方二进制要能被验证。若确实要升级扩展，请同时更新 vendor\wixext\README.md 与本行。
"@
}

# 扩展的大版本必须与 wix.exe 一致：v5 的扩展 v6 不认，反之亦然。
# 文件名里带版本号就是为了能在打包前拦住这种错配，而不是等到用户机器上才发现。
$extNameVersion = [regex]::Match((Split-Path -Leaf $wixExt), 'wixext\.(\d+)\.(\d+)\.(\d+)\.dll$')
if ($extNameVersion.Success) {
  $extMajor = [int]$extNameVersion.Groups[1].Value
  $wixMajor = [int]([regex]::Match($wixVersionText, '^(\d+)').Groups[1].Value)
  if ($extMajor -ne $wixMajor) {
    throw "WiX UI 扩展是 v$extMajor，而 wix.exe 是 $wixVersionText —— 大版本必须一致。"
  }
  Write-Host "WiX UI extension: $(Split-Path -Leaf $wixExt) (sha256 verified, v$extMajor matches wix)"
} else {
  Write-Host "WiX UI extension: $wixExt (sha256 verified; version not parsed from filename)"
}

# ---------------------------------------------------------------- 1. 绿色包
#
# 复用已有绿色包是有条件的：**它不能比源码旧**。
#
# 2026-10-21 踩过：改了 server/src（新增 controlHost），`npm run build:server` 生成了新
# dist，但绿色包仍是几小时前那份；这里只看"node.exe 在不在"就复用了它，于是 MSI 里
# 装的还是旧代码 —— 源码里 6 处 controlHost，包内 0 处。安装后功能缺失，而构建全程无报错。
#
# 判据：绿色包里的关键产物（dist/index.js）必须不早于源码目录里最新的 .ts。
$bundleEntry = Join-Path $StageDir 'app\server\dist\index.js'
$bundleIsStale = $false
if (Test-Path -LiteralPath $bundleEntry) {
  $bundleTime = (Get-Item -LiteralPath $bundleEntry).LastWriteTimeUtc
  $newestSource = Get-ChildItem -LiteralPath (Join-Path $repo 'server\src') -Recurse -Filter *.ts -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newestSource -and $newestSource.LastWriteTimeUtc -gt $bundleTime) {
    $bundleIsStale = $true
    Write-Host ("[1/4] Bundle is STALE: {0} is newer than the bundled dist" -f $newestSource.Name)
  }
}

if ($Repack -or $bundleIsStale -or -not (Test-Path -LiteralPath (Join-Path $StageDir 'node.exe'))) {
  Write-Host '[1/4] Packaging server bundle (npm run pack:server)...'
  Push-Location $repo
  try {
    & npm.cmd run pack:server
    if ($LASTEXITCODE -ne 0) { throw "npm run pack:server failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "[1/4] Reusing existing bundle: $StageDir"
}

if (-not (Test-Path -LiteralPath (Join-Path $StageDir 'app\server\dist\index.js'))) {
  throw "Bundle is incomplete: app\server\dist\index.js missing. Run `npm run build` then `npm run pack:server`."
}

# 内容级断言：绿色包里的 dist 必须和刚编译的 dist 一致。
# 时间戳可能因为文件系统精度/手工复制而失真，内容比对才是硬证据。
$freshConfig = Join-Path $repo 'server\dist\config.js'
$bundledConfig = Join-Path $StageDir 'app\server\dist\config.js'
if ((Test-Path -LiteralPath $freshConfig) -and (Test-Path -LiteralPath $bundledConfig)) {
  $freshHash = (Get-FileHash -LiteralPath $freshConfig -Algorithm SHA256).Hash
  $bundledHash = (Get-FileHash -LiteralPath $bundledConfig -Algorithm SHA256).Hash
  if ($freshHash -ne $bundledHash) {
    throw @"
绿色包里的 dist/config.js 与刚编译的 server\dist\config.js 不一致 —— 包内是旧代码。

  源码:  $freshHash
  包内:  $bundledHash

修复：先 npm run build:server，再 npm run pack:server（或用 -Repack 让本脚本代跑）。
"@
  }
  Write-Host 'Bundle content: dist/config.js matches the freshly built one'
}

# ------------------------------------------------------- 2. 生成文件清单片段
$generated = Join-Path $scriptDir 'generated'
New-Item -ItemType Directory -Path $generated -Force | Out-Null
Write-Host '[2/4] Generating file manifest (scripts/gen-wix-fragment.mjs)...'
Push-Location $repo
try {
  & $node 'scripts\gen-wix-fragment.mjs'
  if ($LASTEXITCODE -ne 0) { throw "gen-wix-fragment.mjs failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$appFiles = Join-Path $generated 'AppFiles.wxs'
if (-not (Test-Path -LiteralPath $appFiles)) { throw "Missing generated fragment: $appFiles" }

# ------------------------------------------------------------ 3. 构建 MSI
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$msi = Join-Path $OutDir "TavernCardStudioServer-$Version.msi"
if (Test-Path -LiteralPath $msi) { Remove-Item -LiteralPath $msi -Force }

Write-Host '[3/4] Building MSI...'
# 注意：不要写成 "StageDir=$(Resolve-Path ...).Path" —— 双引号里的 .Path 是字面量，
# 会拼成 "…\release\server.Path"，wix 随后报一堆 WIX0103 找不到文件。
$stageResolved = (Resolve-Path -LiteralPath $StageDir).Path
$winSwResolved = (Resolve-Path -LiteralPath $winSwDir).Path
$serviceHostResolved = (Resolve-Path -LiteralPath $serviceHostConfig).Path

# 连接说明页（装机后自动打开、并在开始菜单留快捷方式）。
# 缺了它 MSI 会构建失败 —— 这是有意的：指引是交付物的一部分，不该被静默跳过。
$connectGuide = Join-Path $scriptDir 'connect-guide.html'
if (-not (Test-Path -LiteralPath $connectGuide)) {
  throw "Missing connect guide: $connectGuide"
}
$connectGuideResolved = (Resolve-Path -LiteralPath $connectGuide).Path

# 安装布局标记：`.cmd` 启动器靠它区分"MSI 安装"与"绿色包"，从而选对配置文件。
# 绿色包里没有这个文件（pack-server 不生成），所以它是一个可靠的显式信号。
$layoutMarker = Join-Path $scriptDir 'install-layout.ini'
if (-not (Test-Path -LiteralPath $layoutMarker)) {
  throw "Missing install layout marker: $layoutMarker"
}
$layoutMarkerResolved = (Resolve-Path -LiteralPath $layoutMarker).Path

# 向导界面用到的两件附属物（F14.1）：
#   · license.rtf  —— WixUI_InstallDir 编译期强制要求，即使许可页已被跳过；
#   · ui-text.wxl  —— 覆盖 ExitDialog 的正文，把数据目录位置写进完成页。
$licenseRtf = Join-Path $scriptDir 'license.rtf'
if (-not (Test-Path -LiteralPath $licenseRtf)) {
  throw "Missing license RTF: $licenseRtf (required by WixUI_InstallDir, see Product.wxs)"
}
$licenseRtfResolved = (Resolve-Path -LiteralPath $licenseRtf).Path

$uiText = Join-Path $scriptDir 'ui-text.wxl'
if (-not (Test-Path -LiteralPath $uiText)) {
  throw "Missing UI text overrides: $uiText (the uninstall finish page would lose the data-directory hint)"
}
$uiTextResolved = (Resolve-Path -LiteralPath $uiText).Path

$wixArgs = @(
  'build'
  (Join-Path $scriptDir 'Product.wxs')
  $appFiles
  '-arch', 'x64'
  '-ext', $wixExt
  '-loc', $uiTextResolved
  '-d', "StageDir=$stageResolved"
  '-d', "WinSwDir=$winSwResolved"
  '-d', "ServiceHostConfig=$serviceHostResolved"
  '-d', "ConnectGuide=$connectGuideResolved"
  '-d', "LayoutMarker=$layoutMarkerResolved"
  '-d', "LicenseRtf=$licenseRtfResolved"
  '-d', "ProductVersion=$Version"
  '-o', $msi
)
# 直接把参数数组 splat 出去：PowerShell 调用原生 exe 时会自己为含空格的参数加引号。
# 不要手工拼引号（会变成字面引号传给 wix，报 "unrecognized option"）。
& $wix @wixArgs
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $msi)) { throw "wix build reported success but $msi is missing" }

# ------------------------------------------- 4. MSI 内容断言（防静默不生效）
#
# 为什么需要这一步：WiX 对「元素放错位置」有时**不报错也不警告**，只是不写进表。
# 2026-10-22 实测：把 <InstallExecuteSequence> 写在 <Fragment> 里，
# wix build 退出码 0、日志一条警告都没有，但反编译后 CustomAction 表是空的 ——
# 装完根本不会弹连接说明。这类问题只有"解包反编译"才能发现。
#
# 断言这些，缺一即失败：
#   · CustomAction 表有 OpenConnectGuide（安装后打开说明页）；
#   · Shortcut 表有快捷方式（开始菜单能再次打开）；
#   · File 表有 connect-guide.html（说明页本身在包里）；
#   · Dialog 表有 DeleteDataDlg，且它的复选框控件绑在 DELETEDATA 上（F14.1）；
#   · ControlEvent 表有 "MaintenanceTypeDlg / RemoveButton / NewDialog → DeleteDataDlg"
#     —— 这一条最要紧：控件名写错时 WiX 编译成功、日志无警告、那行直接消失，
#     界面上就是"根本没有卸载选项那一页"（2026-10-24 实际踩过，写成 Remove 而不是 RemoveButton）；
#   · Property 表里 DELETEDATA 没有默认值 —— 有值就意味着复选框可能默认勾上；
#   · ExitDialog 的正文被 ui-text.wxl 换成了带数据目录的版本。
Write-Host '[4/5] Verifying MSI content (decompile)...'
$decompDir = Join-Path $OutDir '.decompile'
if (Test-Path -LiteralPath $decompDir) { Remove-Item -LiteralPath $decompDir -Recurse -Force }
New-Item -ItemType Directory -Path $decompDir -Force | Out-Null
$decompFile = Join-Path $decompDir 'decompiled.wxs'
$null = & $wix msi decompile $msi -o $decompFile 2>&1
if (-not (Test-Path -LiteralPath $decompFile)) {
  throw "MSI decompile failed; cannot verify installer content."
}
$decompiled = Get-Content -LiteralPath $decompFile -Raw
$missing = @()
if ($decompiled -notmatch '<CustomAction[^>]*OpenConnectGuide') { $missing += 'CustomAction:OpenConnectGuide' }
if ($decompiled -notmatch '<Shortcut') { $missing += 'Shortcut' }
if ($decompiled -notmatch 'connect-guide\.html') { $missing += 'File:connect-guide.html' }
if ($decompiled -notmatch 'install-layout\.ini') { $missing += 'File:install-layout.ini' }
if ($decompiled -notmatch '<Dialog Id="DeleteDataDlg"') { $missing += 'Dialog:DeleteDataDlg' }
if ($decompiled -notmatch 'Property="DELETEDATA"') { $missing += 'Control:DeleteDataCheck(Property=DELETEDATA)' }
if ($decompiled -notmatch '<CustomAction[^>]*Id="DeleteDataDir"') { $missing += 'CustomAction:DeleteDataDir' }
if ($decompiled -notmatch '<CustomAction[^>]*Id="CleanInstallResidue"') { $missing += 'CustomAction:CleanInstallResidue' }
if ($decompiled -notmatch 'Data directory \(kept unless you delete it during uninstall\)') { $missing += 'UIText:ExitDialogDescription' }
if ($missing.Count -gt 0) {
  throw ("MSI is missing expected entries: {0}. The build succeeded but the installer will not behave as expected." -f ($missing -join ', '))
}

# 复选框默认态：DELETEDATA 只能"声明"，不能有值。
# 反编译里 `<Property Id="DELETEDATA" .../>` 只要带了 Value 就算失败。
$deletedataDefault = [regex]::Match($decompiled, '<Property Id="DELETEDATA"[^>]*>')
if ($deletedataDefault.Success -and $deletedataDefault.Value -match 'Value=') {
  throw ("Property DELETEDATA 带了默认值（{0}）—— 卸载对话框的复选框会默认勾上，这违反 F14.1 的保守默认。" -f $deletedataDefault.Value)
}

# 控件名断言：Remove 按钮上的 NewDialog 必须有一条指向 DeleteDataDlg。
# 反编译把 ControlEvent 表展开成控件下的 <Publish>，所以按控件块抓。
$removeButtonBlock = [regex]::Match($decompiled, '(?s)<Control Id="RemoveButton".*?</Control>')
if (-not $removeButtonBlock.Success) {
  throw 'MSI 里找不到 MaintenanceTypeDlg 的 RemoveButton 控件 —— 标准对话框集可能变了，请复核 Product.wxs 里的 Publish 目标控件名。'
}
if ($removeButtonBlock.Value -notmatch 'Value="DeleteDataDlg"') {
  throw 'MaintenanceTypeDlg.RemoveButton 没有指向 DeleteDataDlg 的 NewDialog —— 卸载对话框不会出现（常见原因：Publish 的 Control 名写成了 Remove）。'
}

# 残留清理的时序断言：必须夹在"删数据"与"删安装目录"之间。
#
# WiX 不允许同一个 Custom 同时写 After 与 Before（WIX0035），所以顺序靠一条链：
#     DeleteDataDir --Before--> CleanInstallResidue --Before--> RemoveFiles
# 顺序有意义：清理要先看到"数据目录还在不在"，才知道日志写 ProgramData 还是 %TEMP%。
$residueSeq = [regex]::Match($decompiled, '<Custom Action="CleanInstallResidue"[^>]*>')
if (-not $residueSeq.Success) {
  throw 'InstallExecuteSequence 里没有 CleanInstallResidue —— 卸载后安装目录残留不会被清理（构建成功不代表它进了表）。'
}
if ($residueSeq.Value -notmatch 'Before="RemoveFiles"') {
  throw 'CleanInstallResidue 必须在 RemoveFiles 之前：之后执行时安装目录已被删，清理无处可跑。'
}
$dataSeq = [regex]::Match($decompiled, '<Custom Action="DeleteDataDir"[^>]*>')
if (-not $dataSeq.Success) {
  throw 'InstallExecuteSequence 里没有 DeleteDataDir。'
}
if ($dataSeq.Value -notmatch 'Before="CleanInstallResidue"') {
  throw 'DeleteDataDir 必须排在 CleanInstallResidue 之前（两者都只锚 RemoveFiles 时相对顺序未定义）。'
}

Remove-Item -LiteralPath $decompDir -Recurse -Force
Write-Host '  CustomAction / Shortcut / connect-guide.html / DeleteDataDlg / DELETEDATA all present'

# ---------------------------------------------------- 5. 结果与后续操作提示
$size = (Get-Item -LiteralPath $msi).Length / 1MB
Write-Host '[5/5] Done.'
Write-Host ''
Write-Host ("MSI:      {0} ({1:N1} MB)" -f $msi, $size)
Write-Host ("Version:  {0}" -f $Version)
Write-Host ''
Write-Host 'Install (elevated PowerShell):'
Write-Host ('  msiexec /i "' + $msi + '" /l*v install.log')
Write-Host 'Uninstall (asks whether to delete the data directory; default keeps it):'
Write-Host ('  msiexec /x "' + $msi + '" /l*v uninstall.log')
Write-Host 'Silent uninstall that also deletes the data directory:'
Write-Host ('  msiexec /x "' + $msi + '" /qn DELETEDATA=1')
Write-Host ''
Write-Host 'Admin panel after install:  http://127.0.0.1:8731/'
Write-Host 'Service name:              TavernCardStudioServer'
Write-Host 'Service logs:              C:\ProgramData\TavernCardStudio\logs\'
Write-Host ''
Write-Host 'If the service does not come up, read the log above — the first-run access'
Write-Host 'token is printed there (a service has no console to print it to).'
Write-Host ''
Write-Host 'Without the MSI you can also register the service from a plain bundle:'
Write-Host '  powershell -ExecutionPolicy Bypass -File installer\install-service.ps1 -InstallDir release\server'
