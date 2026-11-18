//! WebSocket：登录和来源校验、欢迎事件、心跳、推送、登录失效时断开、断开后的清理。

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::{Client, PASSWORD, TestApp};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use vibechat_protocol::{
    ConversationView, FriendRequestResult, Me, ServerEvent, SessionList, SignedOutOthers, SysHello,
    Typing,
};
use vibechat_server::ws::Hub;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// 测试里任何一步都不应该等这么久。
const PATIENCE: Duration = Duration::from_secs(5);

async fn connect(
    addr: SocketAddr,
    origin: Option<&'static str>,
    cookie: Option<&str>,
) -> Result<Socket, Error> {
    let mut request = format!("ws://{addr}/ws").into_client_request().unwrap();
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static(origin));
    }
    if let Some(cookie) = cookie {
        request
            .headers_mut()
            .insert("cookie", HeaderValue::from_str(cookie).unwrap());
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| socket)
}

async fn next_event(socket: &mut Socket) -> ServerEvent {
    let message = timeout(PATIENCE, socket.next())
        .await
        .expect("an event arrives in time")
        .expect("connection is still open")
        .expect("frame is valid");
    match message {
        Message::Text(text) => serde_json::from_str(text.as_str()).expect("a known server event"),
        other => panic!("expected a text frame, got {other:?}"),
    }
}

/// 以这个已登录的"浏览器"的身份连上，并读掉欢迎事件。
async fn connected(addr: SocketAddr, client: &Client) -> Socket {
    let mut socket = connect(addr, Some(common::ORIGIN), client.cookie.as_deref())
        .await
        .unwrap();
    assert!(matches!(
        next_event(&mut socket).await,
        ServerEvent::SysHello(_)
    ));
    socket
}

