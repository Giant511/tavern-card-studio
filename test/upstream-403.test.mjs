/**
 * 403 的两种来源必须分开（2026-11-11）。
 *
 * ## 用户报的
 *
 * > 安卓端有一个新问题，这个绝对不是 API 地址或者是秘钥的问题，
 * > 原生使用相同 API 和秘钥可以正常聊
 *
 * 截图：`/api/backends/chat-completions/generate 返回 403（已重试：true）`
 * 提示："通常是会话过期了"
 *
 * ## 真机日志（这才是真因）
 *
 * ```text
 *   StNode: Streaming request failed with status 403 Forbidden:
 *   {"error":{"message":"账户额度不足。请检查额度或购买。",
 *    "type":"new_api_error","code":"pre_consume_token_quota_failed"}}
 * ```
 *
 * **是上游中转站的 403，跟会话一点关系都没有。** 用户按"会话过期"那句提示
 * 去重连、重登、重填 key，全都治不好 —— 因为要充钱。
 *
 * 而且更糟：老逻辑对 403 一律"重连 + 重试一次"，而上游**按次计费**，
 * 那次重试照样扣钱 —— 在用户已经欠费时又刷了他一次。
 *
 * ## 这条判据钉的三件事
 *
 * ```text
 * ① 403 要看 body 分流，不能一律当 CSRF
 * ② 上游 403 不许重试（省钱）
 * ③ 文案要把服务商原话透出来，不许改写成"会话过期"
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

test('★★★★★ 403 必须按 body 分成「上游拒绝」与「会话失效」两种', () => {
  /*
   * 只看状态码分不出来 —— 两者都是 403。判据是 **body 形状**：
   *
   * ```text
   *   ST 的 CSRF 失败  →  纯文本 "Invalid CSRF token. …"
   *   上游拒绝        →  JSON {"error":{"message":…,"code":…}}
   * ```
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  assert.match(src, /fn classify_forbidden_body/, '要有 403 body 分类函数');
  assert.match(src, /json\.get\("error"\)/, '要检查 error 这一层');
  assert.match(src, /error\.get\("message"\)/, '要取服务商原话');
  assert.match(src, /error\.get\("code"\)/, '要取服务商的 code（用户拿去问客服要用）');

  /* 新错误类型要存在，且与 StForbidden 分开 */
  const err = stripComments(read('client/src-tauri/src/error.rs'));
  assert.match(err, /UpstreamRejected\s*\{/, '要有独立的 UpstreamRejected 变体');
  assert.match(err, /"UPSTREAM_REJECTED"/, '要有对应的 code');
  assert.doesNotMatch(
    err,
    /#\[error\("[^"]*403[^"]*通常是会话过期了"\)\]/,
    '文案不许再说"通常是会话过期了" —— 那句话把上游错误全盖住了',
  );
});

