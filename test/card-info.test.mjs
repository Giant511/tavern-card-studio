/**
 * 卡片级信息（v0.1.6 / 用户反馈「导出的 creator_notes 还是示例卡的话」）。
 *
 * 这一层的性质决定了测试该盯什么：
 *   · 它是**导出内容**（写得对不对直接决定交付物），所以要落到 serialize 上验；
 *   · 它有"清空 = 删键"这种不对称行为，肉眼看不出来，必须逐条断言；
 *   · 它有一个"从示例卡继承"的陷阱，所以要拿真实示例文件对拍常量。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// shared 走 dist（`npm test` 链上有 build:shared）；
// client 走源码 —— client/dist 是 vite 打出来的界面产物，没有可 import 的模块
import { createEmptyCard, serializeStCard } from '../shared/dist/index.js';
import {
  applyCardInfo,
  applyDefaults,
  detectInheritedFields,
  EMPTY_CARD_INFO_DEFAULTS,
  formatTagsInput,
  normalizeCardInfo,
  parseTagsInput,
  readCardInfo,
  SAMPLE_CREATOR_NOTES,
  sameCardInfo,
  sanitizeDefaults,
  toDefaults,
} from '../client/src/session/card-info.ts';

const ROOT = join(import.meta.dirname, '..');

/** 一份"改过全部字段"的卡片信息 */
function fullInfo(overrides = {}) {
  return {
    creator: '某作者',
    characterVersion: '2.3',
    creatorNotes: '这是我自己的说明。',
    tags: ['赛博朋克', '悬疑'],
    systemPrompt: '你是一个写实风格的叙述者。',
    postHistoryInstructions: '保持角色口吻，不要旁白解释。',
    worldbookName: '临海城',
    worldbookDescription: '赛博朋克背景设定集',
    ...overrides,
  };
}

// ── ① 读 ────────────────────────────────────────────────────

test('readCardInfo：从空卡读出全空（不是 undefined）', () => {
  const info = readCardInfo(createEmptyCard('甲'));
  assert.deepEqual(info, {
    creator: '',
    characterVersion: '',
    creatorNotes: '',
    tags: [],
    systemPrompt: '',
    postHistoryInstructions: '',
    worldbookName: '',
    worldbookDescription: '',
  });
});

test('readCardInfo：世界书 raw 为 null 时读空串，不抛', () => {
  // 空卡的世界书 raw 就是 null；读的时候若直接 `.name` 会炸
  const card = createEmptyCard('甲');
  assert.equal(card.worldbook.raw, null);
  assert.equal(readCardInfo(card).worldbookName, '');
});

// ── ② 写回 ──────────────────────────────────────────────────

test('applyCardInfo：八个字段都真的进了卡（而不是只在对话框里）', () => {
  const card = applyCardInfo(createEmptyCard('甲'), fullInfo());
  assert.equal(card.meta.creator, '某作者');
  assert.equal(card.meta.characterVersion, '2.3');
  assert.equal(card.meta.creatorNotes, '这是我自己的说明。');
  assert.deepEqual(card.meta.tags, ['赛博朋克', '悬疑']);
  assert.equal(card.residual.systemPrompt, '你是一个写实风格的叙述者。');
  assert.equal(card.residual.postHistoryInstructions, '保持角色口吻，不要旁白解释。');
  assert.equal(card.worldbook.raw.name, '临海城');
  assert.equal(card.worldbook.raw.description, '赛博朋克背景设定集');
});

test('applyCardInfo：纯函数（入参不被改动）', () => {
  const before = createEmptyCard('甲');
  const snapshot = JSON.stringify(before);
  applyCardInfo(before, fullInfo());
  assert.equal(JSON.stringify(before), snapshot, '入参被改了 —— 会让"取消"变成"改了一半"');
});

test('applyCardInfo：用户填的值出现在导出的 JSON 里（这才是用户看到的东西）', () => {
  /*
   * 这一条是本轮需求的验收点：用户抱怨的是「导出后这里明显不对」，
   * 所以判据必须落在序列化结果上，而不是内存对象上。
   */
  const card = applyCardInfo(createEmptyCard('西奥'), fullInfo());
  const json = serializeStCard(card);
  const data = json.data;
  assert.equal(data.creator, '某作者');
  assert.equal(data.character_version, '2.3');
  assert.equal(data.creator_notes, '这是我自己的说明。');
  assert.deepEqual(data.tags, ['赛博朋克', '悬疑']);
  assert.equal(data.system_prompt, '你是一个写实风格的叙述者。');
  assert.equal(data.post_history_instructions, '保持角色口吻，不要旁白解释。');
  assert.equal(data.character_book.name, '临海城');
  assert.equal(data.character_book.description, '赛博朋克背景设定集');
});

