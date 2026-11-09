/**
 * 消息 Markdown 渲染（v0.1.7 / T15.5）。
 *
 * ## 这一组守的是什么
 *
 * 两组，重要性不同：
 *
 * **第一组是安全**（最重要）。消息正文来自 LLM 与用户输入，是不可信内容。
 * 渲染结果是直接进 `innerHTML` 的字符串，所以每一条 XSS 向量都必须被中和。
 * 这组测试的作用不是"证明安全"（那不可能），而是**把已想到的向量钉住**，
 * 并在有人改动转义顺序时立刻红。
 *
 * 第二组是渲染正确性（粗体/斜体/代码/列表/引用/宏）。
 *
 * ## 一条刻意的严格
 *
 * 断言用 `includes`/`equal` 检查**输出里不许出现**的东西（如 `<script`），
 * 而不只是检查"该有的标签在不在"。只查后者的话，一个"该转义没转义但恰好
 * 也把该有的标签生成了"的实现能通过。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeHtml, renderMessageHtml, renderMessageText } from '@tcs/shared';

/* ═══════════════════════════════════════════════════════════
   一、安全：XSS 向量必须被中和
   ═══════════════════════════════════════════════════════════ */

test('★ 原始 HTML 标签一律被转义，不许形成标签', () => {
  const out = renderMessageHtml('<script>alert(1)</script>');
  assert.equal(out.includes('<script'), false, `不许出现 <script：${out}`);
  assert.equal(out.includes('</script>'), false);
  assert.ok(out.includes('&lt;script&gt;'), '应当以实体形式保留可读内容');
});

test('★ img onerror / 事件属性不许存活', () => {
  /*
   * 判据是「不许**生成元素**」，不是「不许出现 onerror 这个词」。
   *
   * 这一点我第一版写错了：我断言输出里不能含 `onerror`，结果
   * `<p>&lt;img src=x onerror=alert(1)&gt;</p>` 被判成失败 ——
   * 而那是**完全安全**的：整串已是文本，`onerror` 只是可见字符。
   *
   * 所以正确的判据分两层：
   *   ① 输出里不许有真正的开标签（`<img` / `<svg` …）
   *   ② 原文里的 `<` 必须已经变成 `&lt;`（否则才真的危险）
   */
  for (const vector of [
    '<img src=x onerror=alert(1)>',
    '<svg/onload=alert(1)>',
    '<div onclick="alert(1)">x</div>',
    '<iframe src="javascript:alert(1)"></iframe>',
  ]) {
    const out = renderMessageHtml(vector);
    assert.equal(/<(img|svg|div|iframe)\b/i.test(out), false, `不许生成元素：${vector} → ${out}`);
    assert.equal(out.includes('&lt;'), true, `原文的 < 必须已被转义：${vector} → ${out}`);
    // 属性形式（`onerror=` 紧跟在标签内）绝不许出现在真标签里
    assert.equal(/<[^>]*\son[a-z]+\s*=/i.test(out), false, `真标签里不许有事件属性：${vector} → ${out}`);
  }
});

test('★ javascript: / data: 链接降级成纯文本', () => {
  for (const href of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x']) {
    const out = renderMessageHtml(`[点我](${href})`);
    assert.equal(out.includes('href='), false, `不许生成 href：${href} → ${out}`);
    assert.equal(out.includes('<a '), false, `不许生成链接：${href} → ${out}`);
    assert.ok(out.includes('点我'), '可读内容应当保留');
  }
});

test('javascript: 用大小写或前置空格绕不过去', () => {
  // 空格在 markdown 链接语法里不合法，所以走 `[x]( javascript:...)` 时正则本就不匹配；
  // 这里直接测 isSafeHref 的行为经由渲染结果可见的部分
  const out = renderMessageHtml('[x](  javascript:alert(1))');
  assert.equal(out.includes('href='), false, `绕不过：${out}`);
});

test('安全链接正常生成，且带 noopener', () => {
  const out = renderMessageHtml('[示例](https://example.com/a?b=1)');
  assert.ok(out.includes('href="https://example.com/a?b=1"'), out);
  assert.ok(out.includes('rel="noopener noreferrer"'), '外链必须带 noopener');
});

test('★ 转义作用于属性上下文：引号也被中和', () => {
  // 即使当前实现在不给用户内容加属性，这条也要守住 ——
  // 它是"以后某个改动引入属性拼接"时的最后一道防线
  assert.equal(escapeHtml(`" onload="alert(1)`), '&quot; onload=&quot;alert(1)');
  assert.equal(escapeHtml(`' onload='x`), '&#39; onload=&#39;x');
});

test('& 只转义一次（不许 &amp;lt; 这种二次转义）', () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;', '这是正确的一次转义');
  // 渲染器对已含实体的文本不应产生 &amp;amp;
  const out = renderMessageHtml('a & b');
  assert.equal(out.includes('&amp;'), true);
  assert.equal(out.includes('&amp;amp;'), false, `不许二次转义：${out}`);
});

test('★ 行内代码里的尖括号也要转义', () => {
  const out = renderMessageHtml('用 `<div>` 包起来');
  assert.ok(out.includes('<code>&lt;div&gt;</code>'), out);
  assert.equal(out.includes('<div>'), false);
});

