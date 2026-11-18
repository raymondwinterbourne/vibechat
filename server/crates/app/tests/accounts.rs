//! 账号接口：注册、登录、退出、资料、头像、邀请码，以及各接口的权限。

mod common;

use axum::http::StatusCode;
use common::{ADMIN_INITIAL_PASSWORD, ADMIN_PASSWORD, PASSWORD};
use serde_json::json;
use vibechat_core::account::guard::LOCK_MS;
use vibechat_core::account::model::UserStatus;
use vibechat_core::account::service::AVATAR_MAX_BYTES;
use vibechat_protocol::{
    DeleteInviteCodesResponse, ErrorCode, InviteCodeList, InviteCodePage, InviteCodeStatus,
    Language, Me, RevokeInviteCodesResponse, Role, Theme,
};

// ---------- 注册 ----------

#[tokio::test]
async fn registering_logs_in_and_returns_the_assigned_id() {
    let app = common::app().await;
    let mut client = app.client();
    let reply = client
        .post(
            "/api/auth/register",
            json!({ "invite_code": app.invite_code(), "nickname": "小明", "password": PASSWORD }),
        )
        .await;

    assert_eq!(reply.status, StatusCode::CREATED);
    let me: Me = reply.json();
    assert!(me.handle.starts_with("vc") && me.handle.len() == 10);
    assert_eq!(me.nickname, "小明");
    assert_eq!(me.role, Role::User);
    assert!(!me.must_change_password);

    let cookie = reply.headers["set-cookie"].to_str().unwrap();
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Lax"));
    assert!(cookie.contains("Max-Age=2592000"));
    let body = reply.text();
    assert!(
        !body.contains(PASSWORD) && !body.contains("hash"),
        "no password material in the response"
    );

    // 注册完就是登录状态
    let again: Me = client.get("/api/me").await.json();
    assert_eq!(again, me);
}

#[tokio::test]
async fn registration_failures_have_their_own_error_codes() {
    let app = common::app().await;
    let mut client = app.client();
    let code = app.invite_code();
    let register = |invite_code: &str, nickname: &str, password: &str| json!({ "invite_code": invite_code, "nickname": nickname, "password": password });

    let reply = client
        .post(
            "/api/auth/register",
            register("NOSUCHCODE000000", "小明", PASSWORD),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::InviteCodeNotFound)
    );

    let reply = client
        .post("/api/auth/register", register(&code, "小明", "short1"))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::BAD_REQUEST, ErrorCode::PasswordTooWeak)
    );

    let reply = client
        .post("/api/auth/register", register(&code, "  ", PASSWORD))
        .await;
    assert_eq!(reply.error().code, ErrorCode::NicknameInvalid);
    assert!(
        client.cookie.is_none(),
        "failed registrations do not log in"
    );

    assert_eq!(
        client
            .post("/api/auth/register", register(&code, "小明", PASSWORD))
            .await
            .status,
        StatusCode::CREATED
    );

    // 用过的邀请码
    let reply = app
        .client()
        .post("/api/auth/register", register(&code, "小红", PASSWORD))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::InviteCodeUsed)
    );
}

#[tokio::test]
async fn an_expired_invite_code_is_refused_with_its_own_error_code() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    let reply = admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 1, "expires_in_days": 1 }),
        )
        .await;
    let created: InviteCodeList = reply.json();
    let code = &created.items[0].code;

    // 有效期一天：过了一毫秒就不能用
    app.clock.advance(24 * 60 * 60 * 1000 + 1);
    let reply = app
        .client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": code, "nickname": "小明", "password": PASSWORD }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::InviteCodeExpired)
    );
}

// ---------- 登录与退出 ----------

#[tokio::test]
async fn login_works_and_wrong_credentials_are_indistinguishable() {
    let app = common::app().await;
    let (_, me) = app.user("小明").await;

    let mut client = app.client();
    let reply = client
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": "wrong-pass-1" }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::UNAUTHORIZED, ErrorCode::InvalidCredentials)
    );
    let wrong_password = reply.text();

    let reply = client
        .post(
            "/api/auth/login",
            json!({ "handle": "nobody_here", "password": PASSWORD }),
        )
        .await;
    assert_eq!(
        reply.text(),
        wrong_password,
        "same response whether or not the id exists"
    );
    assert!(client.cookie.is_none());

    let reply = client
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle.to_uppercase(), "password": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<Me>().id, me.id);
    assert_eq!(client.get("/api/me").await.status, StatusCode::OK);
}

