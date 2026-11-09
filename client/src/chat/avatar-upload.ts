/**
 * 人设头像上传（2026-11-04，用户要求「支持上传更改显示人设缩略图」）。
 *
 * ## 为什么用 `<input type="file">` 而不是原生 SAF
 *
 * 这个壳里 `<input type="file">` **是可用的** —— Tauri 生成的
 * `RustWebChromeClient` 实现了 `onShowFileChooser`（真机验证过：
 * 点击会拉起系统文件选择器）。所以不必为此再加第 7 个桥方法，
 * 也不必碰 Android 的 Activity 结果回调。
 *
 * ## 为什么必须缩到 96×96
 *
 * 人设状态存在 **localStorage**，配额约 5 MB。用户随手拍的截图可能
 * 3–5 MB，一张就能把整个状态写爆（写爆的后果是**所有人设一起丢**）。
 * 缩到 96×96 的 JPEG 只有几 KB，而且头像显示尺寸本来就只有 44px
 * （3 倍屏也只要 132px）。
 *
 * ## 为什么用 canvas 而不是把原图直接存进去
 *
 * 同上。另外 `toDataURL('image/jpeg', q)` 在 WebView 里一定可用，
 * 不依赖 `CompressionStream` / OffscreenCanvas 这些不一定有的东西。
 */

/** 头像边长（CSS px）。44px 的显示尺寸 × 2 倍屏 ≈ 88，取 96 留余量 */
export const AVATAR_PX = 96;

/** JPEG 质量。头像这么小，0.85 肉眼看不出差别，体积只有 PNG 的三分之一 */
export const AVATAR_QUALITY = 0.85;

/** 把文件读成 data URL（`FileReader`；失败时 reject 原始错误） */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/** 把图片元素画到正方形画布上，返回 data URL（JPEG） */
function drawSquare(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('这台设备无法处理图片');

  /*
   * 居中裁成正方形再缩放。
   *
   * 直接 `drawImage(img, 0, 0, PX, PX)` 会把竖图**压扁**成椭圆脸 ——
   * 与 CSS 那边 `object-fit: cover` 要表达的是同一件事，这里要在
   * 像素层面先做掉，否则存进去的就是一张变形的图。
   */
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;

  /* 先铺一层底色：透明 PNG 转 JPEG 后透明区会变黑 */
  ctx.fillStyle = '#3a3a42';
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);

  return canvas.toDataURL('image/jpeg', AVATAR_QUALITY);
}

/**
 * 弹系统文件选择器，让用户挑一张图，返回缩小后的 data URL。
 *
 * 用户取消返回 `null`（不是错误）。
 *
 * ## 为什么 input 要挂到 DOM 上再点
 *
 * 部分 WebView 对"未插入文档的 input 触发 click"不响应（
 * 元素不在文档里时，浏览器认为它不可见，`click()` 被丢弃）。
 * 所以挂成一个不可见的 fixed 元素，用完立刻摘掉。
 */
export async function pickAvatarDataUrl(): Promise<string | null> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  /* 不加 capture：让用户能选相册里已有的图，而不是直接开相机 */
  input.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;');
  document.body.append(input);

  try {
    const file = await new Promise<File | null>((resolve) => {
      let settled = false;
      const finish = (value: File | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
      /*
       * 取消时某些 WebView 不发 `change` 也不发 `cancel` ——
       * 那这个 Promise 会永远挂着，把调用方的按钮永久禁用。
       *
       * 监听 `cancel`（新规范），并在 60 秒后兜底 resolve(null)：
       * 用户就算什么都不做，按钮也不会永远点不动。
       */
      input.addEventListener('cancel', () => finish(null), { once: true });
      globalThis.setTimeout(() => finish(null), 60_000);
      input.click();
    });

    if (file === null) return null;

    const dataUrl = await readAsDataUrl(file);
    if (dataUrl === '') return null;

    /* 解码一次拿到尺寸（同时验证"这真是一张图"） */
    const img = await loadImage(dataUrl);
    if (img === null) throw new Error('这个文件不是图片');
    return drawSquare(img);
  } finally {
    input.remove();
  }
}

/** 加载图片元素；失败返回 null（不抛 —— 调用方要按"不是图片"处理） */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
