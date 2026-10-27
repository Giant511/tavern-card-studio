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

import type { FieldPreset, PresetApplyPlan, TxtPreset, WorldbookPreset } from '@tcs/shared';

import {
  pickRuleFile,
  pickSavePath,
  readTextExact,
  isShellAvailable,
  askConfirm,
  writeFileAtomic,
} from '../contract';

import {
  groupRuleIssues,
  importHighlightScheme,
  importPlatformRule,
  splitRuleError,
  type ImportOutcome,
  type RuleIssue,
} from './rule-library';
import type { PresetImportOutcome } from './preset-library';
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
  /** 导入 TXT 预设（T10.30）：原子回退、同 id 覆盖、不自动切换 */
  importTxtPresetText: (text: string) => PresetImportOutcome<TxtPreset[]>;
  /** 导入世界书预设（T10.31） */
  importWorldbookPresetText: (text: string) => PresetImportOutcome<WorldbookPreset[]>;
  /** 选中世界书预设（只改导出/解析格式） */
  onWorldbookPresetSelect: (id: string) => void;

  /** 导入 / 选中 / 导出字段板块预设（v0.1.3 追加项一） */
  importGreetingPresetText: (text: string) => PresetImportOutcome<FieldPreset[]>;
  onGreetingPresetSelect: (id: string) => void;
  exportGreetingPreset: (id: string) => string | null;
  importChatExamplePresetText: (text: string) => PresetImportOutcome<FieldPreset[]>;
  onChatExamplePresetSelect: (id: string) => void;
  exportChatExamplePreset: (id: string) => string | null;

  /** 当前状态快照 */
  getState: () => DialogState;
  /** 状态栏消息 */
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 导出时取当前规则原文（null = 无原文可导出） */
  exportPlatformRule: (id: string) => string | null;
  exportHighlightScheme: (id: string) => string | null;
  /** 导出当前预设（T10.30/31）：返回完整 JSON，含用户自定义项 */
  exportTxtPreset: (id: string) => string | null;
  exportWorldbookPreset: (id: string) => string | null;
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
  worldbookPresetId: string | null;
  worldbookPresets: Array<{ id: string; name: string; builtin: boolean; summary: string }>;
  /** 初始场景 / 对话示例预设（v0.1.3 追加项一） */
  greetingPresetId: string | null;
  greetingPresets: Array<{ id: string; name: string; builtin: boolean; summary: string }>;
  /**
   * 「初始场景」当前分隔符从哪来：greeting-preset / txt-preset / frozen。
   * 面板要如实说一句 —— TXT 预设里也有一份 greeting.separator（v0.1.3 早期写法），
   * 不说清的话用户会以为自己选的预设没生效。
   */
  greetingFormatSource: 'greeting-preset' | 'txt-preset' | 'frozen';
  chatExamplePresetId: string | null;
  chatExamplePresets: Array<{ id: string; name: string; builtin: boolean; summary: string }>;
}

export class RulesDialog {
  private readonly overlay: HTMLDivElement;
  private readonly platformSelect: HTMLSelectElement;
  private readonly highlightSelect: HTMLSelectElement;
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetPreview: HTMLElement;
  private readonly worldbookSelect: HTMLSelectElement;
  private readonly worldbookSummary: HTMLElement;
  private readonly greetingSelect: HTMLSelectElement;
  private readonly greetingSummary: HTMLElement;
  private readonly greetingSourceNote: HTMLElement;
  private readonly chatExampleSelect: HTMLSelectElement;
  private readonly chatExampleSummary: HTMLElement;
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
    this.applyButton = this.actionButton('应用预设（重排原文）…', () => void this.applyPreset());
    this.applyButton.classList.add('primary');
    presetActions.append(
      this.applyButton,
      this.actionButton('导入预设文件…', () => void this.importTxtPreset()),
      this.actionButton('导出当前预设…', () => void this.exportTxtPreset()),
    );

