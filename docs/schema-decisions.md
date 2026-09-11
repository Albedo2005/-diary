# 表结构定案（附实测证据）

这份文档只写**经过实测验证**的设计。每条结论都标注了验证方式，
因为这里的每一个错误都会导致"日记搜不到"或"索引损坏"，属于事后极难排查的问题。

## 一、最终表结构

```sql
-- 日记主表
CREATE TABLE entry (
    id          INTEGER PRIMARY KEY,
    entry_date  TEXT    NOT NULL UNIQUE,      -- 'YYYY-MM-DD'，一天一篇的数据库级保证
    title       TEXT    NOT NULL DEFAULT '',  -- 从首行自动提取，不强制用户填
    content_md  TEXT    NOT NULL DEFAULT '',  -- 原文，用于显示、编辑与导出
    word_count  INTEGER NOT NULL DEFAULT 0,
    mood        INTEGER,
    created_at  TEXT    NOT NULL,             -- 与 entry_date 分离：补写昨天的日记不许污染此值
    updated_at  TEXT    NOT NULL
);

-- 主搜索索引：jieba 分词，contentless + 支持按 rowid 删除
CREATE VIRTUAL TABLE entry_fts USING fts5(
    seg,
    tokenize='unicode61',
    content='',
    contentless_delete=1
);

-- 兜底搜索索引：单字切分，保证任意子串可命中
CREATE VIRTUAL TABLE entry_fts_char USING fts5(
    chars,
    tokenize='unicode61',
    content='',
    contentless_delete=1
);

-- 标签
CREATE TABLE tag (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE entry_tag (
    entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tag(id)   ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

-- 附件（不加密，用户已确认）
CREATE TABLE attachment (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    file_name  TEXT    NOT NULL,
    stored_rel TEXT    NOT NULL,   -- 只存相对路径，绝不存绝对路径
    mime       TEXT    NOT NULL,
    byte_size  INTEGER NOT NULL,
    sha256     TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

-- 加密元信息（salt 与 KDF 参数必须持久化）
CREATE TABLE crypto_meta (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    kdf        TEXT    NOT NULL,   -- 'argon2id'
    kdf_salt   BLOB    NOT NULL,   -- >= 16 字节随机
    kdf_params TEXT    NOT NULL,   -- JSON: m_cost / t_cost / p_cost
    cipher_ver INTEGER NOT NULL
);
```

**索引同步方式**：不用触发器，在 Rust 侧写入时同步更新两张索引表。
理由见下文第三节。

## 二、为什么不用外部内容表（`content='entry'`）

**实测证据**：`trigger_diag` 程序证明，用外部内容表 + 触发器存**原文**时，
中文搜索等同失效。原因链条：

1. `unicode61` tokenizer **不把汉字当分隔符**，`今天去吃了火锅。` 是**一个 token**；
2. 所以 `MATCH '"火锅"'` 搜不到，但 `MATCH '"测试"'` 能搜到
   （因为"测试"恰好位于句首 token 边界）；
3. 索引里必须是**分词后的文本**，而分词需要 jieba，jieba 只在 Rust 侧可用；
4. 而外部内容表的 FTS 列必须与内容表列**一一对应**（写错列名直接报
   `no such column: T.seg`），无法存"派生的分词文本"。

**结论**：普通/内容表 + 存分词文本，不用外部内容表。

## 三、为什么不用触发器同步索引

**实测证据**：传统 FTS5 删除命令
`INSERT INTO fts(fts, rowid, seg) VALUES('delete', old.id, old.seg)`
要求提供的旧文本与索引里的**完全一致**，否则抛 `SQL logic error`。
实测中我仅仅因为手打的 seg 与 jieba 切法差一个 token 就触发了该错误。

