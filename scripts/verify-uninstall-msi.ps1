<#
.SYNOPSIS
  T10.25 卸载端到端验证（必须管理员）。

.DESCRIPTION
  为什么这个脚本必须由**人**以管理员身份运行，而不是由 AI 会话直接跑：

    · AI 会话的权限在进程启动时就定了，**无法自我提权**；
    · Windows 的 UAC 提权必须由人点"是"，任何脚本都无法代替；
    · 而 `msiexec /qn` 在非管理员会话下必定失败：
      `MSI_LUA: Elevation prompt disabled`（这正是 T10.25 一直挂账的原因）。

  所以分工是：**你负责提权运行，我负责判定。
  脚本把全过程写成日志，我读日志给结论 —— 证据可复核，不靠"跑完了"这句话。

.PARAMETER KeepBackup
  不删备份目录（默认保留，供事后核对）。

.EXAMPLE
  右键 run-as-admin.cmd → 以管理员身份运行
#>
[CmdletBinding()]
param(
  [switch]$KeepBackup
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ── 落点（与 installer/Product.wxs 对齐，不能自己另编一套）────────────
$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $RepoRoot 'installer'))) {
  $RepoRoot = 'D:\Claw\代码开发\tavern-card-studio'
}
$ServerMsi = Join-Path $RepoRoot 'release\TavernCardStudioServer-0.1.7.msi'
$ClientMsi = Join-Path $RepoRoot 'release\Tavern Card Studio_0.1.7_x64_en-US.msi'
$InstallDir = 'C:\Program Files\Tavern Card Studio Server'
$DataDir    = 'C:\ProgramData\TavernCardStudio'
$Stamp      = Get-Date -Format 'yyyyMMdd-HHmmss'
# 本次运行的起始时刻。用于判定"清理日志是不是这次写的" ——
# 没有它，%TEMP% 里几天前留下的日志会让这条断言永远绿。
$script:RunStart = Get-Date
$LogDir     = Join-Path $env:TEMP "tcs-t10.25-$Stamp"
$BackupDir  = Join-Path $LogDir 'backup-before'

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$MainLog = Join-Path $LogDir 'result.log'

# 结论收集：每一行是 "OK|FAIL <名称> :: <详情>"
$script:Checks = [System.Collections.Generic.List[string]]::new()

function log([string]$text) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text
  Write-Host $line
  Add-Content -Path $MainLog -Value $line -Encoding utf8
}

# 停不掉服务时**立刻退出**，不要带着运行中的服务往下跑。
#
# 为什么必须 fail-fast：服务在跑会持有 state.db 等文件句柄，于是
#   · 造数据写不进去（Write-FakeFile 返回 false）；
#   · 卸载可能因为文件占用而清理不彻底；
# 两者都会让**后续断言的结果不可信** —— 而"不可信的绿"比"明确的红"危险得多。
#
# 退出码 3 与"非管理员"的 2 区分开，便于外层脚本分流处理。
function Assert-ServiceStopped([string]$stage) {
  if (Stop-TcsService) {
    check "$stage 停服务" $true $ServiceName
    return
  }
  log "[FATAL] 停不掉服务 $ServiceName —— 后续断言都会不可信，中止。"
  log '  常见原因：服务处于 "Stopping" 卡住，或有子进程（node.exe）没退出。'
  log '  处置：手工 taskkill /f /im node.exe 后重跑，或重启机器。'
  log "  排查命令：Get-Service $ServiceName; Get-Process node -ErrorAction SilentlyContinue"
  log ''
  log "完整日志：$MainLog"
  exit 3
}

# ── 清理日志的解析（2026-10-30 第二次真机跑后重写）──────────────
#
# ## 第一次错在哪
#
# 我先写了"在 MSI verbose log 里搜 TavernCardStudio" → 恒为真（每行带产品名）。
# 改成读真正的清理日志后，我又用 `Select-Object -First 1` 取**第一处**匹配 ——
# 而那个日志是**追加**写的，文件头是几天前的旧记录。
# 于是断言虽然靠时间戳通过了，展示出来的证据却是 `install dir : D://tmp//t1025-lab2//install`
# —— 一个 2026-10-24 的调试路径。
#
# **"断言过了但证据是旧的" 仍然是绿而无用**：人看日志会以为本次跑到了那个路径。
#
# ## 正确做法
#
# 每次运行在文件里以 `=== Tavern Card Studio uninstall cleanup — <ISO 时间> ===`
# 开头、以 `=== done <ISO 时间> ===` 结尾。所以：
#   · 找**最后一个**这样的段落；
#   · 从**那一段里**取证据（DELETED / KEPT / summary）。
$CleanupLogPath = Join-Path $env:TEMP 'TavernCardStudio-uninstall-cleanup.log'

