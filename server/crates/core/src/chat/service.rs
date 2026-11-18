//! 聊天的业务流程：会话列表、发消息、翻历史、已读位置，以及群和它的成员。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::error::ChatError;
use super::model::{
    Change, Changed, Conversation, ConversationKind, Edit, JoinRequest, JoinRequestStatus, Listing,
    Member, Message, MessageData, MessageKind, NewGroup, NewMessage, Party, Record, RecordItem,
    SearchScope, Visible,
};
use super::store::ChatStore;
use crate::account::model::{FilePurpose, StoredFile, User};
use crate::account::store::{FileStore, UserStore};
use crate::call::{Call, CallOutcome, GroupCall};
use crate::clock::Clock;
use crate::contact::service::relation_between;
use crate::contact::store::ContactStore;
use crate::contact::{Relation, UserCard};
use crate::ids::{ConversationId, FileId, JoinRequestId, MessageId, UserId};
use crate::limits::Limits;
use crate::settings::SettingsStore;

pub const MESSAGE_MAX_CHARS: usize = 4000;
/// 一次取多少条消息：默认值和上限。
pub const HISTORY_PAGE_SIZE: u32 = 50;
pub const HISTORY_PAGE_SIZE_MAX: u32 = 100;
/// 一次最多删几条（F6）。
pub const DELETE_MAX_MESSAGES: usize = 100;
pub const GROUP_NAME_MAX_CHARS: usize = 30;
/// 群公告最多多少个字。
pub const NOTICE_MAX_CHARS: usize = 1000;
/// 群人数上限：管理员没有设置过时的默认值，包括群主在内。
pub const GROUP_MAX_MEMBERS_DEFAULT: u32 = 10;
/// 系统设置里保存群人数上限的那一项。
pub const GROUP_MAX_MEMBERS_SETTING: &str = "group_max_members";
const CLIENT_ID_MAX_CHARS: usize = 36;
/// 引用一条消息时，摘要里最多带原文的这么多个字。
pub const QUOTE_MAX_CHARS: usize = 100;
/// 搜索的关键词最多多少个字。
pub const SEARCH_QUERY_MAX_CHARS: usize = 50;
/// 在全部会话里搜索时最多交出多少条，从新到旧。
pub const SEARCH_ALL_LIMIT: usize = 300;
/// 在一个会话里搜索时一次取多少条：默认值和上限。
pub const SEARCH_PAGE_SIZE: u32 = 20;
pub const SEARCH_PAGE_SIZE_MAX: u32 = 50;
/// 语音的时长由客户端量出，和服务端的上限之间允许差这么多。
const VOICE_SLACK_MS: i64 = 1000;
/// 禁言可以选的时长，分钟：10 分钟、1 小时、12 小时、1 天。不选就是直到解除。
pub const MUTE_MINUTES: [u32; 4] = [10, 60, 720, 1440];
/// "直到解除"记成的时间：公元 9999 年底。
pub const MUTED_FOREVER: i64 = 253_402_300_799_999;
/// 入群申请多久没有处理就算过期：7 天。
pub const JOIN_REQUEST_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// 群内昵称最长多少个字。
pub const GROUP_NICKNAME_MAX_CHARS: usize = 20;
/// 一个群最多几名管理员。
pub const GROUP_MAX_ADMINS: u32 = 3;
/// 一条聊天记录最多放多少条。
pub const RECORD_MAX_ITEMS: usize = 50;
/// 聊天记录的标题最长多少个字。
pub const RECORD_TITLE_MAX_CHARS: usize = 100;
/// 没有起名的群用成员的名称来显示，取最前面的这么多个。
const NAME_HINT_MEMBERS: usize = 4;

pub struct ChatServiceDeps {
    pub users: Arc<dyn UserStore>,
    pub contacts: Arc<dyn ContactStore>,
    pub chat: Arc<dyn ChatStore>,
    pub files: Arc<dyn FileStore>,
    pub settings: Arc<dyn SettingsStore>,
    pub clock: Arc<dyn Clock>,
}

/// 一个会话在我这边的样子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationInfo {
    pub conversation: Conversation,
    /// 我能看到的最新一条的序号。离开了的群里，它停在离开的那一刻。
    pub last_seq: i64,
    /// 我的已读位置。
    pub read_seq: i64,
    /// 单聊的对方。
    pub peer: Option<Peer>,
    /// 群的情况。
    pub group: Option<GroupInfo>,
    pub last_message: Option<Message>,
    /// 群里最新一条消息是谁发的。
    pub last_sender_name: Option<String>,
    /// 最新一条消息所附的文件。
    pub last_file: Option<StoredFile>,
    pub unread: u64,
    /// 我把这个会话设成了免打扰。
    pub muted: bool,
    /// 我把这个会话置顶的时间。没有置顶为空。
    pub pinned_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub card: UserCard,
    /// 对方就是我自己：这是和自己的对话。
    pub is_self: bool,
    /// 我给他起的备注名。
    pub remark: Option<String>,
    /// 现在还是不是好友。不是好友时不能再发消息，历史仍然可以看。
    pub is_friend: bool,
    /// 他的已读位置：我发的消息里，序号不大于它的他都看过了。
    pub read_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupInfo {
    /// 最早加入的几名成员的昵称。群没有起名时用它们来显示。
    pub name_hint: Vec<String>,
    /// 现在在群的人数。
    pub member_count: u32,
    /// 人数上限。
    pub max_members: u32,
    /// 我已经不在这个群里了。
    pub left: bool,
    /// 有 @ 我的消息我还没看。
    pub mentioned: bool,
    /// 当前的群公告。已经离开的人看不到。
    pub notice: Option<NoticeInfo>,
    /// 有公告，并且是我还没看过的那一次。
    pub notice_unseen: bool,
    /// 现在的管理员。
    pub admins: Vec<UserId>,
    /// 全员禁言开着。
    pub all_muted: bool,
    /// 入群审批开着。
    pub join_approval: bool,
    /// 等着处理的入群申请有几条。只有群主和管理员看得到，其他人是 0。
    pub pending_requests: u32,
    /// 我被禁言到什么时候。没有禁言、或者已经到时间了为空。
    pub muted_until: Option<i64>,
}

/// 一则群公告，带着发布人现在的昵称。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeInfo {
    pub text: String,
    pub by: UserId,
    pub by_name: Option<String>,
    pub at: i64,
    /// 发布它的那条事件的序号。
    pub seq: i64,
}

/// 群里的一个成员，从我的角度看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberInfo {
    pub card: UserCard,
    /// 我给他起的备注名。
    pub remark: Option<String>,
    pub is_friend: bool,
    pub is_owner: bool,
    pub is_admin: bool,
    /// 他在这个群里的昵称。
    pub group_nickname: Option<String>,
    /// 被禁言到什么时候。没有禁言、或者已经到时间了为空。
    pub muted_until: Option<i64>,
    /// 现在还在不在群里。离开的人也列出来：显示他以前发的消息时要用到他的名称和头像。
    pub active: bool,
    pub joined_seq: i64,
    pub read_seq: i64,
}

/// 邀请的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invited {
    /// 直接加进来了；要加的人都已经在群里时是空。
    Joined(Option<Box<Posted>>),
    /// 开着入群审批、邀请的人是普通成员：生成了入群申请，等群主或管理员处理。
    /// `requests` 是这一次新生成的（已经有一条待处理的不会再生成）；`managers` 要通知。
    Requested {
        requests: Vec<JoinRequest>,
        managers: Vec<UserId>,
    },
}

impl Invited {
    /// 直接加进来时的那条事件。
    pub fn joined(self) -> Option<Posted> {
        match self {
            Self::Joined(posted) => posted.map(|posted| *posted),
            Self::Requested { .. } => None,
        }
    }
}

/// 一条入群申请，带着邀请人、被邀请人的资料和处理人的名字。状态已经按现在的时间算好（会算出"过期"）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinRequestInfo {
    pub request: JoinRequest,
    pub inviter: UserCard,
    pub invitee: UserCard,
    pub handled_by_name: Option<String>,
}

/// 处理一条入群申请的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinHandled {
    /// 同意并且加进来了：那条入群事件。
    pub posted: Option<Posted>,
    /// 申请列表变了，要告诉的人：群主、管理员和邀请人。
    pub notify: Vec<UserId>,
}

/// 同一个群的成员的资料。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberProfile {
    pub card: UserCard,
    pub signature: String,
    pub remark: Option<String>,
    pub relation: Relation,
}

/// 编辑一条消息时填的内容（F8）。
#[derive(Debug, Clone, Copy)]
pub struct EditDraft<'a> {
    pub text: &'a str,
    pub mentions: &'a [UserId],
    pub mention_all: bool,
}

/// 写入会话日志的一条，以及要通知的人。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Posted {
    pub message: Message,
    /// 这是一次重发：消息以前已经写入过，这一次什么也没有写。
    pub duplicate: bool,
    /// 群消息的发送人的昵称。
    pub sender_name: Option<String>,
    /// 要通知的人：会话里现在的全部成员，包括发送人自己（他在别处的登录也要收到）；
    /// 有人离开时也包括刚离开的那个人。
    pub members: Vec<UserId>,
    /// 显示这一条还要用到的东西：所附的文件、被引用的消息。
    pub extras: Extras,
    /// 要通知的人里，看不到被引用的那条消息的人（在那之后才入群）：给他们的不带引用的内容。
    pub quote_hidden_from: Vec<UserId>,
}

/// 显示一批消息还要用到的东西。消息本身只带着编号和序号，内容在这里。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extras {
    /// 消息所附的文件。
    pub files: HashMap<FileId, StoredFile>,
    /// 被引用的消息，按它们的序号。
    pub quotes: HashMap<i64, Quote>,
    /// 这批消息里我播放过的语音。
    pub played: HashSet<MessageId>,
}

impl Extras {
    /// 给看不到被引用消息的人的那一份。
    pub fn without_quotes(&self) -> Self {
        Self {
            quotes: self
                .quotes
                .keys()
                .map(|seq| (*seq, Quote::Unavailable))
                .collect(),
            ..self.clone()
        }
    }
}

/// 回复里被引用的那条消息，从看的人的角度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Quote {
    Shown {
        sender: Option<UserId>,
        sender_name: Option<String>,
        kind: MessageKind,
        /// 文本消息的开头一段。
        text: Option<String>,
        /// 文件消息的文件名。
        file_name: Option<String>,
    },
    /// 原消息已经撤回。
    Recalled,
    /// 看的人看不到原消息：它在他入群之前。
    Unavailable,
}

/// 消息所附的文件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Attached {
    pub file: FileId,
    /// 给了时长就是一条语音；没有给的，是图片就按图片发，其余按文件发。
    pub voice_duration_ms: Option<i64>,
}

/// 要发的一条消息。
#[derive(Debug, Clone, Copy)]
pub struct Draft<'a> {
    /// 发送方生成的编号：没等到结果而重发时带的是同一个。
    pub client_id: &'a str,
    pub text: &'a str,
    /// @ 了谁。只在群里有用。
    pub mentions: &'a [UserId],
    /// @ 所有人。只有群主可以。
    pub mention_all: bool,
    /// 所附的文件。有它时这是一条图片、文件或语音消息；图片可以用 `text` 带一段文字说明，文件和语音不能带文字。
    pub attachment: Option<Attached>,
    /// 回复的是哪一条：被引用消息的序号。
    pub reply_to: Option<i64>,
    /// 转发：内容从这一条复制过来。有它时其余的内容都不用。
    pub forward: Option<Forwarded>,
    /// 合并转发：把这几条做成一条聊天记录。有它时其余的内容都不用。
    pub merge: Option<Merged<'a>>,
}

/// 合并转发的是哪几条。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Merged<'a> {
    pub conversation: ConversationId,
    pub seqs: &'a [i64],
    /// 转发的人那边生成的标题。
    pub title: &'a str,
}

/// 转发的是哪一条。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Forwarded {
    pub conversation: ConversationId,
    pub seq: i64,
}

impl<'a> Draft<'a> {
    /// 一条不 @ 任何人、不带文件、不引用别的消息的文本消息。
    pub fn text(client_id: &'a str, text: &'a str) -> Self {
        Self {
            client_id,
            text,
            mentions: &[],
            mention_all: false,
            attachment: None,
            reply_to: None,
            forward: None,
            merge: None,
        }
    }
}

/// 发消息的目标会话，校验过了：我能在里面发。
struct Target<'a> {
    conversation: &'a Conversation,
    member: &'a Member,
    /// 现在在会话里的人：要通知的人。
    present: Vec<UserId>,
    /// 群消息的发送人的昵称。
    sender_name: Option<String>,
}

