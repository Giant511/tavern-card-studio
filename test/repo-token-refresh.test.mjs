/**
 * 仓库令牌自动刷新 + 手动刷新按钮（2026-11-07）。
 *
 * ## 用户报的
 *
 * > 安卓端的仓库登陆 Token 管理有问题，如果已经登录服务端，重启 App 再进去，
 * > 就会出现已连接却提示 Token 无效的情况，解决方案有两个，一个是加一个刷新
 * > 按钮，一个就是安卓端自动刷新，我的建议是加一个刷新按钮，后续如果新增的
 * > 仓库点刷新，可以重新获取仓库情况
 *
 * ## 真因（两个独立的洞）
 *
 * ```text
 *   ① access token 只有 2 小时（ACCESS_TOKEN_TTL_SECONDS）
 *      refresh token 有 30 天（REFRESH_TOKEN_TTL_SECONDS）
 *      而客户端的 refresh() 函数**从来没被调用过** —— 零调用点
 *      ⇒ 隔天打开必然 401，除了登出重登没有出路
 *
 *   ② 401 之后没有任何恢复路径
 *      `expired` 只在**未登录**分支显示，而 token 过期时 accessToken 非空
 *      ⇒ 走"已登录"分支 ⇒ 界面同时出现「已登录：Gez」和「缺少或无效的访问令牌」
 *      ⇒ 两句都对，合起来自相矛盾，用户不知道该信哪句
 * ```
 *
 * ## 判据分四组
 *
 * ```text
 *   A  自动续期：存在、会调用、令牌轮换后必须落盘
 *   B  并发安全：refresh 是轮换语义 ⇒ 必须单飞，否则互相作废
 *   C  重试正确：重试时必须读**新** token（值拷贝会拿旧的）
 *   D  界面出路：过期要说清 + 给按钮 + 不死循环
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return (
    source
      /*
       * ★★★ 先把 CRLF 归一成 LF（2026-11-07，当场被咬）。
       *
       * 本仓库的 .ts 是 **CRLF**。`/^...$/m` 里的 `$` 匹配的是 `\n` **之前**
       * 的位置，而 CRLF 下那个位置前面还有一个 `\r` —— 于是
       * `/^ *expired: this\.repoAuthExpired,$/m` **永远不匹配**，
       * 哪怕源码写着完全一样的一行。
       *
       * 症状很隐蔽：判据红，但你把那一行抄出来看怎么都对。
       * 不归一化的话，以后每一条含 `$` 的判据都会莫名其妙地红。
       */
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
  );
}

const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const repoPageSrc = stripComments(read('client/src/chat/repo-page.ts'));
const authSrc = stripComments(read('client/src/auth/auth-client.ts'));

/* ═══════════════════════════════════════════════════════════
   A 自动续期
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 客户端必须真的调用 refresh（原来零调用点）', () => {
  /*
   * `client/src/auth/auth-client.ts` 里的 `refresh()` 写了 100 多天，
   * 全库**零调用点** —— 与 §59「做完了≠交付了」同一类：能力在，没接线。
   *
   * 判据：shell 里必须 import 并调用它。
   */
  assert.match(authSrc, /export async function refresh\(/, 'auth-client 里应有 refresh()');
  assert.match(shellSrc, /refresh as apiRefresh/, 'shell 要 import 它（起别名避免与本地方法重名）');
  assert.match(shellSrc, /apiRefresh\(origin, this\.repoAuth\.refreshToken/, '要用存着的 refreshToken 去换');
});

