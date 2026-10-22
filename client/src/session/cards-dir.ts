/**
 * 卡片目录的**带副作用入口**（T9.8 / F4）。
 *
 * 与 `cards-path.ts` 的分工：
 *   · `cards-path.ts` —— 纯逻辑（命名、拼接、截断），可以在 Node 里单测；
 *   · 这里 —— 需要读配置、问壳要默认目录、列目录内容，所以依赖契约层。
 *
 * 为什么单独抽出来：**打开**与**保存**两个对话框、以及设置面板都要同一个
 * "当前生效的卡片目录"。各写一遍必然出现"设置里改了、保存还落在老地方"。
 */

import { configGet, defaultCardsDir, isShellAvailable, scanCardsDir } from '../contract';
import { nextAvailableFileName, resolveCardsDir, sanitizeFileBase } from './cards-path';

/**
 * 当前生效的卡片目录。
 *
 * 浏览器模式返回空串：那里没有壳，也就没有默认目录、没有原生对话框，
 * 返回一个假的 `C:\...` 只会让后续逻辑以为能落盘。
 */
export async function effectiveCardsDir(): Promise<string> {
  if (!isShellAvailable()) return '';
  try {
    const fallback = await defaultCardsDir();
    const config = await configGet();
    return resolveCardsDir(config.cardsDir, fallback);
  } catch {
    // 读配置失败不该挡住"打开/保存卡片"这件与网络无关的事
    return '';
  }
}

/**
 * 为一张卡挑一个不冲突的文件名（含扩展名）。
 *
 * 序号规则见 `nextAvailableFileName`：`名字.json` → `名字 (2).json` → …
 * 列目录失败时退回原名 —— 让保存对话框自己弹"是否覆盖"，
 * 比因为列不出目录就直接不让人保存要好。
 */
export async function suggestCardFileName(cardName: string, dir: string): Promise<string> {
  const base = sanitizeFileBase(cardName);
  if (dir === '') return `${base}.json`;
  try {
    const scan = await scanCardsDir(dir);
    return nextAvailableFileName(scan.names, base);
  } catch {
    return `${base}.json`;
  }
}
