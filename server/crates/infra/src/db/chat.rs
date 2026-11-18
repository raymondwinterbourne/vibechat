//! 聊天相关的表：会话、会话成员、消息（会话日志）、语音的播放记录。

use async_trait::async_trait;
use sea_orm::sea_query::{Expr, Func, OnConflict, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, ExprTrait,
    PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, SqlErr, TransactionTrait,
    TryInsertResult,
};
use serde::{Deserialize, Serialize};
use vibechat_core::call::CallOutcome;
use vibechat_core::chat::model::{
    Appended, Change, Changed, Conversation, ConversationKind, Edit, JoinRequest,
    JoinRequestStatus, Listing, Member, Message, MessageData, MessageKind, NewGroup, NewMessage,
    Notice, Party, Purged, Record, RecordItem, SearchScope, Visible,
};
use vibechat_core::chat::store::ChatStore;
use vibechat_core::{ConversationId, FileId, JoinRequestId, MessageId, StoreError, UserId};

use super::entities::{
    conversation_members, conversations, deleted_messages, files, join_requests, message_files,
    messages, voice_plays,
};
use super::{contains_pattern, corrupt, parse_id, unavailable};

pub struct DbChat {
    db: DatabaseConnection,
}

impl DbChat {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    /// 这个发送人在这个会话里用这个客户端消息编号写入过的那一条。
    async fn find_by_client_id(&self, message: &NewMessage) -> Result<Option<Message>, StoreError> {
        let (Some(sender), Some(client_id)) = (message.sender, &message.client_id) else {
            return Ok(None);
        };
        messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(message.conversation.to_string()))
            .filter(messages::Column::SenderId.eq(sender.to_string()))
            .filter(messages::Column::ClientId.eq(client_id.as_str()))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(message_from)
            .transpose()
    }
}

fn optional_id<T: std::str::FromStr>(
    text: Option<&str>,
    what: &str,
) -> Result<Option<T>, StoreError> {
    text.map(|text| parse_id(text, what)).transpose()
}

fn conversation_from(row: conversations::Model) -> Result<Conversation, StoreError> {
    Ok(Conversation {
        id: parse_id(&row.id, "conversations.id")?,
        kind: ConversationKind::parse(&row.kind).ok_or_else(|| corrupt("conversations.kind"))?,
        last_seq: row.last_seq,
        created_at: row.created_at,
        name: row.name,
        avatar: optional_id(
            row.avatar_file_id.as_deref(),
            "conversations.avatar_file_id",
        )?,
        owner: optional_id(row.owner_id.as_deref(), "conversations.owner_id")?,
        dissolved: row.dissolved,
        notice: match (row.notice, row.notice_by, row.notice_at, row.notice_seq) {
            (Some(text), Some(by), Some(at), Some(seq)) => Some(Notice {
                text,
                by: parse_id(&by, "conversations.notice_by")?,
                at,
                seq,
            }),
            _ => None,
        },
        all_muted: row.all_muted,
        join_approval: row.join_approval,
    })
}

fn member_from(row: conversation_members::Model) -> Result<Member, StoreError> {
    Ok(Member {
        conversation: parse_id(&row.conversation_id, "conversation_members.conversation_id")?,
        user: parse_id(&row.user_id, "conversation_members.user_id")?,
        joined_seq: row.joined_seq,
        left_seq: row.left_seq,
        read_seq: row.read_seq,
        mentioned_seq: row.mentioned_seq,
        hidden_seq: row.hidden_seq,
        muted: row.muted,
        notice_seen_seq: row.notice_seen_seq,
        since: row.created_at,
        admin: row.is_admin,
        nickname: row.nickname,
        muted_until: row.muted_until,
        pinned_at: row.pinned_at,
        cleared_seq: row.cleared_seq,
    })
}

/// 一条新的成员记录：`joined_seq` 之后的都能看到，之前的都算看过了。
fn member_row(
    conversation: &str,
    user: UserId,
    joined_seq: i64,
    now: i64,
) -> conversation_members::ActiveModel {
    conversation_members::ActiveModel {
        conversation_id: Set(conversation.to_owned()),
        user_id: Set(user.to_string()),
        joined_seq: Set(joined_seq),
        read_seq: Set(joined_seq),
        hidden_seq: Set(None),
        created_at: Set(now),
        left_seq: Set(None),
        mentioned_seq: Set(0),
        muted: Set(false),
        notice_seen_seq: Set(0),
        is_admin: Set(false),
        nickname: Set(None),
        muted_until: Set(None),
        pinned_at: Set(None),
        cleared_seq: Set(0),
    }
}

