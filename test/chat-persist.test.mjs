/**
 * 聊天保存链路（v0.1.7 / 第八批问题二）。
 *
 * ## 用户报的现象
 *
 * > 聊天页发消息、收到回复后，切到其他 Tab 再切回聊天，之前的消息全部消失。
 * > 期望：消息实时落库（ST 的 `/api/chats/save`），切走切回、杀进程重进都在。
 *
 * ## 取证到的两个断点
 *
 * | 现象 | 断点 | 证据 |
 * |---|---|---|
 * | 切 Tab 回来消息没了 | `setChatSnapshot()` 只在 `?sample=1` 时被调用（注入样本），真实聊天路径**从没更新过快照** | `grep -rn setChatSnapshot client/src/` 只有 `main.ts:347` 一处，在 `?sample=1` 分支里 |
 * | 杀进程重进也没了 | `bridge.saveChat()` **全库零调用** | `grep -rn "\.saveChat" client/src/` 无结果（只有 `st-bridge.ts:118` 的定义） |
 *
 * 这两处都是"函数写了没人调"的形状 —— 本项目第四次遇到
 * （前三次：`.nb-chat` 零 CSS、输入框忘 append、`setVoiceTransport` 零调用）。
 *
 * ## 这组测试守什么
 *
 * 1. **文件名生成**：必须合法、可复用、不产出空名
 * 2. **该不该保存**：空历史绝不能存（整份覆盖 = 清空用户历史）
 * 3. **接线**：面板真的通知了、外壳真的接了、保存真的会被调用
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { chatFingerprint, makeChatFileName, shouldSaveChat } from '@tcs/shared';

const ROOT = join(import.meta.dirname, '..');

/**
 * 剥掉注释再搜索。
 *
 * ★ 必须剥：`indexOf('restoreLatestChat')` 会命中**注释里**那句
 *   "不能等读完历史（restoreLatestChat…）"，于是切片切在注释中间，
 *   断言看到的是半段文档而不是代码 —— 判据自己造的假红。
 *   这个坑在 §93/§122 记过两次了。
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}


/* ═══════════════════════════════════════════════════════════
   ① 文件名生成
   ═══════════════════════════════════════════════════════════ */

test('★ 文件名带角色名与时间，观感与 ST 一致', () => {
  const name = makeChatFileName('西奥', new Date(2026, 10, 1, 14, 30, 12));
  assert.equal(name, '西奥 - 2026-11-1@14h30m12s');
});

test('★★ 文件名里不许有非法字符（Windows 上会让保存直接失败）', () => {
  /*
   * `\ / : * ? " < > |` 在 Windows 上全是非法文件名字符。
   * 角色名可能包含它们（用户起的名字不受限），不清洗的话
   * `saveChat` 会失败 —— 而且 ST 那边报的错和"文件系统"有关，
   * 看起来完全不像"角色名的问题"。
   */
  const name = makeChatFileName('a/b\\c:d*e?f"g<h>i|j', new Date(2026, 0, 5, 9, 8, 7));
  for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
    assert.equal(name.includes(bad), false, `文件名里不该有 ${bad}`);
  }
  assert.match(name, /^a_b_c_d_e_f_g_h_i_j - 2026-1-5@9h08m07s$/);
});

test('★ 角色名为空时退回 chat，绝不产出空名字', () => {
  /*
   * 空名字的后果很隐蔽：ST 会拿默认名存下去，而**我们不知道文件叫什么** ——
   * 于是下次保存又生成一个新名字，一次对话留一堆文件。
   */
  const name = makeChatFileName('   ', new Date(2026, 10, 1, 0, 0, 0));
  assert.match(name, /^chat - /);
  assert.equal(name.trim() === '', false);
});

test('★ 时间是补零的：分钟/秒，但月/日不补（与 ST 观感一致）', () => {
  const name = makeChatFileName('甲', new Date(2026, 0, 5, 3, 4, 5));
  assert.match(name, /2026-1-5@3h04m05s$/);
});

test('★ 同一天不同秒 → 不同名字（不会互相覆盖）', () => {
  const a = makeChatFileName('甲', new Date(2026, 10, 1, 14, 30, 12));
  const b = makeChatFileName('甲', new Date(2026, 10, 1, 14, 30, 13));
  assert.notEqual(a, b);
});

/* ═══════════════════════════════════════════════════════════
   ② 该不该保存（安全类判断）
   ═══════════════════════════════════════════════════════════ */

