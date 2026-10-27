/**
 * F15 / T13.2–T13.6 的纯逻辑单测（`client/src/session/st-install.ts`）。
 *
 * 这里的每一条都对应"错了会静默出事"的地方：
 *   · 判据松一格 → 把一个不相干的目录当 ST，点启动拉起奇怪的东西；
 *   · 判据紧一格 → 用户明明装了 ST，界面说没装（他会去装第二份）；
 *   · 冲突不加序号 → 覆盖掉 ST 里已有的同名卡（用户的原卡没了）；
 *   · 四状态共用一句文案 → 用户不知道该"去装"还是该"点启动"；
 *   · 下载地址拼错 → 表现为"下载失败"，看不出是前缀格式问题。
 *
 * 另一件必须对拍的事：**TS 判据与 Rust `looks_like_st_root` 必须一致**。
 * 两处分叉的后果是"面板说装了、点启动却被壳拒掉"，而报错说的是另一件事。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  chooseLaunchTarget,
  chooseStInstall,
  classifyStProbe,
  describeLaunchFailure,
  describeProbe,
  hasStartScript,
  judgeStInstall,
  nodeInstallCandidates,
  probeStState,
  samePath,
  stCharactersDir,
  stDownloadUrl,
  stInstallTargetDir,
  stPushFileName,
  stStatusText,
  ST_LAUNCH_FAILURE_HINTS,
  ST_PROBE_TIMEOUT_MS,
  ST_RELEASE,
  tailOfLog,
  toBase64Chunked,
  waitForStReady,
} from '../client/src/session/st-install.ts';
import { parseStAddress, ST_DEFAULT_ADDRESS } from '../client/src/session/st-address.ts';

/** 探测用的地址（默认值）：T14.0 起地址从配置来，测试里显式给它，不靠隐式默认 */
const ADDRESS = parseStAddress(ST_DEFAULT_ADDRESS);

const ROOT = join(import.meta.dirname, '..');
const COMMANDS_RS = readFileSync(join(ROOT, 'client/src-tauri/src/commands.rs'), 'utf8');
const ST_INSTALL_TS = readFileSync(join(ROOT, 'client/src/session/st-install.ts'), 'utf8');

/** 造一组事实 */
function facts(overrides = {}) {
  return {
    root: 'C:\\Users\\tester\\SillyTavern',
    hasPackageJson: true,
    packageJsonText: '{"scripts":{"start":"node server.js"}}',
    hasServerJs: true,
    ...overrides,
  };
}

// ── 判据矩阵（需求 T13.7 明确要求这一组）────────────────────

test('判据：package.json 有无 × scripts.start / server.js 四种组合', () => {
  const startPkg = '{"scripts":{"start":"node server.js"}}';
  const plainPkg = '{"scripts":{"build":"tsc"}}';

  // ① 有 pkg + 有 start + 无 server.js → 装（1.12 那代：bat 走 npm start）
  assert.equal(
    judgeStInstall(facts({ packageJsonText: startPkg, hasServerJs: false })).installed,
    true,
    'scripts.start 单独就该成立',
  );

  // ② 有 pkg + 无 start + 有 server.js → 装（1.13 那代：直接 node server.js）
  const second = judgeStInstall(facts({ packageJsonText: plainPkg, hasServerJs: true }));
  assert.equal(second.installed, true, 'server.js 单独也该成立');
  assert.deepEqual(second.evidence, ['package.json 存在', 'server.js 存在']);

  // ③ 有 pkg，但两条都不满足 → 不装
  const third = judgeStInstall(facts({ packageJsonText: plainPkg, hasServerJs: false }));
  assert.equal(third.installed, false);
  assert.equal(third.reason, 'no-start-script-and-server-js');

  // ④ 没有 pkg，只有 server.js → 不装（缺一半判据）
  const fourth = judgeStInstall(facts({ hasPackageJson: false, packageJsonText: null, hasServerJs: true }));
  assert.equal(fourth.installed, false);
  assert.equal(fourth.reason, 'no-package-json');

  // ⑤ 什么都没有 → 不装，且原因指向"没有 package.json"（更根本的那一条）
  assert.equal(judgeStInstall(facts({ hasPackageJson: false, packageJsonText: null, hasServerJs: false })).reason, 'no-package-json');
});

