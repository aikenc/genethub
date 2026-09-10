//! Bounded encrypted connection controls. Decimal strings preserve u64 exactly
//! in JavaScript; serde denies unknown fields instead of silently negotiating.
use anyhow::{bail, Result};
use genehub_proto::resume::Watermark;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Position {
    received: String,
    data_grant: String,
    progress_grant: String,
}
impl Position {
    pub fn from_watermark(value: Watermark) -> Self {
        Self {
            received: value.received.to_string(),
            data_grant: value.data_grant.to_string(),
            progress_grant: value.progress_grant.to_string(),
        }
    }
    pub fn watermark(&self) -> Result<Watermark> {
        Ok(Watermark {
            received: decimal(&self.received)?,
            data_grant: decimal(&self.data_grant)?,
            progress_grant: decimal(&self.progress_grant)?,
        })
    }
}
pub(crate) fn decimal(text: &str) -> Result<u64> {
    if text.is_empty()
        || text.len() > 20
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|b| b.is_ascii_digit())
    {
        bail!("invalid logical counter");
    }
    Ok(text.parse()?)
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Message {
    Create {
        policy: String,
        #[serde(default = "resumable_default")]
        resumable: bool,
    },
    Created {
        id: String,
        incarnation: String,
        secret: String,
    },
    Attach {
        id: String,
        incarnation: String,
        attempt: String,
        proof: String,
    },
    Attached {
        epoch: String,
    },
    Activate {
        attempt: String,
        expected: String,
        position: Position,
    },
    Activated {
        epoch: String,
        position: Position,
    },
    Sync {
        epoch: String,
    },
    Synced {
        epoch: String,
    },
    Close,
    Ping {
        nonce: String,
    },
    Pong {
        nonce: String,
    },
    Error {
        code: String,
    },
}
impl Message {
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut bytes = vec![4, 16, 0, 0];
        bytes.extend(serde_json::to_vec(self)?);
        if bytes.len() > 8192 {
            bail!("logical control too large");
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if !(5..=8192).contains(&bytes.len()) || bytes[..4] != [4, 16, 0, 0] {
            bail!("invalid logical control");
        }
        Ok(serde_json::from_slice(&bytes[4..])?)
    }
}

fn resumable_default() -> bool {
    true
}
