# 日记软件（工作名：待定）

Windows 单机日记应用。**所有数据只存在本机，正文数据库加密。**

当前阶段：**技术验证已完成，进入需求讨论与项目雏形设计**。

## 一句话结论

技术层面已无拦路虎。中文全文搜索这个唯一的高风险点已实测定案；
剩下的是需求取舍与实现工作。

## 技术栈（已定）

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面框架 | Tauri 2 | 轻量，前端复用 Vue，Rust 侧直连数据库 |
| 前端 | Vue 3 + TypeScript + Vite | |
| 数据库 | SQLite + SQLCipher（rusqlite 静态编译） | 整库加密，密钥只在 Rust 侧，永不下发前端 |
| 全文搜索 | FTS5 + jieba 分词，双索引（词索引 + 单字兜底） | 已实测定案，见 `docs/schema-decisions.md` |
| 密钥派生 | Argon2id，512 MiB / 3 轮（本机实测 792 ms） | 参数随库持久化，不硬编码 |
| 附件 | 明文文件，存应用数据目录 | 用户已确认接受此取舍 |

## 文档索引

| 文档 | 内容 |
|---|---|
| `docs/feature-plan.md` | **功能清单 + 难度分级 + 可执行概率评估**（需求讨论主文档） |
| `docs/project-structure.md` | **项目结构与代码约定**（含 workspace 设计理由） |
| `docs/p0-progress.md` | **P0 实现进度与验证清单** |
| `docs/backlog.md` | **后续版本功能储备**（V1 所见即所得编辑器、V2 多日记本） |
| `docs/probe-findings.md` | 技术验证完整报告（含踩坑记录与方法论教训） |
| `docs/schema-decisions.md` | 表结构定案，每条结论附实测证据 |
| `docs/sqlcipher-notes.md` | SQLCipher 集成施工要点 |

## 已定的产品决策

- **数据模型**：一天一篇，`entry_date` 唯一约束在数据库层保证；日历为主界面。
- **密码**：6 位数字（最小长度可配置）；连续 5 次错误后锁定 10 分钟；第 2 次错误后显示提示。
- **锁定期状态**：持久化到数据库之外的文件，否则重启应用即可绕过。
- **提示信息**：存在加密库之外（锁屏时需显示），因此明文可读 —— 内容须写得模糊。
- **附件**：不加密。风险已知并接受：图片常比正文更敏感，且可能被云同步带走。
- **备份**：属于 P0，优先级高于一切附加功能。

## 不做的事

- 不做网页版。
- 不做前后端分离（单机应用不需要独立服务进程）。
- 不自己写加密算法。
- 不存绝对路径。
- 不在数据库里存第二份密码校验值（SQLCipher 自己会验证密钥）。
- 不用 Tauri 官方 SQL 插件（不支持 SQLCipher，且会把密钥暴露给前端）。

## 目录结构

```
diary/
  Cargo.toml                    Cargo workspace 根（共享构建产物）
  Cargo.lock                    依赖锁定（应用项目，需提交）
  README.md                     本文件：决策记录与索引
  docs/                         设计文档（见上方索引）
  scripts/                      环境与验证脚本（纯 ASCII）
    env.ps1                     构建环境设置
    install-profile.ps1         装进 PowerShell profile（自动加载）
    build.ps1                   probe 构建（过滤 LNK4099 噪音）
    app-build.ps1               应用构建 / 检查 / 测试 / 开发模式
    e2e-check.ps1               全新终端端到端验证
    check-persisted-env.ps1     读注册表看真实永久配置
    migrate-to-d.ps1            C 盘→D 盘迁移（已完成，备查）
  target/                       workspace 共用的构建产物
  probe/                        Rust 技术验证原型（已验证完毕，保留作证据）
  app/                          正式应用
    src/                        Vue 前端
      api/index.ts              与 Rust 的类型安全封装（唯一数据入口）
      components/               解锁页、日历、编辑器、搜索
      utils/date.ts             日期工具（全部按本地时区）
      styles/global.css         主题变量与 Markdown 阅读样式
    src-tauri/                  Rust 后端
      src/lib.rs                应用入口与 command 注册
      src/commands.rs           前端唯一能调用的接口
      src/db.rs                 数据层：CRUD、双索引搜索、备份
      src/crypto.rs             加密与密码策略（风险最高，改动前先读注释）
      src/schema.rs             建表 SQL（每条设计决定都写了理由）
      src/seg.rs                中文分词
      src/error.rs              前端可消费的错误类型
```

