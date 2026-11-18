//! 管理的业务流程。每一种会改动数据或者读到聊天内容的操作都遵守同一条规则：
//! 先确认它可以做，再写下操作记录，然后才去做。记录写不进去，操作就不会发生。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use super::error::AdminError;
use super::model::{
    AdminToken, AuditAction, AuditDetail, AuditEntry, Overview, SettingKey, Settings,
    SettingsChange, TokenPurpose, UserRow,
};
use super::store::{AuditStore, TokenStore};
use crate::account::guard::RateLimiter;
use crate::account::model::{
    InviteCode, InviteCodeStatus, Language, StoredFile, User, UserQuery, UserStatus,
};
use crate::account::password::{self, PasswordHasher};
use crate::account::service::{check_batch, check_new_invite_codes, hash_token, millis_to_secs};
use crate::account::store::{FileStore, InviteCodeStore, SessionStore, UserStore};
use crate::account::{AccountError, AccountService, AuthContext, NewInviteCodes};
use crate::chat::service::GROUP_MAX_MEMBERS_SETTING;
use crate::chat::store::ChatStore;
use crate::chat::{
    ChatError, ChatService, ConversationKind, HistoryQuery, Overseen, OverseenMember, Page, Posted,
};
use crate::clock::Clock;
use crate::file::{FileError, FileService};
use crate::ids::{ConversationId, FileId, InviteCodeId, SessionId, UserId};
use crate::limits::{
    CAMERA_RELAY_KBPS_SETTING, CallVideo, EDIT_WINDOW_SECONDS_SETTING, FILE_MAX_BYTES_SETTING,
    Limits, RECALL_WINDOW_SECONDS_SETTING, RETENTION_DAYS_SETTING, SCREEN_DIRECT_KBPS_SETTING,
    SCREEN_MAX_FPS_SETTING, SCREEN_MAX_WIDTH_SETTING, SCREEN_RELAY_KBPS_SETTING,
    VOICE_MAX_SECONDS_SETTING, retention_days,
};
use crate::mail::{Mail, Mailer};
use crate::random::{hex, random_bytes, random_string};
use crate::settings::SettingsStore;

/// 用户列表和操作记录每页的数量：默认值和上限。
pub const PAGE_SIZE: u32 = 20;
pub const PAGE_SIZE_MAX: u32 = 100;
/// 查找用户或群时输入的文字最多多少个字。
pub const SEARCH_MAX_CHARS: usize = 50;

/// 一次查看的凭据多久之后失效。
pub const VIEW_TTL_MS: i64 = 30 * 60 * 1000;
/// 邮件里的链接多久之后失效。
pub const LINK_TTL_MS: i64 = 30 * 60 * 1000;
/// 同一来源地址每分钟可以请求几次找回密码：默认值。
pub const RESET_REQUESTS_PER_MINUTE: u32 = 5;
const RATE_WINDOW_MS: i64 = 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 临时密码用的字符：去掉了容易看混的 0、O、1、l、I。
const TEMP_PASSWORD_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TEMP_PASSWORD_LEN: usize = 12;

pub const FILE_MAX_BYTES_RANGE: (u64, u64) = (1024 * 1024, 1024 * 1024 * 1024);
pub const GROUP_MAX_MEMBERS_RANGE: (u32, u32) = (3, 500);
pub const VOICE_MAX_SECONDS_RANGE: (u32, u32) = (5, 300);
pub const RECALL_WINDOW_SECONDS_RANGE: (u32, u32) = (0, 24 * 60 * 60);
pub const RETENTION_DAYS_RANGE: (u32, u32) = (1, 3650);
/// 编辑时限：0 到 7 天（F8）。
pub const EDIT_WINDOW_SECONDS_RANGE: (u32, u32) = (0, 7 * 24 * 60 * 60);
// 通话画面的参数（F7 第 7 章）
pub const SCREEN_MAX_WIDTH_RANGE: (u32, u32) = (1280, 3840);
pub const SCREEN_MAX_FPS_RANGE: (u32, u32) = (5, 30);
pub const SCREEN_DIRECT_KBPS_RANGE: (u32, u32) = (1000, 20_000);
pub const SCREEN_RELAY_KBPS_RANGE: (u32, u32) = (300, 5000);
pub const CAMERA_RELAY_KBPS_RANGE: (u32, u32) = (200, 3000);
// 群视频两档画面的码率（F11）。两个范围不重叠：小的一档总比清楚的一档低
pub const GROUP_CAMERA_HIGH_KBPS_RANGE: (u32, u32) = (300, 1500);
pub const GROUP_CAMERA_LOW_KBPS_RANGE: (u32, u32) = (50, 250);
// 群通话里共享的屏幕的码率（F12）
pub const GROUP_SCREEN_KBPS_RANGE: (u32, u32) = (300, 3000);
const EMAIL_MAX_CHARS: usize = 254;

