# Windows service registration (no MSI required)
#
# Requires an elevated PowerShell session.
#   .\install-service.ps1
#   .\install-service.ps1 -DataDir 'D:\TcsData' -StartupType demand
#   .\install-service.ps1 -WhatIf          # show actions without changing anything
#
# The service runs the bundled node.exe with:
#   app\server\dist\index.js serve --config <DataDir>\config.json --rules-dir app\rules
# The supervisor process stays alive and manages the API worker, so the SCM sees one stable process.

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  # 留空则在正文里解析（param 默认值阶段 $PSScriptRoot 可能为空，见下方说明）
  [string]$InstallDir = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'TavernCardStudio'),
  [string]$ServiceName = 'TavernCardStudioServer',
  [string]$DisplayName = 'Tavern Card Studio Server',
  [ValidateSet('auto', 'demand', 'disabled')]
  [string]$StartupType = 'auto'
)

$ErrorActionPreference = 'Stop'

# 不要在 param() 默认值里用 $PSScriptRoot：用 `powershell -File installer\install-service.ps1`
# 调用时它在参数绑定阶段可能是空串（PS 5.1 实测），Split-Path -Parent '' 会直接抛错。
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrEmpty($InstallDir)) {
  $InstallDir = Split-Path -Parent $scriptDir
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator privileges are required. Start PowerShell with "Run as administrator".'
  }
}

Assert-Administrator

$node = Join-Path $InstallDir 'node.exe'
$entry = Join-Path $InstallDir 'app\server\dist\index.js'
$rules = Join-Path $InstallDir 'app\rules'
$config = Join-Path $DataDir 'config.json'
$store = Join-Path $DataDir 'store'

foreach ($path in @($node, $entry, $rules)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing file: $path. Run 'npm run pack:server' and copy release\server to the install directory first."
  }
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  throw "Service '$ServiceName' already exists. Run .\uninstall-service.ps1 first, or pass -ServiceName with another name."
}

if (-not (Test-Path -LiteralPath $DataDir)) {
  if ($PSCmdlet.ShouldProcess($DataDir, 'Create data directory')) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  }
}

if (-not (Test-Path -LiteralPath $config)) {
  Write-Host 'Creating config and access token (printed once)...'
  if ($PSCmdlet.ShouldProcess($config, 'Create config.json')) {
    & $node $entry config show --config $config --data-dir $store --rules-dir $rules
  }
}

$binaryPath = '"{0}" "{1}" serve --config "{2}" --rules-dir "{3}"' -f $node, $entry, $config, $rules

# ---------------------------------------------------------------------------
# Refuse to register node.exe as the service binary.
#
# node.exe does not implement the Windows service control protocol (it never
# calls StartServiceCtrlDispatcher), so the SCM waits forever for SERVICE_RUNNING
# and the service sits in `Start Pending` while the process is actually up and
# listening. That is exactly how the MSI used to hang at "Please wait while
# Windows configures ..." (2026-10-21).
#
# Use the WinSW host instead: it starts node.exe as a child, reports RUNNING,
# and logs stdout/stderr. Config: installer\ServiceHost.xml (installed as
# <host>.xml next to <host>.exe — WinSW v2 requires the names to match).
# ---------------------------------------------------------------------------
$hostExe = Join-Path $InstallDir 'tcs-service-host.exe'
$hostXml = Join-Path $InstallDir 'tcs-service-host.xml'
if (-not (Test-Path -LiteralPath $hostExe) -or -not (Test-Path -LiteralPath $hostXml)) {
  throw @"
Service host missing under $InstallDir

Expected: tcs-service-host.exe + tcs-service-host.xml (WinSW, from vendor\winsw).
Registering node.exe directly produces a service stuck in Start Pending.

Options:
  1. Install the MSI (it ships the host and registers the service correctly), or
  2. Copy vendor\winsw\WinSW.NET4.exe -> $InstallDir\tcs-service-host.exe
     and installer\ServiceHost.xml      -> $InstallDir\tcs-service-host.xml
     then re-run this script.
"@
}

# WinSW resolves its config by name next to itself, so the binary path is just
# the host exe with no arguments.
$binaryPath = '"{0}"' -f $hostExe

if ($PSCmdlet.ShouldProcess($ServiceName, "Create service (start=$StartupType)")) {
  New-Service -Name $ServiceName `
    -BinaryPathName $binaryPath `
    -DisplayName $DisplayName `
    -Description 'Tavern Card Studio: character card storage, audit and git-based version control.' `
    -StartupType $StartupType | Out-Null

  # Recovery: restart twice, then take no action (prevents crash loops from hiding problems)
  & sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000// | Out-Null

  Start-Service -Name $ServiceName
  Start-Sleep -Seconds 2
  Get-Service -Name $ServiceName | Format-List Name, Status, StartType, DisplayName
  Write-Host ''
  Write-Host "Panel:  http://127.0.0.1:8731/"
  Write-Host "API:    http://127.0.0.1:8730/api"
  Write-Host "Config: $config"
  Write-Host "Logs:   $(Join-Path $store 'logs')"
  Write-Host 'Use `node app\server\dist\index.js token show --config <config>` to print the token again.'
}
