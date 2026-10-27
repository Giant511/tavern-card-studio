/**
 * 卡面选择面板（v0.1.4 / T12.5，需求 F4）。
 *
 * ## 为什么是"导出对话框内的一步"，不是独立弹窗
 *
 * 需求 F4.1：选「PNG 卡」后**弹出卡面选择步骤**。做成独立弹窗会变成
 * "导出 → 关掉 → 又开一个 → 再回来"，中途取消时的状态归属很难说清。
 * 这里就是导出面板里的一个区段：选 PNG 格式时出现，换回 JSON/TXT 时收起，
 * 和格式选择共用同一个"取消 = 整个导出取消"的语义。
 *
 * ## 四类候选（顺序固定，见 `listFaceCandidates`）
 *
 *   · 默认卡面（内置资源，永远可用）
 *   · 当前卡的原图（只有 PNG 导入的卡才有）
 *   · 图库缩略图网格（`<cardsDir>/card-faces`）
 *   · 「浏览选择…」（单次，不入库、不记忆）
 *
 * ## 缩略图为什么要剥掉卡数据块
 *
 * 一张 PNG 卡里可能带着几百 KB 的 base64 正文。直接把完整字节塞进 `<img src>`，
 * 等于让渲染进程为一张 64×64 的缩略图解码并驻留全部数据 —— 图库有 20 张就是
 * 几十 MB。所以缩略图走 `previewDataUrl`（内部 `stripPngCardData`），
 * 而**导出时用的仍是完整字节**。这两件事必须分开，混起来就会出现
 * "导出后卡内容不见了"（因为复用了缩略图那份剥过的字节）。
 */

import type { BinaryFile } from '../contract/types.ts';
import {
  isShellAvailable,
  openFolder,
  pickCardFile,
  readBinaryFile,
  readDefaultFace,
  scanCardsDir,
} from '../contract';
import { joinPath } from '../session/cards-path.ts';
import { previewDataUrl } from '../session/png-source.ts';
import { convertToPng, readImageSize } from './face-convert.ts';
import {
  FACE_EXTENSIONS,
  faceLibraryDir,
  listFaceCandidates,
  needsPngConversion,
  preselectFace,
  sameChoice,
  type FaceCandidate,
  type FaceChoice,
} from './face-library.ts';

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

export interface FacePickerCallbacks {
  /** 当前卡的图库根目录（`<cardsDir>`）；空串表示还没配置 */
  getCardsDir: () => Promise<string>;
  /** 当前卡的原图（PNG 导入才有） */
  getSourceBytes: () => Uint8Array | null;
  /** 选中的卡面变了（导出时要拿它生成 PNG） */
  onChoiceChange: (choice: FaceChoice) => void;
  /** 给用户的一句话（"已把 JPG 转为 PNG"这类） */
  notify: (message: string, kind?: 'ok' | 'warn' | 'bad' | 'info') => void;
  /**
   * **仅截图用的演示数据**（v0.1.4 / T12.5）。
   *
   * 浏览器里（无壳）读不了本地文件，图库必然是空的 —— 那样截图只能证明
   * "空态长什么样"，证明不了网格布局。所以留一个显式注入口：
   *
   *   · 只由 `?faceDemo=` 调试参数提供，正常流程永远返回 `null`；
   *   · 注入的候选在 UI 上**必须**带「演示」角标（见 `renderGrid`），
   *     不能让它看起来像真的读到了磁盘；
   *   · 真正的读盘能力由 `verify:*` 的 live 脚本与契约测试证明，不靠截图。
   *
   * 这条边界写在这里，是因为"为了截图好看而伪造数据"与"演示数据"
   * 之间只差一个标注 —— 没有标注就是伪造。
   *
   * **必须是函数而不是值**：演示数据是在 `start()` 尾部才准备好的，
   * 而回调对象在面板构造时就固定了。写成值会永远拿到构造那一刻的 `null`
   * —— 症状是三张截图里两张字节完全相同。
   */
  getDemoFaces?: () => ReadonlyArray<{ name: string; bytes: Uint8Array }> | null;
  /** 截图用：浏览器里读不到内置默认卡面时的替身（同样是内置那张图） */
  getDemoDefaultBytes?: () => Uint8Array | null;
}

export class FacePicker {
  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly libraryPathEl: HTMLElement;
  private readonly previewBox: HTMLElement;
  private readonly noteEl: HTMLElement;

  private candidates: FaceCandidate[] = [];
  private choice: FaceChoice = { kind: 'default' };
  private libraryDir = '';

