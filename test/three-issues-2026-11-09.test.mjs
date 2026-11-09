/**
 * 真机三问的判据（2026-11-09）。
 *
 * ## 用户报的三条
 *
 * ```text
 *   ① 我明明填了秘钥，却报 "Key 错误：Key 填错、过期或未设置 Bearer"
 *   ② 导入卡片后却没有导入角色的世界书
 *   ③ 最大回复长度是否有限制？正常这个地方不应该有限制
 * ```
 *
 * ## 这组判据守什么
 *
 * 三条都是"**静默错**"——不报错、不崩、只是结果不对，而且用户无法归因：
 *
 * ```text
 *   ① App 说"已配置"，ST 读出来是空 ⇒ 请求带空 Bearer 发出去 ⇒ 上游怪 key
 *   ② 书没落地，一个字的提示都没有 ⇒ 用户以为这张卡本来就没带书
 *   ③ 上限写死 32000 ⇒ 用户填 64000 被夹回去 ⇒ 回复写到一半截断，没人告诉他为什么
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
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
}

/** 按方法边界切一段（v0.1.8 的教训：固定长度会跨进下一个方法） */
function methodBody(source, signature) {
  const at = source.indexOf(signature);
  if (at < 0) return '';
  const next = source.indexOf('\n  private ', at + signature.length);
  return source.slice(at, next < 0 ? source.length : next);
}

/* ═══════════════════════════════════════════════════════════
   ① key 判据必须与 ST 的 readSecret 一致
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 「有没有 key」只认 active:true，不是「键存在」', () => {
  /*
   * ST 1.13 起 secrets 是数组，每条带 active：
   *
   * ```js
   *   const activeSecret = secretArray.find(s => id ? s.id === id : s.active);
   *   return activeSecret?.value || '';        // 全不 active ⇒ 空串
   * ```
   *
   * 而我们原来只判 `!value.is_null()`。两者不一致的后果：
   *
   * ```text
   *   App 说：已配置 ✓
   *   ST  读到：''
   *   请求带：Authorization: Bearer （空）
   *   上游说：未设置 Bearer
   * ```
   *
   * ★ 这是用户那条 400 的真因，判据必须钉住。
   */
  const rs = read('client/src-tauri/src/st_chat.rs');
  const at = rs.indexOf('pub async fn st_chat_secret_present');
  assert.ok(at > 0, '找不到 st_chat_secret_present');
  const body = rs.slice(at, at + 3000);

  /* 必须读 active 字段 */
  assert.match(body, /"active"/, '必须检查 active 字段');
  assert.match(body, /\.any\(/, '数组里「至少有一条 active」才算有');
  /* 旧格式（值是字符串）不算有 —— ST 那边同样读不出来 */
  assert.match(body, /as_array\(\)/, '必须要求是数组');
  /*
   * 反判据：原来那句 `!value.is_null()` 不能再作为唯一判据。
   * 允许它出现在 else 分支的注释里，不能出现在收集条件中。
   */
  const stripped = stripComments(body);
  assert.doesNotMatch(
    stripped,
    /if !value\.is_null\(\) \{\s*present\.push/,
    '不能只判「值不是 null」就当成有 key',
  );
});

test('★★★ 上游怪 key 时给三种可能，且必须提「额度」', () => {
  /*
   * 用户看到的原文是上游返回的：
   *
   * ```text
   *   Key 错误：Key 填错、过期或未设置 Bearer。请检查 Key。
   * ```
   *
   * 三种处置完全不同，而我们分不清 —— 所以三种都要说。
   * ★ 其中「额度用完」最容易被忽略：用户看到"Key 错误"会一直重粘 key，
   *   而真实原因是额度用完了，重粘一百次也没用。
   */
  const src = stripComments(read('shared/src/chat/generate.ts'));

  assert.match(src, /function looksLikeKeyRejection/, '要有专门的识别函数');
  assert.match(src, /looksLikeKeyRejection\(bodyPreview\)/, '要在 400 分支里用上');

  const at = src.indexOf('if (status === 400 && looksLikeKeyRejection');
  assert.ok(at > 0, '找不到 key 拒绝分支');
  const body = src.slice(at, at + 1200);

  assert.match(body, /额度/, '必须提额度用完这一种');
  assert.match(body, /没真的存进去|没存进去/, '必须提"没存进去"这一种');
  assert.match(body, /填错|复制/, '必须提"填错了"这一种');
});

