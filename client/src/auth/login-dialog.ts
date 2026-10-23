/**
 * 登录 / 注册对话框（T10.7）。
 *
 * 三条界面规则（对应需求的 1 与 4）：
 *   · 失败提示**只用服务端文案**（`authErrorMessage` 原样转发），
 *     不做"是不是密码错了"这类本地推断 —— 那会把服务端刻意抹平的枚举面重建起来；
 *   · `registerMode = closed` 时**根本不显示**注册入口（不是点了才报错）；
 *   · 登录成功后不关闭本地任何标签 —— 这个对话框没有那个能力，也刻意不给。
 */

import {
  type AuthPolicy,
  type AuthUser,
  AuthClientError,
} from './auth-client.ts';
import { authErrorMessage, isNetworkFailure, registerHint, shouldShowRegister } from './policy.ts';
import type { AuthSession } from './session.ts';

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

export interface LoginDialogDeps {
  session: AuthSession;
  /** 打开时拉一次策略（免鉴权接口） */
  getPolicy: () => Promise<AuthPolicy | null>;
  /**
   * 当前服务端地址（空串 = 还没配置）。
   *
   * v0.1.2 追加任务：登录/注册只需要**地址**，不需要令牌；但地址都没有时
   * 提交必然失败（`session.login` 会抛"尚未配置服务端地址"）。
   * 那种情况在界面里先说清楚并禁用提交，比让用户填完两个框再看一句报错好。
   */
  getServerUrl?: () => string;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 登录成功（或注册后自动登录成功） */
  onAuthenticated?: (user: AuthUser | null) => void;
}

type Mode = 'login' | 'register';

export class LoginDialog {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly usernameInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly errorBox: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private readonly registerButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  private mode: Mode = 'login';
  private policy: AuthPolicy | null = null;
  private busy = false;
  /** 非 null = 当前状态下提交没有意义（例如还没配服务端地址） */
  private blockedReason: string | null = null;

