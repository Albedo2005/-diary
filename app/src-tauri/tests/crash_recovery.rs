//! 【事项3 · 崩溃恢复】写到一半强杀进程，重开后数据必须完整。
//!
//! 两条路子，互补：
//!
//! 1. **真强杀**（`kill_mid_write_then_reopen_is_consistent`）——
//!    起一个子进程不停往同一篇日记写 2 MB 正文，父进程确认它已经提交了 ≥3 轮后
//!    用 `Child::kill()` 打死（Windows 上是 `TerminateProcess`，进程没有任何收尾机会），
//!    再重新打开：已提交的一个字不能少，也没冒出半条。
//!
//! 2. **确定性复现 WAL 里的"未提交帧"**（`torn_wal_recovers_to_last_commit`）——
//!    开一个事务、写一大段正文、**不提交**，趁事务还开着把「库 ＋ WAL」整份抄走；
//!    这份拷贝正是"进程正好死在这一刻"留在盘上的样子。重开副本后，
//!    未提交的那条必须消失、已提交的那条必须原样在。
//!
//! 为什么需要 2：第 1 条杀在哪一瞬是概率性的（多半落在"两次提交之间"），
//! 而"事务开着的时候整个进程没了"是它盖不住的那一档。

use app_lib::db::Vault;
use rusqlite::params;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const PIN: &str = "135790";
/// 子进程绝不碰的那一篇 —— 它是"别人的数据有没有被殃及"的对照组。
const SAFE_DATE: &str = "2026-09-11";
/// 子进程反复重写的那一篇。
const BUSY_DATE: &str = "2026-09-12";
/// 正文大小：单轮 300 KB。
///
/// ⚠️ 为什么不是"越大越好"：`save_entry` 上限是 **2,000,000 字节**（`db.rs` 的
///    `MAX_CONTENT`），超了会直接被拒。300 KB 已经足够把写入窗口拉到"强杀很可能
///    正好落进去"的量级，同时每轮又不至于慢到让测试没法跑。
const BODY_LEN: usize = 300_000;
const CHILD_ENV: &str = "DSH_CRASH_CHILD_DIR";

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dsh-diary-crash-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建测试目录失败");
    dir
}

/// 第 `round` 轮的正文。前 8 位是轮次号 ——
/// 重开后靠它判断"读到的到底是不是一个**写完的**版本"。
fn body(round: u64) -> String {
    format!("{round:08}{}", "x".repeat(BODY_LEN))
}

// ---------------------------------------------------------------------------
// 子进程入口
// ---------------------------------------------------------------------------

/// 子进程专用：不停往 `BUSY_DATE` 写 2 MB 正文，直到被父进程强杀。
///
/// ⚠️ `#[ignore]` 不是"暂时不跑"，是**必须**：单独跑它就是一个死循环。
///    父测试用 `--ignored --exact crash_child_writer` 把它精确拉起来。
#[test]
#[ignore = "子进程专用入口，由 kill_mid_write_then_reopen_is_consistent 启动"]
fn crash_child_writer() {
    let dir = std::env::var(CHILD_ENV).expect("这是子进程专用入口，请由父测试启动");
    let vault = Vault::unlock(Path::new(&dir), PIN).expect("子进程解锁失败");
    let mut round = 0u64;
    loop {
        vault
            .save_entry(BUSY_DATE, "写到一半", &body(round))
            .expect("子进程写入失败");
        // 这行 stdout 是父进程的"它真的写进去了"信号。
        println!("WROTE {round}");
        let _ = std::io::stdout().flush();
        round += 1;
    }
}

// ---------------------------------------------------------------------------
// 1. 真强杀
// ---------------------------------------------------------------------------

#[test]
fn kill_mid_write_then_reopen_is_consistent() {
    let dir = temp_dir("kill");
    {
        let v = Vault::create(&dir, PIN, None).expect("建库失败");
        v.save_entry(SAFE_DATE, "基线", "这一篇一个字都不能动")
            .expect("写基线失败");
    }

    let exe = std::env::current_exe().expect("拿不到测试程序自身路径");
    let mut child = Command::new(&exe)
        .args(["--ignored", "--exact", "crash_child_writer", "--nocapture"])
        .env(CHILD_ENV, &dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("起子进程失败");

    // 等它真的提交了 ≥3 轮 —— 用它的 stdout 当信号，⛔ 不靠 sleep 猜。
    // （这就是铁律 18：断言「某动作后某量 > 0」之前，必须先确认那个量真的被造出来了。）
    let stdout = child.stdout.take().expect("拿不到子进程 stdout");
    let mut reader = BufReader::new(stdout);
    let mut wrote = 0u32;
    let deadline = Instant::now() + Duration::from_secs(120);
    while wrote < 3 && Instant::now() < deadline {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                if line.contains("WROTE") {
                    wrote += 1;
                }
            }
            Err(_) => break,
        }
    }
    assert!(
        wrote >= 3,
        "子进程没能提交 ≥3 轮（实际 {wrote}）—— 测试的前提没造出来，结果不算数"
    );

    // ⚡ 强杀。Windows 上是 TerminateProcess：不给它任何收尾机会。
    child.kill().expect("强杀子进程失败");
    let _ = child.wait();
    drop(reader);

    // ---- 重开 ----
    let vault = Vault::unlock(&dir, PIN).expect("强杀之后必须还能解锁");

    // ① SQLite 层面没坏
    let db_level: String = vault
        .conn()
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .expect("PRAGMA integrity_check 跑不动");
    assert_eq!(db_level, "ok", "SQLite 完整性检查没过：{db_level}");

    // ② 索引与正文仍然对得上（不能出现"日记在、搜不到"）
    let report = vault.integrity_check().expect("索引完整性检查应能跑");
    assert!(report.is_healthy(), "索引对不上：{report:?}");

    // ③ 对照组：没被碰过的那一篇一个字不能变
    let safe = vault.open_entry(SAFE_DATE).expect("读基线失败");
    assert_eq!(safe.content_md, "这一篇一个字都不能动", "没被碰过的日记被殃及了");

    // ④ 主角：强杀前明明提交了 ≥3 轮 ⇒ 必须读得到，且是**完整的**某一轮
    let busy = vault.open_entry(BUSY_DATE).expect("读写到一半的那篇失败");
    assert!(
        !busy.content_md.is_empty(),
        "强杀前已确认提交 ≥3 轮，重开后却什么都读不到 —— 提交过的数据丢了"
    );
    assert_eq!(
        busy.content_md.len(),
        BODY_LEN + 8,
        "读到的不是完整一轮（长度 {} ≠ {}）—— 出现半条",
        busy.content_md.len(),
        BODY_LEN + 8
    );
    let round: u64 = busy.content_md[..8]
        .parse()
        .expect("前 8 位不是完整轮次号 —— 内容是残缺的");
    println!("强杀后重开：拿到完整第 {round} 轮，{} 字符", busy.content_md.len());

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// 2. 确定性复现：事务开着的时候进程没了
// ---------------------------------------------------------------------------

