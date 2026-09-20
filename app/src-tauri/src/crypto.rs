//! 加密与密码策略。
//!
//! 这是整个项目风险最高的模块：**出错会导致用户的日记永久打不开**，
//! 或者让加密形同虚设。所以每个决定都写明理由。
//!
//! 三条铁律（改动本文件前请先读完）：
//!
//! 1. **密钥只在 Rust 侧存在**，永不通过 Tauri command 返回给前端。
//!    前端只负责把用户输入的 PIN 字符串传进来。
//!
//! 2. **KDF 参数必须持久化，不能硬编码**。如果将来调整参数（适配更慢的机器、
//!    或提高安全强度），硬编码会让老用户的 PIN 派生出不同的密钥，
//!    结果是"密码明明是对的，却打不开自己的日记"。这是本模块最容易犯的错。
//!
//! 3. **不存第二份密码校验值**。SQLCipher 自己会验证密钥：密钥不对时，
//!    `PRAGMA key` 之后的第一次查询就会失败（实测报
//!    `hmac check failed for pgno=1`）。多存一份哈希等于多给攻击者一个
//!    离线爆破目标，而且还得自己维护两者的一致性。

use crate::error::{AppError, AppResult};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 派生出的密钥长度。32 字节 = 256 位，正是 SQLCipher 期望的密钥长度。
pub const KEY_LEN: usize = 32;

/// salt 长度。salt 不是秘密，但必须每次安装都不同，否则预计算攻击可行。
pub const SALT_LEN: usize = 16;

/// 密码最大尝试次数，超过则进入锁定期。
pub const MAX_FAILED_ATTEMPTS: u32 = 5;

/// 锁定时长。
pub const LOCKOUT_DURATION: Duration = Duration::from_secs(10 * 60);

/// 第几次失败后显示提示信息。
pub const HINT_AFTER_ATTEMPTS: u32 = 2;

/// 默认最小密码长度。6 位数字按用户要求，但长度可配置。
pub const DEFAULT_PIN_MIN_LEN: usize = 6;

// ---------------------------------------------------------------------------
// KDF 参数
// ---------------------------------------------------------------------------

/// Argon2id 参数。随数据库持久化，解锁时按存储的值派生。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    /// 内存开销，单位 KiB。这是抵抗离线爆破的主要成本。
    pub m_cost: u32,
    /// 迭代轮数。
    pub t_cost: u32,
    /// 并行度。
    pub p_cost: u32,
}

impl Default for KdfParams {
    /// 默认值来自本机实测（见 docs/probe-findings.md）：
    /// 512 MiB / 3 轮 / 1 并行 = 792 ms，落在 500~1000 ms 的理想区间。
    ///
    /// 之所以要自适应校准而不是写死：512 MiB 对 4GB 内存的老机器可能分配失败。
    fn default() -> Self {
        Self {
            m_cost: 512 * 1024, // 512 MiB
            t_cost: 3,
            p_cost: 1,
        }
    }
}

impl KdfParams {
    fn to_argon2(&self) -> AppResult<Argon2<'static>> {
        let params = Params::new(self.m_cost, self.t_cost, self.p_cost, Some(KEY_LEN))
            .map_err(|e| AppError::Crypto(format!("Argon2 参数非法: {e}")))?;
        Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
    }
}

/// 派生耗时目标区间。低于下限说明参数太弱（爆破成本低），
/// 高于上限说明用户解锁要干等太久。
const KDF_TARGET_MIN_MS: u128 = 500;
const KDF_TARGET_MAX_MS: u128 = 1000;
/// 自适应校准的内存上限，避免在低配机器上分配失败。
const KDF_CALIBRATE_MAX_MIB: u32 = 512;
/// 内存下限。低于这个值安全性没有意义。
const KDF_CALIBRATE_MIN_MIB: u32 = 64;

