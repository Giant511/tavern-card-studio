/**
 * 内置兜底卡面（2026-11-04，T15.2 导入用）。
 *
 * ## 用桌面端那一张，不另造
 *
 * 用户要求：**「兜底图用桌面端的那张兜底图就行了」**。
 *
 * 桌面端那张是 `client/src-tauri/resources/card-face-default.png`
 * （768×1024，891 KB），由 `tauri.conf.json` 的 `bundle.resources` 打进安装包。
 * 已核实 APK 里确实有 `assets/card-face-default.png` —— 所以移动端**不需要**
 * 再打包一份，只是取不到而已（WebView 没有读 assets 的能力）。
 *
 * 两端共用同一张的理由不只是"省一个文件"：仓库里的卡可能没有卡面资产
 * （`GET /api/cards/:id/face` 会 404），那时导入进来的卡用什么图，
 * 直接决定用户在角色库里看到的样子。两端各造一张，迟早一边换了另一边没换。
 *
 * ## 为什么走桥而不是 fetch
 *
 * 这个壳里 fetch / XHR 完全不可用（连 `http://127.0.0.1` 都 `Failed to fetch`），
 * `assets:` 协议也不对渲染层开放。所以走 Kotlin 的 `readAsset()`
 * ——白名单接口，只认 `card-face-default.png`，不接受任意路径。
 *
 * ## 缓存
 *
 * 891 KB 的字节，每次导入都跨 JNI 取一遍没有意义。这里按进程缓存。
 * 缓存的是**字节**不是 base64 —— 解码后的字节才是 `buildPngCard` 要的东西，
 * 保留 base64 字符串等于把 1.2 MB 的字符串再留一份。
 */

/** 桥里那个方法的最小形状（便于单测注入） */
export interface AssetBridge {
  readAsset: (name: string) => string;
}

/** 资源名。必须与 Kotlin 侧 `READABLE_ASSETS` 一致 */
export const DEFAULT_FACE_ASSET = 'card-face-default.png';

/** 进程内缓存：解码后的字节 */
let cached: Uint8Array | null = null;

/** base64 → 字节。atob 不可用时抛错（不静默返回空数组） */
function decodeBase64(text: string): Uint8Array {
  const atobFn = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof atobFn !== 'function') throw new Error('这台设备缺少 base64 解码能力');

  const binary = atobFn(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** 探一下桥在不在（浏览器/测试环境没有它） */
function findBridge(): AssetBridge | null {
  const raw = (globalThis as { __ST_ENGINE__?: Partial<AssetBridge> }).__ST_ENGINE__;
  if (typeof raw?.readAsset !== 'function') return null;
  return raw as AssetBridge;
}

/**
 * 取内置兜底卡面的字节。
 *
 * 拿不到就**抛错**，不退回一张纯色图。理由：这是安装包资源缺失，
 * 是"打包打错了"，不是用户操作问题。静默给张纯色图会让这张卡在角色库里
 * 看起来像"导入成功但封面丢了"，而真正的原因（资源没打进包）永远看不到。
 */
export async function readDefaultFaceBytes(): Promise<Uint8Array> {
  if (cached !== null) return cached;

  const bridge = findBridge();
  if (bridge === null) throw new Error('这台设备读不到内置卡面（缺少桥能力）');

  let parsed: { ok?: boolean; base64?: string; error?: string; bytes?: number } = {};
  try {
    parsed = JSON.parse(bridge.readAsset(DEFAULT_FACE_ASSET)) as typeof parsed;
  } catch {
    throw new Error('内置卡面读取失败（返回的不是有效数据）');
  }

  if (parsed.ok !== true || typeof parsed.base64 !== 'string' || parsed.base64 === '') {
    throw new Error(parsed.error ?? '内置卡面读取失败');
  }

  const bytes = decodeBase64(parsed.base64);
  if (bytes.length === 0) throw new Error('内置卡面是空的');
  cached = bytes;
  return bytes;
}

/** 测试/换包时清缓存 */
export function clearDefaultFaceCache(): void {
  cached = null;
}
