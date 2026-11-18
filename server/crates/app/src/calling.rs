//! 通话的状态变了之后要做的事：推给双方，结束时写通话记录（设计文档 3.7 节）。
//!
//! 通话本身由 `vibechat_core::call::Calls` 保管；接口、WebSocket 和定时的结算都经过这里，
//! 保证每一次变化都通知到双方、每一个结束的通话都留下记录。

use std::time::Duration;

use vibechat_core::call::{Call, CallState, Endpoint};
use vibechat_protocol::{CallView, ServerEvent};

use crate::http::chat::announce_message;
use crate::http::views;
use crate::state::AppState;

/// 多久结算一次到时间的通话（响铃没人接、设备断开太久）。
pub const SETTLE_INTERVAL: Duration = Duration::from_secs(1);

pub fn view(call: &Call) -> CallView {
    let (state, outcome) = match call.state {
        CallState::Ringing => (vibechat_protocol::CallState::Ringing, None),
        CallState::Active => (vibechat_protocol::CallState::Active, None),
        CallState::Ended(outcome) => (
            vibechat_protocol::CallState::Ended,
            Some(views::call_outcome(outcome)),
        ),
    };
    CallView {
        id: call.id.to_string(),
        conversation_id: call.conversation.to_string(),
        caller_id: call.caller.to_string(),
        callee_id: call.callee.to_string(),
        caller_device: call.caller_device.as_str().to_owned(),
        callee_device: call.callee_device.as_ref().map(|d| d.as_str().to_owned()),
        state,
        video: call.video,
        outcome,
        started_at: call.started_at,
        answered_at: call.answered_at,
        ended_at: call.ended_at,
    }
}

/// 通话变了：推给双方的每一台设备。结束了的，再写通话记录并推给双方。
pub async fn announce(state: &AppState, call: &Call) -> CallView {
    let view = view(call);
    state.hub.push(
        &[call.caller, call.callee],
        &ServerEvent::CallUpdated(view.clone()),
    );
    if call.outcome().is_some() {
        match state.chat.record_call(call).await {
            Ok(posted) => {
                announce_message(state, &posted);
            }
            // 记录写不进去不影响通话本身已经结束
            Err(err) => tracing::warn!(call = %call.id, "could not record the call: {err}"),
        }
    }
    view
}

/// 结算到时间的通话。
pub async fn settle(state: &AppState) {
    for call in state.calls.sweep() {
        announce(state, &call).await;
    }
    crate::group_calling::settle(state).await;
}

/// 定时结算，直到服务停止。
pub async fn settle_forever(state: AppState) {
    let mut tick = tokio::time::interval(SETTLE_INTERVAL);
    loop {
        tick.tick().await;
        settle(&state).await;
    }
}

/// 一台设备的 WebSocket 连上了。
pub fn device_connected(state: &AppState, endpoint: &Endpoint) {
    state.calls.device_back(endpoint);
}

/// 一台设备的 WebSocket 断开了：它已经没有别的连接时，通话开始计时。
pub fn device_disconnected(state: &AppState, endpoint: &Endpoint) {
    if !state.hub.has_device(endpoint.user, &endpoint.device) {
        state.calls.device_gone(endpoint);
    }
}
