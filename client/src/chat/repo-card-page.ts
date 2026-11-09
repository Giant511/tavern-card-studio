/**
 * 仓库 → 某仓库 → **某张卡的历史与操作**（第三级，2026-11-06）。
 *
 * ## 用户要求
 *
 * > 点击对应卡片进入卡片历史界面，可以看到卡片的详情，下载、设为最新、
 * > 编辑（做按键入口但是**文字变灰不生效**，这是下个版本的内容）、
 * > 删除、设为最新。
 *
 * ## 为什么从弹窗改成整页
 *
 * 原来是浮在仓库页上的 `.nb-exit-overlay` 弹窗。改成整页有三个实际收益：
 *
 * ```text
 * ① 层级正确：它是"某个仓库里某张卡"的下一级，理应有返回
 * ② 转场复用：整页走 renderPage()，段数 2→3 自动播 push 动画
 * ③ 反馈可见：弹窗盖住了 .nb-topbar，而通知挂在 topbar 里
 *             ⇒ 弹窗内的失败提示**用户根本看不到**（真机确认过）
 * ```
 *
 * 第③条是用户报的第一个问题：
 *
 * > 点完下载没有反馈，用户无法得知具体情况
 *
 * ## 下载为什么要三态
 *
 * 下载是一次网络往返 + 写一个 PNG 文件，慢的时候好几秒。原来只有
 * "按钮变灰"——用户看不出是在下载、卡住了、还是已经成功。
 *
 * ```text
 *   空闲   「下载」
 *   进行中 「下载中…」  禁用（防止连点产生两份）
 *   成功   「已下载 ✓」  绿色，800ms 后复位（用户可以再下一次）
 *   失败   「重试」      红色，**留在原地**让用户能立刻再试
 * ```
 *
 * ★ 失败**不弹窗、不自动消失**：它必须留在按钮上，因为用户的视线在那里。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

export interface RepoVersionRow {
  seq: number;
  commit: string;
  createdAt: string;
  /** `null` = 内容已被清理（prune），下载与回滚都做不了 */
  sha256: string | null;
  message: string;
}

export interface RepoCardPageCallbacks {
  onLoadVersions: () => Promise<RepoVersionRow[]>;
  /** 下载这一版到手机上（导入成一张新卡） */
  onDownload: (seq: number) => Promise<void>;
  /** 把这一版变成仓库里的最新版 */
  onSetLatest: (seq: number) => Promise<void>;
  /** 从仓库删除整张卡（软删除） */
  onDeleteCard: () => Promise<void>;
  onBack: () => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

/**
 * 让一个按钮进入"忙碌 → 成功/失败"的三态循环。
 *
 * 抽出来是因为下载和"设为最新"要做**完全一样**的事，
 * 写两遍必然有一处漏掉复位（那是本项目踩过三次的坑）。
 *
 * @returns 完成时的 Promise。**调用方必须 `.catch()`** ——
 *   失败时会 reject（好让调用方弹通知），不接就是 unhandled rejection。
 */
function runBusy(
  button: ElLike,
  labels: { idle: string; busy: string; done: string; retry: string },
  work: () => Promise<void>,
  options: { doneKind?: 'ok' | 'warn' } = {},
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
      }, 800);
    } catch (error) {
      /*
       * 失败留在原地：文字变「重试」、可点。
       *
       * ★ 这里**不调 onNotify** —— 按钮本身就表达了结果。
       *   只靠通知的问题是它会被遮挡/自动消失（见文件头）。
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

export function renderRepoCardPage(
  doc: DocLike,
  input: {
    cardTitle: string;
    repoName: string;
    versions: RepoVersionRow[] | null;
    error: string;
  },
  callbacks: RepoCardPageCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-repo-card');
  root.setAttribute('data-role', 'repo-card-page');

  const topbar = el(doc, 'div', 'nb-topbar');
  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'repo-card-back');
  back.setAttribute('aria-label', '返回卡片列表');
  back.textContent = '‹';
  back.addEventListener('click', () => callbacks.onBack());

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = input.cardTitle === '' ? '卡片' : input.cardTitle;
  topbar.append(back, title);
  root.append(topbar);

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);
  const list = el(doc, 'div', 'nb-list');
  scroller.append(list);

  /* ── 卡片详情（用户要"可以看到卡片的详情"）── */
  const meta = el(doc, 'div', 'nb-settings-group');
  meta.setAttribute('data-role', 'repo-card-meta');
  meta.textContent =
    input.repoName === '' ? '所属仓库未知' : `所属仓库：${input.repoName}`;
  list.append(meta);

  /* ── 版本列表 ── */
  if (input.versions === null) {
    const wait = el(doc, 'p', 'nb-note');
    wait.setAttribute('data-role', 'repo-versions-loading');
    wait.textContent = input.error === '' ? '正在读取…' : input.error;
    if (input.error !== '') wait.setAttribute('data-kind', 'warn');
    list.append(wait);
  } else if (input.versions.length === 0) {
    const empty = el(doc, 'p', 'nb-note');
    empty.setAttribute('data-role', 'repo-versions-empty');
    empty.textContent = '这张卡还没有任何版本。';
    list.append(empty);
  } else {
    for (const version of input.versions) {
      list.append(renderVersionRow(doc, version, callbacks));
    }
  }

  /* ── 危险操作 ── */
  const actions = el(doc, 'div', 'nb-tag-row');
  const remove = el(doc, 'button', 'nb-btn nb-btn-danger');
  remove.setAttribute('type', 'button');
  remove.setAttribute('data-role', 'repo-card-delete');
  remove.textContent = '从仓库删除这张卡';
  remove.addEventListener('click', () => {
    runBusy(
      remove,
      { idle: '从仓库删除这张卡', busy: '删除中…', done: '已删除', retry: '重试删除' },
      async () => {
        await callbacks.onDeleteCard();
        callbacks.onNotify('已从仓库删除', 'ok');
        /* 删完回上一级 —— 这张卡的页面已经没有意义了 */
        callbacks.onBack();
      },
    ).catch((error: unknown) => {
      callbacks.onNotify(String((error as Error)?.message ?? error), 'danger');
    });
  });
  actions.append(remove);
  list.append(actions);

  return root;
}

