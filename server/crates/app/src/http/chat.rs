//! 聊天：会话列表、发消息、翻历史、已读位置，以及群和它的成员。

use axum::Json;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use vibechat_core::account::AuthContext;
use vibechat_core::chat::{
    Attached, ChatError, Draft, EditDraft, Forwarded, Found, HistoryQuery, Invited, Merged,
    MessageKind, Posted,
};
use vibechat_core::{ConversationId, UserId};
use vibechat_protocol::{
    ConversationCleared, ConversationHidden, ConversationList, ConversationMuted,
    ConversationPinned, ConversationRead, ConversationView, CreateGroupRequest,
    DeleteMessagesRequest, EditMessageRequest, ErrorCode, InviteMembersRequest, InviteResult,
    JoinApprovalRequest, JoinRequestList, JoinRequestsChanged, LimitsView, MarkReadRequest,
    MemberList, MemberProfile, MembersChanged, MessageList, MessagePlayed, MessageView,
    MessagesDeleted, MuteMemberRequest, MuteRequest, NoticeSeen, OpenDirectRequest, PinRequest,
    RenameGroupRequest, SearchResult, SendMessageRequest, ServerEvent, SetGroupNicknameRequest,
    SetNoticeRequest, TransferOwnerRequest,
};

use super::auth::ActiveUser;
use super::json::{ApiJson, ApiQuery};
use super::views;
use crate::error::AppError;
use crate::state::AppState;

fn conversation_id(text: &str) -> Result<ConversationId, ChatError> {
    // 编号格式不对和会话不存在是同一种回答
    text.parse().map_err(|_| ChatError::ConversationNotFound)
}

/// 一串用户的编号。格式不对的当作不认识的人，由后面的检查去拒绝。
fn user_ids(texts: &[String]) -> Vec<UserId> {
    texts
        .iter()
        .map(|text| text.parse().unwrap_or_else(|_| UserId::new()))
        .collect()
}

fn new_message(view: &MessageView) -> ServerEvent {
    ServerEvent::MsgNew(Box::new(view.clone()))
}

/// 把新写入的一条推给要通知的人，包括发送人自己：他在别处的登录也要看到。
pub fn announce_message(state: &AppState, posted: &Posted) -> MessageView {
    let view = views::message(&posted.message, posted.sender_name.clone(), &posted.extras);
    let hidden = &posted.quote_hidden_from;
    if hidden.is_empty() {
        state.hub.push(&posted.members, &new_message(&view));
        return view;
    }
    // 在被引用的那条消息之后才入群的人：给他们的那一份不带引用的内容
    let shown: Vec<UserId> = posted
        .members
        .iter()
        .copied()
        .filter(|user| !hidden.contains(user))
        .collect();
    state.hub.push(&shown, &new_message(&view));
    let without = views::message(
        &posted.message,
        posted.sender_name.clone(),
        &posted.extras.without_quotes(),
    );
    state.hub.push(hidden, &new_message(&without));
    view
}

