/**
 * 「聊天操作」页 + 「聊天文件管理」页（2026-11-03）。
 *
 * ## 这一页是什么
 *
 * 用户给的是 SillyTavern 聊天页那排菜单的截图（12 项），要求「除重新生成和
 * 删除消息外全部要，单独放到一个界面」。所以这里做 10 项里的 8 项 + 2 项已在别处。
 *
 * ## 每一项背后的真实能力（全部实测过，不是照抄 ST 的菜单）
 *
 * 真机上探测了 ST 1.19.0 的路由（`.verify/probe-st-routes.sh`）：
 *
 * | 路由 | 结果 | 结论 |
 * |---|---|---|
 * | `/api/chats/get`、`save`、`rename`、`delete`、`characters/chats` | 200 | 文件管理可直接做 |
 * | `/api/settings/get`、`save` | 200 | 作者注释 / CFG 走设置 |
 * | `/api/groups/create` | 200 | **转群聊能真做** |
 * | `/api/backends/chat-completions/generate` | 400(缺参) | 存在，AI 帮答/续写走它 |
 * | `/api/chats/new`、`chats/close`、`checkpoint/*`、`group/convert` | **404** | 不存在 |
 *
 * 404 那几条在 ST 里本来也是**纯前端动作**（清空消息、换个文件名存盘），
 * 所以由我们自己实现，语义一致。
 *
 * ## 一条纪律：做不了的就别画成能点
 *
 * 「Token 概率」在 ST 里是"把每个 token 的候选和概率画出来"，
 * 需要后端返回 `logprobs`。而我们的请求经 ST 的 generate 接口只拿纯文本 SSE，
 * **拿不到 logprobs**。所以这一项如实标成"暂不支持"并说明原因 ——
 * 画一个点了没反应的按钮比不画更糟。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';
/*
 * 条数与时间都从 shared 取 —— 这两个字段的类型坑在一处踩过就够了
 * （见 `chatFileCount` / `chatFileLastAt` 的注释）。
 */
import {
  chatFileCount,
  chatFileSaysEmpty,
  chatFileSizeBytes,
  isDeletableEmptyChat,
} from '../../../shared/dist/st-adapter/chat-file.js';
import { buildTopbar } from './chat-settings.ts';

/**
 * 暂不在界面上展示的功能（2026-11-03 用户要求）。
 *
 * ## 用户原话
 *
 * > 把我圈起来的这几个功能取消掉（只是 UI 上隐藏和**没有别的代码调用**，
 * > 这些作为后续功能加进去）
 *
 * ## 约束是「只隐藏 UI，不删代码」
 *
 * 所以这些动作的**定义、回调、实现全部保留**，只在渲染时跳过。
 * 将来要放出来：把对应 id 从下面这个集合里删掉，一行即可。
 *
 * 反过来若真把它们删了，将来恢复就得重写一遍 —— 而用户明确说
 * "这些作为后续功能加进去"，删掉等于把活干废。
 *
 * ## 为什么集中成一个集合，而不是在每个 action 上加 `hidden: true`
 *
 * 分散标记会让"现在到底有哪些是藏着的"变得要去数组里逐条翻。
 * 集中一处，一眼看得见全貌；也不会出现"某条改了但漏改标记"。
 */
const HIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  'ai-assist', // AI 帮答（依赖 generate，且用户暂不需要）
  'continue', // 续写
  'convert-group', // 转换为群聊
  'token-probs', // Token 概率（拿不到 logprobs，只是说明性的一条）
]);

/** 一个动作的执行结果。`detail` 是给用户看的一句话，不写"操作成功"这种废话 */
export interface ChatActionOutcome {
  ok: boolean;
  detail: string;
}

