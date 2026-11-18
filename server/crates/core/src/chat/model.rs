use crate::account::model::string_enum;
use crate::call::CallOutcome;
use crate::ids::{ConversationId, FileId, JoinRequestId, MessageId, UserId};

string_enum!(ConversationKind { Direct => "direct", Group => "group" });

string_enum!(
    /// 入群申请的状态。"过期"不写进数据库：待处理的超过 7 天，读出来时就算过期。
    JoinRequestStatus {
        Pending => "pending",
        Approved => "approved",
        Rejected => "rejected",
        Expired => "expired",
    }
);

/// 一条入群申请：开着入群审批时，普通成员邀请的每一个人都生成一条，等群主或管理员处理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequest {
    pub id: JoinRequestId,
    pub conversation: ConversationId,
    pub inviter: UserId,
    pub invitee: UserId,
    pub status: JoinRequestStatus,
    pub created_at: i64,
    /// 处理的人和时间。
    pub handled_by: Option<UserId>,
    pub handled_at: Option<i64>,
}

impl JoinRequest {
    /// 在 `cutoff` 之前发出、还没有处理的，算过期。
    pub fn status_at(&self, cutoff: i64) -> JoinRequestStatus {
        if self.status == JoinRequestStatus::Pending && self.created_at < cutoff {
            JoinRequestStatus::Expired
        } else {
            self.status
        }
    }
}

string_enum!(
    /// 会话日志里一条的类型。文本、图片、文件、语音是消息，其余都是事件。
    /// 事件只保存类型和参数（谁做的、对谁做的），显示成什么文字由客户端按当前语言决定。
    /// 通话记录（call）介于两者之间：有发送人（主叫），算未读、会提醒，
    /// 但不能引用、撤回、转发，也搜不到。
    MessageKind {
        Text => "text",
        Image => "image",
        File => "file",
        Voice => "voice",
        ChatRecord => "chat_record",
        Recalled => "recalled",
        Edited => "edited",
        Friends => "friends",
        GroupCreated => "group_created",
        MemberJoined => "member_joined",
        MemberLeft => "member_left",
        MemberRemoved => "member_removed",
        OwnerChanged => "owner_changed",
        Renamed => "renamed",
        AvatarChanged => "avatar_changed",
        Dissolved => "dissolved",
        NoticeChanged => "notice_changed",
        AdminAdded => "admin_added",
        AdminRemoved => "admin_removed",
        MemberMuted => "member_muted",
        MemberUnmuted => "member_unmuted",
        AllMuted => "all_muted",
        AllUnmuted => "all_unmuted",
        Call => "call",
    }
);

