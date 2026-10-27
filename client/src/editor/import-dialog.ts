/**
 * 导入对话框（T10.9）：TXT 角色卡 / 世界书。
 *
 * 一个对话框挂两种导入，因为它们要展示的东西**完全同构**：
 * 「识别到了什么 + 有哪些问题 + 要不要按这个结果导入」。分成两个类会把
 * 问题列表渲染、模式切换、确认逻辑各写两遍，而这两处最容易长歪。
 *
 * 三条界面规则：
 *
 *  1. **严格失败不是终点**。TXT 严格模式会因缺板块中止（docs/06），
 *     对话框就地提供「改用宽松模式重试」——不然用户只能自己猜哪里缺了。
 *  2. **问题列表要带行号**。只说"缺板块"而不给行号，用户得从头数。
 *  3. **世界书导入前必须让用户看到条目数与格式**。导入世界书会**替换**整个
 *     世界书板块（entries + 文本），这是破坏性操作；不说清楚条目数就点确定，
 *     等于让用户在不知道覆盖了多少的情况下去覆盖。
 */

import type {
  PreservedInfo,
  GreetingFormatParams,
  TxtPreset,
  UnifiedCard,
  WorldbookFormat,
  WorldbookFormatParams,
  WorldbookImportResult,
} from '@tcs/shared';

import {
  previewCardText,
  previewWorldbook,
  type CardTextPreview,
  type ImportIssueView,
  type ImportMode,
  type WorldbookPreview,
} from './import-flow';

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

export interface CardTextImportDecision {
  card: UnifiedCard;
  mode: ImportMode;
  issues: ImportIssueView[];
  /** 保全结论（v0.1.2）：调用方据此在状态栏说明"多少段原文进了【其他设定】" */
  preserved: PreservedInfo | null;
  /** 与对话框里显示的是同一句，避免两处措辞漂移 */
  preservedNote: string;
}

export interface WorldbookImportDecision {
  preview: WorldbookPreview;
  result: WorldbookImportResult;
}

export interface ImportDialogDeps {
  /** 当前卡的深拷贝（严格/宽松判定都需要"导入前"的卡做基线） */
  getCard: () => UnifiedCard;
  /** 当前预设（TXT 分块按它切） */
  getPreset: () => TxtPreset | null;
  /**
   * 初始场景预设的分隔格式（v0.1.3 追加项一）；缺省 = 冻结默认。
   *
   * TXT 导入必须用**用户当前选的**那套分隔符：他手上的卡可能就是用 `===`
   * 分段的（来自别的工具），按冻结默认切会把整段当成一条开场白。
   */
  getGreetingFormat?: () => GreetingFormatParams | undefined;
  /**
   * 当前世界书格式（v0.1.5 / G4）。
   *
   * TXT 卡里可能带世界书段，片段格式按用户选中的预设解析 —— 不传就会用
   * 冻结的 `@@ENTRY` 格式，自定义格式（`【条目N：…】`）一条都认不出。
   */
  getWorldbookFormat?: () => WorldbookFormatParams | undefined;
}

export class ImportDialog {
  private readonly overlay: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly issuesEl: HTMLElement;
  private readonly modeRow: HTMLElement;
  private readonly modeNote: HTMLElement;
  private readonly strictRadio: HTMLInputElement;
  private readonly lenientRadio: HTMLInputElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  /** 当前导入类型与原始文本（切换模式时重新预览） */
  private kind: 'card-text' | 'worldbook' = 'card-text';
  private rawText = '';
  private fileName = '';
  private mode: ImportMode = 'lenient';
  private cardPreview: CardTextPreview | null = null;
  private worldbookPreview: WorldbookPreview | null = null;
  private worldbookFormat: WorldbookFormatParams | undefined;
  private resolve: ((decision: CardTextImportDecision | WorldbookImportDecision | null) => void) | null = null;

  constructor(private readonly deps: ImportDialogDeps) {
    this.overlay = el('div', 'modal-overlay modal-overlay-top');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'import-dialog';

    const panel = el('div', 'modal wide import-modal');

    const head = el('div', 'modal-head');
    this.title = el('h2', 'modal-title', '导入');
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.finish(null));
    head.append(this.title, close);

