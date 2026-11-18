//! 管理接口的请求和响应，以及管理员找回密码、修改邮箱用到的几个。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::account::Role;
use crate::chat::ConversationKind;
use crate::contact::UserCard;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum UserStatus {
    Active,
    /// 被禁用：不能登录，账号、好友和消息都保留。
    Disabled,
}

/// 用户列表里的一个用户。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminUserView {
    pub id: String,
    pub handle: String,
    pub nickname: String,
    pub avatar_file_id: Option<String>,
    pub role: Role,
    pub status: UserStatus,
    /// 注册时用的邀请码。管理员没有。
    pub invite_code: Option<String>,
    /// 注册时间，UTC 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
    /// 最近一次登录的时间。
    #[ts(type = "number | null")]
    pub last_login_at: Option<i64>,
}

/// 用户列表的一页，注册晚的在前。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminUserPage {
    pub items: Vec<AdminUserView>,
    /// 符合条件的用户一共有多少。
    pub total: u32,
}

/// 重置密码的结果。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResetPasswordResponse {
    pub user: AdminUserView,
    /// 临时密码。只在这里出现一次，由管理员转告用户；用它登录后必须先改密码。
    pub password: String,
}

/// 管理员做过的一件事的类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum AuditAction {
    ChatViewed,
    UserDisabled,
    UserEnabled,
    PasswordReset,
    InviteCodesCreated,
    InviteCodesRevoked,
    InviteCodesDeleted,
    GroupDissolved,
    SettingChanged,
}

/// 一条操作记录。显示成什么文字由客户端按当前语言决定。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AuditEntryView {
    pub id: String,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub at: i64,
    pub action: AuditAction,
    /// 操作对象的内部编号：用户或会话。
    pub target: Option<String>,
    /// 操作对象当时的名称。
    pub label: Option<String>,
    /// 涉及几个邀请码。
    pub count: Option<u32>,
    /// 改的是哪一项设置；查看聊天内容时是会话的类型：`direct` 或 `group`。
    pub key: Option<String>,
    /// 设置改之前和改之后的值。
    pub from: Option<String>,
    pub to: Option<String>,
}

/// 操作记录的一页，从新到旧。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AuditPage {
    pub items: Vec<AuditEntryView>,
    pub total: u32,
}

/// 一项设置的默认值和允许的范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SettingRange {
    #[ts(type = "number")]
    pub min: u64,
    #[ts(type = "number")]
    pub max: u64,
    /// 没有设置过时用的值。保留期限没有默认的天数：默认是永久保留。
    #[ts(type = "number | null")]
    pub default: Option<u64>,
}

/// 系统设置：当前的值，和每一项的默认值、允许的范围。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SettingsView {
    /// 单个文件最大多少字节。
    #[ts(type = "number")]
    pub file_max_bytes: u64,
    /// 群人数上限，包括群主。
    pub group_max_members: u32,
    /// 一条语音最长多少秒。
    pub voice_max_seconds: u32,
    /// 消息发出后多少秒之内可以撤回。0 表示不允许撤回。
    pub recall_window_seconds: u32,
    /// 消息发出后多少秒之内可以编辑。0 表示不允许编辑（F8）。
    pub edit_window_seconds: u32,
    /// 聊天记录和文件保留多少天。空表示永久保留。
    pub retention_days: Option<u32>,
    /// 共享屏幕的画面最宽多少像素（F7）。
    pub screen_max_width: u32,
    /// 共享屏幕每秒最多几帧。
    pub screen_max_fps: u32,
    /// 直连时共享屏幕的码率上限，千比特每秒。
    pub screen_direct_kbps: u32,
    /// 走中转时共享屏幕的码率上限，千比特每秒。
    pub screen_relay_kbps: u32,
    /// 走中转时摄像头的码率上限，千比特每秒。
    pub camera_relay_kbps: u32,
    /// 群视频里清楚的那一档的码率上限，千比特每秒（F11）。
    pub group_camera_high_kbps: u32,
    /// 群视频里小的那一档的码率上限，千比特每秒。
    pub group_camera_low_kbps: u32,
    /// 群通话里共享的屏幕的码率上限，千比特每秒（F12）。
    pub group_screen_kbps: u32,
    /// 群通话最多几个人（F10）。
    pub group_call_max: u32,
    pub file_max_bytes_range: SettingRange,
    pub group_max_members_range: SettingRange,
    pub voice_max_seconds_range: SettingRange,
    pub recall_window_seconds_range: SettingRange,
    pub edit_window_seconds_range: SettingRange,
    pub retention_days_range: SettingRange,
    pub screen_max_width_range: SettingRange,
    pub screen_max_fps_range: SettingRange,
    pub screen_direct_kbps_range: SettingRange,
    pub screen_relay_kbps_range: SettingRange,
    pub camera_relay_kbps_range: SettingRange,
    pub group_camera_high_kbps_range: SettingRange,
    pub group_camera_low_kbps_range: SettingRange,
    pub group_screen_kbps_range: SettingRange,
    pub group_call_max_range: SettingRange,
}

