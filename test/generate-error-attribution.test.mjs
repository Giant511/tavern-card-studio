/**
 * 「HTTP 400 {"error":true}」的可归因性 + 未配 key 的可见性（2026-11-07）。
 *
 * ## 用户报的
 *
 * > 测试 deepseek 的官方 api 返回如下错误，怎么解决
 * > `/api/backends/chat-completions/generate 返回 HTTP 400: {"error":true}`
 *
 * ## 真机取证（这次是真的查到了，不是猜）
 *
 * ```text
 *   ① GET https://api.deepseek.com/models  → 200
 *      可用模型：deepseek-v4-pro / deepseek-flash
 *      ⇒ 秘钥本身有效、模型名 deepseek-v4-pro 有效
 *
 *   ② 直连 /chat/completions（非流式 + 流式）→ 均 200，正文正常
 *      ⇒ 上游完全没问题
 *
 *   ③ 设备上 ST 的 secrets.json 里只有：
 *        api_key_openai  1 条
 *        api_key_custom  3 条
 *      **没有 api_key_deepseek**
 *
 *   ④ ST 源码里那条 400 分支：
 *        if (!apiKey && !request.body.reverse_proxy)
 *            → response.status(400).send({ error: true })
 *      注意它**不带 message** —— 与用户看到的 `{"error":true}` 完全一致
 *
 *   ⑤ 通过 App 界面填 key 并保存后，secrets.json 出现 api_key_deepseek
 *      （active=true），同一个 generate 请求立刻 200
 * ```
 *
 * ⇒ 真因：**用户切到了「DeepSeek 官方接口」，但那个源从来没配过 key**。
 *   他给「自定义」源配过（所以 secrets 里有 3 条 custom），
 *   两个源在界面上长得一模一样，切过去没有任何提示。
 *
 * ## 要判别式钉住的三件事
 *
 * ```text
 *   A  那句 400 必须能被翻译成"当前接口还没填 key"（不许原样丢给用户）
 *   B  坏文案不许误伤：带 message 的上游错误要原样保留原因
 *   C  选源时就要看得见"未配 key"（不是展开后才知道）
 * ```
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/*
 * ★ 从 **dist** 导入，不是 `shared/src/.../generate.ts`。
 *
 * `generate.ts` 内部有 `import ... from '../st-adapter/types.js'`
 * （NodeNext 风格，`.js` 后缀指向编译后的文件）。直接从 `.ts` 源码
 * 导入时 Node 会去找 `shared/src/st-adapter/types.js` —— **不存在**，
 * 报 ERR_MODULE_NOT_FOUND。
 *
 * 项目里 `test/api-persist.test.mjs` 早就这么做了（它也测 generate.ts
 * 里的 `buildGenerateRequest`），跟着它的口径走。
 * 代价是跑这条判据前必须先 `npm run build:shared`（`npm test` 已包含）。
 */
import { CHAT_SOURCE_LABELS, explainGenerateError } from '../shared/dist/chat/generate.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

function stripComments(source) {
  return source
    /* CRLF 归一：`$` 前有 `\r` 会让行尾锚点永不匹配 */
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}

/* ═══════════════════════════════════════════════════════════
   A 那句 400 必须可归因
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 400 + 裸 {error:true} 要说清"当前接口没填 key"', () => {
  /*
   * 这是用户实际看到的那一条。原来落到最后兜底，显示
   * `生成失败（400）：{"error":true}` —— 无法归因。
   */
  const msg = explainGenerateError(400, '{"error":true}');

  assert.ok(!msg.includes('{"error":true}'), '不许把原始 JSON 直接丢给用户');
  assert.match(msg, /key/i, '必须点出 key');
  assert.match(msg, /API 连接/, '必须给出下一步去哪（用户版文案里那一页叫「API 连接」）');
  assert.ok(!/失败（400）/.test(msg), '不许再落到通用兜底');
});

