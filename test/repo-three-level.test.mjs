/**
 * 仓库三级结构（2026-11-06）。
 *
 * ## 用户要求（三条）
 *
 * > 1、点完下载没有反馈，用户无法得知具体情况。
 * > 2、建议登录后按照仓库列表做展示（多仓库的情况下），点击对应仓库可进入
 * >    卡查看界面，也是相同的按照卡列表的方式进行展示，并且可以展示缩略图
 * >    头像（按照服务端仓库里的展示，如果服务端没有就用兜底缩略图进行展示）。
 * > 3、点击对应卡片进入卡片历史界面，可以看到卡片的详情，下载、设为最新、
 * >    编辑（做按键入口但是文字变灰不生效，这是下个版本的内容）、删除、设为最新。
 * > 4、注意以上 2、3 点要复用转场。
 *
 * ## 四级结构
 *
 * ```text
 *   repo                              一级  服务端配置 + 登录 + 仓库列表
 *   repo/<repoId>                     二级  该仓库的卡片（带缩略图）
 *   repo/<repoId>/<cardId>            三级  某张卡的历史与操作
 * ```
 *
 * ★ 段数 1→2→3 就是层级。`turnDirection()` 只比段数大小，所以
 *   **转场自动正确** —— 这就是第 4 点"复用转场"的实现方式。
 *   不需要为每一级写动画，也不需要手工标记"这是进还是退"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const level1 = stripComments(read('client/src/chat/repo-page.ts'));
const level2 = stripComments(read('client/src/chat/repo-cards-page.ts'));
const level3 = stripComments(read('client/src/chat/repo-card-page.ts'));
const navSrc = read('shared/src/chat/nav.ts');
const css = read('client/src/chat/chat.css');

/* ═══════════════════════════════════════════════════════════
   一、三级结构与转场复用
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 三级 pageKey：段数就是层级', () => {
  /*
   * 这是"复用转场"的全部实现。`turnDirection()` 的第一条规则就是
   * **比段数**（段数多 = 进，少 = 退），所以只要 key 的段数对，
   * 方向就自动对。
   */
  const at = shellSrc.indexOf('private pageKey()');
  assert.ok(at > 0, '找不到 pageKey()');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(body, /if \(this\.repoCardId !== null\)/, '三级要单独分支');
  assert.match(
    body,
    /return `repo\/\$\{this\.repoRepoId \?\? '-'\}\/\$\{encodeURIComponent\(this\.repoCardId\)\}`/,
    '三级是 3 段：repo/<repoId>/<cardId>',
  );
  assert.match(
    body,
    /return `repo\/\$\{encodeURIComponent\(this\.repoRepoId\)\}`/,
    '二级是 2 段：repo/<repoId>',
  );
  assert.match(body, /return 'repo';/, '一级是 1 段');

  /* 反向：id 必须 encode，否则带 `/` 的 id 会把段数算错 */
  assert.match(body, /encodeURIComponent\(this\.repoCardId\)/, 'cardId 要 encode（否则段数失真）');
});

test('★★★★ 转场方向靠段数推导（不是手工标记）', () => {
  /*
   * `shared/src/chat/nav.ts` 的 `turnDirection` 只比段数大小。
   * 这条判据把它**钉住** —— 如果有人改成"看别的字段"，
   * 三级结构的转场会全部失效，而症状是"进出都没动画"。
   */
  assert.match(navSrc, /keyBefore\.split\('\/'\)\.length/, '要用路径段数');
  assert.match(navSrc, /keyAfter\.split\('\/'\)\.length/, '要比较前后段数');
  assert.match(
    navSrc,
    /if \(depthAfter !== depthBefore\) return depthAfter > depthBefore \? 'push' : 'back'/,
    '段数变多 = push，变少 = back',
  );
});

