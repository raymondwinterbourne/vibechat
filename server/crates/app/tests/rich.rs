//! 图片、文件、语音、引用、撤回、搜索的接口，以及随之发出的推送。

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::{Client, Reply, TestApp};
use serde_json::{Value, json};
use tokio::sync::mpsc::Receiver;
use vibechat_core::limits::{FILE_MAX_BYTES_SETTING, RECALL_WINDOW_SECONDS_SETTING};
use vibechat_core::settings::SettingsStore;
use vibechat_core::testing::fake_image;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    ConversationList, ConversationMuted, ConversationView, ErrorCode, FileView,
    FriendRequestResult, LimitsView, Me, MessageKind, MessageList, MessageView, QuoteState,
    SearchResult, ServerEvent,
};

const WEBM: &[u8] = &[0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4];

/// 一个用户的一处登录收到的推送。
struct Inbox(Receiver<ServerEvent>);

impl Inbox {
    fn open(app: &TestApp, me: &Me) -> Self {
        let user: UserId = me.id.parse().unwrap();
        Self(app.state.hub.register(user, SessionId::new()).events)
    }

    fn events(&mut self) -> Vec<ServerEvent> {
        std::iter::from_fn(|| self.0.try_recv().ok()).collect()
    }

    /// 到目前为止收到的会话日志里的条目。
    fn messages(&mut self) -> Vec<MessageView> {
        let new = |event| match event {
            ServerEvent::MsgNew(message) => Some(*message),
            _ => None,
        };
        self.events().into_iter().filter_map(new).collect()
    }
}

struct Person {
    client: Client,
    me: Me,
}

async fn person(app: &TestApp, nickname: &str) -> Person {
    let (client, me) = app.user(nickname).await;
    Person { client, me }
}

async fn befriend(a: &mut Person, b: &mut Person) {
    let request = json!({ "to": b.me.id });
    let sent = a.client.post("/api/friend-requests", request).await;
    let sent: FriendRequestResult = sent.json();
    let accept = format!("/api/friend-requests/{}/accept", sent.request.id);
    assert_eq!(b.client.post_empty(&accept).await.status, StatusCode::OK);
}

/// 两个好友和他们的单聊。
async fn pair(app: &TestApp) -> (Person, Person, String) {
    let (mut a, mut b) = (person(app, "小明").await, person(app, "小红").await);
    befriend(&mut a, &mut b).await;
    let request = json!({ "user_id": b.me.id });
    let opened = a.client.post("/api/conversations/direct", request).await;
    let id = opened.json::<ConversationView>().id;
    (a, b, id)
}

/// 群主和两个成员的群；另有一个是群主的好友但不在群里的人。
async fn group(app: &TestApp) -> (Person, Person, Person, Person, String) {
    let mut owner = person(app, "群主").await;
    let mut one = person(app, "成员一").await;
    let mut two = person(app, "成员二").await;
    let mut outsider = person(app, "局外人").await;
    for friend in [&mut one, &mut two, &mut outsider] {
        befriend(&mut owner, friend).await;
    }
    let request = json!({ "name": "项目组", "member_ids": [one.me.id, two.me.id] });
    let reply = owner.client.post("/api/conversations/group", request).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = reply.json::<ConversationView>().id;
    (owner, one, two, outsider, id)
}

/// 上传一个文件。文件名按浏览器的做法做百分号编码。
async fn upload_raw(person: &mut Person, name: &str, kind: &str, content: &[u8]) -> Reply {
    let encoded: String = name.bytes().map(|byte| format!("%{byte:02X}")).collect();
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/files")
        .header("x-file-name", encoded)
        .header(header::CONTENT_TYPE, kind);
    person
        .client
        .send(request, Body::from(content.to_vec()))
        .await
}

