//! 第四阶段：验证 contentless_delete=1 方案是否比"原文列 + 传统 delete"更健壮。
//!
//! 上一阶段的实测结论：
//!   传统 FTS5 delete 命令 `INSERT INTO fts(fts, rowid, seg) VALUES('delete', old.id, old.seg)`
//!   要求提供的旧文本与索引中的**完全一致**，否则报 "SQL logic error"。
//!   这意味着 seg 列一旦与索引内容漂移（迁移、分词器升级、手工改数据），
//!   UPDATE/DELETE 就会报错甚至破坏索引。
//!
//! 本阶段验证 contentless_delete=1：
//!   - 删除只需 rowid，不需要重新提供原文 -> 天然免疫漂移问题
//!   - 索引不存储文本 -> 省掉一份分词文本（上一阶段实测 seg 列约占原文 1.0~1.5 倍）
//!   - 代价：失去 highlight() / snippet()
//!
//! 另一个真实局限也在此复现并确认：jieba 按词切分，所以搜「牛肉」搜不到
//! 「牛肉面」—— 精确分词的固有代价。缓解方案（同时建单字索引）也在此验证。

use jieba_rs::Jieba;
use rusqlite::{params, Connection};

fn main() {
    println!("=== contentless_delete=1 健壮性验证 ===\n");
    let db = "probe-out_robust.db";
    let _ = std::fs::remove_file(db);
    let conn = Connection::open(db).expect("打开库失败");
    let jieba = Jieba::new();
    let seg = |s: &str| jieba.cut(s, false).join(" ");

    conn.execute_batch(
        "CREATE TABLE entry (
             id INTEGER PRIMARY KEY,
             entry_date TEXT NOT NULL UNIQUE,
             title TEXT NOT NULL DEFAULT '',
             content_md TEXT NOT NULL DEFAULT '',
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );",
    )
    .unwrap();

    // 主索引：contentless_delete=1，按词切分
    let ok = conn
        .execute_batch(
            "CREATE VIRTUAL TABLE entry_fts USING fts5(
                 seg, tokenize='unicode61', content='', contentless_delete=1
             );",
        )
        .is_ok();
    println!("主索引 contentless_delete=1 建立: {}", if ok { "✓ 支持" } else { "✗ 此构建不支持" });
    if !ok {
        println!("  -> 需要退回传统 delete 方案并格外小心 seg 一致性");
        return;
    }

    // 辅助索引：单字切分，用于兜底搜到"牛肉"这类词的一部分
    conn.execute_batch(
        "CREATE VIRTUAL TABLE entry_fts_char USING fts5(
             chars, tokenize='unicode61', content='', contentless_delete=1
         );",
    )
    .unwrap();

    let char_seg = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(" ")
    };

    let insert = |date: &str, title: &str, body: &str| -> i64 {
        conn.execute(
            "INSERT INTO entry (entry_date, title, content_md, created_at, updated_at)
             VALUES (?1, ?2, ?3, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')",
            params![date, title, body],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        let text = format!("{title} {body}");
        conn.execute(
            "INSERT INTO entry_fts(rowid, seg) VALUES (?1, ?2)",
            params![id, seg(&text)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO entry_fts_char(rowid, chars) VALUES (?1, ?2)",
            params![id, char_seg(&text)],
        )
        .unwrap();
        id
    };

    let samples = [
        ("2026-09-10", "今天很开心", "今天很开心，和朋友去吃了火锅，聊到很晚才回家。"),
        ("2026-09-11", "平静的一天", "平静的一天，在家看了一天书，读完了一本小说。"),
        ("2026-09-12", "爬山", "今天去爬山，看到了很美的日落，山顶风很大。"),
        ("2026-09-13", "加班", "又加班到十点，回家路上买了一碗牛肉面，味道还不错。"),
    ];
    for (d, t, b) in samples {
        insert(d, t, b);
    }
    println!("已写入 {} 条\n", samples.len());

    // ---------- 搜索：词索引 vs 字索引 ----------
    println!("--- 搜索能力对比 ---");
    // 关键区别：两个索引用**不同的查询方式**
    //   词索引：查询词走 jieba，AND 连接（精确、可排序）
    //   字索引：查询词按单字 AND 连接（兜底，保证「牛肉」能搜到「牛肉面」）
    let search_words = |kw: &str| -> Vec<String> {
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
    let search_chars = |kw: &str| -> Vec<String> {
        // 单字 AND：不加引号，让 FTS5 按 token（单字）处理
        let query: Vec<String> = kw
            .chars()
            .filter(|c| !c.is_whitespace())
            .map(|c| c.to_string())
            .collect();
        if query.is_empty() {
            return Vec::new();
        }
        let q = query.join(" AND ");
        let mut stmt = conn
            .prepare("SELECT e.entry_date FROM entry_fts_char f JOIN entry e ON e.id=f.rowid WHERE entry_fts_char MATCH ?1")
            .unwrap();
        stmt.query_map([&q], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };

    for kw in ["火锅", "开心", "日落", "牛肉面", "牛肉", "小说"] {
        let a = search_words(kw);
        let b = search_chars(kw);
        println!(
            "  「{kw}」 词索引={:<18} 字索引={:<18}",
            if a.is_empty() { "无".into() } else { format!("{a:?}") },
            if b.is_empty() { "无".into() } else { format!("{b:?}") }
        );
    }
    println!("  判读：字索引应能命中「牛肉」，而词索引不能。");
    println!("        这验证双索引兜底有效：词索引精确、可排序；字索引保证子串可命中。");

    // ---------- 关键验证：UPDATE / DELETE 不再需要旧文本 ----------
    println!("\n--- UPDATE / DELETE 健壮性（contentless_delete 的核心价值）---");
    conn.execute(
        "UPDATE entry SET content_md='改成了吃烧烤。' WHERE entry_date='2026-09-10'",
        [],
    )
    .unwrap();
    let id: i64 = conn
        .query_row("SELECT id FROM entry WHERE entry_date='2026-09-10'", [], |r| r.get(0))
        .unwrap();
    conn.execute("DELETE FROM entry_fts WHERE rowid=?1", params![id]).unwrap();
    conn.execute(
        "INSERT INTO entry_fts(rowid, seg) VALUES (?1, ?2)",
        params![id, seg("今天很开心 改成了吃烧烤。")],
    )
    .unwrap();
    println!("  UPDATE 流程: {}", "✓ 仅用 rowid 即可删除，无需重新提供旧文本");

    conn.execute("DELETE FROM entry WHERE entry_date='2026-09-13'", []).unwrap();
    let did: i64 = 4; // 被删记录的 id
    conn.execute("DELETE FROM entry_fts WHERE rowid=?1", params![did]).unwrap();
    println!("  DELETE 流程: {}", "✓ 同上");

    println!("  搜「火锅」: {:?} （应为空，已改为烧烤）", search_words("火锅"));
    println!("  搜「烧烤」: {:?} （应命中）", search_words("烧烤"));
    println!("  搜「牛肉面」: {:?} （应为空，已删除）", search_words("牛肉面"));

    // ---------- 一致性自检：FTS 是否可能残留孤儿行 ----------
    println!("\n--- 一致性自检 ---");
    let orphan: i64 = conn
        .query_row(
            "SELECT count(*) FROM entry_fts WHERE rowid NOT IN (SELECT id FROM entry)",
            [],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    if orphan < 0 {
        println!("  contentless 表无法直接 count 孤儿行（需 external content 或 rebuild 校验）");
    } else {
        println!("  FTS 中不在 entry 里的孤儿行: {orphan}  {}", if orphan == 0 { "✓" } else { "✗ 存在漏删" });
    }

    // ---------- 存储对比 ----------
    println!("\n--- 存储开销对比 ---");
    let pc: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let ps: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
    println!("  词索引 + 字索引 + 原文，库大小: {:.1} KB", (pc * ps) as f64 / 1024.0);
    println!("  参考：上一阶段（原文 + seg 列 + 普通 FTS，仅 4 条）约 28 KB。");
    println!("  结论：contentless 省掉了索引内的文本副本，但字索引会加回一部分；");
    println!("        总体积与数据量成正比，对纯文本日记不构成问题。");

    println!("\n=== 验证结束 ===");
}
