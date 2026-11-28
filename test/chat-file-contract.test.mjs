/**
 * 聊天文件三个写端点的**扩展名契约**（2026-11-15，用户报「改不了名字」）。
 *
 * ## 三个端点三种行为 —— 这是本项目最容易踩的一组
 *
 * ```text
 *   /api/chats/save     const chatFileName = `${file_name}.jsonl`        无条件拼
 *                       ⇒ 必须传【不带】
 *   /api/chats/delete   if (!path.extname(chatfile)) chatfile += '.jsonl'  缺了才补
 *                       ⇒ 传【带不带都行】
 *   /api/chats/rename   sanitize(body.original_file)                     不补
 *                       ⇒ 必须传【带】
 * ```
 *
 * 依据（ST 1.19 源码）：
 *
 * ```js
 *   // save  :545 / :547
 *   const chatFileName = `${String(request.body.file_name)}.jsonl`;
 *
 *   // rename :621 / :633-:640
 *   const pathToOriginalFile = path.join(pathToFolder, sanitize(request.body.original_file));
 *   const pathToRenamedFile  = path.join(pathToFolder, sanitize(request.body.renamed_file));
 *   if (!fs.existsSync(pathToOriginalFile) || fs.existsSync(pathToRenamedFile)) {
 *       return response.status(400).send({ error: true });
 *   }
 *
 *   // delete :656-:658
 *   if (!path.extname(request.body.chatfile)) { request.body.chatfile += '.jsonl'; }
 * ```
 *
 * ## 这次是怎么炸的
 *
 * 我按 `/delete` 的直觉写 `/rename`，`original_file` 传了**不带扩展名**的
 * `file_id` ⇒ `existsSync('…/威廉/威廉 - 2026-11-14@19h57m46s')` 恒 false
 * ⇒ **每一次改名都 400**。用户看到「改名失败」。
 *
 * ## 为什么判据之前没拦住
 *
 * `docs/adapter-contract-st-v1.19.md` 第 131 行**写着**「带 `.jsonl`」，
 * 陷阱 #3 也写着「rename/delete 用带」。**契约是对的，代码没遵守，
 * 而且没有任何可执行的判据**。
 *
 * ⇒ 这三条判据的作用就是把"文档里的一句话"变成"编译期之外能自动跑的东西"。
 * 光写文档不写判据 = 下一个人还会犯（这次就是我自己）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readShellImpl, readShellImplNoComments } from './lib/shell-source.mjs';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 去注释：注释里会贴 ST 源码片段，否证断言会被它绊倒 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RUST = 'client/src-tauri/src/st_chat.rs';

/** 截出一个 Rust 命令的函数体 */
function rustBody(src, fnName) {
  const at = src.indexOf(`pub async fn ${fnName}(`);
  assert.ok(at > 0, `找不到 ${fnName}`);
  const end = src.indexOf('\n#[tauri::command]', at);
  return src.slice(at, end < 0 ? at + 2000 : end);
}

/* ═══════════════════════════════════════════════════════════
   一、rename 必须带扩展名
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ rename 的两个文件名都必须带 .jsonl', () => {
  const body = rustBody(stripComments(read(RUST)), 'st_chat_rename');

  /*
   * 钉的是"两个字段都走了同一个补扩展名的函数"，而不是钉具体写法。
   * 只要 `original_file` / `renamed_file` 里出现裸变量，就是这次那个 bug。
   */
  assert.match(
    body,
    /"original_file":\s*with_ext\(/,
    'original_file 必须补扩展名（否则 existsSync 查的是无扩展名路径 ⇒ 恒 400）',
  );
  assert.match(body, /"renamed_file":\s*with_ext\(/, 'renamed_file 也必须补扩展名');

  /* 否定断言：不许直接塞裸的 file_id / new_name */
  assert.doesNotMatch(body, /"original_file":\s*file_id\s*,/, '不许直接传 file_id');
  assert.doesNotMatch(body, /"renamed_file":\s*new_name\s*,/, '不许直接传 new_name');
});

test('★★★★★ 补扩展名要幂等（已经带了不许变成 .jsonl.jsonl）', () => {
  const body = rustBody(stripComments(read(RUST)), 'st_chat_rename');
  assert.match(body, /ends_with\("\.jsonl"\)/i, '要先判是否已带扩展名');
  /*
   * 大小写：用户可能输入 `X.JSONL`。用 `to_ascii_lowercase()` 归一，
   * 否则会拼成 `X.JSONL.jsonl`。
   */
  assert.match(body, /to_ascii_lowercase\(\)/, '比较要忽略大小写');
});

