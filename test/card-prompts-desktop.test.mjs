/**
 * 「角色提示词」在卡片里的读写与比较（2026-11-17）。
 *
 * ## 这一层为什么要单独测
 *
 * 桌面端编辑器的「角色提示词」板块会读写 `data.extensions.tcs.prompts`。
 * 它与安卓端共用同一批纯函数（`writeCharacterPrompts` / `parseCharacterPrompts`），
 * 但**卡这一侧**的入口是本项目自己的（`card-prompts.ts`）。
 *
 * 三个真踩过的坑，每一个都只在这一层能测出来：
 *
 * ```text
 * ① 取错 extensions：卡顶层也有一个 extensions（V1 兼容副本）。
 *    取成 card.extensions 会读到另一份数据 —— 症状是"改这个角色，别的角色也变"。
 * ② 手写 { tcs: { prompts } }：会把 tcs.cardId 抹掉 ——
 *    那会让这张卡在服务端变成另一张卡。
 * ③ 用 JSON.stringify 判"有没有改"：键序一变就误判为"改了"，
 *    症状是"点开又收起也被标成未保存"。
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

import {
  hasPromptChanges,
  promptLimitMessages,
  promptsWithinLimits,
  readCardPrompts,
  samePrompts,
  writePromptsIntoCard,
} from '../client/src/session/card-prompts.ts';
import {
  emptyCharacterPrompts,
  setCharacterPromptEnabled,
  upsertOwnPrompt,
} from '../shared/dist/chat/index.js';
import { createEmptyCard } from '../shared/dist/index.js';

/** 造一张带角色提示词的卡（走真实的写回路径） */
function cardWithPrompts() {
  const base = createEmptyCard('威廉');
  let config = emptyCharacterPrompts();
  config = upsertOwnPrompt(config, {
    id: 'tcs-1',
    name: '方言',
    content: '说话带四川口音。',
    role: 'system',
    enabled: true,
    injection: { position: 1, depth: 4, order: 100 },
  });
  config = setCharacterPromptEnabled(config, 'main', false, true);
  return { card: writePromptsIntoCard(base, config), config };
}

/* ═══════════════════════════════════════════════════════════
   一、读
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 空卡读出来是空配置，不是 null', () => {
  /*
   * 返回 `CharacterPromptConfig`（非空对象）而不是 `null`，
   * 是为了让 UI 不用到处判空。`null` 只在 `parseCharacterPrompts` 那层。
   */
  const card = createEmptyCard('新卡');
  const config = readCardPrompts(card);
  assert.equal(hasPromptChanges(config), false, '空卡不该有改动');
  assert.deepEqual(config.own, []);
  assert.deepEqual(config.overrideOrder, {});
});

test('★★★★★ 取的是 data.extensions，不是卡顶层的 extensions', () => {
  /*
   * 卡顶层也有一个 `extensions`（V1 兼容副本，`stringifyStCard` 会镜像写它）。
   * 取错了会读到另一份 —— 而两份看起来都"有值"，
   * 症状是"改了这个角色、那个角色也变了"，排查代价极高。
   *
   * 构造一张"顶层 extensions 里放一份假配置"的卡：读出来必须是**data 侧**的。
   */
  const card = createEmptyCard('威廉');
  const poisoned = {
    ...card,
    /* 顶层放一个明显不同的配置（模拟 V1 副本或脏数据） */
    extensions: {
      tcs: {
        prompts: {
          version: 1,
          overrideOrder: {},
          own: [{ id: 'top-level', name: '顶层副本', content: '不该被读到', role: 'system', enabled: true }],
        },
      },
    },
  };
  const config = readCardPrompts(poisoned);
  assert.equal(config.own.length, 0, '读的必须是 data.extensions（顶层副本不许被读到）');
});

test('★★★★ 读得回写进去的东西', () => {
  const { config } = cardWithPrompts();
  const card = writePromptsIntoCard(createEmptyCard('威廉'), config);
  const back = readCardPrompts(card);
  assert.deepEqual(back, config, '写→读必须完全一致');
});

