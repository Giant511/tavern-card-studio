/**
 * 本地 SillyTavern 联动的**纯逻辑**（v0.1.5 / F15 · T13.2 / T13.4 / T13.6）—— 无 IO、无 DOM。
 *
 * 为什么这些判断在 TS 而不是 Rust：
 *   · 「算不算 ST 安装」是**业务判据**（需求写的是 package.json + scripts.start /
 *     server.js），要能跑矩阵单测（有 package.json × 有 start × 有 server.js）；
 *   · 「推送文件名冲突怎么加序号」是用户可见的命名规则，出错的表现是覆盖别人的卡；
 *   · 「四状态各自说什么」直接决定用户看到的是"帮你启动"还是"去装一个"，
 *     文案串了比没有更糟。
 * 三样都不需要系统权限，所以都留在这边。真正的原生动作（探测存在、启动进程、
 * 打开链接）在 `contract/shell.ts`，判据在 Rust 侧**还会再验一次**（启动前）。
 *
 * 判据与 Rust `looks_like_st_root` **必须一致**：两边分叉的后果是"面板说装了、
 * 点启动却被拒"。`test/st-install.test.mjs` 逐条对拍这两份实现。
 */

import { joinPath, nextAvailableFileName, sanitizeFileBase } from './cards-path.ts';
import { resolveStAddress, type StAddressOk } from './st-address.ts';

/** 角色卡在 ST 里的落点（相对 ST 根目录） */
export const ST_CHARACTERS_SUBDIR = 'data/default-user/characters';

/**
 * 推送产物的扩展名：**PNG**（v0.1.5 / G8，决策 #212）。
 *
 * ## 为什么不是 JSON（这是实测推翻的设计）
 *
 * 最初的判断是"JSON 体积小一个量级，且能被文本 diff"（决策 #198）。G8 的现场把
 * 这个判断否掉了：`西奥.json` 落盘正确、ST 的「导入角色卡」也能成功，但**角色目录
 * 扫描器始终不显示它**（刷新、重启都无效）。也就是说 ST 1.18 的"文件夹扫描"
 * 只认 PNG 卡 —— UI 导入是另一条代码路径，它认 JSON，于是很容易让人以为 JSON 可用。
 *
 * 用户的实证很直接：他现有的角色**全部是 PNG**。
 *
 * 所以推送改成 PNG 卡（数据块 ccv3 / chara），代价是体积（一张封面 + 卡 JSON），
 * 换来的是"落盘即见"——不需要用户去点任何导入按钮。
 */
export const ST_PUSH_EXTENSION = 'png';

/** 四个状态（需求 T13.6 要求各有各的状态栏文案，不能共用一句模糊提示） */
export type StState = 'missing' | 'installed-idle' | 'running' | 'pushed';

/** 判定失败的具体原因。分开报是为了让界面能说"缺哪一半"，而不是"不是 ST" */
export type StRejectReason = 'no-package-json' | 'no-start-script-and-server-js';

/** 判定所需的事实（全部来自 `probePaths` + `readTextExact`，这里不自己读盘） */
export interface StFacts {
  /** 候选根目录（绝对路径，原样回传） */
  root: string;
  /** `package.json` 存在（是文件，不是目录） */
  hasPackageJson: boolean;
  /** `package.json` 的文本；读失败/不存在时为 null */
  packageJsonText: string | null;
  /** `server.js` 存在 */
  hasServerJs: boolean;
}

/** 判定结果 */
export interface StInstallVerdict {
  installed: boolean;
  root: string;
  /** 未安装时的原因；已安装为 null */
  reason: StRejectReason | null;
  /**
   * 命中的判据（给人看的一句话，界面用它解释"凭什么说装了"）。
   * 空数组 = 没命中任何一条。
   */
  evidence: string[];
  /** 角色卡目录的绝对路径（`<root>/data/default-user/characters`） */
  charactersDir: string;
}

/**
 * 读 `package.json` 里 `scripts.start` 是否存在且非空。
 *
 * 为什么要求非空：`"start": ""` 满足"键存在"但什么都跑不起来 ——
 * 放行之后用户会得到"启动成功但端口 10 秒没起来"，而真正的原因
 * （start 脚本是空的）反而更难看出来。
 */
