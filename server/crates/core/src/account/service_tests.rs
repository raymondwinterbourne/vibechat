//! 账号业务流程的测试。数据在内存里，时间可以拨动，不需要数据库。

use std::sync::Arc;

use super::guard::LOCK_MS;
use super::model::{
    InviteCode, InviteCodeOrder, InviteCodeState, InviteCodeStatus, Language, ProfileChanges, Role,
    Theme, User, UserStatus,
};
use super::service::{
    AVATAR_MAX_BYTES, INVITE_CODES_PAGE_SIZE_MAX, MAX_INVITE_CODES_PER_BATCH, SESSION_TTL_MS,
};
use super::{
    AccountError, AccountService, AuthContext, InviteCodeListing, Limits, LoginOutcome,
    NewInviteCodes, Registration,
};
use crate::clock::Clock;
use crate::ids::{FileId, UserId};
use crate::testing::{ManualClock, MemoryStore, account_service};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const PASSWORD: &str = "correct-horse-1";

/// 邀请码列表的第几页、每页几个；不筛选，最新的在前。
fn paged(page: u32, page_size: u32) -> InviteCodeListing {
    InviteCodeListing {
        page,
        page_size,
        ..InviteCodeListing::default()
    }
}

/// 生成邀请码的参数：只指定数量，没有备注，长期有效。
fn codes(count: u32) -> NewInviteCodes<'static> {
    NewInviteCodes {
        count,
        note: None,
        expires_in_days: None,
    }
}

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    service: AccountService,
}

async fn fixture_with(limits: Limits) -> Fixture {
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let service = account_service(&store, clock.clone(), limits).await;
    Fixture {
        store,
        clock,
        service,
    }
}

async fn fixture() -> Fixture {
    // 限速放得很宽，只有专门测限速的用例才会碰到
    fixture_with(Limits {
        logins_per_minute: 1000,
        registrations_per_minute: 1000,
    })
    .await
}

impl Fixture {
    /// 全部邀请码（测试里的数量不会超过一页），最新的在前。
    async fn invite_codes(&self) -> Vec<(InviteCode, Option<User>)> {
        self.service
            .list_invite_codes(InviteCodeListing {
                page_size: INVITE_CODES_PAGE_SIZE_MAX,
                ..InviteCodeListing::default()
            })
            .await
            .unwrap()
            .entries
    }

    /// 放一个新的邀请码并用它注册一个用户。
    async fn user(&self, code: &str) -> LoginOutcome {
        self.store.add_invite_code(code, UserId::new());
        self.register(code, "小明", PASSWORD).await.unwrap()
    }

    async fn register(
        &self,
        code: &str,
        nickname: &str,
        password: &str,
    ) -> Result<LoginOutcome, AccountError> {
        self.service
            .register(Registration {
                invite_code: code,
                nickname,
                password,
                user_agent: "test",
                source: "10.0.0.1",
            })
            .await
    }

    async fn login(&self, handle: &str, password: &str) -> Result<LoginOutcome, AccountError> {
        self.service
            .login(handle, password, "test", "10.0.0.1")
            .await
    }

    async fn auth(&self, token: &str) -> Option<AuthContext> {
        self.service.authenticate(token).await.unwrap()
    }
}

// ---------- 注册 ----------

#[tokio::test]
async fn registering_with_a_valid_code_creates_a_user_and_logs_in() {
    let f = fixture().await;
    f.store.add_invite_code("AAAABBBBCCCCDDDD", UserId::new());

    let outcome = f
        .register("AAAABBBBCCCCDDDD", "  小明 ", PASSWORD)
        .await
        .unwrap();

    assert!(outcome.user.handle.starts_with("vc"));
    assert_eq!(outcome.user.handle.len(), 10);
    assert_eq!(outcome.user.nickname, "小明", "nickname is trimmed");
    assert_eq!(outcome.user.role, Role::User);
    assert!(!outcome.user.must_change_password);
    assert_ne!(outcome.user.password_hash, PASSWORD);

    let auth = f.auth(&outcome.token).await.expect("token is valid");
    assert_eq!(auth.user.id, outcome.user.id);
}

#[tokio::test]
async fn a_used_code_cannot_be_used_again() {
    let f = fixture().await;
    f.user("AAAABBBBCCCCDDDD").await;

    let err = f
        .register("AAAABBBBCCCCDDDD", "小红", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeUsed));
}

