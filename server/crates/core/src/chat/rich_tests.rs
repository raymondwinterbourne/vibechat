//! 图片、文件、语音、引用、撤回、搜索的业务规则的测试。数据在内存里，时间可以拨动。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use futures_util::StreamExt;

use super::service::{QUOTE_MAX_CHARS, SEARCH_ALL_LIMIT};
use super::{
    Attached, ChatError, ChatService, Draft, EditDraft, HistoryQuery, Merged, Message, MessageKind,
    Posted, Quote,
};
use crate::account::model::{FilePurpose, StoredFile, User};
use crate::account::store::FileStore;
use crate::account::{AccountService, Limits as AccountLimits, Registration};
use crate::blob::ByteStream;
use crate::clock::Clock;
use crate::contact::ContactService;
use crate::file::{FileError, FileService, ORPHAN_AFTER_MS};
use crate::ids::{ConversationId, FileId, UserId};
use crate::limits::{
    EDIT_WINDOW_SECONDS_SETTING, FILE_MAX_BYTES_DEFAULT, FILE_MAX_BYTES_SETTING, Limits,
    RECALL_WINDOW_SECONDS_SETTING, VOICE_MAX_SECONDS_SETTING,
};
use crate::settings::SettingsStore;
use crate::testing::{
    ManualClock, MemoryStore, account_service, byte_stream, chat_service, contact_service,
    fake_image, file_service,
};

const WEBM: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4];

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    accounts: AccountService,
    contacts: ContactService,
    chat: ChatService,
    files: FileService,
    counter: AtomicU32,
}

async fn fixture() -> Fixture {
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let limits = AccountLimits {
        logins_per_minute: 1000,
        registrations_per_minute: 1000,
    };
    Fixture {
        accounts: account_service(&store, clock.clone(), limits).await,
        contacts: contact_service(&store, clock.clone()),
        chat: chat_service(&store, clock.clone()),
        files: file_service(&store, clock.clone()),
        store,
        clock,
        counter: AtomicU32::new(0),
    }
}

impl Fixture {
    fn next(&self) -> u32 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }

    async fn user(&self, nickname: &str) -> User {
        let code = format!("CODE{:012}", self.next());
        self.store.add_invite_code(&code, UserId::new());
        let registration = Registration {
            invite_code: &code,
            nickname,
            password: "correct-horse-1",
            user_agent: "test",
            source: "10.0.0.1",
        };
        self.accounts.register(registration).await.unwrap().user
    }

    async fn befriend(&self, a: &User, b: &User) -> ConversationId {
        let sent = self.contacts.send_request(a, b.id, "").await.unwrap();
        let request = sent.request.id;
        self.contacts.accept_request(b, request).await.unwrap();
        let opened = self.chat.open_direct(a, b.id).await.unwrap();
        opened.conversation.id
    }

    /// 两个好友和他们的单聊。
    async fn pair(&self) -> (User, User, ConversationId) {
        let (a, b) = (self.user("小明").await, self.user("小红").await);
        let conversation = self.befriend(&a, &b).await;
        (a, b, conversation)
    }

    /// 群主、两个成员和他们的群。
    async fn trio(&self) -> (User, User, User, ConversationId) {
        let owner = self.user("群主").await;
        let (b, c) = (self.user("成员1").await, self.user("成员2").await);
        self.befriend(&owner, &b).await;
        self.befriend(&owner, &c).await;
        let created = self.chat.create_group(&owner, "", &[b.id, c.id]).await;
        (owner, b, c, created.unwrap().message.conversation)
    }

    async fn upload(&self, me: &User, name: &str, kind: &str, content: &[u8]) -> StoredFile {
        self.files
            .upload(me, name, kind, byte_stream(content, 3))
            .await
            .unwrap()
    }

    async fn say(&self, from: &User, conversation: ConversationId, text: &str) -> Message {
        let client_id = format!("c-{}", self.next());
        let sent = self.chat.send_text(from, conversation, &client_id, text);
        sent.await.unwrap().message
    }

    async fn attach(
        &self,
        from: &User,
        conversation: ConversationId,
        file: FileId,
        voice_duration_ms: Option<i64>,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("c-{}", self.next());
        let draft = Draft {
            attachment: Some(Attached {
                file,
                voice_duration_ms,
            }),
            ..Draft::text(&client_id, "")
        };
        self.chat.send(from, conversation, draft).await
    }

    async fn reply(
        &self,
        from: &User,
        conversation: ConversationId,
        to: i64,
        text: &str,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("c-{}", self.next());
        let draft = Draft {
            reply_to: Some(to),
            ..Draft::text(&client_id, text)
        };
        self.chat.send(from, conversation, draft).await
    }

    /// 发一个上传好的文件，可以带文字说明、@、引用。
    async fn send_file(
        &self,
        from: &User,
        conversation: ConversationId,
        file: FileId,
        voice_duration_ms: Option<i64>,
        extra: Captioned,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("c-{}", self.next());
        let draft = Draft {
            mentions: &extra.mentions,
            attachment: Some(Attached {
                file,
                voice_duration_ms,
            }),
            reply_to: extra.reply_to,
            ..Draft::text(&client_id, extra.text)
        };
        self.chat.send(from, conversation, draft).await
    }

    /// 会话列表里最新的那个群里，有没有 @ 我的消息我还没看。
    async fn mentioned(&self, me: &User) -> bool {
        let listed = self.chat.list(me).await.unwrap();
        listed[0].group.as_ref().unwrap().mentioned
    }

    async fn history(&self, me: &User, conversation: ConversationId) -> super::Page {
        let query = HistoryQuery::default();
        self.chat.history(me, conversation, query).await.unwrap()
    }

    async fn set(&self, key: &str, value: &str) {
        SettingsStore::set(self.store.as_ref(), key, value)
            .await
            .unwrap();
    }

    async fn hits(&self, me: &User, query: &str) -> Vec<String> {
        let found = self.chat.search(me, query, None, None, None).await.unwrap();
        found
            .hits
            .iter()
            .map(|hit| match hit.file {
                Some(file) => found.extras.files[&file].name.clone().unwrap(),
                None => hit.text.clone().unwrap(),
            })
            .collect()
    }
}

/// 随文件一起发的东西。
struct Captioned {
    text: &'static str,
    mentions: Vec<UserId>,
    reply_to: Option<i64>,
}

impl Captioned {
    fn new(text: &'static str) -> Self {
        Self {
            text,
            mentions: Vec::new(),
            reply_to: None,
        }
    }
}

async fn collect(mut stream: ByteStream) -> Vec<u8> {
    let mut content = Vec::new();
    while let Some(chunk) = stream.next().await {
        content.extend_from_slice(&chunk.unwrap());
    }
    content
}

// ---------- 上传 ----------

#[tokio::test]
async fn an_upload_is_stored_under_a_cleaned_name_and_only_its_uploader_can_read_it() {
    let f = fixture().await;
    let (a, b, _) = f.pair().await;

    let file = f
        .upload(&a, "../报告\n.pdf", "application/pdf", b"%PDF-1.7 hello")
        .await;

    assert_eq!(file.name.as_deref(), Some("报告.pdf"));
    assert_eq!(file.size, 14);
    // 不是图片也不是音频：交回去时一律当作不认识的类型
    assert_eq!(file.content_type, "application/octet-stream");
    assert!(!file.is_image() && !file.is_audio());
    // 路径里没有用户给的任何东西
    assert!(!file.storage_key.contains("报告"));

    let opened = f.files.open(&a, file.id).await.unwrap();
    let content = collect(f.files.content(&opened, None).await.unwrap()).await;
    assert_eq!(content, b"%PDF-1.7 hello");
    let part = collect(f.files.content(&opened, Some(1..4)).await.unwrap()).await;
    assert_eq!(part, b"PDF");
    // 还没有发出去：别人拿到编号也读不到
    let err = f.files.open(&b, file.id).await.unwrap_err();
    assert!(matches!(err, FileError::NotFound));
    let err = f.files.open(&a, FileId::new()).await.unwrap_err();
    assert!(matches!(err, FileError::NotFound));
}

#[tokio::test]
async fn an_upload_over_the_limit_is_refused_and_leaves_nothing_behind() {
    let f = fixture().await;
    let a = f.user("小明").await;
    assert_eq!(
        f.files.limits().await.unwrap().file_max_bytes,
        FILE_MAX_BYTES_DEFAULT
    );
    f.set(FILE_MAX_BYTES_SETTING, "10").await;

    let upload = f.files.upload(&a, "big.bin", "", byte_stream(&[7; 11], 4));
    let err = upload.await.unwrap_err();
    assert!(matches!(err, FileError::TooLarge { max_bytes: 10 }));
    // 正好等于上限的可以
    let file = f.upload(&a, "ok.bin", "", &[7; 10]).await;
    assert_eq!(file.size, 10);

    let empty = f.files.upload(&a, "empty", "", byte_stream(&[], 4));
    assert!(matches!(empty.await.unwrap_err(), FileError::Empty));
    // 传到一半断了
    let broken: ByteStream = Box::pin(futures_util::stream::iter([
        Ok(bytes::Bytes::from_static(b"half")),
        Err(std::io::Error::other("connection reset")),
    ]));
    let err = f.files.upload(&a, "half", "", broken).await.unwrap_err();
    assert!(matches!(err, FileError::Interrupted));

    // 三次失败的上传什么也没有留下
    let orphans = f.clock.now_ms() + 1;
    let left = FileStore::list_orphans(f.store.as_ref(), orphans);
    assert_eq!(left.await.unwrap().len(), 1);
}

