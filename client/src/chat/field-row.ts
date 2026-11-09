/**
 * 表单字段行（标签 + 控件 + 说明）—— 共用一份（2026-11-04）。
 *
 * ## 为什么抽出来
 *
 * `persona-page.ts` 与 `worldbook-page.ts` 各有一份 `fieldRow`，逻辑逐字
 * 相同，只有一处不同：
 *
 * ```text
 *   persona-page   const hint = el(doc, 'span', 'nb-field-hint');   ✅ 灰色小字
 *   worldbook-page const note = el(doc, 'p',    'nb-note');        ❌ 带边框的块
 * ```
 *
 * `.nb-note` 是**提示条**（横幅那一类：带 1px 边框、`--nb-surface-1` 底色、
 * 圆角、内边距），用来提示"正在读取""加载失败"。把它当成字段说明用，真机
 * 截图里每个字段下面就多出一个框，一整页像一堆没填的空输入框。
 *
 * 这个缺陷能存在，就是因为"同一件事写了两遍"—— 两份一旦分叉，改一份
 * 另一份不会跟着对。所以这里只留一份，两边都 import。
 *
 * ## 两类文字别混用
 *
 * | 用途 | 类 | 观感 |
 * |---|---|---|
 * | 字段说明（"填了会发生什么"） | `.nb-field-hint` | 灰色小字，无边框 |
 * | 提示条（"正在读取 / 加载失败"） | `.nb-note` | 带边框的块，可用 `data-kind` 上语义色 |
 *
 * 判据：`test/field-row.test.mjs`。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

export interface FieldRow {
  /** 整行（标签 + 控件 + 说明），直接 append 到容器 */
  row: ElLike;
  /** 只放控件的地方 */
  body: ElLike;
}

/**
 * 造一个字段行。
 *
 * @param labelText 标签文字（用户看到的字段名）
 * @param hintText  说明文字。空串与 `undefined` 都表示"不要说明" ——
 *                  空串会画出一条空白占位，看起来像渲染错。
 */
export function fieldRow(doc: DocLike, labelText: string, hintText?: string): FieldRow {
  const row = el(doc, 'div', 'nb-field');
  const label = el(doc, 'label', 'nb-field-label');
  label.textContent = labelText;
  const body = el(doc, 'div', 'nb-field-body');
  row.append(label, body);

  if (hintText !== undefined && hintText !== '') {
    /*
     * 用 `span` 而不是 `p`：说明是**标签的附属文字**，不是独立段落。
     * `p` 自带上下外边距，在 `gap` 布局里会多出一截。
     */
    const hint = el(doc, 'span', 'nb-field-hint');
    hint.textContent = hintText;
    row.append(hint);
  }

  return { row, body };
}