  /** 已解码的候选字节（按 choice 键缓存；浏览选择不在其中） */
  private readonly bytesCache = new Map<string, { bytes: Uint8Array; width: number; height: number; note: string }>();

  /**
   * `prepare` 的调用序号（竞态守卫）。
   *
   * 为什么需要：`open('png')` 会调一次 `prepare`（异步，读图库目录），
   * 紧接着 `refreshFaceChoices()` 又调一次。两次并发时，第二次读到的
   * `encodeCurrent()` 是**第一次还没写回**的初始值（`default`）——
   * 于是"有原图该预选原图"变成了"预选默认卡面"，还会把这个错误结果
   * 写进记忆。截图第一版就是这样：原图态的图里选中的是默认卡面。
   *
   * 只有最后发起的那次允许落状态，先发起的一律丢弃。
   */
  private prepareToken = 0;
  /** 上一次 `prepare` 收到的"记忆值"（refresh 在还没真正准备过时要沿用它） */
  private lastRemembered: string | null = null;
  /** 是否已经成功准备过一次（决定 refresh 该沿用"当前选择"还是"记忆值"） */
  private hasPrepared = false;

  constructor(private readonly callbacks: FacePickerCallbacks) {
    this.root = el('section', 'form-section face-section');
    this.root.dataset['role'] = 'face-picker';
    this.root.hidden = true;

    this.root.append(el('h3', 'form-title', '卡面'));

    this.libraryPathEl = el('p', 'field-hint face-library-path');
    this.libraryPathEl.dataset['role'] = 'face-library-path';

    this.grid = el('div', 'face-grid');
    this.grid.dataset['role'] = 'face-grid';

    this.previewBox = el('div', 'face-preview');
    this.previewBox.dataset['role'] = 'face-preview';

    this.noteEl = el('p', 'field-hint face-note');
    this.noteEl.dataset['role'] = 'face-note';

    const actions = el('div', 'field-row');
    const browse = el('button', 'btn small', '浏览选择…');
    browse.type = 'button';
    browse.dataset['role'] = 'face-browse';
    browse.addEventListener('click', () => void this.browse());

    const openLib = el('button', 'btn small ghost', '打开图库目录');
    openLib.type = 'button';
    openLib.dataset['role'] = 'face-open-library';
    openLib.addEventListener('click', () => void this.openLibrary());

    actions.append(browse, openLib);

    const hint = el(
      'p',
      'field-hint',
      '图库目录里的 png / jpg / webp 都会出现在上面（文件名即显示名）。' +
        '把图片拷进该目录即可加入图库；jpg / webp 会在导出时转成 PNG。',
    );

    this.root.append(this.libraryPathEl, this.grid, this.previewBox, actions, this.noteEl, hint);
  }

  /** 当前选择（导出时读它） */
  get currentChoice(): FaceChoice {
    return this.choice;
  }

  /**
   * 打开该区段并准备候选（导出对话框切到 PNG 格式时调用）。
   *
   * `remembered` 是配置里存的上次选择；不可用时按 D4 回落
   * （有原图用原图，否则默认卡面）。
   */
  async prepare(remembered: string | null): Promise<void> {
    const token = (this.prepareToken += 1);
    this.lastRemembered = remembered;
    this.root.hidden = false;
    this.bytesCache.clear();

    let names: string[] = [];
    try {
      const cardsDir = await this.callbacks.getCardsDir();
      if (cardsDir !== '') {
        this.libraryDir = faceLibraryDir(cardsDir);
        const scan = await scanCardsDir(this.libraryDir, 200, [...FACE_EXTENSIONS]);
        names = scan.names;
        this.libraryPathEl.textContent = `图库：${this.libraryDir}（${String(names.length)} 张）`;
      } else {
        this.libraryDir = '';
        this.libraryPathEl.textContent = '图库：尚未配置角色卡目录（设置 → 角色卡目录）';
      }
    } catch (error) {
      this.libraryDir = '';
      this.libraryPathEl.textContent = `图库：读取失败（${error instanceof Error ? error.message : String(error)}）`;
    }

    // 上面有 await：期间可能又发起了一次 prepare，此时本次结果已经过期
    if (token !== this.prepareToken) return;

    /*
     * 演示数据（仅 `?faceDemo=`）：预置候选并把字节放进缓存，
     * 这样 `resolveBytes` 不会真的去读盘。标签上明确写「演示」。
     */
    const demo = this.callbacks.getDemoFaces?.() ?? [];
    if (demo.length > 0) {
      this.bytesCache.clear();
      names = demo.map((item) => item.name);
      for (const item of demo) {
        this.bytesCache.set(`lib:${item.name}`, { bytes: item.bytes, width: 0, height: 0, note: '' });
      }
      this.libraryPathEl.textContent =
        `图库：${this.libraryDir === '' ? '(演示)' : this.libraryDir}（${String(names.length)} 张 · 演示数据）`;
    }

    const hasSource = this.callbacks.getSourceBytes() !== null;
    this.candidates = listFaceCandidates(names, hasSource);
    this.choice = preselectFace(remembered, this.candidates);

    this.renderGrid();
    await this.renderPreview();
    if (token !== this.prepareToken) return;
    this.hasPrepared = true;
    this.callbacks.onChoiceChange(this.choice);
  }

