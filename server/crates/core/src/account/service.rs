//! 账号相关的业务流程。接口层只负责把请求翻译成对这里的调用。

use std::sync::Arc;

use sha2::{Digest, Sha256};

use super::error::AccountError;
use super::guard::{LoginGuard, RateLimiter};
use super::handle::{self, ADMIN_HANDLE};
use super::model::{
    FilePurpose, InviteCode, InviteCodeOrder, InviteCodeQuery, InviteCodeState, InviteCodeStatus,
    ProfileChanges, Role, Session, StoredFile, User, UserStatus,
};
use super::password::{self, PasswordHasher};
use super::store::{
    CreateUserError, FileStore, ImageProcessor, InviteCodeStore, SessionStore, UserStore,
};
use crate::blob::BlobStore;
use crate::clock::Clock;
use crate::ids::{FileId, InviteCodeId, SessionId, UserId};
use crate::random::{hex, random_bytes, random_string};

/// 登录保持多久：30 天不活跃后过期，每次使用顺延。
pub const SESSION_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// 不必每个请求都写一次数据库：距上次记录超过这么久才顺延。
const SESSION_TOUCH_INTERVAL_MS: i64 = 60 * 1000;

pub const AVATAR_MAX_BYTES: usize = 5 * 1024 * 1024;
const NICKNAME_MAX_CHARS: usize = 32;
const SIGNATURE_MAX_CHARS: usize = 100;

/// 邀请码用的字符：去掉了容易看混的 0、O、1、I。
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_LEN: usize = 16;
pub const MAX_INVITE_CODES_PER_REQUEST: u32 = 20;
/// 一次最多作废或删除多少个邀请码。
pub const MAX_INVITE_CODES_PER_BATCH: usize = 500;
/// 邀请码列表每页的数量：默认值和上限。
pub const INVITE_CODES_PAGE_SIZE: u32 = 20;
pub const INVITE_CODES_PAGE_SIZE_MAX: u32 = 100;

/// 要看邀请码列表的哪一页。页码从 1 开始。
#[derive(Debug, Clone, Copy)]
pub struct InviteCodeListing {
    pub page: u32,
    pub page_size: u32,
    /// 只看某种状态的；不指定则全部。
    pub state: Option<InviteCodeState>,
    pub order: InviteCodeOrder,
}

impl Default for InviteCodeListing {
    fn default() -> Self {
        Self {
            page: 1,
            page_size: INVITE_CODES_PAGE_SIZE,
            state: None,
            order: InviteCodeOrder::default(),
        }
    }
}

/// 邀请码列表的一页。
pub struct InviteCodePage {
    /// 这一页的邀请码；已使用的带上使用它的用户。
    pub entries: Vec<(InviteCode, Option<User>)>,
    /// 符合条件的邀请码一共有多少。
    pub total: u64,
}
const INVITE_NOTE_MAX_CHARS: usize = 100;
const INVITE_MAX_VALID_DAYS: u32 = 365;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const RATE_WINDOW_MS: i64 = 60 * 1000;
/// 分配默认 ID 时撞上已有的 ID 就重新生成，最多试这么多次。
const HANDLE_ATTEMPTS: usize = 5;

/// 同一来源地址每分钟允许的次数。
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub logins_per_minute: u32,
    pub registrations_per_minute: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            logins_per_minute: 20,
            registrations_per_minute: 10,
        }
    }
}

pub struct AccountServiceDeps {
    pub users: Arc<dyn UserStore>,
    pub sessions: Arc<dyn SessionStore>,
    pub invite_codes: Arc<dyn InviteCodeStore>,
    pub files: Arc<dyn FileStore>,
    pub blobs: Arc<dyn BlobStore>,
    pub images: Arc<dyn ImageProcessor>,
    pub hasher: Arc<dyn PasswordHasher>,
    pub clock: Arc<dyn Clock>,
    pub limits: Limits,
}

/// 一个已经确认身份的请求：是谁，用的是哪一次登录。
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user: User,
    pub session: Session,
}