export function hasStartScript(packageJsonText: string | null): boolean {
  if (packageJsonText === null || packageJsonText.trim() === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    // 坏 JSON 按"没有 start"处理，但**不影响**另一条判据（server.js）：
    // package.json 存在 + server.js 存在仍然是合法的 ST 结构。
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return false;
  const start = (scripts as { start?: unknown }).start;
  return typeof start === 'string' && start.trim() !== '';
}

/**
 * 判据：**`package.json` 存在 且（`scripts.start` 非空 或 `server.js` 存在）**。
 *
 * 为什么要两条覆盖（需求原话「多版本目录结构差异用这两条覆盖」）：
 * ST 1.12 的包里 `Start.bat` 直接 `node server.js`，package.json 的 start
 * 可能只是个占位；1.13 的包里改成走 `npm start`。只认一条会漏掉另一代。
 *
 * 注意 `package.json` 只要求**存在**，不要求可解析：坏 JSON + 有 server.js
 * 依然能 `node server.js` 跑起来，判成"没装"会让用户无从下手。
 */
export function judgeStInstall(facts: StFacts): StInstallVerdict {
  const evidence: string[] = [];
  const start = hasStartScript(facts.packageJsonText);
  if (facts.hasPackageJson) evidence.push('package.json 存在');
  if (start) evidence.push('scripts.start 非空');
  if (facts.hasServerJs) evidence.push('server.js 存在');

  const installed = facts.hasPackageJson && (start || facts.hasServerJs);
  const reason: StRejectReason | null = installed
    ? null
    : facts.hasPackageJson
      ? 'no-start-script-and-server-js'
      : 'no-package-json';

  return {
    installed,
    root: facts.root,
    reason,
    evidence: installed ? evidence : [],
    charactersDir: stCharactersDir(facts.root),
  };
}

/** `<root>/data/default-user/characters` */
export function stCharactersDir(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, '');
  return joinPath(joinPath(joinPath(trimmed, 'data'), 'default-user'), 'characters');
}

/**
 * 从多个候选里挑出"要用的那个" ST。
 *
 * 优先级：**用户记过的路径 > 扫描顺序里的第一个可用项**。
 *
 * ## 已知局限（2026-10-26 生产缺陷暴露的，别再用"记忆优先"解释一切）
 *
 * 8000 端口是**全局的一份**，它只说明"某个 ST 在跑"，说明不了"跑的是哪个目录"。
 * 所以记忆路径记错时（比如记到一个只有 package.json + server.js 的空壳目录），
 * 会出现一种很迷惑的状态：面板说"在运行"（端口确实通），但推送写进的是
 * **那个空壳目录**的 characters —— 用户在自己的 ST 里当然看不到卡。
 *
 * 处置（不靠猜）：位置行**始终显示当前用的是哪个目录**，推送完成后把落点路径
 * 原样显示在面板上；用户发现不对可以直接「换一个…」改掉。比"自动纠正"诚实 ——
 * 因为没有任何可靠办法从端口反推出"跑的是哪个目录"。
 */
export function chooseStInstall(
  verdicts: readonly StInstallVerdict[],
  remembered: string | null | undefined,
): StInstallVerdict | null {
  const installed = verdicts.filter((item) => item.installed);
  if (installed.length === 0) return null;

  const wanted = typeof remembered === 'string' ? remembered.trim() : '';
  if (wanted !== '') {
    const hit = installed.find((item) => samePath(item.root, wanted));
    if (hit) return hit;
  }
  return installed[0] ?? null;
}

/** 路径比较：忽略大小写与首尾分隔符（Windows 上 `C:\a\` 与 `c:\A` 是同一个目录） */
export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}

/** 启动目标的选择依据 */
export interface LaunchFacts {
  /** 目录里有 `start.bat` / `Start.bat` */
  hasStartBat: boolean;
  /** 目录里有 `server.js` */
  hasServerJs: boolean;
}

/**
 * 挑启动方式：**有 `start.bat` 就用它**，否则直接 `node server.js`。
 *
 * 为什么优先 bat：ST 的 `Start.bat` 除了起 node 还会做几件事
 * （检查依赖、提示缺 node、设置环境变量）。绕过它直接用 node，
 * 在"依赖没装"的机器上会得到一堆看不懂的 MODULE_NOT_FOUND。
 */
