//! 聊天业务流程的测试。数据在内存里，时间可以拨动，不需要数据库。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use super::service::{HISTORY_PAGE_SIZE, MESSAGE_MAX_CHARS};
use super::{ChatError, ChatService, Conversation, HistoryQuery, MessageKind};
use crate::account::model::User;
use crate::account::{AccountService, Limits, Registration};
use crate::clock::Clock;
use crate::contact::ContactService;
use crate::ids::{ConversationId, UserId};
use crate::testing::{ManualClock, MemoryStore, account_service, chat_service, contact_service};

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    accounts: AccountService,
    contacts: ContactService,
    chat: ChatService,
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
        chat: chat_service(&store, clock.clone()),
        store,
        clock,
        registered: AtomicU32::new(0),
    }
}

impl Fixture {
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

    /// 两个好友，以及他们的单聊会话。
    async fn friends(&self) -> (User, User, Conversation) {
        let (a, b) = (self.user("小明").await, self.user("小红").await);
        let conversation = self.befriend(&a, &b).await;
        (a, b, conversation)
    }

    async fn befriend(&self, a: &User, b: &User) -> Conversation {
        let sent = self.contacts.send_request(a, b.id, "").await.unwrap();
        self.contacts
            .accept_request(b, sent.request.id)
            .await
            .unwrap();
        self.chat.open_direct(a, b.id).await.unwrap().conversation
    }

    /// 发一条消息，客户端消息编号每次都不同。返回它的序号。
    async fn say(&self, from: &User, conversation: &Conversation, text: &str) -> i64 {
        let client_id = format!("c-{}", self.registered.fetch_add(1, Ordering::Relaxed));
        self.chat
            .send_text(from, conversation.id, &client_id, text)
            .await
            .unwrap()
            .message
            .seq
    }

    async fn texts(
        &self,
        me: &User,
        conversation: &Conversation,
        query: HistoryQuery,
    ) -> Vec<String> {
        self.chat
            .history(me, conversation.id, query)
            .await
            .unwrap()
            .messages
            .iter()
            .map(|message| message.text.clone().unwrap_or_default())
            .collect()
    }
}

// ---------- 会话 ----------

#[tokio::test]
async fn two_friends_share_exactly_one_conversation() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;

    // 由哪一方打开、打开多少次，都是同一个
    for (me, other) in [(&a, &b), (&b, &a), (&a, &b)] {
        let opened = f.chat.open_direct(me, other.id).await.unwrap();
        assert_eq!(opened.conversation.id, conversation.id);
        // 还没有内容，但已经知道对方是谁
        assert_eq!(opened.peer.as_ref().unwrap().card.id, other.id);
        assert!(opened.peer.as_ref().unwrap().is_friend);
        assert_eq!((opened.last_message, opened.unread), (None, 0));
    }
    assert_eq!(conversation.last_seq, 0);
}

#[tokio::test]
async fn a_conversation_can_only_be_opened_with_a_friend() {
    let f = fixture().await;
    let (a, b) = (f.user("小明").await, f.user("小红").await);
    // 发过申请但对方还没有同意，不算好友
    f.contacts.send_request(&a, b.id, "").await.unwrap();

    for who in [b.id, UserId::new()] {
        let err = f.chat.open_direct(&a, who).await.unwrap_err();
        assert!(matches!(err, ChatError::NotFriends));
    }
}

#[tokio::test]
async fn everyone_can_talk_to_themselves() {
    let f = fixture().await;
    let me = f.user("小明").await;
    let opened = f.chat.open_direct(&me, me.id).await.unwrap();
    let peer = opened.peer.clone().unwrap();
    assert_eq!(peer.card.id, me.id);
    assert!(peer.is_self);
    assert!(peer.is_friend);
    assert_eq!(peer.remark, None);
    assert!(opened.group.is_none());
    // 再打开还是同一个
    let again = f.chat.open_direct(&me, me.id).await.unwrap();
    assert_eq!(again.conversation.id, opened.conversation.id);

    // 能发消息；成员只有我一个，所以只发给我自己；自己发的不算未读
    let posted = f
        .chat
        .send_text(&me, opened.conversation.id, "c-self", "记一下")
        .await
        .unwrap();
    assert_eq!(posted.members, vec![me.id]);
    let listed = f.chat.list(&me).await.unwrap();
    let mine = listed
        .iter()
        .find(|c| c.conversation.id == opened.conversation.id)
        .unwrap();
    assert_eq!(mine.unread, 0);
    assert!(mine.peer.as_ref().unwrap().is_self);
    assert_eq!(
        f.texts(&me, &opened.conversation, HistoryQuery::default())
            .await,
        vec!["记一下"]
    );

    // 在别人的列表里不存在
    let other = f.user("小红").await;
    let err = f
        .chat
        .conversation(&other, opened.conversation.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
}

#[tokio::test]
async fn an_empty_conversation_is_not_listed() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    assert!(f.chat.list(&a).await.unwrap().is_empty());

    f.say(&a, &conversation, "你好").await;
    for me in [&a, &b] {
        let listed = f.chat.list(me).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].conversation.id, conversation.id);
    }
}

#[tokio::test]
async fn becoming_friends_writes_a_greeting_that_lists_the_conversation() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;

    let posted = f.chat.greet_new_friends(a.id, b.id).await.unwrap();
    assert_eq!(posted.message.conversation, conversation.id);
    assert_eq!(posted.message.kind, MessageKind::Friends);
    assert_eq!((posted.message.seq, posted.message.sender), (1, None));
    assert_eq!(posted.message.text, None);
    let mut members = posted.members.clone();
    members.sort();
    let mut expected = vec![a.id, b.id];
    expected.sort();
    assert_eq!(members, expected);

    // 双方的列表里都出现了这个会话。事件不是谁发的，不算未读
    for me in [&a, &b] {
        let listed = f.chat.list(me).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].last_message.as_ref(), Some(&posted.message));
        assert_eq!(listed[0].unread, 0);
    }
}

// ---------- 发消息 ----------

#[tokio::test]
async fn a_message_gets_the_next_sequence_number_and_goes_to_both_members() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;

    let first = f
        .chat
        .send_text(&a, conversation.id, "c-1", "  你好\n世界  ")
        .await
        .unwrap();
    assert!(!first.duplicate);
    assert_eq!(first.message.seq, 1);
    assert_eq!(first.message.sender, Some(a.id));
    assert_eq!(first.message.kind, MessageKind::Text);
    assert_eq!(
        first.message.text.as_deref(),
        Some("你好\n世界"),
        "trimmed, line breaks kept"
    );
    assert_eq!(first.message.created_at, f.clock.now_ms());
    assert_eq!(first.members.len(), 2);
    assert!(first.members.contains(&a.id) && first.members.contains(&b.id));

    let second = f
        .chat
        .send_text(&b, conversation.id, "c-1", "收到")
        .await
        .unwrap();
    assert_eq!(
        second.message.seq, 2,
        "the same client id from another sender is a new message"
    );
}

