use std::sync::Arc;

use vibechat_core::Stores;
use vibechat_core::account::AccountService;
use vibechat_core::admin::AdminService;
use vibechat_core::call::{Calls, MediaRooms};
use vibechat_core::chat::ChatService;
use vibechat_core::contact::ContactService;
use vibechat_core::file::FileService;

use crate::config::Config;
use crate::ws::{Hub, WsSettings};

/// 每个请求处理函数都能拿到的共享状态。
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub stores: Stores,
    pub accounts: Arc<AccountService>,
    pub contacts: Arc<ContactService>,
    pub chat: Arc<ChatService>,
    pub files: Arc<FileService>,
    pub admin: Arc<AdminService>,
    pub hub: Arc<Hub>,
    /// 进行中的通话。
    pub calls: Arc<Calls>,
    /// 群通话在媒体转发服务上的房间：把人请出去、关闭房间。
    pub rooms: Arc<dyn MediaRooms>,
    pub ws: WsSettings,
}
