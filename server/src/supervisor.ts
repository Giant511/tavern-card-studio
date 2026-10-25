/**
 * 控制面（supervisor，T5.4）：管理面板 + 服务启停 + 配置读写 + 反向代理。
 *
 * 为什么要拆成两个进程：
 *   需求要「启动 / 停止 / 重启后台服务」。如果面板所在进程就是被停止的那个进程，
 *   点「停止」之后面板再也回不来，点「启动」更是无处可点。所以：
 *
 *     supervisor（controlPort，常驻） ──spawn/stop/restart──▶ worker（port，数据面）
 *            └── /api/* 反向代理 ─────────────────────────────▶
 *
 *   面板永远由 supervisor 提供，worker 停了面板还在，才能真正把「启动」做成可用按钮。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSafeConfig,
  generateToken,
  isLoopbackHost,
  normalizeConfig,
  reachableHost,
  writeConfig,
  type LoadedConfig,
  type ServerConfigFile,
} from './config.js';
import { API_VERSION, SERVER_VERSION, configSummary } from './context.js';
import { isRegisterMode } from './config-live.js';
import { AppError, toAppError } from './errors.js';
import { writeApplicationEvent } from './eventlog.js';
import {
  checkInstallDirAtStartup,
  installDirFromExecPath,
  startInstallDirWatch,
  type InstallDirWatch,
} from './install-dir-watch.js';
import { TokenGate } from './http/auth.js';
import { methodNotAllowed, sendError, sendJson } from './http/responses.js';
import { Router, type RouteContext } from './http/router.js';
import { createLogger, type Logger } from './log.js';
import { Db } from './storage/db.js';
import { certsBackupDir, ensureSelfSigned } from './tls/certificate.js';
import { inspectTlsInputs, resolveTlsPath, tlsSecurityBanners, type TlsInputCheck } from './tls/panel.js';
import { UserStore } from './storage/users.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PANEL_PUBLIC_PATHS = ['/', '/index.html', '/app.js', '/styles.css', '/favicon.ico', '/healthz', '/api/health'];

export type WorkerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface LastExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
  expected: boolean;
}

export interface WorkerStatus {
  state: WorkerState;
  pid: number | null;
  startedAt: string | null;
  uptimeMs: number | null;
  restarts: number;
  lastExit: LastExit | null;
  lastError: string | null;
  health: Record<string, unknown> | null;
  url: string;
}

class LogRing {
  private readonly lines: string[] = [];
  private readonly max = 2000;

  constructor(private readonly file?: string) {
    if (file) mkdirSync(join(file, '..'), { recursive: true });
  }

  push(line: string): void {
    for (const part of line.split(/\r?\n/)) {
      if (part === '') continue;
      this.lines.push(part);
      if (this.lines.length > this.max) this.lines.shift();
      if (this.file) {
        try {
          appendFileSync(this.file, `${part}\n`, 'utf8');
        } catch {
          // 忽略写盘失败
        }
      }
    }
  }

  tail(count: number): string[] {
    return this.lines.slice(Math.max(0, this.lines.length - count));
  }
}

export class WorkerController {
  private child: ChildProcess | null = null;
  private state: WorkerState = 'stopped';
  private startedAtMs: number | null = null;
  private restarts = 0;
  private lastExit: LastExit | null = null;
  private lastError: string | null = null;
  private health: Record<string, unknown> | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private readonly restartBudget: number[] = [];

  constructor(
    private readonly config: ServerConfigFile,
    private readonly configPath: string,
    private readonly entry: string,
    private readonly logger: Logger,
    private readonly logs: LogRing,
  ) {}

  get url(): string {
    return `http://${reachableHost(this.config.host)}:${this.config.port}`;
  }

  status(): WorkerStatus {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAtMs === null ? null : new Date(this.startedAtMs).toISOString(),
      uptimeMs: this.startedAtMs === null ? null : Date.now() - this.startedAtMs,
      restarts: this.restarts,
      lastExit: this.lastExit,
      lastError: this.lastError,
      health: this.health,
      url: this.url,
    };
  }

  async start(): Promise<WorkerStatus> {
    if (this.child) return this.status();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopRequested = false;
    this.lastError = null;
    this.state = 'starting';

    const args = [this.entry, 'worker', '--config', this.configPath];
    this.logger.info('supervisor.worker.spawn', { port: this.config.port, args });
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, TCS_ROLE: 'worker' },
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.logs.push(chunk));
    child.stderr?.on('data', (chunk: string) => this.logs.push(chunk));

    child.on('spawn', () => {
      this.state = 'running';
      this.startedAtMs = Date.now();
      this.logger.info('supervisor.worker.started', { pid: child.pid });
    });

    child.on('error', (error) => {
      this.lastError = error.message;
      this.state = 'crashed';
      this.logger.error('supervisor.worker.error', { message: error.message });
    });

    child.on('exit', (code, signal) => {
      const expected = this.stopRequested;
      this.lastExit = { code, signal, at: new Date().toISOString(), expected };
      this.child = null;
      this.startedAtMs = null;
      this.health = null;
      if (expected) {
        this.state = 'stopped';
        this.logger.info('supervisor.worker.stopped', { code, signal });
      } else {
        this.state = 'crashed';
        this.logger.error('supervisor.worker.exited', { code, signal });
        this.scheduleRestart();
      }
    });

    this.startHealthPolling();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    return this.status();
  }

  async stop(): Promise<WorkerStatus> {
    if (!this.child) {
      this.state = 'stopped';
      return this.status();
    }
    this.stopRequested = true;
    this.state = 'stopping';
    const child = this.child;

    const exited = new Promise<void>((resolvePromise) => {
      child.once('exit', () => resolvePromise());
    });

    try {
      child.send?.({ type: 'shutdown' });
    } catch {
      // IPC 不可用时直接走信号
    }

    const timeout = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5000));
    await Promise.race([exited, timeout]);
    if (this.child === child) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 2000))]);
    }
    if (this.child === child) {
      child.kill('SIGKILL');
    }
    return this.status();
  }

  async restart(): Promise<WorkerStatus> {
    await this.stop();
    return this.start();
  }

  stopPolling(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private scheduleRestart(): void {
    const now = Date.now();
    while (this.restartBudget.length > 0 && now - this.restartBudget[0]! > 60_000) this.restartBudget.shift();
    if (this.restartBudget.length >= 3) {
      this.lastError = '1 分钟内连续崩溃 3 次，已停止自动拉起；请查看日志后手动启动';
      this.logger.error('supervisor.worker.crashloop', {});
      return;
    }
    this.restartBudget.push(now);
    this.restarts += 1;
    this.logger.warn('supervisor.worker.autorestart', { delayMs: 2500 });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.child && !this.stopRequested) void this.start();
    }, 2500);
  }

  private startHealthPolling(): void {
    if (this.healthTimer) return;
    const poll = async (): Promise<void> => {
      if (!this.child) {
        this.health = null;
        return;
      }
      try {
        const response = await fetch(`${this.url}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        this.health = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
      } catch {
        this.health = null;
      }
    };
    void poll();
    this.healthTimer = setInterval(() => void poll(), 3000);
    this.healthTimer.unref?.();
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res: ServerResponse, pathname: string): boolean {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(PUBLIC_DIR, normalize(relative));
  if (!target.startsWith(resolve(PUBLIC_DIR)) || !existsSync(target) || !statSync(target).isFile()) {
    return false;
  }
  const headers = {
    'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': String(statSync(target).size),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
  return true;
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen(port, host, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export interface SupervisorOptions {
  entry: string;
  autoStartWorker?: boolean;
}

export interface RunningSupervisor {
  server: Server;
  controller: WorkerController;
  url: string;
  close(): Promise<void>;
}

export async function startSupervisor(loaded: LoadedConfig, options: SupervisorOptions): Promise<RunningSupervisor> {
  const config = loaded.config;
  const logger = createLogger({ level: config.logLevel, logDir: join(config.dataDir, 'logs'), role: 'supervisor' });
  const workerLogs = new LogRing(join(config.dataDir, 'logs', 'worker.out.log'));
  const controller = new WorkerController(config, loaded.path, options.entry, logger, workerLogs);
  const startedAt = Date.now();

  const gate = (): TokenGate => {
    if (gateInstance === null)
      gateInstance = new TokenGate(config.auth.token, PANEL_PUBLIC_PATHS, config.auth.require);
    return gateInstance;
  };
  let gateInstance: TokenGate | null = null;
  const router = new Router();

  router.get('/healthz', (_ctx) => {
    sendJson(_ctx.res, 200, { status: 'ok', role: 'supervisor', pid: process.pid, worker: controller.status().state });
  });

  router.get('/control/status', (_ctx) => {
    const worker = controller.status();
    sendJson(_ctx.res, 200, {
      role: 'supervisor',
      version: SERVER_VERSION,
      apiVersion: API_VERSION,
      pid: process.pid,
      node: process.version,
      startedAt: new Date(startedAt).toISOString(),
      uptimeMs: Date.now() - startedAt,
      worker,
      config: configSummary(config),
      paths: {
        dataDir: config.dataDir,
        configFile: loaded.path,
        logFile: join(config.dataDir, 'logs', 'server.log'),
        workerLogFile: join(config.dataDir, 'logs', 'worker.out.log'),
      },
      urls: {
        panel: `http://${reachableHost(config.controlHost)}:${config.controlPort}/`,
        api: controller.url,
      },
    });
  });

  router.post('/control/service/:action', async (_ctx) => {
    const action = _ctx.params['action'];
    if (action === 'start') {
      const status = await controller.start();
      sendJson(_ctx.res, 200, { action, worker: status });
      return;
    }
    if (action === 'stop') {
      const status = await controller.stop();
      sendJson(_ctx.res, 200, { action, worker: status });
      return;
    }
    if (action === 'restart') {
      const status = await controller.restart();
      sendJson(_ctx.res, 200, { action, worker: status });
      return;
    }
    throw new AppError(400, 'BAD_REQUEST', `未知的服务操作：${String(action)}（可用 start / stop / restart）`);
  });

  router.get('/control/config', (_ctx) => {
    sendJson(_ctx.res, 200, { config: configSummary(config) });
  });

  /** 面板「显示令牌」：只有拿到有效 token 的调用者才能读到它（本机管理场景） */
  router.post('/control/token/reveal', (_ctx) => {
    sendJson(_ctx.res, 200, { token: config.auth.token });
  });

  /**
   * 最近注册的账户（F12 第 3 条：让管理员对"开放注册"有可视性）。
   *
   * 为什么读库而不是问 worker：worker 可能已经停了（面板的「停止」按钮真的会停它），
   * 而这种"谁在什么时候注册进来"的信息不该因为数据面停摆就看不到。
   * 这里直接以只读方式打开 state.db —— WAL 允许多进程并发读。
   *
   * 只返回运营需要的字段，**不含** password_hash / jwt 相关任何东西。
   */
  router.get('/control/accounts', (_ctx) => {
    const raw = Number(_ctx.query.get('limit') ?? 20);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 20;
    const items = withUsers(config.dataDir, (users) =>
      users
        .list()
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          username: row.username,
          /*
           * uid 必须返回（v0.1.3 / F3 补）。
           *
           * 治理页的账户表有 uid 一列，前端写的是 `item.uid || '—'` ——
           * 而这里一直没返回它，于是那一列**永远是"—"**，看起来像"老账户没有 uid"。
           * 治理页要靠 uid 辨认人（用户名可改），注销审计里也以 uid 为准，
           * 所以这一列必须真的有值。
           */
          uid: row.uid,
          role: row.role,
          status: row.status,
          createdAt: row.created_at,
          lastLoginAt: row.last_login_at,
        })),
    );
    sendJson(_ctx.res, 200, { items, registerMode: config.auth.registerMode });
  });

  /**
   * 启用 / 禁用账户（F12 第 3 条的「一键禁用」）。
   *
   * 复用 `UserStore.setStatus` 而不是自己写 UPDATE：那里有「不能禁用最后一个
   * 管理员」的保护，绕过它等于把自己锁在门外。
   */
  router.post('/control/accounts/:id/status', async (_ctx) => {
    const body = JSON.parse(_ctx.body.toString('utf8') || '{}') as Record<string, unknown>;
    const status = body['status'];
    if (status !== 'active' && status !== 'disabled') {
      throw new AppError(400, 'BAD_REQUEST', 'status 只能是 active 或 disabled');
    }
    const id = _ctx.params['id'] ?? '';
    try {
      const updated = withUsers(config.dataDir, (users) => {
        users.setStatus(id, status);
        const row = users.findById(id);
        return row === null ? null : { id: row.id, username: row.username, status: row.status };
      });
      if (updated === null) throw new AppError(404, 'NOT_FOUND', '账户不存在');
      logger.info('supervisor.account.status', { id, status });
      sendJson(_ctx.res, 200, { account: updated });
    } catch (error) {
      if (error instanceof AppError) throw error;
      // 「最后一个管理员」这类业务规则不是程序崩溃，回 400 并把话原样带出去
      throw new AppError(400, 'BAD_REQUEST', (error as Error).message);
    }
  });

  /**
   * 传输安全状态（v0.1.3 / F4 需求第 1 条最后一项）。
   *
   * 三件事必须一起给，否则面板只能各猜一半：
   *   ① **配置**（用户想用什么）—— mode / httpsPort / 证书路径；
   *   ② **运行时**（实际在用什么）—— 来自 worker 的 `/api/stats`，含指纹与剩余天数；
   *   ③ **采样时间**—— 需求明确要求"标注数据来源时间"。
   *
   * 为什么要有采样时间：面板是**快照式**的，用户可能开着页面去改配置文件、
   * 去点重启，回来看到的还是十分钟前的状态。没有时间戳，"HTTPS 未监听"
   * 到底是"现在没监听"还是"十分钟前没监听"分不清。
   *
   * 证书路径**在这里下发全路径**（`configSummary` 不下发）：控制面只有持令牌的
   * 管理员能访问，而 `/api/stats` 会把配置下发给任何已鉴权客户端。
   */
  router.get('/control/tls/status', async (_ctx) => {
    const sampledAt = new Date().toISOString();
    const stats = await fetchWorkerStats(config);
    const runtime = (stats?.['tls'] ?? null) as Record<string, unknown> | null;

    const httpsPort = typeof runtime?.['httpsPort'] === 'number' ? (runtime['httpsPort'] as number) : null;
    const days = typeof runtime?.['daysUntilExpiry'] === 'number' ? (runtime['daysUntilExpiry'] as number) : null;
    const notAfter = typeof runtime?.['notAfter'] === 'string' ? (runtime['notAfter'] as string) : null;

    sendJson(_ctx.res, 200, {
      sampledAt,
      /** 数据来源，面板原样显示（需求要"标注数据来源"） */
      source: stats === null ? 'none' : 'GET /api/stats',
      workerRunning: stats !== null,
      config: {
        mode: config.tls.mode,
        httpsPort: config.tls.httpsPort,
        certPath: config.tls.certPath,
        keyPath: config.tls.keyPath,
        // 解析后的绝对路径：面板回显"实际读的是哪个文件"，避免相对路径歧义
        resolvedCertPath: resolveTlsPath(config.dataDir, config.tls.certPath),
        resolvedKeyPath: resolveTlsPath(config.dataDir, config.tls.keyPath),
        /** 重新生成时旧证书的去处（面板要写清楚，用户才知道去哪找回） */
        backupDir: certsBackupDir(config.dataDir),
        dataDir: config.dataDir,
        /** API 监听地址：决定"off 模式是否算公网暴露" */
        host: config.host,
      },
      runtime,
      listening: {
        // worker 能应答 stats 就说明 HTTP 在监听；否则状态未知（null ≠ 没监听）
        http: stats === null ? null : { host: config.host, port: config.port },
        https: httpsPort === null ? null : { host: config.host, port: httpsPort },
      },
      banners: tlsSecurityBanners({
        mode: config.tls.mode,
        host: config.host,
        httpsPort,
        expiry: days !== null && notAfter !== null ? { daysUntilExpiry: days, notAfter } : null,
        extra: [],
      }),
      note:
        stats === null
          ? '数据面（worker）未运行：HTTPS 监听状态未知。此时保存的传输安全配置会在下次启动时生效。'
          : null,
    });
  });

  /**
   * custom 模式的即时校验（需求第 1 条：存在性检查 + 公私钥匹配，即时显示结果）。
   *
   * 只**检查**不写盘，所以可以随便调（面板在输入框里 debounce 调用）。
   * 保存时 `PUT /control/config` 会用同一段实现再拦一次 —— 前端禁用按钮是
   * UX，服务端拒绝才是判据；只做前者等于把安全交给浏览器。
   */
  router.post('/control/tls/inspect', async (_ctx) => {
    const body = JSON.parse(_ctx.body.toString('utf8') || '{}') as Record<string, unknown>;
    const rawMode = body['mode'];
    const mode =
      rawMode === 'off' || rawMode === 'selfsigned' || rawMode === 'custom' ? rawMode : config.tls.mode;
    const certPath = typeof body['certPath'] === 'string' ? body['certPath'] : config.tls.certPath;
    const keyPath = typeof body['keyPath'] === 'string' ? body['keyPath'] : config.tls.keyPath;

    let check: TlsInputCheck;
    try {
      check = await inspectTlsInputs({ mode, dataDir: config.dataDir, certPath, keyPath });
    } catch (error) {
      // inspectTlsInputs 已把常见问题转成 problems；走到这里说明是意外错误
      // （比如权限不足读不了文件），如实报出来而不是 500 一片空白
      throw new AppError(400, 'TLS_CERT_INVALID', `检查证书失败：${(error as Error).message}`);
    }
    sendJson(_ctx.res, 200, check);
  });

  /**
   * 重新生成自签证书（需求第 1 条：selfsigned 的「重新生成」按钮）。
   *
   * 旧证书会被 `ensureSelfSigned` 移到 `data/certs-backup/<时间戳>-server.crt`。
   * 生成完**立刻触发一次热更**：否则面板显示新指纹、实际监听还在用旧证书，
   * 用户拿面板上的指纹去核对客户端会得出"证书不对"的错误结论。
   */
  router.post('/control/tls/regenerate', async (_ctx) => {
    let result: Awaited<ReturnType<typeof ensureSelfSigned>>;
    try {
      result = await ensureSelfSigned({
        dataDir: config.dataDir,
        force: true,
        commonName: 'Tavern Card Studio Server',
      });
    } catch (error) {
      /*
       * 面板只该看到**结构化原因**，不该看到 `Command failed: icacls …` 这种
       * 原始 exec 消息 —— 它带着内部路径，而且 stderr 按控制台代码页编码、
       * 经 Node 按 UTF-8 解码后就是一堆 ◆。真机事故里用户截图里那些 ◆ 正是它。
       * 完整错误进日志，面板拿一句话。
       */
      logger.error('supervisor.tls.regenerate_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw new AppError(
        500,
        'TLS_REGENERATE_FAILED',
        `生成自签证书失败：${sanitizeTlsError(error)}`,
        { hint: '完整原因已写入服务端日志（logs 目录）；证书与私钥仍是上一份，HTTPS 未受影响。' },
      );
    }

    /*
     * ACL 收紧失败的降级处理（v0.1.3 真机事故）。
     *
     * 证书已经可用，所以这里是 **warn 而不是 error**：
     * 日志 + 应用事件日志各留一条，面板回执里也带出去。
     * 需求明确：ACL 是纵深防御，不是门禁，不能因为它让证书功能不可用。
     */
    for (const problem of result.aclProblems) {
      logger.warn('tls.acl.warn', { message: problem });
      try {
        writeApplicationEvent(`TavernCardStudio: 私钥 ACL 未能收紧（${problem.slice(0, 120)}）`);
      } catch {
        // 事件日志不可用（非 Windows / 无权限）不该反过来影响主流程
      }
    }

    let reload: { attempted: boolean; ok: boolean; error: string | null } = {
      attempted: false,
      ok: false,
      error: null,
    };
    if (config.tls.mode === 'selfsigned') {
      const reply = await callWorkerTlsReload(config);
      reload = { attempted: true, ok: reply.ok, error: reply.error };
    }

    logger.info('supervisor.tls.regenerated', {
      fingerprint: result.info.fingerprint,
      notAfter: result.info.notAfter,
      backupPath: result.backupPath,
      reloaded: reload.ok,
      aclWarnings: result.aclProblems.length,
    });

    sendJson(_ctx.res, 200, {
      info: result.info,
      /** 旧证书备份到哪（null = 之前没有证书，也就没有备份） */
      backupPath: result.backupPath,
      backupDir: certsBackupDir(config.dataDir),
      reload,
      /** ACL 未能收紧的原因（空数组 = 一切正常）；面板据此显示黄色提示 */
      warnings: result.aclProblems,
      note:
        config.tls.mode === 'selfsigned'
          ? reload.ok
            ? '已重新生成并热更：客户端下次连接会看到新的证书指纹'
            : `新证书已生成，但热更失败：${reload.error ?? ''}`
          : '当前不是 selfsigned 模式，新证书会在切换到该模式时生效',
    });
  });

  router.put('/control/config', async (_ctx) => {
    const patch = JSON.parse(_ctx.body.toString('utf8') || '{}') as Record<string, unknown>;
    let candidate: ServerConfigFile;
    try {
      candidate = applyConfigPatch(config, patch);
      assertSafeConfig(candidate);
    } catch (error) {
      throw new AppError(400, 'BAD_REQUEST', (error as Error).message);
    }

    /*
     * ── 传输安全的前置拦截（v0.1.3 / F4 需求第 1 条尾部）───────────
     *
     * custom 模式在写盘**之前**就校验证书：存在性 + 公私钥匹配。
     * 需求明确"不匹配禁止保存并回显原因 —— 与拒绝启动语义对齐"。
     *
     * 为什么不能"先存再靠热更报错"：那样配置里就留了一份起不来的 tls 段，
     * 下次重启服务直接死在启动路径上；而用户看到的是"保存成功了"，
     * 直到重启才发现。前置拦截把这件事变成一次可读的拒绝。
     */
    if (candidate.tls.mode === 'custom') {
      const check = await inspectTlsInputs({
        mode: 'custom',
        dataDir: candidate.dataDir,
        certPath: candidate.tls.certPath,
        keyPath: candidate.tls.keyPath,
      });
      if (!check.canSave) {
        throw new AppError(400, 'TLS_CERT_INVALID', `自定义证书不可用：${check.message}`, {
          problems: check.problems,
          certPath: check.certPath,
          keyPath: check.keyPath,
          hint: '证书与私钥必须是同一对（PEM）；服务端不会因为证书不匹配而退回明文模式。',
        });
      }
    }

    candidate.updatedAt = new Date().toISOString();

    const previousTls = { ...config.tls };
    const tlsChanged =
      candidate.tls.mode !== config.tls.mode ||
      candidate.tls.httpsPort !== config.tls.httpsPort ||
      candidate.tls.certPath !== config.tls.certPath ||
      candidate.tls.keyPath !== config.tls.keyPath;

    writeConfig(loaded.path, candidate);

    const workerRestartRequired =
      candidate.port !== config.port ||
      candidate.host !== config.host ||
      candidate.dataDir !== config.dataDir ||
      candidate.rulesDir !== config.rulesDir ||
      candidate.defaultPlatformRule !== config.defaultPlatformRule ||
      candidate.defaultPreset !== config.defaultPreset ||
      candidate.maxUploadBytes !== config.maxUploadBytes ||
      candidate.logLevel !== config.logLevel;
    // 管理面板（控制面）绑定的是 controlHost，不是 host。
    // 早先面板与 API 共用 host，所以这里必须比 host；拆开之后只需比 controlHost，
    // 否则「只改 API 地址」会误触发一次面板重启（面板重启会中断正在进行的操作）。
    const supervisorRestartRequired = candidate.controlPort !== config.controlPort ||
      candidate.controlHost !== config.controlHost;

    Object.assign(config, candidate);
    loaded.config = candidate;
    logger.info('supervisor.config.updated', { workerRestartRequired, supervisorRestartRequired });

    // 端口 / 数据目录等影响进程启动的参数：立即重启 worker，避免「配置已改、代理指向新端口但旧进程还在旧端口」的错位
    let restarted = false;
    if (workerRestartRequired) {
      try {
        await controller.restart();
        restarted = true;
      } catch (error) {
        logger.error('supervisor.config.restart_failed', { message: (error as Error).message });
      }
    }

    /*
     * ── TLS 热更（v0.1.3 / F4 需求第 2 条）───────────────────────
     *
     * 只在"进程级参数没变"时才走热更：worker 已经因为端口/目录变化重启的话，
     * 新进程启动时自然按新配置装配 TLS，再调一次重载是多余动作
     * （而且会和刚起来的监听抢同一个端口）。
     */
    let tlsReload: { attempted: boolean; ok: boolean; rolledBack: boolean; error: string | null } = {
      attempted: false,
      ok: false,
      rolledBack: false,
      error: null,
    };

    if (tlsChanged && !workerRestartRequired) {
      const reply = await callWorkerTlsReload(candidate);
      tlsReload = {
        attempted: true,
        ok: reply.ok,
        rolledBack: reply.reachable && !reply.ok,
        error: reply.error,
      };

      if (!reply.reachable) {
        /*
         * worker 没在跑：配置本身没问题，只是没人执行热更。
         * **不回滚**：下次启动会按新配置装配，回滚反而会让用户的修改凭空消失。
         */
        logger.warn('supervisor.tls.reload_unreachable', { message: reply.error });
        tlsReload.ok = false;
        tlsReload.rolledBack = false;
      } else if (!reply.ok) {
        /*
         * 热更失败（端口占用 / 证书不匹配）：
         *   ① worker 内部已经把**监听**回滚到旧配置（runtime.ts 负责）；
         *   ② 这里再把**配置文件**回滚 —— 否则这份起不来的 tls 段会留在盘上，
         *      下次重启服务直接死在启动路径，而用户以为"保存失败了，什么都没变"。
         *
         * 顺序很重要：先写回旧配置，再让 worker 重新读一次。
         * 反过来的话 worker 会先读到坏配置又失败一次。
         */
        const rolledBackCandidate: ServerConfigFile = { ...candidate, tls: previousTls };
        writeConfig(loaded.path, rolledBackCandidate);
        Object.assign(config, rolledBackCandidate);
        loaded.config = rolledBackCandidate;
        // 旧配置与 worker 当前生效的一致 → 这一步是空操作，只是让状态回正
        await callWorkerTlsReload(rolledBackCandidate);
        logger.error('supervisor.tls.reload_failed', {
          message: reply.error,
          rolledBackTo: previousTls.mode,
        });
        throw new AppError(
          409,
          'TLS_RELOAD_FAILED',
          `传输安全设置未生效，已回滚到 ${previousTls.mode} 模式：${reply.error ?? '热更失败'}`,
          {
            rolledBack: true,
            previousMode: previousTls.mode,
            hint:
              '配置已恢复为修改前的值，服务仍在按旧设置运行。' +
              '请修正原因（端口被占用 / 证书与私钥不匹配 / 文件不可读）后重新保存。',
          },
        );
      }
    }

    sendJson(_ctx.res, 200, {
      config: configSummary(candidate),
      workerRestartRequired,
      supervisorRestartRequired,
      restarted,
      tlsReload,
      note: supervisorRestartRequired
        ? '控制面端口修改需要重启 supervisor（Windows 服务：sc.exe stop/start <服务名>）'
        : workerRestartRequired
          ? restarted
            ? '数据面已按新配置重启'
            : '配置已保存，但自动重启失败；请查看日志后手动点「重启」'
          : tlsReload.attempted && tlsReload.ok
            ? '已热更：HTTPS 监听已按新配置重建，服务进程未重启'
            : tlsReload.attempted && !tlsReload.ok && !tlsReload.rolledBack
              ? '配置已保存；数据面未运行，将在下次启动时生效'
              : '已生效',
    });
  });

  router.post('/control/token/rotate', async (_ctx) => {
    const token = generateToken();
    const candidate = { ...config, auth: { ...config.auth, token, require: true }, updatedAt: new Date().toISOString() };
    assertSafeConfig(candidate);
    writeConfig(loaded.path, candidate);
    Object.assign(config, candidate);
    gateInstance = null;
    logger.warn('supervisor.token.rotated', {});
    await controller.restart();
    sendJson(_ctx.res, 200, {
      token,
      worker: controller.status(),
      note: '旧 token 立即失效；请把新 token 填进客户端设置。此值只显示这一次。',
    });
  });

  router.get('/control/logs', (_ctx) => {
    const lines = Math.min(2000, Math.max(1, Number.parseInt(_ctx.query.get('lines') ?? '300', 10) || 300));
    sendJson(_ctx.res, 200, {
      worker: workerLogs.tail(lines),
      note: 'worker 的 stdout/stderr（supervisor 捕获）；完整日志见 paths.logFile',
    });
  });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    let pathname = '/';
    try {
      const host = req.headers.host ?? `${config.controlHost}:${config.controlPort}`;
      const url = new URL(req.url ?? '/', `http://${host}`);
      pathname = url.pathname;

      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        // 数据面没在跑就直接 503，不去连一个必然失败的端口（也避免代理层出现未捕获的流错误）
        const workerState = controller.status().state;
        if (workerState !== 'running') {
          sendJson(res, 503, {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: '数据面服务未运行',
              details: { state: workerState, hint: '在管理面板点「启动」，或检查端口是否被占用' },
            },
          });
          return;
        }
        // API 代理：鉴权交给 worker（token 原样透传），supervisor 不做二次判断
        proxy(req, res, config, controller.url);
        return;
      }

      if (pathname.startsWith('/control/') || pathname === '/healthz') {
        gate().check(req, pathname);
        const match = router.match(method, pathname);
        if (!match) {
          const allowed = router.allowedMethods(pathname);
          if (allowed.length > 0) {
            methodNotAllowed(res, allowed);
            return;
          }
          throw new AppError(404, 'NOT_FOUND', `没有这个控制接口：${method} ${pathname}`);
        }
        const body =
          method === 'POST' || method === 'PUT'
            ? await new Promise<Buffer>((resolvePromise, rejectPromise) => {
                const chunks: Buffer[] = [];
                req.on('data', (chunk: Buffer) => chunks.push(chunk));
                req.on('end', () => resolvePromise(Buffer.concat(chunks)));
                req.on('error', rejectPromise);
              })
            : Buffer.alloc(0);
        const context: RouteContext = {
          req,
          res,
          url,
          method,
          path: pathname,
          params: match.params,
          query: url.searchParams,
          body,
        };
        await match.handler(context);
        return;
      }

      if (serveStatic(res, pathname)) return;
      if (!serveStatic(res, '/index.html')) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('管理面板资源缺失：server/public 未随安装包分发');
      }
    } catch (error) {
      if (!res.headersSent) sendError(res, toAppError(error));
      else res.end();
    } finally {
      logger.debug('supervisor.request', { method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    }
  };

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    void handler(req, res);
  });

  if (!(await isPortFree(config.controlPort, config.controlHost))) {
    throw new Error(`控制面端口 ${config.controlHost}:${config.controlPort} 已被占用`);
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      rejectPromise(
        new Error(
          error.code === 'EADDRINUSE'
            ? `控制面端口 ${config.controlHost}:${config.controlPort} 已被占用`
            : `控制面启动失败：${error.message}`,
        ),
      );
    });
    server.listen(config.controlPort, config.controlHost, () => resolvePromise());
  });

  logger.info('supervisor.listening', {
    // panel 是「给人在浏览器里打开的地址」，bind 才是「实际监听的地址」。
    // F7.4 要求日志能用于审计，所以两者都要打：
    //   bind=127.0.0.1 说明面板只在本机，局域网连不上；
    //   bind=0.0.0.0   说明面板对局域网开放（面板静态资源免鉴权，需要警惕）。
    // 只打 panel 会被误读 —— 监听得是 0.0.0.0 时 panel 仍显示 127.0.0.1。
    panel: `http://${reachableHost(config.controlHost)}:${config.controlPort}/`,
    bind: `${config.controlHost}:${config.controlPort}`,
    panelLoopbackOnly: isLoopbackHost(config.controlHost),
    api: controller.url,
    pid: process.pid,
  });

  if (options.autoStartWorker !== false) {
    await controller.start();
  }

  // 运行期写安装目录自检（F14.3 / T10.24）。
  //
  // 挂在 supervisor 而不是 worker：supervisor 是服务启动的那个进程（WinSW 的
  // arguments 是 `index.js serve`），生命周期最长；而且它做的是**快照比对**，
  // 看见的是文件系统的结果 —— worker 子进程往安装目录写的东西同样会出现在
  // 它的快照里，不需要在子进程里再装一份（装两份只会让同一条告警打两遍）。
  //
  // 任何异常都不能影响启动：这里是诊断，不是门卫。
  let installDirWatch: InstallDirWatch | null = null;
  if (config.installDirWriteCheck) {
    try {
      const installDir = installDirFromExecPath();
      const issues = checkInstallDirAtStartup({ installDir, dataDir: config.dataDir });
      for (const issue of issues) {
        logger.warn('installDir.writeDetected', {
          kind: issue.kind,
          path: issue.path,
          detail: issue.detail,
          hint: issue.hint,
        });
        try {
          writeApplicationEvent(`install-dir check: ${issue.detail}`);
        } catch {
          // eventcreate 需要管理员；没写进去只意味着少一条线索
        }
      }
      if (issues.length === 0) {
        logger.debug('installDir.checkOk', { installDir });
      }
      installDirWatch = startInstallDirWatch({
        installDir,
        allow: config.installDirWriteAllow,
        onIssue: (issue) => {
          logger.warn('installDir.writeDetected', {
            kind: issue.kind,
            path: issue.path,
            detail: issue.detail,
            hint: issue.hint,
          });
        },
      });
    } catch (error) {
      // 连安装目录都读不到（权限/路径异常）时不该拦着服务起来
      logger.warn('installDir.checkFailed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    installDirWatch?.stop();
    controller.stopPolling();
    await controller.stop();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    logger.info('supervisor.closed', {});
  };

  const shutdown = (reason: string): void => {
    logger.info('supervisor.shutdown', { reason });
    void close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return {
    server,
    controller,
    url: `http://${reachableHost(config.controlHost)}:${config.controlPort}`,
    close,
  };
}

function proxy(req: IncomingMessage, res: ServerResponse, config: ServerConfigFile, workerUrl: string): void {
  const target = new URL(workerUrl);
  let finished = false;

  const fail = (error: Error): void => {
    if (finished) return;
    finished = true;
    if (!res.headersSent) {
      sendJson(res, 503, {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: '数据面服务未运行',
          details: {
            reason: error.message,
            hint: '在管理面板点「启动」，或检查端口是否被占用',
            api: config.port,
          },
        },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  };

  const upstream = httpRequest(
    {
      host: target.hostname,
      port: Number(target.port),
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${target.hostname}:${target.port}` },
    },
    (upstreamRes) => {
      finished = true;
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );

  upstream.on('error', (error) => fail(error));
  req.on('error', () => {
    upstream.destroy();
    fail(new Error('客户端连接中断'));
  });
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });

  // GET/HEAD 没有请求体，直接 end；避免把已结束的请求流 pipe 到出错的上游导致未捕获异常
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
}

/** 只允许面板修改已知字段；其余字段忽略（避免手滑写坏配置） */
/**
 * 以只读方式短开一个库连接执行一次查询。
 *
 * 每次请求都开/关，不做常驻连接：面板这些操作是人工点击级别的频率（一次几毫秒），
 * 常驻连接反而要处理"库被替换/迁移"的生命周期。`Db` 构造会跑 schema 迁移，
 * 对已存在的库是幂等的。
 */
function withUsers<T>(dataDir: string, run: (users: UserStore) => T): T {
  const db = new Db(join(dataDir, 'state.db'));
  try {
    return run(new UserStore(db.handle));
  } finally {
    db.close();
  }
}

/**
 * 把内部错误翻成面板能看的一句话。
 *
 * 两条硬要求（真机事故后加的）：
 *   · 去掉 `Command failed:` 这类 exec 包装前缀 —— 它只说明"跑了个命令"；
 *   · 抹掉 `C:\…` / `D:\…` 绝对路径 —— 面板可能被远程访问，内部路径不该出现在
 *     错误框里；而且用户拿路径也没法处理。
 *
 * 完整错误（含 stderr）一律进日志，不进界面。
 */
function sanitizeTlsError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine
    .replace(/^Command failed:\s*/i, '')
    .replace(/[A-Za-z]:\\[^\s'"]+/g, '<路径>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? '未知错误（详见服务端日志）' : cleaned.slice(0, 180);
}

/**
 * worker（数据面）的可访问基址。
 *
 * 必须用 `reachableHost`：配置里 `host=0.0.0.0` 是**监听**地址，
 * 拿它拼 URL 在部分平台会连不上；`::` 还必须要方括号。
 */
function workerBaseUrl(config: ServerConfigFile): string {
  return `http://${reachableHost(config.host)}:${String(config.port)}`;
}

/** 读 worker 的 `/api/stats`；worker 没起来或鉴权失败都返回 null（调用方按"状态未知"处理） */
async function fetchWorkerStats(config: ServerConfigFile): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`${workerBaseUrl(config)}/api/stats`, {
      headers: config.auth.token === '' ? {} : { Authorization: `Bearer ${config.auth.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface WorkerTlsReply {
  /** worker 是否应答了（false = 没在跑 / 连不上） */
  reachable: boolean;
  ok: boolean;
  error: string | null;
}

/**
 * 让 worker 重载 TLS。
 *
 * `reachable=false` 与 `reachable=true, ok=false` 必须分开：
 *   · 前者是"没人接收这次热更"（worker 停着）—— 配置该保留，等启动生效；
 *   · 后者是"试过了但失败"（端口占用 / 证书不匹配）—— 配置该回滚。
 * 混成一种会把"服务没开"当成"配置有错"，用户改半天也改不好。
 */
async function callWorkerTlsReload(config: ServerConfigFile): Promise<WorkerTlsReply> {
  try {
    const response = await fetch(`${workerBaseUrl(config)}/api/tls/reload`, {
      method: 'POST',
      headers: config.auth.token === '' ? {} : { Authorization: `Bearer ${config.auth.token}` },
      // 热更要读证书、关开监听，给足时间（但也不能无限等：面板在同步等这个结果）
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown };
    return {
      reachable: true,
      ok: response.ok && body.ok === true,
      error: typeof body.error === 'string' && body.error !== '' ? body.error : null,
    };
  } catch (error) {
    return {
      reachable: false,
      ok: false,
      error: `数据面（worker）没有应答：${(error as Error).message}`,
    };
  }
}

export function applyConfigPatch(current: ServerConfigFile, patch: Record<string, unknown>): ServerConfigFile {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

  const service = (patch['service'] ?? {}) as Record<string, unknown>;
  const auth = (patch['auth'] ?? {}) as Record<string, unknown>;
  const tls = (patch['tls'] ?? {}) as Record<string, unknown>;

  /*
   * TLS 四字段（v0.1.3 / F4）。
   *
   * 语义与 trustProxy 一致：**字段缺席＝保持原值**。这一点对本批特别关键 ——
   * 面板的「传输安全」在 off / selfsigned 模式下不发 certPath / keyPath（那两个
   * 输入框是隐藏的），若按"缺席即清空"处理，用户从 custom 切到 selfsigned
   * 再切回 custom 时路径就没了；更糟的是"只改 httpsPort"的一次保存会把
   * 用户配好的证书路径一起抹掉。
   *
   * `mode` 不合法时保持原值而**不回落 off**：这是安全开关，一个拼写错误
   * 把 HTTPS 关掉，是这个模块最不该发生的事。
   */
  const tlsMode = ['off', 'selfsigned', 'custom'].includes(String(tls['mode']))
    ? (tls['mode'] as ServerConfigFile['tls']['mode'])
    : current.tls.mode;

  return normalizeConfig(
    {
      ...current,
      port: num(patch['port'], current.port),
      controlPort: num(patch['controlPort'], current.controlPort),
      host: str(patch['host'], current.host),
      // 面板地址独立可改：留空/未传则保持原值（不是回退到 DEFAULT_CONTROL_HOST，
      // 否则面板里某次只改 API 地址的保存会把用户特意设过的面板地址重置掉）。
      controlHost: str(patch['controlHost'], current.controlHost),
      dataDir: str(patch['dataDir'], current.dataDir),
      rulesDir: str(patch['rulesDir'], current.rulesDir),
      defaultPlatformRule: str(patch['defaultPlatformRule'], current.defaultPlatformRule),
      defaultPreset: str(patch['defaultPreset'], current.defaultPreset),
      maxUploadBytes: num(patch['maxUploadBytes'], current.maxUploadBytes),
      logLevel: ['debug', 'info', 'warn', 'error'].includes(String(patch['logLevel']))
        ? patch['logLevel']
        : current.logLevel,
      // trustProxy 必须**显式**下发才改：`null` 表示"清空"（用户确实想关掉），
      // 字段缺席则保持原值。若像其它字段那样"缺席即保持"，面板上就没法清空了。
      trustProxy: parseTrustProxyPatch(patch, current.trustProxy),
      auth: {
        ...current.auth,
        require: bool(auth['require'], current.auth.require),
        // 注册策略（F12）。与 trustProxy 同样的语义：字段缺席＝保持原值，
        // 值不合法同样保持原值 —— 面板传错不该把策略悄悄改成别的状态，
        // 尤其不能因为一个拼写错误掉进 closed 之外的值。
        registerMode: isRegisterMode(auth['registerMode'])
          ? auth['registerMode']
          : current.auth.registerMode,
      },
      service: {
        mode: service['mode'] === 'windows-service' ? 'windows-service' : current.service.mode,
        name: str(service['name'], current.service.name),
        displayName: str(service['displayName'], current.service.displayName),
        autoStart: bool(service['autoStart'], current.service.autoStart),
      },
      tls: {
        mode: tlsMode,
        httpsPort: num(tls['httpsPort'], current.tls.httpsPort),
        // 路径单独处理：允许显式空串（用户想清掉），但不能因为缺席就清空
        certPath: typeof tls['certPath'] === 'string' ? tls['certPath'].trim() : current.tls.certPath,
        keyPath: typeof tls['keyPath'] === 'string' ? tls['keyPath'].trim() : current.tls.keyPath,
      },
    },
    {},
  );
}

/**
 * 面板提交的 trustProxy。
 *
 * 三种输入必须区分开（这是"能否清空"与"能否保持"的分界）：
 *   · `undefined`（字段缺席）→ 保持原值，避免只改端口的保存把信任表清空；
 *   · `null` / `[]` / `''`（显式给空）→ 清空，用户确实想关掉反代信任；
 *   · 字符串（面板用换行/逗号分隔）或字符串数组 → 覆盖。
 *
 * `null` 也当"清空"：JSON 里表达"没有"的两种写法（null 与 []）语义相同，
 * 只认其中一种会让调用方在"我明明传了空"时看到原值不变 —— 第一版就是这样，
 * 注释写了 null 清空而代码把它归进"保持原值"，实测才发现。
 */
function parseTrustProxyPatch(patch: Record<string, unknown>, current: string[]): string[] {
  const value = patch['trustProxy'];
  if (value === undefined) return current;
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter((item) => item !== '');
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  }
  return current;
}

/** 供 CLI `service status` 探测端口是否在监听 */
export function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    socket.setTimeout(800);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

export function panelExists(): boolean {
  return existsSync(join(PUBLIC_DIR, 'index.html'));
}

/** 便于诊断：读取面板文件内容（CLI `config` 子命令输出安装信息时用） */
export function panelIndexPath(): string {
  return join(PUBLIC_DIR, 'index.html');
}

export function readPanelFile(name: string): string {
  return readFileSync(join(PUBLIC_DIR, name), 'utf8');
}