/// 登录或注册成功的结果。`token` 只在这里出现一次，交给客户端保存。
#[derive(Debug)]
pub struct LoginOutcome {
    pub user: User,
    pub session: Session,
    pub token: String,
}

pub struct Registration<'a> {
    pub invite_code: &'a str,
    pub nickname: &'a str,
    pub password: &'a str,
    pub user_agent: &'a str,
    /// 请求的来源地址，用于限速。
    pub source: &'a str,
}

/// 生成一批邀请码的参数。
#[derive(Debug, Clone, Copy)]
pub struct NewInviteCodes<'a> {
    pub count: u32,
    /// 备注，例如发给谁。这一批共用。
    pub note: Option<&'a str>,
    /// 多少天后过期；`None` 表示长期有效。
    pub expires_in_days: Option<u32>,
}

pub struct AccountService {
    deps: AccountServiceDeps,
    guard: LoginGuard,
    login_limiter: RateLimiter,
    registration_limiter: RateLimiter,
    /// ID 不存在时也拿它校验一次密码，让"ID 不存在"和"密码错误"花的时间差不多。
    dummy_hash: String,
}

impl AccountService {
    pub async fn new(deps: AccountServiceDeps) -> Self {
        let dummy_hash = deps.hasher.hash("placeholder-password-0").await;
        Self {
            guard: LoginGuard::new(deps.clock.clone()),
            login_limiter: RateLimiter::new(
                deps.clock.clone(),
                deps.limits.logins_per_minute,
                RATE_WINDOW_MS,
            ),
            registration_limiter: RateLimiter::new(
                deps.clock.clone(),
                deps.limits.registrations_per_minute,
                RATE_WINDOW_MS,
            ),
            dummy_hash,
            deps,
        }
    }

    /// 数据库里还没有管理员时创建第一名管理员，返回是否创建了。
    pub async fn bootstrap_admin(
        &self,
        email: &str,
        initial_password: &str,
    ) -> Result<bool, AccountError> {
        let now = self.deps.clock.now_ms();
        let admin = User {
            id: UserId::new(),
            handle: ADMIN_HANDLE.to_owned(),
            nickname: "Admin".to_owned(),
            signature: String::new(),
            avatar: None,
            password_hash: self.deps.hasher.hash(initial_password).await,
            role: Role::Admin,
            status: UserStatus::Active,
            // 初始密码写在配置里，第一次登录后必须换掉
            must_change_password: true,
            email: Some(email.to_owned()),
            language: None,
            theme: None,
            created_at: now,
            last_login_at: None,
        };
        Ok(self.deps.users.create_admin_if_none(&admin).await?)
    }

    pub async fn register(&self, input: Registration<'_>) -> Result<LoginOutcome, AccountError> {
        self.registration_limiter
            .hit(input.source)
            .map_err(rate_limited)?;

        let now = self.deps.clock.now_ms();
        let code = normalize_invite_code(input.invite_code);
        let invite = self
            .deps
            .invite_codes
            .find_by_code(&code)
            .await?
            .ok_or(AccountError::InviteCodeNotFound)?;
        match invite.status {
            InviteCodeStatus::Used => return Err(AccountError::InviteCodeUsed),
            InviteCodeStatus::Revoked => return Err(AccountError::InviteCodeRevoked),
            InviteCodeStatus::Unused => {}
        }
        if invite.is_expired(now) {
            return Err(AccountError::InviteCodeExpired);
        }

        let nickname = clean_nickname(input.nickname)?;
        password::check_strength(input.password, None)?;
        let password_hash = self.deps.hasher.hash(input.password).await;

        let mut user = User {
            id: UserId::new(),
            handle: String::new(),
            nickname,
            signature: String::new(),
            avatar: None,
            password_hash,
            role: Role::User,
            status: UserStatus::Active,
            must_change_password: false,
            email: None,
            language: None,
            theme: None,
            created_at: now,
            last_login_at: Some(now),
        };
        let mut attempts = 0;
        loop {
            user.handle = handle::generate_default();
            match self
                .deps
                .users
                .create_with_invite(&user, invite.id, now)
                .await
            {
                Ok(()) => break,
                Err(CreateUserError::HandleTaken) if attempts + 1 < HANDLE_ATTEMPTS => {
                    attempts += 1
                }
                Err(CreateUserError::HandleTaken) => {
                    return Err(AccountError::Invalid("could not allocate an id"));
                }
                // 校验之后、写入之前被别人抢先用掉了
                Err(CreateUserError::InviteCodeUnavailable) => {
                    return Err(AccountError::InviteCodeUsed);
                }
                Err(CreateUserError::Store(err)) => return Err(err.into()),
            }
        }

        self.start_session(user, input.user_agent, input.source)
            .await
    }

