/**
 * 卡片信息对话框（v0.1.6 / 用户反馈「导出的 creator_notes 还是示例卡的话」）。
 *
 * ## 为什么必须单独开一个框
 *
 * 八板块编辑的是正文，而 `creator / character_version / creator_notes /
 * system_prompt / post_history_instructions / tags / character_book.name /
 * character_book.description` 这一层**从来没有任何编辑入口**。用户从示例卡起手时，
 * 这些值会一路被导出成别人的文案 —— 这不是显示问题，是把错误内容交付出去。
 *
 * ## 三个刻意的取舍
 *
 * 1. **不含角色名**：标题栏已经能改（带重名校验与去重）。同一个值两个编辑器，
 *    两套规则迟早分叉 —— 这是本项目反复吃过的亏。
 * 2. **不拦保存**：所有字段都允许为空。空的 `creator_notes` 是合法的，
 *    拦住只会逼用户瞎填。真正要防的是"把示例卡的话交付出去"，那由提示解决。
 * 3. **两种落点分开**：`保存` 只改当前这张卡；`设为新卡默认值` 改的是配置，
 *    影响**以后新建**的卡。混成一个按钮会让"我只想改这张"变成"以后都这样"。
 */

import type { CardInfo } from '../session/card-info';
import {
  detectInheritedFields,
  formatTagsInput,
  normalizeCardInfo,
  parseTagsInput,
  readCardInfo,
  sameCardInfo,
} from '../session/card-info';
import type { UnifiedCard } from '@tcs/shared';

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

export interface CardInfoDialogOptions {
  /** 打开时读当前卡（点开那一刻取，避免对话框持有过期引用） */
  getCard: () => UnifiedCard;
  /** 点「保存」：把归一化后的值交给调用方写回会话 */
  onSave: (info: CardInfo) => void;
  /** 点「设为新卡默认值」：只存配置，不改当前卡 */
  onSaveAsDefaults: (info: CardInfo) => Promise<void> | void;
  /** 落日志（保存默认值失败时不许静默） */
  logError?: (line: string) => void;
}

interface Field {
  key: keyof CardInfo;
  label: string;
  /** 单行还是多行；多行的行高按内容量给 */
  multiline: boolean;
  rows?: number;
  placeholder?: string;
  /** 这个字段在 ST 里叫什么，写清楚比让用户猜好 */
  hint?: string;
  /**
   * 占半行（与下一个半行字段并排）。
   *
   * 只为**短字段**开：作者、角色版本这类通常十来个字符，
   * 独占一整行会让对话框在纵向拉长到必须滚动 —— 而滚动之后
   * 底部按钮就容易被挤出屏幕（第一版就是这样，截图里按钮贴着窗口下沿）。
   */
  half?: boolean;
  /**
   * 该字段走"空则删键"（世界书那两个）。界面上提示一句，
   * 否则用户清空后看到 JSON 里键消失会以为是 bug。
   */
  removable?: boolean;
}

const FIELDS: Field[] = [
  {
    key: 'creator',
    label: '作者',
    multiline: false,
    half: true,
    placeholder: '留空则不署作者名',
    hint: '会显示在角色的「创建者」信息里。',
  },
  {
    key: 'characterVersion',
    label: '角色版本',
    multiline: false,
    half: true,
    placeholder: '如 1.0',
    hint: '这张卡自己的版本号，与软件版本无关，用来区分改动。',
  },
  {
    key: 'creatorNotes',
    label: '创作说明',
    multiline: true,
    rows: 4,
    placeholder: '写给人看的说明：设定思路、注意事项、推荐玩法等',
    hint: '给读者看的备注，不会占用模型上下文。',
  },
  {
    key: 'tags',
    label: '标签',
    multiline: false,
    placeholder: '用逗号或顿号分隔，如 日常、治愈、书店',
    hint: '用于在 SillyTavern 里筛选和分组。重复的会自动去掉，顺序按你写的保留。',
  },
  {
    key: 'systemPrompt',
    label: '系统提示',
    multiline: true,
    rows: 4,
    placeholder: '留空 = 使用 SillyTavern 当前的系统提示',
    hint: '留空就跟随 SillyTavern 的设置；填写会覆盖它，除非确定否则建议留空。',
  },
  {
    key: 'postHistoryInstructions',
    label: '历史后指令',
    multiline: true,
    rows: 4,
    placeholder: '留空 = 不加额外指令',
    hint: '会加在聊天记录之后、模型回复之前，用来约束这一轮的写法。',
  },
  {
    key: 'worldbookName',
    label: '世界书名称',
    multiline: false,
    placeholder: '留空则不填',
    hint: '会显示在 SillyTavern 的世界书列表里。',
    removable: true,
  },
  {
    key: 'worldbookDescription',
    label: '世界书说明',
    multiline: true,
    rows: 3,
    placeholder: '留空则不填',
    hint: '给这本文档写一句说明，方便日后认出它。',
    removable: true,
  },
];

