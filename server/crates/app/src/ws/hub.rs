//! 连接登记表：记录每个用户当前的全部 WebSocket 连接，并把事件推给指定的用户。
//!
//! 推送是尽力而为的：发不出去不重试。客户端重连后会通过 HTTP 自己补齐，
//! 所以这里丢一条事件不影响数据的正确性。
//!
//! 这张表只在单个进程内有效。以后运行多个服务端实例时，在 `push` 处接入实例间的广播。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{PoisonError, RwLock};

use tokio::sync::mpsc;
use vibechat_core::call::DeviceId;
use vibechat_core::{SessionId, UserId};
use vibechat_protocol::ServerEvent;

/// 每条连接最多积压这么多条待发事件。积压满了说明对方收得太慢，直接断开，让它重连后补齐。
const QUEUE_CAPACITY: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnId(u64);

struct Connection {
    id: ConnId,
    /// 这条连接属于哪一次登录。登录失效时据此断开连接。
    session: SessionId,
    /// 这条连接来自哪一台设备（页面自己生成的编号）。通话的推送有的只发给一台设备。
    /// 旧版本的页面不带，为空。
    device: Option<DeviceId>,
    sender: mpsc::Sender<ServerEvent>,
}

/// 登记一条连接后得到的凭据。`events` 关闭表示这条连接被登记表踢掉了，应当断开。
pub struct Registration {
    pub conn_id: ConnId,
    pub events: mpsc::Receiver<ServerEvent>,
}

#[derive(Default)]
pub struct Hub {
    connections: RwLock<HashMap<UserId, Vec<Connection>>>,
    next_id: AtomicU64,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一条属于 `user` 的新连接。同一个用户可以有多条连接（多个标签页、多台设备）。
    pub fn register(&self, user: UserId, session: SessionId) -> Registration {
        self.register_device(user, session, None)
    }