#[tokio::test]
async fn sending_again_with_the_same_client_id_does_not_duplicate() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;

    let first = f
        .chat
        .send_text(&a, conversation.id, "c-1", "你好")
        .await
        .unwrap();
    f.clock.advance(5000);
    // 没等到结果而重发：内容即使不同，也以第一次为准
    let again = f
        .chat
        .send_text(&a, conversation.id, "c-1", "你好（重发）")
        .await
        .unwrap();

    assert!(again.duplicate);
    assert_eq!(again.message, first.message);
    assert_eq!(again.members.len(), 2);
    assert_eq!(
        f.texts(&a, &conversation, HistoryQuery::default()).await,
        ["你好"]
    );
}

#[tokio::test]
async fn text_is_cleaned_and_limited() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;
    let send = |client_id: &'static str, text: String| {
        let (chat, a, id) = (&f.chat, &a, conversation.id);
        async move { chat.send_text(a, id, client_id, &text).await }
    };

    for empty in ["", "   ", "\n\n", "\u{0}\u{7}"] {
        let err = send("c-empty", empty.to_owned()).await.unwrap_err();
        assert!(matches!(err, ChatError::MessageEmpty), "{empty:?}");
    }

    // 换行和制表符保留，其余的控制字符去掉；表情符号按一个字算
    let posted = send("c-1", "a\tb\r\nc\u{0}d 😀".to_owned()).await.unwrap();
    assert_eq!(posted.message.text.as_deref(), Some("a\tb\ncd 😀"));

    let longest = "好".repeat(MESSAGE_MAX_CHARS);
    assert!(send("c-2", longest.clone()).await.is_ok());
    let err = send("c-3", format!("{longest}好")).await.unwrap_err();
    assert!(matches!(err, ChatError::MessageTooLong));
}

#[tokio::test]
async fn the_client_id_must_look_like_an_id() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;

    for bad in ["", "has space", "a/b", &"x".repeat(37)] {
        let err = f
            .chat
            .send_text(&a, conversation.id, bad, "你好")
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::Invalid(_)), "{bad:?}");
    }
    let uuid = "0190a000-0000-7000-8000-000000000000";
    assert!(
        f.chat
            .send_text(&a, conversation.id, uuid, "你好")
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn only_members_can_send_read_or_touch_a_conversation() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;
    let c = f.user("小刚").await;
    f.say(&a, &conversation, "只给小红看").await;

    let id = conversation.id;
    let errors = [
        f.chat.send_text(&c, id, "c-9", "插一句").await.err(),
        f.chat.history(&c, id, HistoryQuery::default()).await.err(),
        f.chat.mark_read(&c, id, 1).await.err(),
        f.chat.hide(&c, id).await.err(),
        f.chat.conversation(&c, id).await.err(),
        // 不存在的会话也是同一种回答
        f.chat
            .history(&a, ConversationId::new(), HistoryQuery::default())
            .await
            .err(),
    ];
    for err in errors {
        assert!(matches!(err, Some(ChatError::ConversationNotFound)));
    }
    assert!(f.chat.list(&c).await.unwrap().is_empty());
}

#[tokio::test]
async fn after_unfriending_the_history_stays_but_nothing_more_can_be_sent() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    f.say(&a, &conversation, "还是好友的时候").await;

    f.contacts.remove_friend(&a, b.id).await.unwrap();
    for me in [&a, &b] {
        let err = f
            .chat
            .send_text(me, conversation.id, "c-after", "还在吗")
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::NotFriends));
        assert_eq!(
            f.texts(me, &conversation, HistoryQuery::default()).await,
            ["还是好友的时候"]
        );
        // 列表里还在，并标明已经不是好友
        let listed = f.chat.list(me).await.unwrap();
        assert!(!listed[0].peer.as_ref().unwrap().is_friend);
    }

    // 重新成为好友之后，还是原来的会话，可以接着聊
    let again = f.befriend(&b, &a).await;
    assert_eq!(again.id, conversation.id);
    assert_eq!(f.say(&b, &conversation, "又是好友了").await, 2);
}

// ---------- 历史 ----------

#[tokio::test]
async fn history_is_read_in_pages_in_either_direction() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    for n in 1..=7 {
        f.say(
            if n % 2 == 0 { &a } else { &b },
            &conversation,
            &n.to_string(),
        )
        .await;
    }
    let page = |before, after, limit| {
        let (chat, a, id) = (&f.chat, &a, conversation.id);
        let query = HistoryQuery {
            before,
            after,
            limit,
        };
        async move {
            let page = chat.history(a, id, query).await.unwrap();
            let seqs: Vec<i64> = page.messages.iter().map(|m| m.seq).collect();
            (seqs, page.has_more)
        }
    };

    // 不指定方向：最新的一段，按序号从小到大
    assert_eq!(page(None, None, Some(3)).await, (vec![5, 6, 7], true));
    // 向上翻：接着上一段最早的那一条往前
    assert_eq!(page(Some(5), None, Some(3)).await, (vec![2, 3, 4], true));
    assert_eq!(page(Some(2), None, Some(3)).await, (vec![1], false));
    assert_eq!(page(Some(1), None, Some(3)).await, (vec![], false));
    // 补齐：某个序号之后的
    assert_eq!(page(None, Some(4), Some(2)).await, (vec![5, 6], true));
    assert_eq!(page(None, Some(6), Some(2)).await, (vec![7], false));
    assert_eq!(page(None, Some(7), Some(2)).await, (vec![], false));
    assert_eq!(page(None, Some(0), None).await.0.len(), 7);
    // 正好取完时没有"更多"
    assert_eq!(page(None, None, Some(7)).await, ((1..=7).collect(), false));
}

#[tokio::test]
async fn the_default_page_holds_the_latest_fifty() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;
    for n in 0..HISTORY_PAGE_SIZE + 5 {
        f.say(&a, &conversation, &n.to_string()).await;
    }
    let page = f
        .chat
        .history(&a, conversation.id, HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(page.messages.len(), HISTORY_PAGE_SIZE as usize);
    assert_eq!(page.messages.first().unwrap().seq, 6);
    assert!(page.has_more);
}

#[tokio::test]
async fn nonsense_history_queries_are_refused() {
    let f = fixture().await;
    let (a, _b, conversation) = f.friends().await;
    let bad = [
        HistoryQuery {
            before: Some(5),
            after: Some(1),
            limit: None,
        },
        HistoryQuery {
            before: Some(0),
            ..HistoryQuery::default()
        },
        HistoryQuery {
            after: Some(-1),
            ..HistoryQuery::default()
        },
        HistoryQuery {
            limit: Some(0),
            ..HistoryQuery::default()
        },
        HistoryQuery {
            limit: Some(101),
            ..HistoryQuery::default()
        },
    ];
    for query in bad {
        let err = f
            .chat
            .history(&a, conversation.id, query)
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::Invalid(_)), "{query:?}");
    }
}

// ---------- 已读和未读 ----------

