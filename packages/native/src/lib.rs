//! The questions only a native process can answer.
//!
//! Both front doors need these: the shell that loads the wasm component
//! (`apps/host`) and the native binary that is still the daemon's own process
//! on a build without the component (`apps/cli`, `apps/daemon`). Neither can
//! borrow the other's copy — the shell would drag in the whole daemon, and the
//! daemon cannot link Wasmtime — so the answers live here once.
//!
//! Two of them, so far. What the kernel will hold a process to ([`confine`]),
//! and where a program is installed ([`locate`]). What they have in common is
//! that a WASI guest cannot work either one out: confinement is applied by the
//! process being confined, and `PATH` is a native concept the guest cannot
//! even split. The guest asks the shell over the `genehub:host` imports, and
//! the shell answers from here.

pub mod confine;

#[cfg(not(target_family = "wasm"))]
pub mod locate;
