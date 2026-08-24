//! Which protocol generation a build speaks.
//!
//! Three numbers and a method name, split out of `genehub-proto` so that the
//! things which only need to *state* a protocol generation do not have to link
//! the schema that defines it. The native front door is the case that matters:
//! `apps/host` stamps `webProtocol` into an artifact envelope when it packs a
//! component, and for that one number it used to compile all four thousand
//! lines of session RPC, timeline and speech types into every host binary on
//! three operating systems.
//!
//! That coupling was invisible but not harmless. It made an edit to the session
//! protocol look like an edit to the App, which is exactly backwards: the App
//! pairs with a component through the WIT digest in `apps/host/src/abi.rs`, and
//! nothing in the session schema can move that digest. See
//! `docs/cli-thin-forwarder.md` §6.
//!
//! `genehub-proto` re-exports everything here, so the protocol crate stays the
//! single import for anyone who wants the schema too.

/// Bumped when a change would break an older client. Clients that see a version
/// they do not know must refuse to connect rather than guess.
///
/// WebProtocol version spoken by Web/CLI clients. It deliberately does not
/// inherit the binary carrier version: either side may evolve without turning
/// a protocol adapter into a data-plane upgrade.
pub const WEB_PROTOCOL_VERSION: u32 = 3;

/// Generation of the binary carrier that frames the typed protocol above.
///
/// Separate from [`WEB_PROTOCOL_VERSION`] for the same reason: a change to how
/// bytes are framed is not a change to what the two sides say to each other.
pub const DATA_PLANE_VERSION: u32 = 3;

/// Lean carrier method that returns `{ webProtocol }` before the first
/// business RPC. It is not a `Request` variant.
pub const PROTOCOL_IDENTITY_METHOD: &str = "protocol.identity";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_generation_pair_is_pinned_so_a_bump_is_a_deliberate_act() {
        // Not a tautology: these numbers are what an older peer refuses to
        // connect on, so raising one is a compatibility decision, not an
        // implementation detail. Failing here is the prompt to also ship the
        // refusal path and say which peers are being cut off.
        //
        // They are equal today, which is exactly why they are asserted apart: a
        // reader who assumes one implies the other bumps one and breaks the
        // other side.
        assert_eq!(WEB_PROTOCOL_VERSION, 3);
        assert_eq!(DATA_PLANE_VERSION, 3);
    }

    #[test]
    fn the_identity_method_is_namespaced_away_from_business_verbs() {
        // It is answered before the client has agreed on anything, so it must
        // not be able to collide with a verb somebody adds to the schema later.
        assert_eq!(PROTOCOL_IDENTITY_METHOD, "protocol.identity");
        assert!(PROTOCOL_IDENTITY_METHOD.starts_with("protocol."));
    }
}
