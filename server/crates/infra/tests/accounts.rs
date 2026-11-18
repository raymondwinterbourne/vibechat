//! 账号相关的数据操作，在 SQLite 和 Postgres 上各跑一遍。

mod common;

use vibechat_core::account::model::{
    FilePurpose, InviteCode, InviteCodeOrder, InviteCodeQuery, InviteCodeState, InviteCodeStatus,
    Language, ProfileChanges, Role, Session, StoredFile, Theme, User, UserStatus,
};
use vibechat_core::account::store::CreateUserError;
use vibechat_core::{FileId, InviteCodeId, SessionId, Stores, UserId};

const NOW: i64 = 1_700_000_000_000;

fn user(handle: &str) -> User {
    User {
        id: UserId::new(),
        handle: handle.to_owned(),
        nickname: "小明".to_owned(),
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
    }
}

fn invite(code: &str) -> InviteCode {
    InviteCode {
        id: InviteCodeId::new(),
        code: code.to_owned(),
        note: None,
        status: InviteCodeStatus::Unused,
        expires_at: None,
        created_by: UserId::new(),
        created_at: NOW,
        used_by: None,
        used_at: None,
    }
}

/// 不筛选、最新的在前的一段邀请码列表。
fn unfiltered(offset: u64, limit: u64) -> InviteCodeQuery {
    InviteCodeQuery {
        state: None,
        order: InviteCodeOrder::NewestFirst,
        offset,
        limit,
        now: NOW,
    }
}

/// 生成一个邀请码并用它创建用户。
async fn registered(stores: &Stores, handle: &str) -> User {
    let code = invite(&format!("CODE{:012}", rand_suffix()));
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();
    let user = user(handle);
    stores
        .users
        .create_with_invite(&user, code.id, NOW)
        .await
        .unwrap();
    user
}

fn rand_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn session(user: UserId, token_hash: &str) -> Session {
    Session {
        id: SessionId::new(),
        user_id: user,
        token_hash: token_hash.to_owned(),
        created_at: NOW,
        last_seen_at: NOW,
        expires_at: NOW + 1000,
        user_agent: "test".to_owned(),
        ip: Some("203.0.113.7".to_owned()),
    }
}

async fn a_created_user_is_found_by_id_and_by_handle_ignoring_case(stores: Stores) {
    let mut created = user("Xiao_Ming");
    created.email = Some("ming@example.com".to_owned());
    created.language = Some(Language::ZhCn);
    created.must_change_password = true;
    let code = invite("AAAABBBBCCCCDDDD");
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();
    stores
        .users
        .create_with_invite(&created, code.id, NOW)
        .await
        .unwrap();

    assert_eq!(
        stores.users.find(created.id).await.unwrap(),
        Some(created.clone())
    );
    for handle in ["Xiao_Ming", "xiao_ming", "XIAO_MING"] {
        assert_eq!(
            stores.users.find_by_handle(handle).await.unwrap(),
            Some(created.clone()),
            "{handle}"
        );
    }
    assert_eq!(
        stores.users.find_by_handle("someone_else").await.unwrap(),
        None
    );
    assert_eq!(stores.users.find(UserId::new()).await.unwrap(), None);
}

async fn creating_a_user_marks_the_invite_code_used(stores: Stores) {
    let code = invite("AAAABBBBCCCCDDDD");
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();
    let created = user("xiao_ming");
    stores
        .users
        .create_with_invite(&created, code.id, NOW + 5)
        .await
        .unwrap();

    let stored = stores
        .invite_codes
        .find_by_code("AAAABBBBCCCCDDDD")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, InviteCodeStatus::Used);
    assert_eq!(stored.used_by, Some(created.id));
    assert_eq!(stored.used_at, Some(NOW + 5));
}

async fn an_invite_code_can_only_be_used_once(stores: Stores) {
    let code = invite("AAAABBBBCCCCDDDD");
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();
    stores
        .users
        .create_with_invite(&user("first_user"), code.id, NOW)
        .await
        .unwrap();

    let err = stores
        .users
        .create_with_invite(&user("second_user"), code.id, NOW)
        .await
        .unwrap_err();
    assert!(matches!(err, CreateUserError::InviteCodeUnavailable));
    assert_eq!(
        stores.users.find_by_handle("second_user").await.unwrap(),
        None
    );
}

