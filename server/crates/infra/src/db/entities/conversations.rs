use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "conversations")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub kind: String,
    pub direct_key: Option<String>,
    pub last_seq: i64,
    pub created_at: i64,
    pub name: Option<String>,
    pub avatar_file_id: Option<String>,
    pub owner_id: Option<String>,
    pub dissolved: bool,
    pub notice: Option<String>,
    pub notice_by: Option<String>,
    pub notice_at: Option<i64>,
    pub notice_seq: Option<i64>,
    pub all_muted: bool,
    pub join_approval: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
