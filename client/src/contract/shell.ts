/**
 * 壳能力契约 · 唯一原生入口
 *
 * 规则（务必遵守，评审时按这条查）：
 *   1. 渲染层**只允许**从 `src/contract` 导入原生能力，禁止直接 import
 *      `@tauri-apps/api` / `@tauri-apps/plugin-*`。
 *   2. 这里只暴露**语义化能力**（读卡片、写导出、扫规则、存取配置、选文件），
 *      不暴露通用的「给我一个路径，我随便读写」。
 *   3. 目录选择**只有一个入口** `pickDirectory`，且固定 `recursive: false`
 *      （非递归、不持久化授权）。见下方「文件对话框」与 docs/11 §8。
 *   4. 所有错误统一抛 `ShellError`，调用方按 `code` 分支，不解析文案。
 */

import { invoke } from '@tauri-apps/api/core';
import { confirm as confirmDialog, open, save } from '@tauri-apps/plugin-dialog';
import { load, type Store } from '@tauri-apps/plugin-store';

import { ShellError, toShellError } from './errors.js';
import {
  DEFAULT_CLIENT_CONFIG,
  type BinaryFile,
  type CardsDirScan,
  type ClientConfig,
  type DirProbe,
  type ExtractReceipt,
  type PathProbe,
  type PortProbe,
  type RuleDirScan,
  type RuleKind,
  type ShellInfo,
  type SpawnReceipt,
  type SpawnTarget,
  type StCandidates,
  type TextFile,
  type WriteReceipt,
} from './types.js';

/** invoke 包一层：把 Rust 的 Err 统一成 ShellError */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toShellError(error);
  }
}

// ─────────────────────────────────────────────────────────────
// 读写文件
// ─────────────────────────────────────────────────────────────

/**
 * 读文本文件，严格 UTF-8 解码（等价 Node 的 `new TextDecoder('utf-8', { fatal: true })`）。
 *
 * 为什么不用 plugin-fs 的 readTextFile：它遇到非法字节会替换成 U+FFFD，
 * 静默改写用户内容，与「逐字节可复现」直接冲突。
 *
 * @param maxBytes 默认 64 MiB（Rust 侧同默认），超限报 TOO_LARGE
 */
export function readTextExact(path: string, maxBytes?: number): Promise<TextFile> {
  return call<TextFile>('read_text_exact', { path, maxBytes: maxBytes ?? null });
}

/**
 * 读二进制文件（v0.1.4 / T12.3）：返回 base64 + 字节数 + sha256。
 *
 * 与 `readTextExact` **同形约束**（这是刻意对齐的，不是复制粘贴）：
 *   · 只接受绝对路径（相对路径在 Rust 侧直接拒绝）；
 *   · `maxBytes` 默认 64 MiB，超限报 `TOO_LARGE`；
 *   · 错误码与文本读取完全一致（`PATH_NOT_FOUND` / `NOT_A_FILE` / `TOO_LARGE` /
 *     `PATH_NOT_ALLOWED` / `IO`），调用方可以复用同一套错误处理；
 *   · 不做任何解码/转码 —— 二进制没有"非法 UTF-8"这回事，所以**没有** `NOT_UTF8`。
 *
 * 唯一的区别是返回 `base64` 而不是 `text`。为什么不返回 `number[]`：
 * 5 MB 的 PNG 会变成约 20 MB 的 JSON 文本，序列化本身就要几秒；
 * base64 只膨胀 33%，两端都有现成实现。
 *
 * 为什么不用 plugin-fs 的 `readFile`：那条路走的是"字节数组过 IPC"，
 * 且权限模型是路径白名单（本项目刻意不注册任意 fs 权限，见 capabilities）。
 */
export function readBinaryFile(path: string, maxBytes?: number): Promise<BinaryFile> {
  return call<BinaryFile>('read_binary_file', { path, maxBytes: maxBytes ?? null });
}

