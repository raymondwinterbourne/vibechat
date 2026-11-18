//! 群管理的业务规则的测试：群管理员、禁言、群内昵称、入群审批。数据在内存里，时间可以拨动。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use super::model::JoinRequestStatus;
use super::service::{
    GROUP_MAX_ADMINS, GROUP_NICKNAME_MAX_CHARS, Invited, JOIN_REQUEST_TTL_MS, MUTED_FOREVER,
};
use super::{ChatError, ChatService, Draft, Forwarded, HistoryQuery, MessageKind, Posted};
use crate::account::model::User;
use crate::account::{AccountService, Limits, Registration};
use crate::clock::Clock;
use crate::contact::ContactService;
use crate::ids::{ConversationId, FileId, UserId};
use crate::testing::{ManualClock, MemoryStore, account_service, chat_service, contact_service};

struct Fixture {
    store: Arc<MemoryStore>,
    clock: Arc<ManualClock>,
    accounts: AccountService,
    contacts: ContactService,
    chat: ChatService,
    counter: AtomicU32,
}

async fn fixture() -> Fixture {
    let store = MemoryStore::new();
    let clock = Arc::new(ManualClock::new(1_700_000_000_000));
    let limits = Limits {
        logins_per_minute: 1000,
        registrations_per_minute: 1000,
    };
    Fixture {
        accounts: account_service(&store, clock.clone(), limits).await,
        contacts: contact_service(&store, clock.clone()),
        chat: chat_service(&store, clock.clone()),
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

    async fn befriend(&self, a: &User, b: &User) {
        let sent = self.contacts.send_request(a, b.id, "").await.unwrap();
        let request = sent.request.id;
        self.contacts.accept_request(b, request).await.unwrap();
    }

    /// 群主和 `count` 个成员（都是群主的好友）建的群。
    async fn group(&self, count: usize) -> (User, Vec<User>, ConversationId) {
        let owner = self.user("群主").await;
        let mut members = Vec::new();
        for n in 0..count {
            let member = self.user(&format!("成员{}", n + 1)).await;
            self.befriend(&owner, &member).await;
            members.push(member);
        }
        let ids: Vec<UserId> = members.iter().map(|user| user.id).collect();
        let created = self.chat.create_group(&owner, "", &ids).await.unwrap();
        (owner, members, created.message.conversation)
    }

    async fn say(
        &self,
        from: &User,
        group: ConversationId,
        text: &str,
    ) -> Result<Posted, ChatError> {
        let client_id = format!("c-{}", self.next());
        self.chat.send_text(from, group, &client_id, text).await
    }

    async fn admins(&self, me: &User, group: ConversationId) -> Vec<UserId> {
        let info = self.chat.conversation(me, group).await.unwrap();
        let mut admins = info.group.unwrap().admins;
        admins.sort();
        admins
    }

    /// 我在这个群里被禁言到什么时候。
    async fn my_mute(&self, me: &User, group: ConversationId) -> Option<i64> {
        let info = self.chat.conversation(me, group).await.unwrap();
        info.group.unwrap().muted_until
    }

    async fn promote(&self, owner: &User, group: ConversationId, user: &User) -> Posted {
        let set = self.chat.set_admin(owner, group, user.id, true).await;
        set.unwrap().expect("an admin was added")
    }
}

fn sorted(users: &[&User]) -> Vec<UserId> {
    let mut ids: Vec<UserId> = users.iter().map(|user| user.id).collect();
    ids.sort();
    ids
}

// ---------- 群管理员 ----------

#[tokio::test]
async fn the_owner_appoints_up_to_three_admins_and_everyone_sees_it() {
    let f = fixture().await;
    let (owner, members, group) = f.group(5).await;
    let [a, b, c, d, _] = [0, 1, 2, 3, 4].map(|n| &members[n]);

    let posted = f.promote(&owner, group, a).await;
    assert_eq!(posted.message.kind, MessageKind::AdminAdded);
    assert_eq!(posted.message.data.actor.as_ref().unwrap().id, owner.id);
    assert_eq!(posted.message.data.targets[0].id, a.id);
    assert_eq!(posted.members.len(), 6);
    // 已经是的，再设一次什么也不做
    let again = f.chat.set_admin(&owner, group, a.id, true).await.unwrap();
    assert!(again.is_none());

    f.promote(&owner, group, b).await;
    f.promote(&owner, group, c).await;
    assert_eq!(f.admins(d, group).await, sorted(&[a, b, c]));
    let err = f
        .chat
        .set_admin(&owner, group, d.id, true)
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ChatError::TooManyAdmins {
            max: GROUP_MAX_ADMINS
        }
    ));

    // 成员名单上标着谁是管理员
    let list = f.chat.members(d, group).await.unwrap();
    let flagged: Vec<UserId> = list
        .iter()
        .filter(|member| member.is_admin)
        .map(|member| member.card.id)
        .collect();
    assert_eq!(flagged.len(), 3);

    // 取消一名，就又有位置了
    let removed = f.chat.set_admin(&owner, group, c.id, false).await.unwrap();
    assert_eq!(removed.unwrap().message.kind, MessageKind::AdminRemoved);
    f.promote(&owner, group, d).await;
    assert_eq!(f.admins(&owner, group).await, sorted(&[a, b, d]));
}

