//! HTTP 和 WebSocket 的消息类型，前后端共用。
//!
//! 带 `#[ts(export)]` 的类型由 `scripts/gen-protocol` 生成对应的 TS 类型，
//! 输出到 `client/packages/protocol`。

mod account;
mod admin;
mod call;
mod chat;
mod contact;
mod desktop;
mod error;
mod health;
mod realtime;

pub use account::{
    ChangeHandleRequest, ChangePasswordRequest, CreateInviteCodesRequest,
    DeleteInviteCodesResponse, InviteCodeIds, InviteCodeList, InviteCodeOrder, InviteCodePage,
    InviteCodeStatus, InviteCodeUser, InviteCodeView, Language, LoginRequest, Me, RegisterRequest,
    RevokeInviteCodesResponse, Role, SessionList, SessionView, SignedOutOthers, Theme,
    UpdateProfileRequest,
};
pub use admin::{
    AdminConversationList, AdminConversationView, AdminGroupPage, AdminMemberList, AdminMemberView,
    AdminUserPage, AdminUserView, AuditAction, AuditEntryView, AuditPage, ChangeEmailRequest,
    EmailConfirmRequest, EmailConfirmed, OverviewView, PasswordResetConfirm, PasswordResetRequest,
    ResetPasswordResponse, SettingRange, SettingsView, UpdateSettingsRequest, UserStatus,
    ViewStarted,
};
pub use call::{
    CallDeviceRequest, CallOutcome, CallSignal, CallSignalRequest, CallState, CallVideoView,
    CallView, CurrentCall, GroupCallDeviceRequest, GroupCallInvite, GroupCallInviteRequest,
    GroupCallJoined, GroupCallList, GroupCallMember, GroupCallView, GroupCheckRequest,
    HangupReason, IceServerView, IceServers, RejectCallRequest, RejectReason, RoomTicketView,
    StartCallRequest, StartGroupCallRequest,
};
pub use chat::{
    ChatRecordView, ConversationCleared, ConversationHidden, ConversationKind, ConversationList,
    ConversationMuted, ConversationPeer, ConversationPinned, ConversationRead, ConversationView,
    CreateGroupRequest, DeleteMessagesRequest, EditMessageRequest, EventParty, FileView,
    ForwardFrom, GroupView, InviteMembersRequest, InviteResult, JoinApprovalRequest,
    JoinRequestList, JoinRequestStatus, JoinRequestView, JoinRequestsChanged, LimitsView,
    MarkReadRequest, MemberList, MemberProfile, MemberView, MembersChanged, MergeFrom, MessageKind,
    MessageList, MessagePlayed, MessageView, MessagesDeleted, MuteMemberRequest, MuteRequest,
    NoticeSeen, NoticeView, OpenDirectRequest, PinRequest, QuoteState, QuoteView, RecordItemView,
    RenameGroupRequest, SearchResult, SendMessageRequest, SetGroupNicknameRequest,
    SetNoticeRequest, TransferOwnerRequest,
};
pub use contact::{
    FriendList, FriendProfile, FriendRemoved, FriendRequestDirection, FriendRequestList,
    FriendRequestResult, FriendRequestStatus, FriendRequestView, FriendView, Relation,
    SendFriendRequest, SetRemarkRequest, UserCard, UserLookup,
};
pub use desktop::{DesktopLatest, DesktopRelease};
pub use error::{ErrorCode, ErrorResponse};
pub use health::{HealthResponse, HealthStatus};
pub use realtime::{ClientMessage, ServerEvent, SysHello, Typing, TypingStarted};
