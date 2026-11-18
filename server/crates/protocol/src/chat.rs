//! 聊天相关接口的请求和响应：会话、消息、已读位置。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::contact::{Relation, UserCard};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ConversationKind {
    Direct,
    Group,
}

/// 会话日志里一条的类型。`text`、`image`、`file`、`voice`、`chat_record` 是消息，其余都是事件。
/// 事件只带类型和参数（谁做的、对谁做的），显示成什么文字由客户端按当前语言决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum MessageKind {
    Text,
    /// 一张图片，在 `file` 里。
    Image,
    /// 一个文件，在 `file` 里。
    File,
    /// 一段语音，在 `file` 里；时长在 `duration_ms` 里。
    Voice,
    /// 一条聊天记录（合并转发），在 `record` 里。
    ChatRecord,
    /// `actor` 撤回了序号为 `target_seq` 的那条消息。这一条本身不显示：
    /// 收到它，就把那条消息换成"撤回了一条消息"的提示。
    Recalled,
    /// `actor` 编辑了序号为 `target_seq` 的那条消息，新的内容在 `text` 里，这一次新 @ 到的人
    /// 在 `mentions`、`mention_all` 里（F8）。这一条本身不显示：收到它，就把那条消息换成新的内容。
    Edited,
    /// 两个人成为了好友。
    Friends,
    /// `actor` 拉 `targets` 建了群。
    GroupCreated,
    /// `actor` 邀请 `targets` 入群。
    MemberJoined,
    /// `actor` 退出了群。
    MemberLeft,
    /// `actor`（群主）把 `targets` 移出了群。
    MemberRemoved,
    /// `actor` 把群主转让给了 `targets`。
    OwnerChanged,
    /// `actor`（群主）把 `targets` 设为了群管理员。
    AdminAdded,
    /// `actor`（群主）取消了 `targets` 的群管理员。
    AdminRemoved,
    /// `actor` 禁言了 `targets`，到 `until` 为止。
    MemberMuted,
    /// `actor` 解除了 `targets` 的禁言。
    MemberUnmuted,
    /// `actor` 开启了全员禁言。
    AllMuted,
    /// `actor` 关闭了全员禁言。
    AllUnmuted,
    /// `actor` 把群名改成了 `name`；`name` 为空表示去掉了群名。
    Renamed,
    /// `actor` 换了群头像。
    AvatarChanged,
    /// `actor` 解散了群。
    Dissolved,
    /// `actor`（群主）发布或修改了群公告，这一次的全文在 `text` 里；`text` 为空表示清空了。
    NoticeChanged,
    /// 一条通话记录：发送人是主叫，结果在 `call_outcome` 里，接通过的时长在 `duration_ms` 里。
    /// 算未读、会提醒，但不能引用、撤回、转发，也搜不到。
    Call,
}

/// 事件里提到的一个人。昵称是事件发生时的：这个人现在查不到了，还能显示出当时的名字。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EventParty {
    pub id: String,
    pub nickname: String,
}

/// 一个上传好的文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FileView {
    pub id: String,
    /// 上传时的文件名。
    pub name: String,
    /// 字节数。
    #[ts(type = "number")]
    pub size: i64,
    /// 图片的宽高。只有服务端认定是图片的文件才有：它可以在页面里显示，并且有缩略图。
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 服务端认定它是一段可以在页面里播放的音频：可以作为语音消息发出去。
    pub audio: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum QuoteState {
    /// 可以显示：带着发送人和摘要。
    Shown,
    /// 原消息已经撤回。
    Recalled,
    /// 我看不到原消息：它在我入群之前。
    Unavailable,
}

/// 回复里被引用的那条消息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct QuoteView {
    /// 被引用消息的序号。
    #[ts(type = "number")]
    pub seq: i64,
    pub state: QuoteState,
    pub sender_id: Option<String>,
    /// 发送人现在的昵称。
    pub sender_name: Option<String>,
    pub kind: Option<MessageKind>,
    /// 文本消息的开头一段；图片的文字说明的开头一段。
    pub text: Option<String>,
    /// 文件消息的文件名。
    pub file_name: Option<String>,
}

