#!/usr/bin/env node
/**
 * 双样本审计冒烟（v0.1.3 / 6d）。
 *
 * ## 验的是什么
 *
 * 铁律：**历史卡片必须永远可审计。** 六板块时代（v0.1.2 及更早）的卡，
 * 在八板块版本的服务端上审计时：
 *   · 必须给出 `info`「旧格式卡片」；
 *   · **绝不能**出现 `error`（否则老卡被判"不可导出"，等于升级即坏）；
 *   · 也不能刷一屏 warning 说"两个板块缺失"。
 *
 * 同时反证：缺板块的卡**仍然**按既有语义报 —— 兼容不是靠放宽检查换来的。
 *
 * ## 两个样本怎么造
 *
 * 用**同一张卡的同一份内容**，只改 description 的分块形态，排除"样本本身不同"：
 *   样本 A（旧格式）：description 只含六个老标题（用 v0.1.2 的六板块预设渲染）
 *   样本 B（新格式）：description 含八个标题（用当前 default 预设渲染）
 *
 * 两者其余顶层字段完全相同，都转成 JSON 字节 —— 服务端收到的就是 JSON，
 * 所以**必须在 JSON 形态上验**。第一版脚本只接了 TXT 导入路径，而 `missing`
 * 标记只在 TXT 路径产生，导致旧格式判据在服务端根本不触发（双样本冒烟当场抓出）。
 *
 * ## 为什么走 AuditService 而不是 HTTP
 *
 * 服务端审计的全部判断都在 `AuditService.run(bytes)` 里，HTTP 只是包了一层
 * （解析请求体 → 调它 → 序列化响应）。离线直调覆盖同一段代码，
 * 且不依赖"本机有没有跑服务端"—— 否则这条验收在干净机器上永远跑不了。
 * HTTP 侧另有 smoke 脚本（live-server 类，见 scripts/lib/verify-inventory.mjs）。
 *
 * 用法：npm run build:server && node scripts/verify-audit-dual-sample.mjs
 * 退出码：0 全绿；1 有断言失败
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPresets, parseCardText, parseStCard, renderCardText } from '../shared/dist/index.js';
// 用编译产物而不是 .ts：Node 的类型剥离**不支持 TS 参数属性**
// （`constructor(private readonly x: T)`），而 server/src 里大量使用这种写法。
// 读 dist 还有额外好处：新鲜度由 check:dist 与 test/dist-freshness 双重守着。
import { AuditService } from '../server/dist/audit/service.js';
import { RuleRegistry } from '../server/dist/rules/registry.js';

const ROOT = join(import.meta.dirname, '..');

/**
 * v0.1.2 的六板块 default 预设，**已解析形态**。
 *
 * 关键：**不能走 parsePreset**。它会把六项 blockOrder 自动补齐成八项
 * （这正是 v0.1.3 要的兼容语义），于是 renderCardText 仍会渲染出两个新板块 ——
 * 那就不叫"六板块导出"了。所以这里直接构造已解析对象。
 */
function legacyPresetFrom(currentPreset) {
  const headings = {};
  // static-rule-allow: hardcoded-block-array —— v0.1.2 的历史格式，必须冻结
  for (const id of ['basic', 'personality', 'settings', 'special', 'user', 'worldbook']) {
    headings[id] = currentPreset.headings[id];
  }
  return {
    ...currentPreset,
    id: 'legacy-six',
    name: '默认（v0.1.2 六板块）',
    // static-rule-allow: hardcoded-block-array —— 同上：模拟当年那份预设
    blockOrder: ['basic', 'personality', 'settings', 'special', 'user', 'worldbook'],
    headings,
  };
}

/**
 * 拼出「服务端会收到的 JSON 字节」。
 *
 * 手工构造而不是调 `serializeStCard`：后者用卡里已有的 `description.raw`
 * （原始八板块文本），拿不到"换一套预设渲染"的形态。
 * 字段与 ST 规范一一对应。
 */