export interface ChatActionsCallbacks {
  onBack: () => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  /** 当前是否已打开某个聊天（没打开时依赖聊天的项要禁用） */
  hasOpenChat: boolean;
  /** 保存检查点：以一个新文件名把当前消息存成独立聊天 */
  onSaveCheckpoint: () => Promise<ChatActionOutcome>;
  /** 把当前角色转成群聊 */
  onConvertToGroup: () => Promise<ChatActionOutcome>;
  /** 开始一段新聊天（当前聊天不受影响） */
  onNewChat: () => Promise<ChatActionOutcome>;
  /** 关闭当前聊天（回到未打开状态） */
  onCloseChat: () => ChatActionOutcome;
  /** 进入聊天文件管理 */
  onManageFiles: () => void;
  /** AI 帮答：让模型以旁白口吻给几条后续建议 */
  onAiAssist: () => Promise<ChatActionOutcome>;
  /** 续写：按上文继续写下去 */
  onContinueWriting: () => Promise<ChatActionOutcome>;
}

/** 一条动作的定义 */
interface ActionSpec {
  id: string;
  icon: string;
  label: string;
  hint: string;
  /** 危险动作（不可逆）用红色 */
  danger?: boolean;
  /** 需要已打开聊天 */
  needsChat: boolean;
  run: () => Promise<ChatActionOutcome> | ChatActionOutcome;
}

/**
 * 渲染「聊天操作」页。
 *
 * 行是 `button` 而不是 `div`：可点、可聚焦、长按不选中文字
 * （全局 `user-select: none` 已经管住了，但按钮语义更对）。
 */
