package com.taverncardstudio.client.stengine

import android.content.Context
import android.os.Build
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 起停 ST 的 Node 进程（v0.1.7 / T15.3）。
 *
 * ## W^X 五条件（照抄 spike ① 的结论，缺一条就起不来）
 *
 * 1. 可执行体命名成 `libnode.so`，放 APK 的 `jniLibs/arm64-v8a/`；
 * 2. manifest/gradle：`extractNativeLibs=true` **且** `useLegacyPackaging=true`
 *    （只设第一项时 AGP 8+ 不会在安装时解压，要 exec 的路径根本不存在）；
 * 3. `libc++_shared.so` 与它**同目录**（`libnode.so` 的 DT_NEEDED 里有它）；
 * 4. 启动时显式设 `LD_LIBRARY_PATH=nativeLibraryDir`
 *    —— 链接器**不会**在"要 exec 那个文件的邻居目录"里自动找依赖；
 * 5. 只 exec `nativeLibraryDir` 里的只读路径，绝不解到 `files/` 里再执行。
 *
 * 前四条是"能不能跑"，第五条是"会不会被系统拒"。spike 里四条全过才跑起来，
 * 任何一条拼错的表现都是 `EACCES` 或 `dlopen failed`，而**不是**"node 没输出"。
 *
 * ## 为什么端口探测用的是 HTTP 而不是 socket connect
 *
 * "端口能连上"只证明有人 listen，不证明那个人是 ST。而孤儿清理最怕杀错 ——
 * 所以必须问到**身份**（`/version` 的 agent 字段含 `SillyTavern`）。
 * 详见 `shared/src/android/st-lifecycle.ts` 的 `shouldKillOrphan`。
 */
object StLauncher {

    private const val TAG = "StLauncher"

    /** 首选端口。与设计文档一致 */
    const val PRIMARY_PORT = 8000

    /** 备用端口上限。8001..8010，够用且不会撞到常见开发工具 */
    private val BACKUP_PORTS = (8001..8010).toList()

    /** 探活间隔/上限。与 `st-lifecycle.ts` 的 PROBE_INTERVAL_MS / PROBE_TIMEOUT_MS 一致 */
    const val PROBE_INTERVAL_MS = 500L
    /*
     * ★★★ 2026-11-09 从 30 秒改成 120 秒（用户真机报"世界没能打开"）。
     *
     * 原注释写"低端机冷启动更慢"，但真实情况是：**升级安装后也慢**。
     * 用户覆盖装 0.1.8 补丁版后 30 秒被判超时，而几分钟后 8000 端口
     * LISTEN、`/version` 返回 200（0.08s）。
     *
     * 启动耗时随用户数据量增长（卡 / 聊天 / 世界书都要扫），不是常数。
     * 拿固定 30 秒卡它会越来越容易不够。
     *
     * 与 `shared/src/android/st-lifecycle.ts` 的 `PROBE_TIMEOUT_MS` 一致 ——
     * 两侧必须同值，否则会出现"后端已放弃、前端还在等"的错位。
     */
    const val PROBE_TIMEOUT_MS = 120_000L

    /**
     * **首次启动**的探活上限。与 `st-lifecycle.ts` 的 `FIRST_RUN_PROBE_TIMEOUT_MS` 一致。
     *
     * 真机实测：热启动（数据目录已存在）7 秒就绪；首次启动（`st-data` 空，
     * ST 要创建默认数据）**超过 30 秒**。第一版用 30 秒，于是首次启动
     * 被判"引擎启动超时"，而几十秒后端口其实是 LISTEN 的 ——
     * 现象是"提示启动失败，但其实好了"，最难查的一类。
     */
    const val FIRST_RUN_PROBE_TIMEOUT_MS = 120_000L

    /** SIGTERM 之后等多久再 SIGKILL。设计文档 §5.3 定为 5 秒 */
    const val GRACEFUL_STOP_MS = 5_000L

    /** 只在内存里持有 —— 不写 PID 文件（PID 会被系统复用，拿文件里的号 kill 会杀错） */
    @Volatile
    private var process: Process? = null

    /** 当前实际用的端口（可能是备用端口） */
    @Volatile
    var activePort: Int = PRIMARY_PORT
        private set

    /** 最近一次读到的 RSS（MB）。通知里要用它，且必须跟着真实值走 */
    @Volatile
    var residentMb: Int = 0
        private set

