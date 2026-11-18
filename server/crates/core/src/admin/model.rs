use crate::account::model::{User, string_enum};
use crate::ids::UserId;
use crate::limits::CallVideo;

string_enum!(
    /// 管理员做过的一件事。记录里只保存类型和参数，显示成什么文字由客户端按当前语言决定。
    AuditAction {
        ChatViewed => "chat_viewed",
        UserDisabled => "user_disabled",
        UserEnabled => "user_enabled",
        PasswordReset => "password_reset",
        InviteCodesCreated => "invite_codes_created",
        InviteCodesRevoked => "invite_codes_revoked",
        InviteCodesDeleted => "invite_codes_deleted",
        GroupDissolved => "group_dissolved",
        SettingChanged => "setting_changed",
    }
);

/// 一条操作记录的参数。用到哪几项由操作的类型决定，其余为空。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AuditDetail {
    /// 操作对象当时的名称：用户的昵称和 ID、会话的名称。之后改了名，记录里还是当时的。
    pub label: Option<String>,
    /// 涉及几个：生成、作废、删除了几个邀请码。
    pub count: Option<u32>,
    /// 改的是哪一项设置；查看聊天内容时是会话的类型（单聊还是群）。
    pub key: Option<String>,
    /// 改之前和改之后的值。
    pub from: Option<String>,
    pub to: Option<String>,
}

/// 一条操作记录。只能追加和查阅，不能修改和删除。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub id: String,
    pub at: i64,
    /// 做这件事的管理员。
    pub actor: UserId,
    pub action: AuditAction,
    /// 操作的对象的编号：用户、会话。没有具体对象的操作为空。
    pub target: Option<String>,
    pub detail: AuditDetail,
}

/// 用户列表里的一行。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserRow {
    pub user: User,
    /// 他注册时用的邀请码。管理员没有。
    pub invite_code: Option<String>,
}

string_enum!(
    /// 管理员可以调整的设置。
    SettingKey {
        FileMaxBytes => "file_max_bytes",
        GroupMaxMembers => "group_max_members",
        VoiceMaxSeconds => "voice_max_seconds",
        RecallWindowSeconds => "recall_window_seconds",
        EditWindowSeconds => "edit_window_seconds",
        RetentionDays => "retention_days",
        ScreenMaxWidth => "screen_max_width",
        ScreenMaxFps => "screen_max_fps",
        ScreenDirectKbps => "screen_direct_kbps",
        ScreenRelayKbps => "screen_relay_kbps",
        CameraRelayKbps => "camera_relay_kbps",
        GroupCameraHighKbps => "group_camera_high_kbps",
        GroupCameraLowKbps => "group_camera_low_kbps",
        GroupScreenKbps => "group_screen_kbps",
        GroupCallMax => "group_call_max",
    }
);

/// 当前生效的系统设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// 单个文件最大多少字节。
    pub file_max_bytes: u64,
    /// 群人数上限，包括群主。
    pub group_max_members: u32,
    /// 一条语音最长多少秒。
    pub voice_max_seconds: u32,
    /// 消息发出后多少秒之内可以撤回。0 表示不允许撤回。
    pub recall_window_seconds: u32,
    /// 消息发出后多少秒之内可以编辑。0 表示不允许编辑（F8）。
    pub edit_window_seconds: u32,
    /// 聊天记录和文件保留多少天。空表示永久保留。
    pub retention_days: Option<u32>,
    /// 通话画面的参数（F7）。
    pub call_video: CallVideo,
    /// 群通话最多几个人（F10）。
    pub group_call_max: u32,
}

/// 对系统设置的修改；为 `None` 的项保持不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SettingsChange {
    pub file_max_bytes: Option<u64>,
    pub group_max_members: Option<u32>,
    pub voice_max_seconds: Option<u32>,
    pub recall_window_seconds: Option<u32>,
    pub edit_window_seconds: Option<u32>,
    /// 外层为 `None` 是不改；`Some(None)` 是改成永久保留。
    pub retention_days: Option<Option<u32>>,
    /// 群通话最多几个人（F10）。
    pub group_call_max: Option<u32>,
    pub screen_max_width: Option<u32>,
    pub screen_max_fps: Option<u32>,
    pub screen_direct_kbps: Option<u32>,
    pub screen_relay_kbps: Option<u32>,
    pub camera_relay_kbps: Option<u32>,
    pub group_camera_high_kbps: Option<u32>,
    pub group_camera_low_kbps: Option<u32>,
    /// 群通话里共享的屏幕的码率上限（F12）。
    pub group_screen_kbps: Option<u32>,
}

/// 系统概况。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Overview {
    pub users_total: u64,
    pub users_disabled: u64,
    /// 此刻有连接的用户数。
    pub online: u64,
    pub groups: u64,
    /// 全部上传的文件：头像和消息里的文件。
    pub files_count: u64,
    pub files_bytes: u64,
}

string_enum!(TokenPurpose { ResetPassword => "reset_password", ConfirmEmail => "confirm_email" });

/// 发到邮箱里的链接所带的一次性令牌。数据库里只保存它的哈希。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdminToken {
    pub token_hash: String,
    pub user: UserId,
    pub purpose: TokenPurpose,
    /// 确认邮箱时：要改成的新邮箱。
    pub email: Option<String>,
    pub expires_at: i64,
    pub used_at: Option<i64>,
}
