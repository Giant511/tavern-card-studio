/**
 * 角色级记忆（2026-11-22，v0.2.2）。
 *
 * ## 用户定的五条（都在这份判据里）
 *
 * ```text
 * ① 不随角色卡，只存本地（localStorage），不写进 PNG
 * ② 导出是单独 JSON，只有角色名 + 记忆条目
 *    —— 明确要求不放卡设定 / 世界书 / 提示词
 * ③ 上限 3000 字符
 * ④ 条目化；点气泡原文预填，不调 LLM（省按次计费）
 * ⑤ 超 3000 实时提醒 + 保存置灰，改到以下才可保存
 * ```
 *
 * ## 判据分层
 *
 * ```text
 * A. 纯函数（shared/src/chat/memory.ts）   直接调，最可靠
 * B. 注入位置（两条拼装路径）              调 assembleWithPrompts / assembleContext
 * C. 界面与接线（源码静态断言）            行为要在真机验，这里钉"代码是这么写的"
 * ```
 *
 * C 层不能省：判据写得再对，只要接线漏一处，功能就是不生效 ——
 * 而"不生效"在界面上看起来完全正常（memory §160 的教训）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

import {
  MEMORY_MAX_CHARS,
  MEMORY_VERSION,
  buildExportFile,
  emptyMemoryStore,
  isEntryStorable,
  memoryBudgetView,
  memoryExportFileName,
  memoryOf,
  memoryTokens,
  mergeImported,
  nextEntryId,
  parseImportFile,
  parseMemoryStore,
  remainingChars,
  renderMemoryBlock,
  usedChars,
  withMemoryOf,
  withinLimit,
  assembleWithPrompts,
  assembleContext,
  parsePromptConfig,
} from '../shared/dist/index.js';

/** 造一张最小可用的卡 */
const CARD = {
  name: '西奥',
  description: '一个角色',
  personality: '',
  scenario: '',
  first_mes: '你好',
  mes_example: '',
};

/** 一条记忆 */
const entry = (id, text) => ({ id, text, at: 0 });

/* ═══════════════════════════════════════════════════════════
   A. 纯函数
   ═══════════════════════════════════════════════════════════ */

test('上限就是 3000 字符（用户折中后的决定，不许悄悄改大）', () => {
  assert.equal(MEMORY_MAX_CHARS, 3000);
});

test('已用字符只算正文，不把 id 与时间戳算进去', () => {
  const entries = [entry('mem-1', 'abc'), entry('mem-2', '中文')];
  assert.equal(usedChars(entries), 5);
  assert.equal(remainingChars(entries), MEMORY_MAX_CHARS - 5);
});

test('★ 超限后 remaining 返回负数，界面靠它显示"超出多少"', () => {
  const entries = [entry('mem-1', 'x'.repeat(MEMORY_MAX_CHARS + 27))];
  assert.equal(remainingChars(entries), -27);
  assert.equal(withinLimit(entries), false);
});

test('★ 边界：正好 3000 字符算通过（不是"小于"）', () => {
  const exact = [entry('mem-1', 'x'.repeat(MEMORY_MAX_CHARS))];
  assert.equal(withinLimit(exact), true);
  const over = [entry('mem-1', 'x'.repeat(MEMORY_MAX_CHARS + 1))];
  assert.equal(withinLimit(over), false);
});

test('空正文与纯空白不可存 —— 存了就是看不见的空条目', () => {
  assert.equal(isEntryStorable(''), false);
  assert.equal(isEntryStorable('   \n  '), false);
  assert.equal(isEntryStorable('有内容'), true);
});

test('★★ token 必须走 estimateTokens，与预算裁剪同一个函数', () => {
  /*
   * 3000 汉字 = 9000 字节 ÷ 3.35 ≈ 2687 token。
   *
   * 这个数字是用户理解"记忆占多少上下文"的唯一依据，所以必须与
   * `applyTokenBudget` 用的估算完全一致 —— 另写一套会让界面上的
   * 百分比与实际裁剪结果对不上。
   */
  const entries = [entry('mem-1', '汉'.repeat(3000))];
  assert.equal(memoryTokens(entries), Math.ceil(9000 / 3.35));
});

