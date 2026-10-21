/**
 * 设置面板（T6.8）：服务端 URL / token / 测试连接。
 *
 * 契约约束：配置读写只走 C5（configGet / configSet / configPatch），
 * 落在应用配置目录（plugin-store），不由渲染层直接碰文件。
 *
 * 一个重要设计：**这个面板的任何失败都不阻断编辑**。
 * 它只影响"同步能力是否可用"，编辑 / 审计 / 导出与网络无关。
 */

import { configGet, configPatch, isShellAvailable } from '../contract';
import {
  isSyncReady,
  normalizeServerUrl,
  probeServer,
  type ProbeResult,
} from '../net/server-probe';

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

export interface SettingsCallbacks {
  /** 连接状态变化（用于顶栏指示与同步入口的启用/禁用） */
  onConnectionChange: (result: ProbeResult | null) => void;
  /** 保存成功（便于外部提示） */
  onSaved?: () => void;
}

export class SettingsDialog {
  private readonly overlay: HTMLDivElement;
  private readonly urlInput: HTMLInputElement;
  private readonly tokenInput: HTMLInputElement;
  private readonly probeStatus: HTMLParagraphElement;
  private readonly syncNote: HTMLParagraphElement;
  private readonly testButton: HTMLButtonElement;
  private readonly saveButton: HTMLButtonElement;
  private lastResult: ProbeResult | null = null;
  private busy = false;

