/**
 * 功能
 * 卡片的保存管线：选格式 → 解析卡面 → 规划落点 → 撞名守卫 → 原子写 → 记基线。
 * 从 EditorApp 搬出，6 个函数 239 行。
 *
 * 注意事项
 * `saveSessionToDisk` 是**唯一**的落盘入口，`saveCard` 只是它的薄封装。
 * 新加保存路径请走这里 —— 绕过就拿不到 sha256 校验与撞名守卫。
 *
 * `savePngWithGuard` 的 `isOpenInTab` / `isDirty` 读**全部已开会话**，
 * 不是当前那一个：判断"这个文件正被别的标签页占着"必须看全集。
 *
 * 状态留壳：`session` / `sessions` / `hasSession` / `rules` / `lastFaceChoice` /
 * `saveFormatDialog`。它们同时被标签页、导出、提示词面板读写。
 *
 * 踩过的坑
 * 写完必须真去 `statFile` 一次记基线，不能拿"当前时间"顶替：文件系统写的
 * mtime 与我们这边的时间可能差几百毫秒（同步盘上尤其明显）。拿当前时间记，
 * 下次判定会得到 `fileMtime < baseline` ⇒ 永远判不脏 ⇒ 这层保护静默失效。
 */

import type { CardSession } from '../session/card-session';
import type { WriteReceipt } from '../contract/types';
import type { ResolvedSaveFace } from '../session/save-face';
import type { GreetingFormatParams, TxtPreset } from '@tcs/shared';
import { parsePngCard } from '@tcs/shared';
import { SaveFormatDialog, type SaveFormatDialogResult } from '../session/save-format-dialog';

import {
  configGet,
  configPatch,
  pickSavePath,
  readBinaryFile,
  scanCardsDir,
  statFile,
  writeBinaryFileAtomic,
  writeFileAtomic,
} from '../contract';
import { buildExportAsync } from '../export/export-card';
import { decodeBinaryFile } from '../session/png-source';
import { joinPath } from '../session/cards-path';
import { effectiveCardsDir, suggestCardFileName } from '../session/cards-dir';
import {
  defaultSaveFaceDeps,
  resolveSaveFace as resolveSaveFaceCore,
} from '../session/save-face';
import { saveFormatNote, saveFormatOption, withSaveExtension } from '../session/save-format';
import { askDirtyChoice, askUnknownChoice } from '../sync/save-guard-dialog';
import { getBaseline, isNewerThanBaseline, recordBaseline } from '../sync/file-baseline';
import { saveTargetWithGuard } from '../sync/save-target-guard';
import { bytesToBase64 } from '../chat/share-card';
import { describeError, readCardIdFromCardJson } from './error-text';

/**
 * 功能
 * 本模块能碰的编辑器状态与动作。
 *
 * 注意事项
 * 6 个字段里 4 个与会话相关（`session` / `sessions` / `hasSession` / `rules`）：
 * 它们是编辑器的核心状态，保存管线只读不拥有。
 * 5 个方法都是界面反馈（状态栏、标签栏、卡名），不涉及业务逻辑。
 *
 * 踩过的坑
 * 无。
 */
export interface SaveHost {
  /** 当前会话。null = 没打开任何卡 */
  readonly session: CardSession | null;
  /** 全部已开会话（撞名守卫要判"这文件被别的标签占着没"） */
  readonly sessions: readonly CardSession[];
  /** 有没有打开会话 */
  readonly hasSession: boolean;
  /** 当前规则选择（导出时要带进产物） */
  readonly rules: { preset: unknown } | null;
  /** 上次选的卡面来源，用于「记住上次选择」 */
  lastFaceChoice: string | null;
  /** 保存格式对话框实例（懒建） */
  saveFormatDialog: SaveFormatDialog | null;

  /** 状态栏一行话 */
  setStatus(message: string, kind: 'info' | 'ok' | 'warn' | 'bad'): void;
  refreshTabs(): void;
  renderCardName(): void;
  /** 开场白格式（导出参数）。`format` 是结构化参数，不是字符串 */
  greetingFormat(): { format: GreetingFormatParams };
  /** 对话示例格式（导出参数）。同样返回结构化参数 */
  chatExamplesFormat(): GreetingFormatParams;
}

export async function previewSaveFormatDialog(host: SaveHost, forcePngDisabled = false): Promise<void> {
  if (!host.saveFormatDialog) host.saveFormatDialog = new SaveFormatDialog();
  const result = await host.saveFormatDialog.open({
    defaultFormat: host.session?.saveFormat ?? 'json',
    pngAvailable: !forcePngDisabled,
    ...(forcePngDisabled
      ? { pngUnavailableReason: '浏览器模式读不到卡面 —— 请在桌面客户端里另存为 PNG' }
      : {}),
  });
  if (result !== null) {
    host.setStatus(
      `已选择 ${saveFormatOption(result.format).label}${result.remember ? '（并记住此格式）' : ''}`,
      'ok',
    );
  }
}