#[tokio::test]
async fn only_the_owner_appoints_admins_and_only_members_can_be_appointed() {
    let f = fixture().await;
    let (owner, members, group) = f.group(3).await;
    let [a, b, _] = [0, 1, 2].map(|n| &members[n]);
    f.promote(&owner, group, a).await;

    // 管理员、普通成员都不能设置管理员
    for someone in [a, b] {
        let err = f
            .chat
            .set_admin(someone, group, b.id, true)
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::NotOwner));
    }
    // 群主自己不是管理员；不在群里的人不能设
    let err = f
        .chat
        .set_admin(&owner, group, owner.id, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
    let outsider = f.user("路人").await;
    let err = f
        .chat
        .set_admin(&owner, group, outsider.id, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotMember));
    // 不是管理员的，取消什么也不做
    let nothing = f.chat.set_admin(&owner, group, b.id, false).await.unwrap();
    assert!(nothing.is_none());
}

#[tokio::test]
async fn an_admin_manages_the_group_but_not_the_owner_or_other_admins() {
    let f = fixture().await;
    let (owner, members, group) = f.group(4).await;
    let [admin, other_admin, plain, last] = [0, 1, 2, 3].map(|n| &members[n]);
    f.promote(&owner, group, admin).await;
    f.promote(&owner, group, other_admin).await;

    // 改群名、换头像、发公告、@ 所有人
    f.chat.rename(admin, group, "管理员改的名字").await.unwrap();
    f.chat.require_manager(admin, group).await.unwrap();
    f.chat
        .set_group_avatar(admin, group, FileId::new())
        .await
        .unwrap();
    f.chat.set_notice(admin, group, "周六见").await.unwrap();
    let client_id = format!("c-{}", f.next());
    let everyone = Draft {
        mention_all: true,
        ..Draft::text(&client_id, "大家注意")
    };
    let sent = f.chat.send(admin, group, everyone).await.unwrap();
    assert!(sent.message.data.mention_all);

    // 移出普通成员可以；群主、其他管理员不行
    let removed = f.chat.remove_member(admin, group, plain.id).await.unwrap();
    assert_eq!(removed.message.kind, MessageKind::MemberRemoved);
    for protected in [&owner, other_admin] {
        let err = f
            .chat
            .remove_member(admin, group, protected.id)
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::NotOwner));
    }
    // 转让、解散、设置管理员只有群主能做
    let err = f.chat.transfer(admin, group, last.id).await.unwrap_err();
    assert!(matches!(err, ChatError::NotOwner));
    let err = f.chat.dissolve(admin, group).await.unwrap_err();
    assert!(matches!(err, ChatError::NotOwner));

    // 群主可以移出管理员
    f.chat
        .remove_member(&owner, group, other_admin.id)
        .await
        .unwrap();
    assert_eq!(f.admins(&owner, group).await, sorted(&[admin]));
    // 普通成员什么都不能做
    let err = f.chat.rename(last, group, "不行").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let err = f
        .chat
        .remove_member(last, group, admin.id)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
}