pub async fn list(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<ConversationList>, AppError> {
    let items = state
        .chat
        .list(&context.user)
        .await?
        .iter()
        .map(views::conversation)
        .collect();
    Ok(Json(ConversationList { items }))
}

pub async fn open_direct(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<OpenDirectRequest>,
) -> Result<Json<ConversationView>, AppError> {
    // 编号格式不对的，自然不是我的好友
    let friend: UserId = request.user_id.parse().map_err(|_| ChatError::NotFriends)?;
    let info = state.chat.open_direct(&context.user, friend).await?;
    Ok(Json(views::conversation(&info)))
}

pub async fn show(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<ConversationView>, AppError> {
    let info = state
        .chat
        .conversation(&context.user, conversation_id(&id)?)
        .await?;
    Ok(Json(views::conversation(&info)))
}

/// 翻看历史的参数，写在地址里：`?before=120&limit=50` 是序号 120 之前的一段，
/// `?after=120` 是之后的一段。都不写时取最新的一段。
#[derive(Debug, Deserialize)]
pub struct HistoryParams {
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<u32>,
}

/// `GET /api/conversations/{id}/media`：会话里的图片或文件，从新到旧一页一页地取（F6）。
#[derive(Debug, Deserialize)]
pub struct MediaParams {
    /// `image` 或者 `file`。
    kind: String,
    before: Option<i64>,
    limit: Option<u32>,
}

pub async fn media(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiQuery(params): ApiQuery<MediaParams>,
) -> Result<Json<MessageList>, AppError> {
    let kind = match params.kind.as_str() {
        "image" => MessageKind::Image,
        "file" => MessageKind::File,
        _ => return Err(ChatError::Invalid("kind must be image or file").into()),
    };
    let page = state
        .chat
        .media(
            &context.user,
            conversation_id(&id)?,
            kind,
            params.before,
            params.limit,
        )
        .await?;
    Ok(Json(message_list(&page)))
}

/// 一页消息交出去的样子。
fn message_list(page: &vibechat_core::chat::Page) -> MessageList {
    let items = page
        .messages
        .iter()
        .map(|message| {
            let sender_name = message
                .sender
                .and_then(|sender| page.sender_names.get(&sender))
                .cloned();
            views::message(message, sender_name, &page.extras)
        })
        .collect();
    MessageList {
        items,
        has_more: page.has_more,
    }
}

pub async fn history(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiQuery(params): ApiQuery<HistoryParams>,
) -> Result<Json<MessageList>, AppError> {
    let page = state
        .chat
        .history(
            &context.user,
            conversation_id(&id)?,
            HistoryQuery {
                before: params.before,
                after: params.after,
                limit: params.limit,
            },
        )
        .await?;
    let items = page
        .messages
        .iter()
        .map(|message| {
            let sender_name = message
                .sender
                .and_then(|sender| page.sender_names.get(&sender))
                .cloned();
            views::message(message, sender_name, &page.extras)
        })
        .collect();
    Ok(Json(MessageList {
        items,
        has_more: page.has_more,
    }))
}

pub async fn send(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageView>), AppError> {
    let mentions = user_ids(request.mentions.as_deref().unwrap_or_default());
    let attachment = match &request.file_id {
        // 编号格式不对的，自然不是我上传的文件
        Some(id) => Some(Attached {
            file: id.parse().map_err(|_| ChatError::FileUnavailable)?,
            voice_duration_ms: request.voice_duration_ms,
        }),
        None => None,
    };
    let draft = Draft {
        client_id: &request.client_id,
        text: request.text.as_deref().unwrap_or(""),
        mentions: &mentions,
        mention_all: request.mention_all.unwrap_or(false),
        attachment,
        reply_to: request.reply_to,
        forward: match &request.forward {
            // 会话编号格式不对的，自然不是我看得到的会话
            Some(from) => Some(Forwarded {
                conversation: from
                    .conversation_id
                    .parse()
                    .map_err(|_| ChatError::ConversationNotFound)?,
                seq: from.seq,
            }),
            None => None,
        },
        merge: match &request.merge {
            Some(from) => Some(Merged {
                conversation: from
                    .conversation_id
                    .parse()
                    .map_err(|_| ChatError::ConversationNotFound)?,
                seqs: &from.seqs,
                title: &from.title,
            }),
            None => None,
        },
    };
    let posted = state
        .chat
        .send(&context.user, conversation_id(&id)?, draft)
        .await?;
    if posted.duplicate {
        // 重发：消息在第一次发送时已经写入并推送过了，这一次只把它交还给发送方
        let view = views::message(&posted.message, posted.sender_name.clone(), &posted.extras);
        return Ok((StatusCode::OK, Json(view)));
    }
    Ok((StatusCode::CREATED, Json(announce_message(&state, &posted))))
}

/// 撤回自己发的一条消息。应答是会话里新增的那条撤回事件。
pub async fn recall(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, seq)): Path<(String, String)>,
) -> Result<Json<MessageView>, AppError> {
    let seq: i64 = seq.parse().map_err(|_| ChatError::MessageNotFound)?;
    let posted = state
        .chat
        .recall(&context.user, conversation_id(&id)?, seq)
        .await?;
    Ok(Json(announce_message(&state, &posted)))
}

