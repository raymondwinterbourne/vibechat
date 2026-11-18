//! 启动配置，全部来自环境变量。启动时一次读完并校验，有问题就明确指出是哪一项。

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use tracing::Level;
use url::Url;
use vibechat_core::account::{Limits, password};
use vibechat_core::admin::service::RESET_REQUESTS_PER_MINUTE;
use vibechat_core::call::{CallSettings, LiveKitConfig, TurnConfig};

#[derive(Debug, Clone)]
pub struct Config {
    /// 监听地址和端口。
    pub listen_addr: SocketAddr,
    /// 用户在浏览器里访问系统的地址。用于校验请求的来源。
    pub public_url: Url,
    /// 数据库连接串，前缀决定使用 SQLite 还是 Postgres。
    pub database_url: String,
    /// 上传的文件存放的本地目录。
    pub files_dir: PathBuf,
    /// 数据库里还没有管理员时，用它创建第一名管理员。
    pub admin: Option<AdminBootstrap>,
    /// 反向代理的地址。只有来自这些地址的请求，才采信其中关于用户真实地址的请求头。
    pub trusted_proxies: Vec<IpAddr>,
    /// 同一来源地址每分钟允许的登录和注册次数。
    pub limits: Limits,
    /// 同一来源地址每分钟可以请求几次找回密码。
    pub password_resets_per_minute: u32,
    /// 发邮件用的邮件服务。没有配置时邮件不发出去，写进 `mail_dir`。
    pub mail: Option<MailServer>,
    /// 没有配置邮件服务时，邮件写成文件放在这个目录里。
    pub mail_dir: PathBuf,
    /// 桌面客户端的安装包放在这个目录里，登录的用户可以下载其中版本最高的那个。
    pub desktop_dir: PathBuf,
    /// 通话的中转服务。没有配置时不能通话。
    pub turn: Option<TurnConfig>,
    /// 群通话的媒体转发服务（LiveKit）。没有配置时不能群通话。
    pub livekit: Option<LiveKitConfig>,
    /// 通话的时限：响铃多久没人接算未接，通话里的设备断开多久算网络中断。
    pub calls: CallSettings,
    /// 桌面客户端的最低版本，形如 `0.2.0`。低于它的桌面客户端整个页面是"请更新"。没有要求时为空。
    pub desktop_min_version: Option<String>,
    pub log_level: Level,
}

#[derive(Clone)]
pub struct MailServer {
    /// 形如 `smtps://用户:密码@主机:465`。
    pub url: String,
    /// 发件人，形如 `VibeChat <no-reply@example.com>`。
    pub from: String,
}

impl std::fmt::Debug for MailServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 地址里可能带着密码，不让它出现在日志里
        f.debug_struct("MailServer")
            .field("url", &"(hidden)")
            .field("from", &self.from)
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct AdminBootstrap {
    pub email: String,
    pub initial_password: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required but not set")]
    Missing(&'static str),
    #[error("{name} has an invalid value {value:?}: {reason}")]
    Invalid {
        name: &'static str,
        value: String,
        reason: String,
    },
}

/// 三个不带前导零的数字，用点隔开，例如 `0.10.2`。和安装包文件名里的版本号是同一个规则。
fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
                && (*part == "0" || !part.starts_with('0'))
        })
}

