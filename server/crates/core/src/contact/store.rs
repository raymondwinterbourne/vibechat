//! 通讯录相关的数据操作。实现在 `vibechat-infra`。

use async_trait::async_trait;

use super::model::{FriendRequest, Friendship};
use crate::ids::{FriendRequestId, UserId};
use crate::store::StoreError;

#[async_trait]
pub trait ContactStore: Send + Sync {
    /// 保存一条待处理的申请，返回保存后的样子。
    /// 同一对"申请方、接收方"只有一行：已经有了就把它改回待处理，更新验证信息和时间，编号不变。
    async fn save_request(&self, request: &FriendRequest) -> Result<FriendRequest, StoreError>;

    async fn find_request(&self, id: FriendRequestId) -> Result<Option<FriendRequest>, StoreError>;

    /// `from` 发给 `to` 的那一条申请。
    async fn find_request_between(
        &self,
        from: UserId,
        to: UserId,
    ) -> Result<Option<FriendRequest>, StoreError>;

    /// 一个用户收到的和发出的全部申请，最近发出的在前。
    async fn list_requests(&self, user: UserId) -> Result<Vec<FriendRequest>, StoreError>;

    /// 同意一条待处理的申请：把它标为已同意，并让双方互为好友。
    /// 这几件事要么都成功要么都不发生；对方同时发来的待处理申请也一并标为已同意。
    /// 申请已经不是待处理时什么也不改，返回 `false`。
    async fn accept_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError>;

    /// 拒绝一条待处理的申请。已经不是待处理时什么也不改，返回 `false`。
    async fn reject_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError>;

    /// `user` 这一边的好友记录；两人不是好友时为空。
    async fn find_friendship(
        &self,
        user: UserId,
        friend: UserId,
    ) -> Result<Option<Friendship>, StoreError>;

    /// 一个用户的全部好友（他这一边的记录）。
    async fn list_friendships(&self, user: UserId) -> Result<Vec<Friendship>, StoreError>;

    /// 设置或清除备注名，只改 `user` 这一边。两人不是好友时返回 `false`。
    async fn set_remark(
        &self,
        user: UserId,
        friend: UserId,
        remark: Option<&str>,
    ) -> Result<bool, StoreError>;

    /// 解除好友关系，两个方向一起删掉。本来就不是好友时返回 `false`。
    async fn remove_friendship(&self, a: UserId, b: UserId) -> Result<bool, StoreError>;
}
