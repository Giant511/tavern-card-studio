/**
 * 思考模式适配层 · P0（2026-11-07）。
 *
 * ## 这份判据要防的四类错
 *
 * ```text
 *   A  双写参数（同时发 thinking 和 enable_thinking）  ← 实测会被静默忽略，造成假关闭
 *   B  参数发错族（给 Qwen 发 thinking.type）          ← 同样静默忽略
 *   C  通道走错（custom 源却指望 include_reasoning）    ← ST 不读，等于没设
 *   D  forcedThinking 没有降级，界面却显示"已关闭"      ← 撒谎
 * ```
 *
 * ## 为什么全部是纯静态/纯函数判据
 *
 * 这一层是**纯逻辑**（能力表 + 注入计算），不需要真机也不需要真 API。
 * 真 API 那一层在 P0 验收时单独跑一次（每家 2 次请求），成本约 0.01 元。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FAMILY_PRESETS,
  PROFILES,
  manualProfile,
  normalizeModelName,
  buildReasoningInjection,
  isForcedThinking,
  matchProfile,
  mergeUserBody,
  profileById,
  serializeInjectionBody,
} from '../shared/dist/chat/reasoningProfiles.js';
import { buildGenerateRequest, previewReasoningPlan } from '../shared/dist/chat/generate.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

const msgs = [{ role: 'user', content: 'hi' }];

/* ═══════════════════════════════════════════════════════════
   A 能力表本身
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 能力表覆盖六家（P0 四家 + Gemini/Claude）', () => {
  /*
   * ★ 2026-11-07 扩到六家。
   *
   * P0 只做 DeepSeek / Qwen / GLM / Kimi 是有意的范围控制。但用户截图里
   * 他实际在用的中转站模型全是 `gemini-*` 和 `claude-*` ——
   * 这两家不覆盖的话，他最常用的那些模型全都显示"认不出"。
   *
   * 断言"恰好六家"而不是"至少包含"：多一家就意味着有人加了 profile
   * 但没在这里登记，那条 hint / budget 的正确性就没人验过。
   */
  const ids = PROFILES.map((p) => p.id).sort();
  assert.deepEqual(
    ids,
    ['claude', 'deepseek', 'gemini', 'glm', 'kimi', 'qwen'],
    '实际 ' + ids.join('/'),
  );
});

