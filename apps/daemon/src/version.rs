//! The two versions a daemon answers about, and where each comes from.
//!
//! The **product version** is the loaded component envelope's release
//! version, handed over by the host at instantiate time: a Live release moves
//! it without touching any binary. The **App version** is the host binary's
//! own, and is what an App update check compares against the channel's App
//! manifest. A native or source build has no host to hand either over and
//! falls back to this crate's own build version for both.
//!
//! Neither variable is a trust boundary: inside the component they are the
//! host's assertions about itself, and a native daemon that lets its
//! environment rename itself only misleads whoever set it.

/// The product version this daemon serves — the running component's.
pub fn product_version() -> String {
    handed_over("GENEHUB_COMPONENT_VERSION")
}

/// The App build this daemon runs inside — the host binary's.
pub fn app_version() -> String {
    handed_over("GENEHUB_APP_VERSION")
}

fn handed_over(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}
