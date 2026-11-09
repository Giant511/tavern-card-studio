"""
把 Tauri 的 Android Gradle 工程镜像到 ASCII 路径（一次性实验，可重跑）。

## 为什么要做这件事

`tauri android build` 报：

```text
An exception occurred applying plugin request [id: 'com.android.application']
> Failed to apply plugin 'com.android.internal.application'.
   > Your project path contains non-ASCII characters. This will most likely
     cause the build to fail on Windows. Please move your project to a
     different directory. See http://b.android.com/95744
```

**AGP 主动拒绝含非 ASCII 字符的项目路径**，没有配置开关可以绕过。

而仓库在 `D:\\Claw\\代码开发\\tavern-card-studio` —— 「代码开发」是中文。
仓库 13G，不适合整体搬；但 Android Gradle 工程只有 99M。

## 思路

只把 **Gradle 工程**镜像到 `D:/tcs-gradle`，源码继续留在中文路径：

- `app/jniLibs` 里的 libnode.so 复制过去（97M，本地盘复制约 1 秒）；
- `rootDirRel` 从 `../../../` 改成指向真实 `client` 的**相对路径**。
  `BuildTask.kt` 用它作为 cargo 的 `workingDir`，而 **cargo/rustc 自己能处理
  中文路径**（前面已验证），所以这里含中文没关系 ——
  AGP 只检查"Gradle 工程目录"本身。

## 为什么用脚本而不是手改

`tauri android init` 会覆盖 `app/build.gradle.kts`，手改会被冲掉。
脚本每次都从源工程重新镜像，保证可重跑、不漂移。
"""

import pathlib
import shutil
import sys

SRC = pathlib.Path(r"D:\Claw\代码开发\tavern-card-studio\client\src-tauri\gen\android")
DST = pathlib.Path(r"D:\tcs-gradle")
CLIENT = pathlib.Path(r"D:\Claw\代码开发\tavern-card-studio\client")


