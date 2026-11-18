//! 通讯录：按 ID 查找用户、好友申请、好友关系。

pub mod error;
pub mod model;
pub mod service;
pub mod store;

pub use error::ContactError;
pub use model::{
    Friend, FriendRequest, FriendRequestStatus, Friendship, Relation, RequestEntry, UserCard,
};
pub use service::{ContactService, ContactServiceDeps, RequestOutcome};

#[cfg(test)]
mod service_tests;
