/**
 * 功能
 * 预设文本的导入：平台、高亮、字段、TXT、世界书五种，外加世界书文件挑选
 * 与"记住这个预设"的落盘。从 EditorApp 搬出，9 个函数 159 行。
 *
 * 注意事项
 * 每个 `importXxx` 都是「解析 → 记进对应集合 → 让用户看到结果」三段。
 * 解析成功但没记进去，用户会以为导入了 —— 所以返回
 * `PresetImportOutcome`（带 issues）而不是布尔，调用方必须看 issues。
 *
 * `importPlatformText` 不只是解析：它按规则把内容切块写进编辑器。
 * 这是「标准写法 TXT」的入口，改它要连带验到达规范化。
 *
 * `rememberPreset` 在 `demoQuiet` 为 true 时**跳过落盘** —— 取证/截图期间
 * 不该把演示数据写进用户的预设库。
 *
 * 踩过的坑
 * 这些函数的参数形态不一致（有的收 text，有的收 block + text），因为字段预设
 * 要指定"导进哪一块"。合并成统一签名会逼调用方拼假参数。
 *
 * host 接口第一版我按"看起来合理"猜了 `ChatExamplePreset` / `GreetingPreset`
 * 两个类型 —— 全库都没有这两个名字。实际是 `FieldPreset`。
 * **类型不能猜，要去 grep 字段声明。**
 */

import type {
  FieldPreset,
  FieldPresetBlock,
  TxtPreset,
  UnifiedCard,
  WorldbookPreset,
} from '@tcs/shared';
import type { Ruleset } from './rules';
import {
  importTxtPreset,
  importWorldbookPreset,
  type PresetImportOutcome,
} from '../rules/preset-library';
import type { PresetKind } from '../rules/preset-store';
import type { PresetPersistence } from '../rules/preset-persist';
import type { RulesDialog } from '../rules/rules-dialog';

import { resolvePlatformRule } from '@tcs/shared';
import { pickCardFile, readTextExact } from '../contract';
import { applyWorldbookImport } from './import-flow';
import { importFieldPreset } from '../rules/preset-library';
import { importHighlightScheme, importPlatformRule } from '../rules/rule-library';

import { describeError } from './error-text';
import type { ImportDialog } from './import-dialog';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 四个预设集合都要**写**（导入就是往里塞）。`demoQuiet` 是取证模式的开关，
 * `rememberPreset` 要读它决定落不落盘。
 *
 * 踩过的坑
 * `worldbookPresets`（复数数组）与 `worldbookPreset`（当前选中）是两个字段，
 * 名字只差一个 s。第一版只声明了复数那个，编译能过但语义是错的。
 */
export interface ImportHost {
  /** 平台预设集合 */
  greetingPresets: FieldPreset[];
  /** 对话示例预设集合 */
  chatExamplePresets: FieldPreset[];
  /** 世界书预设集合（全部） */
  worldbookPresets: WorldbookPreset[];
  /** 当前选中的世界书预设 */
  worldbookPreset: WorldbookPreset;
  /** 规则集（含字段预设） */
  rules: Ruleset | null;
  /** 规则面板实例 */
  rulesDialog: RulesDialog | null;
  /** 导入面板实例 */
  importDialog: ImportDialog | null;
  /** 预设持久化（本机存储） */
  readonly presetStore: PresetPersistence;
  /** 持久化是否已就绪 */
  readonly presetStoreReady: boolean;
  /** 取证/演示模式：为 true 时不落盘 */
  readonly demoQuiet: boolean;
  /** 当前卡片（未打开时为 null） */
  readonly card: UnifiedCard;
  /** 当前会话。`hasSession` 为真时非空 */
  readonly session: import('../session/card-session').CardSession | null;
  /** 有没有打开会话 */
  readonly hasSession: boolean;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  refreshRulesLabel(): void;
  /** 把编辑器内容重新从卡里铺一遍（导入平台预设后要重铺） */
  reloadBlocksFromCard(): void;
  /** 排一次校验（防抖） */
  /** 排一次校验（防抖）。参数是延迟毫秒，0 = 立刻 */
  scheduleValidate(delayMs?: number): void;
  /** 选中某个字段预设 */
  selectFieldPreset(block: FieldPresetBlock, id: string): void;
  /** 切高亮预设（导入高亮后要应用） */
  switchHighlight(id: string): void;
  /** 立刻校验 */
  validate(): void;
}

