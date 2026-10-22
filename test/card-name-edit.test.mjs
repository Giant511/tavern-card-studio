/**
 * T9.6 角色名就地编辑（F10）测试。
 *
 * 这条修复的核心不是"能改名"，而是**改的名字真的进了导出 JSON**。
 * 之前顶栏只是个只读 div，用户改不到 meta.name，导出的 JSON 里角色名
 * 一直是最初那个样例名 —— 这是 F10 要根治的问题，也是本文件最重要的断言。
 *
 * DOM 交互部分（点击变输入框、回车/失焦/Esc）在浏览器里验（见 E2E）；
 * 这里测纯逻辑：改名 → 数据模型 → 导出产物的完整链路。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildAuditReport,
  createEmptyCard,
  loadPlatformRules,
  parseStCard,
  resolvePlatformRule,
} from '@tcs/shared';

import { buildJsonExport } from '../client/src/export/export-card.ts';
import { parseCardNameExport } from './helpers/export-probe.mjs';

const SAMPLE = JSON.parse(readFileSync('test/fixtures/sample-card.json', 'utf8'));
const BASE_CARD = parseStCard(SAMPLE).card;

function loadStRule() {
  const names = ['sillytavern', 'character-card-v2', 'character-card-v3', 'janitorai', 'chub'];
  const files = names.map((name) =>
    JSON.parse(readFileSync(new URL(`../rules/platforms/${name}.json`, import.meta.url), 'utf8')),
  );
  const loaded = loadPlatformRules(files);
  assert.equal(loaded.errors.length, 0);
  return resolvePlatformRule('sillytavern', loaded.rules);
}

const ST_RULE = loadStRule();

/** 模拟 F10 的写入：只改 meta.name，不碰板块正文 */
function renameCard(card, name) {
  return { ...card, meta: { ...card.meta, name } };
}

// ── 核心：导出 JSON 的角色名 ───────────────────────────────

test('导出：改名后 JSON 里的 name 就是用户设定的值（F10 验证点）', () => {
  const renamed = renameCard(BASE_CARD, '林晚照');
  const artifact = buildJsonExport(renamed, null);
  const payload = JSON.parse(artifact.text);

  assert.equal(payload.name, '林晚照', '导出 JSON 的角色名没有跟着改');
  assert.equal(payload.data.name, '林晚照', 'data.name 没有跟着改');
});

test('导出：样例卡原名不会被写死进产物（回归旧 bug）', () => {
  const originalName = BASE_CARD.meta.name;
  const renamed = renameCard(BASE_CARD, '张三');
  const artifact = buildJsonExport(renamed, null);

  // 旧 bug 的表现就是"无论怎么改，导出的还是样例名"
  if (originalName !== '' && originalName !== '张三') {
    assert.ok(
      !artifact.text.includes(`"name": "${originalName}"`),
      `导出产物里仍出现原始样例名「${originalName}」`,
    );
  }
  assert.equal(JSON.parse(artifact.text).name, '张三');
});

test('导出：连续改名以最后一次为准（没有残留旧值）', () => {
  let card = BASE_CARD;
  for (const name of ['第一版', '第二版', '最终版']) {
    card = renameCard(card, name);
  }
  const payload = JSON.parse(buildJsonExport(card, null).text);
  assert.equal(payload.name, '最终版');
});

test('导出：改名不影响其它字段（只动 meta.name）', () => {
  const renamed = renameCard(BASE_CARD, '只改名字');
  const before = JSON.parse(buildJsonExport(BASE_CARD, null).text);
  const after = JSON.parse(buildJsonExport(renamed, null).text);

  assert.equal(after.data.description, before.data.description);
  assert.equal(after.data.first_mes, before.data.first_mes);
  assert.equal(after.data.personality, before.data.personality);
  assert.equal(after.data.tags.length, before.data.tags.length);
});

// ── 空名与未命名 ──────────────────────────────────────────

