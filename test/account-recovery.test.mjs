/**
 * 账户找回链路（2026-11-25）——静态形态判据。
 *
 * 端到端在 `scripts/verify-account-recovery.mjs`（35 条）与
 * `scripts/verify-account-security.mjs`（29 条）。这里只守"形态"：
 * 那些改回去不会报错、但会让用户走不通的地方。
 *
 * ## 为什么每一条都值得写
 *
 * ```text
 * ① 登录界面必须有「忘记密码？」入口         —— 忘了密码的人进不了账户面板
 * ② 临时密码字段必须齐（uid / 码 / 新密码） —— 少一个就提交不了
 * ③ 桌面端账户区必须有 UID + 复制 + 保存提示 —— 用户点名要的三样
 * ④ 改密码必须在文案里说"要重新登录"        —— 不说会被当成故障
 * ⑤ 运维修用户名/密码的入口必须**不在**     —— 兜底只发临时密码，不直接改
 * ```
 *
 * ⑤ 是这一版的关键取舍：运维直接设密码等于运维知道用户的最终密码。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 取一个类方法 / 函数体的源码片段。
 *
 * 为什么不用正则 `fnName[\s\S]*?\n  \}`：方法体里只要有嵌套的 `}`，
 * 第一个就停了 —— 我第一版就是这么写的，"issue 里没作废旧票据"
 * 与"resetPasswordWithTicket 没吊销会话"两条误报全是这个原因。
 *
 * 改成按**下一个同级成员**的位置切片（`\n\n  async ` / `\n\n  private ` /
 * `\n\n  function `），比猜缩进稳。
 */