async fn upload(person: &mut Person, name: &str, kind: &str, content: &[u8]) -> FileView {
    let reply = upload_raw(person, name, kind, content).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn post(person: &mut Person, conversation: &str, body: Value) -> Reply {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let mut body = body;
    if body.get("client_id").is_none() {
        let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        body["client_id"] = json!(format!("c-{next}"));
    }
    let path = format!("/api/conversations/{conversation}/messages");
    person.client.post(&path, body).await
}

async fn say(person: &mut Person, conversation: &str, body: Value) -> MessageView {
    let reply = post(person, conversation, body).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn history(person: &mut Person, conversation: &str) -> Vec<MessageView> {
    let path = format!("/api/conversations/{conversation}/messages");
    person.client.get(&path).await.json::<MessageList>().items
}

async fn recall(person: &mut Person, conversation: &str, seq: i64) -> Reply {
    let path = format!("/api/conversations/{conversation}/messages/{seq}/recall");
    person.client.post_empty(&path).await
}

async fn set(app: &TestApp, key: &str, value: &str) {
    SettingsStore::set(app.store.as_ref(), key, value)
        .await
        .unwrap();
}

fn header_of(reply: &Reply, name: header::HeaderName) -> &str {
    reply.headers.get(name).map_or("", |v| v.to_str().unwrap())
}

// ---------- 上传和下载 ----------

#[tokio::test]
async fn a_file_is_uploaded_then_downloaded_whole_or_in_part() {
    let app = common::app().await;
    let (mut a, mut b, _) = pair(&app).await;
    let content: Vec<u8> = (0..=255).collect();

    let file = upload(&mut a, "季度 报告.pdf", "application/pdf", &content).await;
    assert_eq!((file.name.as_str(), file.size), ("季度 报告.pdf", 256));
    assert_eq!((file.width, file.height, file.audio), (None, None, false));

    let path = format!("/api/files/{}", file.id);
    let reply = a.client.get(&path).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, content);
    assert_eq!(header_of(&reply, header::CONTENT_LENGTH), "256");
    assert_eq!(header_of(&reply, header::ACCEPT_RANGES), "bytes");
    // 不认识的类型一律作为下载返回，带着原来的文件名；浏览器不许猜类型、不许运行里面的东西
    assert_eq!(
        header_of(&reply, header::CONTENT_TYPE),
        "application/octet-stream"
    );
    assert_eq!(
        header_of(&reply, header::CONTENT_DISPOSITION),
        "attachment; filename=\"__ __.pdf\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A.pdf"
    );
    assert_eq!(header_of(&reply, header::X_CONTENT_TYPE_OPTIONS), "nosniff");
    assert!(header_of(&reply, header::CONTENT_SECURITY_POLICY).contains("sandbox"));

    // 只取一段：播放音频时浏览器这样请求
    let ranged = |range: &'static str| {
        Request::builder()
            .method(Method::GET)
            .uri(&path)
            .header(header::RANGE, range)
    };
    let reply = a.client.send(ranged("bytes=10-19"), Body::empty()).await;
    assert_eq!(reply.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(reply.body, &content[10..20]);
    assert_eq!(header_of(&reply, header::CONTENT_RANGE), "bytes 10-19/256");
    assert_eq!(header_of(&reply, header::CONTENT_LENGTH), "10");
    let reply = a.client.send(ranged("bytes=-6"), Body::empty()).await;
    assert_eq!(reply.body, &content[250..]);
    let reply = a.client.send(ranged("bytes=500-"), Body::empty()).await;
    assert_eq!(reply.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(header_of(&reply, header::CONTENT_RANGE), "bytes */256");

    // 还没有发出去：别人拿到地址也读不到；没有登录的更不行
    assert_eq!(b.client.get(&path).await.status, StatusCode::NOT_FOUND);
    assert_eq!(
        app.client().get(&path).await.status,
        StatusCode::UNAUTHORIZED
    );
    let reply = a.client.get("/api/files/not-an-id").await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
    let reply = app.client().post_empty("/api/files").await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
}

/// 一个会数自己被读走了多少字节的请求体：`chunks` 块，每块 `size` 字节。
fn counted_body(chunks: usize, size: usize) -> (Body, Arc<AtomicUsize>) {
    let read = Arc::new(AtomicUsize::new(0));
    let counter = read.clone();
    let content = futures_util::stream::iter((0..chunks).map(move |_| {
        counter.fetch_add(size, Ordering::Relaxed);
        Ok::<_, std::io::Error>(vec![7u8; size])
    }));
    (Body::from_stream(content), read)
}

#[tokio::test]
async fn a_refused_upload_is_read_to_the_end_before_the_answer() {
    let app = common::app().await;
    let mut a = person(&app, "小明").await;
    set(&app, FILE_MAX_BYTES_SETTING, "10").await;
    let too_big = |length: &str| {
        Request::builder()
            .method(Method::POST)
            .uri("/api/files")
            .header(header::CONTENT_LENGTH, length)
    };

    // 不存，但要读完：对方（或者中间的代理）还在发的时候把连接关掉，它就收不到"文件太大"这个答复
    let (body, read) = counted_body(20, 1000);
    let reply = a.client.send(too_big("20000"), body).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.error().code, ErrorCode::FileTooLarge);
    assert_eq!(read.load(Ordering::Relaxed), 20_000);

    // 大得离谱的不奉陪：读到一定的量就不读了，照样答复
    let megabyte = 1024 * 1024;
    let (body, read) = counted_body(200, megabyte);
    let reply = a.client.send(too_big("209715200"), body).await;
    assert_eq!(reply.error().code, ErrorCode::FileTooLarge);
    let read = read.load(Ordering::Relaxed);
    assert!(read > 60 * megabyte, "read {read}");
    assert!(read < 70 * megabyte, "read {read}");
}

#[tokio::test]
async fn an_upload_over_the_limit_is_refused() {
    let app = common::app().await;
    let mut a = person(&app, "小明").await;
    set(&app, FILE_MAX_BYTES_SETTING, "10").await;

    // 读到上限就中止
    let reply = upload_raw(&mut a, "big.bin", "", &[7; 11]).await;
    assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(reply.error().code, ErrorCode::FileTooLarge);
    // 浏览器报的长度已经超限：内容都不用收
    let declared = Request::builder()
        .method(Method::POST)
        .uri("/api/files")
        .header(header::CONTENT_LENGTH, "5000");
    let reply = a.client.send(declared, Body::from(vec![7; 5])).await;
    assert_eq!(reply.error().code, ErrorCode::FileTooLarge);

    upload(&mut a, "ok.bin", "", &[7; 10]).await;
    let reply = upload_raw(&mut a, "empty.bin", "", &[]).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);

    let limits: LimitsView = a.client.get("/api/limits").await.json();
    assert_eq!(limits.file_max_bytes, 10);
    assert_eq!(
        (limits.voice_max_seconds, limits.recall_window_seconds),
        (60, 120)
    );
    assert_eq!(
        app.client().get("/api/limits").await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn only_real_images_and_recordings_are_shown_in_the_page() {
    let app = common::app().await;
    let mut a = person(&app, "小明").await;

    let image = upload(&mut a, "photo.png", "image/png", &fake_image()).await;
    assert_eq!((image.width, image.height), (Some(640), Some(480)));
    let path = format!("/api/files/{}", image.id);
    let reply = a.client.get(&path).await;
    assert_eq!(header_of(&reply, header::CONTENT_TYPE), "image/png");
    assert_eq!(header_of(&reply, header::CONTENT_DISPOSITION), "inline");
    // 点"下载"时带上这个参数
    let reply = a.client.get(&format!("{path}?download=1")).await;
    assert!(
        header_of(&reply, header::CONTENT_DISPOSITION)
            .starts_with("attachment; filename=\"photo.png\"")
    );
    let reply = a.client.get(&format!("{path}/thumbnail")).await;
    assert_eq!(reply.status, StatusCode::OK);
    assert_eq!(reply.body, b"THUMB");
    assert!(header_of(&reply, header::CONTENT_TYPE).starts_with("image/"));

    let voice = upload(&mut a, "voice.webm", "audio/webm;codecs=opus", WEBM).await;
    assert!(voice.audio);
    let reply = a.client.get(&format!("/api/files/{}", voice.id)).await;
    assert_eq!(header_of(&reply, header::CONTENT_TYPE), "audio/webm");
    assert_eq!(header_of(&reply, header::CONTENT_DISPOSITION), "inline");

    // 一个网页，声称自己是图片：只能下载，类型也不是网页
    let page = upload(
        &mut a,
        "evil.html",
        "image/png",
        b"<html><script>alert(1)</script>",
    )
    .await;
    assert_eq!((page.width, page.audio), (None, false));
    let path = format!("/api/files/{}", page.id);
    let reply = a.client.get(&path).await;
    assert_eq!(
        header_of(&reply, header::CONTENT_TYPE),
        "application/octet-stream"
    );
    assert!(header_of(&reply, header::CONTENT_DISPOSITION).starts_with("attachment"));
    let reply = a.client.get(&format!("{path}/thumbnail")).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);
}

// ---------- 带文件的消息 ----------

#[tokio::test]
async fn images_files_and_voice_messages_reach_the_other_side() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let mut inbox = Inbox::open(&app, &b.me);
    let image = upload(&mut a, "photo.png", "image/png", &fake_image()).await;
    let document = upload(&mut a, "notes.txt", "text/plain", b"hello").await;
    let voice = upload(&mut a, "voice.webm", "audio/webm", WEBM).await;

    let sent = say(&mut a, &conversation, json!({ "file_id": image.id })).await;
    assert_eq!(sent.kind, MessageKind::Image);
    assert_eq!(sent.file.as_ref().unwrap().width, Some(640));
    let sent = say(&mut a, &conversation, json!({ "file_id": document.id })).await;
    assert_eq!((sent.kind, sent.text.as_deref()), (MessageKind::File, None));
    let body = json!({ "file_id": voice.id, "voice_duration_ms": 3200 });
    let sent = say(&mut a, &conversation, body).await;
    assert_eq!(
        (sent.kind, sent.duration_ms),
        (MessageKind::Voice, Some(3200))
    );

    // 推送里带着文件的信息，对方不用再问
    let pushed = inbox.messages();
    let kinds: Vec<MessageKind> = pushed.iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        [MessageKind::Image, MessageKind::File, MessageKind::Voice]
    );
    assert_eq!(pushed[1].file.as_ref().unwrap().name, "notes.txt");
    assert!(pushed[2].file.as_ref().unwrap().audio);
    // 翻历史时也带着；会话列表的最新一条带着文件名
    let listed = history(&mut b, &conversation).await;
    let files: Vec<&str> = listed
        .iter()
        .filter_map(|m| m.file.as_ref())
        .map(|f| f.name.as_str())
        .collect();
    assert_eq!(files, ["photo.png", "notes.txt", "voice.webm"]);
    let list: ConversationList = b.client.get("/api/conversations").await.json();
    assert_eq!(list.items[0].unread, 3);
    let last = list.items[0].last_message.as_ref().unwrap();
    assert_eq!(last.file.as_ref().unwrap().id, voice.id);
    // 对方现在能读这些文件了
    let reply = b.client.get(&format!("/api/files/{}", document.id)).await;
    assert_eq!(
        (reply.status, reply.body.as_slice()),
        (StatusCode::OK, b"hello".as_slice())
    );
}

