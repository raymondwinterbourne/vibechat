//! 通讯录业务流程的测试。数据在内存里，时间可以拨动，不需要数据库。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use super::service::{
    LOOKUPS_PER_MINUTE, REMARK_MAX_CHARS, REQUEST_MESSAGE_MAX_CHARS, REQUESTS_PER_HOUR,
};
use super::{ContactError, ContactService, FriendRequestStatus, Relation};
use crate::account::model::{User, UserStatus};
use crate::account::{AccountService, Limits, Registration};
use crate::ids::{FriendRequestId, UserId};
use crate::testing::{ManualClock, MemoryStore, account_service, contact_service};

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    accounts: AccountService,
    contacts: ContactService,
    registered: AtomicU32,
}

async fn fixture() -> Fixture {
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let limits = Limits {
        logins_per_minute: 1000,
        registrations_per_minute: 1000,
    };
    Fixture {
        accounts: account_service(&store, clock.clone(), limits).await,
        contacts: contact_service(&store, clock.clone()),
        store,
        clock,
        registered: AtomicU32::new(0),
    }
}

impl Fixture {
    /// 注册一个新用户。
    async fn user(&self, nickname: &str) -> User {
        let code = format!(
            "CODE{:012}",
            self.registered.fetch_add(1, Ordering::Relaxed)
        );
        self.store.add_invite_code(&code, UserId::new());
        self.accounts
            .register(Registration {
                invite_code: &code,
                nickname,
                password: "correct-horse-1",
                user_agent: "test",
                source: "10.0.0.1",
            })
            .await
            .unwrap()
            .user
    }

    /// 让两个人成为好友：a 申请，b 同意。
    async fn befriend(&self, a: &User, b: &User) {
        let sent = self.contacts.send_request(a, b.id, "").await.unwrap();
        self.contacts
            .accept_request(b, sent.request.id)
            .await
            .unwrap();
    }

    async fn friend_ids(&self, user: &User) -> Vec<UserId> {
        let mut ids: Vec<UserId> = self
            .contacts
            .list_friends(user)
            .await
            .unwrap()
            .iter()
            .map(|friend| friend.card.id)
            .collect();
        ids.sort();
        ids
    }
}

// ---------- 查找 ----------

#[tokio::test]
async fn a_user_is_found_by_exact_handle_ignoring_case() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let (card, relation) = f
        .contacts
        .lookup(&a, &format!("  {}  ", b.handle.to_uppercase()))
        .await
        .unwrap();
    assert_eq!((card.id, card.nickname.as_str()), (b.id, "小红"));
    assert_eq!(card.handle, b.handle, "the handle keeps its own case");
    assert_eq!(relation, Relation::None);

    // 只支持精确匹配：少一位、空的都找不到
    for handle in [&b.handle[..b.handle.len() - 1], "", "   "] {
        let err = f.contacts.lookup(&a, handle).await.unwrap_err();
        assert!(matches!(err, ContactError::UserNotFound), "{handle:?}");
    }
}

#[tokio::test]
async fn lookup_tells_how_the_found_user_relates_to_me() {
    let f = fixture().await;
    let (a, b, c) = (
        f.user("小明").await,
        f.user("小红").await,
        f.user("小刚").await,
    );
    let relation = |me: &User, other: &User| {
        let (me, handle) = (me.clone(), other.handle.clone());
        let contacts = &f.contacts;
        async move { contacts.lookup(&me, &handle).await.unwrap().1 }
    };

    assert_eq!(relation(&a, &a).await, Relation::Myself);
    assert_eq!(relation(&a, &b).await, Relation::None);

    let sent = f.contacts.send_request(&a, b.id, "").await.unwrap();
    assert_eq!(relation(&a, &b).await, Relation::RequestSent);
    assert_eq!(
        relation(&b, &a).await,
        Relation::RequestReceived(sent.request.id)
    );
    assert_eq!(
        relation(&c, &a).await,
        Relation::None,
        "others are unaffected"
    );

    f.contacts
        .accept_request(&b, sent.request.id)
        .await
        .unwrap();
    assert_eq!(relation(&a, &b).await, Relation::Friend);
    assert_eq!(relation(&b, &a).await, Relation::Friend);

    // 被拒绝之后回到没有关系
    let sent = f.contacts.send_request(&a, c.id, "").await.unwrap();
    f.contacts
        .reject_request(&c, sent.request.id)
        .await
        .unwrap();
    assert_eq!(relation(&a, &c).await, Relation::None);
    assert_eq!(relation(&c, &a).await, Relation::None);
}

