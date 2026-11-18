use crate::account::AccountError;
use crate::chat::ChatError;
use crate::store::StoreError;

/// 管理操作的失败原因。
#[derive(Debug, thiserror::Error)]
pub enum AdminError {
    #[error("no such user")]
    UserNotFound,
    /// 管理员不能禁用自己，也不能用"重置密码"重置自己。
    #[error("an administrator cannot do this to their own account")]
    CannotTargetSelf,
    #[error("no such conversation")]
    ConversationNotFound,
    #[error("the group has already been dissolved")]
    GroupDissolved,
    /// 设置的值不在允许的范围里。
    #[error("setting {key} is out of range")]
    SettingOutOfRange { key: &'static str },
    /// 没有带查看凭据，或者它过期了、不是这个会话的：要先"开始一次查看"。
    #[error("a view of this conversation must be started first")]
    ViewRequired,
    /// 链接里的令牌不存在、用过了或者过期了。三种情况不作区分。
    #[error("the link is invalid or has expired")]
    TokenInvalid,
    #[error("the email address is not valid")]
    EmailInvalid,
    #[error("too many requests, retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("invalid request: {0}")]
    Invalid(&'static str),

    #[error(transparent)]
    Account(#[from] AccountError),
    #[error(transparent)]
    Chat(#[from] ChatError),
    #[error(transparent)]
    Store(#[from] StoreError),
}
