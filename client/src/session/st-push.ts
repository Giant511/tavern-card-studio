/**
 * 把当前卡推送到 SillyTavern 的角色目录 —— **唯一的写盘实现**（v0.1.6 / T14.4）。
 *
 * ## 为什么要从 `st-dialog.ts` 里抽出来
 *
 * 推送入口现在有两个（四状态对话框、右侧常驻面板）。如果两处各写一份，就会出现
 * 那种"对话框里加了序号防覆盖、面板里忘了"的缺陷 —— 而它只在特定入口触发，
 * 用户报上来时还很难复现。所以链路只有一份：
 *
 *   角色名 → 文件名（**更新式：按 cardId 复用，不是每次加序号**）→ characters 目录
 *   → 二进制原子写 → 回读自证
 *
 * 面板与对话框都调它，差别只在"推完之后的界面反应"（对话框留在原地显示结果，
 * 面板去刷新 iframe）。
 *
 * ## v0.1.7 修订一：从"同名加序号"改成"更新式"
 *
 * 旧语义每次推送都当新卡，ST 里就多一个角色、聊天记录留在旧的上面 —— 用户看到的
 * 是"改个设定，聊天全没了"。现在的判据在 `st-push-name.ts`：
 * 同 cardId 覆盖原文件，只有目标名被**别的卡**占用时才加序号。
 *
 * ## 为什么依赖是注入的
 *
 * 写盘、扫目录、建目录、读写映射都是壳能力。注入之后这个模块可以**在 Node 里真跑**
 * （`test/st-push-pipeline.test.mjs` 就是这么做的：临时目录 + 真实字节），
 * 而不是只能在 Tauri 壳里手点。
 */

import { joinPath } from './cards-path.ts';
import {
  describePushFace,
  staleJsonSiblings,
  toBase64Chunked,
  type StPushFace,
} from './st-install.ts';
import {
  nameKeyFor,
  resolveStPushName,
  type StPushNameRegistry,
} from './st-push-name.ts';

/** 导出管线产出的 PNG 卡（`buildStPushArtifact` 的返回） */
export interface StPushArtifact {
  bytes: Uint8Array;
  sha256: string;
  /** 导出管线自己建议的文件名（不带扩展名；最终名由这里按目录冲突决定） */
  fileName: string;
  face: StPushFace;
}

/** 推送成功的结果（够界面说话用，不含内部实现细节） */
export interface StPushSuccess {
  ok: true;
  /** 落盘文件名，如 `西奥.png`（更新已有卡时是**原来那个名字**，不是新的） */
  fileName: string;
  /** 完整路径 */
  path: string;
  /**
   * 这次是"更新已有角色"还是"首次占名"（v0.1.7 修订一）。
   *
   * 界面要区分：更新时应当说「已更新」，首次说「已推送」—— 用户看到
   * 「已推送」加上一个一模一样的文件名，会怀疑是不是又建了一个。
   */
  isUpdate: boolean;
  /** 卡面来源说明（"用原图" / "用图库封面 xxx.png" / "内置默认"） */
  faceNote: string;
  /** 旧 JSON 残留提示（空串 = 没有） */
  staleNote: string;
  /** 命名决策的补充说明（如"原名被别的卡占用"）；空串 = 没有 */
  nameNote: string;
}

/** 推送失败：`reason` 是给用户看的一句话，不做 code → 文案映射 */
export interface StPushFailure {
  ok: false;
  reason: string;
}

export type StPushOutcome = StPushSuccess | StPushFailure;

