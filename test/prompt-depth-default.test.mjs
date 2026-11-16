/**
 * 「按深度插入」的默认值与实际落点（2026-11-16 用户报的真缺陷）。
 *
 * ## 用户原话
 *
 * > 发现角色特有的提示词没有生效
 *
 * ## 日志实证（app-001 / engine-8000）
 *
 * 三条提示词**确实写进了卡、也确实发进了请求**：
 *
 * ```text
 *   [提示词] 写回 avatar=威廉.png own=3 override=0 字节=709458
 *   [分享]  取卡 avatar=威廉.png 有提示词=yes own=3
 *   请求体：22 条消息，最后一条 role=system，装着这四条「按深度插入」的提示词
 * ```
 *
 * 问题在于**位置**：`深度 = 0` 把它们排到了最后一条用户消息**之后**。
 * 那是整段上下文里最弱的位置 —— 模型把最后那条用户消息当本轮任务，
 * 末尾追加的 system 压不住前面十几轮的既有文风。
 *
 * ## 为什么会设成 0
 *
 * 我们的 `NEW_PROMPT_DRAFT.injectionDepth` 是 **0**，而 ST 的默认是 **4**
 * （`public/index.html`：`<input name="injection_depth" ... value="4" />`）。
 * 用户在编辑页把「位置」切到"按深度插入"时，深度框里显示 0，
 * 绝大多数人不会去改它 —— 于是每一条都落进了最弱的位置。
 *
 * 这个文件钉三件事：
 *
 * ```text
 * ① 默认深度必须是 4（与 ST 一致），不许退回 0
 * ② 深度语义本身是对的（0=末尾、4=倒数第 5 条之前）—— 不许"顺手改语义"
 * ③ 装配结果要可观测（report.depthInjected），否则下次又只能靠推演
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { NEW_PROMPT_DRAFT } from '../shared/dist/chat/prompt-edit.js';
import { assembleWithPrompts } from '../shared/dist/chat/prompt-assemble.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   一、默认值（这次的真缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 新建提示词的默认深度必须是 4（与 ST 一致）', () => {
  /*
   * ST 的 `public/index.html` 里那个输入框是
   * `<input name="injection_depth" ... value="4" />`。
   *
   * 我们原来是 0。0 不是"最靠后所以最强"，而是"排在最后一条之后"——
   * 模型最不买账的位置。用户那三条就是这么废掉的。
   */
  assert.equal(
    NEW_PROMPT_DRAFT.injectionDepth,
    4,
    '默认深度必须是 4（ST 的默认值）。写 0 会让新建的「按深度插入」提示词落在末尾被模型忽略。',
  );
  assert.equal(NEW_PROMPT_DRAFT.injectionPosition, 0, '默认位置仍是「跟随顺序」（最强，进 system 块）');
  assert.equal(NEW_PROMPT_DRAFT.injectionOrder, 100, '排序默认 100（ST 同值）');
});

test('★★★★ 编辑页的深度说明要点出 0 的后果，不能只说定义', () => {
  /*
   * 原来只说「0 = 在最后一条消息之后」。用户会以为"0 最靠后 = 最强"。
   * 事实相反 —— 说明里必须带一句"模型常常忽略"。
   */
  const page = stripComments(read('client/src/chat/chat-prompt-edit-page.ts'));
  assert.match(page, /0 = 在最后一条消息之后/, '要保留位置定义（与 ST 文案一致）');
  assert.match(page, /模型常常忽略/, '要说出 0 的实际后果');
  assert.match(page, /一般用 4/, '要给出该填什么');
});

/* ═══════════════════════════════════════════════════════════
   二、深度语义（不许"顺手改"）
   ═══════════════════════════════════════════════════════════ */

const HISTORY = [
  { is_user: true, mes: 'U1' },
  { is_user: false, mes: 'A1' },
  { is_user: true, mes: 'U2' },
  { is_user: false, mes: 'A2' },
  { is_user: true, mes: 'U3' },
];

