//! Host kernel capability report for machine diagnostics.
//! No process policy or wrapper is selected by the guest.

use genet_native::isolation::IsolationBackend;

use crate::bindings::genehub::host::isolation as wit;

impl wit::Host for crate::load::Host {
    async fn machine(&mut self) -> wit::Report {
        let report = genet_native::isolation::report();
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
