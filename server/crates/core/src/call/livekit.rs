//! 群通话的媒体转发服务 LiveKit（F10，设计文档 4.6 节）：入场凭证。
//!
//! 群通话里每个人只和 LiveKit 连一条线，由它把声音转给其他人。一个群通话在它那里是一个"房间"。
//! 要进房间，先向服务端要一张入场凭证：服务端用和 LiveKit 共享的密钥现签，只能进指定的那一个房间、
//! 只能发麦克风的声音（视频通话再加上摄像头的画面，F11）、几分钟后失效，不存库。
//! LiveKit 用同一个密钥验，对得上并且没过期才让进。

use async_trait::async_trait;
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

use crate::ids::CallId;

/// 入场凭证签出来之后多久失效，秒。只在进门时检查：进去之后凭证过期不影响通话。
pub const TICKET_TTL_SECS: i64 = 10 * 60;
/// 服务端自己调 LiveKit 的接口用的凭证多久失效，秒。现签现用。
const ADMIN_TOKEN_TTL_SECS: i64 = 60;

/// LiveKit 的配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveKitConfig {
    /// 服务端调 LiveKit 的接口用的地址，例如 `http://127.0.0.1:7880`。浏览器不用它。
    pub url: String,
    /// 密钥的名字（LiveKit 配置文件 `keys` 里的那一项）。
    pub api_key: String,
    /// 和 LiveKit 共享的密钥。
    pub api_secret: String,
}

/// 一张入场凭证。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomTicket {
    pub token: String,
    /// 什么时候失效，UTC 毫秒。
    pub expires_at: i64,
}

/// 凭一张入场凭证可以往房间里发什么。麦克风的声音总是可以的。
///
/// 语音通话的凭证不放行摄像头：拿它发摄像头的画面，LiveKit 不接受。所以"语音通话里不能开摄像头"
/// 由媒体转发服务把关，不只靠界面上没有按钮（F11 的 Q2）。共享的屏幕是另一回事：
/// 语音通话里也可以共享（F12 的 Q1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TicketSources {
    /// 摄像头的画面：视频通话。
    pub camera: bool,
    /// 共享的屏幕（F12）。
    pub screen: bool,
}

impl TicketSources {
    /// 只有麦克风的声音。
    pub const VOICE: TicketSources = TicketSources {
        camera: false,
        screen: false,
    };

