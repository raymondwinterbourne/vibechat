//! 账号相关的数据操作。实现在 `vibechat-infra`。

use async_trait::async_trait;

use super::model::{
    InviteCode, InviteCodeQuery, ProfileChanges, Session, StoredFile, User, UserCounts, UserQuery,
    UserStatus,
};
use crate::ids::{FileId, InviteCodeId, SessionId, UserId};
use crate::store::StoreError;

#[derive(Debug, thiserror::Error)]
pub enum CreateUserError {
    /// 这个 ID 已经有人用了。
    #[error("handle is taken")]
    HandleTaken,
    /// 邀请码在这一刻已经不是"未使用"了：被别人抢先用掉、被作废或已过期。
    #[error("invite code is no longer available")]
    InviteCodeUnavailable,
    #[error(transparent)]
    Store(#[from] StoreError),
}

#[async_trait]
pub trait UserStore: Send + Sync {
    /// 把邀请码标记为已使用并创建用户，两件事要么都成功要么都不发生。
    /// 两个人同时用同一个邀请码时，只有一个能成功。
    async fn create_with_invite(
        &self,
        user: &User,
        invite_code: InviteCodeId,
        now: i64,
    ) -> Result<(), CreateUserError>;

    /// 数据库里还没有管理员时创建它，返回是否创建了。
    async fn create_admin_if_none(&self, user: &User) -> Result<bool, StoreError>;

    async fn has_admin(&self) -> Result<bool, StoreError>;

    async fn find(&self, id: UserId) -> Result<Option<User>, StoreError>;

    /// 一次取多个用户。不存在的会被跳过，返回的顺序不保证。
    async fn find_many(&self, ids: &[UserId]) -> Result<Vec<User>, StoreError>;

    /// 按 ID 查找，不区分大小写。
    async fn find_by_handle(&self, handle: &str) -> Result<Option<User>, StoreError>;

    /// 修改 ID。已经被别人占用时返回 `false`。
    async fn set_handle(&self, id: UserId, handle: &str) -> Result<bool, StoreError>;

    async fn set_password(
        &self,
        id: UserId,
        password_hash: &str,
        must_change_password: bool,
    ) -> Result<(), StoreError>;

    async fn update_profile(&self, id: UserId, changes: &ProfileChanges) -> Result<(), StoreError>;

    async fn set_avatar(&self, id: UserId, file: FileId) -> Result<(), StoreError>;

    async fn record_login(&self, id: UserId, now: i64) -> Result<(), StoreError>;

    /// 用户列表的一段，同时返回符合条件的用户一共有多少。
    async fn list(&self, query: &UserQuery) -> Result<(Vec<User>, u64), StoreError>;

    async fn set_status(&self, id: UserId, status: UserStatus) -> Result<(), StoreError>;

    async fn counts(&self) -> Result<UserCounts, StoreError>;

    /// 那一名管理员。
    async fn find_admin(&self) -> Result<Option<User>, StoreError>;

    async fn set_email(&self, id: UserId, email: &str) -> Result<(), StoreError>;
}

#[async_trait]
pub trait SessionStore: Send + Sync {
    async fn create(&self, session: &Session) -> Result<(), StoreError>;

    async fn find_by_token_hash(&self, token_hash: &str) -> Result<Option<Session>, StoreError>;

    /// 顺延有效期。
    async fn touch(
        &self,
        id: SessionId,
        last_seen_at: i64,
        expires_at: i64,
    ) -> Result<(), StoreError>;

    async fn delete(&self, id: SessionId) -> Result<(), StoreError>;

    /// 一个用户此刻还有效（没有过期）的全部登录（F9）。
    async fn list_for_user(&self, user: UserId, now: i64) -> Result<Vec<Session>, StoreError>;

    /// 删除一个用户的某一次登录（F9）。不是他的、已经没有了，什么也不做，返回 `false`。
    async fn delete_for_user(&self, user: UserId, id: SessionId) -> Result<bool, StoreError>;

