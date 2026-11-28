/**
 * 功能
 * 「开场与示例」页的行为：读角色列表、打开某个角色的开场数据、保存回卡、改完刷新聊天。
 * 从 AppShell 的 5 个方法搬出（约 400 行）。
 *
 * 注意事项
 * 四个数据字段（state / png / json / changeFlag）仍由壳持有 —— `goBackOneLevel`
 * 与 `pageKey` 也在读它们（导航与重绘要判"这一页是不是脏的"）。本模块通过
 * host 的 get/set 读写。
 *
 * `saveGreeting` 必须用**原始 PNG** 当容器（`greetingPng`）：`buildPngCard` 只替换
 * 卡数据块，头像图与其它 tEXt 逐字节保留。重新生成一张会让卡面变掉。
 *
 * 踩过的坑
 * `greetingChangeFlag` 存在的理由是"每敲一个字都整页重建会让输入框失焦"。
 * 去掉它会让打字时不断丢焦点 —— 这是 2026-11-05 真机抓到的，不是理论问题。
 */

import type { GreetingDraft, GreetingPageState } from './greeting-page';
import {
  emptyGreetingDraft,
  emptyGreetingPageState,
  greetingFingerprint,
  hasGreetingChanges,
} from './greeting-page';

import { chatAvatar, loadCharacterCard, writeCardPng } from './card-actions';
import type { EngineStatus } from '@tcs/shared';
import type { ChatPanel } from './chat-panel';
import type { DocLike, ElLike } from './chat-view';
import type { ShellOptions } from './shell-contract';
import type { StChatBridge } from './st-bridge';

import {
  buildOpeningMessages,
  buildPngCard,
  describeBridgeError,
  parseCharacterList,
  parsePngCard,
  parseStCardText,
  readEmbeddedWorldbook,
  stringifyStCard,
} from '@tcs/shared';

import { renderGreetingPage } from './greeting-page';

/**
 * 功能
 * 本模块能碰的壳能力。
 *
 * 注意事项
 * 四个 `greeting*` 字段都是读写双向：页面渲染会改 state，保存后要清 png/json，
 * changeFlag 每次渲染前都要重算。少一个 setter 就会"改完看着没改"。
 *
 * 踩过的坑
 * 无。
 */
export interface GreetingHost {
  readonly doc: DocLike;
  readonly pageHost: ElLike | null;
  readonly bridge: StChatBridge;
  readonly options: ShellOptions;
  readonly chatPanel: ChatPanel | null;
  readonly chatFileName: string | null;
  /** 快照。可写 —— 改完开场白要同步快照，否则下一次重绘读到的是旧的 */
  chatSnapshot: { fileName: string | null; messages: import('@tcs/shared').StChatMessage[] } | null;
  readonly loadedCard: Record<string, unknown>;

  /** 这一页的数据（四段 residual + 选中角色 + 错误） */
  greetingState: GreetingPageState;
  /** 正在编辑那张卡的原始 PNG。写回时当容器 */
  greetingPng: Uint8Array | null;
  /** 正在编辑那张卡的原始 JSON */
  greetingJson: string | null;
  /** 改动状态的上一帧快照。只在翻转时重绘 */
  greetingChangeFlag: boolean;

  renderPage(): void;
  goBackOneLevel(): boolean;
  withConnection<T>(run: () => Promise<T>): Promise<T>;
  readEngineStatus?: () => EngineStatus | null;
  /** 卡片簇的接入点（写回 PNG 要走它的收口） */
  cardHost(): import('./card-actions').CardHost;
  /** 「已保存 ✓」的回落定时器。存成字段是因为连续保存两次时前一个会提前掐掉后一个 */
  savedFlashTimer: number | null;
  /** 清掉上一个回落定时器并返回 null */
  clearSavedFlashTimer(): number | null;
  paintSavedFlashOff(): void;
  /** 聊天内容变了（保存后要让面板重新读） */
  handleChatChanged(messages: import('@tcs/shared').StChatMessage[]): Promise<void> | void;
}

