/**
 * 「仓库某一版 → 本地角色卡」的纯逻辑判据（2026-11-04）。
 *
 * ## 用户要求
 *
 * > 点击仓库里的对应卡片，点击对应版本卡片的下载即可将卡片导入到 ST 内
 * > （注意此处还是不能出现 ST 的字样）
 *
 * ## 这组判据守什么
 *
 * 三件事错了都**不报错**，只是结果不对：
 *
 * ```text
 *   v3 的 JSON 写进 chara 块   → 卡能导入、名字对、设定一个字都没有
 *   文件名撞了没去重           → 静默覆盖原来那张卡
 *   文件名没过滤非法字符       → 写文件失败，或写到别的目录
 * ```
 *
 * 三种都要逐条钉。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planCardImport, sanitizeAvatarBase } from '../shared/dist/repo/card-import.js';

const v2 = (name) => JSON.stringify({ spec: 'chara_card_v2', name, description: 'd' });
const v3 = (name) => JSON.stringify({ spec: 'chara_card_v3', data: { name, description: 'd' } });

/* ═══════════════════════════════════════════════════════════
   一、块类型要跟着原卡的 spec 走
   ═══════════════════════════════════════════════════════════ */

test('★★★ v3 卡认出 ccv3（名字从 data 里取）', () => {
  const r = planCardImport({ jsonText: v3('林晚照'), cardId: 'card-abc', existingAvatars: [] });
  assert.equal(r.ok, true);
  assert.equal(r.plan.spec, 'v3', 'v3 卡必须写进 ccv3 块');
  assert.equal(r.plan.avatar, '林晚照.png');
});

test('★★★ v2 卡认 chara（名字从顶层取）', () => {
  const r = planCardImport({ jsonText: v2('林晚照'), cardId: 'card-abc', existingAvatars: [] });
  assert.equal(r.ok, true);
  assert.equal(r.plan.spec, 'v2');
  assert.equal(r.plan.avatar, '林晚照.png');
});

test('★★★ 有 data 但 spec 是 v2 ⇒ 仍然按 v2（别只看有没有 data）', () => {
  /*
   * 某些工具导出的 v2 卡也带一个 data 对象。只看"有没有 data"会把 v2
   * 判成 v3，写进 ccv3 块 —— 读取方去 data 里找正文，拿到空。
   */
  const text = JSON.stringify({ spec: 'chara_card_v2', name: '顶层名', data: { name: '内部名' } });
  const r = planCardImport({ jsonText: text, cardId: 'c', existingAvatars: [] });
  assert.equal(r.plan.spec, 'v2');
  assert.equal(r.plan.avatar, '内部名.png', 'v2 带 data 时优先 data.name（与读取方一致）');
});

test('★★ 没有 spec 字段 ⇒ 按 v2（老卡没有 spec，读取方认 chara）', () => {
  const r = planCardImport({
    jsonText: JSON.stringify({ name: '老卡' }),
    cardId: 'c',
    existingAvatars: [],
  });
  assert.equal(r.plan.spec, 'v2');
  assert.equal(r.plan.avatar, '老卡.png');
});

/* ═══════════════════════════════════════════════════════════
   二、文件名
   ═══════════════════════════════════════════════════════════ */

test('★★★ 撞名要加序号，不许静默覆盖', () => {
  const r = planCardImport({
    jsonText: v2('林晚照'),
    cardId: 'c',
    existingAvatars: ['林晚照.png'],
  });
  assert.equal(r.plan.avatar, '林晚照 (2).png');
  assert.equal(r.plan.displayName, '林晚照 (2)', '提示里要说出去重后的名字');
});

test('★★ 撞名两次 ⇒ (3)', () => {
  const r = planCardImport({
    jsonText: v2('林晚照'),
    cardId: 'c',
    existingAvatars: ['林晚照.png', '林晚照 (2).png'],
  });
  assert.equal(r.plan.avatar, '林晚照 (3).png');
});

