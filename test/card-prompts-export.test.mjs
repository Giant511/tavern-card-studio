/**
 * 角色提示词在**所有导出路径**上都要带出去（2026-11-17）。
 *
 * ## 为什么单独一个文件
 *
 * `card-prompts-desktop.test.mjs` 验的是"卡的内存状态对不对"。
 * 而用户真正拿到手的是**产物**，桌面端有三条产出路径：
 *
 * ```text
 *   ① 保存到磁盘（saveSessionToDisk → buildExportAsync）
 *   ② 导出 JSON（buildJsonExport）
 *   ③ 导出 PNG（buildPngExport，把 JSON 嵌进图里）
 * ```
 *
 * 三条都走 `buildExportAsync` → `serializeStCard`，所以"应该"都带着。
 * 但"应该"不是判据 —— 本项目已经因为"推演代替实测"错过好几次
 * （§151 我一开始就误判成导出丢字段，真因在另一处）。
 *
 * 所以这里**真的跑那三条函数**，再**真的把产物读回来**。
 *
 * ## 判据的形状
 *
 * ```text
 *   不是断言"调用了 serializeStCard"（那是钉实现）
 *   而是断言"产物里读得出那几条提示词"（那是钉结果）
 * ```
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildJsonExport, buildPngExport } from '../client/src/export/export-card.ts';
import { serializeCard } from '../client/src/editor/block-doc.ts';
import { writePromptsIntoCard } from '../client/src/session/card-prompts.ts';
import {
  emptyCharacterPrompts,
  parseCharacterPrompts,
  setCharacterPromptContent,
  setCharacterPromptEnabled,
  upsertOwnPrompt,
} from '../shared/dist/chat/index.js';
import { createEmptyCard, parsePngCard, parseStCard } from '../shared/dist/index.js';
import { readCardPrompts } from '../client/src/session/card-prompts.ts';

const ROOT = join(import.meta.dirname, '..');
const FACE = new Uint8Array(readFileSync(join(ROOT, 'test/fixtures/png/fixture-bare.png')));

/**
 * 造一张"桌面端改过提示词"的卡。
 *
 * 三种改动一起上，因为它们走的是三个不同的写入函数：
 * ```text
 *   own         upsertOwnPrompt
 *   enabled     setCharacterPromptEnabled
 *   content     setCharacterPromptContent（只允许 main/nsfw/jailbreak）
 * ```
 * 只测 own 会漏掉"覆盖那条路根本没接上"这种缺陷。
 */
function cardWithPrompts() {
  let config = emptyCharacterPrompts();
  config = upsertOwnPrompt(config, {
    id: 'tcs-1',
    name: '方言',
    content: '说话带点四川口音。',
    role: 'system',
    enabled: true,
    injection: { position: 1, depth: 4, order: 100 },
  });
  config = setCharacterPromptEnabled(config, 'main', false, true);
  const withContent = setCharacterPromptContent(config, 'jailbreak', '这个角色别啰嗦。', '全局越狱词', false);
  assert.equal(withContent.ok, true, '非标记位改正文应当成功');
  return writePromptsIntoCard(createEmptyCard('威廉'), withContent.config);
}

/** 从任意一段卡 JSON 文本里取角色提示词 */
function promptsFromJsonText(text) {
  const parsed = parseCharacterPrompts(JSON.parse(text).data.extensions);
  assert.notEqual(parsed, null, '产物里应当能读出角色提示词');
  return parsed;
}

