/**
 * 从文件名推导角色名（T10.28）+ 改名提示的显示策略（T10.29）。
 *
 * 两组都是"看着一眼就懂、边界一碰就错"的逻辑：
 *   · 名字推导：`林晚照.v2.txt` 不能被截成 `林晚照`；`a:::b.txt` 不能变成 `a___b`；
 *     emoji 不能被截成半个码点（截半个会让标签栏显示出一个方块）；
 *   · 提示策略：localStorage 抛异常时**必须显示**提示 —— 这是可发现性功能，
 *     静默消失等于没做。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCardNameFromFile, DERIVED_NAME_MAX } from '../client/src/editor/open-name.ts';
import { NAME_HINT_KEY, dismissNameHint, resetNameHint, shouldShowNameHint } from '../client/src/editor/name-hint.ts';

// ────────────────────────────────────────────── 名字推导

test('去扩展名：只去掉最后一个，不吞掉名字里的点', () => {
  assert.equal(deriveCardNameFromFile('C:\\cards\\林晚照.txt'), '林晚照');
  assert.equal(deriveCardNameFromFile('/home/x/林晚照.json'), '林晚照');
  // `.v2` 是用户名字的一部分，不是后缀
  assert.equal(deriveCardNameFromFile('林晚照.v2.txt'), '林晚照.v2');
  assert.equal(deriveCardNameFromFile('没有扩展名'), '没有扩展名');
});

test('非法字符清成下划线，连续下划线压成一个，首尾点与空白去掉', () => {
  assert.equal(deriveCardNameFromFile('a:b*c?.txt'), 'a_b_c_');
  assert.equal(deriveCardNameFromFile('a:::b.txt'), 'a_b');
  assert.equal(deriveCardNameFromFile('  . 名字 . .txt'), '名字');
  // 冒号在 Windows 上非法，而这份名字会进导出 JSON 与文件名建议，必须提前清掉
  assert.doesNotMatch(deriveCardNameFromFile('C:\\x\\问:号.txt'), /[:*?"<>|\\/]/);
});

test('全空名字给可辨认的兜底，不留空字符串', () => {
  // 只剩扩展名 / 全是非法字符 —— 都是真实可能出现的文件名
  assert.equal(deriveCardNameFromFile('.txt'), '未命名角色');
  assert.equal(deriveCardNameFromFile('___.txt'), '未命名角色');
  const name = deriveCardNameFromFile('C:\\cards\\.txt');
  assert.notEqual(name.trim(), '', '标签栏不能出现空名字');
});

test('超长截断按码点算，emoji 不会被切成半个', () => {
  const long = '卡'.repeat(DERIVED_NAME_MAX + 20);
  assert.equal(Array.from(deriveCardNameFromFile(`${long}.txt`)).length, DERIVED_NAME_MAX);

  const emoji = '🌙'.repeat(DERIVED_NAME_MAX + 5);
  const truncated = deriveCardNameFromFile(`${emoji}.txt`);
  const chars = Array.from(truncated);
  assert.equal(chars.length, DERIVED_NAME_MAX);
  // 半个代理对会变成 U+FFFD 或孤立代理项 —— 两种都不该出现
  assert.doesNotMatch(truncated, /\uFFFD/);
  assert.equal(chars.every((char) => char === '🌙'), true, '截断不能破坏字符');
});

test('重名追加数字后缀，且不区分大小写地避开已占用名字', () => {
  assert.equal(deriveCardNameFromFile('甲.txt', ['甲']), '甲 (2)');
  assert.equal(deriveCardNameFromFile('甲.txt', ['甲', '甲 (2)']), '甲 (3)');
  assert.equal(deriveCardNameFromFile('Abc.txt', ['abc']), 'Abc (2)');
  assert.equal(deriveCardNameFromFile('乙.txt', ['甲']), '乙');
});

// ────────────────────────────────────────────── 提示策略

/** 内存版 store，可注入 save 抛异常 */
function memoryStore(options = {}) {
  const data = new Map(Object.entries(options.initial ?? {}));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (options.throwOnSet === true) throw new Error('quota exceeded');
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

test('提示：没记录过就显示', () => {
  assert.equal(shouldShowNameHint(memoryStore()), true);
});

test('提示：点过一次之后不再显示，重置后重新出现', () => {
  const store = memoryStore();
  dismissNameHint(store);
  assert.equal(store.getItem(NAME_HINT_KEY), '1');
  assert.equal(shouldShowNameHint(store), false);

  resetNameHint(store);
  assert.equal(store.getItem(NAME_HINT_KEY), null);
  assert.equal(shouldShowNameHint(store), true);
});

test('提示：localStorage 写失败时本次会话仍然隐藏（不能让点击看起来没反应）', () => {
  const store = memoryStore({ throwOnSet: true });
  assert.doesNotThrow(() => dismissNameHint(store));
  // 写失败 → 下次启动还会提示一次；这可以接受，但不能抛
});

test('提示：读失败时**显示**提示（可发现性功能，静默消失等于没做）', () => {
  const store = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.equal(shouldShowNameHint(store), true);
});

test('提示：store 为 null（浏览器禁用存储）时显示', () => {
  assert.equal(shouldShowNameHint(null), true);
  assert.doesNotThrow(() => dismissNameHint(null));
  assert.doesNotThrow(() => resetNameHint(null));
});
