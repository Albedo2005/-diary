# 项目结构说明与约定

## 一、完整目录结构

```
D:\Users\Lenovo\Desktop\Diary\
├── Cargo.toml                  Cargo workspace 根
├── Cargo.lock                  依赖锁定（workspace 共用）
├── README.md                   决策记录与文档索引
│
├── docs/                       设计与调研文档
│   ├── feature-plan.md         功能清单 + 难度分级 + 可行性评估
│   ├── probe-findings.md       技术验证报告（含踩坑与方法论教训）
│   ├── schema-decisions.md     表结构定案（每条附实测证据）
│   ├── sqlcipher-notes.md      SQLCipher 施工要点
│   └── project-structure.md    本文件
│
├── scripts/                    环境与验证脚本（纯 ASCII，见下文约定）
│   ├── env.ps1                 构建环境设置
│   ├── install-profile.ps1     把环境装进 PowerShell profile
│   ├── check-env.ps1           诊断当前会话的工具可见性
│   ├── check-persisted-env.ps1 读注册表看真实的永久配置
│   ├── probe-tools.ps1         报告各工具的实际路径
│   ├── e2e-check.ps1           全新终端端到端验证
│   └── migrate-to-d.ps1        C 盘→D 盘迁移（已完成，保留备查）
│
├── target/                     workspace 共用的构建产物（约 800 MB）
│
├── probe/                      Rust 技术验证原型（使命已完成，保留作参考）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs             阶段一+二：基础能力 + 中文搜索方案对比
│       └── bin/
│           ├── schema.rs           阶段三：FTS 表结构
│           ├── trigger_diag.rs     阶段三：触发器诊断（定位 unicode61 的坑）
│           ├── schema_final.rs     阶段三：seg 列方案
│           ├── robust.rs           阶段四：contentless_delete + 双索引
│           └── kdf.rs              KDF 参数校准
│
└── app/                        正式应用（待创建）
    ├── package.json            Vue 3 + Vite
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    ├── src/                    Vue 前端
    │   ├── main.ts
    │   ├── App.vue
    │   ├── views/              日历主界面 / 编辑器 / 解锁页 / 设置页
    │   ├── components/         日历、编辑器、搜索结果等组件
    │   ├── api/                Tauri command 的类型安全封装
    │   └── styles/
    └── src-tauri/              Rust 后端（加入 workspace members）
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── capabilities/
        └── src/
            ├── main.rs         Tauri 入口
            ├── commands.rs     暴露给前端的接口
            ├── db/             数据库层
            │   ├── mod.rs      连接管理、迁移
            │   ├── crypto.rs   密码派生、密钥管理、锁定
            │   ├── schema.rs   建表 SQL
            │   ├── entry.rs    日记 CRUD
            │   ├── search.rs   双索引中文搜索
            │   └── backup.rs   在线备份
            └── seg.rs          jieba 分词封装
```

## 二、为什么用 Cargo workspace

### 理由：避免重复编译重型 C 依赖

SQLCipher + OpenSSL 从源码静态编译，**一次约 12 分钟、产物约 800 MB**。

如果不建 workspace，`probe/` 和 `app/src-tauri/` 会各自维护独立的 `target/`，
把这两个 C 依赖**编译两遍** —— 白白多花 12 分钟和 800 MB 磁盘。

workspace 让所有成员共享同一个 `target/`，每个依赖只编译一次。

### 代价（必须提前知道）

Cargo 的构建缓存与 workspace 布局绑定。**任何改动 workspace 结构的操作都会使缓存失效**：

| 操作 | 后果 |
|---|---|
| 新增/移动 workspace 成员 | 全部依赖重编（约 12 分钟） |
| 改动 `CARGO_TARGET_DIR` | 全部依赖重编 |
| 移动 `CARGO_HOME` | 全部依赖重编（源码路径变了，指纹失效） |
| 改动 `rusqlite` 的 feature flags | 重编 SQLCipher + OpenSSL |

这些都是一次性代价，但每次都会浪费十几分钟，所以**不要频繁调整 workspace 布局**。

### 依赖版本收敛在 workspace 根

`rusqlite` 的 feature flags（`bundled-sqlcipher-vendored-openssl`）写在
`Cargo.toml` 的 `[workspace.dependencies]` 里，成员用 `rusqlite.workspace = true` 引用。

**理由**：防止 `probe` 和正式应用用了不同的 SQLCipher 配置。那种不一致会造成
"验证原型能跑，正式应用却报错"的诡异问题，而且极难排查。

### 成员显式列出，不用通配

```toml
members = ["probe"]          # 以后追加 "app/src-tauri"
```

**不用 `app/*` 这类通配**：那会把 `app/src-tauri` 也当作一个包处理，是错误的。
显式列出还能让拼写错误立刻报错，而不是被静默忽略。

## 三、前端与后端的边界（安全约定）

**前端永远不直接接触数据库，也永远拿不到密钥。**

