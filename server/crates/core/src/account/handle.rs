//! 用户看得见的 ID 的规则。代码里叫 handle，以免与内部编号混淆。

use crate::random::random_string;

/// 第一名管理员的 ID。它只有 5 位，普通用户自定义的 ID 至少 6 位，所以不会被别人占用。
pub const ADMIN_HANDLE: &str = "admin";

const MIN_LEN: usize = 6;
const MAX_LEN: usize = 20;
const DEFAULT_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// 注册时系统分配的默认 ID：`vc` 加 8 位小写字母和数字。
pub fn generate_default() -> String {
    format!("vc{}", random_string(DEFAULT_ALPHABET, 8))
}

/// 用户自定义的 ID 是否符合规则：6 到 20 位，字母开头，只含字母、数字和下划线。
pub fn is_valid_custom(handle: &str) -> bool {
    let mut chars = handle.chars();
    let starts_with_letter = chars.next().is_some_and(|c| c.is_ascii_alphabetic());
    starts_with_letter
        && (MIN_LEN..=MAX_LEN).contains(&handle.len())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 用于比较和查找的形式。ID 不区分大小写：`Alice` 和 `alice` 是同一个。
pub fn normalize(handle: &str) -> String {
    handle.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_handle_is_vc_plus_eight_lowercase_alphanumerics() {
        let handle = generate_default();
        assert_eq!(handle.len(), 10);
        assert!(handle.starts_with("vc"));
        assert!(
            handle
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        );
        assert!(is_valid_custom(&handle), "a default id is also a valid id");
    }

    #[test]
    fn default_handles_differ() {
        assert_ne!(generate_default(), generate_default());
    }

    #[test]
    fn accepts_handles_that_follow_the_rules() {
        for handle in ["abcdef", "Alice_2026", "a_b_c_d", "x1234567890123456789"] {
            assert!(is_valid_custom(handle), "{handle} should be valid");
        }
    }

    #[test]
    fn rejects_too_short_or_too_long() {
        assert!(!is_valid_custom("abcde"));
        assert!(!is_valid_custom("a12345678901234567890"));
        assert!(!is_valid_custom(""));
    }

    #[test]
    fn rejects_a_first_character_that_is_not_a_letter() {
        assert!(!is_valid_custom("1abcdef"));
        assert!(!is_valid_custom("_abcdef"));
    }

    #[test]
    fn rejects_other_characters() {
        for handle in ["abc-def", "abc def", "abc.def", "abcdé1", "中文中文中文"] {
            assert!(!is_valid_custom(handle), "{handle} should be invalid");
        }
    }

    #[test]
    fn the_admin_handle_cannot_be_chosen_by_a_user() {
        assert!(!is_valid_custom(ADMIN_HANDLE));
    }

    #[test]
    fn normalize_ignores_case_and_surrounding_spaces() {
        assert_eq!(normalize("  Alice_2026 "), "alice_2026");
    }
}
