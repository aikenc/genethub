//! Domain objects shared by requests, responses and the frontend's caches.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What an agent can do, declared up front.
///
/// The frontend renders controls from this rather than probing with calls that
/// might fail: a user should never be offered a model picker by an agent that
/// cannot switch models (`architecture.md` §3.2).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Capabilities {
    pub interrupt: bool,
    pub set_model: bool,
    /// How hard the model should think. A separate switch from `set_model`
    /// because it is a separate axis: the same model runs at any of its levels,
    /// and which levels exist is the model's own business (`ModelInfo::efforts`).
    #[serde(default)]
    pub set_effort: bool,
    pub set_mode: bool,
    pub permissions: bool,
    /// The agent can rehydrate a past session itself. When false the daemon
    /// falls back to read-only replay from its own log.
    pub resume: bool,
    /// The Agent can create a genuinely independent context through a
    /// completed turn. False means the UI keeps the action visible but honest.
    #[serde(default)]
    pub fork: bool,
    pub attachments: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    #[ts(optional)]
    #[ts(type = "number")]
    pub context_window: Option<u64>,
    pub reasoning: bool,
    /// The thinking levels this model accepts, in the order it named them —
    /// weakest first, because that is how a slider reads. Empty means this model
    /// has no such dial, and the control belongs nowhere near it.
    #[serde(default)]
    pub efforts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ModeInfo {
    pub id: String,
    pub label: String,
    #[ts(optional)]
    pub description: Option<String>,
}

/// A slash command the agent understands.
///
/// Nothing about running one is special: it is sent as ordinary prompt text, and
/// the agent recognises its own commands. What the agent alone can supply is the
/// *list* — which for a Claude Code install is dozens of commands and skills that
/// are otherwise undiscoverable outside its own terminal UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct CommandInfo {
    /// Without the leading slash.
    pub name: String,
    #[ts(optional)]
    pub description: Option<String>,
    /// What to type after the name, when it takes an argument — the agent's own
    /// wording, e.g. `[low|medium|high]`.
    #[ts(optional)]
    pub argument_hint: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Catalog {
    pub models: Vec<ModelInfo>,
    pub modes: Vec<ModeInfo>,
    #[serde(default)]
    pub commands: Vec<CommandInfo>,
    #[ts(optional)]
    pub default_model: Option<String>,
    #[ts(optional)]
    pub default_mode: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ProbeState {
    /// Installed and it answered a handshake.
    Ready,
    /// Binary is missing. Not an error: we simply do not offer it.
    NotInstalled,
    /// Present but unusable, e.g. not logged in or a version we cannot speak to.
    #[serde(rename_all = "camelCase")]
    Unavailable { reason: String },
}

/// Whether the agent has usable credentials, as far as a non-interactive check
/// can tell.
///
/// `Unknown` is a first-class answer, not a failure: several CLIs publish no
/// status command, and claiming either way would put a made-up badge on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AuthState {
    Authenticated,
    Unauthenticated,
    Unknown,
    /// Credentials are not the CLI's own concern — the built-in agent uses the
    /// daemon's provider keys, so there is nothing to ask it.
    NotApplicable,
}

/// The operating system of the machine an agent (and its daemon) runs on.
///
/// Sent with every agent so a browser on any device can pick the install
/// command that can actually run there — the terminal the wizard pastes into
/// lives on that machine, not on the device showing the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "index.ts")]
pub enum GuidePlatform {
    Macos,
    Linux,
    Windows,
}

/// One way to install an agent, in the words of its own documentation.
///
/// `command` is pasted into the workbench's embedded terminal and left for the
/// user to run — the wizard never executes it by itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InstallMethod {
    /// `官方安装脚本`, `npm`, `Homebrew` — the name its own docs give it.
    pub label: String,
    pub platforms: Vec<GuidePlatform>,
    pub command: String,
}

/// The agent's official sign-in flow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct LoginGuide {
    /// What starts it, pasted into the embedded terminal (never auto-run).
    pub command: String,
    /// True when the flow continues in the browser, so the wizard can say so
    /// before the window appears.
    pub opens_browser: bool,
    /// What to expect, in one sentence.
    pub hint: String,
}

/// How an API key (or compatible endpoint) reaches this agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ApiKeyKind {
    /// The built-in agent: the key is stored by the daemon itself through
    /// `settings.setProvider`, write-only, exactly as on the settings page.
    BuiltinProvider,
    /// The CLI's own command takes the key (e.g. `codex login --with-api-key`).
    /// The user pastes the key into the terminal itself; it never passes
    /// through GeneHub.
    TerminalCommand,
    /// The CLI reads environment variables. The wizard can paste the lines,
    /// but they only reach the daemon's children after a restart — this is the
    /// last resort, not the recommended path.
    Environment,
}

