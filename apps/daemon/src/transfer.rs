//! Cross-machine file transfer.
//!
//! One capability covers both directions: the receiving machine downloads
//! from the source. To move a file the other way, the user runs the same
//! download on the other machine (for example through `genet --machine <id>
//! shell`). The receiver owns resume, verification and the final rename, so
//! completion is decided where the file lands.

pub mod wire {
    use serde::{Deserialize, Serialize};

    /// What identifies one version of a source file for the length of a
    /// transfer. A resume is only allowed against the same identity, so two
    /// versions are never spliced into one result.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileIdentity {
        pub size: u64,
        pub modified_ms: i64,
    }

    impl FileIdentity {
        pub fn of(metadata: &std::fs::Metadata) -> Self {
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_millis() as i64)
                .unwrap_or(0);
            FileIdentity {
                size: metadata.len(),
                modified_ms,
            }
        }
    }

    /// `file.read` request metadata.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileReadRequest {
        /// Absolute path on the answering machine.
        pub path: String,
        #[serde(default)]
        pub offset: u64,
        /// Refuse unless the source still has this identity.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expect: Option<FileIdentity>,
        /// Answer with the whole file's SHA-256 instead of its bytes.
        #[serde(default)]
        pub digest: bool,
    }

    /// `file.read` response metadata.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileReadHead {
        pub identity: FileIdentity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sha256: Option<String>,
    }
}
