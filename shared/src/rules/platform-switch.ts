/**
 * 平台规则切换与内容适配（T1.4）。
 *
 * 两个动作，全部需要用户确认后才落盘：
 * 1. 占位符归一：把旧平台特有的写法替换为新平台的主写法（如 <BOT> → {{char}}）；
 * 2. 执行新规则的 autoFix（如清理伪标签、trim）。
 * 返回一份「将要发生什么」的变更清单，供 UI 预览。
 */

import type { BlockId } from '../model/blocks.js';
import type { UnifiedCard } from '../model/unified-card.js';
import { renderWorldbookText } from '../format/worldbook.js';
import type { AutoFixOp, ResolvedPlatformRule, Selector } from './platform-rule.js';
import { parseSelector } from './scopes.js';

export interface TextChange {
  /** 变更位置的展示名，如「性格」「开场白」「世界书 · 书店位置」 */
  target: string;
  blockId: BlockId | null;
  field: string | null;
  from: string;
  to: string;
  count: number;
}

export interface PlatformSwitchPlan {
  /** 适配后的卡片（原卡片不被修改） */
  card: UnifiedCard;
  changes: TextChange[];
  /** 无法自动适配、需要人工处理的提示 */
  notes: string[];
}

interface EditableTarget {
  label: string;
  blockId: BlockId | null;
  field: string;
  get(): string;
  set(value: string): void;
}

const BLOCK_LABELS: Record<BlockId, string> = {
  basic: '基本信息',
  personality: '性格',
  settings: '其他设定',
  special: '特殊设定',
  user: '用户相关设定',
  worldbook: '世界书',
};

function collectTargets(card: UnifiedCard): EditableTarget[] {
  const targets: EditableTarget[] = [];

  for (const block of card.blocks) {
    targets.push({
      label: BLOCK_LABELS[block.id],
      blockId: block.id,
      field: block.id === 'personality' ? 'personality' : 'description',
      get: () => block.text,
      set: (value) => {
        if (block.text !== value) {
          block.text = value;
          block.dirty = true;
        }
      },
    });
  }

  const residualEntries: { field: string; label: string; key: 'scenario' | 'firstMes' | 'mesExample' | 'systemPrompt' | 'postHistoryInstructions' }[] = [
    { field: 'scenario', label: '场景', key: 'scenario' },
    { field: 'first_mes', label: '开场白', key: 'firstMes' },
    { field: 'mes_example', label: '对话示例', key: 'mesExample' },
    { field: 'system_prompt', label: '系统提示词', key: 'systemPrompt' },
    { field: 'post_history_instructions', label: '历史后指令', key: 'postHistoryInstructions' },
  ];

  for (const entry of residualEntries) {
    targets.push({
      label: entry.label,
      blockId: null,
      field: entry.field,
      get: () => card.residual[entry.key],
      set: (value) => {
        card.residual[entry.key] = value;
      },
    });
  }

  card.residual.alternateGreetings.forEach((greeting, index) => {
    targets.push({
      label: `备选开场白 ${index + 1}`,
      blockId: null,
      field: `alternate_greetings[${index}]`,
      get: () => greeting,
      set: (value) => {
        card.residual.alternateGreetings[index] = value;
      },
    });
  });

  card.worldbook.entries.forEach((entry, index) => {
    targets.push({
      label: `世界书 · ${entry.name ?? entry.comment ?? `条目 ${index + 1}`}`,
      blockId: 'worldbook',
      field: 'character_book',
      get: () => entry.content ?? '',
      set: (value) => {
        entry.content = value;
      },
    });
  });

  return targets;
}

function matchesScope(target: EditableTarget, scope: Selector | Selector[] | undefined): boolean {
  if (!scope) return true;
  const list = Array.isArray(scope) ? scope : [scope];
  return list.some((selector) => {
    const parsed = parseSelector(selector);
    if (!parsed) return false;
    if (parsed.kind === 'all') return true;
    if (parsed.kind === 'block') return target.blockId === parsed.blockId;
    return target.field === parsed.field;
  });
}

function replaceLiteral(text: string, from: string, to: string): { text: string; count: number } {
  if (from === '' || !text.includes(from)) return { text, count: 0 };
  const parts = text.split(from);
  return { text: parts.join(to), count: parts.length - 1 };
}

