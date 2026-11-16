/**
 * v0.2.0 第 2、3 步：写回卡片 + 提示词页的作用域 UI（2026-11-15）。
 *
 * ## 这个文件测什么
 *
 * `character-prompts.test.mjs` 测 overlay 的纯函数，
 * `character-prompts-wiring.test.mjs` 测第 1 步的接线（读卡生效）。
 *
 * 这里测**写回**与**界面**：
 *
 * ```text
 *   ① 写进 extensions 之后，别的工具的键必须原样还在（V2 规范 MUST）
 *   ② 清空之后 `tcs.prompts` 要消失，但 `tcs.cardId` 不许跟着消失
 *   ③ 写→读 往返一致（否则"保存成功"但下次打开是旧的）
 *   ④ 界面：作用域切换 / 已改标记 / 恢复按钮 / 上限计数
 *   ⑤ 接线：开关与保存按作用域分流，不许两条路都写同一个地方
 * ```
 *
 * ## 为什么用真 fixture 而不是手造卡
 *
 * `test/fixtures/sample-card.json` 自带 `depth_prompt`（ST 自己的角色专属
 * 提示词）、`unknown_top_level_field`、`fav` —— 正好是"别的工具的键"的
 * 真实样本。手造一个 `{extensions: {}}` 测不出保真问题，因为里面本来
 * 就没有会被弄丢的东西。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  emptyCharacterPrompts,
  parseCharacterPrompts,
  writeCharacterPrompts,
  setCharacterPromptEnabled,
  setCharacterPromptContent,
  upsertOwnPrompt,
  clearOverride,
} from '../shared/dist/chat/index.js';
import { parseStCardText, stringifyStCard } from '../shared/dist/index.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const FIXTURE = read('test/fixtures/sample-card.json');

/** 去注释（判定源码文本时必须做，否注释会骗判据） */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * 按外壳里那条路走一遍：解析卡 → 改 extensions → 序列化。
 *
 * 与 `shell.ts` 的 `saveCharacterPrompts()` 保持**同样的三步**。
 * 不在这里复制粘贴"我以为的流程" —— 那种判据测的是我的想象，
 * 而不是代码真的会做什么。
 */
function writeBack(config, baseText = FIXTURE) {
  const parsed = parseStCardText(baseText);
  const prev = parsed.card.passthrough.data['extensions'];
  const extensions = writeCharacterPrompts(
    prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : null,
    config,
  );
  const updated = {
    ...parsed.card,
    passthrough: { ...parsed.card.passthrough, data: { ...parsed.card.passthrough.data, extensions } },
  };
  return {
    jsonText: stringifyStCard(updated, { indent: 2, entryTitleToComment: true }),
    card: updated,
  };
}

/* ═══════════════════════════════════════════════════════════
   一、写回保真（第 2 步的核心）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ round-trip：写回后 ST 的 depth_prompt / fav / 未知顶层键全都还在', () => {
  /*
   * V2 规范 MUST：Character editors MUST NOT destroy unknown key-value pairs.
   *
   * 这条判据的价值在于**用真卡**。fixture 里 `data.extensions` 有三个键
   * （`talkativeness` / `fav` / `depth_prompt`），顶层还有一个未知键。
   * 整块替换 `extensions` 会一次丢掉前三个，而那种缺陷在界面上完全
   * 看不出来 —— 用户的卡表面正常，只是「深度提示词」悄悄没了。
   *
   * ★ 期望值**从原 fixture 读**，不写死在判据里。
   *   第一版我把 `fav` 写成 `true`、把顶层未知键写成一个字符串 —— 全错，
   *   而那不是在测"保真"，是在测"我记得 fixture 长什么样"。
   *   读出来对比之后，fixture 将来改了内容也不会假红。
   */
  const before = JSON.parse(FIXTURE);
  const config = setCharacterPromptEnabled(
    emptyCharacterPrompts(),
    'main',
    false,
    /* globalEnabled */ true,
  );

  const { jsonText } = writeBack(config);
  const after = JSON.parse(jsonText);

  /* 逐键比对：多一个键、少一个键、改一个值都要红 */
  assert.deepEqual(
    after.data.extensions,
    { ...before.data.extensions, tcs: { prompts: after.data.extensions.tcs.prompts } },
    'data.extensions 除新增的 tcs.prompts 之外必须与原卡逐键相同',
  );
  assert.deepEqual(
    after.unknown_top_level_field,
    before.unknown_top_level_field,
    '顶层未知键也要原样保留',
  );
});

