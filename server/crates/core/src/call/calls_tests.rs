use std::sync::Arc;

use super::calls::*;
use crate::ids::{CallId, ConversationId, UserId};
use crate::testing::ManualClock;

struct World {
    clock: Arc<ManualClock>,
    calls: Calls,
    alice: UserId,
    bob: UserId,
    carol: UserId,
}

fn world() -> World {
    let clock = Arc::new(ManualClock::new(1_000_000));
    World {
        calls: Calls::new(clock.clone(), CallSettings::default()),
        clock,
        alice: UserId::new(),
        bob: UserId::new(),
        carol: UserId::new(),
    }
}

fn device(user: UserId, name: &str) -> Endpoint {
    Endpoint {
        user,
        device: DeviceId::parse(&format!("{name}-device")).unwrap(),
    }
}

impl World {
    /// alice 在她的笔记本上打给 bob，bob 在线。
    fn ring(&self) -> Call {
        self.calls
            .start(
                device(self.alice, "laptop"),
                ConversationId::new(),
                self.bob,
                true,
                false,
            )
            .unwrap()
    }

    /// 接通：bob 在手机上接了。
    fn connected(&self) -> Call {
        let call = self.ring();
        self.calls
            .accept(&device(self.bob, "phone"), call.id)
            .unwrap()
    }
}

#[test]
fn device_ids_are_short_plain_words() {
    assert!(DeviceId::parse("tab-1a2b3c4d").is_some());
    assert!(DeviceId::parse("A_b-9_____").is_some());
    assert!(DeviceId::parse("short").is_none());
    assert!(DeviceId::parse(&"x".repeat(65)).is_none());
    assert!(DeviceId::parse("has space here").is_none());
    assert!(DeviceId::parse("中文设备编号很长很长").is_none());
}

#[test]
fn a_call_rings_until_it_is_answered_on_one_device() {
    let w = world();
    let call = w.ring();
    assert_eq!(call.state, CallState::Ringing);
    assert_eq!(call.callee_device, None);
    assert_eq!(w.calls.current(w.bob).unwrap().id, call.id);
    assert_eq!(w.calls.current(w.alice).unwrap().id, call.id);

    w.clock.advance(5_000);
    let answered = w.calls.accept(&device(w.bob, "phone"), call.id).unwrap();
    assert_eq!(answered.state, CallState::Active);
    assert_eq!(answered.callee_device, Some(device(w.bob, "phone").device));
    assert_eq!(answered.answered_at, Some(call.started_at + 5_000));

    // 他的另一台设备晚了一步
    assert_eq!(
        w.calls.accept(&device(w.bob, "laptop"), call.id),
        Err(CallError::NotRinging)
    );
}

#[test]
fn hanging_up_after_answering_records_how_long_it_lasted() {
    let w = world();
    let call = w.connected();
    w.clock.advance(192_000);
    let ended = w
        .calls
        .hangup(&device(w.bob, "phone"), call.id, Hangup::Normal)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Completed));
    assert_eq!(ended.duration_ms(), Some(192_000));
    assert!(w.calls.current(w.alice).is_none());
    assert!(w.calls.current(w.bob).is_none());
    assert_eq!(w.calls.count(), 0);

    // 已经结束了
    assert_eq!(
        w.calls
            .hangup(&device(w.alice, "laptop"), call.id, Hangup::Normal),
        Err(CallError::NotFound)
    );
}

#[test]
fn the_caller_can_cancel_before_it_is_answered() {
    let w = world();
    let call = w.ring();
    let ended = w
        .calls
        .hangup(&device(w.alice, "laptop"), call.id, Hangup::Normal)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Cancelled));
    assert_eq!(ended.duration_ms(), None);
    assert!(CallOutcome::Cancelled.missed_by_callee());
}

#[test]
fn the_callee_can_reject_from_any_device() {
    let w = world();
    let call = w.ring();
    let ended = w.calls.reject(w.bob, call.id, Rejection::Declined).unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Rejected));
    assert!(!CallOutcome::Rejected.missed_by_callee());

    // 被叫在响铃时点挂断，也是拒绝
    let call = w.ring();
    let ended = w
        .calls
        .hangup(&device(w.bob, "tablet"), call.id, Hangup::Normal)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Rejected));
}