#[tokio::test]
async fn five_wrong_passwords_lock_the_id_and_say_how_long_to_wait() {
    let app = common::app().await;
    let (_, me) = app.user("小明").await;
    let mut client = app.client();

    for _ in 0..5 {
        let reply = client
            .post(
                "/api/auth/login",
                json!({ "handle": me.handle, "password": "wrong-pass-1" }),
            )
            .await;
        assert_eq!(reply.error().code, ErrorCode::InvalidCredentials);
    }
    let reply = client
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::TOO_MANY_REQUESTS);
    let error = reply.error();
    assert_eq!(error.code, ErrorCode::AccountLocked);
    assert_eq!(error.retry_after_secs, Some(900));
    assert_eq!(reply.headers["retry-after"], "900");

    app.clock.advance(LOCK_MS);
    let reply = client
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
}

#[tokio::test]
async fn a_disabled_user_is_told_so_and_loses_existing_logins() {
    let app = common::app().await;
    let (mut logged_in, me) = app.user("小明").await;
    app.store.edit_user(me.id.parse().unwrap(), |user| {
        user.status = UserStatus::Disabled
    });

    let reply = logged_in.get("/api/me").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized)
    );

    let reply = app
        .client()
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::AccountDisabled)
    );
}

#[tokio::test]
async fn without_a_login_protected_endpoints_answer_unauthorized() {
    let app = common::app().await;
    let mut client = app.client();
    for path in [
        "/api/me",
        "/api/admin/invite-codes",
        "/api/files/0190a000-0000-7000-8000-000000000000",
    ] {
        let reply = client.get(path).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized),
            "{path}"
        );
    }
    let reply = client.patch("/api/me", json!({ "nickname": "x" })).await;
    assert_eq!(reply.error().code, ErrorCode::Unauthorized);

    client.cookie = Some("vc_session=made-up-token".to_owned());
    assert_eq!(
        client.get("/api/me").await.error().code,
        ErrorCode::Unauthorized
    );
}

