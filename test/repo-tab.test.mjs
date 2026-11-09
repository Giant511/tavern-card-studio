/**
 * 仓库 Tab 判据（2026-11-04，T15.2 阶段 A；同日按用户要求合并成"一页到底"）。
 *
 * ## 用户的两组硬约束
 *
 * ```text
 *   上一轮：全部走既有服务端 API 与 auth/session 纯逻辑层，禁止重写任何协议代码
 *   本轮  ：自定义和内置云仓库在同一个页面，用下拉选择
 *           内置云仓库的 URL 不要暴露给用户
 * ```
 *
 * ## 这组判据守什么
 *
 * ```text
 *   在页面里写 fetch        → 协议从此两份，改一处忘另一处
 *   硬编码 /api/ 路径       → 绕过那层的超时与错误处理
 *   云仓库地址显示出来      → 用户看到内部域名，引出无关问题
 *   邀请码框在登录时也提示  → 用户以为登录要填码，回头去要一个不需要的码
 *   注册后不自动登录        → 明明注册成功了还要再输一遍密码
 *   直接用全局 fetch        → 这个壳里它根本不可用（真机实测）
 * ```
 *
 * 六种都不报错。逐条钉。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(REPO, rel), 'utf8');

/** 剥注释（判据自己的解释文字里会引用被禁的东西） */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '')
    .replace(/\s\/\/[^\n]*$/gm, '');
}

const REPO_PAGE = 'client/src/chat/repo-page.ts';
const SHELL = 'client/src/chat/shell.ts';

/* ═══════════════════════════════════════════════════════════
   一、一页到底（本轮核心变化）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 服务端配置不再是独立页（已合并进仓库页）', () => {
  /*
   * 用户要求：
   *
   * > 自定义和内置云仓库应该在同一个页面处理，使用下拉选项进行选择
   *
   * 原来的"仓库页 → 点服务端 → 配置页 → 返回"两步走没了。
   *
   * ★ 为什么删文件而不是留着不用：留着就有两个"改服务端配置"的入口，
   * 以后有人改了其中一个、另一个不生效 —— 那种缺陷最难查
   * （界面上两个地方看起来都能改，只有一个真管用）。
   */
  assert.equal(
    existsSync(join(REPO, 'client/src/chat/repo-config-page.ts')),
    false,
    'repo-config-page.ts 应该已删除（配置已合并进 repo-page）',
  );

  const shell = stripComments(read(SHELL));
  assert.doesNotMatch(shell, /renderRepoConfigPage/, 'shell 里不该还有独立配置页');
  assert.doesNotMatch(shell, /repoConfigOpen/, '不该还有"配置页是否打开"这个状态');
});

test('★★★ 仓库页有类型下拉，且按类型分支', () => {
  const src = stripComments(read(REPO_PAGE));

  assert.match(src, /makeSelectTrigger/, '要用下拉选择仓库类型');
  assert.match(src, /repo-kind/, '下拉要带 data-role');
  assert.match(src, /draft\.kind === 'cloud'/, '要按类型分支');
  assert.match(src, /CLOUD_INVITE_HINT/, '内置模式要有邀请码说明');
});

test('★★★ 内置云仓库不向用户暴露地址', () => {
  /*
   * 用户明令：
   *
   * > 内置云仓库的 URL 不要暴露给用户
   *
   * 所以 cloud 分支里**不能**有地址输入框、也不能把 origin 写到界面上。
   *
   * ★ 为什么这条要用判据守：最容易的"顺手实现"就是把 cloud 的地址
   * 填进一个 readonly 输入框（我上一版就是这么做的）。看起来"让用户知道
   * 连到哪"是透明的，实际会引出"这是谁的服务器""我能不能改"这类
   * 与任务无关的问题。
   */
  const src = stripComments(read(REPO_PAGE));

  /* 找到 cloud 分支的边界：从 `draft.kind === 'cloud'` 到配对的 `} else {` */
  const at = src.indexOf("draft.kind === 'cloud'");
  assert.ok(at > 0, '找不到 cloud 分支');
  const elseAt = src.indexOf('} else {', at);
  assert.ok(elseAt > at, '找不到 else 边界');
  const cloudBlock = src.slice(at, elseAt);

  assert.doesNotMatch(cloudBlock, /repo-cloud-address/, '内置模式不该有地址输入框');
  assert.doesNotMatch(cloudBlock, /CLOUD_REPO_HOST/, '不该把域名写出来');
  assert.doesNotMatch(cloudBlock, /CLOUD_REPO_ORIGIN/, '不该把完整地址写出来');
});

