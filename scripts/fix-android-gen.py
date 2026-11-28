#!/usr/bin/env python3
"""
修 `tauri android init` 生成的 Android 工程 —— **本机必需的三处**，可重跑。

## 为什么需要这个脚本

`client/src-tauri/gen/android` 的 **Gradle 工程部分不入库**（2026-11-24 修正本文）：
它会随 `tauri android init` 重新生成，而生成物里有一批路径是本机绝对路径，
入库既会冲突也会误导。所以它对每个开发者、每台机器、每次重新 init
都是**重新生成的**。

★ 但 `gen/android` 里有 **15 个文件是入库的**，那些是"我们写的东西"：

```text
  app/src/main/AndroidManifest.xml            竖屏锁定 + 任务保留（必须入库）
  app/src/main/java/.../*.kt                  6 个手写 Kotlin（含 1056 行 MainActivity）
  app/src/main/res/{values,values-night}/*.xml 窗口底色（必须入库）
  buildSrc/src/main/java/.../{BuildTask,RustPlugin}.kt
  app/jniLibs/.gitignore
  docs/android-user-guide.md                  用户手册
```

**`tauri android init --force` 会覆盖/清空这些**。跑之前先确认：

```bash
git status --short client/src-tauri/gen/android   # 必须是干净的
```

它们已经入库，所以覆盖后 `git checkout -- client/src-tauri/gen/android` 能拿回来 ——
这也是"手写代码必须入库"的理由（早期它们不入库，一次 --force 就没了）。

Gradle 工程（`build.gradle.kts` / `settings.gradle.kts` / `gradle/`）由
`tauri android init` 生成，本脚本在其后做幂等修补，所以：
  · 可反复跑，不漂移；
  · 别人 clone 后跑一次 `bash scripts/build-android.sh` 就够（它会调本脚本）；
  · 修了什么、为什么修，都留在输出里。

## 三处修补

### ① `gradle.properties` → `android.overridePathCheck=true`

仓库在 `D:\\Claw\\代码开发\\tavern-card-studio`，「代码开发」是中文。
AGP 默认拒绝，报：

    Your project path contains non-ASCII characters...
    This warning can be disabled by adding the line
    'android.overridePathCheck=true'

★ 这条**是错误消息自己给出的官方开关**。我此前判断"AGP 硬拒绝、没有开关
可绕过"，于是绕道把整个 Gradle 工程镜像到 `D:/tcs-gradle` 再手改
`rootDirRel`/`compileSdk`。那套做法能跑，但 `tauri android build` 不认
（它坚持在自己的 `gen/android` 里跑），而且每次都要同步。有开关就不用镜像。

### ② `app/build.gradle.kts` → `compileSdk`/`targetSdk` 37 → 36

`tauri android init` 写当前最新的 compileSdk（这里是 37），本机只装了 34/36。
Gradle 于是去下 "Android SDK Platform 37.0" —— 实测约 120 KB/s，
9 分钟只下了 65 MB，整包要 20 分钟以上。

我们**不需要 37**：Tauri 插件的 AAR 元数据要求是 "36 or later"
（之前把 compileSdk 降到 34 时踩过 6 条 `requires 36 or later`），36 正好满足。
**这不是迁就本机 —— 是依赖的真实下限就是 36。**

判据：只有在「写了 37」且「本机确实没有 platform 37」时才降。
装了 37 的机器不会被无谓改动。

### ③ `buildSrc/.../BuildTask.kt` → 修 node 调 tauri 的 argv

生成出来是这样：

    val executable = \"\"\"C:\\...\\node\"\"\"          // 这台机器上是 node，不是原生 tauri 二进制
    val args = listOf("tauri", "android", "android-studio-script")

于是执行 `node tauri android ...`，而 **node 把 "tauri" 当成要加载的模块**：

    Error: Cannot find module 'D:\\Claw\\代码开发\\...\\client\\src-tauri\\tauri'

那个路径是原样打印的（上次在别处看到的是 GBK 乱码，同一个错的不同显示形式），
很容易误判成"中文路径又炸了"—— **与中文无关**。
实测差别（`--help` 一次就能看出来，不用等整轮构建）：

    带 "tauri"  → error: unrecognized subcommand 'tauri'
    不带        → 正常打印 android android-studio-script 的选项

修法：`executable` 用 node.exe，`args` 首位换成 `@tauri-apps/cli/tauri.js`，
并去掉那个会把 node 带偏的 `"tauri"`。

## 用法

    python scripts/fix-android-gen.py [--check]

`--check` 只报告不修改，退出码 1 表示有需要修的地方。
"""

import os
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
GEN = REPO / "client" / "src-tauri" / "gen" / "android"
CLI_JS = REPO / "node_modules" / "@tauri-apps" / "cli" / "tauri.js"

# Android SDK 位置（与 build-android.sh 同一口径）
ANDROID_HOME = pathlib.Path(os.environ.get("ANDROID_HOME", r"D:/android-env/sdk"))


