/**
 * 角色级记忆的本地存储（2026-11-22，v0.2.2）。
 *
 * ## 为什么只存本地、不写进角色卡
 *
 * 用户明令：
 *
 * > 这个记忆不需要随角色卡，只存储在用户本地，可导入导出
 *
 * 写进卡的话有两个问题：一是导出给别人时会带上私人的剧情摘要；
 * 二是每次改记忆都要重写一遍 PNG，而那是几百 KB 的原子写盘。
 *
 * ## 为什么按 avatar 分槽
 *
 * `avatar` 是 ST 目录里的真实文件名，一定有。而 `extensions.tcs.cardId`
 * 大量卡根本没有（见 `client/src/session/card-id.ts` 的兜底逻辑）。
 *
 * 代价：用户在 ST 里改了角色文件名之后，旧记忆会对不上。这时界面上
 * 显示「这个角色还没有记忆」，而不是报错 —— 记忆丢了但聊天照常。
 *
 * ## 与 `shared/src/chat/memory.ts` 的分工
 *
 * 那边是纯解析/校验/预算，一行 IO 都没有；这边只管读写 localStorage。
 * 分开才能让那边的判据在 Node 里直接跑。
 */

import {
  type CharacterMemory,
  type MemoryEntry,
  type MemoryStore,
  emptyMemoryStore,
  memoryOf,
  parseMemoryStore,
  withMemoryOf,
} from '../../../shared/dist/index.js';

const LS_MEMORY = 'tcs.mobile.memory';

/** 取 localStorage；不可用时返回 null（而不是抛错） */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    /* 隐私模式 / 被策略禁用时会抛 */
    return null;
  }
}

/** 把存储里的原始 JSON 读成结构化存档。坏值一律当空 */
export function readMemoryStore(): MemoryStore {
  const store = storage();
  if (store === null) return emptyMemoryStore();
  try {
    const raw = store.getItem(LS_MEMORY);
    if (raw === null) return emptyMemoryStore();
    return parseMemoryStore(JSON.parse(raw));
  } catch {
    /*
     * 解析失败当空，不抛。
     *
     * 记忆读不出来时聊天必须照常能用 —— 用户最不希望的是
     * "一个坏掉的记忆 JSON 让整个 App 打不开"。
     */
    return emptyMemoryStore();
  }
}

/**
 * 写回存档。
 *
 * @returns 是否成功。写失败（配额满 / 隐私模式）时返回 `false`，
 *          调用方要提示用户 —— 与"聊天记录存不进 ST"不同，
 *          记忆**只有这一份**，写失败就是真丢了。
 */
export function writeMemoryStore(next: MemoryStore): boolean {
  const store = storage();
  if (store === null) return false;
  try {
    store.setItem(LS_MEMORY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/** 读某个角色的记忆条目。没有就返回空数组 */
export function readCharacterMemory(avatar: string): MemoryEntry[] {
  if (avatar.trim() === '') return [];
  return memoryOf(readMemoryStore(), avatar);
}

/**
 * 写某个角色的记忆条目。
 *
 * @returns 是否成功
 */
export function writeCharacterMemory(avatar: string, entries: readonly MemoryEntry[]): boolean {
  if (avatar.trim() === '') return false;
  return writeMemoryStore(withMemoryOf(readMemoryStore(), avatar, entries));
}

/**
 * 有记忆的角色列表。
 *
 * 导出「全部角色」时用。只返回有内容的那些 —— 空壳不该出现在列表里。
 */
export function listMemoryCharacters(): Array<{ avatar: string; entryCount: number }> {
  const store = readMemoryStore();
  const out: Array<{ avatar: string; entryCount: number }> = [];
  for (const [avatar, value] of Object.entries(store.byAvatar)) {
    const memory: CharacterMemory | undefined = value;
    if (memory === undefined || memory.entries.length === 0) continue;
    out.push({ avatar, entryCount: memory.entries.length });
  }
  /* 按角色名排序，界面上好找 */
  out.sort((a, b) => a.avatar.localeCompare(b.avatar));
  return out;
}
