/**
 * 传输安全面板的**静态契约**（v0.1.3 / F4）。
 *
 * 这一批的"功能正确"由 test/tls-hot-reload.test.mjs（运行时）与
 * scripts/verify-f4-tls.mjs（跨进程）保证。这里补的是它们都盖不到的两类事：
 *
 *   ① **面板与配置摘要的字段契约**。面板是纯 vanilla（没有类型检查），
 *      `$('tls-fingerprint')` 打错一个字不会编译报错，只会静默拿到 null
 *      然后在运行时抛 —— 而那时页面已经渲染了一半。所以这里把
 *      "app.js 里出现的每个 id 都必须在 index.html 里"做成断言。
 *
 *   ② **配置摘要里的 tls 段不能带证书路径**。`configSummary` 会随
 *      `/api/stats` 下发给**任何已鉴权客户端**（含普通用户）；把
 *      `certPath` / `keyPath` 放进去等于把服务端磁盘结构告诉所有人。
 *      面板需要路径，所以它走控制面的 `/control/tls/status`。
 *      这条很容易在"顺手补个字段"时被破坏，所以钉住。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configSummary } from '../server/dist/context.js';
import { normalizeConfig } from '../server/dist/config.js';
import { applyConfigPatch } from '../server/dist/supervisor.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'server/public/index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'server/public/app.js'), 'utf8');

function htmlIds() {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
}

// ══════════════════════════════════════════════════════════
// 1. 面板元素与引用一致性
// ══════════════════════════════════════════════════════════

test('F4 面板：传输安全区块的元素齐全（需求第 1 条逐项）', () => {
  const required = {
    'tls-card': '区块容器',
    'tls-banners': '常驻警告容器',
    'cfg-tls-mode': '三态单选组',
    'cfg-tls-httpsPort': 'HTTPS 端口输入',
    'tls-selfsigned-box': 'selfsigned 分区',
    'tls-fingerprint': 'SHA-256 指纹',
    'tls-days': '剩余天数',
    'tls-regenerate': '重新生成按钮',
    'tls-backup-hint': '备份位置说明',
    'tls-custom-box': 'custom 分区',
    'cfg-tls-certPath': '证书路径输入',
    'cfg-tls-keyPath': '私钥路径输入',
    'tls-check': '匹配校验结果',
    'tls-listen': '监听状态与采样时间',
  };
  const ids = htmlIds();
  const missing = Object.entries(required)
    .filter(([id]) => !ids.has(id))
    .map(([id, what]) => `${id}（${what}）`);
  assert.deepEqual(missing, [], `面板缺少这些元素：${missing.join('、')}`);

  // 三态单选必须正好三个，值也要对
  const values = [...html.matchAll(/name="cfg-tls-mode" value="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values.sort(), ['custom', 'off', 'selfsigned'], `三态单选的值不对：${values.join(',')}`);
});

test('F4 面板：app.js 里引用的每个 id 都在 index.html 中存在', () => {
  const ids = htmlIds();
  const used = [...new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]))];
  assert.ok(used.length > 50, `只解析到 ${String(used.length)} 个 id，正则可能失效了`);
  const missing = used.filter((id) => !ids.has(id));
  assert.deepEqual(
    missing,
    [],
    '以下 id 在 app.js 里被引用但 index.html 里没有（拼错会静默拿到 null 并在运行时抛）：' + missing.join('、'),
  );
});

test('F4 面板：保存按钮的门控与三态分区切换都接在真实函数上', () => {
  // 不是"检查字符串存在"这么弱的判据：这三个函数必须真的被调用，
  // 否则界面上会出现"按钮永远可点""切了模式也不换分区"。
  assert.match(js, /function updateTlsSaveGate\(/, '缺少保存门控函数');
  assert.match(js, /tlsCustomOk !== true/, '门控判据应基于即时校验结果');
  assert.match(js, /function applyTlsModeUi\(/, '缺少分区切换函数');
  assert.match(js, /for \(const input of document\.querySelectorAll\('input\[name="cfg-tls-mode"\]'\)\)/, '缺少三态单选的 change 绑定');

  /*
   * `tlsModeValue` 一个都没选中时必须返回空串（= 不改 mode），而不是 'off'。
   * 否则"表单没回填成功"会变成"保存时把 HTTPS 关掉" —— 一次读取失败就静默降级到明文。
   */
  assert.match(js, /return picked === null \? '' : picked\.value;/, 'tlsModeValue 的兜底必须是空串而不是 off');
});