#[tokio::test]
async fn unread_counts_what_others_sent_after_my_read_position() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    let unread = |me: &User| {
        let (chat, me) = (&f.chat, me.clone());
        async move {
            let listed = chat.list(&me).await.unwrap();
            (listed[0].unread, listed[0].read_seq)
        }
    };

    f.say(&a, &conversation, "一").await;
    f.say(&a, &conversation, "二").await;
    f.say(&b, &conversation, "三").await;
    // 自己发的不算未读
    assert_eq!(unread(&b).await, (2, 0));
    assert_eq!(unread(&a).await, (1, 0));

    let update = f.chat.mark_read(&b, conversation.id, 2).await.unwrap();
    assert!(update.changed);
    assert_eq!((update.read_seq, update.members.len()), (2, 2));
    assert_eq!(unread(&b).await, (0, 2));
    // 对方的已读位置在我这边看得到：序号不大于它的他都看过了
    let listed = f.chat.list(&a).await.unwrap();
    assert_eq!(listed[0].peer.as_ref().unwrap().read_seq, 2);

    f.say(&a, &conversation, "四").await;
    assert_eq!(unread(&b).await, (1, 2));
}

#[tokio::test]
async fn the_read_position_only_moves_forward_and_never_past_the_end() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    for text in ["一", "二", "三"] {
        f.say(&a, &conversation, text).await;
    }
    let id = conversation.id;

    assert_eq!(f.chat.mark_read(&b, id, 2).await.unwrap().read_seq, 2);
    // 往回报：不改动
    let back = f.chat.mark_read(&b, id, 1).await.unwrap();
    assert_eq!((back.read_seq, back.changed), (2, false));
    let same = f.chat.mark_read(&b, id, 2).await.unwrap();
    assert_eq!((same.read_seq, same.changed), (2, false));
    // 报得比最新的序号还大：只算到最新的
    let beyond = f.chat.mark_read(&b, id, 99).await.unwrap();
    assert_eq!((beyond.read_seq, beyond.changed), (3, true));

    let err = f.chat.mark_read(&b, id, -1).await.unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
}

// ---------- 列表 ----------

#[tokio::test]
async fn the_list_shows_the_peer_the_latest_message_and_newest_first() {
    let f = fixture().await;
    let (a, b, with_b) = f.friends().await;
    let c = f.user("小刚").await;
    let with_c = f.befriend(&a, &c).await;
    f.contacts.set_remark(&a, b.id, "红姐").await.unwrap();

    f.say(&b, &with_b, "早").await;
    f.clock.advance(1000);
    f.say(&c, &with_c, "在吗").await;
    f.clock.advance(1000);

    let listed = f.chat.list(&a).await.unwrap();
    let ids: Vec<_> = listed.iter().map(|info| info.conversation.id).collect();
    assert_eq!(ids, [with_c.id, with_b.id]);
    let peer = listed[1].peer.as_ref().unwrap();
    assert_eq!(peer.card.id, b.id);
    assert_eq!(peer.remark.as_deref(), Some("红姐"));
    assert!(peer.is_friend);
    assert_eq!(
        listed[1].last_message.as_ref().unwrap().text.as_deref(),
        Some("早")
    );

    // 有了新消息的会话排到最前面
    f.say(&a, &with_b, "早上好").await;
    let listed = f.chat.list(&a).await.unwrap();
    assert_eq!(listed[0].conversation.id, with_b.id);
    assert_eq!(listed[0].conversation.last_seq, 2);
    // 对方那边看到的是我，没有备注
    let theirs = f.chat.list(&b).await.unwrap();
    let peer = theirs[0].peer.as_ref().unwrap();
    assert_eq!((peer.card.id, peer.remark.clone()), (a.id, None));
}

#[tokio::test]
async fn a_hidden_conversation_comes_back_with_the_next_message() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    f.say(&b, &conversation, "一").await;

    f.chat.hide(&a, conversation.id).await.unwrap();
    assert!(f.chat.list(&a).await.unwrap().is_empty());
    // 不在列表里，但按编号仍然取得到
    let hidden = f.chat.conversation(&a, conversation.id).await.unwrap();
    assert_eq!(hidden.conversation.last_seq, 1);
    assert_eq!(hidden.last_message.unwrap().text.as_deref(), Some("一"));
    assert_eq!(
        f.chat.list(&b).await.unwrap().len(),
        1,
        "only my side is hidden"
    );
    // 历史还在
    assert_eq!(
        f.texts(&a, &conversation, HistoryQuery::default()).await,
        ["一"]
    );

    f.say(&b, &conversation, "二").await;
    let listed = f.chat.list(&a).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].unread, 2);
    assert_eq!(
        f.texts(&a, &conversation, HistoryQuery::default()).await,
        ["一", "二"]
    );
}

// ---------- 群 ----------

use super::service::{GROUP_MAX_MEMBERS_DEFAULT, GROUP_MAX_MEMBERS_SETTING, GROUP_NAME_MAX_CHARS};
use super::{ConversationInfo, ConversationKind, Draft, Posted};
use crate::contact::Relation;
use crate::ids::FileId;
use crate::settings::SettingsStore;

impl Fixture {
    /// 一个群主和他的若干好友。好友之间互相不是好友。
    async fn owner_with_friends(&self, count: usize) -> (User, Vec<User>) {
        let owner = self.user("群主").await;
        let mut friends = Vec::new();
        for n in 0..count {
            let friend = self.user(&format!("成员{}", n + 1)).await;
            self.befriend(&owner, &friend).await;
            friends.push(friend);
        }
        (owner, friends)
    }

    /// 群主拉这些好友建一个群，返回群的编号。
    async fn group(&self, owner: &User, members: &[&User]) -> ConversationId {
        let ids: Vec<UserId> = members.iter().map(|user| user.id).collect();
        let posted = self.chat.create_group(owner, "", &ids).await.unwrap();
        posted.message.conversation
    }

    async fn info(&self, me: &User, group: ConversationId) -> ConversationInfo {
        self.chat.conversation(me, group).await.unwrap()
    }

    /// 我在这个群里能看到的全部条目的类型，按顺序。
    async fn kinds(&self, me: &User, group: ConversationId) -> Vec<MessageKind> {
        let page = self.chat.history(me, group, HistoryQuery::default()).await;
        page.unwrap().messages.iter().map(|m| m.kind).collect()
    }

    async fn group_say(&self, from: &User, group: ConversationId, text: &str) -> Posted {
        let client_id = format!("g-{}", self.registered.fetch_add(1, Ordering::Relaxed));
        self.chat
            .send_text(from, group, &client_id, text)
            .await
            .unwrap()
    }
}

fn sorted(mut ids: Vec<UserId>) -> Vec<UserId> {
    ids.sort();
    ids
}

