/**
 * 数据面进程（worker）：只提供 /api/*。
 *
 * 由 supervisor 拉起，也可以单独运行（`tcs-server worker`）用于调试。
 * 退出方式有两种：SIGTERM（Windows 下等价于强杀）与 supervisor 通过 IPC 发来的 shutdown 消息
 * —— 后者会先关闭 HTTP server、再关 SQLite，尽量留下干净的 WAL。
 */

import { createServer, type Server } from 'node:http';

import type { LoadedConfig } from './config.js';
import { createContext, type ServerContext } from './context.js';
import { createWorkerHandler } from './http/app.js';
import { warmUpPasswordHashing } from './auth/password.js';
import { AUDIT_RETENTION_DAYS, pruneAuditEvents } from './account/purge.js';
import { PLAINTEXT_BANNER } from './tls/server.js';
import { TlsRuntime } from './tls/runtime.js';

export interface RunningWorker {
  server: Server;
  context: ServerContext;
  url: string;
  /** HTTPS 监听（T10.5）；mode=off 时为 null */
  httpsUrl: string | null;
  /** TLS 相关告警（启动时已写日志，这里留一份供调用方展示） */
  tlsWarnings: string[];
  close(): Promise<void>;
}

export async function startWorker(loaded: LoadedConfig): Promise<RunningWorker> {
  const context = createContext(loaded, { role: 'worker' });

  // 预热密码哈希路径（T10.4 补充）。
  //
  // 不 await：预热只是"省掉首次开销"，让它跟 listen 并行即可，
  // 不该拖慢服务可用时间。若第一次登录正好撞在预热完成之前，
  // 那一次仍会有额外的 20ms —— 比完全不预热好得多，且那不是热路径。
  void warmUpPasswordHashing().catch(() => {
    /* 预热失败只影响性能，不影响正确性 */
  });

  const handler = createWorkerHandler(context);
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `API 端口 ${loaded.config.host}:${loaded.config.port} 已被占用`
            : `API 服务启动失败：${error.message}`,
        ),
      );
    });
    server.listen(loaded.config.port, loaded.config.host, () => resolve());
  });

  // ── TLS（T10.5；v0.1.3 / F4 起可热重载）──────────────────
  //
  // 在 HTTP listen **之后**启动：HTTP 是既有的、已验证的路径，
  // 先让它就绪再去碰证书 —— 证书出问题（custom 不匹配、权限不足）时，
  // 服务至少还有一个可用的 HTTP 入口能登录排查。
  // 但注意：这不等于"静默降级" —— custom 模式失败会抛错并让 worker 启动失败，
  // 只是失败前 HTTP 已经起来了，日志里能看到完整原因。
  const tlsRuntime = new TlsRuntime({
    handler,
    dataDir: loaded.config.dataDir,
    host: loaded.config.host,
  });

  const tlsWarnings: string[] = [];
  try {
    context.tls = await tlsRuntime.start(loaded.config.tls);
    tlsWarnings.push(...context.tls.warnings);

    for (const warning of context.tls.warnings) {
      context.logger.warn('tls.warning', { message: warning });
    }
    if (context.tls.fingerprint !== null) {
      context.logger.info('tls.certificate', {
        mode: context.tls.mode,
        // 指纹打出来供用户与面板核对（自签证书必须让用户能验）
        fingerprint: context.tls.fingerprint,
        subject: context.tls.subject,
        notBefore: context.tls.notBefore,
        notAfter: context.tls.notAfter,
        daysUntilExpiry: context.tls.daysUntilExpiry,
        selfSigned: context.tls.selfSigned,
      });
    }

    if (context.tls.mode === 'off') {
      // off 模式：把明文这件事喊出来。它不是一个"提醒"，而是持续存在的安全事实。
      context.logger.warn('tls.plaintext', {
        mode: 'off',
        message: PLAINTEXT_BANNER.body,
      });
    } else {
      context.logger.info('tls.listening', {
        mode: context.tls.mode,
        bind: `${loaded.config.host}:${String(context.tls.httpsPort ?? 0)}`,
        // HTTP 与 HTTPS 并存是刻意的：客户端需要一个平滑切换的双通窗口
        httpStillServing: true,
      });
    }
  } catch (error) {
    // 证书/配置有问题 → 让整个 worker 启动失败。
    // 需求第 4 条明确：custom 不匹配要拒绝启动，不静默退回 off。
    await new Promise<void>((resolve) => server.close(() => resolve()));
    context.db.close();
    throw error;
  }

  /**
   * 热重载入口（v0.1.3 / F4）。
   *
   * 由 `/api/tls/reload` 调用：supervisor 保存配置后**同步**等这个结果，
   * 才能把"已热更 / 已回滚 + 原因"如实回给面板。没有它，面板只能
   * 写"配置已保存"，而用户不知道生效没有。
   */
  context.tlsReload = async () => {
    const result = await tlsRuntime.applyFromConfigFile(loaded.path);
    context.tls = result.state;
    return { ok: result.ok, error: result.error, state: result.state };
  };

  /*
   * 配置文件兜底轮询。
   *
   * 主路径是 supervisor 保存后直接调 `/api/tls/reload`（同步、有回执）。
   * 这个 5 秒轮询只覆盖"有人只手改了 config.json"的场景 —— 那种情况下
   * 没有任何人能给回执，只能让 worker 自己发现。
   *
   * 间隔比 `LiveRegisterMode` 的按需读取宽松得多：TLS 重载要动监听器
   * （关/开 socket），顺手为之的代价远大于读一个字段。
   */
  const tlsWatchTimer = setInterval(() => {
    void tlsRuntime.applyFromConfigFile(loaded.path).then((result) => {
      if (result.changed) {
        context.tls = result.state;
        context.logger.info('tls.reload.file_watch', { mode: result.state.mode, port: result.state.httpsPort });
      }
    });
  }, 5000);
  tlsWatchTimer.unref();

  const url = `http://${loaded.config.host === '0.0.0.0' ? '127.0.0.1' : loaded.config.host}:${loaded.config.port}`;
  context.logger.info('worker.listening', {
    url,
    // 实际监听地址（审计用）：0.0.0.0 表示对局域网开放。
    // url 是「可访问地址」，两者不能混为一谈 —— 只打 url 看不出是否暴露到局域网。
    bind: `${loaded.config.host}:${loaded.config.port}`,
    exposedToLan: loaded.config.host === '0.0.0.0' || loaded.config.host === '::',
    pid: process.pid,
    dataDir: loaded.config.dataDir,
    authRequired: loaded.config.auth.require,
    tlsMode: loaded.config.tls.mode,
    httpsPort: context.tls.httpsPort,
    // 反代信任表：启动时打一行，运维不用翻配置就知道"现在按谁判定来源 IP"。
    // 空数组时必须显式说"未信任任何代理"—— 否则反代部署下会出现
    // "取令牌 403、限速全局化"这两类现象，而日志里找不到任何线索。
    trustProxy: loaded.config.trustProxy.length > 0 ? loaded.config.trustProxy : '（未信任任何代理，忽略全部代理头）',
  });

  /**
   * 回收站清理任务（F13.2）。
   *
   * 为什么用 `setInterval` + `unref()` 而不是 cron/外部调度：
   * 服务端要能在 Windows 服务、绿色包前台、测试进程三种形态下都自己跑起来，
   * 不依赖任何外部编排。`unref()` 让这个定时器**不阻止进程退出** ——
   * 否则 worker 收到 SIGTERM 后要等最长一个周期才走，服务停止会明显变慢。
   *
   * 间隔 1 小时：保留期以"天"计，分钟级精度没有意义；
   * 启动时先跑一轮，避免"服务长期不重启 → 过期数据一直不清理"。
   */
  const retentionDays = loaded.config.trash.retentionDays;
  const runTrashCleanup = (): void => {
    if (retentionDays <= 0) return;
    void context.cards
      .purgeExpired(retentionDays)
      .then((result) => {
        if (result.purged.length > 0) {
          context.logger.info('trash.cleanup', {
            retentionDays,
            scanned: result.scanned,
            purged: result.purged.length,
          });
        }
      })
      .catch((error: unknown) => {
        // 清理失败不该影响服务可用性：记一条 warn，下一轮再试
        context.logger.warn('trash.cleanup.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
  const trashTimer = setInterval(runTrashCleanup, 60 * 60 * 1000);
  trashTimer.unref();
  runTrashCleanup();

  /**
   * 审计日志保留期清理（v0.1.3 / F3，需求 3「保留 90 天」）。
   *
   * 与回收站清理同一套形态（setInterval + unref + 启动先跑一轮），但**间隔更长**：
   * 保留期以天计，6 小时一次的精度已经过分了，1 天一次也够；
   * 取 6 小时是因为它要跟着 `trash.cleanup` 的节奏走，运维看日志时两条记录挨着。
   *
   * 一个刻意不做的让步：**没有配置项**。需求把 90 天写成了硬要求，
   * 而不像回收站保留期那样是"用户可调的策略"。留一个配置口反而会让人
   * 把它调成 0（= 不清理）或 3650（= 永不清理），两种都违背这条要求。
   */
  const runAuditSweep = (): void => {
    try {
      const removed = pruneAuditEvents(context.db.handle);
      if (removed > 0) {
        context.logger.info('audit.prune', { retentionDays: AUDIT_RETENTION_DAYS, removed });
      }
    } catch (error) {
      // 与回收站清理同一条原则：清理失败不该影响服务可用性，记一条 warn 下一轮再试
      context.logger.warn('audit.prune.failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const auditTimer = setInterval(runAuditSweep, 6 * 60 * 60 * 1000);
  auditTimer.unref();
  runAuditSweep();

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(trashTimer);
    clearInterval(auditTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearInterval(tlsWatchTimer);
    await tlsRuntime.close();
    context.db.close();
    context.logger.info('worker.closed', {});
  };

  const shutdown = (reason: string): void => {
    context.logger.info('worker.shutdown', { reason });
    void close().then(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'shutdown') {
      shutdown('ipc');
    }
  });

  return {
    server,
    context,
    url,
    httpsUrl:
      context.tls.httpsPort === null
        ? null
        : `https://${loaded.config.host === '0.0.0.0' ? '127.0.0.1' : loaded.config.host}:${String(context.tls.httpsPort)}`,
    tlsWarnings,
    close,
  };
}
