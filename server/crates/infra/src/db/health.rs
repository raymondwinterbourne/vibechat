use async_trait::async_trait;
use sea_orm::DatabaseConnection;
use vibechat_core::{StoreError, StoreHealth};

use super::unavailable;

pub struct DbHealth {
    db: DatabaseConnection,
}

impl DbHealth {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}

#[async_trait]
impl StoreHealth for DbHealth {
    async fn ping(&self) -> Result<(), StoreError> {
        self.db.ping().await.map_err(unavailable)
    }
}