test('★★★★★ 续期后必须把**新的 refresh token** 也落盘', () => {
  /*
   * 服务端的 `/api/auth/refresh` 是**轮换**语义（`rotateRefresh`）：
   * 每刷一次就换掉 refresh token，旧的立即作废。
   *
   * 如果只更新 accessToken 而不存新的 refreshToken：
   *
   * ```text
   *   第 1 次续期（2 小时后）  用 token1 换到 token2，只存了 access2
   *   第 2 次续期（4 小时后）  又拿 token1 去换 ⇒ 401，因为 token1 已作废
   *   ⇒ 用户第二次就必须重新登录，而问题本可以说 30 天内都不打扰
   * ```
   *
   * 所以 `this.repoAuth = {...}` 里四个字段都要有，且随后 `writeRepoAuth`。
   */
  const at = shellSrc.indexOf('private async refreshRepoAuth');
  assert.ok(at > 0, '找不到 refreshRepoAuth');
  const body = shellSrc.slice(at, at + 3200);

  assert.match(body, /refreshToken: bundle\.refreshToken/, '新 refresh token 必须存进状态');
  assert.match(body, /accessToken: bundle\.accessToken/, '新 access token 必须存进状态');
  assert.match(body, /accessExpiresAt: bundle\.accessExpiresAt/, '到期时刻要跟着更新');
  assert.match(body, /await writeRepoAuth\(/, '必须落盘（否则下次开机还是旧的）');

  /*
   * 落盘要在赋值**之后** —— 反了就是把旧值写回磁盘。
   */
  const assignAt = body.indexOf('this.repoAuth = {');
  const writeAt = body.indexOf('await writeRepoAuth(');
  assert.ok(assignAt > 0 && writeAt > assignAt, '先赋值再落盘');
});

/* ═══════════════════════════════════════════════════════════
   B 并发安全（这条是最容易漏、后果最严重的）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 续期必须单飞（并发只刷一次）', () => {
  /*
   * refresh 是轮换语义。仓库页进入时会**并发**发多个请求
   * （连通探测 + 仓库列表 + 卡片列表），若每个 401 各自去刷：
   *
   * ```text
   *   t0  A 401 → refresh(旧) → 拿到 token2（token1 作废）
   *   t0  B 401 → refresh(旧) → 401！因为 token1 已被 A 用掉
   *   ⇒ B 判定"登录过期"，把用户踢成未登录 —— 而刚刚续期其实成功了
   * ```
   *
   * 用户看到的是"明明刚刷成功，却又让我重新登录"。
   */
  assert.match(
    shellSrc,
    /private repoRefreshInFlight: Promise<boolean> \| null = null/,
    '要有 in-flight 字段',
  );

  const at = shellSrc.indexOf('private async refreshRepoAuth');
  const body = shellSrc.slice(at, at + 3200);

  /* 先判 in-flight，再决定要不要发请求 */
  const guardAt = body.indexOf('if (this.repoRefreshInFlight !== null)');
  const assignAt = body.indexOf('this.repoRefreshInFlight = task');
  assert.ok(guardAt > 0, '开头要判 in-flight');
  assert.ok(assignAt > guardAt, 'in-flight 必须在 guard 之后才赋值');

  /* finally 里清空 —— 不清的话失败一次以后永远等同一个旧 Promise */
  assert.match(body, /finally[\s\S]{0,120}this\.repoRefreshInFlight = null/, '结束后要清空 in-flight');
});

test('★★★★ 续期失败时不许弹通知（否则一次 401 弹三条）', () => {
  /*
   * 三个请求同时 401、同时续期失败 ⇒ 如果 `refreshRepoAuth` 内部
   * 各自 `onNotify`，用户会收到三条一模一样的「登录已过期」，
   * 看起来像出了三个错。
   *
   * 提示统一由 `repoExpiredError()` 发一次（它只在最后一次抛出时调用）。
   */
  const at = shellSrc.indexOf('private async refreshRepoAuth');
  const body = shellSrc.slice(at, at + 3200);
  assert.ok(!/onNotify/.test(body), 'refreshRepoAuth 内部不许弹通知');
});