test('★★★★ 各种等价的裸 error 写法都要认出来', () => {
  /*
   * ST 的响应会经过 Rust 侧透传，空格与引号可能被规整过。
   * 判据不能只认一种字面。
   */
  const variants = [
    '{"error":true}',
    '{ "error": true }',
    '{"error": true}',
    '\n{"error":true}\n',
  ];
  for (const body of variants) {
    const msg = explainGenerateError(400, body);
    assert.ok(!msg.includes('"error"'), `这种写法没被识别：${JSON.stringify(body)}`);
    assert.match(msg, /key/i, `${JSON.stringify(body)} 应译成"缺 key"`);
  }
});

test('★★★★★ 带 message 的上游错误不许被误伤（原因要原样保留）', () => {
  /*
   * 这条防的是"翻译过头"：如果只查 `includes('error')`，
   * 上游真正的错误原因（模型不存在、参数非法、余额不足）会被
   * 统一吞成"没填 key" —— 那比不翻译更糟（把用户引到错误方向）。
   */
  /*
   * ★ 2026-11-09 修正取样：原来把 `invalid_api_key` 与 `Authentication Fails`
   * 也放在"不该被译成 key 问题"这一组里 —— 那是取样错了。
   *
   * 这两条**确实**是 key 问题（上游在说"这个 key 不行"），把它们归到
   * key 分支是对的。判据真正要防的是：**非 key 的原因**（模型不存在、
   * 余额不足）被吞成"key 有问题"，把用户引到错误方向。
   *
   * key 类的那两条移到下面单独断言（见"key 类错误应给出三种可能"）。
   */
  const realErrors = [
    '{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}',
    '{"error":true,"message":"insufficient balance"}',
    '{"error":{"message":"上下文超长，请减少历史","type":"invalid_request_error"}}',
  ];
  for (const body of realErrors) {
    const msg = explainGenerateError(400, body);
    assert.ok(
      !/没(有)?填|没存进去/.test(msg),
      `这条带了具体原因，不该被译成"没填 key"：${JSON.stringify(body)} → ${msg}`,
    );
    /* 具体原因必须能被用户看到（截断也要保留开头） */
    const firstWord = body.match(/"(message|detail|code)":"([^"]{4,})"/);
    if (firstWord !== null) {
      assert.ok(
        msg.includes(firstWord[2].slice(0, 6)),
        `原因被吞掉了：${JSON.stringify(body)} → ${msg}`,
      );
    }
  }
});

test('★★★★ key 类错误要归到 key 分支，并给出三种可能', () => {
  /*
   * 与上一条互补：上一条防"什么都说是 key 问题"，
   * 这一条防"该说是 key 问题时不敢说"。
   *
   * 用户真机那条原文（中转站返回）：
   *
   * ```text
   *   Key 错误：Key 填错、过期或未设置 Bearer。请检查 Key。
   * ```
   */
  const keyErrors = [
    '{"error":{"code":"","message":"Key 错误：Key 填错、过期或未设置 Bearer。请检查 Key。"}}',
    '{"error":true,"code":"invalid_api_key"}',
    '{"detail":"Authentication Fails"}',
  ];
  for (const body of keyErrors) {
    const msg = explainGenerateError(400, body);
    assert.match(msg, /key/i, `应认成 key 问题：${JSON.stringify(body)} → ${msg}`);
    /* 三种可能都要说到，尤其额度 —— 那是用户最容易漏判的一种 */
    assert.match(msg, /额度/, `必须提额度：${msg}`);
  }
});

