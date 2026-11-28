/**
 * 功能
 * 界面刷新与预设切换：账号按钮、规则标签、统计数字、块徽标、名字提示，
 * 以及平台/高亮两处的预设切换。从 EditorApp 搬出，8 个函数 169 行。
 *
 * 注意事项
 * 全是"把状态同步到界面"的动作，**不改业务数据** ——
 * 唯一例外是 `switchPlatform` / `switchHighlight`：它们会写 `rules`。
 *
 * `refreshBlockBadges` 的参数 `all` 是**全部**审计问题，不是单块的。
 * 徽标要显示"这一块有几条"，必须拿全集再按 blockId 过滤。
 *
 * `refreshAccountButton` 里有一条独立分支判断仓库令牌模式：
 * 那个模式 `user` 恒为 null，走通用路径会显示「登录…」——
 * 明明连上了却说没登录。
 *
 * 踩过的坑
 * 这些函数短，容易被当成"没价值的小工具"内联回去。但调用点分散在
 * 二十多处，内联会让"改一处样式要翻遍整个类"。
 */

import type { AuditIssue, BlockId } from '@tcs/shared';
import type { Ruleset } from './rules';

import type { AuthSession } from '../auth/session';
import type { SettingsDialog } from '../settings/settings-dialog';
import type { BlockRuntime } from './block-runtime';

import { compileHighlightRule, resolveHighlightRule, resolvePlatformRule } from '@tcs/shared';

import { describeCapabilities } from '../auth/repo-token';
import {
  phaseLabel,
  phaseTitle,
  repoTokenLabel,
  repoTokenTitle,
} from '../auth/policy';
import { configGet } from '../contract';
import { probeServer } from '../net/server-probe';
import { BlockEditor } from './block-editor';
import { onBlockChange } from './block-actions';
import { totalLength } from './block-doc';
import { byId } from './dom-id';
import { el } from './dom';
import { applySchemeStyles } from './highlight';
import { browserHintStore, shouldShowNameHint } from './name-hint';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 10 个字段里 `rules` / `settings` 可写（两个 switch* 与令牌刷新会改），
 * 其余只读。`blocks` 用真实类型 `BlockRuntime[]` 而不是 unknown ——
 * 第一版写成 unknown，refreshBlockBadges 里遍历时 30 多个连锁错误。
 *
 * 踩过的坑
 * 无。
 */
export interface RefreshHost {
  /** 全部板块运行时（刷徽标与统计要遍历） */
  readonly blocks: readonly BlockRuntime[];
  /** 当前审计问题全集 */
  readonly issues: readonly AuditIssue[];
  /** 上次校验的条数统计 */
  readonly lastSummary: { error: number; warning: number; info: number };
  /** 规则集。两个 switch* 会写它 */
  rules: Ruleset | null;
  /** 设置面板实例（令牌刷新后要它重画身份区） */
  readonly settings: SettingsDialog | null;
  /** 设置写入令牌（令牌刷新后会换新） */
  settingsToken: string;
  /** 账号认证服务器地址。`refreshTokenAfterSave` 会写 */
  authServerUrl: string;
  /** 账号认证会话 */
  readonly authSession: AuthSession | null;
  /** 有没有打开会话 */
  readonly hasSession: boolean;
  /** 工具栏统计节点。索引页里它是常驻的，不会为 null */
  readonly toolbarStats: HTMLElement;

  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  /** 立刻校验 */
  validate(): void;
  /** 取某块的问题清单 */
  issuesFor(blockId: BlockId): readonly import('./block-editor').EditorIssue[];
  /** 落盘当前预设选择。只传要改的那几项，其余保持不动 */
  persistSelection(patch: Partial<import('../contract').ClientConfig>): void;
  /** 把连接配置写进 ST */
  applyConnection(result: unknown): void;
  /** 板块模块的接入点（切高亮后要重建编辑器） */
  blockHost(): import('./block-actions').BlockHost;
}

export async function refreshTokenAfterSave(host: RefreshHost): Promise<void> {
  try {
    const config = await configGet();
    host.settingsToken = config.token;
    host.authServerUrl = config.serverUrl;
    // 与 autoProbe 同一套优先级：账户令牌 > legacy 全局令牌
    const accountToken = host.authSession?.accessToken ?? '';
    const result = await probeServer({
      serverUrl: config.serverUrl,
      token: accountToken !== '' ? accountToken : config.token,
    });
    host.applyConnection(result);
  } catch {
    // 浏览器模式读不到配置，忽略
  }
}

export function refreshAccountButton(host: RefreshHost): void {
  const button = byId<HTMLButtonElement>('btn-account');
  const session = host.authSession;

  /*
   * 仓库令牌模式（v0.1.3 / F5 后半）单独一条分支。
   *
   * 不能复用 phaseLabel：那个模式里 `user` 恒为 null（令牌代表的是**签发人**的账户，
   * 用令牌的人未必是同一个），走原来的路径会显示「登录…」——
   * 明明已经连上了却说没登录。文案必须写"仓库令牌 · <仓库名>"。
   */
  if (session?.isRepoTokenMode === true) {
    const repoName = session.repoTokenRepoName;
    button.textContent = repoTokenLabel(repoName);
    button.title = repoTokenTitle(repoName, describeCapabilities(session.capabilities));
    button.dataset['phase'] = 'repo-token';
    button.dataset['repoName'] = repoName;
    host.settings?.refreshIdentity();
    return;
  }
  delete button.dataset['repoName'];

  const phase = session?.currentPhase ?? 'anonymous';
  const user = session?.user ?? null;
  button.textContent = phaseLabel(phase, user);
  button.title = phaseTitle(phase, user);
  button.dataset['phase'] = phase;
  // 设置面板里的「已登录：alice（账户令牌）」/「未登录」跟着变：
  // 登录态可能在任何地方变化（登录、登出、静默过期、401 恢复），
  // 只在一处改文案，避免两个面板各说一套。
  host.settings?.refreshIdentity();
}

