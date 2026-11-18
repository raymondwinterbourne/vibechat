//! 通话（F3，设计文档 3.7、4.6 节）。
//!
//! - 进行中的通话：只在内存里，一对一的见 [`calls`]，群里的见 [`group`]（F10）。
//! - 中转服务的临时账号：浏览器要经过我们自己的中转服务（coturn）通话时，先向服务端要一个账号。
//!   账号由服务端用和 coturn 共享的密钥现签，几个小时后失效，不存库。
//! - 群通话的媒体转发服务（LiveKit）的入场凭证：见 [`livekit`]。

pub mod calls;
#[cfg(test)]
mod calls_tests;
pub mod group;
#[cfg(test)]
mod group_tests;
pub mod livekit;

pub use calls::{
    Call, CallError, CallOutcome, CallSettings, CallState, Calls, DeviceId, Endpoint, Hangup,
    Rejection,
};
pub use group::{GroupCall, GroupCallError, GroupInvite, GroupParticipant, GroupSwept};
#[cfg(any(test, feature = "testing"))]
pub use livekit::RecordingRooms;
pub use livekit::{
    LiveKitConfig, MediaError, MediaRooms, NoRooms, RoomTicket, TicketSources, admin_token,
    call_room, room_ticket,
};

use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;

use crate::ids::UserId;

/// 中转服务的配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnConfig {
    /// 中转服务的地址，例如 `turn:turn.example.com:3478?transport=udp`。
    pub urls: Vec<String>,
    /// 和 coturn 共享的密钥（coturn 的 `static-auth-secret`）。
    pub secret: String,
    /// 签发的账号多久失效，秒。
    pub ttl_secs: u64,
}

/// 交给浏览器的中转服务：地址和临时账号。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
    /// 账号什么时候失效，UTC 毫秒。
    pub expires_at: i64,
}

/// 给这个用户签一个中转账号（coturn 的 `use-auth-secret` 约定）：
/// 用户名是"失效时间（Unix 秒）:用户编号"，密码是用密钥对用户名做 HMAC-SHA1 再转 Base64。
/// coturn 用同一个密钥重算一遍，对得上并且没过期才给中转。
pub fn turn_credential(config: &TurnConfig, user: UserId, now_ms: i64) -> IceServer {
    let expires = now_ms / 1000 + config.ttl_secs as i64;
    let username = format!("{expires}:{user}");
    let credential = sign(&config.secret, &username);
    IceServer {
        urls: config.urls.clone(),
        username,
        credential,
        expires_at: expires * 1000,
    }
}

/// 用密钥对一段文字做 HMAC-SHA1，结果转 Base64。
fn sign(secret: &str, text: &str) -> String {
    let mut mac =
        Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(text.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TurnConfig {
        TurnConfig {
            urls: vec!["turn:turn.example.com:3478?transport=udp".to_owned()],
            secret: "north".to_owned(),
            ttl_secs: 6 * 3600,
        }
    }

    #[test]
    fn the_username_carries_the_expiry_and_the_user() {
        let user: UserId = "0190a5c2-0000-7000-8000-000000000001".parse().unwrap();
        let server = turn_credential(&config(), user, 1_700_000_000_123);
        assert_eq!(server.username, format!("1700021600:{user}"));
        assert_eq!(server.expires_at, 1_700_021_600_000);
        assert_eq!(server.urls, config().urls);
    }

    #[test]
    fn the_password_is_the_base64_hmac_sha1_of_the_username() {
        // 对照值用 openssl 算的：
        // printf '1700021600:alice' | openssl dgst -sha1 -hmac north -binary | base64
        assert_eq!(
            sign("north", "1700021600:alice"),
            "aonDLPDw0TXo+i6Ds/clXYd7Cs8="
        );
    }

    #[test]
    fn different_users_and_times_get_different_passwords() {
        let a: UserId = "0190a5c2-0000-7000-8000-000000000001".parse().unwrap();
        let b: UserId = "0190a5c2-0000-7000-8000-000000000002".parse().unwrap();
        let first = turn_credential(&config(), a, 1_700_000_000_000);
        assert_ne!(
            first.credential,
            turn_credential(&config(), b, 1_700_000_000_000).credential
        );
        assert_ne!(
            first.credential,
            turn_credential(&config(), a, 1_700_000_100_000).credential
        );
    }
}