  /** 收起（切回 JSON/TXT 格式时） */
  hide(): void {
    this.root.hidden = true;
  }

  /**
   * 导出对话框每次打开 / 原图变化时刷新。
   *
   * **不能无条件把"当前选择"当记忆值传进去**：在首次 prepare 完成之前，
   * `this.choice` 还是初始的 `default`，拿它当 remembered 会把
   * "有原图该预选原图"（决策 D4）覆盖成默认卡面 —— 而且会顺手把这个
   * 错误结果写进记忆。截图第一版正是这样：原图态的图里选中的是默认卡面。
   *
   * 所以只有**真正准备过**之后，才沿用当前选择；否则沿用上一次收到的记忆值。
   */
  refresh(): void {
    if (this.root.hidden) return;
    void this.prepare(this.hasPrepared ? this.encodeCurrent() : this.lastRemembered);
  }

  private encodeCurrent(): string | null {
    if (this.choice.kind === 'library') return `lib:${this.choice.name}`;
    if (this.choice.kind === 'default') return 'default';
    if (this.choice.kind === 'source') return 'source';
    return null;
  }

  private renderGrid(): void {
    this.grid.replaceChildren();

    for (const candidate of this.candidates) {
      const card = el('button', 'face-card');
      card.type = 'button';
      card.dataset['role'] = 'face-card';
      card.dataset['faceKind'] = candidate.choice.kind;
      if (candidate.choice.kind === 'library') card.dataset['faceName'] = candidate.choice.name;
      card.classList.toggle('is-active', sameChoice(candidate.choice, this.choice));

      /*
       * 演示候选必须自曝身份：截图里看起来像"真的读到了 3 张图"，
       * 而实际是注入的 —— 没有这个角标就是伪造。
       */
      const badge =
        candidate.badge === '' && candidate.choice.kind === 'library' && this.isDemoName(candidate.choice.name)
          ? '演示'
          : candidate.badge;

      const thumb = el('div', 'face-thumb');
      thumb.dataset['role'] = 'face-thumb';
      /*
       * 占位符只放一个省略号：角标已经负责说"默认 / 原图 / 演示"。
       * 第一版把角标文字同时写进占位符，于是渲染成「默认」+「默认卡面默认」
       * —— 同一句话在两处出现，看起来像标签拼错了。
       *
       * 角标必须放进 `thumb` 里（不是 card 下）：它是 `position:absolute`
       * 压在缩略图左上角的，挂在 card 上会跑到卡片外面。
       */
      thumb.append(el('span', 'face-thumb-empty', '…'));
      if (badge !== '') thumb.append(el('span', 'face-badge', badge));
      card.append(thumb, el('span', 'face-name', candidate.label));

      card.addEventListener('click', () => {
        this.choice = candidate.choice;
        for (const other of this.grid.querySelectorAll<HTMLButtonElement>('[data-role="face-card"]')) {
          other.classList.toggle('is-active', other === card);
        }
        this.callbacks.onChoiceChange(this.choice);
        void this.renderPreview();
      });

      this.grid.append(card);
      // 缩略图异步填：不阻塞整个面板，也避免一次性解码 20 张
      void this.fillThumb(thumb, candidate);
    }

    if (this.candidates.length <= 1) {
      this.grid.append(el('p', 'face-empty', '图库里还没有图片。把 png / jpg / webp 放进去即可加入候选。'));
    }
  }

  private async fillThumb(thumb: HTMLElement, candidate: FaceCandidate): Promise<void> {
    try {
      const bytes = await this.resolveBytes(candidate.choice);
      if (bytes === null) return;
      const img = el('img', 'face-thumb-img');
      img.alt = candidate.label;
      // 缩略图用**剥掉卡数据块**的那份，避免为 64px 缩略图驻留几百 KB 正文
      img.src = previewDataUrl(bytes);
      /*
       * 只替换占位符，**不要** `replaceChildren(img)`：那会把已经放进去的
       * 「默认 / 原图 / 演示」角标一起清掉 —— 缩略图读成功后角标就消失了，
       * 而"这是默认卡面"恰恰是缩略图看起来都一样时唯一的区分依据。
       */
      const placeholder = thumb.querySelector('.face-thumb-empty');
      if (placeholder !== null) placeholder.replaceWith(img);
      else thumb.append(img);
    } catch {
      // 单张读不到不影响其它候选（可能刚被删）
    }
  }

