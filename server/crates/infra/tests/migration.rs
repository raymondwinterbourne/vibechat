//! 迁移机制：空库自动建表；重复打开同一个库不会重复执行。

use vibechat_infra::db;

#[tokio::test]
async fn opening_twice_keeps_data_and_does_not_fail() {
    let dir = tempfile::tempdir().unwrap();
    let url = format!("sqlite://{}?mode=rwc", dir.path().join("test.db").display());

    let first = db::open(&url).await.unwrap();
    first.settings.set("k", "v").await.unwrap();
    drop(first);

    // 第二次打开：迁移已经执行过，应当直接跳过，之前写入的数据还在
    let second = db::open(&url).await.unwrap();
    assert_eq!(
        second.settings.get("k").await.unwrap().as_deref(),
        Some("v")
    );
}
