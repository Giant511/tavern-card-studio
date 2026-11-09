/**
 * 圆形角色头像（2026-11-04，用户要求「最好圆形的，类似于头像的感觉」）。
 *
 * ## 为什么单独一个模块
 *
 * 仓库页的「选择要上传的卡片」、角色选择器、以及后面的卡片列表都要用同一个东西。
 * 三处各写一份样式，迟早一处圆一处方、一处 40px 一处 44px。
 *
 * ## 为什么不只是 `border-radius: 50%`
 *
 * 头像图来自卡片的封面，**比例不一定是方的**（768×1024 的常见）。
 * 只写 `border-radius: 50%` 会把长方形直接切成椭圆 —— 本项目踩过
 * 一次同类问题（`.nb-input` 的 pill 圆角用在 textarea 上画成了椭圆）。
 *
 * 必须 `object-fit: cover` + 固定宽高，让图片**裁切填满**那个正方形，
 * 再对正方形做 50% 圆角。
 *
 * ## 为什么用 data URL
 *
 * 这个壳里 `<img>` 直连回环地址不可用（与 `fetch` 同一个根因，见 §104/§106.8），
 * 缩略图只能走桥读字节转 base64。取图逻辑在 `thumbnail.ts`，这里只管画。
 */

import { el, type DocLike, type ElLike } from './chat-view.ts';

/** 头像直径（CSS 变量，改一处全动） */
export const AVATAR_SIZE_VAR = '--nb-avatar-size';

export interface AvatarOptions {
  /** 角色文件名（含 .png）—— 取图用 */
  avatar: string;
  /** 显示名，用作 `alt` */
  name: string;
  /** 取图函数；返回 null 表示没有图 */
  load: (avatar: string) => Promise<string | null>;
  /** 直径像素值，默认 40 */
  size?: number;
}

/**
 * 造一个圆形头像节点。
 *
 * 图**异步**填：先画一个带首字的占位圆（列表立刻成型），图到了再换。
 * 不这么做的话，20 张卡要等 20 次跨 JNI 往返才有第一帧 ——
 * 用户看到的是"点了没反应"。
 */
export function makeAvatar(doc: DocLike, options: AvatarOptions): ElLike {
  const box = el(doc, 'span', 'nb-avatar');
  box.setAttribute('data-role', 'avatar');
  box.setAttribute('data-avatar', options.avatar);
  box.setAttribute('data-state', 'loading');
  if (options.size !== undefined) {
    box.style.setProperty(AVATAR_SIZE_VAR, `${String(options.size)}px`);
  }

  /*
   * 占位：名字的第一个字符。
   *
   * 用首字而不是一个通用图标 —— 扫列表时首字比图标更能帮人定位
   * （"夜"和"林"一眼分得开，两个一样的灰圆分不开）。
   *
   * 空名字时退回一个中性字形，不留一个空白圈。
   */
  const first = Array.from(options.name.trim())[0] ?? '·';
  box.textContent = first;

  void (async () => {
    let src: string | null = null;
    try {
      src = await options.load(options.avatar);
    } catch {
      src = null;
    }

    /*
     * 图没取到就把占位留下来，标记成 `empty` 让 CSS 换个颜色。
     * **不画破图图标** —— 那看起来像坏了，而实际只是这张卡没设封面。
     *
     * ## ★ 失败要**自己重试几次**（2026-11-04 真机）
     *
     * 真机现象：列表刚打开时第一张卡只有首字圆、第二张有头像；
     * 而两张用桥单独取都是 200。真因是**首次取图时引擎还没就绪**
     * （面板渲染早于 `status().ready`），那一次失败之后如果没有重试，
     * 这张卡就一直是占位圆 —— 用户会以为这张卡没有封面。
     *
     * 间隔 600/1500/3000ms，共 3 次：覆盖引擎从"起了进程"到"能应答"的窗口。
     * 三次都失败就是真的没有封面（404），那时再标 `empty`。
     */
    for (const [attempt, delay] of [600, 1500, 3000].entries()) {
      await new Promise((resolve) => {
        globalThis.setTimeout(resolve, delay);
      });
      /*
       * 页面已重画时这个节点已经不在文档里（§86：元素在 ≠ 在 document 里）。
       * `ElLike` 没声明 `isConnected`（Node 里的 stub 也没有），
       * 用可选读取 —— 拿不到就当"还在"，最坏只是多一次无害的取图。
       */
      const connected = (box as unknown as { isConnected?: boolean }).isConnected;
      if (connected === false) return;
      try {
        src = await options.load(options.avatar);
      } catch {
        src = null;
      }
      if (src !== null) break;
      void attempt;
    }

    if (src === null) {
      box.setAttribute('data-state', 'empty');
      return;
    }

    const img = el(doc, 'img', 'nb-avatar-img');
    img.setAttribute('alt', options.name);
    img.setAttribute('src', src);
    box.replaceChildren(img);
    box.setAttribute('data-state', 'ready');
  })();

  return box;
}
