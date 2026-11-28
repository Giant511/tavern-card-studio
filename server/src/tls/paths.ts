/**
 * TLS 证书路径的口径（2026-11-24）。
 *
 * ## 为什么单独一个模块
 *
 * 相对路径在项目里有**两个**解析者：
 *
 * ```text
 *   面板（inspectTlsInputs）  按 dataDir 解析 → 检查"文件在不在、配对不配对"
 *   运行时（prepareTlsMaterial）原来直接用 config.certPath → 按进程 cwd 解析
 * ```
 *
 * 于是出现"面板说可用、服务起不来"的错位。Windows 服务装好后的 cwd 是
 * `C:\Windows\System32`，用户填的 `certs/server.pem` 在那里当然找不到 ——
 * 而面板检查时用的是 dataDir，一切正常。
 *
 * 两处必须用同一个函数。放在独立模块里是为了避开 `panel.ts ↔ server.ts`
 * 的运行时循环依赖（panel 只 `import type` server，但 server 若反过来
 * import panel，就成了环）。
 */

import { isAbsolute, join } from 'node:path';

/** 相对路径按数据目录解析（与 `inspectTlsInputs` 的口径一致） */
export function resolveTlsPath(dataDir: string, path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '';
  return isAbsolute(trimmed) ? trimmed : join(dataDir, trimmed);
}
