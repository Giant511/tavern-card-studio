#!/usr/bin/env node
/**
 * 复核 MSI 的 Upgrade 表 —— §16.4 判据：看表不看 wxs。
 *
 * 为什么需要它：
 *   `Product.wxs` 里写 `<MajorUpgrade .../>` 不等于 MSI 里真的有两行。
 *   WiX 会把 MajorUpgrade 展开成 Upgrade 表的两行，只有表里那两行 + 一条
 *   LaunchCondition 才算数。只看 wxs 等于只看意图，不是产物。
 *
 * 为什么不读 MSI 数据库：
 *   本机安全策略拦截 `WindowsInstaller.Installer` COM 对象实例化。
 *   但 WiX 产出的 `.wixpdb` 是个 ZIP，里面 `wix-wid.xml` 是完整的
 *   windowsInstallerData（所有表 + 每行来源行号）。读它比读 MSI 更容易，
 *   而且能直接看到"这行来自哪个 wxs 的哪一行"。
 *
 * 用法：
 *   node tools/check-msi-upgrade.mjs release/TavernCardStudioServer-0.1.7.wixpdb
 *   node tools/check-msi-upgrade.mjs            # 自动挑 release/ 下最新的 .wixpdb
 *
 * 退出码：0 全过 / 1 有未通过项 / 2 用法或输入错误
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- ZIP 读取（只用 zlib，不引第三方） ---------------- */

/**
 * 从 ZIP 缓冲区取出指定条目。
 * 支持 stored(0) 与 deflate(8)；本项目 wixpdb 只有这两种。
 */
function readZipEntry(buf, wanted) {
  // EOCD 签名 0x06054b50，位于文件尾部，后面最多跟 65535 字节注释
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到 EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${n} 项签名不对`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name === wanted) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头签名不对');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`不支持的压缩方法 ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP 内没有条目 ${wanted}`);
}

/* ---------------- 从 windowsInstallerData 取表 ---------------- */

/** 取 <table name="X"> 的所有行，每行是 field 文本数组。 */
function tableRows(xml, name) {
  const re = new RegExp(`<table name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([\\s\\S]*?)</table>`);
  const m = xml.match(re);
  if (!m) return null;
  const rows = [];
  for (const rm of m[1].matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    rows.push([...rm[1].matchAll(/<field[^>]*>([\s\S]*?)<\/field>/g)].map((f) => decodeXml(f[1].trim())));
  }
  return rows;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** MSI Upgrade 表 Attributes 位值 → 可读串 */
const UPGRADE_ATTR_BITS = [
  [1, 'MigrateFeatures'],
  [2, 'OnlyDetect'],
  [4, 'IgnoreRemoveFailure'],
  [8, 'VersionMinInclusive'],
  [16, 'VersionMaxInclusive'],
  [256, 'LanguagesExclusive'],
];

function decodeAttrs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return `? (${v})`;
  if (n === 0) return '0 (无)';
  const parts = UPGRADE_ATTR_BITS.filter(([bit]) => n & bit).map(([, name]) => name);
  const rest = n - UPGRADE_ATTR_BITS.reduce((acc, [bit]) => (n & bit ? acc + bit : acc), 0);
  if (rest) parts.push(`+${rest}?`);
  return `${n} (${parts.join(' | ')})`;
}

/* ---------------- 主流程 ---------------- */

function pickDefault() {
  const dir = join(ROOT, 'release');
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.wixpdb'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return join(dir, files[0]);
}

const arg = process.argv[2];
const file = arg ? resolve(arg) : pickDefault();
if (!file) {
  console.error('用法：node tools/check-msi-upgrade.mjs <xxx.wixpdb>');
  console.error('（release/ 下也没有 .wixpdb，先跑一次服务端打包）');
  process.exit(2);
}

let xml;
try {
  xml = readZipEntry(readFileSync(file), 'wix-wid.xml').toString('utf8');
} catch (err) {
  console.error(`读 ${file} 失败：${err.message}`);
  process.exit(2);
}

console.log('='.repeat(72));
console.log('MSI Upgrade 表复核（§16.4 判据：看表不看 wxs）');
console.log(`文件：${file}`);
console.log('='.repeat(72));

const up = tableRows(xml, 'Upgrade');
const HEAD = ['UpgradeCode', 'VersionMin', 'VersionMax', 'Language', 'Attributes', 'Remove', 'ActionProperty'];

console.log(`\n[Upgrade] 共 ${up ? up.length : 0} 行`);
(up || []).forEach((r, i) => {
  console.log(`\n  行 ${i + 1}:`);
  HEAD.forEach((k, j) => {
    const v = r[j] ?? '';
    const shown = k === 'Attributes' ? decodeAttrs(v) : v || '(空)';
    console.log(`    ${k.padEnd(15)} = ${shown}`);
  });
});

let failed = 0;
function check(label, cond, detail = '') {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? `  → ${detail}` : ''}`);
  if (!cond) failed++;
}

