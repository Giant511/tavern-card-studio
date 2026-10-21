/**
 * 生成 WiX 片段 installer/generated/AppFiles.wxs
 *
 * 为什么不用 Heat / Files 扩展：安装包里 node_modules 层级很深，
 * 手写不现实、第三方 harvesting 又要求构建机额外装扩展。
 * 这里直接遍历 release/server，按目录生成 Directory 树 + 每个目录一个 Component（首文件作 KeyPath），
 * 只依赖 WiX 核心语法，构建机只需 `wix build`。
 *
 * 运行：node scripts/gen-wix-fragment.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const STAGE = join(ROOT, 'release', 'server');
const OUT_DIR = join(ROOT, 'installer', 'generated');
const OUT = join(OUT_DIR, 'AppFiles.wxs');

if (!existsSync(STAGE)) {
  console.error('缺少 release/server：先执行 npm run pack:server');
  process.exit(1);
}

function idFor(relativePath) {
  return createHash('sha1').update(relativePath).digest('hex').slice(0, 12);
}

/**
 * 为每个组件派生确定性 GUID（UUID v5 风格：sha1(namespace + key) 取前 16 字节，
 * 再按 RFC 4122 打上 version=5 / variant=10 位）。
 *
 * 为什么不能用 Guid="*"：
 *   WiX 只允许「单文件且 KeyPath 为版本化文件」的组件自动生成 GUID。
 *   我们的组件是按目录聚合的多文件组件，会报 WIX0367。
 *
 * 为什么不能用随机 GUID：
 *   组件 GUID 是 MSI 的组件标识。若每次构建都变，升级安装时 MSI 认为
 *   是全新组件，旧版本文件不会被正确替换/清理，容易出现残留文件。
 *   从相对路径派生可以保证「同一路径 → 同一 GUID」，升级行为可预测。
 */
function guidFor(key) {
  const digest = createHash('sha1').update(`TavernCardStudio/AppFiles/${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString('hex').toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const directories = []; // { rel, name, children: [], files: [] }
const byRel = new Map();

function ensureDir(rel) {
  if (byRel.has(rel)) return byRel.get(rel);
  const parts = rel.split('/');
  const node = { rel, name: parts[parts.length - 1], children: [], files: [] };
  byRel.set(rel, node);
  directories.push(node);
  if (rel !== '') {
    const parentRel = parts.slice(0, -1).join('/');
    ensureDir(parentRel).children.push(node);
  }
  return node;
}

/**
 * 注意：不要用 readdirSync({withFileTypes:true}) 的 Dirent.isDirectory()，
 * 某些受限环境下它会恒为 false（目录被当成文件），导致生成 0 个组件。
 * 这里统一用 statSync 判断类型，行为稳定。
 */
function walk(rel) {
  const absolute = rel === '' ? STAGE : join(STAGE, rel.split('/').join(sep));
  const node = ensureDir(rel);
  for (const name of readdirSync(absolute)) {
    const childRel = rel === '' ? name : `${rel}/${name}`;
    const stat = statSync(join(absolute, name));
    if (stat.isDirectory()) walk(childRel);
    else node.files.push(childRel);
  }
}

walk('');

// 这几个文件由 Product.wxs 的 ServiceComponent 显式声明，清单里必须排除，否则 WiX
// 会报重复文件（同一个目录下出现两个 <File> 指向同一路径）。
//   node.exe              — 运行时，ServiceComponent 里以 <File Id="NodeExe"> 声明
//   tcs-service-host.exe  — WinSW 服务宿主（node.exe 自己当不了服务）
//   tcs-service-host.xml  — WinSW 配置，必须与宿主同名同目录（WinSW v2 按名字找）
const OWNED_BY_PRODUCT_WXS = ['node.exe', 'tcs-service-host.exe', 'tcs-service-host.xml'];
const rootNode = byRel.get('');
rootNode.files = rootNode.files.filter((file) => !OWNED_BY_PRODUCT_WXS.includes(file));

function renderDirectory(node, indent) {
  const pad = '  '.repeat(indent);
  const id = `D_${idFor(node.rel)}`;
  const lines = [`${pad}<Directory Id="${id}" Name="${escapeXml(node.name)}">`];
  for (const child of node.children) lines.push(renderDirectory(child, indent + 1));
  lines.push(`${pad}</Directory>`);
  return lines.join('\n');
}

const components = [];
for (const node of directories) {
  if (node.files.length === 0) continue;
  const hash = idFor(node.rel || 'root');
  const dirId = node.rel === '' ? 'INSTALLFOLDER' : `D_${idFor(node.rel)}`;
  const lines = [
    `    <Component Id="C_${hash}" Directory="${dirId}" Guid="${guidFor(node.rel || 'root')}">`,
  ];
  node.files.forEach((file, index) => {
    const fileId = `F_${hash}_${index}`;
    const source = `$(var.StageDir)\\${file.split('/').join('\\')}`;
    lines.push(
      `      <File Id="${fileId}" Source="${escapeXml(source)}"${index === 0 ? ' KeyPath="yes"' : ''} />`,
    );
  });
  lines.push('    </Component>');
  components.push(lines.join('\n'));
}

const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- 自动生成，请勿手改：node scripts/gen-wix-fragment.mjs -->
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Fragment>
    <DirectoryRef Id="INSTALLFOLDER">
${byRel.get('').children.map((child) => renderDirectory(child, 3)).join('\n')}
    </DirectoryRef>
  </Fragment>

  <Fragment>
    <ComponentGroup Id="AppFiles">
${components.join('\n')}
    </ComponentGroup>
  </Fragment>
</Wix>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, xml, 'utf8');
console.log(`✔ 已生成 ${relative(ROOT, OUT)}（${components.length} 个组件，${directories.length - 1} 个目录）`);
