//! 群的接口：建群、成员进出、群资料、@ 和可见范围，以及随之发出的推送。

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use serde_json::{Value, json};
use tokio::sync::mpsc::Receiver;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    ConversationKind, ConversationList, ConversationView, ErrorCode, FriendRequestResult,
    InviteResult, JoinRequestList, JoinRequestStatus, Me, MemberList, MemberProfile, MemberView,
    MessageKind, MessageList, MessageView, NoticeSeen, Relation, ServerEvent,
};

/// 一个用户的一处登录收到的推送。
struct Inbox(Receiver<ServerEvent>);

impl Inbox {
    fn open(app: &TestApp, me: &Me) -> Self {
        let user: UserId = me.id.parse().unwrap();
        Self(app.state.hub.register(user, SessionId::new()).events)
    }

    /// 到目前为止收到的"我在别处看过了群公告"。
    fn notices_seen(&mut self) -> Vec<NoticeSeen> {
        std::iter::from_fn(|| self.0.try_recv().ok())
            .filter_map(|event| match event {
                ServerEvent::ConvNoticeSeen(seen) => Some(seen),
                _ => None,
            })
            .collect()
    }

    /// 到目前为止收到的会话日志里的条目。
    fn messages(&mut self) -> Vec<MessageView> {
        std::iter::from_fn(|| self.0.try_recv().ok())
            .filter_map(|event| match event {
                ServerEvent::MsgNew(message) => Some(*message),
                _ => None,
            })
            .collect()
    }
}

struct Person {
    client: Client,
    me: Me,
}

async fn person(app: &TestApp, nickname: &str) -> Person {
    let (client, me) = app.user(nickname).await;
    Person { client, me }
}

async fn befriend(a: &mut Person, b: &mut Person) {
    let sent: FriendRequestResult = a
        .client
        .post("/api/friend-requests", json!({ "to": b.me.id }))
        .await
        .json();
    let reply = b
        .client
        .post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
}

