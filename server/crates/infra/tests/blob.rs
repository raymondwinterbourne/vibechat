//! 本地目录上的文件存储。

use bytes::Bytes;
use futures_util::StreamExt;
use vibechat_core::blob::{BlobStore, ByteStream, HEAD_BYTES, Written};
use vibechat_infra::blob::ObjectBlobStore;

/// 把一段内容变成"一段一段到来"的样子。
fn stream(content: &[u8], chunk: usize) -> ByteStream {
    let chunks: Vec<Result<Bytes, std::io::Error>> = content
        .chunks(chunk)
        .map(|part| Ok(Bytes::copy_from_slice(part)))
        .collect();
    Box::pin(futures_util::stream::iter(chunks))
}

async fn collect(mut stream: ByteStream) -> Vec<u8> {
    let mut content = Vec::new();
    while let Some(chunk) = stream.next().await {
        content.extend_from_slice(&chunk.unwrap());
    }
    content
}

/// 目录下一共有几个文件，包括写到一半留下的临时文件。
fn files_under(dir: &std::path::Path) -> usize {
    let mut count = 0;
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        count += if path.is_dir() { files_under(&path) } else { 1 };
    }
    count
}

#[tokio::test]
async fn content_can_be_written_read_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    // 目录还不存在时自动创建
    let store = ObjectBlobStore::local(dir.path().join("files")).unwrap();

    store
        .put("avatar/user-1/file-1", b"hello".to_vec())
        .await
        .unwrap();
    assert_eq!(
        store.get("avatar/user-1/file-1").await.unwrap().as_deref(),
        Some(b"hello".as_slice())
    );
    assert!(dir.path().join("files/avatar/user-1/file-1").is_file());

    store.delete("avatar/user-1/file-1").await.unwrap();
    assert_eq!(store.get("avatar/user-1/file-1").await.unwrap(), None);
    // 删除不存在的文件不出错
    store.delete("avatar/user-1/file-1").await.unwrap();
}

#[tokio::test]
async fn a_missing_file_reads_as_none() {
    let dir = tempfile::tempdir().unwrap();
    let store = ObjectBlobStore::local(dir.path()).unwrap();
    assert_eq!(store.get("no/such/file").await.unwrap(), None);
}

#[tokio::test]
async fn writing_again_replaces_the_content() {
    let dir = tempfile::tempdir().unwrap();
    let store = ObjectBlobStore::local(dir.path()).unwrap();
    store.put("a/b", b"first".to_vec()).await.unwrap();
    store.put("a/b", b"second".to_vec()).await.unwrap();
    assert_eq!(
        store.get("a/b").await.unwrap().as_deref(),
        Some(b"second".as_slice())
    );
}

#[tokio::test]
async fn binary_content_survives_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let store = ObjectBlobStore::local(dir.path()).unwrap();
    let content: Vec<u8> = (0..=255).cycle().take(100_000).collect();
    store.put("big", content.clone()).await.unwrap();
    assert_eq!(store.get("big").await.unwrap(), Some(content));
}

#[tokio::test]
async fn content_arriving_in_pieces_is_stored_whole() {
    let dir = tempfile::tempdir().unwrap();
    let store = ObjectBlobStore::local(dir.path()).unwrap();
    let content: Vec<u8> = (0..=255).cycle().take(300_000).collect();

    let written = store.write("a/big", stream(&content, 7_000), 300_000).await;
    let Written::Stored { size, head } = written.unwrap() else {
        panic!("the content fits the limit");
    };
    assert_eq!(size, 300_000);
    assert_eq!(head, &content[..HEAD_BYTES]);
    assert_eq!(store.get("a/big").await.unwrap(), Some(content.clone()));

    // 整个读，或者只读一段
    let whole = collect(store.read("a/big", None).await.unwrap().unwrap()).await;
    assert_eq!(whole, content);
    let part = collect(
        store
            .read("a/big", Some(1000..1010))
            .await
            .unwrap()
            .unwrap(),
    )
    .await;
    assert_eq!(part, &content[1000..1010]);
    let tail = store.read("a/big", Some(299_990..300_000)).await.unwrap();
    assert_eq!(collect(tail.unwrap()).await, &content[299_990..]);
    assert!(store.read("no/such", None).await.unwrap().is_none());

    // 比"开头一小段"还短的内容
    let written = store.write("a/tiny", stream(b"hi", 1), 10).await.unwrap();
    let expected = Written::Stored {
        size: 2,
        head: b"hi".to_vec(),
    };
    assert_eq!(written, expected);
}

#[tokio::test]
async fn content_over_the_limit_or_cut_short_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let store = ObjectBlobStore::local(dir.path()).unwrap();
    let content = vec![7u8; 50_000];

    let written = store.write("a/big", stream(&content, 4_000), 49_999).await;
    assert_eq!(written.unwrap(), Written::TooLarge);
    assert_eq!(store.get("a/big").await.unwrap(), None);

    let broken: ByteStream = Box::pin(futures_util::stream::iter([
        Ok(Bytes::from(content.clone())),
        Err(std::io::Error::other("connection reset")),
    ]));
    let written = store.write("a/half", broken, 1_000_000).await;
    assert_eq!(written.unwrap(), Written::Interrupted);
    assert_eq!(store.get("a/half").await.unwrap(), None);

    // 写到一半被丢弃（上传的人断开了）：同样什么也不留
    let endless: ByteStream = Box::pin(
        futures_util::stream::iter([Ok(Bytes::from(content))])
            .chain(futures_util::stream::pending()),
    );
    let writing = store.write("a/dropped", endless, 1_000_000);
    let timed_out = tokio::time::timeout(std::time::Duration::from_millis(200), writing).await;
    assert!(timed_out.is_err());
    // 清理是在后台做的，等它一下
    for _ in 0..50 {
        if files_under(dir.path()) == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        files_under(dir.path()),
        0,
        "no partial or temporary files remain"
    );
}