test('★★ 裸 {error:true} 仍走"没有 key"那条（不能被新分支吃掉）', () => {
  /*
   * 两条 400 分支的**顺序**很重要：
   *
   * ```text
   *   裸 {error:true}  = ST 自己说没 key        → 精确指引
   *   带 message 的    = 上游收到了但说 key 不行 → 三种可能
   * ```
   *
   * 反过来的话，裸 error 会命中 `looksLikeKeyRejection` 的兜底
   * （因为关键词表里有 bearer），把一句确定的话变成三种猜测。
   */
  const src = stripComments(read('shared/src/chat/generate.ts'));
  const bareAt = src.indexOf('status === 400 && isBareErrorTrue(bodyPreview)');
  const keyAt = src.indexOf('status === 400 && looksLikeKeyRejection(bodyPreview)');
  assert.ok(bareAt > 0 && keyAt > 0, '两条分支都要在');
  assert.ok(bareAt < keyAt, '裸 error 那条必须在前');
});

/* ═══════════════════════════════════════════════════════════
   ② 世界书：不许再静默
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 世界书落地失败必须留下原因，不能空 catch', () => {
  /*
   * 原来是：
   *
   * ```ts
   *   } catch {
   *     // 失败静默：卡已经写好了，世界书是加分项
   *     return null;
   *   }
   * ```
   *
   * 后果：卡能用、书没进来、**界面上一个字都没有**。
   * 用户只能猜"是不是这张卡本来就没带世界书"。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));
  const body = methodBody(src, 'private async persistEmbeddedWorldbook');

  assert.ok(body !== '', '找不到 persistEmbeddedWorldbook');
  assert.match(body, /catch \(error\)/, 'catch 要接住错误对象（不能是空 catch）');
  assert.match(body, /lastWorldbookFailure\s*=/, '要把原因记下来');
});

test('★★★★ 「卡里没有书」与「有书但落地失败」必须分开', () => {
  /*
   * 两者处置相反：
   *
   * ```text
   *   none    本来就没有 ⇒ 什么都不该说
   *   failed  有书但没落地 ⇒ 必须说
   * ```
   *
   * 混成一句"世界书未导入"会让没有书的卡也弹提示 —— 噪音换消息，
   * 用户很快就不看了。
   */
  const src = stripComments(read('client/src/chat/shell.ts'));

  assert.match(src, /interface CardWriteResult/, '要有结果类型');
  assert.match(src, /worldbook:\s*'ok'\s*\|\s*'none'\s*\|\s*'failed'/, '三态要分清');
  /* 判定「卡里到底有没有书」要用源头函数，不能靠"没报错就算没有" */
  assert.match(src, /readEmbeddedWorldbook\(/, '要知道卡里到底有没有书');
});

test('★★★ 两条导入路径都要把世界书结果说出来', () => {
  const src = stripComments(read('client/src/chat/shell.ts'));

  for (const fn of ['private async importLocalCard', 'private async importRepoVersion']) {
    const body = methodBody(src, fn);
    assert.ok(body !== '', `找不到 ${fn}`);
    assert.match(body, /worldbook === 'failed'/, `${fn} 要把失败说出来`);
  }

  /*
   * 成功时也要提一句"含世界书「x」" —— 否则用户不知道书进来了。
   * 这比"没进来"更需要说：静默成功等于放弃一次确认机会。
   */
  const local = methodBody(src, 'private async importLocalCard');
  assert.match(local, /含世界书/, '成功时要说明书也进来了');
});

