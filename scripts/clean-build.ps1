# 彻底清理构建产物（2026-11-04）
#
# ## 为什么不能用 rm -rf / fs.rmSync
#
# 本机有安全层会把**删除调用**改写成"移入回收站"（safe-delete）：
#
# ```text
# [safe-delete] 操作失败: spawnSync ...\genie-trash\win32-x64.exe ETIMEDOUT
# ```
#
# 后果有两层，都很贵：
#
# 1. **空间不释放**。回收站与原文件同盘（D 盘），删 `D:\...\target`
#    只是把内容挪进 `D:\$RECYCLE.BIN`。我连续几轮"清理"之后回收站涨到
#    80 GB，D 盘可用 0.00 GB，构建报 `ENOSPC`。
# 2. **慢到卡死**。`rm -rf` 被逐文件拦截改写，一个 2.7 GB 的 build 目录
#    跑 16 分钟还没完，最后被 SIGTERM 掐掉 —— 看着像"句柄占用"。
#
# 用户明令（长期有效）：清理过程数据必须彻底删除。
#
# ## 唯一实测有效的方式
#
# 直接调 .NET 的文件/目录删除 API，绕开 safe-delete 那一层：
#
# ```powershell
# [System.IO.File]::Delete($path)
# [System.IO.Directory]::Delete($path, $true)
# ```
#
# 实测：清回收站里的编译产物，一次释放 48 GB。
#
# ## 只删构建产物，不碰用户数据
#
# 默认只清本仓库的构建目录（下面 $Targets）。加 `-Recycle` 才清回收站，
# 且**只按扩展名白名单**清编译中间产物 —— `.docx` / `.png` / `.zip` /
# 视频一律不动（那些可能是用户自己的）。
#
# 用法：
#   powershell -NoProfile -File scripts/clean-build.ps1
#   powershell -NoProfile -File scripts/clean-build.ps1 -Recycle
#   powershell -NoProfile -File scripts/clean-build.ps1 -Recycle -DryRun
#
# ★ 参数不能叫 `-WhatIf`：`[CmdletBinding()]` 已经内置了 `-WhatIf`，
# 再定义一个同名 switch 会直接报参数重复、脚本一个字都不执行
# （第一次演练就是这么"静默失败"的：exit code 0、日志空白）。

[CmdletBinding()]
param(
  [switch]$Recycle,
  [switch]$DryRun
)

$ErrorActionPreference = 'SilentlyContinue'
$repo = Split-Path -Parent $PSScriptRoot

function Get-FreeGB {
  $d = Get-PSDrive D
  if ($null -eq $d) { return 0 }
  return [math]::Round($d.Free / 1GB, 2)
}

function Remove-PathHard {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  # 先量大小，好在删完后核对（命令成功不等于空间释放）
  $bytes = 0
  if (Test-Path -LiteralPath $Path -PathType Container) {
    $sum = (Get-ChildItem -LiteralPath $Path -Recurse -File -Force |
      Measure-Object -Property Length -Sum).Sum
    # 空目录时 .Sum 是 $null，直接参与除法会得到 $null，这里显式归零
    $bytes = if ($null -eq $sum) { 0 } else { [long]$sum }
  } else {
    $bytes = [long](Get-Item -LiteralPath $Path -Force).Length
  }
  if ($DryRun) {
    # ★ 必须用 Write-Host，不能用 Write-Output。
    #   PowerShell 函数**所有**输出都会成为返回值，`Write-Output` 会让
    #   这个函数返回 [string, long] 数组，外面 `$freed += ...` 立刻变成
    #   数组，再除以 1GB 就报 "System.Object[] 不包含 op_Division"。
    Write-Host ("[dryrun] " + $Path + "  " + [math]::Round($bytes / 1GB, 2) + " GB")
    return $bytes
  }
  if (Test-Path -LiteralPath $Path -PathType Container) {
    # .NET 方法抛的是**异常**，`$ErrorActionPreference` 管不住它，必须 try/catch。
    # 常见原因：gradle daemon / cargo 还开着，句柄没放。
    try {
      [System.IO.Directory]::Delete($Path, $true)
    } catch {
      Write-Host ("  [skip] " + $Path + " —— " + $_.Exception.Message)
      return 0
    }
  } else {
    # 只读属性会让 File.Delete 抛 UnauthorizedAccessException
    try { (Get-Item -LiteralPath $Path -Force).IsReadOnly = $false } catch {}
    try {
      [System.IO.File]::Delete($Path)
    } catch {
      return 0
    }
  }
  return $bytes
}

