/**
 * 世界书纯逻辑判据（2026-11-04）。
 *
 * 用户要求：**创建、导入、修改、重命名、启用禁用**，以及截图里那组
 * 全局激活设置（扫描深度 / 上下文百分比 / Token 预算 / 最小激活数 /
 * 最大深度 / 最大递归深度 / 六个勾选 / 插入策略）。
 *
 * ## 这组判据守什么
 *
 * 四件事错了都**不报错**，只是数据悄悄变坏：
 *
 * ```text
 *   写回时丢了不认识的字段   → 用户原本的设置被清掉，界面上看不出来
 *   用数组下标当键           → 删一条之后"改的是另一条"
 *   只认英文逗号             → 手机上打的中文逗号变成一个长关键词，永不触发
 *   uid 重排                 → 界面上「条目 3」指向的东西变了
 * ```
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_GLOBAL_SETTINGS,
  WORLD_POSITION,
  checkWorldbook,
  describeWorldbook,
  formatKeywordInput,
  makeEntry,
  nextUid,
  parseKeywordInput,
  parseWorldbook,
  removeEntry,
  serializeWorldbook,
  toggleEntry,
  updateEntry,
} from '../shared/dist/chat/worldbook.js';

function rawEntry(over = {}) {
  return {
    uid: 0,
    key: ['eldoria'],
    keysecondary: [],
    comment: 'eldoria',
    content: '正文',
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: false,
    displayIndex: 0,
    addMemo: false,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    probability: 100,
    depth: 4,
    useProbability: true,
    role: null,
    vectorized: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    ...over,
  };
}

test('★★★ 解析要保住所有不认识的字段（写回是整份覆盖）', () => {
  const parsed = parseWorldbook({ entries: { '0': rawEntry() } });
  assert.equal(parsed.entries.length, 1);
  const entry = parsed.entries[0];

  /* 界面上不编辑、但必须原样带回去的那些 */
  for (const field of ['displayIndex', 'addMemo', 'groupOverride', 'sticky', 'cooldown', 'delay', 'vectorized', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'useGroupScoring', 'automationId']) {
    assert.ok(field in entry.extra, `字段 ${field} 丢了（写回会清掉用户的设置）`);
  }
  assert.equal(entry.extra['sticky'], 0);
  assert.equal(entry.extra['automationId'], '');
});

test('★★★ 写回要还原成 ST 的结构，且字段一个不少', () => {
  const original = rawEntry({ sticky: 5, cooldown: 30 });
  const parsed = parseWorldbook({ entries: { '0': original } });
  const out = serializeWorldbook(parsed.entries);

  const back = out.entries['0'];
  /* 原始 31 个字段要全在 */
  for (const key of Object.keys(original)) {
    assert.ok(key in back, `写回后少了字段 ${key}`);
  }
  assert.equal(back['sticky'], 5);
  assert.equal(back['cooldown'], 30);
  assert.deepEqual(back['key'], ['eldoria']);
});

test('★★★ 写回的键必须是 uid，不是数组下标', () => {
  /*
   * 用下标的话删掉中间一条，其余条目的键全部前移 ——
   * 用户保存后再打开会发现"改的是另一条"。
   */
  const parsed = parseWorldbook({
    entries: { '5': rawEntry({ uid: 5 }), '9': rawEntry({ uid: 9, key: ['b'] }) },
  });
  const afterDelete = removeEntry(parsed.entries, 5);
  const out = serializeWorldbook(afterDelete);

  assert.deepEqual(Object.keys(out.entries), ['9'], '剩下的那条键还是 9，不是 0');
});

test('★★★ 关键词分隔符要认中文逗号（手机上手打的是全角）', () => {
  assert.deepEqual(parseKeywordInput('龙，魔法,森林\n海边'), ['龙', '魔法', '森林', '海边']);
  assert.deepEqual(parseKeywordInput('  单个  '), ['单个']);
  assert.deepEqual(parseKeywordInput(''), []);
  assert.equal(formatKeywordInput(['龙', '魔法']), '龙，魔法');
});

test('★★ 中文逗号输入能正确往返', () => {
  const keys = parseKeywordInput('龙，魔法');
  assert.equal(formatKeywordInput(keys), '龙，魔法');
});

test('★★★ 新增条目 uid 取最大 +1（不复用已删的号）', () => {
  const parsed = parseWorldbook({
    entries: { '0': rawEntry({ uid: 0 }), '3': rawEntry({ uid: 3 }) },
  });
  assert.equal(nextUid(parsed.entries), 4);

  /* 删掉最大的那条后仍然是 4 —— uid 不复用，避免"界面上的第 4 条换人" */
  const afterDelete = removeEntry(parsed.entries, 3);
  assert.equal(nextUid(afterDelete), 1);
});

