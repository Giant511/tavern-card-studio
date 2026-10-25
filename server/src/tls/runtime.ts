/**
 * TLS 监听层的**热重载运行时**（v0.1.3 / F4）。
 *
 * 需求第 2 条：`tls.mode` 切换与证书更换不重启服务进程本身，监听层热重载；
 * 热更失败要**回滚**并显示错误。
 *
 * 为什么必须有这一层：v0.1.2 里 TLS 只在 worker 启动路径上装配一次
 * （`prepareTlsMaterial` → `startHttpsServer`），配置改了只有重启 worker 才生效。
 * 而 worker 重启会断掉正在上传的客户端 —— 换一张证书打断所有人是不可接受的。
 *
 * 三条实现约束，每条都对应一种"会把人坑住"的做法：
 *
 *   1. **先备料，后动监听**。`prepareTlsMaterial` 会读文件、验公私钥、可能生成
 *      自签证书 —— 它抛错时**一个字节的监听都不该被动过**。所以顺序是
 *      `prepare → (close old → start new)`，而不是"先关再说"。
 *
 *   2. **同端口必须先关再开，跨端口可以先开再关**。同一个端口上不可能同时
 *      挂两个监听（EADDRINUSE），所以端口没变时只能 close→start，中间有
 *      几十毫秒的空窗；端口变了就可以先起新的再关旧的，客户端完全无感。
 *      两条路径都要能回滚。
 *
 *   3. **回滚要真的把旧配置重新监听起来，不能只把状态改回去**。失败后
 *      如果只是"状态显示旧模式"而监听已经关了，面板会显示"selfsigned 正常"
 *      而实际 https 端口没人听 —— 那是最坏的一种不一致。
 *
 * 并发：watcher（定时比对配置文件）与 `POST /api/tls/reload`（面板保存后立即
 * 触发）会同时到达。所有 `apply` 串行化，且**幂等**（同一份配置重复应用是空操作），
 * 所以谁先谁后都不影响结果。
 */

import type { RequestListener } from 'node:http';

import {
  prepareTlsMaterial,
  runtimeTlsState,
  startHttpsServer,
  type PreparedTls,
  type RuntimeTlsStateShape,
  type StartedHttps,
  type TlsConfig,
} from './server.js';
import { readFileSync } from 'node:fs';

/** 应用结果：面板据此决定"已生效 / 已回滚 / 未变" */
export interface TlsApplyResult {
  ok: boolean;
  /** 本次是否真的动了监听（false = 配置与当前一致，空操作） */
  changed: boolean;
  /** 应用后（失败时是回滚后）**实际生效**的状态 */
  state: RuntimeTlsStateShape;
  /** 失败原因；ok=true 时为 null */
  error: string | null;
  /** 失败回滚时，旧监听是否成功恢复（false = 现在处于"没有 HTTPS"的状态） */
  rolledBack: boolean;
}

export interface TlsRuntimeOptions {
  handler: RequestListener;
  dataDir: string;
  /** API 监听地址，HTTPS 与它共用（需求 F1.3 的双通窗口） */
  host: string;
  commonName?: string;
  logger?: {
    info: (event: string, data?: Record<string, unknown>) => void;
    warn: (event: string, data?: Record<string, unknown>) => void;
    error: (event: string, data?: Record<string, unknown>) => void;
  };
}

/** 配置指纹：用来判断"是否需要真的动监听" */
export function tlsSignature(config: TlsConfig): string {
  return JSON.stringify([config.mode, config.httpsPort, config.certPath, config.keyPath]);
}

export class TlsRuntime {
  private current: StartedHttps | null = null;
  private prepared: PreparedTls;
  private applied: TlsConfig;
  private stateValue: RuntimeTlsStateShape;
  /** 串行化：后到的 apply 排在队尾，读到的永远是"上一次完成后的状态" */
  private queue: Promise<unknown> = Promise.resolve();
  private lastErrorValue: string | null = null;
  /** 上一次尝试的配置指纹（含失败），避免 watcher 对同一份坏配置每 2 秒重试一次刷日志 */
  private lastAttempt: string | null = null;

  constructor(private readonly options: TlsRuntimeOptions) {
    // 构造时给一个"尚未监听"的占位状态：真正启动走 `start()`
    this.prepared = { material: null, info: null, warnings: [], plaintext: true };
    this.applied = { mode: 'off', httpsPort: 0, certPath: '', keyPath: '' };
    this.stateValue = runtimeTlsState('off', null, this.prepared);
  }

  get state(): RuntimeTlsStateShape {
    return this.stateValue;
  }

  get lastError(): string | null {
    return this.lastErrorValue;
  }

  /** 首次启动（worker 的启动路径）。失败**抛错**让 worker 启动失败 —— 与 T10.5 一致。 */
  async start(config: TlsConfig): Promise<RuntimeTlsStateShape> {
    const result = await this.apply(config, { initial: true });
    if (!result.ok) throw new Error(result.error ?? 'TLS 启动失败');
    return result.state;
  }

