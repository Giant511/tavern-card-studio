/**
 * 「导出/分享拿到的是旧卡」的判据（2026-11-16，用户报的真缺陷）。
 *
 * ## 用户报的原话
 *
 * > 为啥新增角色特有的提示词，重新导入后没有了，重点排查导出的时候
 * > 有没有把这个提示词导出
 *
 * ## 真因
 *
 * 不是"导出丢字段"（ST 的 `/api/characters/export` 从磁盘读原 PNG，
 * 只删 `fav` / `chat`，`extensions.tcs.prompts` 原样保留，已核实源码）。
 *
 * 而是**导出用的是旧字节**：
 *
 * ```text
 *   进「卡片」Tab → prefetchForShare 把每张卡的 PNG 缓存起来
 *   回聊天加提示词 → 写卡成功（磁盘已是新卡）
 *   再回「卡片」Tab → 预取里 `if (shareCache.has(avatar)) continue` 跳过
 *   点「导出并分享」→ 用**加提示词之前**那份字节
 *   ⇒ 导出的卡里没有 tcs.prompts，导入回来当然也没有
 * ```
 *
 * 而 `shareCache` 原来**没有任何一处清空** —— 一次 App 生命周期内，
 * 只要进过一次卡片列表，之后所有导出都是那一刻的旧卡。
 *
 * ## 这个文件钉什么
 *
 * ```text
 * ① 写卡必须收口（三处写卡各调一次 bridge.writeCharacterPng 是不可能的防线）
 * ② 写卡成功必须作废这张卡的分享缓存
 * ③ 进列表时预取必须 force（缓存里有也重读）
 * ④ 导出用的是缓存（同步签名决定的），所以 ①②③ 缺一不可
 * ```
 *
 * ★ 这类缺陷的共性是"两个真值，只更新了一个"：
 * 磁盘上的卡是新的、`shareCache` 里是旧的。本项目已有多次同源教训
 * （§106.3 `localStorage` 回读≠落盘、§130 通知与重绘顺序）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 去注释（判定源码文本时必须做，否则注释会骗判据） */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 取两个语义锚点之间的一段（不用固定字符窗口，见 §149.4） */
function between(code, startNeedle, endNeedle) {
  const at = code.indexOf(startNeedle);
  assert.ok(at >= 0, `找不到起点锚：${startNeedle}`);
  const end = code.indexOf(endNeedle, at + startNeedle.length);
  assert.ok(end > at, `找不到终点锚：${endNeedle}`);
  return code.slice(at, end);
}

const shell = stripComments(read('client/src/chat/shell.ts'));

/* ═══════════════════════════════════════════════════════════
   一、写卡收口（防止将来新增第四处写卡漏掉清缓存）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 全文件只有 writeCardPng 一处直接写卡', () => {
  /*
   * 这是本文件最重要的一条。
   *
   * 原来三处写卡各写一行 `this.bridge.writeCharacterPng(...)`：
   * 导入 / 存开场白 / 存提示词。谁也没想到要清分享缓存 ——
   * 而"想到"这件事本身是不可靠的防线。
   *
   * 收口成 `writeCardPng()` 之后，新增写卡路径时只要跟着既有的写，
   * 就自动带上了"作废缓存"。漏掉会在 CI 红。
   */
  const calls = [];
  const re = /bridge\.writeCharacterPng\(/g;
  let match;
  while ((match = re.exec(shell)) !== null) {
    const line = shell.slice(0, match.index).split('\n').length;
    calls.push(line);
  }

  assert.equal(
    calls.length,
    1,
    `只允许 writeCardPng() 内部调 bridge.writeCharacterPng 一次，实际 ${String(calls.length)} 处：` +
      calls.map((n) => `第 ${String(n)} 行`).join('、') +
      '。写卡请走 this.writeCardPng()（它会作废分享缓存）。',
  );
});