#[tokio::test]
async fn what_a_file_is_depends_on_its_content() {
    let f = fixture().await;
    let a = f.user("小明").await;

    // 图片：记下宽高，有缩略图
    let image = f.upload(&a, "photo.png", "image/png", &fake_image()).await;
    assert!(image.is_image());
    assert_eq!((image.width, image.height), (Some(640), Some(480)));
    assert_eq!(image.content_type, "image/png");
    assert_eq!(f.files.thumbnail(&image).await.unwrap(), b"THUMB");

    // 开头像图片、内容却解不出来：普通文件
    let broken = f
        .upload(&a, "fake.png", "image/png", b"\x89PNG\r\n\x1a\nnope")
        .await;
    assert!(!broken.is_image());
    assert!(matches!(
        f.files.thumbnail(&broken).await.unwrap_err(),
        FileError::NotFound
    ));
    // 说是图片，内容是网页：普通文件
    let html = f
        .upload(&a, "page.png", "image/png", b"<html><script>")
        .await;
    assert_eq!(html.content_type, "application/octet-stream");

    // 录音：内容和浏览器报的类型都对才算
    let voice = f
        .upload(&a, "voice.webm", "audio/webm;codecs=opus", WEBM)
        .await;
    assert!(voice.is_audio());
    assert_eq!(voice.content_type, "audio/webm");
    let video = f.upload(&a, "clip.webm", "video/webm", WEBM).await;
    assert!(!video.is_audio());
}

// ---------- 带文件的消息 ----------

#[tokio::test]
async fn an_attachment_becomes_an_image_a_file_or_a_voice_message() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let image = f.upload(&a, "photo.png", "image/png", &fake_image()).await;
    let document = f.upload(&a, "notes.txt", "text/plain", b"hello").await;
    let voice = f.upload(&a, "voice.webm", "audio/webm", WEBM).await;

    let sent = f.attach(&a, conversation, image.id, None).await.unwrap();
    assert_eq!(sent.message.kind, MessageKind::Image);
    assert_eq!(
        (sent.message.text.as_deref(), sent.message.file),
        (None, Some(image.id))
    );
    assert_eq!(
        sent.extras.files[&image.id].name.as_deref(),
        Some("photo.png")
    );
    let sent = f.attach(&a, conversation, document.id, None).await.unwrap();
    assert_eq!(sent.message.kind, MessageKind::File);
    let sent = f
        .attach(&a, conversation, voice.id, Some(3200))
        .await
        .unwrap();
    assert_eq!(sent.message.kind, MessageKind::Voice);
    assert_eq!(sent.message.data.duration_ms, Some(3200));

    // 对方翻历史时，文件的信息一并带上
    let page = f.history(&b, conversation).await;
    let kinds: Vec<MessageKind> = page.messages.iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        [MessageKind::Image, MessageKind::File, MessageKind::Voice]
    );
    assert_eq!(page.extras.files.len(), 3);
    // 会话列表里最新一条所附的文件
    let listed = f.chat.list(&b).await.unwrap();
    assert_eq!(
        listed[0].last_file.as_ref().map(|file| file.id),
        Some(voice.id)
    );
    assert_eq!(listed[0].unread, 3);
}

#[tokio::test]
async fn an_image_can_carry_a_caption_but_files_and_voice_cannot() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let image = f.upload(&a, "photo.png", "image/png", &fake_image()).await;
    let document = f.upload(&a, "notes.txt", "text/plain", b"hello").await;
    let voice = f.upload(&a, "voice.webm", "audio/webm", WEBM).await;

    let caption = Captioned::new("  海边的日落\n");
    let sent = f.send_file(&a, conversation, image.id, None, caption).await;
    let sent = sent.unwrap();
    assert_eq!(sent.message.kind, MessageKind::Image);
    assert_eq!(sent.message.text.as_deref(), Some("海边的日落"));
    // 只有空白的说明等于没有说明
    let bare = f.upload(&a, "bare.png", "image/png", &fake_image()).await;
    let sent = f
        .send_file(&a, conversation, bare.id, None, Captioned::new("  "))
        .await;
    assert_eq!(sent.unwrap().message.text, None);

    for (file, duration) in [(document.id, None), (voice.id, Some(1000))] {
        let sent = f
            .send_file(&a, conversation, file, duration, Captioned::new("看看"))
            .await;
        assert!(matches!(sent.unwrap_err(), ChatError::Invalid(_)));
    }

    // 对方看到的是同一条消息；说明能被搜到
    let page = f.history(&b, conversation).await;
    assert_eq!(page.messages[0].text.as_deref(), Some("海边的日落"));
    assert_eq!(f.hits(&b, "日落").await, ["photo.png"]);
}

#[tokio::test]
async fn a_caption_can_mention_group_members() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let image = f
        .upload(&owner, "photo.png", "image/png", &fake_image())
        .await;

    let caption = Captioned {
        mentions: vec![b.id],
        ..Captioned::new("@成员1 看这张")
    };
    let sent = f.send_file(&owner, group, image.id, None, caption).await;
    assert_eq!(sent.unwrap().message.data.mentions, [b.id]);
    assert!(f.mentioned(&b).await);
    assert!(!f.mentioned(&c).await);

    // 没有说明的图片不带 @
    let plain = f
        .upload(&owner, "plain.png", "image/png", &fake_image())
        .await;
    let caption = Captioned {
        mentions: vec![c.id],
        ..Captioned::new("")
    };
    let sent = f.send_file(&owner, group, plain.id, None, caption).await;
    assert!(sent.unwrap().message.data.mentions.is_empty());
    assert!(!f.mentioned(&c).await);
}

#[tokio::test]
async fn images_files_and_voice_messages_can_reply_too() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let question = f.say(&b, conversation, "照片发我一下").await;
    let image = f.upload(&a, "photo.png", "image/png", &fake_image()).await;
    let document = f.upload(&a, "notes.txt", "text/plain", b"hello").await;
    let voice = f.upload(&a, "voice.webm", "audio/webm", WEBM).await;

    for (file, duration) in [(image.id, None), (document.id, None), (voice.id, Some(900))] {
        let caption = Captioned {
            reply_to: Some(question.seq),
            ..Captioned::new("")
        };
        let sent = f.send_file(&a, conversation, file, duration, caption).await;
        let sent = sent.unwrap();
        assert_eq!(sent.message.reply_to, Some(question.seq));
        assert!(matches!(
            &sent.extras.quotes[&question.seq],
            Quote::Shown { text: Some(text), .. } if text == "照片发我一下"
        ));
    }

    // 引用一张带说明的图片：摘要里是说明
    let sea = f.upload(&b, "sea.png", "image/png", &fake_image()).await;
    let sent = f
        .send_file(&b, conversation, sea.id, None, Captioned::new("海边"))
        .await;
    let photo = sent.unwrap().message;
    let reply = f
        .reply(&a, conversation, photo.seq, "真好看")
        .await
        .unwrap();
    assert!(matches!(
        &reply.extras.quotes[&photo.seq],
        Quote::Shown { kind: MessageKind::Image, text: Some(text), .. } if text == "海边"
    ));
}

#[tokio::test]
async fn a_file_can_only_be_sent_once_by_the_one_who_uploaded_it() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let file = f.upload(&a, "notes.txt", "", b"hello").await;
    let unavailable = |result: Result<Posted, ChatError>| {
        assert!(matches!(result.unwrap_err(), ChatError::FileUnavailable));
    };

    // 别人上传的、不存在的、头像，都不能拿来发
    unavailable(f.attach(&b, conversation, file.id, None).await);
    unavailable(f.attach(&a, conversation, FileId::new(), None).await);
    let avatar = FileId::new();
    let stored = StoredFile {
        id: avatar,
        purpose: FilePurpose::Avatar,
        ..file.clone()
    };
    FileStore::create(f.store.as_ref(), &stored).await.unwrap();
    unavailable(f.attach(&a, conversation, avatar, None).await);

    // 重发（同一个客户端消息编号）交还第一次写入的那一条，不算"用了两次"
    let draft = Draft {
        attachment: Some(Attached {
            file: file.id,
            voice_duration_ms: None,
        }),
        ..Draft::text("same-id", "")
    };
    let first = f.chat.send(&a, conversation, draft).await.unwrap();
    let again = f.chat.send(&a, conversation, draft).await.unwrap();
    assert!(!first.duplicate && again.duplicate);
    assert_eq!(again.message, first.message);
    assert_eq!(again.extras.files.len(), 1);
    // 换一个编号再发同一个文件：不行
    unavailable(f.attach(&a, conversation, file.id, None).await);
    assert_eq!(f.history(&a, conversation).await.messages.len(), 1);
}