```
Vue 组件
   ↓ 调用 api/ 里的类型安全封装
Tauri command（Rust）
   ↓ 你的业务逻辑
db/ 模块（rusqlite + SQLCipher）
```

三条必须守住的规则：

1. **密钥只在 Rust 侧派生与使用**，绝不下发前端。前端只传用户输入的密码字符串。
2. **前端不拼 SQL**。所有查询都是预定义的 command，参数化传参。
   这既防注入，也保证前端无法绕过加密直接读文件。
3. **不用 Tauri 官方 SQL 插件**。它把 SQL 字符串从前后端传递，
   与"密钥必须留在 Rust 侧"的设计目标冲突，且不支持 SQLCipher。

## 四、数据库层为什么拆成多个文件

`crypto.rs` 和 `search.rs` 是**两个高风险且逻辑独立**的模块：

- `crypto.rs`：密码派生、密钥生命周期、锁定策略。**出错会导致数据永久打不开。**
- `search.rs`：双索引维护与查询合并。**出错会导致日记搜不到。**

它们各自需要独立的测试与故障演练。混在一个大文件里，会让人不敢改动 ——
而"不敢改"正是数据层最危险的状态。

## 五、代码与脚本约定

### `.ps1` 脚本一律写成纯 ASCII

**原因**：Windows PowerShell 5.1 会把**无 BOM 的 UTF-8** 文件按 ANSI/GBK 解析。
中文字符会变成乱码（如 `鈿?`），进而破坏引号配对，导致语法错误。

我在这上面踩过一次：脚本本身逻辑正确，却报 `The string is missing the terminator`。

两个选择：
- 写成纯 ASCII（本项目采用，最省事、最不容易出错）
- 或保存为 **UTF-8 with BOM**

### 注释里记录"为什么"，不只是"做什么"

尤其是这几类决定，必须写清楚理由，否则未来一定会有人（包括你自己）
把它"优化"掉，然后踩坑：

- 为什么用 `contentless_delete=1` 而不是外部内容表
- 为什么建两张 FTS 索引
- 为什么不用触发器同步索引
- 为什么 `PRAGMA key` 必须是连接后第一条语句
- 为什么 KDF 参数不能硬编码
- 为什么附件只存相对路径

以上每一条都在 `docs/schema-decisions.md` 和 `docs/sqlcipher-notes.md` 里有实测依据。

### 不要把 `CARGO_TARGET_DIR` 改来改去

只要与上次构建用的值不同，就会触发全量重编（约 12 分钟）。
项目在 D 盘，产物天然就在 D 盘的 `target/`，不需要设置这个变量。

## 六、开发命令速查

```powershell
# 环境：已通过 PowerShell profile 自动配置，通常无需手动操作
# 若某工具找不到，手动补一次：
. D:\Users\Lenovo\Desktop\Diary\scripts\env.ps1

# 验证结论可复现（在 probe 目录）
cd D:\Users\Lenovo\Desktop\Diary\probe
cargo run --release --bin robust     # 双索引 + contentless_delete
cargo run --release --bin kdf        # KDF 参数校准
cargo run --release --bin trigger_diag   # 复现 unicode61 分词坑

# 全新终端端到端检查
powershell -File D:\Users\Lenovo\Desktop\Diary\scripts\e2e-check.ps1

# 环境诊断
powershell -NoProfile -File D:\Users\Lenovo\Desktop\Diary\scripts\check-persisted-env.ps1
```

## 七、当前状态

| 阶段 | 状态 |
|---|---|
| 环境搭建 | ✅ 完成（Rust + Perl 工具链在 D 盘，profile 自动加载） |
| 技术验证原型 | ✅ 完成（SQLCipher / FTS5 / 中文分词 / KDF 全部实测定案） |
| 需求与范围 | ✅ 已敲定（P0 十项，见 `feature-plan.md`） |
| workspace 结构 | ✅ 已验证（构建 11 分 10 秒，二进制运行正常，缓存共享生效） |
| 项目雏形 | ⬜ 待开始（创建 `app/`） |

## 八、workspace 迁移的实测结果

迁移后完整构建耗时 **11 分 10 秒**，二进制运行正常，双索引行为与迁移前一致：

```
「火锅」 词索引=["2026-09-10"]   字索引=["2026-09-10"]
「牛肉」 词索引=无                字索引=["2026-09-13"]   ← 兜底索引生效
```

**删除的冗余**：迁移使 `probe/target/`（828 MB）失效，已删除。
现在只有 `target/` 一份构建产物，由所有成员共享。

**关于 stderr 的噪音**：链接 OpenSSL 时会产生约 800 行
`LNK4099: 未找到 PDB` 警告，这是**无害的** —— OpenSSL 的预编译对象不含调试符号。
`scripts/build.ps1` 会自动过滤它们，只报告真实错误。

⚠️ **一个容易误判的现象**：cargo 把编译进度（`Compiling xxx`）写到 **stderr**。
所以"stderr 有输出"不等于"构建失败"，必须看**退出码**。
本次迁移中我两次误判，都是因为这个。

