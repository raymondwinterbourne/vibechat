//! 通讯录：按 ID 查找用户、好友申请、好友。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use vibechat_core::account::model::User;
use vibechat_core::contact::{ContactError, Relation, RequestOutcome};
use vibechat_core::{FriendRequestId, UserId};
use vibechat_protocol::{
    FriendList, FriendRemoved, FriendRequestList, FriendRequestResult, FriendView,
    SendFriendRequest, ServerEvent, SetRemarkRequest, UserLookup,
};

use super::auth::ActiveUser;
use super::json::{ApiJson, ApiQuery};
use super::{chat, views};
use crate::error::AppError;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LookupQuery {
    handle: String,
}

pub async fn lookup(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiQuery(query): ApiQuery<LookupQuery>,
) -> Result<Json<UserLookup>, AppError> {
    let (card, relation) = state.contacts.lookup(&context.user, &query.handle).await?;
    let request_id = match relation {
        Relation::RequestReceived(id) => Some(id.to_string()),
        _ => None,
    };
    Ok(Json(UserLookup {
        user: views::user_card(&card),
        relation: views::relation(relation),
        request_id,
    }))
}

pub async fn list_requests(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<FriendRequestList>, AppError> {
    let me = context.user.id;
    let items = state
        .contacts
        .list_requests(&context.user)
        .await?
        .iter()
        .map(|entry| views::friend_request(&entry.request, &entry.other, me))
        .collect();
    Ok(Json(FriendRequestList { items }))
}

pub async fn send_request(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    ApiJson(request): ApiJson<SendFriendRequest>,
) -> Result<(StatusCode, Json<FriendRequestResult>), AppError> {
    // 编号格式不对和用户不存在是同一种回答
    let to: UserId = request.to.parse().map_err(|_| ContactError::UserNotFound)?;
    let outcome = state
        .contacts
        .send_request(&context.user, to, request.message.as_deref().unwrap_or(""))
        .await?;
    let result = announce_request(&state, &context.user, &outcome);
    greet_new_friends(&state, &outcome).await;
    Ok((StatusCode::CREATED, result))
}

pub async fn accept_request(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<FriendRequestResult>, AppError> {
    let outcome = state
        .contacts
        .accept_request(&context.user, request_id(&id)?)
        .await?;
    let result = announce_request(&state, &context.user, &outcome);
    greet_new_friends(&state, &outcome).await;
    Ok(result)
}

pub async fn reject_request(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<FriendRequestResult>, AppError> {
    let outcome = state
        .contacts
        .reject_request(&context.user, request_id(&id)?)
        .await?;
    Ok(announce_request(&state, &context.user, &outcome))
}

/// 两个人因为这一步成为了好友：在他们的会话里写入一条"已经成为好友"的提示，
/// 会话因此出现在双方的聊天列表里。放在"多了一个好友"的推送之后，页面先知道有了这个好友。
async fn greet_new_friends(state: &AppState, outcome: &RequestOutcome) {
    if outcome.new_friends.is_none() {
        return;
    }
    match state
        .chat
        .greet_new_friends(outcome.from.id, outcome.to.id)
        .await
    {
        Ok(posted) => {
            chat::announce_message(state, &posted);
        }
        // 好友关系已经建立。这条提示没有写成不影响聊天：会话在第一次打开时照样会创建
        Err(err) => tracing::warn!("could not greet new friends: {err}"),
    }
}

fn request_id(text: &str) -> Result<FriendRequestId, ContactError> {
    text.parse().map_err(|_| ContactError::RequestNotFound)
}

/// 把一条申请现在的样子推给双方的每一处登录，各自看到的"对方"不同。
/// 两人因此成为好友时，再各推一条"多了一个好友"。返回值是给发起这次请求的人的应答。
fn announce_request(
    state: &AppState,
    me: &User,
    outcome: &RequestOutcome,
) -> Json<FriendRequestResult> {
    let RequestOutcome {
        request, from, to, ..
    } = outcome;
    let for_requester = views::friend_request(request, to, from.id);
    let for_recipient = views::friend_request(request, from, to.id);
    state.hub.push(
        &[from.id],
        &ServerEvent::ContactRequest(for_requester.clone()),
    );
    state.hub.push(
        &[to.id],
        &ServerEvent::ContactRequest(for_recipient.clone()),
    );

    let friends = outcome.new_friends.as_ref().map(|new| {
        let of_requester = views::friend(&new.of_requester);
        let of_recipient = views::friend(&new.of_recipient);
        state.hub.push(
            &[from.id],
            &ServerEvent::ContactFriend(of_requester.clone()),
        );
        state
            .hub
            .push(&[to.id], &ServerEvent::ContactFriend(of_recipient.clone()));
        (of_requester, of_recipient)
    });

    let i_am_the_requester = me.id == from.id;
    Json(FriendRequestResult {
        request: if i_am_the_requester {
            for_requester
        } else {
            for_recipient
        },
        friend: friends.map(|(of_requester, of_recipient)| {
            if i_am_the_requester {
                of_requester
            } else {
                of_recipient
            }
        }),
    })
}

pub async fn list_friends(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
) -> Result<Json<FriendList>, AppError> {
    let items = state
        .contacts
        .list_friends(&context.user)
        .await?
        .iter()
        .map(views::friend)
        .collect();
    Ok(Json(FriendList { items }))
}

fn friend_id(text: &str) -> Result<UserId, ContactError> {
    // 编号格式不对的，自然不是我的好友
    text.parse().map_err(|_| ContactError::NotFriends)
}

pub async fn friend(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Json<FriendView>, AppError> {
    let friend = state
        .contacts
        .friend(&context.user, friend_id(&id)?)
        .await?;
    Ok(Json(views::friend(&friend)))
}

pub async fn set_remark(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<SetRemarkRequest>,
) -> Result<Json<FriendView>, AppError> {
    let friend = state
        .contacts
        .set_remark(&context.user, friend_id(&id)?, &request.remark)
        .await?;
    let view = views::friend(&friend);
    // 备注只有自己看得到：只推给自己在别处的登录
    state.hub.push(
        &[context.user.id],
        &ServerEvent::ContactFriend(view.clone()),
    );
    Ok(Json(view))
}

pub async fn remove_friend(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    let me = context.user.id;
    let friend = friend_id(&id)?;
    state.contacts.remove_friend(&context.user, friend).await?;
    // 双方的通讯录里都不再有对方
    for (who, gone) in [(me, friend), (friend, me)] {
        let event = ServerEvent::ContactFriendRemoved(FriendRemoved {
            user_id: gone.to_string(),
        });
        state.hub.push(&[who], &event);
    }
    Ok(StatusCode::NO_CONTENT)
}