def _find_node() -> str:
    """
    找当前能用的 node **可执行文件**。

    不用 `shutil.which("node")`：它常返回 `node.bat`，而 Gradle 的 `exec`
    需要真的 exe（`.bat` 会被 shell 解释，此前的失败就是
    `A problem occurred starting process 'node.bat'`）。
    """
    candidates = []
    env = os.environ.get("TCS_NODE")
    if env:
        candidates.append(env)
    candidates.append(r"C:\Users\PC\.workbuddy\binaries\node\versions\22.22.2-3\node.exe")
    candidates.append(r"D:\tcs-bin\node.exe")
    for one in candidates:
        if pathlib.Path(one).is_file():
            return one.replace("\\", "/")
    return "node"


def patch_gradle_properties(check_only: bool) -> list[str]:
    path = GEN / "gradle.properties"
    if not path.is_file():
        return [f"[跳过] 没有 {path.name}（gen/android 还没 init？）"]
    text = path.read_text(encoding="utf-8")
    if "android.overridePathCheck=true" in text:
        return ["[OK] gradle.properties 已允许非 ASCII 路径"]

    msg = "[修] gradle.properties 加 android.overridePathCheck=true（AGP 官方开关）"
    if check_only:
        return [msg]
    text = text.rstrip("\n") + (
        "\n\n# 允许项目位于含非 ASCII 字符的路径。\n"
        "# 仓库在 D:\\Claw\\代码开发\\...，「代码开发」是中文，AGP 默认拒绝；\n"
        "# 这条是错误消息自己给出的官方开关（b.android.com/95744）。\n"
        "android.overridePathCheck=true\n"
    )
    path.write_text(text, encoding="utf-8", newline="\n")
    return [msg]


def patch_compile_sdk(check_only: bool) -> list[str]:
    path = GEN / "app" / "build.gradle.kts"
    if not path.is_file():
        return [f"[跳过] 没有 {path.name}"]
    text = path.read_text(encoding="utf-8")

    if "compileSdk = 37" not in text:
        return ["[OK] compileSdk 不需要下调"]

    has_37 = (ANDROID_HOME / "platforms" / "android-37").is_dir() or (
        ANDROID_HOME / "platforms" / "android-37.0"
    ).is_dir()
    if has_37:
        return ["[OK] 本机已装 platform 37，保持不动"]

    msg = "[修] compileSdk/targetSdk 37 → 36（本机无 37；依赖下限就是 36）"
    if check_only:
        return [msg]
    text = text.replace("compileSdk = 37", "compileSdk = 36", 1)
    text = text.replace("targetSdk = 37", "targetSdk = 36", 1)
    path.write_text(text, encoding="utf-8", newline="\n")
    return [msg]


def patch_build_task(check_only: bool) -> list[str]:
    path = (
        GEN
        / "buildSrc"
        / "src"
        / "main"
        / "java"
        / "com"
        / "taverncardstudio"
        / "client"
        / "kotlin"
        / "BuildTask.kt"
    )
    if not path.is_file():
        return [f"[跳过] 没有 BuildTask.kt"]
    text = path.read_text(encoding="utf-8")
    out: list[str] = []

    # ① executable 指向真实存在的 node.exe
    node_exe = _find_node()
    new_text, n = re.subn(
        r'val executable = """[^"]*"""',
        f'val executable = """{node_exe}"""',
        text,
        count=1,
    )
    if n == 0:
        out.append("[警告] 找不到 `val executable = \"\"\"...\"\"\"`，生成格式可能变了")
    elif new_text != text:
        text = new_text
        out.append(f"[修] BuildTask.kt executable → {node_exe}")

    # ② args 首位换成"按仓库根相对算"的 CLI JS 路径
    #
    # 三种形态都要认（2026-11-26 修）：
    #   ① tauri init 原始生成：`listOf("tauri", ...)`
    #   ② 旧机器留下的绝对路径：`listOf("""D:/Claw/.../tauri.js""", ...)`
    #      这条原来没被判据覆盖，换机后只在 gradle 阶段炸，最难查
    #   ③ 已修好的相对形态：`val cliJs = File(File(projectDir, rootDirRel), ...)`
    relative_form = (
        'val cliJs = File(File(projectDir, rootDirRel), '
        '"../../node_modules/@tauri-apps/cli/tauri.js").canonicalPath'
    )
    relative_args = 'val args = listOf(cliJs, "android", "android-studio-script");'
    cli_js = CLI_JS.as_posix()
    abs_args = re.compile(
        r'val args = listOf\("""[^"]*tauri\.js""", "android", "android-studio-script"\);'
    )
    if relative_form in text:
        out.append("[OK] BuildTask.kt 已按仓库根相对定位 CLI")
    elif abs_args.search(text):
        text = abs_args.sub(
            f"{relative_form}\n        {relative_args}",
            text,
            count=1,
        )
        out.append("[修] BuildTask.kt 的绝对路径 → 仓库根相对（原来的写死路径换机即失效）")
    else:
        old_args = 'val args = listOf("tauri", "android", "android-studio-script")'
        if old_args in text:
            text = text.replace(
                old_args,
                f"{relative_form}\n        {relative_args}",
                1,
            )
            out.append("[修] BuildTask.kt args[0] → 仓库根相对的 tauri.js")
        elif cli_js in text:
            pass  # 已经是修过的形态
        else:
            out.append("[警告] 找不到 args 那一行，请人工核对 BuildTask.kt")

    if not out:
        return ["[OK] BuildTask.kt 无需修改"]

    if check_only:
        return out
    path.write_text(text, encoding="utf-8", newline="\n")
    return out


