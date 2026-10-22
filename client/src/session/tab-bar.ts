/**
 * 标签栏（T9.2）—— 只负责渲染，不做状态决策。
 *
 * 设计原则：**标签栏是会话列表的投影，不是第二个状态源**。
 * 它从 `getSessions()` 拿数据、把用户动作转成回调，自己不保存任何卡片状态。
 * 这样"改名后标签要刷新"只需要调用 `refresh()` 重读一遍，
 * 不需要在改名逻辑里再手动同步一份文本（那正是两处状态不一致的来源）。
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

/** 渲染标签所需的最小信息（不直接依赖 CardSession，便于单测） */
export interface TabItem {
  id: string;
  /** 完整标签文字：卡名 + 脏标记（由会话的 `label` 给出） */
  label: string;
  /** 是否未落盘（用于 tooltip 与视觉区分） */
  persisted: boolean;
  /** 卡名，用于 tooltip 与无障碍标签 */
  displayName: string;
  /** 角色卡 ID */
  cardId: string;
}

export interface TabBarCallbacks {
  /** 点击标签切换 */
  onActivate: (id: string) => void;
  /** 点击标签上的关闭按钮 */
  onClose: (id: string) => void;
  /** 点击「+」新建 */
  onNew: () => void;
}

/**
 * 顶部标签栏。
 *
 * 结构：
 *   <div class="tabbar">
 *     <div class="tabbar-scroll">   ← 横向滚动容器
 *       <button class="tab is-active">…<span class="tab-close">×</span></button>
 *       …
 *     </div>
 *     <button class="tab-new">+</button>   ← 固定在最右，不随滚动移动
 *   </div>
 *
 * 为什么「+」放在滚动容器外面：标签多到需要滚动时，
 * 如果「+」也在滚动区里，用户得先横向滚到底才能新建 —— 这是很常见的体验缺陷。
 */
export class TabBar {
  private readonly root: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly newButton: HTMLButtonElement;
  private items: readonly TabItem[] = [];
  private activeId: string | null = null;

  constructor(container: HTMLElement, private readonly callbacks: TabBarCallbacks) {
    this.root = el('div', 'tabbar');
    this.root.setAttribute('role', 'tablist');
    this.root.setAttribute('aria-label', '已打开的角色卡');

    this.scroll = el('div', 'tabbar-scroll');
    this.root.append(this.scroll);

    this.newButton = el('button', 'tab-new', '＋');
    this.newButton.type = 'button';
    this.newButton.title = '新建角色卡（Ctrl+N）';
    this.newButton.setAttribute('aria-label', '新建角色卡');
    this.newButton.addEventListener('click', () => this.callbacks.onNew());
    this.root.append(this.newButton);

    container.append(this.root);
  }

  /** 更新数据并重绘 */
  render(items: readonly TabItem[], activeId: string | null): void {
    this.items = items;
    this.activeId = activeId;
    this.repaint();
  }

  /**
   * 就地刷新（不改变标签集合，只更新文字/状态）。
   *
   * 用途：改名、置脏之后让标签文字跟上。
   *
   * ⚠️ 必须**重新取数**再重绘。曾经这里只调 `repaint()` 而不更新 `this.items`，
   * 结果改名后标签文字纹丝不动 —— 因为 repaint 读的还是打开时那份旧快照。
   * 标签栏刻意不持有状态，所以"刷新"的正确含义是"再读一遍数据源"。
   *
   * 与 `render()` 的分工：`render` 用于标签集合本身变化（新建/关闭），
   * 会做增删与顺序调整；`refresh` 只在集合不变时更新内容，
   * 避免重建 DOM 导致焦点与滚动位置丢失。
   */
  refresh(items: readonly TabItem[], activeId: string | null): void {
    this.items = items;
    this.activeId = activeId;
    this.repaint();
  }

  get element(): HTMLElement {
    return this.root;
  }

  private repaint(): void {
    const existing = new Map<string, HTMLElement>();
    for (const node of this.scroll.querySelectorAll<HTMLElement>('.tab')) {
      const id = node.dataset['sessionId'];
      if (id) existing.set(id, node);
    }

    const keep = new Set(this.items.map((item) => item.id));
    // 先删掉已经不存在的
    for (const [id, node] of existing) {
      if (!keep.has(id)) node.remove();
    }

    // 再按顺序更新/插入
    let cursor: HTMLElement | null = this.scroll.firstElementChild as HTMLElement | null;
    for (const item of this.items) {
      let node = existing.get(item.id) ?? null;
      if (!node) {
        node = this.buildTab(item);
      }
      this.updateTab(node, item);
      if (cursor === node) {
        cursor = cursor.nextElementSibling as HTMLElement | null;
      } else {
        this.scroll.insertBefore(node, cursor);
      }
    }

    // 新标签出现时滚到可见，否则用户会以为"点了没反应"
    const activeNode = this.scroll.querySelector<HTMLElement>('.tab.is-active');
    activeNode?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private buildTab(item: TabItem): HTMLElement {
    const tab = el('button', 'tab');
    tab.type = 'button';
    tab.dataset['sessionId'] = item.id;
    tab.setAttribute('role', 'tab');

    const text = el('span', 'tab-label');
    const close = el('span', 'tab-close', '×');
    close.setAttribute('role', 'button');
    close.setAttribute('aria-label', `关闭 ${item.displayName}`);
    close.title = '关闭（Ctrl+W）';
    tab.append(text, close);

    tab.addEventListener('click', (event) => {
      // 点关闭按钮时不要再触发"切换"
      if ((event.target as HTMLElement).classList.contains('tab-close')) return;
      this.callbacks.onActivate(item.id);
    });
    // 关闭按钮用 mousedown 更稳：click 在拖拽/长按时可能被吞
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onClose(item.id);
    });
    // 中键关闭：多标签界面的通行习惯
    tab.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        this.callbacks.onClose(item.id);
      }
    });

    return tab;
  }

  private updateTab(node: HTMLElement, item: TabItem): void {
    const active = item.id === this.activeId;
    node.classList.toggle('is-active', active);
    node.setAttribute('aria-selected', String(active));

    const text = node.querySelector('.tab-label');
    if (text && text.textContent !== item.label) text.textContent = item.label;

    // tooltip 说清三件事：卡名、ID、是否已落盘
    node.title = `${item.displayName}\nID：${item.cardId}\n${item.persisted ? '已保存到磁盘' : '未保存到磁盘'}`;

    // 未落盘给一个视觉标记（虚线左边框），与"已落盘"区分开
    node.classList.toggle('is-unpersisted', !item.persisted);
  }
}
