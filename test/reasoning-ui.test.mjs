/**
 * 「思考」设置区块 · 三分支渲染（2026-11-07，P0 第三步）。
 *
 * ## 用户定的三条红线
 *
 * ```text
 *   ① 前端不许猜厂商，只能吃 ReasoningPlan
 *   ② degraded 不许显示"已关闭思考"，必须是"已降级为限制思考长度"
 *   ③ 不破坏响应式、复用现有组件
 * ```
 *
 * 这份判据主要守 ① 和 ② —— 那两条是"错了也看不出来"的类型：
 * 界面照样能点、照样能存，只是说的话是假的。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { makeReasoningSection, isReasoningEffortField } from '../client/src/chat/reasoning-section.ts';
import { previewReasoningPlan } from '../shared/dist/chat/generate.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/* ── 最小 DOM stub（与 api-page-dom.test.mjs 同一套思路）── */
function makeDoc() {
  const createElement = (tag) => {
    const attributes = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      innerHTML: '',
      hidden: false,
      value: '',
      dataset: {},
      children: [],
      listeners: {},
      append(...nodes) {
        for (const one of nodes) {
          this.children.push(
            typeof one === 'string' ? { textContent: one, children: [], isText: true } : one,
          );
        }
      },
      replaceChildren(...nodes) {
        this.children = [];
        this.append(...nodes);
      },
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.has(name) ? attributes.get(name) : null;
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      addEventListener(type, handler) {
        (this.listeners[type] ??= []).push(handler);
      },
      fire(type) {
        for (const handler of this.listeners[type] ?? []) handler({ type, target: this });
      },
    };
  };
  return {
    createElement,
    createTextNode: (text) => ({ textContent: text, children: [], isText: true }),
  };
}