/// 翻看历史的方向：某个序号之前的一段，或者之后的一段。都不指定时取最新的一段。
#[derive(Debug, Clone, Copy, Default)]
pub struct HistoryQuery {
    pub before: Option<i64>,
    pub after: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// 按序号从小到大。
    pub messages: Vec<Message>,
    /// 这个方向上还有没有更多。
    pub has_more: bool,
    /// 群消息的发送人的昵称。
    pub sender_names: HashMap<UserId, String>,
    pub extras: Extras,
}

/// 搜索的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    /// 从新到旧。
    pub hits: Vec<Message>,
    /// 还有更多没有交出来。
    pub has_more: bool,
    /// 发送人的昵称。
    pub sender_names: HashMap<UserId, String>,
    pub extras: Extras,
}

/// 语音播放的记录结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Played {
    pub seq: i64,
    /// 这一次是第一次播放。
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadUpdate {
    /// 现在的已读位置。
    pub read_seq: i64,
    /// 这一次是否前进了。
    pub changed: bool,
    pub members: Vec<UserId>,
}

/// 群通话结束后写下的通话记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCallRecord {
    pub posted: Posted,
    /// 参加了通话、之前又没有别的未读的人：这一条直接算他们读过了。每一项是谁、读到第几条。
    pub read_by: Vec<(UserId, i64)>,
}

/// 清空聊天记录的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cleared {
    /// 清空到了第几条。
    pub seq: i64,
    /// 已读位置跟着挪了：要告诉会话里的人（对方据此显示"已读"）。
    pub read: ReadUpdate,
}

/// 一个会话在管理员那里的样子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Overseen {
    pub conversation: Conversation,
    /// 单聊的两个人；群里最早加入的几名成员，群没有起名时用他们的昵称来显示。
    pub people: Vec<UserCard>,
    /// 群主。
    pub owner: Option<UserCard>,
    /// 现在在会话里的人数。
    pub member_count: u32,
    /// 最新一条的时间。还没有内容、或者内容都过了保留期限时为空。
    pub last_at: Option<i64>,
}

impl Overseen {
    /// 这个会话叫什么：群名；没有起名的群和单聊用其中几个人的昵称。写进操作记录里。
    pub fn label(&self) -> String {
        match &self.conversation.name {
            Some(name) => name.clone(),
            None => {
                let names: Vec<&str> = self.people.iter().map(|p| p.nickname.as_str()).collect();
                names.join(" / ")
            }
        }
    }
}

/// 会话的一个成员，管理员看到的样子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverseenMember {
    pub card: UserCard,
    pub is_owner: bool,
    /// 现在还在不在会话里。
    pub active: bool,
}

pub struct ChatService {
    deps: ChatServiceDeps,
}

impl ChatService {
    pub fn new(deps: ChatServiceDeps) -> Self {
        Self { deps }
    }

    // ---------- 会话 ----------

    /// 我的会话列表：置顶的在前，各自按最新有动静的先后（F6 Q2）。
    pub async fn list(&self, me: &User) -> Result<Vec<ConversationInfo>, ChatError> {
        let listings = self.deps.chat.list_for_user(me.id).await?;
        let mut infos = self.describe(me, listings).await?;
        infos.sort_by_key(|info| {
            let latest = info
                .last_message
                .as_ref()
                .map_or(info.conversation.created_at, |message| message.created_at);
            std::cmp::Reverse((info.pinned_at.is_some(), latest, info.conversation.id))
        });
        Ok(infos)
    }

    /// 我现在所在的全部群，不管它们在不在我的会话列表里。
    pub async fn groups(&self, me: &User) -> Result<Vec<ConversationInfo>, ChatError> {
        let mut listings = Vec::new();
        for group in self.deps.chat.list_groups(me.id).await? {
            if let Some(member) = self.deps.chat.find_member(group.id, me.id).await? {
                listings.push(self.listing(me, group, member).await?);
            }
        }
        self.describe(me, listings).await
    }

    /// 一个会话在我这边的样子。它不必在我的列表里：还没有内容的、被我移除了的也能取到。
    pub async fn conversation(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<ConversationInfo, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let listing = self.listing(me, conversation, member).await?;
        let mut infos = self.describe(me, vec![listing]).await?;
        infos.pop().ok_or(ChatError::ConversationNotFound)
    }

    /// 一个会话从我的角度看的原始数据。在列表里的直接用列表里的那一项，未读数已经算好了。
    async fn listing(
        &self,
        me: &User,
        conversation: Conversation,
        member: Member,
    ) -> Result<Listing, ChatError> {
        let chat = &self.deps.chat;
        let listed = chat.list_for_user(me.id).await?;
        if let Some(listing) = listed
            .into_iter()
            .find(|listing| listing.conversation.id == conversation.id)
        {
            return Ok(listing);
        }
        Ok(Listing {
            others: chat
                .list_members(conversation.id)
                .await?
                .into_iter()
                .filter(|other| other.user != me.id)
                .collect(),
            last_message: chat
                .list_before(conversation.id, member.visible(), None, 1)
                .await?
                .pop(),
            unread: 0,
            me: member,
            conversation,
        })
    }

    /// 给会话补上显示要用的东西：对方是谁、群里有谁、最新一条是谁发的。
    async fn describe(
        &self,
        me: &User,
        listings: Vec<Listing>,
    ) -> Result<Vec<ConversationInfo>, ChatError> {
        // 要用到名称的人：单聊的对方，群里最早加入的几个人，最新一条消息的发送人
        let mut wanted: HashSet<UserId> = HashSet::new();
        for listing in &listings {
            match listing.conversation.kind {
                ConversationKind::Direct => wanted.extend(listing.others.iter().map(|m| m.user)),
                ConversationKind::Group => {
                    wanted.extend(hinted(listing).iter().map(|member| member.user));
                    wanted.extend(listing.last_message.as_ref().and_then(|m| m.sender));
                    wanted.extend(listing.conversation.notice.as_ref().map(|n| n.by));
                }
            }
        }
        let wanted: Vec<UserId> = wanted.into_iter().collect();
        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&wanted)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        let remarks: HashMap<UserId, Option<String>> = self
            .deps
            .contacts
            .list_friendships(me.id)
            .await?
            .into_iter()
            .map(|friendship| (friendship.friend, friendship.remark))
            .collect();
        let max_members = self.max_members().await?;
        let now = self.deps.clock.now_ms();
        // 我管理的群里等着处理的入群申请
        let cutoff = now - JOIN_REQUEST_TTL_MS;
        let mut pending: HashMap<ConversationId, u32> = HashMap::new();
        for listing in &listings {
            let conversation = &listing.conversation;
            let managed = conversation.kind == ConversationKind::Group
                && !conversation.dissolved
                && manages(conversation, &listing.me);
            if !managed {
                continue;
            }
            let requests = self.deps.chat.list_join_requests(conversation.id).await?;
            let count = requests
                .iter()
                .filter(|request| request.status_at(cutoff) == JoinRequestStatus::Pending)
                .count();
            if count > 0 {
                pending.insert(conversation.id, count as u32);
            }
        }
        let last_files: Vec<FileId> = listings
            .iter()
            .filter_map(|listing| listing.last_message.as_ref())
            .filter(|message| !message.is_recalled())
            .filter_map(|message| message.file)
            .collect();
        let files = self.files_by_id(&last_files).await?;

