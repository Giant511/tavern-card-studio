package com.taverncardstudio.client.stengine

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * 清理早期版本播进用户角色目录的**内置测试卡**（2026-11-09，0.1.7 收尾）。
 *
 * ## 背景
 *
 * v0.1.7 早期包首启时会把 `assets/test-card/test-card.png` 拷进
 * `default-user/characters/`。那个 `TestCardSeeder` 与资产都已删除，
 * 但**已经装过早期包的机器上，那张卡还在** ——
 * 删播种器只保证"不再播新的"，不会清掉已经种下去的。
 *
 * 所以升级后必须扫一遍并删掉，否则那些用户会一直看到
 * 「测试用-夜航小助手」这个角色，以为是产品自带内容。
 *
 * ★ 这个缺口在测试机上看不出来：测试机做过 `pm clear`（数据全清）。
 * **测试机的干净会掩盖真机的不干净**。
 *
 * ## 判据为什么在 TS 里，不在这里
 *
 * 「什么算测试卡」的判断放在 `shared/src/android/test-card-cleanup.ts`
 * （`isBuiltinTestCard`），有单测。Kotlin 这边只负责：
 *
 * ```text
 *   列目录 → 读出 (文件名, character_version) → 交给判据 → 删命中项
 * ```
 *
 * 判断写两份必然漂移 —— 而且 Kotlin 那份没有测试，漂了也没人知道。
 *
 * ## 这里**不**删"看起来像测试"的任何东西
 *
 * 双判据同时命中才删（文件名前缀 `测试用-` **且** version 是 `test-asset`）。
 * 宁可留着一张没人用的卡，也不能误删用户改过的卡 ——
 * 角色卡是用户数据，误删不可逆。
 */
object TestCardCleaner {
    private const val TAG = "TestCardCleaner"

    /**
     * 一张候选卡的识别信息（送进判据的原料）。
     *
     * @param fileName 文件名（含 `.png`）
     * @param characterVersion PNG 里 `character_version` 的值；读不到为 null
     */
    data class Candidate(val fileName: String, val characterVersion: String?)

    /**
     * 扫描角色目录，返回所有 `.png` 的识别信息。
     *
     * 读 version 的方式是**在字节里找 `"character_version"` 后面的值**，
     * 而不是完整解析 PNG / base64-解码 `chara` 块：
     *
     * ```text
     *   我们播的那张卡的 tEXt 里是明文 JSON（`chara` 或 v3 的 `ccv3`）
     *   ⇒ 直接搜字节就能命中，几十行代码 vs 引一个 PNG 解析器
     * ```
     *
     * 只读前 [MAX_SCAN_BYTES] 字节：tEXt 块在 PNG 头部，
     * 而一张卡可能几 MB（含立绘），全读进来是浪费。
     */
    fun scan(context: Context): List<Candidate> {
        val dir = charactersDir(context)
        if (!dir.isDirectory) return emptyList()

        val out = ArrayList<Candidate>()
        val files = dir.listFiles() ?: return emptyList()
        for (file in files) {
            if (!file.isFile) continue
            val name = file.name
            if (!name.lowercase().endsWith(".png")) continue
            out.add(Candidate(name, readCharacterVersion(file)))
        }
        return out
    }

    /**
     * 把判据命中的卡删掉（[hitNames] 是 TS 判据算好的结果）。
     *
     * @return 真的删掉的（删失败的不会出现在这里 —— 不能对用户谎报"已清理"）
     */
    fun remove(context: Context, hitNames: Collection<String>): List<String> {
        val dir = charactersDir(context)
        val removed = ArrayList<String>()
        for (name in hitNames) {
            /*
             * 只允许删目录内的普通文件：`name` 来自扫描结果，但多一道
             * 校验不亏 —— 带路径分隔符的名字一律拒绝（防 `../` 逃逸）。
             */
            if (name.contains('/') || name.contains('\\')) continue
            val target = File(dir, name)
            if (!target.isFile) continue
            try {
                if (target.delete()) {
                    removed.add(name)
                } else {
                    Log.w(TAG, "删不掉：${target.absolutePath}")
                }
            } catch (error: Throwable) {
                Log.w(TAG, "删异常：${target.absolutePath} ${error.javaClass.simpleName}")
            }
        }
        return removed
    }