    /// 写在凭证里的样子：LiveKit 认的来源的名字。
    fn claim(self) -> String {
        let mut sources = vec![r#""microphone""#];
        if self.camera {
            sources.push(r#""camera""#);
        }
        if self.screen {
            sources.push(r#""screen_share""#);
        }
        format!("[{}]", sources.join(","))
    }
}

/// 签一张入场凭证：`identity` 这个人可以进 `room` 这个房间，发 `sources` 写明的那几样、
/// 听（看）别人的。
///
/// 凭证是一个 JWT（HS256）：签发人是密钥的名字，主体是这个人在房间里的身份，
/// `video` 一项写明他能做什么。同一个身份再进一次，LiveKit 会把前一个请出去。
pub fn room_ticket(
    config: &LiveKitConfig,
    room: &str,
    identity: &str,
    sources: TicketSources,
    now_ms: i64,
) -> RoomTicket {
    let now = now_ms / 1000;
    let expires = now + TICKET_TTL_SECS;
    let claims = format!(
        concat!(
            r#"{{"iss":{iss},"sub":{sub},"nbf":{nbf},"exp":{exp},"#,
            r#""video":{{"room":{room},"roomJoin":true,"canPublish":true,"canSubscribe":true,"#,
            r#""canPublishData":false,"canPublishSources":{sources}}}}}"#,
        ),
        iss = quote(&config.api_key),
        sub = quote(identity),
        nbf = now,
        exp = expires,
        room = quote(room),
        sources = sources.claim(),
    );
    RoomTicket {
        token: sign(config, &claims),
        expires_at: expires * 1000,
    }
}

/// 服务端自己调 LiveKit 的接口（把人请出房间、关闭房间）时用的凭证：只管这一个房间，一分钟后失效。
pub fn admin_token(config: &LiveKitConfig, room: &str, now_ms: i64) -> String {
    let now = now_ms / 1000;
    let claims = format!(
        concat!(
            r#"{{"iss":{iss},"sub":"server","nbf":{nbf},"exp":{exp},"#,
            r#""video":{{"room":{room},"roomAdmin":true,"roomCreate":true}}}}"#,
        ),
        iss = quote(&config.api_key),
        nbf = now,
        exp = now + ADMIN_TOKEN_TTL_SECS,
        room = quote(room),
    );
    sign(config, &claims)
}

/// 一个群通话在 LiveKit 里的房间叫什么。
pub fn call_room(call: CallId) -> String {
    format!("call-{call}")
}

/// 把一份声明签成 JWT（HS256）。
fn sign(config: &LiveKitConfig, claims: &str) -> String {
    let header = r#"{"alg":"HS256","typ":"JWT"}"#;
    let body = format!(
        "{}.{}",
        encode(header.as_bytes()),
        encode(claims.as_bytes())
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(config.api_secret.as_bytes())
        .expect("HMAC accepts a key of any length");
    mac.update(body.as_bytes());
    let signature = encode(&mac.finalize().into_bytes());
    format!("{body}.{signature}")
}

/// 调媒体转发服务的接口没有成功。
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("the media server could not be reached: {0}")]
pub struct MediaError(pub String);

/// 媒体转发服务上的房间：服务端只做两件事，把一个人请出去、把房间关掉。
///
/// 入场凭证只在进门时检查，所以该离开的人（离开了通话、被移出了群）要由服务端请出去，
/// 不能只靠页面自觉断开。真的实现去调 LiveKit 的接口；测试里用假的。
#[async_trait]
pub trait MediaRooms: Send + Sync {
    /// 把这个人从房间里请出去。他不在里面、房间不在，都算成功。
    async fn remove(&self, room: &str, identity: &str) -> Result<(), MediaError>;
    /// 关闭房间，里面的人都断开。房间不在算成功。
    async fn close(&self, room: &str) -> Result<(), MediaError>;
}

/// 没有配置媒体转发服务：没有房间可管。
pub struct NoRooms;

#[async_trait]
impl MediaRooms for NoRooms {
    async fn remove(&self, _room: &str, _identity: &str) -> Result<(), MediaError> {
        Ok(())
    }

    async fn close(&self, _room: &str) -> Result<(), MediaError> {
        Ok(())
    }
}

/// JWT 用的 Base64：网址里能用的字符，不补等号。
fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// 把一段文字写成 JSON 的字符串。
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ch if u32::from(ch) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(ch))),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// 测试用的假房间：只记下被要求做了什么，例如 `remove call-… 用户编号`、`close call-…`。
#[cfg(any(test, feature = "testing"))]
#[derive(Default)]
pub struct RecordingRooms {
    asked: std::sync::Mutex<Vec<String>>,
}

#[cfg(any(test, feature = "testing"))]
impl RecordingRooms {
    /// 到现在为止被要求做的事，按先后；取走之后清空。
    pub fn take(&self) -> Vec<String> {
        std::mem::take(&mut self.asked.lock().unwrap())
    }
}

#[cfg(any(test, feature = "testing"))]
#[async_trait]
impl MediaRooms for RecordingRooms {
    async fn remove(&self, room: &str, identity: &str) -> Result<(), MediaError> {
        self.asked
            .lock()
            .unwrap()
            .push(format!("remove {room} {identity}"));
        Ok(())
    }

