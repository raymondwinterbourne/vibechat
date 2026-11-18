use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

/// 编号一律是应用生成的 UUID，存成 36 位的字符串。
fn id(column: impl IntoIden) -> ColumnDef {
    let mut def = ColumnDef::new(column);
    def.string_len(36);
    def
}

/// UTC 毫秒时间戳。
fn time(column: impl IntoIden) -> ColumnDef {
    let mut def = ColumnDef::new(column);
    def.big_integer();
    def
}

/// 会话内的序号。
fn seq(column: impl IntoIden) -> ColumnDef {
    let mut def = ColumnDef::new(column);
    def.big_integer();
    def
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Conversations::Table)
                    .col(id(Conversations::Id).not_null().primary_key())
                    .col(
                        ColumnDef::new(Conversations::Kind)
                            .string_len(16)
                            .not_null(),
                    )
                    // 单聊：两个人的内部编号排序后用冒号连起来。唯一，保证两个人之间只有一个单聊会话
                    .col(
                        ColumnDef::new(Conversations::DirectKey)
                            .string_len(73)
                            .unique_key(),
                    )
                    // 最新一条的序号。写入一条时在同一个事务里加一
                    .col(seq(Conversations::LastSeq).not_null())
                    .col(time(Conversations::CreatedAt).not_null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(ConversationMembers::Table)
                    .col(id(ConversationMembers::ConversationId).not_null())
                    .col(id(ConversationMembers::UserId).not_null())
                    .col(seq(ConversationMembers::JoinedSeq).not_null())
                    .col(seq(ConversationMembers::ReadSeq).not_null())
                    .col(seq(ConversationMembers::HiddenSeq))
                    .col(time(ConversationMembers::CreatedAt).not_null())
                    .primary_key(
                        Index::create()
                            .col(ConversationMembers::ConversationId)
                            .col(ConversationMembers::UserId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_members_conversation")
                            .from(
                                ConversationMembers::Table,
                                ConversationMembers::ConversationId,
                            )
                            .to(Conversations::Table, Conversations::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_conversation_members_user")
                            .from(ConversationMembers::Table, ConversationMembers::UserId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;
        // 取一个用户的会话列表
        manager
            .create_index(
                Index::create()
                    .name("idx_conversation_members_user")
                    .table(ConversationMembers::Table)
                    .col(ConversationMembers::UserId)
                    .to_owned(),
            )
            .await?;

        // 会话日志：消息和事件
        manager
            .create_table(
                Table::create()
                    .table(Messages::Table)
                    .col(id(Messages::Id).not_null().primary_key())
                    .col(id(Messages::ConversationId).not_null())
                    .col(seq(Messages::Seq).not_null())
                    // 事件没有发送人，也没有客户端消息编号
                    .col(id(Messages::SenderId))
                    .col(ColumnDef::new(Messages::ClientId).string_len(36))
                    .col(ColumnDef::new(Messages::Kind).string_len(16).not_null())
                    .col(ColumnDef::new(Messages::Text).text())
                    .col(time(Messages::CreatedAt).not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_messages_conversation")
                            .from(Messages::Table, Messages::ConversationId)
                            .to(Conversations::Table, Conversations::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_messages_sender")
                            .from(Messages::Table, Messages::SenderId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;
        // 顺序：一个会话里每个序号只有一条。按序号翻阅和补齐也用这个索引
        manager
            .create_index(
                Index::create()
                    .name("idx_messages_conversation_seq")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::Seq)
                    .unique()
                    .to_owned(),
            )
            .await?;
        // 去重：同一个人在同一个会话里，一个客户端消息编号只有一条
        manager
            .create_index(
                Index::create()
                    .name("idx_messages_client_id")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::SenderId)
                    .col(Messages::ClientId)
                    .unique()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            Messages::Table.into_iden(),
            ConversationMembers::Table.into_iden(),
            Conversations::Table.into_iden(),
        ] {
            manager
                .drop_table(Table::drop().table(table).to_owned())
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}

#[derive(DeriveIden)]
enum Conversations {
    Table,
    Id,
    Kind,
    DirectKey,
    LastSeq,
    CreatedAt,
}

#[derive(DeriveIden)]
enum ConversationMembers {
    Table,
    ConversationId,
    UserId,
    JoinedSeq,
    ReadSeq,
    HiddenSeq,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    Id,
    ConversationId,
    Seq,
    SenderId,
    ClientId,
    Kind,
    Text,
    CreatedAt,
}
