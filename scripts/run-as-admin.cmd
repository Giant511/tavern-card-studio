@echo off
rem ─────────────────────────────────────────────────────────────────────
rem T10.25 卸载端到端验证的**提权入口**。
rem
rem 用法：右键这个文件 → 「以管理员身份运行」
rem
rem 为什么需要这个 .cmd：
rem   AI 会话无法自我提权（进程权限在启动时确定，UAC 必须由人点"是"）。
rem   把"提权"这一步交给你点一次，脚本内部就不再需要任何 elevation 逻辑 ——
rem   这是唯一可靠的分工。
rem ─────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0.."

rem 自检提权状态：省得跑一半才失败
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   这个脚本需要管理员权限。
  echo.
  echo   请关掉这个窗口，改为：右键 run-as-admin.cmd ^-^> 「以管理员身份运行」
  echo.
  pause
  exit /b 2
)

echo.
echo   T10.25 卸载端到端验证（管理员会话）
echo   ─────────────────────────────────────────────
echo   会依次验证三条路径：
echo     A  勾选删数据  ^-^> 数据目录与安装目录都要消失
echo     B  不勾选      ^-^> 数据必须还在，安装目录清空
echo     C  残留场景    ^-^> 白名单外的文件不许被删
echo.
echo   注意：过程中会装卸载 MSI 三次，并临时改写
echo         C:\ProgramData\TavernCardStudio
echo         （脚本会先整份备份，跑完自动还原）
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\verify-uninstall-msi.ps1" %*
set RC=%ERRORLEVEL%

echo.
rem 退出码分流：0 通过 / 1 有断言失败 / 2 非管理员 / 3 停不掉服务
rem
rem 分开的意思是**下一步动作不同**：
rem   1 -> 看哪条断言红了
rem   2 -> 先提权
rem   3 -> 先手工把服务或进程收干净再重跑
rem 混成一句"未通过"会让用户不知道从哪下手。
if %RC%==0 (
  echo   验证通过。日志路径见上方输出。
) else if %RC%==2 (
  echo   当前不是管理员，无法安装或卸载 MSI。
  echo   请关掉本窗口，右键 run-as-admin.cmd 选择「以管理员身份运行」。
) else if %RC%==3 (
  echo   停不掉服务端服务，脚本已中止（后续断言都会不可信）。
  echo   处置：结束 node.exe 后重跑，命令：
  echo         taskkill /f /im node.exe
) else (
  echo   有断言失败。请在日志里找 [FAIL] 开头的行，把日志路径发给我。
)
echo.
pause
exit /b %RC%
