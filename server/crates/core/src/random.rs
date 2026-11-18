//! 密码学强度的随机数：会话令牌、邀请码、默认 ID 都从这里来。

/// 从操作系统取随机字节。取不到说明系统环境有严重问题，直接终止。
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).expect("operating system random number generator is unavailable");
    bytes
}

/// 从给定的字符表里均匀地随机取 `len` 个字符。
pub fn random_string(alphabet: &[u8], len: usize) -> String {
    assert!(!alphabet.is_empty() && alphabet.len() <= 256);
    // 丢弃落在最后一个不完整区间里的字节，否则靠前的字符会出现得更多
    let limit = 256 - (256 % alphabet.len());
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for byte in random_bytes::<32>() {
            if (byte as usize) < limit && out.len() < len {
                out.push(alphabet[byte as usize % alphabet.len()] as char);
            }
        }
    }
    out
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_string_has_the_requested_length_and_alphabet() {
        let value = random_string(b"abc", 500);
        assert_eq!(value.len(), 500);
        assert!(value.chars().all(|c| "abc".contains(c)));
        // 500 个字符里三种都应该出现
        for c in "abc".chars() {
            assert!(value.contains(c));
        }
    }

    #[test]
    fn two_random_values_differ() {
        assert_ne!(random_bytes::<32>(), random_bytes::<32>());
    }

    #[test]
    fn hex_is_lowercase_and_two_digits_per_byte() {
        assert_eq!(hex(&[0x00, 0x0f, 0xab]), "000fab");
    }
}
