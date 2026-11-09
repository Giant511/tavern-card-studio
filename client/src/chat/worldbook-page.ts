/**
 * 世界书管理页（2026-11-04，用户要求「实现原生 ST 的对应可实现的所有功能」）。
 *
 * ## 用户要的功能（原话）
 *
 * > 开始动工聊天里面的世界书管理，实现原生 ST 的对应可实现的所有功能：
 * > 即创建、导入、修改、重命名、启用禁用以及如图功能
 *
 * 「如图功能」= 那组全局激活设置：扫描深度 / 上下文百分比 /
 * Token 预算上限 / 最小激活数 / 最大深度 / 最大递归深度 /
 * 六个勾选（包括名称、递归扫描、区分大小写、匹配整个单词、
 * 使用群组评分、溢出警报）/ 插入策略。
 *
 * ## 三层结构，一页到底（与仓库页同一个取舍）
 *
 * ```text
 *   ① 世界书列表        ＋ 新建 / 导入
 *   ② 选中那本的条目列表  ＋ 新增条目 / 整本设置
 *   ③ 展开某一条的编辑区（就地展开，与「用户设定」同一个抽屉形态）
 * ```
 *
 * 竖屏下"列表 → 二级页 → 三级页"要按三次返回才回到聊天，
 * 而这个功能是**高频小改**（加一条、改个关键词），所以一页到底。
 *
 * ## 保存是整份覆盖，所以每次保存都必须先有完整数据
 *
 * ST 的 `worldinfo/edit` 收整份 `entries`。这里的做法：
 * 进页面时读一次完整内容 → 所有编辑都改内存里那份 → 点保存整份写回。
 * **不在每次小改时都发请求**：网络慢时会出现"改 A 保存了，改 B 把 A 写回旧值"。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { fieldRow } from './field-row.ts';
import { buildTopbar } from './chat-settings.ts';
import { makeSelectTrigger } from './select-popover.ts';
import {
  DEFAULT_GLOBAL_SETTINGS,
  INSERTION_STRATEGY_OPTIONS,
  WORLD_POSITION,
  WORLD_POSITION_OPTIONS,
  checkWorldbook,
  describeWorldbook,
  formatKeywordInput,
  makeEntry,
  parseKeywordInput,
  parseWorldbook,
  removeEntry,
  serializeWorldbook,
  toggleEntry,
  updateEntry,
  type WorldEntry,
  type WorldGlobalSettings,
} from '@tcs/shared';

/** 列表里的一本（只有元信息，内容按需读） */
export interface WorldbookSummary {
  /** 文件名（不带 .json）—— 所有接口都用它做 name */
  fileId: string;
  /** 显示名 */
  name: string;
}

