// 根项目：只声明插件版本，不应用。
//
// 为什么不能把 `version "8.7.3"` 写在 app/build.gradle.kts 的 plugins 块里：
// 模块级脚本**不允许**声明插件版本（只有根项目或 settings 的 pluginManagement 能）。
// 写了不报明显的错，而是让脚本编译在别处失败（实测报的是
// "build.gradle.kts:31:6 Expecting '}'"，指到 defaultConfig 的结束括号上 ——
// 一个和真实原因完全无关的位置）。
plugins {
    id("com.android.application") version "8.7.3" apply false
}
