//! 群通话的接口（F10）：发起、邀请、加入、不理会、离开，人数上限，
//! 一个人同一时间只能在一个通话里，通话记录，以及随之发出的推送和对媒体转发服务的要求。

mod common;

use std::sync::Arc;

use axum::http::StatusCode;
use base64::Engine;
use common::{Client, TestApp, app};
use serde_json::json;
use tokio::sync::mpsc::Receiver;
use vibechat_core::call::{DeviceId, Endpoint, LiveKitConfig, MediaError, MediaRooms};
use vibechat_core::settings::SettingsStore;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::{
    AuditPage, CallOutcome, CallView, ConversationRead, ConversationView, ErrorCode,
    FriendRequestResult, GroupCallJoined, GroupCallList, GroupCallView, LimitsView, Me,
    MessageKind, MessageList, MessageView, ServerEvent, SessionList, SettingsView,
};
use vibechat_server::calling;

struct Person {
    client: Client,
    me: Me,
}

async fn person(app: &TestApp, nickname: &str) -> Person {
    let (client, me) = app.user(nickname).await;
    Person { client, me }
}

async fn befriend(a: &mut Person, b: &mut Person) {
    let sent: FriendRequestResult = a
        .client
        .post("/api/friend-requests", json!({ "to": b.me.id }))
        .await
        .json();
    let reply = b
        .client
        .post_empty(&format!("/api/friend-requests/{}/accept", sent.request.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK);
}

/// 配置了媒体转发服务的服务端。
async fn app_with_media() -> TestApp {
    let mut app = app().await;
    let mut config = (*app.state.config).clone();
    config.livekit = Some(LiveKitConfig {
        url: "http://127.0.0.1:7880".to_owned(),
        api_key: "devkey".to_owned(),
        api_secret: "0123456789abcdef0123456789abcdef".to_owned(),
    });
    app.state.config = Arc::new(config);
    app
}

/// 群主和两个成员建一个群；另有一个是群主的好友但不在群里的人。大家都把群里已有的内容看过了。
async fn group(app: &TestApp) -> (Person, Person, Person, Person, String) {
    let mut owner = person(app, "群主").await;
    let mut one = person(app, "成员一").await;
    let mut two = person(app, "成员二").await;
    let mut outsider = person(app, "局外人").await;
    for friend in [&mut one, &mut two, &mut outsider] {
        befriend(&mut owner, friend).await;
    }
    let reply = owner
        .client
        .post(
            "/api/conversations/group",
            json!({ "name": "项目组", "member_ids": [one.me.id, two.me.id] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let id = reply.json::<ConversationView>().id;
    for member in [&mut owner, &mut one, &mut two] {
        let seq = conversation(member, &id).await.last_seq;
        member
            .client
            .post(
                &format!("/api/conversations/{id}/read"),
                json!({ "seq": seq }),
            )
            .await;
    }
    (owner, one, two, outsider, id)
}

async fn conversation(person: &mut Person, id: &str) -> ConversationView {
    let reply = person.client.get(&format!("/api/conversations/{id}")).await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    reply.json()
}

/// 一台设备收到的推送。像一条带着设备编号的 WebSocket 连接那样登记到推送表里。
struct Device {
    name: String,
    events: Receiver<ServerEvent>,
    conn: vibechat_server::ws::ConnId,
    user: UserId,
}

impl Device {
    fn open(app: &TestApp, person: &Person, name: &str) -> Self {
        let user: UserId = person.me.id.parse().unwrap();
        let name = format!("{name}-device");
        let registration = app.state.hub.register_device(
            user,
            SessionId::new(),
            Some(DeviceId::parse(&name).unwrap()),
        );
        Self {
            name,
            events: registration.events,
            conn: registration.conn_id,
            user,
        }
    }

    fn take(&mut self) -> Vec<ServerEvent> {
        std::iter::from_fn(|| self.events.try_recv().ok()).collect()
    }

    /// 这台设备收到的群通话的变化。
    fn calls(&mut self) -> Vec<GroupCallView> {
        self.take()
            .into_iter()
            .filter_map(|event| match event {
                ServerEvent::GroupCallUpdated(call) => Some(call),
                _ => None,
            })
            .collect()
    }

    /// 像 WebSocket 断开那样离开推送表。
    fn close(self, app: &TestApp) {
        app.state.hub.unregister(self.user, self.conn);
        let endpoint = Endpoint {
            user: self.user,
            device: DeviceId::parse(&self.name).unwrap(),
        };
        calling::device_disconnected(&app.state, &endpoint);
    }
}

async fn start(person: &mut Person, group: &str, device: &str, invite: &[&str]) -> common::Reply {
    person
        .client
        .post(
            "/api/group-calls",
            json!({
                "conversation_id": group,
                "device": format!("{device}-device"),
                "invite": invite,
            }),
        )
        .await
}

async fn started(
    person: &mut Person,
    group: &str,
    device: &str,
    invite: &[&str],
) -> GroupCallJoined {
    let reply = start(person, group, device, invite).await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    reply.json()
}

async fn act(person: &mut Person, call: &str, action: &str, device: &str) -> common::Reply {
    person
        .client
        .post(
            &format!("/api/group-calls/{call}/{action}"),
            json!({ "device": format!("{device}-device") }),
        )
        .await
}

fn in_call(call: &GroupCallView) -> Vec<&str> {
    call.participants
        .iter()
        .map(|entry| entry.user_id.as_str())
        .collect()
}

fn ringing(call: &GroupCallView) -> Vec<&str> {
    call.ringing
        .iter()
        .map(|invite| invite.user_id.as_str())
        .collect()
}

fn claims(token: &str) -> serde_json::Value {
    let payload = token.split('.').nth(1).unwrap();
    serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap(),
    )
    .unwrap()
}

async fn last_message(person: &mut Person, group: &str) -> MessageView {
    let list: MessageList = person
        .client
        .get(&format!("/api/conversations/{group}/messages"))
        .await
        .json();
    list.items.last().cloned().unwrap()
}

#[tokio::test]
async fn without_a_media_server_there_are_no_group_calls() {
    let app = app().await;
    let (mut owner, _, _, _, group) = group(&app).await;
    let reply = start(&mut owner, &group, "laptop", &[]).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::SERVICE_UNAVAILABLE, ErrorCode::Unavailable)
    );
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert!(list.calls.is_empty());
}

#[tokio::test]
async fn starting_puts_me_in_rings_the_people_i_picked_and_tells_the_whole_group() {
    let app = app_with_media().await;
    let (mut owner, mut one, mut two, mut outsider, group) = group(&app).await;
    let mut owner_laptop = Device::open(&app, &owner, "laptop");
    let mut one_phone = Device::open(&app, &one, "phone");
    let mut two_phone = Device::open(&app, &two, "phone");
    let mut outsider_phone = Device::open(&app, &outsider, "phone");

    // 要登录
    let reply = app
        .client()
        .post(
            "/api/group-calls",
            json!({ "conversation_id": group, "device": "laptop-device" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
    // 不在群里的人不能发起
    let reply = start(&mut outsider, &group, "phone", &[]).await;
    assert_eq!(reply.status, StatusCode::NOT_FOUND);

    // 只邀请成员一；名单里不在群里的人、不像样的编号不认
    let joined = started(
        &mut owner,
        &group,
        "laptop",
        &[&one.me.id, &outsider.me.id, "nonsense"],
    )
    .await;
    let call = &joined.call;
    assert_eq!(call.conversation_id, group);
    assert_eq!(call.starter_id, owner.me.id);
    assert_eq!(in_call(call), [owner.me.id.as_str()]);
    assert_eq!(call.participants[0].device, "laptop-device");
    assert_eq!(ringing(call), [one.me.id.as_str()]);
    assert_eq!(call.ringing[0].by, owner.me.id);
    assert_eq!(call.ringing[0].until, call.started_at + 30_000);
    assert_eq!(call.limit, 6);
    assert_eq!(call.ended_at, None);

    // 入场凭证：只能进这个通话的房间，身份是我的用户编号，只能发麦克风
    let ticket = &joined.ticket;
    assert_eq!(ticket.room, format!("call-{}", call.id));
    assert_eq!(ticket.identity, owner.me.id);
    assert!(ticket.url.ends_with("/livekit"));
    let claims = claims(&ticket.token);
    assert_eq!(claims["sub"], owner.me.id);
    assert_eq!(claims["video"]["room"], ticket.room);
    // 语音通话：不放行摄像头；共享的屏幕可以（F12）
    assert_eq!(
        claims["video"]["canPublishSources"],
        json!(["microphone", "screen_share"])
    );

    // 群里的每个人都收到了，没被邀请的也是（他要看到"通话进行中"）；不在群里的人没有
    for device in [&mut owner_laptop, &mut one_phone, &mut two_phone] {
        assert_eq!(device.calls(), std::slice::from_ref(call));
    }
    assert!(outsider_phone.calls().is_empty());

    // 页面打开时取"我所在的群里正在进行的通话"
    for member in [&mut owner, &mut one, &mut two] {
        let list: GroupCallList = member.client.get("/api/group-calls").await.json();
        assert_eq!(list.calls, std::slice::from_ref(call));
    }
    let list: GroupCallList = outsider.client.get("/api/group-calls").await.json();
    assert!(list.calls.is_empty());

    // 一个群同一时间只有一个通话
    let reply = start(&mut two, &group, "phone", &[]).await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::GroupCallRunning)
    );
}

#[tokio::test]
async fn people_join_ignore_invite_and_leave_and_the_last_one_out_ends_it_with_a_record() {
    let app = app_with_media().await;
    let (mut owner, mut one, mut two, mut outsider, group) = group(&app).await;
    let mut two_phone = Device::open(&app, &two, "phone");
    let call = started(&mut owner, &group, "laptop", &[&one.me.id, &two.me.id])
        .await
        .call;

    // 不在群里的人：没有这个通话
    let reply = act(&mut outsider, &call.id, "join", "phone").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::NOT_FOUND, ErrorCode::CallNotFound)
    );

    // 成员二不理会邀请：不再响，别人还在响
    let reply = two
        .client
        .post_empty(&format!("/api/group-calls/{}/decline", call.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(
        ringing(&reply.json::<GroupCallView>()),
        [one.me.id.as_str()]
    );

    // 成员一加入：拿到他自己的入场凭证
    app.clock.advance(5_000);
    let reply = act(&mut one, &call.id, "join", "phone").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let joined: GroupCallJoined = reply.json();
    assert_eq!(
        in_call(&joined.call),
        [owner.me.id.as_str(), one.me.id.as_str()]
    );
    assert!(joined.call.ringing.is_empty());
    assert_eq!(joined.ticket.identity, one.me.id);
    assert_eq!(joined.ticket.room, format!("call-{}", call.id));

    // 不在通话里的人不能邀请；通话里的人可以再叫一次成员二
    let reply = two
        .client
        .post(
            &format!("/api/group-calls/{}/invite", call.id),
            json!({ "user_ids": [one.me.id] }),
        )
        .await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::NotInGroupCall)
    );
    two_phone.take();
    let reply = one
        .client
        .post(
            &format!("/api/group-calls/{}/invite", call.id),
            json!({ "user_ids": [two.me.id, outsider.me.id] }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let invited: GroupCallView = reply.json();
    assert_eq!(ringing(&invited), [two.me.id.as_str()]);
    assert_eq!(invited.ringing[0].by, one.me.id);
    assert_eq!(two_phone.calls(), [invited]);

    // 只能在通话里的那一台设备上离开
    let reply = act(&mut owner, &call.id, "leave", "phone").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::FORBIDDEN, ErrorCode::WrongCallDevice)
    );
    assert!(app.rooms.take().is_empty());

    // 发起人离开：通话还在，他被请出房间
    app.clock.advance(60_000);
    let reply = act(&mut owner, &call.id, "leave", "laptop").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let left: GroupCallView = reply.json();
    assert_eq!(in_call(&left), [one.me.id.as_str()]);
    assert_eq!(left.ended_at, None);
    let room = format!("call-{}", call.id);
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", owner.me.id)]);

    // 最后一个人离开：通话结束，房间关闭
    two_phone.take();
    let reply = act(&mut one, &call.id, "leave", "phone").await;
    let ended: GroupCallView = reply.json();
    assert!(ended.participants.is_empty() && ended.ringing.is_empty());
    assert_eq!(ended.ended_at, Some(call.started_at + 65_000));
    assert_eq!(
        app.rooms.take(),
        [
            format!("remove {room} {}", one.me.id),
            format!("close {room}")
        ]
    );
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert!(list.calls.is_empty());
    let reply = act(&mut two, &call.id, "join", "phone").await;
    assert_eq!(reply.error().code, ErrorCode::CallNotFound);

    // 群里留下一条通话记录，记在发起人名下：多久、几个人参加过
    let record = last_message(&mut two, &group).await;
    assert_eq!(record.kind, MessageKind::Call);
    assert_eq!(record.sender_id.as_deref(), Some(owner.me.id.as_str()));
    assert_eq!(record.sender_name.as_deref(), Some("群主"));
    assert_eq!(record.call_outcome, Some(CallOutcome::Completed));
    assert_eq!(record.call_joined, Some(2));
    assert_eq!(record.duration_ms, Some(65_000));
    assert!(!record.call_video);

    // 没参加的人：一条普通的未读。参加了的人：直接算读过，别处的登录也收到"读到这里了"
    assert_eq!(conversation(&mut two, &group).await.unread, 1);
    assert_eq!(conversation(&mut one, &group).await.unread, 0);
    assert_eq!(conversation(&mut owner, &group).await.unread, 0);
    let events = two_phone.take();
    assert!(
        events.iter().any(
            |event| matches!(event, ServerEvent::MsgNew(message) if message.seq == record.seq)
        )
    );
    let read: Vec<&ConversationRead> = events
        .iter()
        .filter_map(|event| match event {
            ServerEvent::ConvRead(read) => Some(read),
            _ => None,
        })
        .collect();
    assert!(
        read.iter()
            .any(|read| read.user_id == one.me.id && read.read_seq == record.seq)
    );
    assert!(read.iter().all(|read| read.user_id != two.me.id));
}

