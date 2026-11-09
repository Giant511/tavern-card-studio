/**
 * 2026-11-06 四个真机问题。
 *
 * ## 用户四条
 *
 * > 1、已存在角色的时候从仓库中再次导入同一个角色的时候会出现多个角色
 * >    （其他途径导入角色的时候也要做去重处理）。
 * > 2、选择聊天时同一个角色不跳转到聊天（建议检测一下用户当前点击的是不是
 * >    聊天中的角色，不是就直接加载点击的角色并跳转，如果是就直接跳转）。
 * > 3、在已经存在聊天记录的时候，再次打开APP，开屏动画之后会短暂显示还没有
 * >    聊天的那个界面，干脆再把开屏动画弄长一点，聊天记录页面加载完成后再显示。
 * > 4、从仓库导入的角色明明是包含角色世界书的，但是世界书编辑里面却没有。
 *
 * ## 四条都是"静默出错"
 *
 * ```text
 * ① 同名 → 生成 ` (2)` 副本（代码故意这么写的，注释还写着"去重"）
 * ② 点角色 → renderPage 排在 60 秒重试之后 ⇒ 点了没反应
 * ③ 开屏 → 恢复历史是 void 异步 ⇒ 闪一下空界面
 * ④ 内嵌世界书 → 只写 PNG，不落 worlds/ ⇒ 列表里没有
 * ```
 *
 * 没有一条会报错、会红单测 —— 所以判据要钉到**行为**上。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g).replace(/^\s*\/\/[^\n]*$/gm, '');
}

const shellSrc = stripComments(read('client/src/chat/shell.ts'));
const importSrc = read('shared/src/repo/card-import.ts');
const worldSrc = read('shared/src/repo/embedded-worldbook.ts');
const mainSrc = stripComments(read('client/src/mobile/main.ts'));

/* ═══════════════════════════════════════════════════════════
   ① 导入去重：同名要覆盖，不是新建副本
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 同名角色导入要复用已有文件（不许生成 (2) 副本）', async () => {
  /*
   * 真机上同一个角色导入两次，列表里出现：
   *
   * ```text
   *   西奥.png        ← 第一次
   *   西奥 (2).png    ← 第二次（第一版"去重"的产物）
   * ```
   *
   * 第一版的 `uniqueAvatar` 把"同名"一律当成"两张不同的卡"。
   * 从文件名推不出"同一个角色"（两个字符串不同），必须按**卡名**比。
   *
   * 这条**真跑** `planCardImport`，不读源码。
   */
  const { planCardImport } = await import('../shared/dist/repo/card-import.js');

  const cardJson = JSON.stringify({
    spec: 'chara_card_v2',
    data: { name: '西奥', first_mes: '你好' },
  });

  /* 场景 1：本地已有同名角色 ⇒ 覆盖它，不起新文件 */
  const reuse = planCardImport({
    jsonText: cardJson,
    cardId: 'c1',
    existingAvatars: ['西奥.png'],
    existingNames: ['西奥'],
  });
  assert.equal(reuse.ok, true, '应该成功');
  if (reuse.ok) {
    assert.equal(reuse.plan.avatar, '西奥.png', '要复用已有的那个文件名');
    assert.equal(reuse.plan.overwrite, true, '要标记为覆盖');
  }

  /* 场景 2：本地没有这个角色 ⇒ 新建，overwrite=false */
  const fresh = planCardImport({
    jsonText: cardJson,
    cardId: 'c1',
    existingAvatars: ['别人.png'],
    existingNames: ['别人'],
  });
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(fresh.plan.avatar, '西奥.png');
    assert.equal(fresh.plan.overwrite, false, '新卡不该覆盖');
  }

  /* 场景 3：真的有另一张同名卡但文件名不同 ⇒ 按名字覆盖（用户要的效果） */
  const renamed = planCardImport({
    jsonText: cardJson,
    cardId: 'c1',
    existingAvatars: ['西奥-旧.png'],
    existingNames: ['西奥'],
  });
  assert.equal(renamed.ok, true);
  if (renamed.ok) {
    assert.equal(renamed.plan.avatar, '西奥-旧.png', '要认用户手改过的文件名');
    assert.equal(renamed.plan.overwrite, true);
  }

  /* 场景 4：不同名 ⇒ 各自独立（不许因为"都是卡"就合并） */
  const other = planCardImport({
    jsonText: JSON.stringify({ data: { name: '西奥2' } }),
    cardId: 'c2',
    existingAvatars: ['西奥.png'],
    existingNames: ['西奥'],
  });
  assert.equal(other.ok, true);
  if (other.ok) {
    assert.equal(other.plan.avatar, '西奥2.png', '不同名要新建');
    assert.equal(other.plan.overwrite, false);
  }
});