test('★★★ 空历史**绝不能**存（整份覆盖 = 清空用户历史，且不报错）', () => {
  /*
   * `/api/chats/save` 是**整份覆盖**语义。用 `[]` 覆盖一个已有文件，
   * 等于把用户几十轮的历史清空，而服务端返回 `{ok:true}`（没有错）。
   *
   * 这是本项目反复强调的"陷阱 #1"，也是这条判据存在的唯一理由。
   */
  assert.equal(
    shouldSaveChat({ messages: [], avatar: 'xiao.png', lastSavedFingerprint: null }),
    false,
  );
  // 即使指纹不同（比如上次存了 5 条）也不许用空数组覆盖
  assert.equal(
    shouldSaveChat({ messages: [], avatar: 'xiao.png', lastSavedFingerprint: '5:100' }),
    false,
  );
});

test('★ 没选角色不存（不知道往哪个目录写）', () => {
  assert.equal(
    shouldSaveChat({ messages: [{ mes: 'hi' }], avatar: null, lastSavedFingerprint: null }),
    false,
  );
  assert.equal(
    shouldSaveChat({ messages: [{ mes: 'hi' }], avatar: '  ', lastSavedFingerprint: null }),
    false,
  );
});

test('★ 正常情况：有新消息就存', () => {
  assert.equal(
    shouldSaveChat({ messages: [{ mes: 'hi' }], avatar: 'a.png', lastSavedFingerprint: null }),
    true,
  );
});

