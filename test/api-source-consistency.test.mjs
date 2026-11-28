/**
 * 「填了自定义地址」必须真的决定源与 key 槽位（2026-11-11）。
 *
 * ## 用户报的
 *
 * > 秘钥存储还是有问题
 *
 * 截图：`400 {"code":"","message":"Key 错误: Key 填错、过期或未设置 Bearer。请检查 Key。"}`
 *
 * 录屏（13.9 秒）里看清了他做的两件事：
 *
 * ```text
 *   ① 地址填 https://vip4lai.xyz/v1    （中转站）
 *   ② 把源从「自定义」改成「DeepSeek」
 * ```
 *
 * ## 真因：key 存对了，请求发错地方
 *
 * ST 的分支（`chat-completions.js`）：
 *
 * ```js
 *   // custom 源
 *   apiUrl = request.body.custom_url;
 *   apiKey = readSecret(…, SECRET_KEYS.CUSTOM, …);
 *
 *   // deepseek 源
 *   apiUrl = request.body.reverse_proxy || API_DEEPSEEK;   // ← 官方地址
 *   apiKey = readSecret(…, SECRET_KEYS.DEEPSEEK, …);
 * ```
 *
 * 源一切成 DeepSeek，`custom_url` 就**不被读**了 ⇒ 请求打到
 * `api.deepseek.com`，拿着中转站的 key ⇒ 上游回「Key 错误」。
 *
 * 所以"秘钥存储有问题"是误判：key 在 `api_key_deepseek` 里好好的，
 * 只是**没有任何人去用它**。
 *
 * ## 判据要钉的三处一致
 *
 * ```text
 *   ① 落盘   buildStConnectionPatch  → chat_completion_source 用实际源
 *   ② 写 key api-page                 → api_key_<实际源>
 *   ③ 生成   buildGenerateRequest     → chat_completion_source 用实际源
 * ```
 *
 * 三处任一不一致，就又回到"存的和发的不一样"。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  effectiveSourceFor,
  isOfficialUrlFor,
  buildStConnectionPatch,
  isLocalEndpoint,
} from '../shared/dist/chat/api-persist.js';
import {
  initialKeyState,
  keyStateOnBlur,
  keyStateOnFocus,
  shouldKeepTypedValue,
} from '../shared/dist/voice/key-field.js';
import { buildGenerateRequest } from '../shared/dist/chat/generate.js';
import { readShellImpl, readShellImplNoComments } from './lib/shell-source.mjs';

const ROOT = join(import.meta.dirname, '..');

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ═══ ① 官方地址判据 ═══ */

test('★★★ 能认出各家的官方地址', () => {
  assert.equal(isOfficialUrlFor('deepseek', 'https://api.deepseek.com/v1'), true);
  assert.equal(isOfficialUrlFor('openai', 'https://api.openai.com/v1'), true);
  assert.equal(isOfficialUrlFor('groq', 'https://api.groq.com/openai/v1'), true);
  assert.equal(isOfficialUrlFor('custom', 'https://vip4lai.xyz/v1'), false);
  assert.equal(isOfficialUrlFor('deepseek', ''), true, '空地址视为"就是不填"');
});

test('★★★ 中转站地址不算官方', () => {
  assert.equal(isOfficialUrlFor('deepseek', 'https://vip4lai.xyz/v1'), false);
  assert.equal(isOfficialUrlFor('openai', 'https://my-proxy.example.com/v1'), false);
});

/* ═══ ② 实际源的纠正 ═══ */

test('★★★★★ 填了中转站地址但选了 DeepSeek ⇒ 必须按 custom 走', () => {
  /*
   * 这正是用户那次的操作。不纠正的话地址会被静默丢掉，
   * 请求发到官方、key 是别家的 ⇒ 「Key 错误」。
   */
  assert.equal(effectiveSourceFor('deepseek', 'https://vip4lai.xyz/v1'), 'custom');
  assert.equal(effectiveSourceFor('openai', 'https://my-proxy.example.com/v1'), 'custom');
});

test('★★★★ 选什么源就用什么源（不该乱纠正）', () => {
  /* 地址为空：用户就是想用官方 */
  assert.equal(effectiveSourceFor('deepseek', ''), 'deepseek');
  /* 地址是官方地址：一切照旧 */
  assert.equal(effectiveSourceFor('deepseek', 'https://api.deepseek.com/v1'), 'deepseek');
  /* 本来就用 custom：不动 */
  assert.equal(effectiveSourceFor('custom', 'https://vip4lai.xyz/v1'), 'custom');
});

