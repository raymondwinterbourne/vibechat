//! 通讯录的业务流程：查找用户、好友申请、好友。

use std::collections::HashMap;
use std::sync::Arc;

use super::error::ContactError;
use super::model::{
    Friend, FriendRequest, FriendRequestStatus, Friendship, Relation, RequestEntry, UserCard,
};
use super::store::ContactStore;
use crate::account::guard::RateLimiter;
use crate::account::model::{User, UserStatus};
use crate::account::store::UserStore;
use crate::clock::Clock;
use crate::ids::{FriendRequestId, UserId};
use crate::store::StoreError;

/// 每个人每分钟最多查找多少次。按 ID 查找只支持精确匹配，再加上限速，没法用来枚举用户。
pub const LOOKUPS_PER_MINUTE: u32 = 30;
/// 每个人每小时最多发出多少次好友申请。
pub const REQUESTS_PER_HOUR: u32 = 30;
pub const REQUEST_MESSAGE_MAX_CHARS: usize = 50;
pub const REMARK_MAX_CHARS: usize = 32;

const MINUTE_MS: i64 = 60 * 1000;
const HOUR_MS: i64 = 60 * MINUTE_MS;

pub struct ContactServiceDeps {
    pub users: Arc<dyn UserStore>,
    pub contacts: Arc<dyn ContactStore>,
    pub clock: Arc<dyn Clock>,
}

/// 发出、同意或拒绝一条申请之后的结果：申请现在的样子，以及双方是谁。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestOutcome {
    pub request: FriendRequest,
    /// 申请方。
    pub from: UserCard,
    /// 接收方。
    pub to: UserCard,
    /// 这一步让两人成为了好友时，是两人各自眼里的对方。
    pub new_friends: Option<NewFriends>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFriends {
    /// 申请方的新好友，也就是接收方。
    pub of_requester: Friend,
    /// 接收方的新好友，也就是申请方。
    pub of_recipient: Friend,
}

pub struct ContactService {
    deps: ContactServiceDeps,
    lookups: RateLimiter,
    requests: RateLimiter,
}

impl ContactService {
    pub fn new(deps: ContactServiceDeps) -> Self {
        let lookups = RateLimiter::new(deps.clock.clone(), LOOKUPS_PER_MINUTE, MINUTE_MS);
        let requests = RateLimiter::new(deps.clock.clone(), REQUESTS_PER_HOUR, HOUR_MS);
        Self {
            deps,
            lookups,
            requests,
        }
    }

    /// 按 ID 精确查找一个用户，不区分大小写。返回他的名片，以及他和我的关系。
    pub async fn lookup(
        &self,
        me: &User,
        handle: &str,
    ) -> Result<(UserCard, Relation), ContactError> {
        limit(&self.lookups, me.id)?;
        let handle = handle.trim();
        if handle.is_empty() {
            return Err(ContactError::UserNotFound);
        }
        let found = self
            .deps
            .users
            .find_by_handle(handle)
            .await?
            .filter(is_active)
            .ok_or(ContactError::UserNotFound)?;
        let relation = relation_between(self.deps.contacts.as_ref(), me.id, found.id).await?;
        Ok((UserCard::from(&found), relation))
    }

    /// `from` 发给 `to` 的、还没有处理的那一条申请。
    async fn pending_between(
        &self,
        from: UserId,
        to: UserId,
    ) -> Result<Option<FriendRequest>, ContactError> {
        Ok(pending_between(self.deps.contacts.as_ref(), from, to).await?)
    }

    /// 向一个用户发好友申请。
    ///
    /// 已经向他申请过时，更新原来那一条。对方已经向我申请、还没有处理时，
    /// 我再向他申请就等于同意：两人直接成为好友。
    pub async fn send_request(
        &self,
        me: &User,
        to: UserId,
        message: &str,
    ) -> Result<RequestOutcome, ContactError> {
        if to == me.id {
            return Err(ContactError::CannotAddSelf);
        }
        let target = self
            .deps
            .users
            .find(to)
            .await?
            .filter(is_active)
            .ok_or(ContactError::UserNotFound)?;
        let message = single_line(message);
        if message.chars().count() > REQUEST_MESSAGE_MAX_CHARS {
            return Err(ContactError::MessageTooLong);
        }
        if self
            .deps
            .contacts
            .find_friendship(me.id, to)
            .await?
            .is_some()
        {
            return Err(ContactError::AlreadyFriends);
        }
        limit(&self.requests, me.id)?;

        let now = self.deps.clock.now_ms();
        if let Some(theirs) = self.pending_between(to, me.id).await? {
            return self.accept_pending(theirs, &target, me, now).await;
        }
        let request = self
            .deps
            .contacts
            .save_request(&FriendRequest {
                id: FriendRequestId::new(),
                from: me.id,
                to,
                message,
                status: FriendRequestStatus::Pending,
                sent_at: now,
                handled_at: None,
            })
            .await?;
        Ok(RequestOutcome {
            request,
            from: UserCard::from(me),
            to: UserCard::from(&target),
            new_friends: None,
        })
    }

