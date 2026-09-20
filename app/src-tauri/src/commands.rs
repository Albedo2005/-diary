//! Tauri command 层：前端唯一能调用的接口。
//!
//! 这里是前端与加密数据库之间的**唯一通道**。设计规则：
//!
//! 1. **不暴露任何"执行任意 SQL"的接口**。每个 command 都是预定义的业务操作。
//! 2. **不返回密钥、salt、KDF 参数**。前端不需要它们，给了只会扩大攻击面。
//! 3. 前端传来的字符串（PIN、日期、查询词）一律在 Rust 侧校验后再用。
//!
//! 状态管理：`VaultState` 用 Mutex 包住"当前已解锁的数据库连接"。
//! 未解锁时是 None，此时任何数据操作都返回 `State` 错误 ——
//! 这样即使前端被绕过，也拿不到数据，因为密钥只在解锁后的连接里。

use crate::crypto::{self, CryptoMeta, KdfParams};
use crate::db::{
    AppSettings, BackupResult, DayMood, Entry, EntrySummary, IntegrityReport, SearchHit, Stats,
    Vault,
};
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// 应用当前状态。前端用它决定显示解锁页还是日历页。
#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    /// 数据库文件是否已存在（决定"初始化"还是"解锁"）。
    pub initialized: bool,
    /// 当前是否已解锁。
    pub unlocked: bool,
    /// 是否处于锁定期。
    pub locked: bool,
    /// 剩余锁定秒数。
    pub remaining_lock_secs: u64,
    /// 剩余尝试次数。
    pub remaining_attempts: u32,
    /// 是否该显示提示。
    pub show_hint: bool,
    /// 用户写下的提示文本（明文，见 crypto.rs 的说明）。
    pub hint: Option<String>,
    /// 最小 PIN 长度。
    pub pin_min_len: usize,
    /// 最大尝试次数。
    pub max_attempts: u32,
    /// 锁定时长（秒）。
    pub lockout_secs: u64,
    /// 数据目录，便于设置页展示与备份选择默认位置。
    pub data_dir: String,
}

/// 全局可共享的应用状态。
///
/// ⚠️ 为什么内部套一层 `Arc`，而不是把 `Arc<VaultState>` 注册给 Tauri：
///   命令签名声明的是 `State<'_, VaultState>`，Tauri 按**具体类型**查找状态，
///   所以注册进去的必须正好是 `VaultState`。
///   注册 `Arc<VaultState>` 会导致运行时报
///   "state not managed for field `state` on command ..."
///   （这个错误在本项目里真实发生过）。
///
///   而 `VaultState` 又需要被两处共享：
///     1. Tauri 的状态管理
///     2. 后台自动备份线程
///   解决办法：把真正需要共享的内容放进 `Arc<VaultStateInner>`，
///   然后 `VaultState` 实现 `Clone`（克隆只是 Arc 计数 +1）。
///   这样注册的是 `VaultState` 本身，而所有克隆共享同一份数据。
pub struct VaultState {
    inner: std::sync::Arc<VaultStateInner>,
}

/// 被共享的实际内容。所有字段都是 `Sync` 的。
struct VaultStateInner {
    data_dir: PathBuf,
    /// 已解锁的数据库连接。None 表示未解锁。
    vault: Mutex<Option<Vault>>,
}

impl Clone for VaultState {
    /// 克隆出的副本与原件**共享同一份数据**（Arc 语义），
    /// 所以后台线程看到的解锁状态与命令层完全一致。
    fn clone(&self) -> Self {
        Self {
            inner: std::sync::Arc::clone(&self.inner),
        }
    }
}

impl VaultState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            inner: std::sync::Arc::new(VaultStateInner {
                data_dir,
                vault: Mutex::new(None),
            }),
        }
    }

    /// 数据目录。命令层与备份逻辑都用它。
    pub fn data_dir(&self) -> &PathBuf {
        &self.inner.data_dir
    }

    /// 借用已解锁的连接。
    pub fn vault(&self) -> &Mutex<Option<Vault>> {
        &self.inner.vault
    }
}