#[tokio::test]
async fn a_video_call_lets_cameras_in_and_says_video_everywhere() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, _, group) = group(&app).await;
    let mut one_phone = Device::open(&app, &one, "phone");

    let reply = owner
        .client
        .post(
            "/api/group-calls",
            json!({
                "conversation_id": group,
                "device": "laptop-device",
                "video": true,
                "invite": [one.me.id],
            }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    let started: GroupCallJoined = reply.json();
    assert!(started.call.video);
    // 入场凭证放行摄像头；别的和语音通话的一样
    let sources = json!(["microphone", "camera", "screen_share"]);
    assert_eq!(
        claims(&started.ticket.token)["video"]["canPublishSources"],
        sources
    );
    // 被邀请的人从推送里知道这是视频通话；"我所在的群里的通话"里也写着
    assert!(one_phone.calls().last().unwrap().video);
    let list: GroupCallList = one.client.get("/api/group-calls").await.json();
    assert!(list.calls[0].video);

    // 加入的人拿到的凭证同样放行摄像头
    let joined: GroupCallJoined = act(&mut one, &started.call.id, "join", "phone")
        .await
        .json();
    assert!(joined.call.video);
    assert_eq!(
        claims(&joined.ticket.token)["video"]["canPublishSources"],
        sources
    );

    // 结束后的通话记录写明是视频
    app.clock.advance(30_000);
    act(&mut one, &started.call.id, "leave", "phone").await;
    act(&mut owner, &started.call.id, "leave", "laptop").await;
    let record = last_message(&mut owner, &group).await;
    assert_eq!(record.kind, MessageKind::Call);
    assert!(record.call_video);
    assert_eq!(record.call_joined, Some(2));
}

#[tokio::test]
async fn a_voice_call_ticket_never_lets_a_camera_in() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, _, group) = group(&app).await;
    // 不带类型的请求（旧的页面）是语音通话
    let started = started(&mut owner, &group, "laptop", &[]).await;
    assert!(!started.call.video);
    let joined: GroupCallJoined = act(&mut one, &started.call.id, "join", "phone")
        .await
        .json();
    for ticket in [&started.ticket, &joined.ticket] {
        assert_eq!(
            claims(&ticket.token)["video"]["canPublishSources"],
            json!(["microphone", "screen_share"])
        );
    }
}

