/**
 * 录音器：**权限失败与初始化失败必须分开报**（v0.1.7 / 第七批问题二）。
 *
 * ## 为什么这组测试以前不存在
 *
 * `createRecorder` 在此前**零测试**（`grep -rn createRecorder test/` 无结果）。
 * 于是"权限被拒"这条文案从来没被验证过 —— 而它正是用户看到的那句话。
 *
 * 真机现场（2026-11-01，截图 10:13）：
 * 系统权限页写着「使用应用时允许」，按麦克风却弹「麦克风权限被拒绝」。
 * 用户按提示去系统设置里看，权限**本来就是允许的** —— 他被指到了一个
 * 已经做对的地方，然后永远修不好。
 *
 * ## 这组测试守什么
 *
 * 不是"文案好不好听"，而是**三类失败不许混成一个**：
 *
 * | 真实原因 | 用户该做什么 | 判据 |
 * |---|---|---|
 * | 宿主拒绝了请求 | 先看系统权限；已允许则是 App 的问题 | 文案要点出"已允许时该反馈" |
 * | 设备被别的应用占用 | 关掉那个应用 | 文案不许提"权限" |
 * | 编码器不支持 | 换设备 | 文案要点明"已授权" |
 *
 * 第三类是这次新加的：原来 `new MediaRecorder(...)` 抛的异常会**原样**冒到
 * UI 的「打不开麦克风：」后面，用户看到 `NotSupportedError` 会以为是权限。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRecorder } from '../client/src/chat/recorder.ts';

/* ── 假的浏览器环境 ── */

/**
 * 装一套假 globals。
 *
 * `globalThis.navigator` 在 Node 22 上是**只读 getter**，不能直接赋值，
 * 所以用 `defineProperty` 覆盖，并在 finally 里还原 —— 不还原会污染
 * 同一进程里后面的测试（node --test 同文件内共享全局）。
 */
function withGlobals(overrides, run) {
  const saved = new Map();
  const set = (name, value) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };

  try {
    for (const [name, value] of Object.entries(overrides)) set(name, value);
    return run();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
  }
}

/** 一个最小可用的假 MediaRecorder（构造不抛，start 后能 stop） */
class FakeRecorder {
  constructor() {
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

/** 一个最小可用的假 AudioContext */
class FakeAudioContext {
  constructor() {
    this.state = 'running';
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return { fftSize: 1024, frequencyBinCount: 512, getByteTimeDomainData() {} };
  }
  async close() {}
  async resume() {}
}

/** 造一个 getUserMedia，按给定方式失败或成功 */
function getUserMediaFailing(name) {
  return function fail() {
    const error = new Error('Permission denied');
    error.name = name;
    return Promise.reject(error);
  };
}

function getUserMediaOk() {
  return function ok() {
    return Promise.resolve({
      getTracks: () => [{ stop() {} }],
      getAudioTracks: () => [{ label: 'fake mic', enabled: true, state: 'live' }],
    });
  };
}

/* ═══════════════════════════════════════════════════════════
   ① 三类失败必须分开
   ═══════════════════════════════════════════════════════════ */

test('★★ NotAllowedError：文案要承认"系统可能已经允许了"（真机就是这种）', async () => {
  /*
   * 真机：`dumpsys` 显示 `RECORD_AUDIO: granted=true`，
   * 页面也确认 `isSecureContext === true`，而 getUserMedia 依旧
   * 返回 `NotAllowedError: Permission denied`。
   *
   * 原因在宿主程序（WebView 的 onPermissionRequest 被 deny），
   * 不在系统权限上。原来那句「麦克风权限被拒绝。到系统设置里允许「录音」后重试。」
   * 把用户指向了一个**他已经做对**的地方。
   */
  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaFailing('NotAllowedError') } },
      MediaRecorder: FakeRecorder,
      AudioContext: FakeAudioContext,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /没有被允许/, '要说清"我被拒绝了"');
          assert.match(
            error.message,
            /已经允许|已允许/,
            '要覆盖"系统已经允许了但 App 还判拒绝"这种情况 —— 否则用户会反复检查权限页',
          );
          assert.doesNotMatch(
            error.message,
            /^麦克风权限被拒绝。到系统设置里允许「录音」后重试。$/,
            '不许再一口咬定"去系统设置里允许"',
          );
          return true;
        },
      );
    },
  );
});