#[tokio::test]
async fn a_group_is_created_from_friends_with_its_creator_as_owner() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;

    let posted = f
        .chat
        .create_group(
            &owner,
            "  项目组  ",
            &[friends[0].id, friends[1].id, friends[0].id],
        )
        .await
        .unwrap();
    let event = &posted.message;
    assert_eq!(
        (event.kind, event.seq, event.sender),
        (MessageKind::GroupCreated, 1, None)
    );
    assert_eq!(event.data.actor.as_ref().unwrap().id, owner.id);
    assert_eq!(event.data.actor.as_ref().unwrap().nickname, "群主");
    let invited: Vec<UserId> = event.data.targets.iter().map(|p| p.id).collect();
    assert_eq!(
        invited,
        [friends[0].id, friends[1].id],
        "duplicates are dropped"
    );
    assert_eq!(
        sorted(posted.members.clone()),
        sorted(vec![owner.id, friends[0].id, friends[1].id])
    );

    // 三个人的列表里都有这个群
    for me in [&owner, &friends[0], &friends[1]] {
        let listed = f.chat.list(me).await.unwrap();
        let info = listed
            .iter()
            .find(|info| info.conversation.id == event.conversation)
            .expect("the group is listed");
        assert_eq!(info.conversation.kind, ConversationKind::Group);
        assert_eq!(info.conversation.name.as_deref(), Some("项目组"));
        assert_eq!(info.conversation.owner, Some(owner.id));
        assert!(info.peer.is_none());
        let group = info.group.as_ref().unwrap();
        assert_eq!(
            (group.member_count, group.max_members),
            (3, GROUP_MAX_MEMBERS_DEFAULT)
        );
        assert!(!group.left && !group.mentioned);
        assert_eq!(group.name_hint, ["群主", "成员1", "成员2"]);
        assert_eq!(info.unread, 0, "events are not unread");
    }
    assert_eq!(f.chat.groups(&friends[0]).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_group_needs_two_friends_a_sane_name_and_room() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let stranger = f.user("路人").await;
    let ids = [friends[0].id, friends[1].id];

    // 至少选两个人；自己不算
    for members in [vec![], vec![friends[0].id], vec![friends[0].id, owner.id]] {
        let err = f.chat.create_group(&owner, "", &members).await.unwrap_err();
        assert!(matches!(err, ChatError::GroupTooSmall), "{members:?}");
    }
    // 只能拉自己的好友
    let err = f
        .chat
        .create_group(&owner, "", &[friends[0].id, stranger.id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotFriends));
    // 好友的好友也不行：成员 1 和成员 2 互相不是好友
    let err = f
        .chat
        .create_group(&friends[0], "", &[owner.id, friends[1].id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotFriends));

    let longest = "群".repeat(GROUP_NAME_MAX_CHARS);
    assert!(f.chat.create_group(&owner, &longest, &ids).await.is_ok());
    let err = f
        .chat
        .create_group(&owner, &format!("{longest}群"), &ids)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupNameTooLong));
    // 名字可以不起
    let unnamed = f.chat.create_group(&owner, "   ", &ids).await.unwrap();
    assert_eq!(
        f.info(&owner, unnamed.message.conversation)
            .await
            .conversation
            .name,
        None
    );
}

#[tokio::test]
async fn the_size_limit_comes_from_the_settings_and_counts_the_owner() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(4).await;
    f.store.set(GROUP_MAX_MEMBERS_SETTING, "4").await.unwrap();
    let all: Vec<UserId> = friends.iter().map(|user| user.id).collect();

    // 群主加四个人是五个，超过了四
    let err = f.chat.create_group(&owner, "", &all).await.unwrap_err();
    assert!(matches!(err, ChatError::GroupFull { room: 3 }));

    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    assert_eq!(f.info(&owner, group).await.group.unwrap().max_members, 4);
    // 还能加一个；一次加两个整个被拒绝，一个也不加
    let err = f
        .chat
        .invite(&owner, group, &[friends[2].id, friends[3].id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupFull { room: 1 }));
    assert_eq!(f.info(&owner, group).await.group.unwrap().member_count, 3);
    assert!(
        f.chat
            .invite(&owner, group, &[friends[2].id])
            .await
            .unwrap()
            .joined()
            .is_some()
    );
    let err = f
        .chat
        .invite(&owner, group, &[friends[3].id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupFull { room: 0 }));

    // 有人离开之后腾出了位置
    f.chat.leave(&friends[0], group).await.unwrap();
    assert!(
        f.chat
            .invite(&owner, group, &[friends[3].id])
            .await
            .unwrap()
            .joined()
            .is_some()
    );

    // 设置成没法用的值时用默认的
    f.store
        .set(GROUP_MAX_MEMBERS_SETTING, "nonsense")
        .await
        .unwrap();
    assert_eq!(
        f.info(&owner, group).await.group.unwrap().max_members,
        GROUP_MAX_MEMBERS_DEFAULT
    );
}

#[tokio::test]
async fn any_member_can_invite_their_own_friends() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(3).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    let (member, outsider) = (&friends[0], &friends[2]);

    // 成员 1 不是成员 3 的好友：拉不了
    let err = f
        .chat
        .invite(member, group, &[outsider.id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotFriends));
    f.befriend(member, outsider).await;

    let posted = f
        .chat
        .invite(member, group, &[outsider.id, friends[1].id])
        .await
        .unwrap()
        .joined()
        .expect("someone joined");
    let event = &posted.message;
    assert_eq!(event.kind, MessageKind::MemberJoined);
    assert_eq!(event.data.actor.as_ref().unwrap().id, member.id);
    // 已经在群里的跳过，事件里只有新来的
    let joined: Vec<UserId> = event.data.targets.iter().map(|p| p.id).collect();
    assert_eq!(joined, [outsider.id]);
    assert_eq!(posted.members.len(), 4);
    assert!(posted.members.contains(&outsider.id));

    // 要加的人都已经在群里：什么也不做
    assert!(
        f.chat
            .invite(member, group, &[outsider.id])
            .await
            .unwrap()
            .joined()
            .is_none()
    );
    assert_eq!(f.info(&owner, group).await.group.unwrap().member_count, 4);

    // 不在群里的人不能往里拉人
    let stranger = f.user("路人").await;
    let err = f
        .chat
        .invite(&stranger, group, &[owner.id])
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
}

#[tokio::test]
async fn a_newcomer_sees_only_what_came_after_joining() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(3).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    f.group_say(&owner, group, "入群之前的").await;
    f.group_say(&friends[0], group, "也是之前的").await;

    let newcomer = &friends[2];
    f.chat.invite(&owner, group, &[newcomer.id]).await.unwrap();
    f.group_say(&owner, group, "欢迎").await;

    // 新成员：从"加入"这条事件开始
    assert_eq!(
        f.kinds(newcomer, group).await,
        [MessageKind::MemberJoined, MessageKind::Text]
    );
    assert_eq!(f.texts_in(newcomer, group).await, ["", "欢迎"]);
    let info = f.info(newcomer, group).await;
    assert_eq!(
        (info.last_seq, info.unread),
        (5, 1),
        "only what came after counts"
    );
    // 按序号去要入群之前的，也取不到
    let page = f
        .chat
        .history(
            newcomer,
            group,
            HistoryQuery {
                before: Some(4),
                ..HistoryQuery::default()
            },
        )
        .await
        .unwrap();
    assert!(page.messages.is_empty());
    assert!(!page.has_more);
    let page = f
        .chat
        .history(
            newcomer,
            group,
            HistoryQuery {
                after: Some(0),
                ..HistoryQuery::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page.messages.first().unwrap().seq, 4);

    // 老成员看得到全部
    assert_eq!(f.kinds(&owner, group).await.len(), 5);
}