#[tokio::test]
async fn a_voice_message_must_be_audio_within_the_time_limit() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let mut voices = Vec::new();
    for _ in 0..4 {
        voices.push(f.upload(&a, "voice.webm", "audio/webm", WEBM).await.id);
    }
    let document = f.upload(&a, "notes.txt", "", b"hello").await;

    // 不是音频的文件不能当语音发
    let err = f.attach(&a, conversation, document.id, Some(1000)).await;
    assert!(matches!(err.unwrap_err(), ChatError::FileUnavailable));
    let err = f.attach(&a, conversation, voices[0], Some(0)).await;
    assert!(matches!(err.unwrap_err(), ChatError::Invalid(_)));
    // 默认最长 60 秒。时长是客户端量的，允许差一点
    let err = f.attach(&a, conversation, voices[0], Some(61_500)).await;
    assert!(matches!(
        err.unwrap_err(),
        ChatError::VoiceTooLong { max_seconds: 60 }
    ));
    f.attach(&a, conversation, voices[0], Some(60_400))
        .await
        .unwrap();

    // 管理员改了上限
    f.set(VOICE_MAX_SECONDS_SETTING, "10").await;
    let err = f.attach(&a, conversation, voices[1], Some(30_000)).await;
    assert!(matches!(
        err.unwrap_err(),
        ChatError::VoiceTooLong { max_seconds: 10 }
    ));
    f.attach(&a, conversation, voices[1], Some(9_000))
        .await
        .unwrap();
    // 一段录音不带时长：当作普通文件发
    let sent = f.attach(&a, conversation, voices[2], None).await.unwrap();
    assert_eq!(sent.message.kind, MessageKind::File);
}

#[tokio::test]
async fn a_file_can_be_read_by_exactly_those_who_can_see_its_message() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let outsider = f.user("路人").await;
    let newcomer = f.user("新人").await;
    f.befriend(&owner, &newcomer).await;
    let file = f.upload(&owner, "plan.pdf", "", b"secret plan").await;

    let sent = f.attach(&owner, group, file.id, None).await.unwrap();
    f.chat.invite(&owner, group, &[newcomer.id]).await.unwrap();

    for member in [&owner, &b, &c] {
        f.files.open(member, file.id).await.unwrap();
    }
    // 不在群里的人、在这条消息之后才入群的人，都读不到
    for stranger in [&outsider, &newcomer] {
        let err = f.files.open(stranger, file.id).await.unwrap_err();
        assert!(matches!(err, FileError::NotFound));
    }
    // 离开群的人还能看离开之前的
    f.chat.leave(&b, group).await.unwrap();
    f.files.open(&b, file.id).await.unwrap();

    // 撤回之后谁都读不到，包括发的人
    f.chat
        .recall(&owner, group, sent.message.seq)
        .await
        .unwrap();
    for member in [&owner, &b, &c] {
        let err = f.files.open(member, file.id).await.unwrap_err();
        assert!(matches!(err, FileError::NotFound));
    }
}

#[tokio::test]
async fn files_that_were_never_sent_are_swept_after_a_day() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let abandoned = f.upload(&a, "old.png", "image/png", &fake_image()).await;
    let sent = f.upload(&a, "sent.txt", "", b"kept").await;
    f.attach(&a, conversation, sent.id, None).await.unwrap();

    // 不到一天：都还在
    f.clock.advance(ORPHAN_AFTER_MS - 1000);
    assert_eq!(f.files.sweep().await.unwrap(), 0);
    let recent = f.upload(&a, "new.txt", "", b"fresh").await;

    f.clock.advance(2000);
    assert_eq!(f.files.sweep().await.unwrap(), 1);
    let err = f.files.open(&a, abandoned.id).await.unwrap_err();
    assert!(matches!(err, FileError::NotFound));
    // 内容和缩略图都删掉了
    let blobs = crate::blob::BlobStore::get(f.store.as_ref(), &abandoned.storage_key);
    assert_eq!(blobs.await.unwrap(), None);
    let thumbnail = abandoned.thumbnail_key.unwrap();
    let blobs = crate::blob::BlobStore::get(f.store.as_ref(), &thumbnail);
    assert_eq!(blobs.await.unwrap(), None);
    // 发出去了的、刚上传的，不受影响
    f.files.open(&a, sent.id).await.unwrap();
    f.files.open(&a, recent.id).await.unwrap();
    assert_eq!(f.files.sweep().await.unwrap(), 0);
}

// ---------- 引用 ----------

#[tokio::test]
async fn a_reply_shows_who_said_what_it_quotes() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let long = "长".repeat(QUOTE_MAX_CHARS + 50);
    let original = f.say(&a, conversation, &long).await;
    let file = f.upload(&a, "plan.pdf", "", b"plan").await;
    let attached = f.attach(&a, conversation, file.id, None).await.unwrap();

    let reply = f
        .reply(&b, conversation, original.seq, "好的")
        .await
        .unwrap();
    assert_eq!(reply.message.reply_to, Some(original.seq));
    assert!(reply.quote_hidden_from.is_empty());
    let Quote::Shown {
        sender,
        sender_name,
        kind,
        text,
        ..
    } = &reply.extras.quotes[&original.seq]
    else {
        panic!("the quote should be shown");
    };
    assert_eq!(
        (*sender, sender_name.as_deref()),
        (Some(a.id), Some("小明"))
    );
    assert_eq!(*kind, MessageKind::Text);
    // 摘要只带开头的一段
    assert_eq!(text.as_ref().unwrap().chars().count(), QUOTE_MAX_CHARS);

    // 引用一条文件消息：摘要是文件名
    let seq = attached.message.seq;
    f.reply(&b, conversation, seq, "收到").await.unwrap();
    let page = f.history(&a, conversation).await;
    let Quote::Shown {
        kind, file_name, ..
    } = &page.extras.quotes[&seq]
    else {
        panic!("the quote should be shown");
    };
    assert_eq!(
        (*kind, file_name.as_deref()),
        (MessageKind::File, Some("plan.pdf"))
    );
}

#[tokio::test]
async fn only_a_visible_live_message_can_be_quoted() {
    let f = fixture().await;
    let (owner, b, _, group) = f.trio().await;
    let newcomer = f.user("新人").await;
    f.befriend(&owner, &newcomer).await;
    let before = f.say(&owner, group, "入群之前").await;
    f.chat.invite(&owner, group, &[newcomer.id]).await.unwrap();
    let recalled = f.say(&owner, group, "说错了").await;
    f.chat.recall(&owner, group, recalled.seq).await.unwrap();
    let unavailable = |result: Result<Posted, ChatError>| {
        assert!(matches!(result.unwrap_err(), ChatError::QuoteUnavailable));
    };

    // 系统提示（第 1 条是建群）、已撤回的、不存在的，都不能引用
    unavailable(f.reply(&b, group, 1, "?").await);
    unavailable(f.reply(&b, group, recalled.seq, "?").await);
    unavailable(f.reply(&b, group, 999, "?").await);
    // 自己看不到的也不能引用
    unavailable(f.reply(&newcomer, group, before.seq, "?").await);

    // 老成员引用入群之前的消息：新人拿到的那一份不带内容
    let reply = f.reply(&b, group, before.seq, "同意").await.unwrap();
    assert_eq!(reply.quote_hidden_from, [newcomer.id]);
    assert!(matches!(
        reply.extras.quotes[&before.seq],
        Quote::Shown { .. }
    ));
    let hidden = reply.extras.without_quotes();
    assert_eq!(hidden.quotes[&before.seq], Quote::Unavailable);
    // 之后翻历史也一样
    let page = f.history(&newcomer, group).await;
    assert_eq!(page.extras.quotes[&before.seq], Quote::Unavailable);
    let page = f.history(&owner, group).await;
    assert!(matches!(
        page.extras.quotes[&before.seq],
        Quote::Shown { .. }
    ));
}

// ---------- 撤回 ----------

#[tokio::test]
async fn a_recalled_message_loses_its_content_for_everyone() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let first = f.say(&a, conversation, "第一条").await;
    let wrong = f.say(&a, conversation, "说错了").await;
    let reply = f
        .reply(&b, conversation, wrong.seq, "什么？")
        .await
        .unwrap();
    assert_eq!(f.chat.list(&b).await.unwrap()[0].unread, 2);

    let recalled = f.chat.recall(&a, conversation, wrong.seq).await.unwrap();

    // 撤回是会话里的一条事件，带着被撤回的那条的序号，通知到双方
    assert_eq!(recalled.message.kind, MessageKind::Recalled);
    assert_eq!(recalled.message.seq, reply.message.seq + 1);
    assert_eq!(recalled.message.data.seq, Some(wrong.seq));
    assert_eq!(recalled.message.data.actor.as_ref().unwrap().id, a.id);
    assert_eq!(recalled.members.len(), 2);

    for viewer in [&a, &b] {
        let page = f.history(viewer, conversation).await;
        let gone = &page.messages[wrong.seq as usize - first.seq as usize];
        assert_eq!(gone.seq, wrong.seq);
        assert!(gone.is_recalled());
        // 谁发的还知道，说了什么不知道了
        assert_eq!((gone.sender, gone.text.as_deref()), (Some(a.id), None));
        // 引用它的回复：原消息已撤回
        assert_eq!(page.extras.quotes[&wrong.seq], Quote::Recalled);
    }
    // 对方还没读的那一条不再算未读；撤回事件本身也不算
    let listed = f.chat.list(&b).await.unwrap();
    assert_eq!(listed[0].unread, 1);
    assert_eq!(
        listed[0].last_message.as_ref().unwrap().kind,
        MessageKind::Recalled
    );
}

