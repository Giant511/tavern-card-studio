package com.taverncardstudio.client

import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowInsets
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.taverncardstudio.client.stengine.StBridge

/**
 * 安卓端主 Activity。
 *
 * ## 这里做两件事，都跟 T15.3 有关
 *
 * 1. **注入引擎桥**（`onWebViewCreate`）—— 让移动端 UI 能点「开始聊天」
 *    拉起前台服务；
 * 2. **处理 edge-to-edge 的状态栏内边距** —— `enableEdgeToEdge()` 让内容
 *    从 y=0 开始画，而 WebView 的 `env(safe-area-inset-top)` 在 Android 上
 *    解析为 **0**，于是顶栏标题被状态栏图标压住。
 *
 * ## 为什么第 2 条必须在这儿做，不能只在 CSS 里兜
 *
 * CSS 侧已经写了 `max(env(safe-area-inset-top, 0px), 24px)`（第四批的兜底），
 * 但那只是"不重叠"：有挖孔/刘海的机型状态栏不是 24dp，兜底会偏。
 * 真实值只有 Android 侧知道（`WindowInsets`），所以这里把它算出来、
 * 以 CSS 变量的形式注入 —— CSS 那边读 `--nb-safe-top` 即可。
 */
class MainActivity : TauriActivity() {

  companion object {
    private const val TAG = "MainActivity"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /*
     * 启动时把引擎拉起来（设计文档 §5.4：App 启动拉起）。
     *
     * 注意这**不代表立刻解包 437 MB** —— 服务内部会先看
     * `isUnpacked()`，已解过就直接起 node。首启才会走解包那条路。
     *
     * 为什么在 onCreate 就起而不是等用户点「开始聊天」：
     * 冷启动 ST 要 8–14 秒。等用户点了再起，他会在聊天页干等十几秒；
     * 提前起则他选角色、看卡片列表的时间刚好覆盖掉。
     * 用户明确不想跑时，通知里有「停止」。
     */
    try {
      com.taverncardstudio.client.stengine.StService.start(this)
    } catch (error: Throwable) {
      /*
       * Android 12+ 在"应用在后台"时禁止起前台服务
       * （`ForegroundServiceStartNotAllowedException`）。onCreate 时应用
       * 一定在前台，理论上不会撞，但捕获一下 —— 漏出去就是启动即崩。
       */
      Log.e(TAG, "启动引擎服务失败", error)
    }
  }