/* ═══════════════════════════════════════════════════════════
   C 重试正确性
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 401 重试时必须读**新** token（值拷贝会拿旧的，等于没续）', () => {
  /*
   * `repoSyncConfig()` 返回的对象里 `token` 是**值拷贝**。
   * 续期后 `this.repoAuth.accessToken` 变了，但闭包里捕获的那份不会变 ——
   * 直接拿旧 config 重试还是 401。
   *
   * 所以重试路径必须**重新调** `repoSyncConfig()`。
   */
  const at = shellSrc.indexOf('private async runRepoRequest');
  assert.ok(at > 0, '找不到 runRepoRequest');
  const body = shellSrc.slice(at, at + 1400);

  assert.match(body, /repoFetchWithRefresh/, '要走带续期的包装');
  assert.match(body, /const config = this\.repoSyncConfig\(\);/, '重试时必须重新取配置');
});

test('★★★★ 401 → 续期 → 重试，且只重试一次（不许递归）', () => {
  const at = shellSrc.indexOf('private async repoFetchWithRefresh');
  assert.ok(at > 0);
  const body = shellSrc.slice(at, at + 1200);

  assert.match(body, /this\.isUnauthorized\(error\)/, '要先判是不是 401');
  assert.match(body, /await this\.refreshRepoAuth\(\)/, '要续期');
  assert.match(body, /return await work\(\);/, '续期成功后重试');

  /*
   * ★ 重试发生在 `try` 块**外面**（catch 里），所以再 401 不会再进
   * catch —— 天然只有一次。
   *
   * ★★ 判据取点要小心：`return await work();` 在源码里出现**两次**
   *   （try 里首次执行一次、catch 里重试一次）。用 `indexOf` 取到的
   *   是 try 里那个 —— 它当然在 catch 之前，于是这条判据永远红。
   *   必须**从 catch 之后**开始找。
   */
  const catchAt = body.indexOf('} catch (error) {');
  assert.ok(catchAt > 0, '找不到 catch 分支');
  const retryAt = body.indexOf('return await work();', catchAt);
  assert.ok(retryAt > catchAt, '重试必须在 catch 分支内（否则就是无限递归）');
});

test('★★★★ 续期也失败时，给用户看的文案必须指向"重新登录"', () => {
  /*
   * 服务端原话是「缺少或无效的访问令牌」。直接透传的问题：
   *   · 只描述现象，不说下一步
   *   · 与界面上「已登录：Gez」并列时自相矛盾
   */
  const at = shellSrc.indexOf('private repoExpiredError');
  assert.ok(at > 0, '找不到 repoExpiredError');
  const body = shellSrc.slice(at, at + 800);
  assert.match(body, /重新登录/, '文案要指出下一步');
  assert.ok(!/缺少或无效的访问令牌/.test(body), '不许把服务端原话直接给用户');
});