test('★★★ 自定义模式才有地址栏，且没有预览行', () => {
  const src = stripComments(read(REPO_PAGE));
  assert.match(src, /repo-custom-address/, '自定义模式要有地址输入框');

  /*
   * 2026-11-04 用户要求去掉（原话）：
   *
   * > 这个地方在 UI 上去掉，用户无感就行
   * > 那你填错了直接弹窗不就好了，因为这个地方 UI 的框很不一致，不好看
   *
   * 那行"实际会连到 https://…（已加密）"只在填错时才有信息量，
   * 填对的时候它只是把用户自己写的内容再念一遍，还把字段行的疏密拉得不匀。
   */
  assert.doesNotMatch(src, /repo-address-preview/, '不该再有"实际会连到哪"预览行');
  assert.doesNotMatch(src, /实际会连到/, '预览文案也要一起删干净');
});

test('★★★ 去掉预览行后，地址填错仍然有提示（不能连提示一起删）', () => {
  /*
   * 删掉预览行时最容易连带丢掉的东西：那是"填错了"的唯一反馈。
   * 现在收在 `gateDraft()` —— 点登录/注册时 `onNotify(reason)`。
   */
  const src = stripComments(read(REPO_PAGE));
  const at = src.indexOf('const gateDraft = async');
  assert.ok(at > 0, '找不到 gateDraft');
  const block = src.slice(at, src.indexOf('const commitThen', at));

  assert.match(block, /resolveRepoOrigin\(draft\)/, '要解析地址');
  assert.match(block, /if \(!resolved\.ok\)/, '要有非法分支');
  assert.match(block, /callbacks\.onNotify\(resolved\.reason/, '非法时要把原因提示给用户');
});

test('★★ 打字过程中不弹提示（地址栏只同步 draft，不碰 DOM）', () => {
  const src = stripComments(read(REPO_PAGE));
  const at = src.indexOf("addr.addEventListener('input'");
  assert.ok(at > 0, '地址栏要有 input 监听（同步 draft）');
  const block = src.slice(at, at + 240);

  assert.match(block, /draft = \{ \.\.\.draft, customAddress: valueOf\(addr\) \}/, '要同步到 draft');
  assert.doesNotMatch(block, /onNotify/, '打字过程中不许弹提示：半截地址必然非法');
});

/* ═══════════════════════════════════════════════════════════
   二、账户表单
   ═══════════════════════════════════════════════════════════ */

test('★★★ 邀请码占位提示说明"仅注册时填写"', () => {
  /*
   * 用户要求：
   *
   * > 填写栏里面提示仅注册的时候才填写，登录不需要填写
   *
   * 不写这句的后果：用户登录时看到空的邀请码框，以为必填，
   * 回头找开发者要一个**本来不需要**的码。
   */
  const src = read(REPO_PAGE);
  assert.match(src, /仅注册时填写/, '邀请码占位提示必须说明仅注册时填');
  assert.match(src, /登录不用填/, '要说明登录不用填');
});

test('★★★ 邀请码字段只在被内置模式渲染', () => {
  const src = stripComments(read(REPO_PAGE));

  const inviteAt = src.indexOf("textInput(doc, 'repo-invite'");
  assert.ok(inviteAt > 0, '找不到邀请码输入框');

  /* 往前找最近的 cloud 条件 */
  const before = src.slice(0, inviteAt);
  const lastIf = before.lastIndexOf("draft.kind === 'cloud'");
  assert.ok(lastIf > 0, '邀请码输入框必须在 cloud 分支里');

  /* 且它在 if 之内、else 之前（中间不该出现配对的 else） */
  const between = src.slice(lastIf, inviteAt);
  assert.doesNotMatch(between, /\}\s*else\s*\{/, '邀请码不能在 else 分支');
});

test('★★★ 注册成功后自动登录', () => {
  /*
   * 用户要求：
   *
   * > 支持注册后自动登录
   *
   * 服务端注册成功时会**直接返回令牌**（`accessToken` + `refreshToken`），
   * 所以"自动登录"不需要再打一次 login —— 把令牌存下来就是登录态。
   *
   * 但 `tokens === null` 的情况（`admin-only` 模式替人建号）不能假装成功。
   */
  const shell = stripComments(read(SHELL));
  const start = shell.indexOf('private async repoRegisterWith');
  assert.ok(start > 0, '找不到注册方法');
  const block = shell.slice(start, start + 2400);

  assert.match(block, /outcome\.tokens === null/, '要处理"只建号没会话"的情况');
  /*
   * 钉**性质**：注册成功必须把令牌写下来（= 自动登录）。
   *
   * 原来钉的是 `writeRepoAuth(this.repoAuth)` 这个精确形式 ——
   * 2026-11-05 给 `writeRepoAuth` 加了 `origin` 参数（按 origin 分槽存），
   * 变成 `writeRepoAuth(this.repoOrigin() ?? '', this.repoAuth)`，
   * 性质没变、判据却红了。
   *
   * 这是本项目第 N 次「判据钉实现而非性质」：断言应该回答
   * "它必须满足什么"，而不是"这行代码长什么样"。
   */
  /*
   * `[\s\S]{0,80}?` 而不是 `[^)]*`：第一个参数是 `this.repoOrigin() ?? ''`，
   * 里面自带一对括号 —— `[^)]*` 会在那里断掉，判据永远匹配不上。
   */
  assert.match(
    block,
    /writeRepoAuth\([\s\S]{0,80}?this\.repoAuth/,
    '注册成功要把令牌存下来（= 自动登录）',
  );
  assert.match(block, /outcome\.tokens\.accessToken/, '用注册返回的令牌，不是再登录一次');
});

test('★★★ 注册与登录都带"页面刚给的配置"', () => {
  /*
   * 用户可能是"刚改完地址就点登录"。外壳手里若还是上一次保存的地址，
   * 请求会打到旧机器 —— 而界面上显示的是新地址，用户会以为新地址没生效。
   */
  const shell = stripComments(read(SHELL));

  assert.match(shell, /repoLoginWith\(\s*config,/, '登录方法要接收配置');
  assert.match(shell, /repoRegisterWith\(\s*config,/, '注册方法要接收配置');
  assert.match(shell, /await this\.saveRepoConfig\(config\)/, '连接前先同步配置');
});

/* ═══════════════════════════════════════════════════════════
   三、闸门顺序
   ═══════════════════════════════════════════════════════════ */

test('★★★ 明文风险闸门在"发请求之前"', () => {
  /*
   * 顺序错了的后果：先发请求（令牌已明文过网），再弹提示。
   * 闸门的全部意义就是"在发之前拦住"。
   */
  const src = stripComments(read(REPO_PAGE));

  const gateAt = src.indexOf('needsPlainHttpAck(');
  assert.ok(gateAt > 0, '要调用明文闸门判定');

  const commitAt = src.indexOf('await callbacks.onConfigChange(gated)');
  assert.ok(commitAt > gateAt, '闸门必须在提交配置之前');

  const loginAt = src.indexOf('await commitThen(');
  assert.ok(loginAt > 0, '登录要走 commitThen（先过闸门再提交）');
});

test('★★★ 换服务端不许沿用旧令牌（2026-11-05 从"清空"改成"换槽"）', () => {
  /*
   * ## 需求变了，安全性质没变
   *
   * 原判据要求 `clearRepoAuth()` —— 换服务端就把登录态清空。
   * 清空**安全**（不同服务器的 token 绝不能混用），但用户报：
   *
   * > 只要从内置云仓库切到自定义仓库，或者是自定义切到内置云仓库，
   * > 登录状态都会消失，但是杀掉进程和切换到其他页面不会消失
   *
   * 也就是说：清掉之后**没地方恢复**，切回原来的服务器还得重新登录。
   *
   * 现在改成"按 origin 分槽"：
   *
   * ```text
   *   切到 B → 读 B 那格（多半是空）→ 未登录    ✅
   *   切回 A → 读 A 那格           → 恢复登录    ✅
   * ```
   *
   * ★ 安全性质**更强了**：原来靠"清空"保证不串用，
   * 现在靠"按 origin 分 key"在**存储结构上**保证拿不到对方的 token。
   *
   * 所以这条判据改成验那两件真正重要的事：
   *   ① 要比较前后 origin（不比较就不知道该读哪一格）
   *   ② 新 origin 的登录态必须**从存储里读**，不许沿用内存里那份旧 token
   */
  const shell = stripComments(read(SHELL));
  const start = shell.indexOf('private async saveRepoConfig');
  assert.ok(start > 0, '找不到保存配置的方法');
  const block = shell.slice(start, start + 2600);

  assert.match(block, /beforeOrigin !== afterOrigin/, '要比较前后 origin');
  assert.match(
    block,
    /this\.repoAuth\s*=\s*readRepoAuthFor\(/,
    '换 origin 后必须从存储读新那格 —— 沿用内存里的旧 token 就是跨服务器串用',
  );
  /*
   * ★★★ 2026-11-05 晚上再反向一次：**不许**再把旧登录态存进旧槽。
   *
   * 上一版这里是正的（要求 `writeRepoAuth(beforeOrigin, …)`），
   * 为的是"切回去还能恢复"。用户当天就撞上了它的代价：
   *
   * > 还有一个很危险的问题就是自定义和云仓库可以同时登录
   *
   * 两套 token 并存 = 两个账号同时在线。现在切换即登出。
   * 详见 `mobile-fixes-2026-11-05.test.mjs` 里那条同名判据的长注释。
   */
  assert.doesNotMatch(
    block,
    /writeRepoAuth\([\s\S]{0,40}?beforeOrigin/,
    '不许把旧登录态存下来（那会变成两套并存、两个账号同时在线）',
  );
  assert.match(block, /await clearRepoAuth\(/, '切换服务端要清掉旧登录态');
});

test('★★★ 登录态按 origin 分槽存（不是只有一份）', () => {
  /*
   * 存储层的判据：`writeRepoAuth` 必须带 origin，且真的按它分 key。
   * 只看外壳是看不出来的 —— 外壳传了 origin，存储层若忽略它照样串用。
   */
  const store = stripComments(read('client/src/chat/repo-store.ts'));

  assert.match(store, /LS_AUTH_BY_ORIGIN/, '要有按 origin 分槽的键');
  assert.match(
    store,
    /export async function writeRepoAuth\(\s*origin: string,/,
    'writeRepoAuth 必须接收 origin',
  );
  assert.match(
    store,
    /export function readRepoAuthFor\(/,
    '要有 readRepoAuthFor(origin)',
  );
  /* 清一格不许清全部（退出登录是"我这个人登出"，那才清全部） */
  assert.match(
    store,
    /export async function clearRepoAuth\(origin\?: string\)/,
    'clearRepoAuth 要能只清一个 origin',
  );
  /*
   * ★ 2026-11-05：表结构仍是 origin → 登录态，但**写入互斥** ——
   * 表里永远最多一条。这样 `readRepoAuthFor` 不用改，
   * 而"两套并存"在存储层就被挡住了。
   */
  assert.match(
    store,
    /for \(const key of Object\.keys\(map\)\)[\s\S]{0,80}?delete map\[key\]/,
    '写入时要清掉其它 origin',
  );
});

/* ═══════════════════════════════════════════════════════════
   四、不许重写协议
   ═══════════════════════════════════════════════════════════ */

test('★★★ 仓库页里一次 fetch 都不许有', () => {
  const src = stripComments(read(REPO_PAGE));
  assert.doesNotMatch(src, /\bfetch\s*\(/, '仓库页里出现了 fetch —— 协议不许在这一层写');
  assert.doesNotMatch(src, /\bXMLHttpRequest\b/, '仓库页里出现了 XHR');
  assert.doesNotMatch(src, /['"`]\/api\//, '仓库页里出现了硬编码 API 路径');
});

test('★★★ 外壳复用既有三个客户端模块', () => {
  const src = read(SHELL);
  assert.match(src, /from '\.\.\/auth\/auth-client\.ts'/, '要复用 auth-client');
  assert.match(src, /from '\.\.\/sync\/server-sync\.ts'/, '要复用 server-sync');
});

/* ═══════════════════════════════════════════════════════════
   五、上传
   ═══════════════════════════════════════════════════════════ */

test('★★★ 上传读 PNG 里的卡数据，body 是原文', () => {
  const src = stripComments(read(SHELL));
  const start = src.indexOf('onUpload: async');
  assert.ok(start > 0, '找不到 onUpload');
  const block = src.slice(start, start + 2200);

  assert.match(block, /this\.bridge\.characterPng\(/, '要读 PNG 字节');
  assert.match(block, /parsePngCard\(/, '要用既有解析器');
  assert.match(block, /text: parsed\.jsonText/, '要传 JSON 原文（不重新序列化）');
  assert.doesNotMatch(block, /characters\/get/, '不许走 /get');
});

/* ═══════════════════════════════════════════════════════════
   六、网络层走原生通道
   ═══════════════════════════════════════════════════════════ */

test('★★★ 每个仓库调用都注入原生 fetch', () => {
  /*
   * 真机实测：这个 WebView 里 fetch 完全不可用（连 127.0.0.1 都失败）。
   * 漏一处的表现是"某个功能报连不上"，其它功能正常 —— 极难定位。
   */
  const src = stripComments(read(SHELL));

  for (const fn of [
    'apiLogin',
    'apiRegister',
    'apiLogout',
    'repoListCards',
    'repoUploadCard',
    'repoListVersions',
    'repoRollbackCard',
    'repoDeleteCard',
  ]) {
    const at = src.indexOf(`${fn}(`);
    assert.ok(at > 0, `找不到 ${fn}`);
    const window = src.slice(at, at + 280);
    assert.match(window, /pickFetch\(\)/, `${fn} 没注入原生 fetch`);
  }
});

test('★★★ 原生 fetch 适配器不许静默吞掉错误', () => {
  const src = stripComments(read('client/src/chat/native-fetch.ts'));
  assert.match(src, /throw new TypeError\(reply\.error/, '原生错误要抛出去');
  assert.match(src, /function makeResponse/, '要有 Response 适配');
});

test('★★★ 只对用户确认过的 origin 关证书校验', () => {
  const src = stripComments(read('client/src/chat/native-fetch.ts'));
  assert.match(src, /setInsecureOrigins/, '要有白名单入口');
  assert.match(src, /insecureOrigins\.has\(originOf\(url\)\)/, '要按 origin 判定而不是全局');

  const shellSrc = stripComments(read(SHELL));
  assert.match(shellSrc, /this\.repoConfig\.ackedPlainOrigin/, '要用明文确认记录');
  assert.match(shellSrc, /this\.repoConfig\.trustedCertOrigins/, '要用证书信任记录');
});

test('★★★ WebView 放开混合内容，且不是 ALWAYS_ALLOW', () => {
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
  );
  assert.match(kt, /MIXED_CONTENT_COMPATIBILITY_MODE/);
  assert.doesNotMatch(kt, /MIXED_CONTENT_ALWAYS_ALLOW/);
});

/* ═══════════════════════════════════════════════════════════
   七、文案红线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 仓库页不许出现内部术语', () => {
  const src = read(REPO_PAGE);
  const literals = [...src.matchAll(/'([^'\n]{4,})'/g)].map((m) => m[1]);

  for (const text of literals) {
    if (text.includes('@tcs/') || text.startsWith('.')) continue;
    assert.ok(!/SillyTavern/i.test(text), `出现 SillyTavern：${text.slice(0, 50)}`);
    assert.ok(!/(?<![A-Za-z_])ST(?![A-Za-z_])/.test(text), `出现 ST：${text.slice(0, 50)}`);
  }
});

test('★★★ 邀请码说明引用共享常量，不硬编码', () => {
  /*
   * 那句话来自 `CLOUD_INVITE_HINT`，页面引用它而不是重写 ——
   * 重写就会出现"两处文字慢慢分叉"。
   */
  const src = read(REPO_PAGE);
  assert.match(src, /CLOUD_INVITE_HINT/, '要引用共享常量而不是硬编码文案');
});

/* ═══════════════════════════════════════════════════════════
   八、改地址不许抹掉已填的账号（2026-11-04 真机缺陷）

   现象（真机验收 ③⑪⑫⑰ 一起红）：

   ```text
     用户填了用户名 / 密码
     → 点地址框（失焦触发 change）→ 地址存盘 → 外壳 renderPage()
     → 页面重建，用户名密码回到空（它们在 render 的闭包里）
     → 再点「登录」→ 守卫报「用户名和密码都要填」
   ```

   更糟：`change` 是在**点登录按钮导致失焦**时触发的，用户点的
   正是那颗即将被移除的按钮 ⇒ 表现为"点了没反应"。

   ★ 为什么判"结构"而不是判"行为"：这条链跨了页面与外壳两层，
   页面单测里 fake 的 `onConfigChange` 不会重画任何东西，判不出来。
   真机探针里有对应断言（`credsKept`），这里钉住成因 —— 无条件重画。
   ═══════════════════════════════════════════════════════════ */

test('★★★ 保存配置要报告"登录态是否真被清掉"', () => {
  const src = stripComments(read(SHELL));
  assert.match(
    src,
    /private async saveRepoConfig\(next: RepoConfigState\): Promise<boolean>/,
    '返回值要能区分"有没有清掉登录态"',
  );
  assert.match(src, /const hadAuth = this\.repoAuth\.accessToken !== ''/, '要判是否本来登录着');
});

test('★★★ 配置变化只在登录态被清掉时重画整页', () => {
  const src = stripComments(read(SHELL));
  const from = src.indexOf('onConfigChange: async (next) =>');
  assert.ok(from > 0, '找不到 onConfigChange');
  const block = src.slice(from, src.indexOf('onLogin: async', from));

  assert.match(block, /authCleared/, '要用 saveRepoConfig 的返回值决定要不要重画');

  /*
   * 不许出现**不带条件**的 `this.renderPage()`。
   * 注释已在 stripComments 里剥掉，这里出现的都是真代码。
   */
  const bare = block
    .split('\n')
    .filter((line) => line.includes('this.renderPage()') && !line.includes('authCleared'));
  assert.deepEqual(bare, [], '存在无条件重画：改地址会把刚填的账号一起抹掉');
});

test('★★★ 地址失焦仍然存盘（别为了上一个缺陷把持久化一起删了）', () => {
  const src = stripComments(read(REPO_PAGE));
  const at = src.indexOf("addr.addEventListener('change'");
  assert.ok(at > 0, '地址框要有 change 处理');
  const block = src.slice(at, at + 700);
  assert.match(block, /callbacks\.onConfigChange/, '失焦要存地址，否则重启后回到空');
  assert.doesNotMatch(block, /askPlainHttpRisk/, '打字过程中不许弹明文框（会打断输入）');
});

/* ═══════════════════════════════════════════════════════════
   九、禁用状态的复位写法（2026-11-04 真机真缺陷）

   现象：点登录 → 弹「明文传输」风险框 → 点「换一个地址」取消
   → 登录 / 注册按钮**永久变灰**，再点没有任何反应。

   真因：`finally` 里写 `setAttribute('disabled', '')` 想"清掉"禁用。
   但 `disabled` 是**布尔属性** —— 只要属性存在就禁用，值是什么无关。
   真机实测 `el.disabled === true`、`matches(':disabled') === true`。

   ★ 这类错误不会报错、不会红单测，只会在某条路径上让按钮静默失效。
   所以判据直接钉写法。
   ═══════════════════════════════════════════════════════════ */

test('★★★ 不许用 setAttribute(disabled, 空串) 复位禁用状态', () => {
  /*
   * 全文扫，不限定某几个按钮：这写法一旦被人复制到新按钮上，
   * 缺陷就换个地方重演。
   */
  for (const rel of [REPO_PAGE, 'client/src/chat/persona-page.ts']) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(
      src,
      /setAttribute\(\s*'disabled'\s*,\s*''\s*\)/,
      `${rel} 用空串复位 disabled：属性仍在，按钮照样禁着`,
    );
  }
});

test('★★ 登出 / 登录 / 注册的 finally 用 removeAttribute 复位', () => {
  const src = stripComments(read(REPO_PAGE));

  for (const [name, needle] of [
    ['登出', 'out.removeAttribute'],
    ['登录', 'loginBtn.removeAttribute'],
    ['注册', 'registerBtn.removeAttribute'],
  ]) {
    assert.ok(src.includes(`${needle}('disabled')`), `${name}按钮要用 removeAttribute('disabled') 复位`);
  }
});
