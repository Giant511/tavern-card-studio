/**
 * 语音态布局：三圆横排 + 顶部「波形 · 计时 · 波形」（2026-11-02 用户给的图）。
 *
 * ## 用户要什么
 *
 * 布局照图片：
 * ```text
 *            |||||| || 0:01 || ||||||
 *
 *      (内心/动作)     ( 🎤 )      (消息)
 *                     ↑
 *                按住这里
 * ```
 *
 * 操作照视频 + 一条补充：
 * > 左边那个是内心/动作，**按住并滑到这个按钮上**使用；中间是说话，
 * > 右边是消息，按住并滑到这个按钮上使用；
 * > 然后**按住并上滑是取消**，按住中间的按钮是提示上滑取消，松开识别为对话
 *
 * ## 这组判据守什么
 *
 * 1. **三个圆在同一行**（大圆在 `chips` 容器里，不是留在 `stage`）
 *    —— 分两个容器靠外边距对齐，窄屏会偏移
 * 2. **大圆在中间**（左右两个档位圆分别在它前后）
 * 3. **顶部有波形 + 计时**，未录音显示 `0:00`
 * 4. **提示文案三态**：未按住「按住说话」/ 按住「上滑取消」/ 越界「松开 取消」
 *
 * 第 2 条特别重要：顺序错了（比如内心在右）会让"往左滑"落到「消息」上，
 * 用户看到的与他得到的是反的 —— 而界面上完全正常，只是反了。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const css = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');
const rawPanel = readFileSync(join(ROOT, 'client/src/chat/voice-panel.ts'), 'utf8');
/** 剥注释再扫 —— 本项目因"注释被当代码"踩过 6 次 */
const panel = rawPanel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/* ═══════════════════════════════════════════════════════════
   一、三个圆在同一行
   ═══════════════════════════════════════════════════════════ */

test('★★★ 大圆必须在 chips 容器里（三个圆同一行才能左右对称）', () => {
  const start = panel.indexOf('private renderChips(');
  assert.ok(start >= 0, '找不到 renderChips');
  const end = panel.indexOf('private renderSideChip(', start);
  const body = panel.slice(start, end);

  /*
   * 顺序断言：先渲染左圆 → 再渲染大圆 → 再渲染右圆。
   *
   * 只断言"三者都在 renderChips 里"不够 —— 顺序反了同样是错的
   * （内心跑到右边，左滑就落到「消息」上）。
   */
  const leftAt = body.indexOf("this.renderSideChip('inner')");
  const bigAt = body.indexOf("VOICE_MOUNTS.bigmic");
  const rightAt = body.lastIndexOf("this.renderSideChip('message')");

  assert.ok(leftAt >= 0, '缺左圆（内心/动作）');
  assert.ok(bigAt >= 0, '大圆必须在这个容器里（否则和两个档位圆不在同一行）');
  assert.ok(rightAt >= 0, '缺右圆（消息）');
  assert.ok(leftAt < bigAt, '左圆必须在大圆**之前**（往左滑才落到内心）');
  assert.ok(bigAt < rightAt, '右圆必须在大圆**之后**（往右滑才落到消息）');
});

test('★★★ 大圆带 data-voice-mode=speak（"按住中间 = 说话"要有落点）', () => {
  /*
   * 大圆不只是一个按钮，它同时是「说话」这一档。若 DOM 上没有这个标记，
   * 读屏念不出来、验收也看不见 —— 而"按住中间发成什么"就只存在于代码里。
   */
  assert.match(
    panel,
    /bigmic\.setAttribute\('data-voice-mode',\s*'speak'\)/,
    "大圆要标 data-voice-mode='speak'",
  );
});