    /// 同上，并且记下这条连接来自哪一台设备。
    pub fn register_device(
        &self,
        user: UserId,
        session: SessionId,
        device: Option<DeviceId>,
    ) -> Registration {
        let conn_id = ConnId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, events) = mpsc::channel(QUEUE_CAPACITY);
        self.connections
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(user)
            .or_default()
            .push(Connection {
                id: conn_id,
                session,
                device,
                sender,
            });
        Registration { conn_id, events }
    }

    /// 连接断开时调用。重复调用或连接已被踢掉都没有影响。
    pub fn unregister(&self, user: UserId, conn_id: ConnId) {
        self.remove(&[(user, conn_id)]);
    }

    /// 把事件推给这些用户的每一条连接，返回成功送出的连接数。不在线的用户直接跳过。
    pub fn push(&self, users: &[UserId], event: &ServerEvent) -> usize {
        let mut delivered = 0;
        let mut dead = Vec::new();
        {
            let connections = self
                .connections
                .read()
                .unwrap_or_else(PoisonError::into_inner);
            for user in users {
                for connection in connections.get(user).into_iter().flatten() {
                    match connection.sender.try_send(event.clone()) {
                        Ok(()) => delivered += 1,
                        // 积压已满或连接已经结束
                        Err(_) => dead.push((*user, connection.id)),
                    }
                }
            }
        }
        // 移除后发送端被丢弃，对应的连接处理循环会发现通道关闭并断开
        self.remove(&dead);
        delivered
    }

    /// 把事件推给某个用户的某一台设备（它可能有几条连接），返回成功送出的连接数。
    pub fn push_device(&self, user: UserId, device: &DeviceId, event: &ServerEvent) -> usize {
        let mut delivered = 0;
        let mut dead = Vec::new();
        {
            let connections = self
                .connections
                .read()
                .unwrap_or_else(PoisonError::into_inner);
            let on_device = connections
                .get(&user)
                .into_iter()
                .flatten()
                .filter(|connection| connection.device.as_ref() == Some(device));
            for connection in on_device {
                match connection.sender.try_send(event.clone()) {
                    Ok(()) => delivered += 1,
                    Err(_) => dead.push((user, connection.id)),
                }
            }
        }
        self.remove(&dead);
        delivered
    }

    /// 这台设备还有没有连接。
    pub fn has_device(&self, user: UserId, device: &DeviceId) -> bool {
        self.connections
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&user)
            .is_some_and(|list| {
                list.iter()
                    .any(|connection| connection.device.as_ref() == Some(device))
            })
    }

    /// 这个人有没有能接电话的设备在线：带着设备编号的连接（旧版本的页面不算）。
    pub fn can_ring(&self, user: UserId) -> bool {
        self.connections
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&user)
            .is_some_and(|list| list.iter().any(|connection| connection.device.is_some()))
    }

    /// 把事件推给属于这些登录的全部连接（F9：下线之前先告诉它原因）。
    pub fn push_sessions(&self, sessions: &[SessionId], event: &ServerEvent) {
        let connections = self
            .connections
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        for connection in connections.values().flatten() {
            if sessions.contains(&connection.session) {
                let _ = connection.sender.try_send(event.clone());
            }
        }
    }

    /// 这个用户的哪几次登录现在有连接（F9：登录设备里的"在线"）。
    pub fn online_sessions(&self, user: UserId) -> Vec<SessionId> {
        self.connections
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&user)
            .map(|list| list.iter().map(|connection| connection.session).collect())
            .unwrap_or_default()
    }

    /// 这些登录现在连着的设备：谁的、哪一台（F10：登录被断开时，它们在群通话里的要立即离开）。
    /// 不带设备编号的旧连接不算。
    pub fn devices_of_sessions(&self, sessions: &[SessionId]) -> Vec<(UserId, DeviceId)> {
        let connections = self
            .connections
            .read()
            .unwrap_or_else(PoisonError::into_inner);
        let mut devices = Vec::new();
        for (user, list) in connections.iter() {
            for connection in list {
                if !sessions.contains(&connection.session) {
                    continue;
                }
                if let Some(device) = &connection.device {
                    let entry = (*user, device.clone());
                    if !devices.contains(&entry) {
                        devices.push(entry);
                    }
                }
            }
        }
        devices
    }

    /// 告诉这些登录"已在别处被退出登录"，再断开它们的连接。
    pub fn sign_out_sessions(&self, sessions: &[SessionId]) {
        self.push_sessions(sessions, &ServerEvent::SysSignedOut);
        self.kick_sessions(sessions);
    }

    /// 断开属于这些登录的全部连接。退出登录、修改密码后调用。
    pub fn kick_sessions(&self, sessions: &[SessionId]) {
        if sessions.is_empty() {
            return;
        }
        let mut connections = self
            .connections
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        // 移除后发送端被丢弃，对应的连接处理循环会发现通道关闭并断开
        connections.retain(|_, list| {
            list.retain(|connection| !sessions.contains(&connection.session));
            !list.is_empty()
        });
    }

    /// 当前有连接的用户。
    pub fn online_users(&self) -> Vec<UserId> {
        self.connections
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect()
    }

    pub fn connection_count(&self) -> usize {
        self.connections
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .values()
            .map(Vec::len)
            .sum()
    }

    fn remove(&self, targets: &[(UserId, ConnId)]) {
        if targets.is_empty() {
            return;
        }
        let mut connections = self
            .connections
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        for (user, conn_id) in targets {
            if let Some(list) = connections.get_mut(user) {
                list.retain(|connection| connection.id != *conn_id);
                if list.is_empty() {
                    connections.remove(user);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> ServerEvent {
        ServerEvent::SysPong
    }

    #[test]
    fn every_connection_of_a_user_receives_the_event() {
        let hub = Hub::new();
        let user = UserId::new();
        let mut first = hub.register(user, SessionId::new());
        let mut second = hub.register(user, SessionId::new());

        assert_eq!(hub.push(&[user], &event()), 2);
        assert_eq!(first.events.try_recv().unwrap(), event());
        assert_eq!(second.events.try_recv().unwrap(), event());
    }

    #[test]
    fn only_the_addressed_users_receive_the_event() {
        let hub = Hub::new();
        let (alice, bob) = (UserId::new(), UserId::new());
        let mut alice_conn = hub.register(alice, SessionId::new());
        let mut bob_conn = hub.register(bob, SessionId::new());

        assert_eq!(hub.push(&[alice], &event()), 1);
        assert!(alice_conn.events.try_recv().is_ok());
        assert!(bob_conn.events.try_recv().is_err());
    }

    #[test]
    fn pushing_to_an_offline_user_is_not_an_error() {
        let hub = Hub::new();
        assert_eq!(hub.push(&[UserId::new()], &event()), 0);
    }

    #[test]
    fn unregistered_connection_is_removed() {
        let hub = Hub::new();
        let user = UserId::new();
        let first = hub.register(user, SessionId::new());
        let _second = hub.register(user, SessionId::new());
        assert_eq!(hub.connection_count(), 2);

        hub.unregister(user, first.conn_id);
        assert_eq!(hub.connection_count(), 1);
        assert_eq!(hub.online_users(), vec![user]);
        assert_eq!(hub.push(&[user], &event()), 1);

        // 重复注销没有影响
        hub.unregister(user, first.conn_id);
        assert_eq!(hub.connection_count(), 1);
    }

    #[test]
    fn user_goes_offline_when_the_last_connection_is_gone() {
        let hub = Hub::new();
        let user = UserId::new();
        let registration = hub.register(user, SessionId::new());
        hub.unregister(user, registration.conn_id);
        assert!(hub.online_users().is_empty());
        assert_eq!(hub.connection_count(), 0);
    }

    #[test]
    fn dropped_receiver_is_cleaned_up_on_next_push() {
        let hub = Hub::new();
        let user = UserId::new();
        drop(hub.register(user, SessionId::new()));

        assert_eq!(hub.push(&[user], &event()), 0);
        assert_eq!(hub.connection_count(), 0);
    }

    #[test]
    fn kicking_a_session_closes_only_its_connections() {
        let hub = Hub::new();
        let user = UserId::new();
        let (laptop, phone) = (SessionId::new(), SessionId::new());
        let mut laptop_tab_1 = hub.register(user, laptop);
        let mut laptop_tab_2 = hub.register(user, laptop);
        let mut phone_tab = hub.register(user, phone);

        hub.kick_sessions(&[laptop]);

        assert_eq!(hub.connection_count(), 1);
        for kicked in [&mut laptop_tab_1, &mut laptop_tab_2] {
            assert!(matches!(
                kicked.events.try_recv(),
                Err(mpsc::error::TryRecvError::Disconnected)
            ));
        }
        assert_eq!(hub.push(&[user], &event()), 1);
        assert!(phone_tab.events.try_recv().is_ok());

        hub.kick_sessions(&[phone]);
        assert!(hub.online_users().is_empty());
    }

    fn device(name: &str) -> DeviceId {
        DeviceId::parse(&format!("{name}-device")).unwrap()
    }

    #[test]
    fn an_event_can_go_to_one_device_only() {
        let hub = Hub::new();
        let user = UserId::new();
        let mut laptop_tab = hub.register_device(user, SessionId::new(), Some(device("laptop")));
        let mut phone = hub.register_device(user, SessionId::new(), Some(device("phone")));
        let mut old_page = hub.register(user, SessionId::new());

        assert_eq!(hub.push_device(user, &device("phone"), &event()), 1);
        assert!(phone.events.try_recv().is_ok());
        assert!(laptop_tab.events.try_recv().is_err());
        assert!(old_page.events.try_recv().is_err());

        // 别人的同名设备收不到
        assert_eq!(
            hub.push_device(UserId::new(), &device("phone"), &event()),
            0
        );
    }

    #[test]
    fn only_pages_that_name_their_device_can_ring() {
        let hub = Hub::new();
        let user = UserId::new();
        let old_page = hub.register(user, SessionId::new());
        assert!(!hub.can_ring(user));

        let phone = hub.register_device(user, SessionId::new(), Some(device("phone")));
        assert!(hub.can_ring(user));
        assert!(hub.has_device(user, &device("phone")));
        assert!(!hub.has_device(user, &device("laptop")));

        hub.unregister(user, phone.conn_id);
        assert!(!hub.can_ring(user));
        assert!(!hub.has_device(user, &device("phone")));
        hub.unregister(user, old_page.conn_id);
    }

    #[test]
    fn connection_that_stops_reading_is_kicked() {
        let hub = Hub::new();
        let user = UserId::new();
        let mut slow = hub.register(user, SessionId::new());

        for _ in 0..QUEUE_CAPACITY {
            assert_eq!(hub.push(&[user], &event()), 1);
        }
        // 积压已满：这一条送不出去，连接被移除
        assert_eq!(hub.push(&[user], &event()), 0);
        assert_eq!(hub.connection_count(), 0);

        // 已经排队的事件还能读到，之后通道关闭
        for _ in 0..QUEUE_CAPACITY {
            assert!(slow.events.try_recv().is_ok());
        }
        assert!(matches!(
            slow.events.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }
}