#[tokio::test]
async fn logging_out_clears_the_cookie_and_ends_that_login_only() {
    let app = common::app().await;
    let (mut here, me) = app.user("小明").await;
    let mut elsewhere = app.client();
    elsewhere
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    let old_cookie = here.cookie.clone();

    let reply = here.post_empty("/api/auth/logout").await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(
        here.cookie.is_none(),
        "the browser is told to drop the cookie"
    );

    // 即使有人留着旧的 Cookie，它也已经无效
    here.cookie = old_cookie;
    assert_eq!(here.get("/api/me").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(elsewhere.get("/api/me").await.status, StatusCode::OK);
}

#[tokio::test]
async fn opening_the_app_renews_the_cookie() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;
    let reply = client.get("/api/me").await;
    let cookie = reply.headers["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with(&format!("vc_session={}", client.token())));
    assert!(cookie.contains("Max-Age=2592000"));
}

// ---------- 必须修改密码 ----------

#[tokio::test]
async fn the_first_admin_must_change_the_password_before_anything_else() {
    let app = common::app().await;
    app.state
        .accounts
        .bootstrap_admin("admin@example.com", ADMIN_INITIAL_PASSWORD)
        .await
        .unwrap();
    let mut client = app.client();

    let me: Me = client
        .post(
            "/api/auth/login",
            json!({ "handle": "admin", "password": ADMIN_INITIAL_PASSWORD }),
        )
        .await
        .json();
    assert!(me.must_change_password);
    assert_eq!(me.role, Role::Admin);
    assert_eq!(me.email.as_deref(), Some("admin@example.com"));

    // 能看到自己是谁，但做不了别的
    assert_eq!(client.get("/api/me").await.status, StatusCode::OK);
    for reply in [
        client.patch("/api/me", json!({ "nickname": "x" })).await,
        client.get("/api/admin/invite-codes").await,
        client
            .post("/api/admin/invite-codes", json!({ "count": 1 }))
            .await,
    ] {
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::FORBIDDEN, ErrorCode::MustChangePassword)
        );
    }

    let reply = client
        .put(
            "/api/me/password",
            json!({ "current_password": ADMIN_INITIAL_PASSWORD, "new_password": ADMIN_PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);

    let me: Me = client.get("/api/me").await.json();
    assert!(!me.must_change_password);
    assert_eq!(
        client.get("/api/admin/invite-codes").await.status,
        StatusCode::OK
    );
}

// ---------- 个人资料 ----------

#[tokio::test]
async fn profile_and_preferences_can_be_changed() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;

    let me: Me = client
        .patch(
            "/api/me",
            json!({ "nickname": " 明明 ", "signature": "今天也要加油" }),
        )
        .await
        .json();
    assert_eq!(
        (me.nickname.as_str(), me.signature.as_str()),
        ("明明", "今天也要加油")
    );
    assert_eq!((me.language, me.theme), (None, None));

    let me: Me = client
        .patch("/api/me", json!({ "language": "en", "theme": "dark" }))
        .await
        .json();
    assert_eq!(
        (me.language, me.theme),
        (Some(Language::En), Some(Theme::Dark))
    );
    assert_eq!(
        me.nickname, "明明",
        "fields that were not sent are untouched"
    );

    let reply = client
        .patch("/api/me", json!({ "nickname": "名".repeat(33) }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::BAD_REQUEST, ErrorCode::NicknameInvalid)
    );
    let reply = client
        .patch("/api/me", json!({ "signature": "签".repeat(101) }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::SignatureTooLong);
    let reply = client.patch("/api/me", json!({ "language": "fr" })).await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn after_changing_the_id_only_the_new_one_logs_in() {
    let app = common::app().await;
    let (mut client, me) = app.user("小明").await;
    let (mut other, _) = app.user("小红").await;

    let reply = client
        .put("/api/me/handle", json!({ "handle": "ab" }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::BAD_REQUEST, ErrorCode::IdInvalid)
    );

    let changed: Me = client
        .put("/api/me/handle", json!({ "handle": "Xiao_Ming" }))
        .await
        .json();
    assert_eq!(changed.handle, "Xiao_Ming");
    assert_eq!(changed.id, me.id, "the internal id never changes");

    let reply = other
        .put("/api/me/handle", json!({ "handle": "xiao_ming" }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::IdTaken)
    );

    let mut fresh = app.client();
    let reply = fresh
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::InvalidCredentials);
    let reply = fresh
        .post(
            "/api/auth/login",
            json!({ "handle": "xiao_ming", "password": PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
}

#[tokio::test]
async fn changing_the_password_ends_other_logins_and_rejects_bad_input() {
    let app = common::app().await;
    let (mut here, _) = app.user("小明").await;
    // 系统分配的 ID 是随机的，不一定含数字；换成一个固定的、本身够得上密码强度的 ID，
    // 才能确定地测到"密码不能与 ID 相同"
    let me: Me = here
        .put("/api/me/handle", json!({ "handle": "Xiao_Ming2026" }))
        .await
        .json();
    let mut elsewhere = app.client();
    elsewhere
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;

    let change =
        |current: &str, new: &str| json!({ "current_password": current, "new_password": new });
    let cases = [
        (
            "wrong-current-1",
            "brand-new-pass-2",
            ErrorCode::PasswordIncorrect,
        ),
        (PASSWORD, PASSWORD, ErrorCode::PasswordUnchanged),
        (PASSWORD, "short1", ErrorCode::PasswordTooWeak),
        (PASSWORD, "xiao_ming2026", ErrorCode::PasswordSameAsId),
    ];
    for (current, new, expected) in cases {
        let reply = here.put("/api/me/password", change(current, new)).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::BAD_REQUEST, expected)
        );
    }
    assert_eq!(
        elsewhere.get("/api/me").await.status,
        StatusCode::OK,
        "nothing changed yet"
    );

    let reply = here
        .put("/api/me/password", change(PASSWORD, "brand-new-pass-2"))
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(here.get("/api/me").await.status, StatusCode::OK);
    assert_eq!(
        elsewhere.get("/api/me").await.status,
        StatusCode::UNAUTHORIZED
    );
}

// ---------- 头像与文件 ----------

#[tokio::test]
async fn an_avatar_can_be_uploaded_and_read_by_logged_in_users_only() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;
    let (mut other, _) = app.user("小红").await;

    let me: Me = client
        .put_bytes("/api/me/avatar", b"IMG-bytes".to_vec())
        .await
        .json();
    let file = me.avatar_file_id.expect("avatar is set");
    let path = format!("/api/files/{file}");

    let reply = client.get(&path).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, b"IMG-bytes");
    assert_eq!(reply.headers["content-type"], "image/png");
    assert_eq!(reply.headers["x-content-type-options"], "nosniff");
    assert!(
        reply.headers["cache-control"]
            .to_str()
            .unwrap()
            .contains("private")
    );

    assert_eq!(
        other.get(&path).await.status,
        StatusCode::OK,
        "any logged-in user can see an avatar"
    );
    assert_eq!(
        app.client().get(&path).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn uploads_that_are_not_images_or_too_large_are_refused() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;

    let reply = client
        .put_bytes("/api/me/avatar", b"#!/bin/sh".to_vec())
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ErrorCode::UnsupportedImage
        )
    );

    let mut huge = b"IMG".to_vec();
    huge.resize(AVATAR_MAX_BYTES + 1, 0);
    let reply = client.put_bytes("/api/me/avatar", huge).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::PAYLOAD_TOO_LARGE, ErrorCode::PayloadTooLarge)
    );

    assert_eq!(
        client.get("/api/me").await.json::<Me>().avatar_file_id,
        None
    );
}

