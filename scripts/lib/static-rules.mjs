/**
 * 仓库级静态判据（v0.1.3 / 6d）。
 *
 * 这里放的是"跨端、跨目录"的静态检查：不是某个包的私有约束，
 * 而是**整个仓库必须一致**的口径。两条，各对应一次真实缺陷。
 *
 * ## ① `data-block-id` 正则必须允许连字符
 *
 * `verify-e2e.mjs` 原来写 `data-block-id="([a-z]+)"`。加两个新板块
 * （`chat-examples` / `initial-scene`）后这个正则**匹配不到它们**，
 * 于是 `Set.size` 少算两个 —— 而断言只报"size !== 8"，看不出是谁缺了。
 *
 * ## ② 业务代码不许写死板块数组
 *
 * 加板块时实测到 6 处副本，失效方式都是**静默**：新板块不出现、规则不生效、
 * 审计筛不到，**不报任何错**。
 *
 * ## 判据为什么只认"数组字面量"
 *
 * 第一版把"一行里出现两个板块 id"也算违规，结果误报 5 处：
 *   · `id === 'chat-examples' || id === 'initial-scene'`（单点判断，不是清单）；
 *   · 测试里 `uniqueIds.has('worldbook') && uniqueIds.has('chat-examples')`
 *     （断言必须点名，正是它要证明的东西）；
 *   · 跨行数组被大括号切错，把 `.find((b) => b.id === 'basic')` 也算进去了。
 *
 * 一个判据误报多了，人就会去关掉它 —— 所以这里收紧到**结构级**：
 * 只匹配"元素几乎全是板块 id 字符串"的数组字面量。
 * 单点判断（`=== 'x'`）不算违规：它引用的是**这一个**板块，不是"有哪些板块"。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** 扫描目录下所有源码文件 */
export function walkSources(dir, extensions = ['.ts', '.mjs', '.sh']) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'target', '.verify', 'gen', 'fixtures'].includes(entry.name)) continue;
      out.push(...walkSources(full, extensions));
      continue;
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

/**
 * 去掉注释，**但保留换行**，保证行号与原文一一对应。
 *
 * 为什么必须保留换行：判定结果里的 line 是给人看的（"第几行违规"），
 * 而豁免标记是按**原文行号**查的。第一版把注释整段删掉（连同换行），
 * 于是 stripped 文本的行号与原文错位 —— 文件头部的注释块被删掉后，
 * 后面的代码行号全部前移，豁免标记查不到，豁免失效（实测踩到）。
 *
 * 现在用等量空格替换注释内容，只抹字符不动行。
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length))
    .replace(/^[ \t]*#[^\n]*/gm, (match) => ' '.repeat(match.length));
}

/**
 * ① `data-block-id` 提取正则的字符类必须允许 `-`。
 *
 * 判据要注意一个坑：字符类里的 `-` 有两种角色 ——
 *   `[a-z]` 的 `-` 是**范围符**，它不允许字面连字符；
 *   `[a-z-]` 的第二个 `-` 才是"允许连字符"。
 * 所以不能简单看"内容里有没有 `-`"（第一版就是这么写的，
 * 结果 `[a-z]` 被判成合格，负向自检当场抓出来了）。
 * 做法：先把范围模式（`x-y`）剥掉，再看剩下的还有没有 `-`。
 *
 * @returns {{file: string, line: number, snippet: string}[]}
 */
export function findBlockIdRegexWithoutHyphen(files, root) {
  const violations = [];
  /** 剥掉 `a-z` / `A-Z` / `0-9` 这类范围，剩下的 `-` 才是字面连字符 */
  const allowsLiteralHyphen = (content) => /[a-zA-Z0-9]-[a-zA-Z0-9]/.test(content)
    ? content.replace(/[a-zA-Z0-9]-[a-zA-Z0-9]/g, '').includes('-')
    : content.includes('-');

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('data-block-id')) return;
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('#')) return;
      const classes = [...line.matchAll(/\[([^\]\n]*)\]/g)].map((match) => match[1]);
      const bad = classes.some((content) => /a-z/.test(content) && !allowsLiteralHyphen(content));
      if (bad) {
        violations.push({
          file: relative(root, file).split(sep).join('/'),
          line: index + 1,
          snippet: line.trim().slice(0, 140),
        });
      }
    });
  }
  return violations;
}

/**
 * ② 业务代码里的硬编码板块数组。
 *
 * 判据：数组字面量的**元素几乎全是引号包裹的板块 id**（≥3 个不同 id）。
 * 这样：
 *   · `['basic','personality','settings','special','user']` → 违规
 *   · `['basic','worldbook']`（2 个）→ 不违规（小映射表，改板块时不易漏）
 *   · `a === 'x' || a === 'y'` → 不违规（单点判断）
 *   · `['【基本信息】', ...]`（标题文案数组）→ 不违规（元素不是 id）
 *
 * ## 显式豁免：`static-rule-allow: hardcoded-block-array`
 *
 * 有一种情况**必须写死**：模拟历史格式。比如双样本冒烟要造一份"v0.1.2 的
 * 六板块预设"，那个清单就不能跟着 `BLOCK_IDS` 走 —— 历史格式是冻结的，
 * 派生出来的"六板块"会随着未来加板块而变形，测试就失去了意义。
 *
 * 这类地方用一个显式注释标记放行，并且**必须写理由**：
 *
 * ```js
 * // static-rule-allow: hardcoded-block-array —— v0.1.2 的历史格式，冻结
 * const LEGACY = ['basic', ..., 'worldbook'];
 * ```
 *
 * 为什么用标记而不是文件白名单：白名单一次放行整文件，等于把该文件里
 * 其它真正的手滑也放过了；标记只放行**那一行**，而且 grep 一下就能数出
 * 全仓有多少处豁免（本仓库目前 2 处，都在同一个模拟历史格式的函数里）。
 *
 * @param {string[]} files
 * @param {string} root
 * @param {readonly string[]} blockIds
 * @param {(absolutePath: string) => boolean} isExempt
 */
