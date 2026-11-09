/**
 * 气泡点按操作菜单：编辑 / 复制 / 删除（2026-11-02 用户要求）。
 *
 * > 聊天界面可以点击任意气泡修改文本或者一键复制或者删除消息，
 * > 并且修改后可以以上下文的形式在下一条回复中
 *
 * ## 为什么点气泡弹菜单，而不是长按
 *
 * 长按已经被"选中文字复制"占用了（用户明确要聊天记录可选中）。
 * 两种手势叠在一个动作上，用户永远不知道自己会得到哪一个。
 * 点一下弹菜单，长按选中文字 —— 互不抢。
 *
 * ## 为什么菜单是"底部三键"而不是浮动气泡菜单
 *
 * 浮动菜单要算位置（气泡可能在屏幕上沿、也可能在下沿），
 * 算错就跑到屏幕外。底部固定三键与键盘/输入区同侧，
 * 手指够得着，也不遮挡被操作的那条消息。
 *
 * ## 为什么用 sheet（半屏）而不是 window.confirm
 *
 * `confirm()` / `prompt()` 在 Android WebView 里**阻塞主线程** ——
 * 流式输出期间弹一个会让打字机直接停住（memory 里记过这条）。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

/** 菜单中的一个动作 */
export interface BubbleAction {
  /** 稳定标识，方便判据钉住（`edit` / `copy` / `delete`） */
  id: 'edit' | 'copy' | 'delete';
  label: string;
  /** 危险动作用红色（删除） */
  danger?: boolean;
  /** 被点中时调用。返回 `false` 表示"不关闭菜单"（比如复制失败要留着） */
  run: () => void | boolean | Promise<void | boolean>;
}

export interface BubbleMenuOptions {
  /** 消息正文（编辑时作为初始值、复制时作为内容） */
  text: string;
  /** 是否允许编辑（系统/占位消息不允许） */
  editable: boolean;
  /** 编辑保存 */
  onSaveEdit: (next: string) => void | Promise<void>;
  /** 复制成功后回调（用来弹提示） */
  onCopied?: () => void;
  /** 删除 */
  onDelete: () => void | Promise<void>;
  /**
   * 复制实现。**由调用方注入**，因为"怎么复制"随环境不同：
   * Tauri / 普通 WebView / 测试 stub 各不一样，写死一种必然在另一种上失效。
   */
  writeClipboard: (text: string) => Promise<boolean>;
  /** 关掉时回调（调用方用来清理引用） */
  onClose?: () => void;
}

export interface BubbleMenuHandle {
  /** 直接关掉（切换聊天、卸载面板时用） */
  close: () => void;
  /** 当前是否打开 */
  isOpen: () => boolean;
}

/**
 * 打开气泡操作菜单。
 *
 * 返回句柄而不是 void：调用方要在 `dispose()` 里关掉它，
 * 否则切 Tab 之后菜单还浮在上面（"僵尸面板"，memory §72 踩过）。
 */
