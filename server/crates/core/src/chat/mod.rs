//! 聊天：会话、会话日志（消息和事件）、已读位置。

pub mod error;
pub mod model;
pub mod service;
pub mod store;

pub use error::ChatError;
pub use model::{
    Conversation, ConversationKind, JoinRequest, JoinRequestStatus, Member, Message, MessageData,
    MessageKind, Party,
};
pub use service::{
    Attached, ChatService, ChatServiceDeps, Cleared, ConversationInfo, Draft, EditDraft, Extras,
    Forwarded, Found, GroupCallRecord, GroupInfo, HistoryQuery, Invited, JoinHandled,
    JoinRequestInfo, MemberInfo, MemberProfile, Merged, NoticeInfo, Overseen, OverseenMember, Page,
    Peer, Played, Posted, Quote, ReadUpdate,
};

#[cfg(test)]
mod group_tests;
#[cfg(test)]
mod rich_tests;
#[cfg(test)]
mod service_tests;
