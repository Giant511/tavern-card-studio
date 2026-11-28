/**
 * 功能
 * 两个确认对话框（关闭未保存的卡、覆盖同名文件）与 ST 角色库目录定位。
 * 从 EditorApp 搬出，3 个函数 110 行。
 *
 * 注意事项
 * 三个函数不读任何编辑器状态，也**不需要 host 参数** —— 它们只用全局 `document`
 * 和外部函数。这是能干净搬出来的原因，也让调用方少一层传参。
 *
 * `confirmClose` 返回三态（save / discard / cancel）而不是布尔：
 * 「取消」与「不保存」是两件事，压成布尔会让用户误以为点了取消也丢了修改。
 *
 * 踩过的坑
 * 这两个对话框原来各自 new 一套 overlay DOM。合并时要注意它们共用
 * `modal-overlay` / `confirm-close-modal` 两个类名 —— 样式是同一份，
 * 改样式会同时影响两处。
 */

import {
  configGet,
  findStCandidates,
  isShellAvailable,
  probePaths,
  readTextExact,
} from '../contract';
import type { CardSession } from '../session/card-session';
import { locateSt } from '../session/st-install';

import { el } from './dom';


export async function locateStCharactersDir(): Promise<{ dir: string } | { error: string }> {
  if (!isShellAvailable()) {
    return { error: '推送需要桌面客户端（浏览器模式没有写本机目录的能力）' };
  }
  const located = await locateSt({
    findCandidates: () => findStCandidates(),
    readConfig: async () => {
      const config = await configGet();
      return { stPath: config.stPath, stAddress: config.stAddress };
    },
    probePaths: (paths) => probePaths(paths),
    readText: (path, maxBytes) => readTextExact(path, maxBytes),
  });
  if (located.chosen === null) {
    return {
      error: '没找到本地 SillyTavern：先点面板底部的「安装 / 启动向导」指定它的位置',
    };
  }
  return { dir: located.chosen.charactersDir };
}

export function confirmClose(session: CardSession): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const panel = el('div', 'modal confirm-close-modal');
    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', '有未保存的修改'));
    const body = el('div', 'modal-body');
    body.append(
      el(
        'p',
        'confirm-text',
        `「${session.displayName}」有尚未保存到磁盘的修改。关闭前要保存吗？`,
      ),
    );
    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    const discard = el('button', 'btn', '不保存关闭');
    discard.type = 'button';
    const save = el('button', 'btn primary', '保存并关闭');
    save.type = 'button';
    foot.append(cancel, discard, save);
    panel.append(head, body, foot);
    overlay.append(panel);
    document.body.append(overlay);

    const finish = (value: 'save' | 'discard' | 'cancel'): void => {
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish('cancel'));
    discard.addEventListener('click', () => finish('discard'));
    save.addEventListener('click', () => finish('save'));
  // 点遮罩**不关闭**（2026-10-29 用户要求）：子窗口只能由它自己的按钮或 × 关闭。
  // 去掉这条监听是有意的，不是漏了 —— 误触空白处关掉正在填的表单比多点一次 × 更烦。
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && overlay.isConnected) {
          event.preventDefault();
          finish('cancel');
        }
      },
      { once: true },
    );
    save.focus();
  });
}

export function confirmOverwrite(targetName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const panel = el('div', 'modal confirm-close-modal');
    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', '要覆盖同名卡吗'));
    const body = el('div', 'modal-body');
    body.append(
      el(
        'p',
        'confirm-text',
        `已打开「${targetName}」这张卡，而它还有未保存到磁盘的修改。` +
          '继续打开会用文件里的内容整张替换它，那些修改会丢失。',
      ),
    );
    const foot = el('div', 'modal-foot');
    const cancel = el('button', 'btn', '取消');
    cancel.type = 'button';
    const overwrite = el('button', 'btn primary', '覆盖');
    overwrite.type = 'button';
    foot.append(cancel, overwrite);
    panel.append(head, body, foot);
    overlay.append(panel);
    document.body.append(overlay);

    const finish = (value: boolean): void => {
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(false));
    overwrite.addEventListener('click', () => finish(true));
    // 与 confirmClose 同一条规矩：点遮罩不关闭，只有按钮或 Esc
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && overlay.isConnected) {
          event.preventDefault();
          finish(false);
        }
      },
      { once: true },
    );
    cancel.focus();
  });
}