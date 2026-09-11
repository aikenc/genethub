//! Configuration and the on-disk layout.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

// The on-disk layout and its owner-only hardening live in the native front door:
// `genet daemon start|stop|status` creates and inspects the very same files this
// daemon writes, and two definitions of that layout would be two products
// sharing a name (`docs/cli-thin-forwarder.md` §6). What stays here is the
// `Config` that only the guest reads, plus these names, because layout and
// settings are answered together everywhere this crate asks.
pub use genet_frontdoor::paths::{home_dir, Paths};
#[cfg(windows)]
pub(crate) use genet_frontdoor::perms::windows_acl;
pub(crate) use genet_frontdoor::perms::{
    ensure_real_directory, reject_link_or_reparse, replace_private, restrict_dir_to_owner,
    sensitive_metadata,
};
pub use genet_frontdoor::perms::{open_append, restrict_to_owner};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// 0 asks the OS for a free port, which is the normal case: the chosen port
    /// is published through `endpoint.json` rather than being agreed in advance.
    pub port: u16,
    /// Off by default. Listening beyond loopback is a decision the user makes,
    /// not something that happens because they installed the app.
    pub lan_enabled: bool,
    pub agents: AgentsConfig,
    /// Qwen3-ASR input is independent of Agent/LLM providers. GeneHub stores
    /// only prompt and local correction preferences; model installation and
    /// runtime configuration belong to the community adapter.
    pub speech: SpeechConfig,
    /// Device-local, project-independent filesystem roots.
    ///
    /// Projects only reference these opaque handles. Keeping the mapping here
    /// makes one physical directory keep the same locator when it is opened as
    /// a folder or appears in any number of `.code-workspace` files.
    #[serde(default)]
    pub workspace_roots: Vec<WorkspaceRootEntry>,
    pub workspaces: Vec<WorkspaceEntry>,
    /// Identifies one lifetime of the local workspace catalogue.
    ///
    /// This is deliberately unrelated to the machine identity and to any Hub
    /// row id. If the local configuration is recreated, the new generation
    /// cannot be mistaken for a delayed snapshot from the old one.
    pub workspace_catalog_generation: String,
    /// Monotonically increases whenever the safe, path-free catalogue changes.
    /// The Hub uses it to reject a delayed snapshot after a newer one.
    pub workspace_catalog_revision: u64,
    /// How many events per session stay replayable after a disconnect.
    pub replay_window: usize,
    /// Where to look when someone asks whether there is a newer build.
    ///
    /// Empty turns the check off, which is the setting for a deployment that
    /// wants no outbound call at all — and the reason this is an address rather
    /// than a flag is that a self-hosted copy can point it at its own file
    /// instead of at somebody else's releases.
    pub update_manifest_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 0,
            lan_enabled: false,
            agents: AgentsConfig::default(),
            speech: SpeechConfig::default(),
            workspace_roots: Vec::new(),
            workspaces: Vec::new(),
            workspace_catalog_generation: String::new(),
            workspace_catalog_revision: 0,
            replay_window: 2048,
            update_manifest_url: crate::channel::DEFAULT_MANIFEST_URL.to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentsConfig {
    /// Credentials for the built-in agent's providers, keyed by provider id.
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
    /// Extra agents declared by the user. `extends` names a built-in adapter
    /// shape, so adding a new ACP-speaking CLI needs no code change.
    pub custom: std::collections::BTreeMap<String, CustomAgent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechConfig {
    /// A machine-level community adapter. GeneHub never invokes this through a
    /// shell and never stores it in project files.
    pub runtime: Option<SpeechRuntimeConfig>,
    /// Runs GeneHub's deterministic no-model protocol Stub instead of the
    /// registered community adapter. The registration is preserved so turning
    /// the Stub off returns to the real runtime without reinstalling it.
    pub stub_enabled: bool,
    pub context_enabled: bool,
    pub pinned_terms: Vec<String>,
    pub language_hints: Vec<String>,
    /// Deprecated machine-wide consent. Kept only so old config files can be
    /// read and rewritten without accidentally turning that consent into a
    /// project-wide wildcard.
    pub collect_corrections: bool,
    /// Explicit project-local correction consent, keyed by stable workspace id.
    pub correction_workspaces: Vec<String>,
}

impl Default for SpeechConfig {
    fn default() -> Self {
        Self {
            runtime: None,
            stub_enabled: false,
            context_enabled: true,
            pinned_terms: Vec::new(),
            language_hints: Vec::new(),
            collect_corrections: false,
            correction_workspaces: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRuntimeConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub api_key: Option<String>,
    /// Empty for a provider we ship an address for; see `crate::provider`.
    pub base_url: Option<String>,
    /// What to call it on screen. Only a provider the user added needs this.
    pub label: Option<String>,
    /// `openai` | `anthropic`. Which wire protocol the address speaks, which is
    /// not decided by whose name is on it: most services copy Chat Completions.
    pub dialect: Option<String>,
    /// Why this provider produced no models, in its own words.
    ///
    /// Never stored: it describes one attempt to reach a service, not a setting.
    #[serde(skip)]
    pub problem: Option<String>,
    /// Models the user listed by hand.
    ///
    /// For an endpoint that does not implement a list call — a local llama.cpp,
    /// a gateway that only proxies — this is the only way to have anything in
    /// the picker. Non-empty means we do not ask.
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgent {
    pub extends: String,
    pub command: Vec<String>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRootEntry {
    pub handle: String,
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderEntry {
    pub name: String,
    pub root: PathBuf,
    /// Stable device-local identity of `root`. It is independent of every
    /// project and display label that references the directory.
    #[serde(default)]
    pub root_handle: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    /// The first folder is deliberately duplicated here as a first-class fact:
    /// it remains the Agent/session/terminal/git working directory.
    pub root: PathBuf,
    /// Every filesystem root visible in Explorer and Asset Preview, in order.
    /// Empty only while loading a pre-multi-root config; startup migrates it.
    #[serde(default)]
    pub folders: Vec<WorkspaceFolderEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_file: Option<PathBuf>,
    /// Hidden from the active registry, but retained so reopening the same
    /// project restores its id and therefore its on-disk conversation history.
    #[serde(default)]
    pub removed: bool,
    /// A revisioned catalogue fact, sampled when the daemon starts or the
    /// workspace is first opened. Keeping it in config prevents a filesystem
    /// change from producing a different Hub snapshot at the same revision.
    #[serde(default)]
    pub is_git_repo: bool,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(raw) => {
                let mut value: serde_json::Value = serde_json::from_str(&raw)
                    .with_context(|| format!("parsing {}", path.display()))?;
                let remove_legacy_speech_provider = value
                    .get_mut("speech")
                    .and_then(serde_json::Value::as_object_mut)
                    .is_some_and(|speech| {
                        ["region", "dashscopeWorkspaceId", "apiKey"]
                            .iter()
                            .filter_map(|field| speech.remove(*field))
                            .count()
                            > 0
                    });
                if remove_legacy_speech_provider {
                    let rewritten = serde_json::to_string_pretty(&value)?;
                    save_private(path, rewritten.as_bytes()).with_context(|| {
                        format!(
                            "removing obsolete speech credentials from {}",
                            path.display()
                        )
                    })?;
                }
                let mut config: Self = serde_json::from_value(value)
                    .with_context(|| format!("parsing {}", path.display()))?;
                config.normalize_workspace_paths();
                Ok(config)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let body = serde_json::to_string_pretty(self)?;
        save_private(path, body.as_bytes())
    }

    /// Rewrites workspace roots from a Windows host's spelling into the
    /// component's preopen namespace. Configs written by a pre-component
    /// (native) daemon carry `F:\…` or the `\\?\` verbatim form, which no
    /// WASI call can resolve; a no-op everywhere else.
    fn normalize_workspace_paths(&mut self) {
        for mapping in &mut self.workspace_roots {
            mapping.root = crate::guest_paths::guest_path(&mapping.root);
        }
        for workspace in &mut self.workspaces {
            workspace.root = crate::guest_paths::guest_path(&workspace.root);
            for folder in &mut workspace.folders {
                folder.root = crate::guest_paths::guest_path(&folder.root);
            }
            if let Some(workspace_file) = &mut workspace.workspace_file {
                *workspace_file = crate::guest_paths::guest_path(workspace_file);
            }
        }
    }

    /// Returns the device-wide locator for one already-canonical directory,
    /// creating it in this pending configuration snapshot when first seen.
    pub(crate) fn ensure_workspace_root(&mut self, root: &Path) -> String {
        if let Some(mapping) = self
            .workspace_roots
            .iter()
            .find(|mapping| mapping.root == root)
        {
            return mapping.handle.clone();
        }
        let handle = new_workspace_root_handle(
            self.workspace_roots
                .iter()
                .map(|mapping| mapping.handle.as_str()),
        );
        self.workspace_roots.push(WorkspaceRootEntry {
            handle: handle.clone(),
            root: root.to_path_buf(),
        });
        handle
    }

    /// Rewrites the old one-root representation once, instead of carrying a
    /// permanent runtime fallback through every filesystem operation.
    pub fn migrate_workspace_folders(&mut self, path: &Path) -> Result<()> {
        let mut changed = false;
        for workspace in &mut self.workspaces {
            if workspace.folders.is_empty() {
                workspace.folders.push(WorkspaceFolderEntry {
                    name: workspace
                        .root
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                        .unwrap_or_else(|| workspace.name.clone()),
                    root: workspace.root.clone(),
                    root_handle: String::new(),
                });
                changed = true;
            }
            if workspace.folders.first().map(|folder| &folder.root) != Some(&workspace.root) {
                anyhow::bail!(
                    "workspace {} primary root does not match its first folder",
                    workspace.id
                );
            }
        }
        if changed {
            self.save(path)?;
        }
        Ok(())
    }

    /// Gives every concrete folder one durable, device-local locator.
    ///
    /// This is a one-time rewrite for configurations written before roots were
    /// first-class. Runtime resolution has no alias/path-name fallback after
    /// startup: every project folder must carry the canonical global handle.
    pub fn migrate_workspace_roots(&mut self, path: &Path) -> Result<()> {
        let mut changed = false;
        let mut handles = std::collections::HashMap::<String, PathBuf>::new();
        let mut roots = std::collections::HashMap::<PathBuf, String>::new();
        let mut normalized = Vec::with_capacity(self.workspace_roots.len());

        for mut mapping in std::mem::take(&mut self.workspace_roots) {
            if !valid_workspace_root_handle(&mapping.handle)
                || handles
                    .get(&mapping.handle)
                    .is_some_and(|root| root != &mapping.root)
            {
                mapping.handle = new_workspace_root_handle(handles.keys().map(String::as_str));
                changed = true;
            }
            if let Some(existing) = roots.get(&mapping.root) {
                if existing != &mapping.handle {
                    changed = true;
                }
                continue;
            }
            handles.insert(mapping.handle.clone(), mapping.root.clone());
            roots.insert(mapping.root.clone(), mapping.handle.clone());
            normalized.push(mapping);
        }
        self.workspace_roots = normalized;

        for workspace in &mut self.workspaces {
            for folder in &mut workspace.folders {
                let handle = match roots.get(&folder.root) {
                    Some(handle) => handle.clone(),
                    None => {
                        let handle = new_workspace_root_handle(handles.keys().map(String::as_str));
                        roots.insert(folder.root.clone(), handle.clone());
                        handles.insert(handle.clone(), folder.root.clone());
                        self.workspace_roots.push(WorkspaceRootEntry {
                            handle: handle.clone(),
                            root: folder.root.clone(),
                        });
                        changed = true;
                        handle
                    }
                };
                if folder.root_handle != handle {
                    folder.root_handle = handle;
                    changed = true;
                }
            }
        }

        if changed {
            self.save(path)?;
        }
        Ok(())
    }

    /// Repairs malformed local ids without merging distinct project sources.
    /// A directly opened folder and every `.code-workspace` file are separate
    /// projects even when their Agent root is the same physical directory.
    pub fn migrate_workspace_identities(&mut self, path: &Path) -> Result<()> {
        let mut changed = false;
        let mut ids = std::collections::HashSet::new();
        for workspace in &mut self.workspaces {
            if workspace.id.trim().is_empty() || !ids.insert(workspace.id.clone()) {
                workspace.id = format!("w_{}", uuid::Uuid::new_v4().simple());
                ids.insert(workspace.id.clone());
                changed = true;
            }
        }

        if changed {
            self.workspace_catalog_revision = self.workspace_catalog_revision.saturating_add(1);
            self.save(path)?;
        }
        Ok(())
    }

    /// Makes the catalogue generation durable before it is ever uploaded.
    ///
    /// Older configuration files predate this field. Generating an id only in
    /// memory would give them a different generation after every restart and
    /// make the Hub correctly reject what looked like a catalogue replacement.
    pub fn ensure_workspace_catalog_generation(&mut self, path: &Path) -> Result<()> {
        if self.workspace_catalog_generation.is_empty() {
            self.workspace_catalog_generation = format!("wcg_{}", uuid::Uuid::new_v4().simple());
            self.save(path)?;
        }
        Ok(())
    }

    /// Refreshes filesystem-derived catalogue facts under a new revision.
    ///
    /// The Hub rejects two different complete snapshots that claim the same
    /// revision. Sampling `.git` directly while serializing would therefore
    /// make a repository initialized between daemon restarts permanently
    /// conflict with its previous snapshot.
    pub fn refresh_workspace_catalog_facts(&mut self, path: &Path) -> Result<()> {
        let mut changed = false;
        for workspace in &mut self.workspaces {
            let is_git_repo = workspace.root.join(".git").exists();
            if workspace.is_git_repo != is_git_repo {
                workspace.is_git_repo = is_git_repo;
                changed = true;
            }
        }
        if changed {
            self.workspace_catalog_revision = self.workspace_catalog_revision.saturating_add(1);
            self.save(path)?;
        }
        Ok(())
    }
}

fn valid_workspace_root_handle(handle: &str) -> bool {
    handle.len() >= 3
        && handle.len() <= 128
        && handle.starts_with("r_")
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn new_workspace_root_handle<'a>(existing: impl Iterator<Item = &'a str>) -> String {
    let existing = existing.collect::<std::collections::HashSet<_>>();
    loop {
        let candidate = format!("r_{}", uuid::Uuid::new_v4().simple());
        if !existing.contains(candidate.as_str()) {
            return candidate;
        }
    }
}

/// Identity that must survive restarts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineState {
    pub machine_id: String,
    pub secret: String,
    /// Set once the machine is enrolled with a Hub.
    #[serde(default)]
    pub enrollment: Option<Enrollment>,
    /// Set once the owner points this machine at a relay to be reachable from
    /// outside. Independent of `enrollment`: self-hosting needs no Hub.
    #[serde(default)]
    pub rendezvous: Option<Rendezvous>,
}

/// A relay this machine waits at, and the token it needs to hang there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rendezvous {
    pub relay_url: String,
    #[serde(default)]
    pub join_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub hub_url: String,
    /// The Hub's id for this machine, shown in the owner's list.
    pub machine_id: String,
    pub daemon_id: String,
    /// Presented only to the Hub HTTPS boundary to mint short-lived uplink
    /// admissions. Only its hash is persisted by the Hub, and the reusable
    /// value must never be sent to a Relay.
    pub secret: String,
    /// Last workspace catalogue generation durably acknowledged by this Hub.
    ///
    /// This lives beside the enrollment rather than in `config.json`: if the
    /// local workspace registry is recreated, the daemon must still be able to
    /// name the generation it is replacing. Without that compare-and-swap an
    /// old process could overwrite a newer registry snapshot.
    #[serde(default)]
    pub workspace_catalog_generation: Option<String>,
}

impl MachineState {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path)
            .with_context(|| format!("reading machine state at {}", path.display()))?;
        serde_json::from_str(&raw)
            .with_context(|| format!("parsing machine state at {}", path.display()))
    }

    pub fn load_or_create(path: &Path) -> Result<Self> {
        if path.exists() {
            return Self::load(path);
        }
        let state = MachineState {
            machine_id: format!("m_{}", uuid::Uuid::new_v4().simple()),
            secret: uuid::Uuid::new_v4().simple().to_string(),
            enrollment: None,
            rendezvous: None,
        };
        state.save(path)?;
        Ok(state)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        save_private(path, serde_json::to_string_pretty(self)?.as_bytes())
    }

    /// Short, readable form of the machine identity for out-of-band comparison
    /// between the desktop tray and a browser that just connected.
    pub fn fingerprint(&self) -> String {
        let digest = simple_digest(format!("{}:{}", self.machine_id, self.secret).as_bytes());
        digest
            .chunks(2)
            .take(4)
            .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
            .collect::<Vec<_>>()
            .join("-")
    }
}

/** Writes secrets without a world-readable creation window and survives crashes. */
pub fn save_private(path: &Path, body: &[u8]) -> Result<()> {
    #[cfg(test)]
    if take_injected_save_failure(path) {
        anyhow::bail!("injected private-save failure for {}", path.display());
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    ensure_real_directory(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("private");
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut cleanup = PrivateTemp::new(tmp.clone());
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    restrict_to_owner(&tmp)?;
    file.write_all(body)?;
    file.sync_all()?;
    drop(file);
    replace_private(&tmp, path)?;
    cleanup.disarm();
    let metadata = sensitive_metadata(path)
        .with_context(|| format!("inspecting published private file {}", path.display()))?;
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() {
        anyhow::bail!("published private path is not a file: {}", path.display());
    }
    // Do not rely on rename ACL preservation; a failed protection step fails
    // the save closed even when the destination existed before this write.
    restrict_to_owner(path)?;
    // Persist the rename where the platform supports syncing directories.
    if let Ok(directory) = fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(test)]
static PRIVATE_SAVE_FAILURES: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<PathBuf>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn fail_next_private_save(path: &Path) {
    use std::collections::HashSet;
    use std::sync::Mutex;

    PRIVATE_SAVE_FAILURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .insert(path.to_path_buf());
}

#[cfg(test)]
fn take_injected_save_failure(path: &Path) -> bool {
    use std::collections::HashSet;
    use std::sync::Mutex;

    PRIVATE_SAVE_FAILURES
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .remove(path)
}

struct PrivateTemp(Option<PathBuf>);

impl PrivateTemp {
    fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for PrivateTemp {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = fs::remove_file(path);
        }
    }
}

/// A small non-cryptographic digest used only for display fingerprints.
///
/// Deliberately not used for anything that needs collision resistance; the
/// authentication path uses random secrets compared in full.
fn simple_digest(input: &[u8]) -> [u8; 16] {
    let mut out = [0u8; 16];
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for (i, byte) in input.iter().enumerate() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
        out[i % 16] ^= (hash >> ((i % 8) * 8)) as u8;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_config_reads_as_defaults_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("nope.json")).unwrap();
        assert_eq!(config.port, 0);
        assert!(!config.lan_enabled);
        assert!(!config.speech.stub_enabled);
    }

    #[test]
    fn config_survives_a_save_and_load_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut config = Config {
            port: 1234,
            ..Default::default()
        };
        config.speech.runtime = Some(SpeechRuntimeConfig {
            command: "/opt/genehub-speech/adapter".into(),
            args: vec!["--model".into(), "Qwen/Qwen3-ASR-1.7B-hf".into()],
        });
        config.speech.stub_enabled = true;
        config.workspaces.push(WorkspaceEntry {
            id: "w1".into(),
            name: "demo".into(),
            root: PathBuf::from("/tmp/demo"),
            folders: vec![WorkspaceFolderEntry {
                name: "demo".into(),
                root: PathBuf::from("/tmp/demo"),
                root_handle: "r_demo".into(),
            }],
            workspace_file: None,
            removed: false,
            is_git_repo: false,
        });
        config.save(&path).unwrap();

        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.port, 1234);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "demo");
        assert_eq!(loaded.speech.runtime, config.speech.runtime);
        assert!(loaded.speech.stub_enabled);
    }

    #[test]
    fn loading_removes_obsolete_cloud_speech_credentials_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{
                "port": 1234,
                "speech": {
                    "region": "beijing",
                    "dashscopeWorkspaceId": "legacy-workspace",
                    "apiKey": "legacy-secret",
                    "contextEnabled": false,
                    "pinnedTerms": ["GeneHub"],
                    "languageHints": ["zh"]
                },
                "futureField": {"keep": true}
            }"#,
        )
        .unwrap();

        let loaded = Config::load(&path).unwrap();

        assert!(!loaded.speech.context_enabled);
        assert_eq!(loaded.speech.pinned_terms, ["GeneHub"]);
        let rewritten = std::fs::read_to_string(&path).unwrap();
        assert!(!rewritten.contains("legacy-secret"));
        assert!(!rewritten.contains("legacy-workspace"));
        assert!(!rewritten.contains("dashscopeWorkspaceId"));
        assert!(!rewritten.contains("\"region\""));
        assert!(rewritten.contains("futureField"));
    }

    #[test]
    fn legacy_workspace_roots_are_migrated_once_to_folder_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let root = dir.path().join("project");
        let mut config = Config::default();
        config.workspaces.push(WorkspaceEntry {
            id: "w1".into(),
            name: "Project".into(),
            root: root.clone(),
            folders: Vec::new(),
            workspace_file: None,
            removed: false,
            is_git_repo: false,
        });
        config.save(&path).unwrap();

        let mut loaded = Config::load(&path).unwrap();
        loaded.migrate_workspace_folders(&path).unwrap();
        loaded.migrate_workspace_roots(&path).unwrap();
        assert_eq!(loaded.workspaces[0].folders.len(), 1);
        assert_eq!(loaded.workspaces[0].folders[0].root, root);
        assert!(loaded.workspaces[0].folders[0]
            .root_handle
            .starts_with("r_"));

        let saved = Config::load(&path).unwrap();
        assert_eq!(saved.workspaces[0].folders.len(), 1);
        assert_eq!(saved.workspace_roots.len(), 1);
        assert_eq!(
            saved.workspaces[0].folders[0].root_handle,
            saved.workspace_roots[0].handle
        );
    }

    #[test]
    fn folder_and_workspace_projects_keep_distinct_ids_but_share_global_roots() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let root = dir.path().join("product");
        let docs = dir.path().join("docs");
        let definition = dir.path().join("suite.code-workspace");
        let folder = WorkspaceFolderEntry {
            name: "product".into(),
            root: root.clone(),
            root_handle: String::new(),
        };
        let mut config = Config {
            workspaces: vec![
                WorkspaceEntry {
                    id: "w_folder".into(),
                    name: "product".into(),
                    root: root.clone(),
                    folders: vec![folder.clone()],
                    workspace_file: None,
                    removed: false,
                    is_git_repo: false,
                },
                WorkspaceEntry {
                    id: "w_suite".into(),
                    name: "suite".into(),
                    root: root.clone(),
                    folders: vec![
                        WorkspaceFolderEntry {
                            name: "Product".into(),
                            root: root.clone(),
                            root_handle: String::new(),
                        },
                        WorkspaceFolderEntry {
                            name: "Docs".into(),
                            root: docs,
                            root_handle: String::new(),
                        },
                    ],
                    workspace_file: Some(definition.clone()),
                    removed: true,
                    is_git_repo: false,
                },
            ],
            ..Config::default()
        };

        config.migrate_workspace_roots(&path).unwrap();
        config.migrate_workspace_identities(&path).unwrap();

        assert_eq!(config.workspaces.len(), 2);
        assert_eq!(config.workspaces[0].id, "w_folder");
        assert_eq!(config.workspaces[1].id, "w_suite");
        assert_eq!(
            config.workspaces[0].folders[0].root_handle,
            config.workspaces[1].folders[0].root_handle
        );
        assert_ne!(
            config.workspaces[0].folders[0].root_handle,
            config.workspaces[1].folders[1].root_handle
        );
        assert_eq!(config.workspace_roots.len(), 2);
        assert_eq!(config.workspace_catalog_revision, 0);
        assert_eq!(Config::load(&path).unwrap().workspaces.len(), 2);
    }

    #[test]
    fn malformed_root_handles_are_repaired_before_runtime_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let root = dir.path().join("project");
        let mut config = Config {
            workspace_roots: vec![WorkspaceRootEntry {
                handle: "../project".into(),
                root: root.clone(),
            }],
            workspaces: vec![WorkspaceEntry {
                id: "w_project".into(),
                name: "project".into(),
                root: root.clone(),
                folders: vec![WorkspaceFolderEntry {
                    name: "project".into(),
                    root,
                    root_handle: "../project".into(),
                }],
                workspace_file: None,
                removed: false,
                is_git_repo: false,
            }],
            ..Config::default()
        };

        config.migrate_workspace_roots(&path).unwrap();

        let handle = &config.workspace_roots[0].handle;
        assert!(valid_workspace_root_handle(handle));
        assert_eq!(config.workspaces[0].folders[0].root_handle, *handle);
        assert!(!handle.contains('/'));
    }

    #[test]
    fn private_save_atomically_replaces_the_same_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        save_private(&path, br#"{"version":1}"#).unwrap();
        save_private(&path, br#"{"version":2}"#).unwrap();
        assert_eq!(fs::read(&path).unwrap(), br#"{"version":2}"#);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn planted_sensitive_symlinks_never_touch_their_external_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let outer = tempfile::tempdir().unwrap();
        let victim_dir = outer.path().join("victim-dir");
        fs::create_dir(&victim_dir).unwrap();
        fs::set_permissions(&victim_dir, fs::Permissions::from_mode(0o755)).unwrap();
        let linked_root = outer.path().join("linked-data");
        symlink(&victim_dir, &linked_root).unwrap();
        assert!(Paths::new(&linked_root).ensure().is_err());
        assert_eq!(
            victim_dir.metadata().unwrap().permissions().mode() & 0o777,
            0o755
        );

        let root_with_linked_logs = outer.path().join("data-with-linked-logs");
        fs::create_dir(&root_with_linked_logs).unwrap();
        symlink(&victim_dir, root_with_linked_logs.join("logs")).unwrap();
        assert!(Paths::new(&root_with_linked_logs).ensure().is_err());
        assert_eq!(
            victim_dir.metadata().unwrap().permissions().mode() & 0o777,
            0o755
        );

        let root = outer.path().join("real-data");
        fs::create_dir(&root).unwrap();
        let victim_file = outer.path().join("victim.json");
        fs::write(&victim_file, b"outside secret").unwrap();
        fs::set_permissions(&victim_file, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&victim_file, root.join("config.json")).unwrap();
        assert!(Paths::new(&root).ensure().is_err());
        assert_eq!(fs::read(&victim_file).unwrap(), b"outside secret");
        assert_eq!(
            victim_file.metadata().unwrap().permissions().mode() & 0o777,
            0o644
        );

        let path = outer.path().join("published.json");
        let stale_fixed_temp = path.with_extension("json.tmp");
        symlink(&victim_file, &stale_fixed_temp).unwrap();
        save_private(&path, b"new private data").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new private data");
        assert_eq!(fs::read(&victim_file).unwrap(), b"outside secret");
        assert_eq!(
            victim_file.metadata().unwrap().permissions().mode() & 0o777,
            0o644
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_secrets_are_saved_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut config = Config::default();
        config.agents.providers.insert(
            "private".into(),
            ProviderConfig {
                api_key: Some("secret".into()),
                ..Default::default()
            },
        );
        config.save(&path).unwrap();
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_data_root_and_secret_files_have_protected_owner_only_dacls() {
        let parent = tempfile::tempdir().unwrap();
        let paths = Paths::new(parent.path().join("data"));
        let nested = paths.logs_dir().join("archive");
        let old_rotation = nested.join("daemon.log.1");
        let old_log = paths.logs_dir().join("old.log");
        fs::create_dir_all(&nested).unwrap();
        fs::write(&old_rotation, b"legacy log").unwrap();
        fs::write(&old_log, b"legacy log").unwrap();
        windows_acl::make_unprotected_for_test(&nested).unwrap();
        windows_acl::make_unprotected_for_test(&old_rotation).unwrap();
        windows_acl::make_unprotected_for_test(&old_log).unwrap();
        paths.ensure().unwrap();
        windows_acl::verify_owner_only(&paths.root, true).unwrap();
        windows_acl::verify_owner_only(&paths.logs_dir(), true).unwrap();
        windows_acl::verify_owner_only(&nested, true).unwrap();
        windows_acl::verify_owner_only(&old_rotation, false).unwrap();
        windows_acl::verify_owner_only(&old_log, false).unwrap();

        let mut config = Config::default();
        config.agents.providers.insert(
            "private".into(),
            ProviderConfig {
                api_key: Some("secret".into()),
                ..Default::default()
            },
        );
        config.save(&paths.config_file()).unwrap();
        config.port = 4242;
        config.save(&paths.config_file()).unwrap();
        assert_eq!(Config::load(&paths.config_file()).unwrap().port, 4242);
        windows_acl::verify_owner_only(&paths.config_file(), false).unwrap();
    }

    #[test]
    fn an_old_config_gets_one_durable_workspace_catalog_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"port":1234}"#).unwrap();

        let mut first = Config::load(&path).unwrap();
        assert!(first.workspace_catalog_generation.is_empty());
        first.ensure_workspace_catalog_generation(&path).unwrap();
        let generation = first.workspace_catalog_generation.clone();
        assert!(generation.starts_with("wcg_"));

        let mut restarted = Config::load(&path).unwrap();
        restarted
            .ensure_workspace_catalog_generation(&path)
            .unwrap();
        assert_eq!(restarted.workspace_catalog_generation, generation);
    }

    #[test]
    fn filesystem_catalog_facts_advance_the_revision_before_upload() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let path = dir.path().join("config.json");
        let mut config = Config::default();
        config.workspaces.push(WorkspaceEntry {
            id: "w1".into(),
            name: "project".into(),
            root: project.clone(),
            folders: vec![WorkspaceFolderEntry {
                name: "project".into(),
                root: project.clone(),
                root_handle: "r_project".into(),
            }],
            workspace_file: None,
            removed: false,
            is_git_repo: false,
        });

        config.refresh_workspace_catalog_facts(&path).unwrap();
        assert_eq!(config.workspace_catalog_revision, 0);
        std::fs::create_dir(project.join(".git")).unwrap();
        config.refresh_workspace_catalog_facts(&path).unwrap();
        assert!(config.workspaces[0].is_git_repo);
        assert_eq!(config.workspace_catalog_revision, 1);
        config.refresh_workspace_catalog_facts(&path).unwrap();
        assert_eq!(config.workspace_catalog_revision, 1);
    }

    /// The two roots must never be the same tree: uninstall deletes the data
    /// root, and the user's files are not ours to delete.
    #[test]
    fn the_working_folder_is_not_inside_the_data_folder() {
        let paths = Paths {
            root: PathBuf::from("/data/GeneHub"),
            default_workspace: Some(PathBuf::from("/home/me/GeneHub")),
        };
        let workspace = paths.default_workspace.unwrap();
        assert!(!workspace.starts_with(&paths.root));
    }

    #[test]
    fn a_test_gets_an_empty_machine_unless_it_asks_otherwise() {
        assert!(Paths::new("/tmp/whatever").default_workspace.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn daemon_data_and_sensitive_subdirectories_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let outer = tempfile::tempdir().unwrap();
        let root = outer.path().join("daemon-data");
        // Simulate an older build (or permissive umask) which left the data
        // directory traversable by other local accounts.
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        let paths = Paths::new(&root);
        paths.ensure().unwrap();

        for path in [&root, &paths.logs_dir()] {
            assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn machine_identity_is_stable_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let first = MachineState::load_or_create(&path).unwrap();
        let second = MachineState::load_or_create(&path).unwrap();
        assert_eq!(first.machine_id, second.machine_id);
        assert_eq!(first.fingerprint(), second.fingerprint());
        assert!(first.fingerprint().contains('-'));
    }
}