export interface WorldbookPageCallbacks {
  /** 列出所有世界书 */
  onList: () => Promise<WorldbookSummary[]>;
  /** 读一本的全部条目（返回原始 JSON 文本） */
  onRead: (fileId: string) => Promise<string>;
  /** 整份写回 */
  onSave: (fileId: string, entries: readonly WorldEntry[]) => Promise<void>;
  /** 导入（同名要先在外壳查重，这里只负责调用） */
  onImport: (name: string, jsonText: string) => Promise<void>;
  /** 删除整本 */
  onDelete: (fileId: string) => Promise<void>;
  /** 重命名 */
  onRename: (fileId: string, nextName: string) => Promise<void>;
  /** 挑一个 .json 文件读成文本（导入用）。取消返回 null */
  onPickFile: () => Promise<{ name: string; text: string } | null>;
  /**
   * 读全局激活设置。
   *
   * 这组设置在**引擎的全局设置**里（不是每本世界书各自一份），
   * 所以外壳负责读与写。
   */
  onReadSettings: () => Promise<WorldGlobalSettings>;
  onSaveSettings: (next: WorldGlobalSettings) => Promise<void>;
  onBack: () => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

/* ───────────────────────── 小工具 ───────────────────────── */

/*
 * 字段行已抽到 `field-row.ts`（与人设页共用）。
 *
 * ★ 本地原来这一份用的是 `.nb-note`（提示条：带边框、有底色），
 * 于是每个字段下面都多出一个框 —— 真机上看着像一堆空输入框。
 * 字段说明该用 `.nb-field-hint`（灰色小字）。
 */

function textInput(doc: DocLike, role: string, placeholder: string): ElLike {
  const input = el(doc, 'input', 'nb-input');
  input.setAttribute('type', 'text');
  input.setAttribute('data-role', role);
  input.setAttribute('placeholder', placeholder);
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  return input;
}

function numberInput(doc: DocLike, role: string, value: number, min: number, max: number): ElLike {
  const input = el(doc, 'input', 'nb-input');
  input.setAttribute('type', 'number');
  input.setAttribute('data-role', role);
  input.setAttribute('inputmode', 'numeric');
  input.setAttribute('min', String(min));
  input.setAttribute('max', String(max));
  (input as unknown as HTMLInputElement).value = String(value);
  return input;
}

/** 勾选框 + 说明（截图里右侧那一列） */
function checkRow(
  doc: DocLike,
  role: string,
  labelText: string,
  checked: boolean,
  onChange: (next: boolean) => void,
  hint?: string,
): ElLike {
  const row = el(doc, 'label', 'nb-check-row');

  const box = el(doc, 'input', 'nb-check');
  box.setAttribute('type', 'checkbox');
  box.setAttribute('data-role', role);
  (box as unknown as HTMLInputElement).checked = checked;
  box.addEventListener('change', () => {
    onChange((box as unknown as HTMLInputElement).checked);
  });

  const text = el(doc, 'span', 'nb-check-text');
  const title = el(doc, 'span', 'nb-check-title');
  title.textContent = labelText;
  text.append(title);
  if (hint !== undefined && hint !== '') {
    const sub = el(doc, 'span', 'nb-check-sub');
    sub.textContent = hint;
    text.append(sub);
  }

  row.append(box, text);
  return row;
}

function readValue(node: ElLike): string {
  return (node as unknown as HTMLInputElement).value ?? '';
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/* ───────────────────────── 页面 ───────────────────────── */

export function renderWorldbookPage(
  doc: DocLike,
  callbacks: WorldbookPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-worldbook');
  root.setAttribute('data-role', 'worldbook-page');
  root.append(buildTopbar(doc, '世界书', callbacks.onBack));

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);
  const list = el(doc, 'div', 'nb-list');
  scroller.append(list);

  /* ── 状态 ── */
  let books: WorldbookSummary[] = [];
  /** 当前打开的那本（null = 只看列表） */
  let openedId: string | null = null;
  /** 打开那本的条目（内存工作副本；保存时才写回） */
  let entries: WorldEntry[] = [];
  /** 展开编辑的那一条 uid */
  let editingUid: number | null = null;
  let settings: WorldGlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS };
  let settingsOpen = false;
  /** 读失败时的说明（引擎没起 / 书坏了） */
  let loadError = '';
  let busy = false;

  const fail = (error: unknown): string =>
    error instanceof Error ? error.message : typeof error === 'string' ? error : '操作失败';

  /* ── 读列表 ── */
  const reload = async (): Promise<void> => {
    try {
      books = await callbacks.onList();
      loadError = '';
    } catch (error) {
      books = [];
      loadError = fail(error);
    }
    paint();
  };