    const presetHint = el(
      'p',
      'field-hint',
      '「选择预设」只改变导出时的标题与顺序；只有「应用预设」会重排原文，且会先列出变更让你确认。导入预设不会自动切换到它。',
    );
    presetSection.append(
      presetTitle,
      this.presetSelect,
      this.presetPreview,
      presetActions,
      presetHint,
    );

    // ── ④ 世界书预设（格式轨，T10.31）────────────────────
    const wbSection = el('section', 'form-section');
    const wbTitle = el('h3', 'form-title', '世界书预设');
    const wbHint = el(
      'p',
      'field-hint',
      '决定世界书文本的写法：条目如何分隔、每项叫什么、按什么顺序排列。切换后世界书的导出、导入与格式检查都按它走。',
    );

    this.worldbookSelect = el('select', 'select wide') as HTMLSelectElement;
    this.worldbookSelect.dataset['role'] = 'worldbook-preset-select';
    this.worldbookSelect.addEventListener('change', () => {
      const id = this.worldbookSelect.value;
      this.callbacks.onWorldbookPresetSelect(id);
      this.callbacks.notify(`已切换世界书预设：${this.labelOf(this.worldbookSelect)}`, 'ok');
      this.renderWorldbookSummary();
    });

    this.worldbookSummary = el('div', 'preset-preview');
    this.worldbookSummary.dataset['role'] = 'worldbook-preset-summary';

    const wbActions = el('div', 'field-row');
    wbActions.append(
      this.actionButton('导入世界书预设…', () => void this.importWorldbookPreset()),
      this.actionButton('导出当前世界书预设…', () => void this.exportWorldbookPreset()),
    );
    wbSection.append(wbTitle, this.worldbookSelect, this.worldbookSummary, wbActions, wbHint);

    // ── ⑤ 初始场景预设（格式轨，v0.1.3 追加项一）──────────
    const greetingSection = el('section', 'form-section');
    greetingSection.dataset['role'] = 'greeting-preset-section';
    const greetingTitle = el('h3', 'form-title', '初始场景预设');
    const greetingHint = el(
      'p',
      'field-hint',
      '决定「初始场景」怎么写：多条开场白之间的分隔行、以及可选的段标签行。' +
        '内置「标准初始场景」等价于 v0.1.3 冻结格式（空行+--- +空行，不写标签）。' +
        '**只影响格式**，不评价开场白写得好不好。',
    );

    this.greetingSelect = el('select', 'select wide') as HTMLSelectElement;
    this.greetingSelect.dataset['role'] = 'greeting-preset-select';
    this.greetingSelect.addEventListener('change', () => {
      const id = this.greetingSelect.value;
      this.callbacks.onGreetingPresetSelect(id);
      this.renderGreetingSummary();
    });

    this.greetingSummary = el('div', 'preset-preview');
    this.greetingSummary.dataset['role'] = 'greeting-preset-summary';
    // 来源提示：TXT 预设里也有一份 greeting.separator（v0.1.3 早期写法）。
    // 不说清"现在生效的是哪一份"，用户会以为自己选的预设没起作用。
    this.greetingSourceNote = el('p', 'field-hint');
    this.greetingSourceNote.dataset['role'] = 'greeting-format-source';

    const greetingActions = el('div', 'field-row');
    greetingActions.append(
      this.actionButton('导入初始场景预设…', () => void this.importFieldPreset('greeting')),
      this.actionButton('导出当前初始场景预设…', () => void this.exportFieldPreset('greeting')),
    );
    greetingSection.append(
      greetingTitle,
      this.greetingSelect,
      this.greetingSummary,
      this.greetingSourceNote,
      greetingActions,
      greetingHint,
    );

    // ── ⑥ 对话示例预设（格式轨，v0.1.3 追加项一）──────────
    const exampleSection = el('section', 'form-section');
    exampleSection.dataset['role'] = 'chat-example-preset-section';
    const exampleTitle = el('h3', 'form-title', '对话示例预设');
    const exampleHint = el(
      'p',
      'field-hint',
      '决定「对话示例」怎么读：轮次分隔（只用于审计统计轮数，**不改写正文**）与轮次称呼。' +
        '内置「标准对话示例」= 不切分，即 v0.1.3 冻结行为。',
    );

