/**
 * 内置测试卡的识别判据（2026-11-09，A1）。
 *
 * ## 为什么这里必须判得严
 *
 * 命中的后果是**删掉用户目录里的一个文件**，而且不可逆。
 * 所以本文件里每一条都是"宁可少删、不可错删"：
 *
 * ```text
 *   只有文件名像       → 不删（用户可能自己建了个叫「测试用-」的卡）
 *   只有 version 像    → 不删（别人分享的卡可能恰好写了 test-asset）
 *   version 读不到     → 不删（读不出内容 ≠ 确认是测试卡）
 *   不是 png           → 不删（别的文件一律不碰）
 *   前缀不在开头       → 不删（「我的测试用-xxx」是用户的卡）
 * ```
 *
 * 反向也有一条：**双判据都命中就必须删**，否则升级上来的用户
 * 永远看着那张卡 —— 那正是这个功能要解决的问题。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEST_CARD_NAME_PREFIX,
  TEST_CARD_VERSION_MARKER,
  describeRemovedTestCards,
  isBuiltinTestCard,
  pickBuiltinTestCards,
} from '../shared/dist/android/test-card-cleanup.js';

/** 构造一张"真·内置测试卡"的身份 */
const realTestCard = () => ({
  fileName: `${TEST_CARD_NAME_PREFIX}夜航小助手.png`,
  characterVersion: TEST_CARD_VERSION_MARKER,
});

/* ═══════════════════════════════════════════════════════════
   ① 双判据都命中 → 删
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 文件名前缀 + version 标记都命中 → 判定为测试卡', () => {
  assert.equal(isBuiltinTestCard(realTestCard()), true);
});

test('★★★★ 常量与历史值一致（改名等于让老卡再也认不出来）', () => {
  /*
   * 这两个值是**已经播进用户机器**的卡上的实际值。
   * 改一个字，那些卡就永远清不掉了 —— 而它们已经发出去了。
   */
  assert.equal(TEST_CARD_NAME_PREFIX, '测试用-');
  assert.equal(TEST_CARD_VERSION_MARKER, 'test-asset');
});

/* ═══════════════════════════════════════════════════════════
   ② 只命中一条 → 不删（这是这个文件的主要价值）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 只有文件名像：不删（用户可能自己建了个同前缀的卡）', () => {
  assert.equal(
    isBuiltinTestCard({ fileName: `${TEST_CARD_NAME_PREFIX}我的角色.png`, characterVersion: '1.0' }),
    false,
  );
  assert.equal(
    isBuiltinTestCard({ fileName: `${TEST_CARD_NAME_PREFIX}我的角色.png`, characterVersion: null }),
    false,
  );
});

test('★★★★★ 只有 version 像：不删（别人分享的卡可能恰好写了 test-asset）', () => {
  assert.equal(
    isBuiltinTestCard({ fileName: '别人的角色.png', characterVersion: TEST_CARD_VERSION_MARKER }),
    false,
  );
});

test('★★★★★ version 读不到（null）：不删', () => {
  /*
   * `null` = 读不出内容（文件损坏、格式不认识、读失败）。
   * 这与"读到了、值是空的"是两件事 —— 后者可以下结论，前者不能。
   * 宁可留着一张没人用的卡，也不能因为读不出来就删用户的卡。
   */
  assert.equal(
    isBuiltinTestCard({ fileName: `${TEST_CARD_NAME_PREFIX}夜航.png`, characterVersion: null }),
    false,
  );
});

test('★★★★ version 是空串：不删（空 ≠ test-asset）', () => {
  assert.equal(
    isBuiltinTestCard({ fileName: `${TEST_CARD_NAME_PREFIX}夜航.png`, characterVersion: '' }),
    false,
  );
});

test('★★★★ 不是 png：一律不碰', () => {
  for (const name of ['测试用-夜航.png.bak', '测试用-夜航.json', '测试用-夜航.txt', '测试用-夜航']) {
    assert.equal(
      isBuiltinTestCard({ fileName: name, characterVersion: TEST_CARD_VERSION_MARKER }),
      false,
      `${name} 不该被判定为测试卡`,
    );
  }
});

