//! 密码的保存和校验，用 Argon2id。

use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher as _, PasswordVerifier};
use argon2::{Algorithm, Argon2, Params, Version};
use async_trait::async_trait;
use vibechat_core::account::password::PasswordHasher;

pub struct Argon2Hasher {
    params: Params,
}

impl Argon2Hasher {
    /// 正式使用的强度：19 MiB 内存、2 轮，是目前通行的推荐值。
    pub fn new() -> Self {
        Self {
            params: Params::default(),
        }
    }

    /// 测试用：强度降到最低，否则每次哈希要几十到几百毫秒。不要在正式环境使用。
    pub fn fast_for_tests() -> Self {
        Self {
            params: Params::new(Params::MIN_M_COST, 1, 1, None).expect("valid argon2 params"),
        }
    }

    fn argon2(&self) -> Argon2<'static> {
        Argon2::new(Algorithm::Argon2id, Version::V0x13, self.params.clone())
    }
}

impl Default for Argon2Hasher {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl PasswordHasher for Argon2Hasher {
    async fn hash(&self, password: &str) -> String {
        let argon2 = self.argon2();
        let password = password.to_owned();
        // 计算量大，放到专门的线程上，不占用处理请求的线程
        tokio::task::spawn_blocking(move || {
            argon2
                .hash_password(password.as_bytes())
                .expect("argon2 hashing with valid params does not fail")
                .to_string()
        })
        .await
        .expect("password hashing task panicked")
    }

    async fn verify(&self, password: &str, hash: &str) -> bool {
        let argon2 = self.argon2();
        let password = password.to_owned();
        let hash = hash.to_owned();
        tokio::task::spawn_blocking(move || {
            // 校验时用的是保存在哈希里的参数，所以以后调整强度不影响已有的密码
            PasswordHash::new(&hash)
                .is_ok_and(|parsed| argon2.verify_password(password.as_bytes(), &parsed).is_ok())
        })
        .await
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_right_password_verifies_and_a_wrong_one_does_not() {
        let hasher = Argon2Hasher::fast_for_tests();
        let hash = hasher.hash("correct-horse-1").await;
        assert!(hasher.verify("correct-horse-1", &hash).await);
        assert!(!hasher.verify("correct-horse-2", &hash).await);
    }

    #[tokio::test]
    async fn the_stored_form_does_not_contain_the_password_and_differs_each_time() {
        let hasher = Argon2Hasher::fast_for_tests();
        let first = hasher.hash("correct-horse-1").await;
        let second = hasher.hash("correct-horse-1").await;
        assert!(first.starts_with("$argon2id$"));
        assert!(!first.contains("correct-horse-1"));
        assert_ne!(first, second, "each hash uses its own random salt");
    }

    #[tokio::test]
    async fn a_hash_made_with_other_settings_still_verifies() {
        let stored = Argon2Hasher::fast_for_tests().hash("correct-horse-1").await;
        assert!(Argon2Hasher::new().verify("correct-horse-1", &stored).await);
    }

    #[tokio::test]
    async fn garbage_in_place_of_a_hash_never_verifies() {
        let hasher = Argon2Hasher::fast_for_tests();
        assert!(!hasher.verify("anything-1", "not-a-hash").await);
        assert!(!hasher.verify("anything-1", "").await);
    }
}
