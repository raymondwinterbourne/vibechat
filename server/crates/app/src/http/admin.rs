//! 管理接口。路径都在 `/api/admin/` 下，都要求管理员身份。
//!
//! 会改动数据或者读到聊天内容的操作，都由管理服务先写下操作记录再执行。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use vibechat_core::account::service::INVITE_CODES_PAGE_SIZE;
use vibechat_core::account::{
    InviteCodeListing, InviteCodeOrder as Order, InviteCodeState, NewInviteCodes, User,
    UserStatus as Status,
};
use vibechat_core::admin::model::{SettingsChange, UserRow};
use vibechat_core::admin::service::{
    CAMERA_RELAY_KBPS_RANGE, EDIT_WINDOW_SECONDS_RANGE, FILE_MAX_BYTES_RANGE,
    GROUP_CAMERA_HIGH_KBPS_RANGE, GROUP_CAMERA_LOW_KBPS_RANGE, GROUP_MAX_MEMBERS_RANGE,
    GROUP_SCREEN_KBPS_RANGE, PAGE_SIZE, RECALL_WINDOW_SECONDS_RANGE, RETENTION_DAYS_RANGE,
    SCREEN_DIRECT_KBPS_RANGE, SCREEN_MAX_FPS_RANGE, SCREEN_MAX_WIDTH_RANGE,
    SCREEN_RELAY_KBPS_RANGE, VOICE_MAX_SECONDS_RANGE,
};
use vibechat_core::admin::{AdminError, Paging, Settings};
use vibechat_core::chat::HistoryQuery;
use vibechat_core::chat::service::GROUP_MAX_MEMBERS_DEFAULT;
use vibechat_core::contact::UserCard;
use vibechat_core::limits::{
    CAMERA_RELAY_KBPS_DEFAULT, EDIT_WINDOW_SECONDS_DEFAULT, FILE_MAX_BYTES_DEFAULT,
    GROUP_CALL_MAX_DEFAULT, GROUP_CALL_MAX_RANGE, GROUP_CAMERA_HIGH_KBPS_DEFAULT,
    GROUP_CAMERA_LOW_KBPS_DEFAULT, GROUP_SCREEN_KBPS_DEFAULT, RECALL_WINDOW_SECONDS_DEFAULT,
    SCREEN_DIRECT_KBPS_DEFAULT, SCREEN_MAX_FPS_DEFAULT, SCREEN_MAX_WIDTH_DEFAULT,
    SCREEN_RELAY_KBPS_DEFAULT, VOICE_MAX_SECONDS_DEFAULT,
};
use vibechat_core::{ConversationId, InviteCodeId, UserId};
use vibechat_protocol::{
    AdminConversationList, AdminConversationView, AdminGroupPage, AdminMemberList, AdminUserPage,
    AdminUserView, AuditAction, AuditPage, CreateInviteCodesRequest, DeleteInviteCodesResponse,
    ErrorCode, InviteCodeIds, InviteCodeList, InviteCodeOrder, InviteCodePage, InviteCodeStatus,
    InviteCodeView, MessageList, OverviewView, ResetPasswordResponse, RevokeInviteCodesResponse,
    SettingRange, SettingsView, UpdateSettingsRequest, UserStatus, ViewStarted,
};

use super::auth::Admin;
use super::chat::announce_message;
use super::files::{self, ReadParams};
use super::json::{ApiJson, ApiQuery};
use super::views;
use crate::error::AppError;
use crate::state::AppState;