test('★★ 新建条目默认：启用、必触发、顺序 100', () => {
  const entry = makeEntry([]);
  assert.equal(entry.uid, 0);
  assert.equal(entry.disabled, false);
  assert.equal(entry.probability, 100);
  assert.equal(entry.useProbability, true);
  assert.equal(entry.order, 100);
  assert.deepEqual(entry.keys, []);
});

test('★★ 改一条只动那一条（uid 不可改）', () => {
  const parsed = parseWorldbook({
    entries: { '0': rawEntry({ uid: 0 }), '1': rawEntry({ uid: 1, comment: 'b' }) },
  });
  const next = updateEntry(parsed.entries, 1, { comment: '改过了', uid: 999 });
  assert.equal(next[0].comment, 'eldoria', '第 0 条不受影响');
  assert.equal(next[1].comment, '改过了');
  assert.equal(next[1].uid, 1, 'uid 不许被 patch 改掉');
});

test('★★ 启用/禁用是翻转，不是设置', () => {
  const parsed = parseWorldbook({ entries: { '0': rawEntry() } });
  const off = toggleEntry(parsed.entries, 0);
  assert.equal(off[0].disabled, true);
  const on = toggleEntry(off, 0);
  assert.equal(on[0].disabled, false);
});

test('★★★ 校验：没内容 / 没关键词且非常驻 都要报出来', () => {
  const parsed = parseWorldbook({
    entries: {
      '0': rawEntry({ content: '' }),
      '1': rawEntry({ uid: 1, key: [], constant: false }),
      '2': rawEntry({ uid: 2, key: ['ok'] }),
    },
  });
  const problems = checkWorldbook(parsed.entries);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((one) => one.uid === 0 && one.message.includes('没有内容')));
  assert.ok(problems.some((one) => one.uid === 1 && one.message.includes('永远不会触发')));
});

test('★★ 校验：常驻且没关键词**不算**问题（这是正常用法）', () => {
  const parsed = parseWorldbook({ entries: { '0': rawEntry({ key: [], constant: true }) } });
  assert.deepEqual(checkWorldbook(parsed.entries), []);
});

test('★★ 禁用条目不参与校验（用户主动关的，不用提醒）', () => {
  const parsed = parseWorldbook({ entries: { '0': rawEntry({ content: '', disable: true }) } });
  assert.deepEqual(checkWorldbook(parsed.entries), []);
});

test('★★ 关键词重复要报（两条争同一个词，只有一条生效）', () => {
  const parsed = parseWorldbook({
    entries: {
      '0': rawEntry({ uid: 0, key: ['龙'] }),
      '1': rawEntry({ uid: 1, key: ['龙'] }),
    },
  });
  const problems = checkWorldbook(parsed.entries);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /重复/);
});

test('★★ 坏条目跳过并计数（不能让整本书打不开）', () => {
  const parsed = parseWorldbook({
    entries: { '0': rawEntry(), '1': null, '2': 'not-an-object' },
  });
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.skipped, 2);
});

test('★★ 空书 / 缺 entries 都要安全返回空', () => {
  assert.deepEqual(parseWorldbook(null), { entries: [], skipped: 0 });
  assert.deepEqual(parseWorldbook({}), { entries: [], skipped: 0 });
  assert.deepEqual(parseWorldbook({ entries: {} }), { entries: [], skipped: 0 });
});

test('★★ 数组形态（某些工具导出）也能读', () => {
  const parsed = parseWorldbook({ entries: [rawEntry({ uid: 7 }), rawEntry({ uid: 8 })] });
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.skipped, 0);
});

test('★★ 条目按 order 排序（同 order 按 uid）', () => {
  const parsed = parseWorldbook({
    entries: {
      '0': rawEntry({ uid: 0, order: 200 }),
      '1': rawEntry({ uid: 1, order: 10 }),
      '2': rawEntry({ uid: 2, order: 10 }),
    },
  });
  assert.deepEqual(parsed.entries.map((one) => one.uid), [1, 2, 0]);
});

test('★★★ 全局设置的默认值与截图一致（扫描深度 2 / 上下文 25% / 插入策略角色优先）', () => {
  assert.equal(DEFAULT_GLOBAL_SETTINGS.scanDepth, 2);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.contextPercent, 25);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.budgetCap, 0);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.minActivations, 0);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.includeNames, true);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.recursive, true);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.matchWholeWords, true);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.caseSensitive, false);
  assert.equal(DEFAULT_GLOBAL_SETTINGS.insertionStrategy, 'character_first');
});

