/**
 * T4.3 格式规范检查。
 *
 * 三类检查，产出的都是带完整位置的 AuditIssue（T4.4 位置契约）：
 *   1. **JSON 合法性**：序列化 → 字符串 → 重新解析必须成立；给了原始文本则先验证原始文本可解析；
 *      另做一次「未编辑板块的原文自洽」检查（assemble 结果必须等于导入原文）。
 *   2. **TXT 分块是否符合当前预设**：标题别名、标题装饰符、板块顺序、分隔符、结构缺失。
 *      顺序/装饰符偏差只给 `info`——按阶段 2 的决定，导出不主动重排，只有点「应用预设」才重排。
 *   3. **世界书格式**：TXT 解析错误（重复 id 等）+ 结构化条目 id 重复。
 *
 * **缺省字段的处理（关键）**：有 SillyTavern 缺省值但未写出的字段（constant / insertion_order …）
 * 只产出 **一条 info 级提示**，绝不当 error、绝不计入 exportable=false。
 * 与 T4.2 两级语义同源：真正必填且无缺省值的字段缺失才报 error。
 */

import type { TxtPreset } from '../format/preset.js';
import { descriptionOrderOf, headingTextFor } from '../format/preset.js';
import { assembleDescription } from '../format/description.js';
import { parseWorldbookText } from '../format/worldbook.js';
import { stringifyStCard } from '../format/sillytavern-io.js';
import { BLOCK_IDS } from '../model/blocks.js';
import type { BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import { lineTextAt } from '../text/count.js';
import { makeAuditIssue } from './issue.js';
import { collectOmittedDefaults } from './st-defaults.js';
import type { AuditIssue } from './types.js';

/** description 板块（性格独占 personality、世界书独占 character_book，不参与分块检查） */
const TXT_BLOCK_IDS: readonly BlockId[] = ['basic', 'settings', 'special', 'user'];

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}

// ---------------------------------------------------------------- 1. JSON 合法性

