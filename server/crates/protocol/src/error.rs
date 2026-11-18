use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 稳定的错误码。客户端按错误码和当前语言决定显示什么文字，所以这里的取值不能随意改名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    /// 请求的格式或参数不对。
    BadRequest,
    /// 没有登录，或登录已经失效。
    Unauthorized,
    /// 没有权限，或请求的来源不被允许。
    Forbidden,
    /// 路径或资源不存在。
    NotFound,
    /// 路径存在，但不支持这种请求方法。
    MethodNotAllowed,
    /// 上传的内容超过了大小上限。
    PayloadTooLarge,
    /// 请求太频繁。`retry_after_secs` 给出还要等多久。
    TooManyRequests,
    /// 服务端内部出错。
    Internal,
    /// 服务端依赖的资源（如数据库）暂时不可用。
    Unavailable,

    /// ID 或密码不正确。
    InvalidCredentials,
    /// 连续输错密码，这个 ID 暂时被锁定。`retry_after_secs` 给出还要等多久。
    AccountLocked,
    AccountDisabled,
    /// 必须先修改密码才能做别的事。
    MustChangePassword,

    InviteCodeNotFound,
    InviteCodeUsed,
    InviteCodeExpired,
    InviteCodeRevoked,

    PasswordTooWeak,
    /// 密码不能与 ID 相同。
    PasswordSameAsId,
    /// 修改密码时，当前密码不正确。
    PasswordIncorrect,
    /// 新密码与当前密码相同。
    PasswordUnchanged,

    /// ID 不符合规则。
    IdInvalid,
    IdTaken,
    NicknameInvalid,
    SignatureTooLong,
    /// 上传的文件不是受支持的图片。
    UnsupportedImage,

    /// 没有这个用户。
    UserNotFound,
    /// 不能加自己为好友。
    CannotAddSelf,
    AlreadyFriends,
    /// 对方不是我的好友。
    NotFriends,
    FriendRequestNotFound,
    /// 这条好友申请已经被同意或拒绝过了。
    FriendRequestHandled,
    /// 好友申请的验证信息太长。
    FriendRequestMessageTooLong,
    RemarkTooLong,

    /// 没有这个会话，或者我不是它的成员。
    ConversationNotFound,
    MessageEmpty,
    MessageTooLong,

    /// 建群至少要选两个人。
    GroupTooSmall,
    /// 群人数会超过上限。
    GroupFull,
    GroupNameTooLong,
    /// 这件事只有群主能做。
    NotGroupOwner,
    /// 这件事只有群主和管理员能做。
    NotGroupManager,
    /// 一个群最多 3 名管理员。
    TooManyAdmins,
    /// 没有这条入群申请。
    JoinRequestNotFound,
    /// 这条入群申请已经处理过了，或者已经过期。
    JoinRequestHandled,
    /// 群主和管理员不能被禁言。
    CannotMuteManager,
    /// 我在这个群里被禁言了。还剩多久看会话里的 `muted_until`。
    Muted,
    /// 全员禁言中，只有群主和管理员能发。
    AllMuted,
    /// 群主不能直接退群，要先转让或解散。
    OwnerCannotLeave,
    GroupDissolved,
    /// 我已经不在这个群里了。
    LeftGroup,
    /// 操作的对象不在这个群里。
    NotGroupMember,

    /// 没有这条消息，或者我看不到它。
    MessageNotFound,
    /// 文件超过了大小上限。上限见 `/api/limits`。
    FileTooLarge,
    /// 这个文件不能用来发这条消息：不存在、不是我上传的、已经用过，或者类型对不上。
    FileUnavailable,
    /// 语音超过了时长上限。
    VoiceTooLong,
    /// 被引用的消息不能引用：不存在、已经撤回，或者它是一条系统提示。
    QuoteUnavailable,
    /// 已经过了可以撤回的时限。
    RecallTooLate,
    /// 这条不能撤回：不是我发的、是一条系统提示，或者已经撤回过了。
    RecallNotAllowed,
    /// 这条不能转发：已经撤回了，或者它是系统提示。
    ForwardNotAllowed,
    /// 已经过了可以编辑的时限，或者管理员关掉了编辑（F8）。
    EditTooLate,
    /// 这条不能编辑：不是我发的、不是文字或图片、已经撤回了（F8）。
    EditNotAllowed,

    /// 这个会话里不能打电话：只能在和好友的单聊里打。
    CallNotAllowed,
    /// 没有这个通话：不存在、已经结束，或者我不是它的一方。
    CallNotFound,
    /// 我已经在一个通话里了（在任何一台设备上）。
    AlreadyInCall,
    /// 这个通话已经不在响铃了：已经在别处接了，或者已经结束。
    CallNotRinging,
    /// 还没接通，不能交换建立连接用的信息。
    CallNotAnswered,
    /// 这台设备不在通话里：通话是在另一台设备上发起或接听的。
    WrongCallDevice,
    /// 这个群已经有一个通话在进行（F10）：应该加入它，而不是再发起一个。
    GroupCallRunning,
    /// 群通话人数已满。
    GroupCallFull,
    /// 我不在这个群通话里：不能邀请别人，也没有什么可离开的。
    NotInGroupCall,
    /// 群通话里已经有别人在共享屏幕（F12）：同一时间只有一个人共享，要等他停。
    GroupCallSharing,

    /// 管理员不能对自己做这件事：禁用、重置密码。
    CannotTargetSelf,
    /// 系统设置的值不在允许的范围里。
    SettingOutOfRange,
    /// 要先"开始一次查看"：没有带查看凭据，或者它过期了、不是这个会话的。
    ViewRequired,
    /// 邮件里的链接无效：不存在、用过了，或者过期了。
    LinkInvalid,
    EmailInvalid,
}

/// 所有接口的错误响应都是这个结构。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ErrorResponse {
    pub code: ErrorCode,
    /// 供排查问题用的说明，不直接显示给用户。
    pub message: String,
    /// 被锁定或被限速时，还要等多少秒才能再试。
    pub retry_after_secs: Option<u32>,
}