#[tokio::test]
async fn only_my_own_recent_messages_can_be_recalled_and_only_once() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let mine = f.say(&a, conversation, "我的").await;
    let theirs = f.say(&b, conversation, "对方的").await;
    let not_allowed = |result: Result<Posted, ChatError>| {
        assert!(matches!(result.unwrap_err(), ChatError::RecallNotAllowed));
    };

    not_allowed(f.chat.recall(&a, conversation, theirs.seq).await);
    let missing = f.chat.recall(&a, conversation, 999).await.unwrap_err();
    assert!(matches!(missing, ChatError::MessageNotFound));
    let stranger = f.user("路人").await;
    let err = f.chat.recall(&stranger, conversation, mine.seq).await;
    assert!(matches!(err.unwrap_err(), ChatError::ConversationNotFound));

    f.chat.recall(&a, conversation, mine.seq).await.unwrap();
    not_allowed(f.chat.recall(&a, conversation, mine.seq).await);
    // 撤回事件本身不是消息，不能撤回
    not_allowed(f.chat.recall(&a, conversation, theirs.seq + 1).await);
}

#[tokio::test]
async fn recalling_is_only_possible_within_the_time_window() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    let on_time = f.say(&a, conversation, "来得及").await;
    let too_late = f.say(&a, conversation, "来不及").await;

    // 默认 2 分钟
    f.clock.advance(120_000);
    f.chat.recall(&a, conversation, on_time.seq).await.unwrap();
    f.clock.advance(1);
    let err = f.chat.recall(&a, conversation, too_late.seq).await;
    assert!(matches!(err.unwrap_err(), ChatError::RecallTooLate));

    // 管理员把时限改长了
    f.set(RECALL_WINDOW_SECONDS_SETTING, "600").await;
    f.chat.recall(&a, conversation, too_late.seq).await.unwrap();
    let expected = Limits {
        file_max_bytes: FILE_MAX_BYTES_DEFAULT,
        voice_max_seconds: 60,
        recall_window_seconds: 600,
        edit_window_seconds: 24 * 60 * 60,
    };
    assert_eq!(f.chat.limits().await.unwrap(), expected);
}

#[tokio::test]
async fn someone_who_left_can_still_recall_what_they_just_said() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let said = f.say(&b, group, "发错群了").await;
    f.chat.leave(&b, group).await.unwrap();

    let recalled = f.chat.recall(&b, group, said.seq).await.unwrap();

    // 还在群里的人和他自己都被通知
    let mut notified = recalled.members.clone();
    notified.sort();
    let mut expected = vec![owner.id, b.id, c.id];
    expected.sort();
    assert_eq!(notified, expected);
    let page = f.history(&owner, group).await;
    let gone = page.messages.iter().find(|m| m.seq == said.seq).unwrap();
    assert!(gone.is_recalled());
    // 离开之后说的话他看不到，自然也撤回不了
    let later = f.say(&owner, group, "之后的").await;
    let err = f.chat.recall(&b, group, later.seq).await.unwrap_err();
    assert!(matches!(err, ChatError::MessageNotFound));
}

// ---------- 语音：听过没有 ----------

#[tokio::test]
async fn each_listener_keeps_their_own_record_of_played_voice_messages() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let voice = f.upload(&owner, "voice.webm", "audio/webm", WEBM).await;
    let sent = f.attach(&owner, group, voice.id, Some(2000)).await.unwrap();
    let seq = sent.message.seq;
    let text = f.say(&owner, group, "文字").await;

    let played = f.chat.mark_played(&b, group, seq).await.unwrap();
    assert!(played.changed);
    // 再听一遍不算新的
    assert!(!f.chat.mark_played(&b, group, seq).await.unwrap().changed);
    // 自己发的没有"听过没有"
    assert!(
        !f.chat
            .mark_played(&owner, group, seq)
            .await
            .unwrap()
            .changed
    );

    assert!(
        f.history(&b, group)
            .await
            .extras
            .played
            .contains(&sent.message.id)
    );
    assert!(f.history(&c, group).await.extras.played.is_empty());
    assert!(f.history(&owner, group).await.extras.played.is_empty());

    // 只有语音消息能标记
    let err = f.chat.mark_played(&b, group, text.seq).await.unwrap_err();
    assert!(matches!(err, ChatError::MessageNotFound));
    let err = f.chat.mark_played(&b, group, 999).await.unwrap_err();
    assert!(matches!(err, ChatError::MessageNotFound));
}

// ---------- 搜索 ----------

#[tokio::test]
async fn search_finds_text_and_file_names_across_my_conversations() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let direct = f
        .chat
        .open_direct(&owner, b.id)
        .await
        .unwrap()
        .conversation
        .id;
    f.say(&owner, group, "周六去 Hiking 吗").await;
    f.clock.advance(1000);
    let file = f.upload(&b, "hiking-路线.pdf", "", b"map").await;
    f.attach(&b, direct, file.id, None).await.unwrap();
    f.clock.advance(1000);
    f.say(&b, direct, "HIKING 的装备").await;
    f.say(&owner, group, "别的话题").await;
    let image = f
        .upload(&owner, "hiking.png", "image/png", &fake_image())
        .await;
    f.attach(&owner, group, image.id, None).await.unwrap();

    // 从新到旧；英文不区分大小写；图片的文件名不在搜索范围里
    let expected = ["HIKING 的装备", "hiking-路线.pdf", "周六去 Hiking 吗"];
    assert_eq!(f.hits(&owner, "hiking").await, expected);
    assert_eq!(f.hits(&owner, "  路线 ").await, ["hiking-路线.pdf"]);
    // 单聊是另外两个人的：第三个人只搜得到群里的
    assert_eq!(f.hits(&c, "hiking").await, ["周六去 Hiking 吗"]);
    assert!(f.hits(&c, "没有这个词").await.is_empty());

    let found = f.chat.search(&owner, "hiking", None, None, None).await;
    let found = found.unwrap();
    assert!(!found.has_more);
    assert_eq!(found.sender_names[&b.id], "成员1");
    assert!(found.hits.len() < SEARCH_ALL_LIMIT);
}

#[tokio::test]
async fn search_only_returns_what_i_can_see_and_what_was_not_recalled() {
    let f = fixture().await;
    let (owner, b, _, group) = f.trio().await;
    let newcomer = f.user("新人").await;
    f.befriend(&owner, &newcomer).await;
    f.say(&owner, group, "密码是 1234").await;
    f.chat.invite(&owner, group, &[newcomer.id]).await.unwrap();
    let wrong = f.say(&owner, group, "密码改成 5678").await;
    f.say(&b, group, "密码收到").await;

    // 后来入群的人搜不到入群之前的
    assert_eq!(
        f.hits(&newcomer, "密码").await,
        ["密码收到", "密码改成 5678"]
    );
    assert_eq!(f.hits(&owner, "密码").await.len(), 3);
    // 撤回了的搜不到
    f.chat.recall(&owner, group, wrong.seq).await.unwrap();
    assert_eq!(f.hits(&newcomer, "密码").await, ["密码收到"]);

    // 离开群的人只搜得到离开之前的
    f.chat.leave(&b, group).await.unwrap();
    f.say(&owner, group, "密码又改了").await;
    assert_eq!(f.hits(&b, "密码").await, ["密码收到", "密码是 1234"]);
    // 系统提示不在搜索范围里：成员的名字搜不到"邀请入群"那一条
    assert!(f.hits(&owner, "新人").await.is_empty());
}

#[tokio::test]
async fn search_inside_one_conversation_pages_from_newest_to_oldest() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let other = f.user("小刚").await;
    let elsewhere = f.befriend(&a, &other).await;
    for n in 1..=5 {
        f.say(&a, conversation, &format!("进度 {n}")).await;
    }
    f.say(&a, elsewhere, "进度 另一个会话").await;

    let page = |before| {
        f.chat
            .search(&b, "进度", Some(conversation), before, Some(2))
    };
    let first = page(None).await.unwrap();
    let texts = |hits: &[Message]| -> Vec<String> {
        hits.iter().map(|hit| hit.text.clone().unwrap()).collect()
    };
    assert_eq!(texts(&first.hits), ["进度 5", "进度 4"]);
    assert!(first.has_more);
    let second = page(Some(first.hits[1].seq)).await.unwrap();
    assert_eq!(texts(&second.hits), ["进度 3", "进度 2"]);
    let last = page(Some(second.hits[1].seq)).await.unwrap();
    assert_eq!(texts(&last.hits), ["进度 1"]);
    assert!(!last.has_more);

    // 不是我的会话搜不了
    let err = f.chat.search(&b, "进度", Some(elsewhere), None, None).await;
    assert!(matches!(err.unwrap_err(), ChatError::ConversationNotFound));
}

