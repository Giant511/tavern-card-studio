/**
 * 预设持久化的**接线完整性**（v0.1.5 / G5）。
 *
 * 为什么要单独测"源码里有没有调那个函数"：
 *
 * 这类缺陷的症状是**分类型的**——漏了某一类（比如只给世界书预设做了保存，忘了
 * 初始场景预设），用户恰好只用过另一类，就永远发现不了。而等到他发现时，
 * 表现是"我明明导入过"，日志里什么都没有。
 *
 * 单测覆盖不到它：单测测的是 `PresetPersistence` 的行为，而"App 有没有在导入
 * 成功之后调用它"是装配问题。所以这里对源码做结构性断言 —— 与
 * `validate-rules.mjs`、`feature-sentinels` 的做法一致。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'client/src/editor/app.ts'), 'utf8');

/** 六类预设的 kind 字面量（与 preset-store.ts 的 PresetKind 对应） */
const KINDS = ['platform', 'highlight', 'txt', 'worldbook', 'greeting', 'chat-examples'];

/** 六类的选中项在 config 里的键 */
const SELECTION_KEYS = [
  'platformRuleId',
  'highlightSchemeId',
  'presetId',
  'worldbookPresetId',
  'greetingPresetId',
  'chatExamplePresetId',
];

test('六类预设导入后都调了 rememberPreset（漏一类 = 那一类重启即丢）', () => {
  for (const kind of KINDS) {
    assert.ok(
      APP.includes(`rememberPreset('${kind}'`),
      `没有为 ${kind} 调用 rememberPreset —— 这一类导入后不会落盘`,
    );
  }
});

test('六类选中项切换时都写了 config（漏一类 = 重启后回到默认）', () => {
  for (const key of SELECTION_KEYS) {
    assert.ok(
      APP.includes(key) && APP.includes(`{ ${key}:`),
      `没有把 ${key} 写进配置 —— 切换后重启会回到默认`,
    );
  }
});

test('六类选中项启动时都能恢复（只存不读等于没存）', () => {
  for (const key of SELECTION_KEYS) {
    assert.ok(
      APP.includes(`config.${key}`),
      `启动时没有读 config.${key} —— 保存了选择却不会恢复`,
    );
  }
});

test('启动顺序：预设库在 buildRuleset 之后加载（内置要先在，同 id 才能覆盖）', () => {
  const rulesAt = APP.indexOf('this.rules = await buildRuleset()');
  const loadAt = APP.indexOf('await this.loadPresetLibrary()');
  assert.notEqual(rulesAt, -1, 'start 里必须 buildRuleset');
  assert.notEqual(loadAt, -1, 'start 里必须 loadPresetLibrary');
  assert.ok(loadAt > rulesAt, 'loadPresetLibrary 必须排在 buildRuleset 之后');
});

test('库未加载完时不写盘（否则会把磁盘上已有的预设覆盖成只有一条）', () => {
  assert.ok(
    APP.includes('if (!this.presetStoreReady)'),
    'rememberPreset 必须检查 presetStoreReady',
  );
});

test('浏览器直开不做持久化，且不报错（那是预期场景，不该刷警告）', () => {
  const loadBlock = APP.slice(
    APP.indexOf('private async loadPresetLibrary()'),
    APP.indexOf('private async loadPresetLibrary()') + 600,
  );
  assert.match(loadBlock, /if \(!isShellAvailable\(\)\)/, '无壳时要直接返回');

  const persistBlock = APP.slice(
    APP.indexOf('private persistSelection('),
    APP.indexOf('private persistSelection(') + 400,
  );
  assert.match(persistBlock, /if \(!isShellAvailable\(\)\) return;/, '无壳时不写配置');
});
