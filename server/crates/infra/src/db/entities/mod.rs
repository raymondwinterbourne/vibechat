//! 数据表对应的 SeaORM 实体。只在 `infra` 内部使用，不向外暴露。

pub mod admin_tokens;
pub mod audit_logs;
pub mod conversation_members;
pub mod conversations;
pub mod deleted_messages;
pub mod files;
pub mod friend_requests;
pub mod friendships;
pub mod invite_codes;
pub mod join_requests;
pub mod message_files;
pub mod messages;
pub mod sessions;
pub mod settings;
pub mod users;
pub mod voice_plays;
