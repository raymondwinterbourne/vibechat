//! 业务对象到接口响应的转换。密码哈希等内部字段不会出现在这里。

use vibechat_core::UserId;
use vibechat_core::account::model::{self, InviteCode, StoredFile, User};
use vibechat_core::admin::model as admin;
use vibechat_core::call;
use vibechat_core::chat;
use vibechat_core::contact;
use vibechat_protocol::{
    AdminConversationView, AdminMemberView, AdminUserView, AuditAction, AuditEntryView,
    CallOutcome, ChatRecordView, ConversationKind, ConversationPeer, ConversationView, EventParty,
    FileView, FriendProfile, FriendRequestDirection, FriendRequestStatus, FriendRequestView,
    FriendView, GroupView, InviteCodeStatus, InviteCodeUser, InviteCodeView, JoinRequestStatus,
    JoinRequestView, Language, Me, MemberProfile, MemberView, MessageKind, MessageView, NoticeView,
    QuoteState, QuoteView, RecordItemView, Relation, Role, Theme, UserCard, UserStatus,
};

fn role(role: model::Role) -> Role {
    match role {
        model::Role::User => Role::User,
        model::Role::Admin => Role::Admin,
    }
}

pub fn me(user: &User) -> Me {
    Me {
        id: user.id.to_string(),
        handle: user.handle.clone(),
        nickname: user.nickname.clone(),
        signature: user.signature.clone(),
        avatar_file_id: user.avatar.map(|id| id.to_string()),
        role: role(user.role),
        must_change_password: user.must_change_password,
        email: user.email.clone(),
        language: user.language.map(|language| match language {
            model::Language::ZhCn => Language::ZhCn,
            model::Language::En => Language::En,
        }),
        theme: user.theme.map(|theme| match theme {
            model::Theme::Light => Theme::Light,
            model::Theme::Dark => Theme::Dark,
            model::Theme::System => Theme::System,
        }),
        created_at: user.created_at,
    }
}

pub fn language(language: Language) -> model::Language {
    match language {
        Language::ZhCn => model::Language::ZhCn,
        Language::En => model::Language::En,
    }
}

pub fn theme(theme: Theme) -> model::Theme {
    match theme {
        Theme::Light => model::Theme::Light,
        Theme::Dark => model::Theme::Dark,
        Theme::System => model::Theme::System,
    }
}

pub fn invite_code(invite: &InviteCode, used_by: Option<&User>, now: i64) -> InviteCodeView {
    let status = match invite.state(now) {
        model::InviteCodeState::Unused => InviteCodeStatus::Unused,
        model::InviteCodeState::Used => InviteCodeStatus::Used,
        model::InviteCodeState::Expired => InviteCodeStatus::Expired,
        model::InviteCodeState::Revoked => InviteCodeStatus::Revoked,
    };
    InviteCodeView {
        id: invite.id.to_string(),
        code: invite.code.clone(),
        status,
        note: invite.note.clone(),
        created_at: invite.created_at,
        expires_at: invite.expires_at,
        used_by: used_by.map(|user| InviteCodeUser {
            id: user.id.to_string(),
            handle: user.handle.clone(),
            nickname: user.nickname.clone(),
        }),
        used_at: invite.used_at,
    }
}

pub fn user_card(card: &contact::UserCard) -> UserCard {
    UserCard {
        id: card.id.to_string(),
        handle: card.handle.clone(),
        nickname: card.nickname.clone(),
        avatar_file_id: card.avatar.map(|id| id.to_string()),
    }
}

pub fn relation(relation: contact::Relation) -> Relation {
    match relation {
        contact::Relation::Myself => Relation::Myself,
        contact::Relation::Friend => Relation::Friend,
        contact::Relation::RequestSent => Relation::RequestSent,
        contact::Relation::RequestReceived(_) => Relation::RequestReceived,
        contact::Relation::None => Relation::None,
    }
}

/// 一条好友申请在 `viewer` 眼里的样子。`other` 是对方。
pub fn friend_request(
    request: &contact::FriendRequest,
    other: &contact::UserCard,
    viewer: UserId,
) -> FriendRequestView {
    FriendRequestView {
        id: request.id.to_string(),
        direction: if request.from == viewer {
            FriendRequestDirection::Sent
        } else {
            FriendRequestDirection::Received
        },
        user: user_card(other),
        message: request.message.clone(),
        status: match request.status {
            contact::FriendRequestStatus::Pending => FriendRequestStatus::Pending,
            contact::FriendRequestStatus::Accepted => FriendRequestStatus::Accepted,
            contact::FriendRequestStatus::Rejected => FriendRequestStatus::Rejected,
        },
        sent_at: request.sent_at,
        handled_at: request.handled_at,
    }
}

