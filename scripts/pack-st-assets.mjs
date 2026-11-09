#!/usr/bin/env node
/**
 * 把 SillyTavern 打包成 APK 的 assets/st.zip（v0.1.7 / T15.3）。
 *
 * ## 为什么全量打包而不联网下载
 *
 * 决策 #262：用户对体积不敏感，而"首启还要再下 400 MB"才是真正的流失点
 * —— 手机流量、弱网、中途切后台。
 *
 * ## 排除清单的理由（每一条都会让 APK 变小，但只有前两条是必须的）
 *
 * · `data/`      用户数据（聊天记录/角色）。**必须排除**：
 *                我们自己有 `--dataRoot=files/st-data`，把别人的数据装进
 *                APK 既侵犯隐私，也会让"首启是干净环境"这个前提不成立。
 * · `.git/`      git 历史，几百 MB，纯垃圾。
 * · `tests/`     单元测试，运行时用不到。
 * · `backups/`   用户备份。
 * · 文档图片     体积大、运行时用不到。
 *
 * 保留 `default/`（ST 的默认配置与前端资源，缺了起不来）。
 *
 * ## 用法
 *
 *   node scripts/pack-st-assets.mjs [--src D:/SillyTavern] [--check]
 *
 * `--check` 只报告"会不会重新打包"，不写文件。
 */

import { createWriteStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** 输出位置：APK 的 assets */
const OUT = join(REPO, 'client/src-tauri/gen/android/app/src/main/assets/st.zip');

/**
 * 必须排除的目录（相对 ST 根）。
 *
 * 用**相对路径前缀**匹配而不是 basename：`node_modules/foo/tests` 这种
 * 嵌套的 tests 也想排掉，但 `src/endpoints/` 里真有叫 tests 的东西时
 * 误排会导致 ST 起不来 —— 所以这里只排 ST 根下的那几个。
 */
const EXCLUDE_ROOTS = new Set([
  '.git',
  'data',
  'backups',
  'tests',
  'doc',
  'docs',
]);

/**
 * 打包时的目录遍历。
 *
 * 一个细节：ST 的 `node_modules` 里有**符号链接**（npm 的 bin 软链）。
 * 解包时若把符号链接当普通文件读，会读到目标内容（体积翻倍）；
 * 若跳过，某些包的 CLI 会缺文件。这里**跳过符号链接**，
 * 因为 ST 运行只需要 `require` 的模块文件，不需要 bin 里的软链。
 */
function* walk(dir, root) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full);

    /*
     * ★ 只看**根级**目录（`rel` 只有一段）。
     *
     * 2026-10-31 真机抓到的崩溃：
     *
     *     Error: Cannot find module '../doc/directives.js'
     *     （node_modules/yaml/dist/doc/directives.js）
     *
     * 第一版写的是 `if (!rel.includes('/') && ...)` —— 而 **Windows 的
     * `path.relative()` 返回反斜杠**，所以 `rel` 形如
     * `node_modules\yaml\dist\doc`，`includes('/')` **恒为 false**。
     * 于是"仅根级排除"退化成"任意层级按名字排除"，
     * 把 `node_modules/yaml/dist/doc/`、以及任意深度的 `data/` 目录全删了。
     *
     * 后果不是"少几个不重要的文件"，而是**依赖在手机上跑不起来** ——
     * 而且报错指向 `yaml`，看起来像"依赖装错了"，与打包脚本毫无关系。
     *
     * 修法：用 `split(/[\\/]/)` 判断层级，两种分隔符都认。
     */
    const segments = rel.split(/[\\/]/);
    if (segments.length === 1 && EXCLUDE_ROOTS.has(segments[0])) continue;

    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      yield* walk(full, root);
    } else if (entry.isFile()) {
      yield { full, rel };
    }
  }
}

/**
 * 极简 ZIP 写入器（store 模式，不压缩）。
 *
 * ## 为什么不引 archiver / jszip
 *
 * 项目至今零打包依赖（`pack-server.mjs` 也是手写的）。
 * 加一个依赖只为打一次包不划算，而 ZIP 的 store 格式足够简单。
 *
 * ## 为什么不压缩
 *
 * ST 的 `node_modules` 里绝大部分是纯文本，deflate 能压到 30%
 * —— 但**构建时间会从 40 秒变成几分钟**（4 万个文件逐个 deflate）。
 * 而且 APK 本身在安装时不再二次压缩，所以高压缩率的收益只在
 * 下载体积上；而我们是本地安装，不受影响。
 *
 * 真要压的话：把 `method` 改成 8 并接 `node:zlib` 的 `deflateRaw`。
 */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

async function main() {
  const args = process.argv.slice(2);
  const srcIndex = args.indexOf('--src');
  const src = resolve(srcIndex >= 0 ? args[srcIndex + 1] : 'D:/SillyTavern');
  const checkOnly = args.includes('--check');

  if (!existsSync(join(src, 'server.js'))) {
    console.error(`[FATAL] ${src} 不是 SillyTavern 目录（找不到 server.js）`);
    process.exit(2);
  }

  const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;

  console.log(`源目录 = ${src}`);
  console.log(`版本   = ${version}`);
  console.log(`输出   = ${OUT}`);

  if (checkOnly) {
    console.log('[--check] 不写文件');
    return;
  }

  const entries = [];
  for (const item of walk(src, src)) entries.push(item);
  console.log(`待打包文件数 = ${entries.length}`);

  const out = createWriteStream(OUT);

  /*
   * ★ error 监听只挂一次。
   *
   * 第一版在每次 `write()` 里 `out.once('error', rej)` —— 2 万个文件
   * 就是 2 万个监听器，Node 在 11 个时就开始警告
   * `MaxListenersExceededWarning`。虽然警告本身不致命，但它意味着
   * **内存里挂着几万个永不触发的闭包**，而且真正的错误会被最后那个
   * 监听器吞掉（其余的 promise 永远悬着）。
   *
   * 改成：一个监听器把错误记下来，`write()` 每次先检查。
   */
  let writeError = null;
  out.on('error', (error) => {
    writeError = error;
  });

  const write = (buf) =>
    new Promise((res, rej) => {
      if (writeError !== null) {
        rej(writeError);
        return;
      }
      if (out.write(buf)) res();
      else out.once('drain', res);
    });

  const central = [];
  let offset = 0;
  let totalBytes = 0;

  for (const { full, rel } of entries) {
    const data = readFileSync(full);
    const stat = statSync(full);
    const { time, day } = dosTime(stat.mtime);
    const nameBuf = Buffer.from(rel.split('\\').join('/'), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    await write(local);
    await write(data);

    central.push({ nameBuf, crc, size: data.length, offset, time, day });
    offset += local.length + data.length;
    totalBytes += data.length;
  }

  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46 + entry.nameBuf.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(10, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.day, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuf.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    entry.nameBuf.copy(header, 46);
    await write(header);
  }

  const centralSize = central.reduce((sum, e) => sum + 46 + e.nameBuf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);

  await new Promise((res) => out.end(res));

  const mb = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`[OK] 写出 ${OUT}`);
  console.log(`     内容 ${mb} MB，${central.length} 个文件`);
}

main().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});