pub struct AdminServiceDeps {
    pub accounts: Arc<AccountService>,
    pub chat: Arc<ChatService>,
    pub files: Arc<FileService>,
    pub users: Arc<dyn UserStore>,
    pub sessions: Arc<dyn SessionStore>,
    pub invite_codes: Arc<dyn InviteCodeStore>,
    pub chat_store: Arc<dyn ChatStore>,
    pub file_store: Arc<dyn FileStore>,
    pub settings: Arc<dyn SettingsStore>,
    pub audit: Arc<dyn AuditStore>,
    pub tokens: Arc<dyn TokenStore>,
    pub hasher: Arc<dyn PasswordHasher>,
    pub mailer: Arc<dyn Mailer>,
    pub clock: Arc<dyn Clock>,
    /// 用户访问这个系统用的地址。邮件里的链接以它开头。
    pub public_url: String,
    /// 同一来源地址每分钟可以请求几次找回密码。
    pub reset_requests_per_minute: u32,
}

/// 一次查看的凭据。`token` 只在这里出现，之后取消息、取文件都要带着它。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewGrant {
    pub token: String,
    pub expires_at: i64,
}

/// 凭据对哪一次登录、哪一个会话有效。
struct View {
    session: SessionId,
    conversation: ConversationId,
    expires_at: i64,
}

/// 开始一次查看得到的东西。
pub struct ViewStarted {
    pub grant: ViewGrant,
    pub conversation: Overseen,
    pub members: Vec<OverseenMember>,
}

/// 重置密码的结果。`password` 只在这里出现一次。
pub struct PasswordReset {
    pub user: User,
    pub password: String,
    /// 被结束的那些登录。
    pub sessions: Vec<SessionId>,
}

/// 清理过期内容的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cleaned {
    pub messages: u64,
    pub files: u64,
}

/// 列表的哪一页。页码从 1 开始。
#[derive(Debug, Clone, Copy)]
pub struct Paging {
    pub page: u32,
    pub page_size: u32,
}

impl Default for Paging {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: PAGE_SIZE,
        }
    }
}

impl Paging {
    fn offset(self) -> Result<u64, AdminError> {
        if self.page == 0 {
            return Err(AdminError::Invalid("page starts at 1"));
        }
        if self.page_size == 0 || self.page_size > PAGE_SIZE_MAX {
            return Err(AdminError::Invalid("page_size must be between 1 and 100"));
        }
        Ok(u64::from(self.page - 1) * u64::from(self.page_size))
    }
}

pub struct AdminService {
    deps: AdminServiceDeps,
    /// 还没有过期的查看凭据，按凭据的哈希。只在内存里：服务重启后要重新开始查看。
    views: Mutex<HashMap<String, View>>,
    reset_limiter: RateLimiter,
}

impl AdminService {
    pub fn new(deps: AdminServiceDeps) -> Self {
        Self {
            reset_limiter: RateLimiter::new(
                deps.clock.clone(),
                deps.reset_requests_per_minute,
                RATE_WINDOW_MS,
            ),
            views: Mutex::new(HashMap::new()),
            deps,
        }
    }

    // ---------- 操作记录 ----------

    /// 操作记录的一页，从新到旧。可以只看某一种操作。
    pub async fn audit_log(
        &self,
        action: Option<AuditAction>,
        paging: Paging,
    ) -> Result<(Vec<AuditEntry>, u64), AdminError> {
        let offset = paging.offset()?;
        let limit = u64::from(paging.page_size);
        Ok(self.deps.audit.list(action, offset, limit).await?)
    }

    async fn record(
        &self,
        actor: &User,
        action: AuditAction,
        target: Option<String>,
        detail: AuditDetail,
    ) -> Result<(), AdminError> {
        let entry = AuditEntry {
            id: uuid::Uuid::now_v7().to_string(),
            at: self.deps.clock.now_ms(),
            actor: actor.id,
            action,
            target,
            detail,
        };
        Ok(self.deps.audit.append(&entry).await?)
    }

    // ---------- 用户 ----------

    /// 用户列表的一页，注册晚的在前。`search` 在 ID 和昵称里找。
    pub async fn list_users(
        &self,
        search: Option<&str>,
        status: Option<UserStatus>,
        paging: Paging,
    ) -> Result<(Vec<UserRow>, u64), AdminError> {
        let query = UserQuery {
            search: clean_search(search)?,
            status,
            offset: paging.offset()?,
            limit: u64::from(paging.page_size),
        };
        let (users, total) = self.deps.users.list(&query).await?;
        let ids: Vec<UserId> = users.iter().map(|user| user.id).collect();
        let codes: HashMap<UserId, String> = if ids.is_empty() {
            HashMap::new()
        } else {
            let used = self.deps.invite_codes.find_used_by(&ids).await?;
            used.into_iter()
                .filter_map(|invite| Some((invite.used_by?, invite.code)))
                .collect()
        };
        let rows = users
            .into_iter()
            .map(|user| UserRow {
                invite_code: codes.get(&user.id).cloned(),
                user,
            })
            .collect();
        Ok((rows, total))
    }

