//! 中文分词。
//!
//! 为什么要自己做分词，而不是用 SQLite 内置能力：**FTS5 的内置 tokenizer
//! 对中文等于失效**。实测（docs/probe-findings.md）：
//!
//! `unicode61` 不把汉字视为分隔符，所以「今天去吃了火锅。」是**一个 token**。
//! 结果极具迷惑性：
//!   搜「测试」✅ 命中（"测试"恰好在句首 token 边界）
//!   搜「火锅」❌ 失败（不在 token 边界）
//!
//! 也就是说，它看起来像"搜索能用"，实际大部分查询词都搜不到。
//! 诊断程序 `probe/src/bin/trigger_diag.rs` 把库里真实内容打出来才定位到。
//!
//! 因此索引里必须存**分词后的文本**，而分词需要 jieba，jieba 只在 Rust 侧
//! 可用 —— 这也是为什么索引同步不用 SQLite 触发器：触发器无法调用 jieba。

use jieba_rs::Jieba;

/// 分词器。持有 jieba 词典，创建成本较高（十几毫秒），
/// 所以整个应用只建一个实例并复用。
pub struct Segmenter {
    jieba: Jieba,
}

impl Segmenter {
    pub fn new() -> Self {
        Self {
            jieba: Jieba::new(),
        }
    }

    /// 按词切分，用空格连接，供主索引 `entry_fts.seg` 使用。
    ///
    /// 用 jieba 的精确模式（`cut` 的第二个参数 false 表示不使用 HMM）。
    /// 实测切分质量（docs/probe-findings.md）：
    ///   "今天很开心，和朋友去吃了火锅，聊到很晚才回家。"
    ///   -> "今天 很 开心 ， 和 朋友 去 吃 了 火锅 ， 聊到 很 晚 才 回家 。"
    /// 连「牛肉面」「聊到」这类词都能正确切出。
    pub fn words(&self, text: &str) -> String {
        self.jieba.cut(text, false).join(" ")
    }

    /// 按单字切分，用空格连接，供兜底索引 `entry_fts_char.chars` 使用。
    ///
    /// 为什么要空格连接而不是原样存：`unicode61` 会把连续的汉字串当成
    /// 一个 token，那样单字索引就失去意义了。空格是 unicode61 认可的分隔符。
    ///
    /// 空白字符直接丢弃：它们在单字索引里没有检索价值，留着只会浪费空间。
    pub fn chars(text: &str) -> String {
        let mut out = String::with_capacity(text.len() * 2);
        for ch in text.chars() {
            if ch.is_whitespace() {
                continue;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push(ch);
        }
        out
    }
}

impl Default for Segmenter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_are_split_and_space_joined() {
        let s = Segmenter::new();
        let seg = s.words("今天很开心");
        // 必须产生空格，否则 unicode61 会把整串当做一个 token，搜索失效。
        assert!(seg.contains(' '), "分词结果必须含空格，实际: {seg:?}");
        assert!(seg.contains("开心"), "应切出「开心」，实际: {seg:?}");
    }

    #[test]
    fn word_search_term_survives_segmentation() {
        let s = Segmenter::new();
        // 这是核心保证：索引文本里的分词结果必须包含查询词本身，
        // 否则 MATCH 无法命中。
        let seg = s.words("今天很开心，和朋友去吃了火锅，聊到很晚才回家。");
        assert!(seg.split(' ').any(|t| t == "火锅"), "索引应含「火锅」token: {seg:?}");
        assert!(seg.split(' ').any(|t| t == "开心"), "索引应含「开心」token: {seg:?}");
    }

    #[test]
    fn jieba_treats_compound_word_as_one_token() {
        // 这条测试固化的是**一个已知局限**，不是期望行为：
        // jieba 把「牛肉面」切成一个整词，所以主索引里搜「牛肉」搜不到它。
        // 兜底的单字索引正是为此存在（见 db::search 与 docs/schema-decisions.md）。
        // 如果哪天 jieba 升级后把「牛肉面」切成「牛肉」+「面」，这条测试会失败 ——
        // 那时说明主索引已经能命中，是好事，但需要同步复查双索引策略是否仍有必要。
        let s = Segmenter::new();
        let seg = s.words("买了一碗牛肉面");
        assert!(
            seg.split(' ').any(|t| t == "牛肉面"),
            "jieba 当前把「牛肉面」当整词，主索引因此搜不到「牛肉」: {seg:?}"
        );
        assert!(
            !seg.split(' ').any(|t| t == "牛肉"),
            "若这里开始为真，说明分词行为变了，请复查双索引策略: {seg:?}"
        );
    }

    #[test]
    fn chars_drops_whitespace_and_separates() {
        let out = Segmenter::chars("牛 肉\n面");
        assert_eq!(out, "牛 肉 面");
        assert_eq!(Segmenter::chars("火锅"), "火 锅");
        assert_eq!(Segmenter::chars(""), "");
    }

    #[test]
    fn chars_index_makes_substring_searchable() {
        // 兜底索引的意义：jieba 把「牛肉面」当一个词，搜「牛肉」在主索引里
        // 搜不到；但单字索引里有「牛」「肉」两个 token，AND 查询即可命中。
        let chars = Segmenter::chars("买了一碗牛肉面");
        let tokens: Vec<&str> = chars.split(' ').collect();
        assert!(tokens.contains(&"牛"));
        assert!(tokens.contains(&"肉"));
    }
}
