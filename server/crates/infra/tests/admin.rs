//! 管理功能用到的数据操作，在 SQLite 和 Postgres 上各跑一遍。

mod common;

use std::sync::atomic::{AtomicU64, Ordering};

use vibechat_core::account::model::{
    FilePurpose, InviteCode, InviteCodeStatus, Role, StoredFile, User, UserQuery, UserStatus,
};
use vibechat_core::admin::model::{AdminToken, AuditAction, AuditDetail, AuditEntry, TokenPurpose};
use vibechat_core::chat::model::{
    Change, Conversation, MessageData, MessageKind, NewGroup, NewMessage, Visible,
};
use vibechat_core::{ConversationId, FileId, InviteCodeId, MessageId, Stores, UserId};

const NOW: i64 = 1_700_000_000_000;
const DAY: i64 = 24 * 60 * 60 * 1000;
const ALL: Visible = Visible::EVERYTHING;

fn next() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn account(handle: &str, nickname: &str, role: Role, created_at: i64) -> User {
    User {
        id: UserId::new(),
        handle: handle.to_owned(),
        nickname: nickname.to_owned(),
        signature: String::new(),
        avatar: None,
        password_hash: "hash".to_owned(),
        role,
        status: UserStatus::Active,
        must_change_password: false,
        email: (role == Role::Admin).then(|| "boss@example.com".to_owned()),
        language: None,
        theme: None,
        created_at,
        last_login_at: None,
    }
}

/// 注册一个用户，返回他和他用掉的邀请码。
async fn register(
    stores: &Stores,
    handle: &str,
    nickname: &str,
    created_at: i64,
) -> (User, InviteCode) {
    let code = InviteCode {
        id: InviteCodeId::new(),
        code: format!("CODE{:012}", next()),
        note: None,
        status: InviteCodeStatus::Unused,
        expires_at: None,
        created_by: UserId::new(),
        created_at: NOW,
        used_by: None,
        used_at: None,
    };
    let codes = std::slice::from_ref(&code);
    stores.invite_codes.create_many(codes).await.unwrap();
    let user = account(handle, nickname, Role::User, created_at);
    let created = stores.users.create_with_invite(&user, code.id, NOW);
    created.await.unwrap();
    (user, code)
}

async fn user(stores: &Stores, handle: &str) -> User {
    register(stores, handle, handle, NOW).await.0
}

fn message(conversation: ConversationId, sender: &User, body: &str, at: i64) -> NewMessage {
    NewMessage {
        id: MessageId::new(),
        conversation,
        sender: Some(sender.id),
        client_id: Some(format!("c-{}", next())),
        kind: MessageKind::Text,
        text: Some(body.to_owned()),
        data: MessageData::default(),
        file: None,
        reply_to: None,
        created_at: at,
    }
}

async fn group(stores: &Stores, name: Option<&str>, owner: &User, created_at: i64) -> Conversation {
    let id = ConversationId::new();
    let event = NewMessage {
        sender: None,
        client_id: None,
        kind: MessageKind::GroupCreated,
        text: None,
        ..message(id, owner, "", created_at)
    };
    let new = NewGroup {
        id,
        name: name.map(str::to_owned),
        owner: owner.id,
        members: vec![owner.id],
        event,
    };
    stores.chat.create_group(&new).await.unwrap().0
}

fn entry(actor: &User, action: AuditAction, at: i64, detail: AuditDetail) -> AuditEntry {
    AuditEntry {
        id: uuid::Uuid::now_v7().to_string(),
        at,
        actor: actor.id,
        action,
        target: Some(actor.id.to_string()),
        detail,
    }
}

