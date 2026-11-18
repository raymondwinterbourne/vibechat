//! 管理功能的业务规则的测试。数据在内存里，时间可以拨动。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use super::service::{LINK_TTL_MS, VIEW_TTL_MS};
use super::{AdminError, AdminService, AuditAction, Paging, SettingsChange, ViewStarted};
use crate::account::handle::ADMIN_HANDLE;
use crate::account::model::{Language, ProfileChanges, StoredFile, User, UserStatus};
use crate::account::store::{FileStore, UserStore};
use crate::account::{
    AccountError, AccountService, AuthContext, Limits as AccountLimits, NewInviteCodes,
    Registration,
};
use crate::chat::{
    Attached, ChatError, ChatService, ConversationKind, Draft, HistoryQuery, Message, MessageKind,
    Quote,
};
use crate::clock::Clock;
use crate::contact::ContactService;
use crate::file::{FileError, FileService};
use crate::ids::{ConversationId, UserId};
use crate::limits::{CallVideo, Limits};
use crate::testing::{
    ManualClock, MemoryStore, Outbox, account_service, admin_service, byte_stream, chat_service,
    contact_service, fake_image, file_service,
};

const ADMIN_PASSWORD: &str = "initial-pass-1";
const USER_PASSWORD: &str = "correct-horse-1";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    accounts: Arc<AccountService>,
    contacts: ContactService,
    chat: Arc<ChatService>,
    files: FileService,
    admin: AdminService,
    outbox: Arc<Outbox>,
    /// 管理员和他的一次登录。
    boss: AuthContext,
    counter: AtomicU32,
}

async fn fixture() -> Fixture {
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let limits = AccountLimits {
        logins_per_minute: 1000,
        registrations_per_minute: 1000,
    };
    let accounts = Arc::new(account_service(&store, clock.clone(), limits).await);
    let chat = Arc::new(chat_service(&store, clock.clone()));
    let (admin, outbox) = admin_service(&store, clock.clone(), accounts.clone(), chat.clone());
    accounts
        .bootstrap_admin("boss@example.com", ADMIN_PASSWORD)
        .await
        .unwrap();
    let login = accounts.login(ADMIN_HANDLE, ADMIN_PASSWORD, "test", "10.0.0.9");
    let login = login.await.unwrap();
    Fixture {
        contacts: contact_service(&store, clock.clone()),
        files: file_service(&store, clock.clone()),
        boss: AuthContext {
            user: login.user,
            session: login.session,
        },
        accounts,
        chat,
        admin,
        outbox,
        store,
        clock,
        counter: AtomicU32::new(0),
    }
}

impl Fixture {
    fn next(&self) -> u32 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }

    async fn user(&self, nickname: &str) -> User {
        let code = format!("CODE{:012}", self.next());
        self.store.add_invite_code(&code, self.boss.user.id);
        // 注册的先后要分得出来
        self.clock.advance(1000);
        let registration = Registration {
            invite_code: &code,
            nickname,
            password: USER_PASSWORD,
            user_agent: "test",
            source: "10.0.0.1",
        };
        self.accounts.register(registration).await.unwrap().user
    }

    async fn befriend(&self, a: &User, b: &User) -> ConversationId {
        let sent = self.contacts.send_request(a, b.id, "").await.unwrap();
        self.contacts
            .accept_request(b, sent.request.id)
            .await
            .unwrap();
        let opened = self.chat.open_direct(a, b.id).await.unwrap();
        opened.conversation.id
    }

    async fn pair(&self) -> (User, User, ConversationId) {
        let (a, b) = (self.user("小明").await, self.user("小红").await);
        let conversation = self.befriend(&a, &b).await;
        (a, b, conversation)
    }

    async fn trio(&self, name: &str) -> (User, User, User, ConversationId) {
        let owner = self.user("群主").await;
        let (b, c) = (self.user("成员1").await, self.user("成员2").await);
        self.befriend(&owner, &b).await;
        self.befriend(&owner, &c).await;
        let created = self.chat.create_group(&owner, name, &[b.id, c.id]).await;
        (owner, b, c, created.unwrap().message.conversation)
    }

    async fn say(&self, from: &User, conversation: ConversationId, text: &str) -> Message {
        let client_id = format!("c-{}", self.next());
        let sent = self.chat.send_text(from, conversation, &client_id, text);
        sent.await.unwrap().message
    }

    async fn send_file(&self, from: &User, conversation: ConversationId) -> (Message, StoredFile) {
        let upload = self.files.upload(
            from,
            "photo.png",
            "image/png",
            byte_stream(&fake_image(), 4),
        );
        let file = upload.await.unwrap();
        let client_id = format!("c-{}", self.next());
        let draft = Draft {
            attachment: Some(Attached {
                file: file.id,
                voice_duration_ms: None,
            }),
            ..Draft::text(&client_id, "")
        };
        let sent = self.chat.send(from, conversation, draft).await.unwrap();
        (sent.message, file)
    }

    async fn view(&self, conversation: ConversationId) -> ViewStarted {
        self.admin
            .start_view(&self.boss, conversation)
            .await
            .unwrap()
    }

    fn actions(&self) -> Vec<AuditAction> {
        let entries = self.store.audit_entries();
        entries.iter().map(|entry| entry.action).collect()
    }

    async fn find(&self, id: UserId) -> User {
        UserStore::find(self.store.as_ref(), id)
            .await
            .unwrap()
            .unwrap()
    }
}

// ---------- 用户 ----------