#[tokio::test]
async fn leaving_or_becoming_owner_ends_being_an_admin() {
    let f = fixture().await;
    let (owner, members, group) = f.group(3).await;
    let [a, b, c] = [0, 1, 2].map(|n| &members[n]);
    f.promote(&owner, group, a).await;
    f.promote(&owner, group, b).await;

    // 转让给一名管理员：他成了群主，不再是管理员；原来的群主是普通成员
    f.chat.transfer(&owner, group, a.id).await.unwrap();
    assert_eq!(f.admins(c, group).await, sorted(&[b]));
    let err = f.chat.rename(&owner, group, "不行").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));

    // 退群的管理员不再是；回来之后也不是
    f.chat.leave(b, group).await.unwrap();
    assert!(f.admins(c, group).await.is_empty());
    f.chat.invite(a, group, &[b.id]).await.unwrap_err();
    f.befriend(a, b).await;
    f.chat.invite(a, group, &[b.id]).await.unwrap();
    assert!(f.admins(c, group).await.is_empty());
    let err = f.chat.rename(b, group, "不行").await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    f.say(b, group, "我回来了").await.unwrap();
}

// ---------- 禁言 ----------

const MINUTE: i64 = 60_000;

#[tokio::test]
async fn a_muted_member_cannot_speak_recall_or_forward_in_until_the_time_is_up() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let [muted, other] = [0, 1].map(|n| &members[n]);
    let earlier = f.say(muted, group, "说过的话").await.unwrap().message;
    let now = f.clock.now_ms();

    let posted = f
        .chat
        .mute_member(&owner, group, muted.id, Some(10))
        .await
        .unwrap();
    assert_eq!(posted.message.kind, MessageKind::MemberMuted);
    assert_eq!(posted.message.data.targets[0].id, muted.id);
    assert_eq!(posted.message.data.until, Some(now + 10 * MINUTE));
    assert_eq!(f.my_mute(muted, group).await, Some(now + 10 * MINUTE));
    assert_eq!(f.my_mute(other, group).await, None);
    let listed = f.chat.members(other, group).await.unwrap();
    let flagged = listed.iter().find(|m| m.card.id == muted.id).unwrap();
    assert_eq!(flagged.muted_until, Some(now + 10 * MINUTE));

    // 发消息、撤回、从别处转发进来都不行
    let err = f.say(muted, group, "我还能说话吗").await.unwrap_err();
    assert!(matches!(err, ChatError::Muted { until } if until == now + 10 * MINUTE));
    let err = f.chat.recall(muted, group, earlier.seq).await.unwrap_err();
    assert!(matches!(err, ChatError::Muted { .. }));
    let direct = f
        .chat
        .open_direct(muted, owner.id)
        .await
        .unwrap()
        .conversation
        .id;
    let note = f.say(muted, direct, "转过去").await.unwrap().message;
    let client_id = format!("c-{}", f.next());
    let forward = Draft {
        forward: Some(Forwarded {
            conversation: direct,
            seq: note.seq,
        }),
        ..Draft::text(&client_id, "")
    };
    let err = f.chat.send(muted, group, forward).await.unwrap_err();
    assert!(matches!(err, ChatError::Muted { .. }));
    // 别的人照常；他自己还能看、能退群
    f.say(other, group, "我可以").await.unwrap();
    f.chat.conversation(muted, group).await.unwrap();

    // 时间到了自然解除
    f.clock.advance(10 * MINUTE);
    assert_eq!(f.my_mute(muted, group).await, None);
    f.say(muted, group, "我回来了").await.unwrap();
    f.chat.leave(muted, group).await.unwrap();
}

