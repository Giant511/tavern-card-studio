/**
 * 仓库常驻连通指示灯 + 跨页面不丢连接（2026-11-06）。
 *
 * ## 用户要求
 *
 * > 可以在仓库里面加常驻的图标用来指示是否连上服务器，比如连上就是绿色，
 * > 没连上就是红色，**不影响页面的其他按钮**，还有就是**切到其他地方不
 * > 丢失连接，切回来不需要重新连接服务器**。
 *
 * ## 三个不同的东西，别混
 *
 * ```text
 *   是否登录     是否有 token         → 已有（repoAuth）
 *   是否连通     服务器有没有回话      → 本次新加（repoLink）
 *   是否能拉列表 连通 + 登录 + 有权限  → 拉列表的结果
 * ```
 *
 * ★ 最容易搞错的是第一和第二：**`401` 说明"连上了但不认这个身份"**，
 * 属于"连通正常"。把它判成离线，用户会去查网络查地址，而真正要做的
 * 是登录 —— 而仓库页未登录是**最常见**的状态。
 *
 * ## 判据分三组
 *
 * ```text
 *   A  状态模型：四态齐备、跨页面存活在外壳上
 *   B  判定规则：401 算在线、连不上才算离线、重请求不许当探测
 *   C  体感：切回来先有内容、静默刷新失败不清空、指示灯不挡按钮
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const pageSrc = stripComments(read('client/src/chat/repo-page.ts'));
const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const css = read('client/src/chat/chat.css');

/* ═══════════════════════════════════════════════════════════
   A. 状态模型
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 四态齐备且挂在外壳上（切页面不丢）', () => {
  /*
   * 用户："切到其他地方不丢失连接"。
   *
   * 页面每次切 Tab 都会**重建**（转场架构决定的，不能改）。所以状态
   * 放在页面闭包里的必然结果就是：切回来变回 `unknown` ⇒ 再探测一次 ⇒
   * 用户看到"又在重连"。
   *
   * 只有挂在外壳字段上，才叫"不丢失"。
   */
  for (const state of ["'unknown'", "'checking'", "'online'", "'offline'"]) {
    assert.ok(
      pageSrc.includes(`RepoLinkState =`) && pageSrc.includes(state),
      `四态里缺 ${state}`,
    );
  }

  /* 外壳必须有这三个字段（状态 / 说明 / 时间戳） */
  assert.match(shellSrc, /private repoLink: RepoLinkState = 'unknown'/, '外壳要有 repoLink 字段');
  assert.match(shellSrc, /private repoLinkDetail = ''/, '外壳要有 linkDetail');
  assert.match(shellSrc, /private repoLinkCheckedAt = 0/, '外壳要有 linkCheckedAt');

  /* 而且必须是**字段**，不能是方法局部变量 */
  const fieldAt = shellSrc.indexOf('private repoLink: RepoLinkState');
  assert.ok(fieldAt > 0, '找不到 repoLink 字段声明');
});

test('★★★ 状态要传给页面（否则指示灯永远是灰的）', () => {
  const at = shellSrc.indexOf('private repoStatus()');
  assert.ok(at > 0, '找不到 repoStatus()');
  const body = shellSrc.slice(at, at + 900);

  assert.match(body, /link: this\.repoLink/, '要带上 link');
  assert.match(body, /linkDetail: this\.repoLinkDetail/, '要带上 linkDetail');
  assert.match(body, /linkCheckedAt: this\.repoLinkCheckedAt/, '要带上 linkCheckedAt');
});

/* ═══════════════════════════════════════════════════════════
   B. 判定规则
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 401 必须算「在线」（连上 ≠ 登录）', () => {
  /*
   * 这是整个功能的**核心判断**，也是最容易写错的一处。
   *
   * ```text
   *   服务器回 401  ⇒ 它活着，只是不认这个身份  ⇒ 在线
   *   连不上/超时    ⇒ 它可能没活着              ⇒ 离线
   * ```
   *
   * 若把 401 判成离线：
   *
   * ```text
   *   用户没登录 → 亮红灯「连不上」→ 去查网络、查地址、换服务端
   *   → 全都白费，真正要做的是登录
   * ```
   *
   * 而仓库页**未登录是最常见的状态**，所以这个错会让指示灯长期在撒谎。
   *
   * 判据：判在线的条件是 `status > 0`（拿到了 HTTP 状态码），
   * 不是 `response.ok`（那会排除掉 401/403）。
   */
  const at = shellSrc.indexOf('private async probeRepoLink()');
  assert.ok(at > 0, '找不到 probeRepoLink()');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(body, /response\.status > 0/, '要按"拿到了状态码"判在线');
  assert.doesNotMatch(body, /response\.ok\b/, '不许用 response.ok 判（它会把 401 排除掉）');
});

