/**
 * T9.1 会话模型（CardSession）测试。
 *
 * 这一层的价值全在**隔离性**上：多标签并行编辑时，只要有一处状态是共享的，
 * A 卡的编辑就会渗进 B 卡。所以本文件的重心不是「字段能不能读」，
 * 而是「两张卡真的互不影响吗」——包括深拷贝、不可变更新、脏标记独立、审计独立。
 *
 * 直接 import 客户端的 TS 模块（Node 22 类型剥离），测的就是 UI 要用的那份实现。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildAuditReport,
  createEmptyCard,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  resolvePlatformRule,
} from '@tcs/shared';

import {
  CardSession,
  DIRTY_MARK,
  UNNAMED_CARD_LABEL,
  createBlankSession,
} from '../client/src/session/card-session.ts';

const SAMPLE = JSON.parse(readFileSync('test/fixtures/sample-card.json', 'utf8'));
const parsed = parseStCard(SAMPLE);
const BASE_CARD = parsed.card;

// 平台规则有继承链（janitorai → ccv2），必须整组加载后按 id 解析
function loadAllPlatformRules() {
  const names = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'];
  const files = names.map((name) =>
    JSON.parse(readFileSync(new URL(`../rules/platforms/${name}.json`, import.meta.url), 'utf8')),
  );
  const loaded = loadPlatformRules(files);
  assert.equal(loaded.errors.length, 0, `平台规则应全部通过校验：${JSON.stringify(loaded.errors)}`);
  return loaded.rules;
}

const PLATFORM_RULES = loadAllPlatformRules();
const ST_RULE = resolvePlatformRule('sillytavern', PLATFORM_RULES);
const PRESETS = loadPresets(
  ['default', 'divider', 'markdown'].map((name) =>
    JSON.parse(readFileSync(new URL(`../rules/presets/${name}.json`, import.meta.url), 'utf8')),
  ),
).presets;

/** 造一个两会话场景：A、B 各自独立 */
function twoSessions() {
  const a = new CardSession({ card: BASE_CARD, id: 'A' });
  const b = new CardSession({ card: BASE_CARD, id: 'B' });
  return { a, b };
}

// ── 隔离性（核心）─────────────────────────────────────────

test('隔离：编辑 A 卡正文，B 卡内容与指纹都不变', () => {
  const { a, b } = twoSessions();
  const bBefore = b.fingerprint();

  const result = a.setBlockText('personality', 'A 卡专属的性格描述');
  assert.equal(result.changed, true);

  // A 变了
  assert.match(a.fingerprint(), /A 卡专属的性格描述/);
  // B 一点没动
  assert.equal(b.fingerprint(), bBefore, 'B 卡指纹被 A 卡的编辑污染了');
  assert.doesNotMatch(b.fingerprint(), /A 卡专属的性格描述/);
});

test('隔离：两张会话不共享任何 card 子对象（引用不同）', () => {
  const { a, b } = twoSessions();
  // 深拷贝的直接证据：同名字段但不是同一个对象
  assert.notEqual(a.card, b.card, 'a.card 与 b.card 指向同一对象');
  assert.notEqual(a.card.meta, b.card.meta, 'meta 被共享');
  assert.notEqual(a.card.blocks, b.card.blocks, 'blocks 被共享');
  assert.notEqual(a.card.worldbook, b.card.worldbook, 'worldbook 被共享');
  assert.notEqual(a.card.blocks[0], b.card.blocks[0], '板块对象被共享');
});

test('隔离：构造后修改调用方持有的原对象，不影响会话', () => {
  const source = createEmptyCard('原始名');
  const session = new CardSession({ card: source });

  // 直接改构造入参（模拟调用方误用）
  source.meta.name = '被外部改掉';
  source.blocks[0].text = '外部写入的正文';

  assert.equal(session.card.meta.name, '原始名', '会话读到了外部后续修改');
  assert.notEqual(session.card.blocks[0].text, '外部写入的正文', '正文被外部修改渗透');
});

test('隔离：replaceCard 之后，后续修改传入对象不影响会话', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  const incoming = createEmptyCard('替换名');
  session.replaceCard(incoming);

  incoming.meta.name = '又被改了';
  assert.equal(session.card.meta.name, '替换名');
});

