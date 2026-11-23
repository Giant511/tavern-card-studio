/**
 * 角色级记忆的编辑界面（2026-11-22，v0.2.2）。
 *
 * ## 设计的核心是一条：点一次就能改
 *
 * 用户原话：
 *
 * > 世界书虽然可以编辑但是每次聊天都多点几步进去很不方便……这个主打的就是
 * > 随手可改，只需要点一次就可以打开界面更改
 *
 * 所以这里是**从聊天页直接弹出的底部面板**，不是"设置 → 某一级 → 再某一级"。
 * 每条记忆就是一个可直接输入的 textarea，改完点保存，没有中间的"编辑"动作。
 *
 * ## 为什么每条一个 textarea，而不是列表 + 点开编辑
 *
 * "列表 + 点开"会让改一个字变成两次点击。总字符上限只有 3000，
 * 条目数通常十几条以内，textarea 数量可控。
 *
 * ## 超限时的行为（用户明令）
 *
 * > 如果预填之后超出 3000 需要实时提醒用户并且不让用户保存，
 * > 需改到安全字符数量以下才可保存
 *
 * 所以保存按钮在超限时置灰，并显示"超出 N 字符"。按钮的点击处理里
 * **也再检查一次** —— `disabled` 在某些 WebView 上对 `addEventListener`
 * 不生效（属性存在但事件照收），只靠置灰是不可靠的。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import {
  MEMORY_MAX_CHARS,
  type MemoryBudgetView,
  type MemoryEntry,
  isEntryStorable,
  memoryBudgetView,
  nextEntryId,
  usedChars,
  withinLimit,
} from '../../../shared/dist/index.js';

/** 一条正在编辑的条目（id 稳定的同时允许文本为空 —— 空的新条目要被丢掉） */
interface DraftEntry {
  id: string;
  text: string;
  at: number;
}

export interface MemoryPageOptions {
  doc: DocLike;
  /** 当前角色 avatar 文件名。为空时不能保存 */
  avatar: string;
  /** 显示用的角色名（avatar 去掉扩展名，或卡里的 name） */
  characterName: string;
  /** 打开时的条目 */
  entries: readonly MemoryEntry[];
  /** 输入预算 = 上下文 − 回复预留。0 表示没设上下文（不算占比） */
  inputBudget: number;
  /** 保存。返回 false 表示写盘失败（要提示用户） */
  onSave: (entries: MemoryEntry[]) => boolean;
  /** 导出当前角色 */
  onExport?: () => void;
  /** 导入（会弹文件选择，由调用方处理） */
  onImport?: () => void;
  /** 关掉时回调（调用方清理引用） */
  onClose?: () => void;
}

export interface MemoryPageHandle {
  close: () => void;
  isOpen: () => boolean;
}

/** 千分位，让"3,000"比"3000"好读 */
function fmt(n: number): string {
  return n.toLocaleString('zh-CN');
}

/**
 * 打开记忆编辑面板。
 *
 * 返回句柄而不是 void：调用方要在 `dispose()` 里关掉它，
 * 否则切 Tab 之后面板还浮在上面（同 `bubble-menu.ts` 的理由）。
 */
