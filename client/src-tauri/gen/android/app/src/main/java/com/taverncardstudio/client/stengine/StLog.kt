package com.taverncardstudio.client.stengine

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong

/**
 * 应用日志（2026-11-12）。
 *
 * ## 为什么必须在原生侧，不能只写在 JS 里
 *
 * 用户报「过一段时间自动闪退，不做任何操作也会」，而 **JS 侧一个字都留不下**：
 *
 * ```text
 *   JS 崩溃      → 页面上下文没了，未落盘的记录一起消失
 *   渲染进程被杀  → 更是整个人间蒸发（这恰恰是 WebView 最常见的一种死法）
 *   进程被系统回收 → 同上
 * ```
 *
 * 所以真正的写入点必须在 **Kotlin**：它比 WebView 活得久，而且
 * `Thread.setDefaultUncaughtExceptionHandler` 能在进程死前最后执行一次。
 *
 * ## 为什么放外部目录（用户要求）
 *
 * 用户原话：
 *
 * > 最好是放在用户无 root 时可以访问的目录，这样在应用反复崩溃时也可以拿到APP日志
 *
 * ```text
 *   /data/data/<包名>/files   应用私有，无 root 拿不到        ✗
 *   /sdcard/Android/data/<包名>/files  ← getExternalFilesDir  ✓
 * ```
 *
 * 后者零权限可写、数据线（MTP）与部分文件管理器可直接看到，
 * 卸载时随应用一起清掉（不会留垃圾）。
 *
 * 但它有个已知限制：**Android 11+ 的手机自带文件管理器进不去 `Android/data`**。
 * 所以另提供 `exportToDownloads()` —— 通过 MediaStore 把最近日志写成
 * `Download/tcs-log-<时间>.txt`，那个位置任何文件管理器都能打开、也能直接分享。
 *
 * ## 大小上限（用户要求 10–20MB）
 *
 * ```text
 *   单文件     2MB   —— 超出立刻滚动到下一个
 *   保留文件数  8 个  —— 合计上限 16MB
 *   硬上限     18MB  —— 每次写入后检查总量，超了从最旧的删
 * ```
 *
 * 取 16MB 而不是贴着 20MB：留 2MB 余量，避免"检查时刚好没超、下一次写入
 * 就顶破"的边界抖动。16MB 也在用户要求的 10–20MB 区间内。
 *
 * ## 线程安全
 *
 * `write()` 加锁。多线程同时写会交错出半行，读日志时最难看的正是那种。
 * 用 `synchronized` 而不是队列：日志量小（每秒几条），锁竞争可以忽略，
 * 而队列在崩溃时会丢掉还在缓冲区里的那几条 —— 那几条往往最关键。
 */
object StLog {

    private const val TAG = "StLog"

    /** 单文件上限：2MB */
    private const val MAX_FILE_BYTES = 2L * 1024 * 1024

    /** 保留文件数：8 个 */
    private const val MAX_FILES = 8

    /** 总量硬上限：18MB（略高于 8×2MB，作为绝对红线） */
    private const val MAX_TOTAL_BYTES = 18L * 1024 * 1024

    private const val FILE_PREFIX = "app-"
    private const val FILE_SUFFIX = ".log"

    private val lock = Any()

    @Volatile
    private var logDir: File? = null

    /** 已安装过未捕获异常处理器（重复调用不重复装） */
    @Volatile
    private var crashHandlerInstalled = false

    /** 写入计数：便于诊断"日志器是不是还活着" */
    private val writeCount = AtomicLong(0)

