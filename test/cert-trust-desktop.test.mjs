/**
 * 「自签证书被拒」的修复判据（2026-11-17）。
 *
 * ## 要修的三件事（memory §105 记着的三个独立缺陷）
 *
 * ```text
 * ① 归因错误   —— 证书失败被说成「地址不通、端口未开、或服务端未启动」
 *                 用户被指向一件没坏的事（去查端口）
 * ② 没有出口   —— 自签证书本来「确认风险后可以继续」，但界面上没这个选项
 * ③ UI 自相矛盾 —— 探测红字「无法连接」与「同步已就绪」同屏互斥
 * ```
 *
 * ## 这个文件测什么
 *
 * 全是**纯逻辑**：传输层分派、错误归因、origin 白名单、门禁三态。
 * 不启动 Tauri 壳、不连网 —— 那套留给人真机验（判据只保证逻辑对）。
 *
 * ★ 有一件事这里**测不了**：Rust 侧的两段探测是否真的能区分
 *   "证书问题"与"连不上"。那需要真起一个自签 https 服务端。
 *   已用 `openssl` + 本地 https 服务单独验过（见提交说明）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createFetchTransport,
  defaultTransport,
  isOriginCertAcked,
  isTauriRuntime,
  normalizeOrigin,
  registerNativeTransport,
  resetTransportRegistry,
  withCertAckedOrigin,
} from '../client/src/net/http-transport.ts';
import { probeServer } from '../client/src/net/server-probe.ts';
import { resolveSyncGate, syncGateMessage, syncHintText } from '../client/src/auth/entry-policy.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ═══════════════════════════════════════════════════════════
   一、传输层分派（漏注册必须炸，不能静默降级）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 浏览器环境默认用 fetch', () => {
  resetTransportRegistry();
  /* Node 里没有 window，`isTauriRuntime()` 为 false ⇒ 走 fetch */
  assert.equal(isTauriRuntime(), false);
  const transport = defaultTransport();
  assert.equal(typeof transport, 'function');
});

test('★★★★★ 注册过原生通道就优先用它', async () => {
  resetTransportRegistry();
  let called = 0;
  registerNativeTransport(() => async () => {
    called += 1;
    return {
      status: 200,
      contentType: 'application/json',
      text: '{"ok":true}',
      base64: null,
      elapsedMs: 1,
      errorKind: null,
      error: null,
    };
  });
  const transport = defaultTransport();
  const outcome = await transport({ url: 'https://example.test/api/health', timeoutMs: 1000 });
  assert.equal(called, 1, '应当调用已注册的那个');
  assert.equal(outcome.status, 200);
  resetTransportRegistry();
});

test('★★★★★ 壳里但没注册 → 抛错，绝不悄悄退回 fetch', () => {
  /*
   * 这条是这次修复的**防退化**判据。
   *
   * 如果漏注册时悄悄用 fetch，后果正是这个 bug 的原状：自签证书连不上，
   * 而界面说"端口没开"。那种缺陷只在桌面端 + 自签证书时出现，
   * 端到端测试（跑在 Chrome 里）永远测不到。
   *
   * 所以宁可抛错 —— 当场看得见。
   */
  resetTransportRegistry();
  const original = globalThis.window;
  /* 伪造 Tauri 运行时标记 */
  globalThis.window = { __TAURI_INTERNALS__: {} };
  try {
    assert.equal(isTauriRuntime(), true);
    assert.throws(() => defaultTransport(), /没有注册原生 HTTP 通道/, '必须抛错');
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
    resetTransportRegistry();
  }
});

test('★★★★ 桌面入口真的 import 了注册模块（否则上面那条会炸在运行时）', () => {
  /*
   * 注册是**副作用**，只能靠 import 触发。少这一行不会报编译错误，
   * 而是第一次探测时抛"没有注册原生 HTTP 通道" —— 用户看到的是
   * 一句开发者才知道怎么处理的话。所以这里钉住入口确实带进来了。
   */
  const app = stripComments(read('client/src/editor/app.ts'));
  assert.match(app, /import '\.\.\/net\/http-native'/, '入口必须 import 注册模块');
});

