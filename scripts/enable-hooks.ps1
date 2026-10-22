# 启用仓库内的 git 钩子（pre-commit 校验 PLAN.md 决策表序号）
#
# 为什么用 core.hooksPath 而不是往 .git/hooks 里拷文件：
#   .git/hooks 不入库，换台机器就丢了；钩子放 scripts/hooks 可审查、可版本化。
#
# 用法：powershell -ExecutionPolicy Bypass -File scripts\enable-hooks.ps1
#       powershell ... -File scripts\enable-hooks.ps1 -GitPath "C:\...\git.exe"

param(
  [string]$GitPath = ''
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot

# 定位 git：PowerShell 的 PATH 里未必有 git（本机就只在 Git Bash 的 mingw 环境里），
# 所以不能直接写 `& git`，否则报「无法将 git 项识别为 cmdlet」。
function Resolve-Git {
  param([string]$Explicit)

  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    throw "指定的 -GitPath 不存在：$Explicit"
  }

  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  foreach ($candidate in @(
      'C:\Program Files\Git\cmd\git.exe',
      'C:\Program Files\Git\bin\git.exe',
      'C:\Program Files (x86)\Git\cmd\git.exe',
      "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
    )) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  # 便携版 Git（如 WorkBuddy 自带的 PortableGit）：按版本目录倒序取最新
  foreach ($root in @(
      "$env:USERPROFILE\.workbuddy\binaries\PortableGit\versions",
      "$env:LOCALAPPDATA\PortableGit"
    )) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $found = Get-ChildItem -LiteralPath $root -Recurse -Filter git.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'mingw64\\bin\\git\.exe$' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($found) { return $found.FullName }
  }

  return $null
}

$git = Resolve-Git -Explicit $GitPath
if (-not $git) {
  Write-Host '找不到 git.exe。可在仓库根目录手动执行：'
  Write-Host '  git config core.hooksPath scripts/hooks'
  Write-Host '或用 -GitPath 指定 git.exe 路径。'
  exit 1
}
Write-Host "使用 git：$git"

Push-Location $repo
try {
  & $git config core.hooksPath 'scripts/hooks'
  if ($LASTEXITCODE -ne 0) { throw 'git config 失败：当前目录不是 git 仓库？' }
  Write-Host '已设置 core.hooksPath = scripts/hooks'
  Write-Host '生效的钩子：'
  Get-ChildItem -LiteralPath (Join-Path $repo 'scripts/hooks') -File |
    ForEach-Object { Write-Host "  - $($_.Name)" }
} finally {
  Pop-Location
}