async fn when_many_register_with_one_code_at_once_exactly_one_succeeds(stores: Stores) {
    let code = invite("AAAABBBBCCCCDDDD");
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();

    let attempts: Vec<_> = (0..8)
        .map(|i| {
            let stores = stores.clone();
            let candidate = user(&format!("racer_{i}"));
            tokio::spawn(async move {
                let result = stores
                    .users
                    .create_with_invite(&candidate, code.id, NOW)
                    .await;
                (candidate.id, result)
            })
        })
        .collect();

    let mut winners = Vec::new();
    for attempt in attempts {
        let (id, result) = attempt.await.unwrap();
        match result {
            Ok(()) => winners.push(id),
            Err(CreateUserError::InviteCodeUnavailable) => {}
            Err(other) => panic!("unexpected error: {other:?}"),
        }
    }
    assert_eq!(winners.len(), 1, "exactly one registration wins");

    let stored = stores
        .invite_codes
        .find_by_code("AAAABBBBCCCCDDDD")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.used_by, Some(winners[0]));
    // 落败的人没有留下用户记录
    let mut created = 0;
    for i in 0..8 {
        if stores
            .users
            .find_by_handle(&format!("racer_{i}"))
            .await
            .unwrap()
            .is_some()
        {
            created += 1;
        }
    }
    assert_eq!(created, 1);
}

async fn an_expired_invite_code_cannot_be_used(stores: Stores) {
    let mut code = invite("AAAABBBBCCCCDDDD");
    code.expires_at = Some(NOW);
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();

    let err = stores
        .users
        .create_with_invite(&user("late_user"), code.id, NOW)
        .await
        .unwrap_err();
    assert!(matches!(err, CreateUserError::InviteCodeUnavailable));
    // 还没到期的时刻可以用
    assert!(
        stores
            .users
            .create_with_invite(&user("early_user"), code.id, NOW - 1)
            .await
            .is_ok()
    );
}

async fn a_taken_handle_is_refused_and_does_not_consume_the_code(stores: Stores) {
    registered(&stores, "Xiao_Ming").await;
    let code = invite("AAAABBBBCCCCDDDD");
    stores
        .invite_codes
        .create_many(std::slice::from_ref(&code))
        .await
        .unwrap();

    let err = stores
        .users
        .create_with_invite(&user("xiao_ming"), code.id, NOW)
        .await
        .unwrap_err();
    assert!(matches!(err, CreateUserError::HandleTaken));

    let stored = stores
        .invite_codes
        .find_by_code("AAAABBBBCCCCDDDD")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        stored.status,
        InviteCodeStatus::Unused,
        "rolled back together"
    );
    assert!(
        stores
            .users
            .create_with_invite(&user("other_name"), code.id, NOW)
            .await
            .is_ok()
    );
}

async fn the_admin_is_created_only_when_there_is_none(stores: Stores) {
    let mut admin = user("admin");
    admin.role = Role::Admin;
    assert!(stores.users.create_admin_if_none(&admin).await.unwrap());

    let mut another = user("admin2");
    another.role = Role::Admin;
    assert!(!stores.users.create_admin_if_none(&another).await.unwrap());
    assert_eq!(stores.users.find_by_handle("admin2").await.unwrap(), None);
    assert_eq!(
        stores
            .users
            .find_by_handle("admin")
            .await
            .unwrap()
            .unwrap()
            .role,
        Role::Admin
    );
}