#[tokio::test]
async fn unknown_or_malformed_file_ids_are_not_found() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;
    for path in [
        "/api/files/0190a000-0000-7000-8000-000000000000",
        "/api/files/not-an-id",
        "/api/files/..%2F..%2Fetc%2Fpasswd",
    ] {
        let reply = client.get(path).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::NOT_FOUND, ErrorCode::NotFound),
            "{path}"
        );
    }
}

// ---------- 邀请码 ----------

#[tokio::test]
async fn an_admin_generates_codes_and_sees_who_used_them() {
    let app = common::app().await;
    let mut admin = app.admin().await;

    let reply = admin
        .post("/api/admin/invite-codes", json!({ "count": 3 }))
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let created: InviteCodeList = reply.json();
    assert_eq!(created.items.len(), 3);
    assert!(
        created
            .items
            .iter()
            .all(|item| item.code.len() == 16 && item.status == InviteCodeStatus::Unused)
    );

    let code = created.items[0].code.clone();
    let mut newcomer = app.client();
    let me: Me = newcomer
        .post(
            "/api/auth/register",
            json!({ "invite_code": code, "nickname": "小明", "password": PASSWORD }),
        )
        .await
        .json();

    let list: InviteCodeList = admin.get("/api/admin/invite-codes").await.json();
    assert_eq!(list.items.len(), 3);
    let used = list.items.iter().find(|item| item.code == code).unwrap();
    assert_eq!(used.status, InviteCodeStatus::Used);
    let used_by = used.used_by.as_ref().unwrap();
    assert_eq!(
        (used_by.id.as_str(), used_by.nickname.as_str()),
        (me.id.as_str(), "小明")
    );
    assert_eq!(
        list.items
            .iter()
            .filter(|item| item.status == InviteCodeStatus::Unused)
            .count(),
        2
    );

    for count in [0, 21] {
        let reply = admin
            .post("/api/admin/invite-codes", json!({ "count": count }))
            .await;
        assert_eq!(reply.error().code, ErrorCode::BadRequest);
    }
}