/* ═══════════════════════════════════════════════════════════
   二、save 不许带扩展名
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ save 不许给 file_name 拼扩展名（ST 自己会拼）', () => {
  /*
   * ST：`const chatFileName = `${file_name}.jsonl`` —— 无条件拼。
   * 我们这边再补一次就变成 `xxx.jsonl.jsonl`，用户会在文件列表里
   * 看到一个名字带两个扩展名的怪文件。
   */
  const body = rustBody(stripComments(read(RUST)), 'st_chat_save');
  assert.doesNotMatch(
    body,
    /file_name.*\.jsonl|with_ext\(&?file_name\)/,
    'save 的 file_name 不许自己补 .jsonl',
  );
});

/* ═══════════════════════════════════════════════════════════
   三、前端要用 ST 回传的权威名
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 改名后要记 ST 返回的 sanitizedFileName，不是用户输入的原文', () => {
  /*
   * ST 那侧过了一遍 `sanitize()`（`sanitize-filename` 包）：非法字符删掉、
   * 结尾点和空格去掉、超长截断，然后回 `sanitizedFileName`（**不带扩展名**）。
   *
   * 记成用户原文的话：
   *
   * ```text
   *   输入 a/b:c  → 实际 abc.jsonl
   *   记 a/b:c   → 下次按它读 ⇒ 404 ⇒ 又"记录没了"
   * ```
   *
   * 用户上一次报的「记录没了」，其中一个成因就是这个形状的错配。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('onRename: async (id, newName) =>');
  assert.ok(at > 0, '找不到 onRename');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /sanitizedFileName/, '要读 ST 回传的权威名');
  assert.match(body, /const finalName = /, '要有一个"最终名字"变量');
  /* ★ 不绑定 `this.` 前缀（2026-11-24 搬家后是 `host.`）—— 判据钉的是"指针被赋成 finalName" */
  assert.match(body, /\.chatFileName = finalName/, '指针记最终名');

  /* 否定：不许把用户原文直接写进指针 */
  assert.doesNotMatch(body, /\.chatFileName = trimmed/, '不许记用户原文');

  /*
   * ★★★ 还要钉"finalName 真的是从 sanitized 来的"（2026-11-15，变异验证抓到）。
   *
   * 第一版只断言"有 finalName"和"提到了 sanitizedFileName"。
   * 把赋值改成 `const finalName = trimmed;` 之后**判据照样绿** ——
   * 因为 `sanitizedFileName` 那几个字还在（只是读了没用），
   * `finalName` 也还在（只是来源错了）。
   *
   * 这正是本项目反复出现的「读到了但没用它」形状（同 §125 的"捞而不用"）。
   * ⇒ 断言要落在**赋值语句本身**。
   */
  const assign = body.split('\n').find((line) => line.includes('const finalName'));
  assert.ok(assign !== undefined, '找不到 finalName 的赋值');
  assert.match(assign, /sanitized/, 'finalName 必须由 sanitized 参与决定，不许直接用用户输入');
});

test('★★★★★ 改名还要同步面板与快照（否则下次保存写回旧名）', () => {
  const src = readShellImplNoComments();
  const at = src.indexOf('onRename: async (id, newName) =>');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /chatSnapshot = \{ \.\.\.[\w.]*chatSnapshot, fileName: finalName \}/, '要改快照的 fileName');

  /*
   * 面板同步的方式在 2026-11-15 从 `setMessages` 换成了 `openChatFile`。
   *
   * 前者只是"把手上的名字改掉"，证明不了新名字在磁盘上读得到 ——
   * 而这次故障恰恰是"改名成功但读不到"。后者会真的走一次
   * `loadChat`（设面板 fileName + 渲染 + 验证可读），强度更高。
   */
  assert.match(
    body,
    /openChatFile\(avatar, finalName\)/,
    '要用"真的读一次"来同步面板，而不是只改手里的变量',
  );
});

