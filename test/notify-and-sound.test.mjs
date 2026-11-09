/**
 * 通知条 / 底部空隙 / 发送提示音（2026-11-02 用户四条要求）。
 *
 * 原话：
 * > 各个错误弹窗或提醒的位置给我改成顶端提示（聊天栏下面），底端会影响到底部的按钮，
 * > 并且这个弹窗长按或者点击不能触发复制等选型，弹出弹窗后在消失之前点一下屏幕空白处
 * > 可以快速去掉通知弹窗。还有就是底部栏和聊天之间有空隙，看起来很不和谐，需要紧贴哈。
 * > 还有就是语音发送成功后需要有提示音，最好是QQ那种。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const rawCss = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
const rawMain = readFileSync(join(ROOT, 'client/src/mobile/main.ts'), 'utf8');
const main = rawMain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const rawPanel = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');
const panel = rawPanel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const sound = readFileSync(join(ROOT, 'client/src/chat/send-sound.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m !== null, `找不到规则 ${selector}`);
  return m[1];
}

/* ═══════════════════════════════════════════════════════════
   一、通知在顶端，不在底端
   ═══════════════════════════════════════════════════════════ */

test('★★★ 通知不许再用 bottom 定位（会压住底部按钮）', () => {
  /*
   * 用户原话：「底端会影响到底部的按钮」。
   *
   * 原来通知是 `bottom: calc(72px + safe-area)` —— 正好压在输入区/发送键上，
   * 而且它 `pointer-events` 没设，会**吃掉点击**。
   */
  assert.equal(
    /bottom\s*:/.test(ruleBody('.nb-notify')),
    false,
    '通知条不要用 bottom 定位',
  );
  assert.equal(
    /'bottom:/.test(main) || /bottom:calc/.test(main),
    false,
    'main.ts 里不许再拼 bottom 内联样式',
  );
});

