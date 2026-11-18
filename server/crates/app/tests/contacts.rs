//! 通讯录的接口：查找用户、好友申请、好友，以及随之发出的推送。

mod common;

use axum::http::StatusCode;
use common::{ADMIN_INITIAL_PASSWORD, Client, TestApp};
use serde_json::json;
use tokio::sync::mpsc::Receiver;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    ErrorCode, FriendList, FriendProfile, FriendRemoved, FriendRequestDirection, FriendRequestList,
    FriendRequestResult, FriendRequestStatus, FriendView, Me, MessageKind, Relation, ServerEvent,
    UserLookup,
};

/// 一个用户的一处登录收到的推送。
struct Inbox(Receiver<ServerEvent>);

impl Inbox {
    /// 像一条 WebSocket 连接那样登记到推送表里，不需要真的建立连接。
    fn open(app: &TestApp, me: &Me) -> Self {
        let user: UserId = me.id.parse().unwrap();
        Self(app.state.hub.register(user, SessionId::new()).events)
    }

    /// 到目前为止收到的全部推送。推送是在处理请求的过程中发出的，请求返回时已经都在这里了。
    fn take(&mut self) -> Vec<ServerEvent> {
        std::iter::from_fn(|| self.0.try_recv().ok()).collect()
    }
}

