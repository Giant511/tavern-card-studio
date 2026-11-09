/**
 * 上传（入仓）时的「配一张封面」步骤（v0.1.7 增补一 第 2 点）。
 *
 * ## 为什么是个两步对话框
 *
 * 需求原话：`选一张卡面（可选）→ [从相册选图] [暂不选，直接推送]`，
 * 而"选图"进去之后还要「压缩预览 → 确认」。两件事必须在**同一个**对话框里
 * 完成，不能先弹一个"要不要选"再弹一个"确认用这张" —— 连着两个模态框
 * 会让用户搞不清自己在第几步，而且中间那个还没法反悔。
 *
 * ## 为什么压缩结论要当场显示
 *
 * 用户挑了一张 4MB 的照片，最终入仓 180KB。这个差距必须**在确认之前**告诉他，
 * 否则他确认之后才发现"怎么变小了"，会怀疑是 bug。
 * 需求指定的格式是 `压缩后约 X KB（原图 Y MB）✓`，这里照抄。
 *
 * ## 为什么允许空手而归
 *
 * "暂不选"是**正常选项**不是取消：无卡面的卡完全合法（推送时走默认卡面兜底）。
 * 所以按钮文案写"暂不选，直接推送"，不写"取消" —— 后者会让人以为整个上传没了。
 */

import { readBinaryFile, pickImageFile } from '../contract/shell.ts';
import { decodeBinaryFile } from '../session/png-source.ts';
import { buildStoreFace, decodeImage } from '../export/face-encode.ts';
import { FACE_SIZE_HINT, formatBytes } from '../export/face-spec.ts';

export interface UploadFaceChoice {
  bytes: Uint8Array;
  mime: 'image/webp' | 'image/png';
  /** 给用户的一句话（压缩结论） */
  note: string;
}

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

/**
 * 问用户要不要给这张卡配封面。
 *
 * @param cardName 角色名（用在标题里，让用户确认是这张卡）
 * @returns 选好并压好的卡面；`null` = 用户选了"暂不选"（或直接关掉）
 */
