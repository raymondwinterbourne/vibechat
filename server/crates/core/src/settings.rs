//! 系统设置：管理员可以在界面上调整的那些项目，以键值的形式保存。

use async_trait::async_trait;

use crate::store::StoreError;

#[async_trait]
pub trait SettingsStore: Send + Sync {
    /// 读取一项设置；没有设置过时返回 `None`。
    async fn get(&self, key: &str) -> Result<Option<String>, StoreError>;

    /// 写入一项设置，已存在则覆盖。
    async fn set(&self, key: &str, value: &str) -> Result<(), StoreError>;
}
