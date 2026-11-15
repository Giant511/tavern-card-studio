/**
 * 聊天列表的 `last_mes` / 条数解析（2026-11-14）。
 *
 * ## 这两条判据防的是同一类错：**假设了字段的类型和语义**
 *
 * 用户报的三个现象，全部来自这一个字段：
 *
 * ```text
 *   8 个文件都显示 2027 条       ← parseInt(ISO 字符串) 取到年份 2026
 *   打开都是同一个聊天记录        ← typeof last_mes === 'number' 对 ISO 失败
 *   上午的记录没了               ← 选中的是空壳文件
 * ```
 *
 * 而 ST 源码里 `last_mes` 的类型**取决于文件空不空**，这是它的实现细节，
 * 但我们不得不依赖 —— 所以必须有一个地方把它嚼碎，而不是散在各处猜。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  chatFileCount,
  chatFileLastAt,
  chatFileSizeBytes,
  chatFileSaysEmpty,
  isDeletableEmptyChat,
} from '../shared/dist/st-adapter/chat-file.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 去掉块注释与行注释。
 *
 * ## 为什么这几条判据必须 strip
 *
 * 修 bug 时我把**旧代码原文**贴进了注释，作为"原来错在哪"的说明：
 *
 * ```ts
 *  *   const count = last + 1;
 *  *   const at = typeof info['last_mes'] === 'number' ? … : 0;
 * ```
 *
 * 而否定断言 `doesNotMatch(/last \+ 1/)` 会命中这些注释 ⇒ 判据假红。
 *
 * 反过来更危险：**上一次是假绿**（CSS 那条判据读到注释里被删掉的声明，
 * 于是变异不变红）。两个方向都发生过，所以这里必须去注释。
 * 与 §93「判据看错对象」同类。
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   ① last_mes 的两种类型都要解析成毫秒
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ chatFileLastAt：ISO 字符串与数字都要给出正确毫秒', () => {
  /*
   * ST 源码（`src/endpoints/chats.js`）：
   *
   * ```js
   *   // 非空文件
   *   chatData.last_mes = jsonData.send_date || new Date(...).toISOString();
   *   // 空文件
   *   const chatData = { ..., last_mes: stats.mtimeMs };
   * ```
   */
  const iso = '2026-11-11T19:30:00.000Z';
  assert.equal(
    chatFileLastAt({ last_mes: iso }),
    Date.parse(iso),
    'ISO 字符串要走 Date.parse —— 原来 typeof === "number" 直接给 0',
  );

  const ms = 1763107200000;
  assert.equal(chatFileLastAt({ last_mes: ms }), ms, '数字（空文件的 mtimeMs）原样用');

  /* 坏数据不许伪装成"最新" */
  assert.equal(chatFileLastAt({ last_mes: 'not a date' }), 0, '解析失败给 0，不给 now()');
  assert.equal(chatFileLastAt({}), 0, '没有字段给 0');
  assert.equal(chatFileLastAt({ last_mes: null }), 0, 'null 给 0');
});

test('★★★★★ 空文件不许赢过有内容的文件（用户"记录没了"的直接原因）', () => {
  /*
   * 复现原来的判定：
   *
   * ```ts
   *   const at = typeof info['last_mes'] === 'number' ? info['last_mes'] : 0;
   * ```
   *
   * - 非空文件是 ISO 字符串 ⇒ at = 0
   * - 空文件是 mtimeMs 数字 ⇒ at = 1.7e12
   * ⇒ **空文件恒赢**，用户打开的永远是个空壳。
   *
   * 修好之后，"最新"要按真实时间排，且时间相同时有内容的优先。
   */
  const list = [
    { file_id: 'real-old', last_mes: '2026-11-11T19:30:00.000Z', chat_items: 120 },
    { file_id: 'real-new', last_mes: '2026-11-14T08:00:00.000Z', chat_items: 88 },
    { file_id: 'empty-shell', last_mes: 1794000000000, chat_items: 1 },
  ];

  /* 修好后的判定（与 shell.ts 的 findLatestChat 同构） */
  let best = null;
  for (const info of list) {
    const at = chatFileLastAt(info);
    const count = chatFileCount(info);
    if (best === null || at > best.at || (at === best.at && count > best.count)) {
      best = { id: info.file_id, at, count };
    }
  }

  /*
   * `empty-shell` 的 mtimeMs 是 1794000000000（2026-11-07 左右换算），
   * 比 real-new 的 2026-11-14 更早 ⇒ 不该赢。
   *
   * 这里刻意让"空壳的时间戳是数字"，正是原来会赢的那种数据形状。
   */
  assert.notEqual(best.id, 'empty-shell', '空壳文件不许被选为"最近的聊天"');
});