/// 编辑我发的一条消息（F8）。会话里的人都收到一条编辑事件，交回的也是它。
pub async fn edit_message(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, seq)): Path<(String, String)>,
    ApiJson(request): ApiJson<EditMessageRequest>,
) -> Result<Json<MessageView>, AppError> {
    let seq: i64 = seq.parse().map_err(|_| ChatError::MessageNotFound)?;
    let mentions = user_ids(request.mentions.as_deref().unwrap_or_default());
    let draft = EditDraft {
        text: &request.text,
        mentions: &mentions,
        mention_all: request.mention_all.unwrap_or(false),
    };
    let posted = state
        .chat
        .edit(&context.user, conversation_id(&id)?, seq, draft)
        .await?;
    Ok(Json(announce_message(&state, &posted)))
}

/// 记下我听过了一条语音。
pub async fn mark_played(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, seq)): Path<(String, String)>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    let seq: i64 = seq.parse().map_err(|_| ChatError::MessageNotFound)?;
    let played = state
        .chat
        .mark_played(&context.user, conversation, seq)
        .await?;
    if played.changed {
        // 只影响自己这一边：只推给自己在别处的登录
        let event = ServerEvent::MsgPlayed(MessagePlayed {
            conversation_id: conversation.to_string(),
            seq,
        });
        state.hub.push(&[context.user.id], &event);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 搜索的参数，写在地址里：`?q=关键词`。在一个会话里搜时还可以带 `before`（只要序号小于它的）
/// 和 `limit`，用来一页一页往更早的翻。
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    q: String,
    before: Option<i64>,
    limit: Option<u32>,
}

fn search_result(found: &Found) -> Json<SearchResult> {
    let items = found
        .hits
        .iter()
        .map(|hit| {
            let sender_name = hit
                .sender
                .and_then(|sender| found.sender_names.get(&sender))
                .cloned();
            views::message(hit, sender_name, &found.extras)
        })
        .collect();
    Json(SearchResult {
        items,
        has_more: found.has_more,
    })
}

/// 在我的全部会话里搜索。
pub async fn search(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiQuery(params): ApiQuery<SearchParams>,
) -> Result<Json<SearchResult>, AppError> {
    let found = state
        .chat
        .search(&context.user, &params.q, None, None, None)
        .await?;
    Ok(search_result(&found))
}

/// 只在一个会话里搜索。
pub async fn search_conversation(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiQuery(params): ApiQuery<SearchParams>,
) -> Result<Json<SearchResult>, AppError> {
    let conversation = conversation_id(&id)?;
    let found = state
        .chat
        .search(
            &context.user,
            &params.q,
            Some(conversation),
            params.before,
            params.limit,
        )
        .await?;
    Ok(search_result(&found))
}

/// 当前生效的几项上限：客户端据此在上传前就能提示、到时长自动停止录音、
/// 过了时限不再显示"撤回"。
pub async fn limits(
    State(state): State<AppState>,
    ActiveUser(_): ActiveUser,
) -> Result<Json<LimitsView>, AppError> {
    let limits = state.chat.limits().await?;
    Ok(Json(LimitsView {
        file_max_bytes: limits.file_max_bytes,
        voice_max_seconds: limits.voice_max_seconds,
        recall_window_seconds: limits.recall_window_seconds,
        edit_window_seconds: limits.edit_window_seconds,
        group_call_max: state.chat.group_call_max().await?,
    }))
}

pub async fn mark_read(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<MarkReadRequest>,
) -> Result<Json<ConversationRead>, AppError> {
    let conversation = conversation_id(&id)?;
    let update = state
        .chat
        .mark_read(&context.user, conversation, request.seq)
        .await?;
    let read = ConversationRead {
        conversation_id: conversation.to_string(),
        user_id: context.user.id.to_string(),
        read_seq: update.read_seq,
    };
    if update.changed {
        // 对方据此显示"已读"；我自己在别处的登录据此清掉未读数
        state
            .hub
            .push(&update.members, &ServerEvent::ConvRead(read.clone()));
    }
    Ok(Json(read))
}

pub async fn hide(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    state.chat.hide(&context.user, conversation).await?;
    // 只影响自己这一边：只推给自己在别处的登录
    let event = ServerEvent::ConvHidden(ConversationHidden {
        conversation_id: conversation.to_string(),
    });
    state.hub.push(&[context.user.id], &event);
    Ok(StatusCode::NO_CONTENT)
}

