/**
 * 功能
 * 预设库的加载与"把库里的某一项应用进来"。
 * 从 EditorApp 搬出，2 个函数 81 行。
 *
 * 注意事项
 * `loadPresetLibrary` 启动时跑一次，把本机存的预设读进内存；读完把
 * `presetStoreReady` 置真 —— **之后再允许写盘**。没置真就写盘会把
 * 磁盘上已有的预设覆盖成只有一条（§149 那条缺陷）。
 *
 * `applyLibraryItem` 按 `item.kind` 分派到六种导入之一，全部复用导入模块的
 * 函数 —— 它自己不做解析，只负责"库里的一项 → 对应集合"。
 *
 * 踩过的坑
 * 这两个函数的顺序不能反：`loadPresetLibrary` 内部会调
 * `restorePresetSelection`（恢复上次选择），而恢复要在库加载完之后。
 */

import type { FieldPresetBlock } from '@tcs/shared';
import type { PresetLibraryItem } from '../rules/preset-store';
import type { PresetPersistence } from '../rules/preset-persist';

import { isShellAvailable } from '../contract';
import {
  importFieldPreset,
  importTxtPreset,
  importWorldbookPreset,
} from '../rules/preset-library';
import { importHighlightScheme, importPlatformRule } from '../rules/rule-library';
import { fieldPresetsOf } from './import-actions';
import { firstIssue } from './error-text';
import { restorePresetSelection } from './preset-restore';

/**
 * 功能
 * 本模块能碰的预设状态与动作。
 *
 * 注意事项
 * 四个集合可写（应用库项就是往集合里塞），`presetStoreReady` 也可写
 * —— 加载完成后要把闸门打开。
 *
 * 踩过的坑
 * 无。
 */
export interface LibraryHost {
  /** 平台预设集合 */
  greetingPresets: import('@tcs/shared').FieldPreset[];
  /** 对话示例预设集合 */
  chatExamplePresets: import('@tcs/shared').FieldPreset[];
  /** 世界书预设集合 */
  worldbookPresets: import('@tcs/shared').WorldbookPreset[];
  /** 规则集（含字段预设） */
  rules: import('./rules').Ruleset | null;
  /** 预设持久化 */
  readonly presetStore: PresetPersistence;
  /** 持久化是否已就绪。加载完置真 */
  presetStoreReady: boolean;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 导入模块的接入点 */
  importHost(): import('./import-actions').ImportHost;
  /** 预设恢复的接入点 */
  presetRestoreHost(): import('./preset-restore').PresetRestoreHost;
}

export async function loadPresetLibrary(host: LibraryHost): Promise<void> {
  /*
   * 浏览器直开（无壳）没有配置文件也没有预设库 —— 不是错误。
   * 不加这一层，每次刷新页面都会在状态栏留一条"预设库读取失败"，
   * 而那是故意不支持的场景（截图/验收才用浏览器）。
   */
  if (!isShellAvailable()) {
    host.presetStoreReady = true;
    return;
  }

  const loaded = await host.presetStore.load();
  host.presetStoreReady = true;

  const problems: string[] = [...loaded.warnings];
  for (const item of loaded.items) {
    const problem = applyLibraryItem(host, item);
    if (problem !== null) {
      const label = item.name !== '' ? item.name : (item.id ?? '(未命名)');
      problems.push(`预设库里的 ${item.kind}「${label}」未能加载：${problem}`);
    }
  }

  const selectionProblems = await restorePresetSelection(host.presetRestoreHost());
  problems.push(...selectionProblems);

  if (problems.length > 0) {
    host.setStatus(problems.join('；'), 'warn');
    // 同时进控制台：状态栏只显示一行，长内容会被截断
    console.warn('[presets] 预设库加载问题：', problems);
  }
}

export function applyLibraryItem(host: LibraryHost, item: PresetLibraryItem): string | null {
  if (!host.rules) return '规则尚未加载';
  switch (item.kind) {
    case 'platform': {
      const outcome = importPlatformRule(host.rules.platformFiles, item.text);
      if (!outcome.ok) return firstIssue(outcome.issues);
      const platformSourceText = { ...host.rules.platformSourceText };
      if (outcome.id) platformSourceText[outcome.id] = item.text;
      host.rules = { ...host.rules, platformFiles: outcome.value, platformSourceText };
      return null;
    }
    case 'highlight': {
      const outcome = importHighlightScheme(
        host.rules.highlightFile,
        host.rules.highlightFiles,
        item.text,
      );
      if (!outcome.ok || !outcome.value || outcome.id === null) return firstIssue(outcome.issues);
      host.rules = {
        ...host.rules,
        highlightFiles: [
          ...host.rules.highlightFiles.filter((file) => file.id !== outcome.id),
          outcome.value,
        ],
        highlightSourceText: { ...host.rules.highlightSourceText, [outcome.id]: item.text },
      };
      return null;
    }
    case 'txt': {
      const outcome = importTxtPreset(host.rules.presets, item.text);
      if (!outcome.ok) return firstIssue(outcome.issues);
      host.rules = { ...host.rules, presets: outcome.value };
      return null;
    }
    case 'worldbook': {
      const outcome = importWorldbookPreset(host.worldbookPresets, item.text);
      if (!outcome.ok) return firstIssue(outcome.issues);
      host.worldbookPresets = outcome.value;
      return null;
    }
    case 'greeting':
    case 'chat-examples': {
      const block: FieldPresetBlock = item.kind === 'greeting' ? 'initial-scene' : 'chat-examples';
      const outcome = importFieldPreset(fieldPresetsOf(host.importHost(), block), item.text, block);
      if (!outcome.ok) return firstIssue(outcome.issues);
      if (block === 'initial-scene') host.greetingPresets = outcome.value;
      else host.chatExamplePresets = outcome.value;
      return null;
    }
  }
}