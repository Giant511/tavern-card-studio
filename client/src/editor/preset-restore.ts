/**
 * 功能
 * 启动时把上一次的预设选择恢复回来：平台规则、高亮方案、开场白、
 * 对话示例、世界书、字段预设。从 EditorApp 搬出，1 个函数 82 行。
 *
 * 注意事项
 * 每一项都做「存在性检查」：配置里记的 id 可能已经被删（用户删了自定义预设），
 * 这时**回到默认值并记一条 problems**，而不是抛错中断启动。
 * 调用方把这些 problems 显示成一条启动提示 —— 用户需要知道"你的选择没了"。
 *
 * 全函数**只读 config、只写内存**，不落盘。落盘在 `persistSelection` 里，
 * 两者分开是为了避免"恢复过程本身触发一次保存"。
 *
 * 踩过的坑
 * 不用 `config.xxx ?? 默认值` 判断 —— 配置项里 `null` 是合法的
 * "用户明确选了默认"，与"没这一项"（undefined）语义不同。
 */

import type { FieldPreset, WorldbookPreset } from '@tcs/shared';
import type { Ruleset } from './rules';

import {
  compileHighlightRule,
  DEFAULT_WORLDBOOK_PRESET,
  resolveHighlightRule,
  resolvePlatformRule,
} from '@tcs/shared';

import { configGet } from '../contract';
import { describeError } from './error-text';
import { applySchemeStyles } from './highlight';

/**
 * 功能
 * 本模块能碰的预设状态。
 *
 * 注意事项
 * 八个字段全部**可写**：恢复就是往这些字段上赋值。没有一个是只读的 ——
 * 如果将来只需要读，那说明这个函数不该存在。
 *
 * 踩过的坑
 * `greetingPreset`（当前选中）与 `greetingPresets`（全部）名字只差一个 s，
 * 世界书那对也是。少写一个不会报错（对象里有另一个），但恢复会失效。
 */
export interface PresetRestoreHost {
  /** 规则集（平台与高亮都在里面） */
  rules: Ruleset | null;
  /** 当前开场白预设 */
  greetingPreset: FieldPreset;
  /** 全部开场白预设 */
  greetingPresets: FieldPreset[];
  /** 当前对话示例预设 */
  chatExamplePreset: FieldPreset;
  /** 全部对话示例预设 */
  chatExamplePresets: FieldPreset[];
  /** 当前世界书预设 */
  worldbookPreset: WorldbookPreset;
  /** 全部世界书预设 */
  worldbookPresets: WorldbookPreset[];
  /** 已开会话（恢复后要把世界书格式同步进去） */
  readonly sessions: readonly import('../session/card-session').CardSession[];
}

export async function restorePresetSelection(host: PresetRestoreHost): Promise<string[]> {
  if (!host.rules) return [];
  let config;
  try {
    config = await configGet();
  } catch {
    // 浏览器直开：没有配置可读，不算问题
    return [];
  }

  const problems: string[] = [];

  // ── 平台规则 ──
  if (config.platformRuleId !== null && config.platformRuleId !== host.rules.platformId) {
    try {
      const resolved = resolvePlatformRule(config.platformRuleId, host.rules.platformFiles);
      host.rules = { ...host.rules, platform: resolved, platformId: config.platformRuleId };
    } catch {
      problems.push(`上次使用的平台规则「${config.platformRuleId}」已不存在，已回到「${host.rules.platformId}」`);
    }
  }

  // ── 高亮方案 ──
  if (config.highlightSchemeId !== null && config.highlightSchemeId !== host.rules.highlightId) {
    const file = host.rules.highlightFiles.find((item) => item.id === config.highlightSchemeId);
    if (file === undefined) {
      problems.push(`上次使用的高亮方案「${config.highlightSchemeId}」已不存在，已回到「${host.rules.highlightId}」`);
    } else {
      try {
        const compiled = compileHighlightRule(resolveHighlightRule(file.id, host.rules.highlightFiles));
        host.rules = { ...host.rules, highlight: compiled, highlightFile: file, highlightId: file.id };
        applySchemeStyles(file);
      } catch (error) {
        problems.push(`高亮方案「${file.id}」编译失败已回退：${describeError(error)}`);
      }
    }
  }

  // ── TXT 预设 ──
  if (config.presetId !== null) {
    const preset = host.rules.presets.find((item) => item.id === config.presetId);
    if (preset === undefined) {
      problems.push(`上次使用的 TXT 预设「${config.presetId}」已不存在，继续用当前的`);
    } else {
      host.rules = { ...host.rules, preset };
    }
  }

  // ── 世界书格式预设 ──
  if (config.worldbookPresetId !== null) {
    const preset = host.worldbookPresets.find((item) => item.id === config.worldbookPresetId);
    if (preset === undefined) {
      problems.push(`上次使用的世界书格式「${config.worldbookPresetId}」已不存在，继续用内置格式`);
    } else {
      host.worldbookPreset = preset;
    }
  }

  // ── 初始场景 / 对话示例格式预设 ──
  if (config.greetingPresetId !== null) {
    const preset = host.greetingPresets.find((item) => item.id === config.greetingPresetId);
    if (preset === undefined) {
      problems.push(`上次使用的初始场景格式「${config.greetingPresetId}」已不存在，继续用内置格式`);
    } else {
      host.greetingPreset = preset;
    }
  }
  if (config.chatExamplePresetId !== null) {
    const preset = host.chatExamplePresets.find((item) => item.id === config.chatExamplePresetId);
    if (preset === undefined) {
      problems.push(`上次使用的对话示例格式「${config.chatExamplePresetId}」已不存在，继续用内置格式`);
    } else {
      host.chatExamplePreset = preset;
    }
  }

  // 会话里存着格式（编辑世界书时用它），恢复完要同步到已打开的会话
  if (host.worldbookPreset !== DEFAULT_WORLDBOOK_PRESET) {
    for (const session of host.sessions) session.setWorldbookFormat(host.worldbookPreset.format);
  }

  return problems;
}