test('★★★★★ 上游 403 不许重试（按次计费，重试就多花钱）', () => {
  /*
   * 用户明确说过 API 是**按次计费**的（5 元 ≈ 200 次）。
   * 额度不足时上游回 403，重试照样扣费 —— 这不是性能问题，是钱。
   *
   * 判据：分类到上游之后必须**立刻返回**，不许走到 `recover_forbidden`。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  const at = src.indexOf('async fn send_post_with_recovery');
  assert.ok(at > 0, '找不到 send_post_with_recovery');
  const body = src.slice(at, at + 3000);

  /*
   * ★ 判据要钉"上游分支里是 return"，不是"UpstreamRejected 之后 400 字符内
   *   没有 recover_forbidden"。
   *
   * 我第一版就是后者，结果**误报**：`UpstreamRejected` 之后紧跟的是
   * `}` 和 CSRF 分支（那里当然有 recover_forbidden），被我算成了违规。
   * 截固定长度必然跨到相邻分支，这个写法从根上就不可靠。
   *
   * 正确的钉法：`return Err(ShellError::UpstreamRejected` 必须**字面连着**出现
   * —— 那就是"立刻返回、不进重试"的证明。
   */
  /*
   * ★ 钉**第一次分类之后**的那个 return，不是"全文存在任一处 return"。
   *
   * 我第二版写成 `assert.match(body, /return Err(...UpstreamRejected/)`，
   * 变异验证（把第一处 `return` 删掉）**没变红** —— 因为封装里有两处
   * `return Err(UpstreamRejected`（第一处首次判为上游，第二处重试后仍判为上游），
   * 删掉第一处还剩第二处，`match` 照样成立。
   *
   * 正确：从首次 `classify_forbidden_body(&text)` 往后截一段，那一段里
   * 必须出现 `return Err(`。删掉 return 时这段就没有了。
   */
  const classifyAt = body.indexOf('classify_forbidden_body(&text)');
  assert.ok(classifyAt > 0, '封装里要分类 body');
  const firstBranch = body.slice(classifyAt, classifyAt + 500);
  assert.match(
    firstBranch,
    /return Err\(ShellError::UpstreamRejected/,
    '首次判为上游必须立刻 return Err(UpstreamRejected)，不许往下走重试',
  );
});

test('★★★★ 所有 POST 路径都走同一套 403 分流', () => {
  /*
   * 四条路径：post_json / 两个 text/bytes 变体 / post_stream（流式）。
   * 漏一条，那条路上的 403 就还是会报成"会话过期"。
   *
   * 特别是**流式**那条：它就是 generate 走的路 —— 用户报的正是它。
   */
  const src = stripComments(read('client/src-tauri/src/st_api.rs'));

  /*
   * 2026-11-21：签名多了第三个参数（`ClientKind`）—— 流式要单独用
   * 没有总超时的那只 client。判据守的性质没变（都要走统一分流），
   * 所以这里只把正则放宽到"允许带参数"，并额外核对两条客户端都有人用。
   */
  const calls = [...src.matchAll(/send_post_with_recovery\(\s*path,\s*&body,\s*(ClientKind::\w+)\s*\)/g)];
  assert.ok(calls.length >= 4, `期望至少 4 处走统一分流，实际 ${String(calls.length)} 处`);
  const kinds = new Set(calls.map((m) => m[1]));
  assert.ok(
    kinds.has('ClientKind::Stream'),
    '流式那条必须传 Stream —— 传 Plain 会被 30 秒总超时掐断',
  );
  assert.ok(kinds.has('ClientKind::Plain'), '普通接口要传 Plain');

  /* 直接用 send_post 的地方只允许在封装内部自己 */
  const direct = [...src.matchAll(/self\.send_post\(/g)].length;
  const inWrapper = [...src.matchAll(/async fn send_post\(/g)].length;
  assert.ok(
    direct <= 3 + inWrapper,
    `有 ${String(direct)} 处直接调 send_post，疑似漏了分流（应走 send_post_with_recovery）`,
  );
});

test('★★★★ 上游原话要透到前端，不许改写成"请求失败"', () => {
  /*
   * "账户额度不足。请检查额度或购买。" 这句话只有服务商说得准。
   * 我们在中间改写成"服务拒绝了这次请求"就等于把最有用的一条信息扔了。
   */
  const shared = stripComments(read('shared/src/chat/bridge-error.ts'));

  assert.match(shared, /case 'UPSTREAM_REJECTED'/, '前端要认这个新 code');

  const at = shared.indexOf("case 'UPSTREAM_REJECTED'");
  const body = shared.slice(at, at + 900);
  /* message 直接沿用（不给兜底覆盖） */
  assert.match(body, /message === '' \?/, '只在 message 为空时才用兜底文案');
  /* hint 要指向真正能解决的方向 */
  assert.match(body, /额度/, 'hint 要提到额度 —— 那是最常见的原因');
  assert.match(body, /不用改任何设置/, '要明确告诉用户"改设置没用"，免得他白折腾');
});
