//! HTTP 层的基础：健康检查、统一的错误结构、请求编号、来源校验。

mod common;

use std::sync::atomic::Ordering;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::routing::get;
use tower::ServiceExt;
use vibechat_protocol::{ErrorCode, HealthResponse, HealthStatus};
use vibechat_server::http::with_middleware;

#[tokio::test]
async fn health_is_ok_when_the_database_answers() {
    let app = common::app().await;
    let reply = app.client().get("/api/health").await;

    assert_eq!(reply.status, StatusCode::OK);
    let health: HealthResponse = reply.json();
    assert_eq!(health.status, HealthStatus::Ok);
    assert!(health.database);
    assert_eq!(health.version, env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn health_is_unhealthy_when_the_database_is_down() {
    let app = common::app().await;
    app.store.healthy.store(false, Ordering::Relaxed);
    let reply = app.client().get("/api/health").await;

    assert_eq!(reply.status, StatusCode::SERVICE_UNAVAILABLE);
    let health: HealthResponse = reply.json();
    assert_eq!(health.status, HealthStatus::Degraded);
    assert!(!health.database);
}

#[tokio::test]
async fn unknown_path_returns_the_unified_error() {
    let app = common::app().await;
    let reply = app.client().get("/api/no-such-thing").await;

    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.error().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn wrong_method_returns_the_unified_error() {
    let app = common::app().await;
    let reply = app.client().post_empty("/api/health").await;

    assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(reply.error().code, ErrorCode::MethodNotAllowed);
}

#[tokio::test]
async fn a_body_that_is_not_valid_json_returns_the_unified_error() {
    let app = common::app().await;
    let mut client = app.client();
    let reply = client
        .send(
            Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header("content-type", "application/json"),
            Body::from("{not json"),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.error().code, ErrorCode::BadRequest);

    // 缺少必填字段也一样
    let reply = client
        .post("/api/auth/login", serde_json::json!({ "handle": "x" }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn panic_in_a_handler_returns_the_unified_error() {
    async fn boom() -> &'static str {
        panic!("deliberate panic in a test handler")
    }
    let router = with_middleware(Router::new().route("/boom", get(boom)));
    let response = router
        .oneshot(Request::builder().uri("/boom").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let error: vibechat_protocol::ErrorResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(error.code, ErrorCode::Internal);
}

#[tokio::test]
async fn every_response_carries_a_request_id() {
    let app = common::app().await;
    let mut client = app.client();
    let ok = client.get("/api/health").await;
    let error = client.get("/api/no-such-thing").await;

    let first = ok
        .headers
        .get("x-request-id")
        .expect("request id on success");
    let second = error
        .headers
        .get("x-request-id")
        .expect("request id on error");
    assert_ne!(first, second);
}

#[tokio::test]
async fn request_id_from_the_caller_is_kept() {
    let app = common::app().await;
    let reply = app
        .client()
        .send(
            Request::builder()
                .uri("/api/health")
                .header("x-request-id", "from-the-proxy"),
            Body::empty(),
        )
        .await;
    assert_eq!(reply.headers["x-request-id"], "from-the-proxy");
}

// ---------- 来源校验 ----------

#[tokio::test]
async fn a_change_from_another_site_is_rejected_even_with_a_valid_login() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;

    client.origin = Some("http://evil.example");
    let reply = client
        .patch("/api/me", serde_json::json!({ "nickname": "被改了" }))
        .await;
    assert_eq!(reply.status, StatusCode::FORBIDDEN);
    assert_eq!(reply.error().code, ErrorCode::Forbidden);

    client.origin = None;
    let reply = client
        .patch("/api/me", serde_json::json!({ "nickname": "被改了" }))
        .await;
    assert_eq!(
        reply.status,
        StatusCode::FORBIDDEN,
        "a missing origin is not trusted either"
    );

    client.origin = Some(common::ORIGIN);
    let me: vibechat_protocol::Me = client.get("/api/me").await.json();
    assert_eq!(me.nickname, "小明");
}

#[tokio::test]
async fn reading_does_not_require_an_origin() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;
    client.origin = None;
    assert_eq!(client.get("/api/me").await.status, StatusCode::OK);
}

#[tokio::test]
async fn a_client_using_a_bearer_token_needs_no_origin() {
    let app = common::app().await;
    let (logged_in, _) = app.user("小明").await;
    let token = logged_in.token().to_owned();

    let mut client = app.client();
    client.origin = None;
    let reply = client
        .send(
            Request::builder()
                .method(Method::PATCH)
                .uri("/api/me")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json"),
            Body::from(r#"{"nickname":"明明"}"#),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json::<vibechat_protocol::Me>().nickname, "明明");
}
