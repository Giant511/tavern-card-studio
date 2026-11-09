/**
 * 本地文件"是否被外部改过"的基线判定（v0.1.7 增补三）。
 *
 * ## 这条判据要回答什么
 *
 * 取回/导出撞名时，如果本地那份文件**在客户端之外**被改过（手工编辑、
 * 另一个工具、同步盘把云端的旧版本刷下来），直接覆盖就是丢用户的东西。
 *
 * 渲染层能问到的只有"编辑器里有没有未保存的修改"，问不到"磁盘上的文件
 * 是不是还跟上次一样"。后者只能靠 `mtime` 与**上次我们碰它时的 `mtime`** 比 ——
 * 单比"文件早于现在"是恒真的废话。
 *
 * ## 为什么基线存在客户端配置里
 *
 * 它描述的是**本机这份文件的历史**，换台机器毫无意义（与 `stPushNames` 同理）。
 * 服务端也不该知道用户的磁盘布局。
 *
 * ## 三个"看起来该判脏但必须放过"的情况
 *
 * 1. **没有基线**（第一次见这个路径、或配置被清过）⇒ 不判脏。
 *    否则所有老文件第一次取回都会弹三选，用户会学会闭着眼睛点"覆盖"，
 *    那这条判据就白做了。
 * 2. **mtime 取不到**（壳侧给了 0）⇒ 不判脏。文件系统不支持 mtime 属于
 *    极罕见情况，为它把整个功能拦下来不值。
 * 3. **文件比基线旧**（同步盘回滚、用户从备份恢复了旧版本）⇒ 不判脏。
 *    需求写的是"mtime > 基线"，严格大于；旧文件覆盖掉不丢他新东西。
 */

/**
 * 路径归一化，用作基线表的键。
 *
 * Windows 上 `C:\Cards\西奥.PNG` 与 `c:/cards/西奥.png` 是同一个文件，
 * 而两次调用可能来自不同来源（保存对话框给的、扫描目录给的）。
 * **键的生成必须只有一处** —— 两处各归一一次，迟早分叉。
 *
 * 只做两件事：分隔符统一成 `/`、转小写。不做 `..` 折叠（那是另一类活儿，
 * 且壳侧已经 canonicalize 过）。
 */
export function baselineKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').trim().toLowerCase();
}

/**
 * 这个文件的 mtime 是否**严格晚于**基线。
 *
 * @param mtimeMs 当前文件的 mtime（`statFile` 给的；0 表示取不到）
 * @param baseline 上次与本客户端同步时的 mtime；`undefined` = 没记录过
 * @returns true = 文件被外部改过，需要走三选
 */
export function isNewerThanBaseline(
  mtimeMs: number,
  baseline: number | undefined,
): boolean {
  // 见文件头第 1、2 条：没有基线 / 取不到时间，都不判脏
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return false;
  if (baseline === undefined || !Number.isFinite(baseline) || baseline <= 0) return false;
  /*
   * 用 `>` 而不是 `!==`：文件系统时间精度有限（FAT32 只有 2 秒），
   * 写完立刻读回来可能得到**相同的 mtime**；反过来"变旧"（同步盘回滚）
   * 也不该判脏（见文件头第 3 条）。
   */
  return mtimeMs > baseline;
}

/** 从基线表里查这条路径的基线 */
export function getBaseline(
  map: Readonly<Record<string, number>> | null | undefined,
  path: string,
): number | undefined {
  if (map === null || map === undefined) return undefined;
  const value = map[baselineKey(path)];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 记下"我们此刻碰过这个文件，它是这个时间"。
 *
 * 返回**新对象**而不是原地改：配置是 `plugin-store` 的 JSON，
 * 原地改会让调用方以为"已经存了"，而实际还要走一次 `configPatch`。
 * 返回新对象能逼调用方把结果传下去，不容易漏存。
 *
 * `mtimeMs` 非法（0 / NaN）时**原样返回**，不写坏值 ——
 * 写进去一个 0 会让下次判定把任何文件都当成"不旧于基线"，
 * 等于悄悄关掉这条判据。
 */
export function recordBaseline(
  map: Readonly<Record<string, number>> | null | undefined,
  path: string,
  mtimeMs: number,
): Record<string, number> {
  const next: Record<string, number> = { ...(map ?? {}) };
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return next;
  next[baselineKey(path)] = mtimeMs;
  return next;
}

/**
 * 删掉一条基线（文件被删除 / 另存到别处时）。
 *
 * 不删的后果：用户把 `西奥.png` 换成另一张同名图，旧基线还在，
 * 新文件 mtime 更新 ⇒ 下次取回必然弹三选，而实际上没有任何东西要保。
 */
export function dropBaseline(
  map: Readonly<Record<string, number>> | null | undefined,
  path: string,
): Record<string, number> {
  const next: Record<string, number> = { ...(map ?? {}) };
  delete next[baselineKey(path)];
  return next;
}
