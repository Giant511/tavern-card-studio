/**
 * T9.8 卡片目录的纯逻辑（`client/src/session/cards-path.ts`）。
 *
 * 这些规则都不是"好看"问题，每一条对应一个真实故障：
 *   · 非法字符 → 文件根本写不进去；
 *   · 首尾的点和空格 → Windows 会静默裁掉，于是"我存的名字"和磁盘上的名字不一致；
 *   · 保留设备名 → `con.json` 永远创建失败，报错还很莫明；
 *   · 重名不追加序号 → 静默覆盖别人的卡（F4 明确禁止）；
 *   · 大小写敏感比较 → Windows 上 `A.json` / `a.json` 是同一个文件，
 *     按大小写去比会以为"没冲突"，然后覆盖。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FILE_BASE_LENGTH,
  decideCardsDir,
  fileNameOf,
  joinPath,
  nextAvailableFileName,
  parentPath,
  resolveCardsDir,
  sanitizeFileBase,
} from '../client/src/session/cards-path.ts';

// ── joinPath / parentPath / fileNameOf ─────────────────────

test('joinPath：按分隔符判断平台，并吃掉目录末尾多余的分隔符', () => {
  assert.equal(joinPath('C:\\Users\\PC\\Documents\\cards', 'a.json'), 'C:\\Users\\PC\\Documents\\cards\\a.json');
  assert.equal(joinPath('C:\\Users\\PC\\cards\\', 'a.json'), 'C:\\Users\\PC\\cards\\a.json');
  assert.equal(joinPath('/home/pc/cards', 'a.json'), '/home/pc/cards/a.json');
  assert.equal(joinPath('/home/pc/cards//', 'a.json'), '/home/pc/cards/a.json');
});

test('parentPath / fileNameOf：不碰文件系统，纯字符串切分', () => {
  assert.equal(parentPath('C:\\cards\\a.json'), 'C:\\cards');
  assert.equal(parentPath('/cards/a.json'), '/cards');
  assert.equal(fileNameOf('C:\\cards\\a.json'), 'a.json');
  assert.equal(fileNameOf('/cards/a.json'), 'a.json');
  // 没有分隔符时原样返回（不抛错：这个函数在错误路径上也会被调用）
  assert.equal(fileNameOf('a.json'), 'a.json');
});

// ── resolveCardsDir ───────────────────────────────────────

test('resolveCardsDir：未设置时回落到默认值，不会被"空配置"变成空目录', () => {
  const fallback = 'C:\\Users\\PC\\Documents\\TavernCardStudio\\cards';
  assert.equal(resolveCardsDir(null, fallback), fallback);
  assert.equal(resolveCardsDir(undefined, fallback), fallback);
  assert.equal(resolveCardsDir('', fallback), fallback);
  assert.equal(resolveCardsDir('   ', fallback), fallback);
  assert.equal(resolveCardsDir(' D:\\cards ', fallback), 'D:\\cards');
});

// ── sanitizeFileBase ──────────────────────────────────────

test('sanitizeFileBase：中文与常见标点原样保留', () => {
  assert.equal(sanitizeFileBase('林晚照'), '林晚照');
  assert.equal(sanitizeFileBase('林晚照（修订）'), '林晚照（修订）');
  assert.equal(sanitizeFileBase('Lin Wanzhao'), 'Lin Wanzhao');
});

test('sanitizeFileBase：去掉 Windows 非法字符，不留下空洞', () => {
  assert.equal(sanitizeFileBase('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(sanitizeFileBase('2026-10-22 15:30'), '2026-10-22 1530');
});

test('sanitizeFileBase：砍掉首尾的点与空格（Windows 会静默裁掉它们）', () => {
  assert.equal(sanitizeFileBase('  林晚照  '), '林晚照');
  assert.equal(sanitizeFileBase('林晚照.'), '林晚照');
  assert.equal(sanitizeFileBase('.林晚照'), '林晚照');
  assert.equal(sanitizeFileBase('...'), 'card');
});

test('sanitizeFileBase：保留设备名加下划线（con.json 永远创建失败）', () => {
  assert.equal(sanitizeFileBase('con'), '_con');
  assert.equal(sanitizeFileBase('CON'), '_CON');
  assert.equal(sanitizeFileBase('nul'), '_nul');
  assert.equal(sanitizeFileBase('com1'), '_com1');
  // 只是"以 con 开头"的普通名字不该被改
  assert.equal(sanitizeFileBase('content'), 'content');
});

test('sanitizeFileBase：空名回退 card（角色名允许为空，文件名不行）', () => {
  assert.equal(sanitizeFileBase(''), 'card');
  assert.equal(sanitizeFileBase('   '), 'card');
  assert.equal(sanitizeFileBase('///'), 'card');
});

test('sanitizeFileBase：超长按码点截断，不留半个字符', () => {
  const long = '阿'.repeat(MAX_FILE_BASE_LENGTH + 20);
  const result = sanitizeFileBase(long);
  assert.equal([...result].length, MAX_FILE_BASE_LENGTH);

  // emoji 是代理对：按 UTF-16 直接 slice 会切出半个字符（乱码方块）
  const emoji = '🐉'.repeat(MAX_FILE_BASE_LENGTH + 10);
  const truncated = sanitizeFileBase(emoji);
  assert.equal([...truncated].length, MAX_FILE_BASE_LENGTH);
  assert.ok(!truncated.includes('\uFFFD'), '不能出现替换字符');
  assert.ok(truncated === '🐉'.repeat(MAX_FILE_BASE_LENGTH));
});

// ── nextAvailableFileName ─────────────────────────────────

test('重名：目录为空时直接用原名', () => {
  assert.equal(nextAvailableFileName([], '林晚照'), '林晚照.json');
});

test('重名：已有同名时追加 (2)，再冲突依次递增', () => {
  assert.equal(nextAvailableFileName(['林晚照.json'], '林晚照'), '林晚照 (2).json');
  assert.equal(
    nextAvailableFileName(['林晚照.json', '林晚照 (2).json'], '林晚照'),
    '林晚照 (3).json',
  );
  // 中间空出来要复用（用户删掉了 (2)，下一个就该填 (2)）
  assert.equal(
    nextAvailableFileName(['林晚照.json', '林晚照 (3).json'], '林晚照'),
    '林晚照 (2).json',
  );
});

test('重名：忽略大小写（Windows 上 A.json 与 a.json 是同一个文件）', () => {
  assert.equal(nextAvailableFileName(['LIN.JSON'], 'lin'), 'lin (2).json');
  assert.equal(nextAvailableFileName(['林晚照.JSON'], '林晚照'), '林晚照 (2).json');
});

test('重名：不把别的扩展名当冲突，也不被它干扰', () => {
  assert.equal(nextAvailableFileName(['林晚照.txt'], '林晚照'), '林晚照.json');
  assert.equal(nextAvailableFileName(['林晚照.json'], '林晚照', 'txt'), '林晚照.txt');
});

test('重名：空 base 也要给出可用名字（不返回 ".json"）', () => {
  assert.equal(nextAvailableFileName([], ''), 'card.json');
});

test('重名：极端情况（一万个同名）也不返回已存在的名字', () => {
  const existing = ['x.json', ...Array.from({ length: 10000 }, (_, i) => `x (${i + 2}).json`)];
  const result = nextAvailableFileName(existing, 'x');
  assert.ok(!existing.includes(result), '绝不能返回一个已存在的名字（那等于静默覆盖）');
  assert.ok(result.endsWith('.json'));
});

// ── decideCardsDir（判定：拦还是不拦）────────────────────────
//
// 三条分支的处置完全不同，错一处的后果都很具体：
//   · 该拦没拦 → 配置里存了个用不了的路径，之后每次保存都失败；
//   · 不该拦却拦 → 用户连"先把配置记下来、待会修好权限"都做不到。

const probeOf = (patch) => ({
  path: 'C://cards',
  pathDisplay: 'C://cards',
  exists: true,
  created: false,
  writable: true,
  reason: null,
  ...patch,
});

test('判定：目录不存在 + 保存 → blocked（建不出来就别存）', () => {
  const decision = decideCardsDir(probeOf({ exists: false, writable: false, reason: '无法创建目录：拒绝访问' }), 'save');
  assert.equal(decision.state, 'blocked');
  assert.match(decision.message, /拒绝访问/, '原因要原样带给用户');
});

test('判定：目录不存在 + 刚选完 → 也 blocked', () => {
  assert.equal(decideCardsDir(probeOf({ exists: false, writable: false, reason: 'x' }), 'pick').state, 'blocked');
});

test('判定：目录不存在 + 只是打开面板 → info，且不阻断', () => {
  const decision = decideCardsDir(probeOf({ exists: false, writable: false, reason: '目录不存在' }), 'open');
  assert.equal(decision.state, 'info');
  assert.match(decision.message, /保存设置时会自动创建/);
});

test('判定：存在但不可写 + 保存 → warn（允许保存，但要说清后果）', () => {
  const decision = decideCardsDir(probeOf({ writable: false, reason: '目录不可写：只读文件系统' }), 'save');
  assert.equal(decision.state, 'warn');
  assert.match(decision.message, /已保存/);
  assert.match(decision.message, /保存卡片时会失败/);
});

test('判定：存在但不可写 + 刚选完 → warn，不写"已保存"（那时还没保存）', () => {
  const decision = decideCardsDir(probeOf({ writable: false, reason: 'x' }), 'pick');
  assert.equal(decision.state, 'warn');
  assert.doesNotMatch(decision.message, /已保存/);
});

test('判定：自动创建成功 → ok 且说明是这次创建的', () => {
  const decision = decideCardsDir(probeOf({ created: true }), 'save');
  assert.equal(decision.state, 'ok');
  assert.match(decision.message, /已创建/);
});

test('判定：一切正常 → ok', () => {
  assert.deepEqual(decideCardsDir(probeOf({}), 'save'), { state: 'ok', message: '目录可用。' });
});

test('判定：reason 缺失时不留 "undefined" 字样', () => {
  const decision = decideCardsDir(probeOf({ exists: false, reason: null }), 'save');
  assert.doesNotMatch(decision.message, /undefined|null/);
});
