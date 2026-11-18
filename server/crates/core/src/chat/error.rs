use crate::store::StoreError;

/// 聊天相关操作的失败原因。每一种都对应接口里的一个错误码和界面上的一句提示。
#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    /// 没有这个会话，或者自己不是它的成员。两种情况不作区分。
    #[error("no such conversation")]
    ConversationNotFound,
    /// 单聊的双方已经不是好友了；或者建群、邀请时选的人不是自己的好友。
    #[error("not friends")]
    NotFriends,
    #[error("message is empty")]
    MessageEmpty,
    #[error("message is too long")]
    MessageTooLong,

    /// 建群至少要选两个人。
    #[error("a group needs at least two other members")]
    GroupTooSmall,
    #[error("the group would exceed its size limit, room for {room} more")]
    GroupFull { room: u32 },
    #[error("group name is too long")]
    GroupNameTooLong,
    /// 这件事只有群主能做。
    #[error("only the group owner can do this")]
    NotOwner,
    /// 这件事只有群主和管理员能做。
    #[error("only the group owner or an admin can do this")]
    NotManager,
    #[error("a group can have at most {max} admins")]
    TooManyAdmins { max: u32 },
    /// 群主和管理员不能被禁言。
    #[error("the owner and admins cannot be muted")]
    CannotMuteManager,
    /// 我在这个群里被禁言了，到 `until`（UTC 毫秒）为止。
    #[error("you are muted in this group")]
    Muted { until: i64 },
    /// 全员禁言中，只有群主和管理员能发。
    #[error("everyone is muted in this group")]
    AllMuted,
    /// 没有这条入群申请，或者它不是这个群的。
    #[error("no such join request")]
    JoinRequestNotFound,
    /// 这条入群申请已经处理过了，或者已经过期。
    #[error("this join request has already been handled or has expired")]
    JoinRequestHandled,
    /// 群主不能直接退群，要先转让或解散。
    #[error("the owner must transfer or dissolve the group before leaving")]
    OwnerCannotLeave,
    #[error("the group has been dissolved")]
    GroupDissolved,
    /// 我已经不在这个群里了。
    #[error("no longer a member of this group")]
    LeftGroup,
    /// 操作的对象不在这个群里。
    #[error("that user is not a member of this group")]
    NotMember,
    /// 没有这条消息，或者我看不到它。
    #[error("no such message")]
    MessageNotFound,
    /// 这个文件不能用来发这条消息：不存在、不是我上传的、已经用过，或者类型对不上。
    #[error("that file cannot be attached to this message")]
    FileUnavailable,
    #[error("the voice message is longer than {max_seconds} seconds")]
    VoiceTooLong { max_seconds: u32 },
    /// 被引用的消息不能引用：不存在、我看不到、已经撤回，或者它是一条系统提示。
    #[error("that message cannot be quoted")]
    QuoteUnavailable,
    /// 已经过了可以撤回的时限。
    #[error("too late to recall this message")]
    RecallTooLate,
    /// 这条不能撤回：不是我发的、是一条系统提示，或者已经撤回过了。
    #[error("this message cannot be recalled")]
    RecallNotAllowed,
    /// 已经过了可以编辑的时限，或者管理员关掉了编辑（F8）。
    #[error("too late to edit this message")]
    EditTooLate,
    /// 这条不能编辑：不是我发的、不是文字或图片、已经撤回了（F8）。
    #[error("this message cannot be edited")]
    EditNotAllowed,
    /// 这条不能转发：已经撤回了，或者它是系统提示。
    #[error("this message cannot be forwarded")]
    ForwardNotAllowed,
    /// 这个会话里不能打电话：群、和自己的对话。
    #[error("calls are only possible in a one-to-one chat with a friend")]
    CallNotAllowed,
    #[error("invalid request: {0}")]
    Invalid(&'static str),

    #[error(transparent)]
    Store(#[from] StoreError),
}
