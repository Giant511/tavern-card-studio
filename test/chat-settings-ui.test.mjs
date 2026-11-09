/**
 * 第三批 · 问题二：聊天页设置入口与四项配置（2026-10-31）。
 *
 * ## 这组守的核心缺陷类型
 *
 * 1. **入口没接线** —— 第一次实现时 `makeSettingsCallbacks()` 里漏了
 *    `onOpenGroup`，而 `chat-settings.ts` 那边是 `callbacks.onOpenGroup?.()`
 *    可选调用。于是：菜单渲染正常、四项都在、**点下去毫无反应**。
 *    这类"实现存在但没接线"是本项目最反复的缺陷。
 *
 * 2. **读不到设置却渲染表单** —— 会拿 fallback 冒充真实值，
 *    用户在上面改、一保存就把真实设置覆盖成 fallback（静默数据丢失）。
 *
 * 3. **顶栏挂一个点了没反应的按钮** —— 比不挂更糟。
 *
 * ## 为什么断言"接线"而不是"函数存在"
 *
 * 函数存在这件事，`grep` 一下就有；但链路通不通要看**谁把它接上了**。
 * 所以这里的判据是"外壳必须给这个回调赋值"，不是"某个文件里有这个名字"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const shellSrc = () => readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
const settingsSrc = () => readFileSync(join(CHAT_DIR, 'chat-settings.ts'), 'utf8');
const panelSrc = () => readFileSync(join(CHAT_DIR, 'chat-panel.ts'), 'utf8');

function functionSource(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `找不到 ${signature}`);
  let depth = 0;
  let started = false;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') {
      depth += 1;
      started = true;
    } else if (source[i] === '}') {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`${signature} 大括号没配平`);
}

/* ═══════════════════════════════════════════════════════════
   一、顶栏设置按钮
   ═══════════════════════════════════════════════════════════ */