test('★★★★ 「排除带原因的错误」必须是一道**独立的早退**', () => {
  /*
   * ★ 变异验证抓到的（2026-11-07）：把最后那行
   *   `return /["']?error["']?\s*:\s*true/.test(inner)`
   *   放宽成 `return /error/.test(text)`，判据**全绿**。
   *
   * 为什么？因为 `isBareErrorTrue` 开头还有一道早退：
   *
   * ```ts
   *   if (/message|detail|code|hint|reason/i.test(inner)) return false;
   * ```
   *
   * 它先挡住了带原因的那些。所以真正的安全网是**那道早退**，不是末尾的匹配。
   * 判据必须钉住它 —— 否则将来有人觉得"这行多余"删掉，
   * 所有上游错误都会被译成"没填 key"，而行为判据（上面那条）只会红一半。
   */
  const src = stripComments(read('shared/src/chat/generate.ts'));
  const at = src.indexOf('function isBareErrorTrue');
  assert.ok(at > 0, '找不到 isBareErrorTrue');

  const body = src.slice(at, src.indexOf('\n}', at));
  assert.match(
    body,
    /if \(\/message\|detail\|code\|hint\|reason\/i\.test\(inner\)\) return false;/,
    '必须有"带原因就返回 false"的独立早退',
  );

  /*
   * 而且末尾的匹配必须是**锚定的那个形状**，不能只查 substring `error`。
   */
  assert.match(
    body,
    /return \/\["']\?error\["']\?\\s\*:\\s\*true\/\.test\(inner\);/,
    '末尾匹配要钉住 error:true 这个形状，不许放宽成裸 error',
  );
});

test('★★★ 其它状态码的既有文案没被这次改动破坏', () => {
  assert.match(explainGenerateError(401, ''), /key/i, '401 仍说 key');
  assert.match(explainGenerateError(403, ''), /重新连接/, '403 仍是重连');
  assert.match(explainGenerateError(429, ''), /频繁|限流/, '429 仍是限流');
  assert.match(explainGenerateError(500, ''), /上游服务出错/, '5xx 仍是上游');
  assert.match(explainGenerateError(502, ''), /502/, '5xx 要带上状态码');
});

test('★★★ 空 body 的 400 不许报成"缺 key"（信息不足时别瞎猜）', () => {
  /*
   * `explainGenerateError(400, '')` 说明调用方没拿到 body ——
   * 那不能断定是缺 key，只能给通用文案。
   */
  const msg = explainGenerateError(400, '');
  assert.ok(!/API 连接/.test(msg), '没有 body 就不该断言是缺 key');
  assert.match(msg, /400/, '至少要说清状态码');
});

/* ═══════════════════════════════════════════════════════════
   B 选源时就要看得见"未配 key"
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 源列表项上要有"未配 key"标记（不是展开后才知道）', () => {
  /*
   * 用户切到 DeepSeek 那一刻界面和配好的源一模一样 —— 他直接发消息，
   * 拿到无法归因的 400。状态必须在**选源的横向比较处**就可见。
   *
   * ★★ 判据要钉**那一行完整的赋值**（2026-11-07 变异验证抓到的）。
   *
   * 第一版写的是 `assert.match(src, /callbacks\.hasKeyFor\?\.\(source\)/)` ——
   * 而同一个文件里**还有另一处**调用它（key 输入框初始化时
   * `initialKeyState(callbacks.hasKeyFor?.(source) ?? false)`）。
   * 把列表项的判定改成 `const keyMissing = false`（等于不显示标记）之后，
   * 判据仍然匹配到那一处，**变异溜过去了**。
   *
   * 这是本日第 9 次"判据取错对象"（匹配范围太宽 / 命中同名调用）。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));
  assert.match(src, /data-role', 'source-key-missing'/, '要有 data-role（探针靠它定位）');
  assert.match(
    src,
    /^[ \t]*const keyMissing = callbacks\.hasKeyFor\?\.\(source\) !== true;$/m,
    '列表项的"未配 key"判定必须是这一整行（不能只看有没有调用过 hasKeyFor）',
  );
  assert.match(src, /未配 key/, '文案要直白');
});

test('★★★★ 标记要挂在**列表项**上，不是面板里', () => {
  /*
   * 挂面板里就得先展开才看得见 —— 用户选源时是横向比一眼，
   * 不会逐个展开。
   *
   * 判据：`main`（= nb-listitem-main，列表项的主文本容器）里要 append 它。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));
  const at = src.indexOf("badge.setAttribute('data-role', 'source-key-missing')");
  assert.ok(at > 0, '找不到标记创建');
  const after = src.slice(at, at + 300);
  assert.match(after, /main\.append\(badge\)/, '必须 append 到 main（列表项主区）');
});

test('★★★ 标记的样式在（不然是一串没上色的裸文字）', () => {
  const css = read('client/src/chat/chat.css');
  assert.match(css, /\.nb-src-badge \{/, '要有 .nb-src-badge 样式');

  /*
   * ★ 检查块内容前**必须先剥注释**（本日第三次栽在这上面）。
   *
   * 我在那条规则的注释里特意写了"不许用 `color-mix()`"来解释原因 ——
   * 而判据直接扫原文，于是**命中了自己的解释文字**，误判成违规。
   *
   * 规则：凡"某段里不许出现 X"的判据，都要先 stripComments。
   */
  const clean = stripComments(css);
  const at = clean.indexOf('.nb-src-badge {');
  assert.ok(at > 0, '剥注释后找不到 .nb-src-badge 规则');
  const block = clean.slice(at, clean.indexOf('}', at));
  assert.ok(
    !/color-mix\(/.test(block),
    '不许用 color-mix（Chrome 87 会整条规则失效）',
  );
});

