//! Small portable foundations shared inside the Wasm application.
//!
//! This is an ordinary Rust library, not a runtime service. Calls remain typed
//! Rust calls inside one artifact and never cross the host boundary.

use serde::de::DeserializeOwned;
use serde::Serialize;

pub fn decode_json<T: DeserializeOwned>(
    label: &str,
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<T, String> {
    if bytes.is_empty() {
        return Err(format!("{label} is empty"));
    }
    if bytes.len() > maximum_bytes {
        return Err(format!("{label} exceeds {maximum_bytes} bytes"));
    }
    serde_json::from_slice(bytes).map_err(|error| format!("decoding {label}: {error}"))
}

pub fn encode_json<T: Serialize>(label: &str, value: &T) -> Result<Vec<u8>, String> {
    serde_json::to_vec(value).map_err(|error| format!("encoding {label}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_json_rejects_empty_oversize_and_malformed_inputs() {
        assert!(decode_json::<serde_json::Value>("event", b"", 32).is_err());
        assert!(decode_json::<serde_json::Value>("event", b"{}", 1).is_err());
        assert!(decode_json::<serde_json::Value>("event", b"{", 32).is_err());
        assert_eq!(
            decode_json::<serde_json::Value>("event", b"{}", 32).unwrap(),
            serde_json::json!({})
        );
    }
}