#[tokio::test]
async fn a_disabled_user_cannot_be_found_or_sent_a_request() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);
    f.store
        .edit_user(b.id, |user| user.status = UserStatus::Disabled);

    let err = f.contacts.lookup(&a, &b.handle).await.unwrap_err();
    assert!(matches!(err, ContactError::UserNotFound));
    let err = f.contacts.send_request(&a, b.id, "").await.unwrap_err();
    assert!(matches!(err, ContactError::UserNotFound));
}

#[tokio::test]
async fn lookups_are_rate_limited_per_user() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    for _ in 0..LOOKUPS_PER_MINUTE {
        // 找不到的也算次数，否则可以用来不停地试
        let _ = f.contacts.lookup(&a, "nobody_here").await;
    }
    let err = f.contacts.lookup(&a, &b.handle).await.unwrap_err();
    assert!(matches!(
        err,
        ContactError::RateLimited { retry_after_secs } if retry_after_secs > 0 && retry_after_secs <= 60
    ));
    // 只限制他自己
    assert!(f.contacts.lookup(&b, &a.handle).await.is_ok());

    f.clock.advance(60 * 1000);
    assert!(f.contacts.lookup(&a, &b.handle).await.is_ok());
}

// ---------- 好友申请 ----------

#[tokio::test]
async fn a_request_reaches_the_recipient_and_accepting_makes_both_friends() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let sent = f
        .contacts
        .send_request(&a, b.id, "  我是小明\n ")
        .await
        .unwrap();
    assert_eq!(sent.request.status, FriendRequestStatus::Pending);
    assert_eq!(sent.request.message, "我是小明", "trimmed to a single line");
    assert_eq!((sent.from.id, sent.to.id), (a.id, b.id));
    assert!(sent.new_friends.is_none());

    // 双方的申请列表里都有它，对方各是谁
    let received = f.contacts.list_requests(&b).await.unwrap();
    assert_eq!(received.len(), 1);
    assert_eq!(received[0].request, sent.request);
    assert_eq!(received[0].other.id, a.id);
    let outgoing = f.contacts.list_requests(&a).await.unwrap();
    assert_eq!(outgoing[0].other.id, b.id);
    assert!(f.friend_ids(&a).await.is_empty(), "not friends yet");

    f.clock.advance(5000);
    let accepted = f
        .contacts
        .accept_request(&b, sent.request.id)
        .await
        .unwrap();
    assert_eq!(accepted.request.status, FriendRequestStatus::Accepted);
    assert_eq!(accepted.request.handled_at, Some(f.clock_now()));
    let new_friends = accepted.new_friends.unwrap();
    assert_eq!(new_friends.of_requester.card.id, b.id);
    assert_eq!(new_friends.of_recipient.card.id, a.id);

    assert_eq!(f.friend_ids(&a).await, [b.id]);
    assert_eq!(f.friend_ids(&b).await, [a.id]);
    let listed = f.contacts.list_requests(&a).await.unwrap();
    assert_eq!(listed[0].request.status, FriendRequestStatus::Accepted);
    // 好友的资料里有个性签名，没有备注
    let friend = f.contacts.friend(&a, b.id).await.unwrap();
    assert_eq!(friend, new_friends.of_requester);
    assert_eq!((friend.remark, friend.since), (None, f.clock_now()));
}

#[tokio::test]
async fn a_request_cannot_go_to_myself_a_friend_or_nobody() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let err = f.contacts.send_request(&a, a.id, "").await.unwrap_err();
    assert!(matches!(err, ContactError::CannotAddSelf));

    let err = f
        .contacts
        .send_request(&a, UserId::new(), "")
        .await
        .unwrap_err();
    assert!(matches!(err, ContactError::UserNotFound));

    f.befriend(&a, &b).await;
    for (from, to) in [(&a, &b), (&b, &a)] {
        let err = f.contacts.send_request(from, to.id, "").await.unwrap_err();
        assert!(matches!(err, ContactError::AlreadyFriends));
    }
}

