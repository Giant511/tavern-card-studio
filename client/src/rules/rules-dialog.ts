/**
 * 规则与预设管理面板（T6.2 + T6.3）。
 *
 * 三个分区：
 *   ① 平台规则：下拉切换（**切换即重检**，由调用方负责）+ 导入/导出
 *   ② 高亮方案：下拉切换（立即重新着色）+ 导入/导出
 *   ③ TXT 预设：下拉选择（只影响导出格式）+ 「应用预设」按钮（唯一重排入口，需确认）
 *
 * 约束：
 *   · 文件读写全部走 `../contract`（pickRuleFile / readTextExact / pickSavePath / writeFileAtomic）；
 *   · 导入失败**不写回**任何状态，错误按字段分组展示（来自 rule-library 的结构化结果）；
 *   · UI 不自行重排文本——「应用预设」只调用 shared 的 plan → 确认 → apply。
 */

import type { PresetApplyPlan } from '@tcs/shared';

import {
  pickRuleFile,
  pickSavePath,
  readTextExact,
  isShellAvailable,
  writeFileAtomic,
} from '../contract';

import {
  groupRuleIssues,
  importHighlightScheme,
  importPlatformRule,
  type ImportOutcome,
  type RuleIssue,
} from './rule-library';
import {
  decideApplyPreset,
  describePresets,
  previewPresetSelection,
  type PresetChoice,
} from './preset-switch';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface RulesDialogCallbacks {
  /** 切换平台规则：调用方需立即重检并提醒 */
  onPlatformChange: (id: string) => Promise<void> | void;
  /** 切换高亮方案：调用方需重新着色 */
  onHighlightChange: (id: string) => Promise<void> | void;
  /** 选择预设（不重排，只改导出格式） */
  onPresetSelect: (id: string) => void;
  /**
   * 应用预设（重排）。由 app.ts 执行 applyPresetPlan —— 卡片状态归它所有，
   * 这里不能直接改，否则会绕过 dirty/anchor 维护。
   */
  onPresetApply: (presetId: string, plan: PresetApplyPlan) => void;

  /** 导入平台规则文本（校验与原子回退在 app 侧完成，UI 只负责展示结果） */
  importPlatformText: (text: string) => ImportOutcome<unknown> & {
    id: string | null;
    name: string | null;
  };
  /** 导入高亮方案文本 */
  importHighlightText: (text: string) => ImportOutcome<unknown> & {
    id: string | null;
    name: string | null;
  };

  /** 当前状态快照 */
  getState: () => DialogState;
  /** 状态栏消息 */
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 导出时取当前规则原文（null = 无原文可导出） */
  exportPlatformRule: (id: string) => string | null;
  exportHighlightScheme: (id: string) => string | null;
}

export interface DialogState {
  platformId: string;
  platforms: Array<{ id: string; name: string }>;
  highlightId: string;
  highlights: Array<{ id: string; name: string }>;
  presetId: string | null;
  presets: PresetChoice[];
  previewFor: (presetId: string) => ReturnType<typeof previewPresetSelection> | null;
  decideFor: (presetId: string) => ReturnType<typeof decideApplyPreset> | null;
}

export class RulesDialog {
  private readonly overlay: HTMLDivElement;
  private readonly platformSelect: HTMLSelectElement;
  private readonly highlightSelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetPreview: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly applyButton: HTMLButtonElement;

  constructor(private readonly callbacks: RulesDialogCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'rules-title');

    const panel = el('div', 'modal wide');