/// 会话日志里的一条。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageView {
    pub id: String,
    pub conversation_id: String,
    /// 在会话内的序号，从 1 开始，连续不重复。所有人都按它排列。
    #[ts(type = "number")]
    pub seq: i64,
    /// 发送人的内部编号。事件没有发送人。
    pub sender_id: Option<String>,
    /// 发送方的客户端生成的编号。发送方用它认出自己发出的那一条。
    pub client_id: Option<String>,
    pub kind: MessageKind,
    /// 文本消息的文字；图片的文字说明（可能为空）。
    pub text: Option<String>,
    /// 群消息的发送人现在的昵称。单聊和事件没有。
    pub sender_name: Option<String>,
    /// 事件是谁做的。
    pub actor: Option<EventParty>,
    /// 事件是对谁做的。
    pub targets: Vec<EventParty>,
    /// 改名事件里新的群名。
    pub name: Option<String>,
    /// 消息 @ 了谁：他们的内部编号。
    pub mentions: Vec<String>,
    /// 消息 @ 了所有人。
    pub mention_all: bool,
    /// 图片、文件、语音消息所附的文件。
    pub file: Option<FileView>,
    /// 语音消息的时长；通话记录里接通了多久。毫秒。
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    /// 聊天记录的内容。
    pub record: Option<ChatRecordView>,
    /// 通话记录里通话是怎么结束的。
    pub call_outcome: Option<crate::call::CallOutcome>,
    /// 通话记录：是视频通话。
    pub call_video: bool,
    /// 群通话的记录：一共有几个人参加过，包括发起人。一对一通话的记录里为空。
    pub call_joined: Option<u32>,
    /// 经过审批入群的事件里同意的人。这时 `actor` 是邀请人。
    pub approver: Option<EventParty>,
    /// 禁言事件里禁言到什么时候，UTC 毫秒。"直到解除"是一个极大的值（公元 9999 年底）。
    #[ts(type = "number | null")]
    pub until: Option<i64>,
    /// 这条消息是在回复哪一条。
    pub reply: Option<QuoteView>,
    /// 这条消息已经被撤回：不带任何内容，只知道是谁发的。
    /// 管理员查看聊天内容时例外：仍然带着原内容。
    pub recalled: bool,
    /// 撤回、编辑事件里被撤回、被编辑的那条消息的序号。
    #[ts(type = "number | null")]
    pub target_seq: Option<i64>,
    /// 别人发来的语音消息我听过没有。
    pub played: bool,
    /// 最后一次编辑的时间，UTC 毫秒（F8）。没有编辑过为空。
    #[ts(type = "number | null")]
    pub edited_at: Option<i64>,
    /// 编辑事件里这一次修改之前的内容。只有管理员查看聊天内容时才有。
    pub previous_text: Option<String>,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
}

/// 一条聊天记录：转发那一刻的快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ChatRecordView {
    pub title: String,
    /// 按原来的先后。
    pub items: Vec<RecordItemView>,
}

/// 聊天记录里的一条。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RecordItemView {
    /// 原发送人的内部编号。
    pub sender_id: Option<String>,
    /// 原发送人转发那一刻的昵称和头像。
    pub sender_name: String,
    pub sender_avatar_file_id: Option<String>,
    /// `text`、`image`、`file`、`voice`、`chat_record` 之一。
    pub kind: MessageKind,
    /// 文字；图片的文字说明；嵌在里面的聊天记录的标题。
    pub text: Option<String>,
    /// 图片、文件、语音。
    pub file: Option<FileView>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<i64>,
    /// 原消息的时间，UTC 毫秒。
    #[ts(type = "number")]
    pub created_at: i64,
}

/// 单聊的对方。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPeer {
    pub user: UserCard,
    /// 对方就是我自己：这是和自己的对话。
    pub is_self: bool,
    /// 我给他起的备注名。
    pub remark: Option<String>,
    /// 现在还是不是好友。不是好友时不能再发消息，历史仍然可以看。
    pub is_friend: bool,
    /// 他的已读位置：我发的消息里，序号不大于它的他都看过了。
    #[ts(type = "number")]
    pub read_seq: i64,
}

