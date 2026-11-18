#!/usr/bin/env node
/**
 * 生成**发布页上的 AGPL 指引文案**（2026-11-18，合规要求）。
 *
 * ## 为什么要把它做成脚本
 *
 * AGPL-3.0 §6 要求分发时"随附对应源码的获取方式"。这个"随附"发生在
 * **用户下载 APK 的那个页面**上 —— 也就是 GitHub Release 描述 / 官网下载页。
 *
 * 手写这段文字有三个必然的失效方式：
 *
 * ```text
 * ① 版本号写错（复制上一版描述忘了改）→ 指向别人的源码
 * ② 资产名写错（zip 叫别的名字）→ 点进去 404
 * ③ 干脆忘了贴 → 页面上没有任何源码指引，等于义务没履行
 * ```
 *
 * 三种都不报错。所以文案由脚本按**实际版本**生成，直接贴进 Release 描述即可。
 *
 * ## 用法
 *
 * ```bash
 * # 打印到终端（默认用 package.json 的版本）
 * node scripts/release-agpl-notice.mjs
 *
 * # 指定版本
 * node scripts/release-agpl-notice.mjs --version 0.2.0
 *
 * # 写进文件（顺便给 release-notes 用）
 * node scripts/release-agpl-notice.mjs --out release/AGPL-NOTICE-0.2.0.md
 * ```
 *
 * ## 发布流程（每个安卓版本都要走）
 *
 * ```text
 * 1. 打包 APK
 * 2. 打包 ST 源码 zip：见 --st-zip 提示（scripts/pack-st-source.mjs）
 * 3. 建 Release，**同一次**上传：APK + ST 源码 zip
 * 4. 把本脚本的输出贴进 Release 描述
 * 5. 核对：描述里的两个链接都能点开
 * ```
 *
 * ★ 第 3 步的"同一次"很关键：先发 APK 再补 zip，中间那段时间用户下到的包
 *   是**拿不到对应源码**的。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_SILLYTAVERN_VERSION,
  REPO_URL,
  appSourceUrl,
  releasePageUrl,
  sillytavernSourceUrl,
  sillytavernUpstreamTagUrl,
} from '../client/src/settings/about-info.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};

const version =
  argOf('--version') ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const apkName = `tavern-card-studio-${version}-arm64-release.apk`;
const stZipName = `sillytavern-${BUNDLED_SILLYTAVERN_VERSION}-source.zip`;

const notice = `## 关于本安装包的开源许可（请先读这段）

本 APK **包含以 AGPL-3.0 许可的组件**（SillyTavern ${BUNDLED_SILLYTAVERN_VERSION}，
内置为聊天引擎）。按 AGPL-3.0 §6 的要求，其**对应源代码**可在此获取：

- **内置引擎源码（SillyTavern ${BUNDLED_SILLYTAVERN_VERSION}）**
  ${sillytavernSourceUrl(version)}
  —— 即本 Release 资产中的 \`${stZipName}\`
- 若上面这个链接取不到，可改用上游 tag：
  ${sillytavernUpstreamTagUrl()}

- **本应用自身的源码（v${version}）**
  ${appSourceUrl(version)}
  —— 也可在 ${releasePageUrl(version)} 页面的 *Source code (zip)* 处下载

内置的 SillyTavern **未作任何修改**，原样随包分发。

本项目自身的代码以 **MIT** 许可发布；第三方组件的完整清单与各自许可见
[THIRD-PARTY-NOTICES](${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md)。

> 如果你要**再分发**这个 APK，请一并保留上述指引与
> \`THIRD-PARTY-NOTICES.md\`、\`LICENSES/\` 目录。
`;

const outPath = argOf('--out');
if (outPath !== undefined) {
  writeFileSync(join(ROOT, outPath), notice, 'utf8');
  console.log('已写出 ' + outPath);
  console.log('');
}

console.log(notice);

/* ── 发布前自检 ─────────────────────────────────── */
console.log('────────────────────────────────────────');
console.log('发布前自检（版本 v' + version + '）');
console.log('────────────────────────────────────────');

const apkLocal = join(ROOT, 'release/android', apkName);
console.log(
  (existsSync(apkLocal) ? '✔ ' : '· ') +
    '本地 APK：' +
    (existsSync(apkLocal) ? apkName : '尚未产出（先跑安卓构建）'),
);

const stZipLocal = join(ROOT, 'client/src-tauri/gen/android/app/src/main/assets/st.zip');
console.log(
  (existsSync(stZipLocal) ? '✔ ' : '· ') +
    '本地 st.zip：' +
    (existsSync(stZipLocal) ? '存在（用 pack-st-source.mjs 转成 Release 资产）' : '尚未打包'),
);

console.log('');
console.log('★ 上传时必须**同一次**传这三样，否则用户下到的包拿不到对应源码：');
console.log('   1) ' + apkName);
console.log('   2) ' + stZipName);
console.log('   3) 把上面那段文案贴进 Release 描述');
console.log('');
console.log('★ 每个版本都要重做一遍，不要复用上一版的描述（版本号会指错）。');