test('隔离：会话内更新是「替换」而非「原地改」，旧引用拿不到新值', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  const before = session.card;
  session.setBlockText('personality', '新内容');

  // 不可变更新的直接证据：旧引用仍是旧内容
  assert.ok(before !== session.card, '更新后 card 引用未变（说明是原地修改）');
  assert.equal(session.card.blocks.find((b) => b.id === 'personality')?.text, '新内容');
});

test('隔离：A 卡切规则/改脏标记，B 卡状态不受影响', () => {
  const { a, b } = twoSessions();
  assert.equal(b.dirty, false);

  a.setBlockText('personality', '触发 A 变脏');
  a.setPlatformId('janitorai');
  a.setPresetId('divider');
  a.markSaved('C:/tmp/a.json');

  assert.equal(b.dirty, false, 'B 卡被连带置脏');
  assert.equal(b.platformId, 'sillytavern', 'B 卡平台规则被改');
  assert.equal(b.presetId, null, 'B 卡预设被改');
  assert.equal(b.filePath, null, 'B 卡文件路径被改');
});

test('隔离：三张卡交叉编辑，各卡内容互不串味', () => {
  const sessions = [
    new CardSession({ card: BASE_CARD, id: 'x' }),
    new CardSession({ card: BASE_CARD, id: 'y' }),
    new CardSession({ card: BASE_CARD, id: 'z' }),
  ];
  const marks = ['XYZ-X', 'XYZ-Y', 'XYZ-Z'];
  sessions.forEach((session, index) => {
    session.setBlockText('personality', marks[index]);
  });

  sessions.forEach((session, index) => {
    const text = session.card.blocks.find((b) => b.id === 'personality')?.text ?? '';
    assert.equal(text, marks[index], `${session.id} 卡内容串味`);
    // 其它两张的标记不应出现在自己身上
    marks.forEach((mark, other) => {
      if (other === index) return;
      assert.ok(!text.includes(mark), `${session.id} 卡混入了 ${mark}`);
    });
  });
});

// ── 脏标记 ────────────────────────────────────────────────

test('脏标记：新建会话是干净的（未动过就不该显示已修改）', () => {
  const session = new CardSession({ card: BASE_CARD });
  assert.equal(session.dirty, false);
  assert.ok(!session.label.includes(DIRTY_MARK));
});

test('脏标记：内容变更后置脏，标签出现 ●', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  session.setBlockText('personality', '改一下');
  assert.equal(session.dirty, true);
  assert.ok(session.label.endsWith(DIRTY_MARK), `标签应带脏标记，实际：${session.label}`);
});

test('脏标记：正文写入相同内容不算修改', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  const current = session.card.blocks.find((b) => b.id === 'personality')?.text ?? '';
  const result = session.setBlockText('personality', current);
  assert.equal(result.changed, false);
  assert.equal(session.dirty, false, '写回相同内容被误判为修改');
});

test('脏标记：markSaved 清除脏标记，并记住落盘路径', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  assert.equal(session.persisted, false);

  session.setBlockText('personality', '改动');
  session.markSaved('D:/cards/角色.json');

  assert.equal(session.dirty, false);
  assert.equal(session.persisted, true);
  assert.equal(session.filePath, 'D:/cards/角色.json');
  assert.ok(!session.label.includes(DIRTY_MARK));
});

test('脏标记：markSaved 不传路径时沿用原路径（保存而非另存）', () => {
  const session = new CardSession({ card: BASE_CARD, filePath: 'D:/a.json' });
  session.setBlockText('personality', '改');
  session.markSaved();
  assert.equal(session.filePath, 'D:/a.json');
  assert.equal(session.dirty, false);
});

test('脏标记：改名算内容变更', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setName('新名字');
  assert.equal(session.card.meta.name, '新名字');
  assert.equal(session.dirty, true);
});

test('脏标记：改成相同名字不置脏', () => {
  const session = new CardSession({ card: BASE_CARD });
  const name = session.card.meta.name;
  session.setName(name);
  assert.equal(session.dirty, false);
});

// ── 规则选择与脏标记的关系（容易判错的地方）───────────────

test('规则：切平台规则不置脏（只影响校验，不改变导出内容）', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setPlatformId('janitorai');
  assert.equal(session.platformId, 'janitorai');
  assert.equal(session.dirty, false, '切平台规则被误判为内容修改');
});

