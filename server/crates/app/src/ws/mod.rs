//! WebSocket 接入。服务端通过它把变化推给在线的用户；客户端到服务端只有心跳，
//! 和"正在输入"（F8）。

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, header};
use axum::response::Response;
use serde::Deserialize;
use tokio::time::Instant;
use vibechat_core::ConversationId;
use vibechat_core::account::AuthContext;
use vibechat_core::call::{DeviceId, Endpoint};
use vibechat_protocol::{ClientMessage, ErrorCode, ServerEvent, SysHello, Typing};

use crate::calling;
use crate::error::AppError;
use crate::http::auth::ActiveUser;
use crate::state::AppState;

mod hub;

pub use hub::{ConnId, Hub, Registration};

/// 同一个会话里"正在输入"最多多久转一次（F8）。页面平时每 3 秒说一次，发出一条消息之后
/// 再打字会马上说；这里只防一个出了毛病的页面刷屏，多出来的直接丢掉。
pub const TYPING_MIN_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy)]
pub struct WsSettings {
    /// 客户端发送心跳的间隔。
    pub heartbeat: Duration,
}

impl Default for WsSettings {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(30),
        }
    }
}

impl WsSettings {
    /// 连续两次心跳都没有收到就认为连接已断。多留四分之一个间隔，容忍网络抖动。
    pub fn idle_timeout(&self) -> Duration {
        self.heartbeat * 2 + self.heartbeat / 4
    }
}

/// `/ws?device=…`：这个页面自己生成的设备编号。不带或者格式不对的，这条连接不能接电话。
#[derive(Debug, Deserialize)]
pub struct WsQuery {
    device: Option<String>,
}

pub async fn handler(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
    user: Result<ActiveUser, AppError>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Result<Response, AppError> {
    let upgrade = upgrade
        .map_err(|_| AppError::new(ErrorCode::BadRequest, "expected a websocket upgrade"))?;
    check_origin(&headers, &state.config.public_origin())?;
    // 浏览器建立 WebSocket 时会带上登录的 Cookie，连接的身份就是登录的用户
    let ActiveUser(context) = user?;
    let device = query.device.as_deref().and_then(DeviceId::parse);
    Ok(upgrade.on_upgrade(move |socket| serve(socket, state, context, device)))
}

/// 只接受从本系统页面发起的连接。浏览器会如实带上页面的来源，其他网站无法伪造。
fn check_origin(headers: &HeaderMap, expected: &str) -> Result<(), AppError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if origin == Some(expected) {
        return Ok(());
    }
    tracing::warn!(?origin, expected, "websocket rejected: origin not allowed");
    Err(AppError::new(ErrorCode::Forbidden, "origin not allowed"))
}

async fn serve(
    mut socket: WebSocket,
    state: AppState,
    context: AuthContext,
    device: Option<DeviceId>,
) {
    let user = context.user.id;
    let Registration {
        conn_id,
        mut events,
    } = state
        .hub
        .register_device(user, context.session.id, device.clone());
    let endpoint = device.map(|device| Endpoint { user, device });
    if let Some(endpoint) = &endpoint {
        calling::device_connected(&state, endpoint);
    }

    let hello = ServerEvent::SysHello(SysHello {
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
        heartbeat_interval_ms: state.ws.heartbeat.as_millis() as u32,
    });
    if send(&mut socket, &hello).await.is_ok() {
        pump(&mut socket, &mut events, &state, &context).await;
    }

    state.hub.unregister(user, conn_id);
    if let Some(endpoint) = &endpoint {
        calling::device_disconnected(&state, endpoint);
    }
    // 尽量礼貌地关闭；对方可能已经不在了，失败无所谓
    let _ = socket.send(Message::Close(None)).await;
}

/// 在连接存续期间转发事件、应答心跳、转告"正在输入"。返回即表示连接应当关闭。
async fn pump(
    socket: &mut WebSocket,
    events: &mut tokio::sync::mpsc::Receiver<ServerEvent>,
    state: &AppState,
    context: &AuthContext,
) {
    let idle_timeout = state.ws.idle_timeout();
    let mut deadline = Instant::now() + idle_timeout;
    // 每个会话最近一次转告"正在输入"的时间
    let mut typed: HashMap<ConversationId, Instant> = HashMap::new();
    loop {
        tokio::select! {
            event = events.recv() => {
                // 通道关闭：这条连接被登记表踢掉了
                let Some(event) = event else { return };
                if send(socket, &event).await.is_err() {
                    return;
                }
            }
            incoming = socket.recv() => {
                let message = match incoming {
                    Some(Ok(message)) => message,
                    Some(Err(_)) | None => return,
                };
                match message {
                    Message::Close(_) => return,
                    Message::Text(text) => {
                        deadline = Instant::now() + idle_timeout;
                        match serde_json::from_str::<ClientMessage>(text.as_str()) {
                            Ok(ClientMessage::SysPing) => {
                                if send(socket, &ServerEvent::SysPong).await.is_err() {
                                    return;
                                }
                            }
                            Ok(ClientMessage::ConvTyping(started)) => {
                                typing(state, context, &mut typed, &started.conversation_id)
                                    .await;
                            }
                            // 不认识的消息直接忽略：新版客户端连上旧版服务端时不至于被断开
                            Err(_) => {}
                        }
                    }
                    // 其他类型的帧也算对方还活着
                    _ => deadline = Instant::now() + idle_timeout,
                }
            }
            _ = tokio::time::sleep_until(deadline) => {
                tracing::debug!("websocket closed: no heartbeat");
                return;
            }
        }
    }
}

/// 转告会话里的其他人"我正在输入"。太频繁的、不是成员的、发不了消息的，都不转，也不回复。
async fn typing(
    state: &AppState,
    context: &AuthContext,
    typed: &mut HashMap<ConversationId, Instant>,
    conversation: &str,
) {
    let Ok(conversation) = conversation.parse::<ConversationId>() else {
        return;
    };
    let now = Instant::now();
    if typed
        .get(&conversation)
        .is_some_and(|last| now.duration_since(*last) < TYPING_MIN_INTERVAL)
    {
        return;
    }
    let Ok(others) = state.chat.typing(&context.user, conversation).await else {
        return;
    };
    typed.insert(conversation, now);
    if others.is_empty() {
        return;
    }
    let event = ServerEvent::ConvTyping(Typing {
        conversation_id: conversation.to_string(),
        user_id: context.user.id.to_string(),
    });
    state.hub.push(&others, &event);
}

async fn send(socket: &mut WebSocket, event: &ServerEvent) -> Result<(), axum::Error> {
    let json = serde_json::to_string(event).expect("server events always serialize");
    socket.send(Message::Text(json.into())).await
}
