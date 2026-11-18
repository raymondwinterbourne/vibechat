//! 聊天的接口：会话列表、发消息、翻历史、已读位置，以及随之发出的推送。

mod common;

use axum::http::StatusCode;
use common::{Client, TestApp};
use serde_json::json;
use tokio::sync::mpsc::Receiver;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    ConversationCleared, ConversationHidden, ConversationList, ConversationPinned,
    ConversationRead, ConversationView, ErrorCode, FriendRequestResult, Me, MessageKind,
    MessageList, MessageView, MessagesDeleted, ServerEvent,
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

/// 两个好友和他们的会话。成为好友时会话里已经有了第 1 条：一个事件。
async fn friends(app: &TestApp) -> ((Client, Me), (Client, Me), String) {
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let sent: FriendRequestResult = a
        .post("/api/friend-requests", json!({ "to": b_me.id }))
        .await
        .json();
    b.post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    let conversation = conversations(&mut a).await.remove(0).id;
    ((a, a_me), (b, b_me), conversation)
}

async fn conversations(client: &mut Client) -> Vec<ConversationView> {
    client
        .get("/api/conversations")
        .await
        .json::<ConversationList>()
        .items
}

async fn say(client: &mut Client, conversation: &str, client_id: &str, text: &str) -> MessageView {
    let reply = client
        .post(
            &format!("/api/conversations/{conversation}/messages"),
            json!({ "client_id": client_id, "text": text }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn history(client: &mut Client, conversation: &str, query: &str) -> MessageList {
    let reply = client
        .get(&format!(
            "/api/conversations/{conversation}/messages{query}"
        ))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

#[tokio::test]
async fn becoming_friends_puts_the_conversation_in_both_lists() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;

    for (client, me, other) in [(&mut a, &a_me, &b_me), (&mut b, &b_me, &a_me)] {
        let listed = conversations(client).await;
        assert_eq!(listed.len(), 1, "for {}", me.nickname);
        let view = &listed[0];
        assert_eq!(view.id, conversation);
        let peer = view.peer.as_ref().unwrap();
        assert_eq!(peer.user.id, other.id);
        assert!(peer.is_friend);
        let greeting = view.last_message.as_ref().unwrap();
        assert_eq!(
            (greeting.kind, greeting.seq, &greeting.sender_id),
            (MessageKind::Friends, 1, &None)
        );
        // 事件不算未读
        assert_eq!((view.last_seq, view.unread), (1, 0));
    }
}

#[tokio::test]
async fn a_message_is_stored_once_and_pushed_to_every_login_of_both_members() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let (mut a_inbox, mut a_elsewhere, mut b_inbox) = (
        Inbox::open(&app, &a_me),
        Inbox::open(&app, &a_me),
        Inbox::open(&app, &b_me),
    );

    let sent = say(&mut a, &conversation, "c-1", "  你好\n小红  ").await;
    assert_eq!(sent.seq, 2);
    assert_eq!(sent.conversation_id, conversation);
    assert_eq!(sent.sender_id.as_deref(), Some(a_me.id.as_str()));
    assert_eq!(sent.client_id.as_deref(), Some("c-1"));
    assert_eq!(
        (sent.kind, sent.text.as_deref()),
        (MessageKind::Text, Some("你好\n小红"))
    );

    // 对方收到；发送人自己的每一处登录也收到
    let expected = [ServerEvent::MsgNew(Box::new(sent.clone()))];
    assert_eq!(b_inbox.take(), expected);
    assert_eq!(a_inbox.take(), expected);
    assert_eq!(a_elsewhere.take(), expected);

    // 没等到结果而重发：还是那一条，不再推送，对方只有一条
    let reply = a
        .post(
            &format!("/api/conversations/{conversation}/messages"),
            json!({ "client_id": "c-1", "text": "你好（重发）" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<MessageView>(), sent);
    assert!(b_inbox.take().is_empty());
    let stored = history(&mut b, &conversation, "").await;
    assert_eq!(stored.items.len(), 2);
    assert_eq!(stored.items[1], sent);

    // 会话列表：最新消息、未读数
    let mine = conversations(&mut a).await.remove(0);
    assert_eq!((mine.last_seq, mine.unread), (2, 0));
    assert_eq!(mine.last_message, Some(sent.clone()));
    let theirs = conversations(&mut b).await.remove(0);
    assert_eq!((theirs.last_seq, theirs.unread), (2, 1));
}

#[tokio::test]
async fn messages_that_cannot_be_sent_are_refused_with_a_reason() {
    let app = common::app().await;
    let ((mut a, _), _, conversation) = friends(&app).await;
    let path = format!("/api/conversations/{conversation}/messages");

    let cases = [
        (
            json!({ "client_id": "c-1", "text": "   \n " }),
            StatusCode::BAD_REQUEST,
            ErrorCode::MessageEmpty,
        ),
        (
            json!({ "client_id": "c-1", "text": "字".repeat(4001) }),
            StatusCode::BAD_REQUEST,
            ErrorCode::MessageTooLong,
        ),
        (
            json!({ "client_id": "not a valid id", "text": "你好" }),
            StatusCode::BAD_REQUEST,
            ErrorCode::BadRequest,
        ),
        (
            json!({ "text": "你好" }),
            StatusCode::BAD_REQUEST,
            ErrorCode::BadRequest,
        ),
    ];
    for (body, status, code) in cases {
        let reply = a.post(&path, body.clone()).await;
        assert_eq!((reply.status, reply.error().code), (status, code), "{body}");
    }
    // 正好 4000 字可以发
    let reply = a
        .post(
            &path,
            json!({ "client_id": "c-2", "text": "字".repeat(4000) }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    assert_eq!(history(&mut a, &conversation, "").await.items.len(), 2);
}

#[tokio::test]
async fn a_conversation_is_closed_to_everyone_but_its_members() {
    let app = common::app().await;
    let ((mut a, _), _, conversation) = friends(&app).await;
    let (mut c, c_me) = app.user("小刚").await;
    let mut c_inbox = Inbox::open(&app, &c_me);
    say(&mut a, &conversation, "c-1", "只给小红看").await;

    for id in [
        conversation.as_str(),
        "0190a000-0000-7000-8000-000000000000",
        "not-an-id",
    ] {
        let base = format!("/api/conversations/{id}");
        let replies = [
            c.get(&base).await,
            c.get(&format!("{base}/messages")).await,
            c.post(
                &format!("{base}/messages"),
                json!({ "client_id": "c-9", "text": "插一句" }),
            )
            .await,
            c.post(&format!("{base}/read"), json!({ "seq": 1 })).await,
            c.post_empty(&format!("{base}/hide")).await,
        ];
        for reply in replies {
            assert_eq!(
                (reply.status, reply.error().code),
                (StatusCode::NOT_FOUND, ErrorCode::ConversationNotFound),
                "{id}"
            );
            assert!(!reply.text().contains("只给小红看"));
        }
    }
    assert!(conversations(&mut c).await.is_empty());
    assert!(c_inbox.take().is_empty(), "nothing is pushed to outsiders");
    assert_eq!(history(&mut a, &conversation, "").await.items.len(), 2);

    let mut anonymous = app.client();
    let reply = anonymous.get("/api/conversations").await;
    assert_eq!(reply.error().code, ErrorCode::Unauthorized);
}

#[tokio::test]
async fn history_is_read_in_pages_by_sequence_number() {
    let app = common::app().await;
    let ((mut a, _), (mut b, _), conversation) = friends(&app).await;
    // 加上成为好友时的那一条，一共 8 条
    for n in 2..=8 {
        let sender = if n % 2 == 0 { &mut a } else { &mut b };
        say(sender, &conversation, &format!("c-{n}"), &n.to_string()).await;
    }
    let seqs = |list: &MessageList| list.items.iter().map(|m| m.seq).collect::<Vec<_>>();

    let latest = history(&mut a, &conversation, "?limit=3").await;
    assert_eq!((seqs(&latest), latest.has_more), (vec![6, 7, 8], true));
    let older = history(&mut a, &conversation, "?before=6&limit=3").await;
    assert_eq!((seqs(&older), older.has_more), (vec![3, 4, 5], true));
    let oldest = history(&mut a, &conversation, "?before=3&limit=3").await;
    assert_eq!((seqs(&oldest), oldest.has_more), (vec![1, 2], false));
    let newer = history(&mut b, &conversation, "?after=5&limit=2").await;
    assert_eq!((seqs(&newer), newer.has_more), (vec![6, 7], true));
    let rest = history(&mut b, &conversation, "?after=7").await;
    assert_eq!((seqs(&rest), rest.has_more), (vec![8], false));
    assert_eq!(history(&mut a, &conversation, "").await.items.len(), 8);

    for query in [
        "?before=5&after=2",
        "?before=0",
        "?after=-1",
        "?limit=0",
        "?limit=101",
        "?before=abc",
    ] {
        let reply = a
            .get(&format!(
                "/api/conversations/{conversation}/messages{query}"
            ))
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
            "{query}"
        );
    }
}

#[tokio::test]
async fn reading_clears_the_unread_count_and_tells_the_sender() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    say(&mut a, &conversation, "c-1", "一").await;
    say(&mut a, &conversation, "c-2", "二").await;
    assert_eq!(conversations(&mut b).await[0].unread, 2);
    let (mut a_inbox, mut b_elsewhere) = (Inbox::open(&app, &a_me), Inbox::open(&app, &b_me));
    let path = format!("/api/conversations/{conversation}/read");

    let reply = b.post(&path, json!({ "seq": 3 })).await;
    assert_eq!(reply.status, StatusCode::OK);
    let read: ConversationRead = reply.json();
    assert_eq!(
        read,
        ConversationRead {
            conversation_id: conversation.clone(),
            user_id: b_me.id.clone(),
            read_seq: 3,
        }
    );
    // 发送方据此显示"已读"；读的人自己在别处的登录据此清掉未读数
    assert_eq!(a_inbox.take(), [ServerEvent::ConvRead(read.clone())]);
    assert_eq!(b_elsewhere.take(), [ServerEvent::ConvRead(read.clone())]);

    let theirs = conversations(&mut b).await.remove(0);
    assert_eq!((theirs.unread, theirs.read_seq), (0, 3));
    let mine = conversations(&mut a).await.remove(0);
    assert_eq!(mine.peer.unwrap().read_seq, 3);

    // 再报一次、往回报：位置不变，也不再推送
    for seq in [3, 1] {
        let again: ConversationRead = b.post(&path, json!({ "seq": seq })).await.json();
        assert_eq!(again.read_seq, 3);
    }
    assert!(a_inbox.take().is_empty());
    // 报得比最新的序号还大：只算到最新的
    say(&mut a, &conversation, "c-3", "三").await;
    let beyond: ConversationRead = b.post(&path, json!({ "seq": 999 })).await.json();
    assert_eq!(beyond.read_seq, 4);

    let reply = b.post(&path, json!({ "seq": -1 })).await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn a_hidden_conversation_returns_with_the_next_message() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    say(&mut b, &conversation, "c-1", "一").await;
    let (mut a_elsewhere, mut b_inbox) = (Inbox::open(&app, &a_me), Inbox::open(&app, &b_me));

    let reply = a
        .post_empty(&format!("/api/conversations/{conversation}/hide"))
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        a_elsewhere.take(),
        [ServerEvent::ConvHidden(ConversationHidden {
            conversation_id: conversation.clone(),
        })]
    );
    assert!(b_inbox.take().is_empty(), "the other side is not told");
    assert!(conversations(&mut a).await.is_empty());
    assert_eq!(conversations(&mut b).await.len(), 1);

    // 不在列表里，但按编号取得到，历史也在
    let reply = a.get(&format!("/api/conversations/{conversation}")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<ConversationView>().last_seq, 2);
    assert_eq!(history(&mut a, &conversation, "").await.items.len(), 2);

    say(&mut b, &conversation, "c-2", "二").await;
    let back = conversations(&mut a).await;
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].unread, 2);
}

#[tokio::test]
async fn opening_a_conversation_with_a_friend_always_gives_the_same_one() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let (mut c, c_me) = app.user("小刚").await;

    // 由哪一方打开、打开多少次，都是同一个
    for _ in 0..2 {
        for (client, other) in [(&mut a, &b_me), (&mut b, &a_me)] {
            let reply = client
                .post("/api/conversations/direct", json!({ "user_id": other.id }))
                .await;
            assert_eq!(reply.status, StatusCode::OK);
            let view: ConversationView = reply.json();
            assert_eq!(view.id, conversation);
            assert_eq!(view.peer.unwrap().user.id, other.id);
        }
    }

    // 不是好友、不存在的人、格式不对的编号
    for user_id in [
        c_me.id.as_str(),
        "0190a000-0000-7000-8000-000000000000",
        "not-an-id",
    ] {
        let reply = a
            .post("/api/conversations/direct", json!({ "user_id": user_id }))
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::NOT_FOUND, ErrorCode::NotFriends),
            "{user_id}"
        );
    }
    let reply = c
        .post("/api/conversations/direct", json!({ "user_id": a_me.id }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotFriends);
}

