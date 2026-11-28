/**
 * 账户表单弹窗（2026-11-27）。
 *
 * 功能：用同一个模态框收「当前密码 + 新值 + 确认」这类输入，提交时把服务端
 *   的拒绝原因显示在框内，而不是关掉弹窗再去顶栏弹一条提示。
 * 注意事项：一次只服务一个动作（改名 / 改密码各建一个实例）；关闭即丢弃输入，
 *   不要复用它做多步向导。
 * 踩过的坑：上一版用 window.prompt 串行问三个问题，当前密码错也要等新密码
 *   和确认都输完才报错，而且浏览器弹窗没有掩码开关，用户看不到自己输了什么。
 */

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

export interface AccountFormFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'password';
  value?: string;
  placeholder?: string;
  autocomplete?: string;
  minLength?: number;
  hint?: string;
  /**
   * 必须与哪个字段逐字符相同（新密码的「再输一次」用）。
   * 填了这个键的输入框在失焦时才比较，不打断输入。
   */
  confirmOf?: string;
}

export interface AccountFormSubmitFailure {
  ok: false;
  message: string;
  /** 把错误挂到某个字段下面；缺省挂到表单底部 */
  field?: string;
}

export type AccountFormSubmitResult = { ok: true } | AccountFormSubmitFailure;

export interface AccountFormOptions {
  title: string;
  description?: string;
  fields: AccountFormFieldSpec[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<AccountFormSubmitResult>;
}

export class AccountFormModal {
  private readonly overlay: HTMLDivElement;
  private readonly inputs = new Map<string, HTMLInputElement>();
  private readonly fieldErrors = new Map<string, HTMLElement>();
  private readonly formError: HTMLElement;
  private readonly submitButton: HTMLButtonElement;
  private busy = false;

  constructor(private readonly options: AccountFormOptions) {
    this.overlay = el('div', 'modal-overlay modal-overlay-top');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'account-form-dialog';

    const panel = el('div', 'modal account-form-modal');
    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', options.title));
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.close());
    head.append(close);

    const body = el('div', 'modal-body');
    if (options.description !== undefined && options.description !== '') {
      body.append(el('p', 'account-form-desc', options.description));
    }

    for (const spec of options.fields) {
      const field = el('label', 'field');
      field.append(el('span', 'field-label', spec.label));
      const row = el('span', 'field-row');
      const input = el('input', 'input') as HTMLInputElement;
      input.type = spec.type;
      input.value = spec.value ?? '';
      if (spec.placeholder !== undefined) input.placeholder = spec.placeholder;
      if (spec.autocomplete !== undefined) input.setAttribute('autocomplete', spec.autocomplete);
      input.dataset['field'] = spec.key;
      row.append(input);
      this.inputs.set(spec.key, input);

      /*
       * 密码框的明文开关。按钮放在输入框右侧，用 aria-pressed 表明当前状态；
       * 只切 type，不动 value（部分浏览器重设 type 会清空光标位置，但不清值）。
       */
      if (spec.type === 'password') {
        const reveal = el('button', 'btn small ghost account-form-reveal', '显示');
        reveal.type = 'button';
        reveal.setAttribute('aria-pressed', 'false');
        reveal.addEventListener('click', () => {
          const shown = input.type === 'text';
          input.type = shown ? 'password' : 'text';
          reveal.textContent = shown ? '显示' : '隐藏';
          reveal.setAttribute('aria-pressed', shown ? 'false' : 'true');
        });
        row.append(reveal);
      }
      field.append(row);

      if (spec.hint !== undefined && spec.hint !== '') {
        field.append(el('span', 'field-hint', spec.hint));
      }
      if (spec.confirmOf !== undefined) {
        input.addEventListener('blur', () => this.checkConfirm(spec));
      }
      const error = el('span', 'field-hint bad account-form-field-error');
      error.hidden = true;
      field.append(error);
      this.fieldErrors.set(spec.key, error);
      body.append(field);
    }

    this.formError = el('p', 'account-form-error');
    this.formError.hidden = true;
    this.formError.setAttribute('role', 'alert');
    body.append(this.formError);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());
    this.submitButton = el('button', 'btn primary', options.submitLabel) as HTMLButtonElement;
    this.submitButton.type = 'button';
    this.submitButton.addEventListener('click', () => void this.submit());
    foot.append(cancel, this.submitButton);

    panel.append(head, body, foot);
    this.overlay.append(panel);
    document.body.append(this.overlay);

    document.addEventListener('keydown', this.handleKeyDown);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.overlay.hidden) return;
    if (event.key === 'Escape') this.close();
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      void this.submit();
    }
  };

  open(): void {
    this.overlay.hidden = false;
    const first = this.options.fields[0];
    if (first !== undefined) this.inputs.get(first.key)?.focus();
  }

  close(): void {
    if (this.busy) return;
    this.overlay.hidden = true;
    this.overlay.remove();
    /*
     * 监听挂在 document 上：不摘掉的话，每开一次弹窗就永久多一个监听器，
     * 而且它还握着已移除的 DOM。
     */
    document.removeEventListener('keydown', this.handleKeyDown);
  }

  private clearMessages(): void {
    this.formError.hidden = true;
    this.formError.textContent = '';
    for (const node of this.fieldErrors.values()) {
      node.hidden = true;
      node.textContent = '';
    }
  }

  private showFormError(message: string): void {
    this.formError.textContent = message;
    this.formError.hidden = false;
  }

  private checkConfirm(spec: AccountFormFieldSpec): boolean {
    if (spec.confirmOf === undefined) return true;
    const input = this.inputs.get(spec.key);
    const target = this.inputs.get(spec.confirmOf);
    if (!input || !target) return true;
    const error = this.fieldErrors.get(spec.key);
    if (input.value !== target.value) {
      if (error) {
        error.textContent = '两次输入不一致';
        error.hidden = false;
      }
      return false;
    }
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
    return true;
  }

  private validate(): boolean {
    this.clearMessages();
    let ok = true;
    let firstInvalid: HTMLInputElement | null = null;
    for (const spec of this.options.fields) {
      const input = this.inputs.get(spec.key);
      if (!input) continue;
      const error = this.fieldErrors.get(spec.key);
      if (input.value.trim() === '') {
        if (error) {
          error.textContent = '请填写这一项';
          error.hidden = false;
        }
        ok = false;
        firstInvalid ??= input;
        continue;
      }
      if (spec.minLength !== undefined && input.value.length < spec.minLength) {
        if (error) {
          error.textContent = `至少 ${String(spec.minLength)} 个字符`;
          error.hidden = false;
        }
        ok = false;
        firstInvalid ??= input;
        continue;
      }
      if (!this.checkConfirm(spec)) {
        ok = false;
        firstInvalid ??= input;
      }
    }
    firstInvalid?.focus();
    return ok;
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (!this.validate()) return;

    const values: Record<string, string> = {};
    for (const [key, input] of this.inputs) values[key] = input.value;

    this.busy = true;
    this.submitButton.disabled = true;
    try {
      const result = await this.options.onSubmit(values);
      if (result.ok) {
        this.busy = false;
        this.close();
        return;
      }
      const fieldError = result.field !== undefined ? this.fieldErrors.get(result.field) : undefined;
      if (fieldError) {
        fieldError.textContent = result.message;
        fieldError.hidden = false;
      } else {
        this.showFormError(result.message);
      }
    } catch (error) {
      this.showFormError(error instanceof Error ? error.message : '操作失败（原因未知）');
    } finally {
      this.busy = false;
      this.submitButton.disabled = false;
    }
  }
}
