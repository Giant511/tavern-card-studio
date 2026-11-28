/**
 * 管理面板总览的两件事：统计口径 + 免密登录。
 *
 * ## 这两条抓的是什么
 *
 * ```text
 * ① 总览的数字必须是**全站**的，不能按登录身份过滤
 * ② 「记住此设备」的凭证必须落在 localStorage（sessionStorage 过不了新标签页）
 * ```
 *
 * ## 为什么还要静态判据（不是已经有端到端了吗）
 *
 * 端到端要起服务 + 浏览器，几十秒，跑不进 `npm test` 的每次回归。
 * 而这两条恰恰是"改回去不会报错"的那类：换成 `/api/stats` 页面照样渲染，
 * 只是数字悄悄变成"我自己那一片"。静态判据便宜，能在每次回归里守住。
 *
 * 端到端在 `scripts/verify-panel-overview.mjs`（18 条，含两个阴性对照）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const APP = readFileSync(join(ROOT, 'server/public/app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'server/public/index.html'), 'utf8');
const SUPERVISOR = readFileSync(join(ROOT, 'server/src/supervisor.ts'), 'utf8');

/** 去掉注释，避免解释规则的文字被当成代码（这个仓库踩过多次） */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const APP_CODE = stripComments(APP);

/* ═══════════════════════════════════════════════════════════
   ① 总览统计是全站的
   ═══════════════════════════════════════════════════════════ */

test('★★★ 总览统计必须走 /control/stats（不是按凭证过滤的 /api/stats）', () => {
  /*
   * `/api/stats` 会 `scopeFromIdentity` 过滤 —— 那是客户端的正确语义。
   * 面板是运维视图，用它得到的是"我这个账号有几张卡"，
   * 用户已经报过这个问题：「不会是显示的已登录账号的情况吧」。
   */
  const fn = /async function refreshStats\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 refreshStats');
  assert.match(fn[0], /api\('\/control\/stats'\)/, 'refreshStats 必须调 /control/stats');
  assert.ok(
    !/api\('\/api\/stats'\)/.test(fn[0]),
    'refreshStats 里不许再出现 /api/stats：那是按凭证过滤的',
  );
});

test('★★★ 控制面必须有 /control/stats，且直接读库', () => {
  /*
   * 走 worker 的话「服务停了」就看不到数据 —— 而那正是运维最需要看的时候。
   * 与 `/control/accounts` 同一个理由。
   */
  const route = /router\.get\('\/control\/stats'[\s\S]*?\n  \}\)/.exec(SUPERVISOR);
  assert.notEqual(route, null, 'supervisor 缺 /control/stats');
  assert.match(route[0], /withDb\(/, '必须直接读库（不依赖 worker 是否在跑）');
  assert.ok(!/proxy\(|controller\.url/.test(route[0]), '不许转发给 worker');
});

test('★★★ 全站统计必须包含账户 / 卡 / 仓库三项', () => {
  const route = /router\.get\('\/control\/stats'[\s\S]*?\n  \}\)/.exec(SUPERVISOR);
  assert.notEqual(route, null, 'supervisor 缺 /control/stats');
  for (const [label, pattern] of [
    ['账户', /FROM users/],
    ['角色卡', /FROM cards/],
    ['仓库', /FROM repos/],
  ]) {
    assert.match(route[0], pattern, `/control/stats 必须统计${label}`);
  }
});

test('★★ 统计必须排除已删除的卡与仓库', () => {
  /*
   * 不排除的话"入库一次删一次"会让数字永远只增不减，
   * 运维看到的是"历史累计"而不是"现在有多少"。
   */
  const route = /router\.get\('\/control\/stats'[\s\S]*?\n  \}\)/.exec(SUPERVISOR);
  assert.match(route[0], /FROM cards WHERE deleted_at IS NULL/, '角色卡要排除已删除');
  assert.match(route[0], /FROM repos WHERE deleted_at IS NULL/, '仓库要排除已删除');
});

test('★★ 总览页必须写明"全站"口径，且六张卡都在', () => {
  for (const id of ['stat-accounts', 'stat-cards', 'stat-repos', 'stat-versions', 'stat-bytes', 'stat-uptime']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `总览缺 ${id}`);
  }
  assert.match(HTML, /id="stat-scope"/, '缺口径说明');
  assert.match(HTML, /全站/, '口径说明要写明是全站');
});

test('★★ 读不到统计时不许显示 0', () => {
  /*
   * 「0 张卡」和「读不到」在运维眼里是完全不同的两件事。
   * 把后者显示成前者会让人以为数据丢了。
   */
  const fn = /async function refreshStats\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.match(fn[0], /catch[\s\S]*?'—'/, '失败分支要显示「—」');
});

