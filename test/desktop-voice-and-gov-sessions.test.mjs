/**
 * 两件事的判据（2026-11-25 第二批）。
 *
 * ```text
 * ① 桌面端设置里不该有「语音输入」
 * ② 服务端全站管理要有页面入口，不能只靠 URL
 * ```
 *
 * ## ① 为什么这是缺陷而不是"多放一个开关"
 *
 * 桌面客户端**没有语音输入**（录音链路只在移动端）。所以那个
 * 「语音发送前需确认」写的是 `client-config.json` 的 `voiceConfirmBeforeSend`，
 * 而**全库没有任何代码读它** —— 改了不生效，用户会以为"设置坏了"。
 *
 * 移动端生效的是它自己那份（`chat/voice-settings.ts` 的 `confirmBeforeSend`），
 * 与本字段无关。所以桌面那个开关是纯粹的噪音。
 *
 * ## ② 为什么必须有页面
 *
 * 会话管理那 5 个端点（设备列表 / 踢设备 / 退出其它设备 / 强制下线 /
 * 解除锁定）做完后只有 API，用户原话：「全用URL感觉不方便
 * （因为这个是运维界面，一般用户也访问不到）」。
 *
 * 端到端在 `scripts/verify-gov-sessions.mjs`。这个文件守静态形态。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SETTINGS = read('client/src/settings/settings-dialog.ts');
const HTML = read('server/public/index.html');
const APP = read('server/public/app.js');
const CONTRACT = read('client/src/contract/types.ts');

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   ① 桌面端不该有语音输入
   ═══════════════════════════════════════════════════════════ */

test('★★★ 桌面端设置里不许再出现「语音输入」区块', () => {
  /*
   * 用户的判断是对的：「这个安卓端的东西怎么带到桌面端了」。
   * 桌面没有录音链路，那个开关写进去没人读。
   */
  assert.ok(
    !/语音发送前需确认/.test(SETTINGS),
    '桌面设置里不该再有「语音发送前需确认」',
  );
  assert.ok(
    !/form-title',\s*'语音输入'/.test(SETTINGS),
    '桌面设置里不该再有「语音输入」标题',
  );
  assert.ok(
    !/voiceConfirmCheckbox/.test(stripComments(SETTINGS)),
    '不该再有这个字段的引用（否则是删了一半）',
  );
});

test('★★★ 桌面端不许再写 voiceConfirmBeforeSend', () => {
  /*
   * 写进去却没人读 = 死配置。留着它只会让下一个人以为"已经有这个功能了"。
   */
  const code = stripComments(SETTINGS);
  assert.ok(
    !/voiceConfirmBeforeSend/.test(code),
    '桌面设置不该再保存这个字段',
  );
});

test('★★ 契约字段保留，但必须写明"桌面端无对应开关"', () => {
  /*
   * 保留字段是为了兼容已有 client-config.json（里面可能带它），
   * 以及给将来桌面端接入录音留语义。但注释必须说清现状，
   * 否则下一个人又会照着它去做一个界面。
   */
  assert.match(CONTRACT, /voiceConfirmBeforeSend: boolean/, '字段本体要留着（兼容老配置）');
  assert.match(
    CONTRACT,
    /桌面端已无对应开关/,
    '契约注释必须写明桌面端已移除',
  );
});

test('★★ 移动端的语音设置不受影响（那是另一份）', () => {
  /*
   * 删桌面那个开关时**不能**顺手把移动端的删掉 —— 它们字段名不同
   * （`confirmBeforeSend` vs `voiceConfirmBeforeSend`），
   * 但都是"发送前确认"的语义，很容易看错。
   */
  const voiceSettings = read('client/src/chat/voice-settings.ts');
  assert.match(voiceSettings, /confirmBeforeSend/, '移动端语音设置必须还在');
  assert.match(voiceSettings, /DEFAULT_VOICE_SETTINGS/, '默认值要还在');
});

/* ═══════════════════════════════════════════════════════════
   ② 全站管理要有页面
   ═══════════════════════════════════════════════════════════ */

test('★★★ 治理页必须有「登录设备」区块', () => {
  assert.match(HTML, /id="gov-sessions"/, '缺设备列表 tbody');
  assert.match(HTML, /id="gov-sessions-refresh"/, '缺刷新按钮');
  assert.match(HTML, /id="gov-sessions-revoke-others"/, '缺「退出其它设备」');
});

