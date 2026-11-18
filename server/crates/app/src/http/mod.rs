//! HTTP 路由和所有请求都经过的中间层。

use std::any::Any;
use std::time::Duration;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request};
use axum::http::HeaderName;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use tower::ServiceBuilder;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;
use tracing::{Instrument, Span};
use vibechat_core::account::service::AVATAR_MAX_BYTES;
use vibechat_protocol::ErrorCode;

use crate::error::AppError;
use crate::state::AppState;
use crate::ws;

mod account;
mod admin;
pub mod auth;
mod calls;
pub(crate) mod chat;
pub mod client;
mod contacts;
mod desktop;
mod files;
mod group_calls;
mod health;
mod json;
mod origin;
pub(crate) mod views;

const REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");

pub fn router(state: AppState) -> Router {
    let routes = Router::new()
        .route("/api/health", get(health::health))
        .route("/api/auth/register", post(account::register))
        .route("/api/auth/login", post(account::login))
        .route("/api/auth/logout", post(account::logout))
        .route(
            "/api/auth/password-reset",
            post(account::request_password_reset),
        )
        .route(
            "/api/auth/password-reset/confirm",
            post(account::confirm_password_reset),
        )
        .route("/api/auth/email-confirm", post(account::confirm_email))
        .route("/api/me/email", put(account::change_email))
        .route("/api/me", get(account::me).patch(account::update_profile))
        .route("/api/me/handle", put(account::change_handle))
        .route("/api/me/password", put(account::change_password))
        .route("/api/me/sessions", get(account::sessions))
        .route(
            "/api/me/sessions/sign-out-others",
            post(account::sign_out_others),
        )
        .route("/api/me/sessions/{id}", delete(account::sign_out_session))
        .route(
            "/api/me/avatar",
            put(account::set_avatar).layer(DefaultBodyLimit::max(AVATAR_MAX_BYTES)),
        )
        // 上传的内容边收边写，大小在读的过程中按系统设置里的上限检查，不用这里的固定上限
        .route(
            "/api/files",
            post(files::upload).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/files/{id}", get(files::read))
        .route("/api/files/{id}/thumbnail", get(files::thumbnail))
        .route("/api/desktop/latest", get(desktop::latest))
        .route("/api/calls", post(calls::start))
        .route("/api/calls/current", get(calls::current))
        .route("/api/calls/ice-servers", get(calls::ice_servers))
        .route("/api/calls/group-check", post(calls::group_check))
        .route("/api/calls/{id}/accept", post(calls::accept))
        .route("/api/calls/{id}/reject", post(calls::reject))
        .route("/api/calls/{id}/hangup", post(calls::hangup))
        .route("/api/calls/{id}/signal", post(calls::signal))
        .route(
            "/api/group-calls",
            get(group_calls::list).post(group_calls::start),
        )
        .route("/api/group-calls/{id}/join", post(group_calls::join))
        .route("/api/group-calls/{id}/invite", post(group_calls::invite))
        .route("/api/group-calls/{id}/decline", post(group_calls::decline))
        .route("/api/group-calls/{id}/leave", post(group_calls::leave))
        .route("/api/group-calls/{id}/share", post(group_calls::share))
        .route("/api/group-calls/{id}/unshare", post(group_calls::unshare))
        .route("/api/desktop/download", get(desktop::download))
        .route("/api/limits", get(chat::limits))
        .route("/api/search", get(chat::search))
        .route("/api/users/lookup", get(contacts::lookup))
        .route(
            "/api/friend-requests",
            get(contacts::list_requests).post(contacts::send_request),
        )
        .route(
            "/api/friend-requests/{id}/accept",
            post(contacts::accept_request),
        )
        .route(
            "/api/friend-requests/{id}/reject",
            post(contacts::reject_request),
        )
        .route("/api/conversations", get(chat::list))
        .route("/api/conversations/direct", post(chat::open_direct))
        .route("/api/conversations/group", post(chat::create_group))
        .route("/api/groups", get(chat::groups))
        .route(
            "/api/conversations/{id}",
            get(chat::show).patch(chat::rename_group),
        )
        .route(
            "/api/conversations/{id}/avatar",
            put(chat::set_group_avatar).layer(DefaultBodyLimit::max(AVATAR_MAX_BYTES)),
        )
        .route(
            "/api/conversations/{id}/members",
            get(chat::members).post(chat::invite_members),
        )
        .route(
            "/api/conversations/{id}/members/{user}",
            get(chat::member_profile).delete(chat::remove_member),
        )
        .route("/api/conversations/{id}/leave", post(chat::leave_group))
        .route("/api/conversations/{id}/owner", put(chat::transfer_owner))
        .route(
            "/api/conversations/{id}/admins/{user}",
            put(chat::add_admin).delete(chat::remove_admin),
        )
        .route(
            "/api/conversations/{id}/muted-members/{user}",
            put(chat::mute_member).delete(chat::unmute_member),
        )
        .route(
            "/api/conversations/{id}/join-approval",
            put(chat::set_join_approval),
        )
        .route(
            "/api/conversations/{id}/join-requests",
            get(chat::join_requests),
        )
        .route(
            "/api/conversations/{id}/join-requests/{request}/approve",
            post(chat::approve_join_request),
        )
        .route(
            "/api/conversations/{id}/join-requests/{request}/reject",
            post(chat::reject_join_request),
        )
        .route(
            "/api/conversations/{id}/nickname",
            put(chat::set_group_nickname),
        )
        .route(
            "/api/conversations/{id}/all-muted",
            put(chat::set_all_muted),
        )
        .route(
            "/api/conversations/{id}/dissolve",
            post(chat::dissolve_group),
        )
        .route(
            "/api/conversations/{id}/messages",
            get(chat::history).post(chat::send),
        )
        .route(
            "/api/conversations/{id}/messages/{seq}",
            put(chat::edit_message),
        )
        .route(
            "/api/conversations/{id}/messages/{seq}/recall",
            post(chat::recall),
        )
        .route(
            "/api/conversations/{id}/messages/{seq}/played",
            post(chat::mark_played),
        )
        .route(
            "/api/conversations/{id}/search",
            get(chat::search_conversation),
        )
        .route("/api/conversations/{id}/read", post(chat::mark_read))
        .route("/api/conversations/{id}/hide", post(chat::hide))
        .route("/api/conversations/{id}/mute", put(chat::mute))
        .route("/api/conversations/{id}/pin", put(chat::pin))
        .route("/api/conversations/{id}/media", get(chat::media))
        .route(
            "/api/conversations/{id}/messages/delete",
            post(chat::delete_for_me),
        )
        .route("/api/conversations/{id}/clear", post(chat::clear_for_me))
        .route("/api/conversations/{id}/notice", put(chat::set_notice))
        .route(
            "/api/conversations/{id}/notice/seen",
            post(chat::notice_seen),
        )
        .route("/api/friends", get(contacts::list_friends))
        .route(
            "/api/friends/{id}",
            get(contacts::friend)
                .patch(contacts::set_remark)
                .delete(contacts::remove_friend),
        )
        .route(
            "/api/admin/invite-codes",
            get(admin::list_invite_codes).post(admin::create_invite_codes),
        )
        .route(
            "/api/admin/invite-codes/revoke",
            post(admin::revoke_invite_codes),
        )
        .route(
            "/api/admin/invite-codes/delete",
            post(admin::delete_invite_codes),
        )
        .route(
            "/api/admin/invite-codes/{id}/revoke",
            post(admin::revoke_invite_code),
        )
        .route("/api/admin/overview", get(admin::overview))
        .route("/api/admin/users", get(admin::list_users))
        .route("/api/admin/users/{id}/disable", post(admin::disable_user))
        .route("/api/admin/users/{id}/enable", post(admin::enable_user))
        .route(
            "/api/admin/users/{id}/reset-password",
            post(admin::reset_password),
        )
        .route(
            "/api/admin/users/{id}/conversations",
            get(admin::user_conversations),
        )
        .route("/api/admin/groups", get(admin::groups))
        .route("/api/admin/conversations/{id}/members", get(admin::members))
        // 查看聊天内容的这一组只有"开始一次查看"和"读"：没有发送、修改、删除、撤回
        .route(
            "/api/admin/conversations/{id}/views",
            post(admin::start_view),
        )
        .route(
            "/api/admin/conversations/{id}/messages",
            get(admin::view_messages),
        )
        .route(
            "/api/admin/conversations/{id}/files/{file}",
            get(admin::view_file),
        )
        .route(
            "/api/admin/conversations/{id}/files/{file}/thumbnail",
            get(admin::view_thumbnail),
        )
        .route(
            "/api/admin/conversations/{id}/dissolve",
            post(admin::dissolve_group),
        )
        .route(
            "/api/admin/settings",
            get(admin::settings).put(admin::update_settings),
        )
        .route("/api/admin/audit", get(admin::audit_log))
        .route("/ws", get(ws::handler))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            origin::require_same_origin,
        ))
        .with_state(state);
    with_middleware(routes)
}

