/**
 * 把当前卡推送到 SillyTavern 的角色目录 —— **唯一的写盘实现**（v0.1.6 / T14.4）。
 *
 * ## 为什么要从 `st-dialog.ts` 里抽出来
 *
 * 推送入口现在有两个（四状态对话框、右侧常驻面板）。如果两处各写一份，就会出现
 * 那种"对话框里加了序号防覆盖、面板里忘了"的缺陷 —— 而它只在特定入口触发，
 * 用户报上来时还很难复现。所以链路只有一份：
 *
 *   角色名 → 文件名（冲突加序号）→ characters 目录 → 二进制原子写 → 回读自证
 *
 * 面板与对话框都调它，差别只在"推完之后的界面反应"（对话框留在原地显示结果，
 * 面板去刷新 iframe）。
 *
 * ## 为什么依赖是注入的
 *
 * 写盘、扫目录、建目录都是壳能力。注入之后这个模块可以**在 Node 里真跑**
 * （`test/st-push-pipeline.test.mjs` 就是这么做的：临时目录 + 真实字节），
 * 而不是只能在 Tauri 壳里手点。
 */

import { joinPath } from './cards-path.ts';
import {
  describePushFace,
  staleJsonSiblings,
  stPushFileName,
  toBase64Chunked,
  type StPushFace,
} from './st-install.ts';

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
  /** 落盘文件名，如 `西奥 (2).png` */
  fileName: string;
  /** 完整路径 */
  path: string;
  /** 卡面来源说明（"用原图" / "用图库封面 xxx.png" / "内置默认"） */
  faceNote: string;
  /** 旧 JSON 残留提示（空串 = 没有） */
  staleNote: string;
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
}

export interface StPushRequest {
  /** ST 的 characters 目录（`<ST>/data/default-user/characters`） */
  charactersDir: string;
  /** 当前卡的角色名（决定文件名） */
  cardName: string;
  /** 生成产物；返回 null = 被导出闸门拦下 */
  build: () => Promise<StPushArtifact | null>;
  deps: StPushDeps;
}

/**
 * 推一次。**不抛异常**：所有失败都折成 `{ ok: false, reason }` ——
 * 两个调用方都要把原因显示出来，抛异常只会让其中一处忘了 catch。
 */
export async function pushCardToSt(request: StPushRequest): Promise<StPushOutcome> {
  const { charactersDir, cardName, build, deps } = request;

  const built = await build();
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

  const fileName = stPushFileName(cardName, scan.names);
  const target = joinPath(charactersDir, fileName);

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
    faceNote: describePushFace(built.face),
    staleNote:
      stale.length === 0
        ? ''
        : `目录里还有更早版本推送的 ${stale.join('、')}（SillyTavern 的角色列表不读 .json，` +
          '不影响这次推送，可自行删除）。',
  };
}