#[tokio::test]
async fn owners_and_admins_mute_ordinary_members_only() {
    let f = fixture().await;
    let (owner, members, group) = f.group(3).await;
    let [admin, plain, another] = [0, 1, 2].map(|n| &members[n]);
    f.promote(&owner, group, admin).await;

    // 普通成员不能禁言别人
    let err = f
        .chat
        .mute_member(plain, group, another.id, Some(10))
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    // 群主和管理员不能被禁言，谁来都不行
    for (by, target) in [(admin, &owner), (&owner, admin), (admin, admin)] {
        let err = f
            .chat
            .mute_member(by, group, target.id, Some(10))
            .await
            .unwrap_err();
        assert!(matches!(err, ChatError::CannotMuteManager));
    }
    // 只能选那几种时长；不选是直到解除
    let err = f
        .chat
        .mute_member(admin, group, plain.id, Some(5))
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
    let posted = f
        .chat
        .mute_member(admin, group, plain.id, None)
        .await
        .unwrap();
    assert_eq!(posted.message.data.until, Some(MUTED_FOREVER));
    f.clock.advance(365 * 24 * 60 * MINUTE);
    assert!(f.say(plain, group, "一年了").await.is_err());

    // 提前解除
    let lifted = f.chat.unmute_member(&owner, group, plain.id).await.unwrap();
    assert_eq!(lifted.unwrap().message.kind, MessageKind::MemberUnmuted);
    f.say(plain, group, "终于").await.unwrap();
    let nothing = f.chat.unmute_member(&owner, group, plain.id).await.unwrap();
    assert!(nothing.is_none());

    // 被禁言的人被设为管理员：禁言跟着解除
    f.chat
        .mute_member(&owner, group, another.id, Some(60))
        .await
        .unwrap();
    f.promote(&owner, group, another).await;
    assert_eq!(f.my_mute(another, group).await, None);
    f.say(another, group, "我是管理员了").await.unwrap();
}

#[tokio::test]
async fn when_everyone_is_muted_only_the_owner_and_admins_speak() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let [admin, plain] = [0, 1].map(|n| &members[n]);
    f.promote(&owner, group, admin).await;

    let err = f.chat.set_all_muted(plain, group, true).await.unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    let posted = f.chat.set_all_muted(admin, group, true).await.unwrap();
    assert_eq!(posted.unwrap().message.kind, MessageKind::AllMuted);
    let info = f.chat.conversation(plain, group).await.unwrap();
    assert!(info.group.unwrap().all_muted);
    // 已经开着的再开一次：什么也不做
    assert!(
        f.chat
            .set_all_muted(&owner, group, true)
            .await
            .unwrap()
            .is_none()
    );

    let err = f.say(plain, group, "说不了").await.unwrap_err();
    assert!(matches!(err, ChatError::AllMuted));
    f.say(admin, group, "管理员可以").await.unwrap();
    f.say(&owner, group, "群主可以").await.unwrap();

    let posted = f.chat.set_all_muted(&owner, group, false).await.unwrap();
    assert_eq!(posted.unwrap().message.kind, MessageKind::AllUnmuted);
    f.say(plain, group, "又能说了").await.unwrap();
}

// ---------- 群内昵称 ----------

#[tokio::test]
async fn a_member_sets_their_own_group_nickname_and_the_group_uses_it() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let [me, other] = [0, 1].map(|n| &members[n]);
    let said = f.say(me, group, "第一句").await.unwrap();
    assert_eq!(said.sender_name.as_deref(), Some("成员1"));

    // 去掉首尾空白；告诉群里所有人
    let notify = f
        .chat
        .set_group_nickname(me, group, "  爬山队长 ")
        .await
        .unwrap();
    assert_eq!(notify.unwrap().len(), 3);
    let listed = f.chat.members(other, group).await.unwrap();
    let mine = listed.iter().find(|m| m.card.id == me.id).unwrap();
    assert_eq!(mine.group_nickname.as_deref(), Some("爬山队长"));
    // 和原来一样：什么也不做
    let again = f
        .chat
        .set_group_nickname(me, group, "爬山队长")
        .await
        .unwrap();
    assert!(again.is_none());

    // 消息上方、历史里、会话列表的摘要里，都是群内昵称
    let said = f.say(me, group, "第二句").await.unwrap();
    assert_eq!(said.sender_name.as_deref(), Some("爬山队长"));
    let page = f
        .chat
        .history(other, group, HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(
        page.sender_names.get(&me.id).map(String::as_str),
        Some("爬山队长")
    );
    let info = f.chat.conversation(&owner, group).await.unwrap();
    assert_eq!(info.last_sender_name.as_deref(), Some("爬山队长"));

    // 最多 20 字；只有空白就是去掉
    let long = "长".repeat(GROUP_NICKNAME_MAX_CHARS + 1);
    let err = f
        .chat
        .set_group_nickname(me, group, &long)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::Invalid(_)));
    f.chat.set_group_nickname(me, group, "  ").await.unwrap();
    let listed = f.chat.members(other, group).await.unwrap();
    let mine = listed.iter().find(|m| m.card.id == me.id).unwrap();
    assert_eq!(mine.group_nickname, None);

    // 不在群里的人改不了
    f.chat.leave(other, group).await.unwrap();
    let err = f
        .chat
        .set_group_nickname(other, group, "走了")
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::LeftGroup));
}

