// release 构建不弹控制台窗口；debug 保留，方便看 panic 与日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tcs_shell_lib::run()
}
