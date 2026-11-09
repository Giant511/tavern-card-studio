/**
 * 「我的卡片」列表（T10.7）。
 *
 * 只做一件事：把服务端 `GET /api/cards` 的结果按
 * `角色名 · cardId · 仓库 · vN` 展示出来，点一行就去看它的历史。
 *
 * **客户端不做任何过滤**。需求明确要求"数据隔离前端不假设"：
 * 前端再加一层按 owner 的过滤，看起来更安全，实际只是把"服务端漏过滤"这件事
 * 藏起来 —— 列表看起来干净了，直连 API 仍然能拿到全部，反而更难发现。
 * 所以这里显示的永远是服务端原样返回的条数。
 *
 * 同理，界面**不声称**"这是你账户的卡"：T10.10 之前服务端还没按账户过滤，
 * 声称了就是假话。真实提示见 `isolationNote()`。
 */

import { askConfirm } from '../contract';
import {
  deleteCard,
  deleteFace,
  listCards,
  moveCard,
  SyncError,
  type CardSummary,
  type SyncConfig,
} from './server-sync.ts';
import { type RepoSummary } from './repo-client.ts';
import { emptyCardsText, isolationNote, toCardRow, type CardRowView } from './card-row.ts';
import type { RepoTokenContext } from './repo-select.ts';
import { describeCapabilities } from '../auth/repo-token.ts';
// 换封面（v0.1.7 修订二）：选图 → 压成仓库资产 → PUT /api/cards/:id/face
import { pickImageFile, readBinaryFile } from '../contract/shell.ts';
import { decodeBinaryFile } from '../session/png-source.ts';
import { uploadFace } from './server-sync.ts';
// 增补二：压缩管线（WebP ≤250KB / 平涂 PNG），决策纯函数在 face-pipeline.ts
import { buildStoreFace, decodeImage } from '../export/face-encode.ts';

export { isolationNote };

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

export interface CardsDialogDeps {
  /** 当前同步配置（含 access 或 legacy 令牌）；未就绪时返回 null */
  getConfig: () => SyncConfig | null;
  /** 是否已用账户登录（决定要不要显示"尚未按账户过滤"的诚实提示） */
  isAccountLogin: () => boolean;
  /**
   * 服务端是否已强制隔离（来自 /api/stats 的 isolationEnforced）。
   *  时**不再显示**未隔离提示 —— 否则就是一句永远为真的免责声明。
   */
  isIsolationEnforced: () => boolean | null;
  onPick?: (cardId: string) => void;
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /** 401 后尝试恢复（续期）；返回 false 表示要回登录界面 */
  onUnauthorized?: () => Promise<boolean>;
  /** 登出（仅账户登录时显示按钮）。登出后本地编辑不受影响 */
  onLogout?: () => Promise<void>;
  /**
   * 取仓库列表（F13.5「移动…」用）。不提供时移动入口直接隐藏 ——
   * 没有仓库列表就没法选目标，摆一个点了没用的按钮比不摆更糟。
   */
  getRepos?: () => Promise<RepoSummary[]>;
  /**
   * 仓库令牌模式上下文（v0.1.3 / F5 后半）。null = 不在该模式。
   *
   * 这个面板需要它做三件事：
   *   ① 顶部提示改成"只显示该仓库的卡片"，而不是账户隔离那句；
   *   ② 「退出」按钮在这个模式下也要显示（= 退出令牌模式，需求第 2 条最后一项）；
   *   ③ 没有 write 范围时隐藏「移动…」「删除」这类写操作。
   */
  getRepoTokenContext?: () => RepoTokenContext | null;
}

/**
 * 隔离提示（实现见 `card-row.ts`，那里是纯函数、可单测）。
 *
 * 只有"账户登录"时才提：legacy 全局令牌本来就该看到全部卡片，
 * 对它说"还没隔离"是废话。而账户登录下不提，用户会误以为列表已经按账户过滤。
 */

