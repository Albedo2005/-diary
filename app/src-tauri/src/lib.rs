//! 应用入口。
//!
//! 架构边界（这是本项目最重要的一条设计）：
//!
//! ```text
//!   Vue 组件
//!      ↓  调用 src/api/ 里的类型安全封装
//!   Tauri command（本 crate 的 commands.rs）
//!      ↓  业务逻辑
//!   db.rs（rusqlite + SQLCipher）
//! ```
//!
//! 前端**永远不接触数据库**，也**永远拿不到密钥**。密钥由用户 PIN 经 Argon2id
//! 派生后只存在于已解锁的 rusqlite 连接里，随连接对象一起释放。
//!
//! 因此没有引入 `tauri-plugin-sql`：它的模型是把 SQL 字符串从前后端传递，
//! 与"密钥必须留在 Rust 侧"直接冲突，且它不支持 SQLCipher。

// 模块可见性：crypto / db / error / schema / seg 设为 pub，
// 让 tests/ 下的集成测试能直接驱动数据层。
// 这不扩大前端攻击面 —— 前端只能通过 commands.rs 里注册的 Tauri command
// 访问后端，Rust 侧的 pub 与前端可见性无关。
pub mod commands;
pub mod crypto;
pub mod db;
pub mod error;
pub mod schema;
pub mod seg;

// `Manager` trait 必须显式引入：`App` 上的 `manage()` / `state()` 等方法是
// 由这个 trait 提供的，不在作用域内会报 "no method named `manage`"。
use tauri::Manager;

use commands::VaultState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 数据目录在启动时解析一次。数据库、加密元信息、锁定状态、附件都放这里。
    // 用系统标准的应用数据目录而不是程序目录：安装到 Program Files 后
    // 程序目录通常不可写。
    let data_dir = match commands::resolve_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            // 无法确定数据目录属于致命错误：继续跑只会在后面随机失败，
            // 不如立即退出并给出明确原因。
            eprintln!("致命错误：无法确定应用数据目录：{e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("致命错误：无法创建数据目录 {}：{e}", data_dir.display());
        std::process::exit(1);
    }

    tauri::Builder::default()
        .setup(move |app| {
            // VaultState 需要被两处共享：
            //   1. Tauri 的状态管理（前端调用 command 时使用）
            //   2. 后台自动备份线程
            //
            // ⚠️ 必须注册 `VaultState` 本身，不能注册 `Arc<VaultState>`。
            //    命令签名声明的是 `State<'_, VaultState>`，Tauri 按**具体类型**
            //    查找状态；注册 Arc 会运行时报
            //    "state not managed for field `state` on command ..."
            //    （这个错误在本项目真实发生过）。
            //
            //    共享问题由 VaultState 内部持有的 Arc 解决：
            //    `clone()` 只是 Arc 计数 +1，两份共享同一份数据。
            let state = VaultState::new(data_dir.clone());
            app.manage(state.clone());
            // 后台线程持有另一个克隆，与命令层看到的是同一份解锁状态。
            commands::spawn_auto_backup(state);

            // 窗口形态必须在"窗口出现"**之前**定下来，所以它存在**库外**
            // 明文文件（ui_prefs.json）里，不放加密库 —— 放加密库会变成
            // "每次启动先出小窗口、解锁后才撑开"，每次都跳一下。
            //
            // 把"读文件 + 应用"包进闭包并**忽略其错误**，然后无条件 show()：
            // 下面 tauri.conf.json 里设了 "visible": false（为启动零跳动），
            // 一旦在中途 return Err 或 panic，窗口就永远不出现 ——
            // 用户会得到"点了没反应"的隐形应用，只能去任务管理器杀。
            if let Some(window) = app.get_webview_window("main") {
                let apply = |w: &tauri::WebviewWindow| -> crate::error::AppResult<()> {
                    let mode = commands::load_window_mode(&data_dir);
                    commands::apply_window_mode_at_startup(w, &mode)
                };
                if let Err(e) = apply(&window) {
                    eprintln!("应用窗口形态失败（不影响启动）：{e}");
                }

                // ⚠️ 硬要求：无论上面读到什么、成功还是失败，窗口必须显示出来。
                if let Err(e) = window.show() {
                    eprintln!("显示主窗口失败：{e}");
                }
            } else {
                // 理论上不会走到：窗口 label 未显式设置，Tauri 默认就是 "main"。
                // 但配上 "visible": false 之后，任何一条漏掉 show 的路径都会
                // 变成"隐形应用"，所以宁可把全部窗口兜一遍。
                for (label, w) in app.webview_windows() {
                    eprintln!("未找到 main 窗口，兜底显示 {label}");
                    let _ = w.show();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 状态
            commands::app_status,
            commands::estimate_kdf_ms,
            // 初始化 / 解锁 / 锁定
            commands::initialize_vault,
            commands::unlock_vault,
            commands::lock_vault,
            // 日记读写
            // 注意：这里注册的是 open_entry（纯读取、不写库），
            // 而不是早期版本的 get_or_create_entry。后者会让"点开日历"
            // 被算成"写过日记"，详见 db.rs 里 has_content_sql() 的说明。
            commands::open_entry,
            commands::is_date_written,
            commands::save_entry,
            commands::set_entry_locked,
            commands::lock_all_entries,
            commands::delete_entry,
            commands::list_month,
            commands::written_dates,
            // 日历上的心情标记（第三种标记：只在有心情的日子显示）
            commands::written_moods,
            commands::stats,
            // 搜索
            commands::search_entries,
            // 维护与备份
            commands::backup_now,
            commands::backup_status,
            commands::set_auto_backup,
            commands::list_backups,
            commands::integrity_check,
            commands::rebuild_indexes,
            commands::crypto_info,
            // 应用设置
            // 读是"通用读"（一个结构体带所有项，以后加字段不用加命令），
            // 写是"专用写"（每项一条，因为写入要校验、要有明确语义）。
            commands::get_settings,
            commands::set_auto_lock_secs,
            // 窗口形态：存**库外明文文件** ui_prefs.json，
            // 未解锁也能读改（理由见 commands.rs 里 get_window_mode 的说明）。
            commands::get_window_mode,
            commands::set_window_mode,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
