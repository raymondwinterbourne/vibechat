use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 服务器上可以下载的桌面客户端安装包。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DesktopRelease {
    /// 版本号，形如 `0.1.0`。
    pub version: String,
    /// 安装包的大小，字节。
    #[ts(type = "number")]
    pub size: u64,
    /// 下载下来的文件名。
    pub file_name: String,
}

/// `GET /api/desktop/latest` 的响应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DesktopLatest {
    /// 服务器上没有安装包时为空。
    pub release: Option<DesktopRelease>,
    /// 桌面客户端的最低版本：低于它的桌面客户端要先更新才能用。没有要求时为空。
    pub min_version: Option<String>,
}
