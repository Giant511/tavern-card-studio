/**
 * 功能
 * 编辑器**实现源码**的统一入口，给读源码做形状断言的判据用。
 *
 * 注意事项
 * 新增拆分文件时必须加进 EDITOR_IMPL_FILES，否则相关判据会报「没找到 xxx」。
 * 需要区分文件时不要用本模块，直接 readEditorFile 或自己读 app.ts。
 *
 * `readEditorImplNoComments` 先逐文件剥注释再拼接 —— 不能反过来：
 * 某个文件里的字符串含「斜杠+星号」时，跨文件的正则会一路吃到下一个文件的
 * 结束标记，中间整段消失。
 *
 * 踩过的坑
 * 这是第三次踩同一个坑（前两次在 shell.ts）。前两次都是"发现一批判据假红 →
 * 逐个文件改锚点"，改完下次搬家又红。根因是**每个测试各自读文件**，
 * 搬家时没有任何一处能同时通知到它们。
 *
 * 所以这次不逐个改，而是把读取收口到这里：以后搬 app.ts 的代码只改上面那
 * 一个数组。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * 组成编辑器实现的全部文件。
 *
 * 顺序即拼接顺序。做 `indexOf` 比较相对位置的判据会受它影响，
 * 所以被调用的、被依赖的放后面。
 */
export const EDITOR_IMPL_FILES = [
  // 主类
  'client/src/editor/app.ts',
  // 已拆出的职责（按拆分顺序追加）
  'client/src/editor/dom.ts',
  'client/src/editor/error-text.ts',
  'client/src/editor/demo-actions.ts',
  'client/src/editor/save-actions.ts',
  'client/src/editor/dialogs.ts',
  'client/src/editor/import-actions.ts',
  'client/src/editor/block-runtime.ts',
  'client/src/editor/block-actions.ts',
  'client/src/editor/ui-refresh.ts',
  'client/src/editor/preview-scenarios.ts',
  'client/src/editor/preset-restore.ts',
  'client/src/editor/wiring.ts',
  'client/src/editor/open-actions.ts',
  'client/src/editor/st-push.ts',
  'client/src/editor/landing.ts',
  'client/src/editor/connection.ts',
  'client/src/editor/library-actions.ts',
  'client/src/editor/undo-snapshot.ts',
];

/** 读单个文件（相对仓库根）。需要区分文件时用这个 */
export function readEditorFile(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

/**
 * 剥注释，保护字符串字面量里的注释标记。状态机，不是正则。
 *
 * 与 `test/lib/shell-source.mjs` 里的同名函数是同一份逻辑。
 * 两处各留一份是因为它们服务的文件清单不同；若哪天要合并，
 * 注意不要引入对 `@tcs/shared` 之类运行时依赖（测试要能独立跑）。
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          out += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 功能
 * 把拆出去模块里的接收者名统一成 `this.`。
 *
 * 注意事项
 * 判据要钉的是行为（"导入后调了 selectFieldPreset"），不是"用哪个变量名访问"。
 * 接收者只是"这段代码住在哪个文件"的产物。
 *
 * 踩过的坑
 * 第一版漏了这个函数，于是 6 个测试改走共享入口后，判据里所有
 * `this.selectFieldPreset(...)` 形态的断言全部落空。报错是
 * 「导入成功后必须 selectFieldPreset」—— 看起来像逻辑丢了，实际只是
 * 变量名从 `this.` 变成了 `host.`。
 */
export function normalizeReceiver(text) {
  return text.replace(/\bhost\./g, 'this.');
}

/** 拼接后的实现源码，保留注释 */
export function readEditorImpl() {
  return normalizeReceiver(EDITOR_IMPL_FILES.map(readEditorFile).join('\n'));
}

/**
 * 剥注释的拼接源码。绝大多数判据用这个。
 *
 * 逐文件剥再拼 —— 反过来会跨文件匹配，见文件头的说明。
 */
export function readEditorImplNoComments() {
  return normalizeReceiver(
    EDITOR_IMPL_FILES.map((rel) => stripComments(readEditorFile(rel))).join('\n'),
  );
}
