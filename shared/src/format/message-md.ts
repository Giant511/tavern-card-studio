/**
 * 聊天消息的 Markdown 渲染（v0.1.7 / T15.5）。
 *
 * ## 为什么这个文件是"新写"的，而不是"复用既有管线"
 *
 * 契约 §5.2 写的是「Markdown 渲染 / 表情 / 宏替换 —— 移动端复用 v0.1.6
 * 渲染管线（`shared` 里已有）」。**这个前提不成立**：
 * `shared/format/` 里只有卡片 TXT/JSON 的编解码，没有任何消息正文渲染；
 * `client` 也没装 markdown 库（只有 CodeMirror，那是**编辑器语法高亮**，
 * 不是"把消息正文变成 HTML"）。已于 2026-10-30 向用户确认，选择
 * 「shared 写零依赖最小渲染器」。
 *
 * ## 为什么零依赖、为什么自己写
 *
 * 三条项目纪律压过"用现成库更方便"：
 *
 * 1. **shared 至今零运行时依赖**。引入 `markdown-it` + `DOMPurify` 是两个
 *    供应链面，而这里要处理的东西（六个行内标记 + 五类行级结构）用不到
 *    它们能力的一成；
 * 2. **可单测**。纯字符串进、纯字符串出，Node 里直接跑，不需要 DOM；
 * 3. **安全边界必须自己能说清**。消息正文来自 LLM 与用户输入，是**不可信内容**。
 *    用库的话，"它默认安不安全"要靠读它的文档与版本历史来保证；
 *    自己写的话，防线就是下面这一段，能一眼看完。
 *
 * ## ★ 安全模型：先转义，再做标记替换
 *
 * 顺序**不能反**，这是整个文件的根基：
 *
 * ```text
 * ① 宏替换（{{char}} 等）→ ② HTML 全量转义 → ③ 行级结构 → ④ 行内标记
 * ```
 *
 * 因为 ② 已经把 `<` `>` `&` `"` `'` 全变成了实体，之后无论用户写了什么，
 * 都**不可能再形成 HTML 标签**。③④ 只负责把 `**x**` 这类**纯符号**换成标签。
 *
 * 反过来（先替换标记再转义）会得到两种错误：
 *   · `**粗体**` → `<strong>粗体</strong>` → 转义 → 用户看到字面的 `<strong>`；
 *   · 或者为了"不转义我刚生成的标签"而放行白名单 → 一处漏判就是 XSS。
 *
 * 链接额外过一道协议白名单（`javascript:` / `data:` / `vbscript:` 一律降级为纯文本），
 * 因为转义挡不住 `[点我](javascript:alert(1))` —— 那个 `javascript:` 是合法字符串。
 *
 * ## 支持的子集（ST 聊天里真正会出现的）
 *
 * | 语法 | 输出 | 备注 |
 * |---|---|---|
 * | `**粗体**` `__粗体__` | `<strong>` | |
 * | `*斜体*` `_斜体_` | `<em>` | ST 里大量用 `*动作*`，这条必须有 |
 * | `~~删除线~~` | `<del>` | |
 * | `` `代码` `` | `<code>` | 行内 |
 * | ```` ``` ```` 围栏 | `<pre><code>` | 内部不再解析行内标记 |
 * | `> 引用` | `<blockquote>` | 连续行合并 |
 * | `- ` / `* ` / `1. ` | `<ul>` / `<ol>` | 连续的合成一个列表 |
 * | `---` | `<hr>` | |
 * | 空行 | 段落分隔 | 单个换行 → `<br>`（ST 的书写习惯） |
 *
 * **不做**：表格、脚注、HTML 内联（本来就该被转义）、嵌套列表（v1 用不到）。
 * 这些"不做"是刻意的 —— 每多支持一种，就多一处可能与转义顺序打架的地方。
 */

/** 宏替换用的名字。ST 的 `{{char}}` / `<BOT>` 都指角色，`{{user}}` / `<USER>` 指用户。 */
export interface MessageMacros {
  charName?: string;
  userName?: string;
}