#[tokio::test]
async fn one_person_shares_the_screen_at_a_time_and_everyone_is_told() {
    let app = app_with_media().await;
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let mut two_phone = Device::open(&app, &two, "phone");
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    assert_eq!(call.sharing, None);
    act(&mut one, &call.id, "join", "phone").await;

    // 不在通话里的人不能共享；通话里的人要在自己的那一台设备上
    let reply = act(&mut two, &call.id, "share", "phone").await;
    assert_eq!(reply.error().code, ErrorCode::NotInGroupCall);
    let reply = act(&mut owner, &call.id, "share", "tablet").await;
    assert_eq!(reply.error().code, ErrorCode::WrongCallDevice);

    // 第一个人开始共享：群里的人都知道是谁
    two_phone.take();
    let shared: GroupCallView = act(&mut owner, &call.id, "share", "laptop").await.json();
    assert_eq!(shared.sharing.as_deref(), Some(owner.me.id.as_str()));
    assert_eq!(
        two_phone.calls().last().unwrap().sharing.as_deref(),
        Some(owner.me.id.as_str())
    );
    // 再说一次没有关系
    let again = act(&mut owner, &call.id, "share", "laptop").await;
    assert_eq!(again.status, StatusCode::OK);
    // 别人这时不能共享，也不能替他停
    let reply = act(&mut one, &call.id, "share", "phone").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::GroupCallSharing)
    );
    let untouched: GroupCallView = act(&mut one, &call.id, "unshare", "phone").await.json();
    assert_eq!(untouched.sharing.as_deref(), Some(owner.me.id.as_str()));

    // 他停了，别人就可以了
    let stopped: GroupCallView = act(&mut owner, &call.id, "unshare", "laptop").await.json();
    assert_eq!(stopped.sharing, None);
    let shared: GroupCallView = act(&mut one, &call.id, "share", "phone").await.json();
    assert_eq!(shared.sharing.as_deref(), Some(one.me.id.as_str()));

    // 共享的人离开通话：共享随之结束
    two_phone.take();
    let left: GroupCallView = act(&mut one, &call.id, "leave", "phone").await.json();
    assert_eq!(left.sharing, None);
    assert_eq!(two_phone.calls().last().unwrap().sharing, None);
    // "我所在的群里的通话"里也带着
    act(&mut owner, &call.id, "share", "laptop").await;
    let list: GroupCallList = two.client.get("/api/group-calls").await.json();
    assert_eq!(list.calls[0].sharing.as_deref(), Some(owner.me.id.as_str()));
}