test('★★ 去重大小写不敏感（列表里只差大小写会混淆）', () => {
  const r = planCardImport({ jsonText: v2('Aria'), cardId: 'c', existingAvatars: ['aria.png'] });
  assert.equal(r.plan.avatar, 'Aria (2).png');
});

test('★★★ 路径分隔符与控制字符要滤掉', () => {
  assert.equal(sanitizeAvatarBase('a/b\\c'), 'abc');
  assert.equal(sanitizeAvatarBase('a:b*c?d"e<f>g|h'), 'abcdefgh');
  assert.equal(sanitizeAvatarBase('a\nb\tc'), 'abc');
});

test('★★★ 全是非法字符 ⇒ 给一个能认出来的兜底名', () => {
  assert.equal(sanitizeAvatarBase('///'), '未命名卡片');
  assert.equal(sanitizeAvatarBase(''), '未命名卡片');
});

test('★★ 前导点要去掉（`..` 是目录穿越）', () => {
  assert.equal(sanitizeAvatarBase('..hidden'), 'hidden');
  assert.equal(sanitizeAvatarBase('...'), '未命名卡片');
});

test('★★ 超长名字要截断（按码点，不切半个中文/emoji）', () => {
  const long = '晚'.repeat(200);
  const out = sanitizeAvatarBase(long);
  assert.ok(Array.from(out).length <= 48, `实际 ${String(Array.from(out).length)} 个码点`);
  assert.ok(!out.includes('\ufffd'), '不许出现替换字符（说明切坏了）');
});

/* ═══════════════════════════════════════════════════════════
   三、拒绝的情况
   ═══════════════════════════════════════════════════════════ */