/**
 * 读**内置默认卡面**（v0.1.4 / T12.5）。
 *
 * 刻意不接收路径：资源目录在 MSI / 绿色包 / `tauri dev` 三种形态下都不一样，
 * 这个差异只该由 Rust 侧一份解析逻辑承担（`paths::default_face_path`）。
 * 渲染层说"给我默认卡面"，而不是"去读某个路径"—— 后者一旦算错，
 * 表现是"默认卡面显示不出来"，而没人会想到去查资源目录。
 *
 * 返回结构与 `readBinaryFile` 完全相同，所以解码/校验逻辑可以复用。
 */
export function readDefaultFace(): Promise<BinaryFile> {
  return call<BinaryFile>('read_default_face', {});
}

/**
 * 在系统文件管理器里打开一个目录（v0.1.4 / T12.5）。
 *
 * **只接受目录**：这个能力刻意比 opener 插件窄得多 —— 插件能给"用默认程序
 * 打开任意路径"（含 `.exe`、`file://` URL），而这里 Rust 侧先校验
 * "绝对路径 + 确实是目录"。capabilities 至今没有授予 opener 的任何 IPC 权限，
 * 所以这条自定义命令是打开文件夹的**唯一**通路。
 */
export function openFolder(path: string): Promise<void> {
  return call<void>('open_folder', { path });
}

/**
 * 用系统默认浏览器打开一个 http/https 链接（F15 / T13.4、T13.5）。
 *
 * v0.1.3 回滚时这条能力一起消失了，v0.1.5 的 F15 需要它（推送完要打开 ST 页面），
 * 于是按原来的口径恢复：**只放行 http/https**，`file://` / `javascript:` /
 * `data:` 一律拒绝 —— 前者的实际效果是"用默认程序打开本地任意文件"，
 * 与 `openFolder` 那条口子加起来就等于恢复了 opener 插件的全部能力。
 *
 * 渲染层因此仍然拿不到"打开任意路径"，只有"打开一个网址"。
 */
export function openExternal(url: string): Promise<void> {
  return call<void>('open_external', { url });
}

// ─────────────────────────────────────────────────────────────
// SillyTavern 联动（v0.1.5 / F15 · T13.1）
// ─────────────────────────────────────────────────────────────
//
// 这一段的三条能力都**碰本地其它程序**，所以每条都窄：
//   探测只回答存在形态（不读内容）、候选目录只来自用户主目录、
//   启动只允许 ST 目录里的三个固定目标。约束在 Rust 侧兜底，
//   这里只负责把它们翻译成语义化的调用。

/**
 * 批量探测路径的存在形态（`file` / `dir` / `none`）。
 *
 * 为什么不读内容：ST 检测只需要知道"有没有 package.json、有没有 server.js"，
 * 读内容那是下一步（`readTextExact`）的事。把两件事分开，
 * "探测"就可以被当成一个纯存在性查询来审计。
 *
 * 上限 64 条（Rust 侧 `MAX_PROBE_PATHS`）：没有上限它就是一台目录扫描器。
 */
export function probePaths(paths: string[]): Promise<PathProbe[]> {
  return call<PathProbe[]>('probe_paths', { paths });
}

/**
 * 列出 `SillyTavern*` 候选目录（只看用户主目录，不接受路径参数）。
 *
 * 返回的是**候选**：标准位置 `%USERPROFILE%\SillyTavern` 无论存不存在都会在列，
 * 因为"用户装在默认位置"是最常见的情况，不该靠猜。判定交给调用方
 * （`session/st-install.ts` 的 `judgeStInstall`）。
 */
export function findStCandidates(): Promise<StCandidates> {
  return call<StCandidates>('find_st_candidates', {});
}

/**
 * 探测本机回环端口有没有人在听（F15 / v0.1.5 生产反馈追加）。
 *
 * 判定"ST 在不在跑"只该问这一条：webview 的 fetch 受系统代理、安全软件、
 * 本地网络权限影响，它说"不通"不等于端口没开（线上就这么误报过）。
 * 壳侧走 `TcpStream::connect_timeout(127.0.0.1:port)`，不经过任何 HTTP 中间层。
 *
 * 失败**不抛错**：连不上是正常结论（`alive: false` + `errorKind`），不是命令错误。
 */
