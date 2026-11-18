//! 请求来自谁：来源地址和浏览器信息。用于限速和记录登录会话。

use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::header;
use axum::http::request::Parts;

use crate::error::AppError;
use crate::state::AppState;

pub struct ClientInfo {
    /// 发起请求的地址。经过受信任的反向代理时，是代理报告的用户真实地址。
    pub ip: String,
    pub user_agent: String,
}

impl FromRequestParts<AppState> for ClientInfo {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|info| info.0.ip());
        let forwarded = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok());
        let ip = client_ip(peer, forwarded, &state.config.trusted_proxies)
            .map_or_else(|| "unknown".to_owned(), |ip| ip.to_string());

        let user_agent = parts
            .headers
            .get(header::USER_AGENT)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_owned();
        Ok(Self { ip, user_agent })
    }
}

/// 确定请求的来源地址。
///
/// 请求头里的地址是可以随便伪造的，所以只有当请求确实来自受信任的反向代理时才看它；
/// 并且从右往左找第一个不是代理的地址，因为靠左的部分同样可能是用户自己填的。
fn client_ip(peer: Option<IpAddr>, forwarded: Option<&str>, trusted: &[IpAddr]) -> Option<IpAddr> {
    let peer = peer?;
    if !trusted.contains(&peer) {
        return Some(peer);
    }
    let reported = forwarded
        .into_iter()
        .flat_map(|value| value.split(','))
        .filter_map(|item| item.trim().parse::<IpAddr>().ok())
        .rev()
        .find(|ip| !trusted.contains(ip));
    Some(reported.unwrap_or(peer))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn a_direct_connection_uses_the_peer_address_and_ignores_the_header() {
        assert_eq!(
            client_ip(Some(ip("203.0.113.9")), Some("1.2.3.4"), &[]),
            Some(ip("203.0.113.9"))
        );
    }

    #[test]
    fn behind_a_trusted_proxy_the_reported_address_is_used() {
        let trusted = [ip("10.0.0.1")];
        assert_eq!(
            client_ip(Some(ip("10.0.0.1")), Some("203.0.113.9"), &trusted),
            Some(ip("203.0.113.9"))
        );
    }

    #[test]
    fn a_forged_entry_on_the_left_is_not_believed() {
        // 用户自己在请求头里填了 1.2.3.4，代理在后面追加了它看到的真实地址
        let trusted = [ip("10.0.0.1")];
        assert_eq!(
            client_ip(Some(ip("10.0.0.1")), Some("1.2.3.4, 203.0.113.9"), &trusted),
            Some(ip("203.0.113.9"))
        );
    }

    #[test]
    fn several_trusted_proxies_in_a_row_are_skipped() {
        let trusted = [ip("10.0.0.1"), ip("10.0.0.2")];
        assert_eq!(
            client_ip(
                Some(ip("10.0.0.1")),
                Some("203.0.113.9, 10.0.0.2"),
                &trusted
            ),
            Some(ip("203.0.113.9"))
        );
    }

    #[test]
    fn a_trusted_proxy_without_a_usable_header_falls_back_to_itself() {
        let trusted = [ip("10.0.0.1")];
        assert_eq!(
            client_ip(Some(ip("10.0.0.1")), None, &trusted),
            Some(ip("10.0.0.1"))
        );
        assert_eq!(
            client_ip(Some(ip("10.0.0.1")), Some("garbage"), &trusted),
            Some(ip("10.0.0.1"))
        );
    }

    #[test]
    fn without_a_peer_address_nothing_is_known() {
        assert_eq!(client_ip(None, Some("203.0.113.9"), &[]), None);
    }
}