export function checkJsonValidity(card: UnifiedCard, rawJsonText?: string | null): AuditIssue[] {
  const issues: AuditIssue[] = [];

  if (rawJsonText !== undefined && rawJsonText !== null && rawJsonText.trim() !== '') {
    try {
      JSON.parse(rawJsonText);
    } catch (error) {
      issues.push(
        makeAuditIssue({
          ruleId: 'builtin:json-invalid',
          category: 'format',
          severity: 'error',
          message: `原始文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
          hint: '导入已中止，卡片未变更',
          field: 'file',
        }),
      );
      return issues;
    }
  }

  try {
    const text = stringifyStCard(card);
    JSON.parse(text);
  } catch (error) {
    issues.push(
      makeAuditIssue({
        ruleId: 'builtin:json-serialize-invalid',
        category: 'format',
        severity: 'error',
        message: `序列化产物不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        hint: '通常是 passthrough 里混入了 undefined / BigInt / 循环引用',
        field: 'file',
      }),
    );
  }

  // 原文自洽：没有任何板块被编辑过时，重新拼装必须逐字节等于导入原文
  const dirty = card.blocks.some((block) => block.dirty);
  if (!dirty && card.description.raw !== '') {
    const rebuilt = assembleDescription(card.blocks, card.description);
    if (rebuilt !== card.description.raw) {
      issues.push(
        makeAuditIssue({
          ruleId: 'builtin:description-drift',
          category: 'format',
          severity: 'warning',
          message: '未编辑状态下重新拼装 description 与导入原文不一致，保存可能改动未编辑的字节',
          hint: '请检查是否存在重复标题或板块外自由文本',
          field: 'description',
          start: 0,
          end: 0,
          text: card.description.raw,
        }),
      );
    }
  }

  return issues;
}

// ---------------------------------------------------------------- 2. 预设符合性

export function checkPresetConformance(card: UnifiedCard, preset: TxtPreset): AuditIssue[] {
  const issues: AuditIssue[] = [];

  if (card.description.raw !== '' && !card.description.structured) {
    issues.push(
      makeAuditIssue({
        ruleId: 'builtin:description-unstructured',
        category: 'structure',
        severity: 'warning',
        message: 'description 未使用板块标题分块，编辑器将按自由文本处理（六个板块无法分别定位）',
        hint: '点「应用预设」即可按当前预设重排并补标题',
        field: 'description',
        start: 0,
        end: 0,
        text: card.description.raw,
      }),
    );
  }

  for (const blockId of TXT_BLOCK_IDS) {
    const block = card.blocks.find((item) => item.id === blockId);
    if (!block) continue;

    if (block.missing === true) {
      issues.push(
        makeAuditIssue({
          ruleId: 'builtin:block-missing',
          category: 'structure',
          severity: 'warning',
          message: `板块「${labelOf(blockId)}」在导入源中没有标题，当前按空块处理`,
          hint: '不是内容为空——是导入时根本没找到该板块，请确认后再保存',
          blockId,
          field: 'description',
          start: 0,
          end: 0,
          text: block.text,
        }),
      );
      continue;
    }

    const headingText = block.anchor?.headingText ?? null;
    if (!headingText) continue;

    const config = preset.headings?.[blockId];
    const aliases = (config?.aliases ?? []).map(normalize);
    if (aliases.length > 0 && !aliases.includes(normalize(headingText))) {
      issues.push(
        makeAuditIssue({
          ruleId: 'builtin:preset-heading-alias',
          category: 'format',
          severity: 'warning',
          message: `板块标题「${headingText}」不在当前预设的别名表中，换预设导入会识别不到该板块`,
          hint: `可用别名：${(config?.aliases ?? []).join(' / ')}`,
          blockId,
          field: 'description',
          start: 0,
          end: 0,
          text: block.text,
        }),
      );
      continue;
    }

    // 装饰符偏差：仍能解析，但与预设写法不一致（导出不会自动纠正）
    const expected = headingTextFor(preset, blockId, headingText);
    const anchor = block.anchor;
    if (anchor?.headingSpan && card.description.raw !== '') {
      const actualLine = lineTextAt(card.description.raw, anchor.headingSpan.start).trim();
      if (actualLine !== '' && actualLine !== expected.trim()) {
        issues.push(
          makeAuditIssue({
            ruleId: 'builtin:preset-heading-decorator',
            category: 'format',
            severity: 'info',
            message: `标题写法与预设不一致：当前「${actualLine}」，预设「${expected.trim()}」`,
            hint: '解析不受影响；点「应用预设」可统一装饰符。若换了预设，记得同步调整高亮方案的标题正则',
            blockId,
            field: 'description',
            start: 0,
            end: 0,
            text: block.text,
          }),
        );
      }
    }
  }

  // 板块顺序：只提示，不阻断（导出不主动重排）
  const currentOrder = descriptionOrderOf(card);
  const presetOrder = (preset.blockOrder ?? []).filter((id) => TXT_BLOCK_IDS.includes(id));
  const currentFiltered = currentOrder.filter((id) => TXT_BLOCK_IDS.includes(id));
  if (presetOrder.length > 0 && currentFiltered.join('>') !== presetOrder.join('>')) {
    issues.push(
      makeAuditIssue({
        ruleId: 'builtin:block-order',
        category: 'format',
        severity: 'info',
        message: `板块顺序与预设不一致：当前 ${currentFiltered.map(labelOf).join(' → ')}，预设 ${presetOrder.map(labelOf).join(' → ')}`,
        hint: '导出不会主动重排；点「应用预设」才会按预设重排',
        field: 'description',
      }),
    );
  }

  // 分隔符偏差
  if (card.description.structured && preset.separator && card.description.separator !== preset.separator) {
    issues.push(
      makeAuditIssue({
        ruleId: 'builtin:separator',
        category: 'format',
        severity: 'info',
        message: `板块间分隔符与预设不一致：当前 ${JSON.stringify(card.description.separator)}，预设 ${JSON.stringify(preset.separator)}`,
        field: 'description',
      }),
    );
  }

  return issues;
}

const LABELS: Readonly<Record<string, string>> = {
  basic: '基本信息',
  personality: '性格',
  settings: '其他设定',
  special: '特殊设定',
  user: '用户相关设定',
  worldbook: '世界书',
};

function labelOf(blockId: BlockId): string {
  return LABELS[blockId] ?? blockId;
}

// ---------------------------------------------------------------- 3. 世界书格式

export function checkWorldbookFormat(card: UnifiedCard): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const text = card.worldbook?.text ?? '';

  if (text.trim() !== '') {
    const parsed = parseWorldbookText(text);
    for (const problem of parsed.issues) {
      // 世界书 TXT 就是用户编辑的文本，按行号换算成偏移，客户端可直接选中整行
      const offset = problem.line ? offsetOfLine(text, problem.line) : null;
      const length = offset === null ? 0 : lineTextAt(text, offset).length;
      issues.push(
        makeAuditIssue({
          ruleId: `builtin:worldbook-${problem.code}`,
          category: 'format',
          severity: problem.severity,
          message: problem.message,
          hint: problem.code === 'duplicate-id' ? '重复 id 不会静默合并，请先修正再保存' : undefined,
          blockId: 'worldbook',
          field: 'character_book',
          start: offset,
          end: offset === null ? null : offset + length,
          text,
          entryId: problem.entryId ?? null,
        }),
      );
    }
  }

  // 结构化侧：条目 id 重复（TXT 可能还没重新渲染）
  const seen = new Map<number, number>();
  for (const entry of card.worldbook?.entries ?? []) {
    if (typeof entry.id !== 'number') continue;
    const count = (seen.get(entry.id) ?? 0) + 1;
    seen.set(entry.id, count);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push(
        makeAuditIssue({
          ruleId: 'builtin:worldbook-duplicate-entry-id',
          category: 'format',
          severity: 'error',
          message: `世界书存在重复条目 id ${id}（${count} 条）`,
          hint: '条目按 id 合并，重复 id 会导致 extensions 归属不确定',
          blockId: 'worldbook',
          field: 'character_book',
          entryId: id,
        }),
      );
    }
  }

  return issues;
}

