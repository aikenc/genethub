use thiserror::Error;

pub type Result<T> = std::result::Result<T, PlatformError>;

#[derive(Debug, Error)]
pub enum PlatformError {
    #[error("artifact verification failed: {0}")]
    Verification(String),

    #[error("logic VM rejected the module: {0}")]
    Vm(String),

    #[error("the logic instance is poisoned after a failed call")]
    InstancePoisoned,

    #[error("artifact slot state is invalid: {0}")]
    State(String),

    #[error("logic revision {candidate} is older than highest accepted revision {highest}")]
    RevisionReplay { candidate: u64, highest: u64 },

    #[error("platform state lock was poisoned")]
    LockPoisoned,

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
