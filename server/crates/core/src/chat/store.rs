//! 聊天相关的数据操作。实现在 `vibechat-infra`。

use async_trait::async_trait;

use super::model::{
    Appended, Change, Changed, Conversation, Edit, JoinRequest, JoinRequestStatus, Listing, Member,
    Message, MessageKind, NewGroup, NewMessage, Purged, SearchScope, Visible,
};
use crate::ids::{ConversationId, FileId, JoinRequestId, MessageId, UserId};
use crate::store::StoreError;

#[async_trait]
pub trait ChatStore: Send + Sync {
    /// 两个人的单聊会话：已经有了就返回原来的，没有就用 `id` 创建，连同两个成员。
    /// 两处同时调用时也只会有一个会话。
    async fn open_direct(
        &self,
        id: ConversationId,
        a: UserId,
        b: UserId,
        now: i64,
    ) -> Result<Conversation, StoreError>;

    /// 创建一个群：会话、全部成员和"建群"这条事件，要么都成功要么都不发生。
    async fn create_group(&self, group: &NewGroup) -> Result<(Conversation, Message), StoreError>;

    /// 改动一个群，并把对应的事件写进会话日志，两件事在同一个事务里。
    async fn apply(&self, event: &NewMessage, change: &Change) -> Result<Changed, StoreError>;

    async fn find_conversation(
        &self,
        id: ConversationId,
    ) -> Result<Option<Conversation>, StoreError>;

