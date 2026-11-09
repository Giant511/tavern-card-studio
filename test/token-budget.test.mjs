/**
 * Token 预算裁剪的判据（2026-11-03，第十九批 ④）。
 *
 * ## 这组守的是什么
 *
 * 裁剪的失败方式**全是静默的**：
 *
 * ```text
 *   不裁         → 长对话报 400，或上游静默截断（回复变糊）
 *   裁错方向     → 保留开局寒暄、丢掉刚刚发生的事（角色立刻失忆）
 *   中间挖洞     → 模型自己脑补缺失那段（开始编造没发生的事）
 *   裁掉提示词   → 用户调教好的规则被扔掉（效果突然"失效"）
 * ```
 *
 * 四种里后面三种都不会报错，只会"表现得怪"。所以每条都要单独钉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

import {
  applyTokenBudget,
  computeBudget,
  estimateTokens,
  BYTES_PER_TOKEN,
} from '../shared/dist/chat/token-budget.js';

/** 用"字符数"当 token 数的假计数器，便于把用例写成可读的数字 */
const byChars = (text) => text.length;

/* ═══════════════════════════════════════════════════════════
   一、估算（兜底路径）
   ═══════════════════════════════════════════════════════════ */

test('★ 估算按 UTF-8 **字节**算，不按字符算', () => {
  /*
   * ## 第一版这条判据写错了，连带注释也是错的
   *
   * 我原来写"中文一个字 3 字节，按字符算会低估三倍" —— **这个说法不成立**。
   * 实际算一下：
   *
   * ```text
   *   6 个中文字 = 18 字节 → 18/3.35 = 5.4 → 6 token
   *   6 个字符  = 6 token
   *   两者恰好都是 6
   * ```
   *
   * 因为 3 字节 ÷ 3.35 ≈ 0.9 token/字，对纯中文来说按字节算**反而略少**，
   * 不是"低估三倍"。
   *
   * 正确的对照要挑**中英混合**或**纯英文**，那时两者才明显不同：
   *
   * ```text
   *   'abc中文'     5 字符 / 9 字节  → 按字节 3，按字符 5
   *   'hello world' 11 字符 / 11 字节 → 按字节 4，按字符 11
   * ```
   *
   * 教训：判据里的"差值"必须**先算过**再写断言，不能凭直觉。
   */
  assert.equal(estimateTokens('abc中文'), 3, '9 字节 ÷ 3.35 向上取整 = 3');
  assert.notEqual(estimateTokens('abc中文'), 5, '按字符算会得到 5 —— 那说明没走字节');

  assert.equal(estimateTokens('hello world'), 4, '11 字节 ÷ 3.35 向上取整 = 4');
  assert.notEqual(estimateTokens('hello world'), 11, '按字符算会得到 11');

  /* 纯中文：两种算法恰好都是 6，所以它**证明不了**按字节算，只作参考 */
  assert.equal(estimateTokens('一二三四五六'), 6);
});

test('★ 估算与 ST 的 BYTES_PER_TOKEN 一致', () => {
  assert.equal(BYTES_PER_TOKEN, 3.35, '要与 ST 保持一致，两边数字才可比');
});

test('★ 空串是 0，不是 1', () => {
  assert.equal(estimateTokens(''), 0);
});

test('★ 四字节字符（emoji）按 4 字节算', () => {
  assert.equal(estimateTokens('😀'), Math.ceil(4 / BYTES_PER_TOKEN));
});

/* ═══════════════════════════════════════════════════════════
   二、预算计算
   ═══════════════════════════════════════════════════════════ */

test('★★ 预算 = 上下文上限 − 回复额度（与 ST 的 setTokenBudget 一致）', () => {
  assert.equal(computeBudget(8192, 512), 8192 - 512);
});

test('★★ 上下文没填时预算是 0（不裁，也不乱裁）', () => {
  assert.equal(computeBudget(0, 512), 0);
  assert.equal(computeBudget(undefined, 512), 0);
  assert.equal(computeBudget('8192', 512), 0, '字符串不算数（ST 存的是数字）');
});

test('★ 回复额度 ≥ 上下文（配置错误）时兜底留四分之一给输入', () => {
  /*
   * 用户可能把 max_tokens 填得比 context 还大。硬减会得到负数预算 ⇒
   * 把上下文裁空 ⇒ 模型完全不知道在演谁。
   */
  assert.equal(computeBudget(1000, 1000), 250);
  assert.equal(computeBudget(1000, 5000), 250);
});

/* ═══════════════════════════════════════════════════════════
   三、裁剪：方向与"不许挖洞"
   ═══════════════════════════════════════════════════════════ */

