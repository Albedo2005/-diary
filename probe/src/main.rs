//! 中文全文搜索方案对比（probe 第二阶段）
//!
//! 背景：第一阶段实测确认 SQLite FTS5 的默认 tokenizer 对中文完全失效 ——
//! 整句被当成一个 token，搜「火锅」搜不到「今天去吃了火锅」。
//!
//! 本阶段对三种方案做实测对比，用数据决定选哪个：
//!
//!   A. unicode61 + jieba 预分词
//!      写入索引前先用 jieba 切词、以空格连接，查询也走同一套切词。
//!      优点：分词准确、索引体积可控、无外部依赖
//!      缺点：需要维护"原文 -> 分词文本"的同步（靠触发器）
//!
//!   B. trigram tokenizer
//!      SQLite 内置的三元组分词器，把文本切成连续 3 字窗口。
//!      优点：零依赖、能子串匹配、任何语言都work
//!      缺点：索引体积显著变大；**少于 3 字的查询词无法匹配**
//!
//!   C. simple 扩展（支持中文+拼音的 FTS5 tokenizer）
//!      本阶段不实测（需要引入 C 扩展并走 loadable extension 路径），
//!      留作备选记录。
//!
//! 同时验证第一阶段没测准的两件事：
//!   1. 外部内容 FTS 表到底需不需要 INSERT 触发器（上次的测试有缺陷，
//!      分词失效和索引未同步两个原因混在一起了）
//!   2. 全文搜索能否给出命中位置（决定要不要做"结果高亮"）

use jieba_rs::Jieba;
use rusqlite::{params, Connection};
use std::time::Instant;