pub fn friend(friend: &contact::Friend) -> FriendView {
    FriendView {
        user: user_card(&friend.card),
        signature: friend.signature.clone(),
        remark: friend.remark.clone(),
        since: friend.since,
    }
}

/// 一个用户的资料里好友看得到的部分。
pub fn friend_profile(user: &User) -> FriendProfile {
    FriendProfile {
        user: user_card(&contact::UserCard::from(user)),
        signature: user.signature.clone(),
    }
}

pub fn file(file: &StoredFile) -> FileView {
    let image = file.is_image();
    FileView {
        id: file.id.to_string(),
        name: file.name.clone().unwrap_or_default(),
        size: file.size,
        width: file.width.filter(|_| image).map(|width| width as u32),
        height: file.height.filter(|_| image).map(|height| height as u32),
        audio: file.is_audio(),
    }
}

fn message_kind(kind: chat::MessageKind) -> MessageKind {
    match kind {
        chat::MessageKind::Text => MessageKind::Text,
        chat::MessageKind::Image => MessageKind::Image,
        chat::MessageKind::File => MessageKind::File,
        chat::MessageKind::Voice => MessageKind::Voice,
        chat::MessageKind::ChatRecord => MessageKind::ChatRecord,
        chat::MessageKind::Recalled => MessageKind::Recalled,
        chat::MessageKind::Edited => MessageKind::Edited,
        chat::MessageKind::Friends => MessageKind::Friends,
        chat::MessageKind::GroupCreated => MessageKind::GroupCreated,
        chat::MessageKind::MemberJoined => MessageKind::MemberJoined,
        chat::MessageKind::MemberLeft => MessageKind::MemberLeft,
        chat::MessageKind::MemberRemoved => MessageKind::MemberRemoved,
        chat::MessageKind::OwnerChanged => MessageKind::OwnerChanged,
        chat::MessageKind::AdminAdded => MessageKind::AdminAdded,
        chat::MessageKind::AdminRemoved => MessageKind::AdminRemoved,
        chat::MessageKind::MemberMuted => MessageKind::MemberMuted,
        chat::MessageKind::MemberUnmuted => MessageKind::MemberUnmuted,
        chat::MessageKind::AllMuted => MessageKind::AllMuted,
        chat::MessageKind::AllUnmuted => MessageKind::AllUnmuted,
        chat::MessageKind::Renamed => MessageKind::Renamed,
        chat::MessageKind::AvatarChanged => MessageKind::AvatarChanged,
        chat::MessageKind::Dissolved => MessageKind::Dissolved,
        chat::MessageKind::NoticeChanged => MessageKind::NoticeChanged,
        chat::MessageKind::Call => MessageKind::Call,
    }
}

/// 回复里被引用的那条消息。`quote` 为空说明没有查到它，和看不到是同一种回答。
fn quote(seq: i64, quote: Option<&chat::Quote>) -> QuoteView {
    let empty = |state| QuoteView {
        seq,
        state,
        sender_id: None,
        sender_name: None,
        kind: None,
        text: None,
        file_name: None,
    };
    match quote {
        Some(chat::Quote::Shown {
            sender,
            sender_name,
            kind,
            text,
            file_name,
        }) => QuoteView {
            sender_id: sender.map(|id| id.to_string()),
            sender_name: sender_name.clone(),
            kind: Some(message_kind(*kind)),
            text: text.clone(),
            file_name: file_name.clone(),
            ..empty(QuoteState::Shown)
        },
        Some(chat::Quote::Recalled) => empty(QuoteState::Recalled),
        Some(chat::Quote::Unavailable) | None => empty(QuoteState::Unavailable),
    }
}

/// 会话日志里的一条，交给普通用户的样子。已撤回的消息在这里去掉内容：
/// 除了管理员查看聊天内容的那一处，任何一条消息都要经过这里才会交出去。
pub fn message(
    message: &chat::Message,
    sender_name: Option<String>,
    extras: &chat::Extras,
) -> MessageView {
    revealed_message(&message.clone().redacted(), sender_name, extras)
}

