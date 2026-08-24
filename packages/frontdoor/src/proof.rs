//! Loopback control-plane proofs.
//!
//! Both sides of the local control plane are ours: the daemon mints these and
//! the native front door checks them, or the other way round. That is why they
//! live in one place — a proof the two sides compute differently is a proof
//! neither of them is actually making.
//!
//! Three properties, none of them optional:
//!
//! - The reusable bearer in `endpoint.json` never crosses a socket. Only a MAC
//!   over it does, so capturing the wire yields nothing that can be replayed
//!   against a later daemon.
//! - Every action has its own domain string. A captured `health` proof cannot
//!   be presented as a `shutdown`, which would otherwise turn the cheapest
//!   liveness probe into a way to stop the machine.
//! - The destructive actions expire. A pid and a port are both reusable by an
//!   unrelated process, so a proof that never went stale would eventually
//!   authorize an action against something else entirely.

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// How long a one-use admission stays valid. Short on purpose: it only has to
/// survive the round trip from minting it to presenting it.
pub const ADMISSION_LIFETIME_SECS: u64 = 15;

/// Constant-time comparison.
///
/// A proof check that returns early on the first wrong byte leaks the expected
/// value one byte at a time to a caller able to make repeated measurements.
pub fn token_matches(expected: &str, presented: &str) -> bool {
    let expected = expected.as_bytes();
    let presented = presented.as_bytes();
    if expected.len() != presented.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in expected.iter().zip(presented) {
        difference |= a ^ b;
    }
    difference == 0
}

/// A fresh secret, long enough that guessing is not a strategy.
pub fn random_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Proof that a health response came from the daemon which owns endpoint.json.
///
/// The endpoint bearer never leaves the machine-private file. A fresh public
/// challenge prevents a stale response from being replayed after the daemon's
/// pid or port has been reused by another process.
pub fn health_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    control_proof(token, b"health", challenge, pid, machine_id, fingerprint)
}

/// One-use proof for the destructive loopback shutdown action.
pub fn shutdown_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"shutdown",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

/// One-use proof for forwarding a native CLI invocation into this daemon.
pub fn cli_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"cli",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

/// One-use, short-lived admission for opening the privileged loopback WS.
pub fn websocket_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

/// The daemon's half of the websocket admission: what proves to the client that
/// the listener it reached is the one that minted the admission.
pub fn websocket_server_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket-server",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

fn expiring_control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    let mut mac = control_mac(token, action, challenge, pid, machine_id, fingerprint);
    let expiry = expires_at.to_be_bytes();
    mac.update(&(expiry.len() as u64).to_be_bytes());
    mac.update(&expiry);
    hex(mac)
}

fn control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    hex(control_mac(
        token,
        action,
        challenge,
        pid,
        machine_id,
        fingerprint,
    ))
}