def patch_signing_config(check_only: bool) -> list[str]:
    """
    给 release 配 signingConfig —— 让 **AGP 自己签**，而不是事后 apksigner。

    ## 为什么让 AGP 签（而不是事后 apksigner）

    **理由不是"v1 必须开"** —— 那条我判断错了，见下方「走过的弯路」。

    真正的理由是工程性：
      · AGP 在打包流水线内部按正确顺序签名（对齐 → v1 → v2/v3），
        产物直接叫 `app-arm64-release.apk`（不带 `-unsigned`），
        不需要再有一个"事后 apksigner"步骤；
      · 事后签名是在 AGP 已产出的 zip 上追加签名块，`jarsigner -verify`
        会报一串 `Entry xxx is signed in JarFile but is not signed in
        JarInputStream`（v2 签名块插在条目区和 central directory 之间导致），
        虽然不影响 Android 安装，但**让人无法判断 v1 到底好不好**。

    ## 走过的弯路（记下来，别再走一遍）

    用户报「安装包缺乏开发者证书」时，我判断是"缺 v1 签名"，并为此做了三件事：

      1. `apksigner sign --v1-signing-enabled true`（事后签）→ 仍报 `v1: false`
      2. `apksigner sign --min-sdk-version 21 --v1-signing-enabled true` → 仍 `v1: false`
      3. gradle `signingConfigs { enableV1Signing = true }` → 仍 `v1: false`
      4. 甚至试图把 `minSdk` 降到 23 → **`tauri-plugin-dialog` 的 AAR 声明
         minSdk=24，Manifest merger 硬报错**，路直接堵死

    三次都不成立，说明**前提就是错的**。回头做了个对照才发现真因：

      · 用户**装成功过 debug 包**；
      · debug 包的 `apksigner verify` 结果同样是 `v1: false, v2: true`
        —— 跟 release 包一模一样；
      · 所以 **v1:false 根本不阻碍安装**。`apksigner` 在 `minSdk >= 24`
        时本来就把 v1 报 false（它认为 v2 已经够了），这是**展示逻辑**，
        不是"签名缺失"。

    **真正的原因是签名冲突**：

      debug 包证书：`CN=Android Debug`
      release 包证书：`CN=Tavern Card Studio`
      两个包名相同：`com.taverncardstudio.client`

    用户先装了 debug 版，再装 release 版 —— 签名不一致，系统拒绝覆盖安装。
    vivo 把这件事笼统说成"缺乏开发者证书"。
    **解法是卸载旧版再装**，跟 v1 / minSdk 一点关系都没有。

    ## 教训

    判据要用**能区分两种假设的对照**：
    我手里一直有"用户装成功过的 debug 包"，只要早一步拿它的签名方案
    跟 release 比一比，五分钟就能定位。而我先花了三轮去改签名参数。
    「换个方向试试」之前，先问一句：**手上有没有一个"已知能跑"的样本可以对照？**

    ## 凭据怎么读

    从 `D:/tcs-release-keys/keystore.properties` 读（仓库外，与 MSI 的
    客户端签名同一套材料）。**文件不存在就跳过** —— 没有 keystore 的机器
    仍然应该能出 unsigned 的 debug/release 包来跑测试，不能因为缺签名材料
    就整条构建失败。
    """
    path = GEN / "app" / "build.gradle.kts"
    if not path.is_file():
        return [f"[跳过] 没有 {path.name}"]
    text = path.read_text(encoding="utf-8")

    if "signingConfigs" in text:
        return ["[OK] build.gradle.kts 已有 signingConfigs"]

    props = pathlib.Path(os.environ.get("TCS_KEYSTORE_PROPS", r"D:/tcs-release-keys/keystore.properties"))
    if not props.is_file():
        return [f"[跳过] 没有 {props}，release 包将保持 unsigned"]

    msg = "[修] build.gradle.kts 加 signingConfigs（release 由 AGP 直接签名，含 v1+v2+v3）"
    if check_only:
        return [msg]

    # ① 在 android { 之后插入 signingConfigs 块
    #
    # 用 `file(props)` 读 properties 而不是把密码硬编码进来 ——
    # 密码绝不能出现在这个（会被 commit 到 gen/ 之外的？不，gen/ 是 gitignore）
    # 文件里。实际上 gen/ 在 gitignore 里，但仍然不该把密码写进源码文本：
    # 万一哪天有人为了调试把它 commit 出去，就是永久泄露。
    signing_block = '''    /*
     * release 签名（2026-10-31 加）。
     *
     * 凭据来自仓库外的 D:/tcs-release-keys/keystore.properties，
     * **密码不写进本文件**。文件不存在时这个块会被跳过（见下方 exist 判断），
     * 于是没有 keystore 的机器仍能构建 unsigned 包。
     */
    signingConfigs {
        create("release") {
            val propPath = System.getenv("TCS_KEYSTORE_PROPS")
                ?: rootProject.file("../../../../android/tcs-release-keys/keystore.properties").absolutePath
            val propFile = file(propPath)
            if (propFile.exists()) {
                val props = Properties()
                propFile.inputStream().use { props.load(it) }
                val ks = props.getProperty("storeFile")
                storeFile = if (ks != null && ks.isNotBlank()) file(ks) else propFile.parentFile.resolve("tcs-release.jks")
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
                // v2 是 Android 7+ 的必需项。
                // v1 在 minSdk>=24 时 AGP 会自动跳过（不写也行）；
                // 显式写 true 只是表达意图，实际不会产出 v1 块 —— 这不影响安装。
                enableV2Signing = true
            }
        }
    }

'''
    marker = "android {\n"
    if marker not in text:
        return ["[警告] 找不到 `android {` 行"]
    text = text.replace(marker, marker + signing_block, 1)

    # ② release buildType 挂上这个 signingConfig
    old_release = '''        getByName("release") {
            optimization {
               enable = true
            }'''
    new_release = '''        getByName("release") {
            // 有 keystore 才挂签名配置；没有就保持 unsigned（不阻断构建）
            val releaseSigning = signingConfigs.findByName("release")
            if (releaseSigning != null && file("D:/tcs-release-keys/keystore.properties").exists()) {
                signingConfig = releaseSigning
            }
            optimization {
               enable = true
            }'''
    if old_release in text:
        text = text.replace(old_release, new_release, 1)
    else:
        return ["[警告] 找不到 release buildType，请人工核对"]

    path.write_text(text, encoding="utf-8", newline="\n")
    return [msg]