def main() -> int:
    if not SRC.is_dir():
        print(f"[FATAL] 源工程不存在：{SRC}")
        return 2

    # 清空目标（只删我们自己建的镜像目录，不碰仓库）
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    # 复制（跳过 build 产物目录，那里面是上次的中间结果，没必要带）
    for item in SRC.iterdir():
        target = DST / item.name
        if item.is_dir():
            shutil.copytree(item, target, ignore=shutil.ignore_patterns("build", ".gradle"))
        else:
            shutil.copy2(item, target)
    print(f"[OK] 镜像完成 → {DST}")

    # ── 改 rootDirRel：从 app 目录到真实 client 的相对路径 ──
    app_gradle = DST / "app" / "build.gradle.kts"
    text = app_gradle.read_text(encoding="utf-8")

    # 计算相对路径：D:/tcs-gradle/app → D:/Claw/代码开发/tavern-card-studio/client
    rel = _relpath(CLIENT, DST / "app")
    old = 'rootDirRel = "../../../"'
    new = f'rootDirRel = "{rel}"'
    if old not in text:
        print(f"[WARN] 找不到 {old}，当前 rootDirRel 行：")
        for line in text.splitlines():
            if "rootDirRel" in line:
                print("       " + line.strip())
    else:
        app_gradle.write_text(text.replace(old, new, 1), encoding="utf-8")
        print(f"[OK] rootDirRel → {rel}")

    # ── compileSdk / targetSdk 对齐到 36 ──
    #
    # 2026-10-30 的教训：我先降到 34（因为本机只装了 android-34），
    # 结果 `checkArm64DebugAarMetadata` 报 6 条：
    #   Dependency ':tauri-plugin-dialog' requires ... compile against version 36 or later
    #
    # 也就是说 **Tauri 的插件自己要求 compileSdk >= 36**，把它降到 34 是错的。
    # 正确的做法是让 SDK 下载 36（Gradle 会自动装），而不是迁就本机已有的版本。
    text = app_gradle.read_text(encoding="utf-8")
    before = text
    text = text.replace("compileSdk = 37", "compileSdk = 36")
    text = text.replace("targetSdk = 37", "targetSdk = 36")
    text = text.replace("compileSdk = 34", "compileSdk = 36")
    text = text.replace("targetSdk = 34", "targetSdk = 36")
    if text != before:
        app_gradle.write_text(text, encoding="utf-8")
        print("[OK] compileSdk/targetSdk → 36（Tauri 插件要求 >= 36，不是迁就本机 34）")
    else:
        print("[INFO] SDK 版本已是 36")

    # ── 修 BuildTask：把「node 起 tauri」这条调用改成能真正跑起来的形态 ──
    #
    # `tauri android init` 生成的 BuildTask.kt 长这样：
    #
    #     val executable = """C:\...\node"""        ← 本机的 node 可执行文件
    #     val args = listOf("tauri", "android", "android-studio-script")
    #
    # 它默认 executable 应该是**原生 tauri 二进制**（那时多出来的 "tauri"
    # 被当成 argv[0] 一样忽略掉）。但这台机器上没有原生二进制，只有
    # `node_modules/@tauri-apps/cli`，于是生成的 executable 是 node。
    #
    # 后果是 `node tauri android android-studio-script` —— node 把 "tauri"
    # 当成**要加载的模块**，报：
    #
    #     Error: Cannot find module 'D:\Claw\´úÂë¿ª·¢\...\client\tauri'
    #
    # 注意那个乱码：node 打印时按 GBK 编了中文路径，所以报错里根本看不出
    # 真实路径是什么 —— 很容易被误判成"中文路径又炸了"。其实与中文无关。
    #
    # 实测两种写法的差别（`--help` 一次就能看出来，不用等整轮构建）：
    #   带 "tauri"  → error: unrecognized subcommand 'tauri'
    #   不带        → 正常打印 android android-studio-script 的选项
    #
    # 所以：executable 用 node，args 前面插入 CLI 的 JS 入口，并去掉 "tauri"。
    build_task = (
        DST
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
    if build_task.is_file():
        kt = build_task.read_text(encoding="utf-8")
        cli_js = (CLIENT.parent / "node_modules" / "@tauri-apps" / "cli" / "tauri.js").as_posix()
        node_exe = _find_node()

        # ① executable：把生成时写死的 node 路径换成当前这份（可能不存在的）路径
        import re as _re

        kt2 = _re.sub(
            r'val executable = """[^"]*"""',
            f'val executable = """{node_exe}"""',
            kt,
            count=1,
        )
        # ② args：插入 CLI JS，并去掉那个会把 node 带偏的 "tauri"
        kt2 = kt2.replace(
            'val args = listOf("tauri", "android", "android-studio-script")',
            f'val args = listOf("""{cli_js}""", "android", "android-studio-script")',
            1,
        )
        if kt2 != kt:
            build_task.write_text(kt2, encoding="utf-8")
            print(f"[OK] BuildTask：node={node_exe}")
            print(f"     args[0]={cli_js}（已去掉会误导 node 的 'tauri'）")
        else:
            print("[WARN] BuildTask 未改动 —— 生成格式可能变了，请人工核对")

    # ── 报告关键事实 ──
    jni = DST / "app" / "jniLibs" / "arm64-v8a"
    if jni.is_dir():
        for f in sorted(jni.iterdir()):
            print(f"[OK] jniLibs: {f.name} = {f.stat().st_size:,} 字节")
    else:
        print(f"[WARN] jniLibs 缺失：{jni}")

    return 0


def _find_node() -> str:
    """
    找当前能用的 node 可执行文件。

    为什么不用 `shutil.which("node")`：在这个仓库里它很可能返回
    `C:/Users/PC/.workbuddy/binaries/node/versions/22.22.2-3/node.bat` 之类，
    而 Gradle 里那个 `exec` 需要的是**真正的 exe**（`.bat` 会被 shell 解释，
    且此前的失败就是 `A problem occurred starting process 'node.bat'`）。

    优先级：环境变量 TCS_NODE → 默认 managed node.exe → PATH 上的 node。
    """
    import os
    import shutil

    candidates = []
    env = os.environ.get("TCS_NODE")
    if env:
        candidates.append(env)
    candidates.append(r"C:\Users\PC\.workbuddy\binaries\node\versions\22.22.2-3\node.exe")
    # D:/tcs-bin/node.exe：为了绕开 node.bat 而复制的一份
    candidates.append(r"D:\tcs-bin\node.exe")

    for one in candidates:
        if pathlib.Path(one).is_file():
            return one.replace("\\", "/")

    found = shutil.which("node")
    if found and found.lower().endswith(".exe"):
        return found.replace("\\", "/")

    print("[WARN] 找不到 node.exe，BuildTask 里的值可能不可用")
    return "node"


def _relpath(target: pathlib.Path, start: pathlib.Path) -> str:
    """算相对路径，用正斜杠（Gradle 在 Windows 上也认）。"""
    import os

    rel = os.path.relpath(target, start)
    return rel.replace("\\", "/")


if __name__ == "__main__":
    sys.exit(main())