test('★★★★★ 每家都必须有非空的 on 与 off（少了 off 就等于关不掉）', () => {
  const bad = [];
  for (const p of PROFILES) {
    if (Object.keys(p.on).length === 0) bad.push(`${p.id}: on 为空`);
    if (Object.keys(p.off).length === 0) bad.push(`${p.id}: off 为空`);
    if (p.on === p.off) bad.push(`${p.id}: on 与 off 是同一个对象引用`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('★★★★★ 绝对不许双写：一家的 on/off 只能出现**一族**参数', () => {
  /*
   * 这是本方案最重要的一条。
   *
   * 实测：`DeepSeek + enable_thinking:false` → 思考仍有 52 字（被静默忽略）。
   * 所以"两个都写，总有一个生效"会让界面说"已关闭"而模型还在思考、
   * 还在烧 token —— 比"不支持"更糟，因为用户失去了发现问题的线索。
   */
  const FAMILY_KEYS = {
    'thinking.type': 'thinking',
    enable_thinking: 'enable_thinking',
    'reasoning_effort': 'reasoning_effort',
    think: 'think',
  };

  const bad = [];
  for (const p of PROFILES) {
    const allowed = FAMILY_KEYS[p.family];
    if (allowed === undefined) {
      bad.push(`${p.id}: 未知 family ${p.family}`);
      continue;
    }
    for (const [label, body] of [
      ['on', p.on],
      ['off', p.off],
    ]) {
      const keys = Object.keys(body);
      const foreign = keys.filter((k) => !Object.values(FAMILY_KEYS).includes(k));
      if (foreign.length > 0) bad.push(`${p.id}.${label} 混入了无关字段: ${foreign.join(',')}`);
      /* 必须含自己那一族，且不含另一族的开关字段 */
      if (!keys.includes(allowed) && allowed !== 'reasoning_effort') {
        bad.push(`${p.id}.${label} 缺少本族字段 ${allowed}`);
      }
      const otherSwitches = ['thinking', 'enable_thinking', 'think'].filter(
        (k) => k !== allowed && keys.includes(k),
      );
      if (otherSwitches.length > 0) {
        bad.push(`${p.id}.${label} **双写**了 ${allowed} 与 ${otherSwitches.join(',')}`);
      }
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('★★★★ 各族的具体字段值符合官方文档', () => {
  const ds = profileById('deepseek');
  assert.deepEqual(ds.off, { thinking: { type: 'disabled' } });
  assert.deepEqual(ds.on, { thinking: { type: 'enabled' } });

  const qwen = profileById('qwen');
  assert.deepEqual(qwen.off, { enable_thinking: false });
  assert.deepEqual(qwen.on, { enable_thinking: true });
  assert.equal(qwen.budget.key, 'thinking_budget');

  const glm = profileById('glm');
  assert.deepEqual(glm.off, { thinking: { type: 'disabled' } });
  /* GLM 只认 max/high/low（5.3 传 medium 会 400），所以档位表不许更宽 */
  assert.deepEqual(glm.budget.options, ['low', 'high', 'max']);

  const kimi = profileById('kimi');
  assert.deepEqual(kimi.off, { thinking: { type: 'disabled' } });
  /* Kimi 的 thinking.keep 是"保留多少历史思考"，不是长度上限，不许当 budget */
  assert.equal(kimi.budget, undefined);
});

/* ═══════════════════════════════════════════════════════════
   B 厂商识别（地址优先于模型名）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 按地址识别（用户明确填的地址最权威）', () => {
  const cases = [
    ['https://api.deepseek.com/v1', 'whatever', 'deepseek'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'whatever', 'qwen'],
    ['https://open.bigmodel.cn/api/paas/v4', 'whatever', 'glm'],
    ['https://api.moonshot.cn/v1', 'whatever', 'kimi'],
  ];
  for (const [url, model, want] of cases) {
    assert.equal(matchProfile({ baseUrl: url, model })?.id, want, `${url} 应识别为 ${want}`);
  }
});

test('★★★★ 地址认不出时按模型名兜底（中转站场景）', () => {
  assert.equal(matchProfile({ baseUrl: 'https://my-proxy.example.com/v1', model: 'deepseek-v4-pro' })?.id, 'deepseek');
  assert.equal(matchProfile({ baseUrl: 'https://my-proxy.example.com/v1', model: 'qwen3-max' })?.id, 'qwen');
  assert.equal(matchProfile({ baseUrl: 'https://my-proxy.example.com/v1', model: 'glm-4.6' })?.id, 'glm');
  assert.equal(matchProfile({ baseUrl: 'https://my-proxy.example.com/v1', model: 'kimi-k2.6' })?.id, 'kimi');
});

test('★★★★ 地址优先级高于模型名（不许被模型名带偏）', () => {
  /*
   * 极端但真实的情况：在 DeepSeek 官方地址上填了一个奇怪模型名。
   * 地址是用户明确填的，所以按 deepseek 处理，不按模型名猜。
   */
  const p = matchProfile({ baseUrl: 'https://api.deepseek.com/v1', model: 'qwen3-max' });
  assert.equal(p?.id, 'deepseek', '地址命中就该停下，不许再看模型名');
});

test('★★★ 认不出的返回 null（上层走兜底，不许瞎猜一家）', () => {
  assert.equal(matchProfile({ baseUrl: 'https://unknown.example.com', model: 'gpt-4o' }), null);
  assert.equal(matchProfile({ model: '' }), null);
});

/* ═══════════════════════════════════════════════════════════
   C 注入计算
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ auto 必须返回空对象（不许替用户做决定）', () => {
  /*
   * 各家默认值不同（DeepSeek/Kimi/GLM 默认开，qwen3-vl 默认关）。
   * 把 auto 翻成 off 就是替用户做错决定，而他还看不出是谁改的。
   */
  for (const p of PROFILES) {
    const r = buildReasoningInjection(p, 'auto', 4096, 'any-model');
    assert.deepEqual(r.body, {}, `${p.id} 的 auto 必须什么都不发`);
    assert.equal(r.degraded, false);
  }
});

test('★★★★★ off / on 分别产出 off / on 的字段', () => {
  const ds = profileById('deepseek');
  assert.deepEqual(buildReasoningInjection(ds, 'off', undefined, 'deepseek-v4-pro').body, {
    thinking: { type: 'disabled' },
  });
  assert.deepEqual(buildReasoningInjection(ds, 'on', undefined, 'deepseek-v4-pro').body, {
    thinking: { type: 'enabled' },
  });
});

test('★★★★★ forcedThinking + off ⇒ 降级为 on + 限长，并标记 degraded', () => {
  const qwen = profileById('qwen');
  const r = buildReasoningInjection(qwen, 'off', undefined, 'qwen3-max-thinking');
  assert.deepEqual(r.body, { enable_thinking: true, thinking_budget: 128 }, '应发 on + 最轻预算');
  assert.equal(r.degraded, true, '必须标记降级，否则 UI 会撒谎说"已关闭"');
  assert.match(String(r.reason), /关不掉|强制思考/, '要说清为什么没关成');

  /* GLM：降级到 reasoning_effort=low */
  const glm = profileById('glm');
  const g = buildReasoningInjection(glm, 'off', undefined, 'glm-5.3');
  assert.deepEqual(g.body, { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.equal(g.degraded, true);
});

test('★★★ 没有 budget 的厂商降级后仍然 degraded（并说明限不了长）', () => {
  /*
   * Kimi 没有"限制思考长度"的旋钮（`thinking.keep` 是"保留多少历史思考"，
   * 语义不同，不能当长度上限用）。降级只能做到"仍然开"，
   * 但要如实说"限不了长"。
   *
   * ★ 2026-11-07 改：DeepSeek **原本**也在这条判据里，但它有
   *   `reasoning_effort`（实测 low 34s / max 83s），已补上 budget。
   *   所以这里换成 Kimi —— 它才是真的没有旋钮。
   */
  const kimi = profileById('kimi');
  const r = buildReasoningInjection(kimi, 'off', undefined, 'kimi-k2.7-code');
  assert.deepEqual(r.body, { thinking: { type: 'enabled' } });
  assert.equal(r.degraded, true);
  assert.match(String(r.reason), /没有|无法/, '要说清这个接口没有限长选项');
});

test('★★★★★ DeepSeek 有思考长度旋钮（2026-11-07 实测后补）', () => {
  /*
   * 原来 DeepSeek 没有 budget，用户只能"开/关"，调不了长度。
   *
   * 实测（狼羊白菜，max_tokens=8192）：
   *   low   思考 3196 字 | 34s
   *   high  思考 2957 字 | 35s   ← 与 low 无区别
   *   max  思考 18208 字 | 83s   ← 5.7 倍
   *
   * ⇒ 三档都留着（max 确实有用），但 default 必须是 low ——
   *   把用户默认拖进 83 秒那一档，就是他最初抱怨的"延迟非常大"。
   */
  const ds = profileById('deepseek');
  assert.ok(ds.budget !== undefined, 'DeepSeek 要有思考长度旋钮');
  assert.equal(ds.budget.key, 'reasoning_effort');
  assert.deepEqual(ds.budget.options, ['low', 'high', 'max']);
  assert.equal(ds.budget.default, 'low', '默认必须是最轻档，不能是 max');

  /* 降级时压到最轻 */
  const r = buildReasoningInjection(ds, 'off', undefined, 'deepseek-reasoner');
  assert.deepEqual(r.body, { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  assert.equal(r.degraded, true);
});

test('★★★★★ 不许把 DeepSeek 静默忽略的档位放进 options', () => {
  /*
   * 实测：`medium` / `minimal` / `none` 全都**不报错**，退回默认
   * （思考量 5473 / 2379 / 4295 字）。
   *
   * 所以绝不能把它们列进 options —— 用户选「无」以为关掉了思考，
   * 实际思考 4295 字（比 low 还多）。这与"双写参数"是同一类陷阱：
   * **不报错的无效**比报错更危险。
   */
  const ds = profileById('deepseek');
  for (const bad of ['medium', 'minimal', 'none', 'auto']) {
    assert.ok(
      !ds.budget.options.includes(bad),
      `DeepSeek 的 options 不许含 ${bad}（它会被静默忽略，造成"以为关了"）`,
    );
  }
});

test('★★★★ 预算必须夹到合法区间（超范围上游会 400）', () => {
  const qwen = profileById('qwen');
  const lo = buildReasoningInjection(qwen, 'on', 1, 'qwen3-max');
  assert.deepEqual(lo.body, { enable_thinking: true, thinking_budget: 128 }, '低于下限要夹到 128');

  const hi = buildReasoningInjection(qwen, 'on', 999999, 'qwen3-max');
  assert.deepEqual(hi.body, { enable_thinking: true, thinking_budget: 32768 }, '高于上限要夹到 32768');

  /* enum 型：非法档位回落 fallback，不许原样发出去 */
  const glm = profileById('glm');
  const bad = buildReasoningInjection(glm, 'on', 'medium', 'glm-4.6');
  assert.equal(bad.body.reasoning_effort, 'low', 'GLM-5.3 不认 medium，应回落到合法档位');
});

test('★★★ 可关的模型 off 时不许被降级', () => {
  const qwen = profileById('qwen');
  for (const model of ['qwen3-max', 'qwen3-8b', 'qwq-32b']) {
    const r = buildReasoningInjection(qwen, 'off', undefined, model);
    assert.deepEqual(r.body, { enable_thinking: false }, `${model} 可关，不该降级`);
    assert.equal(r.degraded, false);
  }
});

test('★★★ forcedThinking 识别', () => {
  assert.equal(isForcedThinking(profileById('deepseek'), 'deepseek-reasoner'), true);
  assert.equal(isForcedThinking(profileById('deepseek'), 'deepseek-v4-pro'), false);
  assert.equal(isForcedThinking(profileById('qwen'), 'qwen3-vl-plus'), false);
  assert.equal(isForcedThinking(profileById('qwen'), 'qwen3-235b-a22b-thinking'), true);
  assert.equal(isForcedThinking(profileById('glm'), 'GLM-5.3'), true);
  assert.equal(isForcedThinking(profileById('glm'), 'glm-4.6'), false);
  assert.equal(isForcedThinking(profileById('kimi'), 'kimi-k2.7-code'), true);
});

/* ═══════════════════════════════════════════════════════════
   D 序列化与用户手写合并
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 序列化产出合法 JSON（JSON 是 YAML 子集，ST 的 yaml.parse 能读）', () => {
  const body = { thinking: { type: 'disabled' }, enable_thinking: false };
  const s = serializeInjectionBody(body);
  assert.equal(typeof s, 'string');
  assert.deepEqual(JSON.parse(s), body, '必须能被 JSON.parse 还原');
  /* 不许出现 YAML 专有写法（那说明有人手拼了） */
  assert.ok(!s.includes('---'), '不许出现 YAML 文档分隔符');
});

test('★★★★★ 用户手写优先（能力表过期时用户要能自救）', () => {
  const merged = mergeUserBody({ thinking: { type: 'disabled' } }, '{"thinking":{"type":"enabled"}}');
  assert.deepEqual(JSON.parse(merged), { thinking: { type: 'enabled' } }, '用户写的必须赢');
});

test('★★★★ 用户手写不是 JSON 时原样透传（不许把他的手写弄坏）', () => {
  /*
   * 用户可能写 YAML。我们没有 yaml 依赖，也不能"猜着修" ——
   * 原样交给 ST 的 yaml.parse 是唯一不会破坏他内容的做法。
   */
  const yaml = 'thinking:\n  type: disabled\n';
  assert.equal(mergeUserBody({ enable_thinking: true }, yaml), yaml);
});

test('★★★ 没手写时就是注入体本身', () => {
  const s = mergeUserBody({ a: 1 }, undefined);
  assert.deepEqual(JSON.parse(s), { a: 1 });
});

/* ═══════════════════════════════════════════════════════════
   E 三通道落点（走真正的 buildGenerateRequest）
   ═══════════════════════════════════════════════════════════ */

function build(over) {
  return buildGenerateRequest({
    source: 'custom',
    model: 'deepseek-v4-pro',
    messages: msgs,
    customUrl: 'https://api.deepseek.com/v1',
    ...over,
  });
}

test('★★★★★ 通道① 原生：deepseek 源走 include_reasoning，不碰 custom_include_body', () => {
  const off = build({ source: 'deepseek', model: 'deepseek-v4-pro', customUrl: undefined, sampling: { thinkingIntent: 'off' } });
  assert.equal(off.ok, true);
  assert.equal(off.request.include_reasoning, false);
  assert.equal(off.request.custom_include_body, undefined, '原生通道不许用注入');
  assert.equal(off.reasoning.channel, 'native');

  const on = build({ source: 'deepseek', model: 'deepseek-v4-pro', customUrl: undefined, sampling: { thinkingIntent: 'on' } });
  assert.equal(on.request.include_reasoning, true);
});

test('★★★★★ 通道② 注入：custom 源走 custom_include_body，不设 include_reasoning', () => {
  const r = build({ sampling: { thinkingIntent: 'off' } });
  assert.equal(r.ok, true);
  assert.equal(r.reasoning.channel, 'inject');
  assert.equal(r.request.include_reasoning, undefined, 'custom 源设它没用，不许设');
  assert.deepEqual(JSON.parse(r.request.custom_include_body), { thinking: { type: 'disabled' } });
});

test('★★★★★ 同是 DeepSeek，换源就换通道（这正是"最大兼容"的核心）', () => {
  /*
   * 用户在「自定义」里填 DeepSeek 地址 —— 这是最常见的用法，
   * 也是"思考关不掉"的来源。它必须走注入通道。
   */
  const native = build({ source: 'deepseek', model: 'deepseek-v4-pro', customUrl: undefined, sampling: { thinkingIntent: 'off' } });
  const injected = build({ source: 'custom', model: 'deepseek-v4-pro', customUrl: 'https://api.deepseek.com/v1', sampling: { thinkingIntent: 'off' } });

  assert.equal(native.reasoning.channel, 'native');
  assert.equal(injected.reasoning.channel, 'inject');

  /* 两者的**效果**必须一致：都能关 */
  assert.equal(native.request.include_reasoning, false);
  assert.deepEqual(JSON.parse(injected.request.custom_include_body), { thinking: { type: 'disabled' } });
});

test('★★★★★ 通道③ 兜底：认不出的源要标 unsupported（不许假装生效）', () => {
  const r = build({ model: 'gpt-4o', customUrl: 'https://unknown.example.com/v1', sampling: { thinkingIntent: 'off' } });
  assert.equal(r.ok, true);
  assert.equal(r.reasoning.unsupported, true);
  assert.equal(r.request.custom_include_body, undefined, '认不出就不许瞎注入');
  assert.match(String(r.reasoning.reason), /不会生效/);
});

test('★★★★ auto 在注入通道下什么都不发', () => {
  const r = build({ sampling: { thinkingIntent: 'auto' } });
  assert.equal(r.ok, true);
  assert.equal(r.request.custom_include_body, undefined, 'auto 不许注入任何字段');
  assert.equal(r.reasoning.degraded, false);
});

test('★★★★ auto 在原生通道下不设字段，但要给出解释', () => {
  /*
   * ST 对 deepseek 源恒发 `thinking:{type:'disabled'}`，所以"自动"实际是关。
   * 不说清用户会困惑 —— 但也不许我们擅自改成"开"（那是另一种替他决定）。
   */
  const r = build({ source: 'deepseek', model: 'deepseek-v4-pro', customUrl: undefined, sampling: { thinkingIntent: 'auto' } });
  assert.equal(r.request.include_reasoning, undefined, 'auto 不许设字段');
  assert.match(String(r.reasoning.note), /自动/, '必须解释「自动」在这个源下意味着什么');
});

test('★★★★★ 降级时 plan 要带 degraded + reason（UI 靠它不说谎）', () => {
  const r = build({ model: 'qwen3-max-thinking', customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', sampling: { thinkingIntent: 'off' } });
  assert.equal(r.reasoning.degraded, true);
  assert.match(String(r.reasoning.reason), /关不掉|强制/);
  const body = JSON.parse(r.request.custom_include_body);
  assert.equal(body.enable_thinking, true, '降级后仍要开（因为关不掉）');
  assert.equal(body.thinking_budget, 128);
});

test('★★★ 不传 thinkingIntent 时按 auto（向后兼容旧调用方）', () => {
  const r = build({});
  assert.equal(r.ok, true);
  assert.equal(r.reasoning.intent, 'auto');
  assert.equal(r.request.custom_include_body, undefined);
});

/* ═══════════════════════════════════════════════════════════
   F 源码纪律
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 能力表里不许出现"两家都发"的兜底写法', () => {
  /*
   * 运行时判据（A 组那条）已经在对象层查过一次；这里从**源码字面**再钉一次，
   * 目的是防止有人"为了让判据变绿"去改运行时判据。
   *
   * ★ 第一版的正则 `off:\s*\{[^}]*\}` 是错的：`[^}]*` 在**嵌套对象**上直接失效
   *   （`{ thinking: { type: 'disabled' } }` 里第一个 `}` 就截断了），
   *   于是它把后面几个 profile 的 `enable_thinking` 也算进同一个 off 块 ——
   *   报了一个不存在的违规。这是"判据取错范围"的第 N 次。
   *
   * 现在改成按**括号配平**切块，切出来的才是真正的一个对象字面量。
   */
  const src = stripComments(read('shared/src/chat/reasoningProfiles.ts'));
  const start = src.indexOf('export const PROFILES');
  assert.ok(start > 0, '找不到 PROFILES');
  const body = src.slice(start);

  /** 从 `off: {` 的 `{` 开始，配平出整块 */
  function blockAfter(text, key) {
    const out = [];
    const re = new RegExp(`\\b${key}:\\s*\\{`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const from = m.index + m[0].length - 1;
      let depth = 0;
      let i = from;
      for (; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out.push(text.slice(from, i + 1));
    }
    return out;
  }

  /*
   * ★★ 直接 `b.includes('thinking')` 是错的 —— `enable_thinking` **包含**
   *    子串 `thinking`，于是每一块都"同时写了两个"。这是子串匹配的经典陷阱
   *    （本项目第 3 次踩：§131 的 `expired: this.repoAuthExpired` 前缀匹配同理）。
   *
   * 正确做法：按**键名**匹配，要求前面是 `{` `,` 或空白。
   */
  const KEY_THINKING = /[{,\s]thinking\s*:/;
  const KEY_ENABLE = /[{,\s]enable_thinking\s*:/;

  for (const key of ['on', 'off']) {
    const blocks = blockAfter(body, key);
    assert.ok(blocks.length >= PROFILES.length, `${key} 块数量应不少于 ${PROFILES.length}，实际 ${blocks.length}`);
    const offenders = blocks.filter((b) => KEY_THINKING.test(b) && KEY_ENABLE.test(b));
    assert.deepEqual(offenders, [], `${key} 的某一块同时写了 thinking 与 enable_thinking：\n${offenders.join('\n')}`);
  }
});

test('★★★ 通道判定必须只认 deepseek / claude 为原生（别的源设 include_reasoning 无效）', () => {
  const src = stripComments(read('shared/src/chat/generate.ts'));
  assert.match(
    src,
    /const NATIVE_REASONING_SOURCES: readonly StChatSource\[\] = \['deepseek', 'claude'\];/,
    '原生源清单必须是这两家（openrouter 的语义不同，不许放进来）',
  );
});

/* ═══════════════════════════════════════════════════════════
   G 命名空间前缀（2026-11-07 实测抓到的真缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 带命名空间前缀的模型名也要认得出（硅基流动格式）', () => {
  /*
   * 真机实测发现：`Pro/zai-org/GLM-4.7` 是**硅基流动的官方模型名格式**，
   * 而原来 `^glm-` 被前缀挡住 ⇒ 一个都认不出。
   *
   * ★ 这个缺陷的掩盖性极强：四家里 DeepSeek / Qwen 的模型名本来就以
   *   自己的名字开头（`deepseek-ai/DeepSeek-V3`、`Qwen/Qwen3-...`），
   *   **恰好**能匹配。所以只测这两家会得出"识别没问题"的错误结论。
   *   只有 GLM / Kimi 会漏。
   */
  const cases = [
    ['Pro/zai-org/GLM-4.7', 'glm'],
    ['Pro/zai-org/GLM-4.6', 'glm'],
    ['zai-org/glm-5.3', 'glm'],
    ['moonshotai/Kimi-K2.6', 'kimi'],
    ['Pro/moonshotai/Kimi-K2.5', 'kimi'],
    ['deepseek-ai/DeepSeek-V3.2', 'deepseek'],
    ['Qwen/Qwen3-235B-A22B', 'qwen'],
  ];
  for (const item of cases) {
    const model = item[0];
    const want = item[1];
    const p = matchProfile({ baseUrl: 'https://api.siliconflow.cn/v1', model });
    const got = p === null ? 'null' : p.id;
    assert.equal(got, want, model + ' 应识别为 ' + want + '，实际 ' + got);
  }
});

test('★★★★ 规范化只剥 `/` 前缀，不动 `:` 后缀', () => {
  /*
   * OpenRouter 有 `glm-4.6:free` / `:nitro` 这种修饰后缀。
   * 切掉它们会改变语义（free 版可能有额外限制），而且没必要 ——
   * `glm-4.6:free` 用 `^glm-` 本来就匹配得上。
   */
  assert.equal(normalizeModelName('glm-4.6:free'), 'glm-4.6:free');
  assert.equal(normalizeModelName('Pro/zai-org/GLM-4.7'), 'GLM-4.7');
  assert.equal(normalizeModelName('  glm-4.6  '), 'glm-4.6');
  assert.equal(normalizeModelName(''), '');
});

test('★★★★★ 前缀不影响 forcedThinking 的判定', () => {
  /*
   * 若只给 matchProfile 加规范化、忘了 isForcedThinking，
   * 就会出现：认得出是 GLM，但"GLM-4.7 强制思考"判不出来
   * ⇒ 用户点「关闭」得到静默无效，界面还告诉他"已关闭"。
   */
  const glm = profileById('glm');
  assert.equal(isForcedThinking(glm, 'Pro/zai-org/GLM-4.7'), true, '带前缀的 4.7 也是强制思考');
  assert.equal(isForcedThinking(glm, 'glm-4.6'), false);

  const ds = profileById('deepseek');
  assert.equal(isForcedThinking(ds, 'deepseek-ai/DeepSeek-Reasoner'), true);
});

/* ═══════════════════════════════════════════════════════════
   H 兜底：手动指定参数族（2026-11-07）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 四族通用配方齐备，且每族都有 on/off', () => {
  const families = FAMILY_PRESETS.map((p) => p.family).sort();
  assert.deepEqual(families, ['enable_thinking', 'reasoning_effort', 'think', 'thinking.type']);
  for (const p of FAMILY_PRESETS) {
    assert.ok(Object.keys(p.on).length > 0, p.family + ' 的 on 为空');
    assert.ok(Object.keys(p.off).length > 0, p.family + ' 的 off 为空');
    assert.ok(p.hint.length > 0, p.family + ' 缺 hint（用户靠它判断该选哪族）');
  }
});

test('★★★★★ 手选族包装成 profile 后能复用全部现有逻辑', () => {
  /*
   * 这是"不写第二套逻辑"的关键：`manualProfile` 产出的东西
   * 必须能被 `buildReasoningInjection` / UI 三分支直接吃掉。
   */
  const p = manualProfile('enable_thinking');
  assert.ok(p !== null);
  assert.equal(p.id, 'manual:enable_thinking');
  assert.equal(p.family, 'enable_thinking');
  /* 空 match：手选本身不参与自动匹配 */
  assert.deepEqual(p.match, {});

  const off = buildReasoningInjection(p, 'off', undefined, 'whatever');
  assert.deepEqual(off.body, { enable_thinking: false });

  const on = buildReasoningInjection(p, 'on', 2048, 'whatever');
  assert.deepEqual(on.body, { enable_thinking: true, thinking_budget: 2048 });
});

test('★★★★★ 手选族优先于自动识别（用户能自救）', () => {
  /*
   * 场景：中转站地址 + 认不出的模型名（比如 `doubao-seed-1-6`）。
   * 自动识别返回 null ⇒ 参数发不出去。用户按豆包文档手选
   * `thinking.type` 后，必须能正常注入。
   */
  const auto = previewReasoningPlan({
    source: 'custom',
    model: 'doubao-seed-1-6',
    customUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    intent: 'off',
  });
  assert.equal(auto.plan.unsupported, true, '前提：自动识别认不出');
  assert.deepEqual(auto.injectionBody, {});

  const manual = previewReasoningPlan({
    source: 'custom',
    model: 'doubao-seed-1-6',
    customUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    intent: 'off',
    manualFamily: 'thinking.type',
  });
  assert.equal(manual.plan.unsupported, false, '手选后应可用');
  assert.deepEqual(manual.injectionBody, { thinking: { type: 'disabled' } });
  assert.equal(manual.plan.profileId, 'manual:thinking.type');
});

test('★★★★ 手选族也覆盖"自动识别错了"的情况（手选优先）', () => {
  /*
   * 假如某个中转站的 `glm-4.6` 其实是个不支持 thinking 的魔改版，
   * 用户手选 `reasoning_effort` 后必须听用户的，而不是继续按 GLM 发 thinking。
   */
  const r = previewReasoningPlan({
    source: 'custom',
    model: 'glm-4.6',
    customUrl: 'https://open.bigmodel.cn/api/paas/v4',
    intent: 'off',
    manualFamily: 'reasoning_effort',
  });
  assert.equal(r.plan.profileId, 'manual:reasoning_effort');
  assert.deepEqual(r.injectionBody, { reasoning_effort: 'none' });
  assert.equal(
    Object.hasOwn(r.injectionBody, 'thinking'),
    false,
    '手选 reasoning_effort 时不许再发 thinking（那是自动识别的结论）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑨ 中转站模型名（2026-11-07，用户截图里的真实格式）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 中转站的方括号标签 / 倍率前缀都要剥掉', () => {
  /*
   * 用户截图里的真实写法（不是举例，是他正在用的）：
   *
   * ```text
   *   [反重力次]gemini-4-argon
   *   [次0.2]claude-opus-4-8-thinking
   *   0.12[ais]gemini-2.5-pro
   *   0.35[vertex]gemini-2.5-pro
   * ```
   *
   * 这些前缀的**共同结构**是「倍率 + [标签] + 真名」，
   * 但组合顺序、是否带倍率、标签里有数字，全都不统一。
   */
  const cases = [
    ['[反重力次]gemini-3.7-flash-high', 'gemini-3.7-flash-high'],
    ['[反重力次]gemini-4-argon', 'gemini-4-argon'],
    ['[次0.2]claude-opus-4-8-thinking', 'claude-opus-4-8-thinking'],
    ['0.12[ais]gemini-2.5-pro', 'gemini-2.5-pro'],
    ['0.1[vertex]gemini-3.8-flash', 'gemini-3.8-flash'],
    ['0.35[vertex]gemini-2.5-pro', 'gemini-2.5-pro'],
    /* 组合：组织前缀 + 标签 + 倍率 */
    ['Pro/zai-org/[标签]GLM-4.7', 'GLM-4.7'],
    /* 保持不动的 */
    ['gemini-2.5-flash', 'gemini-2.5-flash'],
    ['glm-4.6:free', 'glm-4.6:free'],
  ];
  for (const item of cases) {
    assert.equal(normalizeModelName(item[0]), item[1], item[0] + ' 应规范化为 ' + item[1]);
  }
});

test('★★★★★ 中转站的 gemini / claude 也要认得出（用户实际在用的）', () => {
  const url = 'https://my-relay.example.com/v1';
  const cases = [
    ['[反重力次]gemini-4-argon', 'gemini'],
    ['0.12[ais]gemini-2.5-pro', 'gemini'],
    ['[次0.2]claude-opus-4-8', 'claude'],
    ['[次0.2]claude-opus-4-8-thinking', 'claude'],
  ];
  for (const item of cases) {
    const p = matchProfile({ baseUrl: url, model: item[0] });
    const got = p === null ? 'null' : p.id;
    assert.equal(got, item[1], item[0] + ' 应识别为 ' + item[1] + '，实际 ' + got);
  }
});

test('★★★★★ Gemini 关不掉思考的型号要拦住（否则点了关闭等于没关）', () => {
  /*
   * 官方原文："Reasoning cannot be turned off for Gemini 2.5 Pro or 3 models"。
   *
   * 而这些型号对 `reasoning_effort: 'none'` **不报错、直接忽略** ——
   * 那正是"假关闭"：界面说关了，模型还在想。
   *
   * 所以必须靠 `forcedThinking` 拦住，走"降级到限长"那条路。
   */
  const g = profileById('gemini');
  for (const model of ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.1-pro-preview']) {
    assert.equal(isForcedThinking(g, model), true, model + ' 应判为强制思考（官方说关不掉）');
  }
  /* 2.5 Flash 可以用 none 关，不该被拦 */
  assert.equal(isForcedThinking(g, 'gemini-2.5-flash'), false, 'gemini-2.5-flash 是可以关的');

  /* 降级后的注入体：on + 最轻档，绝不许出现 none（那个会被静默忽略） */
  const r = buildReasoningInjection(g, 'off', undefined, 'gemini-4-argon');
  assert.equal(r.degraded, true);
  assert.deepEqual(r.body, { reasoning_effort: 'minimal' });
  assert.notEqual(
    (r.body).reasoning_effort,
    'none',
    '对关不掉的型号发 none 等于假关闭',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑩ 「思考」与「思考长度」的关系（2026-11-07，用户要求说明）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 思考关闭后：长度对"可关的模型"无效，对"关不掉的"仍有效', () => {
  /*
   * 用户原话：
   *
   * > 思考和思考长度没有说明这两个选型的关系，思考关闭后思考长度是
   * > 有效还是无效这个没有说明。
   *
   * 三种情况必须分开：
   *
   * ```text
   *   关 + 可关      → budgetEffective = false（不想了，限长度没意义）
   *   关 + 关不掉    → budgetEffective = true （降级就是靠它，置灰等于剥夺控制权）
   *   自动 / 开      → budgetEffective = true
   * ```
   */
  /* ① 可关的模型 + 关 ⇒ 无效 */
  const qwenOff = previewReasoningPlan({
    source: 'custom',
    model: 'qwen3-max',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  assert.equal(qwenOff.budgetEffective, false, '思考关掉了，长度不该说"生效"');
  assert.match(qwenOff.budgetNote, /已关闭|不生效/, '要明说它现在不生效');

  /* ② 关不掉 + 关 ⇒ 仍有效（关键格） */
  const forced = previewReasoningPlan({
    source: 'custom',
    model: 'qwen3-max-thinking',
    customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    intent: 'off',
  });
  assert.equal(forced.plan.degraded, true);
  assert.equal(forced.budgetEffective, true, '降级时长度是唯一的控制手段，不能置灰');
  assert.match(forced.budgetNote, /关不掉|压短/, '要说清它现在承载了全部控制');

  /* ③ 开 / 自动 ⇒ 有效 */
  for (const intent of ['on', 'auto']) {
    const r = previewReasoningPlan({
      source: 'custom',
      model: 'qwen3-max',
      customUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      intent,
    });
    assert.equal(r.budgetEffective, true, intent + ' 时长度应有效');
    assert.ok(r.budgetNote.length > 0, intent + ' 时也要有一句说明');
  }
});

test('★★★★ 没有旋钮的厂商不给长度说明（不留空话）', () => {
  const r = previewReasoningPlan({
    source: 'custom',
    model: 'kimi-k2.6',
    customUrl: 'https://api.moonshot.cn/v1',
    intent: 'on',
  });
  assert.equal(r.budget, null, 'Kimi 没有旋钮');
  assert.equal(r.budgetEffective, false);
  assert.equal(r.budgetNote, '', '没有旋钮就不该有"长度"的说明文字');
});