#[test]
fn torn_wal_recovers_to_last_commit() {
    let src = temp_dir("torn-src");
    let vault = Vault::create(&src, PIN, None).expect("建库失败");
    vault
        .save_entry(SAFE_DATE, "基线", "已提交的那一篇")
        .expect("写基线失败");

    // 开一个事务，写一大段**不提交**的正文。
    let conn = vault.conn();
    let wal_path = src.join("diary.db-wal");
    let wal_before = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

    // ⭐ 这一步是整个复现的关键：把这条连接的页缓存压到 128 KB。
    //    默认缓存够大，300 KB 的插入会**全部留在内存里**、直到提交才落 WAL ——
    //    实测过：那样 `-wal` 一个字节都不涨，这份"崩溃现场"里根本没有未提交帧。
    //    压小之后页缓存必然溢出，SQLite 只能把脏页提前写进 `-wal`，
    //    于是盘上就真的出现了"没有提交记录的帧" —— 那才是崩溃现场。
    conn.pragma_update(None, "cache_size", -128)
        .expect("压小页缓存失败");

    let tx = conn.unchecked_transaction().expect("开事务失败");
    let big = "z".repeat(BODY_LEN);
    tx.execute(
        "INSERT INTO entry (notebook_id, entry_date, title, content_md, word_count, locked, created_at, updated_at)
         VALUES (1, ?1, '没提交', ?2, 0, 0, '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z')",
        params![BUSY_DATE, big],
    )
    .expect("事务内插入失败");

    let wal_after = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

    // ⚠️ 前提必须真的造出来（铁律 18）：**未提交**的那一大坨必须已经落到 `-wal` 上。
    //    否则这份"崩溃现场"里根本没有未提交帧，下面那句"幽灵不见了"就是空话。
    assert!(
        wal_after > wal_before,
        "未提交的帧没有落到 WAL 上（{wal_before} → {wal_after} 字节）—— 这个复现手法不成立，别当通过"
    );

    // 趁事务还开着，把整个数据目录抄走 —— 这份拷贝就是"进程正好死在这一刻"留在盘上的样子。
    // ⛔ `-shm` 故意不抄：崩溃时它本来就是废的，SQLite 会自己从 WAL 重建。
    // ⚠️ `crypto_meta.json` 必须一起抄：`Vault::unlock` 要靠它把 PIN 派生成密钥，
    //    少了它报的是"缺少加密元信息，无法解锁"，跟崩溃恢复半点关系没有。
    let dst = temp_dir("torn-dst");
    for entry in std::fs::read_dir(&src).expect("列目录失败") {
        let entry = entry.expect("读目录项失败");
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with("-shm") || name == "backups" {
            continue;
        }
        let from = entry.path();
        if from.is_file() {
            std::fs::copy(&from, dst.join(&name))
                .unwrap_or_else(|e| panic!("抄 {name} 失败: {e}"));
        }
    }

    // 这边收摊（不提交，让它回滚），再去开副本。
    drop(tx);
    drop(vault);

    let reopened = Vault::unlock(&dst, PIN).expect("崩溃现场的副本必须能打开");

    let db_level: String = reopened
        .conn()
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(db_level, "ok", "崩溃现场的副本完整性检查没过：{db_level}");

    let safe = reopened.open_entry(SAFE_DATE).expect("读基线失败");
    assert_eq!(safe.content_md, "已提交的那一篇", "已提交的数据没恢复出来");

    let ghost = reopened.open_entry(BUSY_DATE).expect("读幽灵篇失败");
    assert!(
        ghost.content_md.is_empty(),
        "没提交的事务居然活下来了 —— 长度 {}",
        ghost.content_md.len()
    );

    println!(
        "崩溃现场重开：已提交 1 篇完好，未提交的那条按预期消失（WAL {} → {} 字节）",
        wal_before, wal_after
    );

    let _ = std::fs::remove_dir_all(&src);
    let _ = std::fs::remove_dir_all(&dst);
}
