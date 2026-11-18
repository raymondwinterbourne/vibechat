//! 文件：上传要随消息发出去的文件，读取头像和消息里的文件。

use std::ops::Range;
use std::time::Duration;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde::Deserialize;
use vibechat_core::FileId;
use vibechat_core::account::model::{FilePurpose, StoredFile};
use vibechat_core::file::FileError;
use vibechat_protocol::{ErrorCode, FileView};

use super::auth::ActiveUser;
use super::json::ApiQuery;
use super::views;
use crate::error::AppError;
use crate::state::AppState;

/// 上传时文件名放在这个请求头里，按 UTF-8 做百分号编码（请求头里不能直接写中文）。
const FILE_NAME_HEADER: &str = "x-file-name";
/// 文件名里不用编码的字符。
const FILE_NAME_SAFE: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// 拒绝一个上传时，最多替对方读掉这么多内容、等这么久。
const DISCARD_MAX_BYTES: u64 = 64 * 1024 * 1024;
const DISCARD_MAX_TIME: Duration = Duration::from_secs(15);

pub fn file_id(text: &str) -> Result<FileId, FileError> {
    // 编号格式不对和文件不存在是同一种回答
    text.parse().map_err(|_| FileError::NotFound)
}

/// 上传一个文件。请求体就是文件的内容，边收边写；超过上限就中止。
/// 应答里说明服务端把它认成了什么：图片、音频，还是普通文件。
pub async fn upload(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<FileView>), AppError> {
    let text = |name| headers.get(name).and_then(|value| value.to_str().ok());
    let name = text(FILE_NAME_HEADER)
        .map(|name| percent_decode_str(name).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let declared_type = text(header::CONTENT_TYPE.as_str()).unwrap_or_default();

    // 浏览器报了长度并且已经超过上限：一个字节都不用存
    let max_bytes = state.files.limits().await?.file_max_bytes;
    let declared_size = text(header::CONTENT_LENGTH.as_str()).and_then(|v| v.parse::<u64>().ok());
    if declared_size.is_some_and(|size| size > max_bytes) {
        discard(body).await;
        return Err(FileError::TooLarge { max_bytes }.into());
    }

    let content = body
        .into_data_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let file = state
        .files
        .upload(&context.user, &name, declared_type, Box::pin(content))
        .await?;
    Ok((StatusCode::CREATED, Json(views::file(&file))))
}

/// 把对方正在发的内容读掉，不保存。拒绝一个上传之前先做这件事。
///
/// 不读就答复的话，连接会在对方还在发的时候被关掉，对方多半收不到这个答复：
/// 经过反向代理时，用户看到的就成了"网关错误"，而不是"文件太大"。
/// 读多少、等多久都有上限：大得离谱的、发得太慢的，不奉陪，直接答复。
async fn discard(body: Body) {
    let mut content = body.into_data_stream();
    let read_all = async {
        let mut seen: u64 = 0;
        while let Some(Ok(chunk)) = content.next().await {
            seen += chunk.len() as u64;
            if seen > DISCARD_MAX_BYTES {
                break;
            }
        }
    };
    let _ = tokio::time::timeout(DISCARD_MAX_TIME, read_all).await;
}

#[derive(Debug, Deserialize)]
pub struct ReadParams {
    /// 带上它（任意值）时，图片和音频也作为下载返回，而不是在页面里显示。
    pub download: Option<String>,
}

/// 读取一个文件。每次都校验请求者是否有权访问，客户端不直接接触存储。
/// 支持只取其中一段：浏览器播放音频时会这样请求。
pub async fn read(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
    ApiQuery(params): ApiQuery<ReadParams>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let file = state.files.open(&context.user, file_id(&id)?).await?;
    serve(&state, &file, params.download.is_some(), &headers).await
}

/// 把一个已经确认可以读的文件交出去，或者其中的一段。
pub async fn serve(
    state: &AppState,
    file: &StoredFile,
    download: bool,
    headers: &HeaderMap,
) -> Result<Response, AppError> {
    let size = file.size.max(0) as u64;
    let requested = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| parse_range(value, size));
    let range = match requested {
        // 没有要求只取一段，或者写法不认识：给整个文件
        None | Some(Requested::Whole) => None,
        Some(Requested::Part(range)) => Some(range),
        Some(Requested::Unsatisfiable) => {
            let total = HeaderValue::from_str(&format!("bytes */{size}"));
            let mut response =
                AppError::new(ErrorCode::BadRequest, "range not satisfiable").into_response();
            *response.status_mut() = StatusCode::RANGE_NOT_SATISFIABLE;
            if let Ok(total) = total {
                response.headers_mut().insert(header::CONTENT_RANGE, total);
            }
            return Ok(response);
        }
    };
    let content = state.files.content(file, range.clone()).await?;

    let mut response = Body::from_stream(content).into_response();
    let headers = response.headers_mut();
    common_headers(headers, &file.content_type);
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_DISPOSITION, disposition(file, download));
    let length = match &range {
        Some(range) => {
            let value = format!("bytes {}-{}/{size}", range.start, range.end - 1);
            if let Ok(value) = HeaderValue::from_str(&value) {
                headers.insert(header::CONTENT_RANGE, value);
            }
            range.end - range.start
        }
        None => size,
    };
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    if range.is_some() {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

/// 图片的缩略图。能读原图的人才能读它。
pub async fn thumbnail(
    State(state): State<AppState>,
    ActiveUser(context): ActiveUser,
    Path(id): Path<String>,
) -> Result<Response, AppError> {
    let file = state.files.open(&context.user, file_id(&id)?).await?;
    serve_thumbnail(&state, &file).await
}

/// 把一个已经确认可以读的图片的缩略图交出去。
pub async fn serve_thumbnail(state: &AppState, file: &StoredFile) -> Result<Response, AppError> {
    let content = state.files.thumbnail(file).await?;
    // 缩略图是服务端自己生成的，只有这两种格式
    let content_type = if content.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        "image/png"
    };
    let mut response = content.into_response();
    common_headers(response.headers_mut(), content_type);
    Ok(response)
}

