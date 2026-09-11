# P0 实现进度

对照 `feature-plan.md` 的 P0 十项，逐项记录实际状态。

图例：✅ 已完成 · 🔶 已写代码待验证 · ⬜ 未开始

| # | 功能 | 状态 | 位置 | 说明 |
|---|---|---|---|---|
| 1 | 项目脚手架 | 🔶 | `app/` | Tauri 2.11 + Vue 3.5 + Vite 8 + TS 6；前端类型检查与生产构建均通过 |
| 2 | 数据库层 | 🔶 | `app/src-tauri/src/db.rs`、`schema.rs`、`seg.rs` | 建表、加密连接、双索引写入事务、搜索、备份、一致性自检 |
| 3 | 密码设置与解锁 | 🔶 | `crypto.rs`、`commands.rs` | Argon2id 512 MiB；KDF 参数随库持久化；salt 在加密库之外 |
| 4 | 密码锁定 | 🔶 | `crypto.rs` 的 `LockoutState` | 5 次 / 10 分钟 / 第 2 次起显示提示；状态持久化在加密库外 |
| 5 | Markdown 编辑器 | 🔶 | `components/EditorPane.vue` | 形态 A（源码 + 自动保存）+ 阅读模式；IME 组字期间暂停保存 |
| 6 | 一天一篇 + 自动保存 | 🔶 | `db.rs`、`EditorPane.vue` | 唯一约束在数据库层；输入停止 1 秒落库 |
| 7 | 日历主界面 | 🔶 | `components/CalendarPanel.vue` | 月视图、写过标记、今天高亮、周一起排 |
| 8 | 中文全文搜索 | 🔶 | `db.rs::search`、`components/SearchPanel.vue` | 词索引 + 单字兜底索引合并；摘要取自原文 |
| 9 | 自动备份 | 🔶 | `db.rs::backup_to` | SQLite 在线备份 API（WAL 下裸复制文件不安全）；备份是密文 |
| 10 | 阅读模式 | 🔶 | `EditorPane.vue` + `styles/global.css` | 一键切换；Markdown 渲染 + 基础 XSS 过滤 |

**"代码写完"与"验证通过"是两件事**，所以现在统一标 🔶。验证清单见下节。

## 关键实现决定（与文档定案一致）

| 决定 | 实现位置 | 理由 |
|---|---|---|
| 密钥只在 Rust 侧，永不下发前端 | `commands.rs` 全部 command | 前端只传 PIN 字符串；无任何"执行任意 SQL"的接口 |
| 不用 Tauri 官方 SQL 插件 | `Cargo.toml` 注释 | 它把 SQL 字符串从前后端传递，与密钥隔离冲突，且不支持 SQLCipher |
| KDF 参数随库持久化 | `crypto.rs::CryptoMeta` | 硬编码会导致"密码对却打不开" |
| 不存第二份密码校验值 | `db.rs::open_with_key` | SQLCipher 自己验证密钥（实测报 hmac check failed） |
| `PRAGMA key` 是连接后第一条语句 | `db.rs::open_with_key` | 否则 SQLite 先以明文处理文件头，加密不生效 |
| FTS 用 contentless + `contentless_delete=1` | `schema.rs` | 免疫文本漂移导致的索引损坏；删除只需 rowid |
| 双索引（词 + 单字） | `db.rs` 写入与 `search` | 实测搜「牛肉」只能靠单字索引命中「牛肉面」 |
| 索引同步不用触发器 | `db.rs::save_entry` | 触发器无法调用 jieba；且传统 delete 命令对文本一致性极敏感 |
| 正文与索引在同一事务 | `db.rs::save_entry` | 分开写会产生"搜得到打不开"或"存了搜不到" |
| 附件只存相对路径 | `schema.rs` | 绝对路径换电脑即失效 |
| 唯一约束在数据库层 | `schema.rs` 的 `UNIQUE(entry_date)` | 应用层"先查再插"在异常路径下会产生同日两条 |
| 预留 `notebook_id` | `schema.rs` | 为 V2 多日记本留迁移路径（见 backlog.md） |
| 正文永远存 Markdown 原文 | `schema.rs` 注释 | V1 升级所见即所得的前提（见 backlog.md） |

## 已写的 Rust 单元测试

