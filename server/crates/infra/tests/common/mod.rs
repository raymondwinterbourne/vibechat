//! 数据层测试的公共部分：为每个测试准备一个独立的空库，SQLite 和 Postgres 各一种。
//!
//! Postgres 的地址来自环境变量 `TEST_PG_URL`。没有设置时 Postgres 的测试会跳过；
//! 如果同时设置了 `REQUIRE_PG=1`（全量测试时），则当作失败，避免以为跑过了其实没跑。

use sea_orm::{ConnectionTrait, Database};
use tempfile::TempDir;
use vibechat_core::Stores;
use vibechat_infra::db;

/// 一个测试专用的数据库。`_dir` 只是为了让临时目录活到测试结束。
pub struct TestDb {
    pub stores: Stores,
    _dir: Option<TempDir>,
}

pub async fn sqlite() -> TestDb {
    let dir = tempfile::tempdir().expect("create temp dir");
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("test.db").display());
    let stores = db::open(&url).await.expect("open sqlite");
    TestDb {
        stores,
        _dir: Some(dir),
    }
}

pub async fn postgres() -> Option<TestDb> {
    let Ok(admin_url) = std::env::var("TEST_PG_URL") else {
        if std::env::var("REQUIRE_PG").is_ok_and(|v| v == "1") {
            panic!("REQUIRE_PG=1 but TEST_PG_URL is not set");
        }
        eprintln!("skipped: TEST_PG_URL is not set");
        return None;
    };

    // 每个测试新建一个库，互不影响。测试用的 Postgres 容器数据在内存里，跑完即销毁，不必清理
    let name = format!("vc_test_{}", uuid::Uuid::now_v7().simple());
    let admin = Database::connect(&admin_url)
        .await
        .expect("connect to TEST_PG_URL");
    admin
        .execute_unprepared(&format!("CREATE DATABASE \"{name}\""))
        .await
        .expect("create test database");

    let mut url = url::Url::parse(&admin_url).expect("TEST_PG_URL is a valid url");
    url.set_path(&name);
    let stores = db::open(url.as_str()).await.expect("open postgres");
    Some(TestDb { stores, _dir: None })
}

/// 把同一段测试在 SQLite 和 Postgres 上各跑一遍。
#[macro_export]
macro_rules! on_both_databases {
    ($name:ident, $test:expr) => {
        mod $name {
            use super::*;

            #[tokio::test]
            async fn sqlite() {
                let db = common::sqlite().await;
                $test(db.stores.clone()).await;
            }

            #[tokio::test]
            async fn postgres() {
                if let Some(db) = common::postgres().await {
                    $test(db.stores.clone()).await;
                }
            }
        }
    };
}
