/**
 * ST 引擎生命周期判据（v0.1.7 / T15.3）—— 纯逻辑层。
 *
 * ## 为什么这些判断要抽成纯逻辑
 *
 * T15.3 主体是 Android 原生代码（Java + Gradle），**没法在 Node 里跑**。
 * 但它里面的关键判断都能抽出来，而抽出来的理由很实在：
 *
 * | 判断 | 写错的后果 | 能不能只靠真机发现 |
 * |---|---|---|
 * | 端口探活超时该多长 | 太短 → 误判"没起来"反复重启；太长 → 白屏几十秒 | 慢，且要复现特定场景 |
 * | 孤儿进程该不该杀 | 误杀 → 用户正在聊的会话断掉 | 难（要构造孤儿态） |
 * | 解包进度到几成 | 进度条卡住/跳变 | 要真的解 437MB |
 * | 前台服务该不该重启 | START_STICKY 反复拉起 → 耗电 | 要等系统杀进程 |
 *
 * 所以这四件事都在这里做纯函数 + 单测，Android 侧只负责"调它、照它做"。
 *
 * ## 一条刻意的设计：判据返回**原因**而不只布尔值
 *
 * `shouldKillOrphan` 返回 `{ kill: boolean, reason: string }` 而不是 `boolean`。
 * 理由是杀进程是**不可逆**操作：写了日志才知道"当时为什么杀"。
 * 只返回 true/false 的话，事后排查只能猜。
 */

/* ═══════════════════════════════════════════════════════════
   一、端口探活
   ═══════════════════════════════════════════════════════════ */

/**
 * 探活参数。
 *
 * 数值来自 spike 实测（决策 #291）：冷启动到 8000 监听约 **8–14 秒**
 * （437MB 解包之后、node 加载 ST 的时间）。这里给到 30 秒上限，
 * 是给低端机与冷缓存留余量 —— Redmi Note 8 Pro 上实测启动明显更慢。
 */
export const PROBE_INTERVAL_MS = 500;

/**
 * 探活上限。
 *
 * ## ★★★ 2026-11-09 从 30 秒改成 120 秒（用户真机报"世界没能打开"）
 *
 * 原来的模型是：
 *
 * ```text
 *   热启动（已有数据）  → 30 秒够（实测 7 秒）
 *   首次安装（数据空）  → 120 秒（FIRST_RUN_PROBE_TIMEOUT_MS）
 * ```
 *
 * 这个模型漏了第三种情况：**升级安装**。
 *
 * 用户从 0.1.8 覆盖装 0.1.8 补丁版后启动，30 秒报"引擎启动超时"，
 * 而几分钟后从 adb 直连 8000 拿到 `HTTP 200 / 0.08s`，ST 1.19.0 跑得好好的。
 * 也就是说**引擎起来了，只是比 30 秒慢**。
 *
 * 为什么升级后也慢：
 *
 * ```text
 *   ① 用户数据变多（导入的卡、聊天记录、世界书都要扫）
 *   ② 升级后 V8 code cache 失效，node 重新编译
 *   ③ 装载条数与扫描耗时随使用时间单调增长
 * ```
 *
 * 第 ③ 条是关键：**启动耗时不是常数，它随用户数据增长**。
 * 拿一个固定 30 秒去卡一个会增长的量，迟早不够 —— 而且失败的表现是
 * "引擎起不来"，把用户和排查的人都引向完全错误的方向。
 *
 * 所以现在统一成 120 秒：那是首次启动的实测上限（30~90 秒）留一倍余量，
 * 也是唯一被验证过"一定够"的数。慢一点点可接受，
 * **"起来了却报失败"不可接受**。
 */
export const PROBE_TIMEOUT_MS = 120_000;

/**
 * **首次启动**的探活上限（2026-10-31 第四批加）。
 *
 * ## 为什么 30 秒不够
 *
 * 真机实测（Redmi Note 8 Pro / Android 11）：
 *   · 数据目录**已存在**时，起 ST 到监听 8000 用了 **7 秒**；
 *   · **首次**启动（`st-data` 是空的，ST 要创建默认数据、初始化索引）
 *     用了 **超过 30 秒** —— 实测第一次 30 秒超时报"启动失败"，
 *     而过了几十秒后端口其实是 LISTEN 的。
 *
 * 也就是说 30 秒这个数**只对热启动成立**。设计文档里写的
 * "冷启动 8–14 秒"是在已有数据目录的前提下量的 —— 那个前提没写清，
 * 于是"首次启动被判超时"看起来像"引擎起不来"。
 *
 * 给到 120 秒：首次初始化的实测值在 30–90 秒之间，
 * 留一倍余量。用户看到的是通知里的进度文案，不会干等无反馈。
 */
export const FIRST_RUN_PROBE_TIMEOUT_MS = 120_000;

export type ProbeOutcome = 'listening' | 'timeout' | 'aborted';

/**
 * 该不该继续等。
 *
 * 用"已等时长"与"是否被取消"两个输入，而不是内部计时 ——
 * 这样测试不必真等 30 秒。
 */
