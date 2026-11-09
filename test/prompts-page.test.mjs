/**
 * 「提示词管理」的判据（2026-11-03，第二十二批）。
 *
 * ## 用户原话
 *
 * > 这个我看不到导入预设后预设里面的提示词，
 * > 没有办法管理我要开哪个提示词或者关哪个提示词。
 *
 * ## 这组守什么
 *
 * 开关的失败方式**全是静默的**：
 *
 * ```text
 *   入口没接线     → 页面上根本没有那个按钮（用户以为功能没做）
 *   开关没写回     → 界面关了、发出去还带着（"设了不生效"）
 *   写回写错对象   → 改了另一条 order，重启后变回去
 *   写回整份预设时丢键 → 模型名/采样参数被清空（比开关失效严重得多）
 * ```
 *
 * 四条都不会报错。所以逐条钉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePromptConfig } from '../shared/dist/chat/prompt-config.js';
import { setPromptEnabled } from '../shared/dist/chat/prompt-toggle.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

/* ═══════════════════════════════════════════════════════════
   一、写回：只改开关，不丢任何键
   ═══════════════════════════════════════════════════════════ */

/** 造一份最小预设（带"不能被丢掉的"其它键） */
function makePreset() {
  return {
    temperature: 0.9,
    openai_model: 'gpt-4o',
    scenario_format: '{{scenario}}',
    prompts: [
      { identifier: 'a', name: '甲', content: '内容甲', role: 'system' },
      { identifier: 'b', name: '乙', content: '内容乙', role: 'user' },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'a', enabled: true },
          { identifier: 'b', enabled: false },
        ],
      },
    ],
  };
}

test('★★★ 关掉一条：只改 enabled，其它键一个都不许丢', () => {
  /*
   * ST 的 `/api/presets/save` 收**整份**预设（62 个键）。
   *
   * 少传一个键 = 把它删了。而预设里还有模型名、采样参数、格式串 ——
   * 丢一个就是"导入了预设，模型名反而没了"，比开关失效严重得多。
   */
  const body = makePreset();
  const config = parsePromptConfig(body);

  const result = setPromptEnabled(body, config, 'a', false);
  assert.equal(result.ok, true);

  const next = result.body;
  /* 开关确实改了 */
  assert.equal(next.prompt_order[0].order[0].enabled, false);
  /* 其它键全在 */
  assert.equal(next.temperature, 0.9);
  assert.equal(next.openai_model, 'gpt-4o');
  assert.equal(next.scenario_format, '{{scenario}}');
  assert.deepEqual(next.prompts, body.prompts);
});

test('★★★ 不许改原对象（保存失败时内存不能已经变了）', () => {
  /*
   * 就地改会让"读到的"和"保存的"变成同一个东西。
   * 万一写回失败，界面上的开关已经关了、实际还在发 ——
   * 而且内存状态和磁盘不一致，刷新一下就"变回去"，用户会以为界面有 bug。
   */
  const body = makePreset();
  const config = parsePromptConfig(body);
  const before = JSON.stringify(body);

  void setPromptEnabled(body, config, 'a', false);

  assert.equal(JSON.stringify(body), before, '原对象必须一字未动');
});

test('★★★ 已经是目标状态时不写（changed=false）', () => {
  /*
   * 避免无意义的 IO。更重要的是：`presetSave` 会更新文件时间戳，
   * 而"我什么都没改却保存了一次"会让排查时的时序线索变乱。
   */
  const body = makePreset();
  const config = parsePromptConfig(body);

  const result = setPromptEnabled(body, config, 'a', true);
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
});

test('★★ 找不到那条 order 时明确报错，不许硬塞一条新的', () => {
  /*
   * 硬塞的后果：用户在 A 环境有 `character_id: 100001` 的 order，
   * 我们塞一条 `100000` 的 ⇒ 预设里有了两条，而 ST 只读其中一条。
   * 表现为"改了开关，重启后变回去"，极难归因。
   */
  const body = makePreset();
  /* 故意把 order 抹掉，模拟"结构不对" */
  delete body.prompt_order;
  const config = parsePromptConfig(makePreset());

  const result = setPromptEnabled(body, config, 'a', false);
  assert.equal(result.ok, false);
  assert.match(result.reason, /缺少提示词顺序表/);
});

test('★★ 顺序表里没有这条提示词时也要报错（不猜）', () => {
  const body = makePreset();
  const config = parsePromptConfig(body);
  const result = setPromptEnabled(body, config, '不存在的-id', false);

  assert.equal(result.ok, false);
  assert.match(result.reason, /没有这条提示词/);
});

test('★★ `character_id` 不是 100000 时也能写回（only-one 兜底同款）', () => {
  /*
   * 与 `parsePromptConfig` 的退让顺序必须一致。
   * 两份实现分叉 = "开关改了但没生效"的经典成因。
   */
  const body = {
    prompts: [{ identifier: 'a', name: '甲', content: '内容', role: 'system' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }],
  };
  const config = parsePromptConfig(body);
  assert.equal(config.orderSource, 'only-one');

  const result = setPromptEnabled(body, config, 'a', false);
  assert.equal(result.ok, true);
  assert.equal(result.body.prompt_order[0].order[0].enabled, false);
});

/* ═══════════════════════════════════════════════════════════
   二、界面与接线
   ═══════════════════════════════════════════════════════════ */

