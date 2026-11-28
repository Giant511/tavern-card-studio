/*
 * 功能
 * 桌面端「账户」面板：身份、UID、登录设备、改名/改密码、我的卡片、退出登录。
 *
 * 注意事项
 * 仓库令牌属于「仓库与令牌」面板，不在这里；这里只处理"我是谁、我在哪登录"。
 * 每次 open 都重新拉一次 /api/auth/me —— 改名后顶栏与面板必须同时变，
 * 只信构造时缓存的名字会留下"顶栏 test、面板 testuser"的分叉。
 *
 * 踩过的坑
 * 旧版把这些内容塞在仓库面板里：点右上角用户名打开的是卡片列表，
 * 点第 4 个工具栏按钮却看到账户与仓库混在一起（用户 2026-11-27 指出）。
 */

import type { RepoClientConfig } from './repo-client';
import {
  RepoClientError,
  changeAccountPassword,
  changeAccountUsername,
  fetchAccountIdentity,
  fetchAccountSessions,
  revokeAccountSession,
  revokeOtherSessions,
} from './repo-client';
import type { AccountSession } from './repo-client';
import { AccountFormModal } from './account-form-modal';
import { describeSession, sortSessions } from './session-view';
import { listCards, type SyncConfig } from './server-sync';

export interface AccountDialogDeps {
  /** 账户身份（不是仓库令牌）；未登录时返回 null */
  getConfig: () => RepoClientConfig | null;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 401 时先试续期；返回 false 表示要回登录界面 */
  onUnauthorized?: () => Promise<boolean>;
  /** 改名成功后同步顶栏、设置页等其它显示用户名的地方 */
  onAccountChanged?: () => void;
  /** 打开「我的卡片」完整面板 */
  onOpenCards?: () => void | Promise<void>;
  /** 卡片列表用的同步配置（与 CardsDialog 同一个来源） */
  getSyncConfig?: () => SyncConfig | null;
  /** 退出登录 / 退出令牌模式 */
  onLogout?: () => Promise<void>;
  isRepoTokenMode?: () => boolean;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class AccountDialog {
  private readonly overlay: HTMLDivElement;
  private readonly usernameEl: HTMLElement;
  private readonly uidInput: HTMLInputElement;
  private readonly identityHint: HTMLElement;
  private readonly sessionsListEl: HTMLElement;
  private readonly sessionsHint: HTMLElement;
  private readonly revokeOthersButton: HTMLButtonElement;
  private readonly refreshSessionsButton: HTMLButtonElement;
  private readonly cardsListEl: HTMLElement;
  private readonly cardsHint: HTMLElement;
  private readonly cardsButton: HTMLButtonElement;
  private readonly logoutButton: HTMLButtonElement;
  private busy = false;

  constructor(private readonly deps: AccountDialogDeps) {
    this.overlay = el('div', 'modal-overlay') as HTMLDivElement;
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'account-dialog';

    const panel = el('div', 'modal account-dialog');

    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', '账户'));
    const close = el('button', 'icon-btn', '×') as HTMLButtonElement;
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(close);

    const body = el('div', 'modal-body');

    const hero = el('div', 'account-hero');
    hero.append(el('div', 'account-avatar', '·'));
    const heroText = el('div', 'account-hero-text');
    this.usernameEl = el('div', 'account-name', '—');
    this.usernameEl.dataset['role'] = 'account-username';
    this.identityHint = el('div', 'account-sub', '正在读取账户…');
    this.identityHint.dataset['role'] = 'account-identity-hint';
    heroText.append(this.usernameEl, this.identityHint);
    hero.append(heroText);
    body.append(hero);

    const uidSection = el('section', 'form-section account-card');
    uidSection.dataset['role'] = 'account-section';
    uidSection.append(el('h3', 'form-title', '账号标识'));
    const uidLabel = el('p', 'field-hint', 'UID 是注册时生成的唯一标识：改名不会改变它，找回账号时运维只认它。');
    const uidRow = el('div', 'field-row');
    this.uidInput = el('input', 'input mono') as HTMLInputElement;
    this.uidInput.readOnly = true;
    this.uidInput.dataset['role'] = 'account-uid';
    const copy = el('button', 'btn', '复制 UID') as HTMLButtonElement;
    copy.type = 'button';
    copy.dataset['role'] = 'account-uid-copy';
    copy.addEventListener('click', () => void this.copyUid(copy));
    uidRow.append(this.uidInput, copy);
    uidSection.append(uidLabel, uidRow);

    const uidHint = el(
      'p',
      'field-hint account-uid-hint',
      '请好好保存 UID —— 紧急情况下（忘了用户名或密码）需要 UID 才能找回账号。',
    );
    uidHint.dataset['role'] = 'account-uid-hint';
    uidSection.append(uidHint);

    const actions = el('div', 'field-row account-actions');
    const rename = el('button', 'btn', '修改用户名…') as HTMLButtonElement;
    rename.type = 'button';
    rename.dataset['role'] = 'account-rename';
    rename.addEventListener('click', () => void this.renameAccount());
    const password = el('button', 'btn', '修改密码…') as HTMLButtonElement;
    password.type = 'button';
    password.dataset['role'] = 'account-change-password';
    password.addEventListener('click', () => void this.changePassword());
    actions.append(rename, password);
    uidSection.append(actions);
    body.append(uidSection);

    const sessionsSection = el('section', 'form-section account-card');
    sessionsSection.dataset['role'] = 'account-sessions-section';
    sessionsSection.append(el('h3', 'form-title', '登录设备'));
    this.sessionsListEl = el('div', 'session-list');
    this.sessionsListEl.dataset['role'] = 'account-sessions';
    this.sessionsHint = el('p', 'field-hint', '登录后可以查看自己的登录设备。');
    this.sessionsHint.dataset['role'] = 'account-sessions-hint';
    const sessionActions = el('div', 'field-row');
    this.refreshSessionsButton = el('button', 'btn', '刷新') as HTMLButtonElement;
    this.refreshSessionsButton.type = 'button';
    this.refreshSessionsButton.dataset['role'] = 'account-sessions-refresh';
    this.refreshSessionsButton.addEventListener('click', () => void this.refreshSessions());
    this.revokeOthersButton = el('button', 'btn', '退出其它设备') as HTMLButtonElement;
    this.revokeOthersButton.type = 'button';
    this.revokeOthersButton.dataset['role'] = 'account-sessions-revoke-others';
    this.revokeOthersButton.addEventListener('click', () => void this.revokeOthers());
    sessionActions.append(this.refreshSessionsButton, this.revokeOthersButton);
    sessionsSection.append(this.sessionsListEl, this.sessionsHint, sessionActions);
    body.append(sessionsSection);

    /*
     * 我的卡片。卡片资产属于账户，是「我是谁」的一部分。
     * 这里只给最近几张的概览；搜索、设封面、移动、删除仍在完整的「我的卡片」面板。
     */
    const cardsSection = el('section', 'form-section account-card');
    cardsSection.dataset['role'] = 'account-cards-section';
    const cardsHead = el('div', 'form-title-row');
    cardsHead.append(el('h3', 'form-title', '我的卡片'));
    this.cardsHint = el('span', 'field-hint', '正在加载…');
    this.cardsHint.dataset['role'] = 'account-cards-hint';
    cardsHead.append(this.cardsHint);
    this.cardsListEl = el('div', 'account-card-list');
    this.cardsListEl.dataset['role'] = 'account-cards-list';
    cardsSection.append(cardsHead, this.cardsListEl);
    body.append(cardsSection);

    const foot = el('div', 'modal-foot');
    this.logoutButton = el('button', 'btn ghost', '退出登录') as HTMLButtonElement;
    this.logoutButton.type = 'button';
    this.logoutButton.dataset['role'] = 'account-logout';
    this.logoutButton.addEventListener('click', () => void this.logout());
    const spacer = el('span', 'foot-note', '登录设备由服务端返回；改密码会让所有设备重新登录');
    this.cardsButton = el('button', 'btn', '我的卡片…') as HTMLButtonElement;
    this.cardsButton.type = 'button';
    this.cardsButton.dataset['role'] = 'account-cards';
    this.cardsButton.addEventListener('click', () => void this.openCards());
    const done = el('button', 'btn primary', '关闭') as HTMLButtonElement;
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(this.logoutButton, spacer, this.cardsButton, done);

    panel.append(head, body, foot);
    this.overlay.append(panel);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });
    document.body.append(this.overlay);
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    this.logoutButton.textContent = this.deps.isRepoTokenMode?.() === true ? '退出令牌模式' : '退出登录';
    this.cardsButton.hidden = false;
    await this.reload();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /**
   * 重新读身份与登录设备，保证面板显示的是服务端当前值。
   *
   * 401 先续期，续不上就关面板。否则用户叉掉登录框后，还能看到一份已经失效的
   * 账户界面（2026-11-27 用户截图反馈）。
   */
  private async reload(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.usernameEl.textContent = '未登录';
      this.uidInput.value = '';
      this.identityHint.textContent = '登录后才能查看账户信息。';
      this.sessionsListEl.replaceChildren();
      this.sessionsHint.textContent = '仅登录账户后可用。';
      this.revokeOthersButton.disabled = true;
      this.cardsButton.disabled = false;
      this.cardsHint.textContent = '登录后显示。';
      this.cardsListEl.replaceChildren();
      return;
    }

