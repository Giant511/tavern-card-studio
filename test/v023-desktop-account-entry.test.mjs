/**
 * v0.2.3 桌面端账户入口与改资料弹窗（2026-11-27）。
 *
 * 覆盖四件用户可感知的事：
 *
 *   1. 工具栏第 4 位多了「仓库与令牌…」，原来的账户入口不动（用户明确要求）。
 *   2. 桌面壳屏蔽 WebView 右键菜单与 Ctrl+P，移动端入口不受影响。
 *   3. 改名 / 改密码走模态框：一次提交、掩码开关、框内报错，不再用 window.prompt。
 *   4. 临时密码重置成功后不再留下空的粉色提示框。
 *
 * 这些都是"接线有没有接上"的问题，静态判据比启动 WebView 便宜，也足以
 * 防止后续重构把按钮删掉、把拦截器挪走。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8');

const HTML = read('client/index.html');
const APP = read('client/src/editor/app.ts');
const WIRING = read('client/src/editor/wiring.ts');
const REPO_DIALOG = read('client/src/sync/repo-dialog.ts');
const ACCOUNT_DIALOG = read('client/src/sync/account-dialog.ts');
const ACCOUNT_MODAL = read('client/src/sync/account-form-modal.ts');
const LOGIN_DIALOG = read('client/src/auth/login-dialog.ts');

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('★★★ 工具栏第 4 位是「仓库与令牌…」，原来入口还在', () => {
  const saveAt = HTML.indexOf('id="btn-save"');
  const reposAt = HTML.indexOf('id="btn-repos"');
  const exportAt = HTML.indexOf('id="btn-export"');
  assert.ok(saveAt >= 0 && reposAt >= 0 && exportAt >= 0, '三个按钮都要在');
  assert.ok(saveAt < reposAt && reposAt < exportAt, 'btn-repos 必须夹在「另存为」与「导出」之间');
  assert.match(HTML, /id="btn-account"/, '右上角账户入口不许被替换（用户要求保留原入口）');
  assert.match(HTML, /id="btn-settings"/, '设置页入口也要保留');
});

test('★★★ btn-repos 按登录态分流，不画空面板', () => {
  const code = stripComments(WIRING);
  const start = code.indexOf("byId<HTMLButtonElement>('btn-repos')");
  assert.notEqual(start, -1, '找不到 btn-repos 的监听');
  const handler = code.slice(start, start + 900);
  assert.match(handler, /isRepoTokenMode/, '仓库令牌模式下要先说明为什么不能管仓库');
  assert.match(handler, /host\.repoDialog\?\.open\(\)/, '已登录账户要直接开面板');
  assert.match(handler, /host\.openAccountEntry\(\)/, '未登录要走登录/地址入口');
});

test('★★ 改名后顶栏、设置页身份行一起刷新', () => {
  const code = stripComments(WIRING);
  assert.match(code, /onAccountChanged[\s\S]{0,200}?refreshAccountButton/, '顶栏要刷');
  assert.match(code, /onAccountChanged[\s\S]{0,200}?settings\?\.refreshIdentity/, '设置页身份行也要刷');
});

test('★★★ 桌面壳拦右键菜单、Ctrl+P 与非编辑区 Ctrl+A，且只在桌面入口安装', () => {
  const code = stripComments(APP);
  const start = code.indexOf('function installDesktopShellGuards');
  assert.notEqual(start, -1, '缺 installDesktopShellGuards');
  const fn = code.slice(start, code.indexOf('\n}', start) + 2);
  assert.match(fn, /'contextmenu'[\s\S]{0,80}?preventDefault/, '右键菜单要被拦下');
  assert.match(fn, /'keydown'/, 'Ctrl+P 要在 keydown 里拦');
  assert.match(fn, /toLowerCase\(\)/, '按键先归一化再比较');
  assert.match(fn, /key === 'p'/, '只拦 P 键');
  assert.match(fn, /addEventListener\('contextmenu'[\s\S]{0,100},\s*true\)/, '右键监听要用捕获阶段，先于页面处理器');
  assert.match(code, /async function boot\(\)[\s\S]{0,120}?installDesktopShellGuards\(\)/, 'boot 第一行就要装');

  // 非编辑区 Ctrl+A 不许把整页文字选蓝；输入框与 CodeMirror 必须放行。
  assert.match(code, /function isEditableTarget\(/, '缺可编辑焦点判断');
  assert.match(code, /isEditableTarget[\s\S]{0,400}?isContentEditable/, 'CodeMirror 等 contenteditable 要算可编辑');
  assert.match(code, /isEditableTarget[\s\S]{0,500}?'INPUT'[\s\S]{0,120}?'TEXTAREA'/, 'input/textarea 要算可编辑');
  assert.match(fn, /key === 'a'[\s\S]{0,80}?!isEditableTarget\(event\.target\)/, '非编辑区 Ctrl+A 要拦');
  assert.match(fn, /!isEditableTarget\(event\.target\)[\s\S]{0,120}?preventDefault/, '拦下后要 preventDefault');
});

test('★★★★ 改密码是模态框：一次提交、掩码开关、框内报错', () => {
  const dialog = stripComments(ACCOUNT_DIALOG);
  const start = dialog.indexOf('private async changePassword');
  assert.notEqual(start, -1, '找不到 changePassword');
  const fn = dialog.slice(start, dialog.indexOf('\n  }', start));
  assert.doesNotMatch(fn, /window\.prompt/, '不许再用串行 prompt');
  assert.match(fn, /new AccountFormModal/, '要用账户表单弹窗');
  assert.match(fn, /confirmOf: 'newPassword'/, '新密码要有二次确认');
  assert.match(fn, /field: 'currentPassword'/, '403 要挂在当前密码这一项下面');
  assert.match(fn, /onUnauthorized/, '改完密码必须让外壳回登录态');

  assert.match(ACCOUNT_MODAL, /type === 'password'/, '要为密码框加明文开关');
  assert.match(ACCOUNT_MODAL, /aria-pressed/, '开关要维护 aria-pressed');
  assert.match(ACCOUNT_MODAL, /'显示'[\s\S]{0,120}?'隐藏'/, '按钮文案在显示/隐藏之间切');
});

test('★★★ 改名同样走模态框，不再用 prompt 串行问', () => {
  const dialog = stripComments(ACCOUNT_DIALOG);
  const start = dialog.indexOf('private async renameAccount');
  assert.notEqual(start, -1, '找不到 renameAccount');
  const fn = dialog.slice(start, dialog.indexOf('\n  }', start));
  assert.doesNotMatch(fn, /window\.prompt/, '不许再用串行 prompt');
  assert.match(fn, /new AccountFormModal/);
  assert.match(fn, /onAccountChanged/, '改名后要通知外壳刷新各处名字');
});

test('★★★ 临时密码重置后不留空提示框', () => {
  const code = stripComments(LOGIN_DIALOG);
  assert.doesNotMatch(code, /showError\(''\)/, 'showError(\'\') 会把空盒子显示出来');
  assert.match(code, /showOk\('密码已重置，请用新密码登录。'\)/, '成功提示要写进提示框');
});

test('★★★★ 账户与仓库彻底分家：点用户名进账户面板，第 4 位进仓库面板', () => {
  const app = stripComments(APP);
  const start = app.indexOf('private async openAccountEntry');
  const fn = app.slice(start, app.indexOf('\n  }', start));
  assert.match(fn, /this\.accountDialog\?\.open\(\)/, '已登录必须打开账户面板');
  assert.match(fn, /this\.loginDialog\?\.open\(\)/, '未登录仍要走登录框');
  /* 仓库令牌模式下没有账户身份，仍回卡片列表（那里才有「退出令牌模式」） */

  const wiring = stripComments(WIRING);
  assert.match(wiring, /host\.repoDialog\?\.open\(\)/, '第 4 位按钮仍要进仓库面板');
  assert.match(wiring, /new AccountDialog/, '要构造账户面板');

  const repo = stripComments(REPO_DIALOG);
  assert.doesNotMatch(repo, /account-username|account-sessions|changeAccountPassword/, '仓库面板不许再混入账户区');
  const account = stripComments(ACCOUNT_DIALOG);
  for (const role of ['account-username', 'account-uid', 'account-sessions', 'account-cards', 'account-logout']) {
    assert.ok(account.includes(role), `账户面板缺 ${role}`);
  }
});

