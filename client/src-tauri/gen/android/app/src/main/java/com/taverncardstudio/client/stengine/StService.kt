package com.taverncardstudio.client.stengine

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * 让 ST 在 Doze 下活着的唯一机制（v0.1.7 / T15.3）。
 *
 * ## 为什么必须是前台服务
 *
 * spike 只验了 **2 分 22 秒**灭屏存活，而且是在 `setsid` 拉起的 shell 会话里。
 * 真实场景是"锁屏聊微信、半小时后回来继续"，那期间 Doze 会批量冻结后台网络，
 * 厂商 ROM 还会额外杀后台。而 `exec` 出来的 node **不受 Android 生命周期管理**
 * —— Activity 被杀它不会跟着退，反过来系统也不会替我们保它。
 *
 * 前台服务是目前唯一能在 Doze 下维持进程的机制。
 *
 * ## `START_STICKY` 的真实语义要自己实现
 *
 * 系统重建服务时**可能已经有一个 node 在跑**（进程没死透）。这时再 exec 一个
 * 会 `EADDRINUSE` 失败，而失败只出现在日志里 —— 用户看到的是"通知在，
 * 但页面打不开"。
 *
 * 所以 `onStartCommand` 的第一件事是**先探测端口再决定**，
 * 详见 `StLauncher.ensureRunning()`。
 */
class StService : Service() {

