//! Context owned by the Agent that launched a daemon, never by the daemon.
//!
//! Keep the native CLI's spawn boundary and the Host's daemon entry aligned.
//! Agent-specific launching variables are additionally cleared by the Host.

pub const SESSION_SCOPED: &[&str] = &[
    "GENEHUB_SESSION_ID",
    "GENEHUB_CONTROLLER_TOKEN",
    "GENEHUB_EVIDENCE_SCOPE",
    "GENEHUB_SKILLS_DIR",
    "GENET_WORKSPACE_ROOT",
    "GENEHUB_AGENT_PID",
    "GENEHUB_HOST_PID",
    "GENEHUB_ALLOW_FOREGROUND_IN_SESSION",
];

/// An accidental foreground launch would remain owned by this Agent's tool.
pub fn in_agent_session() -> bool {
    [
        "GENEHUB_SESSION_ID",
        "GENEHUB_CONTROLLER_TOKEN",
        "GENEHUB_AGENT_PID",
        "GENEHUB_HOST_PID",
    ]
    .iter()
    .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}
