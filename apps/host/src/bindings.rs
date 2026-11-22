//! Generated bindings for the `daemon` world: the imports the shell provides
//! and the entry points for the daemon, agent and background worker.

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
        "genehub:host/scoped-fs.file": crate::scoped_fs::File,
        "genehub:host/scoped-fs.directory": crate::scoped_fs::Directory,
        "genehub:host/tls-server.connection": crate::tls_server::Connection,
        "genehub:host/tls-server.listener": crate::tls_server::Listener,
        "genehub:host/worker.instance": crate::worker::Instance,
        "genehub:host/image-preview.job": crate::image_preview::Job,
    },
});
