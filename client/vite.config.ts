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
    emptyOutDir: true,
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
