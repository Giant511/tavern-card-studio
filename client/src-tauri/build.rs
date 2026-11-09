fn main() {
    /*
     * ★ 前端资源变化必须让 build 重跑 —— 否则 Android 的 .so 里会保留旧前端。
     *
     * Tauri 2 在 **Android** 上把 `frontendDist`（`client/dist`）**嵌进
     * `libtcs_shell_lib.so`**（不是像桌面那样单独放资源目录）。
     * 嵌入发生在 `tauri_build::build()` 里，也就是 **build.rs 阶段**。
     *
     * 而 cargo 的规则是：只有「build.rs 本身变了」或「它声明过的文件变了」
     * 才重跑 build.rs。**改前端不会碰任何 Rust 源码** —— 于是：
     *
     *   改 CSS → npm run build:ui（dist 里 hash 从 CvhQVDo9 变成 DI7_8aP1）
     *          → cargo 认为 tcs-shell 无需重编，跳过
     *          → .so 里还是 rules-CvhQVDo9.css
     *          → 装到手机上：界面一点变化都没有，而构建**全绿**
     *
     * 2026-10-31 实测踩到：改完窄屏断点、重装 APK，界面纹丝不动。
     * 当时的绕法是"检测到过期就整轮重跑 tauri android build"，
     * 代价是每次都多编一次 Rust（release 要 17 分钟）。这条声明把那个代价去掉了。
     *
     * 为什么监视目录而不是单个文件：`clean-client-dist.mjs` 每次先归档旧 dist，
     * 再让 vite 生成**带新 hash 的文件名**。盯 `index.html` 也够，但盯目录更稳 ——
     * 少一个"新增了 xxx 资源但 index.html 没变"的漏网场景
     * （比如 rules CSS 被单独 chunk 出来时就是这样）。
     */
    println!("cargo:rerun-if-changed=../dist");

    tauri_build::build()
}
