//! 数据存储的 SeaORM 实现。同一份代码运行在 SQLite 和 Postgres 上，由连接串决定用哪一种。

use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sea_orm::sea_query::LikeExpr;
use sea_orm::sqlx::sqlite::SqliteJournalMode;
use sea_orm::{ConnectOptions, Database, DatabaseConnection, DbErr};
use vibechat_core::{StoreError, Stores};
use vibechat_migration::{Migrator, MigratorTrait};

mod accounts;
mod admin;
mod chat;
mod contacts;
mod entities;
mod health;
mod settings;

/// 连接数据库，把表结构更新到最新，返回全部数据操作的入口。
pub async fn open(database_url: &str) -> Result<Stores, StoreError> {
    let db = connect(database_url).await?;
    Migrator::up(&db, None).await.map_err(unavailable)?;
    let accounts = Arc::new(accounts::DbAccounts::new(db.clone()));
    let admin = Arc::new(admin::DbAdmin::new(db.clone()));
    Ok(Stores {
        health: Arc::new(health::DbHealth::new(db.clone())),
        users: accounts.clone(),
        sessions: accounts.clone(),
        invite_codes: accounts.clone(),
        files: accounts,
        contacts: Arc::new(contacts::DbContacts::new(db.clone())),
        chat: Arc::new(chat::DbChat::new(db.clone())),
        audit: admin.clone(),
        tokens: admin,
        settings: Arc::new(settings::DbSettingsStore::new(db)),
    })
}

async fn connect(database_url: &str) -> Result<DatabaseConnection, StoreError> {
    ensure_sqlite_dir(database_url)?;
    let mut options = ConnectOptions::new(database_url.to_owned());
    options
        // 每条 SQL 都打日志太吵，请求日志已经足够定位问题
        .sqlx_logging(false)
        // 以下设置只对 SQLite 生效，并且对连接池里的每一条连接都生效
        .map_sqlx_sqlite_opts(|sqlite| {
            sqlite
                // 读写互不阻塞
                .journal_mode(SqliteJournalMode::Wal)
                .foreign_keys(true)
                // 写入撞上别的写入时等待，而不是立即报错
                .busy_timeout(Duration::from_secs(5))
        });
    Database::connect(options).await.map_err(unavailable)
}

/// SQLite 的数据库文件所在的目录还不存在时先建好：第一次启动不用自己去建。
/// `sqlite::memory:`、PostgreSQL 的地址不用管。
fn ensure_sqlite_dir(database_url: &str) -> Result<(), StoreError> {
    let Some(rest) = database_url.strip_prefix("sqlite://") else {
        return Ok(());
    };
    let path = rest.split('?').next().unwrap_or_default();
    let Some(dir) = std::path::Path::new(path).parent() else {
        return Ok(());
    };
    if dir.as_os_str().is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)
        .map_err(|err| StoreError::Unavailable(format!("cannot create {}: {err}", dir.display())))
}

fn unavailable(err: DbErr) -> StoreError {
    StoreError::Unavailable(err.to_string())
}

/// 数据库里的内容不符合预期（例如编号不是 UUID）。只可能是数据被外部改坏了。
fn corrupt(what: &str) -> StoreError {
    StoreError::Unavailable(format!("unexpected value in database: {what}"))
}

fn parse_id<T: FromStr>(text: &str, what: &str) -> Result<T, StoreError> {
    text.parse().map_err(|_| corrupt(what))
}

/// 把 `needle` 写成"包含它"的匹配模式：其中的 `%`、`_` 和转义符本身都按字面匹配。
/// 模式是小写的，要和转成小写的列去比。
fn contains_pattern(needle: &str) -> LikeExpr {
    let mut pattern = String::with_capacity(needle.len() + 2);
    pattern.push('%');
    for c in needle.to_lowercase().chars() {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    LikeExpr::new(pattern).escape('\\')
}

/// 当前时间，UTC 毫秒。所有表里的时间都用这种整数，不用数据库的时间类型。
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
