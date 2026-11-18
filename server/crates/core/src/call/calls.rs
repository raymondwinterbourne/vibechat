//! 进行中的通话（设计文档 3.7 节）。
//!
//! 只在内存里，由这里统一保管：谁在和谁通话、通话到了哪一步。系统部署在单台服务器上，
//! 服务端重启时进行中的通话会断，也不留通话记录，这可以接受。通话结束时把结束的样子交出去，
//! 由调用方写通话记录、通知双方。
//!
//! 这里不碰网络和数据库，也不自己计时：超时由调用方定期调 [`Calls::sweep`] 来结算，
//! 测试时拨动时钟再调一次就行。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use super::group::LiveGroup;
use crate::account::model::string_enum;
use crate::clock::Clock;
use crate::ids::{CallId, ConversationId, UserId};

string_enum!(
    /// 通话是怎么结束的。写进通话记录。
    ///
    /// - 接通（completed）：接通过，后来有一方挂断。
    /// - 已取消（cancelled）：主叫在对方接听前取消了。
    /// - 已拒绝（rejected）：被叫拒绝了。
    /// - 未接（missed）：响铃到时间也没人接。
    /// - 对方忙（busy）：被叫正在另一个通话里。
    /// - 对方不在线（offline）：被叫没有一台设备在线。
    /// - 网络中断（interrupted）：一方的设备断开太久，例如网络断了、关掉或刷新了页面；
    ///   或者音频连接断了、恢复不了。
    /// - 被叫的麦克风用不了（no_microphone）：被叫点了接听，但拿不到麦克风，没能接通。
    CallOutcome {
        Completed => "completed",
        Cancelled => "cancelled",
        Rejected => "rejected",
        Missed => "missed",
        Busy => "busy",
        Offline => "offline",
        Interrupted => "interrupted",
        NoMicrophone => "no_microphone",
    }
);

/// 被叫为什么没有接。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// 点了拒绝。
    Declined,
    /// 点了接听，但麦克风用不了。
    NoMicrophone,
}

/// 为什么挂断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hangup {
    /// 用户点了挂断。
    Normal,
    /// 音频连接断了，自动重连也没有恢复：通话记录写"网络中断"。
    Network,
}

impl CallOutcome {
    /// 被叫算不算"没接到"：通话记录对他显示成未接来电。
    pub fn missed_by_callee(&self) -> bool {
        matches!(
            self,
            Self::Cancelled | Self::Missed | Self::Busy | Self::Offline
        )
    }
}

/// 一台设备：浏览器的一个标签页、桌面客户端的一个窗口。
///
/// 页面打开时自己生成一个，连 WebSocket 和调通话接口时带上。同一个人可以同时有好几台，
/// 通话只和其中的一台建立：发起的那一台、接听的那一台。页面刷新后是新的一台。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct DeviceId(String);

