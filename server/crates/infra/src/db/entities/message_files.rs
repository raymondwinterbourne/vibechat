use sea_orm::entity::prelude::*;

/// 聊天记录里的文件：属于哪一条消息。
#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "message_files")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub file_id: String,
    pub message_id: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
