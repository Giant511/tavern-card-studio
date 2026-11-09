/**
 * 仓库：网络请求不许阻塞 UI / 登录态必须互斥（2026-11-05）。
 *
 * ## 用户报的两条
 *
 * > 1、不管怎么切，在已登录过服务端的情况下，如果服务器连不上的情况下
 * >    点到仓库后会卡很久而且卡的时候不能对APP做任何操作包括切底部tab，
 * >    这个是不能阻塞的，你可以在页面提示登录中或者别的什么。
 * > 2、在登录任意一个仓库类型的服务端时，互相切换仓库类型会卡很久，
 * >    而且还有一个很危险的问题就是自定义和云仓库可以同时登录。
 *
 * ## 问题一：同步桥冻结 JS 线程
 *
 * `StBridge.httpRequest` 是同步的（`(String) -> String`）。虽然它跑在
 * JavaBridge 线程，但 **JS 侧调它是同步等待** —— WebView 的 JS 执行线程
 * 停在这句上，直到 Kotlin 返回。`connectTimeout = 15_000` 意味着
 * 服务端连不上时整个 App 冻 15 秒。
 *
 * 所以：原生必须有 `httpRequestAsync`，前端**只准用它**。
 *
 * ## 2026-11-06 追加：桥方法解引用 = 全部请求失败
 *
 * 异步化之后又踩了一个更隐蔽的坑（见下面那条 ★★★★★ 的注释）：
 * `const f = port.httpRequestAsync; f(...)` 会丢 `this`，
 * WebView 抛 `Java bridge method can't be invoked on a non-injected object`。
 * 那个错误被包装成「无法连接服务端」，于是**所有服务器都"连不上"** ——
 * 用户报「我用内置云的账号也提示无法连接服务器」就是这个。
 *
 * ## 问题二：两套凭据并存
 *
 * 真机录屏：内置云仓库「已登录：Gez」、切到自定义仓库「已登录：testuser」、
 * 再切回去 Gez 还在 —— 两个账号同时在线，切过去还拿错 token。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释：解释文字里会写到被禁的写法，不剥就是自己骗自己 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const nativeFetchSrc = stripComments(read('client/src/chat/native-fetch.ts'));
const repoStoreSrc = stripComments(read('client/src/chat/repo-store.ts'));
const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const repoPageSrc = stripComments(read('client/src/chat/repo-page.ts'));
const bridgeKt = read(
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
);
const mainActivity = read(
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt',
);

/* ═══════════════════════════════════════════════════════════
   一、网络请求不许冻结 JS 线程
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 原生必须有异步 HTTP 方法（同步的会冻住整个 App）', () => {
  assert.match(
    bridgeKt,
    /fun httpRequestAsync\s*\(\s*specJson:\s*String\s*,\s*requestId:\s*String\s*\)/,
    '要有 httpRequestAsync(specJson, requestId)',
  );
  /* 必须是 @JavascriptInterface，否则页面调不到 */
  const at = bridgeKt.indexOf('fun httpRequestAsync');
  const above = bridgeKt.slice(Math.max(0, at - 200), at);
  assert.match(above, /@JavascriptInterface/, 'httpRequestAsync 必须暴露给 JS');
  /* 必须开新线程，不能在调用线程里干活 */
  assert.match(bridgeKt, /Thread\(\s*\{/, '要开后台线程（HttpURLConnection 是阻塞 API）');
});

