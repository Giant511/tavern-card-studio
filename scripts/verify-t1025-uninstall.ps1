# T10.25 —— 卸载端到端验证（勾选删数据 / 不勾保留 + 安装目录残留）
#
# 这个脚本**不做删除**，它只做两件事：布置现场（Setup）与事后断言（Check）。
# 卸载动作由你在"设置 → 应用"或控制面板里做，卸载对话框才是被测对象。
#
# ## 为什么必须由你执行
#
# 卸载要提权，而工具侧拿不到提权会话（本仓库的历史结论：非管理员下
# `msiexec /qn` 必定失败，日志里是 `MSI_LUA: Elevation prompt disabled`）。
# 所以这里给的是"现场布置 + 证据回收"，跑完把 report 文件发回来即可。
#
# ## 用法（**管理员** PowerShell）
#
#   1. 先看流程与截图清单：
#        .\scripts\verify-t1025-uninstall.ps1 -Phase Guide
#
#   2. 装好服务端、用一下（建账户、传一张卡），然后布置现场：
#        .\scripts\verify-t1025-uninstall.ps1 -Phase Setup
#      （这一步会在安装目录里造 data\ logs\ foreground.log user-notes.txt，
#        并记一份数据目录快照，供事后比对）
#
#   3. 去卸载。**第一轮**在卸载对话框里**不勾**"同时删除数据目录"。
#
#   4. 断言"数据保留"：
#        .\scripts\verify-t1025-uninstall.ps1 -Phase Check -Expect DataKept
#
#   5. 重装一遍（数据目录还在，账户还能用），再卸载。**第二轮**这次**勾上**复选框。
#
#   6. 断言"数据删除"：
#        .\scripts\verify-t1025-uninstall.ps1 -Phase Check -Expect DataRemoved
#
# 退出码：0 = 全部通过；1 = 有断言不满足（报告里逐条列出）；2 = 前置条件不满足。
#
# ## 截图要求（脚本无法代替）
#
# 卸载向导是 msiexec 的窗口，脚本跑的时候它已经不在了，所以下面四类必须手截：
#   A. 卸载选项页 —— 复选框**未勾选**的状态（这是"默认不勾"的唯一证据）
#   B. 卸载完成页 —— 正文里有数据目录位置的那一行
#   C. 卸载后的资源管理器 —— 安装目录 / 数据目录各一张（两轮共 4 张）
#   D. C:\ProgramData\TavernCardStudio\logs\uninstall-cleanup.log 的内容（或 %TEMP% 下那份）
# 文件名建议：t1025-a-uninstall-options.png、t1025-b-exit-page.png、
#             t1025-c1-installdir-kept.png、t1025-c2-datadir-kept.png、
#             t1025-c3-installdir-removed.png、t1025-c4-datadir-removed.png、
#             t1025-d-cleanup-log.png
# 截图放 assets/（README 的卸载小节会引用 t1025-a-* 那张）。

[CmdletBinding()]
param(
  [ValidateSet('Guide', 'Setup', 'Check')]
  [string]$Phase = 'Guide',

  # Check 阶段必填：这一次卸载时到底勾没勾"同时删除数据目录"
  [ValidateSet('DataRemoved', 'DataKept')]
  [string]$Expect = 'DataKept',

  [string]$InstallDir = 'C:\Program Files\Tavern Card Studio Server',
  [string]$DataDir = 'C:\ProgramData\TavernCardStudio',
  [string]$ServiceName = 'TavernCardStudioServer',

  # 证据落点；默认桌面下的新文件夹（空目录，不动其它任何东西）
  [string]$EvidenceDir = '',

  # 布置现场时跳过残留文件（只想验数据目录时用）
  [switch]$SkipResidue
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0
$script:Checks = New-Object System.Collections.ArrayList

if ([string]::IsNullOrEmpty($EvidenceDir)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ([string]::IsNullOrEmpty($desktop)) { $desktop = $env:TEMP }
  $EvidenceDir = Join-Path $desktop 'tcs-t1025-evidence'
}

$tempLogPath = Join-Path $env:TEMP 'TavernCardStudio-uninstall-cleanup.log'
$dataLogPath = Join-Path (Join-Path $DataDir 'logs') 'uninstall-cleanup.log'
$snapshotPath = Join-Path $EvidenceDir 'setup-snapshot.json'

# ── 输出小工具 ────────────────────────────────────────────────
function Write-Section([string]$text) {
  Write-Host ''
  Write-Host "── $text " -NoNewline
  Write-Host ('─' * [Math]::Max(4, 74 - $text.Length))
}

function Add-Check([bool]$ok, [string]$label, [string]$detail = '') {
  $null = $script:Checks.Add([pscustomobject]@{ ok = $ok; label = $label; detail = $detail })
  if ($ok) {
    if ($detail) { Write-Host "  [PASS] $label（$detail）" -ForegroundColor DarkGreen }
    else { Write-Host "  [PASS] $label" -ForegroundColor DarkGreen }
  } else {
    $script:Failures += 1
    if ($detail) { Write-Host "  [FAIL] $label —— $detail" -ForegroundColor Red }
    else { Write-Host "  [FAIL] $label" -ForegroundColor Red }
  }
}

function Add-Skip([string]$label, [string]$why) {
  $null = $script:Checks.Add([pscustomobject]@{ ok = $null; label = $label; detail = $why })
  Write-Host "  [SKIP] $label —— $why" -ForegroundColor DarkYellow
}

function Add-Note([string]$text) {
  Write-Host "  [NOTE] $text" -ForegroundColor DarkCyan
}

function Test-IsAdmin() {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not [string]::IsNullOrEmpty($dir) -and -not (Test-Path -LiteralPath $dir)) {
    $null = New-Item -ItemType Directory -Path $dir -Force
  }
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $encoding)
}