#[tokio::test]
async fn the_user_list_is_searchable_and_shows_the_invite_code_used() {
    let f = fixture().await;
    let ming = f.user("小明").await;
    let bob = f.user("Bob").await;
    f.store
        .edit_user(bob.id, |user| user.status = UserStatus::Disabled);

    let (rows, total) = f
        .admin
        .list_users(None, None, Paging::default())
        .await
        .unwrap();
    // 注册晚的在前；管理员最早
    assert_eq!(total, 3);
    let ids: Vec<UserId> = rows.iter().map(|row| row.user.id).collect();
    assert_eq!(ids, [bob.id, ming.id, f.boss.user.id]);
    assert!(rows[0].invite_code.as_deref().unwrap().starts_with("CODE"));
    assert_eq!(rows[2].invite_code, None);

    // 昵称和 ID 里都找，不区分大小写
    let (rows, total) = f
        .admin
        .list_users(Some(" bOB "), None, Paging::default())
        .await
        .unwrap();
    assert_eq!((rows.len(), total), (1, 1));
    assert_eq!(rows[0].user.id, bob.id);
    let shouted = ming.handle.to_uppercase();
    let by_handle = f.admin.list_users(Some(&shouted), None, Paging::default());
    assert_eq!(by_handle.await.unwrap().0[0].user.id, ming.id);

    let disabled = f
        .admin
        .list_users(None, Some(UserStatus::Disabled), Paging::default());
    let (rows, total) = disabled.await.unwrap();
    assert_eq!((rows.len(), total), (1, 1));
    assert_eq!(rows[0].user.id, bob.id);

    // 分页：总数不随页变
    let paging = Paging {
        page: 2,
        page_size: 2,
    };
    let (rows, total) = f.admin.list_users(None, None, paging).await.unwrap();
    assert_eq!((rows.len(), total), (1, 3));
    let bad = Paging {
        page: 0,
        page_size: 20,
    };
    let refused = f.admin.list_users(None, None, bad).await;
    assert!(matches!(refused, Err(AdminError::Invalid(_))));
}

#[tokio::test]
async fn disabling_a_user_ends_their_logins_and_enabling_restores_everything() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    f.say(&a, conversation, "在吗").await;
    assert_eq!(f.store.session_count(a.id), 1);

    let (disabled, sessions) = f.admin.disable_user(&f.boss.user, a.id).await.unwrap();
    assert_eq!(disabled.status, UserStatus::Disabled);
    assert_eq!(sessions.len(), 1);
    assert_eq!(f.store.session_count(a.id), 0);
    let login = f
        .accounts
        .login(&a.handle, USER_PASSWORD, "test", "10.0.0.1");
    assert!(matches!(login.await, Err(AccountError::Disabled)));

    // 别人给他发的消息照常保存
    f.say(&b, conversation, "你去哪了").await;

    let enabled = f.admin.enable_user(&f.boss.user, a.id).await.unwrap();
    assert_eq!(enabled.status, UserStatus::Active);
    let login = f
        .accounts
        .login(&a.handle, USER_PASSWORD, "test", "10.0.0.1");
    let back = login.await.unwrap().user;
    let listed = f.chat.list(&back).await.unwrap();
    assert_eq!(listed[0].unread, 1);
    assert!(listed[0].peer.as_ref().unwrap().is_friend);

    let entries = f.store.audit_entries();
    assert_eq!(
        f.actions(),
        [AuditAction::UserDisabled, AuditAction::UserEnabled]
    );
    assert_eq!(entries[0].actor, f.boss.user.id);
    assert_eq!(entries[0].target, Some(a.id.to_string()));
    let label = entries[0].detail.label.as_deref().unwrap();
    assert_eq!(label, format!("小明 ({})", a.handle));

    // 已经是那个状态时不再记一条
    f.admin.enable_user(&f.boss.user, a.id).await.unwrap();
    assert_eq!(f.actions().len(), 2);
}

#[tokio::test]
async fn an_administrator_cannot_disable_or_reset_themselves() {
    let f = fixture().await;
    let me = &f.boss.user;
    let disabled = f.admin.disable_user(me, me.id).await;
    assert!(matches!(disabled, Err(AdminError::CannotTargetSelf)));
    let reset = f.admin.reset_password(me, me.id).await;
    assert!(matches!(reset, Err(AdminError::CannotTargetSelf)));
    let nobody = f.admin.disable_user(me, UserId::new()).await;
    assert!(matches!(nobody, Err(AdminError::UserNotFound)));
    assert!(f.actions().is_empty());
    assert_eq!(f.store.session_count(me.id), 1);
}

#[tokio::test]
async fn resetting_a_password_hands_out_a_temporary_one_that_must_be_changed() {
    let f = fixture().await;
    let a = f.user("小明").await;

    let reset = f.admin.reset_password(&f.boss.user, a.id).await.unwrap();
    assert_eq!(reset.password.chars().count(), 12);
    assert!(reset.password.chars().any(|c| c.is_ascii_digit()));
    assert!(reset.password.chars().any(char::is_alphabetic));
    assert_eq!(reset.sessions.len(), 1);
    assert_eq!(f.store.session_count(a.id), 0);

    // 原来的密码不能用了；临时密码能登录，但必须先改密码
    let old = f
        .accounts
        .login(&a.handle, USER_PASSWORD, "test", "10.0.0.1");
    assert!(matches!(old.await, Err(AccountError::InvalidCredentials)));
    let login = f
        .accounts
        .login(&a.handle, &reset.password, "test", "10.0.0.1");
    assert!(login.await.unwrap().user.must_change_password);

    // 操作记录里没有密码
    let entries = f.store.audit_entries();
    assert_eq!(f.actions(), [AuditAction::PasswordReset]);
    assert!(!format!("{:?}", entries[0]).contains(&reset.password));

    // 每次都不一样
    let again = f.admin.reset_password(&f.boss.user, a.id).await.unwrap();
    assert_ne!(again.password, reset.password);
}

#[tokio::test]
async fn nothing_happens_when_the_audit_record_cannot_be_written() {
    let f = fixture().await;
    let (owner, _, _, group) = f.trio("项目组").await;
    let boss = &f.boss.user;
    let code = f.store.add_invite_code("TOBEREVOKED00001", boss.id);
    f.store.audit_writable.store(false, Ordering::Relaxed);

    assert!(f.admin.disable_user(boss, owner.id).await.is_err());
    assert_eq!(f.find(owner.id).await.status, UserStatus::Active);
    assert_eq!(f.store.session_count(owner.id), 1);

    assert!(f.admin.reset_password(boss, owner.id).await.is_err());
    let login = f
        .accounts
        .login(&owner.handle, USER_PASSWORD, "t", "10.0.0.1");
    assert!(login.await.is_ok());

    assert!(f.admin.start_view(&f.boss, group).await.is_err());

    assert!(f.admin.dissolve_group(boss, group).await.is_err());
    assert!(
        !f.chat
            .conversation(&owner, group)
            .await
            .unwrap()
            .conversation
            .dissolved
    );

    let change = SettingsChange {
        voice_max_seconds: Some(30),
        ..SettingsChange::default()
    };
    assert!(f.admin.update_settings(boss, change).await.is_err());
    assert_eq!(f.admin.settings().await.unwrap().voice_max_seconds, 60);

    let new = NewInviteCodes {
        count: 2,
        note: None,
        expires_in_days: None,
    };
    assert!(f.admin.create_invite_codes(boss, new).await.is_err());
    assert!(f.admin.revoke_invite_codes(boss, &[code]).await.is_err());
    let listing = f.accounts.list_invite_codes(Default::default()).await;
    let page = listing.unwrap();
    // 只有测试自己放进去的那些，而且都还没有作废
    assert!(
        page.entries
            .iter()
            .all(|(invite, _)| invite.code.len() == 16)
    );
    assert!(
        page.entries
            .iter()
            .all(|(invite, _)| invite.status != crate::account::InviteCodeStatus::Revoked)
    );
    assert!(f.actions().is_empty());
}

