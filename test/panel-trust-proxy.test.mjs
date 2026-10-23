/**
 * 管理面板的静态守卫（v0.1.2 追加任务）。
 *
 * 只查三件"改错了不会报错、只会静默失效"的事 —— 它们都属于
 * 「页面看起来正常，但功能没生效」这一类，人工看截图也未必发现：
 *
 *   1. **表单里每个新增字段都必须既有回显又有提交**。少了回显会让用户
 *      以为配置丢了；少了提交会让"改了保存"变成静默放弃。
 *      更糟的一种：回显在但提交不在 —— 用户改完保存，看到提示"已保存"，
 *      实际配置没变。`cfg-trustProxy` 就属于这一类新增字段。
 *   2. **`placeholder` 不能长得像真实值**。第一版把示例写成 `127.0.0.1\n10.0.0.0/8`，
 *      截图验收时连我自己都把它当成了已配置的值（用颜色采样才确认是 placeholder）。
 *      既然审核者会误读，用户更会。
 *   3. **`/api/stats` 下发的字段必须有一个渲染出口**（`proxy` → `ov-proxy`）。
 *      下发但没渲染等于白做。
 *
 * 这些都是纯文本断言，不需要浏览器；真实渲染由截图验收覆盖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const HTML = readFileSync(join(ROOT, 'server/public/index.html'), 'utf8');
const APP = readFileSync(join(ROOT, 'server/public/app.js'), 'utf8');

test('trustProxy：表单有输入框、有回显、有提交三处', () => {
  assert.match(HTML, /id="cfg-trustProxy"/, 'index.html 缺输入框');

  // 回显：fillConfigForm 里把配置写进控件
  assert.match(
    APP,
    /\$\('cfg-trustProxy'\)\.value\s*=/,
    'app.js 没有回显 trustProxy（用户会把"没显示"当成"配置丢了"）',
  );

  // 提交：面板保存时把它带进 payload
  assert.match(
    APP,
    /trustProxy:\s*\$\('cfg-trustProxy'\)\.value/,
    'app.js 保存时没带 trustProxy —— 改了保存会显示"已保存"但实际没变',
  );
});

test('trustProxy：placeholder 不像真实值（审核者与用户都会误读）', () => {
  const match = /id="cfg-trustProxy"[^>]*placeholder="([^"]*)"/.exec(HTML);
  assert.ok(match, '找不到 placeholder');
  const placeholder = match[1];

  // 不能以裸 IP 开头 —— 那看起来就是"已经配好了"
  const firstLine = placeholder.split('&#10;')[0];
  assert.ok(
    !/^\s*[\d:[\]]/.test(firstLine),
    `placeholder 第一行不能以 IP 开头（会被当成真实值）：${firstLine}`,
  );
  // 必须明确说出"留空"的语义
  assert.match(placeholder, /留空/, 'placeholder 要说明留空＝不信任任何代理头');
});

test('trustProxy：反代未登记时有可见提示，且提示是条件显示', () => {
  assert.match(HTML, /id="cfg-trustProxy-warn"[^>]*hidden/, '提示默认必须隐藏');
  assert.match(APP, /function updateTrustProxyWarning/, '缺提示逻辑');
  // 判据必须包含"本机打开时不提示"，否则会变成永远为真的噪声
  assert.match(
    APP,
    /updateTrustProxyWarning[\s\S]{0,600}?127\\\./,
    '提示逻辑里应区分"从回环打开"与"经代理打开"',
  );
});

test('/api/stats 的 proxy 字段有渲染出口', () => {
  assert.match(APP, /stats\.proxy/, 'app.js 没读 /api/stats 的 proxy 字段');
  assert.match(HTML, /id="ov-proxy"/, 'index.html 缺「可信代理」展示位');
  // 概览的那一行要能同时表达"没配"与"N 条规则"
  assert.match(APP, /未信任任何代理/, '未配置时要说清楚，不能留空白');
  assert.match(APP, /已生效/, '配置非空时要给出"已生效数"，这才是"配对了没有"的答案');
});
