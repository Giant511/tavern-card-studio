/**
 * 仓库与仓库令牌面板（T10.8）。
 *
 * 三件事：**仓库列表** / **仓库令牌列表** / **申请令牌**。
 *
 * 申请令牌这一段有一条不可妥协的交互：签发响应里的原文是**唯一一次**
 * 能看到它的机会（服务端只存 sha256）。所以：
 *   · 原文直接显示在一个只读文本框里，不是"点一下才展开"；
 *   · 旁边就是「复制」按钮，且复制失败要说清楚怎么手动复制；
 *   · 用醒目样式写明"只显示这一次"，并**不提供**"以后再看"的入口 ——
 *     那会让人以为能回来看，从而不去保存。
 * 这三条与服务端响应里的 `note` 是同一句话的两种呈现。
 */

import {
  RepoClientError,
  createRepo,
  issueRepoToken,
  listRepos,
  listRepoTokens,
  revokeRepoToken,
  type IssuedRepoToken,
  type RepoClientConfig,
  type RepoSummary,
  type RepoTokenSummary,
} from './repo-client.ts';
import { describeExpiry, describeScopes, tokenState } from './repo-select.ts';

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

export interface RepoDialogDeps {
  /** 账户身份（仓库管理只认它）；未登录时返回 null，面板显示"需要登录" */
  getConfig: () => RepoClientConfig | null;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 401 时先试续期，返回 false 表示要回登录界面 */
  onUnauthorized?: () => Promise<boolean>;
}

const SCOPE_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'read', label: '读', hint: '列卡片 / 读版本 / 下载原文' },
  { value: 'write', label: '写（含删除）', hint: '上传新版本、删除卡片' },
  { value: 'rollback', label: '回滚', hint: '把某张卡回滚到旧版本' },
];

export class RepoDialog {
  private readonly overlay: HTMLDivElement;
  private readonly bodyEl: HTMLElement;
  private readonly repoListEl: HTMLElement;
  private readonly tokenListEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  private readonly newRepoInput: HTMLInputElement;
  private readonly scopeInputs: HTMLInputElement[] = [];
  private readonly tokenNameInput: HTMLInputElement;
  private readonly issuedBox: HTMLElement;
  private readonly issuedValue: HTMLInputElement;
  private readonly issueButton: HTMLButtonElement;
  private repos: RepoSummary[] = [];
  private selectedRepoId: string | null = null;
  private busy = false;

  constructor(private readonly deps: RepoDialogDeps) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'repo-dialog';