test('规则：切高亮方案不置脏（只影响着色）', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setHighlightId('dark');
  assert.equal(session.highlightId, 'dark');
  assert.equal(session.dirty, false);
});

test('规则：切 TXT 预设会置脏（预设决定导出标题与顺序，属于产出的一部分）', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setPresetId('divider');
  assert.equal(session.presetId, 'divider');
  assert.equal(session.dirty, true, '换预设应被视为内容变更');
});

test('规则：设为相同的值不产生副作用', () => {
  const session = new CardSession({ card: BASE_CARD, platformId: 'chub', highlightId: 'minimal' });
  session.setPlatformId('chub');
  session.setHighlightId('minimal');
  assert.equal(session.dirty, false);
});

// ── 审计缓存 ──────────────────────────────────────────────

test('审计：存入后可读，内容变更后立即过期', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'S' });
  const report = buildAuditReport(session.card, { platformRule: ST_RULE });
  session.setAudit(report);

  assert.ok(session.audit !== null, '刚存入的报告应可读');
  assert.equal(session.auditStale, false);
  assert.equal(session.audit?.issues.length, report.issues.length);

  session.setBlockText('personality', '改过之后审计就过期了');
  assert.equal(session.audit, null, '内容变更后仍返回旧报告');
  assert.equal(session.auditStale, true, '应标记为过期');
});

test('审计：切平台规则会使旧报告失效（结论按旧规则得出，不再适用）', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setAudit(buildAuditReport(session.card, { platformRule: ST_RULE }));
  assert.equal(session.auditStale, false);

  session.setPlatformId('janitorai');
  assert.equal(session.audit, null);
  assert.equal(session.auditStale, true);
});

test('审计：切高亮方案不影响审计（着色与校验无关）', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setAudit(buildAuditReport(session.card, { platformRule: ST_RULE }));
  session.setHighlightId('dark');
  assert.ok(session.audit !== null, '切高亮不该让审计失效');
  assert.equal(session.auditStale, false);
});

test('审计：没有缓存时 invalidate 不制造"过期"状态', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.invalidateAudit();
  assert.equal(session.auditStale, false, '从未审计过的会话不该显示"审计已过期"');
});

test('审计：重新审计后过期状态清除', () => {
  const session = new CardSession({ card: BASE_CARD });
  session.setAudit(buildAuditReport(session.card, { platformRule: ST_RULE }));
  session.setBlockText('personality', '改');
  assert.equal(session.auditStale, true);

  session.setAudit(buildAuditReport(session.card, { platformRule: ST_RULE }));
  assert.equal(session.auditStale, false);
  assert.ok(session.audit !== null);
});

// ── 显示名与标签 ──────────────────────────────────────────

test('标签：卡名为空显示「未命名」', () => {
  const session = createBlankSession({ id: 'blank' });
  assert.equal(session.displayName, UNNAMED_CARD_LABEL);
  assert.equal(session.label, UNNAMED_CARD_LABEL);
});

test('标签：纯空白卡名也算未命名（不能让标签看起来是空的）', () => {
  const session = new CardSession({ card: createEmptyCard('   ') });
  assert.equal(session.displayName, UNNAMED_CARD_LABEL);
});

test('标签：有卡名时显示卡名', () => {
  const session = new CardSession({ card: BASE_CARD });
  assert.equal(session.displayName, BASE_CARD.meta.name.trim());
});

test('标签：脏标记格式为「卡名 ●」', () => {
  const session = new CardSession({ card: createEmptyCard('测试卡') });
  session.setBlockText('personality', 'x');
  assert.equal(session.label, `测试卡 ${DIRTY_MARK}`);
});

// ── 未落盘状态（需求 F1.1）────────────────────────────────

test('未落盘：新建会话无文件路径，persisted=false', () => {
  const session = createBlankSession({ id: 'new-card' });
  assert.equal(session.filePath, null);
  assert.equal(session.persisted, false);
});

test('未落盘：空白会话有六个板块骨架，且 name 为空', () => {
  const session = createBlankSession();
  assert.equal(session.card.meta.name, '');
  // 五个文本板块在 blocks 里，世界书单独一段
  assert.equal(session.card.blocks.length, 5);
  assert.ok(session.card.worldbook !== undefined);
});

// ── 会话 id ───────────────────────────────────────────────

