//! 测试用的假实现：全部数据放在内存里，时间可以拨动，密码哈希不做真正的计算。
//!
//! 假的数据存储在行为上与真实的数据库一致（唯一性、邀请码只能用一次），
//! 这样业务逻辑的测试不需要数据库也能覆盖这些情况。

use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::StreamExt;

use crate::account::handle::normalize;
use crate::account::model::{
    FilePurpose, InviteCode, InviteCodeOrder, InviteCodeQuery, InviteCodeStatus, ProfileChanges,
    Role, Session, StoredFile, User, UserCounts, UserQuery, UserStatus,
};
use crate::account::password::PasswordHasher;
use crate::account::store::{
    CreateUserError, FileStore, ImageProcessor, InviteCodeStore, ProcessedImage, SessionStore,
    Thumbnail, UserStore,
};
use crate::account::{AccountService, AccountServiceDeps, Limits};
use crate::admin::model::{AdminToken, AuditAction, AuditEntry, TokenPurpose};
use crate::admin::service::RESET_REQUESTS_PER_MINUTE;
use crate::admin::store::{AuditStore, TokenStore};
use crate::admin::{AdminService, AdminServiceDeps};
use crate::blob::{BlobStore, ByteStream, HEAD_BYTES, Written};
use crate::chat::model::{
    Appended, Change, Changed, Conversation, ConversationKind, Edit, JoinRequest,
    JoinRequestStatus, Listing, Member, Message, MessageKind, NewGroup, NewMessage, Notice, Purged,
    SearchScope, Visible,
};
use crate::chat::store::ChatStore;
use crate::chat::{ChatService, ChatServiceDeps};
use crate::clock::Clock;
use crate::contact::model::{FriendRequest, FriendRequestStatus, Friendship};
use crate::contact::store::ContactStore;
use crate::contact::{ContactService, ContactServiceDeps};
use crate::file::{FileService, FileServiceDeps};
use crate::ids::{
    ConversationId, FileId, FriendRequestId, InviteCodeId, JoinRequestId, MessageId, SessionId,
    UserId,
};
use crate::mail::{Mail, Mailer};
use crate::settings::SettingsStore;
use crate::store::{StoreError, StoreHealth, Stores};

/// 只在被拨动时才走的时钟。
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(now_ms: i64) -> Self {
        Self(AtomicI64::new(now_ms))
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::Relaxed);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// 不做任何计算的密码"哈希"。每次结果都带一个不同的序号，保留"同一个密码两次结果不同"的性质。
#[derive(Default)]
pub struct PlainHasher(AtomicU64);

#[async_trait]
impl PasswordHasher for PlainHasher {
    async fn hash(&self, password: &str) -> String {
        format!(
            "plain${}${password}",
            self.0.fetch_add(1, Ordering::Relaxed)
        )
    }

    async fn verify(&self, password: &str, hash: &str) -> bool {
        hash.splitn(3, '$').nth(2) == Some(password)
    }
}

/// 把以 `IMG` 开头的内容当作图片，其余都不是。
pub struct FakeImages;

#[async_trait]
impl ImageProcessor for FakeImages {
    async fn process_avatar(&self, content: Vec<u8>) -> Option<ProcessedImage> {
        content.starts_with(b"IMG").then(|| ProcessedImage {
            content: content.clone(),
            content_type: "image/png",
            width: 64,
            height: 64,
        })
    }

    async fn thumbnail(&self, content: Vec<u8>) -> Option<Thumbnail> {
        // 假的"图片"：开头是 PNG 的标记，后面跟着 IMG
        content.ends_with(b"IMG").then(|| Thumbnail {
            content: b"THUMB".to_vec(),
            content_type: "image/jpeg",
            original_type: "image/png",
            width: 640,
            height: 480,
        })
    }
}

/// 一段会被 `FakeImages` 当作图片的内容。
pub fn fake_image() -> Vec<u8> {
    [b"\x89PNG\r\n\x1a\n".as_slice(), b"IMG"].concat()
}

/// 把一段内容变成"一段一段到来"的样子，每段 `chunk` 个字节。
pub fn byte_stream(content: &[u8], chunk: usize) -> ByteStream {
    let chunks: Vec<Result<Bytes, std::io::Error>> = content
        .chunks(chunk.max(1))
        .map(|part| Ok(Bytes::copy_from_slice(part)))
        .collect();
    Box::pin(futures_util::stream::iter(chunks))
}

#[derive(Default)]
struct Tables {
    users: Vec<User>,
    sessions: Vec<Session>,
    invite_codes: Vec<InviteCode>,
    files: Vec<StoredFile>,
    friend_requests: Vec<FriendRequest>,
    friendships: Vec<Friendship>,
    conversations: Vec<Conversation>,
    /// 单聊会话属于哪两个人（编号小的在前）。
    direct: HashMap<(UserId, UserId), ConversationId>,
    members: Vec<Member>,
    messages: Vec<Message>,
    join_requests: Vec<JoinRequest>,
    /// 谁播放了哪一条语音。
    voice_plays: Vec<(MessageId, UserId)>,
    /// 谁把哪个会话的第几条从自己这边删掉了（F6）。
    deleted: HashSet<(ConversationId, UserId, i64)>,
    settings: HashMap<String, String>,
    blobs: HashMap<String, Vec<u8>>,
    audit: Vec<AuditEntry>,
    tokens: Vec<AdminToken>,
}

/// 内存里的全部"数据表"。
pub struct MemoryStore {
    tables: Mutex<Tables>,
    pub healthy: AtomicBool,
    /// 设为假时操作记录写不进去，用来确认"记不下来就不做"。
    pub audit_writable: AtomicBool,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self {
            tables: Mutex::new(Tables::default()),
            healthy: AtomicBool::new(true),
            audit_writable: AtomicBool::new(true),
        }
    }
}