test('★★★ 上下文未设置时不估算占比（不能显示假百分比）', () => {
  /*
   * `computeBudget` 在上下行为 0 时返回 0，语义是"不裁剪"。
   * 此时除以 0 会得 Infinity，或者被兜成 100% —— 两种都是假数字，
   * 而用户会照那个数字去调上下文。
   */
  const view = memoryBudgetView([entry('mem-1', 'abc')], 0);
  assert.equal(view.percent, null);
  assert.equal(view.tight, false);
  assert.equal(view.inputBudget, 0);
});

test('★★★ 占比超过 50% 要标记为"该提醒"', () => {
  /*
   * 依据：记忆之外还要放 system prompt、角色设定、世界书、对话示例
   * 和聊天历史。记忆占一半时剩下五样挤在另一半里，历史基本进不去。
   */
  const entries = [entry('mem-1', '汉'.repeat(3000))]; // ≈2687 token
  /* 输入预算 3296（上下文 4096 − 回复 800）⇒ 81% */
  const tight = memoryBudgetView(entries, 3296);
  assert.ok(tight.percent !== null && tight.percent >= 50, `实际 ${String(tight.percent)}%`);
  assert.equal(tight.tight, true);

  /* 上下文 32768 − 2048 = 30720 ⇒ 8.7%，不该提醒 */
  const roomy = memoryBudgetView(entries, 30720);
  assert.ok(roomy.percent !== null && roomy.percent < 50);
  assert.equal(roomy.tight, false);
});

test('坏的存档一律当空，不抛 —— 记忆读不出来时聊天必须照常能用', () => {
  for (const bad of [null, undefined, 42, 'x', [], { byAvatar: 'oops' }, { byAvatar: [] }]) {
    const store = parseMemoryStore(bad);
    assert.deepEqual(store.byAvatar, {});
    assert.equal(store.version, MEMORY_VERSION);
  }
});

test('存档能往返：写进去读出来一致', () => {
  const store = withMemoryOf(emptyMemoryStore(), '西奥.png', [entry('mem-1', '雨夜火车站台')]);
  const again = parseMemoryStore(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(memoryOf(again, '西奥.png').map((one) => one.text), ['雨夜火车站台']);
});

test('★ 条目清空后该角色的槽要整个删掉，不留空壳', () => {
  /*
   * 留空壳的话，"有没有记忆"的判断会一直是"有"，
   * 而列表里一条也看不到 —— 用户会以为坏了。
   */
  const store = withMemoryOf(emptyMemoryStore(), '西奥.png', [entry('mem-1', 'x')]);
  const cleared = withMemoryOf(store, '西奥.png', []);
  assert.equal('西奥.png' in cleared.byAvatar, false);
});

test('不同角色之间不共用', () => {
  let store = emptyMemoryStore();
  store = withMemoryOf(store, '甲.png', [entry('mem-1', '甲的记忆')]);
  store = withMemoryOf(store, '乙.png', [entry('mem-1', '乙的记忆')]);
  assert.deepEqual(memoryOf(store, '甲.png').map((one) => one.text), ['甲的记忆']);
  assert.deepEqual(memoryOf(store, '乙.png').map((one) => one.text), ['乙的记忆']);
  assert.deepEqual(memoryOf(store, '丙.png'), []);
});

test('★★ 导出文件只有角色名和条目（用户明令不放卡设定/世界书/提示词）', () => {
  const file = buildExportFile('西奥', [entry('mem-1', 'A'), entry('mem-2', 'B')]);
  assert.deepEqual(Object.keys(file).sort(), ['character', 'memories']);
  assert.equal(file.character, '西奥');
  assert.deepEqual(file.memories, ['A', 'B']);
  /* 条目里不许带 id / at —— 那是本地状态，跨设备无意义 */
  assert.equal(typeof file.memories[0], 'string');
});

test('★★ 导入认三种写法：字符串 / {text} / 裸数组', () => {
  const a = parseImportFile({ character: '西奥', memories: ['一条', '两条'] });
  assert.equal(a.character, '西奥');
  assert.equal(a.entries.length, 2);

  const b = parseImportFile({ character: '西奥', memories: [{ text: '一条' }] });
  assert.deepEqual(b.entries.map((one) => one.text), ['一条']);

  const c = parseImportFile(['直接从别处粘的']);
  assert.equal(c.character, '');
  assert.deepEqual(c.entries.map((one) => one.text), ['直接从别处粘的']);

  /* `entries` 这个旧键也要认 */
  const d = parseImportFile({ entries: ['旧写法'] });
  assert.deepEqual(d.entries.map((one) => one.text), ['旧写法']);
});

test('★★ 导入默认只合并，不替换已有条目', () => {
  const existing = [entry('mem-1', '原有的一条')];
  const incoming = [entry('mem-1', '新的一条')];
  const result = mergeImported(existing, incoming, 1000);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].text, '新的一条');
  /* 新增的 id 必须从现有最大编号往后排，不能撞回 mem-1 */
  assert.equal(result.added[0].id, 'mem-2');
});

