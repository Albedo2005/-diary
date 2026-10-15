# 日记 · 本地加密日记本（桌面端）

一款 Windows 单机加密日记应用。所有日记明文只存在本机，数据库经 SQLCipher 加密，无云端依赖。

## 技术栈
- **Tauri 2**（Rust 后端）＋ **Vue 3**（前端）
- **SQLCipher**：AES-256 加密数据库，主密钥经 KDF 派生
- **three.js**：自研 3D「生命树」可视化（算法生成枝干，按月份/心情映射花叶）

## 已实现
富文本编辑器（HTML 正文）、本地加密存储、自动保存、多格式导出、心情/字数统计等 20+ 功能。

## 架构要点
- 前端仅经单一 API 出口调用 Rust 命令，SQL 全部收敛于数据访问层
- 跨层职责清晰：api → commands → db → schema 分层登记，新增命令需同步四处

## 构建
Tauri 2 ＋ pnpm ＋ cargo，详见仓库源码与 `docs/`。



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
  data/                         **日记数据（不进 git）**
    diary.db                    加密数据库
    crypto_meta.json            salt 与 KDF 参数（明文，但不可泄漏）
    lockout.json                密码错误次数与锁定状态（明文）
    backups/                    自动备份（密文，按保留策略清理）
  发布/                          交付物：可执行文件、安装包、使用说明
  生产/                         ⭐ 全部要长期留存的东西（见 生产/README.md）
    生产日志.md                  全项目唯一的真相来源（按版本号检索）
    Diary-*.md                  规划与指令文档（P1 / P2 / P3 / 代码精读）
    交付证据/                    各版验收脚本 ＋ 结果日志 ＋ 界面截图
  probe/                        Rust 技术验证原型（已验证完毕，保留作证据）
  app/                          正式应用
    src/                        Vue 前端
      api/index.ts              与 Rust 的类型安全封装（唯一数据入口）
      components/               解锁页、日历、编辑器、搜索
      utils/date.ts             日期工具（全部按本地时区）
      styles/global.css         主题变量与 Markdown 阅读样式
    src-tauri/                  Rust 后端
      src/lib.rs                应用入口与 command 注册
      src/commands.rs           前端唯一能调用的接口 + 后台自动备份线程
      src/db.rs                 数据层：CRUD、双索引搜索、备份、保留策略
      src/crypto.rs             加密与密码策略（风险最高，改动前先读注释）
      src/schema.rs             建表 SQL（每条设计决定都写了理由）
      src/seg.rs                中文分词
      src/error.rs              前端可消费的错误类型
```



