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
// `Emitter` trait 同理 —— `emit()` 是它提供的方法（托盘菜单里那条"退出"
// 要先请前端落库，就是用它往后端→前端发事件）。
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

use crate::error::AppError;
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
        // 打开目录（导出完成后那个「打开文件夹」用的）。
        //
        // ⚠️ 这个依赖一直在 `Cargo.toml` 里，但**从来没有注册过**，
        //    于是 `capabilities/default.json` 里的 `opener:default` 一直是
        //    一纸空文（权限声明了却没有对应插件）。这里把它补上 ——
        //    补的是"声明与实现对不上"这个既有缺口，不是新增能力。
        //
        //    `opener:default` 只放行两件事：用默认程序打开 http/https/mailto/tel
        //    这类 URL、以及在文件管理器里定位一个条目；**不含**"打开任意本地路径"。
        .plugin(tauri_plugin_opener::init())
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
            // 顺手把附件目录建好（`<数据目录>/attachments/`）。
            //
            // 为什么在启动时做：设置页要显示「图片缓存位置」并给一个"打开文件夹"
            // 的按钮，而这个目录在用户还没插过任何图片时并不存在 —— 那时点开
            // 会报"目录不存在"，太别扭。建一个空目录没有代价。
            // 失败也不吭声（只读介质之类）：真要用附件时会再建一次，
            // 那次的错误才该报给用户。
            let _ = std::fs::create_dir_all(data_dir.join("attachments"));

            let state = VaultState::new(data_dir);
            app.manage(state.clone());
            // 后台线程持有另一个克隆，与命令层看到的是同一份解锁状态。
            commands::spawn_auto_backup(state);
            // 托盘（【P2-21】）。⚠️ 建在 `manage` **之后** ——
            // 它要把"托盘建起来了"记回 `VaultState`，那份状态得先注册好。
            // ⚠️ 它**没有返回值**：托盘建不起来也不该让软件起不来（见函数说明）。
            setup_tray(app.handle());
            // ⭐ 窗口到底显不显示的责任**全落在这一句上**（理由见
            //    `show_window_unless_silent`）——
            //    `tauri.conf.json` 里窗口是 `"visible": false`，
            //    ⚠️ 必须排在 `setup_tray` **之后**：它要问"托盘建起来了没有"。
            show_window_unless_silent(app.handle());
            Ok(())
        })
        // ⭐ 关窗口时到底"藏进托盘"还是"真退出"，由设置决定（【P2-21】）。
        .on_window_event(|window, event| {
            // ⚠️ **只拦 `CloseRequested`**：它带着 `api`，能 `prevent_close()`。
            //    ⛔ 别去拦 `Destroyed` —— 那个事件来的时候窗口已经在销毁了，
            //    它**没有** `api` 字段，`prevent_close()` 对它无效（拦了也白拦）。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 关掉之后干什么由我们说了算，所以先拦下来。
                api.prevent_close();

                let app = window.app_handle();
                let state = app.state::<VaultState>();

                // ⚠️ 读设置失败（未解锁 / 库坏了 / 被外部工具写坏）一律当
                //    "直接退出"：**宁可关得掉，也绝不能出现"点了 ✕ 什么都没发生"**。
                //    这层兜底收在 `commands::close_action_now()` 里，
                //    连同"托盘不可用 ⇒ 一律直接退出"一起判（那是唯一的判定点）。
                if commands::close_action_now(&state) == crate::db::CloseAction::Tray {
                    // 藏起来：**进程还活着**、库连接还开着、密钥**还留在内存里**。
                    // ⚠️ 这是**刻意**的 —— 提醒要靠它才响得了。
                    //    真正把密钥从内存里清掉的是「锁定」，不是关窗口。
                    //    （这句话也必须如实写在设置页那一行的说明里。）
                    let _ = window.hide();
                } else {
                    // 让前端先落库再真退（编辑器是 1 秒防抖，见 `request_quit`）。
                    request_quit(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 状态
            commands::app_status,
            commands::estimate_kdf_ms,
            // 初始化 / 解锁 / 锁定 / 改密码
            commands::initialize_vault,
            commands::unlock_vault,
            commands::lock_vault,
            commands::change_password,
            // 免密打开（钥匙明文存在库外的 data/auto_login.json）
            commands::unlock_with_auto_key,
            commands::enable_auto_login,
            commands::disable_auto_login,
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
            // 「回顾」：之最 ＋ 所有写过的日子（P2-23）。
            // 与 stats 分开：这条只在前端点开「旧影」时才算，不是开机白算。
            commands::recap,
            // 搜索
            commands::search_entries,
            // 标签
            // 读是"列全部 + 查某天"，写是"整组覆盖"（不是逐条增删）——
            // 逐条增删会多出"插一个已存在的"这种中间态，语义反而更绕。
            commands::list_tags,
            commands::tags_of_entry,
            commands::set_entry_tags,
            commands::rename_tag,
            commands::retire_tag,
            // 筛选（P2-7）：按标签 / 心情 / 时间捞日记。**纯读**。
            // ⚠️ 登记在这里是照指令的位置；它同时吃标签与心情两组条件，
            //    所以既不属于"搜索"也不属于"标签"，单独一条。
            commands::filter_entries,
            // 维护与备份
            commands::backup_now,
            commands::backup_status,
            commands::set_auto_backup,
            commands::list_backups,
            // 备份恢复（P2-5）—— 全项目唯一会覆盖整库的操作。
            // 三条都不走 with_vault（理由见 commands.rs 里那张例外清单）：
            //   inspect_backup   纯只读，未解锁时也必须能给信息
            //   restore_backup   自己操作那把锁，中途还要把连接置成 None
            //   copy_backups_to  搬的是密文文件，与库里的内容无关
            commands::inspect_backup,
            commands::restore_backup,
            commands::copy_backups_to,
            commands::integrity_check,
            commands::rebuild_indexes,
            commands::crypto_info,
            // Markdown 导出（P1 #11）—— 目的：**别把用户的日记锁死在这个软件里**。
            // 导出全部 / 导出单篇文本 / 在文件管理器里打开导出目录。
            commands::export_markdown,
            commands::export_entry_markdown,
            commands::reveal_dir,
            // 图片附件（P1 #10）
            // 附件是**明文**文件、放在库外的 <数据目录>/attachments/，但"有哪几张
            // 图、哪一天有几张"本身也是隐私，所以这五条一律走 with_vault
            //（未解锁时统一拒绝）。⚠️ save_attachment 的图片字节走的是 IPC 原始
            // 通道，其余参数在请求头里 —— 详见 commands.rs 里那条的说明。
            commands::save_attachment,
            commands::list_attachments,
            commands::read_attachment,
            commands::delete_attachment,
            commands::prune_orphan_attachments,
            // 应用设置
            // 读是"通用读"（一个结构体带所有项，以后加字段不用加命令），
            // 写是"专用写"（每项一条，因为写入要校验、要有明确语义）。
            commands::get_settings,
            commands::set_auto_lock_secs,
            commands::set_auto_lock_entries,
            commands::set_triple_click_unlock,
            // 关闭行为与托盘（【P2-21】）。
            // `get_close_action` 返回的是**生效值**（已经叠上"托盘可不可用"），
            // 所以设置页读到什么、点 ✕ 就真的做什么 —— 不会出现两处说法不一致。
            // `quit_app` 是"前端已经落完库，现在真的退"那一下。
            commands::get_close_action,
            commands::set_close_action,
            commands::quit_app,
            // 写作提醒与开机自启（【P2-13】）。
            // ⚠️ 提醒的**判断全在前端**（只有前端知道本地日期）：
            //    这几条只负责"存设置"＋"把窗口叫出来"＋"把自启项写对"。
            commands::set_reminder_enabled,
            commands::set_reminder_time,
            commands::set_reminder_mode,
            commands::set_reminder_last_fired,
            commands::present_reminder,
            commands::set_auto_start,
            commands::sync_auto_start,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

// ---------------------------------------------------------------------------
// 系统托盘与关闭行为（【P2-21】）
// ---------------------------------------------------------------------------

/// 把主窗口叫回来：显示 → 取消最小化 → 聚焦。
///
/// 三句都要做，缺一个都会留下别扭状态：
///   - 只 `show()` 不 `unminimize()` ⇒ 窗口出来了但还最小化着，点了像没反应；
///   - 不 `set_focus()` ⇒ 窗口在别的窗口后面，用户以为没打开。
///
/// 拿不到 `"main"` 窗口就什么都不做（`tauri.conf.json` 里窗口没写 `label`，
/// Tauri 2 的默认 label 就是 `"main"`，与 capabilities 里的 `["main"]` 一致）。
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 请求"真的退出"：先请前端把没落库的正文写完，再退。
///
/// ⚠️ **不能在这里直接 `app.exit(0)`**：正文是 **1 秒防抖保存**的，
///    点 `✕` 那一瞬间最后打的那些字**可能还没落库**，直接退会把它们丢掉。
///    所以这里只发一条事件，真退由前端在 `flushNow()` 之后调 `quit_app` 完成。
///
/// ⭐ **顺序是这一段的要害：先把兜底武装起来，再去请前端。**
///    `emit` 会在某些状态下**一直等渲染进程**（实测：窗口被隐藏过、
///    或前端主线程正忙时），那一句就可能卡住当前线程 ——
///    兜底要是写在它后面，就永远轮不到执行，结果就是**"点了 ✕ 关不掉"**。
///
/// ⚠️ 这条不是本件新引入的问题：改动前点 `✕` 就是直接走、同样会丢字。
///    本件顺手把它堵上，而且**两条路（点 ✕ / 托盘菜单的「退出」）共用它**。
fn request_quit(app: &tauri::AppHandle) {
    spawn_quit_watchdog(app.clone());
    let _ = app.emit("app-quit-requested", ());
}

/// 退出的**兜底**：2 秒后不管前端有没有回话，直接退。
///
/// 为什么必须有：前端可能根本不理我们 —— 正在启动（页面还没挂监听）、
/// 页面崩了、脚本出错…… 少了它就会出现**"点了 ✕ 关不掉"**，
/// 那比丢一个字严重得多（用户只能去开任务管理器）。
///
/// ⚠️ `app.exit(0)` 不会再触发一次 `CloseRequested`（它是直接退进程），
///    所以不会绕回来形成死循环。
///
/// ⭐ **两层退法**，因为第一层在"事件循环正卡着"时是排不上队的：
///   `app.exit()` 只是**把退出请求塞进事件循环的消息队列**
///   （它自己不阻塞、也不会立刻退）。若此刻主线程正卡在别处
///   （比如上面那条 `emit`），这条请求就永远处理不到 ⇒ 进程还在。
///   所以再等一会儿补一层**硬退**，把"关不掉"从可能性里彻底删掉。
///
///   代价：极端情况下最后那一秒多里没落库的字会丢 ——
///   但那是"本来就已经卡住"的场景，能关掉比什么都重要。
fn spawn_quit_watchdog(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("quit-watchdog".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(2));
            // 第一层：请事件循环正常退出（它会走 Tauri 自己的收尾）。
            app.exit(0);
            // 第二层：再等一会儿还不退 ⇒ 事件循环确实卡着，硬退。
            std::thread::sleep(std::time::Duration::from_millis(1500));
            std::process::exit(0);
        });
    // 线程都建不起来（极端情况）也得留个痕：那时就只剩"指望前端"这一条路了。
    if let Err(e) = spawned {
        eprintln!("退出兜底线程未能启动（此时只能等前端回话）：{e}");
    }
}

/// 建系统托盘图标。
///
/// ⭐ 它存在的**真正理由不是"方便"**，而是【P2-13】的写作提醒**需要进程活着**：
///    窗口关掉、进程没了，21:00 的提醒永远响不了。
///    这也是"关闭行为的默认值要跟提醒走"的由来（见 `db::close_action()`）。
///
/// ⚠️ 全程**绝不上抛错误**：托盘是锦上添花，建不起来最多是
///    "关闭行为退回直接退出"（见 `commands::apply_tray_availability`）。
///    为一个图标让软件起不来，是拿小功能换掉整个软件。
///    ⇒ 所以这里把 `try_setup_tray` 的 `Err` **收成一句日志**就完事：
///      ⛔ 调用处不要写 `?`、⛔ 更不要 `expect` / `unwrap`。
fn setup_tray(app: &tauri::AppHandle) {
    if let Err(e) = try_setup_tray(app) {
        eprintln!("托盘创建失败：{e}；关闭行为会退回「直接退出」");
    }
}

/// 真正建托盘那一段。任何一步失败都返回 `Err` —— **由 `setup_tray` 收成日志**。
fn try_setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let state = app.state::<VaultState>();

    // 图标一律用 `default_window_icon()`：它在**编译期**就已经解码好
    // （来自 `tauri.conf.json` 的 `bundle.icon`）。
    // ⚠️ 不要自己去找 png 路径、更不要引 `image` crate ——
    //    本机 `Cargo.lock` 里**没有** `image`，引了直接构建失败。
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("托盘图标缺失：跳过托盘，关闭行为会退回「直接退出」");
        return Ok(());
    };

    // 菜单两项。**id 是稳定标识，别拿中文字 label 去匹配** ——
    // label 是给人看的，将来改一个字就把逻辑改坏了。
    let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let icon = TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .tooltip("日记")
        // 左键点图标要"显示窗口"，所以菜单**只在右键出** ——
        // 否则左键既弹菜单又显示窗口，两件事叠在一起。
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => show_main(app),
            // ⚠️ 走"退出"这条路**必须让前端先落库**，所以不是 `app.exit(0)`，
            //    而是发一条请求交给前端（见 `request_quit`）。
            "quit" => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    // ⚠️ 这个返回值**不能随手丢**：`TrayIcon` 是引用计数的，
    //    "最后一个实例被 drop 时图标就被移除"（tauri 2.11 的原话）。
    //    这里之所以能在函数结束时让它离开作用域，是因为 `build()` 内部
    //    已经 clone 了一份存进应用的资源表
    //    （`app.resources_table().add(icon.clone())`）⇒ 计数不为 0。
    //    ⛔ 别改成 `mem::forget`（没必要），也别调 `set_visible(false)`。
    drop(icon);

    // 记下"托盘真的建起来了"。**必须在 build 成功之后**：
    // 置早了，用户在"托盘没建成"的机器上点 ✕ 就会关不回来。
    state.set_tray_ok();
    Ok(())
}