/// 把会话设为免打扰，或者取消。
pub async fn mute(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<MuteRequest>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    state
        .chat
        .mute(&context.user, conversation, request.muted)
        .await?;
    // 只影响自己这一边：只推给自己在别处的登录
    let event = ServerEvent::ConvMuted(ConversationMuted {
        conversation_id: conversation.to_string(),
        muted: request.muted,
    });
    state.hub.push(&[context.user.id], &event);
    Ok(StatusCode::NO_CONTENT)
}

/// 把会话置顶，或者取消。
pub async fn pin(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<PinRequest>,
) -> Result<Json<ConversationPinned>, AppError> {
    let conversation = conversation_id(&id)?;
    let pinned_at = state
        .chat
        .pin(&context.user, conversation, request.pinned)
        .await?;
    let pinned = ConversationPinned {
        conversation_id: conversation.to_string(),
        pinned_at,
    };
    // 只影响自己这一边：只推给自己在别处的登录
    state
        .hub
        .push(&[context.user.id], &ServerEvent::ConvPinned(pinned.clone()));
    Ok(Json(pinned))
}

/// 把几条从自己这边删掉（F6）。别人照常看得到。
pub async fn delete_for_me(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<DeleteMessagesRequest>,
) -> Result<Json<MessagesDeleted>, AppError> {
    let conversation = conversation_id(&id)?;
    let seqs = state
        .chat
        .delete_for_me(&context.user, conversation, &request.seqs)
        .await?;
    let deleted = MessagesDeleted {
        conversation_id: conversation.to_string(),
        seqs,
    };
    // 只影响自己这一边：只推给自己在别处的登录
    state.hub.push(
        &[context.user.id],
        &ServerEvent::MsgDeleted(deleted.clone()),
    );
    Ok(Json(deleted))
}

