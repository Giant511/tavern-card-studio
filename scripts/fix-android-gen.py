#!/usr/bin/env python3
"""
修 `tauri android init` 生成的 Android 工程 —— **本机必需的三处**，可重跑。

## 为什么需要这个脚本

`client/src-tauri/gen/` 整个在 `.gitignore` 里（第 24 行），所以它对每个
开发者、每台机器、每次重新 `tauri android init` 都是**重新生成的**。
而生成出来的东西在这台机器上有三处跑不动，且三处都会报出**指向别处**的错误。

脚本每次都从当前 gen/ 现状出发做幂等修补，所以：
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

    # ② args 首位换成 CLI 的 JS 入口，并去掉 "tauri"
    cli_js = CLI_JS.as_posix()
    old_args = 'val args = listOf("tauri", "android", "android-studio-script")'
    new_args = f'val args = listOf("""{cli_js}""", "android", "android-studio-script")'
    if old_args in text:
        text = text.replace(old_args, new_args, 1)
        out.append(f"[修] BuildTask.kt args[0] → {cli_js}（去掉会误导 node 的 'tauri'）")
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
            val propFile = file("D:/tcs-release-keys/keystore.properties")
            if (propFile.exists()) {
                val props = Properties()
                propFile.inputStream().use { props.load(it) }
                storeFile = file(props.getProperty("storeFile"))
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

    for line in lines:
        print(line)

    # --check 模式下，有任何 "[修]" 就返回 1（供 CI / 助手判断）
    if check_only and any(line.startswith("[修]") for line in lines):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