impl MemoryStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 以各个 trait 的形式交给业务逻辑。
    pub fn stores(self: &Arc<Self>) -> Stores {
        Stores {
            health: self.clone(),
            settings: self.clone(),
            users: self.clone(),
            sessions: self.clone(),
            invite_codes: self.clone(),
            files: self.clone(),
            contacts: self.clone(),
            chat: self.clone(),
            audit: self.clone(),
            tokens: self.clone(),
        }
    }

    /// 到现在为止的全部操作记录，按写入的先后。
    pub fn audit_entries(&self) -> Vec<AuditEntry> {
        self.tables.lock().unwrap().audit.clone()
    }

    /// 文件存储里有没有这一份内容。
    pub fn has_blob(&self, key: &str) -> bool {
        self.tables.lock().unwrap().blobs.contains_key(key)
    }

    /// 修改一条消息，用来构造"很久以前发的"等情况。
    pub fn edit_message(
        &self,
        conversation: ConversationId,
        seq: i64,
        edit: impl FnOnce(&mut Message),
    ) {
        let mut tables = self.tables.lock().unwrap();
        let message = tables
            .messages
            .iter_mut()
            .find(|m| m.conversation == conversation && m.seq == seq)
            .expect("message exists");
        edit(message);
    }

    /// 登记着的文件有几个（包括共用同一份内容的）。
    pub fn file_count(&self) -> usize {
        self.tables.lock().unwrap().files.len()
    }

    /// 直接放进一个邀请码，省去先建管理员再生成的步骤。
    pub fn add_invite_code(&self, code: &str, created_by: UserId) -> InviteCodeId {
        let id = InviteCodeId::new();
        self.tables.lock().unwrap().invite_codes.push(InviteCode {
            id,
            code: code.to_owned(),
            note: None,
            status: InviteCodeStatus::Unused,
            expires_at: None,
            created_by,
            created_at: 0,
            used_by: None,
            used_at: None,
        });
        id
    }

    /// 修改一个邀请码，用来构造已过期、已作废等情况。
    pub fn edit_invite_code(&self, code: &str, edit: impl FnOnce(&mut InviteCode)) {
        let mut tables = self.tables.lock().unwrap();
        let invite = tables
            .invite_codes
            .iter_mut()
            .find(|invite| invite.code == code)
            .expect("invite code exists");
        edit(invite);
    }

    /// 修改一个用户，用来构造被禁用等情况。
    pub fn edit_user(&self, id: UserId, edit: impl FnOnce(&mut User)) {
        let mut tables = self.tables.lock().unwrap();
        let user = tables
            .users
            .iter_mut()
            .find(|user| user.id == id)
            .expect("user exists");
        edit(user);
    }

    pub fn session_count(&self, user: UserId) -> usize {
        let tables = self.tables.lock().unwrap();
        tables
            .sessions
            .iter()
            .filter(|session| session.user_id == user)
            .count()
    }
}

fn handle_taken(users: &[User], handle: &str, except: Option<UserId>) -> bool {
    users
        .iter()
        .any(|user| Some(user.id) != except && normalize(&user.handle) == normalize(handle))
}

#[async_trait]
impl StoreHealth for MemoryStore {
    async fn ping(&self) -> Result<(), StoreError> {
        if self.healthy.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(StoreError::Unavailable("fake store is down".to_owned()))
        }
    }
}

#[async_trait]
impl SettingsStore for MemoryStore {
    async fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.tables.lock().unwrap().settings.get(key).cloned())
    }

    async fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        tables.settings.insert(key.to_owned(), value.to_owned());
        Ok(())
    }
}

#[async_trait]
impl UserStore for MemoryStore {
    async fn create_with_invite(
        &self,
        user: &User,
        invite_code: InviteCodeId,
        now: i64,
    ) -> Result<(), CreateUserError> {
        let mut tables = self.tables.lock().unwrap();
        if handle_taken(&tables.users, &user.handle, None) {
            return Err(CreateUserError::HandleTaken);
        }
        let invite = tables
            .invite_codes
            .iter_mut()
            .find(|invite| invite.id == invite_code)
            .filter(|invite| invite.status == InviteCodeStatus::Unused)
            .filter(|invite| invite.expires_at.is_none_or(|expires_at| expires_at > now))
            .ok_or(CreateUserError::InviteCodeUnavailable)?;
        invite.status = InviteCodeStatus::Used;
        invite.used_by = Some(user.id);
        invite.used_at = Some(now);
        tables.users.push(user.clone());
        Ok(())
    }

    async fn create_admin_if_none(&self, user: &User) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if tables.users.iter().any(|user| user.role == Role::Admin) {
            return Ok(false);
        }
        tables.users.push(user.clone());
        Ok(true)
    }

    async fn has_admin(&self) -> Result<bool, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.users.iter().any(|user| user.role == Role::Admin))
    }

    async fn find(&self, id: UserId) -> Result<Option<User>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.users.iter().find(|user| user.id == id).cloned())
    }

    async fn find_many(&self, ids: &[UserId]) -> Result<Vec<User>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .users
            .iter()
            .filter(|user| ids.contains(&user.id))
            .cloned()
            .collect())
    }

    async fn find_by_handle(&self, handle: &str) -> Result<Option<User>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .users
            .iter()
            .find(|user| normalize(&user.handle) == normalize(handle))
            .cloned())
    }

    async fn set_handle(&self, id: UserId, handle: &str) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if handle_taken(&tables.users, handle, Some(id)) {
            return Ok(false);
        }
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.handle = handle.to_owned();
        }
        Ok(true)
    }

    async fn set_password(
        &self,
        id: UserId,
        password_hash: &str,
        must_change_password: bool,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.password_hash = password_hash.to_owned();
            user.must_change_password = must_change_password;
        }
        Ok(())
    }

    async fn update_profile(&self, id: UserId, changes: &ProfileChanges) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            if let Some(nickname) = &changes.nickname {
                user.nickname = nickname.clone();
            }
            if let Some(signature) = &changes.signature {
                user.signature = signature.clone();
            }
            if changes.language.is_some() {
                user.language = changes.language;
            }
            if changes.theme.is_some() {
                user.theme = changes.theme;
            }
        }
        Ok(())
    }

    async fn set_avatar(&self, id: UserId, file: FileId) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.avatar = Some(file);
        }
        Ok(())
    }

    async fn list(&self, query: &UserQuery) -> Result<(Vec<User>, u64), StoreError> {
        let tables = self.tables.lock().unwrap();
        let needle = query.search.as_ref().map(|search| search.to_lowercase());
        let mut users: Vec<User> = tables
            .users
            .iter()
            .filter(|user| query.status.is_none_or(|status| user.status == status))
            .filter(|user| {
                needle.as_ref().is_none_or(|needle| {
                    user.handle.to_lowercase().contains(needle)
                        || user.nickname.to_lowercase().contains(needle)
                })
            })
            .cloned()
            .collect();
        users.sort_by_key(|user| std::cmp::Reverse((user.created_at, user.id)));
        let total = users.len() as u64;
        let page = users
            .into_iter()
            .skip(usize::try_from(query.offset).unwrap_or(usize::MAX))
            .take(usize::try_from(query.limit).unwrap_or(usize::MAX))
            .collect();
        Ok((page, total))
    }

    async fn set_status(&self, id: UserId, status: UserStatus) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.status = status;
        }
        Ok(())
    }

    async fn counts(&self) -> Result<UserCounts, StoreError> {
        let tables = self.tables.lock().unwrap();
        let disabled = |user: &&User| user.status == UserStatus::Disabled;
        Ok(UserCounts {
            total: tables.users.len() as u64,
            disabled: tables.users.iter().filter(disabled).count() as u64,
        })
    }

    async fn find_admin(&self) -> Result<Option<User>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let is_admin = |user: &&User| user.role == Role::Admin;
        Ok(tables.users.iter().find(is_admin).cloned())
    }

    async fn set_email(&self, id: UserId, email: &str) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.email = Some(email.to_owned());
        }
        Ok(())
    }

    async fn record_login(&self, id: UserId, now: i64) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(user) = tables.users.iter_mut().find(|user| user.id == id) {
            user.last_login_at = Some(now);
        }
        Ok(())
    }
}

