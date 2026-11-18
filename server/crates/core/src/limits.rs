//! 管理员可以调整的几项上限。没有设置过时用默认值；修改它们的界面在管理功能里。

use crate::settings::SettingsStore;
use crate::store::StoreError;

pub const FILE_MAX_BYTES_SETTING: &str = "file_max_bytes";
pub const FILE_MAX_BYTES_DEFAULT: u64 = 100 * 1024 * 1024;
pub const VOICE_MAX_SECONDS_SETTING: &str = "voice_max_seconds";
pub const VOICE_MAX_SECONDS_DEFAULT: u32 = 60;
pub const RECALL_WINDOW_SECONDS_SETTING: &str = "recall_window_seconds";
pub const RECALL_WINDOW_SECONDS_DEFAULT: u32 = 120;
/// 消息发出后多久之内可以编辑（F8）。0 表示不允许编辑。
pub const EDIT_WINDOW_SECONDS_SETTING: &str = "edit_window_seconds";
pub const EDIT_WINDOW_SECONDS_DEFAULT: u32 = 24 * 60 * 60;
/// 聊天记录和文件保留多少天。没有设置过，或者写的是 0：永久保留。
pub const RETENTION_DAYS_SETTING: &str = "retention_days";

// 通话画面的参数（F7 第 7 章）。码率按千比特每秒存，都是整数。
pub const SCREEN_MAX_WIDTH_SETTING: &str = "screen_max_width";
pub const SCREEN_MAX_WIDTH_DEFAULT: u32 = 2560;
pub const SCREEN_MAX_FPS_SETTING: &str = "screen_max_fps";
pub const SCREEN_MAX_FPS_DEFAULT: u32 = 15;
pub const SCREEN_DIRECT_KBPS_SETTING: &str = "screen_direct_kbps";
pub const SCREEN_DIRECT_KBPS_DEFAULT: u32 = 6000;
pub const SCREEN_RELAY_KBPS_SETTING: &str = "screen_relay_kbps";
pub const SCREEN_RELAY_KBPS_DEFAULT: u32 = 1000;
pub const CAMERA_RELAY_KBPS_SETTING: &str = "camera_relay_kbps";
pub const CAMERA_RELAY_KBPS_DEFAULT: u32 = 500;
// 群视频里每个人同时发的两档画面的码率（F11 第 1 章）。大小和帧率是固定的，不在这里。
pub const GROUP_CAMERA_HIGH_KBPS_SETTING: &str = "group_camera_high_kbps";
pub const GROUP_CAMERA_HIGH_KBPS_DEFAULT: u32 = 400;
pub const GROUP_CAMERA_LOW_KBPS_SETTING: &str = "group_camera_low_kbps";
pub const GROUP_CAMERA_LOW_KBPS_DEFAULT: u32 = 120;
/// 群通话里共享的屏幕最多多少千比特每秒（F12）。屏幕只发一档；它要转给通话里其他每一个人。
pub const GROUP_SCREEN_KBPS_SETTING: &str = "group_screen_kbps";
pub const GROUP_SCREEN_KBPS_DEFAULT: u32 = 1000;

/// 群通话最多几个人（F10）。默认 6：服务器的带宽有限，要给以后的画面留余地。
pub const GROUP_CALL_MAX_SETTING: &str = "group_call_max";
pub const GROUP_CALL_MAX_DEFAULT: u32 = 6;
/// 管理员能设的范围。
pub const GROUP_CALL_MAX_RANGE: (u32, u32) = (2, 20);

/// 群通话人数上限：管理员设置过并且在范围里就用设置的，否则用默认值。
pub async fn group_call_max(settings: &dyn SettingsStore) -> Result<u32, StoreError> {
    let (min, max) = GROUP_CALL_MAX_RANGE;
    Ok(read::<u32>(settings, GROUP_CALL_MAX_SETTING)
        .await?
        .filter(|limit| (min..=max).contains(limit))
        .unwrap_or(GROUP_CALL_MAX_DEFAULT))
}

/// 当前生效的上限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// 单个文件最大多少字节。图片和语音也受它限制。
    pub file_max_bytes: u64,
    /// 一条语音消息最长多少秒。
    pub voice_max_seconds: u32,
    /// 消息发出后多少秒之内可以撤回。0 表示不允许撤回。
    pub recall_window_seconds: u32,
    /// 消息发出后多少秒之内可以编辑。0 表示不允许编辑。
    pub edit_window_seconds: u32,
}