export class CardsDialog {
  private readonly overlay: HTMLDivElement;
  private readonly listEl: HTMLElement;
  private readonly noteEl: HTMLElement;
  /**
   * 操作反馈条（v0.1.7 生产反馈：「换封面后没有任何提示」）。
   *
   * 为什么不能复用上面的 `noteEl`：那个是**静态说明**（账户隔离 / 令牌范围），
   * 在 `open()` 里按模式写一次，语义是"这个列表怎么来的"。
   * 操作反馈是"你刚才那次点击的结果"，两者生命周期不同，混用会让说明被覆盖掉。
   *
   * 为什么不能只调 `notify`：它写的是主窗口状态栏，而这个对话框是模态的，
   * 状态栏被遮在下面 —— 用户看到的等价于"什么都没发生"。反馈必须出现在
   * **用户此刻正在看的这个窗口里**。
   */
  private readonly actionNoteEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly logoutButton: HTMLButtonElement;
  /** 显式字段（不用构造函数参数属性）：Node 的类型剥离不支持，测试要导入本文件的纯函数 */
  private readonly deps: CardsDialogDeps;
  private rows: CardSummary[] = [];
  private busy = false;
  /** 仓库令牌模式上下文（open 时定一次，渲染各行时用；null = 不在该模式） */
  private tokenContext: RepoTokenContext | null = null;

