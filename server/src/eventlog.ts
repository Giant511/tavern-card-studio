/**
 * 写 Windows 应用程序事件日志（`eventcreate.exe`）。
 *
 * 为什么单独一个模块：卸载清理（T10.23）与服务端自检（T10.24）都要留一条
 * "即使文件日志丢了也还在"的痕迹。两处各写一份 `spawnSync('eventcreate.exe', …)`
 * 迟早会漂（参数顺序、ID、来源名各改一处）。
 *
 * ## 为什么用 eventcreate 而不是直接写 ETW / 注册事件源
 *
 * 注册事件源要写 `HKLM\SYSTEM\CurrentControlSet\Services\EventLog\Application\<源>`
 * 下的 `EventMessageFile`，需要管理员且要清理，对"偶尔留一条诊断痕迹"来说是过重的。
 * `eventcreate.exe` 是系统自带、一条命令搞定（第一次用到时它自己注册源）。
 *
 * 代价：它**需要管理员**（服务以 LocalSystem 跑，满足；用户手工跑
 * `tcs-server cleanup` 时若未提权就会失败）。失败必须只记录、不影响主流程 ——
 * 事件日志是第二条线索，不是唯一证据。
 */

import { spawnSync } from 'node:child_process';

/** 事件源名。写成常量是为了让 `Get-WinEvent -ProviderName` 有个稳定目标。 */
export const EVENT_SOURCE = 'TavernCardStudio';

/**
 * 写一条 Information 级事件。
 *
 * @throws 调用方可捕获；本函数不吞异常（吞掉就没人知道事件日志没写成功）。
 */
export function writeApplicationEvent(message: string): void {
  if (process.platform !== 'win32') {
    throw new Error('事件日志仅 Windows 可用');
  }
  // `/D` 后面的文本会原样进事件描述。eventcreate 对长度有限制（约 200 字符
  // 安全），调用方应自己截断 —— 这里再兜一层，避免"事件没写进去"变成静默失败。
  const body = message.length > 200 ? `${message.slice(0, 197)}...` : message;
  const result = spawnSync(
    'eventcreate.exe',
    ['/T', 'INFORMATION', '/ID', '100', '/L', 'APPLICATION', '/SO', EVENT_SOURCE, '/D', body],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || result.stdout || `eventcreate exited ${result.status}`).trim());
  }
}
