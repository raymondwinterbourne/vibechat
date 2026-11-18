//! 通话的接口（F3）：发起、接听、拒绝、挂断，连接信息只转给通话里的设备，超时，
//! 通话记录；以及中转服务的临时账号。

mod common;

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine;
use common::{Client, TestApp, app};
use futures_util::StreamExt;
use serde_json::json;
use tokio::sync::mpsc::Receiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use vibechat_core::call::{DeviceId, LiveKitConfig, TurnConfig};
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    CallOutcome, CallState, CallView, ConversationList, CurrentCall, ErrorCode,
    FriendRequestResult, IceServers, Me, MessageKind, MessageList, RoomTicketView, ServerEvent,
};
use vibechat_server::calling;

#[tokio::test]
async fn without_a_relay_there_is_nothing_to_hand_out() {
    let app = app().await;
    let (mut client, _) = app.user("小明").await;
    let reply = client.get("/api/calls/ice-servers").await;
    assert_eq!(reply.status, StatusCode::OK);
    let servers: IceServers = reply.json();
    assert!(servers.ice_servers.is_empty());
    assert_eq!(servers.expires_at, None);
    // 没有配置媒体转发服务：不能群通话
    assert!(!servers.group_calls);
}

#[tokio::test]
async fn a_logged_in_user_gets_a_short_lived_account_for_the_relay() {
    let mut app = app().await;
    let mut config = (*app.state.config).clone();
    config.turn = Some(TurnConfig {
        urls: vec!["turn:turn.example.com:3478?transport=udp".to_owned()],
        secret: "north".to_owned(),
        ttl_secs: 6 * 3600,
    });
    app.state.config = Arc::new(config);

    // 要登录
    let reply = app.client().get("/api/calls/ice-servers").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized)
    );

    let (mut client, me): (_, Me) = app.user("小明").await;
    let servers: IceServers = client.get("/api/calls/ice-servers").await.json();
    let server = &servers.ice_servers[0];
    assert_eq!(server.urls, ["turn:turn.example.com:3478?transport=udp"]);
    // 用户名是"失效时间:用户编号"，失效时间在 6 小时后
    let (expires, user) = server.username.split_once(':').unwrap();
    assert_eq!(user, me.id);
    let expires: i64 = expires.parse().unwrap();
    assert_eq!(servers.expires_at, Some(expires * 1000));
    let now = app.state.accounts.now_ms() / 1000;
    assert_eq!(expires - now, 6 * 3600);
    assert!(!server.credential.is_empty());
}

// ---------- 群通话的入场凭证（F10 的技术验证） ----------

#[tokio::test]
async fn without_a_media_server_there_is_no_ticket() {
    let app = app().await;
    let (mut client, _) = app.user("小明").await;
    let reply = client
        .post("/api/calls/group-check", json!({ "device": "device-0001" }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable)
    );
}

