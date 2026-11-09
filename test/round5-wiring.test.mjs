/**
 * 第五批三问题点的断言（2026-10-31）。
 *
 * ## 这组测试守什么
 *
 * 用户报的三条，根因都是"**接线断了但没人发现**"：
 *
 * 1. `StChatBridge.connect()` 全库零调用 ⇒ 所有 ST 命令返回 `StUnavailable`
 *    ⇒ `String(对象)` 得到 `[object Object]`
 * 2. 测试卡生成函数零调用 + `onPickCharacter` 硬编码 `null` ⇒ 选不到卡
 * 3. UI 把"设置读失败"归因成"服务没起来" ⇒ 用户去查引擎什么也查不到
 *
 * 所以这里既测**纯函数行为**（错误渲染、状态归因、列表解析），
 * 也测**接线是否存在**（connect 有没有被调、baseUrl 有没有被存/被带出去）。
 *
 * 只测前者的话，接线再次断掉不会有任何测试变红 —— 而"接线断掉"才是这次的病。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeBridgeError, formatBridgeError } from '../shared/dist/chat/bridge-error.js';
import { parseCharacterList } from '../shared/dist/chat/character-list.js';
import {
  describeSettingsFailure,
  parseEngineStatus,
} from '../shared/dist/chat/engine-status.js';
import { buildGenerateRequest } from '../shared/dist/chat/generate.js';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = join(REPO, 'client/src');
const KT = join(
  REPO,
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine',
);

const read = (rel) => readFileSync(join(CLIENT, rel), 'utf8');

/** 剥注释：大量"不许出现 X"的断言会被注释里的 X 误伤（前几批反复踩） */
function codeOnly(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ═══════════════════════════════════════════════════════════
   问题一 A：`[object Object]` 不许再出现（展示层）
   ═══════════════════════════════════════════════════════════ */

/** Tauri 拒绝时交给前端的真实形状（`error.rs:198` 的 Serialize） */
const SHELL_ERROR = {
  code: 'ST_UNAVAILABLE',
  message: '还没连上 SillyTavern。先点一次「连接」',
};

test('★★ 问题一：`{code,message}` 对象必须被拆开，不许出 [object Object]', () => {
  /*
   * 这是用户报的第一个症状。原来的两处渲染都是
   *   `error instanceof Error ? error.message : String(error)`
   * 而 Tauri 给的是普通对象 ⇒ `String()` ⇒ `"[object Object]"`。
   */
  const described = describeBridgeError(SHELL_ERROR);

  assert.equal(described.kind, 'engine');
  assert.equal(described.code, 'ST_UNAVAILABLE');
  assert.equal(described.message, '还没连上 SillyTavern。先点一次「连接」');
  assert.ok(described.hint !== undefined && described.hint !== '', '要给出下一步做什么');
});

test('★★ 任何错误形态都不许产出 [object Object]', () => {
  /*
   * 五种形态逐个过。用户要求"不许出现 [object Object] 这类把错误对象
   * 直接字符串化的输出" —— 这是**兜底判据**，不针对某一种形状。
   */
  const shapes = [
    SHELL_ERROR,
    { code: 'ST_HTTP_STATUS', message: '上游 500' },
    { code: 'SOMETHING_NEW', message: '' }, // 未知码、空 message
    { foo: 1, bar: 2 }, // 没有 code/message 的对象
    [1, 2, 3], // 数组
    new Error('普通 Error'),
    '纯字符串错误',
    42,
    null,
    undefined,
    {}, // 空对象
  ];

  for (const shape of shapes) {
    const text = formatBridgeError(shape);
    assert.equal(
      text.includes('[object Object]'),
      false,
      `形态 ${JSON.stringify(shape)} 产出了 [object Object]：${text}`,
    );
    // 也不许是"保存失败："后面什么都没有
    assert.ok(text.length > '保存失败：'.length + 1, `形态 ${JSON.stringify(shape)} 的文案是空的：${text}`);
  }
});

test('★ 分类要有区分度（下一步动作不同的不许混成一句）', () => {
  /*
   * 用户要求"显示可归因的明确原因（分类文案）"。
   * 分类不是装饰：engine / auth / upstream 的下一步动作完全不同。
   */
  const engine = describeBridgeError({ code: 'ST_UNAVAILABLE', message: 'x' });
  const auth = describeBridgeError({ code: 'ST_FORBIDDEN', message: 'x' });
  const upstream = describeBridgeError({ code: 'ST_HTTP_STATUS', message: 'x' });

  assert.equal(engine.kind, 'engine');
  assert.equal(auth.kind, 'auth');
  assert.equal(upstream.kind, 'upstream');

  // 三者的建议不许相同（相同就等于没分类）
  const hints = [engine.hint, auth.hint, upstream.hint];
  assert.equal(new Set(hints).size, 3, '三类错误的建议必须各不相同');
});

test('★ 没有 code 的对象也要把内容露出来（用 JSON，不用 String）', () => {
  const described = describeBridgeError({ foo: 1, bar: 'x' });
  assert.match(described.message, /foo/, '必须带出对象的字段内容');
});

/* ═══════════════════════════════════════════════════════════
   问题一 B：展示层不许再出现裸 String(error)
   ═══════════════════════════════════════════════════════════ */

test('★★ 源码里不许再有 `String(error)` 式的错误渲染', () => {
  /*
   * 光有 `describeBridgeError` 不够 —— 必须确认**调用点也换了**。
   * 第一版就是"两处各写一份"，改一处漏一处。
   */
  const apiPage = codeOnly(read('chat/api-page.ts'));
  const bridge = codeOnly(read('chat/st-bridge.ts'));

  assert.doesNotMatch(
    apiPage,
    /String\(\s*error\s*\)/,
    'api-page 不许再 String(error)（那会产出 [object Object]）',
  );
  assert.doesNotMatch(
    bridge,
    /return\s+String\(\s*error\s*\)/,
    'st-bridge 不许再 String(error)',
  );

  assert.match(apiPage, /describeBridgeError/, 'api-page 要走统一渲染');
  assert.match(bridge, /describeBridgeError/, 'st-bridge 要走统一渲染');
});

/* ═══════════════════════════════════════════════════════════
   问题一 C：connect 接线（三项修复的共同根因）
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题一/三：外壳必须真的调 bridge.connect（此前全库零调用）', () => {
  /*
   * 取证：`grep -rn "\.connect(" client/src/` 只有 login-dialog 与 recorder。
   * `StChatBridge.connect()` 定义在 st-bridge.ts:78，**没有任何调用方**。
   * 于是 Rust 侧 `StChatState.api` 恒为 None ⇒ 所有命令返回 StUnavailable。
   */
  const shell = codeOnly(read('chat/shell.ts'));

  assert.match(shell, /await this\.bridge\.connect\(/, '必须真的调用 connect');
  assert.match(shell, /private async ensureConnected/, '要有连接门');
  assert.match(shell, /this\.options\.stBaseUrl/, '要用 stBaseUrl（此前是死字段）');
});