/// 解析数据目录：日记到底存在哪。
///
/// 这是一个**便携式应用**：数据跟着项目走，而不是塞进 AppData。
/// 用户要能自己看见、自己备份自己的日记文件。
///
/// 解析顺序（先命中者胜）：
///   1. 环境变量 `DSH_DIARY_DATA_DIR` —— 用于测试与多套数据并存
///   2. 从可执行文件所在目录**向上查找**名为 `data` 的目录，
///      最多找 4 层。之所以要向上找：开发时 exe 在 `target/release/` 下，
///      距项目根有三层；打包安装后 exe 在安装目录里，一层就到。
///   3. 都找不到就用可执行文件旁边的 `data`（首次运行时创建）
///
/// 为什么不沿用"系统标准应用数据目录"（AppData）：
///   那会让用户找不到自己的日记文件，也不符合"完全离线、数据在本地"的定位。
///   代价是安装到 Program Files 后可能不可写 —— 但本应用是便携式的，
///   不会装到那里。
pub fn resolve_data_dir() -> AppResult<PathBuf> {
    // 1. 环境变量覆盖
    if let Ok(dir) = std::env::var("DSH_DIARY_DATA_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return Ok(p);
        }
    }

    // 2. 从 exe 所在目录向上找已有的 data 目录
    let exe = std::env::current_exe()
        .map_err(|e| AppError::State(format!("无法确定程序位置: {e}")))?;

    if let Some(mut dir) = exe.parent().map(|p| p.to_path_buf()) {
        for _ in 0..4 {
            let candidate = dir.join("data");
            if candidate.is_dir() {
                return Ok(candidate);
            }
            match dir.parent() {
                Some(parent) => dir = parent.to_path_buf(),
                None => break,
            }
        }
        // 3. 找不到就建在 exe 旁边
        return Ok(exe
            .parent()
            .map(|p| p.join("data"))
            .unwrap_or_else(|| PathBuf::from("data")));
    }

    Err(AppError::State("无法确定数据目录".into()))
}

fn with_vault<T>(state: &State<'_, VaultState>, f: impl FnOnce(&Vault) -> AppResult<T>) -> AppResult<T> {
    let guard = state
        .vault()
        .lock()
        .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
    match guard.as_ref() {
        Some(vault) => f(vault),
        None => Err(AppError::State("尚未解锁，请先输入密码".into())),
    }
}

// ---------------------------------------------------------------------------
// 状态查询
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn app_status(state: State<'_, VaultState>) -> AppResult<AppStatus> {
    let lock_path = crypto::lockout_path(state.data_dir());
    let mut lockout = crypto::LockoutState::load(&lock_path);
    let db_exists = state.data_dir().join("diary.db").exists();

    // 若锁定已过期，顺手清理（会写回文件）。
    let _ = lockout.check_not_locked(&lock_path);
    let remaining_secs = lockout.remaining_lock_secs();

    let unlocked = state
        .vault()
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);

    Ok(AppStatus {
        initialized: db_exists,
        unlocked,
        locked: remaining_secs > 0,
        remaining_lock_secs: remaining_secs,
        remaining_attempts: lockout.remaining_attempts(),
        show_hint: lockout.should_show_hint(),
        hint: lockout.hint.clone(),
        pin_min_len: lockout.pin_min_len,
        max_attempts: crypto::MAX_FAILED_ATTEMPTS,
        lockout_secs: crypto::LOCKOUT_DURATION.as_secs(),
        data_dir: state.data_dir().to_string_lossy().to_string(),
    })
}

/// 预估 KDF 耗时，供初始化界面提示用户"首次设置需要约 1 秒"。
#[tauri::command]
pub fn estimate_kdf_ms() -> AppResult<u128> {
    Ok(crypto::KdfParams::default().m_cost as u128)
}

// ---------------------------------------------------------------------------
// 初始化与解锁
// ---------------------------------------------------------------------------

/// 首次初始化：设置密码并创建加密数据库。
#[tauri::command]
pub fn initialize_vault(
    state: State<'_, VaultState>,
    pin: String,
    hint: Option<String>,
) -> AppResult<()> {
    let lock_path = crypto::lockout_path(state.data_dir());
    let mut lockout = crypto::LockoutState::load(&lock_path);

    // 初始化也必须受锁定期约束，否则可以在锁定期内反复重建库绕过限制。
    lockout.check_not_locked(&lock_path)?;

    crypto::validate_pin(&pin, lockout.pin_min_len)?;

    let hint = hint.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            // 提示会明文存储并显示在锁屏界面，长度做个限制避免被当备忘录用。
            Some(t.chars().take(60).collect::<String>())
        }
    });

    let vault = Vault::create(state.data_dir(), &pin, hint)?;

    let mut guard = state
        .vault()
        .lock()
        .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
    *guard = Some(vault);

    let mut fresh = crypto::LockoutState::load(&lock_path);
    fresh.initialized = true;
    fresh.record_success(&lock_path)?;

    Ok(())
}