test('★★ 两个档位圆各有两行文字，且不靠斜杠硬断', () => {
  /*
   * `内心/动作` 在 64px 圆里一行放不下，会被裁成「内心/动」——
   * 比不放字更糟。所以按 `/` 拆成两行。
   */
  assert.match(panel, /VOICE_MODE_LABEL\[mode\]\.split\('\/'\)/, '标签要按 / 拆行');
  assert.match(css, /\.nb-chip-line\s*\{[\s\S]{0,80}?display:\s*block/, '每行要独占一行');
});

/* ═══════════════════════════════════════════════════════════
   二、顶部波形 + 计时
   ═══════════════════════════════════════════════════════════ */

test('★★★ 顶部有「波形 · 计时 · 波形」一行，计时在正中', () => {
  const start = panel.indexOf('private renderWaveClock(');
  assert.ok(start >= 0, '找不到 renderWaveClock');
  const end = panel.indexOf('private makeWaveBar(', start);
  const body = panel.slice(start, end);

  const leftAt = body.indexOf("'data-side', 'left'");
  const clockAt = body.indexOf("'voice-clock'");
  const rightAt = body.indexOf("'data-side', 'right'");
  assert.ok(leftAt >= 0 && clockAt > leftAt && rightAt > clockAt, '顺序必须是 左波形 → 计时 → 右波形');

  /* CSS 里靠 flex 居中，计时宽度变化不该把波形挤走 */
  assert.match(css, /\.nb-voice-waveclock\s*\{[\s\S]{0,200}?justify-content:\s*center/);
  /* 等宽数字：否则每秒数字宽度变化，计时会左右抖 */
  assert.match(css, /\.nb-voice-clock\s*\{[\s\S]{0,300}?font-variant-numeric:\s*tabular-nums/);
});

test('★★ 计时用 formatRecordClock（0:01），不是气泡上的 1"', () => {
  /*
   * 两个格式服务不同位置：气泡上是结果（`5"` 更短），录音中是时钟（要能看出在走）。
   * 混用会出现"录音计时显示 1""或"气泡上写 0:05"。
   */
  assert.match(panel, /formatRecordClock\(/, '计时要用 formatRecordClock');
  assert.equal(
    /voiceDurationLabel\(.*recordStartedAt/.test(panel),
    false,
    '录音中不能用气泡格式（它最少显示 1，而刚开始真实值是 0）',
  );
});

/* ═══════════════════════════════════════════════════════════
   三、手势：命中圆按钮（不是位移阈值）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 切档判据是"落在哪个圆上"，不是"滑了多远"', () => {
  /*
   * 用户原话是「按住并**滑到这个按钮上**使用」。
   * 位移阈值（`dx <= -56`）看不见按钮在哪 —— 用户明明滑到左圆上，
   * 但差几像素就不生效；反过来滑到空白处却因为位移够而切了档。
   */
  assert.match(panel, /private modeUnderPoint\(/, '要有"落点命中"判定');
  assert.match(panel, /hitTestVoiceChip\(point, rects\)/, '要复用纯逻辑的命中测试');

  const moveStart = panel.indexOf('handlePointerMove(clientX: number');
  const moveBody = panel.slice(moveStart, moveStart + 1400);
  assert.ok(
    moveBody.includes('modeUnderPoint'),
    '拖动时要走命中判定',
  );
  assert.equal(
    /highlightByHorizontalSlide|modeByHorizontalSlide/.test(moveBody),
    false,
    '拖动时不许再用位移阈值（两套判据并存会让"高亮"与"结果"分叉）',
  );
});

test('★★★ 松手与拖动必须用同一个判定函数', () => {
  /*
   * 两处各写一套的后果：拖动时高亮内心、松手却发成消息。
   * 判据：`onPointerUp` 里也要调 `modeUnderPoint`。
   */
  const upStart = panel.indexOf('private async onPointerUp(');
  const upBody = panel.slice(upStart, upStart + 3000);
  assert.ok(upBody.includes('modeUnderPoint'), '松手重算模式要用同一个 modeUnderPoint');
});

test('★★★ 上滑取消的优先级高于切档', () => {
  /*
   * 取消 = "这次别发了"，比"发成什么类型"更重要。
   * 顺序反了会出现"手指掠过某个圆，取消状态被清掉，结果发出去了"。
   */
  const moveStart = panel.indexOf('handlePointerMove(clientX: number');
  const moveBody = panel.slice(moveStart, moveStart + 1400);
  const cancelAt = moveBody.indexOf('isCancelSlide');
  const hitAt = moveBody.indexOf('modeUnderPoint');
  assert.ok(cancelAt >= 0, '拖动时要判上滑取消');
  assert.ok(hitAt > cancelAt, '必须先判取消、再判命中');
  assert.match(moveBody, /if \(cancelling\) return;/, '取消成立后不再理会落在哪');
});

/* ═══════════════════════════════════════════════════════════
   四、提示文案三态（用户原话）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 未按住「按住说话」· 按住「上滑取消」· 越界「松开 取消」', () => {
  const start = panel.indexOf("if (this.hintEl !== null) {");
  assert.ok(start >= 0, '找不到提示同步逻辑');
  const body = panel.slice(start, start + 900);

  assert.match(body, /'松开 取消'/, '越界态要说"松开 取消"');
  assert.match(body, /'上滑取消'/, '按住态要说"上滑取消"（用户原话）');
  assert.match(body, /'按住说话'/, '空闲态要说"按住说话"');

  /*
   * 反向断言：空闲态**不许**提"取消"。
   *
   * 用户原话是"按住中间的按钮是提示上滑取消" —— 也就是按住之后才提。
   * 一进语音态就看到"取消"会让人以为按下去就有风险。
   */
  const idleBlock = /else \{\s*this\.hintEl\.textContent = '([^']*)'/.exec(body);
  assert.ok(idleBlock !== null, '找不到空闲态文案');
  assert.equal(
    idleBlock[1].includes('取消'),
    false,
    `空闲态不该提取消，实际 ${idleBlock[1]}`,
  );
});

test('★★ 提示与判据同向：写的方向必须是"上滑"', () => {
  /*
   * 「文案是唯一的产品内教学」—— 与判据不同向时，用户按提示做会得到相反结果。
   * 这个项目已经因此出过事（提示写"下滑取消"，而代码判上滑）。
   */
  assert.match(
    panel,
    /this\.hintEl\.textContent = '上滑取消'/,
    '按住时的提示必须写"上滑取消"（与 isCancelSlide 同向）',
  );
  assert.equal(
    /hintEl\.textContent = '[^']*下滑/.test(panel),
    false,
    '提示里不许出现"下滑"（判据判的是上滑）',
  );
});