#[tokio::test]
async fn the_code_is_accepted_in_lowercase_and_with_separators() {
    let f = fixture().await;
    f.store.add_invite_code("AAAABBBBCCCCDDDD", UserId::new());
    assert!(
        f.register("aaaa-bbbb cccc-dddd", "小明", PASSWORD)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn unknown_revoked_and_expired_codes_are_rejected_with_their_reason() {
    let f = fixture().await;
    let err = f
        .register("NOSUCHCODE000000", "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeNotFound));

    f.store.add_invite_code("REVOKED000000000", UserId::new());
    f.store
        .edit_invite_code("REVOKED000000000", |c| c.status = InviteCodeStatus::Revoked);
    let err = f
        .register("REVOKED000000000", "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeRevoked));

    f.store.add_invite_code("EXPIRED000000000", UserId::new());
    let now = f.clock.now_ms();
    f.store
        .edit_invite_code("EXPIRED000000000", |c| c.expires_at = Some(now));
    let err = f
        .register("EXPIRED000000000", "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeExpired));
}

#[tokio::test]
async fn a_rejected_registration_does_not_consume_the_code() {
    let f = fixture().await;
    f.store.add_invite_code("AAAABBBBCCCCDDDD", UserId::new());

    let err = f
        .register("AAAABBBBCCCCDDDD", "小明", "short1")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::PasswordTooWeak));
    let err = f
        .register("AAAABBBBCCCCDDDD", "   ", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::NicknameInvalid));

    assert!(
        f.register("AAAABBBBCCCCDDDD", "小明", PASSWORD)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn registrations_from_one_source_are_rate_limited() {
    let f = fixture_with(Limits {
        logins_per_minute: 1000,
        registrations_per_minute: 2,
    })
    .await;
    for _ in 0..2 {
        let err = f
            .register("NOSUCHCODE000000", "小明", PASSWORD)
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::InviteCodeNotFound));
    }
    let err = f
        .register("NOSUCHCODE000000", "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        AccountError::RateLimited {
            retry_after_secs: 60
        }
    ));

    f.clock.advance(60_000);
    let err = f
        .register("NOSUCHCODE000000", "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeNotFound));
}

// ---------- 登录 ----------

#[tokio::test]
async fn login_works_with_the_right_password_and_ignores_the_case_of_the_id() {
    let f = fixture().await;
    let user = f.user("AAAABBBBCCCCDDDD").await.user;
    f.clock.advance(5000);

    let outcome = f
        .login(&user.handle.to_uppercase(), PASSWORD)
        .await
        .unwrap();
    assert_eq!(outcome.user.id, user.id);
    assert!(f.auth(&outcome.token).await.is_some());

    let reloaded = f.auth(&outcome.token).await.unwrap().user;
    assert_eq!(reloaded.last_login_at, Some(f.clock.now_ms()));
}

/// 登录设备（F9）：记下登录时的地址；本机排第一；本机不能在这里下线，别人的、没有的找不到。
#[tokio::test]
async fn my_logins_are_listed_with_this_one_first_and_others_can_be_signed_out() {
    let f = fixture().await;
    let user = f.user("AAAABBBBCCCCDDDD").await.user;
    let first = f.login(&user.handle, PASSWORD).await.unwrap();
    f.clock.advance(5000);
    let second = f.login(&user.handle, PASSWORD).await.unwrap();
    let here = f.auth(&first.token).await.unwrap();

    let listed = f.service.sessions(&here).await.unwrap();
    assert_eq!(listed[0].id, here.session.id);
    assert_eq!(listed[0].ip.as_deref(), Some("10.0.0.1"));
    assert!(listed.iter().any(|session| session.id == second.session.id));

    let err = f.service.sign_out_session(&here, here.session.id).await;
    assert!(matches!(err, Err(AccountError::Invalid(_))));
    f.service
        .sign_out_session(&here, second.session.id)
        .await
        .unwrap();
    assert!(f.auth(&second.token).await.is_none());
    let err = f.service.sign_out_session(&here, second.session.id).await;
    assert!(matches!(err, Err(AccountError::NotFound)));
}

#[tokio::test]
async fn wrong_password_and_unknown_id_give_the_same_error() {
    let f = fixture().await;
    let user = f.user("AAAABBBBCCCCDDDD").await.user;

    let wrong_password = f
        .login(&user.handle, "not-the-password-1")
        .await
        .unwrap_err();
    let unknown_id = f.login("nobody_here", PASSWORD).await.unwrap_err();
    assert!(matches!(wrong_password, AccountError::InvalidCredentials));
    assert!(matches!(unknown_id, AccountError::InvalidCredentials));
}

#[tokio::test]
async fn five_wrong_passwords_lock_the_id_even_for_the_right_password() {
    let f = fixture().await;
    let user = f.user("AAAABBBBCCCCDDDD").await.user;

    for _ in 0..5 {
        let err = f.login(&user.handle, "wrong-password-1").await.unwrap_err();
        assert!(matches!(err, AccountError::InvalidCredentials));
    }
    let err = f.login(&user.handle, PASSWORD).await.unwrap_err();
    assert!(matches!(
        err,
        AccountError::Locked {
            retry_after_secs: 900
        }
    ));

    // 快到 15 分钟时仍然锁着，并且如实报告还要等多久
    f.clock.advance(LOCK_MS - 500);
    let err = f.login(&user.handle, PASSWORD).await.unwrap_err();
    assert!(matches!(
        err,
        AccountError::Locked {
            retry_after_secs: 1
        }
    ));

    f.clock.advance(500);
    assert!(f.login(&user.handle, PASSWORD).await.is_ok());
}

#[tokio::test]
async fn an_id_that_does_not_exist_is_locked_the_same_way() {
    let f = fixture().await;
    for _ in 0..5 {
        f.login("nobody_here", PASSWORD).await.unwrap_err();
    }
    let err = f.login("Nobody_Here", PASSWORD).await.unwrap_err();
    assert!(matches!(err, AccountError::Locked { .. }));
}

#[tokio::test]
async fn a_successful_login_resets_the_failure_count() {
    let f = fixture().await;
    let user = f.user("AAAABBBBCCCCDDDD").await.user;

    for _ in 0..4 {
        f.login(&user.handle, "wrong-password-1").await.unwrap_err();
    }
    f.login(&user.handle, PASSWORD).await.unwrap();
    for _ in 0..4 {
        f.login(&user.handle, "wrong-password-1").await.unwrap_err();
    }
    assert!(f.login(&user.handle, PASSWORD).await.is_ok());
}

#[tokio::test]
async fn a_disabled_user_cannot_log_in_and_existing_logins_stop_working() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    f.store
        .edit_user(outcome.user.id, |user| user.status = UserStatus::Disabled);

    let err = f.login(&outcome.user.handle, PASSWORD).await.unwrap_err();
    assert!(matches!(err, AccountError::Disabled));
    // 密码不对的人不会得知账号被禁用
    let err = f
        .login(&outcome.user.handle, "wrong-password-1")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InvalidCredentials));

    assert!(f.auth(&outcome.token).await.is_none());
}

