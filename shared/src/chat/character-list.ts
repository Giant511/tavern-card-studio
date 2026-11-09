/**
 * 角色列表解析（v0.1.7 / 第五批问题二）。
 *
 * ## 为什么要单独一个解析器
 *
 * 用户报的是"聊天页没有任何角色可选"。而取证发现这里**有两个**断点：
 *
 * 1. 测试卡没落库（生成函数从不被调用）；
 * 2. `onPickCharacter` 硬编码 `async () => null` —— 选卡器根本没实现。
 *
 * 修第 2 个就必然要解析 `/api/characters/all` 的返回。而那个返回有两个
 * 已知的坑，写在契约里但很容易漏：
 *
 * · **裸数组**，不是 `{data: []}`（`characters.js:1466` 的 `send(data)`）
 * · 元素是 `{ name, avatar, chat, ... }`，其中 **`avatar` 才是文件标识**
 *   （`default_Seraphina.png`），`name` 只是显示名。
 *   后续 `/api/chats/get` 要的是 `avatar`，用 `name` 会 404。
 *
 * 所以这两件事各写一份必然出错，收在这里并单测。
 */

/** 角色列表里的一项（只保留我们真正要用的字段） */
export interface CharacterSummary {
  /** 显示名（用户看这个） */
  name: string;
  /**
   * 文件标识（`xxx.png`）。**后续所有接口都用它**，不是 `name`。
   */
  avatar: string;
  /** 最近一次聊天文件名。空串 = 没聊过 */
  lastChat: string;
}

export type ParseCharactersResult =
  | { ok: true; items: CharacterSummary[] }
  | { ok: false; reason: string };

/**
 * 解析 `/api/characters/all` 的响应体。
 *
 * ## 三种情况分开处理
 *
 * · 空数组 ⇒ `ok: true, items: []`（**不是失败** —— "还没有角色"是合法状态）
 * · 不是数组 ⇒ `ok: false`（契约说这是裸数组；不是数组说明形状变了）
 * · 数组里个别元素缺字段 ⇒ 跳过那一条，但**不整份失败**
 *   （一张坏卡不该让整个列表打不开）
 */
export function parseCharacterList(raw: unknown): ParseCharactersResult {
  let data: unknown = raw;

  // 允许直接传字符串（Rust 侧返回的是 JSON 文本）
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data === '' ? '[]' : data);
    } catch {
      return { ok: false, reason: '角色列表不是有效的 JSON' };
    }
  }

  if (!Array.isArray(data)) {
    return { ok: false, reason: '角色列表的形状不对（应该是数组）' };
  }

  const items: CharacterSummary[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;

    const avatar = typeof obj['avatar'] === 'string' ? obj['avatar'].trim() : '';
    // 没有 avatar 就没法继续（后续接口全靠它），跳过这一条
    if (avatar === '') continue;

    /*
     * `name` 缺失时**回落到 avatar 去掉扩展名**，而不是丢掉这一条。
     *
     * 真实情况：用户的卡可能是手工放进 characters/ 的，个别卡没有 name
     * 字段（或为空）。此时列表里显示 `xxx.png` 难看但可用 ——
     * 比"卡明明在库里却列不出来"好得多。
     */
    const rawName = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
    const name = rawName !== '' ? rawName : avatar.replace(/\.png$/i, '');

    const chat = typeof obj['chat'] === 'string' ? obj['chat'].trim() : '';

    items.push({ name, avatar, lastChat: chat });
  }

  return { ok: true, items };
}
