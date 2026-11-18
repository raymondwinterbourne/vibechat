//! 消息里的文件：上传、读取时的权限检查、清理没有发出去的文件。

use std::ops::Range;
use std::sync::Arc;

use crate::account::model::{FilePurpose, StoredFile, User};
use crate::account::store::{FileStore, ImageProcessor};
use crate::blob::{BlobStore, ByteStream, Written};
use crate::chat::store::ChatStore;
use crate::clock::Clock;
use crate::ids::{ConversationId, FileId};
use crate::limits::Limits;
use crate::settings::SettingsStore;
use crate::store::StoreError;

/// 文件名最多多少个字。
pub const FILE_NAME_MAX_CHARS: usize = 255;
/// 超过这个大小的图片不去解码，当作普通文件：解码要把整张图放进内存。
pub const IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// 上传之后过了这么久还没有随消息发出去的文件会被清理。
pub const ORPHAN_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// 页面里不能直接显示或播放的文件，一律用这个类型交回去。
const OPAQUE_TYPE: &str = "application/octet-stream";

#[derive(Debug, thiserror::Error)]
pub enum FileError {
    /// 没有这个文件，或者我无权读取。两种情况不作区分。
    #[error("no such file")]
    NotFound,
    #[error("the file is larger than {max_bytes} bytes")]
    TooLarge { max_bytes: u64 },
    #[error("the file is empty")]
    Empty,
    /// 内容没有传完就断了。
    #[error("the upload was interrupted")]
    Interrupted,
    #[error(transparent)]
    Store(#[from] StoreError),
}

pub struct FileServiceDeps {
    pub files: Arc<dyn FileStore>,
    pub blobs: Arc<dyn BlobStore>,
    pub images: Arc<dyn ImageProcessor>,
    pub chat: Arc<dyn ChatStore>,
    pub settings: Arc<dyn SettingsStore>,
    pub clock: Arc<dyn Clock>,
}

pub struct FileService {
    deps: FileServiceDeps,
}

impl FileService {
    pub fn new(deps: FileServiceDeps) -> Self {
        Self { deps }
    }

    /// 当前生效的各项上限。
    pub async fn limits(&self) -> Result<Limits, FileError> {
        Ok(Limits::load(self.deps.settings.as_ref()).await?)
    }

    /// 上传一个要随消息发出去的文件。内容边收边写，超过上限就中止。
    ///
    /// `declared_type` 是浏览器报的类型，只用来在"这是一段录音"和"这是一段视频"之间做区分；
    /// 文件到底是什么，看的是内容。
    pub async fn upload(
        &self,
        me: &User,
        name: &str,
        declared_type: &str,
        content: ByteStream,
    ) -> Result<StoredFile, FileError> {
        let max_bytes = self.limits().await?.file_max_bytes;
        let id = FileId::new();
        // 路径完全由服务端生成，不包含任何用户提供的内容
        let key = format!("attachment/{}/{id}", me.id);
        let (size, head) = match self.deps.blobs.write(&key, content, max_bytes).await? {
            Written::Stored { size, head } => (size, head),
            Written::TooLarge => return Err(FileError::TooLarge { max_bytes }),
            Written::Interrupted => return Err(FileError::Interrupted),
        };
        if size == 0 {
            self.deps.blobs.delete(&key).await?;
            return Err(FileError::Empty);
        }

        let mut file = StoredFile {
            id,
            storage_key: key,
            content_type: OPAQUE_TYPE.to_owned(),
            size: size as i64,
            uploader: me.id,
            purpose: FilePurpose::Attachment,
            width: None,
            height: None,
            name: Some(clean_name(name)),
            thumbnail_key: None,
            created_at: self.deps.clock.now_ms(),
        };
        if let Some(audio) = audio_type(&head, declared_type) {
            file.content_type = audio.to_owned();
        } else if looks_like_image(&head) && size <= IMAGE_MAX_BYTES {
            self.describe_image(&mut file).await?;
        }
        self.deps.files.create(&file).await?;
        Ok(file)
    }