// ---------- 入群审批 ----------

impl Fixture {
    /// 群里一个普通成员和他的一个好友（不在群里）。
    async fn friend_of(&self, member: &User, nickname: &str) -> User {
        let friend = self.user(nickname).await;
        self.befriend(member, &friend).await;
        friend
    }

    async fn pending(&self, me: &User, group: ConversationId) -> u32 {
        let info = self.chat.conversation(me, group).await.unwrap();
        info.group.unwrap().pending_requests
    }

    async fn members_count(&self, me: &User, group: ConversationId) -> u32 {
        let info = self.chat.conversation(me, group).await.unwrap();
        info.group.unwrap().member_count
    }
}

#[tokio::test]
async fn with_approval_on_an_ordinary_member_invites_by_request() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let [admin, plain] = [0, 1].map(|n| &members[n]);
    f.promote(&owner, group, admin).await;

    // 普通成员不能开关；管理员可以
    let err = f
        .chat
        .set_join_approval(plain, group, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));
    assert!(f.chat.set_join_approval(admin, group, true).await.unwrap());
    assert!(!f.chat.set_join_approval(&owner, group, true).await.unwrap());

    let guest = f.friend_of(plain, "客人").await;
    let invited = f.chat.invite(plain, group, &[guest.id]).await.unwrap();
    let Invited::Requested { requests, managers } = invited else {
        panic!("expected a request");
    };
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].inviter, plain.id);
    let mut expected = vec![owner.id, admin.id];
    expected.sort();
    let mut managers = managers;
    managers.sort();
    assert_eq!(managers, expected);
    assert_eq!(f.members_count(&owner, group).await, 3);
    assert_eq!(f.pending(&owner, group).await, 1);
    assert_eq!(f.pending(admin, group).await, 1);
    assert_eq!(f.pending(plain, group).await, 0);
    // 再邀请一次不会多出一条
    let again = f.chat.invite(plain, group, &[guest.id]).await.unwrap();
    assert!(matches!(again, Invited::Requested { requests, .. } if requests.is_empty()));

    // 群主和管理员邀请的人直接进来
    let direct = f.friend_of(admin, "直接进").await;
    let joined = f.chat.invite(admin, group, &[direct.id]).await.unwrap();
    assert!(joined.joined().is_some());
    assert_eq!(f.members_count(&owner, group).await, 4);

    // 邀请人只看到自己发出的；管理员看到全部
    let mine = f.chat.join_requests(plain, group).await.unwrap();
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].invitee.id, guest.id);
    assert_eq!(f.chat.join_requests(admin, group).await.unwrap().len(), 1);
    let other = f.friend_of(&owner, "别人").await;
    assert!(f.chat.join_requests(&other, group).await.is_err());
}

