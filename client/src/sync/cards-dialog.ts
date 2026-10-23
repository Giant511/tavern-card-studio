/**
 * 「我的卡片」列表（T10.7）。
 *
 * 只做一件事：把服务端 `GET /api/cards` 的结果按
 * `角色名 · cardId · 仓库 · vN` 展示出来，点一行就去看它的历史。
 *
 * **客户端不做任何过滤**。需求明确要求"数据隔离前端不假设"：
 * 前端再加一层按 owner 的过滤，看起来更安全，实际只是把"服务端漏过滤"这件事
 * 藏起来 —— 列表看起来干净了，直连 API 仍然能拿到全部，反而更难发现。
 * 所以这里显示的永远是服务端原样返回的条数。
 *
 * 同理，界面**不声称**"这是你账户的卡"：T10.10 之前服务端还没按账户过滤，
 * 声称了就是假话。真实提示见 `isolationNote()`。
 */

import { listCards, SyncError, type CardSummary, type SyncConfig } from './server-sync.ts';
import { emptyCardsText, isolationNote, toCardRow, type CardRowView } from './card-row.ts';

export { isolationNote };

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

export interface CardsDialogDeps {
  /** 当前同步配置（含 access 或 legacy 令牌）；未就绪时返回 null */
  getConfig: () => SyncConfig | null;
  /** 是否已用账户登录（决定要不要显示"尚未按账户过滤"的诚实提示） */
  isAccountLogin: () => boolean;
  onPick?: (cardId: string) => void;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 401 后尝试恢复（续期）；返回 false 表示要回登录界面 */
  onUnauthorized?: () => Promise<boolean>;
  /** 登出（仅账户登录时显示按钮）。登出后本地编辑不受影响 */
  onLogout?: () => Promise<void>;
}

/**
 * 隔离提示（实现见 `card-row.ts`，那里是纯函数、可单测）。
 *
 * 只有"账户登录"时才提：legacy 全局令牌本来就该看到全部卡片，
 * 对它说"还没隔离"是废话。而账户登录下不提，用户会误以为列表已经按账户过滤。
 */

export class CardsDialog {
  private readonly overlay: HTMLDivElement;
  private readonly listEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly logoutButton: HTMLButtonElement;
  /** 显式字段（不用构造函数参数属性）：Node 的类型剥离不支持，测试要导入本文件的纯函数 */
  private readonly deps: CardsDialogDeps;
  private rows: CardSummary[] = [];
  private busy = false;

  constructor(deps: CardsDialogDeps) {
    this.deps = deps;
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'cards-dialog';

    const panel = el('div', 'modal wide cards-modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '我的卡片');
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    const body = el('div', 'modal-body');

    const tools = el('div', 'cards-toolbar');
    this.searchInput = el('input', 'input') as HTMLInputElement;
    this.searchInput.type = 'search';
    this.searchInput.placeholder = '按角色名或 cardId 搜索';
    this.searchInput.dataset['role'] = 'cards-search';
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.reload();
    });
    this.refreshButton = el('button', 'btn small', '刷新') as HTMLButtonElement;
    this.refreshButton.type = 'button';
    this.refreshButton.dataset['role'] = 'cards-refresh';
    this.refreshButton.addEventListener('click', () => void this.reload());
    tools.append(this.searchInput, this.refreshButton);

    this.noteEl = el('p', 'field-hint cards-note');
    this.noteEl.dataset['role'] = 'cards-note';
    this.noteEl.hidden = true;

    this.countEl = el('p', 'field-hint cards-count');
    this.countEl.dataset['role'] = 'cards-count';
    this.countEl.textContent = '尚未加载';

    this.listEl = el('div', 'cards-list');
    this.listEl.dataset['role'] = 'cards-list';

    body.append(tools, this.noteEl, this.countEl, this.listEl);

    const foot = el('div', 'modal-foot');
    // 登出放在这个面板：它是"账户"这一面唯一常驻的地方，
    // 再单独做一个账户管理页，会出现两处都能登出、状态各刷一半的问题。
    this.logoutButton = el('button', 'btn ghost', '登出') as HTMLButtonElement;
    this.logoutButton.type = 'button';
    this.logoutButton.dataset['role'] = 'account-logout';
    this.logoutButton.hidden = true;
    this.logoutButton.addEventListener('click', () => void this.logout());
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(this.logoutButton, el('span', 'foot-note', '列表内容由服务端返回，客户端不做二次过滤'), done);