    pub async fn login(
        &self,
        handle: &str,
        password: &str,
        user_agent: &str,
        source: &str,
    ) -> Result<LoginOutcome, AccountError> {
        self.login_limiter.hit(source).map_err(rate_limited)?;

        let key = handle::normalize(handle);
        if let Err(retry_after_ms) = self.guard.check(&key) {
            return Err(AccountError::Locked {
                retry_after_secs: millis_to_secs(retry_after_ms),
            });
        }

        let user = self.deps.users.find_by_handle(&key).await?;
        let hash = user
            .as_ref()
            .map_or(self.dummy_hash.as_str(), |user| user.password_hash.as_str());
        let password_ok = self.deps.hasher.verify(password, hash).await;
        let Some(user) = user.filter(|_| password_ok) else {
            self.guard.record_failure(&key);
            return Err(AccountError::InvalidCredentials);
        };

        // 只有密码正确的人才会知道账号被禁用了
        if user.status == UserStatus::Disabled {
            return Err(AccountError::Disabled);
        }

        self.guard.record_success(&key);
        let now = self.deps.clock.now_ms();
        self.deps.users.record_login(user.id, now).await?;
        self.start_session(user, user_agent, source).await
    }

    /// 根据客户端带来的令牌确认身份。令牌无效、已过期或账号被禁用时返回 `None`。
    pub async fn authenticate(&self, token: &str) -> Result<Option<AuthContext>, AccountError> {
        let now = self.deps.clock.now_ms();
        let Some(mut session) = self
            .deps
            .sessions
            .find_by_token_hash(&hash_token(token))
            .await?
        else {
            return Ok(None);
        };
        if session.expires_at <= now {
            self.deps.sessions.delete(session.id).await?;
            return Ok(None);
        }
        let Some(user) = self.deps.users.find(session.user_id).await? else {
            return Ok(None);
        };
        if user.status == UserStatus::Disabled {
            return Ok(None);
        }

        if now - session.last_seen_at >= SESSION_TOUCH_INTERVAL_MS {
            session.last_seen_at = now;
            session.expires_at = now + SESSION_TTL_MS;
            self.deps
                .sessions
                .touch(session.id, session.last_seen_at, session.expires_at)
                .await?;
        }
        Ok(Some(AuthContext { user, session }))
    }

    pub async fn logout(&self, session: SessionId) -> Result<(), AccountError> {
        Ok(self.deps.sessions.delete(session).await?)
    }

    /// 修改密码。成功后这个账号在其他地方的登录全部失效，返回被结束的那些登录。
    pub async fn change_password(
        &self,
        auth: &AuthContext,
        current: &str,
        new: &str,
    ) -> Result<Vec<SessionId>, AccountError> {
        let user = &auth.user;
        if !self.deps.hasher.verify(current, &user.password_hash).await {
            return Err(AccountError::PasswordIncorrect);
        }
        if current == new {
            return Err(AccountError::PasswordUnchanged);
        }
        password::check_strength(new, Some(&user.handle))?;

        let hash = self.deps.hasher.hash(new).await;
        self.deps.users.set_password(user.id, &hash, false).await?;
        Ok(self
            .deps
            .sessions
            .delete_others(user.id, Some(auth.session.id))
            .await?)
    }