impl DeviceId {
    /// 8 到 64 个字母、数字、`-`、`_`。不符合的不认。
    pub fn parse(text: &str) -> Option<Self> {
        let fits = (8..=64).contains(&text.len())
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        fits.then(|| Self(text.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 某个人的某一台设备。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Endpoint {
    pub user: UserId,
    pub device: DeviceId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallState {
    /// 呼叫中：被叫的设备在响铃。
    Ringing,
    /// 通话中：被叫在某一台设备上接了。
    Active,
    Ended(CallOutcome),
}

/// 一次通话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub id: CallId,
    /// 双方的单聊。通话记录写在这里。
    pub conversation: ConversationId,
    pub caller: UserId,
    pub callee: UserId,
    /// 主叫发起通话的那一台设备。
    pub caller_device: DeviceId,
    /// 被叫接听的那一台设备。接听之前为空。
    pub callee_device: Option<DeviceId>,
    pub state: CallState,
    /// 视频通话。不是的就是语音通话。
    pub video: bool,
    pub started_at: i64,
    pub answered_at: Option<i64>,
    pub ended_at: Option<i64>,
}

impl Call {
    /// 接通了多久，毫秒。没有接通过的为空。
    pub fn duration_ms(&self) -> Option<i64> {
        Some(self.ended_at? - self.answered_at?)
    }

    pub fn outcome(&self) -> Option<CallOutcome> {
        match self.state {
            CallState::Ended(outcome) => Some(outcome),
            _ => None,
        }
    }

    pub fn is_party(&self, user: UserId) -> bool {
        user == self.caller || user == self.callee
    }

    /// 这个人在通话里的那一台设备。
    fn device_of(&self, user: UserId) -> Option<&DeviceId> {
        if user == self.caller {
            Some(&self.caller_device)
        } else if user == self.callee {
            self.callee_device.as_ref()
        } else {
            None
        }
    }

    /// 这台设备是不是通话里的那一台。
    fn is_in_call(&self, endpoint: &Endpoint) -> bool {
        self.device_of(endpoint.user) == Some(&endpoint.device)
    }
}

/// 通话的时限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallSettings {
    /// 响铃多久没人接算未接，毫秒。
    pub ring_timeout_ms: i64,
    /// 通话里的设备断开多久算网络中断，毫秒。给 WebSocket 断线重连留时间。
    pub gone_grace_ms: i64,
    /// 群通话的邀请响铃多久，毫秒。过了不再响，但只要通话还在就可以加入。
    pub group_ring_timeout_ms: i64,
}

impl Default for CallSettings {
    fn default() -> Self {
        Self {
            ring_timeout_ms: 45_000,
            gone_grace_ms: 30_000,
            group_ring_timeout_ms: 30_000,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CallError {
    /// 没有这个通话：不存在、已经结束，或者我不是它的一方。
    #[error("no such call")]
    NotFound,
    /// 我已经在一个通话里了（在任何一台设备上）。
    #[error("already in a call")]
    AlreadyInCall,
    /// 这个通话已经不在响铃了：已经接了，或者已经结束。
    #[error("the call is no longer ringing")]
    NotRinging,
    /// 还没接通，不能交换建立连接用的信息。
    #[error("the call has not been answered yet")]
    NotAnswered,
    /// 这台设备不是通话里的那一台。
    #[error("this device is not in the call")]
    WrongDevice,
}

/// 一个进行中的通话，加上双方通话里的那一台设备从什么时候起断开着。
pub(super) struct Live {
    call: Call,
    caller_gone_since: Option<i64>,
    callee_gone_since: Option<i64>,
}

/// 全部进行中的通话：一对一的和群里的（群通话的操作在 [`super::group`] 里）。
/// 放在同一把锁下面，"一个人同一时间只能在一个通话里"才判得准。
#[derive(Default)]
pub(super) struct State {
    pub(super) direct: HashMap<CallId, Live>,
    pub(super) groups: HashMap<CallId, LiveGroup>,
}

/// 全部进行中的通话。
pub struct Calls {
    pub(super) clock: Arc<dyn Clock>,
    pub(super) settings: CallSettings,
    state: Mutex<State>,
}

impl Calls {
    pub fn new(clock: Arc<dyn Clock>, settings: CallSettings) -> Self {
        Self {
            clock,
            settings,
            state: Mutex::new(State::default()),
        }
    }

    pub fn settings(&self) -> CallSettings {
        self.settings
    }

    /// 主叫在 `caller` 这台设备上给 `callee` 打电话，`video` 说明是不是视频通话。调用方已经确认过双方能通话（是好友的单聊）。
    ///
    /// 被叫在通话中、或者没有设备在线时，通话马上结束（对方忙、对方不在线），交回结束的样子。
    pub fn start(
        &self,
        caller: Endpoint,
        conversation: ConversationId,
        callee: UserId,
        callee_online: bool,
        video: bool,
    ) -> Result<Call, CallError> {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        if in_call(&state, caller.user) {
            return Err(CallError::AlreadyInCall);
        }
        let mut call = Call {
            id: CallId::new(),
            conversation,
            caller: caller.user,
            callee,
            caller_device: caller.device,
            callee_device: None,
            state: CallState::Ringing,
            video,
            started_at: now,
            answered_at: None,
            ended_at: None,
        };
        let failed = if in_call(&state, callee) {
            Some(CallOutcome::Busy)
        } else if !callee_online {
            Some(CallOutcome::Offline)
        } else {
            None
        };
        if let Some(outcome) = failed {
            end(&mut call, outcome, now);
            return Ok(call);
        }
        state.direct.insert(
            call.id,
            Live {
                call: call.clone(),
                caller_gone_since: None,
                callee_gone_since: None,
            },
        );
        Ok(call)
    }

    /// 被叫在 `callee` 这台设备上接听。他的其他设备随之停止响铃。
    pub fn accept(&self, callee: &Endpoint, id: CallId) -> Result<Call, CallError> {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        let entry = state.direct.get_mut(&id).ok_or(CallError::NotFound)?;
        let call = &mut entry.call;
        if call.callee != callee.user {
            return Err(CallError::NotFound);
        }
        if call.state != CallState::Ringing {
            return Err(CallError::NotRinging);
        }
        call.state = CallState::Active;
        call.callee_device = Some(callee.device.clone());
        call.answered_at = Some(now);
        Ok(call.clone())
    }

    /// 被叫拒绝（在哪一台设备上都可以）。
    pub fn reject(&self, callee: UserId, id: CallId, why: Rejection) -> Result<Call, CallError> {
        let mut state = self.lock();
        let call = &state.direct.get(&id).ok_or(CallError::NotFound)?.call;
        if call.callee != callee {
            return Err(CallError::NotFound);
        }
        if call.state != CallState::Ringing {
            return Err(CallError::NotRinging);
        }
        let outcome = match why {
            Rejection::Declined => CallOutcome::Rejected,
            Rejection::NoMicrophone => CallOutcome::NoMicrophone,
        };
        Ok(self.finish(&mut state, id, outcome))
    }

    /// 挂断。响铃时主叫挂断是取消，被叫挂断是拒绝；接通后是正常结束。
    /// 主叫、接听了的被叫，都只能在通话里的那一台设备上挂断。
    /// 接通后因为音频连接断了而挂断的，记为网络中断。
    pub fn hangup(&self, me: &Endpoint, id: CallId, why: Hangup) -> Result<Call, CallError> {
        let mut state = self.lock();
        let call = &state.direct.get(&id).ok_or(CallError::NotFound)?.call;
        if !call.is_party(me.user) {
            return Err(CallError::NotFound);
        }
        let outcome = match call.state {
            CallState::Ringing if me.user == call.callee => CallOutcome::Rejected,
            CallState::Ringing => CallOutcome::Cancelled,
            CallState::Active if why == Hangup::Network => CallOutcome::Interrupted,
            CallState::Active => CallOutcome::Completed,
            CallState::Ended(_) => return Err(CallError::NotFound),
        };
        if outcome != CallOutcome::Rejected && !call.is_in_call(me) {
            return Err(CallError::WrongDevice);
        }
        Ok(self.finish(&mut state, id, outcome))
    }

    /// 通话里的一台设备要把建立连接用的信息发给对方：交回对方通话里的那一台设备。
    /// 只有接通之后才能发，也只能由通话里的设备发。
    pub fn peer_of(&self, me: &Endpoint, id: CallId) -> Result<Endpoint, CallError> {
        let state = self.lock();
        let call = &state.direct.get(&id).ok_or(CallError::NotFound)?.call;
        if !call.is_party(me.user) {
            return Err(CallError::NotFound);
        }
        if call.state != CallState::Active {
            return Err(CallError::NotAnswered);
        }
        if !call.is_in_call(me) {
            return Err(CallError::WrongDevice);
        }
        let peer = if me.user == call.caller {
            call.callee
        } else {
            call.caller
        };
        let device = call
            .device_of(peer)
            .cloned()
            .expect("both sides have a device once the call is active");
        Ok(Endpoint { user: peer, device })
    }

    /// 这台设备断开了（它的最后一条连接没了）。它是通话里的设备时开始计时，
    /// 超过 [`CallSettings::gone_grace_ms`] 还没回来，下一次 [`Calls::sweep`] 结束通话。
    pub fn device_gone(&self, endpoint: &Endpoint) {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        for entry in state.direct.values_mut() {
            if !entry.call.is_in_call(endpoint) {
                continue;
            }
            if endpoint.user == entry.call.caller {
                entry.caller_gone_since.get_or_insert(now);
            } else {
                entry.callee_gone_since.get_or_insert(now);
            }
        }
        for group in state.groups.values_mut() {
            group.device_gone(endpoint, now);
        }
    }

    /// 这台设备又连上了：停止计时。
    pub fn device_back(&self, endpoint: &Endpoint) {
        let mut state = self.lock();
        for entry in state.direct.values_mut() {
            if !entry.call.is_in_call(endpoint) {
                continue;
            }
            if endpoint.user == entry.call.caller {
                entry.caller_gone_since = None;
            } else {
                entry.callee_gone_since = None;
            }
        }
        for group in state.groups.values_mut() {
            group.device_back(endpoint);
        }
    }

    /// 结算到时间的一对一通话，交回这一次结束的。调用方大约每秒调一次。
    /// 群通话的在 [`Calls::sweep_groups`]。
    ///
    /// - 响铃到时间没人接：未接。
    /// - 响铃时主叫的设备断开太久：取消。
    /// - 通话中任一方的设备断开太久：网络中断。
    pub fn sweep(&self) -> Vec<Call> {
        let now = self.clock.now_ms();
        let CallSettings {
            ring_timeout_ms,
            gone_grace_ms,
            ..
        } = self.settings;
        let gone_too_long = |since: Option<i64>| since.is_some_and(|at| now - at >= gone_grace_ms);
        let mut state = self.lock();
        let due: Vec<(CallId, CallOutcome)> = state
            .direct
            .values()
            .filter_map(|entry| {
                let call = &entry.call;
                let outcome = match call.state {
                    CallState::Ringing if now - call.started_at >= ring_timeout_ms => {
                        CallOutcome::Missed
                    }
                    CallState::Ringing if gone_too_long(entry.caller_gone_since) => {
                        CallOutcome::Cancelled
                    }
                    CallState::Active
                        if gone_too_long(entry.caller_gone_since)
                            || gone_too_long(entry.callee_gone_since) =>
                    {
                        CallOutcome::Interrupted
                    }
                    _ => return None,
                };
                Some((call.id, outcome))
            })
            .collect();
        due.into_iter()
            .map(|(id, outcome)| self.finish(&mut state, id, outcome))
            .collect()
    }

    /// 这个人现在所在的通话（响铃中或通话中）。页面打开、重连之后用它恢复界面。
    pub fn current(&self, user: UserId) -> Option<Call> {
        self.lock()
            .direct
            .values()
            .find(|entry| entry.call.is_party(user))
            .map(|entry| entry.call.clone())
    }

    /// 进行中的通话有几个，一对一的和群里的都算。
    pub fn count(&self) -> usize {
        let state = self.lock();
        state.direct.len() + state.groups.len()
    }

    fn finish(&self, state: &mut State, id: CallId, outcome: CallOutcome) -> Call {
        let mut call = state.direct.remove(&id).expect("the call is live").call;
        end(&mut call, outcome, self.clock.now_ms());
        call
    }

    pub(super) fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// 这个人是不是已经在一个通话里了：一对一的（响铃中也算），或者群通话（进去了才算，只是被邀请的不算）。
pub(super) fn in_call(state: &State, user: UserId) -> bool {
    state.direct.values().any(|entry| entry.call.is_party(user))
        || state.groups.values().any(|group| group.call.is_in(user))
}

fn end(call: &mut Call, outcome: CallOutcome, now: i64) {
    call.state = CallState::Ended(outcome);
    call.ended_at = Some(now);
}
