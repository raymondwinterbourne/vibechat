use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "users")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub handle: String,
    pub handle_lower: String,
    pub nickname: String,
    pub signature: String,
    pub avatar_file_id: Option<String>,
    pub password_hash: String,
    pub role: String,
    pub status: String,
    pub must_change_password: bool,
    pub email: Option<String>,
    pub invite_code_id: Option<String>,
    pub language: Option<String>,
    pub theme: Option<String>,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