    /// 确认它是能在页面里显示的图片，是的话生成缩略图、记下宽高。
    async fn describe_image(&self, file: &mut StoredFile) -> Result<(), FileError> {
        let Some(content) = self.deps.blobs.get(&file.storage_key).await? else {
            return Ok(());
        };
        let Some(thumbnail) = self.deps.images.thumbnail(content).await else {
            // 开头像图片，内容却解不出来：当作普通文件
            return Ok(());
        };
        let key = format!("{}.thumb", file.storage_key);
        self.deps.blobs.put(&key, thumbnail.content).await?;
        file.content_type = thumbnail.original_type.to_owned();
        file.width = Some(thumbnail.width as i32);
        file.height = Some(thumbnail.height as i32);
        file.thumbnail_key = Some(key);
        Ok(())
    }

    /// 我能不能读这个文件。能的话返回它的登记信息。
    ///
    /// 头像对所有登录的人开放。消息附件看的是它所在的那条消息：我必须能看到那条消息，
    /// 并且它没有被撤回；还没有随消息发出去的文件只有上传的人能读。
    pub async fn open(&self, me: &User, id: FileId) -> Result<StoredFile, FileError> {
        let file = self.deps.files.find(id).await?.ok_or(FileError::NotFound)?;
        match file.purpose {
            FilePurpose::Avatar => Ok(file),
            FilePurpose::Attachment => {
                let allowed = match self.deps.chat.find_by_file(id).await? {
                    None => file.uploader == me.id,
                    Some(message) => {
                        let member = self
                            .deps
                            .chat
                            .find_member(message.conversation, me.id)
                            .await?;
                        !message.is_recalled()
                            && member.is_some_and(|member| member.visible().contains(message.seq))
                    }
                };
                if allowed {
                    Ok(file)
                } else {
                    Err(FileError::NotFound)
                }
            }
        }
    }

    /// 管理员查看一个会话时读其中的文件：它必须是这个会话里某条消息的附件。
    /// 不看消息有没有撤回。
    pub async fn open_in(
        &self,
        conversation: ConversationId,
        id: FileId,
    ) -> Result<StoredFile, FileError> {
        let file = self.deps.files.find(id).await?.ok_or(FileError::NotFound)?;
        let message = self.deps.chat.find_by_file(id).await?;
        if message.is_some_and(|message| message.conversation == conversation) {
            Ok(file)
        } else {
            Err(FileError::NotFound)
        }
    }

    /// 文件的内容，或者其中的一段，边读边交出。
    pub async fn content(
        &self,
        file: &StoredFile,
        range: Option<Range<u64>>,
    ) -> Result<ByteStream, FileError> {
        let found = self.deps.blobs.read(&file.storage_key, range).await?;
        found.ok_or(FileError::NotFound)
    }

    /// 图片的缩略图。不是图片的文件没有。
    pub async fn thumbnail(&self, file: &StoredFile) -> Result<Vec<u8>, FileError> {
        let key = file.thumbnail_key.as_deref().ok_or(FileError::NotFound)?;
        let found = self.deps.blobs.get(key).await?;
        found.ok_or(FileError::NotFound)
    }

    /// 删掉上传了很久还没有发出去的文件，返回删了几个。
    pub async fn sweep(&self) -> Result<u64, FileError> {
        let before = self.deps.clock.now_ms() - ORPHAN_AFTER_MS;
        let mut removed = 0;
        for file in self.deps.files.list_orphans(before).await? {
            self.discard(&file).await?;
            removed += 1;
        }
        Ok(removed)
    }

