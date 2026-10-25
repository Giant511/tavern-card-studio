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

/**
 * 这个高熵串是不是"字符集表"（而不是凭据）。
 *
 * 判据：**相邻两字符的码点差为 +1 的比例**。
 *
 *   · 真随机串：每个相邻对"恰好差 1"的概率约 1%，据此误判概率可忽略；
 *   · 字符集表：几乎每一对都是递增的（跳过易混字符只会让少数几对断开）。
 *
 * 阈值 90% 留了足够余量：一个 28 字符的字母表即使跳过 2 个字符，占比仍 ≈ 92%。
 */
function isCharsetTable(token) {
  if (token.length < 2) return false;
  let ascending = 0;
  for (let i = 1; i < token.length; i += 1) {
    if (token.charCodeAt(i) === token.charCodeAt(i - 1) + 1) ascending += 1;
  }
  return ascending / (token.length - 1) >= 0.9;
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
      // 字符集表（如 `abcdefghijkmnpqrstuvwxyz23456789`）：跳过。
      //
      // 这类常量熵很高（32 个不同字符、各出现一次 ⇒ H=5.00），但它不是凭据，
      // 是**给随机源用的字母表**（v0.1.3 的 uid 生成器就是这个）。
      //
      // 判据用**结构**而不是字符串本身：真随机串里"相邻两字符码点差 1"的概率约 1%，
      // 而字母表几乎每一对都是递增的。所以"递增邻对占比 ≥ 90%"能可靠区分两者，
      // 且不需要按文件路径排除 —— 排除整个文件会让该文件里其它真令牌也漏过去。
      //
      // 试过但不够好的写法：`^abcdefghijklmnopqrstuvwxyz…` 硬匹配完整字母表 ——
      // 实际字母表为了避开易混字符会**跳过 l/o**，硬匹配直接失效。
      if (isCharsetTable(tok)) continue;
      hits += 1;
      console.log('HIGH-ENTROPY ' + f + ':' + String(idx + 1) + '  len=' + String(tok.length) + ' H=' + h.toFixed(2) + '  ' + tok.slice(0, 10) + '...');
    }
  });
}

console.log('\n扫描 ' + String(scanned) + ' 个文本文件，跳过 ' + String(skipped) + ' 个二进制/不可读，命中 ' + String(hits) + ' 条');

// 清单为空时必须报错，不能安静地绿。
//
// 起因：2026-10-25 直接跑 `node scripts/scan-entropy.mjs`（忘了接管道），
// stdin 读到空串，于是输出「扫描 0 个文本文件…命中 0 条」并 **exit 0** ——
// 看上去是一次通过的检查，实际什么都没查。
// 这正是本批一直在防的那类"静默假绿"：判据存在、跑得通、结论是错的。
//
// 现在：没拿到文件清单（或清单里一个可读文件都没有）→ 打错误并 exit 2。
// 与"命中 0 条"（exit 0）区分开，见 pre-commit 的用法。
if (scanned === 0) {
  console.error(
    '✘ 没有扫描到任何文件：缺少文件清单。\n' +
      '  正确用法：git status --porcelain=v1 -uall | node scripts/scan-entropy.mjs\n' +
      '  （脚本自身不调 git，清单必须由外部喂入）',
  );
  process.exit(2);
}
process.exit(hits > 0 ? 1 : 0);
