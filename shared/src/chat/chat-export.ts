/**
 * 聊天记录导出为 TXT（2026-11-14，v0.1.9）。
 *
 * ## 为什么是纯函数
 *
 * 导出要处理五件容易做错的事（见下面 `chatToText` 的注释），
 * 而它们在真机上每次都要"导出 → 打开文件 → 看对不对"，一周也验不完。
 * 做成纯函数就能在 Node 里直接喂各种畸形输入跑断言。
 *
 * ## 为什么不做成 Markdown
 *
 * 用户口径是 TXT（`PLAN.md` v0.1.9 §二，2026-11-09 已确认）。
 * TXT 的好处是**任何设备、任何聊天软件都能直接看**，
 * 转发到微信不会被折成一坨。
 */

import type { StChatMessage } from '../st-adapter/types.js';

/**
 * `send_date` 的三种形态。
 *
 * ST 存的是人可读的英文时间，而**有些卡/有些路径**给的是 ISO：
 *
 * ```text
 *   "November 8, 2026 9:03pm"      ← ST 的 `toLocaleString` 常见输出
 *   "November 8, 2026 9:03 pm"     ← 带空格
 *   "2026-11-11T19:30:00.000Z"     ← ISO
 * ```
 *
 * ## ★★★ 为什么不能只靠 `Date.parse`
 *
 * 实测（Node 22 / V8）：
 *
 * ```text
 *   Date.parse('November 8, 2026 9:03pm')   → NaN     ← 差一个空格就废
 *   Date.parse('November 8, 2026 9:03 pm')  → OK
 *   Date.parse('Nov 8, 2026 9:03pm')        → NaN     ← 缩写也不行
 * ```
 *
 * 而 ST 存的恰恰是**不带空格的那个**。所以必须先补空格再解析 ——
 * 否则全部记录的时间都会退化成"原样输出"，需求②等于没做。
 *
 * 这个坑是判据用**真样本**跑出来的：如果判据只断言 `/[2026-11-08/`，
 * 它会在"原样输出"的分支上也匹配到，永远绿。
 */
function normalizeEnglishStamp(text: string): string {
  /*
   * 在 `am`/`pm` 前面补空格。
   *
   * ★ 不许用 `\b(\d)`：`9:03pm` 里 `3` 与 `p` **都是词字符**，
   * 中间没有词边界 ⇒ `\b` 永不成立，整条正则匹配不到（实测 null）。
   * 这个坑是判据用真样本跑出来的，光看代码看不出来。
   *
   * 用 `(\d)\s*(am|pm)`：只会命中"数字紧跟 am/pm"，
   * 而那个组合基本只出现在时间里。`\s*` 贪婪 ⇒ 已经是 `9:03 pm`
   * 的会原样替换成自己，**幂等**，重复调用安全。
   */
  return text.replace(/(\d)\s*(am|pm)/gi, '$1 $2');
}