export function openBubbleMenu(
  doc: DocLike,
  options: BubbleMenuOptions,
): BubbleMenuHandle {
  let open = true;

  const root = el(doc, 'div', 'nb-sheet-mask');
  root.setAttribute('data-role', 'bubble-menu-mask');

  const sheet = el(doc, 'div', 'nb-sheet');
  sheet.setAttribute('data-role', 'bubble-menu');
  sheet.setAttribute('role', 'dialog');

  const close = (): void => {
    if (!open) return;
    open = false;
    root.remove();
    options.onClose?.();
  };

  /* 点遮罩关掉。`pointerdown` 而不是 `click`：手指按下就响应，更跟手 */
  root.addEventListener?.('pointerdown', (event) => {
    /* 只有点在遮罩本身（不是 sheet 内部）才关 */
    if ((event as { target?: unknown }).target === (root as unknown as object)) close();
  });

  /* ── 标题区：显示被操作的那条（截断，避免撑爆） ── */
  const header = el(doc, 'div', 'nb-sheet-title');
  header.textContent = '这条消息';
  sheet.append(header);

  const preview = el(doc, 'div', 'nb-sheet-preview');
  preview.setAttribute('data-role', 'bubble-menu-preview');
  preview.textContent = options.text.length > 80 ? `${options.text.slice(0, 80)}…` : options.text;
  sheet.append(preview);

  /* ── 编辑区（默认隐藏，点"编辑"才展开） ── */
  const editor = el(doc, 'div', 'nb-sheet-editor');
  editor.setAttribute('data-role', 'bubble-menu-editor');
  editor.setAttribute('hidden', 'true');

  /*
   * 造 textarea 并**立刻**收窄成"既能当 ElLike 用、又有 value/focus"的交叉类型。
   *
   * `ElLike` 是渲染层自己定义的宽接口，不含 `value`；直接
   * `as unknown as HTMLTextAreaElement` 之后就没法再传给 `append`
   * （类型不兼容）—— 所以用交叉类型，两种用法都保留。
   */
  const textarea = el(doc, 'textarea', 'nb-input nb-sheet-textarea') as unknown as ElLike & {
    value: string;
    focus?: () => void;
  };
  textarea.setAttribute('rows', '4');
  textarea.setAttribute('data-role', 'bubble-edit-input');
  textarea.setAttribute('aria-label', '编辑这条消息');
  textarea.value = options.text;
  editor.append(textarea);

  const saveBtn = el(doc, 'button', 'nb-sheet-action nb-sheet-action--primary');
  saveBtn.setAttribute('type', 'button');
  saveBtn.setAttribute('data-role', 'bubble-edit-save');
  saveBtn.textContent = '保存';
  saveBtn.addEventListener?.('click', () => {
    void (async () => {
      const next = String(textarea.value ?? '').trim();
      if (next === '') {
        /*
         * 空文本不保存 —— 想清空应该用"删除"。
         * 静默不保存会让用户以为点了没反应，所以改提示文案。
         */
        preview.textContent = '内容不能为空。想删除这条请用「删除」。';
        return;
      }
      await options.onSaveEdit(next);
      close();
    })();
  });
  editor.append(saveBtn);
  sheet.append(editor);

  /* ── 三个动作 ── */
  const actions: BubbleAction[] = [
    {
      id: 'edit',
      label: '编辑',
      run: () => {
        /*
         * `ElLike` 没有 `removeAttribute`（渲染层的窄接口）。
         * 用 `hidden='false'` 而不是删属性：`hidden` 是布尔属性，
         * **任何值**（包括 "false"）都表示隐藏 —— 只有删掉才显示。
         * 所以这里改 `setAttribute('hidden','')` 的反面无从表达，
         * 换成 CSS 类切换，两边都清爽。
         */
        editor.setAttribute('data-open', 'true');
        editor.className = 'nb-sheet-editor nb-sheet-editor--open';
        preview.setAttribute('hidden', 'true');
        textarea.focus?.();
        /* 编辑态下不需要"编辑"自己了 */
        editBtn.setAttribute('hidden', 'true');
        return false;
      },
    },
    {
      id: 'copy',
      label: '复制',
      run: () => {
        void (async () => {
          const ok = await options.writeClipboard(options.text);
          if (ok) {
            options.onCopied?.();
            close();
          } else {
            /* 复制失败要说清，否则用户以为复制到了 */
            preview.textContent = '复制失败：系统不允许访问剪贴板。可以长按消息手动选中复制。';
            preview.setAttribute('data-open', 'true');
          }
        })();
        /* 异步结果决定要不要关，先不关 */
        return false;
      },
    },
    {
      id: 'delete',
      label: '删除',
      danger: true,
      run: () => {
        void (async () => {
          await options.onDelete();
          close();
        })();
        return false;
      },
    },
  ];

  const list = el(doc, 'div', 'nb-sheet-actions');
  let editBtn: ElLike = list;
  for (const action of actions) {
    const btn = el(doc, 'button', 'nb-sheet-action');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-role', `bubble-${action.id}`);
    if (action.danger === true) btn.setAttribute('data-danger', 'true');
    btn.textContent = action.label;
    if (action.id === 'edit') editBtn = btn;
    btn.addEventListener?.('click', () => {
      const keep = action.run();
      /* 同步返回 `false` 表示保持打开；其余（含 undefined）都关 */
      if (keep !== false) close();
    });
    list.append(btn);
  }

  /* 编辑未保存时不允许编辑（占位/系统消息） */
  if (!options.editable) {
    editBtn.setAttribute('hidden', 'true');
  }

  const cancel = el(doc, 'button', 'nb-sheet-action nb-sheet-cancel');
  cancel.setAttribute('type', 'button');
  cancel.setAttribute('data-role', 'bubble-cancel');
  cancel.textContent = '取消';
  cancel.addEventListener?.('click', () => close());
  list.append(cancel);

  sheet.append(list);
  root.append(sheet);
  /*
   * `DocLike` 没有声明 `body`（渲染层只暴露 createElement）。
   * 但这里是移动壳自己的调用点，`doc` 一定是真 `document` ——
   * 用一次断言比给 `DocLike` 加一个只有这里用的成员更干净
   * （加成员会让所有单测 stub 都要跟着补）。
   */
  const host = (doc as unknown as { body?: { append?: (n: unknown) => void } }).body;
  if (host?.append !== undefined) {
    host.append(root);
  } else {
    /* 极端兜底：挂到 documentElement，至少不会整个菜单消失 */
    (doc as unknown as { documentElement?: { append?: (n: unknown) => void } })
      .documentElement?.append?.(root);
  }

  return {
    close,
    isOpen: () => open,
  };
}