test('★★ 去重按完全一致；完全相同的跳过并计数', () => {
  const existing = [entry('mem-1', '一样的')];
  const result = mergeImported(existing, [entry('mem-1', '一样的'), entry('mem-2', '新的')], 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].text, '新的');
});

test('★ 导入时空条目不占位，但也不该算进 skipped', () => {
  const result = mergeImported([], [entry('m', '  '), entry('n', '有内容')], 1);
  assert.equal(result.added.length, 1);
  assert.equal(result.skipped, 0);
});

test('nextEntryId 不与现有 id 撞车', () => {
  assert.equal(nextEntryId([]), 'mem-1');
  assert.equal(nextEntryId([entry('mem-1', 'a')]), 'mem-2');
  assert.equal(nextEntryId([entry('mem-1', 'a'), entry('mem-7', 'b')]), 'mem-8');
});

test('★★ 注入文本带标题，条目之间换行不分编号', () => {
  /*
   * 编号（`1. 2. 3.`）会让模型以为那是待办事项或步骤，
   * 而记忆是并列的事实。
   */
  const block = renderMemoryBlock([entry('mem-1', 'A'), entry('mem-2', 'B')]);
  assert.match(block, /【长期记忆】/);
  assert.ok(block.includes('A\nB'), `实际：${block}`);
  assert.doesNotMatch(block, /1\.\s*A/);
});

test('★ 没有记忆时不生成任何文本（不能注入一个空标题）', () => {
  assert.equal(renderMemoryBlock([]), '');
  assert.equal(renderMemoryBlock([entry('mem-1', '   ')]), '');
});

test('导出文件名去掉文件系统不接受的字符', () => {
  assert.equal(memoryExportFileName('西奥'), '西奥 · 记忆.json');
  assert.equal(memoryExportFileName('a/b:c*d'), 'abcd · 记忆.json');
  /* 空名要兜底，不能产出 " · 记忆.json" 这种以空格开头的名字 */
  assert.equal(memoryExportFileName('   '), '角色 · 记忆.json');
});

/* ═══════════════════════════════════════════════════════════
   B. 注入位置（两条拼装路径）
   ═══════════════════════════════════════════════════════════ */

/** 一份最小提示词配置：只有角色描述与历史 */
const minimalConfig = parsePromptConfig({
  prompts: [
    {
      identifier: 'charDescription',
      name: 'Char Description',
      system_prompt: true,
      marker: true,
      role: 'system',
      content: '',
    },
    {
      identifier: 'chatHistory',
      name: 'Chat History',
      system_prompt: true,
      marker: true,
      role: 'system',
      content: '',
    },
  ],
  prompt_order: [{ character_id: 100000, order: [{ identifier: 'charDescription' }, { identifier: 'chatHistory' }] }],
});

const HISTORY = [
  { name: 'User', is_user: true, is_system: false, mes: '第一句用户话' },
  { name: '西奥', is_user: false, is_system: false, mes: '第一句角色话' },
  { name: 'User', is_user: true, is_system: false, mes: '第二句用户话' },
];

