/**
 * 聊天文件名与"该不该保存"（v0.1.7 / 第八批问题二）。
 *
 * ## 为什么文件名要由客户端生成
 *
 * `POST /api/chats/save` 的契约（`docs/adapter-contract-st-v1.19.md:130`）是：
 *
 * ```text
 * 请求 {avatar_url, file_name, chat, force?}
 * 响应 {ok: true}            ← **不带文件名**
 * ```
 *
 * 也就是说：**ST 不会告诉我它把这次保存存成了什么名字**。
 * 而"新建聊天"时我们手里根本没有文件名（聊天文件要等第一次保存才存在）。
 *
 * 所以文件名只能自己定，并且**定完要记住** —— 否则每次保存都生成新名字，
 * 一次对话会在 ST 里留下十几个文件。
 *
 * ## 格式：跟随 ST 的观感，但不假装是它的实现
 *
 * ST 自己生成的名字形如 `角色名 - 2024-5-17@14h30m12s`。
 * 这里用同样的观感（角色名 + 日期 + 时分秒），但：
 *
 * · **月份/日期不补零**（与 ST 一致），因为用户对照 ST 自己的列表时更自然；
 * · 非法文件名字符一律换成 `_`（Windows 上 `\ / : * ? " < > |` 都会失败）；
 * · 中间的分隔符用 ` - `（含空格），与 ST 一致。
 *
 * ⚠️ 如实说明：**这不是 ST 的实现**，是我们自己定的。
 * 我拿不到 ST 内部那个生成函数（源码被压缩进 APK 资产），
 * 所以没有声称"与 ST 完全一致"。只要名字合法，ST 会照单收下 ——
 * 生成、读取、列表、删除都用这个名字，行为是自洽的。
 *
 * ## 为什么"该不该保存"要单独一个函数
 *
 * 用户要求"用户消息发送后即保存、assistant 回复完成后即保存"。
 * 但**不是所有 messages 变化都该落库**：
 *
 * | 变化 | 该存吗 | 为什么 |
 * |---|---|---|
 * | 用户发了一条 | 该存 | 用户期望"发出去了就不丢" |
 * | assistant 回复完成 | 该存 | 同上 |
 * | 流式中间帧（每 120ms 一次） | **不该** | 一秒钟十几次写盘，且内容不完整 |
 * | 流式失败、占位被删 | 不该 | 什么也没多出来 |
 * | `loadChat` 刚载入 | 不该 | 内容与文件一致，写一遍纯属多余（且整份覆盖有风险） |
 * | 空消息列表 | 不该 | 空历史覆盖真实文件是**数据丢失**（陷阱 #1） |
 */

/** 文件名里不能出现的字符（Windows 全部非法；其他平台留着也没意义） */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 造一个聊天文件名（**不带扩展名**）。
 *
 * ST 的 `file_name` 是不带 `.jsonl` 的（契约里 `file_id` 是无扩展名的那个）。
 *
 * @param characterName 角色显示名。空的话退回 `chat`，绝不产出空名字
 *   —— 空名字会让 ST 用默认名，而我们就不知道文件叫什么了。
 * @param now 注入时间便于测试
 */
export function makeChatFileName(characterName: string, now: Date = new Date()): string {
  const who = characterName.trim() === '' ? 'chat' : characterName.trim();
  const safe = who.replace(ILLEGAL, '_');
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  const d = now.getDate();
  const h = now.getHours();
  const mi = `${String(now.getMinutes()).padStart(2, '0')}`;
  const s = `${String(now.getSeconds()).padStart(2, '0')}`;
  return `${safe} - ${String(y)}-${String(mo)}-${String(d)}@${String(h)}h${mi}m${s}s`;
}

