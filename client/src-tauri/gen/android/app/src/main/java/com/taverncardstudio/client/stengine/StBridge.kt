package com.taverncardstudio.client.stengine

import android.content.Context
import java.io.File
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

/**
 * 移动端 UI ↔ 引擎的桥（v0.1.7 / T15.3）。
 *
 * ## 为什么需要一个 JS 桥而不是走 Tauri 的 `invoke`
 *
 * Tauri 的 `invoke` 走的是 Rust 侧的 `#[tauri::command]`，而这里要拉起的
 * 是**前台服务 + 外部进程** —— 那是纯 Android 生命周期的东西，绕 Rust 一圈
 * 只会让"服务没起来"这件事更难定位（两个进程、两套日志）。
 *
 * ## 安全边界
 *
 * `@JavascriptInterface` 暴露的方法**只做很窄的事**：开始、停止、查状态、
 * 发 HTTP（用户已配置的服务端）、读只读的安装包资源。
 * 不暴露"执行任意命令"、不暴露任意文件路径、不接受端口参数 ——
 * 页面里跑了什么第三方脚本都不能借它越权。
 *
 * `readAsset()` 是**白名单**式的（只认下面 `READABLE_ASSETS` 里的名字），
 * 不接受任意路径 —— 否则它就成了"读安装包任意文件"的通道。
 *
 * `sharePng()` 只做一件事：把一段 PNG 字节**写进缓存目录**再拉起系统分享面板。
 * 它不读、不删、不支持任意路径，字节由页面给出、文件名由它自己生成。
 *
 * 这也是为什么 `start()` 不接受参数：端口与参数全在 Kotlin 侧决定。
 */