/// 群的情况。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GroupView {
    /// 群名称。没有起名时为空，这时用 `name_hint` 来显示。
    pub name: Option<String>,
    /// 最早加入的几名成员的昵称。
    pub name_hint: Vec<String>,
    pub avatar_file_id: Option<String>,
    pub owner_id: Option<String>,
    /// 群已经解散：谁都不能再发消息，历史保留。
    pub dissolved: bool,
    /// 现在在群的人数。
    pub member_count: u32,
    /// 人数上限，包括群主。
    pub max_members: u32,
    /// 我已经不在这个群里了：只能看离开之前的消息。
    pub left: bool,
    /// 有 @ 我的消息我还没看。发布群公告也算。
    pub mentioned: bool,
    /// 当前的群公告。没有公告、或者我已经离开了时为空。
    pub notice: Option<NoticeView>,
    /// 有公告，并且是我还没看过的那一次：会话顶部显示公告条。
    pub notice_unseen: bool,
    /// 现在的群管理员：他们的内部编号。
    pub admin_ids: Vec<String>,
    /// 全员禁言开着：只有群主和管理员能发消息。
    pub all_muted: bool,
    /// 入群审批开着：普通成员邀请的人要群主或管理员同意。
    pub join_approval: bool,
    /// 等着处理的入群申请有几条。只有群主和管理员看得到，其他人是 0。
    pub pending_requests: u32,
    /// 我被禁言到什么时候，UTC 毫秒。没有禁言、或者已经到时间了为空。
    #[ts(type = "number | null")]
    pub muted_until: Option<i64>,
}

/// 一则群公告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NoticeView {
    pub text: String,
    /// 发布人的内部编号和现在的昵称。
    pub by_id: String,
    pub by_name: Option<String>,
    /// UTC 毫秒。
    #[ts(type = "number")]
    pub at: i64,
    /// 发布它的那条事件的序号。
    #[ts(type = "number")]
    pub seq: i64,
}

/// 发布、修改或清空群公告。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetNoticeRequest {
    /// 公告的全文，最多 1000 字。只有空白就是清空。
    pub text: String,
}

/// 推送：我在别处看过了一个群的公告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct NoticeSeen {
    pub conversation_id: String,
    /// 看过的那一次公告的序号。
    #[ts(type = "number")]
    pub seq: i64,
}

/// 推送：一个群的成员名单变了，但没有在群里留下提示（例如有人改了群内昵称）。重新取一下名单。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MembersChanged {
    pub conversation_id: String,
}

/// 改我在一个群里的昵称的请求。只有空白就是去掉，最多 20 个字。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SetGroupNicknameRequest {
    pub nickname: String,
}

/// 我眼里的一个会话。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationView {
    pub id: String,
    pub kind: ConversationKind,
    /// 单聊的对方。
    pub peer: Option<ConversationPeer>,
    /// 群的情况。
    pub group: Option<GroupView>,
    /// 我能看到的最新一条的序号。还没有任何内容时是 0。
    #[ts(type = "number")]
    pub last_seq: i64,
    /// 我的已读位置。
    #[ts(type = "number")]
    pub read_seq: i64,
    pub last_message: Option<MessageView>,
    /// 别人发的、我还没有看过的消息条数。
    pub unread: u32,
    /// 我把这个会话设成了免打扰：消息照常收，只是不提醒。
    pub muted: bool,
    /// 我把这个会话置顶的时间，UTC 毫秒。没有置顶为空。置顶的排在列表的最前面。
    #[ts(type = "number | null")]
    pub pinned_at: Option<i64>,
}

