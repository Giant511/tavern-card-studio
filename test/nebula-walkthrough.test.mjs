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

const ROOT = join(import.meta.dirname, '..');
const CHAT_DIR = join(ROOT, 'client', 'src', 'chat');
const TOKENS = 'nebula-tokens.css';

function cssFiles() {
  return readdirSync(CHAT_DIR)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, text: readFileSync(join(CHAT_DIR, name), 'utf8') }));
}

function tsFiles() {
  return readdirSync(CHAT_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(CHAT_DIR, name), 'utf8') }));
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
    for (const literal of stringLiterals(text)) {
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
        out.push(buf);
        i = j + 1;
        continue;
      }
      i += 1;
    }
  }
  return out;
}

/* ── 走查 7：空状态不许是"暂无数据" ── */

test('★ 走查 7：空状态都给了"人话 + 下一步"', () => {
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
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
