/**
 * 热生效的注册策略（F12）。
 *
 * 为什么需要它：管理面板与数据面是**两个进程**（见 supervisor.ts 文件头）。
 * 面板改 `auth.registerMode` 时写的是磁盘上的 config.json，而 worker 里
 * `AuthService` 拿到的是一份启动时的快照 —— 两个进程不共享内存，快照永远不会变。
 *
 * 于是"面板上改成 open"和"服务端真的允许注册"之间必须有个交接点，只有两条路：
 *
 *   1. 改完就重启 worker —— 面板写「立即生效」会变成撒谎（重启完才生效，
 *      而且正在上传的客户端会被打断）；
 *   2. worker 自己盯配置文件 —— 本模块走这条。
 *
 * 判据只看**文件内容是否变化**（不只看 mtime）：Windows 的 mtime 精度足够，
 * 但同一毫秒内两次写入、或"改回原值"这类情况会让 mtime 判据漏掉，
 * 而 config.json 只有几 KB，整份读出来比对最稳，代价可以忽略
 * （只在注册与 /api/auth/config 时调用）。
 */

import { readFileSync } from 'node:fs';

import type { RegisterMode } from './config.js';

export const REGISTER_MODES = ['closed', 'open', 'admin-only'] as const;

export function isRegisterMode(value: unknown): value is RegisterMode {
  return typeof value === 'string' && (REGISTER_MODES as readonly string[]).includes(value);
}

export class LiveRegisterMode {
  /** 上一次成功解析**或**解析失败时看到的原文；null 表示还没读过 */
  private lastSeen: string | null = null;
  private mode: RegisterMode;
  private error: string | null = null;

  constructor(
    private readonly file: string,
    fallback: RegisterMode,
  ) {
    this.mode = fallback;
  }

  /**
   * 当前生效的注册策略。
   *
   * 任何读取/解析问题都**保持上一次的值**，不回落默认：
   *   · 文件正被 atomic-rename 替换时可能读到空内容 —— 回落 closed 会让
   *     "管理员刚点了开放"在几毫秒内被撤销，客户端看到注册入口闪一下消失；
   *   · 配置被手改成坏 JSON 时，坚守旧值比悄悄关门更容易被发现（面板会显示原策略）。
   */
  current(): RegisterMode {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      // 文件暂不可读（权限/被占用）：保持旧值，不要因为一次 IO 抖动改变鉴权行为
      return this.mode;
    }
    if (text === this.lastSeen) return this.mode;
    this.lastSeen = text;

    try {
      const parsed: unknown = JSON.parse(text);
      const auth = (parsed as { auth?: { registerMode?: unknown } } | null)?.auth;
      const mode = auth?.registerMode;
      if (isRegisterMode(mode)) {
        this.mode = mode;
        this.error = null;
      } else {
        // 字段缺失或不合法：保持旧值，并记下原因（/api/auth/config 会带出去）
        this.error = `config.auth.registerMode 不合法：${JSON.stringify(mode)}`;
      }
    } catch (error) {
      this.error = `config.json 解析失败：${error instanceof Error ? error.message : String(error)}`;
    }
    return this.mode;
  }

  /** 最近一次热加载失败的原因（成功时为 null）；排查"面板改了但没生效"时用 */
  get lastError(): string | null {
    return this.error;
  }
}