    /// 禁用一个用户：他的全部登录失效，之后不能再登录。账号、好友和消息都保留。
    /// 返回被结束的那些登录，已经建立的连接要靠它们断开。
    pub async fn disable_user(
        &self,
        admin: &User,
        target: UserId,
    ) -> Result<(User, Vec<SessionId>), AdminError> {
        let mut user = self.other_user(admin, target).await?;
        if user.status != UserStatus::Disabled {
            self.record(
                admin,
                AuditAction::UserDisabled,
                Some(user.id.to_string()),
                named(&user),
            )
            .await?;
            let users = &self.deps.users;
            users.set_status(user.id, UserStatus::Disabled).await?;
            user.status = UserStatus::Disabled;
        }
        // 已经是禁用的也再清一次：万一上一次只做了一半
        let sessions = self.deps.sessions.delete_others(user.id, None).await?;
        Ok((user, sessions))
    }

    /// 启用一个被禁用的用户。
    pub async fn enable_user(&self, admin: &User, target: UserId) -> Result<User, AdminError> {
        let mut user = self.other_user(admin, target).await?;
        if user.status != UserStatus::Active {
            self.record(
                admin,
                AuditAction::UserEnabled,
                Some(user.id.to_string()),
                named(&user),
            )
            .await?;
            let users = &self.deps.users;
            users.set_status(user.id, UserStatus::Active).await?;
            user.status = UserStatus::Active;
        }
        Ok(user)
    }

    /// 重置一个用户的密码：生成临时密码，他的全部登录失效，用临时密码登录后必须先改密码。
    pub async fn reset_password(
        &self,
        admin: &User,
        target: UserId,
    ) -> Result<PasswordReset, AdminError> {
        let mut user = self.other_user(admin, target).await?;
        self.record(
            admin,
            AuditAction::PasswordReset,
            Some(user.id.to_string()),
            named(&user),
        )
        .await?;
        let password = temp_password(&user.handle);
        let hash = self.deps.hasher.hash(&password).await;
        self.deps.users.set_password(user.id, &hash, true).await?;
        let sessions = self.deps.sessions.delete_others(user.id, None).await?;
        user.password_hash = hash;
        user.must_change_password = true;
        Ok(PasswordReset {
            user,
            password,
            sessions,
        })
    }

    /// 管理操作的对象：存在，并且不是管理员自己。
    async fn other_user(&self, admin: &User, target: UserId) -> Result<User, AdminError> {
        if target == admin.id {
            return Err(AdminError::CannotTargetSelf);
        }
        let found = self.deps.users.find(target).await?;
        found.ok_or(AdminError::UserNotFound)
    }

    // ---------- 邀请码 ----------

    pub async fn create_invite_codes(
        &self,
        admin: &User,
        new: NewInviteCodes<'_>,
    ) -> Result<Vec<InviteCode>, AdminError> {
        check_new_invite_codes(&new)?;
        self.record(
            admin,
            AuditAction::InviteCodesCreated,
            None,
            counted(u64::from(new.count)),
        )
        .await?;
        Ok(self
            .deps
            .accounts
            .create_invite_codes(admin.id, new)
            .await?)
    }

    /// 作废一个还没有使用的邀请码。
    pub async fn revoke_invite_code(
        &self,
        admin: &User,
        id: InviteCodeId,
    ) -> Result<InviteCode, AdminError> {
        let found = self.deps.invite_codes.find(id).await?;
        match found.ok_or(AccountError::NotFound)?.status {
            InviteCodeStatus::Used => return Err(AccountError::InviteCodeUsed.into()),
            InviteCodeStatus::Revoked => return Err(AccountError::InviteCodeRevoked.into()),
            InviteCodeStatus::Unused => {}
        }
        self.record(admin, AuditAction::InviteCodesRevoked, None, counted(1))
            .await?;
        Ok(self.deps.accounts.revoke_invite_code(id).await?)
    }