/// 我的会话列表，置顶的在前，各自按最新有动静的先后。只含有内容、并且没有被我移除的会话。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationList {
    pub items: Vec<ConversationView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpenDirectRequest {
    /// 好友的内部编号。
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SendMessageRequest {
    /// 客户端为这条消息生成的编号。没等到结果而重发时带同一个，服务端据此不会存成两条。
    pub client_id: String,
    /// 文本消息的文字；图片的文字说明。文件和语音不能带文字。
    #[serde(default)]
    #[ts(optional)]
    pub text: Option<String>,
    /// 所附的文件：先上传，再把得到的编号放在这里。是图片就按图片发，否则按文件发。
    #[serde(default)]
    #[ts(optional)]
    pub file_id: Option<String>,
    /// 语音的时长，毫秒。给了它，所附的文件就按语音发。
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub voice_duration_ms: Option<i64>,
    /// 回复的是哪一条：被引用消息的序号。
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub reply_to: Option<i64>,
    /// @ 了谁：他们的内部编号。只在群里、并且有文字（文本消息或带说明的图片）时有用。
    #[serde(default)]
    #[ts(optional)]
    pub mentions: Option<Vec<String>>,
    /// @ 所有人。只有群主可以。
    #[serde(default)]
    #[ts(optional)]
    pub mention_all: Option<bool>,
    /// 转发：内容从这一条复制过来。给了它，就不用给文字、文件、引用和 @。
    #[serde(default)]
    #[ts(optional)]
    pub forward: Option<ForwardFrom>,
    /// 合并转发：把同一个会话里的几条做成一条聊天记录。给了它，就不用给文字、文件、引用和 @。
    #[serde(default)]
    #[ts(optional)]
    pub merge: Option<MergeFrom>,
}

/// 合并转发的是哪几条：一个我能看到的会话里的序号，最多 50 条。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MergeFrom {
    pub conversation_id: String,
    #[ts(type = "Array<number>")]
    pub seqs: Vec<i64>,
    /// 聊天记录的标题，最多 100 个字。
    pub title: String,
}

/// 转发的是哪一条：一个我能看到的会话里的序号。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ForwardFrom {
    pub conversation_id: String,
    #[ts(type = "number")]
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateGroupRequest {
    /// 群名称，可以不起。
    #[serde(default)]
    #[ts(optional)]
    pub name: Option<String>,
    /// 要拉进来的好友的内部编号，至少两个。
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteMembersRequest {
    pub user_ids: Vec<String>,
}

/// 邀请的结果。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct InviteResult {
    pub conversation: ConversationView,
    /// 开着入群审批、我是普通成员时：这一次发出了几条入群申请。直接加进来时是 0。
    pub requested: u32,
}

/// 开关入群审批的请求。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinApprovalRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JoinRequestStatus {
    Pending,
    Approved,
    Rejected,
    /// 7 天没有处理。
    Expired,
}

/// 一条入群申请。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinRequestView {
    pub id: String,
    pub inviter: UserCard,
    pub invitee: UserCard,
    pub status: JoinRequestStatus,
    #[ts(type = "number")]
    pub created_at: i64,
    /// 处理的人的昵称和处理的时间。
    pub handled_by_name: Option<String>,
    #[ts(type = "number | null")]
    pub handled_at: Option<i64>,
}

/// 一个群的入群申请，新的在前。群主和管理员看到全部，其他人只看到自己发出的。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinRequestList {
    pub items: Vec<JoinRequestView>,
}

/// 推送：一个群的入群申请变了（有了新的，或者有一条被处理了）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JoinRequestsChanged {
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RenameGroupRequest {
    /// 留空即去掉群名。
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TransferOwnerRequest {
    pub user_id: String,
}

/// 群里的一个成员，从我的角度看。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MemberView {
    pub user: UserCard,
    /// 我给他起的备注名。
    pub remark: Option<String>,
    pub is_friend: bool,
    pub is_owner: bool,
    /// 群管理员。
    pub is_admin: bool,
    /// 他在这个群里的昵称。群里显示名字时排在我给他的备注之后、他的昵称之前。
    pub group_nickname: Option<String>,
    /// 被禁言到什么时候，UTC 毫秒。没有禁言、或者已经到时间了为空。
    #[ts(type = "number | null")]
    pub muted_until: Option<i64>,
    /// 现在还在不在群里。离开的人也列出来：显示他以前发的消息时要用到他的名称和头像。
    pub active: bool,
    /// 入群时的序号：这之后的消息他才看得到。
    #[ts(type = "number")]
    pub joined_seq: i64,
    /// 他的已读位置。
    #[ts(type = "number")]
    pub read_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MemberList {
    pub items: Vec<MemberView>,
}

/// 同一个群的成员的资料。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MemberProfile {
    pub user: UserCard,
    pub signature: String,
    pub remark: Option<String>,
    /// 他和我的关系。
    pub relation: Relation,
    /// 关系是 `request_received` 时，他发来的那条好友申请的编号。
    pub request_id: Option<String>,
}

