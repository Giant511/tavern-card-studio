/**
 * 服务端同步面板（T6.7）：上传 / 版本历史 / 回滚。
 *
 * 约束：
 *   · 可用性**复用** T6.8 的 `isSyncReady`（不在这里另设判据）；
 *   · 未就绪时入口置灰（由 app.ts 控制，面板内再兜一层）；
 *   · 回滚前必须确认，并提示「当前编辑内容将被覆盖，建议先另存」；
 *   · 上传成功后刷新版本历史，并显示服务端返回的版本号。
 */

import { isSyncReady, type ProbeResult } from '../net/server-probe';
import {
  SyncError,
  fetchVersionText,
  listCards,
  listVersions,
  rollbackCard,
  uploadCard,
  type CardSummary,
  type SyncConfig,
  type UploadResult,
  type VersionSummary,
} from '../sync/server-sync';

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

export interface SyncDialogCallbacks {
  /** 当前连接状态（来自 probeServer） */
  getConnection: () => ProbeResult | null;
  /** 当前配置（serverUrl / token） */
  getConfig: () => SyncConfig | null;
  /** 当前待上传的 JSON 文本（与导出同一份，保证字节一致） */
  getPayload: () => Promise<string>;
  /** 当前是否已关联某张服务端卡 */
  getCurrentCardId: () => string | null;
  setCurrentCardId: (id: string | null) => void;
  /** 回滚时把版本内容应用回编辑器 */
  onRollbackApplied: (text: string, version: VersionSummary) => void;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
}

export class SyncDialog {
  private readonly overlay: HTMLDivElement;
  private readonly statusLine: HTMLElement;
  private readonly cardSelect: HTMLSelectElement;
  private readonly versionList: HTMLElement;
  private readonly uploadButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly busyBox: HTMLElement;
  private versions: VersionSummary[] = [];

  constructor(private readonly callbacks: SyncDialogCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');

    const panel = el('div', 'modal wide');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '服务端同步');
    title.id = 'sync-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // 状态
    this.statusLine = el('p', 'sync-status', '检查连接…');

    // 目标卡选择 + 上传
    const uploadSection = el('section', 'form-section');
    uploadSection.append(el('h3', 'form-title', '上传'));

    const cardRow = el('div', 'field-row');
    this.cardSelect = el('select', 'select') as HTMLSelectElement;
    this.cardSelect.dataset['role'] = 'sync-card';
    const newOption = el('option');
    newOption.value = '__new__';
    newOption.textContent = '＋ 作为新卡片上传';
    this.cardSelect.append(newOption);

    this.uploadButton = el('button', 'btn primary', '上传当前内容') as HTMLButtonElement;
    this.uploadButton.type = 'button';
    this.uploadButton.addEventListener('click', () => void this.upload());

    this.refreshButton = el('button', 'btn', '刷新') as HTMLButtonElement;
    this.refreshButton.type = 'button';
    this.refreshButton.addEventListener('click', () => void this.reload());

    cardRow.append(this.cardSelect, this.uploadButton, this.refreshButton);
    uploadSection.append(cardRow);
    uploadSection.append(
      el(
        'p',
        'field-hint',
        '上传内容与「导出 JSON」完全一致（同样 2 空格缩进 + 结尾换行），保证服务端字节与本地可复现。',
      ),
    );

    // 版本历史
    const historySection = el('section', 'form-section');
    historySection.append(el('h3', 'form-title', '版本历史'));
    this.versionList = el('div', 'version-list');
    historySection.append(this.versionList);

    // 忙碌提示
    this.busyBox = el('p', 'sync-busy');
    this.busyBox.hidden = true;

    const foot = el('div', 'modal-foot');
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(el('span', 'foot-note', ''), done);

