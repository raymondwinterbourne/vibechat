use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HealthStatus {
    Ok,
    /// 服务端在运行，但有依赖不可用。
    Degraded,
}

/// `GET /api/health` 的响应。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct HealthResponse {
    pub status: HealthStatus,
    pub version: String,
    /// 数据库是否可用。
    pub database: bool,
}