test('★★★ 裁的是**最早**的历史，保留最近的', () => {
  /*
   * 对话的尾部才是当前语境。从前往后保留会留下"开局寒暄"、
   * 丢掉"刚刚发生的事" —— 角色立刻失忆。
   */
  const messages = [
    { role: 'system', content: 'SYS' },   // 4 token，必留
    { role: 'user', content: 'A'.repeat(10) },      // 10
    { role: 'assistant', content: 'B'.repeat(10) }, // 10
    { role: 'user', content: 'C'.repeat(10) },      // 10
  ];
  const trimmable = [false, true, true, true];

  /* 必留 3 + 历史可用 23 ⇒ 只能放两条（20），最早那条丢 */
  const result = applyTokenBudget({ messages, trimmable, budget: 3 + 23, countTokens: byChars });

  assert.deepEqual(result.messages.map((m) => m.content[0]), ['S', 'B', 'C']);
  assert.equal(result.droppedCount, 1);
});

test('★★★ 放不下的那条**本身**要被丢掉（不是被保留）', () => {
  /*
   * 这条是上一版实现的真 bug：
   *
   * ```js
   * if (cost > remaining) { cutoff = i; break; }
   * ...
   * if (isTrimmable && i < cutoff) 丢掉;   // ← 不含 i 自己
   * ```
   *
   * 于是"唯一放不下的那一条"反而留下了 —— 它明明是最该丢的。
   * 光看代码很容易觉得对（"cutoff 就是分割线嘛"），
   * 必须用"单条超长"的用例才照得出。
   */
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'X'.repeat(100) }, // 超长，放不下
    { role: 'assistant', content: 'ok' },
  ];
  const trimmable = [false, true, true];

  /* 必留 3，历史可用 10 ⇒ 第 2 条(100) 放不下，第 3 条(2) 放得下 */
  const result = applyTokenBudget({ messages, trimmable, budget: 13, countTokens: byChars });

  /*
   * ★ 停住语义：第 2 条放不下 ⇒ 第 2 条及其之前的历史全丢。
   * 第 3 条（更晚的）保留。结果里不该有那个 100 字的长消息。
   */
  assert.equal(
    result.messages.some((m) => m.content.length === 100),
    false,
    '放不下的超长消息必须被丢掉',
  );
  assert.equal(result.droppedCount, 1);
  assert.ok(result.usedTokens <= result.budget, `实际 ${String(result.usedTokens)} 应 ≤ 预算 ${String(result.budget)}`);
});

test('★★★ 不许在中间挖洞：放不下就停，不跳过它去留更早的', () => {
  /*
   * 若"跳过"而不是"停住"，模型会看到「A 说话 → 角色回话」中间缺一段，
   * 然后**自己脑补**缺的内容 —— 表现为"它开始编造之前没发生的事"。
   *
   * 少几轮历史只是记性差；中间的洞会让它说错话。
   */
  const messages = [
    { role: 'system', content: 'SYS' },              // 3 必留
    { role: 'user', content: 'P'.repeat(5) },        // 5 早期，本来放得下
    { role: 'assistant', content: 'Q'.repeat(50) },  // 50 放不下
    { role: 'user', content: 'R'.repeat(5) },        // 5 靠后
  ];
  const trimmable = [false, true, true, true];

  /* 必留 3 + 可用 15 ⇒ 从后往前：R(5) 可以，Q(50) 不行 ⇒ 停 */
  const result = applyTokenBudget({ messages, trimmable, budget: 18, countTokens: byChars });

  const contents = result.messages.map((m) => m.content);
  assert.ok(contents.includes('R'.repeat(5)), '最近的要留');
  assert.equal(contents.includes('Q'.repeat(50)), false, '放不下的要丢');
  /*
   * ★ 关键：P 明明放得下，但它在 Q 之前 ⇒ 必须一起丢（不许挖洞）。
   */
  assert.equal(contents.includes('P'.repeat(5)), false, '更早的历史也要丢（否则中间出现缺口）');
  assert.equal(result.droppedCount, 2);
});

test('★★ 必留项永远不裁（裁掉等于扔掉用户的提示词）', () => {
  /*
   * 提示词是用户调教出来的成果。裁掉它们比少几轮历史严重得多。
   * 即使必留项很长、预算很小，也只能裁历史。
   */
  const messages = [
    { role: 'system', content: 'L'.repeat(80) }, // 长提示词，必留
    { role: 'user', content: 'H'.repeat(10) },   // 历史
  ];
  const trimmable = [false, true];

  const result = applyTokenBudget({ messages, trimmable, budget: 85, countTokens: byChars });

  assert.equal(result.messages.length, 1, '历史被裁掉');
  assert.equal(result.messages[0].content, 'L'.repeat(80), '提示词完整保留');
});

/* ═══════════════════════════════════════════════════════════
   四、边界
   ═══════════════════════════════════════════════════════════ */

test('★★★ 必留项自己就超预算时：不裁、但标 overBudget', () => {
  /*
   * 这时裁什么都是错的（裁也放不下，只是把用户配置扔了）。
   * 必须让上层能提醒用户："你的提示词加起来就超过上下文了，去关掉几条。"
   */
  const messages = [
    { role: 'system', content: 'L'.repeat(100) },
    { role: 'user', content: 'H'.repeat(10) },
  ];
  const trimmable = [false, true];

  const result = applyTokenBudget({ messages, trimmable, budget: 50, countTokens: byChars });

  assert.equal(result.overBudget, true);
  assert.equal(result.droppedCount, 0, '不裁');
  assert.equal(result.messages.length, 2, '全都留着');
  assert.equal(result.requiredTokens, 100);
});