/// 解锁。
///
/// 失败路径必须极其小心：
///   - 不能泄漏"密码错在哪一位"
///   - 每次失败都要持久化计数（否则重启即可重置）
///   - 达到上限后进入锁定期
#[tauri::command]
pub fn unlock_vault(state: State<'_, VaultState>, pin: String) -> AppResult<AppStatus> {
    let lock_path = crypto::lockout_path(state.data_dir());
    let mut lockout = crypto::LockoutState::load(&lock_path);

    // 先检查锁定期。锁定中不消耗尝试次数，也不做密钥派生（省掉无谓的 0.8 秒）。
    lockout.check_not_locked(&lock_path)?;

    match Vault::unlock(state.data_dir(), &pin) {
        Ok(vault) => {
            {
                let mut guard = state
                    .vault()
                    .lock()
                    .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
                *guard = Some(vault);
            }
            lockout.record_success(&lock_path)?;
            app_status(state)
        }
        Err(AppError::WrongPin) => {
            let locked_now = lockout.record_failure(&lock_path)?;
            if locked_now {
                Err(AppError::Locked {
                    remaining_secs: crypto::LOCKOUT_DURATION.as_secs(),
                })
            } else {
                Err(AppError::WrongPin)
            }
        }
        Err(e) => Err(e),
    }
}

/// 手动锁定（离开电脑时用）。只丢弃内存中的连接，不删数据。
#[tauri::command]
pub fn lock_vault(state: State<'_, VaultState>) -> AppResult<AppStatus> {
    {
        let mut guard = state
            .vault()
            .lock()
            .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
        // 直接 drop 连接。密钥随连接对象一起被释放。
        *guard = None;
    }
    app_status(state)
}

// ---------------------------------------------------------------------------
// 日记读写
// ---------------------------------------------------------------------------

/// 打开某天的日记。
///
/// **不写库**：没有内容时返回一条空模板（id = 0）。
/// 用户真正输入内容并保存后才会落库 —— 所以"点开日历"不会被算成"写过日记"。
#[tauri::command]
pub fn open_entry(state: State<'_, VaultState>, date: String) -> AppResult<Entry> {
    with_vault(&state, |v| v.open_entry(&date))
}

/// 查询某天是否**写过**（正文非空白）。
///
/// 判定规则集中在 `db::has_content_sql()`，与日历标记、月度摘要、
/// 统计、搜索索引用的是同一条规则。
#[tauri::command]
pub fn is_date_written(state: State<'_, VaultState>, date: String) -> AppResult<bool> {
    with_vault(&state, |v| v.is_written(&date))
}

/// 保存日记。
///
/// `mood`：1=悲伤 2=受伤 3=茫然 4=愤怒 5=开心（1~5 只是编号，无好坏顺序），
/// `null` = 未标记。
///
/// 心情并进 save_entry 而**不是**单独开一个命令，是有意的设计：
/// 单开命令就会出现"先标心情、后写正文"的中间状态，库里留下
/// "有心情但没内容"的行，与"打开 ≠ 写过"的判定冲突。
/// 并进来之后，两者永远同一次写入、同生同灭（空内容时后端会丢掉心情）。
#[tauri::command]
pub fn save_entry(
    state: State<'_, VaultState>,
    date: String,
    title: String,
    content_md: String,
    mood: Option<i64>,
) -> AppResult<Entry> {
    with_vault(&state, |v| {
        v.save_entry_with_mood(&date, &title, &content_md, mood)
    })
}

/// 一次性锁上所有日记，返回被锁的篇数。
///
/// 由前端在**切换日期**和**应用启动**时调用 —— 效果等价于
/// "离开一篇日记 / 关掉软件，所有日记就都锁上了"。
#[tauri::command]
pub fn lock_all_entries(state: State<'_, VaultState>) -> AppResult<usize> {
    with_vault(&state, |v| v.lock_all_entries())
}

/// 锁定 / 解锁某天的日记。
///
/// 锁定只影响"能否修改"，**不改动正文一个字符** —— 用户手动排的版原样保留。
#[tauri::command]
pub fn set_entry_locked(
    state: State<'_, VaultState>,
    date: String,
    locked: bool,
) -> AppResult<Entry> {
    with_vault(&state, |v| v.set_entry_locked(&date, locked))
}

#[tauri::command]
pub fn delete_entry(state: State<'_, VaultState>, date: String) -> AppResult<()> {
    with_vault(&state, |v| v.delete_entry(&date))
}

#[tauri::command]
pub fn list_month(state: State<'_, VaultState>, month: String) -> AppResult<Vec<EntrySummary>> {
    with_vault(&state, |v| v.list_month(&month))
}