#[tokio::test]
async fn a_sharer_removed_from_the_group_stops_sharing() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, _, group) = group(&app).await;
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    act(&mut one, &call.id, "join", "phone").await;
    act(&mut one, &call.id, "share", "phone").await;
    let reply = owner
        .client
        .delete(&format!("/api/conversations/{group}/members/{}", one.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert_eq!(list.calls[0].sharing, None);
    // 现在别人可以共享了
    let shared: GroupCallView = act(&mut owner, &call.id, "share", "laptop").await.json();
    assert_eq!(shared.sharing.as_deref(), Some(owner.me.id.as_str()));
}

#[tokio::test]
async fn a_call_nobody_else_joined_says_so_in_the_record() {
    let app = app_with_media().await;
    let (mut owner, one, _, _, group) = group(&app).await;
    let call = started(&mut owner, &group, "laptop", &[&one.me.id])
        .await
        .call;
    app.clock.advance(20_000);
    act(&mut owner, &call.id, "leave", "laptop").await;
    let record = last_message(&mut owner, &group).await;
    assert_eq!(record.call_joined, Some(1));
    assert_eq!(record.duration_ms, Some(20_000));
}

#[tokio::test]
async fn the_call_takes_as_many_people_as_the_administrator_allows() {
    let app = app_with_media().await;
    app.store.set("group_call_max", "2").await.unwrap();
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    assert_eq!(call.limit, 2);
    assert_eq!(
        act(&mut one, &call.id, "join", "phone").await.status,
        StatusCode::OK
    );
    let reply = act(&mut two, &call.id, "join", "phone").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::GroupCallFull)
    );
    // 有人离开就又进得去了
    act(&mut one, &call.id, "leave", "phone").await;
    assert_eq!(
        act(&mut two, &call.id, "join", "phone").await.status,
        StatusCode::OK
    );
    // 设得不像样的值不算数，用默认的 6
    app.store.set("group_call_max", "1").await.unwrap();
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert_eq!(list.calls[0].limit, 6);
}

