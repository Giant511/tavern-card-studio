/**
 * 导入流程的纯逻辑（T10.9）：TXT 角色卡 / 世界书。
 *
 * 为什么单独一层：这一层要做的是**判断"能不能导"以及"导完的卡长什么样"**，
 * 而这两件事都会直接影响文档模型（板块缺省标记、世界书 entries 合并）。
 * 放进对话框里就只能靠截图验；放这里能单测。
 *
 * 三条与既有决策对齐的硬规则：
 *
 *  1. **TXT 角色卡没有 JSON 信封** —— 整篇就是文本，按**当前预设**切板块
 *     （`applyCardText` 已实现，严格/宽松的语义见 docs/06）。这里不重新发明。
 *  2. **世界书导入失败绝不写回** —— 残缺结果会把"没解析出来的条目"当成
 *     "用户删除"，一次导入能清空整个世界书（docs/04 §5 的调用前置条件）。
 *  3. **世界书导入口的 rawText 要留住** —— 未改动时按原文逐字节写回，
 *     这是"JSON 往返无损"的唯一可靠实现（见 shared/format/worldbook-io.ts）。
 */

import {
  exportWorldbook,
  importWorldbook,
  renderWorldbookText,
  type UnifiedCard,
  type WorldbookExportResult,
  type WorldbookFormat,
  type WorldbookImportResult,
  type TxtPreset,
} from '@tcs/shared';

// 带 .ts 后缀：Node 的类型剥离下裸扩展名无法解析（本仓库测试统一走这种写法）
import { importCardText } from './block-doc.ts';

export type ImportMode = 'strict' | 'lenient';

export interface ImportIssueView {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  line?: number;
  hint?: string;
}

export interface CardTextPreview {
  kind: 'card-text';
  mode: ImportMode;
  /** 结果为 null 表示严格模式下被拒绝（缺板块等） */
  card: UnifiedCard | null;
  canImport: boolean;
  issues: ImportIssueView[];
  /** 宽松模式下被填为空的板块（要明确告诉用户"这些是空的"） */
  missingBlocks: string[];
  /** 识别到的世界书条目数（TXT 里可能带世界书段） */
  worldbookEntries: number;
}

/**
 * 预览 TXT 角色卡导入。
 *
 * `mode` 由界面切换：严格失败时用户可以切到宽松再试 —— 这正是 docs/06 的
 * 两模式语义，不是"严格失败就报错结束"。
 */
export function previewCardText(
  card: UnifiedCard,
  text: string,
  preset: TxtPreset,
  mode: ImportMode,
): CardTextPreview {
  const result = importCardText(card, text, preset, mode);
  const issues: ImportIssueView[] = result.issues.map((issue) => ({
    // 只有「缺板块」这一条会随模式改变级别：严格是 error（导入中止），
    // 宽松是 warning（按空块处理）。其它问题（重复标题、未知标题）与模式无关。
    severity: issue.code === 'missing-block' ? (mode === 'strict' ? 'error' : 'warning') : 'warning',
    code: issue.code,
    message: issue.message,
    ...(issue.line === undefined ? {} : { line: issue.line }),
  }));

  const missingBlocks = (result.card?.blocks ?? [])
    .filter((block) => block.missing === true)
    .map((block) => block.id);

  return {
    kind: 'card-text',
    mode,
    card: result.card,
    canImport: result.card !== null,
    issues,
    missingBlocks,
    worldbookEntries: result.card?.worldbook.entries.length ?? 0,
  };
}

export interface WorldbookPreview {
  kind: 'worldbook';
  format: WorldbookFormat | null;
  canImport: boolean;
  entryCount: number;
  /** 导入结果（成功时用于写回卡片，并作为 rawText 的来源） */
  result: WorldbookImportResult;
  issues: ImportIssueView[];
}

export function previewWorldbook(text: string): WorldbookPreview {
  const result = importWorldbook(text);
  return {
    kind: 'worldbook',
    format: result.format,
    canImport: result.ok && result.entries.length > 0,
    entryCount: result.entries.length,
    result,
    issues: result.issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      ...(issue.line === undefined ? {} : { line: issue.line }),
      ...(issue.hint === undefined ? {} : { hint: issue.hint }),
    })),
  };
}

/**
 * 把世界书导入结果写进卡片。
 *
 * 返回 null = 拒绝写入（结果不可信），调用方必须提示而不是"导了个空的"。
 *
 * 写入内容三样：
 *   · `entries`：解析出的条目（带未知键，不丢字段）；
 *   · `raw`：JSON 里的周边字段（name / scan_depth / extensions），导出时原样带出；
 *   · `text`：渲染成冻结格式的 TXT，编辑器里立刻能看到条目 ——
 *     这比显示"3 个条目"更可靠，用户能直接核对内容。
 */
export function applyWorldbookImport(
  card: UnifiedCard,
  preview: WorldbookPreview,
): UnifiedCard | null {
  if (!preview.canImport || !preview.result.ok) return null;

  const { entries, meta } = preview.result;
  return {
    ...card,
    worldbook: {
      entries,
      text: renderWorldbookText(entries),
      dirty: false,
      raw: { ...meta, entries },
    },
  };
}

/**
 * 导出世界书（双向的另一半）。
 *
 * `format` 由用户选（JSON / TXT）。JSON 在"未改动"时走原文写回 ——
 * 需求要求「JSON → 导入 → 导出 → 逐字节一致」，这条是唯一可靠的实现方式：
 * 用户文件的缩进、键顺序、转义风格都是他自己的，重排一遍等于把
 * "打开又保存"变成整篇 diff。
 */
export function exportWorldbookText(
  card: UnifiedCard,
  format: WorldbookFormat,
  source: WorldbookImportResult | null,
): WorldbookExportResult {
  const raw = card.worldbook.raw;
  const meta: Record<string, unknown> = {};
  if (raw !== null) {
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'entries') continue;
      meta[key] = value;
    }
  }
  return exportWorldbook({ entries: card.worldbook.entries, meta, format, source });
}

/** 导出建议文件名：角色名 + 后缀（非法字符替换掉，避免 Windows 上存不下来） */
export function suggestWorldbookFileName(card: UnifiedCard, format: WorldbookFormat): string {
  const base = (card.meta.name || '世界书').replace(/[\\/:*?"<>|]/g, '_').trim() || '世界书';
  return `${base}-世界书.${format}`;
}