/// 群主和两个成员建一个群；另有一个是群主的好友但不在群里的人。
async fn group(app: &TestApp) -> (Person, Person, Person, Person, String) {
    let mut owner = person(app, "群主").await;
    let mut one = person(app, "成员一").await;
    let mut two = person(app, "成员二").await;
    let mut outsider = person(app, "局外人").await;
    for friend in [&mut one, &mut two, &mut outsider] {
        befriend(&mut owner, friend).await;
    }
    let reply = owner
        .client
        .post(
            "/api/conversations/group",
            json!({ "name": "项目组", "member_ids": [one.me.id, two.me.id] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = reply.json::<ConversationView>().id;
    (owner, one, two, outsider, id)
}

async fn say(person: &mut Person, group: &str, client_id: &str, body: Value) -> MessageView {
    let mut body = body;
    body["client_id"] = json!(client_id);
    let reply = person
        .client
        .post(&format!("/api/conversations/{group}/messages"), body)
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn view(person: &mut Person, group: &str) -> ConversationView {
    let reply = person
        .client
        .get(&format!("/api/conversations/{group}"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

async fn kinds(person: &mut Person, group: &str) -> Vec<MessageKind> {
    let list: MessageList = person
        .client
        .get(&format!("/api/conversations/{group}/messages"))
        .await
        .json();
    list.items.iter().map(|item| item.kind).collect()
}

async fn members(person: &mut Person, group: &str) -> Vec<MemberView> {
    let reply = person
        .client
        .get(&format!("/api/conversations/{group}/members"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json::<MemberList>().items
}

#[tokio::test]
async fn a_new_group_appears_for_every_member_at_once() {
    let app = common::app().await;
    let mut owner = person(&app, "群主").await;
    let mut one = person(&app, "成员一").await;
    let mut two = person(&app, "成员二").await;
    befriend(&mut owner, &mut one).await;
    befriend(&mut owner, &mut two).await;
    let mut inboxes = [
        Inbox::open(&app, &owner.me),
        Inbox::open(&app, &one.me),
        Inbox::open(&app, &two.me),
    ];

    let reply = owner
        .client
        .post(
            "/api/conversations/group",
            json!({ "name": " 项目组 ", "member_ids": [one.me.id, two.me.id] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let created: ConversationView = reply.json();
    assert_eq!(created.kind, ConversationKind::Group);
    assert!(created.peer.is_none());
    let info = created.group.as_ref().unwrap();
    assert_eq!(info.name.as_deref(), Some("项目组"));
    assert_eq!(info.owner_id.as_deref(), Some(owner.me.id.as_str()));
    assert_eq!((info.member_count, info.max_members), (3, 10));
    assert_eq!(info.name_hint, ["群主", "成员一", "成员二"]);
    assert!(!info.left && !info.dissolved && !info.mentioned);

    // 三个人各收到"建群"这一条
    for inbox in &mut inboxes {
        let pushed = inbox.messages();
        assert_eq!(pushed.len(), 1);
        let event = &pushed[0];
        assert_eq!((event.kind, event.seq), (MessageKind::GroupCreated, 1));
        assert_eq!(event.conversation_id, created.id);
        assert_eq!(event.actor.as_ref().unwrap().nickname, "群主");
        let invited: Vec<&str> = event.targets.iter().map(|p| p.nickname.as_str()).collect();
        assert_eq!(invited, ["成员一", "成员二"]);
    }
    // 三个人的会话列表和"我的群"里都有它
    for member in [&mut owner, &mut one, &mut two] {
        let listed: ConversationList = member.client.get("/api/conversations").await.json();
        assert!(listed.items.iter().any(|item| item.id == created.id));
        let groups: ConversationList = member.client.get("/api/groups").await.json();
        assert_eq!(groups.items.len(), 1);
        assert_eq!(groups.items[0].id, created.id);
    }
}

#[tokio::test]
async fn groups_that_cannot_be_created_are_refused_with_a_reason() {
    let app = common::app().await;
    let mut owner = person(&app, "群主").await;
    let mut one = person(&app, "成员一").await;
    let mut two = person(&app, "成员二").await;
    let stranger = person(&app, "路人").await;
    befriend(&mut owner, &mut one).await;
    befriend(&mut owner, &mut two).await;

    let cases = [
        (
            json!({ "member_ids": [one.me.id] }),
            StatusCode::BAD_REQUEST,
            ErrorCode::GroupTooSmall,
        ),
        (
            json!({ "member_ids": [one.me.id, stranger.me.id] }),
            StatusCode::NOT_FOUND,
            ErrorCode::NotFriends,
        ),
        (
            json!({ "member_ids": [one.me.id, "not-an-id"] }),
            StatusCode::NOT_FOUND,
            ErrorCode::NotFriends,
        ),
        (
            json!({ "name": "群".repeat(31), "member_ids": [one.me.id, two.me.id] }),
            StatusCode::BAD_REQUEST,
            ErrorCode::GroupNameTooLong,
        ),
        (json!({}), StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
    ];
    for (body, status, code) in cases {
        let reply = owner
            .client
            .post("/api/conversations/group", body.clone())
            .await;
        assert_eq!((reply.status, reply.error().code), (status, code), "{body}");
    }
    let groups: ConversationList = owner.client.get("/api/groups").await.json();
    assert!(groups.items.is_empty());
}

#[tokio::test]
async fn a_newcomer_cannot_fetch_what_was_said_before_joining() {
    let app = common::app().await;
    let (mut owner, mut one, _two, mut newcomer, group) = group(&app).await;
    say(&mut one, &group, "c-1", json!({ "text": "入群之前的秘密" })).await;
    let mut inbox = Inbox::open(&app, &newcomer.me);

    let reply = owner
        .client
        .post(
            &format!("/api/conversations/{group}/members"),
            json!({ "user_ids": [newcomer.me.id, one.me.id] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply
            .json::<InviteResult>()
            .conversation
            .group
            .unwrap()
            .member_count,
        4
    );
    // 新成员收到"加入"这一条，群因此出现在他的列表里
    let pushed = inbox.messages();
    assert_eq!(pushed.len(), 1);
    assert_eq!(pushed[0].kind, MessageKind::MemberJoined);
    assert_eq!(
        pushed[0].targets.len(),
        1,
        "only the one who was not in yet"
    );
    say(&mut owner, &group, "c-2", json!({ "text": "欢迎" })).await;

    assert_eq!(
        kinds(&mut newcomer, &group).await,
        [MessageKind::MemberJoined, MessageKind::Text]
    );
    // 换着法子去要入群之前的，都取不到
    for query in ["?before=3", "?after=0", "?after=1&limit=100"] {
        let reply = newcomer
            .client
            .get(&format!("/api/conversations/{group}/messages{query}"))
            .await;
        assert!(
            !reply.text().contains("入群之前的秘密"),
            "{query} leaked an earlier message"
        );
    }
    assert_eq!(view(&mut newcomer, &group).await.unread, 1);
    // 老成员看得到全部
    assert_eq!(kinds(&mut one, &group).await.len(), 4);
}

#[tokio::test]
async fn group_messages_carry_the_sender_name_and_reach_all_members() {
    let app = common::app().await;
    let (mut owner, mut one, two, outsider, group) = group(&app).await;
    let (mut two_inbox, mut outsider_inbox) =
        (Inbox::open(&app, &two.me), Inbox::open(&app, &outsider.me));

    let sent = say(&mut one, &group, "c-1", json!({ "text": "大家好" })).await;
    assert_eq!(sent.sender_name.as_deref(), Some("成员一"));
    assert_eq!(two_inbox.messages(), std::slice::from_ref(&sent));
    assert!(
        outsider_inbox.messages().is_empty(),
        "not a member, not told"
    );

    let listed = view(&mut owner, &group).await;
    assert_eq!(listed.unread, 1);
    assert_eq!(
        listed.last_message.unwrap().sender_name.as_deref(),
        Some("成员一")
    );
    let history: MessageList = owner
        .client
        .get(&format!("/api/conversations/{group}/messages"))
        .await
        .json();
    assert_eq!(history.items[1].sender_name.as_deref(), Some("成员一"));
    assert_eq!(history.items[0].sender_name, None, "events have no sender");
}

#[tokio::test]
async fn mentions_flag_the_conversation_for_those_mentioned() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, outsider, group) = group(&app).await;

    let sent = say(
        &mut one,
        &group,
        "c-1",
        json!({ "text": "@成员二 看一下", "mentions": [two.me.id] }),
    )
    .await;
    assert_eq!(sent.mentions, [two.me.id.clone()]);
    assert!(view(&mut two, &group).await.group.unwrap().mentioned);
    assert!(!view(&mut owner, &group).await.group.unwrap().mentioned);

    // 看过之后提示消失
    two.client
        .post(
            &format!("/api/conversations/{group}/read"),
            json!({ "seq": sent.seq }),
        )
        .await;
    assert!(!view(&mut two, &group).await.group.unwrap().mentioned);

    // 只有群主能 @ 所有人；不能 @ 不在群里的人
    let path = format!("/api/conversations/{group}/messages");
    let reply = one
        .client
        .post(
            &path,
            json!({ "client_id": "c-2", "text": "@所有人", "mention_all": true }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::NotGroupManager)
    );
    let reply = one
        .client
        .post(
            &path,
            json!({ "client_id": "c-3", "text": "@局外人", "mentions": [outsider.me.id] }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotGroupMember);

    let all = say(
        &mut owner,
        &group,
        "c-4",
        json!({ "text": "@所有人 开会", "mention_all": true }),
    )
    .await;
    assert!(all.mention_all);
    assert!(view(&mut one, &group).await.group.unwrap().mentioned);
    assert!(view(&mut two, &group).await.group.unwrap().mentioned);
}

#[tokio::test]
async fn only_the_owner_manages_the_group() {
    let app = common::app().await;
    let (mut owner, mut one, two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");

    // 普通成员做群主和管理员的事：一律拒绝
    let replies = [
        one.client.patch(&base, json!({ "name": "我来改" })).await,
        one.client
            .put_bytes(&format!("{base}/avatar"), b"IMG-new".to_vec())
            .await,
        one.client
            .delete(&format!("{base}/members/{}", two.me.id))
            .await,
    ];
    for reply in replies {
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::FORBIDDEN, ErrorCode::NotGroupManager)
        );
    }
    // 只有群主能做的
    let replies = [
        one.client
            .put(&format!("{base}/owner"), json!({ "user_id": one.me.id }))
            .await,
        one.client.post_empty(&format!("{base}/dissolve")).await,
        one.client
            .put_empty(&format!("{base}/admins/{}", two.me.id))
            .await,
    ];
    for reply in replies {
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::FORBIDDEN, ErrorCode::NotGroupOwner)
        );
    }
    assert_eq!(kinds(&mut owner, &group).await.len(), 1, "nothing happened");

    // 群主改名、换头像：成员那边跟着变，并留下一行提示
    let mut one_inbox = Inbox::open(&app, &one.me);
    let renamed: ConversationView = owner
        .client
        .patch(&base, json!({ "name": "周末爬山" }))
        .await
        .json();
    assert_eq!(renamed.group.unwrap().name.as_deref(), Some("周末爬山"));
    let reply = owner
        .client
        .put_bytes(&format!("{base}/avatar"), b"IMG-new".to_vec())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let avatar = reply
        .json::<ConversationView>()
        .group
        .unwrap()
        .avatar_file_id;
    assert!(avatar.is_some());
    let pushed = one_inbox.messages();
    let pushed_kinds: Vec<_> = pushed.iter().map(|m| m.kind).collect();
    assert_eq!(
        pushed_kinds,
        [MessageKind::Renamed, MessageKind::AvatarChanged]
    );
    assert_eq!(pushed[0].name.as_deref(), Some("周末爬山"));
    let seen = view(&mut one, &group).await.group.unwrap();
    assert_eq!(
        (seen.name.as_deref(), seen.avatar_file_id),
        (Some("周末爬山"), avatar.clone())
    );
    // 群头像和个人头像一样，登录了就能读
    let file = one
        .client
        .get(&format!("/api/files/{}", avatar.unwrap()))
        .await;
    assert_eq!(file.status, StatusCode::OK);

    // 不是图片的文件不能当头像
    let reply = owner
        .client
        .put_bytes(&format!("{base}/avatar"), b"not an image".to_vec())
        .await;
    assert_eq!(reply.error().code, ErrorCode::UnsupportedImage);
}

#[tokio::test]
async fn the_owner_appoints_admins_who_then_manage_the_group() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");

    let mut two_inbox = Inbox::open(&app, &two.me);
    let reply = owner
        .client
        .put_empty(&format!("{base}/admins/{}", one.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let appointed = reply.json::<ConversationView>().group.unwrap();
    assert_eq!(appointed.admin_ids, [one.me.id.clone()]);
    // 群里的人收到一行提示；名单上标着
    let pushed = two_inbox.messages();
    assert_eq!(pushed[0].kind, MessageKind::AdminAdded);
    assert_eq!(pushed[0].targets[0].id, one.me.id);
    let listed = members(&mut two, &group).await;
    let flagged: Vec<&str> = listed
        .iter()
        .filter(|member| member.is_admin)
        .map(|member| member.user.id.as_str())
        .collect();
    assert_eq!(flagged, [one.me.id.as_str()]);

    // 管理员可以改群名、移出普通成员；不能移出群主
    let reply = one
        .client
        .patch(&base, json!({ "name": "管理员改的" }))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let reply = one
        .client
        .delete(&format!("{base}/members/{}", owner.me.id))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::NotGroupOwner)
    );
    let reply = one
        .client
        .delete(&format!("{base}/members/{}", two.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);

    // 取消
    let reply = owner
        .client
        .delete(&format!("{base}/admins/{}", one.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(
        view(&mut one, &group)
            .await
            .group
            .unwrap()
            .admin_ids
            .is_empty()
    );
    let kinds = kinds(&mut owner, &group).await;
    assert_eq!(kinds.last(), Some(&MessageKind::AdminRemoved));
}

#[tokio::test]
async fn a_group_has_at_most_three_admins() {
    let app = common::app().await;
    let mut owner = person(&app, "群主").await;
    let mut people = Vec::new();
    for n in 0..4 {
        let mut someone = person(&app, &format!("成员{n}")).await;
        befriend(&mut owner, &mut someone).await;
        people.push(someone);
    }
    let ids: Vec<&str> = people.iter().map(|p| p.me.id.as_str()).collect();
    let reply = owner
        .client
        .post("/api/conversations/group", json!({ "member_ids": ids }))
        .await;
    let group = reply.json::<ConversationView>().id;
    for someone in &people[..3] {
        let reply = owner
            .client
            .put_empty(&format!(
                "/api/conversations/{group}/admins/{}",
                someone.me.id
            ))
            .await;
        assert_eq!(reply.status, StatusCode::OK);
    }
    let reply = owner
        .client
        .put_empty(&format!(
            "/api/conversations/{group}/admins/{}",
            people[3].me.id
        ))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::TooManyAdmins)
    );
}

#[tokio::test]
async fn a_muted_member_is_refused_and_everyone_sees_why() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");

    // 普通成员不能禁言；时长只能是那几种
    let reply = one
        .client
        .put(
            &format!("{base}/muted-members/{}", two.me.id),
            json!({ "minutes": 10 }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotGroupManager);
    let reply = owner
        .client
        .put(
            &format!("{base}/muted-members/{}", two.me.id),
            json!({ "minutes": 7 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let mut one_inbox = Inbox::open(&app, &one.me);
    let reply = owner
        .client
        .put(
            &format!("{base}/muted-members/{}", two.me.id),
            json!({ "minutes": 10 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let pushed = one_inbox.messages();
    assert_eq!(pushed[0].kind, MessageKind::MemberMuted);
    assert!(pushed[0].until.is_some());
    // 被禁言的人看得到自己禁言到什么时候；发不出去
    let mine = view(&mut two, &group).await.group.unwrap();
    assert_eq!(mine.muted_until, pushed[0].until);
    let reply = two
        .client
        .post(
            &format!("{base}/messages"),
            json!({ "client_id": "m-1", "text": "我说话" }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Muted)
    );
    // 名单上所有人都看得到
    let listed = members(&mut one, &group).await;
    let flagged = listed.iter().find(|m| m.user.id == two.me.id).unwrap();
    assert_eq!(flagged.muted_until, pushed[0].until);

    // 解除
    let reply = owner
        .client
        .delete(&format!("{base}/muted-members/{}", two.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    say(&mut two, &group, "m-2", json!({ "text": "可以了" })).await;

    // 全员禁言
    let reply = owner
        .client
        .put(&format!("{base}/all-muted"), json!({ "muted": true }))
        .await;
    assert!(reply.json::<ConversationView>().group.unwrap().all_muted);
    let reply = one
        .client
        .post(
            &format!("{base}/messages"),
            json!({ "client_id": "m-3", "text": "我说话" }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::AllMuted);
    say(&mut owner, &group, "m-4", json!({ "text": "群主照常" })).await;
    let kinds = kinds(&mut owner, &group).await;
    assert!(kinds.contains(&MessageKind::AllMuted));
}

#[tokio::test]
async fn a_group_nickname_reaches_the_others_without_a_line_in_the_group() {
    let app = common::app().await;
    let (mut owner, mut one, _two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");
    let before = kinds(&mut owner, &group).await.len();

    let mut owner_inbox = Inbox::open(&app, &owner.me);
    let reply = one
        .client
        .put(&format!("{base}/nickname"), json!({ "nickname": "小一" }))
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());
    // 群里的人收到"名单变了"；群里没有多出一行
    let pushed: Vec<ServerEvent> = std::iter::from_fn(|| owner_inbox.0.try_recv().ok()).collect();
    assert!(pushed.iter().any(|event| matches!(
        event,
        ServerEvent::ConvMembers(changed) if changed.conversation_id == group
    )));
    assert_eq!(kinds(&mut owner, &group).await.len(), before);
    let listed = members(&mut owner, &group).await;
    let named = listed.iter().find(|m| m.user.id == one.me.id).unwrap();
    assert_eq!(named.group_nickname.as_deref(), Some("小一"));
    // 群里的消息带的是群内昵称
    let said = say(&mut one, &group, "n-1", json!({ "text": "你好" })).await;
    assert_eq!(said.sender_name.as_deref(), Some("小一"));

    let reply = one
        .client
        .put(
            &format!("{base}/nickname"),
            json!({ "nickname": "太".repeat(21) }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn with_join_approval_an_ordinary_member_only_asks_and_a_manager_decides() {
    let app = common::app().await;
    let (mut owner, mut one, _two, mut outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");
    befriend(&mut one, &mut outsider).await;

    // 普通成员不能开关；群主开
    let reply = one
        .client
        .put(&format!("{base}/join-approval"), json!({ "enabled": true }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotGroupManager);
    let reply = owner
        .client
        .put(&format!("{base}/join-approval"), json!({ "enabled": true }))
        .await;
    assert!(
        reply
            .json::<ConversationView>()
            .group
            .unwrap()
            .join_approval
    );

    // 成员一邀请局外人：只是一条申请，群主收到推送
    let mut owner_inbox = Inbox::open(&app, &owner.me);
    let reply = one
        .client
        .post(
            &format!("{base}/members"),
            json!({ "user_ids": [outsider.me.id] }),
        )
        .await;
    let result = reply.json::<InviteResult>();
    assert_eq!(result.requested, 1);
    assert_eq!(result.conversation.group.unwrap().member_count, 3);
    let pushed: Vec<ServerEvent> = std::iter::from_fn(|| owner_inbox.0.try_recv().ok()).collect();
    assert!(
        pushed
            .iter()
            .any(|event| matches!(event, ServerEvent::ConvJoinRequests(_)))
    );
    assert_eq!(
        view(&mut owner, &group)
            .await
            .group
            .unwrap()
            .pending_requests,
        1
    );
    assert_eq!(
        view(&mut one, &group).await.group.unwrap().pending_requests,
        0
    );

    // 邀请人看得到自己发出的；群主看到全部
    let mine: JoinRequestList = one
        .client
        .get(&format!("{base}/join-requests"))
        .await
        .json();
    assert_eq!(mine.items.len(), 1);
    assert_eq!(mine.items[0].status, JoinRequestStatus::Pending);
    let all: JoinRequestList = owner
        .client
        .get(&format!("{base}/join-requests"))
        .await
        .json();
    let request = all.items[0].id.clone();
    // 普通成员处理不了
    let reply = one
        .client
        .post_empty(&format!("{base}/join-requests/{request}/approve"))
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotGroupManager);

    // 群主同意：他进来了，群里的提示带着邀请人和同意的人
    let reply = owner
        .client
        .post_empty(&format!("{base}/join-requests/{request}/approve"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let group_view = reply.json::<ConversationView>().group.unwrap();
    assert_eq!(
        (group_view.member_count, group_view.pending_requests),
        (4, 0)
    );
    let list: MessageList = owner.client.get(&format!("{base}/messages")).await.json();
    let joined = list.items.last().unwrap();
    assert_eq!(joined.kind, MessageKind::MemberJoined);
    assert_eq!(joined.actor.as_ref().unwrap().id, one.me.id);
    assert_eq!(joined.approver.as_ref().unwrap().id, owner.me.id);
    let mine: JoinRequestList = one
        .client
        .get(&format!("{base}/join-requests"))
        .await
        .json();
    assert_eq!(mine.items[0].status, JoinRequestStatus::Approved);
    assert_eq!(mine.items[0].handled_by_name.as_deref(), Some("群主"));
    // 再处理一次不行
    let reply = owner
        .client
        .post_empty(&format!("{base}/join-requests/{request}/reject"))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::JoinRequestHandled)
    );
    let reply = owner
        .client
        .post_empty(&format!("{base}/join-requests/{}/reject", UserId::new()))
        .await;
    assert_eq!(reply.error().code, ErrorCode::JoinRequestNotFound);
}

#[tokio::test]
async fn a_removed_member_is_told_and_then_shut_out() {
    let app = common::app().await;
    let (mut owner, mut one, two, _outsider, group) = group(&app).await;
    say(&mut one, &group, "c-1", json!({ "text": "我还在" })).await;
    let (mut one_inbox, mut two_inbox) = (Inbox::open(&app, &one.me), Inbox::open(&app, &two.me));

    let reply = owner
        .client
        .delete(&format!("/api/conversations/{group}/members/{}", one.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json::<ConversationView>().group.unwrap().member_count,
        2
    );

    // 被移出的人和留下的人都收到这一条
    for inbox in [&mut one_inbox, &mut two_inbox] {
        let pushed = inbox.messages();
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0].kind, MessageKind::MemberRemoved);
        assert_eq!(pushed[0].targets[0].id, one.me.id);
    }
    // 之后的消息他收不到
    say(&mut owner, &group, "c-2", json!({ "text": "他走了之后" })).await;
    assert!(one_inbox.messages().is_empty());
    assert_eq!(two_inbox.messages().len(), 1);

    // 他这边：会话还在，标着已经离开，只能看到被移出为止，不能再发
    let mine = view(&mut one, &group).await;
    assert!(mine.group.as_ref().unwrap().left);
    assert_eq!(mine.last_message.unwrap().kind, MessageKind::MemberRemoved);
    let history = one
        .client
        .get(&format!("/api/conversations/{group}/messages?limit=100"))
        .await;
    assert!(!history.text().contains("他走了之后"));
    let reply = one
        .client
        .post(
            &format!("/api/conversations/{group}/messages"),
            json!({ "client_id": "c-3", "text": "为什么" }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::LeftGroup)
    );
    let groups: ConversationList = one.client.get("/api/groups").await.json();
    assert!(groups.items.is_empty());

    // 成员名单里他还在，标着已经离开
    let listed = members(&mut owner, &group).await;
    let gone = listed.iter().find(|m| m.user.id == one.me.id).unwrap();
    assert!(!gone.active);
    assert_eq!(listed.iter().filter(|m| m.active).count(), 2);
}

#[tokio::test]
async fn the_owner_hands_over_before_leaving_and_a_leaver_drops_the_group() {
    let app = common::app().await;
    let (mut owner, mut one, two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");

    let reply = owner.client.post_empty(&format!("{base}/leave")).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::OwnerCannotLeave)
    );

    let reply = owner
        .client
        .put(&format!("{base}/owner"), json!({ "user_id": one.me.id }))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let transferred = reply.json::<ConversationView>().group.unwrap();
    assert_eq!(transferred.owner_id.as_deref(), Some(one.me.id.as_str()));

    let mut two_inbox = Inbox::open(&app, &two.me);
    let reply = owner.client.post_empty(&format!("{base}/leave")).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(two_inbox.messages()[0].kind, MessageKind::MemberLeft);
    // 自己退群：会话从自己的列表里消失
    let listed: ConversationList = owner.client.get("/api/conversations").await.json();
    assert!(listed.items.iter().all(|item| item.id != group));

    // 新群主可以做群主的事了；成员名单里标着谁是群主
    let reply = one
        .client
        .patch(&base, json!({ "name": "新群主的群" }))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let listed = members(&mut one, &group).await;
    let owners: Vec<&str> = listed
        .iter()
        .filter(|m| m.is_owner)
        .map(|m| m.user.id.as_str())
        .collect();
    assert_eq!(owners, [one.me.id.as_str()]);
}

#[tokio::test]
async fn a_dissolved_group_takes_no_more_messages() {
    let app = common::app().await;
    let (mut owner, mut one, two, outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");
    let mut two_inbox = Inbox::open(&app, &two.me);

    let reply = owner.client.post_empty(&format!("{base}/dissolve")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.json::<ConversationView>().group.unwrap().dissolved);
    assert_eq!(two_inbox.messages()[0].kind, MessageKind::Dissolved);

    let replies = [
        one.client
            .post(
                &format!("{base}/messages"),
                json!({ "client_id": "c-1", "text": "还在吗" }),
            )
            .await,
        owner
            .client
            .post(
                &format!("{base}/members"),
                json!({ "user_ids": [outsider.me.id] }),
            )
            .await,
        owner.client.post_empty(&format!("{base}/dissolve")).await,
    ];
    for reply in replies {
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::CONFLICT, ErrorCode::GroupDissolved)
        );
    }
    // 历史还在
    assert_eq!(
        kinds(&mut one, &group).await,
        [MessageKind::GroupCreated, MessageKind::Dissolved]
    );
}

#[tokio::test]
async fn members_see_each_other_and_outsiders_see_nothing() {
    let app = common::app().await;
    let (mut owner, mut one, two, mut outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");
    two.client
        .clone()
        .patch("/api/me", json!({ "signature": "同群可见" }))
        .await;

    // 成员一和成员二不是好友，但在同一个群里：能看到资料，包括个性签名
    let reply = one
        .client
        .get(&format!("{base}/members/{}", two.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    let profile: MemberProfile = reply.json();
    assert_eq!(profile.signature, "同群可见");
    assert_eq!(profile.relation, Relation::None);
    // 据此可以发好友申请
    let reply = one
        .client
        .post("/api/friend-requests", json!({ "to": profile.user.id }))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let again: MemberProfile = one
        .client
        .get(&format!("{base}/members/{}", two.me.id))
        .await
        .json();
    assert_eq!(again.relation, Relation::RequestSent);
    // 对群主：是好友
    let friend: MemberProfile = one
        .client
        .get(&format!("{base}/members/{}", owner.me.id))
        .await
        .json();
    assert_eq!(friend.relation, Relation::Friend);
    assert_eq!(members(&mut owner, &group).await.len(), 3);

    // 不在群里的人：什么都取不到，也做不了
    let paths = [
        base.clone(),
        format!("{base}/messages"),
        format!("{base}/members"),
        format!("{base}/members/{}", owner.me.id),
    ];
    for path in paths {
        let reply = outsider.client.get(&path).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::NOT_FOUND, ErrorCode::ConversationNotFound),
            "{path}"
        );
    }
    let reply = outsider
        .client
        .post(
            &format!("{base}/members"),
            json!({ "user_ids": [owner.me.id] }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);
    // 群里的人查一个不在群里的人
    let reply = one
        .client
        .get(&format!("{base}/members/{}", outsider.me.id))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::NotGroupMember)
    );
}

#[tokio::test]
async fn read_positions_of_every_member_are_pushed_to_the_group() {
    let app = common::app().await;
    let (mut owner, mut one, _two, _outsider, group) = group(&app).await;
    let sent = say(&mut owner, &group, "c-1", json!({ "text": "看到请回复" })).await;
    let mut owner_events = app
        .state
        .hub
        .register(owner.me.id.parse().unwrap(), SessionId::new())
        .events;

    one.client
        .post(
            &format!("/api/conversations/{group}/read"),
            json!({ "seq": sent.seq }),
        )
        .await;

    let pushed = owner_events.try_recv().expect("the sender is told");
    let ServerEvent::ConvRead(read) = pushed else {
        panic!("expected a read event, got {pushed:?}");
    };
    assert_eq!((read.user_id, read.read_seq), (one.me.id.clone(), sent.seq));
    let listed = members(&mut owner, &group).await;
    let reader = listed.iter().find(|m| m.user.id == one.me.id).unwrap();
    assert_eq!(reader.read_seq, sent.seq);
}

#[tokio::test]
async fn the_owner_posts_a_notice_and_members_are_reminded_until_they_have_seen_it() {
    let app = common::app().await;
    let (mut owner, mut one, _two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}/notice");

    // 普通成员不能改
    let reply = one.client.put(&base, json!({ "text": "我来写" })).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::NotGroupManager)
    );

    let mut one_inbox = Inbox::open(&app, &one.me);
    let published: ConversationView = owner
        .client
        .put(&base, json!({ "text": "周五下午三点开会" }))
        .await
        .json();
    let mine = published.group.unwrap();
    assert_eq!(
        mine.notice.as_ref().map(|n| n.text.as_str()),
        Some("周五下午三点开会")
    );
    assert!(!mine.notice_unseen);
    // 成员收到一条事件，带着全文
    let pushed = one_inbox.messages();
    assert_eq!(pushed.len(), 1);
    assert_eq!(
        (pushed[0].kind, pushed[0].text.as_deref()),
        (MessageKind::NoticeChanged, Some("周五下午三点开会"))
    );
    let seen = view(&mut one, &group).await.group.unwrap();
    let notice = seen.notice.unwrap();
    assert_eq!(
        (notice.by_id.as_str(), notice.by_name.as_deref()),
        (owner.me.id.as_str(), Some(owner.me.nickname.as_str()))
    );
    assert!(seen.notice_unseen && seen.mentioned);

    // 一样的内容再发一次：什么也不变
    let again = owner
        .client
        .put(&base, json!({ "text": " 周五下午三点开会 " }))
        .await;
    assert_eq!(again.status, StatusCode::OK);
    assert!(one_inbox.messages().is_empty());

    // 看过了：自己在别处的登录也知道
    let reply = one.client.post_empty(&format!("{base}/seen")).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let notices = one_inbox.notices_seen();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].seq, pushed[0].seq);
    assert!(!view(&mut one, &group).await.group.unwrap().notice_unseen);

    // 太长的不收
    let long = "字".repeat(1001);
    let reply = owner.client.put(&base, json!({ "text": long })).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_full_group_takes_nobody_more() {
    let app = common::app().await;
    let (mut owner, _one, _two, outsider, group) = group(&app).await;
    // 管理员把群人数上限改成 3：群里已经 3 个人
    let mut admin = app.admin().await;
    let reply = admin
        .put("/api/admin/settings", json!({ "group_max_members": 3 }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());

    let reply = owner
        .client
        .post(
            &format!("/api/conversations/{group}/members"),
            json!({ "user_ids": [outsider.me.id] }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::GroupFull)
    );
}

#[tokio::test]
async fn a_manager_cannot_be_muted() {
    let app = common::app().await;
    let (mut owner, mut one, two, _outsider, group) = group(&app).await;
    let base = format!("/api/conversations/{group}");
    for admin in [&one, &two] {
        let reply = owner
            .client
            .put_empty(&format!("{base}/admins/{}", admin.me.id))
            .await;
        assert_eq!(reply.status, StatusCode::OK);
    }
    // 管理员不能禁言群主，也不能禁言别的管理员
    for target in [&owner.me.id, &two.me.id] {
        let reply = one
            .client
            .put(
                &format!("{base}/muted-members/{target}"),
                json!({ "minutes": 10 }),
            )
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::FORBIDDEN, ErrorCode::CannotMuteManager)
        );
    }
}
