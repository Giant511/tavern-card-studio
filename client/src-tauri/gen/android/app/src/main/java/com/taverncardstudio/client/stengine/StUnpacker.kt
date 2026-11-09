package com.taverncardstudio.client.stengine

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * ST 1.19 首次解包（v0.1.7 / T15.3）。
 *
 * ## 为什么是"从 assets 解"而不是"联网下载"
 *
 * 决策 #262：全量打包。用户对体积不敏感（129 MB 的 APK 已经装得下去），
 * 而"首启还要再下 400 MB"是真正的流失点 —— 手机流量、弱网、中途切后台。
 *
 * ## 判据：解包完成 = 标记文件存在 + 关键文件在
 *
 * 只判"标记文件存在"不够：上次解包可能在中途被杀，标记却先写了。
 * 只判"关键文件在"也不够：解包到一半 `server.js` 已经落地、
 * 但 `node_modules` 还缺一半 —— 这种情况下 ST 会以一个**难以归因**的
 * MODULE_NOT_FOUND 挂掉。
 *
 * 所以两个判据同时成立才算解包完成（见 [isUnpacked]）。
 *
 * ## 进度
 *
 * 用"已写字节 / 预估总字节"，分母 `ST_UNPACKED_BYTES` 与
 * `shared/src/android/st-lifecycle.ts` 的 `ST_UNPACKED_BYTES` **必须一致**
 * （有测试钉住）。封顶 0.99 的语义也在那边定义：
 * 不许显示 100% 而实际还在解。
 */
object StUnpacker {

    private const val TAG = "StUnpacker"

    /** assets 里的包名。与 `scripts/pack-st-assets.mjs` 的产出对应 */
    const val ASSET_NAME = "st.zip"

    /**
     * 解包后的目录（`files/st`）。
     *
     * W^X 只限制"执行可写目录里的文件"，不限制"node 读可写目录里的 server.js"，
     * 所以 ST 放这儿是合法的 —— 只有 `libnode.so` 必须待在只读的 nativeLibraryDir。
     */
    fun stDir(context: Context): File = File(context.filesDir, "st")

    /** `--dataRoot` 指向这里：用户数据（聊天/角色/设置）长期存放 */
    fun dataDir(context: Context): File = File(context.filesDir, "st-data")

    /** 完成标记。**最后**写，所以它存在就意味着前面都写完了 */
    private fun markerFile(context: Context): File = File(stDir(context), ".unpacked")

    /**
     * 是否已解包完成（双判据）。
     *
     * `server.js` 是 ST 的入口，`node_modules/.package-lock.json` 是依赖装齐的
     * 最可靠信号（npm 在装完后写它）。两个都在 + 标记在，才算完成。
     */
    fun isUnpacked(context: Context): Boolean {
        val root = stDir(context)
        return markerFile(context).exists() &&
            File(root, "server.js").exists() &&
            File(root, "node_modules/.package-lock.json").exists()
    }