#[tokio::test]
async fn several_codes_are_revoked_in_one_request() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    let created: InviteCodeList = admin
        .post("/api/admin/invite-codes", json!({ "count": 4 }))
        .await
        .json();
    let [used, first, second, kept] = &created.items[..] else {
        panic!("expected four codes");
    };
    app.client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": used.code, "nickname": "小明", "password": PASSWORD }),
        )
        .await;

    // 已经使用的、不存在的、格式不对的都被跳过
    let ids = json!({ "ids": [
        used.id, first.id, second.id, "0190a000-0000-7000-8000-000000000000", "not-an-id",
    ] });
    let reply = admin
        .post("/api/admin/invite-codes/revoke", ids.clone())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<RevokeInviteCodesResponse>().revoked, 2);

    let list: InviteCodeList = admin.get("/api/admin/invite-codes").await.json();
    let status = |id: &str| list.items.iter().find(|item| item.id == id).unwrap().status;
    assert_eq!(status(&used.id), InviteCodeStatus::Used);
    assert_eq!(status(&first.id), InviteCodeStatus::Revoked);
    assert_eq!(status(&second.id), InviteCodeStatus::Revoked);
    assert_eq!(status(&kept.id), InviteCodeStatus::Unused);

    // 重复提交、空列表：都不是错误，只是什么也没作废
    for body in [ids, json!({ "ids": [] })] {
        let reply = admin.post("/api/admin/invite-codes/revoke", body).await;
        assert_eq!(reply.json::<RevokeInviteCodesResponse>().revoked, 0);
    }

    let too_many: Vec<String> = (0..501).map(|_| kept.id.clone()).collect();
    let reply = admin
        .post("/api/admin/invite-codes/revoke", json!({ "ids": too_many }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);

    // 普通用户不能调用
    let mut user = app.client();
    user.post(
        "/api/auth/register",
        json!({ "invite_code": kept.code, "nickname": "小红", "password": PASSWORD }),
    )
    .await;
    let reply = user
        .post(
            "/api/admin/invite-codes/revoke",
            json!({ "ids": [first.id] }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
    );
}

#[tokio::test]
async fn revoked_and_expired_codes_can_be_deleted() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    let created: InviteCodeList = admin
        .post("/api/admin/invite-codes", json!({ "count": 3 }))
        .await
        .json();
    let [used, revoked, usable] = &created.items[..] else {
        panic!("expected three codes");
    };
    let short: InviteCodeList = admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 1, "expires_in_days": 1 }),
        )
        .await
        .json();
    let expiring = &short.items[0];
    app.client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": used.code, "nickname": "小明", "password": PASSWORD }),
        )
        .await;
    admin
        .post_empty(&format!("/api/admin/invite-codes/{}/revoke", revoked.id))
        .await;

    // 只有已作废的被删除：还能用的、已经使用的、不存在的、格式不对的都被跳过
    let ids = json!({ "ids": [
        used.id, revoked.id, usable.id, expiring.id,
        "0190a000-0000-7000-8000-000000000000", "not-an-id",
    ] });
    let reply = admin
        .post("/api/admin/invite-codes/delete", ids.clone())
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<DeleteInviteCodesResponse>().deleted, 1);
    let page: InviteCodePage = admin.get("/api/admin/invite-codes").await.json();
    assert_eq!(page.total, 3);
    assert!(page.items.iter().all(|item| item.id != revoked.id));

    // 过期之后也可以删除
    app.clock.advance(24 * 60 * 60 * 1000);
    let reply = admin
        .post("/api/admin/invite-codes/delete", ids.clone())
        .await;
    assert_eq!(reply.json::<DeleteInviteCodesResponse>().deleted, 1);
    let page: InviteCodePage = admin.get("/api/admin/invite-codes").await.json();
    let left: Vec<&str> = page.items.iter().map(|item| item.id.as_str()).collect();
    assert_eq!(page.total, 2);
    assert!(left.contains(&used.id.as_str()) && left.contains(&usable.id.as_str()));

    // 重复提交、空列表：都不是错误，只是什么也没删除
    for body in [ids, json!({ "ids": [] })] {
        let reply = admin.post("/api/admin/invite-codes/delete", body).await;
        assert_eq!(reply.json::<DeleteInviteCodesResponse>().deleted, 0);
    }

    let too_many: Vec<String> = (0..501).map(|_| usable.id.clone()).collect();
    let reply = admin
        .post("/api/admin/invite-codes/delete", json!({ "ids": too_many }))
        .await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);

    // 普通用户不能调用
    let mut user = app.client();
    user.post(
        "/api/auth/register",
        json!({ "invite_code": usable.code, "nickname": "小红", "password": PASSWORD }),
    )
    .await;
    let reply = user
        .post(
            "/api/admin/invite-codes/delete",
            json!({ "ids": [used.id] }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
    );
}

