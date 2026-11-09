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