async fn audit_entries_are_appended_and_read_newest_first(stores: Stores) {
    let boss = account("admin", "Admin", Role::Admin, NOW);
    let (none, total) = stores.audit.list(None, 0, 20).await.unwrap();
    assert!(none.is_empty());
    assert_eq!(total, 0);

    let full = AuditDetail {
        label: Some("小明 (xiaoming)".to_owned()),
        count: Some(3),
        key: Some("file_max_bytes".to_owned()),
        from: Some("104857600".to_owned()),
        to: Some("2097152".to_owned()),
    };
    let first = entry(
        &boss,
        AuditAction::UserDisabled,
        NOW,
        AuditDetail::default(),
    );
    let second = entry(&boss, AuditAction::SettingChanged, NOW + 1, full);
    let mut third = entry(
        &boss,
        AuditAction::UserDisabled,
        NOW + 2,
        AuditDetail::default(),
    );
    third.target = None;
    for entry in [&first, &second, &third] {
        stores.audit.append(entry).await.unwrap();
    }

    // 每一项都原样读回来，包括空的参数和空的对象
    let (entries, total) = stores.audit.list(None, 0, 20).await.unwrap();
    assert_eq!(total, 3);
    assert_eq!(entries, [third.clone(), second.clone(), first.clone()]);

    let only = Some(AuditAction::UserDisabled);
    let (entries, total) = stores.audit.list(only, 0, 20).await.unwrap();
    assert_eq!((entries, total), (vec![third, first.clone()], 2));
    let (entries, total) = stores.audit.list(only, 1, 1).await.unwrap();
    assert_eq!((entries, total), (vec![first], 2));
    let (entries, total) = stores.audit.list(None, 1, 1).await.unwrap();
    assert_eq!((entries, total), (vec![second], 3));
    let unused = Some(AuditAction::GroupDissolved);
    assert_eq!(stores.audit.list(unused, 0, 20).await.unwrap().1, 0);
}

async fn a_token_is_consumed_once_for_its_own_purpose_before_it_expires(stores: Stores) {
    let boss = account("admin", "Admin", Role::Admin, NOW);
    assert!(stores.users.create_admin_if_none(&boss).await.unwrap());
    let token = |hash: &str, purpose, email: Option<&str>| AdminToken {
        token_hash: hash.to_owned(),
        user: boss.id,
        purpose,
        email: email.map(str::to_owned),
        expires_at: NOW + 1000,
        used_at: None,
    };
    let reset = token("hash-reset", TokenPurpose::ResetPassword, None);
    let confirm = token(
        "hash-confirm",
        TokenPurpose::ConfirmEmail,
        Some("new@example.com"),
    );
    let stale = token("hash-stale", TokenPurpose::ResetPassword, None);
    for token in [&reset, &confirm, &stale] {
        stores.tokens.create(token).await.unwrap();
    }
    let tokens = &stores.tokens;

    // 用途不对、不存在：都拿不到，也不会把它用掉
    let wrong = tokens.consume("hash-reset", TokenPurpose::ConfirmEmail, NOW);
    assert_eq!(wrong.await.unwrap(), None);
    let missing = tokens.consume("nope", TokenPurpose::ResetPassword, NOW);
    assert_eq!(missing.await.unwrap(), None);

    let used = tokens.consume("hash-reset", TokenPurpose::ResetPassword, NOW + 5);
    let used = used.await.unwrap().unwrap();
    assert_eq!(used.user, boss.id);
    assert_eq!(used.used_at, Some(NOW + 5));
    let again = tokens.consume("hash-reset", TokenPurpose::ResetPassword, NOW + 6);
    assert_eq!(again.await.unwrap(), None);

    let used = tokens.consume("hash-confirm", TokenPurpose::ConfirmEmail, NOW + 999);
    assert_eq!(
        used.await.unwrap().unwrap().email.as_deref(),
        Some("new@example.com")
    );

    // 到期的那一刻就不能用了
    let expired = tokens.consume("hash-stale", TokenPurpose::ResetPassword, NOW + 1000);
    assert_eq!(expired.await.unwrap(), None);
}

async fn when_a_token_is_used_many_times_at_once_only_one_succeeds(stores: Stores) {
    let boss = account("admin", "Admin", Role::Admin, NOW);
    stores.users.create_admin_if_none(&boss).await.unwrap();
    let token = AdminToken {
        token_hash: "hash-race".to_owned(),
        user: boss.id,
        purpose: TokenPurpose::ResetPassword,
        email: None,
        expires_at: NOW + 1000,
        used_at: None,
    };
    stores.tokens.create(&token).await.unwrap();

    let attempts: Vec<_> = (0..8)
        .map(|_| {
            let stores = stores.clone();
            tokio::spawn(async move {
                let used = stores
                    .tokens
                    .consume("hash-race", TokenPurpose::ResetPassword, NOW);
                used.await.unwrap().is_some()
            })
        })
        .collect();
    let mut winners = 0;
    for attempt in attempts {
        winners += usize::from(attempt.await.unwrap());
    }
    assert_eq!(winners, 1);
}