    pub async fn change_handle(&self, auth: &AuthContext, new: &str) -> Result<User, AccountError> {
        let new = new.trim();
        if !handle::is_valid_custom(new) {
            return Err(AccountError::HandleInvalid);
        }
        if !self.deps.users.set_handle(auth.user.id, new).await? {
            return Err(AccountError::HandleTaken);
        }
        self.reload(auth.user.id).await
    }

    pub async fn update_profile(
        &self,
        auth: &AuthContext,
        changes: ProfileChanges,
    ) -> Result<User, AccountError> {
        let changes = ProfileChanges {
            nickname: changes
                .nickname
                .as_deref()
                .map(clean_nickname)
                .transpose()?,
            signature: changes
                .signature
                .as_deref()
                .map(clean_signature)
                .transpose()?,
            ..changes
        };
        self.deps
            .users
            .update_profile(auth.user.id, &changes)
            .await?;
        self.reload(auth.user.id).await
    }

    /// 更换头像。`content` 是用户上传的原始内容。
    pub async fn set_avatar(
        &self,
        auth: &AuthContext,
        content: &[u8],
    ) -> Result<User, AccountError> {
        let id = self.store_avatar(auth, content).await?;
        self.deps.users.set_avatar(auth.user.id, id).await?;
        self.reload(auth.user.id).await
    }

    /// 把上传的图片处理成头像并保存，返回文件的编号。个人头像和群头像都走这里。
    pub async fn store_avatar(
        &self,
        auth: &AuthContext,
        content: &[u8],
    ) -> Result<FileId, AccountError> {
        if content.len() > AVATAR_MAX_BYTES {
            return Err(AccountError::FileTooLarge);
        }
        let image = self
            .deps
            .images
            .process_avatar(content.to_vec())
            .await
            .ok_or(AccountError::ImageUnsupported)?;

        let now = self.deps.clock.now_ms();
        let id = FileId::new();
        let file = StoredFile {
            id,
            // 路径完全由服务端生成，不包含任何用户提供的内容
            storage_key: format!("avatar/{}/{id}", auth.user.id),
            content_type: image.content_type.to_owned(),
            size: image.content.len() as i64,
            uploader: auth.user.id,
            purpose: FilePurpose::Avatar,
            width: Some(image.width as i32),
            height: Some(image.height as i32),
            name: None,
            thumbnail_key: None,
            created_at: now,
        };
        self.deps
            .blobs
            .put(&file.storage_key, image.content)
            .await?;
        self.deps.files.create(&file).await?;
        Ok(id)
    }

    /// 读取一个文件。头像对所有已登录的用户开放。
    pub async fn read_file(
        &self,
        _auth: &AuthContext,
        id: FileId,
    ) -> Result<(StoredFile, Vec<u8>), AccountError> {
        let file = self
            .deps
            .files
            .find(id)
            .await?
            .ok_or(AccountError::NotFound)?;
        match file.purpose {
            FilePurpose::Avatar => {}
            // 消息附件要看请求者能不能看到那条消息，不在这里读，见 `FileService`
            FilePurpose::Attachment => return Err(AccountError::NotFound),
        }
        let content = self
            .deps
            .blobs
            .get(&file.storage_key)
            .await?
            .ok_or(AccountError::NotFound)?;
        Ok((file, content))
    }

    pub async fn create_invite_codes(
        &self,
        created_by: UserId,
        new: NewInviteCodes<'_>,
    ) -> Result<Vec<InviteCode>, AccountError> {
        check_new_invite_codes(&new)?;
        let note = new.note.map(str::trim).filter(|note| !note.is_empty());

        let now = self.deps.clock.now_ms();
        let expires_at = new
            .expires_in_days
            .map(|days| now + i64::from(days) * DAY_MS);
        let codes: Vec<InviteCode> = (0..new.count)
            .map(|_| InviteCode {
                id: InviteCodeId::new(),
                code: random_string(INVITE_ALPHABET, INVITE_LEN),
                note: note.map(str::to_owned),
                status: InviteCodeStatus::Unused,
                expires_at,
                created_by,
                created_at: now,
                used_by: None,
                used_at: None,
            })
            .collect();
        self.deps.invite_codes.create_many(&codes).await?;
        Ok(codes)
    }