test('★★ stBaseUrl 不许再是死字段', () => {
  const shell = codeOnly(read('chat/shell.ts'));
  const uses = [...shell.matchAll(/this\.options\.stBaseUrl/g)];
  assert.ok(uses.length >= 1, 'stBaseUrl 必须被读取（此前只声明、从不使用）');
});

test('★ 连接门要包住读设置、写设置、播种、拉角色', () => {
  /*
   * 只在某一处过连接门是不够的 —— 别处仍然会拿到 StUnavailable。
   */
  const shell = codeOnly(read('chat/shell.ts'));

  const gated = [...shell.matchAll(/this\.withConnection\(/g)].length;
  assert.ok(gated >= 4, `至少要包住四处（实际 ${String(gated)} 处）`);

  assert.match(shell, /getRaw: \(\) => this\.withConnection/, 'mutateSettings 的读要走连接门');
  assert.match(shell, /save: \(settings\) => this\.withConnection/, 'mutateSettings 的写要走连接门');
});

test('★ ST_UNAVAILABLE 要清掉连接标记（否则永远不重连）', () => {
  const shell = codeOnly(read('chat/shell.ts'));
  assert.match(
    shell,
    /described\.code === 'ST_UNAVAILABLE'[\s\S]{0,80}this\.connected = false/,
    '观察到 ST_UNAVAILABLE 必须重置连接状态',
  );
});

/* ═══════════════════════════════════════════════════════════
   问题一 D：地址 + key + 模型名能存、能带出去
   ═══════════════════════════════════════════════════════════ */

test('★★ 自定义地址必须进状态并持久化（此前连存都没存）', () => {
  /*
   * 取证：`onSave({source, model})` 不含 baseUrl，它只活在页面内的
   * `drafts` Map 里，切 Tab 就丢。用户明确要求"地址 + key + 模型名能存"。
   */
  const apiPage = codeOnly(read('chat/api-page.ts'));
  assert.match(apiPage, /baseUrl: string;/, 'ApiPageState 要有 baseUrl');
  assert.match(apiPage, /baseUrl: rawBaseUrl/, 'onSave 要带上 baseUrl');

  const main = codeOnly(read('mobile/main.ts'));
  assert.match(main, /baseUrl:/, 'localStorage 白名单要含 baseUrl');
});

test('★★ 自定义地址要随请求体发出去（custom_url）', () => {
  /*
   * 契约 §3.2：`custom_url` 属于**请求体**，服务端不读设置。
   * 只存不发 = 用户填了地址、保存成功、生成时仍然用旧地址。
   */
  const built = buildGenerateRequest({
    source: 'custom',
    model: '[次0.2]claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    customUrl: 'https://ai.ota1245.top/v1',
  });

  assert.equal(built.ok, true);
  if (built.ok) {
    assert.equal(built.request.custom_url, 'https://ai.ota1245.top/v1');
    // 带方括号的模型名必须原样带出去（用户专门提了这个）
    assert.equal(built.request.model, '[次0.2]claude-opus-4-8');
  }
});

test('★ 非 custom 源不许带 custom_url', () => {
  const built = buildGenerateRequest({
    source: 'openai',
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hi' }],
    customUrl: 'https://example.invalid/v1',
  });
  assert.equal(built.ok, true);
  if (built.ok) assert.equal(built.request.custom_url, undefined);
});

test('★ 自定义源没填地址要拦下来（不许"保存成功"却不知道发给谁）', () => {
  const apiPage = codeOnly(read('chat/api-page.ts'));
  assert.match(
    apiPage,
    /currentSource === 'custom' && rawBaseUrl === ''/,
    '自定义源必须校验地址非空',
  );
});

/* ═══════════════════════════════════════════════════════════
   问题二：测试卡补种 + 选卡器
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   问题二（已反转）：测试卡**不许**再进发布包（2026-11-07 收尾）

   原文（2026-10-31）要求「必须有 TestCardSeeder + 必须播种」。
   那时测试卡是**功能缺口**的填充：ST 首启没角色，用户看到空列表。

   0.1.7 收尾时反过来 —— 它成了**发布包里不该有的东西**：
   每个装包的人第一次打开都会看到一个叫「测试用-夜航小助手」的角色，
   以为那是产品自带内容。

   所以下面这组断言全部反向：不许有播种、不许有 assets、不许有生成器。
   保留它们（而不是删掉）的理由：**防止以后有人为了调试又加回来**。
   ═══════════════════════════════════════════════════════════ */

test('★★★★ 服务启动流程不许再补种测试卡（发布包不该带测试角色）', () => {
  /*
   * 剥注释再查 —— 这条规则的说明文字里就写着 `TestCardSeeder.seed`，
   * 而本项目被注释误伤过很多次（凡"出现/位置"类断言一律先剥注释）。
   */
  const service = readFileSync(join(KT, 'StService.kt'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(
    service,
    /TestCardSeeder/,
    '服务启动流程不许出现 TestCardSeeder（发布包不该自动塞测试卡）',
  );
});

test('★★★★ TestCardSeeder.kt 已删除（不给"以后再打开"留开关）', () => {
  /*
   * 留着类、只注释掉调用 = 留一个随时会被人打开的开关。
   * 收尾就要真删：要再造测试卡走「卡片 → 导入」那条正式路径。
   */
  assert.equal(
    existsSync(join(KT, 'TestCardSeeder.kt')),
    false,
    'TestCardSeeder.kt 应当已删除',
  );
});

test('★★★★ APK 的 assets 里不许有测试卡（788KB 的 PNG）', () => {
  /*
   * 这一条是真正决定"用户装完看到什么"的：`assets/` 会被原样打进 APK。
   * 源码删干净了但 assets 里还留着 PNG，装上去照样能播。
   */
  const assetsDir = join(
    REPO,
    'client/src-tauri/gen/android/app/src/main/assets',
  );
  assert.equal(
    existsSync(join(assetsDir, 'test-card')),
    false,
    'assets/test-card/ 应当已删除',
  );
});

test('★★★★ 测试卡生成器与它的构建脚本都删掉了', () => {
  assert.equal(
    existsSync(join(REPO, 'shared/src/android/test-card.ts')),
    false,
    'shared/src/android/test-card.ts 应当已删除',
  );
  assert.equal(
    existsSync(join(REPO, 'scripts/build-test-card.mjs')),
    false,
    'scripts/build-test-card.mjs 应当已删除',
  );
});

test('★★ 选卡器不许再硬编码返回 null', () => {
  /*
   * `onPickCharacter: async () => null` ⇒ 点「选择角色」什么都不会发生。
   * 卡落库了也选不到 —— 这是用户报的现象的另一半。
   */
  const shell = codeOnly(read('chat/shell.ts'));

  assert.doesNotMatch(
    shell,
    /onPickCharacter:\s*async\s*\(\)\s*=>\s*null/,
    '选卡器不许硬编码返回 null',
  );
  assert.match(shell, /renderCharacterPicker/, '要真的打开选卡页');
});

test('★★ 选卡器的两条关闭路径都要 resolve promise', () => {
  /*
   * 只 resolve 一条的话：用户点返回 ⇒ promise 永挂 ⇒ 按钮再也点不动
   * （第二次点击的 promise 排队等第一次）。这类"点一次能用、第二次没反应"
   * 最容易被当成玄学。
   */
  const shell = codeOnly(read('chat/shell.ts'));
  const resolves = [...shell.matchAll(/resolve\?\.\(/g)];
  assert.ok(resolves.length >= 2, `选中与返回都要 resolve（实际 ${String(resolves.length)} 处）`);
});

test('★★ 角色列表解析：裸数组 + avatar 才是文件标识', () => {
  const parsed = parseCharacterList(
    JSON.stringify([
      { name: '测试用-夜航小助手（测试）', avatar: '测试用-夜航小助手.png', chat: '' },
      { name: 'Seraphina', avatar: 'default_Seraphina.png', chat: 'Seraphina - 2023' },
    ]),
  );

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.items.length, 2);
  // avatar 是后续接口要用的标识，不是 name
  assert.equal(parsed.items[0].avatar, '测试用-夜航小助手.png');
  assert.equal(parsed.items[0].lastChat, '');
  assert.equal(parsed.items[1].lastChat, 'Seraphina - 2023');
});

test('★ 空数组是合法状态（"还没有角色"不是错误）', () => {
  const parsed = parseCharacterList('[]');
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.items, []);
});

test('★ 缺 avatar 的条目跳过，缺 name 的用文件名兜底', () => {
  const parsed = parseCharacterList([{ name: 'no avatar' }, { avatar: 'x.png' }]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.items.length, 1, '缺 avatar 的要跳过（后续接口用不了）');
    assert.equal(parsed.items[0].name, 'x', '缺 name 要用文件名兜底，不能丢这一条');
  }
});

test('★ 不是数组要报失败（形状变了要能发现）', () => {
  const parsed = parseCharacterList('{"data":[]}');
  assert.equal(parsed.ok, false);
});

/* ═══════════════════════════════════════════════════════════
   问题三：引擎状态判定必须真实
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题三：引擎在跑但读失败时，文案不许说"服务没起来"', () => {
  /*
   * 这是用户明确报的错判：
   *   「引擎实际在跑、UI 却读不到 …… 与 UI 判定不一致，这一点必须查清」
   *
   * 归因错在这里：UI 那句"可能是内嵌服务还没起来"判的是"能不能读设置"，
   * 而不是"引擎在不在跑"。引擎明明 pid 在、8000 LISTEN、/version 正常。
   */
  const running = {
    ready: true,
    port: 8000,
    rssMb: 180,
    unpacked: true,
    running: true,
    error: null,
  };

  const note = describeSettingsFailure(running, '还没连上 SillyTavern');

  assert.equal(note.cause, 'read-failed', '引擎在跑时归因必须是 read-failed');
  assert.equal(
    note.message.includes('没起来'),
    false,
    `引擎在跑，文案不许说"没起来"。实际：${note.message}`,
  );
  assert.match(note.message, /引擎在运行|在跑/, '要如实说引擎在运行');
  // 端口要出现在文案里 —— 那是用户能去核对的东西
  assert.match(note.message, /8000/, '要把端口露出来（用户可据此核对）');
});