test('★★★★★ 三级都走 renderPage（否则没有转场）', () => {
  /*
   * 转场只发生在 `renderPage()` 里（它算 key、播动画、清旧层）。
   * 直接往 `pageHost.append(...)` 挂页面就绕过了转场 —— 表现为"硬切"。
   *
   * 判据：三级各自有一个 `renderXxxPage()` 私人方法，且调度处
   * 按 cardId → repoId → 一级 的顺序分派。
   */
  assert.match(shellSrc, /private renderRepoPage\(\): void/, '一级渲染方法');
  assert.match(shellSrc, /private renderRepoCardsPage\(\): void/, '二级渲染方法');
  assert.match(shellSrc, /private renderRepoCardPage\(\): void/, '三级渲染方法');

  /* 调度顺序：先判最深的，否则会渲染成上一级 */
  /*
   * 用 `renderRepoCardPage()` 的调用位置当锚点 —— 不依赖缩进/换行。
   * 然后看三个渲染方法的调用顺序。
   */
  const cardCall = shellSrc.indexOf('this.renderRepoCardPage();');
  const cardsCall = shellSrc.indexOf('this.renderRepoCardsPage();');
  const pageCall = shellSrc.lastIndexOf('this.renderRepoPage();');
  assert.ok(cardCall > 0 && cardsCall > 0 && pageCall > 0, '三级渲染方法都要被调度到');
  assert.ok(
    cardCall < cardsCall && cardsCall < pageCall,
    `调度顺序必须是 三级 → 二级 → 一级（实际 ${String(cardCall)} / ${String(cardsCall)} / ${String(pageCall)}）`,
  );
});

test('★★★★ 返回必须逐级退（不能一退到底）', () => {
  /*
   * 从"某张卡的历史"退回来，用户期待的是那张卡所在的列表，
   * 而不是整个仓库的入口。
   */
  const at = shellSrc.indexOf("if (this.active === 'repo') {", shellSrc.indexOf('goBackOneLevel(): boolean'));
  assert.ok(at > 0, '找不到仓库的返回分支');
  const body = shellSrc.slice(at, at + 1800);

  /* 先退三级，再退二级 */
  const cardBack = body.indexOf('this.repoCardId = null');
  const repoBack = body.indexOf('this.repoRepoId = null');
  assert.ok(cardBack > 0, '要先退三级');
  assert.ok(repoBack > cardBack, '三级在二级之前处理（深的先退）');
});

