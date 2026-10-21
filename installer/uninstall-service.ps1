# Remove the Tavern Card Studio Windows service.
# Requires an elevated PowerShell session.
#   .\uninstall-service.ps1
#   .\uninstall-service.ps1 -RemoveData     # also delete C:\ProgramData\TavernCardStudio (IRREVERSIBLE)
#   .\uninstall-service.ps1 -WhatIf

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ServiceName = 'TavernCardStudioServer',
  [string]$DataDir = (Join-Path $env:ProgramData 'TavernCardStudio'),
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required. Start PowerShell with "Run as administrator".'
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) {
  Write-Host "Service '$ServiceName' is not installed."
} else {
  if ($service.Status -ne 'Stopped') {
    if ($PSCmdlet.ShouldProcess($ServiceName, 'Stop service')) {
      # 不能只靠 Stop-Service：若服务是旧格式（binPath 直指 node.exe，或本身已卡在
      # StartPending），SCM 的 Stop 永远得不到确认，WaitForStatus 会抛超时异常，
      # 后面的删除就走不到了。所以停不下来就强制结束进程树，再删服务。
      $stopped = $false
      try {
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        $service.WaitForStatus('Stopped', '00:00:20')
        $stopped = $true
      } catch {
        Write-Host "Stop-Service failed or timed out: $($_.Exception.Message)"
      }

      if (-not $stopped) {
        Write-Host 'Forcing the service processes down (LocalSystem session-0 children)...'
        $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
        if ($svc -and $svc.ProcessId -gt 0) {
          # 只结束该服务的进程树，不用 -Name 匹配，避免误杀本机其他 node.exe
          foreach ($proc in (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" -ErrorAction SilentlyContinue)) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
          }
          Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        # session 0 里由该服务拉起的 node 子进程
        foreach ($node in (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq 0 })) {
          if ($node.CommandLine -and $node.CommandLine -match 'TavernCardStudio|app\\server\\dist') {
            Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Host "  killed node pid=$($node.ProcessId)"
          }
        }
        Start-Sleep -Seconds 3
      }
    }
  }
  if ($PSCmdlet.ShouldProcess($ServiceName, 'Delete service')) {
    # sc.exe 可能在受限环境被策略禁用；回退到 CIM（等价于 sc delete）
    & sc.exe delete $ServiceName 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $svcToDelete = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
      if ($svcToDelete) { $svcToDelete | Remove-CimInstance -ErrorAction SilentlyContinue }
    }
    $still = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($still) { Write-Host "WARNING: service '$ServiceName' still present. Reboot and re-run." }
    else { Write-Host "Service '$ServiceName' deleted." }
  }
}

if ($RemoveData) {
  if ($PSCmdlet.ShouldProcess($DataDir, 'Delete data directory')) {
    if (Test-Path -LiteralPath $DataDir) {
      Remove-Item -LiteralPath $DataDir -Recurse -Force
      Write-Host "Data directory removed: $DataDir"
    }
  }
} else {
  Write-Host "Data kept at: $DataDir (pass -RemoveData to delete)"
}