        Ok(listings
            .into_iter()
            .map(|listing| {
                let is_group = listing.conversation.kind == ConversationKind::Group;
                let peer = if is_group {
                    None
                } else if let Some(other) = listing.others.first() {
                    users.get(&other.user).map(|user| {
                        let friendship = remarks.get(&other.user);
                        Peer {
                            card: UserCard::from(user),
                            is_self: false,
                            remark: friendship.cloned().flatten(),
                            is_friend: friendship.is_some(),
                            read_seq: other.read_seq,
                        }
                    })
                } else {
                    // 单聊里没有别人：是和自己的对话
                    Some(Peer {
                        card: UserCard::from(me),
                        is_self: true,
                        remark: None,
                        is_friend: true,
                        read_seq: listing.me.read_seq,
                    })
                };
                let group = is_group.then(|| GroupInfo {
                    name_hint: hinted(&listing)
                        .iter()
                        .filter_map(|member| users.get(&member.user))
                        .map(|user| user.nickname.clone())
                        .collect(),
                    member_count: std::iter::once(&listing.me)
                        .chain(&listing.others)
                        .filter(|member| member.is_active())
                        .count() as u32,
                    max_members,
                    left: !listing.me.is_active(),
                    mentioned: listing.me.mentioned_seq > listing.me.read_seq,
                    notice: listing
                        .conversation
                        .notice
                        .as_ref()
                        .filter(|_| listing.me.is_active())
                        .map(|notice| NoticeInfo {
                            text: notice.text.clone(),
                            by: notice.by,
                            by_name: users.get(&notice.by).map(|user| user.nickname.clone()),
                            at: notice.at,
                            seq: notice.seq,
                        }),
                    notice_unseen: listing.me.is_active()
                        && listing
                            .conversation
                            .notice
                            .as_ref()
                            .is_some_and(|notice| notice.seq > listing.me.notice_seen_seq),
                    admins: std::iter::once(&listing.me)
                        .chain(&listing.others)
                        .filter(|member| member.is_active() && member.admin)
                        .map(|member| member.user)
                        .collect(),
                    all_muted: listing.conversation.all_muted,
                    muted_until: muted_until(&listing.me, now),
                    join_approval: listing.conversation.join_approval,
                    pending_requests: pending.get(&listing.conversation.id).copied().unwrap_or(0),
                });
                // 群里的名字：有群内昵称用群内昵称
                let last_sender_name = listing
                    .last_message
                    .as_ref()
                    .filter(|_| is_group)
                    .and_then(|message| message.sender)
                    .and_then(|sender| {
                        let member = std::iter::once(&listing.me)
                            .chain(&listing.others)
                            .find(|member| member.user == sender);
                        member
                            .and_then(|member| member.nickname.clone())
                            .or_else(|| users.get(&sender).map(|user| user.nickname.clone()))
                    });
                let last_message = listing.last_message.map(Message::redacted);
                let last_file = last_message
                    .as_ref()
                    .and_then(|message| message.file)
                    .and_then(|file| files.get(&file))
                    .cloned();
                ConversationInfo {
                    last_seq: listing.me.last_visible(&listing.conversation),
                    read_seq: listing.me.read_seq,
                    peer,
                    group,
                    last_message,
                    last_sender_name,
                    last_file,
                    unread: listing.unread,
                    muted: listing.me.muted,
                    pinned_at: listing.me.pinned_at,
                    conversation: listing.conversation,
                }
            })
            .collect())
    }

    /// 取得我和一个好友的单聊会话，没有就创建。
    /// 对方是我自己时，是和自己的对话：只有我一个成员，不用是谁的好友，随时可以用。
    pub async fn open_direct(
        &self,
        me: &User,
        friend: UserId,
    ) -> Result<ConversationInfo, ChatError> {
        if friend != me.id && !self.are_friends(me.id, friend).await? {
            return Err(ChatError::NotFriends);
        }
        let conversation = self.direct(me.id, friend).await?;
        self.conversation(me, conversation.id).await
    }

    /// 两个人刚成为好友：在他们的会话里写入一条"已经成为好友"的事件，
    /// 会话因此出现在双方的列表里。
    pub async fn greet_new_friends(&self, a: UserId, b: UserId) -> Result<Posted, ChatError> {
        let conversation = self.direct(a, b).await?;
        let greeting = self.event(
            conversation.id,
            MessageKind::Friends,
            MessageData::default(),
        );
        let appended = self.deps.chat.append(&greeting).await?;
        Ok(posted(appended.message, vec![a, b]))
    }

    async fn direct(&self, a: UserId, b: UserId) -> Result<Conversation, ChatError> {
        let now = self.deps.clock.now_ms();
        Ok(self
            .deps
            .chat
            .open_direct(ConversationId::new(), a, b, now)
            .await?)
    }

    // ---------- 群 ----------

    /// 拉几个好友建一个群，我是群主。
    pub async fn create_group(
        &self,
        me: &User,
        name: &str,
        members: &[UserId],
    ) -> Result<Posted, ChatError> {
        let others = distinct(members, me.id);
        if others.len() < 2 {
            return Err(ChatError::GroupTooSmall);
        }
        let name = clean_group_name(name)?;
        let limit = self.max_members().await?;
        if others.len() as u32 + 1 > limit {
            return Err(ChatError::GroupFull {
                room: limit.saturating_sub(1),
            });
        }
        let invited = self.friends_of(me, &others).await?;

        let id = ConversationId::new();
        let mut everyone = vec![me.id];
        everyone.extend(&others);
        let event = self.event(
            id,
            MessageKind::GroupCreated,
            MessageData {
                actor: Some(party(me)),
                targets: invited,
                ..MessageData::default()
            },
        );
        let (_, message) = self
            .deps
            .chat
            .create_group(&NewGroup {
                id,
                name,
                owner: me.id,
                members: everyone.clone(),
                event,
            })
            .await?;
        Ok(posted(message, everyone))
    }

    /// 邀请几个好友入群。已经在群里的跳过；一个要加的都没有时什么也不做。
    /// 开着入群审批、我又是普通成员时，不直接加进来，而是给每个人生成一条入群申请。
    pub async fn invite(
        &self,
        me: &User,
        conversation: ConversationId,
        users: &[UserId],
    ) -> Result<Invited, ChatError> {
        let (conversation, member) = self.active_in_open_group(me, conversation).await?;
        let present = self.active_members(conversation.id).await?;
        let newcomers: Vec<UserId> = distinct(users, me.id)
            .into_iter()
            .filter(|user| !present.contains(user))
            .collect();
        if newcomers.is_empty() {
            return Ok(Invited::Joined(None));
        }
        let invited = self.friends_of(me, &newcomers).await?;
        if conversation.join_approval && !manages(&conversation, &member) {
            let now = self.deps.clock.now_ms();
            let mut requests = Vec::new();
            for invitee in newcomers {
                let request = JoinRequest {
                    id: JoinRequestId::new(),
                    conversation: conversation.id,
                    inviter: me.id,
                    invitee,
                    status: JoinRequestStatus::Pending,
                    created_at: now,
                    handled_by: None,
                    handled_at: None,
                };
                let added = self
                    .deps
                    .chat
                    .add_join_request(&request, now - JOIN_REQUEST_TTL_MS)
                    .await?;
                if added {
                    requests.push(request);
                }
            }
            let managers = self.managers(&conversation).await?;
            return Ok(Invited::Requested { requests, managers });
        }
        let change = Change::Join {
            users: newcomers,
            limit: self.max_members().await?,
        };
        let data = MessageData {
            actor: Some(party(me)),
            targets: invited,
            ..MessageData::default()
        };
        match self
            .change(conversation.id, MessageKind::MemberJoined, data, change)
            .await?
        {
            Some(message) => {
                let posted = self.to_active_members(message).await?;
                Ok(Invited::Joined(Some(Box::new(posted))))
            }
            None => Ok(Invited::Joined(None)),
        }
    }

    /// 群主或管理员开关入群审批。不在群里留提示。返回改了没有。
    pub async fn set_join_approval(
        &self,
        me: &User,
        conversation: ConversationId,
        on: bool,
    ) -> Result<bool, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        Ok(self
            .deps
            .chat
            .set_join_approval(conversation.id, on)
            .await?)
    }

    /// 一个群的入群申请，新的在前：群主和管理员看全部，其他人只看自己发出的。
    pub async fn join_requests(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Vec<JoinRequestInfo>, ChatError> {
        let (conversation, member) = self.group_membership(me, conversation).await?;
        if !member.is_active() {
            return Err(ChatError::LeftGroup);
        }
        let all = manages(&conversation, &member);
        let requests: Vec<JoinRequest> = self
            .deps
            .chat
            .list_join_requests(conversation.id)
            .await?
            .into_iter()
            .filter(|request| all || request.inviter == me.id)
            .collect();
        let cutoff = self.deps.clock.now_ms() - JOIN_REQUEST_TTL_MS;
        let ids: HashSet<UserId> = requests
            .iter()
            .flat_map(|request| {
                [
                    Some(request.inviter),
                    Some(request.invitee),
                    request.handled_by,
                ]
            })
            .flatten()
            .collect();
        let ids: Vec<UserId> = ids.into_iter().collect();
        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&ids)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        Ok(requests
            .into_iter()
            .filter_map(|request| {
                let inviter = UserCard::from(users.get(&request.inviter)?);
                let invitee = UserCard::from(users.get(&request.invitee)?);
                let handled_by_name = request
                    .handled_by
                    .and_then(|id| users.get(&id))
                    .map(|user| user.nickname.clone());
                let status = request.status_at(cutoff);
                Some(JoinRequestInfo {
                    request: JoinRequest { status, ..request },
                    inviter,
                    invitee,
                    handled_by_name,
                })
            })
            .collect())
    }

    /// 群主或管理员同意或拒绝一条入群申请。同意时照"加入"的流程把人加进来，人数上限在这时检查；
    /// 群里的提示写明是谁邀请的、谁同意的。已经处理过、或者已经过期的不能再处理。
    pub async fn handle_join_request(
        &self,
        me: &User,
        conversation: ConversationId,
        id: JoinRequestId,
        approve: bool,
    ) -> Result<JoinHandled, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let request = self.deps.chat.find_join_request(id).await?;
        let request = request
            .filter(|request| request.conversation == conversation.id)
            .ok_or(ChatError::JoinRequestNotFound)?;
        let now = self.deps.clock.now_ms();
        let cutoff = now - JOIN_REQUEST_TTL_MS;
        let status = if approve {
            JoinRequestStatus::Approved
        } else {
            JoinRequestStatus::Rejected
        };
        // 先占下这条申请：两处同时处理时只有一处成功
        let settled = self
            .deps
            .chat
            .settle_join_request(id, status, me.id, now, cutoff)
            .await?;
        if !settled {
            return Err(ChatError::JoinRequestHandled);
        }
        let mut notify = self.managers(&conversation).await?;
        if !notify.contains(&request.inviter) {
            notify.push(request.inviter);
        }
        if !approve {
            return Ok(JoinHandled {
                posted: None,
                notify,
            });
        }

        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&[request.inviter, request.invitee])
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        let invitee = users
            .get(&request.invitee)
            .ok_or(ChatError::JoinRequestNotFound)?;
        let data = MessageData {
            actor: users.get(&request.inviter).map(party),
            targets: vec![party(invitee)],
            approver: Some(party(me)),
            ..MessageData::default()
        };
        let change = Change::Join {
            users: vec![request.invitee],
            limit: self.max_members().await?,
        };
        let event = self.event(conversation.id, MessageKind::MemberJoined, data);
        let posted = match self.deps.chat.apply(&event, &change).await? {
            Changed::Done(message) => Some(self.to_active_members(*message).await?),
            // 他已经在群里了（例如别人又直接拉了他）：申请照样算同意了
            Changed::Nothing => None,
            Changed::Full { room } => {
                self.deps.chat.reopen_join_request(id).await?;
                return Err(ChatError::GroupFull { room });
            }
        };
        Ok(JoinHandled { posted, notify })
    }

    /// 退出一个群。群主要先转让或解散；群里只剩群主一个人时可以直接退。
    pub async fn leave(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Posted, ChatError> {
        let (conversation, member) = self.group_membership(me, conversation).await?;
        if !member.is_active() {
            return Err(ChatError::LeftGroup);
        }
        let present = self.active_members(conversation.id).await?;
        let owns = conversation.owner == Some(me.id) && !conversation.dissolved;
        if owns && present.len() > 1 {
            return Err(ChatError::OwnerCannotLeave);
        }
        let data = MessageData {
            actor: Some(party(me)),
            ..MessageData::default()
        };
        let change = Change::Leave {
            user: me.id,
            hide: true,
        };
        let message = self
            .change(conversation.id, MessageKind::MemberLeft, data, change)
            .await?
            .ok_or(ChatError::LeftGroup)?;
        // 退群的人自己在别处的登录也要知道
        Ok(posted(message, present))
    }

    /// 群主或管理员把一个成员移出群。管理员只能移出普通成员。
    pub async fn remove_member(
        &self,
        me: &User,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        if user == me.id {
            return Err(ChatError::Invalid("cannot remove yourself"));
        }
        self.may_manage(me, &conversation, user).await?;
        let present = self.active_members(conversation.id).await?;
        let removed = self.member_party(conversation.id, user).await?;
        let data = MessageData {
            actor: Some(party(me)),
            targets: vec![removed],
            ..MessageData::default()
        };
        let change = Change::Leave { user, hide: false };
        let message = self
            .change(conversation.id, MessageKind::MemberRemoved, data, change)
            .await?
            .ok_or(ChatError::NotMember)?;
        // 被移出的人也收到这一条：他据此知道自己被移出了
        Ok(posted(message, present))
    }

    /// 群主把群主的身份转让给另一名成员。
    pub async fn transfer(
        &self,
        me: &User,
        conversation: ConversationId,
        to: UserId,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.owner_of_open_group(me, conversation).await?;
        if to == me.id {
            return Err(ChatError::Invalid("already the owner"));
        }
        let successor = self.member_party(conversation.id, to).await?;
        let data = MessageData {
            actor: Some(party(me)),
            targets: vec![successor],
            ..MessageData::default()
        };
        self.announce(
            conversation.id,
            MessageKind::OwnerChanged,
            data,
            Change::SetOwner(to),
        )
        .await
    }

    /// 群主或管理员修改群名称；留空则去掉群名，回到用成员名称显示。
    pub async fn rename(
        &self,
        me: &User,
        conversation: ConversationId,
        name: &str,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let name = clean_group_name(name)?;
        let data = MessageData {
            actor: Some(party(me)),
            name: name.clone(),
            ..MessageData::default()
        };
        self.announce(
            conversation.id,
            MessageKind::Renamed,
            data,
            Change::Rename(name),
        )
        .await
    }

    /// 发布、修改或清空群公告（`text` 只有空白就是清空）。群主和管理员可以。
    /// 发布和修改时提醒全体成员，效果和 @ 所有人一样。和现在的一样时什么也不做，返回空。
    pub async fn set_notice(
        &self,
        me: &User,
        conversation: ConversationId,
        text: &str,
    ) -> Result<Option<Posted>, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let text = clean_notice(text)?;
        if conversation.notice.as_ref().map(|notice| &notice.text) == text.as_ref() {
            return Ok(None);
        }
        let data = MessageData {
            actor: Some(party(me)),
            ..MessageData::default()
        };
        let mut event = self.event(conversation.id, MessageKind::NoticeChanged, data);
        // 事件里带着这一次的全文：翻聊天记录能看到以前的公告
        event.text = text.clone();
        let change = Change::SetNotice {
            remind: text.is_some(),
            text,
            by: me.id,
        };
        match self.deps.chat.apply(&event, &change).await? {
            Changed::Done(message) => Ok(Some(self.to_active_members(*message).await?)),
            _ => Err(ChatError::ConversationNotFound),
        }
    }

    /// 我看过了现在的群公告：会话顶部的公告条不再显示。返回记下的序号；
    /// 没有公告，或者本来就看过了，返回空。
    pub async fn mark_notice_seen(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Option<i64>, ChatError> {
        // 解散了的群里公告条照样可以关掉
        let (conversation, member) = self.group_membership(me, conversation).await?;
        if !member.is_active() {
            return Err(ChatError::LeftGroup);
        }
        let Some(notice) = conversation.notice else {
            return Ok(None);
        };
        let moved = self
            .deps
            .chat
            .mark_notice_seen(conversation.id, me.id, notice.seq)
            .await?;
        Ok(moved.then_some(notice.seq))
    }

    /// 我是不是这个群的群主或管理员、群有没有解散。换群头像之前先问一下，免得白存一张图。
    pub async fn require_manager(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(), ChatError> {
        self.manager_of_open_group(me, conversation)
            .await
            .map(|_| ())
    }

    /// 群主或管理员更换群头像。`avatar` 是已经处理并保存好的图片。
    pub async fn set_group_avatar(
        &self,
        me: &User,
        conversation: ConversationId,
        avatar: FileId,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let data = MessageData {
            actor: Some(party(me)),
            ..MessageData::default()
        };
        self.announce(
            conversation.id,
            MessageKind::AvatarChanged,
            data,
            Change::SetAvatar(avatar),
        )
        .await
    }

    /// 群主解散群。之后谁都不能再发消息，历史保留。
    pub async fn dissolve(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.owner_of_open_group(me, conversation).await?;
        let data = MessageData {
            actor: Some(party(me)),
            ..MessageData::default()
        };
        self.announce(
            conversation.id,
            MessageKind::Dissolved,
            data,
            Change::Dissolve,
        )
        .await
    }

    /// 群主把一名成员设为管理员，或者取消。最多 3 名。本来就是（或者本来就不是）时什么也不做，返回空。
    pub async fn set_admin(
        &self,
        me: &User,
        conversation: ConversationId,
        user: UserId,
        admin: bool,
    ) -> Result<Option<Posted>, ChatError> {
        let (conversation, _) = self.owner_of_open_group(me, conversation).await?;
        if user == me.id {
            return Err(ChatError::Invalid("the owner cannot be an admin"));
        }
        let target = self.member_party(conversation.id, user).await?;
        let (kind, change) = (
            if admin {
                MessageKind::AdminAdded
            } else {
                MessageKind::AdminRemoved
            },
            Change::SetAdmin {
                user,
                admin,
                limit: GROUP_MAX_ADMINS,
            },
        );
        let data = MessageData {
            actor: Some(party(me)),
            targets: vec![target],
            ..MessageData::default()
        };
        let event = self.event(conversation.id, kind, data);
        match self.deps.chat.apply(&event, &change).await? {
            Changed::Done(message) => Ok(Some(self.to_active_members(*message).await?)),
            Changed::Full { .. } => Err(ChatError::TooManyAdmins {
                max: GROUP_MAX_ADMINS,
            }),
            Changed::Nothing => Ok(None),
        }
    }

    /// 群主或管理员禁言一名普通成员 `minutes` 分钟（只能是 10、60、720、1440），
    /// 不给就是直到解除。已经禁言着的，按这一次的重新算。
    pub async fn mute_member(
        &self,
        me: &User,
        conversation: ConversationId,
        user: UserId,
        minutes: Option<u32>,
    ) -> Result<Posted, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let now = self.deps.clock.now_ms();
        let until = match minutes {
            Some(minutes) if MUTE_MINUTES.contains(&minutes) => now + i64::from(minutes) * 60_000,
            Some(_) => return Err(ChatError::Invalid("unsupported mute duration")),
            None => MUTED_FOREVER,
        };
        let target = self.deps.chat.find_member(conversation.id, user).await?;
        let target = target
            .filter(Member::is_active)
            .ok_or(ChatError::NotMember)?;
        if conversation.is_owner(user) || target.admin {
            return Err(ChatError::CannotMuteManager);
        }
        let data = MessageData {
            actor: Some(party(me)),
            targets: vec![self.member_party(conversation.id, user).await?],
            until: Some(until),
            ..MessageData::default()
        };
        let change = Change::Mute {
            user,
            until: Some(until),
        };
        self.announce(conversation.id, MessageKind::MemberMuted, data, change)
            .await
    }

    /// 群主或管理员提前解除一名成员的禁言。他没有被禁言时什么也不做，返回空。
    pub async fn unmute_member(
        &self,
        me: &User,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Option<Posted>, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let now = self.deps.clock.now_ms();
        let target = self.deps.chat.find_member(conversation.id, user).await?;
        let target = target
            .filter(Member::is_active)
            .ok_or(ChatError::NotMember)?;
        if muted_until(&target, now).is_none() {
            return Ok(None);
        }
        let data = MessageData {
            actor: Some(party(me)),
            targets: vec![self.member_party(conversation.id, user).await?],
            ..MessageData::default()
        };
        let change = Change::Mute { user, until: None };
        self.announce(conversation.id, MessageKind::MemberUnmuted, data, change)
            .await
            .map(Some)
    }

    /// 群主或管理员开启或关闭全员禁言。和现在一样时什么也不做，返回空。
    pub async fn set_all_muted(
        &self,
        me: &User,
        conversation: ConversationId,
        muted: bool,
    ) -> Result<Option<Posted>, ChatError> {
        let (conversation, _) = self.manager_of_open_group(me, conversation).await?;
        let kind = if muted {
            MessageKind::AllMuted
        } else {
            MessageKind::AllUnmuted
        };
        let data = MessageData {
            actor: Some(party(me)),
            ..MessageData::default()
        };
        let event = self.event(conversation.id, kind, data);
        match self
            .deps
            .chat
            .apply(&event, &Change::SetAllMuted(muted))
            .await?
        {
            Changed::Done(message) => Ok(Some(self.to_active_members(*message).await?)),
            _ => Ok(None),
        }
    }

    /// 改我在这个群里的昵称；只有空白就是去掉。返回要通知的人（群里现在的人）；
    /// 和原来一样时什么也不做，返回空。
    pub async fn set_group_nickname(
        &self,
        me: &User,
        conversation: ConversationId,
        nickname: &str,
    ) -> Result<Option<Vec<UserId>>, ChatError> {
        let (conversation, _) = self.active_in_open_group(me, conversation).await?;
        let nickname = clean_line(nickname);
        if nickname.chars().count() > GROUP_NICKNAME_MAX_CHARS {
            return Err(ChatError::Invalid("the group nickname is too long"));
        }
        let nickname = (!nickname.is_empty()).then_some(nickname);
        let changed = self
            .deps
            .chat
            .set_nickname(conversation.id, me.id, nickname)
            .await?;
        if !changed {
            return Ok(None);
        }
        Ok(Some(self.active_members(conversation.id).await?))
    }

    /// 群的全部成员，包括已经离开的。
    pub async fn members(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Vec<MemberInfo>, ChatError> {
        let (conversation, _) = self.group_membership(me, conversation).await?;
        let members = self.deps.chat.list_members(conversation.id).await?;
        let now = self.deps.clock.now_ms();
        let ids: Vec<UserId> = members.iter().map(|member| member.user).collect();
        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&ids)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        let remarks: HashMap<UserId, Option<String>> = self
            .deps
            .contacts
            .list_friendships(me.id)
            .await?
            .into_iter()
            .map(|friendship| (friendship.friend, friendship.remark))
            .collect();
        Ok(members
            .iter()
            .filter_map(|member| {
                let user = users.get(&member.user)?;
                let friendship = remarks.get(&member.user);
                Some(MemberInfo {
                    card: UserCard::from(user),
                    remark: friendship.cloned().flatten(),
                    is_friend: friendship.is_some(),
                    is_owner: conversation.owner == Some(member.user),
                    is_admin: member.is_active() && member.admin,
                    group_nickname: member.nickname.clone(),
                    muted_until: muted_until(member, now),
                    active: member.is_active(),
                    joined_seq: member.joined_seq,
                    read_seq: member.read_seq,
                })
            })
            .collect())
    }

    /// 同一个群的成员的资料。两个人都要在这个群里。
    pub async fn member_profile(
        &self,
        me: &User,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<MemberProfile, ChatError> {
        let (conversation, member) = self.group_membership(me, conversation).await?;
        if !member.is_active() {
            return Err(ChatError::LeftGroup);
        }
        let present = self.active_members(conversation.id).await?;
        if !present.contains(&user) {
            return Err(ChatError::NotMember);
        }
        let found = self
            .deps
            .users
            .find(user)
            .await?
            .ok_or(ChatError::NotMember)?;
        let contacts = self.deps.contacts.as_ref();
        let friendship = contacts.find_friendship(me.id, user).await?;
        Ok(MemberProfile {
            card: UserCard::from(&found),
            signature: found.signature.clone(),
            remark: friendship.and_then(|friendship| friendship.remark),
            relation: relation_between(contacts, me.id, user).await?,
        })
    }

    // ---------- 消息 ----------

    /// 发一条不 @ 任何人的文本消息。
    pub async fn send_text(
        &self,
        me: &User,
        conversation: ConversationId,
        client_id: &str,
        text: &str,
    ) -> Result<Posted, ChatError> {
        self.send(me, conversation, Draft::text(client_id, text))
            .await
    }

    /// 发一条消息：文本，或者带着一个已经上传的文件（图片、文件、语音）。
    /// 没等到结果而重发时带同一个客户端消息编号，这时不会产生第二条消息，
    /// 返回的是第一次写入的那一条。
    pub async fn send(
        &self,
        me: &User,
        conversation: ConversationId,
        draft: Draft<'_>,
    ) -> Result<Posted, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        if !is_valid_client_id(draft.client_id) {
            return Err(ChatError::Invalid(
                "client_id must be 1 to 36 letters, digits or hyphens",
            ));
        }
        let members = self.deps.chat.list_members(conversation.id).await?;
        let present: Vec<UserId> = members
            .iter()
            .filter(|member| member.is_active())
            .map(|member| member.user)
            .collect();

        let mut data = MessageData::default();
        match conversation.kind {
            ConversationKind::Direct => {
                let peer = present.iter().find(|user| **user != me.id);
                // 单聊里双方必须仍然是好友；和自己的对话里没有对方，随时可以发
                let still_friends = match peer {
                    Some(peer) => self.are_friends(me.id, *peer).await?,
                    None => present.contains(&me.id),
                };
                if !still_friends {
                    return Err(ChatError::NotFriends);
                }
            }
            ConversationKind::Group => {
                if !member.is_active() {
                    return Err(ChatError::LeftGroup);
                }
                if conversation.dissolved {
                    return Err(ChatError::GroupDissolved);
                }
                silenced(&conversation, &member, self.deps.clock.now_ms())?;
                if draft.mention_all && !manages(&conversation, &member) {
                    return Err(ChatError::NotManager);
                }
            }
        }

        // 群里的名字：有群内昵称用群内昵称
        let sender_name = (conversation.kind == ConversationKind::Group).then(|| {
            member
                .nickname
                .clone()
                .unwrap_or_else(|| me.nickname.clone())
        });
        if let Some(source) = draft.forward {
            let target = Target {
                conversation: &conversation,
                member: &member,
                present,
                sender_name,
            };
            return self.forward(me, target, draft.client_id, source).await;
        }
        if let Some(merge) = draft.merge {
            let target = Target {
                conversation: &conversation,
                member: &member,
                present,
                sender_name,
            };
            return self
                .forward_merged(me, target, draft.client_id, merge)
                .await;
        }
        let (kind, mut text, file) = match draft.attachment {
            None => (MessageKind::Text, Some(clean_text(draft.text)?), None),
            Some(attached) => {
                let file = self.deps.files.find(attached.file).await?;
                let file = file.ok_or(ChatError::FileUnavailable)?;
                if file.purpose != FilePurpose::Attachment || file.uploader != me.id {
                    return Err(ChatError::FileUnavailable);
                }
                // 一个文件只能属于一条消息。已经用过它的如果正是这一条（重发），交还那一条
                if let Some(earlier) = self.deps.chat.find_by_file(file.id).await? {
                    let resent = earlier.conversation == conversation.id
                        && earlier.sender == Some(me.id)
                        && earlier.client_id.as_deref() == Some(draft.client_id);
                    if !resent {
                        return Err(ChatError::FileUnavailable);
                    }
                    let extras = self
                        .extras(conversation.id, member.visible(), me.id, &[&earlier])
                        .await?;
                    return Ok(Posted {
                        message: earlier,
                        duplicate: true,
                        sender_name,
                        members: present,
                        extras,
                        quote_hidden_from: Vec::new(),
                    });
                }
                let kind = match attached.voice_duration_ms {
                    Some(duration_ms) => {
                        if !file.is_audio() {
                            return Err(ChatError::FileUnavailable);
                        }
                        let max_seconds = self.limits().await?.voice_max_seconds;
                        if duration_ms <= 0 {
                            return Err(ChatError::Invalid("voice duration must be positive"));
                        }
                        if duration_ms > i64::from(max_seconds) * 1000 + VOICE_SLACK_MS {
                            return Err(ChatError::VoiceTooLong { max_seconds });
                        }
                        data.duration_ms = Some(duration_ms);
                        MessageKind::Voice
                    }
                    None if file.is_image() => MessageKind::Image,
                    None => MessageKind::File,
                };
                (kind, None, Some(file.id))
            }
        };
        // 图片可以带一段文字说明；文件和语音不能带文字
        if kind != MessageKind::Text && !draft.text.trim().is_empty() {
            if kind != MessageKind::Image {
                return Err(ChatError::Invalid("only images can carry a caption"));
            }
            text = Some(clean_text(draft.text)?);
        }
        // @ 只在有文字的消息里有：文本消息，和带说明的图片
        if conversation.kind == ConversationKind::Group && text.is_some() {
            data.mention_all = draft.mention_all;
            data.mentions = distinct(draft.mentions, me.id);
            if data.mentions.iter().any(|user| !present.contains(user)) {
                return Err(ChatError::NotMember);
            }
        }

        if let Some(seq) = draft.reply_to {
            // 只能引用自己看得到的、没有撤回的消息，不能引用系统提示
            let quoted = self
                .deps
                .chat
                .find_messages(conversation.id, &[seq])
                .await?;
            let quotable = quoted.first().is_some_and(|quoted| {
                member.visible().contains(quoted.seq)
                    && quoted.kind.is_message()
                    && !quoted.is_recalled()
            });
            if !quotable {
                return Err(ChatError::QuoteUnavailable);
            }
        }

        let appended = self
            .deps
            .chat
            .append(&NewMessage {
                id: MessageId::new(),
                conversation: conversation.id,
                sender: Some(me.id),
                client_id: Some(draft.client_id.to_owned()),
                kind,
                text,
                data,
                file,
                reply_to: draft.reply_to,
                created_at: self.deps.clock.now_ms(),
            })
            .await?;
        let extras = self
            .extras(
                conversation.id,
                member.visible(),
                me.id,
                &[&appended.message],
            )
            .await?;
        // 在被引用的那条之后才入群的人，看不到它的内容
        let quote_hidden_from = match appended.message.reply_to {
            Some(seq) => members
                .iter()
                .filter(|member| member.is_active() && !member.visible().contains(seq))
                .map(|member| member.user)
                .collect(),
            None => Vec::new(),
        };
        Ok(Posted {
            message: appended.message,
            duplicate: appended.duplicate,
            sender_name,
            members: present,
            extras,
            quote_hidden_from,
        })
    }

    /// 转发：在目标会话里发一条新消息，内容从原消息复制过来（文字、图片和它的说明、文件、语音），
    /// 不带原来的引用和 @。带文件的，新登记一个文件，和原文件共用存储里的同一份内容。
    async fn forward(
        &self,
        me: &User,
        target: Target<'_>,
        client_id: &str,
        source: Forwarded,
    ) -> Result<Posted, ChatError> {
        // 原消息：我要看得到它（会话不是我的、在我入群之前，都当作不存在）
        let (origin, origin_member) = self.membership(me, source.conversation).await?;
        let found = self
            .deps
            .chat
            .find_messages(origin.id, &[source.seq])
            .await?;
        let original = found
            .into_iter()
            .next()
            .filter(|message| origin_member.visible().contains(message.seq))
            .ok_or(ChatError::MessageNotFound)?;
        if !is_forwardable(&original) {
            return Err(ChatError::ForwardNotAllowed);
        }

        let now = self.deps.clock.now_ms();
        let mut created = Vec::new();
        let file = match original.file {
            Some(id) => Some(self.copy_file(me, id, now, &mut created).await?.id),
            None => None,
        };
        // 聊天记录连同里面的文件原样复制
        let record = match original.data.record {
            Some(record) => {
                let mut items = Vec::with_capacity(record.items.len());
                for item in record.items {
                    let file = match item.file {
                        Some(id) => Some(self.copy_file(me, id, now, &mut created).await?.id),
                        None => None,
                    };
                    items.push(RecordItem { file, ..item });
                }
                Some(Record {
                    title: record.title,
                    items,
                })
            }
            None => None,
        };
        let copy = NewMessage {
            id: MessageId::new(),
            conversation: target.conversation.id,
            sender: Some(me.id),
            client_id: Some(client_id.to_owned()),
            kind: original.kind,
            text: original.text,
            // 语音带着时长；引用和 @ 都不带
            data: MessageData {
                duration_ms: original.data.duration_ms,
                record,
                ..MessageData::default()
            },
            file,
            reply_to: None,
            created_at: now,
        };
        self.post_copy(me, target, copy, created).await
    }

    /// 合并转发：把同一个会话里的几条做成一条聊天记录，发到目标会话。
    /// 每一条存下转发那一刻的样子：原发送人现在的昵称和头像、内容；带文件的新登记一个文件，共用内容。
    async fn forward_merged(
        &self,
        me: &User,
        target: Target<'_>,
        client_id: &str,
        merge: Merged<'_>,
    ) -> Result<Posted, ChatError> {
        let title = clean_line(merge.title);
        if title.is_empty() || title.chars().count() > RECORD_TITLE_MAX_CHARS {
            return Err(ChatError::Invalid("record title must be 1-100 characters"));
        }
        let mut seqs = merge.seqs.to_vec();
        seqs.sort_unstable();
        seqs.dedup();
        if seqs.is_empty() || seqs.len() > RECORD_MAX_ITEMS {
            return Err(ChatError::Invalid("a record holds 1-50 messages"));
        }

        // 原消息：每一条我都要看得到
        let (origin, origin_member) = self.membership(me, merge.conversation).await?;
        let mut originals = self.deps.chat.find_messages(origin.id, &seqs).await?;
        originals.retain(|message| origin_member.visible().contains(message.seq));
        if originals.len() != seqs.len() {
            return Err(ChatError::MessageNotFound);
        }
        if !originals.iter().all(is_forwardable) {
            return Err(ChatError::ForwardNotAllowed);
        }
        originals.sort_by_key(|message| message.seq);

        let senders: Vec<UserId> = originals
            .iter()
            .filter_map(|message| message.sender)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&senders)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();

        let now = self.deps.clock.now_ms();
        let mut created = Vec::new();
        let mut items = Vec::with_capacity(originals.len());
        // 给搜索用的一段文字：标题，和每一条的文字、图片说明、文件名、里面的聊天记录的标题
        let mut searchable = vec![title.clone()];
        for original in originals {
            let sender = original.sender.and_then(|id| users.get(&id));
            let mut item = RecordItem {
                sender: original.sender,
                sender_name: sender.map(|user| user.nickname.clone()).unwrap_or_default(),
                sender_avatar: sender.and_then(|user| user.avatar),
                kind: original.kind,
                text: original.text,
                file: None,
                duration_ms: original.data.duration_ms,
                created_at: original.created_at,
            };
            if let Some(id) = original.file {
                let copy = self.copy_file(me, id, now, &mut created).await?;
                if item.kind == MessageKind::File
                    && let Some(name) = &copy.name
                {
                    searchable.push(name.clone());
                }
                item.file = Some(copy.id);
            }
            // 嵌在里面的聊天记录只留标题
            if let Some(record) = original.data.record {
                item.text = Some(record.title);
            }
            searchable.extend(item.text.clone());
            items.push(item);
        }

        let message = NewMessage {
            id: MessageId::new(),
            conversation: target.conversation.id,
            sender: Some(me.id),
            client_id: Some(client_id.to_owned()),
            kind: MessageKind::ChatRecord,
            text: Some(searchable.join("\n")),
            data: MessageData {
                record: Some(Record { title, items }),
                ..MessageData::default()
            },
            file: None,
            reply_to: None,
            created_at: now,
        };
        self.post_copy(me, target, message, created).await
    }

    /// 给转发新登记一个文件，和原文件共用存储里的内容。
    async fn copy_file(
        &self,
        me: &User,
        id: FileId,
        now: i64,
        created: &mut Vec<FileId>,
    ) -> Result<StoredFile, ChatError> {
        let file = self.deps.files.find(id).await?;
        let file = file.ok_or(ChatError::FileUnavailable)?;
        let copy = StoredFile {
            id: FileId::new(),
            uploader: me.id,
            created_at: now,
            ..file
        };
        self.deps.files.create(&copy).await?;
        created.push(copy.id);
        Ok(copy)
    }

    /// 写入转发出来的一条。
    async fn post_copy(
        &self,
        me: &User,
        target: Target<'_>,
        message: NewMessage,
        created: Vec<FileId>,
    ) -> Result<Posted, ChatError> {
        let appended = self.deps.chat.append(&message).await?;
        // 重发：上一次已经转发过了，这一次登记的文件用不上，拿掉（内容是共用的，不删）
        if appended.duplicate {
            for file in created {
                self.deps.files.delete(file).await?;
            }
        }
        let extras = self
            .extras(
                target.conversation.id,
                target.member.visible(),
                me.id,
                &[&appended.message],
            )
            .await?;
        Ok(Posted {
            message: appended.message,
            duplicate: appended.duplicate,
            sender_name: target.sender_name,
            members: target.present,
            extras,
            quote_hidden_from: Vec::new(),
        })
    }

    /// 撤回自己发的一条消息。只能在时限之内；撤回后所有人看到的都是"撤回了一条消息"。
    pub async fn recall(
        &self,
        me: &User,
        conversation: ConversationId,
        seq: i64,
    ) -> Result<Posted, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let found = self
            .deps
            .chat
            .find_messages(conversation.id, &[seq])
            .await?;
        let message = found
            .into_iter()
            .next()
            .filter(|message| member.visible().contains(message.seq))
            .ok_or(ChatError::MessageNotFound)?;
        if !message.kind.is_message() || message.sender != Some(me.id) || message.is_recalled() {
            return Err(ChatError::RecallNotAllowed);
        }
        // 被禁言的人不能撤回：撤回也是在群里留下一行
        if conversation.kind == ConversationKind::Group && member.is_active() {
            silenced(&conversation, &member, self.deps.clock.now_ms())?;
        }
        // 时限从服务端收到这条消息的时间算起
        let window_ms = i64::from(self.limits().await?.recall_window_seconds) * 1000;
        // 时限是 0：管理员关掉了撤回
        if window_ms == 0 || self.deps.clock.now_ms() - message.created_at > window_ms {
            return Err(ChatError::RecallTooLate);
        }

        let data = MessageData {
            actor: Some(party(me)),
            seq: Some(seq),
            ..MessageData::default()
        };
        let event = self.event(conversation.id, MessageKind::Recalled, data);
        let event = self.deps.chat.recall(&event, seq).await?;
        // 另一处抢先撤回了
        let event = event.ok_or(ChatError::RecallNotAllowed)?;
        let mut members = self.active_members(conversation.id).await?;
        // 已经离开会话的人也能撤回自己在时限内的消息：他在别处的登录要知道
        if !members.contains(&me.id) {
            members.push(me.id);
        }
        Ok(posted(event, members))
    }

    /// 编辑我发的一条消息（F8）：文字消息的文字、图片的说明。在时限之内，次数不限。
    /// 会话里写一条"编辑"事件（像撤回那样），带着新的内容和这一次新 @ 到的人；修改之前的内容
    /// 也存在事件里，只给管理员看。原来那条消息换成新的内容。
    pub async fn edit(
        &self,
        me: &User,
        conversation: ConversationId,
        seq: i64,
        draft: EditDraft<'_>,
    ) -> Result<Posted, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let found = self
            .deps
            .chat
            .find_messages(conversation.id, &[seq])
            .await?;
        let message = found
            .into_iter()
            .next()
            .filter(|message| member.visible().contains(message.seq))
            .ok_or(ChatError::MessageNotFound)?;
        let editable = matches!(message.kind, MessageKind::Text | MessageKind::Image);
        if !editable || message.sender != Some(me.id) || message.is_recalled() {
            return Err(ChatError::EditNotAllowed);
        }
        // 和发消息一样：单聊里还得是好友，群里还在群、没有被禁言
        match conversation.kind {
            ConversationKind::Direct => {
                let members = self.active_members(conversation.id).await?;
                let still_friends = match members.iter().find(|user| **user != me.id) {
                    Some(peer) => self.are_friends(me.id, *peer).await?,
                    None => members.contains(&me.id),
                };
                if !still_friends {
                    return Err(ChatError::NotFriends);
                }
            }
            ConversationKind::Group => {
                if !member.is_active() {
                    return Err(ChatError::LeftGroup);
                }
                if conversation.dissolved {
                    return Err(ChatError::GroupDissolved);
                }
                silenced(&conversation, &member, self.deps.clock.now_ms())?;
            }
        }
        // 时限从服务端收到这条消息的时间算起，改几次都不延长（F8 Q2、Q3）
        let window_ms = i64::from(self.limits().await?.edit_window_seconds) * 1000;
        if window_ms == 0 || self.deps.clock.now_ms() - message.created_at > window_ms {
            return Err(ChatError::EditTooLate);
        }

        // 文字消息不能改成空的；图片的说明可以去掉
        let text = match message.kind {
            MessageKind::Image if draft.text.trim().is_empty() => None,
            _ => Some(clean_text(draft.text)?),
        };
        let (mentions, mention_all) = if conversation.kind == ConversationKind::Group
            && text.is_some()
        {
            let present = self.active_members(conversation.id).await?;
            let mentions = distinct(draft.mentions, me.id);
            if mentions.iter().any(|user| !present.contains(user)) {
                return Err(ChatError::NotMember);
            }
            // @ 所有人只有群主和管理员能用；原来就有的留着
            if draft.mention_all && !message.data.mention_all && !manages(&conversation, &member) {
                return Err(ChatError::NotManager);
            }
            (mentions, draft.mention_all)
        } else {
            (Vec::new(), false)
        };
        let unchanged = text == message.text
            && mentions == message.data.mentions
            && mention_all == message.data.mention_all;
        if unchanged {
            return Err(ChatError::Invalid("nothing changed"));
        }

        // 事件里 @ 的是这一次新 @ 到的人：原来就 @ 过的不再提醒（F8 Q4）
        let data = MessageData {
            actor: Some(party(me)),
            seq: Some(seq),
            mentions: mentions
                .iter()
                .copied()
                .filter(|user| !message.data.mentions.contains(user))
                .collect(),
            mention_all: mention_all && !message.data.mention_all,
            previous: message.text.clone(),
            ..MessageData::default()
        };
        let mut event = self.event(conversation.id, MessageKind::Edited, data);
        event.text = text.clone();
        let change = Edit {
            text,
            mentions,
            mention_all,
        };
        let event = self.deps.chat.edit(&event, seq, &change).await?;
        // 另一处抢先撤回了
        let event = event.ok_or(ChatError::EditNotAllowed)?;
        let members = self.active_members(conversation.id).await?;
        Ok(posted(event, members))
    }

    /// 我在这个会话里正在输入（F8）：交回要告诉的人，会话里其他还在的成员。
    /// 发不了消息的时候（不是好友了、离开了群、被禁言了）不告诉任何人，报错（F8 Q11）。
    pub async fn typing(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Vec<UserId>, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let present = self.active_members(conversation.id).await?;
        match conversation.kind {
            ConversationKind::Direct => {
                let peer = present.iter().find(|user| **user != me.id);
                match peer {
                    Some(peer) if self.are_friends(me.id, *peer).await? => {}
                    // 和自己的对话里没有别人
                    _ => return Ok(Vec::new()),
                }
            }
            ConversationKind::Group => {
                if !member.is_active() {
                    return Err(ChatError::LeftGroup);
                }
                if conversation.dissolved {
                    return Err(ChatError::GroupDissolved);
                }
                silenced(&conversation, &member, self.deps.clock.now_ms())?;
            }
        }
        Ok(present.into_iter().filter(|user| *user != me.id).collect())
    }

    /// 记下我播放了一条语音。
    pub async fn mark_played(
        &self,
        me: &User,
        conversation: ConversationId,
        seq: i64,
    ) -> Result<Played, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let found = self
            .deps
            .chat
            .find_messages(conversation.id, &[seq])
            .await?;
        let message = found
            .into_iter()
            .next()
            .filter(|message| member.visible().contains(message.seq))
            .filter(|message| message.kind == MessageKind::Voice && !message.is_recalled())
            .ok_or(ChatError::MessageNotFound)?;
        // 自己发的语音没有"听过没有"
        let changed = message.sender != Some(me.id)
            && self
                .deps
                .chat
                .mark_played(message.id, me.id, self.deps.clock.now_ms())
                .await?;
        Ok(Played { seq, changed })
    }

    /// 按关键词搜索：文本消息的文字和文件消息的文件名。只搜我能看到的、没有撤回的消息。
    /// 给了 `conversation` 时只在这一个会话里搜，可以用 `before` 翻页；否则搜我的全部会话。
    pub async fn search(
        &self,
        me: &User,
        query: &str,
        conversation: Option<ConversationId>,
        before: Option<i64>,
        limit: Option<u32>,
    ) -> Result<Found, ChatError> {
        let needle = query.trim();
        if needle.is_empty() || needle.chars().count() > SEARCH_QUERY_MAX_CHARS {
            return Err(ChatError::Invalid("the query must be 1 to 50 characters"));
        }
        let (scopes, limit) = match conversation {
            Some(conversation) => {
                let (conversation, member) = self.membership(me, conversation).await?;
                let limit = limit.unwrap_or(SEARCH_PAGE_SIZE);
                if limit == 0 || limit > SEARCH_PAGE_SIZE_MAX {
                    return Err(ChatError::Invalid("limit must be between 1 and 50"));
                }
                let scope = SearchScope {
                    conversation: conversation.id,
                    visible: member.visible(),
                    before,
                };
                (vec![scope], limit as usize)
            }
            None => {
                let scopes = self
                    .deps
                    .chat
                    .memberships(me.id)
                    .await?
                    .iter()
                    .map(|member| SearchScope {
                        conversation: member.conversation,
                        visible: member.visible(),
                        before: None,
                    })
                    .collect();
                (scopes, SEARCH_ALL_LIMIT)
            }
        };
        if scopes.is_empty() {
            return Ok(Found {
                hits: Vec::new(),
                has_more: false,
                sender_names: HashMap::new(),
                extras: Extras::default(),
            });
        }

        // 多取一条，用来判断还有没有更多
        let mut hits = self
            .deps
            .chat
            .search(&scopes, needle, limit as u64 + 1)
            .await?;
        let has_more = hits.len() > limit;
        hits.truncate(limit);

        let senders: HashSet<UserId> = hits.iter().filter_map(|hit| hit.sender).collect();
        let senders: Vec<UserId> = senders.into_iter().collect();
        let sender_names = self
            .deps
            .users
            .find_many(&senders)
            .await?
            .into_iter()
            .map(|user| (user.id, user.nickname))
            .collect();
        let file_ids: Vec<FileId> = hits.iter().filter_map(|hit| hit.file).collect();
        let extras = Extras {
            files: self.files_by_id(&file_ids).await?,
            ..Extras::default()
        };
        Ok(Found {
            hits,
            has_more,
            sender_names,
            extras,
        })
    }

    /// 当前生效的各项上限。
    /// 通话画面的参数（F7）：打电话前随中转账号一起交给客户端。
    pub async fn call_video(&self) -> Result<crate::limits::CallVideo, ChatError> {
        Ok(crate::limits::CallVideo::load(self.deps.settings.as_ref()).await?)
    }

    pub async fn limits(&self) -> Result<Limits, ChatError> {
        Ok(Limits::load(self.deps.settings.as_ref()).await?)
    }

    /// 会话里的一段消息。只能取到我能看到的范围：入群之后、离开之前。
    pub async fn history(
        &self,
        me: &User,
        conversation: ConversationId,
        query: HistoryQuery,
    ) -> Result<Page, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        self.page(&conversation, member.visible(), Some(me.id), query)
            .await
    }

    /// 会话里 `visible` 范围内的一段消息。`viewer` 为空是管理员在看：
    /// 已撤回的消息带着原内容，单聊也带上发送人的昵称。
    async fn page(
        &self,
        conversation: &Conversation,
        visible: Visible,
        viewer: Option<UserId>,
        query: HistoryQuery,
    ) -> Result<Page, ChatError> {
        if query.before.is_some() && query.after.is_some() {
            return Err(ChatError::Invalid("give either before or after, not both"));
        }
        if query.before.is_some_and(|seq| seq < 1) || query.after.is_some_and(|seq| seq < 0) {
            return Err(ChatError::Invalid("sequence numbers start at 1"));
        }
        let limit = query.limit.unwrap_or(HISTORY_PAGE_SIZE);
        if limit == 0 || limit > HISTORY_PAGE_SIZE_MAX {
            return Err(ChatError::Invalid("limit must be between 1 and 100"));
        }
        let limit = limit as usize;

        // 多取一条，用来判断这个方向上还有没有更多
        let wanted = limit as u64 + 1;
        let chat = &self.deps.chat;
        let (messages, has_more) = match query.after {
            Some(after) => {
                let mut messages = chat
                    .list_after(conversation.id, visible, after, wanted)
                    .await?;
                let has_more = messages.len() > limit;
                messages.truncate(limit);
                (messages, has_more)
            }
            None => {
                let mut messages = chat
                    .list_before(conversation.id, visible, query.before, wanted)
                    .await?;
                let has_more = messages.len() > limit;
                if has_more {
                    // 多出来的是最早的那一条
                    messages.remove(0);
                }
                (messages, has_more)
            }
        };

        self.decorate(conversation, visible, viewer, messages, has_more)
            .await
    }

    /// 会话里的图片或文件，从新到旧一页一页地取（F6）：`kind` 只能是图片或文件。
    /// 只有我看得到的，撤回了的不算。一页里按序号从小到大，`before` 往更早的翻。
    pub async fn media(
        &self,
        me: &User,
        conversation: ConversationId,
        kind: MessageKind,
        before: Option<i64>,
        limit: Option<u32>,
    ) -> Result<Page, ChatError> {
        if kind != MessageKind::Image && kind != MessageKind::File {
            return Err(ChatError::Invalid("kind must be image or file"));
        }
        if before.is_some_and(|seq| seq < 1) {
            return Err(ChatError::Invalid("sequence numbers start at 1"));
        }
        let limit = limit.unwrap_or(HISTORY_PAGE_SIZE);
        if limit == 0 || limit > HISTORY_PAGE_SIZE_MAX {
            return Err(ChatError::Invalid("limit must be between 1 and 100"));
        }
        let (conversation, member) = self.membership(me, conversation).await?;
        let visible = member.visible();
        let mut messages = self
            .deps
            .chat
            .list_kind_before(conversation.id, visible, kind, before, u64::from(limit) + 1)
            .await?;
        let has_more = messages.len() > limit as usize;
        if has_more {
            messages.remove(0);
        }
        self.decorate(&conversation, visible, Some(me.id), messages, has_more)
            .await
    }

    /// 一段消息交出去之前：撤回了的去掉内容（管理员除外），配上发送人的名字、所附的文件、引用。
    async fn decorate(
        &self,
        conversation: &Conversation,
        visible: Visible,
        viewer: Option<UserId>,
        messages: Vec<Message>,
        has_more: bool,
    ) -> Result<Page, ChatError> {
        let messages: Vec<Message> = match viewer {
            Some(_) => messages.into_iter().map(Message::redacted).collect(),
            None => messages,
        };
        let mut sender_names = HashMap::new();
        if conversation.kind == ConversationKind::Group || viewer.is_none() {
            let senders: HashSet<UserId> = messages.iter().filter_map(|m| m.sender).collect();
            let senders: Vec<UserId> = senders.into_iter().collect();
            for user in self.deps.users.find_many(&senders).await? {
                sender_names.insert(user.id, user.nickname);
            }
            // 群里的名字：有群内昵称用群内昵称
            if conversation.kind == ConversationKind::Group {
                for member in self.deps.chat.list_members(conversation.id).await? {
                    if let Some(nickname) = member.nickname
                        && sender_names.contains_key(&member.user)
                    {
                        sender_names.insert(member.user, nickname);
                    }
                }
            }
        }
        let shown: Vec<&Message> = messages.iter().collect();
        let extras = self
            .extras_as(conversation.id, visible, viewer, &shown)
            .await?;
        Ok(Page {
            messages,
            has_more,
            sender_names,
            extras,
        })
    }

    // ---------- 通话 ----------

    /// 我能在这个会话里给谁打电话：必须是和好友的单聊。交回对方。
    pub async fn call_peer(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<UserId, ChatError> {
        let (conversation, _) = self.membership(me, conversation).await?;
        if conversation.kind != ConversationKind::Direct {
            return Err(ChatError::CallNotAllowed);
        }
        let peer = self
            .active_members(conversation.id)
            .await?
            .into_iter()
            .find(|user| *user != me.id)
            .ok_or(ChatError::CallNotAllowed)?;
        if !self.are_friends(me.id, peer).await? {
            return Err(ChatError::NotFriends);
        }
        Ok(peer)
    }

    /// 通话结束后，在双方的单聊里写一条通话记录，发送人是主叫。
    /// 它和普通消息一样算被叫的未读。双方已经不是好友了也照样写：通话确实发生过。
    pub async fn record_call(&self, call: &Call) -> Result<Posted, ChatError> {
        let outcome = call
            .outcome()
            .ok_or(ChatError::Invalid("the call has not ended"))?;
        let record = NewMessage {
            id: MessageId::new(),
            conversation: call.conversation,
            sender: Some(call.caller),
            client_id: None,
            kind: MessageKind::Call,
            text: None,
            data: MessageData {
                call: Some(outcome),
                call_video: call.video,
                duration_ms: call.duration_ms(),
                ..MessageData::default()
            },
            file: None,
            reply_to: None,
            created_at: call.ended_at.unwrap_or_else(|| self.deps.clock.now_ms()),
        };
        let appended = self.deps.chat.append(&record).await?;
        Ok(posted(appended.message, vec![call.caller, call.callee]))
    }

    /// 我能不能在这个群里发起、加入群通话（F10）：我是在群的成员，群没有解散。
    /// 交回现在在群的全部成员：邀请只认他们，通话的变化也推给他们。
    pub async fn group_call_members(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Vec<UserId>, ChatError> {
        let (conversation, _) = self.active_in_open_group(me, conversation).await?;
        self.active_members(conversation.id).await
    }

    /// 现在在群的成员：群通话有变化时推给他们。
    pub async fn group_call_audience(
        &self,
        conversation: ConversationId,
    ) -> Result<Vec<UserId>, ChatError> {
        self.active_members(conversation).await
    }

    /// 群通话最多几个人：管理员设置过就用设置的，否则用默认值。
    pub async fn group_call_max(&self) -> Result<u32, ChatError> {
        Ok(crate::limits::group_call_max(self.deps.settings.as_ref()).await?)
    }

    /// 群通话结束后，在群里写一条通话记录，记在发起人名下：通话了多久、几个人参加过。
    ///
    /// 对没参加的人它是一条普通的未读。参加了的人，之前没有别的未读的话，这一条直接算读过：
    /// 他们刚从通话里出来，不该再被它提醒一次。
    pub async fn record_group_call(&self, call: &GroupCall) -> Result<GroupCallRecord, ChatError> {
        let ended_at = call
            .ended_at
            .ok_or(ChatError::Invalid("the group call has not ended"))?;
        let record = NewMessage {
            id: MessageId::new(),
            conversation: call.conversation,
            sender: Some(call.starter),
            client_id: None,
            kind: MessageKind::Call,
            text: None,
            data: MessageData {
                call: Some(CallOutcome::Completed),
                call_video: call.video,
                call_joined: Some(call.joined.len() as u32),
                duration_ms: call.duration_ms(),
                ..MessageData::default()
            },
            file: None,
            reply_to: None,
            created_at: ended_at,
        };
        let appended = self.deps.chat.append(&record).await?;
        let seq = appended.message.seq;
        let mut read_by = Vec::new();
        for user in &call.joined {
            let Some(member) = self.deps.chat.find_member(call.conversation, *user).await? else {
                continue;
            };
            // 发起人是这一条的发送人，本来就不算他的未读；他的已读位置也跟上
            let caught_up = member.is_active() && member.read_seq == seq - 1;
            if caught_up
                && self
                    .deps
                    .chat
                    .advance_read(call.conversation, *user, seq)
                    .await?
            {
                read_by.push((*user, seq));
            }
        }
        let sender_name = self
            .deps
            .users
            .find(call.starter)
            .await?
            .map(|starter| starter.nickname);
        let mut posted = posted(
            appended.message,
            self.active_members(call.conversation).await?,
        );
        posted.sender_name = sender_name;
        Ok(GroupCallRecord { posted, read_by })
    }

    /// 上报已读位置：序号不大于 `seq` 的我都看过了。位置只前进不后退。
    pub async fn mark_read(
        &self,
        me: &User,
        conversation: ConversationId,
        seq: i64,
    ) -> Result<ReadUpdate, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        if seq < 0 {
            return Err(ChatError::Invalid("sequence numbers start at 1"));
        }
        // 不能"读到"还不存在、或者自己看不到的消息
        let seq = seq.min(member.last_visible(&conversation));
        let changed = self
            .deps
            .chat
            .advance_read(conversation.id, me.id, seq)
            .await?;
        Ok(ReadUpdate {
            read_seq: seq.max(member.read_seq),
            changed,
            members: self.active_members(conversation.id).await?,
        })
    }

    // ---------- 删除和清空（只对自己，F6） ----------

    /// 把几条从我这边删掉：对方、管理员照常看得到（Q5、Q8），删了不能恢复（Q9）。
    /// 交回删掉的序号，从小到大、不重复。
    pub async fn delete_for_me(
        &self,
        me: &User,
        conversation: ConversationId,
        seqs: &[i64],
    ) -> Result<Vec<i64>, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let mut seqs = seqs.to_vec();
        seqs.sort_unstable();
        seqs.dedup();
        if seqs.is_empty() || seqs.len() > DELETE_MAX_MESSAGES {
            return Err(ChatError::Invalid("delete 1 to 100 messages at a time"));
        }
        // 只能删自己看得到的
        let visible = member.visible();
        let last = member.last_visible(&conversation);
        if seqs
            .iter()
            .any(|seq| !visible.contains(*seq) || *seq > last)
        {
            return Err(ChatError::MessageNotFound);
        }
        self.deps
            .chat
            .delete_for(conversation.id, me.id, &seqs, self.deps.clock.now_ms())
            .await?;
        Ok(seqs)
    }

    /// 清空这个会话到现在为止的记录，只对我（Q7：会话还留在列表里）。清空的算读过（Q10）。
    pub async fn clear_for_me(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<Cleared, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        let seq = member.last_visible(&conversation);
        self.deps.chat.clear(conversation.id, me.id, seq).await?;
        Ok(Cleared {
            seq,
            read: ReadUpdate {
                read_seq: seq.max(member.read_seq),
                changed: seq > member.read_seq,
                members: self.active_members(conversation.id).await?,
            },
        })
    }

    /// 把会话从我的列表里移除。历史不受影响；有新内容时它会重新出现。
    pub async fn hide(&self, me: &User, conversation: ConversationId) -> Result<(), ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        self.deps
            .chat
            .hide(conversation.id, me.id, member.last_visible(&conversation))
            .await?;
        Ok(())
    }

    /// 把会话设为免打扰，或者取消。只影响我自己：消息照常收，未读数照常算，只是不提醒。
    /// 把会话置顶，或者取消。交回置顶的时间（取消了为空）。不限个数（F6 Q1），跟着账号走（Q3）。
    pub async fn pin(
        &self,
        me: &User,
        conversation: ConversationId,
        pinned: bool,
    ) -> Result<Option<i64>, ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        // 已经置顶的再置顶一次：保留原来的时间
        let pinned_at = match (pinned, member.pinned_at) {
            (true, Some(at)) => Some(at),
            (true, None) => Some(self.deps.clock.now_ms()),
            (false, _) => None,
        };
        self.deps
            .chat
            .set_pinned(conversation.id, me.id, pinned_at)
            .await?;
        Ok(pinned_at)
    }

    pub async fn mute(
        &self,
        me: &User,
        conversation: ConversationId,
        muted: bool,
    ) -> Result<(), ChatError> {
        let (conversation, _) = self.membership(me, conversation).await?;
        self.deps
            .chat
            .set_muted(conversation.id, me.id, muted)
            .await?;
        Ok(())
    }

    // ---------- 内部 ----------

    // ---------- 管理员 ----------
    //
    // 这里只有"读"和"解散群"。调用它们之前要不要留记录、有没有查看凭据，由管理功能负责。

    /// 一个会话，不管管理员是不是它的成员。
    pub async fn oversee(&self, conversation: ConversationId) -> Result<Overseen, ChatError> {
        let found = self.deps.chat.find_conversation(conversation).await?;
        let conversation = found.ok_or(ChatError::ConversationNotFound)?;
        let mut described = self.describe_overseen(vec![conversation]).await?;
        described.pop().ok_or(ChatError::ConversationNotFound)
    }

    /// 一个用户参与的全部会话：单聊和群，包括他已经离开的群和已经解散的群。最近有动静的在前。
    pub async fn oversee_user(&self, user: UserId) -> Result<Vec<Overseen>, ChatError> {
        let memberships = self.deps.chat.memberships(user).await?;
        let ids: Vec<ConversationId> = memberships.iter().map(|m| m.conversation).collect();
        let conversations = if ids.is_empty() {
            Vec::new()
        } else {
            self.deps.chat.find_conversations(&ids).await?
        };
        let mut described = self.describe_overseen(conversations).await?;
        described.sort_by_key(|overseen| {
            let latest = overseen.last_at.unwrap_or(overseen.conversation.created_at);
            std::cmp::Reverse((latest, overseen.conversation.id))
        });
        Ok(described)
    }

    /// 系统里的群，新建的在前，同时返回一共有多少。`search` 在群名里找。
    pub async fn oversee_groups(
        &self,
        search: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<Overseen>, u64), ChatError> {
        let chat = &self.deps.chat;
        let (groups, total) = chat.list_all_groups(search, offset, limit).await?;
        Ok((self.describe_overseen(groups).await?, total))
    }

    /// 一个会话的全部成员，包括已经离开的，按加入的先后。
    pub async fn oversee_members(
        &self,
        conversation: ConversationId,
    ) -> Result<Vec<OverseenMember>, ChatError> {
        let found = self.deps.chat.find_conversation(conversation).await?;
        let conversation = found.ok_or(ChatError::ConversationNotFound)?;
        let members = self.deps.chat.list_members(conversation.id).await?;
        let ids: Vec<UserId> = members.iter().map(|member| member.user).collect();
        let users: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(&ids)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        Ok(members
            .iter()
            .filter_map(|member| {
                Some(OverseenMember {
                    card: UserCard::from(users.get(&member.user)?),
                    is_owner: conversation.owner == Some(member.user),
                    active: member.is_active(),
                })
            })
            .collect())
    }

    /// 一个会话里的一段消息，不受"入群之后才能看"的限制；已撤回的带着原内容。
    pub async fn oversee_history(
        &self,
        conversation: ConversationId,
        query: HistoryQuery,
    ) -> Result<Page, ChatError> {
        let found = self.deps.chat.find_conversation(conversation).await?;
        let conversation = found.ok_or(ChatError::ConversationNotFound)?;
        let everything = Visible::EVERYTHING;
        self.page(&conversation, everything, None, query).await
    }

    /// 管理员解散一个群。事件里不写是谁解散的：成员看到的是"群已被管理员解散"。
    pub async fn dissolve_as_admin(
        &self,
        conversation: ConversationId,
    ) -> Result<Posted, ChatError> {
        let found = self.deps.chat.find_conversation(conversation).await?;
        let conversation = found
            .filter(|conversation| conversation.kind == ConversationKind::Group)
            .ok_or(ChatError::ConversationNotFound)?;
        if conversation.dissolved {
            return Err(ChatError::GroupDissolved);
        }
        self.announce(
            conversation.id,
            MessageKind::Dissolved,
            MessageData::default(),
            Change::Dissolve,
        )
        .await
    }

    async fn describe_overseen(
        &self,
        conversations: Vec<Conversation>,
    ) -> Result<Vec<Overseen>, ChatError> {
        let chat = &self.deps.chat;
        let everything = Visible::EVERYTHING;
        let mut rows = Vec::with_capacity(conversations.len());
        let mut wanted: HashSet<UserId> = HashSet::new();
        for conversation in conversations {
            let members = chat.list_members(conversation.id).await?;
            let last = chat
                .list_before(conversation.id, everything, None, 1)
                .await?;
            // 单聊是那两个人；群是最早加入、现在还在的几个人
            let shown: Vec<UserId> = match conversation.kind {
                ConversationKind::Direct => members.iter().map(|member| member.user).collect(),
                ConversationKind::Group => members
                    .iter()
                    .filter(|member| member.is_active())
                    .take(NAME_HINT_MEMBERS)
                    .map(|member| member.user)
                    .collect(),
            };
            wanted.extend(&shown);
            wanted.extend(conversation.owner);
            let active = members.iter().filter(|member| member.is_active()).count();
            let last_at = last.first().map(|message| message.created_at);
            rows.push((conversation, shown, active as u32, last_at));
        }
        let wanted: Vec<UserId> = wanted.into_iter().collect();
        let users: HashMap<UserId, User> = if wanted.is_empty() {
            HashMap::new()
        } else {
            let found = self.deps.users.find_many(&wanted).await?;
            found.into_iter().map(|user| (user.id, user)).collect()
        };
        Ok(rows
            .into_iter()
            .map(|(conversation, shown, member_count, last_at)| Overseen {
                people: shown
                    .iter()
                    .filter_map(|id| users.get(id))
                    .map(UserCard::from)
                    .collect(),
                owner: conversation
                    .owner
                    .and_then(|owner| users.get(&owner))
                    .map(UserCard::from),
                member_count,
                last_at,
                conversation,
            })
            .collect())
    }

    /// 一个会话，以及我在其中的成员记录。没有记录时当作会话不存在。
    /// 离开了的群也有记录：还能看离开之前的内容。
    async fn membership(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(Conversation, Member), ChatError> {
        let member = self
            .deps
            .chat
            .find_member(conversation, me.id)
            .await?
            .ok_or(ChatError::ConversationNotFound)?;
        let conversation = self
            .deps
            .chat
            .find_conversation(conversation)
            .await?
            .ok_or(ChatError::ConversationNotFound)?;
        Ok((conversation, member))
    }

    /// 同上，并且这个会话必须是群。
    async fn group_membership(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(Conversation, Member), ChatError> {
        let (conversation, member) = self.membership(me, conversation).await?;
        if conversation.kind != ConversationKind::Group {
            return Err(ChatError::ConversationNotFound);
        }
        Ok((conversation, member))
    }

    /// 我还在这个群里，并且群没有解散。
    async fn active_in_open_group(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(Conversation, Member), ChatError> {
        let (conversation, member) = self.group_membership(me, conversation).await?;
        if !member.is_active() {
            return Err(ChatError::LeftGroup);
        }
        if conversation.dissolved {
            return Err(ChatError::GroupDissolved);
        }
        Ok((conversation, member))
    }

    /// 同上，并且我是群主或管理员。
    async fn manager_of_open_group(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(Conversation, Member), ChatError> {
        let (conversation, member) = self.active_in_open_group(me, conversation).await?;
        if !manages(&conversation, &member) {
            return Err(ChatError::NotManager);
        }
        Ok((conversation, member))
    }

    /// 群主和现在的管理员。
    async fn managers(&self, conversation: &Conversation) -> Result<Vec<UserId>, ChatError> {
        let members = self.deps.chat.list_members(conversation.id).await?;
        Ok(members
            .iter()
            .filter(|member| member.is_active() && manages(conversation, member))
            .map(|member| member.user)
            .collect())
    }

    /// 我能不能对 `user` 做移出、禁言这样的事：群主对谁都可以（除了自己），
    /// 管理员只能对普通成员。
    async fn may_manage(
        &self,
        me: &User,
        conversation: &Conversation,
        user: UserId,
    ) -> Result<(), ChatError> {
        if conversation.is_owner(me.id) {
            return Ok(());
        }
        if conversation.is_owner(user) {
            return Err(ChatError::NotOwner);
        }
        let target = self.deps.chat.find_member(conversation.id, user).await?;
        if target.is_some_and(|target| target.is_active() && target.admin) {
            return Err(ChatError::NotOwner);
        }
        Ok(())
    }

    /// 同上，并且我是群主。
    async fn owner_of_open_group(
        &self,
        me: &User,
        conversation: ConversationId,
    ) -> Result<(Conversation, Member), ChatError> {
        let (conversation, member) = self.active_in_open_group(me, conversation).await?;
        if conversation.owner != Some(me.id) {
            return Err(ChatError::NotOwner);
        }
        Ok((conversation, member))
    }

    /// 一批文件的登记信息，按编号。
    async fn files_by_id(&self, ids: &[FileId]) -> Result<HashMap<FileId, StoredFile>, ChatError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let found = self.deps.files.find_many(ids).await?;
        Ok(found.into_iter().map(|file| (file.id, file)).collect())
    }

    /// 显示同一个会话里的这些消息还要用到的东西，从 `viewer` 的角度：
    /// 所附的文件、被引用的消息、他播放过的语音。
    async fn extras(
        &self,
        conversation: ConversationId,
        visible: Visible,
        viewer: UserId,
        messages: &[&Message],
    ) -> Result<Extras, ChatError> {
        self.extras_as(conversation, visible, Some(viewer), messages)
            .await
    }

    /// 同上。`viewer` 为空是管理员在看：已撤回的消息和引用也带出内容，不管谁播放过语音。
    async fn extras_as(
        &self,
        conversation: ConversationId,
        visible: Visible,
        viewer: Option<UserId>,
        messages: &[&Message],
    ) -> Result<Extras, ChatError> {
        let reveal = viewer.is_none();
        let quoted_seqs: Vec<i64> = messages.iter().filter_map(|m| m.reply_to).collect();
        let quoted = if quoted_seqs.is_empty() {
            Vec::new()
        } else {
            self.deps
                .chat
                .find_messages(conversation, &quoted_seqs)
                .await?
        };
        // 被引用的消息只有看的人看得到、并且没有撤回时才带出内容
        let shown =
            |quoted: &&Message| visible.contains(quoted.seq) && (reveal || !quoted.is_recalled());

        // 消息所附的、聊天记录里的；被引用的只要它自己所附的那一个
        let file_ids: Vec<FileId> = messages
            .iter()
            .filter(|message| reveal || !message.is_recalled())
            .flat_map(|message| message.all_files())
            .chain(
                quoted
                    .iter()
                    .filter(shown)
                    .filter_map(|message| message.file),
            )
            .collect();
        let files = self.files_by_id(&file_ids).await?;

        let quoted_senders: HashSet<UserId> = quoted
            .iter()
            .filter(shown)
            .filter_map(|message| message.sender)
            .collect();
        let quoted_senders: Vec<UserId> = quoted_senders.into_iter().collect();
        let names: HashMap<UserId, String> = if quoted_senders.is_empty() {
            HashMap::new()
        } else {
            self.deps
                .users
                .find_many(&quoted_senders)
                .await?
                .into_iter()
                .map(|user| (user.id, user.nickname))
                .collect()
        };
        let mut quotes = HashMap::new();
        for seq in quoted_seqs {
            let quote = match quoted.iter().find(|message| message.seq == seq) {
                Some(message) if !visible.contains(message.seq) => Quote::Unavailable,
                Some(message) if message.is_recalled() && !reveal => Quote::Recalled,
                Some(message) => Quote::Shown {
                    sender: message.sender,
                    sender_name: message.sender.and_then(|id| names.get(&id)).cloned(),
                    kind: message.kind,
                    // 聊天记录引用的是它的标题
                    text: match &message.data.record {
                        Some(record) => Some(&record.title),
                        None => message.text.as_ref(),
                    }
                    .map(|text| text.chars().take(QUOTE_MAX_CHARS).collect()),
                    file_name: message
                        .file
                        .and_then(|file| files.get(&file))
                        .and_then(|file| file.name.clone()),
                },
                None => Quote::Unavailable,
            };
            quotes.insert(seq, quote);
        }

        let voices: Vec<MessageId> = messages
            .iter()
            .filter(|message| message.kind == MessageKind::Voice && !message.is_recalled())
            .filter(|message| message.sender != viewer)
            .map(|message| message.id)
            .collect();
        let played = match viewer {
            Some(viewer) if !voices.is_empty() => {
                let found = self.deps.chat.played(viewer, &voices).await?;
                found.into_iter().collect()
            }
            _ => HashSet::new(),
        };
        Ok(Extras {
            files,
            quotes,
            played,
        })
    }

    /// 现在在会话里的人。
    async fn active_members(&self, conversation: ConversationId) -> Result<Vec<UserId>, ChatError> {
        let members = self.deps.chat.list_members(conversation).await?;
        Ok(members
            .iter()
            .filter(|member| member.is_active())
            .map(|member| member.user)
            .collect())
    }

    /// 群里的一名在群成员，用在事件里。
    async fn member_party(
        &self,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Party, ChatError> {
        if !self.active_members(conversation).await?.contains(&user) {
            return Err(ChatError::NotMember);
        }
        let found = self.deps.users.find(user).await?;
        found.as_ref().map(party).ok_or(ChatError::NotMember)
    }

    /// 确认这些人都是我的好友，返回他们在事件里的样子，顺序与给的一致。
    async fn friends_of(&self, me: &User, users: &[UserId]) -> Result<Vec<Party>, ChatError> {
        for user in users {
            if !self.are_friends(me.id, *user).await? {
                return Err(ChatError::NotFriends);
            }
        }
        let found: HashMap<UserId, User> = self
            .deps
            .users
            .find_many(users)
            .await?
            .into_iter()
            .map(|user| (user.id, user))
            .collect();
        users
            .iter()
            .map(|id| found.get(id).map(party).ok_or(ChatError::NotFriends))
            .collect()
    }

    fn event(
        &self,
        conversation: ConversationId,
        kind: MessageKind,
        data: MessageData,
    ) -> NewMessage {
        NewMessage {
            id: MessageId::new(),
            conversation,
            sender: None,
            client_id: None,
            kind,
            text: None,
            data,
            file: None,
            reply_to: None,
            created_at: self.deps.clock.now_ms(),
        }
    }

    /// 改动一个群并写入对应的事件。人数超过上限时报错；没有可以改的返回 `None`。
    async fn change(
        &self,
        conversation: ConversationId,
        kind: MessageKind,
        data: MessageData,
        change: Change,
    ) -> Result<Option<Message>, ChatError> {
        let event = self.event(conversation, kind, data);
        match self.deps.chat.apply(&event, &change).await? {
            Changed::Done(message) => Ok(Some(*message)),
            Changed::Full { room } => Err(ChatError::GroupFull { room }),
            Changed::Nothing => Ok(None),
        }
    }

    /// 改动一个群，并通知现在在群的全部成员。
    async fn announce(
        &self,
        conversation: ConversationId,
        kind: MessageKind,
        data: MessageData,
        change: Change,
    ) -> Result<Posted, ChatError> {
        let message = self
            .change(conversation, kind, data, change)
            .await?
            .ok_or(ChatError::ConversationNotFound)?;
        self.to_active_members(message).await
    }

    async fn to_active_members(&self, message: Message) -> Result<Posted, ChatError> {
        let members = self.active_members(message.conversation).await?;
        Ok(posted(message, members))
    }

    async fn are_friends(&self, a: UserId, b: UserId) -> Result<bool, ChatError> {
        Ok(self.deps.contacts.find_friendship(a, b).await?.is_some())
    }

    /// 群人数上限：管理员设置过就用设置的，否则用默认值。
    pub async fn max_members(&self) -> Result<u32, ChatError> {
        let configured = self.deps.settings.get(GROUP_MAX_MEMBERS_SETTING).await?;
        Ok(configured
            .and_then(|value| value.parse().ok())
            // 建群至少三个人，上限比这还小就没法用了
            .filter(|limit| *limit >= 3)
            .unwrap_or(GROUP_MAX_MEMBERS_DEFAULT))
    }
}

fn posted(message: Message, members: Vec<UserId>) -> Posted {
    Posted {
        message,
        duplicate: false,
        sender_name: None,
        members,
        extras: Extras::default(),
        quote_hidden_from: Vec::new(),
    }
}

fn party(user: &User) -> Party {
    Party {
        id: user.id,
        nickname: user.nickname.clone(),
    }
}

/// 没有起名的群用哪几个成员的名称来显示：在群的成员里最早加入的几个，包括我自己。
fn hinted(listing: &Listing) -> Vec<&Member> {
    let mut members: Vec<&Member> = std::iter::once(&listing.me)
        .chain(&listing.others)
        .filter(|member| member.is_active())
        .collect();
    members.sort_by_key(|member| (member.since, member.user));
    members.truncate(NAME_HINT_MEMBERS);
    members
}

/// 去掉重复的和自己，保持给的顺序。
fn distinct(users: &[UserId], me: UserId) -> Vec<UserId> {
    let mut seen = HashSet::new();
    users
        .iter()
        .copied()
        .filter(|user| *user != me && seen.insert(*user))
        .collect()
}

fn is_valid_client_id(client_id: &str) -> bool {
    !client_id.is_empty()
        && client_id.len() <= CLIENT_ID_MAX_CHARS
        && client_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 整理消息的文字：保留换行和制表符，去掉其余的控制字符和首尾的空白。
fn clean_text(text: &str) -> Result<String, ChatError> {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .collect();
    let text = text.trim();
    if text.is_empty() {
        return Err(ChatError::MessageEmpty);
    }
    if text.chars().count() > MESSAGE_MAX_CHARS {
        return Err(ChatError::MessageTooLong);
    }
    Ok(text.to_owned())
}

/// 这个成员被禁言到什么时候。没有禁言、或者已经到时间了为空。
fn muted_until(member: &Member, now: i64) -> Option<i64> {
    member.muted_until.filter(|until| *until > now)
}

/// 这个成员现在能不能在群里说话：没有被禁言，全员禁言时是群主或管理员。
fn silenced(conversation: &Conversation, member: &Member, now: i64) -> Result<(), ChatError> {
    if let Some(until) = muted_until(member, now) {
        return Err(ChatError::Muted { until });
    }
    if conversation.all_muted && !manages(conversation, member) {
        return Err(ChatError::AllMuted);
    }
    Ok(())
}

/// 这个成员能不能管理这个群：群主，或者还在群里的管理员。
fn manages(conversation: &Conversation, member: &Member) -> bool {
    conversation.is_owner(member.user) || (member.is_active() && member.admin)
}

/// 能转发的：文字、图片、文件、语音、聊天记录，没有撤回的。
fn is_forwardable(message: &Message) -> bool {
    let kind = matches!(
        message.kind,
        MessageKind::Text
            | MessageKind::Image
            | MessageKind::File
            | MessageKind::Voice
            | MessageKind::ChatRecord
    );
    kind && !message.is_recalled()
}

/// 整理一行字：去掉控制字符和首尾的空白。
fn clean_line(text: &str) -> String {
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    text.trim().to_owned()
}

/// 整理群公告：去掉首尾空白，最多 1000 字。什么都不剩就是清空。
fn clean_notice(text: &str) -> Result<Option<String>, ChatError> {
    let text = text.trim();
    if text.chars().count() > NOTICE_MAX_CHARS {
        return Err(ChatError::Invalid("the notice is too long"));
    }
    Ok((!text.is_empty()).then(|| text.to_owned()))
}

/// 整理群名：一行字，去掉首尾的空白；空的就是没有起名。
fn clean_group_name(name: &str) -> Result<Option<String>, ChatError> {
    let name: String = name.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim();
    if name.chars().count() > GROUP_NAME_MAX_CHARS {
        return Err(ChatError::GroupNameTooLong);
    }
    Ok((!name.is_empty()).then(|| name.to_owned()))
}
