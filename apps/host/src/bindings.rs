//! Generated bindings for the `daemon` world: the imports the shell provides
//! and the two exports (`run` / `agent-run`) it picks between per process.

wasmtime::component::bindgen!({
    path: "../../wit",
    world: "daemon",
    imports: { default: async },
    exports: { default: async },
    with: {
        "genehub:host/process.child": crate::process::ChildHandle,
        "genehub:host/pty.session": crate::pty::PtySession,
        "genehub:host/rtc.session": crate::rtc::RtcSession,
        "genehub:host/file-lock.handle": crate::file_lock::LockHandle,
    },
});
