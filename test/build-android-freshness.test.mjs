/**
 * `scripts/build-android.sh` 里"前端产物是否过期"那段判据的自检。
 *
 * ## 这条判据为什么要有
 *
 * Tauri 2 在 Android 把 `client/dist` 嵌进 `.so`。**改了源码忘了
 * `npm run build:ui`，就会打出一个界面还是上一版的 APK** ——
 * 而且构建全绿、装上能跑、只是"改了没生效"（最费时间的一类问题）。
 *
 * 2026-10-31 实测过一次：`dist` 12:14、`chat.css`/`shell.ts` 12:18，差 4 分钟。
 *
 * ## 这个文件本身纠正了我一个错误判断
 *
 * 加这条守卫时我写了一段 `-prune src-tauri`，理由写得很肯定：
 * "`client/src-tauri` 就在 `client/src` 下面，里面有 gen/ 与 target/，
 * mtime 永远更新 ⇒ 判据恒真"。
 *
 * **那是错的。** `client/src-tauri` 与 `client/src` 是**同级目录**。
 * 我把一次手动 `npm run build:ui` 的输出误当成了脚本输出，于是"推理"出一个
 * 不存在的缺陷，还给它配了一段很长的解释。
 *
 * 是下面的反证用例逼出来的：它要求"不跳过时确实会命中 src-tauri 里的产物"，
 * 而实测命中数是 **0** —— 因为那棵树里根本没有 src-tauri。
 *
 * 所以这里保留一条 `★ 目录关系` 的事实断言。它防的不是代码变化，
 * 而是**下一个人（或我）再一次凭印象推断目录结构**。
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, 'scripts', 'build-android.sh');

const src = () => readFileSync(SCRIPT, 'utf8');

/** dist 里最新的入口页 mtime（与脚本里的基准一致）；不存在返回 null */
function distBaseMtime() {
  for (const name of ['index.html', 'mobile.html']) {
    try {
      return statSync(join(REPO, 'client', 'dist', name)).mtimeMs;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

/**
 * 与脚本里那条 `find ... -newer` 等价的最小实现。
 *
 * ## 为什么不 spawn 真的 `find`
 *
 * Windows 上从 node 里 `execFileSync('find' | 'bash', ...)` 会报
 * **`EBUSY`** —— 记忆 §4 那条「EBUSY 只在捕获输出时出现」。
 * `bash.exe` 与 `find.exe` 两条路都试过，都炸。
 *
 * 所以用 fs 复刻判据语义，测"该不该报过期"这个意图；
 * shell 语法那一层由上面的正则守卫覆盖。
 */
function findNewer(rootAbs, baseMtimeMs) {
  const hits = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        if (statSync(abs).mtimeMs > baseMtimeMs) hits.push(abs);
      } catch {
        /* 读不到就跳过（与 find 的 2>/dev/null 一致） */
      }
    }
  };
  walk(rootAbs);
  return hits;
}

test('★ 构建前的"产物过期"检查必须存在，且在 ⑧b 之前', () => {
  /*
   * 位置有讲究：脚本第 ⑧b 步也检查 `.so` 内嵌前端，但那是在
   * `tauri android build` **之后** —— 判出过期就得重跑一遍完整构建
   * （release 17 分钟）。构建前先查一次，代价只有 3 秒。
   */
  const text = src();
  assert.match(text, /前端产物比/, '构建脚本要能自己发现"改了源码没 build:ui"');
  assert.match(text, /npm run build:ui/, '发现过期后要自动重建前端');

  /*
   * 只断言"有这么一段检查、且排在 tauri build 之前"，
   * **不钉文案**：第一版写死 `'前端产物比源码旧'`，我把它改成
   * "比输入旧"（因为现在比的是 shared/dist 这个产物）就误红了。
   */
  const iCheck = text.indexOf('[修] 前端产物比');
  const iBuild = text.indexOf('node "$TAURI_CLI" android build');
  assert.ok(iCheck > 0 && iBuild > 0, '找不到检查段或构建段');
  assert.ok(iCheck < iBuild, '过期检查必须在 tauri build 之前');
});

test('★ find 的基准必须取自 dist，且方向是"源码比产物新"', () => {
  /*
   * `-newer "$NEWEST_DIST"` 的含义是"比基准更新"。
   * 基准是 **dist 里的产物** ⇒ 命中 = 源码更新 = 需要重建。
   * 写反（拿源码当基准）会变成相反行为，而且两种都能跑、都不报错。
   */
  const text = src();
  assert.match(text, /-newer "\$NEWEST_DIST"/, '-newer 后面必须跟 dist 产物当基准');

  const i = text.indexOf('NEWEST_DIST=$(');
  assert.ok(i > 0, '找不到 NEWEST_DIST 的赋值');
  const seg = text.slice(i, i + 200);
  assert.match(seg, /dist\/index\.html|dist\/mobile\.html/, `基准要从 dist 取，实际：${seg}`);
});

test('★ 目录关系：src-tauri 与 src 同级，不在 src 里面', () => {
  /*
   * 这条是事实断言，不是假设 —— 2026-10-31 我凭印象以为在下面，
   * 加了一段 `-prune` 并写了一长段"为什么必须排除"。
   * 一个不存在的缺陷，被描述得比真缺陷还详细。
   *
   * 如果哪天目录真的变成 `client/src/src-tauri`，这条会红，
   * 那时才需要去 `build-android.sh` 里加 prune。
   */
  assert.ok(existsSync(join(REPO, 'client', 'src')), 'client/src 必须存在');
  assert.ok(existsSync(join(REPO, 'client', 'src-tauri')), 'client/src-tauri 必须存在');
  assert.equal(
    existsSync(join(REPO, 'client', 'src', 'src-tauri')),
    false,
    'client/src/src-tauri 不该存在。若它出现了，build-android.sh 的清单检查需要排除它',
  );
});