    /// 一次作废多个邀请码，返回作废了几个。已经使用、已经作废或不存在的会被跳过。
    pub async fn revoke_invite_codes(
        &self,
        admin: &User,
        ids: &[InviteCodeId],
    ) -> Result<u64, AdminError> {
        let unused = |invite: &InviteCode| invite.status == InviteCodeStatus::Unused;
        let count = self.count_invite_codes(ids, unused).await?;
        if count == 0 {
            return Ok(0);
        }
        self.record(admin, AuditAction::InviteCodesRevoked, None, counted(count))
            .await?;
        Ok(self.deps.accounts.revoke_invite_codes(ids).await?)
    }

    /// 删除已经作废或已经过期的邀请码，返回删除了几个。其余的会被跳过。
    pub async fn delete_invite_codes(
        &self,
        admin: &User,
        ids: &[InviteCodeId],
    ) -> Result<u64, AdminError> {
        let now = self.deps.clock.now_ms();
        let dead = |invite: &InviteCode| match invite.status {
            InviteCodeStatus::Revoked => true,
            InviteCodeStatus::Unused => invite.is_expired(now),
            InviteCodeStatus::Used => false,
        };
        let count = self.count_invite_codes(ids, dead).await?;
        if count == 0 {
            return Ok(0);
        }
        self.record(admin, AuditAction::InviteCodesDeleted, None, counted(count))
            .await?;
        Ok(self.deps.accounts.delete_invite_codes(ids).await?)
    }

    /// 这些邀请码里有几个符合条件。
    async fn count_invite_codes(
        &self,
        ids: &[InviteCodeId],
        wanted: impl Fn(&InviteCode) -> bool,
    ) -> Result<u64, AdminError> {
        check_batch(ids)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let found = self.deps.invite_codes.find_many(ids).await?;
        Ok(found.iter().filter(|invite| wanted(invite)).count() as u64)
    }

    // ---------- 系统设置 ----------

    /// 当前生效的系统设置。
    pub async fn settings(&self) -> Result<Settings, AdminError> {
        let settings = self.deps.settings.as_ref();
        let limits = Limits::load(settings).await?;
        Ok(Settings {
            file_max_bytes: limits.file_max_bytes,
            group_max_members: self.deps.chat.max_members().await?,
            voice_max_seconds: limits.voice_max_seconds,
            recall_window_seconds: limits.recall_window_seconds,
            edit_window_seconds: limits.edit_window_seconds,
            retention_days: retention_days(settings).await?,
            call_video: CallVideo::load(settings).await?,
            group_call_max: crate::limits::group_call_max(settings).await?,
        })
    }