/* ═══════════════════════════════════════════════════════════
   ② 条数要用 ST 真正给的字段
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ chatFileCount：认 chat_items，绝不用 last_mes + 1', () => {
  /*
   * 用户截图里 8 个文件全是 "2027 条消息"。
   *
   * ```text
   *   parseInt("2026-11-11T19:30:00.000Z", 10) = 2026   ← 年份
   *   count = 2026 + 1 = 2027
   * ```
   *
   * 所有文件都以 `2026-` 开头 ⇒ 全部显示 2027。
   */
  assert.equal(chatFileCount({ chat_items: 42 }), 42, 'chat_items 是 ST 给的真正条数');
  assert.equal(chatFileCount({ message_count: 7 }), 7, '搜索端点叫 message_count，也认');
  assert.equal(chatFileCount({ chat_items: 0 }), 0, '空文件就是 0');
  assert.equal(chatFileCount({}), 0, '没有字段给 0（不猜）');

  /*
   * ★ 关键否定断言：只有 `last_mes` 时不许编出一个条数。
   * 这正是 "2027" 的来源。
   */
  assert.equal(
    chatFileCount({ last_mes: '2026-11-11T19:30:00.000Z' }),
    0,
    '只有 last_mes 时必须给 0 —— 它是时间，不是条数',
  );
});

test('★★★★★ 列表页必须调 chatFileCount，不许自己 parseInt(last_mes)', () => {
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  assert.match(src, /chatFileCount\(info\)/, '要用 shared 的解析');

  /* 否定：原来那段 parseInt 的写法不许复活 */
  assert.doesNotMatch(
    src,
    /Number\.parseInt\(String\(lastRaw \?\? ''\)/,
    '不许再把 last_mes 当数字 parse 成条数',
  );
  /* 也不许出现 "last + 1" 这种"下标"假设 */
  assert.doesNotMatch(src, /last \+ 1/, '不许把 last_mes 当"最后一条的下标"');
});

test('★★★★★ findLatestChat 必须调 chatFileLastAt，不许自己判 typeof number', () => {
  const src = stripComments(read('client/src/chat/shell.ts'));
  const at = src.indexOf('private async findLatestChat');
  assert.ok(at > 0, '找不到 findLatestChat');
  const end = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, end < 0 ? src.length : end);

  assert.match(body, /chatFileLastAt\(info\)/, '要用 shared 的解析');
  assert.doesNotMatch(
    body,
    /typeof info\['last_mes'\] === 'number'/,
    '不许自己判类型 —— ISO 字符串会掉进 else 变成 0',
  );
});

test('★★★★★ "找最近"要优先有内容的文件（空壳的 mtime 更新也不该赢）', () => {
  /*
   * 修好时间解析之后还剩一个问题：**空壳文件的 mtime 确实是最新的**。
   *
   * ```text
   *   上午 真历史    08:00（ISO），chat_items = 88
   *   下午 空壳      18:47（mtimeMs，被 applyOpening 创建）
   *   ⇒ 光按时间排，空壳仍然赢 ⇒ 用户还是打不开历史
   * ```
   *
   * 所以判定要分两轮：先在"有内容"的里选，一个都没有才回退。
   *
   * ## 但这里有个陷阱（写这条判据时才想清楚）
   *
   * `chat_items` 是 ST 才给的字段。如果某版本没有它，`chatFileCount`
   * 返回 0 —— 若直接 `count > 0` 过滤，会把**所有文件**排除 ⇒ 空白。
   * 所以只在"确实读到了条数字段"时才认为它是空文件。
   */
  const SHELL = read('client/src/chat/shell.ts');
  const at = SHELL.indexOf('private async findLatestChat');
  const end = SHELL.indexOf('\n  private ', at + 10);
  const body = SHELL.slice(at, end < 0 ? SHELL.length : end);

  assert.match(body, /hasCount/, '要区分"读到 0 条"与"没有条数字段"');
  assert.match(
    body,
    /row\.hasCount && row\.count === 0/,
    '只有"确实读到 0 条"才算空壳',
  );
  assert.match(body, /withContent/, '要有"优先有内容"的那一轮');
});

