/**
 * 安卓端三个问题（2026-11-11）。
 *
 * ## 用户报的
 *
 * ```text
 * ① 安装后的第一次切换聊天角色不会自动加载开场白，需要进去保存一下才行
 * ② 仓库有背景的时候下载没有把仓库的背景下载下来并合并成一张 PNG，
 *    如果无背景提示用户选背景或者生成背景
 * ③ 卡片的缩略图在每次进仓库界面都要请求一次进行加载，我的建议是和仓库
 *    里面的卡片背景对比一下，如果不一样再进行替换
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ═══════════════════════════════════════════════════════════
   ① 首次切角色没有开场白
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 读角色卡失败必须重试（引擎首启要 7–57 秒）', () => {
  /*
   * 根因：`loadCharacterCard` 的 catch 里静默置空，**不重试**。
   *
   * ```text
   *   切角色 → renderPage()（空卡，没开场白）
   *          → loadCharacterCard()   ← 引擎没起，失败即空，不重试
   *          → restoreLatestChat()   ← 有重试，但救不了已经空掉的卡
   * ```
   *
   * 而 `restoreLatestChat` 每轮都 `ensureConnected()` —— 等引擎就绪的机制
   * 一直存在，只是没用在读卡上。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  assert.match(
    src,
    /private async loadCharacterCardWithRetry/,
    '要有带重试的读卡入口',
  );

  const at = src.indexOf('private async loadCharacterCardWithRetry');
  const body = src.slice(at, at + 1200);

  assert.match(body, /ensureConnected\(\)/, '每轮重试前要先确保连上引擎');
  assert.match(body, /Date\.now\(\) >= deadline/, '要有超时上限（不能无限重试）');
  assert.match(body, /setTimeout/, '两轮之间要退避');
  assert.match(body, /CARD_LOAD_TIMEOUT_MS/, '超时预算要是具名常量，不是魔法数');
});

test('★★★★★ 冷启动与切角色都要用带重试的读卡', () => {
  /*
   * 两条路都会撞上"引擎没起"：冷启动（mount 时引擎刚拉起来）
   * 与切角色（用户随时可能切）。只要有一条漏了，那条路上就永远没有开场白。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  const calls = [...src.matchAll(/loadCharacterCardWithRetry\(/g)].length;
  assert.ok(
    calls >= 3,
    `定义 + 两处调用点，期望至少 3 次出现，实际 ${String(calls)} 次（有一条路没接上）`,
  );

  /*
   * 单次版还剩两处是**对的**：
   *
   * ```text
   *   ① loadCharacterCardWithRetry 内部的那一次尝试   ← 它本来就该是单次
   *   ② 保存之后的重读（refreshOpeningAfterEdit）    ← 那一刻引擎必然已就绪
   * ```
   *
   * 我第一版写 `plain <= 1`，把 ① 也算成了"漏接重试"，误报。
   * 判据要看**调用点在哪**，不是数总数。
   */
  const plainCalls = [...src.matchAll(/await this\.loadCharacterCard\(/g)];
  assert.ok(
    plainCalls.length <= 2,
    `裸调用 loadCharacterCard 应只剩 2 处（重试内部 1 + 保存后 1），实际 ${String(plainCalls.length)} 处`,
  );
});