#[tokio::test]
async fn one_person_is_in_one_call_at_a_time_counting_both_kinds() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, mut outsider, group) = group(&app).await;
    let _one_phone = Device::open(&app, &one, "phone");
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    act(&mut one, &call.id, "join", "phone").await;

    // 在别的设备上再加入：不行，那一台还连着
    let reply = act(&mut one, &call.id, "join", "tablet").await;
    assert_eq!(
        (reply.status, reply.error().code),
        (StatusCode::CONFLICT, ErrorCode::AlreadyInCall)
    );

    // 局外人是群主的好友：给正在群通话里的群主打电话，对方忙
    let direct = {
        let list: vibechat_protocol::ConversationList =
            outsider.client.get("/api/conversations").await.json();
        list.items[0].id.clone()
    };
    let reply = outsider
        .client
        .post(
            "/api/calls",
            json!({ "conversation_id": direct, "device": "phone-device" }),
        )
        .await;
    assert_eq!(reply.status, StatusCode::CREATED, "{}", reply.text());
    assert_eq!(reply.json::<CallView>().outcome, Some(CallOutcome::Busy));

    // 群主自己也不能在群通话里再打电话
    let reply = owner
        .client
        .post(
            "/api/calls",
            json!({ "conversation_id": direct, "device": "laptop-device" }),
        )
        .await;
    assert_eq!(reply.error().code, ErrorCode::AlreadyInCall);
}

