/**
 * 用户预设库的**读写时序**（v0.1.5 / G5）。
 *
 * ## 这个文件解决什么
 *
 * 之前所有用户导入的预设（平台规则 / 高亮方案 / TXT 预设 / 世界书格式 /
 * 初始场景 / 对话示例）都只活在内存里，关掉软件就没了 —— README 当时写的是
 * "只在本次运行内生效"。用户的实际诉求是：**导入一次、切换一次，下次打开还在**。
 *
 * 于是要回答三个问题，答案都在这里：
 *   1. 什么时候读？—— `start()` 里、内置规则装好之后，读一次；
 *   2. 什么时候写？—— **导入成功那一刻**，不等退出。关窗口时写有个致命问题：
 *      崩溃/断电就没写。而导入是低频动作，每次写一点代价可以接受；
 *   3. 写失败怎么办？—— 不打断用户（预设本次已经生效），但**必须告知**
 *      "这次没能保存，重启会丢"。静默失败会让用户以为已经存好了。
 *
 * ## 为什么串行化
 *
 * 连续导入两个文件会在几乎同一时刻触发两次写。两次 `writePresetLibrary` 各自
 * 原子写没问题，但**后一次用的是旧的 items 快照**就会把前一次的结果覆盖掉
 * （经典 read-modify-write 竞态）。这里用一个 Promise 链把它们排队，
 * 每次写入时用的是**当时最新的** `#items`。
 */

import {
  parsePresetLibrary,
  serializePresetLibrary,
  upsertLibraryItem,
  type PresetKind,
  type PresetLibraryItem,
} from './preset-store.ts';

export interface PresetLibraryLoadResult {
  items: PresetLibraryItem[];
  /** 需要展示给用户的问题（版本不认 / 某条坏了 / 读失败） */
  warnings: string[];
  /** 是否真的读到了文件（false = 首次运行或文件不在） */
  present: boolean;
}

export interface RememberResult {
  /** 是否成功落盘 */
  saved: boolean;
  /** 失败原因（saved=false 时非空），直接给用户看 */
  error: string | null;
}

/**
 * 库的 IO 接口。
 *
 * 抽成接口是为了**能测时序** —— 这一层最容易出错的不是格式（`preset-store`
 * 已覆盖），而是"什么时候写、写失败怎么办、两次写并发会不会互相覆盖"。
 * 这些问题用假 IO 才能稳定复现（真实文件系统里竞态窗口只有几毫秒）。
 *
 * 依赖方向也顺了：本模块**不 import contract**，由 App 在构造时注入
 * （它本来就要从 contract 取原生能力）。这样这个类能在 Node 里直接单测，
 * 不需要壳、不需要 Tauri 的 IPC 桩。
 */
export interface PresetLibraryIo {
  /** 返回 `null` = 文件不存在（首次运行）。读失败请**抛错** */
  read: () => Promise<{ text: string } | null>;
  write: (text: string) => Promise<unknown>;
}

export class PresetPersistence {
  #items: PresetLibraryItem[] = [];
  /** 写入队列：保证 read-modify-write 不互相踩 */
  #queue: Promise<void> = Promise.resolve();
  /** 库文件内容是否已成功读入（读失败时不写，避免覆盖用户还能手工修的文件） */
  #readable = true;
  readonly #io: PresetLibraryIo;

  constructor(io: PresetLibraryIo) {
    this.#io = io;
  }

  /** 当前内存中的库（只含用户导入项，不含内置） */
  get items(): readonly PresetLibraryItem[] {
    return this.#items;
  }

  /**
   * 读库。**只在启动时调一次。**
   *
   * 读失败（不是"文件不存在"）时把 `#readable` 置 false：此后 `remember()`
   * 不会再写盘。理由 —— 用户的库文件可能只是**临时**读不动（占用、权限），
   * 直接覆盖会把他原来那份永久毁掉。这种情况下宁可这次不保存，
   * 也要保住原文件（警告里会说清）。
   */
  async load(): Promise<PresetLibraryLoadResult> {
    let text: string | null = null;
    try {
      const file = await this.#io.read();
      text = file?.text ?? null;
    } catch (error) {
      this.#readable = false;
      this.#items = [];
      return {
        items: [],
        present: false,
        warnings: [
          `预设库读取失败（${describe(error)}）—— 本次启动不会改动磁盘上的预设库，以免覆盖你原有的预设。若持续失败，可到应用配置目录检查 preset-library.json`,
        ],
      };
    }

    if (text === null) {
      // 首次运行：没有文件是正常状态，不是警告
      this.#items = [];
      return { items: [], present: false, warnings: [] };
    }

    const parsed = parsePresetLibrary(text);
    if (parsed.error !== null) {
      /*
       * 文件在、但读不懂。**不覆盖** —— 那可能是旧版本客户端写的、也可能是
       * 用户手工改坏的。让他自己决定是删掉还是修好，比替他清空更安全。
       */
      this.#readable = false;
      this.#items = [];
      return { items: [], present: true, warnings: [parsed.error, '已跳过预设库（不会覆盖原文件）'] };
    }

    this.#items = parsed.items;
    return { items: parsed.items, present: true, warnings: parsed.warnings };
  }

  /**
   * 记住一条刚导入成功的预设，并立刻落盘。
   *
   * 返回 `saved=false` 时调用方**必须**告诉用户"本次生效但没存下" ——
   * 这是本模块对外唯一的行为契约（静默失败 = 用户以为存好了，下次发现没了）。
   */
  async remember(
    kind: PresetKind,
    name: string,
    text: string,
    id: string | null,
  ): Promise<RememberResult> {
    this.#items = upsertLibraryItem(this.#items, kind, name, text, id);

    if (!this.#readable) {
      return {
        saved: false,
        error: '预设库当前不可写（启动时读取失败，为避免覆盖原文件未做保存）',
      };
    }

    const snapshot = serializePresetLibrary(this.#items);
    let failure: string | null = null;
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#io.write(snapshot);
      } catch (error) {
        failure = describe(error);
      }
    });
    await this.#queue;
    return failure === null ? { saved: true, error: null } : { saved: false, error: failure };
  }

  /**
   * 清空库（供将来的"恢复出厂预设"用；当前没有 UI 入口）。
   *
   * 写一个**空库**而不是删文件：删掉之后下次启动又是"没有文件"，
   * 与"用户主动清空"在语义上无法区分，排查问题时会误导。
   */
  async clear(): Promise<RememberResult> {
    this.#items = [];
    if (!this.#readable) return { saved: false, error: '预设库当前不可写' };
    try {
      await this.#io.write(serializePresetLibrary([]));
      return { saved: true, error: null };
    } catch (error) {
      return { saved: false, error: describe(error) };
    }
  }

  /** 等所有排队的写入结束（测试与退出前用） */
  async flush(): Promise<void> {
    await this.#queue;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