test('★★★★ 异步方法必须真的回传结果（否则前端永远在等）', () => {
  /*
   * 三步缺一不可：
   *   ① Kotlin 完成时调 `deliver(script)`
   *   ② script 调 `window.__TCS_HTTP__(requestId, reply)`
   *   ③ MainActivity 提供 deliver（`webView.evaluateJavascript`）
   */
  assert.match(bridgeKt, /deliver\s*\(/, 'Kotlin 要调 deliver 回传');
  assert.match(bridgeKt, /__TCS_HTTP__/, '回传脚本要调 window.__TCS_HTTP__');
  assert.match(bridgeKt, /JSONObject\.quote\(requestId\)/, 'requestId 要转义（防注入）');
  assert.match(
    mainActivity,
    /StBridge\(applicationContext\)\s*\{\s*script\s*->/,
    'MainActivity 要传入 deliver 闭包',
  );
  assert.match(mainActivity, /evaluateJavascript\(script/, 'deliver 要走 evaluateJavascript');
  assert.match(mainActivity, /webView\.post\s*\{/, 'evaluateJavascript 必须在 WebView 线程（post）');
});

test('★★★★ 前端只准用异步通道（同步那条会卡 15 秒）', () => {
  /*
   * `callBridge()` 里允许**退路**（老 APK 没有异步方法时退回同步），
   * 但主路径必须是 `httpRequestAsync`。
   */
  const fetchAt = nativeFetchSrc.indexOf('export async function nativeFetch');
  assert.ok(fetchAt > 0, '找不到 nativeFetch');
  const body = nativeFetchSrc.slice(fetchAt);

  assert.doesNotMatch(
    body,
    /\.httpRequest\s*\(/,
    'nativeFetch 不许直接调同步 httpRequest（会冻 JS 线程）',
  );
  assert.match(body, /await callBridge\(/, '要走 callBridge（内部是异步）');
});

test('★★★ 异步通道要有超时兜底（原生回传丢了不能让页面永远转圈）', () => {
  assert.match(nativeFetchSrc, /setTimeout\(/, '要有 JS 侧超时');
  assert.match(nativeFetchSrc, /pendingReplies\.delete\(requestId\)/, '超时要清掉挂起的回调');
  assert.match(nativeFetchSrc, /clearTimeout\(/, '回传到了要清掉定时器');
});

test('★★★★★ 桥方法必须写在注入对象上调用（不许解引用）', () => {
  /*
   * ## 2026-11-06 真机全功能故障的根因
   *
   * ```text
   *   const asyncCall = port.httpRequestAsync;
   *   asyncCall(spec, id);
   *     => Error: Java bridge method can't be invoked on a non-injected object
   *
   *   port.httpRequestAsync(spec, id);
   *     => 正常
   * ```
   *
   * WebView 的 `@JavascriptInterface` 方法靠 `this` 判断调用者是不是那个
   * **注入对象**。解引用后 `this` 是 undefined，WebView 直接拒。
   *
   * ## 为什么这个坑特别贵
   *
   * 错误被下层包装成「无法连接服务端」，于是表现为**所有请求都失败、
   * 与服务器是否可达无关**。用户报告：
   *
   * > 现在连正常可通的服务端提示无法连接服务器
   * > 我用内置云的账号也提示无法连接服务器
   *
   * 排查时我去查网络（设备在 4G、内网确实不通）、查服务端（curl 返回 401
   * 正常）、用原生通道直连内置云（2.5 秒拿到 401）—— **全都正常**。
   * 真正的问题是客户端根本没把请求发出去，而且耗时只有 405ms（不是超时）。
   */
  assert.doesNotMatch(
    nativeFetchSrc,
    /(?:const|let|var)\s+\w+\s*=\s*\w+\.httpRequest(?:Async)?\b/,
    '不许把桥方法赋值给变量（会丢 this => 所有请求报无法连接服务端）',
  );

  /* 正向：必须真的在注入对象上调用（允许 ?. 可选调用符） */
  assert.match(
    nativeFetchSrc,
    /port\.httpRequestAsync\??\.\(/,
    '异步调用要写成 port.httpRequestAsync(...)',
  );

  /*
   * 不按花括号切块：那几行里有类型标注 `{ __ST_ENGINE__?: HttpBridge }`，
   * 第一个 `}` 是类型闭合，不是函数结束（第一版判据就这么看错了块）。
   */
  assert.ok(nativeFetchSrc.includes('function bridge('), '找不到 bridge()');
  assert.match(
    nativeFetchSrc,
    /return raw;/,
    'bridge() 要原样返回注入对象（不许展开/拷贝，否则 this 又丢）',
  );
});

test('★★★ 桥调用失败要保留原始错误（否则会被当成网络问题）', () => {
  /*
   * 「无法连接服务端」这个文案在两种完全不同的情况下出现：
   *
   * ```text
   *   网络真不通      => 用户去查 WiFi / 地址 / 服务端
   *   桥调用就失败    => 上面那些全是白费，问题在客户端
   * ```
   *
   * 所以 `callBridge` 的 catch 要把原始错误**原样抛**（由 `nativeFetch` 的
   * catch 包成 `网络请求失败：<原文>`）—— 于是
   * "Java bridge method can't be invoked" 会出现在提示里，
   * 一眼能看出不是网络问题。
   */
  assert.match(
    nativeFetchSrc,
    /reject\(error instanceof Error \? error : new TypeError\(String\(error\)\)\)/,
    '桥调用的异常要原样抛，不许换成固定文案',
  );
});

test('★★★ 并发请求靠 id 对上，不靠顺序', () => {
  assert.match(nativeFetchSrc, /replySeq \+= 1/, '要自增序号');
  assert.match(nativeFetchSrc, /pendingReplies\.set\(requestId,/, '按 id 存回调');
  /* 重复注册会把在途请求的回调冲掉 */
  assert.match(nativeFetchSrc, /if \(host\.__TCS_HTTP__ !== undefined\) return;/, '回调只注册一次');
});

test('★★★ 回传的第二个参数要按**对象**接（不是字符串）', () => {
  /*
   * 原生回传的脚本是：
   *
   * ```js
   *   window.__TCS_HTTP__ && window.__TCS_HTTP__("r1", {"ok":true,"status":200,…})
   * ```
   *
   * 那个 JSON 字面量在 `evaluateJavascript` 里**被当成 JS 对象**求值 ——
   * 回调收到的是 `Object`。
   *
   * 真机上撞到过：第一版直接 `JSON.parse(raw)`，报 `[object Object]`，
   * 而请求其实成功了 —— 于是"网络全挂"的假象，查半天才发现是解包错。
   */
  assert.match(
    nativeFetchSrc,
    /typeof raw === 'string' \? raw : JSON\.stringify\(raw\)/,
    '两种形态都要接：字符串原样用，对象先 stringify',
  );
});

/* ═══════════════════════════════════════════════════════════
   一·补：超时与等待反馈（2026-11-06）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 连接超时必须短于读取超时（连不上不该等满全长）', () => {
  /*
   * 真机实测（地址写错）：`connectTimeout = 15s` ⇒ **15043ms** 才报错。
   *
   * 那 15 秒 UI 是流畅的（898 帧 / 15 秒 = 60fps，不冻结），但用户盯着
   * 一个按钮看 15 秒，体验上就是"卡"。
   *
   * 两件事的时间尺度差一个数量级：
   *
   * ```text
   *   建立连接   内网 1～20ms，公网 100～2000ms  => 8 秒不通就是不通
   *   等首字节   慢服务器可能要十几秒            => 给 15 秒
   * ```
   *
   * 写成一个值就是"用最坏情况的时长套最确定的事情"。
   */
  assert.match(
    bridgeKt,
    /connection\.connectTimeout\s*=\s*spec\.optInt\(\s*"connectTimeoutMs"/,
    'connectTimeout 要读 connectTimeoutMs（独立参数）',
  );
  assert.match(
    bridgeKt,
    /connection\.readTimeout\s*=\s*spec\.optInt\(\s*"timeoutMs"/,
    'readTimeout 读 timeoutMs',
  );

  /* 前端要真的传这个更短的值 */
  const connect = /connectTimeoutMs:\s*(\d+)/.exec(nativeFetchSrc);
  const readTimeout = /timeoutMs:\s*(\d+)/.exec(nativeFetchSrc);
  assert.ok(connect !== null, 'nativeFetch 要传 connectTimeoutMs');
  assert.ok(readTimeout !== null, 'nativeFetch 要传 timeoutMs');
  assert.ok(
    Number(connect[1]) < Number(readTimeout[1]),
    `连接超时（${connect[1]}ms）必须小于读取超时（${readTimeout[1]}ms）`,
  );
});

test('★★★ 登录按钮忙碌时必须有文字反馈（不许只是变灰）', () => {
  /*
   * 原来忙碌时只 `disabled`，文字一直停在「登录」—— 用户点完看到一颗
   * 灰按钮，内容**完全不变**，要盯十几秒才知道在干什么。
   *
   * 那十几秒里用户会反复点、会以为卡死、会去查网络。
   * **静默的等待比慢更难受。**
   */
  assert.match(
    repoPageSrc,
    /loginBtn\.textContent\s*=\s*'连接服务端中…'/,
    '忙碌时按钮要说"连接服务端中…"',
  );
  /*
   * 复位：只复位 disabled 不复位文字，按钮会永久停在「连接服务端中…」。
   */
  assert.match(repoPageSrc, /loginBtn\.textContent\s*=\s*original/, '结束后要把文字复位');
  assert.match(repoPageSrc, /const original\s*=\s*loginBtn\.textContent/, '先记下原文字');
});

/* ═══════════════════════════════════════════════════════════
   二、登录态互斥（不许两个仓库同时在线）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 登录任一处就清掉其它 origin（不许同时在线）', () => {
  const at = repoStoreSrc.indexOf('export async function writeRepoAuth');
  assert.ok(at > 0, '找不到 writeRepoAuth');
  const body = repoStoreSrc.slice(
    at,
    repoStoreSrc.indexOf('export async function clearRepoAuth', at),
  );

  /*
   * 判据钉的是"写完只剩一条"，不是具体写法：
   * 必须有删掉非本 origin 的循环。
   */
  assert.match(body, /for \(const key of Object\.keys\(map\)\)/, '要遍历并清掉其它 origin');
  assert.match(body, /key !== origin/, '只保留当前 origin');
  assert.match(body, /delete map\[key\]/, '要真的删');
});

test('★★★★ 切换仓库类型 = 登出旧服务端，并且要说一声', () => {
  const at = shellSrc.indexOf('private async saveRepoConfig');
  assert.ok(at > 0, '找不到 saveRepoConfig');
  const body = shellSrc.slice(at, at + 4200);

  /* 必须清旧凭据 */
  assert.match(body, /await clearRepoAuth\(/, '切换时要清掉旧登录态');
  /*
   * 不许再"存进旧槽" —— 那正是"切回来还是登录着"的成因。
   */
  assert.doesNotMatch(
    body,
    /writeRepoAuth\(beforeOrigin/,
    '不许再把旧登录态存进旧 origin 槽（会变成两套并存）',
  );
  /* 用户要知道自己被动登出了 */
  assert.match(body, /onNotify\?\.\(/, '切换导致登出要提示用户');
});

test('★★★ 老键兜底不许绕过互斥（表非空时忽略老键）', () => {
  /*
   * `LS_AUTH` 是"还没按 origin 分表"那个年代的遗留单份凭据。
   * 上一版只要它存在就返回 —— 于是"表里存着 A、切到 B"时，
   * B 会把 A 的老键值当自己的登录态，**互斥被绕过**。
   *
   * 现在只在整张表为空时才兜底（真正的老版本升级场景）。
   */
  const at = repoStoreSrc.indexOf('export function readRepoAuthFor');
  assert.ok(at > 0, '找不到 readRepoAuthFor');
  const body = repoStoreSrc.slice(
    at,
    repoStoreSrc.indexOf('export async function writeRepoAuth', at),
  );

  assert.match(body, /Object\.keys\(map\)\.length === 0/, '老键只在表为空时才读');
});

test('★★★ 仓库页在连不上时必须能操作 Tab（页面自己转圈，不锁全局）', () => {
  /*
   * 页面级 loading 是允许的（"正在读取…"），但**不许**有全屏遮罩把
   * 底部 Tab 一起盖住 —— 那种锁法在服务端挂掉时等于 App 变砖。
   */
  assert.doesNotMatch(
    repoPageSrc,
    /nb-overlay|position:\s*fixed[\s\S]{0,80}inset:\s*0[\s\S]{0,80}disabled/,
    '仓库页不许用全屏遮罩锁住界面',
  );
  /* 有这个提示就行 */
  assert.match(repoPageSrc, /正在读取/, '卡片区要有"正在读取"之类的占位');
});