/// 会话日志里的一条，原样交出：已撤回的消息仍然带着内容。只给管理员查看聊天内容用。
pub fn revealed_message(
    message: &chat::Message,
    sender_name: Option<String>,
    extras: &chat::Extras,
) -> MessageView {
    let party = |party: &chat::Party| EventParty {
        id: party.id.to_string(),
        nickname: party.nickname.clone(),
    };
    MessageView {
        id: message.id.to_string(),
        conversation_id: message.conversation.to_string(),
        seq: message.seq,
        sender_id: message.sender.map(|id| id.to_string()),
        client_id: message.client_id.clone(),
        kind: message_kind(message.kind),
        // 聊天记录的文字字段是给搜索用的，不交出去
        text: match message.kind {
            chat::MessageKind::ChatRecord => None,
            _ => message.text.clone(),
        },
        sender_name,
        actor: message.data.actor.as_ref().map(party),
        targets: message.data.targets.iter().map(party).collect(),
        name: message.data.name.clone(),
        mentions: message
            .data
            .mentions
            .iter()
            .map(ToString::to_string)
            .collect(),
        mention_all: message.data.mention_all,
        file: message.file.and_then(|id| extras.files.get(&id)).map(file),
        duration_ms: message.data.duration_ms,
        approver: message.data.approver.as_ref().map(party),
        until: message.data.until,
        record: message.data.record.as_ref().map(|record| ChatRecordView {
            title: record.title.clone(),
            items: record
                .items
                .iter()
                .map(|item| RecordItemView {
                    sender_id: item.sender.map(|id| id.to_string()),
                    sender_name: item.sender_name.clone(),
                    sender_avatar_file_id: item.sender_avatar.map(|id| id.to_string()),
                    kind: message_kind(item.kind),
                    text: item.text.clone(),
                    file: item.file.and_then(|id| extras.files.get(&id)).map(file),
                    duration_ms: item.duration_ms,
                    created_at: item.created_at,
                })
                .collect(),
        }),
        call_outcome: message.data.call.map(call_outcome),
        call_video: message.data.call_video,
        call_joined: message.data.call_joined,
        reply: message
            .reply_to
            .map(|seq| quote(seq, extras.quotes.get(&seq))),
        recalled: message.is_recalled(),
        target_seq: message.data.seq,
        played: extras.played.contains(&message.id),
        edited_at: message.edited_at,
        // 普通用户拿到的已经在 `redacted` 里去掉了
        previous_text: message.data.previous.clone(),
        created_at: message.created_at,
    }
}

pub fn conversation(info: &chat::ConversationInfo) -> ConversationView {
    let conversation = &info.conversation;
    ConversationView {
        id: conversation.id.to_string(),
        kind: conversation_kind(conversation.kind),
        peer: info.peer.as_ref().map(|peer| ConversationPeer {
            user: user_card(&peer.card),
            is_self: peer.is_self,
            remark: peer.remark.clone(),
            is_friend: peer.is_friend,
            read_seq: peer.read_seq,
        }),
        group: info.group.as_ref().map(|group| GroupView {
            name: conversation.name.clone(),
            name_hint: group.name_hint.clone(),
            avatar_file_id: conversation.avatar.map(|id| id.to_string()),
            owner_id: conversation.owner.map(|id| id.to_string()),
            dissolved: conversation.dissolved,
            member_count: group.member_count,
            max_members: group.max_members,
            left: group.left,
            mentioned: group.mentioned,
            notice: group.notice.as_ref().map(|notice| NoticeView {
                text: notice.text.clone(),
                by_id: notice.by.to_string(),
                by_name: notice.by_name.clone(),
                at: notice.at,
                seq: notice.seq,
            }),
            notice_unseen: group.notice_unseen,
            admin_ids: group.admins.iter().map(ToString::to_string).collect(),
            all_muted: group.all_muted,
            muted_until: group.muted_until,
            join_approval: group.join_approval,
            pending_requests: group.pending_requests,
        }),
        last_seq: info.last_seq,
        read_seq: info.read_seq,
        last_message: info.last_message.as_ref().map(|last| {
            // 列表里的摘要只用到所附文件的名字
            let extras = chat::Extras {
                files: info
                    .last_file
                    .iter()
                    .map(|file| (file.id, file.clone()))
                    .collect(),
                ..chat::Extras::default()
            };
            message(last, info.last_sender_name.clone(), &extras)
        }),
        unread: u32::try_from(info.unread).unwrap_or(u32::MAX),
        muted: info.muted,
        pinned_at: info.pinned_at,
    }
}

pub fn join_request(info: &chat::JoinRequestInfo) -> JoinRequestView {
    let request = &info.request;
    JoinRequestView {
        id: request.id.to_string(),
        inviter: user_card(&info.inviter),
        invitee: user_card(&info.invitee),
        status: match request.status {
            chat::JoinRequestStatus::Pending => JoinRequestStatus::Pending,
            chat::JoinRequestStatus::Approved => JoinRequestStatus::Approved,
            chat::JoinRequestStatus::Rejected => JoinRequestStatus::Rejected,
            chat::JoinRequestStatus::Expired => JoinRequestStatus::Expired,
        },
        created_at: request.created_at,
        handled_by_name: info.handled_by_name.clone(),
        handled_at: request.handled_at,
    }
}

pub fn member(member: &chat::MemberInfo) -> MemberView {
    MemberView {
        user: user_card(&member.card),
        remark: member.remark.clone(),
        is_friend: member.is_friend,
        is_owner: member.is_owner,
        is_admin: member.is_admin,
        group_nickname: member.group_nickname.clone(),
        muted_until: member.muted_until,
        active: member.active,
        joined_seq: member.joined_seq,
        read_seq: member.read_seq,
    }
}

