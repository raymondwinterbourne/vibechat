//! 时间的来源。业务逻辑通过它取当前时间，测试时可以换成能拨动的假时钟。

use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// 当前时间，UTC 毫秒。
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or(0)
    }
}
