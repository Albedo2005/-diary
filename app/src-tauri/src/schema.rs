//! 数据库表结构。
//!
//! 每条设计决定都有实测依据，详见 docs/schema-decisions.md。这里只写
//! "为什么这么建"，避免以后有人好心改坏。

/// 当前 schema 版本。将来加字段时递增，并在 `db::migrate` 里处理升级。
///
/// 用一个独立的 `schema_version` 表记录，而不是 SQLite 的 `PRAGMA user_version`：
/// 后者在加密库里行为正常，但用独立表更直观、也便于把版本信息一并导出。
pub const SCHEMA_VERSION: i64 = 2;

/// 建表语句。
///
/// 执行顺序有意义：notebook 必须在 entry 之前建，因为 entry 有外键引用它。
pub const CREATE_SQL: &str = r#"
-- ---------------------------------------------------------------------------
-- 日记本
--
-- 当前版本只有一个默认本子（P0 是单本模式）。但**现在就建这张表并在 entry
-- 上留 notebook_id**，成本约 10 分钟，却能省掉将来支持多日记本时的数据迁移。
--
-- 将来升级到多本时只需：
--   1. 把 entry 的唯一约束从 UNIQUE(entry_date) 改为 UNIQUE(notebook_id, entry_date)
--   2. 加上本子切换界面
-- 不需要迁移任何历史数据，因为所有老记录已经带着 notebook_id = 1。
-- 见 docs/backlog.md 的 V2。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notebook (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    icon       TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 日记
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entry (
    id          INTEGER PRIMARY KEY,
    notebook_id INTEGER NOT NULL DEFAULT 1 REFERENCES notebook(id),
    -- 逻辑日期 'YYYY-MM-DD'。与 created_at 分离：用户补写昨天的日记时，
    -- 不应该污染"这条记录是什么时候写的"这个事实。
    entry_date  TEXT    NOT NULL,
    title       TEXT    NOT NULL DEFAULT '',
    -- Markdown 原文。这是唯一的正文存储形式。
    -- ⚠️ 铁律：永远不要改成 HTML 或富文本 JSON。
    --    将来升级到所见即所得编辑器（docs/backlog.md 的 V1）时，
    --    富文本只在内存里存在，落库前仍然转回 Markdown。
    --    一旦改成别的格式，导出、搜索、备份全部要重写，升级也不再平滑。
    content_md  TEXT    NOT NULL DEFAULT '',
    word_count  INTEGER NOT NULL DEFAULT 0,
    mood        INTEGER,
    -- 锁定：1 = 这篇日记只读，不可修改。
    -- 锁的是**内容**，不是排版 —— 锁定状态下正文一字不改地原样显示，
    -- 包括用户手动排的换行与空格。（曾经右上角是"阅读"视图，用 Markdown
    -- 渲染，会把手动排版吃掉：Markdown 里单个换行等于空格、行首空格被吞。
    -- 详见 EditorPane.vue 顶部的说明。）
    locked      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL,
    -- 一天一篇靠数据库约束保证，不靠应用层"先查再插"。
    -- 应用层判断在并发或异常路径下会产生同日两条记录，而这类脏数据极难清理。
    UNIQUE (entry_date)
);

CREATE INDEX IF NOT EXISTS idx_entry_date ON entry(entry_date DESC);

-- ---------------------------------------------------------------------------
-- 搜索索引（两张）
--
-- 为什么是 contentless（content=''）而不是普通表或外部内容表：
--   1. 不用外部内容表 content='entry'：它的 FTS 列必须与内容表列一一对应，
--      而我们要存的是"分词后的文本"这个派生数据，结构上对不上。
--      实测报错 `no such column: T.seg`。
--   2. 不用普通表：普通表能存文本、支持 highlight()，但传统 FTS5 删除命令
--      要求提供的旧文本与索引内容**完全一致**，否则报 `SQL logic error`。
--      实测中仅仅手打的分词与 jieba 切法差一个 token 就触发了该错误。
--      这意味着存储的分词文本一旦漂移（分词器升级、数据迁移、手工改库），
--      UPDATE/DELETE 就会失败甚至损坏索引。
--   3. 用 contentless + contentless_delete=1：删除只需 rowid，
--      不重新提供原文，天然免疫上述漂移问题。省掉索引里的文本副本。
--
-- 代价：失去 highlight()/snippet()（实测 contentless 表调用返回 NULL）。
-- 这个代价可以接受，因为高亮本来就该在**原文**上做 ——
-- 实测普通表的 highlight() 输出是
--   "今天 很 开心 ... 和 朋友 去 吃 了 [火锅] ..."
-- 里面的空格来自 jieba 分词，直接展示给用户会是破碎的排版。
-- ---------------------------------------------------------------------------

-- 主索引：jieba 按词切分。查询精确，将来可用于相关性排序。
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5(
    seg,
    tokenize='unicode61',
    content='',
    contentless_delete=1
);

-- 兜底索引：按单字切分。
--
-- 为什么需要第二张：jieba 按词切分是"精确匹配"，实测搜「牛肉」搜不到
-- 「牛肉面」（jieba 把"牛肉面"当做一个词）。这是精确分词的固有代价。
-- 单字索引保证任意子串都能命中，作为降级路径。
--
-- 实测对比（docs/probe-findings.md）：
--   「牛肉」 词索引=无   字索引=命中   ← 兜底索引的价值所在
--   「火锅」 词索引=命中 字索引=命中
CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts_char USING fts5(
    chars,
    tokenize='unicode61',
    content='',
    contentless_delete=1
);

-- ---------------------------------------------------------------------------
-- 标签（数据结构先建好，界面属于 P1）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tag (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS entry_tag (
    entry_id INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tag(id)   ON DELETE CASCADE,
    PRIMARY KEY (entry_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- 附件（P1）
--
-- ⚠️ 当前决定：附件**不加密**（用户已知风险）。
--    附件文件放在应用数据目录下的 attachments/ 子目录，绝不放桌面或文档根目录。
--    已知风险：图片往往比正文更敏感，且会被云同步软件一起带走 ——
--    那会造成"正文是加密的，图片却明文躺在云盘里"的错觉。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachment (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
    file_name  TEXT    NOT NULL,
    -- 只存相对路径。绝对路径在用户换电脑、改用户名、移动数据目录后全部失效。
    stored_rel TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    byte_size  INTEGER NOT NULL,
    sha256     TEXT    NOT NULL,
    created_at TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- 设置与版本
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);
"#;

/// 默认本子的 id。单本模式下所有日记都挂在这个本子上。
pub const DEFAULT_NOTEBOOK_ID: i64 = 1;
