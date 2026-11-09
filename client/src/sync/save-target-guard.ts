/**
 * 落盘守卫：把「目标路径已有同名文件」的五种情况收在一处（v0.1.7 增补三）。
 *
 * ## 为什么要有这一层
 *
 * 决策本身在 `face-drop.ts`（纯函数，14 项测试）。但决策只是一句话，
 * 真正容易出错的是**执行**：
 *
 *   · 「同卡干净 → 覆盖」必须**原子写 + 回读自证**，否则写一半断电会得到一个
 *     半截 PNG，而它长得像一张正常的卡（有签名、有 IEND 缺失），用户导入时才发现坏；
 *   · 「另存」的序号必须**重新扫描目录**再取，不能沿用进入时的快照 ——
 *     期间可能有别的卡落了盘；
 *   · 「无 cardId」那种情况**不能**退化成另存（否则反复取回同一张老卡会堆出
 *     `(2)(3)(4)`，而用户分不清哪个在用的）。
 *
 * 所以执行逻辑单独一层，依赖全部注入 —— 这样它能在 Node 里跑测试，
 * 不必起一个 Tauri 窗口。
 */

import { decideFaceDrop, type DirtyChoiceId, type FaceDropDecision } from '../export/face-drop.ts';
import { nextAvailableFileName } from '../session/cards-path.ts';

/** 落盘需要的全部外部能力（都由调用方注入） */
export interface SaveTargetDeps {
  /** 读文件字节；不存在返回 null（**不要抛错**，不存在是正常路径） */
  readFile: (path: string) => Promise<Uint8Array | null>;
  /** 从 PNG 卡字节里读 `extensions.tcs.cardId`；读不出返回 null */
  readCardId: (bytes: Uint8Array) => string | null;
  /** 该路径是否正被某个标签打开 */
  isOpenInTab: (path: string) => boolean;
  /** 该路径对应的编辑器有未保存修改 */
  isDirty: (path: string) => boolean;
  /** 该路径的文件比要落盘的内容更新 */
  isNewer: (path: string) => Promise<boolean>;
  /**
   * 原子写 + 回读校验。**返回值必须是"磁盘上那份的摘要"**，
   * 由实现方写完再读一遍算出来 —— 直接返回入参摘要等于没校验。
   */
  writeAtomic: (path: string, bytes: Uint8Array) => Promise<{ sha256: string }>;
  /** 目录下现有文件名（给"另存"取序号用） */
  listDir: (dir: string) => Promise<string[]>;
  /** 拼路径 */
  joinPath: (dir: string, name: string) => string;
  /** 三选弹窗；返回用户的选择 */
  askDirty: (options: {
    fileName: string;
    reason: string;
    choices: readonly { id: DirtyChoiceId; label: string; danger?: boolean }[];
  }) => Promise<DirtyChoiceId | null>;
  /** 「本地文件没有卡片标识」的询问；返回 true = 覆盖，false = 另存 */
  askUnknown: (options: { fileName: string; reason: string }) => Promise<'overwrite' | 'save-as' | null>;
  /** 异卡撞名之类的一句话提示（状态栏） */
  note?: (message: string) => void;
}

export interface SaveTargetResult {
  /** 实际写入的路径（另存时与入参不同） */
  path: string;
  /** 磁盘上那份的摘要 */
  sha256: string;
  /** 最后的决策，便于日志与验收断言 */
  decision: FaceDropDecision;
  /** 给状态栏的一句话 */
  note: string;
}

/**
 * 把 `bytes` 写到 `target`，必要时按 cardId 身份改道。
 *
 * @param incomingCardId 这张卡的 cardId（要落盘的那份的身份）
 * @returns 实际落点与摘要；用户取消时返回 null
 */