# 返回最后一次运行的段落（含头尾标记）；没有则返回 $null。
function Get-LatestCleanupSection([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  $lines = Get-Content -Path $path -Encoding UTF8
  $starts = @()
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if ($lines[$i] -match '^===\s*Tavern Card Studio uninstall cleanup') { $starts += $i }
  }
  if ($starts.Count -eq 0) { return $null }
  $from = $starts[$starts.Count - 1]
  return ($lines[$from..($lines.Count - 1)] -join "`n")
}

# 这一段是不是**本次运行**写的？
#
# 判据用段落头部里的 ISO 时间戳，而不是文件 mtime：
# mtime 只说明"文件被碰过"，说明不了"这一段是这次写的"。
# （第一次就是栽在只看 mtime 上：文件确实刚被写过，但内容是旧的。）
function Test-SectionIsFromThisRun([string]$section) {
  if ([string]::IsNullOrWhiteSpace($section)) { return $false }
  $firstLine = ($section -split "`n")[0]
  if ($firstLine -notmatch '(\d{4}-\d{2}-\d{2}T[\d:.]+Z)') { return $false }
  $stamp = [datetime]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
  # 容许 2 分钟时钟偏差（UTC 与本地时区换算、以及脚本准备时间）
  return ($stamp -ge $script:RunStart.ToUniversalTime().AddMinutes(-2))
}

function check([string]$name, [bool]$ok, [string]$detail) {
  $tag = if ($ok) { 'OK' } else { 'FAIL' }
  $script:Checks.Add("$tag`t$name`t$detail")
  log ("  {0} {1} — {2}" -f $tag, $name, $detail)
}

function step([string]$title) {
  log ''
  log "== $title =="
}

# ── 0. 先自检：不是管理员就立刻停下，别留下半装状态 ────────────────

# ════════════════════════════════════════════════════════════════
#  函数定义区 —— **必须在任何 step 调用之前**
# ════════════════════════════════════════════════════════════════
#
# 这一段位置不是随意的。2026-10-30 第二次真机跑崩在：
#
#   Stop-TcsService : 无法将"Stop-TcsService"项识别为 cmdlet、函数...
#
# 原因是当时函数定义在 0.5 段**之后**：这个 shell 按**执行顺序**创建函数，
# 不做预扫描提升。脚本跑到 0.5 要调 Stop-TcsService 时，它还没被定义。
#
# 教训：`Parser::ParseFile` 能查出语法错误，但**查不出这个** ——
# 语法完全合法。这类只能靠真跑发现，或靠"定义一律前置"这条纪律。
#
# 所以：本文件里所有 function 与全局变量定义，全部集中在这一段，
# 后面只允许调用。新增函数也放这里，不要就近塞到用它的地方。

# ── 服务控制 ────────────────────────────────────────────────
#
# **这个函数是 2026-10-30 第一次真机跑之后才加的。**
#
# 第一版没有它，路径 B 直接崩在这个错误上：
#
#   Set-Content : 文件"C://ProgramData//TavernCardStudio//store//state.db"
#   正由另一进程使用，因此该进程无法访问此文件。
#
# 根因：**MSI 装完会把服务端注册成服务并立即启动**（这是产品行为，不是 bug）。
# 服务进程一开就自己建了 store/state.db 并持着句柄。我随后去"造假数据"，
# 撞在它正在写的文件上。
#
# 所以顺序必须是：装 → **停服务** → 造数据 → 卸载。
# 少了"停服务"这一步，等于跟一个正在跑的服务端抢文件。
$ServiceName = 'TavernCardStudioServer'