/* ═══════════════════════════════════════════════════════════
   二、仓库列表（二级的入口）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 一级显示仓库列表（不是把卡片混在一起）', () => {
  /*
   * 用户："按照仓库列表做展示（多仓库的情况下）"。
   *
   * 之前是"一页到底"：所有卡片躺在一个列表里，多仓库时根本分不清
   * 哪张卡属于哪个仓库。现在一级只列仓库，点进去才是卡片。
   */
  assert.match(level1, /data-role', 'repo-repo-list'/, '一级要有仓库列表容器');
  assert.match(level1, /data-role', 'repo-repo-item'/, '仓库行要有可点标记');
  assert.match(level1, /data-repo-id/, '行上要带 repoId');

  /* 服务端 API 有 cardCount，要显示出来 */
  assert.match(level1, /\$\{String\(repo\.cardCount\)\} 张卡/, '要显示每个仓库有多少张卡');

  /* 点进二级 */
  assert.match(level1, /callbacks\.onOpenRepo\(repo\.id/, '点击要进二级');

  /* 反向：一级不许再画卡片列表 */
  assert.doesNotMatch(level1, /data-role', 'repo-card-list'/, '一级不许有卡片列表');
  assert.doesNotMatch(level1, /data-role', 'repo-card-item'/, '一级不许有卡片行');
});

/* ═══════════════════════════════════════════════════════════
   三、二级：卡片列表 + 缩略图
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 缩略图：有就用服务端的，没有用兜底', () => {
  /*
   * 用户：
   *
   * > 可以展示缩略图头像（按照服务端仓库里的展示，如果服务端没有就用
   * > 兜底缩略图进行展示）
   *
   * 三条硬要求：
   *
   * ```text
   * ① 兜底**同步**就有（不能等网络回来才画，否则那一格是空的）
   * ② 服务端有才去取（`hasFace` 为 true），没有不发请求
   * ③ 取回来是 data URL（这个 WebView 里 <img src="https://…"> 走不通）
   * ```
   */
  assert.match(level2, /function fallbackAvatar/, '要有兜底头像');
  assert.match(
    level2,
    /faceBox\.append\(fallbackAvatar\(doc, card\.title\)\)/,
    '兜底要**同步**先画上去',
  );
  assert.match(level2, /if \(!card\.hasFace\) continue;/, '服务端没有卡面就不发请求');

  /*
   * ★ data URL 的拼接在**外壳**（`loadCardFace`），不在页面里 ——
   *   页面只负责把拿到的字符串塞进 `<img src>`。
   *   第一版判据查错了对象。
   *
   *   验的是性质：必须是 data URL（这个 WebView 里远端 `https://…`
   *   直连走不通，见 native-fetch 的 file 头注释）。
   */
  assert.match(
    shellSrc,
    /return `data:\$\{mime\};base64,\$\{base64\}`/,
    '外壳要把字节转成 data URL',
  );
  assert.match(shellSrc, /repoFetchFace/, '要用取卡面接口');

  /* 取失败不打扰用户 —— 那只是装饰 */
  const catchAt = level2.indexOf('void (async () => {');
  assert.ok(catchAt > 0, '要有异步取图');
  const asyncBody = level2.slice(catchAt, catchAt + 1200);
  assert.doesNotMatch(asyncBody, /onNotify/, '缩略图失败不许弹通知（那会让人以为列表坏了）');
});

test('★★★★ 二级的版本信息不许出现「第 0 版」', () => {
  /*
   * 刚建还没推的卡 `latestSeq = 0`。直接拼"第 0 版"是错的 ——
   * 那不是版本号，是"没有版本"。
   */
  assert.match(level2, /card\.versionCount === 0/, '要单独处理 0 版本');
  assert.match(level2, /还没有版本/, '要说人话');
});

/* ═══════════════════════════════════════════════════════════
   四、三级：历史与操作
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 下载要有三态反馈（用户报的第一个问题）', () => {
  /*
   * 用户：
   *
   * > 点完下载没有反馈，用户无法得知具体情况。
   *
   * 原来只把按钮 `disabled`、文字不变 —— 用户看不出是在下载、
   * 卡住了、还是已经完成。而**失败时的提示被弹窗盖住**
   * （通知挂在 `.nb-topbar` 里，topbar 有 `z-index: 2` 自成 stacking
   * context，压不过 `z-index: 200` 的弹窗）—— 所以失败时完全没反馈。
   *
   * 现在按钮自己承载结果，不依赖通知：
   *
   * ```text
   *   busy    下载中…    禁用（防连点产生两份）
   *   done    已下载 ✓   绿色，800ms 后复位
   *   failed  重试       红色，留在原地可点
   * ```
   */
  assert.match(level3, /function runBusy/, '要有统一的忙碌三态助手');
  assert.match(level3, /data-state', 'busy'/, '要标忙碌态');
  assert.match(level3, /data-state', 'done'/, '要标成功态');
  assert.match(level3, /data-state', 'failed'/, '要标失败态');

  /* 忙碌文案必须是"下载中…"这类，不能只是变灰 */
  assert.match(level3, /busy: '下载中…'/, '下载要有进行中文案');
  assert.match(level3, /done: '已下载 ✓'/, '成功要有明确文案');
  assert.match(level3, /retry: '重试'/, '失败要能重试');

  /* 失败后必须恢复可点，否则用户被卡住 */
  const failAt = level3.indexOf("button.setAttribute('data-state', 'failed')");
  assert.ok(failAt > 0, '找不到失败分支');
  const failBody = level3.slice(failAt, failAt + 260);
  assert.match(failBody, /removeAttribute\('disabled'\)/, '失败后按钮要能再点');
});

test('★★★★ 编辑按钮：有入口但灰色不生效', () => {
  /*
   * 用户：
   *
   * > 编辑（做按键入口但是文字变灰不生效，这是下个版本的内容）
   *
   * 所以既要**存在**（下个版本接上就是一行的事），又要**明确不可用**。
   *
   * ★ 只给一个灰按钮不够：用户会以为是自己操作错了或者软件坏了。
   *   要说明"为什么点不了" —— 而"下个版本"是用户自己定的原因。
   */
  assert.match(level3, /data-role', 'repo-version-edit'/, '要有编辑入口');
  assert.match(level3, /edit\.setAttribute\('disabled', 'true'\)/, '编辑要禁用');
  assert.match(level3, /title', '编辑功能下个版本提供'/, '要说明为什么点不了');
});

test('★★★★ 三个操作齐备：下载 / 设为最新 / 删除', () => {
  const roles = ['repo-version-download', 'repo-version-latest', 'repo-card-delete'];
  for (const role of roles) {
    assert.ok(level3.includes(role), `缺少 ${role}`);
  }
  /* 内容已清理的版本：下载与设为最新都做不了，要说清原因 */
  assert.match(level3, /version\.sha256 === null/, '要处理内容被清理的版本');
  assert.match(level3, /内容已清理/, '要说清为什么按不了');
});

test('★★★ 三级要有卡片详情（不只是版本列表）', () => {
  /* 用户："可以看到卡片的详情" */
  assert.match(level3, /data-role', 'repo-card-meta'/, '要有详情区');
  assert.match(level3, /所属仓库/, '至少要显示归属');
});

/* ═══════════════════════════════════════════════════════════
   五、UI 约束
   ═══════════════════════════════════════════════════════════ */

test('★★★ 三级页面用整页，不用弹窗', () => {
  /*
   * 弹窗有两个问题，都是这次真机上暴露的：
   *
   * ```text
   * ① 没有层级：用户不知道自己在哪一级，也没有"返回"
   * ② 盖住通知：通知挂在 .nb-topbar 里，而 topbar 的 z-index(2)
   *             自成 stacking context ⇒ 压不过弹窗的 z-index(200)
   *             ⇒ 弹窗里的操作**失败提示用户看不到**
   * ```
   *
   * ②正是"点完下载没有反馈"的机制。
   *
   * 所以二三级必须是整页（`.nb-page`），不是 `.nb-exit-overlay`。
   */
  for (const [name, src] of [['二级', level2], ['三级', level3]]) {
    assert.match(src, /'nb-page /, `${name}要是整页`);
    assert.doesNotMatch(src, /nb-exit-overlay/, `${name}不许用弹窗`);
  }
});

test('★★★ 缩略图容器尺寸固定（有无卡面都不跳）', () => {
  /*
   * 有图/没图两种行如果高度差一点，列表滚动时会看着在抖。
   * 所以容器固定 40px，里面 img 与兜底圆都填满它。
   */
  const at = css.indexOf('.nb-repo-face {');
  assert.ok(at > 0, '找不到 .nb-repo-face');
  const rule = css.slice(at, css.indexOf('}', at) + 1);
  assert.match(rule, /width:\s*40px/, '容器宽度固定');
  assert.match(rule, /height:\s*40px/, '容器高度固定');
});

test('★★★ 危险按钮只染边框与文字（不铺满高饱和底色）', () => {
  /*
   * 设计册 §1.3：语义色只用于图标与短文本，大块高饱和在暗色下晃眼。
   */
  const at = css.indexOf('.nb-btn-danger {');
  assert.ok(at > 0, '找不到 .nb-btn-danger');
  const rule = css.slice(at, css.indexOf('}', at) + 1);
  assert.match(rule, /color:\s*var\(--nb-danger\)/, '文字用危险色');
  assert.doesNotMatch(rule, /background:\s*var\(--nb-danger\)/, '不许整块铺危险色');
});

/* ═══════════════════════════════════════════════════════════
   六、转场方向：真跑 turnDirection（不靠读源码）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 三级的进/退方向必须是 push / back（真跑）', async () => {
  /*
   * 前五组判据都是"读源码" —— 它们能防住"代码被改坏"，
   * 但证明不了"行为对"。这一条**真调** `turnDirection()`，
   * 用三级结构的真实 key 跑一遍。
   *
   * 这是用户第 4 点"复用转场"的唯一确定性证据（不依赖登录态、
   * 不依赖真机）。
   */
  const { turnDirection } = await import('../shared/dist/chat/nav.js');
  const TABS = ['chat', 'cards', 'repo', 'me'];

  /* 一级 → 二级 → 三级：都是 push */
  assert.equal(turnDirection('repo', 'repo/R1', TABS), 'push', '一级 → 二级要 push');
  assert.equal(turnDirection('repo/R1', 'repo/R1/C1', TABS), 'push', '二级 → 三级要 push');

  /* 三级 → 二级 → 一级：都是 back */
  assert.equal(turnDirection('repo/R1/C1', 'repo/R1', TABS), 'back', '三级 → 二级要 back');
  assert.equal(turnDirection('repo/R1', 'repo', TABS), 'back', '二级 → 一级要 back');

  /* 跨级：从仓库首页直接切到「我的」Tab 要按 Tab 顺序 */
  assert.equal(turnDirection('repo', 'me', TABS), 'push', 'repo → me 按 Tab 顺序是 push');
  assert.equal(turnDirection('me', 'repo', TABS), 'back', 'me → repo 按 Tab 顺序是 back');

  /*
   * ★ 同一级换仓库（A 仓库 → B 仓库）也应该是 push：
   *   段数不变、Tab 相同 ⇒ `turnDirection` 的兜底是 'push'。
   *   这是对的 —— 从 A 的列表跳进 B 的列表，视觉上确实是"换了个页面"。
   */
  assert.equal(turnDirection('repo/RA', 'repo/RB', TABS), 'push', '同层换仓库也要 push');

  /*
   * 同名不同卡（C1 → C2）同样是 push：
   *   用户从一张卡的历史直接跳到另一张卡的历史（理论上要先进列表，
   *   但只要 key 变了，方向就不能是"重绘"）。
   */
  assert.equal(turnDirection('repo/R1/C1', 'repo/R1/C2', TABS), 'push', '同层换卡也要 push');
});