test('★★★★ 卡读到就要重绘，不许等历史（等 60 秒空屏）', () => {
  /*
   * `restoreLatestChat` 找不到历史时会重试到 60 秒超时。
   * 把重绘排在它后面 ⇒ 用户对着"没有开场白"的空屏等一分钟。
   * 而开场白只需要卡，不需要历史。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  for (const marker of ['const gotCard = await this.loadCharacterCardWithRetry']) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `找不到 ${marker}`);
    const after = src.slice(at, at + 700);
    assert.match(
      after,
      /this\.renderPage\(\)[\s\S]{0,200}?await this\.restoreLatestChat/,
      'renderPage() 必须排在 restoreLatestChat 之前（卡到了就先画）',
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   ② 下载没合并仓库背景
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 下载导入要用仓库卡面当底图（不是永远首字封面）', () => {
  /*
   * 原来传的是 `base: null`，理由是"卡面是 webp，buildPngCard 只认 PNG"。
   * 但 `convertToPng` 一直存在（桌面导出用的就是它），只是没接到这条路上。
   *
   * 后果：仓库里精心画的卡面，下载下来是一个字 —— 正是 v0.1.8 当初说
   * 要避免的"所有卡长得一样"。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  const at = src.indexOf('private async importRepoVersion');
  assert.ok(at > 0, '找不到 importRepoVersion');
  const body = src.slice(at, at + 3000);

  assert.match(body, /fetchRepoFaceForImport\(cardId\)/, '要先拉仓库卡面');
  assert.match(body, /convertToPng\(/, 'webp 要转成 PNG 才能当容器');
  assert.match(body, /writeCardToLibrary\(\{ plan, jsonText, base \}\)/, '把转好的字节传进去');
  assert.doesNotMatch(body, /writeCardToLibrary\(\{ plan, jsonText, base: null \}\)/, '不许再固定传 null');
});

test('★★★★ 没有背景时要提示用户（不能静默用首字封面）', () => {
  /*
   * 用户明确要求："如果无背景提示用户选背景或者生成背景"。
   * 不说的话，用户会以为"下载坏了" —— 而其实仓库里那张卡本来就没配图。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const at = src.indexOf('private async importRepoVersion');
  const body = src.slice(at, at + 3600);

  assert.match(body, /if \(face === null\)/, '要对"没有卡面"单独分支');
  assert.match(body, /onNotify\?\.\(/, '要说给用户听');
  assert.match(body, /背景/, '提示文案要点明是背景图的事');
});

/* ═══════════════════════════════════════════════════════════
   ③ 缩略图每次都重新请求
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 缩略图要按内容指纹缓存，一致就不发请求', () => {
  /*
   * 用户建议「和仓库里面的卡片背景对比一下，如果不一样再进行替换」。
   *
   * 比对什么都试过：
   *
   * ```text
   *   card.updatedAt   ✗ 改标题也变 ⇒ 白拉一次图
   *   card.seq         ✗ 改设定也涨版本号
   *   face.sha256      ✓ 只有图变了才变
   * ```
   */
  const page = stripComments(read('client/src/chat/repo-cards-page.ts'));

  assert.match(page, /faceSha256/, '行数据要带卡面指纹');
  assert.match(page, /const repoFaceCache = new Map/, '要有缓存容器');
  assert.match(page, /cached\.sha256 === card\.faceSha256/, '要按指纹比对命中');
  assert.match(page, /paintFace\(faceBox, doc, cached\.url\)/, '命中就直接画，不发请求');
});

test('★★★★ 缓存键要带仓库名（否则换仓库会串图）', () => {
  /*
   * `cardId` 在不同仓库之间可能重名。只用 cardId 当键，
   * 换仓库后会画出上一个仓库的图 —— 那种错看着像"图加载错了"，
   * 极难联想到缓存。
   */
  const page = stripComments(read('client/src/chat/repo-cards-page.ts'));
  assert.match(page, /\$\{input\.repoName\}\/\$\{card\.id\}/, '缓存键必须是 仓库名/卡 id');
  assert.match(page, /REPO_FACE_CACHE_LIMIT/, '要有容量上限（不然长会话会一直涨）');
  assert.match(page, /clearRepoFaceCache/, '要提供清理入口');
});

test('★★★★ 取图失败时不许写缓存（否则那张卡永不重试）', () => {
  /*
   * 把失败也写进缓存，下次会以为"已经是最新的"，于是那张卡永远是兜底首字。
   * 判据：写缓存必须在 `url === null` 的 return 之后。
   */
  const page = stripComments(read('client/src/chat/repo-cards-page.ts'));

  /*
   * ★ 定位必须带完整参数 —— 写成 `indexOf('rememberFace(cacheKey')` 会先命中
   * **函数定义**（`function rememberFace(cacheKey: string, …)`），于是
   * "写在取到值之后"这条永远判不出来。
   *
   * 这是本项目**重复犯**的错：前缀相同就撞车（今天第 3 次，
   * 前两次是 `async fn send_post` 撞 `send_post_with_recovery`）。
   * 规矩：**定位一律带足以区分的尾缀**。
   */
  const nullCheck = page.indexOf('if (url === null) return;');
  const remember = page.indexOf('rememberFace(cacheKey, card.faceSha256, url)');
  assert.ok(nullCheck > 0, '要有 url 为空的提前返回');
  assert.ok(remember > 0, '要写缓存（调用点，不是定义）');
  assert.ok(remember > nullCheck, '写缓存必须在"取到值"之后 —— 失败不写');
});

