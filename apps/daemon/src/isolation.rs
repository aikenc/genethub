//! Who has to run confined, and what this machine can hold them to.
//!
//! The mechanism itself is native and lives in `genet_native::confine`: a
//! kernel probe, and a wrapper process that restricts itself before it execs.
//! What is left here is the part that is about *this* product — which callers
//! need confining, over which directories, and what they are told about it.
//!
//! The daemon is the same code in a native process and in a wasm component, so
//! the one thing that differs is where the machine's answer comes from. A
//! native daemon asks the kernel. The guest asks the shell over
//! `genehub:host/isolation`, because a component has no way to make either of
//! those syscalls — and a guest that answered for itself would have to say "no
//! backend" on every machine, refusing every remote terminal on machines that
//! could in fact have confined it.

use std::path::PathBuf;

use genehub_proto::IsolationInfo;

pub use genet_native::confine::{
    Policy, CONFINED_BACKEND_ENV, CONFINED_ROOTS_ENV, CONFINE_ARG, CONFINE_COMMAND_ENV,
};

#[cfg(not(target_family = "wasm"))]
pub use genet_native::confine::{confine, confine_and_exec};

/// Decides what the operating system must hold this caller's process to.
///
/// The same question for a terminal and for a single command, answered in one
/// place because they are the same authority: anything that can be done in one
/// can be done in the other.
///
/// Whoever is sitting at this machine gets a process with nothing in its way:
/// they already own the account, so confining them would cost them a working
/// shell and protect nobody (`architecture.md` §3.4). A device that reaches in
/// from somewhere else is a different subject, and the only reason its
/// processes were ever unconstrained is that nothing existed to constrain them.
///
/// When confinement is required and this machine cannot provide it, the answer
/// is a refusal. Starting an unconfined process instead would be the one
/// outcome nobody could detect.
pub fn required_for(
    caller: &crate::authz::Principal,
    workspace: &crate::config::WorkspaceEntry,
) -> Result<Option<Policy>, String> {
    if caller.allows(crate::authz::Capability::PtyUnconfined) {
        return Ok(None);
    }
    let report = report();
    if !report.enforced {
        return Err(format!(
            "this has to run confined to the workspace and this machine cannot do that: {}. \
             A device holding pty:unconfined may still run it.",
            report.detail
        ));
    }
    let mut roots: Vec<PathBuf> = workspace
        .folders
        .iter()
        .map(|folder| folder.root.clone())
        .collect();
    if roots.is_empty() {
        roots.push(workspace.root.clone());
    }
    Ok(Some(Policy::for_workspace(&roots)))
}

/// How a policy is described to the caller that caused it.
pub fn describe(policy: Option<&Policy>) -> Option<genehub_proto::Confinement> {
    policy.map(|policy| genehub_proto::Confinement {
        backend: report().backend,
        roots: policy
            .roots
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    })
}

/// What this machine can enforce, asked once and answered the same way every
/// time so that two callers never get two different stories.
pub fn report() -> IsolationInfo {
    static REPORT: std::sync::OnceLock<IsolationInfo> = std::sync::OnceLock::new();
    REPORT.get_or_init(probe).clone()
}

#[cfg(not(target_family = "wasm"))]
fn probe() -> IsolationInfo {
    genet_native::confine::report()
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
        // Two callers deciding whether to run something they do not trust must
        // not be able to get two different answers.
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
