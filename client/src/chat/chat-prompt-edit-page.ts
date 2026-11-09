/**
 * 「提示词编辑」页（2026-11-07）。
 *
 * ## 用户的要求
 *
 * > AI响应中提示词管理中增加自定义编辑和增加提示词的功能，和原生ST一样。
 *
 * ## 与 ST 原生编辑框的对应
 *
 * ST 是一个弹窗，六七个字段横排三列。手机屏上塞不下，所以这里改成
 * **整页纵向表单**（与 `persona-page` / `greeting-page` 同一套骨架）：
 *
 * | 字段 | ST | 这里 | 说明 |
 * |---|---|---|---|
 * | 姓名 | 有 | 有 | 列表里显示的名字 |
 * | 身份 | 三选一 | 三选一 | system / user / assistant |
 * | 位置 | 两选一 | 两选一 | 跟随顺序 / 按深度插入 |
 * | 深度 | 有 | 有（仅"按深度插入"时可用） | 插到倒数第几条之前 |
 * | 排序 | 有 | 有 | 同深度内的次序 |
 * | 提示词 | 大文本框 | 大文本框 | 正文 |
 * | 触发器 | 多选 | **只读展示** | 见下 |
 *
 * ## ★ 为什么"触发器"不做成可编辑
 *
 * ST 的 `injection_trigger` 是"只在某种生成类型时发这条"（续写 / 重roll /
 * 扮演…），空数组 = 全部类型。
 *
 * 我们的 App 目前只走 `normal` 这一种生成。如果做成可编辑，用户把它设成
 * 「仅续写」之后，正常聊天里这条**永远不发**，而开关看着是开的 ——
 * 那就是本项目最忌讳的"设了不生效、还不报错"。
 *
 * 所以：**读出来给他看，写回时原样保留**（`prompt-edit.ts` 的 spread），
 * 但不提供修改入口。等生成类型真的支持多种了再打开。
 */

import type { DocLike, ElLike } from './chat-view.js';
import { makeSelectTrigger } from './select-popover.js';
import type { PromptDraft, PromptRole } from '@tcs/shared';

/** 编辑页要编辑的东西 */
export interface PromptEditTarget {
  /** `null` = 新建 */
  readonly identifier: string | null;
  /** 新建时的初值 / 编辑时的当前值 */
  readonly draft: PromptDraft;
  /** 内置槽位：正文内容来自卡片/世界书，改它通常没用 */
  readonly marker: boolean;
  /** 只读展示的触发器（空 = 全部类型） */
  readonly triggers: readonly string[];
}

export interface ChatPromptEditCallbacks {
  onBack: () => void;
  /** 保存。返回 `ok` 决定是否退出这一页 */
  onSave: (draft: PromptDraft) => Promise<{ ok: boolean; reason?: string }>;
  /** 删除（仅编辑已有 + 非内置槽位时提供） */
  onDelete?: () => Promise<{ ok: boolean; reason?: string }>;
  onNotify?: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

function el(doc: DocLike, tag: string, className?: string): ElLike {
  const node = doc.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  return node;
}

/**
 * 一行字段：标签 + 控件 + 说明。
 *
 * ★ `ElLike` **没有 `insertBefore`**（接口刻意精简，见 chat-view.ts）。
 *   所以不能"先 append 标签和说明、再往中间插控件" —— 必须按顺序 append。
 *   这个函数只建好行与说明，控件由调用方 `mount()` 到中间。
 */
interface FieldBits {
  readonly row: ElLike;
  readonly hint: ElLike;
  /** 把控件放到标签之后、说明之前 */
  readonly mount: (control: ElLike) => void;
}

function field(doc: DocLike, labelText: string, role: string, hintText = ''): FieldBits {
  const row = el(doc, 'div', 'nb-field');
  row.setAttribute('data-role', role);
  const label = el(doc, 'span', 'nb-field-label');
  label.textContent = labelText;
  const hint = el(doc, 'span', 'nb-field-hint');
  if (hintText !== '') hint.textContent = hintText;
  row.append(label);
  let mounted = false;
  const mount = (control: ElLike): void => {
    row.append(control);
    if (!mounted) {
      mounted = true;
      row.append(hint);
    }
  };
  return { row, hint, mount };
}

/**
 * 渲染「提示词编辑」页。
 *
 * 参数全部由外壳准备好（它已经读过预设、解析出当前值）——
 * 这一页**不碰网络**，只负责收集用户的输入。
 * 这样"保存失败"的处理只有一处（外壳），不会两处各写一遍。
 */
export function renderChatPromptEditPage(
  doc: DocLike,
  target: PromptEditTarget,
  callbacks: ChatPromptEditCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-prompt-edit');
  root.setAttribute('data-role', 'chat-prompt-edit-page');

  /* ── 顶栏 ── */
  const topbar = el(doc, 'div', 'nb-topbar');
  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'prompt-edit-back');
  back.setAttribute('aria-label', '返回');
  back.textContent = '‹';
  back.addEventListener('click', () => callbacks.onBack());

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = target.identifier === null ? '新建提示词' : '编辑提示词';
  topbar.append(back, title);
  root.append(topbar);

