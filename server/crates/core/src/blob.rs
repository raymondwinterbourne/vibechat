//! 文件内容的存储。现在是本地目录，以后可以换成对象存储。

use std::ops::Range;
use std::pin::Pin;

use async_trait::async_trait;
use bytes::Bytes;
use futures_util::Stream;

use crate::store::StoreError;

/// 一段一段到来的文件内容。
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

/// 边收边写的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    Stored {
        size: u64,
        /// 内容最前面的一小段，用来判断它是什么类型的文件。
        head: Vec<u8>,
    },
    /// 内容超过了上限。已经写下的部分不会留下。
    TooLarge,
    /// 内容没有收完就断了（上传被取消）。已经写下的部分不会留下。
    Interrupted,
}

/// 判断文件类型要看的开头有多长。
pub const HEAD_BYTES: usize = 64;

#[async_trait]
pub trait BlobStore: Send + Sync {
    /// 保存一个文件。`key` 由服务端生成，不包含任何用户输入。
    async fn put(&self, key: &str, content: Vec<u8>) -> Result<(), StoreError>;

    /// 读取一个文件；不存在时返回 `None`。
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError>;

    async fn delete(&self, key: &str) -> Result<(), StoreError>;

    /// 边收边写：内容不会整个放在内存里。超过 `max_bytes` 就停下，什么也不留。
    async fn write(
        &self,
        key: &str,
        content: ByteStream,
        max_bytes: u64,
    ) -> Result<Written, StoreError>;

    /// 边读边交出一个文件，或者其中的一段（从 `start` 到 `end`，不含 `end`）。
    /// 不存在时返回 `None`。
    async fn read(
        &self,
        key: &str,
        range: Option<Range<u64>>,
    ) -> Result<Option<ByteStream>, StoreError>;
}
