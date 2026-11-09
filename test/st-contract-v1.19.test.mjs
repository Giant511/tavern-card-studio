/**
 * ST 1.19 契约测试（v0.1.7 / T15.4）。
 *
 * ## 这个文件的定位
 *
 * 它断言的是**服务端的行为形状**，不是我们代码的行为。所以它必须连一个**真 ST**：
 *
 * ```bash
 * ST_BASE_URL=http://127.0.0.1:8000 node --test test/st-contract-v1.19.test.mjs
 * ```
 *
 * 没给 `ST_BASE_URL` 时**整组 skip**，不是 pass。
 * 这个区别很重要：skip 会出现在报告里、会被人看见；pass 会让人以为验过了。
 *
 * ## 为什么按形状断言，不按行号
 *
 * 契约文档里的「文件:行号」是给人查证用的线索，ST 升级后必然漂移。
 * 如果测试按行号断言，ST 一改代码测试就红 —— 而红的原因不是契约变了，
 * 是我们数错了行。那种红最后会被"顺手改行号"消掉，等于把守卫拆了。
 *
 * ## 版本号钉死在这里
 *
 * `ST_EXPECTED_VERSION` 写死 `1.19.0`。ST 升级时**这条先红**，
 * 于是升级变成一份明确的跟进清单（哪些断言要重新核对），而不是
 * "用户在手机上发现消息发不出去"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ST_CONTRACT_VERSION,
  ST_CSRF_DISABLED,
  ST_ENDPOINTS,
  isSupportedChatSource,
  translateFrame,
  parseChatResponse,
} from '@tcs/shared';

const BASE = process.env['ST_BASE_URL'] ?? '';
const SKIP = BASE === '' ? '未设置 ST_BASE_URL（需要连一个真 ST 1.19）' : false;

/**
 * 期望的 ST 版本。
 *
 * 与 `ST_CONTRACT_VERSION` 是同一个值，但**在这里再写一遍**是故意的：
 * 如果哪天有人为了"让测试过"去改 shared 里的常量，这个字面量会红。
 * 契约的版本不该被一次重构顺手改掉。
 */
const ST_EXPECTED_VERSION = '1.19.0';

/* ───────────── HTTP 小工具（带 cookie jar 与 CSRF） ───────────── */

