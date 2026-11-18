//! 通话（F3，设计文档 3.7 节）：发起、接听、拒绝、挂断，转发建立连接用的信息，
//! 以及浏览器建立音频连接用的中转服务和临时账号。
//!
//! 每个操作都带着"在哪一台设备上"：设备是页面自己生成的编号，和它连 WebSocket 时带的是同一个。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use vibechat_core::CallId;
use vibechat_core::call::{
    CallError, DeviceId, Endpoint, Hangup, Rejection, TicketSources, room_ticket, turn_credential,
};
use vibechat_core::chat::ChatError;
use vibechat_protocol::{
    CallDeviceRequest, CallSignal, CallSignalRequest, CallVideoView, CallView, CurrentCall,
    ErrorCode, GroupCheckRequest, HangupReason, IceServerView, IceServers, RejectCallRequest,
    RejectReason, RoomTicketView, ServerEvent, StartCallRequest,
};

use super::auth::ActiveUser;
use super::json::ApiJson;
use crate::calling;
use crate::error::AppError;
use crate::state::AppState;

/// 一段连接信息最多这么长。WebRTC 的 offer、answer 一般只有几 KB。
const SIGNAL_MAX_CHARS: usize = 64 * 1024;

/// 验证页面（`/group-call-check`）用的房间。真正的群通话各有各的房间，不用这个名字。
const CHECK_ROOM: &str = "check";

impl From<CallError> for AppError {
    fn from(err: CallError) -> Self {
        let code = match err {
            CallError::NotFound => ErrorCode::CallNotFound,
            CallError::AlreadyInCall => ErrorCode::AlreadyInCall,
            CallError::NotRinging => ErrorCode::CallNotRinging,
            CallError::NotAnswered => ErrorCode::CallNotAnswered,
            CallError::WrongDevice => ErrorCode::WrongCallDevice,
        };
        Self::new(code, err.to_string())
    }
}

fn call_id(text: &str) -> Result<CallId, AppError> {
    // 编号格式不对和通话不存在是同一种回答
    text.parse().map_err(|_| CallError::NotFound.into())
}

fn device(text: &str) -> Result<DeviceId, AppError> {
    DeviceId::parse(text).ok_or_else(|| {
        AppError::new(
            ErrorCode::BadRequest,
            "device must be 8 to 64 letters, digits, - or _",
        )
    })
}

/// 在这台设备上给单聊里的好友打电话。对方忙、对方不在线时，交回的通话已经结束了。
pub async fn start(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<StartCallRequest>,
) -> Result<(StatusCode, Json<CallView>), AppError> {
    let me = &context.user;
    let conversation = request
        .conversation_id
        .parse()
        .map_err(|_| ChatError::ConversationNotFound)?;
    let caller = Endpoint {
        user: me.id,
        device: device(&request.device)?,
    };
    let callee = state.chat.call_peer(me, conversation).await?;
    let online = state.hub.can_ring(callee);
    let call = state
        .calls
        .start(caller, conversation, callee, online, request.video)?;
    let view = calling::announce(&state, &call).await;
    Ok((StatusCode::CREATED, Json(view)))
}

