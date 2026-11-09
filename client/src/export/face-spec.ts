/**
 * 卡面三套产物的**规格与口径**（v0.1.7 增补二）。
 *
 * 为什么规格要单独一个文件而不是散在管线里：这三个产物各有各的红线，
 * 而且**三套规则禁止混用**（用户原话）。把它们摊在一处，谁想改数字都得
 * 先看到另外两个 —— 否则很容易出现"给仓库资产放宽到 500KB"这种
 * 顺手把 ST 头像红线也带跑的事。
 *
 * ## 三套产物是什么、为什么必须分开
 *
 * | 产物 | 格式 | 红线 | 存在哪 |
 * |---|---|---|---|
 * | 仓库卡面资产 | WebP（平涂小图可留 PNG） | **250KB 硬限** | 服务端 `faces/` |
 * | ST 头像 | PNG 256 色，512×512 | 500KB 软上限 | `characters/<名>.png` 的一角 |
 * | PNG 卡 / 导出 | PNG，卡面原尺寸 + 卡数据块 | **不受 250KB 限制**，5MB 提示 | 用户磁盘 |
 *
 * 关键点：**250KB 只约束"进仓库的那一份"**。ST 头像和 PNG 卡都不占仓库空间，
 * 所以它们不受这条红线约束 —— 但它们也不是任意大小，各自有软上限。
 *
 * ## "视觉无损"的口径（必须进决策表）
 *
 * 用户定义：**q90 是质量下限，不是数学无损**。
 *
 * 这一点绕不开一个事实：照片类内容**无法**在 PNG 容器里以 250KB 达到视觉无损。
 * 所以设计是各管一段：
 *   · 压缩红利在**仓库层**由 WebP 吃掉（WebP 有损，但 q90 肉眼难辨）；
 *   · 格式合规在**出口层**转 PNG（ST 与导出只认 PNG 容器）；
 *   · 平涂插画例外 —— 它本来就能在 PNG 里压得很小，保留 PNG 才是真无损。
 */

/** 仓库卡面资产的字节上限。**唯一吃这条红线的产物。** */
export const STORE_FACE_MAX_BYTES = 250 * 1024;

/** WebP 编码起点质量。先试它 —— 大多数图 q95 就能进 250KB。 */
export const WEBP_QUALITY_START = 95;

/** WebP 质量下限 = "视觉无损"的口径。低于它宁可不收这张图。 */
export const WEBP_QUALITY_FLOOR = 90;

/**
 * 超限后的降尺寸阶梯（长边）。
 *
 * 从大到小试，命中即停 —— 用户的图能保多大就保多大。
 * 900 是最后一档：再小的话卡面在 ST 里已经糊成方块了，不如让用户换图。
 */
export const STORE_RESIZE_LADDER = [1600, 1200, 900] as const;

/** ST 头像边长（正方形） */
export const ST_AVATAR_EDGE = 512;

/** ST 头像调色板色数（pngquant 的经典 256 色） */
export const ST_AVATAR_COLORS = 256;

/** ST 头像的**软**上限：超了只提示，不拦（它不占仓库） */
export const ST_AVATAR_WARN_BYTES = 500 * 1024;

/** PNG 卡 / 导出的**软**提示阈值：超了状态栏说一句，仍然导出 */
export const PNG_CARD_WARN_BYTES = 5 * 1024 * 1024;

/**
 * 给用户看的那句兜底提示。
 *
 * 为什么要有它：用户在选图之前**无从知道**自己的图能不能进 250KB。
 * 与其让他反复试，不如直接告诉他经验线 ——
 * 而且这条经验线是**内容相关**的，所以只能给"通常"，不能写成承诺。
 */
export const FACE_SIZE_HINT = '长边 ≤2500px 的图通常都能进 250KB，超限会自动降尺寸。';

/** 到 900px + q90 仍超限时的拒绝文案。不说"压缩失败"，说"换一张更简洁的"。 */
export const FACE_REJECT_HINT = '图太复杂，换一张更简洁的。';

/**
 * 仓库卡面资产允许的 MIME。
 *
 * 与 `server/src/storage/cards.ts` 的 `FACE_MIME_ALLOWED` 必须一致 ——
 * 两边对不上的后果是客户端压好了、服务端 415 拒掉，而错误信息说的是
 * "不支持的图片类型"，看着像用户在选图那步出的错。
 */
export const STORE_FACE_MIME = ['image/webp', 'image/png'] as const;

/** 字节数的可读形式。**KB 就 KB，不要显示成 0.24 MB** —— 250KB 的图上限说成 MB 会让人以为是笔误。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    // 100KB 以上不留小数：`248.7 KB` 的精度没有意义
    return kb >= 100 ? `${String(Math.round(kb))} KB` : `${kb.toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
