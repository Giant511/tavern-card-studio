/**
 * v0.1.9 两项功能的**接线判据**（2026-11-14）。
 *
 * ## 为什么单独一个文件
 *
 * 这两项的主逻辑都已经有独立判据了：
 *
 * ```text
 *   聊天记录 TXT    test/chat-export.test.mjs（13 例，纯函数真跑）
 *   分享三按钮      这里（UI 结构 + 都调同一条路径）
 * ```
 *
 * 剩下的风险**不是算错，而是没接上** —— 本项目最反复的缺陷类型：
 * 「实现存在、函数正确，但没有任何调用点」（§70.3 / §71.2 / §88）。
 * 所以这个文件只钉"接没接"和"文案有没有撒谎"。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readShellImpl, readShellImplNoComments } from './lib/shell-source.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * 去掉注释。
 *
 * 理由见 `test/chat-list-fields.test.mjs` 里那段：修 bug 时把旧代码
 * 贴进注释当说明，`doesNotMatch` 会命中注释 ⇒ 假红；同时 CSS 那边
 * 出现过"读到自己写的注释 ⇒ 假绿"。两个方向都要防。
 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   一、卡片分享的三个按钮
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 三个分享渠道都存在，且走同一个 runShare', () => {
  /*
   * 分开写三套逻辑没有意义，而且将来会漂移成
   * "微信那条忘了加防连点" —— 那种缺陷在真机上表现为
   * "点一次分享弹两个面板"。
   */
  const src = stripComments(read('client/src/chat/character-picker.ts'));

  /*
   * ★ 判据要看**结构**，不是看字面量。
   *
   * 第一版写的是 `new RegExp('picker-share-wechat')` —— 假红，
   * 因为源码是模板 `` `picker-share-${channel.key}` ``，
   * 运行时才拼出 `picker-share-wechat`。
   *
   * 所以钉两件事：三个 key 都在列表里、domain 用模板拼 key。
   * 这样既保证运行时有那三个 data-role，又不锁死写法。
   */
  for (const key of ['wechat', 'qq', 'more']) {
    assert.match(src, new RegExp(`key: '${key}'`), `channels 列表里要有 ${key}`);
  }
  assert.match(src, /picker-share-\$\{channel\.key\}/, 'data-role 要用 key 拼（真机探针靠它定位）');

  /* 三个按钮必须共用同一处理函数，不许各写一遍 */
  assert.match(src, /const runShare = \(/, '要有一个共用的分享处理函数');
  assert.match(src, /runShare\(btn\)/, '三个渠道都调它');
});

