# 客户端壳构建验证（目标机上运行）
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File client\scripts\verify-build.ps1
#
# 做 7 件事，逐步打印结果，并把完整输出写到 .verify\last-run.txt：
#   1. 检查 Rust 工具链（rustc / cargo）
#   2. 检查 Node / npm 版本
#   3. npm install
#   4. 前端类型检查（契约层 + 渲染层）
#   5. tauri build（含 MSI 打包）
#   6. 输出 MSI 路径与体积
#   7. **时间链断言**：源文件 ≤ dist ≤ exe/MSI（防止交付的安装包不含最新前端）
#
# 任一步失败即停止，退出码 = 失败步骤序号，便于 CI 判断。
#
# 一次性前置（管理员 PowerShell）：
#   winget install Rustlang.Rustup
#   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
#   winget install Microsoft.EdgeWebView2Runtime

[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# 不在 param() 默认值里用 $PSScriptRoot（PS 5.1 下 -File 调用时可能为空）
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$repo = Split-Path -Parent (Split-Path -Parent $scriptDir)
$client = Join-Path $repo 'client'
$logDir = Join-Path $repo '.verify'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$script:lines = New-Object System.Collections.Generic.List[string]
$script:step = 0

function Write-Result([string]$text, [string]$level = 'INFO') {
  $line = "[$level] $text"
  $script:lines.Add($line)
  Write-Host $line
}

function Fail([int]$stepNo, [string]$message, [string]$hint) {
  Write-Result "步骤 $stepNo 失败：$message" 'FAIL'
  if ($hint) { Write-Result "  → $hint" 'HINT' }
  $script:lines.Add("")
  $script:lines.Add("结论：未通过（卡在步骤 $stepNo）")
  $script:lines | Set-Content -LiteralPath (Join-Path $logDir 'last-run.txt') -Encoding utf8
  exit $stepNo
}

# 调用外部命令并收集 stdout+stderr。
#
# 为什么需要这个包装：$ErrorActionPreference = 'Stop' 时，native 命令往 stderr 写的
# 每一行都会被 PowerShell 5.1 当成 ErrorRecord 抛出（NativeCommandError），
# 于是 `tauri build` 打印一行例行 Info 就会让整个脚本中断——失败原因还看不到。
# 这里临时把 EA 降为 Continue，只把退出码当作失败判据。
function Run-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @Arguments 2>&1
    $code = $LASTEXITCODE
    foreach ($line in $output) {
      $text = "    $line"
      $script:lines.Add($text)
      Write-Host $text
    }
    return $code
  } finally {
    $ErrorActionPreference = $previous
  }
}

# ── 步骤 1：Rust 工具链 ─────────────────────────────────────
$script:step = 1
Write-Result '步骤 1/7：检查 Rust 工具链'
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $rustc -or -not $cargo) {
  Fail 1 '找不到 rustc 或 cargo' 'winget install Rustlang.Rustup 后重开终端（PATH 需要刷新）'
}
$rustVersion = (& rustc --version) 2>&1
$cargoVersion = (& cargo --version) 2>&1
Write-Result "  $rustVersion"
Write-Result "  $cargoVersion"

# 链接器检查：Windows 上 Tauri 需要 MSVC 的 link.exe。
# 注意：link.exe 通常不在 PATH 里（要跑 vcvars 才有），rustc 自己会通过
# vswhere / 注册表找到 MSVC，所以这里只做提示，不作为失败判据。
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
  $vsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) 2>&1
  if ($vsPath) {
    Write-Result "  MSVC 已安装：$vsPath"
  } else {
    Write-Result '  vswhere 未找到 VCTools 组件 —— 编译阶段可能报 linker 错误' 'WARN'
  }
} else {
  Write-Result '  未找到 vswhere（VS Installer），若编译报 linker 错误请装 VS Build Tools 的 VCTools' 'WARN'
}

# ── 步骤 2：Node / npm ─────────────────────────────────────
$script:step = 2
Write-Result '步骤 2/7：检查 Node / npm'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 2 '找不到 node' '安装 Node.js >= 20.11' }
$nodeVersion = (& node --version)
$npmVersion = (& npm --version)
Write-Result "  node $nodeVersion / npm $npmVersion"
$nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) { Fail 2 "Node 版本过低：$nodeVersion" '需要 >= 20.11（package.json 的 engines）' }

# ── 步骤 3：依赖安装 ───────────────────────────────────────
$script:step = 3
if ($SkipInstall) {
  Write-Result '步骤 3/7：跳过（-SkipInstall）' 'WARN'
} else {
  Write-Result '步骤 3/7：npm install（仓库根，workspaces）'
  Push-Location $repo
  try {
    $code = Run-Native -Exe 'npm.cmd' -Arguments @('install', '--no-audit', '--no-fund')
    if ($code -ne 0) { Fail 3 "npm install 退出码 $code" '检查网络或代理；必要时 npm config set registry' }
  } finally { Pop-Location }
  Write-Result '  npm install 完成'
}

