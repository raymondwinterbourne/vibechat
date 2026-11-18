//! 统一的错误模型：所有接口出错时都返回"错误码加说明"的同一种结构。

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use vibechat_core::StoreError;
use vibechat_core::account::AccountError;
use vibechat_core::admin::AdminError;
use vibechat_core::chat::ChatError;
use vibechat_core::contact::ContactError;
use vibechat_core::file::FileError;
use vibechat_protocol::{ErrorCode, ErrorResponse};

#[derive(Debug)]
pub struct AppError {
    pub code: ErrorCode,
    /// 供排查问题用，不直接显示给用户。不要放内部细节，细节写进日志。
    pub message: String,
    /// 被锁定或被限速时，还要等多少秒。
    pub retry_after_secs: Option<u64>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after_secs: None,
        }
    }

    pub fn status(&self) -> StatusCode {
        use ErrorCode::*;
        match self.code {
            BadRequest
            | PasswordTooWeak
            | PasswordSameAsId
            | PasswordIncorrect
            | PasswordUnchanged
            | IdInvalid
            | NicknameInvalid
            | SignatureTooLong
            | CannotAddSelf
            | FriendRequestMessageTooLong
            | RemarkTooLong
            | MessageEmpty
            | MessageTooLong
            | GroupTooSmall
            | GroupNameTooLong
            | VoiceTooLong
            | SettingOutOfRange
            | LinkInvalid
            | EmailInvalid => StatusCode::BAD_REQUEST,
            Unauthorized | InvalidCredentials => StatusCode::UNAUTHORIZED,
            Forbidden | AccountDisabled | MustChangePassword | NotGroupOwner | NotGroupManager
            | CannotMuteManager | Muted | AllMuted | LeftGroup | RecallNotAllowed
            | EditNotAllowed | CannotTargetSelf | ViewRequired | CallNotAllowed
            | WrongCallDevice => StatusCode::FORBIDDEN,
            NotFound
            | InviteCodeNotFound
            | UserNotFound
            | NotFriends
            | FriendRequestNotFound
            | ConversationNotFound
            | NotGroupMember
            | JoinRequestNotFound
            | MessageNotFound
            | CallNotFound => StatusCode::NOT_FOUND,
            MethodNotAllowed => StatusCode::METHOD_NOT_ALLOWED,
            InviteCodeUsed | InviteCodeExpired | InviteCodeRevoked | IdTaken | AlreadyFriends
            | FriendRequestHandled | GroupFull | TooManyAdmins | JoinRequestHandled
            | OwnerCannotLeave | GroupDissolved | FileUnavailable | QuoteUnavailable
            | RecallTooLate | EditTooLate | ForwardNotAllowed | AlreadyInCall | CallNotRinging
            | CallNotAnswered | GroupCallRunning | GroupCallFull | NotInGroupCall
            | GroupCallSharing => StatusCode::CONFLICT,
            PayloadTooLarge | FileTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            UnsupportedImage => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            TooManyRequests | AccountLocked => StatusCode::TOO_MANY_REQUESTS,
            Internal => StatusCode::INTERNAL_SERVER_ERROR,
            Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let body = ErrorResponse {
            code: self.code,
            message: self.message,
            retry_after_secs: self
                .retry_after_secs
                .map(|secs| secs.min(u32::MAX as u64) as u32),
        };
        let mut response = (status, Json(body)).into_response();
        if let Some(secs) = self.retry_after_secs {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        response
    }
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        // 数据库的具体报错只进日志，不返回给调用方
        tracing::error!("store error: {err}");
        match err {
            StoreError::Unavailable(_) => {
                Self::new(ErrorCode::Unavailable, "storage is unavailable")
            }
        }
    }
}

impl From<AccountError> for AppError {
    fn from(err: AccountError) -> Self {
        use AccountError as E;
        let code = match &err {
            E::Store(_) => {
                tracing::error!("store error: {err}");
                return Self::new(ErrorCode::Unavailable, "storage is unavailable");
            }
            E::Locked { retry_after_secs } => {
                return Self {
                    retry_after_secs: Some(*retry_after_secs),
                    ..Self::new(ErrorCode::AccountLocked, err.to_string())
                };
            }
            E::RateLimited { retry_after_secs } => {
                return Self {
                    retry_after_secs: Some(*retry_after_secs),
                    ..Self::new(ErrorCode::TooManyRequests, err.to_string())
                };
            }
            E::InvalidCredentials => ErrorCode::InvalidCredentials,
            E::Disabled => ErrorCode::AccountDisabled,
            E::InviteCodeNotFound => ErrorCode::InviteCodeNotFound,
            E::InviteCodeUsed => ErrorCode::InviteCodeUsed,
            E::InviteCodeExpired => ErrorCode::InviteCodeExpired,
            E::InviteCodeRevoked => ErrorCode::InviteCodeRevoked,
            E::PasswordTooWeak => ErrorCode::PasswordTooWeak,
            E::PasswordSameAsHandle => ErrorCode::PasswordSameAsId,
            E::PasswordIncorrect => ErrorCode::PasswordIncorrect,
            E::PasswordUnchanged => ErrorCode::PasswordUnchanged,
            E::HandleInvalid => ErrorCode::IdInvalid,
            E::HandleTaken => ErrorCode::IdTaken,
            E::NicknameInvalid => ErrorCode::NicknameInvalid,
            E::SignatureTooLong => ErrorCode::SignatureTooLong,
            E::Invalid(_) => ErrorCode::BadRequest,
            E::ImageUnsupported => ErrorCode::UnsupportedImage,
            E::FileTooLarge => ErrorCode::PayloadTooLarge,
            E::NotFound => ErrorCode::NotFound,
        };
        Self::new(code, err.to_string())
    }
}