    /// 修改系统设置。有一项超出范围就整个拒绝；真正变了的每一项各记一条操作记录。
    /// 改完立即生效。
    pub async fn update_settings(
        &self,
        admin: &User,
        change: SettingsChange,
    ) -> Result<Settings, AdminError> {
        let current = self.settings().await?;
        let mut edits: Vec<(SettingKey, String, String)> = Vec::new();
        if let Some(bytes) = change.file_max_bytes {
            check_range(SettingKey::FileMaxBytes, bytes, FILE_MAX_BYTES_RANGE)?;
            edits.push((
                SettingKey::FileMaxBytes,
                current.file_max_bytes.to_string(),
                bytes.to_string(),
            ));
        }
        if let Some(members) = change.group_max_members {
            check_range(
                SettingKey::GroupMaxMembers,
                members,
                GROUP_MAX_MEMBERS_RANGE,
            )?;
            edits.push((
                SettingKey::GroupMaxMembers,
                current.group_max_members.to_string(),
                members.to_string(),
            ));
        }
        if let Some(people) = change.group_call_max {
            check_range(
                SettingKey::GroupCallMax,
                people,
                crate::limits::GROUP_CALL_MAX_RANGE,
            )?;
            edits.push((
                SettingKey::GroupCallMax,
                current.group_call_max.to_string(),
                people.to_string(),
            ));
        }
        if let Some(seconds) = change.voice_max_seconds {
            check_range(
                SettingKey::VoiceMaxSeconds,
                seconds,
                VOICE_MAX_SECONDS_RANGE,
            )?;
            edits.push((
                SettingKey::VoiceMaxSeconds,
                current.voice_max_seconds.to_string(),
                seconds.to_string(),
            ));
        }
        if let Some(seconds) = change.recall_window_seconds {
            check_range(
                SettingKey::RecallWindowSeconds,
                seconds,
                RECALL_WINDOW_SECONDS_RANGE,
            )?;
            edits.push((
                SettingKey::RecallWindowSeconds,
                current.recall_window_seconds.to_string(),
                seconds.to_string(),
            ));
        }
        if let Some(seconds) = change.edit_window_seconds {
            check_range(
                SettingKey::EditWindowSeconds,
                seconds,
                EDIT_WINDOW_SECONDS_RANGE,
            )?;
            edits.push((
                SettingKey::EditWindowSeconds,
                current.edit_window_seconds.to_string(),
                seconds.to_string(),
            ));
        }
        let video = current.call_video;
        for (key, from, to, range) in [
            (
                SettingKey::ScreenMaxWidth,
                video.screen_max_width,
                change.screen_max_width,
                SCREEN_MAX_WIDTH_RANGE,
            ),
            (
                SettingKey::ScreenMaxFps,
                video.screen_max_fps,
                change.screen_max_fps,
                SCREEN_MAX_FPS_RANGE,
            ),
            (
                SettingKey::ScreenDirectKbps,
                video.screen_direct_kbps,
                change.screen_direct_kbps,
                SCREEN_DIRECT_KBPS_RANGE,
            ),
            (
                SettingKey::ScreenRelayKbps,
                video.screen_relay_kbps,
                change.screen_relay_kbps,
                SCREEN_RELAY_KBPS_RANGE,
            ),
            (
                SettingKey::CameraRelayKbps,
                video.camera_relay_kbps,
                change.camera_relay_kbps,
                CAMERA_RELAY_KBPS_RANGE,
            ),
            (
                SettingKey::GroupCameraHighKbps,
                video.group_camera_high_kbps,
                change.group_camera_high_kbps,
                GROUP_CAMERA_HIGH_KBPS_RANGE,
            ),
            (
                SettingKey::GroupCameraLowKbps,
                video.group_camera_low_kbps,
                change.group_camera_low_kbps,
                GROUP_CAMERA_LOW_KBPS_RANGE,
            ),
            (
                SettingKey::GroupScreenKbps,
                video.group_screen_kbps,
                change.group_screen_kbps,
                GROUP_SCREEN_KBPS_RANGE,
            ),
        ] {
            if let Some(to) = to {
                check_range(key, to, range)?;
                edits.push((key, from.to_string(), to.to_string()));
            }
        }
        if let Some(days) = change.retention_days {
            if let Some(days) = days {
                check_range(SettingKey::RetentionDays, days, RETENTION_DAYS_RANGE)?;
            }
            // 永久保留写成 0
            edits.push((
                SettingKey::RetentionDays,
                current.retention_days.unwrap_or(0).to_string(),
                days.unwrap_or(0).to_string(),
            ));
        }

        for (key, from, to) in edits {
            if from == to {
                continue;
            }
            let detail = AuditDetail {
                key: Some(key.as_str().to_owned()),
                from: Some(from),
                to: Some(to.clone()),
                ..AuditDetail::default()
            };
            self.record(admin, AuditAction::SettingChanged, None, detail)
                .await?;
            self.deps.settings.set(setting_name(key), &to).await?;
        }
        self.settings().await
    }

    /// 删除超过保留期限的消息和它们的文件。期限是"永久"时什么也不删。
    pub async fn clean_expired(&self) -> Result<Cleaned, AdminError> {
        let Some(days) = retention_days(self.deps.settings.as_ref()).await? else {
            return Ok(Cleaned::default());
        };
        let cutoff = self.deps.clock.now_ms() - i64::from(days) * DAY_MS;
        let purged = self.deps.chat_store.purge_before(cutoff).await?;
        let files = self.deps.files.remove(&purged.files).await?;
        Ok(Cleaned {
            messages: purged.messages,
            files,
        })
    }

    // ---------- 系统概况 ----------

    /// 系统概况。在线人数由连接那一层给出。
    pub async fn overview(&self, online: u64) -> Result<Overview, AdminError> {
        let users = self.deps.users.counts().await?;
        let (files_count, files_bytes) = self.deps.file_store.usage().await?;
        Ok(Overview {
            users_total: users.total,
            users_disabled: users.disabled,
            online,
            groups: self.deps.chat_store.count_groups().await?,
            files_count,
            files_bytes,
        })
    }

    // ---------- 聊天内容和群 ----------

    /// 一个用户参与的全部会话。
    pub async fn conversations_of(
        &self,
        user: UserId,
    ) -> Result<(User, Vec<Overseen>), AdminError> {
        let found = self.deps.users.find(user).await?;
        let user = found.ok_or(AdminError::UserNotFound)?;
        let conversations = self.deps.chat.oversee_user(user.id).await?;
        Ok((user, conversations))
    }

    /// 系统里的群的一页，新建的在前。`search` 在群名里找。
    pub async fn groups(
        &self,
        search: Option<&str>,
        paging: Paging,
    ) -> Result<(Vec<Overseen>, u64), AdminError> {
        let search = clean_search(search)?;
        let offset = paging.offset()?;
        let limit = u64::from(paging.page_size);
        let chat = &self.deps.chat;
        Ok(chat
            .oversee_groups(search.as_deref(), offset, limit)
            .await?)
    }