test('★★★ worker 停着也要显示统计（不能整块抹掉）', () => {
  /*
   * 旧实现是 `if (running) void refreshStats(); else { 全抹成 — }`。
   * 服务停掉时运维更该知道"我手上有多少数据"。
   */
  const render = /function renderStatus\(status\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(render, null, '找不到 renderStatus');
  assert.match(render[0], /refreshStats\(\)/, 'renderStatus 必须无条件拉全站统计');
  assert.ok(
    !/else \{\s*\$\('stat-cards'\)\.textContent = '—';/.test(render[0]),
    '不许在 worker 停掉时把统计整块抹成「—」',
  );
});

/* ═══════════════════════════════════════════════════════════
   ② 免密登录
   ═══════════════════════════════════════════════════════════ */

test('★★★ 勾选「记住」时必须写 localStorage', () => {
  const fn = /function storeToken\(token, remember\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 storeToken');
  assert.match(fn[0], /localStorage\.setItem\(TOKEN_KEY/, '勾选分支要写 localStorage');
  assert.match(fn[0], /sessionStorage\.setItem/, '不勾分支要写 sessionStorage');
  /*
   * 两个都写会让"不勾"也变成永久的 —— 用户以为选了「本次有效」，
   * 实际关掉浏览器还在。
   */
  assert.match(fn[0], /removeItem/, '另一份必须清掉，否则勾选状态形同虚设');
});

test('★★★ 启动时必须同时读两处存储', () => {
  const fn = /function readStoredToken\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 readStoredToken');
  assert.match(fn[0], /localStorage\.getItem/, '要读 localStorage');
  assert.match(fn[0], /sessionStorage\.getItem/, '要读 sessionStorage');
  assert.match(APP_CODE, /state\.token = readStoredToken\(\)/, '启动分支必须用 readStoredToken');
});

test('★★★ 治理页免密必须用 refresh token，不是存密码', () => {
  /*
   * 存密码自动重登是最差的做法：密码落盘 + 无法撤销。
   * refresh token 服务端可吊销（踢设备 / 改密码即失效），换来的 access 是短效的。
   */
  const fn = /function saveGovRemember\(refreshToken, user\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 saveGovRemember');
  assert.match(fn[0], /GOV_REMEMBER_KEY/, '要写专属的 key');
  assert.match(fn[0], /until:/, '要记到期时间');
  assert.ok(!/password/i.test(fn[0]), '不许把密码写进去');
});

test('★★★ 免密必须能过期（7 天）', () => {
  assert.match(APP_CODE, /GOV_REMEMBER_DAYS = 7/, '必须是 7 天（用户明确要求）');
  const fn = /function readGovRemember\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.match(fn[0], /Date\.now\(\) >= parsed\.until/, '过期必须判掉');
  assert.match(fn[0], /removeItem/, '过期的记录要就地清掉');
});

test('★★★ refresh 之后要存回新的 refresh token（服务端会轮换）', () => {
  /*
   * 不存回去的话，本地留的是已作废的那一把 —— 下次续期必然失败，
   * 而症状是"第一次能免密，第二次又要重登"，极难查。
   */
  const fn = /async function govRedeemRemembered\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 govRedeemRemembered');
  assert.match(fn[0], /saveGovRemember\(result\.refreshToken/, '要用响应里的新 refreshToken 覆盖');
});

test('★★★ 续期失败要清掉记录（否则每次进页面都失败一次）', () => {
  const fn = /async function govRedeemRemembered\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.match(fn[0], /catch[\s\S]*?clearGovRemember\(\)/, '失败要清');
});

test('★★ 退出治理必须清掉免密记录', () => {
  const fn = /function govLogout\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 govLogout');
  assert.match(fn[0], /clearGovRemember\(\)/, '退出就是"这台设备不再免密"');
});

test('★★ 两个登录框都有勾选框，且默认勾选', () => {
  assert.match(HTML, /id="login-remember"[^>]*checked/, '面板令牌要勾选框且默认勾选');
  assert.match(HTML, /id="gov-remember"[^>]*checked/, '治理账户要勾选框且默认勾选');
  assert.match(HTML, /7 天/, '文案要写明 7 天');
});

test('★★ 令牌轮换后按当前勾选状态写回', () => {
  /*
   * 轮换写死 localStorage 的话，一个"没勾记住"的用户点一次轮换
   * 就变成永久免密了 —— 与他刚才的选择相反。
   */
  const fn = /\$\('token-rotate'\)[\s\S]*?\n  \}\)/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到轮换 handler');
  assert.match(fn[0], /storeToken\(result\.token, \$\('login-remember'\)\.checked\)/, '要按勾选状态写回');
});

test('★★ 退出面板要清两处存储', () => {
  const fn = /function clearStoredToken\(\)[\s\S]*?\n  \}/.exec(APP_CODE);
  assert.notEqual(fn, null, '找不到 clearStoredToken');
  assert.match(fn[0], /localStorage\.removeItem/);
  assert.match(fn[0], /sessionStorage\.removeItem/);
});
