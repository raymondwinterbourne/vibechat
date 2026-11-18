//! 会话、成员和消息的数据操作，在 SQLite 和 Postgres 上各跑一遍。

mod common;

use std::sync::atomic::{AtomicU64, Ordering};

use vibechat_core::account::model::{
    FilePurpose, InviteCode, InviteCodeStatus, Role, StoredFile, User, UserStatus,
};
use vibechat_core::call::CallOutcome;
use vibechat_core::chat::model::{
    Change, Changed, Conversation, ConversationKind, Edit, JoinRequest, JoinRequestStatus, Member,
    Message, MessageData, MessageKind, NewGroup, NewMessage, Party, Record, RecordItem,
    SearchScope, Visible,
};
use vibechat_core::{
    ConversationId, FileId, InviteCodeId, JoinRequestId, MessageId, Stores, UserId,
};

const NOW: i64 = 1_700_000_000_000;
/// 什么都能看到：从头到最新。
const ALL: Visible = Visible::EVERYTHING;

/// 注册一个用户。成员和消息都有指向用户表的外键，用户必须真的存在。
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

/// 两个用户和他们的单聊会话。
async fn pair(stores: &Stores) -> (User, User, Conversation) {
    let (a, b) = (user(stores, "user_a").await, user(stores, "user_b").await);
    let conversation = stores
        .chat
        .open_direct(ConversationId::new(), a.id, b.id, NOW)
        .await
        .unwrap();
    (a, b, conversation)
}

fn text(conversation: &Conversation, sender: &User, client_id: &str, text: &str) -> NewMessage {
    NewMessage {
        id: MessageId::new(),
        conversation: conversation.id,
        sender: Some(sender.id),
        client_id: Some(client_id.to_owned()),
        kind: MessageKind::Text,
        text: Some(text.to_owned()),
        data: MessageData::default(),
        file: None,
        reply_to: None,
        created_at: NOW,
    }
}

/// 一条事件。
fn event(conversation: ConversationId, kind: MessageKind, data: MessageData) -> NewMessage {
    NewMessage {
        id: MessageId::new(),
        conversation,
        sender: None,
        client_id: None,
        kind,
        text: None,
        data,
        file: None,
        reply_to: None,
        created_at: NOW,
    }
}

/// 写入一条文本消息，客户端消息编号每次都不同。
async fn say(stores: &Stores, conversation: &Conversation, sender: &User, body: &str) -> Message {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let client_id = format!("c-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let appended = stores
        .chat
        .append(&text(conversation, sender, &client_id, body))
        .await
        .unwrap();
    assert!(!appended.duplicate);
    appended.message
}

async fn last_seq(stores: &Stores, conversation: &Conversation) -> i64 {
    stores
        .chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap()
        .last_seq
}

async fn two_users_have_one_direct_conversation(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let c = user(&stores, "user_c").await;
    let chat = &stores.chat;
    assert_eq!((conversation.last_seq, conversation.created_at), (0, NOW));

    // 再打开：由哪一方发起都是原来那一个，新给的编号没有被用上
    for (x, y) in [(&a, &b), (&b, &a)] {
        let again = chat
            .open_direct(ConversationId::new(), x.id, y.id, NOW + 5)
            .await
            .unwrap();
        assert_eq!(again, conversation);
    }
    assert_eq!(
        chat.find_conversation(conversation.id).await.unwrap(),
        Some(conversation.clone())
    );
    assert_eq!(
        chat.find_conversation(ConversationId::new()).await.unwrap(),
        None
    );

    let mut members = chat.list_members(conversation.id).await.unwrap();
    members.sort_by_key(|m| m.user);
    let mut expected: Vec<Member> = [&a, &b]
        .iter()
        .map(|user| Member {
            conversation: conversation.id,
            user: user.id,
            joined_seq: 0,
            left_seq: None,
            read_seq: 0,
            mentioned_seq: 0,
            hidden_seq: None,
            muted: false,
            notice_seen_seq: 0,
            since: NOW,
            admin: false,
            nickname: None,
            muted_until: None,
            pinned_at: None,
            cleared_seq: 0,
        })
        .collect();
    expected.sort_by_key(|m| m.user);
    assert_eq!(members, expected);
    assert!(
        chat.find_member(conversation.id, a.id)
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(chat.find_member(conversation.id, c.id).await.unwrap(), None);

    // 和另一个人的是另一个会话
    let other = chat
        .open_direct(ConversationId::new(), a.id, c.id, NOW)
        .await
        .unwrap();
    assert_ne!(other.id, conversation.id);
}

async fn when_a_conversation_is_opened_many_times_at_once_there_is_still_one(stores: Stores) {
    let (a, b) = (user(&stores, "user_a").await, user(&stores, "user_b").await);

    let attempts: Vec<_> = (0..8)
        .map(|i| {
            let stores = stores.clone();
            // 一半由 a 发起，一半由 b 发起
            let (x, y) = if i % 2 == 0 {
                (a.id, b.id)
            } else {
                (b.id, a.id)
            };
            tokio::spawn(async move {
                stores
                    .chat
                    .open_direct(ConversationId::new(), x, y, NOW)
                    .await
            })
        })
        .collect();
    let mut ids = Vec::new();
    for attempt in attempts {
        ids.push(attempt.await.unwrap().unwrap().id);
    }
    ids.dedup();
    assert_eq!(ids.len(), 1, "everyone got the same conversation");
    assert_eq!(stores.chat.list_members(ids[0]).await.unwrap().len(), 2);
}

async fn messages_get_consecutive_sequence_numbers(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;

    let first = say(&stores, &conversation, &a, "一").await;
    let second = say(&stores, &conversation, &b, "二").await;
    assert_eq!((first.seq, second.seq), (1, 2));
    assert_eq!(first.text.as_deref(), Some("一"));
    assert_eq!(first.sender, Some(a.id));
    assert_eq!(last_seq(&stores, &conversation).await, 2);

    // 事件：没有发送人，没有客户端消息编号，可以有很多条
    for expected in [3, 4] {
        let event = stores
            .chat
            .append(&NewMessage {
                id: MessageId::new(),
                conversation: conversation.id,
                sender: None,
                client_id: None,
                kind: MessageKind::Friends,
                text: None,
                data: MessageData::default(),
                file: None,
                reply_to: None,
                created_at: NOW,
            })
            .await
            .unwrap();
        assert!(!event.duplicate);
        assert_eq!(event.message.seq, expected);
        assert_eq!(event.message.kind, MessageKind::Friends);
    }

    // 写进不存在的会话是错误，而不是悄悄丢掉
    let nowhere = Conversation {
        id: ConversationId::new(),
        ..conversation.clone()
    };
    assert!(
        stores
            .chat
            .append(&text(&nowhere, &a, "c-x", "x"))
            .await
            .is_err()
    );
}

async fn when_many_write_at_once_every_sequence_number_is_used_exactly_once(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;

    const WRITERS: i64 = 20;
    let attempts: Vec<_> = (0..WRITERS)
        .map(|i| {
            let stores = stores.clone();
            let sender = if i % 2 == 0 { &a } else { &b };
            let message = text(&conversation, sender, &format!("c-{i}"), &i.to_string());
            tokio::spawn(async move { stores.chat.append(&message).await })
        })
        .collect();
    let mut seqs = Vec::new();
    for attempt in attempts {
        let appended = attempt.await.unwrap().unwrap();
        assert!(!appended.duplicate);
        seqs.push(appended.message.seq);
    }
    seqs.sort();
    assert_eq!(seqs, (1..=WRITERS).collect::<Vec<_>>());
    assert_eq!(last_seq(&stores, &conversation).await, WRITERS);

    // 读出来的顺序就是序号的顺序
    let stored = stores
        .chat
        .list_after(conversation.id, ALL, 0, 100)
        .await
        .unwrap();
    let stored: Vec<i64> = stored.iter().map(|m| m.seq).collect();
    assert_eq!(stored, seqs);
}

async fn the_same_client_id_is_written_only_once(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let chat = &stores.chat;

    let first = chat
        .append(&text(&conversation, &a, "c-1", "你好"))
        .await
        .unwrap();
    assert!(!first.duplicate);

    // 重发：内容即使不同，也以第一次为准，序号不再增加
    let again = chat
        .append(&text(&conversation, &a, "c-1", "你好（重发）"))
        .await
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.message, first.message);
    assert_eq!(last_seq(&stores, &conversation).await, 1);

    // 另一个人用了同一个编号：是另一条消息
    let theirs = chat
        .append(&text(&conversation, &b, "c-1", "我也好"))
        .await
        .unwrap();
    assert!(!theirs.duplicate);
    assert_eq!(theirs.message.seq, 2);
}

async fn when_one_message_is_sent_many_times_at_once_it_is_written_once(stores: Stores) {
    let (a, _b, conversation) = pair(&stores).await;

    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let stores = stores.clone();
            let message = text(&conversation, &a, "c-same", "只有一条");
            tokio::spawn(async move { stores.chat.append(&message).await })
        })
        .collect();
    let mut written = 0;
    let mut ids = Vec::new();
    for attempt in attempts {
        let appended = attempt.await.unwrap().unwrap();
        if !appended.duplicate {
            written += 1;
        }
        ids.push(appended.message.id);
    }
    assert_eq!(written, 1, "exactly one attempt wrote the message");
    ids.dedup();
    assert_eq!(
        ids.len(),
        1,
        "every attempt was told about the same message"
    );
    // 没有因为失败的尝试留下空缺
    assert_eq!(last_seq(&stores, &conversation).await, 1);
    assert_eq!(
        stores
            .chat
            .list_after(conversation.id, ALL, 0, 100)
            .await
            .unwrap()
            .len(),
        1
    );
}

