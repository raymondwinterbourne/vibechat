//! VibeChat 服务端：把 HTTP 和 WebSocket 请求翻译成对 `vibechat-core` 的调用。
//! 这里不写业务规则。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use vibechat_core::account::handle::ADMIN_HANDLE;
use vibechat_core::account::{AccountService, AccountServiceDeps};
use vibechat_core::admin::{AdminService, AdminServiceDeps};
use vibechat_core::call::{Calls, MediaRooms, NoRooms};
use vibechat_core::chat::{ChatService, ChatServiceDeps};
use vibechat_core::clock::SystemClock;
use vibechat_core::contact::{ContactService, ContactServiceDeps};
use vibechat_core::file::{FileService, FileServiceDeps};
use vibechat_core::mail::Mailer;
use vibechat_infra::blob::ObjectBlobStore;
use vibechat_infra::crypto::Argon2Hasher;
use vibechat_infra::images::ImageCodec;
use vibechat_infra::mail::{FileMailer, SmtpMailer};

pub mod calling;
pub mod config;
pub mod error;
pub mod group_calling;
pub mod http;
pub mod media;
pub mod state;
pub mod ws;

use config::Config;
use state::AppState;

type BoxError = Box<dyn std::error::Error>;

/// 多久清理一次没有发出去的文件。
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// 多久清理一次超过保留期限的消息和文件。
const RETENTION_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// 连接数据库、启动服务，直到收到停止信号。
pub async fn run(config: Config) -> Result<(), BoxError> {
    let stores = vibechat_infra::db::open(&config.database_url).await?;
    let blobs = Arc::new(ObjectBlobStore::local(&config.files_dir)?);
    let hasher = Arc::new(Argon2Hasher::new());
    let accounts = AccountService::new(AccountServiceDeps {
        users: stores.users.clone(),
        sessions: stores.sessions.clone(),
        invite_codes: stores.invite_codes.clone(),
        files: stores.files.clone(),
        blobs: blobs.clone(),
        images: Arc::new(ImageCodec),
        hasher: hasher.clone(),
        clock: Arc::new(SystemClock),
        limits: config.limits,
    })
    .await;
    ensure_admin(&accounts, &config).await?;
    let accounts = Arc::new(accounts);
    let contacts = ContactService::new(ContactServiceDeps {
        users: stores.users.clone(),
        contacts: stores.contacts.clone(),
        clock: Arc::new(SystemClock),
    });

    let chat = Arc::new(ChatService::new(ChatServiceDeps {
        users: stores.users.clone(),
        contacts: stores.contacts.clone(),
        chat: stores.chat.clone(),
        files: stores.files.clone(),
        settings: stores.settings.clone(),
        clock: Arc::new(SystemClock),
    }));
    let files = Arc::new(FileService::new(FileServiceDeps {
        files: stores.files.clone(),
        blobs,
        images: Arc::new(ImageCodec),
        chat: stores.chat.clone(),
        settings: stores.settings.clone(),
        clock: Arc::new(SystemClock),
    }));
    tokio::spawn(sweep_files(files.clone()));

    let admin = Arc::new(AdminService::new(AdminServiceDeps {
        accounts: accounts.clone(),
        chat: chat.clone(),
        files: files.clone(),
        users: stores.users.clone(),
        sessions: stores.sessions.clone(),
        invite_codes: stores.invite_codes.clone(),
        chat_store: stores.chat.clone(),
        file_store: stores.files.clone(),
        settings: stores.settings.clone(),
        audit: stores.audit.clone(),
        tokens: stores.tokens.clone(),
        hasher,
        mailer: mailer(&config)?,
        clock: Arc::new(SystemClock),
        public_url: config.public_url.to_string(),
        reset_requests_per_minute: config.password_resets_per_minute,
    }));
    tokio::spawn(clean_expired(admin.clone()));

    let listen_addr = config.listen_addr;
    let calls = Arc::new(Calls::new(Arc::new(SystemClock), config.calls));
    // 群通话的媒体转发服务：没有配置时没有房间可管，也不能群通话
    let rooms: Arc<dyn MediaRooms> = match &config.livekit {
        Some(livekit) => Arc::new(media::LiveKitRooms::new(
            livekit.clone(),
            Arc::new(SystemClock),
        )),
        None => Arc::new(NoRooms),
    };
    let state = AppState {
        config: Arc::new(config),
        stores,
        accounts,
        contacts: Arc::new(contacts),
        chat,
        files,
        admin,
        hub: Arc::new(ws::Hub::new()),
        calls,
        rooms,
        ws: ws::WsSettings::default(),
    };
    tokio::spawn(calling::settle_forever(state.clone()));

    let listener = TcpListener::bind(listen_addr).await?;
    tracing::info!("listening on {listen_addr}");
    // 带上对方的地址，按来源地址限速时要用
    let service = http::router(state).into_make_service_with_connect_info::<SocketAddr>();
    axum::serve(listener, service)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// 每隔一段时间清理一次上传了却没有随消息发出去的文件。启动时先清一次。
async fn sweep_files(files: Arc<FileService>) {
    let mut tick = tokio::time::interval(SWEEP_INTERVAL);
    loop {
        tick.tick().await;
        match files.sweep().await {
            Ok(0) => {}
            Ok(removed) => tracing::info!("removed {removed} uploaded files that were never sent"),
            Err(err) => tracing::warn!("could not sweep unsent files: {err}"),
        }
    }
}

/// 配置了邮件服务就通过它发；没有配置时把邮件写成文件。
fn mailer(config: &Config) -> Result<Arc<dyn Mailer>, BoxError> {
    Ok(match &config.mail {
        Some(server) => Arc::new(SmtpMailer::new(&server.url, &server.from)?),
        None => {
            tracing::info!(
                "no mail server is configured: mail is written to {}",
                config.mail_dir.display()
            );
            Arc::new(FileMailer::new(&config.mail_dir))
        }
    })
}

/// 每天清理一次超过保留期限的消息和它们的文件。启动时先清一次。
async fn clean_expired(admin: Arc<AdminService>) {
    let mut tick = tokio::time::interval(RETENTION_INTERVAL);
    loop {
        tick.tick().await;
        match admin.clean_expired().await {
            Ok(cleaned) if cleaned.messages == 0 => {}
            Ok(cleaned) => tracing::info!(
                "removed {} messages and {} files past the retention period",
                cleaned.messages,
                cleaned.files
            ),
            Err(err) => tracing::warn!("could not clean expired messages: {err}"),
        }
    }
}

/// 系统里必须有一名管理员：没有人发邀请码，就没有人能注册。
async fn ensure_admin(accounts: &AccountService, config: &Config) -> Result<(), BoxError> {
    match &config.admin {
        Some(admin) => {
            if accounts
                .bootstrap_admin(&admin.email, &admin.initial_password)
                .await?
            {
                tracing::info!(
                    "created the first administrator: log in with id \"{ADMIN_HANDLE}\" and the \
                     initial password, then change the password"
                );
            }
        }
        None => {
            if !accounts.has_admin().await? {
                return Err(
                    "no administrator exists yet: set ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD"
                        .into(),
                );
            }
        }
    }
    Ok(())
}

/// Ctrl-C 或 SIGTERM（容器停止时发出）到来时结束服务。
async fn shutdown_signal() {
    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}
