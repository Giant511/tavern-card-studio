/**
 * `tcs-server` 命令行入口。
 *
 * 子命令：
 *   serve            默认。启动 supervisor（控制面 + 管理面板）与 worker（数据面）
 *   worker           只启动数据面（调试 / 由服务管理器直接托管时用）
 *   config show      打印配置（token 掩码）与配置路径
 *   config path      只打印配置路径
 *   token show       打印完整 token（本机运维用）
 *   token rotate     重新生成 token（需重启 worker 生效）
 *   service ...      Windows 服务注册 / 卸载 / 启停 / 状态（sc.exe）
 *   version          版本信息
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  assertSafeConfig,
  generateToken,
  loadConfig,
  writeConfig,
  type ConfigOverrides,
  type LoadedConfig,
  type ServerConfigFile,
} from './config.js';
import { SERVER_VERSION } from './context.js';
import { startSupervisor } from './supervisor.js';
import { startWorker } from './worker.js';

export interface CliOptions {
  command: string;
  /** 位置参数（含 command 本身），如 ["config","show"] */
  positional: string[];
  configPath: string;
  overrides: ConfigOverrides;
  flags: Record<string, string | boolean>;
}

function defaultConfigPath(): string {
  return process.env['TCS_CONFIG'] ?? resolve(process.cwd(), 'data', 'config.json');
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (token.startsWith('--')) {
      const withoutPrefix = token.slice(2);
      const eq = withoutPrefix.indexOf('=');
      if (eq >= 0) {
        flags[withoutPrefix.slice(0, eq)] = withoutPrefix.slice(eq + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[withoutPrefix] = next;
        index += 1;
      } else {
        flags[withoutPrefix] = true;
      }
    } else {
      positional.push(token);
    }
  }

  const command = positional[0] ?? 'serve';
  const configPath = resolve(String(flags['config'] ?? defaultConfigPath()));

  const overrides: ConfigOverrides = {};
  if (typeof flags['port'] === 'string') overrides.port = Number.parseInt(flags['port'], 10);
  if (typeof flags['control-port'] === 'string') overrides.controlPort = Number.parseInt(flags['control-port'], 10);
  if (typeof flags['host'] === 'string') overrides.host = flags['host'];
  if (typeof flags['control-host'] === 'string') overrides.controlHost = flags['control-host'];
  if (typeof flags['data-dir'] === 'string') overrides.dataDir = resolve(flags['data-dir']);
  else if (process.env['TCS_DATA_DIR']) overrides.dataDir = resolve(process.env['TCS_DATA_DIR']);
  else if (!existsSync(configPath)) overrides.dataDir = join(dirname(configPath), 'store');
  if (typeof flags['rules-dir'] === 'string') overrides.rulesDir = resolve(flags['rules-dir']);
  if (typeof flags['token'] === 'string') overrides.token = flags['token'];
  if (typeof flags['log-level'] === 'string') {
    overrides.logLevel = flags['log-level'] as ServerConfigFile['logLevel'];
  }
  if (typeof flags['service-mode'] === 'string') {
    overrides.serviceMode = flags['service-mode'] === 'windows-service' ? 'windows-service' : 'process';
  }

  return { command, positional, configPath, overrides, flags };
}

function load(configPath: string, overrides: ConfigOverrides): LoadedConfig {
  const loaded = loadConfig(configPath, overrides);
  if (loaded.created) {
    process.stdout.write(
      `已创建配置文件：${loaded.path}\n` +
        `数据目录：${loaded.config.dataDir}\n` +
        `访问令牌：${loaded.config.auth.token}\n` +
        '（令牌只在此刻完整打印；之后可用 `tcs-server token show` 查看）\n',
    );
  }
  return loaded;
}