function toServerBytes(card, descriptionText, options = {}) {
  const block = (id) => card.blocks.find((item) => item.id === id)?.text ?? '';
  /*
   * `blankNewFields`（v0.1.5 / G3-1）：把 first_mes / mes_example / alternate_greetings
   * 全部写成空。
   *
   * 为什么需要：真正的"六板块旧格式卡"这两个板块**必然为空** —— 那时模型里
   * 还没有它们。而"description 只有六块标题、但字段有内容"的卡，其实是
   * **标准 SillyTavern 卡**（ST 把这两块放在顶层独立字段，从不写进 description）。
   * 两种形态必须分开造，否则会得出"标准 ST 卡也是旧卡"的错误结论。
   *
   * 第一版漏了 `alternate_greetings`：它的内容会渲染进「初始场景」板块，
   * 于是样本仍然"字段有内容"、仍然不报 legacy —— 一次很典型的
   * "样本没造干净，却看起来像实现有 bug"。
   */
  const blank = options.blankNewFields === true;
  const payload = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.meta.name,
      description: descriptionText,
      personality: block('personality'),
      scenario: card.residual.scenario,
      first_mes: blank ? '' : card.residual.firstMes,
      mes_example: blank ? '' : card.residual.mesExample,
      creator_notes: card.meta.creatorNotes,
      system_prompt: card.residual.systemPrompt,
      post_history_instructions: card.residual.postHistoryInstructions,
      alternate_greetings: blank ? [] : [...card.residual.alternateGreetings],
      tags: [...card.meta.tags],
      creator: card.meta.creator,
      character_version: card.meta.characterVersion,
    },
  };
  return Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** 从一个板块标题起、到下一个标题止，把该段从渲染结果里摘掉 */
function dropSection(text, heading) {
  const parts = text.split('\n\n');
  const kept = [];
  let skipping = false;
  for (const part of parts) {
    const isHeading = /^【[^】]+】/.test(part);
    if (isHeading) skipping = part.startsWith(heading);
    if (!skipping) kept.push(part);
  }
  return kept.join('\n\n');
}

/**
 * 构造双样本的**服务端字节**（离线断言与 HTTP 冒烟共用这一份）。
 *
 * 为什么抽出来：`scripts/verify-audit-http.mjs` 要把同样的两份字节 POST 到真实
 * 服务端。如果它自己再拼一遍样本，"离线绿、HTTP 红"时就分不清是实现坏了
 * 还是两份样本根本不是同一对 —— 而这条链的价值恰恰在于两条路径喂的是同一对字节。
 */
export function buildDualSamples() {
  const currentPreset = loadPresets([
    JSON.parse(readFileSync(join(ROOT, 'rules/presets/default.json'), 'utf8')),
  ]).presets[0];
  const legacyPreset = legacyPresetFrom(currentPreset);

  const raw = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/sample-card.json'), 'utf8'));
  const card = parseStCard(JSON.stringify(raw)).card;

  const legacyTxt = renderCardText(card, legacyPreset);
  const eightTxt = renderCardText(card, currentPreset);

  // 样本 A：六板块形态（摘掉两个新板块的标题段）
  const legacyDescription = dropSection(dropSection(legacyTxt, '【对话示例】'), '【初始场景】');
  // 样本 B：八板块形态（世界书走结构化字段，不留在 description 里）
  const eightDescription = dropSection(eightTxt, '【世界书】');

  return {
    card,
    currentPreset,
    legacyPreset,
    legacyTxt,
    eightTxt,
    /** 真·六板块旧卡：description 六块 + 两个新字段**为空** */
    legacyBytes: toServerBytes(card, legacyDescription, { blankNewFields: true }),
    /**
     * 标准 SillyTavern 卡（v0.1.5 / G3-1）：description 与旧卡**逐字节相同**，
     * 只有 first_mes / mes_example 有内容。它**不是**旧卡 —— 正是靠"字段有内容"
     * 与旧卡区分开，这条样本用来钉住"不许误报"。
     */
    stCardBytes: toServerBytes(card, legacyDescription),
    newBytes: toServerBytes(card, eightDescription),
  };
}

