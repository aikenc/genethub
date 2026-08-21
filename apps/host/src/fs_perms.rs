//! The `fs-perms` import: owner-only permissions, which WASI does not model.
//!
//! The guest decides *which* paths are sensitive — it is the one that knows
//! `state.json` holds a bearer token and `logs/` holds transcripts. It cannot
//! act on that, because `wasi:filesystem` has no permission bits, so the shell
//! performs what the guest names. See the v2 proposal §6.9.

use crate::bindings::genehub::host::fs_perms as wit;

impl wit::Host for crate::load::Host {
    async fn restrict_to_owner(&mut self, path: String) -> Result<(), String> {
        restrict(&path).map_err(|error| format!("{path}: {error}"))
    }
}

#[cfg(unix)]
fn restrict(path: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    // Directories need the execute bit to be enterable at all, which is why
    // this is not one constant.
    let mode = if std::fs::symlink_metadata(path)?.is_dir() {
        0o700
    } else {
        0o600
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn restrict(path: &str) -> std::io::Result<()> {
    // Windows owner-only is an ACL rather than a mode, and the guest reaches it
    // through the same call. Not yet needed: the shell is Unix-only today.
    let _ = path;
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "owner-only permissions are not implemented on this platform",
    ))
}
