//! 登录状态的识别：从请求里取出会话令牌，确认是谁在发请求。

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, header};
use vibechat_core::account::AuthContext;
use vibechat_core::account::service::SESSION_TTL_MS;
use vibechat_protocol::ErrorCode;

use crate::error::AppError;
use crate::state::AppState;

const SESSION_COOKIE: &str = "vc_session";

/// 登录成功后交给浏览器的 Cookie：页面里的脚本读不到，只在访问本站时发送。
pub fn session_cookie(token: &str, secure: bool) -> HeaderValue {
    cookie(token, SESSION_TTL_MS / 1000, secure)
}

/// 让浏览器删掉登录的 Cookie。
pub fn clear_session_cookie(secure: bool) -> HeaderValue {
    cookie("", 0, secure)
}

fn cookie(value: &str, max_age_secs: i64, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    let text = format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{secure}"
    );
    HeaderValue::from_str(&text).expect("cookie built from a hex token is a valid header")
}

/// 请求带来的会话令牌，以及它是从哪里来的。
struct Token {
    value: String,
    from_cookie: bool,
}

fn token_from(headers: &HeaderMap) -> Option<Token> {
    // 请求头方式留给以后的桌面客户端；浏览器用 Cookie
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if let Some(value) = bearer {
        return Some(Token {
            value: value.trim().to_owned(),
            from_cookie: false,
        });
    }

    let prefix = format!("{SESSION_COOKIE}=");
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(prefix.as_str()))
        .filter(|value| !value.is_empty())
        .map(|value| Token {
            value: value.to_owned(),
            from_cookie: true,
        })
}

/// 请求是否用请求头里的令牌来表明身份（而不是 Cookie）。
pub fn uses_bearer_token(headers: &HeaderMap) -> bool {
    token_from(headers).is_some_and(|token| !token.from_cookie)
}

/// 已登录。处于"必须修改密码"状态的用户也算，所以只用在修改密码、退出等少数接口上。
pub struct Auth {
    pub context: AuthContext,
    /// 请求带来的令牌，续期 Cookie 时要用。
    pub token: String,
    pub from_cookie: bool,
}

impl FromRequestParts<AppState> for Auth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let unauthorized = || AppError::new(ErrorCode::Unauthorized, "not logged in");
        let token = token_from(&parts.headers).ok_or_else(unauthorized)?;
        let context = state
            .accounts
            .authenticate(&token.value)
            .await?
            .ok_or_else(unauthorized)?;
        Ok(Self {
            context,
            token: token.value,
            from_cookie: token.from_cookie,
        })
    }
}

/// 已登录，并且不需要先修改密码。绝大多数接口用这个。
pub struct ActiveUser(pub AuthContext);

impl FromRequestParts<AppState> for ActiveUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let auth = Auth::from_request_parts(parts, state).await?;
        if auth.context.user.must_change_password {
            return Err(AppError::new(
                ErrorCode::MustChangePassword,
                "the password must be changed first",
            ));
        }
        Ok(Self(auth.context))
    }
}

/// 已登录的管理员。管理接口用这个。
pub struct Admin(pub AuthContext);

impl FromRequestParts<AppState> for Admin {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let ActiveUser(context) = ActiveUser::from_request_parts(parts, state).await?;
        if !context.user.is_admin() {
            return Err(AppError::new(ErrorCode::Forbidden, "administrators only"));
        }
        Ok(Self(context))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn the_token_is_read_from_the_session_cookie_among_others() {
        let token = token_from(&headers(&[(
            "cookie",
            "theme=dark; vc_session=abc123; other=1",
        )]))
        .unwrap();
        assert_eq!(token.value, "abc123");
        assert!(token.from_cookie);
    }

    #[test]
    fn a_cookie_with_a_similar_name_is_not_mistaken_for_it() {
        assert!(
            token_from(&headers(&[(
                "cookie",
                "not_vc_session=abc; vc_session_old=def"
            )]))
            .is_none()
        );
        assert!(token_from(&headers(&[("cookie", "vc_session=")])).is_none());
        assert!(token_from(&headers(&[])).is_none());
    }

    #[test]
    fn a_bearer_token_takes_precedence_and_is_not_a_cookie() {
        let map = headers(&[
            ("authorization", "Bearer from-header"),
            ("cookie", "vc_session=from-cookie"),
        ]);
        let token = token_from(&map).unwrap();
        assert_eq!(token.value, "from-header");
        assert!(!token.from_cookie);
        assert!(uses_bearer_token(&map));
        assert!(!uses_bearer_token(&headers(&[("cookie", "vc_session=x")])));
    }

    #[test]
    fn the_cookie_is_http_only_same_site_and_lasts_thirty_days() {
        let value = session_cookie("abc123", false);
        assert_eq!(
            value.to_str().unwrap(),
            "vc_session=abc123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000"
        );
        assert!(
            session_cookie("abc123", true)
                .to_str()
                .unwrap()
                .ends_with("; Secure")
        );
        assert!(
            clear_session_cookie(false)
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
    }
}