/**
 * 从 ST 的聊天列表条目里取"最后一条消息的时间"（毫秒）。
 *
 * ## ★★★ 为什么必须有这个函数（2026-11-14，用户报"记录没了"）
 *
 * ST 的 `/api/characters/chats` 返回的 `last_mes` **有两种类型**，
 * 这一点在它的源码里写得很清楚（`src/endpoints/chats.js`）：
 *
 * ```js
 *   // 文件非空时 —— 用最后一条消息的发送时间
 *   chatData.last_mes = jsonData.send_date || new Date(...).toISOString();
 *
 *   // 文件为空时 —— 用文件修改时间（数字）
 *   const chatData = { ..., last_mes: stats.mtimeMs };
 * ```
 *
 * 也就是说：
 *
 * ```text
 *   非空文件  last_mes = "2026-11-11T19:30:00.000Z"   ← ISO 字符串
 *   空文件    last_mes = 1763107200000                  ← 数字
 * ```
 *
 * ## 原来的写法为什么会选错文件
 *
 * `findLatestChat()` 里写的是：
 *
 * ```ts
 *   const at = typeof info['last_mes'] === 'number' ? info['last_mes'] : 0;
 *   if (best === null || at > best.at) best = { id, at };
 * ```
 *
 * 后果：
 *
 * ```text
 *   所有**非空**文件  → at = 0        （ISO 字符串不算 number）
 *   所有**空**文件    → at = 1.7e12   （mtimeMs 是 number）
 *   ⇒ 空文件恒赢；没有一个空文件时，永远选中列表里第一个
 * ```
 *
 * 用户看到的就是"打开都是同一个聊天记录"，而且**很可能是个空的** ——
 * 这正是"上午退出后记录就没了"的直接原因。
 *
 * 注意 `Array.prototype.sort` 那类"只比较不取值"的地方不会暴露这个 bug
 * （ISO 字符串的字典序恰好等于时间序），所以它只在 `typeof === 'number'`
 * 这种**类型判断**处才炸 —— 这是个隐蔽点。
 */
export function chatFileLastAt(info: Record<string, unknown>): number {
  const raw = info['last_mes'];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === 'string') {
    /*
     * ISO 字符串走 `Date.parse`。
     *
     * 解析失败给 0 而不是 `Date.now()`：给 now 会把一个坏条目伪装成
     * "最新的"，反而更糟。
     */
    const at = Date.parse(raw);
    return Number.isFinite(at) ? at : 0;
  }
  return 0;
}

/**
 * 从 ST 的聊天列表条目里取**真实的**消息条数。
 *
 * ## ★★★ 为什么不能用 `last_mes + 1`（2026-11-14）
 *
 * 原实现是（`chat-actions-page.ts` 的 `parseChatFileRows`）：
 *
 * ```ts
 *   const last = Number.parseInt(String(info['last_mes'] ?? ''), 10);
 *   const count = Number.isFinite(last) && last >= 0 ? last + 1 : 0;
 * ```
 *
 * 注释把它当成"最后一条的下标"，但 `last_mes` 是**时间**（见上）。
 * 而 `parseInt("2026-11-11T19:30:00.000Z")` 会取到**年份 2026**，
 * 于是 `count = 2027`。
 *
 * 用户截图里 8 个文件**全都显示 2027 条**，就是这个：
 * 所有文件的日期都以 `2026-` 开头 ⇒ parseInt 恒得 2026 ⇒ 恒显示 2027。
 * 他说的"数字也不是真实数量"完全正确。
 *
 * ## 真正的条数字段
 *
 * ```text
 *   /api/characters/chats   → chat_items       （ST 的 readInfoFromChatHeader）
 *   /api/chats/search       → message_count    （ST 的搜索端点）
 * ```
 *
 * 两个都认（搜索端点将来可能被用到），都没有就返回 0 ——
 * **不猜**。猜错的数字比没有数字更糟：用户会据此判断"我的记录还在不在"。
 */
