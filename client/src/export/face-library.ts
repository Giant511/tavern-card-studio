/**
 * 卡面图库与导出卡面的**纯逻辑**（v0.1.4 / T12.5，决策 #166–#168）。
 *
 * 无 DOM、无 IO、无 Tauri 依赖 —— 目录规则、候选排序、记忆值的编解码
 * 都在这里，可以单测。真正读图/转码在 `face-picker.ts`（需要 canvas/契约）。
 *
 * ## 为什么"上次选择"要编码成字符串而不是对象
 *
 * 它存进 `ClientConfig`（plugin-store 的 JSON）。存对象就要在两侧都维护
 * 一个 shape，而且旧配置里缺字段时要迁移。编码成一个字符串：
 *   · 未设置 → `null`
 *   · `'default'` → 默认卡面
 *   · `'source'` → 当前卡的原图
 *   · `'lib:<文件名>'` → 图库里某一张
 * 前缀 `lib:` 而不是光存文件名，是因为文件名可能恰好叫 `default` 或 `source`。
 * **浏览选择的单次路径不参与记忆**（需求 F4.4 明写）—— 那是一次性动作，
 * 记下来会让下次导出默认指向一个可能已被删掉的文件。
 */

import { joinPath } from '../session/cards-path.ts';

/** 卡面图库目录名（跟随用户已配置的卡库目录，F5） */
export const FACE_LIBRARY_DIR_NAME = 'card-faces';

/** 图库接受的图片扩展名（需求 F4.1：png/jpg/webp） */
export const FACE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp'];

/** 长边超过它要等比压缩（需求 F4.3） */
export const FACE_MAX_EDGE = 4096;

/** 卡面来源 */
export type FaceChoice =
  | { kind: 'default' }
  | { kind: 'source' }
  | { kind: 'library'; name: string }
  | { kind: 'browse'; path: string };

/** 图库目录：`<cardsDir>/card-faces` */
export function faceLibraryDir(cardsDir: string): string {
  return joinPath(cardsDir, FACE_LIBRARY_DIR_NAME);
}

/** 记忆值编码 */
export function encodeFaceChoice(choice: FaceChoice): string | null {
  switch (choice.kind) {
    case 'default':
      return 'default';
    case 'source':
      return 'source';
    case 'library':
      return `lib:${choice.name}`;
    case 'browse':
      // 需求 F4.4：不记忆"浏览选择"的单次路径
      return null;
  }
}

/** 记忆值解码。认不出的值一律当"没记过"，而不是猜一个 */
export function decodeFaceChoice(raw: string | null | undefined): FaceChoice | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw === 'default') return { kind: 'default' };
  if (raw === 'source') return { kind: 'source' };
  if (raw.startsWith('lib:')) {
    const name = raw.slice(4);
    return name === '' ? null : { kind: 'library', name };
  }
  return null;
}

export interface FaceCandidate {
  choice: FaceChoice;
  /** 显示名 */
  label: string;
  /** 角标：`默认` / `原图` / 空 */
  badge: string;
  /** 排序权重：默认卡面排第一、原图第二，图库按文件名 */
  order: number;
}

/**
 * 候选列表（需求 F4.1 的 c → d → a 顺序）。
 *
 * 顺序不是随意的：**默认卡面**永远存在（所以它第一，用户总能选到一个能用的）；
 * **原图**只有 PNG 导入的卡才有（所以第二，那是"保持原样"最自然的选择）；
 * 图库是用户自己攒的（按文件名排，稳定）。
 *
 * `hasSource` 为 false 时**不渲染**"原图"这一项 —— 渲染成禁用按钮会让用户
 * 反复点它、怀疑是不是坏了。
 */
export function listFaceCandidates(libraryNames: readonly string[], hasSource: boolean): FaceCandidate[] {
  const candidates: FaceCandidate[] = [
    { choice: { kind: 'default' }, label: '默认卡面', badge: '默认', order: 0 },
  ];
  if (hasSource) {
    candidates.push({ choice: { kind: 'source' }, label: '当前卡的原图', badge: '原图', order: 1 });
  }

  const seen = new Set<string>();
  for (const name of libraryNames) {
    const lowered = name.toLowerCase();
    if (seen.has(lowered)) continue; // Windows 上同名不同大小写是同一个文件
    seen.add(lowered);
    if (!FACE_EXTENSIONS.some((ext) => lowered.endsWith(`.${ext}`))) continue;
    candidates.push({
      choice: { kind: 'library', name },
      label: name,
      badge: '',
      order: 2,
    });
  }

  candidates.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return left.label.localeCompare(right.label, 'zh-Hans-CN');
  });
  return candidates;
}

/** 预选：记忆值可用则用它，否则按"有原图用原图，否则默认卡面"（决策 D4） */
export function preselectFace(
  remembered: string | null | undefined,
  available: readonly FaceCandidate[],
): FaceChoice {
  const decoded = decodeFaceChoice(remembered);
  if (decoded !== null) {
    const matched = available.find((item) => sameChoice(item.choice, decoded));
    if (matched !== undefined) return matched.choice;
  }
  const source = available.find((item) => item.choice.kind === 'source');
  if (source !== undefined) return source.choice;
  return { kind: 'default' };
}

export function sameChoice(left: FaceChoice, right: FaceChoice): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'library' && right.kind === 'library') return left.name === right.name;
  if (left.kind === 'browse' && right.kind === 'browse') return left.path === right.path;
  return true;
}

/**
 * 是否需要等比压缩（需求 F4.3：长边超 4096px）。
 *
 * 返回**缩放比例**而不是"要不要缩"：调用方拿它就够画 canvas 了，
 * 不必再算一遍（两处各算一次是最容易不一致的地方）。
 */
export function faceScale(width: number, height: number, maxEdge = FACE_MAX_EDGE): number {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return 1;
  return maxEdge / longest;
}

/** 压缩后的尺寸（向上取整，至少 1px） */
export function scaledSize(
  width: number,
  height: number,
  maxEdge = FACE_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const scale = faceScale(width, height, maxEdge);
  if (scale === 1) return { width, height, scaled: false };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaled: true,
  };
}

/**
 * 这张图要不要重新编码成 PNG 容器（需求 F4.3）。
 *
 * 判据是**扩展名**而不是内容嗅探：png 原样塞块（零重编码，D1 的核心承诺），
 * 其余（jpg/webp）必须经 canvas 转一次 —— 那一次是用户主动选择的结果，允许重编码。
 *
 * 注意 `.jpeg` 与 `.jpg` 都要认：Windows 上两种都存在。
 */
export function needsPngConversion(fileName: string): boolean {
  return !fileName.toLowerCase().endsWith('.png');
}
