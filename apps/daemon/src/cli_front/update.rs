//! Update entry point.
//!
//! Releases currently publish hashes beside their artifacts, but no signature
//! rooted independently from the release host. That detects accidental damage;
//! it cannot authenticate code after a host or workflow compromise. Keep this
//! command fail-closed until a public signing root and verification policy ship.

use super::{fail, EXIT_FAILED};

pub fn update(args: &[String]) -> i32 {
    if !args.is_empty() {
        return super::usage();
    }
    fail(
        "unsupported",
        "automatic update is disabled until releases have an independent signing key; download manually from https://github.com/aikenc/genethub/releases and verify SHA256SUMS",
        EXIT_FAILED,
    )
}
