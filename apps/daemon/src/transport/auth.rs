//! Constant-time comparison for local proofs and device credentials.

/// Constant-time comparison.
///
/// A proof check that returns early on the first wrong byte leaks the expected
/// value one byte at a time to a caller able to make repeated measurements.
pub fn token_matches(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    if expected.len() != presented.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in expected.iter().zip(presented) {
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matching_token_is_accepted_and_anything_else_is_not() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", ""));
    }
}