export class CardInfoDialog {
  private readonly overlay: HTMLDivElement;
  /** 可滚动的字段区（头部与底部按钮不在里面，所以它们永远可见） */
  private readonly scroller: HTMLDivElement;
  /** 字段网格（两列；half 字段并排，其余整行） */
  private readonly body: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly defaultsButton: HTMLButtonElement;
  private inputs = new Map<keyof CardInfo, HTMLInputElement | HTMLTextAreaElement>();
  private initial: CardInfo | null = null;
  private busy = false;

  constructor(private readonly options: CardInfoDialogOptions) {
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'card-info-dialog';

    /*
     * 结构：头部（固定） + 滚动区（字段） + 底部（固定）。
     *
     * 第一版把整块 `.modal` 设成 `overflow: auto`，同时字段区自己还有 `max-height`
     * —— 两层滚动条，滚到一半时底部按钮跟着内容跑到屏幕外，截图里按钮就贴着窗口下沿。
     * 现在把滚动**只**交给中间那一层，头部与按钮永远在视口内。
     */
    const panel = el('div', 'modal card-info-modal');
    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', '卡片信息'));

    const close = el('button', 'btn small ghost', '×');
    close.type = 'button';
    close.title = '关闭（Esc）';
    close.addEventListener('click', () => this.close());
    head.append(close);
    panel.append(head);

    /*
     * 顶部说明 + 继承提示。
     * 提示区默认隐藏，只在检测到"看起来还是示例卡的值"时出现 ——
     * 常驻一块空提示栏会让真正有话说的时候被当成背景噪声。
     */
    this.scroller = el('div', 'card-info-scroller');
    const intro = el(
      'p',
      'card-info-intro muted',
      '这些信息会一起写进角色卡。角色名请直接在标题栏修改。',
    );
    this.scroller.append(intro);

    this.hint = el('div', 'card-info-hint');
    this.hint.hidden = true;
    this.scroller.append(this.hint);

    this.body = el('div', 'card-info-grid');
    this.scroller.append(this.body);

    panel.append(this.scroller);

    /*
     * 状态条放在滚动区外面（紧贴底部按钮上方）：
     * 「已存为默认值」这类反馈必须看得见，而它最可能出现的时刻正是
     * 用户刚滚到最下面点按钮的时候。
     */
    this.status = el('div', 'card-info-status');
    this.status.hidden = true;
    panel.append(this.status);

    const foot = el('div', 'modal-foot');
    this.defaultsButton = el('button', 'btn ghost card-info-defaults', '设为新卡默认值');
    this.defaultsButton.type = 'button';
    this.defaultsButton.title = '把作者、版本、创作说明、标签、系统提示存成默认值，以后新建的卡自动带上';
    this.defaultsButton.addEventListener('click', () => void this.saveAsDefaults());

    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());

    this.saveButton = el('button', 'btn primary', '保存');
    this.saveButton.type = 'button';
    this.saveButton.addEventListener('click', () => this.commit());

    foot.append(this.defaultsButton, cancel, this.saveButton);
    panel.append(foot);
    this.overlay.append(panel);

