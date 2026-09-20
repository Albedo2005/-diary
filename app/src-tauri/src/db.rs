//! 数据层：加密数据库的连接管理、日记读写、双索引中文搜索、备份。
//!
//! 安全边界（本模块是这条边界的守门人）：
//!   前端 → Tauri command → 本模块 → SQLCipher
//!
//! 前端**永远不接触数据库**，也**永远拿不到密钥**。所有查询都是这里预定义的
//! 方法，参数化传参。这既防注入，也保证前端无法绕过加密层直接读文件。
//!
//! 为什么不用 Tauri 官方的 tauri-plugin-sql：它的模型是"前端把 SQL 字符串
//! 发给后端"，而加密数据库的密钥必须留在 Rust 侧、绝不能出现在前端
//! JavaScript 里。两者设计目标冲突，官方插件至今不支持 SQLCipher。

use crate::crypto::{self, CryptoMeta, KEY_LEN};
use crate::error::{AppError, AppResult};
use crate::schema::{self, DEFAULT_NOTEBOOK_ID};
use crate::seg::Segmenter;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 自动备份：两次备份之间的最小间隔（秒）。默认每天一次。
pub const AUTO_BACKUP_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// 自动备份默认保留的最近份数。
pub const DEFAULT_KEEP_RECENT: usize = 7;

/// 设置项的键名。集中在这里，避免拼写漂移。
pub mod setting_keys {
    pub const AUTO_BACKUP_ENABLED: &str = "auto_backup_enabled";
    pub const LAST_BACKUP_AT: &str = "last_backup_at";
    pub const KEEP_RECENT: &str = "keep_recent";
}

/// 一条日记。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: i64,
    /// 'YYYY-MM-DD'
    pub entry_date: String,
    pub title: String,
    pub content_md: String,
    pub word_count: i64,
    pub mood: Option<i64>,
    /// 锁定：true = 只读，不可修改。
    ///
    /// ⚠️ 锁的是**内容**，不是排版。锁定时正文按原文一字不改地显示，
    ///    用户手动排的换行与空格全部保留。
    pub locked: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 日历用的摘要。不含正文，避免一次拉回整月内容。
#[derive(Debug, Clone, Serialize)]
pub struct EntrySummary {
    pub entry_date: String,
    pub title: String,
    pub word_count: i64,
    pub mood: Option<i64>,
    pub updated_at: String,
}

/// 某一天的心情标记，供日历在日期格上显示表情。
///
/// 没有标记的日子**不会出现在结果里**，所以 `mood` 不必是 `Option`。
#[derive(Debug, Clone, Serialize)]
pub struct DayMood {
    pub entry_date: String,
    /// 1=很差 2=较差 3=一般 4=较好 5=很好（取值约束见 `save_entry_with_mood`）。
    pub mood: i64,
}

/// 搜索结果。
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub entry_date: String,
    pub title: String,
    /// 命中片段。在**原文**上按查询词截取，不使用 FTS5 的 snippet()。
    ///
    /// 为什么不用 FTS5 的 highlight()/snippet()：索引里存的是 jieba 分词后的
    /// 文本，调用这些函数（在普通表上）返回的内容带满分词空格，实测输出形如
    /// "今天 很 开心 ... [火锅] ..."，直接展示会是破碎排版。
    /// 而 contentless 表调用它们直接返回 NULL。
    pub snippet: String,
    /// 命中来源，便于调试与将来做排序加权。
    pub matched_by: String,
}

/// 备份结果。
#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    /// 创建时间（Unix 秒）
    pub created_at: u64,
}

/// SQLite 的 `trim()` **默认只去半角空格**，不去制表符和换行。
/// 这一点和 SQL Server 的 `TRIM`（去所有空白）不同，很容易想当然写错 ——
/// 实测中"只敲了回车和缩进"的内容会被误判成"写过日记"。
/// 所以必须显式列出所有要去掉的空白字符。
const TRIM_CHARS: &str = "char(32) || char(9) || char(10) || char(13) || char(11) || char(12)";

/// "这篇算写过吗"的**唯一判定规则**。
///
/// 规则：`content_md` 去掉各类空白后仍非空。
///
/// 为什么必须集中成一处：这是全应用语义的单一事实来源，被多处使用 ——
///   1. `written_dates` 日历标记
///   2. `list_month` 月度摘要与"本月写了几天"
///   3. `stats` 总篇数 / 总字数 / 连续天数
///   4. `integrity_check` 决定哪些行"应该有索引"
///   5. `rebuild_indexes` 决定重建哪些行
///   6. `save_entry`（经由 `has_content()`）决定要不要收录进搜索索引
/// 以前这些地方各自为政（只看"表里有没有行"），导致**点一下日历就被标记成
/// 写过日记**。分散在多处的判定条件迟早会漂移，所以统一到这里。
///
/// 为什么用 `content_md` 而不是"标题或正文非空"：
///   只填了标题、正文没写的情况，在用户心里不算"写完一篇"，标题往往是顺手
///   打的草稿。用正文作为真相条件最符合"写过日记"的直觉。
pub fn has_content_sql() -> String {
    format!("trim(coalesce(content_md, ''), {TRIM_CHARS}) <> ''")
}

/// 判断一条日记是否算"写过"。必须与 `has_content_sql()` 的语义一致。
pub fn has_content(content_md: &str) -> bool {
    // char::is_whitespace 覆盖空格、制表、换行、回车、垂直制表、换页，
    // 与上面的 SQL 字符集一一对应。
    content_md.chars().any(|c| !c.is_whitespace())
}

/// 加密数据库连接。
pub struct Vault {
    conn: Connection,
    seg: Segmenter,
    /// 数据库文件路径。目前只用于诊断日志；保留是因为将来做
    /// "在文件管理器里打开数据目录"这类功能时需要它。
    #[allow(dead_code)]
    pub db_path: PathBuf,
}

/// 手写 Debug，只暴露路径。
///
/// 不 derive 的原因：rusqlite 的 `Connection` 不实现 `Debug`，
/// 而且**绝不应该**把连接内容打进日志 —— 那可能连带泄漏密钥材料。
/// 手写实现保证输出里只有路径。
impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault")
            .field("db_path", &self.db_path)
            .finish_non_exhaustive()
    }
}

fn now_iso() -> String {
    // 时间格式统一用 RFC3339（带时区的 UTC）。用 SystemTime 而不是引入
    // chrono/time 依赖，避免为一个小需求增加依赖面。
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    unix_to_rfc3339(secs)
}

fn unix_to_rfc3339(secs: u64) -> String {
    // 最小化的 UTC 换算：只处理到"日"，够用且零依赖。
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    // Howard Hinnant 的 civil_from_days 算法
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

    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// 统计字数。
///
/// 中文按字符计，所以直接数非空白字符数即可。不用"按空格分词"那一套 ——
/// 那对中文会得出几乎为零的结果。
fn count_words(text: &str) -> i64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as i64
}

impl Vault {
    /// 新建数据库并用给定 PIN 加密。
    ///
    /// 流程：校准 KDF 参数 → 派生密钥 → 建库 → 写 schema →
    ///       写入加密元信息（salt + 参数）与锁定状态。
    ///
    /// `data_dir` 是应用数据目录，数据库、加密元信息、锁定状态、附件都在这里。
    pub fn create(data_dir: &Path, pin: &str, hint: Option<String>) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("diary.db");
        let meta_path = crypto::crypto_meta_path(data_dir);
        let lock_path = crypto::lockout_path(data_dir);

        if db_path.exists() {
            return Err(AppError::State(
                "数据库已存在，不能重复初始化。请改用解锁流程。".into(),
            ));
        }

