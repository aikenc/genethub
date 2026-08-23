use thiserror::Error;

pub type Result<T> = std::result::Result<T, ArtifactError>;

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("artifact verification failed: {0}")]
    Verification(String),

    #[error("artifact slot state is invalid: {0}")]
    State(String),

    #[error("release version {candidate} is older than highest accepted version {highest}")]
    VersionReplay { candidate: String, highest: String },

    #[error("envelope field {field} is invalid: {reason}")]
    EnvelopeField { field: &'static str, reason: String },

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