#[async_trait]
impl SessionStore for MemoryStore {
    async fn create(&self, session: &Session) -> Result<(), StoreError> {
        self.tables.lock().unwrap().sessions.push(session.clone());
        Ok(())
    }

    async fn find_by_token_hash(&self, token_hash: &str) -> Result<Option<Session>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .sessions
            .iter()
            .find(|session| session.token_hash == token_hash)
            .cloned())
    }

    async fn touch(
        &self,
        id: SessionId,
        last_seen_at: i64,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(session) = tables.sessions.iter_mut().find(|session| session.id == id) {
            session.last_seen_at = last_seen_at;
            session.expires_at = expires_at;
        }
        Ok(())
    }

    async fn delete(&self, id: SessionId) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        tables.sessions.retain(|session| session.id != id);
        Ok(())
    }

    async fn list_for_user(&self, user: UserId, now: i64) -> Result<Vec<Session>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut found: Vec<Session> = tables
            .sessions
            .iter()
            .filter(|session| session.user_id == user && session.expires_at > now)
            .cloned()
            .collect();
        found.sort_by_key(|session| std::cmp::Reverse(session.last_seen_at));
        Ok(found)
    }

    async fn delete_for_user(&self, user: UserId, id: SessionId) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let before = tables.sessions.len();
        tables
            .sessions
            .retain(|session| !(session.id == id && session.user_id == user));
        Ok(tables.sessions.len() != before)
    }

    async fn delete_others(
        &self,
        user: UserId,
        keep: Option<SessionId>,
    ) -> Result<Vec<SessionId>, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let ended: Vec<SessionId> = tables
            .sessions
            .iter()
            .filter(|session| session.user_id == user && Some(session.id) != keep)
            .map(|session| session.id)
            .collect();
        tables
            .sessions
            .retain(|session| !ended.contains(&session.id));
        Ok(ended)
    }
}

#[async_trait]
impl InviteCodeStore for MemoryStore {
    async fn create_many(&self, codes: &[InviteCode]) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        tables.invite_codes.extend_from_slice(codes);
        Ok(())
    }

    async fn find(&self, id: InviteCodeId) -> Result<Option<InviteCode>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .invite_codes
            .iter()
            .find(|invite| invite.id == id)
            .cloned())
    }

    async fn find_by_code(&self, code: &str) -> Result<Option<InviteCode>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .invite_codes
            .iter()
            .find(|invite| invite.code == code)
            .cloned())
    }

    async fn find_many(&self, ids: &[InviteCodeId]) -> Result<Vec<InviteCode>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let wanted = |invite: &&InviteCode| ids.contains(&invite.id);
        Ok(tables.invite_codes.iter().filter(wanted).cloned().collect())
    }

    async fn find_used_by(&self, users: &[UserId]) -> Result<Vec<InviteCode>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let wanted =
            |invite: &&InviteCode| invite.used_by.is_some_and(|user| users.contains(&user));
        Ok(tables.invite_codes.iter().filter(wanted).cloned().collect())
    }

    async fn revoke(&self, ids: &[InviteCodeId]) -> Result<u64, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let mut revoked = 0;
        for invite in &mut tables.invite_codes {
            if ids.contains(&invite.id) && invite.status == InviteCodeStatus::Unused {
                invite.status = InviteCodeStatus::Revoked;
                revoked += 1;
            }
        }
        Ok(revoked)
    }

    async fn delete_dead(&self, ids: &[InviteCodeId], now: i64) -> Result<u64, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let before = tables.invite_codes.len();
        tables.invite_codes.retain(|invite| {
            let dead = match invite.status {
                InviteCodeStatus::Revoked => true,
                InviteCodeStatus::Unused => invite.is_expired(now),
                InviteCodeStatus::Used => false,
            };
            !(dead && ids.contains(&invite.id))
        });
        Ok((before - tables.invite_codes.len()) as u64)
    }

    async fn list(&self, query: &InviteCodeQuery) -> Result<(Vec<InviteCode>, u64), StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut codes: Vec<InviteCode> = tables
            .invite_codes
            .iter()
            .filter(|invite| {
                query
                    .state
                    .is_none_or(|state| invite.state(query.now) == state)
            })
            .cloned()
            .collect();
        codes.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        if query.order == InviteCodeOrder::NewestFirst {
            codes.reverse();
        }
        let total = codes.len() as u64;
        let page = codes
            .into_iter()
            .skip(usize::try_from(query.offset).unwrap_or(usize::MAX))
            .take(usize::try_from(query.limit).unwrap_or(usize::MAX))
            .collect();
        Ok((page, total))
    }
}

#[async_trait]
impl FileStore for MemoryStore {
    async fn create(&self, file: &StoredFile) -> Result<(), StoreError> {
        self.tables.lock().unwrap().files.push(file.clone());
        Ok(())
    }

    async fn find(&self, id: FileId) -> Result<Option<StoredFile>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.files.iter().find(|file| file.id == id).cloned())
    }

    async fn find_many(&self, ids: &[FileId]) -> Result<Vec<StoredFile>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let wanted = |file: &&StoredFile| ids.contains(&file.id);
        Ok(tables.files.iter().filter(wanted).cloned().collect())
    }

    async fn list_orphans(&self, before: i64) -> Result<Vec<StoredFile>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .files
            .iter()
            .filter(|file| file.purpose == FilePurpose::Attachment && file.created_at < before)
            .filter(|file| {
                !tables
                    .messages
                    .iter()
                    .any(|m| m.all_files().contains(&file.id))
            })
            .cloned()
            .collect())
    }

    async fn delete(&self, id: FileId) -> Result<(), StoreError> {
        self.tables
            .lock()
            .unwrap()
            .files
            .retain(|file| file.id != id);
        Ok(())
    }

    async fn count_sharing(&self, storage_key: &str) -> Result<u64, StoreError> {
        let tables = self.tables.lock().unwrap();
        let count = tables
            .files
            .iter()
            .filter(|file| file.storage_key == storage_key);
        Ok(count.count() as u64)
    }

    async fn usage(&self) -> Result<(u64, u64), StoreError> {
        let tables = self.tables.lock().unwrap();
        let distinct: HashMap<&str, i64> = tables
            .files
            .iter()
            .map(|file| (file.storage_key.as_str(), file.size))
            .collect();
        let bytes: i64 = distinct.values().sum();
        Ok((distinct.len() as u64, bytes as u64))
    }
}

