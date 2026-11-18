//! WebSocket 上的消息。类型名按模块分命名空间：`sys.*`、`msg.*`、`conv.*`、`contact.*`、`call.*`。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::account::Me;
use crate::call::{CallSignal, CallView, GroupCallView};
use crate::chat::{
    ConversationCleared, ConversationHidden, ConversationMuted, ConversationPinned,
    ConversationRead, JoinRequestsChanged, MembersChanged, MessagePlayed, MessageView,
    MessagesDeleted, NoticeSeen,
};
use crate::contact::{FriendProfile, FriendRemoved, FriendRequestView, FriendView};

/// 服务端推给客户端的事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data")]
#[ts(export)]
pub enum ServerEvent {
    /// 连接建立后的第一条消息。
    #[serde(rename = "sys.hello")]
    SysHello(SysHello),
    /// 对 `sys.ping` 的应答。
    #[serde(rename = "sys.pong")]
    SysPong,
    /// 这台设备在我的另一台设备上被退出登录了（F9）。紧接着连接就会断开。
    #[serde(rename = "sys.signed_out")]
    SysSignedOut,
    /// 自己的资料变了（可能是在另一处登录里改的）。
    #[serde(rename = "me.updated")]
    MeUpdated(Me),
    /// 一条与我有关的好友申请是新的，或者变了：收到了新的申请，或者申请被同意、被拒绝了。
    #[serde(rename = "contact.request")]
    ContactRequest(FriendRequestView),
    /// 我多了一个好友，或者这个好友在我这边的记录变了（例如在另一处登录里改了备注）。
    #[serde(rename = "contact.friend")]
    ContactFriend(FriendView),
    /// 一个人不再是我的好友了。
    #[serde(rename = "contact.friend_removed")]
    ContactFriendRemoved(FriendRemoved),
    /// 一个好友改了自己的资料。
    #[serde(rename = "contact.profile")]
    ContactProfile(FriendProfile),
    /// 我所在的会话里多了一条：别人发来的消息，我自己在别处发的消息，或者一个事件。
    #[serde(rename = "msg.new")]
    // 一条消息带的东西比别的事件多得多，放在堆上，免得每个事件都占这么大的地方
    MsgNew(Box<MessageView>),
    /// 会话里一个成员的已读位置前进了。可能是对方，也可能是我自己在别处看过了。
    #[serde(rename = "conv.read")]
    ConvRead(ConversationRead),
    /// 我在别处把一个会话从列表里移除了。
    #[serde(rename = "conv.hidden")]
    ConvHidden(ConversationHidden),
    /// 我在别处听过了一条语音。
    #[serde(rename = "msg.played")]
    MsgPlayed(MessagePlayed),
    /// 我在别处把一个会话设成了免打扰，或者取消了。
    #[serde(rename = "conv.muted")]
    ConvMuted(ConversationMuted),
    /// 我在别处把一个会话置顶了，或者取消了。
    #[serde(rename = "conv.pinned")]
    ConvPinned(ConversationPinned),
    /// 会话里有人正在输入（F8）。几秒之内没有新的就当他停下了；他的消息到了也就停下了。
    #[serde(rename = "conv.typing")]
    ConvTyping(Typing),
    /// 我在别处把几条从自己这边删掉了。
    #[serde(rename = "msg.deleted")]
    MsgDeleted(MessagesDeleted),
    /// 我在别处清空了一个会话的记录。
    #[serde(rename = "conv.cleared")]
    ConvCleared(ConversationCleared),
    /// 我在别处看过了一个群的公告。
    #[serde(rename = "conv.notice_seen")]
    ConvNoticeSeen(NoticeSeen),
    /// 一个群的成员名单变了，没有留下提示：例如有人改了群内昵称。
    #[serde(rename = "conv.members")]
    ConvMembers(MembersChanged),
    /// 一个群的入群申请变了：推给群主、管理员，以及申请的邀请人。
    #[serde(rename = "conv.join_requests")]
    ConvJoinRequests(JoinRequestsChanged),
    /// 我参与的一个通话变了：有人打来（响铃）、接通、结束。推给双方的每一台设备。
    #[serde(rename = "call.updated")]
    CallUpdated(CallView),
    /// 对方发来的建立连接用的信息。只推给通话里的那一台设备。
    #[serde(rename = "call.signal")]
    CallSignal(CallSignal),
    /// 一个群通话有变化（F10）：有人发起、加入、离开，邀请开始或不再响，通话结束。推给群里的全体成员。
    #[serde(rename = "group_call.updated")]
    GroupCallUpdated(GroupCallView),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SysHello {
    pub server_version: String,
    /// 客户端应当每隔这么久发一次 `sys.ping`。
    pub heartbeat_interval_ms: u32,
}

/// 会话里有人正在输入（F8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Typing {
    pub conversation_id: String,
    pub user_id: String,
}

/// 页面告诉服务端：我在这个会话的输入框里打字（F8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TypingStarted {
    pub conversation_id: String,
}

/// 客户端发给服务端的消息。写操作都走 HTTP，这里只有心跳和"正在输入"：
/// 后者很频繁、过几秒就没用了，不存下来。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data")]
#[ts(export)]
pub enum ClientMessage {
    #[serde(rename = "sys.ping")]
    SysPing,
    #[serde(rename = "conv.typing")]
    ConvTyping(TypingStarted),
}

#[cfg(test)]
mod tests {
    use super::*;

    // 这些格式是与客户端的约定，改动会让已经打开的页面无法解析

