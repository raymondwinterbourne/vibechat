//! 通话相关接口的请求和响应（F3）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 通话是怎么结束的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CallOutcome {
    /// 接通过，后来有一方挂断。
    Completed,
    /// 主叫在对方接听前取消了。被叫看到未接来电。
    Cancelled,
    /// 被叫拒绝了。
    Rejected,
    /// 响铃到时间也没人接。被叫看到未接来电。
    Missed,
    /// 被叫正在另一个通话里。被叫看到未接来电。
    Busy,
    /// 被叫没有一台设备在线。被叫看到未接来电。
    Offline,
    /// 一方的设备断开太久（网络中断，或者关掉、刷新了页面），或者音频连接断了恢复不了。
    Interrupted,
    /// 被叫点了接听，但麦克风用不了，没能接通。
    NoMicrophone,
}

/// 浏览器建立音频连接时可以用的一个服务器：地址和临时账号（WebRTC 的 RTCIceServer）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IceServerView {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

/// `GET /api/calls/ice-servers` 的响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct IceServers {
    /// 只有我们自己的中转服务。没有配置中转服务时为空：这时不能通话。
    pub ice_servers: Vec<IceServerView>,
    /// 账号什么时候失效，UTC 毫秒。快到时间了要重新取。
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
    /// 通话画面的参数，由管理员在系统设置里调（F7）。
    pub video: CallVideoView,
    /// 这台服务器能不能群通话（F10）：配置了媒体转发服务才能。
    pub group_calls: bool,
}

/// 通话画面的参数。码率是千比特每秒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallVideoView {
    /// 共享屏幕的画面最宽多少像素，高度按屏幕的比例。
    pub screen_max_width: u32,
    /// 共享屏幕每秒最多几帧。
    pub screen_max_fps: u32,
    /// 直连时共享屏幕的码率上限。
    pub screen_direct_kbps: u32,
    /// 走中转时共享屏幕的码率上限。
    pub screen_relay_kbps: u32,
    /// 走中转时摄像头的码率上限。直连时不限。
    pub camera_relay_kbps: u32,
    /// 群视频里清楚的那一档的码率上限（F11）。
    pub group_camera_high_kbps: u32,
    /// 群视频里小的那一档的码率上限。
    pub group_camera_low_kbps: u32,
    /// 群通话里共享的屏幕的码率上限（F12）。
    pub group_screen_kbps: u32,
}

/// 通话进行到了哪一步。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum CallState {
    /// 呼叫中：被叫的设备在响铃。
    Ringing,
    /// 通话中：被叫在某一台设备上接了。
    Active,
    /// 结束了，结果在 `outcome` 里。
    Ended,
}

/// 一次通话。
///
/// 设备是页面打开时自己生成的编号（连 WebSocket 时带在 `/ws?device=` 里）。
/// 通话只和双方各一台设备建立：主叫发起的那一台、被叫接听的那一台。
/// 其余的设备据此显示"已在其他设备接听""正在通话中"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallView {
    pub id: String,
    /// 双方的单聊。
    pub conversation_id: String,
    pub caller_id: String,
    pub callee_id: String,
    /// 主叫发起通话的那一台设备。
    pub caller_device: String,
    /// 被叫接听的那一台设备。接听之前为空。
    pub callee_device: Option<String>,
    pub state: CallState,
    /// 视频通话。不是的就是语音通话。
    pub video: bool,
    /// 结束了的才有。
    pub outcome: Option<CallOutcome>,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub answered_at: Option<i64>,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
}

/// `POST /api/calls`：在这台设备上给单聊里的好友打电话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartCallRequest {
    pub conversation_id: String,
    pub device: String,
    /// 视频通话。不带就是语音通话。
    #[serde(default)]
    pub video: bool,
}

/// 接听、挂断：在哪一台设备上。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallDeviceRequest {
    pub device: String,
    /// 挂断的原因。不带就是用户点了挂断。
    #[serde(default)]
    pub reason: Option<HangupReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum HangupReason {
    /// 音频连接断了，自动重连也没有恢复。通话记录写"网络中断"。
    Network,
}

/// `POST /api/calls/{id}/reject`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RejectCallRequest {
    /// 不带就是用户点了拒绝。
    #[serde(default)]
    pub reason: Option<RejectReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum RejectReason {
    /// 点了接听，但麦克风用不了。
    NoMicrophone,
}