test('★★ 引擎确实没跑时才说"没起来"', () => {
  const down = { ready: false, port: 8000, rssMb: 0, unpacked: true, running: false, error: null };
  const note = describeSettingsFailure(down);
  assert.equal(note.cause, 'engine-down');
  assert.match(note.message, /没起来/);
});

test('★ 进程在但端口没就绪：单独一种说法', () => {
  const starting = { ready: false, port: 8000, rssMb: 120, unpacked: true, running: true, error: null };
  const note = describeSettingsFailure(starting);
  assert.equal(note.cause, 'engine-down');
  assert.match(note.message, /进程在|还没就绪/);
  // 要告诉用户"首次启动要几十秒"——否则他会以为卡死了
  assert.match(note.hint, /几十秒|等/);
});

test('★★ 拿不到引擎状态时不许假装"引擎没起来"', () => {
  /*
   * 桌面端/浏览器没有 `__ST_ENGINE__`（传 null）。
   * 此时说"引擎没起来"是错的 —— 桌面端的 ST 是用户自己在外面起的。
   */
  const note = describeSettingsFailure(null, '连接失败');

  assert.equal(note.cause, 'unknown', '没有状态源时归因只能是 unknown');
  assert.equal(note.message.includes('没起来'), false, '不许猜"没起来"');
});