#[tokio::test]
async fn everyone_has_a_conversation_with_themselves() {
    let app = common::app().await;
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, _) = app.user("小红").await;

    // 不用是谁的好友；对方就是自己
    let reply = a
        .post("/api/conversations/direct", json!({ "user_id": a_me.id }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let view: ConversationView = reply.json();
    let peer = view.peer.clone().unwrap();
    assert_eq!(peer.user.id, a_me.id);
    assert!(peer.is_self);
    assert!(peer.is_friend);
    assert!(view.group.is_none());
    // 普通的单聊里对方不是自己
    let ((mut c, _), (_, d_me), _) = friends(&app).await;
    let view_cd: ConversationView = c
        .post("/api/conversations/direct", json!({ "user_id": d_me.id }))
        .await
        .json();
    assert!(!view_cd.peer.unwrap().is_self);

    // 能发、能看；在列表里；自己发的不算未读
    let sent = a
        .post(
            &format!("/api/conversations/{}/messages", view.id),
            json!({ "client_id": "self-1", "text": "备忘" }),
        )
        .await;
    assert_eq!(sent.status, StatusCode::CREATED, "{}", sent.text());
    let list: ConversationList = a.get("/api/conversations").await.json();
    let mine = list.items.iter().find(|c| c.id == view.id).unwrap();
    assert_eq!(mine.unread, 0);
    assert!(mine.peer.as_ref().unwrap().is_self);

    // 别人看不到它
    let reply = b.get(&format!("/api/conversations/{}", view.id)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn after_unfriending_nothing_more_can_be_sent_but_the_history_stays() {
    let app = common::app().await;
    let ((mut a, _), (mut b, b_me), conversation) = friends(&app).await;
    say(&mut a, &conversation, "c-1", "还是好友的时候").await;
    assert_eq!(
        a.delete(&format!("/api/friends/{}", b_me.id)).await.status,
        StatusCode::NO_CONTENT
    );

    for client in [&mut a, &mut b] {
        let reply = client
            .post(
                &format!("/api/conversations/{conversation}/messages"),
                json!({ "client_id": "c-after", "text": "还在吗" }),
            )
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::NOT_FOUND, ErrorCode::NotFriends)
        );
        let listed = conversations(client).await;
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].peer.as_ref().unwrap().is_friend);
        assert_eq!(history(client, &conversation, "").await.items.len(), 2);
    }
}

