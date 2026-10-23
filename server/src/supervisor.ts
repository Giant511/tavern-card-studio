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
import { AppError, toAppError } from './errors.js';
import { TokenGate } from './http/auth.js';
import { methodNotAllowed, sendError, sendJson } from './http/responses.js';
import { Router, type RouteContext } from './http/router.js';
import { createLogger, type Logger } from './log.js';

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

  router.put('/control/config', async (_ctx) => {
    const patch = JSON.parse(_ctx.body.toString('utf8') || '{}') as Record<string, unknown>;
    let candidate: ServerConfigFile;
    try {
      candidate = applyConfigPatch(config, patch);
      assertSafeConfig(candidate);
    } catch (error) {
      throw new AppError(400, 'BAD_REQUEST', (error as Error).message);
    }
    candidate.updatedAt = new Date().toISOString();
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

    sendJson(_ctx.res, 200, {
      config: configSummary(candidate),
      workerRestartRequired,
      supervisorRestartRequired,
      restarted,
      note: supervisorRestartRequired
        ? '控制面端口修改需要重启 supervisor（Windows 服务：sc.exe stop/start <服务名>）'
        : workerRestartRequired
          ? restarted
            ? '数据面已按新配置重启'
            : '配置已保存，但自动重启失败；请查看日志后手动点「重启」'
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

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
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
export function applyConfigPatch(current: ServerConfigFile, patch: Record<string, unknown>): ServerConfigFile {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

  const service = (patch['service'] ?? {}) as Record<string, unknown>;
  const auth = (patch['auth'] ?? {}) as Record<string, unknown>;

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
      },
      service: {
        mode: service['mode'] === 'windows-service' ? 'windows-service' : current.service.mode,
        name: str(service['name'], current.service.name),
        displayName: str(service['displayName'], current.service.displayName),
        autoStart: bool(service['autoStart'], current.service.autoStart),
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