    this.chatExampleSelect = el('select', 'select wide') as HTMLSelectElement;
    this.chatExampleSelect.dataset['role'] = 'chat-example-preset-select';
    this.chatExampleSelect.addEventListener('change', () => {
      const id = this.chatExampleSelect.value;
      this.callbacks.onChatExamplePresetSelect(id);
      this.renderChatExampleSummary();
    });

    this.chatExampleSummary = el('div', 'preset-preview');
    this.chatExampleSummary.dataset['role'] = 'chat-example-preset-summary';

    const exampleActions = el('div', 'field-row');
    exampleActions.append(
      this.actionButton('导入对话示例预设…', () => void this.importFieldPreset('example')),
      this.actionButton('导出当前对话示例预设…', () => void this.exportFieldPreset('example')),
    );
    exampleSection.append(
      exampleTitle,
      this.chatExampleSelect,
      this.chatExampleSummary,
      exampleActions,
      exampleHint,
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

    panel.append(
      head,
      platformSection,
      highlightSection,
      presetSection,
      wbSection,
      greetingSection,
      exampleSection,
      this.errorBox,
      foot,
    );
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

    this.worldbookSelect.replaceChildren();
    for (const preset of state.worldbookPresets) {
      const option = el('option');
      option.value = preset.id;
      option.textContent = `${preset.name}${preset.builtin ? '' : '（自定义）'}`;
      this.worldbookSelect.append(option);
    }
    if (state.worldbookPresetId) this.worldbookSelect.value = state.worldbookPresetId;

    this.fillFieldPresetSelect(this.greetingSelect, state.greetingPresets, state.greetingPresetId);
    this.fillFieldPresetSelect(this.chatExampleSelect, state.chatExamplePresets, state.chatExamplePresetId);

    this.hideErrors();
    this.renderPresetPreview();
    this.renderWorldbookSummary();
    this.renderGreetingSummary();
    this.renderChatExampleSummary();
    this.overlay.hidden = false;
  }

  /** 两个字段板块下拉共用的填充逻辑（少一份重复就少一处"只改了一边"） */
  private fillFieldPresetSelect(
    select: HTMLSelectElement,
    presets: readonly { id: string; name: string; builtin: boolean }[],
    currentId: string | null,
  ): void {
    select.replaceChildren();
    for (const preset of presets) {
      const option = el('option');
      option.value = preset.id;
      option.textContent = `${preset.name}${preset.builtin ? '' : '（自定义）'}`;
      select.append(option);
    }
    if (currentId !== null) select.value = currentId;
  }

  /**
   * 世界书预设摘要。
   *
   * 为什么不画示例：格式参数有 8 个，画出来只会变成一堵墙。
   * 用户真正要确认的是「条目开标记长什么样、字段标签是不是中文」——
   * 给出这两行就够判断选对没选对。
   */
  private renderWorldbookSummary(): void {
    const state = this.callbacks.getState();
    const id = this.worldbookSelect.value;
    const preset = state.worldbookPresets.find((item) => item.id === id);
    this.worldbookSummary.replaceChildren();
    if (!preset) {
      this.worldbookSummary.append(el('p', 'field-hint', '未选择世界书预设'));
      return;
    }
    for (const [key, value] of [
      ['格式', preset.summary],
      ['项目名称', preset.builtin ? '使用默认名称' : '由该预设自行定义'],
    ] as Array<[string, string]>) {
      const row = el('div', 'preview-row');
      row.append(el('span', 'preview-key', key), el('code', 'preview-value', value));
      this.worldbookSummary.append(row);
    }
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
    if (state.worldbookPresetId) this.worldbookSelect.value = state.worldbookPresetId;
    this.fillFieldPresetSelect(this.greetingSelect, state.greetingPresets, state.greetingPresetId);
    this.fillFieldPresetSelect(this.chatExampleSelect, state.chatExamplePresets, state.chatExamplePresetId);
    this.renderWorldbookSummary();
    this.renderGreetingSummary();
    this.renderChatExampleSummary();
  }