#[tokio::test]
async fn logins_from_one_source_are_rate_limited() {
    let f = fixture_with(Limits {
        logins_per_minute: 3,
        registrations_per_minute: 1000,
    })
    .await;
    for i in 0..3 {
        // 用不同的 ID，避免触发按 ID 的锁定
        let err = f.login(&format!("nobody_{i}"), PASSWORD).await.unwrap_err();
        assert!(matches!(err, AccountError::InvalidCredentials));
    }
    let err = f.login("nobody_9", PASSWORD).await.unwrap_err();
    assert!(matches!(err, AccountError::RateLimited { .. }));
}

// ---------- 登录会话 ----------

#[tokio::test]
async fn an_unknown_token_is_not_authenticated() {
    let f = fixture().await;
    assert!(f.auth("not-a-real-token").await.is_none());
}

#[tokio::test]
async fn a_login_expires_after_thirty_days_without_use() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;

    f.clock.advance(SESSION_TTL_MS - 1);
    // 不调用 authenticate：这段时间里没有使用过
    f.clock.advance(1);
    assert!(f.auth(&outcome.token).await.is_none());
    assert_eq!(f.store.session_count(outcome.user.id), 0);
}

#[tokio::test]
async fn using_a_login_extends_it() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;

    f.clock.advance(29 * DAY_MS);
    assert!(f.auth(&outcome.token).await.is_some());
    f.clock.advance(29 * DAY_MS);
    assert!(
        f.auth(&outcome.token).await.is_some(),
        "58 days after login, but used on day 29"
    );
}

#[tokio::test]
async fn logging_out_ends_only_that_login() {
    let f = fixture().await;
    let first = f.user("AAAABBBBCCCCDDDD").await;
    let second = f.login(&first.user.handle, PASSWORD).await.unwrap();

    f.service.logout(first.session.id).await.unwrap();
    assert!(f.auth(&first.token).await.is_none());
    assert!(f.auth(&second.token).await.is_some());
}

