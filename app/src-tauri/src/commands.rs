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
    derive_and_verify, AppSettings, Attachment, BackupResult, DayMood, Entry, EntrySummary,
    ExportResult, IntegrityReport, PruneReport, SearchHit, Stats, TagStat, Vault,
};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
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
    /// 是否开启了免密打开（`data/auto_login.json` 是否存在）。
    ///
    /// ⚠️ 必须读**库外文件**判断，不能用 `get_setting` —— 那在加密库里，
    ///    未解锁时读不到，而启动时正要靠这个字段决定"走不走免密"，
    ///    那一刻库必然是锁着的。硬塞一个默认值只会骗界面。
    pub auto_login: bool,
    /// 数据目录，便于设置页展示与备份选择默认位置。
    pub data_dir: String,
    /// 「导出全部日记」输入框的默认值（数据目录同级的 `导出/`）。
    ///
    /// 为什么放在 status 里而不是让前端自己拼：默认目录的规则住在后端
    ///（`default_export_dir`），前端再拼一份就成了两处各算各的。
    /// 它只是一段路径文本、不碰加密库，所以未解锁时也能给出来，
    /// 不违反"未解锁不读 `app_setting`"那条（见 `get_settings` 的说明）。
    pub export_default_dir: String,
    /// 图片附件的缓存目录（`<数据目录>/attachments/`）。
    ///
    /// 和 `export_default_dir` 同一个理由放在这里：目录规则住在后端，
    /// 前端再拼一份就是两处各算各的。设置页【数据与备份】用它显示
    /// 「图片缓存位置」，并可一键打开 —— 附件不加密、明文躺在那个目录里
    /// （用户已知风险），所以位置必须让他看得见、找得到。
    ///
    /// ⚠️ 它只是一段路径文本、不碰加密库，所以未解锁时也能给出来。
    ///    应用启动时就会把这个目录建好（见 lib.rs 的 setup），
    ///    所以"打开文件夹"在任何时候都点得动。
    pub attachments_dir: String,
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

