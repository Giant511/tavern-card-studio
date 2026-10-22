/**
 * 客户端壳配置静态校验（不需要 Rust 工具链）。
 *
 * 校验四件事：
 *   1. tauri.conf.json 是否符合官方 schema（有 .verify/tauri-config.schema.json 时）
 *   2. capabilities/*.json 结构完整、权限标识格式合法
 *   3. 引用的图标文件、资源目录、前端产物目录是否存在
 *   4. bundle.resources 的源路径在磁盘上是否存在（打包最容易漏的一项）
 *
 * 运行：node client/scripts/validate-config.mjs
 * 退出码：0 全部通过；1 有失败项
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkDecisionTable } from '../../scripts/check-decision-table.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

const CLIENT = join(import.meta.dirname, '..');
const REPO = join(CLIENT, '..');
const CONF = join(CLIENT, 'src-tauri', 'tauri.conf.json');
const CAPS_DIR = join(CLIENT, 'src-tauri', 'capabilities');
const SCHEMA = join(REPO, '.verify', 'tauri-config.schema.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '✔' : '✘';
  console.log(`${mark} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ── 1. tauri.conf.json ─────────────────────────────────────
let config = null;
try {
  config = JSON.parse(readFileSync(CONF, 'utf8'));
  check('tauri.conf.json 是合法 JSON', true);
} catch (error) {
  check('tauri.conf.json 是合法 JSON', false, error.message);
  process.exit(1);
}

if (existsSync(SCHEMA)) {
  const rawSchema = JSON.parse(readFileSync(SCHEMA, 'utf8'));
  // 官方 schema 里存在 `\/` 这类在 `u` 模式下非法的转义（如文件名字符集），
  // ajv 编译会直接抛 SyntaxError。这里做一次最小归一化：去掉多余的 `\/`，
  // 若仍有无法编译的 pattern 就降级为「不校验该 pattern」（并在结果里标出来）。
  let droppedPatterns = 0;
  const sanitize = (node) => {
    if (Array.isArray(node)) {
      node.forEach(sanitize);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.pattern === 'string') {
      const normalized = node.pattern.replace(/\\\//g, '/');
      try {
        new RegExp(normalized, 'u');
        node.pattern = normalized;
      } catch {
        delete node.pattern;
        droppedPatterns++;
      }
    }
    for (const value of Object.values(node)) sanitize(value);
  };
  sanitize(rawSchema);

  // logger: false —— 官方 schema 里用了 uint32 等非标准 format，ajv 会刷屏警告
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true, logger: false });
  const validate = ajv.compile(rawSchema);
  const ok = validate(config);
  const detail = ok
    ? `schema ${rawSchema.$id}${droppedPatterns ? `（降级跳过 ${droppedPatterns} 条正则）` : ''}`
    : JSON.stringify(validate.errors?.slice(0, 3));
  check('tauri.conf.json 通过官方 schema 校验', ok, detail);
} else {
  check('tauri.conf.json 通过官方 schema 校验', false, '缺少 .verify/tauri-config.schema.json（见 docs/11 §10）');
}

// ── 2. capabilities ───────────────────────────────────────
const capFiles = existsSync(CAPS_DIR) ? readdirSync(CAPS_DIR).filter((f) => f.endsWith('.json')) : [];
check('capabilities 至少一份', capFiles.length > 0, capFiles.join(', '));

const ALLOWED_PREFIX = /^(core|dialog|fs|store|log|opener|window-state|shell|http|notification|updater|process|clipboard-manager|os|global-shortcut)[:.]/;
for (const file of capFiles) {
  const path = join(CAPS_DIR, file);
  let cap;
  try {
    cap = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    check(`${file} 是合法 JSON`, false, error.message);
    continue;
  }
  const hasCore = Array.isArray(cap.permissions) && cap.permissions.length > 0;
  check(`${file} 有 identifier / windows / permissions`, Boolean(cap.identifier) && Array.isArray(cap.windows) && hasCore);

  const ids = (cap.permissions ?? []).map((item) => (typeof item === 'string' ? item : item?.identifier));
  const badIds = ids.filter((id) => typeof id !== 'string' || !ALLOWED_PREFIX.test(id));
  check(`${file} 权限标识格式合法（${ids.length} 项）`, badIds.length === 0, badIds.join(', '));

  // 项目约定：不授予任意路径 fs 写权限（见 docs/11 §7）
  const forbidden = ids.filter((id) => typeof id === 'string' && /^fs:allow-(write|remove|rename|mkdir|copy)/.test(id));
  check(`${file} 未授予任意路径 fs 写/删权限`, forbidden.length === 0, forbidden.join(', '));
}

// ── 3. 引用路径存在性 ─────────────────────────────────────
const tauriDir = join(CLIENT, 'src-tauri');
const icons = config?.bundle?.icon ?? [];
const missingIcons = icons.filter((rel) => !existsSync(join(tauriDir, rel)));
check(`bundle.icon 引用的 ${icons.length} 个图标都存在`, missingIcons.length === 0, missingIcons.join(', '));

const frontendDist = config?.build?.frontendDist;
if (frontendDist) {
  const distPath = join(tauriDir, frontendDist);
  check(`frontendDist 目录存在（${frontendDist}）`, existsSync(distPath), existsSync(distPath) ? '' : '先跑 npm run build:ui');
}

// ── 4. resources ──────────────────────────────────────────
const resources = config?.bundle?.resources ?? {};
const resourceEntries = typeof resources === 'object' && !Array.isArray(resources)
  ? Object.keys(resources)
  : Array.isArray(resources) ? resources : [];
const missingResources = resourceEntries.filter((rel) => !existsSync(join(tauriDir, rel)));
check(`bundle.resources 的 ${resourceEntries.length} 个源路径都存在`, missingResources.length === 0, missingResources.join(', '));

// ── 5. 渲染层纪律（docs/11 §1 与 §8.3）──────────────────────
//
// 这两条是项目硬约束，靠人记会漂移，所以做成可执行检查：
//   A. 只有 src/contract/** 允许 import @tauri-apps/*（其余渲染层代码一律走契约）
//   B. 任何渲染层代码都不允许写 innerHTML / insertAdjacentHTML（XSS 面）

const SRC = join(CLIENT, 'src');
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const tsFiles = existsSync(SRC) ? walk(SRC) : [];
const violationImport = [];
const violationHtml = [];

for (const file of tsFiles) {
  const relative = file.slice(CLIENT.length + 1).replace(/\\/g, '/');
  const source = readFileSync(file, 'utf8');

  // 去掉注释后再判断，避免注释里提到这些词就误报
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const isContract = relative.startsWith('src/contract/');
  if (!isContract && /from\s+['"]@tauri-apps\//.test(code)) {
    violationImport.push(relative);
  }

  if (/\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b/.test(code)) {
    violationHtml.push(relative);
  }
}

check(
  `渲染层仅 contract 依赖 @tauri-apps（共 ${tsFiles.length} 个 TS 文件）`,
  violationImport.length === 0,
  violationImport.length ? `越界：${violationImport.join(', ')}` : '',
);

check(
  '渲染层无 innerHTML / insertAdjacentHTML / outerHTML',
  violationHtml.length === 0,
  violationHtml.length ? `越界：${violationHtml.join(', ')}` : '',
);

// ── 6. PLAN.md 决策表序号连续性 ───────────────────────────
//
// 逻辑放在 scripts/check-decision-table.mjs，那里同时被 git pre-commit 钩子使用，
// 避免两处实现漂移。这里只负责把结果并进统一的校验汇总。
//
// T9.13 起决策表已从 README.md 迁到 PLAN.md（README 转为纯用户文档，
// 不含决策表）；PLAN.md 本地保留、不入库，所以本项在干净 clone 上会报"找不到文件"。
const decisionResult = checkDecisionTable(join(REPO, 'PLAN.md'));
check(
  'PLAN.md 决策表序号严格递增且无缺号',
  decisionResult.ok,
  decisionResult.detail,
);

// ── 汇总 ─────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok);
console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
if (failed.length > 0) {
  console.log('失败项：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.detail}`);
  process.exit(1);
}
