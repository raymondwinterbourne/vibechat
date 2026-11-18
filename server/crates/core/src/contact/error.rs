use crate::store::StoreError;

/// 通讯录相关操作的失败原因。每一种都对应接口里的一个错误码和界面上的一句提示。
#[derive(Debug, thiserror::Error)]
pub enum ContactError {
    /// 没有这个用户，或者他已经被禁用。
    #[error("no such user")]
    UserNotFound,
    #[error("cannot add yourself")]
    CannotAddSelf,
    #[error("already friends")]
    AlreadyFriends,
    #[error("not friends")]
    NotFriends,
    /// 没有这条申请，或者它不是发给自己的。两种情况不作区分。
    #[error("no such friend request")]
    RequestNotFound,
    /// 这条申请已经被同意或拒绝过了。
    #[error("friend request has already been handled")]
    RequestHandled,
    #[error("message is too long")]
    MessageTooLong,
    #[error("remark is too long")]
    RemarkTooLong,
    #[error("too many requests, retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },

    #[error(transparent)]
    Store(#[from] StoreError),
}