fn main() {
    println!("=== 中文全文搜索方案对比 ===\n");
    let db = "probe-out_search.db";
    let _ = std::fs::remove_file(db);
    let conn = Connection::open(db).expect("打开数据库失败");
    let jieba = Jieba::new();

    conn.execute_batch(
        "CREATE TABLE entry (
             id          INTEGER PRIMARY KEY,
             entry_date  TEXT NOT NULL UNIQUE,
             title       TEXT NOT NULL DEFAULT '',
             content_md  TEXT NOT NULL DEFAULT ''
         );",
    )
    .unwrap();

    // 一批真实感的中文日记样本
    let samples = [
        ("2026-09-10", "今天很开心", "今天很开心，和朋友去吃了火锅，聊到很晚才回家。"),
        ("2026-09-11", "平静的一天", "平静的一天，在家看了一天书，读完了一本小说。"),
        ("2026-09-12", "爬山",       "今天去爬山，看到了很美的日落，山顶风很大。"),
        ("2026-09-13", "加班",       "又加班到十点，回家路上买了一碗牛肉面，味道还不错。"),
        ("2026-09-14", "周末",       "周末睡到自然醒，下午整理了房间，把书架重新摆了一遍。"),
    ];
    for (d, t, c) in samples {
        conn.execute(
            "INSERT INTO entry (entry_date, title, content_md) VALUES (?1, ?2, ?3)",
            params![d, t, c],
        )
        .unwrap();
    }
    println!("已写入 {} 条中文样本\n", samples.len());

    // ================= 方案 A：unicode61 + jieba 预分词 =================
    println!("--- 方案 A：jieba 预分词 + unicode61 ---");
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_jieba USING fts5(
             seg, content='', tokenize='unicode61'
         );",
    )
    .unwrap();

    // jieba 切词 + 空格连接。用 jieba 的 cut（精确模式）。
    fn seg_text(jieba: &Jieba, s: &str) -> String {
        jieba.cut(s, false).join(" ")
    }

    let t = Instant::now();
    for (i, (_, title, content)) in samples.iter().enumerate() {
        let seg = format!("{} {}", seg_text(&jieba, title), seg_text(&jieba, content));
        conn.execute(
            "INSERT INTO fts_jieba (rowid, seg) VALUES (?1, ?2)",
            params![(i + 1) as i64, seg],
        )
        .unwrap();
    }
    println!("  索引 5 条耗时: {:?}", t.elapsed());

    // 展示分词结果，这是判断分词质量最直接的方式
    println!("  分词示例（第一条）:");
    println!("    标题 -> {}", seg_text(&jieba, samples[0].1));
    println!("    正文 -> {}", seg_text(&jieba, samples[0].2));

    // 查询：同样要走 jieba，否则查询词和索引词对不上
    println!("  查询测试:");
    for kw in ["火锅", "开心", "书", "日落", "牛肉面", "小说", "房间"] {
        let q = seg_text(&jieba, kw);
        let terms: Vec<String> = q.split_whitespace().map(|t| format!("\"{t}\"")).collect();
        let query = terms.join(" AND ");
        let mut stmt = conn
            .prepare("SELECT e.entry_date FROM fts_jieba f JOIN entry e ON e.id=f.rowid WHERE fts_jieba MATCH ?1")
            .unwrap();
        let hits: Vec<String> = stmt
            .query_map([&query], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        println!(
            "    搜「{kw}」(-> {query}) : {}",
            if hits.is_empty() { "无结果 ✗".to_string() } else { format!("命中 {hits:?} ✓") }
        );
    }

    // 拼音支持检查（jieba 不做拼音，说明这一项需要另找方案）
    println!("  拼音搜索: 未实现（jieba 只做汉字分词；若要拼音需额外引入 pinyin crate）");

    // 索引体积
    let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
    println!("  数据库体积: {:.1} KB\n", (page_count * page_size) as f64 / 1024.0);

    // ================= 方案 B：trigram =================
    println!("--- 方案 B：trigram tokenizer ---");
    let trigram_ok = conn
        .execute_batch(
            "CREATE VIRTUAL TABLE fts_tri USING fts5(
                 content, tokenize='trigram'
             );",
        )
        .is_ok();
    if !trigram_ok {
        println!("  ✗ 此 SQLCipher 构建不支持 trigram tokenizer");
    } else {
        for (i, (_, title, content)) in samples.iter().enumerate() {
            conn.execute(
                "INSERT INTO fts_tri (rowid, content) VALUES (?1, ?2)",
                params![(i + 1) as i64, format!("{title} {content}")],
            )
            .unwrap();
        }
        println!("  查询测试（无预分词，直接查）:");
        for kw in ["火锅", "开心", "书", "日落", "牛肉面", "小说"] {
            let mut stmt = conn
                .prepare("SELECT e.entry_date FROM fts_tri f JOIN entry e ON e.id=f.rowid WHERE fts_tri MATCH ?1")
                .unwrap();
            let hits: Vec<String> = stmt
                .query_map([&format!("\"{kw}\"")], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let note = if kw.chars().count() < 3 { "  <- 2 字词，trigram 天然做不到" } else { "" };
            println!(
                "    搜「{kw}」: {}{note}",
                if hits.is_empty() { "无结果 ✗".to_string() } else { format!("命中 {hits:?} ✓") }
            );
        }
        // 对比索引体积增长
        let pc: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        let ps: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
        println!("  加入 trigram 索引后数据库体积: {:.1} KB", (pc * ps) as f64 / 1024.0);
    }

    // ================= 触发器同步验证 =================
    println!("\n--- 外部内容 FTS 表是否需要触发器 ---");
    // 第一次写这里时报错 "no such column: T.seg"，原因是设计上的误解：
    //   content='entry' 的外部内容表，其 FTS 列必须与内容表的列**逐一对应**，
    //   因为 FTS5 要用 old/new 的行去内容表里回查。我把列名写成 seg 就崩了。
    //
    // 由此得出正式设计的两条路线（见文档结论）：
    //   路线 1：content='entry' + FTS 列 = (title, content_md)，触发器里现算分词
    //   路线 2：content='' 内容表，自己管分词与增删
    // 这里用路线 1 验证触发器是否真的必要。
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_sync USING fts5(
             title, content_md, content='entry', content_rowid='id', tokenize='unicode61'
         );
         -- 外部内容表必须自己维护索引，SQLite 不会自动同步
         CREATE TRIGGER entry_ai AFTER INSERT ON entry BEGIN
             INSERT INTO fts_sync(rowid, title, content_md) VALUES (new.id, new.title, new.content_md);
         END;
         CREATE TRIGGER entry_ad AFTER DELETE ON entry BEGIN
             INSERT INTO fts_sync(fts_sync, rowid, title, content_md) VALUES ('delete', old.id, old.title, old.content_md);
         END;
         CREATE TRIGGER entry_au AFTER UPDATE ON entry BEGIN
             INSERT INTO fts_sync(fts_sync, rowid, title, content_md) VALUES ('delete', old.id, old.title, old.content_md);
             INSERT INTO fts_sync(rowid, title, content_md) VALUES (new.id, new.title, new.content_md);
         END;
         -- 把已有数据补进索引
         INSERT INTO fts_sync(fts_sync) VALUES ('rebuild');",
    )
    .expect("建同步表与触发器失败");

    let before: i64 = conn.query_row("SELECT count(*) FROM fts_sync", [], |r| r.get(0)).unwrap();
    println!("  rebuild 后索引行数: {before}");

    // 新增一条记录，验证触发器是否让索引立刻跟上
    conn.execute(
        "INSERT INTO entry (entry_date, title, content_md) VALUES ('2026-09-15', '新记录', '今天去看了一部电影，很有意思。')",
        [],
    )
    .unwrap();
    let after: i64 = conn.query_row("SELECT count(*) FROM fts_sync", [], |r| r.get(0)).unwrap();
    println!(
        "  插入新记录后索引行数: {after}  {}",
        if after == before + 1 { "✓ 触发器生效，索引自动同步" } else { "✗ 索引未同步，说明触发器没起作用" }
    );

    // 反证：没有触发器的表不会同步。用一张同样结构但无触发器的表对比。
    conn.execute_batch(
        "CREATE VIRTUAL TABLE fts_no_trigger USING fts5(
             title, content_md, content='entry', content_rowid='id', tokenize='unicode61'
         );
         INSERT INTO fts_no_trigger(fts_no_trigger) VALUES ('rebuild');",
    )
    .unwrap();
    let nt_before: i64 = conn.query_row("SELECT count(*) FROM fts_no_trigger", [], |r| r.get(0)).unwrap();
    conn.execute(
        "INSERT INTO entry (entry_date, title, content_md) VALUES ('2026-09-16', '又一条', '测试无触发器的情况。')",
        [],
    )
    .unwrap();
    let nt_after: i64 = conn.query_row("SELECT count(*) FROM fts_no_trigger", [], |r| r.get(0)).unwrap();
    println!(
        "  对照实验（无触发器的表）: {nt_before} -> {nt_after}  {}",
        if nt_after == nt_before { "✓ 确认不会自动同步，触发器是必需的" } else { "？ 竟然同步了，需重新理解" }
    );

    // ================= 命中位置（高亮可行性）=================
    println!("\n--- 命中位置 API（决定能否做结果高亮）---");
    // 用 jieba 方案的表测：索引里存的是分词后的文本，高亮出来也会是分词形态，
    // 这直接影响做不做高亮，必须实测而不是猜。
    let hl: Result<String, _> = conn.query_row(
        "SELECT highlight(fts_jieba, 0, '[', ']') FROM fts_jieba WHERE fts_jieba MATCH '\"火锅\"' LIMIT 1",
        [],
        |r| r.get(0),
    );
    match hl {
        Ok(s) => println!("  highlight() 输出: {s}"),
        Err(e) => println!("  highlight() 失败: {e}"),
    }
    let sn: Result<String, _> = conn.query_row(
        "SELECT snippet(fts_jieba, 0, '[', ']', '...', 6) FROM fts_jieba WHERE fts_jieba MATCH '\"火锅\"' LIMIT 1",
        [],
        |r| r.get(0),
    );
    match sn {
        Ok(s) => println!("  snippet() 输出: {s}"),
        Err(e) => println!("  snippet() 失败: {e}"),
    }
    println!("  判读要点：若高亮输出里带着分词留下的空格，");
    println!("           说明高亮要基于**原文**在前端做子串匹配，而不是直接用 FTS5 输出。");

    println!("\n=== 对比结束 ===");
}