  /* ── 打开一本 ── */
  const open = async (fileId: string): Promise<void> => {
    busy = true;
    paint();
    try {
      const raw = await callbacks.onRead(fileId);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw === '' ? '{}' : raw);
      } catch {
        parsed = null;
      }
      const result = parseWorldbook(parsed);
      entries = result.entries;
      openedId = fileId;
      editingUid = null;
      loadError =
        result.skipped > 0 ? `有 ${String(result.skipped)} 条读不懂，已跳过（那几条不会丢，保存时不动它们）` : '';
    } catch (error) {
      loadError = fail(error);
    } finally {
      busy = false;
      paint();
    }
  };

  /* ── 保存 ── */
  const save = async (): Promise<void> => {
    if (openedId === null) return;
    const problems = checkWorldbook(entries);
    busy = true;
    paint();
    try {
      await callbacks.onSave(openedId, entries);
      callbacks.onNotify(
        problems.length === 0
          ? '已保存'
          : `已保存（有 ${String(problems.length)} 处可能不生效，见条目提示）`,
        problems.length === 0 ? 'ok' : 'warn',
      );
    } catch (error) {
      callbacks.onNotify(`没保存成：${fail(error)}`, 'danger');
    } finally {
      busy = false;
      paint();
    }
  };

  /* ═══════════════ 绘制 ═══════════════ */
  const paint = (): void => {
    list.replaceChildren();

    if (openedId === null) paintBookList();
    else paintBookDetail();

    /* 全局激活设置：两处都显示（截图里它在列表之上） */
    paintSettings();
  };

  /* ── ① 世界书列表 ── */
  const paintBookList = (): void => {
    const head = el(doc, 'div', 'nb-settings-group');
    head.textContent = '世界书';
    list.append(head);

    if (loadError !== '') {
      const note = el(doc, 'p', 'nb-note');
      note.setAttribute('data-kind', 'warn');
      note.setAttribute('data-role', 'worldbook-error');
      note.textContent = loadError;
      list.append(note);
    }

    if (books.length === 0 && loadError === '') {
      const empty = el(doc, 'p', 'nb-note');
      empty.setAttribute('data-role', 'worldbook-empty');
      empty.textContent = '还没有世界书。新建一本，或者从文件导入一本。';
      list.append(empty);
    }

    for (const book of books) {
      const row = el(doc, 'button', 'nb-listitem');
      row.setAttribute('type', 'button');
      row.setAttribute('data-role', 'worldbook-item');
      row.setAttribute('data-id', book.fileId);

      const main = el(doc, 'span', 'nb-listitem-main');
      const name = el(doc, 'span', 'nb-listitem-title');
      name.textContent = book.name;
      const sub = el(doc, 'span', 'nb-listitem-sub');
      sub.textContent = '点开看条目';
      main.append(name, sub);

      const chevron = el(doc, 'span', 'nb-src-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = '›';

      row.append(main, chevron);
      row.addEventListener('click', () => {
        void open(book.fileId);
      });
      list.append(row);
    }

    /* 新建 / 导入 */
    const actions = el(doc, 'div', 'nb-tag-row');

    const create = el(doc, 'button', 'nb-btn');
    create.setAttribute('type', 'button');
    create.setAttribute('data-role', 'worldbook-create');
    create.textContent = '新建世界书';
    create.addEventListener('click', () => {
      askName('新建世界书', '', (name) => {
        void (async () => {
          try {
            /*
             * 新建 = 导入一本空书。
             *
             * 没有独立的"创建"接口（ST 里新建就是写一个空文件），
             * 所以走 import，内容给一个空 entries。
             */
            await callbacks.onImport(name, JSON.stringify({ entries: {} }));
            await reload();
            callbacks.onNotify(`已新建「${name}」`, 'ok');
          } catch (error) {
            callbacks.onNotify(`没建成：${fail(error)}`, 'danger');
          }
        })();
      });
    });

    const importBtn = el(doc, 'button', 'nb-btn');
    importBtn.setAttribute('type', 'button');
    importBtn.setAttribute('data-role', 'worldbook-import');
    importBtn.textContent = '从文件导入';
    importBtn.addEventListener('click', () => {
      void (async () => {
        let picked: { name: string; text: string } | null = null;
        try {
          picked = await callbacks.onPickFile();
        } catch (error) {
          callbacks.onNotify(`读不了这个文件：${fail(error)}`, 'danger');
          return;
        }
        if (picked === null) return;

        /*
         * 先把文件读成 entries，确认**真的是世界书**再问名字。
         * 顺序反了的话用户输完名字才被告知"这不是世界书"。
         */
        let parsed: unknown = null;
        try {
          const json = JSON.parse(picked.text);
          /* 兼容两种导出：整份 {entries:{...}}，或直接是 entries 对象 */
          const looksLikeEntries =
            json !== null &&
            typeof json === 'object' &&
            !Array.isArray(json) &&
            (json as Record<string, unknown>)['entries'] !== undefined;
          parsed = looksLikeEntries ? json : { entries: json };
        } catch {
          callbacks.onNotify('这个文件不是世界书（读不出内容）', 'danger');
          return;
        }

        const preview = parseWorldbook(parsed);
        if (preview.entries.length === 0) {
          callbacks.onNotify('这个文件里没有条目', 'warn');
          return;
        }

        const suggested = picked.name.replace(/\.json$/i, '');
        askName(`导入 ${String(preview.entries.length)} 条`, suggested, (name) => {
          void (async () => {
            try {
              await callbacks.onImport(name, JSON.stringify(parsed));
              await reload();
              callbacks.onNotify(`已导入「${name}」`, 'ok');
            } catch (error) {
              callbacks.onNotify(`没导入成：${fail(error)}`, 'danger');
            }
          })();
        });
      });
    });

    actions.append(create, importBtn);
    list.append(actions);
  };

  /* ── ② 某本世界书的条目 ── */
  const paintBookDetail = (): void => {
    const book = books.find((one) => one.fileId === openedId) ?? null;

    const bar = el(doc, 'div', 'nb-tag-row');
    const back = el(doc, 'button', 'nb-btn');
    back.setAttribute('type', 'button');
    back.setAttribute('data-role', 'worldbook-close');
    back.textContent = '‹ 所有世界书';
    back.addEventListener('click', () => {
      openedId = null;
      entries = [];
      editingUid = null;
      loadError = '';
      paint();
    });
    bar.append(back);

    const rename = el(doc, 'button', 'nb-btn');
    rename.setAttribute('type', 'button');
    rename.setAttribute('data-role', 'worldbook-rename');
    rename.textContent = '重命名';
    rename.addEventListener('click', () => {
      if (openedId === null) return;
      const current = openedId;
      askName('重命名世界书', current, (next) => {
        void (async () => {
          try {
            await callbacks.onRename(current, next);
            await reload();
            callbacks.onNotify(`已改名为「${next}」`, 'ok');
          } catch (error) {
            callbacks.onNotify(`没改成：${fail(error)}`, 'danger');
          }
        })();
      });
    });

    const del = el(doc, 'button', 'nb-btn nb-btn--danger');
    del.setAttribute('type', 'button');
    del.setAttribute('data-role', 'worldbook-delete');
    del.textContent = '删除这本';
    del.addEventListener('click', () => {
      if (openedId === null) return;
      const target = openedId;
      confirmThen(`删除「${target}」和它的全部条目？`, '不能恢复。', () => {
        void (async () => {
          try {
            await callbacks.onDelete(target);
            openedId = null;
            entries = [];
            await reload();
            callbacks.onNotify(`已删除「${target}」`, 'ok');
          } catch (error) {
            callbacks.onNotify(`没删成：${fail(error)}`, 'danger');
          }
        })();
      });
    });

    bar.append(rename, del);
    list.append(bar);

    const head = el(doc, 'div', 'nb-settings-group');
    head.textContent = `${book?.name ?? openedId ?? ''}（${describeWorldbook(entries)}）`;
    list.append(head);

    if (loadError !== '') {
      const note = el(doc, 'p', 'nb-note');
      note.setAttribute('data-kind', 'warn');
      note.textContent = loadError;
      list.append(note);
    }

    if (busy) {
      const wait = el(doc, 'p', 'nb-note');
      wait.textContent = '正在读取…';
      list.append(wait);
      return;
    }

    const problems = checkWorldbook(entries);
    for (const entry of entries) {
      list.append(makeEntryRow(entry, problems.filter((one) => one.uid === entry.uid)));

      /* 抽屉：就地展开这条的编辑区 */
      if (editingUid === entry.uid) list.append(makeEntryEditor(entry));
    }

    const actions = el(doc, 'div', 'nb-tag-row');

    const add = el(doc, 'button', 'nb-btn');
    add.setAttribute('type', 'button');
    add.setAttribute('data-role', 'worldbook-entry-add');
    add.textContent = '＋ 新增条目';
    add.addEventListener('click', () => {
      const entry = makeEntry(entries);
      entries = [...entries, entry];
      editingUid = entry.uid;
      paint();
    });

    const saveBtn = el(doc, 'button', 'nb-btn nb-btn--primary');
    saveBtn.setAttribute('type', 'button');
    saveBtn.setAttribute('data-role', 'worldbook-save');
    saveBtn.setAttribute('data-dirty', 'true');
    saveBtn.textContent = '保存这本';
    saveBtn.addEventListener('click', () => {
      if (busy) return;
      saveBtn.setAttribute('disabled', 'true');
      void save().finally(() => {
        saveBtn.removeAttribute('disabled');
      });
    });

    actions.append(add, saveBtn);
    list.append(actions);
  };

  /* ── 条目一行 ── */
  const makeEntryRow = (entry: WorldEntry, issues: readonly { message: string }[]): ElLike => {
    const row = el(doc, 'div', 'nb-listitem nb-wb-row');
    row.setAttribute('data-role', 'worldbook-entry');
    row.setAttribute('data-uid', String(entry.uid));
    if (entry.disabled) row.setAttribute('data-disabled', 'true');
    /* 展开态：让这一行的下圆角与下边距归零，与抽屉拼成一张卡 */
    if (editingUid === entry.uid) row.setAttribute('data-open', 'true');

    /*
     * 启用开关放在**行上**而不是编辑区里。
     *
     * 用户最常见的动作是"临时关掉某条试试"，那不该进编辑区、
     * 改完再保存 —— 直接在列表上点一下就该生效。
     *
     * ★ 必须是 `<input type="checkbox">`：`.nb-switch` 那套样式用的是
     * `:checked` 伪类。用 `<button>` 拿不到那个状态，会渲染成一个
     * **永远关着的**胶囊（看起来像"这条是禁用的"，而其实开着）。
     */
    const toggle = el(doc, 'input', 'nb-switch');
    toggle.setAttribute('type', 'checkbox');
    toggle.setAttribute('data-role', 'worldbook-entry-toggle');
    (toggle as unknown as HTMLInputElement).checked = !entry.disabled;
    if (entry.disabled) toggle.setAttribute('data-off', 'true');
    toggle.addEventListener('change', () => {
      entries = toggleEntry(entries, entry.uid);
      paint();
    });

    const main = el(doc, 'button', 'nb-wb-main');
    main.setAttribute('type', 'button');
    main.setAttribute('data-role', 'worldbook-entry-open');

    const title = el(doc, 'span', 'nb-listitem-title');
    const label =
      entry.comment.trim() !== ''
        ? entry.comment.trim()
        : entry.keys.length > 0
          ? entry.keys.join('，')
          : entry.constant
            ? '（常驻条目）'
            : '（未命名条目）';
    title.textContent = label;

    const sub = el(doc, 'span', 'nb-listitem-sub');
    const bits: string[] = [];
    if (entry.constant) bits.push('常驻');
    if (entry.keys.length > 0) bits.push(`关键词：${entry.keys.slice(0, 3).join('，')}`);
    if (entry.useProbability && entry.probability < 100) bits.push(`${String(entry.probability)}% 概率`);
    /* `?? ''`：TS 的 noUncheckedIndexedAccess 下 `issues[0]` 可能是 undefined，
       而 `length > 0` 已经保证了它存在 —— 这里只是让类型也同意 */
    if (issues.length > 0) bits.push(`⚠ ${issues[0]?.message ?? ''}`);
    sub.textContent = bits.length === 0 ? '没有关键词，也不是常驻' : bits.join(' · ');
    if (issues.length > 0) sub.setAttribute('data-kind', 'warn');

    main.append(title, sub);
    main.addEventListener('click', () => {
      editingUid = editingUid === entry.uid ? null : entry.uid;
      paint();
    });

    row.append(toggle, main);
    return row;
  };

  /* ── 条目编辑（抽屉） ── */
  const makeEntryEditor = (entry: WorldEntry): ElLike => {
    /* 与「用户设定」共用同一套抽屉视觉（`.nb-drawer`） */
    const box = el(doc, 'div', 'nb-drawer nb-wb-editor');
    box.setAttribute('data-role', 'worldbook-entry-editor');
    box.setAttribute('data-uid', String(entry.uid));

    const patch = (next: Partial<Omit<WorldEntry, 'uid'>>): void => {
      entries = updateEntry(entries, entry.uid, next);
    };

    /* 备注 */
    const commentField = fieldRow(doc, '备注', '列表里显示的名字。不填就用第一个关键词。');
    const comment = textInput(doc, 'worldbook-entry-comment', '例如：王都设定');
    (comment as unknown as HTMLInputElement).value = entry.comment;
    comment.addEventListener('input', () => patch({ comment: readValue(comment) }));
    commentField.body.append(comment);
    box.append(commentField.row);

    /* 关键词 */
    const keyField = fieldRow(
      doc,
      '关键词',
      '命中任意一个就会插入。多个词用逗号分隔。',
    );
    const keys = textInput(doc, 'worldbook-entry-keys', '龙，魔法，王都');
    (keys as unknown as HTMLInputElement).value = formatKeywordInput(entry.keys);
    keys.addEventListener('input', () => patch({ keys: parseKeywordInput(readValue(keys)) }));
    keyField.body.append(keys);
    box.append(keyField.row);

    /* 次关键词 */
    const secField = fieldRow(
      doc,
      '同时出现的词',
      '填了之后要两边都命中才触发。留空则不限制。',
    );
    const sec = textInput(doc, 'worldbook-entry-secondary', '留空即可');
    (sec as unknown as HTMLInputElement).value = formatKeywordInput(entry.secondaryKeys);
    sec.addEventListener('input', () =>
      patch({ secondaryKeys: parseKeywordInput(readValue(sec)) }),
    );
    secField.body.append(sec);
    box.append(secField.row);

    /* 内容 */
    const contentField = fieldRow(doc, '内容', '命中关键词后插进对话的正文。');
    const content = el(doc, 'textarea', 'nb-input nb-textarea');
    content.setAttribute('data-role', 'worldbook-entry-content');
    content.setAttribute('rows', '6');
    content.setAttribute('placeholder', '王都是一座……');
    (content as unknown as HTMLTextAreaElement).value = entry.content;
    content.addEventListener('input', () => patch({ content: readValue(content) }));
    contentField.body.append(content);
    box.append(contentField.row);

    /* 常驻 / 概率 */
    box.append(
      checkRow(
        doc,
        'worldbook-entry-constant',
        '常驻（不看关键词，永远插入）',
        entry.constant,
        (next) => {
          patch({ constant: next });
          paint();
        },
        '会一直占用上下文预算。',
      ),
      checkRow(
        doc,
        'worldbook-entry-useprob',
        '按概率触发',
        entry.useProbability,
        (next) => {
          patch({ useProbability: next });
          paint();
        },
        '关掉就等于 100% 必触发。',
      ),
    );

    if (entry.useProbability) {
      const probField = fieldRow(doc, '触发概率（%）', '100 = 每次命中都触发。');
      const prob = numberInput(doc, 'worldbook-entry-probability', entry.probability, 1, 100);
      prob.addEventListener('change', () =>
        patch({ probability: clampInt(readValue(prob), 1, 100, entry.probability) }),
      );
      probField.body.append(prob);
      box.append(probField.row);
    }

    /* 顺序 */
    const orderField = fieldRow(doc, '插入顺序', '数字越大越靠后。');
    const order = numberInput(doc, 'worldbook-entry-order', entry.order, 0, 9999);
    order.addEventListener('change', () =>
      patch({ order: clampInt(readValue(order), 0, 9999, entry.order) }),
    );
    orderField.body.append(order);
    box.append(orderField.row);

    /* 插入位置 */
    const posField = fieldRow(doc, '插入位置', '');
    const pos = makeSelectTrigger(doc, {
      label: '插入位置',
      options: WORLD_POSITION_OPTIONS.map((one) => ({
        value: String(one.value),
        label: one.label,
      })),
      current: String(entry.position),
      onPick: (value) => {
        patch({ position: Number(value) });
        paint();
      },
    }).el;
    pos.setAttribute('data-role', 'worldbook-entry-position');
    posField.body.append(pos);
    box.append(posField.row);

    /* 深度：只在"按深度插入"时有意义 */
    if (entry.position === WORLD_POSITION.atDepth) {
      const depthField = fieldRow(doc, '深度', '从最新一条往前数第几条插入。');
      const depth = numberInput(doc, 'worldbook-entry-depth', entry.depth, 0, 999);
      depth.addEventListener('change', () =>
        patch({ depth: clampInt(readValue(depth), 0, 999, entry.depth) }),
      );
      depthField.body.append(depth);
      box.append(depthField.row);
    }

    /* 删除这一条 */
    const del = el(doc, 'button', 'nb-btn nb-btn--danger');
    del.setAttribute('type', 'button');
    del.setAttribute('data-role', 'worldbook-entry-delete');
    del.textContent = '删除这条';
    del.addEventListener('click', () => {
      confirmThen('删除这一条？', '保存后才会真的从世界书里消失。', () => {
        entries = removeEntry(entries, entry.uid);
        editingUid = null;
        paint();
      });
    });

    const actions = el(doc, 'div', 'nb-tag-row');
    actions.append(del);
    box.append(actions);

    return box;
  };

  /* ── ③ 全局激活设置（对齐截图那一组） ── */
  const paintSettings = (): void => {
    const head = el(doc, 'button', 'nb-settings-group nb-wb-settings-toggle');
    head.setAttribute('type', 'button');
    head.setAttribute('data-role', 'worldbook-settings-toggle');
    head.setAttribute('data-open', String(settingsOpen));
    head.textContent = `全局激活设置 ${settingsOpen ? '⌄' : '›'}`;
    head.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      paint();
    });
    list.append(head);

    if (!settingsOpen) return;

    const box = el(doc, 'div', 'nb-wb-settings');
    box.setAttribute('data-role', 'worldbook-settings');

    const patch = (next: Partial<WorldGlobalSettings>): void => {
      settings = { ...settings, ...next };
    };

    /* 六个数字 */
    const nums: Array<{ role: string; label: string; hint?: string; min: number; max: number; key: keyof WorldGlobalSettings }> = [
      { role: 'wb-scan-depth', label: '扫描深度', hint: '往回看几条消息找关键词。', min: 0, max: 100, key: 'scanDepth' },
      { role: 'wb-context-percent', label: '上下文百分比', hint: '世界书最多占上下文的百分之几。', min: 1, max: 100, key: 'contextPercent' },
      { role: 'wb-budget-cap', label: 'Token 预算上限', hint: '0 = 按百分比算。', min: 0, max: 100000, key: 'budgetCap' },
      { role: 'wb-min-activations', label: '最小激活数', hint: '0 = 不强制。', min: 0, max: 100, key: 'minActivations' },
      { role: 'wb-max-depth', label: '最大深度', hint: '0 = 不限制。', min: 0, max: 1000, key: 'maxDepth' },
      { role: 'wb-max-recursion', label: '最大递归深度', hint: '0 = 不限制。', min: 0, max: 100, key: 'maxRecursionDepth' },
    ];

    const grid = el(doc, 'div', 'nb-wb-grid');
    for (const item of nums) {
      const field = fieldRow(doc, item.label, item.hint);
      const input = numberInput(doc, item.role, Number(settings[item.key]), item.min, item.max);
      input.addEventListener('change', () => {
        const next = clampInt(readValue(input), item.min, item.max, Number(settings[item.key]));
        patch({ [item.key]: next } as Partial<WorldGlobalSettings>);
      });
      field.body.append(input);
      grid.append(field.row);
    }
    box.append(grid);

    /* 六个勾选 */
    const checks: Array<{ role: string; label: string; key: keyof WorldGlobalSettings; hint?: string }> = [
      { role: 'wb-include-names', label: '包括名称', key: 'includeNames', hint: '角色名和人设名也算关键词。' },
      { role: 'wb-recursive', label: '递归扫描', key: 'recursive', hint: '条目内容里出现的关键词能再触发别的条目。' },
      { role: 'wb-case-sensitive', label: '区分大小写', key: 'caseSensitive' },
      { role: 'wb-whole-words', label: '匹配整个单词', key: 'matchWholeWords', hint: '关掉则词内匹配。' },
      { role: 'wb-group-scoring', label: '使用群组评分', key: 'useGroupScoring' },
      { role: 'wb-overflow-alert', label: '溢出警报', key: 'overflowAlert', hint: '超出预算时提醒。' },
    ];

    const checkBox = el(doc, 'div', 'nb-wb-checks');
    for (const item of checks) {
      checkBox.append(
        checkRow(doc, item.role, item.label, Boolean(settings[item.key]), (next) => {
          patch({ [item.key]: next } as Partial<WorldGlobalSettings>);
        }, item.hint),
      );
    }
    box.append(checkBox);

    /* 插入策略 */
    const strategyField = fieldRow(doc, '插入策略', '');
    const strategy = makeSelectTrigger(doc, {
      label: '插入策略',
      options: INSERTION_STRATEGY_OPTIONS.map((one) => ({
        value: one.value,
        label: one.label,
      })),
      current: settings.insertionStrategy,
      onPick: (value) => {
        const picked = INSERTION_STRATEGY_OPTIONS.find((one) => one.value === value);
        if (picked !== undefined) patch({ insertionStrategy: picked.value });
      },
    }).el;
    strategy.setAttribute('data-role', 'wb-insertion-strategy');
    strategyField.body.append(strategy);
    box.append(strategyField.row);

    const saveSettings = el(doc, 'button', 'nb-btn nb-btn--primary');
    saveSettings.setAttribute('type', 'button');
    saveSettings.setAttribute('data-role', 'worldbook-settings-save');
    saveSettings.textContent = '保存全局设置';
    saveSettings.addEventListener('click', () => {
      saveSettings.setAttribute('disabled', 'true');
      void (async () => {
        try {
          await callbacks.onSaveSettings(settings);
          callbacks.onNotify('已保存全局设置', 'ok');
        } catch (error) {
          callbacks.onNotify(`没保存成：${fail(error)}`, 'danger');
        } finally {
          saveSettings.removeAttribute('disabled');
        }
      })();
    });
    box.append(saveSettings);

    list.append(box);
  };

  /* ── 弹窗：输名字 ── */
  const askName = (titleText: string, initial: string, onOk: (name: string) => void): void => {
    const overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'worldbook-name-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    const title = el(doc, 'p', 'nb-exit-title');
    title.textContent = titleText;

    const input = textInput(doc, 'worldbook-name-input', '给它起个名字');
    (input as unknown as HTMLInputElement).value = initial;

    const actions = el(doc, 'div', 'nb-exit-actions');
    const ok = el(doc, 'button', 'nb-exit-leave');
    ok.setAttribute('type', 'button');
    ok.setAttribute('data-role', 'worldbook-name-ok');
    ok.textContent = '确定';

    const cancel = el(doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'worldbook-name-cancel');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());

    ok.addEventListener('click', () => {
      const value = readValue(input).trim();
      if (value === '') {
        callbacks.onNotify('名字不能为空', 'warn');
        return;
      }
      overlay.remove();
      onOk(value);
    });

    actions.append(ok, cancel);
    card.append(title, input, actions);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) overlay.remove();
    });
    root.append(overlay);
  };

  /* ── 弹窗：二次确认 ── */
  const confirmThen = (titleText: string, subtitleText: string, onOk: () => void): void => {
    const overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'worldbook-confirm-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    const title = el(doc, 'p', 'nb-exit-title');
    title.textContent = titleText;
    const sub = el(doc, 'p', 'nb-exit-subtitle');
    sub.textContent = subtitleText;

    const actions = el(doc, 'div', 'nb-exit-actions');
    const ok = el(doc, 'button', 'nb-exit-leave');
    ok.setAttribute('type', 'button');
    ok.setAttribute('data-role', 'worldbook-confirm-ok');
    ok.textContent = '删除';
    ok.addEventListener('click', () => {
      overlay.remove();
      onOk();
    });

    const cancel = el(doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'worldbook-confirm-cancel');
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());

    actions.append(ok, cancel);
    card.append(title, sub, actions);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) overlay.remove();
    });
    root.append(overlay);
  };

  /* ── 起手：读列表 + 读全局设置 ── */
  void (async () => {
    try {
      settings = await callbacks.onReadSettings();
    } catch {
      /* 读不到就用默认值：界面照常可用，保存时才需要真的写进去 */
      settings = { ...DEFAULT_GLOBAL_SETTINGS };
    }
    await reload();
  })();

  return root;
}
