//! 群通话的状态变了之后要做的事（F10，设计文档 3.7 节）：推给群里的全体成员；
//! 有人离开时把他从媒体转发服务的房间里请出去；结束时写通话记录、关闭房间。
//!
//! 群通话本身由 `vibechat_core::call::Calls` 保管；接口和定时的结算都经过这里。

use vibechat_core::call::{GroupCall, TicketSources, call_room, room_ticket};
use vibechat_core::{ConversationId, SessionId, UserId};
use vibechat_protocol::{
    ConversationRead, ErrorCode, GroupCallInvite, GroupCallMember, GroupCallView, RoomTicketView,
    ServerEvent,
};

use crate::error::AppError;
use crate::http::chat::announce_message;
use crate::state::AppState;

pub fn view(call: &GroupCall, limit: u32) -> GroupCallView {
    GroupCallView {
        id: call.id.to_string(),
        conversation_id: call.conversation.to_string(),
        starter_id: call.starter.to_string(),
        video: call.video,
        started_at: call.started_at,
        ended_at: call.ended_at,
        participants: call
            .participants
            .iter()
            .map(|entry| GroupCallMember {
                user_id: entry.user.to_string(),
                device: entry.device.as_str().to_owned(),
                joined_at: entry.joined_at,
            })
            .collect(),
        ringing: call
            .ringing
            .iter()
            .map(|invite| GroupCallInvite {
                user_id: invite.user.to_string(),
                by: invite.by.to_string(),
                until: invite.until,
            })
            .collect(),
        sharing: call.sharing.map(|user| user.to_string()),
        limit,
    }
}

/// 没有配置媒体转发服务时不能群通话。
pub fn require_media(state: &AppState) -> Result<(), AppError> {
    if state.config.livekit.is_some() {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::Unavailable,
            "group calls are not set up on this server",
        ))
    }
}

/// 给通话里的这个人签一张入场凭证：只能进这个通话的房间，身份是他的用户编号。
/// 视频通话的放行摄像头；语音通话的不放行，拿它发摄像头的画面，媒体转发服务不接受（F11 的 Q2）。
pub fn ticket(
    state: &AppState,
    call: &GroupCall,
    user: UserId,
) -> Result<RoomTicketView, AppError> {
    require_media(state)?;
    let livekit = state
        .config
        .livekit
        .as_ref()
        .expect("just checked that it is set up");
    let room = call_room(call.id);
    let identity = user.to_string();
    // 共享屏幕语音通话里也可以（F12 的 Q1）。同一时间只让一个人共享由服务端自己管，
    // 凭证管不了"现在轮到谁"：页面只收服务端说的那个人的屏幕
    let sources = TicketSources {
        camera: call.video,
        screen: true,
    };
    let signed = room_ticket(livekit, &room, &identity, sources, state.accounts.now_ms());
    Ok(RoomTicketView {
        url: state.config.livekit_public_url(),
        token: signed.token,
        room,
        identity,
        expires_at: signed.expires_at,
    })
}

/// 现在的人数上限。读不出来时用默认值：不能因为这个让通话的变化推不出去。
async fn call_limit(state: &AppState, call: &GroupCall) -> u32 {
    match state.chat.group_call_max().await {
        Ok(limit) => limit,
        Err(err) => {
            tracing::warn!(call = %call.id, "could not read the group call limit: {err}");
            vibechat_core::limits::GROUP_CALL_MAX_DEFAULT
        }
    }
}

/// 通话变了：推给群里现在的全体成员。结束了的，再写通话记录、关闭房间。
pub async fn announce(state: &AppState, call: &GroupCall) -> GroupCallView {
    let view = view(call, call_limit(state, call).await);
    match state.chat.group_call_audience(call.conversation).await {
        Ok(members) => {
            state
                .hub
                .push(&members, &ServerEvent::GroupCallUpdated(view.clone()));
        }
        Err(err) => tracing::warn!(call = %call.id, "could not find who to tell: {err}"),
    }
    if call.ended() {
        record(state, call).await;
        if let Err(err) = state.rooms.close(&call_room(call.id)).await {
            tracing::warn!(call = %call.id, "could not close the room: {err}");
        }
    }
    view
}