async fn messages_are_read_in_slices_by_sequence_number(stores: Stores) {
    let (a, _b, conversation) = pair(&stores).await;
    let (_c, _d, other) = {
        let (c, d) = (user(&stores, "user_c").await, user(&stores, "user_d").await);
        let other = stores
            .chat
            .open_direct(ConversationId::new(), c.id, d.id, NOW)
            .await
            .unwrap();
        say(&stores, &other, &c, "别的会话").await;
        (c, d, other)
    };
    for n in 1..=6 {
        say(&stores, &conversation, &a, &n.to_string()).await;
    }
    let chat = &stores.chat;
    let seqs = |messages: Vec<Message>| messages.iter().map(|m| m.seq).collect::<Vec<_>>();
    let id = conversation.id;

    // 向上翻：最新的几条，按序号从小到大
    assert_eq!(
        seqs(chat.list_before(id, ALL, None, 3).await.unwrap()),
        [4, 5, 6]
    );
    assert_eq!(
        seqs(chat.list_before(id, ALL, Some(4), 2).await.unwrap()),
        [2, 3]
    );
    assert_eq!(
        seqs(chat.list_before(id, ALL, Some(2), 5).await.unwrap()),
        [1]
    );
    assert!(
        chat.list_before(id, ALL, Some(1), 5)
            .await
            .unwrap()
            .is_empty()
    );
    // 补齐：某个序号之后最早的几条
    assert_eq!(seqs(chat.list_after(id, ALL, 0, 2).await.unwrap()), [1, 2]);
    assert_eq!(seqs(chat.list_after(id, ALL, 4, 5).await.unwrap()), [5, 6]);
    assert!(chat.list_after(id, ALL, 6, 5).await.unwrap().is_empty());

    // 别的会话的消息不会混进来
    let theirs = chat.list_before(other.id, ALL, None, 10).await.unwrap();
    assert_eq!(theirs.len(), 1);
    assert_eq!(theirs[0].text.as_deref(), Some("别的会话"));
}

async fn the_read_position_only_moves_forward(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let chat = &stores.chat;
    let read = |user: &User| {
        let user = user.id;
        async move {
            chat.find_member(conversation.id, user)
                .await
                .unwrap()
                .unwrap()
                .read_seq
        }
    };

    assert!(chat.advance_read(conversation.id, a.id, 3).await.unwrap());
    assert_eq!(read(&a).await, 3);
    assert_eq!(read(&b).await, 0, "only that member moves");

    assert!(!chat.advance_read(conversation.id, a.id, 3).await.unwrap());
    assert!(!chat.advance_read(conversation.id, a.id, 1).await.unwrap());
    assert_eq!(read(&a).await, 3);
    assert!(chat.advance_read(conversation.id, a.id, 5).await.unwrap());
    assert_eq!(read(&a).await, 5);

    // 不是成员：什么也不改
    let c = user(&stores, "user_c").await;
    assert!(!chat.advance_read(conversation.id, c.id, 9).await.unwrap());
}

async fn the_list_holds_what_a_user_should_see(stores: Stores) {
    let (a, b, with_b) = pair(&stores).await;
    let c = user(&stores, "user_c").await;
    let chat = &stores.chat;
    let with_c = chat
        .open_direct(ConversationId::new(), a.id, c.id, NOW)
        .await
        .unwrap();
    // 没有内容的会话不在列表里
    assert!(chat.list_for_user(a.id).await.unwrap().is_empty());

    say(&stores, &with_b, &b, "一").await;
    say(&stores, &with_b, &a, "二").await;
    let third = say(&stores, &with_b, &b, "三").await;
    let listing = |user: &User, conversation: &Conversation| {
        let (user, id) = (user.id, conversation.id);
        async move {
            chat.list_for_user(user)
                .await
                .unwrap()
                .into_iter()
                .find(|listing| listing.conversation.id == id)
        }
    };

    let mine = listing(&a, &with_b).await.unwrap();
    assert_eq!(mine.conversation.last_seq, 3);
    assert_eq!(mine.me.user, a.id);
    assert_eq!(mine.others.len(), 1);
    assert_eq!(mine.others[0].user, b.id);
    assert_eq!(mine.last_message, Some(third));
    assert_eq!(mine.unread, 2, "only what the other one sent");
    assert_eq!(listing(&b, &with_b).await.unwrap().unread, 1);
    assert!(listing(&a, &with_c).await.is_none(), "still empty");
    assert!(chat.list_for_user(c.id).await.unwrap().is_empty());

    // 看到第 1 条：还剩对方发的第 3 条。对方的已读位置在我的列表里看得到
    chat.advance_read(with_b.id, a.id, 1).await.unwrap();
    assert_eq!(listing(&a, &with_b).await.unwrap().unread, 1);
    assert_eq!(listing(&b, &with_b).await.unwrap().others[0].read_seq, 1);
    chat.advance_read(with_b.id, a.id, 3).await.unwrap();
    assert_eq!(listing(&a, &with_b).await.unwrap().unread, 0);

    // 事件没有发送人，不算未读
    chat.append(&NewMessage {
        id: MessageId::new(),
        conversation: with_b.id,
        sender: None,
        client_id: None,
        kind: MessageKind::Friends,
        text: None,
        data: MessageData::default(),
        file: None,
        reply_to: None,
        created_at: NOW,
    })
    .await
    .unwrap();
    let mine = listing(&a, &with_b).await.unwrap();
    assert_eq!((mine.conversation.last_seq, mine.unread), (4, 0));
    assert_eq!(mine.last_message.unwrap().kind, MessageKind::Friends);

    // 从列表移除：只影响自己这一边；有了新内容就重新出现
    chat.hide(with_b.id, a.id, 4).await.unwrap();
    assert!(listing(&a, &with_b).await.is_none());
    assert!(listing(&b, &with_b).await.is_some());
    say(&stores, &with_b, &b, "五").await;
    let back = listing(&a, &with_b).await.unwrap();
    assert_eq!((back.unread, back.me.hidden_seq), (1, Some(4)));

    // 另一个会话有了内容之后也在列表里
    say(&stores, &with_c, &c, "在吗").await;
    assert_eq!(chat.list_for_user(a.id).await.unwrap().len(), 2);
}

// ---------- 群 ----------

fn party(user: &User) -> Party {
    Party {
        id: user.id,
        nickname: user.nickname.clone(),
    }
}

/// 一个群主和三个成员的群，以及一个还不在群里的人。
async fn group(stores: &Stores) -> (Conversation, User, Vec<User>, User) {
    let owner = user(stores, "owner").await;
    let mut members = Vec::new();
    for handle in ["member_1", "member_2", "member_3"] {
        members.push(user(stores, handle).await);
    }
    let outsider = user(stores, "outsider").await;
    let id = ConversationId::new();
    let mut everyone = vec![owner.id];
    everyone.extend(members.iter().map(|member| member.id));
    let created = event(
        id,
        MessageKind::GroupCreated,
        MessageData {
            actor: Some(party(&owner)),
            targets: members.iter().map(party).collect(),
            ..MessageData::default()
        },
    );
    let (conversation, _) = stores
        .chat
        .create_group(&NewGroup {
            id,
            name: Some("项目组".to_owned()),
            owner: owner.id,
            members: everyone,
            event: created,
        })
        .await
        .unwrap();
    (conversation, owner, members, outsider)
}

async fn member(stores: &Stores, conversation: &Conversation, user: &User) -> Member {
    stores
        .chat
        .find_member(conversation.id, user.id)
        .await
        .unwrap()
        .unwrap()
}

async fn active_count(stores: &Stores, conversation: &Conversation) -> usize {
    let members = stores.chat.list_members(conversation.id).await.unwrap();
    members.iter().filter(|member| member.is_active()).count()
}

fn done(changed: Changed) -> Message {
    match changed {
        Changed::Done(message) => *message,
        other => panic!("expected the change to be applied, got {other:?}"),
    }
}

async fn a_group_is_created_with_its_members_and_first_event(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;

    assert_eq!(conversation.kind, ConversationKind::Group);
    assert_eq!(conversation.name.as_deref(), Some("项目组"));
    assert_eq!(conversation.owner, Some(owner.id));
    assert_eq!((conversation.last_seq, conversation.dissolved), (1, false));
    assert_eq!(
        chat.find_conversation(conversation.id).await.unwrap(),
        Some(conversation.clone())
    );

    let listed = chat.list_members(conversation.id).await.unwrap();
    assert_eq!(listed.len(), 4);
    assert!(listed.iter().all(|m| m.is_active() && m.joined_seq == 0));
    assert_eq!(
        chat.find_member(conversation.id, outsider.id)
            .await
            .unwrap(),
        None
    );

    // "建群"是第 1 条；谁做的、拉了谁，连同当时的昵称都存下来了
    let log = chat.list_after(conversation.id, ALL, 0, 10).await.unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(
        (log[0].kind, log[0].seq, log[0].sender),
        (MessageKind::GroupCreated, 1, None)
    );
    assert_eq!(log[0].data.actor, Some(party(&owner)));
    assert_eq!(
        log[0].data.targets,
        members.iter().map(party).collect::<Vec<_>>()
    );

    // 四个人的列表里都有它；不在群里的人没有
    for user in std::iter::once(&owner).chain(&members) {
        let listings = chat.list_for_user(user.id).await.unwrap();
        assert_eq!(listings.len(), 1);
        assert_eq!(listings[0].others.len(), 3);
        assert_eq!(listings[0].unread, 0);
        assert_eq!(
            chat.list_groups(user.id).await.unwrap(),
            vec![conversation.clone()]
        );
    }
    assert!(chat.list_for_user(outsider.id).await.unwrap().is_empty());
    assert!(chat.list_groups(outsider.id).await.unwrap().is_empty());
}