test('★ 问题二：聊天页顶栏有设置按钮，且只有给了回调才渲染', () => {
  /*
   * 没有路由能力时挂一个点了没反应的按钮，比不挂更糟 ——
   * 用户会以为功能坏了。所以是条件渲染，不是无条件渲染。
   */
  const src = panelSrc();

  assert.match(src, /data-role',\s*'chat-settings-open'/, '要有设置按钮');
  assert.match(
    src,
    /if\s*\(\s*this\.callbacks\.onOpenChatSettings\s*!==\s*undefined\s*\)/,
    '设置按钮要在有回调时才渲染',
  );
  assert.match(src, /onOpenChatSettings\?:\s*\(\)\s*=>\s*void/, 'ChatPanelCallbacks 要有 onOpenChatSettings');
});

test('★ 问题二：齿轮图形在 CSS 里，TS 里不许写 innerHTML', () => {
  /*
   * ## 这条判据换过一次，两次都在守同一件事：字形可控
   *
   * 第一版断言"必须是 `<svg>` 且不许用 ⚙ emoji"，理由是对的：
   * emoji 在不同 ROM 上字形差异很大，有的系统里 ⚙ 是彩色方块。
   *
   * 但第一版实现是 `settingsBtn.innerHTML = '<svg …>'`，被
   * `test/nebula-walkthrough.test.mjs` 的硬门当场拦住
   * （「所有 innerHTML 必须走 renderMessageHtml」，起因是流式路径上
   * 真的漏过 `innerHTML = 模型原文`）。
   *
   * 改法：图形挪到 CSS（`mask` + 内联 SVG 蒙版，`background-color: currentColor`
   * 跟主题色）。于是这条判据也跟着改成守**新的形态**：
   *   · TS 里不写 innerHTML
   *   · CSS 里有对应的蒙版规则（否则按钮是个空白方块）
   *   · 仍然不许用 emoji 字符（原意不变）
   */
  const ts = panelSrc();
  const css = readFileSync(join(CHAT_DIR, 'chat.css'), 'utf8');
  const tokens = readFileSync(join(CHAT_DIR, 'nebula-tokens.css'), 'utf8');

  const i = ts.indexOf("data-role', 'chat-settings-open'");
  assert.ok(i > 0, '找不到设置按钮');
  const seg = ts.slice(i, i + 700);

  assert.doesNotMatch(seg, /\.innerHTML\s*=/, '设置按钮不许写 innerHTML（硬门：XSS 入口）');
  assert.doesNotMatch(seg, /textContent\s*=\s*'[⚙🔧🛠]/, '不许用 emoji 字符当齿轮（字形不可控）');

  // CSS 侧必须真的画出齿轮
  assert.match(
    css,
    /\.nb-icon-btn\[data-role='chat-settings-open'\]::before/,
    'CSS 里要有齿轮的绘制规则（否则按钮是空白方块）',
  );
  assert.match(css, /var\(--nb-gear-mask\)/, '齿轮要用 --nb-gear-mask 蒙版');

  // 蒙版 token 必须在 token 文件里，且是内联 SVG
  assert.match(tokens, /--nb-gear-mask:\s*url\("data:image\/svg\+xml,/, '--nb-gear-mask 要定义在 token 文件里（内联 SVG）');
});

/* ═══════════════════════════════════════════════════════════
   二、菜单 → 分组页的接线（本批最值得守的一条）
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题二：外壳必须给 onOpenGroup 赋值（否则点了没反应）', () => {
  /*
   * 第一次实现漏了这一行，症状是"菜单正常、点下去停在原地"。
   * `chat-settings.ts` 用的是 `callbacks.onOpenGroup?.()` —— 可选调用，
   * 没接线时它安静地什么也不做，不报错、不告警。
   */
  const src = shellSrc();
  const cb = functionSource(src, 'private makeSettingsCallbacks');

  assert.match(cb, /onOpenGroup:/, `makeSettingsCallbacks 必须给 onOpenGroup 赋值，实际：\n${cb.slice(0, 500)}`);
  assert.match(cb, /this\.chatSettingsRoute\s*=\s*groupId/, 'onOpenGroup 要把路由切到该组');
});

test('★ 问题二：菜单项点击走 onOpenGroup（不是自己改路由）', () => {
  /*
   * 页面不该知道外壳有 `chatSettingsRoute` 这个字段 —— 它只负责
   * "用户点了哪一项"。让它改外壳状态，两处都能改，谁最后生效说不清。
   */
  const src = settingsSrc();
  assert.match(src, /callbacks\.onOpenGroup\?\.\(group\.id\)/, '菜单项要把 group.id 交出去');
  assert.doesNotMatch(src, /chatSettingsRoute/, '页面不该碰外壳的路由字段');
});

test('★ 问题二：切 Tab 要清掉二级路由', () => {
  /*
   * 不清的后果：用户在「聊天 → 设置 → AI 响应配置」停留，切到「卡片」
   * 再切回「聊天」，会直接落在那张表单上，聊天记录看不见 ——
   * 用户第一反应是"我的对话没了"。
   */
  const src = shellSrc();
  const switchTab = functionSource(src, 'switchTab(id: TabId)');

  assert.match(
    switchTab,
    /this\.chatSettingsRoute\s*=\s*null/,
    '切 Tab 必须把聊天设置的二级路由清掉',
  );
});

test('★ 问题二：返回方向按层走（分组页→菜单→聊天）', () => {
  /*
   * ## 2026-11-03 改过一次：从"钉表达式"改成"钉行为"
   *
   * 原判据要求源码里出现 `this.chatSettingsRoute === 'menu' ? null : 'menu'`。
   *
   * 那句表达式**本身就是 bug 的一部分**：
   *
   * ```text
   *   旧：files   → menu   （应为 actions）
   *       prompts → menu   （应为 sampling）
   * ```
   *
   * 用户报的「提示词管理点返回直接退到聊天设置」正是它。
   * 所以这一条不是在"为了让测试变绿而改测试"——
   * 它原本钉的那个写法，恰好是错的写法。
   *
   * 现在它钉三件事，覆盖的意图与原判据一致且更全：
   *   1. onBack 走统一入口（不再各自写死目标）
   *   2. 层级的答案来自 `parentRouteOf`
   *   3. "菜单 → 聊天"这一层确实是 null（原判据最想守的那点）
   *
   * 逐条层级由 `test/back-navigation.test.mjs` 直接单测纯函数。
   */
  const src = shellSrc();
  const cb = functionSource(src, 'private makeSettingsCallbacks');

  assert.match(cb, /this\.goBackOneLevel\(\)/, 'onBack 要走统一入口');

  /* 原判据最想守的：菜单的上一级是聊天（null），不是它自己 */
  const nav = readFileSync(join(REPO, 'shared', 'src', 'chat', 'nav.ts'), 'utf8');
  assert.match(nav, /if \(route === 'menu'\) return null/, "'menu' 的上一级必须是 null（否则返回会死循环）");
});

/* ═══════════════════════════════════════════════════════════
   三、四项菜单的顺序与文案
   ═══════════════════════════════════════════════════════════ */

test('★ 问题二：菜单渲染四项，顺序来自单一真相', () => {
  /*
   * 顺序不能在这里硬编码 —— `CHAT_SETTINGS_GROUPS` 是单一真相
   * （`chat-settings-schema.ts`，测试逐字钉住顺序）。
   */
  const src = settingsSrc();
  assert.match(src, /for\s*\(const group of CHAT_SETTINGS_GROUPS\)/, '菜单要遍历单一真相常量');
  assert.doesNotMatch(src, /'AI 响应配置'/, '菜单文案不许在页面里另写一份');
});

test('★ 问题二：世界书与「用户 UI 设置」不伪装成表单', () => {
  /*
   * 这两项都没有内容页（世界书是 /api/worldinfo/* 的实体管理，
   * UI 设置还没做）。本版给一句「暂不支持」——
   * 不写成"正在加载"那种含糊话，也不给一张空表单。
   *
   * ★ 2026-11-04 变化：原来第二条是 persona（用户设置），
   * 现在改成 ui —— persona 挪到「卡片」Tab 去了（那边是真功能），
   * 这一项改名「用户 UI 设置」回到它本来的语义（界面外观）。
   *
   * ★ 文案只许「暂不支持」，不许写原因（用户明令）。
   */
  const src = shellSrc();
  const fn = functionSource(src, 'private renderChatSettingsSection');

  assert.match(fn, /groupId\s*===\s*'worldbook'/, '要单独处理世界书');
  assert.match(fn, /groupId\s*===\s*'ui'/, '要单独处理用户 UI 设置');
  assert.match(fn, /renderEmptyState/, '这两项要给明确空状态，不是空白');
});

/* ═══════════════════════════════════════════════════════════
   四、读不到设置时不许渲染表单
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题二：读不到设置时只给提示，不渲染表单', () => {
  /*
   * 渲染了就等于拿 fallback 冒充真实值。用户在它上面改，一保存
   * 就把真实设置覆盖成 fallback —— 静默数据丢失。
   * 这是 `mutateSettings` 三道防线之外、界面层的第四道。
   */
  const src = settingsSrc();
  const fn = functionSource(src, 'export function renderFieldSection');

  // 有 null 分支且该分支里不渲染表单
  assert.match(fn, /settings\s*===\s*null/, '要判断读到 null');
  const nullBranch = fn.slice(fn.indexOf('settings === null'), fn.indexOf('status.textContent =', fn.indexOf('settings === null')));
  assert.doesNotMatch(nullBranch, /for\s*\(const field of section\.fields\)/, 'null 分支里不许构建字段表单');
});