  const body = el(doc, 'div', 'nb-list');
  body.setAttribute('data-role', 'prompt-edit-body');
  root.append(body);

  /* 内置槽位的提醒：改正文基本没用，得说清为什么 */
  if (target.marker) {
    const note = el(doc, 'div', 'nb-prompt-edit-note');
    note.setAttribute('data-role', 'prompt-edit-marker-note');
    note.textContent =
      '这是内置槽位：正文在发送时会被「角色卡 / 世界书 / 对话记录」的真实内容替换，改这里通常不会生效。';
    body.append(note);
  }

  /* ── 姓名 ── */
  const nameBits = field(doc, '姓名', 'prompt-field-name', '这条提示词在你列表里显示的名字。');
  const nameInput = el(doc, 'input', 'nb-input');
  nameInput.setAttribute('type', 'text');
  nameInput.setAttribute('data-role', 'prompt-field-name-input');
  nameInput.setAttribute('placeholder', '例如：消息回复规则');
  (nameInput as unknown as HTMLInputElement).value = target.draft.name;
  nameBits.mount(nameInput);
  body.append(nameBits.row);

  /* ── 身份（角色） ── */
  const roleBits = field(doc, '身份', 'prompt-field-role', '这条消息以谁的口吻发出去。');
  let role: PromptRole = target.draft.role;
  const roleTrigger = makeSelectTrigger(doc, {
    label: '身份',
    options: [
      { value: 'system', label: '系统' },
      { value: 'user', label: '用户' },
      { value: 'assistant', label: '助手' },
    ],
    current: role,
    onPick: (picked) => {
      role = picked === 'user' || picked === 'assistant' ? picked : 'system';
    },
  });
  roleTrigger.el.setAttribute('data-role', 'prompt-field-role-select');
  roleBits.mount(roleTrigger.el);
  body.append(roleBits.row);

  /* ── 位置 ── */
  const posBits = field(doc, '位置', 'prompt-field-position', '相对其他提示词的位置，还是按深度插进聊天记录。');
  /*
   * `0` = 跟随顺序（ST 的 RELATIVE），`1` = 按深度插入（ABSOLUTE）。
   * 属性值永远是字符串，所以这里存字符串、提交时转数字。
   */
  let position = String(target.draft.injectionPosition);
  const posTrigger = makeSelectTrigger(doc, {
    label: '位置',
    options: [
      { value: '0', label: '跟随顺序（默认）' },
      { value: '1', label: '按深度插入聊天记录' },
    ],
    current: position,
    onPick: (picked) => {
      position = picked === '1' ? '1' : '0';
      syncDepthState();
    },
  });
  posTrigger.el.setAttribute('data-role', 'prompt-field-position-select');
  posBits.mount(posTrigger.el);
  body.append(posBits.row);

  /* ── 深度 ── */
  const depthBits = field(doc, '深度', 'prompt-field-depth', '0 = 在最后一条消息之后，1 = 在最后一条消息之前，依次往前。');
  const depthInput = el(doc, 'input', 'nb-input');
  depthInput.setAttribute('type', 'number');
  depthInput.setAttribute('inputmode', 'numeric');
  depthInput.setAttribute('min', '0');
  depthInput.setAttribute('data-role', 'prompt-field-depth-input');
  (depthInput as unknown as HTMLInputElement).value = String(target.draft.injectionDepth);
  depthBits.mount(depthInput);
  body.append(depthBits.row);

  /*
   * 深度只在"按深度插入"时有意义。
   *
   * 置灰而不是隐藏：隐藏会让表单高度跳一下，用户以为点错了。
   * 置灰 + 说明「只在按深度插入时用到」，一眼就懂。
   */
  const syncDepthState = (): void => {
    const active = position === '1';
    depthInput.setAttribute('data-disabled', String(!active));
    if (active) depthInput.removeAttribute('disabled');
    else depthInput.setAttribute('disabled', 'true');
    depthBits.row.setAttribute('data-disabled', String(!active));
  };
  syncDepthState();

