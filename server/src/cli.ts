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
 *   selfcheck        离线自检：真跑一遍运行时依赖，不读配置、不绑端口
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  assertSafeConfig,
  generateToken,
  loadConfig,
  reachableHost,
  writeConfig,
  type ConfigOverrides,
  type LoadedConfig,
  type ServerConfigFile,
} from './config.js';
import { SERVER_VERSION } from './context.js';
import { hashPassword } from './auth/password.js';
import { migrateRepos, migrateToFirstAccount, planMigration } from './auth/migrate.js';
import { RepoStore } from './storage/repos.js';
import { Db } from './storage/db.js';
import { adoptOrphanCards, countOrphanCards, UserStore } from './storage/users.js';
import { selfCheckCommand } from './selfcheck.js';
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
  // `--trust-proxy 127.0.0.1,10.0.0.0/8`。传空串表示"清空"（脚本里显式关掉用）。
  if (typeof flags['trust-proxy'] === 'string') {
    overrides.trustProxy = flags['trust-proxy']
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');
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
      `  version               版本信息\n` +
      `  selfcheck             离线自检：真跑一遍运行时依赖（argon2/x509/sqlite/git）\n\n` +
      `选项：\n` +
      `  --config <路径>       配置文件（默认 ./data/config.json）\n` +
      `  --port <端口>         API 端口（默认 8730）\n` +
      `  --control-port <端口> 管理面板端口（默认 port+1）\n` +
      `  --host <地址>         API 监听地址（默认 127.0.0.1；开给局域网就填 0.0.0.0）\n` +
      `  --control-host <地址> 管理面板监听地址（默认 127.0.0.1，独立于 --host）\n` +
      `  --data-dir <路径>     数据目录（blobs / repos / state.db）\n` +
      `  --rules-dir <路径>    规则目录（默认 ./rules）\n` +
      `  --token <token>       指定访问令牌\n` +
      `  --trust-proxy <列表>  可信反向代理，逗号分隔的 IP 或 CIDR（默认空＝不信任任何代理头）\n` +
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

/**
 * `tcs-server user …` —— 账户运维命令（T10.3）。
 *
 * 为什么要这么一组命令：注册策略默认**关闭**（需求 F1.1），所以第一个账户
 * 和后续管理员建的账户都只能从命令行/面板产生。CLI 这条路不依赖 HTTP，
 * 面板进不去时（比如忘了密码）还能救回来。
 *
 * 密码**只从 stdin 读**，不接受 `--password` 参数：命令行参数会进 shell 历史、
 * 也会出现在进程列表里（`ps`/任务管理器都能看到），等于把密码写在公告板上。
 */
async function userCommand(action: string | undefined, options: CliOptions): Promise<number> {
  const loaded = load(options.configPath, options.overrides);
  const dbFile = join(loaded.config.dataDir, 'state.db');
  const db = new Db(dbFile);
  try {
    return await runUserCommand(action, options, db, dbFile);
  } catch (error) {
    // 业务错误（重名、最后一个管理员、密码不合规）不是"程序崩了"，
    // 不该把堆栈甩给用户 —— 说清哪错了、怎么办就够。
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    db.close();
  }
}

async function runUserCommand(
  action: string | undefined,
  options: CliOptions,
  db: Db,
  dbFile: string,
): Promise<number> {
  {
    const users = new UserStore(db.handle);

    if (action === 'list' || action === undefined) {
      const rows = users.list();
      if (rows.length === 0) {
        process.stdout.write('还没有任何账户。用 `tcs-server user add <用户名>` 创建第一个（管理员）。\n');
        return 0;
      }
      process.stdout.write('用户名\t角色\t状态\t创建时间\t最后登录\n');
      for (const row of rows) {
        process.stdout.write(
          `${row.username}\t${row.role}\t${row.status}\t${row.created_at}\t${row.last_login_at ?? '-'}\n`,
        );
      }
      const orphans = countOrphanCards(db.handle);
      if (orphans > 0) {
        process.stderr.write(`\n注意：有 ${String(orphans)} 张卡片没有归属账户。` +
          '用 `tcs-server user adopt <用户名>` 把它们划给某个账户。\n');
      }
      return 0;
    }

    if (action === 'add' || action === 'create') {
      const username = options.positional[2];
      if (!username) {
        process.stderr.write('用法：tcs-server user add <用户名> [--role admin|user]\n');
        return 2;
      }
      const role = options.flags['role'] === 'admin' ? 'admin' : 'user';
      const password = await readPasswordFromStdin('设置密码');
      const passwordHash = await hashPassword(password);
      // 第一个账户强制管理员：否则建完就没人能管理服务端
      const finalRole = users.count() === 0 ? 'admin' : role;
      const row = users.create({ username, passwordHash, role: finalRole });
      process.stdout.write(`已创建账户「${row.username}」（${row.role}）\n`);
      if (finalRole !== role) {
        process.stderr.write('（这是第一个账户，已自动设为管理员）\n');
      }
      return 0;
    }

    if (action === 'passwd' || action === 'password') {
      const username = options.positional[2];
      if (!username) {
        process.stderr.write('用法：tcs-server user passwd <用户名>\n');
        return 2;
      }
      const user = users.findByUsername(username);
      if (!user) {
        process.stderr.write(`用户「${username}」不存在\n`);
        return 1;
      }
      const password = await readPasswordFromStdin('新密码');
      users.setPassword(user.id, await hashPassword(password));
      process.stdout.write(`已更新「${user.username}」的密码\n`);
      return 0;
    }

    if (action === 'disable' || action === 'enable') {
      const username = options.positional[2];
      if (!username) {
        process.stderr.write(`用法：tcs-server user ${action} <用户名>\n`);
        return 2;
      }
      const user = users.findByUsername(username);
      if (!user) {
        process.stderr.write(`用户「${username}」不存在\n`);
        return 1;
      }
      users.setStatus(user.id, action === 'disable' ? 'disabled' : 'active');
      process.stdout.write(`已${action === 'disable' ? '禁用' : '启用'}「${user.username}」\n`);
      return 0;
    }

    if (action === 'adopt') {
      const username = options.positional[2];
      if (!username) {
        process.stderr.write('用法：tcs-server user adopt <用户名>\n');
        return 2;
      }
      const user = users.findByUsername(username);
      if (!user) {
        process.stderr.write(`用户「${username}」不存在\n`);
        return 1;
      }
      const adopted = adoptOrphanCards(db.handle, user.id, {
        // 一起归进默认仓库：否则会出现"账户能看到、仓库令牌看不到"的中间态
        repoId: new RepoStore(db.handle).ensureDefault(user.id).id,
      });
      process.stdout.write(`已把 ${String(adopted)} 张无归属卡片划给「${user.username}」\n`);
      return 0;
    }

    if (action === 'migrate') {
      const username = options.positional[2] ?? 'admin';
      const plan = planMigration(db.handle);
      if (!plan.needed) {
        // 已有账户：仍然跑仓库迁移（v0.1.2 升级上来的库可能缺默认仓库 / 卡片没归仓库）
        const repoResult = migrateRepos(db.handle);
        process.stdout.write(
          `已有 ${String(users.count())} 个账户\n` +
            `仓库迁移：新建 ${String(repoResult.created)} 个默认仓库、${String(repoResult.cardsAssigned)} 张卡片入库\n`,
        );
        return 0;
      }
      process.stdout.write(
        `将创建首账户「${username}」（管理员）并接管 ${String(plan.orphanCards)} 张历史卡片。\n` +
          '原库会先自动备份（VACUUM INTO，含最新事务）。\n',
      );
      const password = await readPasswordFromStdin('首账户密码');
      const result = await migrateToFirstAccount(db.handle, { username, password, dbFile });
      process.stdout.write(`${result.message}\n`);
      return 0;
    }

    if (action === 'repos' || action === 'repo') {
      // 列出仓库与卡片数（运维排查"卡片进错仓库"时的第一手信息）
      const sub = options.positional[2];
      const repos = new RepoStore(db.handle);
      const username = options.positional[3];
      const target = username ? users.findByUsername(username) : users.list()[0] ?? null;
      if (!target) {
        process.stderr.write('还没有账户；先运行 `tcs-server user migrate <用户名>`\n');
        return 1;
      }
      if (sub === 'add') {
        const name = options.positional[4];
        if (!name) {
          process.stderr.write('用法：tcs-server user repos add <账户名> <仓库名>\n');
          return 2;
        }
        const row = repos.create({ ownerId: target.id, name });
        process.stdout.write(`已为「${target.username}」创建仓库「${row.name}」（${row.id}）\n`);
        return 0;
      }
      const list = repos.list(target.id);
      if (list.length === 0) {
        process.stdout.write(`「${target.username}」还没有仓库。运行 user migrate 可自动建默认仓库\n`);
        return 0;
      }
      process.stdout.write(`账户「${target.username}」的仓库：\n`);
      for (const row of list) {
        process.stdout.write(
          `  ${row.name}${row.is_default === 1 ? '（默认）' : ''}\t${String(repos.countCards(row.id))} 张卡片\t${row.id}\n`,
        );
      }
      return 0;
    }

    process.stderr.write(
      `未知的 user 操作：${action}（list/add/passwd/enable/disable/adopt/migrate/repos）\n`,
    );
    return 2;
  }
}

/**
 * 从 stdin 读一行密码（不回显、不入 shell 历史）。
 *
 * 非交互场景（测试、脚本）允许用环境变量 `TCS_PASSWORD`：
 * 环境变量不会进进程列表的可见命令行，但仍可能被同用户进程读到，
 * 所以只在无法交互时才用它。
 */
async function readPasswordFromStdin(prompt: string): Promise<string> {
  const fromEnv = process.env['TCS_PASSWORD'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  if (!process.stdin.isTTY) {
    // 管道输入：读一整行
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
    if (text === '') throw new Error(`${prompt}：没有从 stdin 读到内容`);
    return text;
  }

  process.stderr.write(`${prompt}：`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      const char = String(chunk);
      if (char === '\r' || char === '\n') break;
      if (char === '\u0003') throw new Error('已取消'); // Ctrl+C
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1);
        continue;
      }
      value += char;
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write('\n');
  }
  if (value === '') throw new Error(`${prompt}：不能为空`);
  return value;
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

  // `selfcheck` 刻意放在最前面（与 version 同级）：它**不读配置文件**，
  // 也不解析 --config。产物缺依赖时最需要它，而那时配置文件可能还不存在
  // （全新安装、或数据目录被清）。放在后面就会被 load() 的副作用挡住。
  if (options.command === 'selfcheck' || group === 'selfcheck') {
    // 显式把 --bundle-root 传下去：验证产物时必须约束"只能从包里解析"，
    // 否则绿色包放在仓库里时会从仓库根的 node_modules 找到缺的包，给出假通过。
    const bundleRoot = options.flags['bundle-root'];
    return selfCheckCommand(typeof bundleRoot === 'string' ? { bundleRoot } : {});
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

  if (group === 'user') {
    return userCommand(action, options);
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
        // 这里给人看，必须用可访问地址；监听 0.0.0.0 时打印 http://0.0.0.0:… 是打不开的。
        // 实际监听地址由日志的 bind 字段给出（见 supervisor.listening）。
        `API：http://${reachableHost(loaded.config.host)}:${loaded.config.port}/api\n` +
        `数据目录：${loaded.config.dataDir}\n`,
    );
    return 0;
  }

  printHelp();
  return 2;
}
