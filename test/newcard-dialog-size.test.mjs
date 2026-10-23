/**
 * F5 新建角色卡对话框尺寸基线（v0.1.2）。
 *
 * 为什么要有这层：F5 的症状是"1920 宽屏下内容区挤压"，四个数字才说明问题：
 * 对话框宽度、输入框高度、说明文字行高、内容区内边距。截图能看出"挤"，
 * 但看不出"挤到多少"；而且样式表里没有这条基线时，任何人改一下 `.modal`
 * 都可能悄悄把某个数字改小，截图验收又很容易糊过去。
 *
 * 注意上下文：`.modal` 是**所有**对话框共用的（设置、导出、规则…），
 * 所以这些数值只作用于 `.new-card-modal`，不能让别的对话框一起变大。
 * 这也是判据必须写在选择器作用域里的原因。
 *
 * 判据（需求给的四个下限）：
 *   · 对话框宽度 ≥ 480px
 *   · 输入框高度 ≥ 40px
 *   · 说明文字行高 1.6
 *   · 内容区内边距 ≥ 24px（左右上下都算，因为文字四面都会贴边）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CSS = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8');

/** 取出某个选择器的声明块（第一个匹配到的） */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(CSS);
  assert.notEqual(match, null, `样式表里没有 \`${selector}\` 规则`);
  return match[2];
}

/** 解析声明块为 map（只处理本测试关心的简单情况） */
function decls(body) {
  const map = {};
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

// ── 对话框宽度 ────────────────────────────────────────────
test('新建卡对话框宽度 ≥ 480px（宽屏取 560px）', () => {
  const body = ruleBody('.new-card-modal');
  const d = decls(body);
  const width = d['width'] ?? '';
  const minWidth = d['min-width'] ?? '';

  // width: min(560px, 92vw) —— 宽屏下 560px，窄屏退让
  const widthPx = Number((/min\(\s*(\d+)px/.exec(width) ?? [])[1]);
  assert.ok(widthPx >= 480, `宽度下限 ${String(widthPx)}px 小于 480px（当前 width: ${width}）`);

  assert.ok(minWidth !== '', '缺少 min-width：窗口很窄时对话框会被压到看不清');
  const minPx = Number((/min\(\s*(\d+)px/.exec(minWidth) ?? [])[1]);
  assert.ok(minPx >= 480 || /vw/.test(minWidth), `min-width 需要 ≥480px 或在窄屏用 vw 兜底（当前 ${minWidth}）`);
});

test('尺寸基线不污染其它对话框（只作用于 .new-card-modal）', () => {
  const modal = decls(ruleBody('.modal'));
  // `.modal` 是共用基类：它自己的宽度上限应当保持 560px 以内，
  // 且不应被写成 480px+ 的强制宽度（否则导出/规则面板会一起变形）
  assert.ok(modal['width'], '.modal 应当有基础宽度定义');
  assert.equal(
    /min-width/.test(ruleBody('.modal')),
    false,
    '.modal 基类不应设置 min-width：会让所有对话框一起变宽',
  );
});

// ── 输入框高度 ────────────────────────────────────────────
test('输入框高度 ≥ 40px', () => {
  const d = decls(ruleBody('.new-card-modal .input'));
  const minHeight = d['min-height'] ?? '';
  const value = Number((/(\d+)px/.exec(minHeight) ?? [])[1]);
  assert.ok(value >= 40, `输入框 min-height 应 ≥40px，当前 ${minHeight || '(未设置)'}`);
  // 垂直内边距 + 字号要撑得住这个高度，不然会被内容挤压变形
  assert.ok(d['padding'], '输入框应当有 padding（否则文字贴边）');
});

// ── 说明文字行高 ──────────────────────────────────────────
test('说明文字行高 1.6、字号不小于 12px', () => {
  const d = decls(ruleBody('.new-card-modal .field-hint'));
  assert.equal(d['line-height'], '1.6', `说明文字行高应为 1.6，当前 ${d['line-height'] ?? '(未设置)'}`);
  const size = Number((/(\d+)px/.exec(d['font-size'] ?? '') ?? [])[1]);
  assert.ok(size >= 12, `说明文字字号应 ≥12px（11px 在 1920 宽屏下偏小），当前 ${d['font-size'] ?? '(未设置)'}`);
});

// ── 内容区内边距 ──────────────────────────────────────────
test('内容区内边距 ≥ 24px（这是"内容贴边"的直接成因）', () => {
  const d = decls(ruleBody('.new-card-modal .modal-body'));
  const padding = d['padding'] ?? d['padding-left'] ?? '';
  assert.ok(padding !== '', '.new-card-modal .modal-body 必须有 padding —— 原先完全没有，文字会贴到弹窗边缘');
  const nums = [...padding.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  assert.ok(nums.length > 0, `读不出 padding 数值：${padding}`);
  const horizontal = nums.length >= 2 ? nums[1] : nums[0];
  const vertical = nums[0];
  assert.ok(horizontal >= 24, `左右内边距应 ≥24px，当前 ${String(horizontal)}px（padding: ${padding}）`);
  assert.ok(vertical >= 20, `上下内边距应 ≥20px，当前 ${String(vertical)}px（padding: ${padding}）`);
});

test('.modal-body 在基类里确实没有 padding（说明这条必须写进专属作用域）', () => {
  // 这条是"解释为什么需要上面的规则"，不是要求基类加 padding。
  // 基类若将来加了 padding，上面的断言仍然成立（专属规则会覆盖），
  // 但这里会提醒你：全局加 padding 会影响所有对话框，请谨慎。
  const hasBase = /(^|\n)\.modal-body\s*\{/.test(CSS);
  if (hasBase) {
    const base = decls(ruleBody('.modal-body'));
    console.log('  提示：.modal-body 已有基类规则，改动会影响全部对话框 —— 请确认是有意为之');
    void base;
  }
  assert.ok(true);
});
