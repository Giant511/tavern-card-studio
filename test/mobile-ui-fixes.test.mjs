/**
 * 三处移动端 UI 修复的回归守卫（2026-10-31）。
 *
 * 这一组守的都是**同一类缺陷**：实现存在但没接线。
 *
 * | 问题 | 症状 | 本文件守什么 |
 * |---|---|---|
 * | 一 | 输入区悬浮在页面中部 | `.nb-chat` 必须有 `flex:1 + min-height:0 + flex column` |
 * | 二 | 点接口选项无任何可见变化 | `aria-pressed` 必须有对应 CSS 规则（状态与视觉同源） |
 * | 三 | 找不到语音配置入口 | `voice-settings` 必须被非自身文件 import，且外壳挂了入口 |
 *
 * ## 为什么这些要用静态断言而不用 DOM 断言
 *
 * 【问题一】是纯 CSS 几何问题：DOM 结构完全正确，错的是"某个类没有规则"。
 * 用 DOM stub 永远测不出来（stub 里没有布局引擎）。
 *
 * 【问题二】的核心是"状态与视觉是否同源"：如果 CSS 里没有任何
 * `[aria-pressed='true']` 规则，那么再多的 DOM 断言（属性确实变了）
 * 也会是绿的 —— 而用户什么都看不见。**这正是当初漏掉的原因。**
 *
 * 【问题三】是"有没有人引用它"，静态 grep 就是最准的判据。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * ★ 必须用 `fileURLToPath`，不能用 `URL.pathname`。
 *
 * 本仓库路径含中文（`D:/Claw/代码开发/...`），而 `new URL(...).pathname`
 * 返回的是**百分号编码**的 `%E4%BB%A3%E7%A0%81...`，`readFileSync` 会报
 * ENOENT，且错误里显示的路径看着像"文件不存在"，很难联想到是编码问题。
 * 这个坑在本项目已出现多次（同类：`.` 与 `file://` 混用）。
 */
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');
const CHAT_CSS = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

/** 去掉注释再扫描 —— 本项目已经因为"注释被当代码"红过三次 */
const cssCode = CHAT_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

function readAllTs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readAllTs(full));
    else if (name.endsWith('.ts')) out.push({ name: join(dir, name).slice(REPO.length + 1), text: readFileSync(full, 'utf8') });
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════
   问题一：聊天页根必须有完整的高度链
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题一：.nb-chat 必须 flex:1 + min-height:0 + flex column', () => {
  /*
   * 修复前的真实数据（360×800 视口，headless Chrome 实测）：
   *
   *   .nb-page     h=743
   *   .nb-chat     h=501   flexGrow:0  display:block   ← 撑不满父容器
   *   .nb-composer bottom=501               输入区停在这里
   *   .nb-tabbar   top=743                  中间空 242px
   *
   * 用户看到的就是"输入区悬浮在页面中部"。
   *
   * 三个属性缺一不可，所以三条都断言：
   *   · `flex:1`        → 撑满剩余高度
   *   · `min-height:0`  → 允许内部 .nb-msglist 收缩并自己滚
   *                       （不写的话 flex 子项 min-height 默认 auto，内容会顶开）
   *   · `display:flex` + `column` → 让内部三段按列排
   */
  const m = /\.nb-chat\s*\{([^}]*)\}/.exec(cssCode);
  assert.ok(m !== null, '.nb-chat 在 chat.css 里必须有定义（修复前是零定义）');
  const body = m[1];

  assert.match(body, /flex\s*:\s*1/, '.nb-chat 必须 flex: 1');
  assert.match(body, /min-height\s*:\s*0/, '.nb-chat 必须 min-height: 0');
  assert.match(body, /display\s*:\s*flex/, '.nb-chat 必须 display: flex');
  assert.match(body, /flex-direction\s*:\s*column/, '.nb-chat 必须 flex-direction: column');
});