impl Fixture {
    async fn texts_in(&self, me: &User, group: ConversationId) -> Vec<String> {
        let page = self.chat.history(me, group, HistoryQuery::default()).await;
        page.unwrap()
            .messages
            .iter()
            .map(|m| m.text.clone().unwrap_or_default())
            .collect()
    }
}

#[tokio::test]
async fn group_messages_reach_everyone_in_one_order_with_the_sender_named() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;

    let first = f.group_say(&friends[0], group, "一").await;
    assert_eq!(first.sender_name.as_deref(), Some("成员1"));
    assert_eq!(first.members.len(), 3);
    f.group_say(&owner, group, "二").await;
    f.group_say(&friends[1], group, "三").await;

    for me in [&owner, &friends[0], &friends[1]] {
        assert_eq!(f.texts_in(me, group).await, ["", "一", "二", "三"]);
    }
    let page = f
        .chat
        .history(&owner, group, HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(
        page.sender_names.get(&friends[1].id).map(String::as_str),
        Some("成员2")
    );
    assert_eq!(page.sender_names.len(), 3);

    // 列表里：最新一条是谁发的，别人发的算未读
    let info = f.info(&owner, group).await;
    assert_eq!(info.last_sender_name.as_deref(), Some("成员2"));
    assert_eq!(info.unread, 2);
    assert_eq!(f.info(&friends[1], group).await.unread, 2);
}

#[tokio::test]
async fn members_who_are_not_friends_can_talk_in_the_group_but_not_in_private() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;

    f.group_say(&friends[0], group, "大家好").await;
    let err = f
        .chat
        .open_direct(&friends[0], friends[1].id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotFriends));

    // 同一个群的成员可以互相看资料，并看出还不是好友
    let profile = f
        .chat
        .member_profile(&friends[0], group, friends[1].id)
        .await
        .unwrap();
    assert_eq!(profile.card.id, friends[1].id);
    assert_eq!(profile.relation, Relation::None);
    let me = f
        .chat
        .member_profile(&owner, group, owner.id)
        .await
        .unwrap();
    assert_eq!(me.relation, Relation::Myself);
    let friend = f
        .chat
        .member_profile(&owner, group, friends[0].id)
        .await
        .unwrap();
    assert_eq!(friend.relation, Relation::Friend);

    // 不在这个群里的人看不到，也查不到
    let stranger = f.user("路人").await;
    let err = f
        .chat
        .member_profile(&stranger, group, owner.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
    let err = f
        .chat
        .member_profile(&owner, group, stranger.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));
}

#[tokio::test]
async fn the_member_list_names_the_owner_and_keeps_those_who_left() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    f.contacts
        .set_remark(&owner, friends[0].id, "老一")
        .await
        .unwrap();
    f.chat.leave(&friends[1], group).await.unwrap();

    let members = f.chat.members(&owner, group).await.unwrap();
    let find = |user: &User| members.iter().find(|m| m.card.id == user.id).unwrap();
    assert_eq!(members.len(), 3);
    assert!(find(&owner).is_owner && find(&owner).active);
    assert!(!find(&friends[0]).is_owner);
    assert_eq!(find(&friends[0]).remark.as_deref(), Some("老一"));
    assert!(find(&friends[0]).is_friend);
    assert!(
        !find(&friends[1]).active,
        "still listed, but marked as gone"
    );

    // 成员 1 看群主：是好友；看成员 2：不是
    let members = f.chat.members(&friends[0], group).await.unwrap();
    let find = |user: &User| members.iter().find(|m| m.card.id == user.id).unwrap();
    assert!(find(&owner).is_friend);
    assert!(!find(&friends[1]).is_friend);
    assert_eq!(find(&owner).remark, None);
}

#[tokio::test]
async fn leaving_takes_the_group_off_my_list_and_tells_the_others() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    f.group_say(&owner, group, "之前的").await;
    let leaver = &friends[0];

    let posted = f.chat.leave(leaver, group).await.unwrap();
    assert_eq!(posted.message.kind, MessageKind::MemberLeft);
    assert_eq!(posted.message.data.actor.as_ref().unwrap().id, leaver.id);
    // 离开的人自己在别处的登录也要知道
    assert!(posted.members.contains(&leaver.id));
    assert_eq!(posted.members.len(), 3);

    assert!(f.chat.list(leaver).await.unwrap().is_empty());
    assert!(f.chat.groups(leaver).await.unwrap().is_empty());
    assert_eq!(f.info(&owner, group).await.group.unwrap().member_count, 2);
    // 之后的消息他收不到，也发不了
    let later = f.group_say(&owner, group, "之后的").await;
    assert!(!later.members.contains(&leaver.id));
    let err = f
        .chat
        .send_text(leaver, group, "g-x", "还在吗")
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
    let err = f.chat.leave(leaver, group).await.unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
    let err = f.chat.invite(leaver, group, &[owner.id]).await.unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
    // 离开之前的还能看，到"退出"这一条为止
    assert_eq!(
        f.kinds(leaver, group).await,
        [
            MessageKind::GroupCreated,
            MessageKind::Text,
            MessageKind::MemberLeft
        ]
    );
    assert!(f.info(leaver, group).await.group.unwrap().left);
}

#[tokio::test]
async fn the_owner_must_hand_over_or_dissolve_before_leaving() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;

    let err = f.chat.leave(&owner, group).await.unwrap_err();
    assert!(matches!(err, ChatError::OwnerCannotLeave));

    // 转让：只有群主能做，只能给在群的成员
    let stranger = f.user("路人").await;
    let err = f
        .chat
        .transfer(&friends[0], group, friends[1].id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotOwner));
    let err = f
        .chat
        .transfer(&owner, group, stranger.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));
    let err = f.chat.transfer(&owner, group, owner.id).await.unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));

    let posted = f.chat.transfer(&owner, group, friends[0].id).await.unwrap();
    assert_eq!(posted.message.kind, MessageKind::OwnerChanged);
    assert_eq!(posted.message.data.targets[0].id, friends[0].id);
    assert_eq!(
        f.info(&owner, group).await.conversation.owner,
        Some(friends[0].id)
    );

    // 交出去之后：原来的群主可以退了，也不再能做群主的事
    let err = f.chat.rename(&owner, group, "新名字").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    assert!(f.chat.leave(&owner, group).await.is_ok());
    assert!(f.chat.rename(&friends[0], group, "新名字").await.is_ok());
}