export function shouldKeepProbing(
  elapsedMs: number,
  aborted = false,
  firstRun = false,
): boolean {
  if (aborted) return false;
  return elapsedMs < (firstRun ? FIRST_RUN_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
}

/** 把探活结果翻译成给用户看的一句话 */
export function describeProbe(outcome: ProbeOutcome, elapsedMs: number): string {
  switch (outcome) {
    case 'listening':
      return `引擎已就绪（用了 ${Math.round(elapsedMs / 1000)} 秒）`;
    case 'timeout':
      /*
       * 超时的文案必须能指导下一步。
       *
       * 「引擎启动超时」是没用的 —— 用户不知道是等、是重启、还是去查什么。
       * 这里给三个具体动作，按概率排序：多数是"再等等就好了"（首次解包慢）。
       */
      return '引擎启动超过 30 秒还没就绪。首次启动要解压，可能需要更久 —— 再等一会儿，或到「我的 → 高级功能」里看启动日志。';
    case 'aborted':
      return '已取消启动';
  }
}

/* ═══════════════════════════════════════════════════════════
   二、孤儿进程清理（双判据）
   ═══════════════════════════════════════════════════════════ */

export interface OrphanProbe {
  /** 进程在当前 App 的进程列表里吗（`Process.myPid()` 之外还能看到的 libnode） */
  hasProcess: boolean;
  /** 8000 端口有人监听吗 */
  hasListener: boolean;
  /** 前台服务是否在运行 */
  serviceRunning: boolean;
}

export interface OrphanVerdict {
  kill: boolean;
  reason: string;
}

/**
 * 孤儿判定（**双判据**：进程 + 端口）。
 *
 * ## 为什么必须两个判据一起看
 *
 * 单看进程：
 *   · `ps` 里可能残留**上一次**的记录（Android 的 ps 输出在容器化后有延迟）；
 *   · 而且看不到"它到底在不在服务"—— 进程僵着但端口已关，杀了也无害。
 *
 * 单看端口：
 *   · 端口被别的进程占着（用户装了别的 8000 服务）会被误判成"我们的 ST"，
 *     然后我们去杀一个不属于自己的进程 —— **这是最坏的错**。
 *
 * 两个都对上才杀；只有一个对上就**只记日志不杀**，理由写进 reason。
 *
 * 第三个输入 `serviceRunning`：服务还在跑说明这是**正常实例**，不是孤儿。
 */
export function shouldKillOrphan(probe: OrphanProbe): OrphanVerdict {
  /*
   * 前置：服务在跑 → 什么都不做。
   *
   * 这条必须先判。否则每次 App 回到前台都会"发现进程存在 → 杀掉 → 重启"，
   * 用户正在聊的会话就断一次。
   */
  if (probe.serviceRunning) {
    return { kill: false, reason: '前台服务在运行，这是正常实例' };
  }

  if (probe.hasProcess && probe.hasListener) {
    return {
      kill: true,
      reason: '有 libnode 进程且 8000 在监听，但服务没在跑 —— 判定为上次残留的孤儿',
    };
  }

  if (probe.hasProcess && !probe.hasListener) {
    /*
     * 进程在、端口不在：可能是启动到一半就卡住了，也可能是僵死。
     *
     * 不杀的理由：这类进程**自己会退出**（node 启动失败会 exit），
     * 而我们杀它要冒"其实它正在启动中"的风险。等下一轮再看。
     */
    return { kill: false, reason: '有进程但端口未监听，可能是启动中；本轮不动，等下一轮' };
  }

  if (!probe.hasProcess && probe.hasListener) {
    /*
     * ★ 最危险的一种：端口被占但不是我们的进程。
     *
     * 绝不能杀 —— 那可能是用户自己装的其它服务。只能报错让用户处理。
     */
    return {
      kill: false,
      reason: '8000 被其它程序占用（不是我们的引擎）。请关掉占用它的程序，或在设置里换端口',
    };
  }

  return { kill: false, reason: '既没有 libnode 进程、8000 也没被占 —— 上次已干净退出，不需要清理' };
}

/* ═══════════════════════════════════════════════════════════
   三、首启解包进度
   ═══════════════════════════════════════════════════════════ */

/** spike 实测的 ST 解包后体积（437 MB）。给进度计算当分母 */
export const ST_UNPACKED_BYTES = 437 * 1024 * 1024;

/**
 * 解包进度（0..1）。
 *
 * ## 为什么不用"已解包文件数 / 总文件数"
 *
 * 数文件要遍历 449 个包目录、几万个小文件，遍历本身比解包还慢；
 * 而且**边解边数**会得到跳变的比例（大文件先解完，比例一下从 5% 跳到 60%）。
 *
 * 用**已写字节 / 预估总字节**：单调、平滑、成本低（解包 API 本来就返回当前条目大小）。
 *
 * 分母是"预估"而不是精确值 —— 所以允许超过 1（那说明实际比预估大，
 * 夹到 0.99 让进度条不要卡在 100% 却还在解）。
 */
export function unpackProgress(writtenBytes: number): number {
  if (writtenBytes <= 0) return 0;
  const ratio = writtenBytes / ST_UNPACKED_BYTES;
  if (ratio >= 1) return 0.99; // 见上：不许显示 100% 而实际还在解
  return ratio;
}

/** 进度文案。第一次启动的解包是唯一一处会让人等 10 秒以上的地方，要说清在做什么 */
export function describeUnpack(progress: number): string {
  if (progress <= 0) return '正在准备引擎…';
  if (progress < 0.99) {
    const percent = Math.max(1, Math.round(progress * 100));
    return `首次启动，正在释放引擎文件（${percent}%）—— 只需一次`;
  }
  return '正在启动引擎…';
}

/* ═══════════════════════════════════════════════════════════
   四、前台服务重启策略
   ═══════════════════════════════════════════════════════════ */

export type ServiceStopReason = 'user' | 'low-memory' | 'task-removed' | 'crash' | 'unknown';

export interface RestartVerdict {
  restart: boolean;
  reason: string;
}

/**
 * 被系统停掉之后要不要重启（`START_STICKY` 的实际语义要自己实现）。
 *
 * ## 为什么不能只靠 `START_STICKY`
 *
 * `START_STICKY` 只保证"进程被杀后系统会尝试重建服务"，
 * **不管服务自己是否应该继续跑**。所以：
 *
 *   · 用户在设置里"停止引擎" → 必须**不重启**，否则用户永远关不掉；
 *   · 用户划掉任务（task-removed）→ Android 12+ 上系统会通知，此时**不该重启**
 *     （用户明确表示不用了）；
 *   · 低内存被杀 → **要重启**（那是系统腾内存，不是用户意图）；
 *   · 崩溃 → 重启但要限次数（否则会成循环崩溃，更耗电）。
 *
 * 这些判断写在 Java 里就等于没法测，所以抽到这里。
 */
export function shouldRestartService(reason: ServiceStopReason, crashesInLastHour = 0): RestartVerdict {
  switch (reason) {
    case 'user':
      return { restart: false, reason: '用户主动停止，不许重启（否则关不掉）' };
    case 'task-removed':
      return { restart: false, reason: '用户划掉了任务，视为不想继续跑' };
    case 'low-memory':
      return { restart: true, reason: '系统因内存压力回收，属于正常情况，应当重启' };
    case 'crash':
      /*
       * 崩溃重启要限次数。
       *
       * 一小时 3 次是经验阈值：正常的偶发崩溃不会这么密；到这个量级说明
       * 是**持续性故障**（依赖缺失、ST 文件损坏），再重启只会反复耗电、
       * 而且界面上会表现为"一直在转圈"。
       */
      if (crashesInLastHour >= 3) {
        return {
          restart: false,
          reason: `一小时内已崩溃 ${crashesInLastHour} 次，先停下并提示用户（反复重启更耗电，且掩盖真实原因）`,
        };
      }
      return { restart: true, reason: `崩溃后重启（过去一小时 ${crashesInLastHour} 次，未到上限）` };
    case 'unknown':
    default:
      // 未知原因不重启：宁可让用户手动开，也不要不明原因地反复拉起
      return { restart: false, reason: '停止原因未知，保守起见不重启' };
  }
}

/** 通知文案（152MB 是这个服务的实测 RSS，写进通知是为了让用户理解为什么它常驻） */
export const FOREGROUND_NOTICE_TITLE = '角色卡引擎运行中';

export function foregroundNoticeText(rssMb: number): string {
  /*
   * 需求要求「152MB RSS 通知文案」—— 即通知里要交代内存占用。
   *
   * 为什么值得写：常驻通知是用户最可能不爽的地方。提前说清"它占多少内存、
   * 为什么要在"比事后被骂"偷跑内存"要好。数值用实测值，不用估计。
   */
  const rounded = Math.max(1, Math.round(rssMb));
  return `聊天引擎在后台运行（约 ${rounded} MB 内存）。它是应用的一部分，不是独立服务。`;
}

/* ═══════════════════════════════════════════════════════════
   五、端口选择
   ═══════════════════════════════════════════════════════════ */

/** 默认端口（与桌面端 ST 一致，契约 §2.1） */
export const DEFAULT_ST_PORT = 8000;

/**
 * 端口是否可用（由调用方实测后喂进来）。
 *
 * 只做一件事：把"端口被占"翻译成可操作的文案。
 * 不在这里做实际探测（那是 Android 侧的事）。
 */
export function describePortConflict(port: number): string {
  return `端口 ${port} 被占用了。可能是其它程序，或上一次的引擎没退干净。到「我的 → 高级功能」里可以换一个端口。`;
}

/** 候选端口（默认优先，被占时依次试） */
export function candidatePorts(preferred = DEFAULT_ST_PORT): number[] {
  return [preferred, preferred + 1, preferred + 2];
}
