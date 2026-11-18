//! 管理接口：用户、系统设置、查看聊天内容、群、概况、操作记录，以及管理员找回密码和修改邮箱。

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::{ADMIN_PASSWORD, Client, PASSWORD, Reply, TestApp};
use serde_json::{Value, json};
use tokio::sync::mpsc::Receiver;
use vibechat_core::admin::service::{LINK_TTL_MS, VIEW_TTL_MS};
use vibechat_core::testing::fake_image;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    AdminConversationList, AdminConversationView, AdminGroupPage, AdminMemberList, AdminUserPage,
    AdminUserView, AuditAction, AuditPage, ConversationKind, ConversationView, EmailConfirmed,
    ErrorCode, FileView, FriendRequestResult, IceServers, InviteCodeList, LimitsView, Me,
    MessageKind, MessageList, MessageView, OverviewView, QuoteState, ResetPasswordResponse,
    ServerEvent, SettingsView, UserStatus, ViewStarted,
};

/// 一个用户的一处登录收到的推送。
struct Inbox(Receiver<ServerEvent>);

impl Inbox {
    fn open(app: &TestApp, user: &str) -> Self {
        let user: UserId = user.parse().unwrap();
        Self(app.state.hub.register(user, SessionId::new()).events)
    }

    fn events(&mut self) -> Vec<ServerEvent> {
        std::iter::from_fn(|| self.0.try_recv().ok()).collect()
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
    let request = json!({ "to": b.me.id });
    let sent = a.client.post("/api/friend-requests", request).await;
    let sent: FriendRequestResult = sent.json();
    let accept = format!("/api/friend-requests/{}/accept", sent.request.id);
    assert_eq!(b.client.post_empty(&accept).await.status, StatusCode::OK);
}

/// 两个好友和他们的单聊。
async fn pair(app: &TestApp) -> (Person, Person, String) {
    let (mut a, mut b) = (person(app, "小明").await, person(app, "小红").await);
    befriend(&mut a, &mut b).await;
    let request = json!({ "user_id": b.me.id });
    let opened = a.client.post("/api/conversations/direct", request).await;
    let id = opened.json::<ConversationView>().id;
    (a, b, id)
}

/// 群主和两个成员的群。
async fn group(app: &TestApp, name: &str) -> (Person, Person, Person, String) {
    let mut owner = person(app, "群主").await;
    let mut one = person(app, "成员一").await;
    let mut two = person(app, "成员二").await;
    for friend in [&mut one, &mut two] {
        befriend(&mut owner, friend).await;
    }
    let request = json!({ "name": name, "member_ids": [one.me.id, two.me.id] });
    let reply = owner.client.post("/api/conversations/group", request).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = reply.json::<ConversationView>().id;
    (owner, one, two, id)
}

async fn say(person: &mut Person, conversation: &str, body: Value) -> MessageView {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let client_id = format!(
        "c-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let mut body = body;
    body["client_id"] = json!(client_id);
    let path = format!("/api/conversations/{conversation}/messages");
    let reply = person.client.post(&path, body).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn upload_raw(person: &mut Person, name: &str, content: &[u8]) -> Reply {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/files")
        .header("x-file-name", name)
        .header(header::CONTENT_TYPE, "application/octet-stream");
    person
        .client
        .send(request, Body::from(content.to_vec()))
        .await
}

async fn recall(person: &mut Person, conversation: &str, seq: i64) {
    let path = format!("/api/conversations/{conversation}/messages/{seq}/recall");
    let reply = person.client.post_empty(&path).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
}

async fn audit(admin: &mut Client) -> Vec<vibechat_protocol::AuditEntryView> {
    let reply = admin.get("/api/admin/audit").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json::<AuditPage>().items
}

async fn start_view(admin: &mut Client, conversation: &str) -> ViewStarted {
    let path = format!("/api/admin/conversations/{conversation}/views");
    let reply = admin.post_empty(&path).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

fn refused(reply: &Reply, status: StatusCode, code: ErrorCode) {
    assert_eq!(reply.status, status, "{}", reply.text());
    assert_eq!(reply.error().code, code);
}

// ---------- 权限 ----------

#[tokio::test]
async fn every_admin_endpoint_is_closed_to_ordinary_users_and_visitors() {
    let app = app_with_admin().await.0;
    let (_, _, conversation) = pair(&app).await;
    let (mut user, me) = app.user("普通人").await;
    let mut visitor = app.client();
    let id = &me.id;
    let endpoints = [
        (Method::GET, "/api/admin/overview".to_owned()),
        (Method::GET, "/api/admin/users".to_owned()),
        (Method::POST, format!("/api/admin/users/{id}/disable")),
        (Method::POST, format!("/api/admin/users/{id}/enable")),
        (
            Method::POST,
            format!("/api/admin/users/{id}/reset-password"),
        ),
        (Method::GET, format!("/api/admin/users/{id}/conversations")),
        (Method::GET, "/api/admin/groups".to_owned()),
        (
            Method::GET,
            format!("/api/admin/conversations/{conversation}/members"),
        ),
        (
            Method::POST,
            format!("/api/admin/conversations/{conversation}/views"),
        ),
        (
            Method::GET,
            format!("/api/admin/conversations/{conversation}/messages"),
        ),
        (
            Method::GET,
            format!("/api/admin/conversations/{conversation}/files/{id}"),
        ),
        (
            Method::GET,
            format!("/api/admin/conversations/{conversation}/files/{id}/thumbnail"),
        ),
        (
            Method::POST,
            format!("/api/admin/conversations/{conversation}/dissolve"),
        ),
        (Method::GET, "/api/admin/settings".to_owned()),
        (Method::PUT, "/api/admin/settings".to_owned()),
        (Method::GET, "/api/admin/audit".to_owned()),
        (Method::GET, "/api/admin/invite-codes".to_owned()),
        (Method::POST, "/api/admin/invite-codes".to_owned()),
        (Method::POST, "/api/admin/invite-codes/revoke".to_owned()),
        (Method::POST, "/api/admin/invite-codes/delete".to_owned()),
        (Method::PUT, "/api/me/email".to_owned()),
    ];
    for (method, path) in endpoints {
        let request = || {
            Request::builder()
                .method(method.clone())
                .uri(&path)
                .header(header::CONTENT_TYPE, "application/json")
        };
        let body = || Body::from("{}");
        let reply = user.send(request(), body()).await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(reply.error().code, ErrorCode::Forbidden, "{method} {path}");
        let reply = visitor.send(request(), body()).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    // 什么都没有发生，也没有留下记录
    assert!(app.store.audit_entries().is_empty());
}

async fn app_with_admin() -> (TestApp, Client) {
    let app = common::app().await;
    let admin = app.admin().await;
    (app, admin)
}

// ---------- 用户 ----------

#[tokio::test]
async fn the_user_list_shows_who_registered_with_which_invite_code() {
    let (app, mut admin) = app_with_admin().await;
    let ming = person(&app, "小明").await;
    app.clock.advance(1000);
    let bob = person(&app, "Bob").await;

    let page: AdminUserPage = admin.get("/api/admin/users").await.json();
    assert_eq!(page.total, 3);
    let ids: Vec<&str> = page.items.iter().map(|user| user.id.as_str()).collect();
    assert_eq!(ids[..2], [bob.me.id.as_str(), ming.me.id.as_str()]);
    let first = &page.items[0];
    assert_eq!(first.status, UserStatus::Active);
    assert!(first.invite_code.as_deref().unwrap().starts_with("TEST"));
    assert!(first.last_login_at.is_some());
    assert_eq!(page.items[2].handle, "admin");
    assert_eq!(page.items[2].invite_code, None);
    // 应答里没有密码之类的东西
    let text = admin.get("/api/admin/users").await.text();
    assert!(!text.contains("password") && !text.contains("email"));

    let found: AdminUserPage = admin.get("/api/admin/users?search=bOb").await.json();
    assert_eq!((found.items.len(), found.total), (1, 1));
    let none: AdminUserPage = admin
        .get("/api/admin/users?status=disabled&page=1&page_size=5")
        .await
        .json();
    assert_eq!(none.total, 0);
    let bad = admin.get("/api/admin/users?page=0").await;
    refused(&bad, StatusCode::BAD_REQUEST, ErrorCode::BadRequest);
    let bad = admin.get("/api/admin/users?status=gone").await;
    refused(&bad, StatusCode::BAD_REQUEST, ErrorCode::BadRequest);
}

#[tokio::test]
async fn a_disabled_user_is_cut_off_at_once_and_comes_back_when_enabled() {
    let (app, mut admin) = app_with_admin().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    say(&mut a, &conversation, json!({ "text": "在吗" })).await;
    // 他已经建立的连接
    let session = app.state.accounts.authenticate(a.client.token()).await;
    let session = session.unwrap().unwrap().session.id;
    let user: UserId = a.me.id.parse().unwrap();
    let mut connection = app.state.hub.register(user, session).events;

    let path = format!("/api/admin/users/{}/disable", a.me.id);
    let disabled: AdminUserView = admin.post_empty(&path).await.json();
    assert_eq!(disabled.status, UserStatus::Disabled);

    // 连接被断开，登录失效，再登录被拒绝并说明原因
    assert!(connection.recv().await.is_none());
    assert_eq!(app.state.hub.connection_count(), 0);
    let me = a.client.get("/api/me").await;
    refused(&me, StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized);
    let login = json!({ "handle": a.me.handle, "password": PASSWORD });
    let reply = a.client.post("/api/auth/login", login.clone()).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::AccountDisabled);
    let listed: AdminUserPage = admin.get("/api/admin/users?status=disabled").await.json();
    assert_eq!(listed.items[0].id, a.me.id);

    // 别人给他发的消息照常保存
    say(&mut b, &conversation, json!({ "text": "你去哪了" })).await;

    let path = format!("/api/admin/users/{}/enable", a.me.id);
    let enabled: AdminUserView = admin.post_empty(&path).await.json();
    assert_eq!(enabled.status, UserStatus::Active);
    let reply = a.client.post("/api/auth/login", login).await;
    assert_eq!(reply.status, StatusCode::OK);
    let history = format!("/api/conversations/{conversation}/messages");
    let page: MessageList = a.client.get(&history).await.json();
    assert_eq!(page.items.last().unwrap().text.as_deref(), Some("你去哪了"));

    let entries = audit(&mut admin).await;
    let actions: Vec<AuditAction> = entries.iter().map(|entry| entry.action).collect();
    assert_eq!(
        actions,
        [AuditAction::UserEnabled, AuditAction::UserDisabled]
    );
    assert_eq!(entries[0].target.as_deref(), Some(a.me.id.as_str()));
    let label = format!("小明 ({})", a.me.handle);
    assert_eq!(entries[0].label.as_deref(), Some(label.as_str()));
}

#[tokio::test]
async fn an_administrator_cannot_disable_or_reset_their_own_account() {
    let (_app, mut admin) = app_with_admin().await;
    let me: Me = admin.get("/api/me").await.json();
    for action in ["disable", "reset-password"] {
        let path = format!("/api/admin/users/{}/{action}", me.id);
        let reply = admin.post_empty(&path).await;
        refused(&reply, StatusCode::FORBIDDEN, ErrorCode::CannotTargetSelf);
    }
    for id in ["not-an-id", "01900000-0000-7000-8000-000000000000"] {
        let reply = admin
            .post_empty(&format!("/api/admin/users/{id}/disable"))
            .await;
        refused(&reply, StatusCode::NOT_FOUND, ErrorCode::UserNotFound);
    }
    assert_eq!(admin.get("/api/me").await.status, StatusCode::OK);
    assert!(audit(&mut admin).await.is_empty());
}

#[tokio::test]
async fn after_a_reset_the_user_must_change_the_temporary_password_first() {
    let (app, mut admin) = app_with_admin().await;
    let mut a = person(&app, "小明").await;

    let path = format!("/api/admin/users/{}/reset-password", a.me.id);
    let reset: ResetPasswordResponse = admin.post_empty(&path).await.json();
    assert_eq!(reset.user.id, a.me.id);
    assert_eq!(reset.password.chars().count(), 12);

    // 原来的登录失效了，原来的密码也不能用了
    let me = a.client.get("/api/me").await;
    assert_eq!(me.status, StatusCode::UNAUTHORIZED);
    let old = json!({ "handle": a.me.handle, "password": PASSWORD });
    let reply = a.client.post("/api/auth/login", old).await;
    refused(
        &reply,
        StatusCode::UNAUTHORIZED,
        ErrorCode::InvalidCredentials,
    );

    // 用临时密码登录：只能先改密码
    let temporary = json!({ "handle": a.me.handle, "password": reset.password });
    let reply = a.client.post("/api/auth/login", temporary).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(reply.json::<Me>().must_change_password);
    let blocked = a.client.get("/api/conversations").await;
    refused(
        &blocked,
        StatusCode::FORBIDDEN,
        ErrorCode::MustChangePassword,
    );
    let change = json!({ "current_password": reset.password, "new_password": "my-own-pass-3" });
    let reply = a.client.put("/api/me/password", change).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(
        a.client.get("/api/conversations").await.status,
        StatusCode::OK
    );

    // 操作记录里没有临时密码
    let text = admin.get("/api/admin/audit").await.text();
    assert!(text.contains("password_reset"));
    assert!(!text.contains(&reset.password));
}

// ---------- 系统设置和概况 ----------

/// 通话画面的参数（F7）：管理员改了，下一次取中转账号时就带着新的；超出范围的拒绝。
#[tokio::test]
async fn call_video_settings_reach_the_next_call() {
    let (app, mut admin) = app_with_admin().await;
    let mut a = person(&app, "小明").await;
    let settings: SettingsView = admin.get("/api/admin/settings").await.json();
    assert_eq!(settings.screen_max_width, 2560);
    assert_eq!(settings.screen_direct_kbps_range.min, 1000);
    assert_eq!(settings.screen_direct_kbps_range.default, Some(6000));
    let servers: IceServers = a.client.get("/api/calls/ice-servers").await.json();
    assert_eq!(servers.video.screen_direct_kbps, 6000);
    assert_eq!(servers.video.camera_relay_kbps, 500);
    // 群视频两档画面的码率（F11）：默认 400 和 120，页面进群视频通话时按它发
    assert_eq!(
        (
            servers.video.group_camera_high_kbps,
            servers.video.group_camera_low_kbps
        ),
        (400, 120)
    );
    assert_eq!(settings.group_camera_high_kbps_range.default, Some(400));
    assert_eq!(settings.group_camera_low_kbps_range.max, 250);
    let change = json!({ "group_camera_high_kbps": 600, "group_camera_low_kbps": 100 });
    let reply = admin.put("/api/admin/settings", change).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let servers: IceServers = a.client.get("/api/calls/ice-servers").await.json();
    assert_eq!(
        (
            servers.video.group_camera_high_kbps,
            servers.video.group_camera_low_kbps
        ),
        (600, 100)
    );
    let reply = admin
        .put(
            "/api/admin/settings",
            json!({ "group_camera_low_kbps": 300 }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    // 群通话里共享的屏幕的码率（F12）：默认 1000，可以设 300 到 3000
    assert_eq!(servers.video.group_screen_kbps, 1000);
    assert_eq!(
        (
            settings.group_screen_kbps_range.min,
            settings.group_screen_kbps_range.max,
            settings.group_screen_kbps_range.default
        ),
        (300, 3000, Some(1000))
    );
    let reply = admin
        .put("/api/admin/settings", json!({ "group_screen_kbps": 1500 }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let servers: IceServers = a.client.get("/api/calls/ice-servers").await.json();
    assert_eq!(servers.video.group_screen_kbps, 1500);
    for bad in [299, 3001] {
        let reply = admin
            .put("/api/admin/settings", json!({ "group_screen_kbps": bad }))
            .await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    }

    let change = json!({ "screen_direct_kbps": 10000, "screen_max_fps": 20 });
    let reply = admin.put("/api/admin/settings", change).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let servers: IceServers = a.client.get("/api/calls/ice-servers").await.json();
    assert_eq!(
        (
            servers.video.screen_direct_kbps,
            servers.video.screen_max_fps
        ),
        (10000, 20)
    );

    let reply = admin
        .put("/api/admin/settings", json!({ "screen_max_width": 640 }))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_smaller_file_limit_applies_to_the_very_next_upload() {
    let (app, mut admin) = app_with_admin().await;
    let mut a = person(&app, "小明").await;
    let settings: SettingsView = admin.get("/api/admin/settings").await.json();
    assert_eq!(settings.file_max_bytes, 100 * 1024 * 1024);
    assert_eq!(settings.group_max_members, 10);
    assert_eq!(settings.retention_days, None);
    assert_eq!(settings.file_max_bytes_range.min, 1024 * 1024);
    assert_eq!(settings.file_max_bytes_range.max, 1024 * 1024 * 1024);
    assert_eq!(
        settings.file_max_bytes_range.default,
        Some(100 * 1024 * 1024)
    );
    assert_eq!(settings.retention_days_range.default, None);
    assert_eq!(settings.recall_window_seconds_range.min, 0);

    let megabyte = 1024 * 1024;
    let content = vec![7u8; megabyte + 1];
    let before = upload_raw(&mut a, "big.bin", &content).await;
    assert_eq!(before.status, StatusCode::CREATED);
    before.json::<FileView>();

    let change = json!({ "file_max_bytes": megabyte, "retention_days": 30 });
    let reply = admin.put("/api/admin/settings", change).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let updated: SettingsView = reply.json();
    assert_eq!(updated.file_max_bytes, megabyte as u64);
    assert_eq!(updated.retention_days, Some(30));
    // 没有带上的项不变
    assert_eq!(updated.voice_max_seconds, 60);

    // 不用重启：下一次上传就按新的上限
    let after = upload_raw(&mut a, "big.bin", &content).await;
    refused(
        &after,
        StatusCode::PAYLOAD_TOO_LARGE,
        ErrorCode::FileTooLarge,
    );
    let limits: LimitsView = a.client.get("/api/limits").await.json();
    assert_eq!(limits.file_max_bytes, megabyte as u64);

    // 0 表示永久保留
    let forever = admin.put("/api/admin/settings", json!({ "retention_days": 0 }));
    assert_eq!(forever.await.json::<SettingsView>().retention_days, None);

    for bad in [
        json!({ "file_max_bytes": 1000 }),
        json!({ "group_max_members": 2 }),
        json!({ "voice_max_seconds": 301 }),
        json!({ "recall_window_seconds": 86401 }),
        json!({ "retention_days": 3651 }),
    ] {
        let reply = admin.put("/api/admin/settings", bad.clone()).await;
        refused(
            &reply,
            StatusCode::BAD_REQUEST,
            ErrorCode::SettingOutOfRange,
        );
    }
    let wrong_type = admin.put("/api/admin/settings", json!({ "retention_days": "x" }));
    assert_eq!(wrong_type.await.status, StatusCode::BAD_REQUEST);

    // 每一项修改都有记录，写着从多少改成了多少
    let entries = audit(&mut admin).await;
    let changes: Vec<(&str, &str, &str)> = entries
        .iter()
        .rev()
        .map(|entry| {
            assert_eq!(entry.action, AuditAction::SettingChanged);
            (
                entry.key.as_deref().unwrap(),
                entry.from.as_deref().unwrap(),
                entry.to.as_deref().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            ("file_max_bytes", "104857600", "1048576"),
            ("retention_days", "0", "30"),
            ("retention_days", "30", "0"),
        ]
    );
}

#[tokio::test]
async fn the_overview_counts_users_connections_groups_and_files() {
    let (app, mut admin) = app_with_admin().await;
    let (mut owner, one, _, _) = group(&app, "项目组").await;
    upload_raw(&mut owner, "a.bin", &[1, 2, 3, 4, 5]).await;
    let _first = Inbox::open(&app, &owner.me.id);
    // 同一个人的两处登录只算一个在线的人
    let _second = Inbox::open(&app, &owner.me.id);
    let _other = Inbox::open(&app, &one.me.id);
    admin
        .post_empty(&format!("/api/admin/users/{}/disable", one.me.id))
        .await;

    let overview: OverviewView = admin.get("/api/admin/overview").await.json();
    assert_eq!(overview.users_total, 4);
    assert_eq!(overview.users_disabled, 1);
    assert_eq!(overview.online, 2);
    assert_eq!(overview.groups, 1);
    assert_eq!(overview.files_count, 1);
    assert_eq!(overview.files_bytes, 5);
}

// ---------- 查看聊天内容 ----------

#[tokio::test]
async fn a_view_is_recorded_and_shows_recalled_messages_with_their_content() {
    let (app, mut admin) = app_with_admin().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let wrong = say(&mut a, &conversation, json!({ "text": "说错了的话" })).await;
    let uploaded = upload_raw(&mut a, "photo.png", &fake_image()).await;
    let file: FileView = uploaded.json();
    let photo = say(&mut a, &conversation, json!({ "file_id": file.id })).await;
    let reply = json!({ "text": "什么？", "reply_to": wrong.seq });
    say(&mut b, &conversation, reply).await;
    recall(&mut a, &conversation, wrong.seq).await;
    recall(&mut a, &conversation, photo.seq).await;

    // 先按用户找到会话：这一步看不到内容，也不留记录
    let path = format!("/api/admin/users/{}/conversations", a.me.id);
    let found: AdminConversationList = admin.get(&path).await.json();
    assert_eq!(found.user.id, a.me.id);
    assert_eq!(found.items.len(), 1);
    assert_eq!(found.items[0].id, conversation);
    assert_eq!(found.items[0].kind, ConversationKind::Direct);
    let names: Vec<&str> = found.items[0]
        .people
        .iter()
        .map(|p| p.nickname.as_str())
        .collect();
    assert_eq!(names, ["小明", "小红"]);
    assert!(audit(&mut admin).await.is_empty());

    let started = start_view(&mut admin, &conversation).await;
    assert_eq!(started.conversation.id, conversation);
    assert_eq!(started.members.len(), 2);
    assert_eq!(started.expires_at, app.clock_now() + VIEW_TTL_MS);
    let view = &started.view;

    let path = format!("/api/admin/conversations/{conversation}/messages?view={view}");
    let page: MessageList = admin.get(&path).await.json();
    let by_seq = |seq: i64| page.items.iter().find(|m| m.seq == seq).unwrap();
    // 已撤回的消息带着原内容，并标明已撤回
    let recalled = by_seq(wrong.seq);
    assert!(recalled.recalled);
    assert_eq!(recalled.text.as_deref(), Some("说错了的话"));
    assert_eq!(recalled.sender_name.as_deref(), Some("小明"));
    let image = by_seq(photo.seq);
    assert!(image.recalled);
    assert_eq!(image.file.as_ref().unwrap().id, file.id);
    let quote = page.items.iter().find_map(|m| m.reply.as_ref()).unwrap();
    assert_eq!(quote.state, QuoteState::Shown);

    // 编辑过的（F8）：管理员看得到每一次修改之前的内容
    let said = say(&mut b, &conversation, json!({ "text": "第一版" })).await;
    let path = format!("/api/conversations/{conversation}/messages/{}", said.seq);
    for text in ["第二版", "第三版"] {
        let reply = b.client.put(&path, json!({ "text": text })).await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }
    let path = format!("/api/admin/conversations/{conversation}/messages?view={view}");
    let page: MessageList = admin.get(&path).await.json();
    let edited = page.items.iter().find(|m| m.seq == said.seq).unwrap();
    assert_eq!(edited.text.as_deref(), Some("第三版"));
    assert!(edited.edited_at.is_some());
    let history: Vec<(&str, &str)> = page
        .items
        .iter()
        .filter(|m| m.kind == MessageKind::Edited && m.target_seq == Some(said.seq))
        .map(|m| {
            (
                m.previous_text.as_deref().unwrap(),
                m.text.as_deref().unwrap(),
            )
        })
        .collect();
    assert_eq!(history, [("第一版", "第二版"), ("第二版", "第三版")]);
    assert_eq!(quote.text.as_deref(), Some("说错了的话"));
    // 翻页的参数和普通会话一样
    let older = format!("{path}&before={}&limit=1", wrong.seq + 1);
    let older: MessageList = admin.get(&older).await.json();
    assert_eq!(older.items.len(), 1);
    assert_eq!(older.items[0].seq, wrong.seq);

    // 成员自己看到的仍然没有内容，文件也读不到
    let mine = format!("/api/conversations/{conversation}/messages");
    let mine: MessageList = b.client.get(&mine).await.json();
    let hidden = mine.items.iter().find(|m| m.seq == wrong.seq).unwrap();
    assert!(hidden.recalled && hidden.text.is_none());
    let denied = b.client.get(&format!("/api/files/{}", file.id)).await;
    assert_eq!(denied.status, StatusCode::NOT_FOUND);

    // 管理员带着凭据能读到已撤回消息的文件和缩略图
    let base = format!("/api/admin/conversations/{conversation}/files/{}", file.id);
    let content = admin.get(&format!("{base}?view={view}")).await;
    assert_eq!(content.status, StatusCode::OK);
    assert_eq!(content.body, fake_image());
    assert_eq!(content.headers[header::CONTENT_DISPOSITION], "inline");
    let download = admin.get(&format!("{base}?view={view}&download=1")).await;
    let disposition = download.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap();
    assert!(disposition.starts_with("attachment; filename=\"photo.png\""));
    let thumbnail = admin.get(&format!("{base}/thumbnail?view={view}")).await;
    assert_eq!(thumbnail.status, StatusCode::OK);
    assert_eq!(thumbnail.body, b"THUMB");
    // 管理员不是成员：普通的读文件接口照样拒绝他
    let plain = admin.get(&format!("/api/files/{}", file.id)).await;
    assert_eq!(plain.status, StatusCode::NOT_FOUND);

    // 这一次查看只有一条记录，写着看的是哪个会话
    let entries = audit(&mut admin).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action, AuditAction::ChatViewed);
    assert_eq!(entries[0].target.as_deref(), Some(conversation.as_str()));
    assert_eq!(entries[0].label.as_deref(), Some("小明 / 小红"));
    assert_eq!(entries[0].key.as_deref(), Some("direct"));
    let only: AuditPage = admin
        .get("/api/admin/audit?action=chat_viewed&page_size=1")
        .await
        .json();
    assert_eq!((only.items.len(), only.total), (1, 1));
    let other: AuditPage = admin
        .get("/api/admin/audit?action=user_disabled")
        .await
        .json();
    assert_eq!(other.total, 0);
}

#[tokio::test]
async fn nothing_can_be_read_without_a_valid_view_of_that_conversation() {
    let (app, mut admin) = app_with_admin().await;
    let (mut a, _, conversation) = pair(&app).await;
    let file: FileView = upload_raw(&mut a, "photo.png", &fake_image()).await.json();
    say(&mut a, &conversation, json!({ "file_id": file.id })).await;
    let (mut owner, _, _, other) = group(&app, "项目组").await;
    say(&mut owner, &other, json!({ "text": "群里的话" })).await;

    let messages = |conversation: &str, view: &str| {
        format!("/api/admin/conversations/{conversation}/messages?view={view}")
    };
    let files = |conversation: &str, view: &str| {
        format!(
            "/api/admin/conversations/{conversation}/files/{}?view={view}",
            file.id
        )
    };
    // 没有凭据、乱写的凭据
    let bare = format!("/api/admin/conversations/{conversation}/messages");
    let reply = admin.get(&bare).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::ViewRequired);
    let reply = admin.get(&messages(&conversation, "made-up")).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::ViewRequired);
    let reply = admin.get(&files(&conversation, "made-up")).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert!(audit(&mut admin).await.is_empty());

    let started = start_view(&mut admin, &conversation).await;
    let view = started.view.as_str();
    assert_eq!(
        admin.get(&messages(&conversation, view)).await.status,
        StatusCode::OK
    );

    // 凭据是别的会话的
    let reply = admin.get(&messages(&other, view)).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::ViewRequired);
    let reply = admin.get(&files(&other, view)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // 管理员在别处的登录不能借用这一次的凭据
    let mut elsewhere = app.client();
    let login = json!({ "handle": "admin", "password": ADMIN_PASSWORD });
    assert_eq!(
        elsewhere.post("/api/auth/login", login).await.status,
        StatusCode::OK
    );
    let reply = elsewhere.get(&messages(&conversation, view)).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::ViewRequired);

    // 凭据过期
    app.clock.advance(VIEW_TTL_MS);
    let reply = admin.get(&messages(&conversation, view)).await;
    refused(&reply, StatusCode::FORBIDDEN, ErrorCode::ViewRequired);
    let reply = admin.get(&files(&conversation, view)).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // 不存在的会话开始不了查看
    for id in ["not-an-id", "01900000-0000-7000-8000-000000000000"] {
        let path = format!("/api/admin/conversations/{id}/views");
        let reply = admin.post_empty(&path).await;
        refused(
            &reply,
            StatusCode::NOT_FOUND,
            ErrorCode::ConversationNotFound,
        );
    }
    assert_eq!(audit(&mut admin).await.len(), 1);
}

#[tokio::test]
async fn a_view_cannot_be_started_when_it_cannot_be_recorded() {
    let (app, mut admin) = app_with_admin().await;
    let (_, _, conversation) = pair(&app).await;
    app.store
        .audit_writable
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let path = format!("/api/admin/conversations/{conversation}/views");
    let reply = admin.post_empty(&path).await;
    refused(
        &reply,
        StatusCode::SERVICE_UNAVAILABLE,
        ErrorCode::Unavailable,
    );
    assert!(!reply.text().contains("view"));
}

#[tokio::test]
async fn the_viewing_endpoints_only_read() {
    let (app, mut admin) = app_with_admin().await;
    let (mut a, _, conversation) = pair(&app).await;
    let sent = say(&mut a, &conversation, json!({ "text": "原样留着" })).await;
    let view = start_view(&mut admin, &conversation).await.view;
    let base = format!("/api/admin/conversations/{conversation}");

    let body = || Body::from(json!({ "client_id": "c-x", "text": "管理员的话" }).to_string());
    let request = |method: Method, path: String| {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
    };
    // 取消息和取文件的地址上，除了"读"之外的方法都不存在
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        for path in [
            format!("{base}/messages?view={view}"),
            format!("{base}/files/{}?view={view}", a.me.id),
            format!("{base}/members"),
        ] {
            let reply = admin
                .send(request(method.clone(), path.clone()), body())
                .await;
            assert_eq!(
                reply.status,
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path}"
            );
        }
    }
    for method in [Method::GET, Method::PUT, Method::PATCH, Method::DELETE] {
        let reply = admin
            .send(request(method.clone(), format!("{base}/views")), body())
            .await;
        assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }
    // 管理接口里没有撤回、已读之类的地址
    for path in [
        format!("{base}/messages/{}/recall?view={view}", sent.seq),
        format!("{base}/read?view={view}"),
        format!("{base}/messages/{}?view={view}", sent.seq),
    ] {
        let reply = admin
            .send(request(Method::POST, path.clone()), body())
            .await;
        assert_eq!(reply.status, StatusCode::NOT_FOUND, "{path}");
    }
    // 管理员不是成员：普通的发消息、撤回接口照样拒绝他
    let plain = format!("/api/conversations/{conversation}/messages");
    let reply = admin.send(request(Method::POST, plain), body()).await;
    refused(
        &reply,
        StatusCode::NOT_FOUND,
        ErrorCode::ConversationNotFound,
    );
    // 操作记录也只能读
    for method in [Method::POST, Method::PUT, Method::PATCH, Method::DELETE] {
        let reply = admin
            .send(
                request(method.clone(), "/api/admin/audit".to_owned()),
                body(),
            )
            .await;
        assert_eq!(reply.status, StatusCode::METHOD_NOT_ALLOWED, "{method}");
    }

    let path = format!("{base}/messages?view={view}");
    let page: MessageList = admin.get(&path).await.json();
    let texts: Vec<Option<&str>> = page.items.iter().map(|m| m.text.as_deref()).collect();
    assert!(texts.contains(&Some("原样留着")));
    assert!(!texts.contains(&Some("管理员的话")));
}

// ---------- 群 ----------

#[tokio::test]
async fn every_group_is_listed_with_its_owner_and_members() {
    let (app, mut admin) = app_with_admin().await;
    let (owner, one, _, first) = group(&app, "Alpha 项目").await;
    app.clock.advance(1000);
    let (_, _, _, second) = group(&app, "").await;
    pair(&app).await;

    let page: AdminGroupPage = admin.get("/api/admin/groups").await.json();
    assert_eq!(page.total, 2);
    let ids: Vec<&str> = page.items.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(ids, [second.as_str(), first.as_str()]);
    let alpha = &page.items[1];
    assert_eq!(alpha.name.as_deref(), Some("Alpha 项目"));
    assert_eq!(alpha.owner.as_ref().unwrap().id, owner.me.id);
    assert_eq!((alpha.member_count, alpha.dissolved), (3, false));
    assert!(alpha.last_at.is_some());
    // 没有起名的群带着最早几个人的名字
    assert_eq!(page.items[0].name, None);
    assert_eq!(page.items[0].people.len(), 3);

    let found: AdminGroupPage = admin.get("/api/admin/groups?search=alpha").await.json();
    assert_eq!((found.items.len(), found.total), (1, 1));

    let path = format!("/api/admin/conversations/{first}/members");
    let members: AdminMemberList = admin.get(&path).await.json();
    assert_eq!(members.conversation.id, first);
    assert_eq!(members.items.len(), 3);
    assert!(members.items[0].is_owner && members.items[0].active);
    assert_eq!(members.items[1].user.id, one.me.id);
    // 看成员不算查看聊天内容
    assert!(audit(&mut admin).await.is_empty());
}

#[tokio::test]
async fn an_administrator_dissolves_a_group_and_every_member_is_told() {
    let (app, mut admin) = app_with_admin().await;
    let (mut owner, one, _, id) = group(&app, "项目组").await;
    let (_, _, direct) = pair(&app).await;
    let mut inbox = Inbox::open(&app, &one.me.id);

    let path = format!("/api/admin/conversations/{id}/dissolve");
    let reply = admin.post_empty(&path).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert!(reply.json::<AdminConversationView>().dissolved);

    // 成员实时看到：一条没有写是谁做的"解散"事件
    let pushed: Vec<MessageView> = inbox
        .events()
        .into_iter()
        .filter_map(|event| match event {
            ServerEvent::MsgNew(message) => Some(*message),
            _ => None,
        })
        .collect();
    assert_eq!(pushed.len(), 1);
    assert_eq!(pushed[0].kind, MessageKind::Dissolved);
    assert_eq!(pushed[0].actor, None);

    // 之后谁都不能再发消息
    let send = format!("/api/conversations/{id}/messages");
    let body = json!({ "client_id": "c-after", "text": "还能说话吗" });
    let reply = owner.client.post(&send, body).await;
    refused(&reply, StatusCode::CONFLICT, ErrorCode::GroupDissolved);

    let again = admin.post_empty(&path).await;
    refused(&again, StatusCode::CONFLICT, ErrorCode::GroupDissolved);
    let path = format!("/api/admin/conversations/{direct}/dissolve");
    let reply = admin.post_empty(&path).await;
    refused(
        &reply,
        StatusCode::NOT_FOUND,
        ErrorCode::ConversationNotFound,
    );

    let entries = audit(&mut admin).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action, AuditAction::GroupDissolved);
    assert_eq!(entries[0].label.as_deref(), Some("项目组"));
    let listed: AdminGroupPage = admin.get("/api/admin/groups").await.json();
    assert!(listed.items[0].dissolved);
}

// ---------- 邀请码 ----------

#[tokio::test]
async fn invite_code_operations_leave_a_record() {
    let (_app, mut admin) = app_with_admin().await;
    let created = admin
        .post("/api/admin/invite-codes", json!({ "count": 3 }))
        .await;
    let ids: Vec<String> = created
        .json::<InviteCodeList>()
        .items
        .into_iter()
        .map(|invite| invite.id)
        .collect();
    let revoke = format!("/api/admin/invite-codes/{}/revoke", ids[0]);
    assert_eq!(admin.post_empty(&revoke).await.status, StatusCode::OK);
    let batch = json!({ "ids": ids });
    admin
        .post("/api/admin/invite-codes/revoke", batch.clone())
        .await;
    admin.post("/api/admin/invite-codes/delete", batch).await;
    // 不合规则的请求不留记录
    let bad = admin
        .post("/api/admin/invite-codes", json!({ "count": 0 }))
        .await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);

    let entries = audit(&mut admin).await;
    let summary: Vec<(AuditAction, Option<u32>)> = entries
        .iter()
        .rev()
        .map(|entry| (entry.action, entry.count))
        .collect();
    assert_eq!(
        summary,
        [
            (AuditAction::InviteCodesCreated, Some(3)),
            (AuditAction::InviteCodesRevoked, Some(1)),
            (AuditAction::InviteCodesRevoked, Some(2)),
            (AuditAction::InviteCodesDeleted, Some(3)),
        ]
    );
}

// ---------- 找回密码和修改邮箱 ----------

#[tokio::test]
async fn the_administrator_recovers_the_password_through_a_link_that_works_once() {
    let (app, mut admin) = app_with_admin().await;
    let mut visitor = app.client();

    // 邮箱不对：回答一样，但没有邮件
    let wrong = json!({ "email": "someone@example.com" });
    let reply = visitor.post("/api/auth/password-reset", wrong).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(reply.body.is_empty());
    assert!(app.outbox.sent().is_empty());

    let right = json!({ "email": "Admin@Example.com" });
    let reply = visitor.post("/api/auth/password-reset", right).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert!(reply.body.is_empty());
    let sent = app.outbox.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "admin@example.com");
    let token = app.outbox.last_token().unwrap();
    // 链接指向用户访问系统用的地址（测试里的管理服务配的是这个）
    let link = format!("http://vibe.test/reset-password?token={token}");
    assert!(sent[0].body.contains(&link));

    let weak = json!({ "token": token, "new_password": "short" });
    let reply = visitor.post("/api/auth/password-reset/confirm", weak).await;
    refused(&reply, StatusCode::BAD_REQUEST, ErrorCode::PasswordTooWeak);

    let confirm = json!({ "token": token, "new_password": "recovered-pass-9" });
    let reply = visitor
        .post("/api/auth/password-reset/confirm", confirm.clone())
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);

