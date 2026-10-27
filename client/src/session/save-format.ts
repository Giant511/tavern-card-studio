/**
 * 「另存为」的格式选择（v0.1.5 / G6）。
 *
 * ## 为什么不是"直接复用导出对话框"
 *
 * 两者**语义不同**，硬合并会让其中一个变形：
 *
 * · 「导出」= 生成一份产物到某路径，**不动会话**（可以导出十份、卡还是那一张）；
 * · 「另存为」= 生成产物 **并把会话绑定到那个文件**（此后 Ctrl+S 保存的就是它，
 *   标签栏的文件名也跟着变）。
 *
 * 但**产物**应该完全一致 —— 同一张卡、同一套预设，"另存为 TXT" 与 "导出 TXT"
 * 必须是逐字节相同的文件。所以这里只负责"选哪种格式、叫什么文件名"，
 * 产物本身仍由 `buildExportAsync` 生成（与导出共用同一条链路）。
 *
 * ## 为什么格式要记在会话上
 *
 * 另存为 PNG 之后若下次保存默认回 JSON，用户会在 PNG 路径上写出一个 JSON 文件 ——
 * 扩展名与内容不符，而且平台（SillyTavern）会读不出来。所以格式跟着会话走。
 */

import type { ExportFormat } from '../export/export-card';

/**
 * 会话记住的保存格式。
 *
 * 与 `ExportFormat` 是同一个联合类型 —— 两者产物必须一致，另立一套枚举迟早分叉。
 * 单独起名只是为了读代码时能一眼看出"这是磁盘文件的格式"，而不是"这次导出的格式"。
 */
export type SaveFormat = ExportFormat;

export interface SaveFormatOption {
  format: ExportFormat;
  /** 按钮上的名字 */
  label: string;
  /** 一句话说明，写清"这种格式给谁用" */
  description: string;
  /** 文件扩展名（不含点） */
  extension: string;
}

/**
 * 三种格式，顺序即默认优先级：ST JSON 在最前。
 *
 * 为什么 JSON 仍是默认：它是唯一能**无损 round-trip** 的格式（另存为通常意味着
 * "以后还要继续编辑"）。TXT 与 PNG 是交付形态 —— TXT 会按预设重排、PNG 会固定
 * 一张卡面，都不适合当工作副本。
 */
export const SAVE_FORMATS: readonly SaveFormatOption[] = [
  {
    format: 'json',
    label: 'ST 角色卡 JSON',
    description: '原生 SillyTavern 结构，可继续编辑、可导入 ST / Chub；建议作为工作副本',
    extension: 'json',
  },
  {
    format: 'txt',
    label: 'TXT 文本',
    description: '按当前预设拼装标题与分隔符，便于人工核对或粘贴到别的平台',
    extension: 'txt',
  },
  {
    format: 'png',
    label: 'PNG 角色卡',
    description: '把卡数据写进图片（像素不变），一张图既是封面也是卡',
    extension: 'png',
  },
];

export function saveFormatOption(format: ExportFormat): SaveFormatOption {
  const found = SAVE_FORMATS.find((item) => item.format === format);
  if (found === undefined) throw new Error(`未知的保存格式：${format}`);
  return found;
}

export function isSaveFormat(value: unknown): value is ExportFormat {
  return SAVE_FORMATS.some((item) => item.format === value);
}

/**
 * 把建议文件名换成目标格式的扩展名。
 *
 * 判据是"点之后的部分像不像扩展名"，而不是"以 .json 结尾" —— 角色名里可能
 * 自带点（`Dr. Smith`、`西奥 v1.2`），按已知扩展名剥离才不会把名字切坏：
 *   `西奥 v1.2.json` → `西奥 v1.2` → `西奥 v1.2.png`
 *   `Dr. Smith`      → 不动（`. Smith` 不像扩展名）→ `Dr. Smith.png`
 */
export function withSaveExtension(suggested: string, format: ExportFormat): string {
  const option = saveFormatOption(format);
  const known = SAVE_FORMATS.map((item) => item.extension);
  const base = stripKnownExtension(suggested, known);
  return `${base}.${option.extension}`;
}

/**
 * 去掉**已知**扩展名。只认那几个，不做通配匹配。
 *
 * 通配（`/\.[^.]+$/`）会把 `西奥 v1.2` 变成 `西奥 v1` —— 版本号被当成扩展名
 * 剥掉，用户看到的文件名比原名少一截。
 */
function stripKnownExtension(name: string, known: readonly string[]): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name; // 没有点，或点在开头（`.hidden`）
  const tail = name.slice(dot + 1).toLowerCase();
  if (tail === '' || tail.includes(' ') || !known.includes(tail)) return name;
  return name.slice(0, dot);
}

/**
 * 需要给用户看的提示：这次保存改变了"以后按 Ctrl+S 会写回哪种格式"。
 *
 * 不提示的话，用户另存为 PNG 之后又会点保存，看到文件名变成 `.png` 却以为
 * 文件坏了 —— 实际上是他自己的选择，只是没人告诉他会持续生效。
 */
export function saveFormatNote(format: ExportFormat): string {
  const option = saveFormatOption(format);
  if (format === 'json') return '';
  return `此后对该卡点「保存」将按 ${option.label} 写回，直到你再次另存为其它格式`;
}