test('★★★★ 探测要打最轻的端点，不许拉卡片列表', () => {
  /*
   * ```text
   *   /version     不需要登录、响应最小
   *   卡片列表     要登录、要解析几十条、慢的时候十几秒
   * ```
   *
   * 探测必须轻，否则"亮个灯"就变成一次真实加载。
   */
  const at = shellSrc.indexOf('private async probeRepoLink()');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(body, /\/version/, '探测要打 /version');
  assert.doesNotMatch(body, /repoListCards/, '探测不许拉卡片列表');
});

test('★★★ 地址没填好 ≠ 离线', () => {
  /*
   * 切到自定义仓库但还没填地址时，`repoOrigin()` 返回 null。
   *
   * 这时给 `offline` 是错的 —— 用户会去查网络，而实际要做的是**把地址填上**。
   * 所以保留 `unknown` 并写明原因。
   */
  const at = shellSrc.indexOf('private async probeRepoLink()');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(
    body,
    /origin === null[\s\S]{0,220}settle\('unknown', '还没填服务端地址'\)/,
    '没配地址要判 unknown 并说明，不许判 offline',
  );
});

/* ═══════════════════════════════════════════════════════════
   C. 体感：切回来不重新连
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 切回来要先有内容（缓存列表 + 静默刷新）', () => {
  /*
   * 用户："切回来不需要重新连接服务器。"
   *
   * 页面重建无法避免（转场架构如此），所以"不重新连"只能靠：
   *
   * ```text
   *   有缓存  ⇒ 立刻画出来（同步），再 quiet 刷新
   *   无缓存  ⇒ 才显示「正在读取…」
   * ```
   *
   * ## 2026-11-06 改成三级之后
   *
   * 这条性质**没变**，但承载它的地方换了：
   *
   * ```text
   *   一级（仓库列表）   repo-page.ts   + repoReposCache
   *   二级（卡片列表）   shell 的 repoCardsState（进页面前已拉好）
   *   三级（卡片历史）   shell 的 repoVersionsState
   * ```
   *
   * 二三级不再是"页面自己缓存"，而是**外壳先把状态准备好再渲染**——
   * 这比页面内缓存更强：连"取缓存"这一步都省了。
   *
   * 所以判据改成验：① 一级有同步缓存入口 ② 二三级的状态由外壳持有
   * ③ 状态用 `null` 区分"还没拉"与"拉到了是空的"。
   */
  /* ① 一级：仓库列表缓存 */
  assert.match(shellSrc, /private repoReposCache: RepoRow\[\] = \[\]/, '外壳要缓存仓库列表');
  assert.match(pageSrc, /onCachedRepos: \(\) => RepoRow\[\]/, '回调要声明 onCachedRepos');
  assert.match(pageSrc, /const cachedRepos = callbacks\.onCachedRepos\(\)/, '进页面要同步取缓存');
  assert.match(pageSrc, /paintRepos\(host, cachedRepos\)/, '有缓存要先画出来');
  assert.match(pageSrc, /void loadRepos\(host, \{ quiet: true \}\)/, '然后再静默刷新');

  /* ② 二三级：状态由外壳持有，进页面前就准备好 */
  assert.match(
    shellSrc,
    /private repoCardsState: RepoCardRow\[\] \| null = null/,
    '二级的卡片状态要挂在外壳上',
  );
  assert.match(
    shellSrc,
    /private repoVersionsState: RepoVersionRow\[\] \| null = null/,
    '三级的版本状态要挂在外壳上',
  );

  /* ③ `null` = 还没拉；空数组 = 拉到了但是空的。两者必须能区分 */
  assert.match(
    shellSrc,
    /cards: this\.repoCardsState/,
    '二级渲染要直接把状态传下去（不自己再拉一次）',
  );
  assert.match(
    shellSrc,
    /versions: this\.repoVersionsState/,
    '三级渲染要直接把状态传下去',
  );
});