/// `POST /api/calls/{id}/signal`：把建立连接用的信息（WebRTC 的 offer、answer、候选地址）
/// 发给对方通话里的那一台设备。服务端不看内容，原样转过去。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallSignalRequest {
    pub device: String,
    pub signal: String,
}

/// 推给对方通话里那一台设备的连接信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallSignal {
    pub call_id: String,
    pub signal: String,
}

/// `GET /api/calls/current`：我现在所在的通话（响铃中或通话中）。页面打开、重连之后用它恢复界面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CurrentCall {
    pub call: Option<CallView>,
}

/// `POST /api/calls/group-check`：验证页面（`/group-call-check`）要一张进验证用房间的入场凭证（F10）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCheckRequest {
    /// 这一台设备。同一个人可以用几台设备、几个窗口进验证用的房间，每一个算一个人。
    pub device: String,
    /// 凭证要不要放行摄像头的画面（F11）。不带时不放行，和语音通话的凭证一样。
    #[serde(default)]
    pub camera: bool,
    /// 凭证要不要放行共享的屏幕（F12）。不带时不放行。
    #[serde(default)]
    pub screen: bool,
}

/// 群通话的入场凭证：凭它连到媒体转发服务（LiveKit）的一个房间里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RoomTicketView {
    /// 浏览器连媒体转发服务用的地址：网页的地址下的 `/livekit`，由反向代理转过去。
    pub url: String,
    pub token: String,
    /// 进的是哪个房间。
    pub room: String,
    /// 我在房间里的身份。
    pub identity: String,
    /// 凭证什么时候失效，UTC 毫秒。只在进门时检查。
    #[ts(type = "number")]
    pub expires_at: i64,
}

/// 群通话里的一个人（F10）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallMember {
    pub user_id: String,
    /// 他在通话里的那一台设备。是我自己时，据此知道是这一台还是"已在其他设备加入"。
    pub device: String,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub joined_at: i64,
}

/// 群通话里一个正在响铃的邀请。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallInvite {
    pub user_id: String,
    /// 谁邀请的。
    pub by: String,
    /// 响到什么时候，UTC 毫秒。
    #[ts(type = "number")]
    pub until: i64,
}

/// 一次群通话。它有变化时推给群里的全体成员（`group_call.updated`）。
///
/// 声音不在这里：通话里的人各自凭入场凭证连到媒体转发服务。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallView {
    pub id: String,
    /// 哪个群。
    pub conversation_id: String,
    /// 发起人。
    pub starter_id: String,
    /// 是视频通话（F11）：里面的人可以开摄像头。发起时定下来，之后不变。
    pub video: bool,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub started_at: i64,
    /// 结束了的才有：最后一个人离开的时候。
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    /// 现在在通话里的人，按进来的先后。
    pub participants: Vec<GroupCallMember>,
    /// 正在响铃的邀请。
    pub ringing: Vec<GroupCallInvite>,
    /// 正在共享屏幕的人（F12）。同一时间只有一个；页面只收他的屏幕。
    pub sharing: Option<String>,
    /// 通话里最多几个人。
    pub limit: u32,
}

/// `POST /api/group-calls`：在这台设备上发起群通话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct StartGroupCallRequest {
    pub conversation_id: String,
    pub device: String,
    /// 发起的是视频通话（F11）。不带时是语音通话。
    #[serde(default)]
    pub video: bool,
    /// 邀请哪些人：他们的设备响铃。不是群成员的不认。
    #[serde(default)]
    pub invite: Vec<String>,
}

/// 加入、离开群通话：在哪一台设备上。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallDeviceRequest {
    pub device: String,
}

/// `POST /api/group-calls/{id}/invite`：通话里的人再邀请几个人。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallInviteRequest {
    pub user_ids: Vec<String>,
}

/// 发起、加入群通话的结果：通话现在的样子，和连媒体转发服务用的入场凭证。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallJoined {
    pub call: GroupCallView,
    pub ticket: RoomTicketView,
}

/// `GET /api/group-calls`：我所在的群里正在进行的通话。页面打开、重连之后用它恢复界面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupCallList {
    pub calls: Vec<GroupCallView>,
}