test('★★★★★ writeCharacterPng 的 allowCreate 必须跟着 overwrite 走', () => {
  /*
   * 两个语义必须成对，反着传会报错（Rust 侧两个方向都校验）：
   *
   * ```text
   *   新卡（overwrite=false） ⇒ allowCreate=true   要求同名不存在
   *   覆盖（overwrite=true）  ⇒ allowCreate=false  要求文件已存在
   * ```
   */
  assert.match(
    shellSrc,
    /writeCharacterPng\(avatar, charactersDir, png, !overwrite\)/,
    'allowCreate 要取 !overwrite',
  );

  /* 名字必须真的传进去 */
  assert.match(
    shellSrc,
    /existingNames: listed\.items\.map/,
    '要把本地角色名传给规划函数',
  );
});

/* ═══════════════════════════════════════════════════════════
   ② 点角色必须立即跳转
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ renderPage 不许排在 restoreLatestChat 之后', () => {
  /*
   * 真机和录屏：点角色后画面一直停在「选择角色」，7 秒没动。
   *
   * 真因：
   *
   * ```text
   *   await loadCharacterCard(...)
   *   await restoreLatestChat(...)   // ★ 重试到 60 秒
   *   this.renderPage()              // ← 排在后面
   * ```
   *
   * `renderPage()` 才是"关掉选择器、回到聊天页"那一步。
   *
   * 这条判据钉的是**源码里的顺序**：在 `onPick` 里，
   * 第一次 `renderPage()` 必须出现在 `restoreLatestChat` **之前**。
   */
  const at = shellSrc.indexOf('onPick: (character: CharacterSummary) => {');
  assert.ok(at > 0, '找不到 onPick');
  const body = shellSrc.slice(at, at + 3000);

  const firstRender = body.indexOf('this.renderPage()');
  const restore = body.indexOf('this.restoreLatestChat');
  assert.ok(firstRender > 0, 'onPick 里要有 renderPage');
  assert.ok(restore > 0, 'onPick 里要有 restoreLatestChat');
  assert.ok(
    firstRender < restore,
    `renderPage 必须在 restoreLatestChat 之前（实际 ${String(firstRender)} vs ${String(restore)}）`,
  );
});