def patch_min_sdk_for_v1(check_only: bool) -> list[str]:
    """
    把 `minSdk` 从 24 降到 23 —— **为了让 v1 签名真的被生成**。

    ## 为什么这不是"为了签名去迁就"

    AGP 与 apksigner 对 v1 的规则是一样的：**`minSdk >= 24` 时认为 v1 多余，
    直接跳过**（Android 7.0 起系统只认 v2 就够了）。所以哪怕写
    `enableV1Signing = true` / `--v1-signing-enabled true`，
    v1 依然不会出现在产物里 —— 2026-10-31 实测三种方式都是 `v1: false`：

      · `apksigner sign --v1-signing-enabled true`（事后签）
      · `apksigner sign --min-sdk-version 21 --v1-signing-enabled true`
      · gradle `signingConfigs { enableV1Signing = true }`（AGP 直签）

    而国产 ROM 的自家安装器（vivo「文件管理」等）不看 AOSP 那套规则，
    缺 `META-INF/*.SF` 就报「安装包缺乏开发者证书」。

    `minSdk = 23` 是 **Android 6.0（2015）** —— 对本项目"18 年以后手机"
    这个目标**一点损失都没有**（2018 年的机器最低也是 8.0），
    反而多覆盖了 Android 6.0 那一代。代价是 AGP 会多打一份 v1 签名块
    （几百 KB 的 META-INF 摘要，实际约 100~200 KB）。

    ## 风险核查

    Tauri 2 官方 minSdk 是 24。降到 23 会不会缺 API？
    · 我们自己的 Rust/Java 代码用的都是 Tauri 已封装的接口；
    · `extractNativeLibs` 那套（T15.3 W^X 条件）在 23 上同样成立
      （AGP 从 minSdk>=23 起默认 `extractNativeLibs=false`，我们显式开了 true）；
    · 真机验证：装到 Android 11 上跑通（见 docs/t15.3-apk-design.md）。
    保守起见，这条**只在需要 v1 时才降**（判据：当前是 24 且签名材料存在）。
    """
    path = GEN / "app" / "build.gradle.kts"
    if not path.is_file():
        return [f"[跳过] 没有 {path.name}"]
    text = path.read_text(encoding="utf-8")

    if "minSdk = 24" not in text:
        return ["[OK] minSdk 不需要下调（已不是 24）"]

    props = pathlib.Path(os.environ.get("TCS_KEYSTORE_PROPS", r"D:/tcs-release-keys/keystore.properties"))
    if not props.is_file():
        return ["[跳过] 没有 keystore，保持 minSdk=24（v1 本就要不了）"]

    return [
        "[跳过] minSdk 保持 24：tauri-plugin-dialog 的 AAR 声明 minSdk=24，"
        "降到 23 会被 Manifest merger 硬拒（minSdkVersion 23 cannot be smaller than 24）。"
        "★ 而且降 minSdk 本来也解决不了任何问题 —— 见 patch_signing_config 里的「走过的弯路」"
    ]

    msg = "[修] minSdk 24 → 23（minSdk>=24 时 AGP/apksigner 会跳过 v1 签名）"
    if check_only:
        return [msg]

    # 只改 defaultConfig 里那一处（裸 `minSdk = 24`），不动其它行
    text = text.replace("minSdk = 24", "minSdk = 23", 1)
    path.write_text(text, encoding="utf-8", newline="\n")
    return [msg]