export function probeStAlive(port?: number): Promise<PortProbe> {
  return call<PortProbe>('probe_st_alive', { port: port ?? null });
}

/**
 * 启动本地 SillyTavern（分离进程，不等它退出）。
 *
 * **约束在壳里，不在这里**：`cwd` 必须自己通过 ST 判据（package.json +
 * scripts.start 或 server.js），`cmd` 只能是三个白名单目标之一。
 * 前端传错不会"启动失败但没人知道"，而是收到 `SPAWN_REJECTED`。
 *
 * 返回的 `logPath` 是子进程输出的落点 —— 启动失败时用它把 ST 自己的报错
 * 读出来贴给用户（`readTextExact(logPath)`），而不是我们转述"启动失败"。
 */
export function spawnDetached(cmd: SpawnTarget, cwd: string): Promise<SpawnReceipt> {
  return call<SpawnReceipt>('spawn_detached', { cmd, cwd });
}

/**
 * 把下载好的 ST release zip 解压到目标目录（F15 / T13.3「一键安装」）。
 *
 * 为什么解压要原生做：zip 里的文件动辄上万，走 IPC 逐个 `writeFileAtomic`
 * 慢到不可用，而"一次传整棵树"又会把写文件能力放大成"往任意位置铺文件"。
 * 壳侧调系统 `tar.exe` 解一次，边界反而更窄。
 *
 * **沙箱**：`destDir` 必须落在用户主目录下（壳侧用 canonicalize 比较），
 * 一键安装只能"装到自己家里"。
 */
export function extractZipTo(zipPath: string, destDir: string): Promise<ExtractReceipt> {
  return call<ExtractReceipt>('extract_zip_to', { zipPath, destDir });
}

/**
 * 原子写：同目录临时文件 → fsync → rename 覆盖 → 回读校验 sha256。
 *
 * `expectedSha256` 是「我以为我要写什么」的断言：与传入文本的实际摘要不符时，
 * **一个字节都不落盘**直接报 DIGEST_MISMATCH。用于防「编辑期间文件被外部改动」。
 */
export function writeFileAtomic(
  path: string,
  text: string,
  expectedSha256?: string,
): Promise<WriteReceipt> {
  return call<WriteReceipt>('write_file_atomic', {
    path,
    text,
    expectedSha256: expectedSha256 ?? null,
  });
}

/**
 * 原子写二进制（v0.1.4 / T12.5）：入参 base64，落盘的是解码后的原始字节。
 *
 * 与 `writeFileAtomic` 共用 Rust 侧同一个实现（`write_atomic_impl`），
 * 所以原子性、写前摘要断言、写后回读自证这三条**不会**在其中一条路径上退化。
 *
 * `expectedSha256` 的语义与文本版完全一致：不符则一个字节都不写。
 * 对 PNG 而言这一步尤其值钱 —— 它证明"落盘的图就是内存里那张图"，
 * 而不是某次重新编码的结果。
 */
export function writeBinaryFileAtomic(
  path: string,
  base64: string,
  expectedSha256?: string,
): Promise<WriteReceipt> {
  return call<WriteReceipt>('write_binary_file_atomic', {
    path,
    base64,
    expectedSha256: expectedSha256 ?? null,
  });
}

// ─────────────────────────────────────────────────────────────
// 用户预设库（v0.1.5 / G5）
// ─────────────────────────────────────────────────────────────

/**
 * 读用户预设库。**文件不存在返回 `null`，不抛错。**
 *
 * 首次运行本来就没有这个文件 —— 把它做成错误，调用方就得在
 * "没有预设"和"读失败"之间猜，而两者对用户的含义完全不同：
 * 前者是正常状态，后者要提示"你的预设读不出来"。
 *
 * 路径由壳解析（`<应用配置目录>/preset-library.json`），渲染层既不拼也不传 ——
 * 契约里没有"路径"这个参数，所以不存在"照着约定拼路径"的机会。
 */