test('判据：package.json 只要求"存在"，坏 JSON + server.js 仍然算装', () => {
  // 需求原文是"package.json 存在 且（scripts 含 start 或 server.js 存在）"。
  // 坏 JSON 满足"存在"，而 `node server.js` 照样能跑 —— 判成没装会让用户
  // 无从下手（他看到的目录结构明明是对的）。
  const verdict = judgeStInstall(facts({ packageJsonText: '{not json', hasServerJs: true }));
  assert.equal(verdict.installed, true);
});

test('判据：未安装时 evidence 必须为空（不能一边说没装一边列命中项）', () => {
  const verdict = judgeStInstall(facts({ packageJsonText: '{"scripts":{}}', hasServerJs: false }));
  assert.equal(verdict.installed, false);
  assert.deepEqual(verdict.evidence, []);
});

test('hasStartScript：空串、缺 scripts、非字符串一律不算', () => {
  assert.equal(hasStartScript('{"scripts":{"start":"node server.js"}}'), true);
  assert.equal(hasStartScript('{"scripts":{"start":"   "}}'), false, '全空白等于没写');
  assert.equal(hasStartScript('{"scripts":{"start":1}}'), false, '非字符串不是 start 脚本');
  assert.equal(hasStartScript('{"scripts":{}}'), false);
  assert.equal(hasStartScript('{}'), false);
  assert.equal(hasStartScript(''), false);
  assert.equal(hasStartScript(null), false);
  assert.equal(hasStartScript('[1,2,3]'), false, '数组没有 scripts');
});

test('判据与 Rust looks_like_st_root 是同一条（源码对拍）', () => {
  // 静态断言而不是跑 Rust：这条要抓的是"有人只改了一边"。
  // 判据表达式必须在两侧都出现，且形状一致。
  assert.ok(
    COMMANDS_RS.includes('facts.package_json && (facts.start_script || facts.server_js)'),
    'Rust 侧判据表达式变了 —— 同步 client/src/session/st-install.ts 的 judgeStInstall',
  );
});

// ── 目录与文件名 ────────────────────────────────────────────

test('characters 目录：<root>/data/default-user/characters，末尾分隔符不影响', () => {
  assert.equal(
    stCharactersDir('C:\\Users\\tester\\SillyTavern'),
    'C:\\Users\\tester\\SillyTavern\\data\\default-user\\characters',
  );
  assert.equal(
    stCharactersDir('C:\\Users\\tester\\SillyTavern\\'),
    'C:\\Users\\tester\\SillyTavern\\data\\default-user\\characters',
    '末尾多了分隔符不该拼出双斜杠',
  );
});

/*
 * 推送文件名（G8 起扩展名是 .png，决策 #212）。
 *
 * 这一组原来是 `.json`：**测试本身没写错**，错的是它守的那个格式 —— ST 的角色目录
 * 扫描不读 .json，所以"文件名取角色名 + 冲突加序号"这件事对用户根本不可见。
 * 改格式必须同时改这里，否则会出现"测试守着一个用户看不到的文件"。
 */
test('推送文件名：角色名取样，冲突加序号且不覆盖（.png）', () => {
  assert.equal(stPushFileName('西奥', []), '西奥.png');
  assert.equal(stPushFileName('西奥', ['西奥.png']), '西奥 (2).png');
  assert.equal(stPushFileName('西奥', ['西奥.png', '西奥 (2).png']), '西奥 (3).png');
});