/* ═══════════════════════════════════════════════════════════
   D 界面：刷新按钮 + 过期出路 + 不死循环
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 仓库页要有刷新按钮（用户明确建议）', () => {
  assert.match(repoPageSrc, /data-role', 'repo-refresh'/, '要有 data-role（探针靠它定位）');
  assert.match(repoPageSrc, /onRefresh/, '点击要能回调出去');
  assert.match(repoPageSrc, /aria-label', '刷新仓库列表'/, '无障碍名称');
});

test('★★★★★ 登录过期时不许自动拉列表（否则是无限循环）', () => {
  /*
   * 闭环：
   *
   * ```text
   *   renderRepoPage → 自动 loadRepos → 401 → refresh 失败
   *   → repoExpiredError() → renderPage() → renderRepoPage → 又 loadRepos …
   * ```
   *
   * 每圈一次网络请求，页面永远停在「正在读取…」。
   *
   * 判据：`status.expired` 分支里**不能**出现 `loadRepos(`。
   */
  assert.match(repoPageSrc, /if \(status\.expired\) \{[\s\S]{0,600}?repo-list-blocked/, '过期时要画提示');

  /*
   * ★★ 切片必须精确到"过期分支结束"。
   *
   * 第一版用 `expiredAt + 900` 的固定窗口 —— 窗口越过了 `} else {`
   * 进入正常分支，那里**当然**有 `loadRepos(host, ...)`，于是判据
   * 把"正常分支该做的事"当成了"过期分支违规"。今天第四次取错点。
   *
   * 改成按大括号找配对的 `} else {`。
   */
  const blockAt = repoPageSrc.indexOf("blocked.setAttribute('data-role', 'repo-list-blocked')");
  assert.ok(blockAt > 0, '找不到过期分支');
  const elseAt = repoPageSrc.indexOf('} else {', blockAt);
  assert.ok(elseAt > blockAt, '找不到过期分支的 else');
  const expiredBranch = repoPageSrc.slice(blockAt, elseAt);
  assert.ok(!/loadRepos\(/.test(expiredBranch), '过期分支里不许自动 loadRepos');

  /* 而 else 分支必须还在拉（否则正常路径也废了） */
  const normalBranch = repoPageSrc.slice(elseAt, elseAt + 1200);
  assert.match(normalBranch, /loadRepos\(host/, '正常分支仍然要自动拉');
});

test('★★★★★ 过期时「已登录」与「令牌无效」不许同时出现且不给按钮', () => {
  /*
   * 用户截图里的矛盾状态：
   *
   * ```text
   *   已登录：Gez
   *   缺少或无效的访问令牌
   * ```
   *
   * 现在必须改成一句话说清"登录还在但会话失效了，点这里重新登录"，
   * 并且登出按钮的文案要跟着变成「登出并重新登录」—— 否则用户看不出
   * 那颗按钮是唯一出路。
   */
  const whoAt = repoPageSrc.indexOf("who.setAttribute('data-role', 'repo-who-expired')");
  assert.ok(whoAt > 0, '过期时账户区要有专门的说明');
  const around = repoPageSrc.slice(whoAt, whoAt + 400);
  assert.match(around, /登出.*重新登录|重新登录/, '说明里要指向重新登录');

  assert.match(
    repoPageSrc,
    /status\.expired \? '登出并重新登录' : '登出'/,
    '登出按钮文案要随状态变',
  );
});

test('★★★ `expired` 只认"真的续期失败"，不按本地时钟推测', () => {
  /*
   * 第一版按 `accessExpiresAt < now` 判断。后果：
   *
   * ```text
   *   隔天打开 App（access 只有 2 小时，必然过期）
   *     ⇒ 直接写"登录已过期，请重新登录"
   *     ⇒ 而 refresh token 还有 30 天，本来能自动续上
   * ```
   *
   * 等于把"用户无感的自动续期"变成"每次重启都逼他重登" —— 比原 bug 更糟。
   *
   * ★★ 判据要钉**整行只有一个标识符**，不能只查"有没有那段字符串"。
   *   第一版判据写的是：
   *
   * ```js
   *   assert.match(body, /expired: this\.repoAuthExpired/);
   *   assert.ok(!/accessExpiresAt\s*>/.test(body));
   * ```
   *
   *   而变异后的代码是 `|| this.repoAuth.accessExpiresAt < Date.now()` ——
   *   前缀照样匹配，`<` 又不是 `>`，两条**全过**。变异验证当场抓到了
   *   这个假绿（本日第五次"判据取错对象"）。
   */
  const at = shellSrc.indexOf('private repoStatus()');
  assert.ok(at > 0);
  const body = shellSrc.slice(at, at + 1400);

  /* 整行必须恰好是 `expired: this.repoAuthExpired,` —— 多个 `||` 都不行 */
  assert.match(
    body,
    /^[ \t]*expired: this\.repoAuthExpired,$/m,
    'expired 必须只等于 repoAuthExpired（不许拼接任何时间判断）',
  );

  /*
   * 再兜一道：那一行附近不许出现时钟。
   *
   * ★ 窗口只能取 ±200 字符。第一版用的是整个 1400 字符的窗口，
   *   而 `repoStatus` 后面的 `probeRepoLink` 里就有 `Date.now()`
   *   （`repoLinkCheckedAt = Date.now()`，那是对的用法）——
   *   窗口跨过去之后这条判据**恒红**，与真正要防的东西无关。
   *   这是本日第六次"判据取错范围"。
   */
  const lineAt = body.search(/^[ \t]*expired: this\.repoAuthExpired,$/m);
  const around = body.slice(Math.max(0, lineAt - 200), lineAt + 200);
  assert.ok(!/Date\.now\(\)/.test(around), 'expired 那一行附近不许用 Date.now()');
});

test('★★★ 变异防守：把本地时钟拼进 expired 必须被上面那条拦住', () => {
  /*
   * 反证这条判据**真的在测东西**。
   *
   * 直接对源码字符串做一次"心理变异"：如果那一行被改成
   * `expired: this.repoAuthExpired || this.repoAuth.accessExpiresAt < Date.now(),`
   * 上面那条的正则应该**不匹配**。
   *
   * 这样即使将来有人放宽了上面那条（比如又改回 `indexOf` 判断），
   * 这条反证会立刻红。
   */
  const mutatedLine =
    '      expired: this.repoAuthExpired || this.repoAuth.accessExpiresAt < Date.now(),';
  assert.ok(
    !/^[ \t]*expired: this\.repoAuthExpired,$/m.test(mutatedLine),
    '带 || 的写法不该通过那条判据 —— 若不成立，说明判据太松',
  );
});

test('★★★ 刷新按钮要有忙碌态，且用本地变量防连点', () => {
  /*
   * `ElLike` 没有 `hasAttribute`（接口刻意精简），而
   * `getAttribute('disabled')` 返回空串，表达"有没有"很别扭。
   * 状态本来就该存在页面自己的闭包里。
   */
  assert.match(repoPageSrc, /data-busy', 'true'/, '要有忙碌态');
  assert.match(repoPageSrc, /let refreshing = false/, '要有本地防连点变量');
});

test('★★★ 手动刷新失败的原因要留在页面上（不弹通知）', () => {
  /*
   * 通知 3.2 秒就消失，而用户点刷新就是为了看"为什么是空的"。
   */
  assert.match(repoPageSrc, /repo-refresh-error/, '失败原因要画在列表位置');
});

/* ═══════════════════════════════════════════════════════════
   E 换页必须关掉挂 body 的浮层（2026-11-07 真机抓到的）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 换页时要主动关闭下拉面板（它挂在 body，不随页面销毁）', () => {
  /*
   * 真机现象：聊天页点开人设下拉 → 直接点底部「仓库」→
   * **人设面板还浮在仓库页上面**。
   *
   * 真因：下拉是 `position: fixed` 挂在 `body` 上，不在页面子树里，
   * `pageHost.replaceChildren()` 换页时它不会跟着消失。
   * 它原本只靠"点面板外"和"页面滚动"关闭，而切 Tab 两者都不触发。
   *
   * `closeActiveSelectPopover()` 早就导出了，但**零外部调用** ——
   * 又一个"写了没人调"（本日第二个，第一个是 `refresh()`）。
   */
  const at = shellSrc.indexOf('private renderPage()');
  assert.ok(at > 0, '找不到 renderPage');
  const body = shellSrc.slice(at, at + 900);
  assert.match(body, /closeActiveSelectPopover\(\);/, 'renderPage 开头要关掉浮层');

  /*
   * 必须在**创建新层之前**关 —— 关晚了它是关在新页面上的，
   * 用户会看到面板闪一下再消失。
   */
  const closeAt = body.indexOf('closeActiveSelectPopover();');
  const appendAt = body.indexOf('this.pageRoot.append(next);');
  assert.ok(closeAt > 0 && appendAt > closeAt, '先关面板，再建新层');
});

test('★★★ closeActiveSelectPopover 必须真的被 import（不是同名巧合）', () => {
  const importSrc = read('client/src/chat/shell.ts');
  assert.match(
    importSrc,
    /import \{[^}]*closeActiveSelectPopover[^}]*\} from '\.\/select-popover\.ts'/,
    '要从 select-popover 导入它',
  );
});