/** 推送需要的外部能力（默认走真实壳；测试注入假的） */
export interface StPushDeps {
  probeDir: (
    dir: string,
    options: { create: boolean },
  ) => Promise<{ exists: boolean; reason?: string | null }>;
  scanDir: (
    dir: string,
    limit?: number,
    extensions?: string[],
  ) => Promise<{ names: string[]; truncated: boolean }>;
  writeBinary: (
    path: string,
    base64: string,
    sha256: string,
  ) => Promise<{ verified: boolean }>;
  /**
   * 读 `cardId → 文件名` 映射（v0.1.7 修订一）。
   *
   * 存在客户端配置里（`ClientConfig.stPushNames`），不存服务端：
   * 这是**本机 ST 目录的状态**，换一台机器 ST 目录不同，映射也就不同。
   */
  loadNames: () => Promise<StPushNameRegistry>;
  /**
   * 登记一条映射，并删掉 `dropKeys`（认领场景下清理备用 key）。
   *
   * 刻意做成"登记一个 + 删几个"而不是"整份覆盖"：整份覆盖会让
   * 两个入口（对话框 / 面板）几乎同时推送时互相清掉对方的登记。
   */
  saveName: (key: string, fileName: string, dropKeys: readonly string[]) => Promise<void>;
}

export interface StPushRequest {
  /** ST 的 characters 目录（`<ST>/data/default-user/characters`） */
  charactersDir: string;
  /** 当前卡的角色名（决定文件名） */
  cardName: string;
  /**
   * 当前卡的稳定 ID（F11 的 cardId）。`null`/空串 = 还没上传过服务端。
   *
   * 有它才能做"更新式推送"：映射跟 cardId 走，于是**改名不动文件名**，
   * ST 侧的角色身份（文件名）不变，聊天记录自然保留。
   */
  cardId?: string | null;
  /** 生成产物；返回 null = 被导出闸门拦下 */
  build: () => Promise<StPushArtifact | null>;
  deps: StPushDeps;
}

/**
 * 推一次。**不抛异常**：所有失败都折成 `{ ok: false, reason }` ——
 * 两个调用方都要把原因显示出来，抛异常只会让其中一处忘了 catch。
 */
