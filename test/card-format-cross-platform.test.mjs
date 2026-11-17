/**
 * 服务端 / 桌面端能否识别安卓端导出的新格式卡（2026-11-17）。
 *
 * ## 用户的问题
 *
 * > 服务端和桌面端是否可以识别安卓端导出的新格式的卡？不能请加上
 *
 * "新格式" = 安卓端 v0.2.0 起写进 `data.extensions.tcs.prompts` 的
 * **角色级提示词**（角色专属条目 + 开关/正文覆盖）。
 *
 * ## 这个文件钉两层，缺一不可
 *
 * ```text
 * ① 存储保真（不丢）  服务端字节原样入库、桌面端 stringifyStCard 原样带出
 * ② 识别（看得见）    审计读得出它、报得出"这卡带了什么"
 * ```
 *
 * 只做 ① 不做 ② 的后果：卡传来传去一个字节都没少，但用户在任何一端
 * 都看不到"这卡带了 3 条专属提示词"—— 换设备排障时完全不知道
 * 还有这一层在影响模型输出。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildAuditReport,
  buildPngCard,
  parsePngCard,
  parseStCardText,
  stringifyStCard,
} from '../shared/dist/index.js';
import {
  emptyCharacterPrompts,
  parseCharacterPrompts,
  setCharacterPromptEnabled,
  upsertOwnPrompt,
  writeCharacterPrompts,
} from '../shared/dist/chat/index.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BARE = new Uint8Array(readFileSync(join(ROOT, 'test/fixtures/png/fixture-v2.png')));

/**
 * 造一张"安卓端导出的新格式卡"：真卡 + 角色专属提示词 + 一处开关覆盖。
 *
 * 走的是**安卓端真实的三步**（`writeCharacterPrompts` → `stringifyStCard`
 * → `buildPngCard`），不是在测试里手搓一个形状 —— 手搓的形状可能与
 * 真实产物不一致，那样判据测的是我的想象。
 */
function makeExportedCard() {
  const parsed = parsePngCard(BARE);
  assert.equal(parsed.kind, 'card', 'fixture 应当是一张卡');
  const card = parseStCardText(parsed.jsonText).card;

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

  const prev = card.passthrough.data['extensions'];
  const extensions = writeCharacterPrompts(
    prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : null,
    config,
  );
  const updated = {
    ...card,
    passthrough: { ...card.passthrough, data: { ...card.passthrough.data, extensions } },
  };
  const png = buildPngCard(
    BARE,
    stringifyStCard(updated, { indent: 2, entryTitleToComment: true }),
    'v2',
  );
  return { png, card: updated };
}

/* ═══════════════════════════════════════════════════════════
   一、存储保真（服务端 / 桌面端都不许弄丢）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 桌面端保存（stringifyStCard）不丢 extensions.tcs.prompts', () => {
  /*
   * 桌面端编辑器的保存走 `stringifyStCard`，而它对 `data.extensions`
   * 是**整体原样带出**（`cloneJson(extensions)`）—— 这条判据把这个
   * 行为钉住，防止将来有人"清理未知字段"把这一层顺手删掉。
   *
   * 为什么会有人想删：`tcs.prompts` 是我们自己的键，看起来像"内部状态"。
   * 但它已经是**卡的一部分**（跨设备同步的载体），删了等于丢用户配置。
   */
  const { card } = makeExportedCard();
  const json = stringifyStCard(card, { indent: 2, entryTitleToComment: true });
  const back = parseCharacterPrompts(JSON.parse(json).data.extensions);

  assert.notEqual(back, null, '桌面端序列化后应当还能读出角色提示词');
  assert.equal(back.own.length, 1, '专属条目要还在');
  assert.equal(back.own[0].name, '方言');
  assert.deepEqual(back.overrideOrder.main, { enabled: false }, '开关覆盖要还在');
});

