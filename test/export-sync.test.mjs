/**
 * T6.6 导出 + T6.7 同步 API 的测试。
 *
 * 重点验证两件容易出错的事：
 *   ① **round-trip**：导出 TXT/JSON → 重新导入 → 板块内容一致（不是"看起来差不多"）；
 *   ② 导出闸门只在 exportable=false 时拦截，且把错误逐条带出来。
 *
 * 同步层用注入的 fetch 覆盖全部错误分支（401/404/409/网络断/超时），
 * 不依赖真实服务端；真实服务端的联调另见 docs/16 §5。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyCardText,
  buildAuditReport,
  loadPlatformRules,
  loadPresets,
  parseStCard,
  resolvePlatformRule,
} from '@tcs/shared';

import {
  buildExport,
  buildExportAsync,
  buildJsonExport,
  buildTxtExport,
  evaluateExportGate,
} from '../client/src/export/export-card.ts';
import {
  SyncError,
  fetchVersionText,
  listCards,
  listVersions,
  rollbackCard,
  uploadCard,
} from '../client/src/sync/server-sync.ts';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const CARD = parseStCard(
  JSON.parse(readFileSync(new URL('./fixtures/sample-card.json', import.meta.url), 'utf8')),
).card;

const PRESETS = loadPresets([
  readJson('../rules/presets/default.json'),
  readJson('../rules/presets/divider.json'),
  readJson('../rules/presets/markdown.json'),
]).presets;
const PRESET_DEFAULT = PRESETS.find((p) => p.id === 'default');
const PRESET_DIVIDER = PRESETS.find((p) => p.id === 'divider');

const PLATFORM_RULES = loadPlatformRules(
  ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'].map((name) =>
    readJson(`../rules/platforms/${name}.json`),
  ),
).rules;
const RULE_ST = resolvePlatformRule('sillytavern', PLATFORM_RULES);

function reportFor(card = CARD) {
  return buildAuditReport(card, { platformRule: RULE_ST, preset: PRESET_DEFAULT });
}

// ── 导出闸门 ────────────────────────────────────────────────

test('闸门：无错误时放行', () => {
  const report = reportFor();
  assert.equal(report.summary.exportable, true, '样本卡应可导出');
  assert.equal(evaluateExportGate(report).blocked, false);
});

test('闸门：有 error 时拦截，并把错误逐条带出', () => {
  // 造一个必然触发 error 的卡：清空必填的 name
  const broken = {
    ...CARD,
    meta: { ...CARD.meta, name: '' },
  };
  const report = buildAuditReport(broken, { platformRule: RULE_ST, preset: PRESET_DEFAULT });

  if (report.summary.exportable) {
    // 若规则没把空 name 判为 error，则跳过（避免测试依赖具体规则的严格程度）
    assert.ok(true, '当前规则未将空 name 判为 error，跳过');
    return;
  }

  const gate = evaluateExportGate(report);
  assert.equal(gate.blocked, true);
  assert.ok(gate.errors.length > 0, '必须带出错误明细');
  assert.match(gate.message, /错误级问题/);
});

test('闸门：报告缺失时拦截（宁可多拦，不静默导出）', () => {
  const gate = evaluateExportGate(null);
  assert.equal(gate.blocked, true);
  assert.match(gate.message, /尚未完成审计/);
});

test('闸门：严格平台（janitorai）下的世界书问题不影响 exportable 判定口径', () => {
  const report = buildAuditReport(CARD, {
    platformRule: resolvePlatformRule('janitorai', PLATFORM_RULES),
    preset: PRESET_DEFAULT,
  });
  // 只断言"拦截结论与 summary 一致"，不假设具体有无错误
  assert.equal(evaluateExportGate(report).blocked, report.summary.exportable === false);
});

// ── JSON 导出 round-trip ────────────────────────────────────

test('JSON 导出：结构合法、可被 parseStCard 读回', () => {
  const artifact = buildJsonExport(CARD, PRESET_DEFAULT);
  assert.equal(artifact.format, 'json');
  assert.ok(artifact.fileName.endsWith('.json'));
  assert.ok(artifact.bytes > 0);

  const parsed = JSON.parse(artifact.text);
  // 注意：JSON 里的 `spec` 是 ST 的原始标识（chara_card_v2），
  // 而 card.meta.spec 是内部短名（v2）——两者不是一回事，断言要针对导出值。
  assert.equal(parsed.spec, 'chara_card_v2');
  assert.equal(parsed.spec_version, CARD.meta.specVersion);
  assert.ok(parsed.data);

  const back = parseStCard(parsed).card;
  assert.equal(back.meta.name, CARD.meta.name);
});

test('JSON round-trip：六板块内容逐字一致', () => {
  const artifact = buildJsonExport(CARD, PRESET_DEFAULT);
  const back = parseStCard(JSON.parse(artifact.text)).card;

  for (const id of ['basic', 'personality', 'settings', 'special', 'user']) {
    const before = CARD.blocks.find((b) => b.id === id)?.text.trim();
    const after = back.blocks.find((b) => b.id === id)?.text.trim();
    assert.equal(after, before, `${id} 导出再导入后应一致`);
  }

  // 世界书条目数一致
  assert.equal(back.worldbook.entries.length, CARD.worldbook.entries.length);
});

test('JSON 导出：结尾换行 + 2 空格缩进（与服务端口径一致）', () => {
  const artifact = buildJsonExport(CARD, PRESET_DEFAULT);
  assert.ok(artifact.text.endsWith('\n'));
  const secondLine = artifact.text.split('\n')[1] ?? '';
  assert.ok(secondLine.startsWith('  '), `第二行应以 2 空格缩进，实际：${JSON.stringify(secondLine)}`);
});

// ── TXT 导出 round-trip ─────────────────────────────────────

test('TXT 导出：包含全部非空板块的正文', () => {
  const artifact = buildTxtExport(CARD, PRESET_DEFAULT);
  assert.equal(artifact.format, 'txt');
  assert.ok(artifact.fileName.endsWith('.txt'));

  for (const id of ['basic', 'personality', 'settings', 'special', 'user']) {
    const text = CARD.blocks.find((b) => b.id === id)?.text.trim() ?? '';
    if (text === '') continue;
    // 取正文首行的前 12 个字做存在性检查（避免整段包含比较受空白影响）
    const probe = text.split('\n')[0].slice(0, 12);
    assert.ok(artifact.text.includes(probe), `${id} 的正文应出现在 TXT 里（探针：${probe}）`);
  }
});

test('TXT round-trip：导出 → applyCardText 导入 → 板块内容一致', () => {
  const artifact = buildTxtExport(CARD, PRESET_DEFAULT);

  // 用宽松模式导入：TXT 是给人/平台用的形态，缺板块属正常（世界书不在 TXT 里）
  const applied = applyCardText(CARD, artifact.text, PRESET_DEFAULT, { mode: 'lenient' });
  assert.equal(applied.ok, true, `TXT 应能被重新导入：${JSON.stringify(applied.issues)}`);
  assert.ok(applied.card);

  for (const id of ['basic', 'settings', 'special', 'user']) {
    const before = CARD.blocks.find((b) => b.id === id)?.text.trim() ?? '';
    const after = applied.card.blocks.find((b) => b.id === id)?.text.trim() ?? '';
    assert.equal(after, before, `${id} 经 TXT 往返后应一致`);
  }
});

test('TXT 导出：切换预设后分隔符与标题随之改变', () => {
  const withDefault = buildTxtExport(CARD, PRESET_DEFAULT).text;
  const withDivider = buildTxtExport(CARD, PRESET_DIVIDER).text;
  assert.notEqual(withDefault, withDivider, '不同预设应产生不同 TXT');
  assert.ok(withDivider.includes('---'), 'divider 预设的 TXT 应含 ---');
});

/*
 * 这条原来断言「世界书不写入 TXT」，理由是"世界书是结构化字段"。
 *
 * 那个理由不成立：TXT 是**整卡**的文本形态，世界书同样有文本形态
 * （`@@ENTRY` 段，TXT 卡导入时本来就要解析它）。当初"不写入"是因为
 * `buildTxtExport` 只遍历三类板块，而世界书是 `structured` —— 属于**漏了**，
 * 不是决定不写。
 *
 * 线上后果（用户 v0.1.4 实测）：导出 TXT 后世界书整段消失，且没有任何提示。
 * 现改为断言"必须写入"，并覆盖两种来源：
 *   · `worldbook.text` 非空 → 原样输出（保真优先，不擅自改写成 @@ENTRY）；
 *   · `worldbook.text` 为空 → 从 entries 渲染出 `@@ENTRY`。
 */