    // 以前的登录全部失效；旧密码不能用，新密码可以
    assert_eq!(admin.get("/api/me").await.status, StatusCode::UNAUTHORIZED);
    let old = json!({ "handle": "admin", "password": ADMIN_PASSWORD });
    let reply = visitor.post("/api/auth/login", old).await;
    refused(
        &reply,
        StatusCode::UNAUTHORIZED,
        ErrorCode::InvalidCredentials,
    );
    let new = json!({ "handle": "admin", "password": "recovered-pass-9" });
    let reply = visitor.post("/api/auth/login", new).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert!(!reply.json::<Me>().must_change_password);

    // 同一个链接再用一次；乱写的链接：说法相同
    let reused = visitor
        .post("/api/auth/password-reset/confirm", confirm)
        .await;
    refused(&reused, StatusCode::BAD_REQUEST, ErrorCode::LinkInvalid);
    let forged = json!({ "token": "made-up", "new_password": "recovered-pass-9" });
    let forged = visitor
        .post("/api/auth/password-reset/confirm", forged)
        .await;
    refused(&forged, StatusCode::BAD_REQUEST, ErrorCode::LinkInvalid);
    assert_eq!(reused.error().message, forged.error().message);
}

#[tokio::test]
async fn an_expired_reset_link_is_refused_and_requests_are_rate_limited() {
    let (app, mut admin) = app_with_admin().await;
    let mut visitor = app.client();
    let ask = json!({ "email": "admin@example.com" });
    visitor.post("/api/auth/password-reset", ask.clone()).await;
    let token = app.outbox.last_token().unwrap();
    app.clock.advance(LINK_TTL_MS);
    let confirm = json!({ "token": token, "new_password": "recovered-pass-9" });
    let reply = visitor
        .post("/api/auth/password-reset/confirm", confirm)
        .await;
    refused(&reply, StatusCode::BAD_REQUEST, ErrorCode::LinkInvalid);
    assert_eq!(admin.get("/api/me").await.status, StatusCode::OK);

    let mut last = visitor.post("/api/auth/password-reset", ask.clone()).await;
    for _ in 0..5 {
        last = visitor.post("/api/auth/password-reset", ask.clone()).await;
    }
    refused(
        &last,
        StatusCode::TOO_MANY_REQUESTS,
        ErrorCode::TooManyRequests,
    );
    assert!(last.error().retry_after_secs.unwrap() > 0);
}