/// 在**本机**实测校准 KDF 参数，使单次派生耗时落入目标区间。
///
/// 为什么必须校准：同一份程序在 32 核新机器和 4GB 老笔记本上，
/// 512 MiB 的派生耗时和分配成功率完全不同。写死参数总有一端不合适。
///
/// 校准结果必须写入数据库，解锁时读出来用 —— 这也是 `KdfParams` 需要
/// 持久化的原因。
///
/// 测试中断言参数时可用环境变量跳过校准：
///   `DSH_DIARY_SKIP_KDF_CALIBRATION=1` -> 直接用 `KdfParams::default()`
///
/// 健壮性要求（这是本函数存在的第二个理由）：
///   校准本身**绝不能让初始化失败**。低配机器上任何一档分配失败，
///   都应该继续尝试更小的档；全部失败才回退到最小可用参数。
///   如果这里 panic 或返回错误，用户就永远建不了日记。
pub fn calibrate_kdf_params(salt: &[u8; SALT_LEN], sample_pin: &[u8]) -> KdfParams {
    // 环境变量显式跳过：让测试能断言确定的参数。
    if std::env::var("DSH_DIARY_SKIP_KDF_CALIBRATION").is_ok() {
        return KdfParams::default();
    }

    // 逐档尝试。注意每一档都会真正跑一次派生，所以总共约 0.1+0.2+0.4+0.8 秒。
    // 这比"猜一次就定"慢，但换来的是任何一档失败都能优雅降级。
    for mib in [64u32, 128, 256, KDF_CALIBRATE_MAX_MIB] {
        let candidate = KdfParams {
            m_cost: mib * 1024,
            t_cost: 3,
            p_cost: 1,
        };

        let Ok(argon) = candidate.to_argon2() else {
            continue; // 这一档参数非法，试下一档
        };

        let mut probe = [0u8; KEY_LEN];
        let started = Instant::now();
        let ok = argon.hash_password_into(sample_pin, salt, &mut probe).is_ok();
        let elapsed = started.elapsed().as_millis();
        zeroize(&mut probe);

        if !ok {
            continue; // 内存分配失败，试更小的一档
        }

        // 耗时进入目标区间 -> 就用这一档
        if elapsed >= KDF_TARGET_MIN_MS {
            return candidate;
        }
        // 已经超过上限说明这台机器偏慢，再往上加只会让解锁更难受。
        // 停在当前档位。这一条是重构时曾漏掉的判断，测试没覆盖到，
        // 但编译器的 unused 警告把它暴露了出来。
        if elapsed > KDF_TARGET_MAX_MS {
            return candidate;
        }
        // 还没到区间但已到内存上限 -> 只能用这一档了
        if mib >= KDF_CALIBRATE_MAX_MIB {
            return candidate;
        }
        // 否则继续放大
    }

    // 所有档位都失败（极端低配或异常环境）。
    // 回退到最小可用参数，而不是报错 —— 宁可安全性弱一点，
    // 也要让用户能建起自己的日记。这个取舍在此明确写下。
    KdfParams {
        m_cost: KDF_CALIBRATE_MIN_MIB * 1024,
        t_cost: 3,
        p_cost: 1,
    }
}

/// 用指定参数从 PIN 派生数据库密钥。
///
/// `pin` 以字节切片传入而不是 `String`：调用方应尽快丢弃原始字符串，
/// 减少它停留在内存里的时间。
pub fn derive_key(
    pin: &[u8],
    salt: &[u8; SALT_LEN],
    params: &KdfParams,
) -> AppResult<[u8; KEY_LEN]> {
    let argon = params.to_argon2()?;
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(pin, salt, &mut key)
        .map_err(|e| AppError::Crypto(format!("密钥派生失败: {e}")))?;
    Ok(key)
}

/// 生成随机 salt。
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    rand::rng().fill_bytes(&mut salt);
    salt
}

/// 尽力清零内存中的密钥材料。
///
/// 用 `write_volatile` 而不是普通的赋值：普通赋值可能被编译器判定为
/// "写入后从未读取"而优化掉，导致密钥残留在内存里。
pub fn zeroize(buf: &mut [u8]) {
    use std::ptr;
    for b in buf.iter_mut() {
        // SAFETY: b 是指向有效可写内存的裸指针，写入 u8 是良定义的。
        unsafe { ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// PIN 校验
// ---------------------------------------------------------------------------

/// 校验 PIN 格式。要求：纯数字、长度在 [min_len, 32] 之间。
///
/// 为什么允许上限 32：用户要求 6 位数字，但把长度做成可配置，
/// 将来想改成长密码时不必改动加密层。
pub fn validate_pin(pin: &str, min_len: usize) -> AppResult<()> {
    if !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidPin("密码只能包含数字".into()));
    }
    let len = pin.chars().count();
    if len < min_len {
        return Err(AppError::InvalidPin(format!("密码至少需要 {min_len} 位数字")));
    }
    if len > 32 {
        return Err(AppError::InvalidPin("密码最长 32 位".into()));
    }
    Ok(())
}

/// 提示语的统一清洗：去首尾空白、空串视为"没有"、最多 60 字。
///
/// 为什么必须只有一处：**初始化**与**改密码**都要写这个值。
/// 两处各写一份，迟早一处截 60 字、另一处不截 —— 而它会被渲染在锁屏界面，
/// 超长提示会把排版挤坏，而且用户看到的两条路径行为不一致。
///
/// 为什么限制 60 字：提示是**明文存储**且在解锁前就要显示。
/// 放开长度等于给用户一个"把密码本身写进去"的机会，
/// 那这个功能就从"提示"变成"泄漏"了。
pub fn normalize_hint(hint: Option<String>) -> Option<String> {
    hint.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t.chars().take(60).collect::<String>())
        }
    })
}

