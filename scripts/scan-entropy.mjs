// 用法：git status --porcelain=v1 -uall | node scripts/scan-entropy.mjs
// 本机 Node 无法 spawn 子进程（EBUSY），因此文件清单必须由外部管道喂进来，脚本自身不调 git。
import { readFileSync } from 'node:fs';

const raw = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
const files = raw.split('\n').filter(Boolean)
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''))
  .filter((f) => !f.includes(' -> '));

function shannon(s) {
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  let e = 0;
  for (const c of m.values()) {
    const p = c / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

const TOKEN = /\b[A-Za-z0-9_\-+/=]{28,}\b/g;
let hits = 0;
let scanned = 0;
let skipped = 0;

for (const f of files) {
  if (/\.(png|jpg|jpeg|gif|webp|ico|msi|exe|zip|woff2?|ttf)$/i.test(f)) { skipped += 1; continue; }
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    skipped += 1;
    continue;
  }
  scanned += 1;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(TOKEN)) {
      const tok = m[0];
      if (!/[A-Za-z]/.test(tok) || !/[0-9]/.test(tok)) continue;
      const h = shannon(tok);
      if (h <= 4.5) continue;
      if (/^[0-9a-f]{40,64}$/i.test(tok)) continue;
      if (tok.endsWith('.node') || tok.includes('/') || tok.includes('\\')) continue;
      // npm 的完整性哈希：`sha512-<base64>`。它是**包内容**的哈希，公开可查、
      // 不携带任何凭据，扫它只会让每次改依赖都刷出上百条噪声（实测 41 条）。
      //
      // 精确排除到前缀而不是整个 `package-lock.json`：lock 里还有 resolved URL、
      // 包名等字段，万一有人在里面写了 token 仍然要能抓到。
      if (/^(sha512|sha256|sha1)-/.test(tok)) continue;
      hits += 1;
      console.log('HIGH-ENTROPY ' + f + ':' + String(idx + 1) + '  len=' + String(tok.length) + ' H=' + h.toFixed(2) + '  ' + tok.slice(0, 10) + '...');
    }
  });
}

console.log('\n扫描 ' + String(scanned) + ' 个文本文件，跳过 ' + String(skipped) + ' 个二进制/不可读，命中 ' + String(hits) + ' 条');
process.exit(hits > 0 ? 1 : 0);
