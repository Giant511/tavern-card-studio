/**
 * T15.3 引擎层：Kotlin 实现 与 TS 规格 的一致性（2026-10-31 第四批）。
 *
 * ## 为什么需要这组测试
 *
 * T15.3 的关键判断（探活超时、解包进度、孤儿判定、SIGTERM 等待）
 * 写了两份：
 *
 *   · `shared/src/android/st-lifecycle.ts` —— **规格 + 单测**（PC 上能跑）
 *   · `.../stengine/*.kt`                   —— **实现**（只能在真机上跑）
 *
 * 这不是冗余，是被迫的：Android 侧跑不了 TS，TS 侧跑不了 Android。
 * 但"同一件事写两遍"必然分叉 —— 而分叉的后果是
 * "单测说 30 秒，真机等 20 秒"，那种缺陷很难归因。
 *
 * 所以这里对**常量**做逐字比对。数字改了一边，测试就红。
 *
 * ## 这组测试能覆盖什么、不能覆盖什么
 *
 * 能：常量值、关键方法名与顺序、manifest 必须有的声明。
 * 不能：Kotlin 的运行时行为（那要靠真机自动化，见 `verify-android-device.sh`）。
 *
 * 说清这个边界，是为了不让下一个人以为"测试绿了就等于引擎没问题"。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const KT_DIR = join(
  REPO,
  'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/stengine',
);
/**
 * 读 Kotlin 源码并**剥掉注释**。
 *
 * ## 为什么必须剥
 *
 * 这组断言里有大量"某文件里不许出现 X"。第一版直接扫全文，
 * 于是**解释性的注释**把它判红了 —— 而且红得非常一致：
 *
 *   · `StUnpacker.kt` 注释里写"只有 `libnode.so` 必须待在只读目录"
 *     → 命中 `doesNotMatch(/libnode/)`
 *   · `StLauncher.kt` 注释里写"**不传** `--listen`：会暴露到局域网"
 *     → 命中 `doesNotMatch(/--listen/)`
 *   · 同一条注释里写"不能用 /data/local/tmp，tmp 会被系统清"
 *     → 命中 `doesNotMatch(/local\/tmp/)`
 *
 * 那三句注释恰恰是在**记录为什么要这么做**，是文件里最该保留的部分。
 * 为了过测删掉它们是最坏的选择 —— 所以修判据。
 * （与 `nebula-walkthrough.test.mjs` 走查 10 同一族问题，那条也修过。）
 */
const read = (name) => stripKotlinComments(readFileSync(join(KT_DIR, name), 'utf8'));