# ── 步骤 4：前端类型检查 ───────────────────────────────────
$script:step = 4
Write-Result '步骤 4/7：前端类型检查（client/tsconfig.json）'
Push-Location $repo
try {
  $code = Run-Native -Exe 'npm.cmd' -Arguments @('run', 'typecheck', '--workspace', '@tcs/client')
  if ($code -ne 0) { Fail 4 "类型检查失败（退出码 $code）" '按报错修契约层或渲染层类型' }
} finally { Pop-Location }
Write-Result '  类型检查通过（0 error）'

# ── 步骤 5：tauri build ────────────────────────────────────
$script:step = 5
if ($SkipBuild) {
  Write-Result '步骤 5/7：跳过（-SkipBuild）' 'WARN'
} else {
  Write-Result '步骤 5/7：tauri build（含 MSI 打包，首次约 5–15 分钟）'
  Push-Location $client
  try {
    $code = Run-Native -Exe 'npm.cmd' -Arguments @('run', 'build')
    if ($code -ne 0) { Fail 5 "tauri build 退出码 $code" '常见原因：缺 MSVC 链接器 / 缺 WebView2 / WiX 下载被拦' }
  } finally { Pop-Location }
  Write-Result '  tauri build 完成'
}

# ── 步骤 6：产物与体积 ─────────────────────────────────────
$script:step = 6
Write-Result '步骤 6/7：产物核对'
$msiDir = Join-Path $client 'src-tauri\target\release\bundle\msi'
if (-not (Test-Path -LiteralPath $msiDir)) {
  if ($SkipBuild) {
    Write-Result '  跳过构建，无产物可核对' 'WARN'
  } else {
    Fail 6 "没有找到 MSI 目录：$msiDir" '确认 bundle.targets 含 msi，且构建未被中断'
  }
} else {
  $msiFiles = Get-ChildItem -LiteralPath $msiDir -Filter *.msi
  if ($msiFiles.Count -eq 0) { Fail 6 "MSI 目录为空：$msiDir" '检查 tauri build 日志里的 bundler 段' }
  foreach ($file in $msiFiles) {
    $mb = [math]::Round($file.Length / 1MB, 2)
    Write-Result ("  {0}  {1} MB  {2} 字节" -f $file.Name, $mb, $file.Length)
  }
  $exe = Join-Path $client 'src-tauri\target\release\tcs-shell.exe'
  if (Test-Path -LiteralPath $exe) {
    $exeMb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 2)
    Write-Result "  tcs-shell.exe  $exeMb MB"
  }
}

# ── 步骤 7：时间链断言（源 → dist → 交付物）───────────────
#
# 为什么必须有这一步：Tauri 把前端产物 **brotli 压缩后内嵌**进 exe 的资源段，
# 因此**无法**通过在 exe 里 grep 中文字符串来证明"包里是最新前端"（grep 永远是 0 命中）。
# 2026-10-21 实际踩过：MSI 构建于 16:40，而当时的前端产物是 17:26，
# 交付的安装包不含最新代码——文件名、体积、退出码全都正常，看不出来。
#
# 判据只能是**时间链**。查四段，因为 `tauri build` 的 beforeBuildCommand
# 只跑 `vite build`（client/dist），**不会重建 shared/dist**：
#   ① shared/src  ≤ shared/dist                （改了 shared 却没重编译）
#   ② 源 + shared/dist + rules ≤ client/dist    （vite 没重跑）
#   ③ client/dist ≤ tcs-shell.exe               （没重新内嵌）
#   ④ client/dist ≤ MSI                         （交付物不含最新前端）
#
# **注意：不要断言 `exe ≤ MSI`。** 实测（2026-10-21）两者 mtime 没有固定先后：
#   exe      mtime = 17:58:42.899
#   MSI      mtime = 17:58:38.126  ← light.exe 生成时刻
#   MSI 的 ctime/创建 = 17:58:42.888 ← 被移入 bundle\msi 的时刻
# 原因是 Tauri 在打完包后还会 patch exe（写入 bundle 类型信息），
# 而 MSI 是先在临时目录生成、再整体挪进输出目录（mtime 被保留）。
# 所以这里统一用「dist ≤ 交付物」作为判据，不比较两个产物之间的先后。
$script:step = 7
Write-Result '步骤 7/7：时间链断言（源 ≤ dist ≤ 交付物）'

# 容差 1 秒：避免构建极快时同秒内的时间戳抖动造成假失败；
# 真实事故的间隔是分钟级，不会被容差吃掉。
$script:toleranceSec = 1