test('★★★ 通知要用 absolute 挂在 .nb-chat 里（内联 top 被 CSP 拦）', () => {
  /*
   * ## 真机实测（r34，`probe-notify-style.mjs`）
   *
   * ```text
   *   line.setAttribute('style', 'top:93px')
   *   line.getAttribute('style')       → "top:93px"     ← 属性在
   *   getComputedStyle(line).top       → "851.273px"    ← 但没生效（auto 的静态位置）
   *   getComputedStyle(line).position  → "fixed"
   * ```
   *
   * **内联 `style` 被 CSP 拦了**。于是 `top` 是 `auto`，
   * `position: fixed` 的元素退回"静态位置" ⇒ 通知跑到屏幕最底部，
   * 正好压住用户说的"底部按钮"。
   *
   * ## 改法
   *
   * 挂进 `.nb-chat`（给它 `position: relative`），由 CSS 的 `top` 定位。
   * 一个内联样式都不用，位置天然是"顶部栏下面"（`.nb-chat` 就在 topbar 之下）。
   */
  /*
   * 定位基准必须是 `.nb-topbar`（`top:100%` 压在它下沿）。
   *
   * 挂 `.nb-chat` 不行：实测 `.nb-chat` 的 top=24、topbar 底边=77，
   * 两者重叠 53px，通知会被 topbar 盖住。
   */
  const body = ruleBody('.nb-notify');
  assert.match(body, /position:[ ]*absolute/, '通知要 absolute（fixed 需要内联 top，会被 CSP 拦）');
  assert.match(body, /top:[ ]*100%/, 'top 要用 100%（贴在 topbar 下沿），不写数值');

  /* 不许再出现内联 top 的写法 */
  assert.equal(
    /setAttribute\('style'/.test(main),
    false,
    'main.ts 里不许再给通知写内联 style（CSP 会拦）',
  );
  /* 必须挂进 .nb-topbar */
  assert.match(main, /querySelector\('\.nb-topbar'\)/, '要挂进 .nb-topbar');
});

test('★★★ Android 长按菜单要靠 contextmenu 拦（touch-callout 在 Android 无效）', () => {
  /*
   * `-webkit-touch-callout` 是 **iOS** 的属性。真机上
   * `getPropertyValue('-webkit-touch-callout')` 返回**空串** ——
   * 不是被覆盖，是这台 WebView 根本不认。
   *
   * Android 的长按菜单走 `contextmenu` 事件。CSS 那三条属性留着
   * （对 iOS 有用），但必须有 `contextmenu` 拦截，否则长按照样弹菜单。
   */
  /*
   * 只判"代码里有拦截"——`-webkit-touch-callout` 在 Android WebView 上
   * `getPropertyValue` 返回空串（那是 iOS 属性），真机量不到，
   * 所以这一条不能拿真机计算值当判据。
   */
  assert.match(main, /addEventListener\?\.\('contextmenu'/, '要拦 contextmenu');
  const at = main.indexOf("addEventListener?.('contextmenu'");
  const around = main.slice(at, at + 300);
  assert.match(around, /preventDefault/, 'contextmenu 要 preventDefault');
});

/* ═══════════════════════════════════════════════════════════
   二、长按/点击不能选中、不弹复制菜单
   ═══════════════════════════════════════════════════════════ */

test('★★★ 通知要拦住长按菜单：三条属性缺一不可', () => {
  /*
   * 只写 `user-select: none` 时，Android WebView 长按**仍会弹系统菜单** ——
   * 那个菜单不是"选择"，是 `-webkit-touch-callout`。
   */
  const body = ruleBody('.nb-notify');
  assert.match(body, /user-select:\s*none/, '要 user-select:none');
  assert.match(body, /-webkit-user-select:\s*none/, '老 WebView 只认带前缀的');
  assert.match(body, /-webkit-touch-callout:\s*none/, '这一条才拦得住长按复制/搜索菜单');
});

/* ═══════════════════════════════════════════════════════════
   三、点空白处快速关闭
   ═══════════════════════════════════════════════════════════ */

test('★★★ 点任意处要能立刻关掉通知', () => {
  /*
   * 用 capture 阶段挂 `pointerdown`：晚于它的处理器若 `stopPropagation()`，
   * bubble 阶段就收不到。
   * 但**不许 `preventDefault()`** —— 用户点按钮时那一下仍要生效。
   */
  assert.match(main, /addEventListener\?\.\('pointerdown',\s*dismiss,\s*true\)/, '要挂 pointerdown（capture）');
  assert.match(main, /removeEventListener\?\.\('pointerdown',\s*dismiss,\s*true\)/, '关掉时要摘监听，否则堆积');

  /* 通知本身不接收指针事件，否则"点在通知上"不算点空白 */
  assert.match(
    ruleBody('.nb-notify'),
    /pointer-events:\s*none/,
    '通知条要 pointer-events:none，点哪儿都能关',
  );
});

test('★★ 同一时刻只留一条通知（连着弹会把聊天区盖住）', () => {
  assert.match(main, /querySelectorAll\('\[data-role="shell-notify"\]'\)/, '要先清掉旧的');
});

/* ═══════════════════════════════════════════════════════════
   四、底部栏与聊天之间不许有缝隙
   ═══════════════════════════════════════════════════════════ */

test('★★★ 消息列表底部不许再留 56px（那是老浮层的空间）', () => {
  /*
   * `padding-bottom: calc(var(--nb-sp-4) + 56px)` 是给"语音胶囊浮层"留的：
   * 浮层绝对定位在输入区上方、不参与滚动，所以列表底部必须空出它的高度。
   *
   * 但三圆布局改造后，三个圆已经长在 `.nb-composer` 里（不是浮层），
   * 这块留白变成消息列表底部一条 56px 的空隙 —— 用户截图里红框圈的就是它。
   */
  const body = ruleBody('.nb-msglist');
  assert.equal(
    /56px/.test(body),
    false,
    '消息列表底部不该再有 56px：语音浮层已经不在那儿了',
  );
  /* 但正常的内边距要保留，不能连 var(--nb-sp-4) 一起删掉 */
  assert.match(body, /padding:\s*var\(--nb-sp-4\)/, '常规内边距要留着');
});

/* ═══════════════════════════════════════════════════════════
   五、语音发送成功提示音
   ═══════════════════════════════════════════════════════════ */

test('★★★ 发送成功后要播放提示音（两个发送出口都要）', () => {
  /*
   * 语音有**两个**发送出口：
   *   · `confirmBeforeSend = false` → 转写完直接发
   *   · `confirmBeforeSend = true`  → 用户点"确认"后发
   * 只接一个的话，另一种配置下永远没声音 —— 而两处代码长得不一样，很容易漏。
   */
  const calls = (panel.match(/playSendSound\(\)/g) ?? []).length;
  assert.ok(calls >= 2, `两个发送出口都要播放，实际 ${String(calls)} 处`);

  /* 必须排在 onSend 之后（先发出去再响，不能反过来） */
  const onSendAt = panel.indexOf('await this.options.onSend(');
  const firstPlayAt = panel.indexOf('playSendSound()');
  assert.ok(onSendAt > 0 && firstPlayAt > onSendAt, '提示音要在 onSend 之后');
});

test('★★★ 提示音要用 WebAudio 合成，不能依赖音频文件', () => {
  /*
   * 三条资源路径都试过，全不通（memory §79.7）：
   *   · `data:` URL → WebView 报 not supported source
   *   · 外部 http URL → Tauri 报 Media load rejected by URL safety check
   *   · 打包静态资源 → 多一个"没打进包"的失败面
   *
   * WebAudio 合成零资源、零加载失败可能。
   */
  assert.match(sound, /createOscillator\(\)/, '要用振荡器合成');
  assert.match(sound, /createGain\(\)/, '要有包络（否则是刺耳的方波长音）');
  assert.equal(/new Audio\(|\.mp3|\.ogg['"]/.test(sound), false, '不许依赖音频文件');
});

test('★★★ 录音按下时要预热 AudioContext（否则发送时不出声）', () => {
  /*
   * WebAudio 在没有用户手势时是 `suspended`，播放不出声。
   * 而"发送成功"发生在松手后 1~2 秒（转写完），那时已脱离手势上下文。
   *
   * 所以要在**按住大圆那一刻**（明确的手势）先 resume。
   * 漏了这一步的症状极隐蔽：代码没报错、函数也执行了，就是没声音。
   */
  assert.match(panel, /warmupSendSound\(\)/, '按住时要预热');
  const warmAt = panel.indexOf('warmupSendSound()');
  const downAt = panel.indexOf('private async onPointerDown(');
  assert.ok(downAt > 0 && warmAt > downAt, '预热要写在 onPointerDown 里（那里才有用户手势）');
});

test('★★ 播放失败不能影响发送（全程 try/catch）', () => {
  /*
   * 提示音是锦上添花。用户宁可没声音，也不能因为"播放失败"
   * 而收不到自己刚发的消息。
   */
  assert.match(sound, /export function playSendSound\(\): void \{[\s\S]{0,200}?try \{/, 'playSendSound 要整体包在 try 里');
  assert.match(sound, /catch \{/, '要有 catch 兜住');
});