  constructor(deps: CardsDialogDeps) {
    this.deps = deps;
    this.overlay = el('div', 'modal-overlay');
    this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.dataset['role'] = 'cards-dialog';

    const panel = el('div', 'modal wide cards-modal');

    const head = el('div', 'modal-head');
    const title = el('h2', 'modal-title', '我的卡片');
    const close = el('button', 'icon-btn', '×');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    const body = el('div', 'modal-body');

    const tools = el('div', 'cards-toolbar');
    this.searchInput = el('input', 'input') as HTMLInputElement;
    this.searchInput.type = 'search';
    this.searchInput.placeholder = '按角色名或 cardId 搜索';
    this.searchInput.dataset['role'] = 'cards-search';
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void this.reload();
    });
    this.refreshButton = el('button', 'btn small', '刷新') as HTMLButtonElement;
    this.refreshButton.type = 'button';
    this.refreshButton.dataset['role'] = 'cards-refresh';
    this.refreshButton.addEventListener('click', () => void this.reload());
    tools.append(this.searchInput, this.refreshButton);

    this.noteEl = el('p', 'field-hint cards-note');
    this.noteEl.dataset['role'] = 'cards-note';
    this.noteEl.hidden = true;

    this.countEl = el('p', 'field-hint cards-count');
    this.countEl.dataset['role'] = 'cards-count';
    this.countEl.textContent = '尚未加载';

    this.actionNoteEl = el('p', 'cards-action-note');
    this.actionNoteEl.dataset['role'] = 'cards-action-note';
    this.actionNoteEl.hidden = true;

    this.listEl = el('div', 'cards-list');
    this.listEl.dataset['role'] = 'cards-list';

    body.append(tools, this.noteEl, this.countEl, this.actionNoteEl, this.listEl);

    const foot = el('div', 'modal-foot');
    // 登出放在这个面板：它是"账户"这一面唯一常驻的地方，
    // 再单独做一个账户管理页，会出现两处都能登出、状态各刷一半的问题。
    this.logoutButton = el('button', 'btn ghost', '登出') as HTMLButtonElement;
    this.logoutButton.type = 'button';
    this.logoutButton.dataset['role'] = 'account-logout';
    this.logoutButton.hidden = true;
    this.logoutButton.addEventListener('click', () => void this.logout());
    const done = el('button', 'btn', '关闭');
    done.type = 'button';
    done.addEventListener('click', () => this.close());
    foot.append(this.logoutButton, el('span', 'foot-note', '列表内容由服务端返回，客户端不做二次过滤'), done);

    panel.append(head, body, foot);
    this.overlay.append(panel);
    // 点遮罩**不关闭**（2026-10-29 用户要求）：子窗口只能由它自己的按钮或 × 关闭。
    // 去掉这条监听是有意的，不是漏了 —— 误触空白处关掉正在填的表单比多点一次 × 更烦。
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.overlay.hidden) this.close();
    });

    document.body.append(this.overlay);
  }

  async open(): Promise<void> {
    this.overlay.hidden = false;
    /*
     * 顶部提示三选一（v0.1.3 / F5 后半）。
     *
     * 令牌模式下**不能**再显示"账户隔离"那句：它讲的是"你的卡片按账户过滤"，
     * 而令牌模式下过滤的依据是**仓库 + scope**，两句话说的不是一件事。
     * 说错比不说更糟 —— 用户会以为自己看到的是自己账户的全部卡。
     */
    const tokenContext = this.deps.getRepoTokenContext?.() ?? null;
    if (tokenContext !== null) {
      this.noteEl.hidden = false;
      this.noteEl.textContent =
        `${tokenContext.label}：只显示该仓库的卡片，能力受令牌范围限制（${describeCapabilities(tokenContext.caps)}）。`;
    } else {
      const note = isolationNote(this.deps.isAccountLogin(), this.deps.isIsolationEnforced());
      this.noteEl.hidden = note === null;
      if (note !== null) this.noteEl.textContent = note;
    }
    /*
     * 「退出」按钮在令牌模式下也要出现 —— 需求要求"退出登录 = 退出该模式"。
     * 文案要改：这时候没有"登出账户"这回事，只有"不再使用这把令牌"。
     */
    const showLogout = this.deps.onLogout !== undefined && (this.deps.isAccountLogin() || tokenContext !== null);
    this.logoutButton.hidden = !showLogout;
    this.logoutButton.textContent = tokenContext !== null ? '退出令牌模式' : '登出';
    this.tokenContext = tokenContext;
    this.searchInput.value = '';
    await this.reload();
    this.searchInput.focus();
  }

  close(): void {
    this.overlay.hidden = true;
  }

  /**
   * 静默预取（v0.1.2 追加任务第 4 条）。
   *
   * 登录成功后立刻拉一次"我的卡片"，这样用户点「我的卡片」时不用再等一轮；
   * 失败一律忽略 —— 预取是锦上添花，不该在登录成功的那一刻弹红条。
   */
  async preload(): Promise<void> {
    if (this.deps.getConfig() === null || this.busy) return;
    try {
      const items = await listCards(this.deps.getConfig() as SyncConfig, { limit: 100 });
      this.renderRows(items);
      document.body.dataset['cardsPreloaded'] = String(items.length);
    } catch {
      // 预取失败保持安静：用户点开面板时会自己重试并看到真实错误
    }
  }

  private async logout(): Promise<void> {
    if (!this.deps.onLogout) return;
    this.logoutButton.disabled = true;
    try {
      await this.deps.onLogout();
    } finally {
      this.logoutButton.disabled = false;
      this.close();
    }
  }

  /** 当前渲染的行（截图与端到端断言用，省得去解析文本） */
  get rendered(): CardRowView[] {
    return this.rows.map(toCardRow);
  }

  private async reload(): Promise<void> {
    if (this.busy) return;
    const config = this.deps.getConfig();
    if (!config) {
      // 注意：这里**不能**先写 countEl 再调 renderRows([]) ——
      // 后者会把计数覆盖成「共 0 张」，于是"未连接"看起来像"这个账户没有卡"。
      // 曾据此误判过（截图里只剩一句"共 0 张"）。空态与失败态要分开渲染。
      //
      // 文案也要分两种（v0.1.2 追加任务）：没登录时说的是"登录后可查看"，
      // 而不是"未连接服务端" —— 后者把"还没登录"错报成"连不上"，
      // 正是本次要修的那类错序表述。
      this.renderNotice(
        this.deps.isAccountLogin()
          ? '还没配置服务端地址：请在「设置」里填写，或点「连接本机服务端」。'
          : '登录后可查看你自己的卡片。',
      );
      return;
    }

    this.busy = true;
    this.refreshButton.disabled = true;
    this.countEl.textContent = '正在加载…';
    try {
      const items = await listCards(config, { limit: 100, query: this.searchInput.value.trim() });
      this.renderRows(items);
    } catch (error) {
      if (error instanceof SyncError && error.code === 'UNAUTHORIZED' && this.deps.onUnauthorized) {
        const recovered = await this.deps.onUnauthorized();
        if (recovered) {
          // 续期成功后重试一次；再失败就如实报错，不无限重试
          this.busy = false;
          this.refreshButton.disabled = false;
          await this.reload();
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      this.renderNotice(`加载失败：${message}`);
      this.deps.notify(`加载卡片列表失败：${message}`, 'bad');
    } finally {
      this.busy = false;
      this.refreshButton.disabled = false;
    }
  }

  /**
   * 失败/未连接态：列表区显示原因，计数区显示「—」。
   *
   * 与空态（`共 0 张` + 引导文案）严格区分：把"取不到"画成"没有"，
   * 用户会去建卡/重传，而真正的问题在网络或登录态。
   */
  private renderNotice(text: string): void {
    this.rows = [];
    this.listEl.replaceChildren();
    const note = el('p', 'cards-empty', text);
    note.dataset['role'] = 'cards-empty';
    this.listEl.append(note);
    this.countEl.textContent = '—';
  }

  /**
   * 删除一张卡（软删）。
   *
   * 确认框里刻意写清"进回收站、可恢复"，而不是笼统的"确定删除？"：
   * 前者让用户敢点（知道能撤销），后者会让人宁可不敢用这个功能。
   */
  private async confirmDelete(view: CardRowView): Promise<void> {
    // 必须 await：壳里 window.confirm 被 dialog 插件改写成异步，同步真值判断会直接放行
    const ok = await askConfirm(
      `删除「${view.name}」？\n\n` +
        '它会进入回收站：立刻从列表消失，但保留期内可以恢复。\n' +
        '（彻底清除只能由管理员在管理面板里做，且不可恢复。）',
      '删除卡片',
    );
    if (!ok) return;

    const config = this.deps.getConfig();
    if (!config) {
      this.deps.notify('请先登录或填写服务端地址', 'warn');
      return;
    }
    try {
      await deleteCard(config, view.cardId);
      this.deps.notify(`已删除「${view.name}」（可在回收站恢复）`, 'ok');
      await this.reload();
    } catch (error) {
      this.deps.notify(`删除失败：${error instanceof Error ? error.message : String(error)}`, 'bad');
    }
  }

  /** 移动：列出现有仓库让用户选（不弹输入框 —— 仓库 id 没人记得住） */
  /**
   * 设置/更换卡片封面（v0.1.7 修订二；增补二改成走压缩管线）。
   *
   * 四步：选图 → **压成仓库资产**（WebP ≤250KB 或平涂 PNG）→ PUT → 重载列表。
   * **不产生版本**：服务端只改卡面资产并记一条审计事件。
   *
   * ## 为什么这里必须把原图压完再传（增补二的核心）
   *
   * 上一版直接把用户选的原始字节传上去，服务端上限 8MB —— 于是仓库里躺着
   * 一堆 1–3MB 的封面，而它们的作用只是"列表里那张缩略图"。
   * 现在的规矩是：**进仓库的那一份必须是压过的**，250KB 是硬线。
   * 服务端也收紧了同样的线（413 兜底），两边一起守。
   *
   * ## 为什么压缩结论要 notify 出来
   *
   * 用户选了一张 4MB 的照片、最后存进去 180KB，这个事实**必须让他看见** ——
   * 否则下次他会怀疑"我明明选了高清图，为什么显示得有点糊"。
   * 提示里同时给"压缩后"和"原图"，这是需求指定的格式。
   */
  /**
   * 在当前窗口里显示一条操作结果（v0.1.7 生产反馈）。
   *
   * 这是**必须**的：`notify` 写主窗口状态栏，而本对话框是模态的，
   * 状态栏被遮住 ⇒ 用户点完"换封面"什么都看不到，以为没生效。
   * 所有会改状态的按钮（换封面 / 移除封面）都必须把结果送到这里。
   */
  private showAction(message: string, kind: 'ok' | 'warn' | 'bad' | 'info'): void {
    this.actionNoteEl.hidden = false;
    this.actionNoteEl.textContent = message;
    this.actionNoteEl.className = `cards-action-note ${kind}`;
  }

  private async changeFace(view: CardRowView): Promise<void> {
    const config = this.deps.getConfig();
    if (config === null) {
      this.deps.notify('请先连接服务端再设置封面', 'warn');
      return;
    }
    const path = await pickImageFile();
    if (path === null) return;

    try {
      const file = await readBinaryFile(path);
      const decoded = await decodeBinaryFile(file);
      const originalBytes = decoded.bytes.byteLength;
      const fileName = path.split(/[\\/]/).pop() ?? path;

      const image = await decodeImage(decoded.bytes, fileName);
      let built;
      try {
        built = await buildStoreFace(
          image,
          decoded.bytes,
          fileName.toLowerCase().endsWith('.png'),
        );
      } finally {
        image.bitmap.close();
      }

      if (!built.ok || built.bytes === null || built.mime === null) {
        // 压不下去：文案已经是"换一张更简洁的"，不要在这里再包一层技术名词
        this.showAction(built.note, 'bad');
        return;
      }

      const result = await uploadFace(config, view.cardId, built.bytes, built.mime);
      this.showAction(
        result.changed ? `已更新「${view.name}」的封面 · ${built.note}` : '封面没有变化，未重新上传',
        result.changed ? 'ok' : 'info',
      );
      await this.reload();
    } catch (error) {
      this.showAction(
        `设置封面失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }

  /**
   * 移除卡面（v0.1.7 增补一）。
   *
   * 与"换封面"同一条规则：**不产生版本、写一条审计日志**（服务端 deleteFace 负责）。
   * 移除后这张卡回到"无卡面"态 —— 列表里显示占位，推 ST 时走默认卡面兜底链。
   *
   * 要确认一次：卡面是用户挑过的，删了就得重挑。但它又不是版本，
   * 回滚救不回来，所以这个确认不能省。
   */
  private async removeFace(view: CardRowView): Promise<void> {
    const config = this.deps.getConfig();
    if (config === null) {
      this.showAction('请先连接服务端再移除封面', 'warn');
      return;
    }
    const ok = await askConfirm(
      `移除「${view.name}」的封面？\n\n` +
        '移除后这张卡会变成「无卡面」，推送到 SillyTavern 时会用默认卡面。\n' +
        '封面不属于版本历史，这一步不能靠回滚恢复。',
      '移除封面',
    );
    if (!ok) return;

    try {
      const result = await deleteFace(config, view.cardId);
      this.showAction(
        result.deleted ? `已移除「${view.name}」的封面` : '这张卡本来就没有封面',
        result.deleted ? 'ok' : 'info',
      );
      await this.reload();
    } catch (error) {
      this.showAction(
        `移除封面失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }

  private async openMove(view: CardRowView): Promise<void> {
    const config = this.deps.getConfig();
    if (!config || !this.deps.getRepos) {
      this.deps.notify('请先登录', 'warn');
      return;
    }

    let repos: RepoSummary[];
    try {
      repos = await this.deps.getRepos();
    } catch (error) {
      this.deps.notify(`读取仓库失败：${error instanceof Error ? error.message : String(error)}`, 'bad');
      return;
    }
    if (repos.length === 0) {
      this.deps.notify('还没有任何仓库', 'warn');
      return;
    }

    const overlay = el('div', 'modal-overlay modal-overlay-top');
    overlay.dataset['role'] = 'move-dialog';
    const panel = el('div', 'modal');
    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', `移动「${view.name}」`));
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => overlay.remove());
    head.append(closeBtn);

    const body = el('div', 'modal-body');
    body.append(el('p', 'field-hint', `当前仓库：${view.repo}。选择目标仓库后立即生效（不改内容、不改修改时间）。`));

    const select = el('select', 'input') as HTMLSelectElement;
    select.dataset['role'] = 'move-repo';
    for (const repo of repos) {
      const option = document.createElement('option');
      option.value = repo.id;
      option.textContent = `${repo.name}${repo.isDefault ? '（默认）' : ''} · ${String(repo.cardCount)} 张`;
      if (repo.isDefault) option.selected = true;
      select.append(option);
    }
    body.append(select);

    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn ghost', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => overlay.remove());
    const confirm = el('button', 'btn primary', '移动');
    confirm.type = 'button';
    confirm.dataset['role'] = 'move-confirm';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const result = await moveCard(config, view.cardId, select.value);
        overlay.remove();
        // 目标与当前相同：服务端回 moved:false。如实说"没动"，不要假装成功
        this.deps.notify(result.moved ? `已移动到「${view.name}」的新仓库` : '它已经在这个仓库里了', result.moved ? 'ok' : 'info');
        await this.reload();
      } catch (error) {
        confirm.disabled = false;
        this.deps.notify(`移动失败：${error instanceof Error ? error.message : String(error)}`, 'bad');
      }
    });
    foot.append(cancel, confirm);

    panel.append(head, body, foot);
    overlay.append(panel);
    document.body.append(overlay);
  }

  private renderRows(items: CardSummary[]): void {
    this.rows = items;
    this.listEl.replaceChildren();

    if (items.length === 0) {
      const empty = el('p', 'cards-empty', emptyCardsText(this.searchInput.value));
      empty.dataset['role'] = 'cards-empty';
      this.listEl.append(empty);
      this.countEl.textContent = '共 0 张';
      return;
    }

    for (const item of items) {
      const view = toCardRow(item);
      /*
       * 行从 `<button>` 改成 `<div>`（F13.5）。
       *
       * 原因是 HTML 不允许按钮嵌套按钮：行本身要可点（看历史），又要放
       * 「移动… / 删除…」两个按钮。硬塞会得到一个点哪儿都触发"看历史"的行，
       * 而删除永远点不到 —— 这种"能渲染但点不动"的问题只有真机点得出来。
       */
      const row = el('div', 'cards-row');
      row.dataset['cardId'] = view.cardId;
      if (view.deleted) row.classList.add('deleted');

      const main = el('button', 'cards-row-main');
      main.type = 'button';
      main.title = `查看「${view.name}」的版本历史`;
      const nameEl = el('span', 'cards-row-name', view.name);
      const idEl = el('span', 'cards-row-id', view.cardId);
      const repoEl = el('span', 'cards-row-repo', view.repo);
      const verEl = el('span', 'cards-row-version', view.version);
      main.append(nameEl, idEl, repoEl, verEl);

      /*
       * 「无卡面」占位（v0.1.7 增补一）。
       *
       * 只在**没有卡面**时插入。有卡面时 `facePlaceholder` 是 null，
       * 这里什么都不加 —— 不能加一个空 `<span>`，那会占掉一格的宽度，
       * 列表里就出现一排对不齐的缝隙。
       *
       * 用 `dataset.role` 而不是纯样式类：验收脚本要能直接查
       * "这张卡是不是显示成无卡面"，而不要去猜样式名。
       */
      if (view.facePlaceholder !== null) {
        const faceEl = el('span', 'cards-row-face-none', view.facePlaceholder);
        faceEl.dataset['role'] = 'card-face-none';
        faceEl.title = '这张卡还没有封面。推送时用默认卡面，也可以在这里补一张。';
        main.append(faceEl);
      }

      main.addEventListener('click', () => {
        this.deps.onPick?.(view.cardId);
        this.close();
      });

      const actions = el('div', 'cards-row-actions');
      /*
       * 写操作按 scope 置灰（v0.1.3 / F5 后半）：
       * 需求「无写 → 无删除/移动」。这里用 disabled + title 而不是整块隐藏 ——
       * 隐藏会让人以为"这版客户端没有这个功能"，置灰加说明了才指向真实原因
       * （令牌缺 write，去找签发人）。
       */
      const caps = this.tokenContext?.caps ?? null;
      const noWrite = caps !== null && !caps.canMove;
      const writeReason = this.tokenContext?.reason.move ?? '';

      /*
       * 「设置封面… / 换封面…」（v0.1.7 修订二）。
       *
       * 文案随"有没有卡面"变：选中图之后传的是**卡面资产**，不产生版本 ——
       * 所以这个按钮与「移动…」「删除…」并排，而不是藏在版本历史里。
       * 已删除的卡不给入口（服务端会对已删除卡拒绝写操作）。
       */
      if (!view.deleted) {
        const faceButton = el('button', 'btn small', view.hasFace ? '换封面…' : '设置封面…');
        faceButton.type = 'button';
        faceButton.dataset['role'] = 'card-face';
        faceButton.dataset['cardId'] = view.cardId;
        faceButton.disabled = noWrite;
        if (noWrite) faceButton.title = writeReason;
        faceButton.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.changeFace(view);
        });
        actions.append(faceButton);

        /*
         * 「移除封面」只在**已有卡面**时出现（v0.1.7 增补一）。
         *
         * 不给无卡面的卡渲染一个禁用的"移除"按钮：那是在告诉用户
         * "这里有个功能你用不了"，而实际上是这个功能对这张卡没有意义。
         * 不渲染 = 它本来就不存在。
         */
        if (view.hasFace) {
          const removeButton = el('button', 'btn small', '移除封面…');
          removeButton.type = 'button';
          removeButton.dataset['role'] = 'card-face-remove';
          removeButton.dataset['cardId'] = view.cardId;
          removeButton.disabled = noWrite;
          if (noWrite) removeButton.title = writeReason;
          removeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            void this.removeFace(view);
          });
          actions.append(removeButton);
        }
      }

      if (this.deps.getRepos) {
        const moveButton = el('button', 'btn small', '移动…');
        moveButton.type = 'button';
        moveButton.dataset['role'] = 'card-move';
        moveButton.dataset['cardId'] = view.cardId;
        moveButton.disabled = noWrite;
        if (noWrite) moveButton.title = writeReason;
        moveButton.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.openMove(view);
        });
        actions.append(moveButton);
      }
      const deleteButton = el('button', 'btn small danger', '删除…');
      deleteButton.type = 'button';
      deleteButton.dataset['role'] = 'card-delete';
      deleteButton.dataset['cardId'] = view.cardId;
      deleteButton.disabled = noWrite;
      if (noWrite) deleteButton.title = this.tokenContext?.reason.delete ?? '';
      deleteButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.confirmDelete(view);
      });
      actions.append(deleteButton);

      row.append(main, actions);
      this.listEl.append(row);
    }

    this.countEl.textContent = `共 ${items.length} 张`;
  }
}