test('id：自动生成且互不相同', () => {
  const a = new CardSession({ card: BASE_CARD });
  const b = new CardSession({ card: BASE_CARD });
  assert.ok(a.id.length > 0);
  assert.notEqual(a.id, b.id);
});

test('id：可注入固定值（便于测试与调试）', () => {
  const session = new CardSession({ card: BASE_CARD, id: 'fixed-id' });
  assert.equal(session.id, 'fixed-id');
});

// ── 服务端关联（T9.6 前置）────────────────────────────────

test('同步：未落盘卡也可以建立服务端关联（需求 T9.6）', () => {
  const session = createBlankSession({ id: 'unpersisted' });
  assert.equal(session.persisted, false);
  session.setSyncCardId('card-23a4e7');
  assert.equal(session.syncCardId, 'card-23a4e7');
  // 建立关联不应改变落盘状态，也不该置脏
  assert.equal(session.persisted, false);
  assert.equal(session.dirty, false);
});

test('同步：关联互不影响', () => {
  const { a, b } = twoSessions();
  a.setSyncCardId('card-aaa');
  assert.equal(a.syncCardId, 'card-aaa');
  assert.equal(b.syncCardId, null);
});

// ── 指纹 ──────────────────────────────────────────────────

test('指纹：同源构造的两个会话指纹相同（内容一致）', () => {
  const { a, b } = twoSessions();
  assert.equal(a.fingerprint(), b.fingerprint());
});

test('指纹：落盘后再改内容，指纹与原内容不同（用于判断是否有未落盘改动）', () => {
  const session = new CardSession({ card: BASE_CARD });
  const saved = session.fingerprint();
  session.setBlockText('personality', '保存之后的改动');
  assert.notEqual(session.fingerprint(), saved);
});

test('指纹：改回原内容后指纹还原（内容级比较，不看操作历史）', () => {
  const session = new CardSession({ card: BASE_CARD });
  const original = session.fingerprint();
  const before = session.card.blocks.find((b) => b.id === 'personality')?.text ?? '';

  session.setBlockText('personality', '临时改动');
  session.setBlockText('personality', before);

  assert.equal(session.fingerprint(), original, '内容改回原样后指纹应一致');
});

test('指纹：与落盘用的序列化结果一致（同一套口径）', async () => {
  const { serializeCard } = await import('../client/src/editor/block-doc.ts');
  const session = new CardSession({ card: BASE_CARD });
  assert.equal(session.fingerprint(), serializeCard(session.card));
});

// ── 预设资产存在性（避免测试用不存在的 id 假通过）────────────

test('规则资产：测试引用的 preset id 真实存在', () => {
  const ids = PRESETS.map((preset) => preset.id);
  assert.ok(ids.includes('divider'), `divider 预设不存在，实际：${ids.join(',')}`);
});

// ── buildAuditReport 参数形状（防静默降级）──────────────────
//
// 这段是因为踩过一个真实的坑：把「平台规则对象」直接当 options 传，
// 运行时静默不校验平台规则，issue 里只剩格式检查，
// 看起来像"规则没生效"，会把排查方向带偏到规则文件上。
// 类型检查抓不到这一点 —— 测试文件是 .mjs。

test('参数形状：传规则对象而非 options 时响亮失败（不再静默跳过校验）', () => {
  assert.throws(
    () => buildAuditReport(BASE_CARD, ST_RULE),
    /options|platformRule/,
    '把规则对象当 options 传应该抛错',
  );
});

test('参数形状：传 null / 字符串 / 数字时抛错', () => {
  for (const bad of [null, 'rule', 42, true]) {
    assert.throws(() => buildAuditReport(BASE_CARD, bad), TypeError, '应拒绝：' + String(bad));
  }
});

test('参数形状：空对象与合法 options 仍然可用（不能过度收紧）', () => {
  assert.doesNotThrow(() => buildAuditReport(BASE_CARD, {}));
  assert.doesNotThrow(() => buildAuditReport(BASE_CARD, { platformRule: ST_RULE }));
  assert.doesNotThrow(() => buildAuditReport(BASE_CARD));
});

test('参数形状：错误信息里指明应该怎么传（便于一眼改对）', () => {
  try {
    buildAuditReport(BASE_CARD, ST_RULE);
    assert.fail('应该抛错');
  } catch (error) {
    assert.match(error.message, /platformRule/, '错误信息应给出正确用法');
  }
});