test('★ 问题二：外壳的 loadSettings 失败时返回 null（不是空对象）', () => {
  /*
   * 返回 `{}` 会让页面拿 fallback 渲染出一张"看起来正常"的表单。
   * 返回 null 才会走上面那条"只给提示"的分支。
   */
  const src = shellSrc();
  const cb = functionSource(src, 'private makeSettingsCallbacks');

  /*
   * 2026-11-01 第五批把这里改成了 if/else 形状（因为要顺手记下失败原因，
   * 供 `describeReadFailure()` 归因）。原来是三元 `return parsed.ok ? ... : null`。
   *
   * 判据的**意图没变**：解析失败要给 null（不是空对象）；
   * 所以改成断言"两个失败分支都 return null"。
   */
  assert.match(cb, /if \(!parsed\.ok\)[\s\S]{0,200}?return null;/, '解析失败要给 null');
  assert.match(cb, /catch[\s\S]{0,600}?return null;/, '读异常也要给 null');

  // 反向：任何地方都不许把空对象当"读到"返回
  assert.doesNotMatch(cb, /return \{\};/, '失败时不许返回空对象（会被当成"设置是空的"）');
});

/* ═══════════════════════════════════════════════════════════
   五、保存必须走 mutateSettings
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题二：保存走 mutateSettings，不许直接整份覆盖', () => {
  /*
   * `bridge.settingsSave` 是**整份覆盖**（无 patch 语义）。
   * 直接调它少一个字段就把用户设置清空了。
   */
  const src = shellSrc();
  const cb = functionSource(src, 'private makeSettingsCallbacks');

  assert.match(cb, /mutateSettings\(/, '保存必须走 mutateSettings');
  assert.doesNotMatch(
    cb,
    /await\s+this\.bridge\.settingsSave\s*\(/,
    '不许在回调里直接调 settingsSave（那是整份覆盖）',
  );
  /*
   * 但 mutateSettings 的 transport 里要用它 —— 那是正确用法。
   *
   * 2026-11-01 第五批：transport 变成包过连接门的箭头函数：
   *   save: (settings) => this.withConnection(() => this.bridge.settingsSave(settings))
   * 判据的意图不变：**最终还是要落到 settingsSave**（只是中间多了一道门）。
   */
  assert.match(
    cb,
    /save:\s*\(settings\)\s*=>[\s\S]{0,120}?this\.bridge\.settingsSave\(settings\)/,
    'mutateSettings 的 transport 要接到 settingsSave（经连接门）',
  );
});