// ---------- 邀请码 ----------

#[tokio::test]
async fn invite_code_operations_are_recorded_with_how_many_were_affected() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let new = NewInviteCodes {
        count: 3,
        note: Some("给新同事"),
        expires_in_days: None,
    };
    let codes = f.admin.create_invite_codes(boss, new).await.unwrap();
    let ids: Vec<_> = codes.iter().map(|invite| invite.id).collect();

    // 不合规则的请求不留记录
    let bad = NewInviteCodes { count: 0, ..new };
    assert!(f.admin.create_invite_codes(boss, bad).await.is_err());

    assert_eq!(
        f.admin.revoke_invite_codes(boss, &ids[..2]).await.unwrap(),
        2
    );
    // 已经作废的再作废：没有可做的，也不留记录
    assert_eq!(
        f.admin.revoke_invite_codes(boss, &ids[..2]).await.unwrap(),
        0
    );
    let single = f.admin.revoke_invite_code(boss, ids[0]).await;
    assert!(matches!(
        single,
        Err(AdminError::Account(AccountError::InviteCodeRevoked))
    ));
    f.admin.revoke_invite_code(boss, ids[2]).await.unwrap();
    assert_eq!(f.admin.delete_invite_codes(boss, &ids).await.unwrap(), 3);
    assert_eq!(f.admin.delete_invite_codes(boss, &ids).await.unwrap(), 0);

    let entries = f.store.audit_entries();
    let summary: Vec<(AuditAction, Option<u32>)> = entries
        .iter()
        .map(|entry| (entry.action, entry.detail.count))
        .collect();
    assert_eq!(
        summary,
        [
            (AuditAction::InviteCodesCreated, Some(3)),
            (AuditAction::InviteCodesRevoked, Some(2)),
            (AuditAction::InviteCodesRevoked, Some(1)),
            (AuditAction::InviteCodesDeleted, Some(3)),
        ]
    );
}

// ---------- 系统设置 ----------

#[tokio::test]
async fn settings_start_at_their_defaults_and_changes_take_effect_at_once() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let defaults = f.admin.settings().await.unwrap();
    assert_eq!(defaults.file_max_bytes, 100 * 1024 * 1024);
    assert_eq!(defaults.group_max_members, 10);
    assert_eq!(defaults.voice_max_seconds, 60);
    assert_eq!(defaults.recall_window_seconds, 120);
    assert_eq!(defaults.retention_days, None);

    let change = SettingsChange {
        file_max_bytes: Some(2 * 1024 * 1024),
        group_max_members: Some(50),
        voice_max_seconds: Some(60),
        recall_window_seconds: Some(0),
        retention_days: Some(Some(30)),
        ..SettingsChange::default()
    };
    let updated = f.admin.update_settings(boss, change).await.unwrap();
    assert_eq!(updated.file_max_bytes, 2 * 1024 * 1024);
    assert_eq!(updated.retention_days, Some(30));
    let limits = Limits::load(f.store.as_ref()).await.unwrap();
    assert_eq!(limits.file_max_bytes, 2 * 1024 * 1024);
    assert_eq!(limits.recall_window_seconds, 0);
    assert_eq!(f.chat.max_members().await.unwrap(), 50);

    // 没有变的那一项（语音时长）不留记录；其余各一条，写着从多少改成多少
    let entries = f.store.audit_entries();
    let changes: Vec<(&str, &str, &str)> = entries
        .iter()
        .map(|entry| {
            let detail = &entry.detail;
            (
                detail.key.as_deref().unwrap(),
                detail.from.as_deref().unwrap(),
                detail.to.as_deref().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            ("file_max_bytes", "104857600", "2097152"),
            ("group_max_members", "10", "50"),
            ("recall_window_seconds", "120", "0"),
            ("retention_days", "0", "30"),
        ]
    );

    // 改回永久保留
    let forever = SettingsChange {
        retention_days: Some(None),
        ..SettingsChange::default()
    };
    let updated = f.admin.update_settings(boss, forever).await.unwrap();
    assert_eq!(updated.retention_days, None);
    assert_eq!(updated.group_max_members, 50);
}