    /// 一个会话的成员。
    pub async fn members(
        &self,
        conversation: ConversationId,
    ) -> Result<(Overseen, Vec<OverseenMember>), AdminError> {
        let overseen = self.overseen(conversation).await?;
        let members = self.deps.chat.oversee_members(conversation).await?;
        Ok((overseen, members))
    }

    /// 开始查看一个会话的内容：写下操作记录，换来一个凭据。
    /// 凭据只对这一次登录、这一个会话有效，过一段时间失效。
    pub async fn start_view(
        &self,
        admin: &AuthContext,
        conversation: ConversationId,
    ) -> Result<ViewStarted, AdminError> {
        let (overseen, members) = self.members(conversation).await?;
        let detail = AuditDetail {
            label: Some(overseen.label()),
            key: Some(overseen.conversation.kind.as_str().to_owned()),
            ..AuditDetail::default()
        };
        self.record(
            &admin.user,
            AuditAction::ChatViewed,
            Some(conversation.to_string()),
            detail,
        )
        .await?;

        let now = self.deps.clock.now_ms();
        let token = hex(&random_bytes::<32>());
        let expires_at = now + VIEW_TTL_MS;
        let mut views = self.views.lock().unwrap_or_else(PoisonError::into_inner);
        views.retain(|_, view| view.expires_at > now);
        views.insert(
            hash_token(&token),
            View {
                session: admin.session.id,
                conversation,
                expires_at,
            },
        );
        Ok(ViewStarted {
            grant: ViewGrant { token, expires_at },
            conversation: overseen,
            members,
        })
    }

    /// 查看中的会话里的一段消息。已撤回的带着原内容。
    pub async fn view_messages(
        &self,
        admin: &AuthContext,
        conversation: ConversationId,
        token: &str,
        query: HistoryQuery,
    ) -> Result<Page, AdminError> {
        self.check_view(admin, conversation, token)?;
        Ok(self.deps.chat.oversee_history(conversation, query).await?)
    }

    /// 查看中的会话里的一个文件。
    pub async fn view_file(
        &self,
        admin: &AuthContext,
        conversation: ConversationId,
        token: &str,
        file: FileId,
    ) -> Result<StoredFile, FileError> {
        if self.check_view(admin, conversation, token).is_err() {
            // 和"没有这个文件"不作区分
            return Err(FileError::NotFound);
        }
        self.deps.files.open_in(conversation, file).await
    }

    fn check_view(
        &self,
        admin: &AuthContext,
        conversation: ConversationId,
        token: &str,
    ) -> Result<(), AdminError> {
        let now = self.deps.clock.now_ms();
        let views = self.views.lock().unwrap_or_else(PoisonError::into_inner);
        let valid = views.get(&hash_token(token)).is_some_and(|view| {
            view.session == admin.session.id
                && view.conversation == conversation
                && view.expires_at > now
        });
        if valid {
            Ok(())
        } else {
            Err(AdminError::ViewRequired)
        }
    }

    /// 解散一个群。成员看到"群已被管理员解散"，之后谁都不能再发消息，历史保留。
    pub async fn dissolve_group(
        &self,
        admin: &User,
        conversation: ConversationId,
    ) -> Result<Posted, AdminError> {
        let overseen = self.overseen(conversation).await?;
        if overseen.conversation.kind != ConversationKind::Group {
            return Err(AdminError::ConversationNotFound);
        }
        if overseen.conversation.dissolved {
            return Err(AdminError::GroupDissolved);
        }
        let detail = AuditDetail {
            label: Some(overseen.label()),
            ..AuditDetail::default()
        };
        self.record(
            admin,
            AuditAction::GroupDissolved,
            Some(conversation.to_string()),
            detail,
        )
        .await?;
        match self.deps.chat.dissolve_as_admin(conversation).await {
            Err(ChatError::GroupDissolved) => Err(AdminError::GroupDissolved),
            other => Ok(other?),
        }
    }

    async fn overseen(&self, conversation: ConversationId) -> Result<Overseen, AdminError> {
        match self.deps.chat.oversee(conversation).await {
            Err(ChatError::ConversationNotFound) => Err(AdminError::ConversationNotFound),
            other => Ok(other?),
        }
    }

    // ---------- 找回密码和修改邮箱 ----------

