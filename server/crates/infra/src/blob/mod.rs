//! 文件内容的存储，基于 object_store。目前用本地目录；换成 S3 兼容的对象存储时，
//! 只需要在这里换一种 `ObjectStore` 的实现。

use std::ops::Range;
use std::path::Path as FsPath;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use object_store::local::LocalFileSystem;
use object_store::path::Path;
use object_store::{GetOptions, GetRange, ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart};
use vibechat_core::StoreError;
use vibechat_core::blob::{BlobStore, ByteStream, HEAD_BYTES, Written};

/// 边收边写时，同时最多有几块在往存储里写。收得比写得快时在这里等一等，不让内存里越积越多。
const MAX_PARTS_IN_FLIGHT: usize = 4;

pub struct ObjectBlobStore {
    store: Arc<dyn ObjectStore>,
}

impl ObjectBlobStore {
    /// 把文件存在本地的一个目录下。目录不存在时会创建。
    pub fn local(dir: impl AsRef<FsPath>) -> Result<Self, StoreError> {
        std::fs::create_dir_all(&dir).map_err(|err| {
            StoreError::Unavailable(format!(
                "cannot create files directory {}: {err}",
                dir.as_ref().display()
            ))
        })?;
        let store = LocalFileSystem::new_with_prefix(dir).map_err(unavailable)?;
        Ok(Self {
            store: Arc::new(store),
        })
    }
}

fn unavailable(err: object_store::Error) -> StoreError {
    StoreError::Unavailable(err.to_string())
}

#[async_trait]
impl BlobStore for ObjectBlobStore {
    async fn put(&self, key: &str, content: Vec<u8>) -> Result<(), StoreError> {
        self.store
            .put(&Path::from(key), PutPayload::from(content))
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        match self.store.get(&Path::from(key)).await {
            Ok(result) => Ok(Some(result.bytes().await.map_err(unavailable)?.to_vec())),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(err) => Err(unavailable(err)),
        }
    }

    async fn delete(&self, key: &str) -> Result<(), StoreError> {
        match self.store.delete(&Path::from(key)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(err) => Err(unavailable(err)),
        }
    }

    async fn write(
        &self,
        key: &str,
        mut content: ByteStream,
        max_bytes: u64,
    ) -> Result<Written, StoreError> {
        let upload = self
            .store
            .put_multipart(&Path::from(key))
            .await
            .map_err(unavailable)?;
        // 写完之前文件不会出现在 `key` 上：中途放弃（包括这个函数被丢弃，例如客户端断开）
        // 时，已经写下的部分会被清掉
        let mut writer = WriteMultipart::new(upload);
        let mut size: u64 = 0;
        let mut head = Vec::with_capacity(HEAD_BYTES);
        while let Some(chunk) = content.next().await {
            let Ok(chunk) = chunk else {
                writer.abort().await.map_err(unavailable)?;
                return Ok(Written::Interrupted);
            };
            size += chunk.len() as u64;
            if size > max_bytes {
                writer.abort().await.map_err(unavailable)?;
                return Ok(Written::TooLarge);
            }
            if head.len() < HEAD_BYTES {
                let take = (HEAD_BYTES - head.len()).min(chunk.len());
                head.extend_from_slice(&chunk[..take]);
            }
            writer
                .wait_for_capacity(MAX_PARTS_IN_FLIGHT)
                .await
                .map_err(unavailable)?;
            writer.put(chunk);
        }
        writer.finish().await.map_err(unavailable)?;
        Ok(Written::Stored { size, head })
    }

    async fn read(
        &self,
        key: &str,
        range: Option<Range<u64>>,
    ) -> Result<Option<ByteStream>, StoreError> {
        let options = GetOptions {
            range: range.map(GetRange::Bounded),
            ..GetOptions::default()
        };
        match self.store.get_opts(&Path::from(key), options).await {
            Ok(result) => Ok(Some(Box::pin(
                result
                    .into_stream()
                    .map(|chunk| chunk.map_err(std::io::Error::other)),
            ))),
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(err) => Err(unavailable(err)),
        }
    }
}
