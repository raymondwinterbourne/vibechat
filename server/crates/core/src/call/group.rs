//! 进行中的群通话（F10，设计文档 3.7 节）。
//!
//! 和一对一通话一样只在内存里，和它们放在同一个 [`Calls`] 里、同一把锁下面：
//! 一个人同一时间只能在一个通话里，一对一的和群里的合起来算。
//!
//! 群通话没有主叫、被叫：一个群成员发起，他自己马上就在通话里；他挑的人响铃一阵子，
//! 响不响铃都不影响加入——只要通话还在，群成员随时可以进来、离开。最后一个人离开时通话结束。
//! 声音不经过这里：每个人各自连到媒体转发服务（见 [`super::livekit`]）。
//!
//! 这里不管"他是不是群成员"：调用方先确认过。也不自己计时，超时由调用方定期调
//! [`Calls::sweep_groups`] 来结算。

use std::collections::HashMap;

use super::calls::{Calls, DeviceId, Endpoint, State, in_call};
use crate::ids::{CallId, ConversationId, UserId};

/// 通话里的一个人：在哪一台设备上、什么时候进来的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupParticipant {
    pub user: UserId,
    pub device: DeviceId,
    pub joined_at: i64,
}

/// 一个正在响铃的邀请：谁邀请的、响到什么时候。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupInvite {
    pub user: UserId,
    pub by: UserId,
    /// UTC 毫秒。到了就不再响。
    pub until: i64,
}

/// 一次群通话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupCall {
    pub id: CallId,
    /// 哪个群。通话记录写在这里。
    pub conversation: ConversationId,
    /// 发起人。通话记录记在他名下。
    pub starter: UserId,
    /// 是视频通话（F11）。发起时定下来，之后不变：视频通话里的人可以开摄像头，
    /// 语音通话里不行。邀请怎么写、通话记录怎么写也看它。
    pub video: bool,
    pub started_at: i64,
    /// 结束了的才有：最后一个人离开的时候。
    pub ended_at: Option<i64>,
    /// 现在在通话里的人，按进来的先后。
    pub participants: Vec<GroupParticipant>,
    /// 正在响铃的邀请。
    pub ringing: Vec<GroupInvite>,
    /// 到现在为止进来过的人，不重复。通话记录里写"几人参加"。
    pub joined: Vec<UserId>,
    /// 正在共享屏幕的人（F12）。同一时间只有一个；他不管怎么离开通话，共享都随之结束。
    /// 页面只收这个人的屏幕。
    pub sharing: Option<UserId>,
}

impl GroupCall {
    /// 这个人现在在不在通话里。
    pub fn is_in(&self, user: UserId) -> bool {
        self.participant(user).is_some()
    }

    pub fn participant(&self, user: UserId) -> Option<&GroupParticipant> {
        self.participants.iter().find(|entry| entry.user == user)
    }

    /// 这个人是不是正在被邀请（他的设备在响铃）。
    pub fn is_ringing(&self, user: UserId) -> bool {
        self.ringing.iter().any(|invite| invite.user == user)
    }

    pub fn ended(&self) -> bool {
        self.ended_at.is_some()
    }

    /// 通话进行了多久，毫秒。还没结束的为空。
    pub fn duration_ms(&self) -> Option<i64> {
        Some(self.ended_at? - self.started_at)
    }
}

/// 一次结算里有变化的一个群通话，以及这一次被算作离开的人（设备断开太久）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSwept {
    pub call: GroupCall,
    pub left: Vec<UserId>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GroupCallError {
    /// 没有这个通话：不存在，或者已经结束。
    #[error("no such group call")]
    NotFound,
    /// 我已经在一个通话里了：别的通话，或者就是这个通话、在我另一台还连着的设备上。
    #[error("already in a call")]
    AlreadyInCall,
    /// 这个群已经有一个通话在进行：应该加入它，而不是再发起一个。
    #[error("this group already has a call")]
    AlreadyRunning(CallId),
    /// 通话人数已满。
    #[error("the group call is full")]
    Full,
    /// 我不在这个通话里。
    #[error("not in this group call")]
    NotInCall,
    /// 这台设备不是我在通话里的那一台。
    #[error("this device is not in the call")]
    WrongDevice,
    /// 已经有别人在共享屏幕：要等他停。
    #[error("someone else is sharing the screen")]
    SomeoneSharing(UserId),
}

/// 一个进行中的群通话，加上里面每个人的那一台设备从什么时候起断开着。
pub(super) struct LiveGroup {
    pub(super) call: GroupCall,
    gone_since: HashMap<UserId, i64>,
}