function offsetOfLine(text: string, line: number): number {
  if (line <= 1) return 0;
  let current = 1;
  let index = 0;
  while (index < text.length && current < line) {
    const char = text[index];
    if (char === '\n') {
      current += 1;
      index += 1;
    } else if (char === '\r') {
      current += 1;
      index += text[index + 1] === '\n' ? 2 : 1;
    } else index += 1;
  }
  return index;
}

// ---------------------------------------------------------------- 4. 缺省字段（info）

/**
 * 有 ST 缺省值但未写出的字段：只给一条汇总 info。
 * 这是 T4.3「对缺省字段的处理」的全部实现——不报 error、不阻断导出、不回写 JSON。
 */
export function checkStDefaults(card: UnifiedCard): AuditIssue[] {
  const omitted = collectOmittedDefaults(card);
  if (omitted.length === 0) return [];

  const detail = omitted
    .map((item) => `${item.field.label}（${item.field.path}${item.field.scope === 'entry' && item.count > 1 ? ` ×${item.count}` : ''}）`)
    .join('、');

  return [
    makeAuditIssue({
      ruleId: 'builtin:st-defaults-omitted',
      category: 'format',
      severity: 'info',
      message: `${omitted.length} 个字段未写出，导出时由目标平台按缺省值处理：${detail}`,
      hint: '这是预期行为：工具不注入缺省值，避免版本 diff 噪声',
      field: 'file',
    }),
  ];
}

// ---------------------------------------------------------------- 汇总

export interface FormatCheckOptions {
  preset?: TxtPreset | null;
  /** 原始 JSON 文本（有则先验证其可解析性） */
  rawJsonText?: string | null;
  /** 是否产出缺省字段提示，默认 true */
  includeStDefaults?: boolean;
}

export function checkFormat(card: UnifiedCard, options: FormatCheckOptions = {}): AuditIssue[] {
  const issues = [...checkJsonValidity(card, options.rawJsonText), ...checkWorldbookFormat(card)];
  if (options.includeStDefaults !== false) issues.push(...checkStDefaults(card));
  if (options.preset) issues.push(...checkPresetConformance(card, options.preset));
  return issues;
}
