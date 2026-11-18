//! 账号：注册、登录、登录会话、个人资料、邀请码。

pub mod error;
pub mod guard;
pub mod handle;
pub mod model;
pub mod password;
pub mod service;
pub mod store;

pub use error::AccountError;
pub use model::{
    FilePurpose, InviteCode, InviteCodeOrder, InviteCodeQuery, InviteCodeState, InviteCodeStatus,
    Language, ProfileChanges, Role, Session, StoredFile, Theme, User, UserCounts, UserQuery,
    UserStatus,
};
pub use service::{
    AccountService, AccountServiceDeps, AuthContext, InviteCodeListing, Limits, LoginOutcome,
    NewInviteCodes, Registration,
};

#[cfg(test)]
mod service_tests;