test('★ parseEngineStatus：解析失败返回 null，不伪造默认值', () => {
  assert.equal(parseEngineStatus(undefined), null);
  assert.equal(parseEngineStatus(''), null);
  assert.equal(parseEngineStatus('not json'), null);
  assert.equal(parseEngineStatus('{"port":8000}'), null, '缺 ready 字段要判失败');

  const ok = parseEngineStatus(
    JSON.stringify({ ready: true, port: 8001, rssMb: 180, unpacked: true, running: true, error: null }),
  );
  assert.equal(ok.ready, true);
  assert.equal(ok.port, 8001);
});

test('★★ 引擎状态要接到真实来源（Android JS 桥），且缺桥时不伪造', () => {
  const main = codeOnly(read('mobile/main.ts'));

  assert.match(main, /__ST_ENGINE__/, '要读 Android 注入的桥');
  assert.match(main, /parseEngineStatus/, '要用统一解析（不各写一份）');
  /*
   * 缺桥返回 null —— 断言的是"返回 null"这个分支存在，
   * 且没有 `?? {ready:false}` 之类的伪造。
   */
  assert.doesNotMatch(main, /ready:\s*false/, '不许伪造 ready:false');
});

test('★ 设置页不许再写死"可能是内嵌服务还没起来"', () => {
  /*
   * 那句写死的文案就是错判的载体。页面自己没有归因能力，
   * 必须交给外壳按"引擎真实状态 + 读失败原因"组合。
   */
  const settings = codeOnly(read('chat/chat-settings.ts'));

  assert.doesNotMatch(
    settings,
    /可能是内嵌服务还没起来/,
    '不许写死"服务没起来"（那正是被报的错判）',
  );
  assert.match(settings, /describeReadFailure/, '要向外壳要真实归因');
});

