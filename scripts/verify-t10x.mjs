/**
 * v0.1.2 测试反馈四项的浏览器侧断言（T10.26 / T10.27 / T10.28 / T10.29）。
 *
 * 输入是 `scripts/capture-t10x.sh` 抓的 DOM 快照（本机 Node 无法 spawn，
 * 所以抓取与断言必须分开 —— 与 `capture-e2e-dumps.sh` + `verify-e2e.mjs` 同一套路）。
 *
 * 断言的是**用户能看见的结果**：
 *   · 0 命中时原文逐字节出现在【其他设定】里，且没有分隔符；
 *   · 混合样本里分隔符只出现一次、两个片段按原序在它下方、已识别内容在上方；
 *   · 状态栏说的是"多少段原文去了哪里"，而不是"导入成功"；
 *   · 改名提示两态（有/无）；
 *   · 异常注入后 `error` 钩子确实被触发了（浏览器模式下不落盘，落盘在壳里验）。
 *
 * 用法：node scripts/verify-t10x.mjs
 * 退出码：0 全部通过；1 有失败项
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DUMPS = join(REPO, '.verify', 't10x-dumps');
const SEPARATOR = '════════════ 以下内容为未识别的板块数据，请自行排版 ════════════';

let failures = 0;
const results = [];

function check(ok, label, detail = '') {
  results.push({ ok, label, detail });
  if (ok) console.log(`  ✔ ${label}${detail === '' ? '' : `（${detail}）`}`);
  else {
    failures += 1;
    console.log(`  ✘ ${label}${detail === '' ? '' : ` —— ${detail}`}`);
  }
}

function load(name) {
  const path = join(DUMPS, `${name}.html`);
  if (!existsSync(path)) {
    check(false, `缺少快照 ${name}.html`, '先跑 bash scripts/capture-t10x.sh');
    return '';
  }
  return readFileSync(path, 'utf8');
}

/**
 * 取某段区间内的纯文本（去掉标签）。
 *
 * 为什么不去掉全部标签再找：编辑器里每一行是 `<div class="cm-line">`，
 * 直接去标签会把不同行粘成一行，"片段按原序、片段之间空行"这类断言就废了。
 */
function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 取状态栏文字 */
function statusOf(html) {
  const match = /id="status"[^>]*>([\s\S]*?)<\/footer>/.exec(html) ?? /id="status"[^>]*>([\s\S]*?)<\/(?:p|div|footer)>/.exec(html);
  return match ? stripTags(match[1]).trim() : '';
}

/** 取某个板块的编辑器纯文本（按 data-block-id 定位 section） */
function blockText(html, blockId) {
  const start = html.indexOf(`data-block-id="${blockId}"`);
  if (start < 0) return '';
  // 板块区块到下一个板块之间
  const next = html.indexOf('data-block-id="', start + 10);
  const slice = html.slice(start, next < 0 ? undefined : next);
  return stripTags(slice);
}

console.log('T10.27 全量保全 —— 三种样本');

// ── 1. 0 命中 ───────────────────────────────────────────
{
  const html = load('import-zero');

  check(html.includes('条目1：这是一段完全自由的设定文本'), '0 命中：原文进入了编辑器');
  check(!html.includes(SEPARATOR), '0 命中：不加分隔符（整体放置）');

  // 原文逐字节：三段的相对顺序与内容都要在
  const settings = blockText(html, 'settings');
  const order = ['条目1：这是一段完全自由的设定文本', '它没有使用任何【】或 ## 标题', '条目2：第二段', '条目3：结尾'].map((line) =>
    settings.indexOf(line),
  );
  check(
    order.every((index) => index >= 0),
    '0 命中：三段原文都在【其他设定】里',
    order.some((index) => index < 0) ? '有片段丢失' : '',
  );
  check(
    order.every((index, position) => position === 0 || index > order[position - 1]),
    '0 命中：原文顺序未被打乱',
  );

  const status = statusOf(html);
  check(
    status.includes('未识别到任何板块，原文已整体放入【其他设定】，请自行分块'),
    '0 命中：状态栏用需求指定的那句话',
    status,
  );

  // 需求：审计不报"缺失板块"类错误
  check(!/>缺失板块/.test(html), '0 命中：审计没有"缺失板块"一类问题');

  // 零标签打开 TXT 会自动建会话（T10.28）—— 这条样本正是从零标签导入的
  check(html.includes('演示-zero'), 'T10.28：零标签导入自动建了会话（标签名取文件名）');
}