test('applyCardInfo：清空世界书名 = 从 JSON 里删掉这个键（不是留空串）', () => {
  /*
   * 不对称行为，肉眼完全看不出来：
   * 留 `"name": ""` 时 ST 会显示"世界书有名字但为空白"，看起来像渲染 bug；
   * 而用户在界面上做的事只是"把这个框清空"。
   */
  const withBook = applyCardInfo(createEmptyCard('甲'), fullInfo());
  const cleared = applyCardInfo(withBook, fullInfo({ worldbookName: '', worldbookDescription: '' }));
  assert.equal('name' in cleared.worldbook.raw, false, 'name 键应当被删掉');
  assert.equal('description' in cleared.worldbook.raw, false, 'description 键应当被删掉');
  // 条目不能被顺手清掉
  assert.deepEqual(cleared.worldbook.raw.entries, []);
});

test('applyCardInfo：原卡没有 character_book 且两处都空 → 不凭空造一个', () => {
  /*
   * 造出来会让导出多一个空壳 `"character_book": {"entries": []}`，
   * 反向导入时又被当成"这张卡有世界书"，越用越脏。
   */
  const card = applyCardInfo(createEmptyCard('甲'), fullInfo({ worldbookName: '', worldbookDescription: '' }));
  assert.equal(card.worldbook.raw, null);
  assert.equal('character_book' in serializeStCard(card).data, false);
});

test('applyCardInfo：只填世界书名也会建出 character_book 且 entries 是数组', () => {
  const card = applyCardInfo(createEmptyCard('甲'), fullInfo({ worldbookDescription: '' }));
  assert.equal(card.worldbook.raw.name, '临海城');
  assert.deepEqual(card.worldbook.raw.entries, [], 'entries 必须是数组，否则序列化会炸');
});

// ── ③ 标签解析 ──────────────────────────────────────────────

test('parseTagsInput：逗号 / 顿号 / 换行都当分隔符', () => {
  assert.deepEqual(parseTagsInput('日常, 治愈、书店\n悬疑'), ['日常', '治愈', '书店', '悬疑']);
});

test('parseTagsInput：去空、去重（保序）', () => {
  assert.deepEqual(parseTagsInput(' 日常 ,, 治愈 , 日常 、'), ['日常', '治愈']);
});

test('parseTagsInput：大小写不同的重复也算重复（保第一个的写法）', () => {
  assert.deepEqual(parseTagsInput('SciFi, scifi'), ['SciFi']);
});

test('formatTagsInput / parseTagsInput 互为逆运算', () => {
  const tags = ['日常', '治愈', '书店'];
  assert.deepEqual(parseTagsInput(formatTagsInput(tags)), tags);
});

test('标签顺序不被排序（用户写的顺序是意思表示）', () => {
  const card = applyCardInfo(createEmptyCard('甲'), fullInfo({ tags: ['乙', '甲', '丙'] }));
  assert.deepEqual(card.meta.tags, ['乙', '甲', '丙']);
});

// ── ④ 归一化与判重 ──────────────────────────────────────────

test('normalizeCardInfo：所有字符串去首尾空白', () => {
  const info = normalizeCardInfo(fullInfo({ creator: '  某作者  ', creatorNotes: '\n  说明  \n' }));
  assert.equal(info.creator, '某作者');
  assert.equal(info.creatorNotes, '说明');
});

test('sameCardInfo：只差空白算相同（否则点开又保存会把卡置脏）', () => {
  assert.equal(sameCardInfo(fullInfo(), normalizeCardInfo(fullInfo({ creator: ' 某作者 ' }))), true);
});

test('sameCardInfo：标签顺序不同算不同（顺序有意义）', () => {
  assert.equal(sameCardInfo(fullInfo({ tags: ['甲', '乙'] }), fullInfo({ tags: ['乙', '甲'] })), false);
});

// ── ⑤ 从示例卡继承的检测 ────────────────────────────────────

test('示例卡里确实有一张带着 SAMPLE_CREATOR_NOTES（否则提示永远不会触发）', () => {
  /*
   * `SAMPLE_CREATOR_NOTES` 用来提示"你这几个值还是示例卡的"。
   * 它与示例文件是同一件事的两处表述 —— 示例卡文案一改，提示就失效且**无声**。
   * 所以拿文件对拍，而不是靠人记得同步。
   *
   * 判据刻意是"至少一张有这个值 + 其余要么是它要么为空"：
   * `minimal-v2.json` 的 creator_notes 本来就是空串（它演示的是最小卡片），
   * 要求"所有示例卡都带这句话"就是**断言比事实更严** —— 那类测试只能靠改事实
   * 去迁就，改完就没人记得它原本想守什么了。
   */
  const dir = join(ROOT, 'examples', 'cards');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length > 0, '示例卡目录空了？');

  const notes = files.map((name) => {
    const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const value = raw?.data?.creator_notes ?? raw?.creator_notes ?? '';
    return { name, value };
  });

  const carriers = notes.filter((item) => item.value === SAMPLE_CREATOR_NOTES);
  assert.ok(carriers.length > 0, '没有任何示例卡带 SAMPLE_CREATOR_NOTES —— 继承提示永远不会触发');

  const strays = notes.filter((item) => item.value !== '' && item.value !== SAMPLE_CREATOR_NOTES);
  assert.deepEqual(
    strays,
    [],
    '这些示例卡的 creator_notes 既不是空、也不是 SAMPLE_CREATOR_NOTES：' +
      '改了示例卡文案就要同步 card-info.ts 里的常量，否则继承提示会静默失效',
  );
});