/* ═══════════════════════════════════════════════════════════
   四、空名字与重名：要给能行动的话
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 空名字要拦在本地（ST 会把它变成 .jsonl 隐藏文件）', () => {
  /*
   * `path.parse('.jsonl').name` 是 `.jsonl` 本身（点开头的隐藏文件）。
   * 用户此后既在列表里看不见它，也没法删 —— 只能靠文件管理器。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('onRename: async (id, newName) =>');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /trimmed === ''/, '要拦空名字');
  assert.match(body, /名字不能是空的/, '要说清原因');
});

test('★★★★★ 重名要提前判，别让用户对着 "HTTP 400" 猜', () => {
  /*
   * ST 的 400 同时表示两件事：
   *
   * ```js
   *   if (!existsSync(original) || existsSync(renamed)) return 400;
   * ```
   *
   * 源文件不存在、目标已存在 —— 同一个状态码，同一个 `{error:true}`。
   * 用户看到「返回 HTTP 400」时唯一能做的就是瞎试。
   *
   * 列表就在手上，所以本地先判一次重名；判重必须排除自己
   * （把「A」改成「A」不该报错 —— 用户可能只改了首尾空格）。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('onRename: async (id, newName) =>');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /listChatsRaw\(/, '要读列表来判重');
  /* 排除自己：row.id !== id */
  assert.match(body, /row\.id !== id/, '判重必须排除自己');
  assert.match(body, /已经有叫/, '要给能行动的提示');
});

/* ═══════════════════════════════════════════════════════════
   五、编辑态要有退路
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 改名进入编辑态后必须能取消', () => {
  /*
   * 原来 `tools.replaceChildren(commit)` 只放了「保存」——
   * 改名失败（重名/文件被删）之后，用户手里只有"再试一次"，
   * 想放弃只能切走再进一次列表。
   *
   * 失败时最需要的恰恰是"退出来"。
   */
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  assert.match(src, /chat-file-rename-cancel/, '要有取消按钮');
  assert.match(src, /tools\.replaceChildren\(commit, cancelEdit\)/, '两个按钮都要挂上');
});

test('★★★★ 改名成功后要重绘列表（否则界面还显示旧名字）', () => {
  const src = stripComments(read('client/src/chat/chat-actions-page.ts'));
  const at = src.indexOf('chat-file-rename-commit');
  assert.ok(at > 0, '找不到保存按钮');
  const end = src.indexOf('tools.replaceChildren(commit', at);
  const body = src.slice(at, end < 0 ? at + 1400 : end);

  assert.match(body, /await paint\(\)/, '成功后要重绘');
});

/* ═══════════════════════════════════════════════════════════
   六、改名后必须真的重开（2026-11-15 第二次报障）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 改名后必须按新名字重新打开一次（只是改指针不够）', () => {
  /*
   * ## 用户的复现路径
   *
   * 「改名 → 回聊天页 → 发一句话 → 杀掉重进」⇒ 记录没了。
   *
   * 日志证据：
   *
   * ```text
   *   engine：Successfully renamed chat file.      ← 改名确实成功
   *   重进后的请求里第 4 条是**开场白**             ← 打开的是新的一段
   *   两次会话之间没有任何 save / 删除错误
   * ```
   *
   * 结论：改名成功，但**重进时按某个名字读不到**，于是走
   * "空聊天 → 发一句话 → 建档"，那段历史被新的 2 条顶掉。
   *
   * 只改指针挡不住这种情况：
   *
   * ```text
   *   改名时 chatFileName 是 null（上次恢复就没成功）
   *   ⇒ chatFileName === id 不成立 ⇒ 指针不动
   *   ⇒ localStorage 还是旧名字 ⇒ 重进按旧名读 ⇒ 文件已被改名删掉
   * ```
   *
   * ⇒ 所以改完必须**真的读一次**。读成功才算办完，读失败要当场出声。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('onRename: async (id, newName) =>');
  const end = src.indexOf('\n      },', at);
  const body = src.slice(at, end < 0 ? at + 5000 : end);

  assert.match(body, /const wasCurrent = /, '要有一个"是不是当前这段"的判断');
  assert.match(body, /openChatFile\(avatar, finalName\)/, '要按新名字真的重开一次');
  assert.match(body, /if \(!reopened\)/, '重开失败要单独处理');
});

test('★★★★★ "是不是当前这段"要同时看指针与快照', () => {
  /*
   * 只看 `chatFileName` 会漏掉"指针为 null 但快照有内容"的状态，
   * 而那正是上一次恢复失败后留下的样子。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('const wasCurrent = ');
  const line = src.slice(at, src.indexOf(';', at));

  // ★ 不绑定 `this.` 前缀（2026-11-24 搬家后是 `host.`）
  assert.match(line, /\.chatFileName === id/, '要看指针');
  assert.match(line, /chatSnapshot\?\.fileName === id/, '也要看快照');
});

test('★★★★ 快照的 fileName 不许再用空串表示"没有"', () => {
  /*
   * 昨天为了绕类型报错写成了 `fileName: ''`。而空串在比较里
   * 等于"谁都不是" ⇒ `snapshot.fileName === someId` 永远 false
   * ⇒ 改名时判不出"这是当前那段" ⇒ 指针不更新。
   *
   * 语义要用 `null`。
   */
  const src = readShellImplNoComments();
  assert.doesNotMatch(src, /fileName: ''\s*,\s*\n\s*messages:/, '不许用空串占位');
  assert.match(src, /fileName: string \| null/, '类型要允许 null');
});

