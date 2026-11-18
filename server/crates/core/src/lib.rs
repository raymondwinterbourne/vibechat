//! 业务逻辑，以及它对外部资源的抽象。
//!
//! 这个 crate 不依赖任何具体的数据库或存储实现；实现放在 `vibechat-infra`。
//! 换 Postgres 或 MinIO 时这里不需要改动。

pub mod account;
pub mod admin;
pub mod blob;
pub mod call;
pub mod chat;
pub mod clock;
pub mod contact;
pub mod file;
pub mod ids;
pub mod limits;
pub mod mail;
pub mod random;
pub mod settings;
pub mod store;
#[cfg(any(test, feature = "testing"))]
pub mod testing;

pub use ids::{
    CallId, ConversationId, FileId, FriendRequestId, InviteCodeId, JoinRequestId, MessageId,
    SessionId, UserId,
};
pub use store::{StoreError, StoreHealth, Stores};