export function openMemoryPage(doc: DocLike, options: MemoryPageOptions): MemoryPageHandle {
  let open = true;

  const root = el(doc, 'div', 'nb-sheet-mask');
  root.setAttribute('data-role', 'memory-mask');

  const sheet = el(doc, 'div', 'nb-sheet nb-sheet--memory');
  sheet.setAttribute('data-role', 'memory-page');
  sheet.setAttribute('role', 'dialog');

  const close = (): void => {
    if (!open) return;
    open = false;
    root.remove();
    options.onClose?.();
  };

  /* 点遮罩关掉。`pointerdown` 更跟手（同 bubble-menu） */
  root.addEventListener?.('pointerdown', (event) => {
    if ((event as { target?: unknown }).target === (root as unknown as object)) close();
  });

  /* ── 标题行：角色名 + 关闭 ── */
  const head = el(doc, 'div', 'nb-memory-head');

  const title = el(doc, 'div', 'nb-memory-title');
  title.setAttribute('data-role', 'memory-title');
  title.textContent = `记忆 · ${options.characterName}`;
  head.append(title);

  const closeBtn = el(doc, 'button', 'nb-sheet-action');
  closeBtn.setAttribute('type', 'button');
  closeBtn.setAttribute('data-role', 'memory-close');
  closeBtn.setAttribute('aria-label', '关闭记忆编辑');
  closeBtn.textContent = '×';
  closeBtn.addEventListener?.('click', () => close());
  head.append(closeBtn);

  sheet.append(head);

  /* ── 统计区（实时更新）── */
  const stats = el(doc, 'div', 'nb-memory-stats');
  stats.setAttribute('data-role', 'memory-stats');
  const statsLine1 = el(doc, 'div', 'nb-memory-stats-main');
  const statsLine2 = el(doc, 'div', 'nb-memory-stats-sub');
  const statsLine3 = el(doc, 'div', 'nb-memory-stats-warn');
  stats.append(statsLine1);
  stats.append(statsLine2);
  stats.append(statsLine3);
  sheet.append(stats);

  /* ── 条目列表 ── */
  const list = el(doc, 'div', 'nb-memory-list');
  list.setAttribute('data-role', 'memory-list');
  sheet.append(list);

  /** 当前草稿。所有编辑都落在这里，保存时统一提交 */
  let drafts: DraftEntry[] = options.entries.map((one) => ({
    id: one.id,
    text: one.text,
    at: one.at,
  }));

  /**
   * 每个草稿对应的 textarea。
   *
   * 与 `drafts` 同序等长。用它避免在 input 里回头按 id 查 DOM ——
   * 那种查找在"删了一条之后"会错位。
   */
  let boxes: Array<{ value: string } | null> = [];

  /** 保存按钮与"超出"提示都要随统计变化 */
  let saveBtn: ElLike | null = null;

  /** 把草稿算成统计视图。空条目先滤掉，免得"用户填了个空格也算字数" */
  const currentView = (): { view: MemoryBudgetView; effective: MemoryEntry[] } => {
    const effective: MemoryEntry[] = drafts
      .filter((one) => isEntryStorable(one.text))
      .map((one) => ({ id: one.id, text: one.text, at: one.at }));
    return { view: memoryBudgetView(effective, options.inputBudget), effective };
  };

  /**
   * 刷新统计与保存按钮状态。
   *
   * ★ 用 `usedChars` / `memoryBudgetView` 而不是自己数 —— 它们与预算是同一套，
   * 另算一份必然与实际裁剪结果对不上（见 `memory.ts` 的注释）。
   */
  const refresh = (): void => {
    const { view } = currentView();
    const over = view.remaining < 0;

    statsLine1.textContent =
      `已用 ${fmt(view.chars)} / ${fmt(MEMORY_MAX_CHARS)} 字符 · 约 ${fmt(view.tokens)} token`;
    if (over) {
      statsLine1.setAttribute('data-over', 'true');
    } else {
      statsLine1.removeAttribute('data-over');
    }

    /*
     * 第二行：把"这次请求里记忆占多少"说清楚。
     *
     * 这一行的价值在于让用户自己看出"记忆是不是加得太多了"。
     * 上下文没设时不算占比 —— 算出来是假数字。
     */
    if (view.inputBudget === 0) {
      statsLine2.textContent = '未设置上下文长度，无法估算占比。到「AI 响应配置 → 上下文长度」填上实际值。';
      statsLine2.setAttribute('data-tone', 'muted');
    } else if (view.percent === null) {
      statsLine2.textContent = '';
    } else {
      const left = Math.max(0, view.inputBudget - view.tokens);
      statsLine2.textContent =
        `本次请求：记忆 ${fmt(view.tokens)} + 回复预留 = 输入预算 ${fmt(view.inputBudget)}，` +
        `剩 ${fmt(left)} token 留给提示词、角色设定、世界书和历史（记忆占 ${String(view.percent)}%）`;
      statsLine2.setAttribute('data-tone', view.tight ? 'tight' : 'normal');
    }

    /*
     * 第三行：用户明确要求的那句提醒 + 超限时的具体数字。
     *
     * 超限时**只说超了多少**，不要重复"请删减" —— 按钮已经置灰了，
     * 再喊一遍只是噪音。
     */
    if (over) {
      statsLine3.textContent = `超出 ${fmt(-view.remaining)} 字符，删减后才能保存。`;
      statsLine3.setAttribute('data-tone', 'over');
    } else if (view.tight) {
      statsLine3.textContent =
        '记忆已占输入预算一半以上，历史会被裁掉。建议到「AI 响应配置」把上下文长度调大。';
      statsLine3.setAttribute('data-tone', 'tight');
    } else {
      statsLine3.textContent =
        '请保证记忆 + 提示词 + 角色设定远小于上下文长度，否则历史会被裁掉，聊天会「记不住」。';
      statsLine3.setAttribute('data-tone', 'muted');
    }

    if (saveBtn !== null) {
      if (over || options.avatar.trim() === '') {
        saveBtn.setAttribute('disabled', '');
      } else {
        saveBtn.removeAttribute('disabled');
      }
    }
  };

  /** 按内容行数估一个高度，避免每条都固定两行（内容多时要滚） */
  const rowsFor = (text: string): number => {
    const lines = text.split('\n').length;
    const wrapped = Math.ceil(text.length / 24);
    return Math.min(6, Math.max(2, Math.max(lines, wrapped)));
  };

  /** 重画列表。删/加一条之后调用 */
  const renderList = (): void => {
    list.replaceChildren();
    boxes = drafts.map((draft) => {
      const row = el(doc, 'div', 'nb-memory-row');
      row.setAttribute('data-role', 'memory-row');

      const indexTag = el(doc, 'span', 'nb-memory-index');
      indexTag.textContent = String(drafts.indexOf(draft) + 1);
      row.append(indexTag);

      /*
       * 直接可编辑的 textarea —— 不为"编辑"再多按一次。
       *
       * `ElLike` 是渲染层的窄接口，没有 `value` / `style.height`；
       * 收窄成"既当 ElLike 又能读 value"的交叉类型（同 `bubble-menu.ts`）。
       */
      const box = el(doc, 'textarea', 'nb-memory-input') as unknown as ElLike & {
        value: string;
        focus?: () => void;
      };
      box.setAttribute('rows', String(rowsFor(draft.text)));
      box.setAttribute('data-role', 'memory-input');
      box.setAttribute('aria-label', `第 ${String(drafts.indexOf(draft) + 1)} 条记忆`);
      box.value = draft.text;
      box.addEventListener?.('input', () => {
        draft.text = String(box.value ?? '');
        /* 内容变多时把行数撑开，否则用户要在一行里滚动 */
        box.setAttribute('rows', String(rowsFor(draft.text)));
        refresh();
      });
      row.append(box);

      const delBtn = el(doc, 'button', 'nb-sheet-action nb-sheet-action--danger');
      delBtn.setAttribute('type', 'button');
      delBtn.setAttribute('data-role', 'memory-delete');
      delBtn.setAttribute('aria-label', '删除这条记忆');
      delBtn.textContent = '删';
      delBtn.addEventListener?.('click', () => {
        drafts = drafts.filter((one) => one.id !== draft.id);
        renderList();
        refresh();
      });
      row.append(delBtn);

      list.append(row);
      return box;
    });

    if (drafts.length === 0) {
      const empty = el(doc, 'div', 'nb-memory-empty');
      empty.setAttribute('data-role', 'memory-empty');
      empty.textContent = '还没有记忆。点下面「添加一条」，或在聊天里点某条消息选「存为记忆」。';
      list.append(empty);
    }
  };

  /* ── 添加一条 ── */
  const addBtn = el(doc, 'button', 'nb-sheet-action');
  addBtn.setAttribute('type', 'button');
  addBtn.setAttribute('data-role', 'memory-add');
  addBtn.textContent = '+ 添加一条';
  addBtn.addEventListener?.('click', () => {
    drafts.push({ id: nextEntryId(drafts), text: '', at: Date.now() });
    renderList();
    refresh();
    /* 把光标送到新那条，省一次点击 */
    const last = boxes[boxes.length - 1];
    (last as unknown as { focus?: () => void } | null)?.focus?.();
  });
  sheet.append(addBtn);

  /* ── 底部：导入 / 导出 / 保存 ── */
  const footer = el(doc, 'div', 'nb-memory-footer');

  if (options.onImport !== undefined) {
    const importBtn = el(doc, 'button', 'nb-sheet-action');
    importBtn.setAttribute('type', 'button');
    importBtn.setAttribute('data-role', 'memory-import');
    importBtn.textContent = '导入';
    importBtn.addEventListener?.('click', () => options.onImport?.());
    footer.append(importBtn);
  }

  if (options.onExport !== undefined) {
    const exportBtn = el(doc, 'button', 'nb-sheet-action');
    exportBtn.setAttribute('type', 'button');
    exportBtn.setAttribute('data-role', 'memory-export');
    exportBtn.textContent = '导出';
    exportBtn.addEventListener?.('click', () => options.onExport?.());
    footer.append(exportBtn);
  }

  const save = el(doc, 'button', 'nb-sheet-action nb-sheet-action--primary');
  save.setAttribute('type', 'button');
  save.setAttribute('data-role', 'memory-save');
  save.textContent = '保存';
  saveBtn = save;
  save.addEventListener?.('click', () => {
    /*
     * ★ 再检查一次，不只靠 `disabled`。
     *
     * 有些 WebView 对 `disabled` 属性与 `addEventListener` 的组合处理不一致
     * （属性存在但事件照收）。只靠置灰等于把"不许保存"寄托在样式上。
     */
    const { view, effective } = currentView();
    if (view.remaining < 0) {
      statsLine3.textContent = `超出 ${fmt(-view.remaining)} 字符，删减后才能保存。`;
      statsLine3.setAttribute('data-tone', 'over');
      return;
    }
    if (options.avatar.trim() === '') {
      statsLine3.textContent = '当前没有选中角色，记忆无处可存。';
      statsLine3.setAttribute('data-tone', 'over');
      return;
    }
    const ok = options.onSave(effective);
    if (!ok) {
      /* 写盘失败要说清 —— 记忆只有这一份，不存在"下次再存" */
      statsLine3.textContent = '保存失败：本机存储不可用（可能是隐私模式或空间已满）。';
      statsLine3.setAttribute('data-tone', 'over');
      return;
    }
    close();
  });
  footer.append(save);

  sheet.append(footer);
  root.append(sheet);

  const host = (doc as unknown as { body?: ElLike }).body;
  if (host !== undefined) host.append(root);

  renderList();
  refresh();

  return {
    close,
    isOpen: () => open,
  };
}

/** 已用字符数（导出给调用方做提示用，避免它自己再数一遍） */
export { usedChars, withinLimit };