    /**
     * 解包。**阻塞**，必须在后台线程调用（437 MB，实测十几秒到一分钟）。
     *
     * @param onProgress 0..1。封顶 0.99（语义见 `unpackProgress`）
     * @return 成功返回 null；失败返回给用户看的一句话
     */
    fun unpack(context: Context, onProgress: (Double) -> Unit): String? {
        val root = stDir(context)
        val total = estimateTotalBytes(context)

        Log.i(TAG, "开始解包 → ${root.absolutePath}（预估 $total 字节）")

        /*
         * 先删标记再解 —— 顺序不能反。
         *
         * 如果先解后删标记，那么"上次解到一半被杀、标记还在"的机器上，
         * 这次解包中途再被杀，标记仍是旧的、内容是新旧混合的，
         * `isUnpacked` 会判 true 而 ST 起不来。
         */
        markerFile(context).delete()

        root.mkdirs()

        var written = 0L
        var lastReported = -1.0

        try {
            context.assets.open(ASSET_NAME).use { raw ->
                ZipInputStream(raw.buffered()).use { zip ->
                    while (true) {
                        val entry = zip.nextEntry ?: break

                        /*
                         * Zip Slip 防护：entry.name 可能含 `../`。
                         *
                         * 这不是理论风险 —— 打包脚本是我们自己写的，但
                         * ST 的 node_modules 里有大量符号链接与奇特点名，
                         * 一旦某个名字被解释成上级目录，就会写到 files/ 之外。
                         * 用 canonicalPath 前缀校验，比过滤字符串可靠。
                         */
                        val target = File(root, entry.name)
                        val canonicalRoot = root.canonicalPath + File.separator
                        if (!target.canonicalPath.startsWith(canonicalRoot) &&
                            target.canonicalPath != root.canonicalPath
                        ) {
                            Log.w(TAG, "跳过越界条目：${entry.name}")
                            zip.closeEntry()
                            continue
                        }

                        if (entry.isDirectory) {
                            target.mkdirs()
                            zip.closeEntry()
                            continue
                        }

                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { out ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val read = zip.read(buffer)
                                if (read <= 0) break
                                out.write(buffer, 0, read)
                                written += read
                            }
                        }

                        /*
                         * 每个条目上报一次，但**去重**：进度精确到 0.5% 就够了，
                         * 每个条目都发一次会让 UI 线程被刷爆（几万个小文件）。
                         */
                        val progress = unpackProgress(written, total)
                        if (progress - lastReported >= 0.005) {
                            lastReported = progress
                            onProgress(progress)
                        }

                        zip.closeEntry()
                    }
                }
            }
        } catch (error: Exception) {
            // 失败原因要能指导下一步：ENOSPC（空间不足）与 EOF（包坏了）完全不同
            Log.e(TAG, "解包失败", error)
            return "释放引擎文件失败：${error.javaClass.simpleName} ${error.message ?: ""}".trim()
        }

        // ★ 标记文件最后写 —— 它是"前面都成功了"的凭据
        markerFile(context).writeText("st-1.19.0\n${System.currentTimeMillis()}\n")

        onProgress(0.99)

        if (!isUnpacked(context)) {
            /*
             * 解完了但判据不成立（比如 zip 里缺 node_modules）。
             * 这种情况必须报出来 —— 否则会退化成"ST 起不来但没有原因"。
             */
            return "引擎文件不完整。请卸载重装后再试一次。"
        }

        Log.i(TAG, "解包完成，共写 $written 字节")
        return null
    }

    /** assets 里的 zip 有多大 —— 用作估算分母的兜底 */
    private fun estimateTotalBytes(context: Context): Long {
        return try {
            context.assets.openFd(ASSET_NAME).use { it.length }
                /*
                 * 压缩包比解包后小，所以这里乘一个经验系数。
                 *
                 * 这个值只影响**进度条的斜率**，不影响正确性（
                 * `unpackProgress` 会封顶 0.99）。
                 * 用 `st.zip` 的 418 MB → 437 MB 实测比例 ≈ 1.045，取 1.1 留余量。
                 */
                .let { (it * 1.1).toLong() }
        } catch (error: Exception) {
            Log.w(TAG, "读不到 assets 大小，用预估常量", error)
            ST_UNPACKED_BYTES
        }
    }

    /**
     * 进度计算。**与 `shared/src/android/st-lifecycle.ts` 的 `unpackProgress` 同语义**。
     *
     * 为什么在 Kotlin 里再写一遍：Android 侧跑不了 TS。所以那边是"规格 + 单测"，
     * 这边是"实现"，两边靠 `test/android-st-engine.test.mjs` 对常量做一致性断言
     * （谁改了数字没同步，测试就红）。
     */
    fun unpackProgress(writtenBytes: Long, totalBytes: Long): Double {
        if (writtenBytes <= 0 || totalBytes <= 0) return 0.0
        val ratio = writtenBytes.toDouble() / totalBytes.toDouble()
        return if (ratio >= 1.0) 0.99 else ratio
    }

    /** spike 实测的解包后体积（437 MB）。与 TS 侧 `ST_UNPACKED_BYTES` 一致 */
    const val ST_UNPACKED_BYTES: Long = 437L * 1024 * 1024
}