    panel.append(head, this.statusLine, uploadSection, historySection, this.busyBox, foot);
    this.overlay.append(panel);

    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  open(): void {
    this.overlay.hidden = false;
    void this.reload();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /** 外部预选卡片并加载版本（截图/联调用） */
  selectCard(cardId: string): void {
    if (![...this.cardSelect.options].some((option) => option.value === cardId)) {
      const option = el('option');
      option.value = cardId;
      option.textContent = cardId;
      this.cardSelect.append(option);
    }
    this.cardSelect.value = cardId;
    this.callbacks.setCurrentCardId(cardId);
    void this.loadVersions(cardId);
  }

  private setBusy(text: string | null): void {
    this.busyBox.hidden = text === null;
    if (text !== null) this.busyBox.textContent = text;
    this.uploadButton.disabled = text !== null;
    this.refreshButton.disabled = text !== null;
  }

  /** 渲染连接状态；未就绪时禁用全部操作（不只靠入口置灰） */
  private renderStatus(): boolean {
    const connection = this.callbacks.getConnection();
    const ready = isSyncReady(connection);

    this.statusLine.replaceChildren();
    this.statusLine.className = `sync-status ${ready ? 'ok' : 'bad'}`;
    if (ready) {
      this.statusLine.textContent = connection?.message ?? '已连接';
    } else {
      this.statusLine.textContent = connection
        ? `同步未就绪：${connection.message}（请到「设置」检查地址与令牌）`
        : '同步未就绪：尚未配置服务端（请到「设置」填写地址与令牌）';
    }

    this.uploadButton.disabled = !ready;
    this.refreshButton.disabled = !ready;
    this.cardSelect.disabled = !ready;
    return ready;
  }

  private async reload(): Promise<void> {
    const ready = this.renderStatus();
    if (!ready) {
      this.versionList.replaceChildren(el('p', 'issue-empty', '连接就绪后才能查看版本历史'));
      return;
    }

    const config = this.callbacks.getConfig();
    if (!config) return;

    this.setBusy('加载卡片列表…');
    try {
      const cards = await listCards(config, { limit: 50 });
      this.renderCards(cards);

      const currentId = this.callbacks.getCurrentCardId();
      if (currentId) await this.loadVersions(currentId);
      else this.versionList.replaceChildren(el('p', 'issue-empty', '选择一张卡片后显示版本历史'));
    } catch (error) {
      this.reportError('加载失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private renderCards(cards: CardSummary[]): void {
    const keep = this.cardSelect.value;
    this.cardSelect.replaceChildren();

    const newOption = el('option');
    newOption.value = '__new__';
    newOption.textContent = '＋ 作为新卡片上传';
    this.cardSelect.append(newOption);

    for (const card of cards) {
      const option = el('option');
      option.value = card.id;
      option.textContent = `${card.name || '(未命名)'} · ${card.id.slice(0, 8)} · 最新 v${card.latestSeq}`;
      this.cardSelect.append(option);
    }

    const currentId = this.callbacks.getCurrentCardId();
    this.cardSelect.value = currentId && cards.some((c) => c.id === currentId) ? currentId : keep === '__new__' || keep === '' ? '__new__' : keep;
    if (![...this.cardSelect.options].some((o) => o.value === this.cardSelect.value)) {
      this.cardSelect.value = '__new__';
    }

    this.cardSelect.onchange = () => {
      const value = this.cardSelect.value;
      this.callbacks.setCurrentCardId(value === '__new__' ? null : value);
      if (value !== '__new__') void this.loadVersions(value);
      else this.versionList.replaceChildren(el('p', 'issue-empty', '作为新卡片上传后会生成 v1'));
    };
  }

  private async loadVersions(cardId: string): Promise<void> {
    const config = this.callbacks.getConfig();
    if (!config) return;

    this.setBusy('加载版本历史…');
    try {
      this.versions = await listVersions(config, cardId, { limit: 50 });
      this.renderVersions();
    } catch (error) {
      this.reportError('版本历史加载失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private renderVersions(): void {
    this.versionList.replaceChildren();

    if (this.versions.length === 0) {
      this.versionList.append(el('p', 'issue-empty', '还没有版本'));
      return;
    }

    for (const version of this.versions) {
      const row = el('div', 'version-row');

      const main = el('div', 'version-main');
      const titleLine = el('div', 'version-title');
      titleLine.append(el('span', 'version-seq', `v${version.seq}`));
      titleLine.append(el('span', 'version-kind', version.kind));
      if (version.audit) {
        const badge = el(
          'span',
          `version-audit ${version.audit.exportable ? 'ok' : 'bad'}`,
          version.audit.exportable
            ? `可导出 · 错${version.audit.error} 警${version.audit.warning}`
            : `不可导出 · 错${version.audit.error}`,
        );
        titleLine.append(badge);
      }
      main.append(titleLine);

      const meta = el('div', 'version-meta');
      meta.append(
        el('code', 'version-sha', version.sha256.slice(0, 12)),
        el('span', '', `${version.size} 字节`),
        el('span', '', version.createdAt.replace('T', ' ').slice(0, 19)),
      );
      if (version.message) meta.append(el('span', 'version-msg', version.message));
      main.append(meta);

      const actions = el('div', 'version-actions');

      const loadButton = el('button', 'btn small', '取回');
      loadButton.type = 'button';
      loadButton.title = '把该版本内容载入编辑器（不改变服务端）';
      loadButton.addEventListener('click', () => void this.loadVersionIntoEditor(version));
      actions.append(loadButton);

      // 最新版本没有"回滚到它自己"的意义
      const isLatest = version.seq === this.versions[0]?.seq;
      const rollbackButton = el('button', 'btn small', '回滚到此版本');
      rollbackButton.type = 'button';
      rollbackButton.disabled = isLatest;
      if (isLatest) rollbackButton.title = '这已是最新版本';
      rollbackButton.addEventListener('click', () => void this.rollback(version));
      actions.append(rollbackButton);

      row.append(main, actions);
      this.versionList.append(row);
    }
  }

  private async upload(): Promise<void> {
    const config = this.callbacks.getConfig();
    if (!config || !isSyncReady(this.callbacks.getConnection())) {
      this.callbacks.notify('同步未就绪，无法上传', 'warn');
      return;
    }

    this.setBusy('生成内容并上传…');
    try {
      const text = await this.callbacks.getPayload();
      const targetCardId = this.cardSelect.value === '__new__' ? null : this.cardSelect.value;

      const result: UploadResult = await uploadCard(config, {
        text,
        cardId: targetCardId,
        message: `客户端上传 ${new Date().toISOString()}`,
        author: 'tavern-card-studio',
      });

      this.callbacks.setCurrentCardId(result.cardId);

      // 上传成功后刷新版本历史，并把新版本号反馈给用户
      await this.refreshCardOptionsAndVersions(result.cardId);

      this.callbacks.notify(
        result.created
          ? `已作为新卡片上传：${result.cardId.slice(0, 8)} · 版本 v${result.seq}`
          : `已上传新版本：v${result.seq}（sha256 ${result.sha256.slice(0, 12)}…）`,
        'ok',
      );
    } catch (error) {
      this.reportError('上传失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private async refreshCardOptionsAndVersions(cardId: string): Promise<void> {
    const config = this.callbacks.getConfig();
    if (!config) return;
    const cards = await listCards(config, { limit: 50 });
    this.renderCards(cards);
    this.cardSelect.value = cardId;
    await this.loadVersions(cardId);
  }

  /** 回滚：必须确认，且明确告知会覆盖当前编辑内容 */
  private async rollback(version: VersionSummary): Promise<void> {
    const config = this.callbacks.getConfig();
    const cardId = this.callbacks.getCurrentCardId();
    if (!config || !cardId) {
      this.callbacks.notify('请先选择目标卡片', 'warn');
      return;
    }

    const confirmed = window.confirm(
      `回滚到 v${version.seq}？\n\n` +
        `· 服务端会新建一个提交（历史只增不改，可再回滚回去）\n` +
        `· 当前编辑内容将被覆盖，建议先另存\n\n` +
        `要同时把 v${version.seq} 的内容载入编辑器吗？点「确定」将载入。`,
    );
    if (!confirmed) {
      this.callbacks.notify('已取消回滚', 'info');
      return;
    }

    this.setBusy(`回滚到 v${version.seq}…`);
    try {
      const result = await rollbackCard(config, cardId, version.seq, {
        message: `回滚到 v${version.seq}`,
        author: 'tavern-card-studio',
      });

      // 取回回滚后的内容并载入编辑器（用户已在上一步确认）
      const text = await fetchVersionText(config, cardId, version.seq);
      this.callbacks.onRollbackApplied(text, version);

      await this.loadVersions(cardId);
      this.callbacks.notify(
        `已回滚并新建版本 v${result.seq}（目标 v${version.seq}）；编辑器已载入该版本内容`,
        'ok',
      );
    } catch (error) {
      this.reportError('回滚失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  /** 只取回、不改服务端 */
  private async loadVersionIntoEditor(version: VersionSummary): Promise<void> {
    const config = this.callbacks.getConfig();
    const cardId = this.callbacks.getCurrentCardId();
    if (!config || !cardId) return;

    this.setBusy(`取回 v${version.seq}…`);
    try {
      const text = await fetchVersionText(config, cardId, version.seq);
      this.callbacks.onRollbackApplied(text, version);
      this.callbacks.notify(`已载入 v${version.seq} 的内容（未改动服务端）`, 'ok');
    } catch (error) {
      this.reportError('取回失败', error);
    } finally {
      this.setBusy(null);
    }
  }

  private reportError(prefix: string, error: unknown): void {
    if (error instanceof SyncError) {
      const suffix =
        error.code === 'UNAUTHORIZED'
          ? '（令牌无效，请到「设置」更新）'
          : error.code === 'NETWORK' || error.code === 'TIMEOUT'
            ? '（服务端不可达）'
            : '';
      this.callbacks.notify(`${prefix}：${error.message}${suffix}`, 'bad');
      return;
    }
    this.callbacks.notify(`${prefix}：${error instanceof Error ? error.message : String(error)}`, 'bad');
  }
}