class StBridge(
    private val context: Context,
    /**
     * 把一段 JS 送进页面的通道（2026-11-05 加）。
     *
     * `@JavascriptInterface` 的方法**没有** WebView 引用，所以异步结果
     * 没法自己回传。由 `MainActivity.onWebViewCreate` 注入一个
     * "执行这段 JS" 的闭包（内部是 `webView.post { evaluateJavascript }`）。
     *
     * 默认空实现：单测/桌面端构造 StBridge 时不必提供。
     */
    private val deliver: (String) -> Unit = {},
) {

    companion object {
        private const val TAG = "StBridge"

        /** 页面里注入的名字。前端用 `window.__ST_ENGINE__` 访问 */
        const val JS_NAME = "__ST_ENGINE__"

        /**
         * 允许页面读取的安装包资源（**白名单**，不是路径）。
         *
         * `card-face-default.png` 是桌面端那张内置默认卡面，由
         * `tauri.conf.json` 的 `bundle.resources` 打进来（APK 里位于
         * `assets/card-face-default.png`，已核实）。
         *
         * 移动端导入仓库里的卡时要用它当底图 —— `buildPngCard` 需要一个
         * PNG 容器才能把卡数据塞进 tEXt 块。用桌面端同一张图，两端的
         * "没有封面时长什么样"才一致；各造一张迟早不一样。
         */
        private val READABLE_ASSETS = setOf("card-face-default.png")

        /** 扫描失败时的回包（形状与正常回包一致，多一个 `error` 字段） */
        private const val FAILED_SCAN = "{\"candidates\":[],\"removed\":[],\"error\":\"scan-failed\"}"

        /** 删除失败时的回包 */
        private const val FAILED_REMOVE = "{\"candidates\":[],\"removed\":[],\"error\":\"remove-failed\"}"
    }

    /**
     * 启动引擎（解包 → 起服务 → 等端口）。
     *
     * ## 必须立刻返回，不能在 JS 线程上等
     *
     * `JavascriptInterface` 的方法跑在 WebView 的 JS 线程上。阻塞它会冻结
     * 整个页面（连"正在启动…"都画不出来）。所以这里只做"拉服务"这一个
     * 非阻塞动作，进度通过轮询 `status()` 拿 —— 与 Rust 侧流式用事件
     * 而不是返回值是同一个道理。
     */
    @JavascriptInterface
    fun start() {
        Log.i(TAG, "页面请求启动引擎")
        StService.start(context)
    }

    @JavascriptInterface
    fun stop() {
        Log.i(TAG, "页面请求停止引擎")
        StService.stop(context)
    }

    /**
     * 查状态。**同步返回 JSON 字符串**。
     *
     * 为什么是字符串而不是对象：`@JavascriptInterface` 的返回值只支持
     * 基本类型与 String，返回对象会被转成 `[object Object]`（不报错，
     * 前端拿到一个没用的字符串）。
     *
     * 字段：
     * · `ready`   端口上有我们认得的 ST 在应答
     * · `port`    实际端口（可能是备用端口 8001+）
     * · `rssMb`   常驻内存（通知里那个数字的来源）
     * · `unpacked` 引擎文件是否已解开
     * · `error`   最近一次失败原因（没有则 null）
     */
    /**
     * 角色目录（`files/st-data/default-user/characters`）。
     *
     * 与 `TestCardSeeder` 同一个拼法 —— 那条路径在真机上验证过。
     * 注意**不建目录**：这里只是回答"在哪"，建目录是启动流程的事。
     */
    private fun charactersDir(): File =
        File(File(StUnpacker.dataDir(context), "default-user"), "characters")

    /**
     * 发一个 HTTP 请求（2026-11-04，T15.2 阶段 A）。
     *
     * ## 为什么网络要走这里，而不是 WebView 的 fetch
     *
     * 真机实测（Redmi Note 8 Pro / Android 11）：
     *
     * ```text
     *   fetch('http://127.0.0.1:8000/version')   → TypeError: Failed to fetch
     *   fetch('https://10.9.0.2:8443/version')   → TypeError: Failed to fetch
     *   XMLHttpRequest 同一地址                   → 挂住，5 秒超时
     * ```
     *
     * **连本机回环都失败**，而聊天功能一直正常 —— 因为聊天走的是
     * `invoke()` 到 Rust 的 reqwest，从来不经过 WebView 的网络栈。
     *
     * 也就是说这个 App 里"WebView 发网络请求"这条路从来没被验证过可用。
     *
     * ## 为什么用 HttpURLConnection 而不是在 Rust 侧做
     *
     * 试过给 reqwest 加 `rustls-tls`，但它依赖 `ring` —— 而 ring 需要用
     * NDK 的 clang 编译 C 代码，在这套交叉编译环境里直接失败。
     *
     * 而 HttpURLConnection 走 **Android 系统证书链**：比自带一份 TLS 栈更正确，
     * 也不用编译 C。
     *
     * ## 安全边界（这里比其它方法宽，所以必须写清楚）
     *
     * · 只允许 `http://` / `https://` —— 传 `file://` / `content://` 一律拒绝
     * · 不跟随跨协议重定向（https → http 直接拒绝）
     * · `insecure` 关证书校验，只由前端在**用户明确确认风险后**传 true
     *
     * 仍然不接受"执行命令"、不接受任意文件路径。
     *
     * ## ★★★ 同步阻塞会**冻结 JS 线程**（2026-11-05 更正）
     *
     * 原来这里写的是"阻塞它不会卡界面"—— **那句是错的**。
     *
     * `@JavascriptInterface` 的方法虽然跑在 JavaBridge 线程上，但 JS 侧
     * 调它是**同步等待**的：WebView 的 JS 执行线程会一直停在这句调用上，
     * 直到 Kotlin 返回。所以 `connectTimeout = 15_000` 意味着
     * **服务端连不上时整个 App 冻 15 秒** —— 点不了 Tab、点不了任何按钮。
     *
     * 用户实测就是这个：
     *
     * > 如果服务器连不上的情况下点到仓库后会卡很久而且卡的时候不能对APP
     * > 做任何操作包括切底部tab，这个是不能阻塞的
     *
     * 所以新增 `httpRequestAsync()`（见下面），JS 侧只用那一条。
     * 这个方法保留是为了不破坏别的调用点，但**前端不该再用它**。
     */
    @JavascriptInterface
    fun httpRequest(specJson: String): String = performHttp(specJson)

    /**
     * 异步发一个 HTTP 请求（2026-11-05）。
     *
     * ## 为什么要异步
     *
     * 同步版会冻结 JS 线程（见 `httpRequest` 的注释）。而仓库页在
     * **服务端连不上**时要等满 connectTimeout —— 用户会看到整个 App 卡死。
     *
     * ## 协议
     *
     * ```text
     *   ① JS:  __ST_ENGINE__.httpRequestAsync(specJson, requestId)   ← 立刻返回
     *   ② Kotlin: 后台线程发请求
     *   ③ Kotlin: 完成后回调页面
     *        window.__TCS_HTTP__(requestId, "<reply json>")
     * ```
     *
     * `requestId` 由 JS 生成（自增序号），用来把回调对上是哪个请求 ——
     * 并发多个请求时不能靠"顺序"。
     *
     * ## 为什么不在 UI 线程发
     *
     * `HttpURLConnection` 是阻塞 API。放 UI 线程会 ANR（系统直接杀进程）。
     * 用普通 `Thread` 而不是线程池：仓库操作本来就是低频的，
     * 而线程池在进程退出时还要收尾。
     */
    @JavascriptInterface
    fun httpRequestAsync(specJson: String, requestId: String) {
        Thread({
            val reply = performHttp(specJson)
            /*
             * `reply` 是 JSON 文本，JSON 本身就是合法的 JS 对象字面量，
             * 直接内联是安全的（这里不是 HTML 上下文，不存在 `</script>` 问题）。
             * `requestId` 用 `JSONObject.quote` 转义，防注入。
             */
            val script =
                "window.__TCS_HTTP__ && window.__TCS_HTTP__(${JSONObject.quote(requestId)}, $reply);"
            try {
                deliver(script)
            } catch (error: Throwable) {
                Log.w(TAG, "httpRequestAsync 回传失败：${error.javaClass.simpleName}")
            }
        }, "tcs-http").start()
    }

    /**
     * 扫描角色目录里的候选卡（2026-11-09，A1）。
     *
     * ## 为什么拆成"扫描 / 删除"两次调用
     *
     * 判据（什么算内置测试卡）只有一份，在
     * `shared/src/android/test-card-cleanup.ts` 的 `isBuiltinTestCard` 里，
     * 有单测守着。Kotlin 侧只做"列目录 + 读字段 + 删文件"。
     *
     * 若让 Kotlin 自己判，就变成两份实现：一份有测试、一份没有 ——
     * 漂了也没人知道，而代价是**误删用户的卡**（不可逆）。
     *
     * 所以：`scanTestCards` → JS 用判据筛 → `removeTestCards`。
     *
     * ## 为什么异步
     *
     * `@JavascriptInterface` 的方法跑在 JS 线程上，扫目录 + 读文件在
     * 卡多的时候要几十毫秒 —— 冻住页面就能被用户看见（白屏/掉帧）。
     * 与 `httpRequestAsync` 同一个范式：立刻返回，结果走 `deliver` 回传。
     */
    @JavascriptInterface
    fun scanTestCards(requestId: String) {
        Thread({
            val reply = try {
                TestCardCleaner.toJson(TestCardCleaner.scan(context), emptyList())
            } catch (error: Throwable) {
                Log.w(TAG, "扫描测试卡失败：${error.javaClass.simpleName}")
                FAILED_SCAN
            }
            val script =
                "window.__TCS_TESTCARDS__ && window.__TCS_TESTCARDS__(${JSONObject.quote(requestId)}, $reply);"
            try {
                deliver(script)
            } catch (error: Throwable) {
                Log.w(TAG, "scanTestCards 回传失败：${error.javaClass.simpleName}")
            }
        }, "tcs-testcards").start()
    }

    /**
     * 删掉 JS 判据命中的卡。
     *
     * @param namesJson JSON 字符串数组，如 `["测试用-夜航小助手.png"]`
     */
    @JavascriptInterface
    fun removeTestCards(namesJson: String, requestId: String) {
        Thread({
            val reply = try {
                val array = JSONArray(namesJson)
                val names = ArrayList<String>()
                for (i in 0 until array.length()) names.add(array.optString(i, ""))
                val removed = TestCardCleaner.remove(context, names.filter { it != "" })
                TestCardCleaner.toJson(emptyList(), removed)
            } catch (error: Throwable) {
                Log.w(TAG, "删除测试卡失败：${error.javaClass.simpleName}")
                FAILED_REMOVE
            }
            val script =
                "window.__TCS_TESTCARDS__ && window.__TCS_TESTCARDS__(${JSONObject.quote(requestId)}, $reply);"
            try {
                deliver(script)
            } catch (error: Throwable) {
                Log.w(TAG, "removeTestCards 回传失败：${error.javaClass.simpleName}")
            }
        }, "tcs-testcards-rm").start()
    }

    private fun performHttp(specJson: String): String {
        val result = JSONObject()
        var connection: java.net.HttpURLConnection? = null
        try {
            val spec = JSONObject(specJson)
            val urlText = spec.optString("url", "").trim()
            if (!urlText.startsWith("http://") && !urlText.startsWith("https://")) {
                return fail(result, "只支持 http / https 地址")
            }

            val url = java.net.URL(urlText)
            connection = url.openConnection() as java.net.HttpURLConnection
            connection.requestMethod = spec.optString("method", "GET").uppercase()
            /*
             * ★★★ 连接超时与读取超时**必须分开设**（2026-11-06）。
             *
             * 原来两个都用同一个 `timeoutMs`（15 秒）。真机实测"地址写错"：
             *
             * ```text
             *   点登录 → 15043ms 才报「无法连接服务端」
             * ```
             *
             * 这 15 秒里 UI 是流畅的（898 帧 / 15 秒 = 60fps），但用户
             * 盯着一个按钮看 15 秒，体验上就是"卡"。
             *
             * 两件事的时间尺度本来差一个数量级：
             *
             * ```text
             *   建立连接（TCP + TLS 握手）  内网 1～20ms，公网 100～2000ms
             *                                ⇒ 8 秒还没连上，基本可以断定不通
             *   等首字节（服务端在处理）    慢的服务器/大响应可能要十几秒
             *                                ⇒ 给 20 秒，不许当成"连不上"
             * ```
             *
             * 所以：`connectTimeout` 用 `connectTimeoutMs`（默认 8 秒），
             * `readTimeout` 仍用 `timeoutMs`（默认 15 秒）。
             * 两个都能由前端覆盖，不写死。
             */
            connection.connectTimeout = spec.optInt("connectTimeoutMs", 8_000)
            connection.readTimeout = spec.optInt("timeoutMs", 15_000)
            connection.instanceFollowRedirects = true

            /* 关掉证书校验（只对用户已确认风险的自定义仓库） */
            if (spec.optBoolean("insecure", false) &&
                connection is javax.net.ssl.HttpsURLConnection
            ) {
                connection.sslSocketFactory = insecureSocketFactory()
                connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
            }

            val headers = spec.optJSONArray("headers")
            if (headers != null) {
                for (i in 0 until headers.length()) {
                    val pair = headers.optJSONArray(i) ?: continue
                    connection.setRequestProperty(pair.optString(0), pair.optString(1))
                }
            }

            /*
             * 请求体有两种写法，**`bodyBase64` 优先**（2026-11-07）：
             *
             * ```text
             *   body        UTF-8 文本（JSON 接口用）
             *   bodyBase64  base64 字节流（multipart 表单用）
             * ```
             *
             * ## 为什么必须加二进制通道
             *
             * 语音转写的 multipart 路线（Groq / OpenAI / 本地 whisper.cpp /
             * 中转站）要把音频文件拼进表单。而整条桥原来只收 UTF-8 字符串 ——
             * 于是这些厂商在真机上**全部不可用**，报的还是"网络请求失败"。
             *
             * 真机实测（2026-11-07）：加这条通道之前，9 种语音方式里
             * 只有 2 种（百炼，走 JSON+base64）能用。
             *
             * ★ 音频是二进制，绝不能当字符串传：UTF-8 解码会把 0x80–0xFF
             *   的字节替换成 U+FFFD，写回去就是坏文件 —— 服务端只会说
             *   "无法解析的音频"，而错误信息完全不指向真因。
             */
            val bodyBase64 = if (spec.isNull("bodyBase64")) null else spec.optString("bodyBase64", "")
            val body = if (spec.isNull("body")) null else spec.optString("body", "")
            if (bodyBase64 != null) {
                connection.doOutput = true
                val bytes = android.util.Base64.decode(bodyBase64, android.util.Base64.DEFAULT)
                connection.outputStream.use { it.write(bytes) }
            } else if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }

            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream

            /*
             * ## `binary: true`：响应体按**字节**读，以 base64 回传
             *
             * 默认按 UTF-8 读成文本（JSON 接口用）。但二进制（JPEG/PNG 缩略图）
             * 走文本会被 UTF-8 解码破坏 —— 真机实测：2055 字节的 JPEG 读成
             * String 后前端 `btoa` 直接抛
             * `contains characters outside of the Latin1 range`
             * （0x80–0xFF 的字节被替换成 U+FFFD，信息已丢）。
             *
             * 所以图片必须走这条：Kotlin 侧读原始字节 → base64 → 前端解码。
             * 缩略图只有 2 KB，base64 约 2.7 KB，完全可接受。
             */
            val wantBinary = spec.optBoolean("binary", false)
            val text: String
            if (wantBinary) {
                val bytes = stream?.use { it.readBytes() } ?: ByteArray(0)
                result.put("bytes", bytes.size)
                text = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
            } else {
                text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            }

            val headerArray = org.json.JSONArray()
            connection.headerFields.forEach { (name, values) ->
                if (name == null || values == null) return@forEach
                val pair = org.json.JSONArray()
                pair.put(name)
                pair.put(values.joinToString(", "))
                headerArray.put(pair)
            }

            result.put("status", status)
            result.put("headers", headerArray)
            result.put("body", text)
            result.put("ok", true)
            return result.toString()
        } catch (error: Throwable) {
            Log.w(TAG, "httpRequest 失败：${error.javaClass.simpleName} ${error.message}")
            /*
             * 说人话。三种失败用户要做的事完全不同：
             * 连不上（改地址）/ 证书不对（换证书或自签确认）/ 超时（查网络）。
             */
            val message = when (error) {
                is java.net.SocketTimeoutException -> "请求超时，检查地址与网络"
                is java.net.UnknownHostException -> "找不到这个域名，检查地址是否写对"
                is javax.net.ssl.SSLException ->
                    "证书校验失败。如果这是你自己的服务器且用了自签证书，需要确认风险后重试"
                is java.net.ConnectException -> "连不上这个地址，检查端口与服务是否在运行"
                else -> "${error.javaClass.simpleName}: ${error.message ?: ""}"
            }
            return fail(result, message)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * 读一个**白名单内**的安装包资源，返回 `{ ok, base64, bytes }`。
     *
     * ## 为什么需要它（2026-11-04）
     *
     * 移动端要从仓库导入卡：仓库里存的是卡 JSON，而写回角色库要一张
     * **PNG 容器**（`buildPngCard` 往 tEXt 块里塞数据）。没有封面时得有张底图。
     *
     * 桌面端那张兜底图是 `resources/card-face-default.png`，已由
     * `bundle.resources` 打进 APK（`assets/card-face-default.png`，核实过）。
     * 用它而不是另造一张：两端"没封面时长什么样"才算一致。
     *
     * ## 为什么返回 base64 而不是 `number[]`
     *
     * 那张图 891 KB。`number[]` 序列化成 `137,80,78,71,...` 约 300 万字符；
     * base64 只有约 119 万字符，且解码是纯字符串扫描。跨 JNI 传大字符串
     * 本来就要小心，能小一半是一半。
     *
     * ## 白名单而不是路径参数
     *
     * 这个方法一旦接受任意路径，就成了"读安装包任意文件 + 泄漏给页面"的通道。
     * 所以只认 `READABLE_ASSETS` 里那几个名字，别的一律拒绝。
     */
    @JavascriptInterface
    fun readAsset(name: String): String {
        val result = JSONObject()
        val key = name.trim()
        if (!READABLE_ASSETS.contains(key)) {
            return fail(result, "不允许读取这个资源")
        }
        return try {
            val bytes = context.assets.open(key).use { it.readBytes() }
            result.put("ok", true)
            result.put("bytes", bytes.size)
            result.put(
                "base64",
                android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP),
            )
            result.toString()
        } catch (error: Throwable) {
            Log.w(TAG, "读资源失败：$key ${error.javaClass.simpleName} ${error.message}")
            fail(result, "安装包缺少这个资源（$key）")
        }
    }

    /**
     * 把一段 PNG 导出并拉起**系统分享面板**（2026-11-04，用户要求
     * 「支持将卡导出为PNG分享出来」）。
     *
     * ## 为什么必须由原生做
     *
     * WebView 里既没有 `navigator.share`（这个壳里连 `fetch` 都不通），
     * 也没有写文件的能力。而"分享"在 Android 上是一条 `ACTION_SEND` Intent，
     * 只能从 Activity 起。
     *
     * ## 为什么要写进缓存目录
     *
     * `ACTION_SEND` 带 `file://` URI 在 Android 7+ 会抛
     * `FileUriExposedException`。必须走 `FileProvider` 换一个 `content://`。
     * 项目里 Tauri 已经注册了 FileProvider（`${applicationId}.fileprovider`），
     * 且 `file_paths.xml` 里声明了 `cache-path` —— 所以写 `cacheDir` 就能被分享。
     *
     * ## 为什么不接受路径参数
     *
     * 那等于给页面一个"往任意位置写文件"的能力。这里只接受**字节**，
     * 文件名自己生成（`card-<时间戳>.png`），落点固定为缓存目录。
     *
     * ## 返回
     *
     * `{ ok, uri, bytes }` / `{ ok:false, error }`。分享面板是否真的选了应用
     * 拿不到（那是系统 UI），所以只报到"面板已拉起"为止 —— 不谎报"已分享"。
     */
    @JavascriptInterface
    fun sharePng(base64: String, fileName: String): String {
        val result = JSONObject()
        try {
            val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            if (bytes.isEmpty()) return fail(result, "要分享的内容是空的")

            /*
             * 文件名只保留安全字符：页面上来的是角色名，可能带 `/`、`:`、中文标点。
             * 保留中文（用户看得出是哪张卡），只滤掉路径分隔符与控制字符。
             */
            val safe = fileName.trim().mapNotNull { ch ->
                when {
                    ch.code < 0x20 || ch.code == 0x7f -> null
                    ch in "/\\:*?\"<>|" -> '_'
                    else -> ch
                }
            }.joinToString("").ifEmpty { "card" }.take(60)

            val dir = java.io.File(context.cacheDir, "share")
            if (!dir.exists() && !dir.mkdirs()) return fail(result, "建不了临时目录")
            val file = java.io.File(dir, if (safe.endsWith(".png")) safe else "$safe.png")
            file.writeBytes(bytes)

            val authority = context.packageName + ".fileprovider"
            val uri = androidx.core.content.FileProvider.getUriForFile(context, authority, file)

            val send = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                type = "image/png"
                putExtra(android.content.Intent.EXTRA_STREAM, uri)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            /*
             * ★ 必须 NEW_TASK：`@JavascriptInterface` 跑在 WebView 的线程上，
             * 没有 Activity 上下文，直接 startActivity 会抛
             * `AndroidRuntimeException: Calling startActivity() from outside of an Activity context`。
             */
            val chooser = android.content.Intent.createChooser(send, "分享卡片").apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            /*
             * 用 application context 起。WebView 线程没有 Activity ——
             * 这是唯一不依赖 UI 线程上下文的写法。
             */
            context.startActivity(chooser)

            result.put("ok", true)
            result.put("uri", uri.toString())
            result.put("bytes", bytes.size)
            return result.toString()
        } catch (error: Throwable) {
            Log.w(TAG, "sharePng 失败：${error.javaClass.simpleName} ${error.message}")
            val message = when (error) {
                is java.lang.IllegalArgumentException -> "文件分享配置不对：${error.message ?: ""}"
                is android.content.ActivityNotFoundException -> "这台设备没有可分享的应用"
                else -> "${error.javaClass.simpleName}: ${error.message ?: ""}"
            }
            return fail(result, message)
        }
    }

    /** 构造一个"什么都不校验"的 SocketFactory（仅用于用户已确认的自签证书） */
    private fun insecureSocketFactory(): javax.net.ssl.SSLSocketFactory {
        val trustAll = object : javax.net.ssl.X509TrustManager {
            override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
        }
        val ctx = javax.net.ssl.SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf<javax.net.ssl.TrustManager>(trustAll), java.security.SecureRandom())
        return ctx.socketFactory
    }

    private fun fail(into: JSONObject, message: String): String {
        into.put("ok", false)
        into.put("error", message)
        return into.toString()
    }

    @JavascriptInterface
    fun status(): String {
        /*
         * ★ 这里**只读缓存，不做网络探测**。
         *
         * 这个方法跑在 WebView 的 JS 线程上，而 `probe()` 最长要等 800ms
         * （连接 + 读超时）。前端每秒轮询一次的话，页面会每秒卡 0.8 秒。
         *
         * 缓存的更新责任在服务侧（启动完成 / RSS 刷新 / 进程退出三处），
         * 见 `StLauncher.refreshReady()` 与 `markStopped()`。
         */
        val json = JSONObject()
        json.put("ready", StLauncher.ready)
        json.put("port", StLauncher.activePort)
        json.put("rssMb", StLauncher.residentMb)
        json.put("unpacked", StUnpacker.isUnpacked(context))
        json.put("running", StLauncher.isOurProcessAlive())
        json.put("error", StService.lastError ?: JSONObject.NULL)
        /*
         * 角色目录的**绝对路径**（2026-11-04，T15.2 阶段 B）。
         *
         * 为什么在这里给：卡片编辑器要把改好的 PNG 写回角色文件，
         * 而只有 Kotlin 侧知道 `filesDir` 的真实位置。前端拿不到就写不了。
         *
         * 与 `TestCardSeeder` 用同一个拼法（`default-user/characters`），
         * 真机查过：角色在 `files/st-data/default-user/characters/`。
         */
        json.put("charactersDir", charactersDir().absolutePath)
        return json.toString()
    }
}