impl MessageKind {
    /// 是人发的消息，不是事件。只有消息可以被引用、被撤回、被搜到。
    pub fn is_message(&self) -> bool {
        matches!(
            self,
            Self::Text | Self::Image | Self::File | Self::Voice | Self::ChatRecord
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: ConversationId,
    pub kind: ConversationKind,
    /// 最新一条的序号。还没有任何内容时是 0。
    pub last_seq: i64,
    pub created_at: i64,
    /// 群名称。没有起名的群和单聊为空。
    pub name: Option<String>,
    /// 群头像。
    pub avatar: Option<FileId>,
    /// 群主。单聊没有。
    pub owner: Option<UserId>,
    /// 群已经解散：谁都不能再发消息，历史保留。
    pub dissolved: bool,
    /// 群公告。没有公告的群和单聊为空。
    pub notice: Option<Notice>,
    /// 全员禁言：只有群主和管理员能发消息。
    pub all_muted: bool,
    /// 入群审批：普通成员邀请的人要群主或管理员同意。
    pub join_approval: bool,
}

impl Conversation {
    /// 这个人是不是群主。
    pub fn is_owner(&self, user: UserId) -> bool {
        self.owner == Some(user)
    }
}

/// 一则群公告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    /// 发布人。
    pub by: UserId,
    pub at: i64,
    /// 发布它的那条事件的序号。成员"看过的公告"记的就是它。
    pub seq: i64,
}

/// 一个成员在一个会话里的状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub conversation: ConversationId,
    pub user: UserId,
    /// 加入时会话的序号：只能看到这之后的内容。单聊里是 0。
    pub joined_seq: i64,
    /// 离开（退群或被移出）时的序号：只能看到这之前的内容，包括这一条。还在会话里时为空。
    pub left_seq: Option<i64>,
    /// 已读位置：序号不大于它的都看过了。
    pub read_seq: i64,
    /// 最近一次被 @ 的序号。它大于已读位置，说明有 @ 他的消息他还没看。
    pub mentioned_seq: i64,
    /// 把会话从列表移除时的序号。能看到的最新序号超过它时，会话重新出现在列表里。
    pub hidden_seq: Option<i64>,
    /// 免打扰：消息照常收、未读数照常算，只是不提醒。
    pub muted: bool,
    /// 看过的群公告：发布它的那条事件的序号。小于现在公告的序号，说明有新公告他还没看。
    pub notice_seen_seq: i64,
    /// 第一次加入的时间。成员按它排先后。
    pub since: i64,
    /// 群管理员。离开群时不再是。
    pub admin: bool,
    /// 群内昵称：只在这个群里显示。
    pub nickname: Option<String>,
    /// 禁言到什么时候，UTC 毫秒。为空是没有禁言；过了这个时间自然解除。
    pub muted_until: Option<i64>,
    /// 把会话置顶的时间，UTC 毫秒。没有置顶为空。
    pub pinned_at: Option<i64>,
    /// 清空聊天记录清空到了第几条（F6）：序号不大于它的他都看不到了。没有清空过是 0。
    pub cleared_seq: i64,
}

impl Member {
    /// 现在是否还在会话里。
    pub fn is_active(&self) -> bool {
        self.left_seq.is_none()
    }

    /// 他能看到的最新一条的序号。
    pub fn last_visible(&self, conversation: &Conversation) -> i64 {
        self.left_seq.unwrap_or(conversation.last_seq)
    }

    /// 他能看到的范围：入群之后、清空之后的，离开之前的；不含他自己删掉的。
    pub fn visible(&self) -> Visible {
        Visible {
            after: self.joined_seq.max(self.cleared_seq),
            until: self.left_seq,
            viewer: Some(self.user),
        }
    }

    /// 这个会话现在是否显示在他的会话列表里：要有他能看到的内容，
    /// 并且没有被移除，或者移除之后又有了新内容。
    pub fn lists(&self, conversation: &Conversation) -> bool {
        let last = self.last_visible(conversation);
        last > self.joined_seq && self.hidden_seq.is_none_or(|hidden| last > hidden)
    }
}

/// 一个成员能看到的序号范围：大于 `after`，并且不大于 `until`（为空表示到最新）。
/// `viewer` 是谁在看：他从自己这边删掉的那几条也不算（F6）。为空时不管删没删（管理员查看）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Visible {
    pub after: i64,
    pub until: Option<i64>,
    pub viewer: Option<UserId>,
}

impl Visible {
    /// 从头到最新、不管谁删了什么：管理员查看全部内容时用。
    pub const EVERYTHING: Visible = Visible {
        after: 0,
        until: None,
        viewer: None,
    };

    /// 序号在不在这个范围里。不看删没删：要看的话由存储去排除。
    pub fn contains(&self, seq: i64) -> bool {
        seq > self.after && self.until.is_none_or(|until| seq <= until)
    }
}

/// 事件里提到的一个人。昵称是事件发生时的：之后这个人查不到了，还能显示出当时的名字。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Party {
    pub id: UserId,
    pub nickname: String,
}