/// One environment variable a CLI reads, and what it is for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct EnvVarGuide {
    pub name: String,
    pub purpose: String,
}

/// The API-key path for an agent that has one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ApiKeyGuide {
    pub kind: ApiKeyKind,
    /// For `TerminalCommand`: the command to paste. The key itself is typed by
    /// the user into the terminal, not into any GeneHub field.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub command: Option<String>,
    /// For `Environment`: the variables involved.
    #[serde(default)]
    pub env_vars: Vec<EnvVarGuide>,
    /// Where a key is issued, opened in the browser.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_url: Option<String>,
    pub hint: String,
}

/// Everything the setup wizard knows about an agent.
///
/// Declared by the adapter (boundary B1: only the adapter may know its agent),
/// rendered generically by the client. A section that is absent is a section
/// the wizard does not show; an agent with an empty profile gets the honest
/// fallback — a link to its own documentation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AgentSetup {
    /// Ways to install it. Empty for the built-in agent, which ships installed.
    #[serde(default)]
    pub install: Vec<InstallMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub login: Option<LoginGuide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub api_key: Option<ApiKeyGuide>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub docs_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub probe: ProbeState,
    pub capabilities: Capabilities,
    pub catalog: Catalog,
    /// True for the agent shipped in the installer, which is preselected on
    /// first run so a new user can run something immediately.
    pub builtin: bool,
    /// The machine this agent runs on — which is also where the embedded
    /// terminal executes, so it decides which install command applies.
    pub platform: GuidePlatform,
    /// The installed version as the CLI itself reports it, when it will say.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    pub auth: AuthState,
    pub setup: AgentSetup,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub root: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    /// Absent until the session has been named — by the user, or by the daemon
    /// from the first thing they said. Clients supply their own placeholder;
    /// the daemon has no business picking a word in the user's language.
    #[ts(optional)]
    pub title: Option<String>,
    pub status: crate::event::SessionStatus,
    #[ts(optional)]
    pub model_id: Option<String>,
    #[ts(optional)]
    pub mode_id: Option<String>,
    #[ts(optional)]
    #[serde(default)]
    pub effort_id: Option<String>,
    #[ts(type = "number")]
    pub created_at_ms: i64,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
    pub archived: bool,
}

