/**
 * 导出流程 UI（T6.6）：格式选择 → 审计闸门 → 保存对话框 → 写文件 → 回执摘要。
 *
 * 闸门语义（阶段 4 定下）：`summary.exportable === false` 时**必须**让用户显式选
 * 「仍要导出 / 取消」，默认焦点在「取消」上——避免误按回车就导出坏卡。
 */

import type { AuditReport, GreetingFormatParams, TxtPreset, UnifiedCard } from '@tcs/shared';

import { askConfirm, isShellAvailable, pickSavePath, writeFileAtomic } from '../contract';
import {
  buildExportAsync,
  evaluateExportGate,
  type ExportArtifactReady,
  type ExportFormat,
} from './export-card';

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

export interface ExportDialogCallbacks {
  /** 取当前卡片与审计报告（导出前必须是最新状态） */
  getState: () => {
    card: UnifiedCard;
    report: AuditReport | null;
    preset: TxtPreset | null;
    /** 初始场景预设的分隔格式（v0.1.3 追加项一）；缺省 = 冻结默认 */
    greetingFormat?: GreetingFormatParams;
  };
  /** 重新审计（导出前强制刷新，避免用旧报告放行） */
  revalidate: () => AuditReport | null;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 导出成功后回调（T6.7 可据此同步上传） */
  onExported?: (artifact: ExportArtifactReady, receipt: { pathDisplay: string | null; bytesWritten: number; sha256: string; verified: boolean }) => void;
}

interface Receipt {
  pathDisplay: string | null;
  bytesWritten: number;
  sha256: string;
  verified: boolean;
}

export class ExportDialog {
  private readonly overlay: HTMLDivElement;
  private readonly gateBox: HTMLElement;
  private readonly receiptBox: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private pendingFormat: ExportFormat = 'json';
  private bypassGate = false;