test('★ NotReadableError（设备被占用）：文案不许提"权限"', async () => {
  /*
   * 通话中、录音机开着、别的语音助手占着麦克风，都会给 NotReadableError。
   * 这时权限完全没问题。文案提"权限"会让用户白折腾一轮。
   */
  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaFailing('NotReadableError') } },
      MediaRecorder: FakeRecorder,
      AudioContext: FakeAudioContext,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /占用/);
          assert.doesNotMatch(error.message, /权限/, '这不是权限问题，不许往权限上引');
          return true;
        },
      );
    },
  );
});

test('★ NotFoundError：说"这台设备没有麦克风"，不是"权限被拒"', async () => {
  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaFailing('NotFoundError') } },
      MediaRecorder: FakeRecorder,
      AudioContext: FakeAudioContext,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /没有可用的麦克风/);
          assert.doesNotMatch(error.message, /权限/);
          return true;
        },
      );
    },
  );
});

/* ═══════════════════════════════════════════════════════════
   ② 初始化失败不许冒充权限失败
   ═══════════════════════════════════════════════════════════ */

test('★★ 权限过了但 AudioContext 构造失败 → 说"已授权，音频处理初始化失败"', async () => {
  /*
   * 这条是这次新加的分支。原来 `new Ctx()` 抛出的异常会原样冒到 UI，
   * 位置在「打不开麦克风：」后面 —— 用户看到 `NotSupportedError`
   * 会以为是权限问题，去改系统设置，越改越乱。
   */
  function BrokenContext() {
    throw new Error('AudioContext 不可用');
  }

  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaOk() } },
      MediaRecorder: FakeRecorder,
      AudioContext: BrokenContext,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /已授权/, '要明确告诉用户"权限这关过了"');
          assert.match(error.message, /初始化失败/);
          assert.doesNotMatch(error.message, /权限被拒/, '不许把初始化失败报成权限被拒');
          return true;
        },
      );
    },
  );
});

test('★ 权限与音频上下文都过了、但编码器构造失败 → 说"编码器不可用"', async () => {
  function BrokenRecorder() {
    throw new Error('no encoder');
  }

  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaOk() } },
      MediaRecorder: BrokenRecorder,
      AudioContext: FakeAudioContext,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /已授权/);
          assert.match(error.message, /编码器/);
          assert.doesNotMatch(error.message, /权限被拒/);
          return true;
        },
      );
    },
  );
});

/* ═══════════════════════════════════════════════════════════
   ③ 正常路径没被改坏
   ═══════════════════════════════════════════════════════════ */

test('正常路径：能拿到 amplitude，stop 后返回 Blob', async () => {
  await withGlobals(
    {
      navigator: { mediaDevices: { getUserMedia: getUserMediaOk() } },
      MediaRecorder: FakeRecorder,
      AudioContext: FakeAudioContext,
    },
    async () => {
      const recorder = createRecorder();
      const active = await recorder.start();

      assert.equal(typeof active.amplitude(), 'number', 'amplitude 要给一个数');
      const blob = await active.stop();
      assert.ok(blob instanceof Blob, 'stop 要给 Blob');
    },
  );
});

test('环境缺 getUserMedia / MediaRecorder 时给"这个环境…"，不是权限话术', async () => {
  await withGlobals(
    {
      navigator: {},
      MediaRecorder: undefined,
      AudioContext: undefined,
    },
    async () => {
      const recorder = createRecorder();
      await assert.rejects(
        () => recorder.start(),
        (error) => {
          assert.match(error.message, /这个环境/);
          assert.doesNotMatch(error.message, /权限/);
          return true;
        },
      );
    },
  );
});
