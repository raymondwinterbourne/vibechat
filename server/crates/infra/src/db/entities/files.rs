use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub storage_key: String,
    pub content_type: String,
    pub size: i64,
    pub uploader_id: String,
    pub purpose: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub created_at: i64,
    pub name: Option<String>,
    pub thumbnail_key: Option<String>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