    panel.append(head, body, foot);
    this.overlay.append(panel);
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    const note = isolationNote(this.deps.isAccountLogin());
    this.noteEl.hidden = note === null;
    if (note !== null) this.noteEl.textContent = note;
    this.logoutButton.hidden = this.deps.onLogout === undefined || !this.deps.isAccountLogin();
    this.searchInput.value = '';
    await this.reload();
    this.searchInput.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  private async logout(): Promise<void> {
    if (!this.deps.onLogout) return;
    this.logoutButton.disabled = true;
    try {
      await this.deps.onLogout();
    } finally {
      this.logoutButton.disabled = false;
      this.close();
    }
  }

  /** 当前渲染的行（截图与端到端断言用，省得去解析文本） */
  get rendered(): CardRowView[] {
    return this.rows.map(toCardRow);
  }

  private async reload(): Promise<void> {
    if (this.busy) return;
    const config = this.deps.getConfig();
    if (!config) {
      // 注意：这里**不能**先写 countEl 再调 renderRows([]) ——
      // 后者会把计数覆盖成「共 0 张」，于是"未连接"看起来像"这个账户没有卡"。
      // 曾据此误判过（截图里只剩一句"共 0 张"）。空态与失败态要分开渲染。
      this.renderNotice('未连接服务端：请先在「设置」里填写地址与令牌，或点「登录」。');
      return;
    }

    this.busy = true;
    this.refreshButton.disabled = true;
    this.countEl.textContent = '正在加载…';
    try {
      const items = await listCards(config, { limit: 100, query: this.searchInput.value.trim() });
      this.renderRows(items);
    } catch (error) {
      if (error instanceof SyncError && error.code === 'UNAUTHORIZED' && this.deps.onUnauthorized) {
        const recovered = await this.deps.onUnauthorized();
        if (recovered) {
          // 续期成功后重试一次；再失败就如实报错，不无限重试
          this.busy = false;
          this.refreshButton.disabled = false;
          await this.reload();
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.renderNotice(`加载失败：${message}`);
      this.deps.notify(`加载卡片列表失败：${message}`, 'bad');
    } finally {
      this.busy = false;
      this.refreshButton.disabled = false;
    }
  }

  /**
   * 失败/未连接态：列表区显示原因，计数区显示「—」。
   *
   * 与空态（`共 0 张` + 引导文案）严格区分：把"取不到"画成"没有"，
   * 用户会去建卡/重传，而真正的问题在网络或登录态。
   */
  private renderNotice(text: string): void {
    this.rows = [];
    this.listEl.replaceChildren();
    const note = el('p', 'cards-empty', text);
    note.dataset['role'] = 'cards-empty';
    this.listEl.append(note);
    this.countEl.textContent = '—';
  }

  private renderRows(items: CardSummary[]): void {
    this.rows = items;
    this.listEl.replaceChildren();

    if (items.length === 0) {
      const empty = el('p', 'cards-empty', emptyCardsText(this.searchInput.value));
      empty.dataset['role'] = 'cards-empty';
      this.listEl.append(empty);
      this.countEl.textContent = '共 0 张';
      return;
    }

    for (const item of items) {
      const view = toCardRow(item);
      const row = el('button', 'cards-row');
      row.type = 'button';
      row.dataset['cardId'] = view.cardId;
      row.title = `查看「${view.name}」的版本历史`;
      if (view.deleted) row.classList.add('deleted');

      const nameEl = el('span', 'cards-row-name', view.name);
      const idEl = el('span', 'cards-row-id', view.cardId);
      const repoEl = el('span', 'cards-row-repo', view.repo);
      const verEl = el('span', 'cards-row-version', view.version);

      row.append(nameEl, idEl, repoEl, verEl);
      row.addEventListener('click', () => {
        this.deps.onPick?.(view.cardId);
        this.close();
      });
      this.listEl.append(row);
    }

    this.countEl.textContent = `共 ${items.length} 张`;
  }
}