// ---------------------------------------------------------------------------
// 锁定期状态
// ---------------------------------------------------------------------------

/// 锁定期状态。
///
/// ⚠️ **这个结构必须存在加密数据库之外的文件里**，因为：
///   用户解锁之前就要读取它（显示"还剩几次机会"、锁定倒计时），
///   而那时数据库还没解锁，根本无法查询。
///
/// ⚠️ 由此带来的两个必须让用户知道的事实：
///
///   1. **提示信息是明文可读的**（它在锁屏界面就要显示）。所以提示必须写得
///      模糊（"和你常用的数字有关"），不能写成能直接推出密码的内容。
///
///   2. **锁定期只挡得住"在应用界面里试"，挡不住离线爆破**。攻击者拿到
///      数据库文件后，可以在应用之外用脚本无限次尝试，完全不经过这里的
///      任何逻辑。6 位数字只有 100 万种组合，真正的防线是 Argon2id 的
///      高内存开销（每个候选都要付 512 MB 内存 + 约 0.8 秒）。
///
///      这不是缺陷，是"方便"换来的取舍，但必须如实告知用户。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockoutState {
    /// 当前连续失败次数。
    #[serde(default)]
    pub failed_attempts: u32,
    /// 锁定截止时间（Unix 秒）。None 表示未锁定。
    #[serde(default)]
    pub locked_until: Option<u64>,
    /// 用户自己写的提示。明文存储，见上文说明。
    #[serde(default)]
    pub hint: Option<String>,
    /// 是否已经初始化过密码。
    #[serde(default)]
    pub initialized: bool,
    /// 最小 PIN 长度（可配置）。
    #[serde(default = "default_pin_min_len")]
    pub pin_min_len: usize,
}

fn default_pin_min_len() -> usize {
    DEFAULT_PIN_MIN_LEN
}

impl Default for LockoutState {
    fn default() -> Self {
        Self {
            failed_attempts: 0,
            locked_until: None,
            hint: None,
            initialized: false,
            pin_min_len: DEFAULT_PIN_MIN_LEN,
        }
    }
}