/// 一条的参数在数据库里的样子：一段 JSON。没有的项不写。
#[derive(Serialize, Deserialize, Default)]
struct DataJson {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    actor: Option<PartyJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    targets: Vec<PartyJson>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    until: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approver: Option<PartyJson>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    mention_all: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    record: Option<RecordJson>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    call: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    call_video: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    call_joined: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct RecordJson {
    title: String,
    items: Vec<RecordItemJson>,
}

#[derive(Serialize, Deserialize)]
struct RecordItemJson {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender: Option<String>,
    sender_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sender_avatar: Option<String>,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<i64>,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
struct PartyJson {
    id: String,
    nickname: String,
}

fn data_to_json(data: &MessageData) -> Option<String> {
    if data.is_empty() {
        return None;
    }
    let party = |party: &Party| PartyJson {
        id: party.id.to_string(),
        nickname: party.nickname.clone(),
    };
    let json = DataJson {
        actor: data.actor.as_ref().map(party),
        targets: data.targets.iter().map(party).collect(),
        name: data.name.clone(),
        seq: data.seq,
        duration_ms: data.duration_ms,
        until: data.until,
        approver: data.approver.as_ref().map(party),
        mentions: data.mentions.iter().map(ToString::to_string).collect(),
        mention_all: data.mention_all,
        record: data.record.as_ref().map(|record| RecordJson {
            title: record.title.clone(),
            items: record
                .items
                .iter()
                .map(|item| RecordItemJson {
                    sender: item.sender.map(|id| id.to_string()),
                    sender_name: item.sender_name.clone(),
                    sender_avatar: item.sender_avatar.map(|id| id.to_string()),
                    kind: item.kind.as_str().to_owned(),
                    text: item.text.clone(),
                    file: item.file.map(|id| id.to_string()),
                    duration_ms: item.duration_ms,
                    created_at: item.created_at,
                })
                .collect(),
        }),
        call: data.call.map(|outcome| outcome.as_str().to_owned()),
        call_video: data.call_video,
        call_joined: data.call_joined,
        previous: data.previous.clone(),
    };
    serde_json::to_string(&json).ok()
}

fn data_from_json(text: Option<&str>) -> Result<MessageData, StoreError> {
    let Some(text) = text else {
        return Ok(MessageData::default());
    };
    let json: DataJson = serde_json::from_str(text).map_err(|_| corrupt("messages.data"))?;
    let party = |party: PartyJson| -> Result<Party, StoreError> {
        Ok(Party {
            id: parse_id(&party.id, "messages.data")?,
            nickname: party.nickname,
        })
    };
    Ok(MessageData {
        actor: json.actor.map(party).transpose()?,
        targets: json
            .targets
            .into_iter()
            .map(party)
            .collect::<Result<_, _>>()?,
        name: json.name,
        seq: json.seq,
        duration_ms: json.duration_ms,
        until: json.until,
        approver: json.approver.map(party).transpose()?,
        mentions: json
            .mentions
            .iter()
            .map(|id| parse_id(id, "messages.data"))
            .collect::<Result<_, _>>()?,
        mention_all: json.mention_all,
        record: json.record.map(record_from_json).transpose()?,
        call: json
            .call
            .map(|text| CallOutcome::parse(&text).ok_or_else(|| corrupt("messages.data")))
            .transpose()?,
        call_video: json.call_video,
        call_joined: json.call_joined,
        previous: json.previous,
    })
}

fn record_from_json(json: RecordJson) -> Result<Record, StoreError> {
    let items = json
        .items
        .into_iter()
        .map(|item| {
            Ok(RecordItem {
                sender: optional_id(item.sender.as_deref(), "messages.data")?,
                sender_name: item.sender_name,
                sender_avatar: optional_id(item.sender_avatar.as_deref(), "messages.data")?,
                kind: MessageKind::parse(&item.kind).ok_or_else(|| corrupt("messages.data"))?,
                text: item.text,
                file: optional_id(item.file.as_deref(), "messages.data")?,
                duration_ms: item.duration_ms,
                created_at: item.created_at,
            })
        })
        .collect::<Result<_, StoreError>>()?;
    Ok(Record {
        title: json.title,
        items,
    })
}

fn message_row(message: &Message) -> messages::ActiveModel {
    messages::ActiveModel {
        id: Set(message.id.to_string()),
        conversation_id: Set(message.conversation.to_string()),
        seq: Set(message.seq),
        sender_id: Set(message.sender.map(|id| id.to_string())),
        client_id: Set(message.client_id.clone()),
        kind: Set(message.kind.as_str().to_owned()),
        text: Set(message.text.clone()),
        created_at: Set(message.created_at),
        data: Set(data_to_json(&message.data)),
        file_id: Set(message.file.map(|id| id.to_string())),
        reply_to_seq: Set(message.reply_to),
        recalled_at: Set(message.recalled_at),
        edited_at: Set(message.edited_at),
    }
}

/// 一个成员能看到的范围，写成查询条件。
fn within(visible: Visible) -> Condition {
    let mut condition = Condition::all().add(messages::Column::Seq.gt(visible.after));
    if let Some(until) = visible.until {
        condition = condition.add(messages::Column::Seq.lte(until));
    }
    // 看的人自己删掉的不算（F6）
    if let Some(viewer) = visible.viewer {
        let deleted = Query::select()
            .expr(Expr::val(1))
            .from(deleted_messages::Entity)
            .and_where(
                Expr::col((
                    deleted_messages::Entity,
                    deleted_messages::Column::ConversationId,
                ))
                .equals((messages::Entity, messages::Column::ConversationId)),
            )
            .and_where(
                Expr::col((deleted_messages::Entity, deleted_messages::Column::Seq))
                    .equals((messages::Entity, messages::Column::Seq)),
            )
            .and_where(
                Expr::col((deleted_messages::Entity, deleted_messages::Column::UserId))
                    .eq(viewer.to_string()),
            )
            .to_owned();
        condition = condition.add(Expr::exists(deleted).not());
    }
    condition
}

/// 一个会话里现在还在的成员。
fn active_members_of(conversation: &str) -> Condition {
    Condition::all()
        .add(conversation_members::Column::ConversationId.eq(conversation))
        .add(conversation_members::Column::LeftSeq.is_null())
}

fn message_from(row: messages::Model) -> Result<Message, StoreError> {
    Ok(Message {
        id: parse_id(&row.id, "messages.id")?,
        conversation: parse_id(&row.conversation_id, "messages.conversation_id")?,
        seq: row.seq,
        sender: row
            .sender_id
            .as_deref()
            .map(|id| parse_id(id, "messages.sender_id"))
            .transpose()?,
        client_id: row.client_id,
        kind: MessageKind::parse(&row.kind).ok_or_else(|| corrupt("messages.kind"))?,
        text: row.text,
        data: data_from_json(row.data.as_deref())?,
        file: optional_id(row.file_id.as_deref(), "messages.file_id")?,
        reply_to: row.reply_to_seq,
        recalled_at: row.recalled_at,
        edited_at: row.edited_at,
        created_at: row.created_at,
    })
}

fn join_request_from(row: join_requests::Model) -> Result<JoinRequest, StoreError> {
    Ok(JoinRequest {
        id: parse_id(&row.id, "join_requests.id")?,
        conversation: parse_id(&row.conversation_id, "join_requests.conversation_id")?,
        inviter: parse_id(&row.inviter_id, "join_requests.inviter_id")?,
        invitee: parse_id(&row.invitee_id, "join_requests.invitee_id")?,
        status: JoinRequestStatus::parse(&row.status)
            .ok_or_else(|| corrupt("join_requests.status"))?,
        created_at: row.created_at,
        handled_by: optional_id(row.handled_by.as_deref(), "join_requests.handled_by")?,
        handled_at: row.handled_at,
    })
}

/// 同一个群、同一个被邀请人的待处理申请只能有一条：这一列在待处理时是这个键，处理之后为空。
fn pending_key(conversation: ConversationId, invitee: UserId) -> String {
    format!("{conversation}:{invitee}")
}

/// 两个人的单聊会话的唯一键：编号小的在前，由哪一方发起都是同一个。
fn direct_key(a: UserId, b: UserId) -> String {
    let (first, second) = if a < b { (a, b) } else { (b, a) };
    format!("{first}:{second}")
}

fn is_unique_violation(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_)))
}