#[tokio::test]
async fn a_file_that_cannot_be_attached_is_refused() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let file = upload(&mut a, "notes.txt", "", b"hello").await;
    let voice = upload(&mut a, "voice.webm", "audio/webm", WEBM).await;

    // 别人上传的、不存在的、编号不像样的
    for (who, id) in [(&mut b, file.id.as_str()), (&mut a, "not-an-id")] {
        let reply = post(who, &conversation, json!({ "file_id": id })).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(reply.error().code, ErrorCode::FileUnavailable);
    }
    // 不是录音的文件不能当语音发；语音不能超过时长上限
    let body = json!({ "file_id": file.id, "voice_duration_ms": 1000 });
    assert_eq!(
        post(&mut a, &conversation, body).await.error().code,
        ErrorCode::FileUnavailable
    );
    let body = json!({ "file_id": voice.id, "voice_duration_ms": 90_000 });
    let reply = post(&mut a, &conversation, body).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    assert_eq!(reply.error().code, ErrorCode::VoiceTooLong);

    // 重发交还第一次的那一条；换一个编号再发同一个文件不行
    let body = json!({ "client_id": "same", "file_id": file.id });
    let first = post(&mut a, &conversation, body.clone()).await;
    let again = post(&mut a, &conversation, body).await;
    assert_eq!(
        (first.status, again.status),
        (StatusCode::CREATED, StatusCode::OK)
    );
    assert_eq!(again.json::<MessageView>(), first.json::<MessageView>());
    let reply = post(&mut a, &conversation, json!({ "file_id": file.id })).await;
    assert_eq!(reply.error().code, ErrorCode::FileUnavailable);
    // 既没有文字也没有文件
    let reply = post(&mut a, &conversation, json!({})).await;
    assert_eq!(reply.error().code, ErrorCode::MessageEmpty);
}

