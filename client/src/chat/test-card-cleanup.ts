/**
 * 首启清理「内置测试卡」（2026-11-09，A1）。
 *
 * ## 这一步解决什么
 *
 * v0.1.7 早期包的 `TestCardSeeder` 会把一张测试角色卡播进
 * `default-user/characters/`。那个播种器与资产**已经删除**，但
 * **已经装过早期包的机器上那张卡还在** ——
 * 删播种器只保证"不再播新的"，不会清掉已经种下去的。
 *
 * 结果：那些用户升级后会一直看到角色列表里有个「测试用-夜航小助手」，
 * 以为那是产品自带内容。
 *
 * ★ 这个缺口在开发机上**看不出来**：开发机做过 `pm clear`（数据全清）。
 * 测试机的干净会掩盖真机的不干净 —— 这类"只在升级路径上出现"的问题
 * 只能靠代码主动清，不能靠打包时删资产。
 *
 * ## 判据为什么在 TS 里
 *
 * 「什么算测试卡」由 `shared/src/android/test-card-cleanup.ts` 的
 * `isBuiltinTestCard` 决定（双判据、有单测）。Kotlin 只负责
 * 列目录 / 读字段 / 删文件 —— 判断写两份必然漂移，而代价是误删用户的卡。
 *
 * ## 失败了怎么办
 *
 * **什么都不做，也不提示**。清理是"顺手做的好事"，不是用户要求的动作；
 * 失败时弹一句"清理失败"只会让用户困惑（他没有要求清任何东西）。
 * 只记一条 console.warn 供排查。
 */

import {
  describeRemovedTestCards,
  pickBuiltinTestCards,
  type CardIdentity,
} from '@tcs/shared';

/** 原生桥返回的形状 */
interface TestCardReply {
  candidates?: Array<{ fileName?: string; characterVersion?: string | null }>;
  removed?: string[];
  error?: string;
}

/** Android 注入的桥（只有移动端有这两个方法） */
interface TestCardBridge {
  scanTestCards?: (requestId: string) => void;
  removeTestCards?: (namesJson: string, requestId: string) => void;
}

interface CleanupHost {
  __ST_ENGINE__?: TestCardBridge;
  __TCS_TESTCARDS__?: (requestId: string, raw: string | Record<string, unknown>) => void;
}

/** 等原生回传的 Promise（按 requestId 落定） */
const pending = new Map<string, (reply: TestCardReply) => void>();

let hooked = false;
let seq = 0;

/**
 * 挂回传钩子（幂等）。
 *
 * 与 `native-fetch.ts` 的 `ensureReplyHook` 同一个套路：**只注册一次**，
 * 重复注册会让仍在途的请求失去回调（后注册的覆盖前一个，前一个 Promise 永远悬着）。
 */
function ensureHook(host: CleanupHost): void {
  if (hooked) return;
  hooked = true;
  host.__TCS_TESTCARDS__ = (requestId, raw) => {
    const resolve = pending.get(requestId);
    if (resolve === undefined) return;
    pending.delete(requestId);
    let parsed: TestCardReply;
    try {
      /*
       * ★ 第二个参数可能是**对象**而不是字符串：
       * `evaluateJavascript` 会把 JSON 字面量当 JS 对象求值。
       * 直接 `JSON.parse` 会得到 `[object Object]` —— 这个坑在
       * `native-fetch.ts` 里已经踩过一次了。
       */
      parsed = typeof raw === 'string' ? (JSON.parse(raw) as TestCardReply) : (raw as TestCardReply);
    } catch {
      parsed = {};
    }
    resolve(parsed);
  };
}

/** 调一次原生方法并等回传；超时返回 null（不抛 —— 清理失败不该影响启动） */
function callNative(
  host: CleanupHost,
  invoke: (requestId: string) => void,
  timeoutMs = 4000,
): Promise<TestCardReply | null> {
  return new Promise((resolve) => {
    const id = `tc-${String((seq += 1))}`;
    let settled = false;
    const finish = (value: TestCardReply | null): void => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      resolve(value);
    };
    pending.set(id, finish);
    setTimeout(() => finish(null), timeoutMs);
    try {
      invoke(id);
    } catch {
      finish(null);
    }
  });
}

/** 这次清理的结果（给上层决定要不要提示） */
export interface TestCardCleanupResult {
  /** 真的删掉了哪些（文件名） */
  removed: string[];
  /** 给用户看的一句话；没有删任何东西时是空串 */
  message: string;
  /** 扫描到几张候选卡（排查用） */
  scanned: number;
}

/**
 * 清理内置测试卡。
 *
 * 幂等：没有测试卡时什么都不做（也不会提示）。
 *
 * @param notify 非打断式提示的通道（通常是 App 的 toast/状态行）
 */
export async function cleanupBuiltinTestCards(
  notify?: (message: string) => void,
): Promise<TestCardCleanupResult> {
  const empty: TestCardCleanupResult = { removed: [], message: '', scanned: 0 };

  const host = globalThis as CleanupHost;
  const bridge = host.__ST_ENGINE__;
  /*
   * 桌面端 / 浏览器预览没有这两个方法 —— 直接返回。
   * 用 `typeof === 'function'` 而不是 truthy：桥对象在桌面端也存在
   * （别的功能要用），只是没有这两个方法。
   */
  if (bridge === undefined || typeof bridge.scanTestCards !== 'function') return empty;

  ensureHook(host);

  const scanned = await callNative(host, (id) => bridge.scanTestCards!(id));
  if (scanned === null || scanned.error !== undefined) {
    /* 静默失败：见文件头注释 */
    return empty;
  }

  const candidates: CardIdentity[] = (scanned.candidates ?? [])
    .filter((one) => typeof one.fileName === 'string' && one.fileName !== '')
    .map((one) => ({
      fileName: one.fileName as string,
      characterVersion: typeof one.characterVersion === 'string' ? one.characterVersion : null,
    }));

  const hits = pickBuiltinTestCards(candidates);
  if (hits.length === 0) return { ...empty, scanned: candidates.length };

  const names = hits.map((one) => one.fileName);
  const reply = await callNative(host, (id) =>
    bridge.removeTestCards!(JSON.stringify(names), id),
  );
  const removed = reply?.removed ?? [];

  /*
   * ★ 只报**真的删掉的**。
   *
   * 判据命中但删除失败（权限、文件被占用）时，如果照着 `names` 报
   * "已清理"，用户去角色列表一看卡还在 —— 我们刚才撒了谎。
   * 这是"不许对用户谎报已完成"的直接应用。
   */
  const message = describeRemovedTestCards(removed);
  if (message !== '' && notify !== undefined) notify(message);

  return { removed, message, scanned: candidates.length };
}
