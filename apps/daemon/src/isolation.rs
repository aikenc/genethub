//! OS isolation diagnostics, shared by native and WASM daemons.
//!
//! Complete connections use the daemon OS account; no identity tier selects
//! an implicit sandbox here. The kernel report describes available capabilities
//! only. WASM asks the host rather than claiming a guest owns a kernel.

use genehub_proto::IsolationInfo;

/// What this machine can enforce, asked once and answered the same way every
/// time so that two callers never get two different stories.
pub fn report() -> IsolationInfo {
    static REPORT: std::sync::OnceLock<IsolationInfo> = std::sync::OnceLock::new();
    REPORT.get_or_init(probe).clone()
}

// Both arms translate somebody else's answer into the wire type. Neither
// invents one: the native probe belongs to `genet_native`, which owns a kernel,
// and the guest's belongs to the shell it asks over `genehub:host/isolation`.
#[cfg(not(target_family = "wasm"))]
fn probe() -> IsolationInfo {
    use genehub_proto::IsolationBackend;
    use genet_native::isolation::IsolationBackend as Native;

    let report = genet_native::isolation::report();
    IsolationInfo {
        backend: match report.backend {
            Native::Landlock => IsolationBackend::Landlock,
            Native::Namespaces => IsolationBackend::Namespaces,
            Native::Seatbelt => IsolationBackend::Seatbelt,
            Native::AppContainer => IsolationBackend::AppContainer,
            Native::None => IsolationBackend::None,
        },
        enforced: report.enforced,
        detail: report.detail,
    }
}

#[cfg(target_family = "wasm")]
fn probe() -> IsolationInfo {
    use genehub_proto::IsolationBackend;
    use genet_wasi::wit::genehub::host::isolation;

    let report = isolation::machine();
    IsolationInfo {
        backend: match report.backend {
            isolation::Mechanism::Landlock => IsolationBackend::Landlock,
            isolation::Mechanism::Namespaces => IsolationBackend::Namespaces,
            isolation::Mechanism::Absent => IsolationBackend::None,
        },
        enforced: report.enforced,
        detail: report.detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::IsolationBackend;

    #[test]
    fn a_machine_reports_the_same_thing_every_time_it_is_asked() {
        // Machine diagnostics must return the same capability observation.
        assert_eq!(report(), report());
    }

    #[test]
    fn nothing_is_claimed_that_is_not_implemented_here() {
        let report = report();
        if report.backend == IsolationBackend::None {
            assert!(!report.enforced, "no backend cannot be enforcing anything");
        }
        assert!(
            !report.detail.trim().is_empty(),
            "a report a person cannot act on is not a report"
        );
    }
}