test('★★★★★ 服务端入库字节 = 上传字节（不解析重写）', () => {
  /*
   * 服务端的不变量是"入库字节 = 上传字节"（`server/src/storage/cards.ts` 顶部
   * 第 1 条）。它天生保真 —— 但也正因为它是**约定**而不是类型保证，
   * 必须用判据守住：任何人往上传路径里塞一句 `stringifyStCard` 就破坏它。
   *
   * 这里同时钉两件事：
   * ```text
   * ① 上传的那份字节里确实有 tcs.prompts（别测了个空卡）
   * ② 从字节能完整读回（服务端回给客户端的也是这份字节）
   * ```
   */
  const { png } = makeExportedCard();
  const bytes = Buffer.from(png);

  /* ① 字节里真的带着它 */
  const fromBytes = parsePngCard(new Uint8Array(bytes));
  assert.equal(fromBytes.kind, 'card');
  const config = parseCharacterPrompts(
    parseStCardText(fromBytes.jsonText).card.passthrough.data['extensions'],
  );
  assert.notEqual(config, null);
  assert.equal(config.own.length, 1);

  /* ② 服务端代码里不许在上传路径上重写字节 */
  const service = stripComments(read('server/src/storage/cards.ts'));
  const commitAt = service.indexOf('private async commitSnapshot');
  assert.ok(commitAt > 0, '找不到 commitSnapshot');
  const commit = service.slice(commitAt, commitAt + 2400);
  assert.match(commit, /this\.blobs\.put\(input\.bytes\)/, 'blob 必须直接写上传字节');
  assert.doesNotMatch(commit, /stringifyStCard/, '不许在上传路径上重新序列化');
});

test('★★★★ 桌面端编辑器保存路径不重建 extensions', () => {
  /*
   * `stringifyStCard` 里那句是唯一合法的来源：
   *   const extensions = card.passthrough.data['extensions'] ?? {}
   *   data['extensions'] = cloneJson(extensions)
   *
   * 如果哪天改成"只写已知的 tcs.cardId"，`tcs.prompts` 就没了 ——
   * 而表现是"桌面端保存一次，角色提示词消失"，极难联想到序列化。
   */
  const io = stripComments(read('shared/src/format/sillytavern-io.ts'));
  assert.match(
    io,
    /data\['extensions'\] = cloneJson\(extensions\)/,
    'extensions 必须整体原样带出（不能只挑已知键）',
  );
  /* `extensions` 也不在"由模型接管"的键表里（那样会被重建成空对象） */
  const modeled = io.slice(io.indexOf('const DATA_MODELED_KEYS'), io.indexOf('const V1_MODELED_KEYS'));
  assert.doesNotMatch(modeled, /'extensions'/, 'extensions 不许进 DATA_MODELED_KEYS');
});

/* ═══════════════════════════════════════════════════════════
   二、识别（审计看得见）
   ═══════════════════════════════════════════════════════════ */

/** 只看本功能产生的条目，避免被别的规则干扰 */
const promptIssues = (report) =>
  report.issues.filter((one) => one.ruleId.startsWith('builtin:character-prompts'));

test('★★★★★ 审计能报出"这卡带了什么"（服务端与桌面端共用这一条）', () => {
  /*
   * `buildAuditReport` 是**唯一**的审计入口：
   * 服务端 `server/src/audit/service.ts` 用它，桌面端 `client/src/editor/app.ts` 也用它。
   * 所以这一处改动两端同时生效 —— 判据钉的就是这个性质。
   */
  const { card } = makeExportedCard();
  const report = buildAuditReport(card, {});

  const hit = promptIssues(report);
  const summary = hit.find((one) => one.ruleId === 'builtin:character-prompts');
  assert.ok(summary !== undefined, '要有一条汇总');
  assert.equal(summary.severity, 'info', '正常配置只该是 info（不阻断导出）');
  assert.match(summary.message, /1 条专属提示词/, '要说清专属条目数');
  assert.match(summary.message, /1 处开关\/正文覆盖/, '要说清覆盖处数');
  /*
   * hint 必须讲清"别的工具会忽略它" —— 这是扩展键的固有代价，
   * 不说的话用户导进 ST 网页发现不生效会以为是我们坏了。
   */
  assert.match(summary.hint ?? '', /其他工具/, 'hint 要提醒别的工具会忽略');
});