  /**
   * 应用一份 TLS 配置。
   *
   * `initial=true` 时不做"配置未变则跳过"的判断（启动时必须真的把监听建起来）。
   */
  async apply(config: TlsConfig, options: { initial?: boolean } = {}): Promise<TlsApplyResult> {
    const run = async (): Promise<TlsApplyResult> => this.applyInner(config, options);
    const chained = this.queue.then(run, run);
    // 队列本身不能因为某次失败而断掉：吞掉拒绝，让下一个 apply 还能执行
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async applyInner(config: TlsConfig, options: { initial?: boolean }): Promise<TlsApplyResult> {
    const signature = tlsSignature(config);
    const unchanged = this.current !== null && tlsSignature(this.applied) === signature;
    if (unchanged && options.initial !== true) {
      return { ok: true, changed: false, state: this.stateValue, error: null, rolledBack: false };
    }

    // ── ① 先备料：这一步失败时监听完全没被碰过 ──────────────
    let prepared: PreparedTls;
    try {
      prepared = await prepareTlsMaterial({
        config,
        dataDir: this.options.dataDir,
        commonName: this.options.commonName ?? 'Tavern Card Studio Server',
      });
    } catch (error) {
      const message = describeApplyError(config, error);
      this.lastErrorValue = message;
      this.lastAttempt = signature;
      this.options.logger?.error('tls.reload.prepare_failed', { mode: config.mode, message });
      // 状态保持原样（监听没动，状态就不该动）。
      // `rolledBack` 的语义是"**现在还有一个能用的旧监听**"，所以按现状给，
      // 不是按"做过回滚动作"给 —— 备料阶段失败时监听从未被碰过，但它确实还在。
      return {
        ok: false,
        changed: false,
        state: this.stateValue,
        error: message,
        rolledBack: this.current !== null,
      };
    }

    for (const warning of prepared.warnings) {
      this.options.logger?.warn('tls.warning', { message: warning });
    }

    // ── ② off：关掉现有监听即可 ────────────────────────────
    if (!prepared.material) {
      await this.closeCurrent();
      this.applied = { ...config };
      this.prepared = prepared;
      this.stateValue = runtimeTlsState('off', null, prepared);
      this.lastErrorValue = null;
      this.lastAttempt = signature;
      this.options.logger?.warn('tls.plaintext', { mode: 'off', reload: options.initial !== true });
      return { ok: true, changed: true, state: this.stateValue, error: null, rolledBack: false };
    }

    // ── ③ 起新监听 ────────────────────────────────────────
    const previous = this.current;
    const previousConfig = { ...this.applied };
    const previousPrepared = this.prepared;

    /*
     * 跨端口才能"先开新的"。
     *
     * `previous.port` 是**回读的实际端口**，不是配置里的 httpsPort：
     * 配置写 8443 而实际监听在 8443 时两者相同；但如果上一次是用 0
     * （系统分配）起来的，配置值就与实况不符 —— 拿配置去猜会撞 EADDRINUSE。
     */
    const samePort = previous !== null && previous.port === config.httpsPort;

    if (!samePort) {
      const started = await tryStart(this.options, prepared, config);
      if (started.ok) {
        // 新监听已经在跑，再关旧的：客户端无感
        if (previous !== null) await closeQuietly(previous);
        this.commit(config, prepared, started.value);
        return { ok: true, changed: true, state: this.stateValue, error: null, rolledBack: false };
      }
      this.lastErrorValue = started.error;
      this.lastAttempt = signature;
      // 旧监听还在（没关过），无需回滚动作
      return {
        ok: false,
        changed: false,
        state: this.stateValue,
        error: started.error,
        rolledBack: previous !== null,
      };
    }

    // 同端口：只能先关后开，中间有短暂空窗
    await this.closeCurrent();
    const started = await tryStart(this.options, prepared, config);
    if (started.ok) {
      this.commit(config, prepared, started.value);
      return { ok: true, changed: true, state: this.stateValue, error: null, rolledBack: false };
    }

    /*
     * ── ④ 回滚：把**旧配置**重新监听起来 ──────────────────
     *
     * 这里必须重新 prepare 一份旧材料，而不是复用 `previousPrepared`：
     * 旧材料里的 cert/key 字符串还在内存里，直接重用是可以的 —— 但
     * `startHttpsServer` 只吃 material，所以复用即可，不必再读盘。
     * 只有在旧材料本身不可用（理论不该发生）时才读盘重试。
     */
    this.lastErrorValue = started.error;
    this.lastAttempt = signature;
    const restore = previousPrepared.material
      ? await tryStart(this.options, previousPrepared, previousConfig)
      : { ok: false as const, error: '旧证书材料已不可用' };

    if (restore.ok) {
      this.prepared = previousPrepared;
      this.applied = previousConfig;
      this.current = restore.value;
      this.stateValue = runtimeTlsState(previousConfig.mode, restore.value.port, previousPrepared);
      this.options.logger?.warn('tls.reload.rolled_back', {
        failedMode: config.mode,
        restoredMode: previousConfig.mode,
        restoredPort: restore.value.port,
      });
      return {
        ok: false,
        changed: false,
        state: this.stateValue,
        error: started.error,
        rolledBack: true,
      };
    }

    // 连回滚都失败：如实说"现在没有 HTTPS"，不要假装还是旧模式
    this.current = null;
    this.stateValue = {
      ...runtimeTlsState(previousConfig.mode, null, previousPrepared),
      warnings: [...previousPrepared.warnings, `热更失败且回滚失败：${restore.error}`],
    };
    this.options.logger?.error('tls.reload.rollback_failed', {
      failedMode: config.mode,
      restoreError: restore.error,
    });
    return {
      ok: false,
      changed: false,
      state: this.stateValue,
      error: `${started.error}；回滚也失败（${restore.error}），当前没有 HTTPS 监听`,
      rolledBack: false,
    };
  }

  /**
   * 从配置文件重新应用（watcher 与面板保存都走这里）。
   *
   * 只读 `tls` 段：`host` / `port` 变化属于进程级参数，热更无能为力
   * （socket 已经绑在旧地址上），那类改动仍由 supervisor 重启 worker 处理。
   */
  async applyFromConfigFile(configPath: string): Promise<TlsApplyResult> {
    let config: TlsConfig;
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      const raw = (parsed as { tls?: Partial<TlsConfig> } | null)?.tls;
      if (raw === undefined || raw === null) {
        return { ok: true, changed: false, state: this.stateValue, error: null, rolledBack: false };
      }
      config = {
        mode: raw.mode ?? this.applied.mode,
        httpsPort: raw.httpsPort ?? this.applied.httpsPort,
        certPath: raw.certPath ?? this.applied.certPath,
        keyPath: raw.keyPath ?? this.applied.keyPath,
      };
    } catch (error) {
      // 读到坏 JSON（atomic-rename 的中间态）不该把监听搞挂：保持现状，记一条
      const message = `读取配置失败：${error instanceof Error ? error.message : String(error)}`;
      this.lastErrorValue = message;
      return { ok: false, changed: false, state: this.stateValue, error: message, rolledBack: true };
    }

    // 同一份配置刚试过且失败了：跳过，等文件内容真的变了再试
    const signature = tlsSignature(config);
    if (this.lastAttempt === signature && this.lastErrorValue !== null) {
      return {
        ok: false,
        changed: false,
        state: this.stateValue,
        error: this.lastErrorValue,
        rolledBack: true,
      };
    }
    return this.apply(config);
  }

