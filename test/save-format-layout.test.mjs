/**
 * 对话框尺寸基线（v0.1.5 / G6-1）。
 *
 * ## 为什么这条要写成测试
 *
 * 「对话框太窄、看着不舒服」不是审美问题，是**可复现的布局缺陷**：
 * 宽 520px 时那句 `原生 SillyTavern 结构，可继续编辑、可导入 ST / Chub；建议作为工作副本`
 * 会折成三行，三个选项高度各不相同，整列看起来是歪的。而这类问题
 * **单测、类型检查、功能测试全都抓不到** —— 只有截图能看出来。
 *
 * 但截图不会自动跑，所以这里把"当时调对的数值"变成断言：
 *   · 忘了加 `.modal-body` 内边距 → 文字贴边框（F5 那次的原始缺陷）；
 *   · 宽度掉回 520px → 描述折行，选项高度不齐；
 *   · 基类被加 padding → 设置/导出/规则面板一起变形（F5 明确禁止过）。
 *
 * 判据用的是**具体数值**而不是"看起来还行"：数值变了就必须来改这里，
 * 逼一次确认「是有意的改动，还是又退回去了」。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'client/src/styles.css'), 'utf8');

/** 抓某个选择器的规则体（只取第一个匹配，够用且不引入 CSS 解析器） */
function ruleBody(selector) {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `styles.css 里找不到选择器 ${selector}`);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

test('另存为对话框宽度 ≥700px（520px 时描述折三行、选项高度不齐）', () => {
  const body = ruleBody('.save-format-modal');
  const width = /width:\s*min\((\d+)px/.exec(body);
  assert.notEqual(width, null, '.save-format-modal 缺 width: min(Npx, …)');
  assert.ok(
    Number(width[1]) >= 700,
    `宽度掉到 ${width[1]}px —— 描述会折成多行，整列看起来是歪的`,
  );
});

test('另存为对话框的 modal-body 有内边距（否则文字贴边框）', () => {
  const body = ruleBody('.save-format-modal .modal-body');
  const pad = /padding:\s*([^;]+);/.exec(body);
  assert.notEqual(pad, null, '.save-format-modal .modal-body 没设 padding');
  const top = Number(pad[1].trim().split(/\s+/)[0].replace('px', ''));
  assert.ok(top >= 16, `内容区内边距只有 ${top}px，文字会贴到弹窗边缘（F5 的原始缺陷）`);
});

test('base `.modal-body` 仍然没有 padding（F5 定下的边界）', () => {
  /*
   * 在基类上加 padding 会把设置、导出、规则面板一起改形 —— 那些面板
   * 有自己的内部布局（分区、滚动区），加 padding 会让它们全部错位。
   * 这条断言防的是"为了让一个对话框好看，顺手改基类"。
   */
  assert.ok(
    !/\n\.modal-body\s*\{/.test(CSS),
    '有人在 `.modal-body` 基类上加了规则 —— 会同时改形设置/导出/规则面板（见 styles.css 里 F5 的注释）',
  );
});

test('三个格式选项竖排（auto-fill 会把它们挤成一行）', () => {
  const body = ruleBody('.save-format-list');
  assert.match(body, /flex-direction:\s*column/, '选项容器必须是竖排');
  // 用 auto-fill/grid-template-columns 会出现"一项一行还是一行三项"随宽度抖动
  assert.ok(!body.includes('auto-fill'), '不要用 auto-fill：宽度变化时列数会跳');
});

test('禁用态的"不可用原因"不与描述同色（那会读成该格式的特点）', () => {
  const blocked = ruleBody('.save-format-blocked');
  assert.match(blocked, /color:\s*var\(--warn\)/, '不可用原因要用警示色，与描述区分开');
});

test('禁用态不用整体降透明度（原因文字会被一起变淡）', () => {
  const body = ruleBody('.save-format-option:disabled');
  assert.ok(
    !/opacity:\s*0?\.\d+/.test(body),
    '禁用态用了 opacity —— 那行"为什么不能用"会和选项一起变淡，而它恰恰是唯一要读的内容',
  );
});

test('勾选行与选项之间有分隔（它属于本次偏好，不属于三种格式之一）', () => {
  const body = ruleBody('.save-format-remember');
  assert.match(body, /border-top:/, '勾选行缺少与上方选项的分隔');
});
