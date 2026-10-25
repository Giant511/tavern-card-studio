/**
 * dist 新鲜度指纹：判定「测试跑的 dist 是不是当前 src 编译出来的」。
 *
 * 为什么需要它（2026-10-25 的真实事故）：
 *   做负向验证时往 `users.ts` 里注入了一个类型错误的字段，`tsc -b server` 拒绝编译，
 *   而我把输出重定向进了 /dev/null；随后直接跑 `node --test test/user-uid.test.mjs`，
 *   测试加载的是**上一次**成功编译的 dist —— 于是「注入后仍然全绿」，
 *   差点被读成「测试抓不住这个缺陷」。真正的问题是测试根本没跑新代码。
 *
 * 为什么不用 mtime：
 *   本仓库已经踩过两次时间链的坑 —— `tsc -b` 是**增量**构建，
 *   「src 比 dist 新」可以完全正常（改了但产出字节没变，下游不重新 emit）；
 *   反过来把源码 touch 一下，mtime 变了而内容没变，也会误报。
 *   所以这里比的是**内容哈希**：把这次编译读到的每个源文件的
 *   `相对路径 + 字节` 混进一个 sha256，构建成功时写进 `dist/.build-stamp.json`。
 *   测试时重算一遍，对不上就是「dist 不是这份 src 编译出来的」。
 *
 * 构建失败时**不会**写指纹（见 package.json 里的 `&&` 链），
 * 于是坏构建之后 dist 里留着的是**上一次**的指纹 —— 与当前 src 不符，
 * 下一次测试立刻红。这正是我们要的：坏构建不能静默退化成「用旧产物也算过」。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** 每个包要纳入指纹的源码目录（相对仓库根） */
const SOURCES = {
  shared: ['shared/src'],
  // server 编译时 import 的是 @tcs/shared 的 dist，而 shared/dist 由 shared/src 决定，
  // 所以 shared/src 必须一起进 server 的指纹：否则「只改 shared、只编 server」会被判成新鲜。
  server: ['server/src', 'shared/src'],
  client: ['client/src'],
};

function walk(dir, acc) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/** 计算某个包的源码指纹（与写入指纹用的是同一个函数，避免两处口径不一致） */
export function computeSourceHash(pkg) {
  const roots = SOURCES[pkg];
  if (!roots) throw new Error(`未知的包：${pkg}`);
  const files = [];
  for (const root of roots) {
    const abs = join(ROOT, root);
    if (existsSync(abs)) walk(abs, files);
  }
  files.sort();
  const hash = createHash('sha256');
  for (const file of files) {
    // 路径用 `/` 归一：否则 Windows 与类 Unix 上同一份代码指纹不同
    hash.update(relative(ROOT, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), files: files.length };
}

export function stampPath(pkg) {
  return join(ROOT, pkg, 'dist', '.build-stamp.json');
}

/** 写入指纹（构建成功后调用） */
export function writeStamp(pkg) {
  const { hash, files } = computeSourceHash(pkg);
  const payload = {
    package: pkg,
    at: new Date().toISOString(),
    sourceHash: hash,
    sourceFiles: files,
  };
  writeFileSync(stampPath(pkg), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * 校验指纹。
 * @returns {{ok: boolean, reasons: string[], stamp: object | null, current: object}}
 */
export function checkStamp(pkg) {
  const current = computeSourceHash(pkg);
  const path = stampPath(pkg);
  if (!existsSync(path)) {
    return {
      ok: false,
      reasons: [
        `${pkg}/dist 没有构建指纹（${relative(ROOT, path)}）`,
        `    → dist 可能是手工拷贝的、或构建脚本没走 npm run build:${pkg}`,
      ],
      stamp: null,
      current,
    };
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      reasons: [`${pkg}/dist 的指纹文件无法解析：${error instanceof Error ? error.message : String(error)}`],
      stamp: null,
      current,
    };
  }
  // 构建产物本身在不在：指纹写着成功、dist 被删掉的情况也要判不新鲜
  const entry = join(ROOT, pkg, 'dist', 'index.js');
  const reasons = [];
  if (stamp.sourceHash !== current.hash) {
    reasons.push(
      `${pkg}/dist 与当前源码不一致：指纹 ${String(stamp.sourceHash).slice(0, 12)}…，` +
        `现有源码 ${current.hash.slice(0, 12)}…`,
      `    → 源码改过但没重新编译（或上次编译失败了），测试会跑旧代码`,
      `    → 先跑：npm run build:${pkg}`,
    );
  }
  if (pkg !== 'client' && !existsSync(entry)) {
    reasons.push(`${pkg}/dist/index.js 不存在，产物缺失`);
  }
  return { ok: reasons.length === 0, reasons, stamp, current };
}

/** 该包的 dist 是否比某个文件旧（供 report:release 之类复用；这里只做展示用） */
export function stampAge(pkg) {
  const path = stampPath(pkg);
  if (!existsSync(path)) return null;
  return { mtime: statSync(path).mtime, stamp: JSON.parse(readFileSync(path, 'utf8')) };
}
