/**
 * 注销账户确认弹窗（v0.1.3 / F3）。
 *
 * ## 为什么单独一个弹窗，不复用 `window.confirm`
 *
 * 需求 1 要求「二次确认弹窗必须输入用户名（或密码）确认，非单点确定」。
 * `window.confirm` 只有一个"确定"按钮 —— 手滑一下账户就没了，
 * 而这是**不可恢复**的操作（服务端物理删除，没有回收站）。
 *
 * ## 三道闸，各自防一种错
 *
 *   1. **列出将要删除什么**（卡 / 版本 / 仓库 / 令牌 / 会话的**实际数量**）——
 *      防"我以为只是退出登录"。退出登录就在同一行旁边，太容易点错。
 *   2. **必须手打用户名** —— 防单点。打错一个字母就提交不了，
 *      而"打对了"这个动作本身就说明用户读懂了警告。
 *   3. **密码可选加强** —— 需求允许"用户名或密码"。给了就必须对（服务端判）。
 *
 * 提交按钮在用户名匹配之前**保持禁用**：让"不可点"成为第一道提示，
 * 而不是让人点了才收到一句"用户名不一致"。
 */

import type { DeleteAccountReceipt } from './auth-client.ts';
import { AuthClientError } from './auth-client.ts';
import { authErrorMessage } from './policy.ts';

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

export interface AccountDeleteStats {
  cards: number;
  versions: number;
  repos: number;
  repoTokens: number;
  sessions: number;
}

export interface AccountDeleteDialogDeps {
  /** 当前账户用户名（要用户手打的那个） */
  getUsername: () => string;
  /**
   * 取"将要删除什么"的数量。
   *
   * 失败（没连上、没权限）时返回 null —— 那时弹窗**照样能打开**，
   * 只是不显示数量。理由：注销不该因为"统计拿不到"而做不了，
   * 但也不能编一个数字出来（"将删除 0 张卡"是危险的谎）。
   */
  getStats: () => Promise<AccountDeleteStats | null>;
  /** 真正执行注销；成功返回回执 */
  onConfirm: (input: { confirmUsername: string; password: string }) => Promise<DeleteAccountReceipt>;
  /** 注销成功（App 据此重画顶栏、刷新面板） */
  onDeleted: (receipt: DeleteAccountReceipt) => void;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
}

export class AccountDeleteDialog {
  private readonly overlay: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly statsBox: HTMLElement;
  private readonly usernameHint: HTMLElement;
  private readonly usernameInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly errorBox: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private busy = false;
  private expected = '';

  constructor(private readonly deps: AccountDeleteDialogDeps) {
    this.overlay = el('div', 'modal-overlay modal-overlay-top');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'account-delete-dialog';

    const panel = el('div', 'modal account-delete-modal');
    const head = el('div', 'modal-head');
    this.title = el('h2', 'modal-title', '注销账户');
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（不会注销）';
    closeBtn.addEventListener('click', () => this.close());
    head.append(this.title, closeBtn);

    const body = el('div', 'modal-body');

    /*
     * 警告区。用常驻块而不是一句小字：
     * 这是整个客户端唯一一个"点错就再也回不来"的按钮，
     * 视觉重量必须与后果匹配。
     */
    const warning = el('div', 'account-delete-warning');
    warning.append(
      el('p', 'account-delete-warning-title', '这是不可恢复的操作'),
      el(
        'p',
        'account-delete-warning-text',
        '注销会把这个账户连同它的全部数据从磁盘上删除：没有任何回收站，' +
          '也不能靠重新注册找回。如果你只是想换个账户登录，请用「退出登录」。',
      ),
    );
    body.append(warning);

    this.statsBox = el('div', 'account-delete-stats');
    this.statsBox.dataset['role'] = 'account-delete-stats';
    body.append(this.statsBox);

    this.usernameHint = el('p', 'field-hint account-delete-hint');
    this.usernameHint.dataset['role'] = 'account-delete-hint';
    body.append(this.usernameHint);

    const userField = el('label', 'field');
    userField.append(el('span', 'field-label', '输入用户名以确认'));
    this.usernameInput = el('input', 'input');
    this.usernameInput.type = 'text';
    this.usernameInput.autocomplete = 'off';
    this.usernameInput.spellcheck = false;
    this.usernameInput.dataset['role'] = 'account-delete-username';
    this.usernameInput.addEventListener('input', () => this.resyncConfirm());
    userField.append(this.usernameInput);
    body.append(userField);

    const passField = el('label', 'field');
    passField.append(el('span', 'field-label', '密码（可选，填了会一并校验）'));
    this.passwordInput = el('input', 'input');
    this.passwordInput.type = 'password';
    this.passwordInput.autocomplete = 'current-password';
    this.passwordInput.dataset['role'] = 'account-delete-password';
    passField.append(this.passwordInput);
    body.append(passField);

    this.errorBox = el('p', 'auth-error');
    this.errorBox.hidden = true;
    this.errorBox.dataset['role'] = 'account-delete-error';
    this.errorBox.setAttribute('role', 'alert');
    body.append(this.errorBox);

    const foot = el('div', 'modal-foot');
    this.cancelButton = el('button', 'btn', '取消');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.close());

