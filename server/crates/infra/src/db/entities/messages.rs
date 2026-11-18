use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "messages")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub conversation_id: String,
    pub seq: i64,
    pub sender_id: Option<String>,
    pub client_id: Option<String>,
    pub kind: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub text: Option<String>,
    pub created_at: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub data: Option<String>,
    pub file_id: Option<String>,
    pub reply_to_seq: Option<i64>,
    pub recalled_at: Option<i64>,
    pub edited_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
