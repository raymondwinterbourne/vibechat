use std::sync::Arc;

use super::calls::*;
use super::group::*;
use crate::ids::{CallId, ConversationId, UserId};
use crate::testing::ManualClock;

const LIMIT: usize = 6;

struct World {
    clock: Arc<ManualClock>,
    calls: Calls,
    group: ConversationId,
    alice: UserId,
    bob: UserId,
    carol: UserId,
    dave: UserId,
}

fn world() -> World {
    let clock = Arc::new(ManualClock::new(1_000_000));
    World {
        calls: Calls::new(clock.clone(), CallSettings::default()),
        clock,
        group: ConversationId::new(),
        alice: UserId::new(),
        bob: UserId::new(),
        carol: UserId::new(),
        dave: UserId::new(),
    }
}

fn device(user: UserId, name: &str) -> Endpoint {
    Endpoint {
        user,
        device: DeviceId::parse(&format!("{name}-device")).unwrap(),
    }
}

fn in_call(call: &GroupCall) -> Vec<UserId> {
    call.participants.iter().map(|entry| entry.user).collect()
}

fn ringing(call: &GroupCall) -> Vec<UserId> {
    call.ringing.iter().map(|invite| invite.user).collect()
}

impl World {
    /// alice 在笔记本上发起，邀请 bob 和 carol。
    fn started(&self) -> GroupCall {
        self.calls
            .start_group(
                device(self.alice, "laptop"),
                self.group,
                false,
                &[self.bob, self.carol],
            )
            .unwrap()
    }

    fn join(&self, user: UserId, name: &str, id: CallId) -> Result<GroupCall, GroupCallError> {
        self.calls.join_group(device(user, name), id, LIMIT)
    }
}

#[test]
fn the_starter_is_in_the_call_and_the_people_he_picked_ring() {
    let w = world();
    let call = w.started();
    assert_eq!(call.conversation, w.group);
    assert_eq!(call.starter, w.alice);
    assert_eq!(call.started_at, 1_000_000);
    assert_eq!(in_call(&call), [w.alice]);
    assert_eq!(call.participants[0].device.as_str(), "laptop-device");
    assert_eq!(ringing(&call), [w.bob, w.carol]);
    // 响 30 秒；谁邀请的记着
    assert!(
        call.ringing
            .iter()
            .all(|invite| invite.by == w.alice && invite.until == 1_030_000)
    );
    assert_eq!(call.joined, [w.alice]);
    assert!(!call.ended());
    assert_eq!(w.calls.group_call(call.id), Some(call.clone()));
    assert_eq!(w.calls.group_call_in(w.group), Some(call.clone()));
    assert_eq!(w.calls.group_calls(), [call]);
    assert_eq!(w.calls.count(), 1);
}

#[test]
fn a_call_is_voice_or_video_from_the_start_and_stays_that_way() {
    let w = world();
    let voice = w.started();
    assert!(!voice.video);
    w.calls
        .leave_group(&device(w.alice, "laptop"), voice.id)
        .unwrap();

    let video = w
        .calls
        .start_group(device(w.alice, "laptop"), w.group, true, &[w.bob])
        .unwrap();
    assert!(video.video);
    // 有人进来、有人离开，直到结束，它一直是视频通话
    let joined = w.join(w.bob, "phone", video.id).unwrap();
    assert!(joined.video);
    let left = w
        .calls
        .leave_group(&device(w.alice, "laptop"), video.id)
        .unwrap();
    assert!(left.video);
    let ended = w
        .calls
        .leave_group(&device(w.bob, "phone"), video.id)
        .unwrap();
    assert!(ended.ended() && ended.video);
}

#[test]
fn inviting_myself_or_nobody_rings_nobody() {
    let w = world();
    let call = w
        .calls
        .start_group(device(w.alice, "laptop"), w.group, false, &[w.alice])
        .unwrap();
    assert!(call.ringing.is_empty());
}

#[test]
fn a_group_has_one_call_at_a_time() {
    let w = world();
    let call = w.started();
    // bob 想再发起一个：告诉他已经有了，去加入那一个
    assert_eq!(
        w.calls
            .start_group(device(w.bob, "phone"), w.group, false, &[])
            .unwrap_err(),
        GroupCallError::AlreadyRunning(call.id)
    );
    // 别的群不受影响
    assert!(
        w.calls
            .start_group(device(w.bob, "phone"), ConversationId::new(), false, &[])
            .is_ok()
    );
}