| 测试 | 验证的内容 |
|---|---|
| `same_pin_and_salt_derive_same_key` | 相同输入必须得到相同密钥，否则用户无法解锁 |
| `different_pin_derives_different_key` | 不同 PIN 必须得到不同密钥 |
| `different_salt_derives_different_key` | salt 不同则密钥不同，否则预计算攻击可行 |
| `lockout_triggers_after_max_attempts` | 第 5 次失败触发锁定，**且状态可被重新读出**（防重启绕过） |
| `hint_only_after_two_failures` | 提示的显示时机 |
| `crypto_meta_roundtrip_preserves_params` | KDF 参数原样还原（防"密码对却打不开"） |
| `pin_validation_enforces_digits_and_length` | PIN 格式校验 |
| `words_are_split_and_space_joined` | 分词结果必须含空格，否则单字/词索引都会失效 |
| `word_search_term_survives_segmentation` | 查询词必须出现在索引分词结果里 |
| `chars_drops_whitespace_and_separates` | 单字索引的分隔正确性 |
| `date_validation_rejects_bad_formats` | 日期格式校验 |
| `previous_date_handles_month_and_year_boundaries` | 连续天数统计的跨月/跨年/闰年 |
| `word_count_counts_chinese_characters` | 中文按字符计数（不是按空格） |
| `has_content_matches_sql_semantics` | SQL 与 Rust 两侧的"写过"判定一致（含制表符/换行） |
| `snippet_has_no_leading_ellipsis_near_start` | 命中靠近开头时不应加前省略号 |
| `snippet_has_leading_ellipsis_when_match_is_far_in` | 命中在中间时应加前后省略号 |
| `snippet_has_no_trailing_ellipsis_when_window_reaches_end` | 窗口到结尾时不应加后省略号 |
| `snippet_falls_back_when_term_absent` | 兜底索引命中但原文无该词时不 panic |

## 已修复的用户报告 bug：打开某天 ≠ 写过某天

**现象**：点一下日历（比如 9 月 9 日）什么都没写，日历就显示这天写过日记。

**根因**（两个问题叠加）：
1. 打开日期的操作会**无条件往数据库插入一条空记录**（原 `get_or_create_entry`）
2. 日历标记只看"表里有没有行"，不看"有没有内容"

**修复**：定下一条唯一的真相规则，并把所有判定收敛到它。

```rust
// db.rs —— 全应用语义的单一事实来源
pub fn has_content_sql() -> String    // SQL 侧：trim 掉各类空白后非空
pub fn has_content(content_md: &str)  // Rust 侧：与之语义一致
```

规则：**`content_md` 去掉各类空白后仍非空，才算"写过"**。

| 位置 | 修复前 | 修复后 |
|---|---|---|
| `open_entry` | 不存在就插一条空记录 | **纯读取**，返回 id = 0 的空模板 |
| `written_dates` / `list_month` / `stats` | 只看有没有行 | 加 `has_content_sql()` 过滤 |
| `save_entry` 的索引收录 | 一律收录 | 只有有内容的才收录 |
| `integrity_check` / `rebuild_indexes` | 覆盖所有行 | 只覆盖有内容的行 |
| 前端 `EditorPane` | 无条件保存 | 无内容不落库；**内容被删空时删除整行** |

**顺带发现并修复的 SQLite 陷阱**：`trim()` 默认**只去半角空格**，不去制表符和换行
（与 SQL Server 的 `TRIM` 不同）。所以"只敲了回车和缩进"会被误判成写过日记。
已用显式字符集修正，并有专门测试覆盖。

**新增 8 条回归测试**专门钉住这个行为，见集成测试里的
"回归测试：打开某天 ≠ 写过某天" 一节。

## 事故记录：源文件编码被破坏（已恢复）

修复上述 bug 时，我用 **PowerShell 文本替换**改源文件注释，PowerShell 5.1
把 UTF-8 文件按 ANSI/GBK 解码，导致 4 个文件的中文注释全部变成 mojibake，
且部分换行被吞掉。变换不可逆（信息已丢失），只能重写注释。

**代码本身未受影响**（标识符都是 ASCII），且设计意图都记录在 `docs/` 里，
所以注释得以完整重建。

**防护措施**：
- 新增 `.editorconfig` 声明 UTF-8
- 新增 `docs/encoding-policy.md` 记录事故与规则
- **规则：不要用 shell 文本处理改非 ASCII 源文件**，用文件编辑工具

## 验证清单

- [x] `cargo test` 全部通过（**49 个：20 单元 + 29 集成，0 失败**）
- [x] `vue-tsc --noEmit` 无类型错误
- [x] `vite build` 生产构建通过
- [x] 加密库文件层确认无明文
- [x] 中文 2 字词搜索命中
- [x] 子串搜索由单字索引兜底命中
- [x] 备份产物是密文且能用同一密码恢复
- [x] 已修复：日历标记只出现在真正写过内容的日子
- [ ] `tauri dev` 打开窗口并手动走一遍完整流程（初始化 → 写 → 搜 → 备份）
- [ ] 重启应用后锁定状态仍在

## P0 缺口补齐（本轮完成）

三项缺口已全部补上。逐项说明"改了什么"与"为什么这么做"。

### 1. 自动备份的定时触发

**改了什么**
- `commands.rs` 新增 `spawn_auto_backup()`：启动一个后台线程，每 5 分钟检查一次
- 新增 `AUTO_BACKUP_CHECK_INTERVAL = 5 分钟`、`AUTO_BACKUP_INTERVAL_SECS = 24 小时`
- `VaultState` 改为 `Arc` 包装，被 Tauri 状态管理与后台线程共享
- `lib.rs` 用 `.setup()` 注册状态并启动线程

**为什么这么做**
- **不用长睡眠（sleep 24h）**：应用可能中途关闭、电脑可能休眠，一次长睡眠会直接错过。
  改成"每 5 分钟醒来检查距上次备份是否超过 24 小时"，无论是刚开机还是长期运行都能补上。