/* ═══════════════════════════════════════════════════════════
   一、三条产物路径
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 导出 JSON 带着三条改动（专属 + 开关覆盖 + 正文覆盖）', () => {
  const card = cardWithPrompts();
  const artifact = buildJsonExport(card, null);
  const prompts = promptsFromJsonText(artifact.text);

  assert.equal(prompts.own.length, 1, '专属条目要带出去');
  assert.equal(prompts.own[0].name, '方言');
  assert.equal(prompts.own[0].content, '说话带点四川口音。');
  assert.deepEqual(prompts.own[0].injection, { position: 1, depth: 4, order: 100 }, '注入参数要带出去');
  assert.deepEqual(prompts.overrideOrder.main, { enabled: false }, '开关覆盖要带出去');
  assert.equal(prompts.overrideOrder.jailbreak.content, '这个角色别啰嗦。', '正文覆盖要带出去');
});

test('★★★★★ 导出 PNG 里的 JSON 也带着（嵌进图里那份）', () => {
  /*
   * 这条是我上一轮**漏掉**的：端到端只验了 `buildExportForTest('json')`，
   * 而用户实际最常用的是 PNG（那是 ST 认的卡格式）。
   *
   * PNG 导出与 JSON 导出共用 `serializeStCard`，但"共用"是代码事实、
   * 不是我该假设的东西 —— 真解出来读一遍才算验过。
   */
  const card = cardWithPrompts();
  const artifact = buildPngExport(card, null, FACE);

  const reread = parsePngCard(artifact.png);
  assert.equal(reread.kind, 'card', '导出的 PNG 应当能读回一张卡');
  const prompts = promptsFromJsonText(reread.jsonText);

  assert.equal(prompts.own.length, 1, 'PNG 里也要有专属条目');
  assert.deepEqual(prompts.overrideOrder.main, { enabled: false }, 'PNG 里也要有开关覆盖');
  assert.equal(prompts.overrideOrder.jailbreak.content, '这个角色别啰嗦。', 'PNG 里也要有正文覆盖');
});

test('★★★★★ 保存到磁盘用的序列化也带着（serializeCard）', () => {
  /*
   * 「保存」与「导出」是两条不同的入口，但底层序列化各有各的函数：
   * ```text
   *   保存   serializeCard     （block-doc.ts，无预设参数）
   *   导出   serializeStCard   （export-card.ts，带预设对齐参数）
   * ```
   * 两条都要验：只验一条的话，另一条哪天改成"重建 extensions"就没人发现。
   */
  const card = cardWithPrompts();
  const prompts = promptsFromJsonText(serializeCard(card));

  assert.equal(prompts.own.length, 1, '保存到磁盘的 JSON 里也要有');
  assert.deepEqual(prompts.overrideOrder.main, { enabled: false });
});

/* ═══════════════════════════════════════════════════════════
   二、不许破坏别的键（导出路径同样是"写卡"）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 三条路径都要保住 tcs.cardId 与别的工具的键', () => {
  /*
   * 导出会把整张卡重新序列化一遍。如果哪天有人"顺手清理未知字段"，
   * 用户导出一次就永久丢了 `tcs.cardId`（服务端认不出这张卡了）
   * 和 ST 的 `depth_prompt`（角色的深度提示词）。
   *
   * 三个产物都验，因为它们是三段独立的代码。
   */
  const base = cardWithPrompts();
  const card = {
    ...base,
    passthrough: {
      ...base.passthrough,
      data: {
        ...base.passthrough.data,
        extensions: {
          ...base.passthrough.data['extensions'],
          tcs: {
            ...base.passthrough.data['extensions']['tcs'],
            cardId: 'abcdef123456',
          },
          depth_prompt: { prompt: '保持安静。', depth: 4, role: 'system' },
        },
      },
    },
  };

  const check = (label, text) => {
    const ext = JSON.parse(text).data.extensions;
    assert.equal(ext.tcs.cardId, 'abcdef123456', `${label}：tcs.cardId 必须保留`);
    assert.deepEqual(ext.depth_prompt, { prompt: '保持安静。', depth: 4, role: 'system' }, `${label}：depth_prompt 必须保留`);
  };

  check('导出 JSON', buildJsonExport(card, null).text);
  check('保存序列化', serializeCard(card));
  const png = buildPngExport(card, null, FACE);
  const reread = parsePngCard(png.png);
  assert.equal(reread.kind, 'card');
  check('导出 PNG', reread.jsonText);
});

