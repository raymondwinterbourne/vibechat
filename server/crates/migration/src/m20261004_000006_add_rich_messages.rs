use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite 一条语句只能加一列，所以每一列单独加
        let mut columns: Vec<(DynIden, ColumnDef)> = Vec::new();
        let mut add = |table: DynIden, column: ColumnDef| columns.push((table, column));

        // 消息：所附的文件、被引用的那条消息的序号、撤回的时间
        let messages = || Messages::Table.into_iden();
        add(
            messages(),
            ColumnDef::new(Messages::FileId).string_len(36).to_owned(),
        );
        add(
            messages(),
            ColumnDef::new(Messages::ReplyToSeq)
                .big_integer()
                .to_owned(),
        );
        add(
            messages(),
            ColumnDef::new(Messages::RecalledAt)
                .big_integer()
                .to_owned(),
        );

        // 文件：上传时的文件名、图片缩略图的存放位置
        let files = || Files::Table.into_iden();
        add(
            files(),
            ColumnDef::new(Files::Name).string_len(255).to_owned(),
        );
        add(
            files(),
            ColumnDef::new(Files::ThumbnailKey)
                .string_len(255)
                .to_owned(),
        );

        for (table, mut column) in columns {
            manager
                .alter_table(
                    Table::alter()
                        .table(table)
                        .add_column(&mut column)
                        .to_owned(),
                )
                .await?;
        }

        // 一个文件只能属于一条消息。没有文件的消息这一列是空的，不受约束。
        // 按文件找消息（读文件时检查权限）也用这个索引
        manager
            .create_index(
                Index::create()
                    .name("idx_messages_file_id")
                    .table(Messages::Table)
                    .col(Messages::FileId)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // 谁播放了哪一条语音
        manager
            .create_table(
                Table::create()
                    .table(VoicePlays::Table)
                    .col(
                        ColumnDef::new(VoicePlays::MessageId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(ColumnDef::new(VoicePlays::UserId).string_len(36).not_null())
                    .col(
                        ColumnDef::new(VoicePlays::PlayedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .col(VoicePlays::MessageId)
                            .col(VoicePlays::UserId),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(VoicePlays::Table).to_owned())
            .await?;
        manager
            .drop_index(
                Index::drop()
                    .name("idx_messages_file_id")
                    .table(Messages::Table)
                    .to_owned(),
            )
            .await?;
        let columns: [(DynIden, DynIden); 5] = [
            (Files::Table.into_iden(), Files::ThumbnailKey.into_iden()),
            (Files::Table.into_iden(), Files::Name.into_iden()),
            (
                Messages::Table.into_iden(),
                Messages::RecalledAt.into_iden(),
            ),
            (
                Messages::Table.into_iden(),
                Messages::ReplyToSeq.into_iden(),
            ),
            (Messages::Table.into_iden(), Messages::FileId.into_iden()),
        ];
        for (table, column) in columns {
            manager
                .alter_table(Table::alter().table(table).drop_column(column).to_owned())
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    FileId,
    ReplyToSeq,
    RecalledAt,
}

#[derive(DeriveIden)]
enum Files {
    Table,
    Name,
    ThumbnailKey,
}

#[derive(DeriveIden)]
enum VoicePlays {
    Table,
    MessageId,
    UserId,
    PlayedAt,
}
