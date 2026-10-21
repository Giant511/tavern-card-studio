/**
 * T6.7 对真实服务端的操作证据（可复跑）。
 * 用客户端真实的 sync 层（server-sync.ts）走一遍：上传 → 历史 → 回滚。
 */
import { readFileSync } from 'node:fs';
import { parseStCard, loadPresets } from '../shared/dist/index.js';
import { buildExportAsync } from '../client/src/export/export-card.ts';
import { listVersions, rollbackCard, uploadCard, fetchVersionText } from '../client/src/sync/server-sync.ts';
import { probeServer, isSyncReady } from '../client/src/net/server-probe.ts';

// 不硬编码令牌（会随仓库外泄）：从环境变量读，或命令行参数传
const CFG = {
  serverUrl: process.env['TCS_SERVER_URL'] ?? process.argv[2] ?? 'http://127.0.0.1:8730',
  token: process.env['TCS_TOKEN'] ?? process.argv[3] ?? '',
};
if (!CFG.token) {
  console.error('缺少令牌。用法：');
  console.error('  TCS_SERVER_URL=http://127.0.0.1:8730 TCS_TOKEN=xxx node scripts/verify-sync-live.mjs');
  console.error('  或：node scripts/verify-sync-live.mjs http://127.0.0.1:8730 <token>');
  process.exit(2);
}
const preset = loadPresets([JSON.parse(readFileSync('rules/presets/default.json','utf8'))]).presets[0];
const card = parseStCard(JSON.parse(readFileSync('test/fixtures/sample-card.json','utf8'))).card;

const log = (...a) => console.log(...a);

// 0. 连通性（复用 T6.8 判据）
const probe = await probeServer(CFG);
log('[0] isSyncReady =', isSyncReady(probe), '|', probe.message);

// 1. 上传（新建卡）
const art = await buildExportAsync(card, preset, 'json');
const up1 = await uploadCard(CFG, { text: art.text, message: 'v1 初始上传', author: 't67-verify' });
log('[1] 上传新建: cardId=' + up1.cardId, 'seq=' + up1.seq, 'created=' + up1.created, 'sha256=' + up1.sha256.slice(0,12));

// 2. 追加版本（改内容）
const edited = structuredClone(card);
const b = edited.blocks.find(x => x.id === 'basic');
b.text = b.text + '\n备注：这是第二个版本新增的一行。';
b.dirty = true;
const art2 = await buildExportAsync(edited, preset, 'json');
const up2 = await uploadCard(CFG, { text: art2.text, cardId: up1.cardId, message: 'v2 修改基本信息', author: 't67-verify' });
log('[2] 上传新版本: seq=' + up2.seq, 'sha256=' + up2.sha256.slice(0,12));

// 3. 版本历史
const versions = await listVersions(CFG, up1.cardId);
log('[3] 版本历史 (' + versions.length + ' 条):');
for (const v of versions) log('     v' + v.seq, v.kind, v.sha256.slice(0,12), v.size + 'B', v.audit ? ('审计错' + v.audit.error + '/警' + v.audit.warning) : '');

// 4. 回滚到 v1
const rb = await rollbackCard(CFG, up1.cardId, 1, { message: '回滚到 v1', author: 't67-verify' });
log('[4] 回滚到 v1 → 新建 seq=' + rb.seq, 'sha256=' + rb.sha256.slice(0,12));

// 5. 校验回滚后的内容 == v1 内容
const back = await fetchVersionText(CFG, up1.cardId, 1);
log('[5] 取回 v1 内容字节数 =', new TextEncoder().encode(back).length, '| 与初始上传一致 =', back === art.text);

const versions2 = await listVersions(CFG, up1.cardId);
log('[6] 回滚后历史 (' + versions2.length + ' 条):', versions2.map(v => 'v' + v.seq).join(' '), '（只增不改）');
log('');
log('CARD_ID=' + up1.cardId);
