/**
 * 日志：结构化一行一条（时间 / 级别 / 事件 / 字段 JSON）。
 *
 * 同一个 logger 同时写 stdout 与 `dataDir/logs/server.log`（受 `logLevel` 过滤）。
 * supervisor 会把 worker 的 stdout/stderr 收进内存环形缓冲，供管理面板「日志」页查看。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** 日志目录；不给则只写 stdout */
  logDir?: string;
  /** 额外输出（supervisor 用它把 worker 日志转发到自己的环形缓冲） */
  sink?: (line: string) => void;
  /** 进程角色，写进每条日志便于区分控制面/数据面 */
  role?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_RANK[options.level];
  let fileReady = false;

  const write = (level: LogLevel, prefix: string, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_RANK[level] < threshold) return;
    const record = {
      t: new Date().toISOString(),
      level,
      role: options.role ?? 'server',
      event: prefix ? `${prefix}.${event}` : event,
      ...(fields ?? {}),
    };
    const line = JSON.stringify(record);
    if (level === 'error') console.error(line);
    else console.log(line);
    options.sink?.(line);
    if (options.logDir) {
      try {
        if (!fileReady) {
          mkdirSync(options.logDir, { recursive: true });
          fileReady = true;
        }
        appendFileSync(join(options.logDir, 'server.log'), `${line}\n`, 'utf8');
      } catch {
        // 日志写盘失败不能影响主流程
      }
    }
  };

  const make = (prefix: string): Logger => ({
    debug: (event, fields) => write('debug', prefix, event, fields),
    info: (event, fields) => write('info', prefix, event, fields),
    warn: (event, fields) => write('warn', prefix, event, fields),
    error: (event, fields) => write('error', prefix, event, fields),
    child: (child) => make(prefix ? `${prefix}.${child}` : child),
  });

  return make('');
}