/* ═══════════════════════════════════════════════════════════
   二、写
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 写提示词不许抹掉同一命名空间下的其他键', () => {
  /*
   * `tcs.cardId` 是我们在用的另一个键（服务端按它认卡）。
   * 手写 `{ tcs: { prompts } }` 会把它整个覆盖掉 ——
   * 后果是这张卡在服务端变成**另一张卡**（多出一条新卡、历史对不上），
   * 而现象只是"同步那边多了一张卡"。
   */
  const base = createEmptyCard('威廉');
  const withCardId = {
    ...base,
    passthrough: {
      ...base.passthrough,
      data: { ...base.passthrough.data, extensions: { tcs: { cardId: 'abcdef123456' }, depth_prompt: { depth: 4 } } },
    },
  };
  const { config } = cardWithPrompts();
  const next = writePromptsIntoCard(withCardId, config);
  const ext = next.passthrough.data['extensions'];

  assert.deepEqual(
    (ext['tcs'])['cardId'],
    'abcdef123456',
    'tcs.cardId 必须保留',
  );
  assert.deepEqual(ext['depth_prompt'], { depth: 4 }, '别的工具的键必须保留（ST 的 depth_prompt）');
  assert.ok((ext['tcs'])['prompts'] !== undefined, '提示词也要写进去');
});

test('★★★★★ 清空后 tcs.prompts 要消失，但 tcs.cardId 还在', () => {
  const { card } = cardWithPrompts();
  const withId = {
    ...card,
    passthrough: {
      ...card.passthrough,
      data: {
        ...card.passthrough.data,
        extensions: {
          ...(card.passthrough.data['extensions']),
          tcs: {
            ...((card.passthrough.data['extensions'])['tcs']),
            cardId: 'abcdef123456',
          },
        },
      },
    },
  };
  const next = writePromptsIntoCard(withId, emptyCharacterPrompts());
  const ext = next.passthrough.data['extensions'];
  const tcs = ext['tcs'];

  assert.equal('prompts' in tcs, false, '空配置不该在卡里留空壳');
  assert.equal(tcs['cardId'], 'abcdef123456', 'cardId 必须留着');
});

test('★★★★ 不许改入参（返回新卡）', () => {
  /*
   * 会话层与 UI 都依赖"不可变"：旧引用要能安全地当作历史快照。
   * 原地改会让"撤销/多标签"这类将来的功能拿到被改过的旧值。
   */
  const { config } = cardWithPrompts();
  const base = createEmptyCard('威廉');
  const before = JSON.stringify(base.passthrough.data);
  writePromptsIntoCard(base, config);
  assert.equal(JSON.stringify(base.passthrough.data), before, '入参的 data 不许被改');
});

/* ═══════════════════════════════════════════════════════════
   三、比较（决定要不要置脏）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ overrideOrder 键序不同不算改动', () => {
  /*
   * 用 `JSON.stringify` 判等时，删一条再加一条会改变键序 ⇒ 误判为"改了"。
   * 症状：用户点开面板又收起，卡就被标成未保存。
   */
  const a = {
    version: 1,
    own: [],
    overrideOrder: { main: { enabled: false }, jailbreak: { enabled: false } },
  };
  const b = {
    version: 1,
    own: [],
    /* 键序反过来，内容一样 */
    overrideOrder: { jailbreak: { enabled: false }, main: { enabled: false } },
  };
  assert.equal(samePrompts(a, b), true, '键序不同但内容相同 ⇒ 视为没改');
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), '前提：stringify 确实不同（否则这条判据没意义）');
});

test('★★★★★ own 的顺序有意义（不许当成无序集合）', () => {
  /*
   * 同深度同排序时按数组序发送 —— 所以顺序变了就是真的变了。
   */
  const one = { id: 'tcs-1', name: 'A', content: 'a', role: 'system', enabled: true };
  const two = { id: 'tcs-2', name: 'B', content: 'b', role: 'system', enabled: true };
  const a = { version: 1, overrideOrder: {}, own: [one, two] };
  const b = { version: 1, overrideOrder: {}, own: [two, one] };
  assert.equal(samePrompts(a, b), false, 'own 顺序变了就算改了');
});

