use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 聊天记录里的文件：一条聊天记录可以带好几个文件，消息上的"所附文件"只放得下一个。
        // 一个文件仍然只属于一条消息：文件编号是主键
        manager
            .create_table(
                Table::create()
                    .table(MessageFiles::Table)
                    .col(
                        ColumnDef::new(MessageFiles::FileId)
                            .string_len(36)
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(MessageFiles::MessageId)
                            .string_len(36)
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;
        // 清理消息时按消息找它的文件
        manager
            .create_index(
                Index::create()
                    .name("idx_message_files_message_id")
                    .table(MessageFiles::Table)
                    .col(MessageFiles::MessageId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(MessageFiles::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum MessageFiles {
    Table,
    FileId,
    MessageId,
}
