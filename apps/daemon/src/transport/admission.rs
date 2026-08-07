//! Authenticated peer authority established before business exchanges begin.

use std::time::Instant;

/// Deliberately no `Debug`: hosted variants contain E2EE key material.
#[derive(Clone)]
pub enum Admission {
    /// One-use owner-only loopback admission.
    Loopback { server_proof: String },
    /// Self-hosted peers must prove a daemon-issued device or invite secret.
    DeviceRequired,
    /// Route-bound capability redeemed directly with hosted Control.
    Fabric {
        capability_id: String,
        secret: String,
        expires_at: Instant,
    },
    /// Ephemeral direct channel bootstrapped inside an authenticated base link.
    Rtc {
        capability_id: String,
        secret: String,
        expires_at: Instant,
    },
}