#[tokio::test]
async fn a_logged_in_user_gets_a_ticket_for_the_check_room_only() {
    let mut app = app().await;
    let mut config = (*app.state.config).clone();
    config.livekit = Some(LiveKitConfig {
        url: "http://127.0.0.1:7880".to_owned(),
        api_key: "devkey".to_owned(),
        api_secret: "0123456789abcdef0123456789abcdef".to_owned(),
    });
    app.state.config = Arc::new(config);

    // 要登录
    let reply = app
        .client()
        .post("/api/calls/group-check", json!({ "device": "device-0001" }))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::UNAUTHORIZED, ErrorCode::Unauthorized)
    );

    let (mut client, me): (_, Me) = app.user("小明").await;
    // 设备编号不像样的不要
    let reply = client
        .post("/api/calls/group-check", json!({ "device": "a b" }))
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let ticket: RoomTicketView = client
        .post("/api/calls/group-check", json!({ "device": "device-0001" }))
        .await
        .json();
    // 浏览器连网页的地址下的 /livekit，不直接连媒体转发服务
    assert_eq!(
        ticket.url,
        format!("ws{}/livekit", &app.state.config.public_origin()[4..])
    );
    assert_eq!(ticket.room, "check");
    // 页面据此知道这台服务器能群通话
    let servers: IceServers = client.get("/api/calls/ice-servers").await.json();
    assert!(servers.group_calls);
    assert_eq!(ticket.identity, format!("{}:device-0001", me.id));

    // 凭证里写的：谁签的、是谁、只能进这一个房间、只能发麦克风、十分钟后失效
    let parts: Vec<&str> = ticket.token.split('.').collect();
    assert_eq!(parts.len(), 3);
    let claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts[1])
            .unwrap(),
    )
    .unwrap();
    let now = app.state.accounts.now_ms() / 1000;
    assert_eq!(claims["iss"], "devkey");
    assert_eq!(claims["sub"], ticket.identity);
    assert_eq!(claims["nbf"], now);
    assert_eq!(claims["exp"], now + 600);
    assert_eq!(ticket.expires_at, (now + 600) * 1000);
    assert_eq!(
        claims["video"],
        json!({
            "room": "check",
            "roomJoin": true,
            "canPublish": true,
            "canSubscribe": true,
            "canPublishData": false,
            "canPublishSources": ["microphone"],
        })
    );
    // 密钥本身不在凭证里
    assert!(!ticket.token.contains("0123456789abcdef"));

    // 明说要摄像头的，凭证才放行画面（F11）
    let with_camera: RoomTicketView = client
        .post(
            "/api/calls/group-check",
            json!({ "device": "device-0001", "camera": true }),
        )
        .await
        .json();
    let claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(with_camera.token.split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        claims["video"]["canPublishSources"],
        json!(["microphone", "camera"])
    );

    // 共享的屏幕同样要明说（F12），和摄像头各管各的
    let with_screen: RoomTicketView = client
        .post(
            "/api/calls/group-check",
            json!({ "device": "device-0001", "screen": true }),
        )
        .await
        .json();
    let claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(with_screen.token.split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        claims["video"]["canPublishSources"],
        json!(["microphone", "screen_share"])
    );
}

// ---------- 通话的流程 ----------

/// 一台设备收到的推送。像一条带着设备编号的 WebSocket 连接那样登记到推送表里。
struct Device {
    name: String,
    events: Receiver<ServerEvent>,
    conn: vibechat_server::ws::ConnId,
    user: UserId,
}

impl Device {
    fn open(app: &TestApp, me: &Me, name: &str) -> Self {
        let user: UserId = me.id.parse().unwrap();
        let name = format!("{name}-device");
        let registration = app.state.hub.register_device(
            user,
            SessionId::new(),
            Some(DeviceId::parse(&name).unwrap()),
        );
        Self {
            name,
            events: registration.events,
            conn: registration.conn_id,
            user,
        }
    }

    fn take(&mut self) -> Vec<ServerEvent> {
        std::iter::from_fn(|| self.events.try_recv().ok()).collect()
    }