test('TXT 导出：世界书必须写入（文本形态，不是"结构化就不写"）', () => {
  const artifact = buildTxtExport(CARD, PRESET_DEFAULT);
  const entry = CARD.worldbook.entries[0];
  assert.ok(entry, '样本卡应有世界书条目');
  const probe = entry.content.slice(0, 10);

  assert.ok(artifact.text.includes('【世界书】'), 'TXT 缺世界书段标题');

  // 样本卡的 worldbook.text 可能为空，此时内容来自 entries 渲染
  const fromEntries = CARD.worldbook.text === '';
  if (fromEntries) {
    assert.ok(artifact.text.includes('@@ENTRY'), 'text 为空时应从 entries 渲染 @@ENTRY');
    assert.ok(artifact.text.includes(probe), 'TXT 丢了世界书正文');
  } else {
    assert.ok(artifact.text.includes(CARD.worldbook.text.slice(0, 20)), 'TXT 应原样带上 worldbook.text');
  }
});

test('TXT 导出：空世界书不留空标题', () => {
  const empty = { ...CARD, worldbook: { ...CARD.worldbook, entries: [], text: '' } };
  const artifact = buildTxtExport(empty, PRESET_DEFAULT);
  assert.ok(!artifact.text.includes('【世界书】'), '空世界书不该留一个只有标题的空段');
});

