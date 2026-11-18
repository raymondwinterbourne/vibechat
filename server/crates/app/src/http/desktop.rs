//! 桌面客户端的安装包：现在可以下载哪个版本，以及下载它。
//!
//! 安装包由部署的人放进 `DESKTOP_DIR`，文件名形如 `VibeChat-0.1.0-arm64.dmg`。
//! 放进去就生效，不用重启。请求里不带文件名，也不带路径：
//! 服务端只交出这个目录里版本号最高的那一个，所以拿不到别的文件。

use std::io::SeekFrom;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::stream;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use vibechat_protocol::{DesktopLatest, DesktopRelease, ErrorCode};

use super::auth::ActiveUser;
use super::files::{Requested, parse_range};
use crate::error::AppError;
use crate::state::AppState;

const PREFIX: &str = "VibeChat-";
const SUFFIX: &str = "-arm64.dmg";
/// 一次从磁盘读多少。
const CHUNK: usize = 64 * 1024;

/// 版本号：主、次、修订，三个数字。
type Version = (u32, u32, u32);

struct Installer {
    version: Version,
    name: String,
    path: PathBuf,
    size: u64,
}

impl Installer {
    fn release(&self) -> DesktopRelease {
        let (major, minor, patch) = self.version;
        DesktopRelease {
            version: format!("{major}.{minor}.{patch}"),
            size: self.size,
            file_name: self.name.clone(),
        }
    }

    /// 内容的标记：版本号加大小。浏览器接着上次没下完的往下取时，用它确认还是同一个文件。
    fn tag(&self) -> String {
        let (major, minor, patch) = self.version;
        format!("\"{major}.{minor}.{patch}-{}\"", self.size)
    }
}

/// 从文件名里读出版本号。不是安装包的文件名返回空。
fn version_of(name: &str) -> Option<Version> {
    let version = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let mut parts = version.split('.');
    let mut next = || {
        let part = parts.next()?;
        // 只接受纯数字，并且不带多余的前导零："01"、"+1"、"" 都不算
        let plain = !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_digit())
            && (part == "0" || !part.starts_with('0'));
        plain.then(|| part.parse::<u32>().ok()).flatten()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// 目录里版本号最高的安装包。目录不存在、里面没有安装包时返回空。
async fn latest_in(dir: &Path) -> std::io::Result<Option<Installer>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let mut latest: Option<Installer> = None;
    while let Some(entry) = entries.next_entry().await? {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(version) = version_of(&name) else {
            continue;
        };
        // 只认普通文件。指向别处的链接不跟过去
        let Ok(meta) = tokio::fs::symlink_metadata(entry.path()).await else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 {
            continue;
        }
        if latest.as_ref().is_none_or(|best| version > best.version) {
            latest = Some(Installer {
                version,
                name,
                path: entry.path(),
                size: meta.len(),
            });
        }
    }
    Ok(latest)
}

async fn find(state: &AppState) -> Result<Option<Installer>, AppError> {
    latest_in(&state.config.desktop_dir).await.map_err(|err| {
        tracing::error!(
            "desktop installers in {}: {err}",
            state.config.desktop_dir.display()
        );
        AppError::new(ErrorCode::Internal, "internal error")
    })
}

/// 现在可以下载哪个版本。
pub async fn latest(
    State(state): State<AppState>,
    ActiveUser(_): ActiveUser,
) -> Result<Json<DesktopLatest>, AppError> {
    let release = find(&state).await?.map(|installer| installer.release());
    Ok(Json(DesktopLatest {
        release,
        min_version: state.config.desktop_min_version.clone(),
    }))
}

/// 下载安装包。支持只取其中一段，下到一半断了可以接着下。
pub async fn download(
    State(state): State<AppState>,
    ActiveUser(_): ActiveUser,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let Some(installer) = find(&state).await? else {
        return Err(AppError::new(ErrorCode::NotFound, "no installer"));
    };
    let size = installer.size;
    let tag = installer.tag();
    let text = |name| headers.get(name).and_then(|value| value.to_str().ok());

    // "接着下"的请求会带上它上次拿到的标记。对不上说明安装包已经换了，从头给新的
    let same_file = text(header::IF_RANGE).is_none_or(|expected| expected.trim() == tag);
    let requested = text(header::RANGE)
        .filter(|_| same_file)
        .map(|value| parse_range(value, size));
    let range = match requested {
        None | Some(Requested::Whole) => None,
        Some(Requested::Part(range)) => Some(range),
        Some(Requested::Unsatisfiable) => {
            let mut response =
                AppError::new(ErrorCode::BadRequest, "range not satisfiable").into_response();
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            if let Ok(total) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, total);
            }
            return Ok(response);
        }
    };
    let (start, length) = match &range {
        Some(range) => (range.start, range.end - range.start),
        None => (0, size),
    };

    let unreadable = |err: std::io::Error| {
        tracing::error!("desktop installer {}: {err}", installer.path.display());
        AppError::new(ErrorCode::Internal, "internal error")
    };
    let mut file = File::open(&installer.path).await.map_err(unreadable)?;
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(unreadable)?;
    let content = stream::try_unfold(file.take(length), |mut file| async move {
        let mut chunk = vec![0; CHUNK];
        let read = file.read(&mut chunk).await?;
        chunk.truncate(read);
        Ok::<_, std::io::Error>((read > 0).then_some((chunk, file)))
    });

    let mut response = Body::from_stream(content).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-apple-diskimage"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // 这个地址以后会交出更新的版本，不让浏览器和中间的代理留着旧的
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    // 文件名只含字母、数字、点和连字符（见 `version_of`），可以直接写进请求头
    let disposition = format!("attachment; filename=\"{}\"", installer.name);
    for (name, value) in [
        (header::CONTENT_DISPOSITION, disposition),
        (header::ETAG, tag),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(name, value);
        }
    }
    if let Some(range) = &range {
        let value = format!("bytes {}-{}/{size}", range.start, range.end - 1);
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(header::CONTENT_RANGE, value);
        }
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_is_read_from_the_file_name() {
        assert_eq!(version_of("VibeChat-0.1.0-arm64.dmg"), Some((0, 1, 0)));
        assert_eq!(
            version_of("VibeChat-12.30.456-arm64.dmg"),
            Some((12, 30, 456))
        );
    }

    #[test]
    fn other_files_are_not_installers() {
        for name in [
            "",
            "VibeChat-arm64.dmg",
            "VibeChat-0.1-arm64.dmg",
            "VibeChat-0.1.0.0-arm64.dmg",
            "VibeChat-0.1.x-arm64.dmg",
            "VibeChat-0.01.0-arm64.dmg",
            "VibeChat-+1.0.0-arm64.dmg",
            "VibeChat-0.1.0-x64.dmg",
            "VibeChat-0.1.0-arm64.dmg.part",
            "vibechat-0.1.0-arm64.dmg",
            "VibeChat-0.1.0-arm64.zip",
            "VibeChat-../../x-arm64.dmg",
            ".DS_Store",
        ] {
            assert_eq!(version_of(name), None, "{name}");
        }
    }

    #[test]
    fn versions_compare_as_numbers_not_as_text() {
        let version = |text: &str| version_of(&format!("{PREFIX}{text}{SUFFIX}")).unwrap();
        assert!(version("0.10.0") > version("0.9.9"));
        assert!(version("1.0.0") > version("0.99.99"));
        assert!(version("0.1.10") > version("0.1.9"));
    }
}
