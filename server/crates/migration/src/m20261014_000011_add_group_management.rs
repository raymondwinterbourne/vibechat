use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // SQLite 一条语句只能加一列，所以每一列单独加
        let members = || ConversationMembers::Table.into_iden();
        let conversations = || Conversations::Table.into_iden();
        let columns: [(DynIden, ColumnDef); 5] = [
            // 成员：是不是群管理员、群内昵称（空的是没有）、禁言到什么时候（UTC 毫秒，空的是没有禁言）
            (
                members(),
                ColumnDef::new(ConversationMembers::IsAdmin)
                    .boolean()
                    .not_null()
                    .default(false)
                    .to_owned(),
            ),
            (
                members(),
                ColumnDef::new(ConversationMembers::Nickname)
                    .string_len(64)
                    .to_owned(),
            ),
            (
                members(),
                ColumnDef::new(ConversationMembers::MutedUntil)
                    .big_integer()
                    .to_owned(),
            ),
            // 群：全员禁言、入群审批两个开关
            (
                conversations(),
                ColumnDef::new(Conversations::AllMuted)
                    .boolean()
                    .not_null()
                    .default(false)
                    .to_owned(),
            ),
            (
                conversations(),
                ColumnDef::new(Conversations::JoinApproval)
                    .boolean()
                    .not_null()
                    .default(false)
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

        // 入群申请。同一个群、同一个被邀请人只有一条待处理的：待处理时 `pending_key` 是
        // "群:被邀请人"，处理之后清空。空值不算重复，两种数据库上都一样
        manager
            .create_table(
                Table::create()
                    .table(JoinRequests::Table)
                    .col(
                        ColumnDef::new(JoinRequests::Id)
                            .string_len(36)
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::ConversationId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::InviterId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::InviteeId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::Status)
                            .string_len(16)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::PendingKey)
                            .string_len(80)
                            .unique_key(),
                    )
                    .col(
                        ColumnDef::new(JoinRequests::CreatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(JoinRequests::HandledBy).string_len(36))
                    .col(ColumnDef::new(JoinRequests::HandledAt).big_integer())
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_join_requests_conversation_id")
                    .table(JoinRequests::Table)
                    .col(JoinRequests::ConversationId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(JoinRequests::Table).to_owned())
            .await?;
        let columns: [(DynIden, DynIden); 5] = [
            (
                Conversations::Table.into_iden(),
                Conversations::JoinApproval.into_iden(),
            ),
            (
                Conversations::Table.into_iden(),
                Conversations::AllMuted.into_iden(),
            ),
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::MutedUntil.into_iden(),
            ),
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::Nickname.into_iden(),
            ),
            (
                ConversationMembers::Table.into_iden(),
                ConversationMembers::IsAdmin.into_iden(),
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
    AllMuted,
    JoinApproval,
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    IsAdmin,
    Nickname,
    MutedUntil,
}

#[derive(DeriveIden)]
enum JoinRequests {
    Table,
    Id,
    ConversationId,
    InviterId,
    InviteeId,
    Status,
    PendingKey,
    CreatedAt,
    HandledBy,
    HandledAt,
}