/// 通话画面的参数（F7）：默认值；改了下一通电话起生效（打电话前取到的就是新的）；各记一条操作记录；超出范围整个拒绝。
#[tokio::test]
async fn call_video_settings_have_defaults_and_ranges() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let video = f.admin.settings().await.unwrap().call_video;
    assert_eq!(
        (
            video.screen_max_width,
            video.screen_max_fps,
            video.screen_direct_kbps,
            video.screen_relay_kbps,
            video.camera_relay_kbps,
            video.group_camera_high_kbps,
            video.group_camera_low_kbps,
            video.group_screen_kbps,
        ),
        (2560, 15, 6000, 1000, 500, 400, 120, 1000)
    );

    let change = SettingsChange {
        screen_max_width: Some(3840),
        screen_max_fps: Some(30),
        screen_direct_kbps: Some(12_000),
        screen_relay_kbps: Some(2000),
        camera_relay_kbps: Some(500),
        ..SettingsChange::default()
    };
    f.admin.update_settings(boss, change).await.unwrap();
    let loaded = CallVideo::load(f.store.as_ref()).await.unwrap();
    assert_eq!(loaded.screen_max_width, 3840);
    assert_eq!(loaded.screen_direct_kbps, 12_000);
    assert_eq!(loaded.camera_relay_kbps, 500);
    // 没有变的那一项（摄像头）不留记录
    let keys: Vec<String> = f
        .store
        .audit_entries()
        .iter()
        .filter_map(|entry| entry.detail.key.clone())
        .collect();
    assert_eq!(
        keys,
        [
            "screen_max_width",
            "screen_max_fps",
            "screen_direct_kbps",
            "screen_relay_kbps"
        ]
    );

    for change in [
        SettingsChange {
            screen_max_width: Some(1279),
            ..SettingsChange::default()
        },
        SettingsChange {
            screen_max_fps: Some(31),
            ..SettingsChange::default()
        },
        SettingsChange {
            screen_direct_kbps: Some(999),
            ..SettingsChange::default()
        },
        SettingsChange {
            screen_relay_kbps: Some(5001),
            ..SettingsChange::default()
        },
        SettingsChange {
            camera_relay_kbps: Some(199),
            ..SettingsChange::default()
        },
        // 群视频的两档：小的一档不能高到清楚的一档的范围里去，反过来也一样
        SettingsChange {
            group_camera_high_kbps: Some(299),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_camera_high_kbps: Some(1501),
            ..SettingsChange::default()
        },
        // 群通话里共享的屏幕：300 到 3000
        SettingsChange {
            group_screen_kbps: Some(299),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_screen_kbps: Some(3001),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_camera_low_kbps: Some(49),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_camera_low_kbps: Some(251),
            ..SettingsChange::default()
        },
    ] {
        assert!(matches!(
            f.admin.update_settings(boss, change).await,
            Err(AdminError::SettingOutOfRange { .. })
        ));
    }
    assert_eq!(CallVideo::load(f.store.as_ref()).await.unwrap(), loaded);
}

#[tokio::test]
async fn a_setting_outside_its_range_rejects_the_whole_change() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let cases = [
        SettingsChange {
            file_max_bytes: Some(1024),
            ..SettingsChange::default()
        },
        SettingsChange {
            file_max_bytes: Some(2 * 1024 * 1024 * 1024),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_max_members: Some(2),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_max_members: Some(501),
            ..SettingsChange::default()
        },
        // 群通话人数上限：2 到 20
        SettingsChange {
            group_call_max: Some(1),
            ..SettingsChange::default()
        },
        SettingsChange {
            group_call_max: Some(21),
            ..SettingsChange::default()
        },
        SettingsChange {
            voice_max_seconds: Some(4),
            ..SettingsChange::default()
        },
        SettingsChange {
            recall_window_seconds: Some(24 * 60 * 60 + 1),
            ..SettingsChange::default()
        },
        SettingsChange {
            retention_days: Some(Some(0)),
            ..SettingsChange::default()
        },
        SettingsChange {
            retention_days: Some(Some(3651)),
            ..SettingsChange::default()
        },
    ];
    for change in cases {
        // 同一次里合乎范围的那一项也不生效
        let change = SettingsChange {
            voice_max_seconds: change.voice_max_seconds.or(Some(30)),
            ..change
        };
        let refused = f.admin.update_settings(boss, change).await;
        assert!(
            matches!(refused, Err(AdminError::SettingOutOfRange { .. })),
            "{change:?}"
        );
    }
    assert_eq!(f.admin.settings().await.unwrap().voice_max_seconds, 60);
    assert!(f.actions().is_empty());
}

/// 修改消息的时限（F8）：默认一天；可以是 0（不许修改），最多 7 天，再多一秒整个拒绝；改了留一条记录。
#[tokio::test]
async fn the_edit_window_is_between_none_and_a_week() {
    let f = fixture().await;
    let boss = &f.boss.user;
    assert_eq!(
        f.admin.settings().await.unwrap().edit_window_seconds,
        24 * 60 * 60
    );

    let week = 7 * 24 * 60 * 60;
    let too_long = SettingsChange {
        edit_window_seconds: Some(week + 1),
        ..SettingsChange::default()
    };
    let refused = f.admin.update_settings(boss, too_long).await;
    assert!(
        matches!(refused, Err(AdminError::SettingOutOfRange { .. })),
        "{refused:?}"
    );
    assert!(f.actions().is_empty());

    for seconds in [week, 0] {
        let change = SettingsChange {
            edit_window_seconds: Some(seconds),
            ..SettingsChange::default()
        };
        let updated = f.admin.update_settings(boss, change).await.unwrap();
        assert_eq!(updated.edit_window_seconds, seconds);
        let limits = Limits::load(f.store.as_ref()).await.unwrap();
        assert_eq!(limits.edit_window_seconds, seconds);
    }
    let changes: Vec<(String, String, String)> = f
        .store
        .audit_entries()
        .iter()
        .map(|entry| {
            let detail = &entry.detail;
            (
                detail.key.clone().unwrap(),
                detail.from.clone().unwrap(),
                detail.to.clone().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        changes,
        [
            (
                "edit_window_seconds".into(),
                "86400".into(),
                "604800".into()
            ),
            ("edit_window_seconds".into(), "604800".into(), "0".into()),
        ]
    );
}

#[tokio::test]
async fn a_recall_window_of_zero_turns_recalling_off() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let change = SettingsChange {
        recall_window_seconds: Some(0),
        ..SettingsChange::default()
    };
    f.admin.update_settings(&f.boss.user, change).await.unwrap();
    let sent = f.say(&a, conversation, "收不回来了").await;
    let recalled = f.chat.recall(&a, conversation, sent.seq).await;
    assert!(matches!(recalled, Err(ChatError::RecallTooLate)));
}

// ---------- 保留期限 ----------

#[tokio::test]
async fn nothing_is_cleaned_while_retention_is_forever() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    f.say(&a, conversation, "很久以前").await;
    f.clock.advance(5000 * DAY_MS);
    let cleaned = f.admin.clean_expired().await.unwrap();
    assert_eq!((cleaned.messages, cleaned.files), (0, 0));
    let page = f.chat.history(&a, conversation, HistoryQuery::default());
    assert_eq!(page.await.unwrap().messages.len(), 1);
}

