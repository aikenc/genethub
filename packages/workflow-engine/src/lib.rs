//! A pure, versioned structured-workflow state machine.
//!
//! No storage, clocks, threads, process launching, leases or provider calls.
//! Hosts must commit a transition before dispatching `pending` operations, and
//! provide idempotent operation identities and trustworthy settled results.
mod expr;
mod inspect;
mod model;
mod program;
mod runtime;
pub use inspect::{ancestry, inspect, FrameView};
pub use model::*;
pub use program::{compile, Program};
pub use runtime::{advance, pending, start};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(Box<Diagnostic>),
    #[error("invalid workflow: {0}")]
    Definition(String),
    #[error("invalid workflow state: {0}")]
    State(String),
    #[error("workflow revision conflict: expected {expected}, current {actual}")]
    Conflict { expected: u64, actual: u64 },
    #[error("condition error: {0}")]
    Condition(String),
    #[error("workflow serialization: {0}")]
    Serialization(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

/// Source-relative JSON Pointer, independent of files, YAML, storage or an LLM.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub path: String,
    pub message: String,
    pub hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}
impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} at {}: {}. {}",
            self.code, self.path, self.message, self.hint
        )
    }
}
impl Error {
    pub(crate) fn located(self, path: &str) -> Self {
        if matches!(self, Self::Invalid(_)) {
            self
        } else {
            self.at(path)
        }
    }
    pub(crate) fn invalid(code: &str, path: &str, message: impl Into<String>, hint: &str) -> Self {
        Self::Invalid(Box::new(Diagnostic {
            code: code.into(),
            path: path.into(),
            message: message.into(),
            hint: hint.into(),
            expected: None,
            actual: None,
        }))
    }
    pub(crate) fn at(self, prefix: &str) -> Self {
        match self {
            Self::Invalid(mut diagnostic) => {
                diagnostic.path = format!("{prefix}{}", diagnostic.path);
                Self::Invalid(diagnostic)
            }
            Self::Definition(message) => Self::invalid("WF_DEFINITION", prefix, message,
                "Correct this definition using the installed workflow schema; do not change execution authority."),
            other => other,
        }
    }
}

pub fn pointer_token(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
