//! 【事项4 · 数据规模】造大量日记，量列表 / 搜索 / 统计到底卡不卡。
//!
//! 默认 `#[ignore]` —— 要跑几十秒，不该混进常规全量。
//!
//! ```text
//! cargo test -p app -j 1 --test scale -- --ignored --nocapture
//! ```
//! 规模可用 `DSH_SCALE_N` 覆盖（默认见 `DEFAULT_N`）：
//! ```text
//! DSH_SCALE_N=3650 cargo test -p app -j 1 --test scale -- --ignored --nocapture
//! ```
//!
//! ⚠️ 只在一次性临时库里造数据，绝不碰用户真实库。

use app_lib::db::Vault;
use rusqlite::params;
use std::path::PathBuf;
use std::time::Instant;

const PIN: &str = "135790";

/// 默认规模 **2 万篇**。
///
/// ⚠️ 为什么不是 10 万：表上是 `UNIQUE(entry_date)` —— **一天最多一篇**，
///    10 万篇意味着一天不落地写满 **297 年**，人类做不到。
///    2 万篇已经 ≈ **55 年**天天不断，是"这辈子真写得出来"的天花板量级。
///    10 万那一组实测数字跑过、留档在交付证据里，性质是**灾难线**，不是需求。
const DEFAULT_N: usize = 20_000;

/// 硬上限（毫秒）。定得很宽 —— 它拦的是"病态退化"（比如某次改动把索引查询
/// 变成全表扫描、或者写出 O(N²)），不负责判定"快不快"。
/// **快不快由打印出来的数字说话**，见 `rating()`。
const CATASTROPHE_MS: f64 = 30_000.0;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dsh-diary-scale-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建测试目录失败");
    dir
}

/// 生成 `n` 个互不相同的合法日期，并且**让最后一年落在 2026**。
///
/// ⚠️ 表上有 `UNIQUE(entry_date)` —— **一天最多一篇**，所以 N 篇就是 N 个不同的日子：
///    3,650 篇 ≈ 10 年、2 万篇 ≈ 55 年、10 万篇 ≈ 297 年（每月按 28 天算）。
///    看懂这一点，"10 万篇"这个数字的性质就清楚了：它是**物理天花板**，
///    不是用户会遇到的场景 —— 所以默认规模定在 2 万。
fn dates(n: usize) -> Vec<String> {
    const PER_YEAR: usize = 336; // 12 月 × 28 天
    let years_needed = (n + PER_YEAR - 1) / PER_YEAR;
    let start_year = 2027u32.saturating_sub(years_needed as u32);

    let mut out = Vec::with_capacity(n);
    'outer: for y in start_year..=2026u32 {
        for m in 1..=12u32 {
            for d in 1..=28u32 {
                out.push(format!("{y:04}-{m:02}-{d:02}"));
                if out.len() == n {
                    break 'outer;
                }
            }
        }
    }
    assert_eq!(out.len(), n, "日期生成不够 {n} 个（起点 {start_year}）");
    out
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

/// 人话评级 —— 界面卡不卡，比"多少毫秒"更直观。
fn rating(v: f64) -> &'static str {
    if v <= 100.0 {
        "无感"
    } else if v <= 300.0 {
        "轻快"
    } else if v <= 1000.0 {
        "可察觉"
    } else {
        "卡"
    }
}