function formatStamp(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (text === '') return '';

  let ms = Date.parse(text);
  if (!Number.isFinite(ms)) ms = Date.parse(normalizeEnglishStamp(text));

  /*
   * ★ 解析不了就**原样输出**。
   *
   * 不许输出 `Invalid Date`：那对用户毫无信息量，还显得程序坏了。
   * 原样输出至少让他知道"这条记录里存的就是这个字符串"。
   */
  if (!Number.isFinite(ms)) return text;

  const at = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** 导出用的说话人名 */
function speakerOf(message: StChatMessage, userName: string): string {
  if (message.is_user === true) return userName;
  /*
   * 非用户消息用 `message.name` —— **群聊就靠这个区分角色**。
   * 写死成卡名的话，群聊里三个角色的话全归到一个人头上。
   */
  const name = typeof message.name === 'string' ? message.name.trim() : '';
  return name === '' ? '角色' : name;
}

export interface ChatExportOptions {
  /** 角色名（写进标题） */
  characterName: string;
  /** 用户显示名；缺省「我」 */
  userName?: string;
  /** 注入时间便于测试 */
  now?: Date;
}

export interface ChatExportResult {
  /** 完整的 TXT 内容（永远非空 —— 空聊天也有一段说明） */
  text: string;
  /** 实际写进文件的消息条数 */
  count: number;
  /** 未导出的候选回复条数（末尾会注明） */
  skippedSwipes: number;
  /** 是否为空聊天（此时 `text` 是说明句，不是空串） */
  empty: boolean;
}

const RULE = '─'.repeat(28);

/**
 * 把 ST 的消息数组转成一份给人读的 TXT。
 *
 * ## 五个必须处理的细节（每一条都对应一个真机会碰到的形状）
 *
 * ```text
 * ① is_user 判谁说的         —— 不按顺序猜（ST 有布尔字段）
 * ② send_date 是字符串       —— 能解析就转本地格式，解析不了原样输出
 * ③ swipes 候选不导出        —— 但末尾要注明数量，否则用户以为丢了
 * ④ 空聊天要能导出           —— 给说明句，不许生成空文件
 * ⑤ 群聊要带角色名           —— 用 message.name，不是卡名
 * ```
 *
 * ## 为什么不导出 `is_system` 的消息
 *
 * 那是 ST 内部插的（隐藏提示、系统提示），不是对话内容。
 * 与 `prompt-assemble.ts` 的 `historyToMessages` 口径一致 ——
 * 两处对"什么算对话"必须同一个定义，否则用户看到的和对不上。
 */
export function chatToText(
  messages: readonly StChatMessage[],
  options: ChatExportOptions,
): ChatExportResult {
  const userName = options.userName !== undefined && options.userName.trim() !== ''
    ? options.userName.trim()
    : '我';
  const characterName = options.characterName.trim() === '' ? '角色' : options.characterName.trim();
  const at = options.now ?? new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const exportedAt =
    `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`;

  const talk = messages.filter((one) => one.is_system !== true);

  if (talk.length === 0) {
    /*
     * ★ 空聊天不许生成一个只有标题的空文件。
     *
     * 用户点「导出」→ 拿到一个 0 字节的文件 → 打开是空白 →
     * 会以为导出坏了或记录丢了。写一句说明才说得清。
     */
    return {
      text:
        `${characterName} · 聊天记录\n` +
        `导出时间：${exportedAt}\n\n` +
        `${RULE}\n\n` +
        '（还没有聊天记录）\n',
      count: 0,
      skippedSwipes: 0,
      empty: true,
    };
  }

  let skippedSwipes = 0;
  const blocks: string[] = [];

  for (const message of talk) {
    const body = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (body === '') continue;

    /*
     * 候选回复计数：`swipes` 里第 0 项是原始那条，其余是重新生成的。
     * 当前显示的由 `swipe_id` 指，但**导出的是 `mes` 本身**
     * （那已经是用户选中的那条），所以未采用的数量 = 总数 - 1。
     */
    if (Array.isArray(message.swipes) && message.swipes.length > 1) {
      skippedSwipes += message.swipes.length - 1;
    }

    const stamp = formatStamp(message.send_date);
    const who = speakerOf(message, userName);
    /* 没时间就不写方括号 —— 写 `[]` 或 `[未知]` 都只是噪音 */
    const head = stamp === '' ? `${who}：` : `[${stamp}] ${who}：`;
    blocks.push(`${head}\n${body}`);
  }

  if (blocks.length === 0) {
    /*
     * 有消息但正文全是空（或全是 system）—— 与"真空"给同一句说明，
     * 但 `empty` 为 true，调用方据此可以不说"共 0 条"。
     */
    return {
      text:
        `${characterName} · 聊天记录\n` +
        `导出时间：${exportedAt}\n\n` +
        `${RULE}\n\n` +
        '（还没有聊天记录）\n',
      count: 0,
      skippedSwipes,
      empty: true,
    };
  }

  const header =
    `${characterName} · 聊天记录\n` +
    `导出时间：${exportedAt}\n` +
    `共 ${String(blocks.length)} 条\n\n` +
    `${RULE}`;

  const tail =
    skippedSwipes > 0
      ? `\n${RULE}\n\n另有 ${String(skippedSwipes)} 条未采用的候选回复未导出。\n`
      : '\n';

  return {
    text: `${header}\n\n${blocks.join('\n\n')}\n${tail}`,
    count: blocks.length,
    skippedSwipes,
    empty: false,
  };
}

/** 导出用的文件名（去扩展名、滤掉不安全字符，与分享 PNG 同一套规则） */
export function chatExportFileName(characterName: string): string {
  let out = '';
  for (const ch of Array.from(characterName.trim())) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if ('/\\:*?"<>|'.includes(ch)) continue;
    out += ch;
  }
  out = out.replace(/\.txt$/i, '').trim().slice(0, 40);
  return `${out === '' ? '聊天记录' : out} · 聊天记录.txt`;
}