#[tokio::test]
async fn search_takes_the_query_literally() {
    let f = fixture().await;
    let (a, _, conversation) = f.pair().await;
    f.say(&a, conversation, "完成了 100%").await;
    f.say(&a, conversation, "完成了 100 份").await;
    f.say(&a, conversation, "file_name").await;
    f.say(&a, conversation, "filename").await;

    assert_eq!(f.hits(&a, "100%").await, ["完成了 100%"]);
    assert_eq!(f.hits(&a, "e_n").await, ["file_name"]);
    for bad in ["", "   ", &"长".repeat(51)] {
        let err = f.chat.search(&a, bad, None, None, None).await.unwrap_err();
        assert!(matches!(err, ChatError::Invalid(_)));
    }
    let err = f
        .chat
        .search(&a, "x", Some(conversation), None, Some(0))
        .await;
    assert!(matches!(err.unwrap_err(), ChatError::Invalid(_)));
}

// ---------- 免打扰 ----------

#[tokio::test]
async fn muting_silences_one_conversation_for_me_alone() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    f.say(&b, conversation, "一").await;
    assert!(!f.chat.list(&a).await.unwrap()[0].muted);

    f.chat.mute(&a, conversation, true).await.unwrap();
    f.say(&b, conversation, "二").await;

    // 消息照常收，未读数照常算，只是多了一个标记
    let mine = &f.chat.list(&a).await.unwrap()[0];
    assert_eq!((mine.muted, mine.unread), (true, 2));
    assert!(f.chat.conversation(&a, conversation).await.unwrap().muted);
    // 只影响我自己
    assert!(!f.chat.list(&b).await.unwrap()[0].muted);

    f.chat.mute(&a, conversation, false).await.unwrap();
    assert!(!f.chat.list(&a).await.unwrap()[0].muted);
    // 不是我的会话设不了
    let stranger = f.user("路人").await;
    let err = f
        .chat
        .mute(&stranger, conversation, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
}

#[tokio::test]
async fn a_group_i_left_can_still_be_muted_or_unmuted() {
    let f = fixture().await;
    let (owner, b, _, group) = f.trio().await;
    f.chat.mute(&b, group, true).await.unwrap();
    f.chat.remove_member(&owner, group, b.id).await.unwrap();

    // 被移出之后会话还留在列表里，设置也还在，还可以改
    assert!(f.chat.conversation(&b, group).await.unwrap().muted);
    f.chat.mute(&b, group, false).await.unwrap();
    assert!(!f.chat.conversation(&b, group).await.unwrap().muted);
}

// ---------- 群公告 ----------

impl Fixture {
    /// 一个群在这个人那里的样子。
    async fn group_info(&self, me: &User, group: ConversationId) -> super::GroupInfo {
        let info = self.chat.conversation(me, group).await.unwrap();
        info.group.expect("it is a group")
    }
}

#[tokio::test]
async fn the_owner_publishes_a_notice_and_everyone_else_is_reminded() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;

    let posted = f
        .chat
        .set_notice(&owner, group, "  周五下午三点开会\n带上电脑  ")
        .await;
    let posted = posted.unwrap().expect("something changed");
    // 事件里带着全文和发布人
    assert_eq!(posted.message.kind, MessageKind::NoticeChanged);
    assert_eq!(
        posted.message.text.as_deref(),
        Some("周五下午三点开会\n带上电脑")
    );
    assert_eq!(
        posted.message.data.actor.as_ref().map(|p| p.id),
        Some(owner.id)
    );
    assert_eq!(posted.members.len(), 3);

    for member in [&b, &c] {
        let info = f.group_info(member, group).await;
        let notice = info.notice.expect("members see the notice");
        assert_eq!(notice.text, "周五下午三点开会\n带上电脑");
        assert_eq!(
            (notice.by, notice.by_name.as_deref()),
            (owner.id, Some("群主"))
        );
        assert_eq!(notice.seq, posted.message.seq);
        assert!(info.notice_unseen);
        // 提醒：和 @ 所有人一样
        assert!(info.mentioned);
    }
    // 发布的人自己算看过了，也不提醒自己
    let mine = f.group_info(&owner, group).await;
    assert!(!mine.notice_unseen && !mine.mentioned);
    // 事件不算未读
    assert_eq!(f.chat.conversation(&b, group).await.unwrap().unread, 0);
}

#[tokio::test]
async fn an_ordinary_member_cannot_change_the_notice() {
    let f = fixture().await;
    let (owner, b, _c, group) = f.trio().await;

    let err = f.chat.set_notice(&b, group, "我来写").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let outsider = f.user("路人").await;
    let err = f
        .chat
        .set_notice(&outsider, group, "我来写")
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
    let long = "字".repeat(super::service::NOTICE_MAX_CHARS + 1);
    let err = f.chat.set_notice(&owner, group, &long).await.unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
    let exact = "字".repeat(super::service::NOTICE_MAX_CHARS);
    assert!(
        f.chat
            .set_notice(&owner, group, &exact)
            .await
            .unwrap()
            .is_some()
    );

    f.chat.dissolve(&owner, group).await.unwrap();
    let err = f
        .chat
        .set_notice(&owner, group, "解散了还改")
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupDissolved));
}

