/**
 * 功能
 * 拼接「聊天外壳实现」的全部文件，给读源码做形状断言的判据用统一入口。
 *
 * 注意事项
 * 新增拆分文件时必须加进 SHELL_IMPL_FILES，否则相关判据会报「没实现」。
 * 需要区分文件时不要用本模块，直接用 readShellFile 或自己读原文件
 * （godclass-split-guard 就是自己读的）。
 * readShellImpl 保留注释，readShellImplNoComments 剥掉注释。
 * 量位置的断言用后者：注释里常写着同样的句子，不剥会把判据骗成假绿。
 *
 * 踩过的坑
 * 全库原有 42 个测试文件、96 处直接读 client/src/chat/shell.ts。每搬一个方法
 * 出去，那一批判据就集体假红，报的是「没实现」，而实现得好好的。
 * 搬 makeFilesCallbacks 那次光修断言就改了 3 个文件 20 处。按这个成本，
 * 拆分推进会自己把自己卡住，所以把文件清单收到一处。
 *
 * 另一个坑：拆出去的模块里接收者名是 host.，主体里是 this.。历史判据全写成
 * /this\.xxx/ 或 indexOf('this.xxx')，搬家后集体报错，而错误信息看起来像
 * 逻辑真的错了。normalizeReceiver 把 host. 归一成 this.，判据一个字都不用动。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * 组成聊天外壳实现的全部文件。
 *
 * 顺序即拼接顺序。判据做 indexOf 比较相对位置时（例如「守卫要在跳转之前」）
 * 会受它影响，所以被调用的、被依赖的文件放后面。
 */
export const SHELL_IMPL_FILES = [
  // 契约面，只有类型与 TABS
  'client/src/chat/shell-contract.ts',
  // 主体
  'client/src/chat/shell.ts',
  // 已拆出的职责，按拆分顺序追加
  'client/src/chat/chat-session-state.ts',
  'client/src/chat/files-callbacks.ts',
  'client/src/chat/actions-callbacks.ts',
  'client/src/chat/repo-state.ts',
  'client/src/chat/repo-actions.ts',
  'client/src/chat/card-actions.ts',
  'client/src/chat/greeting-actions.ts',
  'client/src/chat/settings-sections.ts',
  'client/src/chat/persona-actions.ts',
  'client/src/chat/prompt-actions.ts',
];