/* ═══════════════════════════════════════════════════════════
   二、错误归因（证书 vs 连不上）
   ═══════════════════════════════════════════════════════════ */

/** 造一个假 transport，只回一个固定结果 */
function stubTransport(outcome) {
  return async () => outcome;
}

const FAIL_CERT = {
  status: null,
  contentType: '',
  text: null,
  base64: null,
  elapsedMs: 8,
  errorKind: 'cert',
  error: '这个服务器的证书没通过系统校验（多半是自签证书）。',
};

test('★★★★★ 证书失败要单独一个 stage，且标出 certUntrusted', async () => {
  /*
   * memory §105 缺陷 ①：原来任何 TypeError 都翻成
   * 「地址不通、端口未开、或服务端未启动」。而实测那是自签证书。
   *
   * 现在 `stage === 'cert'` + `certUntrusted === true` —— 界面据此
   * 才敢给出"确认风险后继续"的出口。
   */
  const result = await probeServer(
    { serverUrl: 'https://10.9.0.2:8443', token: '' },
    { transport: stubTransport(FAIL_CERT) },
  );
  assert.equal(result.reachable, false);
  assert.equal(result.stage, 'cert', '证书问题必须是独立阶段');
  assert.equal(result.certUntrusted, true);
  assert.match(result.message, /证书/, '文案要说证书');
  assert.doesNotMatch(result.message, /端口未开/, '不许再说端口');
});

test('★★★★★ 连不上时不许提证书（不许瞎猜）', async () => {
  /*
   * 反向判据：只有 Rust 侧第二段探测证实过才叫 `cert`。
   * 如果连不上也报证书，用户会去装证书 —— 那是白费功夫。
   */
  const result = await probeServer(
    { serverUrl: 'https://10.9.0.2:8443', token: '' },
    {
      transport: stubTransport({
        status: null,
        contentType: '',
        text: null,
        base64: null,
        elapsedMs: 8,
        errorKind: 'connect',
        error: '无法连接（地址不通、端口未开、或服务端未启动）',
      }),
    },
  );
  assert.equal(result.stage, 'health');
  assert.equal(result.certUntrusted, false, '没证实过就不许标');
  assert.match(result.message, /无法连接/);
});

test('★★★★ 超时要报超时，不说证书也不说端口', async () => {
  const result = await probeServer(
    { serverUrl: 'https://10.9.0.2:8443', token: '' },
    {
      transport: stubTransport({
        status: null,
        contentType: '',
        text: null,
        base64: null,
        elapsedMs: 6000,
        errorKind: 'timeout',
        error: '请求超时（6000 ms）',
      }),
    },
  );
  assert.equal(result.certUntrusted, false);
  assert.match(result.message, /超时/);
});

test('★★★★ 确认过证书风险的地址：第一次请求就带 allowInvalidCert', async () => {
  /*
   * 不带的话每次探测都要先失败一次：界面先闪一下红字"连不上"再变绿，
   * 而且 Rust 侧要跑两段探测（多一次请求）。
   *
   * 这条钉的是"参数真的传下去了"—— 用假 transport 记下收到的入参。
   */
  const seen = [];
  const transport = async (spec) => {
    seen.push(spec);
    return {
      status: 200,
      contentType: 'application/json',
      text: '{"status":"ok","version":"0.2.0","authRequired":false}',
      base64: null,
      elapsedMs: 5,
      errorKind: null,
      error: null,
    };
  };
  const result = await probeServer(
    { serverUrl: 'https://10.9.0.2:8443', token: '', allowInvalidCert: true },
    { transport },
  );
  assert.equal(result.reachable, true, '带上之后应当直接连通');
  assert.equal(seen.length, 1, '只该请求一次');
  assert.equal(seen[0].allowInvalidCert, true, '必须把 allowInvalidCert 传下去');
});