    // 点遮罩关闭（点面板内部不关）
    this.overlay.addEventListener('click', (event) => {
      if (event.target === this.overlay) this.close();
    });
    /*
     * 自己挂到 body 上，与 `NewCardDialog` 一致 —— 不让调用方再记一句 mount()。
     * 少一个"必须记得调"的步骤，就少一类"对话框永远不出现"的故障。
     */
    document.body.append(this.overlay);
    // Esc 关闭：只在对话框可见时抢键，否则会和编辑器抢
    document.addEventListener('keydown', (event) => {
      if (this.overlay.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      }
    });
  }

  /** 对话框是否开着（调试入口与验收脚本读它） */
  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(): void {
    const card = this.options.getCard();
    this.initial = readCardInfo(card);
    this.buildFields(this.initial);
    this.renderInheritedHint(this.initial);
    this.setStatus('');
    this.overlay.hidden = false;

    // 焦点给第一个输入框：打开就能直接敲字，不必再点一次
    const first = this.inputs.get('creator');
    if (first !== undefined) first.focus();
  }

  close(): void {
    this.overlay.hidden = true;
    this.initial = null;
    this.inputs.clear();
    this.body.replaceChildren();
  }

  /** 读当前表单里的值（归一化前） */
  private current(): CardInfo {
    const read = (key: keyof CardInfo): string => {
      const node = this.inputs.get(key);
      return node === undefined ? '' : node.value;
    };
    return {
      creator: read('creator'),
      characterVersion: read('characterVersion'),
      creatorNotes: read('creatorNotes'),
      tags: parseTagsInput(read('tags')),
      systemPrompt: read('systemPrompt'),
      postHistoryInstructions: read('postHistoryInstructions'),
      worldbookName: read('worldbookName'),
      worldbookDescription: read('worldbookDescription'),
    };
  }

  private buildFields(info: CardInfo): void {
    this.inputs.clear();
    this.body.replaceChildren();

    for (const field of FIELDS) {
      const row = el('div', field.half === true ? 'card-info-row card-info-row--half' : 'card-info-row');
      const label = el('label', 'card-info-label', field.label);
      const inputId = `card-info-${field.key}`;
      label.htmlFor = inputId;

      const value = field.key === 'tags' ? formatTagsInput(info.tags) : info[field.key];
      const input =
        field.multiline === true
          ? el('textarea', 'card-info-input')
          : el('input', 'card-info-input');
      input.id = inputId;
      if (field.multiline === true) {
        (input as HTMLTextAreaElement).rows = field.rows ?? 3;
      } else {
        (input as HTMLInputElement).type = 'text';
      }
      input.value = typeof value === 'string' ? value : '';
      if (field.placeholder !== undefined) input.placeholder = field.placeholder;
      this.inputs.set(field.key, input);

      /*
       * 字段说明拆成两句、分两行显示：
       * 第一句是"这个字段对应 ST 的什么"，第二句（可清空的字段才有）是
       * "清空会怎样"。揉成一句时两种信息混在一起，读起来像一坨注释。
       */
      const hint = el('div', 'card-info-field-hint muted', field.hint ?? '');
      if (field.removable === true) {
        hint.append(el('span', 'card-info-field-note', '留空则不写入这一项。'));
      }

      row.append(label, input, hint);
      this.body.append(row);
    }
  }

  /**
   * 继承提示。
   *
   * 措辞刻意写成"可能"而不是"一定是"：示例卡的文案，用户当然也可能是自己想写
   * 一模一样的话（概率低但不为零）。这是提示，不阻断任何操作。
   */
  private renderInheritedHint(info: CardInfo): void {
    const inherited = detectInheritedFields(info);
    if (inherited.length === 0) {
      this.hint.hidden = true;
      this.hint.replaceChildren();
      return;
    }
    this.hint.replaceChildren();
    this.hint.append(el('strong', 'card-info-hint-title', '以下几项可能不是你填写的内容'));
    /*
     * 一项一行。第一版把四五个值用顿号串成一句话（截图里就是一整段），
     * 读者要自己在一行里挑出"哪几个字段有问题"—— 而这种提示的全部价值
     * 就在于让人一眼扫到是哪几项。
     */
    /*
     * 只列**哪几项**，不重复贴值。
     *
     * 两个理由：
     *   1. 值就在下面的输入框里，再贴一遍是重复；而且这些值可能很长
     *      （创作说明那段有一整句），贴出来会把提示条撑成一大块。
     *   2. 这些值里可能有开发期的原文（我们从示例卡起的文案就带着
     *      "round-trip" 这种词），照原样贴到界面上等于把别人的措辞搬到用户眼前。
     */
    const list = el('ul', 'card-info-hint-list');
    for (const item of inherited) {
      /*
       * 类加在**内层 span** 上，不是 `li` 上。
       *
       * `.card-info-hint-label` 带着 `flex: 0 0 5.5em` —— 给 `li` 加这个类，
       * 它在纵向 flex 列表里就变成"固定 5.5em 高"，四项撑出两百多像素的空白
       * （第一版截图里提示条占了半个弹窗）。同一个类放进 span，才是"标签列定宽"。
       */
      const li = el('li');
      li.append(el('span', 'card-info-hint-label', item.label));
      list.append(li);
    }
    this.hint.append(list);
    this.hint.append(
      el('span', 'card-info-hint-foot', '确认后按需要修改或留空即可。'),
    );
    this.hint.hidden = false;
  }

  private setStatus(text: string): void {
    if (text === '') {
      this.status.hidden = true;
      this.status.textContent = '';
      return;
    }
    this.status.hidden = false;
    this.status.textContent = text;
  }

  private commit(): void {
    if (this.busy) return;
    const next = normalizeCardInfo(this.current());
    // 没改就什么都不做：免得"点开又保存"被记成一次内容变更（会把卡置脏）
    if (this.initial !== null && sameCardInfo(this.initial, next)) {
      this.close();
      return;
    }
    const onSave = this.options.onSave;
    this.close();
    onSave(next);
  }

  private async saveAsDefaults(): Promise<void> {
    if (this.busy) return;
    const next = normalizeCardInfo(this.current());
    this.busy = true;
    this.defaultsButton.disabled = true;
    try {
      await this.options.onSaveAsDefaults(next);
      this.setStatus('已存为默认值：以后新建的卡会自动带上这些内容。当前这张卡没有改动。');
    } catch (error) {
      // 不静默：写配置失败必须让用户知道，否则他以为存上了
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.setStatus(`保存默认值失败：${message}`);
      this.options.logError?.(`[card-info] 存新卡默认值失败：${message}`);
    } finally {
      this.busy = false;
      this.defaultsButton.disabled = false;
    }
  }
}