/// 修改系统设置。只带上要改的项。
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateSettingsRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub file_max_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_max_members: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_call_max: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub voice_max_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recall_window_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edit_window_seconds: Option<u32>,
    /// 0 表示永久保留。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retention_days: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screen_max_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screen_max_fps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screen_direct_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub screen_relay_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub camera_relay_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_camera_high_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_camera_low_kbps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub group_screen_kbps: Option<u32>,
}

/// 系统概况。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OverviewView {
    pub users_total: u32,
    pub users_disabled: u32,
    /// 此刻有连接的用户数。
    pub online: u32,
    /// 现在有多少个群。已经解散的不算。
    pub groups: u32,
    /// 全部上传的文件：头像和消息里的文件。
    pub files_count: u32,
    #[ts(type = "number")]
    pub files_bytes: u64,
}

/// 一个会话在管理员那里的样子。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminConversationView {
    pub id: String,
    pub kind: ConversationKind,
    /// 群名称。没有起名的群和单聊为空，这时用 `people` 来显示。
    pub name: Option<String>,
    /// 单聊的两个人；群里最早加入的几名成员。
    pub people: Vec<UserCard>,
    pub avatar_file_id: Option<String>,
    /// 群主。
    pub owner: Option<UserCard>,
    /// 现在在会话里的人数。
    pub member_count: u32,
    pub dissolved: bool,
    #[ts(type = "number")]
    pub created_at: i64,
    /// 最新一条的时间。
    #[ts(type = "number | null")]
    pub last_at: Option<i64>,
}

/// 一个用户参与的全部会话，最近有动静的在前。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminConversationList {
    pub user: UserCard,
    pub items: Vec<AdminConversationView>,
}

/// 系统里的群的一页，新建的在前。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminGroupPage {
    pub items: Vec<AdminConversationView>,
    pub total: u32,
}

/// 会话的一个成员。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminMemberView {
    pub user: UserCard,
    pub is_owner: bool,
    /// 现在还在不在会话里。
    pub active: bool,
}

/// 一个会话和它的全部成员，包括已经离开的。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AdminMemberList {
    pub conversation: AdminConversationView,
    pub items: Vec<AdminMemberView>,
}

/// 开始一次查看得到的东西。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ViewStarted {
    /// 查看凭据。之后取这个会话的消息和文件都要带着它。
    pub view: String,
    /// 凭据失效的时间，UTC 毫秒。
    #[ts(type = "number")]
    pub expires_at: i64,
    pub conversation: AdminConversationView,
    pub members: Vec<AdminMemberView>,
}

/// 管理员请求找回密码。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PasswordResetRequest {
    pub email: String,
}

/// 凭邮件里的链接设一个新密码。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PasswordResetConfirm {
    pub token: String,
    pub new_password: String,
}

/// 管理员修改绑定的邮箱。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangeEmailRequest {
    pub current_password: String,
    pub email: String,
}

/// 凭确认邮件里的链接让新邮箱生效。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EmailConfirmRequest {
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EmailConfirmed {
    /// 现在生效的邮箱。
    pub email: String,
}