test('★★★★★ 没有这个键的卡：一个字都不该多报', () => {
  /*
   * 绝大多数卡没有这一层。多报一条 info 会让"审计信息数"整体偏移，
   * 而用户会开始忽略 info（真出问题时就不看了）。
   */
  const parsed = parsePngCard(BARE);
  const card = parseStCardText(parsed.jsonText).card;
  const report = buildAuditReport(card, {});
  assert.deepEqual(promptIssues(report), [], '没配过的卡不该有任何 character-prompts 条目');
});

test('★★★★★ 有键但读不出来 → warning（不是静默忽略）', () => {
  /*
   * 这是"存了但坏了"的情况 —— 与"没存过"必须分开：
   * 前者说明卡里有一段无意义数据，后者是正常的。
   *
   * 静默忽略的后果：用户以为提示词同步过去了，实际两端都读不到。
   */
  const parsed = parsePngCard(BARE);
  const card = parseStCardText(parsed.jsonText).card;
  const broken = {
    ...card,
    passthrough: {
      ...card.passthrough,
      data: { ...card.passthrough.data, extensions: { tcs: { prompts: 'not-an-object' } } },
    },
  };
  const report = buildAuditReport(broken, {});
  const hit = promptIssues(report);

  assert.equal(hit.length, 1, '坏形状只报一条');
  assert.equal(hit[0].ruleId, 'builtin:character-prompts-malformed');
  assert.equal(hit[0].severity, 'warning');
  assert.match(hit[0].message, /读不出任何一条/);
});

test('★★★★★ 超上限 → error（与 App 保存校验同一套规则）', () => {
  /*
   * 超限的卡在 App 里**保存会被拒绝**。这种卡只可能来自"别的工具硬写"
   * 或"旧版本写的"。它在别处仍然能用，但用户从仓库下载回来一改就会撞上
   * 保存失败 —— 审计里提前喊，比让他改到一半才发现好。
   *
   * ★ 上限值不在这里写死：直接读 `validateCharacterPrompts` 的结果，
   *   保证"审计说没问题 ⇔ App 让保存"永远等价。
   */
  const parsed = parsePngCard(BARE);
  const card = parseStCardText(parsed.jsonText).card;

  let config = emptyCharacterPrompts();
  /* 21 条：比 ownCount(20) 多一条 —— 从常量读不出这个数，所以直接用 validate 的结果判 */
  for (let i = 1; i <= 21; i += 1) {
    config = upsertOwnPrompt(config, {
      id: `tcs-${String(i)}`,
      name: `第${String(i)}条`,
      content: '内容',
      role: 'system',
      enabled: true,
    });
  }

  const over = {
    ...card,
    passthrough: {
      ...card.passthrough,
      data: {
        ...card.passthrough.data,
        extensions: writeCharacterPrompts(card.passthrough.data['extensions'], config),
      },
    },
  };
  const report = buildAuditReport(over, {});
  const errors = promptIssues(report).filter((one) => one.severity === 'error');

  assert.ok(errors.length >= 1, '超条数要报 error');
  assert.ok(
    errors.some((one) => one.ruleId === 'builtin:character-prompts-ownCount'),
    '要给明确的 ruleId（便于界面分级显示）',
  );
  assert.equal(report.summary.exportable, false, '有 error 就不该 exportable');
});

/* ═══════════════════════════════════════════════════════════
   三、依赖方向（防止将来成环）
   ═══════════════════════════════════════════════════════════ */

test('★★★ audit → chat 是单向依赖（chat 不许反过来 import audit）', () => {
  /*
   * `audit/format.ts` 现在 import 了 `chat/character-prompts.js`。
   * 这条判据钉住反方向不存在 —— 否则会成环，而 ESM 环的报错
   * 往往表现为"某个函数是 undefined"，与真正的原因离得很远。
   */
  const chat = stripComments(read('shared/src/chat/character-prompts.ts'));
  assert.doesNotMatch(chat, /from '\.\.\/audit/, 'chat 不许 import audit');
  assert.doesNotMatch(chat, /from '\.\.\/format\/sillytavern-io/, 'chat 也不许依赖 format 层');
});
