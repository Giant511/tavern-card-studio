/**
 * 用户设定管理页（2026-11-04，第三十批）。
 *
 * ## 用户要求
 *
 * > 我想实现 ST 原生网页里面的功能，包括修改人设名字、为所有消息设置为该用户、
 * > 人设世界书、以及当前聊天角色可切换用户人数
 *
 * 对应到这一页：
 *
 * | ST 原生 | 这里 |
 * |---|---|
 * | 当前人设 + 名字 | 列表 + 名字输入 |
 * | 用户设定描述 | 多行描述 |
 * | 插入位置（在故事字符串/提示词管理器中…） | 位置下拉 + 深度 |
 * | 「更多…」里的世界书 | 人设世界书下拉 |
 * | 链接（默认 / 角色 / 聊天） | 绑定角色多选 |
 * | 全局设置三条 | 三个开关 |
 * | （ST 的批量操作） | 「为所有消息设置为该用户」按钮 |
 *
 * ## 形态：每套人设是一个**抽屉**（2026-11-04 用户要求）
 *
 * > 在用户设定管理里面我的人设一栏做成抽屉式的，比如点击人设1后展开
 * > 对应的人设1参数，支持上传更改显示人设缩略图
 *
 * 原来：列表在上、**选中那一套**的编辑区单独吊在最下面。选 A 改完想改 B，
 * 得滚回上面点 B、再滚下来 —— 而且"选中（正在用）"和"展开（正在改）"
 * 是同一个动作，想改一套但不想切过去就做不到。
 *
 * 现在：点一行 = 展开/收起它自己的参数（就地展开在它下面）。
 * **"展开"与"正在使用"彻底分开**：
 *
 * ```text
 *   点一行         → 展开 / 收起（只看不改也不切）
 *   抽屉里「使用这一套」 → 真正切换当前人设
 * ```
 *
 * 缩略图也在这里：上传后存成 96×96 的 data URL（几 KB），落盘跟着人设走。
 *
 * ## 为什么每处都写清"改了会发生什么"
 *
 * 这一页的每一项都会影响模型看到的上下文，但用户看不见那个上下文。
 * 不写清楚的后果是"我明明填了，怎么没效果"。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { fieldRow } from './field-row.ts';
import { buildTopbar } from './chat-settings.ts';
import { makeSelectTrigger } from './select-popover.ts';
import {
  DEFAULT_PERSONA_NAME,
  type Persona,
  type PersonaPosition,
  type PersonaState,
  activePersona,
  addPersona,
  removePersona,
  selectPersona,
  updatePersona,
} from '@tcs/shared';
import type { PromptRole } from '@tcs/shared';

/** 位置的可选值（给用户看的说法，不是 ST 的常量名） */
const POSITION_OPTIONS: ReadonlyArray<{ value: PersonaPosition; label: string }> = [
  { value: 'in_prompt', label: '放在提示词里（默认）' },
  { value: 'top_an', label: '放在作者注释上方' },
  { value: 'bottom_an', label: '放在作者注释下方' },
  { value: 'at_depth', label: '按深度插进对话' },
  { value: 'none', label: '不插入' },
];

/** 身份的可选值 */
const ROLE_OPTIONS: ReadonlyArray<{ value: PromptRole; label: string }> = [
  { value: 'system', label: '系统' },
  { value: 'user', label: '用户' },
  { value: 'assistant', label: '角色' },
];

export interface PersonaPageCallbacks {
  onBack: () => void;
  /** 状态变了就整份交回（外壳负责落盘） */
  onChange: (next: PersonaState) => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /**
   * 让用户挑一张头像（2026-11-04 用户要求「支持上传更改显示人设缩略图」）。
   *
   * 缩到 96×96 的 JPEG 后写回该人设的 `avatar`；取消则什么都不做。
   * 缩放与编码都交给外壳（页面在 Node 里跑，没有 canvas）。
   */
  onPickAvatar?: (personaId: string) => void;
  /**
   * 「为所有消息设置为该用户」。
   *
   * 外壳负责真的去改当前聊天的消息并存盘。返回改了几条。
   */
  onRelabelMessages: (name: string) => Promise<number>;
  /** 可选的世界书名（人设世界书下拉用） */
  listWorldbooks: () => Promise<string[]>;
  /** 可绑定的角色（avatar 名单，用于"允许每个角色多个设定"） */
  listCharacters: () => Promise<Array<{ avatar: string; name: string }>>;
}