    const body = el('div', 'modal-body');
    this.subtitle = el('p', 'field-hint import-subtitle');
    this.subtitle.dataset['role'] = 'import-file';

    this.summaryEl = el('div', 'import-summary');
    this.summaryEl.dataset['role'] = 'import-summary';

    // 模式切换（仅 TXT 角色卡用；世界书导入没有严格/宽松之分）
    this.modeRow = el('div', 'field-row import-mode');
    const modeLabel = el('span', 'field-label', '导入模式');
    const strictLabel = el('label', 'check');
    this.strictRadio = document.createElement('input');
    this.strictRadio.type = 'radio';
    this.strictRadio.name = 'import-mode';
    this.strictRadio.value = 'strict';
    this.strictRadio.dataset['role'] = 'import-mode-strict';
    this.strictRadio.addEventListener('change', () => void this.switchMode('strict'));
    strictLabel.append(this.strictRadio, el('span', 'check-label', '严格（缺板块即中止）'));

    const lenientLabel = el('label', 'check');
    this.lenientRadio = document.createElement('input');
    this.lenientRadio.type = 'radio';
    this.lenientRadio.name = 'import-mode';
    this.lenientRadio.value = 'lenient';
    this.lenientRadio.dataset['role'] = 'import-mode-lenient';
    this.lenientRadio.addEventListener('change', () => void this.switchMode('lenient'));
    lenientLabel.append(this.lenientRadio, el('span', 'check-label', '宽松（缺板块按空处理并警告）'));

    this.modeRow.append(modeLabel, strictLabel, lenientLabel);

    // 保全机制启用后两种模式行为一致，这件事必须在界面上说出来（见 render()）
    this.modeNote = el('p', 'import-mode-note', '');
    this.modeNote.dataset['role'] = 'import-mode-note';
    this.modeNote.hidden = true;

    this.issuesEl = el('div', 'import-issues');
    this.issuesEl.dataset['role'] = 'import-issues';

    body.append(this.subtitle, this.modeRow, this.modeNote, this.summaryEl, this.issuesEl);