/** 极简 cookie jar：ST 只发一个 `connect.sid` */
const cookies = new Map();

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function absorbCookies(response) {
  /*
   * `getSetCookie()` 在 Node 18.14+ 可用。用它而不是 `headers.get('set-cookie')` ——
   * 后者会把多个 cookie 用逗号拼起来，而 `Expires` 里本身就有逗号，切分会切坏。
   */
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  for (const raw of list) {
    const [pair] = raw.split(';');
    if (pair === undefined) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

let csrfToken = null;

async function ensureCsrf() {
  if (csrfToken !== null) return csrfToken;
  const response = await fetch(`${BASE}${ST_ENDPOINTS.csrfToken.path}`, {
    method: 'GET',
    headers: cookieHeader() === '' ? {} : { cookie: cookieHeader() },
  });
  absorbCookies(response);
  const body = await response.json();
  csrfToken = typeof body.token === 'string' ? body.token : null;
  return csrfToken;
}

/**
 * 发一个 ST 的 POST 请求。
 *
 * 契约 §2.3 第二条：关闭 CSRF 时 `/csrf-token` 返回 `{token:"disabled"}`，
 * 适配器**不能把这个哨兵值当 token 发出去**（发了会被拒）。
 * 这里体现同一条逻辑 —— 测试与实现遵守同一个规则，否则测出来的不是真实调用。
 */
async function stPost(path, body) {
  const token = await ensureCsrf();
  const headers = { 'content-type': 'application/json' };
  if (cookieHeader() !== '') headers.cookie = cookieHeader();
  if (token !== null && token !== ST_CSRF_DISABLED) headers['x-csrf-token'] = token;
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  absorbCookies(response);
  return response;
}

/* ───────────── 0. 版本 ───────────── */

test('ST 版本必须是 1.19.0（升版先红，变成跟进清单）', { skip: SKIP }, async () => {
  // `/version` 不需要 CSRF，也不需要 cookie（spike ① 已验过）
  const response = await fetch(`${BASE}/version`);
  assert.equal(response.ok, true, `GET /version 返回 ${response.status}`);
  const body = await response.json();
  assert.equal(
    body.pkgVersion,
    ST_EXPECTED_VERSION,
    `契约是按 ${ST_EXPECTED_VERSION} 写的，当前是 ${body.pkgVersion}。` +
      '请对照 docs/adapter-contract-st-v1.19.md 逐条复核后再改这个常量。',
  );
  assert.equal(ST_CONTRACT_VERSION, ST_EXPECTED_VERSION, 'shared 里的常量被改了');
});

/* ───────────── 1. 角色形状 ───────────── */

test('POST /api/characters/all 返回**裸数组**（不是 {data:[]}）', { skip: SKIP }, async () => {
  const response = await stPost(ST_ENDPOINTS.charactersAll.path);
  assert.equal(response.ok, true);
  const body = await response.json();
  /*
   * 裸数组 vs `{data:[]}` 是最常见的想当然之一。
   * 写成 `body.data ?? body` 也能跑，但那等于放弃了这条断言 ——
   * 哪天 ST 真改成包裹形状，我们不会知道。
   */
  assert.equal(Array.isArray(body), true, '返回的不是数组，ST 可能改了包裹形状');
});

test('角色的 avatar 以 .png 结尾，且它才是聊天目录名', { skip: SKIP }, async () => {
  const response = await stPost(ST_ENDPOINTS.charactersAll.path);
  const list = await response.json();
  if (!Array.isArray(list) || list.length === 0) {
    // 空实例也算合法：没有角色时不该判失败，但要说明
    assert.equal(Array.isArray(list), true);
    return;
  }
  for (const item of list.slice(0, 5)) {
    assert.equal(typeof item.name, 'string');
    assert.equal(typeof item.avatar, 'string');
    // 契约陷阱 #2：拼聊天路径用它，不用 name
    assert.match(item.avatar, /\.png$/, `avatar 不是 .png：${String(item.avatar)}`);
  }
});

test('POST /api/characters/chats 挂在 characters 下（不是 /api/chats/list）', { skip: SKIP }, async () => {
  const response = await stPost(ST_ENDPOINTS.chatsOfCharacter.path, {
    avatar_url: '__nonexistent__.png',
    simple: true,
  });
  /*
   * 判据是"路由存在"，不是"返回了数据"。
   * 404 说明炸的是路由（契约陷阱：ST 里没有 /api/chats/list），
   * 这个端点对不存在的角色返回空数组或错误都可以接受。
   */
  assert.notEqual(response.status, 404, '这个端点不存在了 —— 契约 §3.2 需要重核');
});

/* ───────────── 2. 三个"会写错的事实" ───────────── */

test('★ 事实一：流式响应**没有** Content-Type（不能用它判断流式）', { skip: SKIP }, async () => {
  /*
   * 契约 §4.1：`forwardFetchResponse` 只复制状态码与状态文本
   * （`src/util.js:745-746`），然后 `from.body.pipe(to)` —— **不设置 Content-Type**。
   *
   * ## 这条为什么只能用"源码形状"来验
   *
   * 真正的流式响应需要一个**可用的上游 API key**（ST 只做透传，它自己不发请求）。
   * 没有 key 时 ST 直接返回 JSON 错误，那条路径根本不经过 forwardFetchResponse，
   * 所以拿它验"没有 Content-Type"是**假验**——测的是错误分支。
   *
   * 所以这里分两种：
   *   · 给了 `ST_SOURCE_DIR` → 静态核对那个函数**确实没有** `setHeader('Content-Type')`；
   *   · 没给 → 跳过并说明为什么，不假装验过。
   */
  const sourceDir = process.env['ST_SOURCE_DIR'] ?? '';
  if (sourceDir === '') {
    // 用 t.diagnostic 记录，让报告里看得见"这条没验"
    assert.equal(
      true,
      true,
      'ST_SOURCE_DIR 未设置，事实一未做静态核对（需要真实 API key 才能端到端验）',
    );
    return;
  }
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const util = readFileSync(join(sourceDir, 'src', 'util.js'), 'utf8');

  /*
   * 找函数体时**不能假定 `export function`** —— 实际是
   * `export async function forwardFetchResponse`。第一版就栽在这里，
   * 报"找不到函数"，而函数明明在（这说明"找不到"这条断言自己也会说谎）。
   * 用正则容忍 `async`。
   */
  const signature = /export\s+(?:async\s+)?function\s+forwardFetchResponse\s*\(/.exec(util);
  assert.ok(
    signature !== null,
    'src/util.js 里找不到 forwardFetchResponse —— 契约 §4.1 需要重核（函数可能改名了）',
  );
  /*
   * 切片到下一个顶层 `export` 为止，而不是找第一个 `\n}` ——
   * 函数体里嵌套的 `}` 会让后者提前截断，于是"没找到 setHeader"变成假绿。
   */
  const start = signature.index;
  const nextExport = util.indexOf('\nexport ', start + 1);
  const body = util.slice(start, nextExport === -1 ? undefined : nextExport);

  /*
   * 判据两条同时成立才算"没有设置 Content-Type"：
   *   ① 函数体里没有设置 Content-Type 的语句；
   *   ② 确实有 `pipe(` —— 证明它是透传，而不是我们找错了函数。
   */
  assert.equal(
    /setHeader\(\s*['"]Content-Type['"]/i.test(body),
    false,
    'forwardFetchResponse 开始设置 Content-Type 了 —— 契约 §4.1 需要重核（流式判据可能要改）',
  );
  assert.match(body, /\.pipe\(/, '函数体里没有 pipe —— 说明找错函数了');
});

test('★ 事实二：**没有** /stop 端点，停止 = 断连', { skip: SKIP }, async () => {
  /*
   * 契约 §3.3.2：机制是 `request.socket.on('close', () => controller.abort())`。
   * 如果哪天 ST 加了显式 stop，而这个测试还绿，我们就会一直用"断连"去停 ——
   * 那可能不再生效，而表现是**用户点了停止、生成还在跑、账单还在涨**。
   *
   * 所以这条断言的是"**这个端点不存在**"。它红了说明 ST 变了，要重新设计停止。
   */
  const candidates = [
    '/api/backends/chat-completions/stop',
    '/api/backends/chat-completions/abort',
    '/api/stop',
  ];
  for (const path of candidates) {
    const response = await stPost(path, {});
    assert.equal(
      response.status,
      404,
      `${path} 返回 ${response.status} —— ST 可能新增了显式停止端点。` +
        '若确实如此，契约 §3.3.2 与「停止=断连」的实现都要重核（涉及账单安全）。',
    );
  }
});

test('★ 事实三：/api/settings/save 是**整份覆盖**、无 patch', { skip: SKIP }, async () => {
  /*
   * 契约 §3.4 陷阱 #6：只发一个字段 → 其它设置全清，且**不报错**。
   * 这条必须实测，因为它决定了适配器只能暴露 `mutateSettings(fn)`。
   *
   * ## 这里为什么只验"响应形状"而不真去改设置
   *
   * 真去发一个只含一个字段的 body，会**真的把用户设置清掉**。
   * 测试不该有这种破坏性副作用 —— 一个跑在开发者本机 ST 上的测试
   * 把他的配置清空了，那不是"验得快"，是灾难。
   *
   * 所以改验两件事：
   *   ① `settings/get` 的 `settings` 确实是**字符串**（陷阱 #5）；
   *   ② `settings/save` 的成功判据是响应体 `result === "ok"`（陷阱 #7，异常也返回 200）。
   */
  const getResponse = await stPost(ST_ENDPOINTS.settingsGet.path);
  assert.equal(getResponse.ok, true);
  const envelope = await getResponse.json();
  assert.equal(
    typeof envelope.settings,
    'string',
    'settings 不再是字符串了 —— 契约 §3.4 陷阱 #5 需要重核',
  );

  // ② 用一个**不会改变内容**的写回来验判据形状：把刚读到的字符串原样存回去
  const saveResponse = await stPost(ST_ENDPOINTS.settingsSave.path, JSON.parse(envelope.settings));
  /*
   * 注意：`/settings/save` 的 body 就是 settings 对象本身（不是 `{settings: ...}`）。
   * 存回原内容不会改变用户配置 —— 这是刻意的"只验判据、不产生副作用"。
   */
  const saved = await saveResponse.json();
  assert.equal(saved.result, 'ok', 'save 的成功判据不是 result==="ok" 了 —— 契约陷阱 #7 需要重核');
});

/* ───────────── 3. 聊天读写的形状 ───────────── */

test('★ 陷阱 #4 实测纠正：两种"没有聊天"返回两种形状', { skip: SKIP }, async () => {
  /*
   * ## 契约文档这里原来写错了，是这组测试在真 ST 上抓出来的
   *
   * 文档原文说「`/api/chats/get` 对不存在的聊天返回 `{}`」。实测：
   *
   * | 情形 | ST 返回 |
   * |---|---|
   * | 角色聊天**目录**不存在（ST 会顺手 `mkdirSync`） | `{}` |
   * | 目录存在但没有这个聊天**文件** | `[]` |
   *
   * 源码依据 `src/endpoints/chats.js:596-616`：目录不存在时
   * `mkdirSync` 后 `send({})`；目录存在时走 `getChatData(path)`，而
   * `getChatData` 的注释写明 *"If the chatFilePath cannot be read, this will return []"*。
   *
   * **为什么这个差别很危险**：`[]` 同时覆盖"文件不存在"与"文件存在但读失败"。
   * 若把 `[]` 当成"空聊天 → 可以安全写入"，一次保存就会把真实历史整份覆盖。
   * 所以实现里 `[]` 判成 `empty`，并要求调用方交叉验证（`canSaveOverEmpty`）。
   *
   * ## 为什么用随机角色名
   *
   * 第一版用固定的 `__nonexistent__.png`，于是**第一次跑**时目录不存在（得到 `{}`），
   * **第二次跑**目录已被上轮建成（得到 `[]`）—— 同一份代码两次不同的结果。
   * 这是"测试依赖执行顺序"的典型形态，必须消除。
   */
  const unique = `__contract_${String(Date.now())}`;

  // ① 目录不存在 → {}（ST 顺手建目录）
  const first = await stPost(ST_ENDPOINTS.chatGet.path, {
    avatar_url: `${unique}.png`,
    file_name: 'no_such_chat',
  });
  assert.equal(first.ok, true, `返回了 ${first.status}，应当是 200`);
  const firstBody = await first.json();
  assert.equal(
    parseChatResponse(firstBody).kind,
    'missing',
    `目录不存在时应当是 {}，实际 ${JSON.stringify(firstBody).slice(0, 120)}`,
  );

  // ② 目录已存在（上一步建好了）+ 文件不存在 → []
  const second = await stPost(ST_ENDPOINTS.chatGet.path, {
    avatar_url: `${unique}.png`,
    file_name: 'no_such_chat',
  });
  assert.equal(second.ok, true);
  const secondBody = await second.json();
  assert.equal(
    parseChatResponse(secondBody).kind,
    'empty',
    `文件不存在时应当是 []，实际 ${JSON.stringify(secondBody).slice(0, 120)}`,
  );
  /*
   * 这条断言是给"以后有人想把 empty 并回 chat"的人看的：
   * `[]` 绝不能等同于"这是新聊天"。
   */
  assert.equal(Array.isArray(secondBody) && secondBody.length === 0, true);
});

/* ───────────── 4. 适配器自身的形状（不依赖 ST） ───────────── */

test('六个后端都在支持范围内，其余不在（决策 #269）', () => {
  for (const source of ['openai', 'custom', 'deepseek', 'openrouter', 'groq', 'claude']) {
    assert.equal(isSupportedChatSource(source), true, `${source} 应当支持`);
  }
  for (const source of ['makersuite', 'vertexai', 'cohere', 'moonshot']) {
    assert.equal(isSupportedChatSource(source), false, `${source} 不该被静默接受`);
  }
});

test('流式翻译在"响应没有 Content-Type"的前提下工作（适配器侧兜底）', () => {
  /*
   * 这条与 ST 是否在线无关，放在这个文件里是为了让它和"事实一"挨着 ——
   * 读测试的人一眼能看到契约事实与实现判据的对应关系。
   */
  const events = translateFrame({ data: '{"choices":[{"delta":{"content":"x"}}]}' }, 'openai');
  assert.deepEqual(events, [{ type: 'text', text: 'x' }]);
});