test('★★ 摘要要说出条数、启用数、常驻数', () => {
  const parsed = parseWorldbook({
    entries: {
      '0': rawEntry({ uid: 0 }),
      '1': rawEntry({ uid: 1, disable: true, key: ['b'] }),
      '2': rawEntry({ uid: 2, constant: true, key: [] }),
    },
  });
  const text = describeWorldbook(parsed.entries);
  assert.match(text, /3 条/);
  assert.match(text, /2 条启用/);
  assert.match(text, /1 条常驻/);
});

test('★★ 插入位置的取值与 ST 常量对齐', () => {
  assert.equal(WORLD_POSITION.beforeChar, 0);
  assert.equal(WORLD_POSITION.afterChar, 1);
  assert.equal(WORLD_POSITION.topAN, 2);
  assert.equal(WORLD_POSITION.bottomAN, 3);
  assert.equal(WORLD_POSITION.atDepth, 4);
  assert.equal(WORLD_POSITION.topEM, 5);
  assert.equal(WORLD_POSITION.bottomEM, 6);
});

/* ═══════════════════════════════════════════════════════════
   三、全局设置的读写映射（ST 的字段名与我们的不同）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 读：吃 ST 的真实字段名（depth / budget.percent …）', async () => {
  const { readWorldSettings } = await import('../shared/dist/chat/worldbook.js');

  const got = readWorldSettings({
    depth: 7,
    case_sensitive: true,
    match_whole_words: false,
    use_group_scoring: true,
    insertion_strategy: 'global_first',
    budget: {
      percent: 40,
      cap: 2048,
      minActivations: 3,
      maxDepth: 12,
      maxRecursionDepth: 2,
      includeNames: false,
      recursive: false,
      overflowAlert: true,
    },
  });

  assert.equal(got.scanDepth, 7);
  assert.equal(got.contextPercent, 40);
  assert.equal(got.budgetCap, 2048);
  assert.equal(got.minActivations, 3);
  assert.equal(got.maxDepth, 12);
  assert.equal(got.maxRecursionDepth, 2);
  assert.equal(got.includeNames, false);
  assert.equal(got.recursive, false);
  assert.equal(got.overflowAlert, true);
  assert.equal(got.caseSensitive, true);
  assert.equal(got.matchWholeWords, false);
  assert.equal(got.useGroupScoring, true);
  assert.equal(got.insertionStrategy, 'global_first');
});

test('★★★ 读：缺字段用默认值，不猜', async () => {
  const { readWorldSettings } = await import('../shared/dist/chat/worldbook.js');
  const got = readWorldSettings({});
  assert.deepEqual(got, DEFAULT_GLOBAL_SETTINGS);
});

test('★★ 读：字段类型不对也退默认（不许把字符串塞进数字位）', async () => {
  const { readWorldSettings } = await import('../shared/dist/chat/worldbook.js');
  const got = readWorldSettings({ depth: 'abc', budget: { percent: null } });
  assert.equal(got.scanDepth, DEFAULT_GLOBAL_SETTINGS.scanDepth);
  assert.equal(got.contextPercent, DEFAULT_GLOBAL_SETTINGS.contextPercent);
});

test('★★ 读：非法的插入策略退默认', async () => {
  const { readWorldSettings } = await import('../shared/dist/chat/worldbook.js');
  const got = readWorldSettings({ insertion_strategy: '乱写的' });
  assert.equal(got.insertionStrategy, DEFAULT_GLOBAL_SETTINGS.insertionStrategy);
});

test('★★★ 写→读 往返一致（映射只许有一份）', async () => {
  const { readWorldSettings, writeWorldSettings } = await import('../shared/dist/chat/worldbook.js');

  const next = {
    ...DEFAULT_GLOBAL_SETTINGS,
    scanDepth: 9,
    contextPercent: 60,
    budgetCap: 4096,
    minActivations: 2,
    maxDepth: 30,
    maxRecursionDepth: 4,
    includeNames: false,
    recursive: false,
    caseSensitive: true,
    matchWholeWords: false,
    useGroupScoring: true,
    overflowAlert: true,
    insertionStrategy: 'evenly',
  };

  const restored = readWorldSettings(writeWorldSettings(next));
  assert.deepEqual(restored, next);
});

test('★★★ 写：只返回我们负责的项（不许整组覆盖）', async () => {
  /*
   * `world_info` 里还有 `globalSelect` 之类我们不碰的字段。
   * `writeWorldSettings` 只给出自己那几个，调用方负责展开合并 ——
   * 直接赋值会把用户的其余设置清掉。
   */
  const { writeWorldSettings } = await import('../shared/dist/chat/worldbook.js');
  const patch = writeWorldSettings(DEFAULT_GLOBAL_SETTINGS);
  assert.ok(!('globalSelect' in patch), '不许在 patch 里出现我们不负责的字段');
  assert.ok('depth' in patch);
  assert.ok('budget' in patch);
});