#[test]
fn only_the_callee_can_answer_or_reject() {
    let w = world();
    let call = w.ring();
    assert_eq!(
        w.calls.accept(&device(w.alice, "phone"), call.id),
        Err(CallError::NotFound)
    );
    assert_eq!(
        w.calls.reject(w.alice, call.id, Rejection::Declined),
        Err(CallError::NotFound)
    );
    assert_eq!(
        w.calls.accept(&device(w.carol, "phone"), call.id),
        Err(CallError::NotFound)
    );
    assert_eq!(
        w.calls
            .hangup(&device(w.carol, "phone"), call.id, Hangup::Normal),
        Err(CallError::NotFound)
    );
    assert_eq!(
        w.calls.accept(&device(w.bob, "phone"), CallId::new()),
        Err(CallError::NotFound)
    );
}

#[test]
fn only_the_devices_in_the_call_can_hang_up() {
    let w = world();
    let call = w.ring();
    // 主叫的另一台设备不能取消
    assert_eq!(
        w.calls
            .hangup(&device(w.alice, "phone"), call.id, Hangup::Normal),
        Err(CallError::WrongDevice)
    );
    w.calls.accept(&device(w.bob, "phone"), call.id).unwrap();
    // 被叫没有接听的那台设备不能挂断
    assert_eq!(
        w.calls
            .hangup(&device(w.bob, "laptop"), call.id, Hangup::Normal),
        Err(CallError::WrongDevice)
    );
    assert_eq!(w.calls.count(), 1);
}

#[test]
fn nobody_answering_for_45_seconds_is_a_missed_call() {
    let w = world();
    let call = w.ring();
    w.clock.advance(44_999);
    assert!(w.calls.sweep().is_empty());
    w.clock.advance(1);
    let ended = w.calls.sweep();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].id, call.id);
    assert_eq!(ended[0].outcome(), Some(CallOutcome::Missed));
    assert!(w.calls.sweep().is_empty());
    assert!(CallOutcome::Missed.missed_by_callee());
}

#[test]
fn an_answered_call_does_not_time_out() {
    let w = world();
    w.connected();
    w.clock.advance(3_600_000);
    assert!(w.calls.sweep().is_empty());
}

#[test]
fn calling_someone_who_is_in_a_call_ends_at_once_as_busy() {
    let w = world();
    w.connected();
    let call = w
        .calls
        .start(
            device(w.carol, "phone"),
            ConversationId::new(),
            w.bob,
            true,
            false,
        )
        .unwrap();
    assert_eq!(call.outcome(), Some(CallOutcome::Busy));
    assert!(call.ended_at.is_some());
    assert!(CallOutcome::Busy.missed_by_callee());
    // 只有原来那一个通话
    assert_eq!(w.calls.count(), 1);

    // 被叫正在响铃也算忙
    let w = world();
    w.ring();
    let call = w
        .calls
        .start(
            device(w.carol, "phone"),
            ConversationId::new(),
            w.bob,
            true,
            false,
        )
        .unwrap();
    assert_eq!(call.outcome(), Some(CallOutcome::Busy));
    // 打给正在呼叫别人的人也一样
    let call = w
        .calls
        .start(
            device(w.carol, "phone"),
            ConversationId::new(),
            w.alice,
            true,
            false,
        )
        .unwrap();
    assert_eq!(call.outcome(), Some(CallOutcome::Busy));
}

#[test]
fn calling_someone_with_no_device_online_ends_at_once() {
    let w = world();
    let call = w
        .calls
        .start(
            device(w.alice, "laptop"),
            ConversationId::new(),
            w.bob,
            false,
            false,
        )
        .unwrap();
    assert_eq!(call.outcome(), Some(CallOutcome::Offline));
    assert!(w.calls.current(w.alice).is_none());
    assert!(CallOutcome::Offline.missed_by_callee());
}

#[test]
fn one_person_can_only_be_in_one_call() {
    let w = world();
    w.ring();
    // 主叫在另一台设备上再打
    assert_eq!(
        w.calls
            .start(
                device(w.alice, "phone"),
                ConversationId::new(),
                w.carol,
                true,
                false
            )
            .map(|call| call.id),
        Err(CallError::AlreadyInCall)
    );
    // 被叫在响铃时自己去打给别人
    assert_eq!(
        w.calls
            .start(
                device(w.bob, "phone"),
                ConversationId::new(),
                w.carol,
                true,
                false
            )
            .map(|call| call.id),
        Err(CallError::AlreadyInCall)
    );
}

#[test]
fn connection_details_go_only_to_the_other_device_in_the_call() {
    let w = world();
    let call = w.ring();
    // 接通之前不能发
    assert_eq!(
        w.calls.peer_of(&device(w.alice, "laptop"), call.id),
        Err(CallError::NotAnswered)
    );
    w.calls.accept(&device(w.bob, "phone"), call.id).unwrap();

    assert_eq!(
        w.calls.peer_of(&device(w.alice, "laptop"), call.id),
        Ok(device(w.bob, "phone"))
    );
    assert_eq!(
        w.calls.peer_of(&device(w.bob, "phone"), call.id),
        Ok(device(w.alice, "laptop"))
    );
    // 不在通话里的设备、不在通话里的人，都不行
    assert_eq!(
        w.calls.peer_of(&device(w.bob, "laptop"), call.id),
        Err(CallError::WrongDevice)
    );
    assert_eq!(
        w.calls.peer_of(&device(w.carol, "phone"), call.id),
        Err(CallError::NotFound)
    );
}