export function chooseLaunchTarget(facts: LaunchFacts): 'start.bat' | 'server.js' | null {
  if (facts.hasStartBat) return 'start.bat';
  if (facts.hasServerJs) return 'server.js';
  return null;
}

/**
 * 推送目标文件名（F15 / T13.5：文件名取角色名，冲突加序号，**不覆盖**）。
 *
 * 复用卡片目录那套命名规则（`sanitizeFileBase` + `nextAvailableFileName`）：
 * 非法字符、Windows 保留设备名、大小写不敏感重名这些坑已经在那里踩完了，
 * 再写一份必然分叉 —— 而分叉的后果是"同一张卡在卡片目录能存、在 ST 里覆盖了别人"。
 */
export function stPushFileName(cardName: string, existing: readonly string[]): string {
  const base = sanitizeFileBase(cardName);
  return nextAvailableFileName(existing, base, ST_PUSH_EXTENSION);
}

/**
 * 推送卡面来源的一句话说明（写进状态栏与面板）。
 *
 * 为什么要说：推送**不弹卡面选择**（需求明确"用卡的既有默认链"），
 * 那用户就无从知道推过去的那张封面是哪来的。说清楚来源，他才能判断
 * "为什么这张卡的封面不是我刚在导出里挑的那张"（那次选择不写进记忆）。
 */
/**
 * 推送时用的卡面来源（决策 #167 的优先级链：原图 → 记住的图库封面 → 内置默认）。
 *
 * 单独列成具名类型是因为它现在跨两个模块（`st-push.ts` 的产物类型、
 * `st-dialog.ts` 的展示），而匿名内联类型会让两边各写一份、慢慢长歪。
 */
export interface StPushFace {
  from: 'source' | 'library' | 'default';
  fileName: string | null;
  note: string;
}

export function describePushFace(face: StPushFace): string {
  if (face.note !== '') return `卡面：${face.note}`;
  switch (face.from) {
    case 'source':
      return '卡面：这张卡的原图（像素未重新编码）';
    case 'library':
      return `卡面：图库里的 ${face.fileName ?? '（未知）'}`;
    case 'default':
      return '卡面：内置默认卡面（这张卡没有原图，也没记住图库封面）';
  }
}

/**
 * 角色目录里同名的**旧 JSON 推送**（v0.1.5 之前推的是 `.json`）。
 *
 * 它必须被提示出来：ST 的文件夹扫描不认 JSON，所以那个文件在 ST 里**永远不会出现**，
 * 但用户在资源管理器里能看到它，会以为"推了两份"。不主动指出来，用户只会更困惑。
 */
export function staleJsonSiblings(cardName: string, existing: readonly string[]): string[] {
  const base = sanitizeFileBase(cardName);
  const wanted = `${base}.json`.toLowerCase();
  return existing.filter((name) => name.toLowerCase() === wanted);
}

/**
 * 四状态的状态栏文案。
 *
 * 需求 T13.6 明确要求"不共享同一句模糊提示" —— 每个状态要回答的是不同的
 * 下一步动作（去装 / 帮你启动 / 直接推 / 已经好了），所以这里宁可长一点。
 * `pushed` 那条是需求原话，逐字保留。
 */
export function stStatusText(
  state: StState,
  context: { root?: string; fileName?: string; address?: string } = {},
): string {
  switch (state) {
    case 'missing':
      return '未检测到本地 SillyTavern：可在「在 SillyTavern 中测试」里看安装步骤或一键安装';
    case 'installed-idle':
      return `已找到 SillyTavern（${context.root ?? '路径未知'}），但它没有运行 —— 点「启动 SillyTavern」后再推送`;
    case 'running':
      return `SillyTavern 正在运行（${context.address ?? '配置的地址'}）：可以把当前卡推送过去`;
    case 'pushed':
      /*
       * 文案在 G8 改过（决策 #212）。原句是需求 T13.6 写的「已在 SillyTavern 中就绪，
       * 刷新角色列表即可看到」，当时推的是 JSON —— 而那句话**不成立**：ST 的文件夹
       * 扫描不读 .json，用户刷新多少次都看不到。现在推开的是 PNG，并且把
       * "要按 F5" 与 "推的是 PNG" 都写进来，避免用户以为还需要点「导入」。
       */
      return `已推送为 PNG · 在 ST 中 F5 刷新可见${context.fileName ? `（${context.fileName}）` : ''}`;
  }
}