test('推送文件名：Windows 上大小写不敏感，不能因大小写不同就覆盖', () => {
  // `XIao.png` 与 `xiao.png` 在 Windows 上是同一个文件
  assert.equal(stPushFileName('xiao', ['XIao.png']), 'xiao (2).png');
});

test('推送文件名：非法字符与保留名沿用卡片目录那套规则', () => {
  assert.equal(stPushFileName('a/b:c*?', []), 'abc.png');
  assert.equal(stPushFileName('con', []), '_con.png', 'con.png 永远创建失败，必须加下划线');
  assert.equal(stPushFileName('', []), 'card.png', '空角色名回退 card');
});

// ── 选择与启动方式 ─────────────────────────────────────────

test('chooseStInstall：记忆路径优先，失效则静默回落到扫描结果', () => {
  const a = judgeStInstall(facts({ root: 'C:\\Users\\tester\\SillyTavern' }));
  const b = judgeStInstall(facts({ root: 'C:\\Users\\tester\\SillyTavern-1.13.2' }));

  assert.equal(chooseStInstall([a, b], 'C:\\Users\\tester\\SillyTavern-1.13.2\\')?.root, b.root, '记忆优先（末尾分隔符不该影响匹配）');
  assert.equal(chooseStInstall([a, b], 'C:\\gone')?.root, a.root, '记忆失效时回落到第一个可用项');
  assert.equal(chooseStInstall([a, b], null)?.root, a.root);
  assert.equal(chooseStInstall([], null), null, '一个都没装时返回 null（界面据此走安装指引）');
});

test('samePath：忽略大小写与末尾分隔符', () => {
  assert.equal(samePath('C:\\Users\\A\\SillyTavern', 'c:\\users\\a\\sillytavern\\'), true);
  assert.equal(samePath('C:\\A', 'C:\\B'), false);
});

test('chooseLaunchTarget：有 start.bat 就用它，否则 server.js，都没有返回 null', () => {
  assert.equal(chooseLaunchTarget({ hasStartBat: true, hasServerJs: true }), 'start.bat');
  assert.equal(chooseLaunchTarget({ hasStartBat: false, hasServerJs: true }), 'server.js');
  assert.equal(chooseLaunchTarget({ hasStartBat: false, hasServerJs: false }), null);
});

// ── 状态机文案（T13.6：不许共用一句模糊提示）────────────────

test('四状态文案两两不同，且各自指出下一步', () => {
  const texts = {
    missing: stStatusText('missing'),
    'installed-idle': stStatusText('installed-idle', { root: 'C:\\ST' }),
    running: stStatusText('running'),
    pushed: stStatusText('pushed', { fileName: '西奥.json' }),
  };
  const values = Object.values(texts);
  assert.equal(new Set(values).size, 4, '四个状态必须给出四句不同的话');

  assert.match(texts.missing, /未检测到/);
  assert.match(texts['installed-idle'], /没有运行/);
  assert.match(texts.running, /正在运行/);
  /*
   * pushed 的文案在 G8 改过（决策 #212）：原句「已在 SillyTavern 中就绪，
   * 刷新角色列表即可看到」是需求 T13.6 写的，但那时推的是 JSON —— 而 ST 的
   * 文件夹扫描不读 .json，刷新多少次都看不到。**需求原话在这里是错的断言**，
   * 继续守着它等于把一个假承诺钉进测试。
   * 现在钉的是"必须同时说清 推的是 PNG + 要 F5"这两件事。
   */
  assert.ok(texts.pushed.includes('PNG'), `pushed 文案要点明推的是 PNG，实际：${texts.pushed}`);
  assert.ok(texts.pushed.includes('F5'), `pushed 文案要说明按 F5 刷新，实际：${texts.pushed}`);
  assert.ok(
    !/已在 SillyTavern 中就绪/.test(texts.pushed),
    '旧文案（JSON 时代的"刷新即可看到"）不该回来 —— 它对 PNG 才对，对 JSON 是假的',
  );
});