/// 把离开了通话的人从房间里请出去：不能只靠他的页面自觉断开。
pub async fn show_out(state: &AppState, call: &GroupCall, users: &[UserId]) {
    let room = call_room(call.id);
    for user in users {
        if let Err(err) = state.rooms.remove(&room, &user.to_string()).await {
            tracing::warn!(call = %call.id, "could not remove a participant from the room: {err}");
        }
    }
}

/// 写通话记录并推给群成员；参加了通话的人，这一条直接算读过。
async fn record(state: &AppState, call: &GroupCall) {
    let record = match state.chat.record_group_call(call).await {
        Ok(record) => record,
        // 记录写不进去不影响通话本身已经结束
        Err(err) => {
            tracing::warn!(call = %call.id, "could not record the group call: {err}");
            return;
        }
    };
    announce_message(state, &record.posted);
    for (user, seq) in record.read_by {
        let read = ConversationRead {
            conversation_id: call.conversation.to_string(),
            user_id: user.to_string(),
            read_seq: seq,
        };
        state
            .hub
            .push(&record.posted.members, &ServerEvent::ConvRead(read));
    }
}

/// 结算到时间的群通话：邀请不再响、设备断开太久的人算离开、没有人了就结束。
pub async fn settle(state: &AppState) {
    for swept in state.calls.sweep_groups() {
        show_out(state, &swept.call, &swept.left).await;
        announce(state, &swept.call).await;
    }
}

/// 这几次登录就要被断开了（退出登录、在别处被退出、被禁用、改了密码）：
/// 它们的设备在群通话里的，立即算离开，不等"设备断开太久"。要在断开连接之前调。
pub async fn sessions_ending(state: &AppState, sessions: &[SessionId]) {
    for (user, device) in state.hub.devices_of_sessions(sessions) {
        for call in state.calls.remove_from_group_calls(user, Some(&device)) {
            show_out(state, &call, &[user]).await;
            announce(state, &call).await;
        }
    }
}

/// 这个人不再是这个群的成员了（被移出，或者自己退了）：他在这个群的通话里的话立即离开，给他的邀请作废。
///
/// 通话的变化只推给群里现在的成员，他已经收不到了，所以单独告诉他两件事：
/// 通话里没有他了；这个通话对他来说没有了（页面据此收起"通话进行中"、停止响铃）。
pub async fn member_gone(state: &AppState, user: UserId, conversation: ConversationId) {
    let changed = state.calls.remove_from_group_call(user, conversation);
    let now = match &changed {
        Some(call) => {
            show_out(state, call, &[user]).await;
            Some(announce(state, call).await)
        }
        // 他和通话没有关系，但页面上可能还显示着"通话进行中"
        None => match state.calls.group_call_in(conversation) {
            Some(call) => Some(view(&call, call_limit(state, &call).await)),
            None => None,
        },
    };
    let Some(now) = now else {
        return;
    };
    if now.ended_at.is_some() {
        // 他是最后一个人：通话结束了
        state.hub.push(&[user], &ServerEvent::GroupCallUpdated(now));
        return;
    }
    if changed.is_some() {
        state
            .hub
            .push(&[user], &ServerEvent::GroupCallUpdated(now.clone()));
    }
    let over = GroupCallView {
        ended_at: Some(state.accounts.now_ms()),
        participants: Vec::new(),
        ringing: Vec::new(),
        sharing: None,
        ..now
    };
    state
        .hub
        .push(&[user], &ServerEvent::GroupCallUpdated(over));
}

/// 群解散了：它的通话随之结束，照常留下通话记录。
pub async fn group_dissolved(state: &AppState, conversation: ConversationId) {
    if let Some(call) = state.calls.end_group_call(conversation) {
        announce(state, &call).await;
    }
}
