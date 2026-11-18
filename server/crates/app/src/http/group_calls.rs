//! 群通话的接口（F10，设计文档 3.7 节）：发起、再邀请、加入、不理会邀请、离开，
//! 以及"我所在的群里正在进行的通话"。
//!
//! 发起和加入都带着"在哪一台设备上"，和一对一通话一样；成功时交回入场凭证，
//! 页面凭它连到媒体转发服务。通话每一次变化都推给群里的全体成员。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use vibechat_core::account::model::User;
use vibechat_core::call::{DeviceId, Endpoint, GroupCall, GroupCallError};
use vibechat_core::chat::ChatError;
use vibechat_core::{CallId, UserId};
use vibechat_protocol::{
    ErrorCode, GroupCallDeviceRequest, GroupCallInviteRequest, GroupCallJoined, GroupCallList,
    GroupCallView, StartGroupCallRequest,
};

use super::auth::ActiveUser;
use super::json::ApiJson;
use crate::error::AppError;
use crate::group_calling;
use crate::state::AppState;

/// 一次最多邀请多少人。群本身没有这么多人，只是不让请求无限长。
const INVITE_MAX: usize = 100;

impl From<GroupCallError> for AppError {
    fn from(err: GroupCallError) -> Self {
        let code = match err {
            GroupCallError::NotFound => ErrorCode::CallNotFound,
            GroupCallError::AlreadyInCall => ErrorCode::AlreadyInCall,
            GroupCallError::AlreadyRunning(_) => ErrorCode::GroupCallRunning,
            GroupCallError::Full => ErrorCode::GroupCallFull,
            GroupCallError::NotInCall => ErrorCode::NotInGroupCall,
            GroupCallError::WrongDevice => ErrorCode::WrongCallDevice,
            GroupCallError::SomeoneSharing(_) => ErrorCode::GroupCallSharing,
        };
        Self::new(code, err.to_string())
    }
}

fn device(text: &str) -> Result<DeviceId, AppError> {
    DeviceId::parse(text).ok_or_else(|| {
        AppError::new(
            ErrorCode::BadRequest,
            "device must be 8 to 64 letters, digits, - or _",
        )
    })
}

/// 邀请的名单：只认群里现在的成员，别的（编号不像样的、不在群里的）不认。
fn invitees(ids: &[String], members: &[UserId]) -> Result<Vec<UserId>, AppError> {
    if ids.len() > INVITE_MAX {
        return Err(AppError::new(
            ErrorCode::BadRequest,
            "too many people to invite at once",
        ));
    }
    Ok(ids
        .iter()
        .filter_map(|id| id.parse::<UserId>().ok())
        .filter(|user| members.contains(user))
        .collect())
}

/// 这个通话，并且我是它那个群里的成员。交回群里现在的全体成员。
/// 通话不存在、已经结束、我不在那个群里，是同一种回答。
async fn call_in_my_group(
    state: &AppState,
    me: &User,
    id: &str,
) -> Result<(GroupCall, Vec<UserId>), AppError> {
    let not_found = || AppError::from(GroupCallError::NotFound);
    let id: CallId = id.parse().map_err(|_| not_found())?;
    let call = state.calls.group_call(id).ok_or_else(not_found)?;
    match state.chat.group_call_members(me, call.conversation).await {
        Ok(members) => Ok((call, members)),
        Err(
            ChatError::ConversationNotFound
            | ChatError::NotMember
            | ChatError::LeftGroup
            | ChatError::GroupDissolved,
        ) => Err(not_found()),
        Err(err) => Err(err.into()),
    }
}

/// 在这台设备上发起群通话，邀请名单里的人。我自己马上就在通话里。
pub async fn start(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<StartGroupCallRequest>,
) -> Result<(StatusCode, Json<GroupCallJoined>), AppError> {
    let me = &context.user;
    let starter = Endpoint {
        user: me.id,
        device: device(&request.device)?,
    };
    let conversation = request
        .conversation_id
        .parse()
        .map_err(|_| ChatError::ConversationNotFound)?;
    let members = state.chat.group_call_members(me, conversation).await?;
    group_calling::require_media(&state)?;
    let invite = invitees(&request.invite, &members)?;
    let call = state
        .calls
        .start_group(starter, conversation, request.video, &invite)?;
    let ticket = group_calling::ticket(&state, &call, me.id)?;
    let view = group_calling::announce(&state, &call).await;
    Ok((
        StatusCode::CREATED,
        Json(GroupCallJoined { call: view, ticket }),
    ))
}

