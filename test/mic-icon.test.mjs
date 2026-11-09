/**
 * 麦克风图标必须是线稿 SVG，且**两处共用一份**（2026-11-05）。
 *
 * ## 用户第二次抱怨同一件事
 *
 * > 我想把进入语言面板的这个图标换成附件这种简笔画的风格，emoji 的不好看
 *
 * 注意"**第二次**"：`voice-panel.ts` 的 `makeMicIcon()` 上方那段注释
 * 早就写着"为什么不用 emoji `🎤`"——那就是为同一个论点写的。
 *
 * 但它当时只把**大圆按钮**（`bigmic`）换成了 SVG，
 * **输入框旁边那个入口**（`mic-slot`）还是 `🎤`：
 *
 * ```text
 *   入口      mic-slot   🎤  彩色 emoji，还不吃 CSS 的 color
 *   面板里    bigmic     ◯   白色线稿
 * ```
 *
 * 同一件事两处实现，改一处忘另一处 —— 本项目反复出现的形状
 * （`fieldRow` 两份、`.nb-drawer` 与 `.nb-acc-panel` 两套、
 * `sillytavern.json` 不管示例对话而 `chub.json` 管…）。
 *
 * ## 判据守三件事
 *
 * 1. `mic-slot` 里**不许**再有 emoji 字符
 * 2. 两处都必须调 `makeMicIcon`（不是各画一份）
 * 3. 线稿吃 `currentColor`，所以 `.nb-mic-slot` 的 `color` 不能是
 *    `--nb-text-3`（emoji 时代看不出来，线稿时代会糊住）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** 剥注释（解释文字里会引用被禁的 emoji 与旧类名） */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

const voice = stripComments(read('client/src/chat/voice-panel.ts'));
const css = stripComments(read('client/src/chat/chat.css'));

test('★★★ 输入框入口不许再用 emoji 麦克风', () => {
  /*
   * 直接找那一行赋值。用"是否出现 🎤"太宽（注释里可能提到），
   * 所以钉"给 mic 设 textContent"这个动作。
   */
  assert.doesNotMatch(
    voice,
    /mic\.textContent\s*=\s*['"][^'"]*🎤/,
    'mic-slot 还在用 🎤 emoji —— 应改成 mic.append(makeMicIcon(this.doc, 22))',
  );
  assert.doesNotMatch(
    voice,
    /\.textContent\s*=\s*['"]🎤['"]/,
    '还有地方把 🎤 直接当图标文本',
  );
});

test('★★★ 两处麦克风必须共用 makeMicIcon（不是各画一份）', () => {
  const calls = [...voice.matchAll(/makeMicIcon\(this\.doc/g)].length;
  assert.ok(calls >= 2, `makeMicIcon 只被调用 ${String(calls)} 次，入口与大按钮应各一次`);

  /* 入口用小尺寸，大按钮用默认（30） */
  assert.match(voice, /mic\.append\(makeMicIcon\(this\.doc,\s*22\)\)/, '入口要用 22px');
  assert.match(voice, /bigmic\.append\(makeMicIcon\(this\.doc\)\)/, '大按钮用默认尺寸');
});

test('★★★ 图标是线稿：fill none + stroke currentColor', () => {
  assert.match(voice, /setAttribute\('fill',\s*'none'\)/, '必须 fill:none（线稿，不是实心）');
  assert.match(
    voice,
    /setAttribute\('stroke',\s*'currentColor'\)/,
    'stroke 要用 currentColor，颜色才能跟着 CSS 走',
  );
  assert.match(voice, /setAttribute\('stroke-linecap',\s*'round'\)/, '圆头端点才是简笔画的手感');
});

test('★★★ 描边宽度跟着尺寸走（小图标用 2 会糊）', () => {
  assert.match(
    voice,
    /stroke-width',\s*size\s*>=\s*28\s*\?\s*'2'\s*:\s*'1\.9'/,
    '描边宽度要按 size 分档',
  );
});

test('★★★ `.nb-mic-slot` 的 color 不能是 text-3（线稿会糊在底色里）', () => {
  /*
   * 这条是"换图标"最容易漏的一步：
   *
   * ```text
   *   emoji  自带颜色，color 无效 ⇒ 写 text-3 也没事
   *   SVG    stroke: currentColor ⇒ 直接吃 color
   *          text-3 = #6e6885，在 #14121e 上几乎看不见
   * ```
   */
  const at = css.indexOf('.nb-mic-slot {');
  assert.ok(at > 0, '找不到 .nb-mic-slot');
  const block = css.slice(at, css.indexOf('}', at));

  assert.doesNotMatch(
    block,
    /color:\s*var\(--nb-text-3\)/,
    '.nb-mic-slot 的 color 还是 text-3 —— 换成线稿后会糊住，改用 text-2',
  );
  assert.match(block, /color:\s*var\(--nb-text-2\)/, '应用 text-2');
});

test('★★ 未配置 ASR 时仍然要置灰（不能因为改了颜色就丢掉状态表达）', () => {
  assert.match(
    css,
    /\.nb-mic-slot\[data-enabled='false'\]\s*\{[^}]*color:\s*var\(--nb-text-3\)/,
    '未配置时要打回 text-3 —— 否则"能不能用"没有视觉区分',
  );
});

test('★★ 图标类名要中性（原来叫 nb-bigmic-icon，会误导下一个加图标的人）', () => {
  assert.match(voice, /setAttribute\('class',\s*'nb-mic-icon'\)/, '类名应统一成 nb-mic-icon');
  assert.match(css, /^\.nb-mic-icon\s*\{/m, 'CSS 里要有 .nb-mic-icon 规则');
  /* 旧名只许出现在注释里解释历史，不许出现在选择器或代码里 */
  assert.doesNotMatch(css, /^\.nb-bigmic-icon\s*\{/m, '旧的 .nb-bigmic-icon 选择器应已改名');
});

test('★★ SVG 不许走 innerHTML（渲染层硬约束）', () => {
  /*
   * `validate:client` 禁止渲染层写 innerHTML（XSS 面）。
   * SVG 也一样 —— 必须 `createElementNS`。
   */
  const at = voice.indexOf('function makeMicIcon');
  const body = voice.slice(at, at + 1600);
  assert.doesNotMatch(body, /innerHTML/, 'makeMicIcon 里不许用 innerHTML');
  assert.match(body, /createElementNS/, '要用 createElementNS 造 SVG 节点');
});