/* ═══ ③ 三处一致：落盘 ═══ */

test('★★★★★ 落盘时源与模型字段都按实际源写', () => {
  const patch = buildStConnectionPatch({
    source: 'deepseek',
    model: 'gpt-4o-mini',
    baseUrl: 'https://vip4lai.xyz/v1',
    maxTokens: 512,
  });

  assert.equal(
    patch['chat_completion_source'],
    'custom',
    '填了中转站地址就必须落成 custom —— 否则 ST 不读 custom_url',
  );
  assert.equal(patch['custom_model'], 'gpt-4o-mini', '模型要写进 custom 的字段');
  assert.equal(patch['deepseek_model'], undefined, '不该再写 deepseek 的字段');
  assert.equal(patch['custom_url'], 'https://vip4lai.xyz/v1', '地址要落盘');
});

test('★★★★ 用官方地址时仍写官方源（不干扰原有用法）', () => {
  const patch = buildStConnectionPatch({
    source: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
  });
  assert.equal(patch['chat_completion_source'], 'deepseek');
  assert.equal(patch['deepseek_model'], 'deepseek-chat');
});

test('★★★★ 官方地址不覆盖 custom_url（别动用户在 ST 里配的地址）', () => {
  /*
   * 我第一版写的是"所有源都写 custom_url，反正 ST 只有 custom 分支读它"。
   * 那样有个真实风险：用户在 ST 界面里给 custom 配过地址，现在用 openai
   * 保存一次，地址就被覆盖了 —— 他切回 custom 会发现莫名变了。
   *
   * 所以只在**这次真的要用地址**（actual === 'custom'）时才写。
   */
  const patch = buildStConnectionPatch({
    source: 'deepseek',
    model: 'x',
    baseUrl: 'https://api.deepseek.com/v1',
  });
  assert.equal('custom_url' in patch, false, '官方地址不该碰 custom_url');
});

/* ═══ ④ 三处一致：请求体 ═══ */

