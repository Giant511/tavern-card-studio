/**
 * 「聊天操作」页隐藏四个功能的判据（2026-11-03，第二十六批）。
 *
 * ## 用户原话
 *
 * > 把我圈起来的这几个功能取消掉（只是UI上隐藏和没有别的代码调用，
 * > 这些作为后续功能加进去）
 *
 * ## 这条约束有两半，缺一半都不算做到
 *
 * ```text
 *   只隐藏了 UI，但代码删了     → 将来恢复要重写，等于把活干废
 *   代码留着，但 UI 还看得见    → 用户白说
 *   代码留着、UI 藏了，但别处    → "没有别的代码调用"没做到
 *   还能触发（长按菜单等）
 * ```
 *
 * 所以判据要同时守三件：**渲染里没有、定义还在、别处调不到**。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

const actionsSrc = () => readFileSync(join(CHAT_DIR, 'chat-actions-page.ts'), 'utf8');

/** 用户圈掉的那四项 */
const HIDDEN = [
  { id: 'ai-assist', label: 'AI 帮答' },
  { id: 'continue', label: '续写' },
  { id: 'convert-group', label: '转换为群聊' },
  { id: 'token-probs', label: 'Token 概率' },
];

test('★★★ 四项都进了隐藏集合', () => {
  const src = actionsSrc();
  const start = src.indexOf('const HIDDEN_ACTIONS');
  assert.ok(start > 0, '找不到 HIDDEN_ACTIONS');
  const block = src.slice(start, src.indexOf(']);', start));

  for (const one of HIDDEN) {
    assert.ok(
      block.includes(`'${one.id}'`),
      `${one.label}（${one.id}）没进隐藏集合，界面上还会出现`,
    );
  }
});

test('★★★ 渲染循环真的跳过隐藏项', () => {
  /*
   * 光有集合不消费等于没做 —— 这是本项目最反复的缺陷类型
   * （"实现存在但没接线"）。
   */
  const src = actionsSrc();
  const start = src.indexOf('for (const action of actions)');
  assert.ok(start > 0, '找不到渲染循环');
  const block = src.slice(start, start + 500);

  assert.match(block, /HIDDEN_ACTIONS\.has\(action\.id\)/, '循环里要判断');
  assert.match(block, /continue;/, '命中就跳过渲染');
});

test('★★★ Token 概率那一整块也要藏（它不是 action，是独立渲染的）', () => {
  const src = actionsSrc();
  const start = src.indexOf("if (!HIDDEN_ACTIONS.has('token-probs'))");
  assert.ok(start > 0, 'Token 概率那段没被条件包住');
});

test('★★★ 代码必须保留（用户说"作为后续功能加进去"）', () => {
  /*
   * 这是"取消功能"与"删代码"的分界线。
   * 四个 action 的定义、四个回调字段、外壳里的实现，一个都不许少。
   */
  const src = actionsSrc();

  for (const one of HIDDEN) {
    if (one.id === 'token-probs') continue; /* 它不是 action，单独判断 */
    assert.ok(
      src.includes(`id: '${one.id}'`),
      `${one.label} 的 action 定义被删了 —— 用户要求保留作为后续功能`,
    );
  }

  /* 回调字段也要在 */
  for (const field of ['onAiAssist', 'onContinueWriting', 'onConvertToGroup']) {
    assert.ok(src.includes(`${field}:`), `${field} 回调定义被删了`);
  }

  /* 外壳里的实现也要在 */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');
  for (const field of ['onAiAssist', 'onContinueWriting', 'onConvertToGroup']) {
    assert.ok(shell.includes(`${field}:`), `shell 里的 ${field} 实现被删了`);
  }

  /* Token 概率的文案也要在 */
  assert.ok(src.includes('📊 Token 概率'), 'Token 概率那段被整块删了');
});

test('★★★ 别处不许再调这四个功能', () => {
  /*
   * 用户明确要"没有别的代码调用"。
   *
   * 检查范围是**除本页之外**的源码：如果哪天在长按气泡菜单里也加了
   * "续写"入口，用户就会在界面上看到一个他要求藏起来的功能。
   */
  const others = ['chat-panel.ts', 'bubble-menu.ts', 'shell.ts', 'voice-panel.ts'];

  for (const name of others) {
    let text;
    try {
      text = readFileSync(join(CHAT_DIR, name), 'utf8');
    } catch {
      continue;
    }
    /* shell 里的 `onAiAssist:` 是实现（callbacks 接口要求），不算"调用"。
       真正要防的是别处**触发**它 —— 即 `callbacks.onAiAssist(` 这种。 */
    for (const call of ['callbacks.onAiAssist(', 'callbacks.onContinueWriting(', 'callbacks.onConvertToGroup(']) {
      assert.ok(!text.includes(call), `${name} 里还在调用 ${call}`);
    }
  }
});

test('★★ 恢复只需删集合里一行（可逆性）', () => {
  /*
   * 判据：隐藏逻辑**只有**一个开关点。
   *
   * 如果在别处也写了 `if (id === 'ai-assist') return` 这类判断，
   * 将来恢复就要改两处，必然漏一处。这里只允许 HIDDEN_ACTIONS 一个来源。
   */
  const src = actionsSrc();
  const hits = [...src.matchAll(/'ai-assist'/g)].length;

  /*
   * 允许出现两次：一次在 HIDDEN_ACTIONS，一次在 action 定义里。
   * 多出来就说明有人又写了一处散落的判断。
   */
  assert.ok(hits <= 2, `'ai-assist' 出现了 ${String(hits)} 次，隐藏开关应只有一处`);
});

test('★★★ 菜单副标题不许提已隐藏的功能', () => {
  /*
   * 「聊天设置」菜单里那一行的副标题原本是：
   *
   *     检查点、新聊天、续写、管理聊天文件
   *
   * 而「续写」这次被用户要求隐藏了 —— 文案里还写着它，
   * 用户点进去发现没有，会以为功能坏了。
   *
   * 文案是产品内**唯一的教学**。写着有、进去没有，比不写更糟：
   * 用户会开始怀疑其他文案也不准。
   *
   * （§72 记过同一类：提示文案与行为相反时，用户按提示做会得到相反结果。）
   */
  const settings = readFileSync(join(CHAT_DIR, 'chat-settings.ts'), 'utf8');

  /* 找到那行的副标题赋值（取到分号为止） */
  const start = settings.indexOf('actionsHint.textContent');
  assert.ok(start > 0, '找不到聊天操作那一行的副标题');

  const line = settings.slice(start, settings.indexOf(';', start) + 1);

  for (const word of ['续写', '帮答', '群聊']) {
    assert.ok(
      !line.includes(word),
      '副标题里还在提「' + word + '」，而它已被隐藏：' + line.trim(),
    );
  }
});
