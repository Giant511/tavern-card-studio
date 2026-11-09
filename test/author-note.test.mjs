/**
 * 作者注释 + CFG 暂不支持的判据（2026-11-03，第二十七批）。
 *
 * ## 用户要求
 *
 * > 那就先做作者注释，然后两个CFG在UI上先标暂不支持，然后也不可配置
 *
 * ## 为什么要写得这么细
 *
 * 「作者注释」之前是**只存 ST、从不进请求**的（真机 10 次实测标记 0 次出现）。
 * 现在要实现它，最危险的不是"没实现"，而是**实现了一半**：
 *
 * ```text
 *   判定写对了但没插进 messages   → 看起来实现了，实际没生效
 *   插进去了但没做宏替换         → {{char}} 原样发给模型
 *   每轮都插（忽略 interval）    → 用户配了"每 4 轮"，实际每轮都强化
 *   改了设置但面板拿不到新值     → "改了不生效，重启才好"
 * ```
 *
 * 四种都不报错。所以逐条钉。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assembleWithPrompts } from '../shared/dist/chat/prompt-assemble.js';
import {
  AUTHOR_NOTE_DEFAULTS,
  resolveAuthorNoteConfig,
  shouldInjectAuthorNote,
} from '../shared/dist/chat/author-note.js';
import { parsePromptConfig } from '../shared/dist/chat/prompt-config.js';
import { BEHAVIOR_SECTION } from '../shared/dist/chat/settings-schema.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CHAT_DIR = join(REPO, 'client', 'src', 'chat');

/* ═══════════════════════════════════════════════════════════
   一、"这一轮要不要插"—— 逐行照搬 ST 的 setFloatingPrompt
   ═══════════════════════════════════════════════════════════ */

test('★★★ 间隔 1 = 每轮都插（ST 的特例）', () => {
  /*
   * ST 源码里有一句 `if (interval === 1) lastMessageNumber = 1;` ——
   * 这是为了"间隔 1 表示每轮"，而不是"第 1、2、3… 轮才插"。
   * 漏了这个特例，前几轮的行为就会错。
   */
  for (const count of [1, 2, 3, 7, 50]) {
    assert.equal(shouldInjectAuthorNote(count, 1), true, `第 ${String(count)} 轮、间隔 1 应该插`);
  }
});

test('★★★ 间隔 N = 每 N 轮插一次', () => {
  /* interval = 2：第 2、4、6 轮插 */
  assert.equal(shouldInjectAuthorNote(1, 2), false);
  assert.equal(shouldInjectAuthorNote(2, 2), true);
  assert.equal(shouldInjectAuthorNote(3, 2), false);
  assert.equal(shouldInjectAuthorNote(4, 2), true);

  /* interval = 4：第 4、8 轮插；不到 4 轮时按"还差几轮"算，不插 */
  assert.equal(shouldInjectAuthorNote(1, 4), false);
  assert.equal(shouldInjectAuthorNote(3, 4), false);
  assert.equal(shouldInjectAuthorNote(4, 4), true);
  assert.equal(shouldInjectAuthorNote(7, 4), false);
  assert.equal(shouldInjectAuthorNote(8, 4), true);
});

test('★★ 一条用户消息都没有时不插', () => {
  /* 空对话里插注释毫无意义，只会白占 token */
  assert.equal(shouldInjectAuthorNote(0, 1), false);
  assert.equal(shouldInjectAuthorNote(0, 4), false);
});

test('★★ 间隔 <= 0 视为不插（防 0 除 / 死循环）', () => {
  assert.equal(shouldInjectAuthorNote(5, 0), false);
  assert.equal(shouldInjectAuthorNote(5, -1), false);
});

/* ═══════════════════════════════════════════════════════════
   二、从 ST 的 note 对象解析配置
   ═══════════════════════════════════════════════════════════ */

test('★★★ 缺字段时退回 ST 的默认值（不是 0）', () => {
  /*
   * ST 只在用户**手动改过**时才把这些键写进 settings。
   * 没写过就是 undefined —— 当成 0 的话 `depth = 0` 会把注释
   * 插到最末尾，与"插在第 4 条之前"完全相反，而界面看不出区别。
   */
  const cfg = resolveAuthorNoteConfig({ default: '测试注释' });

  assert.equal(cfg.text, '测试注释');
  assert.equal(cfg.depth, AUTHOR_NOTE_DEFAULTS.depth, 'depth 应退回 ST 默认 4');
  assert.equal(cfg.interval, AUTHOR_NOTE_DEFAULTS.interval, 'interval 应退回 ST 默认 1');
  assert.equal(cfg.role, 'system');
});

