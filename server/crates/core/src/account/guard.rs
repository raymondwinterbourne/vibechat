//! 登录保护：连续输错密码后锁定，以及按来源地址限速。
//!
//! 状态都在内存里，只对单个服务端实例有效，重启后清零。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use crate::clock::Clock;

/// 同一个 ID 连续失败这么多次后锁定。
pub const MAX_FAILURES: u32 = 5;
/// 锁定多久；连续失败的计数也在这么久没有新的失败之后清零。
pub const LOCK_MS: i64 = 15 * 60 * 1000;

/// 表里的条目超过这个数量时清理已经过期的，避免被大量随机的 ID 撑爆内存。
const PRUNE_THRESHOLD: usize = 10_000;

#[derive(Clone, Copy)]
struct Failures {
    count: u32,
    last_failure: i64,
    locked_until: Option<i64>,
}

/// 按 ID 统计连续的登录失败。不存在的 ID 同样计数，否则可以借此探测哪些 ID 存在。
pub struct LoginGuard {
    clock: Arc<dyn Clock>,
    failures: Mutex<HashMap<String, Failures>>,
}

impl LoginGuard {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            failures: Mutex::new(HashMap::new()),
        }
    }

    /// 这个 ID 现在能否尝试登录。被锁定时返回还要等多少毫秒。
    pub fn check(&self, handle: &str) -> Result<(), i64> {
        let now = self.clock.now_ms();
        let failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
        match failures.get(handle).and_then(|entry| entry.locked_until) {
            Some(until) if until > now => Err(until - now),
            _ => Ok(()),
        }
    }

    pub fn record_failure(&self, handle: &str) {
        let now = self.clock.now_ms();
        let mut failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
        if failures.len() >= PRUNE_THRESHOLD {
            failures.retain(|_, entry| !is_stale(entry, now));
        }
        let entry = failures.entry(handle.to_owned()).or_insert(Failures {
            count: 0,
            last_failure: now,
            locked_until: None,
        });
        // 上一轮锁定已经结束，或者很久没有失败过：重新开始计数
        if is_stale(entry, now) {
            entry.count = 0;
            entry.locked_until = None;
        }
        entry.count += 1;
        entry.last_failure = now;
        if entry.count >= MAX_FAILURES {
            entry.locked_until = Some(now + LOCK_MS);
        }
    }

    pub fn record_success(&self, handle: &str) {
        self.failures
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(handle);
    }
}

fn is_stale(entry: &Failures, now: i64) -> bool {
    match entry.locked_until {
        Some(until) => until <= now,
        None => now - entry.last_failure >= LOCK_MS,
    }
}

/// 固定窗口的限速：每个来源在一个窗口内最多 `limit` 次。
pub struct RateLimiter {
    clock: Arc<dyn Clock>,
    limit: u32,
    window_ms: i64,
    hits: Mutex<HashMap<String, (i64, u32)>>,
}

impl RateLimiter {
    pub fn new(clock: Arc<dyn Clock>, limit: u32, window_ms: i64) -> Self {
        Self {
            clock,
            limit,
            window_ms,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// 记一次请求。超过限制时返回还要等多少毫秒。
    pub fn hit(&self, key: &str) -> Result<(), i64> {
        let now = self.clock.now_ms();
        let mut hits = self.hits.lock().unwrap_or_else(PoisonError::into_inner);
        if hits.len() >= PRUNE_THRESHOLD {
            hits.retain(|_, (start, _)| now - *start < self.window_ms);
        }
        let entry = hits.entry(key.to_owned()).or_insert((now, 0));
        if now - entry.0 >= self.window_ms {
            *entry = (now, 0);
        }
        if entry.1 >= self.limit {
            return Err(entry.0 + self.window_ms - now);
        }
        entry.1 += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::ManualClock;

    fn guard() -> (LoginGuard, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(1_000_000));
        (LoginGuard::new(clock.clone()), clock)
    }

    #[test]
    fn four_failures_do_not_lock() {
        let (guard, _) = guard();
        for _ in 0..4 {
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_ok());
    }

    #[test]
    fn the_fifth_failure_locks_for_fifteen_minutes() {
        let (guard, clock) = guard();
        for _ in 0..5 {
            guard.record_failure("alice");
        }
        assert_eq!(guard.check("alice"), Err(LOCK_MS));

        clock.advance(LOCK_MS - 1);
        assert_eq!(guard.check("alice"), Err(1));

        clock.advance(1);
        assert!(guard.check("alice").is_ok());
    }

    #[test]
    fn counting_starts_over_after_the_lock_ends() {
        let (guard, clock) = guard();
        for _ in 0..5 {
            guard.record_failure("alice");
        }
        clock.advance(LOCK_MS);

        // 锁定结束后的第一次失败只算一次，不会立刻再锁
        guard.record_failure("alice");
        assert!(guard.check("alice").is_ok());
    }

    #[test]
    fn a_success_clears_the_count() {
        let (guard, _) = guard();
        for _ in 0..4 {
            guard.record_failure("alice");
        }
        guard.record_success("alice");
        for _ in 0..4 {
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_ok());
    }

    #[test]
    fn old_failures_are_forgotten() {
        let (guard, clock) = guard();
        for _ in 0..4 {
            guard.record_failure("alice");
        }
        clock.advance(LOCK_MS);
        guard.record_failure("alice");
        assert!(guard.check("alice").is_ok());
    }

    #[test]
    fn each_id_is_counted_separately() {
        let (guard, _) = guard();
        for _ in 0..5 {
            guard.record_failure("alice");
        }
        assert!(guard.check("alice").is_err());
        assert!(guard.check("bob").is_ok());
    }

    #[test]
    fn rate_limiter_allows_up_to_the_limit_per_window() {
        let clock = Arc::new(ManualClock::new(0));
        let limiter = RateLimiter::new(clock.clone(), 3, 60_000);
        for _ in 0..3 {
            assert!(limiter.hit("10.0.0.1").is_ok());
        }
        assert_eq!(limiter.hit("10.0.0.1"), Err(60_000));
        assert!(
            limiter.hit("10.0.0.2").is_ok(),
            "other sources are unaffected"
        );

        clock.advance(59_999);
        assert_eq!(limiter.hit("10.0.0.1"), Err(1));
        clock.advance(1);
        assert!(limiter.hit("10.0.0.1").is_ok());
    }
}