#[tokio::test]
async fn invitations_stop_ringing_and_devices_gone_too_long_count_as_having_left() {
    let app = app_with_media().await;
    let (mut owner, mut one, two, _, group) = group(&app).await;
    let owner_laptop = Device::open(&app, &owner, "laptop");
    let one_phone = Device::open(&app, &one, "phone");
    let mut two_phone = Device::open(&app, &two, "phone");
    let call = started(&mut owner, &group, "laptop", &[&one.me.id, &two.me.id])
        .await
        .call;
    act(&mut one, &call.id, "join", "phone").await;
    two_phone.take();
    let room = format!("call-{}", call.id);

    // 响了 30 秒：不再响，通话还在
    app.clock.advance(29_000);
    calling::settle(&app.state).await;
    assert!(two_phone.calls().is_empty());
    app.clock.advance(1_000);
    calling::settle(&app.state).await;
    let updates = two_phone.calls();
    assert_eq!(updates.len(), 1);
    assert!(updates[0].ringing.is_empty());
    assert_eq!(updates[0].participants.len(), 2);

    // 成员一的页面关掉了：断开太久算他离开，并且把他请出房间
    one_phone.close(&app);
    app.clock.advance(29_000);
    calling::settle(&app.state).await;
    assert!(two_phone.calls().is_empty());
    app.clock.advance(1_000);
    calling::settle(&app.state).await;
    let updates = two_phone.calls();
    assert_eq!(in_call(&updates[0]), [owner.me.id.as_str()]);
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", one.me.id)]);

    // 刷新之后的页面是另一台设备：通话还在，可以再加入
    assert_eq!(
        act(&mut one, &call.id, "join", "reloaded").await.status,
        StatusCode::OK
    );

    // 群主的页面也关掉了，成员一随后离开：通话结束，留下记录
    owner_laptop.close(&app);
    app.clock.advance(30_000);
    calling::settle(&app.state).await;
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", owner.me.id)]);
    let ended: GroupCallView = act(&mut one, &call.id, "leave", "reloaded").await.json();
    assert!(ended.ended_at.is_some());
    assert_eq!(
        app.rooms.take(),
        [
            format!("remove {room} {}", one.me.id),
            format!("close {room}")
        ]
    );
    assert_eq!(last_message(&mut one, &group).await.call_joined, Some(2));
}

// ---------- 该离开的人立即离开（第三段） ----------

/// 以这个人现在这一次登录的名义登记一台设备：退出登录、被禁用时，服务端要找得到它。
async fn device_of_session(app: &TestApp, person: &mut Person, name: &str) -> Device {
    let list: SessionList = person.client.get("/api/me/sessions").await.json();
    let session: SessionId = list
        .items
        .iter()
        .find(|item| item.current)
        .unwrap()
        .id
        .parse()
        .unwrap();
    let user: UserId = person.me.id.parse().unwrap();
    let name = format!("{name}-device");
    let registration =
        app.state
            .hub
            .register_device(user, session, Some(DeviceId::parse(&name).unwrap()));
    Device {
        name,
        events: registration.events,
        conn: registration.conn_id,
        user,
    }
}