    #[test]
    fn hello_is_tagged_with_type_and_data() {
        let event = ServerEvent::SysHello(SysHello {
            server_version: "0.1.0".to_owned(),
            heartbeat_interval_ms: 30_000,
        });
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"sys.hello","data":{"server_version":"0.1.0","heartbeat_interval_ms":30000}}"#
        );
    }

    #[test]
    fn pong_has_no_data() {
        assert_eq!(
            serde_json::to_string(&ServerEvent::SysPong).unwrap(),
            r#"{"type":"sys.pong"}"#
        );
    }

    #[test]
    fn contact_events_are_in_the_contact_namespace() {
        let user = crate::contact::UserCard {
            id: "u1".to_owned(),
            handle: "xiao_hong".to_owned(),
            nickname: "小红".to_owned(),
            avatar_file_id: None,
        };
        let removed = ServerEvent::ContactFriendRemoved(FriendRemoved {
            user_id: "u1".to_owned(),
        });
        assert_eq!(
            serde_json::to_string(&removed).unwrap(),
            r#"{"type":"contact.friend_removed","data":{"user_id":"u1"}}"#
        );

        let request = ServerEvent::ContactRequest(FriendRequestView {
            id: "r1".to_owned(),
            direction: crate::contact::FriendRequestDirection::Received,
            user: user.clone(),
            message: "你好".to_owned(),
            status: crate::contact::FriendRequestStatus::Pending,
            sent_at: 1,
            handled_at: None,
        });
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["type"], "contact.request");
        assert_eq!(json["data"]["direction"], "received");
        assert_eq!(json["data"]["status"], "pending");
        assert_eq!(json["data"]["user"]["nickname"], "小红");

        let friend = ServerEvent::ContactFriend(FriendView {
            user: user.clone(),
            signature: String::new(),
            remark: None,
            since: 1,
        });
        assert_eq!(
            serde_json::to_value(&friend).unwrap()["type"],
            "contact.friend"
        );
        let profile = ServerEvent::ContactProfile(FriendProfile {
            user,
            signature: String::new(),
        });
        assert_eq!(
            serde_json::to_value(&profile).unwrap()["type"],
            "contact.profile"
        );
    }

    #[test]
    fn chat_events_are_in_the_msg_and_conv_namespaces() {
        let message = ServerEvent::MsgNew(Box::new(MessageView {
            id: "m1".to_owned(),
            conversation_id: "c1".to_owned(),
            seq: 7,
            sender_id: Some("u1".to_owned()),
            client_id: Some("k1".to_owned()),
            kind: crate::chat::MessageKind::Text,
            text: Some("你好".to_owned()),
            sender_name: None,
            actor: None,
            targets: Vec::new(),
            name: None,
            mentions: vec!["u2".to_owned()],
            mention_all: false,
            file: None,
            duration_ms: None,
            record: None,
            call_outcome: None,
            call_video: false,
            call_joined: None,
            approver: None,
            until: None,
            reply: None,
            recalled: false,
            target_seq: None,
            played: false,
            edited_at: None,
            previous_text: None,
            created_at: 1,
        }));
        let json = serde_json::to_value(&message).unwrap();
        assert_eq!(json["type"], "msg.new");
        assert_eq!(json["data"]["seq"], 7);
        assert_eq!(json["data"]["kind"], "text");
        assert_eq!(json["data"]["client_id"], "k1");
        assert_eq!(json["data"]["mentions"][0], "u2");
        assert_eq!(json["data"]["sender_name"], serde_json::Value::Null);

        // 事件的类型都是小写加下划线
        let kind = |kind| serde_json::to_value::<crate::chat::MessageKind>(kind).unwrap();
        assert_eq!(
            kind(crate::chat::MessageKind::MemberJoined),
            "member_joined"
        );
        assert_eq!(
            kind(crate::chat::MessageKind::OwnerChanged),
            "owner_changed"
        );

        let read = ServerEvent::ConvRead(ConversationRead {
            conversation_id: "c1".to_owned(),
            user_id: "u1".to_owned(),
            read_seq: 7,
        });
        assert_eq!(
            serde_json::to_string(&read).unwrap(),
            r#"{"type":"conv.read","data":{"conversation_id":"c1","user_id":"u1","read_seq":7}}"#
        );

        let hidden = ServerEvent::ConvHidden(ConversationHidden {
            conversation_id: "c1".to_owned(),
        });
        assert_eq!(
            serde_json::to_string(&hidden).unwrap(),
            r#"{"type":"conv.hidden","data":{"conversation_id":"c1"}}"#
        );

        let played = ServerEvent::MsgPlayed(crate::chat::MessagePlayed {
            conversation_id: "c1".to_owned(),
            seq: 7,
        });
        assert_eq!(
            serde_json::to_string(&played).unwrap(),
            r#"{"type":"msg.played","data":{"conversation_id":"c1","seq":7}}"#
        );
        let muted = ServerEvent::ConvMuted(crate::chat::ConversationMuted {
            conversation_id: "c1".to_owned(),
            muted: true,
        });
        assert_eq!(
            serde_json::to_string(&muted).unwrap(),
            r#"{"type":"conv.muted","data":{"conversation_id":"c1","muted":true}}"#
        );
        assert_eq!(kind(crate::chat::MessageKind::Recalled), "recalled");
        assert_eq!(kind(crate::chat::MessageKind::Voice), "voice");
    }

    #[test]
    fn ping_is_parsed() {
        let message: ClientMessage = serde_json::from_str(r#"{"type":"sys.ping"}"#).unwrap();
        assert_eq!(message, ClientMessage::SysPing);
    }
}