/* ═══════════════════════════════════════════════════════════
   五、形态判据的值域一致性（2026-11-02 真机踩到）
   ═══════════════════════════════════════════════════════════ */

test('★★★ chips 的显示判据必须用面板自己的 data-voice（不是 composer 的）', () => {
  /*
   * ## 这个坑的完整形状
   *
   * `data-voice` 这一个属性名，在两处用了**两套值域**：
   *
   * | 谁 | 值 |
   * |---|---|
   * | `.nb-composer`（外壳设的） | `'true'` / `'false'` |
   * | `.nb-voice-stage`（面板设的） | `'voice'` / `'keyboard'` |
   *
   * 我第一版 CSS 写的是
   * `.nb-composer:not([data-voice='voice']) .nb-voice-chips-slot { display: none }`，
   * 而 composer 上永远是 `'true'/'false'` ⇒ `'true' !== 'voice'` 恒成立
   * ⇒ `:not()` 恒真 ⇒ **三个圆被永久 display:none**。
   *
   * 真机现象：三圆 `getBoundingClientRect()` 全零（0×0），
   * 但 DOM 上属性、类名、子节点**全都正常** —— 任何 DOM 断言都不会红。
   * 只有量矩形才看得见。
   *
   * ## 判据
   *
   *   ① CSS 里不能出现用 `composer` 的 data-voice 去控 chips 的选择器
   *   ② chips 必须自己被写上 data-voice（值来自 `this.voiceStage`）
   */
  /*
   * ⚠ 两个坑：①`.nb-composer[data-voice='true'] .nb-input` 这类既有规则是**对的**
   * （用 `'true'` 与 composer 的值域一致），不能笼统禁掉；
   * ②**注释里也会出现这两个词**（我自己就在注释里解释了为什么不能用），
   * 必须先剥注释再判 —— 否则判据被自己的说明文字判红。
   */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = cssCode.split('}');
  const crossValueRules = rules.filter(
    (rule) =>
      rule.includes('.nb-composer') &&
      rule.includes('.nb-voice-chips-slot') &&
      rule.includes('[data-voice'),
  );
  assert.deepEqual(
    crossValueRules,
    [],
    `chips 的显隐不许用 .nb-composer 的 data-voice 控制（那边是 true/false，值域不同）：${crossValueRules.join(' | ')}`,
  );
  assert.match(
    css,
    /\.nb-voice-chips-slot\[data-voice='keyboard'\]\s*\{[^}]*display:\s*none/,
    "chips 显隐要用自己的 data-voice='keyboard'",
  );
  assert.match(
    panel,
    /this\.chipsEl\.setAttribute\('data-voice',\s*this\.voiceStage\)/,
    'chips 要自己带 data-voice（与 stage 同源同值域）',
  );
});

