/**
 * 「关于」区块的内容（2026-11-18，合规要求）。
 *
 * ## ★★ 为什么必须区分平台
 *
 * 两个客户的实情完全不同，混着写就是对其中一方说假话：
 *
 * ```text
 * 桌面端（Windows / MSI）  **不内置** SillyTavern。用户想联动就自己装一个，
 *                          我们通过它的 HTTP API 连接 —— 那是互操作，不涉及
 *                          AGPL 分发。所以桌面端的「关于」**不该提 ST**，
 *                          也不该给 ST 源码地址（那会让人以为我们打包了它）。
 *
 * 安卓端（APK）            **内置** SillyTavern 1.19.0 完整源码（assets/st.zip）。
 *                          这是 AGPL-3.0 组件，必须给对应源码地址。
 * ```
 *
 * 2026-11-18 第一版把两者的文案写成了一份，导致桌面端的设置页里出现
 * 「内置引擎 SillyTavern」—— 桌面端根本没有这回事。用户当场指出。
 *
 * 所以本模块的形态是：**公共部分（版本 + 本应用源码 + 第三方声明）共用，
 * ST 部分是安卓端专属的可选块**。调用方按平台决定传不传。
 *
 * ## 为什么不 import `app-version`
 *
 * `app-version.ts` 靠 Vite 把 `client/package.json` 内联进来。Node 的 ESM 对
 * JSON 要求 `import ... with { type: 'json' }`，所以那个模块在纯 Node 里跑不起来
 * —— 判据就测不到本模块了。折中：`version` 作为入参，由调用方给。
 */

/** 上游仓库（本应用） */
export const REPO_URL = 'https://github.com/Giant511/tavern-card-studio';

/** 内置的 SillyTavern 版本（仅安卓端；与 `scripts/pack-st-assets.mjs` 的打包源一致） */
export const BUNDLED_SILLYTAVERN_VERSION = '1.19.0';

/** SillyTavern 上游 */
export const SILLYTAVERN_URL = 'https://github.com/SillyTavern/SillyTavern';

/**
 * 本应用**这一版**的源码归档地址。
 *
 * GitHub 对每个 tag 自动生成 `Source code (zip)`，不需要我们额外上传。
 * 注意它只包含**我们自己的代码**，不含 `assets/st.zip`（构建产物，已被 gitignore）。
 */
export function appSourceUrl(version: string): string {
  return `${REPO_URL}/archive/refs/tags/v${version}.zip`;
}

/** 这一版 Release 页面（资产都挂在这里） */
export function releasePageUrl(version: string): string {
  return `${REPO_URL}/releases/tag/v${version}`;
}

/**
 * SillyTavern 对应源码的地址（**仅安卓端需要**）。
 *
 * 优先指向本版 Release 资产里那个 zip —— 与 APK 同页，最省事。
 * 若某版漏传，用户还能退到上游 tag（见下）。
 */
export function sillytavernSourceUrl(version: string): string {
  return (
    `${releasePageUrl(version)}/download/` +
    `sillytavern-${BUNDLED_SILLYTAVERN_VERSION}-source.zip`
  );
}

/** 上游 tag（兜底：Release 资产缺失时仍能拿到对应源码） */
export function sillytavernUpstreamTagUrl(
  stVersion: string = BUNDLED_SILLYTAVERN_VERSION,
): string {
  return `${SILLYTAVERN_URL}/tree/v${stVersion}`;
}

/** 一条可点的外链 */
export interface AboutLink {
  /** 左侧小字标签 */
  label: string;
  /** 链接上的文字 */
  text: string;
  /** 完整地址（也放进 title，便于复制） */
  url: string;
}

export interface AboutInfo {
  /** 应用版本，如 `0.2.0` */
  version: string;
  /** 一句话说明许可格局（随平台不同） */
  summary: string;
  /** 要显示的链接（按顺序） */
  links: AboutLink[];
  /** 补充说明（可为空数组） */
  notes: string[];
}

/** 公共部分：任何平台都该有的两条 */
function commonLinks(version: string): AboutLink[] {
  return [
    {
      label: '本版源码',
      text: `Tavern Card Studio v${version} 源码（zip）`,
      url: appSourceUrl(version),
    },
    {
      label: '本版 Release',
      text: `v${version} 发布页（含全部资产）`,
      url: releasePageUrl(version),
    },
  ];
}

/**
 * 桌面端（Windows / MSI）的「关于」。
 *
 * **不提 SillyTavern** —— 桌面端没内置它。用户自己装 ST 属于互操作，
 * 不产生任何分发义务，写进「关于」反而会误导。
 */
export function desktopAbout(version: string): AboutInfo {
  return {
    version,
    summary:
      '本项目自身的代码以 MIT 许可发布。安装包内含 Node.js 运行时与若干 MIT / ' +
      'Apache-2.0 依赖，完整清单与各自许可见第三方声明。',
    links: [
      ...commonLinks(version),
      {
        label: '第三方声明',
        text: 'THIRD-PARTY-NOTICES（全部依赖与许可）',
        url: `${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md`,
      },
    ],
    notes: [
      '桌面端**不内置** SillyTavern。如果你想联动它，请自行安装后在本应用的' +
        '「设置 › SillyTavern 地址」里填上它的地址。',
    ],
  };
}

/**
 * 安卓端（APK）的「关于」。
 *
 * 必须说清「内置了 AGPL 组件 + 它的源码在哪」—— 这是 AGPL-3.0 §6 的义务。
 */
export function androidAbout(version: string): AboutInfo {
  return {
    version,
    summary:
      `本项目自身的代码以 MIT 许可发布。本安装包**内置了以 AGPL-3.0 许可的组件**` +
      `（SillyTavern ${BUNDLED_SILLYTAVERN_VERSION}，作为聊天引擎），其对应源码可按下述地址获取。`,
    links: [
      ...commonLinks(version),
      {
        label: '内置引擎源码',
        text: `SillyTavern ${BUNDLED_SILLYTAVERN_VERSION} 源码（AGPL-3.0）`,
        url: sillytavernSourceUrl(version),
      },
      {
        label: '上游兜底',
        text: `SillyTavern 上游 v${BUNDLED_SILLYTAVERN_VERSION}`,
        url: sillytavernUpstreamTagUrl(),
      },
      {
        label: '第三方声明',
        text: 'THIRD-PARTY-NOTICES（全部依赖与许可）',
        url: `${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md`,
      },
    ],
    notes: [
      `内置引擎 SillyTavern ${BUNDLED_SILLYTAVERN_VERSION} 未作修改，原样随包分发；` +
        '本版 Release 资产里同时提供它的源码 zip。',
    ],
  };
}
