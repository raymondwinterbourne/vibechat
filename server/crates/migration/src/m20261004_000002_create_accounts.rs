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
                    .table(Users::Table)
                    .col(id(Users::Id).not_null().primary_key())
                    // 用户看得见的 ID，保留用户输入的大小写
                    .col(ColumnDef::new(Users::Handle).string_len(20).not_null())
                    // 小写形式，用于查找和保证不区分大小写的唯一
                    .col(
                        ColumnDef::new(Users::HandleLower)
                            .string_len(20)
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(Users::Nickname).string_len(32).not_null())
                    .col(ColumnDef::new(Users::Signature).string_len(100).not_null())
                    .col(id(Users::AvatarFileId))
                    .col(ColumnDef::new(Users::PasswordHash).text().not_null())
                    .col(ColumnDef::new(Users::Role).string_len(16).not_null())
                    .col(ColumnDef::new(Users::Status).string_len(16).not_null())
                    .col(
                        ColumnDef::new(Users::MustChangePassword)
                            .boolean()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Users::Email).string_len(254))
                    .col(id(Users::InviteCodeId))
                    .col(ColumnDef::new(Users::Language).string_len(8))
                    .col(ColumnDef::new(Users::Theme).string_len(8))
                    .col(time(Users::CreatedAt).not_null())
                    .col(time(Users::LastLoginAt))
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Sessions::Table)
                    .col(id(Sessions::Id).not_null().primary_key())
                    .col(id(Sessions::UserId).not_null())
                    .col(
                        ColumnDef::new(Sessions::TokenHash)
                            .string_len(64)
                            .not_null()
                            .unique_key(),
                    )
                    .col(time(Sessions::CreatedAt).not_null())
                    .col(time(Sessions::LastSeenAt).not_null())
                    .col(time(Sessions::ExpiresAt).not_null())
                    .col(
                        ColumnDef::new(Sessions::UserAgent)
                            .string_len(255)
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_sessions_user")
                            .from(Sessions::Table, Sessions::UserId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_sessions_user")
                    .table(Sessions::Table)
                    .col(Sessions::UserId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(InviteCodes::Table)
                    .col(id(InviteCodes::Id).not_null().primary_key())
                    .col(
                        ColumnDef::new(InviteCodes::Code)
                            .string_len(16)
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(InviteCodes::Note).string_len(200))
                    .col(
                        ColumnDef::new(InviteCodes::Status)
                            .string_len(16)
                            .not_null(),
                    )
                    .col(time(InviteCodes::ExpiresAt))
                    .col(id(InviteCodes::CreatedBy).not_null())
                    .col(time(InviteCodes::CreatedAt).not_null())
                    .col(id(InviteCodes::UsedBy))
                    .col(time(InviteCodes::UsedAt))
                    .to_owned(),
            )
            .await?;

        manager
            .create_table(
                Table::create()
                    .table(Files::Table)
                    .col(id(Files::Id).not_null().primary_key())
                    .col(ColumnDef::new(Files::StorageKey).string_len(255).not_null())
                    .col(
                        ColumnDef::new(Files::ContentType)
                            .string_len(100)
                            .not_null(),
                    )
                    .col(ColumnDef::new(Files::Size).big_integer().not_null())
                    .col(id(Files::UploaderId).not_null())
                    .col(ColumnDef::new(Files::Purpose).string_len(16).not_null())
                    .col(ColumnDef::new(Files::Width).integer())
                    .col(ColumnDef::new(Files::Height).integer())
                    .col(time(Files::CreatedAt).not_null())
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for table in [
            Files::Table.into_iden(),
            InviteCodes::Table.into_iden(),
            Sessions::Table.into_iden(),
            Users::Table.into_iden(),
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
    Handle,
    HandleLower,
    Nickname,
    Signature,
    AvatarFileId,
    PasswordHash,
    Role,
    Status,
    MustChangePassword,
    Email,
    InviteCodeId,
    Language,
    Theme,
    CreatedAt,
    LastLoginAt,
}

#[derive(DeriveIden)]
enum Sessions {
    Table,
    Id,
    UserId,
    TokenHash,
    CreatedAt,
    LastSeenAt,
    ExpiresAt,
    UserAgent,
}

#[derive(DeriveIden)]
enum InviteCodes {
    Table,
    Id,
    Code,
    Note,
    Status,
    ExpiresAt,
    CreatedBy,
    CreatedAt,
    UsedBy,
    UsedAt,
}

#[derive(DeriveIden)]
enum Files {
    Table,
    Id,
    StorageKey,
    ContentType,
    Size,
    UploaderId,
    Purpose,
    Width,
    Height,
    CreatedAt,
}
