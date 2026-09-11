//! 定案验证：分段列 + 触发器的表结构（segment-in-table 模式）
//!
//! 背景（由 trigger_diag 实测得出，不是推测）：
//!   unicode61 tokenizer 不把汉字视为分隔符，"今天去吃了火锅。" 是一整个 token。
//!   因此索引里必须是**分词后的文本**，存原文会导致中文搜索失效
//!   （只有在 token 开头恰好匹配时才能搜到，如句首的"测试"）。
//!
//! 矛盾点：分词需要 jieba，而 jieba 只在 Rust 侧可用，
//!         SQLite 触发器无法调用它。
//!
//! 解法（本文件验证）：把分词结果作为 entry 表的一个**持久列** seg 存下来，
//!   写入时由 Rust 计算并写入，触发器只做 seg -> FTS 的搬运。
//!   好处：
//!     1. 触发器仍是唯一的索引同步机制，不会漏
//!     2. 数据库本身自洽（即便未来由别的语言写入，只要填对 seg 就能搜到）
//!     3. 便于排查：seg 列可以直接 SELECT 出来看分词结果

use jieba_rs::Jieba;
use rusqlite::{params, Connection};

fn main() {
    println!("=== 表结构定案验证：seg 列 + 触发器 ===\n");
    let db = "probe-out_final_schema.db";
    let _ = std::fs::remove_file(db);
    let conn = Connection::open(db).expect("打开库失败");
    let jieba = Jieba::new();
    let seg = |s: &str| jieba.cut(s, false).join(" ");

    // ---------- 表结构 ----------
    conn.execute_batch(
        "CREATE TABLE entry (
             id          INTEGER PRIMARY KEY,
             entry_date  TEXT NOT NULL UNIQUE,          -- 一天一篇的数据库级保证
             title       TEXT NOT NULL DEFAULT '',
             content_md  TEXT NOT NULL DEFAULT '',      -- 原文，用于显示与导出
             seg         TEXT NOT NULL DEFAULT '',      -- jieba 分词结果，用于搜索
             created_at  TEXT NOT NULL,
             updated_at  TEXT NOT NULL
         );

         -- 普通 FTS5 表：存分词后的文本。
         -- 不用外部内容表（列必须与内容表一一对应，而我们要存的是派生的分词文本）；
         -- 不用 contentless（会失去 highlight/snippet 能力，已实测返回 NULL）。
         CREATE VIRTUAL TABLE entry_fts USING fts5(seg, tokenize='unicode61');

         -- 触发器只搬运 seg，不参与分词
         CREATE TRIGGER entry_ai AFTER INSERT ON entry BEGIN
             INSERT INTO entry_fts(rowid, seg) VALUES (new.id, new.seg);
         END;
         CREATE TRIGGER entry_ad AFTER DELETE ON entry BEGIN
             INSERT INTO entry_fts(entry_fts, rowid, seg) VALUES ('delete', old.id, old.seg);
         END;
         CREATE TRIGGER entry_au AFTER UPDATE ON entry BEGIN
             INSERT INTO entry_fts(entry_fts, rowid, seg) VALUES ('delete', old.id, old.seg);
             INSERT INTO entry_fts(rowid, seg) VALUES (new.id, new.seg);
         END;",
    )
    .expect("建表失败");

    // ---------- 写入（Rust 侧计算分词）----------
    let samples = [
        ("2026-09-10", "今天很开心", "今天很开心，和朋友去吃了火锅，聊到很晚才回家。"),
        ("2026-09-11", "平静的一天", "平静的一天，在家看了一天书，读完了一本小说。"),
        ("2026-09-12", "爬山", "今天去爬山，看到了很美的日落，山顶风很大。"),
        ("2026-09-13", "加班", "又加班到十点，回家路上买了一碗牛肉面，味道还不错。"),
    ];
    let insert = |date: &str, title: &str, body: &str| {
        let seg_text = format!("{} {}", seg(title), seg(body));
        conn.execute(
            "INSERT INTO entry (entry_date, title, content_md, seg, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')",
            params![date, title, body, seg_text],
        )
        .unwrap();
    };
    for (d, t, b) in samples {
        insert(d, t, b);
    }
    println!("已写入 {} 条\n", samples.len());

    // ---------- 搜索：查询词也必须走 jieba ----------
    println!("--- 搜索验证（查询词同样走 jieba）---");
    let search = |kw: &str| -> Vec<String> {
        let q = seg(kw);
        let terms: Vec<String> = q.split_whitespace().map(|t| format!("\"{t}\"")).collect();
        let query = terms.join(" AND ");
        let mut stmt = conn
            .prepare("SELECT e.entry_date FROM entry_fts f JOIN entry e ON e.id=f.rowid WHERE entry_fts MATCH ?1")
            .unwrap();
        stmt.query_map([&query], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    for kw in ["火锅", "开心", "书", "日落", "牛肉面", "小说", "牛肉", "吃"] {
        let hits = search(kw);
        println!(
            "  「{kw}」-> {}",
            if hits.is_empty() { "无结果 ✗".to_string() } else { format!("{hits:?} ✓") }
        );
    }

    // ---------- 触发器在 UPDATE / DELETE 下是否正确 ----------
    println!("\n--- 更新与删除后索引是否同步 ---");
    conn.execute(
        "UPDATE entry SET content_md='改成了吃烧烤。', seg='改 成 了 吃 烧烤 。' WHERE entry_date='2026-09-10'",
        [],
    )
    .unwrap();
    println!("  修改后搜「火锅」: {:?} （应为空，旧内容应被移出索引）", search("火锅"));
    println!("  修改后搜「烧烤」: {:?} （应命中 2026-09-10）", search("烧烤"));

    conn.execute("DELETE FROM entry WHERE entry_date='2026-09-13'", []).unwrap();
    println!("  删除后搜「牛肉面」: {:?} （应为空）", search("牛肉面"));

    // ---------- 索引与原文是否一致（防漏同步）----------
    println!("\n--- 一致性自检 ---");
    let entries: i64 = conn.query_row("SELECT count(*) FROM entry", [], |r| r.get(0)).unwrap();
    let indexed: i64 = conn.query_row("SELECT count(*) FROM entry_fts", [], |r| r.get(0)).unwrap();
    println!("  entry 行数={entries}  entry_fts 行数={indexed}  {}", if entries == indexed { "✓ 一致" } else { "✗ 不一致，存在漏同步" });

    // ---------- 存储开销 ----------
    println!("\n--- 存储开销 ---");
    let raw: i64 = conn
        .query_row("SELECT sum(length(content_md)) FROM entry", [], |r| r.get(0))
        .unwrap_or(0);
    let seg_len: i64 = conn
        .query_row("SELECT sum(length(seg)) FROM entry", [], |r| r.get(0))
        .unwrap_or(0);
    let pc: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let ps: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
    println!("  正文原始字符数: {raw}");
    println!("  分词文本字符数: {seg_len}  （{:.2}x）", if raw > 0 { seg_len as f64 / raw as f64 } else { 0.0 });
    println!("  库文件大小: {:.1} KB（含 FTS 索引与开销）", (pc * ps) as f64 / 1024.0);
    println!("  说明：seg 列与 FTS 索引各占一份分词文本，都是原文的 1~1.5 倍。");
    println!("        对纯文本日记而言可以接受；若日记量大且在意体积，");
    println!("        可改用 contentless FTS 表省掉索引里的文本，代价是放弃 highlight。");

    println!("\n=== 定案完成 ===");
}