#[async_trait]
impl ContactStore for MemoryStore {
    async fn save_request(&self, request: &FriendRequest) -> Result<FriendRequest, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let existing = tables
            .friend_requests
            .iter_mut()
            .find(|r| r.from == request.from && r.to == request.to);
        Ok(match existing {
            Some(existing) => {
                // 同一对申请方、接收方只有一条：改的是原来那一条，编号不变
                *existing = FriendRequest {
                    id: existing.id,
                    ..request.clone()
                };
                existing.clone()
            }
            None => {
                tables.friend_requests.push(request.clone());
                request.clone()
            }
        })
    }

    async fn find_request(&self, id: FriendRequestId) -> Result<Option<FriendRequest>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.friend_requests.iter().find(|r| r.id == id).cloned())
    }

    async fn find_request_between(
        &self,
        from: UserId,
        to: UserId,
    ) -> Result<Option<FriendRequest>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .friend_requests
            .iter()
            .find(|r| r.from == from && r.to == to)
            .cloned())
    }

    async fn list_requests(&self, user: UserId) -> Result<Vec<FriendRequest>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut requests: Vec<FriendRequest> = tables
            .friend_requests
            .iter()
            .filter(|r| r.from == user || r.to == user)
            .cloned()
            .collect();
        requests.sort_by(|a, b| b.sent_at.cmp(&a.sent_at).then(b.id.cmp(&a.id)));
        Ok(requests)
    }

    async fn accept_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let Some((from, to)) = tables
            .friend_requests
            .iter()
            .find(|r| r.id == id && r.status == FriendRequestStatus::Pending)
            .map(|r| (r.from, r.to))
        else {
            return Ok(false);
        };
        // 这一条，以及对方同时发来的那一条
        for request in &mut tables.friend_requests {
            let between = (request.from == from && request.to == to)
                || (request.from == to && request.to == from);
            if between && request.status == FriendRequestStatus::Pending {
                request.status = FriendRequestStatus::Accepted;
                request.handled_at = Some(now);
            }
        }
        for (user, friend) in [(from, to), (to, from)] {
            let exists = tables
                .friendships
                .iter()
                .any(|f| f.user == user && f.friend == friend);
            if !exists {
                tables.friendships.push(Friendship {
                    user,
                    friend,
                    remark: None,
                    created_at: now,
                });
            }
        }
        Ok(true)
    }

    async fn reject_request(&self, id: FriendRequestId, now: i64) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let pending = tables
            .friend_requests
            .iter_mut()
            .find(|r| r.id == id && r.status == FriendRequestStatus::Pending);
        match pending {
            Some(request) => {
                request.status = FriendRequestStatus::Rejected;
                request.handled_at = Some(now);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn find_friendship(
        &self,
        user: UserId,
        friend: UserId,
    ) -> Result<Option<Friendship>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .friendships
            .iter()
            .find(|f| f.user == user && f.friend == friend)
            .cloned())
    }

    async fn list_friendships(&self, user: UserId) -> Result<Vec<Friendship>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .friendships
            .iter()
            .filter(|f| f.user == user)
            .cloned()
            .collect())
    }

    async fn set_remark(
        &self,
        user: UserId,
        friend: UserId,
        remark: Option<&str>,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let friendship = tables
            .friendships
            .iter_mut()
            .find(|f| f.user == user && f.friend == friend);
        match friendship {
            Some(friendship) => {
                friendship.remark = remark.map(str::to_owned);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    async fn remove_friendship(&self, a: UserId, b: UserId) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let before = tables.friendships.len();
        tables
            .friendships
            .retain(|f| !((f.user == a && f.friend == b) || (f.user == b && f.friend == a)));
        Ok(tables.friendships.len() != before)
    }
}

#[async_trait]
impl ChatStore for MemoryStore {
    async fn open_direct(
        &self,
        id: ConversationId,
        a: UserId,
        b: UserId,
        now: i64,
    ) -> Result<Conversation, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let pair = if a < b { (a, b) } else { (b, a) };
        if let Some(existing) = tables.direct.get(&pair).copied() {
            let found = tables.conversations.iter().find(|c| c.id == existing);
            return Ok(found.cloned().expect("a direct conversation exists"));
        }
        let conversation = Conversation {
            id,
            kind: ConversationKind::Direct,
            last_seq: 0,
            created_at: now,
            name: None,
            avatar: None,
            owner: None,
            dissolved: false,
            notice: None,
            all_muted: false,
            join_approval: false,
        };
        tables.direct.insert(pair, id);
        tables.conversations.push(conversation.clone());
        // 和自己的对话只有一个成员
        let users = if a == b { vec![a] } else { vec![a, b] };
        for user in users {
            tables.members.push(new_member(id, user, now));
        }
        Ok(conversation)
    }

    async fn create_group(&self, group: &NewGroup) -> Result<(Conversation, Message), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let now = group.event.created_at;
        let conversation = Conversation {
            id: group.id,
            kind: ConversationKind::Group,
            last_seq: 1,
            created_at: now,
            name: group.name.clone(),
            avatar: None,
            owner: Some(group.owner),
            dissolved: false,
            notice: None,
            all_muted: false,
            join_approval: false,
        };
        tables.conversations.push(conversation.clone());
        for user in &group.members {
            tables.members.push(new_member(group.id, *user, now));
        }
        let message = group.event.stored(1);
        tables.messages.push(message.clone());
        Ok((conversation, message))
    }

    async fn apply(&self, event: &NewMessage, change: &Change) -> Result<Changed, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let id = event.conversation;
        let Some(position) = tables.conversations.iter().position(|c| c.id == id) else {
            return Err(StoreError::Unavailable("no such conversation".to_owned()));
        };
        let seq = tables.conversations[position].last_seq + 1;
        let is_active =
            |m: &Member, user: UserId| m.conversation == id && m.user == user && m.is_active();

        match change {
            Change::Join { users, limit } => {
                let present = tables
                    .members
                    .iter()
                    .filter(|m| m.conversation == id && m.is_active())
                    .count() as u32;
                let newcomers: Vec<UserId> = users
                    .iter()
                    .copied()
                    .filter(|user| !tables.members.iter().any(|m| is_active(m, *user)))
                    .collect();
                if newcomers.is_empty() {
                    return Ok(Changed::Nothing);
                }
                if present + newcomers.len() as u32 > *limit {
                    return Ok(Changed::Full {
                        room: limit.saturating_sub(present),
                    });
                }
                for user in newcomers {
                    let returning = tables
                        .members
                        .iter_mut()
                        .find(|m| m.conversation == id && m.user == user);
                    match returning {
                        // 离开过的人再加入：还是那一条记录，只能看到这一次入群之后的
                        Some(member) => {
                            member.joined_seq = seq - 1;
                            member.left_seq = None;
                            member.read_seq = seq - 1;
                            member.mentioned_seq = 0;
                            member.hidden_seq = None;
                        }
                        None => {
                            let mut member = new_member(id, user, event.created_at);
                            member.joined_seq = seq - 1;
                            member.read_seq = seq - 1;
                            tables.members.push(member);
                        }
                    }
                }
            }
            Change::Leave { user, hide } => {
                let Some(member) = tables.members.iter_mut().find(|m| is_active(m, *user)) else {
                    return Ok(Changed::Nothing);
                };
                member.left_seq = Some(seq);
                member.admin = false;
                if *hide {
                    member.hidden_seq = Some(seq);
                }
            }
            Change::SetOwner(owner) => {
                tables.conversations[position].owner = Some(*owner);
                if let Some(member) = tables.members.iter_mut().find(|m| is_active(m, *owner)) {
                    member.admin = false;
                    member.muted_until = None;
                }
            }
            Change::Mute { user, until } => {
                let Some(member) = tables.members.iter_mut().find(|m| is_active(m, *user)) else {
                    return Ok(Changed::Nothing);
                };
                member.muted_until = *until;
            }
            Change::SetAllMuted(muted) => {
                if tables.conversations[position].all_muted == *muted {
                    return Ok(Changed::Nothing);
                }
                tables.conversations[position].all_muted = *muted;
            }
            Change::SetAdmin { user, admin, limit } => {
                let admins = tables
                    .members
                    .iter()
                    .filter(|m| m.conversation == id && m.is_active() && m.admin)
                    .count() as u32;
                let Some(member) = tables.members.iter_mut().find(|m| is_active(m, *user)) else {
                    return Ok(Changed::Nothing);
                };
                if member.admin == *admin {
                    return Ok(Changed::Nothing);
                }
                if *admin && admins >= *limit {
                    return Ok(Changed::Full { room: 0 });
                }
                member.admin = *admin;
                if *admin {
                    member.muted_until = None;
                }
            }
            Change::Rename(name) => tables.conversations[position].name = name.clone(),
            Change::SetAvatar(avatar) => tables.conversations[position].avatar = Some(*avatar),
            Change::Dissolve => tables.conversations[position].dissolved = true,
            Change::SetNotice { text, by, remind } => {
                tables.conversations[position].notice = text.as_ref().map(|text| Notice {
                    text: text.clone(),
                    by: *by,
                    at: event.created_at,
                    seq,
                });
                for member in tables.members.iter_mut().filter(|m| m.conversation == id) {
                    // 发布的人自己算看过了；提醒其余在群的人，和 @ 所有人一样
                    if member.user == *by {
                        member.notice_seen_seq = seq;
                    } else if *remind && member.is_active() {
                        member.mentioned_seq = seq;
                    }
                }
            }
        }

        tables.conversations[position].last_seq = seq;
        let message = event.stored(seq);
        tables.messages.push(message.clone());
        Ok(Changed::Done(Box::new(message)))
    }

    async fn find_conversation(
        &self,
        id: ConversationId,
    ) -> Result<Option<Conversation>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.conversations.iter().find(|c| c.id == id).cloned())
    }

    async fn find_member(
        &self,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Option<Member>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .members
            .iter()
            .find(|m| m.conversation == conversation && m.user == user)
            .cloned())
    }

    async fn list_members(&self, conversation: ConversationId) -> Result<Vec<Member>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut members: Vec<Member> = tables
            .members
            .iter()
            .filter(|m| m.conversation == conversation)
            .cloned()
            .collect();
        members.sort_by_key(|m| (m.since, m.user));
        Ok(members)
    }

    async fn append(&self, message: &NewMessage) -> Result<Appended, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if message.client_id.is_some() {
            let earlier = tables.messages.iter().find(|m| {
                m.conversation == message.conversation
                    && m.sender == message.sender
                    && m.client_id == message.client_id
            });
            if let Some(earlier) = earlier {
                return Ok(Appended {
                    message: earlier.clone(),
                    duplicate: true,
                });
            }
        }
        // 一个文件只能属于一条消息
        if message.file.is_some() && tables.messages.iter().any(|m| m.file == message.file) {
            return Err(StoreError::Unavailable("file already attached".to_owned()));
        }
        let conversation = tables
            .conversations
            .iter_mut()
            .find(|c| c.id == message.conversation)
            .ok_or_else(|| StoreError::Unavailable("no such conversation".to_owned()))?;
        conversation.last_seq += 1;
        let stored = message.stored(conversation.last_seq);
        // 记下谁被 @ 了：只算现在在会话里的人，发送人自己不算
        for member in &mut tables.members {
            let mentioned = stored.data.mention_all || stored.data.mentions.contains(&member.user);
            if member.conversation == stored.conversation
                && member.is_active()
                && Some(member.user) != stored.sender
                && mentioned
            {
                member.mentioned_seq = stored.seq;
            }
        }
        tables.messages.push(stored.clone());
        Ok(Appended {
            message: stored,
            duplicate: false,
        })
    }

    async fn find_messages(
        &self,
        conversation: ConversationId,
        seqs: &[i64],
    ) -> Result<Vec<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .messages
            .iter()
            .filter(|m| m.conversation == conversation && seqs.contains(&m.seq))
            .cloned()
            .collect())
    }

    async fn find_by_file(&self, file: FileId) -> Result<Option<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .messages
            .iter()
            .find(|m| m.all_files().contains(&file))
            .cloned())
    }

    async fn recall(&self, event: &NewMessage, seq: i64) -> Result<Option<Message>, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let id = event.conversation;
        let Some(target) = tables
            .messages
            .iter_mut()
            .find(|m| m.conversation == id && m.seq == seq && m.recalled_at.is_none())
        else {
            return Ok(None);
        };
        target.recalled_at = Some(event.created_at);
        let conversation = tables
            .conversations
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| StoreError::Unavailable("no such conversation".to_owned()))?;
        conversation.last_seq += 1;
        let stored = event.stored(conversation.last_seq);
        tables.messages.push(stored.clone());
        Ok(Some(stored))
    }

    async fn edit(
        &self,
        event: &NewMessage,
        seq: i64,
        change: &Edit,
    ) -> Result<Option<Message>, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let id = event.conversation;
        let Some(target) = tables
            .messages
            .iter_mut()
            .find(|m| m.conversation == id && m.seq == seq && m.recalled_at.is_none())
        else {
            return Ok(None);
        };
        target.text = change.text.clone();
        target.data.mentions = change.mentions.clone();
        target.data.mention_all = change.mention_all;
        target.edited_at = Some(event.created_at);
        let conversation = tables
            .conversations
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| StoreError::Unavailable("no such conversation".to_owned()))?;
        conversation.last_seq += 1;
        let stored = event.stored(conversation.last_seq);
        // 新 @ 到的人记上提醒：只算还在会话里的，编辑的人自己不算
        let editor = stored.data.actor.as_ref().map(|actor| actor.id);
        for member in &mut tables.members {
            let mentioned = stored.data.mention_all || stored.data.mentions.contains(&member.user);
            if member.conversation == id
                && member.is_active()
                && Some(member.user) != editor
                && mentioned
            {
                member.mentioned_seq = stored.seq;
            }
        }
        tables.messages.push(stored.clone());
        Ok(Some(stored))
    }

    async fn mark_played(
        &self,
        message: MessageId,
        user: UserId,
        _now: i64,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if tables.voice_plays.contains(&(message, user)) {
            return Ok(false);
        }
        tables.voice_plays.push((message, user));
        Ok(true)
    }

    async fn played(
        &self,
        user: UserId,
        messages: &[MessageId],
    ) -> Result<Vec<MessageId>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .voice_plays
            .iter()
            .filter(|(message, who)| *who == user && messages.contains(message))
            .map(|(message, _)| *message)
            .collect())
    }

    async fn memberships(&self, user: UserId) -> Result<Vec<Member>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mine = |m: &&Member| m.user == user;
        Ok(tables.members.iter().filter(mine).cloned().collect())
    }

    async fn search(
        &self,
        scopes: &[SearchScope],
        needle: &str,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let needle = needle.to_lowercase();
        let contains =
            |text: Option<&str>| text.is_some_and(|text| text.to_lowercase().contains(&needle));
        let mut found: Vec<Message> = tables
            .messages
            .iter()
            .filter(|m| m.recalled_at.is_none())
            .filter(|m| {
                scopes.iter().any(|scope| {
                    scope.conversation == m.conversation
                        && shows(&tables.deleted, scope.visible, m)
                        && scope.before.is_none_or(|before| m.seq < before)
                })
            })
            .filter(|m| match m.kind {
                // 图片按它的文字说明匹配
                // 聊天记录按写入时拼好的那段文字匹配
                MessageKind::Text | MessageKind::Image | MessageKind::ChatRecord => {
                    contains(m.text.as_deref())
                }
                MessageKind::File => {
                    let file = tables.files.iter().find(|file| Some(file.id) == m.file);
                    contains(file.and_then(|file| file.name.as_deref()))
                }
                _ => false,
            })
            .cloned()
            .collect();
        found.sort_by_key(|m| std::cmp::Reverse((m.created_at, m.seq)));
        found.truncate(limit as usize);
        Ok(found)
    }

    async fn list_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut found: Vec<Message> = tables
            .messages
            .iter()
            .filter(|m| m.conversation == conversation && shows(&tables.deleted, visible, m))
            .filter(|m| before.is_none_or(|seq| m.seq < seq))
            .cloned()
            .collect();
        found.sort_by_key(|m| m.seq);
        let skip = found.len().saturating_sub(limit as usize);
        Ok(found.split_off(skip))
    }

    async fn list_kind_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        kind: MessageKind,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut found: Vec<Message> = tables
            .messages
            .iter()
            .filter(|m| m.conversation == conversation && shows(&tables.deleted, visible, m))
            .filter(|m| m.kind == kind && m.recalled_at.is_none())
            .filter(|m| before.is_none_or(|seq| m.seq < seq))
            .cloned()
            .collect();
        found.sort_by_key(|m| m.seq);
        let skip = found.len().saturating_sub(limit as usize);
        Ok(found.split_off(skip))
    }

    async fn list_after(
        &self,
        conversation: ConversationId,
        visible: Visible,
        after: i64,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut found: Vec<Message> = tables
            .messages
            .iter()
            .filter(|m| {
                m.conversation == conversation
                    && shows(&tables.deleted, visible, m)
                    && m.seq > after
            })
            .cloned()
            .collect();
        found.sort_by_key(|m| m.seq);
        found.truncate(limit as usize);
        Ok(found)
    }

    async fn advance_read(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let member = tables
            .members
            .iter_mut()
            .find(|m| m.conversation == conversation && m.user == user && m.read_seq < seq);
        Ok(match member {
            Some(member) => {
                member.read_seq = seq;
                true
            }
            None => false,
        })
    }

    async fn hide(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let member = tables
            .members
            .iter_mut()
            .find(|m| m.conversation == conversation && m.user == user);
        if let Some(member) = member {
            member.hidden_seq = Some(seq);
        }
        Ok(())
    }

    async fn clear(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(member) = tables
            .members
            .iter_mut()
            .find(|member| member.conversation == conversation && member.user == user)
        {
            member.cleared_seq = member.cleared_seq.max(seq);
            member.read_seq = member.read_seq.max(seq);
        }
        Ok(())
    }

    async fn delete_for(
        &self,
        conversation: ConversationId,
        user: UserId,
        seqs: &[i64],
        _now: i64,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        for seq in seqs {
            tables.deleted.insert((conversation, user, *seq));
        }
        Ok(())
    }

    async fn set_pinned(
        &self,
        conversation: ConversationId,
        user: UserId,
        pinned_at: Option<i64>,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(member) = tables
            .members
            .iter_mut()
            .find(|member| member.conversation == conversation && member.user == user)
        {
            member.pinned_at = pinned_at;
        }
        Ok(())
    }

    async fn set_muted(
        &self,
        conversation: ConversationId,
        user: UserId,
        muted: bool,
    ) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let member = tables
            .members
            .iter_mut()
            .find(|m| m.conversation == conversation && m.user == user);
        if let Some(member) = member {
            member.muted = muted;
        }
        Ok(())
    }

    async fn set_join_approval(
        &self,
        conversation: ConversationId,
        on: bool,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let found = tables
            .conversations
            .iter_mut()
            .find(|c| c.id == conversation);
        match found {
            Some(found) if found.join_approval != on => {
                found.join_approval = on;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn add_join_request(
        &self,
        request: &JoinRequest,
        cutoff: i64,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let pending = tables.join_requests.iter().any(|existing| {
            existing.conversation == request.conversation
                && existing.invitee == request.invitee
                && existing.status_at(cutoff) == JoinRequestStatus::Pending
        });
        if pending {
            return Ok(false);
        }
        tables.join_requests.push(request.clone());
        Ok(true)
    }

    async fn list_join_requests(
        &self,
        conversation: ConversationId,
    ) -> Result<Vec<JoinRequest>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut found: Vec<JoinRequest> = tables
            .join_requests
            .iter()
            .filter(|request| request.conversation == conversation)
            .cloned()
            .collect();
        found.sort_by_key(|request| std::cmp::Reverse(request.created_at));
        Ok(found)
    }

    async fn find_join_request(
        &self,
        id: JoinRequestId,
    ) -> Result<Option<JoinRequest>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables.join_requests.iter().find(|r| r.id == id).cloned())
    }

    async fn settle_join_request(
        &self,
        id: JoinRequestId,
        status: JoinRequestStatus,
        by: UserId,
        now: i64,
        cutoff: i64,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let found = tables.join_requests.iter_mut().find(|r| r.id == id);
        match found {
            Some(request) if request.status_at(cutoff) == JoinRequestStatus::Pending => {
                request.status = status;
                request.handled_by = Some(by);
                request.handled_at = Some(now);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn reopen_join_request(&self, id: JoinRequestId) -> Result<(), StoreError> {
        let mut tables = self.tables.lock().unwrap();
        if let Some(request) = tables.join_requests.iter_mut().find(|r| r.id == id) {
            request.status = JoinRequestStatus::Pending;
            request.handled_by = None;
            request.handled_at = None;
        }
        Ok(())
    }

    async fn set_nickname(
        &self,
        conversation: ConversationId,
        user: UserId,
        nickname: Option<String>,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let member = tables
            .members
            .iter_mut()
            .find(|m| m.conversation == conversation && m.user == user && m.is_active());
        match member {
            Some(member) if member.nickname != nickname => {
                member.nickname = nickname;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn mark_notice_seen(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let member = tables
            .members
            .iter_mut()
            .find(|m| m.conversation == conversation && m.user == user);
        match member {
            Some(member) if member.notice_seen_seq < seq => {
                member.notice_seen_seq = seq;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn list_for_user(&self, user: UserId) -> Result<Vec<Listing>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut listings = Vec::new();
        for me in tables.members.iter().filter(|m| m.user == user) {
            let Some(conversation) = tables
                .conversations
                .iter()
                .find(|c| c.id == me.conversation)
            else {
                continue;
            };
            if !me.lists(conversation) {
                continue;
            }
            let visible = me.visible();
            let seen = |m: &&Message| {
                m.conversation == conversation.id && shows(&tables.deleted, visible, m)
            };
            let mut others: Vec<Member> = tables
                .members
                .iter()
                .filter(|m| m.conversation == conversation.id && m.user != user)
                .cloned()
                .collect();
            others.sort_by_key(|m| (m.since, m.user));
            listings.push(Listing {
                conversation: conversation.clone(),
                me: me.clone(),
                others,
                // 编辑事件不算：摘要是被编辑的那一条自己（F8）
                last_message: tables
                    .messages
                    .iter()
                    .filter(seen)
                    .filter(|m| m.kind != MessageKind::Edited)
                    .max_by_key(|m| m.seq)
                    .cloned(),
                unread: tables
                    .messages
                    .iter()
                    .filter(seen)
                    .filter(|m| m.seq > me.read_seq && m.sender.is_some_and(|s| s != user))
                    // 已撤回的不算未读
                    .filter(|m| m.recalled_at.is_none())
                    .count() as u64,
            });
        }
        Ok(listings)
    }

    async fn list_groups(&self, user: UserId) -> Result<Vec<Conversation>, StoreError> {
        let tables = self.tables.lock().unwrap();
        Ok(tables
            .conversations
            .iter()
            .filter(|c| c.kind == ConversationKind::Group)
            .filter(|c| {
                tables
                    .members
                    .iter()
                    .any(|m| m.conversation == c.id && m.user == user && m.is_active())
            })
            .cloned()
            .collect())
    }

    async fn find_conversations(
        &self,
        ids: &[ConversationId],
    ) -> Result<Vec<Conversation>, StoreError> {
        let tables = self.tables.lock().unwrap();
        let wanted = |c: &&Conversation| ids.contains(&c.id);
        Ok(tables
            .conversations
            .iter()
            .filter(wanted)
            .cloned()
            .collect())
    }

    async fn list_all_groups(
        &self,
        search: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<Conversation>, u64), StoreError> {
        let tables = self.tables.lock().unwrap();
        let needle = search.map(str::to_lowercase);
        let mut groups: Vec<Conversation> = tables
            .conversations
            .iter()
            .filter(|c| c.kind == ConversationKind::Group)
            .filter(|c| {
                needle.as_ref().is_none_or(|needle| {
                    let name = c.name.as_deref().unwrap_or_default();
                    name.to_lowercase().contains(needle)
                })
            })
            .cloned()
            .collect();
        groups.sort_by_key(|c| std::cmp::Reverse((c.created_at, c.id)));
        let total = groups.len() as u64;
        let page = groups
            .into_iter()
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .collect();
        Ok((page, total))
    }

    async fn count_groups(&self) -> Result<u64, StoreError> {
        let tables = self.tables.lock().unwrap();
        let open = |c: &&Conversation| c.kind == ConversationKind::Group && !c.dissolved;
        Ok(tables.conversations.iter().filter(open).count() as u64)
    }

    async fn purge_before(&self, cutoff: i64) -> Result<Purged, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        // 每个会话里第一条没有过期的：序号比它小的都删
        let mut keep_from: HashMap<ConversationId, i64> = HashMap::new();
        for message in tables.messages.iter().filter(|m| m.created_at >= cutoff) {
            let first = keep_from.entry(message.conversation).or_insert(message.seq);
            *first = (*first).min(message.seq);
        }
        let expired = |m: &Message| {
            keep_from
                .get(&m.conversation)
                .is_none_or(|first| m.seq < *first)
        };
        let gone: Vec<Message> = tables
            .messages
            .iter()
            .filter(|m| expired(m))
            .cloned()
            .collect();
        tables.messages.retain(|m| !expired(m));
        tables.deleted.retain(|(conversation, _, seq)| {
            keep_from
                .get(conversation)
                .is_some_and(|first| *seq >= *first)
        });
        tables
            .voice_plays
            .retain(|(message, _)| !gone.iter().any(|m| m.id == *message));
        Ok(Purged {
            messages: gone.len() as u64,
            files: gone.iter().flat_map(Message::all_files).collect(),
        })
    }
}

#[async_trait]
impl AuditStore for MemoryStore {
    async fn append(&self, entry: &AuditEntry) -> Result<(), StoreError> {
        if !self.audit_writable.load(Ordering::Relaxed) {
            return Err(StoreError::Unavailable("audit log is read-only".into()));
        }
        self.tables.lock().unwrap().audit.push(entry.clone());
        Ok(())
    }

    async fn list(
        &self,
        action: Option<AuditAction>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<AuditEntry>, u64), StoreError> {
        let tables = self.tables.lock().unwrap();
        let mut entries: Vec<AuditEntry> = tables
            .audit
            .iter()
            .filter(|entry| action.is_none_or(|action| entry.action == action))
            .cloned()
            .collect();
        entries.sort_by(|a, b| (b.at, &b.id).cmp(&(a.at, &a.id)));
        let total = entries.len() as u64;
        let page = entries
            .into_iter()
            .skip(usize::try_from(offset).unwrap_or(usize::MAX))
            .take(usize::try_from(limit).unwrap_or(usize::MAX))
            .collect();
        Ok((page, total))
    }
}

#[async_trait]
impl TokenStore for MemoryStore {
    async fn create(&self, token: &AdminToken) -> Result<(), StoreError> {
        self.tables.lock().unwrap().tokens.push(token.clone());
        Ok(())
    }

    async fn consume(
        &self,
        token_hash: &str,
        purpose: TokenPurpose,
        now: i64,
    ) -> Result<Option<AdminToken>, StoreError> {
        let mut tables = self.tables.lock().unwrap();
        let found = tables.tokens.iter_mut().find(|token| {
            token.token_hash == token_hash
                && token.purpose == purpose
                && token.used_at.is_none()
                && token.expires_at > now
        });
        Ok(found.map(|token| {
            token.used_at = Some(now);
            token.clone()
        }))
    }
}

/// 把"发出去"的邮件都留在内存里。可以让它发不出去。
#[derive(Default)]
pub struct Outbox {
    sent: Mutex<Vec<Mail>>,
    pub broken: AtomicBool,
}

impl Outbox {
    pub fn sent(&self) -> Vec<Mail> {
        self.sent.lock().unwrap().clone()
    }

    /// 最近一封邮件里的链接所带的令牌。
    pub fn last_token(&self) -> Option<String> {
        let sent = self.sent.lock().unwrap();
        let body = &sent.last()?.body;
        let after = body.split("token=").nth(1)?;
        Some(after.split_whitespace().next()?.to_owned())
    }
}

#[async_trait]
impl Mailer for Outbox {
    async fn send(&self, mail: &Mail) -> Result<(), StoreError> {
        if self.broken.load(Ordering::Relaxed) {
            return Err(StoreError::Unavailable("mail server is down".into()));
        }
        self.sent.lock().unwrap().push(mail.clone());
        Ok(())
    }
}

/// 一条新的成员记录：从头开始都能看到，什么都还没读。
fn new_member(conversation: ConversationId, user: UserId, now: i64) -> Member {
    Member {
        conversation,
        user,
        joined_seq: 0,
        left_seq: None,
        read_seq: 0,
        mentioned_seq: 0,
        hidden_seq: None,
        muted: false,
        notice_seen_seq: 0,
        since: now,
        admin: false,
        nickname: None,
        muted_until: None,
        pinned_at: None,
        cleared_seq: 0,
    }
}

#[async_trait]
impl BlobStore for MemoryStore {
    async fn put(&self, key: &str, content: Vec<u8>) -> Result<(), StoreError> {
        self.tables
            .lock()
            .unwrap()
            .blobs
            .insert(key.to_owned(), content);
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        Ok(self.tables.lock().unwrap().blobs.get(key).cloned())
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.tables.lock().unwrap().blobs.remove(key);
        Ok(())
    }

    async fn write(
        &self,
        key: &str,
        mut content: ByteStream,
        max_bytes: u64,
    ) -> Result<Written, StoreError> {
        let mut collected = Vec::new();
        while let Some(chunk) = content.next().await {
            let Ok(chunk) = chunk else {
                return Ok(Written::Interrupted);
            };
            collected.extend_from_slice(&chunk);
            if collected.len() as u64 > max_bytes {
                return Ok(Written::TooLarge);
            }
        }
        let head = collected[..collected.len().min(HEAD_BYTES)].to_vec();
        let size = collected.len() as u64;
        BlobStore::put(self, key, collected).await?;
        Ok(Written::Stored { size, head })
    }

    async fn read(
        &self,
        key: &str,
        range: Option<Range<u64>>,
    ) -> Result<Option<ByteStream>, StoreError> {
        let Some(content) = BlobStore::get(self, key).await? else {
            return Ok(None);
        };
        let part = match range {
            Some(range) => {
                let end = (range.end as usize).min(content.len());
                content[(range.start as usize).min(end)..end].to_vec()
            }
            None => content,
        };
        Ok(Some(byte_stream(&part, 16)))
    }
}

/// 用内存里的假实现组装出账号服务。
pub async fn account_service(
    store: &Arc<MemoryStore>,
    clock: Arc<dyn Clock>,
    limits: Limits,
) -> AccountService {
    AccountService::new(AccountServiceDeps {
        users: store.clone(),
        sessions: store.clone(),
        invite_codes: store.clone(),
        files: store.clone(),
        blobs: store.clone(),
        images: Arc::new(FakeImages),
        hasher: Arc::new(PlainHasher::default()),
        clock,
        limits,
    })
    .await
}

/// 用内存里的假实现组装出通讯录服务。
pub fn contact_service(store: &Arc<MemoryStore>, clock: Arc<dyn Clock>) -> ContactService {
    ContactService::new(ContactServiceDeps {
        users: store.clone(),
        contacts: store.clone(),
        clock,
    })
}

/// 用内存里的假实现组装出聊天服务。
pub fn chat_service(store: &Arc<MemoryStore>, clock: Arc<dyn Clock>) -> ChatService {
    ChatService::new(ChatServiceDeps {
        users: store.clone(),
        contacts: store.clone(),
        chat: store.clone(),
        files: store.clone(),
        settings: store.clone(),
        clock,
    })
}

/// 用内存里的假实现组装出管理服务，连同收邮件的地方。
pub fn admin_service(
    store: &Arc<MemoryStore>,
    clock: Arc<dyn Clock>,
    accounts: Arc<AccountService>,
    chat: Arc<ChatService>,
) -> (AdminService, Arc<Outbox>) {
    let outbox = Arc::new(Outbox::default());
    let admin = AdminService::new(AdminServiceDeps {
        accounts,
        chat,
        files: Arc::new(file_service(store, clock.clone())),
        users: store.clone(),
        sessions: store.clone(),
        invite_codes: store.clone(),
        chat_store: store.clone(),
        file_store: store.clone(),
        settings: store.clone(),
        audit: store.clone(),
        tokens: store.clone(),
        hasher: Arc::new(PlainHasher::default()),
        mailer: outbox.clone(),
        clock,
        public_url: "http://vibe.test/".to_owned(),
        reset_requests_per_minute: RESET_REQUESTS_PER_MINUTE,
    });
    (admin, outbox)
}

/// 用内存里的假实现组装出文件服务。
pub fn file_service(store: &Arc<MemoryStore>, clock: Arc<dyn Clock>) -> FileService {
    FileService::new(FileServiceDeps {
        files: store.clone(),
        blobs: store.clone(),
        images: Arc::new(FakeImages),
        chat: store.clone(),
        settings: store.clone(),
        clock,
    })
}

/// 这一条在这个范围里，并且看的人没有把它删掉（F6）。
fn shows(deleted: &HashSet<(ConversationId, UserId, i64)>, visible: Visible, m: &Message) -> bool {
    visible.contains(m.seq)
        && visible
            .viewer
            .is_none_or(|viewer| !deleted.contains(&(m.conversation, viewer, m.seq)))
}
