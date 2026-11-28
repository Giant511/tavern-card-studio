/**
 * 功能
 * 创建元素的唯一入口（typed + 无 innerHTML）。
 *
 * 注意事项
 * 用 `textContent` 而不是 `innerHTML`：本项目的所有文本都可能来自用户
 * 或角色卡（不可信输入），拼 HTML 就等于给自己开一个 XSS 口子。
 *
 * 踩过的坑
 * 这个函数在四个文件里各有一份副本（app.ts / import-dialog.ts / 各 dialog）。
 * 副本之间已经出现细微差异（有的带 `text` 参数、有的不带）。
 * 2026-11-24 收口到这里，新增调用一律 import，不要再复制。
 */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
