/**
 * 夜航设计语言的走查清单（v0.1.7 / T15.5）。
 *
 * ## 为什么把文档里的清单变成测试
 *
 * `docs/design-language-nebula.md` §9 有 10 条走查项。写在文档里的话，
 * 交付前"逐条过"靠人记 —— 而人会忘，尤其在赶时间的时候。
 *
 * 其中**能用静态判据表达的**（色值、字号、热区、危险写法）全部自动化；
 * 需要人眼判断的（对比度观感、键盘遮挡、玻璃层次数）留在文档里，
 * 并在本文件末尾明确列出"哪些没被自动化"，避免造成"全自动了"的错觉。
 *
 * ## 一条重要的边界
 *
 * 这里扫的是 `client/src/chat/` 这一个目录 —— 即四 Tab 新壳的**新增**文件。
 * 旧客户端（`client/src/editor/` 等）是移植版，不在本设计的管辖范围。
 * 把旧文件也扫进来会得到一堆与本次无关的红，然后这条测试就会被 `skip` 掉。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readShellImplNoComments } from './lib/shell-source.mjs';

const ROOT = join(import.meta.dirname, '..');
const CHAT_DIR = join(ROOT, 'client', 'src', 'chat');
const DIAG_DIR = join(ROOT, 'client', 'src', 'diagnostics');
const TOKENS = 'nebula-tokens.css';

function cssFiles() {
  return readdirSync(CHAT_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, text: readFileSync(join(CHAT_DIR, name), 'utf8') }));
}

/*
 * 文案不只在 `client/src/chat` 里。
 *
 * 2026-11-13：用户会把「诊断日志」面板里的整段文本复制给我们，
 * 那些字符串产自 `client/src/diagnostics/mobile-diag.ts` ——
 * 它里面的 `上次会话**非正常结束**` 同样会被用户看到字面的星号。
 * 所以要把这个目录一起扫。
 */
function tsFiles() {
  const out = [];
  for (const dir of [CHAT_DIR, DIAG_DIR]) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      out.push({ name, text: readFileSync(join(dir, name), 'utf8') });
    }
  }
  return out;
}

/* ── 走查 1：不许有裸色值 ── */