    // 头部
    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '规则与预设');
    title.id = 'rules-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // ── ① 平台规则 ─────────────────────────────────────
    const platformSection = el('section', 'form-section');
    const platformTitle = el('h3', 'form-title', '平台规则');
    const platformHint = el(
      'p',
      'field-hint',
      '切换后立即按新规则重新校验；提示会出现在右侧审计面板。',
    );

    this.platformSelect = el('select', 'select wide') as HTMLSelectElement;
    this.platformSelect.dataset['role'] = 'platform-select';
    this.platformSelect.addEventListener('change', () => {
      const id = this.platformSelect.value;
      void Promise.resolve(this.callbacks.onPlatformChange(id)).then(() => {
        this.callbacks.notify(`已切换到平台规则：${this.labelOf(this.platformSelect)}`, 'ok');
      });
    });

    const platformActions = el('div', 'field-row');
    platformActions.append(
      this.actionButton('导入规则文件…', () => void this.importPlatform()),
      this.actionButton('导出当前规则…', () => void this.exportPlatform()),
    );
    platformSection.append(platformTitle, this.platformSelect, platformHint, platformActions);

    // ── ② 高亮方案 ─────────────────────────────────────
    const highlightSection = el('section', 'form-section');
    const highlightTitle = el('h3', 'form-title', '高亮方案');
    const highlightHint = el('p', 'field-hint', '切换后编辑器立即重新着色（配色来自方案本身）。');

    this.highlightSelect = el('select', 'select wide') as HTMLSelectElement;
    this.highlightSelect.dataset['role'] = 'highlight-select';
    this.highlightSelect.addEventListener('change', () => {
      const id = this.highlightSelect.value;
      void Promise.resolve(this.callbacks.onHighlightChange(id)).then(() => {
        this.callbacks.notify(`已切换高亮方案：${this.labelOf(this.highlightSelect)}`, 'ok');
      });
    });

    const highlightActions = el('div', 'field-row');
    highlightActions.append(
      this.actionButton('导入方案文件…', () => void this.importHighlight()),
      this.actionButton('导出当前方案…', () => void this.exportHighlight()),
    );
    highlightSection.append(
      highlightTitle,
      this.highlightSelect,
      highlightHint,
      highlightActions,
    );

    // ── ③ 预设 ─────────────────────────────────────────
    const presetSection = el('section', 'form-section');
    const presetTitle = el('h3', 'form-title', 'TXT 预设');

    this.presetSelect = el('select', 'select wide') as HTMLSelectElement;
    this.presetSelect.dataset['role'] = 'preset-select';
    this.presetSelect.addEventListener('change', () => {
      const id = this.presetSelect.value;
      // 选择预设：只影响导出格式，不动原文
      this.callbacks.onPresetSelect(id);
      this.renderPresetPreview();
    });

    this.presetPreview = el('div', 'preset-preview');
    this.presetPreview.dataset['role'] = 'preset-preview';

    const presetActions = el('div', 'field-row');
    this.applyButton = this.actionButton('应用预设（重排原文）…', () => this.applyPreset());
    this.applyButton.classList.add('primary');
    presetActions.append(this.applyButton);

    const presetHint = el(
      'p',
      'field-hint',
      '「选择预设」只改变导出时的标题与顺序；只有「应用预设」会重排原文，且会先列出变更让你确认。',
    );
    presetSection.append(
      presetTitle,
      this.presetSelect,
      this.presetPreview,
      presetActions,
      presetHint,
    );

    // ── 错误区（导入失败时显示，含字段位置）──────────────
    this.errorBox = el('div', 'rule-errors');
    this.errorBox.hidden = true;

    // 底部
    const foot = el('div', 'modal-foot');
    const note = el(
      'span',
      'foot-note',
      isShellAvailable() ? '' : '浏览器模式：导入/导出不可用（需桌面客户端）',
    );
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(note, done);

    panel.append(head, platformSection, highlightSection, presetSection, this.errorBox, foot);
    this.overlay.append(panel);
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  private actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', 'btn small', label) as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', onClick);
    if (!isShellAvailable() && /导入|导出/.test(label)) {
      button.disabled = true;
      button.title = '浏览器模式不可用';
    }
    return button;
  }

  private labelOf(select: HTMLSelectElement): string {
    return select.selectedOptions[0]?.textContent ?? select.value;
  }

  open(): void {
    const state = this.callbacks.getState();

    this.platformSelect.replaceChildren();
    for (const item of state.platforms) {
      const option = el('option');
      option.value = item.id;
      option.textContent = `${item.name}（${item.id}）`;
      this.platformSelect.append(option);
    }
    this.platformSelect.value = state.platformId;

    this.highlightSelect.replaceChildren();
    for (const item of state.highlights) {
      const option = el('option');
      option.value = item.id;
      option.textContent = `${item.name}（${item.id}）`;
      this.highlightSelect.append(option);
    }
    this.highlightSelect.value = state.highlightId;

    this.presetSelect.replaceChildren();
    for (const preset of state.presets) {
      const option = el('option');
      option.value = preset.id;
      option.textContent = `${preset.name}${preset.builtin ? '' : '（自定义）'} · ${preset.orderLabel}`;
      this.presetSelect.append(option);
    }
    if (state.presetId) this.presetSelect.value = state.presetId;

    this.hideErrors();
    this.renderPresetPreview();
    this.overlay.hidden = false;
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /** 外部（如导入后）刷新下拉内容 */
  refresh(): void {
    if (this.overlay.hidden) return;
    const state = this.callbacks.getState();
    for (const item of state.platforms) {
      if (![...this.platformSelect.options].some((option) => option.value === item.id)) {
        const option = el('option');
        option.value = item.id;
        option.textContent = `${item.name}（${item.id}）`;
        this.platformSelect.append(option);
      }
    }
    for (const item of state.highlights) {
      if (![...this.highlightSelect.options].some((option) => option.value === item.id)) {
        const option = el('option');
        option.value = item.id;
        option.textContent = `${item.name}（${item.id}）`;
        this.highlightSelect.append(option);
      }
    }
    this.platformSelect.value = state.platformId;
    this.highlightSelect.value = state.highlightId;
    if (state.presetId) this.presetSelect.value = state.presetId;
  }

  // ── 预设预览 ─────────────────────────────────────────────
  private renderPresetPreview(): void {
    const state = this.callbacks.getState();
    const presetId = this.presetSelect.value;
    const preview = state.previewFor(presetId);
    const decision = state.decideFor(presetId);

    this.presetPreview.replaceChildren();
    if (!preview || !decision) {
      this.presetPreview.append(el('p', 'field-hint', '选择预设后可查看影响'));
      this.applyButton.disabled = true;
      return;
    }

    const rows: Array<[string, string]> = [
      ['导出顺序', preview.exportOrderLabel || '（无）'],
      ['分隔符', `${preview.separatorBeforeLabel} → ${preview.separatorAfterLabel}`],
    ];
    if (preview.headingSample) {
      rows.push([
        '标题样式',
        `${preview.headingSample.before ?? '（无）'} → ${preview.headingSample.after}`,
      ]);
    }

    for (const [key, value] of rows) {
      const row = el('div', 'preview-row');
      row.append(el('span', 'preview-key', key), el('code', 'preview-value', value));
      this.presetPreview.append(row);
    }

    // 如实说明"选择预设"对导出的实际影响（已有原文时几乎没有影响）
    this.presetPreview.append(
      el('p', preview.affectsExport ? 'preview-note ok' : 'preview-note warn', preview.effectNote),
    );

    // 顺序差异只在"会影响导出"时才值得提示：
    // 已有原文时导出仍走原文顺序，说"顺序会变"反而是误导。
    if (preview.orderWouldDiffer && preview.affectsExport) {
      this.presetPreview.append(
        el(
          'p',
          'preview-note warn',
          '该预设的板块顺序与当前内容顺序不同，导出会按预设顺序拼装。',
        ),
      );
    }

    // 应用按钮：noop 时禁用（点了也没变化，别让用户困惑）
    this.applyButton.disabled = decision.kind === 'noop';
    this.applyButton.title =
      decision.kind === 'noop' ? decision.message : '会先列出变更供你确认';
  }

  private applyPreset(): void {
    const state = this.callbacks.getState();
    const presetId = this.presetSelect.value;
    const decision = state.decideFor(presetId);
    const preset = state.presets.find((item) => item.id === presetId);
    if (!decision || decision.kind !== 'confirm' || !preset) {
      this.callbacks.notify(decision?.kind === 'noop' ? decision.message : '没有可应用的变化', 'warn');
      return;
    }

    // 二次确认：把 plan.changes 原样交给用户（不自己编文案）
    const detail = decision.plan.changes.length
      ? decision.plan.changes.join('\n')
      : '标题样式将按新预设重写';
    const ok = window.confirm(`${decision.message}\n\n${detail}\n\n确定重排原文吗？此操作可撤销（Ctrl+Z 除外，建议先另存）。`);
    if (!ok) return;

    this.callbacks.onPresetApply(presetId, decision.plan);
    this.renderPresetPreview();
  }

  // ── 导入 ─────────────────────────────────────────────────
  private async importPlatform(): Promise<void> {
    this.hideErrors();
    try {
      const path = await pickRuleFile();
      if (!path) return;
      const file = await readTextExact(path);
      // 校验与原子回退在 app 侧（rule-library），这里只拿结果
      const outcome = this.callbacks.importPlatformText(file.text);
      this.afterImport(outcome, 'platform');
    } catch (error) {
      this.showErrors('读取文件失败', [
        { where: '', message: error instanceof Error ? error.message : String(error), group: '', index: null },
      ]);
    }
  }

  private async importHighlight(): Promise<void> {
    this.hideErrors();
    try {
      const path = await pickRuleFile();
      if (!path) return;
      const file = await readTextExact(path);
      const outcome = this.callbacks.importHighlightText(file.text);
      this.afterImport(outcome, 'highlight');
    } catch (error) {
      this.showErrors('读取文件失败', [
        { where: '', message: error instanceof Error ? error.message : String(error), group: '', index: null },
      ]);
    }
  }

  private afterImport(
    outcome: ImportOutcome<unknown> & { id: string | null; name: string | null },
    kind: 'platform' | 'highlight',
  ): void {
    if (!outcome.ok) {
      this.showErrors(
        `导入失败，已保留原有${kind === 'platform' ? '平台规则' : '高亮方案'}（未做任何修改）`,
        outcome.issues,
      );
      this.callbacks.notify(
        `导入失败：${outcome.issues.length} 处问题，原${kind === 'platform' ? '规则' : '方案'}未被修改`,
        'bad',
      );
      return;
    }

    if (outcome.warnings.length > 0) {
      this.callbacks.notify(
        `导入成功（${outcome.name ?? outcome.id}），但有 ${outcome.warnings.length} 条警告`,
        'warn',
      );
    } else {
      this.callbacks.notify(`导入成功：${outcome.name ?? outcome.id}`, 'ok');
    }
    this.refresh();
    this.renderPresetPreview();
  }

  private showErrors(title: string, issues: readonly RuleIssue[]): void {
    this.errorBox.replaceChildren();
    this.errorBox.hidden = false;

    const head = el('div', 'rule-errors-head');
    head.append(el('span', 'rule-errors-title', title));
    const count = el('span', 'rule-errors-count', `${issues.length} 处`);
    head.append(count);
    this.errorBox.append(head);

    for (const group of groupRuleIssues(issues)) {
      const section = el('div', 'rule-error-group');
      section.append(el('div', 'rule-error-group-title', group.title));
      for (const item of group.items) {
        const row = el('div', 'rule-error-row');
        if (item.where) {
          // 显示"哪个字段"——这是用户要求的位置信息
          row.append(el('code', 'rule-error-where', item.where));
        }
        row.append(el('span', 'rule-error-msg', item.message));
        section.append(row);
      }
      this.errorBox.append(section);
    }
  }

  /** 展示一次导入失败（供调试入口与外部调用；正常导入流程内部会自己调） */
  showImportFailure(outcome: {
    issues: readonly RuleIssue[];
    ok: boolean;
  }): void {
    if (outcome.ok) {
      this.hideErrors();
      return;
    }
    this.showErrors('导入失败，已保留原有平台规则（未做任何修改）', outcome.issues);
  }

  private hideErrors(): void {
    this.errorBox.hidden = true;
    this.errorBox.replaceChildren();
  }

  // ── 导出 ─────────────────────────────────────────────────
  private async exportPlatform(): Promise<void> {
    const state = this.callbacks.getState();
    const text = this.callbacks.exportPlatformRule(state.platformId);
    if (!text) {
      this.callbacks.notify('当前平台规则没有可导出的原文（可能来自内置包）', 'warn');
      return;
    }
    await this.saveAs(`${state.platformId}.json`, text);
  }

  private async exportHighlight(): Promise<void> {
    const state = this.callbacks.getState();
    const text = this.callbacks.exportHighlightScheme(state.highlightId);
    if (!text) {
      this.callbacks.notify('当前高亮方案没有可导出的原文（可能来自内置包）', 'warn');
      return;
    }
    await this.saveAs(`${state.highlightId}.json`, text);
  }

  private async saveAs(name: string, text: string): Promise<void> {
    try {
      const target = await pickSavePath(name, 'json');
      if (!target) return;
      const receipt = await writeFileAtomic(target, text);
      this.callbacks.notify(
        `已导出：${receipt.pathDisplay ?? '(非 UTF-8 路径)'} · ${receipt.bytesWritten} 字节`,
        'ok',
      );
    } catch (error) {
      this.callbacks.notify(
        `导出失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }
}
export type { RuleIssue };