test('★★★★ 前缀不在开头：不删（「我的测试用-xxx」是用户的卡）', () => {
  assert.equal(
    isBuiltinTestCard({
      fileName: `我的${TEST_CARD_NAME_PREFIX}夜航.png`,
      characterVersion: TEST_CARD_VERSION_MARKER,
    }),
    false,
  );
});

test('★★★ 空文件名：不删', () => {
  assert.equal(
    isBuiltinTestCard({ fileName: '', characterVersion: TEST_CARD_VERSION_MARKER }),
    false,
  );
  assert.equal(isBuiltinTestCard({ fileName: '   ', characterVersion: null }), false);
});

test('★★★ version 大小写 / 空格差异：按精确值判（不做模糊匹配）', () => {
  /*
   * 模糊匹配在这里是危险的：`TEST-ASSET` / `test-asset-v2` 都"看起来像"，
   * 但**写进我们那张卡的只有 `test-asset` 这一个精确值**。
   * 放宽匹配只会扩大误删面，不会多救回一张卡。
   */
  for (const version of ['TEST-ASSET', 'test-asset-v2', 'Test-Asset', '']) {
    assert.equal(
      isBuiltinTestCard({ fileName: `${TEST_CARD_NAME_PREFIX}夜航.png`, characterVersion: version }),
      false,
      `version=${version} 不该命中`,
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   ③ 批量挑（Kotlin 侧拿到的就是这一份）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 批量里只挑出真测试卡，别人的卡一张不动', () => {
  const cards = [
    realTestCard(),
    { fileName: 'Seraphina.png', characterVersion: '1.0' }, // ST 自带
    { fileName: '西奥.png', characterVersion: '1.2' }, // 用户自己导的
    { fileName: `${TEST_CARD_NAME_PREFIX}另一张.png`, characterVersion: TEST_CARD_VERSION_MARKER },
    { fileName: '别人的角色.png', characterVersion: TEST_CARD_VERSION_MARKER }, // 只有 version
  ];
  const picked = pickBuiltinTestCards(cards);
  assert.equal(picked.length, 2, '只挑出两张真的');
  assert.deepEqual(picked.map((one) => one.fileName), [
    `${TEST_CARD_NAME_PREFIX}夜航小助手.png`,
    `${TEST_CARD_NAME_PREFIX}另一张.png`,
  ]);
});

test('★★★★ 空清单：挑不出任何东西（新装用户走的就是这条）', () => {
  assert.deepEqual(pickBuiltinTestCards([]), []);
});

/* ═══════════════════════════════════════════════════════════
   ④ 给用户的话
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 一张时：说清删了哪个、以及"不是你的数据"', () => {
  const message = describeRemovedTestCards([`${TEST_CARD_NAME_PREFIX}夜航小助手.png`]);
  assert.ok(message.includes('测试用-夜航小助手'), `要点出具体是哪张：${message}`);
  assert.ok(!message.includes('.png'), '不要露扩展名（用户不需要知道）');
  assert.ok(message.includes('不是你的数据'), '要安抚：用户会怕是自己的卡被删了');
});

test('★★★★ 多张时：数量与名字都点出来', () => {
  const message = describeRemovedTestCards(['测试用-甲.png', '测试用-乙.png']);
  assert.ok(message.includes('2 张'), `要有数量：${message}`);
  assert.ok(message.includes('测试用-甲') && message.includes('测试用-乙'), `要列出名字：${message}`);
});

test('★★★★ 没删东西：返回空串（上层据此不提示）', () => {
  /*
   * 空串是"别提示我"的信号。返回一句"已清理 0 张"会让每次启动都弹一条
   * 无意义的通知 —— 而那正好是绝大多数用户（没有测试卡）会看到的。
   */
  assert.equal(describeRemovedTestCards([]), '');
});