test('★★★★★ 写卡成功后必须作废这张卡的分享缓存', () => {
  const seg = between(shell, 'private async writeCardPng(', 'private async prefetchForShare(');

  const writeAt = seg.indexOf('writeCharacterPng');
  const deleteAt = seg.indexOf('this.shareCache.delete(avatar)');
  assert.ok(writeAt > 0, '方法里应当真的写卡（经 bridge）');
  assert.ok(deleteAt > 0, '必须作废分享缓存 —— 否则导出用的是改之前的字节');
  assert.ok(
    writeAt < deleteAt,
    '先写盘、后作废缓存（反了的话写失败也会把缓存清掉，白丢一次预取）',
  );
});

test('★★★★ 三处写卡都走 writeCardPng（导入 / 开场白 / 提示词）', () => {
  /*
   * 判"确实有三处调用"而不是"有一种写法"：三处都写卡，
   * 少一处就等于那条路径上导出还是旧卡。
   */
  const calls = [...shell.matchAll(/this\.writeCardPng\(/g)];
  assert.ok(
    calls.length >= 3,
    `至少三处写卡都要走这个入口（导入 / 开场白 / 提示词），实际 ${String(calls.length)} 处`,
  );
});

/* ═══════════════════════════════════════════════════════════
   二、预取必须能强制刷新
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 进列表时的预取必须 force（缓存里有也重读）', () => {
  /*
   * 只靠"写卡时作废缓存"还不够：`saveGreeting` / 导入 与"进列表"之间
   * 可能夹着别的路径，任何一条漏了就回到旧行为。所以进列表时**无条件重读**，
   * 让"看到的列表"与"导出的字节"必然是同一次读取的结果。
   *
   * 第一版是 `if (this.shareCache.has(item.avatar)) continue;` ——
   * 那一句配合函数内部的早退，让缓存永不刷新。
   */
  /*
   * 锚点用 `listCharactersRaw()` —— 全文件只有这一处（列表页预取）。
   * 第一版用 `void (async () => {` 当起点，命中的是**另一个**异步块（假红）。
   */
  const seg = between(
    shell,
    '() => this.bridge.listCharactersRaw()',
    'private async prefetchForShare(',
  );

  assert.match(
    seg,
    /await this\.prefetchForShare\(item\.avatar, true\)/,
    '预取要传 force=true',
  );
  assert.doesNotMatch(
    seg,
    /shareCache\.has\(item\.avatar\)/,
    '不许先用 has 跳过 —— 那是"缓存永不刷新"的直接原因',
  );
});

test('★★★★ 预取函数支持 force 参数，且内部早退受它约束', () => {
  const seg = between(shell, 'private async prefetchForShare(', 'private renderChatSettingsMenu(');

  assert.match(seg, /force = false/, '要有 force 参数（默认不强制，给 onShare 用）');
  assert.match(
    seg,
    /if \(!force && this\.shareCache\.has\(avatar\)\) return/,
    '早退必须写成"非 force 且有缓存"才返回',
  );
});

test('★★★★ 导出仍然是同步取缓存（不能改成每次都异步读）', () => {
  /*
   * 这条是**反向**判据：钉住"为什么必须有缓存"。
   *
   * `onShare` 的签名是同步的（Kotlin 的 `ACTION_SEND` 要同步拿参数），
   * 而读 PNG 必须走异步的 `invoke`。所以"取消缓存、每次现读"这个想法
   * 在这里不成立 —— 那样每次点导出都只能拿到"正在准备"。
   *
   * 写这条是为了防止后一个人"简化"掉缓存，然后把导出变成永远失败。
   */
  const seg = between(shell, 'onShare: (character: CharacterSummary)', 'this.pageHost.append(page);');

  assert.match(seg, /this\.shareCache\.get\(character\.avatar\)/, '导出要读缓存');
  assert.match(seg, /正在准备/, '没缓存时要如实说"正在准备"，不能拿别的卡顶上');
});