# ── 度量：只读 ────────────────────────────────────────────────
function Get-DirStat([string]$path) {
  $result = [ordered]@{ exists = $false; fileCount = 0; bytes = 0 }
  if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]$result }
  $result.exists = $true
  $files = @(Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue)
  $result.fileCount = $files.Count
  $sum = 0
  foreach ($file in $files) { $sum += $file.Length }
  $result.bytes = $sum
  return [pscustomobject]$result
}

function Get-FileFingerprint([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $item = Get-Item -LiteralPath $path
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLower()
  return [pscustomobject]@{ exists = $true; bytes = $item.Length; sha256 = $hash }
}

function Get-ServiceState([string]$name) {
  $service = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($null -eq $service) { return [pscustomobject]@{ installed = $false; status = '' } }
  return [pscustomobject]@{ installed = $true; status = [string]$service.Status }
}

function Get-ListeningPorts([int[]]$ports) {
  $found = @()
  try {
    foreach ($port in $ports) {
      $conn = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
      if ($conn) { $found += $port }
    }
  } catch {
    # Get-NetTCPConnection 不可用时的兜底：netstat
    $text = (netstat -ano -p TCP) -join "`n"
    foreach ($port in $ports) {
      if ($text -match (':' + $port + '\s+\S+\s+LISTENING')) { $found += $port }
    }
  }
  return $found
}

function Get-UninstallRegistryEntry() {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  $hits = @()
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($key in Get-ChildItem -Path $root -ErrorAction SilentlyContinue) {
      $props = Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue
      if ($null -eq $props) { continue }
      if ($null -ne $props.DisplayName -and $props.DisplayName -like 'Tavern Card Studio Server*') {
        $hits += [pscustomobject]@{ DisplayName = $props.DisplayName; Key = $key.PSPath }
      }
    }
  }
  return $hits
}

# ── 清理日志解析 ──────────────────────────────────────────────
# 日志是追加写的（重试跑两遍会留两块），只断言**最后一块**否则会把上一轮的
# 结论当成本轮的（既有教训：等待/断言的对象必须是这一轮真正会变的东西）。
function Get-LastLogBlock([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $lines = @(Get-Content -LiteralPath $path -Encoding UTF8)
  $starts = @()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^=== Tavern Card Studio uninstall cleanup') { $starts += $i }
  }
  if ($starts.Count -eq 0) { return $null }
  $begin = $starts[$starts.Count - 1]
  $block = @()
  for ($i = $begin; $i -lt $lines.Count; $i++) {
    $block += $lines[$i]
    if ($lines[$i] -match '^=== done ') { break }
  }
  return [pscustomobject]@{ lines = $block; text = ($block -join "`n"); count = $starts.Count }
}

