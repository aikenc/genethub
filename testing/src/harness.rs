//! Journey fixtures: a real daemon, a real workspace, a real client.
//!
//! One set of cases runs against either a mock model or a real one. The only
//! difference is the `baseUrl` handed to the agent, which is what keeps the
//! two modes on the same code path (`docs/testing.md` §2.1).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use genehub_proto::{Reply, Request, WorkspaceInfo};
use genet_daemon::config::Paths;
use genet_daemon::Daemon;
use serde::Serialize;

use crate::client::Client;
use crate::mock_llm::MockLlm;

/// Which model backs this run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Mock,
    Real,
}

impl Mode {
    /// Reads `JOURNEY_LLM`. Defaults to mock so a bare `cargo test` is free,
    /// offline and deterministic.
    pub fn from_env() -> Self {
        match std::env::var("JOURNEY_LLM").unwrap_or_default().as_str() {
            "real" => Mode::Real,
            _ => Mode::Mock,
        }
    }

    pub fn is_mock(self) -> bool {
        self == Mode::Mock
    }
}

/// The model used in real mode, and the key it needs.
///
/// Public because the mock reports having this same model when the daemon asks
/// it for a list: the picker a journey chooses from is built from that answer,
/// so the two have to agree.
pub const REAL_MODEL: &str = "deepseek/deepseek-v4-flash";
const REAL_BASE_URL: &str = "https://api.deepseek.com/v1";

/// Where the model actually lives for this run.
///
/// Third-party agents keep their own credentials, so a journey that drives one
/// has to hand it the same backend the built-in agent got. Exposing it here is
/// what lets those cases run in both modes without knowing which one they are in.
#[derive(Debug, Clone)]
pub struct ModelBackend {
    pub base_url: String,
    pub api_key: String,
    /// Provider-qualified, as the daemon reports it: `provider/model`.
    pub model_id: String,
}

/// Complete first-start fixture consumed by both sides of the split.
///
/// Native startup reads only `port` and `lan_enabled`; the copy-once migration
/// places the same JSON in the portable store, where the signed application
/// reads provider and replay policy. Keeping this as a test-only wire fixture
/// prevents journeys from reaching into either implementation's Rust objects.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub port: u16,
    pub lan_enabled: bool,
    pub agents: AgentsConfig,
    pub replay_window: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub label: Option<String>,
    pub dialect: Option<String>,
    pub models: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: 0,
            lan_enabled: false,
            agents: AgentsConfig::default(),
            replay_window: 2048,
        }
    }
}

impl ModelBackend {
    /// The model id without the provider prefix, for agents that name their
    /// providers themselves.
    pub fn bare_id(&self) -> &str {
        self.model_id
            .split_once('/')
            .map(|(_, id)| id)
            .unwrap_or(&self.model_id)
    }
}

pub struct Journey {
    /// `Option` only so a restart can take it: `shutdown` consumes the daemon.
    daemon: Option<Daemon>,
    pub client: Client,
    pub mock: Option<Arc<MockLlm>>,
    pub workspace: WorkspaceInfo,
    pub mode: Mode,
    pub model: ModelBackend,
    /// Kept alive so the temporary tree outlives the test.
    _home: tempfile::TempDir,
    project: PathBuf,
    data_dir: PathBuf,
}

impl Journey {
    /// Where the daemon keeps its logs, for tests about reading them back.
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    /// A session's own directory, inside the workspace it belongs to
    /// (`docs/session-storage.md` §3).
    pub fn session_dir(&self, session_id: &str) -> PathBuf {
        // The registered root, not the path the test handed over: the daemon
        // canonicalises on open, and on some platforms that is a different
        // string for the same directory.
        Path::new(&self.workspace.root)
            .join(".genethub")
            .join("sessions")
            .join(session_id)
    }

