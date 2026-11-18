use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 操作记录：管理员做过的每一件事。只追加，不修改也不删除
        manager
            .create_table(
                Table::create()
                    .table(AuditLogs::Table)
                    .col(
                        ColumnDef::new(AuditLogs::Id)
                            .string_len(36)
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(AuditLogs::At).big_integer().not_null())
                    .col(ColumnDef::new(AuditLogs::ActorId).string_len(36).not_null())
                    .col(ColumnDef::new(AuditLogs::Action).string_len(40).not_null())
                    // 操作的对象：用户或会话的编号。没有具体对象的操作为空
                    .col(ColumnDef::new(AuditLogs::Target).string_len(36))
                    // 其余的参数，JSON
                    .col(ColumnDef::new(AuditLogs::Detail).text())
                    .to_owned(),
            )
            .await?;
        // 从新到旧翻页
        manager
            .create_index(
                Index::create()
                    .name("idx_audit_logs_at")
                    .table(AuditLogs::Table)
                    .col(AuditLogs::At)
                    .to_owned(),
            )
            .await?;
        // 只看某一种操作
        manager
            .create_index(
                Index::create()
                    .name("idx_audit_logs_action_at")
                    .table(AuditLogs::Table)
                    .col(AuditLogs::Action)
                    .col(AuditLogs::At)
                    .to_owned(),
            )
            .await?;

        // 发到管理员邮箱里的链接所带的一次性令牌。只保存哈希
        manager
            .create_table(
                Table::create()
                    .table(AdminTokens::Table)
                    .col(
                        ColumnDef::new(AdminTokens::TokenHash)
                            .string_len(64)
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(AdminTokens::UserId)
                            .string_len(36)
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(AdminTokens::Purpose)
                            .string_len(20)
                            .not_null(),
                    )
                    // 确认邮箱时：要改成的新邮箱
                    .col(ColumnDef::new(AdminTokens::Email).string_len(254))
                    .col(
                        ColumnDef::new(AdminTokens::ExpiresAt)
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(AdminTokens::UsedAt).big_integer())
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_admin_tokens_user")
                            .from(AdminTokens::Table, AdminTokens::UserId)
                            .to(Users::Table, Users::Id),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(AdminTokens::Table).to_owned())
            .await?;
        manager
            .drop_table(Table::drop().table(AuditLogs::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
enum AuditLogs {
    Table,
    Id,
    At,
    ActorId,
    Action,
    Target,
    Detail,
}

#[derive(DeriveIden)]
enum AdminTokens {
    Table,
    TokenHash,
    UserId,
    Purpose,
    Email,
    ExpiresAt,
    UsedAt,
}

#[derive(DeriveIden)]
enum Users {
    Table,
    Id,
}