test('★★★★ 内容/开关/注入参数任一变化都要判为改了', () => {
  const base = {
    version: 1,
    overrideOrder: {},
    own: [{ id: 'tcs-1', name: 'n', content: 'c', role: 'system', enabled: true, injection: { position: 1, depth: 4, order: 100 } }],
  };
  const variants = [
    { ...base, own: [{ ...base.own[0], content: 'c2' }] },
    { ...base, own: [{ ...base.own[0], enabled: false }] },
    { ...base, own: [{ ...base.own[0], name: 'n2' }] },
    { ...base, own: [{ ...base.own[0], injection: { position: 1, depth: 6, order: 100 } }] },
    { ...base, own: [{ ...base.own[0], injection: { position: 1, depth: 4, order: 90 } }] },
  ];
  for (const [index, variant] of variants.entries()) {
    assert.equal(samePrompts(base, variant), false, `第 ${String(index + 1)} 种变化必须被识别`);
  }
  assert.equal(samePrompts(base, base), true, '同一份配置必须判等');
});

/* ═══════════════════════════════════════════════════════════
   四、上限（与安卓端同一套）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 上限判定与安卓端同一套规则（不许桌面端放宽）', () => {
  /*
   * 桌面端若放宽，会出现"桌面端能存、手机上打不开"——
   * 用户完全无从理解。所以这里钉的是"调的是同一个函数"的**结果**：
   * 超 20 条必须被拒，且文案里带具体数字。
   */
  let config = emptyCharacterPrompts();
  for (let i = 1; i <= 21; i += 1) {
    config = upsertOwnPrompt(config, {
      id: `tcs-${String(i)}`,
      name: `第${String(i)}条`,
      content: '内容',
      role: 'system',
      enabled: true,
    });
  }
  assert.equal(promptsWithinLimits(config), false, '超 20 条必须判超限');
  const messages = promptLimitMessages(config);
  assert.ok(messages.length >= 1, '要给出原因');
  assert.match(messages[0], /21/, '要说出实际条数');
  assert.match(messages[0], /20/, '要说出上限');
});

test('★★★ 正常配置在上限内', () => {
  const { config } = cardWithPrompts();
  assert.equal(promptsWithinLimits(config), true);
  assert.deepEqual(promptLimitMessages(config), []);
});

/* ═══════════════════════════════════════════════════════════
   五、跨卡隔离（草稿不许串卡）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 切卡时清草稿（面板 refresh 必须清 pending）', () => {
  /*
   * 场景：在 A 卡点「新增」留一个空草稿 → 切到 B 卡。
   *
   * 不清的话那个草稿会挂在 B 卡下面显示，用户以为 B 卡也有一条，
   * 写完正文就**真的写进了 B 卡**。这是"状态串卡" ——
   * 本项目最忌讳的一类缺陷（多标签并行的核心难点就在状态隔离）。
   *
   * 这条只能读源码钉：`pending` 是闭包里的数组，外部拿不到。
   * 所以钉的是"refresh 的第一件事是清空它"。
   */
  const panel = readFileSync(join(ROOT, 'client/src/editor/prompts-panel.ts'), 'utf8');
  const at = panel.indexOf('refresh: () => {');
  assert.ok(at > 0, '找不到 refresh 实现');
  const body = panel.slice(at, at + 400);
  assert.match(body, /pending\.length = 0/, 'refresh 必须先清空草稿数组');
  const clearAt = body.indexOf('pending.length = 0');
  const paintAt = body.indexOf('paint()');
  assert.ok(clearAt >= 0 && paintAt > clearAt, '先清草稿、再重画（顺序反了会画出一帧旧草稿）');
});
