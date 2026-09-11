//! 诊断：触发器到底有没有把数据写进 FTS 索引。
//!
//! 上一版测试出现矛盾结果：无触发表搜不到（符合预期），
//! 有触发表也搜不到（不符合预期）。不再猜测，直接把库里的实际内容打出来。

use rusqlite::{params, Connection};

fn dump(conn: &Connection, table: &str) {
    println!("  [{table}] 内容:");
    let sql = format!("SELECT rowid, seg FROM {table}");
    match conn.prepare(&sql) {
        Ok(mut stmt) => {
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            });
            match rows {
                Ok(it) => {
                    let mut n = 0;
                    for row in it.flatten() {
                        println!("    rowid={} seg={:?}", row.0, row.1);
                        n += 1;
                    }
                    if n == 0 {
                        println!("    (空表)");
                    }
                }
                Err(e) => println!("    查询失败: {e}"),
            }
        }
        Err(e) => println!("    准备语句失败: {e}"),
    }
}

fn main() {
    println!("=== 触发器诊断 ===\n");
    let db = "probe-out_trigger_diag.db";
    let _ = std::fs::remove_file(db);
    let conn = Connection::open(db).expect("打开库失败");

    conn.execute_batch(
        "CREATE TABLE entry (
             id INTEGER PRIMARY KEY,
             entry_date TEXT NOT NULL UNIQUE,
             title TEXT NOT NULL DEFAULT '',
             content_md TEXT NOT NULL DEFAULT ''
         );",
    )
    .unwrap();

    // 建表 + 触发器，然后把 sqlite_master 里的触发器定义读回来核对
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_trigger USING fts5(seg, tokenize='unicode61');
         CREATE TRIGGER e_ai AFTER INSERT ON entry BEGIN
             INSERT INTO fts_trigger(rowid, seg) VALUES (new.id, new.title || ' ' || new.content_md);
         END;",
    )
    .unwrap();

    println!("--- sqlite_master 里实际注册的触发器 ---");
    let mut stmt = conn
        .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='trigger'")
        .unwrap();
    let trs: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    if trs.is_empty() {
        println!("  ✗ 没有任何触发器被注册！这就是原因。");
    } else {
        for (n, t) in &trs {
            println!("  触发器 {n} ON {t}");
        }
    }

    println!("\n--- 插入前 ---");
    dump(&conn, "fts_trigger");

    conn.execute(
        "INSERT INTO entry (entry_date, title, content_md) VALUES ('2026-09-20', '测试', '今天去吃了火锅。')",
        [],
    )
    .unwrap();
    println!("\n--- 插入后 ---");
    dump(&conn, "fts_trigger");

    // 直接看 FTS 内部索引表有没有内容
    println!("\n--- FTS5 内部影子表 ---");
    for t in ["fts_trigger_data", "fts_trigger_idx", "fts_trigger_content", "fts_trigger_docsize", "fts_trigger_config"] {
        let n: Result<i64, _> = conn.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0));
        match n {
            Ok(c) => println!("  {t}: {c} 行"),
            Err(e) => println!("  {t}: 不可用 ({e})"),
        }
    }

    // 用两种查询方式对比：MATCH vs 直接看列
    println!("\n--- 查询方式对比 ---");
    let by_match: Vec<String> = conn
        .prepare("SELECT seg FROM fts_trigger WHERE fts_trigger MATCH '\"火锅\"'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("  MATCH '\"火锅\"' -> {by_match:?}");

    let by_match2: Vec<String> = conn
        .prepare("SELECT seg FROM fts_trigger WHERE fts_trigger MATCH '\"测试\"'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("  MATCH '\"测试\"' -> {by_match2:?}");

    // 手工插入一条对照，确认 MATCH 本身没问题
    conn.execute(
        "INSERT INTO fts_trigger(rowid, seg) VALUES (999, '手动 插入 火锅 测试')",
        params![],
    )
    .unwrap();
    let manual: Vec<String> = conn
        .prepare("SELECT seg FROM fts_trigger WHERE fts_trigger MATCH '\"火锅\"'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("  手工插入后 MATCH '\"火锅\"' -> {manual:?}");
    println!("  → 若手工插入能命中而触发器插入不能，说明问题在触发器；");
    println!("     若两者都不命中，说明问题在查询或 tokenizer。");

    println!("\n=== 诊断结束 ===");
}