/* ═══════════════════════════════════════════════════════════
   ② 补：转码失败不许静默 + 安卓 WebView 兼容
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 背景转码失败必须报出来，不许静默退回首字封面', () => {
  /*
   * 第一版这里是 `catch { base = null }` —— **静默**。
   *
   * 真机后果（用户录的两段视频）：
   *
   * ```text
   *   仓库里有卡面的卡，下载耗时 13 秒（图确实拉下来了）
   *   最终却仍是首字封面
   *   而且一句解释都没有 ⇒ 用户只能说"问题未解决"
   * ```
   *
   * 吞掉失败比失败本身更坏：失败还能查，静默只能猜。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const at = src.indexOf('private async importRepoVersion');
  assert.ok(at > 0);
  const body = src.slice(at, at + 4000);

  assert.match(body, /let faceProblem/, '要把失败原因记下来');
  assert.match(body, /faceProblem =/, 'catch 里要赋值原因');
  assert.match(body, /faceProblem !== null/, '有原因就要单独提示');
});

test('★★★★★ 转码的长边要能限小（4096 的 canvas 在手机上很危险）', () => {
  /*
   * `FACE_MAX_EDGE = 4096` 是桌面导出的规格。4096×4096 的 canvas 是
   * 16M 像素 ≈ 64MB，再 PNG 编码一遍 —— 安卓 WebView 很容易在这里失败。
   *
   * 而卡面最终显示的地方（角色列表、聊天顶栏）最大也就几百 px。
   * 用 4096 既浪费又危险。
   */
  const conv = stripComments(read('client/src/export/face-convert.ts'));
  assert.match(conv, /maxEdge: number = FACE_MAX_EDGE/, '要有可覆盖的长边上限');
  assert.match(conv, /scaledSize\(originalWidth, originalHeight, maxEdge\)/, '缩放要用参数而不是常量');

  const shell = stripComments(read('client/src/chat/shell.ts'));
  assert.match(
    shell,
    /convertToPng\(\s*face\.bytes,[\s\S]{0,120}?1024,/,
    '下载卡面时要传 1024，别用 4096',
  );
});