  /** 初始场景预设摘要 + 「现在生效的是哪一份」 */
  private renderGreetingSummary(): void {
    const state = this.callbacks.getState();
    const id = this.greetingSelect.value;
    const preset = state.greetingPresets.find((item) => item.id === id);
    this.greetingSummary.replaceChildren();
    if (!preset) {
      this.greetingSummary.append(el('p', 'field-hint', '未选择初始场景预设'));
    } else {
      const row = el('div', 'preview-row');
      row.append(el('span', 'preview-key', '格式'), el('code', 'preview-value', preset.summary));
      this.greetingSummary.append(row);
    }

    const source = state.greetingFormatSource;
    if (source === 'txt-preset') {
      // 这一句必须说：TXT 预设里也有一份 greeting.separator（v0.1.3 早期写法）。
      // 用户换了初始场景预设却看到"来自 TXT 预设"时，至少知道是两者冲突，
      // 而不是以为功能坏了。
      this.greetingSourceNote.textContent =
        '当前生效的分隔符来自 TXT 预设的 greeting.separator（旧写法）；选择一份自定义的初始场景预设会覆盖它。';
      this.greetingSourceNote.dataset['source'] = 'txt-preset';
    } else {
      this.greetingSourceNote.textContent =
        source === 'frozen'
          ? '当前使用冻结默认分隔符（空行 + --- + 空行）。'
          : '当前生效的分隔符来自上选的初始场景预设。';
      this.greetingSourceNote.dataset['source'] = source;
    }
  }

  private renderChatExampleSummary(): void {
    const state = this.callbacks.getState();
    const id = this.chatExampleSelect.value;
    const preset = state.chatExamplePresets.find((item) => item.id === id);
    this.chatExampleSummary.replaceChildren();
    if (!preset) {
      this.chatExampleSummary.append(el('p', 'field-hint', '未选择对话示例预设'));
      return;
    }
    const row = el('div', 'preview-row');
    row.append(el('span', 'preview-key', '格式'), el('code', 'preview-value', preset.summary));
    this.chatExampleSummary.append(row);
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

  private async applyPreset(): Promise<void> {
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
    const ok = await askConfirm(`${decision.message}\n\n${detail}\n\n确定重排原文吗？此操作可撤销（Ctrl+Z 除外，建议先另存）。`, '应用预设');
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
      // 只给"几条警告"是不够的：用户必须看到**是哪几个字段**，
      // 否则"导入成功"和"规则没生效"之间的因果永远对不上（F4）。
      this.showWarnings(`导入成功，但有以下需要注意的问题`, outcome.warnings);
    } else {
      this.hideErrors();
      this.callbacks.notify(`导入成功：${outcome.name ?? outcome.id}`, 'ok');
    }
    this.refresh();
    this.renderPresetPreview();
  }

  /**
   * 展示"导入成功但有警告"（T10.10 补 F4：未知字段）。
   *
   * 与错误共用同一个盒子，只换配色 —— 两种情况互斥，不会同时出现，
   * 分成两个盒子反而会出现"上面红框、下面黄框"的混乱布局。
   */
  private showWarnings(title: string, warnings: readonly string[]): void {
    this.errorBox.replaceChildren();
    this.errorBox.classList.add('warn');
    this.errorBox.hidden = false;

    const head = el('div', 'rule-errors-head');
    head.append(el('span', 'rule-errors-title', title));
    head.append(el('span', 'rule-errors-count', `${warnings.length} 条`));
    this.errorBox.append(head);

    const section = el('div', 'rule-error-group');
    for (const text of warnings) {
      const issue = splitRuleError(text);
      const row = el('div', 'rule-error-row');
      if (issue.where) row.append(el('code', 'rule-error-where', issue.where));
      row.append(el('span', 'rule-error-msg', issue.message));
      section.append(row);
    }
    this.errorBox.append(section);
  }