    /// 作废一个还没有使用的邀请码，之后它不能再用于注册。
    pub async fn revoke_invite_code(&self, id: InviteCodeId) -> Result<InviteCode, AccountError> {
        let revoked = self.deps.invite_codes.revoke(&[id]).await? == 1;
        let invite = self
            .deps
            .invite_codes
            .find(id)
            .await?
            .ok_or(AccountError::NotFound)?;
        if revoked {
            return Ok(invite);
        }
        // 没有作废成：说明它已经不是"未使用"了
        Err(match invite.status {
            InviteCodeStatus::Used => AccountError::InviteCodeUsed,
            _ => AccountError::InviteCodeRevoked,
        })
    }

    /// 一次作废多个邀请码，返回作废了几个。
    /// 其中已经使用、已经作废或不存在的会被跳过，不算出错。
    pub async fn revoke_invite_codes(&self, ids: &[InviteCodeId]) -> Result<u64, AccountError> {
        check_batch(ids)?;
        if ids.is_empty() {
            return Ok(0);
        }
        Ok(self.deps.invite_codes.revoke(ids).await?)
    }

    /// 删除已经作废或已经过期的邀请码，返回删除了几个。
    /// 还能使用的要先作废；已经使用的记着是谁凭它注册的，不能删除。这两种都会被跳过。
    pub async fn delete_invite_codes(&self, ids: &[InviteCodeId]) -> Result<u64, AccountError> {
        check_batch(ids)?;
        if ids.is_empty() {
            return Ok(0);
        }
        let now = self.deps.clock.now_ms();
        Ok(self.deps.invite_codes.delete_dead(ids, now).await?)
    }

    /// 邀请码列表的一页，可以按状态筛选、按生成时间排序。
    pub async fn list_invite_codes(
        &self,
        listing: InviteCodeListing,
    ) -> Result<InviteCodePage, AccountError> {
        let InviteCodeListing {
            page,
            page_size,
            state,
            order,
        } = listing;
        if page == 0 {
            return Err(AccountError::Invalid("page starts at 1"));
        }
        if page_size == 0 || page_size > INVITE_CODES_PAGE_SIZE_MAX {
            return Err(AccountError::Invalid("page_size must be between 1 and 100"));
        }
        let query = InviteCodeQuery {
            state,
            order,
            offset: u64::from(page - 1) * u64::from(page_size),
            limit: u64::from(page_size),
            now: self.deps.clock.now_ms(),
        };
        let (codes, total) = self.deps.invite_codes.list(&query).await?;
        let mut entries = Vec::with_capacity(codes.len());
        for invite in codes {
            let used_by = match invite.used_by {
                Some(id) => self.deps.users.find(id).await?,
                None => None,
            };
            entries.push((invite, used_by));
        }
        Ok(InviteCodePage { entries, total })
    }

    pub async fn has_admin(&self) -> Result<bool, AccountError> {
        Ok(self.deps.users.has_admin().await?)
    }

    /// 我此刻还有效的全部登录（F9）：本机排在最前面，其余的按最近活跃从近到远。
    pub async fn sessions(&self, context: &AuthContext) -> Result<Vec<Session>, AccountError> {
        let now = self.deps.clock.now_ms();
        let mut found = self
            .deps
            .sessions
            .list_for_user(context.user.id, now)
            .await?;
        found.sort_by_key(|session| (session.id != context.session.id, -session.last_seen_at));
        Ok(found)
    }

    /// 让我的另一台设备下线（F9）。本机不在这里：用"退出登录"。不是我的、已经没有了的，算找不到。
    pub async fn sign_out_session(
        &self,
        context: &AuthContext,
        id: SessionId,
    ) -> Result<(), AccountError> {
        if id == context.session.id {
            return Err(AccountError::Invalid("use logout for this device"));
        }
        if !self
            .deps
            .sessions
            .delete_for_user(context.user.id, id)
            .await?
        {
            return Err(AccountError::NotFound);
        }
        Ok(())
    }

