package studio.taverncard.probe;

import android.app.Activity;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * T15.3 生死项：验证 libnode.so 能不能被 exec。
 *
 * 全部逻辑就是"点一下按钮 → 跑 --version → 把输出打到屏上"。
 * 刻意用纯 Android SDK（不引 AndroidX / Compose）：判定包越简单，
 * 失败时越能确定问题在 W^X 而不是在框架。
 *
 * 判据落在**真实 stdout**上，不是"进程退出码 0"：
 * 退出码 0 可能只是 shell 包装成功，而真正要确认的是 node 自己跑起来了。
 */
public final class MainActivity extends Activity {

    private TextView output;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, pad);

        Button run = new Button(this);
        run.setText("跑 libnode.so --version");
        root.addView(run);

        output = new TextView(this);
        output.setTypeface(Typeface.MONOSPACE);
        output.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        output.setTextIsSelectable(true);
        output.setGravity(Gravity.START);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(output, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        reportEnvironment();
        run.setOnClickListener(v -> runProbe());
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void append(String line) {
        output.append(line);
        output.append("\n");
    }

    /**
     * 先把"东西在哪"打出来。
     *
     * 这三行是失败时最值钱的信息：
     *   · nativeLibraryDir —— 我们打算 exec 的目录；
     *   · filesDir —— **不能** exec 的目录（W^X 限制的对象），用来对照；
     *   · targetSdk —— 低了会进兼容模式，W^X 被放宽，"能跑"就是假绿。
     */
    private void reportEnvironment() {
        append("包名: " + getPackageName());
        append("nativeLibraryDir: " + getApplicationInfo().nativeLibraryDir);
        append("filesDir(可写，不能 exec): " + getFilesDir().getAbsolutePath());
        append("targetSdk: " + getApplicationInfo().targetSdkVersion);
        append("ABI: " + android.os.Build.SUPPORTED_ABIS[0]);
        File node = nodeBinary();
        append("libnode.so 存在: " + node.exists()
                + (node.exists() ? "（" + node.length() + " 字节, 可执行=" + node.canExecute() + "）" : ""));

        /*
         * 把 nativeLibraryDir 的**实际内容**列出来。
         *
         * 为什么必须列：`libnode.so` 的 DT_NEEDED 里有 `libc++_shared.so`，
         * 而 Android 的动态链接器**不会**在"要 exec 的那个文件的邻居目录"里
         * 自动找依赖 —— 它只按 DT_RUNPATH / LD_LIBRARY_PATH / 系统库路径找。
         *
         * 所以"我把 .so 也放进 jniLibs 了"不等于"链接器能找到它"。
         * 这一行是判断"到底是库没落地，还是落地了但找不到"的唯一依据。
         */
        File dir = new File(getApplicationInfo().nativeLibraryDir);
        File[] libs = dir.listFiles();
        append("nativeLibraryDir 内容（" + (libs == null ? 0 : libs.length) + " 个）:");
        if (libs != null) {
            for (File f : libs) {
                append("  " + f.getName() + "  " + f.length() + " B  x=" + f.canExecute());
            }
        }
        append("——");
    }

    private File nodeBinary() {
        return new File(getApplicationInfo().nativeLibraryDir, "libnode.so");
    }

    /**
     * 在后台线程 exec，主线程只负责显示。
     *
     * 不能在主线程跑：起进程 + 等输出是阻塞的，ANR 会让现象看起来像"卡死"，
     * 而实际可能是成功但输出没读完。
     */
    private void runProbe() {
        output.setText("");
        append("== 开始 ==");
        File node = nodeBinary();
        if (!node.exists()) {
            append("✘ nativeLibraryDir 里没有 libnode.so");
            append("  说明 extractNativeLibs 没生效或 .so 没打进 APK 的 lib/arm64-v8a/。");
            return;
        }
        if (!node.canExecute()) {
            append("✘ 文件存在但没有执行权限 —— 系统解包时没带 x 位？");
            return;
        }

        Handler main = new Handler(Looper.getMainLooper());
        AtomicReference<String> verdict = new AtomicReference<>("(未完成)");

        Thread worker = new Thread(() -> {
            StringBuilder log = new StringBuilder();
            try {
                /*
                 * 带 LD_LIBRARY_PATH 启动。
                 *
                 * 这是第二个必须验的点：**系统允许 exec,不代表能找到依赖**。
                 * libnode.so 的 DT_RUNPATH 里没有 nativeLibraryDir（编的时候不知道
                 * 会被装到哪），所以链接器只会去系统库路径找 libc++_shared.so ——
                 * 而它不在那儿（Android 不带 libc++_shared）。
                 *
                 * 所以必须显式把 nativeLibraryDir 塞进 LD_LIBRARY_PATH。
                 * 这一条如果不成立，T15.3 的整个 W^X 方案就得换（改为静态链接 libc++）。
                 */
                ProcessBuilder builder = new ProcessBuilder(node.getAbsolutePath(), "--version");
                builder.redirectErrorStream(true);
                builder.environment().put("LD_LIBRARY_PATH", getApplicationInfo().nativeLibraryDir);
                Process process = builder.start();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                        process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        log.append("  stdout| ").append(line).append('\n');
                    }
                }
                boolean finished = process.waitFor(20, TimeUnit.SECONDS);
                if (!finished) {
                    process.destroyForcibly();
                    log.append("  ✘ 20 秒内没退出（卡住了）\n");
                } else {
                    log.append("  exit=").append(process.exitValue()).append('\n');
                }
                verdict.set(log.toString());
            } catch (Exception error) {
                // 失败原因必须是**异常类型 + 消息**：EACCES（W^X 拒绝）与
                // ENOENT（路径不存在）对下一步动作完全不同。
                log.append("  ✘ ").append(error.getClass().getSimpleName())
                        .append(": ").append(error.getMessage()).append('\n');
                verdict.set(log.toString());
            }
            main.post(() -> {
                append(verdict.get());
                append("== 结束 ==");
            });
        }, "node-probe");
        worker.start();
    }
}
