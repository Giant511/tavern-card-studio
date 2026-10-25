#!/usr/bin/env node
/**
 * 三板块高亮的浏览器侧断言（v0.1.3 追加项二）。
 *
 * 输入是 `scripts/capture-v13-dumps.sh` 抓的 `.verify/v13-dumps/*.html`。
 * 本脚本只做断言、不做抓取 —— 与 `verify-t10x.mjs` 同一条分工
 * （本机 Node 起不了子进程，Chrome 只能由 shell 调）。
 *
 * ## 判据为什么读 `data-rule` 而不是看颜色
 *
 * 「规则生效了吗」与「颜色对不对」是两件事。颜色能从方案里算出来（已有单测），
 * 而"这条规则作用到了这个板块"只有 DOM 能证明。所以断言的是
 * `<span class="tcs-hl tcs-hl-<scope>" data-rule="<规则 id>">` 是否存在。
 *
 * 用法：bash scripts/capture-v13-dumps.sh && node scripts/verify-v13-extras.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DUMPS = join(ROOT, '.verify/v13-dumps');

let pass = 0;
let fail = 0;

function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✘ ${label}${detail === '' ? '' : ` —— ${detail}`}`);
  }
}

function load(name) {
  const path = join(DUMPS, `${name}.html`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** 该快照里出现过的 `data-rule` 值 */
function rulesOf(html) {
  return new Set([...html.matchAll(/data-rule="([^"]+)"/g)].map((match) => match[1]));
}

/** 某个规则命中处的完整 class（用于确认 scope 归属） */
function classOfRule(html, ruleId) {
  const re = new RegExp(`<span class="([^"]*)"[^>]*data-rule="${ruleId}"`, 'g');
  const found = new Set();
  for (const match of html.matchAll(re)) found.add(match[1]);
  return [...found];
}

console.log('\n三板块高亮的浏览器侧断言（追加项二）\n');

// ══════════════════════════════════════════════════════════
// 1. 世界书
// ══════════════════════════════════════════════════════════
console.log('1. 世界书板块');
const wb = load('hl-worldbook');
if (wb === null) {
  check('快照 hl-worldbook.html 存在', false);
} else {
  const rules = rulesOf(wb);
  check('编辑器已渲染高亮（出现 data-rule）', rules.size > 0, `${String(rules.size)} 条规则命中`);

  const expected = [
    ['worldbook-entry-open', 'heading'],
    ['worldbook-content-mark', 'subheading'],
    ['worldbook-entry-close', 'separator'],
    ['worldbook-trigger-keys', 'attribute'],
    ['worldbook-entry-name', 'subheading'],
  ];
  for (const [ruleId, scope] of expected) {
    const classes = classOfRule(wb, ruleId);
    check(
      `${ruleId} 命中且归 ${scope}`,
      classes.length > 0 && classes.some((cls) => cls.includes(`tcs-hl-${scope}`)),
      classes.length === 0 ? '规则一条都没命中' : `class=${classes.join(' / ')}`,
    );
  }

  // 反向：这三条专用规则不该出现在别的板块快照里
  const basic = load('hl-chat-examples');
  if (basic !== null) {
    check(
      '世界书专用规则没有泄漏到对话示例板块',
      !rulesOf(basic).has('worldbook-entry-open'),
      [...rulesOf(basic)].filter((id) => id.startsWith('worldbook-')).join(', '),
    );
  }
}

// ══════════════════════════════════════════════════════════
// 2. 初始场景
// ══════════════════════════════════════════════════════════
console.log('\n2. 初始场景板块');
const scene = load('hl-initial-scene');
if (scene === null) {
  check('快照 hl-initial-scene.html 存在', false);
} else {
  const rules = rulesOf(scene);
  check('scene-divider 命中分隔行', rules.has('scene-divider'), [...rules].join(', '));
  const dividerClass = classOfRule(scene, 'scene-divider');
  check(
    'scene-divider 归 separator',
    dividerClass.some((cls) => cls.includes('tcs-hl-separator')),
    dividerClass.join(' / '),
  );
  // 需求要求"占位符 + 对话引号沿用现有 scope"
  check('占位符沿用 placeholder', rules.has('char-placeholder'));
  check('对话引号沿用 dialogue', rules.has('dialogue-cn-quote') || rules.has('dialogue-double-quote'));
  check(
    '初始场景里没有世界书的标记配色',
    ![...rules].some((id) => id.startsWith('worldbook-')),
    [...rules].filter((id) => id.startsWith('worldbook-')).join(', '),
  );
}

// ══════════════════════════════════════════════════════════
// 3. 对话示例
// ══════════════════════════════════════════════════════════
console.log('\n3. 对话示例板块');
const examples = load('hl-chat-examples');
if (examples === null) {
  check('快照 hl-chat-examples.html 存在', false);
} else {
  const rules = rulesOf(examples);
  check('<START> 由 example-start-marker 接管', rules.has('example-start-marker'), [...rules].join(', '));
  const classList = classOfRule(examples, 'example-start-marker');
  check(
    '<START> 归 subheading（不再是自定义宏）',
    classList.some((cls) => cls.includes('tcs-hl-subheading')),
    classList.join(' / '),
  );
  check(
    '<START> 不再被 custom-macro 抓走',
    !classList.some((cls) => cls.includes('tcs-hl-placeholder-custom')),
    classList.join(' / '),
  );
  check('占位符沿用 placeholder', rules.has('char-placeholder'));
  check(
    'scene-divider 没有泄漏到对话示例',
    !rules.has('scene-divider'),
    [...rules].filter((id) => id === 'scene-divider').join(', '),
  );
}

// ══════════════════════════════════════════════════════════
console.log(`\n结果：${String(pass)} 项通过，${String(fail)} 项失败`);
if (fail > 0) {
  console.log('提示：先跑 bash scripts/capture-v13-dumps.sh 重新抓快照');
  process.exit(1);
}