/* ═══════════════════════════════════════════════════════════
   ③ 最大回复长度不再有硬上限
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 最大回复长度不许卡在 32000', () => {
  /*
   * 用户原话：
   *
   * > 最大回复长度是否有限制？正常这个地方不应该有限制。
   *
   * 原来 `max: 32_000`。而上限卡住的后果是**用户改了也不生效**：
   * 他想填 64000，输入框把它夹回去，然后回复写到一半被截断 ——
   * 界面上没有任何地方说明"是你填的数被我们压小了"。
   *
   * 现在留一百万做边界：那只是拦明显误触（多按几个零），
   * 不构成对任何现役模型的限制。
   */
  const src = stripComments(read('shared/src/chat/settings-schema.ts'));
  const at = src.indexOf("label: '最大回复长度（Token）'");
  assert.ok(at > 0, '找不到最大回复长度这一项');
  /* 往前找这段对象的起点，取足够长的窗口 */
  const body = src.slice(Math.max(0, at - 200), at + 800);

  const maxMatch = /max:\s*([0-9_]+)/.exec(body);
  assert.ok(maxMatch !== null, '这一项应有 max');
  const max = Number((maxMatch[1] ?? '0').replace(/_/g, ''));
  assert.ok(max >= 1_000_000, `上限必须放到一百万以上，实际 ${String(max)}`);
});

test('★★ 采样参数仍会被带进请求体（放开上限不能把这条弄坏）', () => {
  const src = stripComments(read('shared/src/chat/generate.ts'));
  assert.match(src, /request\.max_tokens = s\.maxTokens/, 'max_tokens 仍要下发');
});

/* ═══════════════════════════════════════════════════════════
   ④ 启动探活：两侧超时必须同值，且要够长
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 探活超时两侧必须同值', () => {
  /*
   * 用户真机报「世界没能打开，等了 90 秒还没就绪」。
   *
   * ## 真因不是引擎起不来
   *
   * 报错那会儿 8000 还没有 LISTEN，而几分钟后从 adb 直连拿到：
   *
   * ```text
   *   HTTP 200  耗时 0.08s
   *   {"agent":"SillyTavern:1.19.0:Cohee#1207",...}
   * ```
   *
   * 引擎**起来了**，只是比 30 秒慢。
   *
   * ## 原来的模型漏了一种情况
   *
   * ```text
   *   热启动（已有数据）  30 秒
   *   首次安装            120 秒
   *   升级安装            ← 没考虑，走 30 秒，不够
   * ```
   *
   * 而启动耗时**随用户数据量增长**（卡 / 聊天 / 世界书都要扫），
   * 拿固定值卡它会越来越容易不够。
   *
   * ## 判据
   *
   * 三处必须同值：Java 的 PROBE_TIMEOUT_MS / shared 的 PROBE_TIMEOUT_MS /
   * 前端的开屏 timeoutMs。不同值的后果是"后端已放弃、前端还在等"，
   * 用户会看到两次失败，而引擎其实起来了。
   */
  const java = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );
  const shared = read('shared/src/android/st-lifecycle.ts');
  const mainTs = read('client/src/mobile/main.ts');

  const javaMs = Number(/const val PROBE_TIMEOUT_MS = ([0-9_]+)L/.exec(java)?.[1]?.replace(/_/g, '') ?? '0');
  const sharedMs = Number(/export const PROBE_TIMEOUT_MS = ([0-9_]+)/.exec(shared)?.[1]?.replace(/_/g, '') ?? '0');
  const splashMs = Number(/timeoutMs: ([0-9_]+)/.exec(mainTs)?.[1]?.replace(/_/g, '') ?? '0');

  assert.ok(javaMs > 0, '没读到 Java 的 PROBE_TIMEOUT_MS');
  assert.ok(sharedMs > 0, '没读到 shared 的 PROBE_TIMEOUT_MS');
  assert.ok(splashMs > 0, '没读到开屏的 timeoutMs');

  assert.equal(javaMs, sharedMs, `Java(${String(javaMs)}) 与 shared(${String(sharedMs)}) 必须同值`);
  assert.equal(sharedMs, splashMs, `shared(${String(sharedMs)}) 与开屏(${String(splashMs)}) 必须同值`);

  /* 30 秒被真机证伪过：升级安装不够。至少 120 秒 */
  assert.ok(javaMs >= 120_000, `探活上限不能低于 120 秒，实际 ${String(javaMs)}`);
});

