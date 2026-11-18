//! 密码的强度规则，以及保存和校验密码的抽象。

use async_trait::async_trait;

use super::error::AccountError;
use super::handle::normalize;

const MIN_LEN: usize = 8;
/// 上限只是为了防止有人提交超长的内容来消耗计算资源。
const MAX_LEN: usize = 128;

/// 至少 8 位，同时包含字母和数字，不能与 ID 相同。
pub fn check_strength(password: &str, handle: Option<&str>) -> Result<(), AccountError> {
    let length = password.chars().count();
    let has_letter = password.chars().any(char::is_alphabetic);
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    if !(MIN_LEN..=MAX_LEN).contains(&length) || !has_letter || !has_digit {
        return Err(AccountError::PasswordTooWeak);
    }
    if handle.is_some_and(|handle| normalize(handle) == normalize(password)) {
        return Err(AccountError::PasswordSameAsHandle);
    }
    Ok(())
}

/// 密码的保存和校验。保存的结果不可还原；同一个密码每次保存的结果都不同。
///
/// 真正的实现计算量很大，放在 `infra` 里并且在独立的线程上执行；测试用快速的假实现。
#[async_trait]
pub trait PasswordHasher: Send + Sync {
    async fn hash(&self, password: &str) -> String;

    async fn verify(&self, password: &str, hash: &str) -> bool;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_password_with_letters_and_digits() {
        assert!(check_strength("abc12345", None).is_ok());
        assert!(check_strength("密码密码密码a1", None).is_ok());
    }

    #[test]
    fn rejects_a_short_password() {
        assert!(matches!(
            check_strength("abc1234", None),
            Err(AccountError::PasswordTooWeak)
        ));
    }

    #[test]
    fn rejects_a_password_without_digits_or_without_letters() {
        assert!(matches!(
            check_strength("abcdefgh", None),
            Err(AccountError::PasswordTooWeak)
        ));
        assert!(matches!(
            check_strength("12345678", None),
            Err(AccountError::PasswordTooWeak)
        ));
    }

    #[test]
    fn rejects_an_absurdly_long_password() {
        let long = format!("a1{}", "x".repeat(200));
        assert!(matches!(
            check_strength(&long, None),
            Err(AccountError::PasswordTooWeak)
        ));
    }

    #[test]
    fn rejects_a_password_equal_to_the_id_ignoring_case() {
        assert!(matches!(
            check_strength("Alice2026", Some("alice2026")),
            Err(AccountError::PasswordSameAsHandle)
        ));
        assert!(check_strength("Alice2026", Some("bob_2026")).is_ok());
    }
}