// ---------- 修改密码 ----------

#[tokio::test]
async fn changing_the_password_ends_every_other_login() {
    let f = fixture().await;
    let here = f.user("AAAABBBBCCCCDDDD").await;
    let elsewhere = f.login(&here.user.handle, PASSWORD).await.unwrap();
    let auth = f.auth(&here.token).await.unwrap();

    let ended = f
        .service
        .change_password(&auth, PASSWORD, "brand-new-pass-2")
        .await
        .unwrap();

    assert_eq!(ended, vec![elsewhere.session.id]);
    assert!(f.auth(&here.token).await.is_some(), "this login stays");
    assert!(f.auth(&elsewhere.token).await.is_none());

    let err = f.login(&here.user.handle, PASSWORD).await.unwrap_err();
    assert!(matches!(err, AccountError::InvalidCredentials));
    assert!(f.login(&here.user.handle, "brand-new-pass-2").await.is_ok());
}

#[tokio::test]
async fn changing_the_password_is_refused_for_each_bad_input() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    // 系统分配的 ID 是随机的，不一定含数字；换成一个固定的、本身够得上密码强度的 ID，
    // 才能确定地测到"密码不能与 ID 相同"
    let auth = f.auth(&outcome.token).await.unwrap();
    f.service
        .change_handle(&auth, "Xiao_Ming2026")
        .await
        .unwrap();
    let auth = f.auth(&outcome.token).await.unwrap();
    let handle = auth.user.handle.clone();

    type Expected = fn(&AccountError) -> bool;
    let cases: [(&str, &str, Expected); 4] = [
        ("wrong-current-1", "brand-new-pass-2", |e| {
            matches!(e, AccountError::PasswordIncorrect)
        }),
        (PASSWORD, PASSWORD, |e| {
            matches!(e, AccountError::PasswordUnchanged)
        }),
        (PASSWORD, "short1", |e| {
            matches!(e, AccountError::PasswordTooWeak)
        }),
        (PASSWORD, "xiao_ming2026", |e| {
            matches!(e, AccountError::PasswordSameAsHandle)
        }),
    ];
    for (current, new, expected) in cases {
        let err = f
            .service
            .change_password(&auth, current, new)
            .await
            .unwrap_err();
        assert!(expected(&err), "{current} -> {new} gave {err:?}");
    }
    assert!(
        f.login(&handle, PASSWORD).await.is_ok(),
        "password unchanged"
    );
}

#[tokio::test]
async fn changing_the_password_clears_the_must_change_flag() {
    let f = fixture().await;
    f.service
        .bootstrap_admin("admin@example.com", "initial-pass-1")
        .await
        .unwrap();
    let outcome = f.login("admin", "initial-pass-1").await.unwrap();
    assert!(outcome.user.must_change_password);

    let auth = f.auth(&outcome.token).await.unwrap();
    f.service
        .change_password(&auth, "initial-pass-1", "brand-new-pass-2")
        .await
        .unwrap();
    assert!(
        !f.auth(&outcome.token)
            .await
            .unwrap()
            .user
            .must_change_password
    );
}

// ---------- 修改 ID ----------

#[tokio::test]
async fn after_changing_the_id_the_new_one_logs_in_and_the_old_one_does_not() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();
    let old = auth.user.handle.clone();

    let user = f.service.change_handle(&auth, " Xiao_Ming ").await.unwrap();
    assert_eq!(user.handle, "Xiao_Ming");

    assert!(f.login("xiao_ming", PASSWORD).await.is_ok());
    let err = f.login(&old, PASSWORD).await.unwrap_err();
    assert!(matches!(err, AccountError::InvalidCredentials));
}

#[tokio::test]
async fn an_id_must_follow_the_rules_and_be_unique_ignoring_case() {
    let f = fixture().await;
    let first = f.user("AAAABBBBCCCCDDDD").await;
    let second = f.user("EEEEFFFFGGGGHHHH").await;
    let first_auth = f.auth(&first.token).await.unwrap();
    let second_auth = f.auth(&second.token).await.unwrap();

    let err = f
        .service
        .change_handle(&first_auth, "ab")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::HandleInvalid));
    let err = f
        .service
        .change_handle(&first_auth, "admin")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::HandleInvalid));

    f.service
        .change_handle(&first_auth, "Xiao_Ming")
        .await
        .unwrap();
    let err = f
        .service
        .change_handle(&second_auth, "xiao_ming")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::HandleTaken));

    // 只改自己 ID 的大小写是允许的
    let first_auth = f.auth(&first.token).await.unwrap();
    let user = f
        .service
        .change_handle(&first_auth, "xiao_ming")
        .await
        .unwrap();
    assert_eq!(user.handle, "xiao_ming");
}