test('★★★★ 超时提示不许叫用户"重启应用"', () => {
  /*
   * 超时时 node 进程通常还活着、还在继续初始化。
   * "重启应用"会杀掉它，把它拖回起点 —— 那是最坏的建议。
   *
   * 正确指引是"进主界面等一会儿"：主界面里任何操作都会再问一次
   * `ensureRunning`，那时进程往往已经就绪（走复用分支）。
   */
  const java = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );
  const at = java.indexOf('引擎还在启动');
  assert.ok(at > 0, '找不到超时提示');
  const body = java.slice(at, at + 300);

  assert.match(body, /不要重启/, '要明确劝阻重启');
  assert.match(body, /主界面/, '要给出"进主界面等"这条路');
});

test('★★★★★ 「进程活着」不等于「端口在听」', () => {
  /*
   * 这是"世界没能打开"的第二层原因，比超时更隐蔽。
   *
   * ## 原来的死循环
   *
   * ```text
   *   ① 启动超时（进程还活着、还在初始化）
   *   ② 用户点重试 → ensureRunning 走复用分支
   *               → 直接 return StartResult(true, "引擎正在运行")
   *               → **一次 probe 都不做**
   *   ③ 调用方以为好了，马上发请求
   *   ④ 端口还没 LISTEN → 请求失败
   *   ⑤ 用户再点重试 → 回到 ②
   * ```
   *
   * 也就是说「重试」永远不可能成功：它只回答"进程在不在"，
   * 而用户要的是"能不能用"。
   *
   * ## 判据
   *
   * 复用分支必须也去等端口（与 spawn 那条路径共用 `awaitListening`），
   * 不许直接返回成功。
   */
  const java = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );

  /* ① 有共用的等待方法 */
  assert.match(java, /private fun awaitListening\(/, '要有共用的等待方法');

  /* ② 复用分支调它，而不是直接返回 true */
  const reuseAt = java.indexOf('if (isOurProcessAlive())');
  assert.ok(reuseAt > 0, '找不到复用分支');
  const reuseBlock = java.slice(reuseAt, reuseAt + 1400);

  assert.match(reuseBlock, /awaitListening\(/, '复用分支必须等端口，不能直接返回成功');
  assert.doesNotMatch(
    reuseBlock,
    /return StartResult\(true[^)]*reused = true\)/,
    '不许在没 probe 的情况下就说"引擎正在运行"',
  );

  /* ③ spawn 分支也用它（两处同一份逻辑，不许各写一套） */
  const calls = (java.match(/awaitListening\(port/g) ?? []).length +
    (java.match(/awaitListening\(/g) ?? []).length;
  assert.ok(calls >= 2, `两条路径都要用它，实际调用 ${String(calls)} 次`);

  /* ④ 复用时可以传 null 进程（没法查 isAlive，只能靠 probe + 超时） */
  assert.match(java, /awaitListening\(port, PROBE_TIMEOUT_MS, null\)/, '复用路径传 null 进程');
});

test('★★★ 等待循环必须能识别"进程已退出"（否则白等满时限）', () => {
  /*
   * 进程崩了还继续等满 120 秒，是最差的失败方式：
   * 用户干等两分钟，最后看到的是"超时"而不是真正原因（退出码）。
   */
  const java = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StLauncher.kt',
  );
  const at = java.indexOf('private fun awaitListening');
  assert.ok(at > 0, '找不到 awaitListening');
  const body = java.slice(at, at + 2600);

  assert.match(body, /proc != null && !proc\.isAlive/, '要看自己 spawn 的进程是否还活着');
  assert.match(body, /exitValue/, '退出要报退出码');
  assert.match(body, /PROBE_INTERVAL_MS/, '要有探活间隔');
});

test('★★★★★ lastError 必须在启动开始时清掉（否则旧失败毒化新启动）', () => {
  /*
   * 用户报：
   *
   * > 还是提示没有进入世界，但是界面过了几秒又自动跳转了
   *
   * ## 这条链路值得完整记住
   *
   * ```text
   *   status() 交出： running = isOurProcessAlive()   error = lastError
   *   前端判据：      running === false && error !== null ⇒ 立刻放弃
   *
   *   t=0   这次启动刚开始，node 还没 spawn ⇒ running = false
   *         lastError 还是**上一次**的"引擎启动超时"⇒ error ≠ null
   *   t=0+  前端立刻判失败（不等 120 秒）
   *   几秒后 开屏的 2200ms 延时到 ⇒ 自动进主界面
   *   而引擎在后台照常启动，最后是好的
   * ```
   *
   * 用户看到的那句"没进入世界"其实是**上一次**的旧文案。
   *
   * ## 判据
   *
   * `prepareAndStart()` 一进来就要把 `lastError` 置 null。
   * `error` 的语义是"这一次失败的原因"——这次才刚开始，还没有失败可言。
   *
   * 清掉不损失反应速度：这次真失败时 `ensureRunning` 会立刻返回并写回，
   * 前端下一次轮询（500ms）就能看到。
   */
  const svc = read(
    'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine/StService.kt',
  );
  const at = svc.indexOf('private fun prepareAndStart()');
  assert.ok(at > 0, '找不到 prepareAndStart');
  /* 取方法开头一小段就够 —— 清空必须在最前面 */
  const head = svc.slice(at, at + 1800);

  const clearAt = head.indexOf('lastError = null');
  assert.ok(clearAt > 0, 'prepareAndStart 里必须清掉 lastError');

  /*
   * 顺序也要守：清理必须发生在 `ensureRunning` **之前**。
   * 放在后面等于这次已经失败了才清 —— 那时清不清都没意义。
   */
  const runAt = head.indexOf('ensureRunning(');
  if (runAt > 0) {
    assert.ok(clearAt < runAt, '清空必须排在 ensureRunning 之前');
  }
});

test('★★★★★ 超时不许用"世界没能打开"这个标题', () => {
  /*
   * 超时 = 我们等够了，但引擎还在启动。
   * 失败 = 引擎明确报错 / 进程死了。
   *
   * 把前者说成后者，用户会去重启、重装 —— 而**重启恰好会杀掉
   * 正在启动的引擎**，是最坏的一步。
   *
   * 这就是用户那句自相矛盾的话的来源：
   * 「还是提示没有进入世界，但是界面过了几秒又自动跳转了」
   */
  const mainTs = stripComments(read('client/src/mobile/main.ts'));

  const at = mainTs.indexOf('if (!waited.ok)');
  assert.ok(at > 0, '找不到开屏失败分支');
  const body = mainTs.slice(at, at + 1600);

  /* 必须有 timedOut 这个区分 */
  assert.match(body, /timedOut/, '要把"超时"与"失败"分开');
  /* 超时时不许 setPhase('failed') */
  assert.match(body, /if \(!timedOut\) splash\.setPhase\('failed'\)/, '只有非超时才切失败态');
  /* 超时的 hint 要说"还在启动"，而不是"没能打开" */
  assert.match(body, /还在启动/, '超时要说明引擎还在启动');
  assert.doesNotMatch(
    body,
    /setPhase\('failed'\);\s*\n\s*splash\.setHint\(\s*waited\.reason === null/,
    '不许无条件先切失败态再判断',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 最大回复长度：API 连接页也有夹紧（用户改的就是这一页）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ API 连接页不许再把 maxTokens 夹在 8192', () => {
  /*
   * 用户报「最大回复长度是否有限制」时，我先只改了
   * `settings-schema.ts`（AI 响应配置页那份）。
   *
   * **不够。** 用户真正编辑的是「我的 → API 连接」这一页，而它在
   * 三个地方各写了一遍 8192：
   *
   * ```text
   *   input 的 max 属性    max="8192"
   *   草稿校验             n >= 256 && n <= 8192
   *   保存校验             rawMax >= 256 && rawMax <= 8192
   * ```
   *
   * 三处都是"越界**静默替换**成默认值" —— 用户填 100000，保存后界面
   * 显示 2048，没有任何提示说被改了。这就是"改了不生效"的经典形态。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));

  /* ① 不许再有裸 8192 */
  assert.doesNotMatch(src, /8192|8_192/, '8192 这个夹紧值必须清掉');

  /* ② 三处都要走共享常量 */
  assert.match(src, /MAX_TOKENS_MIN/, '要有共享下界常量');
  assert.match(src, /MAX_TOKENS_MAX/, '要有共享上界常量');
  assert.match(src, /setAttribute\('max', String\(MAX_TOKENS_MAX\)\)/, 'input 的 max 要用常量');

  /* ③ 上界要与 settings-schema 一致（两页不能各说一套） */
  const maxConst = Number(/export const MAX_TOKENS_MAX = ([0-9_]+)/.exec(src)?.[1]?.replace(/_/g, '') ?? '0');
  assert.ok(maxConst >= 1_000_000, `API 页上界不能低于一百万，实际 ${String(maxConst)}`);
});

/* ═══════════════════════════════════════════════════════════
   ⑥ key 写入：只写一次，且要核实真的生效
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 写 key 只能有一个地方（两处都写会让 secrets 无限膨胀）', () => {
  /*
   * ST 的 `writeSecret` 是**追加**语义：新写一条、把别的置为 active:false。
   *
   * 曾经 `api-page.ts` 与 `writeApiConnectionToSt()` 各写一遍 ⇒
   * 每保存一次就往 secrets.json 加两条，保存一百次积两百条历史 key。
   *
   * 现在分工：api-page 写，外壳只回读校验。
   */
  const api = stripComments(read('client/src/chat/api-page.ts'));
  const shell = stripComments(read('client/src/chat/shell.ts'));

  /* api-page 必须是写入点 */
  assert.match(api, /await bridge\.writeSecret\(/, 'api-page 要负责写入');

  /* shell 的 writeApiConnectionToSt 里不许再调 writeSecret */
  const at = shell.indexOf('private async writeApiConnectionToSt');
  assert.ok(at > 0, '找不到 writeApiConnectionToSt');
  const body = shell.slice(at, at + 4000);
  assert.doesNotMatch(body, /bridge\.writeSecret\(/, '外壳不该再写一遍 key，否则 secrets 会翻倍');
});

test('★★★★★ 写完必须回读确认，不许只信 200', () => {
  /*
   * 用户报「我明明填了秘钥」，而真机取证发现 ST 那边**全是 null**。
   *
   * `writeSecret` 返回 200 只说明 ST 收下了请求，不代表 secrets.json 里
   * 真有一条 `active: true`。而 ST 的 `readSecret()` 只认 active 那条：
   *
   * ```js
   *   const activeSecret = secretArray.find(s => s.id === id : s.active);
   *   return activeSecret?.value || '';
   * ```
   *
   * 所以保存流程必须用 `secretPresent()` 确认"引擎读得到"，
   * 而不是假定写成功。
   */
  const shell = stripComments(read('client/src/chat/shell.ts'));
  const at = shell.indexOf('private async writeApiConnectionToSt');
  assert.ok(at > 0, '找不到 writeApiConnectionToSt');
  const body = shell.slice(at, at + 4000);

  /*
   * ★ 判据必须钉"present 来自真实回读"，不能只钉"这两句话存在"。
   *
   * 变异验证抓到的：把调用换成 `const present: string[] = [secretKey];`
   * 之后，`secretPresent()` 与 `present.includes(secretKey)` 仍然各在——
   * 原来的两条断言**全绿**，而回读其实已经没了。
   *
   * 所以要求 `present` 的**赋值表达式本身**含 `secretPresent()`。
   */
  assert.match(
    body,
    /const present\s*=\s*await[^;]*secretPresent\(\)/,
    'present 必须由 secretPresent() 真实回读得到（不许用本地数组冒充）',
  );
  assert.match(body, /present\.includes\(secretKey\)/, '要按名字核对，不是"有返回值就算成功"');
  assert.match(body, /problems\.push/, '不一致要进 problems（会被显示出来）');
});
