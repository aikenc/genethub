//! Guest-side plumbing the daemon and the agent both need.
//!
//! Two things WASI does not give a component: a way to start a process
//! (WASI#899) and a lock the whole machine agrees on. The shell imports supply
//! both, and this crate is the guest half.
//!
//! Everything obeys one rule — no import here may block. A blocking import
//! parks the entire instance, not one task, so every wait is a non-blocking
//! probe plus a timer. See the v2 proposal §6.10.

#[cfg(target_family = "wasm")]
pub mod wit;

#[cfg(target_family = "wasm")]
pub mod poll;

#[cfg(target_family = "wasm")]
pub mod process;

#[cfg(target_family = "wasm")]
pub mod pty;

#[cfg(target_family = "wasm")]
pub mod stdio;