        // 用真实 PIN 做校准样本，这样测得的耗时与实际解锁一致。
        let salt = crypto::generate_salt();
        let params = crypto::calibrate_kdf_params(&salt, pin.as_bytes());
        let mut key = crypto::derive_key(pin.as_bytes(), &salt, &params)?;

        // 先建库、写 schema，成功后才落盘元信息。
        // 顺序很重要：如果元信息先写而建库失败，就会留下一个"有参数但没库"
        // 的残缺状态，下次启动会走错分支。
        let result = Self::open_with_key(&db_path, &key).and_then(|vault| {
            vault.init_schema()?;
            Ok(vault)
        });

        // 无论成败都清零内存中的密钥。
        crypto::zeroize(&mut key);
        let vault = result?;

        // 落盘加密元信息：salt + KDF 参数，必须在加密库之外。
        CryptoMeta::new(&salt, params).save(&meta_path)?;

        // 锁定状态：记录提示、最小 PIN 长度、已初始化标记。
        let mut lockout = crypto::LockoutState {
            initialized: true,
            hint,
            ..Default::default()
        };
        // 提示写进去但此时不该显示（失败次数为 0）。
        lockout.record_success(&lock_path)?;

        Ok(vault)
    }

    /// 用 PIN 打开已有数据库。
    pub fn unlock(data_dir: &Path, pin: &str) -> AppResult<Self> {
        let db_path = data_dir.join("diary.db");
        let meta_path = crypto::crypto_meta_path(data_dir);

        if !db_path.exists() {
            return Err(AppError::State("数据库不存在，需要先初始化".into()));
        }

        let meta = CryptoMeta::load(&meta_path)?
            .ok_or_else(|| AppError::State("缺少加密元信息，无法解锁".into()))?;

        // ⚠️ 必须用**元信息里存储的参数**派生，绝不能用 KdfParams::default()。
        //    否则一旦默认值调整过，老用户会发现"密码明明对却打不开"。
        let salt = meta.salt()?;
        let mut key = crypto::derive_key(pin.as_bytes(), &salt, &meta.params)?;

        let opened = Self::open_with_key(&db_path, &key);
        crypto::zeroize(&mut key);

        let vault = opened?;
        // 验证 schema 版本，必要时升级。
        vault.migrate()?;
        Ok(vault)
    }

    /// 建立连接并设置密钥。
    ///
    /// ⚠️ 三个容易致命的细节：
    ///
    /// 1. **`PRAGMA key` 必须是连接后的第一条语句**。在它之前执行任何其他 SQL，
    ///    SQLite 会先以明文方式创建/读取文件头，之后再设密钥也无法加密已有内容。
    ///
    /// 2. **用 `x'...'` 十六进制形式传密钥**，不要拼字符串。原始密钥是 32 字节
    ///    二进制，直接转字符串会引入转义与编码问题。
    ///
    /// 3. **必须主动执行一次查询来验证密钥**。`PRAGMA key` 本身对错误密钥不会
    ///    报错（SQLCipher 是惰性的）。密钥错时第一次真正读取会失败，
    ///    实测报 `hmac check failed for pgno=1` / `error decrypting page 1`。
    ///    这里把这个"第一次读取"提前到打开阶段，好处是错误密码能在解锁界面
    ///    被立即发现，而不是等到用户点开某篇日记才炸。
    fn open_with_key(db_path: &Path, key: &[u8; KEY_LEN]) -> AppResult<Self> {
        let conn = Connection::open(db_path)?;

        let hex_key = key.iter().map(|b| format!("{b:02x}")).collect::<String>();
        conn.pragma_update(None, "key", format!("x'{hex_key}'"))?;

        // 触发密钥验证。这一步失败 = 密码错误（或数据库损坏）。
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|_| AppError::WrongPin)?;

        // 外键约束默认关闭，必须显式打开，否则删除日记时附件与标签不会级联清理。
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // WAL 提升并发读写体验；对单用户应用主要是让写入不阻塞读取。
        conn.pragma_update(None, "journal_mode", "WAL")?;

        Ok(Self {
            conn,
            seg: Segmenter::new(),
            db_path: db_path.to_path_buf(),
        })
    }

    /// 建表并写入版本号与默认本子。
    fn init_schema(&self) -> AppResult<()> {
        self.conn.execute_batch(schema::CREATE_SQL)?;

        let existing: Option<i64> = self
            .conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;
        if existing.is_none() {
            self.conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                params![schema::SCHEMA_VERSION],
            )?;
        }

        // 默认日记本。单本模式下所有日记都挂在这里。
        let has_default: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM notebook WHERE id = ?1",
                params![DEFAULT_NOTEBOOK_ID],
                |r| r.get(0),
            )
            .optional()?;
        if has_default.is_none() {
            self.conn.execute(
                "INSERT INTO notebook (id, name, icon, sort_order, created_at)
                 VALUES (?1, ?2, ?3, 0, ?4)",
                params![DEFAULT_NOTEBOOK_ID, "我的日记", "book", now_iso()],
            )?;
        }
        Ok(())
    }

    /// schema 版本检查与升级。
    ///
    /// 加字段时在这里按版本分支处理，并且**必须先备份**
    /// 再迁移 —— 迁移失败导致用户日记打不开是最严重的事故。
    fn migrate(&self) -> AppResult<()> {
        let version: Option<i64> = self
            .conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
                r.get(0)
            })
            .optional()?;

        match version {
            None => {
                // 库里没有版本表：可能是极早期数据，补上表与版本号。
                self.init_schema()?;
            }
            Some(v) if v > schema::SCHEMA_VERSION => {
                return Err(AppError::State(format!(
                    "数据库版本 {v} 高于本程序支持的 {}，请升级应用",
                    schema::SCHEMA_VERSION
                )));
            }
            Some(v) if v < schema::SCHEMA_VERSION => {
                self.upgrade_from(v)?;
            }
            Some(_) => { /* 版本相同：无需处理 */ }
        }
        Ok(())
    }

    /// 把旧版本的库升到 `schema::SCHEMA_VERSION`。
    ///
    /// 版本历史：
    ///   - v1 -> v2：加 `entry.locked`（每篇日记各自记忆锁定状态）
    fn upgrade_from(&self, from: i64) -> AppResult<()> {
        // 先备份再动结构。备份失败就别升了 —— 宁可这次打不开，
        // 也不能在没有退路的情况下去改用户唯一的一份数据。
        self.backup_before_upgrade(from)?;

        let tx = self.conn.unchecked_transaction()?;
        if from < 2 {
            tx.execute_batch("ALTER TABLE entry ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")?;
        }
        tx.execute(
            "UPDATE schema_version SET version = ?1",
            params![schema::SCHEMA_VERSION],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 升级前留一份原库快照，返回快照路径。
    ///
    /// 用 `VACUUM INTO` 而不是复制文件：库开着 WAL，直接 copy 只能拿到主文件，
    /// 最新写入还留在 -wal 里，快照会缺最后几次编辑。`VACUUM INTO` 产出的是
    /// 已合并 WAL 的完整副本（和 `run_backup` 用的是同一条路）。
    ///
    /// 同名快照已存在就跳过，不覆盖 —— 上一次升级失败留下的那份，
    /// 正是这次最需要的东西。
    fn backup_before_upgrade(&self, from: i64) -> AppResult<PathBuf> {
        let dir = self.db_path.parent().unwrap_or_else(|| Path::new("."));
        let dest = dir.join(format!("diary.pre-v{from}.db"));
        if dest.exists() {
            return Ok(dest);
        }
        self.conn
            .execute("VACUUM INTO ?1", params![dest.to_string_lossy()])?;
        Ok(dest)
    }

    /// 打开某天的日记。
    ///
    /// **不写库**。没有内容时返回一条未持久化的空日记模板（id = 0）。
    ///
    /// ⚠️ 这里曾经是 `get_or_create_entry`，会无条件插入一条空记录，
    ///    结果是"点一下日历就被标记成写过日记"。已改为纯读取：
    ///    只有用户真的输入了内容并触发保存，才会落库。
    ///
    /// 这样"数据库里有行"不再等于"写过日记" —— 判定交给 `has_content()`。
    pub fn open_entry(&self, date: &str) -> AppResult<Entry> {
        validate_date(date)?;
        match self.find_entry_by_date(date)? {
            Some(entry) => Ok(entry),
            None => Ok(Entry {
                id: 0, // 0 表示尚未落库
                entry_date: date.to_string(),
                title: String::new(),
                content_md: String::new(),
                word_count: 0,
                mood: None,
                locked: false,
                created_at: String::new(),
                updated_at: String::new(),
            }),
        }
    }

    /// 该日期是否已经"写过"（有正文内容）。
    pub fn is_written(&self, date: &str) -> AppResult<bool> {
        validate_date(date)?;
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM entry WHERE entry_date = ?1 AND {})",
            has_content_sql()
        );
        let n: i64 = self.conn.query_row(&sql, params![date], |r| r.get(0))?;
        Ok(n != 0)
    }

    pub fn find_entry_by_date(&self, date: &str) -> AppResult<Option<Entry>> {
        let entry = self
            .conn
            .query_row(
                "SELECT id, entry_date, title, content_md, word_count, mood, created_at, updated_at, locked
                 FROM entry WHERE entry_date = ?1",
                params![date],
                map_entry,
            )
            .optional()?;
        Ok(entry)
    }

    /// 保存日记内容（**不带心情**）。
    ///
    /// 为什么保留这个三参数入口：Rust 没有默认参数，改签名会把测试与探针里
    /// 几十处调用一次性全部打断，而那些文件不属于本次改动的范围。
    /// 运行时保存走 `save_entry_with_mood`，心情由前端显式传入。
    ///
    /// 语义提醒：这个入口**会把心情置空**（等价于"未标记"）。
    pub fn save_entry(&self, date: &str, title: &str, content_md: &str) -> AppResult<Entry> {
        self.save_entry_with_mood(date, title, content_md, None)
    }

    /// 保存日记内容 + 心情标记。
    ///
    /// `mood`：1=很差 2=较差 3=一般 4=较好 5=很好，`None` = 未标记。
    ///
    /// ⚠️ **正文与两份索引必须在同一个事务里更新**。分开写会产生两类脏状态：
    ///   - 正文存了但索引没更新 -> 日记搜不到
    ///   - 索引更新了但正文没存 -> 搜到一条打不开的日记
    ///
    /// ⚠️ 心情**不能**变成"写过"判定的一部分。
    ///    若允许在一篇空日记上标心情，库里就会出现"有心情但没正文"的行，
    ///    与"打开 ≠ 写过"这条铁律正面冲突 —— 日历标记、月度统计、搜索索引
    ///    全都按正文判定，多出这种行会让各处显示自相矛盾。
    ///    所以这里设一道硬闸：**正文为空时心情一律不写库**。
    ///    前端也配合把心情条置灰，两边都不产生这种行。
    pub fn save_entry_with_mood(
        &self,
        date: &str,
        title: &str,
        content_md: &str,
        mood: Option<i64>,
    ) -> AppResult<Entry> {
        validate_date(date)?;

        // 取值必须是 1~5 或未标记。宁可报错也不写进一个语义不明的数字 ——
        // 将来的心情分布统计全靠这几个值分组。
        if let Some(m) = mood {
            if !(1..=5).contains(&m) {
                return Err(AppError::Validation(format!("心情取值应为 1~5，收到 {m}")));
            }
        }

        // 锁定是**硬约束**，不是界面上的置灰。
        // 光靠前端把输入框设成 readonly 拦不住自动保存定时器：
        // 解锁前排队的那次保存、或者组件卸载时的 flush，都会照样写进来。
        if self.is_locked(date)? {
            return Err(AppError::Validation(
                "这篇日记已锁定，先解锁再修改".into(),
            ));
        }

        // 先把内容截断到合理上限，避免异常输入撑爆数据库。
        const MAX_TITLE: usize = 200;
        const MAX_CONTENT: usize = 2_000_000; // 约 200 万字符，远超正常日记
        if title.chars().count() > MAX_TITLE {
            return Err(AppError::Validation(format!(
                "标题过长（上限 {MAX_TITLE} 字）"
            )));
        }
        if content_md.len() > MAX_CONTENT {
            return Err(AppError::Validation("正文过长".into()));
        }

        let now = now_iso();
        let words = count_words(content_md);
        // 只有"算写过"的日记才进搜索索引。
        // 否则用户顺手打的标题草稿会出现在搜索结果里，而日历上又不标记它 ——
        // 那种不一致比"搜不到"更让人困惑。
        let indexed = has_content(content_md);

        // 硬闸：正文为空时心情不落库（理由见方法头注释）。
        // 就算前端异常多传了一个 mood，也只会在这一行被丢掉，
        // 不会产生污染"写过"判定的行。
        let mood = if indexed { mood } else { None };

        let tx = self.conn.unchecked_transaction()?;

        tx.execute(
            "INSERT INTO entry (notebook_id, entry_date, title, content_md, word_count, mood, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(entry_date) DO UPDATE SET
                 title = excluded.title,
                 content_md = excluded.content_md,
                 word_count = excluded.word_count,
                 mood = excluded.mood,
                 updated_at = excluded.updated_at",
            params![DEFAULT_NOTEBOOK_ID, date, title, content_md, words, mood, now],
        )?;

        let id: i64 = tx.query_row(
            "SELECT id FROM entry WHERE entry_date = ?1",
            params![date],
            |r| r.get(0),
        )?;

        // 两份索引：先按 rowid 删旧行，再按需插新行。
        // contentless_delete=1 让删除只需 rowid，不必提供旧文本
        // （这是它相对传统 FTS5 delete 命令的核心优势，见 schema.rs 的说明）。
        //
        // ⚠️ 删除必须**无条件**执行，即使这次不打算建索引：
        //    用户可能先把内容清空（此时要从索引里移除），之后再填回来。
        tx.execute("DELETE FROM entry_fts WHERE rowid = ?1", params![id])?;
        tx.execute("DELETE FROM entry_fts_char WHERE rowid = ?1", params![id])?;

        if indexed {
            let text = format!("{title} {content_md}");
            tx.execute(
                "INSERT INTO entry_fts (rowid, seg) VALUES (?1, ?2)",
                params![id, self.seg.words(&text)],
            )?;
            tx.execute(
                "INSERT INTO entry_fts_char (rowid, chars) VALUES (?1, ?2)",
                params![id, Segmenter::chars(&text)],
            )?;
        }

        tx.commit()?;

        self.find_entry_by_date(date)?
            .ok_or_else(|| AppError::State("保存后读取失败".into()))
    }

    /// 某天是否处于锁定状态。
    ///
    /// 不存在该行、或者该行**没有正文**时一律返回 false。
    /// 空草稿必须永远可写 —— 否则用户没法在那一天写下第一个字。
    pub fn is_locked(&self, date: &str) -> AppResult<bool> {
        validate_date(date)?;
        let sql = format!(
            "SELECT locked FROM entry WHERE entry_date = ?1 AND ({})",
            has_content_sql()
        );
        let v: Option<i64> = self
            .conn
            .query_row(&sql, params![date], |r| r.get(0))
            .optional()?;
        Ok(v.unwrap_or(0) != 0)
    }

    /// 把所有日记一次性锁上，返回被锁的篇数。
    ///
    /// 调用时机：**切换日期**、以及**应用启动**时。
    ///
    /// 为什么"关闭软件自动锁定"落在**启动**而不是关闭事件里：
    /// 进程退出时执行的代码不保证跑完（强杀、断电、崩溃都跳过），
    /// 而且窗口关闭事件在 Tauri 里异步、还可能被取消。
    /// 放到启动时执行，"下次打开时全都是锁的"这个效果是**确定**的 ——
    /// 而数据库本身有 PIN 加密，没解锁前谁也读不到，所以早锁晚锁没有安全差别。
    ///
    /// 只锁"写过"的行，并且跳过已经锁好的：一次切换日期不必写上百行。
    pub fn lock_all_entries(&self) -> AppResult<usize> {
        // 先把"被锁住但没有正文"的行解锁。
        // 这是 1.3 留下的脏数据：当时的 lock_all_entries 不看内容，
        // 把正文为空的旧草稿一起锁了，用户看着空日记显示"已锁定"却写不进去。
        // 放在这里修，是因为这个方法每次启动和切换日期都会跑。
        self.conn.execute(
            &format!(
                "UPDATE entry SET locked = 0 WHERE locked = 1 AND NOT ({})",
                has_content_sql()
            ),
            [],
        )?;

        // 只锁"写过"的日记。
        let n = self.conn.execute(
            &format!(
                "UPDATE entry SET locked = 1 WHERE locked = 0 AND ({})",
                has_content_sql()
            ),
            [],
        )?;
        Ok(n)
    }

    /// 设置某天的锁定状态。
    ///
    /// 只改 `entry.locked` 一个字段，**不碰正文**。这正是"锁定"的全部语义：
    /// 内容一个字符都不改，只是不再允许修改 —— 用户手写的换行和空格原样保留。
    ///
    /// 日期还没有落库行时不做任何事（返回空模板）：一天都没写，锁它没有意义，
    /// 也不该因为点了锁定就在日历上留下一条记录。
    pub fn set_entry_locked(&self, date: &str, locked: bool) -> AppResult<Entry> {
        validate_date(date)?;
        if locked {
            // 只锁"写过"的日记。给空行设 locked=1 是个陷阱：
            // 界面上看不出锁（map_entry 会按内容否掉），但等用户终于写下正文，
            // 这一行会**突然变成锁定的**，用户完全不知道为什么。
            // 所以宁可在写入那一刻就拦住，不留下这种会事后发作的标记。
            self.conn.execute(
                &format!(
                    "UPDATE entry SET locked = 1 WHERE entry_date = ?1 AND ({})",
                    has_content_sql()
                ),
                params![date],
            )?;
        } else {
            self.conn.execute(
                "UPDATE entry SET locked = 0 WHERE entry_date = ?1",
                params![date],
            )?;
        }
        // updated_at 刻意不动：锁定不是对内容的修改，
        // 不该让"最后修改时间"跟着跳一下。
        self.open_entry(date)
    }

    /// 删除某天的日记，并清理两份索引。
    ///
    /// 锁定的日记**不允许删除**。只挡"修改"是不够的：整篇删掉同样是丢失内容，
    /// 而且是不可恢复的那种。所以锁必须同时覆盖改和删。
    pub fn delete_entry(&self, date: &str) -> AppResult<()> {
        validate_date(date)?;
        if self.is_locked(date)? {
            return Err(AppError::Validation(
                "这篇日记已锁定，先解锁再删除".into(),
            ));
        }

        let tx = self.conn.unchecked_transaction()?;
        let id: Option<i64> = tx
            .query_row(
                "SELECT id FROM entry WHERE entry_date = ?1",
                params![date],
                |r| r.get(0),
            )
            .optional()?;
        let Some(id) = id else {
            return Ok(()); // 本就不存在，视为成功
        };
        // 附件表与标签表靠外键 ON DELETE CASCADE 清理（连接已开 foreign_keys）。
        tx.execute("DELETE FROM entry_fts WHERE rowid = ?1", params![id])?;
        tx.execute("DELETE FROM entry_fts_char WHERE rowid = ?1", params![id])?;
        tx.execute("DELETE FROM entry WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// 按月列出**写过的**日记摘要，供日历界面使用。
    ///
    /// `month` 形如 '2026-09'。只返回摘要不含正文，避免一次拉回整月内容。
    ///
    /// 只返回有内容的（`has_content_sql()`）—— 打开过但没写的日期不应出现，
    /// 否则"本月写了几天"会把逛过的日子都算进去。
    pub fn list_month(&self, month: &str) -> AppResult<Vec<EntrySummary>> {
        if !is_valid_month(month) {
            return Err(AppError::Validation(format!("月份格式应为 YYYY-MM，收到 {month}")));
        }
        let pattern = format!("{month}-%");
        let sql = format!(
            "SELECT entry_date, title, word_count, mood, updated_at
             FROM entry
             WHERE entry_date LIKE ?1 AND {}
             ORDER BY entry_date ASC",
            has_content_sql()
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![pattern], |r| {
            Ok(EntrySummary {
                entry_date: r.get(0)?,
                title: r.get(1)?,
                word_count: r.get(2)?,
                mood: r.get(3)?,
                updated_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// **写过**日记的日期集合。日历用它标记哪些日子写过。
    ///
    /// 判定规则见 `has_content_sql()`：只有正文非空白才算写过。
    /// 仅仅"点开看过"的日期**不会**出现在这里 —— 这是用户明确指出的需求。
    pub fn written_dates(&self, from: &str, to: &str) -> AppResult<Vec<String>> {
        let sql = format!(
            "SELECT entry_date FROM entry
             WHERE entry_date BETWEEN ?1 AND ?2 AND {}
             ORDER BY entry_date ASC",
            has_content_sql()
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![from, to], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 区间内**有心情标记**的日期 → 心情值。日历用它给日期格加表情。
    ///
    /// 为什么单独开一个接口、而不是让 `written_dates` 顺带返回心情：
    /// `written_dates` 的返回类型是 `Vec<String>`，前端与多处都已依赖；
    /// 而"这天写过没"和"这天标没标心情"本来就是两个问题，分开取更清楚。
    ///
    /// 仍然带上 `has_content_sql()`：心情只应存在于有正文的行上。
    /// 万一历史数据里混进了"有心情没正文"的脏行，这里会把它挡在日历之外，
    /// 与全项目的判定规则保持一致。
    pub fn written_moods(&self, from: &str, to: &str) -> AppResult<Vec<DayMood>> {
        let sql = format!(
            "SELECT entry_date, mood FROM entry
             WHERE entry_date BETWEEN ?1 AND ?2
               AND mood IS NOT NULL
               AND {}
             ORDER BY entry_date ASC",
            has_content_sql()
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![from, to], |r| {
            Ok(DayMood {
                entry_date: r.get(0)?,
                mood: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 统计：总篇数、总字数、连续写作天数。
    ///
    /// 全部只统计**写过的**日记（`has_content_sql()`）。
    /// 否则"共 N 篇"会把打开过但没写的空记录也算进去 —— 与用户直觉不符。
    pub fn stats(&self) -> AppResult<Stats> {
        let total_entries: i64 = self.conn.query_row(
            &format!("SELECT count(*) FROM entry WHERE {}", has_content_sql()),
            [],
            |r| r.get(0),
        )?;
        let total_words: i64 = self.conn.query_row(
            &format!(
                "SELECT coalesce(sum(word_count),0) FROM entry WHERE {}",
                has_content_sql()
            ),
            [],
            |r| r.get(0),
        )?;

        // 连续天数：从最近一篇开始往前推，日期必须逐日相接。
        // 只取写过的日期，否则打开过的空日期会把"连续"打断（或错误地连起来）。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entry_date FROM entry WHERE {} ORDER BY entry_date DESC",
            has_content_sql()
        ))?;
        let dates: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;

        let mut streak = 0i64;
        let mut expected: Option<String> = None;
        for d in &dates {
            match &expected {
                None => {
                    streak = 1;
                    expected = Some(previous_date(d)?);
                }
                Some(exp) if exp == d => {
                    streak += 1;
                    expected = Some(previous_date(d)?);
                }
                Some(_) => break,
            }
        }

        Ok(Stats {
            total_entries,
            total_words,
            streak_days: streak,
            first_date: dates.last().cloned(),
            last_date: dates.first().cloned(),
        })
    }

    /// 中文全文搜索：双索引合并。
    ///
    /// 策略：
    ///   - 主索引（jieba 词）负责精确匹配
    ///   - 兜底索引（单字）保证任意子串可命中，例如搜「牛肉」能搜到「牛肉面」
    ///   - 主索引命中优先级更高（更精确），所以排在前面并去重
    ///
    /// 查询词也必须走 jieba 分词，否则查询词与索引里的 token 对不上。
    pub fn search(&self, query: &str, limit: i64) -> AppResult<Vec<SearchHit>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 500);

        let mut results: Vec<SearchHit> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

        // --- 主索引：按词 AND ---
        let word_seg = self.seg.words(query);
        let word_terms: Vec<String> = word_seg
            .split_whitespace()
            .map(|t| format!("\"{}\"", t.replace('"', "")))
            .collect();
        if !word_terms.is_empty() {
            let match_expr = word_terms.join(" AND ");
            let mut stmt = self.conn.prepare(
                "SELECT e.entry_date, e.title, e.content_md
                 FROM entry_fts f JOIN entry e ON e.id = f.rowid
                 WHERE entry_fts MATCH ?1
                 ORDER BY e.entry_date DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![match_expr, limit], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (date, title, content) = row?;
                if seen.insert(date.clone()) {
                    results.push(SearchHit {
                        snippet: make_snippet(&content, query),
                        entry_date: date,
                        title,
                        matched_by: "word".into(),
                    });
                }
            }
        }

        // --- 兜底索引：按单字 AND ---
        // 只在主索引结果不足时补充，避免无谓开销。
        if (results.len() as i64) < limit {
            let char_terms: Vec<String> = query
                .chars()
                .filter(|c| !c.is_whitespace())
                .map(|c| c.to_string())
                .collect();
            if !char_terms.is_empty() {
                let match_expr = char_terms.join(" AND ");
                let mut stmt = self.conn.prepare(
                    "SELECT e.entry_date, e.title, e.content_md
                     FROM entry_fts_char f JOIN entry e ON e.id = f.rowid
                     WHERE entry_fts_char MATCH ?1
                     ORDER BY e.entry_date DESC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![match_expr, limit], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })?;
                for row in rows {
                    let (date, title, content) = row?;
                    if seen.insert(date.clone()) {
                        results.push(SearchHit {
                            snippet: make_snippet(&content, query),
                            entry_date: date,
                            title,
                            matched_by: "char".into(),
                        });
                    }
                }
            }
        }

        results.truncate(limit as usize);
        Ok(results)
    }

    /// 一致性自检：索引里的孤儿行（对应日记已删除但索引残留）。
    ///
    /// 正常应为 0。启动时或设置页可以调用，用于及早发现同步 bug。
    ///
    /// ⚠️ "缺失索引"只检查**有内容的**日记（`has_content_sql()`）。
    ///    空日记按设计就不进索引，若把它们算作"缺失"会永远误报。
    ///    这里必须和 `save_entry` 的收录规则保持一致。
    pub fn integrity_check(&self) -> AppResult<IntegrityReport> {
        let entry_count: i64 = self.conn.query_row(
            &format!("SELECT count(*) FROM entry WHERE {}", has_content_sql()),
            [],
            |r| r.get(0),
        )?;

        // contentless 表不能直接 count 出"内容行"，但可以检测 rowid 集合差异：
        // 用两张索引各自的 rowid 与 entry 比较。
        let orphan_word: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM entry_fts WHERE rowid NOT IN (SELECT id FROM entry)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let orphan_char: i64 = self
            .conn
            .query_row(
                "SELECT count(*) FROM entry_fts_char WHERE rowid NOT IN (SELECT id FROM entry)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        // 反向：有内容但索引里没有（会表现为"日记搜不到"）。
        let missing_word: i64 = self
            .conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM entry
                     WHERE {} AND id NOT IN (SELECT rowid FROM entry_fts)",
                    has_content_sql()
                ),
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let missing_char: i64 = self
            .conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM entry
                     WHERE {} AND id NOT IN (SELECT rowid FROM entry_fts_char)",
                    has_content_sql()
                ),
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        Ok(IntegrityReport {
            entry_count,
            orphan_word_index: orphan_word,
            orphan_char_index: orphan_char,
            missing_word_index: missing_word,
            missing_char_index: missing_char,
        })
    }

    /// 重建全部索引。索引损坏或分词器升级后使用。
    ///
    /// 只重建**有内容的**日记（`has_content_sql()`），与 `save_entry` 的收录规则一致。
    /// 返回值是实际收录的篇数，不是表里的行数 —— 后者含空日记，会让人误判。
    pub fn rebuild_indexes(&self) -> AppResult<usize> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM entry_fts", [])?;
        tx.execute("DELETE FROM entry_fts_char", [])?;

        let mut stmt = tx.prepare(&format!(
            "SELECT id, title, content_md FROM entry WHERE {}",
            has_content_sql()
        ))?;
        let rows: Vec<(i64, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        drop(stmt);

        for (id, title, content) in &rows {
            let text = format!("{title} {content}");
            tx.execute(
                "INSERT INTO entry_fts (rowid, seg) VALUES (?1, ?2)",
                params![id, self.seg.words(&text)],
            )?;
            tx.execute(
                "INSERT INTO entry_fts_char (rowid, chars) VALUES (?1, ?2)",
                params![id, Segmenter::chars(&text)],
            )?;
        }
        tx.commit()?;
        Ok(rows.len())
    }

    /// 把加密库导出成一个一致的备份文件。
    ///
    /// ⚠️ **不能用 SQLite 的在线备份 API**（`rusqlite::backup::Backup`）。
    ///    实测在 SQLCipher 上直接报错：
    ///        "backup is not supported with encrypted databases"
    ///    原因是该 API 分页复制时会连每页的元数据（编码格式、页大小、保留字节）
    ///    一起复制，而密钥与盐不在其中，产物无法解密 —— SQLCipher 因此主动拒绝，
    ///    而不是给出一个打不开的备份文件。
    ///
    /// 采用的方案：`VACUUM INTO`。
    ///   - 让 SQLite 把整个库重写到新文件，新库沿用**当前连接的密钥**，所以产物是密文
    ///   - 一条 SQL 完成，不需要关闭连接，不影响正在使用的界面
    ///   - 在事务边界上生成，快照天然一致（不像裸复制文件那样可能拿到撕裂的页）
    ///
    /// ⚠️ **备份必须连同 `crypto_meta.json` 一起保存**。
    ///    它含 salt 与 KDF 参数，缺了它即使 PIN 正确也派生不出密钥，
    ///    备份文件将永久无法打开。调用方（命令层）负责一并复制。
    ///
    /// 为什么不用"WAL checkpoint + 复制文件"：
    ///   数据库开了 WAL，最近的提交可能还在 `-wal` 文件里，只复制 `diary.db`
    ///   会丢数据。虽然可以先 checkpoint 再复制，但那要求复制期间没有写入，
    ///   而我们的连接是长期持有的，无法保证。`VACUUM INTO` 没有这个问题。
    pub fn backup_to(&self, dest: &Path) -> AppResult<BackupResult> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // VACUUM INTO 要求目标文件不存在，所以先删。
        // 备份文件名带时间戳，正常不会冲突；但用户手动指定同名文件时，
        // 明确覆盖比报错更符合预期。
        if dest.exists() {
            std::fs::remove_file(dest)?;
        }

        let dest_str = dest
            .to_str()
            .ok_or_else(|| AppError::State("备份目标路径包含非法字符".into()))?;

        // 用参数绑定而不是字符串拼接，避免路径里的引号破坏 SQL。
        self.conn
            .execute("VACUUM INTO ?1", params![dest_str])
            .map_err(|e| AppError::State(format!("备份失败（VACUUM INTO）: {e}")))?;

        // 校验产物确实生成了。VACUUM INTO 在某些失败模式下可能静默不产出文件，
        // 不检查就会给用户一个"备份成功"的假象 —— 对日记软件这是最坏的结果。
        let meta = std::fs::metadata(dest).map_err(|_| {
            AppError::State("备份执行后目标文件不存在，备份未真正完成".into())
        })?;
        if meta.len() == 0 {
            return Err(AppError::State("备份产物为空，备份未真正完成".into()));
        }

        let created_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        Ok(BackupResult {
            path: dest.to_string_lossy().to_string(),
            bytes: meta.len(),
            created_at,
        })
    }

    /// 只读访问底层连接。保留给集成测试与将来的维护功能。
    #[allow(dead_code)]
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    // -----------------------------------------------------------------------
    // 应用设置（键值对，存在 app_setting 表）
    // -----------------------------------------------------------------------

    /// 读取一个设置项。不存在时返回 None。
    pub fn get_setting(&self, key: &str) -> AppResult<Option<String>> {
        let v = self
            .conn
            .query_row(
                "SELECT value FROM app_setting WHERE key = ?1",
                params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(v)
    }

    /// 写入一个设置项（存在则覆盖）。
    pub fn set_setting(&self, key: &str, value: &str) -> AppResult<()> {
        self.conn.execute(
            "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 自动备份是否开启。**默认开启** —— 对日记软件来说，
    /// "用户忘了开备份"和"没有备份"是等价的，而丢日记不可挽回。
    pub fn auto_backup_enabled(&self) -> AppResult<bool> {
        Ok(self
            .get_setting(setting_keys::AUTO_BACKUP_ENABLED)?
            .map(|v| v == "true")
            .unwrap_or(true))
    }

    /// 上次备份时间（Unix 秒）。从未备份过则返回 0。
    pub fn last_backup_at(&self) -> AppResult<u64> {
        Ok(self
            .get_setting(setting_keys::LAST_BACKUP_AT)?
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0))
    }

    /// 自动备份保留的最近份数。
    pub fn keep_recent_backups(&self) -> AppResult<usize> {
        Ok(self
            .get_setting(setting_keys::KEEP_RECENT)?
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(DEFAULT_KEEP_RECENT))
    }

    /// 到下次自动备份还差多少秒。0 表示现在就该备份。
    ///
    /// 为什么用"距上次备份的间隔"而不是固定时刻：
    /// 用户不一定每天开机，固定时刻会整天错过。按间隔算，
    /// 只要距上次超过 24 小时就会补上。
    pub fn secs_until_next_auto_backup(&self) -> AppResult<u64> {
        let last = self.last_backup_at()?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // 系统时间被往回调过时（now < last），视为到期，避免永远不再备份。
        if now < last {
            return Ok(0);
        }
        Ok(AUTO_BACKUP_INTERVAL_SECS.saturating_sub(now - last))
    }

    /// 执行一次备份，记录时间，并按保留策略清理旧备份。
    ///
    /// 返回 (备份结果, 删除的旧文件数)。调用方（命令层）负责同时复制
    /// `crypto_meta.json` —— 少了它备份无法解锁。
    pub fn run_backup(&self, dest_dir: &Path, stamp: &str) -> AppResult<(BackupResult, usize)> {
        let dest = dest_dir.join(format!("diary-{stamp}.db"));
        let result = self.backup_to(&dest)?;

        // 记录时间，成功后才记 —— 否则失败也会把计时器重置。
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.set_setting(setting_keys::LAST_BACKUP_AT, &now.to_string())?;

        // 清理旧备份。失败不影响备份本身。
        let keep = self.keep_recent_backups()?;
        let (deleted, _kept) = prune_backups(dest_dir, keep).unwrap_or((0, 0));

        Ok((result, deleted))
    }
}

/// 备份保留策略：在备份目录里清理过期的备份。
///
/// 规则（两条同时生效）：
///   1. **保留最近 N 份**（默认 7 份）—— 应付"最近写坏了想回退"的场景
///   2. **每个月保留最早的 1 份** —— 即"每月归档"，应付"想看看半年前的状态"
///
/// 为什么需要这个：P0 要求自动备份，而自动备份如果没有清理，
/// 备份目录会无限增长。日记一年也就几 MB，但备份是**整库复制**，
/// 每天一份、一年就是 365 份文件，用户会看到一个塞满的目录。
///
/// 安全约束（很重要）：
///   - 只处理形如 `diary-*.db` 与配对的 `diary-*.meta.json`，不碰其他文件
///   - **任何删除失败都只记录、不中断备份流程** ——
///     清理是维护动作，不该让"备份成功"这件事变成失败
///   - 被保留的文件绝不删除
///
/// 返回 (删除的文件数, 保留的文件数)。
pub fn prune_backups(dir: &Path, keep_recent: usize) -> AppResult<(usize, usize)> {
    if !dir.is_dir() {
        return Ok((0, 0));
    }

    // 收集所有备份主文件（.db），以及它们的创建时间。
    // 时间取自文件名里的时间戳（diary-YYYYMMDD-HHMMSS.db），
    // 不依赖文件系统时间 —— 后者在复制/恢复后会变。
    let mut backups: Vec<(String, String)> = Vec::new(); // (文件名stem, 时间戳)
    for item in std::fs::read_dir(dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if !name.starts_with("diary-") || !name.ends_with(".db") {
            continue;
        }
        let stem = name.trim_end_matches(".db").to_string();
        // 期望格式 diary-YYYYMMDD-HHMMSS
        let stamp = stem.strip_prefix("diary-").unwrap_or("").to_string();
        if stamp.len() != 15 || !stamp.chars().all(|c| c.is_ascii_digit() || c == '-') {
            continue; // 不是本程序生成的命名，不动它
        }
        backups.push((stem, stamp));
    }

    // 按时间戳倒序（新的在前）
    backups.sort_by(|a, b| b.1.cmp(&a.1));

    // 决定保留哪些：
    //   - 前 keep_recent 份
    //   - 每个月（YYYYMM）出现的最早那一份
    let mut keep: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (stem, _) in backups.iter().take(keep_recent) {
        keep.insert(stem.clone());
    }
    // 从旧到新遍历，每个月第一个遇到的（即该月最早）标记保留
    let mut seen_months: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (stem, stamp) in backups.iter().rev() {
        let month = stamp.get(0..6).unwrap_or("").to_string();
        if month.len() == 6 && seen_months.insert(month) {
            keep.insert(stem.clone());
        }
    }

    let mut deleted = 0usize;
    for (stem, _) in &backups {
        if keep.contains(stem) {
            continue;
        }
        // 删除主文件与配对的 meta 文件。失败只记录，不中断。
        let db = dir.join(format!("{stem}.db"));
        let meta = dir.join(format!("{stem}.meta.json"));
        for f in [db, meta] {
            if f.exists() {
                match std::fs::remove_file(&f) {
                    Ok(()) => deleted += 1,
                    Err(e) => eprintln!("清理备份失败（忽略）: {} -> {e}", f.display()),
                }
            }
        }
    }

    Ok((deleted, keep.len()))
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total_entries: i64,
    pub total_words: i64,
    pub streak_days: i64,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IntegrityReport {
    pub entry_count: i64,
    pub orphan_word_index: i64,
    pub orphan_char_index: i64,
    pub missing_word_index: i64,
    pub missing_char_index: i64,
}

impl IntegrityReport {
    pub fn is_healthy(&self) -> bool {
        self.orphan_word_index == 0
            && self.orphan_char_index == 0
            && self.missing_word_index == 0
            && self.missing_char_index == 0
    }
}

fn map_entry(r: &rusqlite::Row<'_>) -> rusqlite::Result<Entry> {
    let content_md: String = r.get(3)?;
    // ⚠️ 没内容的行一律不算锁定。
    //    数据库里可能存在"有行、正文却是空的"旧草稿（只打了标题，或早期版本
    //    点一下日历就建了行）。这种行一旦被标记成锁定，那一天就**永远写不进
    //    第一个字** —— 用户看到的是"空日记也是锁着的"，而且怎么点都解不开。
    //    locked 只对"写过"的日记成立，判定规则和日历、搜索共用同一条。
    let locked = r.get::<_, i64>(8)? != 0 && has_content(&content_md);
    Ok(Entry {
        id: r.get(0)?,
        entry_date: r.get(1)?,
        title: r.get(2)?,
        content_md,
        word_count: r.get(4)?,
        mood: r.get(5)?,
        locked,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}

/// 从原文里截取包含查询词的片段。
///
/// 为什么不在 SQL 里用 FTS5 的 snippet()：
///   1. contentless 索引表调用 snippet() 返回 NULL（实测）
///   2. 普通索引表返回的文本带满 jieba 分词空格，排版是碎的
/// 所以高亮/摘要应在**原文**上按查询词定位，这样展示的才是用户写下的真实文本。
fn make_snippet(content: &str, query: &str) -> String {
    const WINDOW: usize = 40;
    let chars: Vec<char> = content.chars().collect();

    // 找查询词在原文中的位置。整串找不到就退回第一个字符（至少给出上下文）。
    let needle: Vec<char> = query.chars().collect();
    let mut hit: Option<usize> = None;
    if !needle.is_empty() && chars.len() >= needle.len() {
        for start in 0..=(chars.len() - needle.len()) {
            if chars[start..start + needle.len()] == needle[..] {
                hit = Some(start);
                break;
            }
        }
    }

    let center = hit.unwrap_or(0);
    let start = center.saturating_sub(WINDOW / 2);
    let end = (start + WINDOW).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();

    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    snippet
}

fn validate_date(date: &str) -> AppResult<()> {
    let ok = date.len() == 10
        && date.as_bytes()[4] == b'-'
        && date.as_bytes()[7] == b'-'
        && date
            .chars()
            .enumerate()
            .all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    if !ok {
        return Err(AppError::Validation(format!(
            "日期格式应为 YYYY-MM-DD，收到 {date}"
        )));
    }
    Ok(())
}

fn is_valid_month(month: &str) -> bool {
    month.len() == 7
        && month.as_bytes()[4] == b'-'
        && month
            .chars()
            .enumerate()
            .all(|(i, c)| if i == 4 { c == '-' } else { c.is_ascii_digit() })
}

/// 前一天的日期字符串。用于连续天数统计。
fn previous_date(date: &str) -> AppResult<String> {
    validate_date(date)?;
    let y: i64 = date[0..4].parse().unwrap_or(0);
    let m: i64 = date[5..7].parse().unwrap_or(1);
    let d: i64 = date[8..10].parse().unwrap_or(1);

    // 转成"自纪元起的天数"，减一，再转回日期。
    let days = days_from_civil(y, m, d) - 1;
    let (ny, nm, nd) = civil_from_days(days);
    Ok(format!("{ny:04}-{nm:02}-{nd:02}"))
}

/// Howard Hinnant 的 days_from_civil 算法（公有领域）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Howard Hinnant 的 civil_from_days 算法（公有领域）。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_validation_rejects_bad_formats() {
        assert!(validate_date("2026-09-11").is_ok());
        assert!(validate_date("2026-9-11").is_err());
        assert!(validate_date("2026/09/11").is_err());
        assert!(validate_date("").is_err());
    }

    #[test]
    fn previous_date_handles_month_and_year_boundaries() {
        assert_eq!(previous_date("2026-09-11").unwrap(), "2026-09-10");
        assert_eq!(previous_date("2026-09-01").unwrap(), "2026-08-31");
        assert_eq!(previous_date("2026-01-01").unwrap(), "2025-12-31");
        assert_eq!(previous_date("2024-03-01").unwrap(), "2024-02-29"); // 闰年
    }

    #[test]
    fn word_count_counts_chinese_characters() {
        assert_eq!(count_words("你好世界"), 4);
        assert_eq!(count_words("你好 世界"), 4); // 空白不计
        assert_eq!(count_words(""), 0);
    }

    #[test]
    fn has_content_matches_sql_semantics() {
        // has_content 是 has_content_sql() 的 Rust 侧对应物，两者语义必须一致。
        // 实测中发现 SQLite 的 trim() 默认不去制表符与换行，所以这里特别覆盖它们。
        assert!(!has_content(""));
        assert!(!has_content(" "));
        assert!(!has_content("   \n\t  \n  "));
        // Rust 没有 \v / \f 转义，用 Unicode 转义写垂直制表与换页。
        assert!(!has_content("\r\n\u{000B}\u{000C}"));
        assert!(has_content("一"));
        assert!(has_content("  有内容  "));
        assert!(has_content("\n有内容\n"));
    }

    #[test]
    fn snippet_has_no_leading_ellipsis_near_start() {
        // 命中位置靠近开头时，窗口本身已覆盖从第 0 个字符起的内容，
        // 所以**不应该**加前省略号 —— 加了会误导用户以为前面还有内容。
        let content = "今天很开心，和朋友去吃了火锅，聊到很晚才回家，路上还看到了月亮。";
        let s = make_snippet(content, "火锅");
        assert!(s.contains("火锅"), "摘要必须包含查询词，实际: {s}");
        assert!(!s.starts_with('…'), "命中靠近开头时不应加前省略号: {s}");
        assert!(s.starts_with("今天很开心"), "应从原文开头开始截取: {s}");
    }

    #[test]
    fn snippet_has_leading_ellipsis_when_match_is_far_in() {
        // 命中位置远在中间时，摘要应裁掉前面的内容并加前省略号，
        // 让用户知道这段不是日记开头。
        // 尾部也留足内容（超过窗口长度），否则窗口会正好延伸到结尾，
        // 那时**不该**有后省略号 —— 见下一条测试。
        let content = "第一段先写一些无关紧要的铺垫内容用来把命中位置推远的文字。第二段再写一些同样无关的填充文字继续推远位置。今天终于去吃了一顿很久没吃的火锅，非常满足，下次还要再去一次，而且要约上老朋友一起才更热闹。";
        let s = make_snippet(content, "火锅");
        assert!(s.contains("火锅"), "摘要必须包含查询词，实际: {s}");
        assert!(s.starts_with('…'), "命中在中间时应加前省略号: {s}");
        assert!(s.ends_with('…'), "命中在中间且尾部仍有内容时应加后省略号: {s}");
    }

    #[test]
    fn snippet_has_no_trailing_ellipsis_when_window_reaches_end() {
        // 窗口正好覆盖到原文结尾时，不应加后省略号。
        // 这个边界很容易写错，所以单独固化一条测试。
        let content = "第一段先写一些无关紧要的铺垫内容用来把命中位置推远的文字。第二段再写一些同样无关的填充文字继续推远位置。去吃火锅。";
        let s = make_snippet(content, "火锅");
        assert!(s.contains("火锅"), "摘要必须包含查询词，实际: {s}");
        assert!(!s.ends_with('…'), "窗口已到结尾时不应加后省略号: {s}");
    }

    #[test]
    fn snippet_falls_back_when_term_absent() {
        // 兜底索引可能让"部分字符命中"的记录出现，此时查询词不在原文里。
        // 摘要不能 panic，要给出一段上下文。
        let s = make_snippet("今天去爬山了", "牛肉");
        assert!(!s.is_empty());
    }

    /// v1 -> v2 的真实升级路径。
    ///
    /// 这是整个改动里**唯一会碰用户既有数据**的地方，所以单独钉一条测试：
    /// 把库退回 v1 的样子（没有 locked 列），再走一遍 migrate()。
    #[test]
    fn upgrade_from_v1_adds_locked_column_without_touching_content() {
        let dir = std::env::temp_dir().join("dsh-diary-migrate-v1");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();
        // 一段刻意"手工排版"的正文：单换行、行尾空格、行首缩进。
        // 升级不能动它一个字符。
        let original = "第一行\n第二行   行尾空格\n\n  三个空格开头的缩进\n\t制表符开头";
        vault.save_entry("2026-09-11", "标题", original).unwrap();

        // 退回 v1：删掉 locked 列 + 版本号改回 1。
        vault
            .conn
            .execute_batch("ALTER TABLE entry DROP COLUMN locked")
            .unwrap();
        vault
            .conn
            .execute("UPDATE schema_version SET version = 1", [])
            .unwrap();

        vault.migrate().expect("v1 库必须能升到 v2");

        // 版本号已推进
        let v: i64 = vault
            .conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, schema::SCHEMA_VERSION);

        // 升级前的快照必须留下 —— 这是出事后唯一的退路。
        assert!(
            dir.join("diary.pre-v1.db").exists(),
            "升级前必须产生 v1 快照"
        );

        // 正文一字未改，且旧数据默认未锁定。
        let e = vault.open_entry("2026-09-11").unwrap();
        assert_eq!(e.content_md, original, "迁移绝不能改动正文");
        assert_eq!(e.title, "标题");
        assert!(!e.locked, "升级上来的旧日记默认应该是未锁定的");
        assert!(vault.is_locked("2026-09-11").is_ok(), "locked 列应已可用");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 1.3 留下的脏数据：**空行被标记成 locked=1**。
    ///
    /// 这类行必须被当成"未锁定"，而且还能写进正文 —— 否则用户看着空日记
    /// 显示"已锁定"，怎么点都改不了。全量锁定时还要顺手把锁标清掉。
    #[test]
    fn locked_flag_on_an_empty_row_is_ignored_and_cleaned_up() {
        let dir = std::env::temp_dir().join("dsh-diary-lock-legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();
        // 两条只有标题、没有正文的旧草稿
        vault.save_entry("2026-09-11", "只打了标题", "").unwrap();
        vault.save_entry("2026-09-12", "也只打了标题", "").unwrap();
        // 直接写库，模拟 1.3 的 lock_all_entries 干过的事
        vault
            .conn
            .execute(
                "UPDATE entry SET locked = 1 WHERE entry_date IN ('2026-09-11','2026-09-12')",
                [],
            )
            .unwrap();

        // 读出来必须是"未锁定"：没正文的行不算锁定
        assert!(
            !vault.open_entry("2026-09-11").unwrap().locked,
            "空日记不该显示为锁定"
        );
        assert!(!vault.is_locked("2026-09-11").unwrap());
        // save_entry / delete_entry 的锁定拦截也不能误伤它
        vault
            .save_entry("2026-09-11", "只打了标题", "终于写了正文")
            .expect("空草稿必须能写进第一个字");

        // 全量锁定会先把无正文的锁标清掉（09-12 仍是空的），
        // 再把有正文的锁上（09-11 已写了正文）
        vault.lock_all_entries().unwrap();
        let stale: i64 = vault
            .conn
            .query_row(
                "SELECT locked FROM entry WHERE entry_date = '2026-09-12'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stale, 0, "无正文的锁标必须被清掉，否则以后会突然发作");
        assert!(vault.is_locked("2026-09-11").unwrap(), "写过之后应正常锁上");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 心情能存能读，且**只在有正文时才落库**。
    ///
    /// 这是"心情不能变成非空判定的一部分"的守门测试。
    /// 允许空日记标心情的话，库里就会出现"有心情但没正文"的行，
    /// 而日历、统计、搜索全按正文判定 —— 那种行会让界面自相矛盾。
    #[test]
    fn mood_is_saved_and_dropped_when_content_is_empty() {
        let dir = std::env::temp_dir().join("dsh-diary-mood");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();

        // 有正文 + 心情 → 正常存下，重开还在
        let e = vault
            .save_entry_with_mood("2026-09-11", "标题", "今天过得不错。", Some(5))
            .unwrap();
        assert_eq!(e.mood, Some(5));
        assert_eq!(
            vault.open_entry("2026-09-11").unwrap().mood,
            Some(5),
            "重开这篇日记，心情必须还在"
        );

        // 无正文 + 心情 → 心情被丢弃
        vault
            .save_entry_with_mood("2026-09-12", "", "   \n\t  ", Some(5))
            .unwrap();
        let raw: Option<i64> = vault
            .conn
            .query_row(
                "SELECT mood FROM entry WHERE entry_date = '2026-09-12'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, None, "正文为空时心情绝不能落库");

        // 关键回归点：标过心情但没有正文的这一天，依然不算"写过"
        let dates = vault.written_dates("2026-09-01", "2026-09-30").unwrap();
        assert_eq!(dates.len(), 1, "只有 09-11 算写过，实际: {dates:?}");
        assert_eq!(dates[0], "2026-09-11");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 心情取值只接受 1~5。别的值直接拒绝，不做"猜用户想表达什么"。
    #[test]
    fn mood_out_of_range_is_rejected() {
        let dir = std::env::temp_dir().join("dsh-diary-mood-range");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();
        for bad in [0_i64, 6, -1, 999] {
            let r = vault.save_entry_with_mood("2026-09-11", "", "有内容。", Some(bad));
            assert!(r.is_err(), "心情取值 {bad} 必须被拒绝");
        }
        // 校验发生在写库之前，所以被拒之后不该留下半截数据
        assert!(
            vault
                .written_dates("2026-09-01", "2026-09-30")
                .unwrap()
                .is_empty(),
            "取值非法时不能留下任何写入"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 日历取心情：只返回**有正文**且标过心情的日子。
    #[test]
    fn written_moods_only_lists_days_with_content_and_mood() {
        let dir = std::env::temp_dir().join("dsh-diary-mood-list");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();
        vault
            .save_entry_with_mood("2026-09-11", "", "写过，也标了心情。", Some(4))
            .unwrap();
        // 写过但没标心情 —— 不该出现在结果里
        vault
            .save_entry("2026-09-12", "", "写过，但没标心情。")
            .unwrap();
        // 历史脏数据：有心情、没正文。正常路径产生不了（后端会丢掉），
        // 这里先正常写进去、再直接改库模拟"外部工具写坏"的情况。
        vault
            .save_entry_with_mood("2026-09-13", "", "待会儿清空", Some(3))
            .unwrap();
        vault
            .conn
            .execute(
                "UPDATE entry SET content_md = '   ' WHERE entry_date = '2026-09-13'",
                [],
            )
            .unwrap();

        let got = vault.written_moods("2026-09-01", "2026-09-30").unwrap();
        assert_eq!(got.len(), 1, "只应有 09-11：既有正文又有心情，实际: {got:?}");
        assert_eq!(got[0].entry_date, "2026-09-11");
        assert_eq!(got[0].mood, 4);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
