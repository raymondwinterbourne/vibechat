//! 管理：用户、系统设置、查看聊天内容、群、系统概况、操作记录，以及管理员找回密码。

pub mod error;
pub mod model;
pub mod service;
pub mod store;

pub use error::AdminError;
pub use model::{
    AdminToken, AuditAction, AuditDetail, AuditEntry, Overview, SettingKey, Settings,
    SettingsChange, TokenPurpose, UserRow,
};
pub use service::{
    AdminService, AdminServiceDeps, Cleaned, Paging, PasswordReset, ViewGrant, ViewStarted,
};

#[cfg(test)]
mod service_tests;
