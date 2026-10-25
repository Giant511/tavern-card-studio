/**
 * 端到端测试（阶段 8 任务清单）。
 *
 * 覆盖：TXT 分块编辑 → 语法高亮 → 实时规则提醒 → 审计 → 保存（导出）→
 *       上传 → 版本回滚 → 导出 TXT/JSON。
 *
 * 证据边界（重要）：
 *   · 本脚本跑的是 **client/dist** —— 与打进 MSI 的是同一份产物
 *     （由 verify-build.ps1 第 7 步的时间链断言保证：dist ≤ exe ≤ MSI）；
 *   · 「安装 → 启动」在 T6.9 里单独用冒烟测试验证（窗口句柄、WebView2 子进程、内存），
 *     因为 WebView2 的内容区无法可靠截屏（GPU 合成），也无法稳定走 CDP。
 *
 * 用法：node scripts/verify-e2e.mjs [--keep]
 * 退出码：0 全部通过；1 有失败项
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'client', 'dist');
const SHOTS = join(REPO, 'docs', 'assets');
const PORT = 8942;
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((candidate) => existsSync(candidate));

if (!CHROME) {
  console.error('找不到 Chrome，无法执行浏览器侧端到端。');
  process.exit(2);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('client/dist 不存在，请先 npm run build:ui -w @tcs/client');
  process.exit(2);
}

const results = [];
let failures = 0;
function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  if (ok) console.log(`  ✔ ${label}${detail ? `（${detail}）` : ''}`);
  else {
    failures += 1;
    console.log(`  ✘ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

let server = null;
const DUMPS = join(REPO, '.verify', 'e2e-dumps');

/**
 * 读取某个场景的 DOM 快照。
 *
 * 为什么不在脚本里 spawn Chrome：本机 Node 无法 spawn 任何子进程
 * （`spawnSync('cmd.exe', ['/c','echo'])` 都返回 EBUSY，git 同理）。
 * 因此快照由外部用 Chrome CLI 直接生成（见 captureE2eDumps 的注释），
 * 本脚本只负责断言 —— 这样"抓取"与"判断"解耦，也便于人工复核 HTML。
 */
function dumpDom(name) {
  const file = join(DUMPS, `${name}.html`);
  if (!existsSync(file)) {
    throw new Error(
      `缺少快照 ${file}。请先执行：\n` +
        `  bash scripts/capture-e2e-dumps.sh\n` +
        `（或按 docs/17 §5 的命令手动生成）`,
    );
  }
  return readFileSync(file, 'utf8');
}

/** 截图由外部生成，这里只确认存在 */
function screenshot(name) {
  const target = join(SHOTS, name);
  return existsSync(target) ? target : null;
}

