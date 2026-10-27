//! Tauri 壳入口：插件注册 + 命令注册。
//!
//! 注册顺序有讲究：single-instance 必须是**第一个**插件，否则第二次启动时
//! 前一个实例可能已经初始化完并抢到窗口，聚焦会失效（官方文档明确要求）。

mod commands;
mod error;
mod paths;

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
        .invoke_handler(tauri::generate_handler![
            commands::shell_info,
            commands::read_text_exact,
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
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败：请检查 tauri.conf.json 与 icons");
}