function Stop-TcsService {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -eq $svc) { return $true }
  if ($svc.Status -eq 'Stopped') { return $true }

  log "  停服务 $ServiceName（当前 $($svc.Status)）"
  try {
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
  } catch {
    # Stop-Service 失败时退一步用 sc.exe（进程卡住时前者会拒绝）。
    #
    # 这个回退**自己也必须包 try/catch**：sc.exe 可能不在 PATH、
    # 或被安全策略拦住 —— 那种情况下不加保护就是一个未捕获异常，
    # 脚本会以一句与该场景毫不相关的报错死掉（而这正是本脚本前两次失败的形态）。
    # 捕获后让它安静失败，由下面的轮询 + 返回值表达结果。
    log "  Stop-Service 失败（$($_.Exception.Message)），改用 sc.exe stop"
    try {
      & sc.exe stop $ServiceName 2>&1 | Out-Null
    } catch {
      log "  sc.exe 也失败了：$($_.Exception.Message)"
    }
  }

  # 等服务真的退出 —— 只 Wait 状态位不够：服务报 Stopped 时文件句柄可能还没释放
  for ($i = 0; $i -lt 40; $i += 1) {
    Start-Sleep -Milliseconds 250
    $now = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $now -or $now.Status -eq 'Stopped') {
      # 再多给 500ms 让 handle 释放
      Start-Sleep -Milliseconds 500
      return $true
    }
  }
  return $false
}

function Install-ServerMsi {
  log "  msiexec /i（静默安装）"
  $p = Start-Process msiexec.exe -ArgumentList @(
    '/i', "`"$ServerMsi`"", '/qn', '/norestart', '/L*v', "`"$LogDir\install.log`""
  ) -Wait -PassThru
  return $p.ExitCode
}

function Uninstall-ServerMsi([switch]$DeleteData) {
  # 用产品码卸载比用 MSI 路径稳（路径变了仍能卸）
  $args = @('/x', "`"$ServerMsi`"", '/qn', '/norestart', '/L*v', "`"$LogDir\uninstall.log`"")
  if ($DeleteData) { $args += 'DELETEDATA=1' }
  log ("  msiexec /x {0}" -f $(if ($DeleteData) { 'DELETEDATA=1' } else { '（不勾删）' }))
  $p = Start-Process msiexec.exe -ArgumentList $args -Wait -PassThru
  return $p.ExitCode
}

function Write-FakeFile([string]$path, [string]$content) {
  # 写一个文件，遇占用重试。
  #
  # 光"停服务"还不够稳：Windows 释放文件句柄与"服务已报 Stopped"之间
  # 有时间差，第一版就是这样撞上的。这里做 6 次 x 500ms 的重试 ——
  # 比"再 sleep 5 秒"更快，也比"直接失败"更可靠。
  $last = $null
  for ($i = 0; $i -lt 6; $i += 1) {
    try {
      Set-Content -Path $path -Value $content -Encoding utf8 -ErrorAction Stop
      return $true
    } catch {
      $last = $_
      Start-Sleep -Milliseconds 500
    }
  }
  log "  [FATAL] 写不进 $path：$($last.Exception.Message)"
  return $false
}

function New-FakeData {
  # 造"用过的样子"：数据目录 + 几个有代表性的文件。
  #
  # 为什么不用"真跑服务端建账户"：卸载清理只关心**文件在不在**，
  # 而跑服务端会引入端口占用、进程残留、首次启动耗时等与本次验证无关的变量。
  # 但代价是必须自己处理"服务已经在跑"这件事 —— 见 Stop-TcsService 的注释。

  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $DataDir 'store') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $DataDir 'logs') -Force | Out-Null

  $ok = (Write-FakeFile (Join-Path $DataDir 'config.json') '{"auth":{"token":"probe"}}') -and
        (Write-FakeFile (Join-Path $DataDir 'store\state.db') 'fake-db') -and
        (Write-FakeFile (Join-Path $DataDir 'logs\server.log') 'fake-log')
  return $ok
}

# ── 2. 路径 A：卸载时**勾选**删数据 → 数据目录与安装目录都必须消失 ────

step '0. 管理员自检'
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  log '[FATAL] 当前不是管理员。'
  log ''
  log '  这个脚本必须提权运行。两种方式：'
  log '    ① 右键 scripts\run-as-admin.cmd → 以管理员身份运行'
  log '    ② 开始菜单搜 PowerShell → 右键 → 以管理员身份运行，然后：'
  log "       & '$PSCommandPath'"
  log ''
  log '  非管理员下 msiexec /qn 会失败（MSI_LUA: Elevation prompt disabled），'
  log '  这正是 T10.25 一直挂账的原因。'
  exit 2
}
log '  已在管理员会话中'
check '管理员权限' $true 'IsInRole(Administrator) = True'

