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
pub struct VaultState {
    pub data_dir: PathBuf,
    /// 已解锁的数据库连接。None 表示未解锁。
    pub vault: Mutex<Option<Vault>>,
}

impl VaultState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            vault: Mutex::new(None),
        }
    }
}

/// 解析应用数据目录。
///
/// 用系统标准的应用数据目录，而不是程序所在目录 —— 后者在安装到
/// Program Files 后通常不可写。
pub fn resolve_data_dir() -> AppResult<PathBuf> {
    let proj = directories::ProjectDirs::from("com", "dsh", "Diary")
        .ok_or_else(|| AppError::State("无法确定应用数据目录".into()))?;
    Ok(proj.data_dir().to_path_buf())
}

fn with_vault<T>(state: &State<'_, VaultState>, f: impl FnOnce(&Vault) -> AppResult<T>) -> AppResult<T> {
    let guard = state
        .vault
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
    let lock_path = crypto::lockout_path(&state.data_dir);
    let mut lockout = crypto::LockoutState::load(&lock_path);
    let db_exists = state.data_dir.join("diary.db").exists();

    // 若锁定已过期，顺手清理（会写回文件）。
    let _ = lockout.check_not_locked(&lock_path);
    let remaining_secs = lockout.remaining_lock_secs();

    let unlocked = state
        .vault
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
        data_dir: state.data_dir.to_string_lossy().to_string(),
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
    let lock_path = crypto::lockout_path(&state.data_dir);
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

    let vault = Vault::create(&state.data_dir, &pin, hint)?;

    let mut guard = state
        .vault
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
    let lock_path = crypto::lockout_path(&state.data_dir);
    let mut lockout = crypto::LockoutState::load(&lock_path);

    // 先检查锁定期。锁定中不消耗尝试次数，也不做密钥派生（省掉无谓的 0.8 秒）。
    lockout.check_not_locked(&lock_path)?;

    match Vault::unlock(&state.data_dir, &pin) {
        Ok(vault) => {
            {
                let mut guard = state
                    .vault
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
            .vault
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
/// ⚠️ 会同时写一个 `crypto_meta-<时间戳>.meta.json`。
///    这不是可选项：`crypto_meta.json` 含 salt 与 KDF 参数，
///    **缺了它，即使 PIN 完全正确也派生不出密钥，备份永久打不开。**
///    所以备份产物永远是"两个文件一组"，界面上必须一起提示用户。
///    它是明文，但 salt 与 KDF 参数本身不是秘密，放在一起不会降低安全性。
#[tauri::command]
pub fn backup_now(state: State<'_, VaultState>, dest_dir: String) -> AppResult<BackupResult> {
    let meta_src = crypto::crypto_meta_path(&state.data_dir);
    let result = with_vault(&state, |v| {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let stamp_text = format_unix_compact(stamp);
        let dest = PathBuf::from(&dest_dir).join(format!("diary-{stamp_text}.db"));
        v.backup_to(&dest)
    })?;

    // 把加密元信息复制到备份旁边。
    if meta_src.exists() {
        let stem = PathBuf::from(&result.path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "diary".into());
        let meta_dst = PathBuf::from(&dest_dir).join(format!("{stem}.meta.json"));
        std::fs::copy(&meta_src, &meta_dst)?;
    }

    Ok(result)
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
    let meta_path = crypto::crypto_meta_path(&state.data_dir);
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