test('★★★★★ 纯函数复现：空壳 mtime 更新时不选中它', () => {
  /*
   * 模拟修好之后的完整判定，确认两轮过滤真的能救回历史。
   */
  const rows = [
    { id: 'real', at: Date.parse('2026-11-14T08:00:00.000Z'), count: 88, hasCount: true },
    { id: 'shell', at: 1794700000000, count: 0, hasCount: true },
  ];

  const pick = (pool) => {
    let best = null;
    for (const row of pool) {
      if (best === null || row.at > best.at) best = { id: row.id, at: row.at };
    }
    return best === null ? null : best.id;
  };
  const withContent = rows.filter((row) => !(row.hasCount && row.count === 0));
  const got = pick(withContent) ?? pick(rows);

  /*
   * 注意 shell 的时间戳（1794700000000 ≈ 2026-11-17）确实比 real 晚，
   * 所以纯按时间它会赢 —— 这就是为什么必须单独排除空壳。
   */
  assert.ok(rows[1].at > rows[0].at, '前提：空壳的 mtime 确实更新（否则这条判据没意义）');
  assert.equal(got, 'real', '要选中真历史，不是空壳');
});

test('★★★★★ 全是空文件时仍要能选出一个（不许返回 null 导致空白）', () => {
  /*
   * 矫枉过正的另一面：这个角色只有空文件时，第一轮一个都不剩 ——
   * 必须回退到全部，否则 `findLatestChat` 返回 null ⇒ 界面空白。
   */
  const rows = [
    { id: 'only-shell', at: 1794700000000, count: 0, hasCount: true },
  ];
  const pick = (pool) => {
    let best = null;
    for (const row of pool) {
      if (best === null || row.at > best.at) best = { id: row.id, at: row.at };
    }
    return best === null ? null : best.id;
  };
  const withContent = rows.filter((row) => !(row.hasCount && row.count === 0));
  assert.equal(withContent.length, 0, '前提：第一轮确实空了');
  assert.equal(pick(withContent) ?? pick(rows), 'only-shell', '要回退，不许返回 null');
});

test('★★★★★ 没有条数字段时不许把所有文件排除（防 ST 版本差异）', () => {
  /*
   * 如果 ST 某个版本不返回 `chat_items`，`chatFileCount` 给 0。
   * 若判据写的是 `count > 0`，会把所有文件排除掉 ⇒ 用户看到空白。
   *
   * 正确写法是 `hasCount && count === 0` —— 只有"确实读到 0"才算空。
   */
  const rows = [
    { id: 'a', at: 1, count: 0, hasCount: false },
    { id: 'b', at: 2, count: 0, hasCount: false },
  ];
  const withContent = rows.filter((row) => !(row.hasCount && row.count === 0));
  assert.equal(withContent.length, 2, '没有条数字段时不该被当成空文件');
});

test('★★★★★ 清理空聊天：只删"确实 0 条"的，且跳过当前打开那条', () => {
  /*
   * ## 为什么这条判据的重点是"不许删太多"
   *
   * 用户要的是清掉垃圾，但**删错是不可逆的**。两种误删都能发生：
   *
   * ```text
   *   ① count === 0 但 countKnown === false
   *      ST 没给 chat_items ⇒ 里面可能有 500 条
   *   ② 删掉 current（当前打开的那条）
   *      ⇒ 聊天页的 chatFileName 指向不存在的文件
   *      ⇒ 下次保存又新建一个（正是要断掉的循环）
   * ```
   *
   * 所以判据要把"跳过条件"钉死，而不只是"有这个按钮"。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));

  assert.match(src, /'chat-files-clean-empty'/, '要有清理入口');

  /*
   * ★ 过滤条件已收进 shared 的 `isDeletableEmptyChat()`（2026-11-14 晚）。
   *
   * 原来这里内联写了 `file.countKnown && file.count === 0 && !file.current`，
   * 而且在同一个文件里出现了**两处**（画按钮时数一个、真删除时又数一个）。
   * 补体积/mes 判据时只改一处，另一处就漏 —— 而"另一处"才是真正执行删除的。
   *
   * ⇒ 判据改成钉"必须调纯函数"，具体条件由那个纯函数的单测覆盖。
   */
  assert.match(src, /isDeletableEmptyChat\(file\)/, '要用 shared 的判定（两处共用一套）');
});