test('★★★★★ 生成请求也必须按实际源发（存的和发的不许不一致）', () => {
  /*
   * 只改落盘不改请求体，就会出现"settings 里是 custom、请求体里是 deepseek"
   * —— ST 按请求体走，照样打到官方地址。这条钉的就是这个。
   */
  const built = buildGenerateRequest({
    source: 'deepseek',
    model: 'gpt-4o-mini',
    baseUrl: 'https://vip4lai.xyz/v1',
    customUrl: 'https://vip4lai.xyz/v1',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(built.ok, true);
  assert.equal(
    built.request.chat_completion_source,
    'custom',
    '请求体里的源必须是 custom',
  );
  assert.equal(
    built.request.custom_url,
    'https://vip4lai.xyz/v1',
    '必须带上地址',
  );
});

/* ═══ ⑤ 三处一致：key 槽位 ═══ */

test('★★★★★ 写 key 的槽位要跟着实际源走（否则写进没人读的槽）', () => {
  /*
   * 选 DeepSeek 源 + 中转站地址 ⇒ 实际走 custom ⇒ key 必须写
   * `api_key_custom`。写进 `api_key_deepseek` 的话，ST 读 custom 槽是空的，
   * 又一个「未设置 Bearer」。
   */
  const page = stripComments(read('client/src/chat/api-page.ts'));

  assert.match(page, /effectiveSourceFor\(currentSource, rawBaseUrl\)/, '要算实际源');
  assert.match(
    page,
    /writeSecret\(`api_key_\$\{actualSource\}`/,
    'key 要写进实际源的槽位',
  );
  assert.match(
    page,
    /source: actualSource/,
    'onSave 传的也必须是实际源（否则落盘那边看到的还是旧源）',
  );
});

/* ═══════════════════════════════════════════════════════════
   ⑥ 本地地址判定（决定"没有 key 算不算错"）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 能认出本地/局域网地址（它们可能不需要 key）', () => {
  /*
   * 有些接口是用户自己在电脑上跑的（ollama、koboldcpp、vLLM），
   * 通常不校验 key。对它们要求"必须有 key"会让人没法保存。
   */
  assert.equal(isLocalEndpoint('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalEndpoint('http://localhost:8000'), true);
  assert.equal(isLocalEndpoint('http://10.0.2.2:5000'), true);
  assert.equal(isLocalEndpoint('http://192.168.1.50:1234/v1'), true);
  assert.equal(isLocalEndpoint('http://172.20.0.5:8080'), true);
  assert.equal(isLocalEndpoint('http://[::1]:8000'), true);
});

test('★★★★★ 公网地址不算本地（必须要求 key）', () => {
  /*
   * 用户那个中转站 `ai.ota1245.top` 必须被判成公网 ——
   * 否则"没有 key"就不会提示，又回到"看起来配好了其实 401"。
   */
  assert.equal(isLocalEndpoint('https://ai.ota1245.top/v1'), false);
  assert.equal(isLocalEndpoint('https://api.deepseek.com/v1'), false);
  assert.equal(isLocalEndpoint('http://172.32.0.1'), false, '172.32 不在私有段内');
  assert.equal(isLocalEndpoint(''), false, '空地址不算本地（交给缺地址那条校验）');
});

/* ═══════════════════════════════════════════════════════════
   ⑦ 没有 key 时必须说出来（本次事故的核心）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 核对不能只在"这次填了 key"时做', () => {
  /*
   * ## 这是 2026-11-12 那次事故的根因
   *
   * 原来的写法：
   *
   * ```ts
   *   if (apiKey !== null && apiKey.trim() !== '') { …核对… }
   * ```
   *
   * 于是"没填 key 直接保存"这条路上**什么都不检查**，problems 为空，
   * 界面显示「已保存（已同步到服务）」。
   *
   * 真机后果（直连 ST 读 `/api/secrets/read`）：52 个槽位全 null，
   * 用户填了 key 却一路"保存成功"，直到发消息 401。
   *
   * 判据：核对块**不被 `apiKey !== null` 包住**。
   */
  const src = readShellImplNoComments();

  const at = src.indexOf('function writeApiConnectionToSt(host: SettingsHost');
  assert.ok(at > 0, '找不到 writeApiConnectionToSt');
  const nextPrivate = src.indexOf('\n  private ', at + 10);
  const body = src.slice(at, nextPrivate < 0 ? src.length : nextPrivate);

  /*
   * ★ 不能用"这段里不出现某个字符串"来判。
   *
   * 我第一版就是这么写的，结果被**注释里的示例代码**绊倒：
   * 说明文字里引用了旧写法 `if (apiKey !== null && ...)`，
   * 于是判据红、代码却是对的。
   *
   * 改成钉**结构**：present 判定之后必须有两个分支 ——
   * 「填了但没生效」和「没填且非本地」。
   */
  assert.match(body, /if \(present\.includes\(secretKey\)\)/, '先看引擎里到底有没有');
  assert.match(body, /else if \(!isLocalEndpoint\(state\.baseUrl\)\)/, '没填且非本地 ⇒ 要说出来');

  /*
   * 还要钉住"没有 key 时确实 push 了问题"——只 match 到分支头不够，
   * 分支体里可能什么都不做（那也是"静默"）。
   */
  const branchAt = body.indexOf('else if (!isLocalEndpoint(state.baseUrl))');
  const branch = body.slice(branchAt, branchAt + 500);
  assert.match(branch, /problems\.push\(/, '这个分支必须真的报出来');
});

test('★★★★★ 没填 key 时文案要说清后果和下一步', () => {
  /*
   * 只说"没有 key"不够 —— 用户不知道该干什么。必须给出**动作**。
   */
  const src = readShellImplNoComments();
  const at = src.indexOf('这个接口还没有可用的秘钥');
  assert.ok(at > 0, '要有"没有可用秘钥"这条提示');
  const around = src.slice(at, at + 300);
  assert.match(around, /粘贴/, '要告诉他下一步做什么');
});

test('★★★★ 保存反馈要区分"这次改没改 key"', () => {
  /*
   * 原来两种情况都只说「已保存」。而用户真实看到的那句
   * 「已保存」恰好是 `rawKey === null` 这一支 —— key 一个字节都没动。
   *
   * 这不是措辞问题：它让用户失去了发现"我没填上"的机会。
   */
  const page = stripComments(read('client/src/chat/api-page.ts'));
  assert.match(
    page,
    /rawKey === null \? '已保存（这次没有改动秘钥）'/,
    '没改 key 时要说明',
  );
});

test('★★★★ 保存路径要留现场（否则 rawKey 为什么是 null 查不出来）', () => {
  /*
   * `rawKey === null` 有三种成因（输入框不存在 / 值为空 / 值还是掩码），
   * 处理方式完全不同。不留日志就只能靠猜 —— 而这次已经猜了几轮。
   *
   * 注意：只记长度与是否掩码，**不许记 key 内容**（日志要给用户看的）。
   */
  const page = stripComments(read('client/src/chat/api-page.ts'));
  assert.match(page, /diagNote\(\s*'note'/, '保存路径要有日志');
  assert.match(page, /mask=\$\{maskState\}/, '要记"值是不是掩码"');
  assert.match(page, /len=\$\{String\(rawKeyInput\.length\)\}/, '要记值长度');
  /* 不许把 key 本身写进日志 */
  assert.doesNotMatch(page, /rawKeyInput \}/, '不许把 key 值拼进日志');
});

/* ═══════════════════════════════════════════════════════════
   ⑧ 失焦不许抹掉用户刚粘贴的 key（真机 bug，犯过两次）
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ shouldKeepTypedValue：填了内容就必须保住', () => {
  /*
   * 纯函数，直接真跑。这是两处秘钥框共用的判断。
   */
  assert.equal(shouldKeepTypedValue('editing', 'sk-abc'), true, '有内容 ⇒ 保住');
  assert.equal(shouldKeepTypedValue('editing', '   '), false, '只有空白 ⇒ 不保（该退回"没配"）');
  assert.equal(shouldKeepTypedValue('editing', ''), false, '空 ⇒ 不保');
  assert.equal(shouldKeepTypedValue('masked', 'sk-abc'), false, 'masked 不是"正在填"');
  assert.equal(shouldKeepTypedValue('empty', 'sk-abc'), false, 'empty 不是"正在填"');
});