export function renderChatActionsPage(
  doc: DocLike,
  callbacks: ChatActionsCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-chat-actions');
  root.setAttribute('data-role', 'chat-actions-page');
  root.append(buildTopbar(doc, '聊天操作', callbacks.onBack));

  const body = el(doc, 'div', 'nb-list');
  body.setAttribute('data-role', 'chat-actions');

  /*
   * 状态行：每个动作执行后把结果写在这里。
   *
   * 不用 toast 承载结果 —— 这些动作的**结果需要停留**（"检查点存在 XXX"、
   * "已转成群聊 YYY"），toast 3 秒就没了，用户来不及看名字。
   */
  const status = el(doc, 'div', 'nb-hint-block');
  status.setAttribute('data-role', 'chat-action-status');
  status.hidden = true;

  const actions: readonly ActionSpec[] = [
    {
      id: 'checkpoint',
      icon: '🚩',
      label: '保存检查点',
      hint: '把当前对话另存为一个独立文件，之后可以单独打开',
      needsChat: true,
      run: () => callbacks.onSaveCheckpoint(),
    },
    {
      id: 'new-chat',
      icon: '💬',
      label: '开始新聊天',
      hint: '开一段空白对话；当前这段会保留在聊天文件里',
      needsChat: true,
      run: () => callbacks.onNewChat(),
    },
    {
      id: 'close-chat',
      icon: '✕',
      label: '关闭聊天',
      hint: '退出当前对话，回到未打开状态',
      needsChat: true,
      run: () => callbacks.onCloseChat(),
    },
    {
      id: 'manage-files',
      icon: '📁',
      label: '管理聊天文件',
      hint: '查看、打开、改名、删除这个角色的聊天记录',
      needsChat: false,
      run: () => {
        callbacks.onManageFiles();
        /* 页面已经切走，不需要结果行 */
        return { ok: true, detail: '' };
      },
    },
    {
      id: 'ai-assist',
      icon: '💡',
      label: 'AI 帮答',
      hint: '让模型以旁白口吻给几条接下来的走向建议（会作为一条新回复出现）',
      needsChat: true,
      run: () => callbacks.onAiAssist(),
    },
    {
      id: 'continue',
      icon: '→',
      label: '续写',
      hint: '按上文接着写下去，适合回复被截断或想让它多说一点',
      needsChat: true,
      run: () => callbacks.onContinueWriting(),
    },
    {
      id: 'convert-group',
      icon: '👥',
      label: '转换为群聊',
      hint: '用当前角色建一个群；之后可在群聊设置里加其他成员',
      needsChat: true,
      run: () => callbacks.onConvertToGroup(),
    },
  ];

  for (const action of actions) {
    /*
     * 暂不展示的功能直接跳过（2026-11-03）。
     * 只跳过渲染 —— action 定义、callbacks 字段、外壳实现全都还在。
     */
    if (HIDDEN_ACTIONS.has(action.id)) continue;

    const row = el(doc, 'button', 'nb-listitem');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'chat-action');
    row.setAttribute('data-action', action.id);
    if (action.danger === true) row.setAttribute('data-danger', 'true');

    const disabled = action.needsChat && !callbacks.hasOpenChat;
    if (disabled) {
      row.setAttribute('disabled', 'true');
      row.setAttribute('data-disabled', 'true');
    }

    const main = el(doc, 'span', 'nb-listitem-main');
    const title = el(doc, 'span', 'nb-listitem-title');
    title.textContent = `${action.icon} ${action.label}`;
    const hint = el(doc, 'span', 'nb-listitem-sub');
    hint.textContent = disabled ? '先打开一段对话才能用这一项' : action.hint;
    main.append(title, hint);

    const chevron = el(doc, 'span', 'nb-src-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';

    row.append(main, chevron);
    row.addEventListener('click', () => {
      if (disabled) return;
      void (async () => {
        row.setAttribute('data-busy', 'true');
        try {
          const outcome = await action.run();
          if (outcome.detail !== '') {
            status.hidden = false;
            status.textContent = outcome.detail;
            status.setAttribute('data-kind', outcome.ok ? 'ok' : 'danger');
          }
          if (!outcome.ok && outcome.detail !== '') {
            callbacks.onNotify(outcome.detail, 'danger');
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          status.hidden = false;
          status.textContent = `操作失败：${text}`;
          status.setAttribute('data-kind', 'danger');
          callbacks.onNotify(`操作失败：${text}`, 'danger');
        } finally {
          row.setAttribute('data-busy', 'false');
        }
      })();
    });
    body.append(row);
  }

  /*
   * ── Token 概率：做不了，如实说明 ──
   *
   * 这一项**刻意不做成按钮**：ST 里它需要后端把每个 token 的候选与概率
   * 一起返回（`logprobs`）。我们的生成请求经 ST 的
   * `/api/backends/chat-completions/generate`，只拿得到纯文本 SSE，
   * 里面没有任何 logprobs 字段 ⇒ 前端无从渲染。
   *
   * 画一个点了没反应的按钮，用户会以为是坏的；写清原因，他能判断要不要
   * 去 ST 里看。
   */
  if (!HIDDEN_ACTIONS.has('token-probs')) {
    const tokenRow = el(doc, 'div', 'nb-listitem nb-listitem--note');
    tokenRow.setAttribute('data-role', 'chat-action-note');
    tokenRow.setAttribute('data-action', 'token-probs');
    const tokenMain = el(doc, 'span', 'nb-listitem-main');
    const tokenTitle = el(doc, 'span', 'nb-listitem-title');
    tokenTitle.textContent = '📊 Token 概率';
    const tokenHint = el(doc, 'span', 'nb-listitem-sub');
    tokenHint.textContent =
      '暂不支持。这一项需要模型把每个 token 的候选与概率一起返回，' +
      '而 App 走的是纯文本流、拿不到这些数据，所以这一项暂时不提供。';
    tokenMain.append(tokenTitle, tokenHint);
    tokenRow.append(tokenMain);
    body.append(tokenRow);
  }

  root.append(body, status);
  return root;
}

/* ═══════════════════════════════════════════════════════════
   聊天文件管理
   ═══════════════════════════════════════════════════════════ */

/** 列表里的一条（外壳从 ST 的 `/api/characters/chats` 解析出来） */
export interface ChatFileRow {
  /** `file_id`（不带 .jsonl 的文件名） */
  id: string;
  /** 展示名 */
  name: string;
  /** 消息条数（拿不到给 0） */
  count: number;
  /**
   * 是否**真的**从 ST 读到了条数字段。
   *
   * ## 为什么必须区分"0 条"和"不知道"
   *
   * ST 的 `chat_items` 缺失时 `chatFileCount()` 返回 0，而那与
   * "这个文件真的是空的"**不是一回事**。
   *
   * ```text
   *   清空聊天后 0 条     ⇒ 确实是空的，可以删
   *   ST 没给这个字段      ⇒ 里面可能有 500 条，删了就没了
   * ```
   *
   * 界面上要显示成"条数未知"，清理功能也**必须跳过**它们 ——
   * 拿不准的东西不许删。
   */
  countKnown: boolean;
  /**
   * `file_size` 解析出的字节数；`null` = 读不到。
   *
   * 「清理空聊天」用它做**独立**校验（见 shared 的 `isDeletableEmptyChat`）。
   * 光看 `count === 0` 会误删"只有一条消息但末行解析失败"的聊天。
   */
  sizeBytes: number | null;
  /**
   * ST 是否明确说这个文件是空的（`mes === '[The chat is empty]'`）。
   *
   * 与 `count === 0` **不是同一件事**：末行损坏时 ST 也报 0 条，
   * 但那是"一条消息 + 读不出的末行"，删了就真丢内容。
   */
  saysEmpty: boolean;
  /** 是否当前打开的那一条 */
  current: boolean;
}

/**
 * 解析 `/api/characters/chats` 的返回（纯函数，可单测）。
 *
 * ## 为什么要容错这么多
 *
 * 实测这一路返回过三种形态：
 *   · `[]`（没有聊天）—— 这就是 ST 的"没有"（见契约 §35：`{}` 与 `[]` 是两种不同的"没有"）
 *   · `{"error":true}`（缺参数时）
 *   · 正常数组，元素里有 `file_id` / `file_name` / `last_mes`
 *
 * 而 `file_name` 有时带 `.jsonl` 后缀、有时不带；`last_mes` 有时是数字、
 * 有时是字符串。全都按"拿不到就给默认值"处理 —— 一条脏数据不该让整页空白。
 *
 * @param raw ST 返回的原始 JSON 文本
 * @param currentId 当前打开的那一条（用来标"（当前）"）
 */
export function parseChatFileRows(raw: string, currentId: string | null): ChatFileRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === '' ? '[]' : raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const rows: ChatFileRow[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const info = item as Record<string, unknown>;

    const id = typeof info['file_id'] === 'string' ? info['file_id'] : '';
    if (id === '') continue;

    const fileName = typeof info['file_name'] === 'string' ? info['file_name'] : id;
    /* 去掉 `.jsonl` —— 界面上的"名字"不该带扩展名 */
    const name = fileName.replace(/\.jsonl$/i, '');

    /*
     * ★★★ 条数必须取 `chat_items`，不是 `last_mes` 的下标加一（2026-11-14）。
     *
     * ## 原来的 bug
     *
     * ```ts
     *   const last = Number.parseInt(String(info['last_mes'] ?? ''), 10);
     *   const count = last + 1;
     * ```
     *
     * 注释说 `last_mes` 是"最后一条的下标"，但它其实是**时间**。
     * 而 `parseInt("2026-11-11T19:30:00.000Z")` = **2026**（年份），
     * 于是每个文件都显示 **2027 条**。
     *
     * 用户截图里 8 个文件全是 2027 —— 他说的"数字不是真实数量"完全正确。
     * 更糟的是这个假数字会让人误判"记录还在不在"。
     *
     * 解析收在 shared 的 `chatFileCount()`（认 `chat_items` 与
     * `message_count`，都没有就返回 0，**不猜**）。
     */
    const count = chatFileCount(info);
    /* 只有真的读到了字段才敢说"这是 0 条"（见 countKnown 的注释） */
    const countKnown = info['chat_items'] !== undefined || info['message_count'] !== undefined;

    rows.push({
      id,
      name,
      count,
      countKnown,
      sizeBytes: chatFileSizeBytes(info),
      saysEmpty: chatFileSaysEmpty(info),
      current: currentId !== null && id === currentId,
    });
  }

  /* 当前这条排最前，其余按 ST 给的顺序（它已按最近排序） */
  rows.sort((a, b) => Number(b.current) - Number(a.current));
  return rows;
}

