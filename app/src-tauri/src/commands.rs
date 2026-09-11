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
use crate::db::{BackupResult, Entry, EntrySummary, IntegrityReport, SearchHit, Stats, Vault};
use crate::error::{AppError, AppResult};
use serde::Serialize;
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

#[tauri::command]
pub fn save_entry(
    state: State<'_, VaultState>,
    date: String,
    title: String,
    content_md: String,
) -> AppResult<Entry> {
    with_vault(&state, |v| v.save_entry(&date, &title, &content_md))
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