test('★ 走查 1：裸色值只允许出现在 token 文件里', () => {
  const offenders = [];
  for (const { name, text } of cssFiles()) {
    if (name === TOKENS) continue; // token 文件是裸色值的**唯一**合法位置
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // 注释里的色值不算（文档说明里提到颜色是正常的）
      const stripped = line.replace(/\/\*[\s\S]*?\*\//g, '');
      if (/^\s*\*/.test(stripped)) return;
      const hits = stripped.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hits !== null) offenders.push(`${name}:${index + 1} → ${hits.join(',')}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些地方用了裸色值，应改成 var(--nb-*)：\n  ${offenders.join('\n  ')}`,
  );
});

/* ── 走查 5：不许用纯黑做背景 ── */

test('★ 走查 5：不许用纯黑 #000 做背景', () => {
  for (const { name, text } of cssFiles()) {
    // tokens 文件里也不许出现纯黑 —— 设计册明确说要用 #07060B
    assert.equal(
      /background[^;]*#000(000)?\b/i.test(text),
      false,
      `${name} 里用纯黑做了背景（OLED 上滚动会有拖影感）`,
    );
  }
});

/* ── 走查 2：可点元素热区 ≥ 44px ── */

test('★ 走查 2：可点元素的热区都走 44/48 token', () => {
  const text = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

  /*
   * 判据：凡是定义可点元素尺寸的地方，都必须引用 `--nb-hit-min` 或
   * `--nb-icon-btn`，不许写死 px。
   *
   * 为什么这样判而不是"算一遍实际像素"：CSS 里的尺寸可能来自 token 的
   * 嵌套计算，静态算不准。而"有没有写死一个小于 44 的数"是能判的 ——
   * 那正是这条走查要防的错误（比如顺手写了 height: 32px）。
   */
  const clickable = ['.nb-tab {', '.nb-icon-btn {', '.nb-send {', '.nb-listitem {', '.nb-btn {'];
  for (const selector of clickable) {
    const start = text.indexOf(selector);
    assert.ok(start >= 0, `找不到 ${selector} 的定义`);
    const block = text.slice(start, text.indexOf('}', start));
    const hasToken = /--nb-hit-min|--nb-icon-btn/.test(block);
    assert.ok(hasToken, `${selector} 的尺寸必须用 --nb-hit-min / --nb-icon-btn，不许写死 px`);
  }
});

/* ── 走查 4：正文最小字号 ≥ 16 ── */

test('★ 走查 4：正文字号不小于 16（列表副标题可 14）', () => {
  const text = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

  // 气泡正文与输入框是"正文"，必须 16
  for (const selector of ['.nb-bubble {', '.nb-input {']) {
    const start = text.indexOf(selector);
    assert.ok(start >= 0, `找不到 ${selector}`);
    const block = text.slice(start, text.indexOf('}', start));
    assert.ok(
      block.includes('--nb-fs-16'),
      `${selector} 的字号必须是 --nb-fs-16（桌面端的 14px 搬到手机上偏小）`,
    );
  }
});

/* ── 走查 6：动效只动 transform/opacity + reduced-motion 兜底 ── */

test('★ 走查 6：动效只用 transform/opacity，且有 prefers-reduced-motion 兜底', () => {
  const chatCss = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const tokensCss = readFileSync(join(CHAT_DIR, TOKENS), 'utf8');

  /*
   * ★ 必须先剥离注释再扫。
   *
   * 起稿时这条在代码改对之后仍然红，原因是**注释里写了错误的写法**：
   *
   *   起稿写的是 `height: ...` + `transition: height` —— 走查当场红了
   *
   * 那行注释本身含 "transition: height"，被正则当成真代码。
   * 这已经是本项目第二次踩「注释被当成代码」（第一次是走查 10 的文案扫描）。
   *
   * 教训：任何基于正则的静态扫描，**第一步都应该是剥离注释**，
   * 否则注释里解释错误写法会让检查永远红，最后被 skip 掉。
   */
  const codeOnly = chatCss.replace(/\/\*[\s\S]*?\*\//g, '');

  // 不许出现 width/height/margin/padding 的 transition（会触发 layout）
  const badTransitions = [...codeOnly.matchAll(/transition:\s*([^;]+);/g)]
    .map((m) => m[1])
    .filter((value) => /\b(width|height|margin|padding|top|left)\b/.test(value));
  assert.deepEqual(badTransitions, [], `这些 transition 会触发 layout：${badTransitions.join('; ')}`);

  // 兜底必须在 token 层（改 token 就全站生效，而不是每个组件各写一遍）
  assert.ok(
    tokensCss.includes('prefers-reduced-motion'),
    'token 文件里必须有 prefers-reduced-motion 兜底',
  );
});

/* ── 走查 3：玻璃层次数 ≤ 3 ── */

test('★ 走查 3：玻璃层不超过 3 层（Android WebView 性能约束）', () => {
  const text = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

  /*
   * 判据：统计**声明了 backdrop-filter 的规则数**（不含 token 定义）。
   *
   * 这是静态上限：同一时刻真正叠几层要靠界面看，但"代码里一共只声明了
   * 三处玻璃"能保证它不可能超过三。列表项不许用玻璃这条也顺带守住了 ——
   * 如果谁给 `.nb-listitem` 加了 backdrop-filter，计数就超。
   */
  const declarations = [...text.matchAll(/^\s*(?:-webkit-)?backdrop-filter\s*:/gm)];
  // 每处玻璃通常同时写标准属性与 -webkit- 前缀，所以按 2 折算
  const layers = Math.ceil(declarations.length / 2);
  assert.ok(
    layers <= 3,
    `声明了约 ${layers} 层玻璃（上限 3）。列表项几十个，多一层就会卡。`,
  );
});

/* ── 走查 10：文案里不许有内部术语 ── */

test('★ 走查 10：新增界面文案里没有内部术语', () => {
  const banned = [
    'TODO',
    'FIXME',
    'mock',
    'stub',
    'placeholder 值',
    '暂无数据',
    'null',
    'undefined',
  ];

  /*
   * ★ 纯语言关键字不算"内部术语"（2026-11-04 抓到的假阳性）。
   *
   * `typeof Headers !== 'undefined'` 是标准类型守卫写法，
   * 字符串字面量内容恰好是 `undefined`。它不会被用户看到。
   *
   * 判据的目的是抓"TODO / mock / 占位"这类**写给开发者看的东西漏到界面上**，
   * 不该管 JS 自己的类型名。
   */
  const JS_KEYWORDS = new Set([
    'undefined', 'null', 'true', 'false', 'object', 'string', 'number', 'boolean',
    'function', 'symbol', 'bigint',
  ]);

  const offenders = [];
  for (const { name, text } of tsFiles()) {
    /*
     * ★ 排除诊断日志（2026-11-15）。
     *
     * `diagNote('note', \`[会话] fileName=${x ?? 'null'}\`)` 里的 `null`
     * 是**给排障看的事实**，不是界面文案 —— 那行日志正是为了让
     * "指针当时指向谁"能事后查清才加的。
     *
     * 判据原来的近似是"这个文件里的所有字符串都是文案"，粒度太粗：
     * 它会把日志、错误信息、内部常量一起算进去。
     *
     * 这一条与 §131「判据看错对象」同源：**先问"这段文本给谁看"，
     * 再决定用哪套规则**，而不是拿一套规则套所有字符串。
     */
    const diagRanges = diagNoteRanges(text);
    for (const { text: literal, offset } of stringLiterals(text)) {
      if (inRanges(diagRanges, offset)) continue;

      /* 整体就是语言关键字 ⇒ 跳过 */
      if (JS_KEYWORDS.has(literal.trim())) continue;
      for (const word of banned) {
        if (literal.includes(word)) {
          offenders.push(`${name}: ${word} → '${literal.slice(0, 60)}'`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `界面文案里有内部术语：\n  ${offenders.join('\n  ')}`);
});

/**
 * 抽出源码里**真正的单行字符串字面量**内容。
 *
 * ## 为什么不用正则（这条判据换过两次实现，两次都是正则的错）
 *
 * **第一次**：`/['"][^'"]*word[^'"]*['"]/` —— 漏了 `\n`，
 * 正则从某个 `'` 一路吃到很远处，跨行把代码当字符串。
 *
 * **第二次**（加 `\n` 之后）：`/['"`][^'"`\n]*word[^'"`\n]*['"`]/`。
 * 看起来对，但 2026-10-31 第三批撞到新形态：
 *
 *     this.chatSettingsRoute = this.chatSettingsRoute === 'menu' ? null : 'menu';
 *
 * 正则可以从**第一个字符串的闭合引号**开始，跨过 ` ? null : `，
 * 到**第二个字符串的开引号**结束 —— 于是它认定 `' ? null : '` 是一个
 * 含 `null` 的字符串字面量。**两个相邻字符串之间的代码被当成了文案。**
 *
 * 正则做不了这件事，因为"这个引号是开还是闭"需要**从左往右的顺序状态**，
 * 而正则是无状态的。所以这里手写 20 行词法扫描：遇引号就吃到配对的闭引号，
 * 两个引号之间的才是字面量内容。
 *
 * 顺带处理 `//` 行注释（注释里的引号不算）与 `\\` 转义。
 */
function stringLiterals(text) {
  const out = [];
  /** 是否身处 `/* … *\/` 块注释之中（跨行状态） */
  let inBlock = false;

  /*
   * ★ 返回 `{ text, offset }` 而不是裸字符串（2026-11-15）。
   *
   * ## 为什么需要位置
   *
   * 有的判据要问"这个字面量是**给谁看的**"：
   *
   * ```text
   *   diagNote('note', `[会话] fileName=${x ?? 'null'}`)   ← 诊断日志，写 null 是对的
   *   textContent = '暂无数据'                              ← 界面文案，不许出现内部术语
   * ```
   *
   * 两者在词法上都是字符串，靠内容分不开（都要允许 `null` 这个词出现在
   * 某个场合）。只能靠**在源码里的位置**判断它属于哪类调用。
   *
   * ## 顺带修掉一处脆弱写法
   *
   * 走查里有 `text.indexOf(literal)` 去找位置 —— 同一段文本出现两次时会
   * 找错那个。现在有 offset 了，直接用。
   */
  let offset = 0;
  for (const line of text.split('\n')) {
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf('*/', i);
        if (close < 0) break;
        inBlock = false;
        i = close + 2;
        continue;
      }

      const ch = line[i];

      /*
       * 块注释必须跳过。
       *
       * `chat-view.ts` 的注释里就写着「不许出现"暂无数据"」—— 那是**规定**，
       * 不是文案。不跳过的话这条断言会把规定本身当成违规。
       * 第一版是用"跳过以 `*` 或 `/*` 开头的行"粗暴处理的，那样
       * `const x = 1; /* 注释 *\/` 这种行内块注释漏掉了。
       */
      if (ch === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }

      // 行注释：本行剩下的不看了
      if (ch === '/' && line[i + 1] === '/') break;

      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch;
        let j = i + 1;
        let buf = '';
        while (j < line.length) {
          if (line[j] === '\\') {
            buf += line[j + 1] ?? '';
            j += 2;
            continue;
          }
          if (line[j] === quote) break;
          buf += line[j];
          j += 1;
        }
        out.push({ text: buf, offset: offset + i });
        i = j + 1;
        continue;
      }
      i += 1;
    }
    offset += line.length + 1; // +1 是换行符
  }
  return out;
}

/**
 * 找出所有 `diagNote(...)` 调用的**源码区间**。
 *
 * ## 为什么要这个
 *
 * 诊断日志是给排障看的，允许出现 `null` / `findLatest` 这类内部术语；
 * 界面文案不允许。谓词不同，判据必须分开 —— 否则要么漏（日志混进界面），
 * 要么假红（日志里的 null 被当成界面术语）。
 *
 * ## 括号配对要跳过字符串
 *
 * `diagNote('note', \`a) b\`)` 里那个 `)` 是文案，不是括号。
 * 所以扫的时候要吃掉字符串（单双引号 + 反引号），否则区间会提前闭合。
 */
function diagNoteRanges(text) {
  const ranges = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('diagNote(', from);
    if (at < 0) break;
    let depth = 0;
    let i = at + 'diagNote'.length;
    let quote = '';
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote !== '') {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    ranges.push([at, i]);
    from = i + 1;
  }
  return ranges;
}

/** 某个偏移是否落在诊断调用里 */
function inRanges(ranges, offset) {
  return ranges.some(([a, b]) => offset >= a && offset <= b);
}

/* ── 走查 7：空状态不许是"暂无数据" ── */

test('★ 走查 7：空状态都给了"人话 + 下一步"', () => {
  const shell = readShellImplNoComments();
  const view = readFileSync(join(CHAT_DIR, 'chat-view.ts'), 'utf8');

  /*
   * 判据改成"调用次数 + 每次附近都有 actions 字段"，而不是试图用正则
   * 解析嵌套的对象字面量。
   *
   * 第一版写的是 `/renderEmptyState\([^)]*\{[\s\S]*?\}\s*\)/`，
   * 而参数里有 `onClick: () => this.switchTab('me')` —— 那个 `)` 让
   * `[^)]*` 提前截断，于是匹配数恒为 0。**用正则解析嵌套结构是错的方向。**
   */
  /*
   * 两个文件各查一处 —— 空状态**分布在不同页面里**：
   *   · 聊天的"还没有对话"在 `chat-panel.ts`
   *   · 卡片/仓库的"还在桌面客户端里做"在 `shell.ts`
   *
   * 第一版只扫了 shell.ts 却期望 ≥2，失败原因是**扫错了文件**，不是代码缺东西。
   */
  const panel = readFileSync(join(CHAT_DIR, 'chat-panel.ts'), 'utf8');
  const shellCount = (shell.match(/renderEmptyState\(/g) ?? []).length;
  const panelCount = (panel.match(/renderEmptyState\(/g) ?? []).length;

  assert.ok(shellCount >= 1, `卡片/仓库页要有空状态（实际 ${shellCount} 处）`);
  assert.ok(panelCount >= 1, `聊天页要有空状态（实际 ${panelCount} 处）`);
  assert.ok(
    (shell.match(/actions:/g) ?? []).length >= shellCount,
    'shell 里每个空状态都要给明确的下一步动作',
  );
  assert.ok(
    (panel.match(/actions:/g) ?? []).length >= panelCount,
    '聊天页空状态也要给下一步动作',
  );

  assert.equal(
    /暂无数据/.test(shell),
    false,
    '不许出现"暂无数据" —— 那是信息量为零的句子',
  );
});

/* ═══════════════════════════════════════════════════════════
   ★ 明确说明：哪些走查项**没有**被自动化
   ═══════════════════════════════════════════════════════════

   写在这里是为了避免"全自动了"的错觉 —— 下次交付时这几条仍要人眼看：

   · 第 3 条的后半（同一时刻屏幕上真正叠了几层）—— 只能看界面；
   · 第 8 条 键盘弹起后输入框是否被挡 —— 需要真实软键盘；
   · 第 9 条 深色下的实际对比度数值 —— 需要渲染色值后计算；
   · 第 2 条的热区**实际点击**是否好按 —— 需要触摸屏。

   前三项里，第 9 条本可以算（token 里色值是确定的），但算出来的比值
   再准也不能替代"看起来累不累" —— 那是设计判断，不是断言。
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   ★ CSS 注释里出现“星号紧跟斜杠”的陷阱（2026-10-30 实测踩过）
   ═══════════════════════════════════════════════════════════ */

test('★ CSS 注释里不许出现提前闭合的注释符（会让整块规则被静默丢弃）', () => {
  /*
   * ## 这条测试是拿一整轮调试换来的
   *
   * 我在 `nebula-tokens.css` 的注释里写了 `grep ... src/**\/*.css`
   * —— 那个 glob 的 `**` 紧跟 `/`，恰好构成 `*` + `/`。
   * 于是**注释在那一行就闭合了**，后面的 `--nb-*` 声明全部变成非法 CSS，
   * 浏览器把整个 `:root` 块丢掉。
   *
   * 后果极其隐蔽：
   *   · CSS 不报错，控制台一片干净；
   *   · 页面上大部分样式仍然正常（chat.css 里直接写的属性都生效）；
   *   · 只有用 `var(--nb-*)` 的地方失效 —— 表现为"麦克风按钮 22×23
   *     而不是 48×48"，看起来像布局 bug。
   *
   * 判据：把每个 `/* ... *\/` 注释块剥掉以后，花括号必须仍然配平，
   * 且 token 文件里必须还能找到 `--nb-*` 的声明（说明 `:root` 块没被吃掉）。
   */
  for (const { name, text } of cssFiles()) {
    // 用非贪婪匹配剥离注释；如果注释里有提前闭合，剥离结果会残留 `*` 片段
    const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');

    // 剥离后不该再有孤立的 `*/`（那是提前闭合留下的残渣）
    assert.equal(
      stripped.includes('*/'),
      false,
      `${name} 剥离注释后仍残留 \`*/\` —— 说明注释被提前闭合了`,
    );

    // 花括号必须配平
    const opens = (stripped.match(/\{/g) ?? []).length;
    const closes = (stripped.match(/\}/g) ?? []).length;
    assert.equal(
      opens,
      closes,
      `${name} 括号不配平（${opens} 开 / ${closes} 闭）—— 大概率是注释提前闭合`,
    );
  }
});

test('★ token 文件的 :root 块必须存活（变量真的能被声明）', () => {
  const text = readFileSync(join(CHAT_DIR, TOKENS), 'utf8');
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');

  // 关键变量必须在"剥离注释后的真实 CSS"里出现
  for (const name of ['--nb-icon-btn', '--nb-hit-min', '--nb-text-1', '--nb-grad-primary']) {
    assert.ok(stripped.includes(name), `剥离注释后找不到 ${name} —— :root 块可能被吞了`);
  }

  // 而且必须在 :root 选择器里（不是散在别处）
  const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(stripped);
  assert.ok(rootBlock !== null, '找不到 :root 块');
  assert.ok(rootBlock[1].includes('--nb-icon-btn'), ':root 块里没有 --nb-icon-btn');
});

/* ═══════════════════════════════════════════════════════════
   ★ UI 层不许有未转义的 innerHTML
   ═══════════════════════════════════════════════════════════ */

test('★ 所有 innerHTML 赋值都必须经过 renderMessageHtml', () => {
  /*
   * ## 这条是自查抓出来的真实漏洞
   *
   * `chat-panel.ts` 第一版在流式时写：
   *   `bubble.innerHTML = state.text`
   * 而 `state.text` 是 LLM 返回的**原文**。只要模型吐出
   * `<img src=x onerror=...>`，流式那一两秒就会当场执行。
   *
   * 为什么之前的测试抓不到：
   *   · DOM 测试用的是 `renderMessage`（已转义），没测流式那条路径；
   *   · 结束后 `render()` 也走 `renderMessageHtml`，所以"看最终结果"是干净的；
   *   · 漏洞**只存在于中间态**。
   *
   * 所以加一条静态断言，把"所有 innerHTML 都要经过渲染函数"变成纪律。
   */
  const offenders = [];
  for (const { name, text } of tsFiles()) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      // 只看真正的赋值（含 `.innerHTML =`），不看注释与类型声明
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (!/\.innerHTML\s*=/.test(line)) return;

      /*
       * 允许的三种形态：
       *   ① 右边是 renderMessageHtml(...)
       *   ② 右边是空串 ''（清空，无注入面）
       *   ③ 右边是三元里只有空串与 renderMessageHtml
       */
      const ok = /renderMessageHtml/.test(line) || /=\s*''\s*;?\s*$/.test(line) || /=\s*"";?\s*$/.test(line);
      if (!ok) offenders.push(`${name}:${index + 1} → ${trimmed.slice(0, 90)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `这些 innerHTML 赋值没走渲染函数（可能是 XSS 入口）：\n  ${offenders.join('\n  ')}`,
  );
});

/* ── 走查 11：宽度上限必须真的能约束住 ── */

test('★ 走查 11：写了 max-width 的元素必须同时是 border-box', () => {
  /*
   * 这条来自 2026-10-30 录屏抓到的一个真缺陷。
   *
   * 语音草稿的音频条宽度由时长算出来（JS 传 `--nb-voice-bar-width`），
   * CSS 里再写 `max-width: 50vw` 当兜底 —— 需求原文是"最长不要超过屏幕
   * 宽度的一半"。
   *
   * 但 `max-width` 约束的是**内容盒**。元素默认 `box-sizing: content-box`，
   * 于是左右 padding 与边框会加在它之外：
   *
   *     JS 给 120px → 实测 getBoundingClientRect().width = 146px
   *                                          （120 + 12×2 + 1×2）
   *
   * 内容顶到 180px 时可见宽度是 206px，在 360 宽的屏上占 57% ——
   * **约束写了，但没生效**。
   *
   * 更值得记的是当时怎么漏掉的：截图核对判的是"146 ≤ 180，通过"。
   * 数字碰巧没顶到上限，于是这条判据绿了 —— 而它绿的原因与"约束有没有
   * 生效"毫无关系。这就是"绿而无用"的典型：判据要问"约束在不在"，
   * 不能只问"这次的值有没有越界"。
   */
  const text = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * 判据要**窄到只抓真问题**：只有当同一个块里既有 `max-width`、又有
   * `padding` / `border` 时，`content-box` 才会把可见宽度撑出上限。
   *
   * 第一版写成"只要写了 max-width 就必须 border-box"，当场红了 4 条
   * （`.nb-msg`、`.nb-empty-text`、`.nb-voice-draft-card`、`.nb-voice-textwrap`），
   * 而那 4 个块**根本没有 padding 与 border**，cap 本来就是准的。
   *
   * 一刀切的下场是可预见的：后来的人为了让测试变绿，会给这些块统统补一句
   * `box-sizing`，而这句对它们毫无作用，只是把信号稀释掉。
   * 判据要能回答"差异是否必然存在"——不存在的差异，不要去要求。
   */
  const blocks = [...codeOnly.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const offenders = [];
  for (const [, selector, body] of blocks) {
    if (!/max-width\s*:/.test(body)) continue;
    if (!/(^|[;{\s])(padding|border)\s*:/.test(body)) continue;
    if (/box-sizing\s*:\s*border-box/.test(body)) continue;
    offenders.push(selector.trim().replace(/\s+/g, ' '));
  }
  assert.deepEqual(
    offenders,
    [],
    `这些块同时写了 max-width 与 padding/border 却没声明 box-sizing: border-box，实际宽度会被撑出上限：\n  ${offenders.join('\n  ')}`,
  );
});

/* ── 走查 12：同一个选择器不许定义两次 ── */

test('★ 走查 12：chat.css 里同一个选择器只许出现一次', () => {
  /*
   * 这条来自 2026-10-30 那个"补了 box-sizing 却看不到效果"的坑。
   *
   * 真实经过：草稿卡的 textarea 溢出了父容器（`right` 370px > 视口 360px），
   * 于是我在 `.nb-voice-draft` 里补了 `box-sizing: border-box`。
   * 重新截图 —— **溢出还在**。第一反应是"headless 的 CSS 没热更新"、
   * "是不是 measurement 时机不对"，查了两轮。
   *
   * 真因是文件里有两处 `.nb-voice-draft`：后一处是改版前"编辑框长在输入区"
   * 的残留，把 `box-sizing`、`flex`、`min-width` 全部静默覆盖回去了。
   * 而 CSS 的层叠规则里后写的赢 —— 它不报错、不警告，什么提示都没有。
   *
   * 为什么用这条判据而不是"几何校验"：我一开始写的是"写了 width 且带
   * padding/border 的必须 border-box"，结果红了 5 条，其中三条是误报 ——
   * `.nb-voice-stage` 的水平 padding 是 0（不会溢出）、`.nb-switch` 是
   * 48px + 1px 边框（只差 2px，属于设计精度而不是缺陷）。
   * 一条判据如果一半是误报，结局一定是被人加豁免加到失效。
   *
   * 而"同一选择器只出现一次"是**精确可判、零误报**的：重复定义本身就是缺陷，
   * 无论这一次有没有造成可见问题 —— 它下一次会的。
   */
  const text = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '');

  /*
   * ★ 必须先剥掉 `@keyframes` 的**块内部**。
   *
   * 2026-10-31 第三批撞到：我给收纳项加了 `@keyframes nb-acc-enter { from{} to{} }`，
   * 而文件里早已有 `@keyframes nb-msg-in { from{} to{} }` —— 于是扫描器看到
   * `from` 出现 2 次、`to` 出现 2 次，报"同一选择器定义了多次"。
   *
   * 那两条是**两个动画各自的关键帧**，重复是完全合法的 CSS。
   * 判据想抓的是"同一选择器被定义两次"（后一处静默覆盖前一处），
   * 而 keyframes 里的 `from` / `to` 根本不是选择器。
   *
   * 这是把判据**精确化**，不是放松：真正的重复选择器照样会红
   * （剥 keyframes 的动作用 `[{}]` 配平扫描，不碰其它块；改完用变异验证过）。
   */
  const selectorOnly = stripAtBlocks(codeOnly, 'keyframes');

  const seen = new Map();
  // 只取「单选择器」的块，逗号选择器组与 @media 内部的单独算
  for (const [, rawSelector] of selectorOnly.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const one of rawSelector.split(',')) {
      const sel = one.trim().replace(/\s+/g, ' ');
      if (sel === '' || sel.startsWith('@')) continue;
      seen.set(sel, (seen.get(sel) ?? 0) + 1);
    }
  }

  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([sel, n]) => `${sel} ×${n}`);
  assert.deepEqual(
    duplicated,
    [],
    `这些选择器被定义了多次，后一处会静默覆盖前一处（改了没生效多半就是这个）：\n  ${duplicated.join('\n  ')}`,
  );
});

/**
 * 把 `@<atName> … { … }` 整块（含嵌套花括号）从文本里剥掉。
 *
 * 用于：扫"选择器是否重复"时跳过 `@keyframes` 内部 —— 那里的
 * `from` / `to` 是**关键帧**不是选择器，多个动画各写一遍完全合法。
 *
 * ## 为什么是按花括号配平扫描，而不是正则
 *
 * `@keyframes x { from { a:b } to { c:d } }` 有两层花括号，
 * `[^{}]*` 这类正则只能吃到第一层就停（或吃穿）。而这个项目里
 * "用正则解析嵌套结构"已经失败过两次（见走查 7 的注释）。
 *
 * 配平扫描只依赖一个深度计数，20 行、无歧义。
 *
 * `@media` **不剥** —— 它内部的选择器是真实的，重复了也该报。
 */
function stripAtBlocks(text, atName) {
  let out = '';
  let i = 0;
  const marker = `@${atName}`;

  while (i < text.length) {
    const at = text.indexOf(marker, i);
    if (at < 0) {
      out += text.slice(i);
      break;
    }

    out += text.slice(i, at);

    const open = text.indexOf('{', at);
    if (open < 0) {
      out += text.slice(at);
      break;
    }

    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }

    // 留一个空块占位：保持"块"的边界感，但不贡献任何选择器
    out += `${marker}-stripped{}`;
    i = j;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════
   走查 11：用户看得见的字符都得有意义
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 界面文案里不许有 markdown 强调语法残留', () => {
  /*
   * ## 真机现场（2026-11-13，用户截图）
   *
   * 「诊断日志」副标题原样显示：
   *
   * ```text
   *   上次**异常结束** · 共 0 条 · 0.0/18MB
   * ```
   *
   * 那四个星号是我在**注释里**习惯写 `**重点**` 的写法，直接漏进了
   * 用户可见的模板字符串。`textContent` 不做 markdown 渲染 ——
   * 星号就是四个字符。
   *
   * ## ★★★ 为什么不能"扫所有字符串"
   *
   * 我第一版就是全局扫的，结果抓到两处**都不该改**：
   *
   * ```text
   *   demo.ts   「**好啊。**」              ← 演示对话，气泡走 innerHTML
   *                                           渲染 markdown，星号是合法的
   *   shell.ts  请**不要**替代角色说话      ← 发给 AI 的指令，星号是强调
   * ```
   *
   * 项目的渲染分两条路：
   *
   * ```text
   *   聊天气泡  innerHTML + renderMessageHtml ⇒ 支持 markdown ⇒ ** 合法
   *   其余文案  textContent                   ⇒ 纯文本      ⇒ ** 是字面量
   * ```
   *
   * 所以判据必须**按位置**判，不能按内容判。
   *
   * ## 判据：只看"这条文案最终进的是纯文本槽位"
   *
   * 两种形态都算命中：
   *
   * ```text
   *   ① 字面量紧跟在槽位后面     x.textContent = '…'      { subtitle: '…' }
   *   ② 所在语句的变量名是槽位   const subtitle = 条件 ? A : '…'
   * ```
   *
   * ② 是这次真 bug 的形态（`const subtitle = 条件 ? A : B`，星号在 B 里）。
   * 光看"字面量前面是什么"抓不到 —— 它前面是 `:`，再往前是条件变量。
   *
   * ## 为什么不用"附近有槽位就算"
   *
   * 我试过（往前看 240 字符），结果把 `runDirective('请**不要**…')` 也抓了
   * —— 因为同一个箭头函数体里上一行刚写过一个 `detail: '…'`。
   * **同一个函数里有别的槽位**不等于**这条字符串是文案**。
   */
  const SLOTS = new Set(['textContent', 'subtitle', 'title', 'detail', 'label', 'hint', 'alt']);
  const offenders = [];

  for (const { name, text } of tsFiles()) {
    for (const { text: literal, offset: literalAt } of stringLiterals(text)) {
      /* 成对星号，中间是短内容（强调用法），不是幂运算 */
      const pairs = literal.match(/\*\*[^*\n]{1,40}\*\*/g);
      if (pairs === null) continue;

      /*
       * 用字形自己的 offset，不再 `text.indexOf(literal)`（2026-11-15）。
       *
       * 同一段文本在文件里出现两次时 indexOf 恒返回**第一个**位置，
       * 于是判据检查的是"第一次出现的那个上下文" —— 而真正违规的
       * 可能是第二处。这类错在本项目已经出现过（§131 取错对象）。
       */
      const at = literalAt;
      if (at < 0) continue;

      /* ① 紧邻槽位：跳过引号与空白，应见到 `=` / `:`，再往前是槽位名 */
      let i = at - 1;
      while (i >= 0 && '"\'`'.includes(text[i])) i -= 1;
      while (i >= 0 && /\s/.test(text[i])) i -= 1;
      let directly = false;
      if (text[i] === '=' || text[i] === ':') {
        i -= 1;
        while (i >= 0 && /\s/.test(text[i])) i -= 1;
        const end = i + 1;
        while (i >= 0 && /[\w.]/.test(text[i])) i -= 1;
        const owner = text.slice(i + 1, end).split('.').pop();
        directly = owner !== undefined && SLOTS.has(owner);
      }
      if (directly) {
        for (const hit of pairs) offenders.push(`${name}: ${hit}（直接赋给纯文本槽位）`);
        continue;
      }

      /*
       * ② 所在语句的变量名是槽位：往回 600 字符找最近的 `const X =`。
       *
       * 600 足够覆盖一个多行三元表达式（这次那个约 200 字符），
       * 又不会翻到上一个函数里去。
       */
      const back = text.slice(Math.max(0, at - 600), at);
      const decls = [...back.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]*)?=/g)];
      const owner = decls.length > 0 ? decls[decls.length - 1][1] : undefined;
      if (owner !== undefined && SLOTS.has(owner)) {
        for (const hit of pairs) offenders.push(`${name}: ${hit}（赋给纯文本变量 ${owner}）`);
        continue;
      }

      /*
       * ③ 直接 push 进一个纯文本数组（诊断报告就是这么拼的）。
       *
       * `lines.push('上次会话：**非正常结束**…')` —— 两个 `**` 之间是中文，
       * 没有 `=` / `:` 让形态 ①② 命中，但它们最终会被 `join('\n')`
       * 成一份给用户复制的文本。所以 `push(` / `unshift(` / `log(` 也算。
       */
      const pushAt = back.lastIndexOf('push(');
      const unshiftAt = back.lastIndexOf('unshift(');
      const near = Math.max(pushAt, unshiftAt);
      /*
       * 窗口 200 而不是 40：真实的诊断报告是**多行三元**，
       * `lines.push(` 到那个字面量隔了 60 多个字符（分行 + 缩进 + 条件）。
       *
       * 但放宽窗口会更容易串到上一条语句 ⇒ 要求中间**没有 `;`**
       * （有就说明已经跨过了一条语句）。
       */
      const between = near >= 0 ? back.slice(near) : '';
      if (near >= 0 && between.length < 200 && !between.includes(';')) {
        for (const hit of pairs) offenders.push(`${name}: ${hit}（进入纯文本数组）`);
      }
    }
  }
  /*
   * ★ 还要扫 Kotlin 里的**用户可见字符串**（2026-11-13）。
   *
   * 诊断日志的正文有一部分是原生写的（`BOOT` / `MEM` / `CRASH` 那些），
   * 而用户会把它**原样复制发给我们**。所以 Kotlin 字符串里的 `**`
   * 同样会出现在他眼前。
   */
  for (const { name, text } of ktUserStrings()) {
    const pairs = text.match(/\*\*[^*\n]{1,40}\*\*/g);
    if (pairs === null) continue;
    for (const hit of pairs) offenders.push(`${name}: ${hit}（Kotlin 里会写进日志）`);
  }

  assert.deepEqual(
    offenders,
    [],
    `纯文本界面文案里有 markdown 星号（用户会看到字面的 **）：\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * 取 Kotlin 源码里"可能写进用户可见日志"的字符串字面量。
 *
 * ## 只挑 StLog / Log 的调用
 *
 * 全扫会把注释、资源名、logcat tag 都卷进来。这些字符串的特点是
 * **必然经过 `StLog.x(` / `Log.x(`** —— 那是日志的唯一出口。
 *
 * ## 为什么要去掉注释
 *
 * 判据自己被坑过一次：注释里写了被搜的字符串，于是变异删掉真代码
 * 也不变红（见 §93 与本文件 CSS 那条的注释）。
 */
function ktUserStrings() {
  const dir = join(ROOT, 'client', 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'java', 'com', 'taverncardstudio', 'client');
  const out = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.kt')) continue;
      const raw = readFileSync(full, 'utf8');
      /* 去掉块注释与行注释，再找 StLog/Log 调用里的字符串 */
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const match of code.matchAll(/\bSt?Log\.[iwed]\(([\s\S]{0,300}?)\)/g)) {
        out.push({ name: entry.name, text: match[1] });
      }
    }
  };
  walk(dir);
  return out;
}

test('★★★★★ 说明类文本必须能断长串（路径/URL 不许顶破容器）', () => {
  /*
   * ## 真机现场（2026-11-13，用户截图）
   *
   * ```text
   *   日志文件：/storage/emulated/0/Android/data/com.taven…
   *            ↑ 被卡片右边缘切掉，后面全看不见
   * ```
   *
   * ## 为什么这不是"个别地方忘了写"
   *
   * 「中文 + 一条没有空格的绝对路径」是最坏的组合：中文每字可断，
   * 而 CSS 默认只在空格处断行 ⇒ 整条路径被当成一个不可分的块。
   *
   * 而**这条路径是我们自己拼进文案的**（`日志文件：${status.dir}`），
   * 也就是说：只要一个说明段落里会插入路径/URL，就必须有换行策略。
   *
   * ## 判据
   *
   * ```text
   *   .nb-note 必须有 overflow-wrap   ← 说明类文本的通用容器
   *   .nb-diag-pre 必须有 word-break   ← 等宽日志（逐字符断才对）
   * ```
   *
   * 钉的是**性质**（能不能断）而不是具体写法，两套等价写法都放行。
   */
  const css = cssFiles();
  const cssAt = (file) => css.find((one) => one.name === file);
  const chat = cssAt('chat.css');
  assert.ok(chat !== undefined, '找不到 chat.css');

  /*
   * ★★★ 必须先剥掉 CSS 注释再匹配（2026-11-13，这条判据自己踩的坑）。
   *
   * 我给 `.nb-note` 写的说明注释里就有这一句：
   *
   * ```text
   *   ## 为什么 `overflow-wrap: anywhere` 而不是 `word-break: break-all`
   * ```
   *
   * 于是"删掉真正的声明"之后判据**照样绿** —— 它匹配到的是注释里那串字。
   * 变异因此没变红，等于这条判据在保护一句注释。
   *
   * 这与 §93「判据两次看错对象」是同一类错：注释里写被搜字符串。
   */
  const stripCssComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
  const code = stripCssComments(chat.text);

  const blockOf = (selector) => {
    const at = code.indexOf(`\n${selector} {`);
    assert.ok(at > 0, `找不到 ${selector}`);
    const end = code.indexOf('\n}', at);
    return code.slice(at, end < 0 ? at + 1200 : end);
  };

  const note = blockOf('.nb-note');
  assert.match(
    note,
    /overflow-wrap:\s*(anywhere|break-word)/,
    '.nb-note 要能断长串 —— 它正是"日志文件：<一条绝对路径>"那个容器',
  );

  const pre = blockOf('.nb-diag-pre');
  assert.match(
    pre,
    /word-break:\s*(break-all|break-word)/,
    '.nb-diag-pre 要能断长串（堆栈里的路径没有空格）',
  );
});
