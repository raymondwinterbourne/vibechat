//! 管理相关的两张表：操作记录、发到邮箱里的一次性令牌。

use async_trait::async_trait;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect,
};
use serde::{Deserialize, Serialize};
use vibechat_core::StoreError;
use vibechat_core::admin::model::{AdminToken, AuditAction, AuditDetail, AuditEntry, TokenPurpose};
use vibechat_core::admin::store::{AuditStore, TokenStore};

use super::entities::{admin_tokens, audit_logs};
use super::{corrupt, parse_id, unavailable};

pub struct DbAdmin {
    db: DatabaseConnection,
}

impl DbAdmin {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}

/// 操作记录的参数保存成的样子。没有的项不写。
#[derive(Serialize, Deserialize, Default)]
struct DetailJson {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to: Option<String>,
}

fn detail_to_json(detail: &AuditDetail) -> Option<String> {
    if *detail == AuditDetail::default() {
        return None;
    }
    let json = DetailJson {
        label: detail.label.clone(),
        count: detail.count,
        key: detail.key.clone(),
        from: detail.from.clone(),
        to: detail.to.clone(),
    };
    serde_json::to_string(&json).ok()
}

fn detail_from_json(text: Option<&str>) -> Result<AuditDetail, StoreError> {
    let Some(text) = text else {
        return Ok(AuditDetail::default());
    };
    let json: DetailJson = serde_json::from_str(text).map_err(|_| corrupt("audit_logs.detail"))?;
    Ok(AuditDetail {
        label: json.label,
        count: json.count,
        key: json.key,
        from: json.from,
        to: json.to,
    })
}

fn entry_from(row: audit_logs::Model) -> Result<AuditEntry, StoreError> {
    Ok(AuditEntry {
        at: row.at,
        actor: parse_id(&row.actor_id, "audit_logs.actor_id")?,
        action: AuditAction::parse(&row.action).ok_or_else(|| corrupt("audit_logs.action"))?,
        target: row.target,
        detail: detail_from_json(row.detail.as_deref())?,
        id: row.id,
    })
}

fn token_from(row: admin_tokens::Model) -> Result<AdminToken, StoreError> {
    Ok(AdminToken {
        user: parse_id(&row.user_id, "admin_tokens.user_id")?,
        purpose: TokenPurpose::parse(&row.purpose)
            .ok_or_else(|| corrupt("admin_tokens.purpose"))?,
        token_hash: row.token_hash,
        email: row.email,
        expires_at: row.expires_at,
        used_at: row.used_at,
    })
}

#[async_trait]
impl AuditStore for DbAdmin {
    async fn append(&self, entry: &AuditEntry) -> Result<(), StoreError> {
        let row = audit_logs::ActiveModel {
            id: Set(entry.id.clone()),
            at: Set(entry.at),
            actor_id: Set(entry.actor.to_string()),
            action: Set(entry.action.as_str().to_owned()),
            target: Set(entry.target.clone()),
            detail: Set(detail_to_json(&entry.detail)),
        };
        audit_logs::Entity::insert(row)
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn list(
        &self,
        action: Option<AuditAction>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<AuditEntry>, u64), StoreError> {
        let mut query = audit_logs::Entity::find();
        if let Some(action) = action {
            query = query.filter(audit_logs::Column::Action.eq(action.as_str()));
        }
        let total = query.clone().count(&self.db).await.map_err(unavailable)?;
        let entries = query
            .order_by_desc(audit_logs::Column::At)
            .order_by_desc(audit_logs::Column::Id)
            .offset(offset)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(entry_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((entries, total))
    }
}

#[async_trait]
impl TokenStore for DbAdmin {
    async fn create(&self, token: &AdminToken) -> Result<(), StoreError> {
        let row = admin_tokens::ActiveModel {
            token_hash: Set(token.token_hash.clone()),
            user_id: Set(token.user.to_string()),
            purpose: Set(token.purpose.as_str().to_owned()),
            email: Set(token.email.clone()),
            expires_at: Set(token.expires_at),
            used_at: Set(token.used_at),
        };
        admin_tokens::Entity::insert(row)
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn consume(
        &self,
        token_hash: &str,
        purpose: TokenPurpose,
        now: i64,
    ) -> Result<Option<AdminToken>, StoreError> {
        // 只有还没有用过、没有过期的那一行才会被更新到。
        // 两处同时用同一个令牌时，数据库保证只有一处能改到这一行。
        let claimed = admin_tokens::Entity::update_many()
            .col_expr(admin_tokens::Column::UsedAt, Expr::value(now))
            .filter(admin_tokens::Column::TokenHash.eq(token_hash))
            .filter(admin_tokens::Column::Purpose.eq(purpose.as_str()))
            .filter(admin_tokens::Column::UsedAt.is_null())
            .filter(admin_tokens::Column::ExpiresAt.gt(now))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        if claimed.rows_affected != 1 {
            return Ok(None);
        }
        admin_tokens::Entity::find_by_id(token_hash.to_owned())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(token_from)
            .transpose()
    }
}