#[tokio::test]
async fn expired_messages_and_their_files_are_removed_and_the_rest_stays_contiguous() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let old = f.say(&a, conversation, "很久以前").await;
    let (with_file, file) = f.send_file(&a, conversation).await;
    f.clock.advance(20 * DAY_MS);
    let recent = f.say(&b, conversation, "最近的").await;
    let reply = Draft {
        reply_to: Some(old.seq),
        ..Draft::text("c-reply", "回复很久以前的那条")
    };
    let reply = f.chat.send(&b, conversation, reply).await.unwrap().message;
    // 另一个会话里全是旧的
    let (c, d, other) = {
        let (c, d) = (f.user("老张").await, f.user("老李").await);
        let other = f.befriend(&c, &d).await;
        (c, d, other)
    };
    let stale = f.say(&d, other, "陈年旧事").await;
    f.store
        .edit_message(other, stale.seq, |m| m.created_at -= 20 * DAY_MS);

    let change = SettingsChange {
        retention_days: Some(Some(7)),
        ..SettingsChange::default()
    };
    f.admin.update_settings(&f.boss.user, change).await.unwrap();
    let records = f.store.audit_entries().len();
    let cleaned = f.admin.clean_expired().await.unwrap();

    // 第一个会话里两条旧消息，第二个会话里一条
    assert_eq!((cleaned.messages, cleaned.files), (3, 1));
    let page = f.chat.history(&a, conversation, HistoryQuery::default());
    let page = page.await.unwrap();
    let seqs: Vec<i64> = page.messages.iter().map(|m| m.seq).collect();
    assert_eq!(seqs, [recent.seq, reply.seq]);
    assert!(!page.has_more);
    // 引用的那条已经被清理：引用处显示"无法查看"
    assert_eq!(page.extras.quotes[&old.seq], Quote::Unavailable);
    assert_eq!(with_file.file, Some(file.id));
    assert!(
        FileStore::find(f.store.as_ref(), file.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!f.store.has_blob(&file.storage_key));
    assert!(!f.store.has_blob(file.thumbnail_key.as_deref().unwrap()));

    // 会话本身和成员关系都还在
    assert!(f.chat.conversation(&c, other).await.is_ok());
    let empty = f.chat.history(&c, other, HistoryQuery::default());
    assert!(empty.await.unwrap().messages.is_empty());
    // 操作记录不受影响
    assert_eq!(f.store.audit_entries().len(), records);

    // 再清一次没有可删的；之后照常发消息，序号接着往下排
    let again = f.admin.clean_expired().await.unwrap();
    assert_eq!(again.messages, 0);
    let next = f.say(&a, conversation, "新的").await;
    assert_eq!(next.seq, reply.seq + 1);
}

#[tokio::test]
async fn cleaning_stops_at_the_first_message_that_has_not_expired() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let first = f.say(&a, conversation, "一").await;
    let second = f.say(&a, conversation, "二").await;
    let third = f.say(&a, conversation, "三").await;
    // 中间那条没有过期，它后面那条的时间却更早（时钟被调过）
    f.store
        .edit_message(conversation, first.seq, |m| m.created_at -= 30 * DAY_MS);
    f.store
        .edit_message(conversation, third.seq, |m| m.created_at -= 30 * DAY_MS);
    let change = SettingsChange {
        retention_days: Some(Some(7)),
        ..SettingsChange::default()
    };
    f.admin.update_settings(&f.boss.user, change).await.unwrap();

    assert_eq!(f.admin.clean_expired().await.unwrap().messages, 1);
    let page = f.chat.history(&a, conversation, HistoryQuery::default());
    let seqs: Vec<i64> = page.await.unwrap().messages.iter().map(|m| m.seq).collect();
    assert_eq!(seqs, [second.seq, third.seq]);
}

// ---------- 系统概况 ----------

#[tokio::test]
async fn the_overview_counts_users_groups_and_files() {
    let f = fixture().await;
    let (owner, b, _, group) = f.trio("项目组").await;
    let (_, file) = f.send_file(&owner, group).await;
    f.trio("要解散的").await;
    f.admin.disable_user(&f.boss.user, b.id).await.unwrap();

    let overview = f.admin.overview(4).await.unwrap();
    assert_eq!(overview.users_total, 7);
    assert_eq!(overview.users_disabled, 1);
    assert_eq!(overview.online, 4);
    assert_eq!(overview.groups, 2);
    assert_eq!(overview.files_count, 1);
    assert_eq!(overview.files_bytes, file.size as u64);

    let (groups, _) = f
        .admin
        .groups(Some("解散"), Paging::default())
        .await
        .unwrap();
    let doomed = groups[0].conversation.id;
    f.admin.dissolve_group(&f.boss.user, doomed).await.unwrap();
    assert_eq!(f.admin.overview(0).await.unwrap().groups, 1);
}

// ---------- 查看聊天内容 ----------