async fn users_are_listed_searched_and_counted(stores: Stores) {
    let boss = account("admin", "Admin", Role::Admin, NOW);
    stores.users.create_admin_if_none(&boss).await.unwrap();
    let (ming, ming_code) = register(&stores, "xiaoming", "小明", NOW + 1).await;
    let (bob, bob_code) = register(&stores, "Bob_2024", "Bob 100%", NOW + 2).await;
    let (hong, _) = register(&stores, "hong", "小红 Bobby", NOW + 3).await;
    let users = &stores.users;
    let list = |search: Option<&str>, status, offset, limit| {
        let query = UserQuery {
            search: search.map(str::to_owned),
            status,
            offset,
            limit,
        };
        async move {
            let (found, total) = users.list(&query).await.unwrap();
            let ids: Vec<UserId> = found.iter().map(|user| user.id).collect();
            (ids, total)
        }
    };

    // 注册晚的在前
    let everyone = list(None, None, 0, 20).await;
    assert_eq!(everyone, (vec![hong.id, bob.id, ming.id, boss.id], 4));
    assert_eq!(list(None, None, 1, 2).await, (vec![bob.id, ming.id], 4));

    // ID 和昵称里都找，不区分大小写
    assert_eq!(
        list(Some("BOB"), None, 0, 20).await,
        (vec![hong.id, bob.id], 2)
    );
    assert_eq!(
        list(Some("XiaoMing"), None, 0, 20).await,
        (vec![ming.id], 1)
    );
    assert_eq!(
        list(Some("小"), None, 0, 20).await,
        (vec![hong.id, ming.id], 2)
    );
    // 通配符按字面匹配
    assert_eq!(list(Some("100%"), None, 0, 20).await, (vec![bob.id], 1));
    assert_eq!(list(Some("_2024"), None, 0, 20).await, (vec![bob.id], 1));
    assert_eq!(list(Some("%"), None, 0, 20).await, (vec![bob.id], 1));
    assert_eq!(list(Some("x_a"), None, 0, 20).await, (vec![], 0));

    users
        .set_status(bob.id, UserStatus::Disabled)
        .await
        .unwrap();
    assert_eq!(
        users.find(bob.id).await.unwrap().unwrap().status,
        UserStatus::Disabled
    );
    let disabled = Some(UserStatus::Disabled);
    assert_eq!(list(None, disabled, 0, 20).await, (vec![bob.id], 1));
    assert_eq!(
        list(Some("bob"), Some(UserStatus::Active), 0, 20).await,
        (vec![hong.id], 1)
    );
    let counts = users.counts().await.unwrap();
    assert_eq!((counts.total, counts.disabled), (4, 1));
    users.set_status(bob.id, UserStatus::Active).await.unwrap();
    assert_eq!(users.counts().await.unwrap().disabled, 0);

    // 那一名管理员，和他的邮箱
    assert_eq!(users.find_admin().await.unwrap().unwrap().id, boss.id);
    users.set_email(boss.id, "new@example.com").await.unwrap();
    let admin = users.find_admin().await.unwrap().unwrap();
    assert_eq!(admin.email.as_deref(), Some("new@example.com"));

    // 各人注册时用的邀请码
    let codes = &stores.invite_codes;
    let mut used = codes
        .find_used_by(&[ming.id, bob.id, boss.id])
        .await
        .unwrap();
    used.sort_by_key(|invite| invite.code.clone());
    let pairs: Vec<(Option<UserId>, &str)> = used
        .iter()
        .map(|invite| (invite.used_by, invite.code.as_str()))
        .collect();
    assert_eq!(
        pairs,
        [
            (Some(ming.id), ming_code.code.as_str()),
            (Some(bob.id), bob_code.code.as_str())
        ]
    );
    assert!(codes.find_used_by(&[]).await.unwrap().is_empty());
    let found = codes.find_many(&[ming_code.id, InviteCodeId::new()]).await;
    let found = found.unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].status, InviteCodeStatus::Used);
    assert!(codes.find_many(&[]).await.unwrap().is_empty());
}

