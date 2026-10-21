/**
 * 导出（T6.6）——纯逻辑，无 DOM。
 *
 * 两件事：
 *   ① **导出前审计拦截**：`summary.exportable === false` 时必须让用户显式选择
 *      「仍要导出 / 取消」，不能静默放行（阶段 4 定下的语义）；
 *   ② **两种产物**：TXT 按当前预设拼装、JSON 为 SillyTavern 原生结构，
 *      均返回「待写入的文本」，由契约层 `write_file_atomic` 落盘。
 *
 * 这里不碰文件系统：落盘与回执在 app 层调契约完成，
 * 因此本文件可以在 Node 里对"导出文本"做 round-trip 验证。
 */

import {
  assembleDescription,
  presetAssembleOptions,
  serializeStCard,
  type AuditReport,
  type TxtPreset,
  type UnifiedCard,
} from '@tcs/shared';

export type ExportFormat = 'json' | 'txt';

export interface ExportBlocked {
  blocked: true;
  /** 错误级问题（必须逐条展示，不能只说"有问题"） */
  errors: AuditReport['issues'];
  message: string;
}

export interface ExportAllowed {
  blocked: false;
}

export type ExportGate = ExportBlocked | ExportAllowed;

/**
 * 导出闸门：审计报告 → 是否拦截。
 *
 * 只在 `exportable === false` 时拦截。报告里可能没有 `summary`（构造异常），
 * 此时按"有问题就拦"处理——宁可多拦一次，也不要静默导出坏卡。
 */
export function evaluateExportGate(report: AuditReport | null): ExportGate {
  if (!report) {
    return {
      blocked: true,
      errors: [],
      message: '尚未完成审计，无法导出',
    };
  }

  const exportable = report.summary?.exportable;
  if (exportable === true) {
    return { blocked: false };
  }

  const errors = report.issues.filter((issue) => issue.severity === 'error');
  const count = report.summary?.error ?? errors.length;
  return {
    blocked: true,
    errors,
    message:
      count > 0
        ? `存在 ${count} 个错误级问题，导出后可能在目标平台被拒或行为异常。`
        : '审计未通过，导出可能产生不符合平台要求的文件。',
  };
}

export interface ExportArtifact {
  format: ExportFormat;
  /** 建议文件名（含扩展名） */
  fileName: string;
  /** 将要写入的完整文本 */
  text: string;
  /** 字节数（UTF-8） */
  bytes: number;
  /** 内容 sha256（十六进制），仅 `buildExportAsync` 会填写 */
  sha256: string | null;
  /** 与导出内容相关的说明，展示给用户 */
  notes: string[];
}

/**
 * JSON 导出：SillyTavern 原生结构。
 *
 * 用 2 空格缩进 + 结尾换行，与服务端/既有导出链路一致 ——
 * 这样"导出 → 上传 → 版本 diff"不会因为格式差异产生噪声。
 */
export function buildJsonExport(card: UnifiedCard, preset: TxtPreset | null): ExportArtifact {
  const options = preset ? presetAssembleOptions(preset) : {};
  const payload = serializeStCard(card, options);
  const text = `${JSON.stringify(payload, null, 2)}\n`;

  return {
    format: 'json',
    fileName: `${safeName(card)}.json`,
    text,
    bytes: byteLength(text),
    sha256: null,
    notes: [
      `目标规格：${card.meta.spec}${card.meta.specVersion ? ` ${card.meta.specVersion}` : ''}`,
      preset ? `标题与顺序按预设「${preset.name}」拼装` : '按默认标题拼装',
      '缩进 2 空格 + 结尾换行，与服务端存储口径一致',
    ],
  };
}

/**
 * TXT 导出：按当前预设拼装整卡文本。
 *
 * 注意与 JSON 导出的差别：
 *   · TXT 是**给人看/给平台粘贴**的形态，包含标题行与分隔符；
 *   · 性格板块在 TXT 里也占一段（有标题），而 JSON 里它是独立字段。
 * 这正是"同一张卡、两种形态"的预期差异，不是 bug。
 */
export function buildTxtExport(card: UnifiedCard, preset: TxtPreset): ExportArtifact {
  const options = presetAssembleOptions(preset);
  const description = assembleDescription(card.blocks, card.description, options);
  const personalityBlock = card.blocks.find((block) => block.id === 'personality');
  const personalityText = personalityBlock?.text ?? '';

  // 性格若已在 description 里（不常见），就不再重复追加
  const personalityHeading = options.heading('personality');
  const alreadyIncluded =
    personalityText.trim() === '' ||
    description.includes(`${personalityHeading}\n${personalityText}`);

  const parts = [description];
  if (!alreadyIncluded) {
    parts.push(`${personalityHeading}\n${personalityText}`);
  }

  const text = `${parts.filter((part) => part.trim() !== '').join(preset.separator)}`;
  const finalText = text.endsWith('\n') ? text : `${text}\n`;

  return {
    format: 'txt',
    fileName: `${safeName(card)}.txt`,
    text: finalText,
    bytes: byteLength(finalText),
    sha256: null,
    notes: [
      `按预设「${preset.name}」拼装（${preset.blockOrder.filter((id) => id !== 'worldbook').length} 个板块）`,
      `分隔符：${describeSeparator(preset.separator)}`,
      '世界书不写入 TXT（它是结构化字段，见 docs/04）',
    ],
  };
}

export function buildExport(
  card: UnifiedCard,
  preset: TxtPreset | null,
  format: ExportFormat,
): ExportArtifact {
  if (format === 'json') return buildJsonExport(card, preset);
  if (!preset) {
    throw new Error('TXT 导出需要预设：无法确定标题与分隔符');
  }
  return buildTxtExport(card, preset);
}

/** 文件名剥离非法字符（Windows/macOS 取交集，保守处理） */
function safeName(card: UnifiedCard): string {
  const raw = (card.meta.name || 'character').trim();
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_');
  return cleaned === '' ? 'character' : cleaned.slice(0, 80);
}

function describeSeparator(separator: string): string {
  const visible = separator
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return visible.length === 0 ? '空行' : visible.join(' ');
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * sha256（十六进制）。
 *
 * 用 WebCrypto：Tauri 渲染层（Chromium）与 Node 20+ 都有 `crypto.subtle`。
 * 浏览器 Crypto API 只有异步版本，所以**导出产物统一走 async 入口**——
 * 不做"同步返回空哈希、之后再补"那种半成品设计，避免 UI 上出现 `sha256: (空)`。
 */
async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ExportArtifactReady extends ExportArtifact {
  /** 真实内容哈希（非空） */
  sha256: string;
}

/**
 * 导出入口（唯一）：文本 + 真实 sha256。
 *
 * 调用方拿到它就能：
 *   ① 把 `sha256` 传给 `writeFileAtomic(path, text, sha256)`，让壳写后回读校验；
 *   ② 与回执里的 `receipt.sha256` 比对，确认落盘内容与内存一致。
 */
export async function buildExportAsync(
  card: UnifiedCard,
  preset: TxtPreset | null,
  format: ExportFormat,
): Promise<ExportArtifactReady> {
  const artifact = buildExport(card, preset, format);
  const sha256 = await sha256Hex(artifact.text);
  return { ...artifact, sha256 };
}