function bodyOf(source, name) {
  const start = source.indexOf(name);
  if (start === -1) return '';
  const rest = source.slice(start + name.length);
  const end = rest.search(/\n\n(?:  (?:async |private |public |readonly |[a-zA-Z]+\()|export |function |const |\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end);
}


const LOGIN = read('client/src/auth/login-dialog.ts');
const REPO_DIALOG = read('client/src/sync/account-dialog.ts');
const REPO_CLIENT = read('client/src/sync/repo-client.ts');
const AUTH_CLIENT = read('client/src/auth/auth-client.ts');
const SERVICE = read('server/src/auth/service.ts');
const TICKET = read('server/src/auth/password-ticket.ts');
const SUPERVISOR = read('server/src/supervisor.ts');
const APP_JS = read('server/public/app.js');
const APP_HTML = read('server/public/index.html');

/* ═══════════════════════════════════════════════════════════
   ① 桌面端登录界面：忘记密码入口
   ═══════════════════════════════════════════════════════════ */

test('★★★ 登录界面必须有「忘记密码？」入口（否则忘了密码的人无路可走）', () => {
  assert.match(LOGIN, /'忘记密码？'/, '缺「忘记密码？」按钮文案');
  assert.match(LOGIN, /auth-reset-entry/, '缺 data-role（判据要靠它定位）');
  assert.match(LOGIN, /toggleResetMode/, '缺模式切换');
});

test('★★★ 重置模式必须收齐 uid / 临时密码 / 新密码三项', () => {
  for (const role of ['auth-reset-uid', 'auth-reset-code', 'auth-reset-new-password']) {
    assert.match(LOGIN, new RegExp(role), `缺 ${role}`);
  }
  assert.match(LOGIN, /resetPasswordWithTicket/, '必须真的调 API，不能只画表单');
});

test('★★★ 重置走免鉴权端点，且不要求 access token', () => {
  const fn = bodyOf(AUTH_CLIENT, 'export async function resetPasswordWithTicket');
  assert.notEqual(fn, '', '找不到 resetPasswordWithTicket');
  assert.match(fn, /\/api\/auth\/reset-password/, '路径不对');
  /* 这条不发令牌 —— 拿 tokenRequest 会一直报"令牌不完整" */
  assert.ok(!/tokenRequest\(/.test(fn), '不该走 tokenRequest（它断言必须有 access+refresh）');
  assert.ok(!/Authorization/.test(fn), '不该带 Authorization 头');
});

test('★★ 重置成功后要回填用户名，省得用户再想一次', () => {
  const fn = bodyOf(LOGIN, 'private async submitReset');
  assert.notEqual(fn, '', '找不到 submitReset');
  assert.match(fn, /this\.usernameInput\.value = result\.username/, '应回填用户名');
  assert.match(fn, /this\.setMode\('login'\)/, '成功后应切回登录态');
});

/* ═══════════════════════════════════════════════════════════
   ② 桌面端账户区：UID + 复制 + 保存提示
   ═══════════════════════════════════════════════════════════ */

test('★★★ 桌面端账户区必须显示 UID 且有复制按钮', () => {
  assert.match(REPO_DIALOG, /dataset\['role'\] = 'account-uid'/, '缺 uid 展示');
  assert.match(REPO_DIALOG, /dataset\['role'\] = 'account-uid-copy'/, '缺复制按钮');
  assert.match(REPO_DIALOG, /复制 UID/, '按钮文案要写清复制的是什么');
  assert.match(REPO_DIALOG, /private async copyUid/, '缺复制实现');
});

test('★★★ UID 提示文案必须说「紧急情况下要用 UID」', () => {
  /*
   * 用户点名要的这句。它的作用不是解释功能，而是让用户**现在就存下来** ——
   * 等真忘了密码，他已经登不进来看这个面板了。
   */
  assert.match(REPO_DIALOG, /请好好保存 UID/, '缺保存提示');
  assert.match(REPO_DIALOG, /紧急情况下/, '要点明"紧急情况"这个场合');
  assert.match(REPO_DIALOG, /找回账号/, '要说清它的用途');
});

test('★★★ 复制失败要给出可执行的下一步（选中 + Ctrl+C）', () => {
  /*
   * 剪贴板权限会被拒（非 https / 无用户手势）。静默失败会让人以为复制成功，
   * 然后把一个空剪贴板当成"已经存好了"。
   */
  const fn = bodyOf(REPO_DIALOG, 'private async copyUid');
  assert.notEqual(fn, '', '找不到 copyUid');
  assert.match(fn, /catch/, '缺失败分支');
  assert.match(fn, /\.select\(\)/, '失败时要帮用户选中');
  assert.match(fn, /Ctrl\+C/, '要告诉他怎么手动复制');
});

test('★★ UID 是只读输入框（可选中、可一键复制）', () => {
  assert.match(REPO_DIALOG, /\.uidInput\.readOnly = true/, 'uid 输入框应为只读');
});

/* ═══════════════════════════════════════════════════════════
   ③ 桌面端自助改名 / 改密码
   ═══════════════════════════════════════════════════════════ */

test('★★★ 桌面端账户区必须有「修改用户名」「修改密码」', () => {
  assert.match(REPO_DIALOG, /'修改用户名…'/, '缺改名按钮');
  assert.match(REPO_DIALOG, /'修改密码…'/, '缺改密码按钮');
  assert.match(REPO_CLIENT, /export async function changeAccountUsername/, '缺改名 API');
  assert.match(REPO_CLIENT, /export async function changeAccountPassword/, '缺改密码 API');
});

test('★★★ 改密码前必须提示「这台设备也要重新登录」', () => {
  const fn = bodyOf(REPO_DIALOG, 'private async changePassword');
  assert.notEqual(fn, '', '找不到 changePassword');
  assert.match(fn, /这台设备也会退出登录|请用新密码重新登录/, '必须在输入前就说清后果');
});

test('★★★ 改密码成功后要回到登录态（会话已被吊销）', () => {
  const fn = bodyOf(REPO_DIALOG, 'private async changePassword');
  assert.match(fn, /onUnauthorized/, '必须通知外壳回登录态');
});

test('★★ 改名必须校验当前密码', () => {
  const fn = bodyOf(REPO_DIALOG, 'private async renameAccount');
  assert.notEqual(fn, '', '找不到 renameAccount');
  assert.match(fn, /当前密码/, '必须要求密码确认');
  assert.match(fn, /onAccountChanged/, '改名后要同步顶栏显示');
});

/* ═══════════════════════════════════════════════════════════
   ④ 服务端：临时密码的设计约束
   ═══════════════════════════════════════════════════════════ */

test('★★★ 临时密码必须存哈希，不存原文', () => {
  assert.match(TICKET, /code_hash/, '缺哈希列');
  assert.match(TICKET, /sha256Hex\(code\)/, '必须对原文做哈希');
  assert.ok(!/code:\s*string;.*\n.*INSERT[\s\S]*input\.code\b/.test(TICKET), '不许把原文写库');
});

test('★★★ 临时密码必须有一次性与过期', () => {
  assert.match(TICKET, /TICKET_TTL_MS/, '缺有效期常量');
  assert.match(TICKET, /used_at/, '缺"已用"标记');
  /* redeem 里必须同时判 used_at 与 expires_at */
  const fn = bodyOf(TICKET, 'redeem(input');
  assert.notEqual(fn, '', '找不到 redeem');
  assert.match(fn, /used_at IS NULL/, '必须排除已用的');
  assert.match(fn, /expires_at > \?/, '必须排除过期的');
});

test('★★★ 生成新票据要作废旧票据（每人同时只有一枚）', () => {
  const fn = bodyOf(TICKET, 'issue(input');
  assert.notEqual(fn, '', '找不到 issue');
  assert.match(fn, /UPDATE password_tickets SET used_at = \?/, '必须作废旧票据（每人同时只有一枚）');
});

test('★★★ 拒绝原因必须合并成一句话（防 uid 枚举）', () => {
  const fn = bodyOf(SERVICE, 'async resetPasswordWithTicket');
  assert.notEqual(fn, '', '找不到 resetPasswordWithTicket');
  assert.match(fn, /TICKET_REJECTED/, '必须用统一那句话');
  /* 不许为了"友好"把 uid 不存在单独说出来 */
  assert.ok(
    !/uid 不存在|该 UID 不存在/.test(fn),
    '不许区分"uid 不存在"与"码错了"——那会变成枚举探针',
  );
});

test('★★★ 重置成功必须吊销该账户全部会话', () => {
  const fn = bodyOf(SERVICE, 'async resetPasswordWithTicket');
  assert.match(fn, /revokeAllForUser/, '改完密码不踢会话是经典漏洞');
});

test('★★★ 自助改密码也必须吊销全部会话（含当前）', () => {
  const fn = bodyOf(SERVICE, 'async changePassword');
  assert.notEqual(fn, '', '找不到 changePassword');
  assert.match(fn, /revokeAllForUser/, '必须全踢');
  assert.match(fn, /新密码不能与当前密码相同/, '要给这句校验');
});

test('★★★ 改密码要校验旧密码', () => {
  const fn = bodyOf(SERVICE, 'async changePassword');
  assert.match(fn, /verifyPassword\(user\.password_hash, input\.currentPassword\)/, '必须验旧密码');
});

test('★★ 改用户名要让 uid 保持不变', () => {
  const fn = bodyOf(SERVICE, 'async changeUsername');
  assert.notEqual(fn, '', '找不到 changeUsername');
  assert.match(fn, /setUsername/, '应走 UserStore.setUsername');
  assert.match(fn, /uid: next\.uid/, '返回值要带 uid（证明它没变）');
});

test('★★★ 重置端点必须在 TokenGate 白名单里', () => {
  /*
   * 漏了这一条的现场表现是"临时密码明明是对的，却回 401 缺少访问令牌" ——
   * 我第一次实现就漏了，是端到端测试抓出来的。
   */
  const app = read('server/src/http/app.ts');
  assert.match(app, /pathname === '\/api\/auth\/reset-password'/, '必须加入免鉴权判定');
});

test('★★★ 重置请求必须用独立的限速维度（不能与登录共用 IP 桶）', () => {
  /*
   * 共用会让"同事登录失败"把正在重置密码的人一起锁掉 ——
   * 而他本来就是忘了密码的那个。
   */
  const limit = read('server/src/auth/login-limit.ts');
  assert.match(limit, /'reset-ip'/, '必须新增 reset-ip 维度');
  assert.match(SERVICE, /state\('reset-ip'/, 'reset 限速要查 reset-ip');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 运维侧：只发临时密码，不直接改
   ═══════════════════════════════════════════════════════════ */

test('★★★ 运维侧必须只提供「临时密码」，不许直接设新密码', () => {
  /*
   * 运维直接设密码 = 运维知道用户的最终密码 = 可长期冒充。
   * 临时密码的意义就是"它会失效且不能登录"。
   */
  assert.match(SUPERVISOR, /control\/accounts\/:id\/temp-password/, '缺临时密码端点');
  assert.ok(
    !/control\/accounts\/:id\/password/.test(SUPERVISOR),
    '不许有"运维直接改密码"的端点',
  );
  assert.ok(
    !/control\/accounts\/:id\/rename/.test(SUPERVISOR),
    '不许有"运维直接改用户名"的端点（用户名让用户自己在客户端改）',
  );
});

test('★★★ 运维生成临时密码必须写审计', () => {
  assert.match(SUPERVISOR, /account\.issue-temp-password/, '缺审计动作');
  assert.match(SUPERVISOR, /actor: 'panel-token'/, '审计要记操作者');
  assert.match(SUPERVISOR, /socketIp/, '审计要记来源');
});

test('★★ 临时密码弹窗必须同时给出 UID（用户两样都要）', () => {
  assert.match(APP_JS, /ticket-uid/, '弹窗缺 uid 字段');
  assert.match(APP_JS, /ticket-code/, '弹窗缺密码字段');
  assert.match(APP_HTML, /复制 UID \+ 临时密码/, 'HTML 里要有"一起复制"按钮');
  /* 拼出来的文本要两行都带标签 —— 只给裸值，粘到聊天里对方分不清哪个是哪个 */
  assert.match(APP_JS, /UID：\$\{uid\}/, '复制的文本要标出哪行是 UID');
  assert.match(APP_JS, /临时密码：\$\{code\}/, '复制的文本要标出哪行是密码');
});

test('★★ 弹窗关闭后必须清掉明文', () => {
  const fn = bodyOf(APP_JS, 'function closeTicketDialog');
  assert.notEqual(fn, '', '找不到 closeTicketDialog');
  assert.match(fn, /\$\('ticket-code'\)\.value = ''/, '关闭要抹掉明文');
});

test('★★ 运维账户表必须能按用户名 / uid 过滤', () => {
  assert.match(APP_HTML, /id="gov-account-filter"/, '缺过滤框');
  assert.match(APP_JS, /function filterGovAccounts/, '缺过滤实现');
  assert.match(APP_JS, /username\.includes\(lower\)/, '要按用户名匹配');
  assert.match(APP_JS, /uid\.includes\(lower\)/, '要按 uid 匹配');
});

test('★★ 过滤无结果时要说清「没有匹配」而不是留空表', () => {
  const fn = bodyOf(APP_JS, 'function setAccountFilterHint');
  assert.notEqual(fn, '', '找不到 setAccountFilterHint');
  assert.match(fn, /没有匹配/, '零结果要有明确文案');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 移动端：本轮刻意不做（挂账）
   ═══════════════════════════════════════════════════════════ */

test('★★ 移动端不该出现账户自助 UI（本轮挂账，别半做）', () => {
  /*
   * 用户 2026-11-25 明令："APP 暂不做相关 UI 和操作，先挂账到 PLAN 里"。
   * 半做（比如只加了按钮没接端点）比不做更糟 —— 用户会以为已经能用。
   */
  const mobileShell = read('client/src/chat/shell.ts');
  assert.ok(
    !/account-uid-copy/.test(mobileShell),
    '移动端不该有 UID 复制（已挂账）',
  );
  assert.ok(
    !/changeAccountPassword/.test(mobileShell),
    '移动端不该有改密码（已挂账）',
  );
  /* 但挂账必须写在 PLAN 里，不能只存在于对话里 */
  const plan = read('PLAN.md');
  assert.match(plan, /移动端账户自助管理/, 'PLAN 里必须有这条挂账');
});
