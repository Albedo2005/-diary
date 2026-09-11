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
        .manage(VaultState::new(data_dir))
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
            commands::delete_entry,
            commands::list_month,
            commands::written_dates,
            commands::stats,
            // 搜索
            commands::search_entries,
            // 维护
            commands::backup_now,
            commands::list_backups,
            commands::integrity_check,
            commands::rebuild_indexes,
            commands::crypto_info,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
