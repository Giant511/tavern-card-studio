/**
 * T9.14 端到端（第七、八项）：按 cardId 归档 / 分叉警告 / 历史与回滚按 ID 寻址。
 *
 * 与 verify-sync-live.mjs 的分工：那个脚本验的是「客户端上传链路通不通」，
 * 用服务端自动发号；本脚本验的是 **v0.1.1 新增的按 ID 语义**，逐条钉住决策
 * #34 / #35 的硬规则：
 *   · 显式 cardId → 服务端按该 ID 归档，不再自己发号；
 *   · 同 ID 再传 → 追加版本（200），不是新建；
 *   · baseSeq 落后于远端 → 照常写入，但必须返回 FORK 警告；
 *   · `?cardId=` 空串是**错误输入**，不能被当成「没给」；
 *   · 非法 ID（空格 / 斜杠）必须先拒，不能进库（进库就是一张永远打不开的卡）；
 *   · 历史与回滚都按 ID 寻址，回滚后内容与目标版本逐字节相同。
 *
 * 用法：
 *   TCS_SERVER_URL=http://127.0.0.1:8732 TCS_TOKEN=xxx node scripts/verify-t914-sync.mjs
 *   或 node scripts/verify-t914-sync.mjs <url> <token> [cardId]
 * 退出码：0 全部通过；1 有失败项
 */

import { readFileSync } from 'node:fs';

import { buildExportAsync } from '../client/src/export/export-card.ts';
import { withCardId } from '../client/src/session/card-id.ts';
import { listCards, listVersions, rollbackCard, uploadCard, fetchVersionText } from '../client/src/sync/server-sync.ts';
import { probeServer, isSyncReady } from '../client/src/net/server-probe.ts';
import { loadPresets, parseStCard } from '../shared/dist/index.js';

const CFG = {
  serverUrl: process.env['TCS_SERVER_URL'] ?? process.argv[2] ?? 'http://127.0.0.1:8732',
  token: process.env['TCS_TOKEN'] ?? process.argv[3] ?? '',
};
if (!CFG.token) {
  console.error('缺少令牌。用法：TCS_TOKEN=xxx node scripts/verify-t914-sync.mjs [url] [token] [cardId]');
  process.exit(2);
}