    const panel = el('div', 'modal wide repo-modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '仓库与令牌');
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    this.bodyEl = el('div', 'modal-body');

    this.noteEl = el('p', 'field-hint repo-note');
    this.noteEl.dataset['role'] = 'repo-note';

    // ── 仓库列表 ────────────────────────────────────────────
    const repoSection = el('section', 'form-section');
    repoSection.append(el('h3', 'form-title', '我的仓库'));
    this.repoListEl = el('div', 'repo-list');
    this.repoListEl.dataset['role'] = 'repo-list';

    const newRepoRow = el('div', 'field-row');
    this.newRepoInput = el('input', 'input') as HTMLInputElement;
    this.newRepoInput.type = 'text';
    this.newRepoInput.placeholder = '新仓库名（账户内唯一）';
    this.newRepoInput.dataset['role'] = 'repo-new-name';
    const createButton = el('button', 'btn small', '新建仓库') as HTMLButtonElement;
    createButton.type = 'button';
    createButton.dataset['role'] = 'repo-create';
    createButton.addEventListener('click', () => void this.createNewRepo());
    newRepoRow.append(this.newRepoInput, createButton);

    repoSection.append(this.repoListEl, newRepoRow);

    // ── 令牌申请 ────────────────────────────────────────────
    const tokenSection = el('section', 'form-section');
    tokenSection.append(el('h3', 'form-title', '申请仓库令牌'));

    const tokenNameRow = el('div', 'field-row');
    this.tokenNameInput = el('input', 'input') as HTMLInputElement;
    this.tokenNameInput.type = 'text';
    this.tokenNameInput.placeholder = '令牌用途（例如「CI 上传」）';
    this.tokenNameInput.dataset['role'] = 'token-name';
    tokenNameRow.append(this.tokenNameInput);

    const scopeRow = el('div', 'field-row token-scopes');
    for (const option of SCOPE_OPTIONS) {
      const label = el('label', 'check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = option.value;
      input.dataset['role'] = `token-scope-${option.value}`;
      // 默认只勾"读"：最小权限起步，用户需要写的时候自己勾
      input.checked = option.value === 'read';
      this.scopeInputs.push(input);
      const text = el('span', 'check-label', option.label);
      text.title = option.hint;
      label.append(input, text);
      scopeRow.append(label);
    }

    this.issueButton = el('button', 'btn primary', '签发令牌') as HTMLButtonElement;
    this.issueButton.type = 'button';
    this.issueButton.dataset['role'] = 'token-issue';
    this.issueButton.addEventListener('click', () => void this.issue());

    /*
     * 原文展示区。
     *
     * 用 `input readonly` 而不是 `<pre>`：只读输入框能被鼠标全选、能被
     * `select()`（复制失败时的兜底），而且长串不会撑破面板。
     */
    this.issuedBox = el('div', 'token-issued');
    this.issuedBox.hidden = true;
    this.issuedBox.dataset['role'] = 'token-issued';
    const issuedTitle = el('p', 'token-issued-title', '令牌已签发 —— 请立刻复制保存');
    const issuedWarn = el(
      'p',
      'token-issued-warn',
      '这段内容只显示这一次：服务端只保存哈希，关闭本面板后无法再查看。若丢失，只能吊销后重新签发。',
    );
    const issuedRow = el('div', 'field-row');
    this.issuedValue = el('input', 'input token-value') as HTMLInputElement;
    this.issuedValue.type = 'text';
    this.issuedValue.readOnly = true;
    this.issuedValue.spellcheck = false;
    this.issuedValue.dataset['role'] = 'token-value';
    const copyButton = el('button', 'btn small', '复制') as HTMLButtonElement;
    copyButton.type = 'button';
    copyButton.dataset['role'] = 'token-copy';
    copyButton.addEventListener('click', () => void this.copyIssued());
    issuedRow.append(this.issuedValue, copyButton);
    const issuedNote = el('p', 'field-hint token-issued-note');
    issuedNote.dataset['role'] = 'token-issued-note';
    this.issuedBox.append(issuedTitle, issuedWarn, issuedRow, issuedNote);

    const tokenListHead = el('div', 'form-title-row');
    tokenListHead.append(el('h3', 'form-title', '已签发的令牌'));
    this.tokenListEl = el('div', 'token-list');
    this.tokenListEl.dataset['role'] = 'token-list';

    tokenSection.append(tokenNameRow, scopeRow, this.issueButton, this.issuedBox, tokenListHead, this.tokenListEl);

    this.bodyEl.append(this.noteEl, repoSection, tokenSection);

    const foot = el('div', 'modal-foot');
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(el('span', 'foot-note', '令牌原文只显示一次；仓库令牌不能管理仓库或令牌本身'), done);

    panel.append(head, this.bodyEl, foot);
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
    this.issuedBox.hidden = true;
    this.issuedValue.value = '';
    await this.reload();
  }

  close(): void {
    this.overlay.hidden = true;
    // 关闭时清空原文：留在 DOM 里，截屏/远程协助时会被看见
    this.issuedValue.value = '';
    this.issuedBox.hidden = true;
  }

  private async reload(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.noteEl.textContent = '需要先登录账户：仓库属于账户，全局令牌与仓库令牌都不能管理仓库。';
      this.noteEl.dataset['role'] = 'repo-note';
      this.repoListEl.replaceChildren();
      this.tokenListEl.replaceChildren();
      this.issueButton.disabled = true;
      return;
    }

    this.noteEl.textContent = '仓库名在账户内唯一；上传时可以选择目标仓库，默认仓库已预选。';
    try {
      this.repos = await listRepos(config);
    } catch (error) {
      await this.handleError('加载仓库列表失败', error);
      return;
    }

    this.renderRepos();
    // 默认选中第一个（服务端把默认仓库排在前面），令牌区据此列出该仓库的令牌
    if (this.selectedRepoId === null || !this.repos.some((repo) => repo.id === this.selectedRepoId)) {
      this.selectedRepoId = this.repos[0]?.id ?? null;
    }
    this.issueButton.disabled = this.selectedRepoId === null;
    await this.reloadTokens();
  }

  private renderRepos(): void {
    this.repoListEl.replaceChildren();
    if (this.repos.length === 0) {
      this.repoListEl.append(el('p', 'issue-empty', '还没有仓库。新建一个再上传。'));
      return;
    }

    for (const repo of this.repos) {
      const row = el('button', 'repo-row');
      row.type = 'button';
      row.dataset['repoId'] = repo.id;
      if (repo.id === this.selectedRepoId) row.classList.add('is-active');
      row.append(
        el('span', 'repo-row-name', repo.name),
        el('span', 'repo-row-count', `${String(repo.cardCount)} 张`),
      );
      if (repo.isDefault) row.append(el('span', 'repo-row-badge', '默认'));
      row.addEventListener('click', () => {
        this.selectedRepoId = repo.id;
        this.renderRepos();
        void this.reloadTokens();
      });
      this.repoListEl.append(row);
    }
  }

