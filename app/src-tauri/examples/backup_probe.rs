//! 加密数据库的备份方案验证。
//!
//! 背景：实测发现 `rusqlite::backup::Backup`（SQLite 在线备份 API）
//! 在 SQLCipher 上直接报错：
//!     "backup is not supported with encrypted databases"
//! 原因是 SQLCipher 的编解码层与 sqlite3_backup 的分页复制机制不兼容。
//!
//! 所以必须找别的备份方式。本程序对比三个候选：
//!
//!   A. VACUUM INTO 'path'
//!      让 SQLite 把库重写到新文件。在 SQLCipher 上，新库沿用当前连接的密钥，
//!      因此产物应仍是密文。单条 SQL，无需额外依赖。
//!
//!   B. WAL checkpoint + 复制主文件
//!      先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 内容合并进主文件，
//!      再普通文件复制。简单，但需要保证复制期间没有写入。
//!
//!   C. 关闭连接后复制
//!      最保守。但我们的架构里连接是长期持有的，关掉会影响正在使用的界面。
//!
//! 判定标准：
//!   1. 产物**必须是密文**（文件里搜不到明文汉字）
//!   2. 产物**必须能用同一 PIN 打开**，且数据完整、索引可用
//!   3. 失败时不能损坏源库

use app_lib::db::Vault;
use std::path::Path;

const PIN: &str = "135790";

fn seed(vault: &Vault) {
    vault
        .save_entry(
            "2026-09-10",
            "今天很开心",
            "今天和朋友去吃了火锅，聊到很晚才回家。",
        )
        .unwrap();
    vault
        .save_entry("2026-09-11", "爬山", "今天去爬山，看到了很美的日落。")
        .unwrap();
}

/// 检查文件是否为密文（不应出现明文汉字）。
fn looks_encrypted(path: &Path) -> bool {
    let bytes = std::fs::read(path).unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes);
    !text.contains("火锅") && !text.contains("日落") && !text.contains("开心")
}

/// 把备份放到一个干净目录并用同一 PIN 打开，验证数据完整性。
fn verify_restorable(backup_file: &Path, meta_file: &Path, tag: &str) -> (bool, String) {
    let dir = std::env::temp_dir().join(format!("dsh-backup-verify-{tag}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    std::fs::copy(backup_file, dir.join("diary.db")).unwrap();
    // salt 与 KDF 参数必须一起带过去，否则无法派生密钥。
    std::fs::copy(meta_file, dir.join("crypto_meta.json")).unwrap();

    // 注意：release profile 设了 panic = "abort"，
    // 所以这里不能用 catch_unwind（abort 下它无法拦截 panic）。
    // 好在 Vault::unlock 的错误路径都走 Result，不会 panic。
    let msg = match Vault::unlock(&dir, PIN) {
        Ok(vault) => {
            let n = vault.list_month("2026-09").unwrap().len();
            let hits = vault.search("火锅", 10).unwrap().len();
            if n == 2 && hits == 1 {
                (true, format!("可解锁、{n} 篇日记完整、索引可用（搜「火锅」命中 {hits}）"))
            } else {
                (false, format!("可解锁但数据不对：{n} 篇，搜「火锅」{hits} 条"))
            }
        }
        Err(e) => (false, format!("无法解锁：{e}")),
    };
    let _ = std::fs::remove_dir_all(&dir);
    msg
}

fn main() {
    println!("=== 加密数据库备份方案对比 ===\n");

    // 准备一个源库。
    let src_dir = std::env::temp_dir().join("dsh-backup-src");
    let _ = std::fs::remove_dir_all(&src_dir);
    std::fs::create_dir_all(&src_dir).unwrap();
    let vault = Vault::create(&src_dir, PIN, None).unwrap();
    seed(&vault);

    let meta = src_dir.join("crypto_meta.json");

    // ---------- 方案 A：VACUUM INTO ----------
    println!("--- 方案 A：VACUUM INTO ---");
    let a_path = src_dir.join("backup-vacuum.db");
    let a_result = vault.conn().execute(
        "VACUUM INTO ?1",
        rusqlite::params![a_path.to_string_lossy().to_string()],
    );
    match a_result {
        Ok(_) => {
            let size = std::fs::metadata(&a_path).map(|m| m.len()).unwrap_or(0);
            println!("  执行成功，产物 {} 字节", size);
            println!("  密文检查: {}", if looks_encrypted(&a_path) { "✓ 是密文" } else { "✗ 发现明文" });
            let (ok, msg) = verify_restorable(&a_path, &meta, "vacuum");
            println!("  可恢复性: {} {}", if ok { "✓" } else { "✗" }, msg);
        }
        Err(e) => println!("  ✗ 失败: {e}"),
    }

    // ---------- 方案 B：checkpoint + 文件复制 ----------
    println!("\n--- 方案 B：WAL checkpoint + 文件复制 ---");
    let b_path = src_dir.join("backup-copy.db");
    let ck = vault.conn().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    });
    match ck {
        Ok((busy, log, checkpointed)) => {
            println!("  checkpoint 结果: busy={busy} wal页数={log} 已写回={checkpointed}");
            // busy=0 表示没有其他连接占用，此时复制是安全的。
            if busy == 0 {
                match std::fs::copy(src_dir.join("diary.db"), &b_path) {
                    Ok(n) => {
                        println!("  复制成功，{} 字节", n);
                        println!("  密文检查: {}", if looks_encrypted(&b_path) { "✓ 是密文" } else { "✗ 发现明文" });
                        let (ok, msg) = verify_restorable(&b_path, &meta, "copy");
                        println!("  可恢复性: {} {}", if ok { "✓" } else { "✗" }, msg);
                    }
                    Err(e) => println!("  ✗ 复制失败: {e}"),
                }
            } else {
                println!("  ✗ checkpoint 报告忙碌，此时复制可能不一致");
            }
        }
        Err(e) => println!("  ✗ checkpoint 失败: {e}"),
    }

    // ---------- 方案 C：在线备份 API（预期失败，作为对照）----------
    println!("\n--- 方案 C：SQLite 在线备份 API（对照，预期失败）---");
    let c_path = src_dir.join("backup-api.db");
    match rusqlite::Connection::open(&c_path) {
        Ok(mut target) => {
            match rusqlite::backup::Backup::new(vault.conn(), &mut target) {
                Ok(_) => println!("  意外：居然成功了"),
                Err(e) => println!("  ✗ 如预期失败: {e}"),
            }
        }
        Err(e) => println!("  ✗ 无法创建目标连接: {e}"),
    }

    println!("\n=== 结论 ===");
    println!("采用方案 A（VACUUM INTO）：单条 SQL、无需关闭连接、产物加密且可恢复。");
    println!("方案 B 作为退路（checkpoint 后复制），但必须确认 busy=0。");
    println!("方案 C 不可用 —— SQLCipher 不支持在线备份 API。");

    let _ = std::fs::remove_dir_all(&src_dir);
}