/* ═══════════════════════════════════════════════════════════
   C 示例模型名要指向"你以为的那个模型"
   ═══════════════════════════════════════════════════════════ */

test('★★★★ DeepSeek 的示例模型名要是正式名称（不是兼容别名）', () => {
  /*
   * 实测：`deepseek-chat` 仍可用，但服务端把它别名到 **deepseek-flash**
   * （响应里 model 字段就是 deepseek-flash）。用户以为在用旗舰，
   * 实际跑在轻量模型上 —— 示例值做不到"你以为的那个"就没意义。
   *
   * 官方 `/models` 返回的正式名称：deepseek-v4-pro / deepseek-flash。
   */
  const ph = CHAT_SOURCE_LABELS.deepseek.modelPlaceholder;
  assert.ok(
    ph === 'deepseek-v4-pro' || ph === 'deepseek-flash',
    `DeepSeek 示例模型名应取官方列表里的正式名称，实际是「${ph}」`,
  );
});

/* ═══════════════════════════════════════════════════════════
   D 最直接的那条：没配 key 时**不许**说"已保存"
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 没配 key 时说明文字不许写"已保存"（这就是用户被骗的原因）', () => {
  /*
   * 原来只有两个分支：
   *
   * ```text
   *   masked → '已经配过了…'
   *   else   → 'key 已保存，这里不会再显示。要换就重新粘贴一次。'
   * ```
   *
   * `else` 同时盖住了 `empty`（**根本没配过**）和 `editing`。
   * 于是在一个从来没有 key 的源上，输入框下面写着
   * 「key 已保存，这里不会再显示」—— 用户读到这句话就不再填，
   * 然后发消息拿到 `400 {"error":true}`。
   *
   * ★ 这不是"提示不够清楚"，是**说反了**。所以判据要钉住
   *   `empty` 态的文案里不能出现"已保存/已配置/已经配"这类断言。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));

  const at = src.indexOf('const paintKeyHintImpl');
  assert.ok(at > 0, '找不到 key 说明的渲染函数');
  const body = src.slice(at, at + 900);

  /* 必须有 empty 分支，且它的文案要说"还没有" */
  assert.match(body, /还没有配 key/, 'empty 态必须明说"还没有配 key"');

  /*
   * 逐分支检查：把三元的每一段切出来，确认"什么都没配"那一段
   * 不含"已保存 / 已经配"这种断言。
   *
   * 用 `masked` / `editing` 作为切分点比较稳（它们是字面量）。
   */
  const maskedSeg = body.slice(body.indexOf("keyState === 'masked'"), body.indexOf("keyState === 'editing'"));
  const editingSeg = body.slice(body.indexOf("keyState === 'editing'"), body.indexOf('还没有配 key'));
  const emptySeg = body.slice(body.indexOf('还没有配 key'), body.indexOf('还没有配 key') + 120);

  assert.ok(/已经配过/.test(maskedSeg), 'masked 态说"已经配过了"（这是对的）');
  assert.ok(/粘贴/.test(editingSeg), 'editing 态指导粘贴');
  assert.ok(
    !/已保存|已配置|已经配/.test(emptySeg),
    `empty 态的文案不许出现"已保存/已配置/已经配"：${emptySeg}`,
  );
});

