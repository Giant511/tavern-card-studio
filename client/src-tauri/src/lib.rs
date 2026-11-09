//! Tauri 壳入口：插件注册 + 命令注册。
//!
//! 注册顺序有讲究：single-instance 必须是**第一个**插件，否则第二次启动时
//! 前一个实例可能已经初始化完并抢到窗口，聚焦会失效（官方文档明确要求）。

mod commands;
mod error;
mod paths;
mod pick_file;
mod proxy;
mod st_api;
mod st_chat;

use tauri::Manager;

/*
 * ★ `mobile_entry_point` 在 Android 上是**必需**的，不是可选装饰。
 *
 * 2026-10-31 首次把 APK 编到最后一环时撞到：
 *
 *   failed to validate library: Library from ...libtcs_shell_lib.so does not
 *   include required runtime symbols. This means you are likely missing the
 *   tauri::mobile_entry_point macro usage
 *
 * 这个宏生成 JNI 侧真正被调用的入口符号（`Java_..._Runnable_1...` 一类）。
 * 没有它，`.so` 能编译、能链接、能被塞进 `jniLibs`，但 **Android 侧一调用就
 * 找不到符号**；而 Tauri CLI 会在打包前主动校验并拦下，所以在我们这条链路上
 * 表现为"Rust 编完了却报缺 symbol"。
 *
 * 为什么之前一直没发现：这条校验在内层 `tauri android android-studio-script`
 * 里，而那一层此前被 `BuildTask.kt` 的 `node tauri ...` 错挡在前面
 * （`Cannot find module '...\tauri'`），根本没跑到这里。
 *
 * `cfg_attr(mobile, ...)` 而不是无条件加：桌面端没有 JNI，加了也不会被调用，
 * 但会引入一份无用的导出符号。用 cfg 让两端各取所需。
 * `mobile` 这个 cfg 由 tauri 的 build script 在 android/ios 目标下设置。
 */
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    /*
     * ★ 这两个插件是**桌面专属**，Android 上必须条件编译掉。
     *
     * 2026-10-30 首次尝试构建 Android 时撞到（这是 T15.3 的一个真实发现）：
     *
     *   error[E0425]: cannot find function `init` in crate `tauri_plugin_single_instance`
     *   error[E0433]: cannot find `Builder` in `tauri_plugin_window_state`
     *
     * 原因不是版本不对，而是这两个 crate 在 Android 目标下**根本不导出这些 API**：
     *
     *   · `single_instance` —— "第二个实例被拦下"这个概念在 Android 上不存在。
     *     Android 的应用是单实例的（同一个 Activity 栈），系统层面就没有
     *     "启动第二个实例"这回事。
     *   · `window_state` —— 记忆"窗口位置与大小"。Android 上没有可拖动的窗口，
     *     也没有那套几何 API。
     *
     * 所以不是"暂时跳过"，而是**在 Android 上它们没有意义**。
     * 桌面端行为一字不变（cfg 只对 android 目标生效）。
     *
     * 这条也解释了为什么 PC 端 `cargo check` 全绿而 Android 目标失败 ——
     * **桌面能编译 ≠ 移动端能编译**，必须真跑一次 Android 构建才知道。
     */
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例被拦下：把已有窗口拉到前台，而不是再开一个
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build());

    builder
        // 日志默认 Info 级；落盘位置由插件决定，壳不自行指定路径
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ProxyState::default())
        .manage(st_chat::StChatState::default())
        .invoke_handler(tauri::generate_handler![
            commands::shell_info,
            commands::read_text_exact,
            commands::read_preset_library,
            commands::write_preset_library,
            commands::read_binary_file,
            // v0.1.7 增补三：取回撞名的 mtime 判据（不返回内容，只要元信息）
            commands::stat_file,
            commands::read_default_face,
            commands::open_folder,
            commands::write_file_atomic,
            commands::write_binary_file_atomic,
            commands::scan_rule_dir,
            commands::read_rule_text,
            commands::default_cards_dir,
            commands::probe_cards_dir,
            commands::scan_cards_dir,
            commands::append_client_error_log,
            // v0.1.5 / F15：本地 SillyTavern 联动（探测 / 启动 / 打开链接）
            commands::probe_paths,
            commands::find_st_candidates,
            commands::probe_tcp,
            commands::extract_zip_to,
            commands::spawn_detached,
            commands::open_external,
            // v0.1.6 / T14.1：本地回环反向代理（面板内嵌 ST）
            commands::st_proxy_start,
            commands::st_proxy_stop,
            commands::st_proxy_status,
            st_chat::st_chat_connect,
            st_chat::st_chat_health,
            st_chat::st_chat_characters,
            st_chat::st_chat_character_delete,
            st_chat::st_chat_worldinfo_list,
            st_chat::st_chat_worldinfo_get,
            st_chat::st_chat_worldinfo_edit,
            st_chat::st_chat_worldinfo_import,
            st_chat::st_chat_worldinfo_delete,
            st_chat::st_chat_character_png,
            st_chat::st_chat_character_write_png,
            st_chat::st_chat_list,
            st_chat::st_chat_load,
            st_chat::st_chat_save,
            st_chat::st_chat_rename,
            st_chat::st_chat_delete,
            st_chat::st_chat_settings_get,
            st_chat::st_chat_settings_save,
            st_chat::st_chat_secret_write,
            /* 问 ST「哪些 secret 真的配了」（2026-11-07） */
            st_chat::st_chat_secret_present,
            st_chat::st_chat_generate,
            st_chat::st_chat_group_create,
            st_chat::st_chat_preset_save,
            st_chat::st_chat_count_tokens,
            pick_file::pick_json_file,
            st_chat::st_chat_abort
        ])
        .build(tauri::generate_context!())
        .expect("启动 Tauri 应用失败：请检查 tauri.conf.json 与 icons")
        .run(|app, event| {
            // 退出时把代理端口收掉（决策 #222）：进程退出本身会关 socket，
            // 但显式收一次才能保证"面板已关/应用已退 ⇒ 端口不再监听"这条判据
            // 在将来加托盘驻留时依然成立。
            if let tauri::RunEvent::Exit = event {
                commands::stop_proxy_blocking(app);
            }
        });
}
