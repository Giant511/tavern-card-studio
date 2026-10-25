/**
 * 用户对外标识 `uid`（v0.1.3 / F2）。
 *
 * ## 为什么用户表已经有 `id` 还要再有一个 uid
 *
 * `id` 是**内部主键**（`randomUUID()`），它出现在 `owner_id`、`sessions.user_id`、
 * 仓库归属等所有外键上。它的问题是：
 *
 *   · 它是 uuid，全站唯一但**不可读**，人念不出来、也没法在工单里核对；
 *   · 更关键的是：**用户名可改、可重名**（重名在库里是被 `username_key` 挡住的，
 *     但改名之后"同一个人的历史记录"要靠什么串起来？）。
 *
 * 治理页要显示「用户名（uid）」，审计日志要能回答"这条记录是谁做的" ——
 * 如果只有用户名，用户改个名字，历史记录就再也对不上人。
 * 所以需要一个**注册时生成、此后永不变**的短标识。这就是 uid。
 *
 * ## 形态与为什么不复用其他前缀
 *
 * `usr_` + 8 位 base32（小写，去掉易混的 `0/1/o/l`）。
 *
 *   · 前缀 `usr_` 与仓库令牌 `tcr_` 一致，一眼能看出是本项目的标识；
 *   · 8 位 = 32^8 ≈ 1.1e12 种，账户量级下碰撞可忽略，但仍**必须**靠唯一索引兜底
 *     （概率低不等于不可能，而唯一索引是零成本的确定性保证）；
 *   · 去掉 `0/1/o/l` 是为了能口头念、能手抄 —— 它的用途本来就是"人来核对"。
 *
 * ## 为什么不复用 `id`（把 uuid 显示出来）
 *
 * 隐私与可枚举性：`id` 是内部主键，把它暴露给前端等于把内部寻址方式公开；
 * 而 uid 与 `id` 之间没有推导关系，即使泄露也不能拿去构造内部请求。
 */

import { randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

/** 去掉了 0 / 1 / o / l 的 base32 字母表（32 个字符，正好 5 bit/字符） */
const UID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** uid 的随机段长度 */
const UID_RANDOM_LENGTH = 8;

/**
 * 生成一个 uid。**不保证唯一**（概率上足够），唯一性由 `idx_users_uid` 兜底。
 */
export function generateUserUid(): string {
  const bytes = randomBytes(UID_RANDOM_LENGTH);
  let out = '';
  for (let index = 0; index < UID_RANDOM_LENGTH; index += 1) {
    // 取 5 bit 映射到字母表；`?? 0` 只为满足 noUncheckedIndexedAccess
    out += UID_ALPHABET[(bytes[index] ?? 0) % UID_ALPHABET.length] ?? 'a';
  }
  return `usr_${out}`;
}

/** uid 的形态（用于校验与测试断言，不做业务判断） */
export const USER_UID_PATTERN = new RegExp(`^usr_[${UID_ALPHABET}]{${String(UID_RANDOM_LENGTH)}}$`);

/**
 * 给既有用户补号（老库迁移）。
 *
 * 触发时机：`Db` 构造函数里 `ensureColumn(users, 'uid')` 之后、建唯一索引之前。
 *
 * 三条要点：
 *
 *   1. **只补空串**：新库没有行可补；已经补过的库因为 `uid != ''` 而整体跳过。
 *      不能按"列是否存在"判 —— 列在、值可能还是空（上一次补号中途失败）。
 *   2. **补号用逐行 UPDATE，且在事务里**：中途崩溃不会留下"一半有号一半没有"，
 *      否则下次启动会认为已经处理完（因为部分行有值）而永远漏掉剩下那些。
 *   3. **冲突重试**：极端情况下新生成的号可能撞上已有 uid，重生成即可。
 *      不做"扫描全表去重"那种重活，循环几次就够（8 位随机段撞车概率极低）。
 */
export function backfillUserUids(handle: Database.Database): number {
  const rows = handle.prepare("SELECT id FROM users WHERE uid = ''").all() as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const taken = new Set(
    (handle.prepare("SELECT uid FROM users WHERE uid != ''").all() as Array<{ uid: string }>).map((row) => row.uid),
  );
  const update = handle.prepare('UPDATE users SET uid = ? WHERE id = ?');

  const assign = handle.transaction(() => {
    let count = 0;
    for (const row of rows) {
      let uid = generateUserUid();
      let guard = 0;
      while (taken.has(uid)) {
        uid = generateUserUid();
        guard += 1;
        // 理论上到不了这里（1e12 空间）；真到了就说明随机源坏了，宁可报错也不要写出重复
        if (guard > 1000) throw new Error('生成 uid 连续冲突，随机源可能异常');
      }
      taken.add(uid);
      update.run(uid, row.id);
      count += 1;
    }
    return count;
  });

  return assign();
}
