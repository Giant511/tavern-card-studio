/**
 * 规则资产加载。
 *
 * 两条路径，结果同构（都是「已解析的 JSON 对象数组」，交给 shared 统一校验）：
 *   1. 壳内：走契约 scanRuleDir + readRuleText（读 $RESOURCE/rules，可在不发版的情况下替换规则）；
 *   2. 浏览器：用 Vite 打包进来的 rules/*.json（开发、性能测试、截图用）。
 *
 * 注意：这里**不解析规则语义**，只负责「拿到 JSON 对象」。校验、继承合并、编译
 * 全部交给 shared（loadPlatformRules / loadHighlightRules / loadPresets），保持单一实现。
 */

import {
  compileHighlightRule,
  findPreset,
  loadHighlightRules,
  loadPlatformRules,
  loadPresets,
  resolveHighlightRule,
  resolvePlatformRule,
  type CompiledHighlightRule,
  type HighlightRuleFile,
  type PlatformRuleFile,
  type ResolvedPlatformRule,
  type TxtPreset,
} from '@tcs/shared';

import { isShellAvailable, readRuleText, scanRuleDir, type RuleKind } from '../contract';

import chub from '../../../rules/platforms/chub.json';
import characterCardV2 from '../../../rules/platforms/character-card-v2.json';
import characterCardV3 from '../../../rules/platforms/character-card-v3.json';
import janitorai from '../../../rules/platforms/janitorai.json';
import sillytavern from '../../../rules/platforms/sillytavern.json';
import presetDefault from '../../../rules/presets/default.json';
import presetDivider from '../../../rules/presets/divider.json';
import presetMarkdown from '../../../rules/presets/markdown.json';
import highlightDefault from '../../../rules/highlight/default.json';
import highlightDark from '../../../rules/highlight/dark.json';
import highlightMinimal from '../../../rules/highlight/minimal.json';

/** 浏览器回退：构建期打包进来的规则资产 */
const BUNDLED: Record<RuleKind, unknown[]> = {
  platforms: [sillytavern, characterCardV2, characterCardV3, janitorai, chub],
  presets: [presetDefault, presetDivider, presetMarkdown],
  highlight: [highlightDefault, highlightDark, highlightMinimal],
};

export interface RuleSource {
  items: unknown[];
  /** shell = 读自 $RESOURCE/rules；bundled = 打包进前端的副本 */
  source: 'shell' | 'bundled';
  names: string[];
}

export async function loadRuleSource(kind: RuleKind): Promise<RuleSource> {
  if (isShellAvailable()) {
    try {
      const scan = await scanRuleDir(kind);
      const items: unknown[] = [];
      const names: string[] = [];
      for (const entry of scan.entries) {
        const file = await readRuleText(kind, entry.name);
        items.push(JSON.parse(file.text) as unknown);
        names.push(entry.name);
      }
      if (items.length > 0) {
        return { items, source: 'shell', names };
      }
    } catch (error) {
      // 壳里读不到就退回打包副本，并在控制台留下原因（不打断用户编辑）
      console.warn(`[rules] 从壳读取 ${kind} 失败，改用打包副本：`, error);
    }
  }
  return { items: BUNDLED[kind], source: 'bundled', names: [`builtin:${kind}`] };
}

export interface Ruleset {
  platform: ResolvedPlatformRule;
  platformId: string;
  highlight: CompiledHighlightRule;
  /** 原始方案（配色/字重由此生成 CSS，见 highlight.ts::applySchemeStyles） */
  highlightFile: HighlightRuleFile;
  highlightId: string;
  presets: TxtPreset[];
  preset: TxtPreset | null;
  /** 加载过程中的问题（规则文件坏掉时提示用户，而不是静默降级） */
  warnings: string[];
  sources: Record<RuleKind, RuleSource['source']>;

  /**
   * 以下四项是 T6.3 所需：切换规则与导入都要拿到**全部候选**以及**原始 JSON 文本**。
   * 只给编译结果（platform / highlight）是不够的——导入后要把新文件并进集合重新 resolve，
   * 导出时又要原样吐回用户当时导入的文本（不能从编译结果反推，否则丢注释与键序）。
   */
  platformFiles: PlatformRuleFile[];
  highlightFiles: HighlightRuleFile[];
  /** 原始 JSON 文本，按 id 索引；用于「导出当前规则」逐字节还原 */
  platformSourceText: Record<string, string>;
  highlightSourceText: Record<string, string>;
}

export const DEFAULT_PLATFORM_ID = 'sillytavern';
export const DEFAULT_HIGHLIGHT_ID = 'default';
export const DEFAULT_PRESET_ID = 'default';

/** 一次性把三类规则装好并编译 */
export async function buildRuleset(): Promise<Ruleset> {
  const warnings: string[] = [];

  const platforms = await loadRuleSource('platforms');
  const platformLoad = loadPlatformRules(platforms.items);
  if (platformLoad.errors.length > 0) {
    warnings.push(
      `平台规则有 ${platformLoad.errors.length} 个文件未通过校验：` +
        platformLoad.errors.map((e) => `#${e.index}${e.id ? `(${e.id})` : ''}`).join(', '),
    );
  }

  const platform = resolvePlatformRule(DEFAULT_PLATFORM_ID, platformLoad.rules);

  // 保留原始文本：导出时要原样吐出，不能从解析结果重新序列化（会丢注释、改键序）
  const platformSourceText: Record<string, string> = {};
  for (const item of platformLoad.rules) {
    const raw = platforms.items.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as Record<string, unknown>)['id'] === item.id,
    );
    if (raw !== undefined) platformSourceText[item.id] = JSON.stringify(raw, null, 2);
  }

  const highlights = await loadRuleSource('highlight');
  const highlightLoad = loadHighlightRules(highlights.items);
  if (highlightLoad.errors.length > 0) {
    warnings.push(`高亮规则有 ${highlightLoad.errors.length} 个文件未通过校验`);
  }
  const highlightFile: HighlightRuleFile =
    highlightLoad.rules.find((rule) => rule.id === DEFAULT_HIGHLIGHT_ID) ?? highlightLoad.rules[0]!;
  const highlight = compileHighlightRule(resolveHighlightRule(highlightFile.id, highlightLoad.rules));

  const highlightSourceText: Record<string, string> = {};
  for (const item of highlightLoad.rules) {
    const raw = highlights.items.find(
      (candidate) =>
        typeof candidate === 'object' &&
        candidate !== null &&
        (candidate as Record<string, unknown>)['id'] === item.id,
    );
    if (raw !== undefined) highlightSourceText[item.id] = JSON.stringify(raw, null, 2);
  }

  const presetsSource = await loadRuleSource('presets');
  const presetLoad = loadPresets(presetsSource.items);
  if (presetLoad.errors.length > 0) {
    warnings.push(`预设格式有 ${presetLoad.errors.length} 个文件未通过校验`);
  }
  const preset = findPreset(presetLoad.presets, DEFAULT_PRESET_ID) ?? presetLoad.presets[0] ?? null;

  return {
    platform,
    platformId: platform.id,
    highlight,
    highlightFile,
    highlightId: highlightFile.id,
    presets: presetLoad.presets,
    preset,
    warnings,
    sources: {
      platforms: platforms.source,
      presets: presetsSource.source,
      highlight: highlights.source,
    },
    platformFiles: platformLoad.rules,
    highlightFiles: highlightLoad.rules,
    platformSourceText,
    highlightSourceText,
  };
}
