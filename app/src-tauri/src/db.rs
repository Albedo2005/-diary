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
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub const AUTO_LOCK_SECS: &str = "auto_lock_secs";
    pub const AUTO_LOCK_ENTRIES: &str = "auto_lock_entries";
    pub const TRIPLE_CLICK_UNLOCK: &str = "triple_click_unlock";
}

/// 自动锁定时长的**档位白名单**（秒）。`0` 表示"永不"。
///
/// 为什么钉死四档而不是让用户填任意秒数：
///   这个值决定"离开多久之后密钥从内存里消失"，属于安全参数。
///   放开成任意值，一定有人填 3 秒（自己被烦死）或 8 小时（等于没设），
///   最后都退化成"这人不用自动锁定了"。四档覆盖从"很快"到"不要"，
///   每一档都是能长期用的选择。
pub const AUTO_LOCK_ALLOWED_SECS: [u32; 4] = [0, 60, 300, 600];

/// 自动锁定时长的默认值：10 分钟。
///
/// ⚠️ 这是一次**行为变更**：1.6 及之前这个值是硬编码的 15 分钟。
///    四档里没有 15，取最接近的一档 —— 10 分钟。
///    老库（从没设过这一项）走同一个默认值。
pub const DEFAULT_AUTO_LOCK_SECS: u32 = 600;

/// 「离开日记时自动锁定」的默认值：**开**。
///
/// ⚠️ 默认值只有这一个合理选择：老库（从来没有这个 key）和解析失败
///    都走它，于是**升级上来的行为与改动前逐项一致**。
///    反过来默认关，等于所有人一升级就发现"日记不再自动上锁了" ——
///    而这是一次**静默**的安全倒退（没有任何提示）。
pub const DEFAULT_AUTO_LOCK_ENTRIES: bool = true;

/// 「三击左键快速解锁」的默认值：**开**（指令 15）。
///
/// ⚠️ 默认开：用户要的就是"一只手快速解锁"，而这条手势**只在锁定态**、
///    只在正文输入框上生效 —— 风险面很窄（未锁定时三击仍是原生的
///    "选中一整段"，一个字节都不改）。老库（没有这个 key）走同一个默认值。
///    读取时沿用 `auto_lock_entries` 的口径：**只有精确 "false" 才算关**。
pub const DEFAULT_TRIPLE_CLICK_UNLOCK: bool = true;

/// 应用设置。
///
/// 为什么用一个结构体返回、而不是每项一个读取命令：
///   以后加设置项只需往这里加字段，前端那条读命令不用动。
///   写入则相反 —— 每项一条独立命令，因为写入要校验、要有明确语义，
///   不能开放"前端随便写 key"（见 `set_auto_lock_secs`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    /// 窗口失去焦点后多久自动锁定（秒）。`0` = 永不。
    ///
    /// ⚠️ 这一项锁的是**整个应用**，与下面那一项**同名不同义**。
    pub auto_lock_secs: u32,
    /// 离开某一天时（切日期 / 重开软件）是否自动把日记锁上。默认开。
    ///
    /// ⚠️ 与 `auto_lock_secs` **不是一回事**：这一项锁的是**单篇日记**
    ///    （那天的正文变只读），防的是自己手滑改掉 / 删掉写好的日记；
    ///    那一项防的是别人看。
    pub auto_lock_entries: bool,
    /// 日记锁定时，在正文里连点三下左键是否可以直接解锁（指令 15）。默认开。
    ///
    /// ⚠️ 这一项只是"手势开关"，与 `auto_lock_entries` **不是一回事**：
    ///    它不决定"要不要自动锁"，只决定"锁上之后怎么解开方便"。
    pub triple_click_unlock: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            auto_lock_secs: DEFAULT_AUTO_LOCK_SECS,
            auto_lock_entries: DEFAULT_AUTO_LOCK_ENTRIES,
            triple_click_unlock: DEFAULT_TRIPLE_CLICK_UNLOCK,
        }
    }
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
    /// 1=悲伤 2=受伤 3=茫然 4=愤怒 5=开心（1~5 只是编号，无好坏顺序；
    /// 取值约束见 `save_entry_with_mood`）。
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

/// 一个标签 + 它的使用情况。
#[derive(Debug, Clone, Serialize)]
pub struct TagStat {
    pub id: i64,
    pub name: String,
    /// 打了这个标签、且**算写过**的日记篇数（判定同 `has_content_sql()`）。
    ///
    /// 只数"写过"的，与日历标记、月度统计、搜索索引用同一条规则 ——
    /// 否则同一个标签会出现"这里显示 3 篇、点进去只有 2 篇有内容"。
    ///
    /// **可能是 0**：把最后一篇带它的日记的标签撤掉之后，标签本身不会自动
    /// 消失（见 `set_entry_tags` 的说明），界面上显示"0 篇"；
    /// 想让它从列表里消失就用 `retire_tag`（软删除，不会影响已经贴过它的
    /// 日记）。刻意保留这种"空标签"，理由见 `list_tags`。
    pub entry_count: i64,
}

/// 备份结果。
#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
    pub path: String,
    pub bytes: u64,
    /// 创建时间（Unix 秒）
    pub created_at: u64,
}

/// Markdown 导出结果。
///
/// 只回传"发生了什么"，不回传写过哪些文件 —— 全库导出可能有几千篇，
/// 把文件清单塞进返回值只会让 IPC 变胖，而界面上真正要显示的只有三项：
/// 导到哪、导了几篇、有没有因为重名加过后缀。
#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    /// 导出到的目录（可能带重名后缀，所以以实际写入的为准）。
    pub dest_dir: String,
    /// 导出了多少篇。
    ///
    /// 口径与统计里的"共 N 篇"**完全一致**（都走 `has_content_sql()`）：
    /// 打开过但没写过的空记录不导出。这条例外关系是用户会当场核对的
    /// —— 导出数量对不上统计，用户就有理由怀疑导出漏了东西。
    pub entry_count: usize,
    /// 有多少个文件名因为目标已存在而被加了后缀（` (1)`、` (2)`…）。
    /// 首次导出到一个空目录时应为 0。
    pub renamed: usize,
    /// `index.md` 的落盘路径（同样可能带后缀）。
    pub index_path: String,
}

/// 一条附件（图片）记录 —— 对应 `attachments/` 里的一个文件。
///
/// ⚠️ **附件明文落盘、不进加密库**（用户 2026-09-20 已定决策，风险已知）：
///    图片往往比正文更敏感，而且会被云同步软件连目录一起带走，造成
///    "正文是加密的、图片却明文躺在云盘里"的错觉。
///    数据库里**只存相对路径**（`attachments/<sha256>.<ext>`），因为绝对路径
///    在换电脑、改用户名、移动数据目录之后全部失效。
#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: i64,
    /// 原文件名。**只用来显示**（正文里的 alt 文本），落盘文件名是 sha256。
    pub file_name: String,
    /// 相对**数据目录**的路径，形如 `attachments/<sha256>.<ext>`。
    pub stored_rel: String,
    /// 绝对路径，由 `stored_rel` 推导（不入库）。给界面显示位置用。
    pub abs_path: String,
    pub mime: String,
    pub byte_size: i64,
    pub sha256: String,
    pub created_at: String,
}

/// 「清理图片缓存」的结果。
#[derive(Debug, Clone, Serialize)]
pub struct PruneReport {
    /// 删掉的孤儿文件（磁盘上有、表里没人认领）。
    pub files_removed: usize,
    /// 删掉的失效记录（表里有、磁盘上文件已经没了）。
    pub rows_removed: usize,
    /// 顺带释放的字节数（只算孤儿文件）。
    pub bytes_freed: u64,
}

/// 单张图片的上限：20 MB。
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

/// 单篇日记所有图片之和的上限：50 MB。
///
/// 在**落盘之前**就拒绝：让人把一整本相册塞进一篇日记，换来的只是
/// 导出/备份时一个几 GB 的目录。
pub const MAX_ENTRY_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

/// 允许的图片格式：扩展名 → (MIME, 文件头魔数)。
///
/// 判定是**三重**的：扩展名 + 前端报的 MIME + **文件头魔数**。
/// 前两个都是"别人说了算"的信息（改个名就能骗），所以最终落在文件头上
/// —— 那才是文件真实的样子。规格只写了"扩展名 + MIME 双重判断"，
/// 多这一层代价只有几行。
const ATTACHMENT_TYPES: &[(&str, &str, &[u8])] = &[
    ("png", "image/png", &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
    ("jpg", "image/jpeg", &[0xFF, 0xD8, 0xFF]),
    ("jpeg", "image/jpeg", &[0xFF, 0xD8, 0xFF]),
    ("gif", "image/gif", b"GIF8"),
    ("webp", "image/webp", b"RIFF"),
];

/// 取归一化（小写）的扩展名。
///
/// ⚠️ `file_name` **永远不当作路径用** —— 它只贡献扩展名和界面上的 alt 文本，
///    真正的落盘名字是 `sha256.<ext>`。所以文件名里带 `../` 也伤不到谁。
fn attachment_ext(file_name: &str) -> AppResult<String> {
    Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .ok_or_else(|| AppError::Validation("这个文件没有扩展名，认不出图片格式".into()))
}

/// 扩展名 + MIME + 文件头，三样都对上才算合法图片。返回 `(扩展名, 归一化 MIME)`。
pub fn validate_attachment(
    file_name: &str,
    declared_mime: &str,
    bytes: &[u8],
) -> AppResult<(String, String)> {
    let ext = attachment_ext(file_name)?;
    let (_, mime, magic) = ATTACHMENT_TYPES
        .iter()
        .find(|(e, _, _)| *e == ext)
        .copied()
        .ok_or_else(|| {
            AppError::Validation(format!("只支持 png / jpg / jpeg / gif / webp，这个是 .{ext}"))
        })?;

    // 前端报的 MIME 只能用来"对不上就拒绝"，不能用来放行：
    // 它是浏览器按扩展名猜的，而且可以被改成任意值。
    let declared = declared_mime.trim().to_ascii_lowercase();
    if !declared.is_empty() && declared != mime {
        return Err(AppError::Validation(format!(
            "文件类型对不上：扩展名是 .{ext}（{mime}），但浏览器报的是 {declared}"
        )));
    }

    // webp 的魔数分两段（`RIFF????WEBP`），只判 RIFF 会把 wav / avi 放进来。
    let webp_ok = ext != "webp" || (bytes.len() >= 12 && &bytes[8..12] == b"WEBP");
    if !bytes.starts_with(magic) || !webp_ok {
        return Err(AppError::Validation(format!(
            "文件内容不像 {mime}：扩展名和真实格式不一致（改过后缀名？）"
        )));
    }
    Ok((ext, mime.to_string()))
}

/// 字节的 sha256（小写十六进制）。附件就是靠它做到"同一张图只存一份"。
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        // 写进 String 不可能失败，这个 let _ = 是给编译器的。
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// 把库里的 `stored_rel` 解析成绝对路径，并**挡死路径穿越**。
///
/// 规矩只有一条：`stored_rel` 必须是 `attachments/<文件名>`，中间**只允许
/// 普通路径段** —— `..`、`.`、绝对路径、盘符在解析过程中直接拒绝。
/// 于是"结果一定落在 `attachments/` 里面"是**结构上保证**的，
/// 不靠事后 `starts_with` 断言（那种写法漏一个分支就穿了）。
///
/// 为什么不用 `std::fs::canonicalize`：① 它要求路径已经存在，而"表里有记录、
/// 文件却被手工删了"正是要能报出来的情况；② Windows 上它会返回 `\\?\` 前缀，
/// 拿它跟没规范化的目录做比较很容易出岔子。
fn attachment_path(data_dir: &Path, stored_rel: &str) -> AppResult<PathBuf> {
    let mut comps = Path::new(stored_rel).components();
    match comps.next() {
        Some(std::path::Component::Normal(c)) if c == "attachments" => {}
        _ => {
            return Err(AppError::Validation(
                "附件路径非法：必须以 attachments/ 开头".into(),
            ))
        }
    }

    let mut out = data_dir.join("attachments");
    for comp in comps {
        match comp {
            std::path::Component::Normal(c) => out.push(c),
            _ => {
                return Err(AppError::Validation(
                    "附件路径非法：不允许 .. 或绝对路径".into(),
                ))
            }
        }
    }
    Ok(out)
}

/// SQLite 的 `trim()` **默认只去半角空格**，不去制表符和换行。
/// 这一点和 SQL Server 的 `TRIM`（去所有空白）不同，很容易想当然写错 ——
/// 实测中"只敲了回车和缩进"的内容会被误判成"写过日记"。
/// 所以必须显式列出所有要去掉的空白字符。
const TRIM_CHARS: &str = "char(32) || char(9) || char(10) || char(13) || char(11) || char(12)";

/// "这篇算写过吗"的**唯一判定规则**（SQL 侧）。
///
/// 规则：`content_md` 去掉各类空白后仍非空，**或者这一篇挂着至少一张图片附件**。
///
/// 2026-09-21 加的后半个条件（用户拍板）：图片附件也算"写过"。
/// 起因是"在一篇还没写正文的日记里插图片"这条需求 —— 两条路只能选一条：
///   ① 插图片时凭空建一行正文为空的 entry，但这行在统计 / 日历 / 导出里
///      **仍然不算写过** → 图片存着、日记不算写过，两套口径互相打架；
///   ② 把"有附件"一起算进"写过"（就是现在这条），口径只有一套。
/// 用户选了 ②。代价是**判定从"只看一列"变成"看两处"**，所以后半句必须
/// 跟着 `has_content()` 的说明一起读（那边只回答"有没有正文文本"）。
///
/// 为什么必须集中成一处：这是全应用语义的单一事实来源，被多处使用 ——
///   1. `written_dates` 日历标记
///   2. `list_month` 月度摘要与"本月写了几天"
///   3. `stats` 总篇数 / 总字数 / 连续天数
///   4. `integrity_check` 决定哪些行"应该有索引"
///   5. `rebuild_indexes` 决定重建哪些行
///   6. `list_tags` 每个标签的"被 N 篇用过"
///   7. `export_markdown` 导出哪些篇
///   8. `is_locked` / `map_entry` 决定锁定标记算不算数
/// 以前这些地方各自为政（只看"表里有没有行"），导致**点一下日历就被标记成
/// 写过日记**。分散在多处的判定条件迟早会漂移，所以统一到这里。
///
/// 为什么用 `content_md` 而不是"标题或正文非空"：
///   只填了标题、正文没写的情况，在用户心里不算"写完一篇"，标题往往是顺手
///   打的草稿。用正文作为真相条件最符合"写过日记"的直觉。
pub fn has_content_sql() -> String {
    has_content_sql_for("entry")
}

/// 同 `has_content_sql()`，但用于**给 entry 起了别名**的 SQL。
///
/// 存在的理由只有一个：附件那半句要写 `a.entry_id = <本行>.id`，
/// 而调用方的 SQL 有时是 `FROM entry`、有时是 `LEFT JOIN entry e`。
/// 让调用方把名字传进来，好过在函数里猜、也好过把 `entry.` 写死
/// （写死了 `list_tags` 那条就会在运行时报 "no such column: entry.id"）。
pub fn has_content_sql_for(entry_ref: &str) -> String {
    format!(
        "(trim(coalesce({entry_ref}.content_md, ''), {TRIM_CHARS}) <> '' \
         OR EXISTS(SELECT 1 FROM attachment a WHERE a.entry_id = {entry_ref}.id))"
    )
}

/// 判断一段正文里**有没有文本**。
///
/// ⚠️ 这只回答"有没有正文文本"，**不等于**"这篇算不算写过" ——
///    "算写过"是 `has_content_sql()` / `has_content_sql_for()` 的事，
///    它还包含"有图片附件"那半句。两者用途不同：
///      * 要不要进**搜索索引**、心情能不能落库 —— 问的是"有没有文本可搜"，
///        所以用这个（纯图片日记没有可检索的文字，索引一条空文本没有意义）；
///      * 日历标不标记、统计算不算一篇 —— 问的是"算不算写过"，
///        所以走 `has_content_sql()`。
///    历史上两者是同一条规则，2026-09-21 加附件之后分开了，别再合并回去。
pub fn has_content(content_md: &str) -> bool {
    // char::is_whitespace 覆盖空格、制表、换行、回车、垂直制表、换页，
    // 与上面的 SQL 字符集一一对应。
    content_md.chars().any(|c| !c.is_whitespace())
}

/// 标签名的长度上限（**字符数**，不是字节数）。
///
/// 20 是"够用且不至于把界面撑坏"的经验值：标签是给人扫的，
/// 超过二十字它已经是一句话，该写进标题或正文。
///
/// ⚠️ 按 `chars().count()` 而不是 `len()` 计数：中文一个字 3 字节，
///    拿字节数当上限会让中文标签只能打 6 个字。
pub const TAG_MAX_CHARS: usize = 20;

/// 清洗一批用户输入的标签名。
///
/// 规则（顺序不能反）：
///   1. **去首尾空白**（`str::trim` 覆盖空格 / 制表 / 换行，与
///      `has_content()` 用的 `is_whitespace` 是同一套口径）
///   2. **空的丢掉** —— 用户多敲一个分隔符不该产生一个无名标签
///   3. **超长报错**，不静默截断：悄悄砍掉尾巴的话，用户下次会看到一个
///      自己没打过、也搜不到的标签，而"我明明打过"这件事无法自证
///   4. **去重，且忽略大小写** —— 这条是硬要求，不是洁癖：
///      `tag.name` 是 `UNIQUE COLLATE NOCASE`，`[Travel, travel]` 会落到
///      **同一行**上；不去重就会往 `entry_tag` 插两条
///      (entry_id, tag_id) 完全相同的记录，撞主键直接报错
///
/// 刻意**保留用户敲的原始大小写**（`Travel` 不会被改写成 `travel`）：
/// 名字长什么样是用户的自由，库只保证"大小写不同算同一个标签"。
///
/// ⚠️ 去重用的是**只折 ASCII 大小写**的 `to_ascii_lowercase()`，
///    而不是 `to_lowercase()` —— 后者按 Unicode 规则折，
///    范围比 SQLite 的 `NOCASE`（只折 A~Z）更大，会出现
///    "应用认为重名、数据库认为不重名"的错位。两边必须同口径。
fn normalize_tag_names(raw: &[String]) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    // 折叠后的名字，只用来判重；存回库的仍是用户敲的那个样子。
    let mut seen: Vec<String> = Vec::new();
    for name in raw {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        let chars = trimmed.chars().count();
        if chars > TAG_MAX_CHARS {
            return Err(AppError::Validation(format!(
                "标签名过长（上限 {TAG_MAX_CHARS} 字，收到 {chars} 字）"
            )));
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(trimmed.to_string());
    }
    Ok(out)
}

/// 加密数据库连接。
pub struct Vault {
    conn: Connection,
    seg: Segmenter,
    /// 数据库文件路径。
    ///
    /// 两个用途：诊断日志，以及**改密码时倒推出数据目录** ——
    /// lockout.json / auto_login.json / crypto_meta.json 都躺在库文件旁边，
    /// 而 `change_password` 需要同时动后面那两份库外文件。
    pub db_path: PathBuf,
    /// 本连接所用的密钥。
    ///
    /// ⚠️ 为什么连 `Connection` 都拿着密钥了，还要在这里再存一份：
    ///    换库（备份恢复）时**必须先丢掉旧连接**（Windows 上文件被占用就复制不了），
    ///    而丢掉之后要判断"当前密码还能不能打开刚换上的那个库"，就必须有密钥。
    ///    没有它，恢复完只能把用户踢回解锁页 —— 哪怕新库用的就是同一个密码。
    ///
    /// ⚠️ 安全面**没有扩大**：它和 `Connection` 同生命周期，
    ///    库一锁（`*guard = None`）两者一起消失，并由下面的 `Drop` 显式清零。
    ///    可见性严格限制在 `pub(crate)`（见 `session_key`）。
    key: [u8; KEY_LEN],
}

impl Drop for Vault {
    /// 把密钥在内存里擦掉。
    ///
    /// 为什么必须显式做：`[u8; 32]` 是普通数组，`drop` 只是把这块内存还回去，
    /// 那 32 个字节仍原样留在栈/堆上，可能被下一次分配复用、被内存转储捞走。
    /// 这个应用存在的意义就是"密钥不落在任何能被人捡到的地方"，
    /// 所以库一锁就把内存里的那份擦干净。
    fn drop(&mut self) {
        crypto::zeroize(&mut self.key);
    }
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

/// 统计字数 —— **后端算字数的唯一入口**。
///
/// 中文按字符计，所以直接数非空白字符数即可。不用"按空格分词"那一套 ——
/// 那对中文会得出几乎为零的结果。
///
/// ⭐ **纪律**：某天 / 某篇有多少字，**一律读 `entry.word_count` 列**
///    （保存时由这里算好写进去的）；⛔ 任何新功能**不许自己拿 `content_md` 再数一遍**。
///    重数 ＝ 又开了一套口径：将来"可见文字"的定义一改（富文本上线），
///    散落的每一处都得回头改，而漏掉的那处**不会报错，只会悄悄多出一个对不上的数字**。
///    目前读这一列的有：统计页（总字数 / 每月趋势）、导出、列表。
///    ⚠️ 前端编辑器右上角那个实时「N 字」走的是 `utils/text.ts::visibleText()`，
///       与这里**不是同一套口径**（emoji 差 1~2 个），该差异**照旧保留**。
fn count_words(text: &str) -> i64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as i64
}

// ---------------------------------------------------------------------------
// 密钥校验：全应用只留一份实现
// ---------------------------------------------------------------------------

/// 给连接设密钥并**主动验证**它能不能真正读库。
///
/// 这是加密体系里最容易写错、也最不能写错的一段，所以只留一份。
/// 三处入口走的都是这里：开库（`Vault::open_with_key`）、
/// 改密码前验证旧密码（`derive_and_verify`）、免密打开（指令 4 复用同一函数）。
/// 各写一份的后果是某条路径的校验慢慢漂移，表现就是
/// **某个入口错误密码也能进去**，而加密从外面看还一切正常。
///
/// ⚠️ 三个致命细节（改动前先读懂）：
///
/// 1. **`PRAGMA key` 必须是连接后的第一条语句**。在它之前执行任何其他 SQL，
///    SQLite 会先以明文方式创建/读取文件头，之后再设密钥也**无法**加密已有内容。
///    所以本函数只做这一件事，绝不"顺手先查一下版本号"。
///
/// 2. **用 `x'...'` 十六进制形式传密钥**，不要拼字符串。原始密钥是 32 字节
///    二进制，直接转字符串会引入转义与编码问题。
///
/// 3. **必须主动执行一次查询来验证**。`PRAGMA key` 对错误密钥**不报错**
///    （SQLCipher 是惰性的），要到第一次真正读取才炸，
///    实测报 `hmac check failed for pgno=1` / `error decrypting page 1`。
///    把这个"第一次读取"提前到这里，错误密码才能在解锁界面被立即发现，
///    而不是等用户点开某篇日记才炸。
fn apply_key_and_verify(conn: &Connection, key: &[u8; KEY_LEN]) -> AppResult<()> {
    let hex_key = key.iter().map(|b| format!("{b:02x}")).collect::<String>();
    conn.pragma_update(None, "key", format!("x'{hex_key}'"))?;

    conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
        r.get::<_, i64>(0)
    })
    .map_err(|_| AppError::WrongPin)?;

    Ok(())
}