    /// 删掉这些文件：登记和内容。它们所在的消息已经被清理掉了。返回删了几个。
    pub async fn remove(&self, ids: &[FileId]) -> Result<u64, StoreError> {
        let mut removed = 0;
        for chunk in ids.chunks(200) {
            for file in self.deps.files.find_many(chunk).await? {
                self.discard(&file).await?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    async fn discard(&self, file: &StoredFile) -> Result<(), StoreError> {
        // 先删登记，再删内容：中途失败时留下的是没有登记的内容，不会有登记了却读不到的文件
        self.deps.files.delete(file.id).await?;
        // 转发出来的文件和原文件共用同一份内容（连同缩略图）：还有登记指向它就留着
        if self.deps.files.count_sharing(&file.storage_key).await? > 0 {
            return Ok(());
        }
        self.deps.blobs.delete(&file.storage_key).await?;
        if let Some(key) = &file.thumbnail_key {
            self.deps.blobs.delete(key).await?;
        }
        Ok(())
    }
}

/// 整理文件名：只留最后一段（去掉路径），去掉控制字符，截到上限。什么都不剩时叫 `file`。
pub fn clean_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = last.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return "file".to_owned();
    }
    cleaned.chars().take(FILE_NAME_MAX_CHARS).collect()
}

/// 内容的开头像不像一张 JPEG、PNG、GIF 或 WebP。只是初筛，是不是真的图片要解码了才知道。
fn looks_like_image(head: &[u8]) -> bool {
    head.starts_with(&[0xFF, 0xD8, 0xFF])
        || head.starts_with(b"\x89PNG\r\n\x1a\n")
        || head.starts_with(b"GIF87a")
        || head.starts_with(b"GIF89a")
        || (head.starts_with(b"RIFF") && head.get(8..12) == Some(b"WEBP"))
}

/// 这是不是一段浏览器录下的音频，是的话是哪一种。
///
/// 这几种容器既能装音频也能装视频，光看开头分不出来，所以还要浏览器报的类型是音频。
/// 认错了也只是让一个视频文件能被当作语音发出去、放不出声音，不会有别的后果。
fn audio_type(head: &[u8], declared_type: &str) -> Option<&'static str> {
    if !declared_type
        .trim()
        .to_ascii_lowercase()
        .starts_with("audio/")
    {
        return None;
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        Some("audio/webm")
    } else if head.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if head.get(4..8) == Some(b"ftyp") {
        Some("audio/mp4")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_lose_their_path_and_control_characters() {
        assert_eq!(clean_name("报告.pdf"), "报告.pdf");
        assert_eq!(clean_name("../../etc/passwd"), "passwd");
        assert_eq!(clean_name("C:\\Users\\me\\a.txt"), "a.txt");
        assert_eq!(clean_name("a\u{0}b\n.txt"), "ab.txt");
        assert_eq!(clean_name("   "), "file");
        assert_eq!(clean_name("dir/"), "file");
        assert_eq!(clean_name(&"长".repeat(300)).chars().count(), 255);
    }

    #[test]
    fn audio_is_recognised_by_content_and_declared_type_together() {
        let webm = [0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0];
        assert_eq!(
            audio_type(&webm, "audio/webm;codecs=opus"),
            Some("audio/webm")
        );
        assert_eq!(audio_type(b"OggS\0\0\0\0", "Audio/Ogg"), Some("audio/ogg"));
        assert_eq!(
            audio_type(b"\0\0\0\x1cftypM4A ", "audio/mp4"),
            Some("audio/mp4")
        );
        // 同样的容器，浏览器说是视频：不当作语音
        assert_eq!(audio_type(&webm, "video/webm"), None);
        // 说是音频，内容却不是
        assert_eq!(audio_type(b"<html>", "audio/webm"), None);
    }

    #[test]
    fn images_are_screened_by_their_first_bytes() {
        assert!(looks_like_image(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(looks_like_image(b"\x89PNG\r\n\x1a\n...."));
        assert!(looks_like_image(b"GIF89a...."));
        assert!(looks_like_image(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!looks_like_image(b"RIFF\0\0\0\0WAVEfmt "));
        assert!(!looks_like_image(b"<svg xmlns="));
        assert!(!looks_like_image(b""));
    }
}
