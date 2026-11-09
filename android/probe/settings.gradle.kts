// T15.3 生死项。仓库里只需要一个 module，插件版本在 app/build.gradle.kts 里声明。
/*
 * 仓库顺序：**国内镜像在前**、官方在后。
 *
 * 不是"偏好"问题 —— 实测本机到 dl.google.com / services.gradle.org 的下载速度
 * 约 35 KB/s（130 MB 要 45 分钟），而腾讯镜像能跑满。把镜像放前面省的是**分钟级**等待，
 * 官方仓库留着是为了"镜像没同步某个新版本时仍能构建"。
 *
 * 只在构建脚本里排顺序，不改机器上的任何全局配置 —— 这个项目不该污染开发者的
 * ~/.gradle/init.gradle。
 */
pluginManagement {
    repositories {
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        maven("https://mirrors.cloud.tencent.com/nexus/repository/gradle-plugins/")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        maven("https://mirrors.cloud.tencent.com/nexus/repository/maven-public/")
        google()
        mavenCentral()
    }
}
rootProject.name = "tcs-node-probe"
include(":app")