pub fn member_profile(profile: &chat::MemberProfile) -> MemberProfile {
    MemberProfile {
        user: user_card(&profile.card),
        signature: profile.signature.clone(),
        remark: profile.remark.clone(),
        relation: relation(profile.relation),
        request_id: match profile.relation {
            contact::Relation::RequestReceived(id) => Some(id.to_string()),
            _ => None,
        },
    }
}

fn conversation_kind(kind: chat::ConversationKind) -> ConversationKind {
    match kind {
        chat::ConversationKind::Direct => ConversationKind::Direct,
        chat::ConversationKind::Group => ConversationKind::Group,
    }
}

pub fn admin_user(row: &admin::UserRow) -> AdminUserView {
    let user = &row.user;
    AdminUserView {
        id: user.id.to_string(),
        handle: user.handle.clone(),
        nickname: user.nickname.clone(),
        avatar_file_id: user.avatar.map(|id| id.to_string()),
        role: role(user.role),
        status: match user.status {
            model::UserStatus::Active => UserStatus::Active,
            model::UserStatus::Disabled => UserStatus::Disabled,
        },
        invite_code: row.invite_code.clone(),
        created_at: user.created_at,
        last_login_at: user.last_login_at,
    }
}

pub fn audit_entry(entry: &admin::AuditEntry) -> AuditEntryView {
    use admin::AuditAction as A;
    AuditEntryView {
        id: entry.id.clone(),
        at: entry.at,
        action: match entry.action {
            A::ChatViewed => AuditAction::ChatViewed,
            A::UserDisabled => AuditAction::UserDisabled,
            A::UserEnabled => AuditAction::UserEnabled,
            A::PasswordReset => AuditAction::PasswordReset,
            A::InviteCodesCreated => AuditAction::InviteCodesCreated,
            A::InviteCodesRevoked => AuditAction::InviteCodesRevoked,
            A::InviteCodesDeleted => AuditAction::InviteCodesDeleted,
            A::GroupDissolved => AuditAction::GroupDissolved,
            A::SettingChanged => AuditAction::SettingChanged,
        },
        target: entry.target.clone(),
        label: entry.detail.label.clone(),
        count: entry.detail.count,
        key: entry.detail.key.clone(),
        from: entry.detail.from.clone(),
        to: entry.detail.to.clone(),
    }
}

pub fn audit_action(action: AuditAction) -> admin::AuditAction {
    use admin::AuditAction as A;
    match action {
        AuditAction::ChatViewed => A::ChatViewed,
        AuditAction::UserDisabled => A::UserDisabled,
        AuditAction::UserEnabled => A::UserEnabled,
        AuditAction::PasswordReset => A::PasswordReset,
        AuditAction::InviteCodesCreated => A::InviteCodesCreated,
        AuditAction::InviteCodesRevoked => A::InviteCodesRevoked,
        AuditAction::InviteCodesDeleted => A::InviteCodesDeleted,
        AuditAction::GroupDissolved => A::GroupDissolved,
        AuditAction::SettingChanged => A::SettingChanged,
    }
}

pub fn overseen(overseen: &chat::Overseen) -> AdminConversationView {
    let conversation = &overseen.conversation;
    AdminConversationView {
        id: conversation.id.to_string(),
        kind: conversation_kind(conversation.kind),
        name: conversation.name.clone(),
        people: overseen.people.iter().map(user_card).collect(),
        avatar_file_id: conversation.avatar.map(|id| id.to_string()),
        owner: overseen.owner.as_ref().map(user_card),
        member_count: overseen.member_count,
        dissolved: conversation.dissolved,
        created_at: conversation.created_at,
        last_at: overseen.last_at,
    }
}

pub fn overseen_member(member: &chat::OverseenMember) -> AdminMemberView {
    AdminMemberView {
        user: user_card(&member.card),
        is_owner: member.is_owner,
        active: member.active,
    }
}

pub fn call_outcome(outcome: call::CallOutcome) -> CallOutcome {
    match outcome {
        call::CallOutcome::Completed => CallOutcome::Completed,
        call::CallOutcome::Cancelled => CallOutcome::Cancelled,
        call::CallOutcome::Rejected => CallOutcome::Rejected,
        call::CallOutcome::Missed => CallOutcome::Missed,
        call::CallOutcome::Busy => CallOutcome::Busy,
        call::CallOutcome::Offline => CallOutcome::Offline,
        call::CallOutcome::Interrupted => CallOutcome::Interrupted,
        call::CallOutcome::NoMicrophone => CallOutcome::NoMicrophone,
    }
}
