/**
 * 角色选择页（v0.1.7 / 第五批问题二；第二十九批加长按删除与下拉刷新）。
 *
 * ## 为什么要有它
 *
 * 用户报："聊天页没有任何角色可选，找不到此前要求内置的
 * 「测试用-夜航小助手」卡。"
 *
 * 取证发现这里有**两个**断点，都得修：
 *
 * 1. 测试卡生成函数从不被调用 ⇒ 卡不在库里（Kotlin 侧已补种）；
 * 2. `shell.ts:587` 的 `onPickCharacter: async () => null` ——
 *    点「选择角色」**什么都不会发生**，因为回调直接返回 null（= 取消）。
 *
 * ## 交互（2026-11-04 第二十九批新增两条）
 *
 * | 操作 | 结果 |
 * |---|---|
 * | 点一行 | 选中该角色 |
 * | **长按一行** | 弹操作框：导出并分享 / 删除（含全部聊天记录） |
 * | **在顶部下拉** | 重新从引擎拉一次角色列表 |
 *
 * 长按原来直奔"删除确认"。2026-11-04 用户要求加分享之后，同一个弹窗
 * 承担两个动作 —— 副标题改成中性的说明，删除的原因写在按钮上，
 * 免得只想分享的人以为自己在删东西。
 *
 * ### 用户原话
 *
 * > 1、选择角色时长按删除设备（是彻底删除并且 ST 内无该角色及其相关数据和聊天记录）
 * > 2、下拉刷新角色（重新从 ST 内获取最新角色角色）
 *
 * ## 为什么删除确认框画在这里，不交给外壳
 *
 * 删除是**这一页**的局部动作，弹窗应该压在这一页上面。
 * 交给外壳就得走 `renderPage()` 重绘，而重绘会把整个页面换掉 ——
 * 用户的滚动位置、长按的对象全丢了。
 *
 * 外壳只负责"真的去删"（它拿得到 `bridge` 且要过连接门）。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
import { makeAvatar } from './avatar.ts';
import type { ShareOutcome } from './share-card.ts';
import type { CharacterSummary } from '@tcs/shared';

/**
 * 长按判定时长。
 *
 * 600ms 是移动端的常见取值（Android 系统长按是 500ms，iOS 约 500ms）。
 * 取太短会和"点一下"抢；取太长用户会以为没反应。
 */
const LONG_PRESS_MS = 600;

/**
 * 触发下拉刷新需要拉下的距离。
 *
 * 64px ≈ 一根手指宽的一半。太小会在正常滚动时误触，
 * 太大用户拉不到会以为坏了。
 */
const PULL_THRESHOLD_PX = 64;

/** 删除的结果 */
export interface DeleteOutcome {
  ok: boolean;
  /** 给用户看的一句话（成功/失败都要有） */
  detail: string;
}

export interface CharacterPickerCallbacks {
  /** 拉列表。返回 null 表示失败（错误原因由外壳转成 note 给） */
  load: () => Promise<CharacterSummary[] | null>;
  /** 失败时给一句如实的话（引擎没起 / 读失败 / 空库） */
  describeFailure?: () => { message: string; hint: string };
  /** 用户选了一个 */
  onPick: (character: CharacterSummary) => void;
  /** 用户返回 */
  onBack: () => void;
  /** 重试 */
  onRetry: () => void;
  /**
   * 取角色头像缩略图（2026-11-04 用户要求「支持显示角色缩略图，最好圆形」）。
   *
   * 可选：不给就只显示首字占位圆。这样 Node 里的面板测试
   * 不必为了一个装饰性的图去造一套桥。
   */
  loadThumbnail?: (avatar: string) => Promise<string | null>;
  /**
   * 用户确认删除某个角色。
   *
   * 外壳负责真的调引擎（它拿得到 bridge 且要过连接门）。
   * 返回 `ok: true` 才会刷新列表 —— 失败时列表保持原样，
   * 否则用户会看到"角色消失了但其实没删掉"。
   */
  onDelete?: (character: CharacterSummary) => Promise<DeleteOutcome>;
  /**
   * 把这张卡导出成 PNG 分享出去（2026-11-04 用户要求）。
   *
   * 可选：不给就**不显示分享按钮**，而不是显示一个点了没反应的按钮。
   */
  onShare?: (character: CharacterSummary) => ShareOutcome;
}

