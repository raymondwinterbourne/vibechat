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

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(FriendRequests::Table)
                    .col(id(FriendRequests::Id).not_null().primary_key())
                    .col(id(FriendRequests::FromUser).not_null())
                    .col(id(FriendRequests::ToUser).not_null())
                    .col(
                        ColumnDef::new(FriendRequests::Message)
                            .string_len(50)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(FriendRequests::Status)
                            .string_len(16)
                            .not_null(),
                    )
                    .col(time(FriendRequests::SentAt).not_null())
                    .col(time(FriendRequests::HandledAt))
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_friend_requests_from")
                            .from(FriendRequests::Table, FriendRequests::FromUser)
                            .to(Users::Table, Users::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_friend_requests_to")
                            .from(FriendRequests::Table, FriendRequests::ToUser)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;
        // 同一对"申请方、接收方"只有一行；这个索引同时用于按申请方查找
        manager
            .create_index(
                Index::create()
                    .name("idx_friend_requests_pair")
                    .table(FriendRequests::Table)
                    .col(FriendRequests::FromUser)
                    .col(FriendRequests::ToUser)
                    .unique()
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_friend_requests_to")
                    .table(FriendRequests::Table)
                    .col(FriendRequests::ToUser)
                    .to_owned(),
            )
            .await?;

        // 好友关系存两行，每个方向一行，各自保存自己给对方起的备注名
        manager
            .create_table(
                Table::create()
                    .table(Friendships::Table)
                    .col(id(Friendships::UserId).not_null())
                    .col(id(Friendships::FriendId).not_null())
                    .col(ColumnDef::new(Friendships::Remark).string_len(32))
                    .col(time(Friendships::CreatedAt).not_null())
                    .primary_key(
                        Index::create()
                            .col(Friendships::UserId)
                            .col(Friendships::FriendId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_friendships_user")
                            .from(Friendships::Table, Friendships::UserId)
                            .to(Users::Table, Users::Id),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_friendships_friend")
                            .from(Friendships::Table, Friendships::FriendId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            Friendships::Table.into_iden(),
            FriendRequests::Table.into_iden(),
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
enum FriendRequests {
    Table,
    Id,
    FromUser,
    ToUser,
    Message,
    Status,
    SentAt,
    HandledAt,
}

#[derive(DeriveIden)]
enum Friendships {
    Table,
    UserId,
    FriendId,
    Remark,
    CreatedAt,
}
