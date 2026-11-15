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

/**
 * 卡片缩略图缓存：`仓库名/卡 id` → 内容指纹 + data URL。
 *
 * ## 为什么要有（2026-11-11，用户报的）
 *
 * > 卡片的缩略图在每次进仓库界面都要请求一次进行加载，我的建议是和仓库
 * > 里面的卡片背景对比一下，如果不一样再进行替换
 *
 * 原来每进一次界面、每张有卡面的卡都发一次二进制请求。一个几十张卡的
 * 仓库，来回切两次 Tab 就是上百次下载 —— 而图一次都没变。
 *
 * ## 为什么放模块级而不是外壳字段
 *
 * 外壳字段在切仓库/退出页面时会被清，而这里的价值恰恰是**跨渲染复用**。
 * 缓存键带了仓库名，所以换仓库不会串图。
 *
 * ★ 但**不跨进程**：App 重启就没了。这是刻意的 —— 图是装饰性的，
 *   为它做持久化（localStorage 塞几百 KB base64）不划算，而且
 *   localStorage 有 5MB 上限，塞满会把别的配置挤掉。
 *
 * ## 为什么不担心内存
 *
 * 缩略图是服务端压过的（`X-TCS-Size` 很小），几十张也就几 MB。
 * 仍设了上限：超出按插入顺序淘汰最旧的（Map 的迭代顺序就是插入顺序）。
 */
const repoFaceCache = new Map<string, { sha256: string; url: string }>();

/** 缓存条目上限（张）。超出淘汰最早插入的那批。 */
const REPO_FACE_CACHE_LIMIT = 240;

function rememberFace(cacheKey: string, sha256: string, url: string): void {
  /*
   * 先删再设：同一个键再写入时要**移到队尾**，否则它会按"最早插入"被淘汰
   * —— 而它其实刚刚才用过。
   */
  repoFaceCache.delete(cacheKey);
  repoFaceCache.set(cacheKey, { sha256, url });
  while (repoFaceCache.size > REPO_FACE_CACHE_LIMIT) {
    const oldest = repoFaceCache.keys().next();
    if (oldest.done === true) break;
    repoFaceCache.delete(oldest.value);
  }
}

/** 把缩略图画进容器（整体替换，不会并排出现两个头像） */
function paintFace(faceBox: ElLike, doc: DocLike, url: string): void {
  const img = el(doc, 'img', 'nb-avatar');
  img.setAttribute('data-role', 'repo-card-face');
  img.setAttribute('alt', '');
  img.setAttribute('src', url);
  faceBox.replaceChildren(img);
}

/**
 * 清掉某个仓库的缩略图缓存（下载/上传后图可能变了）。
 *
 * 不给参数时全清 —— 换账号、换仓库地址这类场景用。
 *
 * ★ 其实不必在下载后清：下次渲染比对 `faceSha256` 就会自己发现图变了。
 *   但"用户刚上传了新卡面，回来却还看到旧的"这种观感问题，
 *   靠被动比对要等一次列表刷新。主动清一下更符合预期。
 */
export function clearRepoFaceCache(repoName?: string): void {
  if (repoName === undefined) {
    repoFaceCache.clear();
    return;
  }
  const prefix = `${repoName}/`;
  for (const key of [...repoFaceCache.keys()]) {
    if (key.startsWith(prefix)) repoFaceCache.delete(key);
  }
}

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
  /**
   * 卡面的内容指纹（服务端 `face.sha256`），没有卡面时为 null。
   *
   * ## 为什么缩略图缓存要用它当键（2026-11-11，用户要求）
   *
   * 用户：
   *
   * > 卡片的缩略图在每次进仓库界面都要请求一次进行加载，我的建议是和仓库
   * > 里面的卡片背景对比一下，如果不一样再进行替换
   *
   * 原来每次渲染列表都会为**每张有卡面的卡**发一次请求 —— 进一次界面
   * 几十张卡就是几十次二进制下载，而绝大多数时候图根本没变。
   *
   * 比对什么很关键：
   *
   * ```text
   *   card.updatedAt   ✗ 改标题也会变，导致白拉一次图
   *   card.seq         ✗ 改设定也会涨版本号
   *   face.sha256      ✓ 只有图变了才变 —— 正是"背景有没有换"的判据
   * ```
   */
  faceSha256: string | null;
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

    const cacheKey = `${input.repoName}/${card.id}`;
    const cached = repoFaceCache.get(cacheKey);
    /*
     * 命中条件：**同一张图**（sha256 相同）。
     *
     * 命中就直接画，一个请求都不发 —— 这是"每次进界面都重新拉"的解药。
     * 图换了（sha 变了）就往下走正常的取图流程，取到后覆盖缓存。
     */
    if (card.faceSha256 !== null && cached !== undefined && cached.sha256 === card.faceSha256) {
      paintFace(faceBox, doc, cached.url);
      continue;
    }

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

      /*
       * 取到才写缓存。失败不写 —— 写个空的会让下次误以为"已经是最新的"，
       * 那张卡就永远不重试了。
       */
      if (card.faceSha256 !== null) {
        rememberFace(cacheKey, card.faceSha256, url);
      }
      paintFace(faceBox, doc, url);
    })();
  }

  return root;
}
