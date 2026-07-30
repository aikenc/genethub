//! Configuration and the on-disk layout.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Where everything the daemon owns lives.
///
/// One root keeps uninstall honest: removing it removes every trace, which is
/// an explicit item on the install self-check in `docs/testing.md` §7. The
/// folder the agent works in is deliberately *not* under it — that one holds
/// the user's own files and must survive an uninstall.
#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    /// Where the agent works until the user points it somewhere else.
    ///
    /// `None` means do not invent one, which is what a test wants: an empty
    /// machine that registers exactly the directories the test asked for.
    pub default_workspace: Option<PathBuf>,
}

impl Paths {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Paths {
            root: root.into(),
            default_workspace: None,
        }
    }

    /// `$GENEHUB_DATA_DIR`, else the platform data directory.
    ///
    /// The override exists so every test can run against its own directory;
    /// shared state between tests costs far more to debug than it saves.
    pub fn discover() -> Result<Self> {
        let root = match std::env::var("GENEHUB_DATA_DIR") {
            Ok(dir) => PathBuf::from(dir),
            Err(_) => dirs::data_dir()
                .context("no platform data directory")?
                .join("GeneHub"),
        };
        Ok(Paths {
            root,
            default_workspace: Some(default_workspace()?),
        })
    }

    pub fn config_file(&self) -> PathBuf {
        self.root.join("config.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }

    pub fn lock_file(&self) -> PathBuf {
        self.root.join("daemon.lock")
    }

    /// Holds the loopback port and token for same-machine clients.
    pub fn endpoint_file(&self) -> PathBuf {
        self.root.join("endpoint.json")
    }

    /// Who is allowed to reach this machine from outside.
    pub fn devices_file(&self) -> PathBuf {
        self.root.join("devices.json")
    }

    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.root)
            .with_context(|| format!("creating data directory {}", self.root.display()))?;
        fs::create_dir_all(self.sessions_dir())?;
        Ok(())
    }
}

/// `$GENEHUB_WORKSPACE_DIR`, else `GeneHub` in the user's home.
///
/// It sits in the home directory rather than somewhere hidden because the user
/// is expected to open it, drop files in it, and point their own editor at it.
fn default_workspace() -> Result<PathBuf> {
    if let Ok(dir) = std::env::var("GENEHUB_WORKSPACE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = dirs::home_dir().context("no home directory")?;
    Ok(home.join("GeneHub"))
}

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
    pub workspaces: Vec<WorkspaceEntry>,
    /// How many events per session stay replayable after a disconnect.
    pub replay_window: usize,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 0,
            lan_enabled: false,
            agents: AgentsConfig::default(),
            workspaces: Vec::new(),
            replay_window: 2048,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub id: String,
    pub name: String,
    pub root: PathBuf,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read_to_string(path) {
            Ok(raw) => {
                serde_json::from_str(&raw).with_context(|| format!("parsing {}", path.display()))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let body = serde_json::to_string_pretty(self)?;
        // Write-then-rename so a crash mid-write cannot leave a truncated
        // config that would make the daemon unstartable.
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, body)?;
        fs::rename(&tmp, path)?;
        Ok(())
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
    pub uplink_url: String,
    pub daemon_id: String,
    /// Presented on the uplink. Only its hash ever left this machine.
    pub secret: String,
}

impl Enrollment {
    /// What goes in the uplink's `Authorization` header.
    pub fn ticket(&self) -> String {
        format!("{}.{}", self.daemon_id, self.secret)
    }
}

impl MachineState {
    pub fn load_or_create(path: &Path) -> Result<Self> {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(state) = serde_json::from_str(&raw) {
                return Ok(state);
            }
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
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(self)?)?;
        restrict_to_owner(path)?;
        Ok(())
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

#[cfg(unix)]
pub fn restrict_to_owner(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
pub fn restrict_to_owner(_path: &Path) -> Result<()> {
    // Windows inherits the user profile ACL, which already excludes other users.
    Ok(())
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
    }

    #[test]
    fn config_survives_a_save_and_load_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut config = Config {
            port: 1234,
            ..Default::default()
        };
        config.workspaces.push(WorkspaceEntry {
            id: "w1".into(),
            name: "demo".into(),
            root: PathBuf::from("/tmp/demo"),
        });
        config.save(&path).unwrap();

        let loaded = Config::load(&path).unwrap();
        assert_eq!(loaded.port, 1234);
        assert_eq!(loaded.workspaces.len(), 1);
        assert_eq!(loaded.workspaces[0].name, "demo");
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