  async close(): Promise<void> {
    await this.closeCurrent();
  }

  private commit(config: TlsConfig, prepared: PreparedTls, started: StartedHttps): void {
    this.current = started;
    this.prepared = prepared;
    this.applied = { ...config };
    this.stateValue = runtimeTlsState(config.mode, started.port, prepared);
    this.lastErrorValue = null;
    this.lastAttempt = tlsSignature(config);
    this.options.logger?.info('tls.listening', {
      mode: config.mode,
      bind: `${this.options.host}:${String(started.port)}`,
      hotReload: true,
    });
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    this.current = null;
    if (current !== null) await closeQuietly(current);
  }
}

/** 关监听出错不该阻断后续步骤（socket 可能已经死了） */
async function closeQuietly(server: StartedHttps): Promise<void> {
  try {
    await server.close();
  } catch {
    /* 已经关掉或从未 listen：无所谓 */
  }
}

async function tryStart(
  options: TlsRuntimeOptions,
  prepared: PreparedTls,
  config: TlsConfig,
): Promise<{ ok: true; value: StartedHttps } | { ok: false; error: string }> {
  try {
    const started = await startHttpsServer(options.handler, prepared, config.httpsPort, options.host);
    return { ok: true, value: started };
  } catch (error) {
    return { ok: false, error: describeApplyError(config, error) };
  }
}

/**
 * 把底层错误翻成"用户能照着做"的话。
 *
 * 端口占用要**点名端口**并提示怎么查占用进程 —— 需求第 2 条明确要求
 * "明确报错并提示占用进程"。只说"启动失败"会让人在证书上白找半天。
 *
 * 这里**不提"旧监听还在"**：这段文案在回滚发生之前就生成了，而回滚自己
 * 也可能失败。写死"服务未受影响"会在回滚失败时变成一句假话 ——
 * 是否保留旧监听由 `TlsApplyResult.rolledBack` 单独表达。
 */
function describeApplyError(config: TlsConfig, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/EADDRINUSE|已被占用/.test(message)) {
    return (
      `HTTPS 端口 ${String(config.httpsPort)} 已被占用，无法启用 ${config.mode} 模式。` +
      `请先确认占用该端口的进程（Windows：netstat -ano | findstr :${String(config.httpsPort)}，` +
      '再用任务管理器按 PID 查），或把 tls.httpsPort 改成别的端口。'
    );
  }
  return message;
}
