//! 好友申请和好友关系的数据操作，在 SQLite 和 Postgres 上各跑一遍。

mod common;

use std::sync::atomic::{AtomicU64, Ordering};

use vibechat_core::account::model::{InviteCode, InviteCodeStatus, Role, User, UserStatus};
use vibechat_core::contact::model::{FriendRequest, FriendRequestStatus, Friendship};
use vibechat_core::{FriendRequestId, InviteCodeId, Stores, UserId};

const NOW: i64 = 1_700_000_000_000;

/// 注册一个用户。两张表都有指向用户表的外键，用户必须真的存在。
async fn user(stores: &Stores, handle: &str) -> User {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let code = InviteCode {
        id: InviteCodeId::new(),
        code: format!("CODE{:012}", NEXT.fetch_add(1, Ordering::Relaxed)),
        note: None,
        status: InviteCodeStatus::Unused,
        expires_at: None,
        created_by: UserId::new(),
        created_at: NOW,
        used_by: None,
        used_at: None,
    };
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();
    let user = User {
        id: UserId::new(),
        handle: handle.to_owned(),
        nickname: handle.to_owned(),
        signature: String::new(),
        avatar: None,
        password_hash: "hash".to_owned(),
        role: Role::User,
        status: UserStatus::Active,
        must_change_password: false,
        email: None,
        language: None,
        theme: None,
        created_at: NOW,
        last_login_at: None,
    };
    stores
        .users
        .create_with_invite(&user, code.id, NOW)
        .await
        .unwrap();
    user
}

fn request(from: &User, to: &User, message: &str, sent_at: i64) -> FriendRequest {
    FriendRequest {
        id: FriendRequestId::new(),
        from: from.id,
        to: to.id,
        message: message.to_owned(),
        status: FriendRequestStatus::Pending,
        sent_at,
        handled_at: None,
    }
}

async fn status(stores: &Stores, id: FriendRequestId) -> FriendRequestStatus {
    stores
        .contacts
        .find_request(id)
        .await
        .unwrap()
        .unwrap()
        .status
}

/// 一个用户这一边的好友是谁，按编号排好。
async fn friends_of(stores: &Stores, user: &User) -> Vec<UserId> {
    let mut ids: Vec<UserId> = stores
        .contacts
        .list_friendships(user.id)
        .await
        .unwrap()
        .iter()
        .map(|friendship| friendship.friend)
        .collect();
    ids.sort();
    ids
}

async fn requests_are_saved_found_and_listed(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );
    let contacts = &stores.contacts;

    let a_to_b = request(&a, &b, "我是 A", NOW);
    assert_eq!(contacts.save_request(&a_to_b).await.unwrap(), a_to_b);
    let c_to_a = request(&c, &a, "", NOW + 1);
    contacts.save_request(&c_to_a).await.unwrap();
    let b_to_c = request(&b, &c, "", NOW + 2);
    contacts.save_request(&b_to_c).await.unwrap();

    assert_eq!(
        contacts.find_request(a_to_b.id).await.unwrap(),
        Some(a_to_b.clone())
    );
    assert_eq!(
        contacts.find_request(FriendRequestId::new()).await.unwrap(),
        None
    );
    // 方向是有区别的
    assert_eq!(
        contacts.find_request_between(a.id, b.id).await.unwrap(),
        Some(a_to_b.clone())
    );
    assert_eq!(
        contacts.find_request_between(b.id, a.id).await.unwrap(),
        None
    );

    // 收到的和发出的都在，最近发出的在前；与自己无关的不在
    assert_eq!(
        contacts.list_requests(a.id).await.unwrap(),
        vec![c_to_a, a_to_b]
    );
    assert_eq!(contacts.list_requests(UserId::new()).await.unwrap(), vec![]);
}