  private async renderPreview(): Promise<void> {
    this.previewBox.replaceChildren();
    this.noteEl.textContent = '';

    const candidate = this.candidates.find((item) => sameChoice(item.choice, this.choice));
    if (candidate === undefined) {
      // 浏览选择没有对应的候选卡片
      this.previewBox.append(el('p', 'field-hint', '已选择一次性的图片（不记入图库，也不记忆）'));
      return;
    }

    this.previewBox.append(el('p', 'face-preview-name', candidate.label));
    try {
      const bytes = await this.resolveBytes(candidate.choice);
      if (bytes !== null) {
        const img = el('img', 'face-preview-img');
        img.alt = candidate.label;
        img.src = previewDataUrl(bytes);
        const size = await readImageSize(bytes, candidate.label);
        this.previewBox.append(img);
        this.previewBox.append(
          el(
            'p',
            'field-hint',
            size === null ? `${String(bytes.length)} 字节` : `${String(size.width)}×${String(size.height)} · ${String(bytes.length)} 字节`,
          ),
        );
      }
    } catch (error) {
      this.previewBox.append(
        el('p', 'face-preview-error', `预览失败：${error instanceof Error ? error.message : String(error)}`),
      );
    }

    if (this.choice.kind === 'library' && needsPngConversion(candidate.label)) {
      this.noteEl.textContent = '这张图不是 PNG：导出时会经 canvas 转成 PNG（允许重编码）';
    }
  }

  /**
   * 取某个候选的**完整**字节（导出用这份，不是缩略图那份）。
   *
   * 非 PNG 会在这里就转成 PNG —— 早转的好处是"用户选中时就知道会不会被缩放"，
   * 而不是点完导出才发现尺寸被改了。
   */
  private async resolveBytes(choice: FaceChoice): Promise<Uint8Array | null> {
    const key = this.cacheKey(choice);
    const cached = this.bytesCache.get(key);
    if (cached !== undefined) return cached.bytes;

    let bytes: Uint8Array | null = null;
    let width = 0;
    let height = 0;
    let note = '';

    if (choice.kind === 'default') {
      /*
       * 默认卡面走契约（路径由 Rust 解析）。浏览器里没有壳，`invoke` 不存在，
       * 这一步必然失败 —— 所以先看演示数据，再看能否用壳。
       *
       * 不直接 try/catch 吞掉：真壳里读不到默认卡面是**安装包资源缺失**，
       * 那是要看见的错误，不能静默退化成"没有封面"。
       */
      const demoDefault = this.callbacks.getDemoDefaultBytes?.() ?? null;
      if (demoDefault !== null) {
        bytes = demoDefault;
      } else if (!isShellAvailable()) {
        throw new Error('浏览器模式读不到内置默认卡面（没有壳能力）——请在桌面客户端里导出 PNG');
      } else {
        const binary = await readDefaultFace();
        bytes = await decode(binary);
      }
    } else if (choice.kind === 'source') {
      bytes = this.callbacks.getSourceBytes();
      if (bytes !== null) {
        const size = await readImageSize(bytes, 'source.png');
        width = size?.width ?? 0;
        height = size?.height ?? 0;
      }
    } else if (choice.kind === 'library') {
      const binary = await readBinaryFile(joinPath(this.libraryDir, choice.name));
      const raw = await decode(binary);
      if (needsPngConversion(choice.name)) {
        const converted = await convertToPng(raw, choice.name);
        bytes = converted.bytes;
        width = converted.width;
        height = converted.height;
        note = converted.note;
        this.noteEl.textContent = note;
      } else {
        bytes = raw;
        const size = await readImageSize(raw, choice.name);
        width = size?.width ?? 0;
        height = size?.height ?? 0;
      }
    } else {
      const binary = await readBinaryFile(choice.path);
      const raw = await decode(binary);
      const name = choice.path.replace(/^.*[\\/]/, '');
      if (needsPngConversion(name)) {
        const converted = await convertToPng(raw, name);
        bytes = converted.bytes;
        width = converted.width;
        height = converted.height;
        note = converted.note;
        this.noteEl.textContent = note;
      } else {
        bytes = raw;
        const size = await readImageSize(raw, name);
        width = size?.width ?? 0;
        height = size?.height ?? 0;
      }
    }

    if (bytes === null) return null;
    this.bytesCache.set(key, { bytes, width, height, note });
    return bytes;
  }

