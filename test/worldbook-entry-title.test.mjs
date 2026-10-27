/**
 * 世界书条目标题落到 ST 的 `comment`（v0.1.6 / 用户「这个世界书的条目名字反而缺失了」）。
 *
 * ## 这一组测试盯的是"跨系统的字段名差异"
 *
 * 我们的世界书 TXT 把条目显示名写成 `name`（docs/04 §3.2 第 1 个字段），
 * 而 ST 的前端导入 `character_book` 时**只读 `comment`**：
 *
 *     comment: entry.comment || '',
 *     addMemo: !!entry.comment,
 *
 * 于是从我们的 TXT 起手 → 导出成卡 → 导进 ST，条目标题整片空白。
 * 数据没丢，只是写在 ST 不看的那一格 —— 所以必须落在**导出的 JSON** 上验。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEmptyCard,
  renderWorldbookJson,
  serializeStCard,
  stEntryTitle,
  withStEntryComment,
  withStEntryComments,
} from '../shared/dist/index.js';

/** 一条只有 name、没有 comment 的条目（就是 TXT 解析出来的样子） */
const entryWithNameOnly = {
  id: 1,
  name: '西奥核心关系逻辑',
  keys: [],
  content: '{{char}}与{{user}}的关系发展缓慢。',
  insertion_order: 100,
};

test('withStEntryComment：只有 name 时补出 comment（ST 才认）', () => {
  const fixed = withStEntryComment(entryWithNameOnly);
  assert.equal(fixed.comment, '西奥核心关系逻辑');
  // name 要留着：我们的 TXT 与编辑器还在用它
  assert.equal(fixed.name, '西奥核心关系逻辑');
});

test('withStEntryComment：已有 comment 时不覆盖（ST 里改过的标题优先）', () => {
  const entry = { ...entryWithNameOnly, comment: '我自己起的标题' };
  const fixed = withStEntryComment(entry);
  assert.equal(fixed.comment, '我自己起的标题');
});

test('withStEntryComment：没改就是同一个对象引用（便于判"有没有动过"）', () => {
  // 引用相等比逐字段比对便宜，也不会因为克隆把 extensions 之类的嵌套弄坏
  const entry = { ...entryWithNameOnly, comment: '已有' };
  assert.equal(withStEntryComment(entry), entry);
  const blank = { ...entryWithNameOnly, name: '', comment: '' };
  assert.equal(withStEntryComment(blank), blank);
});

test('withStEntryComment：纯函数（入参不被改动）', () => {
  const before = JSON.stringify(entryWithNameOnly);
  withStEntryComment(entryWithNameOnly);
  assert.equal(JSON.stringify(entryWithNameOnly), before, '入参被改了');
});

test('stEntryTitle：comment 优先，其次 name，都没有给空串', () => {
  assert.equal(stEntryTitle({ keys: [], content: '', comment: 'c', name: 'n' }), 'c');
  assert.equal(stEntryTitle({ keys: [], content: '', name: 'n' }), 'n');
  assert.equal(stEntryTitle({ keys: [], content: '' }), '');
  assert.equal(stEntryTitle({ keys: [], content: '', comment: '   ', name: 'n' }), 'n');
});

test('整卡序列化默认不动 comment（保住无损往返契约）', () => {
  /*
   * `serializeStCard` 的契约是"导入什么都不改、导出字节一致"
   * （test/roundtrip.test.mjs 守着）。补 comment 是**改变内容**，
   * 所以默认必须关 —— 否则用户看到文件被动过，却没有任何提示。
   */
  const card = createEmptyCard('西奥');
  const withBook = {
    ...card,
    worldbook: { ...card.worldbook, entries: [entryWithNameOnly], raw: null },
  };
  const entries = serializeStCard(withBook).data.character_book.entries;
  assert.equal('comment' in entries[0], false, '默认不该凭空多出 comment');
});

test('导出管线开启对齐后：character_book 的每条都有 comment（用户导进 ST 的那份）', () => {
  const card = createEmptyCard('西奥');
  const withBook = {
    ...card,
    worldbook: {
      ...card.worldbook,
      entries: [entryWithNameOnly, { id: 2, name: '傲娇', keys: [], content: '…' }],
      raw: { name: '拾光书店', entries: [] },
    },
  };
  const data = serializeStCard(withBook, { entryTitleToComment: true }).data;
  const entries = data.character_book.entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.comment),
    ['西奥核心关系逻辑', '傲娇'],
    '导出的每条都必须带 comment —— ST 只认这个当标题',
  );
  // 世界书自己的 name / description 不能被 entries 的补齐动到
  assert.equal(data.character_book.name, '拾光书店');
});

test('世界书单独导出（JSON）：同样补 comment', () => {
  // 用户可能把这个 JSON 直接导入 ST，那条路径也要对
  // 与导出管线一致：显式打开对齐（默认关闭以保无损）
  const text = renderWorldbookJson([entryWithNameOnly], { name: '拾光书店' }, { entryTitleToComment: true });
  const parsed = JSON.parse(text);
  assert.equal(parsed.entries[0].comment, '西奥核心关系逻辑');
  assert.equal(parsed.entries[0].name, '西奥核心关系逻辑');
});

test('导出是稳定的：补过一次之后再导出不会多出第二个键', () => {
  /*
   * 补齐必须幂等。否则每导一次就多一层，用户看不出差别但文件会一直长。
   */
  const card = createEmptyCard('西奥');
  const withBook = {
    ...card,
    worldbook: { ...card.worldbook, entries: [withStEntryComment(entryWithNameOnly)], raw: null },
  };
  const first = serializeStCard(withBook, { entryTitleToComment: true }).data.character_book.entries[0];
  assert.equal(first.comment, '西奥核心关系逻辑');
  assert.equal(first.name, '西奥核心关系逻辑');

  const again = withStEntryComments([first])[0];
  assert.equal(again, first, '已经有 comment 的条目不该被再造一份');
});

test('多条一起处理：各自的标题不串（批量版最容易写错的地方）', () => {
  const list = [
    { id: 1, name: '甲', keys: [], content: '' },
    { id: 2, name: '', comment: '乙的标题', keys: [], content: '' },
    { id: 3, name: '丙', keys: [], content: '' },
  ];
  assert.deepEqual(
    withStEntryComments(list).map((entry) => entry.comment),
    ['甲', '乙的标题', '丙'],
  );
});
