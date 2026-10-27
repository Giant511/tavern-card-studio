/**
 * 「另存为」的格式选择对话框（v0.1.5 / G6）。
 *
 * 为什么不用「导出」那个面板：那个面板还要管子集的东西（审计闸门、卡面选择、
 * 导出回执），放在"另存为"里会让人以为保存也要过审计。这里只要一件事 ——
 * **选哪种格式**，选完立刻进系统保存对话框。
 *
 * 唯一从导出面板借用的概念是"卡面"：PNG 必须有封面。但这里**不提供图库选择**，
 * 只用会话已有的原图或内置默认卡面（见 App 侧 `saveAs` 的解析顺序）——
 * 想挑封面就去「导出」，那是它的职责。
 */

import { SAVE_FORMATS, type SaveFormat } from './save-format';

/** 各对话框文件都有一份同形的 `el`（沿用项目既有约定，不额外抽公共层） */
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

export interface SaveFormatDialogResult {
  format: SaveFormat;
  /** 用户勾了"以后都用这个格式"（记住到会话，下次不再问） */
  remember: boolean;
}

export class SaveFormatDialog {
  /**
   * 打开并等待选择。
   *
   * `defaultFormat` = 会话当前的格式（另存为 PNG 的卡再另存，默认还是 PNG）。
   * `pngAvailable` 为 false 时禁用 PNG 并说明原因 —— 比让用户选完再报错好：
   * 那一刻他已经填好文件名了，失败会显得"保存坏了"。
   */
  open(options: {
    defaultFormat: SaveFormat;
    pngAvailable: boolean;
    pngUnavailableReason?: string;
  }): Promise<SaveFormatDialogResult | null> {
    return new Promise((resolve) => {
      const overlay = el('div', 'modal-overlay');
      const panel = el('div', 'modal save-format-modal');
      const head = el('div', 'modal-head');
      head.append(el('h2', 'modal-title', '另存为'));

      const body = el('div', 'modal-body');
      body.append(el('p', 'confirm-text', '选择保存格式。三种格式的产物与「导出」完全一致。'));

      const list = el('div', 'save-format-list');
      let selected: SaveFormat = options.defaultFormat;

      const buttons = new Map<SaveFormat, HTMLButtonElement>();
      for (const option of SAVE_FORMATS) {
        const button = el('button', 'save-format-option');
        button.type = 'button';
        button.dataset['format'] = option.format;
        button.append(
          el('span', 'save-format-name', option.label),
          el('span', 'save-format-desc', option.description),
        );
        if (option.format === 'png' && !options.pngAvailable) {
          button.disabled = true;
          button.dataset['disabledReason'] = options.pngUnavailableReason ?? '当前不可用';
          button.append(
            el('span', 'save-format-blocked', options.pngUnavailableReason ?? '当前不可用'),
          );
        }
        button.addEventListener('click', () => {
          selected = option.format;
          syncSelection();
        });
        buttons.set(option.format, button);
        list.append(button);
      }
      body.append(list);

      const rememberRow = el('label', 'save-format-remember');
      const rememberBox = el('input') as HTMLInputElement;
      rememberBox.type = 'checkbox';
      rememberBox.dataset['role'] = 'save-format-remember';
      rememberRow.append(rememberBox, el('span', '', '以后都用这个格式保存（不再询问）'));
      body.append(rememberRow);

      const foot = el('div', 'modal-foot');
      const cancel = el('button', 'btn', '取消');
      cancel.type = 'button';
      const confirm = el('button', 'btn primary', '继续…');
      confirm.type = 'button';
      foot.append(cancel, confirm);

      panel.append(head, body, foot);
      overlay.append(panel);
      document.body.append(overlay);

      const syncSelection = (): void => {
        for (const [format, button] of buttons) {
          button.classList.toggle('is-active', format === selected);
        }
        confirm.textContent = `保存为 ${SAVE_FORMATS.find((item) => item.format === selected)?.label ?? ''}…`;
      };

      // 默认格式若不可用（如浏览器里 PNG 不可用），退回第一个可用项
      if (selected === 'png' && !options.pngAvailable) selected = 'json';
      syncSelection();

      const finish = (value: SaveFormatDialogResult | null): void => {
        overlay.remove();
        resolve(value);
      };
      cancel.addEventListener('click', () => finish(null));
      confirm.addEventListener('click', () => finish({ format: selected, remember: rememberBox.checked }));
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish(null);
      });
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape' && overlay.isConnected) {
            event.preventDefault();
            finish(null);
          }
        },
        { once: true },
      );
      confirm.focus();
    });
  }
}