    /// 让除本机以外的全部设备下线（F9），交回下线了的那些。
    pub async fn sign_out_others(
        &self,
        context: &AuthContext,
    ) -> Result<Vec<SessionId>, AccountError> {
        Ok(self
            .deps
            .sessions
            .delete_others(context.user.id, Some(context.session.id))
            .await?)
    }

    pub fn now_ms(&self) -> i64 {
        self.deps.clock.now_ms()
    }

    async fn start_session(
        &self,
        user: User,
        user_agent: &str,
        source: &str,
    ) -> Result<LoginOutcome, AccountError> {
        let now = self.deps.clock.now_ms();
        let token = hex(&random_bytes::<32>());
        let session = Session {
            id: SessionId::new(),
            user_id: user.id,
            token_hash: hash_token(&token),
            created_at: now,
            last_seen_at: now,
            expires_at: now + SESSION_TTL_MS,
            user_agent: user_agent.chars().take(255).collect(),
            // 拿不到来源地址时（不该发生）不记
            ip: (source != "unknown" && !source.is_empty())
                .then(|| source.chars().take(64).collect()),
        };
        self.deps.sessions.create(&session).await?;
        Ok(LoginOutcome {
            user,
            session,
            token,
        })
    }

    async fn reload(&self, id: UserId) -> Result<User, AccountError> {
        self.deps
            .users
            .find(id)
            .await?
            .ok_or(AccountError::NotFound)
    }
}

/// 数据库里只保存令牌的哈希：即使数据库泄露，也无法用里面的内容冒充已登录的用户。
pub fn hash_token(token: &str) -> String {
    hex(Sha256::digest(token.as_bytes()).as_slice())
}

/// 邀请码按 4 位一组显示，输入时忽略分隔符和大小写。
fn normalize_invite_code(code: &str) -> String {
    code.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn clean_nickname(nickname: &str) -> Result<String, AccountError> {
    let nickname = nickname.trim();
    let length = nickname.chars().count();
    if length == 0 || length > NICKNAME_MAX_CHARS || nickname.chars().any(char::is_control) {
        return Err(AccountError::NicknameInvalid);
    }
    Ok(nickname.to_owned())
}

fn clean_signature(signature: &str) -> Result<String, AccountError> {
    let signature = signature.trim();
    if signature.chars().count() > SIGNATURE_MAX_CHARS || signature.chars().any(char::is_control) {
        return Err(AccountError::SignatureTooLong);
    }
    Ok(signature.to_owned())
}

fn rate_limited(retry_after_ms: i64) -> AccountError {
    AccountError::RateLimited {
        retry_after_secs: millis_to_secs(retry_after_ms),
    }
}

/// 向上取整到秒：告诉用户"还要等 1 秒"好过"还要等 0 秒"。
pub fn millis_to_secs(ms: i64) -> u64 {
    (ms.max(0) as u64).div_ceil(1000)
}

/// 生成邀请码的参数是否合乎规则。
pub fn check_new_invite_codes(new: &NewInviteCodes<'_>) -> Result<(), AccountError> {
    if new.count == 0 || new.count > MAX_INVITE_CODES_PER_REQUEST {
        return Err(AccountError::Invalid("count must be between 1 and 20"));
    }
    let note = new.note.map(str::trim).filter(|note| !note.is_empty());
    if note.is_some_and(|note| note.chars().count() > INVITE_NOTE_MAX_CHARS) {
        return Err(AccountError::Invalid("note is too long"));
    }
    if new
        .expires_in_days
        .is_some_and(|days| days == 0 || days > INVITE_MAX_VALID_DAYS)
    {
        return Err(AccountError::Invalid(
            "expires_in_days must be between 1 and 365",
        ));
    }
    Ok(())
}

/// 一次处理的邀请码个数是否在上限之内。
pub fn check_batch(ids: &[InviteCodeId]) -> Result<(), AccountError> {
    if ids.len() > MAX_INVITE_CODES_PER_BATCH {
        return Err(AccountError::Invalid(
            "at most 500 invite codes can be handled at once",
        ));
    }
    Ok(())
}