    /// 这台设备收到的通话变化。
    fn calls(&mut self) -> Vec<CallView> {
        self.take()
            .into_iter()
            .filter_map(|event| match event {
                ServerEvent::CallUpdated(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    /// 像 WebSocket 断开那样离开推送表。
    fn close(self, app: &TestApp) {
        app.state.hub.unregister(self.user, self.conn);
        let endpoint = vibechat_core::call::Endpoint {
            user: self.user,
            device: DeviceId::parse(&self.name).unwrap(),
        };
        calling::device_disconnected(&app.state, &endpoint);
    }
}

/// 两个好友和他们的单聊。
async fn friends(app: &TestApp) -> ((Client, Me), (Client, Me), String) {
    let (mut a, a_me) = app.user("小明").await;
    let (mut b, b_me) = app.user("小红").await;
    let sent: FriendRequestResult = a
        .post("/api/friend-requests", json!({ "to": b_me.id }))
        .await
        .json();
    b.post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    let list: ConversationList = a.get("/api/conversations").await.json();
    ((a, a_me), (b, b_me), list.items[0].id.clone())
}

async fn call(client: &mut Client, conversation: &str, device: &str) -> CallView {
    let reply = client
        .post(
            "/api/calls",
            json!({ "conversation_id": conversation, "device": format!("{device}-device") }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn act(client: &mut Client, call: &CallView, action: &str, device: &str) -> common::Reply {
    client
        .post(
            &format!("/api/calls/{}/{action}", call.id),
            json!({ "device": format!("{device}-device") }),
        )
        .await
}

async fn signal(client: &mut Client, call: &CallView, device: &str, text: &str) -> common::Reply {
    client
        .post(
            &format!("/api/calls/{}/signal", call.id),
            json!({ "device": format!("{device}-device"), "signal": text }),
        )
        .await
}

/// 会话里最后一条。
async fn last_message(client: &mut Client, conversation: &str) -> vibechat_protocol::MessageView {
    let list: MessageList = client
        .get(&format!("/api/conversations/{conversation}/messages"))
        .await
        .json();
    list.items.last().cloned().unwrap()
}

async fn unread(client: &mut Client, conversation: &str) -> u32 {
    let list: ConversationList = client.get("/api/conversations").await.json();
    list.items
        .into_iter()
        .find(|item| item.id == conversation)
        .unwrap()
        .unread
}

#[tokio::test]
async fn a_call_rings_every_device_and_connects_with_the_one_that_answers() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let mut a_laptop = Device::open(&app, &a_me, "a-laptop");
    let mut a_phone = Device::open(&app, &a_me, "a-phone");
    let mut b_laptop = Device::open(&app, &b_me, "b-laptop");
    let mut b_phone = Device::open(&app, &b_me, "b-phone");

    let ringing = call(&mut a, &conversation, "a-laptop").await;
    assert_eq!(ringing.state, CallState::Ringing);
    assert_eq!(ringing.caller_id, a_me.id);
    assert_eq!(ringing.callee_id, b_me.id);
    assert_eq!(ringing.caller_device, "a-laptop-device");
    assert_eq!(ringing.conversation_id, conversation);
    // 双方的每一台设备都知道：被叫的响铃，主叫的另一台显示"正在通话中"
    for device in [&mut a_laptop, &mut a_phone, &mut b_laptop, &mut b_phone] {
        assert_eq!(device.calls(), vec![ringing.clone()]);
    }
    let current: CurrentCall = b.get("/api/calls/current").await.json();
    assert_eq!(current.call, Some(ringing.clone()));

    app.clock.advance(4_000);
    let reply = act(&mut b, &ringing, "accept", "b-phone").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let active: CallView = reply.json();
    assert_eq!(active.state, CallState::Active);
    assert_eq!(active.callee_device.as_deref(), Some("b-phone-device"));
    for device in [&mut a_laptop, &mut a_phone, &mut b_laptop, &mut b_phone] {
        assert_eq!(device.calls(), vec![active.clone()]);
    }
    // 另一台晚了一步
    let late = act(&mut b, &ringing, "accept", "b-laptop").await;
    assert_eq!(
        (late.status, late.error().code),
        (StatusCode::CONFLICT, ErrorCode::CallNotRinging)
    );

    // 连接信息只到对方通话里的那一台
    let reply = signal(&mut a, &active, "a-laptop", "offer-sdp").await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());
    assert_eq!(
        b_phone.take(),
        vec![ServerEvent::CallSignal(vibechat_protocol::CallSignal {
            call_id: active.id.clone(),
            signal: "offer-sdp".to_owned(),
        })]
    );
    assert!(b_laptop.take().is_empty());
    assert!(a_phone.take().is_empty());
    signal(&mut b, &active, "b-phone", "answer-sdp").await;
    assert_eq!(a_laptop.take().len(), 1);

    // 通了三分钟十二秒，被叫挂断
    app.clock.advance(192_000);
    let ended: CallView = act(&mut b, &active, "hangup", "b-phone").await.json();
    assert_eq!(ended.state, CallState::Ended);
    assert_eq!(ended.outcome, Some(CallOutcome::Completed));
    for device in [&mut a_laptop, &mut b_phone] {
        let events = device.take();
        assert_eq!(events[0], ServerEvent::CallUpdated(ended.clone()));
        // 随后是会话里的通话记录
        let ServerEvent::MsgNew(record) = &events[1] else {
            panic!("expected the call record, got {:?}", events[1]);
        };
        assert_eq!(record.kind, MessageKind::Call);
        assert_eq!(record.sender_id.as_deref(), Some(a_me.id.as_str()));
        assert_eq!(record.call_outcome, Some(CallOutcome::Completed));
        assert_eq!(record.duration_ms, Some(192_000));
    }
    let record = last_message(&mut b, &conversation).await;
    assert_eq!(record.kind, MessageKind::Call);
    let current: CurrentCall = a.get("/api/calls/current").await.json();
    assert_eq!(current.call, None);
}

#[tokio::test]
async fn the_caller_cancels_and_the_callee_sees_a_missed_call() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let _a_device = Device::open(&app, &a_me, "a-laptop");
    let mut b_device = Device::open(&app, &b_me, "b-phone");
    let unread_before = unread(&mut b, &conversation).await;

    let ringing = call(&mut a, &conversation, "a-laptop").await;
    // 主叫的另一台设备不能取消
    let wrong = act(&mut a, &ringing, "hangup", "a-phone").await;
    assert_eq!(
        (wrong.status, wrong.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::WrongCallDevice)
    );
    let ended: CallView = act(&mut a, &ringing, "hangup", "a-laptop").await.json();
    assert_eq!(ended.outcome, Some(CallOutcome::Cancelled));
    assert_eq!(b_device.calls().last(), Some(&ended));
    assert_eq!(unread(&mut b, &conversation).await, unread_before + 1);
    let record = last_message(&mut b, &conversation).await;
    assert_eq!(record.call_outcome, Some(CallOutcome::Cancelled));
    assert_eq!(record.duration_ms, None);
}

#[tokio::test]
async fn the_callee_rejects_from_any_device() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let mut a_device = Device::open(&app, &a_me, "a-laptop");
    let _b_device = Device::open(&app, &b_me, "b-phone");

    let ringing = call(&mut a, &conversation, "a-laptop").await;
    let reply = b
        .post(&format!("/api/calls/{}/reject", ringing.id), json!({}))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let ended: CallView = reply.json();
    assert_eq!(ended.outcome, Some(CallOutcome::Rejected));
    assert_eq!(a_device.calls().last(), Some(&ended));

    // 主叫不能"拒绝"自己的电话
    let ringing = call(&mut a, &conversation, "a-laptop").await;
    let reply = a
        .post(&format!("/api/calls/{}/reject", ringing.id), json!({}))
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::CallNotFound)
    );
}

#[tokio::test]
async fn calling_someone_with_no_device_online_ends_at_once() {
    let app = app().await;
    let ((mut a, a_me), (mut b, _), conversation) = friends(&app).await;
    let _a_device = Device::open(&app, &a_me, "a-laptop");

    let ended = call(&mut a, &conversation, "a-laptop").await;
    assert_eq!(ended.state, CallState::Ended);
    assert_eq!(ended.outcome, Some(CallOutcome::Offline));
    // 对方上线后看到未接来电
    let record = last_message(&mut b, &conversation).await;
    assert_eq!(record.call_outcome, Some(CallOutcome::Offline));
    assert!(unread(&mut b, &conversation).await >= 1);
}

#[tokio::test]
async fn calling_someone_who_is_in_another_call_is_busy() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let (mut c, c_me) = app.user("小刚").await;
    let sent: FriendRequestResult = c
        .post("/api/friend-requests", json!({ "to": b_me.id }))
        .await
        .json();
    b.post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    let list: ConversationList = c.get("/api/conversations").await.json();
    let c_with_b = list.items[0].id.clone();
    let _devices = [
        Device::open(&app, &a_me, "a-laptop"),
        Device::open(&app, &b_me, "b-phone"),
        Device::open(&app, &c_me, "c-phone"),
    ];