    /// 一个用户在一个会话里的成员记录。离开了的人也有。
    async fn find_member(
        &self,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Option<Member>, StoreError>;

    /// 一个会话的全部成员，包括已经离开的，按加入的先后。
    async fn list_members(&self, conversation: ConversationId) -> Result<Vec<Member>, StoreError>;

    /// 往会话日志里写入一条：把会话的序号加一，用它作为这一条的序号，两件事在同一个事务里。
    /// 许多人同时写入时，序号各不相同并且连续。
    ///
    /// 带有客户端消息编号、并且这个发送人在这个会话里用过同一个编号时，不写入，
    /// 返回当时写入的那一条。
    ///
    /// 消息 @ 了人时，同时记下这些成员"最近一次被 @ 的序号"。
    ///
    /// 一个文件只能属于一条消息：带着已经被别的消息用过的文件时写入失败。
    async fn append(&self, message: &NewMessage) -> Result<Appended, StoreError>;

    /// 一个会话里指定序号的那几条。不看谁能看到谁不能，由调用的地方去判断。
    async fn find_messages(
        &self,
        conversation: ConversationId,
        seqs: &[i64],
    ) -> Result<Vec<Message>, StoreError>;

    /// 附着这个文件的那条消息。
    async fn find_by_file(&self, file: FileId) -> Result<Option<Message>, StoreError>;

    /// 撤回序号为 `seq` 的那条消息：做上标记，并把 `event` 写进会话日志，两件事在同一个事务里。
    /// 那条消息不存在或者已经撤回过时什么也不做，返回 `None`。
    async fn recall(&self, event: &NewMessage, seq: i64) -> Result<Option<Message>, StoreError>;

    /// 编辑序号为 `seq` 的那条消息（F8）：换上 `change` 的文字和 @、记下编辑时间，并把 `event`
    /// 写进会话日志，两件事在同一个事务里。`event` 里 @ 的是这一次新 @ 到的人，给他们记上提醒。
    /// 那条消息不存在或者已经撤回时什么也不做，返回 `None`。
    async fn edit(
        &self,
        event: &NewMessage,
        seq: i64,
        change: &Edit,
    ) -> Result<Option<Message>, StoreError>;

    /// 记下一个人播放了一条语音。以前记过时返回 `false`。
    async fn mark_played(
        &self,
        message: MessageId,
        user: UserId,
        now: i64,
    ) -> Result<bool, StoreError>;

    /// 这些消息里，这个人播放过的。
    async fn played(
        &self,
        user: UserId,
        messages: &[MessageId],
    ) -> Result<Vec<MessageId>, StoreError>;

    /// 一个人的全部成员记录，包括已经离开的群和从列表移除了的会话。
    async fn memberships(&self, user: UserId) -> Result<Vec<Member>, StoreError>;

    /// 在这些范围里找内容包含 `needle` 的消息：文本消息看文字，图片看文字说明，文件消息看文件名。
    /// 不含已撤回的。英文不区分大小写；`needle` 里的任何字符都按字面匹配。
    /// 从新到旧，最多 `limit` 条。
    async fn search(
        &self,
        scopes: &[SearchScope],
        needle: &str,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError>;

    /// 序号小于 `before` 的最新 `limit` 条（不指定则从最新的算起），按序号从小到大。
    /// 只返回 `visible` 范围里的。
    async fn list_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError>;

    /// 某一种（图片或文件）的、没有撤回的消息里，序号小于 `before` 的最新 `limit` 条，
    /// 按序号从小到大。只返回 `visible` 范围里的。会话的图片和文件一览用（F6）。
    async fn list_kind_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        kind: MessageKind,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError>;

    /// 序号大于 `after` 的最早 `limit` 条，按序号从小到大。只返回 `visible` 范围里的。
    async fn list_after(
        &self,
        conversation: ConversationId,
        visible: Visible,
        after: i64,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError>;

    /// 把一个成员的已读位置前移到 `seq`。位置只前进不后退：没有前进时返回 `false`。
    async fn advance_read(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError>;

    /// 记下一个成员在序号 `seq` 时把会话从列表移除了。
    async fn hide(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError>;

    /// 把一个会话对一个成员设为免打扰，或者取消。
    /// 这个人把这个会话的记录清空到第 `seq` 条（F6）：清空的位置只往后挪，已读位置跟着挪过去。
    async fn clear(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError>;

    /// 这个人把这几条从自己这边删掉（F6）。以前删过的不重复记。
    async fn delete_for(
        &self,
        conversation: ConversationId,
        user: UserId,
        seqs: &[i64],
        now: i64,
    ) -> Result<(), StoreError>;

    /// 置顶（给出置顶的时间）或者取消（为空）。只是这个人自己的设置。
    async fn set_pinned(
        &self,
        conversation: ConversationId,
        user: UserId,
        pinned_at: Option<i64>,
    ) -> Result<(), StoreError>;

    async fn set_muted(
        &self,
        conversation: ConversationId,
        user: UserId,
        muted: bool,
    ) -> Result<(), StoreError>;

    /// 开关入群审批。返回改了没有。
    async fn set_join_approval(
        &self,
        conversation: ConversationId,
        on: bool,
    ) -> Result<bool, StoreError>;

    /// 记下一条入群申请。同一个群、同一个被邀请人已经有一条待处理的（在 `cutoff` 之后发出的）时
    /// 什么也不做，返回假；更早的那条算过期，不挡着。
    async fn add_join_request(
        &self,
        request: &JoinRequest,
        cutoff: i64,
    ) -> Result<bool, StoreError>;

    /// 一个群的全部入群申请，新的在前。
    async fn list_join_requests(
        &self,
        conversation: ConversationId,
    ) -> Result<Vec<JoinRequest>, StoreError>;

    async fn find_join_request(&self, id: JoinRequestId)
    -> Result<Option<JoinRequest>, StoreError>;

    /// 处理一条申请：同意或拒绝。只有待处理、并且在 `cutoff` 之后发出的才处理得了；
    /// 两处同时处理时只有一处成功。返回这一次处理了没有。
    async fn settle_join_request(
        &self,
        id: JoinRequestId,
        status: JoinRequestStatus,
        by: UserId,
        now: i64,
        cutoff: i64,
    ) -> Result<bool, StoreError>;

    /// 同意之后人却加不进去（群满了）：把申请退回待处理。
    async fn reopen_join_request(&self, id: JoinRequestId) -> Result<(), StoreError>;

    /// 改一个在群的成员的群内昵称；为空是去掉。返回改了没有：不在群里、和原来一样都算没改。
    async fn set_nickname(
        &self,
        conversation: ConversationId,
        user: UserId,
        nickname: Option<String>,
    ) -> Result<bool, StoreError>;

    /// 记下一个成员看过了哪一次的群公告（发布它的事件的序号）。只前进不后退。
    /// 返回这一次是否前进了。
    async fn mark_notice_seen(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError>;

    /// 一个用户的会话列表：只含现在应当显示的会话（见 `Member::lists`），顺序不保证。
    async fn list_for_user(&self, user: UserId) -> Result<Vec<Listing>, StoreError>;

    /// 一个用户现在所在的全部群，不管它们在不在他的会话列表里。
    async fn list_groups(&self, user: UserId) -> Result<Vec<Conversation>, StoreError>;

    /// 一批会话。不存在的直接略过。
    async fn find_conversations(
        &self,
        ids: &[ConversationId],
    ) -> Result<Vec<Conversation>, StoreError>;

    /// 系统里全部的群（包括已经解散的），新建的在前。`search` 在群名里找，包含匹配。
    /// 同时返回符合条件的一共有多少。管理员用。
    async fn list_all_groups(
        &self,
        search: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<Conversation>, u64), StoreError>;

    /// 现在有多少个群。已经解散的不算。
    async fn count_groups(&self) -> Result<u64, StoreError>;

    /// 删除发送时间早于 `cutoff` 的消息。每个会话里只从最早的删起：
    /// 删到第一条没有过期的为止，剩下的仍然是连续的一段。
    async fn purge_before(&self, cutoff: i64) -> Result<Purged, StoreError>;
}
