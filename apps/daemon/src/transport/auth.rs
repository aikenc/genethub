//! Client authentication for the local and LAN channels.

/// Constant-time comparison.
///
/// A token check that returns early on the first wrong byte leaks the token
/// one byte at a time to anything that can time it, and the LAN channel is
/// reachable by other machines.
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

/// Pulls the token from either the query string or an `Authorization` header.
///
/// Browsers cannot set headers on a WebSocket handshake, so the query form has
/// to exist; other clients should prefer the header.
pub fn extract_token(query: Option<&str>, authorization: Option<&str>) -> Option<String> {
    if let Some(value) = authorization {
        if let Some(token) = value.strip_prefix("Bearer ") {
            return Some(token.trim().to_string());
        }
    }
    let query = query?;
    for pair in query.split('&') {
        if let Some(value) = pair.strip_prefix("token=") {
            return Some(urldecode(value));
        }
    }
    None
}

fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(b'%');
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
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

    #[test]
    fn the_header_form_wins_over_the_query_form() {
        assert_eq!(
            extract_token(Some("token=fromquery"), Some("Bearer fromheader")).as_deref(),
            Some("fromheader")
        );
    }

    #[test]
    fn the_query_form_works_because_browsers_cannot_set_headers() {
        assert_eq!(
            extract_token(Some("a=1&token=secret&b=2"), None).as_deref(),
            Some("secret")
        );
    }

    #[test]
    fn percent_escapes_in_the_query_are_decoded() {
        assert_eq!(
            extract_token(Some("token=a%2Bb%20c"), None).as_deref(),
            Some("a+b c")
        );
    }

    #[test]
    fn a_request_with_no_token_anywhere_yields_none() {
        assert!(extract_token(None, None).is_none());
        assert!(extract_token(Some("other=1"), Some("Basic xyz")).is_none());
    }
}