/// Everything a client needs to render a session from scratch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSnapshot {
    pub summary: SessionSummary,
    pub items: Vec<crate::timeline::TimelineItem>,
    /// Sequence number this snapshot is current as of. Events with a lower or
    /// equal seq have already been folded in.
    #[ts(type = "number")]
    pub seq: u64,
    pub pending_permissions: Vec<crate::event::PermissionRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct FileNode {
    pub name: String,
    /// Workspace-relative, always forward-slashed so clients need no per-OS logic.
    pub path: String,
    pub is_dir: bool,
    #[ts(optional)]
    #[ts(type = "number")]
    pub size: Option<u64>,
    /// Absent means "not expanded yet" rather than "empty".
    #[ts(optional)]
    pub children: Option<Vec<FileNode>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
    /// False when the file looked binary; `content` is then a placeholder.
    pub is_text: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum GitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct GitChange {
    pub path: String,
    pub kind: GitChangeKind,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct GitStatus {
    #[ts(optional)]
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
    pub clean: bool,
}

/// How this client reached the daemon. Surfaced so the UI can show the user
/// which of the three paths in `architecture.md` §1 is in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TransportKind {
    Loopback,
    Lan,
    Forwarded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HelloResult {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub machine_id: String,
    /// Short human-comparable form of the daemon key, for out-of-band checking.
    pub fingerprint: String,
    pub transport: TransportKind,
    pub machine_name: String,
    /// The machine's half of the mutual proof, present when the client
    /// authenticated with a device credential. A client that asked for one and
    /// did not get it is talking to something that is not its machine.
    #[ts(optional)]
    pub proof: Option<String>,
}

/// Whether a newer build has been published, and where a person gets it.
///
/// Asked for, never volunteered. A machine that promises to keep to itself has no
/// business making an outbound call nobody requested, and the answer is only
/// wanted at the moment someone wonders — which is why this is a menu item and a
/// button rather than a heartbeat.
///
/// Nothing here *installs* anything either. The machine can fetch the installer
/// once asked (`UpdateDownload`), but running it — which stops the daemon and
/// whatever an agent was mid-turn — stays a click the user makes, not a timer we
/// fire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct UpdateStatus {
    /// What this machine is running.
    pub current: String,
    /// The newest published version, when the check got an answer at all.
    ///
    /// Left out of the wire rather than sent as null, here and below, so that the
    /// generated `latest?: string` describes what actually arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest: Option<String>,
    /// True only when `latest` is genuinely later. A build from source can be
    /// ahead of the newest release, and telling that person to upgrade would be
    /// telling them to go backwards.
    pub newer: bool,
    /// The release page: notes and checksums. Optional next to `download_url`,
    /// because some people want to read before they fetch.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    /// The installer for *this* machine, when the manifest named one.
    ///
    /// Separate from `url` on purpose: the page is for a person, the file is for
    /// a download button that must not open a browser just to fetch a binary.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub download_url: Option<String>,
    /// Why there is no answer, in the words of whatever failed. The one outcome
    /// worth refusing to render is a check that quietly says "up to date" after
    /// reaching nothing at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub problem: Option<String>,
}

/// How far the machine has got fetching the installer it was asked to fetch.
///
/// A state rather than a reply to one call, because a download outlives the
/// click that started it: the window can be closed, the workbench reloaded, a
/// second client opened on a phone, and all of them have to see the same thing.
/// The machine is the one place that knows, so it is the one place that says.
///
/// Fetching is separate from installing on purpose. What ends this is a file on
/// disk and a sentence on screen; the installer stops the daemon and every agent
/// mid-turn, so when to pay that is the user's call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum UpdateDownload {
    /// Nobody has asked for anything, or the last answer was dismissed.
    Idle,
    #[serde(rename_all = "camelCase")]
    Fetching {
        version: String,
        /// Bytes on disk so far. A number on the wire, so declared as one here:
        /// the generated `bigint` would describe a value `JSON.parse` never
        /// produces.
        #[ts(type = "number")]
        received: u64,
        /// What the release host said the whole file weighs, when it said. A
        /// server that sends no length is unusual but allowed, and a progress
        /// bar that invents a total is worse than a byte count that does not.
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        total: Option<u64>,
    },
    /// The installer is on this machine's disk and nothing has been run.
    #[serde(rename_all = "camelCase")]
    Ready {
        version: String,
        /// Where it landed. Only a shell running on this machine can do
        /// anything with it; a browser on a phone shows the sentence and no
        /// button.
        path: String,
    },
    #[serde(rename_all = "camelCase")]
    Failed { version: String, message: String },
}

/// The machine-level settings a client may see and change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Settings {
    pub providers: Vec<ProviderInfo>,
    /// Whether the daemon accepts connections from the local network.
    pub lan_enabled: bool,
}

/// A provider's configuration, minus the secret.
///
/// `hasApiKey` rather than the key itself: the UI only needs to know whether
/// to show "configured" or an empty field, and sending the value back would
/// put it in every client's memory for no gain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ProviderInfo {
    pub id: String,
    pub has_api_key: bool,
    /// The address in use, whether the user typed it or we ship it. Filled in
    /// even when they typed nothing, so the page shows where their key is going.
    #[ts(optional)]
    pub base_url: Option<String>,
    pub label: String,
    /// `openai` | `anthropic`.
    pub dialect: String,
    /// True for a provider the user added, which is also the only kind that can
    /// be removed again.
    pub custom: bool,
    /// The models this key can use, as the provider itself reported them — or
    /// the list the user wrote by hand.
    pub models: Vec<String>,
    /// Why `models` is empty, in the provider's own words. The alternative is a
    /// picker that is empty for no stated reason, which sends people to the
    /// wrong place: a rejected key looks exactly like a bug in the app.
    #[ts(optional)]
    pub problem: Option<String>,
}

/// The end of one log file, and where it came from.
///
/// The path is included even though the text makes it redundant on the machine
/// itself: on the desktop it is what someone attaches to a bug report or opens in
/// an editor, and knowing which file they are reading matters when there are
/// several.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct LogTail {
    pub name: String,
    pub path: String,
    pub text: String,
    /// Every log in the directory, newest first, with its size in bytes.
    pub files: Vec<LogEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct LogEntry {
    pub name: String,
    /// A number on the wire. Declared as one here too: the generated `bigint`
    /// would be a type that never matches what `JSON.parse` actually produces.
    #[ts(type = "number")]
    pub bytes: u64,
}

