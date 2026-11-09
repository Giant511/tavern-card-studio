/**
 * 提示词编辑/新增/删除的判据（2026-11-07）。
 *
 * 用户要求：「AI响应中提示词管理中增加自定义编辑和增加提示词的功能，和原生ST一样」。
 *
 * 这一批的核心风险不是"按钮没画出来"，而是**写回时把用户的其他字段弄丢**。
 * 所以下面大半篇幅在验"没动的字段还在"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPrompt,
  updatePrompt,
  deletePrompt,
  newPromptIdentifier,
  validateDraft,
  readInjectionTrigger,
  draftOf,
  NEW_PROMPT_DRAFT,
  parsePromptConfig,
} from '../shared/dist/chat/index.js';
import { parentRouteOf } from '../shared/dist/chat/nav.js';

/** 一份像真预设的 body：62 个键里挑几条关键的，外加一条带全部字段的提示词 */
function sampleBody() {
  return {
    /* 这些是"绝对不能被我们弄丢"的兄弟字段 */
    chat_completion_source: 'custom',
    temperature: 0.85,
    openai_model: 'gemini-4-argon',
    custom_url: 'https://relay.example.com/v1',
    max_tokens: 800,
    prompts: [
      {
        identifier: 'main',
        name: '主提示词',
        content: '你正在扮演 {{char}}',
        role: 'system',
        system_prompt: true,
        marker: false,
        injection_position: 0,
        injection_depth: 0,
        injection_order: 100,
        /* ★ 这两个字段 parsePromptConfig 不留 —— 它们正是"容易丢"的样板 */
        injection_trigger: [],
        forbid_overrides: false,
      },
      {
        identifier: 'my-rule',
        name: '消息回复规则',
        content: '对白用双引号',
        role: 'system',
        system_prompt: false,
        marker: false,
        injection_position: 0,
        injection_depth: 0,
        injection_order: 100,
        injection_trigger: ['continue'],
        forbid_overrides: true,
      },
      {
        identifier: 'chatHistory',
        name: '聊天历史',
        content: '',
        role: 'system',
        system_prompt: true,
        marker: true,
        injection_position: 1,
        injection_depth: 0,
        injection_order: 100,
        injection_trigger: [],
        forbid_overrides: false,
      },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'my-rule', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
      {
        character_id: 100001,
        order: [{ identifier: 'main', enabled: true }],
      },
    ],
  };
}

/* ═══════════════════════════════════════════════════════════
   ① 编辑：只改该改的，其余一个都不许丢
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 编辑提示词不许丢掉 injection_trigger / forbid_overrides', () => {
  /*
   * 这两个字段 `parsePromptConfig` **不解析**，所以很容易在写回时被抹掉。
   *
   * 后果不是"少一个字段"，而是行为变了：
   *   injection_trigger: ['continue'] 被抹成 [] ⇒ 这条从"只在续写时发"
   *   变成"每次都发"。用户会觉得模型忽然开始乱说话，而完全查不到原因。
   */
  const body = sampleBody();
  const r = updatePrompt(body, 'my-rule', {
    ...NEW_PROMPT_DRAFT,
    name: '消息回复规则（改过）',
    content: '对白用中文双引号',
  });
  assert.equal(r.ok, true);
  const next = r.body;
  const entry = next.prompts.find((one) => one.identifier === 'my-rule');
  assert.equal(entry.name, '消息回复规则（改过）');
  assert.equal(entry.content, '对白用中文双引号');
  /* ★ 保留 */
  assert.deepEqual(entry.injection_trigger, ['continue'], 'injection_trigger 被抹掉了');
  assert.equal(entry.forbid_overrides, true, 'forbid_overrides 被抹掉了');
});

test('★★★★★ 编辑不许碰兄弟字段（模型名 / 温度 / 地址）', () => {
  /*
   * 写回是**整份预设**。少传一个键 ST 就当成删除 ——
   * 用户的模型名、温度、自定义地址会一起消失。
   */
  const body = sampleBody();
  const r = updatePrompt(body, 'my-rule', { ...NEW_PROMPT_DRAFT, name: 'x', content: 'y' });
  assert.equal(r.ok, true);
  assert.equal(r.body.temperature, 0.85);
  assert.equal(r.body.openai_model, 'gemini-4-argon');
  assert.equal(r.body.custom_url, 'https://relay.example.com/v1');
  assert.equal(r.body.max_tokens, 800);
});

test('★★★★ 内容没变时 changed = false（省一次整份上传）', () => {
  const body = sampleBody();
  const config = parsePromptConfig(body);
  const prompt = config.prompts.find((one) => one.identifier === 'my-rule');
  const r = updatePrompt(body, 'my-rule', draftOf(prompt));
  assert.equal(r.ok, true);
  assert.equal(r.changed, false, '原样保存不该触发写盘');
});

/* ═══════════════════════════════════════════════════════════
   ② 新建：必须同时进 prompts 和**每一份** order
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 新建要同时进 prompts 与每一份 prompt_order', () => {
  /*
   * 只进 prompts 的后果：解析时它"不在顺序表里"⇒ 被忽略 ⇒
   * 用户看到的是"我加了，但没生效"。而开关在列表里明明显示为开。
   */
  const body = sampleBody();
  const id = 'tcs-test-1';
  const r = createPrompt(body, { ...NEW_PROMPT_DRAFT, name: '防全知', content: '不要知道未来' }, id);
  assert.equal(r.ok, true);
  const next = r.body;

  assert.equal(next.prompts.length, 4);
  const added = next.prompts.find((one) => one.identifier === id);
  assert.ok(added !== undefined, '新条目要进 prompts');
  assert.equal(added.name, '防全知');
  /* ST 的 Prompt 构造器要求的键都要给全 */
  assert.equal(added.marker, false);
  assert.equal(added.system_prompt, false);
  assert.deepEqual(added.injection_trigger, []);
  assert.equal(added.forbid_overrides, false);

  /* 每一份 order 都要有它，且默认开启 */
  assert.equal(next.prompt_order.length, 2);
  for (const order of next.prompt_order) {
    const row = order.order.find((one) => one.identifier === id);
    assert.ok(row !== undefined, `character_id=${order.character_id} 的 order 里没有新条目`);
    assert.equal(row.enabled, true);
  }

  /* 而且它真的会被解析进"启用"集合 */
  const config = parsePromptConfig(next);
  const rows = config.order.filter((one) => one.identifier === id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
});