export function readPresetLibrary(): Promise<TextFile | null> {
  return call<TextFile | null>('read_preset_library', {});
}

/**
 * 写用户预设库。原子写 + 写后回读自证，与保存卡片文件同一套保证。
 *
 * 与 `writeFileAtomic` 的差别只有一处：**按需创建父目录**。
 * 保存卡片时父目录必须已存在（不替用户建目录），而应用私有配置目录
 * 在首次运行时可能还没建，创建它是本职。
 */
export function writePresetLibrary(text: string, expectedSha256?: string): Promise<WriteReceipt> {
  return call<WriteReceipt>('write_preset_library', {
    text,
    expectedSha256: expectedSha256 ?? null,
  });
}

// ─────────────────────────────────────────────────────────────
// 内置规则目录
// ─────────────────────────────────────────────────────────────

/**
 * 扫描内置规则目录。
 *
 * 注意参数只有 `kind`，**没有路径**：目录由 Rust 侧解析（$RESOURCE/rules，
 * 开发期回退到仓库根）。前端拿不到「指定任意目录」的能力，
 * 这是对 CVE-2026-95627 那类 scope 递归扩张的架构级规避。
 */
export function scanRuleDir(kind: RuleKind): Promise<RuleDirScan> {
  return call<RuleDirScan>('scan_rule_dir', { kind });
}

/**
 * 读取某个内置规则文件的文本。
 *
 * 同样不接受路径：只接受 `kind` + 文件名。Rust 侧会校验该文件确实在
 * 规则目录内（拒绝 `..` 与路径分隔符），杜绝穿越。
 */
export function readRuleText(kind: RuleKind, name: string, maxBytes?: number): Promise<TextFile> {
  return call<TextFile>('read_rule_text', { kind, name, maxBytes: maxBytes ?? null });
}

// ─────────────────────────────────────────────────────────────
// 文件对话框
// ─────────────────────────────────────────────────────────────
//
// 安全约束（项目决策，勿擅自放宽）：
//   · 选文件一律 `multiple: false`、`directory: false`；
//   · **选目录只有 pickDirectory 一个入口**，固定 `multiple: false`、
//     `directory: true`、`recursive: false`。
//
// 原由：`tauri-plugin-dialog` 会把你选中的路径加入 fs scope。若选目录时带
// 递归，一次点击可能把**整棵目录树**的读写权授给 webview
// （GHSA-j8fp-v6pf-qx45 / CVE-2026-95627，high / 7.7，该公告**没有修复版本**）。
//
// T9.8 为什么要开这个口子：F4 要求「卡片存放目录可配置」，而这必须让用户
// 用原生对话框选一次 —— 让他手打绝对路径既容易错，也绕不过"选目录"这件事。
// 于是把风险收紧到最小：
//   · `recursive: false` —— scope 只加该目录本身，**不下潜子目录**，
//     所以即便 webview 被劫持，也拿不到目录里任何文件的授权；
//   · `multiple: false` —— 一次只加一个目录，不能批量圈地；
//   · **不持久化**：我们只把路径字符串存进配置（plugin-store），
//     从不把它写进 fs 的 scope/allowlist。重启后 dialog 给的运行时授权自然消失。
//     所以"配置里记着这个路径"不等于"这个路径永久可读写"。
// 详见 docs/11 §8。

