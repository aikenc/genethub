//! Imports the shell provides because WASI cannot. Guest-only.
//!
//! The world is `daemon`: the single v2 component exports `run` / `agent-run`
//! and takes these imports in both. The export side of the world lives in
//! `apps/guest`; this crate only consumes the imports.

wit_bindgen::generate!({
    path: "../../wit",
    world: "daemon",
});