impl LiveGroup {
    /// 这台设备是通话里某个人的那一台时，开始计时。
    pub(super) fn device_gone(&mut self, endpoint: &Endpoint, now: i64) {
        if self.holds(endpoint) {
            self.gone_since.entry(endpoint.user).or_insert(now);
        }
    }

    pub(super) fn device_back(&mut self, endpoint: &Endpoint) {
        if self.holds(endpoint) {
            self.gone_since.remove(&endpoint.user);
        }
    }

    fn holds(&self, endpoint: &Endpoint) -> bool {
        self.call
            .participant(endpoint.user)
            .is_some_and(|entry| entry.device == endpoint.device)
    }

    /// 把一个人从通话里拿掉（他不在里面就什么都不做），连同他的邀请。
    fn drop_user(&mut self, user: UserId) -> bool {
        let before = self.call.participants.len() + self.call.ringing.len();
        self.call.participants.retain(|entry| entry.user != user);
        self.call.ringing.retain(|invite| invite.user != user);
        self.gone_since.remove(&user);
        // 他在共享屏幕的话，共享随之结束
        if self.call.sharing == Some(user) {
            self.call.sharing = None;
        }
        before != self.call.participants.len() + self.call.ringing.len()
    }
}

impl Calls {
    /// `starter` 在这台设备上发起群通话，邀请 `invite` 里的人。他自己马上就在通话里。
    ///
    /// 被邀请的人里，正在别的通话里的不响铃；发起人自己不算。
    pub fn start_group(
        &self,
        starter: Endpoint,
        conversation: ConversationId,
        video: bool,
        invite: &[UserId],
    ) -> Result<GroupCall, GroupCallError> {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        if let Some(running) = find_in(&state, conversation) {
            return Err(GroupCallError::AlreadyRunning(running));
        }
        if in_call(&state, starter.user) {
            return Err(GroupCallError::AlreadyInCall);
        }
        let mut call = GroupCall {
            id: CallId::new(),
            conversation,
            starter: starter.user,
            video,
            started_at: now,
            ended_at: None,
            participants: vec![GroupParticipant {
                user: starter.user,
                device: starter.device,
                joined_at: now,
            }],
            ringing: Vec::new(),
            joined: vec![starter.user],
            sharing: None,
        };
        ring(
            &state,
            &mut call,
            starter.user,
            invite,
            self.ring_until(now),
        );
        state.groups.insert(
            call.id,
            LiveGroup {
                call: call.clone(),
                gone_since: HashMap::new(),
            },
        );
        Ok(call)
    }

    /// 通话里的人再邀请几个人：他们的设备响铃一次。已经在通话里的、正在别的通话里的不响；
    /// 已经在响的重新计时。
    pub fn invite_to_group(
        &self,
        me: UserId,
        id: CallId,
        invite: &[UserId],
    ) -> Result<GroupCall, GroupCallError> {
        let now = self.clock.now_ms();
        let until = self.ring_until(now);
        let mut state = self.lock();
        let mut call = state
            .groups
            .get(&id)
            .ok_or(GroupCallError::NotFound)?
            .call
            .clone();
        if !call.is_in(me) {
            return Err(GroupCallError::NotInCall);
        }
        ring(&state, &mut call, me, invite, until);
        state
            .groups
            .get_mut(&id)
            .expect("the call was there a moment ago")
            .call = call.clone();
        Ok(call)
    }

    /// 在这台设备上加入。被没被邀请都可以；通话里最多 `limit` 个人。
    ///
    /// 我已经在这个通话里、但那一台设备断开着（例如刷新了页面）：换成这一台。
    /// 那一台还连着：不行，同一个人只能在一台设备上。
    pub fn join_group(
        &self,
        me: Endpoint,
        id: CallId,
        limit: usize,
    ) -> Result<GroupCall, GroupCallError> {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        let entry = state.groups.get(&id).ok_or(GroupCallError::NotFound)?;
        if let Some(mine) = entry.call.participant(me.user) {
            let gone = entry.gone_since.contains_key(&me.user);
            if mine.device != me.device && !gone {
                return Err(GroupCallError::AlreadyInCall);
            }
            // 同一台设备再点一次，或者换到这一台
            let entry = state.groups.get_mut(&id).expect("just looked it up");
            entry.gone_since.remove(&me.user);
            let mut moved = false;
            for mine in &mut entry.call.participants {
                if mine.user == me.user && mine.device != me.device {
                    mine.device = me.device.clone();
                    moved = true;
                }
            }
            // 换了一台设备（刷新后的页面接替了原来的）：原来那一台共享的屏幕已经没有了
            if moved && entry.call.sharing == Some(me.user) {
                entry.call.sharing = None;
            }
            return Ok(entry.call.clone());
        }
        if in_call(&state, me.user) {
            return Err(GroupCallError::AlreadyInCall);
        }
        if entry.call.participants.len() >= limit {
            return Err(GroupCallError::Full);
        }
        let entry = state.groups.get_mut(&id).expect("just looked it up");
        let call = &mut entry.call;
        call.ringing.retain(|invite| invite.user != me.user);
        call.participants.push(GroupParticipant {
            user: me.user,
            device: me.device,
            joined_at: now,
        });
        if !call.joined.contains(&me.user) {
            call.joined.push(me.user);
        }
        Ok(call.clone())
    }