test('★ 预算为 0 / 负数 / NaN 时不裁（比裁空好）', () => {
  /*
   * `openai_max_context` 没填时是 0。裁成空上下文比超一点更糟 ——
   * 模型完全不知道在演谁。
   */
  const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'HI' }];
  const trimmable = [false, true];

  for (const budget of [0, -5, Number.NaN]) {
    const result = applyTokenBudget({ messages, trimmable, budget, countTokens: byChars });
    assert.equal(result.messages.length, 2, `budget=${String(budget)} 时不该裁`);
    assert.equal(result.overBudget, false);
  }
});

test('★★ trimmable 长度与 messages 不一致时不动（不猜对应关系）', () => {
  /*
   * 长度不一致说明调用方搞错了。猜的结果是"按错位标记裁" ——
   * 可能把提示词当历史删掉，比不裁危险得多。
   */
  const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'HI' }];
  const result = applyTokenBudget({ messages, trimmable: [false], budget: 1, countTokens: byChars });
  assert.equal(result.messages.length, 2, '不裁');
  assert.equal(result.droppedCount, 0);
});

test('★ 全都放得下时一条都不裁，usedTokens 准确', () => {
  const messages = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'hello' },
  ];
  const result = applyTokenBudget({ messages, trimmable: [false, true], budget: 1000, countTokens: byChars });

  assert.equal(result.droppedCount, 0);
  assert.equal(result.usedTokens, 8);
  assert.equal(result.overBudget, false);
});

test('★★ 输出顺序保持原样（裁剪只删不改序）', () => {
  const messages = [
    { role: 'system', content: 'S1' },
    { role: 'user', content: 'H1' },
    { role: 'system', content: 'S2' },
    { role: 'assistant', content: 'H2' },
  ];
  const trimmable = [false, true, false, true];

  const result = applyTokenBudget({ messages, trimmable, budget: 1000, countTokens: byChars });
  assert.deepEqual(result.messages.map((m) => m.content), ['S1', 'H1', 'S2', 'H2']);
  assert.deepEqual(result.trimmable, trimmable);
});

/* ═══════════════════════════════════════════════════════════
   五、界面：预算提示与 CSS 变量（§73 那个静默失效的坑）
   ═══════════════════════════════════════════════════════════ */

test('★★ 预算提示用到的 CSS 变量必须真实存在', () => {
  /*
   * 背景：我第一版给预算提示写了 `var(--nb-fs-15)` ——
   * 而这个 token 集里只有 11/12/14/16，**没有 15**。
   *
   * CSS 里写不存在的变量**不会报错**，只会静默退回继承值：
   * 字号看起来"差不多"，所以肉眼很难发现，而设计稿上差一级就是差一级。
   * §73 已经踩过一次（`--nb-text-4` 不存在）。
   *
   * 判据：把 `.nb-budget-hint*` 规则里用到的 `--nb-*` 逐个拿到 tokens 文件里核对。
   */
  const css = readFileSync(join(REPO, 'client', 'src', 'chat', 'chat.css'), 'utf8');
  const tokens = readFileSync(join(REPO, 'client', 'src', 'chat', 'nebula-tokens.css'), 'utf8');

  /* 收集 tokens 里定义过的变量名 */
  const defined = new Set();
  for (const match of tokens.matchAll(/(--nb-[a-z0-9-]+)\s*:/g)) defined.add(match[1]);

  /* 只看预算提示那几条规则 */
  const blocks = [...css.matchAll(/\.nb-budget-hint[^{]*\{([\s\S]*?)\}/g)];
  assert.ok(blocks.length > 0, '找不到预算提示的样式规则');

  const missing = [];
  for (const block of blocks) {
    for (const use of block[1].matchAll(/var\((--nb-[a-z0-9-]+)/g)) {
      if (!defined.has(use[1])) missing.push(use[1]);
    }
  }
  assert.deepEqual(missing, [], '这些 CSS 变量不存在（会静默失效）：' + missing.join('、'));
});

test('★ 预算提示有 data-role，界面判据能定位到它', () => {
  /*
   * 没有稳定的 `data-role`，真机判据就只能靠 class 或文案定位；
   * 而文案会改、class 会被样式重构带走。`data-role` 是这个项目的约定。
   */
  const src = readFileSync(join(REPO, 'client', 'src', 'chat', 'chat-settings.ts'), 'utf8');
  assert.match(src, /data-role', 'budget-hint'/, '预算提示要有 data-role');
  assert.match(src, /callbacks\.budget !== undefined/, '不传回调时整块不渲染（不显示假信息）');
});