    companion object {
        private const val TAG = "StService"

        const val CHANNEL_ID = "st-engine"
        const val NOTIFICATION_ID = 1001

        const val ACTION_START = "com.taverncardstudio.client.ST_START"
        const val ACTION_STOP = "com.taverncardstudio.client.ST_STOP"

        /** 通知里刷新 RSS 的周期。10 秒够用，太频繁会被系统限流 */
        private const val RSS_REFRESH_MS = 10_000L

        /** 超时后"继续盯"的间隔与总上限（见 `watchUntilReady`） */
        private const val WATCH_INTERVAL_MS = 2_000L
        private const val WATCH_TOTAL_MS = 10 * 60 * 1000L

        /**
         * 最近一次失败原因。
         *
         * 放 companion 而不是实例字段：服务实例会被系统销毁重建，
         * 而 JS 桥拿不到实例引用 —— 放实例上等于"页面永远读不到原因"。
         */
        @Volatile
        var lastError: String? = null
            private set

        /** 供桥与 UI 读的就绪状态（缓存，不现探） */
        val isReady: Boolean get() = StLauncher.ready

        /**
         * 从任意 Context 拉起服务。
         *
         * Android 8+ **必须** `startForegroundService`：用 `startService` 起一个
         * 会调 `startForeground` 的服务，系统会在 5 秒后抛
         * `IllegalStateException` 并杀进程 —— 而现象是"点了没反应，应用退出"。
         */
        fun start(context: Context) {
            val intent = Intent(context, StService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 停止：走同一个服务的 STOP action，保证 SIGTERM 那段逻辑只有一份 */
        fun stop(context: Context) {
            val intent = Intent(context, StService::class.java).setAction(ACTION_STOP)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var rssTask: Runnable? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        /*
         * `startForeground` 必须在 5 秒内调用，否则 Android 14+ 直接
         * 抛 `ForegroundServiceDidNotStartInTimeException` 并杀进程。
         *
         * 所以**先**用"正在准备"的文案进前台，再去解包/启动 ——
         * 反过来的话，437 MB 解包那十几秒就已经超时了。
         */
        startForegroundCompat(buildNotification("正在准备引擎…", null))

        if (intent?.action == ACTION_STOP) {
            Log.i(TAG, "收到停止指令")
            stopEngineAndSelf()
            return START_NOT_STICKY
        }

        /*
         * 在后台线程做"解包 → 启动"。两件事都阻塞：
         * 解包写 437 MB，启动要等端口（最长 30 秒）。
         * 在主线程做会 ANR，而 ANR 在用户看来是"点了开始聊天就卡死"。
         */
        Thread({
            try {
                prepareAndStart()
            } catch (error: Throwable) {
                /*
                 * 这里必须 catch Throwable 而不是 Exception：
                 * `OutOfMemoryError` / `UnsatisfiedLinkError` 都是 Error，
                 * 漏掉的话线程静默死掉，通知永远停在"正在准备引擎…" ——
                 * 用户看到的是一个不会消失的通知，没有任何原因。
                 */
                Log.e(TAG, "启动流程崩溃", error)
                lastError = "启动失败：${error.javaClass.simpleName}"
                updateNotification("启动失败，点开重试", null)
            }
        }, "st-start").start()

        /*
         * START_STICKY：系统杀掉后重建。
         *
         * 传 null intent —— 重建时没有原始 intent，`prepareAndStart()`
         * 里"先探端口"那一步正是为这种情况准备的。
         */
        return START_STICKY
    }

    private fun prepareAndStart() {
        /*
         * ★★★ 开工第一件事：清掉上一次的失败（2026-11-09 修）。
         *
         * ## 用户报的
         *
         * > 还是提示没有进入世界，但是界面过了几秒又自动跳转了
         *
         * ## 真因：`lastError` 从不清空，会**毒化下一次启动**
         *
         * `status()` 把 `lastError` 原样交给前端：
         *
         * ```kotlin
         *   json.put("running", StLauncher.isOurProcessAlive())
         *   json.put("error", StService.lastError ?: JSONObject.NULL)
         * ```
         *
         * 而前端 `waitForEngine` 有一条**立即放弃**的判据：
         *
         * ```js
         *   if (probe.running === false && probe.error !== null) → 立刻失败
         * ```
         *
         * 两条凑在一起的后果：
         *
         * ```text
         *   t=0    这次启动刚开始，node 还没 spawn ⇒ running = false
         *          lastError 还是**上一次**的"引擎启动超时" ⇒ error ≠ null
         *   t=0+   前端一看 running=false + error 有值 ⇒ 立刻判失败
         *   几秒后  开屏的 2200ms 延时到 ⇒ 自动进主界面
         *   而引擎其实在后台照常启动，最后是好的
         * ```
         *
         * 这与用户描述的"还是提示没进入世界，但过几秒又跳转了"完全吻合 ——
         * 而且那句提示是**上一次的**旧文案，不是本次的。
         *
         * ## 为什么清在这里
         *
         * `error` 的语义应当是"这一次启动失败的原因"。既然这次才刚开始，
         * 就还没有失败可言。留着旧值唯一的作用就是骗前端。
         *
         * 清掉不损失反应速度：这次若真失败，`ensureRunning` 会立刻返回
         * 并写回 `lastError`，前端下一次轮询（500ms 后）就能看到。
         */
        lastError = null

        /*
         * 是否"首次启动"：解包完成之后的那一次。
         *
         * 判据用 `isUnpacked()` 的**调用时机**而不是时间戳文件：
         * 这一次我们刚解完包，`st-data` 一定是空的，ST 要做最重的初始化。
         * 热启动（已解过包、数据目录有内容）用 30 秒就够。
         */
        var firstRun = !StUnpacker.isUnpacked(this)

        // ① 解包（已解过就跳过）
        if (firstRun) {
            updateNotification("首次启动，正在释放引擎文件（0%）— 只需一次", null)

            var lastPercent = -1
            val error = StUnpacker.unpack(this) { progress ->
                val percent = (progress * 100).toInt().coerceIn(0, 99)
                if (percent != lastPercent) {
                    lastPercent = percent
                    updateNotification(
                        if (percent <= 0) "正在准备引擎…"
                        else "首次启动，正在释放引擎文件（$percent%）— 只需一次",
                        null,
                    )
                }
            }

            if (error != null) {
                lastError = error
                StLauncher.markStopped()
                updateNotification("启动失败，点开重试", null)
                return
            }

            // 解包刚做完 —— 这一次是最重的冷启动
            firstRun = true
        }

        /*
         * ★ 2026-11-07（0.1.7 收尾）：**删掉了"补种内置测试卡"这一步**。
         *
         * 原来这里会无条件把 `assets/test-card/test-card.png` 拷进
         * `default-user/characters/`，于是每个装了包的人第一次打开都会
         * 看到一个叫「测试用-夜航小助手」的角色 —— 那是开发期的验证素材。
         *
         * 删的理由不是"它坏了"，而是**它不该出现在发布包**：
         * 用户会以为那是产品自带角色，而不是我们的测试残留。
         *
         * 真要再造测试卡，走「卡片 → 导入」那条路（那条路本来就有）。
         * 判据 `test/round5-wiring.test.mjs` 已改成**反向钉住**：
         * 服务启动流程不许再出现播种调用。
         */
        updateNotification("正在启动引擎…", null)

        // ② 启动
        val result = StLauncher.ensureRunning(this, firstRun)
        if (!result.ok) {
            lastError = result.message
            StLauncher.markStopped()
            Log.e(TAG, "启动失败：${result.message}")
            updateNotification(result.message, null)
            /*
             * ★★★ 超时不等于放弃（2026-11-09）。
             *
             * ## 真机实测的矛盾
             *
             * ```text
             *   App：等了 120 秒，报"引擎还在启动"
             *   而 node 进程一直活着，几分钟后 8000 真的 LISTEN 了
             * ```
             *
             * 这时 `ready` 会一直是 false（它只在成功路径里被置 true），
             * 于是**界面永远显示没连上**，而引擎其实是好的。
             * 用户要么点重试（现在能成功），要么以为坏了。
             *
             * ## 所以要有个"后来补上"的机制
             *
             * 进程还活着就说明它还在初始化，值得继续等。
             * 起了程就别管，到点了它自己会就绪。
             */
            if (StLauncher.isOurProcessAlive()) watchUntilReady()
            return
        }

        lastError = null
        publishReady(result.message)

        // ③ RSS 周期刷新（通知里的数字必须真实）
        startRssRefresh()
    }

    /**
     * 引擎还没就绪就一直盯着（2026-11-09）。
     *
     * ## 为什么需要它
     *
     * `awaitListening` 有 120 秒上限，超时后返回"还在启动"。
     * 但**超时只是我们不再等，不是引擎停了** —— 真机上它往往在
     * 120~300 秒之间才 LISTEN。
     *
     * 而 `StLauncher.ready` 只在 `publishReady()` 里被置 true。
     * 超时路径只调 `markStopped()`（把 ready 清成 false），
     * 于是引擎后来起来了，界面也永远显示没连上 —— 用户只能靠点重试。
     *
     * 这个方法把"后来就绪"这件事补上：后台每 2 秒探一次，
     * 一旦 ST 应答就清掉 lastError、置 ready、刷新通知。
     *
     * ## 三个约束
     *
     * ```text
     *   进程死了   → 立刻退出（那不是"还在启动"，是真失败）
     *   10 分钟    → 兜底上限，避免线程永久占着
     *   daemon     → 不阻止进程退出
     * ```
     */
    private fun watchUntilReady() {
        Thread({
            val deadline = System.currentTimeMillis() + WATCH_TOTAL_MS
            while (System.currentTimeMillis() < deadline) {
                if (!StLauncher.isOurProcessAlive()) {
                    Log.w(TAG, "看守结束：引擎进程已退出")
                    return@Thread
                }
                if (StLauncher.probe(StLauncher.activePort).state == StLauncher.ProbeState.ST) {
                    Log.i(TAG, "引擎后来就绪了（超出探活上限，由看守补上）")
                    lastError = null
                    publishReady("引擎后来就绪了")
                    return@Thread
                }
                Thread.sleep(WATCH_INTERVAL_MS)
            }
            Log.w(TAG, "看守超时：${WATCH_TOTAL_MS / 1000} 秒内引擎仍未就绪")
        }, "st-watch-ready").apply { isDaemon = true }.start()
    }

    /** 引擎就绪后把通知换成"已就绪 + 实时 RSS" */
    private fun publishReady(message: String) {
        StLauncher.refreshReady()
        val mb = StLauncher.readResidentMb()
        Log.i(TAG, "就绪：$message，RSS=${mb}MB，端口=${StLauncher.activePort}")
        updateNotification(readyText(mb), null)
    }

    /**
     * 正文文案。
     *
     * 设计文档 §3.2 的三条取舍：
     * · 写出内存：不写的话用户在"电池用量"里看到一个陌生应用占 150 MB，第一反应是卸载；
     * · **不写端口号 / PID / 技术状态**：那是开发者关心的（与本轮 UI 文案红线同一条标准）；
     * · 「停止」放通知里：这是唯一能在应用被杀之后还能停掉引擎的入口。
     */
    private fun readyText(mb: Int): String {
        val size = if (mb > 0) "约 $mb MB 内存" else "资源占用正常"
        return "SillyTavern 在后台待命 · $size"
    }

    private fun startRssRefresh() {
        stopRssRefresh()
        val task = object : Runnable {
            override fun run() {
                if (!StLauncher.isOurProcessAlive()) {
                    /*
                     * 进程没了但服务还在 —— 这正是 START_STICKY 要处理的情况。
                     * 不要在这里自动重启（会与系统重建打架），只把通知改成
                     * "已停止"，让用户能看见，并等他点开重试。
                     */
                    Log.w(TAG, "引擎进程已退出，通知改为已停止")
                    StLauncher.markStopped()
                    updateNotification("引擎已停止，点开重试", null)
                    return
                }
                publishReady("引擎正在运行")
                handler.postDelayed(this, RSS_REFRESH_MS)
            }
        }
        rssTask = task
        handler.postDelayed(task, RSS_REFRESH_MS)
    }

    private fun stopRssRefresh() {
        rssTask?.let { handler.removeCallbacks(it) }
        rssTask = null
    }

    private fun stopEngineAndSelf() {
        stopRssRefresh()
        StLauncher.stop()
        stopForegroundCompat()
        stopSelf()
    }

    override fun onDestroy() {
        stopRssRefresh()
        /*
         * 服务被销毁（用户划掉任务 / 系统回收）时**不停引擎**。
         *
         * 为什么：`START_STICKY` 会把服务拉回来，而 node 如果也停了，
         * 用户回到应用就要重新等 8–14 秒启动。设计文档 §5.1 明确
         * "exec 出来的进程不受 Android 生命周期管理"是既定事实 ——
         * 我们只在用户**明确点停止**或**应用退出**时才停它。
         *
         * 真正的清理靠下次 `ensureRunning()` 的"先探端口"处理孤儿。
         */
        super.onDestroy()
    }

    /* ═══════════════════════════════════════════════════════
       通知
       ═══════════════════════════════════════════════════════ */

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "引擎运行状态",
            /*
             * IMPORTANCE_LOW：常驻通知不该响、不该弹。
             * 用 DEFAULT 会在每次刷新 RSS 时打扰用户 —— 而它每 10 秒刷一次。
             */
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "SillyTavern 在后台运行时显示的内存占用"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(text: String, errorHint: String?): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, StService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }

        builder
            .setContentTitle("口袋酒馆 正在运行")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .setCategory(Notification.CATEGORY_SERVICE)

        /*
         * 「停止」只在能停的时候给。
         * 还在准备阶段就放一个"停止"按钮，点了只会让用户困惑
         * （那时没有进程可停）。
         */
        if (errorHint == null) {
            builder.addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "停止",
                    stopIntent,
                ).build(),
            )
            builder.addAction(
                Notification.Action.Builder(
                    android.R.drawable.ic_menu_view,
                    "打开",
                    openIntent,
                ).build(),
            )
        }

        return builder.build()
    }

    private fun updateNotification(text: String, errorHint: String?) {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(text, errorHint))
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            /*
             * Android 14+ 必须声明 type，否则抛
             * `MissingForegroundServiceTypeException`。
             *
             * 选 SPECIAL_USE：我们的用途是"跑一个本地服务供应用自身使用"，
             * 不属于 mediaPlayback / location / dataSync 任何一类。
             * manifest 里必须同时写 `android:foregroundServiceType="specialUse"`
             * 与对应的 `<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE">`，
             * 否则上架审核会被问"你到底特殊在哪"。
             */
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }
}