    /// 不理会邀请：我的设备都不再响。之后仍然可以加入。没有在响的话什么都不变。
    pub fn decline_group(&self, me: UserId, id: CallId) -> Result<GroupCall, GroupCallError> {
        let mut state = self.lock();
        let entry = state.groups.get_mut(&id).ok_or(GroupCallError::NotFound)?;
        entry.call.ringing.retain(|invite| invite.user != me);
        Ok(entry.call.clone())
    }

    /// 离开。只能在通话里的那一台设备上离开。最后一个人离开时通话结束，交回结束的样子。
    pub fn leave_group(&self, me: &Endpoint, id: CallId) -> Result<GroupCall, GroupCallError> {
        let mut state = self.lock();
        let entry = state.groups.get_mut(&id).ok_or(GroupCallError::NotFound)?;
        let mine = entry
            .call
            .participant(me.user)
            .ok_or(GroupCallError::NotInCall)?;
        if mine.device != me.device {
            return Err(GroupCallError::WrongDevice);
        }
        entry.drop_user(me.user);
        Ok(self.settle_group(&mut state, id))
    }

    /// 我在这台设备上开始共享屏幕（F12）。同一时间只有一个人共享：已经有别人在共享时不行，
    /// 要等他停；我自己已经在共享的，再说一次没有关系。
    pub fn share_group_screen(
        &self,
        me: &Endpoint,
        id: CallId,
    ) -> Result<GroupCall, GroupCallError> {
        let mut state = self.lock();
        let entry = state.groups.get_mut(&id).ok_or(GroupCallError::NotFound)?;
        let mine = entry
            .call
            .participant(me.user)
            .ok_or(GroupCallError::NotInCall)?;
        if mine.device != me.device {
            return Err(GroupCallError::WrongDevice);
        }
        match entry.call.sharing {
            Some(other) if other != me.user => Err(GroupCallError::SomeoneSharing(other)),
            _ => {
                entry.call.sharing = Some(me.user);
                Ok(entry.call.clone())
            }
        }
    }

    /// 我停止共享屏幕。只能停自己的：不是我在共享时什么都不变。
    /// 交回通话现在的样子，和这一次有没有变化。
    pub fn stop_group_screen(
        &self,
        me: &Endpoint,
        id: CallId,
    ) -> Result<(GroupCall, bool), GroupCallError> {
        let mut state = self.lock();
        let entry = state.groups.get_mut(&id).ok_or(GroupCallError::NotFound)?;
        let mine = entry
            .call
            .participant(me.user)
            .ok_or(GroupCallError::NotInCall)?;
        if mine.device != me.device {
            return Err(GroupCallError::WrongDevice);
        }
        let changed = entry.call.sharing == Some(me.user);
        if changed {
            entry.call.sharing = None;
        }
        Ok((entry.call.clone(), changed))
    }

    /// 把一个人从这个群的通话里拿掉，不管他在哪台设备上，连同他的邀请：他被移出群、退了群的时候用。
    /// 群里没有通话、他和这个通话没有关系时为空。
    pub fn remove_from_group_call(
        &self,
        user: UserId,
        conversation: ConversationId,
    ) -> Option<GroupCall> {
        let mut state = self.lock();
        let id = find_in(&state, conversation)?;
        let changed = state.groups.get_mut(&id)?.drop_user(user);
        changed.then(|| self.settle_group(&mut state, id))
    }