async fn lookup(client: &mut Client, handle: &str) -> UserLookup {
    let reply = client
        .get(&format!("/api/users/lookup?handle={handle}"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

async fn send(client: &mut Client, to: &Me, message: &str) -> FriendRequestResult {
    let reply = client
        .post(
            "/api/friend-requests",
            json!({ "to": to.id, "message": message }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

/// 让两个人成为好友：a 申请，b 同意。
async fn befriend(a: &mut Client, b: &mut Client, b_me: &Me) {
    let sent = send(a, b_me, "").await;
    let reply = b
        .post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
}

async fn friends(client: &mut Client) -> Vec<FriendView> {
    client.get("/api/friends").await.json::<FriendList>().items
}

#[tokio::test]
async fn a_user_is_found_by_id_with_only_the_public_part_of_the_profile() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    b.patch("/api/me", json!({ "signature": "只给好友看" }))
        .await;

    let reply = a
        .get(&format!(
            "/api/users/lookup?handle={}",
            b_me.handle.to_uppercase()
        ))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(
        !reply.text().contains("只给好友看"),
        "the signature is for friends only"
    );
    let found: UserLookup = reply.json();
    assert_eq!(
        (found.user.id.as_str(), found.user.nickname.as_str()),
        (b_me.id.as_str(), "小红")
    );
    assert_eq!(found.user.handle, b_me.handle);
    assert_eq!((found.relation, found.request_id), (Relation::None, None));

    assert_eq!(
        lookup(&mut a, &a_me.handle).await.relation,
        Relation::Myself
    );

    let reply = a.get("/api/users/lookup?handle=nobody_here").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::UserNotFound)
    );
    let reply = a.get("/api/users/lookup").await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn a_request_is_pushed_to_the_recipient_and_accepting_makes_both_friends() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let (mut a_inbox, mut b_inbox) = (Inbox::open(&app, &a_me), Inbox::open(&app, &b_me));

    let sent = send(&mut a, &b_me, "我是小明").await;
    assert_eq!(sent.friend, None);
    assert_eq!(sent.request.direction, FriendRequestDirection::Sent);
    assert_eq!(
        sent.request.user.id, b_me.id,
        "the other party is the recipient"
    );
    assert_eq!(sent.request.status, FriendRequestStatus::Pending);

    // 接收方不用刷新就收到；申请方在别处的登录也同步到
    let pushed = b_inbox.take();
    let [ServerEvent::ContactRequest(received)] = &pushed[..] else {
        panic!("expected one request event, got {pushed:?}");
    };
    assert_eq!(received.id, sent.request.id);
    assert_eq!(received.direction, FriendRequestDirection::Received);
    assert_eq!(
        received.user.id, a_me.id,
        "the other party is the requester"
    );
    assert_eq!(received.message, "我是小明");
    assert_eq!(
        a_inbox.take(),
        [ServerEvent::ContactRequest(sent.request.clone())]
    );

    // 查找时能看出两人之间有一条待处理的申请
    assert_eq!(
        lookup(&mut a, &b_me.handle).await.relation,
        Relation::RequestSent
    );
    let found = lookup(&mut b, &a_me.handle).await;
    assert_eq!(found.relation, Relation::RequestReceived);
    assert_eq!(found.request_id.as_deref(), Some(sent.request.id.as_str()));
    let listed: FriendRequestList = b.get("/api/friend-requests").await.json();
    assert_eq!(listed.items, std::slice::from_ref(received));
    assert!(friends(&mut a).await.is_empty());

    let reply = b
        .post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let accepted: FriendRequestResult = reply.json();
    assert_eq!(accepted.request.status, FriendRequestStatus::Accepted);
    let new_friend = accepted.friend.expect("b gained a friend");
    assert_eq!(new_friend.user.id, a_me.id);

    // 双方各收到三条：申请的结果，多出来的好友，和会话里"已经成为好友"的那一条
    let pushed = a_inbox.take();
    let [
        ServerEvent::ContactRequest(request),
        ServerEvent::ContactFriend(friend),
        ServerEvent::MsgNew(greeting),
    ] = &pushed[..]
    else {
        panic!("expected a request, a friend and a message event, got {pushed:?}");
    };
    assert_eq!(request.status, FriendRequestStatus::Accepted);
    assert_eq!(request.direction, FriendRequestDirection::Sent);
    assert_eq!(friend.user.id, b_me.id);
    assert_eq!(
        (greeting.kind, greeting.seq, &greeting.sender_id),
        (MessageKind::Friends, 1, &None)
    );
    assert_eq!(
        b_inbox.take(),
        [
            ServerEvent::ContactRequest(accepted.request.clone()),
            ServerEvent::ContactFriend(new_friend.clone()),
            ServerEvent::MsgNew(greeting.clone()),
        ]
    );

    assert_eq!(friends(&mut b).await, [new_friend]);
    assert_eq!(friends(&mut a).await[0].user.id, b_me.id);
    assert_eq!(
        lookup(&mut a, &b_me.handle).await.relation,
        Relation::Friend
    );
}

#[tokio::test]
async fn a_rejected_request_tells_the_requester_and_can_be_sent_again() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let sent = send(&mut a, &b_me, "").await;
    let mut a_inbox = Inbox::open(&app, &a_me);

    let reply = b
        .post_empty(&format!("/api/friend-requests/{}/reject", sent.request.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let rejected: FriendRequestResult = reply.json();
    assert_eq!(rejected.request.status, FriendRequestStatus::Rejected);
    assert_eq!(rejected.friend, None);

    let pushed = a_inbox.take();
    let [ServerEvent::ContactRequest(request)] = &pushed[..] else {
        panic!("expected one request event, got {pushed:?}");
    };
    assert_eq!(request.status, FriendRequestStatus::Rejected);
    assert!(friends(&mut a).await.is_empty());
    let listed: FriendRequestList = a.get("/api/friend-requests").await.json();
    assert_eq!(listed.items[0].status, FriendRequestStatus::Rejected);

    // 再次申请：还是那一条，回到待处理
    let again = send(&mut a, &b_me, "再试一次").await;
    assert_eq!(again.request.id, sent.request.id);
    assert_eq!(again.request.status, FriendRequestStatus::Pending);
    let listed: FriendRequestList = b.get("/api/friend-requests").await.json();
    assert_eq!(listed.items.len(), 1);
    assert_eq!(listed.items[0].message, "再试一次");
}

#[tokio::test]
async fn requesting_someone_who_already_requested_me_makes_us_friends_at_once() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let theirs = send(&mut a, &b_me, "").await;

    let mine = send(&mut b, &a_me, "").await;
    assert_eq!(mine.request.id, theirs.request.id);
    assert_eq!(mine.request.status, FriendRequestStatus::Accepted);
    assert_eq!(mine.request.direction, FriendRequestDirection::Received);
    assert_eq!(mine.friend.unwrap().user.id, a_me.id);
    assert_eq!(friends(&mut a).await[0].user.id, b_me.id);
}

#[tokio::test]
async fn a_request_can_only_be_handled_by_its_recipient_and_only_once() {
    let app = common::app().await;
    let (mut a, _) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let (mut c, _) = app.user("小刚").await;
    let id = send(&mut a, &b_me, "").await.request.id;

    // 申请方自己、不相干的人、不存在的编号、格式不对的编号：都当作没有这条申请
    for action in ["accept", "reject"] {
        for client in [&mut a, &mut c] {
            let reply = client
                .post_empty(&format!("/api/friend-requests/{id}/{action}"))
                .await;
            assert_eq!(
                (reply.status, reply.error().code),
                (StatusCode::NOT_FOUND, ErrorCode::FriendRequestNotFound)
            );
        }
        for id in ["0190a000-0000-7000-8000-000000000000", "not-an-id"] {
            let reply = b
                .post_empty(&format!("/api/friend-requests/{id}/{action}"))
                .await;
            assert_eq!(reply.error().code, ErrorCode::FriendRequestNotFound);
        }
    }
    assert!(friends(&mut a).await.is_empty());

    let reply = b
        .post_empty(&format!("/api/friend-requests/{id}/reject"))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    for action in ["accept", "reject"] {
        let reply = b
            .post_empty(&format!("/api/friend-requests/{id}/{action}"))
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::CONFLICT, ErrorCode::FriendRequestHandled)
        );
    }
    assert!(friends(&mut a).await.is_empty());
}

#[tokio::test]
async fn requests_that_make_no_sense_are_refused_with_a_reason() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;

    let cases = [
        (
            json!({ "to": a_me.id }),
            StatusCode::BAD_REQUEST,
            ErrorCode::CannotAddSelf,
        ),
        (
            json!({ "to": "0190a000-0000-7000-8000-000000000000" }),
            StatusCode::NOT_FOUND,
            ErrorCode::UserNotFound,
        ),
        (
            json!({ "to": "not-an-id" }),
            StatusCode::NOT_FOUND,
            ErrorCode::UserNotFound,
        ),
        (
            json!({ "to": b_me.id, "message": "字".repeat(51) }),
            StatusCode::BAD_REQUEST,
            ErrorCode::FriendRequestMessageTooLong,
        ),
        (json!({}), StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
    ];
    for (body, status, code) in cases {
        let reply = a.post("/api/friend-requests", body.clone()).await;
        assert_eq!((reply.status, reply.error().code), (status, code), "{body}");
    }

    // 验证信息可以不写
    let reply = a
        .post("/api/friend-requests", json!({ "to": b_me.id }))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let id = reply.json::<FriendRequestResult>().request.id;
    b.post_empty(&format!("/api/friend-requests/{id}/accept"))
        .await;

    for (client, to) in [(&mut a, &b_me), (&mut b, &a_me)] {
        let reply = client
            .post("/api/friend-requests", json!({ "to": to.id }))
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::CONFLICT, ErrorCode::AlreadyFriends)
        );
    }
}