    /// The round rows of a session's chat layer, read straight off disk as
    /// JSON rather than through the wire protocol — there is no query API for
    /// them yet (`docs/agent-analysis-substrate-proposal.md` §8 steps 7-9).
    ///
    /// Folded the way a reader folds them: a round is written once when it
    /// opens and again when it settles, and the last write wins. An empty
    /// vector both when the file is missing and when it is empty, since a
    /// journey asserting "nothing recorded yet" should not have to care which.
    pub fn round_records(&self, session_id: &str) -> Vec<serde_json::Value> {
        let Ok(contents) = std::fs::read_to_string(self.session_dir(session_id).join("chat.jsonl"))
        else {
            return Vec::new();
        };
        let mut rounds: Vec<serde_json::Value> = Vec::new();
        for line in contents.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            if row["t"] != serde_json::json!("round") {
                continue;
            }
            let round = row["round"].clone();
            match rounds
                .iter_mut()
                .find(|existing| existing["roundId"] == round["roundId"])
            {
                Some(existing) => *existing = round,
                None => rounds.push(round),
            }
        }
        rounds
    }

    /// One round's trunk summaries, from that round's own index file.
    pub fn trunk_summaries(&self, session_id: &str, ord: u32) -> Vec<serde_json::Value> {
        let path = self
            .session_dir(session_id)
            .join("rounds")
            .join(format!("r-{ord:03}"))
            .join("index.jsonl");
        let Ok(contents) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        let mut summaries: Vec<serde_json::Value> = Vec::new();
        for line in contents.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(summary) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            match summaries
                .iter_mut()
                .find(|existing| existing["index"] == summary["index"])
            {
                Some(existing) => *existing = summary,
                None => summaries.push(summary),
            }
        }
        summaries
    }
}

impl Journey {
    pub async fn start() -> Result<Self> {
        Journey::start_with(Mode::from_env(), |_| {}).await
    }

    pub async fn start_in_mode(mode: Mode) -> Result<Self> {
        Journey::start_with(mode, |_| {}).await
    }

    /// Builds a journey, letting the caller adjust config before the daemon
    /// starts (used by cases that need LAN on, a tiny replay window, and so on).
    pub async fn start_with(mode: Mode, adjust: impl FnOnce(&mut Config)) -> Result<Self> {
        let home = tempfile::tempdir().context("creating the journey home")?;
        let data_dir = home.path().join("data");
        let project = home.path().join("project");
        std::fs::create_dir_all(&project)?;
        std::fs::create_dir_all(&data_dir)?;

        let mock = match mode {
            Mode::Mock => Some(Arc::new(MockLlm::start().await?)),
            Mode::Real => None,
        };

        let mut config = Config::default();
        let model = ModelBackend {
            base_url: match &mock {
                Some(mock) => mock.base_url.clone(),
                None => REAL_BASE_URL.to_string(),
            },
            api_key: match &mock {
                Some(_) => "sk-mock".to_string(),
                None => real_api_key()?,
            },
            // The mock accepts any id; using the real one keeps the two modes
            // as close as possible.
            model_id: REAL_MODEL.to_string(),
        };
        config.agents.providers.insert(
            "deepseek".to_string(),
            ProviderConfig {
                api_key: Some(model.api_key.clone()),
                base_url: Some(model.base_url.clone()),
                // Left empty on purpose: the daemon asks the address for its
                // models, and in mock mode that address is the mock. Writing the
                // list here instead would leave discovery — the thing every real
                // install depends on for its picker — untested.
                ..Default::default()
            },
        );
        adjust(&mut config);
        std::fs::write(
            data_dir.join("config.json"),
            serde_json::to_vec_pretty(&config)?,
        )?;

        // The daemon finds the agent next to its own binary in production; in a
        // test it lives in the cargo target directory instead. Both the binary
        // name and the override variable are the stamped ones — a dev tree
        // builds `genet-agent-dev` and listens for `GENET_AGENT_DEV_COMMAND`.
        let (env_name, binary) = agent_command_override()?;
        std::env::set_var(env_name, binary);

        let paths = Paths::new(&data_dir);
        let daemon = Daemon::start(paths).await.context("starting the daemon")?;
        let client = Client::connect_loopback(&daemon)
            .await
            .context("connecting to the daemon")?;
        client.hello("journey").await?;

        let workspace = match client
            .call(Request::WorkspaceOpen {
                root: project.display().to_string(),
            })
            .await?
        {
            Reply::Workspace(workspace) => workspace,
            other => anyhow::bail!("expected a workspace, got {other:?}"),
        };

        Ok(Journey {
            daemon: Some(daemon),
            client,
            mock,
            workspace,
            mode,
            model,
            _home: home,
            project,
            data_dir,
        })
    }