fn count(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

// 编号格式不对和对象不存在是同一种回答
fn user_id(text: &str) -> Result<UserId, AdminError> {
    text.parse().map_err(|_| AdminError::UserNotFound)
}

fn conversation_id(text: &str) -> Result<ConversationId, AdminError> {
    text.parse().map_err(|_| AdminError::ConversationNotFound)
}

// ---------- 邀请码 ----------

pub async fn create_invite_codes(
    State(state): State<AppState>,
    Admin(context): Admin,
    ApiJson(request): ApiJson<CreateInviteCodesRequest>,
) -> Result<(StatusCode, Json<InviteCodeList>), AppError> {
    let now = state.accounts.now_ms();
    let created = state
        .admin
        .create_invite_codes(
            &context.user,
            NewInviteCodes {
                count: request.count,
                note: request.note.as_deref(),
                expires_in_days: request.expires_in_days,
            },
        )
        .await?;
    let items = created
        .iter()
        .map(|invite| views::invite_code(invite, None, now))
        .collect();
    Ok((StatusCode::CREATED, Json(InviteCodeList { items })))
}

/// 邀请码列表的参数，写在地址里：`?page=2&page_size=20&status=unused&order=oldest`。
/// 都可以不写：第一页，每页 20 个，不筛选，最新的在前。
#[derive(Debug, Deserialize)]
pub struct InviteCodesQuery {
    page: Option<u32>,
    page_size: Option<u32>,
    status: Option<InviteCodeStatus>,
    order: Option<InviteCodeOrder>,
}

pub async fn list_invite_codes(
    State(state): State<AppState>,
    Admin(_): Admin,
    ApiQuery(query): ApiQuery<InviteCodesQuery>,
) -> Result<Json<InviteCodePage>, AppError> {
    let now = state.accounts.now_ms();
    let page = state
        .accounts
        .list_invite_codes(InviteCodeListing {
            page: query.page.unwrap_or(1),
            page_size: query.page_size.unwrap_or(INVITE_CODES_PAGE_SIZE),
            state: query.status.map(|status| match status {
                InviteCodeStatus::Unused => InviteCodeState::Unused,
                InviteCodeStatus::Used => InviteCodeState::Used,
                InviteCodeStatus::Expired => InviteCodeState::Expired,
                InviteCodeStatus::Revoked => InviteCodeState::Revoked,
            }),
            order: match query.order {
                Some(InviteCodeOrder::Oldest) => Order::OldestFirst,
                Some(InviteCodeOrder::Newest) | None => Order::NewestFirst,
            },
        })
        .await?;
    let items = page
        .entries
        .iter()
        .map(|(invite, used_by)| views::invite_code(invite, used_by.as_ref(), now))
        .collect();
    Ok(Json(InviteCodePage {
        items,
        total: count(page.total),
    }))
}

pub async fn revoke_invite_code(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<Json<InviteCodeView>, AppError> {
    // 编号格式不对和邀请码不存在是同一种回答
    let id: InviteCodeId = id
        .parse()
        .map_err(|_| AppError::new(ErrorCode::NotFound, "no such invite code"))?;
    let invite = state.admin.revoke_invite_code(&context.user, id).await?;
    Ok(Json(views::invite_code(
        &invite,
        None,
        state.accounts.now_ms(),
    )))
}

pub async fn revoke_invite_codes(
    State(state): State<AppState>,
    Admin(context): Admin,
    ApiJson(request): ApiJson<InviteCodeIds>,
) -> Result<Json<RevokeInviteCodesResponse>, AppError> {
    let revoked = state
        .admin
        .revoke_invite_codes(&context.user, &parse_ids(&request))
        .await?;
    Ok(Json(RevokeInviteCodesResponse {
        revoked: count(revoked),
    }))
}

pub async fn delete_invite_codes(
    State(state): State<AppState>,
    Admin(context): Admin,
    ApiJson(request): ApiJson<InviteCodeIds>,
) -> Result<Json<DeleteInviteCodesResponse>, AppError> {
    let deleted = state
        .admin
        .delete_invite_codes(&context.user, &parse_ids(&request))
        .await?;
    Ok(Json(DeleteInviteCodesResponse {
        deleted: count(deleted),
    }))
}

/// 格式不对的编号和不存在的邀请码一样，跳过。
fn parse_ids(request: &InviteCodeIds) -> Vec<InviteCodeId> {
    request
        .ids
        .iter()
        .filter_map(|id| id.parse().ok())
        .collect()
}

// ---------- 用户 ----------

/// 用户列表的参数：`?search=ming&status=disabled&page=2&page_size=20`。都可以不写。
#[derive(Debug, Deserialize)]
pub struct UsersQuery {
    search: Option<String>,
    status: Option<UserStatus>,
    page: Option<u32>,
    page_size: Option<u32>,
}

fn paging(page: Option<u32>, page_size: Option<u32>) -> Paging {
    Paging {
        page: page.unwrap_or(1),
        page_size: page_size.unwrap_or(PAGE_SIZE),
    }
}

pub async fn list_users(
    State(state): State<AppState>,
    Admin(_): Admin,
    ApiQuery(query): ApiQuery<UsersQuery>,
) -> Result<Json<AdminUserPage>, AppError> {
    let status = query.status.map(|status| match status {
        UserStatus::Active => Status::Active,
        UserStatus::Disabled => Status::Disabled,
    });
    let (rows, total) = state
        .admin
        .list_users(
            query.search.as_deref(),
            status,
            paging(query.page, query.page_size),
        )
        .await?;
    Ok(Json(AdminUserPage {
        items: rows.iter().map(views::admin_user).collect(),
        total: count(total),
    }))
}

/// 禁用、启用之后的那个用户。所用的邀请码不在这里重复给：列表里已经有了。
fn changed_user(user: User) -> AdminUserView {
    views::admin_user(&UserRow {
        user,
        invite_code: None,
    })
}

pub async fn disable_user(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<Json<AdminUserView>, AppError> {
    let (user, sessions) = state
        .admin
        .disable_user(&context.user, user_id(&id)?)
        .await?;
    // 他的登录已经失效，已经建立的连接也一并断开：页面会发现并回到登录页
    crate::group_calling::sessions_ending(&state, &sessions).await;
    state.hub.kick_sessions(&sessions);
    Ok(Json(changed_user(user)))
}

pub async fn enable_user(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<Json<AdminUserView>, AppError> {
    let user = state
        .admin
        .enable_user(&context.user, user_id(&id)?)
        .await?;
    Ok(Json(changed_user(user)))
}

pub async fn reset_password(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<Json<ResetPasswordResponse>, AppError> {
    let reset = state
        .admin
        .reset_password(&context.user, user_id(&id)?)
        .await?;
    crate::group_calling::sessions_ending(&state, &reset.sessions).await;
    state.hub.kick_sessions(&reset.sessions);
    Ok(Json(ResetPasswordResponse {
        user: changed_user(reset.user),
        password: reset.password,
    }))
}

// ---------- 系统设置和概况 ----------

fn settings_view(settings: &Settings) -> SettingsView {
    let range = |(min, max): (u32, u32), default: Option<u32>| SettingRange {
        min: u64::from(min),
        max: u64::from(max),
        default: default.map(u64::from),
    };
    SettingsView {
        file_max_bytes: settings.file_max_bytes,
        group_max_members: settings.group_max_members,
        voice_max_seconds: settings.voice_max_seconds,
        recall_window_seconds: settings.recall_window_seconds,
        edit_window_seconds: settings.edit_window_seconds,
        retention_days: settings.retention_days,
        screen_max_width: settings.call_video.screen_max_width,
        screen_max_fps: settings.call_video.screen_max_fps,
        screen_direct_kbps: settings.call_video.screen_direct_kbps,
        screen_relay_kbps: settings.call_video.screen_relay_kbps,
        camera_relay_kbps: settings.call_video.camera_relay_kbps,
        group_camera_high_kbps: settings.call_video.group_camera_high_kbps,
        group_camera_low_kbps: settings.call_video.group_camera_low_kbps,
        group_screen_kbps: settings.call_video.group_screen_kbps,
        group_call_max: settings.group_call_max,
        file_max_bytes_range: SettingRange {
            min: FILE_MAX_BYTES_RANGE.0,
            max: FILE_MAX_BYTES_RANGE.1,
            default: Some(FILE_MAX_BYTES_DEFAULT),
        },
        group_max_members_range: range(GROUP_MAX_MEMBERS_RANGE, Some(GROUP_MAX_MEMBERS_DEFAULT)),
        voice_max_seconds_range: range(VOICE_MAX_SECONDS_RANGE, Some(VOICE_MAX_SECONDS_DEFAULT)),
        recall_window_seconds_range: range(
            RECALL_WINDOW_SECONDS_RANGE,
            Some(RECALL_WINDOW_SECONDS_DEFAULT),
        ),
        edit_window_seconds_range: range(
            EDIT_WINDOW_SECONDS_RANGE,
            Some(EDIT_WINDOW_SECONDS_DEFAULT),
        ),
        retention_days_range: range(RETENTION_DAYS_RANGE, None),
        screen_max_width_range: range(SCREEN_MAX_WIDTH_RANGE, Some(SCREEN_MAX_WIDTH_DEFAULT)),
        screen_max_fps_range: range(SCREEN_MAX_FPS_RANGE, Some(SCREEN_MAX_FPS_DEFAULT)),
        screen_direct_kbps_range: range(SCREEN_DIRECT_KBPS_RANGE, Some(SCREEN_DIRECT_KBPS_DEFAULT)),
        screen_relay_kbps_range: range(SCREEN_RELAY_KBPS_RANGE, Some(SCREEN_RELAY_KBPS_DEFAULT)),
        camera_relay_kbps_range: range(CAMERA_RELAY_KBPS_RANGE, Some(CAMERA_RELAY_KBPS_DEFAULT)),
        group_camera_high_kbps_range: range(
            GROUP_CAMERA_HIGH_KBPS_RANGE,
            Some(GROUP_CAMERA_HIGH_KBPS_DEFAULT),
        ),
        group_camera_low_kbps_range: range(
            GROUP_CAMERA_LOW_KBPS_RANGE,
            Some(GROUP_CAMERA_LOW_KBPS_DEFAULT),
        ),
        group_screen_kbps_range: range(GROUP_SCREEN_KBPS_RANGE, Some(GROUP_SCREEN_KBPS_DEFAULT)),
        group_call_max_range: range(GROUP_CALL_MAX_RANGE, Some(GROUP_CALL_MAX_DEFAULT)),
    }
}

pub async fn settings(
    State(state): State<AppState>,
    Admin(_): Admin,
) -> Result<Json<SettingsView>, AppError> {
    Ok(Json(settings_view(&state.admin.settings().await?)))
}

pub async fn update_settings(
    State(state): State<AppState>,
    Admin(context): Admin,
    ApiJson(request): ApiJson<UpdateSettingsRequest>,
) -> Result<Json<SettingsView>, AppError> {
    let change = SettingsChange {
        file_max_bytes: request.file_max_bytes,
        group_max_members: request.group_max_members,
        voice_max_seconds: request.voice_max_seconds,
        recall_window_seconds: request.recall_window_seconds,
        edit_window_seconds: request.edit_window_seconds,
        // 0 表示永久保留
        retention_days: request
            .retention_days
            .map(|days| Some(days).filter(|d| *d > 0)),
        group_call_max: request.group_call_max,
        screen_max_width: request.screen_max_width,
        screen_max_fps: request.screen_max_fps,
        screen_direct_kbps: request.screen_direct_kbps,
        screen_relay_kbps: request.screen_relay_kbps,
        camera_relay_kbps: request.camera_relay_kbps,
        group_camera_high_kbps: request.group_camera_high_kbps,
        group_camera_low_kbps: request.group_camera_low_kbps,
        group_screen_kbps: request.group_screen_kbps,
    };
    let updated = state.admin.update_settings(&context.user, change).await?;
    Ok(Json(settings_view(&updated)))
}

pub async fn overview(
    State(state): State<AppState>,
    Admin(_): Admin,
) -> Result<Json<OverviewView>, AppError> {
    let online = state.hub.online_users().len() as u64;
    let overview = state.admin.overview(online).await?;
    Ok(Json(OverviewView {
        users_total: count(overview.users_total),
        users_disabled: count(overview.users_disabled),
        online: count(overview.online),
        groups: count(overview.groups),
        files_count: count(overview.files_count),
        files_bytes: overview.files_bytes,
    }))
}

// ---------- 操作记录 ----------

/// 操作记录的参数：`?action=chat_viewed&page=2&page_size=20`。都可以不写。
#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    action: Option<AuditAction>,
    page: Option<u32>,
    page_size: Option<u32>,
}

pub async fn audit_log(
    State(state): State<AppState>,
    Admin(_): Admin,
    ApiQuery(query): ApiQuery<AuditQuery>,
) -> Result<Json<AuditPage>, AppError> {
    let (entries, total) = state
        .admin
        .audit_log(
            query.action.map(views::audit_action),
            paging(query.page, query.page_size),
        )
        .await?;
    Ok(Json(AuditPage {
        items: entries.iter().map(views::audit_entry).collect(),
        total: count(total),
    }))
}

// ---------- 聊天内容和群 ----------

/// 一个用户参与的全部会话。只是找会话，看不到内容。
pub async fn user_conversations(
    State(state): State<AppState>,
    Admin(_): Admin,
    Path(id): Path<String>,
) -> Result<Json<AdminConversationList>, AppError> {
    let (user, conversations) = state.admin.conversations_of(user_id(&id)?).await?;
    Ok(Json(AdminConversationList {
        user: views::user_card(&UserCard::from(&user)),
        items: conversations.iter().map(views::overseen).collect(),
    }))
}

/// 群列表的参数：`?search=项目&page=2&page_size=20`。都可以不写。
#[derive(Debug, Deserialize)]
pub struct GroupsQuery {
    search: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
}

pub async fn groups(
    State(state): State<AppState>,
    Admin(_): Admin,
    ApiQuery(query): ApiQuery<GroupsQuery>,
) -> Result<Json<AdminGroupPage>, AppError> {
    let (groups, total) = state
        .admin
        .groups(query.search.as_deref(), paging(query.page, query.page_size))
        .await?;
    Ok(Json(AdminGroupPage {
        items: groups.iter().map(views::overseen).collect(),
        total: count(total),
    }))
}

pub async fn members(
    State(state): State<AppState>,
    Admin(_): Admin,
    Path(id): Path<String>,
) -> Result<Json<AdminMemberList>, AppError> {
    let (conversation, members) = state.admin.members(conversation_id(&id)?).await?;
    Ok(Json(AdminMemberList {
        conversation: views::overseen(&conversation),
        items: members.iter().map(views::overseen_member).collect(),
    }))
}

/// 开始查看一个会话的内容：写下操作记录，换来一个查看凭据。
pub async fn start_view(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<ViewStarted>), AppError> {
    let started = state
        .admin
        .start_view(&context, conversation_id(&id)?)
        .await?;
    let reply = ViewStarted {
        view: started.grant.token,
        expires_at: started.grant.expires_at,
        conversation: views::overseen(&started.conversation),
        members: started.members.iter().map(views::overseen_member).collect(),
    };
    Ok((StatusCode::CREATED, Json(reply)))
}

/// 查看中取消息的参数：查看凭据，加上和普通翻历史一样的 `before`、`after`、`limit`。
#[derive(Debug, Deserialize)]
pub struct ViewMessagesQuery {
    view: Option<String>,
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u32>,
}

/// 查看中的会话里的一段消息。已撤回的带着原内容，并标明已撤回。
pub async fn view_messages(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<ViewMessagesQuery>,
) -> Result<Json<MessageList>, AppError> {
    let history = HistoryQuery {
        before: query.before,
        after: query.after,
        limit: query.limit,
    };
    let token = query.view.as_deref().unwrap_or_default();
    let page = state
        .admin
        .view_messages(&context, conversation_id(&id)?, token, history)
        .await?;
    let items = page
        .messages
        .iter()
        .map(|message| {
            let sender_name = message
                .sender
                .and_then(|sender| page.sender_names.get(&sender))
                .cloned();
            views::revealed_message(message, sender_name, &page.extras)
        })
        .collect();
    Ok(Json(MessageList {
        items,
        has_more: page.has_more,
    }))
}

/// 查看中取文件的参数：查看凭据，加上和普通读文件一样的 `download`。
#[derive(Debug, Deserialize)]
pub struct ViewFileQuery {
    view: Option<String>,
    download: Option<String>,
}

/// 查看中的会话里的一个文件。凭据写在地址里：图片和语音是页面直接去取的，带不了别的东西。
pub async fn view_file(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path((id, file)): Path<(String, String)>,
    ApiQuery(query): ApiQuery<ViewFileQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = viewed_file(&state, &context, &id, &file, query.view.as_deref()).await?;
    let params = ReadParams {
        download: query.download,
    };
    files::serve(&state, &file, params.download.is_some(), &headers).await
}

pub async fn view_thumbnail(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path((id, file)): Path<(String, String)>,
    ApiQuery(query): ApiQuery<ViewFileQuery>,
) -> Result<Response, AppError> {
    let file = viewed_file(&state, &context, &id, &file, query.view.as_deref()).await?;
    files::serve_thumbnail(&state, &file).await
}

async fn viewed_file(
    state: &AppState,
    context: &vibechat_core::account::AuthContext,
    conversation: &str,
    file: &str,
    token: Option<&str>,
) -> Result<vibechat_core::account::StoredFile, AppError> {
    // 会话的编号格式不对，和没有这个文件是同一种回答
    let conversation = conversation
        .parse()
        .map_err(|_| vibechat_core::file::FileError::NotFound)?;
    let file = files::file_id(file)?;
    let token = token.unwrap_or_default();
    Ok(state
        .admin
        .view_file(context, conversation, token, file)
        .await?)
}

/// 管理员解散一个群。成员实时看到"群已被管理员解散"。
pub async fn dissolve_group(
    State(state): State<AppState>,
    Admin(context): Admin,
    Path(id): Path<String>,
) -> Result<Json<AdminConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state
        .admin
        .dissolve_group(&context.user, conversation)
        .await?;
    announce_message(&state, &posted);
    // 群里正在进行的通话随之结束（F10）
    crate::group_calling::group_dissolved(&state, conversation).await;
    let (overseen, _) = state.admin.members(conversation).await?;
    Ok(Json(views::overseen(&overseen)))
}
