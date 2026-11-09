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