    pub fn project(&self) -> &Path {
        &self.project
    }

    pub fn daemon(&self) -> &Daemon {
        self.daemon.as_ref().expect("the daemon is running")
    }

    /// Stops the daemon and starts another one on the same data directory.
    ///
    /// This is the thing a user does without thinking — quit the app, come back
    /// later — and the only honest way to test that sessions live on disk
    /// rather than in memory. The new daemon mints a new token and picks a new
    /// port, so the client has to be rebuilt too; that is also true of the real
    /// desktop shell, which is why it tells the workbench where the daemon went.
    pub async fn restart_daemon(&mut self) -> Result<()> {
        if let Some(daemon) = self.daemon.take() {
            daemon.shutdown().await;
        }
        let daemon = Daemon::start(Paths::new(&self.data_dir))
            .await
            .context("restarting the daemon")?;
        let client = Client::connect_loopback(&daemon)
            .await
            .context("reconnecting after the restart")?;
        client.hello("journey").await?;

        let previous = std::mem::replace(&mut self.client, client);
        previous.close().await;
        self.daemon = Some(daemon);
        Ok(())
    }

    pub fn model_id(&self) -> String {
        self.model.model_id.clone()
    }

    /// Opens a session on a specific agent and model, for cases that drive a
    /// third-party agent naming its own provider.
    pub async fn session_with_model(&self, agent_id: &str, model_id: &str) -> Result<String> {
        let reply = self
            .client
            .call(Request::SessionCreate {
                workspace_id: self.workspace.id.clone(),
                agent_id: agent_id.to_string(),
                model_id: Some(model_id.to_string()),
                mode_id: None,
                title: None,
            })
            .await?;
        match reply {
            Reply::Session(summary) => {
                self.client
                    .call(Request::Subscribe {
                        session_id: summary.id.clone(),
                        since_seq: None,
                        expand_last_round: false,
                    })
                    .await?;
                Ok(summary.id)
            }
            other => anyhow::bail!("expected a session, got {other:?}"),
        }
    }

    pub fn mock(&self) -> &MockLlm {
        self.mock
            .as_ref()
            .expect("this case is mock-only; guard it with mode.is_mock()")
    }

    /// Opens a session on an agent, ready to receive a prompt.
    pub async fn session(&self, agent_id: &str) -> Result<String> {
        self.session_with_model(agent_id, &self.model_id()).await
    }

    pub async fn send(&self, session_id: &str, text: &str) -> Result<()> {
        self.send_continuing(session_id, text, None).await
    }

    /// Same as `send`, with an explicit `continuesRound` — for journeys that
    /// exercise the "interrupted, then the client says whether this is the
    /// same request" path (`docs/agent-analysis-substrate-proposal.md` §3.2).
    pub async fn send_continuing(
        &self,
        session_id: &str,
        text: &str,
        continues_round: Option<&str>,
    ) -> Result<()> {
        self.client
            .call(Request::SessionSend {
                session_id: session_id.to_string(),
                text: text.to_string(),
                attachments: vec![],
                artifact_preview_base_url: None,
                continues_round: continues_round.map(str::to_string),
            })
            .await?;
        Ok(())
    }

    pub fn write_file(&self, relative: &str, contents: &str) -> Result<()> {
        let path = self.project.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
        Ok(())
    }

    pub fn read_file(&self, relative: &str) -> Option<String> {
        std::fs::read_to_string(self.project.join(relative)).ok()
    }

    pub fn file_exists(&self, relative: &str) -> bool {
        self.project.join(relative).exists()
    }

    /// Turns the project into a git repository with one commit.
    pub async fn init_git(&self) -> Result<()> {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "journey@example.com"],
            vec!["config", "user.name", "Journey"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            tokio::process::Command::new("git")
                .args(args)
                .current_dir(&self.project)
                .output()
                .await?;
        }
        self.write_file("README.md", "# project\n")?;
        tokio::process::Command::new("git")
            .args(["add", "-A"])
            .current_dir(&self.project)
            .output()
            .await?;
        tokio::process::Command::new("git")
            .args(["commit", "-qm", "initial"])
            .current_dir(&self.project)
            .output()
            .await?;
        Ok(())
    }

    pub async fn finish(self) {
        self.client.close().await;
        if let Some(daemon) = self.daemon {
            daemon.shutdown().await;
        }
        if let Some(mock) = self.mock {
            if let Ok(mock) = Arc::try_unwrap(mock) {
                mock.shutdown();
            }
        }
    }
}