#[tokio::test]
async fn a_friend_shows_the_full_profile_and_a_remark_stays_on_one_side() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    b.patch("/api/me", json!({ "signature": "只给好友看" }))
        .await;
    befriend(&mut a, &mut b, &b_me).await;
    let (mut a_inbox, mut b_inbox) = (Inbox::open(&app, &a_me), Inbox::open(&app, &b_me));

    let path = format!("/api/friends/{}", b_me.id);
    let friend: FriendView = a.get(&path).await.json();
    assert_eq!(friend.signature, "只给好友看");
    assert_eq!(friend.remark, None);

    let reply = a.patch(&path, json!({ "remark": " 红姐 " })).await;
    assert_eq!(reply.status, StatusCode::OK);
    let remarked: FriendView = reply.json();
    assert_eq!(remarked.remark.as_deref(), Some("红姐"));
    assert_eq!(remarked.user.nickname, "小红");
    assert_eq!(friends(&mut a).await, std::slice::from_ref(&remarked));

    // 备注只推给自己在别处的登录；对方既收不到，也取不到
    assert_eq!(a_inbox.take(), [ServerEvent::ContactFriend(remarked)]);
    assert!(b_inbox.take().is_empty());
    let reply = b.get("/api/friends").await;
    assert!(!reply.text().contains("红姐"));
    assert_eq!(friends(&mut b).await[0].remark, None);

    let cleared: FriendView = a.patch(&path, json!({ "remark": "" })).await.json();
    assert_eq!(cleared.remark, None);

    let reply = a.patch(&path, json!({ "remark": "红".repeat(33) })).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::BAD_REQUEST, ErrorCode::RemarkTooLong)
    );
}

#[tokio::test]
async fn removing_a_friend_is_pushed_to_both_sides() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    befriend(&mut a, &mut b, &b_me).await;
    let (mut a_inbox, mut b_inbox) = (Inbox::open(&app, &a_me), Inbox::open(&app, &b_me));

    let path = format!("/api/friends/{}", b_me.id);
    assert_eq!(a.delete(&path).await.status, StatusCode::NO_CONTENT);

    let removed = |user: &Me| {
        ServerEvent::ContactFriendRemoved(FriendRemoved {
            user_id: user.id.clone(),
        })
    };
    assert_eq!(a_inbox.take(), [removed(&b_me)]);
    assert_eq!(b_inbox.take(), [removed(&a_me)]);
    assert!(friends(&mut a).await.is_empty());
    assert!(friends(&mut b).await.is_empty());
    assert_eq!(lookup(&mut a, &b_me.handle).await.relation, Relation::None);

    let reply = a.delete(&path).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::NotFriends)
    );
    assert!(
        b_inbox.take().is_empty(),
        "nothing happened, nothing is pushed"
    );
}

