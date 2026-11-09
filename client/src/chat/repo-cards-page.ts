/**
 * 仓库 → **某个仓库里的卡片列表**（第二级，2026-11-06）。
 *
 * ## 用户要求
 *
 * > 登录后按照仓库列表做展示（多仓库的情况下），点击对应仓库可进入卡查看
 * > 界面，也是相同的按照卡列表的方式进行展示，**并且可以展示缩略图头像**
 * > （按照服务端仓库里的展示，如果服务端没有就用兜底缩略图进行展示）。
 *
 * ## 为什么单独一个文件
 *
 * 原来这一页是"一页到底"：服务端配置 + 登录 + 卡片列表全挤在一个滚动区里。
 * 拆成三级之后每级只干一件事：
 *
 * ```text
 *   repo-page.ts        一级：服务端配置 + 登录 + 仓库列表
 *   repo-cards-page.ts  二级：某个仓库的卡片（本文件）
 *   repo-card-page.ts   三级：某张卡的历史与操作
 * ```
 *
 * ★ 三级都走 `renderPage()`，所以转场由 `pageKey()` 的段数自动推导
 *   （1 段 → 2 段 → 3 段），不需要为每一级单独写动画。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

/** 一张卡的展示行（二级用） */
export interface RepoCardRow {
  id: string;
  title: string;
  /** 最新版本号；0 = 还没有版本 */
  seq: number;
  /** 一共几版 */
  versionCount: number;
  updatedAt: string;
  /** 服务端有没有卡面（决定要不要去取缩略图） */
  hasFace: boolean;
}

export interface RepoCardsCallbacks {
  /** 拉这个仓库的卡片 */
  onLoadCards: () => Promise<RepoCardRow[]>;
  /**
   * 取某张卡的缩略图，返回 **data URL**（不是远端地址）。
   *
   * ★ 为什么是 data URL：这个 WebView 里 `<img src="https://…">` 直连
   *   走不通（native-fetch 的 file 头注释里记过：WebView 的网络栈在这个壳里
   *   没通，所以所有请求都过原生通道）。原生通道拿到字节 → base64 →
   *   在这里变成 data URL，`<img>` 才画得出来。
   *
   * 返回 `null` = 服务端没有卡面，**不是错误** —— 调用方退回兜底头像。
   */
  onFace: (cardId: string) => Promise<string | null>;
  /** 点某张卡：进第三级 */
  onOpenCard: (cardId: string, title: string) => void;
  /** 返回上一级 */
  onBack: () => void;
  onNotify: (message: string, kind?: 'info' | 'ok' | 'warn' | 'danger') => void;
}

/** 兜底头像：没有卡面时显示首字（与角色选择器同一套观感） */
function fallbackAvatar(doc: DocLike, title: string): ElLike {
  const box = el(doc, 'span', 'nb-avatar nb-avatar-fallback');
  box.setAttribute('data-role', 'repo-card-face-fallback');
  box.textContent = title.trim() === '' ? '?' : Array.from(title.trim())[0] ?? '?';
  return box;
}

export function renderRepoCardsPage(
  doc: DocLike,
  input: { repoName: string; cards: RepoCardRow[] | null; error: string },
  callbacks: RepoCardsCallbacks,
): ElLike {
  const root = el(doc, 'div', 'nb-page nb-repo-cards');
  root.setAttribute('data-role', 'repo-cards-page');

  const topbar = el(doc, 'div', 'nb-topbar');
  const back = el(doc, 'button', 'nb-icon-btn');
  back.setAttribute('type', 'button');
  back.setAttribute('data-role', 'repo-cards-back');
  back.setAttribute('aria-label', '返回仓库列表');
  back.textContent = '‹';
  back.addEventListener('click', () => callbacks.onBack());

  const title = el(doc, 'h1', 'nb-topbar-title');
  title.textContent = input.repoName === '' ? '仓库' : input.repoName;
  topbar.append(back, title);
  root.append(topbar);

  const scroller = el(doc, 'div', 'nb-scroll');
  root.append(scroller);

  const list = el(doc, 'div', 'nb-list');
  list.setAttribute('data-role', 'repo-cards-list');
  scroller.append(list);

  /* ── 还没拉到数据：占位 ── */
  if (input.cards === null) {
    const wait = el(doc, 'p', 'nb-note');
    wait.setAttribute('data-role', 'repo-cards-loading');
    wait.textContent = input.error === '' ? '正在读取…' : input.error;
    if (input.error !== '') wait.setAttribute('data-kind', 'warn');
    list.append(wait);
    return root;
  }

  if (input.cards.length === 0) {
    const empty = el(doc, 'p', 'nb-note');
    empty.setAttribute('data-role', 'repo-cards-empty');
    empty.textContent = '这个仓库里还没有卡片。';
    list.append(empty);
    return root;
  }

  for (const card of input.cards) {
    const row = el(doc, 'button', 'nb-listitem nb-listitem-with-face');
    row.setAttribute('type', 'button');
    row.setAttribute('data-role', 'repo-card-item');
    row.setAttribute('data-card-id', card.id);

    /*
     * 头像位先放兜底首字 —— **同步就有东西可看**。
     * 服务端有卡面时，异步取回来再换掉（见下面那段）。
     *
     * ★ 用一个**容器**包住兜底与图片，取到后对容器 `replaceChildren`。
     *   不用 `element.replaceWith()`：`ElLike` 没声明它，而为了这一处
     *   去扩接口，所有 DOM stub 都得跟着实现一个用不到的方法 ——
     *   stub 的价值就在于小。
     */
    const faceBox = el(doc, 'span', 'nb-repo-face');
    faceBox.append(fallbackAvatar(doc, card.title));
    row.append(faceBox);

    const main = el(doc, 'span', 'nb-listitem-main');
    const name = el(doc, 'span', 'nb-listitem-title');
    name.textContent = card.title === '' ? card.id : card.title;
    const sub = el(doc, 'span', 'nb-listitem-sub');
    /* 版本信息：有 0 版这种边界（刚建还没推），要说清而不是显示"第 0 版" */
    sub.textContent =
      card.versionCount === 0
        ? '还没有版本'
        : `${String(card.versionCount)} 个版本 · 最新第 ${String(card.seq)} 版`;
    main.append(name, sub);
    row.append(main);

    const arrow = el(doc, 'span', 'nb-src-chevron');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '›';
    row.append(arrow);

    row.addEventListener('click', () => callbacks.onOpenCard(card.id, name.textContent ?? card.id));
    list.append(row);

    /*
     * 有卡面才去取。`hasFace` 是服务端契约给的（`face !== null`）——
     * 没有就不发请求，省掉每张卡一次 404。
     */
    if (!card.hasFace) continue;
    void (async () => {
      let url: string | null = null;
      try {
        url = await callbacks.onFace(card.id);
      } catch {
        /*
         * 取缩略图失败**不打扰用户**：这只是装饰，列表本身是好的。
         * 兜底首字还留在原位，观感不塌。
         * 报错会让人以为"卡片列表出问题了"，那是错的判断。
         */
        return;
      }
      if (url === null) return;

      const img = el(doc, 'img', 'nb-avatar');
      img.setAttribute('data-role', 'repo-card-face');
      img.setAttribute('alt', '');
      img.setAttribute('src', url);
      /* 换掉兜底：对容器整体替换，不会并排出现两个头像 */
      faceBox.replaceChildren(img);
    })();
  }

  return root;
}