#[tokio::test]
async fn the_message_has_a_length_limit() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let longest = "好".repeat(REQUEST_MESSAGE_MAX_CHARS);
    let sent = f.contacts.send_request(&a, b.id, &longest).await.unwrap();
    assert_eq!(sent.request.message, longest);

    let err = f
        .contacts
        .send_request(&a, b.id, &format!("{longest}好"))
        .await
        .unwrap_err();
    assert!(matches!(err, ContactError::MessageTooLong));
}

#[tokio::test]
async fn sending_again_updates_the_same_request() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let first = f.contacts.send_request(&a, b.id, "第一次").await.unwrap();
    f.clock.advance(1000);
    let second = f.contacts.send_request(&a, b.id, "第二次").await.unwrap();

    assert_eq!(second.request.id, first.request.id);
    assert_eq!(second.request.message, "第二次");
    assert_eq!(second.request.sent_at, first.request.sent_at + 1000);
    assert_eq!(f.contacts.list_requests(&b).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_rejected_request_can_be_sent_again() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let sent = f.contacts.send_request(&a, b.id, "").await.unwrap();
    let rejected = f
        .contacts
        .reject_request(&b, sent.request.id)
        .await
        .unwrap();
    assert_eq!(rejected.request.status, FriendRequestStatus::Rejected);
    assert!(rejected.new_friends.is_none());
    assert!(f.friend_ids(&a).await.is_empty());
    // 申请方在自己的列表里看到结果
    let listed = f.contacts.list_requests(&a).await.unwrap();
    assert_eq!(listed[0].request.status, FriendRequestStatus::Rejected);

    f.clock.advance(1000);
    let again = f.contacts.send_request(&a, b.id, "再试一次").await.unwrap();
    assert_eq!(
        again.request.id, sent.request.id,
        "still one request per pair"
    );
    assert_eq!(again.request.status, FriendRequestStatus::Pending);
    assert_eq!(again.request.handled_at, None);
    f.contacts
        .accept_request(&b, again.request.id)
        .await
        .unwrap();
    assert_eq!(f.friend_ids(&a).await, [b.id]);
}

#[tokio::test]
async fn requesting_someone_who_already_requested_me_makes_us_friends() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    let theirs = f.contacts.send_request(&a, b.id, "").await.unwrap();
    let mine = f
        .contacts
        .send_request(&b, a.id, "我也想加你")
        .await
        .unwrap();

    // 相当于 b 同意了 a 的申请：处理的是 a 发的那一条，没有多出一条
    assert_eq!(mine.request.id, theirs.request.id);
    assert_eq!(mine.request.status, FriendRequestStatus::Accepted);
    assert_eq!((mine.from.id, mine.to.id), (a.id, b.id));
    assert!(mine.new_friends.is_some());
    assert_eq!(f.friend_ids(&a).await, [b.id]);
    assert_eq!(f.friend_ids(&b).await, [a.id]);
    assert_eq!(f.contacts.list_requests(&a).await.unwrap().len(), 1);
}

#[tokio::test]
async fn only_the_recipient_can_handle_a_request_and_only_once() {
    let f = fixture().await;
    let (a, b, c) = (
        f.user("小明").await,
        f.user("小红").await,
        f.user("小刚").await,
    );
    let sent = f.contacts.send_request(&a, b.id, "").await.unwrap();
    let id = sent.request.id;

    // 申请方自己、不相干的人：都当作没有这条申请
    for who in [&a, &c] {
        let err = f.contacts.accept_request(who, id).await.unwrap_err();
        assert!(matches!(err, ContactError::RequestNotFound));
        let err = f.contacts.reject_request(who, id).await.unwrap_err();
        assert!(matches!(err, ContactError::RequestNotFound));
    }
    let err = f
        .contacts
        .accept_request(&b, FriendRequestId::new())
        .await
        .unwrap_err();
    assert!(matches!(err, ContactError::RequestNotFound));
    assert!(f.friend_ids(&a).await.is_empty());

    f.contacts.accept_request(&b, id).await.unwrap();
    let err = f.contacts.accept_request(&b, id).await.unwrap_err();
    assert!(matches!(err, ContactError::RequestHandled));
    let err = f.contacts.reject_request(&b, id).await.unwrap_err();
    assert!(matches!(err, ContactError::RequestHandled));
    assert_eq!(f.friend_ids(&a).await, [b.id], "still friends");
}