test('★★★ 账户表每行要有「强制下线」与「解除锁定」', () => {
  for (const role of ['gov-account-revoke-sessions', 'gov-account-unlock-login']) {
    assert.match(APP, new RegExp(`gov-account-${role.replace('gov-account-', '')}`), `缺 ${role}`);
  }
  /* 必须真调那两条端点，不能只画按钮 */
  assert.match(APP, /\/revoke-sessions`/, '必须调 revoke-sessions');
  assert.match(APP, /\/unlock-login`/, '必须调 unlock-login');
});

test('★★★ 设备列表要标出「当前设备」，且不给踢自己', () => {
  /*
   * 踢掉自己 = 立刻掉线，而用户点的时候以为在清理别处。
   * 要退出当前设备用「退出治理」。
   */
  assert.match(APP, /item\.current/, '要区分当前设备');
  assert.match(APP, /（当前设备）/, '界面上要写明');
  assert.match(APP, /if \(item\.current\)/, '当前设备不给踢');
});

test('★★ 「退出其它设备」要保留当前会话（不能全踢）', () => {
  /*
   * 端点是 revoke-all，服务端支持 exceptSessionId ——
   * 前端调的必须是不带 id 的那个自助端点（它内部会排除当前会话）。
   * 若前端自己去拼 `/api/accounts/:id/revoke-sessions` 就会把自己也踢掉。
   */
  const fn = /\$\('gov-sessions-revoke-others'\)[\s\S]*?\n  \}\)/.exec(stripComments(APP));
  assert.notEqual(fn, null, '找不到退出其它设备的 handler');
  assert.match(fn[0], /\/api\/account\/sessions\/revoke-all/, '必须用自助端点（它排除当前会话）');
  assert.ok(
    !/\/api\/accounts\//.test(fn[0]),
    '不许走管理员强制下线端点（那会把自己也踢掉）',
  );
});

test('★★ 解锁的提示要区分「真解开了」与「本来没锁」', () => {
  /*
   * `cleared` 是实际清掉的条目数，可能是 0。
   * 不说清的话管理员会以为"点了没反应"，然后反复点。
   */
  assert.match(APP, /cleared === 0/, '要判 cleared 为 0 的情况');
  assert.match(APP, /当前没有被锁定/, '要明确说"不需要解除"');
});

test('★★ 解锁一次要清账户 + IP 两维（v0.2.3 修正）', () => {
  /*
   * 服务端 `check()` 是"任一维度被锁即拒"，五次失败两个维度都会锁上。
   * 面板只清账户时，用户重试仍被 IP 挡住，管理员看到的就是「解除锁定无效」。
   * 所以响应多了 clearedIps，toast 也要把它说出来。
   *
   * remainingIpHint 已随旧行为删除；若它又出现在 app.js，说明有人把
   * "只解账户"那套悄悄加回来了。
   */
  const code = stripComments(APP);
  const start = code.indexOf("gov-account-unlock-login");
  assert.notEqual(start, -1, '找不到解锁按钮的绑定');
  const handler = code.slice(start, code.indexOf('action.append(unlockButton)', start));
  assert.ok(handler.length > 0, '找不到解锁 handler 主体');
  assert.match(handler, /clearedIps/, 'toast 要报清掉的 IP 记录数');
  assert.match(handler, /clearedAccount|cleared\b/, 'toast 要报总数/账户维度');
  assert.ok(
    !/remainingIpHint/.test(code),
    'remainingIpHint 已删除；再出现说明回退成"只解账户"',
  );
});

test('★★ 页面上要说明改密码的效果（避免逐个踢）', () => {
  assert.match(HTML, /改密码后所有设备都会失效/, '要写明改密码的效果');
});

test('★★ UA 要翻成人话（原样显示只能看到前半截）', () => {
  const fn = /function describeUserAgent\(ua\)[\s\S]*?\n  \}/.exec(stripComments(APP));
  assert.notEqual(fn, null, '找不到 describeUserAgent');
  assert.match(fn[0], /未知设备/, '空 UA 要有兜底');
  assert.match(fn[0], /Android/, '要能认 Android');
  assert.match(fn[0], /Windows/, '要能认 Windows');
});