# ── Guide ─────────────────────────────────────────────────────
function Invoke-Guide() {
  Write-Host ''
  Write-Host 'T10.25 卸载端到端验证 —— 操作手册' -ForegroundColor Cyan
  Write-Host ''
  Write-Host "安装目录：$InstallDir"
  Write-Host "数据目录：$DataDir"
  Write-Host "服务名  ：$ServiceName"
  Write-Host "证据目录：$EvidenceDir"
  Write-Host ''
  Write-Host '两轮验证，顺序不能反（第二轮要先重装，借第一轮留下的数据）：' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  第 1 轮 · 不勾选 → 数据必须留下'
  Write-Host '    1) 装服务端 MSI；建一个账户，传一张卡（让数据目录里有真东西）'
  Write-Host '    2) .\scripts\verify-t1025-uninstall.ps1 -Phase Setup'
  Write-Host '       -> 会往安装目录里放 data\ logs\ foreground.log user-notes.txt'
  Write-Host '       -> 命令结束时会提示 4 张必截图'
  Write-Host '    3) 去卸载。卸载选项页出现时 ——【先截图 A】，保持复选框不勾，点 Next'
  Write-Host '    4) 完成页出现时 ——【截图 B】，然后 Finish'
  Write-Host '    5) 【截图 C1/C2】安装目录、数据目录各一张'
  Write-Host '    6) .\scripts\verify-t1025-uninstall.ps1 -Phase Check -Expect DataKept'
  Write-Host '       -> 期望：数据目录在、state.db 哈希未变、残留被清、user-notes.txt 还在'
  Write-Host ''
  Write-Host '  第 2 轮 · 勾选 → 数据必须清空'
  Write-Host '    7) 重装服务端 MSI（数据目录还在，账户应能直接登录 —— 这也顺带验了"保留"是真的）'
  Write-Host '    8) .\scripts\verify-t1025-uninstall.ps1 -Phase Setup'
  Write-Host '    9) 去卸载。卸载选项页出现时【截图 A2】，这次勾上复选框，点 Next'
  Write-Host '   10) 完成页【截图 B2】，Finish'
  Write-Host '   11) 【截图 C3/C4】安装目录、数据目录各一张（数据目录应不存在）'
  Write-Host '   12) .\scripts\verify-t1025-uninstall.ps1 -Phase Check -Expect DataRemoved'
  Write-Host '       -> 期望：数据目录不存在、清理日志在 %TEMP%、安装目录只剩白名单外的文件'
  Write-Host ''
  Write-Host '  收尾：截图 D —— 清理日志内容（两轮各一张，共 7~8 张）' -ForegroundColor Yellow
  Write-Host ''
  Write-Host '  最后把整个证据目录发回：' -NoNewline
  Write-Host $EvidenceDir -ForegroundColor Cyan
  Write-Host ''
  Write-Host '注意：' -ForegroundColor Yellow
  Write-Host '  · 必须用管理员 PowerShell 打开本脚本（Setup 要往 Program Files 写测试文件）'
  Write-Host '  · 两轮的 Check 都会读 setup-snapshot.json，第二轮会覆盖第一轮 —— 所以'
  Write-Host '    Check 必须在对应那一轮卸载之后立刻跑，别两轮跑完再一起验'
  Write-Host '  · Check 只读：不删文件、不改注册表、不碰服务'
  Write-Host ''
}

