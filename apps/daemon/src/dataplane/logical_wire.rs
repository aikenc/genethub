//! Admission controls for one authenticated connection. No attach or replay.
use anyhow::{bail, Result};
pub(crate) use genehub_proto::ConnectionAdmission as Message;

pub(crate) fn encode(message: &Message) -> Result<Vec<u8>> {
    let mut bytes = vec![4, 16, 0, 0];
    bytes.extend(serde_json::to_vec(message)?);
    if bytes.len() > 8192 {
        bail!("connection control too large");
    }
    Ok(bytes)
}
pub(crate) fn decode(bytes: &[u8]) -> Result<Message> {
    if !(5..=8192).contains(&bytes.len()) || bytes[..4] != [4, 16, 0, 0] {
        bail!("invalid connection admission control");
    }
    Ok(serde_json::from_slice(&bytes[4..])?)
}