async fn no_admin_is_found_before_one_exists(stores: Stores) {
    register(&stores, "someone", "某人", NOW).await;
    assert_eq!(stores.users.find_admin().await.unwrap(), None);
}

async fn file(stores: &Stores, uploader: &User, purpose: FilePurpose, size: i64) -> StoredFile {
    let id = FileId::new();
    let file = StoredFile {
        id,
        storage_key: format!("{}/{}/{id}", purpose.as_str(), uploader.id),
        content_type: "application/octet-stream".to_owned(),
        size,
        uploader: uploader.id,
        purpose,
        width: None,
        height: None,
        name: None,
        thumbnail_key: None,
        created_at: NOW,
    };
    stores.files.create(&file).await.unwrap();
    file
}

async fn storage_usage_adds_up_every_file(stores: Stores) {
    assert_eq!(stores.files.usage().await.unwrap(), (0, 0));
    let a = user(&stores, "user_a").await;
    file(&stores, &a, FilePurpose::Avatar, 1000).await;
    let big = file(&stores, &a, FilePurpose::Attachment, 5_000_000_000).await;
    file(&stores, &a, FilePurpose::Attachment, 24).await;
    assert_eq!(stores.files.usage().await.unwrap(), (3, 5_000_001_024));
    stores.files.delete(big.id).await.unwrap();
    assert_eq!(stores.files.usage().await.unwrap(), (2, 1024));
}

async fn every_group_is_listed_and_found_by_name(stores: Stores) {
    let owner = user(&stores, "owner").await;
    let other = user(&stores, "other").await;
    let alpha = group(&stores, Some("Alpha 项目"), &owner, NOW).await;
    let unnamed = group(&stores, None, &owner, NOW + 1).await;
    let second = group(&stores, Some("alpha_二期 50%"), &other, NOW + 2).await;
    let direct = stores
        .chat
        .open_direct(ConversationId::new(), owner.id, other.id, NOW + 3);
    let direct = direct.await.unwrap();
    let chat = &stores.chat;
    let list = |search: Option<&'static str>, offset, limit| async move {
        let (groups, total) = chat.list_all_groups(search, offset, limit).await.unwrap();
        let ids: Vec<ConversationId> = groups.iter().map(|group| group.id).collect();
        (ids, total)
    };

    // 新建的在前；单聊不在里面
    assert_eq!(
        list(None, 0, 20).await,
        (vec![second.id, unnamed.id, alpha.id], 3)
    );
    assert_eq!(list(None, 1, 1).await, (vec![unnamed.id], 3));
    assert_eq!(
        list(Some("ALPHA"), 0, 20).await,
        (vec![second.id, alpha.id], 2)
    );
    assert_eq!(list(Some("项目"), 0, 20).await, (vec![alpha.id], 1));
    assert_eq!(list(Some("a_"), 0, 20).await, (vec![second.id], 1));
    assert_eq!(list(Some("0%"), 0, 20).await, (vec![second.id], 1));
    assert_eq!(list(Some("没有"), 0, 20).await, (vec![], 0));

    // 解散了的仍然列出来，但不计入"现在有多少个群"
    assert_eq!(chat.count_groups().await.unwrap(), 3);
    let dissolved = NewMessage {
        sender: None,
        client_id: None,
        kind: MessageKind::Dissolved,
        text: None,
        ..message(alpha.id, &owner, "", NOW + 4)
    };
    chat.apply(&dissolved, &Change::Dissolve).await.unwrap();
    assert_eq!(chat.count_groups().await.unwrap(), 2);
    assert_eq!(list(None, 0, 20).await.1, 3);

    let mut found = chat
        .find_conversations(&[alpha.id, direct.id, ConversationId::new()])
        .await
        .unwrap();
    found.sort_by_key(|conversation| conversation.created_at);
    let ids: Vec<ConversationId> = found.iter().map(|conversation| conversation.id).collect();
    assert_eq!(ids, [alpha.id, direct.id]);
    assert!(found[0].dissolved);
    assert!(chat.find_conversations(&[]).await.unwrap().is_empty());
}