async fn joining_respects_the_limit_and_starts_a_new_visible_range(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    say(&stores, &conversation, &owner, "入群之前的").await;
    let join = |users: Vec<UserId>, limit: u32| {
        let joined = event(
            conversation.id,
            MessageKind::MemberJoined,
            MessageData::default(),
        );
        async move {
            chat.apply(&joined, &Change::Join { users, limit })
                .await
                .unwrap()
        }
    };

    // 已经四个人，上限四个：加不进来，什么也没变
    assert_eq!(join(vec![outsider.id], 4).await, Changed::Full { room: 0 });
    assert_eq!(
        last_seq(&stores, &conversation).await,
        2,
        "the sequence number is not used up"
    );
    assert_eq!(
        chat.find_member(conversation.id, outsider.id)
            .await
            .unwrap(),
        None
    );
    // 要加的人都已经在群里
    assert_eq!(join(vec![members[0].id], 10).await, Changed::Nothing);

    let joined = done(join(vec![outsider.id, members[0].id], 5).await);
    assert_eq!((joined.kind, joined.seq), (MessageKind::MemberJoined, 3));
    let newcomer = member(&stores, &conversation, &outsider).await;
    // 入群之前的看不到，也不算未读
    assert_eq!(
        (newcomer.joined_seq, newcomer.read_seq, newcomer.left_seq),
        (2, 2, None)
    );
    assert_eq!(active_count(&stores, &conversation).await, 5);

    let seen = chat
        .list_before(conversation.id, newcomer.visible(), None, 10)
        .await
        .unwrap();
    assert_eq!(seen.iter().map(|m| m.seq).collect::<Vec<_>>(), [3]);
    say(&stores, &conversation, &owner, "欢迎").await;
    let listing = chat.list_for_user(outsider.id).await.unwrap().remove(0);
    assert_eq!((listing.unread, listing.last_message.unwrap().seq), (1, 4));
}

async fn when_many_join_at_once_the_limit_holds(stores: Stores) {
    let (conversation, _owner, _members, outsider) = group(&stores).await;
    let mut candidates = vec![outsider];
    for n in 0..5 {
        candidates.push(user(&stores, &format!("late_{n}")).await);
    }

    // 已经四个人，上限六个：六个人同时想进来，只有两个进得来
    let attempts: Vec<_> = candidates
        .iter()
        .map(|candidate| {
            let stores = stores.clone();
            let joined = event(
                conversation.id,
                MessageKind::MemberJoined,
                MessageData::default(),
            );
            let change = Change::Join {
                users: vec![candidate.id],
                limit: 6,
            };
            tokio::spawn(async move { stores.chat.apply(&joined, &change).await })
        })
        .collect();
    let mut admitted = 0;
    for attempt in attempts {
        match attempt.await.unwrap().unwrap() {
            Changed::Done(_) => admitted += 1,
            Changed::Full { .. } => {}
            Changed::Nothing => panic!("every candidate is new"),
        }
    }
    assert_eq!(admitted, 2);
    assert_eq!(active_count(&stores, &conversation).await, 6);
    // 没进来的人没有用掉序号：建群一条，进来两个人各一条
    assert_eq!(last_seq(&stores, &conversation).await, 3);
}

async fn leaving_closes_the_visible_range(stores: Stores) {
    let (conversation, owner, members, _) = group(&stores).await;
    let chat = &stores.chat;
    let (leaver, removed) = (&members[0], &members[1]);
    say(&stores, &conversation, leaver, "还在的时候").await;
    let leave = |user: UserId, hide: bool, kind: MessageKind| {
        let left = event(conversation.id, kind, MessageData::default());
        async move {
            chat.apply(&left, &Change::Leave { user, hide })
                .await
                .unwrap()
        }
    };

    // 自己退群：同时从自己的列表里移除
    let left = done(leave(leaver.id, true, MessageKind::MemberLeft).await);
    assert_eq!(left.seq, 3);
    let gone = member(&stores, &conversation, leaver).await;
    assert_eq!((gone.left_seq, gone.hidden_seq), (Some(3), Some(3)));
    assert!(chat.list_for_user(leaver.id).await.unwrap().is_empty());
    assert!(chat.list_groups(leaver.id).await.unwrap().is_empty());

    // 被移出：会话留在列表里，最新一条就是"被移出"
    let removal = done(leave(removed.id, false, MessageKind::MemberRemoved).await);
    say(&stores, &conversation, &owner, "他们走了之后").await;
    let listing = chat.list_for_user(removed.id).await.unwrap().remove(0);
    assert_eq!(listing.last_message, Some(removal.clone()));
    assert_eq!(
        listing.unread, 1,
        "what the other one said before, nothing after"
    );
    let out = member(&stores, &conversation, removed).await;
    let seen = chat
        .list_after(conversation.id, out.visible(), 0, 10)
        .await
        .unwrap();
    assert_eq!(seen.iter().map(|m| m.seq).collect::<Vec<_>>(), [1, 2, 3, 4]);

    // 已经不在群里的人再离开一次：什么也没变
    assert_eq!(
        leave(leaver.id, false, MessageKind::MemberRemoved).await,
        Changed::Nothing
    );
    assert_eq!(last_seq(&stores, &conversation).await, 5);
    assert_eq!(active_count(&stores, &conversation).await, 2);
    // 离开的人还在成员名单里
    assert_eq!(chat.list_members(conversation.id).await.unwrap().len(), 4);

    // 再被拉回来：还是那一条记录，只能看到这一次入群之后的
    let back = event(
        conversation.id,
        MessageKind::MemberJoined,
        MessageData::default(),
    );
    let change = Change::Join {
        users: vec![leaver.id],
        limit: 10,
    };
    let rejoined = done(chat.apply(&back, &change).await.unwrap());
    let returned = member(&stores, &conversation, leaver).await;
    assert_eq!(
        (
            returned.joined_seq,
            returned.left_seq,
            returned.hidden_seq,
            returned.since
        ),
        (rejoined.seq - 1, None, None, NOW)
    );
    assert_eq!(chat.list_members(conversation.id).await.unwrap().len(), 4);
    let seen = chat
        .list_before(conversation.id, returned.visible(), None, 10)
        .await
        .unwrap();
    assert_eq!(seen, vec![rejoined]);
}

async fn group_details_change_together_with_their_events(stores: Stores) {
    let (conversation, owner, members, _) = group(&stores).await;
    let chat = &stores.chat;
    let avatar = FileId::new();
    let renamed = MessageData {
        actor: Some(party(&owner)),
        name: Some("周末爬山".to_owned()),
        ..MessageData::default()
    };
    let handed_over = MessageData {
        actor: Some(party(&owner)),
        targets: vec![party(&members[0])],
        ..MessageData::default()
    };
    let steps = [
        (
            MessageKind::Renamed,
            renamed.clone(),
            Change::Rename(renamed.name.clone()),
        ),
        (
            MessageKind::AvatarChanged,
            MessageData::default(),
            Change::SetAvatar(avatar),
        ),
        (
            MessageKind::OwnerChanged,
            handed_over.clone(),
            Change::SetOwner(members[0].id),
        ),
        (
            MessageKind::Dissolved,
            MessageData::default(),
            Change::Dissolve,
        ),
    ];
    for (kind, data, change) in steps {
        let message = done(
            chat.apply(&event(conversation.id, kind, data.clone()), &change)
                .await
                .unwrap(),
        );
        assert_eq!((message.kind, &message.data), (kind, &data));
    }

    let after = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.name.as_deref(), Some("周末爬山"));
    assert_eq!(after.avatar, Some(avatar));
    assert_eq!(after.owner, Some(members[0].id));
    assert!(after.dissolved);
    assert_eq!(after.last_seq, 5);

    // 事件的参数原样读得回来
    let log = chat.list_after(conversation.id, ALL, 1, 10).await.unwrap();
    assert_eq!(log[0].data, renamed);
    assert_eq!(log[2].data, handed_over);
    assert!(log[3].data.is_empty());

    // 去掉群名
    done(
        chat.apply(
            &event(
                conversation.id,
                MessageKind::Renamed,
                MessageData::default(),
            ),
            &Change::Rename(None),
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        chat.find_conversation(conversation.id)
            .await
            .unwrap()
            .unwrap()
            .name,
        None
    );

    // 改一个不存在的群是错误
    let nowhere = event(
        ConversationId::new(),
        MessageKind::Dissolved,
        MessageData::default(),
    );
    assert!(chat.apply(&nowhere, &Change::Dissolve).await.is_err());
}