/// 我所在的群里正在进行的通话。
pub async fn list(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<GroupCallList>, AppError> {
    let limit = state.chat.group_call_max().await?;
    let mut calls: Vec<GroupCallView> = Vec::new();
    for call in state.calls.group_calls() {
        let mine = state
            .chat
            .group_call_members(&context.user, call.conversation)
            .await
            .is_ok();
        if mine {
            calls.push(group_calling::view(&call, limit));
        }
    }
    calls.sort_by_key(|call| call.started_at);
    Ok(Json(GroupCallList { calls }))
}

/// 在这台设备上加入。被没被邀请都可以。
pub async fn join(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<GroupCallDeviceRequest>,
) -> Result<Json<GroupCallJoined>, AppError> {
    let me = &context.user;
    let endpoint = Endpoint {
        user: me.id,
        device: device(&request.device)?,
    };
    let (call, _) = call_in_my_group(&state, me, &id).await?;
    group_calling::require_media(&state)?;
    let limit = state.chat.group_call_max().await?;
    let call = state.calls.join_group(endpoint, call.id, limit as usize)?;
    let ticket = group_calling::ticket(&state, &call, me.id)?;
    let view = group_calling::announce(&state, &call).await;
    Ok(Json(GroupCallJoined { call: view, ticket }))
}

/// 通话里的人再邀请几个人：他们的设备响铃一次。
pub async fn invite(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<GroupCallInviteRequest>,
) -> Result<Json<GroupCallView>, AppError> {
    let me = &context.user;
    let (call, members) = call_in_my_group(&state, me, &id).await?;
    let invite = invitees(&request.user_ids, &members)?;
    let call = state.calls.invite_to_group(me.id, call.id, &invite)?;
    Ok(Json(group_calling::announce(&state, &call).await))
}

/// 不理会邀请：我的设备都不再响。之后仍然可以加入。
pub async fn decline(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<GroupCallView>, AppError> {
    let me = &context.user;
    let (call, _) = call_in_my_group(&state, me, &id).await?;
    let call = state.calls.decline_group(me.id, call.id)?;
    Ok(Json(group_calling::announce(&state, &call).await))
}

/// 离开。最后一个人离开时通话结束。
///
/// 已经不在群里的人（刚被移出）也可以调：这时通话里已经没有他了，回答是"不在这个通话里"。
pub async fn leave(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<GroupCallDeviceRequest>,
) -> Result<Json<GroupCallView>, AppError> {
    let me = &context.user;
    let endpoint = Endpoint {
        user: me.id,
        device: device(&request.device)?,
    };
    let id: CallId = id.parse().map_err(|_| GroupCallError::NotFound)?;
    let call = state.calls.leave_group(&endpoint, id)?;
    group_calling::show_out(&state, &call, &[me.id]).await;
    Ok(Json(group_calling::announce(&state, &call).await))
}

/// 我在这台设备上开始共享屏幕（F12）。同一时间只有一个人共享；已经有别人在共享时不行。
/// 页面先问到这里，成了再去拿屏幕、往外发。
pub async fn share(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<GroupCallDeviceRequest>,
) -> Result<Json<GroupCallView>, AppError> {
    let endpoint = Endpoint {
        user: context.user.id,
        device: device(&request.device)?,
    };
    let id: CallId = id.parse().map_err(|_| GroupCallError::NotFound)?;
    let call = state.calls.share_group_screen(&endpoint, id)?;
    Ok(Json(group_calling::announce(&state, &call).await))
}

/// 我停止共享屏幕。不是我在共享时什么都不变。
pub async fn unshare(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<GroupCallDeviceRequest>,
) -> Result<Json<GroupCallView>, AppError> {
    let endpoint = Endpoint {
        user: context.user.id,
        device: device(&request.device)?,
    };
    let id: CallId = id.parse().map_err(|_| GroupCallError::NotFound)?;
    let (call, changed) = state.calls.stop_group_screen(&endpoint, id)?;
    if changed {
        return Ok(Json(group_calling::announce(&state, &call).await));
    }
    let limit = state.chat.group_call_max().await?;
    Ok(Json(group_calling::view(&call, limit)))
}