async fn seqs(stores: &Stores, conversation: ConversationId) -> Vec<i64> {
    let found = stores.chat.list_before(conversation, ALL, None, 100).await;
    found.unwrap().iter().map(|message| message.seq).collect()
}

async fn expired_messages_are_purged_from_the_start_of_each_conversation(stores: Stores) {
    let (a, b, c) = (
        user(&stores, "user_a").await,
        user(&stores, "user_b").await,
        user(&stores, "user_c").await,
    );
    let chat = &stores.chat;
    let old = NOW - 30 * DAY;
    let cutoff = NOW - 7 * DAY;
    let direct = |x: &User, y: &User| chat.open_direct(ConversationId::new(), x.id, y.id, old);

    // 第一个会话：两条旧的（其中一条带文件、被播放过），两条新的
    let first = direct(&a, &b).await.unwrap().id;
    let attachment = file(&stores, &a, FilePurpose::Attachment, 10).await;
    chat.append(&message(first, &a, "旧一", old)).await.unwrap();
    let voice = NewMessage {
        kind: MessageKind::Voice,
        text: None,
        file: Some(attachment.id),
        ..message(first, &a, "", old + 1)
    };
    let voice = chat.append(&voice).await.unwrap().message;
    chat.mark_played(voice.id, b.id, old + 2).await.unwrap();
    chat.append(&message(first, &b, "新一", NOW)).await.unwrap();
    chat.append(&message(first, &b, "新二", NOW)).await.unwrap();

    // 第二个会话：全是旧的
    let second = direct(&a, &c).await.unwrap().id;
    chat.append(&message(second, &a, "旧", old)).await.unwrap();
    chat.append(&message(second, &c, "也旧", cutoff - 1))
        .await
        .unwrap();

    // 第三个会话：没过期的后面跟着一条时间更早的（时钟被调过），它不删
    let third = direct(&b, &c).await.unwrap().id;
    chat.append(&message(third, &b, "旧", old)).await.unwrap();
    chat.append(&message(third, &b, "刚好没过期", cutoff))
        .await
        .unwrap();
    chat.append(&message(third, &c, "时间更早", old))
        .await
        .unwrap();

    let purged = chat.purge_before(cutoff).await.unwrap();
    assert_eq!(purged.messages, 5);
    assert_eq!(purged.files, [attachment.id]);
    assert_eq!(seqs(&stores, first).await, [3, 4]);
    assert!(seqs(&stores, second).await.is_empty());
    assert_eq!(seqs(&stores, third).await, [2, 3]);
    // 播放记录跟着消息一起删了
    assert!(chat.played(b.id, &[voice.id]).await.unwrap().is_empty());
    assert_eq!(chat.find_by_file(attachment.id).await.unwrap(), None);

    // 会话和成员都还在，序号接着往下排
    assert_eq!(chat.list_members(second).await.unwrap().len(), 2);
    let next = chat
        .append(&message(second, &a, "新的", NOW))
        .await
        .unwrap();
    assert_eq!(next.message.seq, 3);
    assert_eq!(seqs(&stores, second).await, [3]);

    // 再清一次没有可删的
    let again = chat.purge_before(cutoff).await.unwrap();
    assert_eq!((again.messages, again.files.len()), (0, 0));
}

on_both_databases!(audit, audit_entries_are_appended_and_read_newest_first);
on_both_databases!(
    token,
    a_token_is_consumed_once_for_its_own_purpose_before_it_expires
);
on_both_databases!(
    token_race,
    when_a_token_is_used_many_times_at_once_only_one_succeeds
);
on_both_databases!(users, users_are_listed_searched_and_counted);
on_both_databases!(no_admin, no_admin_is_found_before_one_exists);
on_both_databases!(usage, storage_usage_adds_up_every_file);
on_both_databases!(groups, every_group_is_listed_and_found_by_name);
on_both_databases!(
    purge,
    expired_messages_are_purged_from_the_start_of_each_conversation
);