fn hex(mac: Hmac<Sha256>) -> String {
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn control_mac(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts every bearer length");
    // Length-prefixed, so that moving a byte from one field to the next cannot
    // produce the same MAC as the original — which is how a machine id and a
    // fingerprint concatenated without lengths would collide.
    for field in [
        b"genehub-loopback-control-v1".as_slice(),
        action,
        challenge.as_bytes(),
        &pid.to_be_bytes(),
        machine_id.as_bytes(),
        fingerprint.as_bytes(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field);
    }
    mac
}

/// Whether a challenge is one we are willing to put in a MAC and in a URL.
///
/// An empty challenge would make a captured response reusable forever, which is
/// why even an ordinary liveness probe has to supply one.
pub fn valid_control_challenge(challenge: &str) -> bool {
    !challenge.is_empty()
        && challenge.len() <= 128
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

/// Seconds since the epoch. Both sides of an expiry have to read the same clock,
/// and on one machine they do.
pub fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Mints a short-lived URL without putting the reusable bearer on the wire.
pub struct LocalWebSocketAdmission {
    pub url: String,
    pub server_proof: String,
    pub challenge: String,
    pub pid: u32,
    pub machine_id: String,
    pub fingerprint: String,
    pub expires_at: u64,
}

/// Mints both halves of a short-lived loopback admission. Only `url` crosses
/// the socket boundary; `server_proof` and its transcript travel through the
/// owner-only local control path.
pub fn websocket_admission(
    port: u16,
    token: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> LocalWebSocketAdmission {
    let challenge = random_token();
    let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
    let proof = websocket_proof(token, &challenge, pid, machine_id, fingerprint, expires_at);
    let server_proof =
        websocket_server_proof(token, &challenge, pid, machine_id, fingerprint, expires_at);
    LocalWebSocketAdmission {
        url: format!(
            "ws://127.0.0.1:{port}/ws?challenge={challenge}&pid={pid}&expiresAt={expires_at}&proof={proof}"
        ),
        server_proof,
        challenge,
        pid,
        machine_id: machine_id.to_owned(),
        fingerprint: fingerprint.to_owned(),
        expires_at,
    }
}

/// Mints a one-use loopback URL for `POST /cli`. The reusable bearer stays in
/// endpoint.json; only this short-lived proof crosses the socket.
pub fn cli_url(port: u16, token: &str, pid: u32, machine_id: &str, fingerprint: &str) -> String {
    let challenge = random_token();
    let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
    let proof = cli_proof(token, &challenge, pid, machine_id, fingerprint, expires_at);
    format!(
        "http://127.0.0.1:{port}/cli?challenge={challenge}&pid={pid}&expiresAt={expires_at}&proof={proof}"
    )
}

pub fn websocket_url(
    port: u16,
    token: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    websocket_admission(port, token, pid, machine_id, fingerprint).url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matching_token_is_accepted_and_anything_else_is_not() {
        assert!(token_matches("abc123", "abc123"));
        assert!(!token_matches("abc123", "abc124"));
        assert!(!token_matches("abc123", "abc12"));
        assert!(!token_matches("abc123", ""));
    }

    #[test]
    fn every_action_gets_its_own_proof_for_the_same_transcript() {
        // The point of the domain string: a proof captured from one action must
        // be useless when presented as another, or a liveness probe becomes a
        // way to shut the machine down.
        let expires_at = 1_700_000_000;
        let proofs = [
            health_proof("token", "challenge", 42, "machine", "fingerprint"),
            shutdown_proof("token", "challenge", 42, "machine", "fingerprint", expires_at),
            cli_proof("token", "challenge", 42, "machine", "fingerprint", expires_at),
            websocket_proof("token", "challenge", 42, "machine", "fingerprint", expires_at),
            websocket_server_proof(
                "token",
                "challenge",
                42,
                "machine",
                "fingerprint",
                expires_at,
            ),
        ];
        for (index, proof) in proofs.iter().enumerate() {
            for other in &proofs[index + 1..] {
                assert_ne!(proof, other, "two actions share a proof");
            }
        }
    }

    #[test]
    fn an_expiring_proof_changes_with_its_expiry() {
        let early = shutdown_proof("token", "challenge", 42, "machine", "fingerprint", 1_000);
        let late = shutdown_proof("token", "challenge", 42, "machine", "fingerprint", 1_001);
        assert_ne!(early, late, "the expiry is not covered by the MAC");
    }

    #[test]
    fn field_boundaries_are_covered_so_a_transcript_cannot_be_reshuffled() {
        // Without length prefixes these two transcripts would concatenate to
        // the same bytes and produce the same proof.
        let left = health_proof("token", "challenge", 42, "machine", "fingerprint");
        let right = health_proof("token", "challenge", 42, "machinefinger", "print");
        assert_ne!(left, right);
    }

    #[test]
    fn a_minted_url_carries_a_proof_and_never_the_bearer() {
        let url = websocket_url(1234, "never-send-me", 42, "machine", "fingerprint");
        assert!(url.starts_with("ws://127.0.0.1:1234/ws?challenge="));
        assert!(url.contains("&pid=42&expiresAt="));
        assert!(url.contains("&proof="));
        assert!(!url.contains("never-send-me"));
        assert!(!url.contains("token="));

        let cli = cli_url(1234, "never-send-me", 42, "machine", "fingerprint");
        assert!(cli.starts_with("http://127.0.0.1:1234/cli?challenge="));
        assert!(!cli.contains("never-send-me"));
        assert!(!cli.contains("token="));
    }

    #[test]
    fn the_websocket_proof_is_a_frozen_cross_client_contract() {
        // Frozen on purpose. Both ends of the loopback admission are separately
        // built binaries that can be different versions of themselves, so the
        // transcript layout is a wire format: changing it silently locks an
        // installed CLI out of a running daemon. Break these vectors only
        // alongside a deliberate control-plane version bump.
        assert_eq!(
            websocket_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            ),
            "cb10c4c41a54062a453ddd359fd970815064e19ac5a5e2c511103a924129c3c7"
        );
        assert_eq!(
            websocket_server_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            ),
            "6b02a83a6c67e128a762565b92b7184874e9eb806269581b35c8c05f13e3e5c2"
        );
    }

    #[test]
    fn a_challenge_has_to_be_present_and_url_safe() {
        assert!(valid_control_challenge("abc-123_x"));
        assert!(!valid_control_challenge(""));
        assert!(!valid_control_challenge("has space"));
        assert!(!valid_control_challenge("has&ampersand"));
        assert!(!valid_control_challenge(&"x".repeat(129)));
    }

    #[test]
    fn two_random_tokens_are_not_the_same_token() {
        assert_ne!(random_token(), random_token());
        assert_eq!(random_token().len(), 64);
    }
}
