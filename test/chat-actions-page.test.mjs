/**
 * 聊天操作页 / 聊天文件页 / 「聊天行为」分组（2026-11-03）。
 *
 * ## 需求来源
 *
 * 用户给了 ST 的 12 项菜单截图，要求「除重新生成和删除消息外全部要，单独放到一个界面」。
 *
 * ## 做了哪 10 项、依据是什么
 *
 * 真机探测过 ST 1.19.0 的路由（`.verify/probe-st-routes.sh`），
 * **每一项都有实测依据**，没有"看着像能做"：
 *
 * | 项 | 依据 |
 * |---|---|
 * | 作者注释 | `settings/get` 里实测存在 `extension_settings.note.default` |
 * | CFG 缩放 | 实测存在 `extension_settings.cfg.global.guidance_scale` |
 * | 保存检查点 | `chats/save` 换新文件名（ST 里检查点就是这个语义） |
 * | 开始新聊天 | 同上 + 空消息 |
 * | 关闭聊天 | 纯前端清会话指针 |
 * | 管理聊天文件 | `characters/chats` / `rename` / `delete` 全部 200 |
 * | AI 帮答 / 续写 | `generate` 存在（缺参时 400），注入临时 system 指令 |
 * | 转群聊 | **`groups/create` 实测 200**（`group/convert` 是 404） |
 * | Token 概率 | **实测拿不到**：只有纯文本 SSE，没有 logprobs |
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BEHAVIOR_SECTION,
  CHAT_SETTINGS_GROUPS,
  readField,
  writeField,
} from '../shared/dist/chat/settings-schema.js';
import { parseChatFileRows } from '../client/src/chat/chat-actions-page.ts';

const ROOT = join(import.meta.dirname, '..');
const rawCss = readFileSync(join(ROOT, 'client/src/chat/chat.css'), 'utf8');
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
const tokensCss = readFileSync(join(ROOT, 'client/src/chat/nebula-tokens.css'), 'utf8');
const page = readFileSync(join(ROOT, 'client/src/chat/chat-actions-page.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const panel = readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

/* ═══════════════════════════════════════════════════════════
   一、作者注释 / CFG：路径必须是实测出来的那两个
   ═══════════════════════════════════════════════════════════ */

test('★★★ 作者注释与 CFG 的路径必须是实测值（不是社区文档里的猜测）', () => {
  /*
   * 我第一版按常见说法写 `power_user.note_prompt` / `oai_settings.cfg_scale`，
   * 然后**递归搜整个真实设置对象，两个都不存在**。
   *
   * 真机 1.19.0 的实情：
   *   extension_settings.note.default
   *   extension_settings.cfg.global.guidance_scale
   */
  const paths = BEHAVIOR_SECTION.fields.map((f) => f.path.join('.'));
  assert.ok(
    paths.includes('extension_settings.note.default'),
    '作者注释要写在 extension_settings.note.default',
  );
  assert.ok(
    paths.includes('extension_settings.cfg.global.guidance_scale'),
    'CFG 缩放要写在 extension_settings.cfg.global.guidance_scale',
  );

  /* 反面：不许再出现那两个猜错的路径 */
  for (const wrong of ['power_user.note_prompt', 'oai_settings.cfg_scale']) {
    assert.equal(paths.includes(wrong), false, `不许用猜错的路径 ${wrong}`);
  }
});

test('★★★ 写嵌套路径不能把兄弟字段清掉', () => {
  /*
   * `writeField` 逐层浅拷贝。写 `extension_settings.note.default` 时
   * 必须保留 `note.chara` / `note.wiAddition` —— 那是**按角色的覆盖**，
   * 清掉等于把用户给别的角色配的注释全删了，而且不可逆。
   */
  const before = {
    extension_settings: {
      note: { chara: [{ name: 'a', prompt: 'x' }], default: '', wiAddition: [] },
      cfg: { chara: [], global: { guidance_scale: 1, negative_prompt: '' } },
    },
    power_user: { some: 1 },
  };
  const noteField = BEHAVIOR_SECTION.fields.find(
    (f) => f.path.join('.') === 'extension_settings.note.default',
  );
  assert.ok(noteField !== undefined);

  const after = writeField(before, noteField, '新的注释');
  /* 纯 JS（`.mjs`）里不许写 TS 断言 */
  const note = after['extension_settings']['note'];

  assert.equal(note['default'], '新的注释', '新值要写进去');
  assert.deepEqual(note['chara'], [{ name: 'a', prompt: 'x' }], 'chara 不能被清掉');
  assert.deepEqual(note['wiAddition'], [], 'wiAddition 不能被清掉');
  /* 顶层其它键也要在 */
  assert.deepEqual(after['power_user'], { some: 1 }, 'power_user 不能被清掉');
});