async fn admins_are_limited_and_lose_the_role_when_leaving_or_taking_over(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    let appoint = |user: &User, admin: bool, limit: u32| {
        let kind = if admin {
            MessageKind::AdminAdded
        } else {
            MessageKind::AdminRemoved
        };
        let data = MessageData {
            actor: Some(party(&owner)),
            targets: vec![party(user)],
            ..MessageData::default()
        };
        let change = Change::SetAdmin {
            user: user.id,
            admin,
            limit,
        };
        async move {
            chat.apply(&event(conversation.id, kind, data), &change)
                .await
        }
    };

    done(appoint(&members[0], true, 2).await.unwrap());
    assert!(member(&stores, &conversation, &members[0]).await.admin);
    // 已经是的、不在群里的：什么也不改，也不用掉序号
    let before = last_seq(&stores, &conversation).await;
    assert_eq!(
        appoint(&members[0], true, 2).await.unwrap(),
        Changed::Nothing
    );
    assert_eq!(appoint(&outsider, true, 2).await.unwrap(), Changed::Nothing);
    assert_eq!(
        appoint(&members[2], false, 2).await.unwrap(),
        Changed::Nothing
    );
    assert_eq!(last_seq(&stores, &conversation).await, before);
    // 到了上限
    done(appoint(&members[1], true, 2).await.unwrap());
    assert_eq!(
        appoint(&members[2], true, 2).await.unwrap(),
        Changed::Full { room: 0 }
    );
    assert!(!member(&stores, &conversation, &members[2]).await.admin);

    // 取消一名
    done(appoint(&members[1], false, 2).await.unwrap());
    assert!(!member(&stores, &conversation, &members[1]).await.admin);

    // 群主转给管理员：他不再是管理员
    let handed_over = MessageData {
        actor: Some(party(&owner)),
        targets: vec![party(&members[0])],
        ..MessageData::default()
    };
    done(
        chat.apply(
            &event(conversation.id, MessageKind::OwnerChanged, handed_over),
            &Change::SetOwner(members[0].id),
        )
        .await
        .unwrap(),
    );
    assert!(!member(&stores, &conversation, &members[0]).await.admin);

    // 管理员离开时不再是
    done(appoint(&members[2], true, 2).await.unwrap());
    let left = MessageData {
        actor: Some(party(&members[2])),
        ..MessageData::default()
    };
    done(
        chat.apply(
            &event(conversation.id, MessageKind::MemberLeft, left),
            &Change::Leave {
                user: members[2].id,
                hide: true,
            },
        )
        .await
        .unwrap(),
    );
    assert!(!member(&stores, &conversation, &members[2]).await.admin);
    let listed = chat.list_members(conversation.id).await.unwrap();
    assert!(listed.iter().all(|member| !member.admin));
}

async fn mutes_are_kept_on_members_and_the_group(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    let muted = MessageData {
        actor: Some(party(&owner)),
        targets: vec![party(&members[0])],
        until: Some(NOW + 600_000),
        ..MessageData::default()
    };
    let message = done(
        chat.apply(
            &event(conversation.id, MessageKind::MemberMuted, muted.clone()),
            &Change::Mute {
                user: members[0].id,
                until: Some(NOW + 600_000),
            },
        )
        .await
        .unwrap(),
    );
    // 事件里的时间原样读得回来
    assert_eq!(one(&stores, &conversation, message.seq).await.data, muted);
    assert_eq!(
        member(&stores, &conversation, &members[0])
            .await
            .muted_until,
        Some(NOW + 600_000)
    );
    // 不在群里的人禁言不了
    let nobody = Change::Mute {
        user: outsider.id,
        until: Some(NOW),
    };
    let ignored = event(
        conversation.id,
        MessageKind::MemberMuted,
        MessageData::default(),
    );
    assert_eq!(
        chat.apply(&ignored, &nobody).await.unwrap(),
        Changed::Nothing
    );
    // 被设为管理员时禁言解除
    let promote = Change::SetAdmin {
        user: members[0].id,
        admin: true,
        limit: 3,
    };
    let promoted = event(
        conversation.id,
        MessageKind::AdminAdded,
        MessageData::default(),
    );
    done(chat.apply(&promoted, &promote).await.unwrap());
    assert_eq!(
        member(&stores, &conversation, &members[0])
            .await
            .muted_until,
        None
    );

    // 全员禁言：开着的再开一次什么也不改
    let all = |muted: bool| {
        let kind = if muted {
            MessageKind::AllMuted
        } else {
            MessageKind::AllUnmuted
        };
        let data = MessageData::default();
        async move {
            chat.apply(
                &event(conversation.id, kind, data),
                &Change::SetAllMuted(muted),
            )
            .await
            .unwrap()
        }
    };
    done(all(true).await);
    let found = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert!(found.all_muted);
    assert_eq!(all(true).await, Changed::Nothing);
    done(all(false).await);
    let found = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!found.all_muted);
}

async fn a_group_nickname_is_set_only_when_it_changes(stores: Stores) {
    let (conversation, _owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    let set = |user: &User, nickname: Option<&str>| {
        let user = user.id;
        let nickname = nickname.map(str::to_owned);
        async move {
            chat.set_nickname(conversation.id, user, nickname)
                .await
                .unwrap()
        }
    };
    assert!(set(&members[0], Some("队长")).await);
    assert_eq!(
        member(&stores, &conversation, &members[0])
            .await
            .nickname
            .as_deref(),
        Some("队长")
    );
    // 一样的不算改；去掉；去掉了再去掉不算改；不在群里的改不了
    assert!(!set(&members[0], Some("队长")).await);
    assert!(set(&members[0], None).await);
    assert!(!set(&members[0], None).await);
    assert!(!set(&outsider, Some("路人")).await);
    assert_eq!(
        member(&stores, &conversation, &members[0]).await.nickname,
        None
    );
}

async fn join_requests_stay_one_pending_per_invitee_and_are_settled_once(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    const DAY: i64 = 24 * 60 * 60 * 1000;
    let request = |created_at: i64| JoinRequest {
        id: JoinRequestId::new(),
        conversation: conversation.id,
        inviter: members[0].id,
        invitee: outsider.id,
        status: JoinRequestStatus::Pending,
        created_at,
        handled_by: None,
        handled_at: None,
    };

    assert!(chat.set_join_approval(conversation.id, true).await.unwrap());
    assert!(!chat.set_join_approval(conversation.id, true).await.unwrap());
    let found = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert!(found.join_approval);

    // 一条待处理的挡着第二条；过期了就不挡
    let old = request(NOW - 8 * DAY);
    assert!(
        chat.add_join_request(&old, NOW - 7 * DAY - 1)
            .await
            .unwrap()
    );
    let blocked = request(NOW - 8 * DAY + 1);
    assert!(
        !chat
            .add_join_request(&blocked, NOW - 9 * DAY)
            .await
            .unwrap()
    );
    let fresh = request(NOW);
    assert!(chat.add_join_request(&fresh, NOW - 7 * DAY).await.unwrap());
    assert_eq!(
        chat.find_join_request(fresh.id).await.unwrap(),
        Some(fresh.clone())
    );
    let listed = chat.list_join_requests(conversation.id).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, fresh.id, "newest first");
    assert_eq!(
        listed[1].status_at(NOW - 7 * DAY),
        JoinRequestStatus::Expired
    );

    // 过期的处理不了；待处理的只能处理一次
    let cutoff = NOW - 7 * DAY;
    let settle = |id, status| chat.settle_join_request(id, status, owner.id, NOW + 1, cutoff);
    assert!(!settle(old.id, JoinRequestStatus::Approved).await.unwrap());
    assert!(settle(fresh.id, JoinRequestStatus::Approved).await.unwrap());
    assert!(!settle(fresh.id, JoinRequestStatus::Rejected).await.unwrap());
    let settled = chat.find_join_request(fresh.id).await.unwrap().unwrap();
    assert_eq!(
        (settled.status, settled.handled_by, settled.handled_at),
        (JoinRequestStatus::Approved, Some(owner.id), Some(NOW + 1))
    );
    // 处理过的不挡着新的；退回待处理
    let next = request(NOW + 2);
    assert!(chat.add_join_request(&next, cutoff).await.unwrap());
    assert!(settle(next.id, JoinRequestStatus::Approved).await.unwrap());
    chat.reopen_join_request(next.id).await.unwrap();
    let reopened = chat.find_join_request(next.id).await.unwrap().unwrap();
    assert_eq!(
        (reopened.status, reopened.handled_by),
        (JoinRequestStatus::Pending, None)
    );
    assert!(
        !chat
            .add_join_request(&request(NOW + 3), cutoff)
            .await
            .unwrap()
    );

    // 经过审批入群的事件：同意的人原样读得回来
    let data = MessageData {
        actor: Some(party(&members[0])),
        targets: vec![party(&outsider)],
        approver: Some(party(&owner)),
        ..MessageData::default()
    };
    let joined = done(
        chat.apply(
            &event(conversation.id, MessageKind::MemberJoined, data.clone()),
            &Change::Join {
                users: vec![outsider.id],
                limit: 10,
            },
        )
        .await
        .unwrap(),
    );
    assert_eq!(one(&stores, &conversation, joined.seq).await.data, data);
}