async fn a_handle_can_be_changed_unless_someone_else_has_it(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let hong = registered(&stores, "xiao_hong").await;

    assert!(
        !stores.users.set_handle(hong.id, "Xiao_Ming").await.unwrap(),
        "taken, ignoring case"
    );
    assert_eq!(
        stores.users.find(hong.id).await.unwrap().unwrap().handle,
        "xiao_hong"
    );

    assert!(stores.users.set_handle(ming.id, "Ming_2026").await.unwrap());
    assert_eq!(
        stores
            .users
            .find_by_handle("ming_2026")
            .await
            .unwrap()
            .unwrap()
            .id,
        ming.id
    );
    assert_eq!(
        stores.users.find_by_handle("xiao_ming").await.unwrap(),
        None,
        "old one is free"
    );

    // 只改自己 ID 的大小写
    assert!(stores.users.set_handle(ming.id, "MING_2026").await.unwrap());
    assert_eq!(
        stores.users.find(ming.id).await.unwrap().unwrap().handle,
        "MING_2026"
    );
    // 别人现在可以用被放弃的那个
    assert!(stores.users.set_handle(hong.id, "xiao_ming").await.unwrap());
}

async fn profile_changes_touch_only_the_given_fields(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;

    stores
        .users
        .update_profile(
            ming.id,
            &ProfileChanges {
                signature: Some("今天也要加油".to_owned()),
                theme: Some(Theme::Dark),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let stored = stores.users.find(ming.id).await.unwrap().unwrap();
    assert_eq!(stored.nickname, "小明");
    assert_eq!(stored.signature, "今天也要加油");
    assert_eq!(stored.theme, Some(Theme::Dark));
    assert_eq!(stored.language, None);

    stores
        .users
        .update_profile(
            ming.id,
            &ProfileChanges {
                nickname: Some("明明".to_owned()),
                language: Some(Language::En),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let stored = stores.users.find(ming.id).await.unwrap().unwrap();
    assert_eq!(stored.nickname, "明明");
    assert_eq!(stored.signature, "今天也要加油");
    assert_eq!(stored.language, Some(Language::En));
    assert_eq!(stored.theme, Some(Theme::Dark));

    // 什么都不改也不出错
    stores
        .users
        .update_profile(ming.id, &ProfileChanges::default())
        .await
        .unwrap();
}

async fn password_avatar_and_login_time_are_stored(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let avatar = FileId::new();

    stores
        .users
        .set_password(ming.id, "new-hash", true)
        .await
        .unwrap();
    stores.users.set_avatar(ming.id, avatar).await.unwrap();
    stores.users.record_login(ming.id, NOW + 99).await.unwrap();

    let stored = stores.users.find(ming.id).await.unwrap().unwrap();
    assert_eq!(stored.password_hash, "new-hash");
    assert!(stored.must_change_password);
    assert_eq!(stored.avatar, Some(avatar));
    assert_eq!(stored.last_login_at, Some(NOW + 99));
}

async fn sessions_are_found_by_token_hash_extended_and_deleted(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let created = session(ming.id, "hash-a");
    stores.sessions.create(&created).await.unwrap();

    assert_eq!(
        stores.sessions.find_by_token_hash("hash-a").await.unwrap(),
        Some(created.clone())
    );
    assert_eq!(
        stores.sessions.find_by_token_hash("hash-x").await.unwrap(),
        None
    );

    stores
        .sessions
        .touch(created.id, NOW + 10, NOW + 2000)
        .await
        .unwrap();
    let touched = stores
        .sessions
        .find_by_token_hash("hash-a")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (touched.last_seen_at, touched.expires_at),
        (NOW + 10, NOW + 2000)
    );

    stores.sessions.delete(created.id).await.unwrap();
    assert_eq!(
        stores.sessions.find_by_token_hash("hash-a").await.unwrap(),
        None
    );
    // 重复删除不出错
    stores.sessions.delete(created.id).await.unwrap();
}

async fn deleting_other_sessions_keeps_the_given_one_and_other_users(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let hong = registered(&stores, "xiao_hong").await;
    let keep = session(ming.id, "ming-here");
    let other_a = session(ming.id, "ming-phone");
    let other_b = session(ming.id, "ming-laptop");
    let hongs = session(hong.id, "hong-here");
    for s in [&keep, &other_a, &other_b, &hongs] {
        stores.sessions.create(s).await.unwrap();
    }

    let mut ended = stores
        .sessions
        .delete_others(ming.id, Some(keep.id))
        .await
        .unwrap();
    ended.sort();
    let mut expected = vec![other_a.id, other_b.id];
    expected.sort();
    assert_eq!(ended, expected);

    assert!(
        stores
            .sessions
            .find_by_token_hash("ming-here")
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        stores
            .sessions
            .find_by_token_hash("ming-phone")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        stores
            .sessions
            .find_by_token_hash("hong-here")
            .await
            .unwrap()
            .is_some()
    );

    // 不保留任何一个：全部结束
    let ended = stores.sessions.delete_others(ming.id, None).await.unwrap();
    assert_eq!(ended, vec![keep.id]);
}

/// 登录设备（F9）：只列出他自己的、没有过期的，最近活跃的在前；网络地址读得回来，以前没记的为空；
/// 只删得掉他自己的。
async fn a_users_sessions_are_listed_and_signed_out_one_by_one(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let hong = registered(&stores, "xiao_hong").await;
    let mut laptop = session(ming.id, "ming-laptop");
    laptop.last_seen_at = NOW + 50;
    let mut phone = session(ming.id, "ming-phone");
    phone.ip = None;
    let mut expired = session(ming.id, "ming-old");
    expired.expires_at = NOW - 1;
    let hongs = session(hong.id, "hong-here");
    for s in [&laptop, &phone, &expired, &hongs] {
        stores.sessions.create(s).await.unwrap();
    }

    let listed = stores.sessions.list_for_user(ming.id, NOW).await.unwrap();
    assert_eq!(listed, [laptop.clone(), phone.clone()]);
    assert_eq!(listed[0].ip.as_deref(), Some("203.0.113.7"));

    // 别人的删不掉
    assert!(
        !stores
            .sessions
            .delete_for_user(hong.id, phone.id)
            .await
            .unwrap()
    );
    assert!(
        stores
            .sessions
            .delete_for_user(ming.id, phone.id)
            .await
            .unwrap()
    );
    assert!(
        !stores
            .sessions
            .delete_for_user(ming.id, phone.id)
            .await
            .unwrap()
    );
    let listed = stores.sessions.list_for_user(ming.id, NOW).await.unwrap();
    assert_eq!(listed, [laptop]);
    assert_eq!(
        stores.sessions.list_for_user(hong.id, NOW).await.unwrap(),
        [hongs]
    );
}

async fn invite_codes_are_listed_newest_first(stores: Stores) {
    let mut older = invite("OLDER00000000000");
    older.created_at = NOW;
    older.note = Some("给小明".to_owned());
    let mut newer = invite("NEWER00000000000");
    newer.created_at = NOW + 1;
    newer.expires_at = Some(NOW + 5000);
    stores
        .invite_codes
        .create_many(&[older.clone(), newer.clone()])
        .await
        .unwrap();
    stores.invite_codes.create_many(&[]).await.unwrap();

    assert_eq!(
        stores.invite_codes.list(&unfiltered(0, 100)).await.unwrap(),
        (vec![newer.clone(), older.clone()], 2)
    );
    // 一段一段地取，总数不变；取过头了是空的
    assert_eq!(
        stores.invite_codes.list(&unfiltered(0, 1)).await.unwrap(),
        (vec![newer], 2)
    );
    assert_eq!(
        stores.invite_codes.list(&unfiltered(1, 1)).await.unwrap(),
        (vec![older], 2)
    );
    assert_eq!(
        stores.invite_codes.list(&unfiltered(2, 1)).await.unwrap(),
        (vec![], 2)
    );
    assert_eq!(
        stores
            .invite_codes
            .find_by_code("NOSUCHCODE000000")
            .await
            .unwrap(),
        None
    );
}

async fn only_an_unused_invite_code_is_revoked(stores: Stores) {
    let unused = invite("UNUSED0000000000");
    let used = invite("USED000000000000");
    let second = invite("SECOND0000000000");
    let third = invite("THIRD00000000000");
    let untouched = invite("UNTOUCHED0000000");
    stores
        .invite_codes
        .create_many(&[
            unused.clone(),
            used.clone(),
            second.clone(),
            third.clone(),
            untouched.clone(),
        ])
        .await
        .unwrap();
    stores
        .users
        .create_with_invite(&user("xiao_ming"), used.id, NOW)
        .await
        .unwrap();

    assert_eq!(
        stores.invite_codes.find(unused.id).await.unwrap(),
        Some(unused.clone())
    );
    assert_eq!(
        stores.invite_codes.find(InviteCodeId::new()).await.unwrap(),
        None
    );

    assert_eq!(stores.invite_codes.revoke(&[unused.id]).await.unwrap(), 1);
    assert_eq!(
        stores
            .invite_codes
            .find(unused.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        InviteCodeStatus::Revoked
    );
    assert_eq!(
        stores.invite_codes.revoke(&[unused.id]).await.unwrap(),
        0,
        "already revoked"
    );

    assert_eq!(
        stores.invite_codes.revoke(&[used.id]).await.unwrap(),
        0,
        "already used"
    );
    assert_eq!(
        stores
            .invite_codes
            .find(used.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        InviteCodeStatus::Used
    );
    assert_eq!(
        stores
            .invite_codes
            .revoke(&[InviteCodeId::new()])
            .await
            .unwrap(),
        0,
        "does not exist"
    );

    // 一次作废多个：只算上其中还没有使用的，没有点到的不受影响
    let several = [unused.id, used.id, second.id, third.id, InviteCodeId::new()];
    assert_eq!(stores.invite_codes.revoke(&several).await.unwrap(), 2);
    for (id, expected) in [
        (second.id, InviteCodeStatus::Revoked),
        (third.id, InviteCodeStatus::Revoked),
        (used.id, InviteCodeStatus::Used),
        (untouched.id, InviteCodeStatus::Unused),
    ] {
        assert_eq!(
            stores.invite_codes.find(id).await.unwrap().unwrap().status,
            expected
        );
    }
    assert_eq!(stores.invite_codes.revoke(&[]).await.unwrap(), 0);

    // 作废之后不能再用来注册
    let err = stores
        .users
        .create_with_invite(&user("late_user"), unused.id, NOW)
        .await
        .unwrap_err();
    assert!(matches!(err, CreateUserError::InviteCodeUnavailable));
}

async fn invite_codes_are_filtered_and_ordered(stores: Stores) {
    // 生成时间依次增加：长期有效、已使用、已作废、已过期、还没到期、过了有效期但已经使用
    let mut codes: Vec<InviteCode> = [
        "FOREVER000000000",
        "USED000000000000",
        "REVOKED000000000",
        "EXPIRED000000000",
        "NOTYET0000000000",
        "USEDEXPIRED00000",
    ]
    .iter()
    .zip(0..)
    .map(|(code, age)| {
        let mut invite = invite(code);
        invite.created_at = NOW - 100 + age;
        invite
    })
    .collect();
    codes[3].expires_at = Some(NOW);
    codes[4].expires_at = Some(NOW + 1);
    codes[5].expires_at = Some(NOW);
    stores.invite_codes.create_many(&codes).await.unwrap();
    for (index, handle) in [(1, "xiao_ming"), (5, "xiao_hong")] {
        stores
            .users
            .create_with_invite(&user(handle), codes[index].id, NOW - 1)
            .await
            .unwrap();
    }
    stores.invite_codes.revoke(&[codes[2].id]).await.unwrap();

    let list = |state, order, now| {
        let stores = &stores;
        let codes = &codes;
        async move {
            let query = InviteCodeQuery {
                state,
                order,
                offset: 0,
                limit: 100,
                now,
            };
            let (found, total) = stores.invite_codes.list(&query).await.unwrap();
            assert_eq!(total, found.len() as u64);
            // 换成它们在 codes 里的位置，方便比较
            found
                .iter()
                .map(|invite| codes.iter().position(|c| c.id == invite.id).unwrap())
                .collect::<Vec<_>>()
        }
    };
    use InviteCodeOrder::{NewestFirst, OldestFirst};
    use InviteCodeState::{Expired, Revoked, Unused, Used};

    assert_eq!(list(None, NewestFirst, NOW).await, [5, 4, 3, 2, 1, 0]);
    assert_eq!(list(None, OldestFirst, NOW).await, [0, 1, 2, 3, 4, 5]);
    assert_eq!(list(Some(Unused), NewestFirst, NOW).await, [4, 0]);
    assert_eq!(list(Some(Unused), OldestFirst, NOW).await, [0, 4]);
    // 已经使用的不算过期，哪怕过了有效期
    assert_eq!(list(Some(Used), NewestFirst, NOW).await, [5, 1]);
    assert_eq!(list(Some(Expired), NewestFirst, NOW).await, [3]);
    assert_eq!(list(Some(Revoked), NewestFirst, NOW).await, [2]);
    // 时间再往后一点：还没到期的那个也过期了
    assert_eq!(list(Some(Unused), NewestFirst, NOW + 1).await, [0]);
    assert_eq!(list(Some(Expired), OldestFirst, NOW + 1).await, [3, 4]);

    // 筛选之后再取一段：总数是符合条件的数量
    let query = InviteCodeQuery {
        state: Some(Used),
        order: OldestFirst,
        offset: 1,
        limit: 1,
        now: NOW,
    };
    let (found, total) = stores.invite_codes.list(&query).await.unwrap();
    assert_eq!((found.len(), total), (1, 2));
    assert_eq!(found[0].id, codes[5].id);
}

async fn only_dead_invite_codes_are_deleted(stores: Stores) {
    let usable = invite("USABLE0000000000");
    let used = invite("USED000000000000");
    let revoked = invite("REVOKED000000000");
    let mut expired = invite("EXPIRED000000000");
    expired.expires_at = Some(NOW);
    let mut not_yet = invite("NOTYET0000000000");
    not_yet.expires_at = Some(NOW + 1);
    let mut used_then_expired = invite("USEDEXPIRED00000");
    used_then_expired.expires_at = Some(NOW);
    let untouched = invite("UNTOUCHED0000000");
    let mut untouched_revoked = untouched.clone();
    untouched_revoked.status = InviteCodeStatus::Revoked;
    let all = [
        &usable,
        &used,
        &revoked,
        &expired,
        &not_yet,
        &used_then_expired,
    ];
    stores
        .invite_codes
        .create_many(&[
            usable.clone(),
            used.clone(),
            revoked.clone(),
            expired.clone(),
            not_yet.clone(),
            used_then_expired.clone(),
            untouched.clone(),
        ])
        .await
        .unwrap();
    stores
        .users
        .create_with_invite(&user("xiao_ming"), used.id, NOW - 1)
        .await
        .unwrap();
    stores
        .users
        .create_with_invite(&user("xiao_hong"), used_then_expired.id, NOW - 1)
        .await
        .unwrap();
    stores
        .invite_codes
        .revoke(&[revoked.id, untouched.id])
        .await
        .unwrap();

    // 已作废的和已过期的被删除；还能用的、还没到期的、已经使用的（哪怕过了有效期）都留着
    let mut ids: Vec<InviteCodeId> = all.iter().map(|invite| invite.id).collect();
    ids.push(InviteCodeId::new());
    assert_eq!(stores.invite_codes.delete_dead(&ids, NOW).await.unwrap(), 2);
    for (invite, kept) in [
        (&usable, true),
        (&used, true),
        (&revoked, false),
        (&expired, false),
        (&not_yet, true),
        (&used_then_expired, true),
    ] {
        assert_eq!(
            stores.invite_codes.find(invite.id).await.unwrap().is_some(),
            kept,
            "{}",
            invite.code
        );
    }
    // 没有点到的不受影响，哪怕它已经作废
    assert_eq!(
        stores.invite_codes.find(untouched.id).await.unwrap(),
        Some(untouched_revoked)
    );

    assert_eq!(stores.invite_codes.delete_dead(&ids, NOW).await.unwrap(), 0);
    assert_eq!(stores.invite_codes.delete_dead(&[], NOW).await.unwrap(), 0);
    // 到期之后可以删除了
    assert_eq!(
        stores
            .invite_codes
            .delete_dead(&ids, NOW + 1)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        stores
            .invite_codes
            .list(&unfiltered(0, 100))
            .await
            .unwrap()
            .1,
        4
    );
}

async fn file_records_are_stored(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let file = StoredFile {
        id: FileId::new(),
        storage_key: "avatar/x/y".to_owned(),
        content_type: "image/jpeg".to_owned(),
        size: 12345,
        uploader: ming.id,
        purpose: FilePurpose::Avatar,
        width: Some(512),
        height: Some(384),
        name: None,
        thumbnail_key: None,
        created_at: NOW,
    };
    stores.files.create(&file).await.unwrap();

    assert_eq!(stores.files.find(file.id).await.unwrap(), Some(file));
    assert_eq!(stores.files.find(FileId::new()).await.unwrap(), None);
}

async fn files_sharing_one_content_are_counted_once(stores: Stores) {
    let ming = registered(&stores, "xiao_ming").await;
    let original = StoredFile {
        id: FileId::new(),
        storage_key: "attachment/a/b".to_owned(),
        content_type: "application/pdf".to_owned(),
        size: 1000,
        uploader: ming.id,
        purpose: FilePurpose::Attachment,
        width: None,
        height: None,
        name: Some("路线.pdf".to_owned()),
        thumbnail_key: None,
        created_at: NOW,
    };
    // 转发出来的：新的一行，同一份内容
    let copy = StoredFile {
        id: FileId::new(),
        ..original.clone()
    };
    let other = StoredFile {
        id: FileId::new(),
        storage_key: "attachment/c/d".to_owned(),
        size: 10,
        ..original.clone()
    };
    for file in [&original, &copy, &other] {
        stores.files.create(file).await.unwrap();
    }

    assert_eq!(
        stores.files.count_sharing("attachment/a/b").await.unwrap(),
        2
    );
    assert_eq!(
        stores.files.count_sharing("attachment/x/y").await.unwrap(),
        0
    );
    // 存储占用：共用的内容只算一次
    assert_eq!(stores.files.usage().await.unwrap(), (2, 1010));

    stores.files.delete(original.id).await.unwrap();
    assert_eq!(
        stores.files.count_sharing("attachment/a/b").await.unwrap(),
        1
    );
    assert_eq!(stores.files.find(copy.id).await.unwrap(), Some(copy));
}

on_both_databases!(shared_files, files_sharing_one_content_are_counted_once);
on_both_databases!(
    list_sessions,
    a_users_sessions_are_listed_and_signed_out_one_by_one
);
on_both_databases!(
    find_user,
    a_created_user_is_found_by_id_and_by_handle_ignoring_case
);
on_both_databases!(
    invite_marked_used,
    creating_a_user_marks_the_invite_code_used
);
on_both_databases!(invite_used_once, an_invite_code_can_only_be_used_once);
on_both_databases!(
    invite_race,
    when_many_register_with_one_code_at_once_exactly_one_succeeds
);
on_both_databases!(invite_expired, an_expired_invite_code_cannot_be_used);
on_both_databases!(
    handle_taken_on_create,
    a_taken_handle_is_refused_and_does_not_consume_the_code
);
on_both_databases!(admin_once, the_admin_is_created_only_when_there_is_none);
on_both_databases!(
    change_handle,
    a_handle_can_be_changed_unless_someone_else_has_it
);
on_both_databases!(profile, profile_changes_touch_only_the_given_fields);
on_both_databases!(
    password_avatar_login,
    password_avatar_and_login_time_are_stored
);
on_both_databases!(
    sessions,
    sessions_are_found_by_token_hash_extended_and_deleted
);
on_both_databases!(
    delete_other_sessions,
    deleting_other_sessions_keeps_the_given_one_and_other_users
);
on_both_databases!(invite_list, invite_codes_are_listed_newest_first);
on_both_databases!(invite_filter, invite_codes_are_filtered_and_ordered);
on_both_databases!(invite_revoke, only_an_unused_invite_code_is_revoked);
on_both_databases!(invite_delete, only_dead_invite_codes_are_deleted);
on_both_databases!(files, file_records_are_stored);