test('★★★ 入口必须真的接上（漏了就是"页面上没这个按钮"）', () => {
  /*
   * `callbacks.onOpenPrompts` 是可选调用 —— 不传时整块不渲染，
   * 界面上看不到、点了没反应，而测试全绿。
   * 本项目已经犯过 6 次（memory §90.6）。
   */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  assert.match(shell, /onOpenPrompts: \(\) => \{/, '外壳必须给这个回调');
  assert.match(shell, /this\.chatSettingsRoute = 'prompts'/, '要能路由到那一页');
  assert.match(shell, /if \(this\.chatSettingsRoute === 'prompts'\)/, 'renderPage 要处理这个路由');
});

test('★★★ 开关必须真的写回 ST（不是只改内存）', () => {
  /*
   * 只改内存的话，杀掉 App 就恢复原样 ——
   * 用户会以为"我关掉了怎么又开了"。
   *
   * ★★★ 断言必须**限定在 `savePromptToggle` 函数体内**。
   *
   * 第一版在整份 shell.ts 里搜 `bridge.presetSave(` —— 变异验证时
   * 把写回删掉了，测试**依然全绿**。因为 `importFile` 里也有一处
   * `bridge.presetSave(`（导入预设时保存），把断言满足了。
   *
   * 这就是"判据看错了对象"：它答的是"代码里有没有这句话"，
   * 而不是"这个函数有没有写回"。两个意思差得很远。
   */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  /*
   * ★ 2026-11-07 改：断言对象从 `savePromptToggle` 换成 `mutatePromptPreset`。
   *
   * 开关 / 编辑 / 新建 / 删除四条路现在共用同一个"读原体 → 改 → 整份写回"
   * 的实现。再盯着 `savePromptToggle` 断言就等于要求把那段复制四遍 ——
   * 而复制正是"改了不生效"的来源之一。
   *
   * 所以分两段断言：
   *   ① 真正的写回必须在那个公共函数里
   *   ② 开关那条路必须真的调它（不许自己再实现一份）
   */
  const start = shell.indexOf('private async mutatePromptPreset');
  assert.ok(start > 0, '找不到 mutatePromptPreset');

  /* 取到下一个方法边界（下一个 `private async ` / `private render` 之前） */
  const rest = shell.slice(start + 10);
  const nextBoundary = Math.min(
    ...['\n  private async ', '\n  private render', '\n  private ', '\n  /**']
      .map((marker) => {
        const at = rest.indexOf(marker);
        return at < 0 ? Number.POSITIVE_INFINITY : at;
      }),
  );
  const block = rest.slice(0, Number.isFinite(nextBoundary) ? nextBoundary : rest.length);

  assert.match(block, /bridge\.presetSave\(/, '这个函数里必须写回预设');

  /* ② 开关那条路必须是**委托**，不是自己又写一遍 */
  const toggleStart = shell.indexOf('private async savePromptToggle');
  assert.ok(toggleStart > 0, '找不到 savePromptToggle');
  const toggleBlock = shell.slice(toggleStart, shell.indexOf('\n  /**', toggleStart + 10));
  assert.match(
    toggleBlock,
    /mutatePromptPreset\(\(body, config\) =>\s*setPromptEnabled\(/,
    '开关必须走公共写回链路（自己再实现一份 = 迟早分叉）',
  );
});

test('★★★ 写回后必须重新解析（否则聊天还用旧开关）', () => {
  /*
   * 不重新解析的话：用户关掉一条、回聊天、发消息 ——
   * 发出去的**还是**那一条。而界面上开关明明关了。
   */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
  /* 同上：重新解析现在在公共链路里 */
  const block = shell.slice(shell.indexOf('private async mutatePromptPreset'));

  assert.match(block, /parsePromptConfig\(next\.body\)/, '写完要重新解析');
  assert.match(block, /setContext\(\{ promptConfig: this\.promptConfig \}\)/, '要把新配置推给面板');
});

test('★★ 开关失败时界面要退回原状并说明原因', () => {
  /*
   * 不退回的话用户以为关掉了，实际还在发 ——
   * "设了不生效"里最难查的一种。
   */
  const page = readFileSync(join(CHAT_DIR, 'chat-prompts-page.ts'), 'utf8');

  assert.match(page, /checked = !target/, '失败要把勾选状态退回去');
  assert.match(page, /callbacks\.onNotify\?\./, '失败要告诉用户');
});

test('★★ 关掉一条要说明"只是不发这条"（不是整个预设失效）', () => {
  /*
   * 用户不知道关掉一条的后果。不写清的话他会担心"关一条会不会全坏了"。
   * （用户两次明令的文案判据：读了知道能做什么。）
   */
  const page = readFileSync(join(CHAT_DIR, 'chat-prompts-page.ts'), 'utf8');

  assert.match(page, /关掉的不会发出去，其他照发/, '要说清后果');
});

test('★★ 空配置时给"下一步去哪"，不是空列表', () => {
  /*
   * 空列表看起来像"预设里没有提示词"，而实际是"还没读到"。
   */
  const page = readFileSync(join(CHAT_DIR, 'chat-prompts-page.ts'), 'utf8');

  assert.match(page, /prompts-empty/, '要有空状态');
  assert.match(page, /导入一份预设/, '要指路');
});

test('★★ 标记位的空正文要说清"内容来自哪"', () => {
  /*
   * 内置槽（世界书/描述/历史）的 `content` 本来就是空的。
   * 不给解释的话，用户会以为那几条是坏的、关掉算了 ——
   * 而关掉它们等于让 AI 失忆。
   */
  const page = readFileSync(join(CHAT_DIR, 'chat-prompts-page.ts'), 'utf8');

  assert.match(page, /内容来自角色卡 \/ 世界书 \/ 对话记录/, '要解释空正文的来源');
});