test('★ 围栏代码块里不许解析行内标记（也不许产生标签）', () => {
  const out = renderMessageHtml('```\n<script>x</script>\n**不是粗体**\n```');
  assert.ok(out.includes('<pre><code>'), out);
  assert.equal(out.includes('<script'), false, `代码块里也要转义：${out}`);
  assert.equal(out.includes('<strong>'), false, '代码块里不该有粗体');
  assert.ok(out.includes('**不是粗体**'), '原文应保留');
});

/* ═══════════════════════════════════════════════════════════
   二、渲染正确性
   ═══════════════════════════════════════════════════════════ */

test('粗体 / 斜体 / 删除线', () => {
  assert.equal(renderMessageHtml('**粗**'), '<p><strong>粗</strong></p>');
  assert.equal(renderMessageHtml('__粗__'), '<p><strong>粗</strong></p>');
  assert.equal(renderMessageHtml('*斜*'), '<p><em>斜</em></p>');
  assert.equal(renderMessageHtml('~~删~~'), '<p><del>删</del></p>');
});

test('★ 粗体先于斜体匹配（**x** 不许被吃成 *<em>x</em>*）', () => {
  const out = renderMessageHtml('**重点**');
  assert.equal(out, '<p><strong>重点</strong></p>', `粗体被斜体规则抢了：${out}`);
  assert.equal(out.includes('<em>'), false);
});

test('ST 常见的 *动作* 斜体（这条必须有）', () => {
  assert.equal(renderMessageHtml('*轻轻叹了口气*'), '<p><em>轻轻叹了口气</em></p>');
});

test('行内代码里的标记不生效', () => {
  const out = renderMessageHtml('`**不是粗体**`');
  assert.ok(out.includes('<code>**不是粗体**</code>'), out);
  assert.equal(out.includes('<strong>'), false);
});

test('段落与单个换行', () => {
  assert.equal(renderMessageHtml('第一行\n第二行'), '<p>第一行<br>第二行</p>');
  assert.equal(renderMessageHtml('第一段\n\n第二段'), '<p>第一段</p><p>第二段</p>');
});

test('引用块（连续行合并）', () => {
  const out = renderMessageHtml('> 第一句\n> 第二句');
  assert.equal(out.includes('<blockquote>'), true, out);
  assert.equal(out.match(/<\/blockquote>/g)?.length, 1, '连续引用应合成一个 blockquote');
});

test('无序列表与有序列表', () => {
  const ul = renderMessageHtml('- 甲\n- 乙');
  assert.equal(ul, '<ul><li>甲</li><li>乙</li></ul>');

  const ol = renderMessageHtml('1. 甲\n2. 乙');
  assert.equal(ol, '<ol><li>甲</li><li>乙</li></ol>');
});

test('分隔线', () => {
  assert.equal(renderMessageHtml('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>');
});

test('未闭合的围栏按代码块输出（不静默丢弃）', () => {
  const out = renderMessageHtml('```\n内容没写完');
  assert.ok(out.includes('<pre><code>内容没写完</code></pre>'), out);
});

/* ── 宏替换 ── */

test('★ 宏替换：{{char}} / {{user}} / <BOT> / <USER>', () => {
  const m = { charName: '西奥', userName: '旅人' };
  assert.equal(renderMessageHtml('{{char}} 说', m), '<p>西奥 说</p>');
  assert.equal(renderMessageHtml('{{user}} 走了', m), '<p>旅人 走了</p>');
  assert.equal(renderMessageHtml('<BOT> 笑了', m), '<p>西奥 笑了</p>');
  assert.equal(renderMessageHtml('<USER> 点头', m), '<p>旅人 点头</p>');
});

test('★ 宏在转义之前应用（角色名里的尖括号要被中和）', () => {
  const out = renderMessageHtml('{{char}} 说', { charName: '<script>x</script>' });
  assert.equal(out.includes('<script'), false, `角色名里的标签必须被转义：${out}`);
  assert.ok(out.includes('&lt;script&gt;'), out);
});

test('未知宏原样保留（不静默删除）', () => {
  assert.equal(renderMessageHtml('{{unknown}}'), '<p>{{unknown}}</p>');
});

test('没传名字时宏不动', () => {
  assert.equal(renderMessageHtml('{{char}}'), '<p>{{char}}</p>');
});

/* ── 纯文本提取 ── */

test('renderMessageText 去掉标记但保留内容', () => {
  const text = renderMessageText('**粗** *斜* `码` [链](https://e.com) {{char}}', { charName: '西奥' });
  assert.ok(text.includes('粗') && text.includes('斜') && text.includes('码'), text);
  assert.ok(text.includes('链'), text);
  assert.ok(text.includes('西奥'), text);
  assert.equal(text.includes('**'), false, `标记应被去掉：${text}`);
  assert.equal(text.includes('https://'), false, 'URL 应被去掉只留文字');
});

test('renderMessageText 用于列表摘要时会压掉多余空行', () => {
  assert.equal(renderMessageText('a\n\n\n\nb'), 'a\nb');
});

test('空输入不炸', () => {
  assert.equal(renderMessageHtml(''), '');
  assert.equal(renderMessageText(''), '');
});