#[tokio::test]
async fn pinning_moves_a_conversation_to_the_top_on_every_device_of_mine() {
    let app = common::app().await;
    let ((mut a, a_me), (_b, b_me), conversation) = friends(&app).await;
    let mut elsewhere = Inbox::open(&app, &a_me);
    let mut theirs = Inbox::open(&app, &b_me);

    let reply = a
        .put(
            &format!("/api/conversations/{conversation}/pin"),
            json!({ "pinned": true }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let pinned: ConversationPinned = reply.json();
    assert_eq!(pinned.conversation_id, conversation);
    assert!(pinned.pinned_at.is_some());
    assert_eq!(
        elsewhere.take(),
        vec![ServerEvent::ConvPinned(pinned.clone())]
    );
    assert!(theirs.take().is_empty());
    assert_eq!(conversations(&mut a).await[0].pinned_at, pinned.pinned_at);

    let unpinned: ConversationPinned = a
        .put(
            &format!("/api/conversations/{conversation}/pin"),
            json!({ "pinned": false }),
        )
        .await
        .json();
    assert_eq!(unpinned.pinned_at, None);
    assert_eq!(conversations(&mut a).await[0].pinned_at, None);
}

#[tokio::test]
async fn deleting_for_myself_tells_only_my_other_windows() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let one = say(&mut b, &conversation, "c-1", "一").await;
    let two = say(&mut b, &conversation, "c-2", "二").await;
    let mut elsewhere = Inbox::open(&app, &a_me);
    let mut theirs = Inbox::open(&app, &b_me);

    let reply = a
        .post(
            &format!("/api/conversations/{conversation}/messages/delete"),
            json!({ "seqs": [two.seq] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let deleted: MessagesDeleted = reply.json();
    assert_eq!(deleted.seqs, vec![two.seq]);
    assert_eq!(elsewhere.take(), vec![ServerEvent::MsgDeleted(deleted)]);
    assert!(theirs.take().is_empty());

    let mine: MessageList = a
        .get(&format!("/api/conversations/{conversation}/messages"))
        .await
        .json();
    assert!(mine.items.iter().all(|m| m.seq != two.seq));
    assert!(mine.items.iter().any(|m| m.seq == one.seq));
    let theirs_list: MessageList = b
        .get(&format!("/api/conversations/{conversation}/messages"))
        .await
        .json();
    assert!(theirs_list.items.iter().any(|m| m.seq == two.seq));

    let reply = a
        .post(
            &format!("/api/conversations/{conversation}/messages/delete"),
            json!({ "seqs": [999] }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::MessageNotFound);
}

#[tokio::test]
async fn clearing_a_chat_empties_it_for_me_and_counts_as_read() {
    let app = common::app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let last = say(&mut b, &conversation, "c-1", "一").await;
    let mut elsewhere = Inbox::open(&app, &a_me);
    let mut theirs = Inbox::open(&app, &b_me);

    let reply = a
        .post(
            &format!("/api/conversations/{conversation}/clear"),
            json!({}),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let cleared: ConversationCleared = reply.json();
    assert_eq!(cleared.cleared_seq, last.seq);
    let read = ServerEvent::ConvRead(ConversationRead {
        conversation_id: conversation.clone(),
        user_id: a_me.id.clone(),
        read_seq: last.seq,
    });
    let mine = elsewhere.take();
    assert!(mine.contains(&ServerEvent::ConvCleared(cleared.clone())));
    assert!(mine.contains(&read));
    // 对方只知道我读过了
    assert_eq!(theirs.take(), vec![read]);

    let list: MessageList = a
        .get(&format!("/api/conversations/{conversation}/messages"))
        .await
        .json();
    assert!(list.items.is_empty());
    let listed = conversations(&mut a).await;
    let item = listed
        .iter()
        .find(|c| c.id == conversation)
        .expect("still listed");
    assert_eq!((item.last_message.is_none(), item.unread), (true, 0));
}