    let ringing = call(&mut a, &conversation, "a-laptop").await;
    act(&mut b, &ringing, "accept", "b-phone").await;
    let busy = call(&mut c, &c_with_b, "c-phone").await;
    assert_eq!(busy.outcome, Some(CallOutcome::Busy));

    // 自己正在通话中，不能再打
    let reply = b
        .post(
            "/api/calls",
            json!({ "conversation_id": c_with_b, "device": "b-laptop-device" }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::AlreadyInCall)
    );
}

#[tokio::test]
async fn only_one_to_one_chats_with_a_friend_can_call() {
    let app = app().await;
    let ((mut a, a_me), (_, b_me), conversation) = friends(&app).await;
    let _device = Device::open(&app, &a_me, "a-laptop");

    // 和自己的对话
    let opened: vibechat_protocol::ConversationView = a
        .post("/api/conversations/direct", json!({ "user_id": a_me.id }))
        .await
        .json();
    let reply = a
        .post(
            "/api/calls",
            json!({ "conversation_id": opened.id, "device": "a-laptop-device" }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::CallNotAllowed)
    );

    // 设备编号不像样
    let reply = a
        .post(
            "/api/calls",
            json!({ "conversation_id": conversation, "device": "x" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    // 已经不是好友了
    a.delete(&format!("/api/friends/{}", b_me.id)).await;
    let reply = a
        .post(
            "/api/calls",
            json!({ "conversation_id": conversation, "device": "a-laptop-device" }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::NotFriends);

    // 别人的会话
    let (mut stranger, _) = app.user("路人").await;
    let reply = stranger
        .post(
            "/api/calls",
            json!({ "conversation_id": conversation, "device": "s-laptop-device" }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);
}

#[tokio::test]
async fn connection_details_are_only_accepted_from_the_devices_in_the_call() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let _devices = [
        Device::open(&app, &a_me, "a-laptop"),
        Device::open(&app, &b_me, "b-phone"),
    ];
    let ringing = call(&mut a, &conversation, "a-laptop").await;

    // 还没接通
    let reply = signal(&mut a, &ringing, "a-laptop", "offer").await;
    assert_eq!(reply.error().code, ErrorCode::CallNotAnswered);

    act(&mut b, &ringing, "accept", "b-phone").await;
    let reply = signal(&mut a, &ringing, "a-phone", "offer").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::WrongCallDevice)
    );
    let (mut stranger, _) = app.user("路人").await;
    let reply = signal(&mut stranger, &ringing, "s-phone", "offer").await;
    assert_eq!(reply.error().code, ErrorCode::CallNotFound);
    let reply = signal(&mut a, &ringing, "a-laptop", "").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = signal(&mut a, &ringing, "a-laptop", &"x".repeat(64 * 1024 + 1)).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn nobody_answering_ends_as_missed_when_the_time_is_up() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let mut a_device = Device::open(&app, &a_me, "a-laptop");
    let _b_device = Device::open(&app, &b_me, "b-phone");
    call(&mut a, &conversation, "a-laptop").await;
    a_device.take();

    app.clock.advance(44_000);
    calling::settle(&app.state).await;
    assert!(a_device.calls().is_empty());

    app.clock.advance(1_000);
    calling::settle(&app.state).await;
    let ended = a_device.calls();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].outcome, Some(CallOutcome::Missed));
    let record = last_message(&mut b, &conversation).await;
    assert_eq!(record.call_outcome, Some(CallOutcome::Missed));
}