test('★★★★ 解码要有 <img> 兜底（createImageBitmap 在安卓 WebView 上没验证过）', () => {
  /*
   * 原来只有 `createImageBitmap(blob)`。它在桌面 WebView 一直好使，
   * 但安卓从没验证过 —— 而安卓上正好新加了一条要用它的逻辑。
   *
   * `<img>` + decode() 老得多、对 webp 的支持也更普遍。
   * 顺序仍是先试快的，失败再兜底 —— 不改变桌面行为。
   */
  const conv = stripComments(read('client/src/export/face-convert.ts'));
  assert.match(conv, /decodeWithImgElement/, '要有 <img> 兜底解码');
  assert.match(conv, /createImageBitmap 失败/, '失败信息要同时给出两条路的原因');
  assert.match(conv, /drawTarget\(/, 'drawImage 要能接受 <img>（CanvasImageSource）');
});

/* ═══════════════════════════════════════════════════════════
   ④ 切角色后两个角色的开场白一样
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 切角色必须先清空 loadedCard（否则新角色用旧卡建开场白）', () => {
  /*
   * 用户报：「切换两个角色后的开场白是一样的，这两个角色的开场白正常
   * 是不一样的才对」。
   *
   * ## 链路
   *
   * ```text
   *   切角色
   *     → chatSnapshot = null
   *     → renderPage()            ← 同步，此刻 loadedCard 还是**上一个角色**的
   *     → 面板无快照 ⇒ newChat()
   *     → buildOpeningMessages(旧卡) ⇒ 建出**旧角色的开场白**
   *     → onChatChanged ⇒ handleChatChanged ⇒ **chatSnapshot 又被填上**
   *   新卡加载完 → renderPage()
   *     → chatSnapshot !== null ⇒ 走快照分支
   *     → 显示旧角色的开场白
   * ```
   *
   * 判据钉两件事：
   *   ① 切角色那段里有 `this.loadedCard = {}`
   *   ② 它在 `renderPage()` **之前**（顺序反了就白清）
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  const at = src.indexOf('this.lastSavedFingerprint = null;');
  assert.ok(at > 0, '找不到切角色清状态的位置');
  const body = src.slice(at, at + 3000);

  const clearAt = body.indexOf('this.loadedCard = {}');
  assert.ok(clearAt > 0, '切角色时必须清空 loadedCard —— 否则新角色会用到上一个角色的卡');

  const renderAt = body.indexOf('this.renderPage()');
  assert.ok(renderAt > 0, '找不到紧接着的 renderPage()');
  assert.ok(
    clearAt < renderAt,
    '清空 loadedCard 必须在 renderPage() 之前（反了就等于没清）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 下载后头像还是兜底 —— ST 的缩略图缓存没失效
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 下载写卡后必须让 ST 的缩略图失效（两层缓存都要清）', () => {
  /*
   * 真机取证（直连 ST 读字节）：
   *
   * ```text
   *   原图   /characters/威廉.png      PNG  683×1024（691 KB） ← 已经是仓库卡面
   *   缩略图 /thumbnail?type=avatar    JPEG  96×144（5 KB）    ← 还是绿「威」字
   * ```
   *
   * **卡是对的，列表画的是 ST 缓存的旧缩略图。**
   *
   * ST 靠 `originalStat.mtimeMs > cachedStat.ctimeMs` 判断原图变没变，
   * 而我们是直接写文件（tmp + rename），绕过了它的 API —— 它没机会知道。
   *
   * 所以必须在写卡之后主动让缓存失效，而且**两层都要清**：
   * ST 磁盘那层不清 ⇒ App 重新请求拿到的还是旧字节；
   * App 内存那层不清 ⇒ 这一会话根本不重新请求。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  /*
   * ★ 2026-11-11 改过定位：第一版只修在**仓库下载那个调用点**，于是用户
   * 第二次报「直接导入 PNG 卡，缩略图还是兜底」—— 修在调用方就是会漏。
   *
   * 现在修在 `writeCardToLibrary` **内部**（两条导入路径共用），
   * 判据也跟着落到那里。
   */
  const at = src.indexOf('private async writeCardToLibrary');
  assert.ok(at > 0, '找不到 writeCardToLibrary');
  const nextPrivate = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, nextPrivate < 0 ? src.length : nextPrivate);

  assert.match(body, /invalidateThumbnail\(plan\.avatar/, '要删掉 ST 的缩略图缓存');
  assert.match(body, /clearThumbnailCacheFor\(plan\.avatar\)/, '要清 App 自己的缓存');
});

test('★★★★★ 删缩略图的命令必须收窄（它能删文件）', () => {
  /*
   * 这个命令能删磁盘文件，边界必须钉死：
   *
   * ```text
   *   ① 目录只能由 characters_dir 推导，不接受外部传目录
   *   ② avatar 不许含路径分隔符（防 ../../ 穿越）
   *   ③ 只删主干相同的文件（`威廉.png` 的缩略图可能叫 `威廉.jpg`）
   * ```
   */
  const rust = stripComments(read('client/src-tauri/src/st_chat.rs'));

  assert.match(rust, /pub async fn st_chat_invalidate_thumbnail/, '要有这个命令');

  const at = rust.indexOf('pub async fn st_chat_invalidate_thumbnail');
  const body = rust.slice(at, at + 2400);

  assert.match(body, /contains\("\.\."\)/, '要拒绝含 .. 的 avatar（防穿越）');
  assert.match(body, /contains\('\/'\)/, '要拒绝含 / 的 avatar');
  assert.match(body, /characters_dir\)\.parent\(\)/, '缩略图目录只能由 characters_dir 推导');
  assert.match(body, /thumbnails/, '要定位到 thumbnails 目录');
  assert.match(body, /file_stem/, '按主干比（缩略图扩展名可能和原图不同）');
});

test('★★★★ 命令要注册进 invoke_handler（否则前端调不到）', () => {
  const lib = stripComments(read('client/src-tauri/src/lib.rs'));
  assert.match(lib, /st_chat::st_chat_invalidate_thumbnail/, '要注册');
});
