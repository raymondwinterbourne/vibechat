use crate::ids::{FileId, InviteCodeId, SessionId, UserId};

/// 取值不多的小枚举，在数据库里存成短字符串。
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $text),+
                }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

pub(crate) use string_enum;

string_enum!(Role { User => "user", Admin => "admin" });
string_enum!(UserStatus { Active => "active", Disabled => "disabled" });
string_enum!(Language { ZhCn => "zh-CN", En => "en" });
string_enum!(Theme { Light => "light", Dark => "dark", System => "system" });
string_enum!(InviteCodeStatus { Unused => "unused", Used => "used", Revoked => "revoked" });
string_enum!(FilePurpose { Avatar => "avatar", Attachment => "attachment" });

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: UserId,
    /// 用户看得见的 ID：用于登录和被查找，可以修改，不区分大小写地唯一。
    pub handle: String,
    pub nickname: String,
    pub signature: String,
    pub avatar: Option<FileId>,
    pub password_hash: String,
    pub role: Role,
    pub status: UserStatus,
    /// 管理员重置密码或初始创建后为真，此时只能先修改密码。
    pub must_change_password: bool,
    /// 只有管理员有，用于找回密码。
    pub email: Option<String>,
    /// 界面语言和外观的选择；没有选过时为空，由客户端按浏览器和系统决定。
    pub language: Option<Language>,
    pub theme: Option<Theme>,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == Role::Admin
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    pub user_id: UserId,
    /// 令牌本身只交给客户端，这里只保存它的哈希。
    pub token_hash: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    pub user_agent: String,
    /// 登录时的网络地址（F9）。以前的登录没有记，为空。
    pub ip: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCode {
    pub id: InviteCodeId,
    pub code: String,
    pub note: Option<String>,
    pub status: InviteCodeStatus,
    pub expires_at: Option<i64>,
    pub created_by: UserId,
    pub created_at: i64,
    pub used_by: Option<UserId>,
    pub used_at: Option<i64>,
}

/// 邀请码此刻所处的状态，也就是管理员在列表里看到的状态。
/// 与保存的 `InviteCodeStatus` 相比多一种"已过期"：它不单独保存，由有效期和当前时间得出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteCodeState {
    /// 还能用来注册。
    Unused,
    Used,
    /// 没有被使用，但已经过了有效期。
    Expired,
    Revoked,
}

/// 邀请码列表按生成时间排序的方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InviteCodeOrder {
    #[default]
    NewestFirst,
    OldestFirst,
}

/// 取邀请码列表的一段：只要某种状态的（不指定则全部），按什么顺序，跳过几个，最多取几个。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InviteCodeQuery {
    pub state: Option<InviteCodeState>,
    pub order: InviteCodeOrder,
    pub offset: u64,
    pub limit: u64,
    /// 当前时间，用来判断是否已经过期。
    pub now: i64,
}

impl InviteCode {
    /// 是否已经过了有效期。
    pub fn is_expired(&self, now: i64) -> bool {
        self.expires_at.is_some_and(|expires_at| expires_at <= now)
    }

    pub fn state(&self, now: i64) -> InviteCodeState {
        match self.status {
            InviteCodeStatus::Used => InviteCodeState::Used,
            InviteCodeStatus::Revoked => InviteCodeState::Revoked,
            InviteCodeStatus::Unused if self.is_expired(now) => InviteCodeState::Expired,
            InviteCodeStatus::Unused => InviteCodeState::Unused,
        }
    }
}

/// 一个已上传文件的登记信息；内容本身在文件存储里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    pub id: FileId,
    pub storage_key: String,
    pub content_type: String,
    pub size: i64,
    pub uploader: UserId,
    pub purpose: FilePurpose,
    /// 图片的宽高。只有服务端认定是图片的文件才有。
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// 用户上传时的文件名。只用来显示和下载时带回去，不参与存储路径。头像没有。
    pub name: Option<String>,
    /// 图片的缩略图存在哪里。
    pub thumbnail_key: Option<String>,
    pub created_at: i64,
}

impl StoredFile {
    /// 服务端认定它是可以在页面里显示的图片。
    pub fn is_image(&self) -> bool {
        self.width.is_some() && self.content_type.starts_with("image/")
    }

    /// 服务端认定它是可以在页面里播放的音频。
    pub fn is_audio(&self) -> bool {
        self.content_type.starts_with("audio/")
    }
}

/// 取用户列表的一段：名字或 ID 里含有某段文字的（不指定则全部），只要某种状态的，
/// 跳过几个，最多取几个。注册晚的在前。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct UserQuery {
    /// 在 ID 和昵称里找，包含匹配，不区分大小写。
    pub search: Option<String>,
    pub status: Option<UserStatus>,
    pub offset: u64,
    pub limit: u64,
}

/// 用户的数量。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct UserCounts {
    pub total: u64,
    pub disabled: u64,
}

/// 对个人资料的修改；为 `None` 的字段保持不变。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileChanges {
    pub nickname: Option<String>,
    pub signature: Option<String>,
    pub language: Option<Language>,
    pub theme: Option<Theme>,
}