/// 当前 Unix 时间戳（秒）。
fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl LockoutState {
    /// 从文件读取。文件不存在或损坏时返回默认值（fail-open 到"未初始化"）。
    ///
    /// 注意这里的取舍：文件损坏会让锁定状态丢失，攻击者可以通过删掉这个
    /// 文件来重置尝试次数。这是**有意接受**的 —— 因为该文件本来就在用户
    /// 可写目录里，防不住能操作文件系统的人。锁定期的作用是防止"有人坐在
    /// 你电脑前反复猜"，而不是防本地攻击者。
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    /// 写回文件。用"临时文件 + 原子改名"避免写到一半崩溃导致文件损坏。
    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::State(format!("序列化锁定状态失败: {e}")))?;

        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// 剩余锁定秒数。0 表示当前未锁定。
    pub fn remaining_lock_secs(&self) -> u64 {
        match self.locked_until {
            Some(until) => until.saturating_sub(now_unix()),
            None => 0,
        }
    }

    /// 检查当前是否处于锁定期。若锁定已过期，顺手清理状态。
    pub fn check_not_locked(&mut self, path: &Path) -> AppResult<()> {
        let remaining = self.remaining_lock_secs();
        if remaining > 0 {
            return Err(AppError::Locked {
                remaining_secs: remaining,
            });
        }
        // 锁定刚过期：清零失败次数，避免用户一进来又只剩 1 次机会。
        if self.locked_until.is_some() {
            self.locked_until = None;
            self.failed_attempts = 0;
            self.save(path)?;
        }
        Ok(())
    }

    /// 记录一次失败。达到上限则进入锁定期。
    ///
    /// 返回 true 表示本次失败后已触发锁定。
    pub fn record_failure(&mut self, path: &Path) -> AppResult<bool> {
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        let locked = if self.failed_attempts >= MAX_FAILED_ATTEMPTS {
            self.locked_until = Some(now_unix() + LOCKOUT_DURATION.as_secs());
            true
        } else {
            false
        };
        self.save(path)?;
        Ok(locked)
    }

    /// 成功解锁，清零失败计数。
    pub fn record_success(&mut self, path: &Path) -> AppResult<()> {
        self.failed_attempts = 0;
        self.locked_until = None;
        self.save(path)?;
        Ok(())
    }

    /// **只**改提示语并写回，完全不动失败计数与锁定状态。
    ///
    /// ⚠️ 必须自己重新从文件读一遍再改，不能让调用方把内存里的状态传进来：
    ///    `save` 是整份覆盖写，而调用方手里那份往往是"更早"读的。
    ///    直接写回会把中间落盘的东西覆盖掉。
    ///
    ///    改密码流程恰好踩这个坑：命令层在开头读了一份 lockout 用于查锁定期，
    ///    改密码过程中提示语被换新，最后 record_success 用那份旧副本整份写回，
    ///    新提示语就被抹掉了 —— 用户第二次输错时会看到照着**旧密码**写的提示。
    ///    所以"重新读"封死在函数内部，不给调用方犯错的机会。
    pub fn update_hint(path: &Path, hint: Option<String>) -> AppResult<()> {
        let mut st = Self::load(path);
        st.hint = hint;
        st.save(path)
    }

    /// 是否应该显示提示。
    pub fn should_show_hint(&self) -> bool {
        self.hint.is_some() && self.failed_attempts >= HINT_AFTER_ATTEMPTS
    }

    /// 剩余尝试次数（未锁定时）。
    pub fn remaining_attempts(&self) -> u32 {
        MAX_FAILED_ATTEMPTS.saturating_sub(self.failed_attempts)
    }
}

/// 锁定状态文件的路径。与数据库同目录。
pub fn lockout_path(data_dir: &Path) -> PathBuf {
    data_dir.join("lockout.json")
}

// ---------------------------------------------------------------------------
// 免密打开：钥匙文件（库外明文）
// ---------------------------------------------------------------------------
//
// ⚠️ 本文件由**指令 4（免密打开）**引入。指令 4 尚未实施，所以现在这个文件
//    在真实数据目录里根本不存在 —— 下面的函数在"文件不存在"时直接返回，
//    这正是设计要求的路径（见函数文档）。

/// 免密打开用的钥匙文件路径。
///
/// 库里存的是"由 PIN 派生的 32 字节密钥"的十六进制，不是 PIN 本身。
/// 它必须放在**加密库之外**：要在解锁之前就用它把库打开，
/// 放进库里会形成"要开库得先开库"的循环。
pub fn auto_login_path(data_dir: &Path) -> PathBuf {
    data_dir.join("auto_login.json")
}

/// 把免密钥匙文件里的 `key_hex` 换成新密钥。返回 `true` 表示确实改写了文件。
///
/// **什么时候必须调**：改主密码之后。漏了这一步，用户改完密码重启会发现
/// 免密失效 —— 而他刚做的是"改密码"，看起来与免密毫无关系，
/// 除了"这软件坏了"想不出第二个解释。
///
/// **什么时候必须什么都不做**：文件不存在就返回，**绝不顺手创建**。
/// 创建一个就等于替用户把"免密打开"给打开了，这是越过用户意愿的动作。
///
/// 写法是读原文、只改一个键、再写回，而不是序列化一个全新结构：
/// 将来指令 4 往这个文件里加字段时，这里不会把那些字段冲掉。
///
/// ⚠️ 调用顺序必须是【先 rekey 成功、再调本函数】。
///    中途失败时文件里还是旧钥匙：免密虽会失败，但用**新密码**能进，
///    且指令 4 的回退逻辑会把免密关掉，不会把人卡在门外。
///    反过来先写文件再 rekey，就可能出现"文件是新钥匙、库还是旧钥匙"的死局。
pub fn sync_auto_login_key(data_dir: &Path, key: &[u8; KEY_LEN]) -> AppResult<bool> {
    let path = auto_login_path(data_dir);
    if !path.exists() {
        return Ok(false);
    }

    let text = std::fs::read_to_string(&path)?;
    let mut doc: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| AppError::Crypto(format!("免密钥匙文件损坏，无法解析: {e}")))?;
    let Some(obj) = doc.as_object_mut() else {
        return Err(AppError::Crypto(
            "免密钥匙文件格式异常（顶层不是 JSON 对象）".into(),
        ));
    };
    obj.insert("key_hex".into(), serde_json::Value::String(hex_encode(key)));

    write_json_atomic(&path, &doc)?;
    Ok(true)
}

