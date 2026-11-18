use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use vibechat_protocol::{HealthResponse, HealthStatus};

use crate::state::AppState;

/// 健康检查。数据库不可用时返回 503，供 Docker 和反向代理判断服务是否正常。
pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<HealthResponse>) {
    let database = match state.stores.health.ping().await {
        Ok(()) => true,
        Err(err) => {
            tracing::warn!("health check: {err}");
            false
        }
    };
    let (code, status) = if database {
        (StatusCode::OK, HealthStatus::Ok)
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, HealthStatus::Degraded)
    };
    let body = HealthResponse {
        status,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        database,
    };
    (code, Json(body))
}
