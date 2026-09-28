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

use crate::crypto::{self, CryptoMeta, KdfParams, KEY_LEN};
use crate::db::{
    count_written_entries_readonly, derive_and_verify, non_conflicting_path, parse_backup_stamp,
    prune_backups, AppSettings, Attachment, BackupResult, CloseAction, DayMood, Entry,
    EntrySummary, ExportResult, FilterResult, IntegrityReport, PruneReport, Recap, ReminderMode,
    SearchHit, Stats, TagStat, Vault,
};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
// `Manager` 是 `get_webview_window()` 的来源（`present_reminder` 要用它）；
// `State` 是命令参数的来源。两个都得在作用域里。
use tauri::{Manager, State};

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
    /// 「后悔药」目录（`<数据目录>/backups/pre-restore/`）。
    ///
    /// 每次恢复备份前，软件会把**当前这份库**连 meta 一起快照到这里
    /// （见 `restore_core` 的第 ② 步）。恢复确认弹窗要把它**原样写出来**
    /// 并给一个「打开文件夹」—— 那是用户按下"替换"之前最后一件想知道的事。
    ///
    /// 和 `export_default_dir` 同一个理由放在这里：目录规则住在后端，
    /// 前端再拼一份就成了两处各算各的。它同样只是一段路径文本。
    pub pre_restore_dir: String,
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
    /// 托盘图标到底建起来没有（【P2-21】）。
    ///
    /// ⚠️ 为什么需要它：如果托盘**没建起来**（图标缺失、或系统不让建）而
    ///    关闭行为还是「最小化到托盘」—— 用户点 `✕`，窗口消失，
    ///    **托盘上没有图标可点**，他就**再也回不来了**（只能开任务管理器）。
    ///    ⇒ 托盘不可用时，关闭行为**一律按"直接退出"执行**。
    ///
    /// ⚠️ 为什么住在这里、而不是 `db.rs`：数据层**不认识托盘**
    ///    （它连 `tauri` 都不该依赖）。"托盘可不可用"是**进程级事实**，
    ///    判定点收在 `commands.rs` 的 `close_action_now()` 一处。
    ///
    /// 默认 `false`：**先假设没有托盘**。启动过程中（`setup` 建托盘之前）
    /// 任何一次读取都会得到"直接退出"—— 这是保守方向：
    /// 最坏是"该进托盘的时候退出了"，而不是"退不掉的窗口"。
    tray_ok: AtomicBool,
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
                tray_ok: AtomicBool::new(false),
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

    /// 托盘图标是否建起来了。见 `tray_ok` 字段的说明。
    pub fn tray_ok(&self) -> bool {
        self.inner.tray_ok.load(Ordering::Relaxed)
    }

    /// 建托盘成功之后由 `lib.rs` 的 `setup` 调一次。
    ///
    /// ⚠️ 只允许置位成 `true`（没有反方向的调用）：托盘在进程生命周期里
    ///    只会建一次。真出现"托盘后来没了"（Explorer 崩了重开之类），
    ///    那是系统层的事，靠 `SetProcessDefaultLayout` 那套也救不回来 ——
    ///    不在本件的范围内。
    pub fn set_tray_ok(&self) {
        self.inner.tray_ok.store(true, Ordering::Relaxed);
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

/// ⭐ **不走 `with_vault` 的例外清单**（改代码前先看这张表）。
///
/// 绝大多数命令都必须走 `with_vault` —— 它把"未解锁就拒绝"这件事收在一处，
/// 免得某条命令漏判、被绕过前端直接调用时读到了数据。**例外必须逐条有理由**，
/// 而且理由永远是下面三类之一：
///
/// | 命令 | 为什么可以不持锁 |
/// |---|---|
/// | `app_status` | 它要回答的正是"现在锁着没有"，未解锁是它的正常输入 |
/// | `estimate_kdf_ms` | 纯常量：报一个 KDF 参数，不碰库 |
/// | `initialize_vault` | 此刻库**本来**就不存在，不存在"已解锁"这回事 |
/// | `unlock_vault` | 它就是来解锁的，持锁判断在它内部自己做 |
/// | `lock_vault` | 它就是来上锁的，且必须能把连接置成 `None` |
/// | `unlock_with_auto_key` / `enable_auto_login` / `disable_auto_login` | 三条的凭证是**用户输入的密码**（或库外的钥匙文件），与连接在不在无关 |
/// | `list_backups` / `crypto_info` / `reveal_dir` | 只读**库外文件**或打开一个目录，不碰日记内容 |
/// | `inspect_backup` / `restore_backup` / `copy_backups_to` | 见下面「备份恢复」那一段的说明 |
/// | `quit_app`（【P2-21】） | 它就是"退出进程"，一字节数据都不读。**而且它恰恰必须在"读不到库"时也能用**：点 `✕` 的收尾路径上，库可能已经锁了、或设置读坏了 —— 那时若要求"先解锁"，软件就**关不掉了** |
/// | `present_reminder`（【P2-13】） | 它连 `state` 参数都没有，只是把窗口叫到前台。⚠️ 提醒响的那一刻库**完全可能锁着**（"锁着照常提醒"是定过的行为）—— 它要是要求先解锁，提醒就永远响不了 |
///
/// ⚠️ 新增例外时，**同时**把它加进这张表 —— 否则下一个人只能靠通读代码
///    来判断"这条为什么不持锁"，而最省事的猜测永远是"忘了写"。
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
        pre_restore_dir: default_backup_dir(state.data_dir())
            .join("pre-restore")
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

/// 「回顾」那一屏的数据（P2-23）—— 之最 ＋ 所有写过的日子。
///
/// ⚠️ **单独一条命令，不并进 `stats`**：那条已经装着 8 个数字（热力图还要往里
/// 加），再塞就成杂物间了。而且这条**只在前端点开「旧影」时才算**，
/// 不是开机白算 —— 混进 `stats` 会让它每次都白跑三遍全表扫描。
///
/// `today` 由前端传（同 `stats`），本命令只用它做格式校验；
/// 真正跟"今天"有关的「往年今天」由前端用同一条纯函数判定（见 `db::Vault::recap`）。
#[tauri::command]
pub fn recap(state: State<'_, VaultState>, today: String) -> AppResult<Recap> {
    with_vault(&state, |v| v.recap(&today))
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
// 筛选（P2-7）
// ---------------------------------------------------------------------------

/// 按 **标签 / 心情 / 时间** 捞日记。**纯读**，永远不写库。
///
/// 参数全部"空＝不限"：
///   * `tags`   标签 id（**不是名字** —— 名字能改，id 不会）
///   * `moods`  1~5；不在这个范围的会被忽略
///   * `from` / `to`  `'YYYY-MM-DD'`，含两端，只给一个也能用
///   * `recent_first` 缺省 `true`＝最近优先；`false`＝最早优先
///   * `limit`  缺省 200，`clamp(1, 500)`
///
/// ⚠️ 一律走 `with_vault` ⇒ 没解锁时统一被拒，这里一行都不用写。
/// ⚠️ **持锁期间绝不能再调一次 `with_vault`**（自死锁，本项目踩过）。
#[tauri::command]
pub fn filter_entries(
    state: State<'_, VaultState>,
    tags: Vec<i64>,
    moods: Vec<i64>,
    from: Option<String>,
    to: Option<String>,
    recent_first: Option<bool>,
    limit: Option<i64>,
) -> AppResult<FilterResult> {
    with_vault(&state, |v| {
        v.filter_entries(
            &tags,
            &moods,
            from.as_deref(),
            to.as_deref(),
            recent_first.unwrap_or(true),
            limit,
        )
    })
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

/// 设置「三击左键快速解锁」：日记锁定时，在正文里连点三下左键是否直接解锁。
///
/// ⚠️ 这是一个**手势开关**，不改变任何锁定的语义：
///   - 关掉它只是关掉这个手势，手动 🔒 / 🔓 按钮照旧好用；
///   - 它**不会**解锁已经锁上的日记，也不会替用户锁上任何一篇。
///
/// 与上一条同理，没有可校验的非法值（参数就是 `bool`），
/// 整条命令只剩"必须已解锁"这一件事 —— 交给 `with_vault`。
#[tauri::command]
pub fn set_triple_click_unlock(state: State<'_, VaultState>, on: bool) -> AppResult<()> {
    with_vault(&state, |v| v.set_triple_click_unlock(on))
}

// ---------------------------------------------------------------------------
// 写作提醒与开机自启（【P2-13】）
// ---------------------------------------------------------------------------

/// 打开 / 关掉写作提醒。
///
/// ⚠️ **不要在这里顺手写 `close_action`**：关闭行为的默认值要"跟提醒走"，
///    那条推导在 `db::close_action()` 里**现算**（见那里的说明）。
///    一旦把结果写进库，"用户从没设置过"这个状态就永远回不来了 ——
///    用户之后再开/关提醒，关闭行为**再也不会跟着变**，
///    而"跟着变"正是【P2-21】定下的行为。
///
/// ⚠️ 提醒是**纯前端在跑**的（只有前端知道本地日期）：这条命令只管存开关，
///    定时器、判断"今天写过没有"、横幅，全在 `App.vue`。
#[tauri::command]
pub fn set_reminder_enabled(state: State<'_, VaultState>, on: bool) -> AppResult<()> {
    with_vault(&state, |v| v.set_reminder_enabled(on))
}

/// 写提醒时间。**返回洗净后的值**（`"9:5"` ⇒ `"09:05"`）。
///
/// ⚠️ 前端要拿返回值**回填那个输入框** —— 这是"用户输了个怪东西"唯一的
///    可见反馈：它**不报错**（任何输入都能得出一个合法结果），只会被修正。
#[tauri::command]
pub fn set_reminder_time(state: State<'_, VaultState>, time: String) -> AppResult<String> {
    with_vault(&state, |v| v.set_reminder_time(&time))
}

/// 写提醒的重复策略（`daily` / `on_open` / `never`）。
/// 参数是枚举 ⇒ 非法值在类型上进不来，没有白名单要校验。
#[tauri::command]
pub fn set_reminder_mode(state: State<'_, VaultState>, mode: ReminderMode) -> AppResult<()> {
    with_vault(&state, |v| v.set_reminder_mode(mode))
}

/// 记下"今天已经响过提醒了"。
///
/// ⚠️ **只能在真的提醒过之后调**：这一格是 `daily` 档"一天一次"那个承诺的
///    凭据，提前写下去会让当天**再也不响**（比多响一次糟得多）。
/// ⚠️ 日期由**前端给**：只有前端知道本地日期（东八区凌晨 0~8 点会被
///    UTC 算成前一天，见 `db::stats` 的说明）。
#[tauri::command]
pub fn set_reminder_last_fired(state: State<'_, VaultState>, date: String) -> AppResult<()> {
    with_vault(&state, |v| v.set_reminder_last_fired(&date))
}

/// 把主窗口叫到前台 ＋ 闪任务栏。**提醒真的响了那一刻**调它。
///
/// ⚠️ 为什么放在 Rust 侧：前端也能 show / focus，但"抢前台"在 Windows 上
///    经常被系统拦掉（焦点根本不给你）—— 那时要退成**闪任务栏**，
///    而这一下只有 Rust 侧的 `request_user_attention` 做得到。
///
/// ⚠️ 返回 `()` 不是 `Result`：这条路径上**没有该报的错**。
///    窗口找不到就算了（横幅已经挂上，用户照样看得见）；
///    在这里抛错只会让"提醒响了"这件事半途而废。
///
/// ⚠️ 与 `quit_app` 同理**不走 `with_vault`**：它一字节数据都不读。
///    （提醒响的那一刻库完全可能是锁着的 —— "锁着照常提醒"是定过的行为。）
#[tauri::command]
pub fn present_reminder(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        // 三句与托盘菜单的「显示主窗口」**同序同义**：显示 → 取消最小化 → 聚焦。
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        // 抢不到前台时的退路：闪任务栏，用户至少知道"有事发生"。
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
}

/// 打开 / 关掉「开机自启」。
///
/// ⚠️ 它做**两件事**，顺序有讲究：
///    1. **先写注册表**（系统真正认的是那一份）；
///    2. 成了再写库（"用户的意图"，设置页显示它）。
///    反过来的话，注册表写失败而库里已经记着"开着" ⇒
///    设置页显示开着、开机却起不来，而用户完全查不出原因。
///
/// ⚠️ 注册表写失败**必须报上去**：这是用户亲手点的开关，
///    "点了没反应"是最不能接受的结果。此时库里那个值保持原样。
#[tauri::command]
pub fn set_auto_start(state: State<'_, VaultState>, on: bool) -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::State(format!("无法确定程序位置：{e}")))?;
    crate::set_auto_start_impl(&exe, on)?;
    with_vault(&state, |v| v.set_auto_start(on))
}

/// 写「每日字数目标」（【P2-12】）。**返回洗净后的值**。
///
/// ⚠️ 前端要拿返回值**回填那个数字框**（与 `set_reminder_time` 同一理由）：
///    这一项**不报错**（留空 / 负数 / 原文 / 超上限都能得出一个合法结果），
///    只会被修正 —— 不回填的话，用户看到的和真正存下去的就**不是同一个数**。
/// ⚠️ `0` ＝ 不用这个功能（编辑器底部那一句随之消失）。
/// ⚠️ 参数是 `String` 而不是数字：界面上那个框是**文本**，用户会清空它、
///    会粘进一串奇怪的东西 ⇒ "留空"这个状态必须能传进来。
#[tauri::command]
pub fn set_daily_word_goal(state: State<'_, VaultState>, goal: String) -> AppResult<u32> {
    with_vault(&state, |v| v.set_daily_word_goal(&goal))
}

/// 把注册表里的自启路径校正成**当前这个 exe**（幂等，已经对了就什么都不做）。
///
/// 为什么需要它：注册表里记的是**一个绝对路径**。软件换了位置
/// （换目录 / 重新发布到别处）之后那个路径就指向了旧文件，
/// 症状是"自启明明开着，开机却什么都没发生" —— 而这条线索**极难自查**
/// （注册表不是用户会去看的地方）。
///
/// ⚠️ 方向由**库里的用户意图**决定（`auto_start == false` ⇒ 什么都不做）。
///    少了这一层，"从别处的 exe 启动一次"就会把用户的自启悄悄改到那个路径上 ——
///    那是在他背后改设置，比不校正更坏。
///
/// ⚠️ 未解锁时**读不到意图 ⇒ 不校正**。这是刻意接受的：
///    宁可不做，也不凭猜测去改注册表。
///
/// 调用点：前端 `loadSettings()` 之后（＝每次解锁之后）。
#[tauri::command]
pub fn sync_auto_start(state: State<'_, VaultState>) -> AppResult<()> {
    let wanted = with_vault(&state, |v| v.auto_start())?;
    if !wanted {
        return Ok(());
    }
    let exe = std::env::current_exe()
        .map_err(|e| AppError::State(format!("无法确定程序位置：{e}")))?;
    crate::set_auto_start_impl(&exe, true)
}

// ---------------------------------------------------------------------------
// 关闭行为与托盘（【P2-21】）
// ---------------------------------------------------------------------------

/// ⭐ 关闭行为的**唯一判定点**：叠上"托盘到底可不可用"。
///
/// 规则只有一句：**托盘用不了 ⇒ 一律「直接退出」**。
///
/// 为什么非要有这一条：关闭行为是「最小化到托盘」而托盘**没建起来**时，
/// 用户点 `✕` ⇒ 窗口消失、托盘上没有图标 ⇒ **他再也回不来了**，
/// 只能开任务管理器结束进程。宁可关得掉，也绝不能出现"点 ✕ 就失联"。
///
/// ⚠️ 判定收在这里一处，`get_close_action` 命令与"点 ✕"那条路径
///    （`close_action_now`）**共用它** —— 抄第二份的后果是
///    "设置页显示「直接退出」，实际却进了托盘"（或反过来），
///    而用户永远不知道该信哪个。
fn apply_tray_availability(state: &VaultState, action: CloseAction) -> CloseAction {
    if state.tray_ok() {
        action
    } else {
        CloseAction::Quit
    }
}

/// 点窗口 `✕` 那一刻该做什么。**给 `lib.rs` 的 `on_window_event` 用**。
///
/// ⚠️ 它**刻意不返回 `Result`**：这条路径上任何失败都必须变成"能执行的结论"。
///    读设置失败（未解锁 / 库损坏 / 外部工具写坏）一律按 `Quit` ——
///    宁可关得掉，也不能"点了 ✕ 什么都没发生"。
///
/// ⚠️ 内部只 `with_vault` **一次**，而且**没有**在持有那把锁的时候
///    再调一次 `with_vault`（那会自死锁）。
pub(crate) fn close_action_now(state: &State<'_, VaultState>) -> CloseAction {
    let stored = with_vault(state, |v| v.close_action()).unwrap_or(CloseAction::Quit);
    apply_tray_availability(state.inner(), stored)
}

/// 读"点 `✕` 时做什么"（生效值）。
///
/// ⚠️ 与 `get_settings()` 里那个 `close_action` 字段**不是两条规则**：
///    推导（"没设过 ⇒ 跟提醒走"）只有 `db::close_action()` 一份，
///    这里只是在它上面再叠一层"托盘可不可用"（`apply_tray_availability`）。
///
/// 走 `with_vault`：设置住在加密库里，未解锁读不到 —— 读不到就该说
/// "先解锁"，而不是编一个值出来（与 `get_settings` 同一理由）。
#[tauri::command]
pub fn get_close_action(state: State<'_, VaultState>) -> AppResult<CloseAction> {
    let stored = with_vault(&state, |v| v.close_action())?;
    Ok(apply_tray_availability(state.inner(), stored))
}

/// 写"点 `✕` 时做什么"。
///
/// ⚠️ 存的是**用户的选择**，不叠加托盘可用性 —— 系统这会儿没有托盘，
///    不代表用户的选择是错的（换个环境就有了）。真正生效与否
///    由读取路径判定（`apply_tray_availability`）。
#[tauri::command]
pub fn set_close_action(state: State<'_, VaultState>, action: CloseAction) -> AppResult<()> {
    with_vault(&state, |v| v.set_close_action(action))
}

/// 退出整个应用（【P2-21】）。
///
/// ⚠️ **必须是前端在 flush 完之后调它**：正文是 1 秒防抖保存的，
///    点 `✕` 那一瞬间最后打的字可能还没落库（`lib.rs` 里那条
///    `app-quit-requested` 就是为这件事发的）。
///    这条命令本身只负责"真的退"，不负责落库。
///
/// ⚠️ **不走 `with_vault`**：它一字节数据都不读，而且它恰恰必须在
///    "读不到库"时也能用 —— 否则"库锁着的时候关不掉软件"。
///    理由已记进上面那张例外清单。
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
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

/// 当前 Unix 秒（UTC）。
///
/// 单独抽出来是为了让"挑一个没被占用的备份戳"能拿到**秒的整数**、
/// 自己 +1 秒往后试；`now_stamp()` 只负责把它格式化。
pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 当前时间戳，格式 `YYYYMMDD-HHMMSS`（UTC）。
pub fn now_stamp() -> String {
    format_unix_compact(now_secs())
}

/// 从 `base_secs` 起，在 `dir` 里挑一个**还没被占用**的备份时间戳。
///
/// ⚠️ **为什么非要自己挑名字**（⛔ 别把这段当成多余的防御性代码删掉）：
///    `backup_to()` 内部走 `VACUUM INTO`，而它要求目标文件**不存在** ⇒
///    `backup_to()` **会先 `remove_file` 掉同名文件**（见 `db.rs` 里那一段注释）。
///    两次备份若落在**同一秒**，第二份就会把第一份**顶掉**；万一被顶掉的正是
///    "这次要恢复的那一份"（从后悔药恢复、而那份后悔药恰好是这一秒生成的），
///    恢复就变成**一次空操作** —— 界面报「恢复成功」，日记却一个字节没变。
///
/// ✅ 换出来的名字**仍然是合法的 `YYYYMMDD-HHMMSS`** ⇒ 下游四条（备份列表排序、
///    旧备份清理、`.db` ＋ `.meta.json` 配对、列表 UI）**一条都不用改**。
/// ⭐ 名字没被占用时**原样返回** ⇒ 日常行为一个字节都不变。
///
/// 上限 `MAX_BACKUP_STAMP_TRIES`（＝1 小时）：不是可配参数，也不写成可能死循环的
/// `loop` —— 走到上限说明环境已不正常，要报一句人话错误，而不是空转。
pub fn free_backup_stamp(dir: &Path, base_secs: u64) -> AppResult<String> {
    const MAX_BACKUP_STAMP_TRIES: u64 = 3600;
    for offset in 0..MAX_BACKUP_STAMP_TRIES {
        let stamp = format_unix_compact(base_secs + offset);
        // 只看 `.db` 就够：`.db` 与 `.meta.json` 永远用同一个戳成组出现、且 `.db` 先写。
        // 万一只存在半组（历史遗留），换个名字重来反而更安全。
        if !dir.join(format!("diary-{stamp}.db")).exists() {
            return Ok(stamp);
        }
    }
    Err(AppError::State(format!(
        "备份目录里连续 {MAX_BACKUP_STAMP_TRIES} 秒的时间戳都被占用了，\
         没法给这次备份挑一个安全的文件名：{}",
        dir.to_string_lossy()
    )))
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
        let name = path.to_string_lossy().to_string();
        // 时间**优先从文件名解析**（P2-5 统一口径，与 `inspect_backup` 一致）：
        // 备份一定会被拷来拷去，一拷 mtime 就变成"拷回来的那一刻"，
        // 而文件名里的时间戳不变。mtime 只作兜底 —— 用户手工改过名时还能排个序。
        let created_at = parse_backup_stamp(&name)
            .or_else(|| {
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
            })
            .unwrap_or(0);
        out.push(BackupResult {
            path: name,
            bytes: meta.len(),
            created_at,
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

// ---------------------------------------------------------------------------
// 备份恢复（P2-5）
// ---------------------------------------------------------------------------
//
// 这是全项目**唯一会覆盖整库**的一组操作，所以写法比别处更保守：
//   · 任何一步失败都不留"半成品" —— 宁可维持原状，也不给一个半新半旧的库；
//   · 先用同目录的临时文件把两份产物备齐，最后才**原子换名**（不是往 diary.db 上盖）；
//   · 换库之前一定先留一份"后悔药"（`backups/pre-restore/`）。
//
// ⚠️ 这三条命令**都不走 `with_vault`**（见上面那张例外清单）：
//    · `inspect_backup` —— "换电脑"那个场景里界面停在「创建密码」，根本没有密码，
//      它必须能在未解锁时也给出信息，而它本身是纯只读的；
//    · `restore_backup` —— 它**自己操作那把锁**，中途还要把连接置成 `None`。
//      交给 `with_vault` 会当场自死锁（持锁期间再取同一把锁）；
//    · `copy_backups_to` —— 搬的是**密文文件**，与库里的内容无关。

/// 一份备份的体检报告（`inspect_backup` 的返回）。
#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub db_path: String,
    /// 配对的可选 meta 文件（`<同 stem>.meta.json`）。
    pub meta_path: String,
    /// 配对的 meta 在不在。**false ＝ 这份备份永远打不开**。
    ///
    /// 理由：meta 里存着 salt 与 KDF 参数，缺了它**即使密码完全正确**
    /// 也派生不出密钥。所以"缺 meta"不是警告级别的问题，是死刑。
    pub meta_found: bool,
    pub bytes: u64,
    /// 备份时间（Unix 秒）。优先从**文件名**解析，解析不出才用 mtime 兜底。
    pub created_at: u64,
    /// 备份里的篇数。`None` ＝ 读不出来（**绝不编一个数**）。
    pub entry_count: Option<usize>,
    /// 用当前这把钥匙能不能打开它。
    pub openable_now: bool,
    /// ⭐ 此刻**手里有没有**可用的钥匙去做上面那两个判断。
    ///
    /// 为什么必须单独给这个字段：`entry_count = None` 有两种完全不同的原因 ——
    /// ① 手里根本没有钥匙（免密没开、库也锁着）；② 有钥匙，但打不开这份备份。
    /// 前者是"我们不知道"，后者是"它不是用你现在的密码加密的"。
    /// 界面上必须分开说，否则用户会以为自己密码记错了。
    pub key_available: bool,
}

/// 备份主文件配对的 meta 文件路径：**同 stem 换后缀**。
///
/// 这个配对规则是备份的立身之本（`run_backup` 造 `.db`、`copy_crypto_meta`
/// 造 `.meta.json`），检查、恢复、后悔药三处都靠它 —— 所以只写这一份。
fn paired_meta_path(db_path: &Path) -> PathBuf {
    let stem = db_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    db_path.with_file_name(format!("{stem}.meta.json"))
}

/// 取"当前这把钥匙"，用来试开备份。**用完必须 `crypto::zeroize` 掉。**
///
/// 两个来源，优先级从高到低：
///   1. **已解锁的连接** —— 它就是"当前密码对应的那把"，最准；
///   2. **库外的免密钥匙文件**（`data/auto_login.json`）—— 库锁着时也读得到，
///      内容同样是"上一次解锁成功的那把钥匙"。
/// 都没有 ⇒ `None`（免密没开、库也锁着）。
///
/// ⚠️ 它读的是**内存里已有的钥匙**或**库外文件**，从不向用户索要密码 ——
///    恢复流程里不该多出一次"再输一遍密码"，那正是本功能要消灭的麻烦。
fn current_session_key(state: &VaultState) -> Option<[u8; KEY_LEN]> {
    if let Ok(guard) = state.vault().lock() {
        if let Some(v) = guard.as_ref() {
            return Some(*v.session_key());
        }
    }
    match crypto::AutoLogin::load(&crypto::auto_login_path(state.data_dir())) {
        Ok(Some(al)) => al.key().ok(),
        _ => None,
    }
}

/// 把一份备诉说清楚 —— **纯只读，一个字节都不写**。
///
/// 前端在用户按下"恢复"之前调它，把确认弹窗里那几行填上。
///
/// ⚠️ 「纯只读」是硬要求（坑 12）：一旦"先看一眼"变成有副作用的操作，
///    用户就不敢看了 —— 而这个弹窗的全部意义正是让他**敢看**。
///    它只用到 `metadata()` 和一个 `SQLITE_OPEN_READ_ONLY` 连接。
#[tauri::command]
pub fn inspect_backup(state: State<'_, VaultState>, db_path: String) -> AppResult<BackupInfo> {
    let path = PathBuf::from(db_path.trim());
    let meta = paired_meta_path(&path);

    let fm = std::fs::metadata(&path).map_err(|_| {
        AppError::Validation(format!("找不到这个文件：{}", path.to_string_lossy()))
    })?;
    if !fm.is_file() {
        return Err(AppError::Validation(format!(
            "这不是一个文件：{}",
            path.to_string_lossy()
        )));
    }

    let name = path.to_string_lossy().to_string();
    // 与 `list_backups` 同一个口径：文件名优先，mtime 兜底。
    let created_at = parse_backup_stamp(&name)
        .or_else(|| {
            fm.modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
        })
        .unwrap_or(0);

    let meta_found = meta.is_file();
    let mut key = current_session_key(&state);
    let key_available = key.is_some();

    // meta 不在 ⇒ 已经能确定它开不了，不必再费一次解密（那一下并不便宜）。
    let (entry_count, openable_now) = match (key.as_ref(), meta_found) {
        (Some(k), true) => match count_written_entries_readonly(&path, k) {
            Ok(n) => (Some(n as usize), true),
            // 打得开库却读不出篇数（例如备份来自更老的版本、表结构不同）——
            // 一律按"读不出"处理，**不猜、不估**。
            Err(_) => (None, false),
        },
        _ => (None, false),
    };

    if let Some(k) = key.as_mut() {
        crypto::zeroize(k);
    }

    Ok(BackupInfo {
        db_path: name,
        meta_path: meta.to_string_lossy().to_string(),
        meta_found,
        bytes: fm.len(),
        created_at,
        entry_count,
        openable_now,
        key_available,
    })
}

/// 「后悔药」目录最多留几份。
///
/// 为什么必须有上限：每次恢复都留一份整库快照，反复试几次就会攒出一堆副本。
/// 5 份足够覆盖真实场景 ——"试了几次都不满意、想退回最开始那样"。
///
/// ⚠️ 清理复用**同一条**保留策略（`db::prune_backups`），它会连配对的
///    `.meta.json` 一起删。单独删 `.db` 会留下一个永远打不开的孤儿 meta。
pub const PRE_RESTORE_KEEP: usize = 5;

/// 恢复的核心流程 —— **不依赖 Tauri 状态**，集成测试可以直接驱动它。
///
/// `slot` 就是"当前已解锁连接"那个槽位（与 `VaultState` 里是同一个 `Mutex`）。
/// 第 ④ 步会把它置成 `None`，试开成功后再填回去 ——
/// 所以调用方在整个过程中**必须一直持有那把锁**：否则别的命令会在
/// "库文件正被替换"的中间插进来读写，读到什么全看运气。
///
/// 七步，顺序就是设计：
///   ① 校验（一个字节都不动）→ ② 留后悔药 → ③ 备好临时文件 →
///   ④ 关连接 → ⑤ 清 WAL 残留 → ⑥ 原子换名 → ⑦ 试开、按结果收尾
///
/// ⚠️ 与最初的设计（"先关连接、再复制"）有一处**故意的不同**，理由是那条
///    "绝不允许半成品"的禁令：原写法里，复制第二个文件（meta）失败会留下
///    "库换了、meta 没换"的死状态 —— 那个库**谁也打不开**。
///    改成"先备好两份临时文件、最后原子换名"之后，复制阶段出问题主库纹丝未动，
///    而 rename 是同目录内的原子操作，中间几乎不存在失败窗口。
pub fn restore_core(
    data_dir: &Path,
    src_db: &Path,
    slot: &mut Option<Vault>,
    key: Option<&[u8; KEY_LEN]>,
) -> AppResult<()> {
    let src_meta = paired_meta_path(src_db);
    let live_db = data_dir.join("diary.db");
    let live_meta = crypto::crypto_meta_path(data_dir);

    // ── ① 校验：任何一条不过都在这里结束，一个字节都没动 ──
    if !src_db.is_file() {
        return Err(AppError::Validation(format!(
            "找不到备份文件：{}",
            src_db.to_string_lossy()
        )));
    }
    if src_db == live_db {
        return Err(AppError::Validation(
            "这就是当前正在用的日记库 —— 从这里恢复等于让软件覆盖自己。请选 backups 目录里的那一份。"
                .into(),
        ));
    }
    if !src_meta.is_file() {
        return Err(AppError::Validation(format!(
            "缺少配对的 {}。备份永远是「.db ＋ .meta.json」两个文件一组，\
             少一个就永久打不开（缺它即使密码完全正确也派生不出密钥）。",
            src_meta
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        )));
    }
    if std::fs::metadata(src_db)?.len() == 0 {
        return Err(AppError::Validation(
            "这个备份文件是空的，恢复它只会得到一片空白".into(),
        ));
    }

    // ── ② 后悔药（仅已解锁时；未初始化时没有东西可保）──
    if let Some(v) = slot.as_ref() {
        let pre = default_backup_dir(data_dir).join("pre-restore");
        std::fs::create_dir_all(&pre)?;
        // ⚠️ 名字必须**自己挑**，不能用 `now_stamp()` 直接拼：
        //    `backup_to()` 会先删掉同名文件，而这一次要留的"后悔药"有可能
        //    正是上一秒刚生成的那一份（用户从后悔药恢复）。两次操作落进同一秒，
        //    它就会被自己删掉 ⇒ 恢复变成空操作（界面报成功、日记没变）。
        //    见 `free_backup_stamp` 的注释。
        let stamp = free_backup_stamp(&pre, now_secs())?;
        // 复用现成的备份实现（`backup_to` 内部走 VACUUM INTO），**不新写一套**。
        v.backup_to(&pre.join(format!("diary-{stamp}.db")))?;
        // ⚠️ 当时的 crypto_meta.json 必须一起留：只留 .db 的后悔药同样打不开。
        std::fs::copy(&live_meta, pre.join(format!("diary-{stamp}.meta.json")))?;
        let _ = prune_backups(&pre, PRE_RESTORE_KEEP);
    }

    // ── ③ 备好临时文件（此刻主库还被连接用着，什么都还没换）──
    let tmp_db = data_dir.join("diary.db.restoring");
    let tmp_meta = data_dir.join("crypto_meta.json.restoring");
    let prep = std::fs::copy(src_db, &tmp_db).and_then(|_| std::fs::copy(&src_meta, &tmp_meta));
    if let Err(e) = prep {
        let _ = std::fs::remove_file(&tmp_db);
        let _ = std::fs::remove_file(&tmp_meta);
        return Err(AppError::State(format!(
            "准备替换文件失败：{e}。当前日记没有任何改动。"
        )));
    }

    // ── ④ 关连接：Windows 上文件被占用就换不了名 ──
    *slot = None;

    // ── ⑤ 清 WAL 残留：它们属于**旧库**，留在同名新库旁边会被当成新库的一部分 ──
    for suffix in ["diary.db-wal", "diary.db-shm"] {
        let p = data_dir.join(suffix);
        if p.exists() {
            if let Err(e) = std::fs::remove_file(&p) {
                let _ = std::fs::remove_file(&tmp_db);
                let _ = std::fs::remove_file(&tmp_meta);
                return Err(AppError::State(format!(
                    "清理 {} 失败：{e}。日记没有被改动，请先关掉可能正在占用它的程序再重试。",
                    p.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default()
                )));
            }
        }
    }

    // ── ⑥ 原子换名（同目录内 rename：不存在"复制到一半"的中间态）──
    if let Err(e) = std::fs::rename(&tmp_db, &live_db) {
        let _ = std::fs::remove_file(&tmp_db);
        let _ = std::fs::remove_file(&tmp_meta);
        return Err(AppError::State(format!(
            "替换日记库失败：{e}。日记没有被改动。"
        )));
    }
    if let Err(e) = std::fs::rename(&tmp_meta, &live_meta) {
        // 几乎不可能失败（同目录、同文件系统），真发生了也要说清楚
        // "库已经换好了、元信息没换"，并把补救办法一并给出。
        return Err(AppError::State(format!(
            "日记库已换成备份里的那份，但加密元信息替换失败：{e}。\
             元信息暂时留在 {} —— 请再恢复一次这份备份。",
            tmp_meta.to_string_lossy()
        )));
    }

    // ── ⑦ 试开一次：能开就装回去继续用；开不了就扔掉那把已经配不上的钥匙 ──
    if let Some(k) = key {
        match Vault::unlock_with_key(data_dir, k) {
            Ok(v) => *slot = Some(v),
            Err(_) => {
                // 多半是"这份备份当时用的是另一个密码"。
                // 免密钥匙此刻已经对不上这个库，留着只会让下次启动白失败一次。
                let _ = crypto::AutoLogin::clear(&crypto::auto_login_path(data_dir));
            }
        }
    }
    Ok(())
}

/// 用一份备份**替换**当前整个库，返回恢复后的应用状态。
///
/// 那七步都在 `restore_core` 里；这里只做"接线"：
///   取钥匙 → 持锁 → 调核心 → 放锁 → 擦掉内存里的钥匙副本 → 回一份新状态。
///
/// ⚠️ 全程**只取一次** `vault()` 锁，并一直持有到核心流程结束。
///    持锁期间**绝不能**再调 `with_vault`（同一把锁，当场自死锁）。
///    最后回状态那句必须在 `drop(guard)` **之后** —— `app_status` 自己也要取这把锁。
///
/// ⚠️ 不需要为后台自动备份线程做任何事：它每 5 分钟醒一次、醒来先要这把锁，
///    自然会被挡在门外。**别为它再加第二把锁** —— 那只会多一个死锁的机会。
#[tauri::command]
pub fn restore_backup(state: State<'_, VaultState>, db_path: String) -> AppResult<AppStatus> {
    let data_dir = state.data_dir().clone();
    let src = PathBuf::from(db_path.trim());

    // 取钥匙必须在**丢掉旧连接之前** —— 之后就只能靠库外那把了。
    let mut guard = state
        .vault()
        .lock()
        .map_err(|_| AppError::State("内部状态锁已损坏".into()))?;
    let mut key = guard
        .as_ref()
        .map(|v| *v.session_key())
        .or_else(|| {
            crypto::AutoLogin::load(&crypto::auto_login_path(&data_dir))
                .ok()
                .flatten()
                .and_then(|al| al.key().ok())
        });

    let outcome = restore_core(&data_dir, &src, &mut guard, key.as_ref());

    // 锁必须在这里立刻放开：`app_status` 与后续任何命令都要用它。
    drop(guard);
    if let Some(k) = key.as_mut() {
        crypto::zeroize(k);
    }
    outcome?;

    app_status(state)
}

/// 「复制备份到…」的结果。
#[derive(Debug, Clone, Serialize)]
pub struct CopyBackupsResult {
    pub copied: usize,
    pub bytes: u64,
    /// 实际写入的目标目录（已规范化，便于界面如实回显"到底写到哪了"）。
    pub dest_dir: String,
}

/// 把整个 `backups/` 目录复制到别处（含 `pre-restore/`）。
///
/// 为什么需要它：备份目录躺在**数据目录里面**（`default_backup_dir`），
/// 也就是说备份和日记在**同一块硬盘**上 —— 这只能防手滑，防不了硬盘坏掉、
/// 系统重装、误格盘。而用户自己手动复制必然踩两个坑：
/// 漏掉 `pre-restore/`、以及把目标里已有的备份覆盖掉。
///
/// 三条硬规矩：
///   · **绝不覆盖**目标里已有的文件 —— 重名加 ` (1)` / ` (2)` 后缀
///     （复用导出那套 `non_conflicting_path`：同一口径只留一份实现）；
///   · **绝不删源** —— 这是"复制"，不是"搬家"；
///   · 目标**不许落在数据目录内部** —— 那等于搬到了自己家里。
///
/// ⚠️ 不需要解锁（搬的是密文文件），所以不走 `with_vault`。
#[tauri::command]
pub fn copy_backups_to(
    state: State<'_, VaultState>,
    dest_dir: String,
) -> AppResult<CopyBackupsResult> {
    let data_dir = state.data_dir().clone();
    let src = default_backup_dir(&data_dir);
    if !src.is_dir() {
        return Err(AppError::Validation(
            "还没有任何备份 —— 先在【数据与备份】里点一次「立即备份」".into(),
        ));
    }

    let dest_input = PathBuf::from(dest_dir.trim());
    if dest_input.as_os_str().is_empty() {
        return Err(AppError::Validation("请填一个目标目录".into()));
    }
    std::fs::create_dir_all(&dest_input)?;
    if !dest_input.is_dir() {
        return Err(AppError::Validation(format!(
            "目标路径不是一个目录：{}",
            dest_input.to_string_lossy()
        )));
    }

    // 规范化之后才比得了"在不在数据目录里面"（路径里可能有 `..` 或符号链接）。
    let canon_dest = std::fs::canonicalize(&dest_input)?;
    let canon_data = std::fs::canonicalize(&data_dir).unwrap_or_else(|_| data_dir.clone());
    if canon_dest.starts_with(&canon_data) {
        return Err(AppError::Validation(
            "目标目录不能放在数据目录里面 —— 那样并没有搬到别处，硬盘一坏还是一起没。".into(),
        ));
    }

    let mut copied = 0usize;
    let mut bytes = 0u64;
    copy_tree(&src, &canon_dest.join("backups"), &mut copied, &mut bytes)?;

    Ok(CopyBackupsResult {
        copied,
        bytes,
        dest_dir: canon_dest.to_string_lossy().to_string(),
    })
}

/// 递归复制一棵目录树，**绝不覆盖**同名文件。
///
/// 只处理普通文件与目录：符号链接会被跳过（`DirEntry::file_type()` 返回的是
/// 链接本身的类型，不跟随）—— 跟着链接走可能绕进一个巨大的目录，
/// 甚至绕回自己造成无限递归。
///
/// `pub` 是为了让集成测试能直接驱动它 —— 与 `unlock_via_auto_login` /
/// `change_password_core` 同一个理由：这一段的"绝不覆盖"如果写错，
/// 用户的目标目录里会悄无声息地少掉旧备份。
pub fn copy_tree(src: &Path, dest: &Path, copied: &mut usize, bytes: &mut u64) -> AppResult<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dest.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &to, copied, bytes)?;
        } else if ty.is_file() {
            let final_to = non_conflicting_path(&to)?;
            std::fs::copy(entry.path(), &final_to)?;
            *copied += 1;
            *bytes += std::fs::metadata(&final_to).map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(())
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