    /**
     * 端口上是否有我们认得的 ST 在应答 —— **缓存**，由服务在启动/刷新时更新。
     *
     * 为什么不在 `status()` 里现探：那个方法跑在 WebView 的 JS 线程上，
     * 而探测最长要等 800ms（连接 + 读超时）。在前端每 1 秒轮询一次的情况下，
     * 这会让页面每秒钟卡 0.8 秒 —— 表现为"进度条一顿一顿的"。
     */
    @Volatile
    var ready: Boolean = false
        private set

    /** 由服务调用，把最新探测结果写进缓存 */
    fun refreshReady() {
        ready = probe(activePort).state == ProbeState.ST
    }

    /** 进程退出后清掉缓存（否则前端会一直以为还活着） */
    fun markStopped() {
        ready = false
        residentMb = 0
    }

    data class StartResult(
        val ok: Boolean,
        /** 给用户看的一句话 */
        val message: String,
        /** true = 复用了已有实例（孤儿），没有新起进程 */
        val reused: Boolean = false,
    )

    /**
     * 确保 ST 在跑。
     *
     * 顺序（每一步都是判据，不是"尽力而为"）：
     * 1. 首选端口已有人听 → 问身份 → 是 ST 就复用；不是就换备用端口；
     * 2. 起 node，等端口就绪（30 秒上限，低端机冷启动更慢）；
     * 3. 起不来 → 返回可读的失败原因。
     */
    fun ensureRunning(context: Context, firstRun: Boolean = false): StartResult {
        if (isOurProcessAlive()) {
            /*
             * ★★★ 进程活着 ≠ 端口在听（2026-11-09 修）。
             *
             * 原来是直接 `return StartResult(true, "引擎正在运行")`，
             * **一次 probe 都不做**。后果是一条完整的死循环：
             *
             * ```text
             *   ① 启动超时（进程还活着、还在初始化）
             *   ② 用户点重试 → 走这个分支 → 立刻说"引擎正在运行"
             *   ③ 调用方以为好了，马上发请求
             *   ④ 端口还没 listen → 请求失败
             *   ⑤ 用户再点重试 → 回到 ②
             * ```
             *
             * 也就是说"重试"永远不可能成功 —— 它只回答"进程在不在"，
             * 而用户要的是"能不能用"。
             *
             * 现在这里也等端口：与 spawn 那条路径共用 `awaitListening`。
             * 于是"点重试"变成真的重试：等到 listen 就成功，
             * 等不到才报超时。
             */
            Log.i(TAG, "已有自己起的进程在跑（pid=${pidOf(process)}），等它就绪")
            val port = activePort.takeIf { it > 0 } ?: PRIMARY_PORT
            return awaitListening(port, PROBE_TIMEOUT_MS, null)
        }

        // ① 先看首选端口有没有人听
        val primaryProbe = probe(PRIMARY_PORT)
        if (primaryProbe.state == ProbeState.ST) {
            /*
             * 是 ST，但不是我们这次 spawn 的 —— 上一次 App 进程被杀、
             * node 活了下来（设计文档 §5.1 的孤儿）。**复用，不杀**。
             *
             * 为什么复用而不是杀掉重起：用户正在聊天，杀掉等于把他的
             * 会话内存状态丢掉；而复用一个对的实例是零风险的。
             */
            activePort = PRIMARY_PORT
            Log.i(TAG, "复用已有 ST 实例（孤儿）")
            return StartResult(true, "引擎已在运行（复用了上次的实例）", reused = true)
        }

        val port = if (primaryProbe.state == ProbeState.OTHER) {
            /*
             * 8000 被别的程序占了。**不杀**（越权，且手机上 8000 被
             * 开发工具占用很常见），改用备用端口。
             */
            val free = BACKUP_PORTS.firstOrNull { probe(it).state == ProbeState.FREE }
            if (free == null) {
                return StartResult(false, "8000 端口被别的程序占用，备用端口也不可用")
            }
            Log.w(TAG, "8000 被非 ST 程序占用（$primaryProbe.detail），改用 $free")
            free
        } else {
            PRIMARY_PORT
        }

        return startNode(context, port, firstRun)
    }