#[tokio::test]
async fn the_same_notice_again_changes_nothing_and_clearing_does_not_remind() {
    let f = fixture().await;
    let (owner, b, _c, group) = f.trio().await;
    // 没有公告时清空：什么也不做
    assert!(
        f.chat
            .set_notice(&owner, group, "   ")
            .await
            .unwrap()
            .is_none()
    );

    f.chat.set_notice(&owner, group, "第一版").await.unwrap();
    let before = f.history(&b, group).await.messages.len();
    assert!(
        f.chat
            .set_notice(&owner, group, " 第一版 ")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(f.history(&b, group).await.messages.len(), before);

    // b 看过了这个群（读到了最新），然后群主清空公告
    let last = f.chat.conversation(&b, group).await.unwrap().last_seq;
    f.chat.mark_read(&b, group, last).await.unwrap();
    let cleared = f.chat.set_notice(&owner, group, "").await.unwrap().unwrap();
    assert_eq!(cleared.message.kind, MessageKind::NoticeChanged);
    assert_eq!(cleared.message.text, None);
    let info = f.group_info(&b, group).await;
    assert!(info.notice.is_none());
    assert!(!info.notice_unseen);
    assert!(!info.mentioned);
}

#[tokio::test]
async fn a_member_marks_the_notice_seen_and_newcomers_see_the_current_one() {
    let f = fixture().await;
    let (owner, b, _c, group) = f.trio().await;
    // 没有公告：没有什么可以看
    assert_eq!(f.chat.mark_notice_seen(&b, group).await.unwrap(), None);

    let posted = f
        .chat
        .set_notice(&owner, group, "群规")
        .await
        .unwrap()
        .unwrap();
    let seq = posted.message.seq;
    assert_eq!(f.chat.mark_notice_seen(&b, group).await.unwrap(), Some(seq));
    assert!(!f.group_info(&b, group).await.notice_unseen);
    // 再看一次：没有变化
    assert_eq!(f.chat.mark_notice_seen(&b, group).await.unwrap(), None);

    // 之后入群的人看得到当前的公告，算没看过
    let d = f.user("新人").await;
    f.befriend(&owner, &d).await;
    f.chat.invite(&owner, group, &[d.id]).await.unwrap();
    let info = f.group_info(&d, group).await;
    assert_eq!(info.notice.map(|n| n.text).as_deref(), Some("群规"));
    assert!(info.notice_unseen);

    // 修改之后又是没看过的
    f.chat
        .set_notice(&owner, group, "群规第二版")
        .await
        .unwrap();
    assert!(f.group_info(&b, group).await.notice_unseen);
}

#[tokio::test]
async fn someone_who_left_no_longer_sees_the_notice() {
    let f = fixture().await;
    let (owner, b, _c, group) = f.trio().await;
    f.chat.set_notice(&owner, group, "群规").await.unwrap();
    // 他看过了这个群里的提醒，然后被移出
    let last = f.chat.conversation(&b, group).await.unwrap().last_seq;
    f.chat.mark_read(&b, group, last).await.unwrap();

    f.chat.remove_member(&owner, group, b.id).await.unwrap();
    let info = f.group_info(&b, group).await;
    assert!(info.notice.is_none() && !info.notice_unseen);
    let err = f.chat.mark_notice_seen(&b, group).await.unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
    // 之后的改动也不会提醒他
    f.chat.set_notice(&owner, group, "第二版").await.unwrap();
    assert!(!f.group_info(&b, group).await.mentioned);
}

// ---------- 转发 ----------

impl Fixture {
    /// 把 `from` 会话里的第 `seq` 条转发到 `to`。
    async fn forward(
        &self,
        me: &User,
        to: ConversationId,
        from: ConversationId,
        seq: i64,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("f-{}", self.next());
        self.forward_as(me, to, from, seq, &client_id).await
    }

    async fn forward_as(
        &self,
        me: &User,
        to: ConversationId,
        from: ConversationId,
        seq: i64,
        client_id: &str,
    ) -> Result<Posted, ChatError> {
        let draft = Draft {
            forward: Some(super::Forwarded {
                conversation: from,
                seq,
            }),
            ..Draft::text(client_id, "")
        };
        self.chat.send(me, to, draft).await
    }
}

#[tokio::test]
async fn a_forward_copies_the_content_into_a_new_message_of_mine() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    // 群里的三条：一句带 @ 的话、一张带说明的图片、一个文件，其中一条还是回复
    let words = f.say(&b, group, "@群主 周末去爬山").await;
    let photo = f.upload(&c, "hill.png", "image/png", &fake_image()).await;
    let caption = Captioned {
        reply_to: Some(words.seq),
        ..Captioned::new("山顶的风景")
    };
    let photo = f
        .send_file(&c, group, photo.id, None, caption)
        .await
        .unwrap()
        .message;
    let map = f
        .upload(&b, "路线.pdf", "application/pdf", b"%PDF-1.7 map")
        .await;
    let map = f.attach(&b, group, map.id, None).await.unwrap().message;

    // 群主转发给另一位好友
    let dan = f.user("小丹").await;
    let direct = f.befriend(&owner, &dan).await;
    let mut forwarded = Vec::new();
    for seq in [words.seq, photo.seq, map.seq] {
        forwarded.push(f.forward(&owner, direct, group, seq).await.unwrap().message);
    }

    // 发送人是转发的人；内容一样；不带原来的引用和 @
    let kinds: Vec<(MessageKind, Option<&str>)> = forwarded
        .iter()
        .map(|m| (m.kind, m.text.as_deref()))
        .collect();
    assert_eq!(
        kinds,
        [
            (MessageKind::Text, Some("@群主 周末去爬山")),
            (MessageKind::Image, Some("山顶的风景")),
            (MessageKind::File, None),
        ]
    );
    for message in &forwarded {
        assert_eq!(message.sender, Some(owner.id));
        assert_eq!(message.reply_to, None);
        assert!(message.data.mentions.is_empty() && !message.data.mention_all);
    }
    // 文件是新登记的一个，和原文件共用同一份内容
    let original = FileStore::find(f.store.as_ref(), map.file.unwrap())
        .await
        .unwrap()
        .unwrap();
    let copy = FileStore::find(f.store.as_ref(), forwarded[2].file.unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_ne!(copy.id, original.id);
    assert_eq!(copy.storage_key, original.storage_key);
    assert_eq!(
        (copy.uploader, copy.name.as_deref()),
        (owner.id, Some("路线.pdf"))
    );
    // 收到的人读得到它；原来群里的人不在这个单聊里，读不到
    let opened = f.files.open(&dan, copy.id).await.unwrap();
    let content = collect(f.files.content(&opened, None).await.unwrap()).await;
    assert_eq!(content, b"%PDF-1.7 map");
    assert!(matches!(
        f.files.open(&b, copy.id).await.unwrap_err(),
        FileError::NotFound
    ));
    // 存储占用里共用的内容只算一次
    let (count, _) = FileStore::usage(f.store.as_ref()).await.unwrap();
    assert_eq!(count, 2);
}

#[tokio::test]
async fn voice_forwards_with_its_duration_but_recalled_messages_and_events_do_not() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;

    let voice = f.upload(&b, "voice.webm", "audio/webm", WEBM).await;
    let voice = f
        .attach(&b, conversation, voice.id, Some(1000))
        .await
        .unwrap()
        .message;
    // 语音：带着时长转发出去，文件是新登记的一个
    let copy = f
        .forward(&a, target, conversation, voice.seq)
        .await
        .unwrap()
        .message;
    assert_eq!(copy.kind, MessageKind::Voice);
    assert_eq!(copy.data.duration_ms, Some(1000));
    assert_ne!(copy.file, voice.file);
    assert!(f.files.open(&dan, copy.file.unwrap()).await.is_ok());

    let gone = f.say(&a, conversation, "说错了").await;
    f.chat.recall(&a, conversation, gone.seq).await.unwrap();
    let err = f
        .forward(&a, target, conversation, gone.seq)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::ForwardNotAllowed));
    // 系统提示：群里的第 1 条是"建群"
    let group = f.chat.create_group(&a, "", &[b.id, dan.id]).await.unwrap();
    let group = group.message.conversation;
    let err = f.forward(&a, target, group, 1).await.unwrap_err();
    assert!(matches!(err, ChatError::ForwardNotAllowed));
    // 不存在的序号；不是我的会话
    let err = f.forward(&a, target, conversation, 99).await.unwrap_err();
    assert!(matches!(err, ChatError::MessageNotFound));
    let (_, _, strangers) = f.pair().await;
    let err = f.forward(&a, target, strangers, 1).await.unwrap_err();
    assert!(matches!(err, ChatError::ConversationNotFound));
}

#[tokio::test]
async fn the_target_must_be_somewhere_i_can_send_and_a_resend_is_written_once() {
    let f = fixture().await;
    let (owner, b, _c, group) = f.trio().await;
    let note = f.upload(&owner, "note.txt", "text/plain", b"hello").await;
    let note = f
        .attach(&owner, group, note.id, None)
        .await
        .unwrap()
        .message;
    // 建群时就已经是好友了：用他们的单聊
    let direct = f
        .chat
        .open_direct(&owner, b.id)
        .await
        .unwrap()
        .conversation
        .id;

    // 同一个客户端消息编号重发：只有一条，也不会多登记一个文件
    let first = f
        .forward_as(&owner, direct, group, note.seq, "same")
        .await
        .unwrap();
    let files_before = FileStore::usage(f.store.as_ref()).await.unwrap();
    let again = f
        .forward_as(&owner, direct, group, note.seq, "same")
        .await
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.message.id, first.message.id);
    let all = f.history(&b, direct).await.messages;
    assert_eq!(
        all.iter().filter(|m| m.kind == MessageKind::File).count(),
        1
    );
    let rows = f.store.file_count();
    assert_eq!(
        FileStore::usage(f.store.as_ref()).await.unwrap(),
        files_before
    );
    assert_eq!(rows, 2);

    // 已经不是好友的单聊、已经离开的群：不能转发进去
    f.contacts.remove_friend(&owner, b.id).await.unwrap();
    let err = f
        .forward(&owner, direct, group, note.seq)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotFriends));
    f.chat.leave(&b, group).await.unwrap();
    let err = f.forward(&b, group, group, note.seq).await.unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
}

#[tokio::test]
async fn shared_content_is_kept_until_the_last_file_pointing_at_it_is_gone() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;
    let photo = f.upload(&b, "sea.png", "image/png", &fake_image()).await;
    let photo = f
        .attach(&b, conversation, photo.id, None)
        .await
        .unwrap()
        .message;
    let copy = f
        .forward(&a, target, conversation, photo.seq)
        .await
        .unwrap()
        .message;
    let (original, copy) = (photo.file.unwrap(), copy.file.unwrap());
    let stored = FileStore::find(f.store.as_ref(), copy)
        .await
        .unwrap()
        .unwrap();

    // 原消息撤回、原文件被清理掉：转发出去的照样能看
    f.chat.recall(&b, conversation, photo.seq).await.unwrap();
    assert_eq!(f.files.remove(&[original]).await.unwrap(), 1);
    let opened = f.files.open(&dan, copy).await.unwrap();
    assert!(
        !collect(f.files.content(&opened, None).await.unwrap())
            .await
            .is_empty()
    );
    assert_eq!(f.files.thumbnail(&stored).await.unwrap(), b"THUMB");

    // 最后一个也清理掉：内容才删
    assert_eq!(f.files.remove(&[copy]).await.unwrap(), 1);
    assert!(f.files.content(&stored, None).await.is_err());
    assert!(f.files.thumbnail(&stored).await.is_err());
}

// ---------- 合并转发 ----------

impl Fixture {
    /// 把一个会话里的几条合并转发到另一个会话。
    async fn merge(
        &self,
        me: &User,
        to: ConversationId,
        from: ConversationId,
        seqs: &[i64],
        title: &str,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("c-{}", self.next());
        self.merge_as(me, to, from, seqs, title, &client_id).await
    }

    async fn merge_as(
        &self,
        me: &User,
        to: ConversationId,
        from: ConversationId,
        seqs: &[i64],
        title: &str,
        client_id: &str,
    ) -> Result<Posted, ChatError> {
        let draft = Draft {
            merge: Some(Merged {
                conversation: from,
                seqs,
                title,
            }),
            ..Draft::text(client_id, "")
        };
        self.chat.send(me, to, draft).await
    }
}