function applyAutoFix(text: string, op: AutoFixOp): { text: string; count: number } {
  if (op.type === 'replace-text') {
    if (op.caseSensitive === false) {
      const escaped = op.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      const count = (text.match(regex) ?? []).length;
      return { text: text.replace(regex, op.to), count };
    }
    return replaceLiteral(text, op.from, op.to);
  }
  if (op.type === 'replace-regex') {
    const flags = op.flags ?? 'g';
    const regex = new RegExp(op.pattern, flags.includes('g') ? flags : `${flags}g`);
    const count = (text.match(regex) ?? []).length;
    if (count === 0) return { text, count: 0 };
    return { text: text.replace(regex, op.replacement), count };
  }
  const trimmed = text.trim();
  return { text: trimmed, count: trimmed === text ? 0 : 1 };
}

export interface SwitchOptions {
  /** 是否执行目标规则的 autoFix，默认 true */
  includeAutoFix?: boolean;
}

export function planPlatformSwitch(
  card: UnifiedCard,
  from: ResolvedPlatformRule,
  to: ResolvedPlatformRule,
  options: SwitchOptions = {},
): PlatformSwitchPlan {
  const working = structuredClone(card);
  const targets = collectTargets(working);
  const changes: TextChange[] = [];
  const notes: string[] = [];

  // 1) 占位符归一
  const tokens: { key: 'char' | 'user' | string; from: string[]; to: string[] }[] = [
    { key: 'char', from: from.placeholders.char, to: to.placeholders.char },
    { key: 'user', from: from.placeholders.user, to: to.placeholders.user },
  ];
  for (const [name, variants] of Object.entries(from.placeholders.custom ?? {})) {
    tokens.push({ key: `custom:${name}`, from: variants, to: to.placeholders.custom?.[name] ?? [] });
  }

  for (const token of tokens) {
    if (token.to.length === 0) {
      if (token.from.length > 0) {
        notes.push(`新平台未声明占位符 ${token.key}，保留原写法不做替换`);
      }
      continue;
    }
    const primary = token.to[0]!;
    for (const variant of token.from) {
      if (variant === primary || token.to.includes(variant)) continue;
      for (const target of targets) {
        const original = target.get();
        const { text, count } = replaceLiteral(original, variant, primary);
        if (count === 0) continue;
        target.set(text);
        changes.push({
          target: target.label,
          blockId: target.blockId,
          field: target.field,
          from: variant,
          to: primary,
          count,
        });
      }
    }
  }

  // 2) 目标规则的 autoFix
  if (options.includeAutoFix !== false) {
    for (const op of to.autoFix ?? []) {
      for (const target of targets) {
        if (!matchesScope(target, op.scope)) continue;
        const original = target.get();
        const { text, count } = applyAutoFix(original, op);
        if (count === 0) continue;
        target.set(text);
        const label = op.type === 'trim' ? '去除首尾空白' : op.type === 'replace-text' ? op.from : op.pattern;
        const replacement = op.type === 'replace-text' ? op.to : op.type === 'replace-regex' ? op.replacement : '';
        changes.push({
          target: target.label,
          blockId: target.blockId,
          field: target.field,
          from: label,
          to: replacement,
          count,
        });
      }
    }
  }

  if (changes.length > 0) {
    working.worldbook.text = renderWorldbookText(working.worldbook.entries);
  }

  return { card: working, changes, notes };
}

/** 生成变更摘要文案（客户端确认弹窗直接用） */
export function describeSwitchPlan(plan: PlatformSwitchPlan): string {
  if (plan.changes.length === 0) return '内容已符合目标平台写法，无需改动。';
  const total = plan.changes.reduce((sum, change) => sum + change.count, 0);
  const grouped = new Map<string, number>();
  for (const change of plan.changes) {
    const key = `${change.from} → ${change.to}`;
    grouped.set(key, (grouped.get(key) ?? 0) + change.count);
  }
  const lines = [...grouped.entries()].map(([key, count]) => `  ${key}（${count} 处）`);
  return [`共 ${total} 处替换，涉及 ${plan.changes.length} 个位置：`, ...lines].join('\n');
}

/** 增量应用：把变更写回原卡片（需要用户确认后调用） */
export function applySwitchPlan(card: UnifiedCard, plan: PlatformSwitchPlan): void {
  for (const block of card.blocks) {
    const next = plan.card.blocks.find((item) => item.id === block.id);
    if (!next) continue;
    if (next.text !== block.text) {
      block.text = next.text;
      block.dirty = true;
    }
  }
  card.residual = plan.card.residual;
  card.worldbook = plan.card.worldbook;
}