    /// 我收到的和发出的全部申请，最近的在前。
    pub async fn list_requests(&self, me: &User) -> Result<Vec<RequestEntry>, ContactError> {
        let requests = self.deps.contacts.list_requests(me.id).await?;
        let others: Vec<UserId> = requests
            .iter()
            .map(|request| other_party(request, me.id))
            .collect();
        let users = self.users_by_id(&others).await?;
        Ok(requests
            .into_iter()
            .filter_map(|request| {
                let other = users.get(&other_party(&request, me.id))?;
                Some(RequestEntry {
                    other: UserCard::from(other),
                    request,
                })
            })
            .collect())
    }

    /// 同意一条发给我的申请，两人成为好友。
    pub async fn accept_request(
        &self,
        me: &User,
        id: FriendRequestId,
    ) -> Result<RequestOutcome, ContactError> {
        let request = self.incoming_pending(me, id).await?;
        let requester = self
            .deps
            .users
            .find(request.from)
            .await?
            .ok_or(ContactError::UserNotFound)?;
        let now = self.deps.clock.now_ms();
        self.accept_pending(request, &requester, me, now).await
    }

    async fn accept_pending(
        &self,
        request: FriendRequest,
        requester: &User,
        recipient: &User,
        now: i64,
    ) -> Result<RequestOutcome, ContactError> {
        if !self.deps.contacts.accept_request(request.id, now).await? {
            // 就在这一刻被另一处登录处理掉了
            return Err(ContactError::RequestHandled);
        }
        let friend = |user: &User| Friend {
            card: UserCard::from(user),
            signature: user.signature.clone(),
            remark: None,
            since: now,
        };
        Ok(RequestOutcome {
            request: FriendRequest {
                status: FriendRequestStatus::Accepted,
                handled_at: Some(now),
                ..request
            },
            from: UserCard::from(requester),
            to: UserCard::from(recipient),
            new_friends: Some(NewFriends {
                of_requester: friend(recipient),
                of_recipient: friend(requester),
            }),
        })
    }

    /// 拒绝一条发给我的申请。
    pub async fn reject_request(
        &self,
        me: &User,
        id: FriendRequestId,
    ) -> Result<RequestOutcome, ContactError> {
        let request = self.incoming_pending(me, id).await?;
        let requester = self
            .deps
            .users
            .find(request.from)
            .await?
            .ok_or(ContactError::UserNotFound)?;
        let now = self.deps.clock.now_ms();
        if !self.deps.contacts.reject_request(id, now).await? {
            return Err(ContactError::RequestHandled);
        }
        Ok(RequestOutcome {
            request: FriendRequest {
                status: FriendRequestStatus::Rejected,
                handled_at: Some(now),
                ..request
            },
            from: UserCard::from(&requester),
            to: UserCard::from(me),
            new_friends: None,
        })
    }

    /// 一条发给我、还没有处理的申请。发给别人的申请当作不存在。
    async fn incoming_pending(
        &self,
        me: &User,
        id: FriendRequestId,
    ) -> Result<FriendRequest, ContactError> {
        let request = self
            .deps
            .contacts
            .find_request(id)
            .await?
            .filter(|request| request.to == me.id)
            .ok_or(ContactError::RequestNotFound)?;
        if request.status != FriendRequestStatus::Pending {
            return Err(ContactError::RequestHandled);
        }
        Ok(request)
    }