export function renderGreeting(host: GreetingHost): void {
  if (host.pageHost === null) return;

  /*
   * ★★★ 必须先清空（2026-11-05 真机抓到的）。
   *
   * 交互式重绘（打字、加一条备用开场）调的是 `renderGreeting()`，
   * **不经过 `renderPage()`** —— 而 `renderPage()` 里那句
   * `pageHost.replaceChildren()` 是唯一的清空点。
   *
   * 不清的后果：每打一个字就**再叠一页**。真机上的表现是
   * "改了内容，保存按钮还是「没有改动」" —— 因为 `querySelector`
   * 拿到的是**第一页那个旧按钮**，新那一页在后面。
   *
   * 这类缺陷在单测里抓不到（单测直接调渲染函数、没有 pageHost）。
   */
  host.pageHost.replaceChildren();

  const page = renderGreetingPage(host.doc, host.greetingState, {
    /*
     * 返回**统一走 `goBackOneLevel()`**（与 persona 页同一条纪律）：
     * 层级只在一个地方定义，否则"返回去哪"迟早两处不一致。
     */
    onBack: () => {
      host.goBackOneLevel();
    },
    onSelect: (avatar) => {
      void openGreetingCard(host, avatar);
    },
    onChange: (patch) => {
      /*
       * 合并而不是替换：`onChange` 每次只带改的那一段，
       * 替换会把其它三段清空（用户打一个字，另外三段全没了）。
       */
      host.greetingState = {
        ...host.greetingState,
        draft: { ...host.greetingState.draft, ...patch },
      };
      /*
       * 就地重绘整页 —— 因为保存按钮的文案与禁用态依赖"有没有改动"。
       *
       * 代价是每敲一个字都重建 DOM，输入框会失焦。所以只在
       * **改动状态翻转时**才重绘（下面这一行判断），平时不重绘。
       */
      if (host.greetingChangeFlag !== hasGreetingChanges(host.greetingState)) {
        host.greetingChangeFlag = hasGreetingChanges(host.greetingState);
        renderGreeting(host);
      }
    },
    onAddAlternate: () => {
      host.greetingState = {
        ...host.greetingState,
        draft: {
          ...host.greetingState.draft,
          alternateGreetings: [...host.greetingState.draft.alternateGreetings, ''],
        },
      };
      renderGreeting(host);
    },
    onRemoveAlternate: (index) => {
      const next = host.greetingState.draft.alternateGreetings.filter(
        (_, i) => i !== index,
      );
      host.greetingState = {
        ...host.greetingState,
        draft: { ...host.greetingState.draft, alternateGreetings: next },
      };
      renderGreeting(host);
    },
    onSave: () => {
      void saveGreeting(host);
    },
  });

  host.pageHost.append(page);
}

export async function loadGreetingCharacters(host: GreetingHost): Promise<void> {
  host.greetingState = { ...host.greetingState, loading: true, error: '' };
  renderGreeting(host);

  try {
    const raw = await host.withConnection(() => host.bridge.listCharactersRaw());
    const parsed = parseCharacterList(raw);
    if (!parsed.ok) {
      host.greetingState = {
        ...host.greetingState,
        loading: false,
        error: `读不到角色列表：${parsed.reason}`,
      };
    } else {
      host.greetingState = {
        ...host.greetingState,
        loading: false,
        characters: parsed.items.map((one) => ({ avatar: one.avatar, name: one.name })),
      };
    }
  } catch (error) {
    host.greetingState = {
      ...host.greetingState,
      loading: false,
      error: describeBridgeError(error).message,
    };
  }
  renderGreeting(host);
}