test('★★★★★ API 页的失焦处理不许抹 value', () => {
  /*
   * ## 真机现场（2026-11-12，iQOO V2507A）
   *
   * ```text
   *   [save] source=custom input=yes len=0 mask=no write=no
   * ```
   *
   * `input=yes` + `len=0` ⇒ 框在、值是空串。用户明明粘贴过、也看到了圆点。
   *
   * 真因：点「保存」时输入框先 blur（web 标准 blur 早于 click），
   * blur handler 里 `paintKeyField()` 无条件 `value = keyFieldValue(state)`，
   * 而 `keyFieldValue('editing')` 是**空串** ⇒ 刚粘的 key 被自己抹掉。
   *
   * ★ 语音页 2026-11-07 修过同一个 bug，API 页漏了。
   *   所以判据要求两处都走同一个 shared 函数。
   */
  const src = read('client/src/chat/api-page.ts');

  assert.match(src, /shouldKeepTypedValue\(next, typed\)/, 'blur 要用共享判断');
  /* 保住时只更新属性、不碰 value */
  const at = src.indexOf('shouldKeepTypedValue(next, typed)');
  const block = src.slice(at, at + 500);
  assert.match(block, /if \(keepTyped\)/, '要按判断分支');
  assert.match(block, /return;/, '保住时直接返回，不走 paintKeyField');
  assert.doesNotMatch(block, /ki\.value\s*=/, '这个分支里不许给 value 赋值');
});

test('★★★★★ 两处秘钥框必须共用同一个判断（防第三次分叉）', () => {
  /*
   * 这个 bug 已经在两处各写一遍代码的土壤里长出来两次：
   *
   * ```text
   *   2026-11-07  语音页  → 修
   *   2026-11-12  API 页   → 又犯
   * ```
   *
   * 判据：两个文件都必须调 shared 的 `shouldKeepTypedValue`，
   * 且**不许**各自内联一份等价表达式（那就会第三次分叉）。
   */
  for (const file of ['client/src/chat/api-page.ts', 'client/src/chat/voice-settings.ts']) {
    const src = read(file);
    assert.match(src, /shouldKeepTypedValue/, `${file} 要调 shared 判断`);
    assert.doesNotMatch(
      src,
      /next === 'editing' && \(.*\)\.trim\(\) !== ''/,
      `${file} 不许内联一份等价判断`,
    );
  }
});

