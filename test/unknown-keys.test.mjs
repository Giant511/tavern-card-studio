/**
 * 未知字段检查（T10.10 补 F4）。
 *
 * 要证明的是三件事，缺一不可：
 *   1. 拼错的键**被点名**（并且尽量给出正确拼写）；
 *   2. 它只是 warning，`rule` 依然可用 —— 前向兼容不能被这个功能破坏；
 *   3. 合法的内置规则文件一处都不报（否则新功能等于给所有用户刷黄条）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkUnknownKeys,
  editDistance,
  loadHighlightRules,
  loadPlatformRules,
  parseHighlightRule,
  parsePlatformRule,
  suggestKey,
} from '../shared/dist/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function readAll(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
}

const PLATFORM_FILES = readAll(join(ROOT, 'rules', 'platforms'));
const HIGHLIGHT_FILES = readAll(join(ROOT, 'rules', 'highlight'));

function platformRule(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'f4-probe',
    name: 'F4 探针',
    version: '1.0.0',
    target: { spec: 'v2' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'] },
    fields: [{ path: 'name', label: '角色名', required: true }],
    rules: [
      {
        id: 'needs-char',
        type: 'placeholder-min-count',
        message: '需要 {{char}}',
        scope: '*',
        severity: 'warning',
        token: 'char',
        min: 1,
      },
    ],
    ...overrides,
  };
}

test('editDistance / suggestKey 的基本判据', () => {
  assert.equal(editDistance('mach', 'match'), 1);
  assert.equal(editDistance('color', 'color'), 0);
  // 相邻互换算 1 步：这是手打 JSON 最高频的错误
  assert.equal(editDistance('form', 'from'), 1);
  assert.equal(editDistance('enabeld', 'enabled'), 1);
  // 窗口随键名长度放宽，但**短键只有 1**
  assert.equal(suggestKey('mach', ['match', 'words']), 'match');
  assert.equal(suggestKey('colour', ['color', 'label']), 'color');
  assert.equal(suggestKey('form', ['from', 'to']), 'from');
  // 距离太远就不猜（宁可不提示，也不要指向错误的字段）
  assert.equal(suggestKey('whatever', ['color', 'label']), null);
  assert.equal(suggestKey('abcd', ['xyz']), null);
});

test('checkUnknownKeys 点名位置与拼写建议', () => {
  const warnings = [];
  checkUnknownKeys({ id: 'a', mach: {} }, ['id', 'match'], 'rules[2]', warnings);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rules\[2\]\.mach/);
  assert.match(warnings[0], /match/);

  const top = [];
  checkUnknownKeys({ foo: 1 }, ['id'], '', top);
  assert.match(top[0], /未知字段 foo/, '顶层不应带前导点号');
});

test('平台规则：拼错的键只报 warning，规则依然可用', () => {
  const broken = platformRule({
    rules: [
      {
        id: 'needs-char',
        type: 'placeholder-min-count',
        message: 'x',
        scope: '*',
        severity: 'warning',
        token: 'char',
        min: 1,
        // 「想临时关掉这条规则，把 enabled 打成 enabeld」——
        // 这是 F4 最典型的场景：文件照样加载、规则照样生效，
        // 用户以为关掉了，实际一直开着，且没有任何提示。
        enabeld: false,
      },
    ],
  });
  const parsed = parsePlatformRule(broken);
  assert.deepEqual(parsed.errors, [], '未知字段不能让文件变成不可用');
  assert.ok(parsed.rule, 'rule 必须仍然产出');
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /rules\[0\]\.enabeld/);
  assert.match(parsed.warnings[0], /是不是想写 enabled/);
});

test('平台规则：各层级都能查到未知字段', () => {
  const parsed = parsePlatformRule({
    ...platformRule(),
    target: { spec: 'v2', specVer: '3.0' },
    placeholders: { char: ['{{char}}'], user: ['{{user}}'], chars: ['x'] },
    fields: [{ path: 'name', label: '名', required: true, minLenght: 2 }],
    autoFix: [{ type: 'trim', form: '可删' }],
    metadata: { author: 'a', authors: 'b' },
    extraTop: 1,
  });
  const joined = parsed.warnings.join('\n');
  assert.match(joined, /extraTop/);
  assert.match(joined, /target\.specVer/);
  assert.match(joined, /placeholders\.chars/);
  assert.match(joined, /fields\[0\]\.minLenght/, 'minLenght 是 minLength 的常见手误（字母颠倒）');
  assert.match(joined, /是不是想写 minLength/);
  assert.match(joined, /autoFix\[0\]\.form/);
  assert.match(joined, /是不是想写 from/);
  assert.match(joined, /metadata\.authors/);
  assert.equal(parsed.errors.length, 0);
});

test('高亮方案：scope / match / editor / theme 的未知键都被点名', () => {
  const parsed = parseHighlightRule({
    schemaVersion: 1,
    id: 'f4-hl',
    name: 'F4 高亮',
    version: '1.0.0',
    editor: { fontSize: 14, fontsize: 15 },
    theme: { foreground: '#111111', background: '#ffffff', carets: '#222222' },
    scopes: [{ id: 'accent', label: '强调', color: '#aa0000', backgroundColour: null }],
    rules: [
      {
        id: 'kw',
        scope: 'accent',
        priority: 0,
        match: { type: 'word-list', words: ['甲'], caseSensitve: true },
      },
    ],
  });
  // 结构上是合法的：backgroundColour 不是必填项，缺 backgroundColor 也无妨
  assert.deepEqual(parsed.errors, []);
  const joined = parsed.warnings.join('\n');
  assert.match(joined, /editor\.fontsize/);
  assert.match(joined, /theme\.carets/);
  assert.match(joined, /scopes\[0\]\.backgroundColour/);
  assert.match(joined, /rules\[0\]\.match\.caseSensitve/);
  assert.match(joined, /是不是想写 caseSensitive/);
});

test('内置规则文件零未知字段（否则等于给所有用户刷黄条）', () => {
  const platformLoad = loadPlatformRules(PLATFORM_FILES);
  const highlightLoad = loadHighlightRules(HIGHLIGHT_FILES);
  const unknown = [
    ...platformLoad.warnings.flatMap((item) => item.warnings),
    ...highlightLoad.warnings.flatMap((item) => item.warnings),
  ].filter((text) => text.includes('未知字段'));
  assert.deepEqual(unknown, []);
});

test('loadPlatformRules 的 warnings 按文件归并，且不吞掉成功条目', () => {
  const loaded = loadPlatformRules([platformRule({ madeUp: true }), platformRule({ id: 'second' })]);
  assert.equal(loaded.rules.length, 2);
  assert.equal(loaded.errors.length, 0);
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.warnings[0].id, 'f4-probe');
});
