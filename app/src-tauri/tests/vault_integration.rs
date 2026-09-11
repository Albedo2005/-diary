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
