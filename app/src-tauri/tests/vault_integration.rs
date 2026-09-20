//! 集成测试：端到端验证加密数据库的完整链路。
//!
//! 为什么必须有这一层：单元测试只验证了单个函数（如密钥派生、分词、日期换算），
//! 但**数据层最危险的 bug 藏在链路里** —— 例如
//!   - 写入时索引与正文不在同一事务 -> 日记搜不到
//!   - 索引用了分词文本但查询走了原文 -> 2 字词搜不到
//!   - 密码验证逻辑写错 -> 错误密码也能打开（加密形同虚设）
//!   - "一天一篇"约束没生效 -> 同日出现两条记录
//!
//! 这些只有真正建库、写数据、再读出来才能发现。
//!
//! 测试用临时目录，互不干扰。KDF 用真实默认参数（512 MiB），
//! 所以每个用例约 0.8 秒 —— 这是必要的代价，因为参数本身也是被测对象。

use app_lib::crypto::LockoutState;
use app_lib::db::Vault;
use app_lib::error::AppError;

/// 每个测试用独立的临时目录。
fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("dsh-diary-it-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建测试目录失败");
    dir
}

const PIN: &str = "135790";

// ---------------------------------------------------------------------------
// 加密与密码
// ---------------------------------------------------------------------------