/// 我现在所在的通话（响铃中或通话中）。
pub async fn current(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Json<CurrentCall> {
    Json(CurrentCall {
        call: state
            .calls
            .current(context.user.id)
            .as_ref()
            .map(calling::view),
    })
}

/// 在这台设备上接听。
pub async fn accept(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<CallDeviceRequest>,
) -> Result<Json<CallView>, AppError> {
    let me = Endpoint {
        user: context.user.id,
        device: device(&request.device)?,
    };
    let call = state.calls.accept(&me, call_id(&id)?)?;
    Ok(Json(calling::announce(&state, &call).await))
}

/// 拒绝（在哪一台设备上都可以）；或者接听时麦克风用不了。
pub async fn reject(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<RejectCallRequest>,
) -> Result<Json<CallView>, AppError> {
    let why = match request.reason {
        None => Rejection::Declined,
        Some(RejectReason::NoMicrophone) => Rejection::NoMicrophone,
    };
    let call = state.calls.reject(context.user.id, call_id(&id)?, why)?;
    Ok(Json(calling::announce(&state, &call).await))
}

/// 挂断：响铃时主叫挂断是取消、被叫挂断是拒绝，接通后是正常结束。
pub async fn hangup(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<CallDeviceRequest>,
) -> Result<Json<CallView>, AppError> {
    let me = Endpoint {
        user: context.user.id,
        device: device(&request.device)?,
    };
    let why = match request.reason {
        None => Hangup::Normal,
        Some(HangupReason::Network) => Hangup::Network,
    };
    let call = state.calls.hangup(&me, call_id(&id)?, why)?;
    Ok(Json(calling::announce(&state, &call).await))
}

/// 把建立连接用的信息转给对方通话里的那一台设备。
pub async fn signal(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<CallSignalRequest>,
) -> Result<StatusCode, AppError> {
    if request.signal.is_empty() || request.signal.chars().count() > SIGNAL_MAX_CHARS {
        return Err(AppError::new(
            ErrorCode::BadRequest,
            "signal must be 1 to 65536 characters",
        ));
    }
    let me = Endpoint {
        user: context.user.id,
        device: device(&request.device)?,
    };
    let id = call_id(&id)?;
    let peer = state.calls.peer_of(&me, id)?;
    let event = ServerEvent::CallSignal(CallSignal {
        call_id: id.to_string(),
        signal: request.signal,
    });
    state.hub.push_device(peer.user, &peer.device, &event);
    Ok(StatusCode::NO_CONTENT)
}

/// 给这个用户签一个中转服务的临时账号。没有配置中转服务时，列表为空。
pub async fn ice_servers(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<IceServers>, AppError> {
    let settings = state.chat.call_video().await?;
    let video = CallVideoView {
        screen_max_width: settings.screen_max_width,
        screen_max_fps: settings.screen_max_fps,
        screen_direct_kbps: settings.screen_direct_kbps,
        screen_relay_kbps: settings.screen_relay_kbps,
        camera_relay_kbps: settings.camera_relay_kbps,
        group_camera_high_kbps: settings.group_camera_high_kbps,
        group_camera_low_kbps: settings.group_camera_low_kbps,
        group_screen_kbps: settings.group_screen_kbps,
    };
    let group_calls = state.config.livekit.is_some();
    let Some(turn) = &state.config.turn else {
        return Ok(Json(IceServers {
            ice_servers: Vec::new(),
            expires_at: None,
            video,
            group_calls,
        }));
    };
    let server = turn_credential(turn, context.user.id, state.accounts.now_ms());
    Ok(Json(IceServers {
        ice_servers: vec![IceServerView {
            urls: server.urls,
            username: server.username,
            credential: server.credential,
        }],
        expires_at: Some(server.expires_at),
        video,
        group_calls,
    }))
}

/// 给验证页面签一张进验证用房间的入场凭证（F10 的技术验证）。没有配置媒体转发服务时不可用。
///
/// 身份是"用户编号:设备"：同一个人可以用几台设备、几个窗口进来，好凑够人数。
/// 真正的群通话里一个人只能在一台设备上，身份就是用户编号。
pub async fn group_check(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<GroupCheckRequest>,
) -> Result<Json<RoomTicketView>, AppError> {
    let device = device(&request.device)?;
    let Some(livekit) = &state.config.livekit else {
        return Err(AppError::new(
            ErrorCode::Unavailable,
            "group calls are not set up on this server",
        ));
    };
    let identity = format!("{}:{}", context.user.id, device.as_str());
    // 验证页面可以要一张不放行摄像头、不放行共享屏幕的：用来确认拿它发会被媒体转发服务拒绝（F11、F12）
    let sources = TicketSources {
        camera: request.camera,
        screen: request.screen,
    };
    let ticket = room_ticket(
        livekit,
        CHECK_ROOM,
        &identity,
        sources,
        state.accounts.now_ms(),
    );
    Ok(Json(RoomTicketView {
        url: state.config.livekit_public_url(),
        token: ticket.token,
        room: CHECK_ROOM.to_owned(),
        identity,
        expires_at: ticket.expires_at,
    }))
}