function printHelp(): void {
  process.stdout.write(
    `Tavern Card Studio Server ${SERVER_VERSION}\n\n` +
      `用法：tcs-server <命令> [选项]\n\n` +
      `命令：\n` +
      `  serve                 启动控制面（管理面板）+ 数据面（默认）\n` +
      `  worker                只启动数据面 API\n` +
      `  config show|path      打印配置 / 配置路径\n` +
      `  token show|rotate     查看 / 轮换访问令牌\n` +
      `  service install|uninstall|start|stop|status [--dry-run]\n` +
      `  version               版本信息\n\n` +
      `选项：\n` +
      `  --config <路径>       配置文件（默认 ./data/config.json）\n` +
      `  --port <端口>         API 端口（默认 8730）\n` +
      `  --control-port <端口> 管理面板端口（默认 port+1）\n` +
      `  --host <地址>         API 监听地址（默认 127.0.0.1；开给局域网就填 0.0.0.0）\n` +
      `  --control-host <地址> 管理面板监听地址（默认 127.0.0.1，独立于 --host）\n` +
      `  --data-dir <路径>     数据目录（blobs / repos / state.db）\n` +
      `  --rules-dir <路径>    规则目录（默认 ./rules）\n` +
      `  --token <token>       指定访问令牌\n` +
      `  --no-worker           只起控制面（serve）\n`,
  );
}