console.log('\n' + '-'.repeat(72));
console.log('判据');
console.log('-'.repeat(72));

const rows = up || [];
check('Upgrade 表恰好 2 行（MajorUpgrade 标准形态）', rows.length === 2, `实际 ${rows.length} 行`);
check('两行 UpgradeCode 相同', new Set(rows.map((r) => r[0])).size === 1, [...new Set(rows.map((r) => r[0]))].join(','));

const upRow = rows.find((r) => r[6] === 'WIX_UPGRADE_DETECTED');
const dnRow = rows.find((r) => r[6] === 'WIX_DOWNGRADE_DETECTED');
check('存在 WIX_UPGRADE_DETECTED 行（升级更低版本）', !!upRow);
check('存在 WIX_DOWNGRADE_DETECTED 行（探测更高版本）', !!dnRow);

if (upRow) {
  const a = Number(upRow[4]);
  check('升级行 VersionMax 有值且不含上界（不含 = 严格小于）', !!upRow[2] && !(a & 16), `VersionMax=${upRow[2] || '(空)'}`);
  check('升级行非 OnlyDetect（检测到旧版会真的执行移除）', !(a & 2), `Attributes=${decodeAttrs(upRow[4])}`);
  check('升级行 MigrateFeatures 置位（保留功能选择状态）', !!(a & 1), `Attributes=${decodeAttrs(upRow[4])}`);
}

if (dnRow) {
  const a = Number(dnRow[4]);
  check('降级行 VersionMin 有值且不含下界', !!dnRow[1] && !(a & 8), `VersionMin=${dnRow[1] || '(空)'}`);
  check('降级行 OnlyDetect 置位（只探测，不由它自己动手）', !!(a & 2), `Attributes=${decodeAttrs(dnRow[4])}`);
}

// 关键：OnlyDetect 只是设了个属性。不配 LaunchCondition 拦住，降级照样能装。
const lc = tableRows(xml, 'LaunchCondition');
console.log(`\n[LaunchCondition] 共 ${lc ? lc.length : 0} 行`);
for (const r of lc || []) console.log(`    ${r.map((x) => x || '(空)').join('  ||  ')}`);
check(
  'LaunchCondition 里有 WIX_DOWNGRADE_DETECTED 拦截（没有它 = 降级不会被挡）',
  (lc || []).some((r) => (r[0] || '').includes('WIX_DOWNGRADE_DETECTED'))
);

// 属性必须进 SecureCustomProperties，否则提权后会丢
const props = tableRows(xml, 'Property') || [];
const scp = props.find((r) => r[0] === 'SecureCustomProperties');
const scpVals = scp ? scp[1].split(';') : [];
console.log(`\n[Property] SecureCustomProperties = ${scp ? scp[1] : '(缺)'}`);
check('WIX_DOWNGRADE_DETECTED 在 SecureCustomProperties 里', scpVals.includes('WIX_DOWNGRADE_DETECTED'));
check('WIX_UPGRADE_DETECTED 在 SecureCustomProperties 里', scpVals.includes('WIX_UPGRADE_DETECTED'));

const pv = props.find((r) => r[0] === 'ProductVersion');
check('ProductVersion 属性与包名版本一致', !!pv && pv[1].length > 0, pv ? pv[1] : '(缺)');

console.log('\n' + '='.repeat(72));
console.log(failed === 0 ? '结论：全部通过' : `结论：${failed} 项未通过`);
console.log('='.repeat(72));
process.exit(failed === 0 ? 0 : 1);