async fn mentions_are_recorded_for_those_in_the_group(stores: Stores) {
    let (conversation, owner, members, outsider) = group(&stores).await;
    let chat = &stores.chat;
    let mention = |sender: &User, client_id: &str, mentions: Vec<UserId>, mention_all: bool| {
        let mut message = text(&conversation, sender, client_id, "看一下");
        message.data = MessageData {
            mentions,
            mention_all,
            ..MessageData::default()
        };
        async move { chat.append(&message).await.unwrap().message }
    };
    let mentioned = |user: &User| {
        let (stores, conversation, user) = (&stores, &conversation, user.clone());
        async move { member(stores, conversation, &user).await.mentioned_seq }
    };

    // @ 了成员 1，顺带写了发送人自己和一个不在群里的人：只有成员 1 被记下
    let first = mention(
        &members[1],
        "m-1",
        vec![members[0].id, members[1].id, outsider.id],
        false,
    )
    .await;
    assert_eq!(
        first.data.mentions.len(),
        3,
        "the message keeps what was sent"
    );
    assert_eq!(mentioned(&members[0]).await, first.seq);
    assert_eq!(mentioned(&members[1]).await, 0);
    assert_eq!(mentioned(&owner).await, 0);

    // @ 所有人：除了发送人自己
    let all = mention(&owner, "m-2", vec![], true).await;
    assert!(all.data.mention_all);
    for user in &members {
        assert_eq!(mentioned(user).await, all.seq);
    }
    assert_eq!(mentioned(&owner).await, 0);

    // 重发不会把序号再记一遍，读回来的参数和写入的一样
    let again = mention(&owner, "m-2", vec![], true).await;
    assert_eq!(again, all);
    let stored = chat
        .list_after(conversation.id, ALL, first.seq - 1, 10)
        .await
        .unwrap();
    assert_eq!(stored, vec![first, all]);
}

// ---------- 文件、引用、撤回、语音、搜索 ----------

/// 登记一个上传好的消息附件。
async fn upload(stores: &Stores, uploader: &User, name: &str, created_at: i64) -> StoredFile {
    let id = FileId::new();
    let file = StoredFile {
        id,
        storage_key: format!("attachment/{}/{id}", uploader.id),
        content_type: "application/octet-stream".to_owned(),
        size: 42,
        uploader: uploader.id,
        purpose: FilePurpose::Attachment,
        width: None,
        height: None,
        name: Some(name.to_owned()),
        thumbnail_key: None,
        created_at,
    };
    stores.files.create(&file).await.unwrap();
    file
}

/// 一条带文件的消息。
fn attached(
    conversation: &Conversation,
    sender: &User,
    client_id: &str,
    file: FileId,
) -> NewMessage {
    NewMessage {
        kind: MessageKind::File,
        text: None,
        file: Some(file),
        ..text(conversation, sender, client_id, "")
    }
}

async fn one(stores: &Stores, conversation: &Conversation, seq: i64) -> Message {
    let found = stores.chat.find_messages(conversation.id, &[seq]).await;
    found.unwrap().pop().expect("the message exists")
}

async fn a_file_belongs_to_at_most_one_message(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let file = upload(&stores, &a, "报告.pdf", NOW).await;
    let unused = upload(&stores, &a, "old.txt", NOW - 10_000).await;
    assert_eq!(stores.chat.find_by_file(file.id).await.unwrap(), None);

    let mut message = attached(&conversation, &a, "f-1", file.id);
    message.reply_to = Some(7);
    message.data.duration_ms = Some(3200);
    let sent = stores.chat.append(&message).await.unwrap().message;
    assert_eq!((sent.file, sent.reply_to), (Some(file.id), Some(7)));
    // 写进去的和读出来的一样，包括参数里的时长
    assert_eq!(one(&stores, &conversation, sent.seq).await, sent);
    assert_eq!(
        stores.chat.find_by_file(file.id).await.unwrap(),
        Some(sent.clone())
    );

    // 同一个文件不能再附到别的消息上，不管是谁、在哪个会话
    let again = attached(&conversation, &b, "f-2", file.id);
    stores.chat.append(&again).await.unwrap_err();
    assert_eq!(
        last_seq(&stores, &conversation).await,
        1,
        "no sequence number was used"
    );
    // 重发（同一个客户端消息编号）交还原来那一条
    let resent = stores.chat.append(&message).await.unwrap();
    assert!(resent.duplicate);
    assert_eq!(resent.message, sent);

    // 没有被任何消息引用的旧文件
    let orphans = stores.files.list_orphans(NOW - 5_000).await.unwrap();
    assert_eq!(orphans, std::slice::from_ref(&unused));
    let orphans = stores.files.list_orphans(NOW + 5_000).await.unwrap();
    assert_eq!(
        orphans,
        std::slice::from_ref(&unused),
        "an attached file is never an orphan"
    );
    let mut both = stores
        .files
        .find_many(&[file.id, unused.id, FileId::new()])
        .await;
    both.as_mut().unwrap().sort_by_key(|file| file.created_at);
    assert_eq!(both.unwrap(), [unused.clone(), file]);
    stores.files.delete(unused.id).await.unwrap();
    assert_eq!(stores.files.find(unused.id).await.unwrap(), None);
    assert!(stores.files.find_many(&[]).await.unwrap().is_empty());
}

async fn recalling_marks_the_message_and_logs_an_event(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    say(&stores, &conversation, &a, "一").await;
    let wrong = say(&stores, &conversation, &a, "说错了").await;
    let recall = |seq: i64| {
        let data = MessageData {
            seq: Some(seq),
            ..MessageData::default()
        };
        let mut event = event(conversation.id, MessageKind::Recalled, data);
        event.created_at = NOW + 60_000;
        event
    };
    let listed = stores.chat.list_for_user(b.id).await.unwrap();
    assert_eq!(listed[0].unread, 2);

    let logged = stores
        .chat
        .recall(&recall(wrong.seq), wrong.seq)
        .await
        .unwrap();
    let logged = logged.expect("the message was recalled");
    assert_eq!((logged.seq, logged.kind), (3, MessageKind::Recalled));
    assert_eq!(logged.data.seq, Some(wrong.seq));
    // 内容还保存着，只是做了标记
    let marked = one(&stores, &conversation, wrong.seq).await;
    assert_eq!(marked.recalled_at, Some(NOW + 60_000));
    assert_eq!(marked.text.as_deref(), Some("说错了"));
    // 已撤回的不算未读，撤回事件也不算
    let listed = stores.chat.list_for_user(b.id).await.unwrap();
    assert_eq!(listed[0].unread, 1);
    assert_eq!(listed[0].last_message.as_ref().unwrap().seq, 3);

    // 再撤回一次、撤回不存在的：什么也不做，序号也不动
    assert_eq!(
        stores
            .chat
            .recall(&recall(wrong.seq), wrong.seq)
            .await
            .unwrap(),
        None
    );
    assert_eq!(stores.chat.recall(&recall(99), 99).await.unwrap(), None);
    assert_eq!(last_seq(&stores, &conversation).await, 3);
}

async fn when_a_message_is_recalled_many_times_at_once_one_event_is_logged(stores: Stores) {
    let (a, _, conversation) = pair(&stores).await;
    let message = say(&stores, &conversation, &a, "说错了").await;

    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let stores = stores.clone();
            let data = MessageData {
                seq: Some(message.seq),
                ..MessageData::default()
            };
            let event = event(conversation.id, MessageKind::Recalled, data);
            tokio::spawn(async move { stores.chat.recall(&event, message.seq).await })
        })
        .collect();
    let mut logged = 0;
    for attempt in attempts {
        logged += attempt.await.unwrap().unwrap().is_some() as u32;
    }
    assert_eq!(logged, 1);
    assert_eq!(last_seq(&stores, &conversation).await, 2);
}

async fn a_voice_message_is_marked_played_once_per_listener(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let first = say(&stores, &conversation, &a, "语音一").await;
    let second = say(&stores, &conversation, &a, "语音二").await;

    assert!(stores.chat.mark_played(first.id, b.id, NOW).await.unwrap());
    assert!(
        !stores
            .chat
            .mark_played(first.id, b.id, NOW + 1)
            .await
            .unwrap()
    );
    assert!(stores.chat.mark_played(first.id, a.id, NOW).await.unwrap());

    let ids = [first.id, second.id];
    assert_eq!(stores.chat.played(b.id, &ids).await.unwrap(), [first.id]);
    assert!(
        stores
            .chat
            .played(b.id, &[second.id])
            .await
            .unwrap()
            .is_empty()
    );
    assert!(stores.chat.played(b.id, &[]).await.unwrap().is_empty());
}