#[tokio::test]
async fn the_owner_removes_a_member_who_keeps_the_history_up_to_that_point() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    let removed = &friends[0];
    f.group_say(removed, group, "我还在").await;

    // 普通成员不能移人；不能移自己；不在群里的移不了
    let err = f
        .chat
        .remove_member(&friends[1], group, removed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let err = f
        .chat
        .remove_member(&owner, group, owner.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
    let err = f
        .chat
        .remove_member(&owner, group, UserId::new())
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));

    let posted = f
        .chat
        .remove_member(&owner, group, removed.id)
        .await
        .unwrap();
    assert_eq!(posted.message.kind, MessageKind::MemberRemoved);
    assert_eq!(posted.message.data.targets[0].id, removed.id);
    assert_eq!(posted.message.data.targets[0].nickname, "成员1");
    // 被移出的人也收到这一条
    assert!(posted.members.contains(&removed.id));
    f.group_say(&owner, group, "他走了之后").await;

    // 被移出的人：会话还在列表里，最后一条就是"被移出"，之后的看不到，也发不了
    let listed = f.chat.list(removed).await.unwrap();
    assert_eq!(listed.len(), 1, "the group is still listed");
    assert_eq!(listed[0].conversation.id, group);
    let info = f.info(removed, group).await;
    assert!(info.group.as_ref().unwrap().left);
    assert_eq!(info.last_message.unwrap().kind, MessageKind::MemberRemoved);
    assert_eq!(info.last_seq, 3);
    assert_eq!(
        f.kinds(removed, group).await,
        [
            MessageKind::GroupCreated,
            MessageKind::Text,
            MessageKind::MemberRemoved
        ]
    );
    let err = f
        .chat
        .send_text(removed, group, "g-x", "为什么")
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
    let err = f
        .chat
        .remove_member(&owner, group, removed.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));
}

#[tokio::test]
async fn someone_brought_back_sees_only_what_came_after_coming_back() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    let returning = &friends[0];
    f.group_say(returning, group, "第一次在群里时说的").await;
    f.chat
        .remove_member(&owner, group, returning.id)
        .await
        .unwrap();
    f.group_say(&owner, group, "他不在的时候").await;

    f.chat.invite(&owner, group, &[returning.id]).await.unwrap();
    f.group_say(&owner, group, "欢迎回来").await;

    // 和新成员一样：以前在群里时的、不在时的都看不到
    assert_eq!(f.texts_in(returning, group).await, ["", "欢迎回来"]);
    let info = f.info(returning, group).await;
    assert!(!info.group.as_ref().unwrap().left);
    assert_eq!(info.unread, 1);
    assert!(
        f.chat
            .send_text(returning, group, "g-back", "我回来了")
            .await
            .is_ok()
    );
    // 成员名单里还是一个人，不是两个
    let members = f.chat.members(&owner, group).await.unwrap();
    assert_eq!(
        members.iter().filter(|m| m.card.id == returning.id).count(),
        1
    );
}

#[tokio::test]
async fn an_ordinary_member_cannot_change_the_name_or_the_avatar() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;

    let err = f.chat.rename(&friends[0], group, "不行").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let err = f
        .chat
        .require_manager(&friends[0], group)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let avatar = FileId::new();
    let err = f
        .chat
        .set_group_avatar(&friends[0], group, avatar)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));

    let renamed = f.chat.rename(&owner, group, " 周末爬山 ").await.unwrap();
    assert_eq!(renamed.message.kind, MessageKind::Renamed);
    assert_eq!(renamed.message.data.name.as_deref(), Some("周末爬山"));
    assert_eq!(renamed.members.len(), 3);
    assert_eq!(
        f.info(&friends[1], group)
            .await
            .conversation
            .name
            .as_deref(),
        Some("周末爬山")
    );
    // 留空就是去掉名字
    let cleared = f.chat.rename(&owner, group, "").await.unwrap();
    assert_eq!(cleared.message.data.name, None);
    assert_eq!(f.info(&owner, group).await.conversation.name, None);
    let err = f
        .chat
        .rename(&owner, group, &"群".repeat(GROUP_NAME_MAX_CHARS + 1))
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupNameTooLong));

    assert!(f.chat.require_manager(&owner, group).await.is_ok());
    let changed = f
        .chat
        .set_group_avatar(&owner, group, avatar)
        .await
        .unwrap();
    assert_eq!(changed.message.kind, MessageKind::AvatarChanged);
    assert_eq!(
        f.info(&friends[0], group).await.conversation.avatar,
        Some(avatar)
    );
}

#[tokio::test]
async fn a_dissolved_group_keeps_its_history_but_accepts_nothing_more() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(3).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    f.group_say(&friends[0], group, "最后一句").await;

    let err = f.chat.dissolve(&friends[0], group).await.unwrap_err();
    assert!(matches!(err, ChatError::NotOwner));
    let posted = f.chat.dissolve(&owner, group).await.unwrap();
    assert_eq!(posted.message.kind, MessageKind::Dissolved);
    assert_eq!(posted.members.len(), 3);

    for me in [&owner, &friends[0], &friends[1]] {
        let info = f.info(me, group).await;
        assert!(info.conversation.dissolved);
        assert_eq!(info.last_message.unwrap().kind, MessageKind::Dissolved);
        assert_eq!(f.texts_in(me, group).await, ["", "最后一句", ""]);
        let err = f
            .chat
            .send_text(me, group, "g-late", "还能说话吗")
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::GroupDissolved));
    }
    // 群主的那些操作也都不能做了
    let id = friends[2].id;
    assert!(matches!(
        f.chat.invite(&owner, group, &[id]).await.unwrap_err(),
        ChatError::GroupDissolved
    ));
    assert!(matches!(
        f.chat.rename(&owner, group, "x").await.unwrap_err(),
        ChatError::GroupDissolved
    ));
    assert!(matches!(
        f.chat.dissolve(&owner, group).await.unwrap_err(),
        ChatError::GroupDissolved
    ));
    // 解散之后群主可以把它从自己这里拿掉
    assert!(f.chat.leave(&owner, group).await.is_ok());
}

#[tokio::test]
async fn mentions_mark_the_conversation_until_the_mentioned_one_reads_it() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    let (speaker, target) = (&friends[0], &friends[1]);
    let mention = |from: &User, client_id: &'static str, mentions: Vec<UserId>, all: bool| {
        let (chat, from) = (&f.chat, from.clone());
        async move {
            let draft = Draft {
                mentions: &mentions,
                mention_all: all,
                ..Draft::text(client_id, "看一下")
            };
            chat.send(&from, group, draft).await
        }
    };

    // 自己 @ 自己不算，重复的只算一次
    let posted = mention(
        speaker,
        "m-1",
        vec![target.id, speaker.id, target.id],
        false,
    )
    .await
    .unwrap();
    assert_eq!(posted.message.data.mentions, [target.id]);
    assert!(f.info(target, group).await.group.unwrap().mentioned);
    assert!(!f.info(&owner, group).await.group.unwrap().mentioned);
    assert!(!f.info(speaker, group).await.group.unwrap().mentioned);

    // 看过那条消息之后提示消失
    f.chat
        .mark_read(target, group, posted.message.seq)
        .await
        .unwrap();
    assert!(!f.info(target, group).await.group.unwrap().mentioned);

    // 普通成员不能 @ 所有人；@ 的必须是在群的人
    let err = mention(speaker, "m-2", vec![], true).await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let stranger = f.user("路人").await;
    let err = mention(speaker, "m-3", vec![stranger.id], false)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));

    let all = mention(&owner, "m-4", vec![], true).await.unwrap();
    assert!(all.message.data.mention_all);
    for me in [speaker, target] {
        assert!(f.info(me, group).await.group.unwrap().mentioned);
    }
    assert!(
        !f.info(&owner, group).await.group.unwrap().mentioned,
        "not the sender"
    );
}