# ── Setup ─────────────────────────────────────────────────────
function Invoke-Setup() {
  if (-not (Test-IsAdmin)) {
    Write-Host '需要管理员权限：Setup 要往安装目录里写测试文件。' -ForegroundColor Red
    return 2
  }

  Write-Section '前置检查'
  if (-not (Test-Path -LiteralPath $InstallDir)) {
    Write-Host "  [FAIL] 安装目录不存在：$InstallDir" -ForegroundColor Red
    Write-Host '         先装服务端 MSI，再跑 Setup。'
    return 2
  }
  Add-Check $true '安装目录存在' $InstallDir

  $service = Get-ServiceState $ServiceName
  Add-Check $service.installed '服务已注册' "$ServiceName / $($service.status)"
  if (-not $service.installed) {
    Write-Host '         服务没注册，说明这不是一次 MSI 安装（或已被卸载）。Setup 中止。' -ForegroundColor Red
    return 2
  }

  if (-not (Test-Path -LiteralPath $DataDir)) {
    Write-Host "  [WARN] 数据目录还不存在：$DataDir" -ForegroundColor Yellow
    Write-Host '         先启动服务并建一个账户，让数据目录里出现真东西，否则"保留"验不出内容。'
  } else {
    Add-Check $true '数据目录存在' $DataDir
  }

  Write-Section '布置残留现场（白名单内 + 白名单外各一批）'
  $residue = @()
  if (-not $SkipResidue) {
    $fixtures = @(
      @{ rel = 'data\fixture-from-t1025.txt'; text = 'runtime residue fixture'; category = 'whitelist:data' },
      @{ rel = 'data\store\blob.bin'; text = ('B' * 4096); category = 'whitelist:data' },
      @{ rel = 'logs\run.log'; text = 'foreground run log fixture'; category = 'whitelist:logs' },
      @{ rel = 'foreground.log'; text = 'top level log fixture'; category = 'whitelist:logfile' },
      @{ rel = 'user-notes.txt'; text = 'T10.25 fixture — MUST SURVIVE the uninstall'; category = 'NOT whitelisted:must survive' }
    )
    foreach ($fixture in $fixtures) {
      $abs = Join-Path $InstallDir $fixture.rel
      $parent = Split-Path -Parent $abs
      if (-not (Test-Path -LiteralPath $parent)) { $null = New-Item -ItemType Directory -Path $parent -Force }
      $encoding = New-Object System.Text.UTF8Encoding($false)
      [System.IO.File]::WriteAllText($abs, $fixture.text, $encoding)
      $residue += [pscustomobject]@{ path = ($fixture.rel -replace '\\', '/'); abs = $abs; bytes = $fixture.text.Length; category = $fixture.category }
      Write-Host ("  + {0,-34} {1,6} B  {2}" -f $fixture.rel, $fixture.text.Length, $fixture.category)
    }
  } else {
    Write-Host '  （-SkipResidue：跳过残留布置）'
  }

  Write-Section '数据目录快照（供 Check 比对）'
  $stateDb = Get-FileFingerprint (Join-Path $DataDir 'state.db')
  $dataStat = Get-DirStat $DataDir
  $snapshot = [ordered]@{
    phase = 'setup'
    at = (Get-Date).ToString('o')
    machine = $env:COMPUTERNAME
    user = $env:USERNAME
    installDir = $InstallDir
    dataDir = $DataDir
    serviceName = $ServiceName
    residue = $residue
    data = [ordered]@{ exists = $dataStat.exists; fileCount = $dataStat.fileCount; bytes = $dataStat.bytes; stateDb = $stateDb }
    dirs = [ordered]@{
      store = (Test-Path -LiteralPath (Join-Path $DataDir 'store'))
      repos = (Test-Path -LiteralPath (Join-Path $DataDir 'repos'))
      logs = (Test-Path -LiteralPath (Join-Path $DataDir 'logs'))
      configJson = (Test-Path -LiteralPath (Join-Path $DataDir 'config.json'))
    }
  }
  Write-Utf8NoBom $snapshotPath ($snapshot | ConvertTo-Json -Depth 6)
  Write-Host "  数据目录：$($dataStat.fileCount) 个文件 / $($dataStat.bytes) 字节"
  if ($null -ne $stateDb) {
    Write-Host "  state.db：$($stateDb.bytes) 字节 / sha256 $($stateDb.sha256.Substring(0, 16))…"
  } else {
    Write-Host '  state.db：不存在（数据目录里还没有账户数据）' -ForegroundColor Yellow
  }
  Add-Check $true '快照已写入' $snapshotPath

  Write-Section '接下来（按顺序，别跳过截图）'
  Write-Host '  1) 去卸载（设置 → 应用，或控制面板）'
  Write-Host '  2) 卸载选项页出现时 ——【截图 A】，复选框**保持不勾**，点 Next'
  Write-Host '  3) 完成页【截图 B】，Finish'
  Write-Host '  4) 【截图 C1/C2】安装目录、数据目录各一张'
  Write-Host '  5) 回来跑：.\scripts\verify-t1025-uninstall.ps1 -Phase Check -Expect DataKept' -ForegroundColor Cyan
  Write-Host ''
  return 0
}