/// 一条的参数。事件用前四项，消息用后三项；都没有时整个为空。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MessageData {
    /// 事件是谁做的。
    pub actor: Option<Party>,
    /// 事件是对谁做的：被邀请的、被移出的、新的群主。
    pub targets: Vec<Party>,
    /// 改名事件里新的群名；为空表示去掉了群名。
    pub name: Option<String>,
    /// 撤回、编辑事件里被撤回、被编辑的那一条的序号。
    pub seq: Option<i64>,
    /// 语音消息的时长，毫秒。
    pub duration_ms: Option<i64>,
    /// 禁言事件里禁言到什么时候，UTC 毫秒。
    pub until: Option<i64>,
    /// 经过审批入群的事件里同意的人。
    pub approver: Option<Party>,
    /// 消息 @ 了谁。
    pub mentions: Vec<UserId>,
    /// 消息 @ 了所有人。
    pub mention_all: bool,
    /// 聊天记录（合并转发）的内容。
    pub record: Option<Record>,
    /// 通话记录里通话是怎么结束的；接通过的，时长在 `duration_ms` 里。
    pub call: Option<CallOutcome>,
    /// 通话记录：是视频通话。
    pub call_video: bool,
    /// 群通话的记录（F10）：一共有几个人参加过，包括发起人。一对一通话的记录里为空。
    pub call_joined: Option<u32>,
    /// 编辑事件里这一次修改之前的内容（F8）。只给管理员看。
    pub previous: Option<String>,
}

/// 一条聊天记录：转发那一刻的快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    /// 标题，例如"项目组的聊天记录"。转发的人那边生成。
    pub title: String,
    /// 按原来的先后。
    pub items: Vec<RecordItem>,
}

/// 聊天记录里的一条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordItem {
    /// 原发送人和他当时的昵称、头像。
    pub sender: Option<UserId>,
    pub sender_name: String,
    pub sender_avatar: Option<FileId>,
    pub kind: MessageKind,
    /// 文字、图片的说明；嵌套的聊天记录是它的标题。
    pub text: Option<String>,
    /// 图片、文件、语音：新登记的那一个文件。
    pub file: Option<FileId>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

impl Record {
    /// 里面全部的文件。
    pub fn files(&self) -> impl Iterator<Item = FileId> + '_ {
        self.items.iter().filter_map(|item| item.file)
    }
}

impl MessageData {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// 会话日志里的一条。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: MessageId,
    pub conversation: ConversationId,
    /// 在会话内的序号，从 1 开始，连续不重复。所有人都按它排列。
    pub seq: i64,
    /// 发送人。事件没有发送人。
    pub sender: Option<UserId>,
    /// 发送方的客户端生成的编号，用来去重：同一个人在同一个会话里重发时带的是同一个。
    pub client_id: Option<String>,
    pub kind: MessageKind,
    pub text: Option<String>,
    pub data: MessageData,
    /// 所附的文件：图片、文件、语音消息有。
    pub file: Option<FileId>,
    /// 这条消息是在回复哪一条：被引用消息的序号。
    pub reply_to: Option<i64>,
    /// 撤回的时间。没有撤回过为空。撤回只是做标记，内容仍然保存着。
    pub recalled_at: Option<i64>,
    /// 最后一次编辑的时间（F8）。没有编辑过为空。
    pub edited_at: Option<i64>,
    pub created_at: i64,
}

impl Message {
    pub fn is_recalled(&self) -> bool {
        self.recalled_at.is_some()
    }

    /// 这条消息带着的全部文件：所附的一个，加上聊天记录里的。
    pub fn all_files(&self) -> Vec<FileId> {
        let record = self.data.record.iter().flat_map(Record::files);
        self.file.into_iter().chain(record).collect()
    }

    /// 交给普通用户的样子：已撤回的消息不带任何内容；编辑事件不带修改之前的内容。
    pub fn redacted(mut self) -> Self {
        self.data.previous = None;
        if self.is_recalled() {
            self.text = None;
            self.file = None;
            self.reply_to = None;
            self.data = MessageData::default();
        }
        self
    }
}

/// 编辑一条消息时换上的内容（F8）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    /// 新的文字。图片的说明可以去掉，这时为空。
    pub text: Option<String>,
    /// 改完之后这条消息 @ 了谁。
    pub mentions: Vec<UserId>,
    pub mention_all: bool,
}