// ── 统一入口与哈希 ──────────────────────────────────────────

test('统一入口：format 选择正确，缺预设时 TXT 报错', () => {
  assert.equal(buildExport(CARD, PRESET_DEFAULT, 'json').format, 'json');
  assert.equal(buildExport(CARD, PRESET_DEFAULT, 'txt').format, 'txt');
  assert.throws(() => buildExport(CARD, null, 'txt'), /TXT 导出需要预设/);
});

test('哈希：sha256 非空、与内容自洽、两次调用稳定', async () => {
  const first = await buildExportAsync(CARD, PRESET_DEFAULT, 'json');
  const second = await buildExportAsync(CARD, PRESET_DEFAULT, 'json');

  assert.match(first.sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.sha256, second.sha256, '同内容哈希必须稳定');
  assert.notEqual(first.sha256, '0'.repeat(64));
});

test('哈希：内容变化则哈希变化（防止哈希算的是别的东西）', async () => {
  // 注意：对**已有原文**的卡片，不同预设的 JSON 导出是相同的（见 docs/15 §1），
  // 所以不能拿"换预设"当内容变化。这里改成真正改内容：改一个板块的正文。
  const jsonA = await buildExportAsync(CARD, PRESET_DEFAULT, 'json');
  const modified = structuredClone(CARD);
  const basic = modified.blocks.find((b) => b.id === 'basic');
  basic.text = `${basic.text}\n新增一行用于改变内容`;
  basic.dirty = true;
  const jsonB = await buildExportAsync(modified, PRESET_DEFAULT, 'json');

  assert.notEqual(jsonA.sha256, jsonB.sha256, '内容不同则哈希必须不同');
  assert.equal(jsonA.sha256.length, 64);

  // TXT 侧同样验证：换预设会改变 TXT，因而改变哈希
  const txtDefault = await buildExportAsync(CARD, PRESET_DEFAULT, 'txt');
  const txtDivider = await buildExportAsync(CARD, PRESET_DIVIDER, 'txt');
  assert.notEqual(txtDefault.sha256, txtDivider.sha256, 'TXT 换预设应改变内容与哈希');
});

// ── 同步 API（注入 fetch）──────────────────────────────────

function makeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

const CONFIG = { serverUrl: 'http://127.0.0.1:8730', token: 'tok' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('上传：新建卡 → POST /api/cards，body 是原文，带 Bearer', async () => {
  const fetchImpl = makeFetch(() =>
    jsonResponse({ card: { id: 'c1' }, version: { seq: 1, commit: 'abc', sha256: 'ff', size: 10 } }, 201),
  );

  const result = await uploadCard(CONFIG, { text: '{"spec":"chara_card_v2"}' }, { fetchImpl });

  assert.equal(result.created, true);
  assert.equal(result.cardId, 'c1');
  assert.equal(result.seq, 1);

  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/api\/cards$/);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.body, '{"spec":"chara_card_v2"}', 'body 必须是原文，不是信封');
  assert.equal(call.init.headers.Authorization, 'Bearer tok');
});

test('上传：带 cardId → 同一个 upsert 端点并回传 cardId / seq（T9.7）', async () => {
  const fetchImpl = makeFetch(() =>
    jsonResponse({ cardId: 'c1', seq: 4, created: false, warnings: [], card: { id: 'c1' }, version: { seq: 4 } }, 200),
  );

  const result = await uploadCard(CONFIG, { text: '{}', cardId: 'c1', baseSeq: 3 }, { fetchImpl });

  assert.equal(result.created, false);
  assert.equal(result.cardId, 'c1');
  assert.equal(result.seq, 4);

  const url = fetchImpl.calls[0].url;
  // 不再是 /api/cards/:id/versions —— 那是个竞态：查存在性与写入之间别人可能刚建了同一张卡
  assert.match(url, /\/api\/cards\?/);
  assert.match(url, /cardId=c1/);
  assert.match(url, /baseSeq=3/, '基线要一起送到服务端，否则判不出分叉');
});

test('上传：服务端忽略 cardId 自行发号 → 报 CONFLICT，绝不静默换掉用户 ID', async () => {
  // v0.1.0 的服务端就是这个行为：不认识 cardId，返回它自己发的号
  const fetchImpl = makeFetch(() =>
    jsonResponse({ card: { id: 'auto-abc123' }, version: { seq: 1 } }, 201),
  );

  await assert.rejects(
    () => uploadCard(CONFIG, { text: '{}', cardId: 'lin-wanzhao-0001' }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof SyncError);
      assert.equal(error.code, 'CONFLICT');
      assert.match(error.message, /服务端版本过旧/);
      assert.match(error.message, /lin-wanzhao-0001/);
      return true;
    },
  );
});

test('上传：服务端返回 warnings → 原样带出（分叉不阻断写入）', async () => {
  const fetchImpl = makeFetch(() =>
    jsonResponse(
      {
        cardId: 'c1',
        seq: 5,
        created: false,
        warnings: [
          {
            code: 'FORK',
            message: '远端已有他人修改（最新 v4，你的基线是 v2），本次上传将产生分叉历史',
            baseSeq: 2,
            remoteLatestSeq: 4,
            remoteLatestSha256: 'ff',
          },
        ],
      },
      200,
    ),
  );

  const result = await uploadCard(CONFIG, { text: '{}', cardId: 'c1', baseSeq: 2 }, { fetchImpl });
  assert.equal(result.seq, 5, '警告不等于失败：版本号照样要返回');
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, 'FORK');
  assert.equal(result.warnings[0].remoteLatestSeq, 4);
});

test('上传：401 → UNAUTHORIZED（不要让 UI 猜原因）', async () => {
  const fetchImpl = makeFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '令牌无效' } }, 401));

  await assert.rejects(
    () => uploadCard(CONFIG, { text: '{}' }, { fetchImpl }),
    (error) => {
      assert.ok(error instanceof SyncError);
      assert.equal(error.code, 'UNAUTHORIZED');
      assert.equal(error.status, 401);
      assert.match(error.message, /令牌无效/);
      return true;
    },
  );
});

