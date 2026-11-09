/**
 * 更新式推送的名字决策（v0.1.7 修订一）—— `resolveStPushName` 的单元测试。
 *
 * ## 为什么单独一个文件
 *
 * 这条逻辑的每个分支都对应一个**用户能感知的后果**，而且错了都"看起来很成功"：
 *
 *   · 该覆盖却加了序号 → ST 里多一个角色，聊天记录留在旧的上面（用户以为是丢数据）
 *   · 该加序号却覆盖了  → 顶掉别人的卡，对方再也找不回自己的聊天记录
 *   · 改名后换文件名    → 同一个角色在 ST 里变成两个
 *
 * 所以它必须是**纯函数**、可穷举测试的。`st-push.ts` 那个集成测试只能覆盖
 * "读盘写盘都对"的那条主路径，边界全在这里。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  nameKeyFor,
  NAME_KEY_PREFIX,
  resolveStPushName,
} from '../client/src/session/st-push-name.ts';

const CID = 'card-abc123';

test('首次推送：按角色名占名，并登记映射', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    existing: [],
    registry: {},
  });
  assert.equal(d.fileName, '西奥.png');
  assert.equal(d.isUpdate, false);
  assert.equal(d.register, '西奥.png');
  assert.deepEqual(d.dropKeys, []);
});

test('同 cardId 再推：覆盖原文件（这是"更新"，不是新卡）', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    existing: ['西奥.png'],
    registry: { [CID]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png', '必须是原文件名，不能变成 西奥 (2).png');
  assert.equal(d.isUpdate, true);
  assert.equal(d.register, null, '映射已经是这个值，不该重复写');
});

test('改名后推：文件名不变（ST 身份=文件名，聊天记录因此保留）', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥·改了个很长的名字',
    existing: ['西奥.png'],
    registry: { [CID]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png', '改名不影响落盘名');
  assert.equal(d.isUpdate, true);
  assert.equal(d.register, null);
});

test('用户在 ST 侧删了文件：视为首次，重新占名（且登记新名）', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    existing: [],
    registry: { [CID]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png', '目录空着，占到的还是同一个名字');
  assert.equal(d.isUpdate, false, '文件不在了就不是"更新"');
  assert.equal(d.register, '西奥.png', '要重新登记');
});

test('删掉后同名被别人占了：新占名要避开，不能抢回来', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    existing: ['西奥.png'],
    // 映射还指着 西奥.png，但文件已经是别人的了（另一个 key 也登记着它）
    registry: { [CID]: '西奥.png', 'card-other': '西奥.png' },
  });
  // 有映射且文件在 → 走"直接复用"分支，但发现被别的 key 占用 ⇒ 换名并提示
  assert.notEqual(d.fileName, '西奥.png');
  assert.equal(d.isUpdate, false);
  assert.match(d.note, /已被另一张卡占用/);
});

test('目标名被另一个 cardId 占用：才加序号', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    // 目录里只有 西奥.png，且它被另一张卡登记着
    existing: ['西奥.png'],
    registry: { 'card-other': '西奥.png' },
  });
  assert.equal(d.fileName, '西奥 (2).png', '西奥.png 是别人的，跳过它');
  assert.equal(d.isUpdate, false);
  assert.equal(d.register, '西奥 (2).png');
});

test('无 cardId 时退化用 name key，仍能覆盖同名', () => {
  const key = nameKeyFor('西奥');
  assert.ok(key.startsWith(NAME_KEY_PREFIX), 'name key 必须带前缀，别和 cardId 撞');
  const d = resolveStPushName({
    key,
    cardName: '西奥',
    existing: ['西奥.png'],
    registry: { [key]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png');
  assert.equal(d.isUpdate, true);
});

test('先无 cardId 推过、后来有了 cardId：认领旧映射，不多出一张卡', () => {
  const nameKey = nameKeyFor('西奥');
  const d = resolveStPushName({
    key: CID,
    adoptFrom: nameKey,
    cardName: '西奥',
    existing: ['西奥.png'],
    registry: { [nameKey]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png', '要复用原来那个文件');
  assert.equal(d.isUpdate, true);
  assert.equal(d.register, '西奥.png', '把映射迁到 cardId 下');
  assert.deepEqual(d.dropKeys, [nameKey], '旧 name key 要清掉，否则两份映射会各自漂移');
});

test('认领时旧映射指向的文件已经没了：不认领，但仍要清掉这条陈旧映射', () => {
  const nameKey = nameKeyFor('西奥');
  const d = resolveStPushName({
    key: CID,
    adoptFrom: nameKey,
    cardName: '西奥',
    existing: [],
    registry: { [nameKey]: '西奥.png' },
  });
  assert.equal(d.fileName, '西奥.png', '目录空着，占到的就是这个名字');
  assert.equal(d.isUpdate, false);
  /*
   * 关键：这条陈旧的 name 映射**必须被清掉**，哪怕没认领成功。
   *
   * 不清的后果是它会挡住自己：占名时把「别人登记着的名字」算进已占用（防止
   * 抢别人的），而这个 name key 在忽略名单之外 ⇒ 新卡占名会避开 `西奥.png`
   * 拿到 `西奥 (2).png`，凭空多一个文件。这个 bug 是写完测试才发现的。
   */
  assert.deepEqual(d.dropKeys, [nameKey], '陈旧映射要清掉，否则下次会挡住自己');
});

test('映射值是非法名（没有 .png 后缀）：不信它，重新占名', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    existing: ['西奥.png'],
    registry: { [CID]: '西奥' },
  });
  assert.equal(d.fileName, '西奥 (2).png', '西奥.png 已存在且没被合法登记，跳过');
  assert.equal(d.isUpdate, false);
});

test('映射值是空串/null：当作没有映射', () => {
  for (const bad of ['', '   ', null, undefined]) {
    const d = resolveStPushName({
      key: CID,
      cardName: '西奥',
      existing: ['西奥.png'],
      registry: { [CID]: bad },
    });
    assert.equal(d.isUpdate, false, `registry 值是 ${JSON.stringify(bad)} 时不该当成更新`);
    assert.notEqual(d.fileName, '西奥.png');
  }
});

test('别人登记着的名字即使文件不在，新卡也不占（防"抢名字再覆盖别人"）', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥',
    // 目录里没有 西奥.png，但 card-other 登记了它（文件是被 ST 临时移走了）
    existing: [],
    registry: { 'card-other': '西奥.png' },
  });
  assert.equal(d.fileName, '西奥 (2).png');
});

test('名字里的非法字符先被清洗，再判冲突', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: '西奥/测试:名字',
    existing: [],
    registry: {},
  });
  assert.ok(!d.fileName.includes('/'), '不能带路径分隔符');
  assert.ok(!d.fileName.includes(':'), '不能带冒号（Windows 非法字符）');
  assert.ok(d.fileName.endsWith('.png'));
});

test('大小写不同的同名文件不复用（跨平台一致性优先）', () => {
  const d = resolveStPushName({
    key: CID,
    cardName: 'xiao',
    existing: ['XIao.png'],
    registry: {},
  });
  assert.equal(d.fileName, 'xiao (2).png', '按完全一致判断，避免某些文件系统上变成两个');
});

test('名字映射 key 前缀把两个命名空间分开（cardId 可以长得像 name key）', () => {
  // 用户把 cardId 起成 "name:西奥" 这种 —— 只要我们的 name key 也带前缀，
  // 两者就会撞。这里固定住"前缀存在"这个事实，改动时必须重新想清楚。
  assert.equal(nameKeyFor('西奥'), 'name:西奥');
  assert.notEqual(nameKeyFor('西奥'), '西奥');
});
