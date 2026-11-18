//! 注册、登录、退出，以及当前用户对自己资料的修改。

use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use vibechat_core::account::model::User;
use vibechat_core::account::{AccountError, LoginOutcome, ProfileChanges, Registration};
use vibechat_protocol::{
    ChangeEmailRequest, ChangeHandleRequest, ChangePasswordRequest, EmailConfirmRequest,
    EmailConfirmed, ErrorCode, LoginRequest, Me, PasswordResetConfirm, PasswordResetRequest,
    RegisterRequest, ServerEvent, SessionList, SessionView, SignedOutOthers, UpdateProfileRequest,
};

use super::auth::{ActiveUser, Admin, Auth, clear_session_cookie, session_cookie};
use super::client::ClientInfo;
use super::json::ApiJson;
use super::views;
use crate::error::AppError;
use crate::state::AppState;

/// 登录成功的响应：用户资料，加上保存会话令牌的 Cookie。
fn logged_in(state: &AppState, status: StatusCode, outcome: &LoginOutcome) -> Response {
    let cookie = session_cookie(&outcome.token, state.config.secure_cookies());
    (
        status,
        [(header::SET_COOKIE, cookie)],
        Json(views::me(&outcome.user)),
    )
        .into_response()
}

/// 把最新的资料推给这个用户的全部连接，他在别处打开的页面随之更新。
fn announce(state: &AppState, user: &User) -> Json<Me> {
    let me = views::me(user);
    state
        .hub
        .push(&[user.id], &ServerEvent::MeUpdated(me.clone()));
    Json(me)
}

/// 好友看得到的资料（昵称、头像、个性签名、ID）变了：除了自己，也推给全部好友。
async fn announce_to_friends(state: &AppState, user: &User) -> Json<Me> {
    match state.contacts.friend_ids(user.id).await {
        Ok(friends) => {
            let event = ServerEvent::ContactProfile(views::friend_profile(user));
            state.hub.push(&friends, &event);
        }
        // 修改本身已经成功。好友下次打开通讯录时会取到新的资料
        Err(err) => tracing::warn!("could not tell friends about a profile change: {err}"),
    }
    announce(state, user)
}

pub async fn register(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(request): ApiJson<RegisterRequest>,
) -> Result<Response, AppError> {
    let outcome = state
        .accounts
        .register(Registration {
            invite_code: &request.invite_code,
            nickname: &request.nickname,
            password: &request.password,
            user_agent: &client.user_agent,
            source: &client.ip,
        })
        .await?;
    Ok(logged_in(&state, StatusCode::CREATED, &outcome))
}

pub async fn login(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(request): ApiJson<LoginRequest>,
) -> Result<Response, AppError> {
    let outcome = state
        .accounts
        .login(
            &request.handle,
            &request.password,
            &client.user_agent,
            &client.ip,
        )
        .await?;
    Ok(logged_in(&state, StatusCode::OK, &outcome))
}

pub async fn logout(State(state): State<AppState>, auth: Auth) -> Result<Response, AppError> {
    let session = auth.context.session.id;
    state.accounts.logout(session).await?;
    crate::group_calling::sessions_ending(&state, &[session]).await;
    state.hub.kick_sessions(&[session]);
    let cookie = clear_session_cookie(state.config.secure_cookies());
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}