export interface RenderMessageOptions extends MessageMacros {
  /**
   * 是否把 `[文字](url)` 渲染成链接。默认 `true`。
   *
   * 关掉它的场景：导出成纯文本预览、或某些不想让消息里有可点内容的视图。
   */
  allowLinks?: boolean;
}

/**
 * HTML 全量转义。
 *
 * 五个字符一个都不能少：
 *   · `<` `>` —— 标签的骨架
 *   · `&` —— 实体前缀，不转义会让 `&lt;` 被二次解释
 *   · `"` `'` —— 属性值里的引号。虽然本渲染器不给用户内容加属性，
 *     但漏掉它们等于把"以后某个改动引入了属性拼接"变成 XSS 入口
 *
 * `&` **必须第一个替换**，否则 `&lt;` 会被自己的 `&` 规则弄成 `&amp;lt;`。
 * 用一次 replace 带回调而不是链式五次，就是为了根除这个顺序依赖。
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 允许的链接协议。白名单而不是黑名单 —— 黑名单永远漏。 */
const SAFE_PROTOCOLS = ['http://', 'https://', 'mailto:'];

/**
 * 判断一个 href 能不能用。相对路径、锚点视为安全（没有协议前缀）。
 *
 * 注意要先**去掉首尾空白并忽略大小写**：` JavaScript:alert(1)` 用大小写或空格
 * 绕过是很老的招式，但仍然是真实存在的招式。
 */
function isSafeHref(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return false;
  // 没有 `:` 就是相对路径/锚点，不会有协议执行风险
  const colon = value.indexOf(':');
  const slash = value.indexOf('/');
  if (colon === -1 || (slash !== -1 && slash < colon)) {
    // 形如 `foo/bar` 或 `#anchor` —— 但 `javascript:` 走不到这里
    return !value.startsWith('//');
  }
  return SAFE_PROTOCOLS.some((p) => value.startsWith(p));
}

/**
 * 应用宏替换。**必须在转义之前**。
 *
 * 为什么在转义前：宏的值（角色名）本身可能含 `<` 或 `&`。
 * 先替换再整体转义，那些字符会和其他正文一样被中和；
 * 若先转义再替换，就会把**未转义的名字**直接插进已转义的文本里，成为 XSS 入口。
 *
 * 未知宏原样保留（`{{unknown}}` 不动）—— 静默删掉会让用户以为消息丢了内容。
 */
function applyMacros(text: string, macros: MessageMacros): string {
  let out = text;
  const char = macros.charName;
  const user = macros.userName;
  if (char !== undefined && char !== '') {
    out = out.replace(/\{\{char\}\}/gi, char).replace(/<BOT>/gi, char);
  }
  if (user !== undefined && user !== '') {
    out = out.replace(/\{\{user\}\}/gi, user).replace(/<USER>/gi, user);
  }
  return out;
}

