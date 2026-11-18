use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 成员：什么时候把这个会话置顶的（F6）。没有置顶为空
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationMembers::Table)
                    .add_column(
                        ColumnDef::new(ConversationMembers::PinnedAt)
                            .big_integer()
                            .null(),
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
                    .drop_column(ConversationMembers::PinnedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    PinnedAt,
}
