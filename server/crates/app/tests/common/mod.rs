//! 服务端测试的公共部分：用内存里的假数据存储搭一个完整的服务端，不需要数据库。
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use serde::de::DeserializeOwned;
use tower::ServiceExt;
use vibechat_core::UserId;
use vibechat_core::account::Limits;
use vibechat_core::call::{CallSettings, Calls, RecordingRooms};
use vibechat_core::testing::{
    ManualClock, MemoryStore, Outbox, account_service, admin_service, chat_service,
    contact_service, file_service,
};
use vibechat_protocol::{ErrorResponse, Me};
use vibechat_server::config::Config;
use vibechat_server::http::router;
use vibechat_server::state::AppState;
use vibechat_server::ws::{Hub, WsSettings};

/// 测试里"页面"的来源，对应配置里的 PUBLIC_URL。
pub const ORIGIN: &str = "http://test.local";
pub const PASSWORD: &str = "correct-horse-1";
pub const ADMIN_INITIAL_PASSWORD: &str = "initial-pass-1";
pub const ADMIN_PASSWORD: &str = "admin-pass-2";

pub struct TestApp {
    pub state: AppState,
    pub store: Arc<MemoryStore>,
    pub clock: Arc<ManualClock>,
    /// "发出去"的邮件。
    pub outbox: Arc<Outbox>,
    /// 群通话在媒体转发服务上的房间：假的，只记下服务端要它做了什么。
    pub rooms: Arc<RecordingRooms>,
}

pub async fn app() -> TestApp {
    app_with(Duration::from_secs(30)).await
}

pub async fn app_with(heartbeat: Duration) -> TestApp {
    let config = Config::from_lookup(|name| match name {
        "PUBLIC_URL" => Some(ORIGIN.to_owned()),
        "DATABASE_URL" => Some("sqlite::memory:".to_owned()),
        "FILES_DIR" => Some("/unused".to_owned()),
        _ => None,
    })
    .unwrap();
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    // 限速放得很宽，测试里大量请求来自同一个"来源"
    let limits = Limits {
        logins_per_minute: 10_000,
        registrations_per_minute: 10_000,
    };
    let accounts = Arc::new(account_service(&store, clock.clone(), limits).await);
    let chat = Arc::new(chat_service(&store, clock.clone()));
    let (admin, outbox) = admin_service(&store, clock.clone(), accounts.clone(), chat.clone());
    let rooms = Arc::new(RecordingRooms::default());
    let state = AppState {
        config: Arc::new(config),
        stores: store.stores(),
        accounts,
        contacts: Arc::new(contact_service(&store, clock.clone())),
        chat,
        files: Arc::new(file_service(&store, clock.clone())),
        admin: Arc::new(admin),
        hub: Arc::new(Hub::new()),
        calls: Arc::new(Calls::new(clock.clone(), CallSettings::default())),
        rooms: rooms.clone(),
        ws: WsSettings { heartbeat },
    };
    TestApp {
        state,
        store,
        clock,
        outbox,
        rooms,
    }
}

impl TestApp {
    /// 一个还没有登录的"浏览器"。
    pub fn client(&self) -> Client {
        Client {
            router: router(self.state.clone()),
            cookie: None,
            origin: Some(ORIGIN),
        }
    }

    /// 在本机的一个空闲端口上启动服务端，返回它的地址。WebSocket 的测试需要真实的连接。
    pub async fn spawn(&self) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let service =
            router(self.state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        tokio::spawn(async move {
            axum::serve(listener, service).await.unwrap();
        });
        addr
    }

    /// 现在的时间，UTC 毫秒。
    pub fn clock_now(&self) -> i64 {
        self.state.accounts.now_ms()
    }

    /// 放一个新的邀请码，返回它。
    pub fn invite_code(&self) -> String {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let code = format!("TEST{:012}", NEXT.fetch_add(1, Ordering::Relaxed));
        self.store.add_invite_code(&code, UserId::new());
        code
    }

