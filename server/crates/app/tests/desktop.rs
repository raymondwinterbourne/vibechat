//! 桌面客户端安装包的接口：现在可以下载哪个版本，以及下载它。

mod common;

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{Client, Reply, TestApp, app};
use tempfile::TempDir;
use vibechat_protocol::{DesktopLatest, ErrorCode};

/// 一个服务端，它的安装包目录是一个临时目录。
async fn app_with_installers() -> (TestApp, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut app = app().await;
    let mut config = (*app.state.config).clone();
    config.desktop_dir = dir.path().to_owned();
    app.state.config = Arc::new(config);
    (app, dir)
}

fn put(dir: &Path, name: &str, content: &[u8]) {
    std::fs::write(dir.join(name), content).unwrap();
}

async fn latest(client: &mut Client) -> DesktopLatest {
    let reply = client.get("/api/desktop/latest").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

async fn download(client: &mut Client, headers: &[(header::HeaderName, &str)]) -> Reply {
    let mut request = Request::builder().uri("/api/desktop/download");
    for (name, value) in headers {
        request = request.header(name, *value);
    }
    client.send(request, Body::empty()).await
}

fn header_of(reply: &Reply, name: header::HeaderName) -> &str {
    reply.headers.get(name).unwrap().to_str().unwrap()
}

#[tokio::test]
async fn both_need_a_login() {
    let (app, dir) = app_with_installers().await;
    put(dir.path(), "VibeChat-0.1.0-arm64.dmg", b"installer");
    let mut visitor = app.client();
    for path in ["/api/desktop/latest", "/api/desktop/download"] {
        let reply = visitor.get(path).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(reply.error().code, ErrorCode::Unauthorized);
        assert!(!reply.text().contains("installer"));
    }
}

#[tokio::test]
async fn there_is_nothing_to_download_until_an_installer_is_put_there() {
    let (app, dir) = app_with_installers().await;
    let (mut ada, _) = app.user("Ada").await;
    assert_eq!(latest(&mut ada).await.release, None);
    let reply = download(&mut ada, &[]).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    assert_eq!(reply.error().code, ErrorCode::NotFound);

    // 放进去就能看到，不用重启
    put(dir.path(), "VibeChat-0.1.0-arm64.dmg", b"first installer");
    let release = latest(&mut ada).await.release.unwrap();
    assert_eq!(release.version, "0.1.0");
    assert_eq!(release.size, 15);
    assert_eq!(release.file_name, "VibeChat-0.1.0-arm64.dmg");
}

#[tokio::test]
async fn a_missing_directory_is_the_same_as_an_empty_one() {
    let (mut app, dir) = app_with_installers().await;
    let mut config = (*app.state.config).clone();
    config.desktop_dir = dir.path().join("not-created");
    app.state.config = Arc::new(config);
    let (mut ada, _) = app.user("Ada").await;
    assert_eq!(latest(&mut ada).await.release, None);
}

#[tokio::test]
async fn the_highest_version_is_the_one_on_offer() {
    let (app, dir) = app_with_installers().await;
    put(dir.path(), "VibeChat-0.9.0-arm64.dmg", b"nine");
    put(dir.path(), "VibeChat-0.10.0-arm64.dmg", b"ten!!");
    put(dir.path(), "VibeChat-0.2.5-arm64.dmg", b"two");
    // 这些都不算安装包：名字不对、是空的、是目录
    put(dir.path(), "VibeChat-9.9.9-x64.dmg", b"other chip");
    put(dir.path(), "VibeChat-9.9.9-arm64.dmg.part", b"half");
    put(dir.path(), "notes.txt", b"hello");
    put(dir.path(), "VibeChat-8.0.0-arm64.dmg", b"");
    std::fs::create_dir(dir.path().join("VibeChat-7.0.0-arm64.dmg")).unwrap();

    let (mut ada, _) = app.user("Ada").await;
    let release = latest(&mut ada).await.release.unwrap();
    assert_eq!(release.version, "0.10.0");
    assert_eq!(release.size, 5);

    let reply = download(&mut ada, &[]).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, b"ten!!");
    assert_eq!(
        header_of(&reply, header::CONTENT_DISPOSITION),
        "attachment; filename=\"VibeChat-0.10.0-arm64.dmg\""
    );
    assert_eq!(
        header_of(&reply, header::CONTENT_TYPE),
        "application/x-apple-diskimage"
    );
    assert_eq!(header_of(&reply, header::CONTENT_LENGTH), "5");
    assert_eq!(header_of(&reply, header::ACCEPT_RANGES), "bytes");
    assert_eq!(
        header_of(&reply, header::CACHE_CONTROL),
        "private, no-store"
    );
    assert_eq!(header_of(&reply, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
}

#[cfg(unix)]
#[tokio::test]
async fn a_link_out_of_the_directory_is_not_followed() {
    let (app, dir) = app_with_installers().await;
    let outside = tempfile::tempdir().unwrap();
    put(outside.path(), "secret", b"not an installer");
    std::os::unix::fs::symlink(
        outside.path().join("secret"),
        dir.path().join("VibeChat-5.0.0-arm64.dmg"),
    )
    .unwrap();
    let (mut ada, _) = app.user("Ada").await;
    assert_eq!(latest(&mut ada).await.release, None);
    assert_eq!(download(&mut ada, &[]).await.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn nothing_in_the_request_chooses_the_file() {
    let (app, dir) = app_with_installers().await;
    put(dir.path(), "VibeChat-0.1.0-arm64.dmg", b"installer");
    let (mut ada, _) = app.user("Ada").await;
    // 这两个地址之外没有别的入口，后面再接什么都不是一个地址
    for path in [
        "/api/desktop/download/..%2F..%2Fetc%2Fpasswd",
        "/api/desktop/download/VibeChat-0.1.0-arm64.dmg",
        "/api/desktop/..%2Fsecret",
    ] {
        assert_eq!(ada.get(path).await.status, StatusCode::NOT_FOUND, "{path}");
    }
    // 查询参数不起作用
    let reply = ada
        .get("/api/desktop/download?file=../../etc/passwd&version=9.9.9")
        .await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, b"installer");
}

#[tokio::test]
async fn a_download_can_be_picked_up_where_it_stopped() {
    let (app, dir) = app_with_installers().await;
    // 比一次读的量大，确认分块读出来的内容是对的
    let content: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    put(dir.path(), "VibeChat-1.2.3-arm64.dmg", &content);
    let (mut ada, _) = app.user("Ada").await;

    let whole = download(&mut ada, &[]).await;
    assert_eq!(whole.status, StatusCode::OK);
    assert_eq!(whole.body, content);
    let tag = header_of(&whole, header::ETAG).to_owned();
    assert_eq!(tag, "\"1.2.3-200000\"");

    let rest = download(
        &mut ada,
        &[(header::RANGE, "bytes=150000-"), (header::IF_RANGE, &tag)],
    )
    .await;
    assert_eq!(rest.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(rest.body, &content[150_000..]);
    assert_eq!(
        header_of(&rest, header::CONTENT_RANGE),
        "bytes 150000-199999/200000"
    );
    assert_eq!(header_of(&rest, header::CONTENT_LENGTH), "50000");

    let middle = download(&mut ada, &[(header::RANGE, "bytes=10-19")]).await;
    assert_eq!(middle.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(middle.body, &content[10..20]);

    let beyond = download(&mut ada, &[(header::RANGE, "bytes=200000-")]).await;
    assert_eq!(beyond.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(header_of(&beyond, header::CONTENT_RANGE), "bytes */200000");
}

#[tokio::test]
async fn a_newer_installer_restarts_a_half_finished_download() {
    let (app, dir) = app_with_installers().await;
    put(dir.path(), "VibeChat-1.0.0-arm64.dmg", b"the old installer");
    let (mut ada, _) = app.user("Ada").await;
    let first = download(&mut ada, &[(header::RANGE, "bytes=0-3")]).await;
    assert_eq!(first.body, b"the ");
    let tag = header_of(&first, header::ETAG).to_owned();

    put(dir.path(), "VibeChat-1.0.1-arm64.dmg", b"a newer installer");
    // 接着下的那一段不能拼在旧的后面：给整个新的
    let next = download(
        &mut ada,
        &[(header::RANGE, "bytes=4-"), (header::IF_RANGE, &tag)],
    )
    .await;
    assert_eq!(next.status, StatusCode::OK);
    assert_eq!(next.body, b"a newer installer");
    assert_ne!(header_of(&next, header::ETAG), tag);
}

#[tokio::test]
async fn the_minimum_desktop_version_comes_with_the_latest_release() {
    let (mut app, dir) = app_with_installers().await;
    put(dir.path(), "VibeChat-0.2.0-arm64.dmg", b"installer");
    let (mut client, _) = app.user("小明").await;
    // 没有配置时没有要求
    assert_eq!(latest(&mut client).await.min_version, None);

    let mut config = (*app.state.config).clone();
    config.desktop_min_version = Some("0.2.0".to_owned());
    app.state.config = Arc::new(config);
    let (mut client, _) = app.user("小红").await;
    let found = latest(&mut client).await;
    assert_eq!(found.min_version.as_deref(), Some("0.2.0"));
    assert_eq!(found.release.unwrap().version, "0.2.0");
}