foreach ($p in @($ServerMsi, $ClientMsi)) {
  if (-not (Test-Path $p)) { log "[FATAL] 找不到安装包：$p"; exit 1 }
}
log "  服务端 MSI：$ServerMsi"
log "  客户端 MSI：$ClientMsi"

# ── 1. 备份现有数据（保险：这个脚本会删 ProgramData 下的目录）────────
#
# 用户机器上可能已经有真实数据（账户、卡片、版本链）。
# 虽然"勾删"路径本来就该删掉它，但**验证脚本不应该拿真实数据冒险** ——
# 所以先整份拷出来，跑完告诉用户备份在哪。
step '0.5 清理上次运行留下的半成品'
#
# 这一段是 2026-10-30 第一次真机跑**失败之后**加的。
#
# 那次路径 B 崩在 state.db 被占用，脚本中断 —— 于是机器上留下：
#   · 已安装的服务端服务（可能在跑）
#   · 安装目录 Program Files\Tavern Card Studio Server
#   · 数据目录里一堆"假数据"
# 而用户重跑脚本时，一开场就处在"服务在跑 + 目录被占"的状态，
# 会以**同样的方式**再失败一次。
#
# 所以必须自愈：检测到上次的遗留就先收掉，让每次运行都从干净的起点开始。
$installed = (Test-Path $InstallDir) -or ($null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue))
if ($installed) {
  log '  检测到上次留下的安装（服务或安装目录还在），先清理'
  # 预清理阶段也 fail-fast：停不掉就说明环境没准备好，后面全是白跑
  Assert-ServiceStopped '预清理'

  # 卸载时**不带** DELETEDATA —— 这一步在第 1 步备份之前，
  # 万一用户真实数据还活着，不能被这里连带删掉。
  & msiexec.exe /x "`"$ServerMsi`"" /qn /norestart | Out-Null
  Start-Sleep -Seconds 3
  if (Test-Path $InstallDir) {
    log '  msiexec /x 没清掉安装目录，手工收'
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  check '预清理：安装目录已清' (-not (Test-Path $InstallDir)) $InstallDir
} else {
  log '  没有上次遗留'
  check '预清理：无遗留' $true '服务与安装目录都不存在'
}

step '0.6 识别并还原上次留下的假数据'
#
# ## 为什么必须有这一步（第一版没有，会**吃掉用户的真实数据**）
#
# 上一次运行在路径 B 崩了，机器上的现状是：
#   · 数据目录里是脚本自己造的假数据（config.json 内容固定为 {"auth":{"token":"probe"}}）
#   · 用户的真实数据躺在更早的 `%TEMP%\tcs-t10.25-*\backup-before\` 里
#
# 如果直接往下走，第 1 步会把**假数据**备份成"现有数据"，
# 收尾时再用假数据覆盖回去 —— 用户的 54 个真实文件就从数据目录里消失了
# （虽然旧的 temp 里还有，但他不知道，也不会去翻）。
#
# ## 判据
#
# 用"config.json 内容**精确等于**我们造的假值"来判定，不猜：
# 那个字符串是本脚本独有的，用户数据不可能碰巧一样。
# 不满足就当真实数据处理（保守：宁可多备份一次，也不误还原）。
$fakeConfigContent = '{"auth":{"token":"probe"}}'
$currentConfig = Join-Path $DataDir 'config.json'
$looksFake = $false
if (Test-Path $currentConfig) {
  # 必须显式剔 BOM：`Set-Content -Encoding utf8` 在 PS 5.1 下会写 BOM，
  # 而 U+FEFF **不是**空白字符 —— Trim() 去不掉它，
  # 于是精确比较会失败、假数据识别不出来（这一步就白写了）。
  $raw = (Get-Content $currentConfig -Raw -ErrorAction SilentlyContinue)
  if ($null -ne $raw) {
    $looksFake = (($raw -replace "`u{FEFF}", '').Trim() -eq $fakeConfigContent)
  }
}