test('★★ 显式值优先；数字角色也能还原', () => {
  const cfg = resolveAuthorNoteConfig({
    default: 'x',
    defaultDepth: 2,
    defaultInterval: 3,
    defaultRole: 1,
  });

  assert.equal(cfg.depth, 2);
  assert.equal(cfg.interval, 3);
  assert.equal(cfg.role, 'user', 'ST 里 role 存数字，1 = user');
});

test('★★ 间隔下限收到 1（0 会变成"永不插入"的哑巴故障）', () => {
  /*
   * ST 用 `interval <= 0` 表示禁用。我们的界面没有"禁用"开关
   * （清空正文就等于不用），所以间隔必须收到 1 ——
   * 否则用户填了注释、间隔却是 0，注释永远不插，而界面上一切正常。
   */
  const cfg = resolveAuthorNoteConfig({ default: 'x', defaultInterval: 0 });
  assert.equal(cfg.interval, 1);
});

test('★★ 传进来的不是对象时给一份安全默认', () => {
  for (const bad of [undefined, null, 42, 'x']) {
    const cfg = resolveAuthorNoteConfig(bad);
    assert.equal(cfg.text, '', '没有 note 对象就是空文本');
    assert.equal(cfg.depth, AUTHOR_NOTE_DEFAULTS.depth);
  }
});

/* ═══════════════════════════════════════════════════════════
   三、真的插进了 messages
   ═══════════════════════════════════════════════════════════ */

/** 造一份最小预设（有 chatHistory 才能让历史展开） */
function makeConfig() {
  return parsePromptConfig({
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是{{char}}。', role: 'system' },
      { identifier: 'chatHistory', name: '历史', content: '', role: 'system', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100000,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ],
  });
}

test('★★★ 作者注释真的进了 messages（不再是"只存不发"）', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [
      { name: '你', is_user: true, mes: '你好', send_date: '' },
    ],
    persona: { name: '旅人' },
    config: makeConfig(),
    authorNote: { text: '这是作者注释', depth: 4, interval: 1, role: 'system' },
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(all.includes('这是作者注释'), `作者注释没进上下文。实际内容：${all.slice(0, 300)}`);
});

test('★★★ 作者注释做宏替换（{{char}} / {{user}}）', () => {
  /*
   * 用户在注释里几乎一定会写 {{char}}。原样发出去模型看到的是字面量，
   * 而"字面量"在这类提示词里等于噪声。
   */
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '你', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '旅人' },
    config: makeConfig(),
    authorNote: { text: '{{char}} 正在和 {{user}} 说话', depth: 4, interval: 1, role: 'system' },
  });

  const all = result.messages.map((one) => one.content).join('\n');
  assert.ok(all.includes('小夜 正在和 旅人 说话'), `宏没替换：${all.slice(0, 300)}`);
  assert.ok(!all.includes('{{char}}'), '不许把 {{char}} 原样发出去');
});

test('★★ 正文为空 = 不插（哪怕 interval 命中）', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '你', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '旅人' },
    config: makeConfig(),
    authorNote: { text: '   ', depth: 4, interval: 1, role: 'system' },
  });

  /* 只有预设里的两条（main + 历史），没有额外的注释消息 */
  assert.ok(result.messages.length <= 4, `空注释不该增加消息，实际 ${String(result.messages.length)} 条`);
});

test('★★ 不传 authorNote 时行为与之前一致（不影响旧路径）', () => {
  const result = assembleWithPrompts({
    card: { name: '小夜', description: '' },
    history: [{ name: '你', is_user: true, mes: '你好', send_date: '' }],
    persona: { name: '旅人' },
    config: makeConfig(),
  });

  assert.ok(result.messages.length > 0);
  assert.ok(!result.messages.some((one) => one.content.includes('作者注释')));
});

/* ═══════════════════════════════════════════════════════════
   四、两个 CFG 标"暂不支持"且不可配置
   ═══════════════════════════════════════════════════════════ */

