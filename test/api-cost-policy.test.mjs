/**
 * 聊天 API 的**计费纪律**（用户 2026-11-01 09:50 明令）。
 *
 * ## 这条纪律的事实基础
 *
 * 用户用的聊天 API 是 **按次计费**，不是按 token：
 *
 * ```
 * 5 元额度 ≈ 200 次请求 ≈ 0.025 元/次
 * ```
 *
 * 三个直接推论，每一条都推翻了一个常见做法：
 *
 * | 常见做法 | 在这个 API 上为什么错 |
 * |---|---|
 * | "提示词写短一点省钱" | 3 个字和 3000 个字都算 **1 次**，长短完全不影响花费 |
 * | "跑一遍回归没关系" | 每跑一次 = 花掉 1 次额度，200 次额度 = 200 次回归 |
 * | "失败重试几次" | 失败的请求**照样计费**（上游已经接了） |
 *
 * ## 所以这里守的是什么
 *
 * **默认预算是 0 次。** 任何"真的发一条消息"的脚本必须显式打开
 * （`TCS_ALLOW_PAID_API=1`），而且必须能说清这一次花在哪里。
 *
 * 这条测试**不发起任何网络请求** —— 它是纯静态扫描。
 * 如果这条测试自己需要花钱，那它就是又一个问题，而不是解法。
 *
 * ## 为什么判据是"静态扫描脚本"而不是"计数真实请求"
 *
 * 计数真实请求要在运行时拦截 fetch/socket，那得先跑一次才知道有没有跑 ——
 * 已经太晚了（钱已经花了）。静态扫描是**在跑之前**就能判的，
 * 这正是"默认值为 0"这个设计需要的判据类型。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');

/* ═══════════════════════════════════════════════════════════
   ① 计费事实本身（写进常量，改价时只改这里）
   ═══════════════════════════════════════════════════════════ */

/**
 * 用户告知的计费事实。
 *
 * 为什么把它写成常量而不是只写在注释里：
 * 断言需要它（下面会算"跑满额度等于跑多少次回归"），
 * 而注释里的数字没人会去改，常量改了至少会有一条断言跟着变。
 *
 * ⚠️ 如果哪天这个 API 改成按 token 计费，**先改这里再改脚本** ——
 * 因为"提示词写短"这件事只有在那之后才有意义。
 */
const CHAT_API_PRICE = {
  /** 用户给的一次充值额度（元） */
  budgetYuan: 5,
  /** 这笔额度大约能请求多少次 */
  requests: 200,
  /** 按次计费（不是按 token）—— 这条是这个测试全部断言的前提 */
  billedPerRequest: true,
};

/** 单次约多少钱 */
const YUAN_PER_REQUEST = CHAT_API_PRICE.budgetYuan / CHAT_API_PRICE.requests;

test('★ 计费事实：5 元 ≈ 200 次，单次约 0.025 元（按次，不按 token）', () => {
  assert.equal(CHAT_API_PRICE.billedPerRequest, true);
  assert.equal(YUAN_PER_REQUEST, 0.025);

  /*
   * 这条断言看起来是同义反复，但它是在钉**前提**：
   * 如果哪天有人把 `billedPerRequest` 改成 false 却忘了改脚本里的注释
   * （那些注释正是"只发 3 个字所以很省"这套错误推理的来源），
   * 这条会红，逼他回头看一眼。
   */
  assert.ok(
    YUAN_PER_REQUEST > 0 && YUAN_PER_REQUEST < 1,
    '单次成本应当在 0.025 元这个量级 —— 量级不对说明预算数字抄错了',
  );
});

test('★ 默认请求预算必须是 0 次（不是 1 次，也不是"就一次"）', () => {
  /*
   * 这条是整个文件的核心。
   *
   * 判据形态：读脚本源码，确认"发请求"那段被一个
   * `TCS_ALLOW_PAID_API` 的门包住，且门的默认值是 0。
   *
   * 为什么不是"断言脚本里没有 curl"：脚本里当然有 curl（那正是它要做的事），
   * 要害是**默认不执行**。所以判据必须落在"默认值"上。
   */
  const script = read('scripts/verify-android-device.sh');

  assert.match(
    script,
    /if \[ "\$\{TCS_ALLOW_PAID_API:-0\}" != "1" \]/,
    '④-6 必须有一道默认关闭的计费门（${TCS_ALLOW_PAID_API:-0} != 1）',
  );

  /*
   * 门的默认值必须是 `0`。
   *
   * 写成 `${TCS_ALLOW_PAID_API:-1}` 就等于"默认允许花钱" ——
   * 一个字符的差别，行为完全相反，所以单独钉一次。
   */
  assert.doesNotMatch(
    script,
    /TCS_ALLOW_PAID_API:-1/,
    '门的默认值不许是 1（那等于默认允许花钱）',
  );

  // SKIP 的文案要把"为什么跳过"说出来，否则下一个人会以为是漏配
  assert.match(script, /按次计费/, 'SKIP 的说明里要写明按次计费，否则会被当成配置漏了');
});