test('★★★★ 主路径：记忆插在历史之前（用户要的"聊天记录最前面"）', () => {
  const result = assembleWithPrompts({
    card: CARD,
    history: HISTORY,
    config: minimalConfig,
    memory: [entry('mem-1', '他怕黑')],
  });
  const texts = result.messages.map((one) => one.content);
  const memAt = texts.findIndex((one) => one.includes('他怕黑'));
  const firstHistoryAt = texts.findIndex((one) => one === '第一句用户话');
  assert.ok(memAt >= 0, '记忆没进去');
  assert.ok(firstHistoryAt >= 0, '历史没进去');
  assert.ok(memAt < firstHistoryAt, `记忆在 ${String(memAt)}、历史在 ${String(firstHistoryAt)}`);
  assert.match(texts[memAt], /【长期记忆】/);
});

test('★★★★ 主路径：记忆不可被预算裁掉', () => {
  /*
   * 预算紧张时该裁的是历史。记忆是用户手写的长期资料，
   * 裁掉它等于让人物失忆，而用户完全不知道发生了什么。
   */
  const result = assembleWithPrompts({
    card: CARD,
    history: HISTORY,
    config: minimalConfig,
    memory: [entry('mem-1', '他怕黑')],
  });
  const at = result.messages.findIndex((one) => one.content.includes('他怕黑'));
  assert.equal(result.trimmable[at], false);
});

test('★★★★ 回退路径也要插记忆（没配预设的用户走这条）', () => {
  /*
   * 漏这一条的话，那批用户会看到记忆完全不生效 ——
   * 而界面上一切正常，是最难归因的一类。
   */
  const result = assembleContext({
    card: CARD,
    history: HISTORY,
    memory: [entry('mem-1', '他怕黑')],
  });
  const texts = result.messages.map((one) => one.content);
  const memAt = texts.findIndex((one) => one.includes('他怕黑'));
  const firstHistoryAt = texts.findIndex((one) => one === '第一句用户话');
  assert.ok(memAt >= 0, '回退路径没插记忆');
  assert.ok(memAt < firstHistoryAt, '回退路径里记忆没排在历史之前');
});

test('★★★ 记忆不许插到 messages[0]（那会跑到 system prompt 前面）', () => {
  /*
   * 用户说的是"聊天记录最前面"，不是"所有提示词之前"。
   * 有些模型会把第 0 条当系统级命令而不是背景资料。
   */
  const result = assembleWithPrompts({
    card: CARD,
    history: HISTORY,
    config: minimalConfig,
    memory: [entry('mem-1', '他怕黑')],
  });
  assert.doesNotMatch(result.messages[0].content, /【长期记忆】/);
});

test('★★ 没有记忆时一条都不插（不能凭空多出一条空消息）', () => {
  const withNone = assembleWithPrompts({
    card: CARD,
    history: HISTORY,
    config: minimalConfig,
    memory: [],
  });
  const baseline = assembleWithPrompts({ card: CARD, history: HISTORY, config: minimalConfig });
  assert.equal(withNone.messages.length, baseline.messages.length);
});

test('★★ 预设里没有 chatHistory 标记位时也要插进去（兜底）', () => {
  /*
   * 极少见但可能：用户把历史那一项删了。那种情况下循环里插不到，
   * 必须兜底补一次 —— 否则功能完全不生效且没有任何报错。
   */
  const noHistory = parsePromptConfig({
    prompts: [
      {
        identifier: 'charDescription',
        name: 'Char Description',
        system_prompt: true,
        marker: true,
        role: 'system',
        content: '',
      },
    ],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'charDescription' }] }],
  });
  const result = assembleWithPrompts({
    card: CARD,
    history: HISTORY,
    config: noHistory,
    memory: [entry('mem-1', '他怕黑')],
  });
  const texts = result.messages.map((one) => one.content);
  assert.ok(texts.some((one) => one.includes('他怕黑')), '兜底没生效，记忆完全丢了');
});

/* ═══════════════════════════════════════════════════════════
   C. 接线（静态断言）
   ═══════════════════════════════════════════════════════════ */

const PANEL = strip(read('client/src/chat/chat-panel.ts'));
const STORE = strip(read('client/src/chat/memory-store.ts'));
const PAGE = strip(read('client/src/chat/memory-page.ts'));
const MENU = strip(read('client/src/chat/bubble-menu.ts'));
const CSS = read('client/src/chat/chat.css');