    const foot = el('div', 'modal-foot');
    this.cancelButton = el('button', 'btn', '取消');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.finish(null));
    this.confirmButton = el('button', 'btn primary', '导入') as HTMLButtonElement;
    this.confirmButton.type = 'button';
    this.confirmButton.dataset['role'] = 'import-confirm';
    this.confirmButton.addEventListener('click', () => this.confirm());
    foot.append(el('span', 'foot-note', '导入会替换当前卡对应内容；可撤销请先另存'), this.cancelButton, this.confirmButton);

    panel.append(head, body, foot);
    this.overlay.append(panel);
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.finish(null);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.finish(null);
    });

    document.body.append(this.overlay);
  }

  /** 打开 TXT 角色卡导入 */
  openCardText(fileName: string, text: string): Promise<CardTextImportDecision | null> {
    this.kind = 'card-text';
    this.rawText = text;
    this.fileName = fileName;
    this.mode = 'lenient'; // 先用宽松预览：能让用户一眼看到"缺哪些板块"，而不是直接被拒
    this.title.textContent = '导入 TXT 角色卡';
    this.modeRow.hidden = false;
    this.overlay.hidden = false;
    this.render();
    return this.awaitDecision() as Promise<CardTextImportDecision | null>;
  }

  /** 打开世界书导入 */
  openWorldbook(
    fileName: string,
    text: string,
    /** 当前世界书格式预设（T10.31）：预览必须按它解析，否则自定义格式的文件会显示成"没有条目" */
    format?: WorldbookFormatParams,
  ): Promise<WorldbookImportDecision | null> {
    this.kind = 'worldbook';
    this.worldbookFormat = format;
    this.rawText = text;
    this.fileName = fileName;
    this.title.textContent = '导入世界书';
    this.modeRow.hidden = true;
    this.overlay.hidden = false;
    this.render();
    return this.awaitDecision() as Promise<WorldbookImportDecision | null>;
  }

  private awaitDecision(): Promise<CardTextImportDecision | WorldbookImportDecision | null> {
    if (this.resolve) this.resolve(null); // 上一个没关掉的等待要放掉，否则它的 await 永远不返回
    return new Promise((resolveOne) => {
      this.resolve = resolveOne;
    });
  }

  private async switchMode(mode: ImportMode): Promise<void> {
    if (this.mode === mode) return;
    this.mode = mode;
    this.render();
  }

  private render(): void {
    const preset = this.deps.getPreset();
    this.subtitle.textContent = `${this.fileName} · ${String(this.rawText.length)} 字符`;

    if (this.kind === 'worldbook') {
      this.worldbookPreview = previewWorldbook(this.rawText, this.worldbookFormat);
      this.cardPreview = null;
      this.strictRadio.checked = false;
      this.lenientRadio.checked = false;
      this.modeNote.hidden = true;
      this.renderWorldbookSummary(this.worldbookPreview);
      this.renderIssues(this.worldbookPreview.issues);
      this.setConfirm(this.worldbookPreview.canImport, '导入世界书');
      return;
    }

    if (preset === null) {
      this.summaryEl.replaceChildren(el('p', 'import-summary-line bad', '没有加载到 TXT 预设，无法按预设切分板块'));
      this.issuesEl.replaceChildren();
      this.setConfirm(false, '导入');
      return;
    }

    this.strictRadio.checked = this.mode === 'strict';
    this.lenientRadio.checked = this.mode === 'lenient';
    this.cardPreview = previewCardText(
      this.deps.getCard(),
      this.rawText,
      preset,
      this.mode,
      this.deps.getGreetingFormat?.(),
      this.deps.getWorldbookFormat?.(),
    );
    this.worldbookPreview = null;

    this.summaryEl.replaceChildren();
    const lines: string[] = [];
    lines.push(`预设：${preset.id}`);
    if (this.cardPreview.canImport) {
      // 板块计数分两种口径，不能混用：
      //   · 有保全结论时用 `preserved.blockCount`（= 认出的**标题**数）；
      //   · 否则用"非空板块数"（旧口径）。
      // 混用的后果实测过：0 命中样本里【其他设定】装着全文，于是"非空板块"数是 1，
      // 而下一行又说"未识别到任何板块" —— 同一屏两句话互相矛盾。
      if (this.cardPreview.preserved !== null) {
        lines.push(`识别到 ${String(this.cardPreview.preserved.blockCount)} 个板块（按标题判定，含世界书）`);
      } else {
        const blockCount = this.cardPreview.card?.blocks.filter((block) => block.text.trim() !== '').length ?? 0;
        lines.push(`识别到 ${String(blockCount)} 个非空板块`);
      }
      if (this.cardPreview.worldbookEntries > 0) {
        lines.push(`世界书 ${String(this.cardPreview.worldbookEntries)} 个条目`);
      }
      // 保全结论放在最显眼的位置：它决定了"我的原文到底去哪了"，
      // 比"识别到几个板块"更该被读到（v0.1.2 反馈项二）。
      if (this.cardPreview.preservedNote !== '') {
        lines.push(this.cardPreview.preservedNote);
      }
      if (this.cardPreview.missingBlocks.length > 0) {
        // 这些板块确实是空的 —— 必须显式点名，不能只说"已按空处理"
        lines.push(`这些板块为空：${this.cardPreview.missingBlocks.join('、')}`);
      }
    } else {
      lines.push('无法导入（见下面的问题列表）');
    }
    for (const line of lines) {
      this.summaryEl.append(el('p', 'import-summary-line', line));
    }

    // 保全机制让"严格/宽松"在 TXT 导入上不再改变结果，界面上要说明这一点，
    // 否则用户会以为切了模式没生效（两个选项看起来可用、行为却一样）。
    this.modeNote.hidden = !(this.cardPreview.preserved !== null);
    this.modeNote.textContent = '提示：原文保全已启用 —— 缺板块不再中止导入，未识别内容一律放进【其他设定】。';

    this.renderIssues(this.cardPreview.issues);
    this.setConfirm(this.cardPreview.canImport, '导入');
  }

  private renderWorldbookSummary(preview: WorldbookPreview): void {
    this.summaryEl.replaceChildren();
    const formatLabel = preview.format === 'json' ? 'character_book JSON' : preview.format === 'txt' ? '世界书 TXT' : '未识别';
    const lines = [`识别格式：${formatLabel}`];
    if (preview.canImport) {
      lines.push(`解析出 ${String(preview.entryCount)} 个条目 —— 导入将**替换**当前世界书`);
    } else {
      lines.push('无法导入（见下面的问题列表）');
    }
    for (const line of lines) {
      const isReplace = line.includes('替换');
      this.summaryEl.append(el('p', `import-summary-line${isReplace ? ' warn' : ''}`, line));
    }
  }

  private renderIssues(issues: readonly ImportIssueView[]): void {
    this.issuesEl.replaceChildren();
    if (issues.length === 0) {
      this.issuesEl.append(el('p', 'import-issues-empty', '没有发现问题'));
      return;
    }
    const head = el('p', 'import-issues-head', `发现 ${String(issues.length)} 个问题`);
    const list = el('ul', 'import-issues-list');
    list.dataset['role'] = 'import-issues-list';
    for (const issue of issues) {
      const item = el('li', `import-issue ${issue.severity}`);
      item.dataset['severity'] = issue.severity;
      const where = issue.line === undefined ? '' : `第 ${String(issue.line)} 行：`;
      item.append(el('span', 'import-issue-text', `${where}${issue.message}`));
      if (issue.hint !== undefined && issue.hint !== '') {
        item.append(el('span', 'import-issue-hint', issue.hint));
      }
      list.append(item);
    }
    this.issuesEl.append(head, list);
  }

  private setConfirm(enabled: boolean, label: string): void {
    this.confirmButton.disabled = !enabled;
    this.confirmButton.textContent = label;
    // 注意：**不换 data-role**。用途用 `data-intent` 表达：
    // 换 role 会让"按 role 找按钮"的地方（端到端脚本、辅助技术）在切换后突然找不到它。
    this.confirmButton.dataset['intent'] = 'confirm';
    // 严格失败时把"改用宽松"做成直达入口：用户不需要自己去找单选按钮
    if (!enabled && this.kind === 'card-text' && this.mode === 'strict') {
      this.confirmButton.textContent = '改用宽松模式重试';
      this.confirmButton.disabled = false;
      this.confirmButton.dataset['intent'] = 'retry-lenient';
    }
  }

  private confirm(): void {
    // 「改用宽松重试」共用了同一个按钮：用 intent 区分意图，避免两个按钮叠在一起
    if (this.confirmButton.dataset['intent'] === 'retry-lenient') {
      void this.switchMode('lenient');
      return;
    }

    if (this.kind === 'worldbook') {
      const preview = this.worldbookPreview;
      if (!preview || !preview.canImport) return;
      this.finish({ preview, result: preview.result });
      return;
    }

    const preview = this.cardPreview;
    if (!preview || !preview.card) return;
    this.finish({
      card: preview.card,
      mode: this.mode,
      issues: preview.issues,
      preserved: preview.preserved,
      preservedNote: preview.preservedNote,
    });
  }

  private finish(decision: CardTextImportDecision | WorldbookImportDecision | null): void {
    this.overlay.hidden = true;
    const resolve = this.resolve;
    this.resolve = null;
    resolve?.(decision);
  }

  /** 端到端断言用 */
  get currentIssues(): readonly ImportIssueView[] {
    return this.kind === 'worldbook'
      ? (this.worldbookPreview?.issues ?? [])
      : (this.cardPreview?.issues ?? []);
  }

  /** 当前识别的世界书格式（世界书导入时有效） */
  get detectedFormat(): WorldbookFormat | null {
    return this.worldbookPreview?.format ?? null;
  }
}