/** 行内标记：粗体 / 斜体 / 删除线 / 行内代码 / 链接。输入必须**已转义**。 */
function renderInline(escaped: string, allowLinks: boolean): string {
  let out = escaped;

  /*
   * 行内代码先做，并且**占位保护**。
   *
   * 不这样做的话 `` `**不是粗体**` `` 会被后面的粗体规则命中，
   * 用户看到的是"代码里居然加粗了"。占位用的是转义后不可能出现的私用区字符
   * （U+E000 起），替换完再还原。
   */
  const codeSlots: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${inner}</code>`);
    return `\uE000${idx}\uE001`;
  });

  // 链接：先做，避免 [a](b) 里的 * 被斜体规则吃掉
  if (allowLinks) {
    out = out.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) => {
      if (!isSafeHref(href)) {
        // 不安全：降级成纯文本（保留可读内容，丢掉可点能力）
        return label.length > 0 ? `${label}（${href}）` : whole;
      }
      return `<a href="${href}" rel="noopener noreferrer" target="_blank">${label || href}</a>`;
    });
  }

  // 粗体在斜体之前：`**x**` 必须先于 `*x*` 命中，否则会先匹配到单个星号
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>');

  // 还原行内代码
  out = out.replace(/\uE000(\d+)\uE001/g, (_m, idx: string) => codeSlots[Number(idx)] ?? '');

  return out;
}

/** 列表 / 引用 的跨行合并状态 */
type BlockKind = 'none' | 'ul' | 'ol' | 'quote';

/**
 * 渲染消息正文为 HTML。
 *
 * 返回值是**可直接放进 innerHTML 的字符串**，且已经过全量转义 ——
 * 调用方不需要（也不应该）再转义一次，否则会双重转义。
 */
export function renderMessageHtml(markdown: string, options: RenderMessageOptions = {}): string {
  const allowLinks = options.allowLinks !== false;

  // ① 宏替换 → ② 全量转义（顺序见文件头）
  const escaped = escapeHtml(applyMacros(markdown, options));

  const lines = escaped.split(/\r\n|\r|\n/);
  const html: string[] = [];

  let block: BlockKind = 'none';
  let para: string[] = [];
  /** 代码围栏内收集的行；null = 不在围栏内 */
  let fence: string[] | null = null;

  const closeBlock = (): void => {
    if (block === 'ul') html.push('</ul>');
    else if (block === 'ol') html.push('</ol>');
    else if (block === 'quote') html.push('</blockquote>');
    block = 'none';
  };

  const flushPara = (): void => {
    if (para.length === 0) return;
    // 段内单个换行 → <br>：ST 的书写习惯是按"行"断句
    html.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };

  for (const line of lines) {
    // ── 围栏代码块：内部不再解析任何标记 ──
    if (fence !== null) {
      if (/^\s*```\s*$/.test(line)) {
        html.push(`<pre><code>${fence.join('\n')}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushPara();
      closeBlock();
      fence = [];
      continue;
    }

    // ── 空行：结束当前块 ──
    if (line.trim() === '') {
      flushPara();
      closeBlock();
      continue;
    }

    // ── 分隔线 ──
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      flushPara();
      closeBlock();
      html.push('<hr>');
      continue;
    }

    // ── 引用 ──
    const quote = /^\s*&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      if (block !== 'quote') {
        closeBlock();
        html.push('<blockquote>');
        block = 'quote';
      }
      // 引用内部允许行内标记（粗体/斜体），但不嵌套引用
      html.push(`<p>${renderInline(quote[1] ?? '', allowLinks)}</p>`);
      continue;
    }

    // ── 无序列表 ──
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushPara();
      if (block !== 'ul') {
        closeBlock();
        html.push('<ul>');
        block = 'ul';
      }
      html.push(`<li>${renderInline(ul[1] ?? '', allowLinks)}</li>`);
      continue;
    }

    // ── 有序列表 ──
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushPara();
      if (block !== 'ol') {
        closeBlock();
        html.push('<ol>');
        block = 'ol';
      }
      html.push(`<li>${renderInline(ol[1] ?? '', allowLinks)}</li>`);
      continue;
    }

    // ── 普通段落行 ──
    closeBlock();
    para.push(renderInline(line, allowLinks));
  }

  // 收尾：未闭合的围栏按代码块输出（比静默丢弃安全 —— 用户能看到自己写了什么）
  if (fence !== null) {
    html.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  }
  flushPara();
  closeBlock();

  return html.join('');
}

/**
 * 只取纯文本（去掉所有标记），用于：
 *   · 聊天列表的摘要行
 *   · 无障碍的 aria-label
 *   · 复制到剪贴板
 *
 * 刻意**不复用** `renderMessageHtml` 再剥标签 —— 那要先拼 HTML 再正则删，
 * 既慢又容易漏（比如 `<code>` 里的内容会被当成标签剥掉）。
 */
export function renderMessageText(markdown: string, options: MessageMacros = {}): string {
  const text = applyMacros(markdown, options);
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '')) // 留内容丢围栏
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]+\)/g, '$1')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*&gt;\s?/gm, '')
    .replace(/^\s*---\s*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