test('★★★★ 新建时新行加在末尾，不打乱用户原有顺序', () => {
  const body = sampleBody();
  const id = 'tcs-test-2';
  const r = createPrompt(body, NEW_PROMPT_DRAFT, id);
  assert.equal(r.ok, true);
  const order = r.body.prompt_order[0].order;
  assert.deepEqual(
    order.map((one) => one.identifier),
    ['main', 'my-rule', 'chatHistory', id],
  );
});

test('★★★★★ 新 identifier 不能撞车（同一毫秒建两条也不行）', () => {
  /*
   * identifier 是 ST 的主键。撞车的后果是后者覆盖前者 ——
   * 表现为"我加了两条，只看到一条"，极难联想到主键冲突。
   */
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(newPromptIdentifier());
  assert.equal(ids.size, 200, '200 次生成必须全不重复');
  for (const id of ids) assert.match(id, /^tcs-/, '必须带 tcs- 前缀，避免与 ST 自己的 uuid 撞');

  /*
   * ★★★ 上面那 200 次循环**抓不住"用时间戳"的实现**（变异验证实测）：
   *   循环跑得比毫秒快，`Date.now()` 在同一毫秒内会撞 —— 但 200 次
   *   正好跨了好几个毫秒，撞车概率低到测不出来。
   *
   * 所以要把"同一毫秒"造出来：冻结 `Date.now`，让它每次返回同一个值。
   * 这时唯一能保证不重复的只有随机数 / uuid。
   */
  const realNow = Date.now;
  const frozen = 1_700_000_000_000;
  Date.now = () => frozen;
  try {
    const sameMs = new Set();
    for (let i = 0; i < 50; i += 1) sameMs.add(newPromptIdentifier());
    assert.equal(
      sameMs.size,
      50,
      '同一毫秒内 50 次生成必须全不重复（用时间戳当 id 会撞车）',
    );
  } finally {
    Date.now = realNow;
  }
});

/* ═══════════════════════════════════════════════════════════
   ③ 删除：内置槽位不许删，引用要清干净
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 内置槽位（marker）不许删', () => {
  /*
   * 删掉 marker 项不会"少发一段"，而是让拼装时找不到内容来源 ——
   * 角色完全不像、甚至请求结构坏掉。用户只会觉得"模型抽风了"。
   */
  const body = sampleBody();
  const r = deletePrompt(body, 'chatHistory');
  assert.equal(r.ok, false);
  assert.match(r.reason, /内置槽位|不能删/);
});

test('★★★★★ 删除要清掉所有 order 里的引用', () => {
  /*
   * 留着引用的话 `parsePromptConfig` 会报"顺序表里有 N 项找不到"。
   * 它只是跳过，不算致命 —— 但用户每次进页面都看到一句警告，
   * 而他自己刚删过、没法消除。
   */
  const body = sampleBody();
  const r = deletePrompt(body, 'my-rule');
  assert.equal(r.ok, true);
  assert.equal(r.body.prompts.length, 2);
  for (const order of r.body.prompt_order) {
    assert.equal(
      order.order.some((one) => one.identifier === 'my-rule'),
      false,
      'order 里还留着已删条目的引用',
    );
  }
  /* 而且不再产生警告 */
  const config = parsePromptConfig(r.body);
  assert.deepEqual(config.warnings, []);
});

/* ═══════════════════════════════════════════════════════════
   ④ 校验与只读触发器
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 空正文要拦住（发出去是空的，等于白加一条）', () => {
  assert.notEqual(validateDraft({ ...NEW_PROMPT_DRAFT, content: '   ' }), null);
  assert.equal(validateDraft({ ...NEW_PROMPT_DRAFT, content: '有内容' }), null);
  /* 名字空**不算错**：ST 允许，列表会用 identifier 兜底 */
  assert.equal(validateDraft({ ...NEW_PROMPT_DRAFT, name: '', content: 'x' }), null);
  /* 深度不能是负数 */
  assert.notEqual(validateDraft({ ...NEW_PROMPT_DRAFT, content: 'x', injectionDepth: -1 }), null);
});

test('★★★★ 触发器从原始体读出来（parsePromptConfig 不留这个字段）', () => {
  const body = sampleBody();
  assert.deepEqual(readInjectionTrigger(body, 'my-rule'), ['continue']);
  assert.deepEqual(readInjectionTrigger(body, 'main'), []);
  assert.deepEqual(readInjectionTrigger(body, '不存在'), []);
});

test('★★★★ 编辑页的层级：上一级是提示词列表，不是 AI 响应配置', () => {
  /*
   * 这一条踩过一次：`prompts` 当初写成 `'menu'`，用户点返回直接退了三级。
   * 新版加页面时最容易漏的就是这个 —— 漏了会落到默认的 `'menu'`。
   */
  assert.equal(parentRouteOf('promptEdit'), 'prompts');
  assert.equal(parentRouteOf('prompts'), 'sampling');
});
