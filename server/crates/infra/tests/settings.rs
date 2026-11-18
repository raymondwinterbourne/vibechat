mod common;

use vibechat_core::Stores;

async fn missing_key_reads_as_none(stores: Stores) {
    assert_eq!(stores.settings.get("no_such_key").await.unwrap(), None);
}

async fn written_value_can_be_read_back(stores: Stores) {
    stores
        .settings
        .set("max_file_size", "1048576")
        .await
        .unwrap();
    assert_eq!(
        stores
            .settings
            .get("max_file_size")
            .await
            .unwrap()
            .as_deref(),
        Some("1048576")
    );
}

async fn writing_again_overwrites(stores: Stores) {
    stores.settings.set("group_limit", "10").await.unwrap();
    stores.settings.set("group_limit", "20").await.unwrap();
    assert_eq!(
        stores.settings.get("group_limit").await.unwrap().as_deref(),
        Some("20")
    );
}

async fn keys_are_independent(stores: Stores) {
    stores.settings.set("a", "1").await.unwrap();
    stores.settings.set("b", "2").await.unwrap();
    assert_eq!(
        stores.settings.get("a").await.unwrap().as_deref(),
        Some("1")
    );
    assert_eq!(
        stores.settings.get("b").await.unwrap().as_deref(),
        Some("2")
    );
}

async fn database_answers_ping(stores: Stores) {
    stores.health.ping().await.unwrap();
}

on_both_databases!(missing_key, missing_key_reads_as_none);
on_both_databases!(read_back, written_value_can_be_read_back);
on_both_databases!(overwrite, writing_again_overwrites);
on_both_databases!(independent_keys, keys_are_independent);
on_both_databases!(ping, database_answers_ping);
