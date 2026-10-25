/**
 * 「同一配置状态下只警告一次」的持久化去重（v0.1.3 真机反馈）。
 *
 * ## 问题
 *
 * `assertSafeConfig` 里那条「开放注册 + 非回环」的 SecurityWarning 是
 * `process.emitWarning` 打出来的。它**每次进程启动都会打一条**：
 * 真机上装完服务后 worker 反复重启 4 次，err.log 里就堆了 4 条一模一样的警告
 * （PID 各不相同），看起来像"一直在出问题"，实际上是同一件事被念了 4 遍。
 *
 * 安全警告不能因为烦就不打 —— 但重复 4 遍会让真正的新警告淹没在噪声里。
 * 所以要按「配置状态」去重：**同一状态只提示一次，配置一变就重新提示**。
 *
 * ## 为什么必须落盘
 *
 * 去重不能只放内存：重复的根源就是"进程重启"，内存状态每次都是空的。
 * 所以把「上次警告时的配置签名」写进 `<dataDir>/.warned.json`。
 *
 * ## 失败策略
 *
 * 读不到 / 写不进（目录还不存在、权限不足、文件被占用）时**照常警告**。
 * 宁可多念一遍，也不能因为一个缓存文件写失败就把安全警告吞掉。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 记在 `<dataDir>/.warned.json` 里：key → 上次警告时的配置签名 */
export type WarnState = Record<string, string>;

const STATE_FILE = '.warned.json';

export interface WarnOnceOptions {
  dataDir: string;
  /** 警告种类（同一种类一个槽位，互不干扰） */
  key: string;
  /** 配置状态签名：变了就重新警告 */
  signature: string;
  message: string;
  /** 默认 `process.emitWarning(message, 'SecurityWarning')`；测试可注入 */
  emit?: (message: string) => void;
}

/**
 * 同一种警告、同一个配置签名，只发一次。
 *
 * @returns 本次是否真的发出了警告（false = 之前已经警告过同一状态）
 */
export function warnOnce(options: WarnOnceOptions): boolean {
  const emit = options.emit ?? ((message: string) => process.emitWarning(message, 'SecurityWarning'));
  const file = join(options.dataDir, STATE_FILE);

  let state: WarnState = {};
  try {
    if (existsSync(file)) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === 'string') state[key] = value;
        }
      }
    }
  } catch {
    // 文件损坏/读不到：当成"没警告过"，宁可多念一次
    state = {};
  }

  if (state[options.key] === options.signature) return false;

  emit(options.message);

  state[options.key] = options.signature;
  try {
    mkdirSync(options.dataDir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 写不进去就算了：下次启动会再警告一次，比静默好
  }
  return true;
}