/* ═══════════════════════════════════════════════════════════
   ② 不许把真实站点/模型名硬编码进仓库
   ═══════════════════════════════════════════════════════════ */

test('★★ 仓库里不许出现真实中转站域名（换站不该改代码）', () => {
  /*
   * 上一版把 `https://ai.ota1245.top/v1` 和一个具体模型名写死在
   * `scripts/verify-android-device.sh` 里。两个问题：
   *
   * 1. 用户的私有用例（站点地址 + 站里自起的模型名）进了仓库；
   * 2. 换 key / 换站要改脚本 —— 而改脚本的人往往忘了这里还有一份。
   *
   * 真实地址与模型名现在从环境变量来（`TCS_PAID_BASE_URL` / `TCS_PAID_MODEL`）。
   */
  const scanned = [
    'scripts/verify-android-device.sh',
    ...listFiles('scripts', '.mjs'),
    ...listFiles('shared/src', '.ts'),
    ...listFiles('client/src', '.ts'),
  ];

  const offenders = [];
  for (const file of scanned) {
    const text = read(file);
    // 真实中转站的域名片段（写死就等于仓库里带着用户的私有地址）
    if (/ai\.ota1245\.top/.test(text)) offenders.push(`${file}: 站点域名`);
    // "[次0.2]claude-opus-4-8" 这种是**那个站**自起的模型名，不是通用名
    if (/\[次[0-9.]+\]/.test(text)) offenders.push(`${file}: 站点私有模型名`);
  }

  assert.deepEqual(offenders, [], '真实站点/私有模型名不该出现在仓库里');
});