#[tokio::test]
async fn a_file_is_only_served_to_those_who_can_see_its_message() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, mut outsider, group) = group(&app).await;
    let image = upload(&mut owner, "plan.png", "image/png", &fake_image()).await;
    let sent = say(&mut owner, &group, json!({ "file_id": image.id })).await;
    // 之后才入群的人
    let path = format!("/api/conversations/{group}/members");
    let invited = owner
        .client
        .post(&path, json!({ "user_ids": [outsider.me.id] }))
        .await;
    assert_eq!(invited.status, StatusCode::OK);
    let mut stranger = person(&app, "路人").await;

    let original = format!("/api/files/{}", image.id);
    let thumbnail = format!("{original}/thumbnail");
    for path in [&original, &thumbnail] {
        for member in [&mut owner, &mut one, &mut two] {
            assert_eq!(member.client.get(path).await.status, StatusCode::OK);
        }
        for other in [&mut outsider, &mut stranger] {
            let reply = other.client.get(path).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND);
            assert_eq!(reply.error().code, ErrorCode::NotFound);
        }
    }

    // 撤回之后谁都读不到
    assert_eq!(
        recall(&mut owner, &group, sent.seq).await.status,
        StatusCode::OK
    );
    for path in [&original, &thumbnail] {
        for member in [&mut owner, &mut one] {
            assert_eq!(member.client.get(path).await.status, StatusCode::NOT_FOUND);
        }
    }
}

// ---------- 引用 ----------

#[tokio::test]
async fn a_reply_carries_what_it_quotes_unless_the_reader_cannot_see_it() {
    let app = common::app().await;
    let (mut owner, mut one, _, mut newcomer, group) = group(&app).await;
    let original = say(&mut owner, &group, json!({ "text": "周六爬山" })).await;
    let path = format!("/api/conversations/{group}/members");
    owner
        .client
        .post(&path, json!({ "user_ids": [newcomer.me.id] }))
        .await;
    let mut old_inbox = Inbox::open(&app, &owner.me);
    let mut new_inbox = Inbox::open(&app, &newcomer.me);

    let body = json!({ "text": "我去", "reply_to": original.seq });
    let reply = say(&mut one, &group, body).await;
    let quote = reply.reply.as_ref().unwrap();
    assert_eq!((quote.seq, quote.state), (original.seq, QuoteState::Shown));
    assert_eq!(quote.sender_name.as_deref(), Some("群主"));
    assert_eq!(quote.text.as_deref(), Some("周六爬山"));
    assert_eq!(quote.kind, Some(MessageKind::Text));

    // 老成员收到的带着引用的内容；后来入群的人收到的不带
    let pushed = old_inbox.messages();
    assert_eq!(
        pushed[0].reply.as_ref().unwrap().text.as_deref(),
        Some("周六爬山")
    );
    let pushed = new_inbox.messages();
    let hidden = pushed[0].reply.as_ref().unwrap();
    assert_eq!(
        (hidden.state, hidden.text.as_deref()),
        (QuoteState::Unavailable, None)
    );
    assert_eq!(hidden.sender_id, None);
    let listed = history(&mut newcomer, &group).await;
    let seen = listed.iter().find(|m| m.seq == reply.seq).unwrap();
    assert_eq!(seen.reply.as_ref().unwrap().state, QuoteState::Unavailable);

    // 新人不能引用自己看不到的；系统提示不能引用
    for (who, seq) in [(&mut newcomer, original.seq), (&mut one, 1)] {
        let reply = post(who, &group, json!({ "text": "?", "reply_to": seq })).await;
        assert_eq!(reply.status, StatusCode::CONFLICT);
        assert_eq!(reply.error().code, ErrorCode::QuoteUnavailable);
    }

    // 原消息撤回之后：引用处是"已撤回"，也不能再引用它
    recall(&mut owner, &group, original.seq).await;
    let listed = history(&mut one, &group).await;
    let seen = listed.iter().find(|m| m.seq == reply.seq).unwrap();
    let quote = seen.reply.as_ref().unwrap();
    assert_eq!(
        (quote.state, quote.text.as_deref()),
        (QuoteState::Recalled, None)
    );
    let body = json!({ "text": "?", "reply_to": original.seq });
    assert_eq!(
        post(&mut one, &group, body).await.error().code,
        ErrorCode::QuoteUnavailable
    );
}