    /// 我的全部好友。顺序不保证，由界面按名称排序。
    pub async fn list_friends(&self, me: &User) -> Result<Vec<Friend>, ContactError> {
        let friendships = self.deps.contacts.list_friendships(me.id).await?;
        let ids: Vec<UserId> = friendships.iter().map(|f| f.friend).collect();
        let users = self.users_by_id(&ids).await?;
        Ok(friendships
            .iter()
            .filter_map(|friendship| Some(friend_of(friendship, users.get(&friendship.friend)?)))
            .collect())
    }

    /// 一个好友的资料。不是好友的人看不到。
    pub async fn friend(&self, me: &User, id: UserId) -> Result<Friend, ContactError> {
        let friendship = self
            .deps
            .contacts
            .find_friendship(me.id, id)
            .await?
            .ok_or(ContactError::NotFriends)?;
        let user = self
            .deps
            .users
            .find(id)
            .await?
            .ok_or(ContactError::NotFriends)?;
        Ok(friend_of(&friendship, &user))
    }

    /// 给好友设置备注名；留空则清除。备注只有我自己看得到。
    pub async fn set_remark(
        &self,
        me: &User,
        friend: UserId,
        remark: &str,
    ) -> Result<Friend, ContactError> {
        let remark = single_line(remark);
        if remark.chars().count() > REMARK_MAX_CHARS {
            return Err(ContactError::RemarkTooLong);
        }
        let remark = (!remark.is_empty()).then_some(remark.as_str());
        if !self.deps.contacts.set_remark(me.id, friend, remark).await? {
            return Err(ContactError::NotFriends);
        }
        self.friend(me, friend).await
    }

    /// 删除好友。之后双方都不再是对方的好友。
    pub async fn remove_friend(&self, me: &User, friend: UserId) -> Result<(), ContactError> {
        if !self.deps.contacts.remove_friendship(me.id, friend).await? {
            return Err(ContactError::NotFriends);
        }
        Ok(())
    }

    /// 一个用户的全部好友是谁。他的资料变了要通知这些人。
    pub async fn friend_ids(&self, user: UserId) -> Result<Vec<UserId>, ContactError> {
        let friendships = self.deps.contacts.list_friendships(user).await?;
        Ok(friendships.iter().map(|f| f.friend).collect())
    }

    async fn users_by_id(&self, ids: &[UserId]) -> Result<HashMap<UserId, User>, ContactError> {
        let users = self.deps.users.find_many(ids).await?;
        Ok(users.into_iter().map(|user| (user.id, user)).collect())
    }
}

/// `other` 和 `me` 是什么关系。
pub async fn relation_between(
    contacts: &dyn ContactStore,
    me: UserId,
    other: UserId,
) -> Result<Relation, StoreError> {
    if me == other {
        return Ok(Relation::Myself);
    }
    if contacts.find_friendship(me, other).await?.is_some() {
        return Ok(Relation::Friend);
    }
    if pending_between(contacts, me, other).await?.is_some() {
        return Ok(Relation::RequestSent);
    }
    if let Some(request) = pending_between(contacts, other, me).await? {
        return Ok(Relation::RequestReceived(request.id));
    }
    Ok(Relation::None)
}

async fn pending_between(
    contacts: &dyn ContactStore,
    from: UserId,
    to: UserId,
) -> Result<Option<FriendRequest>, StoreError> {
    Ok(contacts
        .find_request_between(from, to)
        .await?
        .filter(|request| request.status == FriendRequestStatus::Pending))
}

fn is_active(user: &User) -> bool {
    user.status == UserStatus::Active
}

fn other_party(request: &FriendRequest, me: UserId) -> UserId {
    if request.from == me {
        request.to
    } else {
        request.from
    }
}

fn friend_of(friendship: &Friendship, user: &User) -> Friend {
    Friend {
        card: UserCard::from(user),
        signature: user.signature.clone(),
        remark: friendship.remark.clone(),
        since: friendship.created_at,
    }
}

/// 验证信息和备注名都是一行字：去掉换行等控制字符和首尾的空白。
fn single_line(text: &str) -> String {
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    text.trim().to_owned()
}

fn limit(limiter: &RateLimiter, user: UserId) -> Result<(), ContactError> {
    limiter
        .hit(&user.to_string())
        .map_err(|wait_ms| ContactError::RateLimited {
            retry_after_secs: (wait_ms as u64).div_ceil(1000),
        })
}