#[tokio::test]
async fn a_merged_forward_keeps_a_snapshot_of_each_message_and_who_said_it() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let words = f.say(&b, group, "周末去爬山").await;
    let photo = f.upload(&c, "hill.png", "image/png", &fake_image()).await;
    let photo = f
        .send_file(&c, group, photo.id, None, Captioned::new("山顶的风景"))
        .await
        .unwrap()
        .message;
    let voice = f.upload(&b, "voice.webm", "audio/webm", WEBM).await;
    let voice = f
        .attach(&b, group, voice.id, Some(2000))
        .await
        .unwrap()
        .message;
    let map = f
        .upload(&owner, "路线.pdf", "application/pdf", b"%PDF-1.7 map")
        .await;
    let map = f.attach(&owner, group, map.id, None).await.unwrap().message;

    let dan = f.user("小丹").await;
    let direct = f.befriend(&owner, &dan).await;
    // 选的顺序不要紧，按原来的先后排
    let seqs = [map.seq, words.seq, voice.seq, photo.seq];
    let posted = f
        .merge(&owner, direct, group, &seqs, "  群聊的聊天记录 ")
        .await
        .unwrap();
    let record_message = posted.message;
    assert_eq!(record_message.kind, MessageKind::ChatRecord);
    assert_eq!(record_message.sender, Some(owner.id));
    let record = record_message.data.record.clone().unwrap();
    assert_eq!(record.title, "群聊的聊天记录");
    let items: Vec<(&str, MessageKind, Option<&str>, Option<i64>)> = record
        .items
        .iter()
        .map(|item| {
            (
                item.sender_name.as_str(),
                item.kind,
                item.text.as_deref(),
                item.duration_ms,
            )
        })
        .collect();
    assert_eq!(
        items,
        [
            ("成员1", MessageKind::Text, Some("周末去爬山"), None),
            ("成员2", MessageKind::Image, Some("山顶的风景"), None),
            ("成员1", MessageKind::Voice, None, Some(2000)),
            ("群主", MessageKind::File, None, None),
        ]
    );
    assert_eq!(record.items[0].sender, Some(b.id));
    assert_eq!(record.items[0].created_at, words.created_at);

    // 带文件的每一条都新登记了一个，和原文件共用内容；收到的人读得到，原来群里的人读不到
    let originals = [photo.file, voice.file, map.file];
    for (item, original) in record.items[1..].iter().zip(originals) {
        let copy = item.file.unwrap();
        assert_ne!(Some(copy), original);
        let stored = FileStore::find(f.store.as_ref(), copy)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.uploader, owner.id);
        f.files.open(&dan, copy).await.unwrap();
        let err = f.files.open(&c, copy).await.unwrap_err();
        assert!(matches!(err, FileError::NotFound));
    }
    // 交给客户端时，聊天记录里的文件也带上了
    for file in record.files() {
        assert!(posted.extras.files.contains_key(&file));
    }

    // 之后原消息撤回、原发送人改名：聊天记录不变
    f.chat.recall(&b, group, words.seq).await.unwrap();
    let renamed = crate::account::model::ProfileChanges {
        nickname: Some("改了名".to_owned()),
        ..Default::default()
    };
    crate::account::store::UserStore::update_profile(f.store.as_ref(), b.id, &renamed)
        .await
        .unwrap();
    let page = f.history(&dan, direct).await;
    let seen = page.messages.last().unwrap();
    assert_eq!(seen.data.record.as_ref(), Some(&record));
}

#[tokio::test]
async fn a_record_is_found_by_what_is_inside_it() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let words = f.say(&b, conversation, "明天交 Weekly Report").await;
    let file = f.upload(&a, "预算表.xlsx", "", b"numbers").await;
    let file = f
        .attach(&a, conversation, file.id, None)
        .await
        .unwrap()
        .message;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;
    let seqs = [words.seq, file.seq];
    f.merge(&a, target, conversation, &seqs, "小明和小红的聊天记录")
        .await
        .unwrap();

    // 标题、文字、文件名都能搜到；搜到的是那条聊天记录
    for query in ["小红的聊天", "weekly report", "预算表"] {
        let found = f.chat.search(&dan, query, None, None, None).await.unwrap();
        let kinds: Vec<MessageKind> = found.hits.iter().map(|hit| hit.kind).collect();
        assert_eq!(kinds, [MessageKind::ChatRecord], "{query}");
    }
    // 发送人的名字不算内容
    let found = f.chat.search(&dan, "小丹", None, None, None).await.unwrap();
    assert!(found.hits.is_empty());
}

#[tokio::test]
async fn a_record_can_be_forwarded_whole_or_nested_by_its_title() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let words = f.say(&b, conversation, "你好").await;
    let photo = f.upload(&b, "sea.png", "image/png", &fake_image()).await;
    let photo = f
        .attach(&b, conversation, photo.id, None)
        .await
        .unwrap()
        .message;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;
    let first = f
        .merge(&a, target, conversation, &[words.seq, photo.seq], "第一份")
        .await
        .unwrap()
        .message;
    let inner = first.data.record.clone().unwrap();

    // 逐条转发一条聊天记录：整条复制，里面的文件重新登记
    let eve = f.user("小艺").await;
    let elsewhere = f.befriend(&dan, &eve).await;
    let copy = f
        .forward(&dan, elsewhere, target, first.seq)
        .await
        .unwrap()
        .message;
    assert_eq!(copy.kind, MessageKind::ChatRecord);
    let copied = copy.data.record.clone().unwrap();
    assert_eq!(copied.title, "第一份");
    assert_eq!(copied.items.len(), 2);
    assert_ne!(copied.items[1].file, inner.items[1].file);
    f.files
        .open(&eve, copied.items[1].file.unwrap())
        .await
        .unwrap();
    assert_eq!(copy.text, first.text);

    // 再合并进另一份聊天记录：只留标题，里面的文件不再带着
    let note = f.say(&dan, target, "看看这个").await;
    let nested = f
        .merge(&dan, elsewhere, target, &[first.seq, note.seq], "第二份")
        .await
        .unwrap()
        .message;
    let outer = nested.data.record.unwrap();
    assert_eq!(outer.items[0].kind, MessageKind::ChatRecord);
    assert_eq!(outer.items[0].text.as_deref(), Some("第一份"));
    assert_eq!(outer.items[0].file, None);
    assert_eq!(outer.files().count(), 0);

    // 引用一条聊天记录时，摘要是它的标题
    let reply = f.reply(&eve, elsewhere, nested.seq, "收到").await.unwrap();
    let quote = reply.extras.quotes.get(&nested.seq).unwrap();
    assert!(matches!(quote, Quote::Shown { text: Some(text), .. } if text == "第二份"));
}

#[tokio::test]
async fn merging_needs_visible_live_messages_and_a_title() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;
    let words = f.say(&b, conversation, "你好").await;
    let gone = f.say(&a, conversation, "说错了").await;
    f.chat.recall(&a, conversation, gone.seq).await.unwrap();

    let invalid = |err: ChatError| matches!(err, ChatError::Invalid(_));
    let seqs = [words.seq];
    for title in ["", "   ", &"长".repeat(101)] {
        let err = f.merge(&a, target, conversation, &seqs, title).await;
        assert!(invalid(err.unwrap_err()), "{title}");
    }
    let err = f.merge(&a, target, conversation, &[], "标题").await;
    assert!(invalid(err.unwrap_err()));
    let many: Vec<i64> = (1..=51).collect();
    let err = f.merge(&a, target, conversation, &many, "标题").await;
    assert!(invalid(err.unwrap_err()));

    // 撤回了的、系统提示（撤回本身留下的那一条）
    for seq in [gone.seq, gone.seq + 1] {
        let err = f
            .merge(&a, target, conversation, &[words.seq, seq], "标题")
            .await;
        assert!(matches!(err.unwrap_err(), ChatError::ForwardNotAllowed));
    }
    // 不存在的序号；不是我的会话
    let err = f
        .merge(&a, target, conversation, &[words.seq, 99], "标题")
        .await;
    assert!(matches!(err.unwrap_err(), ChatError::MessageNotFound));
    let (_, _, strangers) = f.pair().await;
    let err = f.merge(&a, target, strangers, &[1], "标题").await;
    assert!(matches!(err.unwrap_err(), ChatError::ConversationNotFound));
    // 重复的序号只算一次
    let posted = f
        .merge(&a, target, conversation, &[words.seq, words.seq], "标题")
        .await
        .unwrap();
    assert_eq!(posted.message.data.record.unwrap().items.len(), 1);
}

#[tokio::test]
async fn a_resent_merge_is_written_once_and_its_files_live_and_die_with_it() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let photo = f.upload(&b, "sea.png", "image/png", &fake_image()).await;
    let photo = f
        .attach(&b, conversation, photo.id, None)
        .await
        .unwrap()
        .message;
    let dan = f.user("小丹").await;
    let target = f.befriend(&a, &dan).await;

    let seqs = [photo.seq];
    let first = f
        .merge_as(&a, target, conversation, &seqs, "记录", "same")
        .await
        .unwrap();
    let rows = f.store.file_count();
    let again = f
        .merge_as(&a, target, conversation, &seqs, "记录", "same")
        .await
        .unwrap();
    assert!(again.duplicate);
    assert_eq!(again.message.id, first.message.id);
    assert_eq!(f.store.file_count(), rows);

    // 聊天记录里的文件不是没人用的文件，过了一天也不清理
    let inside = first.message.data.record.unwrap().items[0].file.unwrap();
    f.clock.advance(ORPHAN_AFTER_MS + 1000);
    assert_eq!(f.files.sweep().await.unwrap(), 0);
    f.files.open(&dan, inside).await.unwrap();

    // 这条聊天记录过了保留期限被清理时，里面的文件一起交出去清理
    let cutoff = f.clock.now_ms() + 1;
    let purged = super::store::ChatStore::purge_before(f.store.as_ref(), cutoff)
        .await
        .unwrap();
    assert!(purged.files.contains(&inside));
    assert!(purged.files.contains(&photo.file.unwrap()));
}