/// 给路由加上所有请求共用的处理：统一的 404 和 405、请求编号、请求日志、兜住处理函数里的 panic、
/// 开始处理了的请求一定做完。
pub fn with_middleware(routes: Router) -> Router {
    routes
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(
            ServiceBuilder::new()
                // 每个请求一个编号，写进日志，也带回给调用方
                .layer(SetRequestIdLayer::new(REQUEST_ID, MakeRequestUuid))
                .layer(
                    TraceLayer::new_for_http()
                        .make_span_with(request_span)
                        .on_response(log_response),
                )
                .layer(PropagateRequestIdLayer::new(REQUEST_ID))
                .layer(CatchPanicLayer::custom(handle_panic))
                .layer(middleware::from_fn(run_to_completion)),
        )
}

/// 请求一旦开始处理就做完，调用方中途断开了也一样。
///
/// 不这样的话，调用方一断开，处理到一半的请求就被扔掉：状态改了，后面的事没做。例如页面刷新时
/// 发出的"离开通话"，人已经从通话里拿掉了，推送却没发出去，别人那里他一直"还在"。
async fn run_to_completion(request: Request, next: Next) -> Response {
    let handling = tokio::spawn(next.run(request).instrument(Span::current()));
    match handling.await {
        Ok(response) => response,
        // 处理函数 panic 了：交给外面一层，照常回答"内部错误"
        Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
        // 只有服务正在停下时才会被取消
        Err(_) => AppError::new(ErrorCode::Unavailable, "the server is stopping").into_response(),
    }
}

async fn not_found() -> AppError {
    AppError::new(ErrorCode::NotFound, "no such path")
}

async fn method_not_allowed() -> AppError {
    AppError::new(
        ErrorCode::MethodNotAllowed,
        "method not allowed on this path",
    )
}

fn handle_panic(_panic: Box<dyn Any + Send + 'static>) -> Response {
    // panic 的内容已经由默认的 panic hook 打到标准错误
    AppError::new(ErrorCode::Internal, "internal error").into_response()
}

fn request_span(request: &Request) -> Span {
    let request_id = request
        .headers()
        .get(&REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("-");
    tracing::info_span!(
        "request",
        %request_id,
        method = %request.method(),
        path = %request.uri().path(),
    )
}

fn log_response<B>(response: &axum::http::Response<B>, latency: Duration, _span: &Span) {
    tracing::info!(
        status = response.status().as_u16(),
        latency_ms = latency.as_millis() as u64,
        "finished"
    );
}