export async function saveTargetWithGuard(
  target: string,
  bytes: Uint8Array,
  incomingCardId: string,
  deps: SaveTargetDeps,
): Promise<SaveTargetResult | null> {
  const existing = await deps.readFile(target);

  // 目标不存在：最省事的路径，什么都不用问
  if (existing === null) {
    const written = await deps.writeAtomic(target, bytes);
    return {
      path: target,
      sha256: written.sha256,
      decision: { kind: 'write' },
      note: '',
    };
  }

  const localCardId = deps.readCardId(existing);
  const decision = decideFaceDrop({
    targetExists: true,
    localCardId,
    incomingCardId,
    openInTab: deps.isOpenInTab(target),
    localDirty: deps.isDirty(target),
    localNewer: await deps.isNewer(target),
  });

  const fileName = basename(target);
  const dir = dirname(target);

  switch (decision.kind) {
    /*
     * 标签占用：**这里不写盘**。
     *
     * 磁盘先写、内存后改会让编辑器里还是旧内容，用户以为没生效；
     * 而且编辑器下次保存时会用旧内容覆盖回去，变成"写了等于没写"。
     * 交给调用方转既有"导入替换当前卡"流程 —— 那里本来就有确认，
     * 再在这里弹一次就是双弹窗。
     */
    case 'defer-to-open-tab':
      return {
        path: target,
        sha256: '',
        decision,
        note: decision.reason,
      };

    case 'ask-unknown': {
      const choice = await deps.askUnknown({ fileName, reason: decision.reason });
      if (choice === null) return null; // 用户取消
      if (choice === 'overwrite') {
        const written = await deps.writeAtomic(target, bytes);
        return {
          path: target,
          sha256: written.sha256,
          decision: { kind: 'overwrite', reason: '本地文件没有卡片标识，按用户选择覆盖。' },
          note: '已覆盖同名文件',
        };
      }
      return saveAside(target, dir, fileName, bytes, decision, deps);
    }

    case 'ask-dirty': {
      const choice = await deps.askDirty({
        fileName,
        reason: decision.reason,
        // 三选：覆盖 / 另存 / 查看差异。顺序与 `DIRTY_CHOICES` 一致
        choices: [
          { id: 'overwrite', label: '覆盖本地', danger: true },
          { id: 'save-as', label: '另存为' },
          { id: 'diff', label: '查看差异' },
        ],
      });
      if (choice === null) return null;
      if (choice === 'diff') {
        /*
         * 「查看差异」是个**查看**动作，不能顺手写盘。
         * 返回一个 sha 为空的"未落盘"结果，调用方据此打开 diff 视图、
         * 并且知道这次没写 —— 这样用户看完还能再选一次。
         */
        return { path: target, sha256: '', decision, note: '' };
      }
      if (choice === 'overwrite') {
        const written = await deps.writeAtomic(target, bytes);
        return {
          path: target,
          sha256: written.sha256,
          decision: { kind: 'overwrite', reason: '用户选择覆盖本地修改。' },
          note: '已覆盖本地修改',
        };
      }
      return saveAside(target, dir, fileName, bytes, decision, deps);
    }

    case 'overwrite': {
      const written = await deps.writeAtomic(target, bytes);
      return {
        path: target,
        sha256: written.sha256,
        decision,
        note: decision.reason,
      };
    }

    case 'save-as':
      return saveAside(target, dir, fileName, bytes, decision, deps);

    default:
      /*
       * 理论到不了这里（`FaceDropDecision` 的五个 kind 全列了）。
       * 留着是为了"以后有人加了第六种 kind 但忘了在这里处理"时
       * 得到一个明确的 null，而不是静默地什么都不做、调用方以为写过了。
       */
      return null;
  }
}

/**
 * 另存：**重新扫目录**取序号。
 *
 * 不用进入时那份快照，是因为这中间可能有别的卡落了盘（多标签 / 外部操作），
 * 沿用旧快照会撞到一个刚出现的名字上 —— 那等于又覆盖了一次。
 */
async function saveAside(
  _target: string,
  dir: string,
  fileName: string,
  bytes: Uint8Array,
  decision: FaceDropDecision,
  deps: SaveTargetDeps,
): Promise<SaveTargetResult | null> {
  const names = await deps.listDir(dir);
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot + 1) : 'png';

  const available = nextAvailableFileName(names, base, ext);
  const path = deps.joinPath(dir, available);
  const written = await deps.writeAtomic(path, bytes);

  const note =
    decision.kind === 'save-as'
      ? `本地已有同名文件，但它是另一张卡，已另存为「${available}」`
      : `已另存为「${available}」`;

  deps.note?.(note);
  return { path, sha256: written.sha256, decision, note };
}

function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at >= 0 ? path.slice(at + 1) : path;
}

function dirname(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at > 0 ? path.slice(0, at) : '';
}