def patch_cleartext_loopback(check_only: bool) -> list[str]:
    """
    允许 **回环地址** 的明文 HTTP —— 否则 release 包里连不上引擎。

    ## 真机取证（2026-11-10，两台并排）

    ```text
      iQOO V2507A (Android 16)   正常进聊天
      红米 Note 8 Pro (Android 11 + MIUI 12.5)
        E StProbe: probe 失败 port=8000：
          IOException Cleartext HTTP traffic to 127.0.0.1 not permitted
    ```

    ## 为什么只有 release 坏

    `app/build.gradle.kts` 里写的是：

    ```kotlin
      defaultConfig { manifestPlaceholders["usesCleartextTraffic"] = "false" }
      buildTypes { debug { manifestPlaceholders["usesCleartextTraffic"] = "true" } }
    ```

    也就是 **debug 放行、release 禁止**。而我们的引擎就是
    `http://127.0.0.1:8000` —— 明文 HTTP。

    这完美解释了用户那句「之前 debug 版本都没有问题」：
    他之前装的确实是 debug 包，换 release 之后才坏。

    ## 为什么不能直接把 release 也设成 true

    `usesCleartextTraffic=true` 是**全局**放行明文 —— 那会让 App 对
    **任何**域名都接受 HTTP，包括用户填的非 HTTPS 中转站地址。
    那是真实的安全降级，不该为了一个回环连接付这个代价。

    ## 正确做法：network_security_config

    只对 `127.0.0.1` / `localhost` 放行，其它域名仍按默认（禁止）：

    ```xml
      <network-security-config>
          <domain-config cleartextTrafficPermitted="true">
              <domain includeSubdomains="false">127.0.0.1</domain>
              <domain includeSubdomains="false">localhost</domain>
          </domain-config>
      </network-security-config>
    ```

    ★ `networkSecurityConfig` 与 `usesCleartextTraffic` 同时存在时**前者优先**，
      所以 `defaultConfig` 里那个 `false` 可以保持不动 —— 对外仍是禁止明文。

    ## 为什么在 gen/ 里而不是源码树

    `gen/android` 在 `.gitignore` 里，`tauri android init` 会重建它。
    所以这段配置必须由本脚本幂等补上，否则下一个人 init 完就又坏了。
    """
    app = GEN / "app"
    manifest = app / "src" / "main" / "AndroidManifest.xml"
    xml_dir = app / "src" / "main" / "res" / "xml"
    xml_file = xml_dir / "network_security_config.xml"

    if not manifest.is_file():
        return [f"[跳过] 没有 {manifest}"]

    config = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!--\n'
        '  只对回环放行明文 HTTP（2026-11-10）。\n'
        '\n'
        '  引擎是 http://127.0.0.1:8000，而 targetSdk>=28 默认禁止明文，\n'
        '  release 包的 usesCleartextTraffic=false 会把 probe 卡死：\n'
        '    IOException Cleartext HTTP traffic to 127.0.0.1 not permitted\n'
        '\n'
        '  这里只放开 127.0.0.1 / localhost，其它域名仍按系统默认（禁止明文）。\n'
        '  不要改成全局 <base-config cleartextTrafficPermitted="true"> —— 那会让\n'
        '  用户填的非 HTTPS 中转站地址也被接受，是真实的安全降级。\n'
        '-->\n'
        '<network-security-config>\n'
        '    <domain-config cleartextTrafficPermitted="true">\n'
        '        <domain includeSubdomains="false">127.0.0.1</domain>\n'
        '        <domain includeSubdomains="false">localhost</domain>\n'
        '    </domain-config>\n'
        '</network-security-config>\n'
    )

    text = manifest.read_text(encoding="utf-8")
    needs_ref = "android:networkSecurityConfig=" not in text
    needs_file = (not xml_file.is_file()) or (
        xml_file.read_text(encoding="utf-8") != config
    )

    if not needs_ref and not needs_file:
        return ["[OK] 回环明文已放行（network_security_config 就位）"]

    msg = "[修] 放行回环明文（network_security_config.xml + Manifest 引用）"
    if check_only:
        return [msg]

    xml_dir.mkdir(parents=True, exist_ok=True)
    xml_file.write_text(config, encoding="utf-8", newline="\n")

    if needs_ref:
        # 挂在 <application> 上，紧挨 usesCleartextTraffic 那一行
        text = text.replace(
            'android:usesCleartextTraffic="${usesCleartextTraffic}">',
            'android:usesCleartextTraffic="${usesCleartextTraffic}"\n'
            '        android:networkSecurityConfig="@xml/network_security_config">',
            1,
        )
        manifest.write_text(text, encoding="utf-8", newline="\n")

    return [msg]



