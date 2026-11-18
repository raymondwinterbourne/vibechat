use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 成员：清空聊天记录清空到了第几条（F6）。只对他自己有效：序号不大于它的他都看不到了
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationMembers::Table)
                    .add_column(
                        ColumnDef::new(ConversationMembers::ClearedSeq)
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;
        // 谁把哪个会话的第几条从自己这边删掉了（F6）。别人照常看得到
        manager
            .create_table(
                Table::create()
                    .table(DeletedMessages::Table)
                    .col(
                        ColumnDef::new(DeletedMessages::ConversationId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeletedMessages::UserId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeletedMessages::Seq)
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(DeletedMessages::DeletedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(DeletedMessages::ConversationId)
                            .col(DeletedMessages::UserId)
                            .col(DeletedMessages::Seq),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(DeletedMessages::Table).to_owned())
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationMembers::Table)
                    .drop_column(ConversationMembers::ClearedSeq)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    ClearedSeq,
}

#[derive(DeriveIden)]
enum DeletedMessages {
    Table,
    ConversationId,
    UserId,
    Seq,
    DeletedAt,
}
