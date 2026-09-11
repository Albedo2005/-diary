//! 应用错误类型。
//!
//! 设计意图：Tauri command 的返回值必须能序列化给前端，所以这里的错误
//! 不是直接把底层错误透传（那会泄漏文件路径、SQL 片段等内部信息），
//! 而是分类成前端能处理、也能展示给用户的形式。
//!
//! 特别地：`WrongPin` 与 `Locked` 必须区分开，否则界面无法决定
//! "是提示密码错误，还是显示倒计时"。

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 数据库操作失败。可能原因：库被占用、磁盘满、数据损坏。
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    /// 密码错误。注意不要在此处携带任何"错在哪一位"的信息。
    #[error("密码不正确")]
    WrongPin,

    /// 处于锁定期，附带剩余秒数。
    #[error("已锁定，请在 {remaining_secs} 秒后重试")]
    Locked { remaining_secs: u64 },

    /// 密码格式不符合要求（长度、必须为数字等）。
    #[error("{0}")]
    InvalidPin(String),

    /// 加解密或密钥派生失败。
    #[error("加密操作失败: {0}")]
    Crypto(String),

    /// 文件系统操作失败。
    #[error("文件操作失败: {0}")]
    Io(#[from] std::io::Error),

    /// 请求的状态不合法。例如：在未解锁时尝试读写日记。
    #[error("状态错误: {0}")]
    State(String),

    /// 数据格式或约束校验失败。
    #[error("{0}")]
    Validation(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// 序列化为前端可消费的结构。
///
/// 前端拿到的是 `{ kind, message, ... }`，可以按 `kind` 分支处理，
/// 而不必去解析中文错误文本。
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;

        // 稳定的机器可读标识，前端按它分支，不要按 message 文本分支。
        let kind = match self {
            AppError::Db(_) => "db",
            AppError::WrongPin => "wrong_pin",
            AppError::Locked { .. } => "locked",
            AppError::InvalidPin(_) => "invalid_pin",
            AppError::Crypto(_) => "crypto",
            AppError::Io(_) => "io",
            AppError::State(_) => "state",
            AppError::Validation(_) => "validation",
        };

        let mut s = serializer.serialize_struct("AppError", 3)?;
        s.serialize_field("kind", kind)?;
        s.serialize_field("message", &self.to_string())?;
        match self {
            AppError::Locked { remaining_secs } => {
                s.serialize_field("remainingSecs", remaining_secs)?;
            }
            _ => {
                s.serialize_field("remainingSecs", &Option::<u64>::None)?;
            }
        }
        s.end()
    }
}