test('★★★★★ 清理必须两步确认（删除不可逆）', () => {
  /*
   * 与每行的「删除」保持同一套手势：第一下变文案，第二下才真删。
   * 不用 `confirm()` —— 它在 Android WebView 里阻塞主线程
   * （流式回复期间会把打字机卡住，这是本项目已有的结论）。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  const at = src.indexOf("'chat-files-clean-empty'");
  assert.ok(at > 0, '找不到清理按钮');

  /* 从按钮定义往后找它的点击处理 */
  const clickAt = src.indexOf('cleanBtn.addEventListener', at);
  assert.ok(clickAt > 0, '清理按钮要有点击处理');
  const end = src.indexOf('\n  void paint();', clickAt);
  const body = src.slice(clickAt, end < 0 ? clickAt + 2200 : end);

  assert.match(body, /data-armed/, '要有"已就绪"的确认态');
  assert.match(body, /确认删除/, '第二次点击前要让用户看到"确认"字样');
  assert.doesNotMatch(body, /\bconfirm\(/, '不许用阻塞式 confirm()');
});

test('★★★★ 条数未知时不能显示成"0 条消息"', () => {
  /*
   * 那会让用户以为记录被清空了 —— 比不显示更吓人。
   * 用户这次的感受正是"记录没了"，界面不该再说一遍假话。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  assert.match(src, /file\.countKnown \?/, '显示要按 countKnown 分支');
  assert.match(src, /条数未知/, '未知要有明确文案');
});

/* ═══════════════════════════════════════════════════════════
   ③ 体积是"空文件"的第二道独立判据
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ chatFileSizeBytes：ST 的 file_size 要能解析', () => {
  /*
   * `file_size` 来自 npm `bytes` 包的 `format()`：
   * "0 B" / "512 B" / "1 KB" / "1.2 KB" / "3.4 MB"。
   *
   * 它是**独立于 chat_items** 的第二信号 —— 两个都指向"空"才敢删。
   */
  assert.equal(chatFileSizeBytes({ file_size: '0 B' }), 0);
  assert.equal(chatFileSizeBytes({ file_size: '512 B' }), 512);
  assert.equal(chatFileSizeBytes({ file_size: '1 KB' }), 1024);
  /* 1.2 × 1024 = 1228.8 ⇒ 四舍五入 1229。断区间而不是精确值，
     因为这里要的是量级（用于阈值比较），不是逐字节一致。 */
  const onePointTwo = chatFileSizeBytes({ file_size: '1.2 KB' });
  assert.ok(onePointTwo !== null && onePointTwo >= 1228 && onePointTwo <= 1229, '1.2 KB 要落在 1228~1229');
  assert.equal(chatFileSizeBytes({ file_size: '3.4 MB' }), Math.round(3.4 * 1024 * 1024));

  /* 没有空格、大小写混写也认（不同 ST 版本/包的输出可能不同） */
  assert.equal(chatFileSizeBytes({ file_size: '2KB' }), 2048);
  assert.equal(chatFileSizeBytes({ file_size: '2kb' }), 2048);

  /*
   * ★ 读不到必须是 null，**不能是 0**。
   * 返回 0 等于"读不到大小就当空的"，正好把要防的事做成默认行为。
   */
  assert.equal(chatFileSizeBytes({}), null);
  assert.equal(chatFileSizeBytes({ file_size: '' }), null);
  assert.equal(chatFileSizeBytes({ file_size: 'unknown' }), null);
  assert.equal(chatFileSizeBytes({ file_size: 123 }), null, '数字型也当读不到（ST 给的是字符串）');
});

test('★★★★★ "末行损坏"报 0 条但有内容 —— 不许删（真会丢数据的路径）', () => {
  /*
   * ## ST 的两个"0 条"含义完全不同
   *
   * ```js
   *   // ① 真的空
   *   { chat_items: 0, mes: '[The chat is empty]' }
   *
   *   // ② 末行解析失败 —— 文件可能有内容
   *   chatData.chat_items = Math.max(itemCounter - 2, 0);
   *   chatData.mes = '[The message is empty]';
   * ```
   *
   * header + **1 条消息** = 两行 ⇒ `max(2-2,0) = 0` ⇒ 报"0 条"。
   * 只看 `count === 0` 就会把它当空壳删掉。
   *
   * 生产日志里的对应证据：`检查点 - 2026-11-14@19h57m35s.jsonl`
   * 创建 **11 秒后**被清理删除 —— 检查点不可能没有内容。
   *
   * ⇒ 必须同时要求 `mes === '[The chat is empty]'`。
   */
  assert.equal(chatFileSaysEmpty({ mes: '[The chat is empty]' }), true, '真空标记');
  assert.equal(
    chatFileSaysEmpty({ mes: '[The message is empty]' }),
    false,
    '末行损坏 ≠ 空（这两个字符串只差一个词，极易看错）',
  );
  assert.equal(chatFileSaysEmpty({}), false, '没有 mes 就不敢说它空');
  assert.equal(chatFileSaysEmpty({ mes: '下午好' }), false, '有正文');

  /* 核心断言：count=0 但 mes 不是真空标记 ⇒ 不可删 */
  assert.equal(
    isDeletableEmptyChat({
      countKnown: true,
      count: 0,
      sizeBytes: 0,
      saysEmpty: false,
      current: false,
    }),
    false,
    'count 说是 0、但 ST 没说"这是空聊天" ⇒ 不许删',
  );

  /* 真的空：两个信号都指向空 */
  assert.equal(
    isDeletableEmptyChat({
      countKnown: true,
      count: 0,
      sizeBytes: 0,
      saysEmpty: true,
      current: false,
    }),
    true,
  );

  /* 体积兜底：声称空但文件不小 ⇒ 不删 */
  assert.equal(
    isDeletableEmptyChat({
      countKnown: true,
      count: 0,
      sizeBytes: 5000,
      saysEmpty: true,
      current: false,
    }),
    false,
    '说空却有 5KB，不信它',
  );
});

test('★★★★★ 四个条件缺一不可', () => {
  const base = { countKnown: true, count: 0, sizeBytes: 0, saysEmpty: true, current: false };

  assert.equal(isDeletableEmptyChat({ ...base, current: true }), false, '当前打开的不删');
  assert.equal(isDeletableEmptyChat({ ...base, countKnown: false }), false, '条数未知不删');
  assert.equal(isDeletableEmptyChat({ ...base, count: 3 }), false, '有内容不删');
  assert.equal(isDeletableEmptyChat({ ...base, saysEmpty: false }), false, 'ST 没说空不删');
  assert.equal(isDeletableEmptyChat({ ...base, sizeBytes: null }), false, '体积未知不删');
  assert.equal(isDeletableEmptyChat(base), true, '五条都过才删');
});

test('★★★★★ 页面必须用纯函数过滤，不许自己拼条件', () => {
  /*
   * 这条防"两处过滤各写一遍"：原来 482 与 644 行是同一串条件，
   * 补体积校验时只改一处，另一处（真正的删除循环）就漏了。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  assert.match(src, /isDeletableEmptyChat\(file\)/, '要用 shared 的判定');
  assert.doesNotMatch(
    src,
    /file\.countKnown && file\.count === 0/,
    '不许再内联拼条件（两处会分叉）',
  );
});

test('★★★★ 清理时要逐条记录删了什么（否则日志答不了"谁删的"）', () => {
  /*
   * 用户这次的 2.2 万行日志里只有 20 行 `Deleted file: …`，
   * 没有一个字提到那些文件原来有什么 ⇒ "是不是清理删的"谁都答不了。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  assert.match(src, /\[清理\] 删除/, '要记录被删的文件');
  assert.match(src, /count=\$\{String\(file\.count\)\}/, '要记条数');
  assert.match(src, /size=\$\{String\(file\.sizeBytes\)\}B/, '要记体积');
});