#[tokio::test]
async fn codes_are_filtered_by_status() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    let created: InviteCodeList = admin
        .post("/api/admin/invite-codes", json!({ "count": 3 }))
        .await
        .json();
    let [used, revoked, unused] = &created.items[..] else {
        panic!("expected three codes");
    };
    let short: InviteCodeList = admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 1, "expires_in_days": 1 }),
        )
        .await
        .json();
    let expiring = &short.items[0];
    app.client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": used.code, "nickname": "小明", "password": PASSWORD }),
        )
        .await;
    admin
        .post_empty(&format!("/api/admin/invite-codes/{}/revoke", revoked.id))
        .await;

    // 某种状态的邀请码有哪些（按编号排好，方便比较）、一共几个
    async fn with_status(admin: &mut common::Client, status: &str) -> (Vec<String>, u32) {
        let page: InviteCodePage = admin
            .get(&format!("/api/admin/invite-codes?status={status}"))
            .await
            .json();
        let mut ids: Vec<String> = page.items.into_iter().map(|item| item.id).collect();
        ids.sort();
        (ids, page.total)
    }
    let sorted = |ids: &[&String]| {
        let mut ids: Vec<String> = ids.iter().map(|id| (*id).clone()).collect();
        ids.sort();
        ids
    };

    assert_eq!(
        with_status(&mut admin, "unused").await,
        (sorted(&[&unused.id, &expiring.id]), 2)
    );
    assert_eq!(
        with_status(&mut admin, "used").await,
        (sorted(&[&used.id]), 1)
    );
    assert_eq!(
        with_status(&mut admin, "revoked").await,
        (sorted(&[&revoked.id]), 1)
    );
    assert_eq!(with_status(&mut admin, "expired").await, (vec![], 0));

    // 过期之后，它从"未使用"换到"已过期"
    app.clock.advance(24 * 60 * 60 * 1000);
    assert_eq!(
        with_status(&mut admin, "unused").await,
        (sorted(&[&unused.id]), 1)
    );
    assert_eq!(
        with_status(&mut admin, "expired").await,
        (sorted(&[&expiring.id]), 1)
    );
}

#[tokio::test]
async fn codes_are_listed_a_page_at_a_time() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    // 分三批生成，时间各不相同：最后一批排在最前面
    for count in [20, 3, 2] {
        admin
            .post("/api/admin/invite-codes", json!({ "count": count }))
            .await;
        app.clock.advance(1000);
    }

    // 不写参数：第一页，每页 20 个
    let first: InviteCodePage = admin.get("/api/admin/invite-codes").await.json();
    assert_eq!((first.items.len(), first.total), (20, 25));
    let second: InviteCodePage = admin.get("/api/admin/invite-codes?page=2").await.json();
    assert_eq!((second.items.len(), second.total), (5, 25));
    assert!(
        first.items.last().unwrap().created_at >= second.items[0].created_at,
        "newest first across pages"
    );
    assert!(
        second
            .items
            .iter()
            .all(|item| first.items.iter().all(|other| other.id != item.id)),
        "no code appears on two pages"
    );

    let small: InviteCodePage = admin
        .get("/api/admin/invite-codes?page=3&page_size=10")
        .await
        .json();
    assert_eq!((small.items.len(), small.total), (5, 25));
    let beyond: InviteCodePage = admin.get("/api/admin/invite-codes?page=9").await.json();
    assert_eq!((beyond.items.len(), beyond.total), (0, 25));

    // 最早的在前：排在最前面的是第一批里的
    let oldest: InviteCodePage = admin
        .get("/api/admin/invite-codes?order=oldest")
        .await
        .json();
    assert_eq!(oldest.items[0].created_at, second.items[4].created_at);
    assert!(oldest.items[0].created_at < first.items[0].created_at);
    let newest: InviteCodePage = admin
        .get("/api/admin/invite-codes?order=newest")
        .await
        .json();
    assert_eq!(newest.items[0].id, first.items[0].id);

    for query in [
        "page=0",
        "page_size=0",
        "page_size=101",
        "page=abc",
        "page=-1",
        "status=nonsense",
        "order=sideways",
    ] {
        let reply = admin.get(&format!("/api/admin/invite-codes?{query}")).await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::BAD_REQUEST, ErrorCode::BadRequest),
            "{query}"
        );
    }
}

