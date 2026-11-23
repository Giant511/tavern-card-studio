package com.taverncardstudio.client

import android.app.ActivityManager
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.WindowInsets
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import com.taverncardstudio.client.stengine.StBridge
import com.taverncardstudio.client.stengine.StLog

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

    /** 崩溃取证用的偏好文件（与引擎配置分开：清配置时不该顺手清掉它） */
    private const val PREFS = "tcs.diag"

    /**
     * "上次是否正常退出"标记。
     *
     * `onCreate` 置 false、`onDestroy` 置 true —— 只有两个都走到，
     * 才说明这次会话是干净结束的。中间被杀就永远停在 false。
     */
    private const val KEY_CLEAN_EXIT = "cleanExit"

    /**
     * 任务数为 0 时的重试间隔（毫秒）。
     *
     * 递增是有意的：200ms 覆盖"任务马上就绪"，1500ms 覆盖 Tauri + WebView
     * 初始化特别慢的机型。三轮全部走完约 2.3 秒。
     */
    private val RECENTS_RETRY_DELAYS = longArrayOf(200L, 600L, 1500L)

    /** 通知权限请求码（`onRequestPermissionsResult` 里用它区分） */
    private const val REQUEST_NOTIFICATIONS = 4001
  }

  /** 重试用的主线程 Handler（`getAppTasks` 必须在主线程调） */
  private val recentsHandler = android.os.Handler(android.os.Looper.getMainLooper())

  /** 下一个待执行的重试；null 表示没有挂起的任务 */
  private var recentsRetry: Runnable? = null

  /** 已经重试到第几轮（成功或放弃后归零） */
  private var recentsRetryIndex = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    /*
     * ★★★ 日志必须在**一切之前**就绪（2026-11-12）。
     *
     * 用户报「进入 APP 后过一段时间自动闪退，哪怕没做任何操作」，
     * 而之前一条现场记录都拿不到：logcat 要数据线，JS 崩了之后页面里什么都不剩。
     *
     * 放在 `enableEdgeToEdge()` 之前 —— 那一步在个别机型上会抛
     * （窗口 inset 异常），放后面就抓不到那种启动期崩溃。
     */
    StLog.init(this)

    /*
     * ★★★ 第二条就要记版本号（2026-11-22 第三轮）。
     *
     * ## 为什么必须自证版本
     *
     * 同一个问题用户报了三轮、发了三份日志，我三次都在**猜"这是哪个构建的包"**：
     * 靠"日志里有没有某条诊断行"反推。前两份都没有特征，只能得出
     * "至少是某个提交之后"——这个结论不够用，而且推断错一次就会去修错地方
     * （这一轮我一开始就差点以为是新包没修好）。
     *
     * 记了版本号之后每份日志都自证来源，不用再反推。
     *
     * ## 为什么用 BuildConfig
     *
     * `VERSION_NAME` / `VERSION_CODE` 是编译期常量，不依赖 Context、
     * 不会抛异常。`app/build.gradle.kts:131` 已开 `buildConfig = true`。
     */
    StLog.i(
      "BOOT",
      "版本 ${BuildConfig.VERSION_NAME}（versionCode ${BuildConfig.VERSION_CODE}）",
    )

    StLog.i(
      "BOOT",
      "onCreate 开始：SDK ${Build.VERSION.SDK_INT}，" +
        "${Build.MANUFACTURER} ${Build.MODEL}，Android ${Build.VERSION.RELEASE}"
    )

    /*
     * ★ 堆预算（2026-11-13，用户报荣耀90 闪退之后加的）。
     *
     * ## 那份崩溃日志里唯一的硬信息
     *
     * ```text
     *   java.lang.OutOfMemoryError:
     *     Failed to allocate a 211839248 byte allocation
     *     with 186493872 free bytes and 177MB until OOM,
     *     target footprint 402653184, growth limit 402653184
     * ```
     *
     * 换算出来是：**一次要 202MB，当时只剩 178MB，上限 384MB
     * ⇒ 崩溃前已经用掉 206MB。**
     *
     * 但"206MB 用在哪""这台机的上限是多少""开机时还剩多少"——
     * 日志里**一个字都没有**。我们只能反算，不能验证。
     *
     * ## 这两行补的就是这个洞
     *
     * ```text
     *   上限 = maxMemory()      每台机不同（dalvik.vm.heapsize）
     *   已用 = total - free     开机基线；后续任何时刻可再记
     * ```
     *
     * 代价是两次 Runtime 调用（微秒级），只记一次。
     */
    run {
      val runtime = Runtime.getRuntime()
      StLog.i(
        "MEM",
        "堆上限 ${runtime.maxMemory() / 1024 / 1024}MB，" +
          "开机已用 ${(runtime.totalMemory() - runtime.freeMemory()) / 1024 / 1024}MB"
      )
    }

    /*
     * 记一条"上次是怎么退出的"。
     *
     * 依据：上次进程有没有走到 `onDestroy`。
     *
     * ```text
     *   走到过 onDestroy        ⇒ 正常退出
     *   没走到（标记还是 false） ⇒ 被系统回收 / 被杀 / 崩溃
     * ```
     *
     * 这一条与"同一时段有没有 CRASH 记录"配合，就能把「JS 崩了」
     * 「渲染进程被回收」「整个进程被系统清掉」三者分开 ——
     * 它们的修法完全不同，混在一起只能靠猜。
     */
    val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
    if (!prefs.getBoolean(KEY_CLEAN_EXIT, true)) {
      StLog.e(
        "BOOT",
        "上次进程没有正常退出（未走到 onDestroy）。" +
          "若上一条是 CRASH ⇒ 崩溃；若只有心跳中断 ⇒ 多半被系统回收或被杀。"
      )
    }
    /* 先置 false：只有这次真的走到 onDestroy 才会被改回 true */
    prefs.edit().putBoolean(KEY_CLEAN_EXIT, false).apply()

    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    /*
     * ★★★ 把本任务重新放回「最近任务」（2026-11-21，用户报切后台后任务列表看不到 App）。
     *
     * ## 现象
     *
     * ```text
     *   切到后台 → 上滑打开任务列表 → 看不到本 App 的卡片
     *   ⇒ 只能回桌面点图标才能重新进来
     * ```
     *
     * ## 为什么会出现
     *
     * 任务被打了 `FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS`。这个标志**不是我们显式设置**的，
     * 但会跟着启动入口进来：
     *
     * ```text
     *   ① 通知里的启动 Intent
     *      原实现用 packageManager.getLaunchIntentForPackage(packageName)，
     *      拿到的是**桌面启动器**那条 Intent。部分 ROM（实测同类机型 originOS6 /
     *      Android 16）会给它带上 EXCLUDE_FROM_RECENTS，因为桌面把这种启动当作
     *      「跳板」而不是「要留在后台的窗口」。
     *   ② 桌面图标本身
     *      少数 ROM 的启动跳板会把该标志一并带进主任务。
     * ```
     *
     * 标志一旦落到任务上就**一直有效** —— 之后从哪进都不显示，直到任务被销毁重建。
     * 这与"重启 App 就好了一阵、过几天又没了"的观感一致。
     *
     * ## 为什么用 `setExcludeFromRecents(false)` 兜底
     *
     * 我们**无法控制**桌面启动器传什么，也无法保证通知那条 Intent 在所有 ROM 上都干净。
     * 而 `ActivityManager.AppTask#setExcludeFromRecents` 是任务级开关，能在
     * 自己的进程里把结果改回来 —— 不管标志是谁带进来的。
     *
     * 放在 `onCreate` 与 `onResume` 两处：`onCreate` 覆盖冷启动，
     * `onResume` 覆盖"从后台回来时才发现被排除"的情况。方法本身幂等。
     */
    ensureRecentsVisible("onCreate")

    /*
     * ★★★ 请求通知权限（2026-11-22 第五轮）。
     *
     * ## 现场
     *
     * 加上 SERVICE 诊断后，真机日志第一次把这件事说清楚了：
     *
     * ```text
     *   SERVICE: 前台服务启动：通知权限=false SDK=36
     * ```
     *
     * **从来没授权过。** 清单里 `POST_NOTIFICATIONS` 早就声明了，
     * 但那是"我要用"，不是"已经给我" —— Android 13+ 必须**运行时请求**。
     *
     * ## 后果不只是"看不到通知"
     *
     * ```text
     *   ① 引擎的前台服务通知不显示 → 用户不知道引擎在跑，也没法从通知里停
     *   ② 部分 ROM（vivo 尤其激进）会把"有前台服务但通知不可见"的应用
     *      当成异常状态处理 —— 这恰好是本次排查一直怀疑的那一类
     *   ③ Android 14+ 的 FGS 类型申报在通知不可见时更容易被系统回收
     * ```
     *
     * ## 为什么只请求一次、失败也继续
     *
     * 权限被拒不该影响 App 能不能用 —— 引擎仍然工作，只是通知不可见。
     * 所以不阻塞、不重试、不提示二次弹窗（系统自己会处理"拒绝两次就不再弹"）。
     */
    requestNotificationPermissionIfNeeded()

    /*
     * 记 Activity 的进/退后台（2026-11-12）。
     *
     * ## 为什么这条重要
     *
     * 安卓上进程被系统清掉**绝大多数发生在后台**（前台服务也拦不住内存压力
     * 下的回收）。所以"什么时候进的后台、在里面待了多久"是判断
     * 「闪退 vs 后台被杀」的关键上下文。
     *
     * ## 为什么不用 `setWebViewClient` 的 `onRenderProcessGone`
     *
     * 那个回调能直接抓到渲染进程死亡，但 `setWebViewClient` 会**顶掉
     * Tauri 自己的 client**（本文件后面那条注释记的就是这个坑），
     * 顶掉后页面加载、资源拦截全部失常。
     *
     * 所以放弃那个钩子，改用生命周期 + JS 侧心跳来推断 ——
     * 损失一点精度，换来不破坏 WebView 本身。
     */
    registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: android.app.Activity) {
        if (activity === this@MainActivity) StLog.i("LIFE", "进入前台")
      }

      override fun onActivityStopped(activity: android.app.Activity) {
        if (activity === this@MainActivity) StLog.i("LIFE", "退到后台")
      }

      override fun onActivityCreated(activity: android.app.Activity, state: Bundle?) = Unit
      override fun onActivityResumed(activity: android.app.Activity) = Unit
      override fun onActivityPaused(activity: android.app.Activity) = Unit
      override fun onActivitySaveInstanceState(activity: android.app.Activity, state: Bundle) = Unit
      override fun onActivityDestroyed(activity: android.app.Activity) = Unit
    })

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
   * 确保本任务出现在「最近任务」里（2026-11-21 首次，2026-11-22 修）。
   *
   * ## 0.2.1 那版为什么没修好（2026-11-22 用户反馈）
   *
   * 用户原话：
   *
   * > 安装修复版本后很奇怪，退出后还是不在运行列表里面，但是我打开 vivo 系统的
   * > 隐私空间（本质是一个隔离的系统，类似于多系统这种）里面的软件后再上滑它就又有了
   *
   * 只在 `onCreate` / `onResume` 调一次是不够的，具体有两层原因：
   *
   * ```text
   * ① `getAppTasks()` 可能返回空
   *    它查的是"本应用已存在的任务"。`onCreate` 时任务还在建立过程中，
   *    Tauri 的初始化又慢（要起 WebView），`onResume` 也常常还拿不到。
   *    拿不到就静默返回 —— 一次都没设成，而日志里只有一行"任务数为 0"。
   *
   * ② 切后台的那一刻没有任何调用
   *    任务是**在 Activity 停止之后**才被归档进最近任务的。如果厂商 ROM
   *    在那一步重新套用启动 Intent 的标志，我们之前设的 false 会被覆盖。
   * ```
   *
   * 用户观察到的"打开隐私空间里的软件再回来就出现了"正好对应这两条：
   * 隐私空间是另一个 Android 用户，来回切换会让本 Activity **销毁重建** ——
   * 第二次 `onCreate` 时任务已经存在，于是那一次设置成功了。
   *
   * ## 现在的做法
   *
   * ```text
   * 时机：onCreate / onResume / onPause / onUserLeaveHint 四处
   * 重试：任务数为 0 时按 200ms / 600ms / 1500ms 三轮补设
   * 日志：每次都写明"设了几个任务"或"为什么没设成"
   * ```
   *
   * `onUserLeaveHint` 是 AOSP 里"用户主动离开（按 Home / 上滑）"的钩子，
   * 比 `onPause` 更贴近"要进最近任务"那一刻，所以两个都挂。
   *
   * @param stage 日志里的来源标记，用于区分是哪一处触发
   * @return 是否设置成功（任务存在且没抛异常）
   */
  private fun clearRecentsExclusion(stage: String): Boolean {
    return try {
      val am = getSystemService(ActivityManager::class.java)
      if (am == null) {
        StLog.w("RECENTS", "$stage：拿不到 ActivityManager")
        return false
      }
      val tasks = am.appTasks
      if (tasks.isEmpty()) {
        StLog.w("RECENTS", "$stage：拿不到本应用的任务（任务数为 0）")
        return false
      }
      for (task in tasks) {
        task.setExcludeFromRecents(false)
      }
      StLog.i(
        "RECENTS",
        "$stage：已确保 ${tasks.size} 个任务不排除在最近任务之外${describeTasks(tasks)}",
      )
      true
    } catch (error: Throwable) {
      /* 典型是 SecurityException（部分 ROM 限制） */
      StLog.w("RECENTS", "$stage：设置失败：${error.javaClass.simpleName} ${error.message}")
      false
    }
  }

  /**
   * 把任务的真实状态打出来（2026-11-22 第四轮）。
   *
   * ## 为什么必须看 `baseIntent` 而不是 `this.intent`
   *
   * `this.intent` 是**本 Activity 收到的那个 Intent**，而最近任务界面读的是
   * **任务根 Intent**（`RecentTaskInfo.baseIntent`）。两者可能不同：
   *
   * ```text
   *   桌面点图标 → 任务以桌面那条 Intent 为根
   *   之后我们从通知进入 → 只是给同一个任务追加一条 Intent
   * ```
   *
   * 用户的现象是"任务存在、Activity 没被销毁、也没有 onTaskRemoved，
   * 但最近任务里就是没有卡片"。这时唯一还能查的就是：
   * **任务根 Intent 上到底有没有 `FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS`。**
   *
   * `setExcludeFromRecents(false)` 会不会真的清掉根 Intent 的标志，
   * 各家 ROM 实现不一样 —— 这一行日志就是答案。
   *
   * ## 另外两个字段的含义
   *
   * ```text
   *   numActivities=0   ⇒ 任务里没有界面（正常应该 ≥1，我们是单 Activity）
   *   affiliatedTaskId  ⇒ 与别的任务关联时非 -1，那种任务可能被合并显示
   * ```
   */
  private fun describeTasks(tasks: List<ActivityManager.AppTask>): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return ""
    return try {
      val parts = tasks.map { task ->
        val info = task.taskInfo
        val flags = info.baseIntent?.flags ?: 0
        val excluded = (flags and android.content.Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS) != 0
        "id=${info.id} 界面数=${info.numActivities} 根Intent带排除位=$excluded"
      }
      "（${parts.joinToString("；")}）"
    } catch (error: Throwable) {
      /* 拿不到就不影响主流程 —— 这只是诊断 */
      "（任务详情读取失败：${error.javaClass.simpleName}）"
    }
  }

  /**
   * 请求通知权限（Android 13+）。
   *
   * 见 `onCreate` 里的调用点注释：清单声明不等于已授权，
   * 真机日志证明一直是 `通知权限=false`。
   *
   * 只请求一次：被拒之后由系统决定还要不要弹（连续拒绝两次后系统不再弹）。
   * 我们不重复请求，也不弹自己的引导 —— 通知是辅助信息，
   * 引擎本身不依赖它。
   */
  private fun requestNotificationPermissionIfNeeded() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val permission = android.Manifest.permission.POST_NOTIFICATIONS
    if (checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
      StLog.i("SERVICE", "通知权限已授予")
      return
    }
    try {
      StLog.i("SERVICE", "通知权限未授予，请求一次")
      requestPermissions(arrayOf(permission), REQUEST_NOTIFICATIONS)
    } catch (error: Throwable) {
      /* 个别 ROM 上 requestPermissions 会抛；权限失败不影响 App 可用 */
      StLog.w("SERVICE", "请求通知权限失败：${error.javaClass.simpleName} ${error.message}")
    }
  }

  /**
   * 权限结果只记日志。
   *
   * 不在这里做任何引导或重试 —— 用户拒绝是合理选择，
   * 我们只想知道下一份日志里这个值是什么。
   */
  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_NOTIFICATIONS) return
    val granted = grantResults.isNotEmpty() &&
      grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
    StLog.i("SERVICE", "通知权限请求结果：${if (granted) "已授予" else "被拒绝"}")
  }

  /**
   * 主动刷新任务卡片（2026-11-22 第四轮）。
   *
   * ## 为什么在"标志已经正确"之后还需要这一步
   *
   * 第四份日志把这几种可能都排掉了：
   *
   * ```text
   *   12:17:15.396 退到后台
   *   12:20:03.931 进入前台        ← 中间 2 分 48 秒
   * ```
   *
   * ```text
   *   · 没有 onDestroy      ⇒ Activity 一直活着，不是"被销毁所以没卡片"
   *   · 没有 onTaskRemoved  ⇒ 任务没有被 AMS 移除
   *   · 每次都 "已确保 1 个任务不排除"  ⇒ getAppTasks 有任务、调用没抛异常
   *   · manifest 三项已在包里
   * ```
   *
   * 而用户的观察是「打开隐私空间里的应用再回来，卡片就出现了」——
   * 那一步会让最近任务界面**整体重建**。所以问题不在 AMS 的数据，
   * 而在**启动器的最近任务界面没有刷新**。
   *
   * ## 为什么 `setTaskDescription` 能推动刷新
   *
   * 它是唯一会影响"最近任务里那个卡片长什么样"的公开 API（标签/图标/配色）。
   * 系统在它被调用后会更新任务的描述并通知界面重建该卡片。
   *
   * 而 `setExcludeFromRecents(false)` 在值本来就是 false 时是**空操作**，
   * 系统不会因此发出任何变更通知 —— 启动器也就一直不知道要更新。
   *
   * ## 为什么传明确的 label
   *
   * 不传时系统用 Activity 的 label；我们的 `main_activity_title` 与
   * `app_name` 不是同一个字符串，卡片上可能显示成别的名字。传一次就固定下来。
   *
   * 失败只记日志：这是体验优化，不该影响任何功能。
   */
  private fun refreshTaskCard(stage: String) {
    try {
      val label = applicationInfo.loadLabel(packageManager)?.toString() ?: "Tavern Card Studio"

      /*
       * ① **不要**关掉截图预览（2026-11-22 第五轮，撤回上一轮的改动）。
       *
       * 上一轮我加了 `setRecentsScreenshotEnabled(false)`，理由是"WebView 截图
       * 可能失败，露出空白"。用户反馈的结果说明了这个判断错在哪：
       *
       * ```text
       *   卡片出现了，但**一块纯色，完全没有 App 内容**
       * ```
       *
       * 关掉截图之后系统**本来就不截内容**，卡片只能画一个占位块 ——
       * 那不是"修好了缩略图"，而是"放弃了缩略图"。
       *
       * ## 白底的真因在主题，不在这
       *
       * `Theme.tcs_shell` 继承 Material3 DayNight，**没设 windowBackground**，
       * 亮色模式下窗口背景是白色。缩略图里 WebView 那层合成不上时，
       * 露出来的就是白色 —— 看起来像"没有内容"。
       * 已在 `res/values/themes.xml` 把窗口背景改成 `#0c0a14`（应用底色）。
       *
       * 所以这里恢复系统默认：**让系统真的去截图**。
       */

      /*
       * ② 给卡片一个和应用一致的底色。
       *
       * 万一缩略图仍然合成不上（WebView + SurfaceView 的老问题），
       * 卡片至少是深色的、看起来像这个 App，而不是一块白板。
       *
       * 色值与应用底色 `--nb-abyss (#0c0a14)` 一致。
       */
      @Suppress("DEPRECATION")
      setTaskDescription(
        ActivityManager.TaskDescription(label, null, 0xFF0C0A14.toInt()),
      )
      StLog.i("RECENTS", "$stage：已刷新任务卡片（label=$label）")
    } catch (error: Throwable) {
      StLog.w("RECENTS", "$stage：刷新任务卡片失败：${error.javaClass.simpleName} ${error.message}")
    }
  }

  /**
   * 带重试的版本：任务还没建立就过一会儿再试。
   *
   * ## 为什么必须重试
   *
   * 见 `clearRecentsExclusion` 的注释：早期拿不到任务是最可能的失效点。
   * 三轮的间隔是递增的 —— 第一轮 200ms 覆盖"马上就绪"，最后一轮 1500ms
   * 覆盖"Tauri + WebView 初始化特别慢"的机型。全部走完约 2.3 秒，
   * 对启动耗时的感知可以忽略。
   *
   * ## 为什么重试之间有取消
   *
   * 四处调用点会互相覆盖（比如 onResume 紧跟着 onCreate）。不取消上一个
   * 待执行的 Runnable，就会有几个重试链同时在跑，日志里看不出哪条是有效的。
   */
  private fun ensureRecentsVisible(stage: String) {
    if (clearRecentsExclusion(stage)) {
      recentsRetryIndex = 0
      cancelRecentsRetry()
      return
    }

    if (recentsRetryIndex >= RECENTS_RETRY_DELAYS.size) {
      StLog.w(
        "RECENTS",
        "$stage：重试 ${RECENTS_RETRY_DELAYS.size} 轮仍拿不到任务，放弃。" +
          "本机可能限制了 getAppTasks()。",
      )
      recentsRetryIndex = 0
      return
    }

    val delay = RECENTS_RETRY_DELAYS[recentsRetryIndex]
    recentsRetryIndex += 1
    cancelRecentsRetry()
    val runnable = Runnable {
      recentsRetry = null
      /*
       * 销毁之后不要再碰 Activity —— `getSystemService` 在已销毁的实例上
       * 虽然能返回对象，但设置一个已经不属于前台的 task 没有意义，
       * 而且日志会变得难以解读。
       */
      if (!isFinishing && !isDestroyed) {
        ensureRecentsVisible("$stage+${delay}ms")
      }
    }
    recentsRetry = runnable
    recentsHandler.postDelayed(runnable, delay)
    StLog.i(
      "RECENTS",
      "$stage：任务还没建立，${delay}ms 后重试（第 $recentsRetryIndex 轮）",
    )
  }

  /** 撤掉待执行的重试（Activity 销毁时也必须调，否则会持有已销毁的实例） */
  private fun cancelRecentsRetry() {
    val pending = recentsRetry ?: return
    recentsHandler.removeCallbacks(pending)
    recentsRetry = null
  }

  /**
   * 每次回到前台都再确认一次任务可见。
   *
   * 为什么不能只在 `onCreate`：任务是长期存在的，而"被排除"可能是
   * 后台期间被系统/启动器改的。`onResume` 是唯一"用户正看着这个界面"的时刻，
   * 在这里修正最贴近用户预期。
   */
  override fun onResume() {
    super.onResume()
    /*
     * 回到前台时把重试计数归零：用户可能刚在别处（比如隐私空间）
     * 让任务重建过，这时的"重新来一轮"是有意义的。
     */
    recentsRetryIndex = 0
    ensureRecentsVisible("onResume")
    refreshTaskCard("onResume")
  }

  /**
   * 用户主动离开（按 Home / 上滑切走）时再确认一次（2026-11-22 新增）。
   *
   * ## 为什么这个钩子比 onResume 更对症
   *
   * 任务是**在 Activity 停止之后**才被归档进最近任务的。而
   * `onUserLeaveHint` 是 AOSP 里专门表示"用户主动要离开"的时机
   * （按 Home、上滑看任务列表），比 `onPause` 还早一步，
   * 正好赶在归档之前。
   *
   * ## 为什么不用返回值
   *
   * `onUserLeaveHint` 返回 void，不参与导航决策 —— 我们只借这个时机设置属性。
   * 不调 `super` 会有副作用（Tauri / Activity 内部依赖它做状态收尾）。
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    ensureRecentsVisible("onUserLeaveHint")
    refreshTaskCard("onUserLeaveHint")
  }

  /**
   * 暂停时再确认一次（2026-11-22 新增）。
   *
   * 这是 `onUserLeaveHint` 之外的兜底：那个钩子只在"用户主动离开"时触发，
   * 而**被别的应用覆盖**（来电、通知全屏、隐私空间切换）不算用户离开，
   * 那些路径只会走 `onPause`。
   *
   * ★ 这里**不重置**重试计数，也不开启新的重试链：马上要进后台了，
   *   延迟重试在那个状态下没有意义（Activity 已经不可见）。
   *   所以只做一次即时尝试。
   */
  override fun onPause() {
    super.onPause()
    clearRecentsExclusion("onPause")
    refreshTaskCard("onPause")
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
  /**
   * 正常退出标记（2026-11-12）。
   *
   * 与 `onCreate` 里那次置 false 配对 —— 只有真的走到这里才算干净结束。
   * 这是判断"闪退 vs 被系统杀"的唯一依据：没有它，两种情况在日志里
   * 长得一模一样（都是"上次没有日志结尾"）。
   *
   * ## ★★★ 必须用 `commit()` 而不是 `apply()`（2026-11-15）
   *
   * 真机日志里这一对**自相矛盾**，相隔 4 秒：
   *
   * ```text
   *   20:05:10.701 I BOOT: onDestroy（正常退出）
   *   20:05:14.778 E BOOT: 上次进程没有正常退出（未走到 onDestroy）
   * ```
   *
   * 原因就是 `apply()`：它**立刻改内存、异步写磁盘**。而 `onDestroy`
   * 之后进程马上被回收，那次异步写很可能没落地 —— 下次开机读到的
   * 还是 `false`，于是"明明正常退出"被报成"没有正常退出"。
   *
   * 这是所有"退出时写标记"的通病：**进程死亡与异步落盘在赛跑，
   * 通常进程先死。** 标记越小越该用同步写 —— 一个 boolean 的
   * `commit()` 是微秒级，在 `onDestroy` 里阻塞完全可以接受。
   *
   * 更严重的后果不是这条日志错，而是**它会污染所有崩溃归因**：
   * 真的被系统杀掉时，我们会以为"上次是正常退出的"，从而漏掉线索。
   */
  override fun onDestroy() {
    /*
     * ★ 先撤掉挂起的重试（2026-11-22）。
     *
     * 不撤的话 `Handler` 会持有这个已销毁的实例，里面的 Runnable 还会去调
     * `getSystemService` —— 泄漏一个 Activity，而且日志里会出现
     * 「销毁之后还在设置任务」的怪记录，让后续归因变难。
     */
    cancelRecentsRetry()

    /*
     * ★★★ 销毁取证（2026-11-22 第二轮）。
     *
     * 用户报「装上修过的版本还是不行」，日志里却是：
     *
     * ```text
     *   10:14:50.892 RECENTS: onUserLeaveHint：已确保 1 个任务不排除在最近任务之外
     *   10:14:50.966 LIFE: 退到后台
     *   10:14:52.973 BOOT: onDestroy（正常退出）      ← 退后台 2 秒就销毁
     * ```
     *
     * 也就是说 `setExcludeFromRecents(false)` **确实设成功了**，但 Activity
     * 随后被销毁。任务里没有活着的 Activity 时，系统会把它从最近任务移走 ——
     * 卡片当然不显示。
     *
     * 那三个数字是唯一能区分"谁销毁了它"的凭据：
     *
     * ```text
     *   isFinishing = true    ⇒ 有人（或 ROM）调了 finish()
     *   isFinishing = false   ⇒ 系统销毁：回收 / 任务被重置 / 配置变更
     *   任务数 = 0            ⇒ 任务已被移除（卡片消失的直接原因）
     *   Intent 带排除位        ⇒ 启动入口脏，task 创建时就被排除
     * ```
     */
    run {
      val finishing = isFinishing
      /*
       * `isChangingConfigurations` 区分两种"销毁"：
       *
       * ```text
       *   true  ⇒ 配置变更（旋转/深色模式/字号…）导致的临时重建，正常
       *   false ⇒ 真的被销毁
       * ```
       *
       * manifest 里已有 `configChanges` 挡住了大部分配置变更，所以这里
       * 如果出现 true，说明还有没挡住的项 —— 那本身就是一条线索。
       */
      val changing = isChangingConfigurations
      val tasks = try {
        getSystemService(ActivityManager::class.java)?.appTasks?.size ?: -1
      } catch (error: Throwable) {
        -1
      }
      val dirtyFlag = (intent?.flags ?: 0) and android.content.Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
      StLog.i(
        "RECENTS",
        "onDestroy：isFinishing=$finishing 配置变更=$changing 剩余任务=$tasks " +
          "Intent带排除位=${dirtyFlag != 0}",
      )
    }

    /*
     * 顺序也要紧：先落标记，再记日志。
     *
     * 反过来的话，日志里会出现"onDestroy（正常退出）"而标记没写进去 ——
     * 正是这次的现场。**先做有副作用的事，再用日志确认它做完了。**
     */
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_CLEAN_EXIT, true).commit()
    StLog.i("BOOT", "onDestroy（正常退出）")
    super.onDestroy()
  }

}
