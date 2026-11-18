use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 成员：这个会话对他是不是免打扰
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationMembers::Table)
                    .add_column(
                        ColumnDef::new(ConversationMembers::Muted)
                            .boolean()
                            .not_null()
                            .default(false),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationMembers::Table)
                    .drop_column(ConversationMembers::Muted)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    Muted,
}