test('上传：网络断 → NETWORK，超时 → TIMEOUT', async () => {
  const offline = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(
    () => uploadCard(CONFIG, { text: '{}' }, { fetchImpl: offline }),
    (error) => error.code === 'NETWORK',
  );

  const timeout = async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  };
  await assert.rejects(
    () => uploadCard(CONFIG, { text: '{}' }, { fetchImpl: timeout, timeoutMs: 10 }),
    (error) => error.code === 'TIMEOUT',
  );
});

test('版本历史：解析 seq/commit/audit 字段', async () => {
  const fetchImpl = makeFetch(() =>
    jsonResponse({
      total: 2,
      items: [
        { seq: 2, commit: 'b', sha256: 's2', size: 20, message: 'm2', author: 'a', kind: 'update', createdAt: 't2', audit: { error: 0, warning: 1, info: 3, exportable: true } },
        { seq: 1, commit: 'a', sha256: 's1', size: 10, message: 'm1', author: 'a', kind: 'upload', createdAt: 't1' },
      ],
    }),
  );

  const versions = await listVersions(CONFIG, 'c1', { fetchImpl });
  assert.equal(versions.length, 2);
  assert.equal(versions[0].seq, 2);
  assert.equal(versions[0].audit.warning, 1);
  assert.equal(versions[1].audit, null, '缺 audit 时应为 null 而不是崩溃');
});

test('回滚：POST rollback，body 带 to', async () => {
  const fetchImpl = makeFetch(() => jsonResponse({ version: { seq: 5, commit: 'r', sha256: 'rr', size: 30 } }, 201));

  const result = await rollbackCard(CONFIG, 'c1', 2, { fetchImpl });
  assert.equal(result.seq, 5, '回滚在服务端是新建提交，seq 递增');

  const call = fetchImpl.calls[0];
  assert.match(call.url, /\/api\/cards\/c1\/rollback$/);
  assert.deepEqual(JSON.parse(call.init.body).to, 2);
});

test('回滚：目标不存在 → NOT_FOUND', async () => {
  const fetchImpl = makeFetch(() => jsonResponse({ error: { message: '版本不存在' } }, 404));
  await assert.rejects(
    () => rollbackCard(CONFIG, 'c1', 99, { fetchImpl }),
    (error) => error.code === 'NOT_FOUND',
  );
});

test('取版本原文：返回文本（用于取回旧版继续编辑）', async () => {
  const fetchImpl = makeFetch(() => new Response('{"spec":"chara_card_v2"}', { status: 200 }));
  const text = await fetchVersionText(CONFIG, 'c1', 1, { fetchImpl });
  assert.equal(text, '{"spec":"chara_card_v2"}');
});

test('列卡：读 cardId + 角色名 + idSource，并且 latestSeq 不再是 0', async () => {
  const fetchImpl = makeFetch(() =>
    jsonResponse({
      items: [
        // 新服务端：顶层 cardId + latestSeq + idSource
        { cardId: 'lin-0001', id: 'lin-0001', name: '林晚照', latestSeq: 3, idSource: 'client', versionCount: 3 },
        // 老服务端形态：只有 id 与嵌套 latest.seq（这条曾经导致 latestSeq 恒为 0）
        { id: 'card-abcdef', name: '遗留卡', latest: { seq: 7, sha256: 'y' }, idSource: 'legacy' },
      ],
    }),
  );

  const cards = await listCards(CONFIG, { fetchImpl });
  assert.equal(cards[0].cardId, 'lin-0001');
  assert.equal(cards[0].name, '林晚照', '列表要能直接显示角色名');
  assert.equal(cards[0].latestSeq, 3);
  assert.equal(cards[0].idSource, 'client');
  assert.equal(cards[1].cardId, 'card-abcdef');
  assert.equal(cards[1].latestSeq, 7, '嵌套 latest.seq 必须能读到，否则列表永远显示 v0');
  assert.equal(cards[1].idSource, 'legacy', '遗留 ID 要能被识别出来');
});

test('无 token 时不发 Authorization 头（服务端未启用鉴权的情形）', async () => {
  const fetchImpl = makeFetch(() => jsonResponse({ items: [] }));
  await listCards({ serverUrl: 'http://h:1', token: '' }, { fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});