test('★★★★ 说明文字必须随状态刷新（不许渲染时写死一次）', () => {
  /*
   * 写死一次的话，用户点进输入框（empty → editing）后下面还写着
   * "还没有配 key"，读完以为自己没进编辑态。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));

  const paintAt = src.indexOf('const paintKeyField = (): void => {');
  assert.ok(paintAt > 0);
  const paintBody = src.slice(paintAt, paintAt + 700);
  assert.match(paintBody, /paintKeyHint\(\);/, 'paintKeyField 里要顺手刷说明');

  /* 而且这个钩子必须真的被接上（否则永远是个空函数） */
  assert.match(src, /paintKeyHint = paintKeyHintImpl;/, '钩子要被真实实现替换');
});

test('★★★ key 说明有个 data-role（探针要能定位它）', () => {
  const src = stripComments(read('client/src/chat/api-page.ts'));
  assert.match(src, /'data-role', 'key-hint'/, '说明元素要带 data-role="key-hint"');
});

/* ═══════════════════════════════════════════════════════════
   ⑤ 500 的两副面孔（2026-11-07，实测四家直连厂商之后）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 裸 error 的 500 不许说"稍后再试"（地区封锁重试也没用）', () => {
  /*
   * ST **从来不透传上游状态码**：所有厂商分支遇错都写
   * `response.status(500).send({ error: true })`。所以上游的 403
   * 到 App 这边一律变成"500 + 裸 error"。
   *
   * 实测（2026-11-07，本机成都电信 + 手机，两个不同出口 IP）：
   *
   * ```text
   *   Groq   403 {"error":{"message":"Forbidden"}}   cf-ray …-SIN
   *   Claude 403 {"message":"Request not allowed"}
   *   OpenAI DNS 污染（face:b00c 那段），TCP 超时
   * ```
   *
   * 这些"稍后再试"一万次也不会好。原来那句是**错的指引**。
   */
  const msg = explainGenerateError(500, '{"error":true}');
  assert.doesNotMatch(msg, /稍后再试/, '裸 error 的 500 不许说"稍后再试"');
  assert.match(msg, /网络|地区/, '要点出"网络或地区不可用"这个最常见原因');
  assert.match(msg, /中转站/, '要给出可执行动作（换中转站）');
  assert.match(msg, /反复失败/, '要告诉用户怎么区分这两种情况');
});

test('★★★★ 带 message 的 500 保持原来的"稍后再试"（别过度声称）', () => {
  /*
   * 上游若真的给了具体原因（带 message），那多半是临时故障。
   * 把"地区不可用"套到所有 500 上就是过度归因 —— 用户会被引导去乱改网络。
   */
  const msg = explainGenerateError(500, '{"error":{"message":"Internal Server Error"}}');
  assert.match(msg, /稍后再试/, '带 message 的 500 仍按临时故障处理');
  assert.doesNotMatch(msg, /地区/, '不许把地区封锁套到所有 500 上');
});

test('★★★★ 502 裸 error 也走"上游拒绝"（gateway 错误同样不透传）', () => {
  const msg = explainGenerateError(502, '{"error":true}');
  assert.match(msg, /网络|地区/);
});

test('★★★★★ 400 裸 error 仍然是"缺 key"（不能被 500 那条抢走）', () => {
  /*
   * 这两条都在 isBareErrorTrue 上分支，顺序错了就会把"缺 key"
   * 说成"地区封锁" —— 用户会去折腾网络而真正的问题是没填 key。
   */
  const msg = explainGenerateError(400, '{"error":true}');
  assert.match(msg, /API key/i, '400 裸 error 仍要指向缺 key');
  assert.doesNotMatch(msg, /地区/);
});