/// 用给定密钥开一个**一次性连接**并验证，不改任何 pragma、不建任何表。
///
/// 用途：在不打扰当前已解锁连接的前提下，验证"另一把密钥对不对"。
/// 改密码前验证旧密码就是靠它 —— 验完随即丢弃，主连接自始至终没被碰过。
///
/// ⚠️ 必须先确认库文件存在：`Connection::open` 对不存在的路径会**创建**一个
///    空文件，那就等于凭空造出一个明文空库，把用户的数据目录搞脏。
pub fn open_verified_connection(db_path: &Path, key: &[u8; KEY_LEN]) -> AppResult<Connection> {
    if !db_path.exists() {
        return Err(AppError::State("数据库不存在，无法验证密码".into()));
    }
    let conn = Connection::open(db_path)?;
    apply_key_and_verify(&conn, key)?;
    Ok(conn)
}

/// 用给定密钥**只读**打开一个库文件（备份检查专用）。
///
/// 与 `open_verified_connection` 只差一处，但那一处很要紧：它以
/// `SQLITE_OPEN_READ_ONLY` 打开。备份检查面对的是**用户摆在别处的备份文件**，
/// 而 SQLite 在一个可写的库上会顺手创建 `-wal` / `-shm` 同伴文件 ——
/// 那就意味着"我只是点了一眼看看"，却在用户的备份目录里留下了两个陌生文件；
/// 在只读介质（光盘、只读网络盘）上更是直接失败。
///
/// ⚠️ 备份是本程序用 `VACUUM INTO` 生成的**单文件**库（不含 WAL），
///    所以只读打开一定读得到；反过来，把带 WAL 的**主库文件**当成备份拿来，
///    这里会读不出来 —— 那本来也不是一份能用的备份。
pub fn open_verified_connection_readonly(
    db_path: &Path,
    key: &[u8; KEY_LEN],
) -> AppResult<Connection> {
    if !db_path.exists() {
        return Err(AppError::State("数据库不存在，无法验证密码".into()));
    }
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    apply_key_and_verify(&conn, key)?;
    Ok(conn)
}

/// 用给定密钥只读打开一份**备份**，数出里面"写过"的篇数。
///
/// 口径必须与统计页完全一致（`has_content_sql()`）—— 否则会出现
/// "检查时说 12 篇、恢复后统计说 11 篇"这种自己跟自己打架的数目。
///
/// ⚠️ 读不出来（密钥不对 / 备份来自更老的版本、表结构不同）一律返回 `Err`，
///    由调用方翻成"读不出篇数"。**绝不编一个数字**：
///    这是用户在按下"替换并恢复"之前唯一能看到的依据。
pub fn count_written_entries_readonly(db_path: &Path, key: &[u8; KEY_LEN]) -> AppResult<i64> {
    let conn = open_verified_connection_readonly(db_path, key)?;
    let n = conn.query_row(
        &format!("SELECT count(*) FROM entry WHERE {}", has_content_sql()),
        [],
        |r| r.get(0),
    )?;
    Ok(n)
}

/// 从备份文件名里解析创建时间（Unix 秒，UTC）。
///
/// 认这三种写法（都是本程序自己生成的，见 `commands::now_stamp`）：
///
/// ```text
/// diary-20260923-161500.db
/// diary-20260923-161500.meta.json
/// diary-20260923-161500            ← 纯 stem
/// ```
///
/// 认不出来返回 `None` —— **这不是错误**：备份目录里可能有用户自己放的文件，
/// 对它最合适的处理是"当它不存在"，而不是报错并让整个列表打不开。
///
/// 为什么必须优先用文件名、而不是文件的修改时间：备份一定会被**拷来拷去**
///（换电脑、丢进网盘再拷回来），一拷 mtime 就变成"拷回来的那一刻"，
/// 而文件名里的时间戳永远不变。只认 mtime，用户会看到一条被彻底打乱的时间线。
pub fn parse_backup_stamp(name: &str) -> Option<u64> {
    let stem = name
        .strip_suffix(".meta.json")
        .or_else(|| name.strip_suffix(".db"))
        .unwrap_or(name);
    let rest = stem.strip_prefix("diary-")?;

    // 期望 `YYYYMMDD-HHMMSS` ⇒ 剩余正好 15 个字符，第 9 个是分隔号。
    if rest.len() != 15 || rest.as_bytes().get(8) != Some(&b'-') {
        return None;
    }
    let y: i64 = rest.get(0..4)?.parse().ok()?;
    let mo: i64 = rest.get(4..6)?.parse().ok()?;
    let d: i64 = rest.get(6..8)?.parse().ok()?;
    let h: i64 = rest.get(9..11)?.parse().ok()?;
    let mi: i64 = rest.get(11..13)?.parse().ok()?;
    let s: i64 = rest.get(13..15)?.parse().ok()?;

    // 只排除明显不成立的日期（如 13 月、32 日），不做完整日历校验：
    // 这些名字是本程序自己生成的，这里防的是"用户手工改名改坏了"。
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    if h > 23 || mi > 59 || s > 59 {
        return None;
    }

    // 复用本文件里**已有**的那份日期换算（`week_start` / `shift_date` 也在用它）——
    // 各写一份的话，某一处动了闰年处理，另一处就会悄悄算错，
    // 而症状只是"备份列表顺序不对"，几乎联想不到原因。
    let days = days_from_civil(y, mo, d);
    let secs = days
        .checked_mul(86_400)?
        .checked_add(h * 3600 + mi * 60 + s)?;
    u64::try_from(secs).ok()
}