// ---------------------------------------------------------------------------
// 启动方式与开机自启（【P2-13】）
// ---------------------------------------------------------------------------

/// 注册表里那个值的名字（`HKCU\...\Run` 下）。
///
/// ⚠️ **必须固定**：每次换个名字就会在注册表里堆一条新的，
///    而用户关掉自启时只删得掉当前这个名字，老的那些全留下 ——
///    下次开机照样会把软件拉起来，用户却找不到是从哪来的。
const AUTO_START_VALUE_NAME: &str = "Diary";

/// 这次启动是不是"开机自启"那条路径（系统带着 `--startup` 把我们拉起来的）。
///
/// 参数由注册表里那一条命令给出（见 `set_auto_start_impl`）：
/// `"<exe 的完整路径>" --startup`。用户从开始菜单点开时**没有**这个参数。
fn is_startup_launch() -> bool {
    std::env::args().any(|a| a == "--startup")
}

/// 决定这次启动要不要把窗口显出来（【P2-13】§五-6）。
///
/// ⭐ **`tauri.conf.json` 里窗口是 `"visible": false`，所以"显示"这件事
///    没有任何兜底 —— 漏掉它就是"双击图标什么都没发生"。**
///    两条路径都在这里显式处理：
///      - 正常启动（用户双击图标）⇒ **必须 show**，观感与改动前逐帧一致
///        （`setup` 阶段就调，用户看不到多出来的等待）；
///      - 开机自启（`--startup`）⇒ **不 show**，直接进托盘。
///
/// ⭐ **"托盘建不起来 ⇒ 自启那条路也要 show"**：否则托盘上没图标、窗口又不显，
///    用户开机之后**彻底找不到这个软件**（只能靠任务管理器，还得先知道有它）。
///    方向与 `close_action` 那边一致 —— **宁可多显一个窗口，
///    也绝不能出现"什么都看不见"**。
///
/// ⚠️ 判断"托盘可用"**必须问 `VaultState::tray_ok()`**（由 `setup_tray` 置位），
///    ⛔ 不要在这里再去问一次系统、更不要另建一个托盘 —— 那会变成第二份判定，
///    而两份判定迟早不一致。
fn show_window_unless_silent(app: &tauri::AppHandle) {
    let silent = is_startup_launch() && app.state::<VaultState>().tray_ok();
    if silent {
        return;
    }
    show_main(app);
}