export async function openGreetingCard(host: GreetingHost, avatar: string): Promise<void> {
  host.greetingState = { ...host.greetingState, loading: true, error: '', selected: avatar };
  /*
   * ★★★ 这里必须是 `renderPage()`，不是 `renderGreeting()`（2026-11-05 修）。
   *
   * 用户：
   *
   * > 你遗漏了卡片中的开场与示例中的角色界面，点击进入退出对应角色界面
   * > 的时候没有动画（注意如果后续角色多起来后应该如何实现，即不能写死
   * > 现有的角色，后续陆续加进来的也要有动画才行）
   *
   * 真因：`renderGreeting()` 是在**当前层里**清空重绘
   * （`host.pageHost.replaceChildren()`），不新建层 ⇒ `finishPageTurn()`
   * 根本没被调用 ⇒ 一层都没换 ⇒ 没有转场。
   *
   * 而"列表 → 编辑"本来就是换页：`pageKey()` 从 `cards/greeting`
   * 变成 `cards/greeting/edit`，段数 2 → 3 ⇒ 自动 push。
   * 退出（`goBackOneLevel()` 里 `selected = null`）走的是 `renderPage()`，
   * 段数 3 → 2 ⇒ 自动 back。
   *
   * ## 为什么这样对"角色变多"也成立
   *
   * `pageKey()` 只区分**列表**与**编辑**两种形态，**不枚举角色** ——
   * 它不看 avatar 是谁、也不看列表里有几个。所以两个角色和两百个角色
   * 走的是同一条路径、同一套动画，新增角色**不需要改任何动画代码**。
   *
   * 要改的只是"这条入口用哪个渲染函数"，而入口只有这一个
   * （`onSelect` → `openGreetingCard`）。
   */
  host.renderPage();

  try {
    const pngBytes = await host.withConnection(() => host.bridge.characterPng(avatar));
    const png = new Uint8Array(pngBytes);
    const parsed = parsePngCard(png);
    if (parsed.kind !== 'card') {
      host.greetingState = {
        ...host.greetingState,
        loading: false,
        selected: null,
        error: `这张卡没有内嵌设定数据（${parsed.note}）`,
      };
      /*
       * 退回列表也是换页（`cards/greeting/edit` → `cards/greeting`），
       * 同样要走 `renderPage()` —— 否则"打开失败"时页面会硬切回去，
       * 而成功时是滑回去的，同一件事两种观感。
       */
      host.renderPage();
      return;
    }

    const card = parseStCardText(parsed.jsonText);
    const draft: GreetingDraft = {
      scenario: card.card.residual.scenario,
      firstMes: card.card.residual.firstMes,
      alternateGreetings: [...card.card.residual.alternateGreetings],
      mesExample: card.card.residual.mesExample,
    };

    /* 原文留着：保存时在它上面改，其余字段一个字节都不碰 */
    host.greetingJson = parsed.jsonText;
    host.greetingPng = png;
    host.greetingChangeFlag = false;

    host.greetingState = {
      ...host.greetingState,
      loading: false,
      error: '',
      draft,
      baseline: greetingFingerprint(draft),
    };

    /*
     * 解析有问题要**说出来**，但不能拦着不让改。
     *
     * 最常见的是"旧格式卡"（没有这两个板块）。用户能打开、能补内容，
     * 只是要知到这里为什么是空的。
     */
    if (card.issues.length > 0) {
      const first = card.issues[0];
      host.options.onNotify?.(first?.message ?? '这张卡有几处格式问题，已按原样载入', 'warn');
    }
  } catch (error) {
    host.greetingState = {
      ...host.greetingState,
      loading: false,
      selected: null,
      error: describeBridgeError(error).message,
    };
  }

  /*
   * 尾部这次要按 `pageKey()` 分两种情况，所以必须走 `renderPage()`：
   *
   * ```text
   *   加载成功   selected 还是那个角色 ⇒ key 不变 ⇒ 同一页重绘，不播
   *   加载失败   selected 被清成 null   ⇒ key 退回列表 ⇒ 播 back
   * ```
   *
   * 用 `renderGreeting()` 的话第二种情况会硬切回去 ——
   * 同一件事（从编辑页回列表）两种观感。
   */
  host.renderPage();
}

