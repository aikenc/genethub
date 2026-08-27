//! Domain objects shared by requests, responses and the frontend's caches.

use crate::timeline::TimelineItem;
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

/// An Agent-owned runtime dimension beyond model, mode and thinking depth.
///
/// Values are opaque ids returned by the Agent. Clients render and round-trip
/// them; they never synthesize ids from labels or from another axis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RuntimeAxisInfo {
    pub id: String,
    pub label: String,
    #[ts(optional)]
    pub description: Option<String>,
    pub values: Vec<RuntimeAxisValue>,
    #[ts(optional)]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RuntimeAxisValue {
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
    /// Additional Agent-declared runtime dimensions such as Fast. Absent for
    /// older Agents and clients; model ids remain opaque regardless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_axes: Option<Vec<RuntimeAxisInfo>>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceFolderInfo {
    /// Explorer label from `.code-workspace#folders[].name`, or the directory name.
    pub name: String,
    /// Absolute path on the owning device. It never leaves the E2EE application channel.
    pub root: String,
    /// Stable device-local locator for this physical root. Display names and
    /// project membership never participate in resource identity.
    pub root_handle: String,
}

/// Product meaning of a registered workspace.
///
/// `PipeSpace` is discovered from the existing PipeBuilder source shape during
/// migration/open. `AgentSpace` is never inferred: only a project manager may
/// explicitly promote a verified Space source to that kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum WorkspaceKind {
    #[default]
    Folder,
    PipeSpace,
    AgentSpace,
}

/// End-user affordances computed by the daemon for one workspace.
///
/// These fields make the UI honest, but they are not the security boundary;
/// the daemon applies the same policy to every mutation request.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceCapabilities {
    pub create_session: bool,
    pub rename: bool,
    pub remove: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    /// Optional on the TypeScript surface so an older daemon remains readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<WorkspaceKind>,
    /// Server-derived end-user affordances. Authorization is still enforced by
    /// the daemon when a request arrives.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capabilities: Option<WorkspaceCapabilities>,
    /// The first folder and Agent working directory.
    pub root: String,
    pub is_git_repo: bool,
    pub folders: Vec<WorkspaceFolderInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_file: Option<String>,
}

/// How a child session obtained the context that precedes its first new turn.
///
/// Native checkpoints preserve the Agent's own thread. Reconstructed context
/// is deliberately named differently: it is a bounded, provider-agnostic view
/// of GeneHub's visible history, not a claim that hidden Agent state moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ForkMethod {
    NativeCheckpoint,
    ReconstructedContext,
}

/// What a bounded reconstructed fork carried into its target Agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ForkContextStats {
    pub source_item_count: u32,
    pub included_item_count: u32,
    pub omitted_item_count: u32,
    #[ts(type = "number")]
    pub estimated_tokens: u64,
    #[ts(type = "number")]
    pub token_budget: u64,
    pub digest: String,
}

/// Durable ancestry for a forked conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionLineage {
    pub source_session_id: String,
    pub source_turn_id: String,
    pub source_agent_id: String,
    pub method: ForkMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub context: Option<ForkContextStats>,
}

/// The explicit destination chosen in the Fork UI.
///
/// Omitting this object on the RPC keeps the native Fork semantics of the
/// source machine, workspace and Agent. A client sends it when the user
/// explicitly switches any destination dimension, which is the opt-in boundary
/// for reconstructed context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ForkTarget {
    pub agent_id: String,
    /// Required destination workspace for a directed fork. Older clients omit
    /// it and keep the source workspace on the current machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub effort_id: Option<String>,
}

/// Portable, untrusted material exported by the source daemon for a fork on a
/// different machine. The destination daemon applies its own Agent catalog,
/// context budget and workspace validation; clients cannot supply a seed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ForkTransfer {
    pub source_session_id: String,
    pub source_turn_id: String,
    pub source_agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_round_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    pub items: Vec<TimelineItem>,
    pub coverage: HistoryCoverage,
}

/// Whether an imported conversation can keep talking through its original
/// Agent thread, or is a durable GeneHub transcript only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ImportContinuation {
    Native,
    ReadOnly,
}

/// One lightweight external conversation returned by the discovery pass.
///
/// `candidate_id` is an expiring daemon-owned token. Provider handles, source
/// paths and storage details never cross the RPC boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionImportCandidate {
    pub candidate_id: String,
    pub agent_id: String,
    pub title: String,
    pub preview: String,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
    pub continuation: ImportContinuation,
}

/// Discovery is isolated by Agent: one unavailable or incompatible CLI does
/// not hide importable conversations reported by the others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionImportSource {
    pub agent_id: String,
    pub label: String,
    pub supported: bool,
    pub candidates: Vec<SessionImportCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// Result of the lightweight discovery pass. Selecting one candidate performs