export interface ChatFilesCallbacks {
  onBack: () => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
  loadFiles: () => Promise<ChatFileRow[] | null>;
  onOpen: (id: string) => Promise<void>;
  onRename: (id: string, newName: string) => Promise<ChatActionOutcome>;
  onDelete: (id: string) => Promise<ChatActionOutcome>;
  /**
   * 导出这段聊天为 TXT 并分享（2026-11-14，v0.1.9）。
   *
   * 传 `name` 是因为分享出去的文件名要用**用户看到的标题**
   * （它可能改过名），而不是 `file_id` 那个带时间戳的内部名。
   *
   * 可选：没接能力就不画按钮 —— 不给一个点了没反应的按钮。
   */
  onExport?: (id: string, name: string) => Promise<ChatActionOutcome>;
}

/**
 * 渲染聊天文件管理页。
 *
 * 每行三个动作（打开 / 改名 / 删除）。改名用**就地输入框**而不是 `prompt()`：
 * `prompt()` 在 Android WebView 里阻塞主线程（流式期间会把打字机卡住）。
 */
export function renderChatFilesPage(
  doc: DocLike,
  callbacks: ChatFilesCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-chat-files');
  root.setAttribute('data-role', 'chat-files-page');
  root.append(buildTopbar(doc, '聊天文件', callbacks.onBack));

  /*
   * 「清理空聊天」按钮（2026-11-14）。
   *
   * ## 为什么需要
   *
   * 用户视频里有 8 个同角色的聊天文件，每个只有开场白 —— 那是旧版本
   * "切角色就建档"的产物（已修，但**已经产生的垃圾不会自己消失**）。
   *
   * 一个一个点「删除」要 8 次，而且用户不一定分得清哪个是垃圾。
   *
   * ## 三条约束
   *
   * ```text
   *   ① 只删 countKnown && count === 0 —— 拿不准的不许删
   *   ② 跳过当前打开的那条 —— 删了会让聊天页指向不存在的文件
   *   ③ 两步确认 —— 与每行的「删除」一致，不用阻塞式的 confirm()
   * ```
   */
  const cleanBtn = el(doc, 'button', 'nb-mini-btn');
  cleanBtn.setAttribute('type', 'button');
  cleanBtn.setAttribute('data-role', 'chat-files-clean-empty');
  cleanBtn.hidden = true;
  root.append(cleanBtn);

  const status = el(doc, 'div', 'nb-hint-block');
  status.setAttribute('data-role', 'chat-files-status');
  status.hidden = true;
  root.append(status);

  const listHost = el(doc, 'div', 'nb-list');
  listHost.setAttribute('data-role', 'chat-files');
  root.append(listHost);

  const say = (text: string, kind: 'ok' | 'danger' | 'warn'): void => {
    status.hidden = false;
    status.textContent = text;
    status.setAttribute('data-kind', kind);
  };

  const paint = async (): Promise<void> => {
    const files = await callbacks.loadFiles();
    listHost.replaceChildren();

    if (files === null) {
      say('读不到聊天文件列表。检查一下引擎是否还在运行。', 'warn');
      return;
    }
    if (files.length === 0) {
      say('这个角色还没有任何聊天记录。', 'warn');
      cleanBtn.hidden = true;
      return;
    }

    /*
     * 算出"可以安全删的空文件"。
     *
     * 跳过 `current`：当前正打开那一条就算只有开场白也先留着 ——
     * 删了会让聊天页的 `chatFileName` 指向一个不存在的文件，
     * 下一次保存又会新建一个（正是我们要断掉的循环）。
     */
    const empties = files.filter((file) => isDeletableEmptyChat(file));
    cleanBtn.hidden = empties.length === 0;
    cleanBtn.textContent = `清理空聊天（${String(empties.length)}）`;
    /* 每次重绘都把确认态复位 —— 否则用户看到"确认删除"却不知道确认什么 */
    cleanBtn.removeAttribute('data-armed');

    for (const file of files) {
      const row = el(doc, 'div', 'nb-listitem nb-file-row');
      row.setAttribute('data-role', 'chat-file-row');
      row.setAttribute('data-file-id', file.id);

      const main = el(doc, 'span', 'nb-listitem-main');
      const title = el(doc, 'span', 'nb-listitem-title');
      title.textContent = file.current ? `${file.name}（当前）` : file.name;
      const sub = el(doc, 'span', 'nb-listitem-sub');
      /*
       * 未知就不写数字（2026-11-14）。
       * 写 "0 条消息" 会让用户以为记录被清空了 —— 那比不显示更吓人。
       */
      sub.textContent = file.countKnown ? `${String(file.count)} 条消息` : '条数未知';
      main.append(title, sub);
      row.append(main);

      const tools = el(doc, 'span', 'nb-file-tools');

      const openBtn = el(doc, 'button', 'nb-mini-btn');
      openBtn.setAttribute('type', 'button');
      openBtn.setAttribute('data-role', 'chat-file-open');
      openBtn.textContent = '打开';
      openBtn.addEventListener('click', () => {
        void (async () => {
          await callbacks.onOpen(file.id);
          callbacks.onNotify(`已打开「${file.name}」`, 'ok');
        })();
      });
      tools.append(openBtn);

      /*
       * 导出 TXT（2026-11-14，v0.1.9）。
       *
       * ## 为什么放在这一行而不是「我的」页
       *
       * 就近原则：用户看到某段聊天时才会想导出**这一段**。
       * 集中到「我的 → 导出全部」会变成"先选角色再选聊天"的两级选择，
       * 而这一页本来就是按角色列的聊天文件。
       *
       * ## 为什么禁用态要跟 `onExport` 走
       *
       * 没接能力还画按钮 = 点了没反应，用户会以为卡住了。
       */
      const exportRun = callbacks.onExport;
      if (exportRun !== undefined) {
        const exportBtn = el(doc, 'button', 'nb-mini-btn');
        exportBtn.setAttribute('type', 'button');
        exportBtn.setAttribute('data-role', 'chat-file-export');
        exportBtn.textContent = '导出';
        exportBtn.addEventListener('click', () => {
          void (async () => {
            /*
             * 导出要读整份 jsonl + 编码 + 起分享面板，耗时明显。
             * 先禁用防连点，且**失败要恢复** —— 否则一次失败之后
             * 这个按钮就永久灰了。
             */
            exportBtn.setAttribute('disabled', 'true');
            try {
              const outcome = await exportRun(file.id, file.name);
              say(outcome.detail, outcome.ok ? 'ok' : 'danger');
            } finally {
              exportBtn.removeAttribute('disabled');
            }
          })();
        });
        tools.append(exportBtn);
      }

      /*
       * 改名：点一下把标题换成输入框，确认后提交。
       *
       * 拆成"进入编辑"和"提交"两步是必要的 —— 一步式的做法要么用
       * `prompt()`（阻塞主线程），要么需要一个新的弹层组件。
       */
      const renameBtn = el(doc, 'button', 'nb-mini-btn');
      renameBtn.setAttribute('type', 'button');
      renameBtn.setAttribute('data-role', 'chat-file-rename');
      renameBtn.textContent = '改名';
      renameBtn.addEventListener('click', () => {
        /* 交叉类型：既要能 append 进 DOM（ElLike），又要能读写 value / focus */
        const input = el(doc, 'input', 'nb-input nb-file-rename-input') as unknown as ElLike & {
          value: string;
          focus?: () => void;
        };
        input.setAttribute('type', 'text');
        input.setAttribute('data-role', 'chat-file-rename-input');
        input.value = file.name;
        main.replaceChildren(input);
        input.focus?.();

        const commit = el(doc, 'button', 'nb-mini-btn nb-mini-btn--primary');
        commit.setAttribute('type', 'button');
        commit.setAttribute('data-role', 'chat-file-rename-commit');
        commit.textContent = '保存';
        commit.addEventListener('click', () => {
          void (async () => {
            const next = String(input.value ?? '').trim();
            if (next === '') {
              say('名字不能为空。', 'warn');
              return;
            }
            const outcome = await callbacks.onRename(file.id, next);
            if (outcome.ok) {
              say(outcome.detail, 'ok');
              await paint();
            } else {
              say(outcome.detail, 'danger');
            }
          })();
        });

        /*
         * 「取消」必须有（2026-11-15）。
         *
         * 原来这里 `tools.replaceChildren(commit)` 把「改名」按钮顶掉了 ——
         * 于是进入编辑态之后只有"保存"一条路：改名失败（比如重名）时，
         * 用户既改不回标题、也没法放弃，只能切走再进一次列表。
         *
         * 失败后最需要的恰恰是"退出来" —— 而他手里只有"再试一次"。
         */
        const cancelEdit = el(doc, 'button', 'nb-mini-btn');
        cancelEdit.setAttribute('type', 'button');
        cancelEdit.setAttribute('data-role', 'chat-file-rename-cancel');
        cancelEdit.textContent = '取消';
        cancelEdit.addEventListener('click', () => {
          /* 回到列表原样：重绘这一页比手工复原 DOM 可靠 */
          void paint();
        });

        tools.replaceChildren(commit, cancelEdit);
      });
      tools.append(renameBtn);

      const delBtn = el(doc, 'button', 'nb-mini-btn nb-mini-btn--danger');
      delBtn.setAttribute('type', 'button');
      delBtn.setAttribute('data-role', 'chat-file-delete');
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => {
        void (async () => {
          /*
           * 两步确认：第一下把按钮变成"确认删除？"，再点才真删。
           *
           * 不用 `confirm()` —— 它在 Android WebView 里阻塞主线程。
           * 两次点击既是确认，也不需要额外弹层。
           */
          if (delBtn.getAttribute('data-armed') !== 'true') {
            delBtn.setAttribute('data-armed', 'true');
            delBtn.textContent = '确认删除？';
            say(`再点一次就删除「${file.name}」。`, 'warn');
            return;
          }
          const outcome = await callbacks.onDelete(file.id);
          if (outcome.ok) {
            say(outcome.detail, 'ok');
            await paint();
          } else {
            say(outcome.detail, 'danger');
          }
        })();
      });
      tools.append(delBtn);

      row.append(tools);
      listHost.append(row);
    }
  };

  cleanBtn.addEventListener('click', () => {
    void (async () => {
      const files = await callbacks.loadFiles();
      if (files === null) {
        say('读不到聊天文件列表。检查一下引擎是否还在运行。', 'warn');
        return;
      }
      const empties = files.filter((file) => isDeletableEmptyChat(file));
      if (empties.length === 0) {
        say('没有可以清理的空聊天。', 'warn');
        return;
      }

      /* 两步确认，与每行的「删除」同一套手势 */
      if (cleanBtn.getAttribute('data-armed') !== 'true') {
        cleanBtn.setAttribute('data-armed', 'true');
        cleanBtn.textContent = `确认删除 ${String(empties.length)} 个？`;
        say(
          `这 ${String(empties.length)} 个文件里没有任何对话内容（只有开场白）。再点一次就删掉。`,
          'warn',
        );
        return;
      }

      /*
       * 串行删。并发删同一个目录下的多个文件在 ST 那边没有保证，
       * 而且失败时也说不清是哪一个 —— 串行的代价只是多几百毫秒。
       */
      /*
       * ★★★ 逐条记录**删了什么、多大、几条**（2026-11-14）。
       *
       * ## 为什么必须记
       *
       * 用户这次给了一份 2.2 万行的引擎日志，里面只有 20 行
       * `Deleted file: …jsonl`，**没有一个字提到那些文件里原来有什么**。
       *
       * 于是"记录是不是被清理功能删掉的"这个问题，谁都答不了 ——
       * 包括我。日志该能回答的问题答不了，等于没有日志。
       *
       * 现在每条记成：
       *
       * ```text
       *   [清理] 删除 <名字> count=0 size=312B
       * ```
       *
       * 下次同样的疑问，一行就能定案。
       *
       * 走 `onNotify` 的 `info` 通道而不是新加一条桥调用：
       * 它已经会落进 `app-00N-.log`（`StLog`）。
       */
      let done = 0;
      let failed = 0;
      for (const file of empties) {
        callbacks.onNotify(
          `[清理] 删除 ${file.name} count=${String(file.count)} size=${String(file.sizeBytes)}B`,
          'info',
        );
        const outcome = await callbacks.onDelete(file.id);
        if (outcome.ok) done += 1;
        else failed += 1;
      }
      say(
        failed === 0
          ? `已清理 ${String(done)} 个空聊天文件。`
          : `清理了 ${String(done)} 个，${String(failed)} 个没删掉（可以逐个点「删除」重试）。`,
        failed === 0 ? 'ok' : 'warn',
      );
      await paint();
    })();
  });

  void paint();
  return root;
}