export async function saveSessionToDisk(host: SaveHost, session: CardSession): Promise<boolean> {
  try {
    const choice = await askSaveFormat(host, session);
    if (choice === null) return false;
    if (choice.remember) session.setSaveFormat(choice.format);

    // PNG 需要卡面：先解析（失败要在弹保存对话框**之前**说，否则用户填完路径才失败）
    const face = choice.format === 'png' ? await resolveSaveFace(host, ) : null;

    // 默认落点 = cardsDir（F4）；文件名取角色名并按格式换扩展名，重名自动追加序号
    const dir = await effectiveCardsDir();
    const suggestedBase = await suggestCardFileName(session.card.meta.name, dir);
    /*
     * `let` 而不是 `const`：撞名守卫可能把落点改到「另存」的编号副本上
     * （异卡撞名 / 用户在脏三选里选另存），后续 markSaved 必须记实际路径。
     */
    let target = await pickSavePath(
      withSaveExtension(suggestedBase, choice.format),
      choice.format,
      dir === '' ? undefined : dir,
    );
    if (!target) return false;

    const artifact = await buildExportAsync(
      session.card,
      (host.rules?.preset ?? null) as TxtPreset | null,
      choice.format,
      host.greetingFormat().format,
      face?.bytes,
      host.chatExamplesFormat(),
    );

    // PNG 是二进制：走二进制写；文本两种格式走文本写。
    // 两条都带 sha256 断言（壳写后回读重算，不一致就报错）。
    let receipt;
    if (artifact.format === 'png') {
      /*
       * 写盘前过一道"同名撞名"守卫（v0.1.7 增补三）。
       *
       * 系统保存对话框已经问过一次"要覆盖吗"，但它**只知道重名、
       * 不知道身份**：用户手选了一个已有的 `西奥.png`，而那可能是另一张卡 ——
       * 覆盖掉就等于毁了别人的文件，且没有任何提示。
       * 这里按 PNG 里嵌的 `extensions.tcs.cardId` 判身份，五种情况分别处理。
       */
      const guarded = await savePngWithGuard(host, target, artifact.png, session);
      if (guarded === null) return false; // 用户在三选里取消了
      if (guarded.receipt === null) {
        // 没落盘（查看差异 / 标签占用）：已经给过提示，不要伪装成保存成功
        host.setStatus(
          guarded.note === '' ? '这次没有写入文件' : guarded.note,
          'warn',
        );
        return false;
      }
      receipt = guarded.receipt;
      if (guarded.path !== target) {
        // 另存了：后续 markSaved 必须记实际路径，否则下次保存还往旧路径写
        target = guarded.path;
      }
      if (guarded.note !== '') host.setStatus(guarded.note, 'info');
    } else {
      receipt = await writeFileAtomic(target, artifact.text, artifact.sha256);
    }

    session.markSaved(target);
    session.setSaveFormat(choice.format);
    host.refreshTabs();
    host.renderCardName();

    const notes: string[] = [];
    if (face !== null && face.note !== '') notes.push(face.note);
    if (face !== null) {
      notes.push(
        face.from === 'source'
          ? '卡面用本卡原图（像素未重编码）'
          : face.from === 'library'
            ? `卡面用图库：${face.fileName ?? '(未知)'}`
            : '卡面用内置默认图',
      );
    }
    const followUp = saveFormatNote(choice.format);
    if (followUp !== '') notes.push(followUp);

    host.setStatus(
      `已保存（${saveFormatOption(choice.format).label}）：${receipt.pathDisplay ?? '(非 UTF-8 路径)'} · ` +
        `${String(receipt.bytesWritten)} 字节 · ` +
        `文件${receipt.verified ? '校验通过' : '校验未通过！'}` +
        (notes.length === 0 ? '' : ` —— ${notes.join('；')}`),
      receipt.verified ? 'ok' : 'bad',
    );
    return true;
  } catch (error) {
    host.setStatus(`保存失败：${describeError(error)}`, 'bad');
    return false;
  }
}