/* ═══════════════════════════════════════════════════════════
   三、可诊断（这一轮全靠推演，因为没有任何一条日志）
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 写回与取卡都要留日志，能分开"卡里没有"和"读的是旧卡"', () => {
  /*
   * 上一轮排查时日志里**一条相关记录都没有**，只能靠读代码推演。
   * 下次再报同样问题，这两条日志能把原因一刀切开：
   *
   * ```text
   *   [分享] 取卡 … 有提示词=no   ⇒ 卡本身就没写进去（写回失败）
   *   [分享] 取卡 … 有提示词=yes  ⇒ 卡里有，丢在导入/别的环节
   * ```
   */
  assert.match(shell, /\[提示词\] 写回 avatar=/, '写回要记一条（含条数与字节数）');
  assert.match(shell, /\[分享\] 取卡 avatar=/, '取卡要记一条（含有没有提示词）');
  assert.match(shell, /有提示词=\$\{prompts === null \? 'no' : 'yes'\}/, '要说清有/没有');
});

/* ═══════════════════════════════════════════════════════════
   四、离线复现：旧缓存 ⇒ 导出的卡里没有提示词
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 离线复现：用旧字节导出，卡里就是没有提示词', async () => {
  /*
   * 把这条链在纯函数层走一遍 —— 不是为了"证明推演成立"，
   * 而是把**失败的形状**钉下来：
   *
   * ```text
   *   同一张卡的两个版本：加提示词前 / 加提示词后
   *   导出取到"前"那份 ⇒ 解析出来 prompts === null
   *   导出取到"后"那份 ⇒ own.length === 1
   * ```
   *
   * 将来任何人改这条链，只要"导出的字节不是最新的"，这条就会红。
   */
  const { buildPngCard, parsePngCard, parseStCardText, stringifyStCard } = await import(
    '../shared/dist/index.js'
  );
  const { emptyCharacterPrompts, upsertOwnPrompt, writeCharacterPrompts, parseCharacterPrompts } =
    await import('../shared/dist/chat/index.js');

  const bare = readFileSync(join(ROOT, 'test', 'fixtures', 'png', 'fixture-v2.png'));
  const before = parsePngCard(new Uint8Array(bare));
  assert.equal(before.kind, 'card', 'fixture 应当是一张卡');

  /* 旧版本（用户加提示词之前） */
  const oldBytes = new Uint8Array(bare);
  const oldPrompts = parseCharacterPrompts(
    parseStCardText(before.jsonText).card.passthrough.data['extensions'],
  );
  assert.equal(oldPrompts, null, '原卡不该有角色级提示词');

  /* 新版本：加一条角色特有 */
  const card = parseStCardText(before.jsonText).card;
  let config = emptyCharacterPrompts();
  config = upsertOwnPrompt(config, {
    id: 'tcs-1',
    name: '方言',
    content: '说话带四川口音',
    role: 'system',
    enabled: true,
  });
  const prev = card.passthrough.data['extensions'];
  const extensions = writeCharacterPrompts(
    prev !== null && typeof prev === 'object' && !Array.isArray(prev) ? prev : null,
    config,
  );
  const updated = {
    ...card,
    passthrough: { ...card.passthrough, data: { ...card.passthrough.data, extensions } },
  };
  const newBytes = buildPngCard(
    new Uint8Array(bare),
    stringifyStCard(updated, { indent: 2, entryTitleToComment: true }),
    'v2',
  );

  /* 从"新版本字节"导出 ⇒ 有提示词 */
  const fromNew = parsePngCard(newBytes);
  assert.equal(fromNew.kind, 'card');
  const newPrompts = parseCharacterPrompts(
    parseStCardText(fromNew.jsonText).card.passthrough.data['extensions'],
  );
  assert.notEqual(newPrompts, null, '新字节里应当有提示词');
  assert.equal(newPrompts.own.length, 1, '应当有 1 条角色特有');

  /* 从"旧版本字节"导出 ⇒ 没有（这就是用户遇到的现象） */
  const fromOld = parsePngCard(oldBytes);
  assert.equal(fromOld.kind, 'card');
  const stalePrompts = parseCharacterPrompts(
    parseStCardText(fromOld.jsonText).card.passthrough.data['extensions'],
  );
  assert.equal(
    stalePrompts,
    null,
    '用旧字节导出 = 用户看到的"提示词没了"。这条钉住两个版本确实是可区分的',
  );
});