    this.confirmButton = el('button', 'btn danger', '永久注销');
    this.confirmButton.type = 'button';
    this.confirmButton.dataset['role'] = 'account-delete-confirm';
    this.confirmButton.disabled = true;
    this.confirmButton.addEventListener('click', () => void this.submit());

    foot.append(el('span', 'foot-note', '操作会写入审计日志'), this.cancelButton, this.confirmButton);

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

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  async open(): Promise<void> {
    this.expected = this.deps.getUsername();
    this.overlay.hidden = false;
    this.overlay.classList.add('modal-overlay-top');
    this.usernameInput.value = '';
    this.passwordInput.value = '';
    this.clearError();
    this.confirmButton.disabled = true;
    this.title.textContent = `注销账户${this.expected === '' ? '' : `：${this.expected}`}`;
    this.usernameHint.textContent =
      this.expected === ''
        ? '请输入当前账户的用户名以确认'
        : `请输入「${this.expected}」以确认（大小写不敏感）`;
    // 统计是异步的：先显示"读取中"，拿到再替换。拿不到就明说，不编数字。
    this.statsBox.textContent = '正在统计该账户下的数据…';
    this.usernameInput.focus();

    const stats = await this.deps.getStats();
    if (stats === null) {
      this.statsBox.textContent = '无法读取数据统计（服务端未连接或已断开）—— 注销仍会删除该账户的全部数据';
      this.statsBox.dataset['state'] = 'unknown';
      return;
    }
    this.statsBox.dataset['state'] = 'ok';
    this.statsBox.replaceChildren(
      el('p', 'account-delete-stats-title', '将被永久删除：'),
      el(
        'ul',
        'account-delete-stats-list',
        undefined,
      ),
    );
    const list = this.statsBox.querySelector('ul');
    if (list !== null) {
      for (const line of [
        `${String(stats.cards)} 张角色卡（含回收站里的）`,
        `${String(stats.versions)} 个历史版本`,
        `${String(stats.repos)} 个仓库`,
        `${String(stats.repoTokens)} 个仓库令牌（其他设备上用这些令牌的连接会立刻失效）`,
        `${String(stats.sessions)} 个登录会话`,
      ]) {
        list.append(el('li', undefined, line));
      }
    }
  }

  close(): void {
    this.overlay.hidden = true;
    this.passwordInput.value = '';
    this.usernameInput.value = '';
    this.setBusy(false);
  }

  /** 用户名是否已匹配（本地预判，只影响按钮可用性；判据在服务端） */
  private matches(): boolean {
    const typed = this.usernameInput.value.trim();
    if (typed === '' || this.expected === '') return false;
    return typed.toLowerCase() === this.expected.toLowerCase();
  }

  private resyncConfirm(): void {
    this.confirmButton.disabled = this.busy || !this.matches();
    if (this.matches()) this.clearError();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.confirmButton.disabled = busy || !this.matches();
    this.confirmButton.textContent = busy ? '正在注销…' : '永久注销';
    this.cancelButton.disabled = busy;
    this.usernameInput.disabled = busy;
    this.passwordInput.disabled = busy;
  }

  private showError(message: string): void {
    this.errorBox.hidden = false;
    this.errorBox.textContent = message;
  }

  private clearError(): void {
    this.errorBox.hidden = true;
    this.errorBox.textContent = '';
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (!this.matches()) {
      this.showError('输入的用户名与当前账户不一致');
      return;
    }
    this.setBusy(true);
    this.clearError();
    try {
      const receipt = await this.deps.onConfirm({
        confirmUsername: this.usernameInput.value.trim(),
        password: this.passwordInput.value,
      });
      const parts = [
        `${String(receipt.counts.cards)} 张卡`,
        `${String(receipt.counts.repos)} 个仓库`,
        `${String(receipt.counts.repoTokens)} 个令牌`,
      ];
      if (receipt.warnings.length > 0) {
        /*
         * 有文件删不掉时必须如实说，不能报"已彻底删除"。
         * 这条分支在 Windows 上真的会遇到（git 目录被别的进程占着），
         * 静默放过等于让用户以为敏感内容已经从磁盘上消失了。
         */
        this.deps.notify(
          `账户已注销，但 ${String(receipt.warnings.length)} 项未能删除：${receipt.warnings[0] ?? ''}`,
          'warn',
        );
      } else {
        this.deps.notify(`账户「${receipt.username}」已注销：${parts.join('、')} 已清除`, 'ok');
      }
      this.close();
      this.deps.onDeleted(receipt);
    } catch (error) {
      // 错误文案优先用服务端原话（与登录同一条原则）：服务端会说清是
      // 用户名不一致、密码不对，还是"最后一个管理员不能注销"
      this.showError(
        error instanceof AuthClientError || error instanceof Error
          ? authErrorMessage(error)
          : String(error),
      );
    } finally {
      this.setBusy(false);
    }
  }
}
