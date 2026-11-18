//! 通讯录相关的两张表：好友申请、好友关系。

use async_trait::async_trait;
use sea_orm::sea_query::{Expr, OnConflict};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter,
    QueryOrder, TransactionTrait,
};
use vibechat_core::contact::model::{FriendRequest, FriendRequestStatus, Friendship};
use vibechat_core::contact::store::ContactStore;
use vibechat_core::{FriendRequestId, StoreError, UserId};

use super::entities::{friend_requests, friendships};
use super::{corrupt, parse_id, unavailable};

pub struct DbContacts {
    db: DatabaseConnection,
}

impl DbContacts {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}

fn request_from(row: friend_requests::Model) -> Result<FriendRequest, StoreError> {
    Ok(FriendRequest {
        id: parse_id(&row.id, "friend_requests.id")?,
        from: parse_id(&row.from_user, "friend_requests.from_user")?,
        to: parse_id(&row.to_user, "friend_requests.to_user")?,
        message: row.message,
        status: FriendRequestStatus::parse(&row.status)
            .ok_or_else(|| corrupt("friend_requests.status"))?,
        sent_at: row.sent_at,
        handled_at: row.handled_at,
    })
}

fn friendship_from(row: friendships::Model) -> Result<Friendship, StoreError> {
    Ok(Friendship {
        user: parse_id(&row.user_id, "friendships.user_id")?,
        friend: parse_id(&row.friend_id, "friendships.friend_id")?,
        remark: row.remark,
        created_at: row.created_at,
    })
}

/// 一条申请是否还在待处理。
fn pending() -> sea_orm::sea_query::SimpleExpr {
    friend_requests::Column::Status.eq(FriendRequestStatus::Pending.as_str())
}

#[async_trait]
impl ContactStore for DbContacts {
    async fn save_request(&self, request: &FriendRequest) -> Result<FriendRequest, StoreError> {
        let row = friend_requests::ActiveModel {
            id: Set(request.id.to_string()),
            from_user: Set(request.from.to_string()),
            to_user: Set(request.to.to_string()),
            message: Set(request.message.clone()),
            status: Set(request.status.as_str().to_owned()),
            sent_at: Set(request.sent_at),
            handled_at: Set(request.handled_at),
        };
        // 这一对申请方、接收方已经有一行时，改的是那一行，编号不变
        friend_requests::Entity::insert(row)
            .on_conflict(
                OnConflict::columns([
                    friend_requests::Column::FromUser,
                    friend_requests::Column::ToUser,
                ])
                .update_columns([
                    friend_requests::Column::Message,
                    friend_requests::Column::Status,
                    friend_requests::Column::SentAt,
                    friend_requests::Column::HandledAt,
                ])
                .to_owned(),
            )
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        self.find_request_between(request.from, request.to)
            .await?
            .ok_or_else(|| corrupt("friend request vanished right after it was saved"))
    }

    async fn find_request(&self, id: FriendRequestId) -> Result<Option<FriendRequest>, StoreError> {
        friend_requests::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(request_from)
            .transpose()
    }

    async fn find_request_between(
        &self,
        from: UserId,
        to: UserId,
    ) -> Result<Option<FriendRequest>, StoreError> {
        friend_requests::Entity::find()
            .filter(friend_requests::Column::FromUser.eq(from.to_string()))
            .filter(friend_requests::Column::ToUser.eq(to.to_string()))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(request_from)
            .transpose()
    }

    async fn list_requests(&self, user: UserId) -> Result<Vec<FriendRequest>, StoreError> {
        let user = user.to_string();
        friend_requests::Entity::find()
            .filter(
                Condition::any()
                    .add(friend_requests::Column::FromUser.eq(user.as_str()))
                    .add(friend_requests::Column::ToUser.eq(user.as_str())),
            )
            .order_by_desc(friend_requests::Column::SentAt)
            .order_by_desc(friend_requests::Column::Id)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(request_from)
            .collect()
    }

    async fn accept_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError> {
        // 双方是谁先在事务外查好：事务里的第一条语句就是写入，
        // 这样 SQLite 一开始就拿写锁，不会出现两个事务都先读后写、互相卡住的情况
        let Some(request) = self.find_request(id).await? else {
            return Ok(false);
        };
        let (from, to) = (request.from.to_string(), request.to.to_string());
        let accepted = || {
            friend_requests::Entity::update_many()
                .col_expr(
                    friend_requests::Column::Status,
                    Expr::value(FriendRequestStatus::Accepted.as_str()),
                )
                .col_expr(friend_requests::Column::HandledAt, Expr::value(now))
                .filter(pending())
        };

        let txn = self.db.begin().await.map_err(unavailable)?;
        // 只有仍然待处理的才会被改到：两处同时同意时，只有一处能改到这一行
        let claimed = accepted()
            .filter(friend_requests::Column::Id.eq(id.to_string()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if claimed.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Ok(false);
        }
        // 对方同时发来的那一条也算处理过了
        accepted()
            .filter(friend_requests::Column::FromUser.eq(to.as_str()))
            .filter(friend_requests::Column::ToUser.eq(from.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        for (user, friend) in [(&from, &to), (&to, &from)] {
            let row = friendships::ActiveModel {
                user_id: Set(user.clone()),
                friend_id: Set(friend.clone()),
                remark: Set(None),
                created_at: Set(now),
            };
            friendships::Entity::insert(row)
                .on_conflict_do_nothing()
                .exec_without_returning(&txn)
                .await
                .map_err(unavailable)?;
        }
        txn.commit().await.map_err(unavailable)?;
        Ok(true)
    }

    async fn reject_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError> {
        let result = friend_requests::Entity::update_many()
            .col_expr(
                friend_requests::Column::Status,
                Expr::value(FriendRequestStatus::Rejected.as_str()),
            )
            .col_expr(friend_requests::Column::HandledAt, Expr::value(now))
            .filter(friend_requests::Column::Id.eq(id.to_string()))
            .filter(pending())
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected == 1)
    }

    async fn find_friendship(
        &self,
        user: UserId,
        friend: UserId,
    ) -> Result<Option<Friendship>, StoreError> {
        friendships::Entity::find_by_id((user.to_string(), friend.to_string()))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(friendship_from)
            .transpose()
    }

    async fn list_friendships(&self, user: UserId) -> Result<Vec<Friendship>, StoreError> {
        friendships::Entity::find()
            .filter(friendships::Column::UserId.eq(user.to_string()))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(friendship_from)
            .collect()
    }

    async fn set_remark(
        &self,
        user: UserId,
        friend: UserId,
        remark: Option<&str>,
    ) -> Result<bool, StoreError> {
        let result = friendships::Entity::update_many()
            .col_expr(
                friendships::Column::Remark,
                Expr::value(remark.map(str::to_owned)),
            )
            .filter(friendships::Column::UserId.eq(user.to_string()))
            .filter(friendships::Column::FriendId.eq(friend.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected == 1)
    }

    async fn remove_friendship(&self, a: UserId, b: UserId) -> Result<bool, StoreError> {
        let (a, b) = (a.to_string(), b.to_string());
        let one_way = |user: &str, friend: &str| {
            Condition::all()
                .add(friendships::Column::UserId.eq(user))
                .add(friendships::Column::FriendId.eq(friend))
        };
        // 一条语句删掉两个方向，不会只删掉一半
        let result = friendships::Entity::delete_many()
            .filter(Condition::any().add(one_way(&a, &b)).add(one_way(&b, &a)))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected > 0)
    }
}