  /* ── 排序 ── */
  const orderBits = field(doc, '排序', 'prompt-field-order', '同一深度内的次序，小的先发（ST 默认 100）。');
  const orderInput = el(doc, 'input', 'nb-input');
  orderInput.setAttribute('type', 'number');
  orderInput.setAttribute('inputmode', 'numeric');
  orderInput.setAttribute('data-role', 'prompt-field-order-input');
  (orderInput as unknown as HTMLInputElement).value = String(target.draft.injectionOrder);
  orderBits.mount(orderInput);
  body.append(orderBits.row);

  /* ── 触发器（只读） ── */
  const trigBits = field(doc, '触发器', 'prompt-field-trigger');
  const trigText = el(doc, 'span', 'nb-prompt-trigger-text');
  trigText.setAttribute('data-role', 'prompt-field-trigger-text');
  trigText.textContent =
    target.triggers.length === 0 ? '所有类型（默认）' : target.triggers.join('、');
  trigBits.mount(trigText);
  trigBits.hint.textContent =
    target.triggers.length === 0
      ? '这里不可改：本 App 只做普通生成，改成"仅续写"之类会变成开着却不发。'
      : '⚠️ 这条被限定为只在特定生成类型发；本 App 只做普通生成，所以它可能一直不发。';
  body.append(trigBits.row);

  /* ── 正文 ── */
  const contentBits = field(doc, '提示词', 'prompt-field-content');
  const contentInput = el(doc, 'textarea', 'nb-input nb-input--multiline nb-prompt-content');
  contentInput.setAttribute('data-role', 'prompt-field-content-input');
  contentInput.setAttribute('rows', '12');
  (contentInput as unknown as HTMLTextAreaElement).value = target.draft.content;
  contentBits.mount(contentInput);
  contentBits.hint.textContent = '这条会原样插进请求。支持 {{char}} / {{user}} 这类占位符。';
  body.append(contentBits.row);

  /* ── 操作区 ── */
  const actions = el(doc, 'div', 'nb-prompt-edit-actions');

  const save = el(doc, 'button', 'nb-btn nb-btn--primary');
  save.setAttribute('type', 'button');
  save.setAttribute('data-role', 'prompt-edit-save');
  save.textContent = '保存';
  actions.append(save);

  /*
   * 删除按钮只在"编辑已有 + 非内置槽位"时出现。
   *
   * 不给就要回 ST 删 —— 那和在 App 里能管提示词这个前提矛盾。
   */
  if (target.identifier !== null && !target.marker && callbacks.onDelete !== undefined) {
    const del = el(doc, 'button', 'nb-btn nb-btn--danger');
    del.setAttribute('type', 'button');
    del.setAttribute('data-role', 'prompt-edit-delete');
    del.textContent = '删除这条';

    /** 把按钮还原成"未确认"状态（删除失败时要退回去，否则用户会连点） */
    const resetConfirm = (): void => {
      del.setAttribute('data-confirm', 'false');
      del.textContent = '删除这条';
    };

    del.addEventListener('click', () => {
      if (del.getAttribute('data-confirm') !== 'true') {
        /*
         * 两段式确认：第一次点只是"把按钮变成确认"，第二次才真删。
         *
         * 不用系统 confirm —— 本项目的弹窗是自己画的，用系统弹窗会
         * 在部分机型上被 WebView 拦掉（表现为点了没反应）。
         */
        del.setAttribute('data-confirm', 'true');
        del.textContent = '再点一次确认删除';
        return;
      }
      del.setAttribute('data-busy', 'true');
      void callbacks.onDelete?.().then((result) => {
        del.setAttribute('data-busy', 'false');
        if (result.ok) return;
        resetConfirm();
        callbacks.onNotify?.(result.reason ?? '删除失败，请重试。', 'danger');
      });
    });
    actions.append(del);
  }

  body.append(actions);

  /* ── 保存 ── */
  save.addEventListener('click', () => {
    const draft: PromptDraft = {
      name: ((nameInput as unknown as HTMLInputElement).value ?? '').trim(),
      content: (contentInput as unknown as HTMLTextAreaElement).value ?? '',
      role,
      injectionPosition: position === '1' ? 1 : 0,
      injectionDepth: Number((depthInput as unknown as HTMLInputElement).value ?? '0'),
      injectionOrder: Number((orderInput as unknown as HTMLInputElement).value ?? '100'),
    };
    save.setAttribute('data-busy', 'true');
    void callbacks.onSave(draft).then((result) => {
      save.setAttribute('data-busy', 'false');
      if (result.ok) return;
      /*
       * 失败**不退出这一页**，也不清空输入 ——
       * 用户刚写的那一大段正文要是丢了，比"没保存成功"严重得多。
       */
      callbacks.onNotify?.(result.reason ?? '没保存成功，请重试。', 'danger');
    });
  });

  return root;
}