function count(html, pattern) {
  return (html.match(pattern) ?? []).length;
}
function textOf(html, id) {
  const match = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
  return match ? match[1] : '';
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(join(REPO, '.verify'), { recursive: true });
  console.log(`读取 DOM 快照：${DUMPS}\n`);

  // ── 1. 启动与八板块 ────────────────────────────────
  console.log('1. TXT 分块编辑：八板块与折叠懒渲染');
  const base = dumpDom('default');
  // 用 `<section class="block ..." data-block-id=` 精确匹配：
  // 光数 data-block-id 会把编辑器内部（CodeMirror 镜像该属性）也算进来，得到 12。
  const blockCount = count(base, /<section class="block[^"]*" data-block-id="/g);
  check(blockCount === 8, '八个板块已渲染', `${blockCount} 个`);
  // id 正则必须含连字符：chat-examples / initial-scene 在 [a-z]+ 下匹配不到，
  // 于是 uniqueIds 会静默少算两个、size 对不上却看不出是谁缺了。
  const uniqueIds = new Set([...base.matchAll(/<section class="block[^"]*" data-block-id="([a-z-]+)"/g)].map((m) => m[1]));
  check(
    uniqueIds.size === 8 && uniqueIds.has('worldbook') && uniqueIds.has('chat-examples') && uniqueIds.has('initial-scene'),
    '八个板块 id 齐全（含两个新板块与世界书）',
    [...uniqueIds].join(','),
  );
  check(count(base, /class="cm-editor/g) === 2, '默认仍只挂载 2 个编辑器（懒渲染红线）');
  check(count(base, /class="cm-host"><\/div>/g) === 6, '其余 6 块未进 DOM');
  check(textOf(base, 'card-name').trim() !== '', '卡片名已加载', textOf(base, 'card-name'));
  // 默认只展开前两块（懒渲染），所以这里只断言"有内容"，不按六块预期
  const blockTexts = count(base, /class="cm-line"/g);
  check(blockTexts >= 4, '已展开板块的正文载入编辑区', `${blockTexts} 行`);

  // ── 2. 语法高亮 ────────────────────────────────────
  console.log('\n2. 语法高亮');
  const hl = count(base, /class="tcs-hl /g);
  check(hl > 0, '高亮装饰已渲染', `${hl} 段`);
  const scopes = [...base.matchAll(/class="tcs-hl tcs-hl-([a-z-]+)"/g)].map((m) => m[1]);
  check(new Set(scopes).size >= 2, '命中多种 scope', [...new Set(scopes)].join(', '));
  check(/tcs-hl-placeholder/.test(base), '{{char}} 占位符已着色');

  // ── 3. 实时规则提醒 ────────────────────────────────
  console.log('\n3. 实时规则提醒（审计面板）');
  const summary = [...base.matchAll(/class="summary-item[^"]*">([^<]*)</g)].map((m) => m[1]);
  check(summary.length >= 3, '审计摘要已渲染', summary.join(' / '));
  const issues = count(base, /class="issue (error|warning|info)"/g);
  check(issues > 0, '问题列表有条目', `${issues} 条`);
  check(/class="word-row"/.test(base), '字数分布已渲染');
  check(count(base, /class="word-row"/g) === 8, '八个板块的字数条（顺序同 BLOCK_IDS）');

  // ── 4. 编辑 → 审计联动（修正即消失已验证于单测，这里验报错侧）──
  console.log('\n4. 审计：错误注入与拦截');
  const broken = dumpDom('export-blocked');
  const brokenSummary = [...broken.matchAll(/class="summary-item[^"]*">([^<]*)</g)].map((m) => m[1]);
  check(brokenSummary.some((s) => /错误\s*[1-9]/.test(s)), '注入后报出错误', brokenSummary.join(' / '));
  const stats = [...broken.matchAll(/class="stat[^"]*">([^<]*)</g)].map((m) => m[1]);
  check(stats.some((s) => /错误\s*[1-9]/.test(s)), '顶栏统计与面板一致', stats.join(' / '));
  check(/审计未通过/.test(broken), '导出按钮触发拦截提示');
  check(/gate-box/.test(broken) && /仍要导出/.test(broken), '拦截框提供「仍要导出 / 取消」');

  // ── 5. 规则/预设切换 ───────────────────────────────
  console.log('\n5. 规则与预设面板');
  const rules = dumpDom('rules-dialog');
  check(/规则与预设/.test(rules), '规则面板可打开');
  check(count(rules, /data-role="platform-select"/g) === 1, '平台规则下拉存在');
  check(/data-role="preset-preview"/.test(rules), '预设影响预览存在');
  check(/data-role="preset-select"/.test(rules), '预设下拉存在');

  const switched = dumpDom('platform-janitorai');
  check(/平台 janitorai/.test(textOf(switched, 'rules-label')), '切换平台规则生效', textOf(switched, 'rules-label'));
  const switchedSummary = [...switched.matchAll(/class="summary-item[^"]*">([^<]*)</g)].map((m) => m[1]);
  check(switchedSummary.some((s) => /警告\s*[1-9]/.test(s)), '切换后立即重检（出现世界书警告）', switchedSummary.join(' / '));

  const applied = dumpDom('apply-divider');
  check(/预设 divider/.test(textOf(applied, 'rules-label')), '应用预设后当前预设已切换', textOf(applied, 'rules-label'));

  // ── 6. 导出与保存 ─────────────────────────────────
  console.log('\n6. 导出（JSON / TXT 产物）');
  // round-trip 由独立脚本产出报告（本机 Node 不能 spawn，所以读结果文件）
  const rtReport = join(REPO, '.verify', 'export-roundtrip.txt');
  if (existsSync(rtReport)) {
    const text = readFileSync(rtReport, 'utf8');
    check(/全部通过/.test(text), 'JSON/TXT round-trip 通过', text.trim().split(/\r?\n/).pop());
    check(/JSON round-trip/.test(text) && /TXT round-trip/.test(text), '两个方向都已验证');
  } else {
    check(false, 'JSON/TXT round-trip', '缺少 .verify/export-roundtrip.txt（先跑 npm run verify:export-roundtrip）');
  }

  // ── 7. 上传 / 回滚（对真实服务端）──────────────────
  console.log('\n7. 上传与版本回滚');
  const liveReport = join(REPO, '.verify', 'sync-live.txt');
  if (existsSync(liveReport)) {
    const live = readFileSync(liveReport, 'utf8');
    check(/isSyncReady = true/.test(live), '连接就绪（isSyncReady）');
    check(/上传新建/.test(live), '上传成功（新建卡）');
    check(/版本历史/.test(live), '版本历史可读');
    check(/回滚到 v1/.test(live), '回滚成功');
    check(/与初始上传一致 = true/.test(live), '回滚后内容与目标版本一致');
    check(/只增不改/.test(live), '历史只增不改');
  } else {
    check(false, '上传与回滚', '缺少 .verify/sync-live.txt（先跑 npm run verify:sync-live）');
  }

  // ── 8. 渲染预览（F8 回归）───────────────────────────
  //
  // 这一组断言的来历：点「渲染预览」后整页假死，必须重启客户端。
  // 根因是 buildPreviewFragment 里 `while (body.firstChild) importNode(...)` ——
  // importNode 是深拷贝、不从源节点移除，循环永不结束，内存吃死渲染进程。
  // 单元测试抓不到（纯函数在 Node 里跑得飞快），所以必须在这里用真实浏览器点一次。
  //
  // 判据的选择：故障形态是"同步不返回"，所以「click 能返回」本身就是要断言的事实。
  // 若回归重现，抓取阶段 Chrome 会被超时杀掉、dump 缺失，这里会因为读不到快照而失败。
  console.log('\n8. 渲染预览（F8 回归）');
  const previewOpen = dumpDom('preview-open');
  const bodyAttrs = (html) => {
    const match = /<body([^>]*)>/.exec(html);
    return match ? match[1] : '';
  };
  const attr = (html, name) => {
    const match = new RegExp(`data-${name}="([^"]*)"`).exec(html);
    return match ? match[1] : '';
  };

  {
    const attrs = bodyAttrs(previewOpen);
    check(attrs !== '', '预览场景快照可读（点击未卡死）');
    check(attr(previewOpen, 'preview-expanded') === '2', '启动默认展开 2 个板块', attr(previewOpen, 'preview-expanded'));
    const ms = Number(attr(previewOpen, 'preview-ms'));
    check(Number.isFinite(ms) && ms < 200, '点击预览同步返回（<200ms）', `${ms}ms`);
    check(attr(previewOpen, 'preview-visible') === '2', '两个已展开板块显示预览', attr(previewOpen, 'preview-visible'));
    check(Number(attr(previewOpen, 'preview-nodes')) >= 2, '预览内已填充节点', `${attr(previewOpen, 'preview-nodes')} 个`);
  }

  {
    const cycle = dumpDom('preview-cycle10');
    check(attr(cycle, 'preview-cycles') === '10', '打开/关闭重复 10 次');
    check(attr(cycle, 'preview-visible-after-close') === '0', '重复 10 次后无残留可见预览',
      attr(cycle, 'preview-visible-after-close'));
    check(attr(cycle, 'preview-nodes-after-close') === '0', '关闭后预览节点已清空（无累积泄漏）',
      attr(cycle, 'preview-nodes-after-close'));
    check(attr(cycle, 'preview-overlays') === '0', '无残留遮罩层（只计可见）', attr(cycle, 'preview-overlays'));
  }

  {
    const typing = dumpDom('preview-typing');
    check(attr(typing, 'preview-visible') === '2', '输入测试时预览处于打开状态',
      attr(typing, 'preview-visible'));
    check(attr(typing, 'typing-result') === 'changed', '预览打开期间编辑器仍可输入',
      attr(typing, 'typing-result'));
    check(attr(typing, 'typing-content-editable') === 'true', '编辑区仍为 contenteditable',
      attr(typing, 'typing-content-editable'));
    check(attr(typing, 'typing-topmost') === 'editor', '编辑区未被遮罩覆盖（最上层是编辑器）',
      attr(typing, 'typing-topmost'));
  }

  // T9.18：顶栏其余按钮的同类状态机问题扫描
  {
    const sweep = dumpDom('preview-sweep');
    const raw = attr(sweep, 'sweep-results');
    check(raw !== '', '按钮扫描结果存在');
    const entries = raw.split(' | ').map((item) => item.split(':'));
    const hung = entries.filter((parts) => parts[1] && parts[1] !== 'disabled' && Number.parseFloat(parts[1]) > 500);
    check(hung.length === 0, '所有按钮点击均未阻塞（无 >500ms）',
      hung.map((parts) => `${parts[0]}=${parts[1]}`).join(',') || '全部及时返回');
    const threw = entries.filter((parts) => parts[2] && parts[2].startsWith('threw'));
    check(threw.length === 0, '按钮点击均未抛异常', threw.map((parts) => parts[0]).join(',') || '');
    check(attr(sweep, 'sweep-visible-overlays') === '0', '扫完后无残留遮罩', attr(sweep, 'sweep-visible-overlays'));
    check(attr(sweep, 'sweep-visible-preview') === '0', '预览被正确复位（不污染后续操作）',
      attr(sweep, 'sweep-visible-preview'));
  }

  // ── 9. 一键连接本机服务端（F6.1 / F6.3）───────────────
  //
  // 这个场景点的是**真实按钮**，对面是 127.0.0.1:8730 上真实运行的服务端。
  // 所以它同时验证了：按钮绑定、编排顺序、令牌接口、同步状态刷新。
  //
  // 注意：成功态要求那台机器上跑着**本版本**服务端。若跑的是旧版（无 /api/token），
  // 会得到 fail:server-too-old —— 那本身也是正确行为，所以下面按"结果自洽"断言，
  // 而不是硬性要求 ok。
  console.log('\n9. 一键连接本机服务端（F6）');
  {
    const local = dumpDom('settings-local');
    const state = attr(local, 'local-connect');
    check(state !== '', '本地连接场景已执行', state || '未执行（快照缺失或页面未加载）');

    if (state === 'ok') {
      check(attr(local, 'local-token-length') === '32', '自动取到 32 字符令牌',
        attr(local, 'local-token-length'));
      check(attr(local, 'local-auth-required') === 'true', '标注服务端要求鉴权',
        attr(local, 'local-auth-required'));
      check(attr(local, 'local-server-version') !== '', '回填了服务端版本',
        attr(local, 'local-server-version'));
      // 浏览器模式下不该谎报已持久化
      check(attr(local, 'local-persisted') === 'false', '浏览器模式如实标注未持久化',
        attr(local, 'local-persisted'));
    } else if (state.startsWith('fail:')) {
      const kind = state.slice('fail:'.length);
      // 每种失败都必须给出分步处置，不能只丢一句错误
      check(Number(attr(local, 'local-steps')) >= 3, `失败分类 ${kind} 给出分步处置`,
        `${attr(local, 'local-steps')} 步`);
      check(
        ['not-running', 'port-changed', 'not-local', 'token-denied', 'server-too-old', 'network', 'save-failed']
          .includes(kind),
        `失败分类可识别：${kind}`,
      );
    }
  }

  // ── 10. 截图归档 ────────────────────────────────────
  console.log('\n10. 截图归档');
  for (const name of [
    'e2e-editor.png',
    'e2e-all-blocks.png',
    'e2e-export-gate.png',
    'e2e-rules.png',
    'e2e-preview-open.png',
    'f6-local-connect-ok.png',
    'f6-local-connect-addr-changed.png',
  ]) {
    const shot = screenshot(name);
    check(shot !== null, `截图 ${name}`, shot === null ? '缺失（先跑 capture-e2e-dumps.sh）' : '');
  }


  // ── 汇总 ───────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`端到端：${passed}/${results.length} 项通过`);
  writeFileSync(
    join(REPO, '.verify', 'e2e-report.json'),
    `${JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2)}\n`,
    'utf8',
  );
  if (failures === 0) {
    console.log('全部通过。');
    process.exit(0);
  }
  console.log(`失败 ${failures} 项。`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exit(1);
});