#[tauri::command]
pub fn written_dates(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> AppResult<Vec<String>> {
    with_vault(&state, |v| v.written_dates(&from, &to))
}

/// 区间内**有心情标记**的日期 → 心情值。日历用它给日期格加表情。
///
/// 和 `written_dates` 分开：那个回答"这天写过没"，这个回答"这天标了什么心情"。
/// 返回结果里只有真正带心情的日子，没标的不占位置。
#[tauri::command]
pub fn written_moods(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> AppResult<Vec<DayMood>> {
    with_vault(&state, |v| v.written_moods(&from, &to))
}

#[tauri::command]
pub fn stats(state: State<'_, VaultState>) -> AppResult<Stats> {
    with_vault(&state, |v| v.stats())
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn search_entries(
    state: State<'_, VaultState>,
    query: String,
    limit: Option<i64>,
) -> AppResult<Vec<SearchHit>> {
    with_vault(&state, |v| v.search(&query, limit.unwrap_or(50)))
}

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

/// 备份到指定目录。文件名自动带时间戳。
///
/// ⚠️ 会同时写一个 `diary-<时间戳>.meta.json`。
///    这不是可选项：`crypto_meta.json` 含 salt 与 KDF 参数，
///    **缺了它，即使 PIN 完全正确也派生不出密钥，备份永久打不开。**
///    所以备份产物永远是"两个文件一组"，界面上必须一起提示用户。
///    它是明文，但 salt 与 KDF 参数本身不是秘密，放在一起不会降低安全性。
#[tauri::command]
pub fn backup_now(state: State<'_, VaultState>, dest_dir: String) -> AppResult<BackupResult> {
    let stamp_text = now_stamp();
    let result = with_vault(&state, |v| {
        let (r, _deleted) = v.run_backup(&PathBuf::from(&dest_dir), &stamp_text)?;
        Ok(r)
    })?;
    copy_crypto_meta(state.data_dir(), &dest_dir, &stamp_text)?;
    Ok(result)
}

/// 备份相关状态，供界面展示。
#[derive(Debug, Clone, Serialize)]
pub struct BackupStatus {
    /// 备份目录（默认是数据目录下的 backups 子目录）。
    pub dest_dir: String,
    /// 自动备份是否开启。
    pub auto_enabled: bool,
    /// 下次自动备份还需多少秒。0 表示很快就会执行。
    pub secs_until_next: u64,
    /// 备份间隔（秒），用于界面显示"每天一次"。
    pub interval_secs: u64,
    /// 保留的最近份数。
    pub keep_recent: usize,
    /// 已有备份数量。
    pub backup_count: usize,
}

/// 默认备份目录：数据目录下的 `backups`。
///
/// 放在数据目录里而不是让用户随便选，理由：备份是密文，
/// 和数据放一起是安全的；而且用户能在一个地方看到全部相关文件。
pub fn default_backup_dir(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("backups")
}

#[tauri::command]
pub fn backup_status(state: State<'_, VaultState>) -> AppResult<BackupStatus> {
    let dest = default_backup_dir(state.data_dir());
    let dest_str = dest.to_string_lossy().to_string();
    let count = std::fs::read_dir(&dest)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().ends_with(".db"))
                .count()
        })
        .unwrap_or(0);

    with_vault(&state, |v| {
        Ok(BackupStatus {
            dest_dir: dest_str,
            auto_enabled: v.auto_backup_enabled()?,
            secs_until_next: v.secs_until_next_auto_backup()?,
            interval_secs: crate::db::AUTO_BACKUP_INTERVAL_SECS,
            keep_recent: v.keep_recent_backups()?,
            backup_count: count,
        })
    })
}

/// 开关自动备份。
#[tauri::command]
pub fn set_auto_backup(state: State<'_, VaultState>, enabled: bool) -> AppResult<()> {
    with_vault(&state, |v| {
        v.set_setting(crate::db::setting_keys::AUTO_BACKUP_ENABLED, if enabled { "true" } else { "false" })
    })
}

// ---------------------------------------------------------------------------
// 应用设置
// ---------------------------------------------------------------------------

/// 读取应用设置（目前只有"自动锁定时长"）。
///
/// ⚠️ 刻意**不**把这些值并进 `app_status`：`app_setting` 表在**加密库**里，
///    未解锁时读不到 —— 硬塞进 status 只会返回默认值，
///    前端还以为"用户设的就是 10 分钟"，实际根本没读到。
///    读不到就说不出来，比编一个值好。
///
/// 走 `with_vault`：未解锁必须拒绝，不能靠默认值糊弄过去。
#[tauri::command]
pub fn get_settings(state: State<'_, VaultState>) -> AppResult<AppSettings> {
    with_vault(&state, |v| v.get_settings())
}