#[test]
fn people_join_whether_invited_or_not_and_stop_ringing() {
    let w = world();
    let call = w.started();
    w.clock.advance(5_000);
    let call = w.join(w.bob, "phone", call.id).unwrap();
    assert_eq!(in_call(&call), [w.alice, w.bob]);
    assert_eq!(call.participants[1].joined_at, 1_005_000);
    assert_eq!(ringing(&call), [w.carol]);
    // dave 没有被邀请，也能进来
    let call = w.join(w.dave, "phone", call.id).unwrap();
    assert_eq!(in_call(&call), [w.alice, w.bob, w.dave]);
    assert_eq!(call.joined, [w.alice, w.bob, w.dave]);
}

#[test]
fn the_invitation_stops_ringing_after_a_while_but_joining_stays_possible() {
    let w = world();
    let call = w.started();
    w.clock.advance(29_000);
    assert!(w.calls.sweep_groups().is_empty());
    w.clock.advance(1_000);
    let changed = w.calls.sweep_groups();
    assert_eq!(changed.len(), 1);
    assert!(changed[0].call.ringing.is_empty());
    assert!(changed[0].left.is_empty());
    assert!(!changed[0].call.ended());
    // 没什么可结算的了
    assert!(w.calls.sweep_groups().is_empty());
    assert_eq!(
        in_call(&w.join(w.carol, "phone", call.id).unwrap()),
        [w.alice, w.carol]
    );
}

#[test]
fn ignoring_the_invitation_stops_my_ringing_only() {
    let w = world();
    let call = w.started();
    let call = w.calls.decline_group(w.bob, call.id).unwrap();
    assert_eq!(ringing(&call), [w.carol]);
    // 再点一次、没被邀请的人点：什么都不变
    assert_eq!(w.calls.decline_group(w.bob, call.id).unwrap(), call);
    assert_eq!(w.calls.decline_group(w.dave, call.id).unwrap(), call);
    // 之后仍然可以加入
    assert!(w.join(w.bob, "phone", call.id).is_ok());
}

#[test]
fn the_call_is_full_at_the_limit() {
    let w = world();
    let call = w.started();
    assert_eq!(
        w.calls.join_group(device(w.bob, "phone"), call.id, 1),
        Err(GroupCallError::Full)
    );
    assert!(
        w.calls
            .join_group(device(w.bob, "phone"), call.id, 2)
            .is_ok()
    );
    assert_eq!(
        w.calls.join_group(device(w.carol, "phone"), call.id, 2),
        Err(GroupCallError::Full)
    );
    // 人满时已经在里面的人不受影响：再点一次加入照样是他
    assert!(
        w.calls
            .join_group(device(w.bob, "phone"), call.id, 2)
            .is_ok()
    );
}

#[test]
fn someone_in_the_call_can_ring_more_people() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    w.clock.advance(40_000);
    w.calls.sweep_groups();
    // bob 再叫一次 carol，顺便叫 dave；alice 已经在里面，不响
    let call = w
        .calls
        .invite_to_group(w.bob, call.id, &[w.carol, w.dave, w.alice])
        .unwrap();
    assert_eq!(ringing(&call), [w.carol, w.dave]);
    assert!(
        call.ringing
            .iter()
            .all(|invite| invite.by == w.bob && invite.until == 1_070_000)
    );
    // 已经在响的重新计时，不会响两份
    w.clock.advance(10_000);
    let call = w
        .calls
        .invite_to_group(w.alice, call.id, &[w.carol])
        .unwrap();
    assert_eq!(ringing(&call), [w.dave, w.carol]);
    assert_eq!(call.ringing[1].until, 1_080_000);
    // 不在通话里的人不能邀请
    assert_eq!(
        w.calls.invite_to_group(w.dave, call.id, &[w.carol]),
        Err(GroupCallError::NotInCall)
    );
}