#[tokio::test]
async fn someone_removed_from_the_group_leaves_its_call_at_once_and_is_told() {
    let app = app_with_media().await;
    let (mut owner, mut one, two, _, group) = group(&app).await;
    let mut owner_laptop = Device::open(&app, &owner, "laptop");
    let mut one_phone = Device::open(&app, &one, "phone");
    let mut two_phone = Device::open(&app, &two, "phone");
    // 成员一进了通话，成员二正在被邀请
    let call = started(&mut owner, &group, "laptop", &[&one.me.id, &two.me.id])
        .await
        .call;
    act(&mut one, &call.id, "join", "phone").await;
    let room = format!("call-{}", call.id);
    for device in [&mut owner_laptop, &mut one_phone, &mut two_phone] {
        device.take();
    }
    app.rooms.take();

    // 群主把成员一移出群：他马上不在通话里了，并且被请出房间
    let reply = owner
        .client
        .delete(&format!("/api/conversations/{group}/members/{}", one.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", one.me.id)]);
    let seen = owner_laptop.calls();
    assert_eq!(seen.len(), 1);
    assert_eq!(in_call(&seen[0]), [owner.me.id.as_str()]);
    // 他自己被单独告知：先是通话里没有他了，再是这个通话对他来说没有了
    let told = one_phone.calls();
    assert_eq!(told.len(), 2);
    assert_eq!(in_call(&told[0]), [owner.me.id.as_str()]);
    assert_eq!(told[0].ended_at, None);
    assert!(told[1].ended_at.is_some() && told[1].participants.is_empty());
    // 他再也拿不到入场凭证
    let reply = act(&mut one, &call.id, "join", "phone").await;
    assert_eq!(reply.error().code, ErrorCode::CallNotFound);

    // 把正在被邀请的成员二也移出群：邀请作废，他那里不再显示这个通话
    two_phone.take();
    owner
        .client
        .delete(&format!("/api/conversations/{group}/members/{}", two.me.id))
        .await;
    let told = two_phone.calls();
    assert_eq!(told.len(), 2);
    assert!(told[0].ringing.is_empty());
    assert!(told[1].ended_at.is_some());
    // 通话本身还在，群主一个人
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert_eq!(in_call(&list.calls[0]), [owner.me.id.as_str()]);
}

#[tokio::test]
async fn leaving_the_group_takes_me_out_of_its_call() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, _, group) = group(&app).await;
    let mut one_phone = Device::open(&app, &one, "phone");
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    act(&mut one, &call.id, "join", "phone").await;
    one_phone.take();
    app.rooms.take();

    let reply = one
        .client
        .post_empty(&format!("/api/conversations/{group}/leave"))
        .await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());
    assert_eq!(
        app.rooms.take(),
        [format!("remove call-{} {}", call.id, one.me.id)]
    );
    assert_eq!(one_phone.calls().len(), 2);
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert_eq!(in_call(&list.calls[0]), [owner.me.id.as_str()]);
    // 没有通话的群里有人退群：什么都不用做
    act(&mut owner, &call.id, "leave", "laptop").await;
    app.rooms.take();
}

#[tokio::test]
async fn dissolving_the_group_ends_its_call_and_keeps_the_record() {
    let app = app_with_media().await;
    let (mut owner, mut one, _, _, group) = group(&app).await;
    let mut one_phone = Device::open(&app, &one, "phone");
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    act(&mut one, &call.id, "join", "phone").await;
    one_phone.take();
    app.rooms.take();
    app.clock.advance(12_000);

    let reply = owner
        .client
        .post_empty(&format!("/api/conversations/{group}/dissolve"))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(app.rooms.take(), [format!("close call-{}", call.id)]);
    let told = one_phone.calls();
    assert_eq!(told.len(), 1);
    assert!(told[0].ended_at.is_some());
    let list: GroupCallList = owner.client.get("/api/group-calls").await.json();
    assert!(list.calls.is_empty());
    let record = last_message(&mut one, &group).await;
    assert_eq!(record.kind, MessageKind::Call);
    assert_eq!(record.call_joined, Some(2));
    assert_eq!(record.duration_ms, Some(12_000));
}

#[tokio::test]
async fn a_device_that_is_signed_out_or_whose_user_is_disabled_leaves_the_call_at_once() {
    let app = app_with_media().await;
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let mut owner_laptop = Device::open(&app, &owner, "laptop");
    // 这两台设备挂在各自现在的这一次登录上
    let _one_phone = device_of_session(&app, &mut one, "phone").await;
    let _two_phone = device_of_session(&app, &mut two, "phone").await;
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    act(&mut one, &call.id, "join", "phone").await;
    act(&mut two, &call.id, "join", "phone").await;
    let room = format!("call-{}", call.id);
    owner_laptop.take();
    app.rooms.take();

    // 成员一退出登录：不用等"设备断开太久"，马上不在通话里了
    let reply = one.client.post_empty("/api/auth/logout").await;
    assert_eq!(reply.status, StatusCode::NO_CONTENT, "{}", reply.text());
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", one.me.id)]);
    let seen = owner_laptop.calls();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        in_call(&seen[0]),
        [owner.me.id.as_str(), two.me.id.as_str()]
    );

    // 管理员禁用成员二：同样马上离开
    let mut admin = app.admin().await;
    let reply = admin
        .post_empty(&format!("/api/admin/users/{}/disable", two.me.id))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(app.rooms.take(), [format!("remove {room} {}", two.me.id)]);
    let seen = owner_laptop.calls();
    assert_eq!(in_call(seen.last().unwrap()), [owner.me.id.as_str()]);
}