  constructor(private readonly callbacks: ExportDialogCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');

    const panel = el('div', 'modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '导出');
    title.id = 'export-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // 格式选择
    const section = el('section', 'form-section');
    section.append(el('h3', 'form-title', '导出格式'));

    const formatRow = el('div', 'format-row');
    for (const [value, label, desc] of [
      ['json', 'SillyTavern JSON', '原生角色卡结构，可导入 ST / Chub 等平台；服务端存档用这个'],
      ['txt', 'TXT 文本', '按当前预设拼装标题与分隔符，便于人工核对与粘贴'],
    ] as Array<[ExportFormat, string, string]>) {
      const button = el('button', 'format-option');
      button.type = 'button';
      button.dataset['format'] = value;
      button.append(el('span', 'format-name', label), el('span', 'format-desc', desc));
      button.addEventListener('click', () => {
        this.pendingFormat = value;
        this.syncFormatSelection();
        this.renderGatePreview();
      });
      formatRow.append(button);
    }
    section.append(formatRow);

    // 闸门区（有 error 时出现在这里）
    this.gateBox = el('div', 'gate-box');
    this.gateBox.hidden = true;
    section.append(this.gateBox);

    // 回执区
    this.receiptBox = el('div', 'receipt-box');
    this.receiptBox.hidden = true;
    section.append(this.receiptBox);

    // 底部
    const foot = el('div', 'modal-foot');
    const note = el(
      'span',
      'foot-note',
      isShellAvailable() ? '' : '浏览器模式：无法保存到磁盘（请在桌面客户端内导出）',
    );
    this.cancelButton = el('button', 'btn', '取消');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.close());

    this.confirmButton = el('button', 'btn primary', '导出…');
    this.confirmButton.type = 'button';
    this.confirmButton.addEventListener('click', () => void this.run());

    foot.append(note, this.cancelButton, this.confirmButton);
    panel.append(head, section, foot);
    this.overlay.append(panel);

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  open(format: ExportFormat = 'json'): void {
    this.pendingFormat = format;
    this.bypassGate = false;
    this.receiptBox.hidden = true;
    this.receiptBox.replaceChildren();
    this.syncFormatSelection();
    this.renderGatePreview();
    this.overlay.hidden = false;
    // 焦点给「取消」：有错误时防止误按回车导出
    this.cancelButton.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private syncFormatSelection(): void {
    for (const button of this.overlay.querySelectorAll<HTMLButtonElement>('.format-option')) {
      button.classList.toggle('active', button.dataset['format'] === this.pendingFormat);
    }
    this.confirmButton.textContent =
      this.pendingFormat === 'json' ? '导出 JSON…' : '导出 TXT…';
  }

  /** 打开时先按最新报告算一遍闸门，让用户在点导出之前就知道会被拦 */
  private renderGatePreview(): void {
    // 强制重新审计：导出决策不能基于过期报告
    const report = this.callbacks.revalidate();
    const gate = evaluateExportGate(report);

    this.gateBox.replaceChildren();
    if (!gate.blocked) {
      this.gateBox.hidden = true;
      this.confirmButton.disabled = false;
      return;
    }

    this.gateBox.hidden = false;
    this.confirmButton.disabled = false; // 仍允许点，但会在弹窗里二次确认

    const head = el('div', 'gate-head');
    head.append(el('span', 'gate-icon', '⚠'), el('span', 'gate-title', '审计未通过'));
    this.gateBox.append(head, el('p', 'gate-message', gate.message));

    if (gate.errors.length > 0) {
      const list = el('ul', 'gate-errors');
      for (const issue of gate.errors.slice(0, 8)) {
        const item = el('li', 'gate-error-item');
        const where = issue.location.blockId
          ? `${blockLabel(issue.location.blockId)}${issue.location.line !== null ? ` 第 ${issue.location.line} 行` : ''}`
          : '全文';
        item.append(el('code', 'gate-where', where), el('span', 'gate-text', issue.message));
        list.append(item);
      }
      if (gate.errors.length > 8) {
        list.append(el('li', 'gate-more', `…另有 ${gate.errors.length - 8} 条`));
      }
      this.gateBox.append(list);
    }

    this.gateBox.append(
      el(
        'p',
        'gate-note',
        '你可以选择「仍要导出」，但产物可能在目标平台被拒或行为异常。建议先修正上述问题。',
      ),
    );
  }

  private async run(): Promise<void> {
    // 再算一次：renderGatePreview 之后用户可能改了内容（虽然弹窗挡着，但保险）
    const report = this.callbacks.revalidate();
    const gate = evaluateExportGate(report);

    if (gate.blocked && !this.bypassGate) {
      // 二次确认：默认「取消」。必须 await —— askConfirm 在壳里是异步的，
      // 直接 `if (!window.confirm(...))` 会拿 Promise 当真值，闸门等于没有。
      const proceed = await askConfirm(
        `${gate.message}\n\n仍要导出吗？（建议先修正；导出后可随时重新导出）`,
        '导出闸门',
      );
      if (!proceed) {
        this.callbacks.notify('已取消导出', 'info');
        return;
      }
      this.bypassGate = true;
    }

    const state = this.callbacks.getState();
    this.confirmButton.disabled = true;
    this.confirmButton.textContent = '导出中…';

    try {
      const artifact = await buildExportAsync(state.card, state.preset, this.pendingFormat, state.greetingFormat);

      if (!isShellAvailable()) {
        // 浏览器模式：给出可手动保存的提示（不假装成功）
        this.renderReceipt(null, artifact);
        this.callbacks.notify('浏览器模式无法写盘：产物已生成，请在桌面客户端导出', 'warn');
        return;
      }

      const target = await pickSavePath(artifact.fileName, this.pendingFormat);
      if (!target) {
        this.callbacks.notify('已取消保存', 'info');
        return;
      }

      // 把内存里的 sha256 传给壳：壳写后回读重算，不一致就报错（写后自证）
      const receipt = await writeFileAtomic(target, artifact.text, artifact.sha256);

      this.renderReceipt(receipt, artifact);
      this.callbacks.onExported?.(artifact, receipt);
      this.callbacks.notify(
        `已导出 ${artifact.fileName}：${receipt.bytesWritten} 字节，sha256 ${receipt.sha256.slice(0, 12)}…` +
          (receipt.verified ? '（回读一致）' : '（回读不一致！）'),
        receipt.verified ? 'ok' : 'bad',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.notify(`导出失败：${message}`, 'bad');
      this.receiptBox.hidden = false;
      this.receiptBox.replaceChildren(el('p', 'receipt-error', `导出失败：${message}`));
    } finally {
      this.confirmButton.disabled = false;
      this.syncFormatSelection();
    }
  }

  /** 回执摘要：路径 / 字节数 / sha256 / 回读校验结果 */
  private renderReceipt(receipt: Receipt | null, artifact: ExportArtifactReady): void {
    this.receiptBox.hidden = false;
    this.receiptBox.replaceChildren();

    const head = el('div', 'receipt-head');
    head.append(el('span', 'receipt-title', '导出回执'));
    head.append(
      el(
        'span',
        receipt ? (receipt.verified ? 'receipt-badge ok' : 'receipt-badge bad') : 'receipt-badge warn',
        receipt ? (receipt.verified ? '回读一致' : '回读不一致') : '未写盘',
      ),
    );
    this.receiptBox.append(head);

    const rows: Array<[string, string]> = [
      ['格式', artifact.format.toUpperCase()],
      ['文件名', artifact.fileName],
      ['路径', receipt?.pathDisplay ?? '（未保存，仅内存）'],
      ['字节数', String(receipt?.bytesWritten ?? artifact.bytes)],
      ['sha256', receipt?.sha256 ?? artifact.sha256],
    ];
    for (const [key, value] of rows) {
      const row = el('div', 'receipt-row');
      row.append(el('span', 'receipt-key', key), el('code', 'receipt-value', value));
      this.receiptBox.append(row);
    }

    if (artifact.notes.length > 0) {
      const notes = el('ul', 'receipt-notes');
      for (const note of artifact.notes) notes.append(el('li', '', note));
      this.receiptBox.append(notes);
    }
  }
}

const BLOCK_LABELS: Record<string, string> = {
  basic: '基本信息',
  personality: '性格',
  settings: '其他设定',
  special: '特殊设定',
  user: '用户相关设定',
  worldbook: '世界书',
};

function blockLabel(id: string): string {
  return BLOCK_LABELS[id] ?? id;
}
