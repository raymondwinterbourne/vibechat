use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite 一条语句只能加一列，所以每一列单独加
        let mut columns: Vec<(DynIden, ColumnDef)> = Vec::new();
        let mut add = |table: DynIden, column: ColumnDef| columns.push((table, column));

        // 群：名称、头像、群主、是否已经解散
        let conversations = || Conversations::Table.into_iden();
        add(
            conversations(),
            ColumnDef::new(Conversations::Name)
                .string_len(30)
                .to_owned(),
        );
        add(
            conversations(),
            ColumnDef::new(Conversations::AvatarFileId)
                .string_len(36)
                .to_owned(),
        );
        add(
            conversations(),
            ColumnDef::new(Conversations::OwnerId)
                .string_len(36)
                .to_owned(),
        );
        add(
            conversations(),
            ColumnDef::new(Conversations::Dissolved)
                .boolean()
                .not_null()
                .default(false)
                .to_owned(),
        );

        // 成员：离开时的序号（还在会话里则为空）、最近一次被 @ 的序号
        let members = || ConversationMembers::Table.into_iden();
        add(
            members(),
            ColumnDef::new(ConversationMembers::LeftSeq)
                .big_integer()
                .to_owned(),
        );
        add(
            members(),
            ColumnDef::new(ConversationMembers::MentionedSeq)
                .big_integer()
                .not_null()
                .default(0)
                .to_owned(),
        );

        // 消息：事件的参数和被 @ 的人，JSON
        add(
            Messages::Table.into_iden(),
            ColumnDef::new(Messages::Data).text().to_owned(),
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
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let columns: [(DynIden, DynIden); 7] = [
            (Messages::Table.into_iden(), Messages::Data.into_iden()),
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::MentionedSeq.into_iden(),
            ),
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::LeftSeq.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::Dissolved.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::OwnerId.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::AvatarFileId.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::Name.into_iden(),
            ),
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
enum Conversations {
    Table,
    Name,
    AvatarFileId,
    OwnerId,
    Dissolved,
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    LeftSeq,
    MentionedSeq,
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    Data,
}