test('★★★★ 点的就是当前角色时要直接跳（不重新加载）', () => {
  /*
   * 用户建议：
   *
   * > 建议检测一下用户当前点击的是不是聊天中的角色，不是就直接加载点击的
   * > 角色并跳转，如果是就直接跳转
   *
   * 同一个角色重读卡 + 60 秒重试毫无意义 —— 内存里的快照就是最新的。
   */
  const at = shellSrc.indexOf('onPick: (character: CharacterSummary) => {');
  const body = shellSrc.slice(at, at + 3000);

  assert.match(body, /const sameAsCurrent/, '要判断是否当前角色');
  assert.match(body, /if \(sameAsCurrent\) \{/, '要有"直接跳"分支');
  /*
   * 判定必须在**覆盖** `selectedCharacter` 之前 —— 否则永远相等。
   */
  const sameAt = body.indexOf('const sameAsCurrent');
  const assignAt = body.indexOf('this.selectedCharacter = ');
  assert.ok(sameAt < assignAt, 'sameAsCurrent 必须在覆盖 selectedCharacter 之前算');
});

test('★★★★ 读历史失败也要跳转（try/catch 兜住）', () => {
  /*
   * 原来那个 `void (async () => {...})()` **没有 catch** ——
   * 一旦抛错就是 unhandled rejection，而 `renderPage()` 在里面，
   * 于是页面永远停着。
   *
   * 现在渲染在前，但异步块仍要有 catch：`persistSession` 之类
   * 后续动作失败不该变成未处理异常。
   */
  const at = shellSrc.indexOf('onPick: (character: CharacterSummary) => {');
  const body = shellSrc.slice(at, at + 3000);

  const asyncAt = body.indexOf('void (async () => {');
  assert.ok(asyncAt > 0, '要有异步补内容');
  const tail = body.slice(asyncAt, asyncAt + 1400);
  assert.match(tail, /\} catch \{/, '异步块必须有 catch');
});

/* ═══════════════════════════════════════════════════════════
   ③ 开屏要等聊天记录恢复完
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ splash 必须在 shell.mount 之后才 dismiss', () => {
  /*
   * 真机：开屏淡出后闪一下"还没有对话"，然后消息才冒出来。
   *
   * 真因是顺序：
   *
   * ```text
   *   splash.dismiss()      ← 原来在这里
   *   ...
   *   shell.mount(asHost)   ← 230 行之后
   * ```
   *
   * 用户看到的"空界面"其实是 mount 之后、读历史之前那一帧。
   */
  const dismissAt = mainSrc.indexOf('splash.dismiss()');
  const mountAt = mainSrc.indexOf('shell.mount(asHost)');
  assert.ok(dismissAt > 0, '找不到 splash.dismiss()');
  assert.ok(mountAt > 0, '找不到 shell.mount()');
  assert.ok(
    mountAt < dismissAt,
    `splash.dismiss 必须在 shell.mount 之后（实际 ${String(dismissAt)} vs ${String(mountAt)}）`,
  );
});