export async function askSaveFormat(host: SaveHost, session: CardSession): Promise<SaveFormatDialogResult | null> {
  if (!host.saveFormatDialog) host.saveFormatDialog = new SaveFormatDialog();

  // 能不能出 PNG 取决于能否拿到卡面（浏览器无壳读不到内置默认图）
  let pngAvailable = true;
  let pngUnavailableReason = '';
  try {
    const probe = await resolveSaveFace(host, );
    if (probe === null) {
      pngAvailable = false;
      pngUnavailableReason = '浏览器模式读不到卡面 —— 请在桌面客户端里另存为 PNG';
    }
  } catch (error) {
    pngAvailable = false;
    pngUnavailableReason = `卡面不可用：${describeError(error)}`;
  }

  return host.saveFormatDialog.open({
    defaultFormat: session.saveFormat,
    pngAvailable,
    pngUnavailableReason,
  });
}

export async function savePngWithGuard(host: SaveHost, 
  target: string,
  png: Uint8Array,
  session: CardSession,
): Promise<{ path: string; receipt: WriteReceipt | null; note: string } | null> {
  const incomingCardId = readCardIdFromCardJson(session.card);
  const config = await configGet().catch(() => null);
  const baselines = config?.fileBaselines ?? {};

  const result = await saveTargetWithGuard(target, png, incomingCardId, {
    readFile: async (path) => {
      try {
        const file = await readBinaryFile(path);
        const decoded = await decodeBinaryFile(file);
        return decoded.bytes;
      } catch {
        // 不存在是正常路径；读失败也当"没有"，让守卫走"直接写"
        return null;
      }
    },
    readCardId: (bytes) => {
      const parsed = parsePngCard(bytes);
      if (parsed.kind !== 'card') return null;
      return readCardIdFromCardJson(parsed.json);
    },
    isOpenInTab: (path) =>
      host.sessions.some((item) => item.filePath === path),
    isDirty: (path) =>
      host.sessions.some((item) => item.filePath === path && item.dirty),
    isNewer: async (path) => {
      try {
        const stat = await statFile(path);
        if (stat === null) return false;
        return isNewerThanBaseline(stat.mtimeMs, getBaseline(baselines, path));
      } catch {
        // 见方法注释：判据出错时放行，不拦用户导出
        return false;
      }
    },
    writeAtomic: async (path, bytes) => {
      const written = await writeBinaryFileAtomic(path, bytesToBase64(bytes));
      return { sha256: written.sha256 };
    },
    listDir: async (dir) => {
      const scan = await scanCardsDir(dir, undefined, ['png']);
      return scan.names;
    },
    joinPath: (dir, name) => joinPath(dir, name),
    askDirty: (options) => askDirtyChoice(options),
    askUnknown: (options) => askUnknownChoice(options),
    note: (message) => { host.setStatus(message, 'info'); },
  });

  if (result === null) return null;

  /*
   * 没落盘时 `sha256` 是空串（查看差异 / 标签占用这两支）。
   * 用它当判据而不是另外加一个布尔：空摘要本身就不可能是一次成功写入的产物，
   * 两个字段表达同一件事会分叉。
   */
  if (result.sha256 === '') {
    return { path: result.path, receipt: null, note: result.note };
  }

  /*
   * 写完立刻把**这份文件的新 mtime** 记成基线。
   *
   * 必须真去 stat 一次，不能拿"当前时间"顶替：文件的 mtime 由文件系统写、
   * 与我们这边的时间可能有几百毫秒差（尤其在同步盘上）。拿当前时间记基线，
   * 下次判定会得到 `fileMtime < baseline` ⇒ 永远判不脏 ⇒ 这条判据失效。
   */
  try {
    const after = await statFile(result.path);
    if (after !== null) {
      await configPatch({ fileBaselines: recordBaseline(baselines, result.path, after.mtimeMs) });
    }
  } catch {
    // 记基线失败不影响这次导出的结果：只是下次会少一层保护
  }

  return {
    path: result.path,
    receipt: {
      pathDisplay: result.path,
      bytesWritten: png.byteLength,
      sha256: result.sha256,
      verified: true,
    },
    note: result.note,
  };
}

export async function resolveSaveFace(host: SaveHost): Promise<ResolvedSaveFace | null> {
  return resolveSaveFaceCore(
    defaultSaveFaceDeps({
      sourceBytes: () => host.session?.pngSource?.bytes ?? null,
      cardsDir: () => effectiveCardsDir(),
      remembered: () => host.lastFaceChoice,
      readLibraryFile: async (path) => {
        const fileName = path.slice(path.lastIndexOf('/') + 1);
        const binary = await readBinaryFile(path);
        // 复用 png-source 的版本：它顺带核对摘要（字节数与 sha256 自证）
        return { bytes: (await decodeBinaryFile(binary)).bytes, fileName };
      },
    }),
  );
}

export async function saveCard(host: SaveHost): Promise<void> {
  if (!host.hasSession) return;
  if (host.session === null) return;
  await saveSessionToDisk(host, host.session);
}