async fn search_matches_text_captions_and_file_names_inside_the_given_scopes(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let c = user(&stores, "user_c").await;
    let other = stores
        .chat
        .open_direct(ConversationId::new(), a.id, c.id, NOW);
    let other = other.await.unwrap();
    let at = |mut message: NewMessage, offset: i64| {
        message.created_at = NOW + offset;
        message
    };
    let chat = &stores.chat;
    chat.append(&at(text(&conversation, &a, "s-1", "周六去 Hiking 吗"), 1))
        .await
        .unwrap();
    let file = upload(&stores, &b, "hiking-路线.PDF", NOW).await;
    chat.append(&at(attached(&conversation, &b, "s-2", file.id), 2))
        .await
        .unwrap();
    chat.append(&at(text(&conversation, &b, "s-3", "别的话题"), 3))
        .await
        .unwrap();
    let recalled = at(text(&conversation, &a, "s-4", "hiking 取消"), 4);
    let recalled = chat.append(&recalled).await.unwrap().message;
    let data = MessageData {
        seq: Some(recalled.seq),
        ..MessageData::default()
    };
    let event = event(conversation.id, MessageKind::Recalled, data);
    chat.recall(&event, recalled.seq).await.unwrap();
    chat.append(&at(text(&other, &c, "s-5", "HIKING 的装备"), 5))
        .await
        .unwrap();
    // 图片的文件名不在搜索范围里；文字在数据里的事件也不在
    let image = upload(&stores, &a, "hiking.png", NOW).await;
    let mut picture = at(attached(&conversation, &a, "s-6", image.id), 6);
    picture.kind = MessageKind::Image;
    chat.append(&picture).await.unwrap();
    // 带文字说明的图片按说明匹配
    let photo = upload(&stores, &a, "IMG_0001.png", NOW).await;
    let mut captioned = at(attached(&conversation, &a, "s-7", photo.id), 7);
    captioned.kind = MessageKind::Image;
    captioned.text = Some("徒步路上的照片".to_owned());
    chat.append(&captioned).await.unwrap();

    let scope = |conversation: &Conversation, after: i64, until: Option<i64>| SearchScope {
        conversation: conversation.id,
        visible: Visible {
            after,
            until,
            viewer: None,
        },
        before: None,
    };
    let everything = [scope(&conversation, 0, None), scope(&other, 0, None)];
    let seqs = |found: Vec<Message>| -> Vec<(ConversationId, i64)> {
        found.iter().map(|m| (m.conversation, m.seq)).collect()
    };

    // 从新到旧；英文不区分大小写；已撤回的不在里面
    let found = chat.search(&everything, "hiking", 10).await.unwrap();
    assert_eq!(
        seqs(found),
        [(other.id, 1), (conversation.id, 2), (conversation.id, 1)]
    );
    let found = chat.search(&everything, "HIKING", 2).await.unwrap();
    assert_eq!(seqs(found), [(other.id, 1), (conversation.id, 2)]);
    // 文件名
    let found = chat.search(&everything, "路线.pdf", 10).await.unwrap();
    assert_eq!(seqs(found), [(conversation.id, 2)]);
    // 图片的文字说明
    let found = chat.search(&everything, "徒步", 10).await.unwrap();
    assert_eq!(seqs(found), [(conversation.id, 7)]);
    // 只在给定的范围里：一个会话、一段序号、某个序号之前
    let found = chat.search(&everything[..1], "hiking", 10).await.unwrap();
    assert_eq!(seqs(found), [(conversation.id, 2), (conversation.id, 1)]);
    let late = [scope(&conversation, 1, None)];
    assert_eq!(
        seqs(chat.search(&late, "hiking", 10).await.unwrap()),
        [(conversation.id, 2)]
    );
    let early = [scope(&conversation, 0, Some(1))];
    assert_eq!(
        seqs(chat.search(&early, "hiking", 10).await.unwrap()),
        [(conversation.id, 1)]
    );
    let paged = [SearchScope {
        before: Some(2),
        ..scope(&conversation, 0, None)
    }];
    assert_eq!(
        seqs(chat.search(&paged, "hiking", 10).await.unwrap()),
        [(conversation.id, 1)]
    );
    assert!(chat.search(&[], "hiking", 10).await.unwrap().is_empty());
    assert!(
        chat.search(&everything, "没有这个词", 10)
            .await
            .unwrap()
            .is_empty()
    );
}

async fn search_takes_wildcard_characters_literally(stores: Stores) {
    let (a, _, conversation) = pair(&stores).await;
    for body in [
        "完成了 100%",
        "完成了 100 份",
        "file_name",
        "filename",
        "C:\\temp",
        "C:temp",
    ] {
        say(&stores, &conversation, &a, body).await;
    }
    let scope = [SearchScope {
        conversation: conversation.id,
        visible: ALL,
        before: None,
    }];
    let texts =
        |found: Vec<Message>| -> Vec<String> { found.into_iter().filter_map(|m| m.text).collect() };

    let found = stores.chat.search(&scope, "100%", 10).await.unwrap();
    assert_eq!(texts(found), ["完成了 100%"]);
    let found = stores.chat.search(&scope, "e_n", 10).await.unwrap();
    assert_eq!(texts(found), ["file_name"]);
    let found = stores.chat.search(&scope, "C:\\t", 10).await.unwrap();
    assert_eq!(texts(found), ["C:\\temp"]);
    let found = stores.chat.search(&scope, "%", 10).await.unwrap();
    assert_eq!(texts(found), ["完成了 100%"]);
}

async fn memberships_cover_every_conversation_ever_joined(stores: Stores) {
    let (conversation, owner, members, _) = group(&stores).await;
    let leaver = &members[0];
    let direct = stores
        .chat
        .open_direct(ConversationId::new(), owner.id, leaver.id, NOW);
    let direct = direct.await.unwrap();
    let left = event(
        conversation.id,
        MessageKind::MemberLeft,
        MessageData::default(),
    );
    let change = Change::Leave {
        user: leaver.id,
        hide: true,
    };
    stores.chat.apply(&left, &change).await.unwrap();

    // 离开了的群、还没有内容的单聊，都在里面
    let mut found = stores.chat.memberships(leaver.id).await.unwrap();
    found.sort_by_key(|m| m.left_seq.is_none());
    assert_eq!(found.len(), 2);
    assert_eq!(
        (found[0].conversation, found[0].left_seq),
        (conversation.id, Some(2))
    );
    assert_eq!(
        (found[1].conversation, found[1].left_seq),
        (direct.id, None)
    );
    assert!(
        stores
            .chat
            .memberships(UserId::new())
            .await
            .unwrap()
            .is_empty()
    );
}

/// 删除和清空只对自己（F6）：看的人删掉的、清空掉的取不到；别人照常；会话列表的摘要和未读跟着变。
async fn deleting_and_clearing_hide_messages_from_one_member_only(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let chat = &stores.chat;
    let one = say(&stores, &conversation, &b, "一").await;
    let two = say(&stores, &conversation, &b, "二").await;
    let three = say(&stores, &conversation, &b, "三").await;
    let mine = member(&stores, &conversation, &a).await.visible();
    let theirs = member(&stores, &conversation, &b).await.visible();
    let seqs = |found: Vec<Message>| found.into_iter().map(|m| m.seq).collect::<Vec<_>>();
    let listing = |user: &User| {
        let user = user.id;
        async move {
            chat.list_for_user(user)
                .await
                .unwrap()
                .into_iter()
                .find(|listing| listing.conversation.id == conversation.id)
        }
    };

    chat.delete_for(conversation.id, a.id, &[three.seq, two.seq], NOW)
        .await
        .unwrap();
    // 再删一次同样的：不出错
    chat.delete_for(conversation.id, a.id, &[three.seq], NOW)
        .await
        .unwrap();
    let all = chat
        .list_before(conversation.id, mine, None, 50)
        .await
        .unwrap();
    assert!(!seqs(all.clone()).contains(&two.seq) && !seqs(all).contains(&three.seq));
    let all = chat
        .list_before(conversation.id, theirs, None, 50)
        .await
        .unwrap();
    assert!(seqs(all).contains(&three.seq));
    // 搜不到
    let scope = SearchScope {
        conversation: conversation.id,
        visible: mine,
        before: None,
    };
    assert!(chat.search(&[scope], "三", 10).await.unwrap().is_empty());
    // 列表：最新的一条是还剩下的"一"，未读只算它
    let mine_listed = listing(&a).await.unwrap();
    assert_eq!(mine_listed.last_message.map(|m| m.seq), Some(one.seq));
    assert_eq!(mine_listed.unread, 1);

    // 清空：之前的都不见了，已读跟着挪过去；会话还在列表里，没有摘要
    let last = three.seq;
    chat.clear(conversation.id, a.id, last).await.unwrap();
    let me = member(&stores, &conversation, &a).await;
    assert_eq!((me.cleared_seq, me.read_seq), (last, last));
    assert!(
        chat.list_before(conversation.id, me.visible(), None, 50)
            .await
            .unwrap()
            .is_empty()
    );
    let mine_listed = listing(&a).await.expect("still listed");
    assert_eq!((mine_listed.last_message, mine_listed.unread), (None, 0));
    // 清空的位置不往回挪
    chat.clear(conversation.id, a.id, 1).await.unwrap();
    assert_eq!(member(&stores, &conversation, &a).await.cleared_seq, last);

    // 之后的照常
    let four = say(&stores, &conversation, &b, "四").await;
    let me = member(&stores, &conversation, &a).await;
    assert_eq!(
        seqs(
            chat.list_before(conversation.id, me.visible(), None, 50)
                .await
                .unwrap()
        ),
        vec![four.seq]
    );
    // 对方一条都没少
    assert_eq!(
        chat.list_before(conversation.id, theirs, None, 50)
            .await
            .unwrap()
            .len(),
        4
    );
}