export function askFaceForUpload(cardName: string): Promise<UploadFaceChoice | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: UploadFaceChoice | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };

    const overlay = el('div', 'modal-overlay modal-overlay-top');
    overlay.dataset['role'] = 'upload-face-step';
    const panel = el('div', 'modal');
    panel.style.maxWidth = '520px';

    const head = el('div', 'modal-head');
    head.append(el('h2', 'modal-title', `给「${cardName}」配一张封面？`));
    const closeBtn = el('button', 'icon-btn', '×');
    closeBtn.type = 'button';
    closeBtn.title = '暂不选，直接推送';
    closeBtn.addEventListener('click', () => { finish(null); });
    head.append(closeBtn);

    const body = el('div', 'modal-body');
    const foot = el('div', 'modal-foot');

    /* ───── 第一阶段：说明 + 两个选择 ───── */
    const intro = el('div');
    intro.append(
      el(
        'p',
        'field-hint',
        '封面可以现在选，也可以之后在「我的卡片」里补。不选的话，推送到 SillyTavern 时会用默认卡面。',
      ),
      /*
       * 兜底提示语（需求原文）。它必须**在选图之前**出现：
       * 用户拿到这句才知道"我这张 3000px 的照片大概行不行"，
       * 否则他要先选一次、被降尺寸、再回来 —— 而他不知道发生了什么。
       */
      el('p', 'field-hint', FACE_SIZE_HINT),
    );

    const pickBtn = el('button', 'btn primary', '从相册选图');
    pickBtn.type = 'button';
    pickBtn.dataset['role'] = 'upload-face-pick';

    const skipBtn = el('button', 'btn', '暂不选，直接推送');
    skipBtn.type = 'button';
    skipBtn.dataset['role'] = 'upload-face-skip';
    skipBtn.addEventListener('click', () => { finish(null); });

    foot.append(pickBtn, skipBtn);
    body.append(intro);
    panel.append(head, body, foot);
    overlay.append(panel);
    document.body.append(overlay);

    /* ───── 第二阶段：选图后的压缩预览 ───── */
    pickBtn.addEventListener('click', () => {
      void (async () => {
        pickBtn.disabled = true;
        skipBtn.disabled = true;
        const originalLabel = pickBtn.textContent;
        pickBtn.textContent = '正在压缩…';
        try {
          const path = await pickImageFile();
          if (path === null) {
            // 用户在系统选图框里取消了：退回第一阶段，不是关掉整个对话框
            pickBtn.disabled = false;
            skipBtn.disabled = false;
            pickBtn.textContent = originalLabel;
            return;
          }

          const file = await readBinaryFile(path);
          const decoded = await decodeBinaryFile(file);
          const fileName = path.split(/[\\/]/).pop() ?? path;
          const image = await decodeImage(decoded.bytes, fileName);

          let built;
          try {
            built = await buildStoreFace(
              image,
              decoded.bytes,
              fileName.toLowerCase().endsWith('.png'),
            );
          } finally {
            image.bitmap.close();
          }

          if (!built.ok || built.bytes === null || built.mime === null) {
            // 压不下去：留在第一阶段并说明原因，让用户换一张
            pickBtn.disabled = false;
            skipBtn.disabled = false;
            pickBtn.textContent = originalLabel;
            intro.append(el('p', 'field-hint', built.note));
            return;
          }

          showPreview(
            {
              bytes: built.bytes,
              mime: built.mime,
              width: built.width,
              height: built.height,
              note: built.note,
              originalBytes: built.originalBytes,
            },
            path,
            fileName,
          );
        } catch (error) {
          pickBtn.disabled = false;
          skipBtn.disabled = false;
          pickBtn.textContent = originalLabel;
          intro.append(
            el('p', 'field-hint', `这张图用不了：${error instanceof Error ? error.message : String(error)}`),
          );
        }
      })();
    });

    function showPreview(
      built: { bytes: Uint8Array; mime: 'image/webp' | 'image/png'; width: number; height: number; note: string; originalBytes: number },
      path: string,
      fileName: string,
    ): void {
      body.replaceChildren();
      foot.replaceChildren();

      const preview = el('div', 'upload-face-preview');
      const thumb = document.createElement('img');
      thumb.className = 'upload-face-thumb';
      thumb.alt = '封面预览';
      /*
       * 用 **data URL**，不能用 `URL.createObjectURL`。
       *
       * Tauri 的 CSP 是 `img-src 'self' data:` —— 白名单里**没有 `blob:`**，
       * 所以 blob URL 会被静默拦掉，`<img>` 渲染成一个破图图标。
       * 实测（2026-10-29 生产反馈）：缩略图位置只有一个坏图标。
       *
       * 为什么不改 CSP 加 `blob:`：那等于给整个渲染层多开一类来源，
       * 而这里只需要显示一张几百 KB 的预览图。`data:` 已经在白名单里。
       */
      thumb.src = toDataUrl(built.bytes, built.mime);
      preview.append(thumb);

      const meta = el('div', 'upload-face-meta');
      meta.append(
        el('div', 'upload-face-name', fileName),
        el('div', 'field-hint', `${String(built.width)}×${String(built.height)} · ${built.mime === 'image/webp' ? 'WebP' : 'PNG（无损）'}`),
        el('div', 'field-hint', `${formatBytes(built.bytes.byteLength)}（原图 ${formatBytes(built.originalBytes)}）`),
      );
      preview.append(meta);
      body.append(preview);

      /*
       * 压缩结论单独一行、用 ok 色：这是用户要"看懂"的那句话，
       * 不能混在上面的元信息里被一视同仁地渲染成灰字。
       */
      const verdict = el('p', 'sync-status ok', built.note);
      verdict.dataset['role'] = 'upload-face-verdict';
      body.append(verdict);

      const useBtn = el('button', 'btn primary', '用这张');
      useBtn.type = 'button';
      useBtn.dataset['role'] = 'upload-face-use';
      useBtn.addEventListener('click', () => {
        finish({ bytes: built.bytes, mime: built.mime, note: built.note });
      });

      const againBtn = el('button', 'btn', '换一张');
      againBtn.type = 'button';
      againBtn.addEventListener('click', () => {
        // 回到第一阶段：直接重新打开选图框
        body.replaceChildren(intro);
        foot.replaceChildren(pickBtn, skipBtn);
        pickBtn.disabled = false;
        skipBtn.disabled = false;
        pickBtn.textContent = '从相册选图';
        pickBtn.click();
      });

      const dropBtn = el('button', 'btn', '暂不选，直接推送');
      dropBtn.type = 'button';
      dropBtn.addEventListener('click', () => {
        finish(null);
      });

      foot.append(useBtn, againBtn, dropBtn);
      // 预览里也要能看出图是从哪来的（用户可能同时选了好几张）
      thumb.title = path;
    }
  });
}

/**
 * 字节 → data URL。
 *
 * 为什么不是 `URL.createObjectURL`：见 `showPreview` 里的注释 —— Tauri 的
 * `img-src` 白名单只有 `'self' data:`，`blob:` 会被静默拦掉。
 *
 * 为什么要分块：`String.fromCharCode(...bytes)` 一次铺 20 万个数会超出
 * 调用栈上限（V8 大约 6 万~12 万）。0x8000 一块是安全且够快的折中。
 */
function toDataUrl(bytes: Uint8Array, mime: string): string {
  const chunk = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
