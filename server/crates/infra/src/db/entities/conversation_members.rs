use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_members")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub conversation_id: String,
    #[sea_orm(primary_key, auto_increment = false)]
    pub user_id: String,
    pub joined_seq: i64,
    pub read_seq: i64,
    pub hidden_seq: Option<i64>,
    pub created_at: i64,
    pub left_seq: Option<i64>,
    pub mentioned_seq: i64,
    pub muted: bool,
    pub notice_seen_seq: i64,
    pub is_admin: bool,
    pub nickname: Option<String>,
    pub muted_until: Option<i64>,
    pub pinned_at: Option<i64>,
    pub cleared_seq: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
