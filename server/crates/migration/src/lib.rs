//! 数据库迁移。迁移脚本对 SQLite 和 Postgres 通用：只用 SeaORM 的迁移接口描述表结构，
//! 不手写某一种数据库的 SQL。
//!
//! 迁移只增不改：已经发布的迁移不再修改，表结构的变化写成新的迁移。

pub use sea_orm_migration::prelude::*;

mod m20261004_000001_create_settings;
mod m20261004_000002_create_accounts;
mod m20261004_000003_create_contacts;
mod m20261004_000004_create_chat;
mod m20261004_000005_add_groups;
mod m20261004_000006_add_rich_messages;
mod m20261004_000007_add_mute;
mod m20261004_000008_add_admin;
mod m20261014_000009_add_group_notice;
mod m20261014_000010_add_message_files;
mod m20261014_000011_add_group_management;
mod m20261022_000012_add_pinned;
mod m20261022_000013_add_deleted_messages;
mod m20261023_000014_add_edited_at;
mod m20261023_000015_add_session_ip;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20261004_000001_create_settings::Migration),
            Box::new(m20261004_000002_create_accounts::Migration),
            Box::new(m20261004_000003_create_contacts::Migration),
            Box::new(m20261004_000004_create_chat::Migration),
            Box::new(m20261004_000005_add_groups::Migration),
            Box::new(m20261004_000006_add_rich_messages::Migration),
            Box::new(m20261004_000007_add_mute::Migration),
            Box::new(m20261004_000008_add_admin::Migration),
            Box::new(m20261014_000009_add_group_notice::Migration),
            Box::new(m20261014_000010_add_message_files::Migration),
            Box::new(m20261014_000011_add_group_management::Migration),
            Box::new(m20261022_000012_add_pinned::Migration),
            Box::new(m20261022_000013_add_deleted_messages::Migration),
            Box::new(m20261023_000014_add_edited_at::Migration),
            Box::new(m20261023_000015_add_session_ip::Migration),
        ]
    }
}