async fn saving_again_updates_the_one_row_for_the_pair(stores: Stores) {
    let (a, b) = (user(&stores, "user_a").await, user(&stores, "user_b").await);
    let contacts = &stores.contacts;

    let first = contacts
        .save_request(&request(&a, &b, "第一次", NOW))
        .await
        .unwrap();
    assert!(contacts.reject_request(first.id, NOW + 1).await.unwrap());

    // 再次申请：编号还是原来的，其余都换成新的，回到待处理
    let again = request(&a, &b, "第二次", NOW + 2);
    let saved = contacts.save_request(&again).await.unwrap();
    assert_eq!(
        saved,
        FriendRequest {
            id: first.id,
            ..again
        }
    );
    assert_eq!(contacts.list_requests(a.id).await.unwrap(), vec![saved]);

    // 反方向的是另一条
    let reverse = contacts
        .save_request(&request(&b, &a, "", NOW + 3))
        .await
        .unwrap();
    assert_ne!(reverse.id, first.id);
    assert_eq!(contacts.list_requests(a.id).await.unwrap().len(), 2);
}

async fn accepting_makes_both_friends(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );
    let contacts = &stores.contacts;
    let a_to_b = contacts
        .save_request(&request(&a, &b, "", NOW))
        .await
        .unwrap();
    // 对方同时也发来了一条；另有一条与这两个人无关的
    let b_to_a = contacts
        .save_request(&request(&b, &a, "", NOW))
        .await
        .unwrap();
    let c_to_a = contacts
        .save_request(&request(&c, &a, "", NOW))
        .await
        .unwrap();

    assert!(contacts.accept_request(a_to_b.id, NOW + 5).await.unwrap());

    let accepted = contacts.find_request(a_to_b.id).await.unwrap().unwrap();
    assert_eq!(accepted.status, FriendRequestStatus::Accepted);
    assert_eq!(accepted.handled_at, Some(NOW + 5));
    assert_eq!(
        status(&stores, b_to_a.id).await,
        FriendRequestStatus::Accepted,
        "the crossing request is settled too"
    );
    assert_eq!(
        status(&stores, c_to_a.id).await,
        FriendRequestStatus::Pending
    );

    for (user, friend) in [(&a, &b), (&b, &a)] {
        assert_eq!(
            contacts.find_friendship(user.id, friend.id).await.unwrap(),
            Some(Friendship {
                user: user.id,
                friend: friend.id,
                remark: None,
                created_at: NOW + 5,
            })
        );
    }
    assert_eq!(contacts.find_friendship(a.id, c.id).await.unwrap(), None);

    // 已经处理过的、不存在的：什么也不改
    assert!(!contacts.accept_request(a_to_b.id, NOW + 9).await.unwrap());
    assert!(!contacts.reject_request(a_to_b.id, NOW + 9).await.unwrap());
    assert!(
        !contacts
            .accept_request(FriendRequestId::new(), NOW)
            .await
            .unwrap()
    );
    assert_eq!(
        contacts.find_request(a_to_b.id).await.unwrap(),
        Some(accepted)
    );
}

async fn when_a_request_is_accepted_many_times_at_once_exactly_one_succeeds(stores: Stores) {
    let (a, b) = (user(&stores, "user_a").await, user(&stores, "user_b").await);
    let saved = stores
        .contacts
        .save_request(&request(&a, &b, "", NOW))
        .await
        .unwrap();

    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let stores = stores.clone();
            tokio::spawn(async move { stores.contacts.accept_request(saved.id, NOW).await })
        })
        .collect();
    let mut wins = 0;
    for attempt in attempts {
        if attempt.await.unwrap().unwrap() {
            wins += 1;
        }
    }
    assert_eq!(wins, 1, "exactly one acceptance wins");
    assert_eq!(friends_of(&stores, &a).await, [b.id]);
    assert_eq!(friends_of(&stores, &b).await, [a.id]);
}

async fn rejecting_changes_only_a_pending_request(stores: Stores) {
    let (a, b) = (user(&stores, "user_a").await, user(&stores, "user_b").await);
    let contacts = &stores.contacts;
    let saved = contacts
        .save_request(&request(&a, &b, "", NOW))
        .await
        .unwrap();

    assert!(contacts.reject_request(saved.id, NOW + 3).await.unwrap());
    let rejected = contacts.find_request(saved.id).await.unwrap().unwrap();
    assert_eq!(rejected.status, FriendRequestStatus::Rejected);
    assert_eq!(rejected.handled_at, Some(NOW + 3));
    assert!(friends_of(&stores, &a).await.is_empty());

    assert!(!contacts.reject_request(saved.id, NOW + 4).await.unwrap());
    assert!(!contacts.accept_request(saved.id, NOW + 4).await.unwrap());
    assert!(
        !contacts
            .reject_request(FriendRequestId::new(), NOW)
            .await
            .unwrap()
    );
    assert_eq!(
        contacts.find_request(saved.id).await.unwrap(),
        Some(rejected)
    );
    assert!(friends_of(&stores, &a).await.is_empty());
}