test('★★ 两个档位圆必须有非零尺寸（CSS 缺失会让它们 0×0 而 DOM 看不出来）', () => {
  /*
   * `.nb-chip` 的宽高只写在 CSS 里。若选择器名字打错（或像上一条那样
   * 被 `display:none` 波及），元素会是 0×0 —— 而 DOM 断言全绿。
   * 所以这里直接断言"CSS 里给了明确的宽高"。
   */
  assert.match(css, /\.nb-chip\s*\{[\s\S]{0,400}?width:\s*\d+px/, '.nb-chip 要给明确宽度');
  assert.match(css, /\.nb-chip\s*\{[\s\S]{0,400}?height:\s*\d+px/, '.nb-chip 要给明确高度');
  assert.match(css, /\.nb-chip\s*\{[\s\S]{0,400}?border-radius:\s*50%/, '档位圆要正圆');
  assert.match(css, /\.nb-voice-bigmic\s*\{[\s\S]{0,600}?border-radius:\s*50%/, '大圆要正圆');
});

/* ═══════════════════════════════════════════════════════════
   六、语音态下 composer 必须纵向排列（2026-11-02 真机踩到）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 语音态 composer 要纵向排列（否则两行被挤成一排）', () => {
  /*
   * ## 真机现象
   *
   * `.nb-composer` 是 `flex-direction: row`（输入框 + 发送 + 麦克风一行）。
   * 语音态里新增了两块（舞台、三圆行），它们被当成 row 的两个兄弟，
   * 挤在右边那条窄缝里：
   *
   * ```text
   *   ┌──────────────────────────────┐
   *   │ 0:00              (内心)  (🎤) │  ← 全挤在右下
   *   │ 按住说话                       │
   *   └──────────────────────────────┘
   * ```
   *
   * 而 DOM 结构、类名、属性**全都正常** —— 又是只有看图/量矩形才发现的错。
   *
   * ## 判据
   *
   * 语音态必须把方向改成 column，且子项撑满宽度（否则内部居中失效）。
   */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(
    cssCode,
    /\.nb-composer\[data-voice='true'\]\s*\{[^}]*flex-direction:[ ]*column/,
    "语音态 composer 必须 flex-direction: column",
  );
  assert.match(
    cssCode,
    /\.nb-composer\[data-voice='true'\]\s*\{[^}]*align-items:[ ]*stretch/,
    '子项要撑满整宽（否则居中/两端对齐都失效）',
  );
  /* 舞台自己撑满整宽，靠内部 align-items:center 居中 */
  assert.match(
    cssCode,
    /\.nb-voice-stage\[data-voice='voice'\]\s*\{[^}]*width:[ ]*100%/,
    '舞台要撑满整宽',
  );
});

/* ═══════════════════════════════════════════════════════════
   七、CSS 变量必须真实存在 + 盒模型不许溢出（2026-11-02 真机踩到）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 语音布局用到的 CSS 变量都必须在 token 里定义过', () => {
  /*
   * ## 真机现象
   *
   * 波形柱写的是 `background: var(--nb-text-4)`，而 `nebula-tokens.css`
   * 里**只有 `--nb-text-1/2/3`**。`var()` 解析不到变量时**不报错**，
   * 该声明直接失效 ⇒ 柱子 `background-color` 变成 `rgba(0,0,0,0)`（透明）。
   *
   * 于是："顶部波形看不见"，但 DOM 里 32 根柱子都在、
   * `getBoundingClientRect()` 也有宽高 —— 所有常规断言全绿。
   * 只有 `getComputedStyle(bar).backgroundColor` 能揭穿它。
   *
   * ## 判据
   *
   * 把本文件里语音相关的 `var(--nb-xxx)` 全抓出来，逐个核对
   * token 文件里有没有 `--nb-xxx:` 的定义。这条能一次挡住"拼错变量名"
   * 和"用了没定义的 token"两类错 —— 它们全都表现成"样式静默失效"。
   */
  const tokens = readFileSync(join(ROOT, 'client/src/chat/nebula-tokens.css'), 'utf8');
  const defined = new Set(
    [...tokens.matchAll(/(--nb-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  /*
   * 还要允许**运行时变量**：有些变量由 JS 用内联 `style` 写进去
   * （`--nb-wave-level` 是振幅、`--nb-voice-bar-width` 是时长换算的宽度）。
   * 它们本来就不该在 token 里 —— token 放的是设计常量。
   *
   * 判据从面板源码里抓"被写入过的变量名"，这样新加一个运行时变量
   * 不需要回来改这条判据（否则它会变成一个"每次都要顺手改"的负担，
   * 而那种判据最后都会被人放宽到失效）。
   */
  const runtimeDefined = new Set(
    [...rawPanel.matchAll(/(--nb-[a-z0-9-]+)/g)].map((m) => m[1]),
  );
  /* 只查语音相关的规则段，避免把别人写的历史遗留问题算进来 */
  const voiceCss = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .filter((rule) => /nb-voice-|nb-chip|nb-bigmic/.test(rule))
    .join('}');
  const used = [...voiceCss.matchAll(/var\((--nb-[a-z0-9-]+)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter(
    (name) => !defined.has(name) && !runtimeDefined.has(name),
  );

  assert.deepEqual(missing, [], `这些变量没有在 token 里定义（会静默失效）：${missing.join(', ')}`);
});

test('★★★ 三圆行 width:100% 必须配 box-sizing: border-box', () => {
  /*
   * ## 真机现象
   *
   * default 是 `content-box`，于是 `width:100%` + 左右 20px padding
   * = 实际 401px，而父容器只有 361px ⇒ **右边的「消息」圆被推出视口**，
   * 截图里只露出半个。
   *
   * `getBoundingClientRect().width` 返回 401，看上去"很宽很正常"——
   * 只有把它和父容器宽度比才发现溢出。
   */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rowRule = /\.nb-voice-chips-slot\s*\{([^}]*)\}/.exec(cssCode);
  assert.ok(rowRule !== null, '找不到 .nb-voice-chips-slot 规则');
  const body = rowRule[1];
  assert.match(body, /width:[ ]*100%/, '三圆行要撑满整宽');
  assert.match(
    body,
    /box-sizing:[ ]*border-box/,
    'width:100% 必须配 box-sizing:border-box（否则 padding 让它溢出父容器）',
  );
  assert.equal(
    /max-width:[ ]*[0-9]+px/.test(body),
    false,
    '不要在行上写 max-width：它与 padding 组合会让窄屏居中失效，限宽应交给父容器',
  );
});