/* ═══════════════════════════════════════════════════════════
   顺带抓到的真缺陷：切换接口源后面板累积
   ═══════════════════════════════════════════════════════════ */

test('★★ 切换接口源后，旧面板必须被清空（data-role 要保持唯一）', () => {
  /*
   * 真机 CDP 探测到的现场：
   *   1 展开 openai → modelInputs: [ {v:"gpt-4o-mini"} ]        ← 1 个
   *   2 点 custom   → modelInputs: [ {v:"gpt-4o-mini"}, {v:""} ] ← 2 个
   *
   * 页面上看不出（旧的 hidden），但 `data-role="model-input"` 不再唯一。
   * 危害：任何按 data-role 取输入的自动化会拿到**隐藏的那个**，
   * 表现为"填了值但保存说没填"。
   *
   * 原实现只在 `source === null`（全部收起）时清面板 —— 切换时不清。
   * 这条断言钉的是"**每次** expandSource 都清"。
   */
  const apiPage = codeOnly(read('chat/api-page.ts'));
  const fn = apiPage.slice(apiPage.indexOf('const expandSource'), apiPage.indexOf('syncSelection();', apiPage.indexOf('const expandSource')));

  assert.match(
    fn,
    /for \(const row of sourceRows\) row\.panel\.replaceChildren\(\);/,
    'expandSource 必须无条件清空所有面板（不能只在 source===null 时清）',
  );
});