test('★★★★ 写回只加 `tcs.prompts`，不动 `tcs` 下别的键', () => {
  /*
   * `tcs.cardId` 是我们自己在用的（`client/src/session/card-id.ts`）。
   * 写提示词时把它弄丢 = 这张卡的 ID 变了 = 服务端归档多出一条新卡、
   * 历史记录对不上。而现象只是"同步那边多了一张卡"。
   */
  const withId = JSON.parse(FIXTURE);
  withId.data.extensions.tcs = { cardId: 'abcdef123456' };

  const config = setCharacterPromptEnabled(emptyCharacterPrompts(), 'main', false, true);
  const { jsonText } = writeBack(config, JSON.stringify(withId));
  const ext = JSON.parse(jsonText).data.extensions;

  assert.equal(ext.tcs.cardId, 'abcdef123456', 'tcs.cardId 要保留');
  assert.deepEqual(ext.tcs.prompts.overrideOrder.main, { enabled: false }, 'prompts 要写进去');
});

test('★★★★★ 写→读 往返一致（否则"保存成功"但下次打开是旧的）', () => {
  /*
   * 这是"保存了但没生效"的经典成因：写进去的键名/形状与读出来的不一致。
   *
   * 两种错法都不会报错：
   *   · 写 `override_order`（下划线）而读 `overrideOrder` ⇒ 永远读不到
   *   · 写 `own: null` 而读要求数组 ⇒ 静默当空
   */
  let config = emptyCharacterPrompts();
  config = setCharacterPromptEnabled(config, 'main', false, true);

  /*
   * `setCharacterPromptContent` 返回 `{ ok, config }`（它可能拒绝），
   * 不是 config 本身 —— 顺带把这个契约也钉住：写成 `config = 返回值`
   * 会让后面所有操作炸在 `config.own` 上。
   */
  const contentResult = setCharacterPromptContent(
    config,
    'jailbreak',
    '这个角色别啰嗦',
    '全局越狱词',
    false,
  );
  assert.equal(contentResult.ok, true, '非标记位改正文应当成功');
  config = contentResult.config;

  config = upsertOwnPrompt(config, {
    id: 'tcs-1',
    name: '方言',
    content: '说话带点四川口音',
    role: 'system',
    enabled: true,
    injection: { position: 1, depth: 3, order: 90 },
  });

  const { jsonText } = writeBack(config);
  const back = parseCharacterPrompts(JSON.parse(jsonText).data.extensions);

  assert.notEqual(back, null, '写进去的要能读回来');
  assert.deepEqual(back.overrideOrder.main, { enabled: false }, '开关覆盖要往返一致');
  assert.equal(back.overrideOrder.jailbreak.content, '这个角色别啰嗦', '正文覆盖要往返一致');
  assert.equal(back.own.length, 1, '角色特有项要往返一致');
  assert.deepEqual(back.own[0].injection, { position: 1, depth: 3, order: 90 }, '注入位置要往返一致');
  assert.equal(back.own[0].enabled, true);
  assert.equal(back.own[0].role, 'system');
});

test('★★★★ 「恢复卡片默认」后 `tcs.prompts` 消失，但 `tcs.cardId` 还在', () => {
  /*
   * 空配置时留一个 `{version:1, overrideOrder:{}, own:[]}` 会让人以为
   * 这个角色有配置（也让别的工具读到一份没意义的空壳）。所以删干净。
   *
   * 但"删干净"只针对 `tcs.prompts` —— 整个 `tcs` 删掉就把 cardId 带走了。
   */
  const withId = JSON.parse(FIXTURE);
  withId.data.extensions.tcs = { cardId: 'abcdef123456' };

  const { jsonText } = writeBack(emptyCharacterPrompts(), JSON.stringify(withId));
  const ext = JSON.parse(jsonText).data.extensions;

  assert.equal('prompts' in ext.tcs, false, '空配置不该在卡里留空壳');
  assert.equal(ext.tcs.cardId, 'abcdef123456', 'cardId 必须留着');
});