    /// 管理员请求找回密码。邮箱对的话发出一封带链接的邮件；
    /// 不管对不对，结果都一样，不让人借此试出管理员的邮箱。
    pub async fn request_password_reset(
        &self,
        email: &str,
        source: &str,
    ) -> Result<(), AdminError> {
        self.reset_limiter
            .hit(source)
            .map_err(|retry_after_ms| AdminError::RateLimited {
                retry_after_secs: millis_to_secs(retry_after_ms),
            })?;
        let Some(admin) = self.deps.users.find_admin().await? else {
            return Ok(());
        };
        let matches = admin
            .email
            .as_deref()
            .is_some_and(|known| known.eq_ignore_ascii_case(email.trim()));
        if !matches || admin.status != UserStatus::Active {
            return Ok(());
        }
        let Some(to) = admin.email.clone() else {
            return Ok(());
        };
        let token = self
            .issue_token(admin.id, TokenPurpose::ResetPassword, None)
            .await?;
        let link = format!("{}/reset-password?token={token}", self.base_url());
        // 发不出去也不报错：报了错，就等于告诉对方这个邮箱是对的
        let _ = self
            .deps
            .mailer
            .send(&reset_mail(&to, &link, admin.language))
            .await;
        Ok(())
    }

    /// 凭邮件里的链接设一个新密码。成功后管理员的全部登录失效，返回被结束的那些登录。
    pub async fn reset_password_with_token(
        &self,
        token: &str,
        new_password: &str,
    ) -> Result<Vec<SessionId>, AdminError> {
        // 先看密码合不合规则：不合规则时链接还能再用
        let admin = self.deps.users.find_admin().await?;
        let handle = admin.as_ref().map(|admin| admin.handle.as_str());
        password::check_strength(new_password, handle)?;

        let used = self.use_token(token, TokenPurpose::ResetPassword).await?;
        let hash = self.deps.hasher.hash(new_password).await;
        self.deps
            .users
            .set_password(used.user, &hash, false)
            .await?;
        Ok(self.deps.sessions.delete_others(used.user, None).await?)
    }

    /// 管理员修改绑定的邮箱：验证当前密码，向新邮箱发一封确认邮件。
    /// 点了里面的链接才生效，在那之前旧邮箱照常有效。
    pub async fn request_email_change(
        &self,
        admin: &User,
        current_password: &str,
        email: &str,
    ) -> Result<(), AdminError> {
        let hasher = &self.deps.hasher;
        if !hasher.verify(current_password, &admin.password_hash).await {
            return Err(AccountError::PasswordIncorrect.into());
        }
        let email = clean_email(email)?;
        let token = self
            .issue_token(admin.id, TokenPurpose::ConfirmEmail, Some(email.clone()))
            .await?;
        let link = format!("{}/confirm-email?token={token}", self.base_url());
        self.deps
            .mailer
            .send(&confirm_mail(&email, &link, admin.language))
            .await?;
        Ok(())
    }

    /// 凭确认邮件里的链接让新邮箱生效。返回改好之后的管理员。
    pub async fn confirm_email(&self, token: &str) -> Result<User, AdminError> {
        let used = self.use_token(token, TokenPurpose::ConfirmEmail).await?;
        let email = used.email.ok_or(AdminError::TokenInvalid)?;
        self.deps.users.set_email(used.user, &email).await?;
        let found = self.deps.users.find(used.user).await?;
        found.ok_or(AdminError::UserNotFound)
    }

    async fn issue_token(
        &self,
        user: UserId,
        purpose: TokenPurpose,
        email: Option<String>,
    ) -> Result<String, AdminError> {
        let token = hex(&random_bytes::<32>());
        let stored = AdminToken {
            token_hash: hash_token(&token),
            user,
            purpose,
            email,
            expires_at: self.deps.clock.now_ms() + LINK_TTL_MS,
            used_at: None,
        };
        self.deps.tokens.create(&stored).await?;
        Ok(token)
    }

    async fn use_token(
        &self,
        token: &str,
        purpose: TokenPurpose,
    ) -> Result<AdminToken, AdminError> {
        let now = self.deps.clock.now_ms();
        let tokens = &self.deps.tokens;
        let used = tokens.consume(&hash_token(token), purpose, now).await?;
        used.ok_or(AdminError::TokenInvalid)
    }

    fn base_url(&self) -> &str {
        self.deps.public_url.trim_end_matches('/')
    }
}

/// 写进操作记录的用户名称：昵称和当时的 ID。
fn named(user: &User) -> AuditDetail {
    AuditDetail {
        label: Some(format!("{} ({})", user.nickname, user.handle)),
        ..AuditDetail::default()
    }
}

fn counted(count: u64) -> AuditDetail {
    AuditDetail {
        count: Some(count as u32),
        ..AuditDetail::default()
    }
}