impl From<ContactError> for AppError {
    fn from(err: ContactError) -> Self {
        use ContactError as E;
        let code = match &err {
            E::Store(_) => {
                tracing::error!("store error: {err}");
                return Self::new(ErrorCode::Unavailable, "storage is unavailable");
            }
            E::RateLimited { retry_after_secs } => {
                return Self {
                    retry_after_secs: Some(*retry_after_secs),
                    ..Self::new(ErrorCode::TooManyRequests, err.to_string())
                };
            }
            E::UserNotFound => ErrorCode::UserNotFound,
            E::CannotAddSelf => ErrorCode::CannotAddSelf,
            E::AlreadyFriends => ErrorCode::AlreadyFriends,
            E::NotFriends => ErrorCode::NotFriends,
            E::RequestNotFound => ErrorCode::FriendRequestNotFound,
            E::RequestHandled => ErrorCode::FriendRequestHandled,
            E::MessageTooLong => ErrorCode::FriendRequestMessageTooLong,
            E::RemarkTooLong => ErrorCode::RemarkTooLong,
        };
        Self::new(code, err.to_string())
    }
}

impl From<ChatError> for AppError {
    fn from(err: ChatError) -> Self {
        use ChatError as E;
        let code = match &err {
            E::Store(_) => {
                tracing::error!("store error: {err}");
                return Self::new(ErrorCode::Unavailable, "storage is unavailable");
            }
            E::ConversationNotFound => ErrorCode::ConversationNotFound,
            E::NotFriends => ErrorCode::NotFriends,
            E::MessageEmpty => ErrorCode::MessageEmpty,
            E::MessageTooLong => ErrorCode::MessageTooLong,
            E::GroupTooSmall => ErrorCode::GroupTooSmall,
            E::GroupFull { .. } => ErrorCode::GroupFull,
            E::GroupNameTooLong => ErrorCode::GroupNameTooLong,
            E::NotOwner => ErrorCode::NotGroupOwner,
            E::NotManager => ErrorCode::NotGroupManager,
            E::TooManyAdmins { .. } => ErrorCode::TooManyAdmins,
            E::CannotMuteManager => ErrorCode::CannotMuteManager,
            E::JoinRequestNotFound => ErrorCode::JoinRequestNotFound,
            E::JoinRequestHandled => ErrorCode::JoinRequestHandled,
            E::Muted { .. } => ErrorCode::Muted,
            E::AllMuted => ErrorCode::AllMuted,
            E::OwnerCannotLeave => ErrorCode::OwnerCannotLeave,
            E::GroupDissolved => ErrorCode::GroupDissolved,
            E::LeftGroup => ErrorCode::LeftGroup,
            E::NotMember => ErrorCode::NotGroupMember,
            E::MessageNotFound => ErrorCode::MessageNotFound,
            E::FileUnavailable => ErrorCode::FileUnavailable,
            E::VoiceTooLong { .. } => ErrorCode::VoiceTooLong,
            E::QuoteUnavailable => ErrorCode::QuoteUnavailable,
            E::RecallTooLate => ErrorCode::RecallTooLate,
            E::RecallNotAllowed => ErrorCode::RecallNotAllowed,
            E::EditTooLate => ErrorCode::EditTooLate,
            E::EditNotAllowed => ErrorCode::EditNotAllowed,
            E::ForwardNotAllowed => ErrorCode::ForwardNotAllowed,
            E::CallNotAllowed => ErrorCode::CallNotAllowed,
            E::Invalid(_) => ErrorCode::BadRequest,
        };
        Self::new(code, err.to_string())
    }
}

impl From<AdminError> for AppError {
    fn from(err: AdminError) -> Self {
        use AdminError as E;
        let message = err.to_string();
        let code = match err {
            E::Store(err) => return err.into(),
            E::Account(err) => return err.into(),
            E::Chat(err) => return err.into(),
            E::RateLimited { retry_after_secs } => {
                return Self {
                    retry_after_secs: Some(retry_after_secs),
                    ..Self::new(ErrorCode::TooManyRequests, message)
                };
            }
            E::UserNotFound => ErrorCode::UserNotFound,
            E::CannotTargetSelf => ErrorCode::CannotTargetSelf,
            E::ConversationNotFound => ErrorCode::ConversationNotFound,
            E::GroupDissolved => ErrorCode::GroupDissolved,
            E::SettingOutOfRange { .. } => ErrorCode::SettingOutOfRange,
            E::ViewRequired => ErrorCode::ViewRequired,
            E::TokenInvalid => ErrorCode::LinkInvalid,
            E::EmailInvalid => ErrorCode::EmailInvalid,
            E::Invalid(_) => ErrorCode::BadRequest,
        };
        Self::new(code, message)
    }
}

impl From<FileError> for AppError {
    fn from(err: FileError) -> Self {
        use FileError as E;
        let code = match &err {
            E::Store(_) => {
                tracing::error!("store error: {err}");
                return Self::new(ErrorCode::Unavailable, "storage is unavailable");
            }
            E::NotFound => ErrorCode::NotFound,
            E::TooLarge { .. } => ErrorCode::FileTooLarge,
            // 空文件，或者内容没有传完
            E::Empty | E::Interrupted => ErrorCode::BadRequest,
        };
        Self::new(code, err.to_string())
    }
}