test('★★★★★ 小程序按钮明确写"暂不支持"，且不跳转', () => {
  /*
   * 用户 2026-11-09 明令：只做一个入口，按钮写"暂不支持"，
   * 具体实现等小程序编辑器做好再说。
   *
   * 所以判据要同时钉两件事：**文案有这个字**、**点了不发请求**。
   * 只钉文案的话，将来有人"顺手实现"半成品也能通过。
   */
  const src = stripComments(read('client/src/chat/character-picker.ts'));

  assert.match(src, /picker-share-miniapp/, '要有小程序入口');
  assert.match(src, /暂不支持/, '按钮上要写清');

  /*
   * ★★★ 判据必须同时禁**间接调用**（2026-11-14，变异验证抓到的漏判）。
   *
   * 第一版只禁 `onShare`。而把点击处理改成 `runShare(miniApp)` 之后
   * 判据**照样绿** —— 因为 `runShare` 这个标识符里没有 `onShare` 这几个字。
   *
   * 而"复用 runShare"恰恰是最自然的实现方式（谁都不想再写一遍防连点），
   * 也就是说：**最可能发生的退化，正好漏在判据之外**。
   *
   * ⇒ 四个都禁：直调 onShare、复用 runShare、拉原生 shareText、开外链。
   */
  const at = src.indexOf('picker-share-miniapp');
  const end = src.indexOf('actions.append', at);
  const block = src.slice(at, end < 0 ? at + 900 : end);
  assert.doesNotMatch(block, /onShare/, '小程序按钮不许直调分享');
  assert.doesNotMatch(block, /runShare\(/, '也不许复用分享处理函数（这是最容易发生的退化）');
  assert.doesNotMatch(block, /shareText|sharePng/, '不许拉原生分享');
  assert.doesNotMatch(block, /openExternal|window\.open/, '不许跳转');

  /* 但点了必须给反馈 —— 静默无响应等于按钮坏了 */
  assert.match(block, /pullHint\.textContent/, '点了要有一句提示');
});

test('★★★★★ 文案不许承诺"直接发到微信"（走的是系统面板）', () => {
  /*
   * 三个渠道走的都是 `ACTION_SEND` + `createChooser`，不是 SDK 直达。
   * 写"分享到微信"而实际弹系统面板，用户会以为按钮坏了 ——
   * 这属于"文案承诺了做不到的事"，比不写更糟。
   */
  const src = stripComments(read('client/src/chat/character-picker.ts'));

  assert.doesNotMatch(src, /直接发到微信|一键分享到微信/, '不许承诺直达');
  assert.match(src, /系统分享面板/, '要说明会打开系统面板');
});

/* ═══════════════════════════════════════════════════════════
   二、聊天记录导出 TXT
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 导出按钮真的接在聊天文件行上', () => {
  /*
   * 只断言"有 onExport"不够 —— 那是能力存在。要钉的是
   * **按钮被画出来且挂到 tools 上**（"实现了但没接线"的经典形态）。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));

  assert.match(src, /'chat-file-export'/, '要有导出按钮');
  assert.match(src, /tools\.append\(exportBtn\)/, '按钮必须挂到行里（建了不挂 = 用户看不到）');
  assert.match(src, /await exportRun\(file\.id, file\.name\)/, '要真的调回调，并传用户看到的标题');
});

test('★★★★★ shell 真的实现了 onExport（不是留个空壳）', () => {
  const src = readShellImplNoComments();

  assert.match(src, /onExport: async \(id, name\)/, '要有实现');

  const at = src.indexOf('onExport: async');
  const end = src.indexOf('\n      },\n', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  /* 三段链路缺一不可 */
  assert.match(body, /loadChatRaw\(/, '要按 id 现读（不能用面板手上的消息）');
  assert.match(body, /chatToText\(/, '要经过纯函数转换');
  assert.match(body, /shareText\(/, '要起原生分享');
  assert.match(body, /chatExportFileName\(/, '文件名要用用户的标题');
});

test('★★★★★ shareText 必须直接调，不许先赋给变量', () => {
  /*
   * §125：`@JavascriptInterface` 的方法**不许解引用**。
   *
   * ```ts
   *   const f = bridge.shareText;   // ✗ 报 "non-injected object"
   *   f(text, name);
   * ```
   *
   * 现象是"所有导出都失败"，而错误信息完全指不到这里。
   */
  const src = readShellImplNoComments();
  assert.doesNotMatch(
    src,
    /=\s*[^.\n]*\.shareText\s*;/,
    'shareText 不许赋给变量（会让 @JavascriptInterface 失效）',
  );
  assert.match(src, /bridge\.shareText\(/, '要直接调');
});

test('★★★★ 读不出来和空聊天要分开说', () => {
  /*
   * 两者在用户眼里都是"没内容"，但原因完全不同：
   *
   * ```text
   *   读不出来  → 文件损坏 / 引擎没起  ⇒ 要告诉他"读不出"
   *   空聊天    → 确实还没聊          ⇒ 要告诉他"还没有记录"
   * ```
   *
   * 一句"导出成功"盖住两种情况，会让文件损坏的用户以为记录已经导好了。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('onExport: async');
  const end = src.indexOf('\n      },\n', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /读不出来|不在了/, '读失败要有单独的话');
  assert.match(body, /exported\.empty/, '空聊天要单独说');
});

/* ═══════════════════════════════════════════════════════════
   三、原生侧
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ shareText 用 text/plain 且显式 UTF-8', () => {
  /*
   * 两个都会静默出错的点：
   *
   * ```text
   *   类型用 image/png  → 微信当图片解析，一张打不开的图
   *   编码用平台默认    → 少数设备产出 GBK，中文全乱码
   * ```
   *
   * 两者都不会抛异常，只在"用户拿到文件之后"才发现。
   */
  const kt = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StBridge.kt',
  );

  const at = kt.indexOf('fun shareText(');
  assert.ok(at > 0, '要有 shareText');
  const end = kt.indexOf('\n    @JavascriptInterface', at + 10);
  const body = kt.slice(at, end < 0 ? at + 3500 : end);

  assert.match(body, /type = "text\/plain"/, '必须是 text/plain');
  assert.match(body, /Charsets\.UTF_8/, '必须显式 UTF-8');
  assert.match(body, /NEW_TASK/, 'WebView 线程起 Activity 必须 NEW_TASK');
  assert.match(body, /FileProvider/, 'file:// 在 Android 7+ 会抛 FileUriExposedException');
  assert.doesNotMatch(body, /image\/png/, '不许用图片类型');
});