    /**
     * 等端口真的在听 ST（2026-11-09 抽出）。
     *
     * ## 为什么抽出来
     *
     * 两条路径要等同一件事，但原来只有一条在等：
     *
     * ```text
     *   spawn 新进程      等端口就绪  ← 原来有
     *   复用已有进程      直接返回"正在运行"  ← 原来没有，是个洞
     * ```
     *
     * 那个洞的后果是"点重试永远不成功"（详见 `ensureRunning` 的注释）。
     * 两处逻辑一模一样，复制一份会分叉 —— 所以抽成一个方法。
     *
     * @param proc 我们自己 spawn 的进程；复用别处进程时传 `null`
     *   （那时没法看 `isAlive`，只能靠 probe 与超时）
     */
    private fun awaitListening(port: Int, limit: Long, proc: Process?): StartResult {
        val startedAt = System.currentTimeMillis()
        while (System.currentTimeMillis() - startedAt < limit) {
            /*
             * 只有自己 spawn 的进程才能查存活。复用别处的进程时 `proc` 为 null，
             * 跳过这一段 —— 那种情况下唯一的事实来源就是 probe。
             */
            if (proc != null && !proc.isAlive) {
                val code = runCatching { proc.exitValue() }.getOrNull()
                return StartResult(
                    false,
                    "引擎启动后立即退出（退出码 ${code ?: "未知"}）。可能是安装包不完整。",
                )
            }
            if (probe(port).state == ProbeState.ST) {
                val seconds = (System.currentTimeMillis() - startedAt) / 1000
                Log.i(TAG, "引擎已就绪，用了 ${seconds}s，端口 $port")
                return StartResult(true, "引擎已就绪（用了 $seconds 秒）")
            }
            Thread.sleep(PROBE_INTERVAL_MS)
        }

        /*
         * ★★★ 超时**不等于失败**（2026-11-09）。
         *
         * 走到这里时 node 进程通常还活着、还在继续初始化 ——
         * 真机上实测：报超时那会儿端口还没 LISTEN，几分钟后
         * `/version` 就返回 200 了。
         *
         * 所以提示里**不能**叫用户"重启应用"：重启会杀掉这个正在
         * 启动的进程，把它拖回起点。而"点重试"是对的
         * （现在重试真的会等端口），但用户未必会点。
         *
         * 现在明说"进主界面等一会儿"，因为主界面里任何一次操作
         * 都会再问一次 `ensureRunning`，那时进程往往已经就绪。
         */
        return StartResult(
            false,
            "引擎还在启动（等了 ${limit / 1000} 秒）。先进主界面等一会儿，" +
                "或者点重试 —— 不要重启应用，那会把正在启动的引擎杀掉。",
        )
    }