/* ═══════════════════════════════════════════════════════════
   七、恢复失败不许空转，要换名字再试
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 首选名读不到时要回退到"列表里最新的"，不许空转到超时', () => {
  /*
   * 原实现：
   *
   * ```ts
   *   const latest = preferred ?? (await this.findLatestChat(avatar));
   *   if (latest !== null && (await this.tryLoadInto(avatar, latest))) return;
   *   // ↑ 失败就等 2 秒再来，preferred 还是那个坏名字
   * ```
   *
   * 只要 localStorage 里的名字失效（文件被改名/删掉），就会
   * **空转 60 秒然后放弃** ⇒ 界面空白 ⇒ 用户发一句话 ⇒ 建档成新文件
   * ⇒ 看起来"记录全没了"。
   *
   * 改名场景下这必然触发：改名删掉了旧名字的文件，而 localStorage
   * 里还留着旧名字。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('const first = preferred ??');
  assert.ok(at > 0, '找不到首选名解析');
  const end = src.indexOf('await new Promise((resolve) => setTimeout(resolve, 2000))', at);
  const body = src.slice(at, end < 0 ? at + 3000 : end);

  assert.match(body, /const fallback = await this\.findLatestChat\(avatar\)/, '首选失败要回退');
  assert.match(body, /tried\.includes\(fallback\)/, '回退要和已试过的去重');
});

/* ═══════════════════════════════════════════════════════════
   八、日志必须能回答"指针指向谁"
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 会话指针每次落盘都要留痕', () => {
  /*
   * ## 这条判据是"两次定不了案"换来的
   *
   * 用户两次报"记录没了"，两次都只能靠推理：
   *
   * ```text
   *   engine-8000.log → 改名成功、无报错
   *   app-001-.log    → 只有启动/退出，**没有一行提到指针指向谁**
   * ```
   *
   * 而"重进时首选了哪个文件"是唯一关键事实。推理已经错过一次。
   *
   * ⇒ 落盘时记一行：avatar / fileName / hasSnap。
   * 恢复时记：首选名、来源（preferred 还是 findLatest）、命中还是未命中、回退结果。
   */
  const src = readShellImplNoComments();

  const persistAt = src.indexOf('private persistSession(');
  assert.ok(persistAt > 0, '找不到 persistSession');
  const persistBody = src.slice(persistAt, src.indexOf('\n  }', persistAt));
  assert.match(persistBody, /diagNote\(/, '落盘要留痕');
  assert.match(persistBody, /fileName=/, '要记文件名');

  const restoreAt = src.indexOf('private async restoreLatestChat(');
  const restoreBody = src.slice(restoreAt, restoreAt + 6000);
  assert.match(restoreBody, /\[会话\] 恢复首选/, '恢复要记首选与结果');
  assert.match(restoreBody, /\[会话\] 恢复回退/, '回退也要记');
  assert.match(restoreBody, /\[会话\] 恢复放弃/, '放弃要给结论，否则日志只说明"试过"');
});

