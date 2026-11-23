/**
 * 「停止生成」入口必须真的能点（v0.2.2 / 2026-11-22）。
 *
 * ## 用户报的现象
 *
 * > 自己断是因为我切了聊天页面主动打断，因为没有任何停止生成的按钮
 *
 * ## 真因不是"没写"，是"被挡住了"
 *
 * `onSendClick` 里本来就有「生成中 = 停止」的分支，但 `syncSendButton`
 * 算的是 `ready = text.trim().length > 0 && !busy`，再 `disabled = !ready` ——
 * 于是生成期间按钮恒为灰色、点不动，那个分支**永远进不去**。
 *
 * 这类"功能写了但入口被另一个条件挡住"用界面截图看不出来（按钮就在那儿），
 * 只有真去点才发现。所以判据必须钉在**代码里那个条件**上，而不是
 * "存在停止功能"这种模糊断言。
 *
 * ## 为什么是静态判据
 *
 * `chat-panel.ts` 依赖 DOM 与原生桥，Node 里起不来。这里读源码断言
 * 结构 —— 与 `android-recents-visible.test.mjs` 同一套做法。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { stripComments } from '../scripts/lib/static-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * ★ 必须先去注释（§1「内容还是表示」）。
 *
 * 第一版直接读原文，于是 `syncSendButton` 里那句
 *
 * ```text
 *   原来是 `const ready = text.trim().length > 0 && !busy`
 * ```
 *
 * **注释**把判据自己顶红了 —— 判据看到的是解释文字，不是代码。
 * `stripComments` 用等量空格替换，行号不变，可以放心用。
 */
const PANEL = stripComments(readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8'));
const CSS = stripComments(readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8'));

/** 取一个方法体（从签名到下一个同级方法），用花括号配平 */
function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `找不到方法：${signature}`);
  let index = source.indexOf('{', start);
  assert.notEqual(index, -1, `方法没有方法体：${signature}`);
  let depth = 0;
  for (let i = index; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(index, i + 1);
    }
  }
  assert.fail(`方法体没闭合：${signature}`);
}

test('① busy 时不许把发送按钮算成"不能点"（旧缺陷的原样）', () => {
  const body = methodBody(PANEL, 'private syncSendButton');
  assert.ok(
    !/const\s+ready\s*=\s*text\.trim\(\)\.length\s*>\s*0\s*&&\s*!busy/.test(body),
    '`ready` 里带上 `!busy` 会让生成中按钮恒为禁用 —— 那正是停止按钮点不动的原因',
  );
});

test('② 生成中必须有真正的停止分支：data-mode=stop + 可点', () => {
  const body = methodBody(PANEL, 'private syncSendButton');
  assert.match(body, /data-mode',\s*'stop'/, '缺少停止形态标记');
  assert.match(body, /textContent\s*=\s*stopping\s*\?\s*'…'\s*:\s*'停止'/, '停止按钮的文字');
  /*
   * `stopping` 之外必须显式解禁。断言的是"有一处 `disabled = false` 紧跟
   * `removeAttribute('disabled')`" —— 布尔属性残留就是禁用，这是同类缺陷
   * 在本仓库第二次出现（上一次是登录按钮永久变灰）。
   */
  assert.match(
    body,
    /disabled\s*=\s*false;[\s\S]*?removeAttribute\('disabled'\)/,
    '解除禁用必须同时 removeAttribute —— 只赋 false 在部分 WebView 上不生效',
  );
});

test('③ 点发送按钮在生成中走 stopStreaming，不是走 send', () => {
  const body = methodBody(PANEL, 'private async onSendClick');
  assert.match(body, /if\s*\(isBusy\(this\.stream\)\)\s*\{[\s\S]*?stopStreaming\(\)/);
  assert.match(body, /await this\.send\(\)/, '不忙时仍然是发送');
});

test('④ 先置停止态再 abort（顺序反了会被误判成"上游掐断"）', () => {
  const body = methodBody(PANEL, 'private async stopStreaming');
  const stopAt = body.indexOf('requestStop');
  const abortAt = body.indexOf('.abort(');
  assert.notEqual(stopAt, -1, 'stopStreaming 必须调 requestStop');
  assert.notEqual(abortAt, -1, 'stopStreaming 必须调 abort');
  assert.ok(
    stopAt < abortAt,
    '`requestStop` 必须在 `abort` 之前：abort 会让 Rust 立刻推 done，那时 phase 若还是 streaming 就分不出"人停的"',
  );
  assert.match(body, /phase\s*!==\s*'streaming'\)\s*return/, '重复点击（stopping）要直接返回');
});

test('⑤ 按钮文字是「发送」，不是箭头图标', () => {
  assert.match(PANEL, /send\.textContent\s*=\s*'发送'/, '初始文案');
  assert.match(methodBody(PANEL, 'private syncSendButton'), /textContent\s*=\s*'发送'/);
  assert.ok(
    !PANEL.includes("send.textContent = '↑'") && !PANEL.includes("sendEl.textContent = '↑'"),
    '箭头已按用户要求去掉（2026-11-22）',
  );
});

test('⑥ 样式：文字按钮（min-width），三态靠背景色区分', () => {
  const rule = /\.nb-send\s*\{([^}]*)\}/.exec(CSS);
  assert.notEqual(rule, null, '找不到 .nb-send 规则');
  const body = rule[1];
  assert.match(body, /min-width:\s*64px/, '文字按钮要能放下两个字，又不能在宽屏上被拉长');
  assert.ok(
    !/^\s*width:\s*var\(--nb-icon-btn\)/m.test(body),
    '固定成图标尺寸会让"发送"两个字挤成两行',
  );
  assert.match(body, /background:\s*var\(--nb-send-idle-bg\)/, '不可发送=灰底（走 token）');
  assert.match(
    CSS,
    /\.nb-send\[data-ready='true'\]\s*\{[^}]*background:\s*var\(--nb-send-go-bg\)/,
    '可发送=蓝底（走 token）',
  );
  /*
   * 颜色必须定义在 token 文件里。裸色值写在 chat.css 会被
   * `nebula-walkthrough.test.mjs` 的「走查 1」判红 —— 那是设计册的硬约束
   * （换主题时只需改一处）。
   */
  const TOKENS = stripComments(
    readFileSync(join(ROOT, 'client/src/chat/nebula-tokens.css'), 'utf8'),
  );
  for (const token of ['--nb-send-idle-bg', '--nb-send-idle-fg', '--nb-send-go-bg', '--nb-send-go-fg']) {
    assert.match(TOKENS, new RegExp(`${token}:\\s*#[0-9a-f]{6}`, 'i'), `token 文件里缺少 ${token}`);
  }
  /*
   * 禁用态**不许**再叠 opacity：灰底本身已经在表达"不可用"，
   * 叠上去会让灰字看不清（`0.4` 那条上一版就写着）。
   */
  const disabled = /\.nb-send:disabled\s*\{([^}]*)\}/.exec(CSS);
  assert.notEqual(disabled, null, '找不到 :disabled 规则');
  assert.ok(!/opacity:\s*0\.4/.test(disabled[1]), '禁用态不该再压透明度');
});

test('⑦ 空输入时按钮是灰的且禁用（别把"能发"错给人）', () => {
  const body = methodBody(PANEL, 'private syncSendButton');
  assert.match(body, /const\s+ready\s*=\s*text\.trim\(\)\.length\s*>\s*0;/);
  assert.match(body, /data-ready',\s*String\(ready\)/);
});
