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

export interface RunningWorker {
  server: Server;
  context: ServerContext;
  url: string;
  close(): Promise<void>;
}

export async function startWorker(loaded: LoadedConfig): Promise<RunningWorker> {
  const context = createContext(loaded, { role: 'worker' });
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
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  return { server, context, url, close };
}