test('★★★★ 两条拼装路径都传了 memory', () => {
  /*
   * 上面 B 层验的是"函数支持"，这里验的是"调用方给了"。
   * 两者缺一，功能就是不生效。
   */
  const calls = [...PANEL.matchAll(/^\s+memory,$/gm)];
  assert.ok(calls.length >= 2, `只找到 ${String(calls.length)} 处传参，两条路径都要有`);
});

test('★★★★ 记忆每次生成现读，不缓存', () => {
  /*
   * 缓存的失效点有三个：改了记忆、切了角色、在别处清空了存储。
   * 少接任何一个，症状都是"我明明改了它不生效"。
   */
  assert.match(PANEL, /readCharacterMemory\(this\.avatar\)/);
});

test('★★★ 存储只写 localStorage，不写进 PNG', () => {
  /*
   * 用户明令：「这个记忆不需要随角色卡，只存储在用户本地」。
   * 写进卡的话，导出给别人会连带私人剧情摘要。
   */
  assert.match(STORE, /tcs\.mobile\.memory/);
  assert.doesNotMatch(STORE, /st_chat_character_write_png|buildPngCard/);
});

test('★★★ 输入栏有记忆入口（一次点击打开）', () => {
  assert.match(PANEL, /data-role',\s*'chat-memory'/);
  assert.match(PANEL, /openMemoryPanel\(\)/);
});

test('★★★ 气泡菜单有「存为记忆」，且是原文预填不调 LLM', () => {
  assert.match(MENU, /id: 'memory'/);
  assert.match(MENU, /onSaveToMemory/);
  /* 菜单里不许出现生成请求 —— 那会按次计费 */
  assert.doesNotMatch(MENU, /generate\(|st_chat_generate/);
});

test('★★★ 超限时保存置灰，且点击处理里再检查一次', () => {
  /*
   * `disabled` 在某些 WebView 上对 `addEventListener` 不生效
   * （属性存在但事件照收）。只靠置灰等于把"不许保存"寄托在样式上。
   */
  assert.match(PAGE, /saveBtn\.setAttribute\('disabled'/);
  const at = PAGE.indexOf("save.addEventListener");
  assert.ok(at > 0, '找不到保存按钮的处理');
  const body = PAGE.slice(at, at + 700);
  assert.match(body, /view\.remaining < 0/, '点击处理里要再判一次超限');
});

test('★★★ 面板里有"请保证记忆+提示词+角色设定远小于上下文"这句提醒', () => {
  /*
   * 用户明确要求的一句：「请保证记忆+提示词+角色设定远小于上下文长度
   * 以保证聊天体验」。这不是装饰 —— 它解释的是"为什么聊天会失忆"。
   */
  assert.match(PAGE, /远小于上下文长度/);
  assert.match(PAGE, /历史会被裁掉/);
});

test('★★★★ 面板显示的占比与预算是同一个函数', () => {
  assert.match(PAGE, /memoryBudgetView\(/);
  /* 不许自己再除一遍 */
  assert.doesNotMatch(PAGE, /\/\s*view\.inputBudget/);
});

test('★★★ 面板关掉时回调要清引用（防僵尸面板）', () => {
  assert.match(PANEL, /this\.memoryPage\?\.close\(\)/);
  assert.match(PANEL, /this\.memoryPage = null/);
});

test('★★ 导出用 shareText、导入用 pickJsonFile（不自己挑目录写盘）', () => {
  assert.match(PANEL, /shareText/);
  assert.match(PANEL, /pickJsonFile\(\)/);
  /* 取消与失败必须分开处理 */
  assert.match(PANEL, /picked\.cancelled === true/);
});

test('★★ 记忆输入框宽度写死 100% + border-box（textarea 默认宽度来自 cols）', () => {
  const at = CSS.indexOf('.nb-memory-input');
  assert.ok(at > 0, '找不到样式');
  const block = CSS.slice(at, at + 420);
  assert.match(block, /width:\s*100%/);
  assert.match(block, /box-sizing:\s*border-box/);
});

test('★★ 面板列表区可滚（min-height:0 是 flex 子项能滚的前提）', () => {
  const at = CSS.indexOf('.nb-memory-list');
  const block = CSS.slice(at, at + 300);
  assert.match(block, /min-height:\s*0/);
  assert.match(block, /overflow-y:\s*auto/);
});
