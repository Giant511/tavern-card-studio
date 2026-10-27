//! Tauri 壳入口：插件注册 + 命令注册。
//!
//! 注册顺序有讲究：single-instance 必须是**第一个**插件，否则第二次启动时
//! 前一个实例可能已经初始化完并抢到窗口，聚焦会失效（官方文档明确要求）。

mod commands;
mod error;
mod paths;
mod proxy;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二个实例被拦下：把已有窗口拉到前台，而不是再开一个
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // 日志默认 Info 级；落盘位置由插件决定，壳不自行指定路径
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::ProxyState::default())
        .invoke_handler(tauri::generate_handler![
            commands::shell_info,
            commands::read_text_exact,
            commands::read_preset_library,
            commands::write_preset_library,
            commands::read_binary_file,
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