test('★★★ 没确认过的地址不许带 allowInvalidCert（默认安全）', async () => {
  const seen = [];
  await probeServer(
    { serverUrl: 'https://10.9.0.2:8443', token: '' },
    {
      transport: async (spec) => {
        seen.push(spec);
        return { ...FAIL_CERT };
      },
    },
  );
  assert.equal(seen[0].allowInvalidCert, undefined, '默认不许放宽');
});

/* ═══════════════════════════════════════════════════════════
   三、origin 白名单
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 按 origin 记，不按完整 URL（否则同一台机器要确认两次）', () => {
  /*
   * 证书是按**主机**签发的。存完整 URL 的话
   * `https://h:8443/api/health` 与 `https://h:8443/api/stats`
   * 会被当成两个不同的东西，用户要确认两次 —— 而这是同一台服务器。
   */
  const acked = withCertAckedOrigin([], 'https://10.9.0.2:8443/api/health');
  assert.deepEqual(acked, ['https://10.9.0.2:8443'], '存的是 origin');

  assert.equal(isOriginCertAcked(acked, 'https://10.9.0.2:8443/api/stats'), true, '同 origin 的别的路径也算');
  assert.equal(isOriginCertAcked(acked, 'https://10.9.0.2:8443'), true, '不带路径也算');
});

test('★★★★★ 不同端口 / 不同主机 / 不同协议都不算（不许外溢）', () => {
  const acked = ['https://10.9.0.2:8443'];
  assert.equal(isOriginCertAcked(acked, 'https://10.9.0.2:9443'), false, '换端口是另一个 origin');
  assert.equal(isOriginCertAcked(acked, 'https://10.9.0.3:8443'), false, '换主机不算');
  assert.equal(isOriginCertAcked(acked, 'http://10.9.0.2:8443'), false, 'http 与 https 是两个 origin');
});

test('★★★★ 重复确认不叠项，非法地址不入表', () => {
  let acked = withCertAckedOrigin([], 'https://h:8443/a');
  acked = withCertAckedOrigin(acked, 'https://h:8443/b');
  assert.deepEqual(acked, ['https://h:8443'], '同 origin 只留一项');

  const bad = withCertAckedOrigin(['https://h:8443'], '这不是地址');
  assert.deepEqual(bad, ['https://h:8443'], '非法地址不许入表');
  /*
   * ★ 非法地址取 origin 是空串，而空串**永远不匹配** ——
   * 否则"地址写错了"会被当成"已确认过"，那就把证书校验永久关掉了。
   */
  assert.equal(isOriginCertAcked([''], ''), false, '空 origin 不许匹配空 origin');
});

test('★★★★ 归一化：大小写与末尾斜杠不影响匹配', () => {
  assert.equal(normalizeOrigin('HTTPS://Host.EXAMPLE:8443/'), 'https://host.example:8443');
  assert.equal(isOriginCertAcked(['https://host.example:8443'], 'HTTPS://HOST.EXAMPLE:8443/x'), true);
});

/* ═══════════════════════════════════════════════════════════
   四、门禁三态（UI 自相矛盾的修复）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 探测明确失败 → 门禁 unreachable（不再说"已就绪"）', () => {
  /*
   * memory §105 缺陷 ②：`resolveSyncGate` 原来完全不看探测结果，
   * 于是红字「无法连接」与绿字「同步已就绪」同屏 —— 用户不知道该信哪个。
   */
  assert.equal(resolveSyncGate('https://h:8443', true, { reachable: false }), 'unreachable');
  /* 没凭证也一样：连不上是更靠前的事实 */
  assert.equal(resolveSyncGate('https://h:8443', false, { reachable: false }), 'unreachable');
});

test('★★★★★ 还没探测过（null）→ 仍按凭证判（不许说"连不上"）', () => {
  /*
   * 这条是"另一半"：2026-11-02 那条注释担心的是"刚打开客户端、
   * 探测还没回来那几百毫秒里面板说未连接"。所以 `null` 必须**不参与**判定。
   * 只有"测过、且失败"才算 unreachable。
   */
  assert.equal(resolveSyncGate('https://h:8443', true, null), 'ready');
  assert.equal(resolveSyncGate('https://h:8443', false, null), 'need-login');
  assert.equal(resolveSyncGate('https://h:8443', true, undefined), 'ready');
});

