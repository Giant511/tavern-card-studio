/**
 * 流式生成不该被自己的超时掐断，也不该每帧重渲染（2026-11-21）。
 *
 * ## 用户报的两个现象
 *
 * ```text
 * ① 读流失败：error decoding response body
 * ② 流式传输卡顿：一秒冒 3 个字，过一会儿一秒突然蹦 6、7 个字
 * ```
 *
 * ## ① 的根因：我们自己的 30 秒总超时
 *
 * `reqwest::ClientBuilder::timeout` 是**整个请求**的总时限，**包含读完 body**。
 * 而一次流式生成要几十秒到几分钟，所以必然在中途被掐断。
 *
 * 真机日志给出了铁证 —— 每次生成的落盘间隔都是 **30.1 秒**，
 * 一次不多一次不少，与 `REQUEST_TIMEOUT = 30s` 严丝合缝：
 *
 * ```text
 *   14:08:50.441 保存 条数=74
 *   14:09:20.555 保存 条数=75   ← 30.1s
 *   14:10:15.743 保存 条数=74
 *   14:10:45.846 保存 条数=75   ← 30.1s
 * ```
 *
 * 而上游那边（engine 日志）最后一行是 `Streaming request in progress` ——
 * 它还在推。断的是我们这头。
 *
 * 报错文案 `error decoding response body` 是 hyper/reqwest 在读 body 时
 * 遇到连接中止的说法，看上去像"网络坏了"，所以这条极容易被误判。
 *
 * ## ② 的根因：每帧全量重渲染
 *
 * `patchStreamingMessage` 里是 `bubble.innerHTML = renderMessageHtml(state.text)`：
 * **把累积的全文重新跑一遍 markdown 渲染，再重建整个气泡的 DOM**。
 * 每帧成本随回复长度线性增长，主线程被占满 → 显示滞后 → 一次性追赶 → 蹦字。
 *
 * ## 判据为什么看源码文本
 *
 * 超时策略是 `ClientBuilder` 的构造参数，没有可在 Node 里调用的纯函数；
 * 帧合并依赖 `requestAnimationFrame`，在 Node 里不会触发。
 * 所以这里钉「代码里是这么写的」，行为验证要在真机上看流是否还能跑过 30 秒。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const API_RS = strip(read('client/src-tauri/src/st_api.rs'));
const PANEL = strip(read('client/src/chat/chat-panel.ts'));

test('★★★★★ 必须存在两只 client：普通与流式', () => {
  /*
   * 一只 client 无法同时满足两种需求：
   *
   * ```text
   *   普通接口  卡住必须报错          ⇒ 需要总超时
   *   流式生成  要跑几十秒到几分钟     ⇒ 不能有总超时
   * ```
   */
  assert.match(API_RS, /fn build_client_pair/, '要有造这一对的地方');
  assert.match(API_RS, /enum ClientKind/, '要能区分两种用途');
  assert.match(API_RS, /stream_client/, 'Session 里要存流式那只');
});