test('detectInheritedFields：刚从示例卡起的卡，四个字段都要被点出来', () => {
  const card = applyCardInfo(
    createEmptyCard('西奥'),
    fullInfo({
      creator: 'Tavern Card Studio',
      creatorNotes: SAMPLE_CREATOR_NOTES,
      worldbookName: '拾光书店',
      worldbookDescription: '旧城区书店相关设定',
    }),
  );
  const labels = detectInheritedFields(readCardInfo(card)).map((item) => item.label);
  assert.deepEqual(labels, ['创作说明', '作者', '世界书名称', '世界书说明']);
});

test('detectInheritedFields：用户改过之后不再提示', () => {
  const info = readCardInfo(applyCardInfo(createEmptyCard('甲'), fullInfo()));
  assert.deepEqual(detectInheritedFields(info), []);
});

test('detectInheritedFields：character_version 不参与（1.0 太通用，提示了只会添噪）', () => {
  const info = readCardInfo(applyCardInfo(createEmptyCard('甲'), fullInfo({ characterVersion: '1.0' })));
  assert.deepEqual(detectInheritedFields(info), []);
});

// ── ⑥ 新卡默认值 ────────────────────────────────────────────

test('toDefaults：只摘能当"习惯"的字段，不含世界书（那是内容）', () => {
  const defaults = toDefaults(fullInfo());
  assert.equal('worldbookName' in defaults, false);
  assert.equal('worldbookDescription' in defaults, false);
  assert.equal(defaults.creator, '某作者');
});

test('applyDefaults：套上作者等字段，但不动 name 与世界书', () => {
  const card = applyDefaults(createEmptyCard('新卡'), toDefaults(fullInfo()));
  assert.equal(card.meta.name, '新卡', 'new card 的名字不能被默认值盖掉');
  assert.equal(card.meta.creator, '某作者');
  assert.equal(card.meta.creatorNotes, '这是我自己的说明。');
  assert.equal(card.worldbook.raw, null, '世界书不是"习惯"，不该被默认值带进来');
});

test('applyDefaults：null 默认值 = 原样返回', () => {
  const card = createEmptyCard('甲');
  assert.equal(applyDefaults(card, null), card);
});

test('applyDefaults：空默认值不会把卡改脏', () => {
  const card = applyDefaults(createEmptyCard('甲'), EMPTY_CARD_INFO_DEFAULTS);
  assert.equal(card.meta.creator, '');
  assert.deepEqual(card.meta.tags, []);
});

test('sanitizeDefaults：配置被写坏时退回空默认值，不把坏形状带进去', () => {
  /*
   * 这是"新建卡崩掉"的唯一入口：配置来自磁盘，可能是旧版本或人手工改的。
   * `tags: '日常'`（字符串）会让 `tags.join` 之外的代码在别处炸，
   * 而新建卡是用户最常用的操作 —— 崩在那里等于客户端不能用。
   */
  assert.deepEqual(sanitizeDefaults(undefined), EMPTY_CARD_INFO_DEFAULTS);
  assert.deepEqual(sanitizeDefaults(null), EMPTY_CARD_INFO_DEFAULTS);
  assert.deepEqual(sanitizeDefaults({ creator: 123, tags: '日常' }), EMPTY_CARD_INFO_DEFAULTS);
  assert.deepEqual(
    sanitizeDefaults({ creator: '某作者', tags: ['甲', 2, null, '乙'] }),
    { ...EMPTY_CARD_INFO_DEFAULTS, creator: '某作者', tags: ['甲', '乙'] },
  );
});

test('sanitizeDefaults → applyDefaults 全链路：坏配置不会让新建卡抛异常', () => {
  const bad = { creator: {}, tags: 'x', systemPrompt: [] };
  const card = applyDefaults(createEmptyCard('甲'), sanitizeDefaults(bad));
  assert.equal(card.meta.creator, '');
  assert.deepEqual(card.meta.tags, []);
});
