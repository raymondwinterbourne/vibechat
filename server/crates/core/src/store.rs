//! 数据存储的抽象。业务逻辑只依赖这里的 trait，具体实现在 `vibechat-infra`。

use std::sync::Arc;

use async_trait::async_trait;

use crate::account::store::{FileStore, InviteCodeStore, SessionStore, UserStore};
use crate::admin::store::{AuditStore, TokenStore};
use crate::chat::store::ChatStore;
use crate::contact::store::ContactStore;
use crate::settings::SettingsStore;

/// 数据操作可能出现的错误。不暴露任何数据库特有的错误类型。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// 数据库或文件存储连不上，或执行失败。
    #[error("storage unavailable: {0}")]
    Unavailable(String),
}

/// 数据库是否可用。健康检查用。
#[async_trait]
pub trait StoreHealth: Send + Sync {
    async fn ping(&self) -> Result<(), StoreError>;
}

/// 全部数据操作的入口。每个功能模块一个 trait，后续里程碑往这里加。
#[derive(Clone)]
pub struct Stores {
    pub health: Arc<dyn StoreHealth>,
    pub settings: Arc<dyn SettingsStore>,
    pub users: Arc<dyn UserStore>,
    pub sessions: Arc<dyn SessionStore>,
    pub invite_codes: Arc<dyn InviteCodeStore>,
    pub files: Arc<dyn FileStore>,
    pub contacts: Arc<dyn ContactStore>,
    pub chat: Arc<dyn ChatStore>,
    pub audit: Arc<dyn AuditStore>,
    pub tokens: Arc<dyn TokenStore>,
}