export async function pushCardToSt(request: StPushRequest): Promise<StPushOutcome> {
  const { charactersDir, cardName, cardId, build, deps } = request;

  /*
   * `build()` 必须包 try/catch。
   *
   * 它内部走完整的导出链路（解析卡面 → buildPngCard → 算摘要），任何一步
   * 抛错都意味着"这次推送不可能成功"。不包的话异常会一路冒成
   * **未捕获的 promise rejection**，而那条链路上没人接 ——
   * 用户看到的就是"点了推送，什么都不发生"（2026-10-29 生产反馈：
   * 卡面是 WebP 时 `buildPngCard` 抛 `PngCardError: 不是 PNG 文件`）。
   *
   * 这里把异常转成 `{ ok:false, reason }`，让 UI 有一个能显示的原因。
   * 判据是"用户能不能从界面上知道发生了什么"，而不是"日志里有没有记"。
   */
  let built;
  try {
    built = await build();
  } catch (error) {
    return {
      ok: false,
      reason: `推送中止：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (built === null) {
    // 闸门拦下（世界书会丢内容那种），具体文案由导出链路给过，这里只停手
    return { ok: false, reason: '导出被拦下了：先修好审计面板里的硬阻断问题，再推送。' };
  }

  // characters 目录可能还没建（ST 装好但没跑过）：在一键推送里补建一级目录
  const probe = await deps.probeDir(charactersDir, { create: true });
  if (!probe.exists) {
    return { ok: false, reason: `角色卡目录不可用：${probe.reason ?? '未知原因'}` };
  }

  /*
   * 扫描要**同时看 png 与 json**：
   *   · png —— 判断新文件名是否冲突（唯一真正相关的扩展名）；
   *   · json —— 找出 v0.1.5 之前推过的旧 JSON，提示用户它 ST 不认。
   * 只扫 png 的话，用户会在资源管理器里看到两份文件却不知道为什么只出现一张卡。
   */
  const scan = await deps.scanDir(charactersDir, undefined, ['png', 'json']);
  if (scan.truncated) {
    // 扫描被截断时"没有同名"这个结论不成立 —— 宁可不推，也不能覆盖别人的卡
    return {
      ok: false,
      reason: `角色卡目录里的文件太多（超过扫描上限），无法确认新文件名是否冲突：${charactersDir}`,
    };
  }

  /*
   * 决定落盘名（v0.1.7 修订一）。判据全在 `st-push-name.ts` 里，这里只负责取数据：
   *   · 主 key  = cardId（有的话）—— 改名不动文件名，聊天记录保留；
   *   · 备用 key = `name:<角色名>` —— 让"先没登录推过、后来才有 cardId"能认领旧映射，
   *               否则那一次推送会在 ST 里凭空多出一张卡。
   */
  const trimmedId = typeof cardId === 'string' ? cardId.trim() : '';
  const primaryKey = trimmedId !== '' ? trimmedId : nameKeyFor(cardName);
  const adoptFrom = trimmedId !== '' ? nameKeyFor(cardName) : null;

  let registry: StPushNameRegistry;
  try {
    registry = await deps.loadNames();
  } catch {
    /*
     * 读不到映射时**不阻止推送**：映射只是"让下次能覆盖"，丢了最坏结果是
     * 下次推送加序号。为这个把推送整体拒掉，等于让用户连改都改不了。
     * 传空表进去 → 走首次占名逻辑。
     */
    registry = {};
  }

  const decision = resolveStPushName({
    key: primaryKey,
    adoptFrom,
    cardName,
    existing: scan.names,
    registry,
  });

  const fileName = decision.fileName;
  const target = joinPath(charactersDir, fileName);

  /*
   * **先登记映射，再写盘。** 这个顺序是刻意的：
   *
   *   · 先登记、写盘失败 → 映射指向一个不存在的文件。下次推送时
   *     `usableMapping` 会判定"文件不在"→ 重新占名，而目录里确实没有那个文件，
   *     于是**占到的还是同一个名字**。自愈。
   *   · 先写盘、登记失败 → 文件已在目录里但映射缺失。下次推送走"首次占名"，
   *     因为目录里有 `西奥.png`，会得到 `西奥 (2).png` —— **凭空多一张卡**，
   *     而且旧文件成了孤儿。不自愈。
   *
   * 也就是说：只有"先登记"这一侧的错误能自动恢复。
   */
  if (decision.register !== null) {
    try {
      await deps.saveName(primaryKey, decision.register, decision.dropKeys);
    } catch {
      /*
       * 登记失败不能让推送失败（文件还没写，用户会以为整个操作没生效），
       * 但必须**说出来** —— 否则下次推送悄悄多一张卡，而这次界面显示"已推送"。
       */
      return {
        ok: false,
        reason:
          '保存「卡片与酒馆文件名的对应关系」失败，为避免下次推送多出一张角色卡，已中止。' +
          '请重试；若反复出现，检查配置目录是否可写。',
      };
    }
  }

  // PNG 走二进制写：与文本写**共用** write_atomic_impl（原子性 / 写前摘要断言 /
  // 写后回读自证三条不会在这条路径上退化）
  const receipt = await deps.writeBinary(target, toBase64Chunked(built.bytes), built.sha256);
  if (!receipt.verified) {
    // 回读自证失败 = 落盘内容与内存不一致，这时候不能报"成功"
    return { ok: false, reason: '写入文件后校验未通过：文件可能不完整，请检查磁盘空间后重试。' };
  }

  /*
   * 旧 JSON 的处置（v0.1.5 / G8）：**只做一行灰字提示，不弹错误框**。
   *
   * 那是测试期用旧版（推 JSON）留下的文件：ST 的角色扫描不读它，所以它
   * 在游戏里永远不会出现，但也**不影响**任何东西。拿红色错误框去报一件
   * "无害且无需动作"的事，只会让人以为这次推送出了问题。
   */
  const stale = staleJsonSiblings(cardName, scan.names);
  return {
    ok: true,
    fileName,
    path: target,
    isUpdate: decision.isUpdate,
    faceNote: describePushFace(built.face),
    staleNote:
      stale.length === 0
        ? ''
        : `目录里还有更早版本推送的 ${stale.join('、')}（SillyTavern 的角色列表不读 .json，` +
          '不影响这次推送，可自行删除）。',
    nameNote: decision.note,
  };
}