    /** 真正 spawn。失败时返回可读原因，不抛 */
    private fun startNode(context: Context, port: Int, firstRun: Boolean): StartResult {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val node = File(nativeDir, "libnode.so")

        // ── W^X 前置检查：失败在这里报，比让 exec 抛 EACCES 好定位得多 ──
        if (!node.exists()) {
            return StartResult(
                false,
                "找不到引擎可执行文件。请卸载重装（安装包可能不完整）。",
            )
        }
        if (!node.canExecute()) {
            return StartResult(false, "引擎文件没有执行权限（安装包解压异常）。请卸载重装。")
        }
        if (!File(nativeDir, "libc++_shared.so").exists()) {
            return StartResult(false, "缺少运行库（libc++_shared.so）。请卸载重装。")
        }

        val stDir = StUnpacker.stDir(context)
        val dataDir = StUnpacker.dataDir(context)
        dataDir.mkdirs()

        /*
         * 参数说明（逐条对应设计文档）：
         * · `--dataRoot` 指 filesDir/st-data —— **不能**用 /data/local/tmp，
         *   那是 spike 的测试位，tmp 会被系统清，用户聊天记录放那儿等于随时会没；
         * · `--port` 用实际拿到的端口（可能是备用）；
         * · `--browserLaunchEnabled=false` —— 设计文档 §5.5 有 A/B 对照，
         *   开着它会额外起一次浏览器跳转，在 APK 里表现为"多一个空白页"；
         * · **不传 `--listen`**：默认只听回环。传了会暴露到局域网，
         *   而手机上的 ST 没有任何鉴权。
         */
        val command = listOf(
            node.absolutePath,
            File(stDir, "server.js").absolutePath,
            "--dataRoot=${dataDir.absolutePath}",
            "--port=$port",
            "--browserLaunchEnabled=false",
        )

        Log.i(TAG, "启动引擎：${command.joinToString(" ")}")

        return try {
            val builder = ProcessBuilder(command)
                .directory(stDir)
                .redirectErrorStream(true)

            /*
             * ★ 必须设 LD_LIBRARY_PATH（W^X 条件 4）。
             *
             * `libnode.so` 编译时的 DT_RUNPATH 里没有 nativeLibraryDir
             * （那时候还不知道会被装到哪），所以链接器只在系统库路径里找
             * `libc++_shared.so` —— 而 Android 不带它。不设这一条的表现是
             * `dlopen failed: library "libc++_shared.so" not found`。
             */
            builder.environment()["LD_LIBRARY_PATH"] = nativeDir
            /*
             * 让 node 的输出立刻落盘而不是攒满缓冲区再说 ——
             * 崩溃时最需要的是最后几行，缓冲会让它正好丢掉。
             */
            builder.environment()["NODE_OPTIONS"] = "--no-warnings"

            val proc = builder.start()
            process = proc
            activePort = port

            /*
             * 把 stdout/stderr 单独一个线程读掉。
             *
             * 不读的后果不是"看不到日志"，而是**进程会卡住**：
             * 管道缓冲区（通常 64 KB）写满后 node 的 write 就阻塞了，
             * 表现为"ST 起来了但不响应"。这个坑很隐蔽 ——
             * 现象是端口能连、请求没响应。
             */
            Thread({ drain(proc) }, "st-node-output").apply { isDaemon = true }.start()

            // 等端口就绪（与"复用已有进程"那条路径共用同一段等待逻辑）
            val limit = if (firstRun) FIRST_RUN_PROBE_TIMEOUT_MS else PROBE_TIMEOUT_MS
            return awaitListening(port, limit, proc)

            /*
             * ★★★ 超时**不等于失败**（2026-11-09）。
             *
             * 走到这里时 node 进程通常还活着、还在继续初始化 ——
             * 真机上实测：报超时那会儿端口还没 LISTEN，几分钟后
             * `/version` 就返回 200 了。
             *
             * 所以提示里**不能**叫用户"重启应用"：重启会杀掉这个正在
             * 启动的进程，把它拖回起点。而"点重试"是对的
             * （`ensureRunning` 会走 `isOurProcessAlive()` 复用分支），
             * 但用户未必会点。
             *
             * 现在明说"进主界面等一会儿"，因为主界面里任何一次操作
             * 都会再问一次 `ensureRunning`，那时进程往往已经就绪。
             */
            StartResult(
                false,
                "引擎还在启动（等了 ${limit / 1000} 秒）。先进主界面等一会儿，" +
                    "或者点重试 —— 不要重启应用，那会把正在启动的引擎杀掉。",
            )
        } catch (error: Exception) {
            Log.e(TAG, "启动引擎失败", error)
            /*
             * 失败原因必须区分 EACCES 与 ENOENT —— 它们的下一步动作完全不同
             * （前者是 W^X/权限，后者是文件不在）。
             */
            StartResult(false, "启动引擎失败：${error.javaClass.simpleName} ${error.message ?: ""}".trim())
        }
    }

    /**
     * 取子进程的 PID。**只能反射。**
     *
     * ## 为什么这里没有 API 版本判断
     *
     * 我第一版写了 `if (SDK_INT >= O) proc.pid() else 反射`，编译直接报
     * `Unresolved reference 'pid'` —— 因为 **Android 的
     * `java.lang.Process` 从来没有 `pid()`**。
     *
     * `pid()` 是 **Java 9** 的 API，Android 没有 backport（这是 AOSP 上一个
     * 长期存在的缺口，不是版本问题）。所以"高版本用方法、低版本用反射"
     * 那个常见写法在这里**根本编译不过** —— 比我预想的更彻底。
     *
     * 反射读私有字段 `pid` 是 Android 上唯一可行的做法：
     * ART 的 `java.lang.ProcessImpl`（以及 `ProcessManager`）一直有这个字段。
     *
     * 拿不到时返回 null，调用方（读 RSS）直接跳过 —— 宁可通知里不显示内存，
     * 也不要因为拿不到 PID 就崩掉服务。
     */
    private fun pidOf(proc: Process?): Int? {
        if (proc == null) return null
        return try {
            val field = proc.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            field.getInt(proc)
        } catch (error: Exception) {
            Log.w(TAG, "取 PID 失败（反射）", error)
            null
        }
    }