    /**
     * 角色目录。与已删除的 `TestCardSeeder` 用同一个拼法
     * （`default-user/characters`）—— 那条路径在真机上验证过。
     */
    private fun charactersDir(context: Context): File =
        File(File(StUnpacker.dataDir(context), "default-user"), "characters")

    /** 只读头部，见 `scan` 的注释 */
    private const val MAX_SCAN_BYTES = 512 * 1024

    /**
     * 从 PNG 字节里取 `character_version`。
     *
     * 失败一律返回 `null`（"读不到"）。**不要返回空串**：
     * 空串的语义是"读到了、但值是空的"，判据会因此下不同结论。
     */
    private fun readCharacterVersion(file: File): String? {
        return try {
            val length = minOf(file.length(), MAX_SCAN_BYTES.toLong()).toInt()
            if (length <= 0) return null
            val buffer = ByteArray(length)
            file.inputStream().use { input ->
                var offset = 0
                while (offset < length) {
                    val read = input.read(buffer, offset, length - offset)
                    if (read <= 0) break
                    offset += read
                }
            }
            extractVersion(String(buffer, Charsets.ISO_8859_1))
        } catch (error: Throwable) {
            null
        }
    }

    /**
     * 在（可能被 base64 包过的）文本里找 version。
     *
     * 两种形态都要认：
     *
     * ```text
     *   v2 卡   tEXt 块 `chara`      → base64(JSON)
     *   v3 卡   tEXt 块 `ccv3`       → base64(JSON)
     *   少数工具直接写 JSON          → 明文
     * ```
     *
     * 所以先在原文里找；找不到再试"把长串 base64 解码后找"。
     */
    private fun extractVersion(text: String): String? {
        findVersionInJson(text)?.let { return it }

        /*
         * base64 里找：扫一遍长度足够的 base64 片段，解码后再找。
         * 不做完整 PNG 解析 —— 我们要的只是一个字段值。
         */
        val regex = Regex("[A-Za-z0-9+/=]{200,}")
        for (match in regex.findAll(text)) {
            val decoded = try {
                String(Base64.decode(match.value, Base64.DEFAULT), Charsets.UTF_8)
            } catch (error: Throwable) {
                continue
            }
            findVersionInJson(decoded)?.let { return it }
        }
        return null
    }

    private fun findVersionInJson(text: String): String? {
        val key = "\"character_version\""
        val at = text.indexOf(key)
        if (at < 0) return null
        val colon = text.indexOf(':', at + key.length)
        if (colon < 0) return null
        val quote = text.indexOf('"', colon + 1)
        if (quote < 0) return null
        val end = text.indexOf('"', quote + 1)
        if (end < 0) return null
        return text.substring(quote + 1, end)
    }

    /**
     * 把扫描结果与删除结果打包成回传给 JS 的 JSON。
     *
     * 形状与 `shared/src/android/test-card-cleanup.ts` 的 `CardIdentity`
     * 对齐：`{ candidates: [{fileName, characterVersion}], removed: [name] }`。
     */
    fun toJson(candidates: List<Candidate>, removed: List<String>): String {
        val root = JSONObject()
        val list = JSONArray()
        for (one in candidates) {
            val item = JSONObject()
            item.put("fileName", one.fileName)
            /* null 必须真的写 null，不能写空串 —— 判据靠它区分"读不到"与"读到了是空的" */
            if (one.characterVersion === null) item.put("characterVersion", JSONObject.NULL)
            else item.put("characterVersion", one.characterVersion)
            list.put(item)
        }
        root.put("candidates", list)
        val removedArray = JSONArray()
        for (name in removed) removedArray.put(name)
        root.put("removed", removedArray)
        return root.toString()
    }
}