/// 要写入会话日志的一条。序号在写入时分配。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewMessage {
    pub id: MessageId,
    pub conversation: ConversationId,
    pub sender: Option<UserId>,
    pub client_id: Option<String>,
    pub kind: MessageKind,
    pub text: Option<String>,
    pub data: MessageData,
    pub file: Option<FileId>,
    pub reply_to: Option<i64>,
    pub created_at: i64,
}

impl NewMessage {
    /// 分配到序号之后的样子。
    pub fn stored(&self, seq: i64) -> Message {
        Message {
            id: self.id,
            conversation: self.conversation,
            seq,
            sender: self.sender,
            client_id: self.client_id.clone(),
            kind: self.kind,
            text: self.text.clone(),
            data: self.data.clone(),
            file: self.file,
            reply_to: self.reply_to,
            recalled_at: None,
            edited_at: None,
            created_at: self.created_at,
        }
    }
}

/// 写入的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appended {
    pub message: Message,
    /// 这个客户端消息编号以前写入过：`message` 是当时写入的那一条，这一次什么也没有写。
    pub duplicate: bool,
}

/// 要创建的群。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewGroup {
    pub id: ConversationId,
    pub name: Option<String>,
    pub owner: UserId,
    /// 全部成员，包括群主。
    pub members: Vec<UserId>,
    /// "建群"这条事件，是群里的第 1 条。
    pub event: NewMessage,
}

/// 对一个群的一次改动。每一次都连同对应的事件一起写入，要么都成功要么都不发生。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// 这些人加入。已经在群里的不算；加入之后在群的人数不能超过 `limit`。
    Join {
        users: Vec<UserId>,
        limit: u32,
    },
    /// 这个人离开。`hide` 为真时同时把会话从他的列表里移除（自己退群时）。
    Leave {
        user: UserId,
        hide: bool,
    },
    /// 换群主。新群主原来是管理员的，不再是管理员；被禁言着的，禁言解除。
    SetOwner(UserId),
    /// 禁言一名在群的成员到 `until`（UTC 毫秒），或者解除（为空）。
    Mute {
        user: UserId,
        until: Option<i64>,
    },
    /// 开启或关闭全员禁言。和现在一样时什么也不改。
    SetAllMuted(bool),
    /// 设为或取消群管理员。设为时群里的管理员不能超过 `limit` 名；设为管理员的人如果被禁言着，
    /// 禁言跟着解除。
    SetAdmin {
        user: UserId,
        admin: bool,
        limit: u32,
    },
    Rename(Option<String>),
    SetAvatar(FileId),
    Dissolve,
    /// 发布、修改或清空群公告（`text` 为空）。`by` 是群主，算他看过了；
    /// `remind` 为真时提醒其余在群的人，效果和 @ 所有人一样。
    SetNotice {
        text: Option<String>,
        by: UserId,
        remind: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Changed {
    /// 改好了，这是写入的那条事件。
    Done(Box<Message>),
    /// 加入之后人数会超过上限，什么也没有改。`room` 是还能加几个人。
    Full { room: u32 },
    /// 没有可以改的：要加入的人都已经在群里，或者要离开的人本来就不在。
    Nothing,
}

/// 会话列表里的一项，从某一个成员的角度看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listing {
    pub conversation: Conversation,
    /// 这个成员自己的状态。
    pub me: Member,
    /// 其他成员，包括已经离开的，按加入的先后。
    pub others: Vec<Member>,
    /// 他能看到的最新一条。
    pub last_message: Option<Message>,
    /// 别人发的、在他能看到的范围里、序号大于他的已读位置的消息有多少条。
    pub unread: u64,
}

/// 清理过期消息的结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Purged {
    /// 删掉了多少条。
    pub messages: u64,
    /// 被删掉的消息所附的文件：它们的内容也要删。
    pub files: Vec<FileId>,
}

/// 搜索的一处范围：一个会话里某个成员能看到的那一段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchScope {
    pub conversation: ConversationId,
    pub visible: Visible,
    /// 只要序号小于它的。翻下一页时用。
    pub before: Option<i64>,
}