    this.identityHint.textContent = '正在读取账户…';
    this.refreshSessionsButton.disabled = true;
    try {
      const identity = await fetchAccountIdentity(config);
      this.usernameEl.textContent = identity.username === '' ? '（未命名账户）' : identity.username;
      this.uidInput.value = identity.uid;
      this.identityHint.textContent = '已登录 · 账户';
      this.cardsButton.disabled = false;
    } catch (error) {
      if (await this.recover(error)) return;
      this.identityHint.textContent = `身份读取失败：${this.describe(error)}`;
      this.cardsButton.disabled = true;
    } finally {
      this.refreshSessionsButton.disabled = false;
    }
    await this.reloadSessions(config);
    await this.reloadCards();
  }

  /**
   * 读最近 5 张卡片，作为账户资产概览。
   *
   * 只读。修改卡片仍走完整的「我的卡片」面板，避免两处各写一套操作。
   * 这里失败不能影响身份和登录设备两块：卡片接口挂了，用户仍应看到自己的
   * 用户名与设备列表。
   */
  private async reloadCards(): Promise<void> {
    const sync = this.deps.getSyncConfig?.() ?? null;
    if (!sync) {
      this.cardsHint.textContent = '登录后显示。';
      this.cardsListEl.replaceChildren();
      return;
    }
    this.cardsHint.textContent = '正在加载…';
    try {
      const items = await listCards(sync, { limit: 5 });
      this.cardsListEl.replaceChildren();
      if (items.length === 0) {
        this.cardsHint.textContent = '账户里还没有卡片。';
        return;
      }
      this.cardsHint.textContent = `最近 ${String(items.length)} 张`;
      for (const item of items) {
        const row = el('button', 'account-card-row') as HTMLButtonElement;
        row.type = 'button';
        row.dataset['role'] = 'account-card-row';
        row.append(el('span', 'account-card-name', item.name === '' ? item.cardId : item.name));
        row.append(el('span', 'account-card-meta', item.repoName ?? '未归属'));
        row.append(el('span', 'account-card-meta', `v${String(item.latestSeq)}`));
        row.addEventListener('click', () => void this.openCards());
        this.cardsListEl.append(row);
      }
    } catch (error) {
      this.cardsListEl.replaceChildren();
      this.cardsHint.textContent = `读取卡片失败：${this.describe(error)}`;
    }
  }

  /** 401 → 续期一次；续不上就关面板并让外壳去开登录框。返回是否已续期成功 */
  private async recover(error: unknown): Promise<boolean> {
    if (
      !(error instanceof RepoClientError) ||
      error.code !== 'UNAUTHORIZED' ||
      this.deps.onUnauthorized === undefined
    ) {
      return false;
    }
    const recovered = await this.deps.onUnauthorized();
    if (!recovered) this.close();
    return recovered;
  }

  private describe(error: unknown): string {
    return error instanceof RepoClientError ? error.displayMessage : String(error);
  }

  private async copyUid(button: HTMLButtonElement): Promise<void> {
    const uid = this.uidInput.value;
    if (uid === '') return;
    try {
      await navigator.clipboard.writeText(uid);
      const original = button.textContent;
      button.textContent = '已复制';
      this.deps.notify('UID 已复制，请妥善保存', 'ok');
      setTimeout(() => {
        button.textContent = original ?? '复制 UID';
      }, 1500);
    } catch {
      this.uidInput.select();
      this.deps.notify('复制失败：已帮你选中，请按 Ctrl+C 复制', 'warn');
    }
  }

  private async renameAccount(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.deps.notify('需要先登录账户', 'warn');
      return;
    }
    const currentName = this.usernameEl.textContent ?? '';
    const modal = new AccountFormModal({
      title: '修改用户名',
      description: 'UID 不会随改名变化。新用户名需要与当前密码一起提交。',
      submitLabel: '保存新用户名',
      fields: [
        {
          key: 'newUsername',
          label: '新用户名',
          type: 'text',
          value: currentName,
          autocomplete: 'username',
          minLength: 3,
          hint: '3–32 个字符，字母或数字开头',
        },
        {
          key: 'currentPassword',
          label: '当前密码',
          type: 'password',
          autocomplete: 'current-password',
          hint: '改名属于身份变更，需要验证当前密码',
        },
      ],
      onSubmit: async (values) => {
        const newUsername = values['newUsername']?.trim() ?? '';
        if (newUsername === currentName) {
          return { ok: false, message: '新用户名与当前相同', field: 'newUsername' };
        }
        try {
          const result = await changeAccountUsername(config, {
            currentPassword: values['currentPassword'] ?? '',
            newUsername,
          });
          this.usernameEl.textContent = result.username;
          if (result.uid !== '') this.uidInput.value = result.uid;
          this.deps.notify(`已改名为「${result.username}」`, 'ok');
          this.deps.onAccountChanged?.();
          return { ok: true };
        } catch (error) {
          if (error instanceof RepoClientError && error.status === 403) {
            return { ok: false, message: '当前密码不正确', field: 'currentPassword' };
          }
          return {
            ok: false,
            message: error instanceof RepoClientError ? error.displayMessage : '改名失败（原因未知）',
          };
        }
      },
    });
    modal.open();
  }

  private async changePassword(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.deps.notify('需要先登录账户', 'warn');
      return;
    }
    const modal = new AccountFormModal({
      title: '修改密码',
      description: '改完后这台设备也会退出登录，需要用新密码重新登录。',
      submitLabel: '修改密码',
      fields: [
        { key: 'currentPassword', label: '当前密码', type: 'password', autocomplete: 'current-password' },
        {
          key: 'newPassword',
          label: '新密码',
          type: 'password',
          autocomplete: 'new-password',
          minLength: 8,
          hint: '至少 8 个字符，不能与当前密码相同',
        },
        {
          key: 'confirmPassword',
          label: '再输一次新密码',
          type: 'password',
          autocomplete: 'new-password',
          confirmOf: 'newPassword',
        },
      ],
      onSubmit: async (values) => {
        const currentPassword = values['currentPassword'] ?? '';
        const newPassword = values['newPassword'] ?? '';
        if (newPassword === currentPassword) {
          return { ok: false, message: '新密码不能与当前密码相同', field: 'newPassword' };
        }
        try {
          const result = await changeAccountPassword(config, { currentPassword, newPassword });
          this.deps.notify(
            result.revoked > 0
              ? `密码已修改，${String(result.revoked)} 台设备已退出登录。请用新密码重新登录。`
              : '密码已修改，请用新密码重新登录。',
            'ok',
          );
          await this.deps.onUnauthorized?.();
          this.close();
          return { ok: true };
        } catch (error) {
          if (error instanceof RepoClientError && error.status === 403) {
            return { ok: false, message: '当前密码不正确', field: 'currentPassword' };
          }
          return {
            ok: false,
            message: error instanceof RepoClientError ? error.displayMessage : '改密码失败（原因未知）',
          };
        }
      },
    });
    modal.open();
  }

  private async reloadSessions(config: RepoClientConfig): Promise<void> {
    this.sessionsHint.textContent = '正在加载登录设备…';
    this.refreshSessionsButton.disabled = true;
    try {
      const items = await fetchAccountSessions(config);
      this.renderSessions(items);
      const others = items.filter((item) => !item.current).length;
      this.sessionsHint.textContent =
        items.length <= 1
          ? '只有当前这一台设备。'
          : `共 ${String(items.length)} 台设备，其中 ${String(others)} 台不是当前设备。`;
      this.revokeOthersButton.disabled = others === 0;
    } catch (error) {
      if (await this.recover(error)) {
        await this.reloadSessions(config);
        return;
      }
      this.sessionsListEl.replaceChildren();
      this.sessionsHint.textContent = `取不到登录设备：${this.describe(error)}`;
      this.revokeOthersButton.disabled = true;
    } finally {
      this.refreshSessionsButton.disabled = false;
    }
  }

  private renderSessions(items: readonly AccountSession[]): void {
    this.sessionsListEl.replaceChildren();
    const sorted = sortSessions(items);
    if (sorted.length === 0) {
      this.sessionsHint.textContent = '没有可显示的登录设备。';
      return;
    }
    for (const item of sorted) {
      const view = describeSession(item);
      const row = el('div', 'session-row');
      row.dataset['role'] = 'account-session-row';
      row.dataset['sessionId'] = item.id;
      const main = el('div', 'session-main');
      const title = el('div', 'session-title');
      title.append(el('span', 'session-device', view.title));
      if (item.current) {
        const badge = el('span', 'session-current', '当前设备');
        badge.dataset['role'] = 'account-session-current';
        title.append(badge);
      }
      main.append(title, el('div', 'session-meta', view.meta));
      row.append(main);
      if (!item.current) {
        const revoke = el('button', 'btn ghost', '退出') as HTMLButtonElement;
        revoke.type = 'button';
        revoke.dataset['role'] = 'account-session-revoke';
        revoke.addEventListener('click', () => void this.revokeSession(item.id, revoke));
        row.append(revoke);
      }
      this.sessionsListEl.append(row);
    }
  }

  private async revokeSession(sessionId: string, button: HTMLButtonElement): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    if (!window.confirm('退出这台设备？它会立刻失效，下次要用时需要重新登录。')) return;
    button.disabled = true;
    try {
      const result = await revokeAccountSession(config, sessionId);
      if (result.self) {
        this.deps.notify('已退出当前设备', 'ok');
        this.close();
        this.deps.onAccountChanged?.();
        return;
      }
      this.deps.notify(result.revoked ? '已退出 1 台设备' : '这台设备已经不在了，列表已刷新', 'ok');
      await this.reloadSessions(config);
    } catch (error) {
      this.deps.notify(`退出设备失败：${this.describe(error)}`, 'bad');
    } finally {
      button.disabled = false;
    }
  }

  private async revokeOthers(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) return;
    if (!window.confirm('退出所有其它设备？它们会立刻失效，当前这台不受影响。')) return;
    this.revokeOthersButton.disabled = true;
    try {
      const result = await revokeOtherSessions(config);
      this.deps.notify(
        result.revoked === 0 ? '没有其它设备需要退出' : `已退出 ${String(result.revoked)} 台设备`,
        'ok',
      );
      await this.reloadSessions(config);
    } catch (error) {
      this.deps.notify(`退出其它设备失败：${this.describe(error)}`, 'bad');
    } finally {
      this.revokeOthersButton.disabled = false;
    }
  }

  private async refreshSessions(): Promise<void> {
    const config = this.deps.getConfig();
    if (!config) {
      this.sessionsHint.textContent = '需要先登录账户。';
      return;
    }
    await this.reloadSessions(config);
  }

  private async openCards(): Promise<void> {
    if (this.deps.onOpenCards === undefined) return;
    this.close();
    await this.deps.onOpenCards();
  }

  private async logout(): Promise<void> {
    if (this.deps.onLogout === undefined || this.busy) return;
    this.busy = true;
    this.logoutButton.disabled = true;
    try {
      await this.deps.onLogout();
      this.close();
    } finally {
      this.busy = false;
      this.logoutButton.disabled = false;
    }
  }
}