/// "临时文件 + 原子改名"写一个 JSON 文件。
///
/// 与 `LockoutState::save` / `CryptoMeta::save` 是同一套手法：直接覆盖写，
/// 写到一半断电就会留下一个残缺文件。这些文件残了都会导致用户进不去或丢设置。
fn write_json_atomic(path: &Path, value: &serde_json::Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::State(format!("序列化 JSON 失败: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// salt 与 KDF 参数的存放路径。
///
/// 为什么单独放文件而不是存在数据库里：**必须先有 KDF 参数才能派生密钥，
/// 才能打开数据库**。把它们放进数据库会形成循环依赖：打不开库 -> 读不到参数
/// -> 派生不出密钥 -> 打不开库。
///
/// 所以 salt 与 KDF 参数必须放在加密库之外。salt 不是秘密，明文存储即可；
/// KDF 参数也不敏感，但**必须与创建时一致**，否则密码正确也解不开。
pub fn crypto_meta_path(data_dir: &Path) -> PathBuf {
    data_dir.join("crypto_meta.json")
}

/// 随库持久化的加密元信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CryptoMeta {
    /// KDF 算法标识，为将来更换算法留出空间。
    pub kdf: String,
    /// salt 的十六进制表示。
    pub salt_hex: String,
    /// KDF 参数。解锁时按这里存储的值派生，绝不用默认值硬编码。
    pub params: KdfParams,
}

impl CryptoMeta {
    pub fn new(salt: &[u8; SALT_LEN], params: KdfParams) -> Self {
        Self {
            kdf: "argon2id".into(),
            salt_hex: hex_encode(salt),
            params,
        }
    }

    pub fn salt(&self) -> AppResult<[u8; SALT_LEN]> {
        let bytes = hex_decode(&self.salt_hex)?;
        if bytes.len() != SALT_LEN {
            return Err(AppError::Crypto(format!(
                "salt 长度异常：期望 {SALT_LEN} 字节，实际 {}",
                bytes.len()
            )));
        }
        let mut out = [0u8; SALT_LEN];
        out.copy_from_slice(&bytes);
        Ok(out)
    }

    pub fn load(path: &Path) -> AppResult<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(path)?;
        let meta: Self = serde_json::from_str(&text)
            .map_err(|e| AppError::Crypto(format!("加密元信息损坏，无法解析: {e}")))?;
        Ok(Some(meta))
    }

    pub fn save(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::State(format!("序列化加密元信息失败: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> AppResult<Vec<u8>> {
    if s.len() % 2 != 0 {
        return Err(AppError::Crypto("十六进制字符串长度为奇数".into()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&s[i..i + 2], 16)
                .map_err(|e| AppError::Crypto(format!("十六进制解析失败: {e}")))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_validation_enforces_digits_and_length() {
        assert!(validate_pin("123456", 6).is_ok());
        assert!(validate_pin("12345678", 6).is_ok());
        assert!(validate_pin("12345", 6).is_err());
        assert!(validate_pin("12345a", 6).is_err());
        assert!(validate_pin("", 6).is_err());
    }

    #[test]
    fn same_pin_and_salt_derive_same_key() {
        let salt = [7u8; SALT_LEN];
        // 用小参数让测试跑得快；真实参数见 KdfParams::default
        let params = KdfParams {
            m_cost: 64,
            t_cost: 1,
            p_cost: 1,
        };
        let a = derive_key(b"135790", &salt, &params).unwrap();
        let b = derive_key(b"135790", &salt, &params).unwrap();
        assert_eq!(a, b, "相同 PIN 与 salt 必须派生出相同密钥，否则用户无法解锁");
    }

    #[test]
    fn different_pin_derives_different_key() {
        let salt = [7u8; SALT_LEN];
        let params = KdfParams {
            m_cost: 64,
            t_cost: 1,
            p_cost: 1,
        };
        let a = derive_key(b"135790", &salt, &params).unwrap();
        let b = derive_key(b"135791", &salt, &params).unwrap();
        assert_ne!(a, b, "不同 PIN 必须派生出不同密钥");
    }

    #[test]
    fn different_salt_derives_different_key() {
        let params = KdfParams {
            m_cost: 64,
            t_cost: 1,
            p_cost: 1,
        };
        let a = derive_key(b"135790", &[1u8; SALT_LEN], &params).unwrap();
        let b = derive_key(b"135790", &[2u8; SALT_LEN], &params).unwrap();
        assert_ne!(a, b, "salt 不同则密钥必须不同，否则预计算攻击可行");
    }

    #[test]
    fn lockout_triggers_after_max_attempts() {
        let dir = std::env::temp_dir().join("dsh-diary-test-lockout");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = lockout_path(&dir);

        let mut st = LockoutState::default();
        for i in 1..MAX_FAILED_ATTEMPTS {
            let locked = st.record_failure(&path).unwrap();
            assert!(!locked, "第 {i} 次失败不应触发锁定");
        }
        let locked = st.record_failure(&path).unwrap();
        assert!(locked, "第 {MAX_FAILED_ATTEMPTS} 次失败必须触发锁定");

        // 锁定状态必须能被重新读出来 —— 否则重启应用即可绕过。
        let reloaded = LockoutState::load(&path);
        assert!(reloaded.remaining_lock_secs() > 0, "锁定状态必须持久化");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hint_only_after_two_failures() {
        let mut st = LockoutState {
            hint: Some("和你常用的数字有关".into()),
            ..Default::default()
        };
        assert!(!st.should_show_hint(), "零次失败不应显示提示");
        st.failed_attempts = 1;
        assert!(!st.should_show_hint(), "一次失败不应显示提示");
        st.failed_attempts = HINT_AFTER_ATTEMPTS;
        assert!(st.should_show_hint(), "达到阈值后应显示提示");
    }

    #[test]
    fn crypto_meta_roundtrip_preserves_params() {
        let dir = std::env::temp_dir().join("dsh-diary-test-meta");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = crypto_meta_path(&dir);

        let salt = generate_salt();
        let params = KdfParams {
            m_cost: 1234,
            t_cost: 4,
            p_cost: 2,
        };
        CryptoMeta::new(&salt, params.clone()).save(&path).unwrap();

        let loaded = CryptoMeta::load(&path).unwrap().expect("元信息应存在");
        assert_eq!(loaded.salt().unwrap(), salt);
        // 这一条是关键：参数必须原样还原，否则老用户解不开库。
        assert_eq!(loaded.params.m_cost, params.m_cost);
        assert_eq!(loaded.params.t_cost, params.t_cost);
        assert_eq!(loaded.params.p_cost, params.p_cost);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn calibration_returns_usable_params_and_never_fails() {
        // 校准的**健壮性**是本测试的重点：它绝不能让初始化失败。
        // 无论机器多弱，都必须返回一组能实际派生出密钥的参数。
        //
        // 注意：这里不碰 DSH_DIARY_SKIP_KDF_CALIBRATION 环境变量 ——
        // 改进程环境变量会影响并行运行的其他测试，是测试污染的经典来源。
        let salt = generate_salt();
        let params = calibrate_kdf_params(&salt, b"135790");

        // 必须落在合理区间内
        assert!(
            params.m_cost >= KDF_CALIBRATE_MIN_MIB * 1024,
            "内存开销不应低于下限，实际 {} KiB",
            params.m_cost
        );
        assert!(
            params.m_cost <= KDF_CALIBRATE_MAX_MIB * 1024,
            "内存开销不应高于上限，实际 {} KiB",
            params.m_cost
        );
        assert_eq!(params.t_cost, 3);
        assert_eq!(params.p_cost, 1);

        // 最关键的一条：返回的参数必须真的能派生出密钥。
        // 如果这一步失败，用户就永远建不了日记 —— 本测试就是防这个。
        let key = derive_key(b"135790", &salt, &params)
            .expect("校准出的参数必须能实际派生密钥");
        assert_eq!(key.len(), KEY_LEN);
    }

    #[test]
    fn default_params_are_within_calibration_bounds() {
        // 默认值必须落在校准的上限内，否则低配机器上"跳过校准"这条路径
        // 会分配失败。
        let d = KdfParams::default();
        assert!(
            d.m_cost <= KDF_CALIBRATE_MAX_MIB * 1024,
            "默认 m_cost 不应超过校准上限"
        );
        assert!(d.m_cost >= KDF_CALIBRATE_MIN_MIB * 1024);
    }
}
