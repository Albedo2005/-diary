//! 第三阶段：修正前两阶段测试的缺陷，确定 FTS 表结构。
//!
//! 前两阶段暴露了两个我理解错的点，这一阶段专门验证：
//!
//! 缺陷 1：用 `content='entry'` 的外部内容表 + `SELECT count(*)` 去测
//!        "触发器是否必需"，是无效实验。因为外部内容表**不存储文本**，
//!        `count(*)` 直接从内容表 entry 读取，无论索引是否更新都会增长。
//!        正确做法是对新插入的内容做 MATCH 查询 —— 没同步就搜不到。
//!
//! 缺陷 2：内容表 `content=''`（contentless）不存储原始文本，因此
//!        `highlight()` / `snippet()` 返回 NULL。而搜索结果高亮是需要它的。
//!
//! 这一阶段用**普通 FTS5 表**（存储分词后的文本）重测这两件事。

use jieba_rs::Jieba;
use rusqlite::{params, Connection};

fn main() {
    println!("=== FTS 表结构定案测试 ===\n");
    let db = "probe-out_schema.db";
    let _ = std::fs::remove_file(db);
    let conn = Connection::open(db).expect("打开库失败");
    let jieba = Jieba::new();

    conn.execute_batch(
        "CREATE TABLE entry (
             id INTEGER PRIMARY KEY,
             entry_date TEXT NOT NULL UNIQUE,
             title TEXT NOT NULL DEFAULT '',
             content_md TEXT NOT NULL DEFAULT ''
         );",
    )
    .unwrap();

    let seg = |s: &str| jieba.cut(s, false).join(" ");

    // ---------- 定案结构：普通 FTS5 表，存分词后的文本 ----------
    // 为什么不用 content='entry' 外部内容表：
    //   外部内容表的列必须与内容表列一一对应，但我们需要存的是"分词后的文本"，
    //   而内容表存的是原文 —— 两者不是同一份数据，硬套只会导致设计别扭。
    // 为什么不用 content=''：
    //   省空间但丢失 highlight()/snippet() 能力（已实测返回 NULL）。
    // 结论：用普通 FTS5 表，索引里存分词文本，原文仍只存在 entry 表。
    conn.execute_batch(
        "CREATE VIRTUAL TABLE entry_fts USING fts5(
             seg, tokenize='unicode61'
         );",
    )
    .unwrap();

    // ---------- 缺陷 1 的正确实验：触发器到底是否必需 ----------
    println!("--- 触发器是否必需（这次用 MATCH 判定，而不是 count）---");

    // A 表：无触发器
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_novice USING fts5(seg, tokenize='unicode61');",
    )
    .unwrap();
    // B 表：有触发器
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_trigger USING fts5(seg, tokenize='unicode61');
         CREATE TRIGGER e_ai AFTER INSERT ON entry BEGIN
             INSERT INTO fts_trigger(rowid, seg) VALUES (new.id, new.title || ' ' || new.content_md);
         END;
         CREATE TRIGGER e_ad AFTER DELETE ON entry BEGIN
             INSERT INTO fts_trigger(fts_trigger, rowid, seg) VALUES ('delete', old.id, old.title || ' ' || old.content_md);
         END;
         CREATE TRIGGER e_au AFTER UPDATE ON entry BEGIN
             INSERT INTO fts_trigger(fts_trigger, rowid, seg) VALUES ('delete', old.id, old.title || ' ' || old.content_md);
             INSERT INTO fts_trigger(rowid, seg) VALUES (new.id, new.title || ' ' || new.content_md);
         END;",
    )
    .unwrap();

    // 注意：触发器里存的是**原文**（触发器无法调用 Rust 的 jieba）。
    // 这引出一个关键设计问题，见文末"触发器与分词的冲突"。

    conn.execute(
        "INSERT INTO entry (entry_date, title, content_md) VALUES ('2026-09-20', '测试', '今天去吃了火锅。')",
        [],
    )
    .unwrap();

    let nov: Vec<String> = conn
        .prepare("SELECT seg FROM fts_novice WHERE fts_novice MATCH '\"火锅\"'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let trg: Vec<String> = conn
        .prepare("SELECT seg FROM fts_trigger WHERE fts_trigger MATCH '\"火锅\"'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    println!("  无触发器表搜「火锅」: {} （{}）",
        if nov.is_empty() { "无结果" } else { "有结果" },
        if nov.is_empty() { "✓ 确认索引不会自动同步" } else { "✗ 意外" });
    println!("  有触发器表搜「火锅」: {} （{}）",
        if trg.is_empty() { "无结果" } else { "有结果" },
        if trg.is_empty() { "✗ 意外" } else { "✓ 触发器确实能同步索引" });
    println!("  → 结论：索引同步必须自己负责，SQLite 不会代劳。");

    // ---------- 缺陷 2 的正确实验：highlight 需要存储文本 ----------
    println!("\n--- 高亮能力：普通表 vs contentless 表 ---");
    let plain_seg = format!("{} {}", seg("今天很开心"), seg("今天很开心，和朋友去吃了火锅，聊到很晚才回家。"));
    conn.execute(
        "INSERT INTO entry_fts(rowid, seg) VALUES (1, ?1)",
        params![plain_seg],
    )
    .unwrap();

    let hl: Result<String, _> = conn.query_row(
        "SELECT highlight(entry_fts, 0, '[', ']') FROM entry_fts WHERE entry_fts MATCH '\"火锅\"'",
        [],
        |r| r.get(0),
    );
    let hl_text = match &hl {
        Ok(s) => {
            println!("  普通表 highlight(): {s}");
            Some(s.clone())
        }
        Err(e) => {
            println!("  普通表 highlight() 失败: {e}");
            None
        }
    };

    // 对照：contentless 表
    conn.execute_batch("CREATE VIRTUAL TABLE fts_cl USING fts5(seg, content='', tokenize='unicode61');")
        .unwrap();
    conn.execute("INSERT INTO fts_cl(rowid, seg) VALUES (1, ?1)", params![plain_seg]).unwrap();
    let hl2: Result<String, _> = conn.query_row(
        "SELECT highlight(fts_cl, 0, '[', ']') FROM fts_cl WHERE fts_cl MATCH '\"火锅\"'",
        [],
        |r| r.get(0),
    );
    match hl2 {
        Ok(s) => println!("  contentless 表 highlight(): {s}"),
        Err(e) => println!("  contentless 表 highlight() 失败: {e}"),
    }
    println!("  → 结论：要高亮就必须存文本，contentless 表省空间但放弃高亮。");

    // 高亮输出到底长什么样？这决定前端能不能直接用
    println!("\n--- 高亮输出的真实形态（决定前端实现方式）---");
    if let Some(s) = hl_text {
        println!("  原始输出: {s}");
        println!("  注意其中的空格 —— 它们来自 jieba 分词，不是原文内容。");
        println!("  若直接把这段喂给用户，会看到「开心 ，和 朋友」这种被拆开的排版。");
        println!("  → 实践建议：高亮不要用 FTS5 的输出，改为在**原文**上做子串匹配。");
        println!("     理由：FTS5 只告诉我们是哪条记录命中，位置信息可由前端按查询词");
        println!("     在原文中定位，排版才是用户看到的真实文本。");
    }

    println!("\n=== 定案 ===");
}