// ---------- 个人资料 ----------

#[tokio::test]
async fn profile_fields_can_be_changed_independently() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();

    let user = f
        .service
        .update_profile(
            &auth,
            ProfileChanges {
                signature: Some("  今天也要加油  ".to_owned()),
                language: Some(Language::En),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(user.nickname, "小明", "untouched");
    assert_eq!(user.signature, "今天也要加油");
    assert_eq!(user.language, Some(Language::En));
    assert_eq!(user.theme, None);

    let user = f
        .service
        .update_profile(
            &auth,
            ProfileChanges {
                nickname: Some("明明".to_owned()),
                theme: Some(Theme::Dark),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(user.nickname, "明明");
    assert_eq!(user.signature, "今天也要加油", "untouched");
    assert_eq!(user.language, Some(Language::En), "untouched");
    assert_eq!(user.theme, Some(Theme::Dark));
}

#[tokio::test]
async fn nickname_and_signature_have_length_limits() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();

    let change = |nickname: Option<String>, signature: Option<String>| ProfileChanges {
        nickname,
        signature,
        ..Default::default()
    };

    let err = f
        .service
        .update_profile(&auth, change(Some("名".repeat(33)), None))
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::NicknameInvalid));
    assert!(
        f.service
            .update_profile(&auth, change(Some("名".repeat(32)), None))
            .await
            .is_ok()
    );

    let err = f
        .service
        .update_profile(&auth, change(None, Some("签".repeat(101))))
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::SignatureTooLong));
    // 个性签名可以清空
    let user = f
        .service
        .update_profile(&auth, change(None, Some(String::new())))
        .await
        .unwrap();
    assert_eq!(user.signature, "");
}

// ---------- 头像 ----------

#[tokio::test]
async fn an_uploaded_avatar_can_be_read_back() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();

    let user = f.service.set_avatar(&auth, b"IMG-first").await.unwrap();
    let first = user.avatar.expect("avatar is set");
    let (file, content) = f.service.read_file(&auth, first).await.unwrap();
    assert_eq!(content, b"IMG-first");
    assert_eq!(file.content_type, "image/png");
    assert!(
        file.storage_key.starts_with("avatar/"),
        "path is generated by the server"
    );

    // 换一张：得到新的文件编号
    let user = f.service.set_avatar(&auth, b"IMG-second").await.unwrap();
    assert_ne!(user.avatar, Some(first));
}

#[tokio::test]
async fn a_file_that_is_not_an_image_or_is_too_large_is_refused() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();

    let err = f.service.set_avatar(&auth, b"#!/bin/sh").await.unwrap_err();
    assert!(matches!(err, AccountError::ImageUnsupported));

    let mut huge = b"IMG".to_vec();
    huge.resize(AVATAR_MAX_BYTES + 1, 0);
    let err = f.service.set_avatar(&auth, &huge).await.unwrap_err();
    assert!(matches!(err, AccountError::FileTooLarge));

    assert_eq!(f.auth(&outcome.token).await.unwrap().user.avatar, None);
}

#[tokio::test]
async fn reading_a_file_that_does_not_exist_is_not_found() {
    let f = fixture().await;
    let outcome = f.user("AAAABBBBCCCCDDDD").await;
    let auth = f.auth(&outcome.token).await.unwrap();

    let err = f.service.read_file(&auth, FileId::new()).await.unwrap_err();
    assert!(matches!(err, AccountError::NotFound));
}

// ---------- 邀请码 ----------

#[tokio::test]
async fn generated_codes_are_sixteen_unambiguous_characters_and_all_different() {
    let f = fixture().await;
    let codes = f
        .service
        .create_invite_codes(UserId::new(), codes(20))
        .await
        .unwrap();

    assert_eq!(codes.len(), 20);
    for invite in &codes {
        assert_eq!(invite.code.len(), 16);
        assert!(
            invite
                .code
                .chars()
                .all(|c| "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(c))
        );
        assert_eq!(invite.status, InviteCodeStatus::Unused);
    }
    let mut distinct: Vec<&str> = codes.iter().map(|invite| invite.code.as_str()).collect();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(distinct.len(), 20);

    assert!(f.register(&codes[0].code, "小明", PASSWORD).await.is_ok());
}

#[tokio::test]
async fn the_number_of_codes_per_request_is_bounded() {
    let f = fixture().await;
    for count in [0, 21] {
        let err = f
            .service
            .create_invite_codes(UserId::new(), codes(count))
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::Invalid(_)));
    }
}