function printConfig(config: ServerConfigFile, path: string): void {
  const masked = config.auth.token ? `${config.auth.token.slice(0, 4)}…${config.auth.token.slice(-4)}` : '';
  process.stdout.write(
    `${JSON.stringify(
      {
        configPath: path,
        port: config.port,
        controlPort: config.controlPort,
        host: config.host,
        controlHost: config.controlHost,
        dataDir: config.dataDir,
        rulesDir: config.rulesDir,
        defaultPlatformRule: config.defaultPlatformRule,
        defaultPreset: config.defaultPreset,
        maxUploadBytes: config.maxUploadBytes,
        logLevel: config.logLevel,
        auth: { require: config.auth.require, token: masked, publicPaths: config.auth.publicPaths },
        service: config.service,
        panel: `http://${config.controlHost}:${config.controlPort}/`,
        api: `http://${config.host}:${config.port}/api`,
      },
      null,
      2,
    )}\n`,
  );
}

function sc(args: string[], dryRun: boolean): number {
  const line = `sc.exe ${args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ')}`;
  if (dryRun) {
    process.stdout.write(`[dry-run] ${line}\n`);
    return 0;
  }
  if (process.platform !== 'win32') {
    process.stderr.write('service 子命令仅支持 Windows；其他平台请用 systemd / launchd 托管 `tcs-server serve`\n');
    return 2;
  }
  const result = spawnSync('sc.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status ?? 1;
}

function serviceCommand(action: string, loaded: LoadedConfig, dryRun: boolean): number {
  const config = loaded.config;
  const name = config.service.name;

  // 服务二进制必须是 WinSW 宿主，不能是 node.exe。
  //
  // node.exe 从不调用 StartServiceCtrlDispatcher，SCM 永远等不到 SERVICE_RUNNING，
  // 服务卡在 `Start Pending` —— 而进程其实活着、端口也在听，看起来完全正常。
  // 2026-10-21 的 MSI 安装挂起（"Please wait while Windows configures ..."）就是
  // 这个原因：ServiceInstall 直挂 node.exe，ServiceControl/@Wait 又等 SCM 回话。
  //
  // 宿主与配置必须同名同目录（WinSW v2 按文件名找 `<exe名>.xml`，不接受参数传路径）。
  const hostExe = join(dirname(process.execPath), 'tcs-service-host.exe');
  const hostXml = join(dirname(process.execPath), 'tcs-service-host.xml');

  if (action === 'install') {
    if (!existsSync(hostExe) || !existsSync(hostXml)) {
      process.stderr.write(
        [
          '拒绝注册服务：找不到服务宿主。',
          '',
          `  期望：${hostExe}`,
          `  期望：${hostXml}`,
          '',
          '直接用 node.exe 注册会让服务永久停在 Start Pending（SCM 收不到 SERVICE_RUNNING），',
          '安装程序会在等它启动时挂起。',
          '',
          '获取方式：',
          '  · 用 MSI 安装（自带宿主并已正确注册服务）',
          '  · 或把 vendor/winsw/WinSW.NET4.exe 与 installer/ServiceHost.xml',
          '    拷成上面这两个文件名，再重试',
          '',
        ].join('\n'),
      );
      return 2;
    }
  }

  // WinSW 按名字找配置，所以 binPath 只写宿主 exe，不带任何参数。
  const binPath = `"${hostExe}"`;
  switch (action) {
    case 'install': {
      const start = config.service.autoStart ? 'auto' : 'demand';
      let code = sc(
        ['create', name, `binPath= ${binPath}`, `start= ${start}`, `DisplayName= ${config.service.displayName}`],
        dryRun,
      );
      if (code === 0) {
        code = sc(['description', name, 'Tavern Card Studio 角色卡审计与版本控制服务'], dryRun);
      }
      if (code === 0) code = sc(['start', name], dryRun);
      return code;
    }
    case 'uninstall': {
      sc(['stop', name], dryRun);
      return sc(['delete', name], dryRun);
    }
    case 'start':
      return sc(['start', name], dryRun);
    case 'stop':
      return sc(['stop', name], dryRun);
    case 'restart': {
      sc(['stop', name], dryRun);
      return sc(['start', name], dryRun);
    }
    case 'status':
      return sc(['query', name], dryRun);
    default:
      process.stderr.write(`未知的 service 操作：${action}（install/uninstall/start/stop/restart/status）\n`);
      return 2;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const group = options.positional[0] ?? 'serve';
  const action = options.positional[1];

  if (options.command === 'help' || options.command === '--help') {
    printHelp();
    return 0;
  }
  if (options.command === 'version') {
    process.stdout.write(`tcs-server ${SERVER_VERSION} (node ${process.version}, ${process.platform}/${process.arch})\n`);
    return 0;
  }

  if (group === 'config') {
    const loaded = load(options.configPath, options.overrides);
    if (action === 'path') process.stdout.write(`${loaded.path}\n`);
    else printConfig(loaded.config, loaded.path);
    return 0;
  }

  if (group === 'token') {
    const loaded = load(options.configPath, options.overrides);
    if (action === 'rotate' || action === 'new') {
      const token = generateToken();
      const candidate = { ...loaded.config, auth: { ...loaded.config.auth, token, require: true }, updatedAt: new Date().toISOString() };
      assertSafeConfig(candidate);
      writeConfig(loaded.path, candidate);
      process.stdout.write(`${token}\n`);
      process.stderr.write('已写入配置文件；运行中的 worker 需重启后生效（面板「重启」或 sc.exe restart）\n');
      return 0;
    }
    if (!loaded.config.auth.token) {
      process.stderr.write('配置里没有 token；用 `tcs-server token rotate` 生成\n');
      return 1;
    }
    process.stdout.write(`${loaded.config.auth.token}\n`);
    return 0;
  }

  if (group === 'service') {
    const loaded = load(options.configPath, options.overrides);
    return serviceCommand(action ?? 'status', loaded, options.flags['dry-run'] === true);
  }

  if (options.command === 'worker') {
    const loaded = load(options.configPath, options.overrides);
    await startWorker(loaded);
    return 0;
  }

  if (options.command === 'serve') {
    const loaded = load(options.configPath, options.overrides);
    const entry = resolve(process.argv[1] ?? join(process.cwd(), 'server', 'dist', 'index.js'));
    const running = await startSupervisor(loaded, {
      entry,
      autoStartWorker: options.flags['no-worker'] !== true,
    });
    process.stdout.write(
      `Tavern Card Studio Server ${SERVER_VERSION}\n` +
        `管理面板：${running.url}\n` +
        `API：http://${loaded.config.host}:${loaded.config.port}/api\n` +
        `数据目录：${loaded.config.dataDir}\n`,
    );
    return 0;
  }

  printHelp();
  return 2;
}
