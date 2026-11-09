/**
 * 第三批 · 问题四：真机自动化基建（2026-10-31）。
 *
 * ## 用户的要求里最要紧的一条
 *
 * 「**设备不在线时报告"设备缺席"而非假绿**」。
 *
 * 假绿是最坏的结果 —— 它让"没测"看起来像"测过了"，
 * 而真机测试的全部意义就是"真的在手机上验过"。
 * 所以这个脚本的退出码分三档，且**缺席必须是 3 而不是 0**：
 *
 *   0 = 全部 PASS
 *   3 = 设备缺席（没条件测）
 *   4 = 有 FAIL（测了但坏了）
 *
 * ## 这组测试怎么验一个 shell 脚本
 *
 * 分三层：
 *   ① 静态断言：退出码分支、`--pid` 过滤、cygpath 用法（读源码）
 *   ② 行为断言：真的跑一次"设备缺席"路径，读**退出码**
 *   ③ 登记断言：它进了 verify-inventory 且状态是 device-required
 *
 * 第 ② 层不能靠"跑一遍看输出"——必须读 `$?`。
 * 这个项目里 `$?` 被 `tail`/`echo` 吃掉过不止一次。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(REPO, 'scripts', 'verify-android-device.sh');
const src = () => readFileSync(SCRIPT, 'utf8');

/* ═══════════════════════════════════════════════════════════
   一、退出码语义：三档，缺席不许是 0
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题四：设备缺席的退出码必须是 3（不是 0、不是 1）', () => {
  /*
   * 0 会让"没测"看起来像"测过了"（假绿）；1 会与"脚本自身出错"混淆。
   * 3 是刻意选的：脚本能跑完、只是没条件测。
   */
  const text = src();
  const absentBranch = text.slice(text.indexOf('结论：设备缺席'), text.indexOf('结论：设备缺席') + 200);

  assert.match(absentBranch, /exit 3/, `设备缺席分支必须以 exit 3 结束，实际：${absentBranch}`);
});

test('★ 问题四：失败用 4，通过用 0（三档互不重叠）', () => {
  const text = src();
  assert.match(text, /exit 4/, '失败要有独立退出码 4');
  assert.match(text, /exit 0/, '全部通过才 exit 0');
  assert.match(text, /exit 3/, '缺席要 exit 3');
});

