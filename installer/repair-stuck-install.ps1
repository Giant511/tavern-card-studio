# Repair a server MSI install that hung at "Please wait while Windows configures ...".
#
# Symptom: the progress bar stops around 70% and never finishes. In Task Manager
# the server is NOT crashed - node.exe is alive and 8730/8731 are listening - but
#
#     Get-Service TavernCardStudioServer   ->   Status : StartPending
#
# Cause: the older package registered node.exe itself as the service binary.
# node.exe never calls StartServiceCtrlDispatcher, so the SCM waits forever for
# SERVICE_RUNNING and msiexec's ServiceControl/@Wait="yes" waits forever for the
# SCM. (Fixed in 0.1.0 by putting WinSW in front - see installer\ServiceHost.xml.)
#
# What this script does, in one elevated session:
#   1. kill the orphaned LocalSystem node processes  (frees 8730/8731)
#   2. kill the stuck msiexec
#   3. delete the orphaned service                (sc.exe may be blocked; uses CIM)
#   4. remove the leftover install folder         (data dir in ProgramData is KEPT)
#   5. install the rebuilt MSI
#   6. wait for Running, then verify ports and dump the service log
#
# Usage (elevated PowerShell):
#   .\installer\repair-stuck-install.ps1
#   .\installer\repair-stuck-install.ps1 -Msi 'D:\path\to\setup.msi'
#   .\installer\repair-stuck-install.ps1 -WhatIf      # print actions only

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Msi = '',
  [string]$ServiceName = 'TavernCardStudioServer',
  [string]$InstallDir = 'C:\Program Files\Tavern Card Studio Server',
  [string]$DataDir = 'C:\ProgramData\TavernCardStudio'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required. Start PowerShell with "Run as administrator".'
}

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrEmpty($Msi)) {
  $Msi = Join-Path (Split-Path -Parent $scriptDir) 'release\TavernCardStudioServer-0.1.1.msi'
}
if (-not (Test-Path -LiteralPath $Msi)) { throw "MSI not found: $Msi" }

Write-Host "MSI: $Msi"

# 装之前先确认包里的服务配置是良构 XML。
# 这一层 WinSW 自己也会检查，但它的报错在服务模式下不可见，只留事件 7009 + 回滚 1920，
# 排查成本极高（2026-10-21 因此失败两次）。在这里提前判掉，几毫秒换掉一次装不上的来回。
Add-Type -AssemblyName System.Xml -ErrorAction SilentlyContinue
$probeDir = Join-Path $env:TEMP ("tcs-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
try {
  $admin = Start-Process -FilePath 'msiexec.exe' `
    -ArgumentList @('/a', "`"$Msi`"", '/qn', "TARGETDIR=`"$probeDir`"") -Wait -PassThru
  if ($admin.ExitCode -eq 0) {
    $probeXml = Get-ChildItem -LiteralPath $probeDir -Recurse -Filter 'tcs-service-host.xml' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($probeXml) {
      try {
        $null = [xml](Get-Content -LiteralPath $probeXml.FullName -Raw -Encoding UTF8)
        Write-Host "Package service config: well-formed XML"
      } catch {
        throw "包内服务配置不是良构 XML，装上也起不来，先修构建：$($probeXml.FullName)`n  $($_.Exception.Message)"
      }
    } else {
      Write-Host 'WARNING: 包内找不到 tcs-service-host.xml，服务可能无法启动。' -ForegroundColor Yellow
    }
    $probeExe = Get-ChildItem -LiteralPath $probeDir -Recurse -Filter 'tcs-service-host.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $probeExe) {
      Write-Host 'WARNING: 包内找不到 tcs-service-host.exe。' -ForegroundColor Yellow
    }
  } else {
    Write-Host "WARNING: 解包自检失败（exit=$($admin.ExitCode)），跳过包内检查。" -ForegroundColor Yellow
  }
} finally {
  Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''

# ── 1. orphaned service processes ────────────────────────────────────────────
Write-Host '[1/6] Stopping orphaned service processes (LocalSystem, session 0)'
$nodes = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.SessionId -eq 0 }
if ($nodes) {
  foreach ($n in $nodes) {
    if ($PSCmdlet.ShouldProcess("pid $($n.ProcessId)", 'Stop-Process')) {
      try { Stop-Process -Id $n.ProcessId -Force -ErrorAction Stop; Write-Host "  killed node pid=$($n.ProcessId)" }
      catch { Write-Host "  failed pid=$($n.ProcessId): $($_.Exception.Message)" }
    }
  }
  Start-Sleep -Seconds 3
} else {
  Write-Host '  none'
}

# ── 2. stuck msiexec ─────────────────────────────────────────────────────────
Write-Host '[2/6] Stopping the stuck msiexec'
$msis = Get-CimInstance Win32_Process -Filter "Name='msiexec.exe'" | Where-Object { $_.SessionId -eq 0 }
if ($msis) {
  foreach ($m in $msis) {
    if ($PSCmdlet.ShouldProcess("pid $($m.ProcessId)", 'Stop-Process')) {
      try { Stop-Process -Id $m.ProcessId -Force -ErrorAction Stop; Write-Host "  killed msiexec pid=$($m.ProcessId)" }
      catch { Write-Host "  failed pid=$($m.ProcessId): $($_.Exception.Message)" }
    }
  }
  Start-Sleep -Seconds 4
} else {
  Write-Host '  none'
}