const CARD_FILTERS = [{ name: '角色卡 JSON', extensions: ['json'] }];
/** 卡面图库 / 浏览选择用的图片过滤器（v0.1.4 / T12.5） */
const IMAGE_FILTERS = [
  { name: '图片（PNG / JPG / WebP）', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
  { name: 'PNG', extensions: ['png'] },
];
/**
 * 打开角色卡时的过滤器（v0.1.4 / T12.4 加 `.png`）。
 *
 * 把 png 放在**第一个**"全部支持"项里：Windows 的对话框默认选中第一项，
 * 用户打开 SillyTavern 的 PNG 卡是最常见的动作。单独一项用于"只看 PNG"。
 *
 * 放开的是**过滤器**而不是新增原生能力 —— 仍然 `open()`、`multiple:false`、
 * `directory:false`，C6 的安全约束（只选单文件、不传递归）没有放宽。
 */
const CARD_OR_TEXT_FILTERS = [
  { name: '角色卡 / 文本 / PNG', extensions: ['json', 'txt', 'png'] },
  { name: '角色卡 JSON', extensions: ['json'] },
  { name: '纯文本 TXT', extensions: ['txt'] },
  { name: 'PNG 角色卡', extensions: ['png'] },
];
const TEXT_FILTERS = [{ name: '文本文件', extensions: ['txt', 'md'] }];
const PNG_FILTERS = { name: 'PNG 角色卡', extensions: ['png'] };

/**
 * 选一张角色卡文件；取消返回 null。
 *
 * `defaultDir` 是对话框的默认落点（T9.8：接入 cardsDir）。
 * 传目录而不是"目录+文件名"，由 dialog 自己在该目录下打开；
 * 目录不存在时 dialog 会退到父目录，不会报错。
 *
 * `allowText`（T10.9）放开 `.txt`：TXT 角色卡导入**没有 JSON 信封**，
 * 整篇就是文本，按当前预设切板块。放开的是**过滤器**而不是新增原生能力 ——
 * 仍然走同一个 `open()`，`multiple: false` / `directory: false` 不变，
 * 所以 C6 的安全约束（只选单文件、不传递归）没有被放宽。
 */
export async function pickCardFile(
  defaultDir?: string | null,
  options: { allowText?: boolean; allowImages?: boolean } = {},
): Promise<string | null> {
  const filters =
    options.allowImages === true
      ? IMAGE_FILTERS
      : options.allowText === true
        ? CARD_OR_TEXT_FILTERS
        : CARD_FILTERS;
  const selected = await open({
    multiple: false,
    directory: false,
    filters,
    ...(defaultDir ? { defaultPath: defaultDir } : {}),
  });
  return typeof selected === 'string' ? selected : null;
}

/**
 * 选一个保存目标路径；取消返回 null。
 *
 * `defaultDir` 与上面的含义一致：这里要拼成**完整路径**（目录 + 建议文件名），
 * 因为 save 对话框把 `defaultPath` 当作"文件名输入框的初值"：
 * 只给目录时，用户会看到一个停在目录上的文件名框，而不是预填好的名字。
 */
export async function pickSavePath(
  suggestedName: string,
  format: 'json' | 'txt' | 'png',
  defaultDir?: string | null,
): Promise<string | null> {
  const selected = await save({
    defaultPath: defaultDir ? joinPath(defaultDir, suggestedName) : suggestedName,
    filters: format === 'json' ? CARD_FILTERS : format === 'png' ? [PNG_FILTERS] : TEXT_FILTERS,
  });
  return selected ?? null;
}

/**
 * 拼接目录与文件名（实现见 `session/cards-path.ts`）。
 *
 * 放在纯逻辑模块里而不是这里：契约层依赖 `@tauri-apps/*`，Node 里跑不了，
 * 而拼接规则需要单测。这里转发一次，调用方仍然只从契约层取能力。
 */
import { joinPath } from '../session/cards-path.js';

export { joinPath };

/**
 * 选一个目录（T9.8 / F4）。取消返回 null。
 *
 * 唯一允许选目录的入口，固定 `recursive: false`。调用方拿到路径后
 * **必须**再走 `probeCardsDir`：对话框只保证"用户选了这个目录"，
 * 不保证它存在、可写。
 */
export async function pickDirectory(defaultPath?: string | null): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: true,
    // 关键：非递归。缺省也是 false，但这里显式写出来 ——
    // 这是安全边界，不该依赖库的默认值（默认值可能变）。
    recursive: false,
    ...(defaultPath ? { defaultPath } : {}),
  });
  return typeof selected === 'string' ? selected : null;
}