  private async reloadTokens(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config || this.selectedRepoId === null) {
      this.tokenListEl.replaceChildren(el('p', 'issue-empty', '选择一个仓库后显示它的令牌'));
      return;
    }
    try {
      const { items, note } = await listRepoTokens(config, this.selectedRepoId);
      this.renderTokens(items);
      if (note !== '') {
        // 服务端的 note 优先显示：它是唯一权威的说明来源
        this.noteEl.textContent = note;
      }
    } catch (error) {
      await this.handleError('加载令牌列表失败', error);
    }
  }

  private renderTokens(items: RepoTokenSummary[]): void {
    this.tokenListEl.replaceChildren();
    if (items.length === 0) {
      this.tokenListEl.append(el('p', 'issue-empty', '这个仓库还没有令牌。'));
      return;
    }
    for (const token of items) {
      const row = el('div', 'token-row');
      row.dataset['tokenId'] = token.id;
      row.dataset['state'] = tokenState(token);

      const head = el('div', 'token-row-head');
      head.append(
        el('span', 'token-row-name', token.name || '(未命名)'),
        el('code', 'token-row-prefix', `${token.tokenPrefix}…`),
        el('span', 'token-row-scopes', describeScopes(token.scopes)),
        el('span', 'token-row-expiry', describeExpiry(token.expiresAt)),
      );

      const state = tokenState(token);
      if (state !== 'active') {
        head.append(el('span', 'token-row-badge', state === 'revoked' ? '已吊销' : '已过期'));
      } else {
        const revoke = el('button', 'btn small ghost', '吊销') as HTMLButtonElement;
        revoke.type = 'button';
        revoke.dataset['role'] = 'token-revoke';
        revoke.addEventListener('click', () => void this.revoke(token.id, token.name));
        head.append(revoke);
      }
      row.append(head);
      this.tokenListEl.append(row);
    }
  }

  private async createNewRepo(): Promise<void> {
    const config = this.deps.getConfig();
    const name = this.newRepoInput.value.trim();
    if (!config || name === '') {
      this.deps.notify('仓库名不能为空', 'warn');
      return;
    }
    this.setBusy(true, '新建仓库…');
    try {
      await createRepo(config, { name });
      this.newRepoInput.value = '';
      this.deps.notify(`已创建仓库「${name}」`, 'ok');
      await this.reload();
    } catch (error) {
      await this.handleError('新建仓库失败', error);
    } finally {
      this.setBusy(false);
    }
  }

  private async issue(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config || this.selectedRepoId === null) {
      this.deps.notify('先选择一个仓库', 'warn');
      return;
    }
    const scopes = this.scopeInputs.filter((input) => input.checked).map((input) => input.value);
    if (scopes.length === 0) {
      this.deps.notify('至少要勾选一个权限范围', 'warn');
      return;
    }

    this.setBusy(true, '签发令牌…');
    try {
      const issued = await issueRepoToken(config, this.selectedRepoId, {
        name: this.tokenNameInput.value.trim() || '未命名令牌',
        scopes,
      });
      this.showIssued(issued);
      this.tokenNameInput.value = '';
      await this.reloadTokens();
      this.deps.notify('令牌已签发：原文只显示这一次，请立刻复制', 'warn');
    } catch (error) {
      await this.handleError('签发令牌失败', error);
    } finally {
      this.setBusy(false);
    }
  }

  private showIssued(issued: IssuedRepoToken): void {
    this.issuedValue.value = issued.token;
    this.issuedBox.hidden = false;
    const noteEl = this.issuedBox.querySelector<HTMLElement>('[data-role="token-issued-note"]');
    if (noteEl) {
      const parts = [`仓库：${issued.repoName}`, `范围：${describeScopes(issued.scopes)}`, `有效期：${describeExpiry(issued.expiresAt)}`];
      if (issued.note !== '') parts.push(issued.note);
      noteEl.textContent = parts.join(' · ');
    }
    // 自动全选：用户下一步几乎一定是复制，选中省一次点击
    this.issuedValue.focus();
    this.issuedValue.select();
  }

  private async copyIssued(): Promise<void> {
    const value = this.issuedValue.value;
    if (value === '') return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        throw new Error('剪贴板不可用');
      }
      this.deps.notify('已复制到剪贴板', 'ok');
    } catch {
      // 复制失败不能说"已复制"：静默失败会让用户关掉面板后才发现没保存
      this.issuedValue.focus();
      this.issuedValue.select();
      this.deps.notify('无法自动复制：内容已全选，请按 Ctrl+C 手动复制', 'warn');
    }
  }

  private async revoke(tokenId: string, name: string): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    this.setBusy(true, '吊销中…');
    try {
      await revokeRepoToken(config, tokenId);
      this.deps.notify(`已吊销令牌「${name || tokenId}」`, 'ok');
      await this.reloadTokens();
    } catch (error) {
      await this.handleError('吊销失败', error);
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    this.issueButton.disabled = busy || this.selectedRepoId === null;
    if (label !== undefined) this.noteEl.textContent = label;
  }

  private async handleError(prefix: string, error: unknown): Promise<void> {
    if (error instanceof RepoClientError && error.code === 'UNAUTHORIZED' && this.deps.onUnauthorized) {
      const recovered = await this.deps.onUnauthorized();
      if (recovered) {
        await this.reload();
        return;
      }
    }
    const message = error instanceof RepoClientError ? error.displayMessage : String(error);
    this.noteEl.textContent = `${prefix}：${message}`;
    this.deps.notify(`${prefix}：${message}`, 'bad');
  }

  /** 供端到端断言：当前签发区里的原文（不应在关闭后还能读到） */
  get issuedToken(): string {
    return this.issuedBox.hidden ? '' : this.issuedValue.value;
  }

  get busyNow(): boolean {
    return this.busy;
  }
}