#[tokio::test]
async fn codes_are_generated_with_a_note_and_an_expiry_and_can_be_revoked() {
    let app = common::app().await;
    let mut admin = app.admin().await;

    let reply = admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 2, "note": "给新同事", "expires_in_days": 7 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED);
    let created: InviteCodeList = reply.json();
    let week = 7 * 24 * 60 * 60 * 1000;
    for item in &created.items {
        assert_eq!(item.note.as_deref(), Some("给新同事"));
        assert_eq!(item.expires_at, Some(item.created_at + week));
    }

    // 作废其中一个
    let target = &created.items[0];
    let reply = admin
        .post_empty(&format!("/api/admin/invite-codes/{}/revoke", target.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(
        reply.json::<vibechat_protocol::InviteCodeView>().status,
        InviteCodeStatus::Revoked
    );

    let reply = app
        .client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": target.code, "nickname": "小明", "password": PASSWORD }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::InviteCodeRevoked)
    );

    // 再作废一次、作废已经使用的、作废不存在的
    let reply = admin
        .post_empty(&format!("/api/admin/invite-codes/{}/revoke", target.id))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::InviteCodeRevoked)
    );

    let other = &created.items[1];
    app.client()
        .post(
            "/api/auth/register",
            json!({ "invite_code": other.code, "nickname": "小红", "password": PASSWORD }),
        )
        .await;
    let reply = admin
        .post_empty(&format!("/api/admin/invite-codes/{}/revoke", other.id))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::InviteCodeUsed)
    );

    for id in ["0190a000-0000-7000-8000-000000000000", "not-an-id"] {
        let reply = admin
            .post_empty(&format!("/api/admin/invite-codes/{id}/revoke"))
            .await;
        assert_eq!(
            (reply.status, reply.error().code),
            (StatusCode::NOT_FOUND, ErrorCode::NotFound)
        );
    }

    // 过期的邀请码在列表里显示为已过期
    app.clock.advance(week);
    let list: InviteCodeList = admin.get("/api/admin/invite-codes").await.json();
    let statuses: Vec<_> = list.items.iter().map(|item| item.status).collect();
    assert!(statuses.contains(&InviteCodeStatus::Revoked));
    assert!(statuses.contains(&InviteCodeStatus::Used));
    assert!(!statuses.contains(&InviteCodeStatus::Unused));
}

#[tokio::test]
async fn an_unused_code_past_its_expiry_is_listed_as_expired() {
    let app = common::app().await;
    let mut admin = app.admin().await;
    admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 1, "expires_in_days": 1 }),
        )
        .await;

    app.clock.advance(24 * 60 * 60 * 1000);
    let list: InviteCodeList = admin.get("/api/admin/invite-codes").await.json();
    assert_eq!(list.items[0].status, InviteCodeStatus::Expired);

    let reply = admin
        .post(
            "/api/admin/invite-codes",
            json!({ "count": 1, "expires_in_days": 0 }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::BadRequest);
}

#[tokio::test]
async fn an_ordinary_user_cannot_use_admin_endpoints() {
    let app = common::app().await;
    let (mut client, _) = app.user("小明").await;

    let reply = client.get("/api/admin/invite-codes").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
    );
    let reply = client
        .post("/api/admin/invite-codes", json!({ "count": 1 }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
    );

    let reply = client
        .post_empty("/api/admin/invite-codes/0190a000-0000-7000-8000-000000000000/revoke")
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::Forbidden)
    );
}

#[tokio::test]
async fn the_admin_logs_in_with_the_id_admin() {
    let app = common::app().await;
    let _ = app.admin().await;
    let reply = app
        .client()
        .post(
            "/api/auth/login",
            json!({ "handle": "Admin", "password": ADMIN_PASSWORD }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.json::<Me>().handle, "admin");
}