/// 「导出全部日记」的默认目标目录：数据目录的**同级**再拼 `导出`。
///
/// 为什么是这里：本应用是便携式的（`data/` 就待在程序旁边，见
/// `resolve_data_dir`），所以默认导出到"软件旁边的导出文件夹"——
/// 用户既找得到，又不会跟 `data/` 里的库文件、库外钥匙文件混在一起。
/// 取不到父目录（理论上不会发生）时退回数据目录内部，至少保证可用。
pub fn default_export_dir(data_dir: &Path) -> PathBuf {
    match data_dir.parent() {
        Some(p) => p.join("导出"),
        None => data_dir.join("导出"),
    }
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
        // 只看"文件在不在"，与开关语义严格一致（文件存在 = 开启，
        // 不设 enabled 字段，避免"文件在、字段却说不开"的矛盾状态）。
        // 刻意**不解析内容**：状态查询不该因为一个坏文件而失败，
        // "钥匙坏了"由 unlock_with_auto_key 处理（它会顺手删掉坏文件）。
        auto_login: crypto::auto_login_path(state.data_dir()).exists(),
        data_dir: state.data_dir().to_string_lossy().to_string(),
        export_default_dir: default_export_dir(state.data_dir())
            .to_string_lossy()
            .to_string(),
        attachments_dir: state
            .data_dir()
            .join("attachments")
            .to_string_lossy()
            .to_string(),
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

    let hint = crypto::normalize_hint(hint);

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
// 免密打开（指令 4）
// ---------------------------------------------------------------------------
//
// 语义：**不是给库加一把新钥匙，而是把库现有密钥复制一份明文存到库外**
// （`data/auto_login.json`）。所以整个功能**不涉及 `PRAGMA rekey`** ——
// 开关的成本只是写 / 删一个文件。
//
// 三条必须守住的边界：
//   · 开启与关闭**都要求输入密码**。开启是为了防"趁你屏幕还解锁着点两下，
//     就把它变成永久免密入口"；关闭是为了帮用户确认"我还记得密码"——
//     否则关完下次启动就进不去了，而用户完全不知道为什么。
//   · 失败一律计入锁定期，与 `unlock_vault` / `change_password` 同一口径。
//   · 钥匙对不上库时**删掉文件**（留着只会每次启动失败一次），
//     但 IO 类临时故障**保留文件**（不能因一次故障清掉用户的设置）。
//
// ⚠️ 本段三条命令都**不走 `with_vault`**：
//    解锁那条本来就来解锁（此刻必然是 None）；开关那两条的凭证是
//    "用户输入的密码"，密码对才生效，与连接在不在无关。

/// 用免密钥匙解锁。
///
/// 前端在启动时调：`app_status` 里 `auto_login == true` 且未解锁就走这里。
/// 失败意味着钥匙文件已不可用（改过密码没同步上 / 文件被改坏），
/// 那时文件已被清掉，界面应回退到密码解锁并说明原因。
#[tauri::command]
pub fn unlock_with_auto_key(state: State<'_, VaultState>) -> AppResult<AppStatus> {
    let vault = unlock_via_auto_login(state.data_dir())?;

    {
        let mut guard = state
            .vault()
            .lock()
            .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
        *guard = Some(vault);
    }

    // 免密进得来，就算一次成功解锁：清零失败计数。
    // ⚠️ 必须**重新读一遍**再 record_success：save 是整份覆盖写，
    //    拿更早读的副本写回会把中间落盘的东西覆盖掉
    //    （改密码那边正是踩了这个坑，见 crypto::LockoutState::update_hint 的说明）。
    let lock_path = crypto::lockout_path(state.data_dir());
    let mut fresh = crypto::LockoutState::load(&lock_path);
    fresh.record_success(&lock_path)?;

    app_status(state)
}

/// 读钥匙文件并开库。失败路径按"该不该留这个文件"分成两类。
///
/// 为什么必须分类（不能一刀切删或一刀切留）：
///   · 钥匙**已经没用了**（对不上库 / 文件内容坏了）→ 删。
///     留着它只会每次启动都失败一次，而且用户根本不知道该找哪个文件；
///   · **临时故障**（IO 失败、库被别的进程占着）→ 留。
///     一次偶发故障就清掉用户的设置，是把小问题变成"我怎么又要输密码了"。
///
/// 判据是**错误类型**，不是"失败了"这个笼统结论。
///
/// `pub` 是为了让集成测试能直接驱动它 —— 与 `change_password_core` 同一个理由：
/// 这里恰好是最该被测的一段（删文件的分支写错，用户就会每次启动都失败一次）。
pub fn unlock_via_auto_login(data_dir: &Path) -> AppResult<Vault> {
    let path = crypto::auto_login_path(data_dir);

    let al = match crypto::AutoLogin::load(&path) {
        Ok(Some(al)) => al,
        // 文件不在：状态查询与解锁之间被人删了。属于正常竞态，不是错误升级。
        Ok(None) => return Err(AppError::State("免密打开未开启".into())),
        Err(e) => {
            // 内容坏（crypto）→ 删；IO 类 → 保留。见函数文档。
            if matches!(e, AppError::Crypto(_)) {
                let _ = crypto::AutoLogin::clear(&path);
            }
            return Err(e);
        }
    };

    // load 已经校验过长度，这里不会失败；真要失败也按"文件没用"处理。
    let mut key = match al.key() {
        Ok(k) => k,
        Err(e) => {
            let _ = crypto::AutoLogin::clear(&path);
            return Err(e);
        }
    };

    let opened = Vault::unlock_with_key(data_dir, &key);
    // 无论成败，密钥都从内存里清掉 —— 它是库密钥本身。
    crypto::zeroize(&mut key);

    match opened {
        Ok(v) => Ok(v),
        Err(AppError::WrongPin) => {
            // 最典型的原因：改过密码，而钥匙文件没能同步上（或用户手工换过库文件）。
            // 删掉它，让下次启动直接走密码解锁，不必每次都先失败一次。
            let _ = crypto::AutoLogin::clear(&path);
            Err(AppError::State(
                "免密打开已失效，已自动关闭。请用密码解锁 —— 你原来的密码仍然有效。".into(),
            ))
        }
        Err(e) => Err(e),
    }
}

/// 开启免密打开。
#[tauri::command]
pub fn enable_auto_login(state: State<'_, VaultState>, pin: String) -> AppResult<AppStatus> {
    let data_dir = state.data_dir().clone();
    enable_auto_login_core(&data_dir, &pin)?;
    app_status(state)
}

/// 关闭免密打开（仍然要求密码，理由见本段开头的三条边界）。
#[tauri::command]
pub fn disable_auto_login(state: State<'_, VaultState>, pin: String) -> AppResult<AppStatus> {
    let data_dir = state.data_dir().clone();
    disable_auto_login_core(&data_dir, &pin)?;
    app_status(state)
}

/// 开启免密打开的完整流程 —— 可以被测试直接驱动的那部分。
///
/// 顺序不能乱：**先验证密码成功，再写文件**。反过来（先写文件再验证）
/// 会留下"文件在、库却根本打不开"的死状态，而那正好是最坏的一种：
/// 用户以为自己开了免密，重启后走免密失败，还看不出原因。
pub fn enable_auto_login_core(data_dir: &Path, pin: &str) -> AppResult<()> {
    let lock_path = crypto::lockout_path(data_dir);
    let mut lockout = crypto::LockoutState::load(&lock_path);

    // 锁定中直接拒绝，且不消耗尝试次数 —— 与 unlock_vault 同一口径。
    lockout.check_not_locked(&lock_path)?;

    match derive_and_verify(data_dir, pin) {
        Ok(mut key) => {
            let saved = crypto::AutoLogin::new(&key).save(&crypto::auto_login_path(data_dir));
            // 无论写没写成，密钥都不该继续留在内存里。
            crypto::zeroize(&mut key);
            saved?;

            let mut fresh = crypto::LockoutState::load(&lock_path);
            fresh.record_success(&lock_path)?;
            Ok(())
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

/// 关闭免密打开的完整流程。
///
/// 校验通过才删文件：密码都对不上的人，没有资格动这个开关
/// （他可能是坐在电脑前的别人）。
pub fn disable_auto_login_core(data_dir: &Path, pin: &str) -> AppResult<()> {
    let lock_path = crypto::lockout_path(data_dir);
    let mut lockout = crypto::LockoutState::load(&lock_path);

    lockout.check_not_locked(&lock_path)?;

    match derive_and_verify(data_dir, pin) {
        Ok(mut key) => {
            crypto::zeroize(&mut key);
            crypto::AutoLogin::clear(&crypto::auto_login_path(data_dir))?;

            let mut fresh = crypto::LockoutState::load(&lock_path);
            fresh.record_success(&lock_path)?;
            Ok(())
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

// ---------------------------------------------------------------------------
// 修改主密码
// ---------------------------------------------------------------------------

/// 修改主密码的结果。
///
/// 为什么不直接返回 `AppStatus`：改密码**成功之后**还有两件收尾
/// （换提示语、同步免密钥匙文件），而收尾失败时密码其实**已经换掉了**。
/// 用 `Err` 表达会把用户带向"再试一次旧密码"，而真相是旧密码已经作废；
/// 闷着不说又会让人以为一切都好了。所以收尾问题单独走 `warnings`，
/// 由界面如实显示。
#[derive(Debug, Clone, Serialize)]
pub struct ChangePasswordResult {
    /// 改完之后的最新状态（提示语、剩余尝试次数都可能变了）。
    pub status: AppStatus,
    /// 收尾阶段的非致命问题。空 = 全部干净。
    pub warnings: Vec<String>,
}

/// 修改主密码。
///
/// 前端落点：设置页【安全】→「主密码」→「修改」，子表单三格
/// （旧密码 / 新密码 / 确认新密码）+ 一个可选的新提示语。
///
/// ⚠️ 本命令**必须**计入锁定期，否则它会变成一条真实的后门：
///    只校验不计数的话，"改密码"就成了可以无限次试旧密码的入口 ——
///    每次约 0.8 秒，6 位数字共 100 万种，挂着跑一夜就爆破了。
///    所以：锁定中直接拒绝、失败记一次 failure、成功清空计数。
#[tauri::command]
pub fn change_password(
    state: State<'_, VaultState>,
    old_pin: String,
    new_pin: String,
    new_hint: Option<String>,
) -> AppResult<ChangePasswordResult> {
    // 先克隆一份路径：with_vault 的闭包里借不到 state 的其它部分。
    let data_dir = state.data_dir().clone();

    // 整个 rekey 都在 with_vault 持锁期间执行 —— 后台备份线程会被这把锁
    // 自然挡住，而 rekey 恰好要求独占，不需要额外加锁。
    let warnings =
        with_vault(&state, |v| change_password_core(&data_dir, v, &old_pin, &new_pin, new_hint))?;

    // with_vault 的守卫已在上面释放，这里再取一次不会自锁。
    Ok(ChangePasswordResult {
        status: app_status(state)?,
        warnings,
    })
}

/// 改密码的完整流程 —— 可以被测试直接驱动的那部分。
///
/// 为什么不把这段写在命令体里：命令体要 `State`，集成测试拿不到。
/// 而这里恰恰是最该被测的一段 —— 锁定期计数、以及
/// **提示语写回与 record_success 的先后顺序**（顺序错一个新提示语就没了）。
pub fn change_password_core(
    data_dir: &Path,
    vault: &Vault,
    old_pin: &str,
    new_pin: &str,
    new_hint: Option<String>,
) -> AppResult<Vec<String>> {
    let lock_path = crypto::lockout_path(data_dir);
    let mut lockout = crypto::LockoutState::load(&lock_path);

    // 锁定中直接拒绝，且不消耗尝试次数 —— 与 unlock_vault 同一口径。
    lockout.check_not_locked(&lock_path)?;

    let hint = crypto::normalize_hint(new_hint);
    let min_len = lockout.pin_min_len;

    match vault.change_password(old_pin, new_pin, hint, min_len) {
        Ok(warnings) => {
            // ⚠️ 必须**重新读一遍**再 record_success，不能拿上面那份 lockout：
            //    change_password 刚把新提示语写进文件，而 record_success 是
            //    **整份覆盖写** —— 用改密码之前读的旧副本写回，新提示语会被
            //    悄无声息地抹掉（用户下次输错密码，看到的是照着旧密码写的提示）。
            //    这与 initialize_vault 里那句 "let mut fresh = ..." 是同一个道理。
            let mut fresh = crypto::LockoutState::load(&lock_path);
            fresh.record_success(&lock_path)?;

            Ok(post_change_backup(data_dir, vault, warnings))
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

/// 改密码成功后的收尾：立刻备份一份，让最新备份与**新密码**对齐。
///
/// 对齐这件事为什么重要：历史备份全部是旧密码加密的，改密码不会动它们
/// （那正是备份的意义）。所以"最新那一份用新密码"必须由我们主动做出来，
/// 否则用户手里可用的备份全都是旧密码的，而他很可能会忘掉那个旧密码。
///
/// 失败**只记警告、不算改密码失败**：密码此刻已经是新的了，
/// 让"改密码"报错就是骗人。处理口径与后台自动备份一致（记日志、不打断用户）。
fn post_change_backup(data_dir: &Path, vault: &Vault, mut warnings: Vec<String>) -> Vec<String> {
    // 一篇都没写就不备份 —— 与自动备份同一口径，免得备份目录里堆空库。
    // 这里只要"有没有内容"这一个数字，所以用 written_entry_count()，
    // 不必为它去算整份统计（那要走全表日期）。
    match vault.written_entry_count() {
        Ok(0) => return warnings,
        Ok(_) => {}
        Err(e) => {
            warnings.push(format!("改密码后的备份被跳过（{e}）"));
            return warnings;
        }
    }

    let stamp = now_stamp();
    let dest = default_backup_dir(data_dir);
    match vault.run_backup(&dest, &stamp) {
        Ok((result, _deleted)) => {
            // meta 文件必须跟着复制，否则这份备份永远打不开。
            if let Err(e) = copy_crypto_meta(data_dir, &dest.to_string_lossy(), &stamp) {
                warnings.push(format!("改密码后的备份缺少加密元信息（{e}），这一份打不开"));
            } else {
                eprintln!("改密码后已备份: {} ({} 字节)", result.path, result.bytes);
            }
        }
        Err(e) => {
            eprintln!("改密码后的备份失败: {e}");
            warnings.push(format!("改密码后自动备份失败（{e}），建议手动备份一次"));
        }
    }
    warnings
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

/// 统计面板的全部数字，**一条命令取齐**。
///
/// `today`（`YYYY-MM-DD`）由前端传：只有前端知道用户的**本地日期**
/// （Rust 侧只有 UTC，东八区凌晨会被算成前一天）。它只影响"本周 / 本月"，
/// 连续天数不依赖它。详见 `db::Vault::stats`。
#[tauri::command]
pub fn stats(state: State<'_, VaultState>, today: String) -> AppResult<Stats> {
    with_vault(&state, |v| v.stats(&today))
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
// 标签
//
// ⚠️ 这里**只有 5 条命令**，而且都不是"给个 SQL 让前端跑"的形式 ——
//    和其它命令一样，每一条都是一个语义明确的业务动作。
//    标签名能改、能删，但**永远不能**让前端传 SQL 或表名。
// ---------------------------------------------------------------------------

/// 所有标签 + 每个标签的日记篇数（只数"写过"的）。
///
/// 排序在后端定死（按名字、忽略大小写），前端不要再排一次 ——
/// 两处各排一次，迟早出现"下拉框里的顺序和侧栏不一样"。
#[tauri::command]
pub fn list_tags(state: State<'_, VaultState>) -> AppResult<Vec<TagStat>> {
    with_vault(&state, |v| v.list_tags())
}

/// 某天日记的标签名（按名字排序）。那天没有日记 → 空数组。
#[tauri::command]
pub fn tags_of_entry(state: State<'_, VaultState>, date: String) -> AppResult<Vec<String>> {
    with_vault(&state, |v| v.tags_of_entry(&date))
}

/// 整组覆盖某天日记的标签，返回**实际存下来的**标签名。
///
/// ⚠️ 日记必须**已有正文**：标签挂的是 entry_id，而 entry 行是保存正文时
///    产生的（`open_entry` 是纯读取，返回 id = 0）。还没写内容就贴标签，
///    要么得凭空插一条空行（破坏"打开 ≠ 写过"这条铁律），要么写不进去 ——
///    所以后端直接报 validation 错。前端也把标签区置灰，两边都拦。
///
/// 已锁定的日记拒绝改标签（锁定 = 只读，标签也是这篇日记的一部分）。
#[tauri::command]
pub fn set_entry_tags(
    state: State<'_, VaultState>,
    date: String,
    tags: Vec<String>,
) -> AppResult<Vec<String>> {
    with_vault(&state, |v| v.set_entry_tags(&date, &tags))
}

/// 标签改名。新名字已被**别的**标签占用时返回 validation 错误，**不合并**。
/// 返回清洗后的最终名字（前端拿它回显）。
#[tauri::command]
pub fn rename_tag(state: State<'_, VaultState>, id: i64, new_name: String) -> AppResult<String> {
    with_vault(&state, |v| v.rename_tag(id, &new_name))
}

/// 让一个标签"退休"（用户界面上的「删除」）。**已经贴过它的日记，标签会保留。**
///
/// ⚠️ 名字用 retire 而不是 delete 是**故意**的：它并不真删 `tag` 行，
///    只把 `retired` 置 1 —— 于是该标签从"可选列表"（`list_tags`）里消失，
///    而已经贴过它的日记照旧显示它（`tags_of_entry` 不过滤 retired）。
///    叫 delete 会误导后人：`DELETE FROM tag` 会因为 `ON DELETE CASCADE`
///    连坐清掉关联行，把用户的历史改掉 —— 那恰好是用户不要的。
///
/// 返回"有几篇日记挂着它"，供界面说一句实话：
/// "已移除「旅行」——另有 2 篇日记仍保留这个标签"。
#[tauri::command]
pub fn retire_tag(state: State<'_, VaultState>, id: i64) -> AppResult<usize> {
    with_vault(&state, |v| v.retire_tag(id))
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

/// 设置「离开日记时自动锁定」：切日期 / 重开软件时是否把日记自动锁上。
///
/// ⚠️ 与上一条**同名不同义**，别合并：
///   - `set_auto_lock_secs` 锁的是**整个应用**（回解锁页 / 遮蔽页）；
///   - 这一条锁的是**单篇日记**（那天的正文变只读）。
///
/// 这里没有可校验的非法值（参数就是 `bool`），所以整条命令只剩
/// "必须已解锁"这一件事 —— 交给 `with_vault`。
#[tauri::command]
pub fn set_auto_lock_entries(state: State<'_, VaultState>, on: bool) -> AppResult<()> {
    with_vault(&state, |v| v.set_auto_lock_entries(on))
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
    // （只要篇数 → written_entry_count，不必为它算整份统计。）
    if vault.written_entry_count()? == 0 {
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

// ---------------------------------------------------------------------------
// Markdown 导出（P1 #11）
// ---------------------------------------------------------------------------

/// 把整个库导出成 Markdown 文件树（`index.md` + `年/月/日期.md`）。
///
/// `dest_dir` 由前端传。原本的设计是用 `tauri-plugin-dialog` 弹系统目录选择器，
/// 但本机构建环境拉不到那个 crate（出网被拦），所以改成界面上的**路径输入框**
///（预填 `AppStatus::export_default_dir`）。后端只负责"这个目录能不能写"，
/// 不负责"用户想选哪个目录" —— 职责反而更清楚。
///
/// ⚠️ **绝不覆盖已有文件**：重名会在扩展名前加后缀，并把次数回传界面，
///    免得用户以为"导出失败"或"上次导的没了"。
#[tauri::command]
pub fn export_markdown(state: State<'_, VaultState>, dest_dir: String) -> AppResult<ExportResult> {
    with_vault(&state, |v| v.export_markdown(&dest_dir))
}

/// 导出**单篇**日记为 Markdown 文本（不落盘）。给"复制为 Markdown"这类调用方用。
#[tauri::command]
pub fn export_entry_markdown(state: State<'_, VaultState>, date: String) -> AppResult<String> {
    with_vault(&state, |v| v.export_entry_markdown(&date))
}

/// 在系统文件管理器里打开一个目录 —— 导出完成后让用户点一下就能看到产物。
///
/// 为什么用已有的 `tauri-plugin-opener` 而不是新装 dialog 插件：opener 本来
/// 就是这个项目的依赖（`Cargo.toml` 里一直有、`opener:default` 权限也早就
/// 声明了），只是从来没在 `lib.rs` 里注册过 —— 顺手补上注册即可，
/// **不引入任何新依赖**。
///
/// ⚠️ 这个命令**不碰数据、也不需要解锁**（与 `app_status` / `lock_vault` 同类），
///    所以不走 `with_vault`。它只做"打开一个已存在的目录"：先 `is_dir()` 卡一道，
///    非目录直接报错 —— 不给"打开任意文件 / URL"的后门。
#[tauri::command]
pub fn reveal_dir(app: tauri::AppHandle, path: String) -> AppResult<()> {
    let dir = PathBuf::from(path.trim());
    if !dir.is_dir() {
        return Err(AppError::Validation(format!(
            "目录不存在：{}",
            dir.to_string_lossy()
        )));
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::State(format!("打开目录失败: {e}")))
}

// ---------------------------------------------------------------------------
// 图片附件（P1 #10）
// ---------------------------------------------------------------------------

/// 存一张图片附件。
///
/// ⚠️ **这条命令的参数不像别的命令那样走 JSON**：图片字节走 Tauri 的
///    **IPC 原始通道**。前端长这样：
///
///    ```text
///    invoke("save_attachment", uint8Array, { headers: { ... } })
///    ```
///
///    Tauri 的注入脚本（`process-ipc-message-fn.js`）看到 args 是
///    ArrayBuffer / TypedArray / 数组，就把整个 body 当
///    `application/octet-stream` 发过来；**夹在对象里**的 Uint8Array 则会被
///    `Array.from()` 变成"两千万个数字的数组"—— 20 MB 的图会慢到不可用。
///    所以这里必须收 `tauri::ipc::Request`，而不是普通的参数列表。
///
/// ⚠️ 其余三个参数只能走请求头（header 只允许 ASCII，所以**文件名由前端
///    先做 base64**，中文名才不会在头里被拒）。
///
/// 📌 上面的示例只是示意，**用 ```text 围起来**是因为：缩进写在文档注释里
///    会被 rustdoc 当成 Rust 代码去编译，而它不是 Rust —— `cargo test`
///    会因此在 doctest 阶段红掉。
///
/// 不启用 Tauri 的 `asset:` 协议、改成后端读字节的理由见
/// `db::Vault::read_attachment`（数据目录是便携式的，协议作用域写不死）。
#[tauri::command]
pub fn save_attachment(
    state: State<'_, VaultState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<Attachment> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let bytes: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        // 自定义协议走不通时 Tauri 会退化成 postMessage + JSON（整个信封塞在
        // body 里）。这条路传不动大图 —— 直接说清楚，别让人对着"图片坏了"发呆。
        _ => {
            return Err(AppError::State(
                "图片数据没有走原始通道（IPC 退回 JSON 模式了）。重启应用后再试一次".into(),
            ))
        }
    };

    let header = |name: &str| -> AppResult<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| AppError::Validation(format!("缺少请求头 {name}")))
    };

    let date = header("x-diary-date")?;
    let mime = header("x-diary-mime")?;
    let file_name = String::from_utf8(
        STANDARD
            .decode(header("x-diary-name")?.as_bytes())
            .map_err(|_| AppError::Validation("文件名不是合法的 base64".into()))?,
    )
    .map_err(|_| AppError::Validation("文件名不是合法的 UTF-8".into()))?;

    with_vault(&state, |v| {
        v.save_attachment(&date, &file_name, &mime, &bytes)
    })
}

/// 某一天的全部附件（**不含字节**，只有元信息）。编辑器里那块缩略图区用它。
#[tauri::command]
pub fn list_attachments(state: State<'_, VaultState>, date: String) -> AppResult<Vec<Attachment>> {
    with_vault(&state, |v| v.list_attachments(&date))
}

/// 读一张图片的字节。
///
/// 返回 `tauri::ipc::Response`：响应体的 content-type 是
/// `application/octet-stream`，前端那边落地成一个 **ArrayBuffer**
///（见 tauri 的 `ipc-protocol.js`：默认分支就是 `response.arrayBuffer()`），
/// 再用它造 Blob URL —— 全程不经过 base64，也不会把二进制塞进 JSON。
///
/// `mime` 不回在这里：`list_attachments` 已经给过前端每个附件的 mime，
/// 前端就是拿着它来调这条命令的。
#[tauri::command]
pub fn read_attachment(state: State<'_, VaultState>, id: i64) -> AppResult<tauri::ipc::Response> {
    let (_mime, bytes) = with_vault(&state, |v| v.read_attachment(id))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 删一张图片：删记录，并在没有别的记录引用同一份文件时把文件也删掉。
#[tauri::command]
pub fn delete_attachment(state: State<'_, VaultState>, id: i64) -> AppResult<()> {
    with_vault(&state, |v| v.delete_attachment(id))
}

/// 清理图片缓存（设置页【数据与备份】里的按钮）。
///
/// 两个方向：清掉"有记录没文件"的死记录、清掉"有文件没人认领"的孤儿。
/// 详细口径见 `db::Vault::prune_orphan_attachments`。
#[tauri::command]
pub fn prune_orphan_attachments(state: State<'_, VaultState>) -> AppResult<PruneReport> {
    with_vault(&state, |v| v.prune_orphan_attachments())
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
