/**
 * 「只改思考设置却说没有改动」的判据（2026-11-07）。
 *
 * 用户原话：
 *
 * > 改了这个开关参数说没有改变，需要配合其他项的修改才可以
 *
 * 真机复现：只把「思考长度」从 low 改成 high，按保存 → 弹「没有改动」。
 * 而 localStorage 已经是 `{"intent":"auto","budget":"high"}` ——
 * **值真的存了**，只是这句话在撒谎。
 *
 * 成因：思考类的值走 `onPersistThinking`（改完即时写），
 * 而「保存」按钮只算 ST 字段的 diff ⇒ `changed` 为空 ⇒ 提前 return。
 *
 * 这一批的判据要钉住的是「**不会再对已经生效的修改说没有改动**」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SETTINGS = 'client/src/chat/chat-settings.ts';

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

/** 去掉注释，避免注释里的旧写法把判据带偏（本项目踩过多次） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('★★★★★ 思考类改动必须被单独记账（否则 diff 永远是空）', () => {
  const src = stripComments(read(SETTINGS));

  /*
   * 打开页面时就要记下原始值 —— 等到点保存再读，
   * 读到的已经是用户改完的值，diff 恒为空。
   */
  assert.match(src, /initialThinking/, '要记下打开页面时的思考值');
  const readAt = src.indexOf('const first = reasoningHandle.read()');
  assert.ok(readAt > 0, '创建组件后要立刻读一次原始值');
});

test('★★★★★ 只改思考时不许说「没有改动」', () => {
  const src = stripComments(read(SETTINGS));

  /* 先有 thinkingTouched 的判断 */
  assert.match(src, /thinkingTouched/, '要有"思考被改过"的标记');
  assert.match(src, /now\.intent !== initialThinking\.intent/, '要比对意图');
  assert.match(src, /String\(now\.budget \?\? ''\) !== initialThinking\.budget/, '要比对长度');
  assert.match(src, /String\(now\.family \?\? ''\) !== initialThinking\.family/, '要比对参数族');

  /*
   * 关键：`changed` 为空但有思考改动时，**不许**走到「没有改动」。
   *
   * 用位置关系断言：那句提示必须被 `changed.length === 0 && thinkingTouched`
   * 的分支挡住 —— 也就是"思考已保存"的 return 要出现在它前面。
   */
  const emptyNotice = src.indexOf("'没有改动'");
  assert.ok(emptyNotice > 0, '原本的「没有改动」提示应该还在（真的什么都没改时要用）');
  const thinkingSaved = src.indexOf('思考设置已保存');
  assert.ok(thinkingSaved > 0, '要有一句"思考设置已保存"');
  assert.ok(
    thinkingSaved < emptyNotice,
    '「思考已保存」的分支必须排在「没有改动」之前，否则照样会误报',
  );
});

test('★★★★ 那句话要说明"这一类改完立即生效"（用户才知道不用等保存）', () => {
  const src = stripComments(read(SETTINGS));
  const at = src.indexOf('思考设置已保存');
  const line = src.slice(at, at + 120);
  /*
   * 只说"已保存"不够 —— 用户会想"那我以后还要不要按保存"。
   * 补一句"这类改完立即生效"，这个问题就没了。
   */
  assert.match(line, /立即生效/, '要说明这一类改完立即生效');
});

test('★★★★ 思考的即时写入链路必须还在（别为了修提示去改行为）', () => {
  /*
   * 修的是"话"，不是"行为"。如果顺手把自动保存去掉、改成只靠保存按钮，
   * 那聊天面板会用到旧值 —— 反而更糟。
   */
  const shell = stripComments(read('client/src/chat/shell.ts'));
  const onChangeAt = shell.indexOf('onChange: (state) => {');
  assert.ok(onChangeAt > 0);
  const block = shell.slice(onChangeAt, onChangeAt + 600);
  assert.match(block, /onPersistThinking/, 'onChange 里仍要即时持久化');
  assert.match(block, /setThinking/, 'onChange 里仍要推给聊天面板');
});
