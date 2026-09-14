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