test('★★★★★ 探测成功 → 回到按凭证判', () => {
  assert.equal(resolveSyncGate('https://h:8443', true, { reachable: true }), 'ready');
  assert.equal(resolveSyncGate('https://h:8443', false, { reachable: true }), 'need-login');
});

test('★★★★ unreachable 的文案不能再出现"已就绪"', () => {
  const message = syncGateMessage('unreachable');
  assert.match(message, /连不上服务端/);
  assert.doesNotMatch(message, /已就绪/, '面板整句不许说已就绪');

  const hint = syncHintText('unreachable', null);
  assert.doesNotMatch(hint.text, /已就绪/, '顶栏短提示也不许说已就绪');
  assert.equal(hint.tone, 'warn', '这是要提醒的状态，不是 ok');
  /* 但要说清"本地功能不受影响"—— 否则用户会以为整个客户端废了 */
  assert.match(hint.text, /本地功能不受影响/);
});

/* ═══════════════════════════════════════════════════════════
   五、Rust 侧形状与安全边界（读源码，跑不了那段只有壳里能用）
   ═══════════════════════════════════════════════════════════ */

const RUST = stripComments(read('client/src-tauri/src/server_http.rs'));

test('★★★★★ 证书判定用两段探测，不用文案匹配', () => {
  /*
   * ★ 这是整个修复最关键的一条实现约束。
   *
   * Windows 走 schannel，底层错误是**系统消息**：中文系统上
   * "无法建立到信任根颁发机构的证书链"，英文系统上是另一句。
   * 按关键词匹配必然漏，而漏判的后果就是 bug 原状。
   *
   * 所以判据是：正常失败后**再请求一次跳过校验**，成功即证明是证书问题。
   */
  assert.match(RUST, /danger_accept_invalid_certs\(true\)/, '必须真的能跳过校验');
  assert.match(RUST, /match send_once\(&request, true\)/, '第二段要重新发一次');
  assert.match(RUST, /kind: "cert"/, '第二段成功才报 cert');
  /* 不许出现"按文案猜证书"的痕迹 */
  assert.doesNotMatch(RUST, /message\.contains\("certificate"\)/, '不许按英文关键词猜');
  assert.doesNotMatch(RUST, /to_lowercase\(\)\.contains\("证书"\)/, '不许按中文关键词猜');
});

test('★★★★★ 第二段成功不直接返回（用户没确认过，不能偷偷放宽）', () => {
  /*
   * 第二段只用来**定性**。如果它成功就把响应交回去，等于用户没确认
   * 就已经在用一条不校验证书的通道传令牌和卡片 —— 那是安全问题，
   * 不是体验问题。
   */
  const second = RUST.slice(RUST.indexOf('match send_once(&request, true)'));
  assert.match(second.slice(0, 400), /Ok\(_\)/, '成功分支必须丢弃响应（下划线）');
});

test('★★★★ 只放行 http/https，且响应体有上限', () => {
  /* 通用 HTTP 客户端能被渲染层调用 ⇒ 至少挡住 file:// 这类本地读取 */
  assert.match(RUST, /starts_with\("http:\/\/"\)/, '放行 http');
  assert.match(RUST, /starts_with\("https:\/\/"\)/, '放行 https');
  assert.match(RUST, /MAX_BODY_BYTES/, '响应体必须有上限');
  assert.match(RUST, /redirect\(reqwest::redirect::Policy::none\(\)\)/, '不跟随重定向（与 st_api 同一纪律）');
});

