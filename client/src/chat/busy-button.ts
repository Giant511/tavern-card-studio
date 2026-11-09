/**
 * 三态按钮（v0.1.8 从 `repo-card-page.ts` 提出来）。
 *
 * ## 为什么单独一个文件
 *
 * 这套「空闲 → 忙碌 → 成功/失败」的循环，v0.1.7 里只有仓库页的下载与
 * 「设为最新」在用（两处，同一个文件内私有函数）。v0.1.8 的本地卡导入
 * 是第三个用它的地方。
 *
 * 复制一份的代价不是「多几十行」，而是**迟早有一处漏掉复位**：
 *
 * ```text
 *   漏 data-state    → 判据与探针读不到状态，以为一直空转
 *   漏 removeAttribute('disabled') → 按钮永久点不动，只能杀 App
 *   漏清 data-tone   → 上一次的红色残留在下一次成功上
 * ```
 *
 * 这三条本项目都踩过（见 `repo-card-page.ts` 的注释与 §132）。
 * 所以宁可多一个文件，也不写第二份。
 *
 * ## 用法
 *
 * ```ts
 * void runBusy(button, LABELS, async () => { ... }).catch((error) => {
 *   options.onNotify(说明细节, 'danger');
 * });
 * ```
 *
 * ★ **调用方必须 `.catch()`** —— 失败时会 reject（好让调用方弹通知），
 * 不接就是 unhandled rejection。
 */

import type { ElLike } from './chat-view.js';

export interface BusyLabels {
  /** 空闲时显示什么（复位回这个） */
  idle: string;
  /** 进行中 */
  busy: string;
  /** 成功后短暂显示 */
  done: string;
  /** 失败后停留（可再点） */
  retry: string;
}

export interface BusyOptions {
  /** 成功态的颜色（交给 CSS 的 `[data-tone]`） */
  doneKind?: 'ok' | 'warn';
  /** 成功后停留多久再复位。默认 800ms */
  resetAfterMs?: number;
}

/**
 * 让一个按钮进入"忙碌 → 成功/失败"循环。
 *
 * @returns 完成时的 Promise；失败时 reject 且按钮停在「重试」。
 */
export function runBusy(
  button: ElLike,
  labels: BusyLabels,
  work: () => Promise<void>,
  options: BusyOptions = {},
): Promise<void> {
  const idle = labels.idle;
  button.textContent = labels.busy;
  button.setAttribute('disabled', 'true');
  /* 让忙碌态可被判定（探针与判据都读这个，不去猜文字） */
  button.setAttribute('data-state', 'busy');

  return (async () => {
    try {
      await work();
      button.textContent = labels.done;
      button.setAttribute('data-state', 'done');
      if (options.doneKind !== undefined) button.setAttribute('data-tone', options.doneKind);
      /*
       * 成功后**复位**：用户可能想再下一次，或再对另一版操作。
       * 800ms 够看清，又不至于让按钮一直停在"已下载"让人以为不能再点。
       */
      globalThis.setTimeout(() => {
        button.textContent = idle;
        button.removeAttribute('disabled');
        button.setAttribute('data-state', 'idle');
        button.removeAttribute('data-tone');
      }, options.resetAfterMs ?? 800);
    } catch (error) {
      /*
       * 失败留在原地：文字变「重试」、可点。
       *
       * ★ 这里**不调 onNotify** —— 按钮本身就表达了结果。
       *   只靠通知的问题是它会被遮挡/自动消失。
       *   调用方接到 reject 后再额外弹一条说明细节，两条一起用。
       */
      button.textContent = labels.retry;
      button.setAttribute('data-state', 'failed');
      button.setAttribute('data-tone', 'danger');
      button.removeAttribute('disabled');
      throw error;
    }
  })();
}