    async fn close(&self, room: &str) -> Result<(), MediaError> {
        self.asked.lock().unwrap().push(format!("close {room}"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOICE: TicketSources = TicketSources::VOICE;

    fn config() -> LiveKitConfig {
        LiveKitConfig {
            url: "http://127.0.0.1:7880".to_owned(),
            api_key: "devkey".to_owned(),
            api_secret: "north-secret".to_owned(),
        }
    }

    fn part(token: &str, index: usize) -> String {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token.split('.').nth(index).unwrap())
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn the_ticket_matches_one_signed_with_openssl() {
        // 对照值是用 openssl 对同样的内容签出来的：
        // printf '%s' "$头.$内容" | openssl dgst -sha256 -hmac north-secret -binary | base64
        // （再把 + / 换成 - _，去掉等号）
        let ticket = room_ticket(
            &config(),
            "check",
            "alice:device-01",
            VOICE,
            1_700_000_000_123,
        );
        assert_eq!(
            ticket.token,
            concat!(
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.",
                "eyJpc3MiOiJkZXZrZXkiLCJzdWIiOiJhbGljZTpkZXZpY2UtMDEiLCJuYmYiOjE3MDAwMDAwMDAsImV4cCI6",
                "MTcwMDAwMDYwMCwidmlkZW8iOnsicm9vbSI6ImNoZWNrIiwicm9vbUpvaW4iOnRydWUsImNhblB1Ymxpc2gi",
                "OnRydWUsImNhblN1YnNjcmliZSI6dHJ1ZSwiY2FuUHVibGlzaERhdGEiOmZhbHNlLCJjYW5QdWJsaXNoU291",
                "cmNlcyI6WyJtaWNyb3Bob25lIl19fQ.",
                "MHVDSf6hiNvuDJcaBmb2_3IbO6crkZYD5COEJRFzNTc",
            )
        );
        assert_eq!(ticket.expires_at, 1_700_000_600_000);
    }

    #[test]
    fn it_only_opens_the_one_room_for_the_microphone() {
        let ticket = room_ticket(&config(), "call-7", "bob", VOICE, 1_700_000_000_000);
        assert_eq!(part(&ticket.token, 0), r#"{"alg":"HS256","typ":"JWT"}"#);
        assert_eq!(
            part(&ticket.token, 1),
            concat!(
                r#"{"iss":"devkey","sub":"bob","nbf":1700000000,"exp":1700000600,"#,
                r#""video":{"room":"call-7","roomJoin":true,"canPublish":true,"canSubscribe":true,"#,
                r#""canPublishData":false,"canPublishSources":["microphone"]}}"#,
            )
        );
    }

    #[test]
    fn a_video_call_ticket_also_lets_the_camera_in() {
        let video = TicketSources {
            camera: true,
            screen: false,
        };
        let ticket = room_ticket(&config(), "call-7", "bob", video, 1_700_000_000_000);
        assert_eq!(
            part(&ticket.token, 1),
            concat!(
                r#"{"iss":"devkey","sub":"bob","nbf":1700000000,"exp":1700000600,"#,
                r#""video":{"room":"call-7","roomJoin":true,"canPublish":true,"canSubscribe":true,"#,
                r#""canPublishData":false,"canPublishSources":["microphone","camera"]}}"#,
            )
        );
        // 和语音通话的那一张不是同一张
        let voice = room_ticket(&config(), "call-7", "bob", VOICE, 1_700_000_000_000);
        assert_ne!(ticket.token, voice.token);
    }

    #[test]
    fn sharing_the_screen_is_let_in_on_its_own() {
        let sources = |ticket: RoomTicket| {
            let claims = part(&ticket.token, 1);
            let start = claims.find(r#""canPublishSources":"#).unwrap();
            claims[start..].trim_end_matches("}}").to_owned()
        };
        let ticket = |camera, screen| {
            let allowed = TicketSources { camera, screen };
            sources(room_ticket(&config(), "call-7", "bob", allowed, 0))
        };
        // 语音通话里也可以共享屏幕，但还是不能开摄像头
        assert_eq!(
            ticket(false, true),
            r#""canPublishSources":["microphone","screen_share"]"#
        );
        assert_eq!(
            ticket(true, true),
            r#""canPublishSources":["microphone","camera","screen_share"]"#
        );
        assert_eq!(
            ticket(false, false),
            r#""canPublishSources":["microphone"]"#
        );
    }

    #[test]
    fn a_different_secret_person_or_room_gives_a_different_signature() {
        let signature = |config: &LiveKitConfig, room: &str, identity: &str| {
            let token = room_ticket(config, room, identity, VOICE, 1_700_000_000_000).token;
            token.rsplit('.').next().unwrap().to_owned()
        };
        let first = signature(&config(), "check", "alice");
        let mut other = config();
        other.api_secret = "south-secret".to_owned();
        assert_ne!(first, signature(&other, "check", "alice"));
        assert_ne!(first, signature(&config(), "check", "bob"));
        assert_ne!(first, signature(&config(), "other", "alice"));
    }

    #[test]
    fn the_server_gets_a_short_lived_token_to_manage_one_room() {
        let token = admin_token(&config(), "call-7", 1_700_000_000_999);
        assert_eq!(
            part(&token, 1),
            concat!(
                r#"{"iss":"devkey","sub":"server","nbf":1700000000,"exp":1700000060,"#,
                r#""video":{"room":"call-7","roomAdmin":true,"roomCreate":true}}"#,
            )
        );
        assert_ne!(token, admin_token(&config(), "call-8", 1_700_000_000_999));
    }

    #[test]
    fn each_group_call_has_its_own_room() {
        let (first, second) = (CallId::new(), CallId::new());
        assert_eq!(call_room(first), format!("call-{first}"));
        assert_ne!(call_room(first), call_room(second));
    }

    #[test]
    fn odd_characters_cannot_break_out_of_the_text() {
        let ticket = room_ticket(&config(), "a\"b\\c\n", "x", VOICE, 0);
        assert!(part(&ticket.token, 1).contains(r#""room":"a\"b\\c\u000a""#));
    }
}