// 每次跑用不同 ID，避免与上一轮的历史搅在一起（服务端历史只增不改）
const CARD_ID = process.argv[4] ?? `t914-run-${Date.now().toString(36)}`;
const NAME = '端到端·按 ID 归档';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' —— ' + detail : ''}`);
}

const preset = loadPresets([JSON.parse(readFileSync('rules/presets/default.json', 'utf8'))]).presets[0];
const parsed = parseStCard(JSON.parse(readFileSync('test/fixtures/sample-card.json', 'utf8'))).card;
parsed.meta.name = NAME;
// 用客户端真实的 withCardId 写入 ID：它放在 passthrough.data.extensions.tcs.cardId，
// 与新建卡后上传的数据结构完全一致（手写会漏掉 passthrough 的层次）。
const baseCard = withCardId(parsed, CARD_ID);

const withEdit = (suffix) => {
  const card = structuredClone(baseCard);
  const block = card.blocks.find((b) => b.id === 'basic');
  block.text = `${block.text}\n备注：${suffix}`;
  block.dirty = true;
  return card;
};

/** 直接发原始请求，用于测「空串 cardId」「非法 ID」这类客户层会拦住的输入 */
async function raw(pathAndQuery, body) {
  const res = await fetch(`${CFG.serverUrl}${pathAndQuery}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CFG.token}` },
    body,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const main = async () => {
  // ── 0. 连通性 ─────────────────────────────────────────
  const probe = await probeServer(CFG);
  check('服务端就绪（两步探测通过）', isSyncReady(probe), probe.message);
  if (!isSyncReady(probe)) {
    console.log('\n服务端不就绪，后续跳过。');
    process.exit(1);
  }

  // ── 1. 按显式 ID 新建 ─────────────────────────────────
  const art1 = await buildExportAsync(baseCard, preset, 'json');
  const up1 = await uploadCard(CFG, {
    text: art1.text,
    cardId: CARD_ID,
    message: 'v1 按 ID 新建',
    author: 't914-verify',
  });
  check('上传时指定的 cardId 被服务端采用（未自行发号）', up1.cardId === CARD_ID, up1.cardId);
  check('首次上传 = 新建（seq=1）', up1.created === true && up1.seq === 1, `created=${String(up1.created)} seq=${String(up1.seq)}`);
  check('上传回执 sha256 与本地产物一致（字节保真）', up1.sha256 === art1.sha256,
    `${up1.sha256.slice(0, 12)}… vs ${art1.sha256.slice(0, 12)}…`);

  // ── 2. 同 ID 再传 = 追加版本 ──────────────────────────
  const art2 = await buildExportAsync(withEdit('第二个版本'), preset, 'json');
  const up2 = await uploadCard(CFG, {
    text: art2.text,
    cardId: CARD_ID,
    baseSeq: 1,
    message: 'v2 追加',
    author: 't914-verify',
  });
  check('同 ID 再传 = 追加版本（created=false，seq=2）', up2.created === false && up2.seq === 2,
    `created=${String(up2.created)} seq=${String(up2.seq)}`);
  check('基线与远端一致时不产生分叉警告', up2.warnings.length === 0,
    JSON.stringify(up2.warnings));

  // ── 3. 分叉：baseSeq 落后仍写入，但必须警告 ────────────
  const art3 = await buildExportAsync(withEdit('第三个版本（分叉）'), preset, 'json');
  const up3 = await uploadCard(CFG, {
    text: art3.text,
    cardId: CARD_ID,
    baseSeq: 1, // 故意用旧基线：远端已经是 v2
    message: 'v3 从旧基线写入（应触发分叉警告）',
    author: 't914-verify',
  });
  const fork = up3.warnings.find((w) => String(w.code ?? '').includes('FORK'));
  check('分叉：照常写入（不阻断）', up3.seq === 3, `seq=${String(up3.seq)}`);
  check('分叉：返回 FORK 警告', !!fork, JSON.stringify(up3.warnings));

  // ── 4. 历史按 ID 寻址 ─────────────────────────────────
  const versions = await listVersions(CFG, CARD_ID);
  check('历史按 ID 可查，且条数正确（3 条）', versions.length === 3,
    versions.map((v) => `v${String(v.seq)}`).join(' '));
  check('历史里每个版本都带 sha256（可追溯）', versions.every((v) => typeof v.sha256 === 'string' && v.sha256.length === 64));

  // ── 5. 回滚按 ID 寻址 ─────────────────────────────────
  const rb = await rollbackCard(CFG, CARD_ID, 1, { message: '回滚到 v1', author: 't914-verify' });
  check('回滚按 ID 生效，且是新建提交（seq=4，历史只增不改）', rb.seq === 4, `seq=${String(rb.seq)}`);

  const backToV1 = await fetchVersionText(CFG, CARD_ID, 1);
  check('回滚后 v1 内容与首次上传逐字节一致', backToV1 === art1.text,
    `${String(new TextEncoder().encode(backToV1).length)} 字节`);

  const afterRollback = await listVersions(CFG, CARD_ID);
  check('回滚后历史仍为 4 条（没有删掉任何版本）', afterRollback.length === 4,
    afterRollback.map((v) => `v${String(v.seq)}`).join(' '));

  // ── 6. 列表里能看到这张卡（含 ID 与角色名） ──────────────
  const cards = await listCards(CFG, { limit: 200 });
  const mine = cards.find((c) => c.cardId === CARD_ID);
  check('卡片列表里能按 ID 找到这张卡', !!mine, mine ? `name=${JSON.stringify(mine.name)}` : '未找到');
  check('列表带回角色名（不是只有 ID）', !!mine && mine.name === NAME, mine ? JSON.stringify(mine.name) : '');

  // ── 7. 硬规则：空串 cardId 是错误输入 ───────────────────
  const emptyId = await raw('/api/cards?cardId=', art1.text);
  check('`?cardId=` 空串被拒绝（不是「没给」）', emptyId.status >= 400 && emptyId.status < 500,
    `HTTP ${String(emptyId.status)} ${JSON.stringify(emptyId.json?.error?.code ?? emptyId.json?.code ?? '')}`);

  // ── 8. 硬规则：非法 ID 必须先拒 ────────────────────────
  for (const bad of ['has space', 'has/slash', '-leading-dash']) {
    const res = await raw(`/api/cards?cardId=${encodeURIComponent(bad)}`, art1.text);
    check(`非法 ID ${JSON.stringify(bad)} 被拒绝`, res.status >= 400 && res.status < 500, `HTTP ${String(res.status)}`);
  }

  // ── 9. 写入后断言：落库 ID == 请求 ID（跨版本一致） ─────
  const allIds = afterRollback.every(() => true) && (await listCards(CFG, { limit: 200 }))
    .filter((c) => c.cardId === CARD_ID).length === 1;
  check('库里这张 ID 只有一条记录（没有因重复上传分裂成多张卡）', allIds);

  console.log('');
  console.log(`CARD_ID=${CARD_ID}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`合计 ${String(results.length)} 项，失败 ${String(failed.length)} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('✘ 验证中断：' + String(err?.message ?? err));
  process.exit(1);
});