impl Limits {
    pub async fn load(settings: &dyn SettingsStore) -> Result<Self, StoreError> {
        Ok(Self {
            file_max_bytes: read(settings, FILE_MAX_BYTES_SETTING)
                .await?
                .filter(|bytes| *bytes > 0)
                .unwrap_or(FILE_MAX_BYTES_DEFAULT),
            voice_max_seconds: read(settings, VOICE_MAX_SECONDS_SETTING)
                .await?
                .filter(|seconds| *seconds > 0)
                .unwrap_or(VOICE_MAX_SECONDS_DEFAULT),
            // 这一项可以是 0
            recall_window_seconds: read(settings, RECALL_WINDOW_SECONDS_SETTING)
                .await?
                .unwrap_or(RECALL_WINDOW_SECONDS_DEFAULT),
            // 这一项也可以是 0
            edit_window_seconds: read(settings, EDIT_WINDOW_SECONDS_SETTING)
                .await?
                .unwrap_or(EDIT_WINDOW_SECONDS_DEFAULT),
        })
    }
}

/// 通话画面的参数：共享屏幕的清晰度和码率，走中转时摄像头的码率，群视频两档画面的码率。
/// 下一通电话起生效；群视频是之后进通话的人按新的发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallVideo {
    /// 共享屏幕的画面最宽多少像素，高度按屏幕的比例。
    pub screen_max_width: u32,
    /// 共享屏幕每秒最多几帧。
    pub screen_max_fps: u32,
    /// 直连时共享屏幕最多多少千比特每秒。
    pub screen_direct_kbps: u32,
    /// 走中转时共享屏幕最多多少千比特每秒。
    pub screen_relay_kbps: u32,
    /// 走中转时摄像头的画面最多多少千比特每秒。直连时不限。
    pub camera_relay_kbps: u32,
    /// 群视频里清楚的那一档最多多少千比特每秒。
    pub group_camera_high_kbps: u32,
    /// 群视频里小的那一档最多多少千比特每秒。
    pub group_camera_low_kbps: u32,
    /// 群通话里共享的屏幕最多多少千比特每秒（F12）。
    pub group_screen_kbps: u32,
}

impl CallVideo {
    pub async fn load(settings: &dyn SettingsStore) -> Result<Self, StoreError> {
        let positive =
            |value: Option<u32>, default: u32| value.filter(|v| *v > 0).unwrap_or(default);
        Ok(Self {
            screen_max_width: positive(
                read(settings, SCREEN_MAX_WIDTH_SETTING).await?,
                SCREEN_MAX_WIDTH_DEFAULT,
            ),
            screen_max_fps: positive(
                read(settings, SCREEN_MAX_FPS_SETTING).await?,
                SCREEN_MAX_FPS_DEFAULT,
            ),
            screen_direct_kbps: positive(
                read(settings, SCREEN_DIRECT_KBPS_SETTING).await?,
                SCREEN_DIRECT_KBPS_DEFAULT,
            ),
            screen_relay_kbps: positive(
                read(settings, SCREEN_RELAY_KBPS_SETTING).await?,
                SCREEN_RELAY_KBPS_DEFAULT,
            ),
            camera_relay_kbps: positive(
                read(settings, CAMERA_RELAY_KBPS_SETTING).await?,
                CAMERA_RELAY_KBPS_DEFAULT,
            ),
            group_camera_high_kbps: positive(
                read(settings, GROUP_CAMERA_HIGH_KBPS_SETTING).await?,
                GROUP_CAMERA_HIGH_KBPS_DEFAULT,
            ),
            group_camera_low_kbps: positive(
                read(settings, GROUP_CAMERA_LOW_KBPS_SETTING).await?,
                GROUP_CAMERA_LOW_KBPS_DEFAULT,
            ),
            group_screen_kbps: positive(
                read(settings, GROUP_SCREEN_KBPS_SETTING).await?,
                GROUP_SCREEN_KBPS_DEFAULT,
            ),
        })
    }
}

/// 保留多少天。永久保留时为 `None`。
pub async fn retention_days(settings: &dyn SettingsStore) -> Result<Option<u32>, StoreError> {
    Ok(read(settings, RETENTION_DAYS_SETTING)
        .await?
        .filter(|days| *days > 0))
}

/// 一项设置的值。没有设置过或者写的不是数字时为 `None`。
async fn read<T>(settings: &dyn SettingsStore, key: &str) -> Result<Option<T>, StoreError>
where
    T: std::str::FromStr,
{
    let configured = settings.get(key).await?;
    Ok(configured.and_then(|value| value.trim().parse().ok()))
}