#[test]
fn everyone_leaves_for_himself_and_the_last_one_out_ends_the_call() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    w.clock.advance(60_000);
    // 只能在通话里的那一台设备上离开；不在通话里的人没有什么可离开的
    assert_eq!(
        w.calls.leave_group(&device(w.alice, "phone"), call.id),
        Err(GroupCallError::WrongDevice)
    );
    assert_eq!(
        w.calls.leave_group(&device(w.carol, "phone"), call.id),
        Err(GroupCallError::NotInCall)
    );
    // 发起人走了，通话还在
    let left = w
        .calls
        .leave_group(&device(w.alice, "laptop"), call.id)
        .unwrap();
    assert_eq!(in_call(&left), [w.bob]);
    assert!(!left.ended());
    // 只剩一个人：不自动结束（这一次结算到的只是 carol 的邀请过期了）
    w.clock.advance(600_000);
    let changed = w.calls.sweep_groups();
    assert_eq!(changed.len(), 1);
    assert_eq!(in_call(&changed[0].call), [w.bob]);
    assert!(changed[0].call.ringing.is_empty());
    assert!(w.calls.sweep_groups().is_empty());
    // 最后一个人离开：结束
    let ended = w
        .calls
        .leave_group(&device(w.bob, "phone"), call.id)
        .unwrap();
    assert!(ended.participants.is_empty());
    assert!(ended.ringing.is_empty());
    assert_eq!(ended.ended_at, Some(1_660_000));
    assert_eq!(ended.duration_ms(), Some(660_000));
    assert_eq!(ended.joined, [w.alice, w.bob]);
    assert_eq!(w.calls.group_call(call.id), None);
    assert_eq!(w.calls.count(), 0);
    assert_eq!(
        w.join(w.carol, "phone", call.id),
        Err(GroupCallError::NotFound)
    );
    // 群里可以再发起一个
    assert!(
        w.calls
            .start_group(device(w.carol, "phone"), w.group, false, &[])
            .is_ok()
    );
}

#[test]
fn one_person_is_in_one_call_at_a_time_counting_both_kinds() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    let chat = ConversationId::new();
    // 在群通话里的人：别人给他打一对一电话，对方忙
    let busy = w
        .calls
        .start(device(w.dave, "phone"), chat, w.bob, true, false)
        .unwrap();
    assert_eq!(busy.outcome(), Some(CallOutcome::Busy));
    // 他自己也不能再打一对一电话、不能发起或加入别的群通话
    assert_eq!(
        w.calls
            .start(device(w.bob, "phone"), chat, w.dave, true, false),
        Err(CallError::AlreadyInCall)
    );
    let other = w
        .calls
        .start_group(
            device(w.dave, "phone"),
            ConversationId::new(),
            false,
            &[w.bob, w.carol],
        )
        .unwrap();
    // 邀请正在通话的人：不响
    assert_eq!(ringing(&other), [w.carol]);
    assert_eq!(
        w.join(w.bob, "phone", other.id),
        Err(GroupCallError::AlreadyInCall)
    );
    assert_eq!(
        w.calls
            .start_group(device(w.bob, "phone"), ConversationId::new(), false, &[]),
        Err(GroupCallError::AlreadyInCall)
    );

    // 在一对一通话里的人不能加入群通话
    let eve = UserId::new();
    let frank = UserId::new();
    w.calls
        .start(device(eve, "phone"), chat, frank, true, false)
        .unwrap();
    assert_eq!(
        w.join(eve, "phone", call.id),
        Err(GroupCallError::AlreadyInCall)
    );
    assert_eq!(
        w.join(frank, "phone", call.id),
        Err(GroupCallError::AlreadyInCall)
    );

    // 只是被邀请、还没进去的人不算在通话里：照常能接电话
    let ringing_carol = w
        .calls
        .start(device(UserId::new(), "phone"), chat, w.carol, true, false)
        .unwrap();
    assert_eq!(ringing_carol.outcome(), None);
}

#[test]
fn the_same_person_cannot_be_in_on_two_connected_devices() {
    let w = world();
    let call = w.started();
    assert_eq!(
        w.join(w.alice, "phone", call.id),
        Err(GroupCallError::AlreadyInCall)
    );
    // 同一台设备再点一次没关系
    assert_eq!(w.join(w.alice, "laptop", call.id).unwrap(), call);
}

#[test]
fn after_a_refresh_the_new_page_takes_over_from_the_one_that_went_away() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    // alice 刷新了页面：原来那一台断开，新的页面是另一台设备
    w.calls.device_gone(&device(w.alice, "laptop"));
    w.clock.advance(3_000);
    let call = w.join(w.alice, "reloaded", call.id).unwrap();
    assert_eq!(in_call(&call), [w.alice, w.bob]);
    assert_eq!(call.participants[0].device.as_str(), "reloaded-device");
    assert_eq!(call.joined, [w.alice, w.bob]);
    // 原来那一台的计时作废了：过多久她都还在（这一次结算到的只是 carol 的邀请过期了）
    w.clock.advance(60_000);
    let changed = w.calls.sweep_groups();
    assert_eq!(changed.len(), 1);
    assert_eq!(in_call(&changed[0].call), [w.alice, w.bob]);
    assert!(w.calls.sweep_groups().is_empty());
}