/// 一项设置在设置表里叫什么。
fn setting_name(key: SettingKey) -> &'static str {
    match key {
        SettingKey::FileMaxBytes => FILE_MAX_BYTES_SETTING,
        SettingKey::GroupMaxMembers => GROUP_MAX_MEMBERS_SETTING,
        SettingKey::VoiceMaxSeconds => VOICE_MAX_SECONDS_SETTING,
        SettingKey::RecallWindowSeconds => RECALL_WINDOW_SECONDS_SETTING,
        SettingKey::EditWindowSeconds => EDIT_WINDOW_SECONDS_SETTING,
        SettingKey::RetentionDays => RETENTION_DAYS_SETTING,
        SettingKey::ScreenMaxWidth => SCREEN_MAX_WIDTH_SETTING,
        SettingKey::GroupCallMax => crate::limits::GROUP_CALL_MAX_SETTING,
        SettingKey::ScreenMaxFps => SCREEN_MAX_FPS_SETTING,
        SettingKey::ScreenDirectKbps => SCREEN_DIRECT_KBPS_SETTING,
        SettingKey::ScreenRelayKbps => SCREEN_RELAY_KBPS_SETTING,
        SettingKey::CameraRelayKbps => CAMERA_RELAY_KBPS_SETTING,
        SettingKey::GroupCameraHighKbps => crate::limits::GROUP_CAMERA_HIGH_KBPS_SETTING,
        SettingKey::GroupCameraLowKbps => crate::limits::GROUP_CAMERA_LOW_KBPS_SETTING,
        SettingKey::GroupScreenKbps => crate::limits::GROUP_SCREEN_KBPS_SETTING,
    }
}

fn check_range<T: PartialOrd>(key: SettingKey, value: T, range: (T, T)) -> Result<(), AdminError> {
    if value < range.0 || value > range.1 {
        return Err(AdminError::SettingOutOfRange { key: key.as_str() });
    }
    Ok(())
}

fn clean_search(search: Option<&str>) -> Result<Option<String>, AdminError> {
    let search = search.map(str::trim).filter(|search| !search.is_empty());
    if search.is_some_and(|search| search.chars().count() > SEARCH_MAX_CHARS) {
        return Err(AdminError::Invalid("search text is too long"));
    }
    Ok(search.map(str::to_owned))
}

/// 邮箱的样子：一个 @，前后都有内容，后面那段里有点，没有空白。
fn clean_email(email: &str) -> Result<String, AdminError> {
    let email = email.trim();
    let valid = email.chars().count() <= EMAIL_MAX_CHARS
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.contains('@')
                && domain.split('.').count() >= 2
                && domain.split('.').all(|part| !part.is_empty())
        });
    if valid {
        Ok(email.to_owned())
    } else {
        Err(AdminError::EmailInvalid)
    }
}

/// 一个符合密码规则的临时密码。
fn temp_password(handle: &str) -> String {
    loop {
        let candidate = random_string(TEMP_PASSWORD_ALPHABET, TEMP_PASSWORD_LEN);
        if password::check_strength(&candidate, Some(handle)).is_ok() {
            return candidate;
        }
    }
}

/// 邮件用哪种语言写：管理员选过界面语言就用它，没有选过用中文。
fn reset_mail(to: &str, link: &str, language: Option<Language>) -> Mail {
    let (subject, body) = match language {
        Some(Language::En) => (
            "Reset your VibeChat password",
            format!(
                "Someone asked to reset the administrator password of VibeChat.\n\n\
                 Open this link to set a new password. It works once and expires in 30 minutes:\n\n\
                 {link}\n\n\
                 If this was not you, ignore this message; the password stays unchanged.\n"
            ),
        ),
        _ => (
            "重置 VibeChat 的密码",
            format!(
                "有人请求重置 VibeChat 管理员的密码。\n\n\
                 打开下面的链接设一个新密码。链接只能用一次，30 分钟内有效：\n\n\
                 {link}\n\n\
                 如果不是你本人的操作，不用理会这封邮件，密码不会改变。\n"
            ),
        ),
    };
    Mail {
        to: to.to_owned(),
        subject: subject.to_owned(),
        body,
    }
}

fn confirm_mail(to: &str, link: &str, language: Option<Language>) -> Mail {
    let (subject, body) = match language {
        Some(Language::En) => (
            "Confirm your new email address for VibeChat",
            format!(
                "The VibeChat administrator asked to use this address for password recovery.\n\n\
                 Open this link to confirm. It works once and expires in 30 minutes:\n\n\
                 {link}\n\n\
                 If this was not you, ignore this message; nothing changes.\n"
            ),
        ),
        _ => (
            "确认 VibeChat 的新邮箱",
            format!(
                "VibeChat 的管理员请求把这个邮箱用于找回密码。\n\n\
                 打开下面的链接确认。链接只能用一次，30 分钟内有效：\n\n\
                 {link}\n\n\
                 如果不是你本人的操作，不用理会这封邮件，什么都不会改变。\n"
            ),
        ),
    };
    Mail {
        to: to.to_owned(),
        subject: subject.to_owned(),
        body,
    }
}