function stripKotlinComments(text) {
  /*
   * ## 为什么不用两条正则了事
   *
   * 第一版是 `replace(/\/\/.*$/gm, '')`。它把
   * `"http://127.0.0.1:$port/version"` 里的 `//` 当成了行注释起点，
   * 于是**把这一行剩下的内容全删了** —— 包括 `/version`。
   * 结果"必须问 /version"那条判据永远红，而源码明明写着。
   *
   * URL 里的 `//` 是这一类问题的标准形态（任何带协议的字符串都会踩）。
   * 所以这里手写一个**尊重字符串字面量**的扫描器：
   * 遇到引号就吃到配对的闭引号，只有字符串外面的 `//` 与 `/*` 才是注释。
   */
  let out = '';
  let i = 0;
  let inBlock = false;

  while (i < text.length) {
    const ch = text[i];

    if (inBlock) {
      if (ch === '*' && text[i + 1] === '/') {
        inBlock = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      // 行注释：跳到行尾（保留换行，保持行数）
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
      continue;
    }

    // 字符串字面量：原样保留，跳过里面的 // 与 /*
    if (ch === '"' || ch === '\'') {
      out += ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += text[i];
          if (i + 1 < text.length) out += text[i + 1];
          i += 2;
          continue;
        }
        out += text[i];
        if (text[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * 去掉 Kotlin 数字里的下划线分隔符。
 *
 * `30_000L` 与 `30000L` 是同一个值，但字符串比较不同。
 * 第一版直接拼 `${ts.PROBE_TIMEOUT_MS}` 得到 `30000`，
 * 而源码写的是 `30_000L` —— 判据以"写法不同"为由报错，那是假红。
 */
function undigits(text) {
  /*
   * 只去掉**前后都是数字**的下划线。
   *
   * 第一版写的是 `\b(\d[\d_]*)\b` —— 它对 `30_000L` **无效**：
   * `30_000` 与后面的 `L` 都是 `\w`，两者之间没有词边界，
   * 所以 `\b` 匹配失败。判据于是永远红，而源码其实是对的。
   *
   * 用零宽断言只处理 `数字_数字` 的形状：`30_000` → `30000`，
   * 而 `PROBE_TIMEOUT_MS` 这种标识符里的下划线不受影响。
   */
  return text.replace(/(?<=\d)_(?=\d)/g, '');
}
const mainActivity = () =>
  readFileSync(
    join(REPO, 'client/src-tauri/gen/android/app/src/main/java/com/taverncardstudio/client/MainActivity.kt'),
    'utf8',
  );
const manifest = () =>
  readFileSync(join(REPO, 'client/src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8');
const gradle = () =>
  readFileSync(join(REPO, 'client/src-tauri/gen/android/app/build.gradle.kts'), 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、常量必须与 TS 规格一致
   ═══════════════════════════════════════════════════════════ */

test('★★ 探活间隔/上限：Kotlin 与 TS 一致（500ms / 30s）', async () => {
  const ts = await import('../shared/dist/android/st-lifecycle.js');
  const kt = undigits(read('StLauncher.kt'));

  assert.match(
    kt,
    new RegExp(`PROBE_INTERVAL_MS\\s*=\\s*${String(ts.PROBE_INTERVAL_MS)}L`),
    `Kotlin 的 PROBE_INTERVAL_MS 必须等于 TS 的 ${String(ts.PROBE_INTERVAL_MS)}`,
  );
  assert.match(
    kt,
    new RegExp(`PROBE_TIMEOUT_MS\\s*=\\s*${String(ts.PROBE_TIMEOUT_MS)}L`),
    `Kotlin 的 PROBE_TIMEOUT_MS 必须等于 TS 的 ${String(ts.PROBE_TIMEOUT_MS)}`,
  );
});

test('★★ 解包体积常量一致（437 MB）', async () => {
  /*
   * 这个数字是进度条的分母。两边不一致时进度会算错 ——
   * 而进度条"走得快/慢"很难被当成 bug 报出来，只会让人觉得"卡了"。
   */
  const ts = await import('../shared/dist/android/st-lifecycle.js');
  const kt = read('StUnpacker.kt');

  const expectedMb = ts.ST_UNPACKED_BYTES / 1024 / 1024;
  assert.equal(expectedMb, 437, 'TS 侧应是 437 MB');

  assert.match(kt, /437L\s*\*\s*1024\s*\*\s*1024/, 'Kotlin 侧必须是 437 MB');
});

test('★★ 解包进度封顶 0.99（不许显示 100% 而还在解）', async () => {
  const ts = await import('../shared/dist/android/st-lifecycle.js');
  assert.equal(ts.unpackProgress(437 * 1024 * 1024), 0.99, 'TS 侧语义确认');
  assert.equal(ts.unpackProgress(999 * 1024 * 1024), 0.99);

  const kt = read('StUnpacker.kt');
  // Kotlin 里必须也有 >= 1.0 → 0.99 这条分支
  assert.match(kt, /if\s*\(ratio\s*>=\s*1\.0\)\s*0\.99\s*else\s*ratio/, 'Kotlin 侧必须同样封顶 0.99');
});

test('★ SIGTERM 后等 5 秒再 SIGKILL', () => {
  const kt = undigits(read('StLauncher.kt'));
  assert.match(kt, /GRACEFUL_STOP_MS\s*=\s*5000L/, 'SIGTERM 到 SIGKILL 之间必须是 5 秒');
  assert.match(kt, /destroy\(\)/, '要先发 SIGTERM（Java 的 destroy 在 Unix 上是 SIGTERM）');
  assert.match(kt, /destroyForcibly\(\)/, '超时后要 SIGKILL');
});

/* ═══════════════════════════════════════════════════════════
   二、W^X 五条件（少一条就起不来）
   ═══════════════════════════════════════════════════════════ */

test('★★ W^X 条件 1+3：exec 的是 nativeLibraryDir 里的 libnode.so，且 libc++ 同目录', () => {
  const kt = read('StLauncher.kt');

  assert.match(kt, /nativeLibraryDir/, '必须从 nativeLibraryDir 取可执行体');
  assert.match(kt, /File\(nativeDir,\s*"libnode\.so"\)/, '可执行体必须是 libnode.so');
  assert.match(kt, /libc\+\+_shared\.so/, '必须检查 libc++_shared.so 在不在');
});

test('★★ W^X 条件 4：必须设 LD_LIBRARY_PATH', () => {
  /*
   * 这是 spike 里最容易漏的一条：文件在、可执行位在，但链接器找不到
   * libc++_shared.so —— 报 `dlopen failed`，而现象像"node 没输出"。
   */
  const kt = read('StLauncher.kt');
  assert.match(
    kt,
    /environment\(\)\["LD_LIBRARY_PATH"\]\s*=\s*nativeDir/,
    '必须把 nativeLibraryDir 塞进 LD_LIBRARY_PATH',
  );
});

test('★★ W^X 条件 2：gradle 开 useLegacyPackaging + manifest 开 extractNativeLibs', () => {
  assert.match(gradle(), /useLegacyPackaging\s*=\s*true/, 'gradle 必须 useLegacyPackaging = true');
  assert.match(manifest(), /android:extractNativeLibs="true"/, 'manifest 必须 extractNativeLibs="true"');
});

test('★★ W^X 条件 5：绝不把可执行体解到 files/ 再执行', () => {
  /*
   * 反向断言：Kotlin 里不许出现"从 assets 解出 node 再 exec"的写法。
   * 那种写法在 targetSdk>=29 上会被系统拒（EACCES）。
   */
  const unpacker = read('StUnpacker.kt');
  const launcher = read('StLauncher.kt');

  assert.doesNotMatch(unpacker, /libnode/, '解包器不许碰 libnode');
  assert.doesNotMatch(
    launcher,
    /File\(dataDir|File\(stDir[^)]*\)[^)]*\.canExecute/,
    '不许把可执行体当可写目录里的文件',
  );
  assert.match(launcher, /node\.canExecute\(\)/, '要检查可执行位（失败时给可读原因）');
});

/* ═══════════════════════════════════════════════════════════
   三、启动参数（与设计文档逐条对应）
   ═══════════════════════════════════════════════════════════ */

test('★ 启动参数：--dataRoot / --port / --browserLaunchEnabled=false，且不传 --listen', () => {
  const kt = read('StLauncher.kt');

  assert.match(kt, /--dataRoot=/, '必须传 --dataRoot');
  assert.match(kt, /--port=/, '必须传 --port');
  assert.match(kt, /--browserLaunchEnabled=false/, '必须关掉浏览器跳转');
  assert.doesNotMatch(kt, /--listen/, '**不许**传 --listen（会把 ST 暴露到局域网，而它没有鉴权）');
});

test('★ --dataRoot 指 filesDir，不是 /data/local/tmp', () => {
  /*
   * spike 用的是 /data/local/tmp —— 那是**测试位**，tmp 会被系统清。
   * 用户聊天记录放那儿等于随时可能消失。
   */
  const unpacker = read('StUnpacker.kt');
  assert.match(unpacker, /File\(context\.filesDir,\s*"st-data"\)/, 'dataRoot 必须是 filesDir/st-data');

  const launcher = read('StLauncher.kt');
  assert.doesNotMatch(launcher, /local\/tmp/, '不许用 /data/local/tmp');
});

/* ═══════════════════════════════════════════════════════════
   四、孤儿清理：端口 + 身份双判据，不杀未知
   ═══════════════════════════════════════════════════════════ */

test('★★ 孤儿判定要看身份（agent 含 SillyTavern），不是只看端口通', () => {
  const kt = read('StLauncher.kt');
  assert.match(kt, /\/version/, '必须问 /version');
  assert.match(kt, /SillyTavern/, '必须按 agent 里的 SillyTavern 判身份');
});

test('★★ 端口被非 ST 占用时：不杀，改用备用端口', () => {
  const kt = read('StLauncher.kt');
  assert.match(kt, /8001\.\.8010/, '要有备用端口段');
  assert.match(kt, /ProbeState\.OTHER/, '要区分"有人听但不是 ST"');
  /*
   * 反向：不许出现"按端口找 PID 然后 kill"的写法。
   * 那属于越权清理（设计文档 §5.2）。
   */
  assert.doesNotMatch(kt, /kill\s*\(/, '不许 kill 非自己 spawn 的进程');
  assert.doesNotMatch(kt, /pidof|pkill/, '不许按名字/端口找进程去杀');
});

test('★★ 只杀自己 spawn 的 PID（内存持有，不落盘）', () => {
  const kt = read('StLauncher.kt');
  assert.match(kt, /private var process: Process\?/, 'PID 必须由内存里的 Process 对象持有');
  assert.doesNotMatch(kt, /pidFile|\.pid'|PID_FILE/, '不许写 PID 文件（PID 会被复用，拿它 kill 会杀错）');
});

test('★ 启动前先探端口再决定（START_STICKY 的重启竞态）', () => {
  /*
   * 系统重建服务时可能已经有 node 在跑。直接 exec 会 EADDRINUSE，
   * 而失败只在日志里 —— 用户看到的是"通知在，但页面打不开"。
   */
  const kt = read('StLauncher.kt');
  const fn = kt.slice(kt.indexOf('fun ensureRunning'), kt.indexOf('private fun startNode'));

  assert.match(fn, /probe\(PRIMARY_PORT\)/, '先探首选端口');
  assert.match(fn, /reused = true/, '是 ST 就复用，不新起');
});

/* ═══════════════════════════════════════════════════════════
   五、前台服务
   ═══════════════════════════════════════════════════════════ */

test('★★ 前台服务：START_STICKY + 5 秒内 startForeground', () => {
  const kt = read('StService.kt');

  assert.match(kt, /START_STICKY/, '必须 START_STICKY');
  assert.match(kt, /SPECIAL_USE/, 'Android 14+ 必须声明 specialUse');

  /*
   * 顺序判据：`startForegroundCompat` 必须出现在解包/启动**之前**。
   * 反了的话 437 MB 解包那十几秒就超过 5 秒上限，系统直接杀进程。
   */
  const startFg = kt.indexOf('startForegroundCompat(buildNotification');
  const unpack = kt.indexOf('StUnpacker.unpack');
  assert.ok(startFg > 0 && unpack > 0, '找不到关键调用');
  assert.ok(
    startFg < unpack,
    'startForeground 必须在解包之前（否则 5 秒超时被系统杀）',
  );
});

test('★★ 通知文案：写内存、不写端口/PID', () => {
  const kt = read('StService.kt');

  assert.match(kt, /口袋酒馆 正在运行/, '标题按设计文档');
  /*
   * ★★★ 2026-11-10 改：正文里的 `SillyTavern` 换成「聊天服务」。
   *
   * 原来这条钉的是设计文档原文「SillyTavern 在后台待命」。而**通知栏是
   * 用户可见文案**，用户从没见过 SillyTavern 这个词 —— 他报的问题原话是
   * 「连不上ST的时候不能提示无法连接ST」。
   *
   * 同一条标准也适用于错误文案（`error.rs` 的 `#[error("连不上 SillyTavern…")]`
   * 已改成「连不上聊天服务」）。两处必须一致，不能只改一处。
   *
   * 守的性质没变：正文要有一句"在后台待命"，让用户知道这东西还活着。
   */
  assert.match(kt, /聊天服务在后台待命/, '正文按红线：说"聊天服务"，不说 SillyTavern');
  assert.match(kt, /MB 内存/, '要写出内存（不写的话用户会以为陌生应用占内存而卸载）');

  /*
   * 反向：正文里不许出现端口号 / PID。
   * 那是开发者关心的，与 UI 文案红线同一条标准。
   */
  const readyFn = kt.slice(kt.indexOf('private fun readyText'), kt.indexOf('private fun startRssRefresh'));
  assert.doesNotMatch(readyFn, /端口|port|\bpid\b/i, '通知正文不许写端口/PID');
});

test('★ 通知有「停止」动作（应用被杀后唯一的停止入口）', () => {
  const kt = read('StService.kt');
  assert.match(kt, /"停止"/, '通知里必须有停止');
  assert.match(kt, /ACTION_STOP/, '停止走独立 action');
});

test('★ manifest 注册了服务且不导出', () => {
  const xml = manifest();
  assert.match(xml, /\.stengine\.StService/, '必须注册 StService');
  assert.match(xml, /foregroundServiceType="specialUse"/, '必须声明 specialUse');
  assert.match(xml, /PROPERTY_SPECIAL_USE_FGS_SUBTYPE/, 'Android 14+ 要求说明特殊用途');
  /*
   * 导出出去等于给任何应用一个"启动/停止你引擎"的开关。
   */
  const serviceBlock = xml.slice(xml.indexOf('.stengine.StService') - 200, xml.indexOf('</service>'));
  assert.match(serviceBlock, /android:exported="false"/, '服务必须不导出');
});

/* ═══════════════════════════════════════════════════════════
   六、JS 桥
   ═══════════════════════════════════════════════════════════ */

test('★★ JS 桥只暴露九个窄方法，且 status 不做网络探测', () => {
  const kt = read('StBridge.kt');

  const exposed = [...kt.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map((m) => m[1]);
  /*
   * ## 白名单（2026-11-04 从三个扩到四个：加 `httpRequest`）
   *
   * 原来只有 start / status / stop。加 `httpRequest` 是**真机逼出来的**：
   *
   * ```text
   *   fetch('http://127.0.0.1:8000/version')  → Failed to fetch
   *   fetch('https://10.9.0.2:8443/version')  → Failed to fetch
   * ```
   *
   * 这个壳里 WebView 的网络栈没通（聊天一直走 invoke 到 Rust，从没碰过 fetch），
   * 所以仓库的 HTTP 只能从 Android 侧发。
   *
   * ## 为什么它没有突破安全边界
   *
   * · 只接受 `http://` / `https://`（`file://` / `content://` 一律拒绝）
   * · 不跟随 https → http 的降级重定向
   * · `insecure` 只由前端在**用户明确确认风险后**传 true
   * · 仍然不接受"执行命令"、不接受任意文件路径
   *
   * ## 2026-11-04 再扩到五个：加 `readAsset`
   *
   * 用途只有一件：移动端从仓库导入卡时，需要一张 PNG 当容器，
   * 用的是桌面端那张内置兜底卡面（APK 里 `assets/card-face-default.png`）。
   * WebView 读不到 assets，只能由 Android 侧读。
   *
   * ## 为什么它没有突破安全边界
   *
   * 它**不接受路径**，只接受 `READABLE_ASSETS` 白名单里的名字。
   * 一旦接受任意路径，它就变成"把安装包任意文件读给页面"的通道。
   *
   * ## 2026-11-04 再扩到六个：加 `sharePng`
   *
   * 用户要求「支持将卡导出为PNG分享出来」。WebView 里没有 `navigator.share`，
   * 也没有写文件能力，`ACTION_SEND` 只能从原生起。
   *
   * ## 为什么它没有突破安全边界
   *
   * · 只接受**字节**（base64），不接受路径 —— 落点固定为 `cacheDir/share/`
   * · 文件名由它自己滤过（保留中文，滤掉路径分隔符与控制字符）
   * · 不读、不删、不返回文件内容
   *
   * ## 2026-11-05 再扩到七个：加 `httpRequestAsync`
   *
   * 起因是用户的真机反馈：
   *
   * > 如果服务器连不上的情况下点到仓库后会卡很久而且卡的时候不能对APP
   * > 做任何操作包括切底部tab，这个是不能阻塞的
   *
   * 同步版 `httpRequest` 虽然跑在 JavaBridge 线程，但 **JS 侧调它是同步等待**：
   * WebView 的 JS 执行线程停在这句上，直到 Kotlin 返回。`connectTimeout`
   * 15 秒 ⇒ 整个 App 冻 15 秒。
   *
   * ## 为什么它没有突破安全边界
   *
   * 它和 `httpRequest` **共用同一个 `performHttp()` 实现** —— 该有的边界
   * 一个不少（只认 http/https、不跟随降级重定向、`insecure` 需用户确认）。
   * 新增的只是"在别的线程跑完再回传"，没有多出任何能力。
   *
   * ## 2026-11-09 再扩到九个：加 `scanTestCards` / `removeTestCards`
   *
   * 0.1.7 收尾时发现一个只在**升级路径**上出现的缺口：早期包首启会往
   * `characters/` 播一张内置测试卡，而删播种器只保证"不再播新的"，
   * 不会清掉已经种下去的。于是清理必须由原生做（WebView 没有文件能力）。
   *
   * ## 为什么它们没有突破安全边界
   *
   * ```text
   *   · scan 只**列** characters/ 下的 .png，返回 (文件名, character_version)
   *   · remove 只删**该目录内**的名字，且拒绝含 `/` `\` 的名字（防 ../ 逃逸）
   *   · 「什么算测试卡」的判断不在 Kotlin，而在
   *     shared/src/android/test-card-cleanup.ts（双判据 + 单测）
   *   · 不读任意路径、不返回文件内容、不执行任何命令
   * ```
   *
   * 换句话说：它多出来的能力只有"删自己角色目录里指定的 png"，
   * 而那个目录本来就是 App 自己管理的。
   *
   * 判据仍然要求"白名单精确相等" —— 再加方法要重新过这一关。
   */
  assert.deepEqual(
    exposed.sort(),
    [
      'httpRequest',
      'httpRequestAsync',
      'readAsset',
      'removeTestCards',
      'scanTestCards',
      'sharePng',
      'start',
      'status',
      'stop',
    ],
    `桥只暴露这九个方法（多一个就是多一条越权路径）。实际：${exposed.join(', ')}`,
  );

  /*
   * 异步方法必须与同步方法**共用同一份实现**（不许复制一份、各行其是）。
   */
  assert.match(
    kt,
    /fun httpRequest\(specJson: String\): String = performHttp\(specJson\)/,
    '同步版要委托给 performHttp',
  );
  assert.match(kt, /val reply = performHttp\(specJson\)/, '异步版也要用 performHttp');

  /*
   * `sharePng` 的三条硬约束：走 FileProvider、带 NEW_TASK、不接受路径参数。
   */
  const shareFn = kt.slice(kt.indexOf('fun sharePng('), kt.indexOf('fun insecureSocketFactory'));
  assert.match(shareFn, /FileProvider\.getUriForFile/, '必须走 FileProvider（file:// 会抛 FileUriExposedException）');
  assert.match(shareFn, /FLAG_ACTIVITY_NEW_TASK/, 'JS 线程没有 Activity，必须 NEW_TASK');
  assert.match(shareFn, /cacheDir/, '落点固定为缓存目录');
  assert.doesNotMatch(shareFn, /fun sharePng\([^)]*path/, 'sharePng 不许接受路径参数');

  /*
   * `readAsset` 必须是白名单式：有集合、且用它做判断。
   * 只写 `context.assets.open(name)` 而不校验，等于开放了整个 assets。
   */
  assert.match(kt, /READABLE_ASSETS\s*=\s*setOf\(/, 'readAsset 要用白名单集合');
  const readAssetFn = kt.slice(kt.indexOf('fun readAsset('), kt.indexOf('fun insecureSocketFactory'));
  assert.match(readAssetFn, /READABLE_ASSETS\.contains\(/, 'readAsset 要校验白名单');
  assert.doesNotMatch(readAssetFn, /assets\.open\(name\)/, '不许把原始参数直接交给 assets.open');

  assert.doesNotMatch(kt, /exec|Runtime\.getRuntime|ProcessBuilder/, '桥不许能执行命令');
  assert.doesNotMatch(kt, /fun\s+\w+\s*\([^)]*port/, '桥不许接受端口参数');

  /*
   * status() 在 JS 线程上跑，探测最长 800ms —— 现探会让页面每秒卡 0.8 秒。
   */
  const statusFn = kt.slice(kt.indexOf('fun status()'), kt.indexOf('return json.toString'));
  assert.doesNotMatch(statusFn, /StLauncher\.probe/, 'status 不许现探（会卡住 JS 线程）');
  assert.match(statusFn, /StLauncher\.ready/, 'status 要读缓存');
});

test('★ 桥注入挂在 onWebViewCreate（早于页面脚本）', () => {
  const kt = mainActivity();
  assert.match(kt, /override fun onWebViewCreate/, '必须用 onWebViewCreate 钩子');
  assert.match(kt, /addJavascriptInterface/, '必须注入');
  assert.match(kt, /StBridge\.JS_NAME/, '名字要引用常量，不许两处各写一份');
});

test('★ App 启动时拉起服务（设计文档 §5.4）', () => {
  const kt = mainActivity();
  assert.match(kt, /StService\.start\(this\)/, 'onCreate 要拉起服务');
});

/* ═══════════════════════════════════════════════════════════
   七、安全区注入
   ═══════════════════════════════════════════════════════════ */

test('★ 状态栏高度注入成 CSS 变量（修上一批的真机重叠缺陷）', () => {
  const kt = mainActivity();
  assert.match(kt, /--nb-safe-top/, '必须注入 --nb-safe-top');
  assert.match(kt, /status_bar_height/, '要读状态栏高度');

  /*
   * ★ 2026-11-05 改：不再只看 `chat.css`。
   *
   * 安全区的取值链搬到了 token（`--nb-page-inset-top`，定义在
   * `nebula-tokens.css`），`chat.css` 只用 `var(--nb-page-inset-top)`。
   * 原判据只看 `chat.css` 就红了 —— 而"CSS 侧到底读没读注入值"这件事
   * 一个字没变。
   *
   * 判据要钉**性质**：两个样式文件合起来必须读 `--nb-safe-top`。
   * 具体写在哪个文件是实现细节。
   */
  const css = [
    readFileSync(join(REPO, 'client/src/chat/chat.css'), 'utf8'),
    readFileSync(join(REPO, 'client/src/chat/nebula-tokens.css'), 'utf8'),
  ].join('\n');
  assert.match(css, /var\(--nb-safe-top/, 'CSS 侧必须读注入的 --nb-safe-top');
});

/* ═══════════════════════════════════════════════════════════
   八、解包器
   ═══════════════════════════════════════════════════════════ */

test('★★ 解包完成用双判据（标记 + 关键文件）', () => {
  const kt = read('StUnpacker.kt');
  const fn = kt.slice(kt.indexOf('fun isUnpacked'), kt.indexOf('fun unpack('));

  assert.match(fn, /markerFile\(context\)\.exists\(\)/, '要有标记文件判据');
  assert.match(fn, /"server\.js"/, '要判 server.js');
  assert.match(fn, /\.package-lock\.json/, '要判 node_modules 装齐');
});

test('★★ 标记文件必须最后写（否则半途被杀会假绿）', () => {
  const kt = read('StUnpacker.kt');
  const writeIdx = kt.indexOf('markerFile(context).writeText');
  assert.ok(writeIdx > 0, '要写标记');

  /*
   * 标记必须在解包循环之后。判据：写标记的位置在 `while (true)` 循环
   * 结束之后 —— 用"写标记之前没有 `zip.nextEntry`"近似表达。
   */
  const before = kt.slice(0, writeIdx);
  assert.ok(before.includes('zip.nextEntry'), '解包循环必须在写标记之前');
  assert.ok(
    before.lastIndexOf('zip.closeEntry()') < writeIdx,
    '最后一个 closeEntry 必须在写标记之前',
  );
});

test('★ 解包前先删标记（上次半途被杀的情况）', () => {
  const kt = read('StUnpacker.kt');
  const del = kt.indexOf('markerFile(context).delete()');
  const write = kt.indexOf('markerFile(context).writeText');
  assert.ok(del > 0, '要先删标记');
  assert.ok(del < write, '删在写之前');
});

test('★★ Zip Slip 防护（canonicalPath 前缀校验）', () => {
  const kt = read('StUnpacker.kt');
  assert.match(kt, /canonicalPath/, '必须用 canonicalPath 校验');
  assert.match(kt, /startsWith\(canonicalRoot\)/, '必须校验前缀');
});