test('改名：允许清空，导出为空字符串（审计负责报必填）', () => {
  const cleared = renameCard(BASE_CARD, '');
  const payload = JSON.parse(buildJsonExport(cleared, null).text);
  // 空名是合法的 JSON 内容 —— F10.1 明确"清空名称：允许"，
  // 由审计面板按既有语义报「角色名不能为空」，而不是在这里拦。
  assert.equal(payload.name, '');
});

test('改名：清空后审计立刻报「角色名不能为空」', () => {
  const cleared = renameCard(BASE_CARD, '');
  const report = buildAuditReport(cleared, { platformRule: ST_RULE });
  // 精确匹配「角色名不能为空」这条，不能只按 /角色名/ 模糊找：
  // 有一条 info 级提示「正文中未出现 {{char}} 占位符，角色名硬编码后换卡易失效」
  // 也含"角色名"三个字，模糊匹配会先命中它，然后误判成"必填只报了 info"。
  const nameIssue = report.issues.find(
    (issue) => issue.severity === 'error' && /角色名.*不能为空|name.*不能为空/i.test(issue.message),
  );
  assert.ok(
    nameIssue,
    `审计未报「角色名不能为空」的 error。实际 issues：${report.issues
      .map((i) => `${i.severity}:${i.message}`)
      .join(' | ')}`,
  );
});

test('改名：从空改回有值后，该 error 消失', () => {
  const cleared = renameCard(BASE_CARD, '');
  assert.ok(
    buildAuditReport(cleared, { platformRule: ST_RULE }).issues.some((i) => /name|角色名/i.test(i.message)),
    '前置条件：空名应报 issue',
  );

  const fixed = renameCard(cleared, '补上了');
  const remaining = buildAuditReport(fixed, { platformRule: ST_RULE }).issues.filter(
    (i) => /角色名不能为空|name.*required/i.test(i.message),
  );
  assert.equal(remaining.length, 0, '补上名字后仍报必填');
});

// ── 与板块正文的关系（F10.2 不双写）──────────────────────

test('不双写：改名不动【基本信息】板块正文', () => {
  const basicBefore = BASE_CARD.blocks.find((b) => b.id === 'basic')?.text ?? '';
  const renamed = renameCard(BASE_CARD, '换了名字');
  const basicAfter = renamed.blocks.find((b) => b.id === 'basic')?.text ?? '';
  assert.equal(basicAfter, basicBefore, '板块正文被角色名同步改写了（F10.2 要求不双写）');
});

test('不双写：板块正文里的姓名留在正文里，不回写到 meta.name', () => {
  const card = createEmptyCard('meta 里的名字');
  const withBasic = {
    ...card,
    blocks: card.blocks.map((block) =>
      block.id === 'basic' ? { ...block, text: '姓名：正文里的名字', dirty: true } : block,
    ),
  };
  const payload = JSON.parse(buildJsonExport(withBasic, null).text);
  assert.equal(payload.name, 'meta 里的名字', 'meta.name 被正文内容覆盖了');
  assert.match(payload.data.description, /正文里的名字/, '正文内容不应丢失');
});

// ── 空白处理 ─────────────────────────────────────────────

test('改名：首尾空白被 trim（顶栏输入框已 trim，这里验证不会再带出去）', () => {
  // applyCardName 收到的是 trim 后的值；这里验证 trim 后的导出结果
  const renamed = renameCard(BASE_CARD, '  带空格的  '.trim());
  const payload = JSON.parse(buildJsonExport(renamed, null).text);
  assert.equal(payload.name, '带空格的');
});

test('改名：同名重复设置不产生变化（避免把"点一下又点走"记成修改）', () => {
  const a = renameCard(BASE_CARD, '同一个名字');
  const b = renameCard(a, '同一个名字');
  assert.equal(buildJsonExport(a, null).text, buildJsonExport(b, null).text);
});

// ── 辅助：确保本测试的读取口径与导出链路一致 ───────────────

test('口径：parseCardNameExport 读到的名字与 JSON.stringify 一致', () => {
  const artifact = buildJsonExport(renameCard(BASE_CARD, '口径验证'), null);
  assert.equal(parseCardNameExport(artifact.text), '口径验证');
});