/** 选一个用户自定义规则文件（单文件，不含目录） */
export async function pickRuleFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: '规则 JSON', extensions: ['json'] }],
  });
  return typeof selected === 'string' ? selected : null;
}

// ─────────────────────────────────────────────────────────────
// 配置（plugin-store）
// ─────────────────────────────────────────────────────────────

const STORE_FILE = 'client-config.json';
let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true, defaults: { ...DEFAULT_CLIENT_CONFIG } });
  return storePromise;
}

/** 读配置（缺键回落到默认值） */
export async function configGet(): Promise<ClientConfig> {
  const store = await getStore();
  const result: ClientConfig = { ...DEFAULT_CLIENT_CONFIG };
  for (const key of Object.keys(DEFAULT_CLIENT_CONFIG) as Array<keyof ClientConfig>) {
    const value = await store.get<ClientConfig[typeof key]>(key);
    if (value !== undefined && value !== null) {
      // 逐键回落，避免旧版本配置缺键导致 undefined 穿透到 UI
      (result as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/** 写单个配置项 */
export async function configSet<K extends keyof ClientConfig>(
  key: K,
  value: ClientConfig[K],
): Promise<void> {
  const store = await getStore();
  await store.set(key, value);
  await store.save();
}

/** 批量写配置（一次 save，减少落盘次数） */
export async function configPatch(patch: Partial<ClientConfig>): Promise<ClientConfig> {
  const store = await getStore();
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) await store.set(key, value);
  }
  await store.save();
  return configGet();
}

/** 清空配置（重置为默认值） */
export async function configReset(): Promise<void> {
  const store = await getStore();
  await store.clear();
  await store.save();
}

// ─────────────────────────────────────────────────────────────
// 卡片目录（T9.8 / F4）
// ─────────────────────────────────────────────────────────────

/**
 * 默认卡片目录：`<Documents>/TavernCardStudio/cards`。
 *
 * 由壳解析（`document_dir()`），不在 TS 里拼 `%USERPROFILE%\\Documents` ——
 * Windows 上文档目录可能被重定向到 OneDrive，手拼的路径未必存在。
 */
export function defaultCardsDir(): Promise<string> {
  return call<string>('default_cards_dir');
}

/**
 * 探测目录：存在？可写？（可选创建）
 *
 * 可写性是**真实写一个探针文件再删掉**，不是看属性位。返回结构把
 * 「不存在 / 创建失败 / 不可写」分开，调用方才能分别处置（见 types.ts 的 DirProbe）。
 */
export function probeCardsDir(path: string, options: { create?: boolean } = {}): Promise<DirProbe> {
  return call<DirProbe>('probe_cards_dir', { path, create: options.create ?? false });
}

/**
 * 列出目录下的文件名（不递归、不读内容）。
 *
 * 两个用途，共用同一段扫描逻辑：
 *   · 保存前看看有没有同名 `.json`，好自动追加序号而不是静默覆盖；
 *   · 卡面图库（v0.1.4 / T12.5）列出 `png/jpg/jpeg/webp`。
 *
 * `extensions` 缺省为 `['json']`，**默认行为与之前逐字相同** ——
 * 既有调用方（查重名）不需要改。传扩展名时大小写不敏感、前导点可有可无。
 */
export function scanCardsDir(
  path: string,
  limit?: number,
  extensions?: string[],
): Promise<CardsDirScan> {
  return call<CardsDirScan>('scan_cards_dir', {
    path,
    limit: limit ?? null,
    extensions: extensions ?? null,
  });
}

// ─────────────────────────────────────────────────────────────
// 客户端错误日志（C8 / T10.26）
// ─────────────────────────────────────────────────────────────

/**
 * 追加一条客户端错误日志，返回日志文件路径。
 *
 * **为什么不是"给我路径我自己写"**：契约第 2 条规则只暴露语义化能力。
 * 这里渲染层既不决定目录、也不决定文件名 —— 落点由壳解析
 * （`<应用配置目录>/logs/client-error.log`），调用方只拿到回执里的路径用于展示。
 *
 * 为什么需要壳来做这件事（而不是用 `console.error` 或 log 插件）：
 *   · 需求要的是**崩溃后还能看到**的日志。`console.error` 只在 devtools 里，
 *     装好的应用没有 devtools；log 插件是 Rust 侧自己写的日志，格式与落点都不对；
 *   · 崩溃前那一条最需要落盘，而浏览器侧的 `localStorage` 写入在崩溃时可能还没
 *     刷盘。壳里用「open + write + sync_all」同步落盘，且命令返回前就写完。
 *
 * 单条上限 8 KiB（壳侧截断），文件 1 MiB 轮转成 `.1`（只留一份备份）。
 */
export function appendClientErrorLog(entry: string): Promise<string> {
  return call<string>('append_client_error_log', { entry });
}

// ─────────────────────────────────────────────────────────────
// 自检
// ─────────────────────────────────────────────────────────────

/** 壳版本、规则根目录、debug/release —— 用于「关于」页与故障排查 */
export function shellInfo(): Promise<ShellInfo> {
  return call<ShellInfo>('shell_info');
}

/** 供 UI 判断「是不是跑在壳里」（浏览器直开时这些能力不可用） */
export function isShellAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 二次确认。**所有环境统一的异步版本**，渲染层只许用它，不许直接写 `window.confirm`。
 *
 * ## 为什么不能直接用 `window.confirm`
 *
 * `tauri-plugin-dialog` 在初始化脚本（`init-iife.js`）里**改写**了这两个全局函数：
 *
 * ```js
 * window.alert = e => invoke('plugin:dialog|message', { message: e.toString() })
 * window.confirm = async e => 'Ok' === await invoke('plugin:dialog|message', { message: ..., buttons: 'OkCancel' })
 * ```
 *
 * 于是壳里 `window.confirm(...)` 返回的是 **Promise**，不是 boolean。而我们所有调用点
 * 写的都是同步用法 `if (!window.confirm(...)) return;` —— Promise 恒为真值，
 * `!proceed` 永远是 `false`，结果是：
 *
 *   · 确认框**根本不出现**；
 *   · 操作**直接执行**（删除卡片、删除仓库、导出闸门、重排原文全在内）。
 *
 * 2026-10-24 的生产日志就是这么发现的：`client-error.log` 里两条
 * `UNHANDLEDREJECTION Command plugin:dialog|message not allowed by ACL` ——
 * capabilities 当时只给了 `dialog:allow-open` / `dialog:allow-save`，
 * 少了 `dialog:allow-message`（`dialog:default` 里本来是三项齐全的）。
 *
 * 那次事故同时说明为什么这个 bug 能活到发版：**端到端测试跑在 Chrome 里**，
 * 那里的 `window.confirm` 是原生的同步函数，行为完全正常；只有壳里才被改写。
 *
 * ## 现在的约定
 *
 *   · 壳里：走插件的 `confirm()`（本来就是 `Promise<boolean>`，语义对得上）；
 *   · 浏览器里：走原生 `window.confirm`（同步 boolean），包一层 Promise 统一形状。
 *
 * `validate-config.mjs` 会静态拦下渲染层里任何直接的 `window.confirm` / `window.alert`。
 */
export async function askConfirm(text: string, title = '请确认'): Promise<boolean> {
  if (!isShellAvailable()) return window.confirm(text);
  return await confirmDialog(text, { title, kind: 'warning' });
}

// 这里不再复述导出：类型与错误分别由 ./types、./errors 提供，
// 由 ./index.ts 统一汇总，避免同名符号二义（TS2308）。