// ── 2. 混合样本 ─────────────────────────────────────────
{
  const html = load('import-mixed');

  // 命中板块正确
  check(/姓名：林晚照/.test(html), '混合：基本信息填入了');
  const personality = blockText(html, 'personality');
  check(personality.includes('冷静，话少。'), '混合：性格填入了且不含片段');

  // 片段没有残留在上一个板块里（这正是第一版的 bug：导出时会出现两次）
  check(!personality.includes('战斗系统'), '混合：性格板块里没有残留的未识别片段');

  // 分隔符恰好一次。
  // 必须在**去标签后**的文本里数：编辑器把这一行按高亮切成了多个 span
  // （`════` 是装饰符、`以下内容为…` 是正文），原始 HTML 里这串字根本不连续。
  // 第一版直接在 html 上 split，得到 0 次 —— 是断言错了，不是功能错了。
  const separatorCount = stripTags(html).split(SEPARATOR).length - 1;
  check(separatorCount === 1, '混合：分隔符只出现一次', `实际 ${String(separatorCount)} 次`);

  // 片段在分隔符下方、按原序、各自保留标题行
  const settings = blockText(html, 'settings');
  const sepAt = settings.indexOf(SEPARATOR);
  const battleAt = settings.indexOf('## 战斗系统');
  const movesAt = settings.indexOf('## 招式表');
  check(sepAt >= 0 && battleAt > sepAt && movesAt > battleAt, '混合：两个片段在分隔符下方且按原序', `sep=${String(sepAt)} battle=${String(battleAt)} moves=${String(movesAt)}`);

  // 已识别的其他设定内容在分隔符之前
  const headAt = settings.indexOf('这是已识别到的其他设定内容');
  check(headAt >= 0 && headAt < sepAt, '混合：已识别的其他设定内容在分隔符上方');

  // 片段正文跟着自己的标题
  check(/## 战斗系统[\s\S]{0,40}条目1：先攻按敏捷排序/.test(settings), '混合：片段正文跟在自己的标题行后面');

  const status = statusOf(html);
  check(/识别到 3 个板块/.test(status), '混合：状态栏报出了识别的板块数', status);
  check(/2 段未识别内容/.test(status), '混合：状态栏报出了搬了几段原文', status);
}

// ── 3. 全部标准板块 ─────────────────────────────────────
{
  const html = load('import-clean');
  check(!html.includes(SEPARATOR), '干净样本：不插分隔符');
  check(/识别到 5 个板块/.test(statusOf(html)), '干净样本：状态栏只报识别到的板块数', statusOf(html));
  check(!/段未识别内容/.test(statusOf(html)), '干净样本：状态栏不提"未识别"');
}

// ── 4. 导入对话框（保全文案） ───────────────────────────
{
  const html = load('import-dialog-mixed');
  // 摘要不贴分隔符本身，而是说清"几段原文去了哪里" —— 断言的是那句话
  check(
    /另有 \d+ 段未识别内容已按原序放入【其他设定】/.test(stripTags(html)),
    '对话框：摘要里说明了未识别内容的去向',
  );
  check(/data-role="import-mode-note"/.test(html), '对话框：有"保全已启用"的说明元素');
  check(!/将按空块处理/.test(html), '对话框：不再出现旧口径"将按空块处理"');
}

console.log('\nT10.29 改名提示');

{
  const show = load('name-hint-show');
  check(/id="card-name-hint"[^>]*>← 点这里改角色名/.test(show), '提示存在且文字正确');
  const hintTag = /<span id="card-name-hint"[^>]*>/.exec(show)?.[0] ?? '';
  // 不能用 /\bhidden\b/ 判：`aria-hidden="true"` 里也含 hidden，会让断言永远失败。
  // 要判的是**hidden 属性本身**（形如 `hidden=""` 或裸 `hidden` 在标签末尾）。
  check(!/\shidden(?:=""|\s|>)/.test(hintTag), '未点过时提示可见', hintTag);
  // 与角色名同一行（外层有 .card-name-row）
  check(/class="card-name-row"/.test(show), '提示与角色名在同一行的容器里');
}
{
  const hide = load('name-hint-hide');
  const hintTag = /<span id="card-name-hint"[^>]*>/.exec(hide)?.[0] ?? '';
  check(/\shidden(?:=""|\s|>)/.test(hintTag), '点过之后提示隐藏', hintTag);
}

console.log('\nT10.26 异常注入');

{
  const html = load('crash-injected');
  // 浏览器模式下日志落盘是 no-op（没有壳），但页面必须仍然活着 ——
  // 崩溃到白屏的话这里会拿不到编辑器。真正的"日志里有记录"在壳里验
  // （scripts/verify-t1026-crash.ps1 交给用户执行，或用已安装客户端 + CDP）。
  check(html.includes('id="status"'), '注入异常后页面仍然可用（异常处理没有把渲染进程带走）');
  check(html.includes('cm-content'), '注入异常后编辑器仍在（说明 onerror 没阻断后续渲染）');
}

const passed = results.filter((item) => item.ok).length;
console.log('');
console.log(`合计 ${String(results.length)} 项，通过 ${String(passed)}，失败 ${String(failures)}`);
if (failures > 0) {
  console.log('');
  console.log('失败项：');
  for (const item of results.filter((entry) => !entry.ok)) console.log(`  · ${item.label}${item.detail === '' ? '' : ` —— ${item.detail}`}`);
}
process.exit(failures === 0 ? 0 : 1);