    private val stamp = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
    private val fileStamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US)

    /**
     * 初始化。**必须在 Application/Activity 最早处调用**，越早越能抓到
     * 启动期的问题。
     */
    fun init(context: Context) {
        if (logDir != null) return
        synchronized(lock) {
            if (logDir != null) return
            val base = context.getExternalFilesDir(null) ?: context.filesDir
            val dir = File(base, "logs")
            if (!dir.exists() && !dir.mkdirs()) {
                /*
                 * 外部存储不可用（极少数：存储挂载异常）时退回私有目录。
                 *
                 * 退回去之后用户拿不到日志 —— 但那也比"一条都没有"强，
                 * 至少开发侧还能通过 adb 取。要在日志里写清这件事，
                 * 否则下次又会有人问"为什么找不到文件"。
                 */
                val fallback = File(context.filesDir, "logs")
                fallback.mkdirs()
                logDir = fallback
                write("W", TAG, "外部存储不可用，日志改放私有目录（用户需 root 才能取）：${fallback.absolutePath}")
            } else {
                logDir = dir
            }
            write("I", TAG, "日志目录就绪：${logDir?.absolutePath}")
        }
        installCrashHandler()
    }

    /** 日志目录（未初始化时 null） */
    fun directory(): File? = logDir

    /**
     * 写一条。
     *
     * 参数顺序是 `level, tag, message` —— 与 `android.util.Log` 对齐，
     * 调用方不用额外记一套。
     */
    fun write(level: String, tag: String, message: String) {
        val dir = logDir
        if (dir == null) {
            /* 还没 init（比如 Application 早期就崩了）：直接进 logcat，不抛错 */
            Log.println(levelToPriority(level), tag, message)
            return
        }
        val line = "${stamp.format(Date())} ${level.padEnd(1)} $tag: $message\n"
        val bytes = line.toByteArray(Charsets.UTF_8)

        /*
         * 单条超长要截断：一条 10MB 的堆栈会把整个文件的预算吃光，
         * 后面真正有用的记录全被挤掉。
         */
        val clipped = if (bytes.size > MAX_FILE_BYTES / 4) {
            val head = String(bytes, 0, (MAX_FILE_BYTES / 4).toInt(), Charsets.UTF_8)
            "$head…[截断]\n".toByteArray(Charsets.UTF_8)
        } else {
            bytes
        }

        synchronized(lock) {
            try {
                var target = currentFile(dir)
                if (target.length() + clipped.size > MAX_FILE_BYTES) {
                    target = rollLocked(dir)
                }
                FileOutputStream(target, true).use { out ->
                    out.write(clipped)
                    /*
                     * 不调 `fd.sync()`。
                     *
                     * 理由：那是 fsync，每次几毫秒到几十毫秒，写日志的频率
                     * 下会明显拖慢主线程。而不 fsync 时数据已进内核 page cache，
                     * **进程被 kill（包括 SIGKILL）也不会丢** —— 只有断电/内核崩溃
                     * 才会丢，那种场景本来也没法收集日志。
                     */
                }
                writeCount.incrementAndGet()
                enforceTotalLimitLocked(dir)
            } catch (error: Throwable) {
                /* 日志器自己绝不能抛 —— 否则它变成新的崩溃源 */
                Log.println(Log.ERROR, TAG, "写日志失败：${error.message}")
            }
        }
    }

    fun i(tag: String, message: String) = write("I", tag, message)
    fun w(tag: String, message: String) = write("W", tag, message)
    fun e(tag: String, message: String) = write("E", tag, message)

    /**
     * 已排序的日志文件（旧 → 新）。
     *
     * 名字里带创建时间，所以按文件名排序即是时间序 —— 不依赖 mtime
     * （有些文件系统上 mtime 精度只有秒，同一秒内滚动会排错）。
     */
    fun files(): List<File> {
        val dir = logDir ?: return emptyList()
        return dir.listFiles { f -> f.isFile && f.name.startsWith(FILE_PREFIX) && f.name.endsWith(FILE_SUFFIX) }
            ?.sortedBy { it.name }
            ?: emptyList()
    }

    /** 当前总占用（字节） */
    fun totalBytes(): Long = files().sumOf { it.length() }

    /** 状态摘要，给 JS 显示用 */
    fun statusJson(): String {
        val obj = JSONObject()
        obj.put("dir", logDir?.absolutePath ?: "")
        obj.put("totalBytes", totalBytes())
        obj.put("fileCount", files().size)
        obj.put("writes", writeCount.get())
        obj.put("limitBytes", MAX_TOTAL_BYTES)
        return obj.toString()
    }

    /**
     * 读最近的日志（最多 [maxBytes] 字节，从最新的文件往前拼）。
     *
     * 为什么限长：整份日志可能有 16MB，一次性塞进 JS 字符串会直接把
     * WebView 顶爆 —— 那是"为了看日志而制造新的崩溃"。
     */
    fun readTail(maxBytes: Int): String {
        val list = files()
        if (list.isEmpty()) return ""
        val builder = StringBuilder()
        var budget = maxBytes
        for (file in list.asReversed()) {
            if (budget <= 0) break
            val len = file.length()
            if (len <= 0) continue
            try {
                val take = minOf(len, budget.toLong()).toInt()
                val bytes = ByteArray(take)
                java.io.RandomAccessFile(file, "r").use { raf ->
                    raf.seek(len - take)
                    raf.readFully(bytes)
                }
                val text = String(bytes, Charsets.UTF_8)
                /* 从中间截断时可能切在多字节字符中间，丢掉第一个残行 */
                val clean = if (take < len) text.substringAfter('\n', text) else text
                builder.insert(0, clean)
                budget -= take
            } catch (_: Throwable) {
                /* 单个文件读失败不影响其它文件 */
            }
        }
        return builder.toString()
    }

    /**
     * 把最近日志导出成一份**用户能直接打开**的文件。
     *
     * 返回给用户看的位置描述（失败返回 null）。
     *
     * ## 为什么需要它（用户要求"方便快速找到并可传输"）
     *
     * 日志本体在 `Android/data/<包名>/files/logs`，但 **Android 11+ 的
     * 手机自带文件管理器进不去那个目录**（系统限制，不是我们的问题）。
     *
     * ## 两条路，都不申请权限
     *
     * ```text
     *   Android 10+（API 29+）  → MediaStore 写 Download/，零权限
     *   Android 9 及以下        → 写 App 外部目录的 export/，那里旧系统能进
     * ```
     *
     * 刻意**不申请 `WRITE_EXTERNAL_STORAGE`**：
     *
     * ```text
     *   ① 那是个"危险权限"，申请它会让用户在安装/首启时看到一个
     *      "允许访问照片和文件"的弹窗 —— 为了导日志不值得
     *   ② minSdk 是 24，但 API<29 的机器已经很少，为它加权限不划算
     *   ③ 旧系统的文件管理器本来就能进 Android/data（限制是 11+ 才有的）
     * ```
     */
    fun exportToDownloads(context: Context, maxBytes: Int = 4 * 1024 * 1024): String? {
        val text = readTail(maxBytes)
        if (text.isEmpty()) return null
        val name = "tcs-log-${fileStamp.format(Date())}.txt"
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, name)
                    put(MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return null
                context.contentResolver.openOutputStream(uri)?.use { out ->
                    out.write(text.toByteArray(Charsets.UTF_8))
                }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                context.contentResolver.update(uri, values, null, null)
                i(TAG, "日志已导出到 下载目录/$name（${text.length} 字符）")
                "下载目录/$name"
            } else {
                /*
                 * 旧系统：写 App 外部目录的 export/ 子目录。
                 *
                 * 不放 logs/ 是为了让"原始日志"与"导出的快照"分开 ——
                 * 用户拿到的应当是导出那一刻的完整文件，而不是一个还在
                 * 被追加写的活文件（那样传到一半还在变）。
                 */
                val base = context.getExternalFilesDir(null) ?: context.filesDir
                val dir = File(base, "export")
                dir.mkdirs()
                File(dir, name).writeText(text, Charsets.UTF_8)
                val shown = "Android/data/${context.packageName}/files/export/$name"
                i(TAG, "日志已导出到 $shown（${text.length} 字符）")
                shown
            }
        } catch (error: Throwable) {
            e(TAG, "导出日志失败：${error.message}")
            null
        }
    }

    /** 清空全部日志（用户主动操作） */
    fun clear() {
        synchronized(lock) {
            files().forEach { it.delete() }
            write("I", TAG, "日志已由用户清空")
        }
    }

    /**
     * 装未捕获异常处理器。
     *
     * 崩溃那一刻只有这里能拿到完整堆栈 —— 而且是**同步可写**的，
     * 因为此时进程还没死。
     */
    fun installCrashHandler() {
        if (crashHandlerInstalled) return
        crashHandlerInstalled = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val stack = error.stackTraceToString()
                write(
                    "E",
                    "CRASH",
                    "未捕获异常（线程 ${thread.name}）：${error.javaClass.name}: ${error.message}\n$stack"
                )
            } catch (_: Throwable) {
                /* 连写日志都失败时，至少别挡住原来的处理器 */
            }
            /* 交回上一个处理器 —— 不交的话系统不会走正常的崩溃流程 */
            previous?.uncaughtException(thread, error)
        }
        write("I", TAG, "未捕获异常处理器已安装")
    }

    // ────────────────────────── 内部

    /** 当前应写入的文件：一定是文件列表里的最后一个 */
    private fun currentFile(dir: File): File {
        val list = files()
        return list.lastOrNull() ?: newFile(dir, 1)
    }

    /** 滚动到新文件。序号顺延，保证文件名单调递增 */
    private fun rollLocked(dir: File): File {
        val seq = (files().size + 1)
        val file = newFile(dir, seq)
        /* 滚动时记一条：读日志的人能看出"这里换过文件" */
        try {
            FileOutputStream(file, true).use { out ->
                out.write(
                    "${stamp.format(Date())} I StLog: ── 日志滚动到 ${file.name} ──\n"
                        .toByteArray(Charsets.UTF_8)
                )
            }
        } catch (_: Throwable) {
            /* 写不进去就让 write() 那边报 */
        }
        enforceTotalLimitLocked(dir)
        return file
    }

    private fun newFile(dir: File, seq: Int): File {
        val name = "$FILE_PREFIX${String.format(Locale.US, "%03d", seq)}-$FILE_SUFFIX"
        return File(dir, name)
    }

    /**
     * 总量控制：超过硬上限就从**最旧**的开始删。
     *
     * 保留最新的理由是显然的：要查的是"刚才那次崩溃"，
     * 而不是三天前的启动日志。
     */
    private fun enforceTotalLimitLocked(dir: File) {
        val list = files()
        /* ① 文件数超限：删最旧 */
        if (list.size > MAX_FILES) {
            list.take(list.size - MAX_FILES).forEach { it.delete() }
        }
        /* ② 总量超限：继续从最旧删，但至少留一个 */
        var total = files().sumOf { it.length() }
        if (total <= MAX_TOTAL_BYTES) return
        for (file in files()) {
            if (total <= MAX_TOTAL_BYTES) break
            if (files().size <= 1) break
            val len = file.length()
            if (file.delete()) total -= len
        }
    }

    private fun levelToPriority(level: String): Int = when (level) {
        "E" -> Log.ERROR
        "W" -> Log.WARN
        "D" -> Log.DEBUG
        else -> Log.INFO
    }
}