#[tokio::test]
async fn a_manager_approves_or_rejects_once_and_old_requests_expire() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let plain = &members[0];
    f.chat.set_join_approval(&owner, group, true).await.unwrap();
    let [first, second, third] = [
        f.friend_of(plain, "一号").await,
        f.friend_of(plain, "二号").await,
        f.friend_of(plain, "三号").await,
    ];
    f.chat
        .invite(plain, group, &[first.id, second.id])
        .await
        .unwrap();
    let listed = f.chat.join_requests(&owner, group).await.unwrap();
    let id_of = |user: &User| {
        listed
            .iter()
            .find(|info| info.invitee.id == user.id)
            .unwrap()
            .request
            .id
    };
    let (first_id, second_id) = (id_of(&first), id_of(&second));

    // 普通成员处理不了
    let err = f
        .chat
        .handle_join_request(plain, group, first_id, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::NotManager));

    // 同意：照"加入"的流程进来，事件里写明邀请人和同意的人；通知群主、管理员和邀请人
    let handled = f
        .chat
        .handle_join_request(&owner, group, first_id, true)
        .await
        .unwrap();
    let event = handled.posted.unwrap().message;
    assert_eq!(event.kind, MessageKind::MemberJoined);
    assert_eq!(event.data.actor.as_ref().unwrap().id, plain.id);
    assert_eq!(event.data.targets[0].id, first.id);
    assert_eq!(event.data.approver.as_ref().unwrap().id, owner.id);
    assert!(handled.notify.contains(&plain.id) && handled.notify.contains(&owner.id));
    assert_eq!(f.members_count(&owner, group).await, 4);
    // 已经处理过的不能再处理
    let err = f
        .chat
        .handle_join_request(&owner, group, first_id, false)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::JoinRequestHandled));

    // 关了审批之后，还没处理的照样能处理：拒绝只改状态
    f.chat
        .set_join_approval(&owner, group, false)
        .await
        .unwrap();
    let handled = f
        .chat
        .handle_join_request(&owner, group, second_id, false)
        .await
        .unwrap();
    assert!(handled.posted.is_none());
    assert_eq!(f.members_count(&owner, group).await, 4);
    let mine = f.chat.join_requests(plain, group).await.unwrap();
    let statuses: Vec<JoinRequestStatus> = mine.iter().map(|info| info.request.status).collect();
    assert!(statuses.contains(&JoinRequestStatus::Approved));
    assert!(statuses.contains(&JoinRequestStatus::Rejected));

    // 7 天没有处理算过期，处理不了，也不挡着再邀请
    f.chat.set_join_approval(&owner, group, true).await.unwrap();
    f.chat.invite(plain, group, &[third.id]).await.unwrap();
    f.clock.advance(JOIN_REQUEST_TTL_MS + 1);
    let listed = f.chat.join_requests(&owner, group).await.unwrap();
    let stale = listed
        .iter()
        .find(|info| info.invitee.id == third.id)
        .unwrap();
    assert_eq!(stale.request.status, JoinRequestStatus::Expired);
    assert_eq!(f.pending(&owner, group).await, 0);
    let err = f
        .chat
        .handle_join_request(&owner, group, stale.request.id, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::JoinRequestHandled));
    let again = f.chat.invite(plain, group, &[third.id]).await.unwrap();
    assert!(matches!(again, Invited::Requested { requests, .. } if requests.len() == 1));
}

#[tokio::test]
async fn approving_checks_the_size_limit_and_leaves_the_request_pending_when_full() {
    let f = fixture().await;
    let (owner, members, group) = f.group(2).await;
    let plain = &members[0];
    f.chat.set_join_approval(&owner, group, true).await.unwrap();
    let guest = f.friend_of(plain, "客人").await;
    f.chat.invite(plain, group, &[guest.id]).await.unwrap();
    let request = f.chat.join_requests(&owner, group).await.unwrap()[0]
        .request
        .id;
    // 群满了：同意不了，申请还在
    crate::settings::SettingsStore::set(
        f.store.as_ref(),
        super::service::GROUP_MAX_MEMBERS_SETTING,
        "3",
    )
    .await
    .unwrap();
    let err = f
        .chat
        .handle_join_request(&owner, group, request, true)
        .await
        .unwrap_err();
    assert!(matches!(err, ChatError::GroupFull { room: 0 }));
    assert_eq!(f.pending(&owner, group).await, 1);
}