/// 让两个人成为好友。
async fn befriend(stores: &Stores, a: &User, b: &User) {
    let saved = stores
        .contacts
        .save_request(&request(a, b, "", NOW))
        .await
        .unwrap();
    assert!(stores.contacts.accept_request(saved.id, NOW).await.unwrap());
}

async fn a_remark_belongs_to_one_side(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );
    let contacts = &stores.contacts;
    befriend(&stores, &a, &b).await;

    assert!(contacts.set_remark(a.id, b.id, Some("老 B")).await.unwrap());
    let remark = |user: &User, friend: &User| {
        let (user, friend) = (user.id, friend.id);
        async move {
            contacts
                .find_friendship(user, friend)
                .await
                .unwrap()
                .unwrap()
                .remark
        }
    };
    assert_eq!(remark(&a, &b).await.as_deref(), Some("老 B"));
    assert_eq!(remark(&b, &a).await, None, "the other side is untouched");

    assert!(contacts.set_remark(a.id, b.id, None).await.unwrap());
    assert_eq!(remark(&a, &b).await, None);

    // 不是好友：什么也不改
    assert!(!contacts.set_remark(a.id, c.id, Some("x")).await.unwrap());
    assert_eq!(contacts.find_friendship(a.id, c.id).await.unwrap(), None);
}

async fn removing_deletes_both_directions(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );
    let contacts = &stores.contacts;
    befriend(&stores, &a, &b).await;
    befriend(&stores, &a, &c).await;
    befriend(&stores, &c, &b).await;
    let mut expected = [b.id, c.id];
    expected.sort();
    assert_eq!(friends_of(&stores, &a).await, expected);

    // 由哪一方发起都一样
    assert!(contacts.remove_friendship(b.id, a.id).await.unwrap());
    assert_eq!(friends_of(&stores, &a).await, [c.id]);
    assert_eq!(friends_of(&stores, &b).await, [c.id]);
    let mut expected = [a.id, b.id];
    expected.sort();
    assert_eq!(
        friends_of(&stores, &c).await,
        expected,
        "other friendships are kept"
    );

    assert!(!contacts.remove_friendship(a.id, b.id).await.unwrap());
    assert!(
        !contacts
            .remove_friendship(a.id, UserId::new())
            .await
            .unwrap()
    );

    // 删除之后可以重新成为好友
    let again = contacts
        .save_request(&request(&a, &b, "", NOW + 10))
        .await
        .unwrap();
    assert!(contacts.accept_request(again.id, NOW + 11).await.unwrap());
    let mut expected = [b.id, c.id];
    expected.sort();
    assert_eq!(friends_of(&stores, &a).await, expected);
}

async fn several_users_are_fetched_at_once(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );

    let mut found = stores
        .users
        .find_many(&[c.id, a.id, UserId::new()])
        .await
        .unwrap();
    found.sort_by_key(|user| user.handle.clone());
    assert_eq!(found, vec![a, c]);
    assert_eq!(stores.users.find_many(&[]).await.unwrap(), vec![]);
    assert_eq!(stores.users.find_many(&[b.id]).await.unwrap(), vec![b]);
}

on_both_databases!(request_basics, requests_are_saved_found_and_listed);
on_both_databases!(
    request_resend,
    saving_again_updates_the_one_row_for_the_pair
);
on_both_databases!(accept, accepting_makes_both_friends);
on_both_databases!(
    accept_race,
    when_a_request_is_accepted_many_times_at_once_exactly_one_succeeds
);
on_both_databases!(reject, rejecting_changes_only_a_pending_request);
on_both_databases!(remark, a_remark_belongs_to_one_side);
on_both_databases!(remove, removing_deletes_both_directions);
on_both_databases!(find_many_users, several_users_are_fetched_at_once);
