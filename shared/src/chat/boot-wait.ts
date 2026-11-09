/**
 * 开屏等待（v0.1.7 / 第九批）。
 *
 * ## 为什么需要它
 *
 * 冷启动时内置 ST 引擎要 7–57 秒才起来。那段时间界面上是**空聊天页**
 * —— 用户看到"未选择聊天 / 还没有对话"，以为记录丢了（真实反馈）。
 *
 * 而"等一会儿刷新一下就好了"不是能指望的用户行为。所以：
 * **先把这段等待显式化**（进度条 + 一句话），等引擎真的稳定了再进主界面。
 *
 * ## 为什么不用假动画
 *
 * 常见做法是"进度条按固定速度走 3 秒然后跳转"。这里不做，因为：
 *
 * · 引擎慢的时候（57 秒）假进度条会先跑完再干等 ⇒ 用户以为卡死
 * · 引擎快的时候（7 秒）进度条还没走完就跳 ⇒ 一闪而过，更像故障
 *
 * 所以进度**由真实阶段驱动**：解包 → 启动 → 就绪。阶段之间用
 * 平滑插值填补，但**不会越过实际阶段**。
 *
 * ## 为什么"拿不到状态"不算失败
 *
 * `__ST_ENGINE__` 这个 JS 桥只有 Android 有。浏览器预览 / 桌面端没有，
 * 那些环境里 ST 是用户自己在外面起的 —— 此时**应该直接进主界面**，
 * 不能卡在开屏。所以 `readStatus()` 返回 null 时立刻放行。
 */

/** 开屏阶段（文案与进度都由它决定） */
export type BootPhase = 'unpacking' | 'starting' | 'connecting' | 'ready' | 'failed';

/** 一次状态采样 */
export interface BootProbe {
  /** 引擎进程是否活着 */
  running: boolean;
  /** 端口上有没有认得的 ST 在应答 */
  ready: boolean;
  /** ST 数据是否已解包 */
  unpacked: boolean;
  /** 最近一次失败原因 */
  error: string | null;
}

/** 阶段 → 给用户看的一句话 */
export function describeBootPhase(phase: BootPhase): string {
  switch (phase) {
    case 'unpacking':
      return '正在铺开世界的底稿…';
    case 'starting':
      return '正在点亮点灯人…';
    case 'connecting':
      return '正在接通那个世界…';
    case 'ready':
      return '世界已就绪';
    case 'failed':
      return '世界没能打开';
  }
}

/** 阶段 → 进度条百分比（0–100） */
export function phasePercent(phase: BootPhase): number {
  switch (phase) {
    case 'unpacking':
      return 25;
    case 'starting':
      return 55;
    case 'connecting':
      return 82;
    case 'ready':
      return 100;
    // 失败时不给 100：进度条停在 100 会让"失败"看起来像"完成了"
    case 'failed':
      return 0;
  }
}

/**
 * 从一次采样推断当前阶段。
 *
 * 判据顺序**重要**：先判"成功"再判"进度"，否则就绪状态下
 * `unpacked` 也是 true，会被判成"还在解包"。
 */
export function phaseOf(probe: BootProbe | null): BootPhase {
  if (probe === null) return 'ready'; // 拿不到桥 ⇒ 不是 Android，直接放行
  if (probe.ready) return 'ready';
  if (!probe.unpacked) return 'unpacking';
  if (probe.running) return 'connecting';
  return 'starting';
}

/** 等待策略 */
export interface WaitOptions {
  /** 轮询间隔（毫秒） */
  intervalMs: number;
  /**
   * 总时限（毫秒）。
   *
   * 真机首启最慢实测 57 秒，给到 90 秒留余量。
   * 超过之后**不能一直卡着** —— 要有出口，否则用户只能杀进程。
   */
  timeoutMs: number;
  /** 每次阶段变化时回调（用于更新文案与进度） */
  onPhase?: (phase: BootPhase, probe: BootProbe | null) => void;
  /** 采样函数；返回 null 表示"这个平台没有引擎桥" */
  probe: () => BootProbe | null;
}

/** 等待结果 */
export interface WaitResult {
  /** 是否可以进主界面 */
  ok: boolean;
  /** 停在哪个阶段 */
  phase: BootPhase;
  /** 等了多久 */
  elapsedMs: number;
  /** 失败时的原因（超时 / 引擎报了错） */
  reason: string | null;
}

/**
 * 等引擎稳定。
 *
 * ## 三个出口，一个都不能少
 *
 * 1. **就绪** → `ok: true`，进主界面
 * 2. **超时** → `ok: false`，但**仍然进主界面**（由调用方决定），
 *    因为"卡在开屏"比"进去看到空列表"更糟：后者至少能手动选角色重试。
 * 3. **引擎明确失败**（进程死了且报错）→ 提前结束，不空等满 90 秒。
 *
 * 第 3 条是实测驱动的：引擎起不来时（比如 MuMu 上那个 houdini 缺陷），
 * 等满 90 秒纯属浪费，用户盯着进度条不动会更焦虑。
 */
export async function waitForEngine(options: WaitOptions): Promise<WaitResult> {
  const started = Date.now();
  let lastPhase: BootPhase | null = null;

  for (;;) {
    const probe = options.probe();
    const phase = phaseOf(probe);

    if (phase !== lastPhase) {
      lastPhase = phase;
      options.onPhase?.(phase, probe);
    }

    if (phase === 'ready') {
      return { ok: true, phase, elapsedMs: Date.now() - started, reason: null };
    }

    /*
     * 引擎进程已死 **且** 报了错 ⇒ 提前收工。
     *
     * 只判 `running === false` 不够：启动最初的一瞬间进程还没 spawn 出来，
     * 那也是 false。必须有 `error` 才算"明确失败"。
     */
    if (probe !== null && probe.running === false && probe.error !== null) {
      return {
        ok: false,
        phase: 'failed',
        elapsedMs: Date.now() - started,
        reason: probe.error,
      };
    }

    if (Date.now() - started >= options.timeoutMs) {
      return {
        ok: false,
        phase,
        elapsedMs: Date.now() - started,
        reason: '等待超时',
      };
    }

    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