/// 我的登录设备（F9）。
pub async fn sessions(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<SessionList>, AppError> {
    let online = state.hub.online_sessions(context.user.id);
    let items = state
        .accounts
        .sessions(&context)
        .await?
        .into_iter()
        .map(|session| SessionView {
            id: session.id.to_string(),
            user_agent: session.user_agent,
            ip: session.ip,
            created_at: session.created_at,
            last_seen_at: session.last_seen_at,
            current: session.id == context.session.id,
            online: online.contains(&session.id),
        })
        .collect();
    Ok(Json(SessionList { items }))
}

/// 让我的另一台设备下线（F9）：先告诉它的页面原因，再断开。
pub async fn sign_out_session(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let id = id.parse().map_err(|_| AccountError::NotFound)?;
    state.accounts.sign_out_session(&context, id).await?;
    crate::group_calling::sessions_ending(&state, &[id]).await;
    state.hub.sign_out_sessions(&[id]);
    Ok(StatusCode::NO_CONTENT)
}

/// 让除本机以外的全部设备下线（F9）。
pub async fn sign_out_others(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<SignedOutOthers>, AppError> {
    let ended = state.accounts.sign_out_others(&context).await?;
    crate::group_calling::sessions_ending(&state, &ended).await;
    state.hub.sign_out_sessions(&ended);
    Ok(Json(SignedOutOthers {
        count: ended.len() as u32,
    }))
}

pub async fn me(State(state): State<AppState>, auth: Auth) -> Response {
    let body = Json(views::me(&auth.context.user));
    if auth.from_cookie {
        // 页面每次打开都会调用这个接口，借此让 Cookie 的有效期也顺延
        let cookie = session_cookie(&auth.token, state.config.secure_cookies());
        ([(header::SET_COOKIE, cookie)], body).into_response()
    } else {
        body.into_response()
    }
}

pub async fn update_profile(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<UpdateProfileRequest>,
) -> Result<Json<Me>, AppError> {
    // 语言和外观只和自己有关
    let seen_by_friends = request.nickname.is_some() || request.signature.is_some();
    let changes = ProfileChanges {
        nickname: request.nickname,
        signature: request.signature,
        language: request.language.map(views::language),
        theme: request.theme.map(views::theme),
    };
    let user = state.accounts.update_profile(&context, changes).await?;
    Ok(if seen_by_friends {
        announce_to_friends(&state, &user).await
    } else {
        announce(&state, &user)
    })
}

pub async fn change_handle(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<ChangeHandleRequest>,
) -> Result<Json<Me>, AppError> {
    let user = state
        .accounts
        .change_handle(&context, &request.handle)
        .await?;
    Ok(announce_to_friends(&state, &user).await)
}

/// 修改密码。处于"必须修改密码"状态的用户也可以调用，所以用 `Auth` 而不是 `ActiveUser`。
pub async fn change_password(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(request): ApiJson<ChangePasswordRequest>,
) -> Result<StatusCode, AppError> {
    let ended = state
        .accounts
        .change_password(
            &auth.context,
            &request.current_password,
            &request.new_password,
        )
        .await?;
    // 这个账号在其他地方的登录已经失效，它们的连接也一并断开
    crate::group_calling::sessions_ending(&state, &ended).await;
    state.hub.kick_sessions(&ended);
    Ok(StatusCode::NO_CONTENT)
}

/// 管理员请求找回密码。不管邮箱对不对，回答都一样。
pub async fn request_password_reset(
    State(state): State<AppState>,
    client: ClientInfo,
    ApiJson(request): ApiJson<PasswordResetRequest>,
) -> Result<StatusCode, AppError> {
    state
        .admin
        .request_password_reset(&request.email, &client.ip)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 凭邮件里的链接设一个新密码。成功后管理员的全部登录失效，要用新密码重新登录。
pub async fn confirm_password_reset(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<PasswordResetConfirm>,
) -> Result<StatusCode, AppError> {
    let ended = state
        .admin
        .reset_password_with_token(&request.token, &request.new_password)
        .await?;
    crate::group_calling::sessions_ending(&state, &ended).await;
    state.hub.kick_sessions(&ended);
    Ok(StatusCode::NO_CONTENT)
}

/// 管理员修改绑定的邮箱：向新邮箱发一封确认邮件，点了里面的链接才生效。
pub async fn change_email(
    State(state): State<AppState>,
    Admin(context): Admin,
    ApiJson(request): ApiJson<ChangeEmailRequest>,
) -> Result<StatusCode, AppError> {
    state
        .admin
        .request_email_change(&context.user, &request.current_password, &request.email)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 凭确认邮件里的链接让新邮箱生效。链接本身就是凭据，不要求登录。
pub async fn confirm_email(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<EmailConfirmRequest>,
) -> Result<Json<EmailConfirmed>, AppError> {
    let user = state.admin.confirm_email(&request.token).await?;
    // 管理员开着的页面上，设置里的邮箱跟着变
    let event = ServerEvent::MeUpdated(views::me(&user));
    state.hub.push(&[user.id], &event);
    Ok(Json(EmailConfirmed {
        email: user.email.unwrap_or_default(),
    }))
}

pub async fn set_avatar(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<Me>, AppError> {
    let content = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::new(ErrorCode::PayloadTooLarge, "file is too large")
        } else {
            AppError::new(ErrorCode::BadRequest, rejection.body_text())
        }
    })?;
    let user = state.accounts.set_avatar(&context, &content).await?;
    Ok(announce_to_friends(&state, &user).await)
}