# ── 3. orphaned service ──────────────────────────────────────────────────────
Write-Host "[3/6] Removing service '$ServiceName' if present"
$svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "  found: State=$($svc.State)"
  if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop + delete service')) {
    try {
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      $svc | Remove-CimInstance -ErrorAction Stop
      Write-Host '  removed'
    } catch {
      Write-Host "  remove failed: $($_.Exception.Message)"
      Write-Host '  If it still refuses, reboot and re-run this script.'
    }
  }
} else {
  Write-Host '  not present'
}

# ── 4. leftover install folder (data is kept) ────────────────────────────────
Write-Host "[4/6] Removing leftover install folder (data dir is kept)"
if (Test-Path -LiteralPath $InstallDir) {
  if ($PSCmdlet.ShouldProcess($InstallDir, 'Remove-Item -Recurse')) {
    try { Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop; Write-Host '  removed' }
    catch { Write-Host "  remove failed: $($_.Exception.Message)"; Write-Host '  Something still holds a file open. Reboot and retry.' }
  }
} else {
  Write-Host '  not present'
}

# ── 5. install ───────────────────────────────────────────────────────────────
Write-Host '[5/6] Installing'
$installLog = Join-Path $env:TEMP 'tcs-server-install.log'
if ($PSCmdlet.ShouldProcess($Msi, 'msiexec /i')) {
  $p = Start-Process -FilePath 'msiexec.exe' `
    -ArgumentList @('/i', "`"$Msi`"", '/qn', '/norestart', '/l*v', "`"$installLog`"") `
    -Wait -PassThru
  Write-Host "  msiexec exit=$($p.ExitCode)  (log: $installLog)"
  if ($p.ExitCode -ne 0) {
    throw "Install failed with exit code $($p.ExitCode). See $installLog (search for 'Return value 3')."
  }
}

# ── 6. verify ────────────────────────────────────────────────────────────────
Write-Host '[6/6] Verifying'
$deadline = (Get-Date).AddSeconds(60)
$state = 'missing'
while ((Get-Date) -lt $deadline) {
  $s = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($s) {
    $state = [string]$s.Status
    if ($s.Status -eq 'Running') { break }
  }
  Start-Sleep -Seconds 2
}
Write-Host "  service state: $state"

$svc2 = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
if ($svc2) {
  Write-Host "  binary: $($svc2.PathName)"
  Write-Host "  exitcode=$($svc2.ExitCode) pid=$($svc2.ProcessId)"
}

foreach ($port in 8730, 8731) {
  $hit = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { Write-Host "  port $port LISTENING pid=$($hit.OwningProcess)" }
  else { Write-Host "  port $port NOT listening" }
}

$hostExe = Join-Path $InstallDir 'tcs-service-host.exe'
if (Test-Path -LiteralPath $hostExe) {
  Write-Host "  host: $hostExe"
  Write-Host "  sha256=$((Get-FileHash -LiteralPath $hostExe -Algorithm SHA256).Hash.ToLower())"
} else {
  Write-Host '  ERROR: tcs-service-host.exe missing - the package did not include the host.'
}

$logDir = Join-Path $DataDir 'logs'
$logDirExists = Test-Path -LiteralPath $logDir
if ($logDirExists) {
  Get-ChildItem -LiteralPath $logDir -File | Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 | ForEach-Object {
      Write-Host ''
      Write-Host "--- $($_.Name) (tail) ---"
      Get-Content -LiteralPath $_.FullName -Tail 15 | ForEach-Object { Write-Host "  $_" }
    }
}

Write-Host ''
if ($state -eq 'Running') {
  Write-Host 'OK: service is Running.'
  Write-Host 'Admin panel: http://127.0.0.1:8731/'
  Write-Host "Access token (first run only): see $logDir"
} else {
  Write-Host "Service did not reach Running (state=$state)."
  if (-not $logDirExists) {
    # 这条判据能把两类完全不同的故障分开，省掉大量瞎猜：
    #   日志目录没生成 = WinSW 在加载配置阶段就退了（XML 不合法、找不到配置）
    #   日志目录有 = 配置没问题，是 node 子进程起不来（端口占用、数据目录权限）
    Write-Host ''
    Write-Host 'DIAGNOSIS: WinSW never initialised its log, so it failed while LOADING the config.' -ForegroundColor Yellow
    Write-Host '  -> The packaged tcs-service-host.xml is probably not well-formed XML.'
    Write-Host '  -> Run this to see the real error on a console (a service has none):'
    Write-Host "       msiexec /a `"$Msi`" /qn TARGETDIR=`"$env:TEMP\tcs-verify`""
    Write-Host "       & `"$env:TEMP\tcs-verify\PFiles64\Tavern Card Studio Server\tcs-service-host.exe`""
  } else {
    Write-Host 'DIAGNOSIS: WinSW loaded the config, so the failure is in the node child process.' -ForegroundColor Yellow
    Write-Host "  -> Read $(Join-Path $logDir 'tcs-service-host.err.log')"
  }
  Write-Host ''
  Write-Host "MSI log: $installLog (search for 'Return value 3')"
}