test('★★★ 清空之后 `tcs` 整个消失（其余键都不需要时不留空对象）', () => {
  /*
   * fixture 原本没有 `tcs`。写一份空配置进去，应当什么都不加 ——
   * 否则每次"保存"都会给卡里塞一个空的 `tcs: {}`，而 V2 的
   * 编辑者不该给别人的卡添东西。
   */
  const { jsonText } = writeBack(emptyCharacterPrompts());
  const ext = JSON.parse(jsonText).data.extensions;

  assert.equal('tcs' in ext, false, '没配过就不该有 tcs');
});

/* ═══════════════════════════════════════════════════════════
   二、上限校验（超限必须拒绝，不许截断）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 角色特有项超 20 条要能算出来（UI 与保存都靠它）', async () => {
  const { validateCharacterPrompts, PROMPT_LIMITS } = await import(
    '../shared/dist/chat/index.js'
  );
  let config = emptyCharacterPrompts();
  for (let i = 1; i <= PROMPT_LIMITS.ownCount + 1; i += 1) {
    config = upsertOwnPrompt(config, {
      id: `tcs-${String(i)}`,
      name: `第${String(i)}条`,
      content: '内容',
      role: 'system',
      enabled: true,
    });
  }
  const violations = validateCharacterPrompts(config);
  assert.ok(
    violations.some((one) => one.kind === 'ownCount'),
    '超条数要报 ownCount',
  );
  /* 错误信息必须带具体数字：只说"超出限制"等于让用户自己找 */
  const message = violations.find((one) => one.kind === 'ownCount').message;
  assert.match(message, /21/, '要说出实际条数');
  assert.match(message, /20/, '要说出上限');
});

/* ═══════════════════════════════════════════════════════════
   三、界面结构（第 3 步）
   ═══════════════════════════════════════════════════════════ */

const pageSrc = read('client/src/chat/chat-prompts-page.ts');
const pageCode = stripComments(pageSrc);

