/**
 * 开场白 → 聊天的第一条消息（2026-11-05，用户决定 2）。
 *
 * ## 为什么需要这个
 *
 * 之前 `newChat()` 是这一句：
 *
 * ```ts
 * this.messages = [];
 * ```
 *
 * 于是导入一张卡、开始聊天，界面是**一片空白** —— 而那张卡的
 * `first_mes` 有 367 字，是它最值钱的部分（用户报的那个现象）。
 *
 * ## ST 的模型：开场白就是历史里的第一条 assistant 消息
 *
 * ST 建新聊天时会把 `first_mes` 写进聊天文件作为第一条消息，
 * 并把 `alternate_greetings` 做成**候选**（左滑切换）。用户那句
 * 「开场白（first_mes）为空，聊天将没有默认开场」的规则提示
 * 说的就是这个位置。
 *
 * 所以这里按同一条路走，而不是"在界面上显示一段提示文字"：
 *
 * ```text
 *   first_mes            → mes
 *   [first_mes, ...alt]  → swipes（只有存在备用开场白时才建）
 *   swipe_id             → 0
 * ```
 *
 * ★ **只有一条时不要建 `swipes`**：`swipeCount()` 在没有 `swipes` 时
 * 返回 1，界面因此不会显示 "1 / 1" 那个噪音指示器。建一个长度 1 的
 * `swipes` 数组会让它显示出来 —— 那是把"没得选"画成了"有一选"。
 *
 * ## 不做的事（写出来，别让人以为漏了）
 *
 * - **不替换宏**：`{{char}}` / `{{user}}` 在界面上按 ST 的习惯渲染成
 *   角色名/用户名（`renderMessageHtml` 已有这条），而**落盘要存原文** ——
 *   ST 的聊天记录里存的就是带宏的原文，替换过的存回去，下次换人设就错了。
 * - **不剥标签**：用户那张卡的 `first_mes` 里自带「初始场景：」
 *   「第一条消息：」两行。作者就是这么写的，改它就是改用户内容。
 * - **不裁空白内容中的有效行**：只 `trim()` 首尾，正文一行不动。
 */

import type { StChatMessage } from '../st-adapter/types.js';

/**
 * 从卡片数据造出"新聊天的起始消息"。
 *
 * @param card ST 卡片数据（`data` 段，或 V1 的顶层）
 * @returns 起始消息数组。没有开场白时返回 `[]`（调用方据此保留空状态）。
 *
 * 判据：`test/opening.test.mjs`。
 */
export function buildOpeningMessages(card: Record<string, unknown>): StChatMessage[] {
  const first = readString(card['first_mes']).trim();
  if (first === '') return [];

  const alternates = readStringArray(card['alternate_greetings'])
    .map((one) => one.trim())
    /*
     * 空白的备用开场白要丢掉：用户在编辑页点"加一条"之后没写就走，
     * 会留下空串。留着它会变成"有一个候选但换过去是空白"。
     */
    .filter((one) => one !== '');

  const name = readString(card['name']);
  const sendDate = new Date().toISOString();

  const base: StChatMessage = {
    name,
    is_user: false,
    send_date: sendDate,
    mes: first,
  };

  /*
   * 没有备用开场白：连 `swipes` 字段都不出现。
   *
   * 这不是省略，是"没有就不要假装有" —— 见文件头那段。
   */
  if (alternates.length === 0) return [base];

  const swipes = [first, ...alternates];
  return [
    {
      ...base,
      swipes,
      swipe_id: 0,
      /*
       * `swipe_info` 与 `swipes` 等长：每条候选各有自己的生成时间。
       *
       * 开场白不是"生成"出来的，所以 `gen_started` / `gen_finished` 留空
       * （ST 对开场白也是这么写的），`send_date` 用同一次时间戳。
       */
      swipe_info: swipes.map(() => ({
        send_date: sendDate,
        gen_started: '',
        gen_finished: '',
      })),
    },
  ];
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((one): one is string => typeof one === 'string');
}