#[tokio::test]
async fn each_member_has_a_read_position_the_sender_can_see() {
    let f = fixture().await;
    let (owner, friends) = f.owner_with_friends(2).await;
    let group = f.group(&owner, &[&friends[0], &friends[1]]).await;
    let sent = f.group_say(&owner, group, "看到请回复").await.message.seq;

    let read_by = |members: Vec<super::MemberInfo>| {
        members
            .into_iter()
            .filter(|m| m.card.id != owner.id && m.read_seq >= sent)
            .count()
    };
    assert_eq!(read_by(f.chat.members(&owner, group).await.unwrap()), 0);

    let update = f.chat.mark_read(&friends[0], group, sent).await.unwrap();
    assert!(update.changed);
    assert_eq!(update.members.len(), 3, "everyone in the group is told");
    assert_eq!(read_by(f.chat.members(&owner, group).await.unwrap()), 1);
    f.chat.mark_read(&friends[1], group, sent).await.unwrap();
    assert_eq!(read_by(f.chat.members(&owner, group).await.unwrap()), 2);
}

#[tokio::test]
async fn group_operations_do_not_apply_to_a_direct_conversation() {
    let f = fixture().await;
    let (a, b, direct) = f.friends().await;

    let id = direct.id;
    assert!(matches!(
        f.chat.members(&a, id).await.unwrap_err(),
        ChatError::ConversationNotFound
    ));
    assert!(matches!(
        f.chat.leave(&a, id).await.unwrap_err(),
        ChatError::ConversationNotFound
    ));
    assert!(matches!(
        f.chat.invite(&a, id, &[b.id]).await.unwrap_err(),
        ChatError::ConversationNotFound
    ));
    assert!(matches!(
        f.chat.dissolve(&a, id).await.unwrap_err(),
        ChatError::ConversationNotFound
    ));
    // 单聊里 @ 没有意义，直接忽略
    let draft = Draft {
        mentions: &[b.id],
        mention_all: true,
        ..Draft::text("d-1", "你好")
    };
    let posted = f.chat.send(&a, id, draft).await.unwrap();
    assert!(posted.message.data.is_empty());
    assert_eq!(posted.sender_name, None);
}

// ---------- 通话记录 ----------

/// 一个结束了的通话：`caller` 打给 `callee`，接通过的通了 `talked_ms`。
fn ended_call(
    caller: &User,
    callee: &User,
    conversation: &Conversation,
    outcome: crate::call::CallOutcome,
    talked_ms: Option<i64>,
    now: i64,
) -> crate::call::Call {
    crate::call::Call {
        id: crate::ids::CallId::new(),
        conversation: conversation.id,
        caller: caller.id,
        callee: callee.id,
        caller_device: crate::call::DeviceId::parse("caller-device").unwrap(),
        callee_device: None,
        state: crate::call::CallState::Ended(outcome),
        video: false,
        started_at: now - 60_000,
        answered_at: talked_ms.map(|ms| now - ms),
        ended_at: Some(now),
    }
}

#[tokio::test]
async fn calls_are_only_for_one_to_one_chats_with_a_friend() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    assert_eq!(f.chat.call_peer(&a, conversation.id).await.unwrap(), b.id);
    assert_eq!(f.chat.call_peer(&b, conversation.id).await.unwrap(), a.id);

    let myself = f.chat.open_direct(&a, a.id).await.unwrap().conversation;
    assert!(matches!(
        f.chat.call_peer(&a, myself.id).await,
        Err(ChatError::CallNotAllowed)
    ));

    let c = f.user("小刚").await;
    f.befriend(&a, &c).await;
    let group = f
        .chat
        .create_group(&a, "", &[b.id, c.id])
        .await
        .unwrap()
        .message
        .conversation;
    assert!(matches!(
        f.chat.call_peer(&a, group).await,
        Err(ChatError::CallNotAllowed)
    ));

    // 不是自己的会话
    assert!(matches!(
        f.chat.call_peer(&c, conversation.id).await,
        Err(ChatError::ConversationNotFound)
    ));

    f.contacts.remove_friend(&a, b.id).await.unwrap();
    assert!(matches!(
        f.chat.call_peer(&a, conversation.id).await,
        Err(ChatError::NotFriends)
    ));
}

#[tokio::test]
async fn a_call_record_is_written_by_the_caller_and_counts_as_unread_for_the_callee() {
    use crate::call::CallOutcome;

    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    let now = f.clock.now_ms();
    let call = ended_call(
        &a,
        &b,
        &conversation,
        CallOutcome::Completed,
        Some(192_000),
        now,
    );
    let posted = f.chat.record_call(&call).await.unwrap();

    let record = &posted.message;
    assert_eq!(record.kind, MessageKind::Call);
    assert_eq!(record.sender, Some(a.id));
    assert_eq!(record.text, None);
    assert_eq!(record.data.call, Some(CallOutcome::Completed));
    assert_eq!(record.data.duration_ms, Some(192_000));
    assert_eq!(record.created_at, now);
    assert_eq!(sorted(posted.members.clone()), sorted(vec![a.id, b.id]));

    let unread = |me: User| {
        let chat = &f.chat;
        async move {
            chat.list(&me)
                .await
                .unwrap()
                .into_iter()
                .find(|item| item.conversation.id == conversation.id)
                .unwrap()
                .unread
        }
    };
    assert_eq!(unread(b.clone()).await, 1);
    assert_eq!(unread(a.clone()).await, 0);

    // 没接通的没有时长
    let missed = ended_call(&a, &b, &conversation, CallOutcome::Missed, None, now);
    let posted = f.chat.record_call(&missed).await.unwrap();
    assert_eq!(posted.message.data.call, Some(CallOutcome::Missed));
    assert_eq!(posted.message.data.duration_ms, None);
}

#[tokio::test]
async fn a_call_record_cannot_be_quoted_recalled_or_forwarded() {
    use crate::call::CallOutcome;

    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    let call = ended_call(
        &a,
        &b,
        &conversation,
        CallOutcome::Rejected,
        None,
        f.clock.now_ms(),
    );
    let record = f.chat.record_call(&call).await.unwrap().message;

    let quoting = super::Draft {
        reply_to: Some(record.seq),
        ..super::Draft::text("c-quote", "刚才怎么不接")
    };
    assert!(matches!(
        f.chat.send(&b, conversation.id, quoting).await,
        Err(ChatError::QuoteUnavailable)
    ));
    assert!(matches!(
        f.chat.recall(&a, conversation.id, record.seq).await,
        Err(ChatError::RecallNotAllowed)
    ));
    let forwarding = super::Draft {
        forward: Some(super::Forwarded {
            conversation: conversation.id,
            seq: record.seq,
        }),
        ..super::Draft::text("c-forward", "")
    };
    assert!(matches!(
        f.chat.send(&a, conversation.id, forwarding).await,
        Err(ChatError::ForwardNotAllowed)
    ));
}

