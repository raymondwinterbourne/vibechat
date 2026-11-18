use crate::account::model::{User, string_enum};
use crate::ids::{FileId, FriendRequestId, UserId};

string_enum!(FriendRequestStatus {
    Pending => "pending",
    Accepted => "accepted",
    Rejected => "rejected",
});

/// 一条好友申请。同一对"申请方、接收方"只有一条：再次申请时改的是原来那一条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FriendRequest {
    pub id: FriendRequestId,
    pub from: UserId,
    pub to: UserId,
    /// 验证信息，可以为空。
    pub message: String,
    pub status: FriendRequestStatus,
    /// 最近一次发出的时间。
    pub sent_at: i64,
    pub handled_at: Option<i64>,
}

/// 好友关系里一个人这一边的记录。两个人互为好友时有两条，各自保存自己给对方起的备注名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Friendship {
    pub user: UserId,
    pub friend: UserId,
    pub remark: Option<String>,
    pub created_at: i64,
}

/// 任何登录用户都能看到的资料：按 ID 查找的结果、好友申请里的对方。
/// 不含个性签名，那是好友才能看到的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserCard {
    pub id: UserId,
    pub handle: String,
    pub nickname: String,
    pub avatar: Option<FileId>,
}

impl From<&User> for UserCard {
    fn from(user: &User) -> Self {
        Self {
            id: user.id,
            handle: user.handle.clone(),
            nickname: user.nickname.clone(),
            avatar: user.avatar,
        }
    }
}

/// 我的一个好友：他的资料，加上我给他起的备注名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Friend {
    pub card: UserCard,
    pub signature: String,
    pub remark: Option<String>,
    /// 成为好友的时间。
    pub since: i64,
}

/// 查找到的人和我是什么关系。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Relation {
    /// 就是我自己。
    Myself,
    Friend,
    /// 我向他发过申请，他还没有处理。
    RequestSent,
    /// 他向我发过申请，我还没有处理。带上这条申请，可以直接同意。
    RequestReceived(FriendRequestId),
    None,
}

/// 申请列表里的一项：申请本身，加上对方是谁。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestEntry {
    pub request: FriendRequest,
    pub other: UserCard,
}