/* ═══════════════════════════════════════════════════════════
   六、卡片 Tab 的两个入口
   ═══════════════════════════════════════════════════════════ */

test('★ 问题二：卡片 Tab 有卡编辑与用户设定两个入口', () => {
  const src = shellSrc();
  const fn = functionSource(src, 'private renderCardsTab');

  assert.match(fn, /'card-edit-entry'/, '要有卡编辑入口');
  assert.match(fn, /'persona-entry'/, '要有用户设定管理入口');
  assert.match(fn, /this\.renderAccordion\(/, '两个入口要用与「我的」页相同的收纳项组件');
  assert.doesNotMatch(fn, /renderApiPage|api-entry/, 'API 连接不在卡片 Tab（已在「我的」）');
});

test('★ 卡片 Tab 的条目：要么纯说明（点了不展开），要么真的能打开', () => {
  /*
   * ## 这条判据的意图（2026-11-04 更新）
   *
   * 原来钉的是「两个条目都 `onToggle: () => false`」—— 那时它们都是纯说明，
   * 做成可折叠会让用户以为"里面还有配置"，点开只有一句话。
   *
   * 现在「用户设定管理」**真的做出来了**，它应该能点开。所以判据从
   * "必须是纯说明"改成"**不许有第三种情况**"：
   *
   * ```text
   *   纯说明      → onToggle: () => false        ✅
   *   真能打开    → onToggle 里做状态变更/重绘    ✅
   *   看着能点    → onToggle 里什么都不做         ❌
   *   但什么都不发生
   * ```
   *
   * 第三种才是真正要防的：摆了入口、点了没反应。
   */
  const src = shellSrc();
  const fn = functionSource(src, 'private renderCardsTab');

  /*
   * 用**计数**判断，不用正则切块。
   *
   * 第一版按缩进切块（`\n {6}\},`），实际缩进一变就切不到（恒为 0 块），
   * 于是判据变成"永远不通过"。计数式不依赖排版。
   */
  const total = (fn.match(/onToggle:/g) ?? []).length;
  assert.ok(total >= 2, `应该至少两个条目，实际 ${String(total)}`);

  const pureNote = (fn.match(/onToggle:\s*\(\)\s*=>\s*false/g) ?? []).length;
  const reallyOpens = (fn.match(/this\.[a-zA-Z]+\s*=\s*true/g) ?? []).length;

  assert.equal(
    pureNote + reallyOpens,
    total,
    `有 ${String(total - pureNote - reallyOpens)} 个条目既不是纯说明、也没有真的打开任何东西（摆了入口点了没反应）`,
  );
});

test('★ 问题二：renderAccordion 的 onToggle 返回值决定是否展开', () => {
  /*
   * 第一版靠"读 DOM 的 aria-expanded 再翻转"，于是空 onToggle 的说明条目
   * 点一下也会展开。现在由返回值决定 —— 这条守的就是"读返回值"。
   */
  const src = shellSrc();
  const fn = functionSource(src, 'private renderAccordion');

  assert.match(fn, /const shouldFlip = spec\.onToggle\(\)/, '要读 onToggle 的返回值');
  assert.match(fn, /if\s*\(!shouldFlip\)\s*return/, '返回 false 时直接返回，不翻状态');
});

/* ═══════════════════════════════════════════════════════════
   六、保存成功后的提示顺序（2026-11-03 真机定位）
   ═══════════════════════════════════════════════════════════ */

test('★ 保存成功后必须先 onBack() 再提示，否则提示会被 topbar 重建吞掉', () => {
  /*
   * ## 这个缺陷长什么样
   *
   * 用户点保存 → 数据真的存进去了（ST 侧读得到）→ 但屏幕上**一个字都没有**。
   *
   * 原因不是"没写提示"，而是**顺序**：
   *   `.nb-notify` 挂在 `.nb-topbar` 里（`client/src/mobile/main.ts`），
   *   而 `onBack()` 会 `renderPage()` **重建出一个新的 topbar**。
   *   先提示、后导航 ⇒ 刚插进旧 topbar 的那条通知随旧元素一起脱离文档。
   *
   * 真机取证（`.verify/probe-save-notify.mjs`）：
   *
   * ```text
   *   349ms  add    "已保存 1 项"     ← 确实创建了
   *   509ms  notifyCount = 0          ← document 里已经找不到
   *  3549ms  remove "已保存 1 项"     ← 定时器到点，从废弃的旧 topbar 摘掉
   *
   *  topbarSame = false               ← topbar 被换成新元素
   *  notifyInOldTopbar = true         ← 通知还挂在那个废弃元素上
   * ```
   *
   * ## 为什么这里断言"源码里的先后"而不是"跑一遍看效果"
   *
   * 效果层面要真 DOM + 真 topbar 重建才复现，单测里没有那套东西；
   * 而缺陷的全部成因就是**这两句的先后**。所以直接钉顺序：
   * 改成先提示后导航，这条必红。
   */
  const src = settingsSrc();
  const block = functionSource(src, "save.addEventListener('click'");

  const BACK = 'callbacks.onBack()';
  const NOTIFY = 'callbacks.onNotify?.(`已保存';

  const iBack = block.indexOf(BACK);
  const iNotify = block.indexOf(NOTIFY);

  assert.ok(iBack >= 0, '保存成功分支里要有 onBack()');
  assert.ok(iNotify >= 0, '保存成功分支里要有「已保存 N 项」提示');
  assert.ok(
    iBack < iNotify,
    '先 onBack() 再提示 —— 反过来的话 onBack 重建 topbar，提示挂在旧元素上，用户看不到',
  );
});

/* ═══════════════════════════════════════════════════════════
   七、预设切换 / 导入（2026-11-03 / 任务 #259）
   ═══════════════════════════════════════════════════════════ */

test('★ 预设行要接进设置页，且三个动作都要接线', () => {
  /*
   * 本项目最反复的缺陷类型是"实现存在但没接线"（已出现 5 次）。
   * 所以这里断言三件事：
   *   ① 设置页会渲染预设行（有 `renderPresetBar` 调用）；
   *   ② 三个动作都调了（list / apply / importFile）；
   *   ③ 外壳**给了** `presets` 回调（否则页面上的 `callbacks.presets` 恒 undefined，
   *      整块静默不渲染，而界面看起来"就是没有这个功能"）。
   */
  const src = settingsSrc();

  assert.match(src, /if \(callbacks\.presets !== undefined\) \{/, '没有预设回调时不该渲染预设行');
  assert.match(src, /renderPresetBar\(callbacks\.presets\)/, '要真的把预设行画出来');

  const bar = functionSource(src, 'function renderPresetBar');
  assert.match(bar, /presets\.list\(\)/, '要读预设列表');
  assert.match(bar, /presets\.apply\(/, '切换要调 apply');
  assert.match(bar, /presets\.importFile\(\)/, '导入要调 importFile');

  /* 外壳必须给回调 */
  const shell = shellSrc();
  assert.match(shell, /presets: this\.makePresetCallbacks\(\)/, '外壳必须把预设回调交给设置页');
});

test('★ 预设切换失败时下拉要拨回原值（界面不许骗人）', () => {
  /*
   * 用户点选后触发器的显示值立刻就变了。apply 失败若不拨回去，
   * 界面显示"已切到 Creative"，实际还是 Default —— 用户接着按新预设
   * 理解生成结果，得到的是错归因。
   *
   * ★ 2026-11-03 契约变更：下拉不再是 `<select>`，所以不再有
   * `select.value = ...`；改为 `presetSelect.setValue(currentPreset)`。
   * 断言跟着改**语义**（拨回原值），不钉字面。
   */
  const bar = functionSource(settingsSrc(), 'function renderPresetBar');

  const failBranch = bar.slice(bar.indexOf('if (!result.ok)'));
  assert.match(
    failBranch.slice(0, 500),
    /presetSelect\.setValue\(currentPreset\)/,
    '切换失败必须把下拉拨回当前值',
  );
});

test('★ 导入被用户取消时不许弹错误提示', () => {
  /*
   * 「取消」不是错误。`reason` 空串就是取消的约定（见 `pick_json_file` 三态）。
   * 直接 `onNotify?.(result.reason ?? '导入失败')` 会在取消时弹一条空提示 ——
   * 而改成"把空串当失败原因"会让用户以为文件有问题。
   */
  const src = settingsSrc();
  const block = functionSource(src, "importBtn.addEventListener('click'");

  assert.match(block, /result\.reason !== ''/, '要显式区分"取消"（空 reason）与真失败');
  assert.match(block, /return;/, '取消要直接返回');
});

test('★★ 预设：切换与导入成功时都必须先 onBack() 再提示', () => {
  /*
   * ## 同一个成因，我在这一批里又犯了一次
   *
   * §86 已经为「保存成功后先提示再 onBack」修过一次：
   * `.nb-notify` 挂在 `.nb-topbar` 里，而 `onBack()` → `renderPage()`
   * 会重建 topbar ⇒ 提示随旧元素脱离文档。
   *
   * 2026-11-03 真机复验预设切换时，现象一模一样：
   * **ST 里 temperature 确实变了**（④⑤⑥ 全绿），但屏幕上没有任何反馈，
   * 用户会以为没点上、再点一次。
   *
   * ## 为什么这条判据要单独存在
   *
   * 「保存」那条判据只看 `save.addEventListener` 那段，
   * 覆盖不到预设的 `select.change` 与 `importBtn.click` 两个分支。
   * 一处被证实、就要扫同类 —— 这次扫出 2 处。
   */
  const src = settingsSrc();

  /*
   * ★ 2026-11-03：切换逻辑从 `select.addEventListener('change')` 抽成了
   * `applyPreset()`（导入成功后也要走同一条路径，复制两份会慢慢分叉）。
   * 断言跟着看那段函数。
   */
  const changeBlock = functionSource(src, 'function applyPreset');
  const iBackChange = changeBlock.indexOf('callbacks.onBack()');
  const iNotifyChange = changeBlock.indexOf('已切换到');
  assert.ok(iBackChange >= 0, '切换成功分支要有 onBack()');
  assert.ok(iNotifyChange >= 0, '切换成功分支要有「已切换到」提示');
  assert.ok(iBackChange < iNotifyChange, '切换：先 onBack() 再提示');

  const importBlock = functionSource(src, "importBtn.addEventListener('click'");
  /*
   * 导入分支里 `onBack()` 出现在「已导入」之前才算对。
   * 注意这里不能用 `indexOf('callbacks.onBack()')` 找最前面的出现位置 ——
   * 失败/取消分支里也可能出现，所以取**「已导入」附近**那一段比较。
   */
  const iNotifyImport = importBlock.indexOf('已导入预设');
  assert.ok(iNotifyImport >= 0, '导入成功分支要有「已导入预设」提示');
  const beforeNotify = importBlock.slice(0, iNotifyImport);
  assert.ok(beforeNotify.includes('callbacks.onBack()'), '导入：onBack() 必须在「已导入」提示之前');
});

/* ═══════════════════════════════════════════════════════════
   八、下拉不许用原生 <select>（2026-11-03）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 枚举字段不许用原生 <select>（真机弹窗白底白字，改不了）', () => {
  /*
   * ## 用户报的现象
   *
   * > AI 响应配置的所有下拉框里面都显示不出来，而且这个下拉框的样式有点丑，
   * > 和 APP 的 UI 风格一点也不搭，不要这种弹窗式的
   *
   * ## 真机取证（录屏抽帧 + `.verify/probe-select-box.mjs`）
   *
   * `<select>` **元素本身完全正常**：
   *
   * ```text
   *   rect = 361×51        color = rgb(244,242,251)      bg = rgb(28,25,41)
   *   value = "auto"       selectedText = "自动"          options = 6 个
   * ```
   *
   * 坏的是**点开后的系统弹窗**：白底 + 白字，6 个选项一个都看不见。
   * 那个弹窗是 WebView 用系统控件画的 —— 只认 `color-scheme`、
   * 不认我们的 token，而且 `<option>` 的样式写 CSS **无效**。
   *
   * ## 所以判据只能这么写
   *
   * 这个缺陷在 DOM 层面**看不出来**（元素、文字、选项全对），
   * 只有"真人点开看一眼"才发现。而"有没有用原生 select"是可以静态判定的 ——
   * 只要不再有 `<select>`，那个弹窗就不可能再出现。
   */
  const src = settingsSrc();

  assert.equal(
    /el\(doc,\s*'select'/.test(src),
    false,
    '设置页不许再创建 <select>：它的系统弹窗白底白字且样式改不了',
  );
  assert.equal(
    /HTMLSelectElement\)\.value/.test(src),
    false,
    '不许再读 <select>.value（元素已经换掉了，读到的是 undefined）',
  );

  /* 必须走自己画的面板 */
  assert.match(src, /makeSelectTrigger\(doc,/, '枚举字段要用自己画的触发器');
  /*
   * ★ 2026-11-03：第一版做成底部面板（`select-sheet.ts`），用户否掉了 ——
   * 「我偏向于这种下拉框」（贴着控件展开）。现在是 `select-popover.ts`。
   * 详细判据见 `test/select-popover.test.mjs`，这里只钉"接上了"。
   */
  const popover = readFileSync(join(CHAT_DIR, 'select-popover.ts'), 'utf8');
  assert.match(popover, /data-role',\s*'select-popover'/, '面板要有可定位的 data-role');
  assert.match(popover, /placePopover\(/, '位置要交给 placePopover 算');
});

test('★ 自己画的下拉：选中值是字符串，但要按字段真实类型还原后提交', () => {
  /*
   * `names_behavior` 在 ST 里是数字（-1/0/1/2），而 DOM 属性永远是字符串。
   * 不做还原会存成 `"0"`，ST 那边 `switch (names_behavior)` 用严格比较
   * ⇒ 永不命中 ⇒ 静默按默认处理（保存成功、行为没变）。
   */
  const src = settingsSrc();
  const block = functionSource(src, "save.addEventListener('click'");

  assert.match(
    block,
    /typeof field\.fallback === 'number' \? Number\(raw\) : raw/,
    '枚举要按 fallback 的类型把字符串还原成数字',
  );
  assert.match(block, /getAttribute\('data-value'\)/, '要从 data-value 读当前值（不再是 .value）');
});
