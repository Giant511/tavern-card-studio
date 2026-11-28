/**
 * 按 id 取 DOM 节点，取不到就抛（2026-11-24 从 `app.ts` 拎出来）。
 *
 * ## 为什么单独成文件
 *
 * 只有 5 行，但有两个消费方：`app.ts`（16 处）与 `demo-actions.ts`（1 处）。
 *
 * 让 `demo-actions.ts` 从 `app.ts` import 它是不行的 —— 那会形成
 * `demo-actions → app`（值依赖），而 `app` 已经在主 chunk 里，
 * 懒加载的 demo 模块会把整条依赖链再拉一遍。拎成零依赖的小模块，
 * 两边都只依赖这 5 行。
 *
 * ## 为什么抛错而不是返回 null
 *
 * 这些调用点全都是"HTML 里必须存在这个节点"（`index.html` 与 `mobile.html`
 * 都在仓库里，改了会同步）。返回 null 会把这个约定变成每个调用方各判一次，
 * 而漏判的后果是 `null.hidden = true` 这种在下一次点击时才炸的错。
 *
 * 抛错时把 id 写进消息 —— `缺少 DOM 节点 #card-name` 一眼能定位。
 */
export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少 DOM 节点 #${id}`);
  return node as T;
}
