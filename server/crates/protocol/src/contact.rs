//! 通讯录相关接口的请求和响应：按 ID 查找用户、好友申请、好友。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 任何登录用户都能看到的资料：按 ID 查找的结果、好友申请里的对方。
/// 个性签名不在其中，那是好友才能看到的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserCard {
    pub id: String,
    pub handle: String,
    pub nickname: String,
    pub avatar_file_id: Option<String>,
}

/// 查找到的人和我是什么关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum Relation {
    /// 就是我自己。
    Myself,
    Friend,
    /// 我向他发过申请，他还没有处理。
    RequestSent,
    /// 他向我发过申请，我还没有处理。
    RequestReceived,
    None,
}

/// 按 ID 查找的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UserLookup {
    pub user: UserCard,
    pub relation: Relation,
    /// 关系是 `request_received` 时，对方发来的那条申请的编号，可以直接同意。
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SendFriendRequest {
    /// 对方的内部编号，来自查找的结果。
    pub to: String,
    /// 验证信息，可以不写。
    #[serde(default)]
    #[ts(optional)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FriendRequestStatus {
    Pending,
    Accepted,
    Rejected,
}

/// 一条申请是我收到的还是我发出的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum FriendRequestDirection {
    Received,
    Sent,
}

/// 我眼里的一条好友申请。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRequestView {
    pub id: String,
    pub direction: FriendRequestDirection,
    /// 对方：收到的申请里是申请方，发出的申请里是接收方。
    pub user: UserCard,
    /// 验证信息，可能为空。
    pub message: String,
    pub status: FriendRequestStatus,
    /// 最近一次发出的时间，UTC 毫秒。
    #[ts(type = "number")]
    pub sent_at: i64,
    #[ts(type = "number | null")]
    pub handled_at: Option<i64>,
}

/// 我收到的和发出的全部申请，最近的在前。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRequestList {
    pub items: Vec<FriendRequestView>,
}

/// 我的一个好友。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendView {
    pub user: UserCard,
    pub signature: String,
    /// 我给他起的备注名，只有我自己看得到。
    pub remark: Option<String>,
    /// 成为好友的时间，UTC 毫秒。
    #[ts(type = "number")]
    pub since: i64,
}

/// 我的全部好友。顺序不保证，由界面按名称排序。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendList {
    pub items: Vec<FriendView>,
}

/// 发出、同意或拒绝一条申请的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRequestResult {
    pub request: FriendRequestView,
    /// 这一步让两人成为了好友时，是新的这位好友。
    pub friend: Option<FriendView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetRemarkRequest {
    /// 留空即清除备注。
    pub remark: String,
}

/// 推送：一个人不再是我的好友了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendRemoved {
    pub user_id: String,
}

/// 推送：一个好友改了自己的资料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FriendProfile {
    pub user: UserCard,
    pub signature: String,
}
