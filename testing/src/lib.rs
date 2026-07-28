//! Journey test harness.
//!
//! Everything except the model is real: a real daemon process state, real
//! WebSocket frames, real agent subprocesses, real files and git. The one
//! substitution is the model endpoint, and even that is swapped by
//! configuration rather than by a code path the product does not otherwise use.

pub mod client;
pub mod harness;
pub mod mock_llm;

pub use client::{Client, EventsExt};
pub use harness::{Journey, Mode};
pub use mock_llm::{MockLlm, Scripted, Turn};