test('★ 指纹与上次相同 → 跳过（不重复写盘）', () => {
  const messages = [{ mes: '你好' }];
  const print = chatFingerprint(messages);
  assert.equal(
    shouldSaveChat({ messages, avatar: 'a.png', lastSavedFingerprint: print }),
    false,
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ 指纹能抓住哪些变化
   ═══════════════════════════════════════════════════════════ */

test('★ 条数变了 → 指纹变', () => {
  assert.notEqual(chatFingerprint([{ mes: 'a' }]), chatFingerprint([{ mes: 'a' }, { mes: 'b' }]));
});

test('★★ assistant 回复完成（条数不变、末条从占位变正文）→ 指纹必须变', () => {
  /*
   * 这是最容易漏的一种：流式开始时先插一条空占位（`mes: ''`），
   * 完成后把正文写进去。**条数一直没变**，只看条数就会漏存 ——
   * 结果用户切 Tab 回来，assistant 那条回复没了。
   */
  const streaming = [{ mes: '你好' }, { mes: '' }];
  const done = [{ mes: '你好' }, { mes: '你好，我是西奥。' }];
  assert.equal(streaming.length, done.length, '前提：条数确实相同');
  assert.notEqual(chatFingerprint(streaming), chatFingerprint(done));
});

test('★ 纯重渲染（内容完全没变）→ 指纹相同', () => {
  const a = [{ mes: 'x' }, { mes: 'yy' }];
  const b = [{ mes: 'x' }, { mes: 'yy' }];
  assert.equal(chatFingerprint(a), chatFingerprint(b));
});

test('★ mes 不是字符串时给 -1，不抛错', () => {
  assert.doesNotThrow(() => chatFingerprint([{ mes: 123 }]));
  assert.doesNotThrow(() => chatFingerprint([{}]));
});

/* ═══════════════════════════════════════════════════════════
   ④ 接线：函数对了但没接上，等于没做
   ═══════════════════════════════════════════════════════════ */

test('★★★ 面板必须在两个点通知外壳（否则快照与落库都不会发生）', () => {
  const panel = readFileSync(join(ROOT, 'client/src/chat/chat-panel.ts'), 'utf8');

  assert.match(panel, /onChatChanged\?:/, '要声明这个回调');

  const calls = panel.match(/this\.callbacks\.onChatChanged\?\.\(/g) ?? [];
  assert.ok(
    calls.length >= 3,
    `至少要三处调用（用户消息发出、生成成功、生成失败清理），实际 ${String(calls.length)} 处`,
  );

  /*
   * 用户消息插入后必须紧跟一次通知 —— 这是"发出去了就不丢"的唯一保障。
   * 等回复完再存的话，回复过程中被杀进程那条用户消息就没了。
   */
  assert.match(
    panel,
    /this\.messages = \[\.\.\.this\.messages, message\];[\s\S]{0,400}?onChatChanged\?\./,
    '用户消息插入后要通知',
  );
});

test('★★★ 外壳必须真的接上，并且真的调用 saveChat', () => {
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');

  assert.match(shell, /onChatChanged: \(messages\) => this\.handleChatChanged\(messages\)/, '要接线');

  /*
   * `bridge.saveChat(...)` 之前是**零调用** —— 那是"杀进程重进也没了"的根因。
   * 这条断言直接钉住"真的调了"。
   */
  assert.match(shell, /this\.bridge\.saveChat\(/, '必须真的调用 saveChat');

  /*
   * 快照必须跟着更新 —— 那是"切 Tab 回来还在"的唯一依据。
   * 之前 `setChatSnapshot` 只在 `?sample=1` 时被调用。
   */
  assert.match(
    shell,
    /private handleChatChanged[\s\S]{0,2000}?this\.chatSnapshot = \{/,
    'handleChatChanged 里要更新 chatSnapshot',
  );
});

test('★★★ 保存并发时不许丢掉后一次（要排队，不是丢弃）', () => {
  /*
   * 原来的写法是 `if (this.savingChat) return;`，理由写的是
   * "它要存的内容会被后一次带上"。这个假设只在"后一次一定会来"时成立：
   *
   * ```text
   *   ① 保存 A(47 条) 开始        → savingChat = true
   *   ② 立刻要求保存 B(48 条)     → 被 return 丢掉
   *   ③ A 写盘成功                → B 的内容从未落盘
   * ```
   *
   * 重新生成会连着触发两次保存（失败 / 成功各一次），这条路走得到。
   *
   * ★ 诚实标注：这条是**加固**，不是我复现过的缺陷。
   * 我一度以为"界面 48 / 文件 47"就是它，后来查明 47 是 `wc -l` 的口径错误
   * （这个 jsonl 最后一行没有结尾换行），实际一条都没丢。
   * 留着的理由是：丢弃并发保存的假设本身不成立，而排队的代价很小。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const at = shell.indexOf('private async persistChat');
  assert.ok(at > 0, '找不到 persistChat');
  const fn = shell.slice(at, at + 2600);

  assert.match(
    fn,
    /if \(this\.savingChat\) \{\s*this\.pendingChatSave\s*=/,
    '并发时必须记下最新内容（pendingChatSave），不能 return 丢掉',
  );
  assert.doesNotMatch(
    fn,
    /if \(this\.savingChat\) return;/,
    '不许再用"直接丢弃"的写法 —— 丢的正好是最后那份内容',
  );
  assert.match(fn, /for \(;;\)/, '写完之后要循环检查有没有新内容在等');
  assert.match(fn, /this\.pendingChatSave = null;/, '取走待存内容后要清空，否则会一直重写');
});

test('★ 保存失败不许打断对话（只提示，不抛）', () => {
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(shell.indexOf('private async persistChat'));

  assert.match(fn, /catch \(error\)/, '要有 catch');
  assert.match(fn, /onNotify\?\.\(/, '失败要留痕迹');
  assert.doesNotMatch(fn, /throw error/, '不许把异常抛给调用方（会打断聊天）');
});

test('★ 文件名只在没有时生成一次（复用，不是每次新造）', () => {
  /*
   * 如果每次保存都重新生成名字，一次对话会在 ST 里留下十几个文件 ——
   * 用户打开聊天列表会看到一堆"角色名 - 时间"，每条只有一两句。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  assert.match(
    shell,
    /if \(this\.chatFileName === null && avatar !== null\) \{\s*this\.chatFileName = makeChatFileName\(name\);/,
    '只在 null 时生成',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 重进 App 要读回历史（否则"数据在但看不见"）
   ═══════════════════════════════════════════════════════════ */

test('★★★ `onPickChat` 不许再硬编码返回 null（否则永远读不回历史）', () => {
  /*
   * 真机实测（2026-11-01 16:47）：消息**确实落库了**（logcat 有
   * `[st_chat_save] avatar=… file=… messages=2`，磁盘上读回 2 条内容正确），
   * 但杀掉 App 重进、选同一个角色，界面还是「还没有对话」。
   *
   * 根因：`onPickChat: async () => null` —— 它永远返回 null，
   * 于是 `ChatPanel.openPicker()` 走 `newChat()` 分支，
   * **`loadChat()` 从来没被调用过**。
   *
   * 这比"数据丢了"更让人困惑：数据在磁盘上，用户却看不到。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');

  assert.doesNotMatch(
    shell,
    /onPickChat: async \(\) => null/,
    '不许硬编码返回 null（那等于永不读回历史）',
  );
  assert.match(
    shell,
    /onPickChat: async \(avatar\) =>/,
    '要真的用 avatar 去查聊天列表',
  );
  assert.match(shell, /findLatestChat/, '要有查"最近一份聊天"的实现');

  /*
   * ★★ 这条是本轮最贵的一条：**真正的调用点在 `onPick` 里，不在 `onPickChat`**。
   *
   * 外壳的顺序是 `resolve(null)` → `renderPage()` 重建面板。
   * 所以 `ChatPanel.openPicker()` 里 `await onPickChat(...)` **永远走不到**
   * （拿到 null 就 return）。
   *
   * 我先把读历史的逻辑加在 `onPickChat` 上，装了三轮包、查了两小时运行时，
   * 才发现"改的位置根本没被执行过"。判据必须钉住**真正被执行的那个位置**。
   */
  assert.match(
    shell,
    /this\.selectedCharacter = \{ avatar: character\.avatar[\s\S]{0,2000}?restoreLatestChat\(character\.avatar\)/,
    'onPick 里要调 restoreLatestChat（那才是真被执行的位置）',
  );
  assert.match(shell, /restoreLatestChat/, '要有 restoreLatestChat 实现');
  /*
   * ★ 读内容的那一步在 `tryLoadInto` 里（`restoreLatestChat` 负责重试循环）。
   * 所以断言要钉**两个函数都存在且真的调用**，而不是"某一段距离内有 loadChatRaw"。
   *
   * 2026-11-01 第二轮重构后这里假红过一次：`loadChatRaw` 被移到
   * `tryLoadInto`，字符距离超过了原来的 1200 上限 —— 判据报错，
   * 但代码是对的。**判据依赖"代码布局"，重构就会误报**；
   * 钉"谁调用谁"才稳。
   */
  assert.match(shell, /private async tryLoadInto\(/, '要有 tryLoadInto');
  assert.match(
    shell,
    /private async tryLoadInto[\s\S]{0,1500}?this\.bridge\.loadChatRaw\(/,
    'tryLoadInto 要真的读聊天内容',
  );
  assert.match(
    shell,
    /private async restoreLatestChat[\s\S]{0,2500}?this\.tryLoadInto\(/,
    'restoreLatestChat 要调用 tryLoadInto',
  );
  assert.match(
    shell,
    /this\.bridge\.listChatsRaw\(/,
    '要通过 listChatsRaw 查真实列表',
  );
});

test('★★ 取最近一份历史必须用 `file_id`（无扩展名），不是 `file_name`', () => {
  /*
   * 契约陷阱 #3：`file_id` 无扩展名、`file_name` 带 `.jsonl`。
   * `get` / `save` 要的是无扩展名的那个；用错会 400 或建出怪文件。
   *
   * 而 `file_name` 在返回的 JSON 里**总是存在**（带扩展名），
   * 所以"随手取 file_name"是个很容易犯、且后果延迟的错。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(
    shell.indexOf('private async findLatestChat'),
    shell.indexOf('private handleChatChanged'),
  );

  assert.match(fn, /info\['file_id'\]|\binfo\.file_id\b/, '要取 file_id');
  assert.doesNotMatch(fn, /info\['file_name'\]|\binfo\.file_name\b/, '不许取 file_name（带扩展名）');
});

test('★ 按 last_mes 选最近的一份（不依赖服务端返回顺序）', () => {
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(
    shell.indexOf('private async findLatestChat'),
    shell.indexOf('private handleChatChanged'),
  );
  assert.match(fn, /last_mes/, '要按 last_mes 比较');
  assert.match(fn, /at > best\.at|best\.at < at/, '要真的做"更大者胜"的比较');
});

test('★ 读列表失败时返回 null（不卡界面、不弹错）', () => {
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(
    shell.indexOf('private async findLatestChat'),
    shell.indexOf('private handleChatChanged'),
  );
  assert.match(fn, /catch \{/, '要有 catch');
  assert.match(fn, /return null/, '失败要退回"没有历史"');
  assert.doesNotMatch(fn, /onNotify/, '这里不该弹错（用户马上会在别处看到引擎状态）');
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 切走（WebView 被回收）必须能恢复 —— 会话身份要落盘
   ═══════════════════════════════════════════════════════════ */

test('★★★ 会话身份必须落盘（否则切到别的 App 回来就空了）', () => {
  /*
   * 真机实测（2026-11-01 18:10，`.verify/verify-switch-scenarios.mjs`）：
   *
   * ```
   * A. 内部 Tab 往返        3 → -1 → 3       PASS（chatSnapshot 在内存）
   * B. 页面重载（等价回收）  3 → count=1     FAIL
   * ```
   *
   * 用户说的"切走"是 B：切到别的 App / 按 Home，Android 回收 WebView，
   * 整个 JS 堆重建 —— `selectedCharacter` 与 `chatSnapshot` 双双归零。
   *
   * 只靠内存变量修不了这一类，必须落盘。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const main = readFileSync(join(ROOT, 'client/src/mobile/main.ts'), 'utf8');

  assert.match(shell, /savedSession\?:/, '外壳要能接收上次的会话');
  assert.match(shell, /onPersistSession\?:/, '外壳要能通知落盘');
  assert.match(main, /LS_CHAT_SESSION/, '要有存储 key');

  /*
   * ★★ 这两条必须钉**完整的赋值形态**，不能只匹配函数名。
   *
   * 第一版我写的是 `assert.match(main, /readChatSession\(\)/)` —— 而
   * `function readChatSession()` 这个**定义**本身就匹配。
   * 变异验证（把 `savedSession: readChatSession()` 改成 `savedSession: null`）
   * 因此**全绿通过**，判据等于没写。
   *
   * 这与 §68 记过的「读到注释就以为读到代码」是同一类错：
   * 匹配范围太宽 ⇒ 缺陷从判据旁边溜过去，而且测试不红。
   */
  assert.match(
    main,
    /savedSession: readChatSession\(\),/,
    '要把读到的会话真的传进去（`savedSession: readChatSession()` 完整形态）',
  );
  assert.doesNotMatch(main, /savedSession:[ \t]*null/, '不许把 savedSession 写死成 null');
  assert.match(
    main,
    /onPersistSession: writeChatSession,/,
    '要接上落盘回调（完整形态）',
  );
  assert.doesNotMatch(main, /onPersistSession:[ \t]*undefined/, '不许把落盘回调写死');
});

test('★★ 构造函数要恢复会话身份（同步、不发请求）', () => {
  /*
   * 恢复分两步：构造函数里恢复"我是谁"（同步，无依赖），
   * `mount()` 之后才异步读内容。
   *
   * 合在一起做的后果：构造函数里发请求时 ST 引擎可能还没起，
   * 必然失败，而且失败后没有任何重试机会 —— 用户看到的永远是空聊天。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const ctorStart = shell.indexOf('constructor(options: ShellOptions)');
  /*
   * ★ 边界必须是 `mount(container: ElLike)` 这个**签名**，不能是 `mount(`。
   * 构造函数那段注释里写了 "真正的历史读回在 `mount()` 之后" ——
   * 用 `mount(` 会在这句注释处就截断，后面真正的代码全在切片外，
   * 断言必然假红。判据自己的切片边界也要写对。
   */
  const head = shell.slice(ctorStart, shell.indexOf('mount(container: ElLike)'));

  assert.match(head, /options\.savedSession/, '构造函数要读 savedSession');
  assert.match(head, /this\.selectedCharacter = \{/, '要恢复角色');
  assert.match(head, /this\.chatFileName = saved\.fileName/, '要恢复文件名');
  assert.doesNotMatch(head, /await |\.then\(/, '构造函数里不许发异步请求');
});

test('★★ 恢复内容必须在 mount 之后（此时页面骨架才就位）', () => {
  /*
   * ⚠ 2026-11-06 调整：窗口从 900 放宽到 2200。
   *
   * 冷启动恢复那块为了"开屏等聊天记录"加了一层 try/finally
   * （见 `onSessionSettled`），代码变长了 —— 但**性质没变**：
   * `restoreLatestChat` 仍然在 `switchTab` 之后。
   * 判据钉的是"顺序"，不是"多少字符之内"。
   */
  const shell = stripComments(readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8'));
  const mount = shell.slice(shell.indexOf('mount(container: ElLike)'), shell.indexOf('switchTab(id: TabId)'));
  assert.match(
    mount,
    /this\.switchTab\(this\.active\);[\s\S]{0,2200}?restoreLatestChat\(/,
    'mount 里 switchTab 之后要读回历史',
  );
  /*
   * ★ 不 await 的第一层：读历史要一次 ST 往返，阻塞会让首屏迟迟不出现。
   *
   * 2026-11-05 改写成 IIFE 之后（读卡要先于读历史），`void` 从
   * `void this.restoreLatestChat(` 移到了 `void (async () => {` 上。
   * 判据原来钉的是**实现形式**，于是把正确的改法判成了失败。
   *
   * 现在验性质：恢复那一整块必须是 fire-and-forget。
   */
  assert.match(
    mount,
    /void\s*(\(\s*async\s*\(\)\s*=>|this\.restoreLatestChat)/,
    '恢复流程必须 fire-and-forget（`void (...)`），不能在 mount 里 await',
  );
});

test('★★★ 恢复时优先用记下来的文件，不是"重新找最新的"', () => {
  /*
   * 差别在用户行为上：他在聊天 A 里聊到一半切走了，回来应该回到 A，
   * 而不是跳到 A 之后新建的 B。只有没有记录（首次选角色）时才找最新的。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(
    shell.indexOf('private async restoreLatestChat'),
    shell.indexOf('private persistSession'),
  );
  assert.match(fn, /preferred\?: string \| null/, '要接受"指定文件"参数');
  assert.match(fn, /preferred \?\?/, '优先用指定的那个');
});

test('★ 换角色时要清掉旧的会话残留（文件名/快照/指纹）', () => {
  /*
   * 不清的后果：换了角色但 `chatFileName` 还是上一个角色的，
   * 下一条消息会**写进别的角色的目录** —— 数据没丢，但找不到了。
   */
  /*
   * ★ 剥注释：`onPick` 里我写了一段解释"为什么 renderPage 不能排在
   *   restoreLatestChat 之后"的注释，那里面就含函数名。
   *   不剥的话 `indexOf` 命中注释，`head` 只到注释中间，断言必然红。
   */
  const shell = stripComments(readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8'));
  const onPick = shell.slice(shell.indexOf('onPick: (character: CharacterSummary)'));
  const head = onPick.slice(0, onPick.indexOf('restoreLatestChat'));

  assert.match(head, /this\.chatFileName = null;/, '要清文件名');
  assert.match(head, /this\.chatSnapshot = null;/, '要清快照');
  assert.match(head, /this\.lastSavedFingerprint = null;/, '要清指纹');
});

/* ═══════════════════════════════════════════════════════════
   ⑦ 落盘竞态：fileName 必须在读到之后才存
   ═══════════════════════════════════════════════════════════ */

test('★★★ `restoreLatestChat` 设好 fileName 后必须再落一次盘', () => {
  /*
   * 实测（2026-11-01，MuMu）：localStorage 里存成了
   *   `{"avatar":"测试用-夜航小助手.png","name":"…","fileName":null}`
   *
   * 根因是 `onPick` 的顺序：
   *   `void restoreLatestChat(...)`（异步，还没跑完）
   *   → `persistSession()`（此刻 chatFileName 仍是 null）
   *
   * 于是页面重载后：avatar 恢复了（标题能显示角色名）、fileName 是 null
   * ⇒ `mount()` 的条件不成立 ⇒ 不读历史 ⇒ 界面空白。
   * **正是用户看到的"切走再回来没有历史"。**
   *
   * 修法：`restoreLatestChat` 在 `this.chatFileName = latest` 之后
   * 自己再 `persistSession()` 一次。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const fn = shell.slice(
    shell.indexOf('private async restoreLatestChat'),
    shell.indexOf('private persistSession'),
  );

  assert.match(
    fn,
    /this\.chatFileName = latest;[\s\S]{0,1600}?this\.persistSession\(\);/,
    '设好文件名之后要落盘（否则存进去的是 null）',
  );
});

test('★★★ 重载后恢复不能要求 `chatFileName` 非空', () => {
  /*
   * 老版本存下的会话、或上面那个竞态，`fileName` 会是 null 但角色是确定的。
   * 那种情况应该"按这个角色找最近一份"，而不是当作"什么都没选"跳过。
   */
  const shell = readFileSync(join(ROOT, 'client/src/chat/shell.ts'), 'utf8');
  const mount = shell.slice(
    shell.indexOf('mount(container: ElLike)'),
    shell.indexOf('switchTab(id: TabId)'),
  );

  assert.match(mount, /if \(this\.selectedCharacter !== null\) \{/, '只按角色判断');
  assert.doesNotMatch(
    mount,
    /selectedCharacter !== null && this\.chatFileName !== null/,
    '不许再要求 chatFileName 非空（那会让 fileName=null 的存量会话永远读不回）',
  );
});
