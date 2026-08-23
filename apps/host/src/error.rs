use thiserror::Error;

pub type Result<T> = std::result::Result<T, ArtifactError>;

#[derive(Debug, Error)]
pub enum ArtifactError {
    #[error("artifact verification failed: {0}")]
    Verification(String),

    #[error("artifact slot state is invalid: {0}")]
    State(String),

    #[error("logic revision {candidate} is older than highest accepted revision {highest}")]
    RevisionReplay { candidate: u64, highest: u64 },

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
