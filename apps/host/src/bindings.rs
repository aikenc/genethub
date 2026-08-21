//! Generated bindings for the imports the shell provides to the guest.
//!
//! The world is `daemon-command`: the guest is still a `wasi:cli/run` command
//! and only adds what WASI cannot give it.

wasmtime::component::bindgen!({
    path: "../../wit",
    world: "daemon-command",
    imports: { default: async },
    with: {
        "genehub:host/process.child": crate::process::ChildHandle,
        "genehub:host/pty.session": crate::pty::PtySession,
        "genehub:host/file-lock.handle": crate::file_lock::LockHandle,
    },
});