/* ═══════════════════════════════════════════════════════════
   三、没配过的卡不受影响（回归）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 没配过提示词的卡：三条产物里都不该凭空多出 tcs.prompts', () => {
  /*
   * 这一层是"我们自己的扩展键"，用户没配过就不该出现在他的卡里 ——
   * 否则拿去给别人的工具用会多出一堆看不懂的东西。
   */
  const card = createEmptyCard('新卡');

  const json = JSON.parse(buildJsonExport(card, null).text);
  const tcs = json.data.extensions === undefined ? undefined : json.data.extensions.tcs;
  assert.equal(tcs === undefined || tcs.prompts === undefined, true, '导出 JSON 里不该有 prompts');

  const saved = JSON.parse(serializeCard(card));
  const savedTcs = saved.data.extensions === undefined ? undefined : saved.data.extensions.tcs;
  assert.equal(savedTcs === undefined || savedTcs.prompts === undefined, true, '保存序列化里不该有 prompts');

  const png = buildPngExport(card, null, FACE);
  const reread = parsePngCard(png.png);
  assert.equal(reread.kind, 'card');
  assert.equal(parseCharacterPrompts(JSON.parse(reread.jsonText).data.extensions), null, 'PNG 里不该有 prompts');
});

test('★★★★ 清空后重新导出：键消失，不留空壳', () => {
  const card = cardWithPrompts();
  /* 用空配置覆盖（相当于用户点了「恢复卡片默认」） */
  const reset = writePromptsIntoCard(card, emptyCharacterPrompts());
  const json = JSON.parse(buildJsonExport(reset, null).text);
  const tcs = json.data.extensions === undefined ? undefined : json.data.extensions.tcs;
  assert.equal(tcs === undefined || tcs.prompts === undefined, true, '清空后导出不该留空壳');
});

/* ═══════════════════════════════════════════════════════════
   四、闭环：导出 → 用「打开」的解析路径读回
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 闭环：导出 PNG → parseStCard 读回 → 提示词还在', () => {
  /*
   * 用户的实际动作是「改完 → 保存/导出 → 关掉 → 再打开」。
   * 前三节验的是"产物里有"，这一节验的是**产物走回打开路径之后还能被读到**。
   *
   * 为什么要单独一条：`buildPngExport` 与 `parseStCard` 是两个方向的代码，
   * 各自绿不代表接得上。而"存了但打不开"正是本项目最费时间的一类
   * （§151 那次我也先怀疑过这一层）。
   *
   * ★ 用**真实的打开路径**：`parsePngCard` 取 jsonText → `parseStCard`
   *   转 UnifiedCard → `readCardPrompts` 读。与 `openPngCard` 同一串调用。
   */
  const card = cardWithPrompts();
  const png = buildPngExport(card, null, FACE).png;

  /* openPngCard 的第一步：解 PNG 取 JSON */
  const inspected = parsePngCard(png);
  assert.equal(inspected.kind, 'card', '有一张真卡');

  /* openPngCard 的第二步：转成 UnifiedCard */
  const reopened = parseStCard(inspected.jsonText);
  const prompts = readCardPrompts(reopened.card);

  assert.equal(prompts.own.length, 1, '重新打开后专属条目还在');
  assert.equal(prompts.own[0].name, '方言');
  assert.equal(prompts.own[0].content, '说话带点四川口音。');
  assert.deepEqual(prompts.own[0].injection, { position: 1, depth: 4, order: 100 }, '深度等参数不许被读丢');
  assert.deepEqual(prompts.overrideOrder.main, { enabled: false }, '开关覆盖还在');
  assert.equal(prompts.overrideOrder.jailbreak.content, '这个角色别啰嗦。', '正文覆盖还在');

  /* 再导出一次：往返两轮内容不许漂移 */
  const again = buildPngExport(reopened.card, null, FACE).png;
  const second = parsePngCard(again);
  assert.equal(second.kind, 'card');
  const twice = readCardPrompts(parseStCard(second.jsonText).card);
  assert.deepEqual(twice, prompts, '导出→打开→再导出，内容必须完全一致');
});
