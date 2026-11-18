#!/usr/bin/env node
/**
 * 把内置的 SillyTavern 打成**可上传到 Release 的源码包**（2026-11-18，合规要求）。
 *
 * ## 为什么要单独一个包
 *
 * APK 里的 `assets/st.zip` 是**运行时用的**（解包到应用私有目录跑起来），
 * 它的内容与"对应源码"并不等价：
 *
 * ```text
 * assets/st.zip   排除了 data/ .git/ tests/ backups/ doc/  —— 为了体积与隐私
 * 源码包          必须是**完整对应源码**，能重新构建出同样的东西
 * ```
 *
 * AGPL-3.0 §6 要求提供的是**对应源码（Corresponding Source）**，不是"运行时
 * 需要的那部分"。所以源码包从**上游目录原样打包**（只排除 `data/` 与 `.git/`，
 * 那是用户数据与版本历史，不属于源码）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/pack-st-source.mjs                    # 用 D:/SillyTavern
 * node scripts/pack-st-source.mjs --src E:/ST        # 指定别处
 * node scripts/pack-st-source.mjs --check            # 只报告，不写文件
 * ```
 *
 * 产物：`release/st-source/sillytavern-<版本>-source.zip`
 *
 * ## 与 `pack-st-assets.mjs` 的关系
 *
 * 两个脚本读**同一个源目录**、用**同一个版本号**，但排除清单不同：
 * 前者给运行时，后者给合规。别混用。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const srcIdx = args.indexOf('--src');
const src = resolve(srcIdx > -1 ? (args[srcIdx + 1] ?? 'D:/SillyTavern') : 'D:/SillyTavern');
const checkOnly = args.includes('--check');

if (!existsSync(src)) {
  console.error('找不到 SillyTavern 源目录：' + src);
  console.error('用 --src 指定，或先 clone：git clone --depth 1 -b 1.19.0 https://github.com/SillyTavern/SillyTavern');
  process.exit(2);
}

/** 从源目录的 package.json 读版本 —— 不写死，避免与 about-info 的声明漂移 */
const stPkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
const stVersion = String(stPkg.version ?? '');
if (stVersion === '') {
  console.error('源目录的 package.json 没有 version 字段：' + src);
  process.exit(2);
}

/**
 * 与 `client/src/settings/about-info.ts` 的 `BUNDLED_SILLYTAVERN_VERSION` 对拍。
 *
 * ★ 这两处必须一致：声明里写 1.19.0 而源码包是别的版本，等于
 *   "声称的对应源码与实际分发的不一致"——AGPL 下这是实质违规。
 */
const aboutSrc = readFileSync(join(ROOT, 'client/src/settings/about-info.ts'), 'utf8');
const declared = /BUNDLED_SILLYTAVERN_VERSION\s*=\s*'([^']+)'/.exec(aboutSrc)?.[1];
if (declared !== stVersion) {
  console.error('✘ 版本不一致：');
  console.error('   源目录 package.json  → ' + stVersion);
  console.error('   about-info.ts 声明   → ' + String(declared));
  console.error('   两处必须相同，否则"对应源码"与分发物对不上。');
  process.exit(3);
}

const OUT_DIR = join(ROOT, 'release/st-source');
const OUT = join(OUT_DIR, `sillytavern-${stVersion}-source.zip`);

console.log('源目录：' + src);
console.log('ST 版本：' + stVersion + '（与 about-info.ts 一致 ✔）');
console.log('产物：' + OUT);

if (checkOnly) {
  console.log('');
  console.log(existsSync(OUT) ? '已有源码包：' + (statSync(OUT).size / 1048576).toFixed(1) + ' MB' : '尚未打包');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
if (existsSync(OUT)) rmSync(OUT, { force: true });

/*
 * 用 **Windows 自带的 bsdtar**（`C:\Windows\System32\tar.exe`），
 * 不用 Git Bash 的 `tar`。
 *
 * ★ 这是踩过的坑：Git Bash 的 tar 收到 `-f D:\...zip` 时，会把 `D:` 当成
 *   **远程主机名**，报 `tar: Cannot connect to D: resolve failed`。
 *   而 System32 的 bsdtar 认 Windows 路径。
 *
 * 排除项只保留两类：
 *   .git   版本历史，几百 MB，不是源码
 *   data   用户数据（聊天记录/角色）—— 绝不能进公开发布的包
 */
const TAR = 'C:/Windows/System32/tar.exe';
const tarBin = existsSync(TAR) ? TAR : 'tar';

console.log('打包中…（' + tarBin + '）');
try {
  execFileSync(
    tarBin,
    ['-a', '-c', '-f', OUT, '--exclude=.git', '--exclude=data', '-C', src, '.'],
    { stdio: 'inherit' },
  );
} catch (error) {
  console.error('打包失败：' + (error instanceof Error ? error.message : String(error)));
  console.error('可以手工打包：在 ' + src + ' 上一级执行');
  console.error('  tar -a -c -f sillytavern-' + stVersion + '-source.zip --exclude=.git --exclude=data SillyTavern');
  process.exit(1);
}

const mb = statSync(OUT).size / 1048576;
console.log('');
console.log('✔ 已生成：' + OUT + '  (' + mb.toFixed(1) + ' MB)');
console.log('');
console.log('下一步（每个安卓版本都要做）：');
console.log('  1) 建 Release 时**同一次**上传：');
console.log('       release/android/tavern-card-studio-<版本>-arm64-release.apk');
console.log('       ' + OUT.replace(ROOT, '.'));
console.log('  2) 把 `node scripts/release-agpl-notice.mjs` 的输出贴进 Release 描述');
console.log('  3) 核对描述里的两个链接都能点开');
