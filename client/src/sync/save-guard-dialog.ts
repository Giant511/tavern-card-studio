/**
 * 落盘撞名时的两个弹窗（v0.1.7 增补三）。
 *
 * 只有两个：三选（同卡但本地脏）与二选（本地文件没有卡片标识）。
 * 异卡撞名不弹窗 —— 它直接另存并在状态栏说一句，因为用户没得选
 * （总不能让他覆盖掉别人的卡）。
 *
 * ## 为什么按钮顺序固定
 *
 * 「覆盖」永远在最左且标红：它是**写**动作里最危险的那个，放在顺手位置
 * 就是等着被误点。「查看差异」永远在最后：它是查看动作，点错只是多看一眼。
 * 这条已经在 `face-drop.ts` 的 `DIRTY_CHOICES` 里定死，这里只负责渲染。
 */

import type { DirtyChoiceId } from '../export/face-drop.ts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface Shell {
  overlay: HTMLDivElement;
  body: HTMLDivElement;
  foot: HTMLDivElement;
  close: () => void;
}

function buildShell(role: string, title: string): Shell {
  const overlay = el('div', 'modal-overlay modal-overlay-top');
  overlay.dataset['role'] = role;
  const panel = el('div', 'modal');
  panel.style.maxWidth = '520px';

  const head = el('div', 'modal-head');
  head.append(el('h2', 'modal-title', title));

  const body = el('div', 'modal-body');
  const foot = el('div', 'modal-foot');
  panel.append(head, body, foot);
  overlay.append(panel);
  document.body.append(overlay);

  return {
    overlay,
    body,
    foot,
    close: () => { overlay.remove(); },
  };
}

/**
 * 三选：同卡，但本地这份有未保存修改 / 比远端新。
 *
 * @returns 用户的选择；关掉弹窗（× / Esc / 点遮罩）返回 null
 */
export function askDirtyChoice(options: {
  fileName: string;
  reason: string;
}): Promise<DirtyChoiceId | null> {
  return new Promise((resolve) => {
    let settled = false;
    const shell = buildShell('save-guard-dirty', '本地这份和要取回的不一样');
    const finish = (value: DirtyChoiceId | null): void => {
      if (settled) return;
      settled = true;
      shell.close();
      resolve(value);
    };

    shell.body.append(
      el('p', 'field-hint', options.reason),
      el('p', 'field-hint', `要写入的文件：${options.fileName}`),
      el('p', 'field-hint', '「覆盖本地」会丢掉本地这份的修改；「另存为」会多出一个带编号的文件；「查看差异」先看再决定。'),
    );

    const overwrite = el('button', 'btn danger', '覆盖本地');
    overwrite.type = 'button';
    overwrite.dataset['role'] = 'save-guard-overwrite';
    overwrite.addEventListener('click', () => { finish('overwrite'); });

    const saveAs = el('button', 'btn', '另存为');
    saveAs.type = 'button';
    saveAs.dataset['role'] = 'save-guard-save-as';
    saveAs.addEventListener('click', () => { finish('save-as'); });

    const diff = el('button', 'btn', '查看差异');
    diff.type = 'button';
    diff.dataset['role'] = 'save-guard-diff';
    diff.addEventListener('click', () => { finish('diff'); });

    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { finish(null); });

    // 顺序：危险动作在左且被明确标出；查看与取消靠右
    shell.foot.append(overwrite, saveAs, diff, cancel);
  });
}

/**
 * 二选：本地有同名文件，但读不出 cardId（老版本导出的 / 外部导入的 / 不是我们的卡）。
 *
 * 为什么不直接默认"另存"：用户反复取回同一张老卡会堆出 `(2)(3)(4)`，
 * 而他分不清哪个是自己正在用的那份。所以必须问。
 */
export function askUnknownChoice(options: {
  fileName: string;
  reason: string;
}): Promise<'overwrite' | 'save-as' | null> {
  return new Promise((resolve) => {
    let settled = false;
    const shell = buildShell('save-guard-unknown', '本地已有同名文件');
    const finish = (value: 'overwrite' | 'save-as' | null): void => {
      if (settled) return;
      settled = true;
      shell.close();
      resolve(value);
    };

    shell.body.append(
      el('p', 'field-hint', options.reason),
      el('p', 'field-hint', `文件：${options.fileName}`),
    );

    const overwrite = el('button', 'btn danger', '覆盖它');
    overwrite.type = 'button';
    overwrite.dataset['role'] = 'save-guard-overwrite';
    overwrite.addEventListener('click', () => { finish('overwrite'); });

    const saveAs = el('button', 'btn primary', '另存为编号副本');
    saveAs.type = 'button';
    saveAs.dataset['role'] = 'save-guard-save-as';
    saveAs.addEventListener('click', () => { finish('save-as'); });

    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { finish(null); });

    shell.foot.append(overwrite, saveAs, cancel);
  });
}