test('★★★ 空内容不许当卡导入', () => {
  const r = planCardImport({ jsonText: '   ', cardId: 'c', existingAvatars: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /空/);
});

test('★★ 不是 JSON 也要能给出一个名字（不能崩）', () => {
  const r = planCardImport({ jsonText: 'not json', cardId: 'card-xyz', existingAvatars: [] });
  assert.equal(r.ok, true, '内容非空就该尝试导入');
  assert.equal(r.plan.spec, 'v2', '读不懂就按 v2，别猜 v3');
  assert.equal(r.plan.avatar, 'card-xyz.png', '名字取不到就用 cardId，让人认得出');
});

test('★★ 卡名全是空白 ⇒ 用 cardId', () => {
  const r = planCardImport({
    jsonText: JSON.stringify({ spec: 'chara_card_v2', name: '   ' }),
    cardId: 'card-abc',
    existingAvatars: [],
  });
  assert.equal(r.plan.avatar, 'card-abc.png');
});

/* ═══════════════════════════════════════════════════════════
   四、面向用户的文案不许出现内部术语
   ═══════════════════════════════════════════════════════════ */

test('★★★ 导入链路的文案不许出现 ST / SillyTavern', async () => {
  const { readFileSync } = await import('node:fs');
  const files = [
    'client/src/chat/default-face.ts',
    'client/src/chat/repo-page.ts',
    'shared/src/repo/card-import.ts',
  ];
  for (const rel of files) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    /* 只看字符串字面量（注释里可以提到内部实现） */
    const literals = [...src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
      .matchAll(/'([^'\n]{4,})'/g)].map((m) => m[1]);
    for (const text of literals) {
      if (text.includes('@tcs/') || text.startsWith('.')) continue;
      assert.ok(!/SillyTavern/i.test(text), `${rel} 出现 SillyTavern：${text.slice(0, 40)}`);
      assert.ok(!/(?<![A-Za-z_])ST(?![A-Za-z_])/.test(text), `${rel} 出现 ST：${text.slice(0, 40)}`);
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   五、落盘与错误文案（2026-11-04 真机两处缺陷）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 导入必须走「允许新建」，否则新卡写不进去', async () => {
  /*
   * 真机第一轮：点下载后角色数 1 → 1，提示条只有一条 `[object Object]`。
   * 真因在 Rust：`st_chat_character_write_png` 默认要求"文件必须已存在"
   * （那是编辑器改现有卡的语义），导入一张**新卡**必然报
   * 「角色文件不存在」。
   *
   * 所以导入这条路径必须显式传 `allowCreate = true`。
   */
  const { readFileSync } = await import('node:fs');
  const shell = readFileSync(new URL('../client/src/chat/shell.ts', import.meta.url), 'utf8');
  /*
   * ★ 2026-11-06：实现从 `onImportVersion` 回调**提成了方法**
   *   （`importRepoVersion`）—— 因为三级页面（卡片历史）也要调它，
   *   而三级是另一个渲染函数，拿不到一级那个闭包。
   *
   *   判据要守的性质没变（导入必须 allowCreate），只是要找对位置。
   *   原来的锚点 `onImportVersion:` 现在只剩一行委托，自然找不到。
   */
  const at = shell.indexOf('private async importRepoVersion(');
  assert.ok(at > 0, '找不到 importRepoVersion 方法');
  const block = shell.slice(at, at + 3600);

  /*
   * ★ 2026-11-06 起 `allowCreate` 不是硬编码的 `true` 了 ——
   *   它跟着 `overwrite` 走（同名角色导入要覆盖已有那张）。
   *
   * ```text
   *   新卡   overwrite=false ⇒ allowCreate=true    要求同名不存在
   *   覆盖   overwrite=true  ⇒ allowCreate=false   要求文件已存在
   * ```
   *
   * 所以判据从"必须写 true"改成"**必须由 overwrite 决定**，
   * 且两个方向都不许写死"：
   *
   * ```text
   *   ✗ writeCharacterPng(avatar, dir, png, true)     ← 覆盖场景会报错
   *   ✓ writeCharacterPng(avatar, dir, png, !overwrite)
   * ```
   *
   * 这条守的性质没变（新卡必须允许新建），只是现在还要同时守住覆盖。
   */
  assert.match(
    block,
    /writeCharacterPng\(avatar, charactersDir, png, !overwrite\)/,
    'allowCreate 要取 !overwrite（新卡 true / 覆盖 false）',
  );
  assert.doesNotMatch(
    block,
    /writeCharacterPng\(avatar, charactersDir, png, (true|false)\)/,
    '不许写死 allowCreate —— 覆盖与新建两个方向都需要',
  );
});

test('★★★ Rust 侧：新建时不许静默覆盖已有同名卡', async () => {
  const { readFileSync } = await import('node:fs');
  const rs = readFileSync(new URL('../client/src-tauri/src/st_chat.rs', import.meta.url), 'utf8');
  const at = rs.indexOf('pub async fn st_chat_character_write_png');
  assert.ok(at > 0);
  const block = rs.slice(at, at + 3600);

  assert.match(block, /allow_create: Option<bool>/, '要有 allow_create 开关');
  assert.match(block, /let creating = allow_create\.unwrap_or\(false\)/, '默认必须是 false（只改现有）');
  assert.match(block, /if target\.exists\(\)/, '新建时要判重名');
  assert.match(block, /已经有一张同名卡片了/, '重名要报出来，不许覆盖');
});

test('★★★ 仓库页不许再用 String(error)（会显示 [object Object]）', async () => {
  /*
   * Tauri 的 invoke 抛的是普通对象 `{code, message, details}`，
   * 不是 Error 实例。`String(obj)` 得到 `[object Object]`，
   * 唯一有用的 message 被丢掉 —— 用户看到"操作失败：[object Object]"。
   *
   * 全项目唯一该用的是 `describeBridgeError`。
   */
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/src/chat/repo-page.ts', import.meta.url), 'utf8');

  /* 剥注释再判（我自己就在注释里引用过这个错误写法 —— §93 踩过） */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
  assert.doesNotMatch(code, /String\(error\)/, '不许用 String(error) 转错误');
  assert.match(code, /describeBridgeError/, '要用统一的错误描述');
});
