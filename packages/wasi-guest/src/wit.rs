//! Imports the shell provides because WASI cannot. Guest-only.
//!
//! The world is `daemon-command`, not `daemon`: the guest is still a
//! `wasi:cli/run` command and only takes the imports it needs. Switching the
//! entry to the `run` / `agent-run` exports is a separate step.

wit_bindgen::generate!({
    path: "../../wit",
    world: "daemon-command",
});