/// 清空这个会话到现在为止的记录，只对自己（F6）。清空的算读过：对方会看到"已读"。
pub async fn clear_for_me(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<ConversationCleared>, AppError> {
    let conversation = conversation_id(&id)?;
    let cleared = state.chat.clear_for_me(&context.user, conversation).await?;
    let view = ConversationCleared {
        conversation_id: conversation.to_string(),
        cleared_seq: cleared.seq,
    };
    state
        .hub
        .push(&[context.user.id], &ServerEvent::ConvCleared(view.clone()));
    if cleared.read.changed {
        let read = ConversationRead {
            conversation_id: conversation.to_string(),
            user_id: context.user.id.to_string(),
            read_seq: cleared.read.read_seq,
        };
        state
            .hub
            .push(&cleared.read.members, &ServerEvent::ConvRead(read));
    }
    Ok(Json(view))
}

// ---------- 群 ----------

/// 发布、修改或清空群公告。应答是群现在的样子；和原来的一样时什么也不改，照样交回群现在的样子。
pub async fn set_notice(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<SetNoticeRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state
        .chat
        .set_notice(&context.user, conversation, &request.text)
        .await?;
    if let Some(posted) = posted {
        announce_message(&state, &posted);
    }
    group_view(&state, &context, conversation).await
}

/// 我看过了现在的群公告。
pub async fn notice_seen(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    let seen = state
        .chat
        .mark_notice_seen(&context.user, conversation)
        .await?;
    // 只影响自己这一边：只推给自己在别处的登录
    if let Some(seq) = seen {
        let event = ServerEvent::ConvNoticeSeen(NoticeSeen {
            conversation_id: conversation.to_string(),
            seq,
        });
        state.hub.push(&[context.user.id], &event);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 改我在一个群里的昵称。群里的人都收到"名单变了"，各自重新取名单。
pub async fn set_group_nickname(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<SetGroupNicknameRequest>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    let notify = state
        .chat
        .set_group_nickname(&context.user, conversation, &request.nickname)
        .await?;
    if let Some(members) = notify {
        let event = ServerEvent::ConvMembers(MembersChanged {
            conversation_id: conversation.to_string(),
        });
        state.hub.push(&members, &event);
    }
    Ok(StatusCode::NO_CONTENT)
}

/// 我现在所在的全部群，不管它们在不在我的会话列表里。
pub async fn groups(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<ConversationList>, AppError> {
    let items = state
        .chat
        .groups(&context.user)
        .await?
        .iter()
        .map(views::conversation)
        .collect();
    Ok(Json(ConversationList { items }))
}

/// 一个群现在在我这边的样子。群有了变化之后的应答都是它。
async fn group_view(
    state: &AppState,
    context: &AuthContext,
    conversation: ConversationId,
) -> Result<Json<ConversationView>, AppError> {
    let info = state.chat.conversation(&context.user, conversation).await?;
    Ok(Json(views::conversation(&info)))
}

pub async fn create_group(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<CreateGroupRequest>,
) -> Result<(StatusCode, Json<ConversationView>), AppError> {
    let posted = state
        .chat
        .create_group(
            &context.user,
            request.name.as_deref().unwrap_or(""),
            &user_ids(&request.member_ids),
        )
        .await?;
    // 每个成员的会话列表里随之出现这个群
    announce_message(&state, &posted);
    let view = group_view(&state, &context, posted.message.conversation).await?;
    Ok((StatusCode::CREATED, view))
}

pub async fn rename_group(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<RenameGroupRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state
        .chat
        .rename(&context.user, conversation, &request.name)
        .await?;
    announce_message(&state, &posted);
    group_view(&state, &context, conversation).await
}

pub async fn set_group_avatar(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    body: Result<Bytes, BytesRejection>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    // 先确认有权限，免得白处理一张图
    state
        .chat
        .require_manager(&context.user, conversation)
        .await?;
    let content = body.map_err(|rejection| {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            AppError::new(ErrorCode::PayloadTooLarge, "file is too large")
        } else {
            AppError::new(ErrorCode::BadRequest, rejection.body_text())
        }
    })?;
    let avatar = state.accounts.store_avatar(&context, &content).await?;
    let posted = state
        .chat
        .set_group_avatar(&context.user, conversation, avatar)
        .await?;
    announce_message(&state, &posted);
    group_view(&state, &context, conversation).await
}

pub async fn dissolve_group(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state.chat.dissolve(&context.user, conversation).await?;
    announce_message(&state, &posted);
    // 群里正在进行的通话随之结束（F10）
    crate::group_calling::group_dissolved(&state, conversation).await;
    group_view(&state, &context, conversation).await
}

pub async fn members(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<MemberList>, AppError> {
    let items = state
        .chat
        .members(&context.user, conversation_id(&id)?)
        .await?
        .iter()
        .map(views::member)
        .collect();
    Ok(Json(MemberList { items }))
}

pub async fn invite_members(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<InviteMembersRequest>,
) -> Result<Json<InviteResult>, AppError> {
    let conversation = conversation_id(&id)?;
    let invited = state
        .chat
        .invite(&context.user, conversation, &user_ids(&request.user_ids))
        .await?;
    let requested = match invited {
        // 要加的人都已经在群里时什么也没有发生
        Invited::Joined(posted) => {
            if let Some(posted) = posted {
                announce_message(&state, &posted);
            }
            0
        }
        Invited::Requested { requests, managers } => {
            if !requests.is_empty() {
                join_requests_changed(&state, conversation, &managers);
            }
            requests.len() as u32
        }
    };
    let Json(conversation) = group_view(&state, &context, conversation).await?;
    Ok(Json(InviteResult {
        conversation,
        requested,
    }))
}

/// 告诉这些人：这个群的入群申请变了。
fn join_requests_changed(state: &AppState, conversation: ConversationId, users: &[UserId]) {
    let event = ServerEvent::ConvJoinRequests(JoinRequestsChanged {
        conversation_id: conversation.to_string(),
    });
    state.hub.push(users, &event);
}

/// 群主或管理员开关入群审批。
pub async fn set_join_approval(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<JoinApprovalRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    state
        .chat
        .set_join_approval(&context.user, conversation, request.enabled)
        .await?;
    group_view(&state, &context, conversation).await
}

/// 一个群的入群申请。
pub async fn join_requests(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<JoinRequestList>, AppError> {
    let requests = state
        .chat
        .join_requests(&context.user, conversation_id(&id)?)
        .await?;
    Ok(Json(JoinRequestList {
        items: requests.iter().map(views::join_request).collect(),
    }))
}

pub async fn approve_join_request(
    state: State<AppState>,
    user: ActiveUser,
    path: Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    handle_join_request(state, user, path, true).await
}

pub async fn reject_join_request(
    state: State<AppState>,
    user: ActiveUser,
    path: Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    handle_join_request(state, user, path, false).await
}

async fn handle_join_request(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, request)): Path<(String, String)>,
    approve: bool,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let request = request
        .parse()
        .map_err(|_| ChatError::JoinRequestNotFound)?;
    let handled = state
        .chat
        .handle_join_request(&context.user, conversation, request, approve)
        .await?;
    if let Some(posted) = &handled.posted {
        announce_message(&state, posted);
    }
    join_requests_changed(&state, conversation, &handled.notify);
    group_view(&state, &context, conversation).await
}

pub async fn member_profile(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, user)): Path<(String, String)>,
) -> Result<Json<MemberProfile>, AppError> {
    let user: UserId = user.parse().map_err(|_| ChatError::NotMember)?;
    let profile = state
        .chat
        .member_profile(&context.user, conversation_id(&id)?, user)
        .await?;
    Ok(Json(views::member_profile(&profile)))
}

pub async fn remove_member(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, user)): Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let user: UserId = user.parse().map_err(|_| ChatError::NotMember)?;
    let posted = state
        .chat
        .remove_member(&context.user, conversation, user)
        .await?;
    announce_message(&state, &posted);
    // 他在这个群的通话里的话，立即离开（F10）
    crate::group_calling::member_gone(&state, user, conversation).await;
    group_view(&state, &context, conversation).await
}