  constructor(private readonly callbacks: SettingsCallbacks) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'settings-title');

    const panel = el('div', 'modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '设置');
    title.id = 'settings-title';
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    // ── 服务端 ──────────────────────────────────────────
    const serverSection = el('section', 'form-section');
    serverSection.append(el('h3', 'form-title', '服务端连接'));

    const urlField = el('label', 'field');
    urlField.append(el('span', 'field-label', '服务端地址'));
    this.urlInput = el('input', 'input');
    this.urlInput.type = 'text';
    this.urlInput.placeholder = 'http://127.0.0.1:8730';
    this.urlInput.spellcheck = false;
    this.urlInput.autocomplete = 'off';
    urlField.append(this.urlInput);
    urlField.append(
      el(
        'span',
        'field-hint',
        '支持本机、局域网 IP（如 192.168.1.20:8730）与域名；省略 http:// 会自动补全。',
      ),
    );

    const tokenField = el('label', 'field');
    tokenField.append(el('span', 'field-label', '访问令牌'));
    const tokenRow = el('div', 'field-row');
    this.tokenInput = el('input', 'input');
    this.tokenInput.type = 'password';
    this.tokenInput.placeholder = '服务端 config.json 里的 auth.token';
    this.tokenInput.spellcheck = false;
    this.tokenInput.autocomplete = 'off';
    const toggleToken = el('button', 'btn ghost small', '显示');
    toggleToken.type = 'button';
    toggleToken.addEventListener('click', () => {
      const hidden = this.tokenInput.type === 'password';
      this.tokenInput.type = hidden ? 'text' : 'password';
      toggleToken.textContent = hidden ? '隐藏' : '显示';
    });
    tokenRow.append(this.tokenInput, toggleToken);
    tokenField.append(tokenRow);

    const tokenHint = el(
      'span',
      'field-hint',
      '获取方式：node server/dist/index.js token show --config <配置路径>，或管理面板「API 与令牌」页。',
    );
    tokenField.append(tokenHint);

    serverSection.append(urlField, tokenField);

    // ── 测试连接 ────────────────────────────────────────
    const probeRow = el('div', 'probe-row');
    this.testButton = el('button', 'btn', '测试连接');
    this.testButton.type = 'button';
    this.testButton.addEventListener('click', () => void this.test());
    this.probeStatus = el('p', 'probe-status info', '尚未测试');
    probeRow.append(this.testButton);
    serverSection.append(probeRow, this.probeStatus);

    // ── 同步说明（明确降级边界）──────────────────────────
    this.syncNote = el('p', 'sync-note');
    serverSection.append(this.syncNote);

    // ── 底部按钮 ────────────────────────────────────────
    const foot = el('div', 'modal-foot');
    const browserWarn = el(
      'span',
      'foot-note',
      isShellAvailable() ? '' : '浏览器模式：配置不会持久化（请在桌面客户端内使用）',
    );
    this.saveButton = el('button', 'btn primary', '保存');
    this.saveButton.type = 'button';
    this.saveButton.addEventListener('click', () => void this.save());
    const cancel = el('button', 'btn', '关闭');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());
    foot.append(browserWarn, cancel, this.saveButton);

    panel.append(head, serverSection, foot);
    this.overlay.append(panel);

    // 点遮罩关闭
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    // Esc 关闭
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
    this.updateSyncNote();
  }

  /** 打开并载入已保存的配置 */
  async open(prefill?: { serverUrl?: string; token?: string }): Promise<void> {
    this.overlay.hidden = false;
    this.probeStatus.textContent = '尚未测试';
    this.probeStatus.className = 'probe-status info';

    if (prefill?.serverUrl !== undefined) this.urlInput.value = prefill.serverUrl;
    if (prefill?.token !== undefined) this.tokenInput.value = prefill.token;

    if (!isShellAvailable()) {
      // 浏览器模式：契约的 configGet 会失败，保留预填值（若有）让用户仍能测连接
      if (!this.urlInput.value) this.urlInput.value = 'http://127.0.0.1:8730';
      this.updateSyncNote();
      this.urlInput.focus();
      return;
    }

    try {
      const config = await configGet();
      if (prefill?.serverUrl === undefined) this.urlInput.value = config.serverUrl;
      if (prefill?.token === undefined) this.tokenInput.value = config.token;
    } catch (error) {
      this.setProbeStatus(`读取配置失败：${errorText(error)}`, 'bad');
    }
    this.updateSyncNote();
    this.urlInput.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /**
   * 触发一次真实探测（供调试/截图使用）。
   * 注意：这**不是**伪造状态——它执行与点「测试连接」完全相同的网络请求。
   */
  async runProbe(): Promise<ProbeResult | null> {
    await this.test();
    return this.lastResult;
  }

  /** 最近一次探测结果（可能为 null） */
  getLastResult(): ProbeResult | null {
    return this.lastResult;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.testButton.disabled = busy;
    this.saveButton.disabled = busy;
    this.testButton.textContent = busy ? '测试中…' : '测试连接';
  }

  private setProbeStatus(text: string, kind: 'ok' | 'warn' | 'bad' | 'info'): void {
    this.probeStatus.textContent = text;
    this.probeStatus.className = `probe-status ${kind}`;
  }

  private async test(): Promise<void> {
    if (this.busy) return;

    // 先在本地校验地址格式，省一次注定失败的请求
    const checked = normalizeServerUrl(this.urlInput.value);
    if (!checked.ok) {
      this.lastResult = null;
      this.setProbeStatus(checked.message, 'bad');
      this.callbacks.onConnectionChange(null);
      this.updateSyncNote();
      return;
    }

    this.setBusy(true);
    this.setProbeStatus('正在连接…', 'info');
    try {
      const result = await probeServer({
        serverUrl: this.urlInput.value,
        token: this.tokenInput.value,
      });
      this.lastResult = result;

      const ready = isSyncReady(result);
      const kind: 'ok' | 'warn' | 'bad' = ready ? 'ok' : result.reachable ? 'warn' : 'bad';
      const latency = result.latencyMs === null ? '' : `（${result.latencyMs} ms）`;
      this.setProbeStatus(`${result.message}${latency}`, kind);

      this.callbacks.onConnectionChange(result);
    } catch (error) {
      this.lastResult = null;
      this.setProbeStatus(`测试异常：${errorText(error)}`, 'bad');
      this.callbacks.onConnectionChange(null);
    } finally {
      this.setBusy(false);
      this.updateSyncNote();
    }
  }

  private async save(): Promise<void> {
    if (this.busy) return;

    const checked = normalizeServerUrl(this.urlInput.value);
    if (!checked.ok) {
      this.setProbeStatus(`无法保存：${checked.message}`, 'bad');
      return;
    }

    if (!isShellAvailable()) {
      this.setProbeStatus('浏览器模式：配置未持久化（请在桌面客户端内保存）', 'warn');
      return;
    }

    this.setBusy(true);
    try {
      const saved = await configPatch({
        serverUrl: checked.url,
        token: this.tokenInput.value.trim(),
      });
      // 回写归一化后的地址，让用户看到最终存储值
      this.urlInput.value = saved.serverUrl;
      this.setProbeStatus('已保存到应用配置目录', 'ok');
      this.callbacks.onSaved?.();
    } catch (error) {
      this.setProbeStatus(`保存失败：${errorText(error)}`, 'bad');
    } finally {
      this.setBusy(false);
      this.updateSyncNote();
    }
  }

  /** 动态说明"同步可用性"，把降级边界写清楚 */
  private updateSyncNote(): void {
    const result = this.lastResult;
    if (!result) {
      this.syncNote.textContent =
        '同步未启用或未测试：上传 / 历史版本 / 回滚将不可用。编辑、审计、导出不受影响。';
      this.syncNote.className = 'sync-note muted';
      return;
    }
    if (isSyncReady(result)) {
      this.syncNote.textContent = '同步已就绪：可使用上传 / 历史版本 / 回滚。';
      this.syncNote.className = 'sync-note ok';
      return;
    }
    if (!result.reachable) {
      this.syncNote.textContent =
        '无法连接服务端：同步功能不可用。编辑、审计、导出仍可正常使用。';
      this.syncNote.className = 'sync-note warn';
      return;
    }
    this.syncNote.textContent =
      '已连接但鉴权未通过：同步功能不可用。编辑、审计、导出仍可正常使用。';
    this.syncNote.className = 'sync-note warn';
  }
}

function errorText(error: unknown): string {
  const maybe = error as { code?: string; message?: string };
  if (typeof maybe?.code === 'string') {
    return `[${maybe.code}] ${maybe.message ?? ''}`;
  }
  return error instanceof Error ? error.message : String(error);
}
