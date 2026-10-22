/**
 * T9.1 角色卡 ID（F11）测试。
 *
 * ID 的语义只有两条，但都很关键：
 *   1. **创建后不可变** —— 服务端靠它认卡，改了等于换一张卡；
 *   2. **再次打开同一张卡，ID 必须不变** —— 否则同一个角色会散成多张卡。
 *
 * 第 2 条最容易漏：如果只在"新建时生成"，导入一张没有 ID 的卡每次打开都会拿到
 * 新 ID，服务端那边就会出现一堆内容相同、ID 不同的卡片。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createEmptyCard, parseStCard } from '@tcs/shared';

import {
  CARD_ID_MAX_LENGTH,
  findDuplicateCardId,
  generateCardId,
  readCardIdFromCard,
  slugifyCardName,
  validateCardId,
  withCardId,
} from '../client/src/session/card-id.ts';
import { CardSession, createBlankSession } from '../client/src/session/card-session.ts';

const SAMPLE = JSON.parse(readFileSync('test/fixtures/sample-card.json', 'utf8'));
const BASE_CARD = parseStCard(SAMPLE).card;

// ── 格式校验 ──────────────────────────────────────────────

test('校验：字母/数字/连字符的组合都通过', () => {
  for (const id of ['lin-wanzhao-001', 'abc', 'A1', 'card-2026-10-22', 'a'.repeat(CARD_ID_MAX_LENGTH)]) {
    const result = validateCardId(id);
    assert.equal(result.ok, true, `应通过：${id}`);
    assert.equal(result.id, id);
  }
});

test('校验：空与纯空白被拒，且原因可区分', () => {
  for (const id of ['', '   ', '\t']) {
    const result = validateCardId(id);
    assert.equal(result.ok, false);
    assert.equal(result.issue, 'empty');
  }
});

test('校验：中文/空格/路径非法字符一律拒绝', () => {
  const cases = [
    ['林晚照', 'bad-char'],
    ['lin wanzhao', 'bad-char'],
    ['lin/wanzhao', 'bad-char'],
    ['lin\\wanzhao', 'bad-char'],
    ['lin:wanzhao', 'bad-char'],
    ['lin?wanzhao', 'bad-char'],
    ['lin*wanzhao', 'bad-char'],
    ['lin.wanzhao', 'bad-char'],   // 点号也不允许：会被当成扩展名分隔
    ['lin_wanzhao', 'bad-char'],   // 下划线不在白名单里
  ];
  for (const [id, issue] of cases) {
    const result = validateCardId(id);
    assert.equal(result.ok, false, `不该通过：${id}`);
    assert.equal(result.issue, issue, `原因不对：${id}`);
  }
});

test('校验：拒绝信息里带出那个非法字符（比"格式不对"有用得多）', () => {
  const result = validateCardId('lin/wan');
  assert.equal(result.ok, false);
  assert.match(result.message ?? '', /\/|「/, '应指出具体是哪个字符');
});

test('校验：首尾连字符被拒（看起来像被截断的残值）', () => {
  for (const id of ['-abc', 'abc-', '-']) {
    const result = validateCardId(id);
    assert.equal(result.ok, false, `不该通过：${id}`);
  }
});

test('校验：超长被拒，且提示里带出上限与当前长度', () => {
  const result = validateCardId('a'.repeat(CARD_ID_MAX_LENGTH + 1));
  assert.equal(result.ok, false);
  assert.equal(result.issue, 'too-long');
  assert.match(result.message ?? '', new RegExp(String(CARD_ID_MAX_LENGTH)));
});

test('校验：首尾空白会被 trim 掉再判（用户复制粘贴常带空格）', () => {
  const result = validateCardId('  lin-001  ');
  assert.equal(result.ok, true);
  assert.equal(result.id, 'lin-001');
});

test('校验：不做大小写归一（避免"明明一样却说不同"）', () => {
  const result = validateCardId('Lin-WanZhao-001');
  assert.equal(result.ok, true);
  assert.equal(result.id, 'Lin-WanZhao-001', '不该被静默转成小写');
});

// ── 自动生成 ──────────────────────────────────────────────

test('生成：英文名 slug 化后拼随机后缀', () => {
  const id = generateCardId('Lin Wanzhao');
  assert.match(id, /^lin-wanzhao-[a-z0-9]{4}$/, `实际：${id}`);
  assert.equal(validateCardId(id).ok, true, '生成的 ID 必须自身合法');
});

test('生成：中文名退回 card 前缀（slug 化得不到 ASCII）', () => {
  const id = generateCardId('林晚照');
  assert.match(id, /^card-[a-z0-9]{4}$/, `实际：${id}`);
  assert.equal(validateCardId(id).ok, true);
});

test('生成：空名也能生成合法 ID', () => {
  const id = generateCardId('');
  assert.equal(validateCardId(id).ok, true);
});

test('生成：连续调用不重复（同名卡不会撞 ID）', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) ids.add(generateCardId('林晚照'));
  // 4 位 36 进制 = 168 万种；200 次抽样撞车概率极低，留一点余量判断"机制生效"
  assert.ok(ids.size >= 195, `200 次生成出现过多重复：${ids.size} 个唯一值`);
});

test('slug：各种分隔符都压成单个连字符', () => {
  assert.equal(slugifyCardName('Lin   Wanzhao'), 'lin-wanzhao');
  assert.equal(slugifyCardName('Lin--Wanzhao'), 'lin-wanzhao');
  assert.equal(slugifyCardName('Lin_Wan.zhao'), 'lin-wan-zhao');
  assert.equal(slugifyCardName('---abc---'), 'abc');
});

test('slug：纯符号/纯中文退回 card', () => {
  assert.equal(slugifyCardName('!!!'), 'card');
  assert.equal(slugifyCardName('林晚照'), 'card');
  assert.equal(slugifyCardName(''), 'card');
});

test('slug：长名被截断且不以连字符结尾（否则拼出来的 ID 会带 -xxxx 变双连字符）', () => {
  const slug = slugifyCardName('a'.repeat(38) + ' tail');
  assert.ok(slug.length <= 40, `过长：${slug.length}`);
  assert.ok(!slug.endsWith('-'), `不该以连字符结尾：${slug}`);
});

// ── 读写 extensions ───────────────────────────────────────

test('读取：没有 extensions 时返回 null（不抛）', () => {
  assert.equal(readCardIdFromCard({}), null);
  assert.equal(readCardIdFromCard({ passthrough: {} }), null);
  assert.equal(readCardIdFromCard({ passthrough: { data: {} } }), null);
});

test('读取：extensions 形状怪异时返回 null（导入的卡什么形状都可能有）', () => {
  const weird = [
    { passthrough: { data: { extensions: 'not-an-object' } } },
    { passthrough: { data: { extensions: [] } } },
    { passthrough: { data: { extensions: { tcs: 'nope' } } } },
    { passthrough: { data: { extensions: { tcs: { cardId: 123 } } } } },
    { passthrough: { data: { extensions: { tcs: {} } } } },
  ];
  for (const card of weird) {
    assert.equal(readCardIdFromCard(card), null, `应返回 null：${JSON.stringify(card)}`);
  }
});

test('读取：手改过的非法 ID 当作没有（否则会在服务端造出无法寻址的卡）', () => {
  const card = { passthrough: { data: { extensions: { tcs: { cardId: '有中文' } } } } };
  assert.equal(readCardIdFromCard(card), null);
});

test('写入：往返一致', () => {
  const withId = withCardId(BASE_CARD, 'lin-001');
  assert.equal(readCardIdFromCard(withId), 'lin-001');
});

test('写入：不改动传入的对象（不可变更新）', () => {
  const before = JSON.stringify(BASE_CARD);
  withCardId(BASE_CARD, 'lin-001');
  assert.equal(JSON.stringify(BASE_CARD), before, '传入的卡被就地修改了');
});

test('写入：保留 extensions 里其它工具的键（不能整块覆盖）', () => {
  const card = {
    ...BASE_CARD,
    passthrough: {
      ...BASE_CARD.passthrough,
      data: {
        ...BASE_CARD.passthrough.data,
        extensions: { otherTool: { keep: 'me' }, tcs: { note: 'keep this too' } },
      },
    },
  };
  const withId = withCardId(card, 'lin-002');
  const data = withId.passthrough.data;
  const ext = data['extensions'];
  assert.deepEqual(ext['otherTool'], { keep: 'me' }, '别的工具的键丢了');
  assert.equal(ext['tcs']['note'], 'keep this too', 'tcs 下的其它键丢了');
  assert.equal(ext['tcs']['cardId'], 'lin-002');
});

test('写入：非法 ID 直接抛（不能带着坏 ID 进会话）', () => {
  assert.throws(() => withCardId(BASE_CARD, '有中文'), /不合法/);
  assert.throws(() => withCardId(BASE_CARD, ''), /不合法/);
});

// ── 会话集成 ──────────────────────────────────────────────

test('会话：显式传入的 ID 被采用', () => {
  const session = new CardSession({ card: BASE_CARD, cardId: 'lin-001' });
  assert.equal(session.cardId, 'lin-001');
});

test('会话：传入非法 ID 时构造失败（快速失败，不留半成品会话）', () => {
  assert.throws(() => new CardSession({ card: BASE_CARD, cardId: '有中文' }), /不合法/);
});

test('会话：卡里已有 ID 时优先用它（保证再次打开同一张卡 ID 不变）', () => {
  const cardWithId = withCardId(BASE_CARD, 'lin-persisted');
  const session = new CardSession({ card: cardWithId });
  assert.equal(session.cardId, 'lin-persisted', '没有沿用卡里已有的 ID');
});

test('会话：卡里没有 ID 时自动生成，且合法', () => {
  const session = new CardSession({ card: BASE_CARD });
  assert.ok(session.cardId.length > 0);
  assert.equal(validateCardId(session.cardId).ok, true);
});

test('会话：自动生成的 ID 在同一张卡上稳定（构造两次、同一卡数据）', () => {
  // 注意：这里测的是"卡里已有 ID 时稳定"这条路径。
  // 卡里没有 ID 时每次构造都会生成新的 —— 那是刻意的，
  // 因为此时还没有任何东西把它固定下来，落盘/上传时要回填。
  const cardWithId = withCardId(BASE_CARD, 'stable-001');
  assert.equal(new CardSession({ card: cardWithId }).cardId, 'stable-001');
  assert.equal(new CardSession({ card: cardWithId }).cardId, 'stable-001');
});

test('会话：两个会话的 ID 互不相同（避免串卡）', () => {
  const a = new CardSession({ card: BASE_CARD });
  const b = new CardSession({ card: BASE_CARD });
  assert.notEqual(a.cardId, b.cardId);
});

test('会话：ID 不可变 —— 没有任何修改入口', () => {
  const session = new CardSession({ card: BASE_CARD, cardId: 'fixed-001' });
  // 运行时检查：对象上没有 setCardId 之类的方法
  assert.equal(typeof session['setCardId'], 'undefined');
  // getter 返回的是值，改它不影响内部状态
  session.cardId.toUpperCase();
  assert.equal(session.cardId, 'fixed-001');
});

test('会话：改内容/改规则都不影响 ID', () => {
  const session = new CardSession({ card: BASE_CARD, cardId: 'keep-me' });
  session.setBlockText('personality', '改了内容');
  session.setName('改了名字');
  session.setPlatformId('janitorai');
  session.setPresetId('divider');
  session.markSaved('D:/x.json');
  assert.equal(session.cardId, 'keep-me');
});

test('新建空白会话：也带合法 ID', () => {
  const session = createBlankSession({ name: '林晚照' });
  assert.equal(validateCardId(session.cardId).ok, true);
  assert.match(session.cardId, /^card-[a-z0-9]{4}$/, `中文名应退回 card 前缀：${session.cardId}`);
});

test('新建空白会话：可显式指定 ID', () => {
  const session = createBlankSession({ name: '林晚照', cardId: 'lin-wanzhao-001' });
  assert.equal(session.cardId, 'lin-wanzhao-001');
});

// ── 重复检测 ──────────────────────────────────────────────

test('重复检测：命中时返回已有的那个 ID（原样，不是小写）', () => {
  const open = ['lin-001', 'abc-002'];
  assert.equal(findDuplicateCardId('lin-001', open), 'lin-001');
  assert.equal(findDuplicateCardId('ABC-002', open), 'abc-002', '大小写不同也应视为同一张卡');
  assert.equal(findDuplicateCardId('not-there', open), null);
  assert.equal(findDuplicateCardId('', open), null);
});

test('重复检测：只提示不拒绝 —— 所以候选值原样参与比较，不做归一', () => {
  // 同一批里同时存在大小写变体时，返回第一个匹配到的
  const open = ['Lin-001', 'lin-001'];
  const hit = findDuplicateCardId('LIN-001', open);
  assert.equal(hit, 'Lin-001');
});