/// 图片和文件一览：只取那一种、没撤回的、看得到范围里的，从新到旧一页一页地取。
async fn the_gallery_takes_one_kind_newest_first(stores: Stores) {
    let (a, _b, conversation) = pair(&stores).await;
    let chat = &stores.chat;
    let mut images = Vec::new();
    for at in 0..3 {
        let mut message = text(&conversation, &a, &format!("img-{at}"), "");
        message.kind = MessageKind::Image;
        message.text = None;
        images.push(chat.append(&message).await.unwrap().message.seq);
        say(&stores, &conversation, &a, "话").await;
    }
    let mut file = text(&conversation, &a, "file-1", "");
    file.kind = MessageKind::File;
    file.text = None;
    let file = chat.append(&file).await.unwrap().message.seq;
    let seqs = |found: Vec<Message>| found.into_iter().map(|m| m.seq).collect::<Vec<_>>();

    let newest = chat
        .list_kind_before(conversation.id, ALL, MessageKind::Image, None, 2)
        .await
        .unwrap();
    assert_eq!(seqs(newest), images[1..].to_vec());
    let older = chat
        .list_kind_before(conversation.id, ALL, MessageKind::Image, Some(images[1]), 2)
        .await
        .unwrap();
    assert_eq!(seqs(older), vec![images[0]]);
    let files = chat
        .list_kind_before(conversation.id, ALL, MessageKind::File, None, 10)
        .await
        .unwrap();
    assert_eq!(seqs(files), vec![file]);

    // 撤回了的、看得到的范围以外的不取
    let recalled = event(
        conversation.id,
        MessageKind::Recalled,
        MessageData {
            seq: Some(images[2]),
            ..MessageData::default()
        },
    );
    chat.recall(&recalled, images[2]).await.unwrap();
    let later = Visible {
        after: images[0],
        until: None,
        viewer: None,
    };
    let found = chat
        .list_kind_before(conversation.id, later, MessageKind::Image, None, 10)
        .await
        .unwrap();
    assert_eq!(seqs(found), vec![images[1]]);
}

/// 置顶是一个成员自己的设置：记着置顶的时间，取消了为空；对方不受影响，列表里带着。
async fn pinning_is_a_setting_of_one_member_only(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    say(&stores, &conversation, &b, "一").await;
    let pinned = |user: &User| {
        let stores = stores.clone();
        let (conversation, user) = (conversation.clone(), user.clone());
        async move { member(&stores, &conversation, &user).await.pinned_at }
    };
    assert_eq!(pinned(&a).await, None);
    stores
        .chat
        .set_pinned(conversation.id, a.id, Some(NOW + 5))
        .await
        .unwrap();
    assert_eq!(pinned(&a).await, Some(NOW + 5));
    assert_eq!(pinned(&b).await, None);
    let listed = stores.chat.list_for_user(a.id).await.unwrap();
    assert_eq!(listed[0].me.pinned_at, Some(NOW + 5));
    stores
        .chat
        .set_pinned(conversation.id, a.id, None)
        .await
        .unwrap();
    assert_eq!(pinned(&a).await, None);
}

async fn muting_is_a_setting_of_one_member_only(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    say(&stores, &conversation, &b, "一").await;
    let muted = |user: &User| {
        let stores = stores.clone();
        let (conversation, user) = (conversation.clone(), user.clone());
        async move { member(&stores, &conversation, &user).await.muted }
    };
    assert!(!muted(&a).await);

    stores
        .chat
        .set_muted(conversation.id, a.id, true)
        .await
        .unwrap();
    assert!(muted(&a).await);
    // 对方不受影响
    assert!(!muted(&b).await);
    // 消息照常收，未读数照常算；列表里带着这个设置
    say(&stores, &conversation, &b, "二").await;
    let listed = stores.chat.list_for_user(a.id).await.unwrap();
    assert_eq!((listed[0].unread, listed[0].me.muted), (2, true));

    stores
        .chat
        .set_muted(conversation.id, a.id, false)
        .await
        .unwrap();
    assert!(!muted(&a).await);
    // 不是成员的人：什么也不发生
    stores
        .chat
        .set_muted(conversation.id, UserId::new(), true)
        .await
        .unwrap();
}

async fn a_notice_is_kept_on_the_group_together_with_its_event(stores: Stores) {
    let chat = &stores.chat;
    let (conversation, owner, members, _) = group(&stores).await;
    // 有一个人已经离开了：发布公告不会提醒他
    let gone = &members[2];
    done(
        chat.apply(
            &event(
                conversation.id,
                MessageKind::MemberLeft,
                MessageData::default(),
            ),
            &Change::Leave {
                user: gone.id,
                hide: false,
            },
        )
        .await
        .unwrap(),
    );

    let mut published = event(
        conversation.id,
        MessageKind::NoticeChanged,
        MessageData {
            actor: Some(party(&owner)),
            ..MessageData::default()
        },
    );
    published.text = Some("周五开会".to_owned());
    let change = Change::SetNotice {
        text: Some("周五开会".to_owned()),
        by: owner.id,
        remind: true,
    };
    let message = done(chat.apply(&published, &change).await.unwrap());
    assert_eq!(message.kind, MessageKind::NoticeChanged);
    assert_eq!(
        one(&stores, &conversation, message.seq)
            .await
            .text
            .as_deref(),
        Some("周五开会")
    );

    let stored = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    let notice = stored.notice.expect("the notice is kept");
    assert_eq!(
        (notice.text.as_str(), notice.by, notice.at, notice.seq),
        ("周五开会", owner.id, published.created_at, message.seq)
    );
    // 发布的人算看过了，不提醒自己；在群的其他人被提醒；离开了的人不提醒
    let me = member(&stores, &conversation, &owner).await;
    assert_eq!((me.notice_seen_seq, me.mentioned_seq), (message.seq, 0));
    for other in &members[..2] {
        let other = member(&stores, &conversation, other).await;
        assert_eq!(
            (other.notice_seen_seq, other.mentioned_seq),
            (0, message.seq)
        );
    }
    assert_eq!(member(&stores, &conversation, gone).await.mentioned_seq, 0);

    // 看过了：只前进不后退
    assert!(
        chat.mark_notice_seen(conversation.id, members[0].id, message.seq)
            .await
            .unwrap()
    );
    assert!(
        !chat
            .mark_notice_seen(conversation.id, members[0].id, message.seq)
            .await
            .unwrap()
    );
    assert!(
        !chat
            .mark_notice_seen(conversation.id, members[0].id, 1)
            .await
            .unwrap()
    );
    assert_eq!(
        member(&stores, &conversation, &members[0])
            .await
            .notice_seen_seq,
        message.seq
    );

    // 清空：公告连同发布人、时间都没有了；不提醒
    let cleared = event(
        conversation.id,
        MessageKind::NoticeChanged,
        MessageData {
            actor: Some(party(&owner)),
            ..MessageData::default()
        },
    );
    let change = Change::SetNotice {
        text: None,
        by: owner.id,
        remind: false,
    };
    done(chat.apply(&cleared, &change).await.unwrap());
    let stored = chat
        .find_conversation(conversation.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.notice, None);
    assert_eq!(
        member(&stores, &conversation, &members[1])
            .await
            .mentioned_seq,
        message.seq
    );
}

async fn a_chat_record_keeps_its_items_and_owns_the_files_inside(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let photo = upload(&stores, &a, "海边.png", NOW - 100_000).await;
    let report = upload(&stores, &a, "周报.pdf", NOW - 100_000).await;
    let item = |kind, text: Option<&str>, file: Option<FileId>| RecordItem {
        sender: Some(b.id),
        sender_name: "小红".to_owned(),
        sender_avatar: Some(photo.id),
        kind,
        text: text.map(str::to_owned),
        file,
        duration_ms: (kind == MessageKind::Voice).then_some(1500),
        created_at: NOW - 1,
    };
    let record = Record {
        title: "小明和小红的聊天记录".to_owned(),
        items: vec![
            item(MessageKind::Text, Some("明天见"), None),
            item(MessageKind::Image, Some("海边"), Some(photo.id)),
            item(MessageKind::File, None, Some(report.id)),
            item(MessageKind::ChatRecord, Some("更早的记录"), None),
        ],
    };
    let message = NewMessage {
        kind: MessageKind::ChatRecord,
        text: Some("小明和小红的聊天记录\n明天见\n海边\n周报.pdf".to_owned()),
        data: MessageData {
            record: Some(record.clone()),
            ..MessageData::default()
        },
        ..text(&conversation, &a, "r-1", "")
    };
    let sent = stores.chat.append(&message).await.unwrap().message;
    // 写进去的和读出来的一样
    assert_eq!(one(&stores, &conversation, sent.seq).await, sent);
    assert_eq!(sent.data.record, Some(record));
    // 里面的文件属于这一条；它们不是没人用的文件
    for file in [photo.id, report.id] {
        assert_eq!(
            stores.chat.find_by_file(file).await.unwrap(),
            Some(sent.clone())
        );
    }
    assert!(stores.files.list_orphans(NOW).await.unwrap().is_empty());
    // 重发不会再登记一遍
    let resent = stores.chat.append(&message).await.unwrap();
    assert!(resent.duplicate);

    // 按拼好的那段文字搜得到；大小写不论
    let scopes = [SearchScope {
        conversation: conversation.id,
        visible: ALL,
        before: None,
    }];
    for needle in ["明天见", "周报", "PDF"] {
        let found = stores.chat.search(&scopes, needle, 10).await.unwrap();
        assert_eq!(found, std::slice::from_ref(&sent), "{needle}");
    }

    // 过期清理：里面的文件一起交出去，查不到它们属于哪一条了
    let purged = stores.chat.purge_before(NOW + 1).await.unwrap();
    assert_eq!(purged.messages, 1);
    let mut files = purged.files;
    files.sort();
    let mut expected = vec![photo.id, report.id];
    expected.sort();
    assert_eq!(files, expected);
    assert_eq!(stores.chat.find_by_file(photo.id).await.unwrap(), None);
    let orphans = stores.files.list_orphans(NOW).await.unwrap();
    assert_eq!(orphans.len(), 2);
}