#[test]
fn create_then_unlock_with_correct_pin() {
    let dir = temp_dir("unlock-ok");
    {
        let vault = Vault::create(&dir, PIN, Some("测试提示".into())).expect("创建应成功");
        drop(vault);
    }
    let vault = Vault::unlock(&dir, PIN).expect("正确密码必须能解锁");
    assert_eq!(vault.stats().unwrap().total_entries, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn wrong_pin_is_rejected_and_correct_pin_still_works() {
    let dir = temp_dir("unlock-bad");
    {
        Vault::create(&dir, PIN, None).expect("创建应成功");
    }

    // 关键安全断言：错误密码必须被拒绝。
    let err = Vault::unlock(&dir, "135791").expect_err("错误密码必须被拒绝");
    assert!(
        matches!(err, AppError::WrongPin),
        "错误密码应返回 WrongPin，实际: {err:?}"
    );

    // 另一条路径：位数相同但完全不同
    assert!(Vault::unlock(&dir, "000000").is_err());

    // 错误尝试之后，正确密码依然可用（不能因为一次失败就把库弄坏）。
    Vault::unlock(&dir, PIN).expect("错误尝试后正确密码仍应可用");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn database_file_is_encrypted_at_rest() {
    let dir = temp_dir("ciphertext");
    {
        let vault = Vault::create(&dir, PIN, None).unwrap();
        vault
            .save_entry(
                "2026-09-11",
                "今天很开心",
                "今天很开心，和朋友去吃了火锅，聊到很晚才回家。",
            )
            .unwrap();
    }

    // 文件层面确认是密文：正文里的汉字不应出现在数据库文件中。
    //
    // 为什么这条测试重要：只设置 PRAGMA key 但顺序写错（不是第一条语句）时，
    // 数据库会"看起来能用"，实际文件头已按明文写过，加密并没有真正生效。
    let bytes = std::fs::read(dir.join("diary.db")).expect("读取数据库文件失败");
    for needle in ["火锅", "开心", "牛肉面", "今天"] {
        let hay = String::from_utf8_lossy(&bytes);
        assert!(
            !hay.contains(needle),
            "数据库文件中发现明文「{needle}」—— 加密没有真正生效"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn creating_twice_is_rejected() {
    let dir = temp_dir("double-create");
    Vault::create(&dir, PIN, None).unwrap();
    // 第二次创建会覆盖已有数据库，必须拒绝 —— 否则用户会以为"重新设置了密码"，
    // 实际把旧日记全部丢掉。
    let err = Vault::create(&dir, PIN, None).expect_err("重复创建必须被拒绝");
    assert!(matches!(err, AppError::State(_)), "实际: {err:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 日记读写与"一天一篇"
// ---------------------------------------------------------------------------

#[test]
fn entry_roundtrip_persists_across_reopen() {
    let dir = temp_dir("persist");
    {
        let vault = Vault::create(&dir, PIN, None).unwrap();
        vault
            .save_entry("2026-09-11", "标题", "正文内容在这里。")
            .unwrap();
    }

    // 重新打开（模拟重启应用）后内容必须还在且完全一致。
    let vault = Vault::unlock(&dir, PIN).unwrap();
    let entry = vault.find_entry_by_date("2026-09-11").unwrap().unwrap();
    assert_eq!(entry.title, "标题");
    assert_eq!(entry.content_md, "正文内容在这里。");
    assert!(entry.word_count > 0, "字数应被统计");

    // created_at 与 updated_at 都应存在，且格式为 RFC3339。
    assert!(entry.created_at.ends_with('Z'), "时间应为 UTC: {}", entry.created_at);
    assert!(entry.updated_at.ends_with('Z'));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn one_entry_per_day_is_enforced() {
    let dir = temp_dir("one-per-day");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 同一天保存两次应更新同一条，而不是产生两条。
    vault.save_entry("2026-09-11", "第一版", "第一次写。").unwrap();
    vault.save_entry("2026-09-11", "第二版", "改了一下。").unwrap();

    let list = vault.list_month("2026-09").unwrap();
    assert_eq!(list.len(), 1, "同一天必须只有一条日记，实际: {}", list.len());

    let entry = vault.find_entry_by_date("2026-09-11").unwrap().unwrap();
    assert_eq!(entry.title, "第二版");
    assert_eq!(entry.content_md, "改了一下。");
    // 创建时间应保持第一次的值，更新时间应被刷新 ——
    // 这样"这篇是什么时候开始写的"这个事实不会被后续编辑抹掉。
    assert_eq!(entry.created_at, entry.updated_at);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 回归测试：打开某天 ≠ 写过某天
//
// 用户报告的 bug：点一下日历（比如 9 月 9 日）什么都没写，日历就显示这天
// 写过日记。根因是 open 操作会无条件插入一条空记录，而日历标记只看
// "表里有没有行"。下面这一组测试就是为了钉死这个行为不再回归。
// ---------------------------------------------------------------------------

#[test]
fn opening_a_date_does_not_write_to_the_database() {
    let dir = temp_dir("open-no-write");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 打开一个全新的日期：返回空模板，但**不落库**。
    let entry = vault.open_entry("2026-09-12").unwrap();
    assert_eq!(entry.content_md, "");
    assert_eq!(entry.word_count, 0);
    assert_eq!(entry.id, 0, "未落库的日记 id 必须是 0");
    assert_eq!(entry.title, "");

    // 关键断言：表里不应有任何行，统计也不应把它算作一篇。
    let rows: i64 = vault
        .conn()
        .query_row("SELECT count(*) FROM entry", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 0, "仅仅打开某天不应在数据库里留下记录");
    assert_eq!(vault.stats().unwrap().total_entries, 0);
    assert!(!vault.is_written("2026-09-12").unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn opening_a_date_does_not_mark_the_calendar() {
    let dir = temp_dir("open-no-mark");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 模拟用户连续点开几个日期但什么都没写。
    for d in ["2026-09-09", "2026-09-10", "2026-09-11"] {
        vault.open_entry(d).unwrap();
    }

    // 日历标记必须仍然为空 —— 这正是用户报告的问题。
    let marked = vault.written_dates("2026-09-01", "2026-09-30").unwrap();
    assert!(
        marked.is_empty(),
        "没有任何内容时，日历不应标记任何日期，实际: {marked:?}"
    );
    assert!(vault.list_month("2026-09").unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn opening_existing_entry_returns_its_content_and_keeps_id() {
    let dir = temp_dir("open-existing");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault
        .save_entry("2026-09-12", "标题", "一些正文内容。")
        .unwrap();
    let saved_id = vault.find_entry_by_date("2026-09-12").unwrap().unwrap().id;

    // 打开已存在的日记：应返回真实内容与真实 id。
    let opened = vault.open_entry("2026-09-12").unwrap();
    assert_eq!(opened.id, saved_id);
    assert_eq!(opened.title, "标题");
    assert_eq!(opened.content_md, "一些正文内容。");
    // 不应因为"打开"而产生第二条记录。
    let rows: i64 = vault
        .conn()
        .query_row("SELECT count(*) FROM entry", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn title_only_does_not_count_as_written() {
    let dir = temp_dir("title-only");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 只打了标题、正文空白 —— 按用户直觉这不算"写完一篇"。
    vault.save_entry("2026-09-12", "只想了个标题", "").unwrap();

    assert!(
        !vault.is_written("2026-09-12").unwrap(),
        "只填标题不算写过"
    );
    assert!(
        vault.written_dates("2026-09-01", "2026-09-30").unwrap().is_empty(),
        "只填标题不应在日历上留下标记"
    );
    assert!(vault.list_month("2026-09").unwrap().is_empty());
    assert_eq!(vault.stats().unwrap().total_entries, 0);
    // 也不应进搜索索引，否则会出现"搜得到但日历没标记"的矛盾状态。
    assert!(vault.search("标题", 10).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn whitespace_only_content_does_not_count_as_written() {
    let dir = temp_dir("whitespace-only");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 只敲了空格、制表符和回车也不算写过。
    // 注意：SQLite 的 trim() 默认只去半角空格，所以这条用例专门覆盖
    // "制表符与换行"—— 实测发现过这个陷阱（见 db.rs 的 TRIM_CHARS）。
    vault
        .save_entry("2026-09-12", "", "   \n\t  \n  ")
        .unwrap();
    assert!(!vault.is_written("2026-09-12").unwrap());
    assert!(vault.written_dates("2026-09-01", "2026-09-30").unwrap().is_empty());
    assert_eq!(vault.stats().unwrap().total_entries, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn clearing_content_removes_the_calendar_mark() {
    let dir = temp_dir("clear-removes-mark");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    vault.save_entry("2026-09-12", "", "先写点东西。").unwrap();
    assert!(vault.is_written("2026-09-12").unwrap());
    assert_eq!(vault.search("东西", 10).unwrap().len(), 1);

    // 用户把正文全删了。后端仍会保存（前端负责按需删除整行），
    // 但"写过"的判定必须立刻变回 false —— 日历标记随之消失。
    vault.save_entry("2026-09-12", "", "").unwrap();
    assert!(
        !vault.is_written("2026-09-12").unwrap(),
        "清空正文后不应再算写过"
    );
    assert!(vault.written_dates("2026-09-01", "2026-09-30").unwrap().is_empty());
    // 索引也必须一起清掉，否则会搜到一篇"空日记"。
    assert!(
        vault.search("东西", 10).unwrap().is_empty(),
        "清空正文后索引必须同步移除"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn writing_then_reopening_threads_the_needle() {
    let dir = temp_dir("write-reopen");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 完整走一遍用户的真实路径：先点开（不写）-> 再写 -> 再点开别的日子。
    vault.open_entry("2026-09-09").unwrap(); // 点了但没写
    vault
        .save_entry("2026-09-10", "", "今天写了内容。")
        .unwrap();
    vault.open_entry("2026-09-11").unwrap(); // 又点了一天没写

    let marked = vault.written_dates("2026-09-01", "2026-09-30").unwrap();
    assert_eq!(
        marked,
        vec!["2026-09-10".to_string()],
        "只有真正写了内容的那天应被标记，实际: {marked:?}"
    );
    assert_eq!(vault.stats().unwrap().total_entries, 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn invalid_date_is_rejected() {
    let dir = temp_dir("bad-date");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    assert!(vault.open_entry("2026-9-1").is_err());
    assert!(vault.open_entry("2026/09/11").is_err());
    assert!(vault.open_entry("").is_err());
    assert!(vault.is_written("2026-9-1").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn delete_removes_entry_and_its_index() {
    let dir = temp_dir("delete");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault
        .save_entry("2026-09-11", "火锅", "今天去吃了火锅。")
        .unwrap();
    assert_eq!(vault.search("火锅", 10).unwrap().len(), 1);

    vault.delete_entry("2026-09-11").unwrap();
    assert!(vault.find_entry_by_date("2026-09-11").unwrap().is_none());
    // 索引也必须一起清掉，否则会搜到一条打不开的日记。
    assert_eq!(
        vault.search("火锅", 10).unwrap().len(),
        0,
        "删除日记后索引必须同步清理"
    );
    assert_eq!(vault.stats().unwrap().total_entries, 0);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 中文全文搜索（本项目的核心技术点）
// ---------------------------------------------------------------------------

fn seed(vault: &Vault) {
    vault
        .save_entry(
            "2026-09-10",
            "今天很开心",
            "今天很开心，和朋友去吃了火锅，聊到很晚才回家。",
        )
        .unwrap();
    vault
        .save_entry(
            "2026-09-11",
            "平静的一天",
            "平静的一天，在家看了一天书，读完了一本小说。",
        )
        .unwrap();
    vault
        .save_entry(
            "2026-09-12",
            "爬山",
            "今天去爬山，看到了很美的日落，山顶风很大。",
        )
        .unwrap();
    vault
        .save_entry(
            "2026-09-13",
            "加班",
            "又加班到十点，回家路上买了一碗牛肉面，味道还不错。",
        )
        .unwrap();
}

#[test]
fn chinese_two_character_search_works() {
    let dir = temp_dir("search-2char");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    // 这是最关键的一条：FTS5 内置 tokenizer 对中文失效（实测），
    // 2 字词在中文里是高频查询。必须能搜到。
    for (kw, expect_date) in [
        ("火锅", "2026-09-10"),
        ("开心", "2026-09-10"),
        ("日落", "2026-09-12"),
        ("小说", "2026-09-11"),
        ("加班", "2026-09-13"),
    ] {
        let hits = vault.search(kw, 20).unwrap();
        assert!(
            hits.iter().any(|h| h.entry_date == expect_date),
            "搜「{kw}」应命中 {expect_date}，实际: {:?}",
            hits.iter().map(|h| &h.entry_date).collect::<Vec<_>>()
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn substring_search_falls_back_to_single_char_index() {
    let dir = temp_dir("search-substring");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    // 「牛肉面」被 jieba 当一个整词，所以主索引里搜「牛肉」搜不到。
    // 这时必须由**单字兜底索引**命中 —— 这是双索引策略存在的唯一理由。
    let hits = vault.search("牛肉", 20).unwrap();
    assert!(
        hits.iter().any(|h| h.entry_date == "2026-09-13"),
        "搜「牛肉」应由单字索引命中含「牛肉面」的日记，实际: {:?}",
        hits.iter().map(|h| &h.entry_date).collect::<Vec<_>>()
    );
    // 并记录命中来源，便于调试与将来排序。
    assert_eq!(
        hits.iter().find(|h| h.entry_date == "2026-09-13").unwrap().matched_by,
        "char",
        "该结果应标注为由单字索引命中"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn search_snippet_contains_the_query_term() {
    let dir = temp_dir("search-snippet");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    let hits = vault.search("火锅", 10).unwrap();
    let hit = hits.first().expect("应至少命中一条");
    // 摘要取自原文，所以必须包含查询词本身 —— 这验证了
    // "高亮在原文上做、不用 FTS5 snippet()" 的决定可落地。
    assert!(
        hit.snippet.contains("火锅"),
        "摘要必须包含查询词，实际: {:?}",
        hit.snippet
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn search_after_edit_reflects_new_content() {
    let dir = temp_dir("search-after-edit");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault.save_entry("2026-09-11", "第一天", "去吃了火锅。").unwrap();
    assert_eq!(vault.search("火锅", 10).unwrap().len(), 1);

    // 改成别的内容后，旧词必须搜不到、新词必须搜得到。
    // 这条能抓住"更新时忘了重建索引"这类 bug。
    vault
        .save_entry("2026-09-11", "第一天", "改成吃烧烤了。")
        .unwrap();
    assert_eq!(
        vault.search("火锅", 10).unwrap().len(),
        0,
        "旧内容必须从索引中移除"
    );
    assert_eq!(
        vault.search("烧烤", 10).unwrap().len(),
        1,
        "新内容必须进入索引"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn empty_or_whitespace_query_returns_nothing() {
    let dir = temp_dir("search-empty");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);
    assert!(vault.search("", 10).unwrap().is_empty());
    assert!(vault.search("   ", 10).unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 日历与统计
// ---------------------------------------------------------------------------

#[test]
fn list_month_and_written_dates_agree() {
    let dir = temp_dir("calendar");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault); // 全部在 2026-09

    let list = vault.list_month("2026-09").unwrap();
    assert_eq!(list.len(), 4);
    // 必须按日期升序，日历依赖这个顺序。
    let dates: Vec<&str> = list.iter().map(|e| e.entry_date.as_str()).collect();
    let mut sorted = dates.clone();
    sorted.sort();
    assert_eq!(dates, sorted, "list_month 必须按日期升序返回");

    let written = vault.written_dates("2026-09-01", "2026-09-30").unwrap();
    assert_eq!(written.len(), 4);

    // 其他月份应为空。
    assert!(vault.list_month("2026-08").unwrap().is_empty());
    assert!(vault.list_month("bad-month").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stats_counts_entries_words_and_streak() {
    let dir = temp_dir("stats");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 连续三天 + 中间断一天 + 再一天 -> 从最近往前数，连续应为 1。
    vault.save_entry("2026-09-01", "", "第一天。").unwrap();
    vault.save_entry("2026-09-02", "", "第二天。").unwrap();
    vault.save_entry("2026-09-03", "", "第三天。").unwrap();
    vault.save_entry("2026-09-05", "", "断了一天之后。").unwrap();

    let s = vault.stats().unwrap();
    assert_eq!(s.total_entries, 4);
    assert!(s.total_words > 0);
    assert_eq!(s.streak_days, 1, "最近一天与前一天不连续，连续天数应为 1");
    assert_eq!(s.first_date.as_deref(), Some("2026-09-01"));
    assert_eq!(s.last_date.as_deref(), Some("2026-09-05"));

    // 再把断掉的那天补上：日期变成 09-01…09-05，全部相接，连续应为 5 天。
    // （我一开始把这里写成 4，是没算清楚"补上缺口后连成一条整段"。）
    vault.save_entry("2026-09-04", "", "补写的。").unwrap();
    let s2 = vault.stats().unwrap();
    assert_eq!(s2.streak_days, 5, "补上缺口后 09-01..09-05 应连续 5 天");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 索引一致性
// ---------------------------------------------------------------------------

#[test]
fn integrity_check_is_clean_after_normal_use() {
    let dir = temp_dir("integrity");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);
    vault.save_entry("2026-09-10", "改过的", "内容换了。").unwrap();
    vault.delete_entry("2026-09-12").unwrap();

    let r = vault.integrity_check().unwrap();
    assert_eq!(r.orphan_word_index, 0, "不应有孤儿索引行（词索引）");
    assert_eq!(r.orphan_char_index, 0, "不应有孤儿索引行（字索引）");
    assert_eq!(r.missing_word_index, 0, "不应有未索引的日记（词索引）");
    assert_eq!(r.missing_char_index, 0, "不应有未索引的日记（字索引）");
    assert_eq!(r.entry_count, 3);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn integrity_check_ignores_empty_drafts() {
    let dir = temp_dir("integrity-empty");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    // 造一条只有标题的空草稿。它按设计不进索引，
    // 所以一致性检查**不应**把它算作"缺失索引"。
    // 这条测试防止 integrity_check 与 save_entry 的收录规则漂移。
    vault.save_entry("2026-09-20", "只有标题", "").unwrap();

    let r = vault.integrity_check().unwrap();
    assert_eq!(r.missing_word_index, 0, "空草稿不该被算作缺失索引");
    assert_eq!(r.missing_char_index, 0, "空草稿不该被算作缺失索引");
    assert_eq!(r.entry_count, 4, "空草稿不计入篇数");
    assert!(r.is_healthy());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rebuild_indexes_recovers_searchability() {
    let dir = temp_dir("rebuild");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    // 模拟索引损坏：直接清空两张索引表。
    vault.conn().execute("DELETE FROM entry_fts", []).unwrap();
    vault.conn().execute("DELETE FROM entry_fts_char", []).unwrap();
    assert_eq!(vault.search("火锅", 10).unwrap().len(), 0);

    // 只重建有内容的日记，所以返回 4（不带空草稿）。
    let n = vault.rebuild_indexes().unwrap();
    assert_eq!(n, 4);
    // 重建后必须恢复可搜索 —— 这是"索引坏了也不丢数据"的兜底能力。
    assert_eq!(vault.search("火锅", 10).unwrap().len(), 1);
    assert!(
        vault.integrity_check().unwrap().is_healthy(),
        "重建后一致性检查应通过"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

#[test]
fn backup_is_readable_with_the_same_pin() {
    let dir = temp_dir("backup");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    let backup_dir = dir.join("backups");
    let dest = backup_dir.join("manual.db");
    let result = vault.backup_to(&dest).unwrap();
    assert!(result.bytes > 0, "备份文件不应为空");

    // 备份是密文：不应包含明文。
    let bytes = std::fs::read(&dest).unwrap();
    assert!(
        !String::from_utf8_lossy(&bytes).contains("火锅"),
        "备份文件里发现明文，备份应是密文"
    );

    // 备份必须能用**同一个密码**打开 —— 这是"备份可用"的定义。
    // 恢复流程：把备份改名成 diary.db，并把 crypto_meta.json 一起放进去。
    // 后者含 salt 与 KDF 参数，缺了它即使密码正确也派生不出密钥。
    let restore_dir = temp_dir("backup-restore");
    std::fs::copy(&dest, restore_dir.join("diary.db")).unwrap();
    std::fs::copy(
        dir.join("crypto_meta.json"),
        restore_dir.join("crypto_meta.json"),
    )
    .unwrap();

    let restored = Vault::unlock(&restore_dir, PIN).expect("备份应能用同一密码打开");
    let entries = restored.list_month("2026-09").unwrap();
    assert_eq!(entries.len(), 4, "备份里的日记应完整");
    assert_eq!(restored.search("火锅", 10).unwrap().len(), 1, "备份的索引也应可用");

    // 错误密码同样打不开备份。
    assert!(Vault::unlock(&restore_dir, "999999").is_err());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&restore_dir);
}

#[test]
fn backup_overwrites_existing_file() {
    let dir = temp_dir("backup-overwrite");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault.save_entry("2026-09-11", "", "第一篇。").unwrap();

    let dest = dir.join("b.db");
    let first = vault.backup_to(&dest).unwrap();
    assert!(first.bytes > 0);

    // 再备份一次到同一路径，应成功覆盖而不是报错。
    vault.save_entry("2026-09-12", "", "第二篇。").unwrap();
    let second = vault.backup_to(&dest).unwrap();
    assert!(second.bytes > 0);
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 锁定期状态（存在加密库之外）
// ---------------------------------------------------------------------------

#[test]
fn lockout_state_lives_outside_the_encrypted_database() {
    let dir = temp_dir("lockout-file");
    Vault::create(&dir, PIN, None).unwrap();

    let lock_path = app_lib::crypto::lockout_path(&dir);
    assert!(
        lock_path.exists(),
        "锁定期状态必须存在加密库之外，否则未解锁时无法读取"
    );

    // 该文件是明文可读的 —— 这是有意的，但意味着**提示信息也是明文**。
    // 所以界面上要提醒用户把提示写得模糊。
    let text = std::fs::read_to_string(&lock_path).unwrap();
    assert!(text.contains("initialized"), "实际内容: {text}");

    // 模拟连续失败：状态必须能被重新读出来（防重启绕过）。
    let mut st = LockoutState::load(&lock_path);
    for _ in 0..app_lib::crypto::MAX_FAILED_ATTEMPTS {
        st.record_failure(&lock_path).unwrap();
    }
    let reloaded = LockoutState::load(&lock_path);
    assert!(
        reloaded.remaining_lock_secs() > 0,
        "锁定状态必须持久化到文件，否则重启应用即可绕过锁定期"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn hint_is_stored_outside_encryption_for_the_lock_screen() {
    let dir = temp_dir("hint");
    Vault::create(&dir, PIN, Some("和你常用的数字有关".into())).unwrap();

    // 锁屏界面需要显示提示，而那时数据库还没解锁，所以提示必须能从
    // 加密库之外读到。
    let st = LockoutState::load(&app_lib::crypto::lockout_path(&dir));
    assert_eq!(st.hint.as_deref(), Some("和你常用的数字有关"));
    // 失败次数不足时不应显示。
    assert!(!st.should_show_hint());
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 备份保留策略（P0 缺口补齐）
// ---------------------------------------------------------------------------

/// 造一个符合命名规范的备份文件（含配对的 meta）。
fn fake_backup(dir: &std::path::Path, stamp: &str) -> String {
    let stem = format!("diary-{stamp}");
    std::fs::write(dir.join(format!("{stem}.db")), b"x").unwrap();
    std::fs::write(dir.join(format!("{stem}.meta.json")), b"{}").unwrap();
    stem
}

#[test]
fn prune_keeps_recent_backups_and_removes_old_ones() {
    let dir = temp_dir("prune-recent");
    std::fs::create_dir_all(&dir).unwrap();

    // 同一个月里造 10 份备份（每天一份）
    for day in 1..=10 {
        fake_backup(&dir, &format!("202609{day:02}-100000"));
    }

    let (deleted, kept) = app_lib::db::prune_backups(&dir, 7).unwrap();

    // 10 份里保留最近 7 份（09-10…09-04）；"每月最早一份"= 09-01，
    // 它**已经**在那 7 份之外，所以被按月归档规则额外保留 -> 共 8 份。
    // 删除 2 份 × 2 个文件（主文件 + 配对 meta）= 4 个文件。
    //
    // （我第一版把期望写成 kept=7 / deleted=6，是漏算了"本月最早那份本来
    //   就不在最近 7 份里"这一点。）
    assert_eq!(kept, 8, "应保留最近 7 份 + 本月归档 1 份");
    assert_eq!(deleted, 4, "应删除 2 份 × 2 个文件");

    assert!(
        dir.join("diary-20260901-100000.db").exists(),
        "本月最早一份应按月归档规则保留"
    );
    assert!(dir.join("diary-20260910-100000.db").exists(), "09-10 在最近 7 份内");
    assert!(dir.join("diary-20260904-100000.db").exists(), "09-04 是最近 7 份的最后一份");
    assert!(!dir.join("diary-20260903-100000.db").exists(), "09-03 应被删除");
    assert!(!dir.join("diary-20260902-100000.db").exists(), "09-02 应被删除");

    // meta 文件必须与被删的主文件一起清理，否则会留下孤立文件
    assert!(
        !dir.join("diary-20260903-100000.meta.json").exists(),
        "配对 meta 应一起删除"
    );
    assert!(
        dir.join("diary-20260901-100000.meta.json").exists(),
        "被保留的备份，其 meta 也必须保留（否则无法解锁）"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_keeps_one_archive_per_month() {
    let dir = temp_dir("prune-months");
    std::fs::create_dir_all(&dir).unwrap();

    // 三个月，每月两份；keep_recent 设为 2
    for (m, d) in [("202607", "01"), ("202607", "15"), ("202608", "01"),
                   ("202608", "15"), ("202609", "01"), ("202609", "15")] {
        fake_backup(&dir, &format!("{m}{d}-120000"));
    }

    let (_, kept) = app_lib::db::prune_backups(&dir, 2).unwrap();

    // 最近 2 份 = 09-15, 09-01
    // 每月最早一份 = 07-01, 08-01, 09-01
    // 合并去重 = {09-15, 09-01, 07-01, 08-01} = 4 份
    assert_eq!(kept, 4, "应保留最近 2 份 + 每月归档一份（去重后 4 份）");

    assert!(dir.join("diary-20260701-120000.db").exists(), "7 月归档应保留");
    assert!(dir.join("diary-20260801-120000.db").exists(), "8 月归档应保留");
    assert!(!dir.join("diary-20260715-120000.db").exists(), "7 月第二份应删除");
    assert!(!dir.join("diary-20260815-120000.db").exists(), "8 月第二份应删除");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn prune_leaves_foreign_files_alone() {
    let dir = temp_dir("prune-foreign");
    std::fs::create_dir_all(&dir).unwrap();

    // 这些不是本程序生成的命名，绝不能被删
    std::fs::write(dir.join("important.db"), b"user data").unwrap();
    std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
    std::fs::write(dir.join("diary-backup.db"), b"odd name").unwrap();
    fake_backup(&dir, "20260901-100000");

    let (_, _) = app_lib::db::prune_backups(&dir, 0).unwrap();

    assert!(dir.join("important.db").exists(), "不该碰用户自己的 .db 文件");
    assert!(dir.join("notes.txt").exists(), "不该碰非 .db 文件");
    assert!(dir.join("diary-backup.db").exists(), "命名不符规范的文件不该被删");
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 自动备份设置（P0 缺口补齐）
// ---------------------------------------------------------------------------

#[test]
fn auto_backup_defaults_to_enabled() {
    let dir = temp_dir("auto-default");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 默认必须是**开启**的：对日记软件来说"用户忘了开备份"等于"没有备份"，
    // 而丢日记不可挽回。
    assert!(vault.auto_backup_enabled().unwrap(), "自动备份应默认开启");
    assert_eq!(
        vault.keep_recent_backups().unwrap(),
        app_lib::db::DEFAULT_KEEP_RECENT
    );
    // 从未备份过 -> 距下次应为 0（即立刻就该备份）
    assert_eq!(vault.secs_until_next_auto_backup().unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn auto_backup_toggle_and_timer_persist() {
    let dir = temp_dir("auto-persist");
    {
        let vault = Vault::create(&dir, PIN, None).unwrap();
        vault.set_setting(app_lib::db::setting_keys::AUTO_BACKUP_ENABLED, "false").unwrap();
        vault
            .set_setting(app_lib::db::setting_keys::KEEP_RECENT, "3")
            .unwrap();
    }

    // 重新打开后设置必须还在（存在数据库里，不是内存状态）。
    let vault = Vault::unlock(&dir, PIN).unwrap();
    assert!(!vault.auto_backup_enabled().unwrap(), "关闭状态应持久化");
    assert_eq!(vault.keep_recent_backups().unwrap(), 3, "保留份数应持久化");

    // 模拟"24 小时前备份过" —— 距下次应接近 0（已到期）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    vault
        .set_setting(
            app_lib::db::setting_keys::LAST_BACKUP_AT,
            &(now - app_lib::db::AUTO_BACKUP_INTERVAL_SECS - 10).to_string(),
        )
        .unwrap();
    assert_eq!(
        vault.secs_until_next_auto_backup().unwrap(),
        0,
        "超过间隔即视为到期"
    );

    // 刚刚备份过 -> 距下次应接近完整间隔
    vault
        .set_setting(app_lib::db::setting_keys::LAST_BACKUP_AT, &now.to_string())
        .unwrap();
    let until = vault.secs_until_next_auto_backup().unwrap();
    assert!(
        until > app_lib::db::AUTO_BACKUP_INTERVAL_SECS - 60,
        "刚备份过，应接近完整间隔，实际 {until}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn run_backup_records_time_and_prunes() {
    let dir = temp_dir("run-backup");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    // 先造一批旧备份，验证 run_backup 会顺带清理
    for day in 1..=12 {
        fake_backup(&backups, &format!("202601{day:02}-100000"));
    }
    // 保留份数设为 3，方便观察清理
    vault
        .set_setting(app_lib::db::setting_keys::KEEP_RECENT, "3")
        .unwrap();

    assert_eq!(vault.last_backup_at().unwrap(), 0, "初始应无备份时间");

    let (result, deleted) = vault.run_backup(&backups, "20260911-120000").unwrap();

    assert!(result.bytes > 0, "备份产物不应为空");
    assert!(vault.last_backup_at().unwrap() > 0, "备份后必须记录时间");
    assert!(deleted > 0, "应清理了旧备份，实际删除 {deleted} 个文件");
    // 新备份本身必须保留
    assert!(backups.join("diary-20260911-120000.db").exists());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 锁定
//
// 锁定的定义只有一句：**内容一个字符都不改，只是不再允许修改和删除**。
// 这组测试存在的理由：右上角原来是"阅读"视图，用 Markdown 渲染，
// 会吃掉用户手动排的换行与空格。换掉之后必须钉住"排版原样保留"这条底线。
// ---------------------------------------------------------------------------

/// 用户手排的版：单换行、行首缩进、制表符、连续空格、行尾空格。
const HAND_LAYOUT: &str = "第一行\n第二行不空行\n\n  缩进两个空格\n\t制表符开头\n结尾三个空格   ";

#[test]
fn hand_made_layout_survives_lock_and_unlock_verbatim() {
    let dir = temp_dir("lock-layout");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault.save_entry("2026-09-11", "标题", HAND_LAYOUT).unwrap();

    // 锁定再解锁，来回一趟
    let locked = vault.set_entry_locked("2026-09-11", true).unwrap();
    assert!(locked.locked);
    assert_eq!(locked.content_md, HAND_LAYOUT, "锁定不得改动正文");

    let unlocked = vault.set_entry_locked("2026-09-11", false).unwrap();
    assert!(!unlocked.locked);
    assert_eq!(unlocked.content_md, HAND_LAYOUT, "解锁不得改动正文");

    // 落库的字节必须与写入时完全一致
    let read = vault.open_entry("2026-09-11").unwrap();
    assert_eq!(read.content_md, HAND_LAYOUT);
    assert_eq!(read.content_md.as_bytes(), HAND_LAYOUT.as_bytes());

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn locked_entry_rejects_save() {
    let dir = temp_dir("lock-no-save");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault.save_entry("2026-09-11", "标题", "原始内容").unwrap();
    vault.set_entry_locked("2026-09-11", true).unwrap();

    // 后端必须拒绝，而不是靠前端置灰。
    // 自动保存定时器、组件卸载时的 flush 都会绕过界面。
    let err = vault
        .save_entry("2026-09-11", "改过的标题", "改过的内容")
        .expect_err("锁定后写入必须被拒绝");
    assert!(
        matches!(err, AppError::Validation(_)),
        "应返回可展示的校验错误，实际: {err:?}"
    );

    // 内容必须原封不动
    let e = vault.open_entry("2026-09-11").unwrap();
    assert_eq!(e.title, "标题");
    assert_eq!(e.content_md, "原始内容");

    // 解锁后恢复可写
    vault.set_entry_locked("2026-09-11", false).unwrap();
    vault.save_entry("2026-09-11", "改过的标题", "改过的内容").unwrap();
    assert_eq!(
        vault.open_entry("2026-09-11").unwrap().title,
        "改过的标题"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn locked_entry_rejects_delete() {
    let dir = temp_dir("lock-no-delete");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    vault.save_entry("2026-09-11", "", "会被删掉的内容").unwrap();
    vault.set_entry_locked("2026-09-11", true).unwrap();

    // 只挡"改"不挡"删"是半个锁：整篇删掉同样不可恢复。
    let err = vault
        .delete_entry("2026-09-11")
        .expect_err("锁定后删除必须被拒绝");
    assert!(matches!(err, AppError::Validation(_)), "实际: {err:?}");

    // 内容还在，日历标记也还在
    assert!(vault.is_written("2026-09-11").unwrap());
    assert_eq!(
        vault.open_entry("2026-09-11").unwrap().content_md,
        "会被删掉的内容"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn lock_state_persists_across_reopen() {
    let dir = temp_dir("lock-persist");
    {
        let vault = Vault::create(&dir, PIN, None).unwrap();
        vault.save_entry("2026-09-11", "", "锁着的").unwrap();
        vault.save_entry("2026-09-12", "", "没锁的").unwrap();
        vault.set_entry_locked("2026-09-11", true).unwrap();
    }

    // 重新解锁整个库：每篇的锁定状态必须各自记住。
    let vault = Vault::unlock(&dir, PIN).unwrap();
    assert!(vault.open_entry("2026-09-11").unwrap().locked, "应记得锁过");
    assert!(
        !vault.open_entry("2026-09-12").unwrap().locked,
        "不该连累没锁的那篇"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn lock_all_entries_locks_everything() {
    let dir = temp_dir("lock-all");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    for day in 10..=13 {
        vault
            .save_entry(&format!("2026-09-{day}"), "", "内容")
            .unwrap();
    }
    vault.set_entry_locked("2026-09-11", true).unwrap();

    // 切换日期 / 重新打开软件时调用：一次全锁。
    let n = vault.lock_all_entries().unwrap();
    assert_eq!(n, 3, "4 篇里 1 篇本来就锁着，应只更新 3 篇");

    for day in 10..=13 {
        assert!(
            vault
                .open_entry(&format!("2026-09-{day}"))
                .unwrap()
                .locked,
            "2026-09-{day} 应已锁定"
        );
    }

    // 幂等：再调一次不再改任何行（避免每次切换日期都写库）
    assert_eq!(vault.lock_all_entries().unwrap(), 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn locking_a_date_never_written_creates_no_row() {
    let dir = temp_dir("lock-empty");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 点开过但没写的日期：锁它没有意义，
    // 更不该因为点了锁定就在日历上留下一条"写过"的记录。
    let e = vault.set_entry_locked("2026-09-11", true).unwrap();
    assert_eq!(e.id, 0, "不该创建数据库行");
    assert!(!e.locked);
    assert!(!vault.is_written("2026-09-11").unwrap());
    assert_eq!(vault.stats().unwrap().total_entries, 0);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn new_entry_defaults_to_unlocked() {
    let dir = temp_dir("lock-default");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    let e = vault.save_entry("2026-09-11", "", "新写的").unwrap();
    assert!(!e.locked, "新写的日记应该是可编辑的");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 空日记不该被锁定。
///
/// 回归测试：1.3 的 lock_all_entries 是 `WHERE locked = 0`，**没看内容**，
/// 把"有行、正文却是空的"旧草稿一起锁上了。症状是用户看到**空日记也显示已锁定**，
/// 而且那一天再也写不进第一个字。
#[test]
fn empty_draft_is_never_locked() {
    let dir = temp_dir("lock-empty-draft");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 只打了标题、正文没写：表里有行，但按 has_content 的规则不算"写过"。
    vault.save_entry("2026-09-11", "只打了标题", "").unwrap();

    // 全量锁定不能碰它
    assert_eq!(
        vault.lock_all_entries().unwrap(),
        0,
        "没有正文的草稿不该被锁定"
    );

    let e = vault.open_entry("2026-09-11").unwrap();
    assert!(e.id != 0, "这一行确实存在");
    assert!(!e.locked, "空日记不该显示为锁定");
    assert!(!vault.is_locked("2026-09-11").unwrap());

    // 关键：这一天必须还能写进第一个字
    vault
        .save_entry("2026-09-11", "只打了标题", "终于写了正文")
        .expect("空草稿必须可写");
    let e = vault.open_entry("2026-09-11").unwrap();
    assert_eq!(e.content_md, "终于写了正文");
    assert!(!e.locked);

    // 有了正文之后，全量锁定才应该生效
    assert_eq!(vault.lock_all_entries().unwrap(), 1);
    assert!(vault.is_locked("2026-09-11").unwrap());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 修改主密码（指令 3 · PRAGMA rekey）
// ---------------------------------------------------------------------------

/// 改成这个新密码。与 PIN 位数相同、内容不同，能验出"密钥真的变了"。
const NEW_PIN: &str = "246813";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// 把一份备份（连同它的 meta）还原成一个能独立解锁的数据目录。
///
/// 备份能否打开取决于**配对**的那份 `crypto_meta.json`（含 salt 与 KDF 参数），
/// 缺了它即使密码正确也派生不出密钥 —— 所以还原动作必须两个文件一起搬。
fn restore_backup(backup_db: &std::path::Path, meta_src: &std::path::Path, tag: &str) -> std::path::PathBuf {
    let dir = temp_dir(tag);
    std::fs::copy(backup_db, dir.join("diary.db")).expect("复制备份失败");
    std::fs::copy(meta_src, dir.join("crypto_meta.json")).expect("复制 meta 失败");
    dir
}

#[test]
fn change_password_rekeys_and_old_pin_stops_working() {
    let dir = temp_dir("chpw-ok");
    let old_backup = dir.join("老备份.db");
    {
        let vault = Vault::create(&dir, PIN, Some("旧提示".into())).unwrap();
        seed(&vault);
        // 改密码**之前**先留一份备份，后面用它验证"历史备份不受影响"。
        vault.backup_to(&old_backup).unwrap();

        let warnings =
            app_lib::commands::change_password_core(&dir, &vault, PIN, NEW_PIN, Some("新提示".into()))
                .expect("改密码应成功");
        assert!(warnings.is_empty(), "正常环境下不该有收尾警告: {warnings:?}");
    }

    // 新密码能开、旧密码作废 —— 这是"改密码"的定义。
    let vault = Vault::unlock(&dir, NEW_PIN).expect("新密码必须能解锁");
    let err = Vault::unlock(&dir, PIN).expect_err("旧密码必须失效");
    assert!(
        matches!(err, AppError::WrongPin),
        "旧密码应返回 WrongPin，实际: {err:?}"
    );

    // 数据不能有任何变化：正文、日历标记、搜索索引、统计全都要原样。
    assert_eq!(vault.stats().unwrap().total_entries, 4);
    assert_eq!(vault.list_month("2026-09").unwrap().len(), 4);
    assert_eq!(vault.written_dates("2026-09-01", "2026-09-30").unwrap().len(), 4);
    assert_eq!(vault.search("火锅", 10).unwrap().len(), 1, "搜索索引必须原样");
    assert_eq!(
        vault.open_entry("2026-09-12").unwrap().content_md,
        "今天去爬山，看到了很美的日落，山顶风很大。"
    );

    // ① 改密码前做的备份：仍用**旧**密码打开 —— rekey 只重新加密主库，
    //    历史备份文件一个字节都没被碰过。这也是界面上必须写明
    //    "此前的备份仍需用旧密码打开"的原因。
    let r1 = restore_backup(&old_backup, &dir.join("crypto_meta.json"), "chpw-restore-old");
    Vault::unlock(&r1, PIN).expect("改密码前做的备份必须仍能用旧密码打开");
    assert!(Vault::unlock(&r1, NEW_PIN).is_err(), "旧备份不该被新密码打开");

    // ② 改密码**随手做**的那份新备份：必须已经对齐到新密码。
    //    否则用户手里的备份全是旧密码的，而他很可能会忘掉那个旧密码。
    let fresh: Vec<_> = std::fs::read_dir(dir.join("backups"))
        .expect("改密码后应顺手做一次备份")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("db"))
        .collect();
    assert_eq!(fresh.len(), 1, "应恰好有一份随改密码产生的新备份");
    let r2 = restore_backup(&fresh[0], &dir.join("crypto_meta.json"), "chpw-restore-new");
    Vault::unlock(&r2, NEW_PIN).expect("改密码后的备份应能用新密码打开");
    assert!(Vault::unlock(&r2, PIN).is_err(), "新备份不该还能用旧密码打开");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&r1);
    let _ = std::fs::remove_dir_all(&r2);
}

#[test]
fn change_password_with_wrong_old_pin_leaves_the_vault_untouched() {
    let dir = temp_dir("chpw-badold");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    let err = app_lib::commands::change_password_core(&dir, &vault, "999999", NEW_PIN, None)
        .expect_err("旧密码不对必须失败");
    assert!(matches!(err, AppError::WrongPin), "实际: {err:?}");

    // 关键断言：库没被改坏 —— 旧密码照用，新密码进不来。
    // 这一条防的是"验证旧密码时把连接或密钥弄脏"的写法。
    drop(vault);
    let v = Vault::unlock(&dir, PIN).expect("失败的改密码不该动到库");
    assert_eq!(v.stats().unwrap().total_entries, 4);
    assert!(Vault::unlock(&dir, NEW_PIN).is_err());

    // 失败必须计数。否则"改密码"就是一个能无限次试旧密码的后门。
    let st = LockoutState::load(&app_lib::crypto::lockout_path(&dir));
    assert_eq!(st.failed_attempts, 1, "改密码失败必须计入失败次数");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn change_password_rejects_invalid_new_pin_without_touching_anything() {
    let dir = temp_dir("chpw-badnew");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    seed(&vault);

    // 太短。
    let e = app_lib::commands::change_password_core(&dir, &vault, PIN, "12345", None)
        .expect_err("新密码太短必须拒绝");
    assert!(matches!(e, AppError::InvalidPin(_)), "实际: {e:?}");

    // 含字母。
    let e = app_lib::commands::change_password_core(&dir, &vault, PIN, "abcdef", None)
        .expect_err("新密码含字母必须拒绝");
    assert!(matches!(e, AppError::InvalidPin(_)), "实际: {e:?}");

    // 格式非法属于"还没开始改"，不该消耗尝试次数 —— 它和"猜密码"是两回事。
    let st = LockoutState::load(&app_lib::crypto::lockout_path(&dir));
    assert_eq!(st.failed_attempts, 0, "格式非法不该计入失败次数");

    drop(vault);
    let v = Vault::unlock(&dir, PIN).expect("旧密码必须仍然有效");
    assert_eq!(v.stats().unwrap().total_entries, 4);

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn change_password_updates_the_hint_and_survives_the_attempt_reset() {
    let dir = temp_dir("chpw-hint");
    let vault = Vault::create(&dir, PIN, Some("生日".into())).unwrap();
    let lock_path = app_lib::crypto::lockout_path(&dir);
    assert_eq!(LockoutState::load(&lock_path).hint.as_deref(), Some("生日"));

    app_lib::commands::change_password_core(
        &dir,
        &vault,
        PIN,
        NEW_PIN,
        Some("  和门牌号有关  ".into()),
    )
    .unwrap();

    // 提示语必须跟着换：旧提示是照着旧密码写的，留着会直接把用户带沟里。
    // 顺带验证首尾空白被清掉（清洗规则与初始化共用一份）。
    let st = LockoutState::load(&lock_path);
    assert_eq!(st.hint.as_deref(), Some("和门牌号有关"));
    assert_eq!(st.failed_attempts, 0, "成功后失败计数必须清零");

    // 留空 = 明确不要提示，不能把旧提示留着。
    app_lib::commands::change_password_core(&dir, &vault, NEW_PIN, PIN, None).unwrap();
    assert_eq!(LockoutState::load(&lock_path).hint, None, "留空应清掉旧提示");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 免密钥匙文件（指令 4 的文件）在改密码时的两种行为。
///
/// 指令 4 尚未实施，所以真实数据目录里没有这个文件 —— 但**两种行为现在就得定死**：
///   · 文件不存在 → 什么都不做（绝不能替用户创建，那等于替他开了免密）
///   · 文件存在   → 必须同步成新密钥（否则用户重启后免密失效，而他刚做的是改密码）
#[test]
fn change_password_only_syncs_an_existing_auto_login_file() {
    let dir = temp_dir("chpw-autologin");
    let vault = Vault::create(&dir, PIN, None).unwrap();
    let auto_path = app_lib::crypto::auto_login_path(&dir);

    // ① 不存在 → 不创建。
    app_lib::commands::change_password_core(&dir, &vault, PIN, NEW_PIN, None).unwrap();
    assert!(!auto_path.exists(), "免密未开启时不得创建钥匙文件");

    // ② 存在 → 同步，且不能冲掉文件里的其它字段。
    let mut key = app_lib::db::derive_and_verify(&dir, NEW_PIN).unwrap();
    let key_before = hex(&key);
    app_lib::crypto::zeroize(&mut key);
    std::fs::write(
        &auto_path,
        format!("{{\"key_hex\":\"{key_before}\",\"enabled\":true}}"),
    )
    .unwrap();

    const NEWEST_PIN: &str = "112233";
    app_lib::commands::change_password_core(&dir, &vault, NEW_PIN, NEWEST_PIN, None).unwrap();

    let doc: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&auto_path).unwrap()).unwrap();
    let mut key = app_lib::db::derive_and_verify(&dir, NEWEST_PIN).unwrap();
    let key_after = hex(&key);
    app_lib::crypto::zeroize(&mut key);

    assert_eq!(
        doc["key_hex"],
        serde_json::Value::String(key_after),
        "钥匙文件必须同步成新密钥，否则重启后免密失效"
    );
    assert_eq!(
        doc["enabled"],
        serde_json::Value::Bool(true),
        "同步只该改 key_hex，文件里其它字段不能被冲掉"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 改密码必须计入锁定期 —— 否则它就是一条免费爆破旧密码的通道。
///
/// 这是本指令最容易被漏掉的一条：`change_password` 里有一次"验证旧密码"，
/// 如果只验证不计数，攻击者（或捡到电脑的人）就能挂着一个脚本慢慢试 ——
/// 每次约 0.8 秒，6 位数字 100 万种，一夜跑完。
#[test]
fn change_password_counts_attempts_and_locks_out() {
    let dir = temp_dir("chpw-lockout");
    let vault = Vault::create(&dir, PIN, None).unwrap();

    // 前 4 次：只是密码错。
    // ⚠️ 上界用常量而不是写死 4：`1..MAX` 是**开区间**，正好试够 MAX-1 次，
    //    与 crypto.rs 里那条锁定测试同一写法。写死数字的话，
    //    将来调 MAX_FAILED_ATTEMPTS 时这条测试会以一个看不懂的方式挂掉。
    for i in 1..app_lib::crypto::MAX_FAILED_ATTEMPTS {
        let e = app_lib::commands::change_password_core(&dir, &vault, "999999", NEW_PIN, None)
            .expect_err("错误旧密码必须失败");
        assert!(matches!(e, AppError::WrongPin), "第 {i} 次实际: {e:?}");
    }

    // 第 5 次（= MAX_FAILED_ATTEMPTS）：触发锁定。
    let e = app_lib::commands::change_password_core(&dir, &vault, "999999", NEW_PIN, None)
        .expect_err("第 5 次必须触发锁定");
    assert!(matches!(e, AppError::Locked { .. }), "实际: {e:?}");

    // 锁定期间**即使旧密码正确也必须被拒**。否则改密码就成了绕过锁定期的后门：
    // 主界面已经进不去了，却还能靠这个命令反复试。
    let e = app_lib::commands::change_password_core(&dir, &vault, PIN, NEW_PIN, None)
        .expect_err("锁定期内必须直接拒绝");
    assert!(matches!(e, AppError::Locked { .. }), "实际: {e:?}");

    // 密码自始至终没被改动。
    drop(vault);
    Vault::unlock(&dir, PIN).expect("锁定期内不该有任何密码被改掉");

    let _ = std::fs::remove_dir_all(&dir);
}

/// 改密码之后，把**整个数据目录复制一份搬走**，也必须能用新密码读全。
///
/// 为什么要单测这一条：`PRAGMA rekey` 跑在 WAL 模式下，而 WAL 文件里可能
/// 还留着**旧密钥加密的页**。万一它们没被一起重新加密、之后又被 checkpoint
/// 折回主库，用户的日记就会变成"一半新钥匙、一半旧钥匙" —— 谁也打不开。
/// 那属于不可逆丢数据，不能只凭"改完那一下还能打开"来推定。
///
/// 顺带这也是用户的真实操作：换电脑、备份，都是直接复制 data 目录。
#[test]
fn rekey_leaves_no_old_key_pages_behind() {
    let dir = temp_dir("chpw-copy");
    {
        let vault = Vault::create(&dir, PIN, None).unwrap();
        seed(&vault);
        app_lib::commands::change_password_core(&dir, &vault, PIN, NEW_PIN, None).unwrap();
    }

    // 整个目录照搬：diary.db 连同可能存在的 -wal / -shm 一起，
    // 等于用户直接把 data 目录复制走。
    let copy = temp_dir("chpw-copy-dest");
    for entry in std::fs::read_dir(&dir).unwrap() {
        let p = entry.unwrap().path();
        if p.is_file() {
            std::fs::copy(&p, copy.join(p.file_name().unwrap())).unwrap();
        }
    }

    let v = Vault::unlock(&copy, NEW_PIN).expect("整目录搬走后必须能用新密码读全");
    assert_eq!(v.stats().unwrap().total_entries, 4);
    assert_eq!(v.search("火锅", 10).unwrap().len(), 1);
    assert!(Vault::unlock(&copy, PIN).is_err(), "搬出来的库里不该还有旧密钥能解开的页");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&copy);
}