  /**
   * WebView 创建完成 —— 注入引擎桥。
   *
   * ## 为什么在这个钩子里注入
   *
   * Tauri 2 的 `RustWebView` 由生成代码创建，外部拿不到引用。
   * `onWebViewCreate` 是官方给的唯一钩子，在这里 `addJavascriptInterface`
   * 最稳（早于页面脚本执行，所以 `window.__ST_ENGINE__` 一定可用）。
   *
   * ## 安全边界
   *
   * `StBridge` 只暴露 start / stop / status 三个窄方法（见其注释）。
   * 特别注意**没有**暴露"执行命令"或"传端口" —— 页面里跑了第三方脚本
   * 也不能借它越权。
   */
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)

    /*
     * 第二个参数是"把一段 JS 送进页面"的通道，异步 HTTP 用它回传结果。
     *
     * ★ 必须 `webView.post { … }`：`httpRequestAsync` 的回调来自后台线程，
     * 而 `evaluateJavascript` 只能在创建 WebView 的那个线程上调。
     */
    webView.addJavascriptInterface(
      StBridge(applicationContext) { script ->
        webView.post { webView.evaluateJavascript(script, null) }
      },
      StBridge.JS_NAME,
    )
    Log.i(TAG, "已注入 ${StBridge.JS_NAME}")

    /*
     * ★★★ 放开混合内容（2026-11-04，T15.2 阶段 A 真机抓到的真缺陷）。
     *
     * ## 现象
     *
     * 仓库 Tab 里点登录 → `TypeError: Failed to fetch`，而同一个地址
     * 在电脑上用 curl 完全正常、手机 `ping` 也通（43ms）。
     *
     * ## 真因
     *
     * 这个 App 的页面是从 **`http://tauri.localhost`** 加载的
     * （Tauri 在 Android 上把资源走明文 localhost 提供）。
     * WebView 的默认混合内容模式是 `MIXED_CONTENT_NEVER_ALLOW` ——
     * **http 页面里发起的任何 https 请求都会被拦**。
     *
     * 报错是 `Failed to fetch`（网络层错误），看起来像"服务器连不上"，
     * 实际请求根本没发出去。这类"报错指向错误的原因"最难查。
     *
     * ## 为什么允许
     *
     * 一个 HTTP 页面**发往 HTTPS** 是被拦的，但这里被拦的恰恰是**升级**
     * 而非降级 —— 用户的卡片要传到自己指定的仓库服务上，而页面自身
     * 是本地资源（没有网络攻击面：内容全部来自 APK 内置文件）。
     *
     * 反过来说：不放开的话，**仓库功能在任何设备上都用不了**，
     * 而界面上只会显示"连不上服务端"。
     *
     * ★ 仍然保持 `MIXED_CONTENT_COMPATIBILITY_MODE` 而不是
     * `ALWAYS_ALLOW`：前者只放开"http 页面 → https 资源"，
     * 后者会连"https 页面 → http 资源"也放开（那是真正的降级风险）。
     */
    webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

    /*
     * 把真实状态栏 / 导航栏高度注入成 CSS 变量。
     *
     * ★★★ 2026-11-04 修：这一段原来只有 `webView.post { injectSafeArea(...) }`，
     * 而那时**页面还没加载**（WebView 刚创建，还是空白）。
     *
     * 后果有两层：
     *
     * ```text
     *   ① 当次执行：document.documentElement 可能是 null ⇒ 脚本静默失败
     *   ② 即使成功：页面一导航就换了一个新 document，
     *      documentElement.style 上写的东西**全部丢失**
     * ```
     *
     * 真机实测（CDP 读 `getPropertyValue('--nb-safe-top')`）：
     * **空字符串** —— 说明注入从来没成功过。顶部之所以没出问题，
     * 是因为 CSS 写了 `max(..., 24px)` 兜底；底部没有兜底，于是被手势条压住。
     *
     * 这是"兜底掩盖了 bug"的典型：兜底值让界面看起来对，
     * 真正的机制（读真实 inset）一直是坏的。
     *
     * 现在改成**多次延迟注入**：页面加载是异步的，拿不到"加载完成"回调
     * 就按时间点打几次（脚本幂等，重复写同样的值没有副作用）。
     */
    scheduleSafeAreaInjection(webView)

    /*
     * ★ 把软键盘高度注入成 CSS 变量（2026-11-01 第七批问题三）。
     *
     * ## 为什么必须从 Android 侧拿
     *
     * 真机实测（本机型，Android + 本项目 WebView）：
     *
     * ```text
     * focusin 触发、document.activeElement = TEXTAREA   ← 输入框确实聚焦了
     * window.innerHeight    851 → 851                    ← 没变
     * visualViewport.height 851 → 851                    ← 也没变
     * ```
     *
     * 也就是说：**这个 WebView 的软键盘是纯 overlay**，
     * JS 侧任何"视口"信号都拿不到键盘高度。
     *
     * 而 `enableEdgeToEdge()` 让 window 不再随 IME 缩放（这是 edge-to-edge 的定义），
     * 所以 `adjustResize` 那条路也走不通。键盘高度**只存在于 `WindowInsets` 里**。
     *
     * ## 为什么用 `Type.ime()` 而不是 `systemWindowInsetBottom`
     *
     * 后者在键盘弹起时确实包含键盘，但它同时混着导航栏/手势条 ——
     * 分不清"键盘 300 + 手势条 20"与"键盘 320"。而 `Type.ime()`（API 30+）
     * 只给键盘本身。低版本退回 `systemWindowInsetBottom`（那里没有更细的 API）。
     *
     * ## 为什么变量名与 JS 那个分开
     *
     * JS 侧（`keyboard-inset.ts`）也往 `--nb-kb-inset` 写值。两条路都写同一个变量
     * 会互相覆盖：本机型 JS 算出 0，会把这个 300 擦掉。
     * 所以 Android 写 `--nb-kb-inset-native`，CSS 里取两者 `max()` ——
     * 谁有值用谁，谁失效由另一个补上。
     *
     * ## 不消费 insets
     *
     * 最后要 `return insets`（不调 `insets.consumeSystemWindowInsets()`）：
     * 消费掉会让子 view 收不到，状态栏那边已经算好的 padding 也会失效。
     */
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      webView.setOnApplyWindowInsetsListener { view, insets ->
        val density = resources.displayMetrics.density
        val imePx = insets.getInsets(WindowInsets.Type.ime()).bottom
        val imeDp = if (density > 0f) (imePx / density).toInt() else 0

        /*
         * ★★★ 底部安全区（2026-11-04，用户报"红米上白色手势条压住 Tab 栏"）。
         *
         * ## 真因
         *
         * 顶部一直有 `--nb-safe-top` 注入，底部却只写了
         * `padding-bottom: env(safe-area-inset-bottom, 0px)` ——
         * 而这个 WebView 里 `env(safe-area-inset-*)` **恒为 0**
         * （顶部那条注释早就记过这件事，但底部没有跟着修）。
         *
         * 于是：Tab 栏 padding-bottom = 0 ⇒ 高度 = 56dp，
         * 而手势条是**透明覆盖层**，直接压在 Tab 栏上。
         *
         * 为什么 iQOO 上没露出来：那台可能是三键导航（虚拟键区不透明、
         * 且系统没把内容延到那里），或者它对透明手势条的处理不同。
         * 换句话说这不是"某台机器坏了"，而是**依赖系统行为**的脆弱写法。
         *
         * ## 为什么读 navigationBars 而不是写死高度
         *
         * 手势导航约 24dp、三键导航约 48dp、横屏时三键在**侧面**（bottom=0）。
         * 写死任何一个都会在另一种形态下错。
         *
         * ## 键盘弹起时归 0 是**正确**的
         *
         * IME 显示时系统把导航栏算进键盘区域，`navigationBars` 的 bottom
         * 会变成 0 —— 此时 Tab 栏紧贴键盘上方正是我们要的，
         * 不该再额外留一条手势条的空隙。
         */
        val navPx = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
        val navDp = if (density > 0f) (navPx / density).toInt() else 0

        /*
         * 顺手把状态栏也读一遍 —— 这个值比 `status_bar_height` 资源准
         * （挖孔机的真实 inset 不是 24dp）。
         */
        val statusPx = insets.getInsets(WindowInsets.Type.statusBars()).top
        val statusDp = if (density > 0f) (statusPx / density).toInt() else 0

        /* 更新缓存：之后任何时刻补注入都用最新的真值 */
        if (statusDp > 0) safeTopDp = statusDp
        safeBottomDp = navDp

        val script = buildString {
          append("document.documentElement.style.setProperty('--nb-kb-inset-native','${imeDp}px');")
          append("document.documentElement.style.setProperty('--nb-safe-bottom','${navDp}px');")
          if (statusDp > 0) {
            append("document.documentElement.style.setProperty('--nb-safe-top','${statusDp}px');")
          }
        }
        (view as? WebView)?.evaluateJavascript(script, null)
        insets
      }
      webView.requestApplyInsets()
      Log.i(TAG, "已挂上 IME inset 监听（API ${Build.VERSION.SDK_INT}）")
    } else {
      /*
       * API 30 以下没有 `Type.ime()`。
       *
       * 不猜、不退回 `systemWindowInsetBottom`（那里混着导航栏，会多扣）。
       * 老设备上 `--nb-kb-inset-native` 始终为空 ⇒ CSS 的 `max()` 取 JS 那个，
       * 行为退回"修之前"，**不会更差**。如实记录这条边界。
       */
      Log.w(TAG, "API ${Build.VERSION.SDK_INT} < 30，无法精确读键盘高度，键盘避让仅靠 JS 侧")
    }
  }

  /**
   * 安全区高度缓存（dp）。
   *
   * 为什么要缓存：`WindowInsets` 只在系统栏变化时回调一次，而页面加载
   * 是另一条时间线。缓存下来就能在**任何时刻**把已知值补写到当前 document 上，
   * 不必等下一次 insets 回调。
   *
   * -1 表示"还不知道"（还没读过 insets），此时不注入，交给 CSS 兜底。
   */
  private var safeTopDp = -1
  private var safeBottomDp = -1

  /**
   * 按时间点多次注入安全区（2026-11-04）。
   *
   * ## 为什么是"多次"而不是"一次"
   *
   * `onWebViewCreate` 时页面还是空白；真正的 document 在导航后才出现。
   * 而我们没有"页面加载完成"的可靠回调（`setWebViewClient` 会顶掉 Tauri 自己的）。
   *
   * 所以按时间点打几次：300ms（首屏）、1200ms（DOM 就绪）、
   * 3000ms / 6000ms（慢机 / 二次导航）。
   *
   * 脚本是幂等的（`setProperty` 写同一个值无副作用），重复执行没有代价。
   * 这比"想办法精确知道加载完成"更简单，也更不容易在别的机型上失效。
   */
  private fun scheduleSafeAreaInjection(webView: WebView) {
    /* 先立刻算一次（资源值足够，不必等 insets） */
    val density = resources.displayMetrics.density
    val statusBarPx = statusBarHeightPx()
    if (safeTopDp < 0 && statusBarPx > 0 && density > 0f) {
      safeTopDp = (statusBarPx / density).toInt()
    }
    val navBarPx = systemBarHeightPx("navigation_bar_height")
    if (safeBottomDp < 0 && navBarPx > 0 && density > 0f) {
      safeBottomDp = (navBarPx / density).toInt()
    }

    for (delay in longArrayOf(0L, 300L, 1_200L, 3_000L, 6_000L)) {
      webView.postDelayed({ injectSafeArea(webView) }, delay)
    }
  }

  /** 读真实状态栏 / 导航栏高度，写给 CSS */
  private fun injectSafeArea(webView: WebView) {
    val density = resources.displayMetrics.density

    /* 还没读过 insets 时用资源值补一次（只补"不知道"的那一项） */
    if (safeTopDp < 0) {
      val px = statusBarHeightPx()
      if (px > 0 && density > 0f) safeTopDp = (px / density).toInt()
    }
    if (safeBottomDp < 0) {
      val px = systemBarHeightPx("navigation_bar_height")
      if (px > 0 && density > 0f) safeBottomDp = (px / density).toInt()
    }

    /* 一个都不知道就不写 —— 交给 CSS 兜底，避免写入 -1px 这种脏值 */
    if (safeTopDp < 0 && safeBottomDp < 0) {
      Log.w(TAG, "状态栏/导航栏高度都拿不到，依赖 CSS 兜底")
      return
    }

    val script = buildString {
      if (safeTopDp >= 0) {
        append("document.documentElement.style.setProperty('--nb-safe-top','${safeTopDp}px');")
      }
      if (safeBottomDp >= 0) {
        append("document.documentElement.style.setProperty('--nb-safe-bottom','${safeBottomDp}px');")
      }
    }
    webView.evaluateJavascript(script, null)
    Log.i(TAG, "注入安全区：top=${safeTopDp}px bottom=${safeBottomDp}px")
  }

  /**
   * 状态栏高度（px）。
   *
   * 优先用资源值，拿不到退回 24dp 估算。
   */
  private fun statusBarHeightPx(): Int {
    val fromRes = systemBarHeightPx("status_bar_height")
    if (fromRes > 0) return fromRes

    // 兜底 24dp
    return (24 * resources.displayMetrics.density).toInt()
  }

  /**
   * 某个系统栏的高度（px），读 `android` 包里的 dimen 资源。
   *
   * 拿不到返回 0 —— 调用方要知道"不知道"，而不是拿一个假值当真值。
   * （`status_bar_height` / `navigation_bar_height` 是 Android 的隐藏资源，
   * 绝大多数机型都有，但**不是公开 API**，所以必须容忍拿不到。）
   */
  private fun systemBarHeightPx(resName: String): Int {
    val resId = resources.getIdentifier(resName, "dimen", "android")
    if (resId <= 0) return 0

    val fromRes = resources.getDimensionPixelSize(resId)
    return if (fromRes > 0) fromRes else 0
  }
}