test('★ 付费脚本的模型名必须来自环境变量（不猜、不写死）', () => {
  const script = read('scripts/verify-android-device.sh');

  assert.match(script, /\$\{TCS_PAID_MODEL:-\}/, '模型名要从 TCS_PAID_MODEL 读');
  assert.match(
    script,
    /没设 TCS_PAID_MODEL[\s\S]{0,40}跳过/,
    '没设模型名时应当 SKIP 而不是猜一个 —— 猜错也是一次计费',
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ 测试套件本身不许联网
   ═══════════════════════════════════════════════════════════ */

test('★★ `npm test` 不许有任何指向外网的 fetch', () => {
  /*
   * 判据：`test/*.test.mjs` 里，**同一行**同时出现 `fetch(` 与 `https://`
   * 就算越界。
   *
   * 为什么是"同一行"而不是"整个文件"：
   * `test/asr-preset.test.mjs` 里有 `baseUrl: 'https://dashscope.aliyuncs.com/...'`，
   * 那是**被断言的字符串**，不发请求。按整文件判会假红。
   * 按同行判则精确 —— 真的发请求必然把 URL 写进调用里。
   *
   * 测试里的网络请求一律指向 `127.0.0.1` 的本地桩（`asr-gradio.test.mjs`
   * 就是这么做的：起一个 createServer，用完 close）。
   */
  const offenders = [];

  for (const file of listFiles('test', '.mjs')) {
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      /*
       * ★ 必须跳过注释行。
       *
       * 这条测试**自己**第一版就被抓了：它的注释里写着
       * 「同一行同时出现 fetch( 与 https://」，于是自指命中。
       * 那不是实现的问题，是判据不够精确 —— 注释不是代码，不该被执行判据读取。
       *
       * 这条经验一般化：**扫描源码的判据要先排除注释**。否则
       * "解释这条规则"的文字会被当成"违反这条规则"的证据。
       */
      const trimmed = line.trim();
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      ) {
        return;
      }

      const callsFetch = /\bfetch\s*\(|httpRequest\s*\(|\bgot\s*\(/.test(line);
      const remoteUrl = /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/.test(line);
      if (callsFetch && remoteUrl) {
        offenders.push(`${file}:${String(index + 1)} ${trimmed.slice(0, 80)}`);
      }
    });
  }

  assert.deepEqual(offenders, [], '测试里不许真的打外网（要打就打本地桩）');
});

test('★ 测试里不许出现像真 key 的长字面量', () => {
  /*
   * 一个真 key 进了测试文件，既泄密又让人以为"这条测试需要 key"。
   * 判据：`sk-` / `gsk_` 后跟一长串（≥20 个字符）就算可疑。
   * `sk-test-123` 这类假值不命中（不够长）。
   */
  const offenders = [];
  for (const file of listFiles('test', '.mjs')) {
    const text = read(file);
    // 真实 key 形态：前缀 + 长随机串
    const hits = text.match(/\b(?:sk|gsk|xai|sk-ant)-[A-Za-z0-9_-]{20,}/g);
    if (hits !== null) offenders.push(`${file}: ${hits[0].slice(0, 12)}…`);
  }
  assert.deepEqual(offenders, [], '测试里出现真 key 的风险必须为零');
});

/* ═══════════════════════════════════════════════════════════
   ④ 其它会花钱的入口也要有门
   ═══════════════════════════════════════════════════════════ */

/**
 * 一条计费门的**完整形态**。
 *
 * ★ 断言"门是一段真的判断"，不是"文件里出现过这个变量名"。
 *
 * 第一版就是错的：只匹配 `/TCS_ALLOW_PAID_API/`，
 * 于是**注释里那句用法示例**（`TCS_ALLOW_PAID_API=1 node ...`）就让它通过了 ——
 * 把门改成 `if (false)` 之后仍然全绿。
 *
 * 这是变异验证抓出来的，也是我在这个项目里第三次犯同一个错：
 * **判据读到了注释，就以为读到了代码。**（前两次见 memory §39 / §67.3）
 *
 * 现在钉住完整形态：真的读环境变量 + 真的比对 '1' + 不远处真的 exit(5)。
 */
const PAID_GATE_RE =
  /if\s*\(\s*process\.env\.TCS_ALLOW_PAID_API !== '1'\s*\)[\s\S]{0,900}?process\.exit\(5\)/;

/**
 * 找出一个脚本里**在注释之外**出现的、指向真实外网的调用。
 *
 * 为什么要剥注释：这些脚本的注释里大量引用文档地址
 * （`https://api.deepseek.com/models`），直接扫会被自己的说明文字判红。
 *
 * 为什么要排除内网：本项目的排查脚本经常探 `10.9.0.2`（局域网设备）
 * 或 `127.0.0.1`（回环），那些都不花钱。
 */
function realRemoteCalls(source) {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const urls = code.match(/https:\/\/[^\s'"`)]+/g) ?? [];
  const external = urls.filter((u) => {
    if (/^https:\/\/(localhost|127\.0\.0\.1)/.test(u)) return false;
    /* 内网段：10.x / 192.168.x / 172.16-31.x */
    if (/^https:\/\/10\./.test(u)) return false;
    if (/^https:\/\/192\.168\./.test(u)) return false;
    if (/^https:\/\/172\.(1[6-9]|2\d|3[01])\./.test(u)) return false;
    return true;
  });

  const hasCurl = /['"]curl['"]/.test(code);
  if (external.length === 0 && !hasCurl) return false;

  return (
    /\bfetch\s*\(/.test(code) ||
    /execFileSync\(\s*['"]curl['"]/.test(code) ||
    hasCurl ||
    /\.request\s*\(/.test(code)
  );
}

/**
 * 显式豁免标记：`@no-paid-api <理由>`。
 *
 * 为什么需要它 —— 判据第一版要求"凡打外网就必须有计费门"，一跑就红了 6 个，
 * 而其中 5 个根本不花钱（GitHub Release API、内网 `10.9.0.2` 探测）。
 * 那种误报会把人逼到两条歪路：要么给不花钱的脚本加无意义的门，
 * 要么为了消红把判据删掉（memory §68 记过这个风险）。
 *
 * 所以：**默认必须有门，豁免必须显式声明并写理由**。
 * 理由非空才算豁免 —— 空标记不算（否则又变成"出现变量名就算过"）。
 */
const NO_PAID_MARK = /@no-paid-api[ \t]+(\S[^\n]*)/;

function isExempt(source) {
  const m = NO_PAID_MARK.exec(source);
  return m !== null && (m[1] ?? '').trim().length >= 6;
}

test('★★ CDP 驱动发消息的脚本必须自带计费门（默认 exit 5）', () => {
  /*
   * `.verify/` 是本地过程目录（gitignore），新 clone 的仓库里不存在。
   * 所以用**条件断言**：文件在就必须有门，不在就跳过。
   *
   * 为什么不干脆不检：这几个脚本正是我会忍不住跑的那几个
   * （"顺手验一下回复"），最需要这道门。
   */
  const paidScripts = [
    '.verify/device-gen-r5.mjs',
    '.verify/device-e2e-chat.mjs',
  ];

  for (const file of paidScripts) {
    if (!existsSync(join(ROOT, file))) continue;
    assert.match(
      read(file),
      PAID_GATE_RE,
      `${file} 会真发消息，必须有一道真的计费门（读 env + exit 5），注释里的用法说明不算`,
    );
  }
});

test('★★★★ 凡是指向真实外网的脚本都必须自带计费门（不靠白名单）', () => {
  /*
   * ★★★ 2026-11-07 补这个缺口。
   *
   * 上面那条用的是**硬编码文件名清单**。于是我今天新写的
   * `.verify/probe-deepseek-effort.mjs`（会真发 4 次 DeepSeek 请求）
   * 完全不在清单里，判据一声不吭 —— 而我确实拿它打了真 API。
   *
   * 这不是"忘了加"，是**判据只覆盖已知文件**：
   * 明天再写一个花钱脚本，同样漏。记忆 §39 那条
   * "判据价值 = 覆盖范围 × 命中规则"说的就是这个 —— 命中规则对，
   * 覆盖范围是靠人列举的，就必然漏。
   *
   * 改成**按内容扫**：`.verify/*.mjs` 与 `scripts/*.mjs` 里，
   * 只要非注释代码里同时出现「真实外网地址或 curl」和「发起请求」，
   * 就必须有计费门。
   */
  const dirs = ['.verify', 'scripts'];
  const offenders = [];

  for (const dir of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;

    for (const name of readdirSync(abs)) {
      if (!/\.(mjs|js)$/.test(name)) continue;
      const rel = `${dir}/${name}`;
      const text = read(rel);
      if (!realRemoteCalls(text)) continue;
      if (PAID_GATE_RE.test(text)) continue;
      if (isExempt(text)) continue;
      offenders.push(rel);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些脚本会真发外网请求（可能花钱）却没有计费门：\n  ${offenders.join('\n  ')}\n` +
      `要么加 \`if (process.env.TCS_ALLOW_PAID_API !== '1') process.exit(5)\`，\n` +
      '要么在文件里写 `@no-paid-api <为什么它不花钱>`（理由必须非空）显式豁免。',
  );
});

test('★ 计费门被触发时要用**专用退出码**（5），不许混进普通失败', () => {
  /*
   * 退出码 5 = "我没跑，因为要花钱"。
   * 与 1（真失败）分开，否则 CI 里"没花钱"会显示成"坏了"，
   * 然后有人为了消红去把门删掉。
   */
  const file = '.verify/device-gen-r5.mjs';
  if (!existsSync(join(ROOT, file))) return;
  const text = read(file);
  assert.match(text, /process\.exit\(5\)/, '计费门要用 exit(5)');
  /*
   * 反向：不许有 `if (false)` 这类"门在但永远不拦"的写法。
   * 这一条是上面那条变异（把条件改成 false）的直接教训。
   */
  assert.doesNotMatch(
    text,
    /if\s*\(\s*(?:false|0|!!0)\s*\)\s*\{[\s\S]{0,200}?process\.exit\(5\)/,
    '门不许被写成永远不成立的条件（那等于没有门）',
  );
});

test('★ 额度换算：跑满一次充值等于多少次回归（给一个直觉量）', () => {
  /*
   * 这条不是断言行为，是把数字摆出来让人看见 ——
   * 但用断言写，因为它会随常量变，注释里的数字不会。
   *
   * 一次完整回归如果真发 1 条消息：
   *   200 次额度 ÷ 1 次/轮 = 200 轮就烧完 5 元
   * 而"一天跑 5 轮"的话，40 天。
   * 听起来不少，但加上调试时的重跑（改一次验一次）就会快得多 ——
   * 这正是"默认 0 次"的理由。
   */
  const requestsPerRound = 1;
  const roundsPerTopUp = CHAT_API_PRICE.requests / requestsPerRound;
  assert.equal(roundsPerTopUp, 200);

  // 断言"每轮最多 1 次"这个前提：默认 0 次，显式打开后最多发 1 条
  const script = read('scripts/verify-android-device.sh');
  const genCalls = (script.match(/chat-completions\/generate/g) ?? []).length;
  assert.equal(genCalls, 1, '脚本里只该有一处生成调用（多处就等于一轮花多次）');
});

/* ─────────────── 工具 ─────────────── */

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** 列出某目录下指定后缀的文件（相对路径，递归一层足够） */
function listFiles(dir, ext) {
  const base = join(ROOT, dir);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
    .map((entry) => `${dir}/${entry.name}`);
}