test('★★★★★ 流式 client 不许带总超时', () => {
  /*
   * `builder.timeout(...)` 是总时限（含读完 body）。流式那只如果也设了，
   * 就退回修之前的行为 —— 长回复照样在 30 秒被掐断。
   *
   * 判据落在**条件分支**上：`None => builder.read_timeout(...)`。
   * 只断言"有 read_timeout"不够 —— 两个都设的话总超时仍然生效。
   */
  assert.match(
    API_RS,
    /None\s*=>\s*builder\.read_timeout/,
    '不设总超时的分支里要有 read_timeout 兜底',
  );
  /*
   * 反向：流式分支里不许出现 `.timeout(`。
   * 取那一段来看，避免误被判成普通 client 的 timeout。
   */
  const at = API_RS.indexOf('None => builder.read_timeout');
  assert.ok(at > 0, '找不到流式分支');
  const branch = API_RS.slice(at, at + 400);
  assert.doesNotMatch(branch, /\.timeout\(/, '流式分支里不许设总超时');
});

test('★★★★★ read_timeout 要留够推理与长回复的余量', () => {
  /*
   * read_timeout 管"两次读到字节之间"的间隔。太小会误伤：
   * 推理模型出第一帧前可能长时间静默，跨洋中转站首字延迟也常见 30–60 秒。
   */
  const m = /const STREAM_READ_TIMEOUT: Duration = Duration::from_secs\((\d+)\)/.exec(API_RS);
  assert.ok(m !== null, '要有这个常量');
  const secs = Number(m[1]);
  assert.ok(secs >= 90, `读超时 ${String(secs)}s 太短：推理模型静默期会超过它`);
});

test('★★★★★ 流式请求必须用 Stream 那只 client', () => {
  /*
   * 造了两只但 `post_stream` 用的是 Plain 的话，等于什么都没改。
   * 这是"改了但没生效"的经典形态，必须单独钉。
   */
  const at = API_RS.indexOf('pub async fn post_stream');
  assert.ok(at > 0, 'post_stream 要存在');
  const body = API_RS.slice(at, at + 1200);
  assert.match(body, /ClientKind::Stream/, 'post_stream 必须传 Stream');
});

test('★★★★ 两只 client 必须共享同一份 cookie jar', () => {
  /*
   * CSRF 令牌与会话 cookie 绑定。各建一份 jar 的话，流式请求会带着
   * **没有对应 cookie 的 token** → 403。而症状是"普通请求正常、
   * 只有流式 403"，最难查的那种。
   */
  assert.match(API_RS, /cookie_provider/, '要用 cookie_provider 注入共享 jar');
  assert.doesNotMatch(API_RS, /cookie_store\(true\)/, '各建一份 jar 会分叉');
  assert.match(API_RS, /Arc::new\(reqwest::cookie::Jar::default\(\)\)/, '要显式建一份 jar');
});

test('★★★★ 读流中断要说清是哪一种，不许只丢底层措辞', () => {
  /*
   * `error decoding response body` 会被用户读成"网络坏了"，而实际成因
   * 常见是超时、上游断流。三种情况要分开说。
   */
  const at = API_RS.indexOf('let bytes = match chunk');
  assert.ok(at > 0, '找不到 chunk 的错误分支');
  const branch = API_RS.slice(at, at + 900);

  assert.match(branch, /is_timeout\(\)/, '要单独判超时');
  assert.match(branch, /received/, '要在文案里带上已收到多少字节');
  assert.match(branch, /log::warn!/, '要留一条日志 —— 原来这个错一条记录都没有');
});

test('★★★★★ 流式渲染必须合并到一帧一次', () => {
  /*
   * 上游每吐一行就 emit 一次，前端每次都重跑全文 markdown + 重建气泡 DOM。
   * 回复越长单帧越贵，主线程被占满 → 滞后 → 一次性追赶（蹦字）。
   */
  assert.match(PANEL, /private scheduleStreamPatch/, '要有合并入口');
  assert.match(PANEL, /requestAnimationFrame/, '要真的合并到帧');
  assert.match(
    PANEL,
    /this\.scheduleStreamPatch\(targetIndex, state\)/,
    'onState 必须走合并，不许直接调 patchStreamingMessage',
  );
  assert.doesNotMatch(
    PANEL,
    /onState:[\s\S]{0,300}?this\.patchStreamingMessage\(/,
    'onState 里不许直接渲染（那正是每帧重绘的来源）',
  );
});

test('★★★★ 收尾前必须把挂起的那一帧画掉', () => {
  /*
   * `done` 可能在下一帧之前到。不主动 flush 的话，屏幕上少最后一段字，
   * 而落盘的是完整内容 —— 看起来像"丢了一截回复"。
   */
  assert.match(PANEL, /private flushStreamPatch/, '要有 flush');
  const at = PANEL.indexOf('await this.handle.done');
  assert.ok(at > 0, '找不到 done 等待点');
  const after = PANEL.slice(at, at + 600);
  assert.match(after, /this\.flushStreamPatch\(\)/, 'done 之后、收尾之前要 flush');
});

test('★★★ 没有 requestAnimationFrame 时要有回退', () => {
  /*
   * Node 测试环境没有 rAF。不回退的话状态永远停在挂起里，一个字都不出。
   */
  const at = PANEL.indexOf('private scheduleStreamPatch');
  const body = PANEL.slice(at, at + 900);
  assert.match(body, /=== undefined/, '要判 rAF 不存在');
  assert.match(body, /this\.flushStreamPatch\(\)/, '不存在时直接画');
});

test('★★★ 文本没变时不许重建 DOM', () => {
  /*
   * 一帧里可能合并多个事件（`reasoning_content` 与 `content` 各一个），
   * 合并后正文可能一个字没变。`innerHTML` 赋值会整棵子树重建 ——
   * 白花的代价是用户选中的文字被清掉。
   *
   * 标记必须挂在 **bubble 元素**上：`render()` 会 `replaceChildren()`
   * 重建列表，那时面板字段还记着旧值，新气泡会被判成"没变"而一直空着。
   */
  assert.match(PANEL, /data-stream-paint/, '要有画过标记');
  const at = PANEL.indexOf('data-stream-paint');
  const around = PANEL.slice(at - 400, at + 400);
  assert.match(around, /bubble\.getAttribute|bubble\.setAttribute/, '标记要挂在气泡上');
});