// ---------- 撤回 ----------

/// 编辑（F8）：双方都收到编辑事件，带着新的内容，不带修改之前的；历史里那一条换成新的内容。
#[tokio::test]
async fn editing_shows_the_new_text_to_everyone_at_once() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let typo = say(&mut a, &conversation, json!({ "text": "明天三点见" })).await;
    let mut mine = Inbox::open(&app, &a.me);
    let mut theirs = Inbox::open(&app, &b.me);

    let path = format!("/api/conversations/{conversation}/messages/{}", typo.seq);
    let reply = a.client.put(&path, json!({ "text": "明天四点见" })).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let event: MessageView = reply.json();
    assert_eq!(
        (event.kind, event.target_seq, event.text.as_deref()),
        (MessageKind::Edited, Some(typo.seq), Some("明天四点见"))
    );
    assert_eq!(event.previous_text, None);
    assert_eq!(mine.messages(), std::slice::from_ref(&event));
    assert_eq!(theirs.messages(), std::slice::from_ref(&event));

    let list: MessageList = b
        .client
        .get(&format!("/api/conversations/{conversation}/messages"))
        .await
        .json();
    let edited = list.items.iter().find(|m| m.seq == typo.seq).unwrap();
    assert_eq!(edited.text.as_deref(), Some("明天四点见"));
    assert_eq!(edited.edited_at, Some(event.created_at));

    // 别人的消息改不了
    let reply = b.client.put(&path, json!({ "text": "我来改" })).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::EditNotAllowed)
    );
    // 管理员关掉了编辑
    set(&app, "edit_window_seconds", "0").await;
    let reply = a.client.put(&path, json!({ "text": "再改" })).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::EditTooLate)
    );
    let limits: LimitsView = a.client.get("/api/limits").await.json();
    assert_eq!(limits.edit_window_seconds, 0);
}

#[tokio::test]
async fn recalling_replaces_the_message_for_everyone_at_once() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let wrong = say(&mut a, &conversation, json!({ "text": "说错了" })).await;
    say(&mut a, &conversation, json!({ "text": "没说错" })).await;
    let mut mine = Inbox::open(&app, &a.me);
    let mut theirs = Inbox::open(&app, &b.me);

    let reply = recall(&mut a, &conversation, wrong.seq).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let event: MessageView = reply.json();
    assert_eq!(
        (event.kind, event.target_seq),
        (MessageKind::Recalled, Some(wrong.seq))
    );
    assert_eq!(event.actor.as_ref().unwrap().id, a.me.id);
    assert_eq!(event.seq, wrong.seq + 2);
    // 双方（包括撤回的人在别处的登录）都收到这条事件
    assert_eq!(mine.messages(), std::slice::from_ref(&event));
    assert_eq!(theirs.messages(), [event]);

    let sender = a.me.id.clone();
    for viewer in [&mut a, &mut b] {
        let listed = history(viewer, &conversation).await;
        let gone = listed.iter().find(|m| m.seq == wrong.seq).unwrap();
        assert!(gone.recalled);
        assert_eq!(
            (gone.text.as_deref(), gone.sender_id.as_deref()),
            (None, Some(sender.as_str()))
        );
    }
    // 对方的未读数少了一条
    let list: ConversationList = b.client.get("/api/conversations").await.json();
    assert_eq!(list.items[0].unread, 1);
    assert_eq!(
        list.items[0].last_message.as_ref().unwrap().kind,
        MessageKind::Recalled
    );
}

#[tokio::test]
async fn a_message_can_only_be_recalled_by_its_sender_in_time() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let mine = say(&mut a, &conversation, json!({ "text": "我的" })).await;
    let late = say(&mut a, &conversation, json!({ "text": "来不及" })).await;
    let code = |reply: Reply| (reply.status, reply.error().code);

    let reply = recall(&mut b, &conversation, mine.seq).await;
    assert_eq!(
        code(reply),
        (StatusCode::FORBIDDEN, ErrorCode::RecallNotAllowed)
    );
    let reply = recall(&mut a, &conversation, 999).await;
    assert_eq!(
        code(reply),
        (StatusCode::NOT_FOUND, ErrorCode::MessageNotFound)
    );
    let path = format!("/api/conversations/{conversation}/messages/abc/recall");
    assert_eq!(
        a.client.post_empty(&path).await.error().code,
        ErrorCode::MessageNotFound
    );
    let mut stranger = person(&app, "路人").await;
    let reply = recall(&mut stranger, &conversation, mine.seq).await;
    assert_eq!(
        code(reply),
        (StatusCode::NOT_FOUND, ErrorCode::ConversationNotFound)
    );

    assert_eq!(
        recall(&mut a, &conversation, mine.seq).await.status,
        StatusCode::OK
    );
    let reply = recall(&mut a, &conversation, mine.seq).await;
    assert_eq!(
        code(reply),
        (StatusCode::FORBIDDEN, ErrorCode::RecallNotAllowed)
    );

    // 过了时限
    app.clock.advance(120_001);
    let reply = recall(&mut a, &conversation, late.seq).await;
    assert_eq!(
        code(reply),
        (StatusCode::CONFLICT, ErrorCode::RecallTooLate)
    );
    // 管理员把时限改长之后又可以了
    set(&app, RECALL_WINDOW_SECONDS_SETTING, "600").await;
    assert_eq!(
        recall(&mut a, &conversation, late.seq).await.status,
        StatusCode::OK
    );
}

