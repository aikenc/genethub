//! Operating-system access this machine's daemon needs: executing GeneHub's own
//! programs, reading and writing the user's disk, and talking to the network.
//!
//! The daemon cannot grant itself any of these; it can only say which are
//! missing, which ones it can repair on its own, and which need a person at the
//! machine. These types are that answer, and they are the same on macOS,
//! Windows and WSL so one settings page and one CLI serve all three.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AccessState {
    /// The operating system lets the daemon do this today.
    Granted,
    /// Tried and refused, or known to be missing.
    Denied,
    /// The system offers no silent way to ask. The first real use (or an
    /// explicit request) shows the system dialog.
    NotDetermined,
    /// The check could not run; nothing is claimed either way.
    Unknown,
    /// It was granted to a program identity that has since changed.
    NeedsRecheck,
    /// Does not exist on this platform.
    NotApplicable,
}

/// What pressing "request" does for an item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AccessAction {
    /// The daemon repairs it itself, no dialog.
    Fix,
    /// Triggers the system's own dialog; someone must be at the machine.
    Prompt,
    /// Opens the system's settings page; the person flips the switch there.
    Settings,
    /// Needs an administrator; the exact command is shown instead.
    Command,
    /// Nothing to do (already fine, or not applicable).
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AccessItem {
    /// Stable identifier, e.g. `mac.full-disk-access`.
    pub id: String,
    /// `identity` | `disk` | `network` | `desktop`.
    pub group: String,
    pub label: String,
    /// What stops working without it, in the user's words.
    pub purpose: String,
    pub state: AccessState,
    /// Why the state is what it is; shown under the label.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
    /// The programs the system attributes this permission to.
    pub holders: Vec<String>,
    pub action: AccessAction,
    /// Part of the one-click default set.
    pub recommended: bool,
    /// A command for an administrator, when `action` is `command`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AccessReport {
    /// `macos` | `windows` | `wsl` | `linux`.
    pub platform: String,
    /// The graphical session is locked or absent, so no dialog can be answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub locked: Option<bool>,
    pub items: Vec<AccessItem>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AccessOutcomeKind {
    /// Now granted (checked again after acting).
    Done,
    /// Asked, and a person at the machine has to finish it.
    NeedsUser,
    /// The person or system refused.
    Denied,
    /// Not attempted: nothing to do, not applicable, or the session is locked.
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AccessOutcome {
    pub id: String,
    pub kind: AccessOutcomeKind,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AccessSetupResult {
    pub outcomes: Vec<AccessOutcome>,
    /// The state after acting, so a caller never reports "asked" as "granted".
    pub report: AccessReport,
}