if ($looksFake) {
  # 在历史备份里找最新的那份（按目录名倒序，名字里带时间戳）
  $olderBackups = Get-ChildItem -Path $env:TEMP -Directory -Filter 'tcs-t10.25-*' -ErrorAction SilentlyContinue |
                  Sort-Object Name -Descending |
                  Where-Object { Test-Path (Join-Path $_.FullName 'backup-before\TavernCardStudio') }
  $restoreFrom = if ($olderBackups) { Join-Path $olderBackups[0].FullName 'backup-before\TavernCardStudio' } else { $null }

  if ($restoreFrom) {
    log "  数据目录里是上次留下的假数据，从历史备份还原：$restoreFrom"
    Remove-Item -Path $DataDir -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path $restoreFrom -Destination $DataDir -Recurse -Force
    # 这里**故意不写 $BackupDir**：第 1 步会写同一目标，
    # 而 Destination 指向已存在的目录时，源会被放进它里面，
    # 于是变成 backup-before\TavernCardStudio\TavernCardStudio（嵌套陷阱）。
    # 还原到数据目录就够了，第 1 步照常备份这份还原后的数据。
    $n = (Get-ChildItem -Path $DataDir -Recurse -File | Measure-Object).Count
    check '还原上次的真实数据' $true "$n 个文件（来源 $([System.IO.Path]::GetFileName((Split-Path $restoreFrom -Parent)))）"
  } else {
    check '还原上次的真实数据' $false '数据目录是假数据，但找不到历史备份（用户数据可能已在原始目录丢失）'
  }
} else {
  log '  数据目录不是假数据（或不存在），按真实数据处理'
  check '无需还原' $true '未检测到上次的假数据残留'
}

step '1. 备份现有数据'
if (Test-Path $DataDir) {
  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  Copy-Item -Path $DataDir -Destination (Join-Path $BackupDir 'TavernCardStudio') -Recurse -Force
  $n = (Get-ChildItem -Path $BackupDir -Recurse -File | Measure-Object).Count
  log "  已备份到 $BackupDir（$n 个文件）"
  check '备份现有数据' $true "$n 个文件 → $BackupDir"
} else {
  log '  当前没有数据目录，无需备份'
  check '备份现有数据' $true '无数据目录（首次验证的正常状态）'
}

step '2. 路径 A：勾选「删除数据」'
$rc = Install-ServerMsi
check 'A 安装成功' ($rc -eq 0) "exit=$rc"

# 装完**立刻停服务**：MSI 会把服务端注册成服务并启动，它持有 state.db。
# 不停就造数据 = 跟运行中的服务抢文件（第一版就是在这崩的）。
Assert-ServiceStopped 'A'

check 'A 数据已就绪' (New-FakeData) $DataDir

$rc = Uninstall-ServerMsi -DeleteData
check 'A 卸载返回 0' ($rc -eq 0) "exit=$rc"

# 给 MSI 的自定义动作一点时间（它是异步 spawn 的）
Start-Sleep -Seconds 3
check 'A 数据目录已删除' (-not (Test-Path $DataDir)) $DataDir
check 'A 安装目录已清空' (-not (Test-Path $InstallDir)) $InstallDir

# ── 清理日志的判据（2026-10-30 第一次真机跑后**重写**）──
#
# 第一版是这样写的：
#
#   Select-String -Path uninstall.log -Pattern '数据目录|DATAFOLDER|TavernCardStudio'
#
# 它**恒为真**：MSI verbose log 每一行都带产品名 `TavernCardStudioServer`，
# 所以永远能命中。实测那次打出了 `******* Product: ...TavernCardStudioServer-`
# —— 那不是清理记录，是 WiX 的头部行。**绿而无用**。
#
# 真正的清理日志是 `tcs-server cleanup --event-log` 写的，落点规则
# （见 `server/src/uninstall-cleanup.ts:227`）：
#   · dataDir 还在 → `<dataDir>\logs\uninstall-cleanup.log`
#   · dataDir 已被删 → `%TEMP%\TavernCardStudio-uninstall-cleanup.log`
#
# 路径 A 勾了删数据，所以该看 %TEMP% 那份。而**必须校验时间戳**：
# 那个文件可能是几天前跑测试留下的，不校验时间就会拿旧记录当本次结果。
# 路径 A 的判据（2026-10-30 第二次真机跑后**重写**）
#
# ## 为什么这里改成"预期没有新段落"
#
# 勾了删数据时，自定义动作的顺序是：
#   1. DeleteDataDir 先 rmdir 整个 ProgramData\TavernCardStudio
#   2. CleanInstallResidue 要跑 `[INSTALLFOLDER]node.exe ... cleanup`
#        —— 而卸载时安装目录已被 RemoveFiles 删掉，node.exe 不在
# 所以路径 A **本来就产生不了清理日志**。
#
# 我原先那条"清理日志已产出"在 A 这里是**概念错的**：它要么恒真
# （取到旧记录，实测就是这样：展示出 10-24 的 `D://tmp//t1025-lab2//install`），
# 要么恒假。两种都没有信息量。
#
# 改成负向判据：**本次运行不应在清理日志里留下新段落**。
# 这条有真信息量 —— 如果它失败了，说明"删数据"路径里 node.exe 竟然还在，
# 那意味着 RemoveFiles 没按预期删干净，是另一个真问题。
$sectionA = Get-LatestCleanupSection $CleanupLogPath
$sectionAIsFresh = Test-SectionIsFromThisRun $sectionA
check 'A 未产生清理日志（符合预期）' (-not $sectionAIsFresh) $(if ($sectionAIsFresh) {
  '出现了本次的新段落 —— 说明安装目录没被整体删掉，RemoveFiles 可能没按预期工作'
} else {
  '安装目录已被整体删除，cleanup 动作无 node.exe 可跑（已知且正确）'
})

