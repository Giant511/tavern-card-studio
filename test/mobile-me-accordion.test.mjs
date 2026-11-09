/**
 * 第三批 · 问题一：「我的」页两级收纳化（2026-10-31）。
 *
 * ## 守的是什么
 *
 * 用户要求：「我的」页选项分级 —— 第一级 = [API 连接] [语音输入配置] 两个收纳项；
 * 点击就地展开第二级；**两个页面内部的抽屉式交互保持不变**。
 *
 * 改之前的结构是**不一致**的：API 连接页整页平铺在「我的」里
 * （要先滚过一整屏表单才能看到语音），而语音输入已经是个收纳项。
 *
 * 这类"层级不一致"的缺陷不会让任何功能失效 —— 点得到、存得上、测试也绿，
 * 只有把**结构**当判据才抓得到。所以这里断言的是结构本身。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const cssSrc = () => readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');

/** 取出某个函数的**完整源码片段**（从声明起，按大括号配平到函数结束） */
function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);

  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${signature} 的大括号没有配平`);
}

/* ═══════════════════════════════════════════════════════════
   一、两个条目必须同级（共用同一个构造函数）
   ═══════════════════════════════════════════════════════════ */

test('★ 问题一：两个一级收纳项都走同一个 renderAccordion', () => {
  /*
   * 各写一份的后果不是"坏掉"，而是**慢慢分叉**：
   * padding 不同、chevron 一个转一个不转、aria 一边写一边漏。
   * 这些只在截图里看得出来（chat.css 那边已经有过同类教训）。
   */
  const src = shellSrc();

  assert.match(src, /private\s+renderAccordion\(/, '必须有通用的收纳项构造函数');

  const api = functionSource(src, 'private renderApiSection');
  const voice = functionSource(src, 'private renderVoiceSection');

  assert.match(api, /this\.renderAccordion\(/, `API 条目必须用通用组件，实际：${api.slice(0, 200)}`);
  assert.match(voice, /this\.renderAccordion\(/, `语音条目必须用通用组件，实际：${voice.slice(0, 200)}`);
});

test('★ 问题一：「我的」页只挂这两个条目，不再平铺整页', () => {
  /*
   * 反向断言：`renderMe()` 里不许再出现"把 API 页直接 append 到滚动容器"。
   * 那种写法就是改之前的结构（API 平铺、语音收纳）。
   */
  const src = shellSrc();
  const renderMe = functionSource(src, 'private renderMe()');

  assert.match(
    renderMe,
    /scroller\.append\([\s\S]*?this\.renderApiSection\(\)[\s\S]*?this\.renderVoiceSection\(\)[\s\S]*?\);/,
    '两个收纳项都要挂进 .nb-scroll',
  );

  // 面板不能再直接挂在 renderMe 里（应该在各自条目的 buildBody 里）
  assert.doesNotMatch(
    renderMe,
    /renderApiPage\(/,
    'renderMe 不该直接调 renderApiPage —— API 页现在由条目内部构建',
  );
});

test('★ 问题一：两个条目的展开状态各自记在外壳', () => {
  /*
   * 「我的」页随 Tab 切换 `replaceChildren` 重绘。状态记在页面里切一次就丢，
   * 用户会以为"点了没生效"。
   */
  const src = shellSrc();
  assert.match(src, /private\s+apiExpanded/, 'apiExpanded 必须是外壳字段');
  assert.match(src, /private\s+voiceExpanded/, 'voiceExpanded 必须是外壳字段');

  const spec = src.indexOf('interface AccordionSpec');
  assert.ok(spec > 0, '必须有 AccordionSpec');
  const seg = src.slice(spec, spec + 1200);
  assert.match(seg, /onToggle/, 'AccordionSpec 要把翻转状态的责任交给调用方（onToggle）');
});

/* ═══════════════════════════════════════════════════════════
   二、内部交互保持原样（用户明确要求）
   ═══════════════════════════════════════════════════════════ */

test('★ 问题一：两个页面内部仍是原来的抽屉，没有重写', () => {
  /*
   * 用户原话：「现有 API 与语音输入两个页面内部的抽屉式交互保持不变」。
   * 判据：两个 render 函数仍被调用，且各自的 data-role 还在。
   */
  const src = shellSrc();

  /*
   * 2026-11-01 第五批：第二个参数从 `this.bridge` 变成了 `writer`
   * —— 因为 `writeSecret` 必须过连接门（见 `api-page.ts` 的 `SecretWriter`）。
   * 判据的意图不变：**仍走原来的两个 render 函数**，没有另写一份。
   */
  assert.match(src, /renderApiPage\(this\.doc, \w+, this\.apiState/, 'API 页仍走 renderApiPage');
  assert.match(src, /renderVoiceSettingsPage\(this\.doc, this\.voiceSettings/, '语音页仍走 renderVoiceSettingsPage');
});

test('★ 问题一：嵌入时关掉自带顶栏（否则标题连着出现两遍）', () => {
  /*
   * 2026-10-31 实测截图：收纳项标题行写着「API 连接」，点开之后
   * API 页自己又渲染了一个「API 连接」大标题 —— 同一个词连着出现两次。
   *
   * 修法是给两页加 `hideTopbar` 选项（默认 false，保留"独占整屏"用法），
   * 嵌进收纳项时传 true。这条守的就是"embed 时必须传"。
   */
  const src = shellSrc();
  assert.match(src, /hideTopbar:\s*true/, '嵌进收纳项时要传 hideTopbar: true');

  for (const [file, signature] of [
    ['api-page.ts', 'export function renderApiPage'],
    ['voice-settings.ts', 'export function renderVoiceSettingsPage'],
  ]) {
    const text = readFileSync(join(CHAT_DIR, file), 'utf8');
    assert.match(text, /hideTopbar\?:\s*boolean/, `${file} 要有 hideTopbar 选项`);
    assert.match(
      text,
      /callbacks\.hideTopbar\s*!==\s*true/,
      `${file} 要按选项跳过顶栏（默认仍是渲染）`,
    );
    void signature;
  }
});

/* ═══════════════════════════════════════════════════════════
   三、展开动画走夜航 token
   ═══════════════════════════════════════════════════════════ */

test('★ 问题一：展开动画用夜航时长与缓动 token', () => {
  /*
   * 用户要求"展开/收起动画走夜航动效 token"。
   * 裸写 `200ms` 的话 `prefers-reduced-motion` 那条不生效
   * （token 在媒体查询里被改成 1ms，裸值不会）。
   */
  const css = cssSrc();
  const i = css.indexOf("@keyframes nb-acc-enter");
  assert.ok(i > 0, '必须有 nb-acc-enter 关键帧');

  const i2 = css.indexOf(".nb-acc-panel[data-enter='1']");
  assert.ok(i2 > 0, '必须有触发器规则');
  const rule = css.slice(i2, css.indexOf('}', i2));

  assert.match(rule, /animation:\s*nb-acc-enter\s+var\(--nb-dur-base\)\s+var\(--nb-ease-out\)/, `动画必须用 token，实际：${rule}`);
});

test('★ 问题一：动画只动 opacity / transform（不触发布局）', () => {
  /*
   * 宽度/高度动画会触发布局，在低端安卓上掉帧。
   * 这也是"收起不做高度动画"的技术前提 —— 收起时面板内容被清空，
   * 高度就是 0，没有可补间的起点（见 renderAccordion 的注释）。
   */
  const css = cssSrc();
  const i = css.indexOf('@keyframes nb-acc-enter');
  const block = css.slice(i, css.indexOf('\n}', i));

  assert.match(block, /opacity:/, '要有 opacity 过渡');
  assert.match(block, /transform:/, '要有 transform 过渡');
  assert.doesNotMatch(block, /\b(height|width|margin|padding)\s*:/, `关键帧里不许动布局属性，实际：${block}`);
});

test('★ 问题一：收起时清空 DOM（保证字段全局唯一）', () => {
  /*
   * 两个展开面板里都有 `model-input` / `key-input` / `asr-key` 这类字段。
   * 留着 DOM 的话 `byRole('model-input')[0]` 会取到**收起那个**，
   * 保存时读到另一份的值 —— 不报错，只是"填了 A 存成了 B"。
   *
   * ## 这条第一版太弱，被变异测试抓住
   *
   * 第一版只断言 `renderAccordion` 里出现过 `body.replaceChildren()` ——
   * 而那个函数里 `fill()` 分支**也有**一次 `replaceChildren()`，
   * 所以把"收起时清空"那一行删掉，断言照样绿。
   *
   * 改成断言**收起分支**的形状：`body.hidden = true` 前后紧跟
   * `body.replaceChildren()`，也就是"两件事必须成对出现"。
   *
   * ## 第二版仍然太弱，又被变异测试抓住
   *
   * 收起逻辑有**两处**：`renderAccordion` 初始化时（`spec.expanded === false`
   * 那个分支）和点击收起时。第二版只要求"至少一处成对"，
   * 于是删掉其中任意一处都还是绿。
   *
   * 现在要求**恰好两处成对** —— 少一处就红。这也是真实语义：
   * 两条收起路径都必须清空，否则"初始收起"或"点回收起"其中一种会留 DOM。
   */
  const src = shellSrc();
  const accordion = functionSource(src, 'private renderAccordion');

  const pairs = accordion.match(/body\.replaceChildren\(\);\s*body\.hidden\s*=\s*true;/g);
  assert.ok(
    pairs !== null && pairs.length === 2,
    `两条收起路径都必须"先清空 DOM 再隐藏"（初始收起 + 点击收起）。` +
      `实际匹配 ${pairs === null ? 0 : pairs.length} 处，期望 2 处。`,
  );
});

/* ═══════════════════════════════════════════════════════════
   四、状态栏安全区（真机截图抓到的重叠）
   ═══════════════════════════════════════════════════════════ */

test('★★ 状态栏内边距必须三级兜底（注入值 → env() → 24px）', () => {
  /*
   * 2026-10-31 真机截图：状态栏图标与顶栏标题「聊天」重叠。
   * 根因：`env(safe-area-inset-top)` 在 Android WebView 里**解析为 0**
   * —— 只有真的 edge-to-edge 布局且系统把 inset 传下来时才非零。
   *
   * 两层修复：
   *   ① CSS 兜底 `max(env(...), 24px)` —— 保证不重叠；
   *   ② Android 侧从 WindowInsets 读出**真实值**注入 `--nb-safe-top`
   *      （`MainActivity.injectSafeArea()`）—— 这才是"对"。
   *
   * ## ★★★ 2026-11-05 改：不再钉"写在 `.nb-page` 的 padding-top 上"
   *
   * 原判据找 `--nb-safe-top` 的**第一处出现**、再取那一行断言
   * `padding-top: max(var(--nb-safe-top…`。两个问题：
   *
   * ```text
   *   ① 钉的是**写法**。值挪到 token（--nb-page-inset-top）之后，
   *      三级链一个字没少，判据却红了 —— 假红。
   *   ② indexOf 取第一处，注释里先提到它就会截到注释行。
   *      那天我在 `.nb-page` 上写了一大段事故注释，它截到的是
   *      "…--nb-safe-top 27px ← 变量本身是对的…" 这种说明文字。
   * ```
   *
   * 现在钉**性质**：三级链必须完整地出现在 token 定义里，
   * 并且真的有一个地方在用它（`chat.css` 里 `var(--nb-page-inset-top)`）。
   */
  const tokens = readFileSync(join(CHAT_DIR, 'nebula-tokens.css'), 'utf8');

  /* 找 token 的**定义行**（`--name:` 后面跟值），不是随便一处提及 */
  const defMatch = /--nb-page-inset-top:\s*([^;]+);/.exec(tokens);
  assert.ok(defMatch !== null, '必须定义 --nb-page-inset-top（安全区的唯一真值）');
  const definition = defMatch[1];

  assert.match(definition, /--nb-safe-top/, '第一级：Android 注入的真实值');
  assert.match(definition, /env\(safe-area-inset-top/, '第二级：env()（iOS/未来 edge-to-edge）');
  assert.match(definition, /,\s*24px\)/, '第三级：24px 兜底');
  assert.match(definition, /^max\(/, '整体要用 max() 取大值（有真值用真值，取不到至少不重叠）');

  /* 定义出来的东西必须真的有人用 —— 只定义不用等于没修 */
  const css = cssSrc();
  assert.match(
    css,
    /top:\s*var\(--nb-page-inset-top\)/,
    'chat.css 里层的 top 要用它（否则 token 定义了也没生效）',
  );
});

test('★ Android 侧要真的注入 --nb-safe-top（不是只写在注释里）', () => {
  const kt = readFileSync(
    join(REPO, 'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt'),
    'utf8',
  );
  assert.match(kt, /setProperty\(\s*'--nb-safe-top'/, '必须真的调用 setProperty 注入');
  assert.match(kt, /status_bar_height/, '要读状态栏高度资源');
});

test('★ 安全区兜底要写明"这不是最终解"已被取代', () => {
  /*
   * 上一批（第三批）的 CSS 注释里写着"这只是兜底，根治要 Android 注入"。
   * 第四批做了注入，所以注释必须更新 —— 否则下一个人看到"待根治"
   * 会以为还有活没干，或者反过来以为注入没做。
   */
  const css = cssSrc();
  const i = css.indexOf('max(var(--nb-safe-top');
  const around = css.slice(Math.max(0, i - 900), i);

  assert.match(around, /注入|WindowInsets/, '要说明真实值从 Android 注入');
  assert.match(around, /兜底/, '要说明 24px 仍是兜底');
});