test('★★★★ 切了仓库/卡片要清掉下级的加载状态', () => {
  /*
   * 不清的后果是"串台"：
   *
   * ```text
   *   在 A 仓库看过卡片列表 → 退回 → 进 B 仓库
   *   ⇒ 先闪一下 A 的卡片，再变成 B 的
   *
   *   看卡 X 的历史 → 退回 → 看卡 Y
   *   ⇒ 先闪一下 X 的版本列表
   * ```
   *
   * 那一下闪烁比多一次渲染更刺眼，而且会让人以为"点错了"。
   *
   * 判据：`onOpenRepo` 要清 `repoCardsState`；`onOpenCard` 要清
   * `repoVersionsState`；两个返回分支也要清。
   */
  const openRepoAt = shellSrc.indexOf('onOpenRepo:');
  assert.ok(openRepoAt > 0, '找不到 onOpenRepo');
  const openRepoBody = shellSrc.slice(openRepoAt, openRepoAt + 700);
  assert.match(openRepoBody, /this\.repoCardsState = null/, '进二级要清掉上一个仓库的卡片');

  const openCardAt = shellSrc.indexOf('onOpenCard:');
  assert.ok(openCardAt > 0, '找不到 onOpenCard');
  const openCardBody = shellSrc.slice(openCardAt, openCardAt + 600);
  assert.match(openCardBody, /this\.repoVersionsState = null/, '进三级要清掉上一张卡的版本');

  /* 返回时同样要清，否则下次进另一张卡会先闪旧的 */
  const backAt = shellSrc.indexOf('if (this.active === \'repo\')', shellSrc.indexOf('goBackOneLevel(): boolean'));
  assert.ok(backAt > 0, '找不到仓库的返回分支');
  const backBody = shellSrc.slice(backAt, backAt + 1600);
  assert.match(backBody, /this\.repoVersionsState = null/, '三级返回要清版本状态');
  assert.match(backBody, /this\.repoCardsState = null/, '二级返回要清卡片状态');
});

test('★★★ 指示灯不许用全屏遮罩（不挡其它按钮）', () => {
  /*
   * 用户："不影响页面的其他按钮"。
   *
   * 所以指示灯必须是**文档流里**的一个小元素，不是浮层。
   * 判据：它那几条 CSS 规则里不许出现 `position: fixed/absolute`。
   */
  const at = css.indexOf('.nb-repo-link {');
  assert.ok(at > 0, '找不到 .nb-repo-link 样式');
  const rule = css.slice(at, css.indexOf('}', at) + 1);

  assert.doesNotMatch(rule, /position:\s*(fixed|absolute)/, '指示灯要留在文档流里（不覆盖内容）');
  assert.match(rule, /display:\s*inline-flex/, '用 inline-flex 自适应宽度');
  assert.match(rule, /flex:\s*0 0 auto/, '不许参与拉伸（会挤掉标题）');
});