/// 通话记录：结果和时长原样读得回来；它有发送人（主叫），算对方的未读；搜不到。
async fn a_call_record_keeps_its_outcome_and_counts_as_unread(stores: Stores) {
    let (a, b, conversation) = pair(&stores).await;
    let chat = &stores.chat;
    let record = |outcome: CallOutcome, duration_ms: Option<i64>| NewMessage {
        kind: MessageKind::Call,
        text: None,
        client_id: None,
        data: MessageData {
            call: Some(outcome),
            duration_ms,
            ..MessageData::default()
        },
        ..text(&conversation, &a, "unused", "")
    };
    let talked = chat
        .append(&record(CallOutcome::Completed, Some(192_000)))
        .await
        .unwrap()
        .message;
    let missed = chat
        .append(&record(CallOutcome::Missed, None))
        .await
        .unwrap()
        .message;

    let read_back = one(&stores, &conversation, talked.seq).await;
    assert_eq!(read_back.kind, MessageKind::Call);
    assert_eq!(read_back.sender, Some(a.id));
    assert_eq!(read_back.data.call, Some(CallOutcome::Completed));
    assert_eq!(read_back.data.duration_ms, Some(192_000));
    let read_back = one(&stores, &conversation, missed.seq).await;
    assert_eq!(read_back.data.call, Some(CallOutcome::Missed));
    assert_eq!(read_back.data.duration_ms, None);
    assert!(!read_back.data.call_video);

    // 视频通话的记录
    let mut video = record(CallOutcome::Completed, Some(5_000));
    video.data.call_video = true;
    let video = chat.append(&video).await.unwrap().message;
    assert!(one(&stores, &conversation, video.seq).await.data.call_video);
    // 一对一通话的记录里没有"几人参加"
    assert_eq!(read_back.data.call_joined, None);

    // 群通话的记录（F10）：几个人参加过
    let mut together = record(CallOutcome::Completed, Some(65_000));
    together.data.call_joined = Some(4);
    let together = chat.append(&together).await.unwrap().message;
    let read_back = one(&stores, &conversation, together.seq).await;
    assert_eq!(read_back.data.call_joined, Some(4));
    assert_eq!(read_back.data.duration_ms, Some(65_000));

    let unread = |user: &User| {
        let user = user.id;
        async move {
            chat.list_for_user(user)
                .await
                .unwrap()
                .into_iter()
                .find(|listing| listing.conversation.id == conversation.id)
                .unwrap()
                .unread
        }
    };
    assert_eq!(unread(&b).await, 4);
    assert_eq!(unread(&a).await, 0);

    let scope = SearchScope {
        conversation: conversation.id,
        visible: ALL,
        before: None,
    };
    for needle in ["call", "completed", "missed"] {
        assert!(chat.search(&[scope], needle, 10).await.unwrap().is_empty());
    }
}

on_both_databases!(
    edit,
    editing_replaces_the_text_and_logs_an_event_with_what_it_was
);
on_both_databases!(
    call_record,
    a_call_record_keeps_its_outcome_and_counts_as_unread
);
on_both_databases!(
    chat_record,
    a_chat_record_keeps_its_items_and_owns_the_files_inside
);
on_both_databases!(
    notice,
    a_notice_is_kept_on_the_group_together_with_its_event
);
on_both_databases!(mute, muting_is_a_setting_of_one_member_only);
on_both_databases!(pin, pinning_is_a_setting_of_one_member_only);
on_both_databases!(gallery, the_gallery_takes_one_kind_newest_first);
on_both_databases!(
    delete_clear,
    deleting_and_clearing_hide_messages_from_one_member_only
);
on_both_databases!(group_mutes, mutes_are_kept_on_members_and_the_group);
on_both_databases!(
    join_requests,
    join_requests_stay_one_pending_per_invitee_and_are_settled_once
);
on_both_databases!(group_nickname, a_group_nickname_is_set_only_when_it_changes);
on_both_databases!(
    admins,
    admins_are_limited_and_lose_the_role_when_leaving_or_taking_over
);
on_both_databases!(attachment, a_file_belongs_to_at_most_one_message);
on_both_databases!(recall, recalling_marks_the_message_and_logs_an_event);
on_both_databases!(
    recall_race,
    when_a_message_is_recalled_many_times_at_once_one_event_is_logged
);
on_both_databases!(
    voice_plays,
    a_voice_message_is_marked_played_once_per_listener
);
on_both_databases!(
    search,
    search_matches_text_captions_and_file_names_inside_the_given_scopes
);
on_both_databases!(search_literal, search_takes_wildcard_characters_literally);
on_both_databases!(
    memberships,
    memberships_cover_every_conversation_ever_joined
);
on_both_databases!(open_direct, two_users_have_one_direct_conversation);
on_both_databases!(
    group_create,
    a_group_is_created_with_its_members_and_first_event
);
on_both_databases!(
    group_join,
    joining_respects_the_limit_and_starts_a_new_visible_range
);
on_both_databases!(group_join_race, when_many_join_at_once_the_limit_holds);
on_both_databases!(group_leave, leaving_closes_the_visible_range);
on_both_databases!(
    group_details,
    group_details_change_together_with_their_events
);
on_both_databases!(group_mentions, mentions_are_recorded_for_those_in_the_group);
on_both_databases!(
    open_direct_race,
    when_a_conversation_is_opened_many_times_at_once_there_is_still_one
);
on_both_databases!(append, messages_get_consecutive_sequence_numbers);
on_both_databases!(
    append_race,
    when_many_write_at_once_every_sequence_number_is_used_exactly_once
);
on_both_databases!(dedupe, the_same_client_id_is_written_only_once);
on_both_databases!(
    dedupe_race,
    when_one_message_is_sent_many_times_at_once_it_is_written_once
);
on_both_databases!(slices, messages_are_read_in_slices_by_sequence_number);
on_both_databases!(read_position, the_read_position_only_moves_forward);
on_both_databases!(listing, the_list_holds_what_a_user_should_see);

/// 编辑（F8）：原来那条换上新的文字和 @、记下编辑时间；会话日志里多一条编辑事件，带着修改之前的
/// 内容；新 @ 到的人记上提醒，编辑的人自己不算；会话列表的摘要不是编辑事件；撤回了的改不了。
async fn editing_replaces_the_text_and_logs_an_event_with_what_it_was(stores: Stores) {
    let (conversation, owner, members, _) = group(&stores).await;
    let chat = &stores.chat;
    let said = say(&stores, &conversation, &owner, "今天开会").await;
    let newcomer = &members[0];
    let edit_event = |text: &str, mentions: Vec<UserId>| {
        let mut event = event(
            conversation.id,
            MessageKind::Edited,
            MessageData {
                actor: Some(party(&owner)),
                seq: Some(said.seq),
                mentions,
                previous: Some("今天开会".to_owned()),
                ..MessageData::default()
            },
        );
        event.text = Some(text.to_owned());
        event.created_at = NOW + 5;
        event
    };
    let change = Edit {
        text: Some("明天开会 @member_1".to_owned()),
        mentions: vec![newcomer.id, owner.id],
        mention_all: false,
    };
    let logged = chat
        .edit(
            &edit_event("明天开会 @member_1", vec![newcomer.id, owner.id]),
            said.seq,
            &change,
        )
        .await
        .unwrap()
        .expect("edited");
    assert_eq!(logged.kind, MessageKind::Edited);
    assert_eq!(logged.seq, said.seq + 1);
    assert_eq!(logged.data.previous.as_deref(), Some("今天开会"));

    let found = chat
        .find_messages(conversation.id, &[said.seq])
        .await
        .unwrap();
    let edited = &found[0];
    assert_eq!(edited.text.as_deref(), Some("明天开会 @member_1"));
    assert_eq!(edited.data.mentions, [newcomer.id, owner.id]);
    assert_eq!(edited.edited_at, Some(NOW + 5));
    // 读回来的事件和写进去的一样
    let back = chat
        .find_messages(conversation.id, &[logged.seq])
        .await
        .unwrap();
    assert_eq!(back[0], logged);

    // 新 @ 到的人记上了提醒；编辑的人自己没有
    assert_eq!(
        member(&stores, &conversation, newcomer).await.mentioned_seq,
        logged.seq
    );
    assert_eq!(
        member(&stores, &conversation, &owner).await.mentioned_seq,
        0
    );

    // 会话列表的摘要是被编辑的那一条，不是编辑事件
    let listed = chat.list_for_user(newcomer.id).await.unwrap();
    let row = listed
        .iter()
        .find(|listing| listing.conversation.id == conversation.id)
        .unwrap();
    assert_eq!(row.last_message.as_ref().map(|m| m.seq), Some(said.seq));

    // 撤回了的改不了
    let mut recall = event(
        conversation.id,
        MessageKind::Recalled,
        MessageData {
            actor: Some(party(&owner)),
            seq: Some(said.seq),
            ..MessageData::default()
        },
    );
    recall.created_at = NOW + 6;
    chat.recall(&recall, said.seq).await.unwrap().unwrap();
    let again = chat
        .edit(&edit_event("再改", Vec::new()), said.seq, &change)
        .await
        .unwrap();
    assert_eq!(again, None);
}