// ---------- 编辑（F8） ----------

fn editing<'a>(text: &'a str, mentions: &'a [UserId]) -> EditDraft<'a> {
    EditDraft {
        text,
        mentions,
        mention_all: false,
    }
}

#[tokio::test]
async fn an_edit_replaces_the_text_for_everyone_and_keeps_what_it_was() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let typo = f.say(&a, conversation, "明天三点见").await;
    f.clock.advance(60_000);
    let posted = f
        .chat
        .edit(&a, conversation, typo.seq, editing("明天四点见", &[]))
        .await
        .unwrap();
    // 会话里多了一条编辑事件：带着新的内容和修改之前的内容，没有发送人（不算未读）
    let event = &posted.message;
    assert_eq!(event.kind, MessageKind::Edited);
    assert_eq!(event.sender, None);
    assert_eq!(event.data.seq, Some(typo.seq));
    assert_eq!(event.text.as_deref(), Some("明天四点见"));
    assert_eq!(event.data.previous.as_deref(), Some("明天三点见"));
    assert!(posted.members.contains(&b.id));
    // 交给普通用户的样子不带修改之前的内容
    assert_eq!(event.clone().redacted().data.previous, None);

    // 原来那条换成了新的内容，记下了编辑时间
    let page = f.history(&b, conversation).await;
    let edited = page.messages.iter().find(|m| m.seq == typo.seq).unwrap();
    assert_eq!(edited.text.as_deref(), Some("明天四点见"));
    assert_eq!(edited.edited_at, Some(event.created_at));
    // 按新的内容搜得到，旧的搜不到
    assert_eq!(f.hits(&b, "四点").await, ["明天四点见"]);
    assert!(f.hits(&b, "三点").await.is_empty());
    // 会话列表的摘要是被编辑的那一条，不是编辑事件；对方的未读还是 1
    let listed = f.chat.list(&b).await.unwrap();
    let row = listed
        .iter()
        .find(|l| l.conversation.id == conversation)
        .unwrap();
    assert_eq!(row.last_message.as_ref().map(|m| m.seq), Some(typo.seq));
    assert_eq!(row.unread, 1);

    // 时限之内可以再改；内容没有变的不算
    f.chat
        .edit(&a, conversation, typo.seq, editing("明天四点半见", &[]))
        .await
        .unwrap();
    let same = f
        .chat
        .edit(&a, conversation, typo.seq, editing("明天四点半见", &[]))
        .await;
    assert!(matches!(same, Err(ChatError::Invalid(_))));
}

#[tokio::test]
async fn only_my_own_text_and_captions_can_be_edited_in_time() {
    let f = fixture().await;
    let (a, b, conversation) = f.pair().await;
    let theirs = f.say(&b, conversation, "你好").await;
    let err = f
        .chat
        .edit(&a, conversation, theirs.seq, editing("改别人的", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::EditNotAllowed)));

    // 文件、语音不能改；图片可以改说明，也可以去掉说明
    let document = f.upload(&a, "notes.txt", "text/plain", b"hello").await;
    let file = f.attach(&a, conversation, document.id, None).await.unwrap();
    let err = f
        .chat
        .edit(&a, conversation, file.message.seq, editing("说明", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::EditNotAllowed)));
    let image = f.upload(&a, "photo.png", "image/png", &fake_image()).await;
    let caption = Captioned::new("风景");
    let photo = f
        .send_file(&a, conversation, image.id, None, caption)
        .await
        .unwrap()
        .message;
    f.chat
        .edit(&a, conversation, photo.seq, editing("山上的风景", &[]))
        .await
        .unwrap();
    f.chat
        .edit(&a, conversation, photo.seq, editing("  ", &[]))
        .await
        .unwrap();
    // 文字消息不能改成空的
    let mine = f.say(&a, conversation, "一句话").await;
    let err = f
        .chat
        .edit(&a, conversation, mine.seq, editing("", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::MessageEmpty)));

    // 撤回了的不能改
    let recalled = f.say(&a, conversation, "撤回这条").await;
    f.chat.recall(&a, conversation, recalled.seq).await.unwrap();
    let err = f
        .chat
        .edit(&a, conversation, recalled.seq, editing("改", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::EditNotAllowed)));

    // 时限默认 24 小时，从发出时算起；管理员可以改，0 是不允许编辑
    f.clock.advance(24 * 60 * 60 * 1000 + 1);
    let err = f
        .chat
        .edit(&a, conversation, mine.seq, editing("太晚了", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::EditTooLate)));
    f.set(EDIT_WINDOW_SECONDS_SETTING, "0").await;
    let fresh = f.say(&a, conversation, "刚发的").await;
    let err = f
        .chat
        .edit(&a, conversation, fresh.seq, editing("也不行", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::EditTooLate)));
    assert_eq!(f.chat.limits().await.unwrap().edit_window_seconds, 0);
}

#[tokio::test]
async fn only_people_newly_mentioned_by_an_edit_are_reminded() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let client_id = format!("c-{}", f.next());
    let draft = Draft {
        mentions: &[b.id],
        ..Draft::text(&client_id, "@成员1 看一下")
    };
    let sent = f.chat.send(&owner, group, draft).await.unwrap().message;
    // b 看过了
    f.chat.mark_read(&b, group, sent.seq).await.unwrap();
    assert!(!f.mentioned(&b).await);

    let edited = f
        .chat
        .edit(
            &owner,
            group,
            sent.seq,
            editing("@成员1 @成员2 看一下", &[b.id, c.id]),
        )
        .await
        .unwrap()
        .message;
    // 事件里只有这一次新 @ 到的 c；原来那条带着全部的 @
    assert_eq!(edited.data.mentions, [c.id]);
    assert!(f.mentioned(&c).await);
    assert!(!f.mentioned(&b).await);
    let page = f.history(&c, group).await;
    let message = page.messages.iter().find(|m| m.seq == sent.seq).unwrap();
    assert_eq!(message.data.mentions, [b.id, c.id]);

    // 被禁言了就不能改
    let said = f.say(&c, group, "我说一句").await;
    f.chat.mute_member(&owner, group, c.id, None).await.unwrap();
    let err = f
        .chat
        .edit(&c, group, said.seq, editing("改一下", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::Muted { .. })));
}

/// 和发消息一样：单聊里不再是好友、群里已经离开或群解散了，都不能再改；
/// 改的时候 @ 的人要在群里，@ 所有人只有群主和管理员能用。
#[tokio::test]
async fn an_edit_needs_the_same_standing_as_sending() {
    let f = fixture().await;
    let (a, b, direct) = f.pair().await;
    let said = f.say(&a, direct, "你好").await;
    f.contacts.remove_friend(&a, b.id).await.unwrap();
    let err = f.chat.edit(&a, direct, said.seq, editing("改", &[])).await;
    assert!(matches!(err, Err(ChatError::NotFriends)), "{err:?}");

    let (owner, b, c, group) = f.trio().await;
    let stranger = f.user("路人").await;
    let mine = f.say(&b, group, "大家好").await;
    let err = f
        .chat
        .edit(&b, group, mine.seq, editing("@路人 你好", &[stranger.id]))
        .await;
    assert!(matches!(err, Err(ChatError::NotMember)), "{err:?}");
    let all = EditDraft {
        mention_all: true,
        ..editing("@所有人 大家好", &[])
    };
    let err = f.chat.edit(&b, group, mine.seq, all).await;
    assert!(matches!(err, Err(ChatError::NotManager)), "{err:?}");

    let left = f.say(&c, group, "我先走了").await;
    f.chat.leave(&c, group).await.unwrap();
    let err = f.chat.edit(&c, group, left.seq, editing("改", &[])).await;
    assert!(matches!(err, Err(ChatError::LeftGroup)), "{err:?}");

    let last = f.say(&owner, group, "解散了").await;
    f.chat.dissolve(&owner, group).await.unwrap();
    let err = f
        .chat
        .edit(&owner, group, last.seq, editing("改", &[]))
        .await;
    assert!(matches!(err, Err(ChatError::GroupDissolved)), "{err:?}");
}

// ---------- 正在输入（F8） ----------

#[tokio::test]
async fn typing_is_told_to_the_others_who_are_still_there() {
    let f = fixture().await;
    let (owner, b, c, group) = f.trio().await;
    let mut told = f.chat.typing(&b, group).await.unwrap();
    told.sort();
    let mut expected = vec![owner.id, c.id];
    expected.sort();
    assert_eq!(told, expected);

    // 被禁言了、离开了，都不告诉别人
    f.chat.mute_member(&owner, group, b.id, None).await.unwrap();
    assert!(matches!(
        f.chat.typing(&b, group).await,
        Err(ChatError::Muted { .. })
    ));
    f.chat.leave(&c, group).await.unwrap();
    assert!(matches!(
        f.chat.typing(&c, group).await,
        Err(ChatError::LeftGroup)
    ));
    assert_eq!(f.chat.typing(&owner, group).await.unwrap(), [b.id]);

    // 单聊里告诉对方
    let (x, y, direct) = f.pair().await;
    assert_eq!(f.chat.typing(&x, direct).await.unwrap(), [y.id]);
}