#[tokio::test]
async fn a_device_that_stays_disconnected_ends_the_call() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let mut a_device = Device::open(&app, &a_me, "a-laptop");
    let b_device = Device::open(&app, &b_me, "b-phone");
    let ringing = call(&mut a, &conversation, "a-laptop").await;
    act(&mut b, &ringing, "accept", "b-phone").await;
    a_device.take();

    // 被叫的页面关了：30 秒内没有回来，算网络中断
    b_device.close(&app);
    app.clock.advance(29_000);
    calling::settle(&app.state).await;
    assert!(a_device.calls().is_empty());
    app.clock.advance(1_000);
    calling::settle(&app.state).await;
    let ended = a_device.calls();
    assert_eq!(ended[0].outcome, Some(CallOutcome::Interrupted));
    assert_eq!(
        ended[0]
            .answered_at
            .map(|at| ended[0].ended_at.unwrap() - at),
        Some(30_000)
    );
}

#[tokio::test]
async fn a_page_that_names_its_device_on_the_websocket_can_be_called() {
    let app = app().await;
    let addr = app.spawn().await;
    let ((mut a, a_me), (b, b_me), conversation) = friends(&app).await;
    let _a_device = Device::open(&app, &a_me, "a-laptop");
    let b_user: UserId = b_me.id.parse().unwrap();

    // 旧版本的页面不带设备编号：算不在线
    let old_page = open_socket(addr, &b, None).await;
    assert!(!app.state.hub.can_ring(b_user));
    drop(old_page);

    let mut socket = open_socket(addr, &b, Some("b-phone-device")).await;
    wait_until(|| app.state.hub.can_ring(b_user)).await;
    let ringing = call(&mut a, &conversation, "a-laptop").await;
    assert_eq!(ringing.state, CallState::Ringing);
    // 来电推到了这条连接上
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = message else {
            continue;
        };
        if let ServerEvent::CallUpdated(view) = serde_json::from_str(text.as_str()).unwrap() {
            assert_eq!(view, ringing);
            break;
        }
    }

    // 连接断开后，这台设备不再算在线
    drop(socket);
    wait_until(|| !app.state.hub.can_ring(b_user)).await;
}