export function switchPlatform(host: RefreshHost, id: string): void {
  if (!host.rules) return;
  let resolved;
  try {
    resolved = resolvePlatformRule(id, host.rules.platformFiles);
  } catch (error) {
    host.setStatus(
      `平台规则「${id}」无法解析：${error instanceof Error ? error.message : String(error)}`,
      'bad',
    );
    return;
  }

  host.rules = { ...host.rules, platform: resolved, platformId: id };
  // 切换即重检：不等防抖，立刻跑，让用户马上看到结论变化
  host.validate();
  const { error, warning, info } = host.lastSummary;
  host.setStatus(
    `已切换到「${resolved.name}」：错误 ${error} · 警告 ${warning} · 提示 ${info}`,
    error > 0 ? 'bad' : warning > 0 ? 'warn' : 'ok',
  );
  refreshRulesLabel(host);
  // 记下选择（v0.1.5 / G5）
  host.persistSelection({ platformRuleId: id });
}

export function switchHighlight(host: RefreshHost, id: string): void {
  if (!host.rules) return;
  const file = host.rules.highlightFiles.find((item) => item.id === id);
  if (!file) {
    host.setStatus(`高亮方案「${id}」不存在`, 'bad');
    return;
  }

  let compiled;
  try {
    compiled = compileHighlightRule(resolveHighlightRule(id, host.rules.highlightFiles));
  } catch (error) {
    host.setStatus(
      `高亮方案「${id}」编译失败：${error instanceof Error ? error.message : String(error)}`,
      'bad',
    );
    return;
  }

  host.rules = { ...host.rules, highlight: compiled, highlightFile: file, highlightId: id };
  // 配色来自方案本体 → 重新生成 CSS
  applySchemeStyles(file);

  // 已挂载的编辑器需要重建才能用新方案（装饰在 ViewPlugin 构造时绑定）
  for (const runtime of host.blocks) {
    if (!runtime.expanded) continue;
    const text = runtime.editor?.getText() ?? runtime.snapshot.text;
    runtime.editor?.destroy();
    runtime.editor = null;
    runtime.host.replaceChildren();
    runtime.editor = new BlockEditor({
      parent: runtime.host,
      blockId: runtime.snapshot.id,
      text,
      compiled,
      onChange: (next) => onBlockChange(host.blockHost(), runtime, next),
    });
    runtime.editor.setIssues(host.issuesFor(runtime.snapshot.id));
  }

  host.setStatus(`已切换高亮方案：${file.name}（${id}）`, 'ok');
  refreshRulesLabel(host);
  // 记下选择（v0.1.5 / G5）
  host.persistSelection({ highlightSchemeId: id });
}

export function refreshRulesLabel(host: RefreshHost): void {
  const label = byId('rules-label');
  const rules = host.rules;
  if (!rules) return;
  label.textContent = `平台 ${rules.platformId} · 高亮 ${rules.highlightId} · 预设 ${rules.preset?.id ?? '—'}`;
}

export function refreshStats(host: RefreshHost): void {
  const total = totalLength(host.blocks.map((block) => block.snapshot));
  const totalCp = [...host.blocks.map((b) => b.snapshot.text).join('')].length;
  // 等级计数一律取 lastSummary：它是「最近一次审计报告」的唯一投影。
  // 若在这里数 host.issues，会和 report.summary 形成两个数据源
  // （曾导致顶栏显示"错误 0"而审计面板显示"错误 1"）。
  const { error: errors, warning: warnings } = host.lastSummary;

  host.toolbarStats.replaceChildren(
    el('span', 'stat', `八板块 ${totalCp} 字`),
    el('span', 'stat', `块内合计 ${total} 字`),
    el('span', `stat ${errors > 0 ? 'bad' : 'ok'}`, `错误 ${errors}`),
    el('span', `stat ${warnings > 0 ? 'warn' : 'ok'}`, `警告 ${warnings}`),
  );
}

export function refreshBlockBadges(host: RefreshHost, all: readonly AuditIssue[]): void {
  for (const runtime of host.blocks) {
    const mine = all.filter((issue) => issue.location.blockId === runtime.snapshot.id);
    const errors = mine.filter((i) => i.severity === 'error').length;
    const warnings = mine.filter((i) => i.severity === 'warning').length;
    const total = mine.length;

    runtime.section.dataset['errors'] = String(errors);
    runtime.section.dataset['warnings'] = String(warnings);

    const meta = runtime.section.querySelector('.block-meta');
    if (meta) meta.textContent = `${runtime.snapshot.length} 字`;

    if (total === 0) {
      runtime.badge.hidden = true;
      runtime.badge.textContent = '';
      continue;
    }
    runtime.badge.hidden = false;
    // 只有提示级问题时不能显示「0 警告」——按最严重的一级决定文案
    if (errors > 0) {
      runtime.badge.textContent = `${errors} 错误`;
      runtime.badge.className = 'block-badge bad';
    } else if (warnings > 0) {
      runtime.badge.textContent = `${warnings} 警告`;
      runtime.badge.className = 'block-badge warn';
    } else {
      runtime.badge.textContent = `${total} 提示`;
      runtime.badge.className = 'block-badge info';
    }
  }
}

export function refreshNameHint(host: RefreshHost): void {
  const hint = byId<HTMLElement>('card-name-hint');
  const inputVisible = !byId<HTMLInputElement>('card-name-input').hidden;
  const show = host.hasSession && !inputVisible && shouldShowNameHint(browserHintStore());
  hint.hidden = !show;
}