# ── Check ─────────────────────────────────────────────────────
function Invoke-Check() {
  Write-Host ''
  Write-Host "T10.25 卸载验证 —— 期望：$Expect" -ForegroundColor Cyan
  Write-Host "安装目录：$InstallDir"
  Write-Host "数据目录：$DataDir"
  Write-Host ''

  $snapshot = $null
  if (Test-Path -LiteralPath $snapshotPath) {
    try { $snapshot = Get-Content -LiteralPath $snapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $snapshot = $null }
  }

  # ── 1. 卸载是否真的发生 ────────────────────────────────────
  Write-Section '1. 卸载是否真的发生'
  $service = Get-ServiceState $ServiceName
  Add-Check (-not $service.installed) '服务已注销' $(if ($service.installed) { "仍在：状态 $($service.status)" } else { 'Get-Service 查不到' })

  $entry = @(Get-UninstallRegistryEntry)
  Add-Check ($entry.Count -eq 0) '「应用和功能」里已无此程序' $(if ($entry.Count -gt 0) { $entry[0].DisplayName } else { '注册表 Uninstall 键已清' })

  $listening = @(Get-ListeningPorts @(8730, 8731))
  Add-Check ($listening.Count -eq 0) '端口已释放' $(if ($listening.Count -gt 0) { '仍在监听：' + ($listening -join ', ') } else { '8730/8731 无 LISTENING' })

  # ── 2. 安装目录 ────────────────────────────────────────────
  Write-Section '2. 安装目录'
  $installExists = Test-Path -LiteralPath $InstallDir
  if (-not $installExists) {
    Add-Check $true '安装目录已删除' $InstallDir
    if ($snapshot -ne $null -and @($snapshot.residue).Count -gt 0) {
      Add-Check $false '白名单外文件本应保留' '安装目录整个没了 —— user-notes.txt 也一起消失了（不应发生）'
    }
  } else {
    $leftovers = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
    Add-Note ("安装目录仍在，剩余：{0}" -f ($(if ($leftovers.Count -eq 0) { '（空）' } else { $leftovers -join ', ' })))

    # 白名单内的残留**必须**已清 —— 这是 T10.23 的核心断言
    $whitelistNames = @('data', 'logs', 'cache', '.cache', 'tmp', 'temp')
    $leftWhitelist = @()
    foreach ($name in $leftovers) {
      if ($whitelistNames -contains $name.ToLower()) { $leftWhitelist += $name }
      elseif ($name -match '\.(log|tmp|temp)$') { $leftWhitelist += $name }
    }
    Add-Check ($leftWhitelist.Count -eq 0) '白名单内的运行期残留已清' $(if ($leftWhitelist.Count -gt 0) { '仍在：' + ($leftWhitelist -join ', ') } else { 'data/logs/cache/tmp/*.log 均不存在' })

    # 白名单外的用户文件**必须**还在
    if ($snapshot -ne $null) {
      foreach ($residueItem in @($snapshot.residue)) {
        if ($residueItem.category -like 'NOT whitelisted*') {
          $abs = Join-Path $InstallDir ($residueItem.path -replace '/', '\')
          Add-Check (Test-Path -LiteralPath $abs) "白名单外文件被保留：$($residueItem.path)"
        }
      }
    } else {
      Add-Skip '白名单外文件是否保留' '没有 setup-snapshot.json，不知道 Setup 放了哪些文件'
    }

    # 安装清单内的文件应当已被 Windows Installer 删掉
    $manifest = @('node.exe', 'tcs-service-host.exe', 'app')
    $stillThere = @()
    foreach ($name in $manifest) {
      if ($leftovers -contains $name) { $stillThere += $name }
    }
    Add-Check ($stillThere.Count -eq 0) '安装清单内文件已删' $(if ($stillThere.Count -gt 0) { '仍在：' + ($stillThere -join ', ') } else { 'node.exe / 宿主 / app 均已不在' })
  }

  # ── 3. 清理日志（F14.2 的证据） ─────────────────────────────
  Write-Section '3. 残留清理日志'
  $expectedLog = if ($Expect -eq 'DataRemoved') { $tempLogPath } else { $dataLogPath }
  $otherLog = if ($Expect -eq 'DataRemoved') { $dataLogPath } else { $tempLogPath }
  Add-Note ("期望落点：{0}" -f $expectedLog)

  $logExists = Test-Path -LiteralPath $expectedLog
  Add-Check $logExists "清理日志已写到期望位置" $(if (-not $logExists) { "找不到 $expectedLog" } else { '' })

  if ($logExists) {
    $block = Get-LastLogBlock $expectedLog
    if ($null -eq $block) {
      Add-Check $false '日志可解析' '文件里没有 "=== Tavern Card Studio uninstall cleanup" 起始行'
    } else {
      if ($block.count -gt 1) { Add-Note ("日志里有 {0} 块（重试过？）—— 只断言最后一块" -f $block.count) }

      if (-not $SkipResidue -and $snapshot -ne $null -and @($snapshot.residue).Count -gt 0) {
        foreach ($expected in @('DELETED data', 'DELETED logs', 'DELETED foreground.log')) {
          Add-Check ($block.text -match [regex]::Escape($expected)) "日志记录了 $expected"
        }
        Add-Check ($block.text -match 'KEPT\s+user-notes\.txt') '日志把 user-notes.txt 记为 KEPT'
        Add-Check ($block.text -notmatch 'DELETED\s+user-notes\.txt') '日志里没有 "DELETED user-notes.txt"'
      } else {
        Add-Skip '日志逐条内容' '这一轮没有布置残留（-SkipResidue 或没有快照）'
      }

      # 失败条目不作为判据（EBUSY 依环境而定），但要显式报出来
      $failedMatch = [regex]::Match($block.text, 'failed (\d+) item')
      if ($failedMatch.Success -and [int]$failedMatch.Groups[1].Value -gt 0) {
        Add-Note ("日志报告 {0} 个条目删除失败，原因见 reason 行（EBUSY 属正常：文件被占）" -f $failedMatch.Groups[1].Value)
      } else {
        Add-Note '日志报告 failed 0 item'
      }

      # %TEMP% 那份必须自己记着落点，否则"数据目录已删"无从证明
      if ($Expect -eq 'DataRemoved') {
        Add-Check ($block.text -match ('log file\s*:\s*' + [regex]::Escape($tempLogPath))) '日志自述的落点就是 %TEMP%（证明数据目录当时已不在）'
      }
    }
  }

  if (Test-Path -LiteralPath $otherLog) {
    Add-Note ("另一处也有日志：{0}（上一轮留下的，不影响本轮结论）" -f $otherLog)
  }

  # ── 4. 数据目录（按 Expect 分支） ───────────────────────────
  Write-Section ("4. 数据目录（期望：{0}）" -f $Expect)
  $dataExists = Test-Path -LiteralPath $DataDir

  if ($Expect -eq 'DataRemoved') {
    Add-Check (-not $dataExists) '数据目录已删除' $(if ($dataExists) { "仍然存在：$DataDir" } else { '' })
  } else {
    Add-Check $dataExists '数据目录被保留' $(if (-not $dataExists) { "不存在：$DataDir" } else { '' })
    if ($dataExists) {
      $dataStat = Get-DirStat $DataDir
      Add-Note ("当前：{0} 个文件 / {1} 字节" -f $dataStat.fileCount, $dataStat.bytes)
      $stateDbNow = Get-FileFingerprint (Join-Path $DataDir 'state.db')

      if ($null -eq $snapshot) {
        Add-Check ($null -ne $stateDbNow) 'state.db 仍在'
        Add-Skip '数据内容未被改动' '没有 setup-snapshot.json，无法比对'
      } else {
        $before = $snapshot.data.stateDb
        if ($null -eq $before) {
          Add-Skip 'state.db 哈希比对' 'Setup 时 state.db 还不存在'
        } else {
          Add-Check ($null -ne $stateDbNow) 'state.db 仍在'
          if ($null -ne $stateDbNow) {
            Add-Check ($stateDbNow.sha256 -eq $before.sha256) 'state.db 内容未被卸载改动' ("before " + $before.sha256.Substring(0, 12) + "… / after " + $stateDbNow.sha256.Substring(0, 12) + "…")
          }
        }
        Add-Check ($dataStat.fileCount -ge $snapshot.data.fileCount) '数据目录文件数没有变少' ("before " + $snapshot.data.fileCount + " / after " + $dataStat.fileCount)
        foreach ($dirName in @('store', 'repos')) {
          if ($snapshot.dirs.$dirName) {
            Add-Check (Test-Path -LiteralPath (Join-Path $DataDir $dirName)) "子目录仍在：$dirName"
          }
        }
        if ($snapshot.dirs.configJson) {
          Add-Check (Test-Path -LiteralPath (Join-Path $DataDir 'config.json')) 'config.json 仍在（令牌没丢）'
        }
      }
    }
  }

  # ── 5. 事件日志（辅助线索） ────────────────────────────────
  Write-Section '5. 应用程序事件日志（辅助）'
  try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'TavernCardStudio' } -MaxEvents 5 -ErrorAction Stop)
    if ($events.Count -gt 0) {
      Add-Note ("最近一条：{0}" -f ($events[0].Message -replace "`r?`n", ' '))
      Add-Check $true '事件日志有清理摘要'
    } else {
      Add-Skip '事件日志摘要' '没有来源 TavernCardStudio 的事件（eventcreate 可能在受限环境失败）'
    }
  } catch {
    Add-Skip '事件日志摘要' "读不到：$($_.Exception.Message.Split([char]10)[0])"
  }

  # ── 结论与证据落盘 ────────────────────────────────────────
  $total = $script:Checks.Count
  $passed = @($script:Checks | Where-Object { $_.ok -eq $true }).Count
  $failed = @($script:Checks | Where-Object { $_.ok -eq $false }).Count
  $skipped = @($script:Checks | Where-Object { $null -eq $_.ok }).Count

  Write-Section '结论'
  Write-Host ("  PASS {0} / FAIL {1} / SKIP {2}（共 {3} 项）" -f $passed, $failed, $skipped, $total)
  if ($failed -eq 0) {
    Write-Host "  [OK] 这一轮通过：$Expect" -ForegroundColor Green
  } else {
    Write-Host "  [X] 有 $failed 项不满足，逐条看上面对应的 [FAIL]" -ForegroundColor Red
    Write-Host '    报告里也记了，可以直接发回来。'
  }

  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $reportMd = Join-Path $EvidenceDir ("t1025-report-" + $Expect + "-" + $stamp + ".md")
  $reportJson = Join-Path $EvidenceDir ("t1025-report-" + $Expect + "-" + $stamp + ".json")

  $md = New-Object System.Text.StringBuilder
  $null = $md.AppendLine("# T10.25 卸载验证报告 —— $Expect")
  $null = $md.AppendLine('')
  $null = $md.AppendLine("- 时间：$((Get-Date).ToString('o'))")
  $null = $md.AppendLine("- 机器：$env:COMPUTERNAME / 用户：$env:USERNAME / 管理员：$(Test-IsAdmin)")
  $null = $md.AppendLine("- 安装目录：$InstallDir")
  $null = $md.AppendLine("- 数据目录：$DataDir")
  $null = $md.AppendLine("- 服务名：$ServiceName")
  $null = $md.AppendLine("- 期望：$Expect")
  $null = $md.AppendLine('')
  $null = $md.AppendLine("**PASS $passed / FAIL $failed / SKIP $skipped（共 $total）**")
  $null = $md.AppendLine('')
  $null = $md.AppendLine('| 结果 | 断言 | 说明 |')
  $null = $md.AppendLine('|---|---|---|')
  foreach ($item in $script:Checks) {
    $mark = if ($null -eq $item.ok) { 'SKIP' } elseif ($item.ok) { 'PASS' } else { 'FAIL' }
    $detail = ([string]$item.detail) -replace '\|', '\|'
    $null = $md.AppendLine("| $mark | $($item.label) | $detail |")
  }
  $null = $md.AppendLine('')
  $null = $md.AppendLine('## 截图清单（手工）')
  $null = $md.AppendLine('')
  $null = $md.AppendLine('- [ ] A 卸载选项页（复选框未勾选）')
  $null = $md.AppendLine('- [ ] B 卸载完成页（数据目录提示）')
  $null = $md.AppendLine('- [ ] C 卸载后安装目录 / 数据目录（两轮各 2 张）')
  $null = $md.AppendLine('- [ ] D 清理日志内容')
  $null = $md.AppendLine('')
  Write-Utf8NoBom $reportMd $md.ToString()

  $json = [ordered]@{
    at = (Get-Date).ToString('o')
    expect = $Expect
    installDir = $InstallDir
    dataDir = $DataDir
    serviceName = $ServiceName
    admin = (Test-IsAdmin)
    passed = $passed
    failed = $failed
    skipped = $skipped
    total = $total
    checks = @($script:Checks)
  }
  Write-Utf8NoBom $reportJson ($json | ConvertTo-Json -Depth 6)

  Write-Host ''
  Write-Host "报告：$reportMd"
  Write-Host "      $reportJson"
  Write-Host '把这两个文件 + 截图一起发回来即可。'
  Write-Host ''

  if ($failed -gt 0) { return 1 }
  return 0
}

# ── 入口 ──────────────────────────────────────────────────────
switch ($Phase) {
  'Guide' { Invoke-Guide; exit 0 }
  'Setup' { exit (Invoke-Setup) }
  'Check' { exit (Invoke-Check) }
}