#[test]
fn a_device_that_drops_out_of_a_call_for_30_seconds_ends_it() {
    let w = world();
    let call = w.connected();
    w.clock.advance(60_000);
    w.calls.device_gone(&device(w.bob, "phone"));
    w.clock.advance(29_999);
    assert!(w.calls.sweep().is_empty());
    w.clock.advance(1);
    let ended = w.calls.sweep();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].id, call.id);
    assert_eq!(ended[0].outcome(), Some(CallOutcome::Interrupted));
    assert_eq!(ended[0].duration_ms(), Some(90_000));
}

#[test]
fn a_device_that_comes_back_in_time_keeps_the_call() {
    let w = world();
    w.connected();
    w.calls.device_gone(&device(w.alice, "laptop"));
    w.clock.advance(20_000);
    w.calls.device_back(&device(w.alice, "laptop"));
    w.clock.advance(20_000);
    assert!(w.calls.sweep().is_empty());

    // 再断一次，从头计时
    w.calls.device_gone(&device(w.alice, "laptop"));
    w.clock.advance(29_000);
    assert!(w.calls.sweep().is_empty());
}

#[test]
fn devices_outside_the_call_coming_and_going_change_nothing() {
    let w = world();
    w.connected();
    w.calls.device_gone(&device(w.alice, "phone"));
    w.calls.device_gone(&device(w.bob, "laptop"));
    w.calls.device_gone(&device(w.carol, "phone"));
    w.clock.advance(60_000);
    assert!(w.calls.sweep().is_empty());
}

#[test]
fn the_caller_dropping_out_while_it_rings_cancels_it() {
    let w = world();
    let call = w.ring();
    w.calls.device_gone(&device(w.alice, "laptop"));
    w.clock.advance(30_000);
    let ended = w.calls.sweep();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[0].id, call.id);
    assert_eq!(ended[0].outcome(), Some(CallOutcome::Cancelled));
}

#[test]
fn the_timeouts_can_be_shortened() {
    let clock = Arc::new(ManualClock::new(0));
    let calls = Calls::new(
        clock.clone(),
        CallSettings {
            ring_timeout_ms: 2_000,
            gone_grace_ms: 1_000,
            ..CallSettings::default()
        },
    );
    let (alice, bob) = (UserId::new(), UserId::new());
    calls
        .start(
            device(alice, "laptop"),
            ConversationId::new(),
            bob,
            true,
            false,
        )
        .unwrap();
    clock.advance(2_000);
    assert_eq!(calls.sweep()[0].outcome(), Some(CallOutcome::Missed));
}

#[test]
fn a_call_that_loses_its_audio_ends_as_interrupted() {
    let w = world();
    let call = w.connected();
    w.clock.advance(70_000);
    let ended = w
        .calls
        .hangup(&device(w.alice, "laptop"), call.id, Hangup::Network)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Interrupted));
    assert_eq!(ended.duration_ms(), Some(70_000));

    // 还在响铃时没有"网络中断"：照常是取消
    let call = w.ring();
    let ended = w
        .calls
        .hangup(&device(w.alice, "laptop"), call.id, Hangup::Network)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::Cancelled));
}

#[test]
fn a_callee_without_a_microphone_cannot_answer() {
    let w = world();
    let call = w.ring();
    let ended = w
        .calls
        .reject(w.bob, call.id, Rejection::NoMicrophone)
        .unwrap();
    assert_eq!(ended.outcome(), Some(CallOutcome::NoMicrophone));
    assert!(!CallOutcome::NoMicrophone.missed_by_callee());
}

#[test]
fn a_call_remembers_whether_it_is_a_video_call() {
    let w = world();
    let call = w
        .calls
        .start(
            device(w.alice, "laptop"),
            ConversationId::new(),
            w.bob,
            true,
            true,
        )
        .unwrap();
    assert!(call.video);
    let answered = w.calls.accept(&device(w.bob, "phone"), call.id).unwrap();
    assert!(answered.video);
    let ended = w
        .calls
        .hangup(&device(w.bob, "phone"), call.id, Hangup::Normal)
        .unwrap();
    assert!(ended.video);
    assert!(!w.ring().video);
}