test('★★★ CFG 缩放与反向提示都标了暂不支持', () => {
  const cfgFields = BEHAVIOR_SECTION.fields.filter(
    (one) => one.label === 'CFG 缩放' || one.label === 'CFG 反向提示',
  );
  assert.equal(cfgFields.length, 2, '聊天行为页应该有这两个 CFG 字段');

  for (const field of cfgFields) {
    assert.ok(field.unsupported !== undefined && field.unsupported !== '', `${field.label} 没标暂不支持`);
    /*
     * ★ 意向反转（2026-11-04 用户明令）：
     *
     * > 加一个提示为暂不支持就行（不要再加为什么不支持了，
     * > 这个是开发阶段的文字，我要的是用户该看到的东西）
     *
     * 原来这条判据要求"必须讲原因"（双倍成本之类）。那是**给自己看的**，
     * 用户不需要。现在反过来：只许是「暂不支持」。
     */
    assert.equal(field.unsupported, '暂不支持', `${field.label} 的说明只许是「暂不支持」，实际：${field.unsupported}`);
  }
});

test('★★★ 作者注释**没有**被标成暂不支持（它已实现）', () => {
  const note = BEHAVIOR_SECTION.fields.find((one) => one.label === '作者注释');
  assert.ok(note !== undefined, '作者注释字段不见了');
  assert.equal(note.unsupported, undefined, '作者注释已实现，不该再标暂不支持');
});

test('★★★ 渲染层要真的禁用 + 不参与保存', () => {
  const settings = readFileSync(join(CHAT_DIR, 'chat-settings.ts'), 'utf8');

  assert.match(settings, /if \(field\.unsupported !== undefined\) \{[\s\S]{0,200}disabled/, '要设 disabled');
  assert.match(settings, /data-role', 'settings-unsupported'/, '要显示原因');
  assert.match(
    settings,
    /if \(field\.unsupported !== undefined\) continue;/,
    '保存时要跳过（防有人去掉 disabled）',
  );
});

test('★★ 外壳把作者注释交给了面板（接线不能漏）', () => {
  /*
   * 本项目最反复的缺陷类型："实现存在但没接线"。
   * 作者注释的读取在 `seedPromptConfig`，传递在 `renderChat` 的 ctx ——
   * 任一处漏了，用户改完注释都不会生效，而界面一切正常。
   */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  assert.match(shell, /resolveAuthorNoteConfig\(/, '要读 ST 的 note 配置');
  assert.match(shell, /authorNote: this\.authorNote/, '要传给面板 ctx');
});

test('★★★ 启动播种时必须把 authorNote 推给面板（不是只在保存时推）', () => {
  /*
   * ## 这条来自一次真机排障（2026-11-03）
   *
   * 第一版我把 `setContext({ authorNote })` 加到了 **`saveFields`**（保存设置）
   * 里，而不是 `seedPromptConfig`（启动时播种）里。后果：
   *
   * ```text
   *   启动 → seedPromptConfig 推了预设，没推注释
   *        → 面板 ctx.authorNote 恒为 undefined
   *        → 作者注释一次都没进上下文
   * ```
   *
   * 而"保存时推"那条路只有用户手动点保存才走得到 —— 重启 App 就绕过。
   *
   * 「保存时推」是对的但不够；**两条路都要推**。
   * 真机诊断（`__tcsPromptProbe__`）当时报 `hasAuthorNote: false` 而
   * `usePromptManager: true`，正是"预设读到了、只有注释这一路断了"。
   */
  const shell = readFileSync(join(CHAT_DIR, 'shell.ts'), 'utf8');

  /* 取 seedPromptConfig 的函数体（到下一个 private 方法为止） */
  const start = shell.indexOf('private async seedPromptConfig');
  assert.ok(start > 0, '找不到 seedPromptConfig');
  const rest = shell.slice(start + 10);
  const next = rest.indexOf('\n  private ');
  const block = rest.slice(0, next < 0 ? rest.length : next);

  assert.match(block, /authorNote: this\.authorNote/, '启动播种时要把 authorNote 一起 setContext');
});

test('★★★ 页面开头不许承诺 CFG（它已禁用）', () => {
  /*
   * 原文：`作者注释会按固定间隔插进上下文；CFG 缩放决定回复有多贴提示词。`
   *
   * 而 CFG 两项已经禁用并标了暂不支持 —— 开头还承诺它的作用，
   * 用户会先被答应、再发现用不了。
   *
   * 这是同一天里**第二次**犯同一类错（上一次是"聊天操作"菜单副标题
   * 还写着已隐藏的"续写"）。所以从"提醒"升级成"判据"：
   *
   * > 把一个功能标为不可用时，要连同所有提到它的文案一起改。
   */
  const intro = BEHAVIOR_SECTION.intro;

  assert.ok(!/CFG/.test(intro), `页面开头还在提 CFG：${intro}`);
  assert.ok(!/缩放/.test(intro), `页面开头还在提缩放：${intro}`);
  assert.match(intro, /作者注释/, '开头应该只讲作者注释（这一页现在唯一可用的项）');
});
