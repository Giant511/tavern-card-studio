/**
 * 导出 round-trip 证明：导出 TXT/JSON → 重新导入 → 内容一致。
 *
 * ── v0.1.3 / 6d 的两处修正 ──────────────────────────────────
 *
 * 1. **板块清单改为从 `BLOCK_IDS` 派生。** 原来写死
 *    `['basic','personality','settings','special','user']` —— 六个板块时代的残留，
 *    加板块后它照样"通过"，因为它压根不检查新板块。这类副本的失效方式就是静默：
 *    断言数对得上、输出全 PASS，而漏掉的板块无人知晓。
 * 2. **抽成可导入的 `runExportRoundtrip()`**，让 `test/` 跑同一份断言（避免两份实现漂移）。
 *
 * 为什么这条要覆盖**全部**文本板块：round-trip 是"导出再用回来"的契约。
 * 新板块（对话示例 / 初始场景）走独立 ST 字段，它们的往返路径与 description 分段不同，
 * 只测老的五个等于把新路径排除在契约之外。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCK_IDS, WORLDBOOK_VISIBLE_KEYS, applyCardText, exportWorldbook, importWorldbook, loadPresets, parseStCard } from '../shared/dist/index.js';
import { buildJsonExport, buildTxtExport } from '../client/src/export/export-card.ts';

const ROOT = join(import.meta.dirname, '..');

/** 参与 round-trip 的文本板块（世界书走结构化路径，TXT 里是另一套格式，单独断言） */
const TEXT_IDS = BLOCK_IDS.filter((id) => id !== 'worldbook');

const textOf = (card, id) => (card.blocks.find((block) => block.id === id)?.text ?? '').trim();

/**
 * 世界书条目的"参与往返"投影。
 *
 * 用 `WORLDBOOK_VISIBLE_KEYS` 而不是整条 entry：TXT 格式**只承载这些字段**
 * （`extensions` 之类是 JSON 专有的，写进 TXT 会变成一个格式里没有的字段）。
 * 拿整条 entry 去比会让"TXT 无损"这条断言永远不可能成立，而错的是判据不是实现。
 *
 * `id` 也**不参与**：它是锚点，导入时可能重新编号；比 id 等于在比实现细节。
 */
const visibleEntry = (entry) => {
  const out = {};
  for (const key of WORLDBOOK_VISIBLE_KEYS) {
    const value = entry[key];
    if (value === undefined || value === null) continue;
    // TXT 里所有字段都是文本，`position` 这类数字会以 `"0"` 的形式回来。
    // 统一按字符串比较，避免"格式决定了类型"这件事变成一条假的 round-trip 失败。
    out[key] = Array.isArray(value) ? value : String(value);
  }
  return out;
};

const entryDigest = (entries) => JSON.stringify(entries.map(visibleEntry));

/** @returns {{checks: {ok: boolean, label: string, detail: string}[], failures: number}} */
export function runExportRoundtrip() {
  const checks = [];
  const check = (ok, label, detail = '') => checks.push({ ok, label, detail });

  const preset = loadPresets([
    JSON.parse(readFileSync(join(ROOT, 'rules/presets/default.json'), 'utf8')),
  ]).presets[0];
  const card = parseStCard(
    JSON.parse(readFileSync(join(ROOT, 'test/fixtures/sample-card.json'), 'utf8')),
  ).card;

  // ── JSON round-trip ──
  const json = buildJsonExport(card, preset);
  const fromJson = parseStCard(JSON.parse(json.text)).card;
  for (const id of TEXT_IDS) {
    check(textOf(fromJson, id) === textOf(card, id), `JSON·${id} 一致`, textOf(card, id).slice(0, 24));
  }
  check(
    fromJson.worldbook.entries.length === card.worldbook.entries.length,
    'JSON·世界书条目数一致',
    `${String(fromJson.worldbook.entries.length)}/${String(card.worldbook.entries.length)}`,
  );

  // ── TXT round-trip ──
  const txt = buildTxtExport(card, preset);
  const applied = applyCardText(card, txt.text, preset, { mode: 'lenient' });
  check(applied.ok, 'TXT 能被重新导入');
  for (const id of TEXT_IDS) {
    check(textOf(applied.card, id) === textOf(card, id), `TXT·${id} 一致`, textOf(card, id).slice(0, 24));
  }

  /*
   * ── 世界书 round-trip（第三种格式）────────────────────────
   *
   * v0.1.3 收尾时补上：原来这里只比"条目数一致"。条目数对得上，内容却可能
   * 整段丢失（改名、换关键词、正文被压缩）—— 而那是世界书最要紧的部分。
   * 现在 JSON 与 TXT 两条路径都逐条比对可见字段。
   *
   * 这也是需求里"三格式 × 八板块"的那个"世界书格式"：五个文本板块 +
   * 世界书 + 对话示例 + 初始场景 = 八个。
   */
  const wbEntries = card.worldbook.entries;
  check(wbEntries.length > 0, '世界书样本有条目（否则下面两条断言是空转）', `${String(wbEntries.length)} 条`);

  const wbJson = exportWorldbook({ format: 'json', entries: wbEntries, meta: {} });
  const wbJsonBack = importWorldbook(wbJson.text);
  check(wbJsonBack.ok, '世界书 JSON 能被重新导入');
  check(
    entryDigest(wbJsonBack.entries) === entryDigest(wbEntries),
    '世界书 JSON 逐条一致（可见字段）',
    `${String(wbEntries.length)} 条`,
  );

  const wbTxt = exportWorldbook({ format: 'txt', entries: wbEntries });
  const wbTxtBack = importWorldbook(wbTxt.text);
  check(wbTxtBack.ok, '世界书 TXT 能被重新导入');
  check(
    entryDigest(wbTxtBack.entries) === entryDigest(wbEntries),
    '世界书 TXT 逐条一致（可见字段）',
    `${String(wbEntries.length)} 条`,
  );

  return { checks, failures: checks.filter((item) => !item.ok).length };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { checks, failures } = runExportRoundtrip();
  for (const item of checks) {
    console.log(`${item.ok ? '  PASS ' : '  FAIL '}${item.label}${item.detail === '' ? '' : `  — ${item.detail}`}`);
  }
  console.log(
    failures === 0
      ? `全部通过（${String(checks.length)} 项）`
      : `失败 ${String(failures)} 项（共 ${String(checks.length)} 项）`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