step '3. 路径 B：不勾选「删除数据」'
$rc = Install-ServerMsi
check 'B 安装成功' ($rc -eq 0) "exit=$rc"
Assert-ServiceStopped 'B'

check 'B 数据已就绪' (New-FakeData) $DataDir
$configBefore = Get-Content (Join-Path $DataDir 'config.json') -Raw

$rc = Uninstall-ServerMsi
check 'B 卸载返回 0' ($rc -eq 0) "exit=$rc"
Start-Sleep -Seconds 3

$stillThere = Test-Path (Join-Path $DataDir 'config.json')
check 'B 数据目录仍在' $stillThere $DataDir
if ($stillThere) {
  $configAfter = Get-Content (Join-Path $DataDir 'config.json') -Raw
  check 'B 数据内容未变' ($configBefore -eq $configAfter) 'config.json 逐字节一致'
}
check 'B 安装目录已清空' (-not (Test-Path $InstallDir)) $InstallDir

# ── 4. 路径 C：残留场景 → 白名单外的文件不得被删 ────────────────────
step '4. 路径 C：安装目录里的残留（白名单外不许删）'
$rc = Install-ServerMsi
check 'C 安装成功' ($rc -eq 0) "exit=$rc"
# 路径 C 要在**安装目录**里造文件，服务在跑会锁住 node.exe 等文件
Assert-ServiceStopped 'C'

# 在**安装目录**里造三类：data\、logs\（应清）与 user-notes.txt（应留）
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'data') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $InstallDir 'logs') -Force | Out-Null
Set-Content -Path (Join-Path $InstallDir 'data\stray.txt') -Value 'stray' -Encoding utf8
Set-Content -Path (Join-Path $InstallDir 'logs\stray.log') -Value 'stray' -Encoding utf8
Set-Content -Path (Join-Path $InstallDir 'user-notes.txt') -Value 'KEEP ME' -Encoding utf8
log '  已造：data\ + logs\（应清）与 user-notes.txt（应留）'

$rc = Uninstall-ServerMsi
check 'C 卸载返回 0' ($rc -eq 0) "exit=$rc"
Start-Sleep -Seconds 3

# 安装目录整体会被 MSI 删掉的话，user-notes.txt 也随之消失 —— 那是**正确**行为
# （安装目录归 MSI 管）。所以要区分"目录整个被删"与"目录还在但白名单外文件被误删"。
if (-not (Test-Path $InstallDir)) {
  check 'C 安装目录被整体删除' $true '目录不存在（MSI 正常行为，白名单规则无从触发）'
} else {
  check 'C 安装目录仍存在' $true '目录保留（触发了白名单清理）'
  check 'C 白名单外文件被保留' (Test-Path (Join-Path $InstallDir 'user-notes.txt')) 'user-notes.txt'
  check 'C data 子目录被清' (-not (Test-Path (Join-Path $InstallDir 'data'))) 'data\'
  check 'C logs 子目录被清' (-not (Test-Path (Join-Path $InstallDir 'logs'))) 'logs\'
}

# ── 路径 C 的**第三方证据**：清理程序自己写下的记录 ──────────────
#
# 上面那三条是靠脚本自己 `Test-Path` 推出来的结论。这一段补的是
# **另一个信息源**：`tcs-server cleanup` 在卸载时把自己的判断写进了日志，
# 里面明确列出"删了什么、留了什么、有没有失败"。
#
# 为什么这条值得加：文件系统断言只能证明"最终状态对"，证明不了
# "清理逻辑走了白名单" —— 万一是 MSI 把整个目录删了、恰好也没留下 data\？
# 那三条断言照样会绿，但白名单规则其实没被执行。日志能分辨这两种情况。
#
# 这也是唯一能验证"白名单外文件被保留"这个**规则本身**的证据。
$sectionC = Get-LatestCleanupSection $CleanupLogPath
$sectionCIsFresh = Test-SectionIsFromThisRun $sectionC