这意味着：一旦存储的分词文本与索引内容漂移（分词器升级、数据迁移、
手工改库、旧版本残留），UPDATE/DELETE 就会报错，严重时**索引损坏**。
相关实践问题在社区中确实存在，可见
[emdash 项目修复 FTS5 corruption 的 PR](https://github.com/emdash-cms/emdash/pull/768/files/bf1ed6d3b4ca1b67454e8ddf72aaac28c22b3e7e)
与 [SQLite 论坛关于 contentless 表 DELETE/REPLACE 的讨论](https://sqlite.org/forum/info/24d214be68bbf450?t=c)。

**改用 `contentless_delete=1` 后（实测）**：

- 删除只需 `DELETE FROM entry_fts WHERE rowid = ?`，**不需要重新提供原文**；
- 天然免疫上述漂移问题；
- 索引内不存文本副本，省掉一份分词文本；
- 实测孤儿行数 = 0。

**代价**：失去 `highlight()` / `snippet()`（实测 contentless 表调用它们返回 NULL）。

**这个代价可以接受，而且本来就该这样做**：实测普通表的 `highlight()` 输出是
`今天 很 开心 今天 很 开心 ， 和 朋友 去 吃 了 [火锅] ， 聊到 很 晚 才 回家 。`
—— 里面全是 jieba 留下的空格，直接给用户看会是"开心 ，和 朋友"这种破碎排版。

所以**高亮本就应该在原文上做**：FTS 只负责告诉我们"哪几条命中"，
前端拿查询词在 `content_md` 原文里定位并高亮，排版才是真实的。

## 四、为什么需要两张索引（双索引兜底）

**实测证据**：jieba 按词切分，所以搜「牛肉」搜不到「牛肉面」
（jieba 把"牛肉面"切成一个词）。这是精确分词的固有代价，不是 bug。

实测对比：

| 查询 | 词索引（jieba） | 字索引（单字） |
|---|---|---|
| 火锅 | ✅ | ✅ |
| 开心 | ✅ | ✅ |
| 日落 | ✅ | ✅ |
| 牛肉面 | ✅ | ✅ |
| **牛肉** | ❌ | ✅ **命中** |
| 小说 | ✅ | ✅ |

**策略**：两个索引都建，查询时结果合并。

- 词索引负责精确匹配，未来可用于相关性排序
- 字索引保证任意子串都能命中，作为兜底
- 词索引命中优先级高于字索引（前者更精确）

成本：字索引会增加存储，但纯文本日记的数据量下不构成问题
（实测 4 条记录：词索引 + 字索引 + 原文共约 44 KB）。

## 五、中文分词方案的最终选择

三个候选方案的实测结论：

| 方案 | 2 字词 | 3 字词 | 索引体积 | 结论 |
|---|---|---|---|---|
| **jieba 预分词 + unicode61** | ✅ | ✅ | 28 KB | **采用** |
| trigram（内置） | ❌ | ✅ | 48 KB | 否决 |
| `simple` C 扩展 | 未测 | 未测 | — | 备选（支持拼音） |

**否决 trigram 的理由**：「火锅」「开心」「日落」「加班」这类 2 字词是中文日记的
高频查询词，实测全部搜不到，体验损失无法接受。

**jieba 实测表现**（超出预期）：连「牛肉面」「聊到」这类词都切对了，
7 个测试查询词全部命中。

**若将来需要拼音搜索**（用户用 `huoguo` 搜「火锅」），再引入
[`simple` / `sqlite-fts-simple`](https://github.com/zmy12006/sqlite-fts-simple)
这类支持中文+拼音的 FTS5 tokenizer。当前不需要，不提前引入复杂度。

## 六、写入路径（正式代码必须遵守）

写一条日记时，必须在一个事务里完成：

```rust
let tx = conn.transaction()?;
tx.execute("INSERT INTO entry (entry_date, title, content_md, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?4)", params![...])?;
let id = tx.last_insert_rowid();
tx.execute("INSERT INTO entry_fts(rowid, seg) VALUES (?1, ?2)", params![id, jieba_seg(&text)])?;
tx.execute("INSERT INTO entry_fts_char(rowid, chars) VALUES (?1, ?2)", params![id, char_seg(&text)])?;
tx.commit()?;
```

⚠️ **必须放在同一个事务里**。分开写会出现"日记存了但搜不到"
（索引写入失败）或"搜到一条打不开的日记"（索引写了但正文没存）。

⚠️ **分词必须在 Rust 侧完成**，因为 jieba 在 Rust 侧。这也是为什么不用触发器：
触发器无法调用 jieba。

## 七、被否决的方案及原因（避免以后重复纠结）

| 方案 | 否决原因 |
|---|---|
| Tauri 官方 `tauri-plugin-sql` | 不支持 SQLCipher，且密钥会暴露给前端 |
| 触发器里存原文 | 实测中文搜索失效（unicode61 不切汉字） |
| 外部内容表 `content='entry'` | 列必须与内容表一一对应，无法存分词文本 |
| 传统 FTS5 `delete` 命令 | 要求旧文本完全一致，漂移即报错/损坏 |
| trigram tokenizer | 2 字查询词天然做不到 |
| 在数据库里存第二份密码校验值 | SQLCipher 自己会验证密钥，多存一份等于多一个爆破目标 |
| 绝对路径存附件 | 换电脑/改用户名/移动目录即全部失效 |
