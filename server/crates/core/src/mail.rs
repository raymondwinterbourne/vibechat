//! 发邮件的抽象。配置了邮件服务时通过它发；没有配置时写成文件，开发和测试时从那里看。

use async_trait::async_trait;

use crate::store::StoreError;

/// 一封纯文字的邮件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mail {
    pub to: String,
    pub subject: String,
    pub body: String,
}

#[async_trait]
pub trait Mailer: Send + Sync {
    async fn send(&self, mail: &Mail) -> Result<(), StoreError>;
}