/// 设置"窗口失去焦点后多久自动锁定"（秒）。`0` = 永不。
///
/// 档位白名单校验在数据层（`db::AUTO_LOCK_ALLOWED_SECS`）——
/// 这里只负责"必须已解锁"。校验放在数据层而不是命令层，
/// 是为了让"绕过界面直接调命令"也拿不到非法值。
#[tauri::command]
pub fn set_auto_lock_secs(state: State<'_, VaultState>, secs: u32) -> AppResult<()> {
    with_vault(&state, |v| v.set_auto_lock_secs(secs))
}

// ---------------------------------------------------------------------------
// 窗口形态（库外明文文件 ui_prefs.json）
// ---------------------------------------------------------------------------

/// 窗口形态。与前端 `WindowMode` 一一对应。
pub const WINDOW_MODE_WINDOW: &str = "window";
pub const WINDOW_MODE_MAXIMIZED: &str = "maximized";
pub const WINDOW_MODE_FULLSCREEN: &str = "fullscreen";

/// 默认形态。等于 `tauri.conf.json` 里的窗口参数，所以**不是行为变更**。
pub const DEFAULT_WINDOW_MODE: &str = WINDOW_MODE_WINDOW;

fn is_valid_window_mode(mode: &str) -> bool {
    matches!(
        mode,
        WINDOW_MODE_WINDOW | WINDOW_MODE_MAXIMIZED | WINDOW_MODE_FULLSCREEN
    )
}

/// `<数据目录>/ui_prefs.json`。
pub fn ui_prefs_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("ui_prefs.json")
}

/// 库外偏好文件的内容。
///
/// ⚠️ **这个文件为什么不能放进加密库**（本功能最不能商量的一条）：
///    启动时序是"建窗口 → 窗口出现 → 解锁加密库 → `app_setting` 才可读"，
///    而窗口形态必须在"窗口出现"**之前**就定下来。
///    存进加密库的后果很具体：每次启动都先出 1040×720 的窗口、
///    解锁后才撑开，每次都跳一下。
///
/// 字段一律 `#[serde(default)]`：以后加字段（如指令 13 的窗口几何）
/// 不会把旧文件变成"解析失败"。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiPrefs {
    #[serde(default)]
    pub window_mode: Option<String>,
    // 指令 13 会在这里加 window_size / window_pos。本指令不加。
}