export async function saveGreeting(host: GreetingHost): Promise<void> {
  const avatar = host.greetingState.selected;
  if (avatar === null || host.greetingJson === null || host.greetingPng === null) return;

  host.greetingState = { ...host.greetingState, loading: true, error: '' };
  renderGreeting(host);

  try {
    const parsed = parseStCardText(host.greetingJson);
    const draft = host.greetingState.draft;

    /*
     * 空行清掉：用户在备用开场白里点"加一条"之后没写就走，
     * 留下一个空字符串会变成一条**空白开场白** —— 用户换到它时
     * 聊天是空的，而界面上"有一条备用开场"，对不上。
     */
    const alternates = draft.alternateGreetings
      .map((one) => one.trim())
      .filter((one) => one !== '');

    const next = {
      ...parsed.card,
      residual: {
        ...parsed.card.residual,
        scenario: draft.scenario,
        firstMes: draft.firstMes,
        alternateGreetings: alternates,
        mesExample: draft.mesExample,
      },
    };

    /*
     * `entryTitleToComment: true` —— 与桌面端「导出 JSON」同一个选项。
     *
     * 不传的话世界书条目标题只写 `name`，ST 的面板读 `comment` ⇒ 导进 ST
     * 每条标题都是空白。这个选项的存在意义就是"这份文件是给 ST 用的"，
     * 而写到 ST 角色目录里的文件当然属于这一类。
     */
    const jsonText = stringifyStCard(next, { indent: 2, entryTitleToComment: true });

    /*
     * 用**原 PNG** 当容器：`buildPngCard` 只替换卡数据块，
     * 头像图与其它块逐字节保留 —— 重新生成一张会让卡面变掉。
     */
    /*
     * PNG 的 `spec` 是 `'v2' | 'v3'`（不是 keyword 本身）——
     * 由 `PNG_KEYWORD_FOR_SPEC` 映射到 `chara` / `ccv3`。
     * 传错会在 `undefined` 关键字上写出一块 ST 读不到的 tEXt。
     */
    const spec = parsed.card.meta.spec === 'v3' ? 'v3' : 'v2';
    const png = buildPngCard(host.greetingPng, jsonText, spec);

    const status = host.readEngineStatus?.() ?? null;
    const charactersDir = status?.charactersDir ?? '';
    if (charactersDir === '') throw new Error('拿不到角色库目录，无法保存');

    await writeCardPng(host.cardHost(), avatar, charactersDir, png, false);

    /* 写成功后把内存里的旧副本换掉：否则再点一次保存会基于旧 JSON 重算 */
    host.greetingJson = jsonText;
    host.greetingPng = png;

    const fresh: GreetingDraft = {
      scenario: draft.scenario,
      firstMes: draft.firstMes,
      alternateGreetings: [...alternates],
      mesExample: draft.mesExample,
    };
    host.greetingChangeFlag = false;
    host.greetingState = {
      ...host.greetingState,
      loading: false,
      /*
       * 清掉上一轮的错误：保存成功后页面不该还挂着上次的失败提示
       * （否则下面那句"成功才发通知"永远不成立，用户又看不到反馈）。
       */
      error: '',
      draft: fresh,
      baseline: greetingFingerprint(fresh),
      /*
       * ★ 点亮按钮上的"已保存 ✓"（2026-11-06，用户问题①）。
       *
       * 不靠顶栏通知的原因见 `GreetingPageState.savedFlash` 的注释：
       * 这一页保存后会整页重绘，topbar 连同里面的通知一起被删。
       */
      savedFlash: true,
    };
    host.savedFlashTimer = host.clearSavedFlashTimer();
    /*
     * 2 秒后回落成「没有改动」。这个时长选在"用户一定能看见、
     * 又不至于一直占着主按钮位置"之间；与下载按钮的三态同规格。
     *
     * ★★★ 回落**不许重绘整页**（2026-11-06 真机抓到的）。
     *
     * 第一版这里调的是 `renderGreeting()`，探针看到的是：
     *
     * ```text
     *   .nb-scroll scrollTop: 648 → 0     ← 滚动位置被清零
     *   activeElement: BODY               ← 焦点丢了
     *   --nb-kb-inset-native: 0           ← 键盘被收起
     * ```
     *
     * 对用户意味着：保存成功 2 秒后，如果他正在改下一个字段，
     * 输入框会被换掉、键盘收起、页面跳回顶部。**为了撤掉一句
     * "已保存 ✓" 而打断用户**，代价远大于收益。
     *
     * 所以这里只改那一个按钮的文字与状态。
     */
    host.savedFlashTimer = globalThis.setTimeout(() => {
      host.savedFlashTimer = null;
      host.greetingState = { ...host.greetingState, savedFlash: false };
      host.paintSavedFlashOff();
    }, 2000) as unknown as number;

    /*
     * 如果改的正是**当前正在聊的那个角色**，让它重读开场白 ——
     * 否则用户改完开场白去聊天，看到的还是旧的那条（因为面板里
     * 已经建好了一条聊天空记录）。
     *
     * 只在"没有历史消息"时重载：有历史说明已经聊过了，
     * 这时换开场白会把用户已有的对话顶掉。
     */
    if (chatAvatar(host.cardHost()) === avatar) {
      void refreshOpeningAfterEdit(host);
    }
  } catch (error) {
    host.greetingState = {
      ...host.greetingState,
      loading: false,
      error: describeBridgeError(error).message,
      savedFlash: false,
    };
  }

  /*
   * ★★★ 重绘必须在**发通知之前**（2026-11-06 真机取证）。
   *
   * 原来这两句是反的：
   *
   * ```text
   *   onNotify('已保存到卡片')   ← 通知挂进 .nb-topbar
   *   renderGreeting()          ← pageHost.replaceChildren()
   *                                 把 .nb-greeting 整个删掉
   *                                 ⇒ topbar 没了 ⇒ 通知也没了
   * ```
   *
   * 用户看到的就是"点保存，什么反应都没有"。而代码里明明有提示 ——
   * 这类"写了但看不见"的缺陷比没写更难查。
   */
  renderGreeting(host);

  /*
   * 通知放最后，挂在新渲染出来的 topbar 里。
   * 成功的文案说"已保存"，不再补一句"到哪里" —— 按钮上已经写了。
   */
  if (host.greetingState.error === '') {
    host.options.onNotify?.('已保存到卡片', 'ok');
  }
}

