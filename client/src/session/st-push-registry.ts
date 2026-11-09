/**
 * 把客户端配置包成"名字映射"能力，供两个推送入口共用（v0.1.7 修订一）。
 *
 * ## 为什么单独一个文件
 *
 * `st-push.ts` 刻意不依赖壳能力 —— 它的所有外部能力都是注入的，于是能在 Node 里
 * 用临时目录真跑测试。映射要存配置（那是壳能力），所以适配代码放这里，
 * 由调用方把它拼进 deps。这样 `st-push.ts` 的测试性没被破坏。
 *
 * ## 为什么不放在各自的调用里
 *
 * 两个入口（四状态对话框、右侧常驻面板）用的是同一份映射。各写一份的后果是
 * **读改写逻辑分叉** —— 某天一边加了"清理空值"，另一边没加，于是两边对同一份
 * 配置的理解开始不同。这跟 `st-push.ts` 当初从对话框里抽出来是同一个理由。
 */

import { configGet, configPatch } from '../contract/shell.ts';
import type { StPushNameRegistry } from './st-push-name.ts';

/** 与 `StPushDeps` 里那两个函数的签名一致 */
export interface StPushNameDeps {
  loadNames: () => Promise<StPushNameRegistry>;
  saveName: (key: string, fileName: string, dropKeys: readonly string[]) => Promise<void>;
}

/**
 * 读映射。
 *
 * 读失败不在这里兜——`st-push.ts` 已经把"读不到就当空表"处理了（那里注释写了
 * 为什么：映射丢了最坏结果是下次加序号，为这个拒绝推送不划算）。所以这里
 * 直接让异常冒出去，由上层统一决定。
 */
async function loadNames(): Promise<StPushNameRegistry> {
  const config = await configGet();
  return config.stPushNames ?? {};
}

/**
 * 登记一条映射，并删掉需要清理的 key（认领场景）。
 *
 * **读改写语义**：先取整份，改一项，写回整份。并发调用会丢更新 —— 但触发条件是
 * "同一瞬间从两个入口推送同一张卡"，而推送本身是用户点一次发生一次、两处互相
 * 排他（对话框与面板不同时可用），所以不引入锁。真要做的话，代价是一个跨窗口
 * 的写队列，而收益是零。
 */
async function saveName(
  key: string,
  fileName: string,
  dropKeys: readonly string[],
): Promise<void> {
  const config = await configGet();
  const next: Record<string, string> = { ...(config.stPushNames ?? {}) };
  next[key] = fileName;
  for (const stale of dropKeys) {
    if (stale !== key) delete next[stale];
  }
  await configPatch({ stPushNames: next });
}

/** 直接展开进 `pushCardToSt({ deps: { ...configNameDeps, probeDir, scanDir, writeBinary } })` */
export const configNameDeps: StPushNameDeps = { loadNames, saveName };
