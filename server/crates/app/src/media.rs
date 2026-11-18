//! 调媒体转发服务 LiveKit 的接口（F10）：把一个人请出房间、关闭房间。
//!
//! LiveKit 控制用的端口上有一组管理接口，凭服务端现签的短时凭证调用。
//! 服务端只在本机或内网里连它，走普通的 HTTP。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use vibechat_core::call::{LiveKitConfig, MediaError, MediaRooms, admin_token};
use vibechat_core::clock::Clock;

/// 等 LiveKit 回答最多多久。它就在本机，正常是几毫秒。
const TIMEOUT: Duration = Duration::from_secs(5);

pub struct LiveKitRooms {
    http: reqwest::Client,
    config: LiveKitConfig,
    clock: Arc<dyn Clock>,
}

impl LiveKitRooms {
    pub fn new(config: LiveKitConfig, clock: Arc<dyn Clock>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("a plain HTTP client can always be built");
        Self {
            http,
            config,
            clock,
        }
    }

    /// 调房间管理的一个接口。要管的人或房间已经不在了（404）也算成功。
    async fn call(
        &self,
        method: &str,
        room: &str,
        body: serde_json::Value,
    ) -> Result<(), MediaError> {
        let url = format!("{}/twirp/livekit.RoomService/{method}", self.config.url);
        let token = admin_token(&self.config, room, self.clock.now_ms());
        let reply = self
            .http
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            // 错误的说明里可能带着地址，不带凭证
            .map_err(|err| MediaError(format!("{method}: {}", err.without_url())))?;
        let status = reply.status();
        if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
            Ok(())
        } else {
            Err(MediaError(format!("{method} answered {status}")))
        }
    }
}

#[async_trait]
impl MediaRooms for LiveKitRooms {
    async fn remove(&self, room: &str, identity: &str) -> Result<(), MediaError> {
        self.call(
            "RemoveParticipant",
            room,
            json!({ "room": room, "identity": identity }),
        )
        .await
    }

    async fn close(&self, room: &str) -> Result<(), MediaError> {
        self.call("DeleteRoom", room, json!({ "room": room })).await
    }
}