test('★★ 问题四：设备缺席分支的整体形状（不 spawn，改为语义断言）', () => {
  /*
   * ## 为什么这里不真的执行脚本
   *
   * 原本想 `spawnSync('bash', [SCRIPT])` 真跑一次、读 `$?`。实测不行：
   *
   *     spawnSync bash EBUSY
   *
   * 而且**换什么 shell 都一样**（试过 `bash` / `sh` / `dash` / `busybox`，
   * 甚至连 bash.exe 的绝对路径也 EBUSY）。这不是路径或 PATH 问题，
   * 是本环境对"node 子进程启动 POSIX shell"的限制（记忆 §4 / §61.3 那条
   * 「EBUSY 只在捕获输出时出现」的同类，只是范围更大）。
   *
   * 所以这一层改成**语义断言**：把"设备缺席"那段分支整段取出来，
   * 检查它满足三个条件。它比"读源码里有没有 exit 3 这个字符串"强，
   * 因为限定在**分支内部**且要求三件事同时成立。
   *
   * 真实执行的证据另存：`scripts/verify-android-device.sh` 的登记表里有
   * `evidence` 字段，记录 2026-10-31 实测 `ANDROID_SERIAL=FAKE` 返回 3。
   */
  const text = src();

  const start = text.indexOf('if [ "$STATE" != "device" ]');
  assert.ok(start > 0, '找不到"设备缺席"的判定分支');
  const branch = text.slice(start, text.indexOf('exit 3', start) + 10);

  // ① 判定条件：状态不是 device **或** 拿不到 serial
  assert.match(branch, /STATE" != "device"/, '要判 adb state');
  assert.match(branch, /-z "\$SERIAL"/, '也要判 serial 是否为空（state 可能是 "unknown"）');

  // ② 记录成 SKIP（不是 PASS、也不是 FAIL）
  assert.match(branch, /record "SKIP"/, '缺席要记成 SKIP，不许记 PASS（那就是假绿）');
  assert.doesNotMatch(branch, /record "PASS"/, '缺席分支里不许出现 PASS');

  // ③ 以 exit 3 结束
  assert.match(branch, /exit 3/, '缺席分支必须以 exit 3 结束');
});

/* ═══════════════════════════════════════════════════════════
   二、三层结构存在（设备 / 安装 / 运行）
   ═══════════════════════════════════════════════════════════ */

test('★ 问题四：三层检查都在（设备 / 安装 / 运行）', () => {
  /*
   * 分层是为了"上一层失败不拖累下一层的诊断"。
   * 少一层就会出现"装不上时说不出是没设备还是签名不对"。
   */
  const text = src();
  assert.match(text, /①设备/, '要有设备层');
  assert.match(text, /②安装/, '要有安装层');
  assert.match(text, /③运行/, '要有运行层');
});

test('★ 问题四：进程断言用 pidof（证明真的起来了）', () => {
  /*
   * `am start` 返回 `Starting:` 只证明**命令被接受**，
   * 不证明进程活着。闪退的包也会打印 Starting。
   */
  const text = src();
  assert.match(text, /pidof/, '要通过 pidof 确认进程存在');
  assert.match(text, /mResumedActivity/, '要看前台 Activity 是不是我们');
});

/* ═══════════════════════════════════════════════════════════
   三、logcat 断言必须按 pid 过滤（本轮踩到的误伤）
   ═══════════════════════════════════════════════════════════ */

test('★★ 问题四：崩溃断言必须按 pid 过滤，不许扫全系统 logcat', () => {
  /*
   * 2026-10-31 第一次跑就红了，那条 `UnsatisfiedLinkError` 来自
   * `com.miui.hybrid`（小米自带应用引擎），与本 APK 无关。
   *
   * 不过滤的话，手机上任何**别的** App 崩溃都会让这条判据变红 ——
   * 我们既不能修它，也不该因为它就说自己的包有问题。
   */
  const text = src();
  const i = text.indexOf('无致命异常');
  assert.ok(i > 0, '找不到崩溃断言段');

  // 崩溃断言段里必须出现 --pid
  const seg = text.slice(Math.max(0, i - 900), i + 200);
  assert.match(seg, /logcat\s+-d\s+--pid=/, `崩溃断言必须用 --pid 过滤，实际附近代码：\n${seg.slice(-400)}`);

  // 不许出现"扫整份 logcat 再 grep FATAL"的写法
  assert.doesNotMatch(
    text,
    /logcat -d \| grep -E "FATAL EXCEPTION/,
    '不许扫全系统 logcat（会误伤别的 App 的崩溃）',
  );
});

test('★ 问题四：crash buffer 只作现场留存，不参与判定', () => {
  /*
   * `logcat -b crash` 也是全系统的。它有价值（留现场），
   * 但拿它当判据就会误伤。
   */
  const text = src();
  assert.match(text, /crash buffer/, '要说明 crash buffer 的用途');
  assert.match(text, /不计入判定/, 'crash buffer 不参与判定');
});

/* ═══════════════════════════════════════════════════════════
   四、安装路径（cygpath，本轮踩到的第二个误伤）
   ═══════════════════════════════════════════════════════════ */

test('★ 问题四：install 要用 cygpath 转 Windows 路径', () => {
  /*
   * 2026-10-31 实测：`adb install -r /d/Claw/.../x.apk`（MSYS 风格绝对路径）
   * 报 `failed to stat /d/Claw/...` —— adb 把它当成**设备端**路径去找。
   * 症状是"包明明在，adb 说找不到"。
   */
  const text = src();
  assert.match(text, /cygpath -w/, 'install 前要把路径转成 Windows 形式');
});

test('★ 问题四：包名与 Activity 从 APK 读，不写死', () => {
  /*
   * 写死的话改名后 install 仍成功、am start 报"Activity 不存在"，
   * 用户看到的是"装好了但没起来"，容易归因成 APK 坏了。
   */
  const text = src();
  assert.match(text, /aapt2/, '要用 aapt2 读包名/入口');
  assert.match(text, /launchable-activity/, '要读 launchable-activity');
});

/* ═══════════════════════════════════════════════════════════
   五、登记进清单（用户要求"挂 verify-inventory 新类目"）
   ═══════════════════════════════════════════════════════════ */

test('★ 问题四：登记进 verify-inventory，状态是 device-required', async () => {
  /*
   * 用户要求"挂 verify-inventory 新类目「真机自动化」，登记进 npm test 链"。
   *
   * 类目复用了已有的 `device-required`（2026-10-30 为 Spike 复验加的那个）
   * 而不是再造一个 `device-automation` —— 两个名字意思相同，
   * 并存只会让"这条脚本我现在能不能跑"变得要查两处。
   *
   * "登记进 npm test 链"的落点：本文件本身在 `test/*.test.mjs` 里，
   * `npm test` 跑全部 `test/*.test.mjs`，所以它已经在链上了。
   */
  const { VERIFY_INVENTORY, VERIFY_STATUSES } = await import('../scripts/lib/verify-inventory.mjs');

  const entry = VERIFY_INVENTORY.find((item) => item.file === 'scripts/verify-android-device.sh');
  assert.ok(entry, '必须登记 scripts/verify-android-device.sh');
  assert.equal(entry.status, 'device-required', '状态必须是 device-required');
  assert.ok(VERIFY_STATUSES.has(entry.status), '状态值必须合法');
  assert.ok(entry.why.length > 30, 'why 要写清为什么需要真机');
  assert.ok(entry.evidence.length > 30, 'evidence 要写清什么时候跑过、结论是什么');
});

/* ═══════════════════════════════════════════════════════════
   六、聊天类用例未就绪时必须 SKIP
   ═══════════════════════════════════════════════════════════ */

test('★ 问题四：脚本里写明"聊天类用例依赖 T15.3，未就绪应 SKIP"', () => {
  /*
   * 用户明确要求「聊天类自动化用例依赖 T15.3（ST 起不来则跳过并注明，不许红）」。
   * 本版只打通最小链路，聊天类还没写；但**约定必须先落下来**，
   * 否则下一个人接着写时会把"ST 没起来"当成 FAIL。
   */
  const text = src();
  assert.match(text, /T15\.3/, '要写明依赖 T15.3');
  assert.match(text, /SKIP 而不是 FAIL/, '要写明未就绪时 SKIP');
});

test('★ 问题四：脚本明确不做自动构建与自动修复', () => {
  /*
   * 两个刻意的边界：
   *   · 不自动构建 —— 17 分钟，会让"只想验一下当前包"变成"必须等构建"；
   *   · 不自动修复 —— 重启 adb / 重装 / 清数据会掩盖真实原因，
   *     而"真机偶发"最需要保留现场。
   */
  const text = src();
  assert.match(text, /不自动构建/, '要写明不自动构建');
  assert.match(text, /不自动修复/, '要写明不自动修复');
});