function assemble(depth) {
  const prompts = [
    {
      identifier: 'main',
      name: 'Main',
      content: 'SYS',
      role: 'system',
      systemPrompt: true,
      marker: false,
      injectionPosition: 0,
      injectionDepth: 4,
      injectionOrder: 100,
    },
    {
      identifier: 'chatHistory',
      name: '历史',
      content: '',
      role: 'system',
      systemPrompt: false,
      marker: true,
      injectionPosition: 0,
      injectionDepth: 4,
      injectionOrder: 100,
    },
    {
      identifier: 'tcs-1',
      name: '深度项',
      content: 'INJ',
      role: 'system',
      systemPrompt: false,
      marker: false,
      injectionPosition: 1,
      injectionDepth: depth,
      injectionOrder: 100,
    },
  ];
  return assembleWithPrompts({
    config: {
      prompts,
      order: prompts.map((one) => ({ identifier: one.identifier, enabled: true })),
      orderSource: 'preset',
      warnings: [],
    },
    card: {
      name: '威廉',
      description: '',
      personality: '',
      scenario: '',
      mes_example: '',
      first_mes: '',
      post_history_instructions: '',
    },
    history: HISTORY,
    charName: '威廉',
    userName: '格兹',
  });
}

test('★★★★★ 深度 0 = 排在最后一条之后（所以它是最弱的位置）', () => {
  const out = assemble(0);
  assert.equal(out.messages[out.messages.length - 1].content, 'INJ', '深度 0 应当落在最后');
  assert.equal(out.report.depthInjected, 1, '要报"注入了 1 条"');
});

test('★★★★★ 深度 4 = 插在倒数第 5 条位置（不是末尾）', () => {
  /*
   * 这条与上一条成对：证明语义没被"顺手改掉"。
   *
   * 序列 `SYS | U1 | A1 | U2 | A2 | U3` 里，"倒数第 4 条之前"就是
   * A1 之前 ⇒ `SYS | U1 | INJ | A1 | U2 | A2 | U3`。
   *
   * ★ 第一版我把期望写成 `SYS | INJ | U1 | …`（以为 4 该靠前两格），
   *   那是**我自己算错**，代码一直是对的。判据的期望值要按"从末尾倒数"
   *   实际数一遍，不能凭直觉。
   */
  const out = assemble(4);
  const seq = out.messages.map((one) => one.content);
  assert.deepEqual(
    seq,
    ['SYS', 'U1', 'INJ', 'A1', 'U2', 'A2', 'U3'],
    '深度 4 要落在倒数第 4 条（A1）之前',
  );
});

test('★★★★ 深度 1 = 紧接最后一条之前（比 0 强一个身位）', () => {
  const out = assemble(1);
  const seq = out.messages.map((one) => one.content);
  assert.deepEqual(seq, ['SYS', 'U1', 'A1', 'U2', 'A2', 'INJ', 'U3'], '深度 1 要在最后一条之前');
});

/* ═══════════════════════════════════════════════════════════
   三、可观测（下次不用再靠推演）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 装配要报出深度项与深度，供日志定位', () => {
  /*
   * 面板里那行日志形如：
   *   [装配] 消息=22 用=14 关=1 空=0 深度注入=4 深度项=[main@0,msg-rule@0]
   *
   * 有它才能一眼分开三种情况：没走到装配 / 被跳过 / 发出去了但模型没听。
   */
  const panel = stripComments(read('client/src/chat/chat-panel.ts'));
  assert.match(panel, /onDiag\?\.\(/, '面板要有诊断出口');
  assert.match(panel, /\[装配\] 消息=/, '要报消息条数');
  assert.match(panel, /深度注入=/, '要报深度注入条数');
  assert.match(panel, /深度项=\[/, '要列出每个深度项的 identifier@depth');
  assert.match(panel, /injectionPosition === 1/, '深度项按"按深度插入"筛');
});

test('★★★★ 外壳把面板诊断接到 App 日志', () => {
  /*
   * 面板自己不写文件（它也可能跑在桌面端），必须由外壳接到 `diagNote`。
   * 漏了这一行的后果：日志里那条 `[装配]` 永远不会出现 ——
   * 而那正好是排查时最需要的证据。
   */
  const shell = stripComments(read('client/src/chat/shell.ts'));
  assert.match(shell, /onDiag: \(message\) => diagNote\('note', message\)/, '要把面板诊断接到 diagNote');
});