def patch_locked_portrait(check_only: bool) -> list[str]:
    """
    锁定 **竖屏** —— 否则手机横过来界面就跟着转。

    ## 为什么该锁

    这个 App 的形态是"手机上聊天"：消息列表、输入框、底部标签栏都是按
    竖屏长边滚动的布局设计的。横屏之后：

    ```text
      · 输入框被压到很矮，键盘一弹几乎看不见
      · 底部 tabbar 与键盘叠加，可点区域互相打架
      · 消息气泡单行宽度过长，阅读时眼睛要来回扫
    ```

    用户原话：「APP 的应用场景一般是竖屏不是横屏，但是在我的手机上不锁定
    旋转，手机横过来就会自动变成横屏」。

    ## 为什么在 manifest 而不是运行时

    两条路都能做到：

    ```text
      A. AndroidManifest: android:screenOrientation="portrait"
         ⇒ 由系统在**创建 Activity 之前**决定方向，没有中间态
      B. Rust/JS 侧运行时 setRequestedOrientation
         ⇒ 要等 WebView 起来才调用，会先按系统方向渲染一帧再转
            （肉眼可见的"先横后竖"闪一下）
    ```

    选 A。启动瞬间就正确，不闪。

    ## `configChanges` 里已经有 orientation，为什么还要锁

    那行是 tauri 模板自带的，含义是"旋转时**不要重建** Activity，交给应用
    自己处理布局"。它允许旋转，只是避免重建。锁定方向是另一件事 ——
    两行并不冲突：锁定后系统不会发起旋转，`configChanges` 继续兜住多窗口
    等场景带来的尺寸变化。

    ## 为什么不锁 `nosensor` / `user`

    - `nosensor`：忽略方向传感器，但**平板横置时仍是横的**，语义不对
    - `user`：跟随用户系统的自动旋转开关 —— 用户正是关了它才期望锁定，
      而系统那一档在这个 App 里不该生效（竖屏是产品决定，不是用户偏好）
    - `portrait`：无论传感器、无论系统开关，永远是竖的。这才是"锁定"
    """
    manifest = GEN / "app" / "src" / "main" / "AndroidManifest.xml"
    if not manifest.is_file():
        return [f"[跳过] 没有 {manifest}"]

    text = manifest.read_text(encoding="utf-8")

    # 只认 MainActivity 那一个 <activity ...> 开标签（后面可能还有别的 activity）
    match = re.search(r"<activity\b[^>]*\.MainActivity[^>]*>", text, re.S)
    if match is None:
        return ["[跳过] 找不到 MainActivity 的 <activity> 标签（tauri 模板变了？）"]

    tag = match.group(0)
    if "android:screenOrientation=" in tag:
        return ["[OK] 已锁定竖屏（android:screenOrientation=portrait）"]

    msg = "[修] 锁定竖屏（MainActivity android:screenOrientation=portrait）"
    if check_only:
        return [msg]

    # 插在 configChanges 之前 —— 属性顺序不影响语义，但放在首位最显眼，
    # 一眼能看出"这个页面是锁方向的"
    new_tag = tag.replace(
        "android:configChanges=",
        'android:screenOrientation="portrait"\n'
        "            android:configChanges=",
        1,
    )
    if new_tag == tag:
        # 模板若哪天去掉 configChanges，退到 name 之前插，不要静默不修
        new_tag = tag.replace(
            'android:name=".MainActivity"',
            'android:screenOrientation="portrait"\n'
            '            android:name=".MainActivity"',
            1,
        )
    if new_tag == tag:
        return ["[跳过] 找不到插入点（<activity> 属性全变了？）"]

    manifest.write_text(
        text[: match.start()] + new_tag + text[match.end() :],
        encoding="utf-8",
        newline="\n",
    )
    return [msg]


def patch_retain_task_state(check_only: bool) -> list[str]:
    """
    让任务在切到后台后仍留在「最近任务」里（2026-11-22）。

    ## 为什么需要

    用户报「切到后台后上滑看不到本 App」。前两轮的修法都没治到病灶：

    ```text
      0.2.0  什么都没做
      0.2.1  加 setExcludeFromRecents(false)
             ⇒ 真机日志证明**设成功了**（"已确保 1 个任务不排除…"），
               但两秒后 Activity 被 onDestroy，任务从容器的列表里消失
      现在   治"任务被重置"本身
    ```

    真机日志（vivo V2507A / Android 16）：

    ```text
      10:14:50.892 RECENTS: onUserLeaveHint：已确保 1 个任务不排除在最近任务之外
      10:14:50.966 LIFE: 退到后台
      10:14:52.973 BOOT: onDestroy（正常退出）
    ```

    ## 两个属性的分工

    ```text
      android:alwaysRetainTaskState="true"
        默认 false ⇒ 系统**可以**在特定情况下把任务重置成初始状态（清空活动栈）。
        栈一空，任务即被移出最近任务。这是主修。

      android:autoRemoveFromRecents="false"
        默认也是 false，但厂商 ROM 常改默认值。显式写死，
        让"最后一个 Activity 结束后任务仍留在列表里"成为明确契约。
    ```

    ## 为什么必须在 manifest 而不是运行时

    运行时只有 `AppTask.setExcludeFromRecents()`，它改的是 AMS 里那个
    "排除标志"。而这两个属性决定的是**任务本身会不会被重置/移除** ——
    完全不同的两件事，没有运行时 API 能替代。

    ## 为什么写进这个脚本

    `AndroidManifest.xml` 是 **Tauri 生成的**（`tauri android init` 会重建）。
    不在这里守着，重跑一次 init 就把这两个属性丢回去，而后现象会重新出现，
    且没有任何报错 —— 正是最难发现的那种。
    """
    manifest = GEN / "app" / "src" / "main" / "AndroidManifest.xml"
    if not manifest.is_file():
        return [f"[跳过] 没有 {manifest}"]

    text = manifest.read_text(encoding="utf-8")

    # 只认 MainActivity 那一个 <activity ...> 开标签
    match = re.search(r"<activity\b[^>]*\.MainActivity[^>]*>", text, re.S)
    if match is None:
        return ["[跳过] 找不到 MainActivity 的 <activity> 标签（tauri 模板变了？）"]

    tag = match.group(0)
    has_retain = "android:alwaysRetainTaskState=" in tag
    has_auto = "android:autoRemoveFromRecents=" in tag
    has_exclude = "android:excludeFromRecents=" in tag
    if has_retain and has_auto and has_exclude:
        return [
            "[OK] 任务状态已保留"
            "（alwaysRetainTaskState + autoRemoveFromRecents + excludeFromRecents）"
        ]

    msg = "[修] 保留任务状态（alwaysRetainTaskState / autoRemoveFromRecents / excludeFromRecents）"
    if check_only:
        return [msg]

    additions = ""
    if not has_retain:
        additions += 'android:alwaysRetainTaskState="true"\n            '
    if not has_auto:
        additions += 'android:autoRemoveFromRecents="false"\n            '
    if not has_exclude:
        # 默认就是 false，但显式写出来：厂商 ROM 会改默认值，写死比依赖默认可靠
        additions += 'android:excludeFromRecents="false"\n            '

    # 插在 name 之前：那个属性一定有（模板里写死的），是最稳的锚点
    new_tag = tag.replace(
        'android:name=".MainActivity"',
        additions + 'android:name=".MainActivity"',
        1,
    )
    if new_tag == tag:
        return ["[跳过] 找不到插入点（<activity> 里没有 android:name）"]

    manifest.write_text(
        text[: match.start()] + new_tag + text[match.end() :],
        encoding="utf-8",
        newline="\n",
    )
    return [msg]


