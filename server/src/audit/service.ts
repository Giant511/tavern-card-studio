/**
 * 服务端审计（T5.3）：直接复用阶段 4 的 `buildAuditReport`，不另写一套规则。
 *
 * 边界（对应硬约束 1）：
 *   · 审计读的是**上传字节解码后的文本**，审计结果只写进审计报告；
 *   · 审计绝不把 `UnifiedCard` 再序列化回卡片文件 —— 版本里的 card.json 永远是上传字节。
 *
 * 因此「审计—修复—再上传」这条链路上，版本 diff 只反映用户真实改动，
 * 不会掺进服务端 JSON.stringify 造成的键序/缩进噪声。
 */

import {
  buildAuditReport,
  parseStCard,
  type AuditReport,
  type ParseIssue,
  type UnifiedCard,
} from '@tcs/shared';

import { AppError } from '../errors.js';
import type { RuleRegistry } from '../rules/registry.js';

export interface AuditRequestOptions {
  platformId?: string | null;
  presetId?: string | null;
  includeStDefaults?: boolean;
}

export interface AnalyzedCard {
  card: UnifiedCard;
  /** 与上传字节逐字符对应的 UTF-8 文本（仅用于解析/审计） */
  jsonText: string;
  parseIssues: ParseIssue[];
  name: string;
  spec: string;
  specVersion: string;
  creator: string;
  tags: string[];
}

export interface AuditResult {
  report: AuditReport;
  /** 审计报告的规范化字节（作为不可变快照存 blob，并随 Git 提交） */
  reportBytes: Buffer;
  analyzed: AnalyzedCard;
}

function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  const upTo = text.slice(0, Math.max(0, offset));
  const lastBreak = upTo.lastIndexOf('\n');
  return {
    line: upTo.split('\n').length,
    column: offset - lastBreak,
  };
}

function parseErrorDetails(text: string, error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(message)?.[1];
  if (position) {
    const offset = Number.parseInt(position, 10);
    const { line, column } = lineColumnAt(text, offset);
    return { reason: message, offset, line, column };
  }
  return { reason: message };
}

function looksLikeCard(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data'])) {
    const data = raw['data'] as Record<string, unknown>;
    return ['name', 'description', 'personality', 'first_mes'].some((key) => typeof data[key] === 'string');
  }
  return ['name', 'description', 'first_mes'].some((key) => typeof raw[key] === 'string');
}

/** 解析上传字节；失败一律抛 422，调用方据此拒绝入库（不会留下半个版本） */
export function analyzeCardBytes(bytes: Buffer): AnalyzedCard {
  let jsonText: string;
  try {
    jsonText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AppError(422, 'CARD_PARSE_FAILED', '文件不是合法的 UTF-8 文本，服务端不做编码猜测', {
      reason: 'invalid_utf8',
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new AppError(422, 'CARD_PARSE_FAILED', 'JSON 解析失败', parseErrorDetails(jsonText, error));
  }

  if (!looksLikeCard(raw)) {
    throw new AppError(422, 'CARD_PARSE_FAILED', '不是可识别的 SillyTavern 角色卡 JSON（缺少 name/description/data 等字段）');
  }

  let result: ReturnType<typeof parseStCard>;
  try {
    result = parseStCard(raw);
  } catch (error) {
    throw new AppError(422, 'CARD_PARSE_FAILED', '角色卡结构无法解析', parseErrorDetails(jsonText, error));
  }

  const hardErrors = result.issues.filter((issue) => issue.severity === 'error');
  if (hardErrors.length > 0) {
    throw new AppError(422, 'CARD_PARSE_FAILED', '角色卡结构存在无法修复的错误', {
      issues: hardErrors.slice(0, 20),
    });
  }

  const card = result.card;
  return {
    card,
    jsonText,
    parseIssues: result.issues,
    name: (card.meta?.name ?? '').trim() || '未命名角色卡',
    spec: card.meta?.spec ?? '',
    specVersion: card.meta?.specVersion ?? '',
    creator: card.meta?.creator ?? '',
    tags: card.meta?.tags ?? [],
  };
}

export class AuditService {
  constructor(
    private readonly registry: RuleRegistry,
    private readonly defaults: { platformId: string; presetId: string },
  ) {}

  /** 解析并审计；`origin` 只写进报告，不影响卡片字节 */
  run(bytes: Buffer, options: AuditRequestOptions = {}, origin = ''): AuditResult {
    const analyzed = analyzeCardBytes(bytes);
    if (origin) analyzed.card.source = { ...analyzed.card.source, origin };

    const platformId = options.platformId ?? this.defaults.platformId;
    const presetId = options.presetId ?? this.defaults.presetId;

    const platformRule = platformId ? this.registry.resolvePlatform(platformId) : null;
    if (platformId && !platformRule) {
      throw new AppError(400, 'UNKNOWN_PLATFORM', `未知的平台规则：${platformId}`, {
        available: this.registry.listPlatforms().map((item) => item.id),
      });
    }
    const preset = presetId ? this.registry.findPreset(presetId) : null;
    if (presetId && !preset) {
      throw new AppError(400, 'UNKNOWN_PRESET', `未知的 TXT 预设：${presetId}`, {
        available: this.registry.listPresets().map((item) => item.id),
      });
    }

    const report = buildAuditReport(analyzed.card, {
      platformRule,
      preset,
      rawJsonText: analyzed.jsonText,
      includeStDefaults: options.includeStDefaults !== false,
    });

    // 审计报告本身是「新产物」，允许序列化；它不会被当成卡片正文。
    const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return { report, reportBytes, analyzed };
  }
}