#[test]
fn a_device_gone_too_long_counts_as_having_left() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    w.clock.advance(31_000);
    w.calls.sweep_groups();

    // 不是通话里的那一台断开：不算
    w.calls.device_gone(&device(w.bob, "tablet"));
    w.clock.advance(31_000);
    assert!(w.calls.sweep_groups().is_empty());

    // 断开一会儿又回来：不算
    w.calls.device_gone(&device(w.bob, "phone"));
    w.clock.advance(29_000);
    w.calls.device_back(&device(w.bob, "phone"));
    w.clock.advance(5_000);
    assert!(w.calls.sweep_groups().is_empty());

    // 断开太久：算他离开了
    w.calls.device_gone(&device(w.bob, "phone"));
    w.clock.advance(30_000);
    let changed = w.calls.sweep_groups();
    assert_eq!(changed.len(), 1);
    assert_eq!(in_call(&changed[0].call), [w.alice]);
    assert_eq!(changed[0].left, [w.bob]);
    assert!(!changed[0].call.ended());

    // 最后一个人也断开太久：通话结束
    w.calls.device_gone(&device(w.alice, "laptop"));
    w.clock.advance(30_000);
    let changed = w.calls.sweep_groups();
    assert_eq!(changed.len(), 1);
    assert!(changed[0].call.ended());
    assert_eq!(changed[0].left, [w.alice]);
    assert_eq!(w.calls.group_call(call.id), None);
}

#[test]
fn someone_removed_from_the_group_is_taken_out_of_its_call() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    // 和这个通话没有关系的人：没有变化
    assert_eq!(w.calls.remove_from_group_call(w.dave, w.group), None);
    assert_eq!(
        w.calls.remove_from_group_call(w.bob, ConversationId::new()),
        None
    );
    // 正在被邀请的人：邀请作废
    let changed = w.calls.remove_from_group_call(w.carol, w.group).unwrap();
    assert!(changed.ringing.is_empty());
    // 在通话里的人：拿掉
    let changed = w.calls.remove_from_group_call(w.bob, w.group).unwrap();
    assert_eq!(in_call(&changed), [w.alice]);
    // 最后一个人被拿掉：通话结束
    let changed = w.calls.remove_from_group_call(w.alice, w.group).unwrap();
    assert!(changed.ended());
}

#[test]
fn a_disabled_user_or_a_signed_out_device_is_taken_out_of_every_call() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    let other = w
        .calls
        .start_group(
            device(w.dave, "phone"),
            ConversationId::new(),
            false,
            &[w.bob],
        )
        .unwrap();
    // bob 在第一个通话里，所以第二个通话没有让他响铃
    assert!(other.ringing.is_empty());

    // 被退出登录的不是通话里的那一台设备：不动
    let tablet = device(w.bob, "tablet").device;
    assert!(
        w.calls
            .remove_from_group_calls(w.bob, Some(&tablet))
            .is_empty()
    );
    // 是通话里的那一台：拿掉
    let phone = device(w.bob, "phone").device;
    let changed = w.calls.remove_from_group_calls(w.bob, Some(&phone));
    assert_eq!(changed.len(), 1);
    assert_eq!(in_call(&changed[0]), [w.alice]);

    // 整个人被禁用：不管哪台设备，连同给他的邀请
    let changed = w.calls.remove_from_group_calls(w.carol, None);
    assert_eq!(changed.len(), 1);
    assert!(changed[0].ringing.is_empty());
    let changed = w.calls.remove_from_group_calls(w.alice, None);
    assert_eq!(changed.len(), 1);
    assert!(changed[0].ended());
    assert!(w.calls.remove_from_group_calls(w.alice, None).is_empty());
}