/// 读 `ui_prefs.json`。文件不存在 / 读失败 / JSON 坏 → 全部字段为 None。
fn read_ui_prefs(data_dir: &std::path::Path) -> UiPrefs {
    match std::fs::read_to_string(ui_prefs_path(data_dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => UiPrefs::default(),
    }
}

/// 读窗口形态。
///
/// **文件缺失 / 读失败 / 值不在白名单，一律回落 "window"，不报错。**
/// 读不报错是刻意的：这个函数在"窗口还没出现"时就要跑（见 lib.rs 的 setup），
/// 任何一次 Err 都可能让窗口永远显示不出来。
pub fn load_window_mode(data_dir: &std::path::Path) -> String {
    read_ui_prefs(data_dir)
        .window_mode
        .filter(|m| is_valid_window_mode(m))
        .unwrap_or_else(|| DEFAULT_WINDOW_MODE.to_string())
}

/// 写窗口形态。
///
/// **只改 `window_mode` 一个键，其余键原样保留** —— 所以它是
/// "读原文 → 改一个键 → 写回"，而**不是**"反序列化成 `UiPrefs` 再整份写回"。
/// 后者会把文件里不认识的键全部丢掉，而指令 13 的窗口几何正要存在同一个
/// 文件里 —— 那种 bug 要到指令 13 做完才会暴露，且看起来像"记忆功能偶尔失灵"。
///
/// 原文读不到 / 是坏 JSON / 不是对象 → 从空对象重建（等价于"这个文件就存这一项"）。
///
/// 写入用"临时文件 + 原子改名"，与 crypto.rs 的 `LockoutState::save` 同一套写法：
/// 写到一半崩溃也不会留下半个坏文件。
fn save_window_mode(data_dir: &std::path::Path, mode: &str) -> AppResult<()> {
    if !is_valid_window_mode(mode) {
        return Err(AppError::Validation(format!(
            "不支持的窗口模式：{mode}（只接受 {WINDOW_MODE_WINDOW} / \
             {WINDOW_MODE_MAXIMIZED} / {WINDOW_MODE_FULLSCREEN}）"
        )));
    }

    let path = ui_prefs_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut root: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !root.is_object() {
        root = serde_json::json!({});
    }
    root["window_mode"] = serde_json::Value::String(mode.to_string());

    let text = serde_json::to_string_pretty(&root)
        .map_err(|e| AppError::State(format!("序列化窗口偏好失败: {e}")))?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// `tauri::Error` → 带稳定 kind 的应用错误。
fn window_op_err(e: tauri::Error) -> AppError {
    AppError::State(format!("调整窗口失败: {e}"))
}

/// 把窗口还原成"窗口"档该有的几何。
///
/// 本指令（12）内部只有 `center()` —— `tauri.conf.json` 里的 `center: true`
/// **只在首次创建窗口时生效**；从全屏 / 最大化还原时位置是系统记忆的位置，
/// 可能贴在屏幕左上角。
///
/// **指令 13 会把这里换成**："先试记忆几何（`ui_prefs.json` 里的
/// size / pos），越界或没有记忆才 `center()`"。
/// 抽成独立函数就是为了那时不用动主流程 —— 留 TODO 注释会被忽略，
/// 留函数签名不会。
fn restore_window_geometry(window: &tauri::WebviewWindow) {
    let _ = window.center();
}

/// 读当前窗口形态。
///
/// ⚠️ 刻意**不走 `with_vault`**：这个值存在**库外明文文件**里，
///    未解锁时也必须能读 —— 设置页要在解锁前就显示正确的当前档位。
///    走 `with_vault` 会立刻变成"没解锁就读不到"的死功能，
///    而"未解锁"恰恰是启动时的常态。
#[tauri::command]
pub fn get_window_mode(state: State<'_, VaultState>) -> AppResult<String> {
    Ok(load_window_mode(state.data_dir()))
}

/// 切换窗口形态。
///
/// 顺序不能反：**① 先写文件并确认成功 → ② 再改窗口状态**。
/// 反过来的话，窗口已经变了而文件没记住，重启后又变回去，
/// 用户会以为"设置没保存"。
///
/// ⚠️ 同样**不走 `with_vault`**（理由见 `get_window_mode`）。
#[tauri::command]
pub fn set_window_mode(
    state: State<'_, VaultState>,
    window: tauri::WebviewWindow,
    mode: String,
) -> AppResult<()> {
    save_window_mode(state.data_dir(), &mode)?;

    // ⚠️ Tauri 2.11 的方法名是 `maximize()` / `unmaximize()`，
    //    **没有 `set_maximized(bool)`**（指令原文写的是后者，此处按实际 API 写）。
    let applied: tauri::Result<()> = match mode.as_str() {
        WINDOW_MODE_FULLSCREEN => window.set_fullscreen(true),
        WINDOW_MODE_MAXIMIZED => {
            // 必须显式退全屏再最大化：从全屏直接最大化，
            // 部分平台上会保持无边框，看着还是全屏。
            window.set_fullscreen(false).and_then(|_| window.maximize())
        }
        // 走到这里只可能是 "window" —— 非法值已在 save_window_mode 拦下。
        _ => window
            .set_fullscreen(false)
            .and_then(|_| window.unmaximize()),
    };
    applied.map_err(window_op_err)?;

    // 还原成"窗口"档后不一定居中，要显式摆一次。
    if mode == WINDOW_MODE_WINDOW {
        restore_window_geometry(&window);
    }
    Ok(())
}

/// 按已存档的形态调整窗口 —— **启动时**用（由 lib.rs 的 setup 调用）。
///
/// 与 `set_window_mode` 的区别在 "window" 档：这里**什么都不做**。
/// 窗口就是按 `tauri.conf.json` 的 1040×720 居中创建的，
/// 不存在"从全屏还原"这回事，不需要 `center()`。
///
/// 返回 Err 也不会阻塞启动 —— 调用方必须忽略它并**无条件 show()**。
pub fn apply_window_mode_at_startup(window: &tauri::WebviewWindow, mode: &str) -> AppResult<()> {
    let applied: tauri::Result<()> = match mode {
        WINDOW_MODE_FULLSCREEN => window.set_fullscreen(true),
        WINDOW_MODE_MAXIMIZED => window.maximize(),
        _ => Ok(()),
    };
    applied.map_err(window_op_err)
}

/// 后台自动备份的检查间隔。
///
/// 为什么不直接 sleep 24 小时再备份：应用可能中途被关闭、电脑可能休眠，
/// 一次长睡眠会直接错过。改成每 5 分钟醒来检查一次
/// "距上次备份是否已超过 24 小时"，无论是刚开机还是长期运行，
/// 都能在合理时间内补上备份。
///
/// 计时依据是**上次备份的时间戳**（存在库里），不是内存状态，
/// 所以重启应用不会重置计时。
pub const AUTO_BACKUP_CHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(5 * 60);

/// 启动后台自动备份线程。
///
/// 为什么用普通线程而不是 async task：
///   备份全程都要持有 Vault 的 Mutex，并且做的是阻塞式文件 I/O 与
///   SQLite 调用 —— 放在 async 里只会阻塞执行器线程，没有任何收益。
///   一个独立线程语义更清晰，也不需要额外引入运行时依赖。
///
/// 参数是 `VaultState` 的克隆（内部共享同一份 Arc），
/// 所以这个线程看到的解锁状态与命令层完全一致。
///
/// 线程会随进程退出而结束（detached），不需要 join。
pub fn spawn_auto_backup(state: VaultState) {
    std::thread::Builder::new()
        .name("auto-backup".into())
        .spawn(move || loop {
            std::thread::sleep(AUTO_BACKUP_CHECK_INTERVAL);
            if let Err(e) = try_auto_backup(&state) {
                // 自动备份属于后台维护，失败不该打扰用户，但要在日志留痕。
                eprintln!("自动备份跳过: {e}");
            }
        })
        .ok();
}

/// 执行一次自动备份（仅在开启、已解锁且到期时）。
fn try_auto_backup(state: &VaultState) -> AppResult<Option<BackupResult>> {
    // 未解锁：跳过。这是正常状态，不算错误。
    let guard = state
        .vault()
        .lock()
        .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
    let Some(vault) = guard.as_ref() else {
        return Ok(None);
    };

    if !vault.auto_backup_enabled()? {
        return Ok(None);
    }
    if vault.secs_until_next_auto_backup()? > 0 {
        return Ok(None);
    }

    // 一篇都没写就不备份，省得备份目录里堆一堆空库。
    // 但仍要推进计时器，否则每 5 分钟都会重复走到这里。
    if vault.stats()?.total_entries == 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        vault.set_setting(crate::db::setting_keys::LAST_BACKUP_AT, &now.to_string())?;
        return Ok(None);
    }

    let stamp = now_stamp();
    let dest = default_backup_dir(state.data_dir());
    let (result, deleted) = vault.run_backup(&dest, &stamp)?;
    // 先释放锁再做文件复制，缩短持锁时间。
    drop(guard);

    // meta 文件必须一起写，否则备份根本无法解锁。
    copy_crypto_meta(state.data_dir(), &dest.to_string_lossy(), &stamp)?;

    eprintln!(
        "自动备份完成: {} ({} 字节)，清理旧备份 {} 个文件",
        result.path, result.bytes, deleted
    );
    Ok(Some(result))
}

/// 当前时间戳，格式 `YYYYMMDD-HHMMSS`（UTC）。
pub fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix_compact(secs)
}