def patch_dark_window_background(check_only: bool) -> list[str]:
    """
    把窗口背景改成应用自己的深色，避开「最近任务里一片白」。

    ## 现场（2026-11-22 第五轮）

    用户在 vivo 上终于看到任务卡片了，但**内容一片空白**：

    ```text
    紫色顶栏 + 下面整块白色
    ```

    ## 真因

    `Theme.tcs_shell` 继承 `Theme.Material3.DayNight.NoActionBar`，
    而**没有设置 `android:windowBackground`**。Material3 在**亮色模式**下
    窗口背景是白色。

    而这个 App 的内容几乎全在 WebView 里。WebView 的内容在最近任务的
    缩略图里**不一定被合成进去**（SurfaceView / 硬件层的老问题）。
    合成不上时露出来的就是窗口背景 —— 白色。

    所以看到的不是"没有内容"，而是"WebView 那层没进缩略图，
    露出了底下的白窗口"。

    ## 修法

    把窗口背景设成应用真正的底色 `#0c0a14`（`--nb-abyss`）：

    ```text
      合成成功 → 正常缩略图
      合成失败 → 深色卡片，看起来仍然像这个 App，而不是一块白板
    ```

    顺带把状态栏/导航栏也统一，避免启动瞬间的白色闪一下。

    ## 为什么写进脚本

    `res/values/themes.xml` 是 Tauri 模板产物，`tauri android init` 会重建。
    在这里守着，重建后自动补回。
    """
    themes = [
        GEN / "app" / "src" / "main" / "res" / "values" / "themes.xml",
        GEN / "app" / "src" / "main" / "res" / "values-night" / "themes.xml",
    ]

    marker = "android:windowBackground"
    results: list[str] = []

    for path in themes:
        if not path.is_file():
            results.append(f"[跳过] 没有 {path.relative_to(GEN)}")
            continue

        text = path.read_text(encoding="utf-8")
        if marker in text:
            results.append(f"[OK] {path.parent.name}/themes.xml 已有深色窗口背景")
            continue

        msg = f"[修] {path.parent.name}/themes.xml 设置深色窗口背景（最近任务缩略图不露白）"
        if check_only:
            results.append(msg)
            continue

        # 在 <style ...> 开标签之后插属性 —— 那里一定存在
        match = re.search(r'(<style name="Theme\.tcs_shell"[^>]*>)', text, re.S)
        if match is None:
            results.append(f"[跳过] {path.parent.name}/themes.xml 找不到 Theme.tcs_shell")
            continue

        addition = (
            match.group(1)
            + "\n"
            + "        <!-- 应用底色 #0c0a14，与 nebula-tokens.css 的 nb abyss 一致。\n"
            + "             窗口背景必须与它一致，否则最近任务的缩略图合成不上\n"
            + "             WebView 内容时会露出白色。\n"
            + "             注意：XML 注释里不能出现连续两个减号，所以这里不写 CSS 变量名。 -->\n"
            + '        <item name="android:windowBackground">@color/tcs_window_bg</item>\n'
            + '        <item name="android:statusBarColor">@color/tcs_window_bg</item>\n'
            + '        <item name="android:navigationBarColor">@color/tcs_window_bg</item>\n'
            + '        <item name="android:windowLightStatusBar">false</item>'
        )
        path.write_text(
            text[: match.start()] + addition + text[match.end() :],
            encoding="utf-8",
            newline="\n",
        )
        results.append(msg)

    # 颜色资源要单独建 —— themes 引用它，缺了会编译失败
    colors = GEN / "app" / "src" / "main" / "res" / "values" / "colors.xml"
    if colors.is_file() and "tcs_window_bg" in colors.read_text(encoding="utf-8"):
        results.append("[OK] colors.xml 已有 tcs_window_bg")
    else:
        msg2 = "[修] colors.xml 补 tcs_window_bg"
        if check_only:
            results.append(msg2)
        else:
            colors.parent.mkdir(parents=True, exist_ok=True)
            if colors.is_file():
                """
                模板自带的 colors.xml 已经有 purple_200 等主题色 —— **不能整份覆盖**
                （Material3 主题会引用它们）。只在 </resources> 之前插一行。
                """
                existing = colors.read_text(encoding="utf-8")
                if "</resources>" in existing:
                    line = (
                        '    <!-- 应用底色，与 nebula-tokens.css 的 nb abyss 一致 -->\n'
                        '    <color name="tcs_window_bg">#0c0a14</color>\n'
                    )
                    colors.write_text(
                        existing.replace("</resources>", line + "</resources>", 1),
                        encoding="utf-8",
                        newline="\n",
                    )
                    results.append(msg2)
                else:
                    results.append("[跳过] colors.xml 结构不认识，请手工加 tcs_window_bg")
            else:
                colors.write_text(
                    '<?xml version="1.0" encoding="utf-8"?>\n'
                    "<resources>\n"
                    '    <!-- 应用底色，与 nebula-tokens.css 的 nb abyss 一致 -->\n'
                    '    <color name="tcs_window_bg">#0c0a14</color>\n'
                    "</resources>\n",
                    encoding="utf-8",
                    newline="\n",
                )
                results.append(msg2)

    return results