#[tokio::test]
async fn the_list_shows_who_used_each_code_newest_first() {
    let f = fixture().await;
    let admin = UserId::new();
    let older = f
        .service
        .create_invite_codes(admin, codes(1))
        .await
        .unwrap();
    f.clock.advance(1000);
    let newer = f
        .service
        .create_invite_codes(admin, codes(1))
        .await
        .unwrap();
    let user = f
        .register(&older[0].code, "小明", PASSWORD)
        .await
        .unwrap()
        .user;

    let list = f.invite_codes().await;
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].0.code, newer[0].code);
    assert_eq!(list[0].0.status, InviteCodeStatus::Unused);
    assert!(list[0].1.is_none());
    assert_eq!(list[1].0.code, older[0].code);
    assert_eq!(list[1].0.status, InviteCodeStatus::Used);
    assert_eq!(list[1].1.as_ref().map(|u| u.id), Some(user.id));
}

#[tokio::test]
async fn codes_can_carry_a_note_and_an_expiry() {
    let f = fixture().await;
    let now = f.clock.now_ms();
    let created = f
        .service
        .create_invite_codes(
            UserId::new(),
            NewInviteCodes {
                count: 2,
                note: Some("  给新同事  "),
                expires_in_days: Some(7),
            },
        )
        .await
        .unwrap();

    for invite in &created {
        assert_eq!(invite.note.as_deref(), Some("给新同事"), "note is trimmed");
        assert_eq!(invite.expires_at, Some(now + 7 * DAY_MS));
    }

    // 到期之前可以用，到期之后不行
    f.clock.advance(7 * DAY_MS - 1);
    assert!(f.register(&created[0].code, "小明", PASSWORD).await.is_ok());
    f.clock.advance(1);
    let err = f
        .register(&created[1].code, "小红", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeExpired));
}

#[tokio::test]
async fn a_blank_note_is_stored_as_no_note_and_bad_input_is_refused() {
    let f = fixture().await;
    let with = |note: Option<&'static str>, expires_in_days: Option<u32>| NewInviteCodes {
        count: 1,
        note,
        expires_in_days,
    };

    let created = f
        .service
        .create_invite_codes(UserId::new(), with(Some("   "), None))
        .await
        .unwrap();
    assert_eq!(created[0].note, None);
    assert_eq!(created[0].expires_at, None);

    let long: &'static str = Box::leak("注".repeat(101).into_boxed_str());
    for bad in [
        with(Some(long), None),
        with(None, Some(0)),
        with(None, Some(366)),
    ] {
        let err = f
            .service
            .create_invite_codes(UserId::new(), bad)
            .await
            .unwrap_err();
        assert!(matches!(err, AccountError::Invalid(_)));
    }
}

#[tokio::test]
async fn a_revoked_code_can_no_longer_be_used() {
    let f = fixture().await;
    let created = f
        .service
        .create_invite_codes(UserId::new(), codes(1))
        .await
        .unwrap();

    let revoked = f.service.revoke_invite_code(created[0].id).await.unwrap();
    assert_eq!(revoked.status, InviteCodeStatus::Revoked);

    let err = f
        .register(&created[0].code, "小明", PASSWORD)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeRevoked));
}

#[tokio::test]
async fn only_an_unused_code_can_be_revoked() {
    let f = fixture().await;
    let created = f
        .service
        .create_invite_codes(UserId::new(), codes(2))
        .await
        .unwrap();

    // 已经使用的
    f.register(&created[0].code, "小明", PASSWORD)
        .await
        .unwrap();
    let err = f
        .service
        .revoke_invite_code(created[0].id)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeUsed));
    let list = f.invite_codes().await;
    let used = list.iter().find(|(c, _)| c.id == created[0].id).unwrap();
    assert_eq!(
        used.0.status,
        InviteCodeStatus::Used,
        "still marked as used"
    );

    // 已经作废的
    f.service.revoke_invite_code(created[1].id).await.unwrap();
    let err = f
        .service
        .revoke_invite_code(created[1].id)
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::InviteCodeRevoked));

    // 不存在的
    let err = f
        .service
        .revoke_invite_code(crate::ids::InviteCodeId::new())
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::NotFound));
}