/// 写 / 删注册表里的开机自启项（【P2-13】）。
///
/// - `on == true`：往 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
///   写一个 `Diary` 值，内容是 `"<exe 的完整路径>" --startup`。
///   ⚠️ **路径必须带引号**：安装目录里可能有空格（"Program Files"）或中文，
///   不带引号系统会在空格处把命令截断 ⇒ 开机时报"找不到文件"，
///   而用户只会看到"自启没生效"，查不出为什么。
/// - `on == false`：删掉它。**值本来就不存在也算成功**（幂等）。
///
/// ⚠️ 只写 `HKCU`，**绝不写 `HKLM`**：后者要管理员权限，日记软件不该要。
///
/// ⚠️ 已经是目标值时**直接返回、不重复写**：`sync_auto_start` 每次解锁后
///    都会跑一遍，没必要天天去动注册表。
///
/// ⚠️ 非 Windows 上是空操作（返回成功）：本机是 Windows，但别的平台
///    编这一份代码时不该因为注册表而编不过。
pub fn set_auto_start_impl(exe: &std::path::Path, on: bool) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run, _) = hkcu
            .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .map_err(|e| AppError::State(format!("无法打开自启注册表项：{e}")))?;

        if on {
            let want = format!("\"{}\" --startup", exe.display());
            if let Ok(cur) = run.get_value::<String, _>(AUTO_START_VALUE_NAME) {
                if cur == want {
                    return Ok(());
                }
            }
            run.set_value(AUTO_START_VALUE_NAME, &want)
                .map_err(|e| AppError::State(format!("无法写入自启注册表项：{e}")))?;
        } else {
            // 删一个不存在的值会返回 NotFound —— 那正是我们想要的结果，忽略它。
            let _ = run.delete_value(AUTO_START_VALUE_NAME);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (exe, on);
    }
    Ok(())
}