/** 启动失败时给用户的常见原因清单（需求 T13.4 明列三条） */
export const ST_LAUNCH_FAILURE_HINTS: readonly string[] = [
  '端口 8000 被占用：多半是上一次启动的 ST 还在后台跑（去任务管理器看 node.exe），或者别的程序占了 8000',
  'Node 版本不足：ST 1.13 要求 Node 18+（推荐 20 LTS）；在命令行执行 node --version 确认',
  '权限问题：装在 C:\\Program Files 或系统盘根目录时普通用户可能没有写权限，换到用户目录下',
];

/**
 * 启动失败时把"壳的原始报错"翻译成一句能动手的话（v0.1.5 生产反馈追加）。
 *
 * 起因：`node.exe` 不在 PATH 时，壳返回的是 `启动 server.js 失败：程序不存在 (os error 2)`。
 * 用户看到的是"点了没反应/一句话"，而真正的原因是**这个目录里没有 `start.bat`**
 * （只有一个裸 `server.js`，而机器上又没有全局 Node）。这类"差一步"的失败
 * 必须点明差的是哪一步，否则用户只会重复点同一个按钮。
 */
export function describeLaunchFailure(target: 'start.bat' | 'server.js', raw: string): string {
  const notFound = /os error 2|程序不存在|找不到指定|not found|No such file/i.test(raw);
  if (target === 'server.js' && notFound) {
    return (
      '启动失败：这个目录里没有 start.bat，而系统 PATH 里找不到 node.exe。' +
      '请用 SillyTavern 自带的 Start.bat（它通常会把 node 一起带好），或先安装 Node.js LTS。'
    );
  }
  if (target === 'start.bat' && notFound) {
    return `启动失败：找不到（或无法执行）start.bat —— 可能被杀毒软件隔离了。原始错误：${raw}`;
  }
  return `启动失败：${raw}`;
}

/** 轮询等待端口起来的默认参数（需求：10 秒内端口未起即视为失败） */
export const ST_START_TIMEOUT_MS = 10_000;
export const ST_START_POLL_MS = 500;

/**
 * 轮询等待某个探测函数返回 true。
 *
 * 注入 `probe` 而不是自己 fetch：这样这段超时逻辑能在 Node 里单测
 * （用假时钟推进），不需要真起一个 ST。
 *
 * 超时返回 false，**不抛错** —— "10 秒没起来"是预期内的一种结果
 * （用户机器慢、端口被占），要由调用方去展示原因，不该变成异常。
 */