  private showErrors(title: string, issues: readonly RuleIssue[]): void {
    this.errorBox.replaceChildren();
    this.errorBox.classList.remove('warn');
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
    this.errorBox.classList.remove('warn');
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

  private async importTxtPreset(): Promise<void> {
    await this.importPreset('txt');
  }

  private async importWorldbookPreset(): Promise<void> {
    await this.importPreset('worldbook');
  }

  /** greeting = 初始场景预设，example = 对话示例预设（两个入口共用一套流程） */
  private async importFieldPreset(kind: 'greeting' | 'example'): Promise<void> {
    await this.importPreset(kind);
  }

  private async exportFieldPreset(kind: 'greeting' | 'example'): Promise<void> {
    const id = kind === 'greeting' ? this.greetingSelect.value : this.chatExampleSelect.value;
    const text =
      kind === 'greeting'
        ? this.callbacks.exportGreetingPreset(id)
        : this.callbacks.exportChatExamplePreset(id);
    if (text === null) {
      this.callbacks.notify('这份预设无法导出（可能来自内置包）', 'warn');
      return;
    }
    await this.saveAs(`${id}.json`, text);
  }

  /**
   * 预设导入（T10.30/31）。
   *
   * 与平台规则的导入共用同一套展示：失败列字段、成功但有 warning 也列出来。
   * 「不自动切换」是刻意的 —— 导入是往候选列表里加东西，不是"立刻改用"。
   * 用户正在看一份按当前预设排版的内容，格式被悄悄换掉会让人以为文件坏了。
   */
  private async importPreset(kind: 'txt' | 'worldbook' | 'greeting' | 'example'): Promise<void> {
    this.hideErrors();
    let text: string;
    try {
      const path = await pickRuleFile();
      if (!path) return;
      const file = await readTextExact(path);
      text = file.text;
    } catch (error) {
      this.showErrors('读取文件失败', [
        { where: '', message: error instanceof Error ? error.message : String(error), group: '', index: null },
      ]);
      return;
    }

    const label =
      kind === 'txt'
        ? '预设'
        : kind === 'worldbook'
          ? '世界书预设'
          : kind === 'greeting'
            ? '初始场景预设'
            : '对话示例预设';
    const outcome =
      kind === 'txt'
        ? this.callbacks.importTxtPresetText(text)
        : kind === 'worldbook'
          ? this.callbacks.importWorldbookPresetText(text)
          : kind === 'greeting'
            ? this.callbacks.importGreetingPresetText(text)
            : this.callbacks.importChatExamplePresetText(text);

    if (!outcome.ok) {
      this.showErrors(`导入失败，已保留原有${label}列表（未做任何修改）`, outcome.issues);
      this.callbacks.notify(`导入失败：${outcome.issues.length} 处问题，原${label}未变`, 'bad');
      return;
    }

    const notes = [...outcome.warnings];
    if (outcome.renameHint !== '') notes.push(outcome.renameHint);
    if (notes.length > 0) {
      this.showWarnings(`导入成功（${outcome.name ?? outcome.id}），但有以下需要注意的问题`, notes);
      this.callbacks.notify(
        `导入成功${outcome.replaced ? '（覆盖同 id 预设）' : ''}：${outcome.name ?? outcome.id}，${notes.length} 条提示`,
        'warn',
      );
    } else {
      this.hideErrors();
      this.callbacks.notify(
        `导入成功${outcome.replaced ? '（覆盖同 id 预设）' : ''}：${outcome.name ?? outcome.id}`,
        'ok',
      );
    }
    this.refresh();
    this.renderPresetPreview();
  }

  private async exportTxtPreset(): Promise<void> {
    const state = this.callbacks.getState();
    const id = this.presetSelect.value;
    const text = this.callbacks.exportTxtPreset(id);
    if (!text) {
      this.callbacks.notify('当前预设无法导出', 'warn');
      return;
    }
    await this.saveAs(`${id || 'preset'}.preset.json`, text);
  }

  private async exportWorldbookPreset(): Promise<void> {
    const id = this.worldbookSelect.value;
    const text = this.callbacks.exportWorldbookPreset(id);
    if (!text) {
      this.callbacks.notify('当前世界书预设无法导出', 'warn');
      return;
    }
    await this.saveAs(`${id || 'worldbook-preset'}.worldbook.json`, text);
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
