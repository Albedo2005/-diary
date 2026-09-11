//! KDF 参数校准：在本机实测 Argon2id 耗时，选出最合适的参数。
//!
//! 目标区间：单次派生 500~1000 ms。
//!   太快 = 离线爆破成本低；太慢 = 用户每次解锁都要干等。
//!
//! 重要设计约束（由此测试确认）：
//!   KDF 参数必须持久化进数据库，解锁时按**存储的参数**派生。
//!   绝不能硬编码 —— 否则以后调整参数会导致老用户无法解锁自己的日记。

use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use std::time::Instant;

fn bench(m_cost_kib: u32, t_cost: u32, p_cost: u32) -> u128 {
    let params = Params::new(m_cost_kib, t_cost, p_cost, Some(32)).unwrap();
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let mut key = [0u8; 32];

    // 预热一次（避免首次的页分配开销影响测量）
    argon.hash_password_into(b"135790", &salt, &mut key).unwrap();

    // 取 3 次的中位数
    let mut times = Vec::new();
    for _ in 0..3 {
        let t = Instant::now();
        argon.hash_password_into(b"135790", &salt, &mut key).unwrap();
        times.push(t.elapsed().as_millis());
    }
    times.sort();
    key.fill(0);
    times[1]
}

fn main() {
    println!("=== Argon2id 参数校准（本机实测）===\n");
    println!("{:<34} {:>10} {}", "参数 (m_cost / t_cost / p_cost)", "耗时", "评价");
    println!("{}", "-".repeat(74));

    let cases = [
        (65_536, 3, 1),   // 64 MB
        (131_072, 3, 1),  // 128 MB
        (262_144, 3, 1),  // 256 MB
        (524_288, 3, 1),  // 512 MB
        (1_048_576, 3, 1),// 1 GB
        (524_288, 2, 1),  // 512 MB / 2 轮
    ];

    let mut best = None;
    for (m, t, p) in cases {
        let ms = bench(m, t, p);
        let mib = m / 1024;
        let verdict = if ms < 200 {
            "偏快，爆破成本低"
        } else if ms < 500 {
            "可接受，略快"
        } else if ms <= 1000 {
            "★ 理想区间"
        } else if ms <= 2000 {
            "偏慢但可用"
        } else {
            "过慢，用户会不耐烦"
        };
        println!("{:<34} {:>7} ms  {}", format!("{mib} MiB / {t} / {p}"), ms, verdict);

        if (500..=1000).contains(&ms) && best.is_none() {
            best = Some((mib, t, p, ms));
        }
    }

    println!();
    match best {
        Some((mib, t, p, ms)) => {
            println!("推荐参数: m_cost = {mib} MiB, t_cost = {t}, p_cost = {p}  (实测 {ms} ms)");
            println!();
            println!("权衡说明：");
            println!("  - m_cost 越高，离线爆破每个候选的代价越大（攻击者需并行占内存）");
            println!("  - 但高 m_cost 对低配机器（如 4GB 内存的老笔记本）可能造成分配失败");
            println!("  - 建议：安装时做一次自适应校准 —— 从 64 MiB 起逐步加倍并计时，");
            println!("          直到耗时进入 500~1000 ms 或触及上限（如 512 MiB），");
            println!("          然后把最终参数写入数据库。这样同一份程序在高低配机器上都合适。");
        }
        None => println!("没有参数落入 500~1000 ms 理想区间，需要重新选取候选值"),
    }

    println!();
    println!("安全提醒（必须写进代码注释和文档）：");
    println!("  1. 用 6 位数字密码时，密钥空间只有 100 万。Argon2id 的高内存开销");
    println!("     是唯一的防线，参数不能为了启动速度而调低。");
    println!("  2. salt 至少 16 字节随机，与 KDF 参数一起持久化（明文即可，salt 不是秘密）。");
    println!("  3. 派生完成后立即清零内存中的密钥材料。");
    println!("  4. 参数必须随库存储并在解锁时读取，不能硬编码。");
}
