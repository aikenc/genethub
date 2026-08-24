//! The pid the local admission handshake binds to.
//!
//! On native this is simply our own process. In the WASI guest there is no pid
//! to have — `std::process::id` is `panic!("unsupported")` — and the pid a local
//! client can actually observe holding the listening socket is the shell's, not
//! the guest's. So the shell passes its own down and the guest reports that.
//! Either way the value means the same thing to the client that checks it.

#[cfg(not(target_family = "wasm"))]
pub fn current() -> u32 {
    std::process::id()
}

#[cfg(target_family = "wasm")]
pub fn current() -> u32 {
    use std::sync::OnceLock;
    static PID: OnceLock<u32> = OnceLock::new();
    *PID.get_or_init(|| {
        match std::env::var(crate::channel::ENV_HOST_PID)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .filter(|pid| *pid != 0)
        {
            Some(pid) => pid,
            None => {
                // Not fatal, but the client's pid check degrades to accepting
                // whatever it is told, so it must not pass unnoticed.
                tracing::warn!(
                    "{} is unset: local admission cannot bind to a pid",
                    crate::channel::ENV_HOST_PID
                );
                0
            }
        }
    })
}
