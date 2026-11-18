//! 管理相关的数据操作。实现在 `vibechat-infra`。

use async_trait::async_trait;

use super::model::{AdminToken, AuditAction, AuditEntry, TokenPurpose};
use crate::store::StoreError;

/// 操作记录。只有"追加"和"读"：系统里没有修改或删除它的办法。
#[async_trait]
pub trait AuditStore: Send + Sync {
    async fn append(&self, entry: &AuditEntry) -> Result<(), StoreError>;

    /// 从新到旧的一页，同时返回符合条件的一共有多少。可以只要某一种操作的。
    async fn list(
        &self,
        action: Option<AuditAction>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<AuditEntry>, u64), StoreError>;
}

/// 发到邮箱里的一次性令牌。
#[async_trait]
pub trait TokenStore: Send + Sync {
    async fn create(&self, token: &AdminToken) -> Result<(), StoreError>;

    /// 用掉一个令牌：它存在、是这个用途的、没有用过、没有过期时标为已使用并返回它，
    /// 否则返回 `None`。两处同时用同一个令牌时只有一处成功。
    async fn consume(
        &self,
        token_hash: &str,
        purpose: TokenPurpose,
        now: i64,
    ) -> Result<Option<AdminToken>, StoreError>;
}
