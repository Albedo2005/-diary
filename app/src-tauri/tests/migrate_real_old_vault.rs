//! 【事项2 · 老数据不丢】用**真·旧格式库文件**跑一次升级，逐字比对。
//!
//! 与 `db.rs` 里那两条迁移单测的分工：
//!   - 那两条是"从当前库删列退回旧版"——**模拟**老库，好处是不依赖外部文件；
//!   - 本条用的是**真文件**（用户真实库升级前留下的 `diary.pre-vN.db` 快照），
//!     回答的是另一个问题："当年真实写出来的库，今天这版还能原样打开吗？"
//!
//! 默认 `#[ignore]` —— 它需要用户本机的真实数据，常规全量跑没有这个前提。
//!
//! 手动跑（bash 为例）：
//! ```text
//! DSH_REAL_VAULT_DB="<老库文件路径>" \
//! DSH_REAL_VAULT_KEYFILE="<含 key_hex 的 auto_login.json 路径>" \
//! DSH_REAL_VAULT_LABEL="v1" \
//! cargo test -p app -j 1 --test migrate_real_old_vault -- --ignored --nocapture
//! ```
//!
//! 两条红线：
//!   1. **只在临时目录的副本上操作** —— 源文件一个字节都不碰；
//!   2. **绝不打印密钥内容**（只报长度）。

use app_lib::crypto::KEY_LEN;
use app_lib::db::{open_verified_connection_readonly, Vault};
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// 一篇日记里"绝不能变"的部分。
///
/// 故意**不含 `locked`**：那是 v1→v2 才加的列，老库里根本没有，
/// 拿它做前后比对必然对不上 —— 而这里要回答的是"迁移有没有动数据"。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    entry_date: String,
    title: String,
    content_md: String,
    word_count: i64,
    mood: Option<i64>,
    created_at: String,
    updated_at: String,
}

fn dump_entries(conn: &Connection) -> Vec<Row> {
    let mut stmt = conn
        .prepare(
            "SELECT entry_date, title, content_md, word_count, mood, created_at, updated_at
             FROM entry ORDER BY entry_date ASC",
        )
        .expect("读 entry 失败");
    let rows = stmt
        .query_map([], |r| {
            Ok(Row {
                entry_date: r.get(0)?,
                title: r.get(1)?,
                content_md: r.get(2)?,
                word_count: r.get(3)?,
                mood: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
            })
        })
        .expect("查询 entry 失败");
    rows.collect::<Result<Vec<_>, _>>().expect("取 entry 行失败")
}

/// 老标签关联：`(日期, 标签名)`。
///
/// 只取各版本都有的列 —— `tag.retired` 是 v3 才加的，⛔ 不能碰。
fn dump_tags(conn: &Connection) -> Vec<(String, String)> {
    let mut stmt = conn
        .prepare(
            "SELECT e.entry_date, t.name
             FROM entry_tag et
             JOIN entry e ON e.id = et.entry_id
             JOIN tag   t ON t.id = et.tag_id
             ORDER BY e.entry_date ASC, t.name ASC",
        )
        .expect("读标签失败");
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("查询标签失败");
    rows.collect::<Result<Vec<_>, _>>().expect("取标签行失败")
}

fn hex_to_key(hex: &str) -> [u8; KEY_LEN] {
    let hex = hex.trim();
    assert_eq!(
        hex.len(),
        KEY_LEN * 2,
        "key_hex 长度不对，应为 {} 个十六进制字符",
        KEY_LEN * 2
    );
    let mut out = [0u8; KEY_LEN];
    for i in 0..KEY_LEN {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .unwrap_or_else(|_| panic!("key_hex 第 {} 个字节不是合法十六进制", i));
    }
    out
}

fn copy_in(src: &Path, dst: &Path) {
    std::fs::copy(src, dst).unwrap_or_else(|e| panic!("复制 {} 失败: {e}", src.display()));
}

