use crate::store::StoreError;

/// 账号相关操作的失败原因。每一种都对应接口里的一个错误码和界面上的一句提示。
#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    /// ID 或密码不正确。不区分是哪一个，避免被用来探测哪些 ID 存在。
    #[error("invalid credentials")]
    InvalidCredentials,
    #[error("too many failed attempts, locked for {retry_after_secs}s")]
    Locked { retry_after_secs: u64 },
    #[error("too many requests, retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("account is disabled")]
    Disabled,

    #[error("invite code does not exist")]
    InviteCodeNotFound,
    #[error("invite code has already been used")]
    InviteCodeUsed,
    #[error("invite code has expired")]
    InviteCodeExpired,
    #[error("invite code has been revoked")]
    InviteCodeRevoked,

    #[error("password is too weak")]
    PasswordTooWeak,
    #[error("password must differ from the id")]
    PasswordSameAsHandle,
    #[error("current password is incorrect")]
    PasswordIncorrect,
    #[error("new password must differ from the current one")]
    PasswordUnchanged,

    #[error("id does not follow the rules")]
    HandleInvalid,
    #[error("id is already taken")]
    HandleTaken,
    #[error("nickname is empty or too long")]
    NicknameInvalid,
    #[error("signature is too long")]
    SignatureTooLong,
    #[error("invalid request: {0}")]
    Invalid(&'static str),

    #[error("file is not a supported image")]
    ImageUnsupported,
    #[error("file is too large")]
    FileTooLarge,
    #[error("not found")]
    NotFound,

    #[error(transparent)]
    Store(#[from] StoreError),
}