  private cacheKey(choice: FaceChoice): string {
    if (choice.kind === 'library') return `lib:${choice.name}`;
    if (choice.kind === 'browse') return `browse:${choice.path}`;
    return choice.kind;
  }

  /** 这个名字是不是演示注入的（决定要不要打「演示」角标） */
  private isDemoName(name: string): boolean {
    return (this.callbacks.getDemoFaces?.() ?? []).some((item) => item.name === name);
  }

  /** 导出真正要用的字节（含非 PNG 转码）。导出对话框在点「导出」时调它 */
  async resolveForExport(): Promise<Uint8Array> {
    const bytes = await this.resolveBytes(this.choice);
    if (bytes === null) {
      throw new Error('卡面读取失败：请重新选择一张图');
    }
    return bytes;
  }

  private async browse(): Promise<void> {
    if (!isShellAvailable()) {
      this.callbacks.notify('浏览器模式无法浏览本地文件：请在桌面客户端里导出 PNG', 'warn');
      return;
    }
    try {
      const path = await pickCardFile(this.libraryDir === '' ? undefined : this.libraryDir, {
        allowText: false,
        allowImages: true,
      });
      if (path === null) return;

      const name = path.replace(/^.*[\\/]/, '');
      if (!FACE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(`.${ext}`))) {
        this.callbacks.notify(`不支持的图片格式：${name}（只接受 png / jpg / webp）`, 'warn');
        return;
      }

      this.choice = { kind: 'browse', path };
      for (const other of this.grid.querySelectorAll<HTMLButtonElement>('[data-role="face-card"]')) {
        other.classList.remove('is-active');
      }
      this.callbacks.onChoiceChange(this.choice);

      // 立刻预览 + 必要时转码（让"会被缩放"这件事在选择时就暴露）
      const bytes = await this.resolveBytes(this.choice);
      this.previewBox.replaceChildren(el('p', 'face-preview-name', name));
      if (bytes !== null) {
        const img = el('img', 'face-preview-img');
        img.alt = name;
        img.src = previewDataUrl(bytes);
        const size = await readImageSize(bytes, name);
        this.previewBox.append(
          img,
          el(
            'p',
            'field-hint',
            size === null
              ? `${String(bytes.length)} 字节`
              : `${String(size.width)}×${String(size.height)} · ${String(bytes.length)} 字节`,
          ),
        );
        if (this.noteEl.textContent === '' && needsPngConversion(name)) {
          this.noteEl.textContent = `${name} 不是 PNG：导出时会经 canvas 转成 PNG`;
        }
      }
      this.callbacks.notify(
        `已选择 ${name}（一次性使用，不加入图库、不记忆）`,
        'info',
      );
    } catch (error) {
      this.callbacks.notify(
        `选择卡面失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }

  private async openLibrary(): Promise<void> {
    if (!isShellAvailable()) {
      this.callbacks.notify('浏览器模式无法打开本地目录', 'warn');
      return;
    }
    if (this.libraryDir === '') {
      this.callbacks.notify('还没配置角色卡目录：请先在「设置 → 角色卡目录」里设置', 'warn');
      return;
    }
    try {
      /*
       * 目录不存在时先创建：需求 F5 要求"首次使用时自动创建"。
       * 用 probeCardsDir 而不是自己拼 fs 调用 —— 那是唯一能创建目录的契约能力。
       */
      await ensureDirectory(this.libraryDir);
      await openFolder(this.libraryDir);
    } catch (error) {
      this.callbacks.notify(
        `打开图库目录失败：${error instanceof Error ? error.message : String(error)}`,
        'bad',
      );
    }
  }
}

/** 复用的 base64 解码（带长度自检）；这里不校验 sha256 —— 那是导入路径的事 */
async function decode(binary: BinaryFile): Promise<Uint8Array> {
  const clean = binary.base64.replace(/\s/g, '');
  const raw = atob(clean);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  if (bytes.length !== binary.bytesLen) {
    throw new Error(`读取字节数与声明不符（${String(binary.bytesLen)} vs ${String(bytes.length)}）`);
  }
  return bytes;
}

/** 目录不存在则创建（`probeCardsDir` 是契约里唯一的创建入口） */
async function ensureDirectory(path: string): Promise<void> {
  const { probeCardsDir } = await import('../contract');
  const probe = await probeCardsDir(path, { create: true });
  if (!probe.writable) {
    throw new Error(probe.reason ?? '目录不可写');
  }
}
