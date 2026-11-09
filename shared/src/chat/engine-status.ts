/**
 * 引擎状态的真实来源（2026-10-31 第五批）。
 *
 * ## 为什么需要这个模块
 *
 * 用户报的原话：
 *
 * > 引擎实际在跑、UI 却读不到 …… 这一点必须查清
 *
 * 取证结论（`.verify/round5-evidence.md`）：UI 那份「读不到当前的聊天设置。
 * 可能是内嵌服务还没起来。」**判的不是"引擎在不在跑"**，而是
 * "能不能读到 ST 设置"。而后者断在 `bridge.connect()` 从未被调用
 * —— 与引擎死活**无关**。
 *
 * 也就是说：UI 在拿一个"链路状态"冒充"进程状态"，归因错了。
 *
 * ## 现在的判据分成两个，互不冒充
 *
 * | 问题 | 谁回答 |
 * |---|---|
 * | 引擎进程在不在跑？ | Android 侧 `__ST_ENGINE__.status()`（真读 `/proc` + 探活缓存） |
 * | 设置读不读得到？ | `bridge.settingsGetRaw()` 的真实结果 |
 *
 * 两者组合出四种状态，文案各不相同 —— 见 `describeSettingsFailure()`。
 */

/** Android 侧 `StBridge.status()` 返回的形状 */
export interface EngineStatus {
  /** 端口上有没有认得的 ST 在应答（服务侧缓存的探测结果） */
  ready: boolean;
  /** 实际端口（可能是备用端口 8001+） */
  port: number;
  /** 引擎进程的常驻内存（MB）。0 = 拿不到 */
  rssMb: number;
  /** ST 数据是否已解包 */
  unpacked: boolean;
  /** 我们自己 spawn 的进程还活着吗 */
  running: boolean;
  /** 最近一次失败原因（没有则 null） */
  error: string | null;
  /**
   * 角色目录的绝对路径（2026-11-04，T15.2）。
   *
   * 只有 Android 侧知道 `filesDir` 的真实位置。空串 = 拿不到
   * （浏览器预览 / 桌面端没有这个桥）。
   */
  charactersDir: string;
}

/**
 * 解析 `__ST_ENGINE__.status()` 的 JSON 字符串。
 *
 * ## 为什么是字符串而不是对象
 *
 * `@JavascriptInterface` 的返回值只支持基本类型与 String ——
 * 返回对象会被转成 `"[object Object]"`（不报错，前端拿到一个没用的字符串）。
 * 这是 Android WebView 的硬限制，不是设计选择。
 *
 * 解析失败返回 `null`（= 拿不到状态），**不返回一个"看起来很正常的默认值"**：
 * 伪造一个 `{ready:false}` 会让 UI 说"引擎没起来"，而我们其实只是读不到状态。
 */
export function parseEngineStatus(raw: unknown): EngineStatus | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const ready = obj['ready'];
  if (typeof ready !== 'boolean') return null;

  return {
    ready,
    port: typeof obj['port'] === 'number' ? obj['port'] : 8000,
    rssMb: typeof obj['rssMb'] === 'number' ? obj['rssMb'] : 0,
    unpacked: obj['unpacked'] === true,
    running: obj['running'] === true,
    error: typeof obj['error'] === 'string' ? obj['error'] : null,
    charactersDir: typeof obj['charactersDir'] === 'string' ? obj['charactersDir'] : '',
  };
}

/** 设置读失败时的归因结果 */
export interface SettingsFailureNote {
  /** 给用户看的第一句 */
  message: string;
  /** 下一步该做什么 */
  hint: string;
  /** 归因分类（排障用） */
  cause: 'engine-down' | 'not-connected' | 'read-failed' | 'unknown';
}

/**
 * 把"引擎状态 + 读设置是否成功"组合成**如实**的归因。
 *
 * ## 四种情况的文案必须不同
 *
 * 1. 引擎没跑 → "引擎还没起来"（用户该去点开始/看通知）
 * 2. 引擎在跑、但读设置失败 → **不能说"引擎没起来"**（那是假归因，正是本次要修的）
 *    → "引擎在运行，但读设置失败"（用户该重试 / 反馈）
 * 3. 拿到状态但 ready=false（进程在、端口没应答）→ "引擎进程在但还没就绪"
 * 4. 拿不到状态（非 Android / 桥没注入）→ 中性说法，不猜
 *
 * `engine === null` 表示**这个平台没有引擎状态来源**（桌面端/浏览器），
 * 此时不能说"引擎没起来" —— 桌面端的 ST 是用户自己在外面起的。
 */
export function describeSettingsFailure(engine: EngineStatus | null, detail?: string): SettingsFailureNote {
  const suffix = detail === undefined || detail === '' ? '' : `（${detail}）`;

  if (engine === null) {
    return {
      cause: 'unknown',
      message: `读不到当前的聊天设置${suffix}`,
      hint: '确认聊天服务在运行、地址填对了，再点重试。',
    };
  }

  if (!engine.running && !engine.ready) {
    return {
      cause: 'engine-down',
      message: `引擎还没起来${suffix}`,
      hint: '下拉通知栏看「口袋酒馆 正在运行」是否在；不在就回聊天页点一次「开始聊天」。',
    };
  }

  if (engine.running && !engine.ready) {
    return {
      cause: 'engine-down',
      message: `引擎进程在，但还没就绪${suffix}`,
      hint: '首次启动要几十秒（解包 + 建初始数据）。等一会儿点重试。',
    };
  }

  /*
   * 走到这里：进程在、端口也 ready，但读设置失败。
   * **这是本次要如实呈现的那一种** —— 绝不能再说"服务没起来"。
   */
  return {
    cause: 'read-failed',
    message: `引擎在运行（端口 ${String(engine.port)}），但读设置失败${suffix}`,
    hint: '这是连接或设置文件的问题，不是引擎没起。点重试；反复失败请把这条提示发出来。',
  };
}