test('★★★★ 强制下线：客户端轮询 /me，401 时关掉陈旧面板', () => {
  const wiring = stripComments(WIRING);
  assert.match(wiring, /fetchAccountIdentity/, '要用 /api/auth/me 判断会话是否还有效');
  assert.match(wiring, /setInterval\([\s\S]{0,80}?20_000/, '要有 20 秒轮询');
  assert.match(wiring, /accountDialog\?\.close\(\)[\s\S]{0,80}?repoDialog\?\.close\(\)/, '失效后要收起账户与仓库面板');
});

test('★★★★ 7 天免密：不勾记住时 token 只留内存，刷新即回登录', () => {
  const panel = read('server/public/app.js');
  assert.match(panel, /if \(\$\('gov-remember'\)\.checked\) sessionStorage\.setItem/, '勾选才写 sessionStorage');
  assert.match(panel, /else sessionStorage\.removeItem\(GOV_KEY\)/, '不勾必须把 token 从 sessionStorage 移除');
  /* 登录函数体里不允许无条件写 sessionStorage（续期路径写是正常的） */
  const login = panel.slice(panel.indexOf('async function govLogin'), panel.indexOf('function govLogout'));
  assert.doesNotMatch(login, /govToken = result\.accessToken;\s*\n\s*sessionStorage\.setItem/, '登录后不许无条件写 sessionStorage');
});

test('★★★ CLI 子命令写错：先红字点名，再列可用操作与示例', () => {
  const cli = read('server/src/cli.ts');
  assert.match(cli, /未知的 \$\{prefix\} 操作：\$\{action\}（\$\{names\.join\('\/'\)\}）/, '错误行要带可用子命令');
  assert.match(cli, /process\.stderr\.isTTY[\s\S]{0,80}?\\x1b\[31m/, 'TTY 下用红字');
  assert.match(cli, /可用操作：/, '只报错不够，还要列操作');
  assert.match(cli, /示例：\$\{table\[0\]/, '至少给一条示例');
});