/// The agent override as the daemon expects it: the env variable name and the
/// binary to point it at. Both names come from `scripts/channel.env` — the
/// stamp decides what a binary is called, and this harness follows the stamp
/// rather than pinning a channel's names here.
fn agent_command_override() -> Result<(String, PathBuf)> {
    let channel = channel_env()?;
    let env_name = channel
        .get("ENV_AGENT_COMMAND")
        .context("scripts/channel.env has no ENV_AGENT_COMMAND")?
        .to_string();
    let binary = agent_binary(
        channel
            .get("AGENT_BINARY")
            .context("scripts/channel.env has no AGENT_BINARY")?,
    )?;
    Ok((env_name, binary))
}

/// `KEY=value` from `scripts/channel.env`, the file the stamper writes for
/// exactly this kind of consumer.
fn channel_env() -> Result<std::collections::HashMap<String, String>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("no repository root")?
        .join("scripts/channel.env");
    let contents = std::fs::read_to_string(&path)
        .with_context(|| format!("{} could not be read", path.display()))?;
    let mut values = std::collections::HashMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            values.insert(
                key.to_string(),
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string(),
            );
        }
    }
    Ok(values)
}

/// Locates the agent binary cargo just built.
fn agent_binary(name: &str) -> Result<PathBuf> {
    if let Ok(explicit) = std::env::var("GENET_AGENT_BINARY") {
        return Ok(PathBuf::from(explicit));
    }
    // The test executable lives in `target/<profile>/deps/`, so the binaries
    // built alongside it are two levels up.
    let exe = std::env::current_exe().context("locating the test executable")?;
    let target_dir = exe
        .parent()
        .and_then(|deps| deps.parent())
        .context("unexpected target layout")?;
    let file_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = target_dir.join(&file_name);
    if !candidate.is_file() {
        // `cargo test` compiles other packages as test harnesses without ever
        // producing their executables, so this is the normal state of a fresh
        // checkout rather than a broken one — say what to run.
        anyhow::bail!(
            "the agent binary is missing at {}; run `cargo build --workspace --bins` first",
            candidate.display()
        );
    }
    Ok(candidate)
}

/// Reads the real key from the environment or the repository `.env`.
///
/// The file is gitignored and must stay that way; this only reads it.
fn real_api_key() -> Result<String> {
    if let Ok(key) = std::env::var("DEEPSEEK_API_KEY") {
        if !key.is_empty() {
            return Ok(key);
        }
    }
    let env_file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .context("no repository root")?
        .join(".env");
    let contents = std::fs::read_to_string(&env_file).with_context(|| {
        format!(
            "JOURNEY_LLM=real needs DEEPSEEK_API_KEY, and {} could not be read",
            env_file.display()
        )
    })?;
    for line in contents.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("DEEPSEEK_API_KEY=") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Ok(value.to_string());
            }
        }
    }
    anyhow::bail!("DEEPSEEK_API_KEY is not set and was not found in .env")
}

/// Skips a case that needs a real provider when the mock is standing in.
#[macro_export]
macro_rules! real_only {
    ($journey:expr) => {
        if $journey.mode.is_mock() {
            eprintln!(
                "skipping {}: only a real provider can reject us for real",
                module_path!()
            );
            $journey.finish().await;
            return;
        }
    };
}

/// Skips a mock-only case in real mode, printing why.
///
/// `docs/testing.md` §2.2 asks for the reason to be recorded rather than the
/// case quietly disappearing from the run.
#[macro_export]
macro_rules! mock_only {
    ($journey:expr) => {
        if !$journey.mode.is_mock() {
            eprintln!(
                "skipping {}: needs fault injection, which only the mock can do",
                module_path!()
            );
            $journey.finish().await;
            return;
        }
    };
}