export async function refreshOpeningAfterEdit(host: GreetingHost): Promise<void> {
  const panel = host.chatPanel;
  const avatar = chatAvatar(host.cardHost());
  if (panel === null || avatar === null) return;

  /*
   * 先把新卡读进 `loadedCard`：`refreshOpeningAfterEdit` 是在**保存之后**
   * 调的，此时磁盘上已经是新卡，重读一次就拿得到新的 `first_mes`。
   */
  await loadCharacterCard(host.cardHost(), avatar);

  if (panel === null) return;
  const messages = panel.getMessages();
  if (messages.some((one) => one.is_user === true)) return;

  const opening = buildOpeningMessages(host.loadedCard);
  if (opening.length === 0) return;

  /*
   * `setMessages` 而不是 `newChat`：`newChat` 会把 `fileName` 置空、
   * 换一个聊天文件 —— 用户只是改了开场白，不该多出一条聊天记录。
   */
  panel.setMessages(opening, host.chatFileName ?? undefined, avatar);
  /*
   * 快照的形状是 `{ fileName, messages }`，**不是** `messages` 本身。
   * 写成 `= opening` 会让下一次 `renderChat()` 读到 `snapshot.messages`
   * 得 `undefined` ⇒ 面板一片空白（而磁盘上有内容）。
   */
  if (host.chatFileName !== null) {
    host.chatSnapshot = { fileName: host.chatFileName, messages: opening.slice() };
  }
  host.handleChatChanged(opening);
}