/// 会话里的一段消息，按序号从小到大。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageList {
    pub items: Vec<MessageView>,
    /// 这个方向上还有没有更多：向上翻时是更早的，补齐时是更新的。
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MarkReadRequest {
    /// 序号不大于它的我都看过了。
    #[ts(type = "number")]
    pub seq: i64,
}

/// 一个成员的已读位置。上报已读的应答，也是推送给会话成员的事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationRead {
    pub conversation_id: String,
    pub user_id: String,
    #[ts(type = "number")]
    pub read_seq: i64,
}

/// 推送：我在别处把一个会话从列表里移除了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationHidden {
    pub conversation_id: String,
}

/// 禁言一名成员的请求。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MuteMemberRequest {
    /// 多少分钟：10、60、720、1440 之一。为空是直到解除。
    #[serde(default)]
    pub minutes: Option<u32>,
}

/// 编辑一条消息（F8）：新的文字，和改完之后 @ 了谁。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EditMessageRequest {
    pub text: String,
    #[serde(default)]
    #[ts(optional)]
    pub mentions: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional)]
    pub mention_all: Option<bool>,
}

/// 设置或取消免打扰的请求；开关全员禁言也用它。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MuteRequest {
    pub muted: bool,
}

/// 推送：我在别处把一个会话设成了免打扰，或者取消了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationMuted {
    pub conversation_id: String,
    pub muted: bool,
}

/// 置顶或者取消置顶的请求。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PinRequest {
    pub pinned: bool,
}

/// 置顶的结果；也是推送：我在别处把一个会话置顶了，或者取消了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationPinned {
    pub conversation_id: String,
    /// 置顶的时间。取消了为空。
    #[ts(type = "number | null")]
    pub pinned_at: Option<i64>,
}

/// 从自己这边删掉几条（F6）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeleteMessagesRequest {
    #[ts(type = "number[]")]
    pub seqs: Vec<i64>,
}

/// 删掉的结果；也是推送：我在别处把这几条从自己这边删掉了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessagesDeleted {
    pub conversation_id: String,
    #[ts(type = "number[]")]
    pub seqs: Vec<i64>,
}

/// 清空的结果；也是推送：我在别处把这个会话的记录清空了（F6）。序号不大于 `cleared_seq` 的都不见了。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ConversationCleared {
    pub conversation_id: String,
    #[ts(type = "number")]
    pub cleared_seq: i64,
}

/// 推送：我在别处听过了一条语音。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessagePlayed {
    pub conversation_id: String,
    #[ts(type = "number")]
    pub seq: i64,
}

/// 搜索的结果，从新到旧。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SearchResult {
    pub items: Vec<MessageView>,
    /// 还有更多没有交出来：在全部会话里搜时，说明结果太多、只给了最新的一批。
    pub has_more: bool,
}

/// 当前生效的几项上限。管理员可以调整。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LimitsView {
    /// 单个文件最大多少字节。图片和语音也受它限制。
    #[ts(type = "number")]
    pub file_max_bytes: u64,
    /// 一条语音消息最长多少秒。
    pub voice_max_seconds: u32,
    /// 消息发出后多少秒之内可以撤回。0 表示不允许撤回。
    pub recall_window_seconds: u32,
    /// 消息发出后多少秒之内可以编辑。0 表示不允许编辑（F8）。
    pub edit_window_seconds: u32,
    /// 群通话最多几个人（F10）。
    pub group_call_max: u32,
}
