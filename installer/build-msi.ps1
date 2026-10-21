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
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1 -Version 0.1.1 -Repack
#   powershell -ExecutionPolicy Bypass -File installer\build-msi.ps1 -WixPath 'C:\tools\wix\wix.exe'
#
# 输出：release\TavernCardStudioServer-<version>.msi
# 该 MSI 安装服务端、注册 TavernCardStudioServer 自启动 Windows 服务，
# 数据目录固定在 C:\ProgramData\TavernCardStudio（卸载不删数据）。

[CmdletBinding()]
param(
  [string]$Version = '0.1.0',
  [string]$WixPath = '',
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
& $wix --version
if ($LASTEXITCODE -ne 0) { throw 'wix.exe is not runnable (check the .NET runtime)' }

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
$wixArgs = @(
  'build'
  (Join-Path $scriptDir 'Product.wxs')
  $appFiles
  '-arch', 'x64'
  '-d', "StageDir=$stageResolved"
  '-d', "WinSwDir=$winSwResolved"
  '-d', "ServiceHostConfig=$serviceHostResolved"
  '-d', "ProductVersion=$Version"
  '-o', $msi
)
# 直接把参数数组 splat 出去：PowerShell 调用原生 exe 时会自己为含空格的参数加引号。
# 不要手工拼引号（会变成字面引号传给 wix，报 "unrecognized option"）。
& $wix @wixArgs
if ($LASTEXITCODE -ne 0) { throw "wix build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $msi)) { throw "wix build reported success but $msi is missing" }

# ---------------------------------------------------- 4. 结果与后续操作提示
$size = (Get-Item -LiteralPath $msi).Length / 1MB
Write-Host '[4/4] Done.'
Write-Host ''
Write-Host ("MSI:      {0} ({1:N1} MB)" -f $msi, $size)
Write-Host ("Version:  {0}" -f $Version)
Write-Host ''
Write-Host 'Install (elevated PowerShell):'
Write-Host ('  msiexec /i "' + $msi + '" /l*v install.log')
Write-Host 'Uninstall (keeps data in C:\ProgramData\TavernCardStudio):'
Write-Host ('  msiexec /x "' + $msi + '" /l*v uninstall.log')
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
