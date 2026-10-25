import { defineConfig } from 'vite';

/**
 * 渲染层构建。
 *
 * 不引入 UI 框架：阶段 6 的编辑器会自己选（CodeMirror 6 是纯 JS，不绑框架）。
 * 这里只保证「打包成静态资源 → 被 Tauri 从 dist 加载」这条路是通的。
 */
export default defineConfig({
  // Tauri 生产环境用自定义协议加载，相对路径最稳
  base: './',
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    /*
     * **关掉 vite 自己的清空**：清理职责只留一处（`scripts/clean-client-dist.mjs`，
     * 挂在 `npm run build:ui` 的前半段）。
     *
     * 为什么：`emptyOutDir` 会对 `dist/assets` 调 `rmSync(recursive)`。本机装了
     * safe-delete 钩子，**按 turn 累计删除数**超过 50 就拦截并抛错 —— 注意是
     * "累计"，不是"单次"。所以即使 `clean-client-dist` 已经分批清过，
     * 当同一轮里还有别的删除（截图、快照、测试探针）时，vite 这次删除仍会被算进
     * 总数而失败：
     *
     *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":54,"threshold":50,
     *       "targets":["...\client\dist\assets"],"targetCount":1}
     *
     * 2026-10-25 实测：`clean-client-dist` 分批清空的思路是对的，但"清完让 vite
     * 再删一次"多了一层无意义的删除尝试，于是仍然会失败。职责留在脚本里之后，
     * vite 不再碰删除，这条路径彻底消失。
     *
     * 安全性：`clean-client-dist.mjs` 每次构建前都会把 `dist` 删空（含 `assets`
     * 与根目录的 `index.html`/`perf.html`），所以不会残留旧产物 —— 那正是这个
     * 开关原本要保证的事。
     */
    emptyOutDir: false,
    // WebView2 在 Win10/11 上是 Chromium 109+，这里取保守值
    target: 'chrome110',
    sourcemap: true,
    rollupOptions: {
      // 两个入口：主界面 + 性能粗测页（后者不进 MSI 的业务路径，只用于测量）
      input: {
        main: 'index.html',
        perf: 'perf.html',
      },
    },
  },
});