test('★★★★ 作用域切换的两个 data-role 都由 key 拼（真机探针靠它定位）', () => {
  /*
   * 钉结构不钉字面量：源码是 `prompts-scope-${key}`，运行时才拼出
   * `prompts-scope-global` / `prompts-scope-character`。
   *
   * 第一版判据若写 `new RegExp('prompts-scope-global')` 就是假红 ——
   * 这个坑本项目踩过（`test/v019-wiring.test.mjs` 里有记录）。
   */
  assert.match(pageCode, /prompts-scope-\$\{key\}/, 'data-role 要用 key 拼');
  assert.match(pageCode, /make\('global'/, '要有全局档');
  assert.match(pageCode, /make\('character'/, '要有本角色档');
  /*
   * 点当前那个不该重绘：重绘会清零滚动位置（§130 真机实测 648→0）。
   */
  assert.match(pageCode, /if \(scope !== key\) btn\.addEventListener/, '点当前档不做任何事');
});

test('★★★★ 两个作用域的文案都说清"改的影响范围"', () => {
  /*
   * 文案判据（用户两次明令）：**读了知道能做什么**。
   *
   * 「全局 / 本角色」这两个词本身不够 —— 用户要判断的是
   * "我在这里改，会影响谁"。所以副标题必须写「所有角色 / 只这个角色」。
   */
  assert.match(pageCode, /'全局'/, '要有全局');
  assert.match(pageCode, /所有角色/, '全局档要说影响所有角色');
  assert.match(pageCode, /只这个角色/, '角色档要说只影响这个角色');
  /*
   * 汇总条那句也要跟着作用域变 —— 它是用户读开关后果的地方。
   */
  assert.match(pageCode, /存在卡里/, '角色作用域要说清改动存到哪');
});

test('★★★★ 「本角色已改」标记只在角色作用域出现', () => {
  /*
   * 全局作用域下显示"有没有角色覆盖"会让用户以为这条在全局下也被改过。
   * 判据钉的就是那个 `inCharacter &&` 前缀 —— 少了它标记会全线误报。
   */
  assert.match(
    pageCode,
    /const overridden = inCharacter && hasOverride/,
    '标记必须限定在角色作用域',
  );
  assert.match(pageCode, /prompt-overridden-tag/, '要有标记元素');
  assert.match(pageCode, /本角色已改/, '要有那句人话');
  assert.match(pageCode, /prompt-own-tag/, '角色特有项要单独标');
});

test('★★★★ 「恢复」两级：单条恢复 + 整角色恢复（后者必须两步确认）', () => {
  const restoreOne = pageCode.slice(pageCode.indexOf('prompt-restore-one'));
  assert.match(restoreOne.slice(0, 1200), /onRestoreOne/, '单条恢复要真的有回调');

  /*
   * 整角色恢复不可逆（用户的改动与卡作者那份存在同一个位置），
   * 必须两步确认 —— 与「删除聊天文件」同一套手势。
   */
  const restoreAll = pageCode.slice(pageCode.indexOf('prompts-restore-all'));
  const seg = restoreAll.slice(0, 2000);
  assert.match(seg, /data-armed/, '要两步确认');
  assert.match(seg, /确认恢复/, '第一步要改文案');
  assert.match(seg, /onRestoreAll/, '第二步要真的调回调');
  /*
   * 失败要把按钮退回去 —— 否则它还挂着"确认恢复？"，
   * 用户会以为已经在恢复了。
   */
  assert.match(seg, /removeAttribute\('data-armed'\)/, '失败要复位按钮');
});

test('★★★★ 上限计数显示"还能加几条"，超限要标红', () => {
  /*
   * ★ `data-role` 是模板拼出来的（`prompts-quota-${...}`），
   *   所以不能搜字面量 `prompts-quota-count` —— 那是假红。
   *   钉的是"有条数与字数两项、且值里带剩余量"。
   */
  assert.match(pageCode, /data-role', 'prompts-quota'/, '要有计数区');
  assert.match(pageCode, /prompts-quota-\$\{/, '条数与字数用同一套模板（两处不许各写一份）');
  assert.match(pageCode, /'角色特有'/, '要有条数那一行');
  assert.match(pageCode, /'正文字数'/, '要有字数那一行');
  assert.match(pageCode, /还能加/, '要说剩余量（用户据此判断能不能再加）');
  assert.match(pageCode, /data-over'/, '超限要标出来');
  /*
   * 「存在卡里」这句不能省：它决定了用户怎么理解"换设备会不会丢"。
   */
  assert.match(pageCode, /存在角色卡里/, '要说清存哪');
});

test('★★★ 只能在角色作用域用时，不画作用域切换条（假控件要删）', () => {
  /*
   * 没选角色 / 角色名拿不到时 `character` 是 undefined。
   * 这时画一个点了没反应的「本角色」等于假控件 —— 本项目反复强调的一条。
   *
   * ★ 两个文件各钉一半：`character !== undefined` 在页面里，
   *   `canUseCharacter` 是外壳算的。第一版把后者也拿到页面源码里搜，
   *   那是假红（判据对象取错了）。
   */
  assert.match(pageCode, /if \(character !== undefined\)/, '拿不到就不画切换条');
  assert.match(shellCode, /const canUseCharacter/, '外壳要判能不能用角色作用域');
  assert.match(shellCode, /canUseCharacter \? this\.promptScope : 'global'/, '拿不到就落回全局');
});

test('★★★ CSS 只用真实存在的 token（引用不存在的变量会静默失效）', () => {
  /*
   * §73 记过：写一个不存在的 CSS 变量**不报错**，只是静默退回继承值。
   * 表现是"看着没生效"，而查起来要翻整个 token 表。
   *
   * 这里把新增那几段用到的变量与 `nebula-tokens.css` 对账。
   */
  const css = read('client/src/chat/chat.css');
  const tokens = read('client/src/chat/nebula-tokens.css');
  const defined = new Set(
    [...tokens.matchAll(/^\s*(--nb-[a-z0-9-]+):/gm)].map((match) => match[1]),
  );

  const start = css.indexOf('作用域切换（全局 / 本角色，v0.2.0）');
  assert.ok(start > 0, '找不到新增的样式段');
  const segment = css.slice(start, css.indexOf('.nb-prompts-summary {', start));

  const used = new Set([...segment.matchAll(/var\((--nb-[a-z0-9-]+)\)/g)].map((m) => m[1]));
  assert.ok(used.size > 10, `这段应当用了一批 token，实际 ${String(used.size)} 个`);
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], `引用了不存在的 token：${missing.join('、')}`);
});

test('★★★★ 跨设备：切换条不写死宽度（§131 硬约束）', () => {
  const css = read('client/src/chat/chat.css');
  const start = css.indexOf('作用域切换（全局 / 本角色，v0.2.0）');
  const segment = css.slice(start, css.indexOf('.nb-prompts-summary {', start));

  assert.doesNotMatch(segment, /\bwidth:\s*\d+px/, '不许写死宽度');
  assert.doesNotMatch(segment, /\bmin-width:\s*\d+px/, '不许写死最小宽度（要写就锚字号）');
  /*
   * 有 `min-height` + 内容可能换行 ⇒ 必须 border-box，否则 padding
   * 会把高度顶出容器（§130 走查 11）。
   */
  assert.match(segment, /box-sizing:\s*border-box/, '有 min-height 就要 border-box');
  assert.match(segment, /min-height:\s*var\(--nb-hit-min\)/, '触屏目标要用 token');
});

/* ═══════════════════════════════════════════════════════════
   四、接线（按作用域分流）
   ═══════════════════════════════════════════════════════════ */

const shellSrc = read('client/src/chat/shell.ts');
const shellCode = stripComments(shellSrc);

/**
 * 取两个锚点之间的一段源码。
 *
 * ## 为什么不用固定字符窗口
 *
 * 第一版写的是 `slice(at, at + 1400)`，而那一段实际有 1420 字符 ——
 * 判据当场红了，而**代码是对的**。改窗口到 2000 只是把炸弹推远：
 * 下次有人给那段加个注释就再红一次，而红的人会以为代码坏了。
 *
 * 本项目已经记过这个坑（§131：固定窗口 `{0,2000}?`，函数开头加注释就假红）。
 * 用两个**语义锚点**切片，长度由代码决定，不由我猜。
 */
function between(code, startNeedle, endNeedle) {
  const at = code.indexOf(startNeedle);
  assert.ok(at >= 0, `找不到起点锚：${startNeedle}`);
  const end = code.indexOf(endNeedle, at + startNeedle.length);
  assert.ok(end > at, `找不到终点锚：${endNeedle}（在起点之后）`);
  return code.slice(at, end);
}

test('★★★★★ 开关按作用域分流：全局写预设、角色写卡片', () => {
  /*
   * 这是第 3 步最容易写错的一处。判据要看**三元**的两个分支
   * 各自指向不同函数 —— 少一个分支就变成"角色作用域下改了全局预设"，
   * 而后果是所有角色一起变，用户完全想不到。
   */
  const seg = between(shellCode, 'togglePrompt: (identifier, enabled) =>', 'onNotify: (message, kind) =>');

  assert.match(seg, /scope === 'character'/, '要按作用域判断');
  assert.match(seg, /saveCharacterPrompts/, '角色作用域写卡片');
  assert.match(seg, /savePromptToggle/, '全局作用域写预设');
});

test('★★★★★ 角色作用域下改开关，与全局相同就删掉覆盖项', () => {
  /*
   * 不删的话 `overrideOrder` 里会攒一堆"恰好等于全局值"的条目，
   * 「本角色已改」标记会全线误报 —— 而用户会以为这个角色到处都定制过。
   *
   * 这条逻辑在 `setCharacterPromptEnabled` 里（纯函数，有判据）。
   * 这里钉的是**外壳真的调了它**、并把全局值传了进去 —— 传错的话
   * 判断基准错了，覆盖项该删的时候不删。
   */
  assert.match(shellCode, /setCharacterPromptEnabled\(current, identifier, enabled, globalEnabled\)/,
    '要把全局值当基准传进去');
  assert.match(shellCode, /globalPromptConfig\?\.order\?\.find/, '基准值要从全局配置取');
});

test('★★★★ 角色作用域下改角色特有项的开关，不许走 overrideOrder', () => {
  /*
   * 角色特有项（`tcs-*`）在全局里不存在，`setCharacterPromptEnabled`
   * 会把它写进 `overrideOrder` —— 而那个键在全局里没有对应条目，
   * 合成时被静默忽略 ⇒ 开关点了没反应。
   */
  const seg = between(shellCode, 'togglePrompt: (identifier, enabled) =>', 'savePromptToggle(identifier');
  assert.match(seg, /ownIndex/, '要先看是不是角色特有项');
  assert.match(seg, /own\[ownIndex\] = \{ \.\.\.own\[ownIndex\], enabled \}/, '特有项改它自己的 enabled');
});

test('★★★★★ 编辑页在角色作用域下只能改正文（其余字段置灰）', () => {
  /*
   * 角色级只存正文覆盖（`overrideOrder[id].content`）。
   * 如果编辑页还让人改名称/位置，那些值**没有地方存** ——
   * 保存后"看着改了但没变"，是最坏的一类缺陷。
   */
  const editSrc = stripComments(read('client/src/chat/chat-prompt-edit-page.ts'));
  assert.match(editSrc, /contentOnly/, '编辑页要支持只改正文');
  assert.match(editSrc, /prompt-edit-content-only-note/, '要告诉用户为什么置灰');
  assert.match(editSrc, /data-locked/, '置灰要有标记（探针与样式靠它）');

  /* 外壳要真的算出来并传进去 */
  assert.match(shellCode, /const contentOnly = inCharacterScope && id !== null && !editingOwnPrompt/,
    '外壳要判"在角色作用域且编辑的不是特有项"');
  assert.match(shellCode, /contentOnly: true/, '要传给编辑页');
});

test('★★★★ 删除在角色作用域下的语义不同（全局条目不许删）', () => {
  /*
   * 全局预设里的那条属于预设，删掉会让所有角色都少一条。
   * 而在角色作用域下用户看到的"删除"按钮长一样 ——
   * 所以必须拒绝并给替代方案（关掉它）。
   */
  const seg = between(shellCode, 'private async deletePromptById', 'private async mutatePromptPreset');
  assert.match(seg, /promptScope === 'character'/, '要按作用域分流');
  assert.match(seg, /removeOwnPrompt/, '特有项可以删');
  assert.match(seg, /会影响所有角色/, '删全局条目要说清后果');
  assert.match(seg, /把它关掉/, '要给替代方案');
});

test('★★★★ 写回用当前状态重读 PNG，不用内存副本', () => {
  /*
   * 内存副本可能是旧的（用户刚在 ST 网页里改过这张卡）。
   * 用旧副本当基底写回 = 把用户刚做的改动抹掉，而 PNG 里的旧版本
   * 已经没了 ⇒ **不可逆**。
   *
   * 判据钉"写回函数体内有重新读 PNG 的那一句"，而不是钉顺序
   * （钉顺序会被无关重构弄红）。
   */
  const seg = between(shellCode, 'private async saveCharacterPrompts', 'private async restoreCharacterPrompts');

  assert.match(seg, /this\.bridge\.characterPng\(avatar\)/, '要重读 PNG');
  assert.match(seg, /parsePngCard/, '要解析 PNG');
  assert.match(seg, /parseStCardText/, '要解析卡 JSON');
  assert.match(seg, /writeCharacterPrompts/, '要写 extensions');
  assert.match(seg, /buildPngCard/, '要嵌回 PNG');
  /*
   * ★ 2026-11-16 起落盘收口到 `writeCardPng()`（它负责作废分享缓存）。
   *   判据钉"走了收口"而不是"直接调 bridge" —— 后者已不允许
   *   （见 test/share-cache-freshness.test.mjs 第 1 例）。
   */
  assert.match(seg, /this\.writeCardPng\(/, '要落盘（走收口，才会作废分享缓存）');
  /*
   * 上限校验必须在写盘之前 —— 反过来的话卡已经被改坏了才发现超限。
   */
  const validateAt = seg.indexOf('validateCharacterPrompts');
  const writeAt = seg.indexOf('this.writeCardPng(');
  assert.ok(validateAt > 0, '要有上限校验');
  assert.ok(writeAt > 0, '要写盘');
  assert.ok(validateAt < writeAt, '校验必须在写盘之前');
});

test('★★★★ 写盘成功后才更新内存（失败不许让界面显示已保存）', () => {
  const seg = between(shellCode, 'private async saveCharacterPrompts', 'private async restoreCharacterPrompts');
  /* 落盘收口之后，这一句代表"写盘"这件事（见上面那条判据的说明） */
  const writeAt = seg.indexOf('this.writeCardPng(');
  const memAt = seg.indexOf('this.characterPrompts = isCharacterPromptsEmpty');
  assert.ok(writeAt > 0 && memAt > 0, '找不到写盘与更新内存');
  assert.ok(writeAt < memAt, '先落盘、后更新内存');
});