fn common_headers(headers: &mut HeaderMap, content_type: &str) {
    let content_type = HeaderValue::from_str(content_type)
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    headers.insert(header::CONTENT_TYPE, content_type);
    // 不让浏览器自行猜测内容的类型
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // 即使有人把这个地址直接在浏览器里打开，里面的内容也不能运行脚本、不能加载别的东西
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    // 文件的内容永不改变（换头像会得到新的编号），浏览器可以一直用缓存；
    // 但内容需要登录才能看，不允许中间的代理缓存
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
}

/// 浏览器拿到内容之后怎么办：在页面里用，还是存成文件。
///
/// 只有头像、服务端认定的图片和音频可以在页面里用；其余一律存成文件，
/// 这样上传的网页、脚本不会被浏览器当作页面打开。
fn disposition(file: &StoredFile, download: bool) -> HeaderValue {
    let inline = match file.purpose {
        FilePurpose::Avatar => true,
        FilePurpose::Attachment => (file.is_image() || file.is_audio()) && !download,
    };
    let Some(name) = file.name.as_deref().filter(|_| !inline) else {
        return HeaderValue::from_static("inline");
    };
    // 两种写法都给：老的写法只能是 ASCII，新的写法带着真正的名字
    let ascii: String = name
        .chars()
        .map(|c| match c {
            '"' | '\\' => '_',
            c if c.is_ascii() && !c.is_ascii_control() => c,
            _ => '_',
        })
        .collect();
    let encoded = utf8_percent_encode(name, FILE_NAME_SAFE);
    let value = format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}");
    HeaderValue::from_str(&value).unwrap_or(HeaderValue::from_static("attachment"))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Requested {
    /// 给整个文件。
    Whole,
    /// 从 `start` 到 `end`，不含 `end`。
    Part(Range<u64>),
    /// 要的那一段不在文件里。
    Unsatisfiable,
}