export async function pickAndImportWorldbook(host: ImportHost): Promise<void> {
  try {
    const path = await pickCardFile(undefined, { allowText: true });
    if (!path) return;
    const file = await readTextExact(path);
    await importWorldbookFile(host, file.pathDisplay ?? path, file.text);
  } catch (error) {
    host.setStatus(`读取世界书文件失败：${describeError(error)}`, 'bad');
  }
}

export async function rememberPreset(host: ImportHost, 
  kind: PresetKind,
  name: string,
  text: string,
  id: string | null,
): Promise<void> {
  // 取证/截图演示期间不落盘：那是用户真实内容，不该被写进本机预设库
  if (host.demoQuiet) return;
  if (!host.presetStoreReady) {
    host.setStatus(
      `已导入「${id ?? name}」（本次生效）—— 预设库尚未加载完成，这次没有保存，重启会丢失`,
      'warn',
    );
    return;
  }
  const result = await host.presetStore.remember(kind, name, text, id);
  if (!result.saved) {
    host.setStatus(
      `已导入「${id ?? name}」（本次生效），但**没能保存到预设库**：${result.error ?? '未知原因'}。重启后需要重新导入。`,
      'warn',
    );
  }
}

export function importTxtPresetText(host: ImportHost, text: string): PresetImportOutcome<TxtPreset[]> {
  if (!host.rules) {
    return { ok: false, value: [], issues: [], warnings: [], id: null, name: null, replaced: false, renameHint: '' };
  }
  const outcome = importTxtPreset(host.rules.presets, text);
  if (!outcome.ok) return outcome;

  host.rules = { ...host.rules, presets: outcome.value };
  // 导入后**不切换**当前预设：导入是"加入候选"，切换是"改变导出格式"，
  // 两件事合在一起时，用户正在看的内容会突然按另一种格式重排，很难归因。
  host.refreshRulesLabel();
  /*
   * 落盘（v0.1.5 / G5）。**不 await**：导入已经在内存生效，写盘是副作用，
   * 让它卡住"导入"这个动作的响应没有好处。失败时 `rememberPreset`
   * 自己会提示，且不回滚。
   */
  void rememberPreset(host, 'txt', outcome.name ?? 'TXT 预设', text, outcome.id);
  return outcome;
}

export function importWorldbookPresetText(host: ImportHost, text: string): PresetImportOutcome<WorldbookPreset[]> {
  const outcome = importWorldbookPreset(host.worldbookPresets, text);
  if (!outcome.ok) return outcome;
  host.worldbookPresets = outcome.value;
  // 落盘（v0.1.5 / G5）：世界书格式是"分节编号 + 隐式闭合"这类外部格式的唯一载体，
  // 丢了它下次打开软件就会按默认格式解析用户的世界书 → 又变成"解析不出条目"
  void rememberPreset(host, 'worldbook', outcome.name ?? '世界书预设', text, outcome.id);
  return outcome;
}

export function fieldPresetsOf(host: ImportHost, block: FieldPresetBlock): readonly FieldPreset[] {
  return block === 'initial-scene' ? host.greetingPresets : host.chatExamplePresets;
}