#[async_trait]
impl ChatStore for DbChat {
    async fn open_direct(
        &self,
        id: ConversationId,
        a: UserId,
        b: UserId,
        now: i64,
    ) -> Result<Conversation, StoreError> {
        let key = direct_key(a, b);
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 已经有了就什么也不插入。两处同时创建时，后到的一方等先到的提交之后走到这里，同样不插入
        conversations::Entity::insert(conversations::ActiveModel {
            id: Set(id.to_string()),
            kind: Set(ConversationKind::Direct.as_str().to_owned()),
            direct_key: Set(Some(key.clone())),
            last_seq: Set(0),
            created_at: Set(now),
            name: Set(None),
            avatar_file_id: Set(None),
            owner_id: Set(None),
            dissolved: Set(false),
            notice: Set(None),
            notice_by: Set(None),
            notice_at: Set(None),
            notice_seq: Set(None),
            all_muted: Set(false),
            join_approval: Set(false),
        })
        .on_conflict(
            OnConflict::column(conversations::Column::DirectKey)
                .do_nothing()
                .to_owned(),
        )
        .try_insert()
        .exec_without_returning(&txn)
        .await
        .map_err(unavailable)?;
        let row = conversations::Entity::find()
            .filter(conversations::Column::DirectKey.eq(key))
            .one(&txn)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| corrupt("direct conversation vanished right after it was created"))?;
        for user in [a, b] {
            conversation_members::Entity::insert(member_row(&row.id, user, 0, now))
                .on_conflict_do_nothing()
                .exec_without_returning(&txn)
                .await
                .map_err(unavailable)?;
        }
        txn.commit().await.map_err(unavailable)?;
        conversation_from(row)
    }

    async fn create_group(&self, group: &NewGroup) -> Result<(Conversation, Message), StoreError> {
        let id = group.id.to_string();
        let now = group.event.created_at;
        // "建群"这条事件是群里的第 1 条
        let message = group.event.stored(1);
        let row = conversations::Model {
            id: id.clone(),
            kind: ConversationKind::Group.as_str().to_owned(),
            direct_key: None,
            last_seq: 1,
            created_at: now,
            name: group.name.clone(),
            avatar_file_id: None,
            owner_id: Some(group.owner.to_string()),
            dissolved: false,
            notice: None,
            notice_by: None,
            notice_at: None,
            notice_seq: None,
            all_muted: false,
            join_approval: false,
        };

        let txn = self.db.begin().await.map_err(unavailable)?;
        conversations::Entity::insert(conversations::ActiveModel::from(row.clone()))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        let members = group
            .members
            .iter()
            .map(|user| member_row(&id, *user, 0, now));
        conversation_members::Entity::insert_many(members)
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        messages::Entity::insert(message_row(&message))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;
        Ok((conversation_from(row)?, message))
    }

    async fn apply(&self, event: &NewMessage, change: &Change) -> Result<Changed, StoreError> {
        let id = event.conversation.to_string();
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 事务的第一条语句就是写入：同一个群的其他改动和消息从这里开始排队。
        // 所以两处同时拉人时，后到的一方能看到先到的一方加进来的人，人数不会超过上限
        let bumped = conversations::Entity::update_many()
            .col_expr(
                conversations::Column::LastSeq,
                Expr::col(conversations::Column::LastSeq).add(1),
            )
            .filter(conversations::Column::Id.eq(id.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if bumped.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Err(StoreError::Unavailable("no such conversation".to_owned()));
        }
        let seq = conversations::Entity::find_by_id(id.as_str())
            .one(&txn)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| corrupt("conversation vanished inside a transaction"))?
            .last_seq;

        let set = |column: conversations::Column, value: sea_orm::Value| {
            conversations::Entity::update_many()
                .col_expr(column, Expr::value(value))
                .filter(conversations::Column::Id.eq(id.as_str()))
        };
        match change {
            Change::Join { users, limit } => {
                let existing = conversation_members::Entity::find()
                    .filter(conversation_members::Column::ConversationId.eq(id.as_str()))
                    .all(&txn)
                    .await
                    .map_err(unavailable)?;
                let present = existing.iter().filter(|m| m.left_seq.is_none()).count() as u32;
                let state = |user: &UserId| {
                    let user = user.to_string();
                    existing.iter().find(|m| m.user_id == user)
                };
                let newcomers: Vec<&UserId> = users
                    .iter()
                    .filter(|user| state(user).is_none_or(|m| m.left_seq.is_some()))
                    .collect();
                if newcomers.is_empty() {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Nothing);
                }
                if present + newcomers.len() as u32 > *limit {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Full {
                        room: limit.saturating_sub(present),
                    });
                }
                for user in newcomers {
                    if state(user).is_some() {
                        // 离开过的人再加入：还是那一条记录，只能看到这一次入群之后的
                        conversation_members::Entity::update_many()
                            .col_expr(
                                conversation_members::Column::JoinedSeq,
                                Expr::value(seq - 1),
                            )
                            .col_expr(conversation_members::Column::ReadSeq, Expr::value(seq - 1))
                            .col_expr(
                                conversation_members::Column::LeftSeq,
                                Expr::value(None::<i64>),
                            )
                            .col_expr(
                                conversation_members::Column::HiddenSeq,
                                Expr::value(None::<i64>),
                            )
                            .col_expr(conversation_members::Column::MentionedSeq, Expr::value(0))
                            .filter(conversation_members::Column::ConversationId.eq(id.as_str()))
                            .filter(conversation_members::Column::UserId.eq(user.to_string()))
                            .exec(&txn)
                            .await
                            .map_err(unavailable)?;
                    } else {
                        let row = member_row(&id, *user, seq - 1, event.created_at);
                        conversation_members::Entity::insert(row)
                            .exec_without_returning(&txn)
                            .await
                            .map_err(unavailable)?;
                    }
                }
            }
            Change::Leave { user, hide } => {
                let mut leaving = conversation_members::Entity::update_many()
                    .col_expr(
                        conversation_members::Column::LeftSeq,
                        Expr::value(Some(seq)),
                    )
                    .col_expr(conversation_members::Column::IsAdmin, Expr::value(false));
                if *hide {
                    leaving = leaving.col_expr(
                        conversation_members::Column::HiddenSeq,
                        Expr::value(Some(seq)),
                    );
                }
                let left = leaving
                    .filter(active_members_of(&id))
                    .filter(conversation_members::Column::UserId.eq(user.to_string()))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                if left.rows_affected != 1 {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Nothing);
                }
            }
            Change::SetOwner(owner) => {
                set(conversations::Column::OwnerId, owner.to_string().into())
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                // 新群主原来是管理员的，不再是；被禁言着的，禁言解除
                conversation_members::Entity::update_many()
                    .col_expr(conversation_members::Column::IsAdmin, Expr::value(false))
                    .col_expr(
                        conversation_members::Column::MutedUntil,
                        Expr::value(None::<i64>),
                    )
                    .filter(conversation_members::Column::ConversationId.eq(id.as_str()))
                    .filter(conversation_members::Column::UserId.eq(owner.to_string()))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
            }
            Change::SetAdmin { user, admin, limit } => {
                // 会话的序号已经加过了：同一个群的其他改动在排队，这里数出来的人数不会变
                if *admin {
                    let admins = conversation_members::Entity::find()
                        .filter(active_members_of(&id))
                        .filter(conversation_members::Column::IsAdmin.eq(true))
                        .count(&txn)
                        .await
                        .map_err(unavailable)?;
                    if admins >= u64::from(*limit) {
                        txn.rollback().await.map_err(unavailable)?;
                        return Ok(Changed::Full { room: 0 });
                    }
                }
                let mut update = conversation_members::Entity::update_many()
                    .col_expr(conversation_members::Column::IsAdmin, Expr::value(*admin));
                if *admin {
                    // 管理员不能被禁言：设为管理员时禁言跟着解除
                    update = update.col_expr(
                        conversation_members::Column::MutedUntil,
                        Expr::value(None::<i64>),
                    );
                }
                let changed = update
                    .filter(active_members_of(&id))
                    .filter(conversation_members::Column::UserId.eq(user.to_string()))
                    .filter(conversation_members::Column::IsAdmin.eq(!*admin))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                if changed.rows_affected != 1 {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Nothing);
                }
            }
            Change::Mute { user, until } => {
                let changed = conversation_members::Entity::update_many()
                    .col_expr(
                        conversation_members::Column::MutedUntil,
                        Expr::value(*until),
                    )
                    .filter(active_members_of(&id))
                    .filter(conversation_members::Column::UserId.eq(user.to_string()))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                if changed.rows_affected != 1 {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Nothing);
                }
            }
            Change::SetAllMuted(muted) => {
                let changed = conversations::Entity::update_many()
                    .col_expr(conversations::Column::AllMuted, Expr::value(*muted))
                    .filter(conversations::Column::Id.eq(id.as_str()))
                    .filter(conversations::Column::AllMuted.eq(!*muted))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                if changed.rows_affected != 1 {
                    txn.rollback().await.map_err(unavailable)?;
                    return Ok(Changed::Nothing);
                }
            }
            Change::Rename(name) => {
                set(conversations::Column::Name, name.clone().into())
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
            }
            Change::SetAvatar(avatar) => {
                set(
                    conversations::Column::AvatarFileId,
                    avatar.to_string().into(),
                )
                .exec(&txn)
                .await
                .map_err(unavailable)?;
            }
            Change::Dissolve => {
                set(conversations::Column::Dissolved, true.into())
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
            }
            Change::SetNotice { text, by, remind } => {
                // 清空时连同发布人、时间一起清掉
                let present = text.is_some();
                conversations::Entity::update_many()
                    .col_expr(conversations::Column::Notice, Expr::value(text.clone()))
                    .col_expr(
                        conversations::Column::NoticeBy,
                        Expr::value(present.then(|| by.to_string())),
                    )
                    .col_expr(
                        conversations::Column::NoticeAt,
                        Expr::value(present.then_some(event.created_at)),
                    )
                    .col_expr(
                        conversations::Column::NoticeSeq,
                        Expr::value(present.then_some(seq)),
                    )
                    .filter(conversations::Column::Id.eq(id.as_str()))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                // 发布的人自己算看过了
                conversation_members::Entity::update_many()
                    .col_expr(
                        conversation_members::Column::NoticeSeenSeq,
                        Expr::value(seq),
                    )
                    .filter(conversation_members::Column::ConversationId.eq(id.as_str()))
                    .filter(conversation_members::Column::UserId.eq(by.to_string()))
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                if *remind {
                    conversation_members::Entity::update_many()
                        .col_expr(conversation_members::Column::MentionedSeq, Expr::value(seq))
                        .filter(active_members_of(&id))
                        .filter(conversation_members::Column::UserId.ne(by.to_string()))
                        .exec(&txn)
                        .await
                        .map_err(unavailable)?;
                }
            }
        }

        let message = event.stored(seq);
        messages::Entity::insert(message_row(&message))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;
        Ok(Changed::Done(Box::new(message)))
    }

    async fn list_groups(&self, user: UserId) -> Result<Vec<Conversation>, StoreError> {
        let memberships = conversation_members::Entity::find()
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .filter(conversation_members::Column::LeftSeq.is_null())
            .all(&self.db)
            .await
            .map_err(unavailable)?;
        if memberships.is_empty() {
            return Ok(Vec::new());
        }
        conversations::Entity::find()
            .filter(
                conversations::Column::Id.is_in(memberships.into_iter().map(|m| m.conversation_id)),
            )
            .filter(conversations::Column::Kind.eq(ConversationKind::Group.as_str()))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(conversation_from)
            .collect()
    }

    async fn find_conversations(
        &self,
        ids: &[ConversationId],
    ) -> Result<Vec<Conversation>, StoreError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        conversations::Entity::find()
            .filter(conversations::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(conversation_from)
            .collect()
    }

    async fn list_all_groups(
        &self,
        search: Option<&str>,
        offset: u64,
        limit: u64,
    ) -> Result<(Vec<Conversation>, u64), StoreError> {
        let mut filter =
            Condition::all().add(conversations::Column::Kind.eq(ConversationKind::Group.as_str()));
        if let Some(search) = search {
            let name = Func::lower(Expr::col((
                conversations::Entity,
                conversations::Column::Name,
            )));
            filter = filter.add(Expr::expr(name).like(contains_pattern(search)));
        }
        let total = conversations::Entity::find()
            .filter(filter.clone())
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        let groups = conversations::Entity::find()
            .filter(filter)
            .order_by_desc(conversations::Column::CreatedAt)
            .order_by_desc(conversations::Column::Id)
            .offset(offset)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(conversation_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((groups, total))
    }

    async fn count_groups(&self) -> Result<u64, StoreError> {
        conversations::Entity::find()
            .filter(conversations::Column::Kind.eq(ConversationKind::Group.as_str()))
            .filter(conversations::Column::Dissolved.eq(false))
            .count(&self.db)
            .await
            .map_err(unavailable)
    }

    async fn purge_before(&self, cutoff: i64) -> Result<Purged, StoreError> {
        // 有过期消息的会话
        let stale: Vec<String> = messages::Entity::find()
            .select_only()
            .column(messages::Column::ConversationId)
            .distinct()
            .filter(messages::Column::CreatedAt.lt(cutoff))
            .into_tuple()
            .all(&self.db)
            .await
            .map_err(unavailable)?;

        let mut purged = Purged::default();
        for conversation in stale {
            let txn = self.db.begin().await.map_err(unavailable)?;
            // 第一条没有过期的：序号比它小的都删。一条没过期的都没有，就全删
            let keep_from: Option<i64> = messages::Entity::find()
                .select_only()
                .column(messages::Column::Seq)
                .filter(messages::Column::ConversationId.eq(conversation.as_str()))
                .filter(messages::Column::CreatedAt.gte(cutoff))
                .order_by_asc(messages::Column::Seq)
                .limit(1)
                .into_tuple()
                .one(&txn)
                .await
                .map_err(unavailable)?;
            let mut expired =
                Condition::all().add(messages::Column::ConversationId.eq(conversation.as_str()));
            if let Some(seq) = keep_from {
                expired = expired.add(messages::Column::Seq.lt(seq));
            }
            let doomed: Vec<(String, Option<String>)> = messages::Entity::find()
                .select_only()
                .column(messages::Column::Id)
                .column(messages::Column::FileId)
                .filter(expired.clone())
                .into_tuple()
                .all(&txn)
                .await
                .map_err(unavailable)?;
            if doomed.is_empty() {
                continue;
            }
            // 一条语句里的参数个数有上限，分批删
            let mut recorded: Vec<String> = Vec::new();
            for batch in doomed.chunks(500) {
                voice_plays::Entity::delete_many()
                    .filter(
                        voice_plays::Column::MessageId
                            .is_in(batch.iter().map(|(id, _)| id.as_str())),
                    )
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                // 聊天记录里的文件跟着这一条一起删
                let in_records: Vec<String> = message_files::Entity::find()
                    .select_only()
                    .column(message_files::Column::FileId)
                    .filter(
                        message_files::Column::MessageId
                            .is_in(batch.iter().map(|(id, _)| id.as_str())),
                    )
                    .into_tuple()
                    .all(&txn)
                    .await
                    .map_err(unavailable)?;
                message_files::Entity::delete_many()
                    .filter(
                        message_files::Column::MessageId
                            .is_in(batch.iter().map(|(id, _)| id.as_str())),
                    )
                    .exec(&txn)
                    .await
                    .map_err(unavailable)?;
                recorded.extend(in_records);
            }
            messages::Entity::delete_many()
                .filter(expired)
                .exec(&txn)
                .await
                .map_err(unavailable)?;
            // 谁删了这几条的记录也不用留了（F6）
            let mut marks = Condition::all()
                .add(deleted_messages::Column::ConversationId.eq(conversation.as_str()));
            if let Some(seq) = keep_from {
                marks = marks.add(deleted_messages::Column::Seq.lt(seq));
            }
            deleted_messages::Entity::delete_many()
                .filter(marks)
                .exec(&txn)
                .await
                .map_err(unavailable)?;
            txn.commit().await.map_err(unavailable)?;

            purged.messages += doomed.len() as u64;
            for (_, file) in doomed {
                if let Some(file) = file {
                    purged.files.push(parse_id(&file, "messages.file_id")?);
                }
            }
            for file in recorded {
                purged.files.push(parse_id(&file, "message_files.file_id")?);
            }
        }
        Ok(purged)
    }

    async fn find_conversation(
        &self,
        id: ConversationId,
    ) -> Result<Option<Conversation>, StoreError> {
        conversations::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(conversation_from)
            .transpose()
    }

    async fn find_member(
        &self,
        conversation: ConversationId,
        user: UserId,
    ) -> Result<Option<Member>, StoreError> {
        conversation_members::Entity::find_by_id((conversation.to_string(), user.to_string()))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(member_from)
            .transpose()
    }

    async fn list_members(&self, conversation: ConversationId) -> Result<Vec<Member>, StoreError> {
        conversation_members::Entity::find()
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .order_by_asc(conversation_members::Column::CreatedAt)
            .order_by_asc(conversation_members::Column::UserId)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(member_from)
            .collect()
    }

    async fn append(&self, message: &NewMessage) -> Result<Appended, StoreError> {
        // 重发最常见的情况：上一次其实已经写入了。先查一下，不必开事务
        if let Some(earlier) = self.find_by_client_id(message).await? {
            return Ok(Appended {
                message: earlier,
                duplicate: true,
            });
        }

        let conversation = message.conversation.to_string();
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 事务的第一条语句就是写入：数据库从这里开始让同一个会话的其他写入排队，
        // 所以每一条拿到的序号各不相同并且连续
        let bumped = conversations::Entity::update_many()
            .col_expr(
                conversations::Column::LastSeq,
                Expr::col(conversations::Column::LastSeq).add(1),
            )
            .filter(conversations::Column::Id.eq(conversation.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if bumped.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Err(StoreError::Unavailable("no such conversation".to_owned()));
        }
        let seq = conversations::Entity::find_by_id(conversation.as_str())
            .one(&txn)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| corrupt("conversation vanished inside a transaction"))?
            .last_seq;

        let stored = message.stored(seq);
        let inserted = messages::Entity::insert(message_row(&stored))
            .exec_without_returning(&txn)
            .await;
        match inserted {
            Ok(_) => {
                // 聊天记录里的文件：登记它们属于这一条，看得到这一条的人才能读
                if let Some(record) = &stored.data.record {
                    let rows: Vec<_> = record
                        .files()
                        .map(|file| message_files::ActiveModel {
                            file_id: Set(file.to_string()),
                            message_id: Set(stored.id.to_string()),
                        })
                        .collect();
                    if !rows.is_empty() {
                        message_files::Entity::insert_many(rows)
                            .exec_without_returning(&txn)
                            .await
                            .map_err(unavailable)?;
                    }
                }
                // 记下谁被 @ 了：只算现在在会话里的人，发送人自己不算
                let data = &stored.data;
                if data.mention_all || !data.mentions.is_empty() {
                    let mut mentioned = active_members_of(&conversation);
                    if !data.mention_all {
                        mentioned = mentioned.add(
                            conversation_members::Column::UserId
                                .is_in(data.mentions.iter().map(ToString::to_string)),
                        );
                    }
                    if let Some(sender) = stored.sender {
                        mentioned = mentioned
                            .add(conversation_members::Column::UserId.ne(sender.to_string()));
                    }
                    conversation_members::Entity::update_many()
                        .col_expr(conversation_members::Column::MentionedSeq, Expr::value(seq))
                        .filter(mentioned)
                        .exec(&txn)
                        .await
                        .map_err(unavailable)?;
                }
                txn.commit().await.map_err(unavailable)?;
                Ok(Appended {
                    message: stored,
                    duplicate: false,
                })
            }
            Err(err) if is_unique_violation(&err) => {
                // 同一个客户端消息编号的另一次发送抢先写入了。撤销这一次（序号也退回去），
                // 返回已经写入的那一条
                txn.rollback().await.map_err(unavailable)?;
                let earlier = self
                    .find_by_client_id(message)
                    .await?
                    .ok_or_else(|| unavailable(err))?;
                Ok(Appended {
                    message: earlier,
                    duplicate: true,
                })
            }
            Err(err) => {
                txn.rollback().await.map_err(unavailable)?;
                Err(unavailable(err))
            }
        }
    }

    async fn find_messages(
        &self,
        conversation: ConversationId,
        seqs: &[i64],
    ) -> Result<Vec<Message>, StoreError> {
        if seqs.is_empty() {
            return Ok(Vec::new());
        }
        messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation.to_string()))
            .filter(messages::Column::Seq.is_in(seqs.iter().copied()))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect()
    }

    async fn find_by_file(&self, file: FileId) -> Result<Option<Message>, StoreError> {
        let found = messages::Entity::find()
            .filter(messages::Column::FileId.eq(file.to_string()))
            .one(&self.db)
            .await
            .map_err(unavailable)?;
        if let Some(row) = found {
            return message_from(row).map(Some);
        }
        // 聊天记录里的文件
        let Some(link) = message_files::Entity::find_by_id(file.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
        else {
            return Ok(None);
        };
        messages::Entity::find_by_id(link.message_id)
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(message_from)
            .transpose()
    }

    async fn recall(&self, event: &NewMessage, seq: i64) -> Result<Option<Message>, StoreError> {
        let conversation = event.conversation.to_string();
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 和写入消息一样，事务的第一条语句就是给会话的序号加一，同一个会话的其他写入从这里开始排队
        let bumped = conversations::Entity::update_many()
            .col_expr(
                conversations::Column::LastSeq,
                Expr::col(conversations::Column::LastSeq).add(1),
            )
            .filter(conversations::Column::Id.eq(conversation.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if bumped.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Err(StoreError::Unavailable("no such conversation".to_owned()));
        }
        // 只有还没有撤回过的才会改到：两处同时撤回时，后到的一方什么也不做
        let marked = messages::Entity::update_many()
            .col_expr(
                messages::Column::RecalledAt,
                Expr::value(Some(event.created_at)),
            )
            .filter(messages::Column::ConversationId.eq(conversation.as_str()))
            .filter(messages::Column::Seq.eq(seq))
            .filter(messages::Column::RecalledAt.is_null())
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if marked.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Ok(None);
        }
        let last_seq = conversations::Entity::find_by_id(conversation.as_str())
            .one(&txn)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| corrupt("conversation vanished inside a transaction"))?
            .last_seq;
        let stored = event.stored(last_seq);
        messages::Entity::insert(message_row(&stored))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;
        Ok(Some(stored))
    }

    async fn edit(
        &self,
        event: &NewMessage,
        seq: i64,
        change: &Edit,
    ) -> Result<Option<Message>, StoreError> {
        let conversation = event.conversation.to_string();
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 和撤回一样：先给会话的序号加一，同一个会话的其他写入从这里开始排队
        let bumped = conversations::Entity::update_many()
            .col_expr(
                conversations::Column::LastSeq,
                Expr::col(conversations::Column::LastSeq).add(1),
            )
            .filter(conversations::Column::Id.eq(conversation.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if bumped.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Err(StoreError::Unavailable("no such conversation".to_owned()));
        }
        let target = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation.as_str()))
            .filter(messages::Column::Seq.eq(seq))
            .filter(messages::Column::RecalledAt.is_null())
            .one(&txn)
            .await
            .map_err(unavailable)?;
        let Some(target) = target else {
            txn.rollback().await.map_err(unavailable)?;
            return Ok(None);
        };
        let mut data = data_from_json(target.data.as_deref())?;
        data.mentions = change.mentions.clone();
        data.mention_all = change.mention_all;
        messages::Entity::update_many()
            .col_expr(messages::Column::Text, Expr::value(change.text.clone()))
            .col_expr(messages::Column::Data, Expr::value(data_to_json(&data)))
            .col_expr(
                messages::Column::EditedAt,
                Expr::value(Some(event.created_at)),
            )
            .filter(messages::Column::Id.eq(target.id.as_str()))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        let last_seq = conversations::Entity::find_by_id(conversation.as_str())
            .one(&txn)
            .await
            .map_err(unavailable)?
            .ok_or_else(|| corrupt("conversation vanished inside a transaction"))?
            .last_seq;
        let stored = event.stored(last_seq);
        messages::Entity::insert(message_row(&stored))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        // 新 @ 到的人记上提醒：只算还在会话里的，编辑的人自己不算
        let added = &stored.data;
        if added.mention_all || !added.mentions.is_empty() {
            let mut mentioned = active_members_of(&conversation);
            if !added.mention_all {
                mentioned = mentioned.add(
                    conversation_members::Column::UserId
                        .is_in(added.mentions.iter().map(ToString::to_string)),
                );
            }
            if let Some(editor) = &added.actor {
                mentioned =
                    mentioned.add(conversation_members::Column::UserId.ne(editor.id.to_string()));
            }
            conversation_members::Entity::update_many()
                .col_expr(
                    conversation_members::Column::MentionedSeq,
                    Expr::value(stored.seq),
                )
                .filter(mentioned)
                .exec(&txn)
                .await
                .map_err(unavailable)?;
        }
        txn.commit().await.map_err(unavailable)?;
        Ok(Some(stored))
    }

    async fn mark_played(
        &self,
        message: MessageId,
        user: UserId,
        now: i64,
    ) -> Result<bool, StoreError> {
        let row = voice_plays::ActiveModel {
            message_id: Set(message.to_string()),
            user_id: Set(user.to_string()),
            played_at: Set(now),
        };
        // 以前记过就什么也不插入
        let inserted = voice_plays::Entity::insert(row)
            .on_conflict_do_nothing()
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(matches!(inserted, TryInsertResult::Inserted(1)))
    }

    async fn played(
        &self,
        user: UserId,
        messages: &[MessageId],
    ) -> Result<Vec<MessageId>, StoreError> {
        if messages.is_empty() {
            return Ok(Vec::new());
        }
        voice_plays::Entity::find()
            .filter(voice_plays::Column::UserId.eq(user.to_string()))
            .filter(voice_plays::Column::MessageId.is_in(messages.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(|row| parse_id(&row.message_id, "voice_plays.message_id"))
            .collect()
    }

    async fn memberships(&self, user: UserId) -> Result<Vec<Member>, StoreError> {
        conversation_members::Entity::find()
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(member_from)
            .collect()
    }

    async fn search(
        &self,
        scopes: &[SearchScope],
        needle: &str,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        if scopes.is_empty() {
            return Ok(Vec::new());
        }
        // 两边都转成小写再比：英文不区分大小写，在两种数据库上结果一样
        let text = Func::lower(Expr::col((messages::Entity, messages::Column::Text)));
        let text_matches = Expr::expr(text).like(contains_pattern(needle));
        let name = Func::lower(Expr::col((files::Entity, files::Column::Name)));
        let named_like_this = Query::select()
            .column(files::Column::Id)
            .from(files::Entity)
            .and_where(Expr::expr(name).like(contains_pattern(needle)))
            .to_owned();
        // 文本消息看文字，图片看它的文字说明，文件消息看文件名，
        // 聊天记录看写入时拼好的那段文字（标题、每一条的发送人和内容）
        let matches = Condition::any()
            .add(
                Condition::all()
                    .add(messages::Column::Kind.is_in([
                        MessageKind::Text.as_str(),
                        MessageKind::Image.as_str(),
                        MessageKind::ChatRecord.as_str(),
                    ]))
                    .add(text_matches),
            )
            .add(
                Condition::all()
                    .add(messages::Column::Kind.eq(MessageKind::File.as_str()))
                    .add(messages::Column::FileId.in_subquery(named_like_this)),
            );
        let in_scope = scopes.iter().fold(Condition::any(), |any, scope| {
            let mut one = Condition::all()
                .add(messages::Column::ConversationId.eq(scope.conversation.to_string()))
                .add(within(scope.visible));
            if let Some(before) = scope.before {
                one = one.add(messages::Column::Seq.lt(before));
            }
            any.add(one)
        });
        messages::Entity::find()
            .filter(messages::Column::RecalledAt.is_null())
            .filter(matches)
            .filter(in_scope)
            .order_by_desc(messages::Column::CreatedAt)
            .order_by_desc(messages::Column::Seq)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect()
    }

    async fn list_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let mut query = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation.to_string()))
            .filter(within(visible));
        if let Some(before) = before {
            query = query.filter(messages::Column::Seq.lt(before));
        }
        let mut found = query
            .order_by_desc(messages::Column::Seq)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect::<Result<Vec<_>, _>>()?;
        // 取的时候从新到旧，交出去的时候从旧到新
        found.reverse();
        Ok(found)
    }

    async fn list_kind_before(
        &self,
        conversation: ConversationId,
        visible: Visible,
        kind: MessageKind,
        before: Option<i64>,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        let mut query = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation.to_string()))
            .filter(within(visible))
            .filter(messages::Column::Kind.eq(kind.as_str()))
            .filter(messages::Column::RecalledAt.is_null());
        if let Some(before) = before {
            query = query.filter(messages::Column::Seq.lt(before));
        }
        let mut found = query
            .order_by_desc(messages::Column::Seq)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect::<Result<Vec<_>, _>>()?;
        found.reverse();
        Ok(found)
    }

    async fn list_after(
        &self,
        conversation: ConversationId,
        visible: Visible,
        after: i64,
        limit: u64,
    ) -> Result<Vec<Message>, StoreError> {
        messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation.to_string()))
            .filter(within(visible))
            .filter(messages::Column::Seq.gt(after))
            .order_by_asc(messages::Column::Seq)
            .limit(limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect()
    }

    async fn advance_read(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError> {
        // 只有比现在的位置更靠后时才会改到，所以位置不会后退
        let result = conversation_members::Entity::update_many()
            .col_expr(conversation_members::Column::ReadSeq, Expr::value(seq))
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .filter(conversation_members::Column::ReadSeq.lt(seq))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected == 1)
    }

    async fn hide(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError> {
        conversation_members::Entity::update_many()
            .col_expr(
                conversation_members::Column::HiddenSeq,
                Expr::value(Some(seq)),
            )
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn set_muted(
        &self,
        conversation: ConversationId,
        user: UserId,
        muted: bool,
    ) -> Result<(), StoreError> {
        conversation_members::Entity::update_many()
            .col_expr(conversation_members::Column::Muted, Expr::value(muted))
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn clear(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<(), StoreError> {
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 清空的位置和已读位置都只往后挪（F6 Q10：清空的算读过）
        for column in [
            conversation_members::Column::ClearedSeq,
            conversation_members::Column::ReadSeq,
        ] {
            conversation_members::Entity::update_many()
                .col_expr(column, Expr::value(seq))
                .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
                .filter(conversation_members::Column::UserId.eq(user.to_string()))
                .filter(column.lt(seq))
                .exec(&txn)
                .await
                .map_err(unavailable)?;
        }
        txn.commit().await.map_err(unavailable)
    }

    async fn delete_for(
        &self,
        conversation: ConversationId,
        user: UserId,
        seqs: &[i64],
        now: i64,
    ) -> Result<(), StoreError> {
        if seqs.is_empty() {
            return Ok(());
        }
        let rows = seqs.iter().map(|seq| deleted_messages::ActiveModel {
            conversation_id: Set(conversation.to_string()),
            user_id: Set(user.to_string()),
            seq: Set(*seq),
            deleted_at: Set(now),
        });
        deleted_messages::Entity::insert_many(rows)
            .on_conflict_do_nothing()
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn set_pinned(
        &self,
        conversation: ConversationId,
        user: UserId,
        pinned_at: Option<i64>,
    ) -> Result<(), StoreError> {
        conversation_members::Entity::update_many()
            .col_expr(
                conversation_members::Column::PinnedAt,
                Expr::value(pinned_at),
            )
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn set_join_approval(
        &self,
        conversation: ConversationId,
        on: bool,
    ) -> Result<bool, StoreError> {
        let changed = conversations::Entity::update_many()
            .col_expr(conversations::Column::JoinApproval, Expr::value(on))
            .filter(conversations::Column::Id.eq(conversation.to_string()))
            .filter(conversations::Column::JoinApproval.eq(!on))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(changed.rows_affected == 1)
    }

    async fn add_join_request(
        &self,
        request: &JoinRequest,
        cutoff: i64,
    ) -> Result<bool, StoreError> {
        let key = pending_key(request.conversation, request.invitee);
        let txn = self.db.begin().await.map_err(unavailable)?;
        // 过期了还占着这个键的那一条：让出来
        join_requests::Entity::update_many()
            .col_expr(
                join_requests::Column::Status,
                Expr::value(JoinRequestStatus::Expired.as_str()),
            )
            .col_expr(
                join_requests::Column::PendingKey,
                Expr::value(None::<String>),
            )
            .filter(join_requests::Column::PendingKey.eq(key.as_str()))
            .filter(join_requests::Column::CreatedAt.lt(cutoff))
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        let row = join_requests::ActiveModel {
            id: Set(request.id.to_string()),
            conversation_id: Set(request.conversation.to_string()),
            inviter_id: Set(request.inviter.to_string()),
            invitee_id: Set(request.invitee.to_string()),
            status: Set(request.status.as_str().to_owned()),
            pending_key: Set(Some(key)),
            created_at: Set(request.created_at),
            handled_by: Set(None),
            handled_at: Set(None),
        };
        // 已经有一条待处理的：什么也不插入
        let inserted = join_requests::Entity::insert(row)
            .on_conflict_do_nothing_on([join_requests::Column::PendingKey])
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;
        Ok(matches!(inserted, TryInsertResult::Inserted(1)))
    }

    async fn list_join_requests(
        &self,
        conversation: ConversationId,
    ) -> Result<Vec<JoinRequest>, StoreError> {
        join_requests::Entity::find()
            .filter(join_requests::Column::ConversationId.eq(conversation.to_string()))
            .order_by_desc(join_requests::Column::CreatedAt)
            .order_by_desc(join_requests::Column::Id)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(join_request_from)
            .collect()
    }

    async fn find_join_request(
        &self,
        id: JoinRequestId,
    ) -> Result<Option<JoinRequest>, StoreError> {
        join_requests::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(join_request_from)
            .transpose()
    }

    async fn settle_join_request(
        &self,
        id: JoinRequestId,
        status: JoinRequestStatus,
        by: UserId,
        now: i64,
        cutoff: i64,
    ) -> Result<bool, StoreError> {
        let settled = join_requests::Entity::update_many()
            .col_expr(join_requests::Column::Status, Expr::value(status.as_str()))
            .col_expr(
                join_requests::Column::PendingKey,
                Expr::value(None::<String>),
            )
            .col_expr(
                join_requests::Column::HandledBy,
                Expr::value(by.to_string()),
            )
            .col_expr(join_requests::Column::HandledAt, Expr::value(now))
            .filter(join_requests::Column::Id.eq(id.to_string()))
            .filter(join_requests::Column::Status.eq(JoinRequestStatus::Pending.as_str()))
            .filter(join_requests::Column::CreatedAt.gte(cutoff))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(settled.rows_affected == 1)
    }

    async fn reopen_join_request(&self, id: JoinRequestId) -> Result<(), StoreError> {
        let Some(request) = self.find_join_request(id).await? else {
            return Ok(());
        };
        // 退回的时候恰好又有了一条待处理的：键被占着，退不回去，就让这一条保持原样
        let reopened = join_requests::Entity::update_many()
            .col_expr(
                join_requests::Column::Status,
                Expr::value(JoinRequestStatus::Pending.as_str()),
            )
            .col_expr(
                join_requests::Column::PendingKey,
                Expr::value(pending_key(request.conversation, request.invitee)),
            )
            .col_expr(
                join_requests::Column::HandledBy,
                Expr::value(None::<String>),
            )
            .col_expr(join_requests::Column::HandledAt, Expr::value(None::<i64>))
            .filter(join_requests::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await;
        match reopened {
            Ok(_) => Ok(()),
            Err(err) if is_unique_violation(&err) => Ok(()),
            Err(err) => Err(unavailable(err)),
        }
    }

    async fn set_nickname(
        &self,
        conversation: ConversationId,
        user: UserId,
        nickname: Option<String>,
    ) -> Result<bool, StoreError> {
        let conversation = conversation.to_string();
        // 和原来一样的不算改了。原来是空的时候"不等于"比不出结果，要单独算
        let differs = match &nickname {
            Some(name) => Condition::any()
                .add(conversation_members::Column::Nickname.is_null())
                .add(conversation_members::Column::Nickname.ne(name.as_str())),
            None => Condition::all().add(conversation_members::Column::Nickname.is_not_null()),
        };
        let changed = conversation_members::Entity::update_many()
            .col_expr(
                conversation_members::Column::Nickname,
                Expr::value(nickname),
            )
            .filter(active_members_of(&conversation))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .filter(differs)
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(changed.rows_affected == 1)
    }

    async fn mark_notice_seen(
        &self,
        conversation: ConversationId,
        user: UserId,
        seq: i64,
    ) -> Result<bool, StoreError> {
        let moved = conversation_members::Entity::update_many()
            .col_expr(
                conversation_members::Column::NoticeSeenSeq,
                Expr::value(seq),
            )
            .filter(conversation_members::Column::ConversationId.eq(conversation.to_string()))
            .filter(conversation_members::Column::UserId.eq(user.to_string()))
            .filter(conversation_members::Column::NoticeSeenSeq.lt(seq))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(moved.rows_affected == 1)
    }

    async fn list_for_user(&self, user: UserId) -> Result<Vec<Listing>, StoreError> {
        let me = user.to_string();
        let memberships = conversation_members::Entity::find()
            .filter(conversation_members::Column::UserId.eq(me.as_str()))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(member_from)
            .collect::<Result<Vec<_>, _>>()?;
        if memberships.is_empty() {
            return Ok(Vec::new());
        }
        let found = conversations::Entity::find()
            .filter(
                conversations::Column::Id
                    .is_in(memberships.iter().map(|m| m.conversation.to_string())),
            )
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(conversation_from)
            .collect::<Result<Vec<_>, _>>()?;

        // 只留下现在应当显示的
        let shown: Vec<(Conversation, Member)> = memberships
            .into_iter()
            .filter_map(|member| {
                let conversation = found.iter().find(|c| c.id == member.conversation)?;
                member
                    .lists(conversation)
                    .then(|| (conversation.clone(), member))
            })
            .collect();
        if shown.is_empty() {
            return Ok(Vec::new());
        }

        let ids = || shown.iter().map(|(c, _)| c.id.to_string());
        let others = conversation_members::Entity::find()
            .filter(conversation_members::Column::ConversationId.is_in(ids()))
            .filter(conversation_members::Column::UserId.ne(me.as_str()))
            .order_by_asc(conversation_members::Column::CreatedAt)
            .order_by_asc(conversation_members::Column::UserId)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(member_from)
            .collect::<Result<Vec<_>, _>>()?;
        // 每个会话里他能看到的最新一条。通常就是最后一条；他把它删了、清空过时，是再往前的
        // 那一条，或者没有（F6）
        let latest = shown.iter().fold(Condition::any(), |any, (c, member)| {
            any.add(
                Condition::all()
                    .add(messages::Column::ConversationId.eq(c.id.to_string()))
                    .add(messages::Column::Seq.eq(member.last_visible(c)))
                    .add(within(member.visible())),
            )
        });
        // 编辑事件不算：摘要是被编辑的那一条自己，它已经换成了新的内容（F8）
        let not_edit = messages::Column::Kind.ne(MessageKind::Edited.as_str());
        let mut last_messages = messages::Entity::find()
            .filter(latest)
            .filter(not_edit.clone())
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(message_from)
            .collect::<Result<Vec<_>, _>>()?;
        for (conversation, member) in &shown {
            let found = last_messages
                .iter()
                .any(|message| message.conversation == conversation.id);
            let visible = member.visible();
            if found || member.last_visible(conversation) <= visible.after {
                continue;
            }
            let earlier = messages::Entity::find()
                .filter(messages::Column::ConversationId.eq(conversation.id.to_string()))
                .filter(within(visible))
                .filter(not_edit.clone())
                .order_by_desc(messages::Column::Seq)
                .one(&self.db)
                .await
                .map_err(unavailable)?;
            if let Some(row) = earlier {
                last_messages.push(message_from(row)?);
            }
        }

        let mut listings = Vec::with_capacity(shown.len());
        for (conversation, member) in shown {
            // 全部看过了的会话不用去数
            let unread = if member.last_visible(&conversation) > member.read_seq {
                messages::Entity::find()
                    .filter(messages::Column::ConversationId.eq(conversation.id.to_string()))
                    .filter(within(member.visible()))
                    .filter(messages::Column::Seq.gt(member.read_seq))
                    // 事件没有发送人，不算；自己发的也不算；已撤回的也不算
                    .filter(messages::Column::SenderId.is_not_null())
                    .filter(messages::Column::SenderId.ne(me.as_str()))
                    .filter(messages::Column::RecalledAt.is_null())
                    .count(&self.db)
                    .await
                    .map_err(unavailable)?
            } else {
                0
            };
            listings.push(Listing {
                others: others
                    .iter()
                    .filter(|m| m.conversation == conversation.id)
                    .cloned()
                    .collect(),
                last_message: last_messages
                    .iter()
                    .find(|m| m.conversation == conversation.id)
                    .cloned(),
                unread,
                me: member,
                conversation,
            });
        }
        Ok(listings)
    }
}