#[tokio::test]
async fn viewing_a_conversation_is_recorded_and_shows_recalled_messages_in_full() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let wrong = f.say(&a, conversation, "说错了的话").await;
    let (photo, file) = f.send_file(&a, conversation).await;
    let reply = Draft {
        reply_to: Some(wrong.seq),
        ..Draft::text("c-reply", "什么？")
    };
    f.chat.send(&b, conversation, reply).await.unwrap();
    f.chat.recall(&a, conversation, wrong.seq).await.unwrap();
    f.chat.recall(&a, conversation, photo.seq).await.unwrap();

    let started = f.view(conversation).await;
    assert_eq!(
        started.conversation.conversation.kind,
        ConversationKind::Direct
    );
    assert_eq!(started.members.len(), 2);
    assert_eq!(started.grant.expires_at, f.clock.now_ms() + VIEW_TTL_MS);

    let entries = f.store.audit_entries();
    assert_eq!(f.actions(), [AuditAction::ChatViewed]);
    assert_eq!(entries[0].target, Some(conversation.to_string()));
    assert_eq!(entries[0].detail.label.as_deref(), Some("小明 / 小红"));
    assert_eq!(entries[0].detail.key.as_deref(), Some("direct"));

    let token = &started.grant.token;
    let page = f
        .admin
        .view_messages(&f.boss, conversation, token, HistoryQuery::default())
        .await
        .unwrap();
    // 已撤回的两条带着原内容，并且标着已撤回
    let recalled = &page.messages[wrong.seq as usize - 1];
    assert!(recalled.is_recalled());
    assert_eq!(recalled.text.as_deref(), Some("说错了的话"));
    let image = &page.messages[photo.seq as usize - 1];
    assert!(image.is_recalled());
    assert_eq!(image.file, Some(file.id));
    assert!(page.extras.files.contains_key(&file.id));
    // 引用了已撤回消息的回复，引用处也带着原文
    assert!(matches!(
        &page.extras.quotes[&wrong.seq],
        Quote::Shown { text: Some(text), .. } if text == "说错了的话"
    ));
    // 单聊也带着发送人的昵称
    assert_eq!(page.sender_names[&a.id], "小明");
    // 普通成员看到的仍然是空的
    let mine = f.chat.history(&b, conversation, HistoryQuery::default());
    assert_eq!(
        mine.await.unwrap().messages[wrong.seq as usize - 1].text,
        None
    );

    // 已撤回消息的文件，成员读不到，管理员带着凭据能读到
    assert!(matches!(
        f.files.open(&b, file.id).await,
        Err(FileError::NotFound)
    ));
    let opened = f.admin.view_file(&f.boss, conversation, token, file.id);
    assert_eq!(opened.await.unwrap().id, file.id);

    // 翻页、看文件都属于这一次查看，不另外记
    assert_eq!(f.actions().len(), 1);
}

#[tokio::test]
async fn messages_and_files_cannot_be_read_without_a_valid_view() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let (_, file) = f.send_file(&a, conversation).await;
    let (owner, _, _, group) = f.trio("项目组").await;
    let (_, group_file) = f.send_file(&owner, group).await;
    let started = f.view(conversation).await;
    let token = started.grant.token.as_str();
    let query = HistoryQuery::default;

    // 乱写的凭据
    let forged = f
        .admin
        .view_messages(&f.boss, conversation, "nope", query());
    assert!(matches!(forged.await, Err(AdminError::ViewRequired)));
    let forged = f.admin.view_file(&f.boss, conversation, "", file.id);
    assert!(matches!(forged.await, Err(FileError::NotFound)));

    // 别的会话的凭据
    let other = f.admin.view_messages(&f.boss, group, token, query());
    assert!(matches!(other.await, Err(AdminError::ViewRequired)));
    let other = f.admin.view_file(&f.boss, group, token, group_file.id);
    assert!(matches!(other.await, Err(FileError::NotFound)));
    // 凭据是这个会话的，文件却是别的会话的
    let stray = f
        .admin
        .view_file(&f.boss, conversation, token, group_file.id);
    assert!(matches!(stray.await, Err(FileError::NotFound)));

    // 管理员在别处的登录不能用这一次的凭据
    let elsewhere = f
        .accounts
        .login(ADMIN_HANDLE, ADMIN_PASSWORD, "t", "10.0.0.9");
    let elsewhere = elsewhere.await.unwrap();
    let elsewhere = AuthContext {
        user: elsewhere.user,
        session: elsewhere.session,
    };
    let borrowed = f
        .admin
        .view_messages(&elsewhere, conversation, token, query());
    assert!(matches!(borrowed.await, Err(AdminError::ViewRequired)));

    // 快到期时还能用，到期之后不行
    f.clock.advance(VIEW_TTL_MS - 1);
    let valid = f.admin.view_messages(&f.boss, conversation, token, query());
    assert!(valid.await.is_ok());
    f.clock.advance(1);
    let expired = f.admin.view_messages(&f.boss, conversation, token, query());
    assert!(matches!(expired.await, Err(AdminError::ViewRequired)));
    let expired = f.admin.view_file(&f.boss, conversation, token, file.id);
    assert!(matches!(expired.await, Err(FileError::NotFound)));

    // 再看要重新开始一次，又是一条记录
    let again = f.view(conversation).await;
    let valid = f
        .admin
        .view_messages(&f.boss, conversation, &again.grant.token, query());
    assert!(valid.await.is_ok());
    assert_eq!(
        f.actions(),
        [AuditAction::ChatViewed, AuditAction::ChatViewed]
    );

    let missing = f.admin.start_view(&f.boss, ConversationId::new()).await;
    assert!(matches!(missing, Err(AdminError::ConversationNotFound)));
}

#[tokio::test]
async fn a_view_of_a_group_covers_everything_including_what_members_cannot_see() {
    let f = fixture().await;
    let (owner, b, _, group) = f.trio("").await;
    f.say(&owner, group, "入群之前的话").await;
    let late = f.user("后来的").await;
    f.befriend(&owner, &late).await;
    f.chat.invite(&owner, group, &[late.id]).await.unwrap();
    f.chat.leave(&b, group).await.unwrap();

    let started = f.view(group).await;
    // 没有起名的群，用最早加入、现在还在的几个人的昵称
    assert_eq!(
        f.store.audit_entries()[0].detail.label.as_deref(),
        Some("群主 / 成员2 / 后来的")
    );
    assert_eq!(started.conversation.member_count, 3);
    assert_eq!(started.conversation.owner.as_ref().unwrap().id, owner.id);
    // 离开了的人也在成员里：显示他以前发的消息要用
    let active: Vec<bool> = started.members.iter().map(|m| m.active).collect();
    assert_eq!(active, [true, false, true, true]);
    assert!(started.members[0].is_owner);

    let page = f
        .admin
        .view_messages(
            &f.boss,
            group,
            &started.grant.token,
            HistoryQuery::default(),
        )
        .await
        .unwrap();
    let kinds: Vec<MessageKind> = page.messages.iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        [
            MessageKind::GroupCreated,
            MessageKind::Text,
            MessageKind::MemberJoined,
            MessageKind::MemberLeft
        ]
    );
    // 后来的人自己看不到入群之前的那一句
    let mine = f.chat.history(&late, group, HistoryQuery::default());
    assert!(
        mine.await
            .unwrap()
            .messages
            .iter()
            .all(|m| m.kind != MessageKind::Text)
    );
}