export function chatFileCount(info: Record<string, unknown>): number {
  for (const key of ['chat_items', 'message_count']) {
    const raw = info[key];
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}

/** 判断一次保存请求要不要发 */
export interface ShouldSaveInput {
  /** 当前消息列表 */
  messages: readonly { mes?: unknown }[];
  /** 角色标识；`null` = 还没选角色，不该存 */
  avatar: string | null;
  /**
   * 上一次成功保存时的**指纹**（`chatFingerprint()` 的结果）。
   * `null` = 这次会话还没保存过。
   */
  lastSavedFingerprint: string | null;
}

/**
 * 内容指纹：**条数 + 最后一条的长度**。
 *
 * ## 为什么不用深比较
 *
 * 深比较要把整份历史序列化（几十条 × 每条几百字），而这段代码
 * 在"每次消息变化"时都会被调用。用户切 Tab、发消息、收回复都会碰它。
 *
 * ## 为什么这两项够
 *
 * | 变化 | 条数 | 末条长度 | 能抓住吗 |
 * |---|---|---|---|
 * | 用户发了一条 | +1 | 变 | ✅ |
 * | assistant 回复完成（占位 → 正文） | 不变 | **变** | ✅ |
 * | 重新生成（末条被替换） | 不变 | 变 | ✅ |
 * | 删掉占位（生成失败） | -1 | 变 | ✅ |
 * | 流式中间帧 | 不变 | 变 | ✅（但调用方本来就不会在中间帧触发） |
 * | 纯重渲染 | 不变 | 不变 | ✅ 跳过 |
 *
 * 抓不住的情况只有"条数相同、末条长度也相同、但内容变了"——
 * 那意味着同样长度的重写，而本项目的写路径只有"重新生成"，
 * 它改的必然是正文长度或条数。
 *
 * 如实说明：这是**概率性判据**，不是内容哈希。选它的理由是成本；
 * 代价是极端情况下会漏存一次，而上层每个明确的"消息变化点"都会触发一次保存，
 * 所以不会真的丢。
 */
export function chatFingerprint(messages: readonly { mes?: unknown }[]): string {
  const last = messages[messages.length - 1];
  const tail = typeof last?.mes === 'string' ? last.mes.length : -1;
  return `${String(messages.length)}:${String(tail)}`;
}

/**
 * 把 ST 的 `file_size`（人类可读，来自 npm `bytes` 包）转成字节数。
 *
 * ```text
 *   "0 B"      → 0        "512 B"  → 512
 *   "1 KB"     → 1024     "1.2 KB" → 1228
 *   "3.4 MB"   → 3565158
 * ```
 *
 * ## ★★★ 为什么需要它（2026-11-14，真机日志驱动）
 *
 * `chat_items` **不能单独作为"这个文件是空的"的依据** —— ST 在两种情况下
 * 都报 0，而其中一种是有内容的：
 *
 * ```js
 *   // src/endpoints/chats.js
 *   if (stats.size === 0) return chatData;                 // 真的空
 *
 *   rl.on('close', () => {
 *     if (解析成功) chatData.chat_items = itemCounter - 1;
 *     else          chatData.chat_items = Math.max(itemCounter - 2, 0);   // ← 末行坏了
 *   });
 * ```
 *
 * 末行解析失败时它减 2。**只有一条消息的聊天**（文件两行：header + 1 条）
 * 于是得到 `max(2-2,0) = 0` —— 一个有条目的聊天被报成"空的"。
 *
 * 而「清理空聊天」正是按 `chat_items === 0` 删文件。
 * ⇒ 一条**独立**的体积信号是唯一能挡住"误删真记录"的东西。
 *
 * ## 解析失败返回 null
 *
 * 调用方据此**不删**（拿不准就不动手）。不许返回 0 —— 那等于
 * "读不到大小就当成空的"，正好把要防的事做成默认行为。
 */
export function chatFileSizeBytes(info: Record<string, unknown>): number | null {
  const raw = info['file_size'];
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;

  /* `bytes` 包的输出形如 "1.2 KB" / "0 B"，也兼容没有空格与常见变体 */
  const match = /^([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB)$/i.exec(text);
  if (match === null) return null;

  const value = Number.parseFloat(match[1] ?? '');
  if (!Number.isFinite(value) || value < 0) return null;

  const unit = (match[2] ?? 'B').toUpperCase();
  const scale: Record<string, number> = {
    B: 1,
    KB: 1024,
    KIB: 1024,
    MB: 1024 ** 2,
    MIB: 1024 ** 2,
    GB: 1024 ** 3,
    GIB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  const factor = scale[unit];
  if (factor === undefined) return null;
  return Math.round(value * factor);
}

/**
 * ST 用**两个不同的字符串**表示"没有内容"，而它们的含义完全不同。
 *
 * ```js
 *   // src/endpoints/chats.js
 *
 *   // ① 文件真的是空的（size === 0）
 *   const chatData = { ... chat_items: 0, mes: '[The chat is empty]' ... };
 *
 *   // ② 末行解析失败 —— **文件可能有内容**，只是最后一行读不出来
 *   chatData.chat_items = Math.max(itemCounter - 2, 0);
 *   chatData.mes = '[The message is empty]';
 * ```
 *
 * ## ★★★★★ 这就是"清理空聊天"能误删真记录的那条路
 *
 * 一个 header + **1 条消息**的文件：`itemCounter = 2` ⇒ `max(2-2,0) = 0`
 * ⇒ `chat_items` 报 **0**，但 `mes` 是 `'[The message is empty]'`。
 *
 * 用户的生产日志里对得上：`检查点 - 2026-11-14@19h57m35s.jsonl` 创建
 * **11 秒后**就被清理删掉了 —— 而"保存检查点"的语义是把当前对话存一份，
 * 它不可能没有内容。
 *
 * ⇒ 判据不能只看 `chat_items`，必须同时看 `mes`：
 * **只有 `'[The chat is empty]'` 才算真空。**
 *
 * 体积只能当辅助（header 200–600 字节、header+1 条短消息 500–900 字节，
 * 两者区间重叠，单靠阈值分不开）。这里保留它做最后一道保险。
 */
export const EMPTY_CHAT_MARKER = '[The chat is empty]';

/** ST 是否明确说"这个文件是空的"（注意与 `[The message is empty]` 区分） */
export function chatFileSaysEmpty(info: Record<string, unknown>): boolean {
  const mes = info['mes'];
  return typeof mes === 'string' && mes.trim() === EMPTY_CHAT_MARKER;
}

/**
 * 「清理空聊天」能安全删掉的行。
 *
 * ## 四道闸，缺一不可
 *
 * ```text
 *   ① !current              —— 不删当前打开的那条（删了下一句会重建，死循环）
 *   ② countKnown && count===0 —— 真读到了条数，且是 0
 *   ③ saysEmpty             —— ST 的 mes 明确是 "[The chat is empty]"
 *                              （挡住"末行损坏"那一类：它也报 0 条，但有内容）
 *   ④ sizeBytes 已知且 ≤ 1KB  —— 体积兜底（区间重叠，只当保险）
 * ```
 *
 * 任何一条"拿不准"都返回 `false` —— **宁可留垃圾，不可删记录**。
 * 清理是便利功能，删错是不可逆的。
 */
export const EMPTY_CHAT_MAX_BYTES = 1024;

export function isDeletableEmptyChat(row: {
  countKnown: boolean;
  count: number;
  sizeBytes: number | null;
  saysEmpty: boolean;
  current: boolean;
}): boolean {
  if (row.current) return false;
  if (!row.countKnown) return false;
  if (row.count !== 0) return false;
  if (!row.saysEmpty) return false;
  if (row.sizeBytes === null) return false;
  return row.sizeBytes <= EMPTY_CHAT_MAX_BYTES;
}

/**
 * 还没有文件名时，这次消息变化该不该**新建**一个聊天文件。
 *
 * ## ★★★★★ 为什么需要这条判断（2026-11-14，用户报"每切一次角色多一个文件"）
 *
 * 原来的写法是"没有名字就造一个"：
 *
 * ```ts
 *   if (this.chatFileName === null && avatar !== null) {
 *     this.chatFileName = makeChatFileName(name);
 *   }
 * ```
 *
 * 而**切换角色会把 `chatFileName` 清成 null**（那是必须的，否则会写进
 * 上一个角色的目录）。于是每次切角色都走这条分支。
 *
 * 而触发点比想象的密：`applyOpening()` 注入开场白后也会调
 * `handleChatChanged(opening)` —— 那一步只是想"把开场白显示出来"，
 * 却顺手建了一个**只有开场白的新文件**。
 *
 * ```text
 *   点角色 B → 清名 → 注入开场白 → handleChatChanged
 *            → 造新名字 → 写盘 → 磁盘多一个只有 1 条消息的文件
 *   切回角色 A 再切回来 → 再来一次
 * ```
 *
 * 用户截图里 8 个同角色的文件、全是空壳，就是这个。
 *
 * ## 判据：**有用户消息才算"一段对话开始了"**
 *
 * ```text
 *   只有开场白（全是 assistant）  ⇒ 不建 —— 那只是"他还没开口"
 *   有任意一条 is_user === true    ⇒ 建  —— 用户真的聊了，必须落盘
 * ```
 *
 * 这也和 `applyOpening()` 自己的判据一致（它用
 * `messages.some(one => one.is_user === true)` 决定要不要重新注入开场白）。
 *
 * ## 另一条：**恢复期间一律不建**
 *
 * `restoreLatestChat()` 是异步的，最长重试 60 秒。在它跑完之前
 * `chatFileName` 是 null，此时若新建文件，就等于把历史扔掉换成空壳 ——
 * 而且新文件的 mtime 最新，下一轮"找最近"会优先选中它，
 * 历史从此再也打不开（正是用户遇到的"上午的记录没了"）。
 *
 * 所以恢复中的判断放在调用方（它知道自己在恢复），这里只管
 * "内容够不够格"。
 */
export function shouldStartNewChatFile(messages: readonly { is_user?: unknown }[]): boolean {
  return messages.some((one) => one?.is_user === true);
}

/**
 * 该不该发一次保存。
 *
 * ## 两类判断，各有各的道理
 *
 * **安全类**（不做会出数据事故）：
 *   · 没角色 ⇒ 不知道往哪个目录写
 *   · 空历史 ⇒ `/api/chats/save` 是**整份覆盖**，用 `[]` 覆盖等于清空用户历史，
 *     而且不报错（陷阱 #1）。这条是硬性的。
 *
 * **去重类**（不做只是浪费一次请求）：
 *   · 指纹没变 ⇒ 内容与上次存的一样
 */
export function shouldSaveChat(input: ShouldSaveInput): boolean {
  if (input.avatar === null || input.avatar.trim() === '') return false;
  if (input.messages.length === 0) return false;
  return chatFingerprint(input.messages) !== input.lastSavedFingerprint;
}