test('★ 问题一：高度链上每一环都不能缺（app → page → chat → msglist）', () => {
  /*
   * 只看 `.nb-chat` 一条不够 —— 高度链任何一环断了症状都一样（输入区不贴底），
   * 而修的人容易只补最后一环。这里把四环都钉住。
   */
  const chain = [
    ['.nb-app', /inset\s*:\s*0/],
    ['.nb-page', /flex\s*:\s*1/],
    ['.nb-chat', /flex\s*:\s*1/],
    ['.nb-msglist', /flex\s*:\s*1/],
  ];
  for (const [sel, re] of chain) {
    const m = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(cssCode);
    assert.ok(m !== null, `${sel} 缺定义`);
    assert.match(m[1], re, `${sel} 的高度链属性不对（要点：${re}）`);
  }
});

test('★ 问题一：输入区不能是脱离文档流的绝对定位', () => {
  /*
   * 这条防"用 absolute 把它压到底部"的修法。
   * 那样看着也贴底，但会盖住最后一条消息、且键盘弹起时不会跟着上移。
   */
  const m = /\.nb-composer\s*\{([^}]*)\}/.exec(cssCode);
  assert.ok(m !== null);
  assert.doesNotMatch(m[1], /position\s*:\s*(fixed|absolute)/, '.nb-composer 不能靠绝对定位贴底');
});

/* ═══════════════════════════════════════════════════════════
   问题二：接口源状态与视觉必须同源
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题二：aria-pressed 必须有对应的 CSS 规则', () => {
  /*
   * 修复前的真相：`api-page.ts` **已经正确写入** `aria-pressed`，
   * 而 `chat.css` 里 `grep aria-pressed` 零结果。
   * 状态有、视觉无 —— 用户点击六个选项"无任何可见变化"。
   *
   * 这条断言直接守那个断层：状态属性必须被至少一条 CSS 规则消费。
   * 它比 DOM 断言更准：DOM 断言只能证明"属性变了"，
   * 证明不了"用户看得见"。
   */
  assert.match(
    cssCode,
    /\[aria-pressed=['"]true['"]\]/,
    'CSS 里必须有 [aria-pressed="true"] 的规则，否则选中状态没有视觉表达',
  );
});

test('★★ 问题二：点已展开项要收起（手风琴），不是永远选中', () => {
  /*
   * 用户原话：「再次点击收起」。
   * 所以点击处理器里必须有"已展开 → 收起"的分支，
   * 不能写成"点了就一定是选中"。
   */
  const src = readFileSync(join(CHAT_DIR, 'api-page.ts'), 'utf8');
  assert.match(src, /panelExpanded/, '展开态要记在状态里');
  assert.match(
    src,
    /if\s*\(\s*row\.panelExpanded\s*\)\s*\{[\s\S]{0,80}expandSource\(null\)/,
    '点击已展开项必须收起（expandSource(null)）',
  );
});

test('★ 问题二：同一时刻只有一组配置输入（保证 data-role 唯一）', () => {
  /*
   * 为什么重要：验收脚本与单元测试都按 `byRole(page, 'key-input')[0]` 取，
   * 隐含"全局只有一个"。如果六个源的输入框都常驻 DOM，
   * 取到的可能是收起那个源的值 —— 表现为"改了值保存的不是它"，
   * 而界面上看不出来。
   *
   * 判据：收起时必须 replaceChildren 清空面板。
   */
  const src = readFileSync(join(CHAT_DIR, 'api-page.ts'), 'utf8');
  assert.match(
    src,
    /row\.panel\.replaceChildren\(\)/,
    '收起所有源时必须清空面板 DOM（否则 data-role 不唯一）',
  );
});

test('★ 问题二：地址字段只对「自定义」出现', () => {
  /*
   * 其余五个源有内置地址，多给一个地址框只会让人以为必须填。
   */
  const src = readFileSync(join(CHAT_DIR, 'api-page.ts'), 'utf8');
  assert.match(src, /source === 'custom'/, '地址字段要按源条件渲染');
});

/* ═══════════════════════════════════════════════════════════
   问题三：语音配置必须有入口（不是"页面不存在"）
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题三：voice-settings 必须被非自身文件引用', () => {
  /*
   * 修复前的真相：`voice-settings.ts` 448 行、导出完整，
   * 但 `grep -rn "voice-settings" client/src` 除自身外**零引用**。
   *
   * 所以它既不在桌面端、也不在移动端 —— 不是"移动端没挂入口"，
   * 是**两端都没挂**。这条断言守的就是"必须有人真的用它"。
   */
  const files = readAllTs(join(REPO, 'client', 'src'));
  const referrers = files.filter(
    (f) => !f.name.endsWith('voice-settings.ts') && /from\s+['"][^'"]*voice-settings(\.ts)?['"]/.test(f.text),
  );
  assert.ok(
    referrers.length > 0,
    'voice-settings 必须被至少一个非自身文件 import（修复前是零引用）',
  );
});