// ---------- 语音：听过没有 ----------

#[tokio::test]
async fn playing_a_voice_message_is_remembered_for_that_listener_only() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let voice = upload(&mut owner, "voice.webm", "audio/webm", WEBM).await;
    let body = json!({ "file_id": voice.id, "voice_duration_ms": 2000 });
    let sent = say(&mut owner, &group, body).await;
    let text = say(&mut owner, &group, json!({ "text": "文字" })).await;
    let mut elsewhere = Inbox::open(&app, &one.me);
    let mut others = Inbox::open(&app, &two.me);
    let played = |seq: i64| format!("/api/conversations/{group}/messages/{seq}/played");

    let reply = one.client.post_empty(&played(sent.seq)).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    // 只告诉他自己在别处的登录
    let events = elsewhere.events();
    assert!(matches!(&events[..], [ServerEvent::MsgPlayed(p)] if p.seq == sent.seq));
    assert!(others.events().is_empty());
    // 再听一遍不再推送
    one.client.post_empty(&played(sent.seq)).await;
    assert!(elsewhere.events().is_empty());

    let heard =
        |listed: Vec<MessageView>| listed.iter().find(|m| m.seq == sent.seq).unwrap().played;
    assert!(heard(history(&mut one, &group).await));
    assert!(!heard(history(&mut two, &group).await));

    let reply = one.client.post_empty(&played(text.seq)).await;
    assert_eq!(reply.error().code, ErrorCode::MessageNotFound);
}

// ---------- 搜索 ----------