pub async fn leave_group(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state.chat.leave(&context.user, conversation).await?;
    announce_message(&state, &posted);
    // 退群的人在这个群的通话里的话，立即离开（F10）
    crate::group_calling::member_gone(&state, context.user.id, conversation).await;
    Ok(StatusCode::NO_CONTENT)
}

/// 群主把一名成员设为管理员。
pub async fn add_admin(
    state: State<AppState>,
    user: ActiveUser,
    path: Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    set_admin(state, user, path, true).await
}

/// 群主取消一名管理员。
pub async fn remove_admin(
    state: State<AppState>,
    user: ActiveUser,
    path: Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    set_admin(state, user, path, false).await
}

async fn set_admin(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, user)): Path<(String, String)>,
    admin: bool,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let user: UserId = user.parse().map_err(|_| ChatError::NotMember)?;
    let posted = state
        .chat
        .set_admin(&context.user, conversation, user, admin)
        .await?;
    if let Some(posted) = posted {
        announce_message(&state, &posted);
    }
    group_view(&state, &context, conversation).await
}

/// 群主或管理员禁言一名普通成员。
pub async fn mute_member(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, user)): Path<(String, String)>,
    ApiJson(request): ApiJson<MuteMemberRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let user: UserId = user.parse().map_err(|_| ChatError::NotMember)?;
    let posted = state
        .chat
        .mute_member(&context.user, conversation, user, request.minutes)
        .await?;
    announce_message(&state, &posted);
    group_view(&state, &context, conversation).await
}

/// 群主或管理员提前解除禁言。
pub async fn unmute_member(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path((id, user)): Path<(String, String)>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let user: UserId = user.parse().map_err(|_| ChatError::NotMember)?;
    let posted = state
        .chat
        .unmute_member(&context.user, conversation, user)
        .await?;
    if let Some(posted) = posted {
        announce_message(&state, &posted);
    }
    group_view(&state, &context, conversation).await
}

/// 群主或管理员开关全员禁言。
pub async fn set_all_muted(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<MuteRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let posted = state
        .chat
        .set_all_muted(&context.user, conversation, request.muted)
        .await?;
    if let Some(posted) = posted {
        announce_message(&state, &posted);
    }
    group_view(&state, &context, conversation).await
}

pub async fn transfer_owner(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<TransferOwnerRequest>,
) -> Result<Json<ConversationView>, AppError> {
    let conversation = conversation_id(&id)?;
    let to: UserId = request.user_id.parse().map_err(|_| ChatError::NotMember)?;
    let posted = state.chat.transfer(&context.user, conversation, to).await?;
    announce_message(&state, &posted);
    group_view(&state, &context, conversation).await
}