/** 生成一个稳定 id（时间戳 + 随机，本地唯一足够） */
function makeId(): string {
  return `p_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 造一个字段行 → 已抽到 `field-row.ts`（两个页面共用一份，避免分叉） */

export function renderPersonaPage(
  doc: DocLike,
  state: PersonaState,
  callbacks: PersonaPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-persona');
  root.setAttribute('data-role', 'persona-page');
  root.append(buildTopbar(doc, '用户设定', callbacks.onBack));

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);
  const list = el(doc, 'div', 'nb-list');
  scroller.append(list);

  /* ── 应用状态：统一走这里，保证每次都落盘 ── */
  let current = state;
  const apply = (next: PersonaState): void => {
    current = next;
    callbacks.onChange(next);
    /* 就地重绘：不整页重载，保住滚动位置与焦点上下文 */
    paint();
  };

  /* 世界书名与角色名先异步取，取不到就空（下拉显示"无"） */
  let worldbooks: string[] = [];
  let characters: Array<{ avatar: string; name: string }> = [];

  /**
   * 当前**展开**的人设 id（2026-11-04，抽屉式）。
   *
   * 与 `current.selectedId`（**正在使用**的那一套）是**两个独立状态** ——
   * 这正是抽屉式的意义：可以展开 B 改它的描述，而聊天里仍在用 A。
   *
   * 初始值取 `selectedId`：第一次进来先展开正在用的那套，用户最可能改它。
   * `null` = 全收起。
   */
  let openId: string | null = state.selectedId;

  /**
   * 所有在途的「长按删除」计时器（2026-11-07，用户报的真缺陷）。
   *
   * ## 用户的原话
   *
   * > 设定页里面改完设定名字直接点击 tab 会直接提示是否删除人设
   *
   * ## 真因（真机探针 `.verify/probe-persona-longpress-delete.mjs` 证实）
   *
   * 删除是**长按 600ms** 触发的。而 `paint()` 做的是
   * `list.replaceChildren()` —— **把每一行都销毁重建**。
   *
   * ```text
   *   手指按在行上              touchstart → 启动 600ms 计时器
   *   期间发生一次 paint         replaceChildren() 把那行删了
   *     （改名 change / 切开关 / 切 Tab 重绘都算）
   *   ⇒ 那行的 touchend 永远不会再来
   *   ⇒ cancel() 不执行
   *   ⇒ 计时器照常到期 → askDelete() → 弹出「删除「X」？」
   * ```
   *
   * 探针实测：
   *
   * ```text
   *   对照：按住 200ms 后松开（不重绘）      → 删除框 0 个 ✓
   *   实验：按住 150ms 时触发一次 paint 再松 → 删除框 1 个 ✗
   *                                          标题「删除「格兹」？」
   * ```
   *
   * 用户改完名字点 Tab，正好就是"按住的时候发生了一次重绘"——
   * 输入框失焦触发 `change`，`change` 触发 `apply`，`apply` 触发 `paint()`。
   *
   * ## 为什么现在才出现
   *
   * 长按删除是 2026-11-04 加的，`paint()` 逐键重绘是 2026-11-05 才改的
   * （"改名要立刻更新列表标题"）。两边各自都合理，凑在一起才出事 ——
   * 这类"两个正确决定合成一个缺陷"最容易被漏掉。
   *
   * ## 修法（两道一起，缺一不可）
   *
   * ```text
   *   ① 主动：paint() 一开始就清掉所有在途计时器（下面的 cancelAllLongPress）
   *   ② 兜底：计时器到期时校验那个行**是否还在文档里**（见 makeRow）
   * ```
   *
   * 只做①不够：将来若有人绕过 paint 直接改 DOM（比如别的函数只换某一截），
   * 计时器又会变孤儿。只做②也不够：那要等 600ms 才失效，期间 DOM 已乱。
   */
  const pendingLongPress = new Set<() => void>();

  /** 清掉所有在途的长按计时器（`paint()` 开头调） */
  const cancelAllLongPress = (): void => {
    for (const cancel of pendingLongPress) cancel();
    pendingLongPress.clear();
  };

  /**
   * 节点还在不在文档里。
   *
   * `ElLike` 没有 `isConnected`（接口刻意只留少数成员），这里用一次断言
   * 读真实 DOM 的可选属性 —— 与 `shell.ts` 读 `doc.querySelector` 同一处取舍。
   *
   * **拿不到 `isConnected` 时返回 true**（= 认为还活着）：宁可偶尔多弹一次框，
   * 也不要因为读不到属性就把正常的长按删除功能整个废掉。
   */
  const stillConnected = (node: unknown): boolean => {
    const probe = node as { isConnected?: boolean } | null;
    if (probe === null || probe === undefined) return true;
    if (typeof probe.isConnected !== 'boolean') return true;
    return probe.isConnected;
  };

  const paint = (): void => {
    /*
     * ★★★ 先清长按计时器，再销毁节点（2026-11-07）。
     *
     * 顺序不能反：反了的话 `replaceChildren()` 已经把节点摘掉，
     * 计时器里那层"节点还在吗"的兜底会生效，但**清理**这件事得先做 ——
     * 否则每次重绘都会留下一个等到期才自我了断的计时器。
     */
    cancelAllLongPress();
    list.replaceChildren();

    /* ═══ ① 列表 ═══ */
    const head = el(doc, 'div', 'nb-settings-group');
    head.textContent = '我的人设';
    list.append(head);

    if (current.personas.length === 0) {
      const empty = el(doc, 'p', 'nb-note');
      empty.setAttribute('data-role', 'persona-empty');
      empty.textContent =
        `还没有用户设定。你现在用的是默认名字「${DEFAULT_PERSONA_NAME}」——` +
        '建一套就能改名字、写自己是谁。';
      list.append(empty);
    }

    for (const one of current.personas) {
      list.append(makeRow(one));

      /*
       * 抽屉**紧随它自己那一行**展开，而不是全页共用一个编辑区。
       *
       * 好处：「我改的是哪一套」在屏幕上永远是自明的 ——
       * 编辑区就在那行下面，隔一行都算远。
       */
      if (openId === one.id) list.append(makeDrawer(one));
    }

    /* ── 新建 ── */
    const addBtn = el(doc, 'button', 'nb-btn');
    addBtn.setAttribute('type', 'button');
    addBtn.setAttribute('data-role', 'persona-add');
    addBtn.textContent = '＋ 新建一套';
    addBtn.addEventListener('click', () => {
      apply(addPersona(current, '新设定', makeId()));
    });
    list.append(addBtn);

    /*
     * ═══ ② 编辑区不再吊在页面底部 ═══
     *
     * 原来这里是“选中那一套”的编辑区（`makeEditor(activePersona(current))`）。
     * 抽屉式之后每套人设在**自己那一行下面**展开，这里就没有内容了。
     *
     * 留着它会同时出现两份编辑区（展开了 A，底部又出来 A 的那份），
     * 改一处另一处不刷新 —— 那是“同一件事写两遍”的经典后果。
     */

    /* ═══ ③ 全局设置 ═══ */
    const globalHead = el(doc, 'div', 'nb-settings-group');
    globalHead.textContent = '全局设置';
    list.append(globalHead);

    list.append(
      makeToggle(
        '切换用户设定时显示提示',
        '每次换人设时在底部提示一句，避免"我切了但没注意"。',
        current.notifyOnSwitch,
        'persona-notify',
        (next) => apply({ ...current, notifyOnSwitch: next }),
      ),
      makeToggle(
        '允许每个角色与多个用户设定绑定',
        '关掉后每个角色只能用当前这一套。开着才能在聊天里按角色挑不同人设。',
        current.allowMultiBinding,
        'persona-multi',
        (next) => apply({ ...current, allowMultiBinding: next }),
      ),
      makeToggle(
        '自动将选择的用户设定绑定到聊天',
        '换人设时顺便把它记到当前聊天上，下次进这段对话还是它。',
        current.autoBindToChat,
        'persona-autobind',
        (next) => apply({ ...current, autoBindToChat: next }),
      ),
    );
  };

  /* ── 列表一行 ── */
  const makeRow = (one: Persona): ElLike => {
    const selected = current.selectedId === one.id;
    const row = el(doc, 'button', 'nb-listitem');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'persona-item');
    row.setAttribute('data-id', one.id);
    if (selected) row.setAttribute('data-selected', 'true');

    const main = el(doc, 'span', 'nb-listitem-main');
    const name = el(doc, 'span', 'nb-listitem-title');
    /* 选中标记用文字而不是图标：图标在暗色下不明确，文字没有歧义 */
    name.textContent = selected ? `✓ ${one.name}` : one.name;
    /*
     * 选中态另加一个属性，供 CSS 画一个「使用中」小标签。
     * 只靠 `✓` 前缀的话，用户看不出"这是正在用的"还是"这是勾选项"。
     */
    if (selected) row.setAttribute('data-active', 'true');
    /*
     * 展开态单独一个属性（2026-11-04）。
     *
     * 它与 `data-active`（正在使用）**不是一回事**：可以展开 B 改它的描述，
     * 而聊天里仍在用 A。CSS 靠这个属性把这一行的下圆角与下边距归零，
     * 好让抽屉接成一张卡。
     */
    if (openId === one.id) row.setAttribute('data-open', 'true');

    const hint = el(doc, 'span', 'nb-listitem-sub');
    /*
     * 副标题显示**描述的第一行**（截断），而不是"有描述/没描述"。
     * 用户有多套人设时要靠这一行分辨哪套是哪套 ——
     * 只说"有描述"等于没说。
     */
    const firstLine = one.description.split('\n').find((line) => line.trim() !== '') ?? '';
    hint.textContent = firstLine === '' ? '还没写描述' : firstLine.trim().slice(0, 40);
    main.append(name, hint);

    /*
     * 右侧标记表达**两个独立状态**，所以用两个位置：
     *
     * ```text
     *   ●（选中徽标）  这一套正在聊天里使用   ← 放在标题后面
     *   ›/⌄（箭头）    抽屉展开 / 收起          ← 保持在最右侧
     * ```
     *
     * 原来一个字符同时表示两者，抽屉化之后会互相覆盖 ——
     * 展开 B 时箭头变了，就分不出"B 是展开着"还是"B 正在用"。
     */
    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.setAttribute('data-open', String(openId === one.id));
    chevron.textContent = openId === one.id ? '⌄' : '›';

    row.append(main, chevron);

    /* 点 = 选中。长按 = 删除（与角色列表同一套手势，用户不用学两遍） */
    let timer: ReturnType<typeof setTimeout> | null = null;
    let longPressed = false;
    const cancel = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const start = (): void => {
      longPressed = false;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        pendingLongPress.delete(cancel);
        /*
         * ★★★ 到期时校验这一行还在不在文档里（2026-11-07）。
         *
         * 这期间 `paint()` 可能已经把整份列表重建了 —— 那时手指按着的
         * 是**已经被摘掉的旧节点**，它的 touchend 永远不会到。
         * 这种情况下这次长按已经不成立，绝不能弹删除框。
         *
         * 这是"清理计时器"之外的第二道保险：万一将来有别的路径绕过
         * `paint()` 直接换 DOM，这里仍能挡住。
         */
        if (!stillConnected(row)) return;
        longPressed = true;
        askDelete(one);
      }, 600);
      /* 登记，供 `paint()` 统一清理（节点被销毁时 touchend 不会来） */
      pendingLongPress.add(cancel);
    };
    const end = (): void => {
      cancel();
      pendingLongPress.delete(cancel);
    };
    row.addEventListener('touchstart', start);
    row.addEventListener('touchend', end);
    row.addEventListener('touchmove', end);
    row.addEventListener('mousedown', start);
    row.addEventListener('mouseup', end);
    row.addEventListener('mouseleave', end);
    /*
     * 点 = 展开 / 收起抽屉（2026-11-04 改）。
     *
     * 原来是"点 = 切换当前人设"。改成抽屉后**两者必须分开**：
     * 想改一套但还在用另一套是很正常的（试写新设定、先不切过去）。
     * 真正切换的动作移进抽屉里的「使用这一套」按钮。
     */
    row.addEventListener('click', () => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      openId = openId === one.id ? null : one.id;
      paint();
    });

    return row;
  };

  /* ── 删除确认（复用退出弹窗的样式，全 App 一套） ── */
  const askDelete = (one: Persona): void => {
    const overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'persona-delete-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    const title = el(doc, 'p', 'nb-exit-title');
    title.textContent = `删除「${one.name}」？`;
    const sub = el(doc, 'p', 'nb-exit-subtitle');
    /*
     * 说清代价：只删设定本身，聊天记录里的消息不受影响。
     *
     * 不写清的话用户会担心"删了人设我的对话会不会没了"——
     * 那是另一个量级的损失。
     */
    sub.textContent = '只删除这套设定，已经聊过的内容不受影响。';

    const actions = el(doc, 'div', 'nb-exit-actions');
    const ok = el(doc, 'button', 'nb-exit-leave');
    ok.setAttribute('type', 'button');
    ok.setAttribute('data-role', 'persona-delete-confirm');
    ok.textContent = '删除';
    const no = el(doc, 'button', 'nb-exit-stay');
    no.setAttribute('type', 'button');
    no.setAttribute('data-role', 'persona-delete-cancel');
    no.textContent = '取消';

    no.addEventListener('click', () => overlay.remove());
    ok.addEventListener('click', () => {
      overlay.remove();
      apply(removePersona(current, one.id));
    });
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) overlay.remove();
    });

    actions.append(ok, no);
    card.append(title, sub, actions);
    overlay.append(card);
    root.append(overlay);
  };

  /* ── 抽屉：一行展开出来的那一块 ── */
  const makeDrawer = (one: Persona): ElLike => {
    /*
     * 通用类 `nb-drawer` + 本页专属类。
     *
     * 视觉与层级规则全在 `.nb-drawer`（`chat.css` 的「抽屉」那一节），
     * 本页只在 `.nb-persona-drawer` 里写自己那份差异（内边距）。
     */
    const box = el(doc, 'div', 'nb-drawer nb-persona-drawer');
    box.setAttribute('data-role', 'persona-drawer');
    box.setAttribute('data-id', one.id);

    /*
     * 抽屉顶部：头像 + 「使用这一套」。
     *
     * 头像放这里而不是编辑器里面，是因为它是**识别标志** ——
     * 抽屉一展开就要看见"我在改谁"。编辑器里的字段都是内容，会滚走。
     */
    const top = el(doc, 'div', 'nb-persona-drawer-top');

    const avatar = el(doc, 'span', 'nb-avatar nb-persona-avatar');
    avatar.setAttribute('data-role', 'persona-avatar');
    avatar.setAttribute('data-id', one.id);
    avatar.setAttribute('data-state', one.avatar === '' ? 'empty' : 'ready');
    if (one.avatar === '') {
      /* 没设头像：名字首字，与角色列表同一套观感 */
      avatar.textContent = Array.from(one.name.trim())[0] ?? '·';
    } else {
      const img = el(doc, 'img', 'nb-avatar-img');
      img.setAttribute('alt', one.name);
      img.setAttribute('src', one.avatar);
      avatar.replaceChildren(img);
    }

    const topActions = el(doc, 'div', 'nb-persona-drawer-actions');

    const upload = el(doc, 'button', 'nb-btn');
    upload.setAttribute('type', 'button');
    upload.setAttribute('data-role', 'persona-avatar-upload');
    upload.textContent = one.avatar === '' ? '上传头像' : '更换头像';
    upload.addEventListener('click', () => callbacks.onPickAvatar?.(one.id));
    topActions.append(upload);

    if (one.avatar !== '') {
      const clear = el(doc, 'button', 'nb-btn');
      clear.setAttribute('type', 'button');
      clear.setAttribute('data-role', 'persona-avatar-clear');
      clear.textContent = '移除头像';
      clear.addEventListener('click', () => {
        apply(updatePersona(current, one.id, { avatar: '' }));
      });
      topActions.append(clear);
    }

    /*
     * 「使用这一套」：**只有当前没在用它时才出现**。
     *
     * 正在用的那套显示一个静态标记而不是禁用按钮 —— 一个点不动的
     * 按钮会让人以为"坏了"，一句"正在使用"才是答案。
     */
    if (current.selectedId === one.id) {
      const badge = el(doc, 'span', 'nb-persona-active-badge');
      badge.setAttribute('data-role', 'persona-active-badge');
      badge.textContent = '正在使用';
      topActions.append(badge);
    } else {
      const use = el(doc, 'button', 'nb-btn nb-btn--primary');
      use.setAttribute('type', 'button');
      use.setAttribute('data-role', 'persona-use');
      use.setAttribute('data-id', one.id);
      use.textContent = '使用这一套';
      use.addEventListener('click', () => {
        apply(selectPersona(current, one.id));
        if (current.notifyOnSwitch) {
          callbacks.onNotify(`已切换到「${one.name}」`, 'ok');
        }
      });
      topActions.append(use);
    }

    top.append(avatar, topActions);
    box.append(top);

    /* 抽屉正文就是原来那份编辑器 —— 字段一个没改，只是换了位置 */
    box.append(makeEditor(one));

    return box;
  };

  /* ── 编辑区 ── */
  const makeEditor = (one: Persona): ElLike => {
    const box = el(doc, 'div', 'nb-persona-editor');
    box.setAttribute('data-role', 'persona-editor');

    const head = el(doc, 'div', 'nb-settings-group');
    head.textContent = `编辑「${one.name}」`;
    box.append(head);

    /* 名字 */
    const nameField = fieldRow(doc, '名字', '你在故事里的名字。填写后对话里会用它替换 {{user}}。');
    const nameInput = el(doc, 'input', 'nb-input');
    nameInput.setAttribute('type', 'text');
    nameInput.setAttribute('data-role', 'persona-name');
    nameInput.setAttribute('maxlength', '24');
    (nameInput as unknown as HTMLInputElement).value = one.name;
    /*
     * 用 `change` 而不是逐键 `input`：改名会触发整列表重绘（标题要跟着变），
     * 逐键重绘会让输入框在打字过程中失焦。
     */
    nameInput.addEventListener('change', () => {
      const value = (nameInput as unknown as HTMLInputElement).value;
      apply(updatePersona(current, one.id, { name: value }));
    });
    nameField.body.append(nameInput);
    box.append(nameField.row);

    /* 描述 */
    const descField = fieldRow(
      doc,
      '用户设定描述',
      '你来扮演谁。可以写姓名、种族、身份、性格。支持 {{user}} / {{char}}。',
    );
    const descInput = el(doc, 'textarea', 'nb-input nb-input--multiline');
    descInput.setAttribute('rows', '6');
    descInput.setAttribute('data-role', 'persona-description');
    (descInput as unknown as HTMLTextAreaElement).value = one.description;
    /* 描述不触发重绘（没有别的地方依赖它逐字变化），用 change 减少重绘 */
    descInput.addEventListener('change', () => {
      const value = (descInput as unknown as HTMLTextAreaElement).value;
      apply(updatePersona(current, one.id, { description: value }));
    });
    descField.body.append(descInput);
    box.append(descField.row);

    /* 插入位置 */
    const posField = fieldRow(
      doc,
      '插入位置',
      '这段描述放在上下文的哪个位置。不确定就留默认。',
    );
    const posSelect = makeSelectTrigger(doc, {
      label: '插入位置',
      options: POSITION_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
      current: one.position,
    }).el;
    posSelect.setAttribute('data-role', 'persona-position');
    posSelect.addEventListener('click', () => {
      /* `makeSelectTrigger` 自己管面板；选完读 data-value */
      setTimeout(() => {
        const picked = posSelect.getAttribute('data-value');
        const valid = POSITION_OPTIONS.find((opt) => opt.value === picked);
        if (valid !== undefined && valid.value !== one.position) {
          apply(updatePersona(current, one.id, { position: valid.value }));
        }
      }, 400);
    });
    posField.body.append(posSelect);
    box.append(posField.row);

    /* 深度（只在 at_depth 时有意义） */
    if (one.position === 'at_depth') {
      const depthField = fieldRow(
        doc,
        '深度',
        '从最新一条消息往前数第几条插入。数字越大越靠前。',
      );
      const depthInput = el(doc, 'input', 'nb-input');
      depthInput.setAttribute('type', 'number');
      depthInput.setAttribute('min', '0');
      depthInput.setAttribute('max', '100');
      depthInput.setAttribute('inputmode', 'numeric');
      depthInput.setAttribute('data-role', 'persona-depth');
      (depthInput as unknown as HTMLInputElement).value = String(one.depth);
      depthInput.addEventListener('change', () => {
        const value = Number((depthInput as unknown as HTMLInputElement).value);
        if (Number.isFinite(value)) apply(updatePersona(current, one.id, { depth: value }));
      });
      depthField.body.append(depthInput);
      box.append(depthField.row);
    }

    /* 身份 */
    const roleField = fieldRow(
      doc,
      '以什么身份插入',
      '系统 = 背景说明（推荐）；用户 = 当作你说的话；角色 = 当作角色说的话。',
    );
    const roleSelect = makeSelectTrigger(doc, {
      label: '身份',
      options: ROLE_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label })),
      current: one.role,
    }).el;
    roleSelect.setAttribute('data-role', 'persona-role');
    roleSelect.addEventListener('click', () => {
      setTimeout(() => {
        const picked = roleSelect.getAttribute('data-value');
        const valid = ROLE_OPTIONS.find((opt) => opt.value === picked);
        if (valid !== undefined && valid.value !== one.role) {
          apply(updatePersona(current, one.id, { role: valid.value }));
        }
      }, 400);
    });
    roleField.body.append(roleSelect);
    box.append(roleField.row);

    /* 人设世界书 */
    const loreField = fieldRow(
      doc,
      '人设世界书',
      '指定一个世界书，只在这套人设生效时参与匹配。留「不关联」则用聊天的世界书。',
    );
    const loreSelect = makeSelectTrigger(doc, {
      label: '人设世界书',
      options: [
        { value: '', label: '不关联' },
        ...worldbooks.map((name) => ({ value: name, label: name })),
      ],
      current: one.lorebook,
    }).el;
    loreSelect.setAttribute('data-role', 'persona-lorebook');
    loreSelect.addEventListener('click', () => {
      setTimeout(() => {
        const picked = loreSelect.getAttribute('data-value');
        if (picked !== null && picked !== one.lorebook) {
          apply(updatePersona(current, one.id, { lorebook: picked }));
        }
      }, 400);
    });
    loreField.body.append(loreSelect);
    box.append(loreField.row);

    /* 绑定角色（对齐 ST 的"链接：默认/角色/聊天"里的"角色"） */
    if (characters.length > 0) {
      const bindField = fieldRow(
        doc,
        '绑定到角色',
        '不选 = 所有角色都能用（当作默认人设）。选了 = 只在这些角色的对话里出现。',
      );
      const chips = el(doc, 'div', 'nb-tag-row');
      for (const cha of characters) {
        const chosen = one.boundCharacters.includes(cha.avatar);
        const chip = el(doc, 'button', chosen ? 'nb-tag nb-tag--on' : 'nb-tag');
        chip.setAttribute('type', 'button');
        chip.setAttribute('data-role', 'persona-bind-chip');
        chip.setAttribute('data-avatar', cha.avatar);
        chip.textContent = cha.name;
        chip.addEventListener('click', () => {
          const next = chosen
            ? one.boundCharacters.filter((x) => x !== cha.avatar)
            : [...one.boundCharacters, cha.avatar];
          apply(updatePersona(current, one.id, { boundCharacters: next }));
        });
        chips.append(chip);
      }
      bindField.body.append(chips);
      box.append(bindField.row);
    }

    /* 为所有消息设置为该用户 */
    const relabel = el(doc, 'button', 'nb-btn');
    relabel.setAttribute('type', 'button');
    relabel.setAttribute('data-role', 'persona-relabel');
    relabel.textContent = `把这段对话里我的消息都改成「${one.name}」`;
    /*
     * 防重入用标志，不用 `removeAttribute` ——
     * `ElLike` 只有 setAttribute / getAttribute / remove，没有 removeAttribute。
     * 恢复可用态靠下面那次 `paint()`（整块编辑区重建，按钮自然是新的）。
     */
    let relabelBusy = false;
    relabel.addEventListener('click', () => {
      if (relabelBusy) return;
      relabelBusy = true;
      relabel.setAttribute('disabled', 'true');
      void (async () => {
        const count = await callbacks.onRelabelMessages(one.name);
        relabelBusy = false;
        callbacks.onNotify(
          count === 0 ? '这段对话里还没有你的消息' : `已改好 ${String(count)} 条`,
          count === 0 ? 'warn' : 'ok',
        );
        /* 重绘让按钮回到可用态 */
        paint();
      })();
    });
    box.append(relabel);

    const relabelHint = el(doc, 'p', 'nb-note');
    relabelHint.textContent =
      '改了名字之后，这段对话里你自己发过的消息也会显示成新名字。已经发给模型的内容不会变。';
    box.append(relabelHint);

    return box;
  };

  /* ── 开关 ── */
  const makeToggle = (
    labelText: string,
    hintText: string,
    checked: boolean,
    role: string,
    onToggle: (next: boolean) => void,
  ): ElLike => {
    const row = el(doc, 'div', 'nb-field nb-field--switch');
    const label = el(doc, 'label', 'nb-field-label');
    label.textContent = labelText;
    const sw = el(doc, 'input', 'nb-switch');
    sw.setAttribute('type', 'checkbox');
    sw.setAttribute('data-role', role);
    (sw as unknown as HTMLInputElement).checked = checked;
    sw.addEventListener('change', () => {
      onToggle((sw as unknown as HTMLInputElement).checked === true);
    });
    const hint = el(doc, 'span', 'nb-field-hint');
    hint.textContent = hintText;
    row.append(label, sw, hint);
    return row;
  };

  /* 首次绘制 + 异步补数据（世界书名、角色名） */
  paint();

  void (async () => {
    const [books, cast] = await Promise.all([
      callbacks.listWorldbooks().catch(() => []),
      callbacks.listCharacters().catch(() => []),
    ]);
    worldbooks = books;
    characters = cast;
    /* 拿到数据后重绘一次，编辑区里的两个下拉才有选项 */
    if (books.length > 0 || cast.length > 0) paint();
  })();

  return root;
}
