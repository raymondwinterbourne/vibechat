//! 各类实体的内部编号。由应用生成，不依赖数据库的自增。

use std::fmt;
use std::str::FromStr;

use uuid::Uuid;

macro_rules! id_type {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(Uuid);

        impl $name {
            /// 生成一个新的编号。UUIDv7 按时间排序，作为主键时索引更紧凑。
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            pub fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            pub fn as_uuid(&self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s).map(Self)
            }
        }
    };
}

id_type!(
    /// 用户的内部编号。创建后永不改变，表之间的关联都用它；
    /// 用户看得见、可以修改的那个 ID 在代码里叫 handle。
    UserId
);
id_type!(
    /// 一次登录。
    SessionId
);
id_type!(
    /// 一个上传的文件。
    FileId
);
id_type!(InviteCodeId);
id_type!(
    /// 一条好友申请。
    FriendRequestId
);
id_type!(
    /// 一个会话：单聊或群聊。
    ConversationId
);
id_type!(
    /// 会话日志里的一条：一条消息，或一个事件。
    MessageId
);
id_type!(
    /// 一条入群申请。
    JoinRequestId
);
id_type!(
    /// 一次通话。只在通话进行时存在于内存里，结束后写进通话记录。
    CallId
);
