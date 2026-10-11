//! Process spawn types.
//!
//! Native is `tokio::process`. The guest gets the same shape backed by the
//! host's `process` WIT import, because WASI has no exec (WASI#899).

#[cfg(not(target_family = "wasm"))]
pub use std::process::ExitStatus;
#[cfg(not(target_family = "wasm"))]
pub use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[cfg(target_family = "wasm")]
pub use genet_wasi::process::*;

/// The signal that ended a child, on every target that has one: Unix natively,
/// and the guest, whose shell reports it through `try-wait`.
pub fn signal_of(status: &ExitStatus) -> Option<i32> {
    #[cfg(target_family = "wasm")]
    return status.signal();
    #[cfg(all(unix, not(target_family = "wasm")))]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(any(unix, target_family = "wasm")))]
    {
        let _ = status;
        None
    }
}

/// `SIGKILL` for 9, and so on for the ones worth naming; the number otherwise.
/// Linux numbering, which every Unix shares for these.
pub fn signal_name(signal: i32) -> String {
    let name = match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => return format!("信号 {signal}"),
    };
    name.to_string()
}
