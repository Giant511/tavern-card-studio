/**
 * 预设导入（T10.30 / T10.31）：TXT 预设与世界书预设共用同一套语义。
 *
 * 五条约束与平台规则**完全同构**（用户要求"交互与 TXT 预设完全同构"，而 TXT 预设
 * 又对齐平台规则的历史行为）：
 *
 *   1. **原子回退**：坏文件不污染现有列表 —— 失败时原样返回 current；
 *   2. **同 id 覆盖**：重复导入同一份文件不会堆出两份；
 *   3. **不自动切换**：导入后仍用原预设，用户自己选（导入是"加入候选"，不是"立刻改用"）；
 *   4. **unknown-keys warning**：沿用 F4 机制，不阻断但要报出是哪个字段；
 *   5. **改名建议**：id 与现有项只差一两个字符时提示"是不是想覆盖 xxx" ——
 *      否则用户会以为改了自己那份，实际是新增了一份而旧规则还在生效。
 */

import {
  editDistance,
  parsePreset,
  parseWorldbookPreset,
  splitRuleError,
  type RuleIssue,
  type TxtPreset,
  type WorldbookPreset,
} from '@tcs/shared';

export interface PresetImportOutcome<T> {
  ok: boolean;
  /** 生效的列表：成功是新列表，失败是传入的原列表（原子回退） */
  value: T;
  issues: RuleIssue[];
  warnings: string[];
  id: string | null;
  name: string | null;
  /** 是否覆盖了同 id 的现有项 */
  replaced: boolean;
  /** id 与现有项高度相似但不是同一个时的提示（空串表示无需提示） */
  renameHint: string;
}

function emptyOutcome<T>(current: T, issues: RuleIssue[], warnings: string[] = []): PresetImportOutcome<T> {
  return { ok: false, value: current, issues, warnings, id: null, name: null, replaced: false, renameHint: '' };
}

function parseFailure(message: string): RuleIssue[] {
  return [{ where: '', message, group: '', index: null }];
}

/**
 * 「是不是想覆盖 xxx」。阈值 2 且随长度放宽（短 id 更容易撞），与 F4 的拼写建议同源。
 */
export function suggestExistingId(id: string, existing: readonly string[]): string {
  if (existing.includes(id)) return '';
  let best: { id: string; distance: number } | null = null;
  for (const candidate of existing) {
    const distance = editDistance(id.toLowerCase(), candidate.toLowerCase());
    const limit = candidate.length <= 4 ? 1 : 2;
    if (distance <= limit && distance > 0 && (best === null || distance < best.distance)) {
      best = { id: candidate, distance };
    }
  }
  return best === null ? '' : `id "${id}" 与现有预设 "${best.id}" 很像但不是同一个 —— 想覆盖它的话请把 id 改成 "${best.id}"。`;
}

/** 导入 TXT 预设（原子） */
export function importTxtPreset(current: readonly TxtPreset[], text: string): PresetImportOutcome<TxtPreset[]> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch (error) {
    return emptyOutcome([...current], parseFailure(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`));
  }

  const result = parsePreset(parsedJson);
  if (!result.preset) return emptyOutcome([...current], result.errors.map(splitRuleError));

  const preset = result.preset;
  const existingIds = current.map((item) => item.id);
  const replaced = existingIds.includes(preset.id);
  // 同 id 覆盖（含内置）：需求明确「同 id 覆盖」，且用户导出的就是内置那份，
  // 导回来却报错会让人以为导出坏了。覆盖只在本次运行内有效 —— 重启后重新加载规则目录，
  // 内置那份会回来。这条要在 warnings 里说清，否则用户会以为改动永久生效了。
  const collidesBuiltin = current.some((item) => item.id === preset.id && item.builtin === true);
  const warnings = collidesBuiltin
    ? [...result.warnings, `已覆盖内置预设 "${preset.id}"：本次运行内生效，重启后恢复为内置版本。要长期保留请改 id。`]
    : result.warnings;

  const merged = [...current.filter((item) => item.id !== preset.id), preset];
  return {
    ok: true,
    value: merged,
    issues: [],
    warnings,
    id: preset.id,
    name: preset.name,
    replaced,
    renameHint: suggestExistingId(preset.id, existingIds),
  };
}

/** 导入世界书预设（原子） */
export function importWorldbookPreset(
  current: readonly WorldbookPreset[],
  text: string,
): PresetImportOutcome<WorldbookPreset[]> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text) as unknown;
  } catch (error) {
    return emptyOutcome([...current], parseFailure(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`));
  }

  const result = parseWorldbookPreset(parsedJson);
  if (!result.preset) return emptyOutcome([...current], result.errors.map(splitRuleError), result.warnings);

  const preset = result.preset;
  const existingIds = current.map((item) => item.id);
  const replaced = existingIds.includes(preset.id);
  const collidesBuiltin = current.some((item) => item.id === preset.id && item.builtin === true);
  const warnings = collidesBuiltin
    ? [...result.warnings, `已覆盖内置世界书预设 "${preset.id}"：本次运行内生效，重启后恢复为内置版本。`]
    : result.warnings;

  const merged = [...current.filter((item) => item.id !== preset.id), preset];
  return {
    ok: true,
    value: merged,
    issues: [],
    warnings,
    id: preset.id,
    name: preset.name,
    replaced,
    renameHint: suggestExistingId(preset.id, existingIds),
  };
}

/** 当前预设 → 可导出的完整 JSON（含用户自定义项；导出的是"当前生效的值"而不是原始文本） */
export function serializePreset(preset: TxtPreset | WorldbookPreset): string {
  return `${JSON.stringify(preset, null, 2)}\n`;
}