#[tokio::test]
async fn several_codes_can_be_revoked_at_once() {
    let f = fixture().await;
    let created = f
        .service
        .create_invite_codes(UserId::new(), codes(4))
        .await
        .unwrap();
    f.register(&created[0].code, "小明", PASSWORD)
        .await
        .unwrap();

    // 一个已经使用，两个未使用，一个不存在：只作废那两个
    let ids = [
        created[0].id,
        created[1].id,
        created[2].id,
        crate::ids::InviteCodeId::new(),
    ];
    assert_eq!(f.service.revoke_invite_codes(&ids).await.unwrap(), 2);

    let list = f.invite_codes().await;
    let status = |index: usize| {
        list.iter()
            .find(|(c, _)| c.id == created[index].id)
            .unwrap()
            .0
            .status
    };
    assert_eq!(status(0), InviteCodeStatus::Used);
    assert_eq!(status(1), InviteCodeStatus::Revoked);
    assert_eq!(status(2), InviteCodeStatus::Revoked);
    assert_eq!(status(3), InviteCodeStatus::Unused, "not in the request");

    // 再来一次：没有可作废的了
    assert_eq!(f.service.revoke_invite_codes(&ids).await.unwrap(), 0);
    assert_eq!(f.service.revoke_invite_codes(&[]).await.unwrap(), 0);
}

#[tokio::test]
async fn too_many_codes_in_one_revoke_are_rejected() {
    let f = fixture().await;
    let ids: Vec<_> = (0..=MAX_INVITE_CODES_PER_BATCH)
        .map(|_| crate::ids::InviteCodeId::new())
        .collect();
    let err = f.service.revoke_invite_codes(&ids).await.unwrap_err();
    assert!(matches!(err, AccountError::Invalid(_)));
    let err = f.service.delete_invite_codes(&ids).await.unwrap_err();
    assert!(matches!(err, AccountError::Invalid(_)));
}

#[tokio::test]
async fn only_revoked_and_expired_codes_can_be_deleted() {
    let f = fixture().await;
    let admin = UserId::new();
    let forever = f
        .service
        .create_invite_codes(admin, codes(3))
        .await
        .unwrap();
    let short = f
        .service
        .create_invite_codes(
            admin,
            NewInviteCodes {
                count: 1,
                note: None,
                expires_in_days: Some(1),
            },
        )
        .await
        .unwrap();
    let (used, revoked, usable, expiring) = (&forever[0], &forever[1], &forever[2], &short[0]);
    f.register(&used.code, "小明", PASSWORD).await.unwrap();
    f.service.revoke_invite_codes(&[revoked.id]).await.unwrap();

    let all = [
        used.id,
        revoked.id,
        usable.id,
        expiring.id,
        crate::ids::InviteCodeId::new(),
    ];
    // 还没有过期：只有已作废的那个被删除
    assert_eq!(f.service.delete_invite_codes(&all).await.unwrap(), 1);
    let left: Vec<_> = f.invite_codes().await.iter().map(|(c, _)| c.id).collect();
    assert_eq!(left.len(), 3);
    assert!(!left.contains(&revoked.id));

    // 过期之后可以删除了；还能用的和已经使用的始终删不掉
    f.clock.advance(DAY_MS);
    assert_eq!(f.service.delete_invite_codes(&all).await.unwrap(), 1);
    let left: Vec<_> = f.invite_codes().await.iter().map(|(c, _)| c.id).collect();
    assert_eq!(left.len(), 2);
    assert!(left.contains(&used.id) && left.contains(&usable.id));

    assert_eq!(f.service.delete_invite_codes(&all).await.unwrap(), 0);
    assert_eq!(f.service.delete_invite_codes(&[]).await.unwrap(), 0);
}