#[tokio::test]
async fn only_an_ended_call_can_be_recorded() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    let mut call = ended_call(
        &a,
        &b,
        &conversation,
        crate::call::CallOutcome::Completed,
        Some(1_000),
        f.clock.now_ms(),
    );
    call.state = crate::call::CallState::Active;
    assert!(matches!(
        f.chat.record_call(&call).await,
        Err(ChatError::Invalid(_))
    ));
}

// ---------- 置顶 ----------

#[tokio::test]
async fn pinned_conversations_come_first_and_keep_their_own_order() {
    let f = fixture().await;
    let (a, b, with_b) = f.friends().await;
    let c = f.user("小刚").await;
    let with_c = f.befriend(&a, &c).await;
    let d = f.user("小丽").await;
    let with_d = f.befriend(&a, &d).await;
    // 最新有动静的：d、c、b
    f.clock.advance(1_000);
    f.say(&b, &with_b, "一").await;
    f.clock.advance(1_000);
    f.say(&c, &with_c, "二").await;
    f.clock.advance(1_000);
    f.say(&d, &with_d, "三").await;
    let order = |infos: Vec<super::ConversationInfo>| {
        infos
            .into_iter()
            .map(|info| info.conversation.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        order(f.chat.list(&a).await.unwrap()),
        [with_d.id, with_c.id, with_b.id]
    );

    // 置顶 b 和 c：它们在前，彼此之间照样按最新有动静的先后
    let pinned_at = f.chat.pin(&a, with_b.id, true).await.unwrap();
    assert_eq!(pinned_at, Some(f.clock.now_ms()));
    f.clock.advance(1_000);
    f.chat.pin(&a, with_c.id, true).await.unwrap();
    assert_eq!(
        order(f.chat.list(&a).await.unwrap()),
        [with_c.id, with_b.id, with_d.id]
    );
    f.clock.advance(1_000);
    f.say(&b, &with_b, "四").await;
    assert_eq!(
        order(f.chat.list(&a).await.unwrap()),
        [with_b.id, with_c.id, with_d.id]
    );

    // 再置顶一次：时间不变
    f.clock.advance(1_000);
    assert_eq!(f.chat.pin(&a, with_b.id, true).await.unwrap(), pinned_at);

    // 只影响自己
    let mine = f.chat.list(&b).await.unwrap();
    assert!(mine.iter().all(|info| info.pinned_at.is_none()));

    // 取消：回到原来的位置
    assert_eq!(f.chat.pin(&a, with_b.id, false).await.unwrap(), None);
    assert_eq!(
        order(f.chat.list(&a).await.unwrap()),
        [with_c.id, with_b.id, with_d.id]
    );

    // 不是自己的会话
    assert!(matches!(
        f.chat.pin(&d, with_b.id, true).await,
        Err(ChatError::ConversationNotFound)
    ));
}

// ---------- 删除和清空，只对自己（F6） ----------

#[tokio::test]
async fn deleted_messages_are_gone_for_me_only_and_everywhere_for_me() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    f.say(&a, &conversation, "早").await;
    let secret = f.say(&b, &conversation, "那个口令是 7788").await;
    let last = f.say(&b, &conversation, "收到没").await;
    let all = || HistoryQuery::default();
    let had = f.texts(&a, &conversation, all()).await;

    let deleted = f
        .chat
        .delete_for_me(&a, conversation.id, &[last, secret, secret])
        .await
        .unwrap();
    assert_eq!(deleted, vec![secret, last]);

    // 我这边：消息流、搜索、会话列表的摘要都没有了，未读也不算
    let mine = f.texts(&a, &conversation, all()).await;
    assert_eq!(mine, had[..had.len() - 2].to_vec());
    let found = f.chat.search(&a, "口令", None, None, None).await.unwrap();
    assert!(found.hits.is_empty());
    let listed = f.chat.list(&a).await.unwrap();
    let info = listed
        .iter()
        .find(|i| i.conversation.id == conversation.id)
        .unwrap();
    assert_eq!(
        info.last_message.as_ref().map(|m| m.text.clone().unwrap()),
        Some("早".to_owned())
    );
    assert_eq!(info.unread, 0);

    // 对方、管理员照常看得到
    assert_eq!(f.texts(&b, &conversation, all()).await, had);
    let seen = f
        .chat
        .oversee_history(conversation.id, HistoryQuery::default())
        .await
        .unwrap();
    assert!(seen.messages.iter().any(|m| m.seq == secret));
}

#[tokio::test]
async fn only_what_i_can_see_can_be_deleted() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    let seq = f.say(&b, &conversation, "一").await;
    for wrong in [vec![], vec![seq + 5], vec![0]] {
        assert!(
            f.chat
                .delete_for_me(&a, conversation.id, &wrong)
                .await
                .is_err()
        );
    }
    let too_many: Vec<i64> = (1..=101).collect();
    assert!(matches!(
        f.chat.delete_for_me(&a, conversation.id, &too_many).await,
        Err(ChatError::Invalid(_))
    ));
    let stranger = f.user("路人").await;
    assert!(matches!(
        f.chat
            .delete_for_me(&stranger, conversation.id, &[seq])
            .await,
        Err(ChatError::ConversationNotFound)
    ));
}

#[tokio::test]
async fn clearing_empties_the_chat_for_me_but_keeps_it_listed() {
    let f = fixture().await;
    let (a, b, conversation) = f.friends().await;
    f.say(&b, &conversation, "一").await;
    f.say(&b, &conversation, "二").await;
    let all = || HistoryQuery::default();

    let cleared = f.chat.clear_for_me(&a, conversation.id).await.unwrap();
    assert_eq!(cleared.seq, conversation.last_seq + 2);
    // 清空的算读过
    assert!(cleared.read.changed);
    assert_eq!(cleared.read.read_seq, cleared.seq);

    assert!(f.texts(&a, &conversation, all()).await.is_empty());
    let info = f
        .chat
        .list(&a)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.conversation.id == conversation.id)
        .expect("still listed");
    assert_eq!((info.last_message, info.unread), (None, 0));
    assert!(
        f.chat
            .search(&a, "一", None, None, None)
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    // 对方不受影响
    assert_eq!(
        f.texts(&b, &conversation, all()).await.len() as i64,
        cleared.seq
    );

    // 之后的消息照常
    f.say(&b, &conversation, "三").await;
    assert_eq!(
        f.texts(&a, &conversation, all()).await,
        vec!["三".to_owned()]
    );
}