#[tokio::test]
async fn a_users_conversations_include_groups_they_left_and_dissolved_ones() {
    let f = fixture().await;
    let (owner, b, _, kept) = f.trio("留着的").await;
    f.say(&owner, kept, "大家好").await;
    let (owner2, b2, c2, gone) = f.trio("解散了的").await;
    let _ = (b2, c2);
    f.befriend(&owner2, &b).await;
    f.clock.advance(1000);
    f.chat.invite(&owner2, gone, &[b.id]).await.unwrap();
    f.clock.advance(1000);
    f.chat.leave(&b, kept).await.unwrap();
    f.clock.advance(1000);
    f.chat.dissolve(&owner2, gone).await.unwrap();

    let (user, conversations) = f.admin.conversations_of(b.id).await.unwrap();
    assert_eq!(user.id, b.id);
    let names: Vec<Option<&str>> = conversations
        .iter()
        .map(|c| c.conversation.name.as_deref())
        .collect();
    // 最近有动静的在前：解散、退群、和第二个群主的单聊、和第一个群主的单聊
    assert_eq!(names, [Some("解散了的"), Some("留着的"), None, None]);
    assert!(conversations[0].conversation.dissolved);
    assert_eq!(conversations[2].people.len(), 2);

    let nobody = f.admin.conversations_of(UserId::new()).await;
    assert!(matches!(nobody, Err(AdminError::UserNotFound)));
    // 找会话不算查看内容，不留记录
    assert!(f.actions().is_empty());
}

// ---------- 群 ----------

#[tokio::test]
async fn groups_are_listed_newest_first_and_found_by_name() {
    let f = fixture().await;
    let (_, _, _, first) = f.trio("Alpha 项目").await;
    let (_, _, _, second) = f.trio("").await;
    let (owner, _, _, third) = f.trio("alpha 二期").await;
    f.chat.dissolve(&owner, third).await.unwrap();
    f.pair().await;

    let (groups, total) = f.admin.groups(None, Paging::default()).await.unwrap();
    let ids: Vec<ConversationId> = groups.iter().map(|g| g.conversation.id).collect();
    assert_eq!(total, 3);
    assert_eq!(ids, [third, second, first]);
    assert!(groups[0].conversation.dissolved);
    assert_eq!(groups[1].member_count, 3);
    assert_eq!(groups[1].label(), "群主 / 成员1 / 成员2");

    let (found, total) = f
        .admin
        .groups(Some("ALPHA"), Paging::default())
        .await
        .unwrap();
    assert_eq!((found.len(), total), (2, 2));

    let (overseen, members) = f.admin.members(first).await.unwrap();
    assert_eq!(overseen.label(), "Alpha 项目");
    assert_eq!(members.len(), 3);
}

#[tokio::test]
async fn an_administrator_can_dissolve_any_group_once() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio("项目组").await;
    let (_, _, direct) = f.pair().await;

    let posted = f.admin.dissolve_group(&f.boss.user, group).await.unwrap();
    // 事件里不写是谁解散的：成员看到的是"群已被管理员解散"
    assert_eq!(posted.message.kind, MessageKind::Dissolved);
    assert_eq!(posted.message.data.actor, None);
    let mut notified = posted.members.clone();
    notified.sort();
    let mut expected = vec![owner.id, b.id, c.id];
    expected.sort();
    assert_eq!(notified, expected);

    let sent = f.chat.send_text(&owner, group, "c-1", "还能说话吗");
    assert!(matches!(sent.await, Err(ChatError::GroupDissolved)));
    // 历史还在
    let page = f.chat.history(&b, group, HistoryQuery::default());
    assert_eq!(page.await.unwrap().messages.len(), 2);

    let again = f.admin.dissolve_group(&f.boss.user, group).await;
    assert!(matches!(again, Err(AdminError::GroupDissolved)));
    let not_a_group = f.admin.dissolve_group(&f.boss.user, direct).await;
    assert!(matches!(not_a_group, Err(AdminError::ConversationNotFound)));

    let entries = f.store.audit_entries();
    assert_eq!(f.actions(), [AuditAction::GroupDissolved]);
    assert_eq!(entries[0].target, Some(group.to_string()));
    assert_eq!(entries[0].detail.label.as_deref(), Some("项目组"));
}

// ---------- 操作记录 ----------

#[tokio::test]
async fn the_audit_log_reads_newest_first_and_filters_by_action() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let a = f.user("小明").await;
    f.admin.disable_user(boss, a.id).await.unwrap();
    f.clock.advance(1000);
    f.admin.enable_user(boss, a.id).await.unwrap();
    f.clock.advance(1000);
    f.admin.disable_user(boss, a.id).await.unwrap();

    let (entries, total) = f.admin.audit_log(None, Paging::default()).await.unwrap();
    assert_eq!(total, 3);
    let actions: Vec<AuditAction> = entries.iter().map(|entry| entry.action).collect();
    assert_eq!(
        actions,
        [
            AuditAction::UserDisabled,
            AuditAction::UserEnabled,
            AuditAction::UserDisabled
        ]
    );
    assert!(entries[0].at > entries[2].at);

    let only = Some(AuditAction::UserDisabled);
    let paging = Paging {
        page: 2,
        page_size: 1,
    };
    let (entries, total) = f.admin.audit_log(only, paging).await.unwrap();
    assert_eq!((entries.len(), total), (1, 2));
    assert_eq!(entries[0].at, f.store.audit_entries()[0].at);
}

// ---------- 找回密码 ----------