/** 一个版本行：信息 + 下载 / 设为最新 / 编辑（灰） */
function renderVersionRow(
  doc: DocLike,
  version: RepoVersionRow,
  callbacks: RepoCardPageCallbacks,
): ElLike {
  const row = el(doc, 'div', 'nb-listitem');
  row.setAttribute('data-role', 'repo-version-item');
  row.setAttribute('data-seq', String(version.seq));

  const main = el(doc, 'span', 'nb-listitem-main');
  const name = el(doc, 'span', 'nb-listitem-title');
  name.textContent = `第 ${String(version.seq)} 版`;
  const sub = el(doc, 'span', 'nb-listitem-sub');
  /*
   * 内容被清理的版本：下载会得到空内容、设为最新会得到空卡。
   * 所以要说清原因，而不是给两个能点但必然失败的按钮。
   */
  sub.textContent =
    version.sha256 === null
      ? '内容已清理，无法下载或设为最新'
      : version.message.trim() === ''
        ? version.createdAt
        : version.message;
  main.append(name, sub);
  row.append(main);

  const rowActions = el(doc, 'div', 'nb-tag-row');
  row.append(rowActions);

  /* 编辑：按用户要求只做入口，**文字变灰不生效**（下个版本的内容） */
  const edit = el(doc, 'button', 'nb-btn');
  edit.setAttribute('type', 'button');
  edit.setAttribute('data-role', 'repo-version-edit');
  edit.setAttribute('data-seq', String(version.seq));
  edit.setAttribute('disabled', 'true');
  /*
   * ★ 用 `aria-disabled` + `title` 说清"为什么点不了"。
   *   只给一个灰按钮，用户会以为是自己操作错了或者软件坏了。
   *   而"下个版本"是用户自己定的原因，如实告诉他最省事。
   */
  edit.setAttribute('aria-disabled', 'true');
  edit.setAttribute('title', '编辑功能下个版本提供');
  edit.textContent = '编辑';
  rowActions.append(edit);

  if (version.sha256 === null) return row;

  const download = el(doc, 'button', 'nb-btn');
  download.setAttribute('type', 'button');
  download.setAttribute('data-role', 'repo-version-download');
  download.setAttribute('data-seq', String(version.seq));
  download.setAttribute('data-state', 'idle');
  download.textContent = '下载';
  download.addEventListener('click', () => {
    runBusy(
      download,
      { idle: '下载', busy: '下载中…', done: '已下载 ✓', retry: '重试' },
      async () => {
        await callbacks.onDownload(version.seq);
        callbacks.onNotify(`已下载第 ${String(version.seq)} 版到手机`, 'ok');
      },
      { doneKind: 'ok' },
    ).catch((error: unknown) => {
      callbacks.onNotify(String((error as Error)?.message ?? error), 'danger');
    });
  });
  rowActions.append(download);

  const latest = el(doc, 'button', 'nb-btn');
  latest.setAttribute('type', 'button');
  latest.setAttribute('data-role', 'repo-version-latest');
  latest.setAttribute('data-seq', String(version.seq));
  latest.setAttribute('data-state', 'idle');
  latest.textContent = '设为最新';
  latest.addEventListener('click', () => {
    runBusy(
      latest,
      { idle: '设为最新', busy: '处理中…', done: '已设为最新 ✓', retry: '重试' },
      async () => {
        await callbacks.onSetLatest(version.seq);
        callbacks.onNotify(`第 ${String(version.seq)} 版已设为最新`, 'ok');
      },
      { doneKind: 'ok' },
    ).catch((error: unknown) => {
      callbacks.onNotify(String((error as Error)?.message ?? error), 'danger');
    });
  });
  rowActions.append(latest);

  return row;
}
