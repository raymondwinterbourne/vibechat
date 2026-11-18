//! 账号相关接口的请求和响应。
//!
//! 命名约定：`id` 是内部编号，永不改变；`handle` 是用户看得见、可以修改的那个 ID。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Role {
    User,
    Admin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum Language {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en")]
    En,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Theme {
    Light,
    Dark,
    System,
}

/// 当前登录的用户自己的资料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Me {
    pub id: String,
    pub handle: String,
    pub nickname: String,
    pub signature: String,
    pub avatar_file_id: Option<String>,
    pub role: Role,
    /// 为真时只能先修改密码。
    pub must_change_password: bool,
    /// 只有管理员有。
    pub email: Option<String>,
    /// 没有选择过时为空，由客户端按浏览器语言和系统外观决定。
    pub language: Option<Language>,
    pub theme: Option<Theme>,
    /// 注册的时间，UTC 毫秒。客户端用它判断哪些更新说明对这个人来说是新的。
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RegisterRequest {
    pub invite_code: String,
    pub nickname: String,
    pub password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub handle: String,
    pub password: String,
}

/// 修改个人资料。只带上要改的字段。
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateProfileRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub language: Option<Language>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub theme: Option<Theme>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangeHandleRequest {
    pub handle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateInviteCodesRequest {
    pub count: u32,
    /// 备注，例如发给谁。这一批邀请码共用。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
    /// 多少天后过期；不填则长期有效。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expires_in_days: Option<u32>,
}

/// 一次作废或删除多个邀请码时，指明是哪几个。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteCodeIds {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RevokeInviteCodesResponse {
    /// 实际作废了几个。其中已经使用、已经作废或不存在的会被跳过。
    pub revoked: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeleteInviteCodesResponse {
    /// 实际删除了几个。只有已经作废或已经过期的才会被删除，其余的会被跳过。
    pub deleted: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum InviteCodeStatus {
    Unused,
    Used,
    Expired,
    Revoked,
}

/// 使用了某个邀请码的用户。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteCodeUser {
    pub id: String,
    pub handle: String,
    pub nickname: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteCodeView {
    pub id: String,
    pub code: String,
    pub status: InviteCodeStatus,
    pub note: Option<String>,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
    pub used_by: Option<InviteCodeUser>,
    #[ts(type = "number | null")]
    pub used_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteCodeList {
    pub items: Vec<InviteCodeView>,
}

/// 邀请码列表按生成时间排序的方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum InviteCodeOrder {
    Newest,
    Oldest,
}

/// 邀请码列表的一页。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteCodePage {
    pub items: Vec<InviteCodeView>,
    /// 符合筛选条件的邀请码一共有多少，不只是这一页的。
    pub total: u32,
}

/// 我的一次登录，也就是一台设备（F9）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionView {
    pub id: String,
    /// 浏览器报的设备信息，原样交出：页面解析成"Chrome · macOS"这样的。
    pub user_agent: String,
    /// 登录时的网络地址。以前的登录没有记，为空。
    pub ip: Option<String>,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
    /// 最近活跃的时间，UTC 毫秒。最多一分钟更新一次。
    #[ts(type = "number")]
    pub last_seen_at: i64,
    /// 就是现在发请求的这一台。
    pub current: bool,
    /// 现在有页面连着。
    pub online: bool,
}

/// 我的全部有效登录：本机在最前面。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SessionList {
    pub items: Vec<SessionView>,
}

/// 让其他设备全部下线的结果：下线了几台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SignedOutOthers {
    pub count: u32,
}