#[tokio::test]
async fn the_administrator_sets_how_many_people_a_group_call_takes() {
    let app = app_with_media().await;
    let (mut owner, mut one, mut two, _, group) = group(&app).await;
    let mut admin = app.admin().await;

    // 默认 6 人，可以设 2 到 20
    let settings: SettingsView = admin.get("/api/admin/settings").await.json();
    assert_eq!(settings.group_call_max, 6);
    assert_eq!(
        (
            settings.group_call_max_range.min,
            settings.group_call_max_range.max,
            settings.group_call_max_range.default
        ),
        (2, 20, Some(6))
    );
    for bad in [1, 21] {
        let reply = admin
            .put("/api/admin/settings", json!({ "group_call_max": bad }))
            .await;
        assert_eq!(reply.error().code, ErrorCode::SettingOutOfRange);
    }
    let reply = admin
        .put("/api/admin/settings", json!({ "group_call_max": 2 }))
        .await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    assert_eq!(reply.json::<SettingsView>().group_call_max, 2);

    // 改完立即生效：页面取到的上限、通话里带着的上限、第三个人进不去
    let limits: LimitsView = owner.client.get("/api/limits").await.json();
    assert_eq!(limits.group_call_max, 2);
    let call = started(&mut owner, &group, "laptop", &[]).await.call;
    assert_eq!(call.limit, 2);
    act(&mut one, &call.id, "join", "phone").await;
    let reply = act(&mut two, &call.id, "join", "phone").await;
    assert_eq!(reply.error().code, ErrorCode::GroupCallFull);

    // 这一次修改记进了操作记录
    let audit: AuditPage = admin.get("/api/admin/audit").await.json();
    let entry = &audit.items[0];
    assert_eq!(entry.key.as_deref(), Some("group_call_max"));
    assert_eq!(
        (entry.from.as_deref(), entry.to.as_deref()),
        (Some("6"), Some("2"))
    );
}

/// 很慢的媒体转发服务：测试拿着 [`SlowRooms::hold`] 交回的东西时，请求都停在门口，放下之后才回答。
#[derive(Default)]
struct SlowRooms {
    gate: tokio::sync::RwLock<()>,
    waiting: tokio::sync::Notify,
}

impl SlowRooms {
    async fn hold(&self) -> tokio::sync::RwLockWriteGuard<'_, ()> {
        self.gate.write().await
    }

    /// 等到有请求停在门口。
    async fn someone_waiting(&self) {
        self.waiting.notified().await;
    }

    async fn door(&self) {
        self.waiting.notify_one();
        let _open = self.gate.read().await;
    }
}

#[async_trait::async_trait]
impl MediaRooms for SlowRooms {
    async fn remove(&self, _room: &str, _identity: &str) -> Result<(), MediaError> {
        self.door().await;
        Ok(())
    }

    async fn close(&self, _room: &str) -> Result<(), MediaError> {
        self.door().await;
        Ok(())
    }
}

/// 页面刷新、关掉时发出"离开"，浏览器不等回答就把页面丢了：服务端照样做完，别人那里知道他走了。
#[tokio::test]
async fn leaving_completes_even_when_the_page_is_gone_before_the_answer() {
    let mut app = app_with_media().await;
    let rooms = Arc::new(SlowRooms::default());
    app.state.rooms = rooms.clone();
    let (mut owner, mut one, _, _, group) = group(&app).await;
    let mut owner_device = Device::open(&app, &owner, "owner");
    let _one_device = Device::open(&app, &one, "one");
    let call = started(&mut owner, &group, "owner", &[]).await.call;
    let reply = act(&mut one, &call.id, "join", "one").await;
    assert_eq!(reply.status, StatusCode::OK, "{}", reply.text());
    owner_device.take();

    // 媒体转发服务很慢：服务端已经把他从通话里拿掉，正在请媒体转发服务把他请出房间
    let slow = rooms.hold().await;
    let leaving = act(&mut one, &call.id, "leave", "one");
    tokio::select! {
        _ = leaving => panic!("leaving cannot finish while the media server is held"),
        () = rooms.someone_waiting() => {}
    }
    // 走到这里时页面已经不等了（上面那个请求被扔掉了）；媒体转发服务这才回答
    drop(slow);

    let told = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(ServerEvent::GroupCallUpdated(call)) = owner_device.events.recv().await {
                return call;
            }
        }
    })
    .await
    .expect("the others are told that he left");
    assert_eq!(in_call(&told), [owner.me.id.as_str()]);
}
