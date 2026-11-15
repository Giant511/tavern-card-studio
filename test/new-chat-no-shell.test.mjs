/**
 * 「开始新聊天」不许自己造空壳文件（2026-11-14，真机日志驱动）。
 *
 * ## 起因
 *
 * 用户给了一份 vivo 的 `engine-8000.log`，里面只有 7 条异常，其中一条是：
 *
 * ```text
 *   File not found: …/威廉/新聊天 - 2026-11-14@19h57m46s.jsonl.
 *     The chat does not exist or is empty.
 *   Deleted file: …/威廉/新聊天 - 2026-11-14@19h57m46s.jsonl
 * ```
 *
 * 名字里的时间戳（`19h57m46s`）与报错的秒**完全相同** —— 同一秒内
 * 生成名字、写文件、再读它。这不可能是用户操作出来的节奏。
 *
 * 查下去是 `onNewChat`：
 *
 * ```ts
 *   const outcome = await saveAs('新聊天', []);   // ← 立刻写一个空 jsonl
 *   if (fileName !== null) await this.openChatFile(avatar, fileName);  // ← 再读它
 * ```
 *
 * ST 的 `/api/chats/get` 把"空"和"不存在"报成同一句话，于是刷一条
 * W 级 `File not found`。用户看日志会以为记录丢了，实际是我们刚造的空文件。
 *
 * ## 两个独立缺陷
 *
 * ```text
 *   ① 造垃圾：每点一次「开始新聊天」多一个 chat_items: 0 的空壳
 *      —— 与用户视频里那 8 个「2027 条」是同一类东西
 *   ② 状态打架：openChatFile 无条件设 chatFileName，
 *      而 loadChat 失败时面板内部已把 fileName 置 null
 *      ⇒ 面板说"没文件"、外壳说"文件叫 X"
 * ```
 *
 * ## 判据要钉什么
 *
 * 只钉"不造空文件"不够 —— 那只堵了一半。还要钉：
 * **读失败时外壳的指针必须跟着清**，否则下一句消息会写进一个
 * 界面声称已打开、实际不存在的文件里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 去注释（否证断言会被注释里贴的旧代码绊倒，本项目已犯过四次） */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 截出一个方法的函数体（用下一个同级 private/`},` 收边） */
function methodBody(src, marker) {
  const at = src.indexOf(marker);
  assert.ok(at > 0, `找不到 ${marker}`);
  const end = src.indexOf('\n      },', at);
  return src.slice(at, end < 0 ? at + 3000 : end);
}

/* ═══════════════════════════════════════════════════════════
   ① 「开始新聊天」不许写文件
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 「开始新聊天」不许调 saveAs / 不许写空文件', () => {
  const src = stripComments(read('client/src/chat/shell.ts'));
  const body = methodBody(src, 'onNewChat: async () => {');

  /*
   * 两条都要钉，因为它们是同一件事的两种写法：
   * 直接 `saveAs(...)` 或直接 `bridge.saveChat(...)`。
   */
  assert.doesNotMatch(body, /saveAs\(/, '不许用 saveAs 立刻建档（那会留一个空壳）');
  assert.doesNotMatch(body, /saveChat\(/, '不许直接写盘');
  assert.doesNotMatch(body, /\[\s*\]\s*\)/, '不许传空数组去保存');
});

