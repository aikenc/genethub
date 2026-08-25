//! Product Version lives in `genet-frontdoor` so the host, the daemon, and
//! any future binary compare versions with the one shared implementation.
//! This module keeps the host's existing `crate::version::ProductVersion`
//! path working.

pub use genet_frontdoor::version::ProductVersion;

/// This binary's own App version. Release builds are stamped at build time
/// via the crate version; a debug build additionally honours
/// `GENEHUB_APP_VERSION` so the release specialty tests can split the App
/// version from the component version without a stamped rebuild. The
/// variable is compiled out of release builds, where the App version must
/// stay a build-time fact.
pub fn app_version() -> String {
    #[cfg(debug_assertions)]
    if let Ok(version) = std::env::var("GENEHUB_APP_VERSION") {
        if !version.is_empty() {
            return version;
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}
