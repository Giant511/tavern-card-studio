/**
 * T4.3 格式规范检查。
 *
 * 三类检查，产出的都是带完整位置的 AuditIssue（T4.4 位置契约）：
 *   1. **JSON 合法性**：序列化 → 字符串 → 重新解析必须成立；给了原始文本则先验证原始文本可解析；
 *      另做一次「未编辑板块的原文自洽」检查（assemble 结果必须等于导入原文）。
 *   2. **TXT 分块是否符合当前预设**：标题别名、标题装饰符、板块顺序、分隔符、结构缺失。
 *      顺序/装饰符偏差只给 `info`——按阶段 2 的决定，导出不主动重排，只有点「应用预设」才重排。
 *   3. **世界书**（T10.9 起独立成 `worldbook` 类别）：TXT 解析错误、条目结构、
 *      id（重复/非整数/缺失）、触发键（无关键词又非常驻 = 永不触发）。
 *
 * **缺省字段的处理（关键）**：有 SillyTavern 缺省值但未写出的字段（constant / insertion_order …）
 * 只产出 **一条 info 级提示**，绝不当 error、绝不计入 exportable=false。
 * 与 T4.2 两级语义同源：真正必填且无缺省值的字段缺失才报 error。
 */

import type { TxtPreset } from '../format/preset.js';
import { descriptionOrderOf, headingTextFor } from '../format/preset.js';
import { assembleDescription } from '../format/description.js';
import { parseWorldbookTextWith } from '../format/worldbook.js';
import { DEFAULT_WORLDBOOK_FORMAT, type WorldbookFormatParams } from '../format/worldbook-preset.js';
import { stringifyStCard } from '../format/sillytavern-io.js';
import { BLOCK_IDS } from '../model/blocks.js';
import type { BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import { lineTextAt } from '../text/count.js';
import { validateWorldbookRules } from '../rules/platform-rule-engine.js';
import type { ResolvedPlatformRule } from '../rules/platform-rule.js';
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

// ---------------------------------------------------------------- 3. 世界书
//
// T10.9 起这一路单独成类别（`worldbook`）。T10.33 起它分成两半，**职责不重叠**：
//
//   ① **结构**（本文件）：TXT 解析问题（标记不闭合、重复 id、未知字段……）、
//      条目 id 的完整性与唯一性、字段**类型**（content 必须是字符串、keys 必须是数组）。
//      这些是"数据坏了"，规则引擎表达不了，也不该表达 —— 它们与平台规范无关。
//
//   ② **语义**（`rules/worldbook-checks.ts` 的默认规则集，由规则引擎求值）：
//      触发键、空关键词、selective 与次级键、position 取值、insertion_order 非负。
//      这些是"SillyTavern 的规范要求"，用户要能覆盖、追加、禁用其中单条。
//
// **去重铁律**：同一判据只能出现在一边。T10.9 的硬编码语义检查已整段删除
// （不是注释掉、不是保留成"参考实现"）—— 留着它就会变成两套口径，
// 而"同一违规报两遍"和"各报一半"都是不可接受的失败。

export function checkWorldbookFormat(
  card: UnifiedCard,
  options: {
    platformRule?: ResolvedPlatformRule | null;
    /** 世界书格式预设（T10.31）：格式**解析**按它走，否则自定义预设的文件会被误报语法错误 */
    worldbookFormat?: WorldbookFormatParams;
  } = {},
): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const text = card.worldbook?.text ?? '';

  if (text.trim() !== '') {
    const parsed = parseWorldbookTextWith(text, options.worldbookFormat ?? DEFAULT_WORLDBOOK_FORMAT);
    for (const problem of parsed.issues) {
      // 世界书 TXT 就是用户编辑的文本，按行号换算成偏移，客户端可直接选中整行
      const offset = problem.line ? offsetOfLine(text, problem.line) : null;
      const length = offset === null ? 0 : lineTextAt(text, offset).length;
      issues.push(
        makeAuditIssue({
          ruleId: `builtin:worldbook-${problem.code}`,
          category: 'worldbook',
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

  // 结构化侧：TXT 可能还没重新渲染（例如刚从 JSON 导入）
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
          category: 'worldbook',
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

  issues.push(...checkWorldbookStructure(card));

  // 语义：默认规则集 + 当前平台规则里的世界书规则，走同一个引擎
  if (options.platformRule) issues.push(...validateWorldbookRules(card, options.platformRule));

  return issues;
}

/**
 * 条目 id 与**字段类型**（T10.9 的"结构"部分，T10.33 后只剩这些）。
 *
 * 语义判据（触发键 / 空关键词 / selective / position / insertion_order）已迁到
 * `rules/worldbook-checks.ts` 的规则集 —— 见文件上方"去重铁律"。
 */
export function checkWorldbookStructure(card: UnifiedCard): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const entries = card.worldbook?.entries ?? [];

  const bump = (
    ruleId: string,
    severity: 'error' | 'warning' | 'info',
    message: string,
    extra: { entryId?: number | null; entryIndex?: number | null; hint?: string } = {},
  ): void => {
    issues.push(
      makeAuditIssue({
        ruleId,
        category: 'worldbook',
        severity,
        message,
        hint: extra.hint,
        blockId: 'worldbook',
        field: 'character_book',
        entryId: extra.entryId ?? null,
        // 没有 id 的条目只能靠序号定位，否则"第 2 条没有 id"这条问题无处可指
        entryIndex: extra.entryId === undefined || extra.entryId === null ? (extra.entryIndex ?? null) : null,
      }),
    );
  };

  entries.forEach((entry, index) => {
    // 所有单条目问题都带序号：没有 id 的条目（或 id 本身不合法）只能靠序号定位，
    // 否则同一条规则在多条目上会产出相同的问题 id，客户端差量更新会互相顶掉。
    const bumpAt = (ruleId: string, severity: 'error' | 'warning' | 'info', message: string, extra: { entryId?: number | null; hint?: string } = {}): void =>
      bump(ruleId, severity, message, { ...extra, entryIndex: index });
    const label = entry.name?.trim() ? `「${entry.name.trim()}」` : `第 ${String(index + 1)} 条`;
    const entryId = typeof entry.id === 'number' ? entry.id : null;

    // ── id ──
    if (entry.id === undefined) {
      bumpAt('builtin:worldbook-entry-missing-id', 'warning', `世界书${label}没有 id，导出时会自动补号`, {
        hint: '补号会写入文件；若要固定编号，请在导入的 JSON 里显式给出 id',
      });
    } else if (typeof entry.id !== 'number' || !Number.isInteger(entry.id) || entry.id < 0) {
      bumpAt('builtin:worldbook-entry-bad-id', 'error', `世界书${label}的 id 不是非负整数：${JSON.stringify(entry.id)}`, {
        entryId,
        hint: 'id 是合并锚点，必须是 0、1、2…… 这样的整数',
      });
    }

    // ── 类型：正文 ──
    if (typeof entry.content !== 'string') {
      bumpAt('builtin:worldbook-entry-bad-content', 'error', `世界书${label}的正文不是字符串`, { entryId });
    }

    // ── 类型：关键词 ──
    if (!Array.isArray(entry.keys)) {
      bumpAt('builtin:worldbook-entry-bad-keys', 'error', `世界书${label}的 keys 不是数组`, {
        entryId,
        hint: '单关键词也要写成数组： "keys": ["银座"]',
      });
    }
  });

  // ── 世界书整体：条目数上限（ST 运行时按 token 预算扫描，条目过多会拖慢生成）──
  // 这条不是单条目语义，规则引擎的"逐条目求值"表达不了，留在结构侧。
  if (entries.length > 200) {
    bump('builtin:worldbook-too-many-entries', 'info', `世界书共有 ${String(entries.length)} 个条目`, {
      hint: '条目越多扫描越慢；建议把长期用不到的分到别的世界书',
    });
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
  /** 世界书格式预设参数（T10.31）；缺省 = v1.0 冻结格式 */
  worldbookFormat?: WorldbookFormatParams;
  /**
   * 当前平台规则（T10.33）。
   *
   * 传了它，世界书的**语义**检查才跑（默认规则集 + 用户声明的世界书规则）；
   * 不传则只有结构检查 —— 这是刻意的：拿不到规则时凭空造一套语义，
   * 会让"审计通过"与"编辑器实时校验通过"两处判据不一致。
   */
  platformRule?: ResolvedPlatformRule | null;
  /** 原始 JSON 文本（有则先验证其可解析性） */
  rawJsonText?: string | null;
  /** 是否产出缺省字段提示，默认 true */
  includeStDefaults?: boolean;
}

export function checkFormat(card: UnifiedCard, options: FormatCheckOptions = {}): AuditIssue[] {
  const issues = [
    ...checkJsonValidity(card, options.rawJsonText),
    ...checkWorldbookFormat(card, {
      platformRule: options.platformRule ?? null,
      ...(options.worldbookFormat ? { worldbookFormat: options.worldbookFormat } : {}),
    }),
  ];
  if (options.includeStDefaults !== false) issues.push(...checkStDefaults(card));
  if (options.preset) issues.push(...checkPresetConformance(card, options.preset));
  return issues;
}