test('★★★ 颜色之外必须有文字（红绿色盲分不出）', () => {
  /*
   * 红绿两色对红绿色盲是同一个灰度。只给颜色 = 对约 8% 的男性用户
   * 完全失效。所以圆点给颜色，**文字给结论**。
   */
  assert.match(pageSrc, /nb-repo-link-dot/, '要有颜色圆点');
  assert.match(pageSrc, /nb-repo-link-text/, '要有文字');

  /* 文案由 linkLabel() 统一给出（在线态还要看登录，所以不在 LINK_LOOK 里） */
  assert.match(pageSrc, /function linkLabel\(state: RepoLinkState/, '要有 linkLabel()');
  assert.match(pageSrc, /const LINK_LOOK: Record<Exclude<RepoLinkState, 'online'>, string>/, 'LINK_LOOK 只管非在线态');

  for (const label of ['连不上', '检测中', '未检测']) {
    assert.ok(pageSrc.includes(`'${label}'`), `LINK_LOOK 里缺「${label}」`);
  }
  assert.doesNotMatch(pageSrc, /'未知'/, "不要写「未知」—— 该说「未检测」");
});

test('★★★★★ 绿灯要分「已登录」与「已连接」两种', () => {
  /*
   * 用户：
   *
   * > 这个绿灯再加一个语义：已登录
   *
   * ## 为什么必须分
   *
   * 仓库页最常出现的两种状态**都是绿的**：
   *
   * ```text
   *   连上了，没登录   ← 能连，但上传/看历史/回滚都用不了
   *   连上了，已登录   ← 全功能可用
   * ```
   *
   * 都用「已连接」表达，用户看不出"我现在到底登录着没有"——
   * 而那正是他下一步动作的依据（要不要去填账号密码）。
   *
   * ## 优先级：连通 > 登录
   *
   * 已登录但连不上时，显示「连不上」而不是「已登录」：
   * 前者可操作（查网络/换地址），后者只会让人以为一切正常。
   */
  const at = pageSrc.indexOf('function linkLabel(');
  assert.ok(at > 0, '找不到 linkLabel()');
  const body = pageSrc.slice(at, pageSrc.indexOf('\n}', at) + 2);

  assert.match(body, /state === 'online'/, '在线态要单独判');
  assert.match(body, /已登录/, '在线且已登录 ⇒ 「已登录」');
  /*
   * ★ 2026-11-06 第二次调整（用户要求）：
   *   绿灯未登录时写「未登录」，不写「已连接」。
   *
   * 「已连接」只说了"网络通了"，用户不知道接下来要干什么；
   * 「未登录」直接点出身份状态，下一步（填账号密码）一目了然。
   * 而"能连上"已经由**绿灯的颜色**表达了 —— 颜色说连通，文字说身份。
   */
  assert.match(body, /'未登录'/, '在线但未登录 ⇒ 「未登录」');
  assert.doesNotMatch(body, /'已连接'/, '绿灯未登录**不许**写「已连接」（说了等于没说）');
  /*
   * 非在线态直接回落 LINK_LOOK —— 也就是说 offline 时**不会**因为
   * 已登录就显示「已登录」（优先级正确）。
   */
  assert.match(body, /return LINK_LOOK\[state\]/, '非在线态要回落到 LINK_LOOK');
});

test('★★★★ 登录态要传到指示灯（否则永远显示「已连接」）', () => {
  /*
   * `paintLink` 必须知道当前是否登录。来源是 `status.username`
   * —— 由外壳的 `repoStatus()` 提供，是**当前**登录态。
   *
   * ★ 登录成功后外壳会 `renderPage()` 重画，所以重画出来的指示灯自然正确。
   *   这一点单独验：`repoLoginWith` 末尾必须有 `renderPage()`。
   */
  assert.match(
    pageSrc,
    /loggedIn: boolean = status\.username !== null/,
    'paintLink 默认从 status.username 取登录态',
  );
  assert.match(pageSrc, /linkLabel\(state, loggedIn\)/, '要参与文案计算');

  const loginAt = shellSrc.indexOf('private async repoLoginWith');
  assert.ok(loginAt > 0, '找不到 repoLoginWith');
  const loginBody = shellSrc.slice(loginAt, loginAt + 3000);
  assert.match(
    loginBody,
    /this\.renderPage\(\)/,
    '登录成功后必须重画（否则指示灯不会变成「已登录」）',
  );
});

test('★★★★ 换了服务端要作废旧连通结论', () => {
  /*
   * 连通状态有 60 秒新鲜期（切走再切回来不重新探测）。但"切了服务端"
   * 是另一回事 —— 沿用旧结论会给出**错的灯**：
   *
   * ```text
   *   A 通、B 不通  ⇒ 绿灯「已连接」，点上传却失败
   *   A 不通、B 通  ⇒ 红灯「连不上」，其实 B 好好儿的
   * ```
   *
   * 所以切换 origin / kind 时必须清回 `unknown`。
   */
  const at = shellSrc.indexOf('private async saveRepoConfig');
  assert.ok(at > 0, '找不到 saveRepoConfig');
  const body = shellSrc.slice(at, at + 5200);

  assert.match(body, /this\.repoLink = 'unknown'/, '切换服务端要把连通状态清回 unknown');
  assert.match(body, /this\.repoLinkCheckedAt = 0/, '时间戳也要清（否则新鲜期会跳过探测）');
  assert.match(body, /this\.repoCardsCache = \[\]/, '卡片缓存也要清');
});