test('★★ 读字段要能容忍中间层不存在', () => {
  /* 老版本 ST 可能没有 extension_settings.cfg —— 不能抛，要用 fallback */
  const sparse = { extension_settings: {} };
  const cfgField = BEHAVIOR_SECTION.fields.find(
    (f) => f.path.join('.') === 'extension_settings.cfg.global.guidance_scale',
  );
  assert.ok(cfgField !== undefined);
  assert.equal(readField(sparse, cfgField), 1, '读不到要落到 fallback（1）');
});

/* ═══════════════════════════════════════════════════════════
   二、菜单里必须真的能进到操作页
   ═══════════════════════════════════════════════════════════ */

test('★★★ 「聊天操作」入口必须接线（不许只是渲染一行）', () => {
  /*
   * 这个项目最反复的缺陷类型：实现存在但没接线 —— 菜单渲染得好好的，
   * 点下去毫无反应（`onOpenGroup` 就漏过一次，截图里"点了还停在菜单"）。
   *
   * 所以 `onOpenActions` 声明成**必选**，并且 shell 必须给它赋值。
   */
  assert.match(shell, /onOpenActions:\s*\(\)\s*=>\s*\{/, 'shell 必须给 onOpenActions 赋值');
  assert.match(shell, /chatSettingsRoute = 'actions'/, '要切到 actions 路由');
  assert.match(shell, /renderChatActions\(\)/, '要有渲染方法');
  assert.match(shell, /renderChatFiles\(\)/, '要有文件页渲染方法');
});

test('★★★ 新增的两个路由必须排在"分组页"分支**之前**', () => {
  /*
   * `'actions'` / `'files'` 不是字段分组。若落进 `renderChatSettingsSection`，
   * `sectionOf()` 会返回 null ⇒ 渲染成空表单 —— 页面看起来"打开了但什么都没"。
   */
  const at = shell.indexOf("chatSettingsRoute === 'actions'");
  const sectionAt = shell.indexOf('this.renderChatSettingsSection(this.chatSettingsRoute)');
  assert.ok(at > 0 && sectionAt > 0, '两处都要存在');
  assert.ok(at < sectionAt, 'actions 分支要在分组页分支之前');
});

/* ═══════════════════════════════════════════════════════════
   三、8 个动作：每一个都要有真实实现
   ═══════════════════════════════════════════════════════════ */

test('★★★ 8 个动作全部渲染出来（Token 概率是说明行，不是按钮）', () => {
  for (const id of [
    'checkpoint',
    'new-chat',
    'close-chat',
    'manage-files',
    'ai-assist',
    'continue',
    'convert-group',
  ]) {
    assert.ok(page.includes(`id: '${id}'`), `缺动作 ${id}`);
  }
  /* Token 概率单独成"说明行" */
  assert.ok(page.includes("'token-probs'"), 'Token 概率那一项要存在');
  assert.match(page, /nb-listitem--note/, '它要渲染成说明行而不是按钮');
});

test('★★★ Token 概率必须如实说明"不支持"，不许画成能点', () => {
  /*
   * 它需要后端返回 `logprobs`，而我们的生成走 ST 的纯文本 SSE，拿不到。
   * 画一个点了没反应的按钮，用户会以为是坏的 —— 写清原因他才能判断去哪看。
   */
  /*
   * ★ 2026-11-03 改定位方式：原来搜 `'token-probs'`，现在它会先命中
   * `HIDDEN_ACTIONS` 集合里那一项（文件靠前），切片切到的是集合附近，
   * 于是"暂不支持"找不到 ⇒ 假红。
   *
   * 改成锚在**渲染那一行**（`setAttribute('data-action', 'token-probs')`）。
   *
   * 这条判据现在不再约束界面（该项已被用户要求隐藏），但**必须留着**：
   * 用户说"这些作为后续功能加进去"，将来放出来时它立刻恢复作用 ——
   * 那时若有人把它画成能点的按钮，这条会拦住。
   */
  const at = page.indexOf("'data-action', 'token-probs'");
  assert.ok(at > 0, '找不到 Token 概率的渲染位置');
  const body = page.slice(Math.max(0, at - 400), at + 600);
  assert.match(body, /暂不支持/, '要明说暂不支持');
  assert.match(body, /logprobs|纯文本|候选/, '要给出技术原因（用户能据此判断）');
  assert.equal(/addEventListener/.test(body), false, '说明行不许挂点击');
});

test('★★★ 转群聊必须走 groups/create（group/convert 实测 404）', () => {
  assert.match(shell, /bridge\.createGroup\(/, '要走建群命令');
  const rust = readFileSync(join(ROOT, 'client/src-tauri/src/st_chat.rs'), 'utf8');
  assert.match(rust, /fn st_chat_group_create/, '要有 Rust 命令');
  assert.match(rust, /\/api\/groups\/create/, '要打这个端点');
  assert.equal(
    /\/api\/groups\/convert/.test(rust),
    false,
    '不许打 convert（实测 404）',
  );
});

test('★★★ 检查点 / 新聊天必须用**新文件名**（否则覆盖原聊天）', () => {
  /*
   * `chats/save` 是整份覆盖。用原文件名保存检查点 = 把原聊天改成检查点内容，
   * 不可逆。所以文件名必须唯一。
   */
  const at = shell.indexOf('const saveAs = async');
  assert.ok(at > 0, '要有 saveAs');
  const body = shell.slice(at, at + 1400);
  assert.match(body, /pad\(stamp\.getSeconds\(\)\)/, '文件名要精确到秒（避免撞名）');
  assert.match(body, /saveChat\(avatar, fileName/, '要按生成的唯一名字保存');
});

test('★★★ AI 帮答 / 续写用临时 system 指令，不污染聊天记录', () => {
  /*
   * 塞进用户消息会永久留在 `this.messages` 里 —— 用户回看时看到一条
   * 自己从没打过的"（请以旁白口吻给建议）"。
   */
  assert.match(panel, /runDirective\(instruction: string\)/, '要有 runDirective');
  const at = panel.indexOf('const messagesForRequest =');
  assert.ok(at > 0, '要有指令注入');
  const body = panel.slice(at, at + 400);
  assert.match(body, /role: 'system'/, '要作为 system 消息');
  assert.equal(
    /this\.messages\s*=\s*\[\.\.\.this\.messages,/.test(body),
    false,
    '不许把指令写进 messages',
  );
});

/* ═══════════════════════════════════════════════════════════
   四、文件列表解析（纯函数，可单测）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 文件列表解析要容错三种返回形态', () => {
  /* 空 */
  assert.deepEqual(parseChatFileRows('', 'x'), []);
  /* `{"error":true}`：缺参数时 ST 会这么回 */
  assert.deepEqual(parseChatFileRows('{"error":true}', 'x'), []);
  /* 坏 JSON 不抛 */
  assert.deepEqual(parseChatFileRows('{oops', 'x'), []);
  /* 正常 */
  const rows = parseChatFileRows(
    JSON.stringify([
      { file_id: 'a', file_name: 'a.jsonl', last_mes: 4 },
      { file_id: 'b', file_name: 'b', last_mes: '9' },
    ]),
    'a',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.id, 'a', '当前这条要排最前');
  assert.equal(rows[0]?.current, true);
  assert.equal(rows[0]?.name, 'a', '名字要去掉 .jsonl');
  assert.equal(rows[0]?.count, 5, 'last_mes 是下标，条数要 +1');
  assert.equal(rows[1]?.count, 10, '字符串形式的 last_mes 也要认');
});

test('★★ 缺 file_id 的条目要跳过（否则点了会打空请求）', () => {
  const rows = parseChatFileRows(JSON.stringify([{ file_name: 'x' }, { file_id: 'ok' }]), null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 'ok');
});

/* ═══════════════════════════════════════════════════════════
   五、CSS token 必须真实存在（这条守的是"静默失效"）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 新样式用的每个 token 都必须有定义', () => {
  /*
   * `var(--nb-accent)` —— 这个 token **不存在**。`var()` 取不到值时
   * 整条声明**静默失效**，按钮退回默认灰，界面上一点报错都没有。
   * 我第一版就写错了（memory §73 记过同一个坑：`--nb-text-4`）。
   *
   * 判据：把 chat.css 里所有 `var(--nb-xxx)` 的 xxx 抽出来，
   * 逐个确认在 nebula-tokens.css 里有定义。
   */
  /*
   * 有一类 token **本来就不该**在 `nebula-tokens.css` 里：它们由 JS 在运行时
   * 写到 `documentElement.style`（键盘高度、安全区、波形电平…）。
   * 把这些当成"未定义"会误报 —— 判据要能区分"设计令牌"和"运行时变量"。
   */
  const RUNTIME_SET = new Set([
    '--nb-kb-inset',
    '--nb-kb-inset-native',
    '--nb-safe-top',
    /*
     * 底部安全区（2026-11-04）。
     *
     * 与 `--nb-safe-top` 同一族：由 `MainActivity.injectSafeArea()` /
     * insets 监听从 Android `WindowInsets` 读出来写到 documentElement。
     * 不放进白名单会被判成"未定义、会静默失效"。
     *
     * ★ 它与 `--nb-safe-top` 的差别：**CSS 里配了像素兜底**
     * （`max(var(--nb-safe-bottom, ...), 20px)`），所以"没注入"也不会塌。
     */
    '--nb-safe-bottom',
    '--nb-wave-level',
    '--nb-voice-bar-width',
  ]);

  const defined = new Set(
    [...tokensCss.matchAll(/(--nb-[a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  );
  const used = new Set(
    [...css.matchAll(/var\(\s*(--nb-[a-z0-9-]+)/g)].map((m) => m[1]),
  );
  const missing = [...used].filter((t) => !defined.has(t) && !RUNTIME_SET.has(t));
  assert.deepEqual(
    missing,
    [],
    `这些 token 用了但没定义（会静默失效）：${missing.join(', ')}`,
  );
});