async fn open_socket(
    addr: std::net::SocketAddr,
    client: &Client,
    device: Option<&str>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = match device {
        Some(device) => format!("ws://{addr}/ws?device={device}"),
        None => format!("ws://{addr}/ws"),
    };
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_static(common::ORIGIN));
    request.headers_mut().insert(
        "cookie",
        HeaderValue::from_str(client.cookie.as_deref().unwrap()).unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

async fn wait_until(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !check() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the condition became true in time");
}

#[tokio::test]
async fn a_callee_whose_microphone_fails_ends_the_call_and_the_caller_learns_why() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let mut a_device = Device::open(&app, &a_me, "a-laptop");
    let _b_device = Device::open(&app, &b_me, "b-phone");
    let ringing = call(&mut a, &conversation, "a-laptop").await;
    let reply = b
        .post(
            &format!("/api/calls/{}/reject", ringing.id),
            json!({ "reason": "no_microphone" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let ended: CallView = reply.json();
    assert_eq!(ended.outcome, Some(CallOutcome::NoMicrophone));
    assert_eq!(a_device.calls().last(), Some(&ended));
    let record = last_message(&mut a, &conversation).await;
    assert_eq!(record.call_outcome, Some(CallOutcome::NoMicrophone));
}

#[tokio::test]
async fn hanging_up_because_the_audio_dropped_records_an_interruption() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let _devices = [
        Device::open(&app, &a_me, "a-laptop"),
        Device::open(&app, &b_me, "b-phone"),
    ];
    let ringing = call(&mut a, &conversation, "a-laptop").await;
    act(&mut b, &ringing, "accept", "b-phone").await;
    let reply = a
        .post(
            &format!("/api/calls/{}/hangup", ringing.id),
            json!({ "device": "a-laptop-device", "reason": "network" }),
        )
        .await;
    let ended: CallView = reply.json();
    assert_eq!(ended.outcome, Some(CallOutcome::Interrupted));
}

#[tokio::test]
async fn a_video_call_says_so_everywhere_and_in_its_record() {
    let app = app().await;
    let ((mut a, a_me), (mut b, b_me), conversation) = friends(&app).await;
    let _a_device = Device::open(&app, &a_me, "a-laptop");
    let mut b_device = Device::open(&app, &b_me, "b-phone");
    let reply = a
        .post(
            "/api/calls",
            json!({ "conversation_id": conversation, "device": "a-laptop-device", "video": true }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let ringing: CallView = reply.json();
    assert!(ringing.video);
    assert!(b_device.calls()[0].video);
    act(&mut b, &ringing, "accept", "b-phone").await;
    act(&mut b, &ringing, "hangup", "b-phone").await;
    let record = last_message(&mut a, &conversation).await;
    assert_eq!(record.call_outcome, Some(CallOutcome::Completed));
    assert!(record.call_video);

    // 不说就是语音通话
    let voice = call(&mut a, &conversation, "a-laptop").await;
    assert!(!voice.video);
}
