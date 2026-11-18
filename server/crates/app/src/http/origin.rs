//! 来源校验：会改变数据的请求必须来自本系统的页面。
//!
//! 浏览器会自动带上登录的 Cookie，所以别的网站可以诱导已登录的用户向本系统发请求。
//! 这种请求里的来源是那个网站，在这里拦下。

use axum::extract::{Request, State};
use axum::http::{Method, header};
use axum::middleware::Next;
use axum::response::Response;
use vibechat_protocol::ErrorCode;

use super::auth::uses_bearer_token;
use crate::error::AppError;
use crate::state::AppState;

pub async fn require_same_origin(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let safe = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    // 用请求头里的令牌表明身份的客户端不是浏览器，不存在被别的网站借用 Cookie 的问题
    if !safe && !uses_bearer_token(request.headers()) {
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok());
        let expected = state.config.public_origin();
        if origin != Some(expected.as_str()) {
            tracing::warn!(?origin, expected, "request rejected: origin not allowed");
            return Err(AppError::new(ErrorCode::Forbidden, "origin not allowed"));
        }
    }
    Ok(next.run(request).await)
}