/** 读单个文件（相对仓库根）。需要区分文件时用这个 */
export function readShellFile(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

/** 拼接后的实现源码，保留注释 */
export function readShellImpl() {
  return normalizeFieldLayout(normalizeReceiver(SHELL_IMPL_FILES.map(readShellFile).join('\n')));
}

/**
 * 功能
 * 剥掉注释，同时**保护字符串字面量**里的注释标记。
 *
 * 注意事项
 * 这是个状态机，不是正则。别改回 `.replace(/\/\*[\s\S]*?\*\//g, '')`。
 *
 * 踩过的坑
 * 正则版本在两种情况下会吃掉大段代码：
 *
 * ```text
 *   字符串里出现「斜杠+星号」   被当成块注释开始
 *   跨文件拼接后再剥            前一个文件里未闭合的开标记会一路吃下去
 * ```
 *
 * 2026-11-24 撞的是第一种：`card-actions.ts` 里给 `pickFileBytes` 传的 MIME 串
 * 含「斜杠+星号」，正则把后面 7000 字符（含 `confirmOverwriteCard` 定义）当注释删掉，
 * 判据报「找不到 confirmOverwriteCard」。排查时先怀疑搬错了文件，
 * 实际是这一个字符。
 *
 * 跨文件那种情况由 `readShellImplNoComments` 逐文件剥来解决。
 */
export function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // 行注释：保留换行符（否则行号信息全丢）
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    // 块注释：整段丢弃
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // 字符串：原样搬运，跳过转义。三种引号都要认（模板串里的 ${} 不展开）
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
 * 把拆出去模块里的接收者名统一成 this.。
 *
 * 判据要钉的是行为（「把文件名指过去」），不是「用哪个变量名访问」。
 * 接收者只是「这段代码住在哪个文件」的产物。
 * 归一成 this. 而不是 host.，是因为主体仍用 this.，历史判据也全是 this. 口径，
 * 这样只需改这一处。
 */
export function normalizeReceiver(text) {
  return text.replace(/\bhost\./g, 'this.');
}

/**
 * 把「状态收进对象」的字段访问归一回扁平名。
 *
 * ## 为什么需要
 *
 * 2026-11-24 把 AppShell 的 19 个 `repo*` 字段收进了一个 `repo` 对象：
 *
 * ```text
 *   以前   this.repoLink / this.repoCardsState / this.repoConfig
 *   现在   this.repo.link / this.repo.cardsState / this.repo.config
 *          （repo-actions.ts 里是 host.state.link）
 * ```
 *
 * 而历史判据全写成 `this.repoLink`，字段一收就集体报
 * 「外壳要有 repoLink 字段」。它们钉的是**壳里有没有这个状态**，
 * 不是「它挂在扁平字段还是对象字段上」—— 后者是实现布局。
 *
 * 归一规则：`this.repo.x` 与 `this.state.x` → `this.repoXxx`。
 *
 * ## 边界
 *
 * 只做这一层映射，不做通用反变换。以后再有字段收进对象，在这里加一条。
 */
export function normalizeFieldLayout(text) {
  return text
    /*
     * 模块内互调还原：`fetchRepoFaceForImport(host, cardId)` → `this.fetchRepoFaceForImport(cardId)`。
     *
     * 历史判据写的是「壳里调自己的方法」形态（`this.xxx(...)`）。搬出去之后
     * 模块内部变成 `xxx(host, ...)`，判据就查不到了，报「要先拉仓库卡面」
     * 这种看起来像逻辑缺失的错。
     *
     * 判据钉的是调用关系（A 调了 B），与「调用写成方法还是函数」无关。
     */
    /*
     * lookbehind 排除 `function ` —— 否则函数**定义**会被改成
     * `export function this.repoOrigin(host: RepoHost)`，判据再也找不到签名。
     * 第一版漏了这个，`methodBody(src, 'function confirmOverwriteCard(host: CardHost')`
     * 直接返回空串，报「找不到 confirmOverwriteCard」。
     */
    .replace(/(?<!function )\b(\w+)\(host, /g, 'this.$1(')
    .replace(/(?<!function )\b(\w+)\(host\)/g, 'this.$1()')
    /*
     * 第三、四种形态：壳里的调用点显式传 host —— `writeCardPng(this.cardHost(), ...)`。
     * 历史判据查的是 `this.writeCardPng(`，所以把 `(this.xxxHost(), ` 折回去。
     */
    .replace(/\b(\w+)\(this\.\w+Host\(\), /g, 'this.$1(')
    .replace(/\b(\w+)\(this\.\w+Host\(\)\)/g, 'this.$1()')
    // repo-actions.ts 里通过 host 访问，normalizeReceiver 之后是 this.state.xxx
    .replace(/\bthis\.state\.([a-z]\w*)/g, (_m, key) => 'this.repo' + key[0].toUpperCase() + key.slice(1))
    // shell.ts 里是 this.repo.xxx
    .replace(/\bthis\.repo\.([a-z]\w*)/g, (_m, key) => 'this.repo' + key[0].toUpperCase() + key.slice(1));
}

/**
 * 剥注释的拼接源码。绝大多数判据用这个。
 *
 * ## 必须先逐文件剥，再拼接
 *
 * 直接对拼接结果做 `stripComments` 会跨文件边界匹配：某个文件里出现
 * 未闭合的 `/*`（字符串里含注释标记是常见形态），正则就会一路吃到
 * **下一个文件的第一个** `*\/` 为止 —— 后面的内容整段消失。
 *
 * 2026-11-24 撞上过：card-actions.ts 里 `function confirmOverwriteCard`
 * 凭空不见，判据报「找不到 confirmOverwriteCard」，排查时先怀疑搬错了文件。
 */
export function readShellImplNoComments() {
  return normalizeFieldLayout(
    normalizeReceiver(SHELL_IMPL_FILES.map((rel) => stripComments(readShellFile(rel))).join('\n')),
  );
}