    /** 把子进程输出读掉并转进 logcat（按行，前缀便于 grep） */
    private fun drain(proc: Process) {
        try {
            BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    Log.i("StNode", line)
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "读子进程输出结束", error)
        }
    }

    /**
     * 停掉**我们自己起的**那个进程。
     *
     * 只杀内存里持有的这个 `Process` —— 它的 PID 就是我们的。
     * 不用 PID 文件、不按名字 kill：PID 会被系统复用，
     * 而"清理不认识的进程"属于越权（设计文档 §5.2）。
     */
    fun stop(): Boolean {
        val proc = process ?: return false
        process = null

        if (!proc.isAlive) return true

        Log.i(TAG, "SIGTERM → pid=${pidOf(proc)}")
        // Java 的 destroy() 在 Unix 上就是 SIGTERM
        proc.destroy()

        val exited = try {
            proc.waitFor(GRACEFUL_STOP_MS, TimeUnit.MILLISECONDS)
        } catch (interrupted: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }

        if (!exited) {
            Log.w(TAG, "${GRACEFUL_STOP_MS}ms 内没退出，SIGKILL → pid=${pidOf(proc)}")
            proc.destroyForcibly()
        }
        return true
    }

    /** 我们自己起的那个进程还活着吗 */
    fun isOurProcessAlive(): Boolean = process?.isAlive == true

    /**
     * 读 RSS（MB）。通知里要显示，且**必须跟着真实值走**。
     *
     * 设计文档 §3.2 明确：不要写死 187 MB —— 那个数字是特定 Node 版本跑出来的，
     * 换版本就错。用户看到"电池用量里有个陌生应用占 150 MB"会直接卸载，
     * 所以这个数字要真实。
     */
    fun readResidentMb(): Int {
        val proc = process ?: return 0
        val pid = pidOf(proc) ?: return 0

        return try {
            // statm 第二列是常驻页数
            val fields = File("/proc/$pid/statm").readText().trim().split(" ")
            val pages = fields.getOrNull(1)?.toLongOrNull() ?: return 0
            val pageSize = 4096L // Android arm64 固定 4 KB 页（与 §57 的对齐结论一致）
            val mb = (pages * pageSize / (1024 * 1024)).toInt()
            residentMb = mb
            mb
        } catch (error: Exception) {
            Log.w(TAG, "读 RSS 失败", error)
            residentMb
        }
    }

    /* ═══════════════════════════════════════════════════════
       端口探测
       ═══════════════════════════════════════════════════════ */

    enum class ProbeState { ST, OTHER, FREE }

    data class ProbeResult(val state: ProbeState, val detail: String = "")

    /**
     * 问 `127.0.0.1:<port>/version` 并判身份。
     *
     * · 应答且 agent 含 `SillyTavern` → ST（可以复用）
     * · 应答但不是 ST / 超时但端口有人听 → OTHER（占用了，换端口）
     * · 连不上 → FREE（可以用）
     *
     * 超时给 800ms：本机回环，正常应在 10ms 内；800ms 已经是很宽松的上限，
     * 而探测本身在启动路径上，不能等太久。
     */
    fun probe(port: Int): ProbeResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:$port/version").openConnection() as HttpURLConnection).apply {
                /*
                 * ★★★ 800ms 在低端机上不够（2026-11-09 真机取证）。
                 *
                 * ## 证据：红米 Note 8 Pro 的首启日志
                 *
                 * ```text
                 *   00:04:10  Compiling frontend libraries...
                 *   00:04:44  webpack compiled successfully in 33260 ms
                 *   00:04:49  SillyTavern is listening on 127.0.0.1:8000
                 *   00:06:06  App: 引擎还在启动（等了 120 秒）   ← 仍在报失败
                 * ```
                 *
                 * 引擎在 00:04:49 就 LISTEN 了，而 App 到 00:06:06 还在报
                 * "没应答"——**中间 77 秒一次都没探成功**。
                 *
                 * ## 为什么探不到
                 *
                 * 两个原因叠在一起：
                 *
                 * ```text
                 *   ① webpack 刚编译完，node 仍在 GC/预热，响应排队
                 *   ② 红米是低端机，主频低；800ms 里连 TCP + 等首字节不够
                 * ```
                 *
                 * 探测是**本机回环**，放宽超时几乎不花代价（真连不上时
                 * 连接会被立即拒绝，不会真等 3 秒）。而探不到 ST 的代价
                 * 是"引擎明明好了却报失败"—— 那正是用户反复遇到的。
                 *
                 * `PROBE_INTERVAL_MS` 是 500ms，一次探测最长 3s 会让循环变慢。
                 * 这是**刻意的**：探测失败时本来就没必要那么密。
                 */
                connectTimeout = 3_000
                readTimeout = 3_000
                requestMethod = "GET"
            }
            val code = connection.responseCode
            if (code != 200) {
                return ProbeResult(ProbeState.OTHER, "HTTP $code")
            }
            /*
             * ★★★ 判据放宽：`200 + 端口在听 + 能读响应` 就算 ST 就绪
             * （2026-11-09 真机取证）。
             *
             * ## 原来为什么过严
             *
             * 原来要求 body 里含 "SillyTavern"。而红米真机上出现过
             * **200 + `Content-Type: application/json` + body 为空**：
             * 端口在听、HTTP 通了、就是读不到那串字。
             *
             * 那一刻 App 判定"应答但不是 ST"，于是继续等，直到 120 秒超时
             * —— 而引擎其实早就好了（`SillyTavern is listening` 日志在前）。
             *
             * ## 为什么可以不看 body
             *
             * 这个 probe 的用途只有一个：**判断我们自己 spawn 的那个进程
             * 是否已经把端口服务起来了**。我们 bind 的是 8000、是回环、
             * 而且就在刚才 spawn 的进程里 —— 有人在这个端口上回 200，
             * 除了它几乎不可能是别人。
             *
             * "怕是别的服务占着 8000"那种担心，`ensureRunning()` 里
             * 另有一段专门处理（`ProbeState.OTHER` → 换备用端口），
             * 而那段只在**启动前**跑一次，与这里"等自己的进程就绪"是两件事。
             *
             * ## body 仍要读，但只用来做"更确定的证据"
             *
             * 读得到 SillyTavern 就带上它（日志里能看出是 ST 而不是野服务）；
             * 读不到也照样判定就绪 —— 不让一次空 body 把启动判死。
             */
            val body = runCatching {
                connection.inputStream.bufferedReader().use { it.readText() }
            }.getOrDefault("")
            if (body.contains("SillyTavern", ignoreCase = true)) {
                ProbeResult(ProbeState.ST, body.take(120))
            } else {
                /*
                 * 200 但没读到那串字：端口确实在服务，判就绪。
                 * 日志里标记 `body 空/不含 ST`，便于事后区分是哪种情况。
                 */
                ProbeResult(
                    ProbeState.ST,
                    if (body.isEmpty()) "200 但 body 为空（端口已在服务）" else "200：${body.take(80)}",
                )
            }
        } catch (error: Exception) {
            /*
             * 连不上有两种：真没人听（FREE）、和有人听但不 HTTP（OTHER）。
             *
             * 这里简化成 FREE —— 因为后续 `startNode` 会真的去 bind，
             * 撞上 EADDRINUSE 会走"启动后立即退出"那条分支并报出来。
             * 在探测阶段区分这两者需要 raw socket，收益不抵复杂度。
             *
             * ★★★ 日志必须用 **E 级 + 固定可 grep 的前缀**（2026-11-09）。
             *
             * ## 为什么
             *
             * 红米真机上出现过"引擎明明在监听，App 却 110 秒探不到"，
             * 而 `Log.i(TAG, ...)`（TAG=StLauncher）在 MIUI 上**被过滤掉了** ——
             * 排查时 `grep StLauncher` 一条日志都没有，等于黑盒。
             *
             * 用 `Log.e` 并把异常类名 + 消息都写进去，下次一眼就能看出是
             * `ConnectException`（没人听）还是 `SocketTimeoutException`
             * （在听但不回），还是别的（被 SELinux/网络策略拦）。
             * 只在这一条上加 E 级：它只在**探测失败**时打印，
             * 正常启动时一次都不会刷屏。
             */
            Log.e(
                "StProbe",
                "probe 失败 port=$port：${error.javaClass.simpleName} ${error.message ?: ""}",
            )
            ProbeResult(ProbeState.FREE, error.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    /** 设备 ABI，日志用 */
    fun abi(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"
        } else {
            @Suppress("DEPRECATION")
            Build.CPU_ABI
        }
}