async fn wait_for_connection_count(hub: &Hub, expected: usize) {
    timeout(PATIENCE, async {
        while hub.connection_count() != expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("connection count never became {expected}"));
}

/// 等服务端主动关闭这条连接。
async fn expect_closed(socket: &mut Socket) {
    let closed = timeout(PATIENCE, async {
        loop {
            match socket.next().await {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(closed.is_ok(), "server should close the connection");
}

fn rejection_status(result: Result<Socket, Error>) -> StatusCode {
    match result {
        Err(Error::Http(response)) => response.status(),
        Err(other) => panic!("expected an http rejection, got {other:?}"),
        Ok(_) => panic!("expected the connection to be rejected"),
    }
}

async fn app_with_user() -> (TestApp, SocketAddr, Client, Me) {
    let app = common::app().await;
    let addr = app.spawn().await;
    let (client, me) = app.user("小明").await;
    (app, addr, client, me)
}

#[tokio::test]
async fn hello_announces_the_heartbeat_interval() {
    let (_app, addr, client, _) = app_with_user().await;
    let mut socket = connect(addr, Some(common::ORIGIN), client.cookie.as_deref())
        .await
        .unwrap();

    assert_eq!(
        next_event(&mut socket).await,
        ServerEvent::SysHello(SysHello {
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
            heartbeat_interval_ms: 30_000,
        })
    );
}

#[tokio::test]
async fn a_connection_without_a_login_is_rejected() {
    let (_app, addr, _, _) = app_with_user().await;
    let result = connect(addr, Some(common::ORIGIN), None).await;
    assert_eq!(rejection_status(result), StatusCode::UNAUTHORIZED);

    let result = connect(addr, Some(common::ORIGIN), Some("vc_session=made-up")).await;
    assert_eq!(rejection_status(result), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_connection_from_another_site_is_rejected_even_with_a_login() {
    let (_app, addr, client, _) = app_with_user().await;
    let result = connect(addr, Some("http://evil.example"), client.cookie.as_deref()).await;
    assert_eq!(rejection_status(result), StatusCode::FORBIDDEN);

    let result = connect(addr, None, client.cookie.as_deref()).await;
    assert_eq!(rejection_status(result), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn ping_is_answered_with_pong() {
    let (_app, addr, client, _) = app_with_user().await;
    let mut socket = connected(addr, &client).await;

    socket
        .send(Message::text(r#"{"type":"sys.ping"}"#))
        .await
        .unwrap();
    assert_eq!(next_event(&mut socket).await, ServerEvent::SysPong);
}

#[tokio::test]
async fn unknown_message_is_ignored_and_the_connection_stays_open() {
    let (_app, addr, client, _) = app_with_user().await;
    let mut socket = connected(addr, &client).await;

    socket
        .send(Message::text(r#"{"type":"from.the.future","data":{}}"#))
        .await
        .unwrap();
    socket.send(Message::text("not even json")).await.unwrap();
    socket
        .send(Message::text(r#"{"type":"sys.ping"}"#))
        .await
        .unwrap();
    assert_eq!(next_event(&mut socket).await, ServerEvent::SysPong);
}

#[tokio::test]
async fn the_connection_belongs_to_the_logged_in_user() {
    let (app, addr, client, me) = app_with_user().await;
    let (other_client, other) = app.user("小红").await;
    let _socket = connected(addr, &client).await;
    let _other_socket = connected(addr, &other_client).await;

    let mut online: Vec<String> = app
        .state
        .hub
        .online_users()
        .iter()
        .map(ToString::to_string)
        .collect();
    online.sort();
    let mut expected = vec![me.id, other.id];
    expected.sort();
    assert_eq!(online, expected);
}

#[tokio::test]
async fn a_profile_change_reaches_the_users_other_windows_but_nobody_else() {
    let (app, addr, mut client, me) = app_with_user().await;
    let (other_client, _) = app.user("小红").await;
    let mut first_window = connected(addr, &client).await;
    let mut second_window = connected(addr, &client).await;
    let mut other_user = connected(addr, &other_client).await;

    client.patch("/api/me", json!({ "nickname": "明明" })).await;

    for window in [&mut first_window, &mut second_window] {
        match next_event(window).await {
            ServerEvent::MeUpdated(updated) => {
                assert_eq!(updated.id, me.id);
                assert_eq!(updated.nickname, "明明");
            }
            other => panic!("expected me.updated, got {other:?}"),
        }
    }
    // 另一个用户什么也收不到：发一个心跳，回来的第一条就是它的应答
    other_user
        .send(Message::text(r#"{"type":"sys.ping"}"#))
        .await
        .unwrap();
    assert_eq!(next_event(&mut other_user).await, ServerEvent::SysPong);
}

#[tokio::test]
async fn logging_out_closes_the_connections_of_that_login_only() {
    let (app, addr, mut here, me) = app_with_user().await;
    let mut elsewhere = app.client();
    elsewhere
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    let mut here_socket = connected(addr, &here).await;
    let mut elsewhere_socket = connected(addr, &elsewhere).await;

    here.post_empty("/api/auth/logout").await;

    expect_closed(&mut here_socket).await;
    wait_for_connection_count(&app.state.hub, 1).await;
    elsewhere_socket
        .send(Message::text(r#"{"type":"sys.ping"}"#))
        .await
        .unwrap();
    assert_eq!(
        next_event(&mut elsewhere_socket).await,
        ServerEvent::SysPong
    );
}

#[tokio::test]
async fn changing_the_password_closes_the_connections_of_other_logins() {
    let (app, addr, mut here, me) = app_with_user().await;
    let mut elsewhere = app.client();
    elsewhere
        .post(
            "/api/auth/login",
            json!({ "handle": me.handle, "password": PASSWORD }),
        )
        .await;
    let mut here_socket = connected(addr, &here).await;
    let mut elsewhere_socket = connected(addr, &elsewhere).await;

    here.put(
        "/api/me/password",
        json!({ "current_password": PASSWORD, "new_password": "brand-new-pass-2" }),
    )
    .await;

    expect_closed(&mut elsewhere_socket).await;
    wait_for_connection_count(&app.state.hub, 1).await;
    here_socket
        .send(Message::text(r#"{"type":"sys.ping"}"#))
        .await
        .unwrap();
    assert_eq!(next_event(&mut here_socket).await, ServerEvent::SysPong);
}

#[tokio::test]
async fn client_that_stops_sending_heartbeats_is_disconnected() {
    let app = common::app_with(Duration::from_millis(40)).await;
    let addr = app.spawn().await;
    let (client, _) = app.user("小明").await;
    let mut socket = connected(addr, &client).await;
    assert_eq!(app.state.hub.connection_count(), 1);

    // 不发心跳，等服务端主动关闭
    expect_closed(&mut socket).await;
    wait_for_connection_count(&app.state.hub, 0).await;
}

#[tokio::test]
async fn heartbeats_keep_the_connection_open() {
    let heartbeat = Duration::from_millis(40);
    let app = common::app_with(heartbeat).await;
    let addr = app.spawn().await;
    let (client, _) = app.user("小明").await;
    let mut socket = connected(addr, &client).await;

    // 持续的时间远超过空闲超时；只要按时发心跳，连接就一直在
    for _ in 0..10 {
        tokio::time::sleep(heartbeat).await;
        socket
            .send(Message::text(r#"{"type":"sys.ping"}"#))
            .await
            .unwrap();
        assert_eq!(next_event(&mut socket).await, ServerEvent::SysPong);
    }
}

#[tokio::test]
async fn closing_the_client_removes_it_from_the_hub() {
    let (app, addr, client, _) = app_with_user().await;
    let mut socket = connected(addr, &client).await;
    wait_for_connection_count(&app.state.hub, 1).await;

    socket.close(None).await.unwrap();
    wait_for_connection_count(&app.state.hub, 0).await;
    assert!(app.state.hub.online_users().is_empty());
}

/// 正在输入（F8）：转给对方，不转给自己的其他窗口；太频繁的丢掉；不是成员的会话不转。
#[tokio::test]
async fn typing_reaches_the_other_side_but_not_my_other_windows() {
    let (app, addr, mut client, me) = app_with_user().await;
    let (mut friend, friend_me) = app.user("小红").await;
    let sent = client
        .post("/api/friend-requests", json!({ "to": friend_me.id }))
        .await;
    let sent: FriendRequestResult = sent.json();
    let accept = format!("/api/friend-requests/{}/accept", sent.request.id);
    assert_eq!(friend.post_empty(&accept).await.status, StatusCode::OK);
    let opened = client
        .post(
            "/api/conversations/direct",
            json!({ "user_id": friend_me.id }),
        )
        .await;
    let conversation = opened.json::<ConversationView>().id;

    let mut mine = connected(addr, &client).await;
    let mut my_other_window = connected(addr, &client).await;
    let mut theirs = connected(addr, &friend).await;
    let typing = json!({ "type": "conv.typing", "data": { "conversation_id": conversation } });
    mine.send(Message::text(typing.to_string())).await.unwrap();
    assert_eq!(
        next_event(&mut theirs).await,
        ServerEvent::ConvTyping(Typing {
            conversation_id: conversation.clone(),
            user_id: me.id.clone(),
        })
    );
    // 马上又说了一次：丢掉。对方接下来收到的是心跳的应答
    mine.send(Message::text(typing.to_string())).await.unwrap();
    // 不认识的会话也不转
    let stranger = json!({ "type": "conv.typing", "data": { "conversation_id": "nope" } });
    mine.send(Message::text(stranger.to_string()))
        .await
        .unwrap();
    for socket in [&mut theirs, &mut my_other_window] {
        socket
            .send(Message::text(r#"{"type":"sys.ping"}"#))
            .await
            .unwrap();
        assert_eq!(next_event(socket).await, ServerEvent::SysPong);
    }
}

/// 登录设备（F9）：列出我的几次登录；让另一台下线时，它先收到原因、再断开，之后它的登录不能再用；
/// 本机不能在这里下线；让其他全部下线，本机照常。
#[tokio::test]
async fn signing_out_another_device_tells_it_why_and_ends_its_login() {
    let (app, addr, mut here, me) = app_with_user().await;
    let mut phone = app.client();
    let mut laptop = app.client();
    for other in [&mut phone, &mut laptop] {
        let reply = other
            .post(
                "/api/auth/login",
                json!({ "handle": me.handle, "password": PASSWORD }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    }
    let mut phone_socket = connected(addr, &phone).await;

    let listed: SessionList = here.get("/api/me/sessions").await.json();
    assert_eq!(listed.items.len(), 3);
    assert!(listed.items[0].current);
    assert_eq!(listed.items.iter().filter(|s| s.current).count(), 1);
    assert_eq!(listed.items.iter().filter(|s| s.online).count(), 1);
    let phones: SessionList = phone.get("/api/me/sessions").await.json();
    let phone_id = phones.items.iter().find(|s| s.current).unwrap().id.clone();
    let here_id = listed.items[0].id.clone();

    // 本机不在这里下线；不认识的找不到
    let reply = here.delete(&format!("/api/me/sessions/{here_id}")).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    let reply = here.delete("/api/me/sessions/nope").await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    let reply = here.delete(&format!("/api/me/sessions/{phone_id}")).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());
    assert_eq!(
        next_event(&mut phone_socket).await,
        ServerEvent::SysSignedOut
    );
    expect_closed(&mut phone_socket).await;
    assert_eq!(phone.get("/api/me").await.status, StatusCode::UNAUTHORIZED);

    // 其他全部下线：还剩笔记本那一台
    let ended: SignedOutOthers = here
        .post_empty("/api/me/sessions/sign-out-others")
        .await
        .json();
    assert_eq!(ended.count, 1);
    assert_eq!(laptop.get("/api/me").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(here.get("/api/me").await.status, StatusCode::OK);
    let listed: SessionList = here.get("/api/me/sessions").await.json();
    assert_eq!(listed.items.len(), 1);
}