test('★ 清空面板后必须把输入指针置空（防止指向已移除的元素）', () => {
  const apiPage = codeOnly(read('chat/api-page.ts'));
  const fn = apiPage.slice(apiPage.indexOf('const expandSource'), apiPage.indexOf('syncSelection();', apiPage.indexOf('const expandSource')));

  for (const name of ['modelInput', 'keyInput', 'baseUrlInput', 'currentPanelHost']) {
    assert.match(fn, new RegExp(name + ' = null'), `清空后要把 ${name} 置空`);
  }
});

/* ═══════════════════════════════════════════════════════════
   真机端到端抓到的两个缺陷（选中结果丢失 / 成功无反馈）
   ═══════════════════════════════════════════════════════════ */

test('★★ 选中的角色必须由外壳持有（面板会被重建）', () => {
  /*
   * 真机实测：选卡器关掉了，聊天页却仍显示「还没有对话 / 先选一个角色」。
   *
   * 根因：`onPick` 先 `renderPage()` 再 `resolve(结果)` —— 重绘时
   * `ChatPanel` 被 dispose 并新建，`avatar` 回到 null；而 resolve 交给的是
   * **已被移除的旧面板**，它设的 `this.avatar` 落在不在 DOM 上的对象里。
   *
   * 修法：结果记在外壳（与 voiceExpanded / chatSettingsRoute 同一条纪律）。
   */
  const shell = codeOnly(read('chat/shell.ts'));

  assert.match(shell, /private selectedCharacter:/, '选择结果要记在外壳');
  assert.match(
    shell,
    /this\.selectedCharacter = \{ avatar: character\.avatar/,
    'onPick 要把它记下来',
  );
  /*
   * ★ 这条原来只要求传 `avatar`，于是"副标题说未选择"这个缺陷**通过了判据**
   *   （2026-11-01 第七批问题一）。
   *
   * 教训：判据要断言"恢复的是**完整状态**"，不是"恢复了某个字段"。
   * 现在必须连 `name` 一起传 —— 因为 `newChat()` 会把 `fileName` 置空，
   * 副标题在"刚选完角色还没聊"时唯一能靠的就是角色名。
   */
  assert.match(
    shell,
    /panel\.newChat\(this\.selectedCharacter\.avatar,\s*this\.selectedCharacter\.name\)/,
    'renderChat 恢复时要连角色名一起传（只传 avatar 会让副标题退回"未选择聊天"）',
  );
});

test('★★ 保存成功后必须有可见反馈（重绘会把 status 换掉）', () => {
  /*
   * 真机实测：保存其实成功了（localStorage 里 source/model/baseUrl 三个字段都对），
   * 但界面上一片空白 —— 因为成功路径会 `renderPage()` 重绘（副标题要变），
   * 旧 `status` 元素被替换，写在上面的"已保存"用户看不到。
   *
   * 失败路径反而看得到（抛错就不会重绘）——
   * **成功没提示、失败有提示**这种不对称，用户会以为点了没成功。
   */
  const shell = codeOnly(read('chat/shell.ts'));
  const apiPage = codeOnly(read('chat/api-page.ts'));

  assert.match(shell, /pendingApiNotice/, '外壳要记一条重绘后显示的提示');
  assert.match(apiPage, /notice\?:\s*string/, 'api-page 要接收这条提示');
  assert.match(apiPage, /callbacks\.notice/, '渲染时要用它填 status');
});

/* ═══════════════════════════════════════════════════════════
   ★★ 真机端到端抓到的第 6 个缺陷：流式文本被静默丢弃
   ═══════════════════════════════════════════════════════════ */

test('★★ bridge.generate 必须从 startStreaming 起（否则每一帧文本都被丢）', () => {
  /*
   * 真机现象：请求发出去了、ST 也流式回了帧（logcat 里能看到
   * "Streaming request in progress"），但气泡里只有一个时间戳，一个字都没有。
   *
   * 根因：`applyStreamEvent` 有一道门（`stream.ts:84`）——
   *   `if (state.phase !== 'streaming' && state.phase !== 'stopping') return state;`
   * 而 `bridge.generate` 里写的是 `let state = createStreamState();`
   * —— 那个函数的 phase 是 **`'idle'`**，于是**每一个文本帧都被静默丢掉**。
   *
   * ★ 为什么单测没抓到：`test/stream.test.mjs` 测的是 `applyStreamEvent`
   * 本身（直接传 `startStreaming()` 的状态），而**桥接这条路径从来没被跑过**。
   * 典型的"零件都对、装配错了"——只能靠端到端或这类接线断言抓。
   */
  const bridge = codeOnly(read('chat/st-bridge.ts'));

  const fn = bridge.slice(bridge.indexOf('async generate('), bridge.indexOf('async abort('));
  assert.ok(fn.length > 200, '找不到 generate 方法');

  assert.match(fn, /let state = startStreaming\(\)/, 'generate 内部状态必须从 startStreaming 起');
  assert.doesNotMatch(
    fn,
    /let state = createStreamState\(\)/,
    '不许用 createStreamState（phase 是 idle，文本会被丢弃）',
  );
});

test('★ 这条缺陷的边界：applyStreamEvent 在 idle 下确实丢文本', async () => {
  /*
   * 把"为什么必须修"钉在行为上，不只是钉一行源码。
   * 这样即使将来 `createStreamState` 改了实现，这条也能提醒。
   */
  const stream = await import('../shared/dist/chat/stream.js');

  const idle = stream.createStreamState();
  const afterIdle = stream.applyStreamEvent(idle, { type: 'text', text: '你好' });
  assert.equal(afterIdle.text, '', 'idle 状态下文本必须被丢弃（这是设计，不是 bug）');

  const live = stream.startStreaming();
  const afterLive = stream.applyStreamEvent(live, { type: 'text', text: '你好' });
  assert.equal(afterLive.text, '你好', 'streaming 状态下文本要累积');
});

/* ═══════════════════════════════════════════════════════════
   流式事件：Rust 序列化字段 vs 前端读取字段（跨语言契约）
   ═══════════════════════════════════════════════════════════ */

test('★★ 流式事件的 streamId 字段：Rust 必须显式 rename', () => {
  /*
   * 2026-11-01 真机抓到的真缺陷：
   *
   * Rust 的 `#[serde(tag = "type", rename_all = "camelCase")]` 里，
   * `rename_all` 只作用于**变体名**（Frame → "frame"），
   * **不作用于字段名**。所以发出去的是 `{type:"frame", stream_id:1}`，
   * 而前端读 `payload.streamId` → `undefined`。
   *
   * 于是 `payload.streamId !== target[0]` 永远成立 →
   * **每一帧都被静默丢弃**，`done` 也丢 →
   * `done` promise 永不 resolve → 气泡一直是空的、面板卡在 streaming。
   *
   * 现象：消息发出去了、ST 日志显示流式回复了、界面一个字都没有。
   *
   * 为什么既有测试全绿：`test/stream.test.mjs` 直接喂 TS 形状的事件，
   * 从不经过 Rust 的序列化。**两边各自"对"，拼起来是错的。**
   */
  const rust = readFileSync(join(REPO, 'client/src-tauri/src/st_chat.rs'), 'utf8');
  const enumBody = rust.slice(rust.indexOf('pub enum StreamEvent'), rust.indexOf('/// 一个正在跑的生成任务'));

  const renames = [...enumBody.matchAll(/rename = "streamId"/g)].length;
  assert.ok(
    renames >= 3,
    `Frame / Done / Error 三个变体都要 rename = "streamId"（实际 ${String(renames)} 处）`,
  );

  // 前端侧读的必须是 streamId（两边同名才配得上）
  const bridge = codeOnly(read('chat/st-bridge.ts'));
  assert.match(bridge, /streamId: number/, '前端 RawStreamEvent 用 streamId');
  assert.match(bridge, /payload\.streamId/, '前端按 payload.streamId 匹配');
});

test('★ 每个 stream_id 字段都必须带 rename（不靠数量，逐个看）', () => {
  /*
   * 上一条断言"rename 出现 3 次"。这一条换成**逐个检查**：
   * 源码里每一处 `stream_id: u64` 的前一整段里必须有 `rename = "streamId"`。
   *
   * ## 为什么不再做"字段级全比对"
   *
   * 我第一版写了一条"把 Rust 字段名抓出来与前端 TS 接口逐一比对"的断言，
   * 用正则解析 Rust 源码 —— 而 rename 属性上面有一大段注释，
   * 正则当场没匹配到，报出"Rust 侧没有 streamId"，**而源码是对的**。
   *
   * 用正则解析 Rust 结构是错的方向（本项目在走查 7 已经吃过同类的亏）。
   * 换成这条**位置相关**的检查：不看结构，只看"每个字段声明附近有没有 rename"。
   */
  const rust = readFileSync(join(REPO, 'client/src-tauri/src/st_chat.rs'), 'utf8');
  const enumBody = rust.slice(rust.indexOf('pub enum StreamEvent'), rust.indexOf('/// 一个正在跑的生成任务'));

  const declarations = [...enumBody.matchAll(/stream_id:\s*u64/g)];
  assert.ok(declarations.length >= 3, `应有 3 处 stream_id（实际 ${String(declarations.length)}）`);

  for (const decl of declarations) {
    const at = decl.index ?? 0;
    // 往前看 400 字符（够跨过注释块），必须能找到 rename
    const before = enumBody.slice(Math.max(0, at - 400), at);
    assert.match(
      before,
      /rename = "streamId"/,
      `第 ${String(at)} 字符处的 stream_id 声明缺少 rename = "streamId"`,
    );
  }
});

/* ═══════════════════════════════════════════════════════════
   DOM children 的真实形状（stub 过宽容导致的假绿）
   ═══════════════════════════════════════════════════════════ */

test('★★ children 的类型不许是数组（真实 DOM 是 HTMLCollection）', () => {
  /*
   * 2026-11-01 真机抓到的崩溃：
   *
   * ```
   * TypeError: this.listEl.children.find is not a function
   *     at patchStreamingMessage
   * ```
   *
   * 每收到一帧就抛一次 —— 消息发出去了、ST 回了 7 帧、`done` 也发了，
   * 但气泡里**一个字都没有**，呼吸点一直转。
   *
   * 根因是类型声明骗了编译器：`ElLike.children` 原来写的是 `ElLike[]`，
   * 而真实 DOM 的 `children` 是 `HTMLCollection`（**没有** `.find`）。
   * TypeScript 放行了 `children.find(...)`，运行时才炸。
   *
   * 为什么单测全绿：测试用 30 行 stub 当 `doc`，stub 的 `children`
   * 是**真数组** —— `.find()` 有。**stub 比真实 DOM 更宽容**，
   * 于是判据在一个更宽松的世界里通过了。
   */
  const view = codeOnly(read('chat/chat-view.ts'));

  assert.doesNotMatch(
    view,
    /children:\s*ElLike\[\]/,
    'children 不许声明成 ElLike[]（真实是 HTMLCollection，没有数组方法）',
  );
  assert.match(view, /children:\s*ChildList/, 'children 要用 ChildList');
  assert.match(view, /interface ChildList/, '要有 ChildList 定义');
  assert.match(view, /\[Symbol\.iterator\]/, 'ChildList 必须可迭代（HTMLCollection 可迭代）');
});

test('★★ 不许直接对 children 调数组方法（要 Array.from）', () => {
  /*
   * 类型改了还不够 —— 得确认实际代码里没有残留的直接调用。
   *
   * 允许 `Array.from(x.children).find(...)` 与 `[...x.children]`，
   * 禁止 `x.children.find(...)` / `.some(...)` / `.map(...)`。
   */
  const files = ['chat/chat-panel.ts', 'chat/shell.ts', 'chat/api-page.ts', 'chat/chat-settings.ts'];

  for (const file of files) {
    let src;
    try {
      src = codeOnly(read(file));
    } catch {
      continue;
    }

    const bad = [...src.matchAll(/\.children\.(find|some|map|filter|forEach|reduce|slice)\b/g)];
    assert.deepEqual(
      bad.map((m) => m[0]),
      [],
      `${file} 里对 children 直接调了数组方法（真实 DOM 会抛 TypeError）：${bad.map((m) => m[0]).join(', ')}`,
    );
  }
});

test('★★ 流式补丁必须走 Array.from（这条是上面那条的具体落点）', () => {
  const panel = codeOnly(read('chat/chat-panel.ts'));
  const fn = panel.slice(panel.indexOf('private patchStreamingMessage'));

  assert.match(
    fn,
    /Array\.from\(this\.listEl\.children\)/,
    'patchStreamingMessage 必须 Array.from(listEl.children)',
  );
  assert.match(fn, /Array\.from\(bubble\.children\)/, '呼吸点检查也要 Array.from');
});