test('★ 判据行为：dist 最新时，client/src 下零命中', () => {
  /*
   * 判据不能只看源码文本。这里按同样语义真的走一遍树。
   * dist 是最新的时候不该有命中，否则每次构建都白跑一次 build:ui。
   */
  const base = distBaseMtime();
  if (base === null) {
    console.log('  [skip] client/dist 不存在，跳过（skip 不是 pass）');
    return;
  }

  const hits = findNewer(join(REPO, 'client', 'src'), base).map((one) =>
    one.slice(REPO.length + 1),
  );

  assert.equal(
    hits.length,
    0,
    `dist 是最新的，不该有源码比它更新（否则每次构建都白跑一次 build:ui）。实际：\n${hits.join('\n')}`,
  );
});

test('★ 反证：源码真的比 dist 新时，判据必须命中', () => {
  /*
   * 一个恒定"零命中"的判据也可能是**根本没在测东西**。
   * 这条把基准调到很早（epoch），必然全部命中 —— 证明上面那条的
   * "零命中"是树真的干净，而不是遍历函数什么也没扫到。
   */
  const files = findNewer(join(REPO, 'client', 'src'), 0);
  assert.ok(
    files.length > 5,
    `基准设成 epoch 时应当命中大量源码文件（否则遍历本身坏了）。实际命中：${files.length}`,
  );
});

/* ═══════════════════════════════════════════════════════════
   守卫的**覆盖面**：只盯 client/src 是不够的（2026-11-03）
   ═══════════════════════════════════════════════════════════ */

test('★ 守卫必须分两段查：shared/src→shared/dist，然后 shared/dist→client/dist', () => {
  /*
   * ## 怎么发现漏了一棵树
   *
   * 改了 `shared/src/chat/settings-schema.ts` 里 `CHAT_SETTINGS_GROUPS`
   * 的顺序（用户要求「与 ST 原生一致」），构建全绿、装上能跑，
   * 但真机上分组顺序**还是旧的**。
   *
   * ## 第一版修法不够，而且"瞎得很快"
   *
   * 第一版只是把 `shared/src` 加进 B 段的 find 列表。看着合理，实则：
   * `client/dist` 一旦被重建过一次（**哪怕内容还是错的**），它的 mtime
   * 就比 `shared/src` 新 ⇒ B 段判"没问题" ⇒ `shared/dist` 依旧陈旧 ⇒
   * 包里还是旧界面。
   *
   * 实测就撞上了：连打两个包，**sha256 一模一样**（`196e3480…`），
   * 因为两次都从同一份 01:49 的 shared/dist 编，而 shared/src 是 02:23。
   *
   * ## 判据（钉语义，不钉某一行字符串）
   *
   * 两级缓存必须各查一次，且每段只跟自己那一级的输入比：
   *   A 段：基准来自 `shared/dist`，找 `shared/src` 里比它新的
   *   B 段：基准来自 `client/dist`，找 `client/src` 与 **`shared/dist`** 里比它新的
   *
   * 这样 A 段重编会刷新 shared/dist 的 mtime，B 段紧接着必然被触发，链条自接。
   */
  const src = readFileSync(join(REPO, 'scripts', 'build-android.sh'), 'utf8');

  /* A 段：show 一个从 shared/dist 取的基准 */
  assert.ok(
    /NEWEST_SHARED_DIST=.*shared\/dist/s.test(src),
    'A 段的基准必须取自 shared/dist（拿它当"shared 产物有多新"的尺子）',
  );
  assert.ok(
    /find\s+"\$REPO\/shared\/src"[^\n]*-newer\s+"\$NEWEST_SHARED_DIST"/.test(src),
    'A 段要拿 shared/src 去比 shared/dist 的基准',
  );

  /* B 段：输入里必须是 shared/**dist**，不能是 src */
  const findAt = src.indexOf('NEWER=$(find');
  assert.ok(findAt >= 0, '找不到 B 段的 NEWER=$(find ...)');
  const bLine = src.slice(findAt, src.indexOf('\n', findAt));
  assert.ok(
    bLine.includes('$REPO/shared/dist'),
    `B 段的输入必须含 shared/dist（vite 打进去的是产物，不是源码）。实际：${bLine.trim()}`,
  );
  assert.ok(
    !bLine.includes('$REPO/shared/src'),
    `B 段不该直接比 shared/src —— 那是 A 段的事，混在一起会让"client/dist 重建过一次"就永久失效。实际：${bLine.trim()}`,
  );

  /*
   * 顺序只在 **A 段起点 → B 段起点 → 之后** 这个范围内比。
   *
   * 拿全文件 `indexOf` 会命中前面 `if [ ! -d client/dist ]` 分支里的
   * `build:ui`（它排在第 148 行，比 A 段的 `build:shared` 还早），
   * 于是判成"顺序反了"。第一版就是这么误红的 —— 第二次踩同一个坑。
   */
  const aAt = src.indexOf('NEWEST_SHARED_DIST=');
  const bAt = src.indexOf('NEWER=$(find');
  assert.ok(aAt > 0, '找不到 A 段（shared/dist 基准）');
  assert.ok(bAt > aAt, 'A 段必须在 B 段之前');

  const aSeg = src.slice(aAt, bAt);
  const bSeg = src.slice(bAt);
  assert.ok(aSeg.includes('npm run build:shared'), 'A 段（shared 过期）要跑 build:shared');
  assert.ok(bSeg.includes('npm run build:ui'), 'B 段（client 过期）要跑 build:ui');
});