test('状态文案里带路径/文件名时能看见具体对象', () => {
  assert.match(stStatusText('installed-idle', { root: 'C:\\ST' }), /C:\\ST/);
  assert.match(stStatusText('pushed', { fileName: '西奥.json' }), /西奥\.json/);
});

test('启动失败清单覆盖需求点名的三种原因', () => {
  const joined = ST_LAUNCH_FAILURE_HINTS.join('\n');
  assert.match(joined, /端口 8000/);
  assert.match(joined, /Node 版本/);
  assert.match(joined, /权限/);
});

// ── 等待端口 ───────────────────────────────────────────────

test('waitForStReady：第一次就通不睡觉（不白等一个轮询间隔）', async () => {
  let sleeps = 0;
  const ok = await waitForStReady(async () => true, {
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(ok, true);
  assert.equal(sleeps, 0);
});

test('waitForStReady：超时返回 false 而不是抛错', async () => {
  let now = 0;
  const ok = await waitForStReady(async () => false, {
    timeoutMs: 1000,
    intervalMs: 300,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  assert.equal(ok, false);
  // 300×4 = 1200 ≥ 1000：到点就停，不会无限轮询
  assert.ok(now >= 1000 && now <= 1300, `实际推进 ${now}ms`);
});

test('waitForStReady：中途起来就立刻返回 true', async () => {
  let now = 0;
  let polls = 0;
  const ok = await waitForStReady(
    async () => {
      polls += 1;
      return polls >= 3;
    },
    { timeoutMs: 10_000, intervalMs: 500, now: () => now, sleep: async (ms) => { now += ms; } },
  );
  assert.equal(ok, true);
  assert.equal(polls, 3);
});

// ── 一键安装的地址与落点 ────────────────────────────────────

test('下载地址：默认走官方 release，资产名带版本号', () => {
  const url = stDownloadUrl(null);
  assert.equal(
    url,
    `https://github.com/SillyTavern/SillyTavern/releases/download/${ST_RELEASE.version}/SillyTavern-${ST_RELEASE.version}.zip`,
  );
  assert.equal(stDownloadUrl('   '), url, '空白前缀按"没填"处理');
});

test('下载地址：镜像前缀拼在官方地址前面（含末尾斜杠归一）', () => {
  assert.equal(stDownloadUrl('https://ghfast.top/').startsWith('https://ghfast.top/https://github.com/'), true);
  // 前缀写成不带末尾斜杠也要拼对，不能出现 `tophttps://`
  assert.equal(stDownloadUrl('https://ghfast.top').startsWith('https://ghfast.top/https://github.com/'), true);
});

test('下载地址：前缀格式不对时报错而不是拼一个坏地址', () => {
  // 坏地址在用户那里表现为"下载失败"，根本看不出是前缀写错了
  assert.throws(() => stDownloadUrl('ghfast.top'), /http:\/\/ 或 https:\/\//);
  assert.throws(() => stDownloadUrl('ftp://mirror'), /http:\/\/ 或 https:\/\//);
});

test('一键安装落点：已存在则加 -2，绝不覆盖已有的 ST', () => {
  assert.equal(stInstallTargetDir('C:\\Users\\tester', []), 'C:\\Users\\tester\\SillyTavern');
  assert.equal(
    stInstallTargetDir('C:\\Users\\tester', ['SillyTavern']),
    'C:\\Users\\tester\\SillyTavern-2',
  );
  assert.equal(
    stInstallTargetDir('C:\\Users\\tester', ['SillyTavern', 'SillyTavern-2']),
    'C:\\Users\\tester\\SillyTavern-3',
  );
  // 大小写不敏感：Windows 上 `sillytavern` 与 `SillyTavern` 是同一个目录
  assert.equal(
    stInstallTargetDir('C:\\Users\\tester', ['sillytavern']),
    'C:\\Users\\tester\\SillyTavern-2',
  );
});

test('Node 探测位：覆盖官方 MSI 两个位置 + 用户级安装 + nvm', () => {
  const list = nodeInstallCandidates('C:\\Users\\tester');
  assert.ok(list.includes('C:\\Program Files\\nodejs\\node.exe'));
  assert.ok(list.includes('C:\\Program Files (x86)\\nodejs\\node.exe'));
  assert.ok(list.some((item) => item.endsWith('AppData\\Local\\Programs\\nodejs\\node.exe')));
  assert.ok(list.some((item) => item.endsWith('AppData\\Roaming\\nvm')));
});

// ── 二进制与日志小工具 ──────────────────────────────────────

test('toBase64Chunked 与 Buffer.toString(base64) 逐字节一致', () => {
  // 跨块边界最容易错：取长度正好跨过 32 KiB 的几组
  for (const size of [0, 1, 2, 3, 100, 32767, 32768, 32769, 65536, 100_000]) {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 256;
    assert.equal(
      toBase64Chunked(bytes),
      Buffer.from(bytes).toString('base64'),
      `长度 ${size} 的编码结果不一致`,
    );
  }
});

test('tailOfLog：取末尾、丢空行、统一 CRLF', () => {
  const text = ['line1', '', 'line2\r', 'line3', ''].join('\n');
  assert.equal(tailOfLog(text), 'line1\nline2\nline3');
  assert.equal(tailOfLog('a\nb\nc', 2), 'b\nc', '限制行数时保留最后几行');
  assert.equal(tailOfLog(''), '');
});

test('默认 ST 地址：可解析、端口 8000（v0.1.6 起由配置决定，常量只是默认值）', () => {
  assert.equal(ADDRESS.ok, true);
  assert.equal(ADDRESS.port, 8000);
  assert.equal(ADDRESS.baseUrl, 'http://127.0.0.1:8000');
});

// ── 探测（v0.1.5 生产反馈：ST 在跑却报"未运行"）─────────────

/*
 * 回归样本（用户第 4 条要求）：ST 起在 8000 上、**不发任何 CORS 头**，
 * 而 webview 的 fetch reject —— 修前判"未运行"，修后判"运行中"。
 *
 * 注意"修前/修后"到底差在哪，这里必须说清楚，否则这条测试会变成自我安慰：
 * `mode:'no-cors'` 在 26407bd 里**本来就是**（不是这次才改的），
 * 实测对无 CORS 头的服务也能 resolve（见 `scripts/verify-f15-probe.mjs`）。
 * 真正变了的是**判定依据从"浏览器 fetch 成功"改成"壳侧 TCP 能连上"**。
 *
 * ## 2026-10-27 更正：fetch 失败的原因是响应头，不是网络
 *
 * 这条用例原来附带的解释是"请求在浏览器网络层就没出去（代理/安全软件/本地网络权限）"，
 * **那个解释已被实测推翻**：SillyTavern 的响应带
 *
 * ```text
 * Cross-Origin-Resource-Policy: same-origin
 * ```
 *
 * 浏览器对它的执行方式是"跨源 `no-cors` 读取一律失败"，抛 `TypeError: Failed to fetch` ——
 * 请求发出去了、响应也回来了，fetch 仍然 reject。三组对照（页面源 127.0.0.1:8977）：
 * ST:8000（有 CORP）失败 / 反代剥 XFO 留 CORP 失败 / 反代两者都剥 **成功**。
 *
 * 结论没变（TCP 说了算），但**理由变了**，而理由决定这条测试该断言什么：
 * 不能再断言"webview 里连不上"这种把原因说成网络的话。
 */
test('回归：TCP 通、浏览器 fetch 被挡 → 必须判"运行中"（生产缺陷复现）', async () => {
  const blockedFetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const result = await probeStState({
    address: ADDRESS,
    tcpProbe: async () => ({ alive: true, errorKind: null, errorMessage: null }),
    fetchImpl: blockedFetch,
  });

  assert.equal(result.outcome, 'running', '端口在应答就必须判运行中 —— 修前这里会判未运行');
  assert.equal(result.browserBlocked, true, '要能指出"浏览器那侧读不到"（诊断信息，不参与判定）');

  /*
   * 断言的是**语义**而不是某句原文：必须说明"这是响应头策略、不影响使用"，
   * 并且**不许**把原因说成网络不通（那句错话让排查方向偏过一整轮）。
   * 写成 `/webview 里连不上/` 就是把当时的措辞钉成了期望值 —— 与本项目
   * connect-guide 那条测试同一种病（测试给错误作保）。
   */
  const text = describeProbe(result);
  assert.match(text, /在应答/, 'TCP 通就要说在应答');
  assert.match(text, /响应头|策略/, '要说清是被响应头策略拦的');
  assert.doesNotMatch(text, /连不上|网络不通|被挡/, '不许把原因说成网络问题（已证伪）');
  assert.match(text, /不受影响/, '要说明这不影响推送/浏览器打开');
});

test('回归：TCP 没人听 → 判"没有应答"，且原始错误类型带出来', async () => {
  const result = await probeStState({
    address: ADDRESS,
    tcpProbe: async () => ({
      alive: false,
      errorKind: 'ConnectionRefused',
      errorMessage: 'No connection could be made because the target machine actively refused it. (os error 10061)',
    }),
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });

  assert.equal(result.outcome, 'no-answer');
  assert.match(describeProbe(result), /ConnectionRefused/);
  assert.match(describeProbe(result), /Failed to fetch/, '浏览器侧错误也要进文案（代理环境靠它排查）');
});

test('TCP 到点没回（TimedOut）与"没人听"是两种结局', async () => {
  const timed = await probeStState({
    address: ADDRESS,
    tcpProbe: async () => ({ alive: false, errorKind: 'TimedOut', errorMessage: 'timed out' }),
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(timed.outcome, 'timeout');
  assert.match(describeProbe(timed), new RegExp(String(ST_PROBE_TIMEOUT_MS)));
});

test('探测判定只看 TCP：fetch 成功但 TCP 不通仍是"没有应答"', async () => {
  // 反过来也要钉：别让"fetch 恰好成功"把结论翻成运行中（那说明有人在中转，
  // 而我们探测的是本机端口 —— 以 TCP 为准才自洽）
  const result = await probeStState({
    address: ADDRESS,
    tcpProbe: async () => ({ alive: false, errorKind: 'ConnectionRefused', errorMessage: 'refused' }),
    fetchImpl: async () => new Response('ok'),
  });
  assert.equal(result.outcome, 'no-answer');
});

test('探测请求写死 no-cors + no-store（禁改回默认 cors）', () => {
  // 静态断言：`no-cors` 让"ST 不发 CORS 头"不再构成失败；`no-store` 防缓存把
  // "上次活着"的结论缓存下来。两者都是判据的一部分，不是随手写的选项。
  assert.ok(
    ST_INSTALL_TS.includes("mode: 'no-cors'") && ST_INSTALL_TS.includes("cache: 'no-store'"),
    'probeStState 的 fetch 选项被改了 —— 见决策 #207',
  );
  // 判定不能退回"fetch 成功就算活着"。
  // 注意切法：入参类型里那个 `}` 也在行首，按 `\n}` 截会只切到签名 ——
  // 所以用"下一个 export 之前"这一段，边界更稳。
  const start = ST_INSTALL_TS.indexOf('export async function probeStState(');
  const next = ST_INSTALL_TS.indexOf('export async function probeStRunning(');
  assert.ok(start > 0 && next > start, 'probeStState / probeStRunning 的位置变了');
  const body = ST_INSTALL_TS.slice(start, next);
  assert.ok(
    body.includes('classifyStProbe'),
    'probeStState 必须走 classifyStProbe（判定只看 TCP），不能在原地用 fetch 结果下结论',
  );
});

test('classifyStProbe：三种结局的映射表', () => {
  const base = { baseUrl: 'http://127.0.0.1:8000', browserErrorName: null, browserErrorMessage: null };
  assert.equal(classifyStProbe({ ...base, tcp: { alive: true, errorKind: null, errorMessage: null } }).outcome, 'running');
  assert.equal(
    classifyStProbe({ ...base, tcp: { alive: false, errorKind: 'TimedOut', errorMessage: null } }).outcome,
    'timeout',
  );
  assert.equal(
    classifyStProbe({ ...base, tcp: { alive: false, errorKind: 'ConnectionRefused', errorMessage: null } }).outcome,
    'no-answer',
  );
  // 浏览器报错只有在 TCP 通的时候才算"被挡"
  assert.equal(
    classifyStProbe({
      ...base,
      browserErrorName: 'TypeError',
      tcp: { alive: true, errorKind: null, errorMessage: null },
    }).browserBlocked,
    true,
  );
  assert.equal(
    classifyStProbe({
      ...base,
      browserErrorName: 'TypeError',
      tcp: { alive: false, errorKind: 'ConnectionRefused', errorMessage: null },
    }).browserBlocked,
    false,
  );
});

test('探测：壳侧探测函数抛错时按"没有应答"处理，不把异常漏给界面', async () => {
  const result = await probeStState({
    address: ADDRESS,
    tcpProbe: async () => {
      throw new Error('IPC 断了');
    },
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal(result.outcome, 'no-answer');
  assert.match(describeProbe(result), /IPC 断了/);
});

// ── 启动失败的翻译（生产反馈里"点了没反应"的另一半）────────

test('启动失败：缺 node.exe 时要点明"这个目录没有 start.bat"', () => {
  const text = describeLaunchFailure('server.js', '启动 server.js 失败：程序不存在 (os error 2)');
  assert.match(text, /没有 start\.bat/);
  assert.match(text, /Node\.js LTS/);
  assert.ok(!text.includes('os error 2'), '用户不该看到 os error 码作为唯一信息');
});

test('启动失败：start.bat 找不到时提示可能被杀毒隔离', () => {
  assert.match(
    describeLaunchFailure('start.bat', '启动 start.bat 失败：程序不存在 (os error 2)'),
    /杀毒/,
  );
});

test('启动失败：其它错误原样透传（不猜原因）', () => {
  const raw = '启动 start.bat 失败：拒绝访问 (os error 5)';
  assert.equal(describeLaunchFailure('start.bat', raw), `启动失败：${raw}`);
});

test('端口探测契约：超时两侧同值；默认端口只由 TS 定义（壳不持有）', () => {
  const rustTimeout = /pub const PORT_PROBE_TIMEOUT_MS: u64 = (\d+);/.exec(COMMANDS_RS);
  assert.notEqual(rustTimeout, null, 'Rust 侧没有 PORT_PROBE_TIMEOUT_MS');
  assert.equal(Number(rustTimeout[1]), ST_PROBE_TIMEOUT_MS, '两侧超时不一致会导致"TS 说超时、壳说没超时"');

  /*
   * v0.1.6 / T14.0：**壳里不该再有"默认端口"这个概念**。
   *
   * 地址是配置项，壳只接受调用方传进来的 host/port。壳里留一份默认端口，
   * 就多一个"配置文件说 8001、壳偷偷按 8000 探"的分叉点 —— 而这种分叉
   * 表现为"检测通过但推送失败"，极难归因。
   */
  assert.ok(!COMMANDS_RS.includes('ST_DEFAULT_PORT'), '壳里还留着 ST_DEFAULT_PORT —— 默认值只允许在 TS 的契约层');
});