    /// 删除一个用户除 `keep` 之外的全部登录，返回被删除的那些。
    async fn delete_others(
        &self,
        user: UserId,
        keep: Option<SessionId>,
    ) -> Result<Vec<SessionId>, StoreError>;
}

#[async_trait]
pub trait InviteCodeStore: Send + Sync {
    async fn create_many(&self, codes: &[InviteCode]) -> Result<(), StoreError>;

    async fn find(&self, id: InviteCodeId) -> Result<Option<InviteCode>, StoreError>;

    async fn find_by_code(&self, code: &str) -> Result<Option<InviteCode>, StoreError>;

    /// 一批邀请码。不存在的直接略过。
    async fn find_many(&self, ids: &[InviteCodeId]) -> Result<Vec<InviteCode>, StoreError>;

    /// 这些用户注册时各自用的邀请码。
    async fn find_used_by(&self, users: &[UserId]) -> Result<Vec<InviteCode>, StoreError>;

    /// 作废其中还没有使用的邀请码，返回作废了几个。
    /// 已经使用、已经作废或不存在的邀请码不会被改动，也不计数。
    async fn revoke(&self, ids: &[InviteCodeId]) -> Result<u64, StoreError>;

    /// 删除其中已经作废或已经过期的邀请码，返回删除了几个。
    /// 还能使用的、已经使用的和不存在的邀请码不会被改动，也不计数。
    async fn delete_dead(&self, ids: &[InviteCodeId], now: i64) -> Result<u64, StoreError>;

    /// 邀请码列表的一段，同时返回符合条件的邀请码一共有多少。
    async fn list(&self, query: &InviteCodeQuery) -> Result<(Vec<InviteCode>, u64), StoreError>;
}

#[async_trait]
pub trait FileStore: Send + Sync {
    async fn create(&self, file: &StoredFile) -> Result<(), StoreError>;

    async fn find(&self, id: FileId) -> Result<Option<StoredFile>, StoreError>;

    /// 一批文件的登记信息。不存在的直接略过。
    async fn find_many(&self, ids: &[FileId]) -> Result<Vec<StoredFile>, StoreError>;

    /// 在 `before` 之前上传、到现在还没有被任何消息引用的消息附件。
    async fn list_orphans(&self, before: i64) -> Result<Vec<StoredFile>, StoreError>;

    async fn delete(&self, id: FileId) -> Result<(), StoreError>;

    /// 还有几个登记指向存储里的这份内容。转发出来的文件和原文件共用同一份内容，
    /// 删掉一个登记之后，内容要等到没有登记再指向它时才能删。
    async fn count_sharing(&self, storage_key: &str) -> Result<u64, StoreError>;

    /// 全部文件的个数和总大小（字节）。几个登记共用的同一份内容只算一次。
    async fn usage(&self) -> Result<(u64, u64), StoreError>;
}

/// 图片的校验和处理。实现在 `vibechat-infra`。
#[async_trait]
pub trait ImageProcessor: Send + Sync {
    /// 把上传的内容解码并重新编码成头像：确认它确实是图片，缩小到规定的尺寸，
    /// 去掉原图附带的信息。不是受支持的图片时返回 `None`。
    async fn process_avatar(&self, content: Vec<u8>) -> Option<ProcessedImage>;

    /// 给一张图片生成缩略图。不是能在页面里显示的图片时返回 `None`：
    /// 格式不受支持、内容损坏，或者尺寸超过限制。
    async fn thumbnail(&self, content: Vec<u8>) -> Option<Thumbnail>;
}

/// 一张图片的缩略图，以及原图的情况。
pub struct Thumbnail {
    pub content: Vec<u8>,
    pub content_type: &'static str,
    /// 原图的类型，按内容认定。
    pub original_type: &'static str,
    /// 原图显示出来的宽高（已经按照片里记的方向转正）。
    pub width: u32,
    pub height: u32,
}

pub struct ProcessedImage {
    pub content: Vec<u8>,
    pub content_type: &'static str,
    pub width: u32,
    pub height: u32,
}