#[tokio::test]
async fn invite_codes_are_listed_a_page_at_a_time() {
    let f = fixture().await;
    let admin = UserId::new();
    // 分三次生成，时间各不相同，顺序才是确定的
    let mut newest_first = Vec::new();
    for _ in 0..3 {
        let batch = f
            .service
            .create_invite_codes(admin, codes(1))
            .await
            .unwrap();
        newest_first.insert(0, batch[0].id);
        f.clock.advance(1000);
    }

    let page = f.service.list_invite_codes(paged(1, 2)).await.unwrap();
    assert_eq!(page.total, 3);
    let ids: Vec<_> = page.entries.iter().map(|(c, _)| c.id).collect();
    assert_eq!(ids, newest_first[..2]);

    let page = f.service.list_invite_codes(paged(2, 2)).await.unwrap();
    assert_eq!(page.total, 3);
    let ids: Vec<_> = page.entries.iter().map(|(c, _)| c.id).collect();
    assert_eq!(ids, newest_first[2..]);

    // 超出范围的页是空的，总数照常
    let page = f.service.list_invite_codes(paged(3, 2)).await.unwrap();
    assert!(page.entries.is_empty());
    assert_eq!(page.total, 3);

    for (page, page_size) in [(0, 20), (1, 0), (1, 101)] {
        let err = f
            .service
            .list_invite_codes(paged(page, page_size))
            .await
            .err()
            .unwrap();
        assert!(matches!(err, AccountError::Invalid(_)));
    }
}

#[tokio::test]
async fn invite_codes_are_filtered_by_state_and_ordered_by_time() {
    let f = fixture().await;
    let admin = UserId::new();
    // 五个邀请码，时间各不相同：已使用、已作废、会过期、长期有效的两个
    let mut created = Vec::new();
    for expires_in_days in [None, None, Some(1), None, None] {
        let batch = f
            .service
            .create_invite_codes(
                admin,
                NewInviteCodes {
                    count: 1,
                    note: None,
                    expires_in_days,
                },
            )
            .await
            .unwrap();
        created.push(batch.into_iter().next().unwrap());
        f.clock.advance(1000);
    }
    f.register(&created[0].code, "小明", PASSWORD)
        .await
        .unwrap();
    f.service
        .revoke_invite_codes(&[created[1].id])
        .await
        .unwrap();

    let ids = |state, order| {
        let service = &f.service;
        async move {
            let page = service
                .list_invite_codes(InviteCodeListing {
                    state,
                    order,
                    ..InviteCodeListing::default()
                })
                .await
                .unwrap();
            assert_eq!(page.total, page.entries.len() as u64);
            page.entries.iter().map(|(c, _)| c.id).collect::<Vec<_>>()
        }
    };
    let id = |index: usize| created[index].id;
    use InviteCodeOrder::{NewestFirst, OldestFirst};
    use InviteCodeState::{Expired, Revoked, Unused, Used};

    // 还没有过期：会过期的那个算"未使用"
    assert_eq!(ids(Some(Used), NewestFirst).await, [id(0)]);
    assert_eq!(ids(Some(Revoked), NewestFirst).await, [id(1)]);
    assert_eq!(ids(Some(Expired), NewestFirst).await, []);
    assert_eq!(ids(Some(Unused), NewestFirst).await, [id(4), id(3), id(2)]);
    assert_eq!(ids(Some(Unused), OldestFirst).await, [id(2), id(3), id(4)]);
    assert_eq!(
        ids(None, OldestFirst).await,
        [id(0), id(1), id(2), id(3), id(4)]
    );
    assert_eq!(
        ids(None, NewestFirst).await,
        [id(4), id(3), id(2), id(1), id(0)]
    );

    // 过期之后：它从"未使用"变成"已过期"
    f.clock.advance(DAY_MS);
    assert_eq!(ids(Some(Expired), NewestFirst).await, [id(2)]);
    assert_eq!(ids(Some(Unused), NewestFirst).await, [id(4), id(3)]);

    // 筛选之后再分页：总数是符合条件的数量
    let page = f
        .service
        .list_invite_codes(InviteCodeListing {
            page: 2,
            page_size: 1,
            state: Some(Unused),
            order: OldestFirst,
        })
        .await
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.entries[0].0.id, id(4));
}

// ---------- 第一名管理员 ----------

#[tokio::test]
async fn the_first_admin_is_created_once_and_must_change_the_password() {
    let f = fixture().await;
    assert!(
        f.service
            .bootstrap_admin("admin@example.com", "initial-pass-1")
            .await
            .unwrap()
    );
    assert!(
        !f.service
            .bootstrap_admin("other@example.com", "another-pass-2")
            .await
            .unwrap(),
        "an admin already exists"
    );

    let admin = f.login("admin", "initial-pass-1").await.unwrap().user;
    assert_eq!(admin.role, Role::Admin);
    assert!(admin.must_change_password);
    assert_eq!(admin.email.as_deref(), Some("admin@example.com"));
}