export function importFieldPresetText(host: ImportHost, block: FieldPresetBlock, text: string): PresetImportOutcome<FieldPreset[]> {
  const outcome = importFieldPreset(fieldPresetsOf(host, block), text, block);
  if (!outcome.ok) return outcome;
  if (block === 'initial-scene') host.greetingPresets = outcome.value;
  else host.chatExamplePresets = outcome.value;
  /*
   * 落盘（v0.1.5 / G5）。两个板块在库里用不同 kind 分开存 ——
   * 混成一个的话，把「对话示例预设」导进「初始场景」那一栏这种错位
   * 在加载时就再也检不出来了（`importFieldPreset` 的 block 校验会白做）。
   */
  if (block === 'initial-scene') {
    void rememberPreset(host, 'greeting', outcome.name ?? '初始场景预设', text, outcome.id);
  } else {
    void rememberPreset(host, 'chat-examples', outcome.name ?? '对话示例预设', text, outcome.id);
  }
  /*
   * 导入即启用。`selectFieldPreset` 已经包含全部后续动作：
   * 重指对象 → 按新格式重算未编辑板块的视图 → 重检 → 记下选择 → 状态栏说明。
   * 自己再写一遍必然漏一项（这正是 2026-11-17 之前的状况：只更新了数组，
   * 没重指对象，也没重算视图）。
   */
  if (outcome.id !== null) host.selectFieldPreset(block, outcome.id);
  return outcome;
}

export function importPlatformText(host: ImportHost, text: string) {
  if (!host.rules) {
    return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
  }
  const outcome = importPlatformRule(host.rules.platformFiles, text);

  if (outcome.ok) {
    // 只有成功才落到 host.rules —— 这就是原子性的落点
    const platformSourceText = { ...host.rules.platformSourceText };
    if (outcome.id) platformSourceText[outcome.id] = text;
    host.rules = {
      ...host.rules,
      platformFiles: outcome.value,
      platformSourceText,
    };
    // 若当前平台被同名覆盖，重新解析一次，避免用着旧对象
    if (outcome.id === host.rules.platformId) {
      host.rules = {
        ...host.rules,
        platform: resolvePlatformRule(outcome.id, outcome.value),
      };
      host.validate();
    }
    // 落盘（v0.1.5 / G5）
    void rememberPreset(host, 'platform', outcome.name ?? '平台规则', text, outcome.id);
  }
  return outcome;
}

export function importHighlightText(host: ImportHost, text: string) {
  if (!host.rules) {
    return { ok: false, value: null, issues: [], warnings: [], id: null, name: null };
  }
  const outcome = importHighlightScheme(
    host.rules.highlightFile,
    host.rules.highlightFiles,
    text,
  );

  if (outcome.ok && outcome.value && outcome.compiled && outcome.id) {
    const highlightSourceText = { ...host.rules.highlightSourceText };
    highlightSourceText[outcome.id] = text;
    host.rules = {
      ...host.rules,
      highlightFiles: [...host.rules.highlightFiles.filter((f) => f.id !== outcome.id), outcome.value],
      highlightSourceText,
    };
    // 导入即应用：切到新方案，用户能立刻看到效果
    host.switchHighlight(outcome.id);
    host.rulesDialog?.refresh();
    // 落盘（v0.1.5 / G5）
    void rememberPreset(host, 'highlight', outcome.name ?? '高亮方案', text, outcome.id);
  }
  return outcome;
}

export async function importWorldbookFile(host: ImportHost, fileName: string, text: string): Promise<void> {
  if (!host.hasSession) {
    host.setStatus('先打开或新建一张卡，再导入世界书', 'warn');
    return;
  }
  const decision = await host.importDialog?.openWorldbook(fileName, text, host.worldbookPreset.format);
  if (!decision || !('preview' in decision)) return;

  const next = applyWorldbookImport(host.card, decision.preview);
  if (next === null) {
    host.setStatus('世界书导入被拒绝：解析结果不完整，未修改当前卡片', 'bad');
    return;
  }

  // 记下原文：未改动时导出走逐字节写回（JSON 往返无损的唯一可靠实现）
  host.session?.setWorldbookSource(decision.result);
  host.session?.replaceCard(next);
  host.reloadBlocksFromCard();
  host.scheduleValidate(0);
  host.setStatus(
    `已导入世界书：${String(decision.result.entries.length)} 个条目（格式 ${
      decision.result.format === 'json' ? 'JSON' : 'TXT'
    }），未改动时导出将逐字节还原原文`,
    'ok',
  );
}