if (-not $sectionCIsFresh) {
  # 路径 C 不勾删数据，安装目录保留 → cleanup 动作**应该**跑得起来。
  # 没跑起来说明动作注册有问题（`installer/Product.wxs` 的 CustomAction 表），
  # 这是**真问题**，不能记成"已知原因"。
  check 'C 清理日志有本次记录' $false '本次没有新段落 —— cleanup 动作可能没被调用（检查 CustomAction 表）'
} else {
  check 'C 清理日志有本次记录' $true ($sectionC -split "`n")[0].Trim()

  # ① 白名单内的两类被删（正是路径 C 造的那两个）
  $deletedData = ($sectionC -match 'DELETED\s+data\s')
  $deletedLogs = ($sectionC -match 'DELETED\s+logs\s')
  check 'C 日志：data 被删' $deletedData '日志里应有 "DELETED data"'
  check 'C 日志：logs 被删' $deletedLogs '日志里应有 "DELETED logs"'

  # ② 白名单外的被保留（user-notes.txt 是路径 C 造的那个"应留"样本）
  $keptNotes = ($sectionC -match 'KEPT\s+user-notes\.txt')
  check 'C 日志：user-notes.txt 被保留' $keptNotes '日志里应有 "KEPT user-notes.txt"'

  # ③ 没有任何条目处理失败
  $noFailure = ($sectionC -match 'failed 0 item')
  check 'C 日志：failed 0' $noFailure 'summary 行应含 "failed 0 item"'

  # 把摘要行原样打出来 —— 这是给人看的最终凭据
  $summaryLine = (($sectionC -split "`n") | Where-Object { $_ -match '^summary:' } | Select-Object -First 1)
  if ($summaryLine) { log "  清理摘要：$($summaryLine.Trim())" }
}

# ── 5. 收尾：把环境恢复原样 ────────────────────────────────────────
step '5. 收尾'
if (Test-Path $BackupDir) {
  # 路径 B 会留下假数据；用备份覆盖回去，别把"假 config.json"留在用户机器上
  if (Test-Path $DataDir) { Remove-Item -Path $DataDir -Recurse -Force }
  Copy-Item -Path (Join-Path $BackupDir 'TavernCardStudio') -Destination $DataDir -Recurse -Force
  check '环境已恢复' $true "数据目录已用备份还原"
  if (-not $KeepBackup) {
    log "  备份保留在 $BackupDir（可用 -KeepBackup 明确要求保留；不删是为了你事后能核对）"
  }
} else {
  # 本来就无数据：把验证过程中造出来的清干净
  if (Test-Path $DataDir) { Remove-Item -Path $DataDir -Recurse -Force }
  check '环境已恢复' $true '原本无数据，已清理验证残留'
}

# ── 6. 结论 ────────────────────────────────────────────────────────
step '6. 结论'
$results = $script:Checks | ForEach-Object {
  $parts = $_ -split "`t"
  [pscustomobject]@{ Result = $parts[0]; Name = $parts[1]; Detail = $parts[2] }
}

$failed = @($results | Where-Object { $_.Result -eq 'FAIL' })
$results | Format-Table -AutoSize | Out-String -Width 200 | Write-Host

log ''
if ($failed.Count -eq 0) {
  log "[OK] 全部通过（$($results.Count) 项）"
  $verdict = 'PASS'
} else {
  log "[FAIL] $($failed.Count) 项失败（共 $($results.Count) 项）"
  foreach ($f in $failed) { log "   - $($f.Name)：$($f.Detail)" }
  $verdict = 'FAIL'
}

# 机器可读的结论行 —— 让 AI/CI 直接 grep，不用解析上面那一大坨
Add-Content -Path $MainLog -Value "VERDICT=$verdict PASSED=$($results.Count - $failed.Count) TOTAL=$($results.Count)" -Encoding utf8

log ''
log "完整日志：$MainLog"
log "（把这一行路径发给我，我读日志给结论；截图请另存在 $LogDir）"

exit $(if ($verdict -eq 'PASS') { 0 } else { 1 })