/// 把 `crypto_meta.json` 复制到备份目录，命名与备份主文件配对。
///
/// 这是备份能否恢复的**必要条件**：meta 里有 salt 与 KDF 参数，
/// 没有它即使密码正确也派生不出密钥。
fn copy_crypto_meta(data_dir: &std::path::Path, dest_dir: &str, stamp: &str) -> AppResult<()> {
    let meta_src = crypto::crypto_meta_path(data_dir);
    if !meta_src.exists() {
        return Ok(());
    }
    let meta_dst = PathBuf::from(dest_dir).join(format!("diary-{stamp}.meta.json"));
    std::fs::copy(&meta_src, &meta_dst)?;
    Ok(())
}

/// 列出备份目录里已有的备份，按时间倒序。
#[tauri::command]
pub fn list_backups(dest_dir: String) -> AppResult<Vec<BackupResult>> {
    let dir = PathBuf::from(&dest_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let path = item.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let meta = item.metadata()?;
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(BackupResult {
            path: path.to_string_lossy().to_string(),
            bytes: meta.len(),
            created_at,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn integrity_check(state: State<'_, VaultState>) -> AppResult<IntegrityReport> {
    with_vault(&state, |v| v.integrity_check())
}

#[tauri::command]
pub fn rebuild_indexes(state: State<'_, VaultState>) -> AppResult<usize> {
    with_vault(&state, |v| v.rebuild_indexes())
}

/// 加密元信息摘要，仅供设置页展示（**不含 salt 与密钥**）。
#[tauri::command]
pub fn crypto_info(state: State<'_, VaultState>) -> AppResult<CryptoInfo> {
    let meta_path = crypto::crypto_meta_path(state.data_dir());
    let meta = CryptoMeta::load(&meta_path)?.ok_or_else(|| AppError::State("缺少加密元信息".into()))?;
    Ok(CryptoInfo {
        kdf: meta.kdf.clone(),
        m_cost_mib: meta.params.m_cost / 1024,
        t_cost: meta.params.t_cost,
        p_cost: meta.params.p_cost,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CryptoInfo {
    pub kdf: String,
    pub m_cost_mib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

/// 把 Unix 秒格式化成 `YYYYMMDD-HHMMSS`（UTC），用于备份文件名。
fn format_unix_compact(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}-{h:02}{mi:02}{s:02}")
}

/// 供将来在初始化时自适应校准使用。
/// 当前初始化直接用 `KdfParams::default()`（已在开发机实测 792 ms），
/// 但保留这个入口，便于将来做"低配机器自动降档"。
#[allow(dead_code)]
pub fn calibrated_params(pin: &str, salt: &[u8; crypto::SALT_LEN]) -> KdfParams {
    crypto::calibrate_kdf_params(salt, pin.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个用完就删的临时目录。tag 用来避免同一次运行里多个测试互相踩。
    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diary-ui-prefs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 窗口形态的读写与全部回落路径。
    ///
    /// 覆盖的坏情况都是真实会遇到的：老用户没有这个文件、文件被手改坏、
    /// 写进了非法值。任何一种都不能让程序报错 —— 这个值在"窗口还没出现"
    /// 时就要读到（见 lib.rs 的 setup）。
    #[test]
    fn window_mode_defaults_and_falls_back() {
        let dir = tmp_dir("mode");

        // 没这个文件（＝升级上来的用户）→ 默认档，不报错
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_WINDOW);

        // 三档都能写能读
        for mode in [
            WINDOW_MODE_WINDOW,
            WINDOW_MODE_MAXIMIZED,
            WINDOW_MODE_FULLSCREEN,
        ] {
            save_window_mode(&dir, mode).expect("写入合法档位");
            assert_eq!(load_window_mode(&dir), mode, "写进去的应当读得回来");
        }

        // 非法值：写入被拒（validation），且**不破坏已存的值**
        let err = save_window_mode(&dir, "big").expect_err("非法值必须被拒");
        assert!(
            matches!(err, AppError::Validation(_)),
            "应当是 validation 错误：{err:?}"
        );
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_FULLSCREEN);

        // 文件被手改成非法值 → 回落默认，不报错
        std::fs::write(ui_prefs_path(&dir), r#"{"window_mode":"big"}"#).unwrap();
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_WINDOW);

        // 坏 JSON → 回落默认
        std::fs::write(ui_prefs_path(&dir), "{ not json").unwrap();
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_WINDOW);

        // 合法 JSON 但不是对象 → 回落默认
        std::fs::write(ui_prefs_path(&dir), "[1,2,3]").unwrap();
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_WINDOW);

        // 缺 window_mode 这个键 → 回落默认
        std::fs::write(ui_prefs_path(&dir), r#"{"something_else":1}"#).unwrap();
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_WINDOW);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本指令的写入**只动 `window_mode` 一个键**。
    ///
    /// 这条是给指令 13（窗口几何）立的契约：几何存在同一个文件里，
    /// 若这里用"反序列化 → 整份写回"，不认识的键会被全部丢掉，
    /// 表现为"记忆大小位置的功能偶尔失灵"，极难复现。
    #[test]
    fn saving_window_mode_keeps_other_keys() {
        let dir = tmp_dir("keep-keys");
        std::fs::write(
            ui_prefs_path(&dir),
            r#"{"window_mode":"window",
                "window_size":{"w":1200,"h":800},
                "window_pos":{"x":40,"y":60}}"#,
        )
        .unwrap();

        save_window_mode(&dir, WINDOW_MODE_MAXIMIZED).expect("写入");

        let text = std::fs::read_to_string(ui_prefs_path(&dir)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["window_mode"], "maximized");
        assert_eq!(v["window_size"]["w"], 1200, "其他键不许被冲掉：{text}");
        assert_eq!(v["window_pos"]["y"], 60, "其他键不许被冲掉：{text}");

        // 文件是坏的也照样能写：从空对象重建，不会把坏内容带出去
        std::fs::write(ui_prefs_path(&dir), "{ not json").unwrap();
        save_window_mode(&dir, WINDOW_MODE_FULLSCREEN).expect("坏文件也要能重建");
        assert_eq!(load_window_mode(&dir), WINDOW_MODE_FULLSCREEN);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
