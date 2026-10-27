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

import { validateRepoName } from '@tcs/shared';

import { askConfirm } from '../contract';
import {
  RepoClientError,
  createRepo,
  deleteRepo,
  renameRepo,
  setDefaultRepo,
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
  /**
   * 本次打开面板期间签发过的令牌原文（按展示前缀索引）。
   *
   * 服务端只存 sha256，原文只在签发响应里出现一次；这个 Map 让"刚签发的那一把"
   * 在列表里也能复制全文。close() 时清空 —— 一次性凭证不该长期驻留内存。
   */
  private readonly liveRawByPrefix = new Map<string, string>();
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

    /*
     * 签发成功时的使用指引（v0.1.3 / F5 后半）。
     *
     * 这是本次反馈的直接来源：令牌签出来了，但客户端的任何地方都不能粘它 ——
     * 用户拿着字符串不知道往哪儿放。所以在**唯一能看到原文的那一刻**
     * 就把下一步写成可照抄的一句话，而不是让人去翻文档。
     *
     * 文案里的路径要与真实界面逐字一致（登录 → 使用仓库令牌连接），
     * 否则用户按字面找不到（这类"文档指向不存在的入口"是本仓库踩过的坑）。
     */
    const issuedGuide = el(
      'p',
      'field-hint token-guide',
      '在另一台设备的客户端：打开「登录」→ 点「使用仓库令牌连接」→ 粘贴此令牌 → 连接。' +
        '之后那台设备只能访问本仓库，不能管理仓库与令牌。',
    );
    issuedGuide.dataset['role'] = 'token-issued-guide';
    this.issuedBox.append(issuedGuide);

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
    // 内存里的原文也一起清 —— 一次性凭证不该长期驻留
    this.liveRawByPrefix.clear();
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
      /*
       * 行从 `<button>` 改成 `<div>` + 主按钮（F13.5 仓库管理）。
       * 理由同「我的卡片」：HTML 不允许按钮嵌套按钮，而这一行既要"点选看令牌"，
       * 又要放「改名 / 设默认 / 删除」三个按钮。
       */
      const row = el('div', 'repo-row');
      row.dataset['repoId'] = repo.id;
      if (repo.id === this.selectedRepoId) row.classList.add('is-active');

      const main = el('button', 'repo-row-main');
      main.type = 'button';
      main.append(
        el('span', 'repo-row-name', repo.name),
        el('span', 'repo-row-count', `${String(repo.cardCount)} 张`),
      );
      if (repo.isDefault) main.append(el('span', 'repo-row-badge', '默认'));
      main.addEventListener('click', () => {
        this.selectedRepoId = repo.id;
        this.renderRepos();
        void this.reloadTokens();
      });

      const actions = el('div', 'repo-row-actions');
      const renameButton = el('button', 'btn small', '改名');
      renameButton.type = 'button';
      renameButton.dataset['role'] = 'repo-rename';
      renameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.rename(repo);
      });
      actions.append(renameButton);

      if (!repo.isDefault) {
        // 默认仓库不能删 —— 只能把别的设为默认（即「转移默认」）
        const defaultButton = el('button', 'btn small', '设为默认');
        defaultButton.type = 'button';
        defaultButton.dataset['role'] = 'repo-set-default';
        defaultButton.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.setDefault(repo);
        });
        actions.append(defaultButton);

        const deleteButton = el('button', 'btn small danger', '删除…');
        deleteButton.type = 'button';
        deleteButton.dataset['role'] = 'repo-delete';
        deleteButton.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.remove(repo);
        });
        actions.append(deleteButton);
      } else {
        const hint = el('span', 'repo-row-hint', '默认仓库不可删（先设别的为默认）');
        hint.dataset['role'] = 'repo-default-hint';
        actions.append(hint);
      }

      row.append(main, actions);
      this.repoListEl.append(row);
    }
  }

  private async rename(repo: RepoSummary): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    const input = window.prompt(`「${repo.name}」的新名字：`, repo.name);
    if (input === null) return;

    // 与新建同一套校验（`@tcs/shared` 的 validateRepoName）：先本地判，别等往返一次才知道不合法。
    // 注意传**原始输入**而不是 trim 后的：首尾空白是明确拒绝项，静默 trim 会让
    // "存进去的名字"和"用户以为的名字"不一致。
    const check = validateRepoName(input);
    if (!check.ok) {
      this.deps.notify(check.message ?? '仓库名不合法', 'warn');
      return;
    }
    if (check.name === repo.name) return;
    const name = check.name;
    try {
      await renameRepo(config, repo.id, { name });
      this.deps.notify(`已改名为「${name}」`, 'ok');
      await this.reload();
    } catch (error) {
      await this.handleError('改名失败', error);
    }
  }

  private async setDefault(repo: RepoSummary): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    const ok = await askConfirm(
      `把「${repo.name}」设为默认仓库？\n\n` +
        '默认仓库是上传时的预选目标，也是唯一不能删除的那个。\n' +
        '原来的默认仓库会变成普通仓库（之后才可以删）。',
      '设为默认仓库',
    );
    if (!ok) return;
    try {
      await setDefaultRepo(config, repo.id);
      this.deps.notify(`「${repo.name}」已设为默认仓库`, 'ok');
      await this.reload();
    } catch (error) {
      await this.handleError('设置默认仓库失败', error);
    }
  }

  /**
   * 删除仓库。
   *
   * 非空仓库必须选目标 —— 这里**不替用户猜**（"随便挑一个"等于替人做数据迁移）。
   * 空仓库直接确认删除。
   */
  private async remove(repo: RepoSummary): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;

    const others = this.repos.filter((item) => item.id !== repo.id);
    let transferTo: string | undefined;

    if (repo.cardCount > 0) {
      if (others.length === 0) {
        this.deps.notify(`「${repo.name}」里还有 ${String(repo.cardCount)} 张卡，但没有别的仓库可转移`, 'warn');
        return;
      }
      const options = others.map((item, index) => `${String(index + 1)}. ${item.name}（${String(item.cardCount)} 张）`).join('\n');
      const answer = window.prompt(
        `「${repo.name}」里还有 ${String(repo.cardCount)} 张卡片。\n` +
          '删除前必须把它们转移到另一个仓库 —— 输入编号：\n\n' +
          options,
        '1',
      );
      if (answer === null) return;
      const index = Number.parseInt(answer.trim(), 10) - 1;
      const target = others[index];
      if (!target) {
        this.deps.notify('没有选中有效的目标仓库，已取消', 'warn');
        return;
      }
      const confirm = await askConfirm(
        `把 ${String(repo.cardCount)} 张卡片转入「${target.name}」，然后删除「${repo.name}」？\n\n` +
          '这个操作会同时吊销该仓库的令牌。',
        '删除仓库',
      );
      if (!confirm) return;
      transferTo = target.id;
    } else {
      if (!(await askConfirm(`删除空仓库「${repo.name}」？`, '删除仓库'))) return;
    }

    try {
      const result = await deleteRepo(config, repo.id, { transferTo });
      const detail = result.movedCards > 0 ? `，转移了 ${String(result.movedCards)} 张卡片` : '';
      const revoked = result.revokedTokens > 0 ? `，吊销 ${String(result.revokedTokens)} 个令牌` : '';
      this.deps.notify(`已删除「${repo.name}」${detail}${revoked}`, 'ok');
      await this.reload();
    } catch (error) {
      await this.handleError('删除仓库失败', error);
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

      /*
       * 每条的复制按钮（v0.1.3 / F5 后半，需求第 4 条）。
       *
       * **这里有个不能糊弄的事实**：服务端只存 sha256，原文只在签发响应里出现一次。
       * 所以"已签发列表里的复制"分两种情况，必须如实区分 —— 假装能复制全文，
       * 用户会粘一把前缀到登录框里，然后得到"格式不对"，却以为是自己复制错了：
       *
       *   · 令牌是**本次面板里刚签发**的 → 原文还在内存（`liveRawByPrefix`），复制全文；
       *   · 更早签发的 → 只能复制前缀，按钮直接写「复制前缀」并说明原因。
       *
       * 与其给一个"看起来一样、实际粘不过去"的按钮，不如把两种状态在按钮文字上分开。
       */
      const liveRaw = this.liveRawByPrefix.get(token.tokenPrefix);
      const copyLabel = liveRaw === undefined ? '复制前缀' : '复制';
      const copy = el('button', 'btn small ghost', copyLabel) as HTMLButtonElement;
      copy.type = 'button';
      copy.dataset['role'] = 'token-copy-prefix';
      copy.dataset['tokenPrefix'] = token.tokenPrefix;
      copy.title =
        liveRaw === undefined
          ? '原文只在签发时显示一次，这里无法再取回；已丢失请吊销后重新签发'
          : '复制完整令牌（本次打开面板时签发，原文仍在内存里）';
      copy.addEventListener('click', () => void this.copyRowToken(token.tokenPrefix, liveRaw));
      head.append(copy);

      // 使用指引：每条都带，因为用户是"看到这一行才想起要给别人用"
      const guide = el(
        'p',
        'field-hint token-row-guide',
        liveRaw === undefined
          ? '用法（另需原文）：在另一台设备的客户端：登录 → 使用仓库令牌连接 → 粘贴令牌。' +
            '原文已不在本机，如需给别人用请吊销后重新签发。'
          : '在另一台设备的客户端：登录 → 使用仓库令牌连接 → 粘贴此令牌。',
      );
      guide.dataset['role'] = 'token-row-guide';
      row.append(head, guide);
      this.tokenListEl.append(row);
    }
  }

  /**
   * 复制某一行的令牌。
   *
   * `liveRaw` 为 undefined 时复制前缀，并**明确告知这不是可用凭证** ——
   * 静默复制一个前缀是最坏的结果（用户以为拿到了令牌）。
   */
  private async copyRowToken(prefix: string, liveRaw: string | undefined): Promise<void> {
    const value = liveRaw ?? prefix;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
      await navigator.clipboard.writeText(value);
      if (liveRaw === undefined) {
        this.deps.notify(
          `已复制前缀 ${prefix}…（不是完整令牌，黏不过去；原文只在签发时显示一次）`,
          'warn',
        );
      } else {
        this.deps.notify('已复制完整令牌到剪贴板', 'ok');
      }
    } catch {
      this.deps.notify(
        liveRaw === undefined
          ? `无法访问剪贴板；前缀是 ${prefix}（不是完整令牌）`
          : '无法访问剪贴板：请用「签发」区里的复制按钮，或手动选中复制',
        'warn',
      );
    }
  }

  private async createNewRepo(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    // 传原始输入：首尾空白是拒绝项，不静默 trim（与改名字同一条规则）
    const check = validateRepoName(this.newRepoInput.value);
    if (!check.ok) {
      this.deps.notify(check.message ?? '仓库名不合法', 'warn');
      return;
    }
    const name = check.name;
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
    /*
     * 把原文按前缀记进内存，供"已签发列表"那一行的复制按钮使用。
     *
     * 只活在这个面板的打开期内（close() 里清空）：服务端拿不回原文，
     * 我们也不该把它留在内存里更久 —— 那是把"一次性凭证"变成"长期驻留的密钥"。
     */
    if (issued.tokenPrefix !== '') this.liveRawByPrefix.set(issued.tokenPrefix, issued.token);
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

    /*
     * 按错误类别分层（v0.1.4 / G1）。
     *
     * 事故背景：改名走 PATCH，而服务端的 CORS 预检漏了 PATCH，于是浏览器在
     * **发出请求之前**就拒绝，`fetch` 抛 `TypeError` —— 客户端只能把它归成
     * `NETWORK`，显示「无法连接服务端」，而同刻顶栏明明是"已连接"。
     * 根因已在服务端修掉（允许方法改为从路由表派生），但**文案分层是另一半**：
     * 权限问题必须说"权限不足"，不能说"连不上"，否则用户会去查网络和防火墙。
     *
     * 403 加前缀而不是替换：服务端原话里带着"该怎么办"，那部分信息不能丢。
     * 401 不加前缀 —— 认证失败必须保持服务端原话（防用户名枚举，docs/29）。
     */
    const shown =
      error instanceof RepoClientError && error.code === 'FORBIDDEN'
        ? `权限不足 —— ${message}`
        : message;
    this.noteEl.textContent = `${prefix}：${shown}`;
    this.deps.notify(`${prefix}：${shown}`, 'bad');
  }

  /** 供端到端断言：当前签发区里的原文（不应在关闭后还能读到） */
  get issuedToken(): string {
    return this.issuedBox.hidden ? '' : this.issuedValue.value;
  }

  get busyNow(): boolean {
    return this.busy;
  }
}