test('★★★★ 等会话恢复要有**上限**（否则引擎起不来会卡在开屏）', () => {
  /*
   * `restoreLatestChat` 会重试到 60 秒。如果 splash 无脑等它，
   * 引擎起不来的用户要盯着开屏一分钟 —— 比闪一下糟得多。
   *
   * 判据：必须能表达"等，但最多 N 秒"（`Promise.race` + `setTimeout`）。
   */
  /*
   * ★★★ 必须是**无条件**的 `await Promise.race(...)`。
   *
   * 第一版判据只查 `/Promise\.race\(/` —— 变异验证时把它改成
   * `if (false) await Promise.race([...])` 照样绿（什么都没等）。
   * 那种"代码还在、但永远不会执行"的变异正是最该拦住的一类。
   *
   * 所以钉两点：
   *   · 行首是 `await`（不被任何 if/try 包住）
   *   · `splash.dismiss()` 在它之后
   */
  assert.match(mainSrc, /^  await Promise\.race\(/m, '要有无条件的 await Promise.race');
  assert.match(mainSrc, /sessionSettled/, '要等会话恢复信号');
  assert.match(mainSrc, /setTimeout\(resolve, \d+\)/, '要有超时上限');

  const raceAt = mainSrc.search(/^  await Promise\.race\(/m);
  const dismissAt = mainSrc.indexOf('splash.dismiss()');
  assert.ok(
    raceAt > 0 && dismissAt > raceAt,
    '要先等会话恢复，再 dismiss 开屏',
  );
});

test('★★★ 会话信号要用 finally 放行（失败也必须淡出）', () => {
  /*
   * 若只在成功路径调 `onSessionSettled`，引擎起不来时开屏会等满上限
   * （虽然最终也能出去，但白等 3 秒）。用 `finally` 更准确。
   */
  const at = shellSrc.indexOf('await this.loadCharacterCard(avatar);');
  assert.ok(at > 0, '找不到冷启动恢复块');
  const body = shellSrc.slice(at, at + 700);
  assert.match(body, /finally \{/, '要用 finally 放行');
  assert.match(body, /onSessionSettled/, '要在 finally 里调回调');
});

test('★★★ 没有上次角色时要立刻放行（别白等 3 秒）', () => {
  const at = shellSrc.indexOf('if (this.selectedCharacter !== null) {', shellSrc.indexOf('private mount('));
  assert.ok(at > 0, '找不到冷启动分支');
  const body = shellSrc.slice(at, at + 1400);
  assert.match(body, /\} else \{[\s\S]{0,200}onSessionSettled/, 'else 分支也要放行');
});

/* ═══════════════════════════════════════════════════════════
   ④ 内嵌世界书要落地
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ character_book 要转成 ST world info 格式', async () => {
  /*
   * 用户：
   *
   * > 从仓库导入的角色明明是包含角色世界书的，但是世界书编辑里面却没有。
   *
   * 真因：写 PNG 到 characters/ 绕过了 ST 的导入流程，而 ST 的世界书
   * 扫的是 worlds/ 目录。
   *
   * 这条**真跑**转换函数，验三件最容易错的事：
   *   `keys → key`、`secondary_keys → keysecondary`、`enabled → disable`（取反）
   */
  const { convertEmbeddedWorldbook } = await import('../shared/dist/repo/embedded-worldbook.js');

  const card = {
    spec: 'chara_card_v3',
    data: {
      name: '西奥',
      character_book: {
        name: '西奥的世界',
        entries: [
          {
            keys: ['学院', '魔法'],
            secondary_keys: ['夜间'],
            content: '学院在城北。',
            enabled: true,
            constant: true,
            insertion_order: 7,
            position: 'after_char',
            comment: '学院位置',
          },
          {
            keys: ['禁地'],
            content: '禁地不许进入。',
            enabled: false,
          },
          /* 空条目：既没内容也没关键词 ⇒ 丢掉 */
          { keys: [], content: '' },
        ],
      },
    },
  };

  const plan = convertEmbeddedWorldbook(card, { cardName: '西奥' });
  assert.ok(plan !== null, '应该转出结果');
  assert.equal(plan.name, '西奥的世界', '书名取 character_book.name');
  assert.equal(Object.keys(plan.entries).length, 2, '空条目要丢掉');

  const first = plan.entries['0'];
  assert.deepEqual(first.key, ['学院', '魔法'], 'keys → key');
  assert.deepEqual(first.keysecondary, ['夜间'], 'secondary_keys → keysecondary');
  assert.equal(first.constant, true, 'constant 要保留');
  assert.equal(first.order, 7, 'insertion_order → order');
  assert.equal(first.position, 1, 'after_char → 1');
  assert.equal(first.disable, false, 'enabled=true ⇒ disable=false');
  assert.equal(first.comment, '学院位置', 'comment 要保留');

  const second = plan.entries['1'];
  assert.equal(second.disable, true, '★ enabled=false ⇒ disable=true（取反）');
});

test('★★★★ 世界书名要写进卡的 extensions.world', async () => {
  /*
   * 只写世界书文件不够：ST 靠 `extensions.world` 决定这个角色挂哪本书。
   * 不写 ⇒ 世界书在列表里但**不生效**，用户会以为"世界书没导入"。
   */
  const { attachWorldToCard } = await import('../shared/dist/repo/embedded-worldbook.js');

  const card = { spec: 'chara_card_v2', data: { name: '西奥', extensions: { talkativeness: '0.5' } } };
  const next = attachWorldToCard(card, '西奥的世界');

  /* .mjs 里没有类型断言，直接按已知形状取 */
  assert.equal(next.data.extensions['world'], '西奥的世界', 'data.extensions.world 要写上');
  assert.equal(
    next.data.extensions['talkativeness'],
    '0.5',
    '原有扩展字段不许丢（只加 world，不覆盖整个 extensions）',
  );
  assert.equal(next.extensions['world'], '西奥的世界', '顶层也要写（v1 卡只有顶层）');
});

test('★★★★ 世界书要在**写卡之前**落地（书名要先定下来）', () => {
  /*
   * 顺序：先定书名 + 写世界书 ⇒ 再把 `extensions.world` 写进卡 ⇒ 最后写 PNG。
   *
   * 反过来（先写卡）中途失败会留下"卡指向一本不存在的书"，
   * 表现为"世界书是空的" —— 比没有更难查。
   */
  const at = shellSrc.indexOf('private async importRepoVersion');
  assert.ok(at > 0, '找不到 importRepoVersion');
  const body = shellSrc.slice(at, at + 3200);

  const worldAt = body.indexOf('this.persistEmbeddedWorldbook');
  const attachAt = body.indexOf('attachWorldToCard');
  const writeAt = body.indexOf('writeCharacterPng');
  assert.ok(worldAt > 0, '要落地世界书');
  assert.ok(attachAt > 0, '要把书名写进卡');
  assert.ok(writeAt > 0, '要写卡');
  assert.ok(worldAt < attachAt, '先落地世界书，再改卡 JSON');
  assert.ok(attachAt < writeAt, '改完 JSON 才写 PNG');
});

test('★★★ 世界书落地失败不许阻断导入', () => {
  /*
   * 卡本身已经能用了，世界书是加分项。阻断会让用户连卡都拿不到 ——
   * 那比"世界书没进来"糟得多。
   */
  const at = shellSrc.indexOf('private async persistEmbeddedWorldbook');
  assert.ok(at > 0, '找不到 persistEmbeddedWorldbook');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(body, /catch \{[\s\S]{0,200}return null;/, '失败要返回 null 而不是抛');

  /* 调用方也不许因为 null 而中断 */
  const callAt = shellSrc.indexOf('const worldName = await this.persistEmbeddedWorldbook');
  assert.ok(callAt > 0, '找不到调用');
  const callBody = shellSrc.slice(callAt, callAt + 400);
  assert.match(
    callBody,
    /worldName === null \? jsonText/,
    'null 时要原样用原 JSON（继续导入）',
  );
});

test('★★★★ 世界书重名不许覆盖别人的书', () => {
  /*
   * ST 的 import 是**同名覆盖**。若列表里已有同名但来自别的角色，
   * 覆盖会让用户丢掉一整套设定，还没有任何提示。
   *
   * 所以：先查列表，重名就加序号。
   */
  const at = shellSrc.indexOf('private async persistEmbeddedWorldbook');
  const body = shellSrc.slice(at, at + 2600);

  assert.match(body, /listWorldbookNames/, '要先查已有世界书');
  assert.match(body, /existing\.includes\(name\)/, '要判重名');
  /*
   * 重名时生成 `X (2)` 这样的候选名。
   *
   * ★ 判据钉"用了序号"，不钉具体写法：源码里那一行是
   *   `` `${plan.name} (${String(index)})` ``，直接抄进正则会因为
   *   `$` `{` `}` 的转义次数算错而失败（第一版就是这么红的）。
   */
  assert.match(body, /String\(index\)/, '重名要加序号');
});

test('★★★★★ 读不到世界书列表时不许当成"空表"（否则覆盖别人的书）', () => {
  /*
   * 2026-11-06 自查发现：`listWorldbookNames()` 原来 catch 里返回 `[]`，
   * 与"确实一本都没有"无法区分。列表读失败 ⇒ 判重名失效 ⇒ ST 的同名覆盖
   * 直接抹掉用户已有的设定，且不可逆。
   *
   * 判据（两条，缺一不可）：
   *   ① 函数本身三态：失败回 `null`，不许回 `[]`
   *   ② 调用方见到 `null` 就停手，不许继续 import
   */
  const at = shellSrc.indexOf('private async listWorldbookNames');
  assert.ok(at > 0, '找不到 listWorldbookNames');
  const decl = shellSrc.slice(at, at + 200);
  assert.match(decl, /Promise<string\[\] \| null>/, '签名要三态');
  const body = shellSrc.slice(at, at + 1600);
  const catchAt = body.indexOf('} catch {');
  assert.ok(catchAt > 0, '找不到 catch 分支');
  assert.match(body.slice(catchAt, catchAt + 120), /return null;/, 'catch 要返回 null 而不是空数组');

  const callerAt = shellSrc.indexOf('private async persistEmbeddedWorldbook');
  assert.ok(callerAt > 0);
  const caller = shellSrc.slice(callerAt, callerAt + 3000);
  assert.match(
    caller,
    /if \(existing === null\) return null;/,
    '调用方必须先判 null 再 import',
  );
});

test('★★★ 世界书落地失败不许阻断导入（null 回退也不许弹错）', () => {
  const at = shellSrc.indexOf('private async persistEmbeddedWorldbook');
  const body = shellSrc.slice(at, at + 3000);
  /* 跳过世界书是静默的：那里不许出现通知调用 */
  assert.ok(!/notify\(/.test(body), '世界书失败不许弹通知（用户会以为角色没导进去）');
});