/// 解析"只取一段"的请求头。只支持一段；写法不认识或者要了好几段时，按整个文件回答。
pub(super) fn parse_range(value: &str, size: u64) -> Requested {
    let Some(spec) = value.trim().strip_prefix("bytes=") else {
        return Requested::Whole;
    };
    if spec.contains(',') {
        return Requested::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return Requested::Whole;
    };
    let range = match (first.trim(), last.trim()) {
        // 最后的 N 个字节
        ("", suffix) => match suffix.parse::<u64>() {
            Ok(0) => return Requested::Unsatisfiable,
            Ok(count) => size.saturating_sub(count)..size,
            Err(_) => return Requested::Whole,
        },
        // 从某个位置到末尾
        (first, "") => match first.parse::<u64>() {
            Ok(first) => first..size,
            Err(_) => return Requested::Whole,
        },
        (first, last) => match (first.parse::<u64>(), last.parse::<u64>()) {
            (Ok(first), Ok(last)) if first <= last => first..last.saturating_add(1).min(size),
            _ => return Requested::Whole,
        },
    };
    if range.start >= size {
        return Requested::Unsatisfiable;
    }
    Requested::Part(range)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_byte_range_is_understood() {
        assert_eq!(parse_range("bytes=0-99", 1000), Requested::Part(0..100));
        assert_eq!(parse_range("bytes=500-", 1000), Requested::Part(500..1000));
        assert_eq!(parse_range("bytes=-100", 1000), Requested::Part(900..1000));
        // 超出末尾的截到末尾
        assert_eq!(
            parse_range("bytes=900-5000", 1000),
            Requested::Part(900..1000)
        );
        assert_eq!(parse_range("bytes=-5000", 1000), Requested::Part(0..1000));
        assert_eq!(parse_range(" bytes=0-0 ", 1000), Requested::Part(0..1));
    }

    #[test]
    fn a_range_outside_the_file_cannot_be_served() {
        assert_eq!(parse_range("bytes=1000-", 1000), Requested::Unsatisfiable);
        assert_eq!(
            parse_range("bytes=2000-3000", 1000),
            Requested::Unsatisfiable
        );
        assert_eq!(parse_range("bytes=-0", 1000), Requested::Unsatisfiable);
    }

    #[test]
    fn anything_else_gets_the_whole_file() {
        for value in [
            "",
            "items=0-5",
            "bytes=5-2",
            "bytes=a-b",
            "bytes=0-1,5-9",
            "bytes=7",
        ] {
            assert_eq!(parse_range(value, 1000), Requested::Whole, "{value}");
        }
    }

    #[test]
    fn only_images_and_audio_are_shown_in_the_page() {
        let file = |content_type: &str, width: Option<i32>, name: &str| StoredFile {
            id: FileId::new(),
            storage_key: "k".to_owned(),
            content_type: content_type.to_owned(),
            size: 1,
            uploader: vibechat_core::UserId::new(),
            purpose: FilePurpose::Attachment,
            width,
            height: width,
            name: Some(name.to_owned()),
            thumbnail_key: None,
            created_at: 0,
        };
        let image = file("image/png", Some(10), "a.png");
        assert_eq!(disposition(&image, false), "inline");
        assert_eq!(
            disposition(&image, true),
            "attachment; filename=\"a.png\"; filename*=UTF-8''a.png"
        );
        assert_eq!(
            disposition(&file("audio/webm", None, "v.webm"), false),
            "inline"
        );
        // 网页文件只能下载；名字里的中文、引号都处理好
        let page = file("application/octet-stream", None, "报告 \"终\".html");
        assert_eq!(
            disposition(&page, false),
            "attachment; filename=\"__ ___.html\"; \
             filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%22%E7%BB%88%22.html"
        );
    }
}