/// the separate full-history import, so opening this dialog stays bounded even
/// when an Agent owns years of sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionImportListing {
    pub sources: Vec<SessionImportSource>,
    #[ts(type = "number")]
    pub expires_at_ms: i64,
    pub filtered_duplicates: u32,
}

/// Durable, public import origin. The provider-specific source key remains in
/// daemon metadata and is used only for duplicate detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionImportOrigin {
    pub agent_id: String,
    pub continuation: ImportContinuation,
    #[serde(default)]
    pub warnings: Vec<String>,
    /// What GeneHub retained from the provider transcript and whether omitted
    /// history can be recovered. Older imports have no structured answer and
    /// keep this absent rather than pretending their warning prose was parsed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub coverage: Option<HistoryCoverage>,
}

/// Whether text outside the retained GeneHub window can be read again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum RetrievalCapability {
    /// The referenced history is stored in GeneHub and available through the
    /// bounded session/round/trunk/blob query surface.
    Genehub,
    /// The daemon has a durable provider handle that can page the source.
    External,
    /// The provider can resume its own thread, but GeneHub cannot read the
    /// omitted portion for another Agent.
    NativeOnly,
    /// The omitted portion is not currently recoverable.
    Unavailable,
}

/// Honest coverage for a full, clipped or imported history view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct HistoryCoverage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub source_item_count: Option<u64>,
    #[ts(type = "number")]
    pub retained_item_count: u64,
    #[ts(type = "number")]
    pub omitted_item_count: u64,
    pub retrieval: RetrievalCapability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// Stable identity and waterline shared by every read-only session page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionReadSource {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub through_round_id: Option<String>,
    pub digest: String,
    pub untrusted: bool,
}

/// A small structural entry point. It deliberately contains no free-form
/// transcript text; callers choose a bounded narrative page explicitly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionInspection {
    pub summary: SessionSummary,
    pub source: SessionReadSource,
    #[ts(type = "number")]
    pub narrative_item_count: u64,
    #[ts(type = "number")]
    pub round_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_round_id: Option<String>,
    pub coverage: HistoryCoverage,
    pub layers: Vec<String>,
}

/// A recent-first page of narrative items, returned in chronological order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionNarrativePage {
    pub source: SessionReadSource,
    pub items: Vec<crate::timeline::TimelineItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

/// A recent-first page of round summaries, returned in chronological order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionRoundPage {
    pub source: SessionReadSource,
    pub rounds: Vec<RoundSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

/// A durable address carried by compacted context instead of copied detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSourceRef {
    pub id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub round_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub digest: Option<String>,
}

/// Deterministic, model-free context projection used directly by Agents and
/// as the fallback for reconstructed forks and built-in compaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionContext {
    pub source: SessionReadSource,
    pub coverage: HistoryCoverage,
    pub text: String,
    pub references: Vec<SessionSourceRef>,
    pub retrieval_commands: Vec<String>,
    #[ts(type = "number")]
    pub estimated_tokens: u64,
    #[ts(type = "number")]
    pub token_budget: u64,
    pub digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub agent_id: String,
    /// Optional on the TypeScript surface so an older daemon remains readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<SessionKind>,
    /// Present only for a PM-controlled WorkAgent session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub work: Option<WorkSessionInfo>,
    /// Server-derived end-user affordances. The daemon independently enforces
    /// them, including for callers that never render a UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub capabilities: Option<SessionCapabilities>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub runtime_values: Option<std::collections::BTreeMap<String, String>>,
    #[ts(type = "number")]
    pub created_at_ms: i64,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
    pub archived: bool,
    /// Set when this session cannot be opened here. It is still listed: the
    /// conversation is in the user's own project folder, and an unexplained
    /// absence is worse than a row that says why it is out of reach.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsupported: Option<UnsupportedFormat>,
    /// Present only for a fork. Ordinary and imported sessions can add their
    /// own origin variants later without overloading the Agent binding.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lineage: Option<SessionLineage>,
    /// Present only for a conversation imported from an Agent's native store.
    #[ts(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported: Option<SessionImportOrigin>,
}

/// Product role of a durable conversation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum SessionKind {
    #[default]
    Normal,
    Pm,
    Work,
}

/// Durable controller relationship for a WorkAgent execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkSessionInfo {
    pub work_package_id: String,
    pub controller_session_id: String,
}