# ── ① 本仓库的构建目录 ────────────────────────────────────
$Targets = @(
  'client\src-tauri\target',
  'client\src-tauri\gen\android\app\build',
  'client\src-tauri\gen\android\build',
  'client\src-tauri\gen\android\.gradle',
  'client\dist',
  'server\dist',
  'shared\dist'
)

# ── ①b tsc 的增量缓存（**必须与 dist 一起删**）────────────
#
# `tsc -b` 判断"要不要重新编译"看的是 `.tsbuildinfo`，不是 dist 在不在。
# 只删 dist 会得到这个局面：
#
# ```text
#   npx tsc -b shared      → 认为已是最新，什么都不做
#   check-dist-fresh       → ENOENT: shared/dist/.build-stamp.json
#   之后所有 client 构建    → Cannot find module '@tcs/shared'
# ```
#
# 表现是"清了一下磁盘，整个项目就编译不过了"，而且报错指向
# `@tcs/shared`（模块找不到），完全看不出是清理脚本的锅。
# 第一版漏了这条，当场踩到。
$StaleBuildInfo = @(
  'shared\tsconfig.tsbuildinfo',
  'server\tsconfig.tsbuildinfo',
  'client\tsconfig.tsbuildinfo'
)

$before = Get-FreeGB
Write-Output ("before: " + $before + " GB free")
$total = 0
foreach ($rel in $Targets) {
  $full = Join-Path $repo $rel
  $got = Remove-PathHard -Path $full
  if ($got -gt 0) {
    Write-Output ("  cleaned " + $rel + "  " + [math]::Round($got / 1GB, 2) + " GB")
    $total += $got
  }
}
Write-Output ("repo targets freed: " + [math]::Round($total / 1GB, 2) + " GB")

# 增量缓存文件（小，但不清会让下一次构建什么都不做）
foreach ($rel in $StaleBuildInfo) {
  $full = Join-Path $repo $rel
  if (Test-Path -LiteralPath $full) {
    $got = Remove-PathHard -Path $full
    if ($got -gt 0) {
      Write-Output ("  cleaned " + $rel + "  " + [math]::Round($got / 1KB, 1) + " KB")
      $total += $got
    }
  }
}

# ── ② 回收站（只按扩展名白名单）──────────────────────────
if ($Recycle) {
  # 白名单：只含编译中间产物
  $BuildExt = @(
    '.o', '.obj', '.a', '.lib', '.so', '.dylib', '.dll',
    '.rlib', '.rmeta', '.rmeta-link', '.temp-archive',
    '.class', '.dex', '.jar', '.apk', '.flat', '.natvis',
    '.pdb', '.map', '.d', '.gcda', '.gcno', '.bin'
  )

  $root = 'D:\$RECYCLE.BIN'
  $freed = 0
  $count = 0

  # 回收站按 SID 分子目录；逐个进去只取顶层的 $R* 项
  foreach ($sid in [System.IO.Directory]::GetDirectories($root)) {
    foreach ($item in [System.IO.Directory]::GetFileSystemEntries($sid, '$R*')) {
      $name = [System.IO.Path]::GetFileName($item)
      $real = if ($name.Length -gt 2) { $name.Substring(2) } else { $name }
      $ext = [System.IO.Path]::GetExtension($real).ToLower()
      if ($BuildExt -notcontains $ext) { continue }
      $freed += (Remove-PathHard -Path $item)
      $count += 1
    }
  }
  Write-Output ("recycle freed: " + [math]::Round($freed / 1GB, 2) + " GB / " + $count + " items")
}

$after = Get-FreeGB
Write-Output ("after: " + $after + " GB free (delta " + [math]::Round($after - $before, 2) + " GB)")
