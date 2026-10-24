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
import { open, save } from '@tauri-apps/plugin-dialog';
import { load, type Store } from '@tauri-apps/plugin-store';

import { ShellError, toShellError } from './errors.js';
import {
  DEFAULT_CLIENT_CONFIG,
  type CardsDirScan,
  type ClientConfig,
  type DirProbe,
  type RuleDirScan,
  type RuleKind,
  type ShellInfo,
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
const CARD_OR_TEXT_FILTERS = [
  { name: '角色卡 / 文本', extensions: ['json', 'txt'] },
  { name: '角色卡 JSON', extensions: ['json'] },
  { name: '纯文本 TXT', extensions: ['txt'] },
];
const TEXT_FILTERS = [{ name: '文本文件', extensions: ['txt', 'md'] }];

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
  options: { allowText?: boolean } = {},
): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: options.allowText === true ? CARD_OR_TEXT_FILTERS : CARD_FILTERS,
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
  format: 'json' | 'txt',
  defaultDir?: string | null,
): Promise<string | null> {
  const selected = await save({
    defaultPath: defaultDir ? joinPath(defaultDir, suggestedName) : suggestedName,
    filters: format === 'json' ? CARD_FILTERS : TEXT_FILTERS,
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
 * 列出目录下的 `.json` 文件名（不递归、不读内容）。
 *
 * 用途只有一个：保存前看看有没有同名文件，好自动追加序号而不是静默覆盖。
 */
export function scanCardsDir(path: string, limit?: number): Promise<CardsDirScan> {
  return call<CardsDirScan>('scan_cards_dir', { path, limit: limit ?? null });
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

// 这里不再复述导出：类型与错误分别由 ./types、./errors 提供，
// 由 ./index.ts 统一汇总，避免同名符号二义（TS2308）。