  constructor(private readonly deps: LoginDialogDeps) {
    this.overlay = el('div', 'modal-overlay modal-overlay-top');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'auth-dialog';

    this.panel = el('div', 'modal auth-modal');

    const head = el('div', 'modal-head');
    this.title = el('h2', 'modal-title', '登录');
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（不退出登录）';
    closeBtn.addEventListener('click', () => this.close());
    head.append(this.title, closeBtn);

    const body = el('div', 'modal-body');

    this.hint = el('p', 'field-hint auth-hint');
    this.hint.dataset['role'] = 'auth-hint';

    const userField = el('label', 'field');
    userField.append(el('span', 'field-label', '用户名'));
    this.usernameInput = el('input', 'input');
    this.usernameInput.type = 'text';
    this.usernameInput.autocomplete = 'username';
    this.usernameInput.spellcheck = false;
    this.usernameInput.dataset['role'] = 'auth-username';
    userField.append(this.usernameInput);

    const passField = el('label', 'field');
    passField.append(el('span', 'field-label', '密码'));
    this.passwordInput = el('input', 'input');
    this.passwordInput.type = 'password';
    this.passwordInput.autocomplete = 'current-password';
    this.passwordInput.dataset['role'] = 'auth-password';
    passField.append(this.passwordInput);

    // 错误区常驻（不用 alert）：服务端文案可能较长，也可能包含可执行的下一步，
    // 用户需要能反复读，而不是一关就没了。
    this.errorBox = el('p', 'auth-error');
    this.errorBox.hidden = true;
    this.errorBox.dataset['role'] = 'auth-error';
    this.errorBox.setAttribute('role', 'alert');

    body.append(this.hint, userField, passField, this.errorBox);

    const foot = el('div', 'modal-foot');
    this.cancelButton = el('button', 'btn', '取消');
    this.cancelButton.type = 'button';
    this.cancelButton.addEventListener('click', () => this.close());

    this.registerButton = el('button', 'btn ghost', '注册新账户');
    this.registerButton.type = 'button';
    this.registerButton.dataset['role'] = 'auth-register';
    /*
     * **默认隐藏**（fail-closed）。
     *
     * 打开对话框时 `open()` 会先让遮罩可见、再去拉 `/api/auth/config`。
     * 若这里默认可见，closed 的服务端上会先闪一下「注册新账户」再消失 ——
     * 手快的人点得到，然后收到一句"未开放注册"。这与"closed 时界面根本不显示"
     * 是两回事，而 `shouldShowRegister(null)` 早就把"策略未知"判成"不显示"，
     * 默认值跟着它走才一致。
     */
    this.registerButton.hidden = true;
    this.registerButton.addEventListener('click', () => this.switchMode());

    this.submitButton = el('button', 'btn primary', '登录');
    this.submitButton.type = 'button';
    this.submitButton.dataset['role'] = 'auth-submit';
    this.submitButton.addEventListener('click', () => void this.submit());

    foot.append(this.registerButton, el('span', 'foot-note', ''), this.cancelButton, this.submitButton);

    this.panel.append(head, body, foot);

    this.overlay.append(this.panel);
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    // 回车提交：用户名/密码框里回车是最自然的动作
    for (const input of [this.usernameInput, this.passwordInput]) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void this.submit();
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  /**
   * 打开对话框。
   *
   * `reason` 用于"登录已过期"这类被动回到登录界面的场景：把原因写在错误区，
   * 而不是弹一个 toast 就消失 —— 用户回来时得知道为什么又要登录。
   */
  async open(reason?: string): Promise<void> {
    this.overlay.hidden = false;
    /*
     * 必须提到最上层。
     *
     * 登录框会在"令牌过期"时被**被动**打开，而那一刻用户很可能正开着另一个
     * 对话框（我的卡片 / 同步面板）。所有 `.modal-overlay` 都是 z-index 50，
     * 后插入 DOM 的在上面 —— 登录框若被压在下面，用户看到的是"对话框里的
     * 数据突然空了"，而登录框只在后面露出一角（端到端截图抓到过这一幕）。
     * 用类名抬一层而不是改全局 z-index：其余对话框的叠放关系不该受影响。
     */
    this.overlay.classList.add('modal-overlay-top');
    this.setMode('login');
    this.clearError();
    if (reason) this.showError(reason);
    this.usernameInput.value = this.deps.session.user?.username ?? '';
    this.passwordInput.value = '';

    // 地址是唯一的硬前提（令牌不是）。没有地址时把话说清楚并禁用提交 ——
    // 注意这里**不关掉对话框**：用户可能只是刚装完服务端，先看到这句话
    // 再去设置里填地址，回来还是这个框。
    const serverUrl = this.deps.getServerUrl?.() ?? '';
    this.blockedReason =
      serverUrl.trim() === ''
        ? '还没有配置服务端地址：先在「设置」里填写（同机可直接点「连接本机服务端」），再回来登录。'
        : null;
    this.submitButton.disabled = this.blockedReason !== null;

    const policy = await this.deps.getPolicy();
    this.policy = policy;
    this.hint.textContent =
      this.blockedReason ?? registerHint(policy?.registerMode ?? null);
    this.registerButton.hidden = !shouldShowRegister(policy, this.deps.session.user);

    // 焦点给"该填的那个"：已记住用户名时直接进密码框
    (this.usernameInput.value === '' ? this.usernameInput : this.passwordInput).focus();
  }

  close(): void {
    this.overlay.hidden = true;
    this.passwordInput.value = '';
    this.setBusy(false);
  }

  private switchMode(): void {
    this.setMode(this.mode === 'login' ? 'register' : 'login');
    this.clearError();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.title.textContent = mode === 'login' ? '登录' : '注册新账户';
    this.submitButton.textContent = mode === 'login' ? '登录' : '创建账户';
    this.passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    this.registerButton.textContent = mode === 'login' ? '注册新账户' : '返回登录';
    this.overlay.dataset['mode'] = mode;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.submitButton.disabled = busy || this.blockedReason !== null;
    this.registerButton.disabled = busy;
    this.cancelButton.disabled = busy;
  }

  private showError(message: string): void {
    this.errorBox.hidden = false;
    this.errorBox.classList.remove('ok');
    this.errorBox.textContent = message;
  }

  private clearError(): void {
    this.errorBox.hidden = true;
    this.errorBox.textContent = '';
    this.errorBox.classList.remove('ok');
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (this.blockedReason !== null) {
      this.showError(this.blockedReason);
      return;
    }
    const username = this.usernameInput.value.trim();
    const password = this.passwordInput.value;
    if (username === '' || password === '') {
      // 这一条是本地校验，但它**不涉及账户是否存在**，不构成枚举面
      this.showError('请填写用户名和密码。');
      return;
    }

    this.setBusy(true);
    this.clearError();
    try {
      if (this.mode === 'login') {
        const bundle = await this.deps.session.login(username, password);
        this.deps.notify(`已登录：${bundle.user.username}`, 'ok');
        this.deps.onAuthenticated?.(bundle.user);
        this.close();
        return;
      }

      const outcome = await this.deps.session.register(username, password);
      if (outcome.tokens) {
        this.deps.notify(`已创建并登录：${outcome.user.username}`, 'ok');
        this.deps.onAuthenticated?.(outcome.user);
      } else {
        // admin-only：服务端刻意不返回令牌（拿到别人的会话是越权）
        this.deps.notify(`已创建账户「${outcome.user.username}」，请让对方自己登录`, 'ok');
        this.deps.onAuthenticated?.(null);
      }
      this.close();
    } catch (error) {
      this.showError(authErrorMessage(error));
      if (isNetworkFailure(error)) {
        // 网络问题值得额外指路；凭证问题**不能**加这类暗示（会被当成分支信息）
        this.hint.textContent = '连不上服务端：请确认服务端已启动、地址与端口正确（设置 → 服务端地址）。';
      }
      if (error instanceof AuthClientError && error.code === 'REGISTER_CLOSED') {
        // 策略可能刚被管理员改过：重新拉一次，把注册入口收起来
        this.policy = await this.deps.getPolicy();
        this.hint.textContent = registerHint(this.policy?.registerMode ?? null);
        this.registerButton.hidden = !shouldShowRegister(this.policy, this.deps.session.user);
      }
    } finally {
      this.setBusy(false);
    }
  }
}
