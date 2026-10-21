/**
 * 壳能力契约 · 唯一原生入口
 *
 * 规则（务必遵守，评审时按这条查）：
 *   1. 渲染层**只允许**从 `src/contract` 导入原生能力，禁止直接 import
 *      `@tauri-apps/api` / `@tauri-apps/plugin-*`。
 *   2. 这里只暴露**语义化能力**（读卡片、写导出、扫规则、存取配置、选文件），
 *      不暴露通用的「给我一个路径，我随便读写」。
 *   3. 不提供目录选择。见下方 pick* 的注释。
 *   4. 所有错误统一抛 `ShellError`，调用方按 `code` 分支，不解析文案。
 */

import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { load, type Store } from '@tauri-apps/plugin-store';

import { ShellError, toShellError } from './errors.js';
import {
  DEFAULT_CLIENT_CONFIG,
  type ClientConfig,
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
//   · 一律 `multiple: false`、`directory: false`；
//   · 不传任何递归选项。
// 原由：`tauri-plugin-dialog` 会把你选中的路径加入 fs scope；若允许选目录且
// 带递归，一次点击可能把整棵目录树的读写权授给 webview（GHSA-j8fp-v6pf-qx45 /
// CVE-2026-95627，high / 7.7，该公告目前**没有修复版本**）。
// 我们的做法是「根本不给前端选目录的能力」，而不是指望升级修好。

const CARD_FILTERS = [{ name: '角色卡 JSON', extensions: ['json'] }];
const TEXT_FILTERS = [{ name: '文本文件', extensions: ['txt', 'md'] }];

/** 选一张角色卡 JSON；取消返回 null */
export async function pickCardFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: CARD_FILTERS,
  });
  return typeof selected === 'string' ? selected : null;
}

/** 选一个导出目标路径；取消返回 null */
export async function pickSavePath(
  suggestedName: string,
  format: 'json' | 'txt',
): Promise<string | null> {
  const selected = await save({
    defaultPath: suggestedName,
    filters: format === 'json' ? CARD_FILTERS : TEXT_FILTERS,
  });
  return selected ?? null;
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