- **计时依据是库里的时间戳**（`app_setting.last_backup_at`），不是内存状态 ——
  这样重启应用不会重置计时。
- **用普通线程而不是 async task**：备份全程持有 Vault 的 Mutex 且做阻塞式文件 I/O，
  放进 async 只会阻塞执行器线程，没有收益。一个独立线程语义更清晰，也不必引入运行时依赖。
- **未解锁时静默跳过**：这是正常状态，不该报错刷日志。
- **空库不备份**：一篇都没写时不产生备份，避免备份目录堆一堆空库；但仍推进计时器，
  否则每 5 分钟都会重复走到这一步。

### 2. 备份保留策略

**改了什么**
- `db.rs` 新增 `prune_backups(dir, keep_recent)` 与 `DEFAULT_KEEP_RECENT = 7`
- 新增 `Vault::run_backup()`：备份 → 记录时间 → 清理旧备份，三步一体
- 每次备份后自动清理；`备份保留规则` 为两条同时生效：
  1. 保留**最近 N 份**（默认 7）
  2. **每个月保留最早那 1 份**（即按月归档）

**为什么这么做**
- 自动备份如果没有清理，备份目录会无限增长：每天一份、一年 365 个文件，
  用户会看到一个塞满的目录。
- **清理失败绝不中断备份**：清理是维护动作，不该让"备份成功"变成失败。
  这条写进了代码（失败只 `eprintln`）。
- **只删本程序生成的文件**：只处理 `diary-YYYYMMDD-HHMMSS.db` 这种严格命名，
  并连同配对的 `.meta.json` 一起删。用户自己放进目录的任何文件都不碰。
  有专门测试（`prune_leaves_foreign_files_alone`）钉住这一点。
- **时间取自文件名**而不是文件系统时间：后者在复制/恢复后会变，不可靠。

### 3. KDF 自适应校准的健壮性

**先纠正一处文档错误**：`calibrate_kdf_params` **其实早已接入** `Vault::create`，
原先写的"未接入初始化流程"不准确。真正缺的是**低配机器上的健壮性**。

**改了什么**
- 重构校准循环：逐档尝试 64 / 128 / 256 / 512 MiB，**每档真正跑一次派生**
- 任何一档分配失败或派生失败，都继续尝试更小的一档，而不是中止
- 所有档位都失败时，回退到最小可用参数（而不是返回错误）
- 支持 `DSH_DIARY_SKIP_KDF_CALIBRATION=1` 跳过校准，便于测试断言确定参数

**为什么这么做**
- 原实现里"分配失败就 `return chosen`"会在极端低配机器上留下一个**未经实测的参数**。
- **校准绝不能让初始化失败**：如果这里报错或 panic，用户就永远建不了日记 ——
  这个代价远大于"安全性略弱"。宁可回退到最弱参数，也要让用户能开始写。
  这是一个明确写下的取舍。

**新增 7 条测试**
- `prune_keeps_recent_backups_and_removes_old_ones` —— 保留最近 N 份 + 配对 meta 一起删
- `prune_keeps_one_archive_per_month` —— 按月归档
- `prune_leaves_foreign_files_alone` —— **不碰任何非本程序生成的文件**
- `auto_backup_defaults_to_enabled` —— 默认开启（"忘了开备份"等于"没有备份"）
- `auto_backup_toggle_and_timer_persist` —— 开关与计时器跨重启保持
- `run_backup_records_time_and_prunes` —— 备份、记时、清理三步联动
- `calibration_returns_usable_params_and_never_fails` —— 校准出的参数必须真能派生密钥
- `default_params_are_within_calibration_bounds` —— 默认值不超过校准上限

## 本轮其他改动

### 数据目录改为项目本地（便携式）

**改了什么**
- `resolve_data_dir()` 重写：不再用 AppData，改为**从 exe 所在目录向上查找 `data/`**
  （最多 4 层），支持 `DSH_DIARY_DATA_DIR` 环境变量覆盖
- 移除 `directories` 依赖
- `.gitignore` 增加 `/data/`、`app/data/`

**为什么向上查找 4 层**：开发时 exe 在 `target/release/` 下，距项目根三层；
打包安装后 exe 在安装目录里，一层就到。向上找能同时覆盖两种情况。

**为什么数据不能进 git**：`diary.db` 是加密的，但 `crypto_meta.json`
（salt + KDF 参数）与 `lockout.json` 是**明文**，而且它们是用户私人数据。
已加入 gitignore 并有注释说明理由。

### 解锁页

- 标题改为居中的「**日记**」+ 副标题（初始化时"记录每天的自己"，日常"输入密码，继续写下去"）
- **数据目录只在首次初始化时显示一次**，日常解锁页不再显示 ——
  每次打开都看到一个自己改不了的路径只是噪音，但必须说过一次，
  否则用户不知道日记存在哪、该备份什么。

## 尚未实现（P0 范围外，留给 P1/V1）

已无 P0 缺口。P1 与后续版本的功能见 `docs/backlog.md` 与 `docs/feature-plan.md`。