#[test]
#[ignore = "要几十秒；手动跑：cargo test -p app -j 1 --test scale -- --ignored --nocapture"]
fn entries_scale() {
    let n: usize = std::env::var("DSH_SCALE_N")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_N);

    let dir = temp_dir(&format!("{n}"));
    let vault = Vault::create(&dir, PIN, None).expect("建库失败");

    let all_dates = dates(n);
    // 取数据**中段**的日期/月份做探针：那一块必然是填满的。
    let mid_date = all_dates[n / 2].clone();
    let probe_month = mid_date[..7].to_string();
    let probe_year = mid_date[..4].to_string();
    let today = all_dates[n - 1].clone();

    println!("=== 规模 {n} 篇（一天一篇 ⇒ 约 {} 年）===", n / 336);

    // ---- 灌数据 ----
    // 刻意**绕过 save_entry**：它每篇一个事务 + jieba 分词，大规模下会跑到天荒地老。
    // 这里单事务批量插，随后一次性 `rebuild_indexes()` 把索引补齐 ——
    // 那样测出来的搜索才是"真在 N 篇里搜"，而不是"索引是空的所以很快"。
    let t = Instant::now();
    {
        let tx = vault.conn().unchecked_transaction().expect("开事务失败");
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO entry
                       (notebook_id, entry_date, title, content_md, word_count, mood, locked, created_at, updated_at)
                     VALUES (1, ?1, ?2, ?3, ?4, NULL, 0, ?5, ?5)",
                )
                .expect("准备插入语句失败");
            for (i, date) in all_dates.iter().enumerate() {
                let title = format!("第 {i} 篇");
                let body = format!("第 {i} 篇：今天去了公园散步，心情不错，晚上读了一会儿书。");
                stmt.execute(params![
                    date,
                    title,
                    body,
                    body.chars().count() as i64,
                    format!("{date}T20:00:00Z")
                ])
                .expect("插入失败");
            }
        }
        tx.commit().expect("提交失败");
    }
    println!("① 灌数据            {:.1}ms（一次性）", ms(t));

    let t = Instant::now();
    let indexed = vault.rebuild_indexes().expect("重建索引失败");
    println!("② 重建索引          {:.1}ms（一次性）", ms(t));
    // 前提：别让"搜得很快"变成"索引压根是空的"这种假绿。
    assert_eq!(indexed, n, "索引里的篇数不等于 {n} —— 那测的就不是 {n} 篇");

    // ---- ③ 列表：看某一个月 ----
    let t = Instant::now();
    let list = vault.list_month(&probe_month).expect("list_month 失败");
    let list_ms = ms(t);
    println!("③ 列表一个月        {list_ms:8.1}ms  [{}] {} 条", rating(list_ms), list.len());
    // 每月 28 天全填满 ⇒ 必须正好 28 条。这是"前提真的造出来了"的硬证据。
    assert_eq!(list.len(), 28, "{probe_month} 应有 28 条，实际 {}", list.len());

    // 执行计划：10 万篇下"快不快"取决于走不走索引，只报耗时说不清退化的位置。
    {
        let sql = format!(
            "EXPLAIN QUERY PLAN
             SELECT entry_date, title, word_count, mood, updated_at
             FROM entry
             WHERE entry_date LIKE ?1 AND {}
             ORDER BY entry_date ASC",
            app_lib::db::has_content_sql()
        );
        let mut stmt = vault.conn().prepare(&sql).expect("准备 EXPLAIN 失败");
        let plan: Vec<String> = stmt
            .query_map(params![format!("{probe_month}-%")], |r| r.get::<_, String>(3))
            .expect("跑 EXPLAIN 失败")
            .collect::<Result<_, _>>()
            .expect("取执行计划失败");
        for line in &plan {
            println!("      ↳ 计划: {line}");
        }
    }

    // ---- ④ 搜索 ----
    let t = Instant::now();
    let hits = vault.search("公园", 50).expect("search 失败");
    let search_ms = ms(t);
    println!("④ 搜索「公园」      {search_ms:8.1}ms  [{}] 命中 {} 条", rating(search_ms), hits.len());
    assert!(!hits.is_empty(), "搜「公园」一条都没命中 —— 前提没造出来");

    // ---- ⑤ 统计（统计页那一下）----
    let t = Instant::now();
    let st = vault.stats(&today).expect("stats 失败");
    let stats_ms = ms(t);
    println!(
        "⑤ 统计页            {stats_ms:8.1}ms  [{}] {} 篇 / {} 字",
        rating(stats_ms),
        st.total_entries,
        st.total_words
    );
    assert_eq!(st.total_entries, n as i64, "统计篇数不等于 {n}");

    // ---- ⑥ 日历：找一整年的"写过"标记 ----
    let t = Instant::now();
    let days = vault
        .written_dates(&format!("{probe_year}-01-01"), &format!("{probe_year}-12-31"))
        .expect("written_dates 失败");
    let cal_ms = ms(t);
    println!("⑥ 日历一整年        {cal_ms:8.1}ms  [{}] {} 天", rating(cal_ms), days.len());

    // ---- ⑦ 筛选：最新 200 条 ----
    let t = Instant::now();
    let f = vault
        .filter_entries(&[], &[], None, None, true, Some(200))
        .expect("filter_entries 失败");
    let filter_ms = ms(t);
    println!(
        "⑦ 筛选最新 200 条   {filter_ms:8.1}ms  [{}] 共 {} 篇、返回 {} 条",
        rating(filter_ms),
        f.total,
        f.hits.len()
    );
    assert_eq!(f.total, n as i64, "筛选总数不等于 {n}");

    // ---- ⑧ 索引体检 ----
    let t = Instant::now();
    let report = vault.integrity_check().expect("integrity_check 失败");
    let check_ms = ms(t);
    println!("⑧ 索引体检          {check_ms:8.1}ms  [{}] 健康 = {}", rating(check_ms), report.is_healthy());
    assert!(report.is_healthy(), "索引对不上：{report:?}");

    // ---- 汇总 ----
    let mut ops = vec![
        ("列表", list_ms),
        ("搜索", search_ms),
        ("统计", stats_ms),
        ("日历", cal_ms),
        ("筛选", filter_ms),
        ("体检", check_ms),
    ];
    ops.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    println!(
        "→ 最慢：{} {:.1}ms；超过 1 秒的有 {} 项",
        ops[0].0,
        ops[0].1,
        ops.iter().filter(|(_, v)| *v > 1000.0).count()
    );

    for (name, v) in &ops {
        assert!(
            *v <= CATASTROPHE_MS,
            "{name} 花了 {v:.1}ms，超过灾难线 {CATASTROPHE_MS}ms —— 这是病态退化，不是正常的慢"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}