#[test]
#[ignore = "需要用户本机的真实老库：设好 DSH_REAL_VAULT_DB / DSH_REAL_VAULT_KEYFILE 后加 --ignored 跑"]
fn real_old_vault_migrates_without_losing_a_character() {
    let src_db = std::env::var("DSH_REAL_VAULT_DB")
        .expect("必须设置 DSH_REAL_VAULT_DB ＝ 要验证的老库文件路径");
    let key_file = std::env::var("DSH_REAL_VAULT_KEYFILE")
        .expect("必须设置 DSH_REAL_VAULT_KEYFILE ＝ 含 key_hex 的 auto_login.json 路径");
    let label = std::env::var("DSH_REAL_VAULT_LABEL").unwrap_or_else(|_| "old".into());

    // ---------- 只在副本上干活 ----------
    let tmp: PathBuf = std::env::temp_dir().join(format!("dsh-real-migrate-{label}"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).expect("建临时目录失败");
    copy_in(Path::new(&src_db), &tmp.join("diary.db"));
    copy_in(Path::new(&key_file), &tmp.join("auto_login.json"));

    let key_json = std::fs::read_to_string(tmp.join("auto_login.json")).expect("读 auto_login.json 失败");
    let v: serde_json::Value =
        serde_json::from_str(&key_json).expect("auto_login.json 不是合法 JSON");
    let key_hex = v
        .get("key_hex")
        .and_then(|x| x.as_str())
        .expect("auto_login.json 里没有 key_hex 字段");
    let key = hex_to_key(key_hex);
    println!("[{label}] 密钥长度 {} 字节（只报长度，不打印内容）", key.len());

    // ---------- 升级前：只读打开，原样抄一遍 ----------
    let (before_entries, before_tags) = {
        let conn = open_verified_connection_readonly(&tmp.join("diary.db"), &key)
            .expect("用真密钥打不开这个老库 —— 密钥对不上，或文件本身损坏");
        let e = dump_entries(&conn);
        let t = dump_tags(&conn);
        println!("[{label}] 升级前：{} 篇日记、{} 条标签关联", e.len(), t.len());
        // 老库若是空的，这条验证就等于什么也没验 —— 显式拦住，别让"全绿"变假绿。
        assert!(
            !e.is_empty() || !t.is_empty(),
            "老库里一篇日记、一条标签都没有，这条验证没有意义"
        );
        (e, t)
    };

    // ---------- 升级（unlock_with_key 内部会 migrate）----------
    let vault = Vault::unlock_with_key(&tmp, &key).expect("老库必须能被现在这版升级打开");

    let ver: i64 = vault
        .conn()
        .query_row("SELECT version FROM schema_version", [], |r| r.get(0))
        .unwrap();
    println!("[{label}] 升级后 schema 版本 = {ver}");
    assert_eq!(ver, app_lib::schema::SCHEMA_VERSION, "版本号必须推到最新");

    // ---------- 升级后：同样口径再抄一遍 ----------
    let after_entries = dump_entries(vault.conn());
    let after_tags = dump_tags(vault.conn());
    println!(
        "[{label}] 升级后：{} 篇日记、{} 条标签关联",
        after_entries.len(),
        after_tags.len()
    );

    // ---------- 逐字比对 ----------
    assert_eq!(after_entries.len(), before_entries.len(), "篇数变了");
    for (b, a) in before_entries.iter().zip(after_entries.iter()) {
        assert_eq!(a.entry_date, b.entry_date, "日期变了");
        assert_eq!(a.content_md, b.content_md, "【{}】的正文被改动了", b.entry_date);
        assert_eq!(a.title, b.title, "【{}】的标题被改动了", b.entry_date);
        assert_eq!(a.word_count, b.word_count, "【{}】的字数被改动了", b.entry_date);
        assert_eq!(a.mood, b.mood, "【{}】的心情被改动了", b.entry_date);
        assert_eq!(a.created_at, b.created_at, "【{}】的创建时间被改动了", b.entry_date);
        assert_eq!(a.updated_at, b.updated_at, "【{}】的更新时间被改动了", b.entry_date);
    }
    assert_eq!(after_tags, before_tags, "标签关联变了");

    // ---------- 升级前的快照必须留下（出事后唯一的退路）----------
    let snaps: Vec<String> = std::fs::read_dir(&tmp)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with("diary.pre-v") && n.ends_with(".db"))
        .collect();
    println!("[{label}] 升级前快照：{snaps:?}");
    assert!(!snaps.is_empty(), "升级前必须留下 diary.pre-vN.db 快照");

    // ---------- 汇总 ----------
    let total_chars: usize = after_entries.iter().map(|r| r.content_md.chars().count()).sum();
    let total_words: i64 = after_entries.iter().map(|r| r.word_count).sum();
    println!(
        "[{label}] ✅ 全部一致：{} 篇、正文共 {} 字符（字数统计合计 {}）",
        after_entries.len(),
        total_chars,
        total_words
    );

    let _ = std::fs::remove_dir_all(&tmp);
}