function findAll(root, predicate) {
  const found = [];
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (node.isText !== true && predicate(node)) found.push(node);
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

const byRole = (root, role) => findAll(root, (n) => n.getAttribute('data-role') === role);

/** 把整棵树的文本拼起来（找提示语用） */
function allText(root) {
  return findAll(root, () => true)
    .map((n) => n.textContent ?? '')
    .join(' | ');
}

/* ═══════════════════════════════════════════════════════════
   ① 前端不许猜厂商（最重要的一条）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ UI 组件里不许出现任何厂商字面量或源判断', () => {
  /*
   * 用户明令：
   *
   * > 不要在前端去猜模型名字或厂商，**必须且只能**依赖 ReasoningPlan
   *
   * 这条判据是"禁止项"的可执行版本。它扫的是**代码**（剥掉注释），
   * 所以注释里解释"为什么不猜"不会让它红。
   */
  const code = stripComments(read('client/src/chat/reasoning-section.ts'));

  const forbidden = [
    ['源判断', /\.source\s*===\s*['"]/],
    ['源判断', /['"]custom['"]\s*===/],
    ['模型名判断', /\.model\.(startsWith|includes|endsWith|match)\s*\(/],
    ['厂商名', /['"](deepseek|qwen|glm|kimi|openrouter|claude)['"]/i],
    ['地址判断', /baseUrl/],
    ['能力表', /matchProfile|PROFILES|isForcedThinking/],
  ];

  const hits = [];
  for (const [label, re] of forbidden) {
    const m = re.exec(code);
    if (m !== null) {
      const line = code.slice(0, m.index).split('\n').length;
      hits.push(`${label}（第 ${String(line)} 行）：${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `UI 层不许自己判断厂商/源：\n${hits.join('\n')}`);
});

test('★★★★★ 三个分支的结论只能来自 preview（不是组件算的）', () => {
  /*
   * 从正面钉：组件里出现的分支条件必须是 `plan.xxx` / `preview.xxx`。
   */
  const code = stripComments(read('client/src/chat/reasoning-section.ts'));
  assert.match(code, /if \(plan\.unsupported\)/, '分支 C 判 `plan.unsupported`');
  assert.match(code, /if \(plan\.degraded\)/, '分支 B 判 `plan.degraded`');
  assert.match(code, /preview\.effortHandled/, '高级项归属判 `preview.effortHandled`');
});

/* ═══════════════════════════════════════════════════════════
   ② 三分支渲染
   ═══════════════════════════════════════════════════════════ */

/** 用真的 previewReasoningPlan 造一个 section（与生产路径一致） */
function buildSection(over) {
  const opts = {
    source: 'custom',
    model: 'deepseek-v4-pro',
    customUrl: 'https://api.deepseek.com/v1',
    intent: 'auto',
    budget: undefined,
    ...over,
  };
  const doc = makeDoc();
  const changes = [];
  let current = { intent: opts.intent, budget: opts.budget };
  const handle = makeReasoningSection(doc, {
    initialIntent: opts.intent,
    initialBudget: opts.budget,
    initialEffort: 'auto',
    ...(opts.initialFamily === undefined ? {} : { initialFamily: opts.initialFamily }),
    computePreview: (intent, budget, family) =>
      previewReasoningPlan({
        source: opts.source,
        model: opts.model,
        customUrl: opts.customUrl,
        intent,
        budget,
        ...(family === undefined ? {} : { manualFamily: family }),
      }),
    onChange: (state) => {
      current = state;
      changes.push(state);
    },
  });
  return { handle, root: handle.el, changes, current: () => current };
}

test('★★★★★ 分支 A（正常）：三态可用，且按 intent 高亮', () => {
  const { root } = buildSection({ intent: 'off' });
  assert.equal(root.getAttribute('data-branch'), 'normal');

  const btns = byRole(root, 'thinking-intent-option');
  assert.equal(btns.length, 3, '三态应有 3 个按钮');
  for (const btn of btns) {
    assert.equal(btn.getAttribute('disabled'), null, '正常态下三态不许置灰');
  }
  const active = btns.filter((b) => b.getAttribute('data-active') === 'true');
  assert.equal(active.length, 1, '同时只能有一个选中');
  assert.equal(active[0].getAttribute('data-value'), 'off', '选中的应是 off');
});

test('★★★★★ 分支 A：auto 时把 note 显示出来（原生源的"自动=关"）', () => {
  const { root } = buildSection({
    source: 'deepseek',
    customUrl: undefined,
    model: 'deepseek-v4-pro',
    intent: 'auto',
  });
  const hint = byRole(root, 'reasoning-hint')[0];
  assert.match(String(hint.textContent), /自动/, 'auto 要解释它的含义');
  assert.equal(root.getAttribute('data-branch'), 'normal');
});

test('★★★★★ 分支 B（强制降级）：三态置灰 + 强制高亮「开启」+ 说"已降级"', () => {
  /*
   * 这是用户划的第二条红线：
   *
   * > 不要给 degraded 状态的用户显示"已为您关闭思考"，
   * > 必须如实显示"已降级为限制思考长度"
   */
  const { root } = buildSection({
    model: 'qwen3-max-thinking',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  assert.equal(root.getAttribute('data-branch'), 'degraded');

  const btns = byRole(root, 'thinking-intent-option');
  for (const btn of btns) {
    assert.equal(btn.getAttribute('disabled'), 'true', '降级时三态必须点不动');
  }
  /*
   * 「开启」必须高亮 —— 因为模型真的在思考。
   * 若高亮「关闭」，用户会以为关掉了、以为省了 token。
   */
  const active = btns.filter((b) => b.getAttribute('data-active') === 'true');
  assert.equal(active.length, 1);
  assert.equal(active[0].getAttribute('data-value'), 'on', '降级时必须高亮「开启」');

  const hint = byRole(root, 'reasoning-hint')[0];
  const text = String(hint.textContent);
  assert.match(text, /降级|限制/, '必须说明降级');
  assert.ok(!/已.*关闭/.test(text), `不许说"已关闭"：${text}`);
});

test('★★★★★ 分支 B：思考长度控件**保持可用**（降级靠它实现）', () => {
  const { root } = buildSection({
    model: 'qwen3-max-thinking',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  const budgetRow = byRole(root, 'reasoning-budget-row')[0];
  assert.equal(budgetRow.hidden, false, '降级时长度控件必须显示');

  const slider = byRole(root, 'reasoning-budget-range')[0];
  assert.ok(slider !== undefined, 'Qwen 应有数值滑杆');
  assert.equal(slider.getAttribute('disabled'), null, '降级时滑杆必须可用');
});

test('★★★★★ 分支 C（不支持）：整个区块置灰 + 明说"不会生效"', () => {
  const { root } = buildSection({
    model: 'gpt-4o',
    customUrl: 'https://unknown.example.com/v1',
    intent: 'off',
  });
  assert.equal(root.getAttribute('data-branch'), 'unsupported');

  const btns = byRole(root, 'thinking-intent-option');
  for (const btn of btns) {
    assert.equal(btn.getAttribute('disabled'), 'true', '不支持时三态必须置灰');
  }

  const hint = byRole(root, 'reasoning-hint')[0];
  assert.match(String(hint.textContent), /不会生效/, '必须说清设置不会生效');

  /* 高级项也要不可用 */
  const effortHint = byRole(root, 'reasoning-effort-hint')[0];
  assert.equal(String(effortHint.getAttribute('data-kind')), 'warn');
});

/* ═══════════════════════════════════════════════════════════
   ③ 事件绑定
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 点三态：更新状态 + 通知外壳 + 立刻重绘分支', () => {
  const { root, changes, current } = buildSection({ intent: 'auto' });
  const btns = byRole(root, 'thinking-intent-option');
  const off = btns.find((b) => b.getAttribute('data-value') === 'off');

  off.fire('click');
  assert.equal(changes.length, 1, '应通知一次');
  assert.equal(current().intent, 'off', '状态应更新为 off');

  /* 重绘后高亮跟着走 */
  const after = byRole(root, 'thinking-intent-option').filter(
    (b) => b.getAttribute('data-active') === 'true',
  );
  assert.equal(after[0].getAttribute('data-value'), 'off');
});

test('★★★★ 置灰时点三态不产生变更（防"点了没反应还存了个值"）', () => {
  const { root, changes } = buildSection({
    model: 'qwen3-max-thinking',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  const btns = byRole(root, 'thinking-intent-option');
  for (const btn of btns) btn.fire('click');
  assert.deepEqual(changes, [], '置灰状态下点击不该产生任何变更');
});

test('★★★★ 拖滑杆：松手才落值并通知（拖动过程中不重建控件）', () => {
  const { root, changes, current } = buildSection({
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'on',
    budget: 4096,
  });
  const slider = byRole(root, 'reasoning-budget-range')[0];
  assert.ok(slider !== undefined);

  /* 拖动中（input）只改回显，不通知 */
  slider.value = '2048';
  slider.fire('input');
  assert.deepEqual(changes, [], 'input 阶段不该通知（否则控件被重建，拖动会断）');

  /* 松手（change）才落值 */
  slider.fire('change');
  assert.equal(changes.length, 1);
  assert.equal(current().budget, 2048);
});

test('★★★ 数值型用滑杆、枚举型用下拉（两种控件形态）', () => {
  const qwen = buildSection({
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'on',
  });
  assert.ok(byRole(qwen.root, 'reasoning-budget-range')[0] !== undefined, 'Qwen 应用滑杆');

  const glm = buildSection({
    model: 'glm-4.6',
    customUrl: 'https://open.bigmodel.cn/api/paas/v4',
    intent: 'on',
  });
  assert.ok(byRole(glm.root, 'reasoning-budget-select')[0] !== undefined, 'GLM 应用下拉');
});

test('★★★ 没有 budget 的厂商整行隐藏（Kimi）', () => {
  /*
   * ★ 2026-11-07 改：DeepSeek 原本在这条里，但它有 `reasoning_effort`
   *   （实测 low 34s / max 83s），已补上 budget。Kimi 才是真的没有旋钮
   *   （`thinking.keep` 是"保留多少历史思考"，不是长度上限）。
   */
  const { root } = buildSection({ model: 'kimi-k2.6', customUrl: 'https://api.moonshot.cn/v1', intent: 'on' });
  const row = byRole(root, 'reasoning-budget-row')[0];
  assert.equal(row.hidden, true, 'Kimi 没有长度旋钮，整行应隐藏');
});

test('★★★★★ DeepSeek 现在有长度旋钮，且默认不是最慢档', () => {
  const { root } = buildSection({
    model: 'deepseek-v4-pro',
    customUrl: 'https://api.deepseek.com/v1',
    intent: 'on',
  });
  const row = byRole(root, 'reasoning-budget-row')[0];
  assert.equal(row.hidden, false, 'DeepSeek 应该显示长度旋钮');

  const select = byRole(root, 'reasoning-budget-select')[0];
  assert.ok(select !== undefined, 'DeepSeek 的长度旋钮是枚举下拉（reasoning_effort）');
  /*
   * ★ 读 `data-value` 而不是 `textContent`。
   *
   * `makeSelectTrigger` 把显示文字写在**子元素** `valueText` 上，
   * 父节点的 `textContent` 在真实 DOM 里不会自动聚合子节点文字，
   * 在 stub 里更不会 —— 拿 textContent 断言只会拿到空串，
   * 然后得出"默认值不对"的假结论（第一版就是这么错的）。
   */
  assert.equal(select.getAttribute('data-value'), 'low', '默认应是最轻档 low，不能是 max');
});

/* ═══════════════════════════════════════════════════════════
   ④ 高级项：只在该生效时可用
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 高级项在注入通道下置灰（effort 会被 ST 白名单丢掉）', () => {
  const { root } = buildSection({
    source: 'custom',
    model: 'deepseek-v4-pro',
    customUrl: 'https://api.deepseek.com/v1',
    intent: 'on',
  });
  /*
   * ★ 2026-11-07：DeepSeek 的「思考长度」用的就是 reasoning_effort，
   *   所以高级项现在归 'budget' ⇒ **整块隐藏**，而不是置灰。
   *   这条改成验 Qwen（它的 budget 是 thinking_budget，不占 effort）——
   *   那才是"注入通道下 effort 发不出去"的真实场景。
   */
  const qwen = buildSection({
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'on',
  });
  const hint = byRole(qwen.root, 'reasoning-effort-hint')[0];
  assert.equal(String(hint.getAttribute('data-kind')), 'warn', '不可用时要标 warn');
  assert.match(String(hint.textContent), /发不出去|不可用|不生效/);
});

test('★★★★★ 高级项：被「思考长度」接管时整块隐藏（修双入口）', () => {
  /*
   * ★ 2026-11-07 修的真实困惑：
   *
   *   DeepSeek / GLM 的「思考长度」旋钮**就是** `reasoning_effort`。
   *   原来高级设置里还单独放一个「推理强度」下拉 —— 两个控件指同一个字段，
   *   而且其中一个是灰的（走原生字段那条路在注入通道下不生效）。
   *   用户看到"注入体里明明有 reasoning_effort，这里却说不可用"。
   *
   * 现在：`effortHandled === 'budget'` ⇒ 整个「高级设置」**隐藏**。
   *
   * ★ 为什么隐藏而不是置灰：置灰暗示"这里本来能调、只是现在不行"
   *   而实际是上面那个旋钮就能调。
   */
  for (const [source, model, url] of [
    ['deepseek', 'deepseek-v4-pro', undefined],
    ['custom', 'glm-4.6', 'https://open.bigmodel.cn/api/paas/v4'],
  ]) {
    const { root } = buildSection({ source, model, customUrl: url, intent: 'on' });
    const adv = byRole(root, 'reasoning-advanced')[0];
    assert.ok(adv !== undefined, '应有高级设置块');
    assert.equal(adv.hidden, true, `${model} 的「推理强度」已被思考长度接管 ⇒ 高级项应隐藏`);
  }
});

test('★★★★ 高级项在「不被接管」时保持可用并说明范围', () => {
  /*
   * Qwen 的 budget 是 `thinking_budget`，不占 `reasoning_effort`；
   * 原生通道下 effort 又有 ST 原生支持 ⇒ 高级项应可用。
   *
   * 用 openai 源最容易说明：它不在 NATIVE_REASONING_SOURCES 里，
   * 所以走兜底通道 ⇒ 'none'。所以这里用 claude 源
   * （原生通道，且 Claude 的 profile 没有 budget）。
   */
  const { root } = buildSection({
    source: 'claude',
    customUrl: undefined,
    model: 'claude-sonnet-4-20250514',
    intent: 'on',
  });
  const adv = byRole(root, 'reasoning-advanced')[0];
  /*
   * Claude 不在 PROFILES 里 ⇒ 认不出 ⇒ 兜底通道 ⇒ 高级项置灰。
   * 这条断言就是"认不出"的真实表现：高级项**不该**假装可用。
   */
  assert.equal(adv.hidden, false, '未被接管时高级项应显示（置灰或可用）');
  const hint = byRole(root, 'reasoning-effort-hint')[0];
  assert.ok(String(hint.textContent).length > 0, '不管可用与否都要有一句说明');
});

test('★★★ 折叠区：默认收起，点一下展开', () => {
  const { root } = buildSection({});
  const head = byRole(root, 'reasoning-advanced-head')[0];
  const panel = byRole(root, 'reasoning-advanced-panel')[0];
  assert.equal(panel.hidden, true, '默认收起');
  head.fire('click');
  assert.equal(panel.hidden, false, '点一下应展开');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 设置页接线（防止"组件写了但没挂上"）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 设置页必须真的把「思考」区块插进去（不许只 import 不用）', () => {
  const src = stripComments(read('client/src/chat/chat-settings.ts'));
  assert.match(src, /makeReasoningSection\(doc, \{/, '要真的构造组件');
  assert.match(src, /formHost\.append\(reasoningHandle\.el\)/, '要真的挂到表单里');
  assert.match(src, /if \(isReasoningEffortField\(field\.path\)\)/, '原「推理强度」字段要被接管');
});

test('★★★★ 保存时要把「推理强度」一起提交（它在组件里，不在 inputs 里）', () => {
  const src = stripComments(read('client/src/chat/chat-settings.ts'));
  assert.match(src, /reasoningHandle\.read\(\)/, '保存时要从组件读 effort');
  assert.match(src, /changed\.push\(\{ field: effField, value: effort \}\)/, '要把 effort 并进待保存列表');
});

test('★★★★ 外壳必须把 thinking 回调接上（否则整块不渲染）', () => {
  const src = stripComments(read('client/src/chat/shell.ts'));
  assert.match(src, /thinking: \{\s*initialIntent:/, 'callbacks.thinking 要赋值');
  assert.match(src, /computePreview: \(intent, budget, family\) =>/, '要注入预览计算器（三参：含手选族）');
  assert.match(src, /previewReasoningPlan\(\{/, '内部必须调 shared 的实现，不许自己算');
});

test('★★★★ 面板必须收到思考意图（否则设置白改）', () => {
  const shell = stripComments(read('client/src/chat/shell.ts'));
  assert.match(shell, /this\.chatPanel\?\.setThinking\(state\.intent, state\.budget, state\.family\)/);

  const panel = stripComments(read('client/src/chat/chat-panel.ts'));
  assert.match(panel, /setThinking\(intent: 'auto' \| 'off' \| 'on', budget\?: number \| string, family\?: ParamFamily\)/, '面板要有 setThinking（含 family）');
  assert.match(panel, /mergeReasoningSampling\(/, '发送时要把 intent 并进采样参数');
});

test('★★★ 持久化：读的时候逐项校验（localStorage 是能手改的明文）', () => {
  const src = stripComments(read('client/src/mobile/main.ts'));
  assert.match(src, /const LS_THINKING = 'tcs\.mobile\.thinking'/, '要有独立键');
  assert.match(src, /THINKING_INTENTS\.has\(/, 'intent 要按白名单过滤');
  assert.match(src, /function readThinking\(/, '要能读回');
  assert.match(src, /onPersistThinking: writeThinking/, '要真的接上外壳');
});

test('★★★ isReasoningEffortField 只认那一行，别误伤其它字段', () => {
  assert.equal(isReasoningEffortField(['oai_settings', 'reasoning_effort']), true);
  assert.equal(isReasoningEffortField(['oai_settings', 'verbosity']), false);
  assert.equal(isReasoningEffortField(['oai_settings', 'temp_openai']), false);
  assert.equal(isReasoningEffortField(['reasoning_effort']), false);
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 提示文案必须跟着 intent 走（真机抓到的真缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 正常态下三句话各不相同，且都说清"我会怎么做"', () => {
  /*
   * 真机现场：点「关闭」之后，下面还写着「自动 = 不干预，用接口自己的默认值」。
   *
   * 成因是 `plan.note ?? '自动 = …'` —— `note` 只在 `intent === 'auto'`
   * 时有值，于是 off / on 全落到那句"自动"的解释上。
   *
   * 这种错**不会报错、也不会让"提示非空"的判据红**（它确实非空），
   * 但用户读到的是跟自己操作相反的话。
   *
   * 所以这里逐个 intent 验**内容对应**，不只验非空。
   */
  const src = buildSection({ source: 'deepseek', customUrl: undefined, intent: 'off' }).root;
  const offText = String(byRole(src, 'reasoning-hint')[0].textContent);
  assert.match(offText, /关闭/, `选「关闭」时提示应讲关闭，实际：${offText}`);
  assert.ok(!/^自动/.test(offText), `选「关闭」时不许讲"自动"：${offText}`);

  const onSrc = buildSection({ source: 'deepseek', customUrl: undefined, intent: 'on' }).root;
  const onText = String(byRole(onSrc, 'reasoning-hint')[0].textContent);
  assert.match(onText, /开启/, `选「开启」时提示应讲开启，实际：${onText}`);

  const autoSrc = buildSection({ source: 'deepseek', customUrl: undefined, intent: 'auto' }).root;
  const autoText = String(byRole(autoSrc, 'reasoning-hint')[0].textContent);
  assert.match(autoText, /自动/, `选「自动」时提示应讲自动，实际：${autoText}`);

  /* 三句必须真的不同（防止有人偷懒写成同一句） */
  const unique = new Set([offText, onText, autoText]);
  assert.equal(unique.size, 3, '三种 intent 的说明不能是同一句');
});

test('★★★★ 切 intent 后提示跟着变（重绘时重算，不是渲染时写死）', () => {
  const { root } = buildSection({ source: 'deepseek', customUrl: undefined, intent: 'auto' });
  const before = String(byRole(root, 'reasoning-hint')[0].textContent);

  const off = byRole(root, 'thinking-intent-option').find(
    (b) => b.getAttribute('data-value') === 'off',
  );
  off.fire('click');

  const after = String(byRole(root, 'reasoning-hint')[0].textContent);
  assert.notEqual(after, before, '切到「关闭」后提示必须变');
  assert.match(after, /关闭/, `切到「关闭」后应讲关闭：${after}`);
});

/* ═══════════════════════════════════════════════════════════
   ⑦ hidden 必须真的不占位（真机抓到的第二个缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ `hidden` 的行必须有显式 display:none（否则照样占一整行）', () => {
  /*
   * 真机现象：DeepSeek 没有长度旋钮，`budgetRow.hidden = true` 也设上了
   * （探针读到 `hidden: true`），但**视觉上「思考长度」那行还在**，
   * 只是里面空了 —— 用户会以为"控件没加载出来"。
   *
   * 成因：`.nb-field` 有 `display: flex`，而 `[hidden]` 的浏览器默认
   * `display: none` **优先级低于类选择器**。
   *
   * ★ 探针当时为什么没抓到：它断言的是 `element.hidden` 这个**属性**，
   *   而不是"它到底占不占空间"。属性为 true 但视觉仍在 —— 这类
   *   "DOM 正常但视觉错"是本项目最反复的一类（§73 记了四个同款）。
   *
   * 所以这条判据直接钉 CSS：带 `hidden` 的 `.nb-field` 必须显式 `display: none`。
   */
  const css = read('client/src/chat/chat.css');

  /* 找 `.nb-field[hidden]` 那条规则 */
  const idx = css.indexOf('.nb-field[hidden]');
  assert.ok(idx >= 0, '必须有 `.nb-field[hidden] { display: none }` 这条规则');

  const block = css.slice(idx, css.indexOf('}', idx));
  assert.match(block, /display:\s*none/, '`.nb-field[hidden]` 必须显式 display: none');

  /* 同时确认 `.nb-field` 确实会冲突（写了 display 别的值） */
  const baseIdx = css.indexOf('.nb-field {');
  assert.ok(baseIdx >= 0, '找不到 .nb-field 基础规则');
  const baseBlock = css.slice(baseIdx, css.indexOf('}', baseIdx));
  assert.match(
    baseBlock,
    /display:\s*(flex|grid|block|inline-flex)/,
    '`.nb-field` 有 display 才会与 [hidden] 冲突 —— 若它没有，这条判据就没有存在意义',
  );
});

test('★★★ 折叠面板也必须有显式的 [hidden] 规则', () => {
  const css = read('client/src/chat/chat.css');
  assert.ok(
    /\.nb-reasoning-adv-panel\[hidden\]\s*\{\s*display:\s*none/.test(css) ||
      /\.nb-field\[hidden\][\s\S]{0,120}\.nb-reasoning-adv-panel\[hidden\][\s\S]{0,80}display:\s*none/.test(css),
    '折叠面板要能真的收起（同一条 `[hidden]` 规则里带上或单独一条都行）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑧ 兜底：手选参数族（2026-11-07）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 手选入口只在"认不出"时出现（不打扰正常路径）', () => {
  /*
   * 认得出时不显示手选 —— 否则用户会去动它，反而把正确的自动识别覆盖掉。
   *
   * 反过来说：认不出时**必须**出现，否则用户只能干瞪眼
   * （界面说"不会生效"，却没有任何补救手段）。
   */
  const ok = buildSection({
    model: 'deepseek-v4-pro',
    customUrl: 'https://api.deepseek.com/v1',
    intent: 'off',
  });
  assert.equal(
    byRole(ok.root, 'reasoning-manual-row')[0].hidden,
    true,
    '认得出时手选行应隐藏',
  );

  const bad = buildSection({
    model: 'gpt-4o',
    customUrl: 'https://unknown.example.com/v1',
    intent: 'off',
  });
  const row = byRole(bad.root, 'reasoning-manual-row')[0];
  assert.ok(row !== undefined, '认不出时应有手选行');
  assert.equal(row.hidden, false, '认不出时手选行必须出现（用户要能自救）');
});

test('★★★★★ 手选一个族之后，整个区块从"不支持"变成"可用"', () => {
  /*
   * 这是兜底方案的**验收点**：用户按厂商文档选一族，参数就真的能发出去。
   * 只验证"下拉出现了"是不够的 —— 那只能证明界面上有个控件。
   *
   * 走的是真实路径：`initialFamily` 来自持久化，等价于用户上次选过、
   * 下次进来重新渲染。
   */
  const before = buildSection({
    model: 'doubao-seed-1-6',
    customUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    intent: 'off',
  });
  assert.equal(before.root.getAttribute('data-branch'), 'unsupported', '前提：一开始认不出');

  const after = buildSection({
    model: 'doubao-seed-1-6',
    customUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    intent: 'off',
    initialFamily: 'thinking.type',
  });
  assert.equal(
    after.root.getAttribute('data-branch'),
    'normal',
    '手选 thinking.type 后应变成可用（不再是 unsupported）',
  );

  /* 而且三态真的能点了 */
  const btns = byRole(after.root, 'thinking-intent-option');
  for (const btn of btns) {
    assert.equal(btn.getAttribute('disabled'), null, '手选后三态应可用');
  }

  /*
   * ★ 手选行必须**继续显示**（2026-11-07 判据抓到的设计缺陷）。
   *
   * 第一版是"手选生效就收起"。但那样会**死锁**：
   * 手选让识别成功了 ⇒ 行收起 ⇒ 用户看不到自己选了什么，
   * 也再也没有办法改回自动识别（「不确定」那一项就在这个下拉里）。
   */
  assert.equal(
    byRole(after.root, 'reasoning-manual-row')[0].hidden,
    false,
    '手选生效后该行仍要显示，否则用户改不回去',
  );
});

test('★★★★★ 手选的下拉里恰好是四族 + 一个"不确定"', () => {
  /*
   * 四族是结构事实，不多不少。
   * 「不确定（不注入）」这一项必须有：它是"撤销手选"的唯一入口 ——
   * 没有它就等于用户选错之后再也回不到自动识别。
   */
  const { root } = buildSection({
    model: 'gpt-4o',
    customUrl: 'https://unknown.example.com/v1',
    intent: 'off',
  });
  const select = byRole(root, 'reasoning-manual-select')[0];
  assert.ok(select !== undefined, '应有手选下拉');
  /*
   * ★ 选项文字在**子元素**里（`makeSelectTrigger` 只把当前值写进
   *   `valueText`，其余选项在点开的面板里）。所以用 `allText` 聚合整棵子树，
   *   不能读父节点的 `textContent`（stub 与真实 DOM 都不聚合）。
   */
  const text = allText(select);
  assert.match(text, /不确定|不注入/, '必须有"撤销手选"的入口，否则选错了改不回来');
});

test('★★★★ 手选族的说明文字来自那族的 hint（用户靠它判断选对没）', () => {
  const { root } = buildSection({
    model: 'gpt-4o',
    customUrl: 'https://unknown.example.com/v1',
    intent: 'off',
    initialFamily: 'enable_thinking',
  });
  const hint = byRole(root, 'reasoning-manual-hint')[0];
  assert.ok(hint !== undefined, '应有说明文字');
  assert.match(
    String(hint.textContent),
    /enable_thinking/,
    '选了什么族就该显示那族的字段名，用户能对照厂商文档确认',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑨ 「当前按什么模型控制」提示（2026-11-07，用户要求 5）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 思考下面必须说明"当前按哪家规则控制"', () => {
  /*
   * 用户原话：
   *
   * > 最好在思考下面提示一下目前是使用的什么模型的控制。
   *
   * 这句是**信任的基础**：用户改了半天参数，总得知道这些参数是按哪一家的
   * 规矩在发。没有这句，一切设置都像在黑箱里。
   */
  const ds = buildSection({
    model: 'deepseek-v4-pro',
    customUrl: 'https://api.deepseek.com/v1',
    intent: 'on',
  });
  const hint = byRole(ds.root, 'reasoning-model-hint')[0];
  assert.ok(hint !== undefined, '必须有「当前按…」这一行');
  assert.match(String(hint.textContent), /DeepSeek/, '要说清是哪一家');

  /* 认不出时要明说，而不是空着 */
  const unknown = buildSection({
    model: 'gpt-4o',
    customUrl: 'https://unknown.example.com/v1',
    intent: 'on',
  });
  const unknownHint = byRole(unknown.root, 'reasoning-model-hint')[0];
  assert.match(String(unknownHint.textContent), /未识别|认不出|不会生效/);
  assert.equal(String(unknownHint.getAttribute('data-kind')), 'warn', '认不出要标 warn');
});

test('★★★★ 中转站模型也报得出家门（用户实际场景）', () => {
  const r = buildSection({
    model: '[反重力次]gemini-4-argon',
    customUrl: 'https://my-relay.example.com/v1',
    intent: 'on',
  });
  const hint = byRole(r.root, 'reasoning-model-hint')[0];
  assert.match(String(hint.textContent), /Gemini/, '要识别出 Gemini 并说明');
});

/* ═══════════════════════════════════════════════════════════
   ⑩ 「思考」与「思考长度」的关系（2026-11-07，用户要求 4）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 思考关闭 + 可关的模型 ⇒ 长度置灰并说明不生效', () => {
  const r = buildSection({
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  const row = byRole(r.root, 'reasoning-budget-row')[0];
  assert.equal(String(row.getAttribute('data-disabled')), 'true', '长度行应标为不可用');

  const hint = byRole(r.root, 'reasoning-budget-hint')[0];
  assert.match(String(hint.textContent), /已关闭|不生效/, '要明说"思考已关闭所以它不生效"');
  assert.equal(String(hint.getAttribute('data-kind')), 'warn', '不可用要标 warn');
});

test('★★★★★ 思考关闭 + 关不掉的模型 ⇒ 长度仍可用（不置灰）', () => {
  /*
   * 这一格最容易被想当然地搞错：用户的意图是"关"，但模型不听，
   * 于是**一切控制都落在长度上**。把它置灰等于让用户彻底失去手段。
   */
  const r = buildSection({
    model: 'qwen3-max-thinking',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  const row = byRole(r.root, 'reasoning-budget-row')[0];
  assert.equal(String(row.getAttribute('data-disabled')), 'false', '降级时长度必须可用');

  const hint = byRole(r.root, 'reasoning-budget-hint')[0];
  assert.equal(String(hint.getAttribute('data-kind')), 'normal', '可用时不该标 warn');
  assert.match(String(hint.textContent), /关不掉|压短/, '要说明它现在承载了全部控制');
});

test('★★★★ 思考开启时长度可用，并说明两者关系', () => {
  const r = buildSection({
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'on',
  });
  const hint = byRole(r.root, 'reasoning-budget-hint')[0];
  assert.equal(String(hint.getAttribute('data-kind')), 'normal');
  assert.match(String(hint.textContent), /最多想多久|限制/, '要说明它限制的是什么');
});

/* ═══════════════════════════════════════════════════════════
   五个新问题（2026-11-07）：key 状态 / 人设胶囊
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 人设胶囊必须是三个子元素，`▾` 不许混在文本里', () => {
  /*
   * 用户截图反馈「人设切换上的文字显示不清楚」。
   *
   * 真机量到的现场：
   *
   * ```text
   *   胶囊 innerHTML: "👤 新设定 5 ▾"      ← 单个文本节点
   *   max-width: 42% / overflow: hidden / text-overflow: ellipsis
   * ```
   *
   * 于是文字一长就**整体**截断，`▾` 跟着被吃掉或只露一半 ——
   * 用户看到的是"文字后面叠着半个图形"。
   *
   * 修法：图标 / 文字 / 箭头拆成三个元素，只有中间那个可以省略。
   */
  /*
   * ★ 必须剥注释再断言 —— 这个文件的注释里**就写着旧写法**
   *   （`原来是一整段文本：\`chip.textContent = \`👤 ${personaText} ▾\``），
   *   不剥的话判据会读到自己的说明文字然后误报。
   *   这是本项目第 N 次犯同一个错（§39 / §67.3 / §131 都记过）。
   */
  const src = stripComments(read('client/src/chat/chat-panel.ts'));

  /* 三个类都要存在 */
  assert.match(src, /nb-persona-chip-icon/, '要有图标元素');
  assert.match(src, /nb-persona-chip-text/, '要有可省略的文字元素');
  assert.match(src, /nb-persona-chip-caret/, '要有独立的箭头元素');

  /* `▾` 必须在独立元素里，不能拼进模板字符串 */
  assert.doesNotMatch(
    src,
    /👤 \$\{personaText\} ▾/,
    '`▾` 不许混在文本里（会被 ellipsis 吃掉）',
  );
});

test('★★★★★ 切人设后不许写 textContent（会毁掉三个子元素）', () => {
  /*
   * 这是同一缺陷的**第二处**，而且更隐蔽：
   *
   * `syncPersonaChip()` 原来写 `chip.textContent = \`👤 ${text} ▾\``。
   * 拆成三个子元素之后，这行赋值会把它们**整个替换成一个文本节点** ——
   * 于是"首次进页面正常、切一次人设就坏"。
   *
   * 这种"改了一半"的修法比不修更糟：看起来好了，用一下就复发。
   */
  const src = stripComments(read('client/src/chat/chat-panel.ts'));
  const fn = src.slice(src.indexOf('syncPersonaChip('), src.indexOf('constructor('));

  assert.match(fn, /findPersonaTextNode/, '要定位到那个文字节点再改');
  assert.doesNotMatch(
    fn,
    /chip\.textContent\s*=\s*isButton/,
    '不许用 textContent 整体覆盖（会毁掉图标/箭头）',
  );
});

test('★★★★ 胶囊的省略只作用在文字上（CSS 归属要对）', () => {
  const css = read('client/src/chat/chat.css');

  /* 文字元素的规则里必须有 ellipsis + min-width: 0 */
  const textAt = css.indexOf('.nb-persona-chip-text {');
  assert.ok(textAt >= 0, '要有 .nb-persona-chip-text 规则');
  const textBlock = css.slice(textAt, css.indexOf('}', textAt));
  assert.match(textBlock, /text-overflow:\s*ellipsis/, '文字要能省略');
  assert.match(
    textBlock,
    /min-width:\s*0/,
    'flex 子项必须有 min-width: 0，否则拒绝收缩、省略号永不出现',
  );

  /* 图标与箭头不许收缩 */
  assert.match(css, /\.nb-persona-chip-icon,[\s\S]{0,80}flex:\s*0 0 auto/, '图标/箭头不许收缩');
});

test('★★★★★ 「哪些源配了 key」必须问 ST，不能只信本地标记', () => {
  /*
   * 用户报「配了 API key，界面说没配」。
   *
   * 本地标记会因换版本 / 清缓存 / 在 ST 原始界面配过而丢失，
   * 而 ST 的 `secrets.json` 才是真相（`/api/secrets/read` 返回掩码状态）。
   *
   * 追溯：ST 的 `SECRET_KEYS` 命名是 `api_key_<source>`，
   * 所以按前缀剥即可，不必维护映射表。
   */
  const shell = read('client/src/chat/shell.ts');
  assert.match(shell, /refreshKeyPresence/, '要有"问 ST 要真相"的方法');
  assert.match(shell, /this\.bridge\.secretPresent\(\)/, '要真的调那个桥方法');
  assert.match(shell, /api_key_/, '要按 ST 的命名规律剥前缀');

  const bridge = read('client/src/chat/st-bridge.ts');
  assert.match(bridge, /secretPresent\(\): Promise<string\[\]>/, '桥要有 secretPresent');

  const rust = read('client/src-tauri/src/st_chat.rs');
  assert.match(rust, /st_chat_secret_present/, 'Rust 侧要有对应命令');
  assert.match(rust, /\/api\/secrets\/read/, '要打 ST 的那个端点');
  /* 只返回 key 名，不返回掩码内容 */
  assert.match(rust, /Result<Vec<String>, ShellError>/, '只返回 key 名列表');
});

test('★★★★★ 「问不到」不等于「都没配」（失败时不许清空标记）', () => {
  /*
   * 如果把 ST 请求失败当成"一个都没配"，一次临时故障就会让 6 个源
   * 全变成「未配 key」—— 用户会以为自己的 key 被删了。
   *
   * 两处都要守住：
   *   ① Rust：解析失败返回 Err（不是空 Vec）
   *   ② TS：catch 住就 return，不动 apiKeyPresent
   */
  /*
   * 同样剥注释：那段注释里正好写着 `早先这里写的是 return Ok(Vec::new())`，
   * 说明"为什么错"。不剥的话判据会把这段解释当成违规代码。
   */
  const rust = stripComments(read('client/src-tauri/src/st_chat.rs'));
  assert.doesNotMatch(
    rust,
    /return Ok\(Vec::new\(\)\)/,
    '解析失败不许返回空列表（那等于"全都没配"）',
  );
  assert.match(rust, /StBadResponse/, '解析失败要报 StBadResponse');

  const shell = read('client/src/chat/shell.ts');
  const fn = shell.slice(shell.indexOf('private async refreshKeyPresence'), shell.indexOf('private async withConnection'));
  assert.match(fn, /catch\s*\{/, '要 catch');
  assert.match(fn, /return;/, 'catch 里要直接返回、不清标记');
  /* 关键：赋值只能在成功路径上 */
  const assignAt = fn.indexOf('this.apiKeyPresent = fromSt');
  const catchAt = fn.indexOf('catch');
  assert.ok(assignAt > catchAt, '赋值必须在 catch 之后（成功路径）');
});