test('★★★★ paintKeyField 自身也要挡住 editing 态（第二道防线）', () => {
  /*
   * 即使将来某个调用点忘了先判断，paintKeyField 自己也不该覆盖
   * 用户正在输入的内容 —— 纵深防御，成本只有一行。
   */
  const src = read('client/src/chat/api-page.ts');
  const at = src.indexOf('const paintKeyField = ()');
  assert.ok(at > 0, '找不到 paintKeyField');
  const block = src.slice(at, at + 2400);
  assert.match(
    block,
    /if \(keyState !== 'editing'\) ki\.value = keyFieldValue\(keyState\);/,
    'paintKeyField 只在非 editing 态写 value',
  );
});

test('★★★★★ 未保存的 key 要能跨面板重建活下来，但绝不落盘', () => {
  /*
   * ## 真机发现的第二个丢值路径（2026-11-12）
   *
   * `expandSource()` 会 `replaceChildren()` 掉所有面板。于是：
   *
   * ```text
   *   在「自定义」里粘好 key
   *     → 点开「DeepSeek」看一眼
   *     → 点回「自定义」⇒ key 没了，框又变回"粘贴 key"
   * ```
   *
   * 修法：内存里的 `pendingKeys`（按源分开）。
   *
   * ## 但"存起来"有一条红线
   *
   * 它是**秘钥**。所以判据不只要求"存"，还要求**绝不落盘**：
   *
   * ```text
   *   可以  Map 内存、input 时记、重建时回填、保存成功后清
   *   禁止  localStorage / sessionStorage / diagNote 里出现它
   * ```
   *
   * 后半条比前半条重要 —— 存丢了只是让用户重填，
   * **存进磁盘或日志就是泄漏**。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));

  assert.match(src, /const pendingKeys = new Map/, '要有按源分开的内存草稿');
  assert.match(src, /pendingKeys\.set\(source, typedNow\)/, 'input 时要记进草稿');
  assert.match(src, /pendingKeys\.get\(source\)/, '面板重建时要回填');
  assert.match(src, /pendingKeys\.delete\(actualSource\)/, '保存成功后要清掉');

  /*
   * 红线：**存草稿的那段代码里**不许有任何持久化调用。
   *
   * ★ 上一版是"挑出含 pendingKeys 的行来查"，变异（在旁边插一行
   *   `localStorage.setItem('k', typedNow)`）**照样绿** —— 因为新插的
   *   那行里没有 `pendingKeys` 这个词。判据要扫**块**，不是扫**行**。
   *
   * 这里取 input 处理器的整块（从 `'input'` 到它闭合），
   * 块里出现 localStorage / sessionStorage / diagNote / invoke 就算泄漏。
   */
  /*
   * ★ 两个坑，都是这次踩的：
   *
   * ```text
   *   ① 拿第一个 `'input'` 定位 → 那是**地址输入框**的处理器，不是 key 的
   *   ② 拿第一个 `});` 收尾     → 会截在 `.filter()` 那个回调中间
   * ```
   *
   * 改成以 `typedNow`（只出现在 key 的处理器里）为锚点，向前找处理器开头、
   * 向后找缩进 4 空格的 `});`。
   */
  const anchorAt = src.indexOf('typedNow');
  assert.ok(anchorAt > 0, '找不到 key 输入处理器的特征代码');
  const inputAt = src.lastIndexOf("addEventListener?.('input'", anchorAt);
  assert.ok(inputAt > 0, '找不到 key 的 input 处理器');
  const inputEnd = src.indexOf('\n    });', anchorAt);
  const inputBlock = src.slice(inputAt, inputEnd < 0 ? inputAt + 400 : inputEnd);
  assert.match(inputBlock, /pendingKeys\.set\(source, typedNow\)/, '草稿要在这里记');
  assert.doesNotMatch(
    inputBlock,
    /localStorage|sessionStorage|diagNote|invoke\(/,
    '存秘钥的这段里不许落盘或记日志（那是泄漏）',
  );
});

test('★★★★ 回填必须在 paintKeyField 之后（否则被它覆盖）', () => {
  /*
   * `paintKeyField()` 会把 value 设成掩码/空。回填若写在它前面，
   * 顺序一反就被它抹掉 —— 又是一个"写了但没用"。
   */
  /*
   * ★ 不能靠"紧跟某段注释"来定位：`stripComments` 已经把注释删了，
   *   strip 之后那段文字根本不存在（第一版就是这么误红的）。
   *   改成比较两个**代码位置**的先后。
   */
  const src = stripComments(read('client/src/chat/api-page.ts'));
  const paintAt = src.indexOf('paintKeyField();');
  const pendingAt = src.indexOf('const pendingKey = pendingKeys.get(source);');
  assert.ok(paintAt > 0 && pendingAt > 0, '两段都要在');
  assert.ok(paintAt < pendingAt, '回填必须在 paintKeyField() 之后，否则被它覆盖');
  assert.match(src, /if \(pendingKey !== undefined && pendingKey !== ''\)/, '要有回填分支');
  assert.match(src, /keyState = 'editing'/, '回填后要进入 editing 态');
});

/* ═══════════════════════════════════════════════════════════
   ⑨ 完整状态机：从"从未配过 key"到"填完离开"，值必须活下来
   ═══════════════════════════════════════════════════════════ */

test('★★★★★ 从未配过 key 的源：输入后失焦，值必须还在', () => {
  /*
   * ## 这是用户那个 bug 的**真正根因**（2026-11-12 第二次真机取证）
   *
   * 前一轮我修了 `paintKeyField` 与 blur 的 `keepTyped`，但那两条都以
   * **"状态是 editing"** 为前提。而用户那个源从来没配过 key：
   *
   * ```text
   *   initialKeyState(hasKey=false)  = 'empty'
   *   keyStateOnFocus('empty')       = 'empty'   ← 旧实现只处理 masked → editing
   *   type 之后状态**仍是 empty**
   *   blur：keyStateOnBlur('empty', 'sk-xxx', false)
   *         → state !== 'editing' ⇒ 直接返回 'empty'
   *   shouldKeepTypedValue('empty', 'sk-xxx') = false
   *   paintKeyField() → value = keyFieldValue('empty') = ''
   *   ⇒ **值被抹掉，len=0**
   * ```
   *
   * 真机日志（Redmi Note 8 Pro）：
   *
   * ```text
   *   [save] source=openai input=yes len=0 mask=no write=no
   * ```
   *
   * 修复后：`empty` 聚焦也进 `editing`；`blur` 见内容非空也判 `editing`。
   *
   * ## 这条判据为什么必须跑完整链条
   *
   * 单测 `shouldKeepTypedValue` 一直是绿的 —— 它本身没错，
   * 错的是**喂给它的状态不对**。所以必须从 `initialKeyState` 一路跑到
   * `shouldKeepTypedValue`，才抓得到这类"接线错"。
   */
  for (const hadKey of [false, true]) {
    let state = initialKeyState(hadKey);

    /* ① 用户点进输入框 */
    state = keyStateOnFocus(state);

    /* ② 用户粘贴了 key（内容在框里） */
    const typed = 'sk-realkey-1234';

    /* ③ 用户点「保存」——输入框先失焦 */
    const afterBlur = keyStateOnBlur(state, typed, hadKey);

    /* ④ 这一段就是真机上的判定：值会不会被 paintKeyField 抹掉 */
    const kept = shouldKeepTypedValue(afterBlur, typed);

    assert.equal(
      kept,
      true,
      hadKey
        ? '已配过的源（masked 起步）：填了新值后失焦不许抹掉'
        : '**从未配过的源（empty 起步）**：填了值后失焦不许抹掉 —— 这就是用户那个 401 的根因',
    );
    assert.equal(afterBlur, 'editing', '有内容时状态必须是 editing');
  }
});

test('★★★★★ 空输入时仍要退回正确状态（别把"没配"说成"已配"）', () => {
  /*
   * 修复不能矫枉过正：用户点进框、什么都没填就离开，
   * 必须回到 empty（没配过）/ masked（配过），不能停在 editing
   * —— 停在 editing 会让提示语一直是"粘贴 key 然后保存"。
   */
  assert.equal(keyStateOnBlur(keyStateOnFocus(initialKeyState(false)), '', false), 'empty');
  assert.equal(keyStateOnBlur(keyStateOnFocus(initialKeyState(true)), '', true), 'masked');
  assert.equal(keyStateOnBlur(keyStateOnFocus(initialKeyState(true)), '   ', true), 'masked', '只有空白也算没填');
});

test('★★★★ 聚焦必须从 masked/empty 都进 editing', () => {
  /*
   * `masked` 是"展示用的假状态"（显示一排圆点），一聚焦就该消失；
   * `empty` 只是"当前没有值"，不是状态。
   */
  assert.equal(keyStateOnFocus('masked'), 'editing');
  assert.equal(keyStateOnFocus('empty'), 'editing', 'empty 不聚焦进来就没法进入"正在填"');
  assert.equal(keyStateOnFocus('editing'), 'editing');
});
