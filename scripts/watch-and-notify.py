"""
构建结果监视器：一旦出结论就推送微信 + 邮件，人不用守着。

## 为什么需要它

`tauri android build` 的实际耗时里，**下载占了绝大部分**：
Gradle 发行包、AGP/Kotlin 依赖、SDK Platform 36、Build-Tools 36，
一层套一层。每层都会让日志停住十几分钟，看起来像卡死，
实际是网速 —— 而人盯着一个 40 分钟没动静的终端没有意义。

所以这里轮询日志与产物，**出结论才推送**：
  · 出现 `*.apk` → 推"成功"+ 路径 + 体积；
  · 出现 `BUILD FAILED` / `FAILURE` → 推失败原因摘要；
  · 超时仍无结论 → 推"还在下载，没结论"。

## 用法

    python watch-and-notify.py --log /tmp/g1.log --apk-root /d/tcs-gradle --timeout 2400

推送失败不影响退出码 —— 提醒是辅助，不该因为推送不通就丢掉结论。
"""

import argparse
import glob
import os
import pathlib
import subprocess
import sys
import time

WX_SCRIPT_DIR = r"C:\Users\PC\.workbuddy\skills\workbuddy-claw-wechat-send\scripts"
MAIL_SCRIPT = r"C:\Users\PC\.workbuddy\skills\mail-push\scripts\send.py"
PYTHON = r"C:\Users\PC\.workbuddy\binaries\python\versions\3.13.12\python.exe"


def push_wechat(message: str) -> str:
    """发微信。返回结果描述（不抛异常）。"""
    try:
        sys.path.insert(0, WX_SCRIPT_DIR)
        from send_wx import send  # type: ignore

        result = send(message)
        # 成功判据是响应里有 message_id（不是 HTTP 200）
        return f"微信 OK {result}" if "message_id" in str(result) else f"微信 未知响应 {result}"
    except Exception as error:  # noqa: BLE001
        return f"微信 失败：{error}"


def push_mail(title: str, body: str) -> str:
    try:
        subprocess.run(
            [PYTHON, MAIL_SCRIPT, "--title", title, "--content", body],
            check=True,
            capture_output=True,
            timeout=120,
        )
        return "邮件 OK"
    except Exception as error:  # noqa: BLE001
        return f"邮件 失败：{error}"


def tail_text(path: pathlib.Path, limit: int = 3000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except Exception:  # noqa: BLE001
        return ""


def find_apk(root: str) -> str | None:
    hits = glob.glob(os.path.join(root, "**", "*.apk"), recursive=True)
    return hits[0] if hits else None


def classify(log: pathlib.Path) -> tuple[str, str]:
    """
    返回 (结论, 详情)。

    结论只有三种：`apk` / `failed` / `pending`。
    注意判据取**日志末尾**：日志里可能同时出现过早期失败与后来的重试，
    只看 `in` 会把已经过去的失败当成结论。
    """
    text = tail_text(log, 8000)

    if "BUILD SUCCESSFUL" in text:
        return "apk", "构建成功"
    if "BUILD FAILED" in text:
        # 抽 What went wrong 之后那几行，比整份日志有用得多
        marker = text.find("What went wrong")
        detail = text[marker : marker + 700] if marker >= 0 else text[-700:]
        return "failed", detail.strip()
    if "FAILURE:" in text and "BUILD FAILED" not in text:
        return "failed", text[-700:].strip()
    return "pending", ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--log", required=True, help="构建日志路径")
    ap.add_argument("--apk-root", required=True, help="在哪找 *.apk")
    ap.add_argument("--timeout", type=int, default=2400, help="最长监视秒数")
    ap.add_argument("--interval", type=int, default=30, help="轮询间隔秒数")
    args = ap.parse_args()

    log = pathlib.Path(args.log)
    started = time.time()
    last_note = 0

    while True:
        apk = find_apk(args.apk_root)
        verdict, detail = classify(log)

        # 有 APK 就算成功（日志可能因为缓冲还没刷出 BUILD SUCCESSFUL）
        if apk is not None:
            size_mb = os.path.getsize(apk) / 1048576
            title = "APK 构建成功"
            body = (
                f"路径：{apk}\n"
                f"体积：{size_mb:.1f} MB\n\n"
                "下一步（W^X 生死项，尚未验证）：\n"
                "1. adb install -r 这个 APK\n"
                "2. 起 App，确认 libnode.so 能 exec（不是只安装成功）\n"
                "3. 看 nativeLibraryDir 里有没有 libnode.so、可执行位在不在"
            )
            print(f"[结论] 成功 → {apk}")
            print(push_wechat(f"【APK 出来了】{size_mb:.1f} MB\n{apk}\n\n下一步验 W^X：装到手机上确认 libnode.so 能执行"))
            print(push_mail(title, body))
            return 0

        if verdict == "failed":
            title = "APK 构建失败"
            body = f"日志：{args.log}\n\n{detail}"
            print("[结论] 失败")
            print(push_wechat(f"【APK 构建失败】\n{detail[:600]}"))
            print(push_mail(title, body))
            return 1

        elapsed = time.time() - started
        if elapsed >= args.timeout:
            print("[结论] 超时无结论")
            print(
                push_wechat(
                    f"【构建仍在下载，没有结论】已等 {int(elapsed / 60)} 分钟。\n"
                    f"日志停在：{tail_text(log, 200).strip().splitlines()[-1] if tail_text(log, 200).strip() else '(空)'}"
                )
            )
            return 2

        # 每 5 分钟回一次心跳到 stdout（不推送，免得刷屏）
        if elapsed - last_note >= 300:
            last_note = elapsed
            print(f"[等] 已 {int(elapsed / 60)} 分钟，状态 pending")
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
