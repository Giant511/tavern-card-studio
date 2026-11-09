/**
 * 提示词开关的写回（2026-11-03，第二十二批）。
 *
 * ## 为什么写回是"改一整份预设体"
 *
 * ST 的 `POST /api/presets/save` 收的是**整份预设**（62 个键），
 * 不是"改一个字段"。少传一个键就等于把它删了 ——
 * 而预设里还有模型名、采样参数、格式串一大堆东西。
 *
 * 所以这里的做法是：拿原 body → 只改 `prompt_order` 里的 `enabled` →
 * 整份交回去。**绝不新建一个只含 prompts 的对象**。
 *
 * ## 为什么不直接写 `settings.json`
 *
 * 实机验证过（memory §90.2）：`settings.json` 的 `oai_settings` 是空的，
 * 整套 `prompts` + `prompt_order` 在**预设文件**里。
 * 写 settings.json 会"看起来成功了但一点不生效"。
 */

import type { ParsedPromptConfig } from './prompt-config.js';

/**
 * 在预设体里改一个提示词的启用状态，返回**新的** body。
 *
 * ## 为什么不改原对象
 *
 * 调用方（外壳）可能还持有原 body 做别的事（比如再读一次当前预设）。
 * 就地改会让"读到的"和"保存的"变成一个东西 ——
 * 万一保存失败，内存里已经是改过的状态，界面与实际就不一致了。
 *
 * ## 找不到那条 order 时怎么办
 *
 * 返回 `{ ok: false, reason }` 而不是硬塞一条新的。
 *
 * 硬塞的后果：用户在 A 环境下有 `character_id: 100001` 的 order，
 * 我们塞一条 `100000` 的 —— 于是预设里有了两条，而 ST 只会读其中一条。
 * 表现为"改了开关，重启后变回去了"，极难归因。
 *
 * @returns `ok: true` 时 `body` 是新对象；`ok: false` 时 `reason` 给人看
 */
export function setPromptEnabled(
  body: unknown,
  config: ParsedPromptConfig,
  identifier: string,
  enabled: boolean,
): { ok: true; body: Record<string, unknown>; changed: boolean } | { ok: false; reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: '当前预设的内容读不出来（不是对象），没法保存开关。' };
  }

  const root = body as Record<string, unknown>;
  const orderList = root['prompt_order'];
  if (!Array.isArray(orderList) || orderList.length === 0) {
    return { ok: false, reason: '这个预设里缺少提示词顺序表，暂时无法保存开关。' };
  }

  /*
   * 找出"我们正在用的那一条" order。
   *
   * `parsePromptConfig` 已经做过逐级退让（角色卡 id → 100000 → only-one），
   * 这里必须用**同一套判据**重算一遍 —— 否则可能改到另一条上。
   * 判据不同的两份实现，是"开关改了但没生效"的经典成因。
   */
  const targetIndex = pickOrderIndex(orderList, config);
  if (targetIndex < 0) {
    return { ok: false, reason: '找不到这份预设正在使用的提示词顺序，没法保存开关。' };
  }

  const entry = orderList[targetIndex];
  if (entry === null || typeof entry !== 'object') {
    return { ok: false, reason: '提示词顺序表的内容不对，没法保存开关。' };
  }

  const rows = (entry as Record<string, unknown>)['order'];
  if (!Array.isArray(rows)) {
    return { ok: false, reason: '提示词顺序表是空的，没法保存开关。' };
  }

  const rowIndex = rows.findIndex((one) => {
    if (one === null || typeof one !== 'object') return false;
    return (one as Record<string, unknown>)['identifier'] === identifier;
  });
  if (rowIndex < 0) {
    return { ok: false, reason: '顺序表里没有这条提示词，没法保存开关。' };
  }

  const row = rows[rowIndex] as Record<string, unknown>;
  if (row['enabled'] === enabled) {
    /* 已经是这个状态：不用写，省一次 IO 也避免无意义的保存时间戳 */
    return { ok: true, body: root, changed: false };
  }

  /*
   * ★ 逐层复制，只换最里面那个值。
   *
   * 不用 `structuredClone`：preset 里可能有 JSON 不支持的值吗？不会。
   * 但它会把整个 62 键的对象深拷一遍 —— 而这里只需要动 4 层里的 1 个布尔。
   * 手写浅拷贝链更省，也更容易看出"到底改了哪一层"。
   */
  const nextRows = rows.map((one, index) =>
    index === rowIndex ? { ...(one as Record<string, unknown>), enabled } : one,
  );
  const nextEntry = { ...(entry as Record<string, unknown>), order: nextRows };
  const nextOrderList = orderList.map((one, index) => (index === targetIndex ? nextEntry : one));

  return { ok: true, body: { ...root, prompt_order: nextOrderList }, changed: true };
}

/**
 * 找出"当前正在用"的那条 order 在数组里的下标。
 *
 * 与 `parsePromptConfig` 的 `pickOrder` **同一套退让顺序**：
 *
 * | 顺序 | 条件 |
 * |---|---|
 * | 1 | 与当前角色卡 id 匹配（我们没有卡 id，所以跳过） |
 * | 2 | `100000` |
 * | 3 | **只有一条** |
 *
 * 我们没有角色卡 id（ST 的卡 id 是运行时分配的整数，我们手上没有），
 * 所以第 1 条永远跳过 —— 这与 `parsePromptConfig` 在没有传 `characterId`
 * 时的行为一致。
 *
 * `config.orderSource` 是**读的时候**算出来的结论，这里直接用它，
 * 不重算 —— 重算就是两份实现，迟早分叉。
 */
function pickOrderIndex(orderList: readonly unknown[], config: ParsedPromptConfig): number {
  const idOf = (one: unknown): unknown =>
    one === null || typeof one !== 'object' ? undefined : (one as Record<string, unknown>)['character_id'];

  if (config.orderSource === 'global') {
    const index = orderList.findIndex((one) => String(idOf(one)) === '100000');
    if (index >= 0) return index;
  }

  if (config.orderSource === 'only-one' && orderList.length === 1) {
    return 0;
  }

  /*
   * 兜底：`orderSource` 是 `'character'`（需要卡 id，我们没有）或 `'none'`。
   *
   * 这时按"哪条 order 的内容与 config.order 一模一样"来找 ——
   * 内容相同就是它，比按 id 猜可靠。
   */
  if (config.order !== null) {
    const signature = JSON.stringify(config.order);
    const index = orderList.findIndex((one) => {
      if (one === null || typeof one !== 'object') return false;
      const rows = (one as Record<string, unknown>)['order'];
      return Array.isArray(rows) && JSON.stringify(normalizeRows(rows)) === signature;
    });
    if (index >= 0) return index;
  }

  return -1;
}

/** 把 order 行规整成 `parsePromptConfig` 输出的形状（只留 identifier / enabled） */
function normalizeRows(rows: readonly unknown[]): Array<{ identifier: string; enabled: boolean }> {
  const out: Array<{ identifier: string; enabled: boolean }> = [];
  for (const one of rows) {
    if (one === null || typeof one !== 'object') continue;
    const row = one as Record<string, unknown>;
    const identifier = typeof row['identifier'] === 'string' ? row['identifier'] : '';
    if (identifier === '') continue;
    out.push({ identifier, enabled: row['enabled'] !== false });
  }
  return out;
}