function Get-NewestWriteTime {
  param([string[]]$Paths)
  $newest = $null
  $newestFile = $null
  foreach ($path in $Paths) {
    if ([string]::IsNullOrEmpty($path)) { continue }
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $items = Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue
    foreach ($item in $items) {
      if ($null -eq $newest -or $item.LastWriteTimeUtc -gt $newest) {
        $newest = $item.LastWriteTimeUtc
        $newestFile = $item.FullName
      }
    }
  }
  return @{ Time = $newest; File = $newestFile }
}

function Format-Stamp($timeUtc) {
  if ($null -eq $timeUtc) { return '(无)' }
  return $timeUtc.ToLocalTime().ToString('MM-dd HH:mm:ss')
}

# 断言 newer 不晚于 older（允许 tolerance 秒的抖动）
function Assert-Chain {
  param($Newer, $Older, [string]$desc, [string]$hint)
  if ($null -eq $Newer.Time -or $null -eq $Older.Time) {
    Write-Result "  - $desc：缺少一侧文件，跳过" 'WARN'
    return
  }
  $gap = ($Newer.Time - $Older.Time).TotalSeconds
  if ($gap -gt $script:toleranceSec) {
    $msg = "$desc 倒置：$($Newer.File) 更新（$(Format-Stamp $Newer.Time)），" +
           "而 $($Older.File) 更旧（$(Format-Stamp $Older.Time)），相差 $([math]::Round($gap,1)) 秒"
    Fail 7 $msg $hint
  }
  Write-Result ("  OK {0}（间隔 {1} 秒）" -f $desc, [math]::Round($gap, 1))
}

$sharedSrc = Get-NewestWriteTime @((Join-Path $repo 'shared\src'))
$sharedDist = Get-NewestWriteTime @((Join-Path $repo 'shared\dist'))
$clientInputs = Get-NewestWriteTime @(
  (Join-Path $client 'src'),
  (Join-Path $client 'index.html'),
  (Join-Path $client 'perf.html'),
  (Join-Path $repo 'rules')
)
$uiDist = Get-NewestWriteTime @((Join-Path $client 'dist'))

# ② 的"较新一侧"= max(client 源, shared/dist, rules)；rules 已并入 clientInputs
$distInputs = $clientInputs
if ($null -ne $sharedDist.Time -and ($null -eq $distInputs.Time -or $sharedDist.Time -gt $distInputs.Time)) {
  $distInputs = $sharedDist
}

Assert-Chain -Newer $sharedSrc -Older $sharedDist `
  -desc 'shared/src ≤ shared/dist' `
  -hint '先跑 npm run build:shared（tauri build 不会替你重建 shared）'

Assert-Chain -Newer $distInputs -Older $uiDist `
  -desc '源 + shared/dist + rules ≤ client/dist' `
  -hint '前端产物比源旧：重跑 npm run build:ui -w @tcs/client（或 npm run build）'

$exePath = Join-Path $client 'src-tauri\target\release\tcs-shell.exe'
$exeInfo = Get-NewestWriteTime @($exePath)
Assert-Chain -Newer $uiDist -Older $exeInfo `
  -desc 'client/dist ≤ tcs-shell.exe' `
  -hint 'exe 比 dist 旧：tauri 没有重新内嵌前端，重跑 npm run build'

$msiDirForChain = Join-Path $client 'src-tauri\target\release\bundle\msi'
if (Test-Path -LiteralPath $msiDirForChain) {
  $msiFilesForChain = Get-ChildItem -LiteralPath $msiDirForChain -Filter *.msi -File -ErrorAction SilentlyContinue
  if ($null -ne $msiFilesForChain -and $msiFilesForChain.Count -gt 0) {
    $newestMsi = $msiFilesForChain | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    $msiInput = @{ Time = $newestMsi.LastWriteTimeUtc; File = $newestMsi.FullName }
    Assert-Chain -Newer $uiDist -Older $msiInput `
      -desc 'client/dist ≤ MSI' `
      -hint 'MSI 比 dist 旧：交付物不含最新前端。删掉 bundle\msi 后重跑 npm run build'
    Write-Result ("  交付物 {0}  {1} 字节" -f $newestMsi.Name, $newestMsi.Length)
    Write-Result ("  （仅供参考，不作为判据）exe mtime {0} / MSI mtime {1} / MSI 创建 {2}" -f `
      (Format-Stamp $exeInfo.Time), (Format-Stamp $newestMsi.LastWriteTimeUtc), (Format-Stamp $newestMsi.CreationTimeUtc))
  } else {
    Write-Result '  - MSI 链：目录内没有 .msi，跳过' 'WARN'
  }
}

$script:lines.Add('')
$script:lines.Add('结论：通过')
$script:lines | Set-Content -LiteralPath (Join-Path $logDir 'last-run.txt') -Encoding utf8
Write-Result "全部通过。日志：$(Join-Path $logDir 'last-run.txt')"
exit 0