    /// 注册一个新用户，返回已经登录的"浏览器"和他的资料。
    pub async fn user(&self, nickname: &str) -> (Client, Me) {
        let mut client = self.client();
        let reply = client
            .post(
                "/api/auth/register",
                serde_json::json!({
                    "invite_code": self.invite_code(),
                    "nickname": nickname,
                    "password": PASSWORD,
                }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
        let me = reply.json();
        (client, me)
    }

    /// 创建第一名管理员并完成首次登录后的改密码，返回已经登录的"浏览器"。
    pub async fn admin(&self) -> Client {
        self.state
            .accounts
            .bootstrap_admin("admin@example.com", ADMIN_INITIAL_PASSWORD)
            .await
            .unwrap();
        let mut client = self.client();
        let reply = client
            .post(
                "/api/auth/login",
                serde_json::json!({ "handle": "admin", "password": ADMIN_INITIAL_PASSWORD }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::OK);
        let reply = client
            .put(
                "/api/me/password",
                serde_json::json!({
                    "current_password": ADMIN_INITIAL_PASSWORD,
                    "new_password": ADMIN_PASSWORD,
                }),
            )
            .await;
        assert_eq!(reply.status, StatusCode::NO_CONTENT);
        client
    }
}

/// 模拟一个浏览器：记住登录的 Cookie，每个请求带上页面的来源。
#[derive(Clone)]
pub struct Client {
    router: Router,
    pub cookie: Option<String>,
    pub origin: Option<&'static str>,
}

pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json<T: DeserializeOwned>(&self) -> T {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("unexpected body ({err}): {}", self.text()))
    }

    pub fn error(&self) -> ErrorResponse {
        self.json()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

impl Client {
    pub async fn get(&mut self, path: &str) -> Reply {
        self.send(
            Request::builder().method(Method::GET).uri(path),
            Body::empty(),
        )
        .await
    }

    pub async fn post(&mut self, path: &str, body: serde_json::Value) -> Reply {
        self.json(Method::POST, path, body).await
    }

    pub async fn put(&mut self, path: &str, body: serde_json::Value) -> Reply {
        self.json(Method::PUT, path, body).await
    }

    pub async fn patch(&mut self, path: &str, body: serde_json::Value) -> Reply {
        self.json(Method::PATCH, path, body).await
    }

    pub async fn delete(&mut self, path: &str) -> Reply {
        self.send(
            Request::builder().method(Method::DELETE).uri(path),
            Body::empty(),
        )
        .await
    }

    /// 发送不带请求体的 POST。
    pub async fn post_empty(&mut self, path: &str) -> Reply {
        self.send(
            Request::builder().method(Method::POST).uri(path),
            Body::empty(),
        )
        .await
    }

    /// 发送不带请求体的 PUT。
    pub async fn put_empty(&mut self, path: &str) -> Reply {
        self.send(
            Request::builder().method(Method::PUT).uri(path),
            Body::empty(),
        )
        .await
    }

    /// 发送原始的请求体，例如上传文件。
    pub async fn put_bytes(&mut self, path: &str, content: Vec<u8>) -> Reply {
        self.send(
            Request::builder().method(Method::PUT).uri(path),
            Body::from(content),
        )
        .await
    }

    async fn json(&mut self, method: Method, path: &str, body: serde_json::Value) -> Reply {
        self.send(
            Request::builder()
                .method(method)
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json"),
            Body::from(body.to_string()),
        )
        .await
    }

    pub async fn send(&mut self, mut builder: axum::http::request::Builder, body: Body) -> Reply {
        if let Some(origin) = self.origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        if let Some(cookie) = &self.cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let (parts, body) = response.into_parts();

        // 像浏览器一样记住或丢掉登录的 Cookie
        for value in parts.headers.get_all(header::SET_COOKIE) {
            let text = value.to_str().unwrap();
            if let Some(pair) = text
                .split(';')
                .next()
                .filter(|p| p.starts_with("vc_session="))
            {
                self.cookie = if text.contains("Max-Age=0") {
                    None
                } else {
                    Some(pair.to_owned())
                };
            }
        }

        Reply {
            status: parts.status,
            headers: parts.headers,
            body: to_bytes(body, usize::MAX).await.unwrap().to_vec(),
        }
    }

    /// 登录的 Cookie 里的令牌本身。
    pub fn token(&self) -> &str {
        self.cookie
            .as_deref()
            .and_then(|cookie| cookie.strip_prefix("vc_session="))
            .expect("client is logged in")
    }
}