test('★★★★ TLS 只在桌面目标启用（Android 不能拉 OpenSSL）', () => {
  /*
   * `rustls-tls` 曾经因为 `ring` 需要 NDK clang 编译 C 而失败（见
   * Cargo.toml 的注释）。`native-tls` 在 Android 上同样会去找 OpenSSL。
   *
   * 所以必须按目标分流：非 Android 才加 native-tls。
   * 这条判据防止有人"顺手"把它挪回 [dependencies] —— 那会让 APK 打不出来，
   * 而报错在链接阶段，与"证书"八竿子打不着。
   */
  const cargo = read('client/src-tauri/Cargo.toml');
  /*
   * ★ 先按**行**过滤掉注释再断言（第一版直接切字符串，把注释里
   *   "默认带 native-tls / system-proxy 等" 那句散文当成了依赖声明 ——
   *   判据自己假红了）。这是本项目反复强调的一条：判源码必须先去注释。
   */
  const code = cargo
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

  assert.match(
    code,
    /\[target\.'cfg\(not\(target_os = "android"\)\)'\.dependencies\]/,
    '必须有目标分段',
  );
  const sectionAt = code.indexOf("[target.'cfg(not(target_os = \"android\"))'.dependencies]");
  const base = code.slice(0, sectionAt);
  const baseReqwest = base.slice(base.lastIndexOf('reqwest = {'));
  assert.doesNotMatch(baseReqwest, /native-tls/, '基础依赖里不许带 native-tls');
  const scoped = code.slice(sectionAt);
  assert.match(scoped, /native-tls/, '非 Android 分段里必须有 native-tls');
});

test('★★★★ 契约错误码与 kind 一致（两侧对齐）', () => {
  const errors = read('client/src/contract/errors.ts');
  assert.match(errors, /'NET_REQUEST_FAILED'/, '要有这个错误码');
  const native = read('client/src/net/http-native.ts');
  for (const kind of ['cert', 'connect', 'timeout', 'other']) {
    assert.match(native, new RegExp(`'${kind}'`), `kind 里要有 ${kind}`);
  }
  /* Rust 侧抛的 kind 字符串必须与 TS 认的一致 */
  for (const kind of ['cert', 'connect', 'timeout', 'other']) {
    assert.match(RUST, new RegExp(`"${kind}"`), `Rust 侧也要产出 ${kind}`);
  }
});

/* ═══════════════════════════════════════════════════════════
   六、fetch 传输层（浏览器端）行为不变
   ═══════════════════════════════════════════════════════════ */

test('★★★★ fetch 传输层：成功返回文本，失败归 connect，超时归 timeout', async () => {
  const ok = createFetchTransport(async () => new Response('{"a":1}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  const good = await ok({ url: 'https://h/api/health', timeoutMs: 1000 });
  assert.equal(good.status, 200);
  assert.equal(good.text, '{"a":1}');
  assert.equal(good.errorKind, null);

  const bad = createFetchTransport(async () => {
    throw new TypeError('Failed to fetch');
  });
  const failed = await bad({ url: 'https://h/api/health', timeoutMs: 1000 });
  assert.equal(failed.status, null);
  assert.equal(failed.errorKind, 'connect', '浏览器分不清证书与拒连，只能说 connect');

  const timeout = createFetchTransport(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });
  const timedOut = await timeout({ url: 'https://h/api/health', timeoutMs: 10 });
  assert.equal(timedOut.errorKind, 'timeout');
});

test('★★★★ fetch 传输层要容忍最小化的 fetch 桩（缺 headers / arrayBuffer）', async () => {
  /*
   * 本项目有一批测试用手搓的最小对象当 fetch 桩（只有 status/ok/text/json）。
   * 传输层如果直接 `response.headers.get(...)` 就会在桩上抛 TypeError，
   * 而外层 catch 把它归成 `connect` —— 测试报"无法连接"，真因却是
   * "桩少了个字段"。我自己这么红过三条测试。
   *
   * 这条判据钉的就是"按能力探测，不假设"。
   */
  const bare = createFetchTransport(async () => ({
    ok: true,
    status: 200,
    text: async () => '{"status":"ok"}',
    json: async () => ({ status: 'ok' }),
  }));
  const outcome = await bare({ url: 'https://h/api/health', timeoutMs: 1000 });
  assert.equal(outcome.status, 200, '不许因为桩缺 headers 就当成失败');
  assert.equal(outcome.errorKind, null);
  assert.equal(outcome.text, '{"status":"ok"}');
});