#[tokio::test]
async fn a_new_email_takes_effect_only_after_the_link_in_it_is_opened() {
    let (app, mut admin) = app_with_admin().await;
    let me: Me = admin.get("/api/me").await.json();
    let mut inbox = Inbox::open(&app, &me.id);

    let wrong = json!({ "current_password": "not-my-pass-1", "email": "new@example.com" });
    let reply = admin.put("/api/me/email", wrong).await;
    refused(
        &reply,
        StatusCode::BAD_REQUEST,
        ErrorCode::PasswordIncorrect,
    );
    let invalid = json!({ "current_password": ADMIN_PASSWORD, "email": "not-an-email" });
    let reply = admin.put("/api/me/email", invalid).await;
    refused(&reply, StatusCode::BAD_REQUEST, ErrorCode::EmailInvalid);
    assert!(app.outbox.sent().is_empty());

    let change = json!({ "current_password": ADMIN_PASSWORD, "email": "new@example.com" });
    let reply = admin.put("/api/me/email", change).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    assert_eq!(app.outbox.sent()[0].to, "new@example.com");
    let token = app.outbox.last_token().unwrap();
    let link = format!("http://vibe.test/confirm-email?token={token}");
    assert!(app.outbox.sent()[0].body.contains(&link));

    // 没有确认之前，旧邮箱照常有效
    let me: Me = admin.get("/api/me").await.json();
    assert_eq!(me.email.as_deref(), Some("admin@example.com"));
    let mut visitor = app.client();
    let old = json!({ "email": "admin@example.com" });
    visitor.post("/api/auth/password-reset", old.clone()).await;
    assert_eq!(app.outbox.sent()[1].to, "admin@example.com");

    // 确认的链接本身就是凭据，不要求登录
    let confirm = json!({ "token": token });
    let reply = visitor
        .post("/api/auth/email-confirm", confirm.clone())
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json::<EmailConfirmed>().email, "new@example.com");
    let me: Me = admin.get("/api/me").await.json();
    assert_eq!(me.email.as_deref(), Some("new@example.com"));
    // 开着的页面上，邮箱跟着变
    let pushed = inbox.events();
    assert!(matches!(
        &pushed[..],
        [ServerEvent::MeUpdated(me)] if me.email.as_deref() == Some("new@example.com")
    ));

    let reused = visitor.post("/api/auth/email-confirm", confirm).await;
    refused(&reused, StatusCode::BAD_REQUEST, ErrorCode::LinkInvalid);
    // 之后找回密码的邮件发到新邮箱，旧邮箱不再有效
    visitor.post("/api/auth/password-reset", old).await;
    assert_eq!(app.outbox.sent().len(), 2);
    let new = json!({ "email": "new@example.com" });
    visitor.post("/api/auth/password-reset", new).await;
    assert_eq!(app.outbox.sent()[2].to, "new@example.com");
}