/** 从 unknown 事件里取第一个触点的 Y 坐标 */
function touchY(event: unknown): number | null {
  const e = event as { touches?: ArrayLike<{ clientY?: number }> };
  const first = e.touches?.[0];
  return typeof first?.clientY === 'number' ? first.clientY : null;
}

/**
 * 渲染角色选择页。
 *
 * 列表加载是异步的，先画骨架再填 —— 否则用户点进来看到空白几百毫秒，
 * 会以为卡点坏了。
 */
export function renderCharacterPicker(
  doc: DocLike,
  callbacks: CharacterPickerCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-picker');
  root.setAttribute('data-role', 'character-picker');

  // ── 顶栏 ──
  const topbar = el(doc, 'div', 'nb-topbar');
  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'picker-back');
  back.setAttribute('aria-label', '返回');
  back.textContent = '‹';
  back.addEventListener('click', callbacks.onBack);

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = '选择角色';
  topbar.append(back, title);
  root.append(topbar);

  /*
   * 下拉刷新提示条。
   *
   * 放在滚动容器**上方**（不参与滚动），用高度动画显出来。
   * 塞进列表里会跟着滚，用户看不到"正在刷新"这个反馈。
   */
  const pullHint = el(doc, 'div', 'nb-pull-hint');
  pullHint.setAttribute('data-role', 'picker-pull-hint');
  pullHint.textContent = '';
  root.append(pullHint);

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);

  const body = el(doc, 'div', 'nb-list');
  body.setAttribute('data-role', 'picker-list');
  scroller.append(body);

  /** 正在加载/删除时禁止并发操作 */
  let busy = false;

  /**
   * 加载并渲染列表。
   *
   * 抽成函数是因为有三个地方要它：首次渲染、下拉刷新、删除成功后。
   * 抽出来之前，"删除后刷新"只能整页重绘 —— 那会把长按的目标行也换掉。
   */
  const reload = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    pullHint.textContent = '正在读取角色…';
    pullHint.setAttribute('data-state', 'loading');

    try {
      const items = await callbacks.load();
      body.replaceChildren();

      if (items === null) {
        pullHint.textContent = '';
        pullHint.setAttribute('data-state', 'idle');
        /*
         * 失败：按真实原因给话。
         *
         * 与设置页同一个纪律 —— 不能说"服务没起来"而实际是在跑。
         */
        const note = callbacks.describeFailure?.();
        const text = el(doc, 'p', 'nb-note');
        text.setAttribute('data-kind', 'warn');
        text.textContent =
          note === undefined ? '读不到角色列表。' : `${note.message}\n${note.hint}`;
        body.append(text);

        const retry = el(doc, 'button', 'nb-btn');
        retry.setAttribute('type', 'button');
        retry.setAttribute('data-role', 'picker-retry');
        retry.textContent = '重试';
        retry.addEventListener('click', () => void reload());
        body.append(retry);
        return;
      }

      pullHint.textContent = '';
      pullHint.setAttribute('data-state', 'idle');

      if (items.length === 0) {
        /*
         * 空库。这一句很重要：用户会怀疑"是不是没装卡"。
         * 明确告诉他库里确实没有，而不是让页面一片空白。
         */
        const empty = el(doc, 'p', 'nb-note');
        empty.setAttribute('data-role', 'picker-empty');
        empty.textContent =
          '角色库里还没有角色。内置的测试角色会在引擎启动后自动补进来 —— 下拉刷新试试。';
        body.append(empty);

        const retry = el(doc, 'button', 'nb-btn');
        retry.setAttribute('type', 'button');
        retry.setAttribute('data-role', 'picker-retry');
        retry.textContent = '重试';
        retry.addEventListener('click', () => void reload());
        body.append(retry);
        return;
      }

      for (const item of items) {
        body.append(makeRow(item));
      }
    } finally {
      busy = false;
      if (pullHint.getAttribute('data-state') === 'loading') {
        pullHint.textContent = '';
        pullHint.setAttribute('data-state', 'idle');
      }
    }
  };

  /* ── 删除确认框 ── */
  /*
   * 画在 root 上层而不是替换页面：替换会把用户的滚动位置丢掉，
   * 而"我刚长按的那一行"在重绘后也不同一个 DOM 了。
   */
  let overlay: ElLike | null = null;

  const closeDialog = (): void => {
    if (overlay === null) return;
    overlay.remove();
    overlay = null;
  };

  const askDelete = (item: CharacterSummary): void => {
    if (callbacks.onDelete === undefined || overlay !== null) return;

    overlay = el(doc, 'div', 'nb-exit-overlay');
    overlay.setAttribute('data-role', 'picker-delete-dialog');

    const card = el(doc, 'div', 'nb-exit-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = el(doc, 'p', 'nb-exit-title');
    title.textContent = item.name;

    const subtitle = el(doc, 'p', 'nb-exit-subtitle');
    /*
     * 必须说清"连聊天记录一起删"和"不能恢复"。
     *
     * 只说"删除角色"的话，用户会以为只是从列表里移除 ——
     * 而实际上 ST 那边是 `fs.rm` 整个聊天目录。
     */
    /*
     * 副标题说明**分享**这件事（默认动作），删除的原因放到删除按钮上。
     *
     * 原来这里写的是"会连聊天记录一起删掉，不能恢复" —— 那是删除专属警告。
     * 现在这个弹窗既是分享入口又是删除入口，把它写死成删除警告会让
     * 只想分享的人以为自己点了删除。
     */
    subtitle.textContent = '可以把它导出成 PNG 发给别人，对方导入后就能用同一张卡。';

    const actions = el(doc, 'div', 'nb-exit-actions');

    const confirm = el(doc, 'button', 'nb-exit-leave');
    confirm.setAttribute('type', 'button');
    confirm.setAttribute('data-role', 'picker-delete-confirm');
    /*
     * 文案要说清"连聊天记录一起删"。
     *
     * 只说"删除"的话，用户会以为只是从列表里移除 ——
     * 而实际上引擎那边是 `fs.rm` 整个聊天目录。
     */
    confirm.textContent = '删除（含全部聊天记录）';

    const cancel = el(doc, 'button', 'nb-exit-stay');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('data-role', 'picker-delete-cancel');
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeDialog);

    confirm.addEventListener('click', () => {
      const run = callbacks.onDelete;
      if (run === undefined) return;
      confirm.setAttribute('disabled', 'true');

      void (async () => {
        const outcome = await run(item);
        closeDialog();
        if (outcome.ok) {
          void reload();
        } else {
          /*
           * 失败要留在**顶部提示条**上，不能只弹一个 3 秒就没的 toast：
           * 用户刚点完删除，需要知道"到底删没删成"。
           *
           * 不用 `body.prepend()` —— `ElLike` 没这个方法，而且放进列表里
           * 会跟着滚动跑出去。顶部这条一直在视野里。
           */
          pullHint.textContent = `没删掉：${outcome.detail}`;
          pullHint.setAttribute('data-state', 'error');
          pullHint.setAttribute('data-role', 'picker-delete-error');
        }
      })();
    });

    const share = el(doc, 'button', 'nb-exit-stay');
    share.setAttribute('type', 'button');
    share.setAttribute('data-role', 'picker-share');
    share.textContent = '导出并分享';
    share.addEventListener('click', () => {
      const run = callbacks.onShare;
      if (run === undefined) return;

      /*
       * 分享要读整张 PNG（几百 KB）+ 跨桥编码，耗时一秒左右。
       * 先禁用防连点，但不关弹窗 —— 关掉之后失败提示就无处可显示
       * （那是原生分享面板之外唯一的反馈）。
       */
      share.setAttribute('disabled', 'true');
      const outcome = run(item);

      if (outcome.ok) {
        closeDialog();
        return;
      }

      share.removeAttribute('disabled');
      pullHint.textContent = `没分享成：${outcome.reason ?? '未知原因'}`;
      pullHint.setAttribute('data-state', 'error');
      pullHint.setAttribute('data-role', 'picker-share-error');
    });

    /* 有 onShare 才画分享按钮：没接能力就不给一个点了没反应的按钮 */
    if (callbacks.onShare !== undefined) actions.append(share);
    actions.append(confirm, cancel);
    card.append(title, subtitle, actions);
    overlay.append(card);
    overlay.addEventListener('click', (event) => {
      if ((event as { target?: unknown }).target === overlay) closeDialog();
    });
    root.append(overlay);
  };

  /** 造一行 */
  function makeRow(item: CharacterSummary): ElLike {
    const row = el(doc, 'button', 'nb-listitem');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'picker-item');
    row.setAttribute('data-avatar', item.avatar);

    /*
     * 圆形头像（2026-11-04）。
     *
     * 没有 `loadThumbnail` 时它就是一个首字占位圆 —— 仍然比纯文字好扫，
     * 且不会因为"这张卡没封面"留一个空圈。
     */
    const avatar = makeAvatar(doc, {
      avatar: item.avatar,
      name: item.name,
      load: callbacks.loadThumbnail ?? (() => Promise.resolve(null)),
      size: 44,
    });

    const main = el(doc, 'span', 'nb-listitem-main');
    const name = el(doc, 'span', 'nb-listitem-title');
    name.textContent = item.name;

    const hint = el(doc, 'span', 'nb-listitem-sub');
    /*
     * 副标题说"有没有聊过" —— 用户最关心的就是"点进去是不是接着上次"。
     * 不显示 avatar 文件名：那是我们的数据结构，不是他能理解的东西
     * （与 `verify-ui-copy.mjs` 那条红线同源）。
     */
    hint.textContent = item.lastChat === '' ? '还没聊过' : '有历史对话';
    main.append(name, hint);

    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    row.append(avatar, main, chevron);

    /*
     * ── 点与长按的区分 ──
     *
     * ## 为什么不能只靠 click + setTimeout
     *
     * 长按结束时浏览器**也会**发 click。不拦住的话用户长按删除，
     * 松手那一刻还会顺手把角色选中（导致列表页关掉、聊天页打开）——
     * 弹窗和页面跳转打架。
     *
     * 所以用 `longPressed` 标志：长按触发后，随后那次 click 被吃掉。
     *
     * ## 为什么 touchmove 要取消
     *
     * 手指按下后滑动 = 用户在滚动列表，不是在长按。不取消的话
     * 滚一下就有弹窗冒出来。
     */
    let timer: ReturnType<typeof setTimeout> | null = null;
    let longPressed = false;

    const cancelTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const startPress = (): void => {
      if (callbacks.onDelete === undefined) return;
      longPressed = false;
      cancelTimer();
      timer = setTimeout(() => {
        timer = null;
        longPressed = true;
        askDelete(item);
      }, LONG_PRESS_MS);
    };

    row.addEventListener('touchstart', startPress);
    row.addEventListener('touchend', cancelTimer);
    row.addEventListener('touchmove', cancelTimer);
    /* 桌面端 / 预览环境没有触摸事件 */
    row.addEventListener('mousedown', startPress);
    row.addEventListener('mouseup', cancelTimer);
    row.addEventListener('mouseleave', cancelTimer);

    row.addEventListener('click', () => {
      if (longPressed) {
        longPressed = false;
        return;
      }
      callbacks.onPick(item);
    });

    return row;
  }

  /* ── 下拉刷新 ── */
  /*
   * ## 为什么只认"列表已经在顶部"的下拉
   *
   * 列表中间往下拖是**正常滚动**，那时不该刷新 —— 否则用户往回翻
   * 一点内容就触发一次网络请求，列表还会跳回顶部。
   */
  let pullStartY: number | null = null;
  let pullDistance = 0;

  scroller.addEventListener('touchstart', (event) => {
    const y = touchY(event);
    const atTop = (scroller as unknown as { scrollTop?: number }).scrollTop === 0;
    pullStartY = y !== null && atTop ? y : null;
    pullDistance = 0;
  });

  scroller.addEventListener('touchmove', (event) => {
    if (pullStartY === null) return;
    const y = touchY(event);
    if (y === null) return;

    pullDistance = Math.max(0, y - pullStartY);
    if (pullDistance >= PULL_THRESHOLD_PX) {
      pullHint.textContent = '松开刷新';
      pullHint.setAttribute('data-state', 'ready');
    } else if (pullDistance > 8) {
      pullHint.textContent = '下拉刷新';
      pullHint.setAttribute('data-state', 'pulling');
    } else {
      pullHint.textContent = '';
      pullHint.setAttribute('data-state', 'idle');
    }
  });

  scroller.addEventListener('touchend', () => {
    const shouldReload = pullDistance >= PULL_THRESHOLD_PX;
    pullStartY = null;
    pullDistance = 0;
    if (shouldReload) {
      void reload();
    } else {
      pullHint.textContent = '';
      pullHint.setAttribute('data-state', 'idle');
    }
  });

  void reload();

  return root;
}