export async function waitForStReady(
  probe: () => Promise<boolean>,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    /** 便于单测注入：默认 setTimeout */
    sleep?: (ms: number) => Promise<void>;
    /** 便于单测注入：默认 Date.now */
    now?: () => number;
  } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? ST_START_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? ST_START_POLL_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  const deadline = now() + timeoutMs;
  // 先探一次再睡：ST 已经在跑时不该白等一个轮询间隔
  for (;;) {
    if (await probe()) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * 探测结果的三种结局（v0.1.5 生产反馈后从 boolean 改成判别联合）。
 *
 * 为什么要分开：`false` 一个值要同时表示"端口没人接""1.5 秒没回""被浏览器拦了"，
 * 而这三件事的处置完全不同。一个布尔值逼着界面说一句"没有应答"，
 * 用户拿不到任何可执行信息 —— 生产缺陷就是这样被当成"ST 没运行"报上来的。
 */
export type StProbeOutcome = 'running' | 'timeout' | 'no-answer';

/** 壳侧 TCP 探测的结论（`contract.probeTcp` 的返回值，这里只取需要的字段） */
export interface TcpProbeFacts {
  alive: boolean;
  /** `io::ErrorKind` 的可读名：ConnectionRefused / TimedOut / PermissionDenied … */
  errorKind: string | null;
  errorMessage: string | null;
}

export interface StProbeResult {
  outcome: StProbeOutcome;
  baseUrl: string;
  /** 壳侧（TCP）结论 —— **这是唯一的判定依据** */
  tcp: TcpProbeFacts;
  /** 浏览器侧 fetch 的原始错误（诊断用，可能为空） */
  browserErrorName: string | null;
  browserErrorMessage: string | null;
  /**
   * TCP 通、但浏览器 fetch 失败。
   *
   * ## 名字是历史遗留，含义已被证伪过一次（2026-10-27 实测）
   *
   * 它原来被解释成"浏览器网络层被挡（系统代理 / 安全软件 / LNA）"。实测下来
   * **不是网络问题**：SillyTavern 的响应里带
   *
   * ```text
   * Cross-Origin-Resource-Policy: same-origin
   * ```
   *
   * 浏览器对这个头的执行方式是"跨源 `no-cors` 读取一律失败"，抛出的正是
   * `TypeError: Failed to fetch`。于是**请求明明发出去了、响应也回来了**，
   * fetch 仍然 reject —— 与"连不上"长得一模一样。
   *
   * 同一台机器上的三组对照（页面源 `127.0.0.1:8977`）：
   *
   * | 目标 | CORP | `no-cors` fetch |
   * |---|---|---|
   * | ST `:8000` | `same-origin` | 失败 `TypeError: Failed to fetch` |
   * | 反代，剥 XFO 但保留 CORP | `same-origin` | 失败（同上） |
   * | 反代，XFO 与 CORP 都剥 | 无 | **成功** |
   *
   * 所以这个字段只能当"诊断线索"，**绝不能当"网络不通"的结论**。判定"ST 在不在跑"
   * 依旧只看壳侧 TCP（见 `classifyStProbe` 的注释）。
   */
  browserBlocked: boolean;
}

/** 单次 TCP 探测的超时（毫秒）。浏览器里"端口没人接"会立刻 reject，超时兜的是"接了但不回" */
export const ST_PROBE_TIMEOUT_MS = 1500;

/**
 * 把"两侧的证据"归成一个结论（纯函数，可单测）。
 *
 * **判定只看 TCP**：浏览器那侧受代理/跨源策略/本地网络权限影响，它说"不通"
 * 不代表端口没开（生产缺陷就这样误报过）。浏览器错误只用于诊断与提示。
 */
export function classifyStProbe(input: {
  baseUrl: string;
  tcp: TcpProbeFacts;
  browserErrorName: string | null;
  browserErrorMessage: string | null;
}): StProbeResult {
  const browserBlocked = input.tcp.alive && input.browserErrorName !== null;
  return {
    baseUrl: input.baseUrl,
    tcp: input.tcp,
    browserErrorName: input.browserErrorName,
    browserErrorMessage: input.browserErrorMessage,
    browserBlocked,
    outcome: input.tcp.alive
      ? 'running'
      : input.tcp.errorKind === 'TimedOut'
        ? 'timeout'
        : 'no-answer',
  };
}

/** 探测失败时给用户看的一句话（带原始错误，不装懂） */
export function describeProbe(result: StProbeResult): string {
  const parts: string[] = [];
  if (result.tcp.errorKind !== null) {
    parts.push(`${result.tcp.errorKind}${result.tcp.errorMessage ? `: ${result.tcp.errorMessage}` : ''}`);
  }
  if (result.browserErrorName !== null) {
    parts.push(
      `浏览器侧 ${result.browserErrorName}${result.browserErrorMessage ? `: ${result.browserErrorMessage}` : ''}`,
    );
  }
  const detail = parts.length === 0 ? '' : `（${parts.join('；')}）`;

  switch (result.outcome) {
    case 'running':
      /*
       * 措辞刻意不说"被代理挡住" —— 那是我曾经据此判断成"环境拦回环"的原话，
       * 而实测证明 webview 侧的失败主因是 ST 自己的 `Cross-Origin-Resource-Policy`
       * （跨源 no-cors 读取一律失败），网络完全通。
       * 现在只说事实：TCP 通、webview 内读不到；并说明不影响什么。
       */
      return result.browserBlocked
        ? `${result.baseUrl} 在应答（webview 内读取被响应头策略拒绝，属正常现象；` +
            `推送与用系统浏览器打开都不受影响）`
        : `${result.baseUrl} 在应答`;
    case 'timeout':
      return `${result.baseUrl} 在 ${String(ST_PROBE_TIMEOUT_MS)} 毫秒内没有应答${detail}`;
    case 'no-answer':
      return `${result.baseUrl} 没有应答${detail}`;
  }
}

/**
 * 判断"ST 是否在运行"（**配置地址**可达即视为运行中）。
 *
 * ## 两侧各探一次，只有一侧算数
 *
 * 1. **壳侧 TCP**（`tcpProbe` 注入，Rust 里 `TcpStream::connect_timeout` 到 host:port）
 *    —— **唯一判定依据**。它只回答"这个端口有没有人 accept"这一个比特，不受 CORS、
 *    跨源策略、本地网络权限、系统代理影响。
 * 2. **浏览器侧 fetch（`mode:'no-cors'`）** —— 只用于诊断。
 *
 * ## 为什么不能只靠 fetch（哪怕已经是 `no-cors`）
 *
 * 需求最初判断根因是"CORS 头缺失"，但 26407bd 里探测**本来就是** `no-cors`，
 * 线上仍然判"未运行"，而且 ST 自己的访问日志里**没有一条来自 webview 的连接** ——
 * 说明请求在浏览器网络层就没出去（代理/安全软件/本地网络权限），跟 ST 发不发
 * CORS 头无关。`no-cors` 仍然保留（它确实让"不发 CORS 头"不再构成失败，
 * 实测见 `scripts/verify-f15-probe.mjs`），但它一个人兜不住这一层。
 *
 * 所以真正的判据放到壳里：TCP 能连上 = 活着。fetch 的错误名照原样带进诊断日志。
 *
 * ## v0.1.6 / T14.0：地址不再写死
 *
 * 端口可配（用户的 ST 可能改了 `listenPort`、也可能多开）。地址从
 * `resolveStAddress(config.stAddress)` 取，这里没有默认值兜底 ——
 * **默认值只允许存在于 `contract/types.ts`**（静态断言守着）。
 */
export async function probeStState(options: {
  /** 目标地址（来自配置）；省缺时用默认地址，仅为便利，不鼓励省略 */
  address?: StAddressOk;
  /** 壳侧 TCP 探测（`contract.probeTcp`）；测试里可注入假实现 */
  tcpProbe: (host: string, port: number) => Promise<TcpProbeFacts>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<StProbeResult> {
  const address = options.address ?? resolveStAddress(null);
  const timeoutMs = options.timeoutMs ?? ST_PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchAttempt = (async (): Promise<{ name: string | null; message: string | null }> => {
    try {
      await fetchImpl(address.baseUrl, { mode: 'no-cors', signal: controller.signal, cache: 'no-store' });
      return { name: null, message: null };
    } catch (error) {
      return {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  })();

  const [tcp, browser] = await Promise.all([
    options.tcpProbe(address.host, address.port).catch(
      (error: unknown): TcpProbeFacts => ({
        alive: false,
        errorKind: error instanceof Error ? error.name : 'ProbeFailed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    ),
    fetchAttempt,
  ]);

  return classifyStProbe({
    baseUrl: address.baseUrl,
    tcp,
    browserErrorName: browser.name,
    browserErrorMessage: browser.message,
  });
}

/**
 * 只想知道"活着吗"的便捷读法。
 *
 * 保留它是因为很多调用点（含将来的测试）只需要一个布尔；但**判定逻辑只有
 * `probeStState` 一份** —— 这里不再自己 fetch，避免"两处各自下结论"（那正是
 * 生产缺陷的形态：界面看到的结论与真实端口状态不一致）。
 */
export async function probeStRunning(options: Parameters<typeof probeStState>[0]): Promise<boolean> {
  return (await probeStState(options)).outcome === 'running';
}

// ── 一键安装（T13.3）─────────────────────────────────────────

/**
 * 写死在客户端里的 ST 版本（需求：版本号写死在客户端配置里）。
 *
 * 为什么写死而不是"查最新版"：一键安装要的是**可复现**。
 * 查 latest 意味着今天装 1.13.2、明天装 1.13.5，用户的卡在某天突然
 * 因为 ST 换了字段而读不出来，而客户端代码一行没变 —— 这种事无法归因。
 * 升级版本是发版动作，走改这一行。
 */
export const ST_RELEASE = {
  version: '1.13.2',
  repo: 'SillyTavern/SillyTavern',
  /** release 资产的命名规则（`SillyTavern-1.13.2.zip`） */
  assetName: (version: string) => `SillyTavern-${version}.zip`,
} as const;

/**
 * 组装下载地址。
 *
 * `mirrorPrefix` 是给国内网络用的加速前缀（需求：可配置镜像前缀）：
 * 填 `https://ghfast.top/` 就得到 `https://ghfast.top/https://github.com/...`。
 * 前缀**必须以 http(s):// 开头且以 / 结尾**，否则拼出来的地址是坏的 ——
 * 那种坏地址在用户那里表现为"下载失败"，看不出是格式问题。
 * 不合法时抛错（而不是静默忽略前缀），调用方据此提示用户改。
 */
export function stDownloadUrl(prefix: string | null | undefined, version = ST_RELEASE.version): string {
  const asset = ST_RELEASE.assetName(version);
  const official = `https://github.com/${ST_RELEASE.repo}/releases/download/${version}/${asset}`;
  const trimmed = typeof prefix === 'string' ? prefix.trim() : '';
  if (trimmed === '') return official;
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('镜像前缀必须以 http:// 或 https:// 开头');
  }
  return `${trimmed.replace(/\/+$/, '')}/${official}`;
}

/**
 * 一键安装的落点：`<home>/SillyTavern`，**已存在则 `SillyTavern-2`**（需求 c 步）。
 *
 * 为什么不覆盖已存在的同名目录：那可能是用户自己装的、有数据的 ST。
 * 一键安装的职责是"给我一个能用的"，不是"把你这台机器上的 ST 统一成我的版本"。
 */
export function stInstallTargetDir(home: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  const base = home.replace(/[\\/]+$/, '');
  if (!taken.has('sillytavern')) return joinPath(base, 'SillyTavern');
  for (let index = 2; index <= 99; index += 1) {
    if (!taken.has(`sillytavern-${index}`)) return joinPath(base, `SillyTavern-${index}`);
  }
  return joinPath(base, 'SillyTavern-new');
}

/**
 * Node 的常见安装位置（需求 T13.3 a：探测常见安装位，不代装）。
 *
 * 返回的是**要探测的路径**，三种形态都算"有 Node"：
 *   · `file` —— 找到 `node.exe` 本体（官方 MSI 默认装在这两处）；
 *   · `dir`  —— `nvm` 的版本目录（node 在子目录里，逐个找太贵，认版本管理器在就行）。
 *
 * 找不到不等于"没有 Node"（绿色包、Chocolatey 都可能不在这些位置），
 * 所以界面上的措辞是"没在常见位置找到"，并给"我已装好，继续"这条出路 ——
 * 绝不能说"你没装 Node"（那是替用户下结论，而且大概率是错的）。
 */
export function nodeInstallCandidates(home: string): string[] {
  const trimmed = home.replace(/[\\/]+$/, '');
  // 逐级 joinPath：`joinPath('nodejs', 'node.exe')` 会因为第一段没有分隔符
  // 而按 '/' 拼（joinPath 是按目录里出现的分隔符判断平台的），
  // 结果得到 `...\Programs\nodejs/node.exe` 这种混着两种分隔符的路径。
  const local = joinPath(joinPath(trimmed, 'AppData'), 'Local');
  const roaming = joinPath(joinPath(trimmed, 'AppData'), 'Roaming');
  return [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    joinPath(joinPath(joinPath(local, 'Programs'), 'nodejs'), 'node.exe'),
    joinPath(roaming, 'nvm'),
  ];
}

/**
 * 把下载到的字节转成 base64（分块）。
 *
 * 为什么不用 `btoa(String.fromCharCode(...bytes))`：把 4000 万个参数摊进一次
 * 调用会直接爆栈（不同引擎阈值不同，40 MB 必炸）。按 32 KiB 分块既能跑完，
 * 又不会把中间字符串搞得太长。
 */
export function toBase64Chunked(bytes: Uint8Array, chunkSize = 32 * 1024): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * 截取日志尾部（启动失败时给用户看 ST 自己的报错）。
 *
 * 取尾部不是头部：node 的报错栈最后几行才是真正的原因，
 * 前面全是安装路径与版本号。
 */
export function tailOfLog(text: string, maxLines = 20): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((line) => line.trim() !== '');
  return lines.slice(-maxLines).join('\n');
}

// ── ST 安装位置的整体定位（v0.1.6 / T14.3）──────────────────
//
// 这套流程原先写在 `st-dialog.ts` 的 `refresh()` 里。v0.1.6 多了右侧常驻面板，
// 它也要同样的答案（"ST 在哪、characters 目录是哪"），于是抽到这里。
//
// **不是为了复用而复用**：检测规则要是写两份，就会出现"对话框说装了、面板说没装"
// —— 而两边各自的单测都绿。这类分叉在 F15 期间已经踩过一次（审计传了预设、
// 编辑器没传），代价是一个下午。

export interface StLocateDeps {
  /** 壳：列出候选目录（用户目录 + 各盘根） */
  findCandidates: () => Promise<{ home: string | null; dirs: string[] }>;
  /** 壳：读配置（记忆路径 + 地址） */
  readConfig: () => Promise<{ stPath: string | null; stAddress: string | null }>;
  /** 壳：批量存在性探测 */
  probePaths: (paths: string[]) => Promise<{ path: string; exists: 'file' | 'dir' | 'none' }[]>;
  /** 壳：严格读文本 */
  readText: (path: string, maxBytes?: number) => Promise<{ text: string }>;
}

export interface StLocateResult {
  home: string | null;
  /** 配置里记住的路径（原样） */
  remembered: string | null;
  /** 解析后的 ST 访问地址（空/非法值都回落默认） */
  address: StAddressOk;
  /** 每个候选目录的判据结论 */
  verdicts: StInstallVerdict[];
  /** 选中的那个（null = 没装） */
  chosen: StInstallVerdict | null;
}

/**
 * 走一遍"ST 装在哪"。
 *
 * 顺序：候选目录 ∪ 记忆路径 → 批量探 `package.json`/`server.js` → 读 `package.json`
 * 走判据 → `chooseStInstall`（记忆优先，但"活着"的优先于记忆，见 #207）。
 *
 * 地址也在同一处解析：两个入口都从配置读，读法只有这一份。
 */
export async function locateSt(deps: StLocateDeps): Promise<StLocateResult> {
  const scan = await deps.findCandidates();
  const config = await deps.readConfig();
  const address = resolveStAddress(config.stAddress);
  const remembered =
    typeof config.stPath === 'string' && config.stPath.trim() !== '' ? config.stPath.trim() : null;

  const dirs = new Set<string>(scan.dirs);
  if (remembered !== null) dirs.add(remembered);

  const list = [...dirs];
  const probesFor: string[] = [];
  for (const dir of list) {
    probesFor.push(joinPath(dir, 'package.json'), joinPath(dir, 'server.js'));
  }
  const probes = await deps.probePaths(probesFor);
  const byPath = new Map(probes.map((item) => [item.path.toLowerCase(), item.exists]));

  const verdicts: StInstallVerdict[] = [];
  for (const dir of list) {
    const hasPackageJson = byPath.get(joinPath(dir, 'package.json').toLowerCase()) === 'file';
    const hasServerJs = byPath.get(joinPath(dir, 'server.js').toLowerCase()) === 'file';
    // 只有 package.json 真的是文件时才读它（读目录会报 NOT_A_FILE，
    // 而"是个目录"与"不存在"在判据里都算没装，没必要制造噪声）
    let packageJsonText: string | null = null;
    if (hasPackageJson) {
      try {
        packageJsonText = (await deps.readText(joinPath(dir, 'package.json'), 1024 * 1024)).text;
      } catch {
        packageJsonText = null;
      }
    }
    verdicts.push(judgeStInstall({ root: dir, hasPackageJson, packageJsonText, hasServerJs }));
  }

  return {
    home: scan.home,
    remembered,
    address,
    verdicts,
    chosen: chooseStInstall(verdicts, remembered),
  };
}
