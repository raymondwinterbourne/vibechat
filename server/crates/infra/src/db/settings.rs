use async_trait::async_trait;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ActiveValue::Set, DatabaseConnection, EntityTrait};
use vibechat_core::StoreError;
use vibechat_core::settings::SettingsStore;

use super::entities::settings;
use super::{now_ms, unavailable};

pub struct DbSettingsStore {
    db: DatabaseConnection,
}

impl DbSettingsStore {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}

#[async_trait]
impl SettingsStore for DbSettingsStore {
    async fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let row = settings::Entity::find_by_id(key.to_owned())
            .one(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(row.map(|row| row.value))
    }

    async fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let row = settings::ActiveModel {
            key: Set(key.to_owned()),
            value: Set(value.to_owned()),
            updated_at: Set(now_ms()),
        };
        settings::Entity::insert(row)
            .on_conflict(
                OnConflict::column(settings::Column::Key)
                    .update_columns([settings::Column::Value, settings::Column::UpdatedAt])
                    .to_owned(),
            )
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }
}