## 开发命令

```powershell
# 检查 Rust 侧（快，日常用）
powershell -File D:\Users\Lenovo\Desktop\Diary\scripts\app-build.ps1 -Task check

# 跑 Rust 单元测试
powershell -File D:\Users\Lenovo\Desktop\Diary\scripts\app-build.ps1 -Task test

# 打开应用窗口（开发模式，Ctrl+C 停止）
powershell -File D:\Users\Lenovo\Desktop\Diary\scripts\app-build.ps1 -Task dev

# 前端类型检查
cd D:\Users\Lenovo\Desktop\Diary\app ; node_modules\.bin\vue-tsc.cmd --noEmit
```

## 开发环境

工具链已搭建完成并**已迁移到 D 盘**（C 盘累计释放约 16 GB）。

### 环境是自动加载的，不需手动配置

通过 **PowerShell profile** 实现：新开 PowerShell 窗口即可直接用 `cargo` / `perl` / `nasm` / `gmake`。

为什么用 profile 而不是全局 PATH：Strawberry Perl 的 `c\bin` 里还有它自带的
MinGW gcc 13.2.0，加进全局 PATH 会**静默改变你机器上现有 gcc 项目的编译行为**。
profile 方案把影响限制在 PowerShell 会话内，且可一键卸载。

```powershell
# 卸载（如果不需要了）
powershell -ExecutionPolicy Bypass -File D:\Users\Lenovo\Desktop\Diary\scripts\install-profile.ps1 -Uninstall

# 兜底：某工具找不到时，手动补一次（仅当前窗口有效）
. D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1

# 诊断：查看真实的永久配置（读注册表，不受当前会话影响）
powershell -NoProfile -File D:\Users\Lenovo\Desktop\Diary\scripts\check-persisted-env.ps1
```

| 组件 | 版本 | 位置 |
|---|---|---|
| Rust | 1.98.1 | `D:\rust\rustup` + `D:\rust\cargo` |
| MSVC | 14.37.32822 | `E:\Visual Studio\IDE`（本机原有） |
| Strawberry Perl | 5.42.3 便携版 | `D:\toolchains\perl` |
| nasm / gmake | 2.16.01 / 4.4.1（Perl 自带） | 同上 `c\bin` |
| Node.js / pnpm | v22.22.2 / 12.3.4 | 本机原有 |
| WebView2 | 152.0.4191.66 | 本机原有 |

⚠️ 项目里的 `.ps1` 脚本一律写成**纯 ASCII**：Windows PowerShell 5.1 会把无 BOM 的
UTF-8 文件按 GBK 解析，中文注释会导致语法错误。

⚠️ **cargo 把编译进度写到 stderr**，所以"stderr 有输出"不等于失败，必须看**退出码**。
链接 OpenSSL 时约 800 行 `LNK4099` PDB 警告是无害的。

## 复现验证

```powershell
# 端到端检查（全新终端构建 + 运行）
powershell -File D:\Users\Lenovo\Desktop\Diary\scripts\e2e-check.ps1

# 或单独跑某个验证程序
cd D:\Users\Lenovo\Desktop\Diary
cargo run --release --bin robust        # 双索引 + contentless_delete
cargo run --release --bin kdf           # KDF 参数校准
cargo run --release --bin trigger_diag  # 复现 unicode61 分词坑
```

首次编译 SQLCipher + OpenSSL 约需 12 分钟，之后增量编译秒级。

## 下一步

需求讨论：确认 `docs/feature-plan.md` 中待定的 4 项决策
（编辑器形态、备份策略、首版范围、是否多日记本），然后搭建项目雏形。
