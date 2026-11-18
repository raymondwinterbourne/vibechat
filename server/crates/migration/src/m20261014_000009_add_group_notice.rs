use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite 一条语句只能加一列，所以每一列单独加
        let conversations = || Conversations::Table.into_iden();
        let columns: [(DynIden, ColumnDef); 5] = [
            // 群公告：内容（没有公告时为空）、发布人、发布时间、发布它的那条事件的序号
            (
                conversations(),
                ColumnDef::new(Conversations::Notice).text().to_owned(),
            ),
            (
                conversations(),
                ColumnDef::new(Conversations::NoticeBy)
                    .string_len(36)
                    .to_owned(),
            ),
            (
                conversations(),
                ColumnDef::new(Conversations::NoticeAt)
                    .big_integer()
                    .to_owned(),
            ),
            (
                conversations(),
                ColumnDef::new(Conversations::NoticeSeq)
                    .big_integer()
                    .to_owned(),
            ),
            // 成员：看过的群公告，记的是发布它的那条事件的序号
            (
                ConversationMembers::Table.into_iden(),
                ColumnDef::new(ConversationMembers::NoticeSeenSeq)
                    .big_integer()
                    .not_null()
                    .default(0)
                    .to_owned(),
            ),
        ];
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
        let columns: [(DynIden, DynIden); 5] = [
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::NoticeSeenSeq.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::NoticeSeq.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::NoticeAt.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::NoticeBy.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::Notice.into_iden(),
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
    Notice,
    NoticeBy,
    NoticeAt,
    NoticeSeq,
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    NoticeSeenSeq,
}