/** @returns {{checks: {ok: boolean, label: string, detail: string}[], failures: number}} */
export function runAuditDualSample() {
  const checks = [];
  const check = (ok, label, detail = '') => checks.push({ ok, label, detail });

  // ── 规则：用仓库里的 rules/（与服务端包内是同一份，另有 pack 一致性断言）──
  const registry = new RuleRegistry(join(ROOT, 'rules'));
  const sample = buildDualSamples();
  const { card, currentPreset, legacyPreset, legacyTxt, eightTxt } = sample;
  check(
    legacyPreset.blockOrder.length === 6,
    '六板块预设是 6 项（没有经过 parsePreset 的自动补齐）',
    String(legacyPreset.blockOrder.length),
  );

  // 服务端默认用 default 预设审计（部署时的默认值）
  const service = new AuditService(registry, { platformId: 'sillytavern', presetId: 'default' });

  // ── 两种导出形态（构造在 buildDualSamples 里，与 HTTP 冒烟共用）──
  check(
    !legacyTxt.includes('【对话示例】') && !legacyTxt.includes('【初始场景】'),
    '六板块渲染里确实没有两个新板块标题',
  );
  check(
    eightTxt.includes('【对话示例】') && eightTxt.includes('【初始场景】'),
    '八板块渲染里两个新标题都在（空板块也写标题，这正是旧/新形态的判据基础）',
  );

  // ── 样本 A：真正的六板块旧卡（两字段为空 + description 只有六块标题）──
  //
  // 直接用 `buildDualSamples()` 产出的字节，不在这里再拼一份 ——
  // 两份样本必须是同一对，否则"离线绿、HTTP 红"时分不清是谁的错。
  const legacyResult = service.run(sample.legacyBytes, {}, 'legacy-six-block');
  const legacyIssues = legacyResult.report.issues;

  check(
    legacyResult.report.summary.error === 0,
    '★铁律：六板块旧卡审计 error = 0',
    `实际 ${String(legacyResult.report.summary.error)} 条：` +
      legacyIssues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.ruleId}:${issue.message}`)
        .join('; '),
  );
  check(legacyResult.report.summary.exportable === true, '★铁律：六板块旧卡仍判为可导出');

  const legacyNotice = legacyIssues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block');
  check(legacyNotice.length === 1, '给了且只给一条「旧格式卡片」提示', `实际 ${String(legacyNotice.length)} 条`);
  check(
    legacyNotice[0]?.severity === 'info',
    '「旧格式卡片」是 info 级（不是 warning/error）',
    legacyNotice[0]?.severity ?? '缺失',
  );
  check(
    /六板块|旧格式/.test(legacyNotice[0]?.message ?? ''),
    '提示文案点明了「六板块 / 旧格式」',
    (legacyNotice[0]?.message ?? '').slice(0, 60),
  );
  check(
    legacyIssues.filter((issue) => issue.ruleId === 'builtin:block-missing').length === 0,
    '没有逐条报「板块缺失」（旧卡不该刷 warning）',
  );

  // ── 样本 A2：标准 SillyTavern 卡（六块 description + 两字段有内容）──
  //
  // v0.1.5 / G3-1 新增。这张卡与样本 A 的 description **完全相同**，只有
  // first_mes / mes_example 有内容 —— 而"有内容"恰恰说明它不是旧卡：
  // 旧卡这两个字段必然为空。两者在 JSON 上唯一的差别就是字段是否为空，
  // 所以旧判据（只看 description 标题）必然把它们判成同一类，误报就此产生。
  const stResult = service.run(sample.stCardBytes, {}, 'standard-st-card');
  const stIssues = stResult.report.issues;
  check(
    stIssues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block').length === 0,
    '★标准 ST 卡（两字段有内容）**不**报「不含对话示例/初始场景」',
    stIssues
      .filter((issue) => issue.ruleId === 'builtin:legacy-six-block')
      .map((issue) => issue.message)
      .join('; '),
  );
  check(
    stResult.report.summary.error === 0,
    '★标准 ST 卡审计 error = 0',
    stIssues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.ruleId)
      .join(','),
  );

  // ── 样本 B：八板块形态 ──
  const eightDescription = dropSection(eightTxt, '【世界书】');
  const eightResult = service.run(toServerBytes(card, eightDescription), {}, 'eight-block');
  const eightIssues = eightResult.report.issues;
  check(
    eightIssues.filter((issue) => issue.ruleId === 'builtin:legacy-six-block').length === 0,
    '八板块新卡**不**出现「旧格式卡片」提示（判据不误伤新卡）',
  );
  check(
    eightResult.report.summary.error === 0,
    '八板块新卡审计 error = 0（样本本身干净）',
    eightIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.ruleId).join(','),
  );

  // ── 反证一：检查对 JSON 卡依然有效（旧卡没被"一律放过"）──
  //
  // 拿 name 为空的同一张卡审计：平台规则要求名字必填，必须报 error。
  // 这条与"旧卡不报错"不矛盾 —— 旧卡是因为**格式旧**才不报，不是因为"卡都放过"。
  const noNameBytes = toServerBytes({ ...card, meta: { ...card.meta, name: '' } }, eightDescription);
  const noNameResult = service.run(noNameBytes, {}, 'no-name');
  check(
    noNameResult.report.summary.error > 0,
    '反证一：name 为空的卡仍报 error（检查没有被整体放宽）',
    noNameResult.report.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.ruleId)
      .join(','),
  );

  // ── 反证二：TXT 路径的"缺板块"语义不变 ──
  //
  // 注意 JSON 卡**没有"标题缺失"这个概念**：JSON 的 description 就是一段自由文本，
  // 缺一段标题不算错（要错也是平台规则的"必填字段为空"）。
  // 所以这里用 TXT 路径验 —— 那才是 `missing` 标记与 `block-missing` 的适用场景。
  const missingTxt = [
    '【基本信息】\n姓名：林晚照',
    '【性格】\n安静。',
    '【其他设定】\n普通设定。',
    '【用户相关设定】\n{{user}} 是熟客。',
  ].join('\n\n');
  const missingParsed = parseCardText(missingTxt, currentPreset, { mode: 'lenient' });
  const missingTxtIssues = missingParsed.issues.filter((issue) => issue.code === 'missing-block');
  check(
    missingTxtIssues.some((issue) => issue.blockId === 'special'),
    '反证二：TXT 缺【特殊设定】仍报 missing-block（既有语义不变）',
    missingTxtIssues.map((issue) => String(issue.blockId)).join(','),
  );
  check(
    missingTxtIssues.some((issue) => issue.blockId === 'special' && issue.severity === 'warning'),
    '反证二的严重级仍是 warning（不是 info）',
  );
  // 而两个字段板块不在这个列表里（它们是可选内容，见 6c 的决策）
  check(
    !missingTxtIssues.some(
      (issue) => issue.blockId === 'chat-examples' || issue.blockId === 'initial-scene',
    ),
    'TXT 的缺失列表不含两个字段板块（可选内容不报"缺板块"）',
    missingTxtIssues.map((issue) => String(issue.blockId)).join(','),
  );
  check(
    missingParsed.issues.filter((issue) => issue.code === 'missing-block' && issue.blockId === 'special')
      .length === 1,
    '反证二：同一板块只报一次（不重复）',
  );

  // ── byField 口径在服务端报告里也成立 ──
  const byField = legacyResult.report.wordCount.byField;
  for (const key of ['description', 'personality', 'character_book', 'first_mes', 'mes_example']) {
    check(byField[key] !== undefined, `报告 wordCount.byField.${key} 存在（服务端与客户端同口径）`);
  }
  const described =
    byField.description.chars +
    byField.personality.chars +
    byField.character_book.chars +
    byField.first_mes.chars +
    byField.mes_example.chars;
  check(
    described === legacyResult.report.wordCount.total.chars,
    '五个字段口径之和 = 全文合计（无重复计数、无漏计）',
    `${String(described)} vs ${String(legacyResult.report.wordCount.total.chars)}`,
  );
  check(
    byField.character_book.chars === 0,
    '样本未带 character_book 时该口径为 0（没把 description 的字数算进来）',
    String(byField.character_book.chars),
  );

  // ── PNG 格式：服务端不支持，且要**明确拒绝** ──
  //
  // 需求第 5 项要求"字段统计对 PNG/JSON 双格式一致"。实测结论是：
  // **服务端只接受 UTF-8 JSON 文本，PNG 嵌卡（SillyTavern 的 .png + chara 块）不支持。**
  // 所以"双格式一致"无从谈起 —— 但这件事必须**被验证并写下来**，
  // 而不是假装验过。这里断言的是"拒绝得清楚"：
  // 抛 422 CARD_PARSE_FAILED，而不是崩溃、不是静默当空卡、不是瞎猜编码。
  //
  // 为什么这条重要：PNG 卡在 ST 生态里很常见。用户拖一个 .png 进来，
  // 最坏的结果是"看起来成功了但内容是空的"。明确报错才是负责的行为。
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  let pngError = null;
  try {
    service.run(pngBytes, {}, 'png-card');
  } catch (error) {
    pngError = error;
  }
  check(pngError !== null, 'PNG 嵌卡被拒绝解析（不会当成空卡静默通过）');
  check(
    pngError !== null && pngError.status === 422 && pngError.code === 'CARD_PARSE_FAILED',
    'PNG 拒绝码是 422 CARD_PARSE_FAILED（可被客户端识别的明确错误）',
    pngError === null ? '未抛错' : `${String(pngError.status)} ${String(pngError.code)}`,
  );
  check(
    pngError !== null && /UTF-8|编码/.test(pngError.message ?? ''),
    'PNG 的报错文案说明了原因（不是"未知错误"）',
    (pngError?.message ?? '').slice(0, 40),
  );

  return { checks, failures: checks.filter((item) => !item.ok).length };
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  const { checks, failures } = runAuditDualSample();
  for (const item of checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.detail === '' ? '' : `  — ${item.detail}`}`);
  }
  console.log('');
  console.log(
    failures === 0
      ? `全部通过（${String(checks.length)} 项）：旧卡可审计，新卡正常校验。`
      : `失败 ${String(failures)} 项（共 ${String(checks.length)} 项）`,
  );
  process.exit(failures === 0 ? 0 : 1);
}