#[tokio::test]
async fn search_covers_all_my_conversations_or_just_one() {
    let app = common::app().await;
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let request = json!({ "user_id": one.me.id });
    let direct = owner
        .client
        .post("/api/conversations/direct", request)
        .await;
    let direct = direct.json::<ConversationView>().id;
    say(&mut owner, &group, json!({ "text": "预算 第一版" })).await;
    app.clock.advance(1000);
    let file = upload(&mut one, "预算表.xlsx", "", b"numbers").await;
    say(&mut one, &direct, json!({ "file_id": file.id })).await;
    app.clock.advance(1000);
    let wrong = say(&mut owner, &group, json!({ "text": "预算 作废" })).await;
    app.clock.advance(1000);
    say(&mut owner, &group, json!({ "text": "预算 第二版" })).await;
    recall(&mut owner, &group, wrong.seq).await;

    // 中文关键词在地址里要编码
    let all = "/api/search?q=%E9%A2%84%E7%AE%97";
    let found: SearchResult = owner.client.get(all).await.json();
    let hits: Vec<(&str, String)> = found
        .items
        .iter()
        .map(|hit| {
            let label = hit
                .file
                .as_ref()
                .map_or(hit.text.clone().unwrap_or_default(), |f| f.name.clone());
            (hit.conversation_id.as_str(), label)
        })
        .collect();
    // 从新到旧，跨会话，带文件名；撤回的不在里面
    let expected = [
        (group.as_str(), "预算 第二版".to_owned()),
        (direct.as_str(), "预算表.xlsx".to_owned()),
        (group.as_str(), "预算 第一版".to_owned()),
    ];
    assert_eq!(hits, expected);
    assert!(!found.has_more);
    assert_eq!(found.items[1].sender_name.as_deref(), Some("成员一"));
    // 不在那个单聊里的人搜不到里面的文件
    let found: SearchResult = two.client.get(all).await.json();
    assert_eq!(found.items.len(), 2);

    // 只在一个会话里搜，一页一条
    let inside = format!("/api/conversations/{group}/search?q=%E9%A2%84%E7%AE%97&limit=1");
    let first: SearchResult = owner.client.get(&inside).await.json();
    assert_eq!(first.items[0].text.as_deref(), Some("预算 第二版"));
    assert!(first.has_more);
    let next = format!("{inside}&before={}", first.items[0].seq);
    let second: SearchResult = owner.client.get(&next).await.json();
    assert_eq!(second.items[0].text.as_deref(), Some("预算 第一版"));
    assert!(!second.has_more);

    // 关键词不能空着；不是我的会话搜不了
    for bad in ["/api/search?q=%20", "/api/search"] {
        assert_eq!(
            owner.client.get(bad).await.status,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    let foreign = format!("/api/conversations/{direct}/search?q=x");
    let reply = two.client.get(&foreign).await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);
    assert_eq!(app.client().get(all).await.status, StatusCode::UNAUTHORIZED);
}

// ---------- 免打扰 ----------

#[tokio::test]
async fn muting_a_conversation_follows_me_to_my_other_logins() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let mut elsewhere = Inbox::open(&app, &a.me);
    let mut theirs = Inbox::open(&app, &b.me);
    let path = format!("/api/conversations/{conversation}/mute");

    let reply = a.client.put(&path, json!({ "muted": true })).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());

    // 只告诉我自己在别处的登录
    let expected = ServerEvent::ConvMuted(ConversationMuted {
        conversation_id: conversation.clone(),
        muted: true,
    });
    assert_eq!(elsewhere.events(), [expected]);
    assert!(theirs.events().is_empty());
    // 消息和未读数照常
    say(&mut b, &conversation, json!({ "text": "在吗" })).await;
    let list: ConversationList = a.client.get("/api/conversations").await.json();
    assert_eq!((list.items[0].muted, list.items[0].unread), (true, 1));
    let list: ConversationList = b.client.get("/api/conversations").await.json();
    assert!(!list.items[0].muted);

    let reply = a.client.put(&path, json!({ "muted": false })).await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT);
    let shown: ConversationView = a
        .client
        .get(&format!("/api/conversations/{conversation}"))
        .await
        .json();
    assert!(!shown.muted);

    // 不是我的会话；没有登录；请求不对
    let mut stranger = person(&app, "路人").await;
    let reply = stranger.client.put(&path, json!({ "muted": true })).await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);
    let reply = app.client().put(&path, json!({ "muted": true })).await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    let reply = a.client.put(&path, json!({})).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_forwarded_file_can_be_fetched_by_the_new_audience_only() {
    let app = common::app().await;
    let (mut owner, mut one, _two, mut outsider, group) = group(&app).await;
    let file = upload(&mut one, "路线.pdf", "application/pdf", b"%PDF-1.7 map").await;
    let shared = say(&mut one, &group, json!({ "file_id": file.id })).await;

    // 群主转发给不在群里的好友
    let request = json!({ "user_id": outsider.me.id });
    let direct = owner
        .client
        .post("/api/conversations/direct", request)
        .await;
    let direct = direct.json::<ConversationView>().id;
    let forward = json!({ "forward": { "conversation_id": group, "seq": shared.seq } });
    let copy = say(&mut owner, &direct, forward).await;
    assert_eq!(copy.kind, MessageKind::File);
    assert_eq!(copy.sender_id.as_deref(), Some(owner.me.id.as_str()));
    let copied = copy.file.expect("the copy has a file");
    assert_ne!(copied.id, file.id);
    assert_eq!(copied.name, "路线.pdf");

    // 好友读得到转发来的文件，读不到群里的原文件
    let fetched = outsider
        .client
        .get(&format!("/api/files/{}", copied.id))
        .await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.body, b"%PDF-1.7 map");
    let original = outsider
        .client
        .get(&format!("/api/files/{}", file.id))
        .await;
    assert_eq!(original.status, StatusCode::NOT_FOUND);

    // 局外人转发群里的消息：他看不到那个群
    let forward = json!({ "forward": { "conversation_id": group, "seq": shared.seq } });
    let reply = post(&mut outsider, &direct, forward).await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);

    // 系统提示不能转发
    let forward = json!({ "forward": { "conversation_id": group, "seq": 1 } });
    let reply = post(&mut owner, &direct, forward).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::ForwardNotAllowed)
    );
}

#[tokio::test]
async fn a_merged_forward_arrives_as_a_chat_record_with_its_files() {
    let app = common::app().await;
    let (mut owner, mut one, _two, mut outsider, group) = group(&app).await;
    let words = say(&mut one, &group, json!({ "text": "周末去爬山" })).await;
    let file = upload(&mut one, "路线.pdf", "application/pdf", b"%PDF-1.7 map").await;
    let shared = say(&mut one, &group, json!({ "file_id": file.id })).await;

    let request = json!({ "user_id": outsider.me.id });
    let direct = owner
        .client
        .post("/api/conversations/direct", request)
        .await;
    let direct = direct.json::<ConversationView>().id;
    let merge = json!({ "merge": {
        "conversation_id": group,
        "seqs": [shared.seq, words.seq],
        "title": "群聊的聊天记录",
    } });
    let record = say(&mut owner, &direct, merge).await;
    assert_eq!(record.kind, MessageKind::ChatRecord);
    // 文字字段是给搜索用的，不交出来
    assert_eq!(record.text, None);
    let content = record.record.expect("the record");
    assert_eq!(content.title, "群聊的聊天记录");
    let items: Vec<(&str, MessageKind, Option<&str>)> = content
        .items
        .iter()
        .map(|item| (item.sender_name.as_str(), item.kind, item.text.as_deref()))
        .collect();
    assert_eq!(
        items,
        [
            ("成员一", MessageKind::Text, Some("周末去爬山")),
            ("成员一", MessageKind::File, None),
        ]
    );
    assert_eq!(
        content.items[0].sender_id.as_deref(),
        Some(one.me.id.as_str())
    );
    let copied = content.items[1].file.clone().expect("the file inside");
    assert_eq!(copied.name, "路线.pdf");
    assert_ne!(copied.id, file.id);

    // 收到的人读得到里面的文件
    let fetched = outsider
        .client
        .get(&format!("/api/files/{}", copied.id))
        .await;
    assert_eq!(fetched.status, StatusCode::OK);
    assert_eq!(fetched.body, b"%PDF-1.7 map");

    // 搜里面的内容找得到这条聊天记录（"爬山"）
    let found: SearchResult = outsider
        .client
        .get("/api/search?q=%E7%88%AC%E5%B1%B1")
        .await
        .json();
    let kinds: Vec<MessageKind> = found.items.iter().map(|hit| hit.kind).collect();
    assert_eq!(kinds, [MessageKind::ChatRecord]);

    // 标题不能空着
    let merge = json!({ "merge": {
        "conversation_id": group,
        "seqs": [words.seq],
        "title": " ",
    } });
    let reply = post(&mut owner, &direct, merge).await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
}