/* ═══════════════════════════════════════════════════════════
   九、冷启动不许用开场白覆盖历史（2026-11-15 第三修，真根因）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 恢复期间一律不许写盘（不只是不许建档）', () => {
  /*
   * ## 冷启动的真实时序（日志逐条对得上）
   *
   * ```text
   *   ① mount：从 localStorage 恢复 selectedCharacter + chatFileName（有值）
   *   ② renderChat() 立刻执行：快照为 null ⇒ newChat() ⇒ 只有开场白
   *   ③ handleChatChanged：chatFileName 非 null ⇒ 跳过全部闸门
   *      ⇒ persistChat(开场白) ⇒ ST 整份覆盖 ⇒ 真实历史被冲掉
   *   ④ restoreLatestChat 读到"就剩开场白"的文件 ⇒ 报 ok
   *      ⇒ 日志看着正常，记录已经没了
   * ```
   *
   * 原来的闸写在 `chatFileName === null` 的分支里，只防"建新文件"，
   * 没防"覆盖旧文件" —— 而后者才是丢数据的动作。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('private handleChatChanged');
  assert.ok(at > 0, '找不到 handleChatChanged');
  const end = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, end < 0 ? at + 6000 : end);

  /* 闸要提到函数级：restoring 判断之后立刻 return */
  const restoreGate = body.indexOf('if (restoring && avatar !== null)');
  assert.ok(restoreGate > 0, '要有函数级的"恢复中"闸');

  const gateBlock = body.slice(restoreGate, restoreGate + 800);
  assert.match(gateBlock, /return;/, '恢复中要直接返回，不写盘');

  /*
   * 闸必须在 persistChat 之前。用位置比较而不是"有没有出现"——
   * 后者在函数末尾也成立，等于没钉住顺序。
   */
  const persistAt = body.indexOf('this.persistChat(');
  assert.ok(persistAt > restoreGate, '闸要在写盘之前');
});

test('★★★★★ 没读过文件时不许拿"只有开场白"的内容去覆盖它', () => {
  /*
   * ## 为什么还要这一道（时序闸挡不住启动窗口）
   *
   * `mount()` 的顺序是：
   *
   * ```text
   *   卡一到就 renderPage()      ← 先
   *   await restoreLatestChat()   ← 后
   * ```
   *
   * 重绘故意排前面（否则用户对着空屏等一分钟）。而
   * `renderPage → renderChat → newChat → 开场白 → onChatChanged`
   * **整串都发生在 restoringAvatar 被设上之前** ⇒ 时序闸对这次调用无效。
   *
   * ## 用"读没读过"判断，不依赖时序
   *
   * ```text
   *   lastSavedFingerprint === null   本进程还没成功读过/写过这段
   *   没有 user 消息                  手里只有开场白
   *   chatFileName 非 null            它指向一个可能有历史的真实文件
   * ```
   *
   * 三条同时成立就是"临时显示用的开场白"，写下去 = 整段历史被覆盖。
   *
   * 不误伤：发第一句（有 user）、恢复成功（指纹有值）、新建对话（自己生成名字）。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('private handleChatChanged');
  const end = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, end < 0 ? at + 6000 : end);

  assert.match(body, /const hasUserMessage = /, '要算"有没有用户消息"');
  assert.match(body, /(?:this|host)\.lastSavedFingerprint === null/, '要用"没读过"作为条件');
  assert.match(body, /!hasUserMessage/, '要要求"只有开场白"');
  assert.match(body, /跳过保存（开场白未覆盖）/, '跳过要留痕（否则又是一次定不了案）');

  /* 三道条件必须组成同一个 if，不许分散 */
  const guard = body.indexOf('const hasUserMessage');
  const block = body.slice(guard, guard + 600);
  assert.match(block, /if \([\s\S]*?lastSavedFingerprint === null[\s\S]*?\)/, '三条要在同一个 if 里');
});

test('★★★★★ 保存成功与读回都要记条数', () => {
  /*
   * 两次"定不了案"的教训：日志只证明"persistSession 被调过"，
   * 而**调过不等于写过**（指纹相同会跳过、并发会排队）。
   *
   * 用户这次直接说「气泡出来了但记录没进文件」—— 这句话本来应该
   * 一条日志就能证实或推翻。
   */
  const src = readShellImplNoComments();

  const saveAt = src.indexOf('private async persistChat');
  const saveBody = src.slice(saveAt, src.indexOf('\n  }', saveAt));
  assert.match(saveBody, /保存成功.*条数=/, '写成功要记条数');

  const loadAt = src.indexOf('private async tryLoadInto');
  const loadBody = src.slice(loadAt, loadAt + 4000);
  assert.match(loadBody, /读回.*条数=/, '读回要记条数');
  assert.match(loadBody, /有user=/, '还要记有没有用户消息（区分"只有开场白"）');
});