test('★★★★★ 「开始新聊天」要清指针 + 让面板注入开场白', () => {
  const src = stripComments(read('client/src/chat/shell.ts'));
  const body = methodBody(src, 'onNewChat: async () => {');

  /* 指针三件套都要清，否则会写进上一段 */
  assert.match(body, /this\.chatFileName = null/, '要清文件名');
  assert.match(body, /this\.chatSnapshot = null/, '要清快照');
  assert.match(body, /this\.lastSavedFingerprint = null/, '要清指纹');

  /* 面板要真的被清空 + 注入开场白（不是只改外壳状态） */
  assert.match(body, /this\.chatPanel\?\.newChat\(/, '要让面板真的清空并注入开场白');

  /*
   * ★ 顺序：先清指针，再调 newChat。
   *
   * `newChat()` 会回调 `onChatChanged` → 保存逻辑。若那一刻
   * `chatFileName` 还是旧值，开场白会写进**上一段**（把旧聊天覆盖成开场白），
   * 而 save 是全量覆盖 ⇒ 不可逆。
   */
  const clearAt = body.indexOf('this.chatFileName = null');
  const newChatAt = body.indexOf('this.chatPanel?.newChat(');
  assert.ok(clearAt > 0 && newChatAt > 0, '两件事都要有');
  assert.ok(clearAt < newChatAt, '必须先清指针再清面板（否则开场白会覆盖上一段）');
});

/* ═══════════════════════════════════════════════════════════
   ② loadChat 必须能报告成败
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ loadChat 要返回布尔（成功/读不到）', () => {
  const src = stripComments(read('client/src/chat/chat-panel.ts'));
  const at = src.indexOf('async loadChat(');
  assert.ok(at > 0, '找不到 loadChat');
  const sig = src.slice(at, src.indexOf('{', at));

  assert.match(sig, /Promise<boolean>/, '要返回 boolean，调用方才分得清成没成');
  assert.doesNotMatch(sig, /Promise<void>/, '不许只返回 void');
});

test('★★★★★ 读失败时 openChatFile 必须把指针清成 null', () => {
  /*
   * 这是缺陷②的核心：面板说"没文件"、外壳说"文件叫 X"。
   * 两个答案并存时，用户看到的是"打开了一段没有内容的对话"。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const body = methodBody(src, 'private async openChatFile(');

  assert.match(body, /const loaded = .*loadChat\(/, '要用返回值判断');
  assert.match(body, /if \(loaded\)/, '要分支处理');

  const ok = body.indexOf('this.chatFileName = fileName');
  const fail = body.indexOf('this.chatFileName = null');
  assert.ok(ok > 0, '成功分支要记文件名');
  assert.ok(fail > 0, '失败分支要清成 null（否则界面在说谎）');

  /*
   * 无条件赋值是这次要根治的写法：它必须在 `if (loaded)` 里面。
   */
  assert.doesNotMatch(
    body,
    /await this\.chatPanel\?\.loadChat\([^)]*\);\s*this\.chatFileName = fileName/s,
    '不许"读完就赋值"，不管成败',
  );
});

test('★★★★ 打开失败要留在文件列表页，别跳走', () => {
  /*
   * 原来不管成没成都 `chatSettingsRoute = null` 跳回聊天页。
   * 于是"哪一条没读出来"这个信息丢了，用户还得重新进列表才知道。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const at = src.indexOf('onOpen: async (id) =>');
  assert.ok(at > 0, '找不到 onOpen');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 1200 : end);

  assert.match(body, /if \(!loaded\) return/, '失败要提前返回');
  const guard = body.indexOf('if (!loaded) return');
  const navigate = body.indexOf('this.chatSettingsRoute = null');
  assert.ok(guard < navigate, '守卫要在跳转之前');
});

/* ═══════════════════════════════════════════════════════════
   ③ saveAs 兜底
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ saveAs 不许接受空内容（它是唯一的"新建文件"入口）', () => {
  /*
   * 新文件名不覆盖任何东西，所以空内容不会丢数据 —— 只会攒垃圾。
   * 而上游每多一个调用点就漏一次，所以判据钉在**最靠近副作用**的地方。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const at = src.indexOf('const saveAs = async (');
  assert.ok(at > 0, '找不到 saveAs');
  const end = src.indexOf('\n    };', at);
  const body = src.slice(at, end < 0 ? at + 2200 : end);

  assert.match(body, /messages\.length === 0/, '要拦空内容');
  const guard = body.indexOf('messages.length === 0');
  const sideEffect = body.indexOf('this.bridge.saveChat(');
  assert.ok(sideEffect > 0, '要有写盘');
  assert.ok(guard < sideEffect, '守卫必须在写盘之前');
});