// ---------- 图片和文件一览（F6） ----------

async fn media(person: &mut Person, conversation: &str, query: &str) -> Reply {
    let path = format!("/api/conversations/{conversation}/media?{query}");
    person.client.get(&path).await
}

#[tokio::test]
async fn the_gallery_lists_pictures_and_files_newest_last_page_by_page() {
    let app = common::app().await;
    let (mut a, mut b, conversation) = pair(&app).await;
    let mut pictures = Vec::new();
    for name in ["one.png", "two.png", "three.png"] {
        let image = upload(&mut a, name, "image/png", &fake_image()).await;
        pictures.push(
            say(&mut a, &conversation, json!({ "file_id": image.id }))
                .await
                .seq,
        );
        say(&mut b, &conversation, json!({ "text": "nice" })).await;
    }
    let notes = upload(&mut b, "notes.txt", "text/plain", b"hello").await;
    let file = say(&mut b, &conversation, json!({ "file_id": notes.id })).await;
    let voice = upload(&mut a, "voice.webm", "audio/webm", WEBM).await;
    say(
        &mut a,
        &conversation,
        json!({ "file_id": voice.id, "voice_duration_ms": 1000 }),
    )
    .await;

    // 最新的两张；还有更早的
    let page: MessageList = media(&mut b, &conversation, "kind=image&limit=2")
        .await
        .json();
    assert_eq!(
        page.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        pictures[1..].to_vec()
    );
    assert!(page.has_more);
    assert!(page.items.iter().all(|m| m.file.is_some()));
    let older: MessageList = media(
        &mut b,
        &conversation,
        &format!("kind=image&limit=2&before={}", pictures[1]),
    )
    .await
    .json();
    assert_eq!(
        older.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        vec![pictures[0]]
    );
    assert!(!older.has_more);

    // 文件只有那一个；语音不算
    let files: MessageList = media(&mut a, &conversation, "kind=file").await.json();
    assert_eq!(
        files.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        vec![file.seq]
    );

    // 撤回了的不列
    recall(&mut a, &conversation, pictures[2]).await;
    let page: MessageList = media(&mut b, &conversation, "kind=image").await.json();
    assert_eq!(
        page.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        pictures[..2].to_vec()
    );

    // 只能是图片或文件；别人的会话看不到
    let reply = media(&mut a, &conversation, "kind=voice").await;
    assert_eq!(reply.status, StatusCode::BAD_REQUEST);
    // 序号从 1 开始；每页 1 到 100 条
    for query in [
        "kind=image&before=0",
        "kind=image&limit=0",
        "kind=image&limit=101",
    ] {
        let reply = media(&mut a, &conversation, query).await;
        assert_eq!(reply.status, StatusCode::BAD_REQUEST, "{query}");
    }
    let page: MessageList = media(&mut a, &conversation, "kind=image&limit=100")
        .await
        .json();
    assert_eq!(page.items.len(), 2);
    let mut stranger = person(&app, "路人").await;
    let reply = media(&mut stranger, &conversation, "kind=image").await;
    assert_eq!(reply.error().code, ErrorCode::ConversationNotFound);
}

#[tokio::test]
async fn a_newcomer_to_a_group_sees_only_the_pictures_sent_after_joining() {
    let app = common::app().await;
    let (mut owner, mut b, mut c, mut newcomer, group) = group(&app).await;
    let before = upload(&mut b, "before.png", "image/png", &fake_image()).await;
    say(&mut b, &group, json!({ "file_id": before.id })).await;

    let path = format!("/api/conversations/{group}/members");
    let reply = owner
        .client
        .post(&path, json!({ "user_ids": [newcomer.me.id] }))
        .await;
    assert!(reply.status.is_success(), "{}", reply.text());
    let after = upload(&mut c, "after.png", "image/png", &fake_image()).await;
    let seen = say(&mut c, &group, json!({ "file_id": after.id })).await;

    let page: MessageList = media(&mut newcomer, &group, "kind=image").await.json();
    assert_eq!(
        page.items.iter().map(|m| m.seq).collect::<Vec<_>>(),
        vec![seen.seq]
    );
    let page: MessageList = media(&mut b, &group, "kind=image").await.json();
    assert_eq!(page.items.len(), 2);
}
