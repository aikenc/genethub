//! The `isolation` import: what this kernel will hold a started process to.
//!
//! The guest decides *who* must run confined and over *which* directories, and
//! builds the wrapper invocation itself. What it cannot do is find out whether
//! this machine can enforce anything: the answer is an LSM version syscall and
//! a fork that tries to unshare, neither of which a component can make. So the
//! shell probes, and the guest refuses or proceeds on a real answer instead of
//! on the flat "no backend here" a component would otherwise have to give.
//!
//! Probed once and memoised in `genet_native`, so two callers never get two
//! different stories — including the callers in the *other* process, since the
//! wrapper this answer describes is a native binary of ours.

use genehub_proto::IsolationBackend;

use crate::bindings::genehub::host::isolation as wit;

impl wit::Host for crate::load::Host {
    async fn machine(&mut self) -> wit::Report {
        let report = genet_native::confine::report();
        wit::Report {
            backend: match report.backend {
                IsolationBackend::Landlock => wit::Mechanism::Landlock,
                IsolationBackend::Namespaces => wit::Mechanism::Namespaces,
                // Named rather than defaulted: a backend this shell does not
                // know how to describe is one it cannot promise is in force.
                _ => wit::Mechanism::Absent,
            },
            enforced: report.enforced,
            detail: report.detail,
        }
    }
}