/// End-user affordances computed from the durable session kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SessionCapabilities {
    pub send: bool,
    pub respond_permission: bool,
    pub interrupt: bool,
    pub close: bool,
    pub archive: bool,
    pub rename: bool,
    pub delete: bool,
    pub set_model: bool,
    pub set_mode: bool,
    pub set_effort: bool,
    pub set_runtime_axis: bool,
    pub upload_artifact: bool,
    pub manage_processes: bool,
    pub fork: bool,
}

/// A session written by a newer build than this one.
///
/// Both numbers travel so a client can tell the user which side is behind
/// without knowing anything about storage layouts itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct UnsupportedFormat {
    pub written: u32,
    pub supported: u32,
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
    /// One entry per user request. `items` carries only the session narrative;
    /// tool calls and reasoning are addressed through the round layer instead
    /// of being replayed wholesale (`docs/session-storage.md`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rounds: Option<Vec<RoundSummary>>,
    /// The last round's recent trunk index and last trunk details, prefetched
    /// in the same response for the unread/mobile-first-screen path.
    // Boxed, which the wire never sees: most snapshots carry no expanded round,
    // and inline it would make every reply — and so every frame on the uplink —
    // pay for the widest one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "RoundLayer")]
    pub expanded_round: Option<Box<RoundLayer>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum RoundLayerOutcome {
    Completed,
    Failed,
    Canceled,
    Superseded,
    Running,
}

/// Compact session-layer description of one user request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundSummary {
    pub round_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub user_item_id: Option<String>,
    #[ts(type = "number")]
    pub started_at_ms: i64,
    #[ts(type = "number")]
    pub ended_at_ms: i64,
    pub outcome: RoundLayerOutcome,
    pub trunk_count: u32,
}

/// A semantic group inside a trunk: one monologue and the work following it,
/// bounded to sixteen blobs even when an agent never narrates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundBatchSummary {
    pub index: u32,
    pub first_item_id: String,
    pub blob_count: u32,
    pub text: String,
}

/// A visible, bounded section of a round. Trunks are carried by the round
/// protocol layer; they are not a fourth storage/addressing layer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundTrunkSummary {
    pub index: u32,
    pub first_item_id: String,
    #[serde(alias = "itemCount")]
    pub blob_count: u32,
    #[serde(alias = "overview")]
    pub title: String,
    #[serde(default)]
    pub batches: Vec<RoundBatchSummary>,
}

/// A complete address for one stored blob: what it is, and where it sits.
///
/// The locator travels with the reference on purpose (`docs/session-storage.md`
/// §3.3). A content id alone only narrows the search to one bucket file, which
/// is what made the old reader scan and deserialize a whole bucket per read;
/// carrying the byte range instead makes the row that holds the reference its
/// own index, so no separate blob index has to be built, loaded or kept honest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct BlobRef {
    /// First 24 hex characters of the payload's SHA-256. 96 bits: collision
    /// odds stay negligible at any session size, and every trunk row carries
    /// one, so the 40 characters saved are not decorative.
    pub id: String,
    #[ts(type = "number")]
    pub bytes: u64,
    /// `<bucket>:<offset>:<length>`. Opaque to clients — they hand it back
    /// unchanged and the daemon resolves it against this session's own blob
    /// files, verifying the id it finds there before answering.
    pub at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum BlobKind {
    Reasoning,
    ToolCall,
}