/// 从 PIN 派生密钥，并**实际打开库验证**它是对的，返回那把密钥。
///
/// ⚠️ 调用方拿到密钥后**必须**在用完后 `crypto::zeroize` 掉。
///
/// 为什么返回密钥而不是一个 bool：免密打开（指令 4）需要把
/// "已经验证过的密钥"写进钥匙文件，而派生一次约 0.8 秒 ——
/// 让调用方为了拿密钥再派生一遍纯属浪费，且那第二把密钥大概率没人清零。
pub fn derive_and_verify(data_dir: &Path, pin: &str) -> AppResult<[u8; KEY_LEN]> {
    let db_path = data_dir.join("diary.db");
    let meta = CryptoMeta::load(&crypto::crypto_meta_path(data_dir))?
        .ok_or_else(|| AppError::State("缺少加密元信息，无法验证密码".into()))?;

    // ⚠️ 必须用**元信息里存储的参数**派生，绝不能退回 KdfParams::default()。
    //    否则一旦默认值调整过，老用户会发现"密码明明对却打不开"。
    let salt = meta.salt()?;
    let mut key = crypto::derive_key(pin.as_bytes(), &salt, &meta.params)?;

    match open_verified_connection(&db_path, &key) {
        Ok(conn) => {
            // 校验用的连接必须在这里就丢掉：改密码紧接着要 PRAGMA rekey，
            // 而 rekey 需要独占，多留一个连接会让它拿到 SQLITE_BUSY。
            drop(conn);
            Ok(key)
        }
        Err(e) => {
            // 失败路径也要清零 —— 错的密钥同样是密钥材料，没理由留着。
            crypto::zeroize(&mut key);
            Err(e)
        }
    }
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

    /// 用**现成的密钥**打开已有数据库（免密打开用，指令 4）。
    ///
    /// 与 `unlock` 的唯一区别：密钥不来自 PIN 派生，而是从
    /// `data/auto_login.json` 里读出来的那把（它当初也是派生出来的）。
    ///
    /// 为什么单独开一个入口而不是复用 `unlock`：`unlock` 必须先读
    /// crypto_meta.json 才能派生，而免密路径**不需要也不应该**再派生一次
    /// —— 免密打开的全部意义就是跳过那次约 0.8 秒的 Argon2id。
    ///
    /// ⚠️ 本函数只是**借用**密钥，不清零调用方内存；调用方用完自己清。
    pub fn unlock_with_key(data_dir: &Path, key: &[u8; KEY_LEN]) -> AppResult<Self> {
        let db_path = data_dir.join("diary.db");
        if !db_path.exists() {
            return Err(AppError::State("数据库不存在，需要先初始化".into()));
        }
        // 密钥不对时，open_with_key 内部的 apply_key_and_verify 返回 WrongPin ——
        // 正是调用方用来判断"这把钥匙已过期（比如改过密码）"的信号。
        let vault = Self::open_with_key(&db_path, key)?;
        vault.migrate()?;
        Ok(vault)
    }

    /// 修改主密码。
    ///
    /// 原理：在**已解锁的连接**上执行 `PRAGMA rekey`，SQLCipher 会把整个库
    /// 用新密钥重新加密一遍。不需要自己解密再重写，表结构与数据都不变。
    ///
    /// 为什么绝不用"解密导出 → 用新密码重建"那套：那要求把全部日记解密到
    /// 某个地方（临时文件或内存），而"明文日记在磁盘上停留哪怕一瞬"
    /// 正是这个应用存在的意义所不允许的。
    ///
    /// 步骤顺序不能乱 —— 每一步失败都对应一个"用户以为改了、其实没改"的坑：
    ///   ① 校验新密码格式 —— 此时什么都还没动，不合格就在这里结束
    ///   ② 验证旧密码     —— 用**独立连接**验证，主库纹丝未动
    ///   ③ 派生新密钥     —— 沿用同一份 salt 与 KDF 参数
    ///   ④ `PRAGMA rekey` —— 分界线：这一步成功，密码就真的换了
    ///   ⑤ 换提示语 / ⑥ 同步免密钥匙 —— ④ 之后的收尾
    ///
    /// ⑤⑥ 失败**不算改密码失败**：那时密码已经是新的了，报错只会让用户
    /// 拿旧密码反复试。所以它们被收集成 warnings 交给界面显示，而不是变成 Err。
    ///
    /// 返回"收尾阶段的警告列表"，空列表 = 全部干净。
    ///
    /// ⚠️ 调用方必须保证本方法在**未解锁时不会被调到**（命令层用 with_vault 兜住），
    ///    并且整个调用期间独占连接：rekey 需要独占，后台备份线程会被
    ///    那把 Mutex 自然挡住，不需要额外加锁。
    pub fn change_password(
        &self,
        old_pin: &str,
        new_pin: &str,
        new_hint: Option<String>,
        min_len: usize,
    ) -> AppResult<Vec<String>> {
        // ① 新密码格式。放在最前：不合格时连一次 KDF 都不用跑，更没碰过库。
        crypto::validate_pin(new_pin, min_len)?;

        let data_dir = self
            .db_path
            .parent()
            .ok_or_else(|| AppError::State("无法定位数据目录".into()))?
            .to_path_buf();

        // ② 旧密码必须真的能开库。打不开 → WrongPin，到此为止。
        let mut old_key = derive_and_verify(&data_dir, old_pin)?;
        // 只拿它做验证，用完立刻清掉：新密钥才是接下来要用的那把。
        crypto::zeroize(&mut old_key);

        // ③ 派生新密钥：沿用**同一份 salt 与 KDF 参数**（crypto_meta.json 一个字节都不改）。
        //    换 salt 会让所有历史备份与这份元信息对不上，而备份是救命的 ——
        //    用户真正需要备份的时刻，正是他连密码都搞不清的时候。
        let meta = CryptoMeta::load(&crypto::crypto_meta_path(&data_dir))?
            .ok_or_else(|| AppError::State("缺少加密元信息，无法派生新密钥".into()))?;
        let salt = meta.salt()?;
        let mut new_key = crypto::derive_key(new_pin.as_bytes(), &salt, &meta.params)?;

        let outcome = self.rekey_and_followups(&new_key, &data_dir, new_hint);
        // 无论成功还是中途返回，新密钥都在这里被清掉。
        // 这也是把 ④⑤⑥ 拆出去的唯一理由：留在本方法里任何一个 `?`
        // 都会提前 return，那把密钥就永远留在内存里了。
        crypto::zeroize(&mut new_key);
        outcome
    }

    /// ④⑤⑥：rekey 本体与它之后的收尾。
    fn rekey_and_followups(
        &self,
        new_key: &[u8; KEY_LEN],
        data_dir: &Path,
        new_hint: Option<String>,
    ) -> AppResult<Vec<String>> {
        // ④ 重新加密整个库。成功的瞬间，密码就已经换了。
        //    传法与 PRAGMA key 完全一致（同样是 x'...' 十六进制）。
        let hex_key = new_key.iter().map(|b| format!("{b:02x}")).collect::<String>();
        self.conn
            .pragma_update(None, "rekey", format!("x'{hex_key}'"))
            .map_err(|e| {
                AppError::State(format!(
                    "重新加密失败（密码很可能未改动，请先用原密码试解锁）: {e}"
                ))
            })?;

        // ── 以下两步都已经在"密码换掉了"之后：失败只记警告，不返回 Err。──
        let mut warnings = Vec::new();

        // ⑤ 提示语必须一起换。它存在 lockout.json（库外明文），而
        //    record_success 只清失败次数、不清提示 —— 不改的话，
        //    用户下次输错密码会看到照着**旧密码**写的提示，直接把人带沟里。
        if let Err(e) =
            crypto::LockoutState::update_hint(&crypto::lockout_path(data_dir), new_hint)
        {
            warnings.push(format!("提示语未能更新（{e}），请稍后到设置里重设"));
        }

        // ⑥ 免密开着时必须同步钥匙文件，否则用户重启后免密失效 ——
        //    而他刚做的是"改密码"，完全看不出两者的关联。
        //    文件不存在（免密未开）时是空操作，**不会**凭空创建。
        if let Err(e) = crypto::sync_auto_login_key(data_dir, new_key) {
            warnings.push(format!(
                "免密钥匙文件未能同步（{e}），请关掉免密再重新打开一次"
            ));
        }

        Ok(warnings)
    }

    /// 建立连接并设置密钥。
    ///
    /// 设密钥与验证那一小段是整个加密体系的命门，已抽到模块级的
    /// `apply_key_and_verify()` —— 那里写了三条铁律，改动前请先读它。
    /// 这里只负责"建连接 → 验密钥 → 打开两个必要 pragma"。
    fn open_with_key(db_path: &Path, key: &[u8; KEY_LEN]) -> AppResult<Self> {
        let conn = Connection::open(db_path)?;

        // ⚠️ 这一行必须是连接后的第一条语句：在它之前执行任何其他 SQL，
        //    SQLite 会先按明文读一遍文件头，之后再设密钥也救不回来。
        apply_key_and_verify(&conn, key)?;

        // 外键约束默认关闭，必须显式打开，否则删除日记时附件与标签不会级联清理。
        conn.pragma_update(None, "foreign_keys", "ON")?;
        // WAL 提升并发读写体验；对单用户应用主要是让写入不阻塞读取。
        conn.pragma_update(None, "journal_mode", "WAL")?;

        Ok(Self {
            conn,
            seg: Segmenter::new(),
            db_path: db_path.to_path_buf(),
            // 密钥连同连接一起留下：恢复备份要"丢掉旧连接之后仍然能试开新库"，
            // 靠的就是这一份。详见字段注释与 `session_key`。
            key: *key,
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
    ///   - v2 -> v3：加 `tag.retired`（标签的"删除"改成软删除，见 `schema.rs`
    ///     与 `retire_tag`）。只加列、不动任何已有数据，老库里所有标签的
    ///     retired 默认 0 = "在列表里"，与升级前的可见性完全一致 ——
    ///     用户不该在升级后发现"我的标签少了一个"。
    fn upgrade_from(&self, from: i64) -> AppResult<()> {
        // 先备份再动结构。备份失败就别升了 —— 宁可这次打不开，
        // 也不能在没有退路的情况下去改用户唯一的一份数据。
        self.backup_before_upgrade(from)?;

        let tx = self.conn.unchecked_transaction()?;
        if from < 2 {
            tx.execute_batch("ALTER TABLE entry ADD COLUMN locked INTEGER NOT NULL DEFAULT 0")?;
        }
        if from < 3 {
            tx.execute_batch("ALTER TABLE tag ADD COLUMN retired INTEGER NOT NULL DEFAULT 0")?;
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

    /// 该日期是否已经"写过"（正文非空，**或挂着图片附件**）。
    pub fn is_written(&self, date: &str) -> AppResult<bool> {
        validate_date(date)?;
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM entry WHERE entry_date = ?1 AND {})",
            has_content_sql()
        );
        let n: i64 = self.conn.query_row(&sql, params![date], |r| r.get(0))?;
        Ok(n != 0)
    }

    // -----------------------------------------------------------------------
    // 图片附件（P1 #10）
    // -----------------------------------------------------------------------

    /// 数据目录。由 `db_path` 倒推 —— 与 `change_password` 找那几个库外文件
    /// 是同一套做法：本应用是**便携式**的，数据目录跟着 exe 走，没有全局变量可查。
    fn data_dir(&self) -> AppResult<PathBuf> {
        Ok(self
            .db_path
            .parent()
            .ok_or_else(|| AppError::State("无法定位数据目录".into()))?
            .to_path_buf())
    }

    /// 附件目录（`<数据目录>/attachments/`）。
    fn attachments_dir(&self) -> AppResult<PathBuf> {
        Ok(self.data_dir()?.join("attachments"))
    }

    /// 该日期那一篇是否挂着至少一张附件。日期没有对应行时是 `false`。
    pub fn entry_has_attachment_on(&self, date: &str) -> AppResult<bool> {
        validate_date(date)?;
        let n: i64 = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attachment a
                           JOIN entry e ON e.id = a.entry_id
                           WHERE e.entry_date = ?1)",
            params![date],
            |r| r.get(0),
        )?;
        Ok(n != 0)
    }

    /// 取（必要时**新建**）某一天的 entry 行 id，供附件挂靠。
    ///
    /// 为什么允许建一行正文为空的 entry：用户 2026-09-21 拍板 ——
    /// 在一篇还没写正文的日记里也允许插图片，并且**把附件也算作"写过"**
    ///（见 `has_content_sql()`）。这两件事必须一起做，否则"图存下来了、
    /// 这篇却不算写过"，统计和日历立刻自相矛盾。
    ///
    /// 用 `ON CONFLICT ... DO NOTHING` 而**不是** DO UPDATE：这里绝不能碰
    /// 已有的正文 —— 它只是"把挂靠点准备好"，不是一次保存。
    fn entry_id_ensuring(&self, date: &str) -> AppResult<i64> {
        let now = now_iso();
        self.conn.execute(
            "INSERT INTO entry (notebook_id, entry_date, title, content_md, word_count, mood, created_at, updated_at)
             VALUES (?1, ?2, '', '', 0, NULL, ?3, ?3)
             ON CONFLICT(entry_date) DO NOTHING",
            params![DEFAULT_NOTEBOOK_ID, date, now],
        )?;
        self.conn
            .query_row(
                "SELECT id FROM entry WHERE entry_date = ?1",
                params![date],
                |r| r.get(0),
            )
            .map_err(Into::into)
    }

    /// 存一张图片：校验 → 算 sha256 → 落盘 → 插表。
    ///
    /// 落盘名字由 sha256 决定（`attachments/<sha256>.<ext>`），所以
    /// **同一张图插两次只占一份磁盘**。但表里会有两条记录 —— 这是有意的：
    /// 用户可能在不同位置引用同一张图，删掉其中一处时不该把文件也带走
    ///（见 `delete_attachment`）。
    ///
    /// ⚠️ 落盘和插表**不能放进同一个事务**（文件系统不参与 SQLite 事务）。
    ///    万一是"文件写成功、插表失败"，留下的就是一个孤儿文件 ——
    ///    那正是「清理图片缓存」要清的东西，不会永远赖着。
    pub fn save_attachment(
        &self,
        date: &str,
        file_name: &str,
        declared_mime: &str,
        bytes: &[u8],
    ) -> AppResult<Attachment> {
        validate_date(date)?;
        // 与 save_entry / 标签同口径：锁定的日记不接受任何修改。
        if self.is_locked(date)? {
            return Err(AppError::Validation(
                "这篇日记已锁定，先解锁再插入图片".into(),
            ));
        }
        if bytes.is_empty() {
            return Err(AppError::Validation("这个文件是空的".into()));
        }

        let size = bytes.len() as u64;
        if size > MAX_ATTACHMENT_BYTES {
            return Err(AppError::Validation(format!(
                "单张图片上限 {} MB，这张是 {} MB",
                MAX_ATTACHMENT_BYTES / 1024 / 1024,
                size / 1024 / 1024
            )));
        }
        let (ext, mime) = validate_attachment(file_name, declared_mime, bytes)?;
        let sha = sha256_hex(bytes);

        let entry_id = self.entry_id_ensuring(date)?;

        // 单篇总量闸。同一张图重复插入**不占新配额**（它不会写第二份文件），
        // 否则"把同一张图插三次"就能绕过 50 MB 的上限。
        let existing: i64 = self.conn.query_row(
            "SELECT coalesce(sum(byte_size), 0) FROM attachment WHERE entry_id = ?1",
            params![entry_id],
            |r| r.get(0),
        )?;
        let already: i64 = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM attachment WHERE entry_id = ?1 AND sha256 = ?2)",
            params![entry_id, sha],
            |r| r.get(0),
        )?;
        if already == 0 && existing as u64 + size > MAX_ENTRY_ATTACHMENT_BYTES {
            return Err(AppError::Validation(format!(
                "这一篇的图片总量已经到上限（{} MB）",
                MAX_ENTRY_ATTACHMENT_BYTES / 1024 / 1024
            )));
        }

        let stored_rel = format!("attachments/{sha}.{ext}");
        let dir = self.attachments_dir()?;
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{sha}.{ext}"));
        // 文件已经在（同一张图第二次插入）就直接复用，不重写：省一次 IO，
        // 也免得把可能正被别处读取的文件截断。
        if !path.is_file() {
            std::fs::write(&path, bytes)?;
        }

        let now = now_iso();
        self.conn.execute(
            "INSERT INTO attachment (entry_id, file_name, stored_rel, mime, byte_size, sha256, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![entry_id, file_name, stored_rel, mime, size as i64, sha, now],
        )?;
        let id = self.conn.last_insert_rowid();

        Ok(Attachment {
            id,
            file_name: file_name.to_string(),
            stored_rel,
            abs_path: path.to_string_lossy().to_string(),
            mime,
            byte_size: size as i64,
            sha256: sha,
            created_at: now,
        })
    }

    /// 某一天的全部附件，按插入顺序（先插的在前面）。
    pub fn list_attachments(&self, date: &str) -> AppResult<Vec<Attachment>> {
        validate_date(date)?;
        let data_dir = self.data_dir()?;
        let mut stmt = self.conn.prepare(
            "SELECT a.id, a.file_name, a.stored_rel, a.mime, a.byte_size, a.sha256, a.created_at
             FROM attachment a
             JOIN entry e ON e.id = a.entry_id
             WHERE e.entry_date = ?1
             ORDER BY a.id ASC",
        )?;
        let rows = stmt.query_map(params![date], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
            ))
        })?;

        // 路径解析失败的行（只可能是库被手工改过、`stored_rel` 里塞了 `..`）
        // **跳过而不是整页报错** —— 少显示一张图，比让编辑器打不开好。
        // 真正该被拒绝的访问由 `read_attachment` 挡。
        let mut out = Vec::new();
        for row in rows {
            let (id, file_name, stored_rel, mime, byte_size, sha256, created_at) = row?;
            let Ok(path) = attachment_path(&data_dir, &stored_rel) else {
                continue;
            };
            out.push(Attachment {
                id,
                file_name,
                stored_rel,
                abs_path: path.to_string_lossy().to_string(),
                mime,
                byte_size,
                sha256,
                created_at,
            });
        }
        Ok(out)
    }

    /// 读一张图片的字节，返回 `(mime, bytes)`。
    ///
    /// 这是"图片从磁盘到界面"的**唯一出口**：所有访问都要过
    /// `attachment_path` 的路径穿越检查，命令层还包着 `with_vault`
    ///（未解锁一律拒绝）。
    ///
    /// 为什么不用 Tauri 的 `asset:` 协议让 WebView 自己读文件：本应用的
    /// 数据目录是**便携式**的（跟着 exe 走，见 `commands::resolve_data_dir`），
    /// 而协议的作用域是编译期写死在 `tauri.conf.json` 里的，覆盖不到运行时
    /// 才知道的目录。改成后端读字节，顺带把"这条路径能不能读"收进了我们
    /// 自己的校验里 —— 安全边界反而更清楚。
    pub fn read_attachment(&self, id: i64) -> AppResult<(String, Vec<u8>)> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT stored_rel, mime FROM attachment WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let (stored_rel, mime) =
            row.ok_or_else(|| AppError::Validation(format!("附件不存在（id={id}）")))?;

        let path = attachment_path(&self.data_dir()?, &stored_rel)?;
        match std::fs::read(&path) {
            Ok(bytes) => Ok((mime, bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::Validation(
                "图片文件已经不在磁盘上了。可以在 设置 →【数据与备份】里点「清理图片缓存」把它清掉"
                    .into(),
            )),
            Err(e) => Err(e.into()),
        }
    }

    /// 删一条附件记录，并在**没有别的记录引用同一个文件**时把文件也删掉。
    ///
    /// 为什么不能直接删文件：同一张图可以挂在多处，它们共用
    /// `attachments/<sha256>.<ext>` 这一个文件。删之前必须问一句"还有谁引用它"。
    pub fn delete_attachment(&self, id: i64) -> AppResult<()> {
        let data_dir = self.data_dir()?;
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT stored_rel, sha256 FROM attachment WHERE id = ?1",
                params![id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;
        let (stored_rel, sha) =
            row.ok_or_else(|| AppError::Validation(format!("附件不存在（id={id}）")))?;

        self.conn
            .execute("DELETE FROM attachment WHERE id = ?1", params![id])?;

        let left: i64 = self.conn.query_row(
            "SELECT count(*) FROM attachment WHERE sha256 = ?1",
            params![sha],
            |r| r.get(0),
        )?;
        if left == 0 {
            let path = attachment_path(&data_dir, &stored_rel)?;
            // 文件可能早就没了（手工删过、或上次清理过）—— 不算错：
            // 目标状态本来就是"这个文件不存在"。
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

    /// 清理图片缓存 —— 设置页【数据与备份】里那个按钮。
    ///
    /// 两个方向都清：
    ///   ① 表里有记录、磁盘上文件没了 → 删记录（否则列表里永远挂着一张
    ///      加载不出来的图，点一次报一次错）；
    ///   ② 磁盘上有文件、表里没有任何记录 → 删文件，并把释放的字节数报出来。
    ///
    /// ⚠️ ② 是**无条件删掉 `attachments/` 里所有没人认领的文件**。这个目录是
    ///    本应用自己的缓存目录（见 schema.rs：附件只放这里，绝不放桌面或文档
    ///    根目录），所以"没人认领"就等于垃圾。而且它是用户主动点的按钮，
    ///    不会在后台静默删东西。
    ///
    /// 为什么必须有它：删日记时附件**不会**自动删 —— 外键上的
    /// `ON DELETE CASCADE` 只清表行，文件在磁盘上没人管。所以
    /// "删完日记，图片在一次清理之后才消失"是有意设计的行为。
    pub fn prune_orphan_attachments(&self) -> AppResult<PruneReport> {
        let data_dir = self.data_dir()?;
        let dir = self.attachments_dir()?;

        let all: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare("SELECT id, stored_rel FROM attachment")?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };

        let mut rows_removed = 0usize;
        // 按**文件名**收集"还活着的文件"。不用完整路径：两边都是同一个目录
        // 拼出来的，比字符串不容易被分隔符差异坑到。
        let mut alive: std::collections::HashSet<String> = std::collections::HashSet::new();

        for (id, stored_rel) in &all {
            match attachment_path(&data_dir, stored_rel) {
                Ok(path) if path.is_file() => {
                    if let Some(name) = path.file_name() {
                        alive.insert(name.to_string_lossy().to_string());
                    }
                }
                // 两种情况都留不住这条记录：路径非法（手工改过库）、
                // 或文件已经不在磁盘上。⚠️ 非法路径那条**只删记录**，
                // 绝不照着它去删任何文件 —— 那正是路径穿越想达到的效果。
                _ => {
                    self.conn
                        .execute("DELETE FROM attachment WHERE id = ?1", params![id])?;
                    rows_removed += 1;
                }
            }
        }

        let mut files_removed = 0usize;
        let mut bytes_freed = 0u64;
        if dir.is_dir() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                // 只清文件，不动任何子目录（本应用的附件是平铺的）。
                if !path.is_file() {
                    continue;
                }
                if let Some(name) = path.file_name() {
                    if alive.contains(&name.to_string_lossy().to_string()) {
                        continue;
                    }
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                // 删不掉就跳过（文件被占用等）：下次再点还能试，
                // 不该让整个操作失败 —— 前面已经删掉的记录不该被回滚。
                if std::fs::remove_file(&path).is_ok() {
                    files_removed += 1;
                    bytes_freed += size;
                }
            }
        }

        Ok(PruneReport {
            files_removed,
            rows_removed,
            bytes_freed,
        })
    }

    pub fn find_entry_by_date(&self, date: &str) -> AppResult<Option<Entry>> {
        let entry = self
            .conn
            .query_row(
                "SELECT id, entry_date, title, content_md, word_count, mood, created_at, updated_at, locked,
                        EXISTS(SELECT 1 FROM attachment a WHERE a.entry_id = entry.id)
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
    /// `mood`：1=悲伤 2=受伤 3=茫然 4=愤怒 5=开心（1~5 只是编号，
    /// 无好坏顺序），`None` = 未标记。
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
        //
        // ⚠️ 附件也算"写过"（见 `has_content_sql()`），所以这里要先问一次本篇
        //    有没有图片：下面两张硬闸（心情能不能落库、要不要进索引）都挂在
        //    `indexed` 上，问错了就会出现"图片在、心情却存不进去"或者
        //    "日历上有标记、搜索结果里却没有"。
        //    这**不是**"先查再插"（写库仍然是那一条 `ON CONFLICT`），
        //    只是把判定要用的信息先取出来。
        let indexed = has_content(content_md) || self.entry_has_attachment_on(date)?;

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

    // -----------------------------------------------------------------------
    // 标签
    //
    // 两张表（tag / entry_tag）在建库时就有了，本组方法只是把它们用起来。
    // 外键方向是关键，别改：
    //     entry_tag.entry_id → entry(id) ON DELETE CASCADE
    //     entry_tag.tag_id   → tag(id)   ON DELETE CASCADE
    // 也就是**删标签只删关联行，永远不会碰 entry**；删日记也只删关联行，
    // 标签本身留着（可能还有别的日记在用）。
    // 连接里 `foreign_keys = ON` 已经在 `open_with_key` 打开了 ——
    // SQLite 默认是关的，关着的话 CASCADE 一声不响地不生效，
    // 库里会留下指向已删记录的孤儿关联行。
    // -----------------------------------------------------------------------

    /// 所有标签 + 每个标签的日记篇数（只数"写过"的）。
    ///
    /// 排序按**名字**（忽略大小写），不按篇数：篇数会随用户改日记而变，
    /// 列表跟着重排会让"想点第 3 个"变成灾难；按名字排是稳定的。
    ///
    /// 为什么用两层 LEFT JOIN：**没有关联的标签也要出现**（显示 0 篇）。
    /// 如果内连接过滤掉它们，用户撤掉最后一篇的标签后，这个标签就从界面上
    /// 凭空消失了 —— 而它还在库里，将来重新用上时又冒出来，像灵异事件。
    /// 更要紧的是：界面上看不见它，用户就没有机会去删它。
    ///
    /// ⚠️ 数的是 `count(e.id)` 而不是 `count(*)`：第二个 LEFT JOIN 没配上时
    ///    `e.id` 是 NULL，`count(*)` 会把它数成 1（"0 篇的标签显示 1 篇"）。
    ///
    /// ⚠️ **只列没退休的标签**（`retired = 0`）—— 这就是界面上"删除"这个动作
    ///    的全部效果：让它从此不出现在可选列表里。已经贴过它的日记不受影响
    ///    （`tags_of_entry` 不过滤 retired），历史原样保留。
    ///
    ///    代价是会出现"某篇日记挂着一个列表里找不到的标签"这种状态 ——
    ///    这是**故意**的，不是 bug：用户要的正是"我以后不用它了，
    ///    但别动我写过的东西"。要把它从那一篇上摘掉，走编辑器里的 chip ×。
    pub fn list_tags(&self) -> AppResult<Vec<TagStat>> {
        let sql = format!(
            "SELECT t.id, t.name, count(e.id)
             FROM tag t
             LEFT JOIN entry_tag et ON et.tag_id = t.id
             LEFT JOIN entry e ON e.id = et.entry_id AND {}
             WHERE t.retired = 0
             GROUP BY t.id, t.name
             ORDER BY t.name COLLATE NOCASE ASC",
            has_content_sql_for("e")
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| {
            Ok(TagStat {
                id: r.get(0)?,
                name: r.get(1)?,
                entry_count: r.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 某天日记上的标签名（按名字排序）。那天没有日记 → 空列表。
    ///
    /// 刻意**不按"写过"过滤**：这里回答的是"挂在这条记录上的标签是什么"。
    /// 能不能改标签是另一回事，由 `set_entry_tags` 把闸（那时才需要正文）。
    /// 多一层过滤只会让"读到的比刚写进去的少"这种怪事出现。
    pub fn tags_of_entry(&self, date: &str) -> AppResult<Vec<String>> {
        validate_date(date)?;
        let mut stmt = self.conn.prepare(
            "SELECT t.name
             FROM tag t
             JOIN entry_tag et ON et.tag_id = t.id
             JOIN entry e ON e.id = et.entry_id
             WHERE e.entry_date = ?1
             ORDER BY t.name COLLATE NOCASE ASC",
        )?;
        let rows = stmt.query_map(params![date], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 整组覆盖某天日记的标签。返回**实际存下来的**标签名（清洗 + 去重 + 排序后）。
    ///
    /// 为什么返回列表而不是 `()`：清洗规则住在后端（去空白、限长、忽略大小写
    /// 去重），前端不可能自己算出完全一致的一份。让它拿后端的结果去刷界面，
    /// 就不会出现"界面上显示「旅行 」而库里是「旅行」"这种两套真相
    /// —— 与免密开关"整体替换 status"是同一条思路。
    ///
    /// 三道硬闸，全在后端，**不靠界面置灰**（置灰只是提示，
    /// 拦不住排队中的自动保存、也拦不住绕过前端的调用）：
    ///
    ///   1. 日记**必须已经存在且有正文**。标签挂的是 `entry_id`，而 entry 行
    ///      是保存正文时产生的（`open_entry` 是纯读取，id = 0）。没有 id 时
    ///      要打标签只有两条路：凭空插一条空行，或写库失败。前者会直接破坏
    ///      **"打开 ≠ 写过"** 这条铁律（日历标记、统计、搜索全按正文判定），
    ///      所以这里明确报错，把"给空日记打标签"挡在数据层。
    ///   2. 日记**已锁定**时拒绝：锁定 = 只读，标签也是这篇日记的一部分。
    ///      与 `save_entry` / `delete_entry` 同一口径（那里也是硬约束）。
    ///   3. **整组覆盖**：传什么就是什么，不做"增量猜测"。前端加一个标签就传
    ///      全集，撤一个也传全集，语义永远只有一个。
    ///
    /// ⚠️ 撤掉某个日记的标签**不会**顺手删掉"没人用的标签行"。
    ///    清理是显式动作（`retire_tag`）：自动删会产生"我撤了 A 篇的标签，
    ///    另外 B 篇上的同名标签也没了"这种看不懂的行为 ——
    ///    除非那真的是用户想要的（那是"合并/清理"，另一个功能）。
    ///
    /// ⚠️ 传进来的名字可能命中一个**退休**标签（用户之前"删"过它）。这时
    ///    本轮不动它 —— 除非这次是把它**新挂到某一篇**上，那才算"我又要用
    ///    它了"，顺手复活。判据的细节写在下面插入关联那段。
    pub fn set_entry_tags(&self, date: &str, tags: &[String]) -> AppResult<Vec<String>> {
        validate_date(date)?;
        if self.is_locked(date)? {
            return Err(AppError::Validation(
                "这篇日记已锁定，先解锁再改标签".into(),
            ));
        }
        let names = normalize_tag_names(tags)?;

        // "删"与"插"必须同一个事务：分开写的话，中途失败会留下半套标签
        //（旧的删了、新的还没插 —— 用户看到的是"标签全没了"）。
        let tx = self.conn.unchecked_transaction()?;

        // 闸 1：必须存在"写过的"那一行。判定走同一条 has_content_sql()，
        // 与日历标记、月度统计、搜索索引用的是同一个口径。
        let entry_id: Option<i64> = tx
            .query_row(
                &format!(
                    "SELECT id FROM entry WHERE entry_date = ?1 AND {}",
                    has_content_sql()
                ),
                params![date],
                |r| r.get(0),
            )
            .optional()?;
        let Some(entry_id) = entry_id else {
            return Err(AppError::Validation(
                "这篇还没有内容，先写点内容再打标签".into(),
            ));
        };

        // ① 让每个标签存在，并取回它的 id。
        //
        // ⚠️ 必须"先 INSERT OR IGNORE，再 SELECT"两步，**不能用
        //    `last_insert_rowid()`**：名字已存在时那一条被 OR IGNORE 跳过，
        //    而 `last_insert_rowid()` 返回的是**上一次成功插入的 id** ——
        //    拿它当这个标签的 id，会把标签静默挂到别的标签身上。
        let mut tag_ids: Vec<i64> = Vec::with_capacity(names.len());
        for name in &names {
            tx.execute(
                "INSERT OR IGNORE INTO tag (name) VALUES (?1)",
                params![name],
            )?;
            let id: i64 = tx.query_row(
                "SELECT id FROM tag WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )?;
            tag_ids.push(id);
        }

        // ② 算差集：删掉这次没给的，补上新增的。
        //    刻意**不是**"全删再全插" —— 差集不动没变的那部分，
        //    写入量最小，也让"哪条关联真的动过"一眼看得出来。
        let existing: Vec<i64> = {
            let mut stmt = tx.prepare("SELECT tag_id FROM entry_tag WHERE entry_id = ?1")?;
            let rows = stmt.query_map(params![entry_id], |r| r.get(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        for old_id in existing {
            if !tag_ids.contains(&old_id) {
                tx.execute(
                    "DELETE FROM entry_tag WHERE entry_id = ?1 AND tag_id = ?2",
                    params![entry_id, old_id],
                )?;
            }
        }
        for tag_id in &tag_ids {
            // OR IGNORE：已经在表里的关联不重复插（差集已经排除了，
            // 但这条路必须自己也是安全的 —— 将来若有人改成增量调用，
            // 这里不该炸）。
            //
            // 返回值顺便用来判断"这是不是一次**新挂上**的动作"：
            // 插进去了 = 1，被 OR IGNORE 跳过 = 0。
            let freshly_linked = tx.execute(
                "INSERT OR IGNORE INTO entry_tag (entry_id, tag_id) VALUES (?1, ?2)",
                params![entry_id, tag_id],
            )? > 0;

            // 复活退休标签 —— 但**只在"新挂上"的时候**。
            //
            // 判据必须是"这一篇原来没有它、这次新挂上"，而不是"名单里有它"：
            // 前端提交的是**整组**（带上了这篇老日记原有的标签），所以一篇
            // 老日记只要被编辑一次，它身上那个退休标签就会出现在名单里。
            // 若据此复活，用户就会看到"我删掉的标签自己冒回来了"。
            // 反过来，用户在新的一篇上亲手敲这个名字 = 明确要再用它 → 复活。
            // 不复活的话它会变成"隐形标签"：挂着、读得出、但列表里没有，
            // 想再删一次都点不到。
            if freshly_linked {
                tx.execute(
                    "UPDATE tag SET retired = 0 WHERE id = ?1 AND retired = 1",
                    params![tag_id],
                )?;
            }
        }

        tx.commit()?;

        // 回读一次再返回 —— 让"返回的就是库里的"这件事真的成立，
        // 而不是把请求原样回给前端（那等于让前端自己给自己当裁判）。
        self.tags_of_entry(date)
    }

    /// 标签改名。新名字已被**别的**标签占用时返回 validation 错误，**不合并**。
    ///
    /// 为什么不合并：改名和合并是两件事。"把「旅行」改成「远行」"用户要的是
    /// 换个词；而"这两批日记从此归到同一个标签下"是一次**数据合并**，
    /// 影响面大得多（可能几百条关联行要重挂），不该由一次手滑的改名触发。
    /// 真要合并，就该明说"合并"—— 那是另一个功能，不是这个函数的隐式行为。
    ///
    /// 返回清洗后的最终名字（前端拿它回显，别自己再 trim 一份）。
    pub fn rename_tag(&self, id: i64, new_name: &str) -> AppResult<String> {
        let mut names = normalize_tag_names(&[new_name.to_string()])?;
        let Some(name) = names.pop() else {
            return Err(AppError::Validation("标签名不能为空".into()));
        };

        // 这个名字现在归谁？`tag.name` 是 COLLATE NOCASE，所以这里比的是
        // 折了大小写之后的结果（travel 与 Travel 会撞上）。
        let owner: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM tag WHERE name = ?1",
                params![name],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(other) = owner {
            if other != id {
                return Err(AppError::Validation(format!(
                    "已有同名标签「{name}」，没有改名"
                )));
            }
            // 名字是它自己 → 放行。这条分支不是多余的：用户可能只想改个
            // 大小写（travel → Travel），对 NOCASE 而言"名字没变"，
            // 但显示的样子变了，仍然要落库。
        }

        let changed =
            self.conn
                .execute("UPDATE tag SET name = ?1 WHERE id = ?2", params![name, id])?;
        if changed == 0 {
            return Err(AppError::Validation("标签不存在（可能已被删除）".into()));
        }
        Ok(name)
    }

    /// 让一个标签"退休"。**这就是界面上「删除」按钮的全部行为。**
    ///
    /// 只把 `retired` 置 1：
    ///   - 它从此不再出现在 `list_tags`（可选列表 / 侧栏）里；
    ///   - 而**已经贴过它的日记照旧显示它**（`tags_of_entry` 不过滤 retired）。
    ///
    /// ⚠️ 为什么不再用 `DELETE FROM tag`（2026-09-21 改）
    ///    外键是 `entry_tag.tag_id → tag(id) ON DELETE CASCADE`，真删会
    ///    **连坐清掉关联行** —— 那几篇日记上的标签凭空消失。用户的原话是
    ///    "这个标签对应的日记还是这个标签……把它删去比较节约地方，而不是将
    ///    以前的对应标签都删去"：他要的只是"别再出现在我眼前"，不是"把历史
    ///    改掉"。软删除一次满足这两个诉求，而且改名传播、篇数统计、同名合并
    ///    这三件好处一条都不用丢（硬删 + 反规范化都会丢）。
    ///
    /// 返回**有几篇日记挂着它**，用来给用户一句实话：
    /// "已移除「旅行」——另有 2 篇日记仍保留这个标签"。
    /// 不说的话，用户看见"删除"两个字就会担心自己的日记被动了。
    ///
    /// 幂等：标签不存在 / 已经退休都不报错（界面上连点两下不该炸）。
    /// ⚠️ 重复调用返回的仍是"挂着它的篇数"（关联行一直都在），不是 0。
    pub fn retire_tag(&self, id: i64) -> AppResult<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let affected: i64 = tx.query_row(
            "SELECT count(*) FROM entry_tag WHERE tag_id = ?1",
            params![id],
            |r| r.get(0),
        )?;
        // ⚠️ 是 UPDATE 而不是 DELETE —— 见上面的说明，关联行一行都不碰。
        tx.execute("UPDATE tag SET retired = 1 WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(affected as usize)
    }

    /// 只数"写过"的日记篇数。
    ///
    /// 单独抽出来，是因为有两个调用方**只要这一个数字**（改密码后要不要备份、
    /// 自动备份前判断库是不是空的）—— 它们不该为此走一遍全表日期。
    /// 判定口径仍然只有一条：`has_content_sql()`。
    pub fn written_entry_count(&self) -> AppResult<i64> {
        let n = self.conn.query_row(
            &format!("SELECT count(*) FROM entry WHERE {}", has_content_sql()),
            [],
            |r| r.get(0),
        )?;
        Ok(n)
    }

    /// 本连接所用的密钥（备份恢复流程专用）。
    ///
    /// 唯一的用法：**换库之前**先把它取出来，换完之后用它判断
    /// "当前密码还能不能打开刚换上来的那个库" —— 见 `commands::restore_backup`。
    ///
    /// ⚠️ 可见性只能是 `pub(crate)`，**绝不能是 `pub`**。
    ///    `db` 模块对外是公开的（集成测试要用），一旦这里是 `pub`，
    ///    这把密钥就会顺着 `Vault` 的公开面漏出去 ——
    ///    而"前端永远拿不到密钥"正是整个加密设计的底线。
    pub(crate) fn session_key(&self) -> &[u8; KEY_LEN] {
        &self.key
    }

    /// 统计：总篇数、总字数、连续写作天数（当前 / 最长）、本周与本月写作天数、
    /// 心情分布、每月字数趋势。
    ///
    /// 全部只统计**写过的**日记（`has_content_sql()`）。
    /// 否则"共 N 篇"会把打开过但没写的空记录也算进去 —— 与用户直觉不符。
    ///
    /// `today` 是 `YYYY-MM-DD`，**由前端传入**，这里不取系统时间。两条理由：
    ///   1. 前端 `todayKey()` 算的是**本地日期**；Rust 侧只有 `SystemTime`（UTC），
    ///      东八区凌晨 0~8 点会被算成前一天 —— 那正是日记应用最不能错的地方
    ///      （见 `utils/date.ts` 顶部那段说明）。
    ///   2. "今天是哪天"全应用只应有一个来源。`list_month` / `written_dates` 的
    ///      日期区间也是前端传的，这里是同一套做法。
    ///
    /// ⚠️ `today` 只影响**本周 / 本月**两项。连续天数不依赖它（见下面的口径）。
    pub fn stats(&self, today: &str) -> AppResult<Stats> {
        validate_date(today)?;

        let total_entries = self.written_entry_count()?;
        let total_words: i64 = self.conn.query_row(
            &format!(
                "SELECT coalesce(sum(word_count),0) FROM entry WHERE {}",
                has_content_sql()
            ),
            [],
            |r| r.get(0),
        )?;

        // 只取写过的日期，否则打开过的空日期会把"连续"打断（或错误地连起来）。
        // 这次是**升序**取。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entry_date FROM entry WHERE {} ORDER BY entry_date ASC",
            has_content_sql()
        ))?;
        let dates: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?;

        // 连续天数：**一次遍历同时算出「当前连续」与「最长连续」**。
        // 规则本身（以及"为什么必须一次算完"）都收在 `longest_and_current_run` 里，
        // 这里只负责把"相接"的判定传进去 —— 统计页的口径就是**逐日相接**。
        let (streak, longest) =
            longest_and_current_run(&dates, |d, p| Ok(previous_date(d)? == p))?;

        // 本周 / 本月写作天数：直接在**已经取出来的日期**上过滤，不再多跑两条 SQL。
        // 日期是定长 ISO 字符串，字典序即时间序，所以能直接比字符串。
        let week_start = week_start(today)?;
        let week_end = shift_date(&week_start, 6)?;
        let month_prefix = &today[0..7];
        let days_this_week = dates
            .iter()
            .filter(|d| d.as_str() >= week_start.as_str() && d.as_str() <= week_end.as_str())
            .count() as i64;
        let days_this_month = dates
            .iter()
            .filter(|d| d.starts_with(month_prefix))
            .count() as i64;

        // 心情分布：只在"有正文"的行上数 —— 库里有"有 mood 没正文"的历史脏行，
        // 口径必须与日历的 written_moods() 一致。
        // 没出现过的档位不返回（由前端按 MOODS 补 0）。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT mood, count(*) FROM entry
             WHERE mood IS NOT NULL AND {}
             GROUP BY mood ORDER BY mood",
            has_content_sql()
        ))?;
        let mood_counts: Vec<MoodCount> = stmt
            .query_map([], |r| {
                Ok(MoodCount {
                    mood: r.get(0)?,
                    count: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        // 每月字数趋势：按 entry_date 的前 7 位（YYYY-MM）分组。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT substr(entry_date, 1, 7) AS m, coalesce(sum(word_count), 0) FROM entry
             WHERE {}
             GROUP BY m ORDER BY m ASC",
            has_content_sql()
        ))?;
        let monthly_words: Vec<MonthWords> = stmt
            .query_map([], |r| {
                Ok(MonthWords {
                    month: r.get(0)?,
                    words: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        // 热力图：窗口内**写过**的每一天。窗口口径见 `heatmap_window`。
        //
        // 三个要点：
        //   1. `has_content_sql()` 用 `format!` 拼进去 —— 既有的写法（上面 5 处同款），
        //      这段 SQL 是常量，不是注入。**绝不许自己写 `content_md <> ''`**：
        //      那就是第二套"算不算写过"的判定，而且它会漏掉"纯图片日"。
        //   2. 上限用 `heatmap_end` 而不是 `today` —— 让"未来日期"的记录也能显示。
        //   3. `sum` ＋ `GROUP BY` 是防御性的：当前 `UNIQUE(entry_date)` 保证一天一行，
        //      直接取 `word_count` 也对；但 V2 多日记本会把唯一约束改成
        //      `UNIQUE(notebook_id, entry_date)`，那时这里就会多行。现在加零成本。
        let (heatmap_start, heatmap_end) = heatmap_window(today)?;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entry_date, coalesce(sum(word_count), 0) FROM entry
             WHERE {}
               AND entry_date >= ?1 AND entry_date <= ?2
             GROUP BY entry_date
             ORDER BY entry_date ASC",
            has_content_sql()
        ))?;
        let daily_words: Vec<DayWords> = stmt
            .query_map([&heatmap_start, &heatmap_end], |r| {
                Ok(DayWords {
                    date: r.get(0)?,
                    words: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;

        Ok(Stats {
            total_entries,
            total_words,
            streak_days: streak,
            // dates 是升序：第一个是最早，最后一个是最近。
            first_date: dates.first().cloned(),
            last_date: dates.last().cloned(),
            longest_streak: longest,
            days_this_week,
            days_this_month,
            mood_counts,
            monthly_words,
            heatmap_start,
            heatmap_end,
            daily_words,
        })
    }

    /// 「回顾」那一屏的数据（P2-23）。**只读**，且只在前端点开「旧影」时才算一次
    /// —— ⛔ 不并进 `stats()`（那条已经装了 8 个数字，热力图还要往里加）。
    ///
    /// 三条查询 ＋ 一份名单：
    ///   ① 写得最长的一篇；② 照片最多的一篇；③ 最长连续同一种心情；
    ///   ④ `days` ＝ 所有写过的日子（给「往年今天」取内容用）。
    ///
    /// ⚠️ `today` **只用来校验**（与 `stats` 同款，前端传、后端不自己取系统时间）。
    ///    本函数的返回值与"今天"无关 —— 真正跟今天有关的那一块（往年今天）
    ///    由前端用 `sameDayInPastYears()` 算，判定只有这样才只有一份。
    ///
    /// ⚠️ 全套走 `has_content_sql()`：口径与"共 N 篇"天生一致。
    pub fn recap(&self, today: &str) -> AppResult<Recap> {
        validate_date(today)?;

        // ① 写得最长的一篇（并列时取**更近**的那天 —— 近期的事更值得翻出来）。
        //
        // `word_count > 0`：只有图片、一个字没写的日记**不该叫"写得最长"**。
        // 不写这半句的话，库里若全是纯图片日记，这块会显示"写得最长的一篇 · 0 字"。
        let longest_entry = self
            .conn
            .query_row(
                &format!(
                    "SELECT entry_date, word_count, mood, content_md FROM entry
                     WHERE {} AND word_count > 0
                     ORDER BY word_count DESC, entry_date DESC LIMIT 1",
                    has_content_sql()
                ),
                [],
                |r| {
                    Ok(DayDigest {
                        date: r.get(0)?,
                        words: r.get(1)?,
                        mood: r.get(2)?,
                        preview: make_preview(&r.get::<_, String>(3)?),
                    })
                },
            )
            .optional()?;

        // ② 照片最多的一篇（并列时取更近的那天）。
        //
        // ⚠️ **不按 mime 过滤**：附件只可能是图片（`ATTACHMENT_TYPES` 只收
        //    png/jpg/jpeg/gif/webp，而且是扩展名＋MIME＋文件头三重校验）。
        // ⚠️ `JOIN` 本身就保证了"至少有一张图" ⇒ 一张图都没有时这块自然是 `None`，
        //    不需要（也不许）用"0 张"的日子来占位。
        let most_photos = self
            .conn
            .query_row(
                &format!(
                    "SELECT e.entry_date, count(*) AS photos
                     FROM entry e JOIN attachment a ON a.entry_id = e.id
                     WHERE {}
                     GROUP BY e.id
                     ORDER BY photos DESC, e.entry_date DESC LIMIT 1",
                    has_content_sql_for("e")
                ),
                [],
                |r| {
                    Ok(PhotoTop {
                        date: r.get(0)?,
                        photos: r.get(1)?,
                    })
                },
            )
            .optional()?;

        // ③ 连续同一种心情。
        //
        // 先把"有心情**且**有正文"的日子按升序取出来，再**按心情分组**，
        // 每组各自跑一遍那个公用零件 —— 判定循环全项目仍然只有一份。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entry_date, mood FROM entry
             WHERE mood IS NOT NULL AND {}
             ORDER BY entry_date ASC",
            has_content_sql()
        ))?;
        let moods: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;

        // `BTreeMap` 而不是 `HashMap`：键升序 ⇒ 天数并列时**编号小的赢**，
        // 结果稳定、可复现。（这不代表 1 比 5 好 —— 五种心情是并列的。）
        let mut by_mood: std::collections::BTreeMap<i64, Vec<String>> =
            std::collections::BTreeMap::new();
        for (date, mood) in moods {
            by_mood.entry(mood).or_default().push(date);
        }

        let mut mood_streak: Option<MoodStreak> = None;
        for (mood, dates) in &by_mood {
            let run = longest_run(dates, |d, p| Ok(previous_date(d)? == p))?;
            if run.longest == 0 {
                continue;
            }
            // 天数没有更长就留着当前这个（严格大于才换）⇒ 并列时保住编号小的那个。
            if mood_streak.as_ref().is_some_and(|b| b.days >= run.longest) {
                continue;
            }
            // ⭐ 起止日**直接从真实写过的日期里取下标**，⛔ 绝不按天数往前推算 ——
            //    推算会撞上闰日，而且算出来那天未必真写过。
            let from = dates[run.longest_start].clone();
            let to = dates[run.longest_start + run.longest as usize - 1].clone();
            mood_streak = Some(MoodStreak {
                mood: *mood,
                days: run.longest,
                from,
                to,
            });
        }

        // ④ 所有写过的日子（含纯图片日），按日期升序。
        //
        // ⚠️ 正文只取前 300 个字符：`make_preview` 最多要 60 个字，多取没用。
        //    这**不是**第二套"取开头"的实现，只是限制传输量 ——
        //    真正的取开头逻辑仍然只有 `make_preview` 一处。
        // ⚠️ `coalesce(content_md, '')`：这一列历史上可以为 NULL。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entry_date, mood, word_count, substr(coalesce(content_md, ''), 1, 300)
             FROM entry WHERE {} ORDER BY entry_date ASC",
            has_content_sql()
        ))?;
        let days: Vec<DayDigest> = stmt
            .query_map([], |r| {
                Ok(DayDigest {
                    date: r.get(0)?,
                    mood: r.get(1)?,
                    words: r.get(2)?,
                    preview: make_preview(&r.get::<_, String>(3)?),
                })
            })?
            .collect::<Result<_, _>>()?;

        Ok(Recap {
            longest_entry,
            most_photos,
            mood_streak,
            days,
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

    // -----------------------------------------------------------------------
    // Markdown 导出（P1 #11）
    //
    // 目的只有一个：**别把用户的日记锁死在这个软件里**。所以这里全部取向
    // 都是"宁可土、也要让产物是纯文本、可直接丢进任何编辑器"。
    //
    // 两条铁律：
    //   1. 正文**原样输出 `content_md`**，绝不经过 Markdown 渲染再转回来。
    //      渲染是有损的：软换行被吃掉、行首缩进被吞、表格里的对齐空格被重排。
    //      用户手动排的版式是他写的东西的一部分。
    //   2. **锁定不影响导出**。锁定是"防误改"，不是"防读"
    //      （见 schema.rs 里 `locked` 列的说明）；导出是读。
    // -----------------------------------------------------------------------

    /// 导出**一篇**日记为 Markdown 文本（front-matter + 正文原文）。
    ///
    /// 只返回字符串、不落盘：给"复制为 Markdown"这类需要拿到文本的调用方用。
    /// 落盘的全库导出走 `export_markdown`，两者共用同一个渲染函数 ——
    /// 否则"复制出来的"和"导出出来的"迟早长得不一样。
    ///
    /// 那一天**根本没有记录**时返回 `validation` 错误；有记录但正文是空的
    /// （打开过没写）照常返回，因为这是一个"指名道姓要某天"的调用，
    /// 要不要空内容由调用方决定，这里不做二次筛选。
    pub fn export_entry_markdown(&self, date: &str) -> AppResult<String> {
        validate_date(date)?;
        let row = self
            .conn
            .query_row(
                "SELECT title, content_md, word_count, mood FROM entry WHERE entry_date = ?1",
                params![date],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, Option<i64>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((title, content_md, word_count, mood)) = row else {
            return Err(AppError::Validation(format!("{date} 这一天还没有日记")));
        };
        let tags = self.tags_of_entry(date)?;
        Ok(render_entry_md(
            date,
            &title,
            mood,
            &tags,
            word_count,
            &content_md,
        ))
    }

    /// 把整个库导出成 Markdown 文件树。
    ///
    /// 产物形状：
    /// ```text
    /// <dest>/
    ///   index.md                  全部日记的日期 + 标题 + 链接
    ///   2026/09/2026-09-18.md     单篇（front-matter + 正文原文）
    /// ```
    ///
    /// 为什么按 年 / 月 分两层目录：全塞在一层里，几千篇之后连资源管理器
    /// 打开都要卡；而 `2026/09` 这种分法用户自己也会这么整理。
    ///
    /// ⚠️ 文件名**只用日期**。标题可能含 `/ \ : * ? " < > |` 和换行
    ///    （全是 Windows 文件名非法字符），拿标题当文件名轻则建不出文件、
    ///    重则被用来做目录穿越。标题只出现在 front-matter 里。
    ///
    /// ⚠️ 只导"写过"的（`has_content_sql()`），数量与统计里的"共 N 篇"
    ///    严格一致 —— 用户会当场拿这两个数字对着看。
    pub fn export_markdown(&self, dest_dir: &str) -> AppResult<ExportResult> {
        if dest_dir.trim().is_empty() {
            return Err(AppError::Validation("导出目录不能为空".into()));
        }
        let dest = Path::new(dest_dir.trim());
        std::fs::create_dir_all(dest)?;
        // 归一化后再回显：用户可能填的是相对路径或带 `..`，而他下一步要去
        // 文件管理器里找这个目录 —— 回显一个"实际生成的绝对路径"才用得上。
        let dest = std::fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());

        // 一次把所有标签取齐并按 entry_id 归组。不这么做就得每篇查一次，
        // 全库导出下就是 N+1 次查询（几千篇时会明显卡）。
        let mut tags_by_entry: HashMap<i64, Vec<String>> = HashMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT et.entry_id, t.name
                 FROM entry_tag et
                 JOIN tag t ON t.id = et.tag_id
                 ORDER BY t.name COLLATE NOCASE ASC",
            )?;
            let rows =
                stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
            for row in rows {
                let (entry_id, name) = row?;
                tags_by_entry.entry(entry_id).or_default().push(name);
            }
        }

        // 升序导出：index.md 读起来像一本书。日历与统计用倒序是"最近优先"，
        // 那是给日常使用看的；导出是给存档看的，两者取向不同。
        let mut stmt = self.conn.prepare(&format!(
            "SELECT id, entry_date, title, content_md, word_count, mood
             FROM entry
             WHERE {}
             ORDER BY entry_date ASC",
            has_content_sql()
        ))?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })?;

        let mut renamed = 0usize;
        // (日期, 标题, 落盘相对路径) —— index.md 就用这三样渲染。
        let mut index_rows: Vec<(String, String, String)> = Vec::new();
        for row in rows {
            let (id, date, title, content_md, word_count, mood) = row?;
            // entry_date 恒为 `YYYY-MM-DD`（写入时校验过），按字节切片安全。
            let (year, month) = (&date[0..4], &date[5..7]);
            let rel = Path::new(year).join(month).join(format!("{date}.md"));
            let tags = tags_by_entry.get(&id).cloned().unwrap_or_default();
            let body = render_entry_md(&date, &title, mood, &tags, word_count, &content_md);
            let written = self.write_export_file(dest.join(&rel), &body)?;
            if written != dest.join(&rel) {
                renamed += 1;
            }
            // 链接里一律用 `/`：Markdown 链接是给别的编辑器/渲染器读的，
            // Windows 的反斜杠在那边不是路径分隔符。
            let rel_written = written
                .strip_prefix(&dest)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| rel.to_string_lossy().replace('\\', "/"));
            index_rows.push((date, title, rel_written));
        }

        let index_text = render_index_md(&index_rows);
        let index_path = self.write_export_file(dest.join("index.md"), &index_text)?;
        if index_path != dest.join("index.md") {
            renamed += 1;
        }

        Ok(ExportResult {
            dest_dir: dest.to_string_lossy().to_string(),
            entry_count: index_rows.len(),
            renamed,
            index_path: index_path.to_string_lossy().to_string(),
        })
    }

    /// 写一个导出文件，**绝不覆盖已有文件**（重名就在扩展名前加 ` (1)`）。
    ///
    /// 为什么宁可加后缀也不覆盖：导出目录是用户自己挑的，完全可能选到
    /// "文档"这种本来就有一堆文件的地方。同名就覆盖＝悄悄毁掉用户的文件，
    /// 这对一个"防止数据被锁死"的功能来说是最坏的结果。
    ///
    /// 返回**实际写入**的路径（可能带后缀）。
    fn write_export_file(&self, path: PathBuf, content: &str) -> AppResult<PathBuf> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let target = non_conflicting_path(&path)?;
        std::fs::write(&target, content)?;
        Ok(target)
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

    /// 读取应用设置。
    ///
    /// **刻意不报错**：缺失 / 解析失败 / 值不在白名单，一律回落默认值。
    /// 理由：老库（1.6 及之前）里根本没有 `auto_lock_secs` 这个 key，
    /// 而这是一条"每次解锁都要读"的路径 —— 为它抛错会让升级上来的库
    /// 一打开就报错，而用户什么都没做错。
    /// 库里的值被外部工具改坏（比如写了 123）也是同一条兜底。
    pub fn get_settings(&self) -> AppResult<AppSettings> {
        let secs = self
            .get_setting(setting_keys::AUTO_LOCK_SECS)?
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| AUTO_LOCK_ALLOWED_SECS.contains(v))
            .unwrap_or(DEFAULT_AUTO_LOCK_SECS);
        // 「离开日记时自动锁定」：**只有精确写着 "false" 才算关**，
        // 其余（缺失 / 空串 / 数字 / 别的词）一律按 **开** 处理。
        //
        // ⚠️ 这里的兜底方向是"继续锁"，与 `auto_backup_enabled()` 的
        //    `v == "true"` 正好相反 —— 因为两项读错方向的代价不对称：
        //    备份读错最多是少备一份（还有"立即备份"兜底，用户也看得见），
        //    而锁定读错是**静默地失去保护**：用户不会发现某天的日记没被
        //    锁上，直到误删。宁可"以为关了、其实还锁着"（他看得见，
        //    也能再关一次），也不要反过来。
        let auto_lock_entries = self
            .get_setting(setting_keys::AUTO_LOCK_ENTRIES)?
            .map(|v| v.trim() != "false")
            .unwrap_or(DEFAULT_AUTO_LOCK_ENTRIES);
        // 「三击左键快速解锁」（指令 15）：与上一项**同一口径** ——
        // 只有精确写着 "false" 才算关，其余（缺失 / 空串 / 数字 / 别的词）
        // 一律按 **开** 处理；老库没有这个 key 也走同一个默认值。
        //
        // 口径统一是为了"少一份要记的规则"：这只是一个解锁手势，
        // 读错方向的代价远小于 `auto_lock_entries`（不涉及保护被静默关掉）。
        let triple_click_unlock = self
            .get_setting(setting_keys::TRIPLE_CLICK_UNLOCK)?
            .map(|v| v.trim() != "false")
            .unwrap_or(DEFAULT_TRIPLE_CLICK_UNLOCK);
        Ok(AppSettings {
            auto_lock_secs: secs,
            auto_lock_entries,
            triple_click_unlock,
        })
    }

    /// 写入自动锁定时长（秒）。
    ///
    /// 白名单之外的值返回 `validation` 错误 —— 这个值安全相关，
    /// 让界面能写进任意数字，等于把"自动锁定"交给一个可能出错的 UI。
    pub fn set_auto_lock_secs(&self, secs: u32) -> AppResult<()> {
        if !AUTO_LOCK_ALLOWED_SECS.contains(&secs) {
            let allowed = AUTO_LOCK_ALLOWED_SECS
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(" / ");
            return Err(AppError::Validation(format!(
                "自动锁定时长只能是 {allowed} 秒之一（0 表示永不）"
            )));
        }
        self.set_setting(setting_keys::AUTO_LOCK_SECS, &secs.to_string())
    }

    /// 写入「离开日记时自动锁定」（指令 14）。
    ///
    /// 与 `set_auto_lock_secs` 不同，这一项**没有白名单要校验** ——
    /// 参数就是 `bool`，非法值在类型上根本进不来。
    ///
    /// ⚠️ 它**不会**去动任何已经锁上的日记：开关只管"以后要不要自动锁"。
    ///    顺手把已锁的解开，就成了"改个设置把所有保护一次性抹掉"。
    pub fn set_auto_lock_entries(&self, on: bool) -> AppResult<()> {
        self.set_setting(
            setting_keys::AUTO_LOCK_ENTRIES,
            if on { "true" } else { "false" },
        )
    }

    /// 写入「三击左键快速解锁」（指令 15）。
    ///
    /// 与 `set_auto_lock_entries` 同一形状：无白名单可校验（参数就是 `bool`），
    /// 也**不去动任何已经锁上的日记** —— 它只是开关一个解锁手势。
    pub fn set_triple_click_unlock(&self, on: bool) -> AppResult<()> {
        self.set_setting(
            setting_keys::TRIPLE_CLICK_UNLOCK,
            if on { "true" } else { "false" },
        )
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

/// 统计面板要用的全部数字（一次取齐 —— 面板只调一条命令）。
///
/// ⚠️ 加字段要**同时改前端**：`api/index.ts` 里那份 `Stats` interface 是手抄的，
///    不会自动跟着变；漏了会在运行时读到 `undefined`（编译期查不出来）。
#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub total_entries: i64,
    pub total_words: i64,
    /// **当前连续**：以最新写过的日期收尾的那一段连续天数。
    ///
    /// ⚠️ 口径是"从最近一篇往前逐日相接"，**不是**"必须写到今天" ——
    ///    今天还没写、昨天写了，仍然显示到昨天为止的天数（用户 2026-09-21 拍板）。
    ///    所以界面必须标注"截至 {last_date}"，否则用户会以为今天是断的。
    pub streak_days: i64,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    /// **最长连续**：历史上最长的那一段（断一天再写，当前归 1，但这里保留纪录）。
    pub longest_streak: i64,
    /// 本周（**周一起算**）写过日记的天数。以 `stats(today)` 的 today 为基准。
    pub days_this_week: i64,
    /// 本月写过日记的天数。同样以 today 为基准。
    pub days_this_month: i64,
    /// 各心情档位各出现过多少次。**没出现过的档位不会出现**在结果里，
    /// 由前端按 `MOODS` 补 0（心情档位表全项目只留一份）。
    pub mood_counts: Vec<MoodCount>,
    /// 每月字数趋势，按月份升序。没有内容的月份不会出现（前端会补 0 格）。
    pub monthly_words: Vec<MonthWords>,
    /// 热力图窗口的第一天。**一定是周一**。
    pub heatmap_start: String,
    /// 热力图窗口的最后一天（含）。**一定是周日**，且 ≥ today。
    pub heatmap_end: String,
    /// 窗口内"写过"的每一天，按日期升序。
    ///
    /// ⚠️ **没写过的日子不会出现在这里** —— 前端正是据此区分"没写"与"写了 0 字"：
    ///    在窗口内但没有出现在这份名单里的，才是"没写"。
    ///    （"写了 0 字"＝ 只有图片没有文字的日记，它**算写过**，档位是最浅那一档。）
    /// ⚠️ 窗口之外的历史数据**不返回** —— 热力图画的是"这一年"，不是"这辈子"。
    pub daily_words: Vec<DayWords>,
}

/// 一个心情档位的出现次数。
#[derive(Debug, Clone, Serialize)]
pub struct MoodCount {
    /// 1~5，含义见 `api/index.ts` 的 `MOODS`（只是编号，不是程度刻度）。
    pub mood: i64,
    pub count: i64,
}

/// 某个月的总字数。
#[derive(Debug, Clone, Serialize)]
pub struct MonthWords {
    /// `YYYY-MM`
    pub month: String,
    pub words: i64,
}

// ---------------------------------------------------------------------------
// 「回顾」（P2-23）—— 统计页里那一屏「旧影」
// ---------------------------------------------------------------------------

/// 一天的"最小信息"：日期 ＋ 心情 ＋ 字数 ＋ 一句开头。
///
/// 两个用途共用这一个形状，因为它们在界面上长得完全一样：
///   * 「往年今天」的每一条；
///   * 「写得最长的一篇」那一张卡（它就是"某一天"而已）。
///
/// ⚠️ `preview` 由 `make_preview()` 生成 —— 那是**取正文开头的唯一实现**，
///    P2-3（正文富文本）落地后只改它一个（见该函数的说明）。
#[derive(Debug, Clone, Serialize)]
pub struct DayDigest {
    pub date: String,
    pub mood: Option<i64>,
    /// 直接读 `entry.word_count` 列（保存时算好的）。
    /// ⛔ **不许**拿 `content_md` 在这里重数一遍 —— 那会变成第二套"数字数"。
    pub words: i64,
    pub preview: String,
}

/// 「照片最多的一篇」。
#[derive(Debug, Clone, Serialize)]
pub struct PhotoTop {
    pub date: String,
    pub photos: i64,
}

/// 「最长连续同一种心情」。
///
/// ⚠️ `mood` 是**并列的类型、不是刻度**（见 `api/index.ts` 的 `MOODS`）：
///    "连续 5 天开心"与"连续 5 天emo"都是 5 天，不存在"哪种更好"。
#[derive(Debug, Clone, Serialize)]
pub struct MoodStreak {
    pub mood: i64,
    pub days: i64,
    /// 起止**都是真实写过的日期**（从日期列表里取，不是按天数推算的）。
    pub from: String,
    pub to: String,
}

/// 「回顾」那一屏要的全部数据（`getRecap()` → 后端 `recap()`）。
///
/// ⚠️ 加字段要**同时改前端**：`api/index.ts` 里那份 `Recap` interface 是手抄的，
///    不会自动跟着变（同 `Stats` 的说明）。
#[derive(Debug, Clone, Serialize)]
pub struct Recap {
    /// 写得最长的一篇。库里只有纯图片日记时为 `None`（那些日记 `word_count = 0`）。
    pub longest_entry: Option<DayDigest>,
    /// 照片最多的一篇。一张图都没有时为 `None`。
    pub most_photos: Option<PhotoTop>,
    /// 最长连续同一种心情。从没标过心情时为 `None`。
    pub mood_streak: Option<MoodStreak>,
    /// **所有写过的日子**（含纯图片日），按日期升序。
    ///
    /// ⚠️ 这里**不判"往年今天"是哪几天** —— 那句判定在 `utils/date.ts` 的
    ///    `sameDayInPastYears()`，全项目只有一份实现（同"连续判定"那条铁律）。
    ///    前端先用它把要显示的那几天筛出来，再回来这份名单里取内容，
    ///    所以这里给的是**全部**，不是筛过的结果。
    pub days: Vec<DayDigest>,
}

/// 热力图窗口内**写过**的某一天（统计页的 371 个格子里，有颜色的那些）。
#[derive(Debug, Clone, Serialize)]
pub struct DayWords {
    /// `YYYY-MM-DD`
    pub date: String,
    /// 这一天的字数。⚠️ **可能是 0** —— 只有图片、没有文字的日记也算"写过"
    /// （口径同 `has_content_sql()`），它落在**最浅那一档**，不是"没写"。
    pub words: i64,
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
    //
    // ⚠️ 第 10 列（`has_attachment`）由**调用方的 SELECT** 提供，它和
    //    `is_locked()` 用的是同一条"算写过"规则（正文非空 **或** 有附件）——
    //    两边不一致的话，界面会显示成未锁定、后端却拒绝保存
    //    （"这篇日记已锁定，先解锁再修改"）。目前只有一个调用方
    //    `find_entry_by_date`，它的 SELECT 里已经带上了这一列。
    let has_attachment = r.get::<_, i64>(9)? != 0;
    let locked = r.get::<_, i64>(8)? != 0 && (has_content(&content_md) || has_attachment);
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

/// 正文**开头**的一小段，给「回顾」里每一条下面那一行用（P2-23）。
///
/// ⚠️ **这是"取正文开头"的唯一实现。**
///    P2-3（正文富文本）落地后正文里会多出**看不见的格式标记**，届时
///    **只改这一个函数**：先取可见文字、再截。⛔ 别在 `StatsPanel.vue` 里
///    自己 `slice()` —— 那就是第二套实现，P2-3 落地时必然只改一处。
///
/// 与 `make_snippet` 的分工（两者用途不同，**别合并**）：
///   * `make_snippet` 是**搜索命中**用的，窗口要**围绕命中词**；
///   * 这个是**开头**那一小段，永远从第 0 个字起。
///
/// 换行与连续空白一律压成一个空格：摘要是单行的，留着换行会让卡片高度忽高忽低。
/// 全是空白（纯图片日记）时返回空串，由前端决定显示什么。
fn make_preview(content: &str) -> String {
    const MAX: usize = 60;
    let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = text.chars().take(MAX).collect();
    if text.chars().count() > MAX {
        out.push('…');
    }
    out
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

// ---------------------------------------------------------------------------
// Markdown 导出：渲染与文件名
// ---------------------------------------------------------------------------

/// 渲染一篇日记为 Markdown：YAML front-matter + 正文**原文**。
///
/// ⚠️ `content_md` 一字不改地接在 `---` 后面。不要 trim、不要补空行、
///    不要做任何"顺手美化" —— 验收标准就是"导出的 .md 打开后，
///    中文、换行、Markdown 语法完全原样"。
///
/// `mood` 用 `null` 显式写出而不是留空：留空的 `mood:` 在 YAML 里同样是
/// null，但显式写出来，读的人（和解析器）都不必猜这是"没标"还是"忘了写"。
fn render_entry_md(
    date: &str,
    title: &str,
    mood: Option<i64>,
    tags: &[String],
    word_count: i64,
    content_md: &str,
) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str("date: ");
    out.push_str(&yaml_scalar(date));
    out.push('\n');
    out.push_str("title: ");
    out.push_str(&yaml_scalar(title));
    out.push('\n');
    match mood {
        Some(m) => out.push_str(&format!("mood: {m}\n")),
        None => out.push_str("mood: null\n"),
    }
    let quoted: Vec<String> = tags.iter().map(|t| yaml_scalar(t)).collect();
    out.push_str(&format!("tags: [{}]\n", quoted.join(", ")));
    out.push_str(&format!("word_count: {word_count}\n"));
    out.push_str("---\n");
    out.push_str(content_md);
    out
}

/// 渲染 `index.md`：全部日记的日期 + 标题 + 链接。
///
/// 标题在列表项里是**纯文本**，所以要把换行折叠成空格 —— 否则一个带换行的
/// 标题会把 Markdown 列表切碎成好几行。链接路径用 `/` 分隔（见 export_markdown）。
///
/// ⚠️ 刻意**不写导出时间**：那需要用系统时钟，而本项目在"今天是哪天"上
///    已经吃过 UTC 的亏（见 `stats(today)` 的说明）；一个只用于存档的索引
///    不值得再引入一次时区歧义。文件自身的修改时间已经记录了导出时刻。
fn render_index_md(entries: &[(String, String, String)]) -> String {
    let mut out = String::new();
    out.push_str("# 日记索引\n\n");
    out.push_str(&format!("共 {} 篇。\n\n", entries.len()));
    for (date, title, rel) in entries {
        let flat = title.split_whitespace().collect::<Vec<_>>().join(" ");
        if flat.is_empty() {
            out.push_str(&format!("- [{date}]({rel})\n"));
        } else {
            out.push_str(&format!("- [{date}]({rel}) {flat}\n"));
        }
    }
    out
}

/// YAML 标量：能用裸值就用裸值，有歧义才加双引号。
///
/// 为什么不一律加引号：front-matter 是给人看的，`title: 标题` 比
/// `title: "标题"` 顺眼。但**用户什么都可能往标题里打**（冒号、井号、
/// 引号、换行、emoji），裸着写出去就不是合法 YAML 了。
///
/// 判据（保守）：空串、首尾有空白、以 `-` / `?` 开头，或含有 YAML 里有
/// 特殊含义的字符，就整体包进双引号并把内部转义。
///
/// 用**双引号**而不是单引号：YAML 的单引号风格里换行只能折行，没法写
/// "一个真的换行符"；双引号风格支持 `\n` 这类转义序列，正好能表达它。
fn yaml_scalar(s: &str) -> String {
    const SPECIAL: &str = "\n\r\t\"'\\:#[]{},&*!|>%@`";
    let plain_safe = !s.is_empty()
        && s.trim() == s
        && !s.starts_with('-')
        && !s.starts_with('?')
        && !s.chars().any(|c| SPECIAL.contains(c) || c.is_control());
    if plain_safe {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// 目标文件已存在时，在扩展名前追加 ` (1)`、` (2)`… —— **绝不覆盖**。
///
/// ⚠️ `.meta.json` 按**整体**当一个扩展名（见函数内注释）：
///    备份是"两个文件一组"，后缀插错位置会让配对名对不上，
///    复制出来的那一份直接变成打不开的废文件。
///
/// 上千次都撞名说明这个目录已经不是"偶尔重名"了，再往下试没有意义：
/// 这时**报错**而不是退回原路径 —— 退回原路径就等于覆盖，
/// 恰好是这个函数唯一要防的事。
///
/// `pub` 是为了让命令层的「复制备份到…」（P2-5）也用它 ——
/// 那条命令同守"绝不覆盖"，各写一份就等着两处的后缀规则慢慢分叉。
pub fn non_conflicting_path(path: &Path) -> AppResult<PathBuf> {
    if !path.exists() {
        return Ok(path.to_path_buf());
    }
    let parent = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let file = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if file.is_empty() {
        return Err(AppError::State(format!("不是一个文件路径：{}", path.display())));
    }

    // ⚠️ 这里必须把 `.meta.json` 当成**一个**扩展名整体处理。
    //
    // 按普通的"最后一个点"去拆，`diary-20260923-161500.meta.json` 会被拆成
    // `diary-20260923-161500.meta` + `.json`，重名后生成
    // `diary-20260923-161500.meta (1).json` —— 于是它的搭档
    // `diary-20260923-161500 (1).db` 找不到配对的 meta。
    //
    // 后果比"名字难看"严重得多：备份的配对规则是**同 stem 换后缀**
    //（`db.rs` 的 `parse_backup_stamp` 与 `commands::paired_meta_path` 都按它走），
    // 配对不上＝"缺 meta"，而缺 meta 的备份**密码再对也永远打不开**。
    // 也就是说：用户为了安全把备份复制到第二个盘，复制出来的那一份反而成了废文件 ——
    // 正是"改一处崩三处"最典型的形态（复制功能与配对规则本来是两件不相干的事）。
    const META_SUFFIX: &str = ".meta.json";
    let (stem, ext) = match file.strip_suffix(META_SUFFIX) {
        Some(s) => (s.to_string(), META_SUFFIX.to_string()),
        None => {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            match path.extension() {
                Some(e) => (stem, format!(".{}", e.to_string_lossy())),
                None => (stem, String::new()),
            }
        }
    };

    for n in 1..1000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::State(format!(
        "同名文件太多，放弃写入：{}",
        path.display()
    )))
}

/// 日期加减若干天（`delta` 可负）。
///
/// 用于连续天数（前一天）和"本周"的收尾（周一 + 6 天）。
/// ⚠️ 只保留这一份加法：`previous_date` 就是它减一天，别再写第二遍。
fn shift_date(date: &str, delta: i64) -> AppResult<String> {
    validate_date(date)?;
    let y: i64 = date[0..4].parse().unwrap_or(0);
    let m: i64 = date[5..7].parse().unwrap_or(1);
    let d: i64 = date[8..10].parse().unwrap_or(1);

    // 转成"自纪元起的天数"，加减，再转回日期。
    let days = days_from_civil(y, m, d) + delta;
    let (ny, nm, nd) = civil_from_days(days);
    Ok(format!("{ny:04}-{nm:02}-{nd:02}"))
}

/// 前一天的日期字符串。用于连续天数统计。
fn previous_date(date: &str) -> AppResult<String> {
    shift_date(date, -1)
}

/// 一次遍历同时算出「当前连续」与「最长连续」。
///
/// **为什么两件事必须在同一趟里算**：它们用的是同一条"相接"判定。
/// 写成两段循环（一段从最近往前、一段从头到尾）就是把同一条规则抄了两份，
/// 哪天要调"断"的口径，必然只改其中一处 —— 于是两个数字开始互相矛盾，
/// 而且几乎不会被发现。这就是本项目"判定只实现一次"那条铁律。
///
/// `dates` 必须**升序**，元素是定长 ISO 日期串。升序遍历，
/// `run` = 当前这一段连续了多少天：
///   - 与上一篇**相接**（由 `is_connected` 判定）→ run += 1
///   - 否则（第一段，或中间断了）→ run 从 1 重新起算
/// 循环结束时 `run` 就是以**最新一篇收尾**的那一段长度，即"当前连续"；
/// `longest` 是历史最大值。从未写过时两者都是 0。
///
/// 返回 `(当前连续, 历史最长)`。
///
/// ⭐ **"相接"怎么判定由调用方传进来，这里不写死** —— 两处用法不同：
///    统计页的"连续" ＝ 相邻两天**逐日相接**；
///    回顾页的"连续同一种心情" ＝ **逐日相接 且 心情相同**。
///   ⚠️ 返回类型带 `AppResult` 而不是光秃秃一个元组：判定本身要算日期
///      （`previous_date` 会失败），错误必须照旧往外传，不能吞掉。
/// ⚠️ **真正的循环在 `longest_run` 里**，这里只是一层"只要两个数"的薄包装
///    （`stats()` 用）。P2-23 的「连续同一种心情」还要知道最长那一段**起止在哪**，
///    所以它调 `longest_run`。**判定仍然只有一份实现** —— 包装不算第二份。
fn longest_and_current_run<F>(dates: &[String], is_connected: F) -> AppResult<(i64, i64)>
where
    F: Fn(&str, &str) -> AppResult<bool>,
{
    let r = longest_run(dates, is_connected)?;
    Ok((r.current, r.longest))
}

/// 同一条"连续"判定的**唯一实现**，比上面那个多给**最长那一段的起始下标**。
///
/// 为什么需要下标：P2-23 的「连续同一种心情」要在界面上写出起止日期，而那两个
/// 日期**必须取自真实写过的日期**（`dates[start]` / `dates[start + longest - 1]`）
/// —— ⛔ 绝不按天数往前推算，那会撞上闰日，而且算出来那天未必真写过。
struct RunStats {
    /// 以**最后一个元素收尾**的那一段长度（一个元素都没有时为 0）。
    current: i64,
    /// 历史最长的那一段长度。
    longest: i64,
    /// 最长那一段在入参切片里的**起始下标**（`longest == 0` 时无意义）。
    longest_start: usize,
}

fn longest_run<F>(dates: &[String], is_connected: F) -> AppResult<RunStats>
where
    F: Fn(&str, &str) -> AppResult<bool>,
{
    let mut run = 0i64;
    let mut longest = 0i64;
    let mut run_start = 0usize;
    let mut longest_start = 0usize;
    let mut prev: Option<&str> = None;
    for (i, d) in dates.iter().enumerate() {
        match prev {
            Some(p) if is_connected(d, p)? => run += 1,
            _ => {
                run = 1;
                run_start = i;
            }
        }
        if run > longest {
            longest = run;
            longest_start = run_start;
        }
        prev = Some(d);
    }
    Ok(RunStats {
        current: run,
        longest,
        longest_start,
    })
}

/// 该日期所在周的**周一**（`YYYY-MM-DD`）。
///
/// 周一起算，与日历的排布一致（`utils/date.ts::monthGrid` 也是"周一为 0"）。
/// 1970-01-01 是**星期四**，也就是 `days_from_civil` 的 0 对应周四，
/// 所以偏移 +3 才是"周一为 0"的星期序号；外层先 +10 再取模是为了让
/// 负天数（1970 年之前）也落在 0~6，不至于出现负下标。
fn week_start(date: &str) -> AppResult<String> {
    validate_date(date)?;
    let y: i64 = date[0..4].parse().unwrap_or(0);
    let m: i64 = date[5..7].parse().unwrap_or(1);
    let d: i64 = date[8..10].parse().unwrap_or(1);

    let days = days_from_civil(y, m, d);
    let monday_index = ((days % 7) + 10) % 7; // 0 = 周一 … 6 = 周日
    let (ny, nm, nd) = civil_from_days(days - monday_index);
    Ok(format!("{ny:04}-{nm:02}-{nd:02}"))
}

/// 热力图窗口：返回 `(起始周一, 结束周日)`，共 **371 天 ＝ 53 列 × 7 行**。
///
/// 口径（**全项目只此一处**）：
/// ```text
/// week_start(today)              = 本周周一
/// heatmap_end   = shift_date(week_start, +6)    = 本周周日
/// heatmap_start = shift_date(week_start, -364)  = 53 周前那一周的周一
/// ```
/// `-364` ＝ 52 个整周，所以起点与 `week_start(today)` 落在同一个星期几（都是周一），
/// 加上结束那一整周（7 天）正好 53 周。
///
/// **为什么窗口在后端算、"今天"却由前端传**：两件事方向相反、道理相同 ——
/// 「今天」只有前端知道（本地时区），所以前端给（见 `stats` 的档注）；
/// 而「窗口有多长、从哪个周一开始」是一条**业务口径**，全项目只应有一处定义。
/// 前端自己再算一遍，哪天改口径就两处不一致 —— 这正是"判定只实现一次"那条铁律。
///
/// ⚠️ 结束日**是本周周日、不是 today**：库里若存在"未来日期"的记录
///    （日历选择范围若含未来），它应该正常显示成一个格子，而不是被窗口悄悄切掉。
///    前端对"未来且没数据"的格子另有样式（留空占位）。
fn heatmap_window(today: &str) -> AppResult<(String, String)> {
    let monday = week_start(today)?;
    let end = shift_date(&monday, 6)?;
    let start = shift_date(&monday, -364)?;
    Ok((start, end))
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

    // -----------------------------------------------------------------------
    // 备份文件名的解析（P2-5 备份恢复）
    // -----------------------------------------------------------------------

    #[test]
    fn backup_stamp_parses_all_three_spellings() {
        let from_db = parse_backup_stamp("diary-20260923-161500.db").unwrap();
        let from_meta = parse_backup_stamp("diary-20260923-161500.meta.json").unwrap();
        let from_stem = parse_backup_stamp("diary-20260923-161500").unwrap();

        // 三种写法必须算出同一个时间 —— 恢复时正是靠它把 .db 和 .meta.json 配成一对。
        assert_eq!(from_db, from_meta);
        assert_eq!(from_db, from_stem);
        assert_eq!(from_db, 1_790_180_100); // 2026-09-23T16:15:00Z

        // 与反方向的换算对得上（同一份日期换算的两个方向只有一处实现）。
        assert_eq!(unix_to_rfc3339(from_db), "2026-09-23T16:15:00Z");
    }

    #[test]
    fn backup_stamp_handles_leap_day_and_epoch() {
        assert_eq!(
            parse_backup_stamp("diary-20240229-000001.db").unwrap(),
            1_709_164_801
        );
        assert_eq!(
            parse_backup_stamp("diary-20000101-000000.db").unwrap(),
            946_684_800
        );
    }

    #[test]
    fn backup_stamp_rejects_foreign_names() {
        // 认不出来必须是 None（而不是 Err）：备份目录里可能有用户自己放的文件，
        // 对它最合适的处理是"当它不存在"，不能让整个列表打不开。
        assert!(parse_backup_stamp("diary.db").is_none());
        assert!(parse_backup_stamp("diary-20260923-1615.db").is_none()); // 少一位
        assert!(parse_backup_stamp("diary-20261323-161500.db").is_none()); // 13 月
        assert!(parse_backup_stamp("diary-20260932-161500.db").is_none()); // 32 日
        assert!(parse_backup_stamp("diary-20260923-251500.db").is_none()); // 25 点
        assert!(parse_backup_stamp("diary-20260923-166100.db").is_none()); // 61 分
        assert!(parse_backup_stamp("backup-20260923-161500.db").is_none()); // 前缀不对
        assert!(parse_backup_stamp("notes.txt").is_none());
        assert!(parse_backup_stamp("").is_none());
    }

    // -----------------------------------------------------------------------
    // Markdown 导出
    // -----------------------------------------------------------------------

    #[test]
    fn yaml_scalar_leaves_plain_values_alone() {
        assert_eq!(yaml_scalar("标题"), "标题");
        assert_eq!(yaml_scalar("2026-09-18"), "2026-09-18");
        assert_eq!(yaml_scalar("旅行"), "旅行");
        // emoji 与汉字一样是普通字符，不需要引号
        assert_eq!(yaml_scalar("开心🥰"), "开心🥰");
    }

    #[test]
    fn yaml_scalar_quotes_and_escapes_anything_ambiguous() {
        // 冒号 + 空格在 YAML 里是键值分隔，必须引起来，否则整段 front-matter 崩掉
        assert_eq!(yaml_scalar("a: b"), "\"a: b\"");
        // 井号是注释起点
        assert_eq!(yaml_scalar("a #b"), "\"a #b\"");
        // 换行 / 引号 / 反斜杠要转义成双引号风格里的转义序列
        assert_eq!(yaml_scalar("第一行\n第二行"), "\"第一行\\n第二行\"");
        assert_eq!(yaml_scalar("说\"话\""), "\"说\\\"话\\\"\"");
        assert_eq!(yaml_scalar("C:\\tmp"), "\"C:\\\\tmp\"");
        // 空串与首尾空白（裸着写会被 YAML 当成别的意思）
        assert_eq!(yaml_scalar(""), "\"\"");
        assert_eq!(yaml_scalar("  x  "), "\"  x  \"");
        // 以 - 开头会被当成列表项
        assert_eq!(yaml_scalar("- 待办"), "\"- 待办\"");
    }

    #[test]
    fn non_conflicting_path_never_overwrites() {
        let dir = std::env::temp_dir().join("dsh-diary-export-name");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let first = dir.join("2026-09-18.md");
        // 目标不存在时原样返回，不加后缀
        assert_eq!(non_conflicting_path(&first).unwrap(), first);

        std::fs::write(&first, "x").unwrap();
        let second = non_conflicting_path(&first).unwrap();
        assert_eq!(second, dir.join("2026-09-18 (1).md"));

        std::fs::write(&second, "x").unwrap();
        let third = non_conflicting_path(&first).unwrap();
        assert_eq!(third, dir.join("2026-09-18 (2).md"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ 重名加后缀时，`.db` 与 `.meta.json` 必须**还是配成一对**。
    ///
    /// 这是「复制备份到…」的命门：备份的配对规则是"同 stem 换后缀"，
    /// 只要 meta 被改成 `…meta (1).json`，它的搭档 `…(1).db` 就配不上，
    /// 复制出去的那一份＝永远打不开。两个文件都在，用户却打不开 ——
    /// 最难查的那种故障。
    #[test]
    fn non_conflicting_path_keeps_the_backup_pair_together() {
        let dir = std::env::temp_dir().join("dsh-diary-backup-pair-name");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let db = dir.join("diary-20260923-161500.db");
        let meta = dir.join("diary-20260923-161500.meta.json");
        std::fs::write(&db, "x").unwrap();
        std::fs::write(&meta, "x").unwrap();

        let db2 = non_conflicting_path(&db).unwrap();
        let meta2 = non_conflicting_path(&meta).unwrap();

        assert_eq!(db2, dir.join("diary-20260923-161500 (1).db"));
        assert_eq!(
            meta2,
            dir.join("diary-20260923-161500 (1).meta.json"),
            "后缀要插在整个 `.meta.json` 之前，不能插在 `.json` 之前"
        );
        // 用真正的配对口径再验一次：同 stem 换后缀必须能互相找到。
        assert_eq!(
            meta2.file_name().unwrap().to_string_lossy(),
            format!(
                "{}.meta.json",
                db2.file_name().unwrap().to_string_lossy().strip_suffix(".db").unwrap()
            )
        );

        // 原有的普通扩展名行为不许被这次改动带偏。
        let md = dir.join("2026-09-18.md");
        std::fs::write(&md, "x").unwrap();
        assert_eq!(
            non_conflicting_path(&md).unwrap(),
            dir.join("2026-09-18 (1).md")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_entry_md_keeps_the_body_byte_for_byte() {
        // 正文里有软换行、行首缩进、列表与表格 —— 全部必须原样保留。
        // 这一条就是验收标准"中文、换行、Markdown 语法完全原样"的机器版。
        let body = "第一行\n\n  缩进两格\n\n- 列表\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        let md = render_entry_md(
            "2026-09-18",
            "标题",
            Some(4),
            &["旅行".to_string(), "美食".to_string()],
            320,
            body,
        );
        let expected = format!(
            "---\ndate: 2026-09-18\ntitle: 标题\nmood: 4\ntags: [旅行, 美食]\nword_count: 320\n---\n{body}"
        );
        assert_eq!(md, expected);
        assert!(
            md.ends_with(body),
            "正文必须一字不改地接在 front-matter 之后"
        );
    }

    #[test]
    fn render_entry_md_writes_null_mood_and_empty_tags() {
        let md = render_entry_md("2026-01-02", "", None, &[], 0, "正文");
        assert!(md.contains("\ntitle: \"\"\n"), "空标题应显式加引号：{md}");
        assert!(md.contains("\nmood: null\n"), "没标心情应写 null：{md}");
        assert!(md.contains("\ntags: []\n"), "没有标签应是空列表：{md}");
    }

    #[test]
    fn previous_date_handles_month_and_year_boundaries() {
        assert_eq!(previous_date("2026-09-11").unwrap(), "2026-09-10");
        assert_eq!(previous_date("2026-09-01").unwrap(), "2026-08-31");
        assert_eq!(previous_date("2026-01-01").unwrap(), "2025-12-31");
        assert_eq!(previous_date("2024-03-01").unwrap(), "2024-02-29"); // 闰年
    }

    #[test]
    fn shift_date_moves_forward_across_boundaries() {
        assert_eq!(shift_date("2026-09-21", 6).unwrap(), "2026-09-27");
        assert_eq!(shift_date("2026-09-30", 1).unwrap(), "2026-10-01");
        assert_eq!(shift_date("2026-12-31", 1).unwrap(), "2027-01-01");
        assert_eq!(shift_date("2024-02-28", 1).unwrap(), "2024-02-29"); // 闰年
        assert_eq!(shift_date("2023-02-28", 1).unwrap(), "2023-03-01"); // 平年
        assert_eq!(shift_date("2026-01-01", -1).unwrap(), "2025-12-31");
    }

    /// "本周"必须是**周一到周日**，且跨月 / 跨年都要对。
    /// 基准：2026-09-21 是周一（写这条断言的那天）。
    #[test]
    fn week_start_is_monday_and_handles_boundaries() {
        assert_eq!(week_start("2026-09-21").unwrap(), "2026-09-21"); // 周一
        assert_eq!(week_start("2026-09-24").unwrap(), "2026-09-21"); // 周四
        assert_eq!(week_start("2026-09-20").unwrap(), "2026-09-14"); // 周日 → 上一周
        assert_eq!(week_start("2026-10-01").unwrap(), "2026-09-28"); // 跨月
        assert_eq!(week_start("2027-01-01").unwrap(), "2026-12-28"); // 跨年
        assert!(week_start("2026-9-21").is_err()); // 格式不对要报错，不猜
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
    fn tag_names_are_trimmed_deduped_and_length_checked() {
        // 清洗是纯函数，先在这里把规则钉死；数据库那一层的行为在
        // tests/vault_integration.rs 的「标签」组里端到端验证。
        let cleaned = normalize_tag_names(&[
            "  旅行  ".into(),
            "旅行".into(),      // 与第一条重复（去空白后同名）
            "旅行 ".into(),
            "Travel".into(),
            "travel".into(),    // 只差大小写 → 同一个标签（NOCASE 语义）
            "TRAVEL".into(),
            "   ".into(),       // 全空白 → 丢掉
            "".into(),
        ])
        .unwrap();
        assert_eq!(cleaned, vec!["旅行", "Travel"]);
        // 保留第一个出现的大小写，不把 Travel 改写成 travel。
        assert_eq!(cleaned[1], "Travel");

        // 全空白 / 空输入 → 空列表（前端"撤掉全部标签"走的就是这条）。
        assert!(normalize_tag_names(&[]).unwrap().is_empty());
        assert!(normalize_tag_names(&[" ".into(), "\t\n".into()])
            .unwrap()
            .is_empty());

        // 长度按**字符**算而不是字节：20 个汉字必须通过。
        // 按字节算的话 20 个汉字是 60 字节，中文用户只能打 6 个字。
        let twenty_chars = "字".repeat(TAG_MAX_CHARS);
        assert_eq!(twenty_chars.len(), TAG_MAX_CHARS * 3);
        assert_eq!(
            normalize_tag_names(&[twenty_chars]).unwrap(),
            vec!["字".repeat(TAG_MAX_CHARS)]
        );

        // 超一个字就报错，且必须是 validation 类（前端按 kind 分支展示）。
        let too_long = "字".repeat(TAG_MAX_CHARS + 1);
        let err = normalize_tag_names(&[too_long]).expect_err("超长必须被拒绝");
        assert!(
            matches!(err, AppError::Validation(_)),
            "超长应返回 Validation，实际: {err:?}"
        );
        // 边界是"清洗之后"的长度：前后空白不计入，
        // 否则用户粘一段带空格的文字会被莫名其妙拒掉。
        let padded = format!("  {}  ", "字".repeat(TAG_MAX_CHARS));
        assert_eq!(normalize_tag_names(&[padded]).unwrap().len(), 1);
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

        // 退回 v1：把 v2 / v3 后加的两列都删掉 + 版本号改回 1。
        // （模拟的是"老库"，所以后加的列一个都不能在 —— 否则下面那句
        //  ALTER TABLE ... ADD COLUMN 会因为列已存在而直接失败。）
        vault
            .conn
            .execute_batch("ALTER TABLE entry DROP COLUMN locked")
            .unwrap();
        vault
            .conn
            .execute_batch("ALTER TABLE tag DROP COLUMN retired")
            .unwrap();
        vault
            .conn
            .execute("UPDATE schema_version SET version = 1", [])
            .unwrap();

        vault.migrate().expect("v1 库必须能升到最新版");

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

    /// v2 -> v3：加 `tag.retired`（标签"删除"改成软删除）。
    ///
    /// ⚠️ 这条迁移最容易出的事故是**把老标签变成"退休"**：只要默认值不是 0，
    ///    用户升个版本就会看到"我的标签一个都不见了"。所以这里专门断言
    ///    老标签升级后**照旧在列表里**、篇数与关联都没变。
    #[test]
    fn upgrade_from_v2_adds_retired_column_and_keeps_tags_visible() {
        let dir = std::env::temp_dir().join("dsh-diary-migrate-v2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();
        vault.save_entry("2026-09-12", "", "内容").unwrap();
        vault
            .set_entry_tags("2026-09-12", &["旅行".into()])
            .unwrap();

        // 退回 v2：删掉 retired 列 + 版本号改回 2。
        vault
            .conn
            .execute_batch("ALTER TABLE tag DROP COLUMN retired")
            .unwrap();
        vault
            .conn
            .execute("UPDATE schema_version SET version = 2", [])
            .unwrap();

        vault.migrate().expect("v2 库必须能升到 v3");

        let v: i64 = vault
            .conn
            .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, schema::SCHEMA_VERSION);
        assert!(
            dir.join("diary.pre-v2.db").exists(),
            "升级前必须产生 v2 快照"
        );

        // 升上来的老标签必须原样在列表里（retired 默认 0），内容与关联都不动。
        let all = vault.list_tags().unwrap();
        assert_eq!(all.len(), 1, "老标签不能被迁移顺手退休掉");
        assert_eq!(all[0].name, "旅行");
        assert_eq!(all[0].entry_count, 1);
        assert_eq!(vault.tags_of_entry("2026-09-12").unwrap(), vec!["旅行"]);
        assert_eq!(vault.open_entry("2026-09-12").unwrap().content_md, "内容");

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

    /// 自动锁定时长：默认值、白名单、以及"库里被写坏"的兜底。
    ///
    /// 这条路径每次解锁都要走，所以它**不允许报错** ——
    /// 三种坏情况（没设过 / 填了非法数 / 不是数字）都必须安静地回落默认值。
    #[test]
    fn auto_lock_secs_defaults_and_falls_back() {
        let dir = std::env::temp_dir().join("dsh-diary-auto-lock");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();

        // 老库：从来没有这个 key。默认 10 分钟，且不能报错。
        assert_eq!(
            vault.get_settings().unwrap().auto_lock_secs,
            600,
            "1.6 及之前的库没有这个 key，必须安静地用默认值"
        );

        // 四档都能写能读（0 = 永不 是个合法值，不能和"没设过"混为一谈）
        for secs in AUTO_LOCK_ALLOWED_SECS {
            vault.set_auto_lock_secs(secs).unwrap();
            assert_eq!(vault.get_settings().unwrap().auto_lock_secs, secs);
        }

        // 白名单之外：写入被拒，且不能把库里的值改坏
        vault.set_auto_lock_secs(300).unwrap();
        let err = vault.set_auto_lock_secs(123).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "非白名单档位必须以 validation 拒绝，实际: {err:?}"
        );
        assert_eq!(
            vault.get_settings().unwrap().auto_lock_secs,
            300,
            "被拒绝的写入不能改动已存的值"
        );

        // 库里被外部工具写坏：合法数字但不在白名单 / 根本不是数字
        vault
            .set_setting(setting_keys::AUTO_LOCK_SECS, "123")
            .unwrap();
        assert_eq!(vault.get_settings().unwrap().auto_lock_secs, 600);
        vault
            .set_setting(setting_keys::AUTO_LOCK_SECS, "abc")
            .unwrap();
        assert_eq!(vault.get_settings().unwrap().auto_lock_secs, 600);
        // 空串也一样 —— 有些工具会把"空值"存成空字符串而不是删掉这一行
        vault.set_setting(setting_keys::AUTO_LOCK_SECS, "").unwrap();
        assert_eq!(vault.get_settings().unwrap().auto_lock_secs, 600);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「离开日记时自动锁定」：默认开、两个方向都留得住、坏值一律回落到"开"。
    ///
    /// 兜底方向是这条测试的重点：读不出来时**宁可继续锁**，
    /// 也不能静默地变成"不锁"。注意它与 `auto_backup_enabled()` 的
    /// `v == "true"` 口径故意的不同（读错方向的代价不对称）。
    #[test]
    fn auto_lock_entries_defaults_and_falls_back() {
        let dir = std::env::temp_dir().join("dsh-diary-auto-lock-entries");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();

        // 老库：从来没有这个 key → 默认 **开**（与改动前的行为逐项一致）
        assert!(
            vault.get_settings().unwrap().auto_lock_entries,
            "老库必须默认开 —— 默认关等于所有人一升级就静默地失去保护"
        );

        // 两个方向都要留得住（"关"必须真的读回 false，不能被兜底吞掉）
        vault.set_auto_lock_entries(false).unwrap();
        assert!(!vault.get_settings().unwrap().auto_lock_entries);
        vault.set_auto_lock_entries(true).unwrap();
        assert!(vault.get_settings().unwrap().auto_lock_entries);

        // 库里被外部工具写坏：一律回落到"开"（保守方向）
        for bad in ["", "abc", "0", "TRUE", "yes", " "] {
            vault
                .set_setting(setting_keys::AUTO_LOCK_ENTRIES, bad)
                .unwrap();
            assert!(
                vault.get_settings().unwrap().auto_lock_entries,
                "坏值 {bad:?} 必须回落到开"
            );
        }
        // 但精确的 "false" 必须被认出来，否则这个开关就永远关不掉了
        vault
            .set_setting(setting_keys::AUTO_LOCK_ENTRIES, "false")
            .unwrap();
        assert!(!vault.get_settings().unwrap().auto_lock_entries);

        // 两项互不干扰：读一次设置会把它们一起读出来
        vault.set_auto_lock_secs(60).unwrap();
        vault.set_auto_lock_entries(false).unwrap();
        let s = vault.get_settings().unwrap();
        assert_eq!(s.auto_lock_secs, 60);
        assert!(!s.auto_lock_entries);

        // 默认值本身也要对（两个常量各自被 Default 用着）
        let d = AppSettings::default();
        assert_eq!(d.auto_lock_secs, DEFAULT_AUTO_LOCK_SECS);
        assert!(d.auto_lock_entries);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 「三击左键快速解锁」：默认开、两个方向都留得住、坏值一律回落到"开"（指令 15）。
    ///
    /// 与 `auto_lock_entries` 同一套口径，重点仍是**兜底方向**：
    /// 读不出来时按"开"处理 —— 老库升级上来时行为与改动前一致
    /// （此前没有这个开关，手势始终可用）。
    #[test]
    fn triple_click_unlock_defaults_and_falls_back() {
        let dir = std::env::temp_dir().join("dsh-diary-triple-click-unlock");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let vault = Vault::create(&dir, "135790", None).unwrap();

        // 老库：从来没有这个 key → 默认 **开**
        assert!(
            vault.get_settings().unwrap().triple_click_unlock,
            "老库必须默认开 —— 升级前的版本里这个手势一直可用"
        );

        // 两个方向都要留得住（"关"必须真的读回 false，不能被兜底吞掉）
        vault.set_triple_click_unlock(false).unwrap();
        assert!(!vault.get_settings().unwrap().triple_click_unlock);
        vault.set_triple_click_unlock(true).unwrap();
        assert!(vault.get_settings().unwrap().triple_click_unlock);

        // 库里被外部工具写坏：一律回落到"开"
        for bad in ["", "abc", "0", "TRUE", "yes", " "] {
            vault
                .set_setting(setting_keys::TRIPLE_CLICK_UNLOCK, bad)
                .unwrap();
            assert!(
                vault.get_settings().unwrap().triple_click_unlock,
                "坏值 {bad:?} 必须回落到开"
            );
        }
        // 但精确的 "false" 必须被认出来，否则这个开关就永远关不掉了
        vault
            .set_setting(setting_keys::TRIPLE_CLICK_UNLOCK, "false")
            .unwrap();
        assert!(!vault.get_settings().unwrap().triple_click_unlock);

        // 三项互不干扰：读一次设置会把它们一起读出来
        vault.set_auto_lock_secs(60).unwrap();
        vault.set_auto_lock_entries(false).unwrap();
        vault.set_triple_click_unlock(false).unwrap();
        let s = vault.get_settings().unwrap();
        assert_eq!(s.auto_lock_secs, 60);
        assert!(!s.auto_lock_entries);
        assert!(!s.triple_click_unlock);

        // 默认值本身也要对（三个常量各自被 Default 用着）
        let d = AppSettings::default();
        assert_eq!(d.auto_lock_secs, DEFAULT_AUTO_LOCK_SECS);
        assert!(d.auto_lock_entries);
        assert!(d.triple_click_unlock);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // 图片附件（P1 #10 / 指令 8）
    // -----------------------------------------------------------------------

    /// 一张"合法"的 PNG：只有文件头魔数是真的，后面随便填。
    /// 我们不做真正的解码，判定的就是魔数 —— 所以这样够用。
    fn png_bytes(tag: u8) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        v.extend_from_slice(&[tag; 32]);
        v
    }

    /// 一个空的临时库（数据目录与库文件在同一个目录里，正是便携式的布局）。
    fn temp_vault(name: &str) -> (PathBuf, Vault) {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let vault = Vault::create(&dir, "135790", None).unwrap();
        (dir, vault)
    }

    // -----------------------------------------------------------------------
    // 热力图窗口与逐日数据（P2-18）
    // -----------------------------------------------------------------------

    /// 两个日期相差多少天（`b - a`）。测试自己算差值，不依赖被测代码的换算。
    fn heat_days_between(a: &str, b: &str) -> i64 {
        let to_days = |s: &str| {
            days_from_civil(
                s[0..4].parse().unwrap(),
                s[5..7].parse().unwrap(),
                s[8..10].parse().unwrap(),
            )
        };
        to_days(b) - to_days(a)
    }

    /// 该日期是星期几（0＝周一 … 6＝周日），与 `week_start` 同一套口径。
    fn heat_weekday(date: &str) -> i64 {
        let days = days_from_civil(
            date[0..4].parse().unwrap(),
            date[5..7].parse().unwrap(),
            date[8..10].parse().unwrap(),
        );
        ((days % 7) + 10) % 7
    }

    #[test]
    fn heatmap_window_is_53_whole_weeks_ending_after_today() {
        // 特意挑一个窗口**跨年**的 today：热力图年年都会跨一次，这条顺手覆盖它。
        let today = "2026-01-03"; // 周六
        let (start, end) = heatmap_window(today).unwrap();

        assert_eq!(heat_weekday(&start), 0, "起点必须是周一，实际 {start}");
        assert_eq!(heat_weekday(&end), 6, "终点必须是周日，实际 {end}");
        assert_eq!(
            heat_days_between(&start, &end),
            370,
            "371 天窗口 ⇒ 首尾相差 370 天"
        );
        assert!(
            end.as_str() >= today,
            "终点（本周周日）必须不早于 today：{end} < {today}"
        );
        assert_eq!(end, "2026-01-04", "01-03 是周六，本周周日应是 01-04");
    }

    #[test]
    fn heatmap_lists_only_days_that_were_written() {
        let (dir, vault) = temp_vault("dsh-diary-heatmap-written");
        let today = "2026-09-24"; // 周四

        vault.save_entry("2026-09-22", "", "写了").unwrap();
        vault.save_entry("2026-09-24", "", "也写了").unwrap();
        // 只填了标题、正文空 ⇒ 不算"写过"（口径同 has_content_sql）。
        // 它同样落在窗口内，所以"不出现"是真的被判定排除了，不是被窗口切掉。
        vault.save_entry("2026-09-21", "只有标题", "").unwrap();

        let stats = vault.stats(today).unwrap();
        let dates: Vec<&str> = stats.daily_words.iter().map(|d| d.date.as_str()).collect();

        assert!(dates.contains(&"2026-09-22"), "写过的天必须在名单里");
        assert!(dates.contains(&"2026-09-24"), "写过的天必须在名单里");
        assert!(
            !dates.contains(&"2026-09-21"),
            "只有标题、没有正文的那天不算写过，不该出现在名单里"
        );
        // 升序 —— 前端正是按这个顺序平铺那 371 个格子，顺序错了整张图就错位。
        let mut sorted = dates.clone();
        sorted.sort_unstable();
        assert_eq!(dates, sorted, "必须按日期升序");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heatmap_counts_an_image_only_day_as_written() {
        // ⭐ 本件最重要的一条。
        // 纯图片日记**算"写过"**（`has_content_sql()` 含有附件那半句），
        // 但它的 `word_count` 是 0 ⇒ 必须出现在名单里、且 `words == 0`。
        // 前端据此把它画成**最浅那一档绿色**，而不是"没写的灰"。
        // 若这条退化，用户那张只有照片的日记会变成灰格 —— 违反已拍板第 ⑥ 条。
        let (dir, vault) = temp_vault("dsh-diary-heatmap-image-only");
        let today = "2026-09-24";

        vault.save_entry("2026-09-23", "", "").unwrap();
        vault
            .save_attachment("2026-09-23", "猫.png", "image/png", &png_bytes(7))
            .unwrap();

        let stats = vault.stats(today).unwrap();
        let day = stats
            .daily_words
            .iter()
            .find(|d| d.date == "2026-09-23")
            .expect("只有图片的那天必须算「写过」，否则会被画成灰格");
        assert_eq!(day.words, 0, "纯图片日没有文字，字数应为 0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heatmap_ignores_history_outside_the_window() {
        let (dir, vault) = temp_vault("dsh-diary-heatmap-window-edge");
        let today = "2026-09-24";

        let (start, _end) = heatmap_window(today).unwrap();
        let before = shift_date(&start, -1).unwrap(); // 窗口起点**前一天**，差一天就出界
        vault.save_entry(&before, "", "窗口外").unwrap();
        vault.save_entry(&start, "", "窗口第一天").unwrap();

        let stats = vault.stats(today).unwrap();
        let dates: Vec<&str> = stats.daily_words.iter().map(|d| d.date.as_str()).collect();

        assert!(
            !dates.contains(&before.as_str()),
            "窗口前一天的数据不该返回（{before}）"
        );
        assert!(
            dates.contains(&start.as_str()),
            "窗口第一天必须包含（{start}）"
        );
        // 窗口本身也要如实报出来，前端拿它当铺格子的起点。
        assert_eq!(stats.heatmap_start, start);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachment_rejects_path_traversal_but_never_deletes_outside() {
        let (dir, vault) = temp_vault("dsh-diary-attach-traversal");

        // 制造"库被外部工具改过"的场景：直接塞一条 stored_rel 指向数据目录**外面**。
        let entry_id = vault.save_entry("2026-09-21", "", "正文").unwrap().id;
        vault
            .conn()
            .execute(
                "INSERT INTO attachment (entry_id, file_name, stored_rel, mime, byte_size, sha256, created_at)
                 VALUES (?1, 'x.png', '../../crypto_meta.json', 'image/png', 1, 'deadbeef', '2026-09-21T00:00:00Z')",
                params![entry_id],
            )
            .unwrap();
        let bad_id = vault.conn().last_insert_rowid();

        // ① 读：必须被拒 —— 而不是把数据目录外面那个文件读出来
        let err = vault.read_attachment(bad_id).unwrap_err();
        assert!(
            matches!(err, AppError::Validation(_)),
            "路径穿越必须以 validation 拒绝，实际: {err:?}"
        );

        // ② 列表：跳过这条，但**不许**让整页报错 —— 少显示一张图好过编辑器打不开
        let list = vault.list_attachments("2026-09-21").unwrap();
        assert!(
            list.iter().all(|a| a.id != bad_id),
            "非法路径的附件不该出现在列表里"
        );

        // ③ 清理：只删记录，绝不顺着这条路径去删任何文件
        let outside = dir.join("crypto_meta.json");
        std::fs::write(&outside, "{\"kdf\":\"argon2id\"}").unwrap();
        let report = vault.prune_orphan_attachments().unwrap();
        assert_eq!(report.rows_removed, 1, "非法路径的记录应被清理掉");
        assert!(
            outside.is_file(),
            "清理绝不能跟着 ../ 删到数据目录外面的文件"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachment_dedups_by_sha256_and_refcounts_before_deleting() {
        let (dir, vault) = temp_vault("dsh-diary-attach-dedup");
        let bytes = png_bytes(1);

        let a = vault
            .save_attachment("2026-09-21", "猫.png", "image/png", &bytes)
            .unwrap();
        let b = vault
            .save_attachment("2026-09-21", "同一张.png", "image/png", &bytes)
            .unwrap();
        assert_eq!(a.sha256, b.sha256);
        assert_eq!(a.stored_rel, b.stored_rel, "同一张图应落到同一个文件");

        let files: Vec<String> = std::fs::read_dir(dir.join("attachments"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 1, "同一张图只该占一份磁盘，实际: {files:?}");

        // 删掉其中一条：文件还被另一条引用着，必须留住
        vault.delete_attachment(a.id).unwrap();
        let on_disk = dir.join("attachments").join(format!("{}.png", a.sha256));
        assert!(on_disk.is_file(), "还有记录引用它时不能删文件");
        assert_eq!(vault.list_attachments("2026-09-21").unwrap().len(), 1);

        // 删掉最后一条：文件才消失
        vault.delete_attachment(b.id).unwrap();
        assert!(!on_disk.exists(), "没人引用了，文件该跟着走");
        assert!(vault.list_attachments("2026-09-21").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachment_rejects_wrong_type_and_oversize() {
        let (dir, vault) = temp_vault("dsh-diary-attach-limits");

        // 扩展名不在白名单
        let e = vault
            .save_attachment("2026-09-21", "笔记.txt", "text/plain", b"hello")
            .unwrap_err();
        assert!(matches!(e, AppError::Validation(_)), "实际: {e:?}");

        // 扩展名说是 png、内容却是纯文本 —— 魔数这一关必须拦住"改后缀名"
        // ⚠️ 字节串字面量只能是 ASCII，中文得走字符串再 as_bytes()
        let e = vault
            .save_attachment("2026-09-21", "假图.png", "image/png", "这不是图片".as_bytes())
            .unwrap_err();
        assert!(matches!(e, AppError::Validation(_)), "实际: {e:?}");

        // 内容确实是 PNG，但浏览器报的 MIME 对不上
        let e = vault
            .save_attachment("2026-09-21", "a.png", "image/jpeg", &png_bytes(2))
            .unwrap_err();
        assert!(matches!(e, AppError::Validation(_)), "实际: {e:?}");

        // 空文件
        let e = vault
            .save_attachment("2026-09-21", "空.png", "image/png", b"")
            .unwrap_err();
        assert!(matches!(e, AppError::Validation(_)), "实际: {e:?}");

        // 超过单张 20 MB
        let mut big = png_bytes(3);
        big.resize(MAX_ATTACHMENT_BYTES as usize + 1, 0);
        let e = vault
            .save_attachment("2026-09-21", "大图.png", "image/png", &big)
            .unwrap_err();
        assert!(matches!(e, AppError::Validation(_)), "实际: {e:?}");

        // 被拒绝的上传不该留下任何痕迹：表里空、磁盘上也没文件、这天也不算写过
        assert!(vault.list_attachments("2026-09-21").unwrap().is_empty());
        assert!(
            !vault.is_written("2026-09-21").unwrap(),
            "全部被拒的日期不该算写过"
        );
        let n = std::fs::read_dir(dir.join("attachments"))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(n, 0, "被拒绝的上传不该留下文件");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attachment_counts_as_written_and_prune_cleans_both_ways() {
        let (dir, vault) = temp_vault("dsh-diary-attach-prune");
        let bytes = png_bytes(4);

        // 正文一个字都没写、只插了一张图 —— 用户 2026-09-21 拍板：这也算写过
        let a = vault
            .save_attachment("2026-09-21", "图.png", "image/png", &bytes)
            .unwrap();
        assert!(
            vault.is_written("2026-09-21").unwrap(),
            "只有附件的日记也要算写过"
        );
        assert!(vault
            .written_dates("2026-09-01", "2026-09-30")
            .unwrap()
            .contains(&"2026-09-21".to_string()));
        assert_eq!(vault.written_entry_count().unwrap(), 1);

        let file = dir.join("attachments").join(format!("{}.png", a.sha256));
        assert!(file.is_file());

        // 删掉这一天（正文为空、只有附件）：表行被级联删掉，文件却没人管
        vault.delete_entry("2026-09-21").unwrap();
        assert!(
            vault.list_attachments("2026-09-21").unwrap().is_empty(),
            "外键 ON DELETE CASCADE 应清掉表行"
        );
        assert!(file.is_file(), "删日记不会自动删文件，要等一次「清理图片缓存」");

        // 方向 ①：磁盘上有、表里没人认领 → 删文件
        let report = vault.prune_orphan_attachments().unwrap();
        assert_eq!(report.files_removed, 1);
        assert!(!file.exists(), "清理之后文件才消失");
        assert!(report.bytes_freed >= bytes.len() as u64);

        // 方向 ②：表里有记录、磁盘上文件被手工删了 → 删记录
        let b = vault
            .save_attachment("2026-09-22", "图.png", "image/png", &bytes)
            .unwrap();
        std::fs::remove_file(dir.join("attachments").join(format!("{}.png", b.sha256))).unwrap();
        let report = vault.prune_orphan_attachments().unwrap();
        assert_eq!(report.rows_removed, 1, "文件没了的记录应被清掉");
        assert!(vault.list_attachments("2026-09-22").unwrap().is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -----------------------------------------------------------------------
    // 「回顾」（P2-23）
    // -----------------------------------------------------------------------
    //
    // ⚠️ 断言里找结果**一律按 `entry_date` 找**，别用固定下标 ——
    //    `COLLATE NOCASE` 下 ASCII 排在汉字前面，下标是脆的。

    /// 空库：三项都是 `None` ＋ 名单为空，而且**不许报错**
    /// （回顾页在"第一年"就是这种状态，见 §6.3）。
    #[test]
    fn recap_on_empty_vault_returns_all_none() {
        let (dir, vault) = temp_vault("dsh-diary-recap-empty");

        let r = vault.recap("2026-09-24").unwrap();
        assert!(r.longest_entry.is_none(), "空库不该有「写得最长」");
        assert!(r.most_photos.is_none(), "空库不该有「照片最多」");
        assert!(r.mood_streak.is_none(), "空库不该有「连续心情」");
        assert!(r.days.is_empty(), "空库不该有「写过的日子」");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 一篇：它同时是「写得最长」和（带图时）「照片最多」。
    #[test]
    fn recap_single_entry_is_both_longest_and_most_photos() {
        let (dir, vault) = temp_vault("dsh-diary-recap-single");

        vault
            .save_entry_with_mood("2026-09-20", "", "只有这一篇，带了图。", Some(5))
            .unwrap();
        vault
            .save_attachment("2026-09-20", "图.png", "image/png", &png_bytes(1))
            .unwrap();

        let r = vault.recap("2026-09-24").unwrap();

        let longest = r.longest_entry.expect("应有一条「写得最长」");
        assert_eq!(longest.date, "2026-09-20");
        assert_eq!(longest.mood, Some(5), "心情要跟着带出来");
        assert!(longest.words > 0, "有正文就该有字数，实际 {}", longest.words);
        assert!(
            longest.preview.contains("带了图"),
            "开头应取自正文，实际 {:?}",
            longest.preview
        );

        let photos = r.most_photos.expect("应有一条「照片最多」");
        assert_eq!(photos.date, "2026-09-20");
        assert_eq!(photos.photos, 1);

        assert_eq!(r.days.len(), 1, "写过的日子应只有这一天");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 并列时取**更近**的那天（两篇同为 100 字 ⇒ 取日期更晚的）。
    #[test]
    fn recap_longest_prefers_the_more_recent_of_a_tie() {
        let (dir, vault) = temp_vault("dsh-diary-recap-tie");

        let hundred = "字".repeat(100);
        vault.save_entry("2026-09-10", "", &hundred).unwrap();
        vault.save_entry("2026-09-18", "", &hundred).unwrap();

        let r = vault.recap("2026-09-24").unwrap();
        let longest = r.longest_entry.expect("应有一条");
        assert_eq!(longest.date, "2026-09-18", "并列应取更近的那天");
        assert_eq!(longest.words, 100);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 纯图片日记：出现在「照片最多」里，**不出现**在「写得最长」里。
    ///
    /// 它算写过（`has_content_sql()` 含"有附件"那半句），但一个字都没写
    /// ⇒ 不该被叫「写得最长」。库里**只有**纯图片日记时那一块应当是空的，
    /// 而不是显示「0 字」。
    #[test]
    fn recap_image_only_day_is_never_the_longest() {
        let (dir, vault) = temp_vault("dsh-diary-recap-image-only");

        vault
            .save_attachment("2026-09-19", "图.png", "image/png", &png_bytes(2))
            .unwrap();
        vault
            .save_attachment("2026-09-19", "图二.png", "image/png", &png_bytes(3))
            .unwrap();

        let r = vault.recap("2026-09-24").unwrap();

        assert!(
            r.longest_entry.is_none(),
            "全是纯图片日记时不该有「写得最长」，实际 {:?}",
            r.longest_entry
        );
        let photos = r.most_photos.expect("应有一条「照片最多」");
        assert_eq!(photos.date, "2026-09-19");
        assert_eq!(photos.photos, 2);

        assert_eq!(r.days.len(), 1, "纯图片日也算「写过的日子」");
        assert!(r.days[0].preview.is_empty(), "它没有正文，开头应是空串");
        assert_eq!(r.days[0].words, 0, "纯图片日记的字数是 0");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `days` 给的是**所有**写过的日子（升序、含纯图片日）。
    ///
    /// 这一份是给「往年今天」取内容用的 —— **哪几天要显示由前端那条纯函数判定**
    /// （"找往年同一天"只许有一份实现），所以后端必须给全，不能替前端筛。
    #[test]
    fn recap_days_lists_every_written_day_in_order() {
        let (dir, vault) = temp_vault("dsh-diary-recap-days");

        vault
            .save_entry_with_mood("2026-09-05", "", "第一篇。", Some(1))
            .unwrap();
        // 纯图片日也要在名单里，否则「往年今天」会漏掉它
        vault
            .save_attachment("2026-09-06", "图.png", "image/png", &png_bytes(7))
            .unwrap();
        vault.save_entry("2026-09-07", "", "第三篇。").unwrap();
        // 打开过、但一个字没写：**不在**名单里（与「共 N 篇」同一把尺子）
        vault.open_entry("2026-09-08").unwrap();

        let r = vault.recap("2026-09-24").unwrap();
        let dates: Vec<&str> = r.days.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(
            dates,
            ["2026-09-05", "2026-09-06", "2026-09-07"],
            "应只有真正写过的那三天，且按日期升序"
        );
        assert_eq!(r.days[0].mood, Some(1), "心情要带出来");
        assert_eq!(r.days[1].mood, None, "纯图片日没有心情");

        assert_eq!(
            vault.written_entry_count().unwrap(),
            3,
            "名单与「共 N 篇」必须是同一把尺子"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 连续心情：**逐日相接**才算。连着 3 天同一心情 ⇒ 3 天；
    /// 中间断一天的两次**不成一段**，不该被接起来。
    #[test]
    fn mood_streak_requires_consecutive_days() {
        let (dir, vault) = temp_vault("dsh-diary-recap-mood-streak");

        // 9/10 ~ 9/12 连着三天都是「开心」(5)
        for d in ["2026-09-10", "2026-09-11", "2026-09-12"] {
            vault
                .save_entry_with_mood(d, "", "连着写了。", Some(5))
                .unwrap();
        }
        // 9/20 与 9/22 也是同一种心情，但**中间缺了 9/21** ⇒ 只有 1 天一段
        for d in ["2026-09-20", "2026-09-22"] {
            vault
                .save_entry_with_mood(d, "", "断了。", Some(5))
                .unwrap();
        }

        let r = vault.recap("2026-09-24").unwrap();
        let s = r.mood_streak.expect("应有一条「连续心情」");
        assert_eq!(s.mood, 5);
        assert_eq!(s.days, 3, "只有 9/10~9/12 是逐日相接的三天");
        assert_eq!(s.from, "2026-09-10", "起止必须是真实写过的日期");
        assert_eq!(s.to, "2026-09-12");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ⭐ 「连续同一种心情」**不等于**「连续天数」—— 专防把两个口径混起来。
    ///
    /// 连着 3 天都写过，但只有前两天标了同一种心情 ⇒ 连续心情是 **2**，不是 3。
    /// 顺手把统计页那个「最长连续」拿来对照：它**是** 3。两个都对。
    #[test]
    fn mood_streak_is_not_the_same_as_streak_days() {
        let (dir, vault) = temp_vault("dsh-diary-recap-two-clocks");

        vault
            .save_entry_with_mood("2026-09-10", "", "标了心情。", Some(3))
            .unwrap();
        vault
            .save_entry_with_mood("2026-09-11", "", "也标了。", Some(3))
            .unwrap();
        // 第三天照样写了，只是没标心情
        vault.save_entry("2026-09-12", "", "没标心情。").unwrap();

        let r = vault.recap("2026-09-24").unwrap();
        let s = r.mood_streak.expect("应有一条「连续心情」");
        assert_eq!(s.days, 2, "只有两天标了同一种心情 ⇒ 不能算 3");
        assert_eq!(s.to, "2026-09-11");

        assert_eq!(
            vault.stats("2026-09-12").unwrap().longest_streak,
            3,
            "对照：连续**天数**确实是 3（两个口径不同，各自都对）"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 五种心情**各自独立**算，取天数最多的那一种 —— 绝不把 4 和 5 混成
    /// 「心情好的连续」（心情是并列的类型，不是刻度）。
    #[test]
    fn mood_streak_treats_each_mood_separately() {
        let (dir, vault) = temp_vault("dsh-diary-recap-mood-separate");

        // 连着两天 4，再连着三天 5 —— 4 与 5 相邻但**不是同一种**
        for d in ["2026-09-10", "2026-09-11"] {
            vault.save_entry_with_mood(d, "", "有点生气。", Some(4)).unwrap();
        }
        for d in ["2026-09-12", "2026-09-13", "2026-09-14"] {
            vault.save_entry_with_mood(d, "", "开心。", Some(5)).unwrap();
        }

        let r = vault.recap("2026-09-24").unwrap();
        let s = r.mood_streak.expect("应有一条「连续心情」");
        assert_eq!(s.mood, 5, "应取天数最多的那一种");
        assert_eq!(s.days, 3, "4 与 5 必须分开算，不能接成 5 天");
        assert_eq!(s.from, "2026-09-12");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
