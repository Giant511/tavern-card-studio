/**
 * 功能
 * 一个板块的运行时状态：快照（数据）+ 几个 DOM 节点（视图）。
 *
 * 注意事项
 * `expanded` / `collapsed` 这类是**纯 UI 状态**，不进快照、不参与脏判定 ——
 * 折叠一个板块不算"改了卡"。写进快照会让导出带上无意义的差异。
 *
 * 踩过的坑
 * 这个接口原来定义在 app.ts 里，被 demo-actions / block 操作 / 预览共同引用。
 * 搬出来时注意 `el` 的返回类型是 `HTMLElementTagNameMap[K]`，
 * 而这里的字段声明成 `HTMLElement` 就够 —— 别为了精确去写泛型，那会让
 * 所有使用方都要跟着带类型参数。
 */

import type { BlockEditor } from './block-editor';
import type { EditorBlockSnapshot } from './block-doc';
import type { UndoSnapshot } from './undo-snapshot';

/**
 * 一个板块的运行时状态。
 *
 * ★ 导出是给 `demo-actions.ts` 用的（纯类型，编译后擦除，不影响产物划分）。
 */
export interface BlockRuntime {
  snapshot: EditorBlockSnapshot;
  section: HTMLElement;
  body: HTMLElement;
  host: HTMLElement;
  preview: HTMLElement;
  badge: HTMLElement;
  editor: BlockEditor | null;
  expanded: boolean;
  previewOn: boolean;
  /**
   * 功能
   * 折叠前存下的撤销现场（P1-10）。展开时若校验通过就复用它。
   *
   * 注意事项
   * 展开后要清成 null —— 否则下次折叠会拿一份已经"落后"的旧 state 覆盖新的。
   */
  undo: UndoSnapshot | null;
}