/// One compact row in a batch. Full source content is fetched by `blob.get`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct BlobOverview {
    pub item_id: String,
    pub kind: BlobKind,
    pub overview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob: Option<BlobRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundBatch {
    pub summary: RoundBatchSummary,
    /// Full process narration for this batch. It belongs to the expanded trunk,
    /// not to the session narrative. A compact prefix remains in `summary.text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub monologue: Option<String>,
    pub blobs: Vec<BlobOverview>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundTrunk {
    pub summary: RoundTrunkSummary,
    pub batches: Vec<RoundBatch>,
}

/// A page of visible trunks in one round. `nextCursor` asks for the preceding
/// page; cursors are opaque to clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RoundLayer {
    pub round: RoundSummary,
    pub trunks: Vec<RoundTrunkSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub expanded_trunk: Option<RoundTrunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct BlobPayload {
    pub id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct FileNode {
    pub name: String,
    /// Workspace-relative, always forward-slashed so clients need no per-OS logic.
    pub path: String,
    pub is_dir: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub size: Option<u64>,
    /// Absent means "not expanded yet" rather than "empty".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub children: Option<Vec<FileNode>>,
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
    pub web_protocol: u32,
    pub machine_id: String,
    /// Short human-comparable form of the daemon key, for out-of-band checking.
    pub fingerprint: String,
    pub transport: TransportKind,
    pub machine_name: String,
    /// Advertised inside the encrypted data plane. The viewer's local RTC
    /// preference still decides whether negotiation is attempted.
    pub rtc_supported: bool,
    /// Additive product capabilities. Older daemons omit this field; clients
    /// must treat that exactly like an empty list rather than guessing support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub features: Option<Vec<String>>,
    /// What this machine can actually enforce on a process it starts on a
    /// caller's behalf. Absent from older daemons, which is why it is optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub isolation: Option<IsolationInfo>,
}

/// The operating system confinement this machine can put a spawned process in.
///
/// Reported rather than promised. A caller decides whether to run something it
/// does not fully trust by reading this, so it has to describe what is actually
/// in force on this kernel right now — not what the build supports and not what
/// a configuration file asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct IsolationInfo {
    pub backend: IsolationBackend,
    /// Whether a confined process would really be confined. False means every
    /// request that needs confinement is refused, never quietly downgraded.
    pub enforced: bool,
    /// Why, in a sentence a person can act on. Present whether or not it worked,
    /// because "landlock, abi 4" is as worth saying as "kernel 5.4 has none".
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum IsolationBackend {
    Landlock,
    /// Unprivileged user and mount namespaces: a filesystem view built to hold
    /// only what the caller is allowed to see. Older than Landlock by a
    /// decade, and the only thing available on a kernel that predates it.
    Namespaces,
    Seatbelt,
    AppContainer,
    None,
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
    /// Qwen3 speech is independent of LLM providers. GeneHub exposes prompt,
    /// N-best and correction contracts while the model runtime stays local.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub speech: Option<crate::speech::SpeechSettings>,
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

/// A bounded support record that is safe to attach to explicit user feedback.
///
/// Every string in this shape comes from a daemon-owned allowlist. User input,
/// local paths, URLs, identifiers, prompts, terminal output and Agent output do
/// not have a field in the schema.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SupportDiagnostics {
    pub version: u32,
    pub captured_at: String,
    pub daemon_version: String,
    pub os: String,
    pub arch: String,
    #[ts(type = "number")]
    pub uptime_seconds: u64,
    pub hub_state: String,
    pub remote_state: String,
    pub events: Vec<SupportDiagnosticEvent>,
    #[ts(type = "number")]
    pub dropped_events: u64,
}

/// One daemon-owned diagnostic fact. Values are intentionally categorical.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SupportDiagnosticEvent {
    pub at: String,
    pub component: String,
    pub operation: String,
    pub outcome: String,
    #[ts(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// Consecutive identical events are coalesced so a reconnect loop cannot
    /// evict every earlier clue from the bounded record.
    pub count: u32,
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
    /// No Hub. Everything still works on this machine over loopback.
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
    /// Stable daemon-owned handle used by Preview locators across clients.
    pub device_handle: String,
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
    /// Opaque name Relay carries to the target daemon in OPEN.
    pub channel_capability: String,
    /// Per-connection E2E secret. Never placed in a URL or Relay API.
    pub channel_secret: String,
    /// One-shot outer Fabric route. It contains no workspace/path/business data.
    pub fabric_route_ticket: String,
    pub fabric_route_expires_at: String,
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
    /// What this device may ask for. Absent from machines that predate grants,
    /// where every authorized device could do everything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub grants: Option<Vec<String>>,
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
    /// a relay first for that reason; privileged LAN transport is deliberately
    /// unsupported.
    #[ts(optional)]
    pub rendezvous_url: Option<String>,
    pub expires_at: String,
    /// What redeeming this invitation will be worth. Shown before anyone
    /// accepts it, because a grant nobody was told about is not a choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub grants: Option<Vec<String>>,
}

/// How much of a machine an invitation is worth.
///
/// Its own type rather than a bare list of strings so that the request carrying
/// it can grow other limits — an expiry, a workspace — without changing shape
/// again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InviteScope {
    pub grants: Vec<String>,
}

/// What a client keeps after redeeming an invite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DeviceCredential {
    pub device_id: String,
    /// Stable machine identity. Device ids name one browser authorization and
    /// must never be reused as a routing target.
    pub machine_id: String,
    /// Shared with this machine only. Never sent again after this reply: later
    /// connections prove knowledge of it instead (`security-model.md` §4.2).
    pub secret: String,
    pub machine_name: String,
    pub fingerprint: String,
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

/// Proof of the PSK carried in the fragment half of a pairing link.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct InviteAuth {
    pub invite_id: String,
    pub nonce: String,
    pub proof: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapsed_file_tree_fields_are_absent_instead_of_null() {
        let node = FileNode {
            name: "docs".into(),
            path: "docs".into(),
            is_dir: true,
            size: None,
            children: None,
        };
        let wire = serde_json::to_value(node).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "name": "docs",
                "path": "docs",
                "isDir": true,
            })
        );
    }
}