test('★★ 问题三：「我的」页要真的**挂上**语音入口（不只是定义了函数）', () => {
  /*
   * ★ 这条第一版写错了，被变异测试抓住：
   *
   * 第一版只断言 `shell.ts` 里出现过 `renderVoiceSettingsPage` 和 `voice-entry`
   * 两个字符串 —— 而 `renderVoiceSection()` 这个**函数定义本身**里就含这两个词。
   * 于是把 `this.pageHost.append(this.renderVoiceSection())` 那一行删掉，
   * 断言照样绿 —— 「函数定义在、但没人调用」正是本次要抓的那类缺陷，
   * 我的断言却对它免疫。
   *
   * 改成：必须能找到**调用点**（`append(this.renderVoiceSection())`）。
   */
  const src = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  /*
   * 判据：在 **`renderMe()` 内部**找到那条 `scroller.append(...)`，
   * 断言里面有两个入口。
   *
   * ## 为什么要先限定到 renderMe
   *
   * 第一版是 `src.match(/scroller\.append\([\s\S]*?\)/)` —— 全文找第一个。
   * 2026-10-31 第三批给「卡片」Tab 也加了 `scroller.append(...)`（两个说明条目），
   * 而那段代码在文件里**更靠前**，于是匹配到的是卡片页那条，
   * 断言在一个完全不相干的位置变红/变绿。
   *
   * 一条"检查 A 处"的断言却去读 B 处，比没有断言更糟：它会给出确定但错误的结论。
   */
  const start = src.indexOf('private renderMe()');
  assert.ok(start > 0, '找不到 renderMe');
  let depth = 0;
  let began = false;
  let end = start;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') {
      depth += 1;
      began = true;
    } else if (src[i] === '}') {
      depth -= 1;
      if (began && depth === 0) {
        end = i;
        break;
      }
    }
  }
  const renderMe = src.slice(start, end);

  const appendStmt = renderMe.match(/scroller\.append\([\s\S]*?\);/);
  assert.ok(appendStmt !== null, 'renderMe 里找不到往 scroller 里 append 的语句');
  assert.match(
    appendStmt[0],
    /this\.renderVoiceSection\(\)/,
    `「我的」页必须真的把语音区块 append 进滚动容器（删掉等于没入口）。实际语句：${appendStmt[0]}`,
  );

  // ② 区块里真的渲染了语音设置页
  assert.match(src, /renderVoiceSettingsPage\(/, '语音区块里要调用 renderVoiceSettingsPage');

  // ③ 入口元素与展开状态
  assert.match(src, /voice-entry/, '必须有 voice-entry 这个入口元素');
  assert.match(src, /voiceExpanded/, '语音区块要有展开状态');
});

test('★ 问题三：语音区块的展开状态记在外壳，不记在页面里', () => {
  /*
   * 「我的」页每次切 Tab 都会 `replaceChildren` 重绘。
   * 展开状态若记在页面内部对象里，切一次 Tab 再回来就变回收起 ——
   * 用户会以为"点了没生效"。
   */
  const src = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
  assert.match(
    src,
    /private\s+voiceExpanded/,
    'voiceExpanded 必须是外壳的字段（页面会随 Tab 切换重绘）',
  );
});

test('★ 问题三：语音区块收起时不留 DOM', () => {
  /*
   * 与问题二同一理由：避免字段重复导致取值歧义，也省内存。
   */
  const src = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
  const seg = src.slice(src.indexOf('renderVoiceSection'), src.indexOf('renderVoiceSection') + 4000);
  assert.match(seg, /body\.replaceChildren\(\)/, '收起时要清空语音面板 DOM');
});