    /// 把一个人从他所在的群通话里拿掉，连同别的群通话给他的邀请：他被禁用、那台设备被退出登录的时候用。
    /// `device` 给了的话，只有他在通话里的是这一台设备时才拿掉。交回有变化的通话。
    pub fn remove_from_group_calls(
        &self,
        user: UserId,
        device: Option<&DeviceId>,
    ) -> Vec<GroupCall> {
        let mut state = self.lock();
        let ids: Vec<CallId> = state
            .groups
            .values()
            .filter(|entry| match (entry.call.participant(user), device) {
                (Some(mine), Some(device)) => &mine.device == device,
                (Some(_), None) => true,
                (None, Some(_)) => false,
                (None, None) => entry.call.is_ringing(user),
            })
            .map(|entry| entry.call.id)
            .collect();
        ids.into_iter()
            .map(|id| {
                state
                    .groups
                    .get_mut(&id)
                    .expect("collected a moment ago")
                    .drop_user(user);
                self.settle_group(&mut state, id)
            })
            .collect()
    }

    /// 结束这个群的通话：群解散的时候用。群里没有通话时为空。
    pub fn end_group_call(&self, conversation: ConversationId) -> Option<GroupCall> {
        let mut state = self.lock();
        let id = find_in(&state, conversation)?;
        let entry = state.groups.get_mut(&id)?;
        entry.call.participants.clear();
        entry.call.sharing = None;
        Some(self.settle_group(&mut state, id))
    }

    /// 结算到时间的群通话，交回这一次有变化的（结束了的带着结束时间）。调用方大约每秒调一次。
    ///
    /// - 邀请响够了时间：不再响。
    /// - 通话里的人，他的设备断开太久：算他离开了。
    /// - 没有人了：通话结束。
    pub fn sweep_groups(&self) -> Vec<GroupSwept> {
        let now = self.clock.now_ms();
        let grace = self.settings.gone_grace_ms;
        let mut state = self.lock();
        let mut changed = Vec::new();
        for entry in state.groups.values_mut() {
            let before = entry.call.participants.len() + entry.call.ringing.len();
            entry.call.ringing.retain(|invite| invite.until > now);
            let gone: Vec<UserId> = entry
                .gone_since
                .iter()
                .filter(|(_, since)| now - **since >= grace)
                .map(|(user, _)| *user)
                .collect();
            for user in &gone {
                entry.drop_user(*user);
            }
            if before != entry.call.participants.len() + entry.call.ringing.len() {
                changed.push((entry.call.id, gone));
            }
        }
        changed
            .into_iter()
            .map(|(id, left)| GroupSwept {
                call: self.settle_group(&mut state, id),
                left,
            })
            .collect()
    }

    /// 一个进行中的群通话。
    pub fn group_call(&self, id: CallId) -> Option<GroupCall> {
        self.lock().groups.get(&id).map(|entry| entry.call.clone())
    }

    /// 这个群正在进行的通话。
    pub fn group_call_in(&self, conversation: ConversationId) -> Option<GroupCall> {
        let state = self.lock();
        let id = find_in(&state, conversation)?;
        state.groups.get(&id).map(|entry| entry.call.clone())
    }

    /// 全部进行中的群通话。
    pub fn group_calls(&self) -> Vec<GroupCall> {
        self.lock()
            .groups
            .values()
            .map(|entry| entry.call.clone())
            .collect()
    }

    fn ring_until(&self, now: i64) -> i64 {
        now + self.settings.group_ring_timeout_ms
    }

    /// 通话变了之后：没有人了就结束它（从表里拿掉、记下结束时间、邀请作废），交回现在的样子。
    fn settle_group(&self, state: &mut State, id: CallId) -> GroupCall {
        let entry = state.groups.get(&id).expect("the group call is live");
        if !entry.call.participants.is_empty() {
            return entry.call.clone();
        }
        let mut call = state.groups.remove(&id).expect("just looked it up").call;
        call.ringing.clear();
        call.ended_at = Some(self.clock.now_ms());
        call
    }
}

/// 这个群正在进行的通话的编号。
fn find_in(state: &State, conversation: ConversationId) -> Option<CallId> {
    state
        .groups
        .values()
        .find(|entry| entry.call.conversation == conversation)
        .map(|entry| entry.call.id)
}

/// 让 `invite` 里的人响铃到 `until`：邀请人自己、已经在通话里的、正在别的通话里的不响；
/// 已经在响的重新计时。
fn ring(state: &State, call: &mut GroupCall, by: UserId, invite: &[UserId], until: i64) {
    for user in invite {
        if *user == by || call.is_in(*user) || in_call(state, *user) {
            continue;
        }
        call.ringing.retain(|invite| invite.user != *user);
        call.ringing.push(GroupInvite {
            user: *user,
            by,
            until,
        });
    }
}