#[test]
fn dissolving_the_group_ends_its_call() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    w.clock.advance(10_000);
    assert_eq!(w.calls.end_group_call(ConversationId::new()), None);
    let ended = w.calls.end_group_call(w.group).unwrap();
    assert_eq!(ended.id, call.id);
    assert_eq!(ended.ended_at, Some(1_010_000));
    assert!(ended.participants.is_empty());
    assert_eq!(ended.joined, [w.alice, w.bob]);
    assert_eq!(w.calls.end_group_call(w.group), None);
}

#[test]
fn only_one_person_shares_the_screen_at_a_time() {
    let w = world();
    let call = w.started();
    w.join(w.bob, "phone", call.id).unwrap();
    let alice = device(w.alice, "laptop");
    let bob = device(w.bob, "phone");

    // 不在通话里的人、不是自己那一台设备，都不行
    assert_eq!(
        w.calls
            .share_group_screen(&device(w.carol, "phone"), call.id),
        Err(GroupCallError::NotInCall)
    );
    assert_eq!(
        w.calls
            .share_group_screen(&device(w.alice, "tablet"), call.id),
        Err(GroupCallError::WrongDevice)
    );

    let shared = w.calls.share_group_screen(&alice, call.id).unwrap();
    assert_eq!(shared.sharing, Some(w.alice));
    // 自己再说一次没有关系；别人要等他停
    assert!(w.calls.share_group_screen(&alice, call.id).is_ok());
    assert_eq!(
        w.calls.share_group_screen(&bob, call.id),
        Err(GroupCallError::SomeoneSharing(w.alice))
    );
    // 别人不能替他停
    let (same, changed) = w.calls.stop_group_screen(&bob, call.id).unwrap();
    assert_eq!((same.sharing, changed), (Some(w.alice), false));

    let (stopped, changed) = w.calls.stop_group_screen(&alice, call.id).unwrap();
    assert_eq!((stopped.sharing, changed), (None, true));
    assert_eq!(
        w.calls.share_group_screen(&bob, call.id).unwrap().sharing,
        Some(w.bob)
    );
}

#[test]
fn sharing_ends_whichever_way_the_sharer_leaves() {
    let w = world();
    let alice = device(w.alice, "laptop");
    let bob = device(w.bob, "phone");
    let sharing_bob = |w: &World| {
        let call = w.calls.group_call_in(w.group).unwrap();
        if !call.is_in(w.bob) {
            w.join(w.bob, "phone", call.id).unwrap();
        }
        let shared = w.calls.share_group_screen(&bob, call.id).unwrap();
        assert_eq!(shared.sharing, Some(w.bob));
        call.id
    };
    w.started();

    // 自己离开
    let id = sharing_bob(&w);
    assert_eq!(w.calls.leave_group(&bob, id).unwrap().sharing, None);
    // 被移出群、退群
    sharing_bob(&w);
    let call = w.calls.remove_from_group_call(w.bob, w.group).unwrap();
    assert_eq!(call.sharing, None);
    // 被禁用、那台设备被退出登录
    sharing_bob(&w);
    let calls = w.calls.remove_from_group_calls(w.bob, Some(&bob.device));
    assert_eq!(calls[0].sharing, None);
    // 刷新后的页面接替了原来的那一台：原来共享的屏幕已经没有了
    let id = sharing_bob(&w);
    let moved = w.join(w.bob, "new-tab", id);
    // 原来那一台还连着时换不过去；它断开之后才行
    assert_eq!(moved, Err(GroupCallError::AlreadyInCall));
    w.calls.device_gone(&bob);
    assert_eq!(w.join(w.bob, "new-tab", id).unwrap().sharing, None);
    // 同一台设备再报一次到不算换设备：共享还在
    let tab = device(w.bob, "new-tab");
    w.calls.share_group_screen(&tab, id).unwrap();
    assert_eq!(w.join(w.bob, "new-tab", id).unwrap().sharing, Some(w.bob));
    // 设备断开太久，被算作离开
    w.calls.device_gone(&tab);
    w.clock.advance(CallSettings::default().gone_grace_ms);
    let swept = w.calls.sweep_groups();
    assert_eq!(swept[0].call.sharing, None);
    // 别人的共享不受他离开的影响
    w.calls.share_group_screen(&alice, id).unwrap();
    w.join(w.bob, "phone", id).unwrap();
    assert_eq!(
        w.calls.leave_group(&bob, id).unwrap().sharing,
        Some(w.alice)
    );
    // 群解散：通话结束，记下来的样子里没有人在共享
    assert_eq!(w.calls.end_group_call(w.group).unwrap().sharing, None);
}