/// Where this machine stands with a Hub.
///
/// One shape covers every stage of pairing so the UI polls a single call and
/// renders from what it gets back, rather than tracking the flow itself and
/// getting out of step with the daemon after a restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum HubStatus {
    /// No Hub. Everything still works on this machine and over the LAN.
    Unpaired,
    /// A code is on screen, waiting for someone to approve it in a browser.
    #[serde(rename_all = "camelCase")]
    Pairing {
        hub_url: String,
        user_code: String,
        verification_uri: String,
        /// The same address with the code already filled in, for a QR code.
        verification_uri_complete: String,
        expires_at: String,
    },
    #[serde(rename_all = "camelCase")]
    Paired {
        hub_url: String,
        /// The Hub's id for this machine, which is what the owner sees listed.
        machine_id: String,
        /// True while the outbound connection to the Hub is up. False means
        /// remote access is down even though pairing is intact.
        online: bool,
    },
    /// Pairing was attempted and did not finish. Kept until the next attempt so
    /// the reason stays on screen instead of reverting to "unpaired".
    #[serde(rename_all = "camelCase")]
    Failed { hub_url: String, message: String },
}

/// The ways back into an identity that has no password.
///
/// A trial identity is reachable only through these, so whatever shows them
/// has one chance to do it: nothing on this machine keeps a copy, and the Hub
/// will not repeat itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HubClaim {
    /// One-time link, good for opening this identity in another browser.
    pub claim_url: String,
    /// Present only when the identity was just created. Left out of the wire
    /// rather than sent as null, so that the generated `recoveryKey?: string`
    /// describes what actually arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub recovery_key: Option<String>,
    pub expires_at: String,
}

/// Another machine belonging to whoever owns this one.
///
/// The Hub knows this list; nothing on this machine does. It is fetched
/// through the daemon rather than by the UI directly, and that is the whole
/// design: the client stays one program that talks to one daemon, and the
/// account remains something only the server side knows about.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HubMachine {
    /// The Hub's id, which is also what `HubStatus::Paired` reports for this
    /// machine — so a client can tell which entry is the one it is sitting on.
    pub id: String,
    pub name: String,
    pub online: bool,
    pub fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_seen_at: Option<String>,
}

/// A one-time way to reach one of those machines through the forwarding layer.
///
/// Spent by the connection that uses it, so a client that needs to reconnect
/// asks for another rather than replaying this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HubTicket {
    pub url: String,
    pub expires_at: String,
    /// The target machine's key fingerprint, learned from the Hub rather than
    /// from the connection — which is what makes comparing the two worth
    /// anything.
    pub fingerprint: String,
}

// ---------------------------------------------------------------------------
// Devices
//
// Who may reach this machine from outside is decided here and nowhere else.
// The list lives on the machine, the way `authorized_keys` does, so revoking
// takes effect the moment it is edited and does not depend on any server
// being reachable (`security-model.md` §4).

/// One entry in the machine's authorized-devices list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub paired_at: String,
    #[ts(optional)]
    pub last_seen_at: Option<String>,
    /// True while this device has a live connection to the machine.
    pub connected: bool,
}

/// A one-time chance to become an authorized device.
///
/// The code is not a credential: it buys exactly one exchange, and only within
/// its lifetime. What comes back from that exchange is the credential.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DeviceInvite {
    pub code: String,
    /// Where the client should meet this machine.
    ///
    /// Absent when remote access is off, and then there is nowhere to send
    /// anyone: this machine does not know its own address on the network, so an
    /// invite without this cannot be turned into a link. The workbench asks for
    /// a relay first for that reason. Pairing over a LAN alone would need the
    /// address to come from somewhere else, and nothing supplies it today.
    #[ts(optional)]
    pub rendezvous_url: Option<String>,
    pub expires_at: String,
}

/// What a client keeps after redeeming an invite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DeviceCredential {
    pub device_id: String,
    /// Shared with this machine only. Never sent again after this reply: later
    /// connections prove knowledge of it instead (`security-model.md` §4.2).
    pub secret: String,
    pub machine_name: String,
    pub fingerprint: String,
    /// The machine's half of the mutual proof, over the nonce the client sent.
    pub proof: String,
}

/// Whether this machine is reachable through a rendezvous relay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RemoteAccess {
    #[ts(optional)]
    pub relay_url: Option<String>,
    /// Where clients meet this machine. Unguessable, and derived from the
    /// machine identity so it survives restarts.
    #[ts(optional)]
    pub rendezvous_url: Option<String>,
    pub online: bool,
}

/// A client proving it is on the authorized list, without sending its secret.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DeviceAuth {
    pub device_id: String,
    /// Fresh per connection. A nonce is never accepted twice, so intercepting
    /// one proof buys nothing.
    pub nonce: String,
    pub proof: String,
}
