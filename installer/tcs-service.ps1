<#
.SYNOPSIS
  注册 / 卸载 / 查询 Tavern Card Studio 服务端 Windows 服务（不依赖 MSI）。

.DESCRIPTION
  适用于绿色包（release\server）或源码目录。默认以 LocalSystem 运行，数据目录
  %ProgramData%\TavernCardStudio。需要以管理员身份运行 PowerShell。

.EXAMPLE
  .\tcs-service.ps1 -Action install
  .\tcs-service.ps1 -Action status
  .\tcs-service.ps1 -Action uninstall

.EXAMPLE
  # 只打印将要执行的命令，不实际改动系统
  .\tcs-service.ps1 -Action install -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [ValidateSet('install', 'uninstall', 'status', 'start', 'stop')]
  [string]$Action = 'status',

  # 绿色包根目录（包含 node.exe 与 app\）；源码目录也可。
  # 注意：不要在 param() 默认值里用 $PSScriptRoot —— 用 powershell -File 调用时
  # 它在参数绑定阶段可能是空串（实测 PS 5.1 如此），脚本会直接报
  # "Cannot bind argument to parameter 'Path'"。所以留空，在正文里解析。
  [string]$InstallDir = '',

  [string]$DataDir = (Join-Path $env:ProgramData 'TavernCardStudio'),

  [string]$ServiceName = 'TavernCardStudioServer',
  [string]$DisplayName = 'Tavern Card Studio Server',
  [ValidateSet('Automatic', 'Manual')]
  [string]$StartupType = 'Automatic',

  # 卸载时是否连数据目录一起删除（默认保留，避免误删版本历史）
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'

# 脚本自身所在目录：$PSScriptRoot 在正文里可靠，取不到时退回 $MyInvocation。
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($scriptDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrEmpty($InstallDir)) {
  $InstallDir = Split-Path -Parent $scriptDir
}

function Resolve-NodePath {
  param([string]$Root)
  $bundled = Join-Path $Root 'node.exe'
  if (Test-Path $bundled) { return $bundled }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "找不到 node.exe：$bundled 不存在，且 PATH 中没有 node。"
}

function Resolve-EntryPath {
  param([string]$Root)
  $bundled = Join-Path $Root 'app\server\dist\index.js'
  if (Test-Path $bundled) { return $bundled }
  $source = Join-Path $Root 'server\dist\index.js'
  if (Test-Path $source) { return $source }
  throw "找不到服务端入口：$bundled 或 $source。请先 npm run build 或 npm run pack:server。"
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ServiceOrNull {
  Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

$node = Resolve-NodePath -Root $InstallDir
$entry = Resolve-EntryPath -Root $InstallDir
$configPath = Join-Path $DataDir 'config.json'
$binaryPath = '"{0}" "{1}" serve --config "{2}"' -f $node, $entry, $configPath

switch ($Action) {
  'status' {
    $service = Get-ServiceOrNull
    if (-not $service) {
      Write-Host "服务未安装：$ServiceName"
      exit 1
    }
    $service | Format-List Name, DisplayName, Status, StartType
    $cim = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
    Write-Host "BinaryPathName: $($cim.PathName)"
    Write-Host "进程号: $($cim.ProcessId)"
    exit 0
  }

  'install' {
    if (-not (Test-Administrator)) {
      throw '注册服务需要管理员权限：请以「以管理员身份运行」打开 PowerShell 后重试。'
    }
    if (Get-ServiceOrNull) {
      throw "服务已存在：$ServiceName。先执行 -Action uninstall，或用 -Action stop/start。"
    }
    if (-not (Test-Path $DataDir)) {
      if ($PSCmdlet.ShouldProcess($DataDir, '创建数据目录')) {
        New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
      }
    }

    # 首次启动前先初始化配置，确保 token 生成并打印（服务以 LocalSystem 运行，也需要能写该目录）
    if (-not (Test-Path $configPath)) {
      if ($PSCmdlet.ShouldProcess($configPath, '初始化配置并生成访问令牌')) {
        & $node $entry config show --config $configPath --data-dir (Join-Path $DataDir 'store') --rules-dir (Join-Path $InstallDir 'app\rules')
      }
    }

    # 不要直接用 node.exe 当服务二进制：它不实现服务控制协议
    # （从不调用 StartServiceCtrlDispatcher），SCM 永远等不到 SERVICE_RUNNING，
    # 服务卡在 Start Pending，而进程其实活着且在监听端口 —— 极具迷惑性。
    # 2026-10-21 就是这样让 MSI 卡在 "Please wait while Windows configures ..."。
    # 正确做法：用 WinSW 宿主（vendor\winsw），它负责报告 RUNNING 并转发日志。
    $hostExe = Join-Path $InstallDir 'tcs-service-host.exe'
    $hostXml = Join-Path $InstallDir 'tcs-service-host.xml'
    if (-not (Test-Path -LiteralPath $hostExe) -or -not (Test-Path -LiteralPath $hostXml)) {
      throw @"
缺少服务宿主：需要 $InstallDir\tcs-service-host.exe 与 tcs-service-host.xml
（来自 vendor\winsw\WinSW.NET4.exe + installer\ServiceHost.xml）。

直接注册 node.exe 会让服务永久停在 Start Pending。
请改用 MSI 安装，或先把上面两个文件拷到安装目录再重跑本脚本。
"@
    }
    # WinSW 按文件名在自身同目录找配置，所以 BinaryPath 只写宿主 exe，不带参数。
    $binaryPath = '"{0}"' -f $hostExe

    if ($PSCmdlet.ShouldProcess($ServiceName, "注册服务（$StartupType）")) {
      New-Service -Name $ServiceName -BinaryPathName $binaryPath -DisplayName $DisplayName -StartupType $StartupType | Out-Null
      if ($PSCmdlet.ShouldProcess($ServiceName, '写入服务描述')) {
        & sc.exe description $ServiceName 'Tavern Card Studio 角色卡审计与版本控制服务（本地部署）' | Out-Null
      }
      Start-Service -Name $ServiceName
      Write-Host "已安装并启动：$ServiceName"
      Write-Host "管理面板：http://127.0.0.1:8731/（端口以 config.json 为准）"
      Write-Host "数据目录：$DataDir"
    }
    exit 0
  }

  'uninstall' {
    if (-not (Test-Administrator)) {
      throw '卸载服务需要管理员权限。'
    }
    $service = Get-ServiceOrNull
    if (-not $service) {
      Write-Host "服务未安装：$ServiceName"
      exit 0
    }
    if ($PSCmdlet.ShouldProcess($ServiceName, '停止并删除服务')) {
      if ($service.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force }
      $cim = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
      if ($cim) { Invoke-CimMethod -InputObject $cim -MethodName Delete | Out-Null }
      Write-Host "已删除服务：$ServiceName"
    }
    if ($RemoveData) {
      Write-Warning "⚠️ 将删除数据目录（含全部角色卡、版本历史、审计快照）：$DataDir"
      if ($PSCmdlet.ShouldProcess($DataDir, '删除数据目录')) {
        Remove-Item -LiteralPath $DataDir -Recurse -Force
      }
    } else {
      Write-Host "数据目录已保留：$DataDir（如需删除，加 -RemoveData）"
    }
    exit 0
  }

  'start' {
    Start-Service -Name $ServiceName
    Write-Host "已启动：$ServiceName"
    exit 0
  }

  'stop' {
    Stop-Service -Name $ServiceName -Force
    Write-Host "已停止：$ServiceName（数据目录保留）"
    exit 0
  }
}
