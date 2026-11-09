// T15.3 生死项：最小验证 APK
//
// 这个模块**故意只做一件事**：把 libnode.so 放进 jniLibs、让系统解到
// nativeLibraryDir、然后 exec 它跑 --version。
// 任何"顺手加个界面""顺手接一下 ST"的想法都要拒绝 ——
// 它的作用是**判定生死**，不是功能原型。功能多一点，失败时就更难定位
// 是 W^X 不通还是别的什么不通。
plugins {
    id("com.android.application")
}

android {
    namespace = "studio.taverncard.probe"
    compileSdk = 34

    defaultConfig {
        applicationId = "studio.taverncard.probe"
        minSdk = 24
        // targetSdk 必须是 34：低 targetSdk 会进入兼容模式、放宽 W^X，
        // 于是"能跑"是假绿 —— 而线上装的是 targetSdk 34 的包。
        // 这条不是"顺手对齐"，是把判据钉在真实约束上。
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        ndk {
            // 只打 arm64：Node 产物是 aarch64，其它 ABI 打了也用不上，
            // 而且会把 APK 撑大（libnode.so 本身 94.9 MB）。
            abiFilters += listOf("arm64-v8a")
        }
    }

    /*
     * extractNativeLibs 的处置（这是整个 APK 的核心）。
     *
     * AGP 4.2+ 在 minSdk >= 23 时默认 `extractNativeLibs=false`：.so 不落地，
     * 直接从 APK mmap。那样 `nativeLibraryDir` 里**没有文件**，
     * 我们想 exec 的路径根本不存在。
     *
     * 这里显式设成 true，让系统把 lib/arm64-v8a 下的 .so 解到
     * /data/app/.../lib/arm64/libnode.so（**只读**，因此不受 W^X 限制）。
     *
     * 与 manifest 的 `android:extractNativeLibs="true"` **两处都要写**：
     * manifest 是最终权威（AGP 会把它写进 APK），Gradle 这里是让打包行为一致。
     * 只写一处时曾经出现过"manifest 写了但 AGP 仍按 false 打包"的情况。
     */
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    /*
     * release 签名。参数从环境变量读，**不落仓库**。
     *
     * 为什么从一开始就用 release：debug 与 release 签名不兼容，
     * 先用 debug 装 = 以后换 release 必须卸载重装，而卸载会清用户数据。
     *
     * 缺参数时**不要让构建悄悄退回 debug 签名** —— 那会打出一个
     * "看起来成功、其实签名不对"的包，比构建失败更糟。所以直接报错。
     */
    signingConfigs {
        create("release") {
            val store = System.getenv("TCS_KEYSTORE")
            val pass = System.getenv("TCS_KEYSTORE_PASSWORD")
            val alias = System.getenv("TCS_KEY_ALIAS")
            if (store.isNullOrBlank() || pass.isNullOrBlank() || alias.isNullOrBlank()) {
                throw GradleException(
                    "缺签名参数：请设置 TCS_KEYSTORE / TCS_KEYSTORE_PASSWORD / TCS_KEY_ALIAS。" +
                        "keystore 用 vendor/android-env/gen-release-keystore.sh 生成。"
                )
            }
            storeFile = file(store)
            storePassword = pass
            keyAlias = alias
            keyPassword = pass
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 不混淆：这个包是判定用的，反编译要能直接看到逻辑。
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 刻意零依赖：不引 AndroidX、不引 Compose。
    // 判定包每多一个依赖，失败时就多一个"是不是它的问题"。
}