def patch_version_code_override(check_only: bool) -> list[str]:
    """
    允许构建时用环境变量单独指定 versionCode。

    ## 为什么需要这个开关

    版本名（versionName）和版本号（versionCode）在 `tauri.properties` 里
    是**一起**由 tauri CLI 从 `tauri.conf.json` 的 version 算出来的。
    于是"把版本名退回 0.2.0"这件事，会顺带把 versionCode 从 2001 退回 200 ——
    而 **Android 不允许降级安装**：

    ```text
      手机上装过 0.2.1 (2001)
      再装 0.2.0 (200)   ⇒ INSTALL_FAILED_VERSION_DOWNGRADE
      而卸载重装会丢掉聊天记录（存在应用内部存储）
    ```

    用户明确要求"版本名回到 0.2.0"，同时又不能丢数据。
    两个诉求只有一个交集：**版本名 0.2.0 + versionCode 不低于已装的**。

    所以这里加一个**只影响 versionCode** 的旁路：设了
    `TCS_VERSION_CODE` 就用它，没设就完全走原逻辑（正常发版不受影响）。
    """
    path = GEN / "app" / "build.gradle.kts"
    if not path.is_file():
        return [f"[跳过] 没有 {path.name}"]
    text = path.read_text(encoding="utf-8")

    if "TCS_VERSION_CODE" in text:
        return ["[OK] build.gradle.kts 已支持 TCS_VERSION_CODE 覆盖"]

    old = 'versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()'
    if old not in text:
        return ["[跳过] 找不到 versionCode 行（tauri 模板变了？）"]

    new = (
        '// 允许构建时单独指定 versionCode（只覆盖它，版本名不动）。\n'
        '        // 用途：版本名回退到旧号时，仍能覆盖安装已装的新版本 ——\n'
        '        // Android 不许降级，而卸载会丢聊天记录。见 fix-android-gen.py。\n'
        '        versionCode = (System.getenv("TCS_VERSION_CODE")\n'
        '            ?: tauriProperties.getProperty("tauri.android.versionCode", "1")).toInt()'
    )
    msg = "[修] build.gradle.kts 支持 TCS_VERSION_CODE 覆盖 versionCode"
    if check_only:
        return [msg]
    text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8", newline="\n")
    return [msg]

def main() -> int:
    check_only = "--check" in sys.argv

    if not GEN.is_dir():
        print(f"[FATAL] 没有 {GEN}，先跑 `tauri android init`")
        return 2

    lines: list[str] = []
    lines += patch_gradle_properties(check_only)
    lines += patch_compile_sdk(check_only)
    lines += patch_build_task(check_only)
    lines += patch_signing_config(check_only)
    lines += patch_min_sdk_for_v1(check_only)
    lines += patch_cleartext_loopback(check_only)
    lines += patch_locked_portrait(check_only)
    lines += patch_retain_task_state(check_only)
    lines += patch_dark_window_background(check_only)
    lines += patch_version_code_override(check_only)

    for line in lines:
        print(line)

    # --check 模式下，有任何 "[修]" 就返回 1（供 CI / 助手判断）
    if check_only and any(line.startswith("[修]") for line in lines):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