fn invalid(name: &'static str, value: impl Into<String>, reason: impl Into<String>) -> ConfigError {
    ConfigError::Invalid {
        name,
        value: value.into(),
        reason: reason.into(),
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// 从任意来源读取配置。测试用它来避免改动进程的环境变量。
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // 空字符串当作没有设置
        let get = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        let required = |name: &'static str| get(name).ok_or(ConfigError::Missing(name));

        let listen_addr = parse(
            "LISTEN_ADDR",
            get("LISTEN_ADDR").unwrap_or_else(|| "0.0.0.0:3488".to_owned()),
        )?;

        let public_url: Url = parse("PUBLIC_URL", required("PUBLIC_URL")?)?;
        if !matches!(public_url.scheme(), "http" | "https") || public_url.host_str().is_none() {
            return Err(invalid(
                "PUBLIC_URL",
                public_url,
                "must be an http or https address",
            ));
        }

        let database_url = required("DATABASE_URL")?;
        if !database_url.starts_with("sqlite:") && !database_url.starts_with("postgres:") {
            return Err(invalid(
                "DATABASE_URL",
                database_url,
                "must start with sqlite: or postgres:",
            ));
        }

        let files_dir = PathBuf::from(required("FILES_DIR")?);

        let admin = match (get("ADMIN_EMAIL"), get("ADMIN_INITIAL_PASSWORD")) {
            (None, None) => None,
            (Some(_), None) => return Err(ConfigError::Missing("ADMIN_INITIAL_PASSWORD")),
            (None, Some(_)) => return Err(ConfigError::Missing("ADMIN_EMAIL")),
            (Some(email), Some(initial_password)) => {
                if !email.contains('@') {
                    return Err(invalid("ADMIN_EMAIL", email, "must be an email address"));
                }
                if password::check_strength(&initial_password, None).is_err() {
                    // 不把密码本身写进错误信息
                    return Err(invalid(
                        "ADMIN_INITIAL_PASSWORD",
                        "(hidden)",
                        "must be at least 8 characters with both letters and digits",
                    ));
                }
                Some(AdminBootstrap {
                    email,
                    initial_password,
                })
            }
        };

        let trusted_proxies = get("TRUSTED_PROXIES")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(|item| {
                item.parse::<IpAddr>()
                    .map_err(|err| invalid("TRUSTED_PROXIES", item, err.to_string()))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let defaults = Limits::default();
        let per_minute = |name: &'static str, default: u32| match get(name) {
            None => Ok(default),
            Some(value) => match value.parse::<u32>() {
                Ok(limit) if limit > 0 => Ok(limit),
                _ => Err(invalid(name, value, "must be a positive integer")),
            },
        };
        let limits = Limits {
            logins_per_minute: per_minute("LOGINS_PER_MINUTE", defaults.logins_per_minute)?,
            registrations_per_minute: per_minute(
                "REGISTRATIONS_PER_MINUTE",
                defaults.registrations_per_minute,
            )?,
        };

        let password_resets_per_minute =
            per_minute("PASSWORD_RESETS_PER_MINUTE", RESET_REQUESTS_PER_MINUTE)?;

        let mail = match get("SMTP_URL") {
            None => None,
            Some(url) => {
                if !url.starts_with("smtp://") && !url.starts_with("smtps://") {
                    // 地址里可能带着密码，不把它写进错误信息
                    return Err(invalid(
                        "SMTP_URL",
                        "(hidden)",
                        "must start with smtp:// or smtps://",
                    ));
                }
                let from = required("MAIL_FROM")?;
                if !from.contains('@') {
                    return Err(invalid("MAIL_FROM", from, "must be an email address"));
                }
                Some(MailServer { url, from })
            }
        };
        // 默认放在文件目录的旁边，不和上传的文件混在一起
        let mail_dir = get("MAIL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| files_dir.with_file_name("mail"));
        let desktop_dir = get("DESKTOP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| files_dir.with_file_name("desktop"));

        // 中转服务：地址和密钥要一起给
        let turn = match (get("TURN_URLS"), get("TURN_SECRET")) {
            (None, None) => None,
            (Some(urls), Some(secret)) => {
                let urls: Vec<String> = urls
                    .split(',')
                    .map(|url| url.trim().to_owned())
                    .filter(|url| !url.is_empty())
                    .collect();
                if urls
                    .iter()
                    .any(|url| !url.starts_with("turn:") && !url.starts_with("turns:"))
                {
                    return Err(invalid(
                        "TURN_URLS",
                        urls.join(","),
                        "every address must start with turn: or turns:",
                    ));
                }
                // 正整数，和上面的次数限制同一个规则
                let hours = per_minute("TURN_CREDENTIAL_HOURS", 6)?;
                if urls.is_empty() || secret.is_empty() || hours == 0 {
                    return Err(invalid(
                        "TURN_URLS",
                        urls.join(","),
                        "needs addresses, a secret and a lifetime",
                    ));
                }
                Some(TurnConfig {
                    urls,
                    secret,
                    ttl_secs: u64::from(hours) * 3600,
                })
            }
            (Some(_), None) => return Err(ConfigError::Missing("TURN_SECRET")),
            (None, Some(_)) => return Err(ConfigError::Missing("TURN_URLS")),
        };

        // 群通话的媒体转发服务：地址、密钥的名字、密钥要一起给
        let livekit = match (
            get("LIVEKIT_URL"),
            get("LIVEKIT_API_KEY"),
            get("LIVEKIT_API_SECRET"),
        ) {
            (None, None, None) => None,
            (Some(url), Some(api_key), Some(api_secret)) => {
                let url = url.trim().trim_end_matches('/').to_owned();
                // 服务端只在本机或内网里连它，不带 TLS
                if !url.starts_with("http://") {
                    return Err(invalid("LIVEKIT_URL", url, "must start with http://"));
                }
                if api_key.is_empty() {
                    return Err(invalid("LIVEKIT_API_KEY", api_key, "must not be empty"));
                }
                // LiveKit 自己也不接受太短的密钥
                if api_secret.len() < 32 {
                    return Err(invalid(
                        "LIVEKIT_API_SECRET",
                        "(hidden)",
                        "must be at least 32 characters",
                    ));
                }
                Some(LiveKitConfig {
                    url,
                    api_key,
                    api_secret,
                })
            }
            (None, _, _) => return Err(ConfigError::Missing("LIVEKIT_URL")),
            (_, None, _) => return Err(ConfigError::Missing("LIVEKIT_API_KEY")),
            (_, _, None) => return Err(ConfigError::Missing("LIVEKIT_API_SECRET")),
        };

        // 通话的时限，秒。只有测试需要改：端到端测试里把响铃时间调短
        let call_defaults = CallSettings::default();
        let seconds = |name: &'static str, default_ms: i64| {
            per_minute(name, (default_ms / 1000) as u32).map(|secs| i64::from(secs) * 1000)
        };
        let calls = CallSettings {
            ring_timeout_ms: seconds("CALL_RING_SECONDS", call_defaults.ring_timeout_ms)?,
            gone_grace_ms: seconds("CALL_GONE_SECONDS", call_defaults.gone_grace_ms)?,
            group_ring_timeout_ms: seconds(
                "GROUP_CALL_RING_SECONDS",
                call_defaults.group_ring_timeout_ms,
            )?,
        };

        let desktop_min_version = match get("DESKTOP_MIN_VERSION") {
            None => None,
            Some(version) if is_version(&version) => Some(version),
            Some(version) => {
                return Err(invalid(
                    "DESKTOP_MIN_VERSION",
                    version,
                    "expected three numbers such as 0.2.0",
                ));
            }
        };

        let log_level = parse(
            "LOG_LEVEL",
            get("LOG_LEVEL").unwrap_or_else(|| "info".to_owned()),
        )?;

        Ok(Self {
            listen_addr,
            public_url,
            database_url,
            files_dir,
            admin,
            trusted_proxies,
            limits,
            password_resets_per_minute,
            mail,
            mail_dir,
            desktop_dir,
            turn,
            livekit,
            calls,
            desktop_min_version,
            log_level,
        })
    }

    /// 浏览器从 `public_url` 打开页面时，请求里携带的来源，形如 `https://example.com`。
    pub fn public_origin(&self) -> String {
        self.public_url.origin().ascii_serialization()
    }

    /// 浏览器连群通话的媒体转发服务用的地址：网页的地址下的 `/livekit`，
    /// 由反向代理（开发时是前端的开发服务器）转到 LiveKit 控制用的端口上。
    pub fn livekit_public_url(&self) -> String {
        let scheme = if self.secure_cookies() { "wss" } else { "ws" };
        let origin = self.public_origin();
        let host = origin
            .split_once("://")
            .map_or(origin.as_str(), |(_, host)| host);
        format!("{scheme}://{host}/livekit")
    }

    /// 系统通过 HTTPS 提供访问时，登录的 Cookie 只允许在加密连接上发送。
    pub fn secure_cookies(&self) -> bool {
        self.public_url.scheme() == "https"
    }
}

fn parse<T>(name: &'static str, value: String) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    value
        .parse()
        .map_err(|err: T::Err| invalid(name, value, err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(vars: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let vars: Vec<(String, String)> = vars
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        Config::from_lookup(move |name| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        })
    }

    const MINIMAL: [(&str, &str); 3] = [
        ("PUBLIC_URL", "http://127.0.0.1:8780"),
        ("DATABASE_URL", "sqlite:///tmp/test.db?mode=rwc"),
        ("FILES_DIR", "/tmp/files"),
    ];

    fn with(extra: &[(&'static str, &'static str)]) -> Result<Config, ConfigError> {
        let mut vars = MINIMAL.to_vec();
        for (key, value) in extra {
            vars.retain(|(existing, _)| existing != key);
            vars.push((key, value));
        }
        config(&vars)
    }

    fn invalid_name(result: Result<Config, ConfigError>) -> &'static str {
        match result.unwrap_err() {
            ConfigError::Invalid { name, .. } => name,
            other => panic!("expected an invalid value, got {other:?}"),
        }
    }

    #[test]
    fn minimal_config_uses_defaults() {
        let config = config(&MINIMAL).unwrap();
        assert_eq!(config.listen_addr.to_string(), "0.0.0.0:3488");
        assert_eq!(config.log_level, Level::INFO);
        assert_eq!(config.public_origin(), "http://127.0.0.1:8780");
        assert!(!config.secure_cookies());
        assert!(config.admin.is_none());
        assert!(config.trusted_proxies.is_empty());
        assert_eq!(config.limits.logins_per_minute, 20);
        assert_eq!(config.limits.registrations_per_minute, 10);
        assert_eq!(config.password_resets_per_minute, 5);
        // 没有配置邮件服务：邮件写进文件目录旁边的目录
        assert!(config.mail.is_none());
        assert_eq!(config.mail_dir, PathBuf::from("/tmp/mail"));
        assert_eq!(config.desktop_dir, PathBuf::from("/tmp/desktop"));
    }

    #[test]
    fn the_relay_for_calls_needs_addresses_and_a_secret_together() {
        assert_eq!(with(&[]).unwrap().turn, None);
        let config = with(&[
            (
                "TURN_URLS",
                "turn:turn.example.com:3478?transport=udp, turn:turn.example.com:3478?transport=tcp",
            ),
            ("TURN_SECRET", "north"),
        ])
        .unwrap();
        let turn = config.turn.unwrap();
        assert_eq!(turn.urls.len(), 2);
        assert_eq!(turn.urls[1], "turn:turn.example.com:3478?transport=tcp");
        assert_eq!(turn.ttl_secs, 6 * 3600);
        let config = with(&[
            ("TURN_URLS", "turn:t.example.com:3478"),
            ("TURN_SECRET", "north"),
            ("TURN_CREDENTIAL_HOURS", "2"),
        ])
        .unwrap();
        assert_eq!(config.turn.unwrap().ttl_secs, 2 * 3600);
        // 只给了一半；地址写错了；时长不对
        assert!(with(&[("TURN_URLS", "turn:t.example.com:3478")]).is_err());
        assert!(with(&[("TURN_SECRET", "north")]).is_err());
        assert!(
            with(&[
                ("TURN_URLS", "stun:t.example.com:3478"),
                ("TURN_SECRET", "north")
            ])
            .is_err()
        );
        assert!(
            with(&[
                ("TURN_URLS", "turn:t.example.com:3478"),
                ("TURN_SECRET", "north"),
                ("TURN_CREDENTIAL_HOURS", "0"),
            ])
            .is_err()
        );
    }

    #[test]
    fn a_minimum_desktop_version_must_be_three_numbers() {
        assert_eq!(with(&[]).unwrap().desktop_min_version, None);
        let config = with(&[("DESKTOP_MIN_VERSION", "0.10.2")]).unwrap();
        assert_eq!(config.desktop_min_version.as_deref(), Some("0.10.2"));
        for bad in ["1.2", "v1.2.3", "1.2.3-beta", "1.02.3"] {
            assert!(with(&[("DESKTOP_MIN_VERSION", bad)]).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_desktop_installers_can_live_somewhere_else() {
        let config = with(&[("DESKTOP_DIR", "/srv/desktop")]).unwrap();
        assert_eq!(config.desktop_dir, PathBuf::from("/srv/desktop"));
    }

    #[test]
    fn a_mail_server_needs_a_sender_and_never_shows_its_password() {
        let config = with(&[
            ("SMTP_URL", "smtps://user:hunter2@mail.example.com:465"),
            ("MAIL_FROM", "VibeChat <no-reply@example.com>"),
            ("MAIL_DIR", "/var/mail-out"),
        ])
        .unwrap();
        let mail = config.mail.clone().unwrap();
        assert_eq!(mail.url, "smtps://user:hunter2@mail.example.com:465");
        assert_eq!(mail.from, "VibeChat <no-reply@example.com>");
        assert_eq!(config.mail_dir, PathBuf::from("/var/mail-out"));
        assert!(!format!("{config:?}").contains("hunter2"));

        assert_eq!(
            with(&[("SMTP_URL", "smtp://mail.example.com")]).unwrap_err(),
            ConfigError::Missing("MAIL_FROM")
        );
        let err = with(&[
            ("SMTP_URL", "http://user:hunter2@mail.example.com"),
            ("MAIL_FROM", "a@example.com"),
        ])
        .unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "SMTP_URL",
                ..
            }
        ));
        assert!(!err.to_string().contains("hunter2"));
        assert_eq!(
            invalid_name(with(&[
                ("SMTP_URL", "smtp://mail.example.com"),
                ("MAIL_FROM", "nobody"),
            ])),
            "MAIL_FROM"
        );
    }

    #[test]
    fn the_media_server_for_group_calls_needs_all_three_items() {
        assert_eq!(with(&[]).unwrap().livekit, None);
        const SECRET: &str = "0123456789abcdef0123456789abcdef";
        let config = with(&[
            ("LIVEKIT_URL", "http://127.0.0.1:7880/"),
            ("LIVEKIT_API_KEY", "devkey"),
            ("LIVEKIT_API_SECRET", SECRET),
        ])
        .unwrap();
        let livekit = config.livekit.unwrap();
        assert_eq!(livekit.url, "http://127.0.0.1:7880");
        assert_eq!(livekit.api_key, "devkey");
        assert_eq!(livekit.api_secret, SECRET);

        assert!(with(&[("LIVEKIT_URL", "http://127.0.0.1:7880")]).is_err());
        assert!(
            with(&[
                ("LIVEKIT_API_KEY", "devkey"),
                ("LIVEKIT_API_SECRET", SECRET)
            ])
            .is_err()
        );
        for url in ["ws://127.0.0.1:7880", "https://livekit.example.com"] {
            assert_eq!(
                invalid_name(with(&[
                    ("LIVEKIT_URL", url),
                    ("LIVEKIT_API_KEY", "devkey"),
                    ("LIVEKIT_API_SECRET", SECRET),
                ])),
                "LIVEKIT_URL"
            );
        }
        // 密钥太短的不要，也不把它写进错误里
        let short = with(&[
            ("LIVEKIT_URL", "http://127.0.0.1:7880"),
            ("LIVEKIT_API_KEY", "devkey"),
            ("LIVEKIT_API_SECRET", "too-short"),
        ]);
        assert!(!format!("{:?}", short.as_ref().err()).contains("too-short"));
        assert_eq!(invalid_name(short), "LIVEKIT_API_SECRET");
    }

    #[test]
    fn browsers_reach_the_media_server_under_the_page_address() {
        assert_eq!(
            with(&[]).unwrap().livekit_public_url(),
            "ws://127.0.0.1:8780/livekit"
        );
        let config = with(&[("PUBLIC_URL", "https://chat.example.com/app/")]).unwrap();
        assert_eq!(
            config.livekit_public_url(),
            "wss://chat.example.com/livekit"
        );
    }

    #[test]
    fn public_origin_drops_path_and_default_port() {
        let config = with(&[("PUBLIC_URL", "https://chat.example.com:443/app/")]).unwrap();
        assert_eq!(config.public_origin(), "https://chat.example.com");
        assert!(config.secure_cookies());
    }

    #[test]
    fn each_required_item_is_named_when_missing() {
        for missing in ["PUBLIC_URL", "DATABASE_URL", "FILES_DIR"] {
            let vars: Vec<_> = MINIMAL
                .iter()
                .copied()
                .filter(|(key, _)| *key != missing)
                .collect();
            assert_eq!(
                config(&vars).unwrap_err(),
                ConfigError::Missing(missing),
                "{missing}"
            );
        }
        assert_eq!(
            ConfigError::Missing("FILES_DIR").to_string(),
            "FILES_DIR is required but not set"
        );
    }

    #[test]
    fn empty_value_counts_as_missing() {
        assert_eq!(
            with(&[("PUBLIC_URL", "  ")]).unwrap_err(),
            ConfigError::Missing("PUBLIC_URL")
        );
    }

    #[test]
    fn invalid_values_are_named() {
        let cases = [
            ("LISTEN_ADDR", "not-an-address"),
            ("PUBLIC_URL", "ftp://example.com"),
            ("DATABASE_URL", "mysql://localhost/vm"),
            ("LOG_LEVEL", "loud"),
            ("TRUSTED_PROXIES", "10.0.0.1, not-an-ip"),
            ("LOGINS_PER_MINUTE", "0"),
            ("REGISTRATIONS_PER_MINUTE", "many"),
            ("PASSWORD_RESETS_PER_MINUTE", "0"),
        ];
        for (name, value) in cases {
            assert_eq!(invalid_name(with(&[(name, value)])), name);
        }
    }

    #[test]
    fn admin_settings_come_as_a_pair() {
        let admin = with(&[
            ("ADMIN_EMAIL", "admin@example.com"),
            ("ADMIN_INITIAL_PASSWORD", "initial-pass-1"),
        ])
        .unwrap()
        .admin
        .unwrap();
        assert_eq!(admin.email, "admin@example.com");
        assert_eq!(admin.initial_password, "initial-pass-1");

        assert_eq!(
            with(&[("ADMIN_EMAIL", "admin@example.com")]).unwrap_err(),
            ConfigError::Missing("ADMIN_INITIAL_PASSWORD")
        );
        assert_eq!(
            with(&[("ADMIN_INITIAL_PASSWORD", "initial-pass-1")]).unwrap_err(),
            ConfigError::Missing("ADMIN_EMAIL")
        );
    }

    #[test]
    fn a_weak_initial_admin_password_is_refused_without_echoing_it() {
        let err = with(&[
            ("ADMIN_EMAIL", "admin@example.com"),
            ("ADMIN_INITIAL_PASSWORD", "secret"),
        ])
        .unwrap_err();
        assert!(matches!(
            err,
            ConfigError::Invalid {
                name: "ADMIN_INITIAL_PASSWORD",
                ..
            }
        ));
        assert!(!err.to_string().contains("secret"));

        assert_eq!(
            invalid_name(with(&[
                ("ADMIN_EMAIL", "not-an-email"),
                ("ADMIN_INITIAL_PASSWORD", "initial-pass-1"),
            ])),
            "ADMIN_EMAIL"
        );
    }

    #[test]
    fn trusted_proxies_and_limits_are_parsed() {
        let config = with(&[
            ("TRUSTED_PROXIES", "10.0.0.1, ::1 ,"),
            ("LOGINS_PER_MINUTE", "500"),
        ])
        .unwrap();
        assert_eq!(
            config.trusted_proxies,
            vec![
                "10.0.0.1".parse::<IpAddr>().unwrap(),
                "::1".parse::<IpAddr>().unwrap()
            ]
        );
        assert_eq!(config.limits.logins_per_minute, 500);
        assert_eq!(config.limits.registrations_per_minute, 10);
    }

    #[test]
    fn call_timeouts_default_to_45_and_30_seconds_and_can_be_shortened() {
        let config = with(&[]).unwrap();
        assert_eq!(config.calls.ring_timeout_ms, 45_000);
        assert_eq!(config.calls.gone_grace_ms, 30_000);

        let config = with(&[("CALL_RING_SECONDS", "3"), ("CALL_GONE_SECONDS", "2")]).unwrap();
        assert_eq!(config.calls.ring_timeout_ms, 3_000);
        assert_eq!(config.calls.gone_grace_ms, 2_000);

        assert!(matches!(
            with(&[("CALL_RING_SECONDS", "0")]),
            Err(ConfigError::Invalid {
                name: "CALL_RING_SECONDS",
                ..
            })
        ));
    }
}