#[tokio::test]
async fn a_reset_link_is_mailed_only_to_the_right_address_and_works_once() {
    let f = fixture().await;
    // 邮箱不对：结果一样，但没有邮件
    f.admin
        .request_password_reset("someone@example.com", "10.0.0.5")
        .await
        .unwrap();
    assert!(f.outbox.sent().is_empty());

    f.admin
        .request_password_reset(" Boss@Example.com ", "10.0.0.5")
        .await
        .unwrap();
    let sent = f.outbox.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].to, "boss@example.com");
    assert!(sent[0].subject.contains("重置"));
    let token = f.outbox.last_token().unwrap();
    assert!(
        sent[0]
            .body
            .contains(&format!("http://vibe.test/reset-password?token={token}"))
    );

    // 新密码不合规则：链接还能再用
    let weak = f.admin.reset_password_with_token(&token, "short").await;
    assert!(matches!(
        weak,
        Err(AdminError::Account(AccountError::PasswordTooWeak))
    ));

    let ended = f
        .admin
        .reset_password_with_token(&token, "brand-new-pass-2");
    // 管理员的全部登录失效
    assert_eq!(ended.await.unwrap(), [f.boss.session.id]);
    assert_eq!(f.store.session_count(f.boss.user.id), 0);
    let old = f
        .accounts
        .login(ADMIN_HANDLE, ADMIN_PASSWORD, "t", "10.0.0.9");
    assert!(matches!(old.await, Err(AccountError::InvalidCredentials)));
    let new = f
        .accounts
        .login(ADMIN_HANDLE, "brand-new-pass-2", "t", "10.0.0.9");
    // 自己设的密码，不用再改一次
    assert!(!new.await.unwrap().user.must_change_password);

    // 同一个链接再用一次
    let reused = f.admin.reset_password_with_token(&token, "another-pass-3");
    assert!(matches!(reused.await, Err(AdminError::TokenInvalid)));
    let forged = f
        .admin
        .reset_password_with_token("made-up", "another-pass-3");
    assert!(matches!(forged.await, Err(AdminError::TokenInvalid)));
    // 找回密码的链接不能拿去确认邮箱
    assert!(matches!(
        f.admin.confirm_email(&token).await,
        Err(AdminError::TokenInvalid)
    ));
}

#[tokio::test]
async fn a_reset_link_expires_and_requests_are_rate_limited() {
    let f = fixture().await;
    f.admin
        .request_password_reset("boss@example.com", "10.0.0.5")
        .await
        .unwrap();
    let token = f.outbox.last_token().unwrap();
    f.clock.advance(LINK_TTL_MS);
    let expired = f
        .admin
        .reset_password_with_token(&token, "brand-new-pass-2");
    assert!(matches!(expired.await, Err(AdminError::TokenInvalid)));
    assert_eq!(f.store.session_count(f.boss.user.id), 1);

    for _ in 0..5 {
        let asked = f.admin.request_password_reset("x@example.com", "10.0.0.6");
        asked.await.unwrap();
    }
    let limited = f.admin.request_password_reset("x@example.com", "10.0.0.6");
    assert!(matches!(
        limited.await,
        Err(AdminError::RateLimited { retry_after_secs }) if retry_after_secs > 0
    ));
    // 别的来源不受影响
    let other = f.admin.request_password_reset("x@example.com", "10.0.0.7");
    assert!(other.await.is_ok());
}

#[tokio::test]
async fn a_failing_mail_server_does_not_reveal_whether_the_address_was_right() {
    let f = fixture().await;
    f.outbox.broken.store(true, Ordering::Relaxed);
    let right = f
        .admin
        .request_password_reset("boss@example.com", "10.0.0.5");
    assert!(right.await.is_ok());
    let wrong = f
        .admin
        .request_password_reset("nope@example.com", "10.0.0.5");
    assert!(wrong.await.is_ok());
}

#[tokio::test]
async fn mail_is_written_in_the_administrators_language() {
    let f = fixture().await;
    let changes = ProfileChanges {
        language: Some(Language::En),
        ..ProfileChanges::default()
    };
    UserStore::update_profile(f.store.as_ref(), f.boss.user.id, &changes)
        .await
        .unwrap();
    f.admin
        .request_password_reset("boss@example.com", "10.0.0.5")
        .await
        .unwrap();
    let sent = f.outbox.sent();
    assert!(sent[0].subject.starts_with("Reset your"));
    assert!(sent[0].body.contains("expires in 30 minutes"));
}

// ---------- 修改邮箱 ----------

#[tokio::test]
async fn a_new_email_takes_effect_only_after_it_is_confirmed() {
    let f = fixture().await;
    let boss = &f.boss.user;
    let wrong = f
        .admin
        .request_email_change(boss, "not-my-pass-1", "new@example.com");
    assert!(matches!(
        wrong.await,
        Err(AdminError::Account(AccountError::PasswordIncorrect))
    ));
    for bad in [
        "",
        "plain",
        "a@b",
        "a b@example.com",
        "@example.com",
        "a@@b.com",
        "a@b..com",
    ] {
        let refused = f.admin.request_email_change(boss, ADMIN_PASSWORD, bad);
        assert!(
            matches!(refused.await, Err(AdminError::EmailInvalid)),
            "{bad}"
        );
    }
    assert!(f.outbox.sent().is_empty());

    f.admin
        .request_email_change(boss, ADMIN_PASSWORD, " new@example.com ")
        .await
        .unwrap();
    let sent = f.outbox.sent();
    assert_eq!(sent[0].to, "new@example.com");
    let confirm = f.outbox.last_token().unwrap();
    assert!(
        sent[0]
            .body
            .contains("http://vibe.test/confirm-email?token=")
    );

    // 没有确认之前，找回密码的邮件仍然发到旧邮箱
    f.admin
        .request_password_reset("new@example.com", "10.0.0.5")
        .await
        .unwrap();
    assert_eq!(f.outbox.sent().len(), 1);
    f.admin
        .request_password_reset("boss@example.com", "10.0.0.5")
        .await
        .unwrap();
    assert_eq!(f.outbox.sent()[1].to, "boss@example.com");
    // 确认邮箱的链接不能拿去设密码
    let misuse = f
        .admin
        .reset_password_with_token(&confirm, "brand-new-pass-2");
    assert!(matches!(misuse.await, Err(AdminError::TokenInvalid)));

    let confirmed = f.admin.confirm_email(&confirm).await.unwrap();
    assert_eq!(confirmed.email.as_deref(), Some("new@example.com"));
    assert_eq!(
        f.find(boss.id).await.email.as_deref(),
        Some("new@example.com")
    );
    let reused = f.admin.confirm_email(&confirm).await;
    assert!(matches!(reused, Err(AdminError::TokenInvalid)));

    // 之后旧邮箱不再有效
    f.admin
        .request_password_reset("boss@example.com", "10.0.0.5")
        .await
        .unwrap();
    assert_eq!(f.outbox.sent().len(), 2);
    f.admin
        .request_password_reset("new@example.com", "10.0.0.5")
        .await
        .unwrap();
    assert_eq!(f.outbox.sent()[2].to, "new@example.com");
}