#[tokio::test]
async fn someone_who_is_not_a_friend_cannot_be_viewed_remarked_or_removed() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (_b, b_me) = app.user("小红").await;
    // 发过申请但对方还没有同意，不算好友
    send(&mut a, &b_me, "").await;

    for id in [
        b_me.id.as_str(),
        a_me.id.as_str(),
        "0190a000-0000-7000-8000-000000000000",
        "not-an-id",
    ] {
        let path = format!("/api/friends/{id}");
        for reply in [
            a.get(&path).await,
            a.patch(&path, json!({ "remark": "x" })).await,
            a.delete(&path).await,
        ] {
            assert_eq!(
                (reply.status, reply.error().code),
                (StatusCode::NOT_FOUND, ErrorCode::NotFriends),
                "{id}"
            );
        }
    }
}

#[tokio::test]
async fn friends_are_told_when_someone_changes_what_they_can_see() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let (_c, c_me) = app.user("小刚").await;
    befriend(&mut a, &mut b, &b_me).await;
    let (mut b_inbox, mut c_inbox) = (Inbox::open(&app, &b_me), Inbox::open(&app, &c_me));

    a.patch(
        "/api/me",
        json!({ "nickname": "大明", "signature": "新的签名" }),
    )
    .await;
    let pushed = b_inbox.take();
    let [ServerEvent::ContactProfile(FriendProfile { user, signature })] = &pushed[..] else {
        panic!("expected one profile event, got {pushed:?}");
    };
    assert_eq!(
        (user.id.as_str(), user.nickname.as_str(), signature.as_str()),
        (a_me.id.as_str(), "大明", "新的签名")
    );

    // 改 ID 也会通知；只和自己有关的语言和外观不会
    a.put("/api/me/handle", json!({ "handle": "Da_Ming2026" }))
        .await;
    let pushed = b_inbox.take();
    let [ServerEvent::ContactProfile(profile)] = &pushed[..] else {
        panic!("expected one profile event, got {pushed:?}");
    };
    assert_eq!(profile.user.handle, "Da_Ming2026");
    a.patch("/api/me", json!({ "language": "en", "theme": "dark" }))
        .await;
    assert!(b_inbox.take().is_empty());

    assert!(c_inbox.take().is_empty(), "not a friend, not told");
    assert_eq!(friends(&mut b).await[0].user.nickname, "大明");
}

#[tokio::test]
async fn lookups_are_rate_limited() {
    let app = common::app().await;
    let (mut a, _) = app.user("小明").await;
    let (_b, b_me) = app.user("小红").await;

    for _ in 0..30 {
        a.get("/api/users/lookup?handle=nobody_here").await;
    }
    let reply = a
        .get(&format!("/api/users/lookup?handle={}", b_me.handle))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::TOO_MANY_REQUESTS, ErrorCode::TooManyRequests)
    );
    assert!(reply.error().retry_after_secs.unwrap() > 0);
    assert!(reply.headers.contains_key("retry-after"));

    app.clock.advance(60 * 1000);
    assert_eq!(lookup(&mut a, &b_me.handle).await.user.id, b_me.id);
}

#[tokio::test]
async fn the_contact_api_needs_a_login_that_is_free_to_act() {
    let app = common::app().await;
    let paths = [
        "/api/users/lookup?handle=x",
        "/api/friend-requests",
        "/api/friends",
    ];

    let mut anonymous = app.client();
    for path in paths {
        let reply = anonymous.get(path).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized),
            "{path}"
        );
    }

    // 还没有改掉初始密码的管理员：先改密码，别的都不能做
    app.state
        .accounts
        .bootstrap_admin("admin@example.com", ADMIN_INITIAL_PASSWORD)
        .await
        .unwrap();
    let mut admin = app.client();
    admin
        .post(
            "/api/auth/login",
            json!({ "handle": "admin", "password": ADMIN_INITIAL_PASSWORD }),
        )
        .await;
    for path in paths {
        let reply = admin.get(path).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::FORBIDDEN, ErrorCode::MustChangePassword),
            "{path}"
        );
    }
}