// ══════════════════════════════════════════════════════════
// 2. 配置摘要的字段契约
// ══════════════════════════════════════════════════════════

function baseConfig() {
  return normalizeConfig({}, {});
}

test('F4 configSummary：下发 mode / httpsPort / customConfigured / plaintext', () => {
  const config = baseConfig();
  config.tls = { mode: 'selfsigned', httpsPort: 9443, certPath: 'C:/secret/a.crt', keyPath: 'C:/secret/a.key' };

  const summary = configSummary(config);
  assert.equal(summary.tls.mode, 'selfsigned');
  assert.equal(summary.tls.httpsPort, 9443);
  assert.equal(summary.tls.customConfigured, true);
  assert.equal(summary.tls.plaintext, false);
});

test('F4 configSummary：**不下发**证书全路径（它会随 /api/stats 给任何已鉴权客户端）', () => {
  const config = baseConfig();
  config.tls = { mode: 'custom', httpsPort: 9443, certPath: 'C:/Users/alice/certs/a.crt', keyPath: 'C:/Users/alice/certs/a.key' };

  const summary = configSummary(config);
  const serialized = JSON.stringify(summary.tls);
  assert.ok(!serialized.includes('alice'), `tls 段里不该出现磁盘路径：${serialized}`);
  assert.ok(!('certPath' in summary.tls), 'certPath 不应出现在 configSummary.tls 里');
  assert.ok(!('keyPath' in summary.tls), 'keyPath 不应出现在 configSummary.tls 里');
  // 面板需要路径 → 它走控制面的 /control/tls/status（那条只有持令牌的管理员能访问）
});

// ══════════════════════════════════════════════════════════
// 3. 配置补丁的 tls 语义
// ══════════════════════════════════════════════════════════

test('F4 配置补丁：字段缺席＝保持原值（只改端口不能把证书路径抹掉）', () => {
  const current = baseConfig();
  current.tls = { mode: 'custom', httpsPort: 8443, certPath: 'D:/certs/a.crt', keyPath: 'D:/certs/a.key' };

  const patched = applyConfigPatch(current, { tls: { httpsPort: 9443 } });
  assert.equal(patched.tls.httpsPort, 9443);
  assert.equal(patched.tls.mode, 'custom', '缺席 mode 时应保持原值，不能回落 off');
  assert.equal(patched.tls.certPath, 'D:/certs/a.crt', '缺席 certPath 时必须保留');
  assert.equal(patched.tls.keyPath, 'D:/certs/a.key');
});

test('F4 配置补丁：非法 mode 保持原值（拼写错误不能把 HTTPS 关掉）', () => {
  const current = baseConfig();
  current.tls = { mode: 'selfsigned', httpsPort: 8443, certPath: '', keyPath: '' };

  const patched = applyConfigPatch(current, { tls: { mode: 'self-signed' } });
  assert.equal(patched.tls.mode, 'selfsigned', `非法 mode 必须保持原值，实际 ${patched.tls.mode}`);
});

test('F4 配置补丁：显式空串可以清空路径（切到 selfsigned 后留空是合法意图）', () => {
  const current = baseConfig();
  current.tls = { mode: 'custom', httpsPort: 8443, certPath: 'D:/certs/a.crt', keyPath: 'D:/certs/a.key' };

  const patched = applyConfigPatch(current, { tls: { mode: 'selfsigned', certPath: '', keyPath: '' } });
  assert.equal(patched.tls.mode, 'selfsigned');
  assert.equal(patched.tls.certPath, '', '显式空串应清空');
  assert.equal(patched.tls.keyPath, '');
});

test('F4 配置补丁：完全没有 tls 字段时不动 tls（老面板/脚本兼容）', () => {
  const current = baseConfig();
  current.tls = { mode: 'selfsigned', httpsPort: 9443, certPath: '', keyPath: '' };

  const patched = applyConfigPatch(current, { port: 9999 });
  assert.equal(patched.port, 9999);
  assert.deepEqual(patched.tls, current.tls, '不带 tls 的补丁不该改动传输安全配置');
});