#[tokio::test]
async fn requests_are_rate_limited_per_user() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);

    for _ in 0..REQUESTS_PER_HOUR {
        f.contacts.send_request(&a, b.id, "").await.unwrap();
    }
    let err = f.contacts.send_request(&a, b.id, "").await.unwrap_err();
    assert!(matches!(err, ContactError::RateLimited { .. }));
    // 被拒绝的请求（加自己）不占次数；别人不受影响
    assert!(f.contacts.send_request(&b, a.id, "").await.is_ok());

    f.clock.advance(60 * 60 * 1000);
    let c = f.user("小刚").await;
    assert!(f.contacts.send_request(&a, c.id, "").await.is_ok());
}

// ---------- 好友 ----------

#[tokio::test]
async fn a_remark_is_seen_only_by_the_one_who_set_it() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);
    f.befriend(&a, &b).await;

    let friend = f.contacts.set_remark(&a, b.id, "  红姐 ").await.unwrap();
    assert_eq!(friend.remark.as_deref(), Some("红姐"));
    assert_eq!(
        friend.card.nickname, "小红",
        "the nickname itself is untouched"
    );
    let listed = f.contacts.list_friends(&a).await.unwrap();
    assert_eq!(listed[0].remark.as_deref(), Some("红姐"));

    // b 这一边看 a：没有备注
    assert_eq!(f.contacts.friend(&b, a.id).await.unwrap().remark, None);

    // 留空即清除
    let friend = f.contacts.set_remark(&a, b.id, "   ").await.unwrap();
    assert_eq!(friend.remark, None);

    let longest = "红".repeat(REMARK_MAX_CHARS);
    assert!(f.contacts.set_remark(&a, b.id, &longest).await.is_ok());
    let err = f
        .contacts
        .set_remark(&a, b.id, &format!("{longest}红"))
        .await
        .unwrap_err();
    assert!(matches!(err, ContactError::RemarkTooLong));
}

#[tokio::test]
async fn removing_a_friend_ends_the_friendship_on_both_sides() {
    let f = fixture().await;
    let (a, b, c) = (
        f.user("小明").await,
        f.user("小红").await,
        f.user("小刚").await,
    );
    f.befriend(&a, &b).await;
    f.befriend(&a, &c).await;
    f.contacts.set_remark(&a, b.id, "红姐").await.unwrap();

    f.contacts.remove_friend(&a, b.id).await.unwrap();
    assert_eq!(f.friend_ids(&a).await, [c.id], "other friends are kept");
    assert!(f.friend_ids(&b).await.is_empty());

    let err = f.contacts.remove_friend(&a, b.id).await.unwrap_err();
    assert!(matches!(err, ContactError::NotFriends));

    // 重新加回来：要再申请一次，以前的备注不会回来
    let sent = f.contacts.send_request(&b, a.id, "").await.unwrap();
    assert_eq!(sent.request.status, FriendRequestStatus::Pending);
    f.contacts
        .accept_request(&a, sent.request.id)
        .await
        .unwrap();
    assert_eq!(f.contacts.friend(&a, b.id).await.unwrap().remark, None);
}

#[tokio::test]
async fn only_friends_can_be_viewed_remarked_or_removed() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);
    // 发过申请但还没有同意，不算好友
    f.contacts.send_request(&a, b.id, "").await.unwrap();

    for who in [b.id, a.id, UserId::new()] {
        let err = f.contacts.friend(&a, who).await.unwrap_err();
        assert!(matches!(err, ContactError::NotFriends));
        let err = f.contacts.set_remark(&a, who, "备注").await.unwrap_err();
        assert!(matches!(err, ContactError::NotFriends));
        let err = f.contacts.remove_friend(&a, who).await.unwrap_err();
        assert!(matches!(err, ContactError::NotFriends));
    }
}

#[tokio::test]
async fn a_friend_who_gets_disabled_stays_in_the_list() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);
    f.befriend(&a, &b).await;
    f.store
        .edit_user(b.id, |user| user.status = UserStatus::Disabled);

    assert_eq!(f.friend_ids(&a).await, [b.id]);
    assert_eq!(f.contacts.friend_ids(a.id).await.unwrap(), [b.id]);
}

impl Fixture {
    fn clock_now(&self) -> i64 {
        use crate::clock::Clock;
        self.clock.now_ms()
    }
}