export function findHardcodedBlockArrays(files, root, blockIds, isExempt) {
  const idAlt = blockIds.join('|');
  const elementPattern = `['"\`](?:${idAlt})['"\`]`;
  const arrayPattern = new RegExp(
    `\\[\\s*(?:${elementPattern}\\s*,\\s*){2,}${elementPattern}\\s*,?\\s*\\]`,
    'g',
  );
  const ALLOW = 'static-rule-allow: hardcoded-block-array';

  const violations = [];
  for (const file of files) {
    if (isExempt(file)) continue;
    const raw = readFileSync(file, 'utf8');
    // 豁免标记：只认**同一行或紧邻上一行**。
    //
    // 窗口放大（比如"上方 3 行内"）会让标记意外覆盖后续多个数组 ——
    // 实测把窗口设为 4 行时，一个标记会连带放行下面两处真正的违规，
    // 那这个机制就退化成了文件白名单。收紧到 1 行后，"标记 → 声明"是一一对应的。
    const rawLines = raw.split(/\r?\n/);
    const allowedLine = (lineNumber) => {
      for (let i = Math.max(0, lineNumber - 2); i <= lineNumber - 1; i += 1) {
        if ((rawLines[i] ?? '').includes(ALLOW)) return true;
      }
      return false;
    };

    const code = stripComments(raw);
    for (const match of code.matchAll(arrayPattern)) {
      const ids = [...match[0].matchAll(new RegExp(`['"\`](${idAlt})['"\`]`, 'g'))].map((m) => m[1]);
      const distinct = [...new Set(ids)];
      if (distinct.length < 3) continue;
      const before = code.slice(0, match.index ?? 0);
      const line = before.split(/\r?\n/).length;
      if (allowedLine(line)) continue;
      violations.push({
        file: relative(root, file).split(sep).join('/'),
        line,
        snippet: match[0].replace(/\s+/g, ' ').slice(0, 140),
        ids: distinct,
      });
    }
  }
  return violations;
}

/**
 * ③ 任何 `block:(...)` 交替式都必须覆盖**全部**板块 id。
 *
 * ## 为什么这条要有
 *
 * v0.1.3 反复踩同一个坑：板块清单散落在多处，其中三处是**正则交替式**
 * （两个 JSON Schema + `validate-rules.mjs`）。它们与 `shared` 里那三处
 * （已从 `BLOCK_ID_ALTERNATION` 派生）不同 —— Schema 是纯数据、校验脚本
 * 刻意不 import dist（保持零构建依赖），所以只能写死。
 *
 * 写死的后果与派生处一样**静默**，而且更隐蔽：
 *   · Schema 没跟上 → 写了新板块的规则文件被 **JSON Schema 拒收**，
 *     报错是 `appliesTo must match pattern`，看不出"少了个板块 id"；
 *   · `validate-rules` 没跟上 → `npm run validate:rules` 直接判红，
 *     但同样只说"不是合法选择器"。
 *
 * 实测：加完两个新板块后，`default.json` 里 5 条 `block:worldbook` 规则
 * 能过（worldbook 在旧清单里），而 `block:chat-examples` / `block:initial-scene`
 * 一写就被拒 —— 恰好是新板块，最容易让人以为是自己的写法错了。
 *
 * ## 判据
 *
 * 扫 `.json` / `.mjs` / `.ts`，找出所有 `block:(a|b|c)`，把括号里的分支
 * 与 `BLOCK_IDS` 比对：**缺任何一个即违规**（多出来的也报，那说明 id 拼错了）。
 *
 * 只认 `block:(` 这个形状：单纯的字符串数组由判据 ② 负责，
 * 而 `block:${BLOCK_ID_ALTERNATION}` 这类派生写法根本不含字面 `block:(` 分支，
 * 天然不会被误报。
 *
 * @param {string[]} files
 * @param {string} root
 * @param {readonly string[]} blockIds
 * @returns {{file: string, line: number, missing: string[], extra: string[], snippet: string}[]}
 */
export function findBlockAlternationDrift(files, root, blockIds) {
  const violations = [];
  const expected = new Set(blockIds);

  for (const file of files) {
    // 去注释（保留换行 → 行号不变）：否则本文件自己的文档注释里那句
    // `block:(a|b|c)` 会被自己判成违规 —— 判据先拿自己开刀这种事必须避免。
    const lines = stripComments(readFileSync(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('block:(')) return;
      for (const match of line.matchAll(/block:\(([^)]*)\)/g)) {
        const branches = match[1]
          .split('|')
          .map((item) => item.trim())
          .filter((item) => item !== '' && !item.includes('$') && !item.includes('+'));
        // 只处理"看起来像板块 id 清单"的分支（全部是小写+连字符），
        // `block:(${...})` 这类模板串里的分支含 `$`/`{`，上面已过滤掉。
        if (branches.length === 0) continue;
        if (!branches.every((item) => /^[a-z][a-z-]*$/.test(item))) continue;
        const actual = new Set(branches);
        const missing = blockIds.filter((id) => !actual.has(id));
        const extra = [...actual].filter((id) => !expected.has(id));
        if (missing.length === 0 && extra.length === 0) continue;
        violations.push({
          file: relative(root, file).split(sep).join('/'),
          line: index + 1,
          missing,
          extra,
          snippet: line.trim().slice(0, 140),
        });
      }
    });
  }
  return violations;
}
