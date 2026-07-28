//! Journey fixtures: a real daemon, a real workspace, a real client.
//!
//! One set of cases runs against either a mock model or a real one. The only
//! difference is the `baseUrl` handed to the agent, which is what keeps the
//! two modes on the same code path (`docs/testing.md` §2.1).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use genehub_proto::{Reply, Request, WorkspaceInfo};
use genet_daemon::config::{Config, Paths, ProviderConfig};
use genet_daemon::Daemon;

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
const REAL_MODEL: &str = "deepseek/deepseek-v4-flash";
const REAL_BASE_URL: &str = "https://api.deepseek.com/v1";

pub struct Journey {
    pub daemon: Daemon,
    pub client: Client,
    pub mock: Option<Arc<MockLlm>>,
    pub workspace: WorkspaceInfo,
    pub mode: Mode,
    /// Kept alive so the temporary tree outlives the test.
    _home: tempfile::TempDir,
    project: PathBuf,
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
    pub async fn start_with(
        mode: Mode,
        adjust: impl FnOnce(&mut Config),
    ) -> Result<Self> {
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
        let (provider, base_url, api_key) = match &mock {
            Some(mock) => (
                "deepseek".to_string(),
                Some(mock.base_url.clone()),
                Some("sk-mock".to_string()),
            ),
            None => (
                "deepseek".to_string(),
                Some(REAL_BASE_URL.to_string()),
                Some(real_api_key()?),
            ),
        };
        config.agents.providers.insert(
            provider,
            ProviderConfig { api_key, base_url },
        );
        adjust(&mut config);
        config.save(&data_dir.join("config.json"))?;

        // The daemon finds the agent next to its own binary in production; in a
        // test it lives in the cargo target directory instead.
        std::env::set_var("GENET_AGENT_COMMAND", agent_binary()?);

        let paths = Paths::new(&data_dir);
        let daemon = Daemon::start(paths).await.context("starting the daemon")?;
        let client = Client::connect(&daemon.websocket_url())
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
            daemon,
            client,
            mock,
            workspace,
            mode,
            _home: home,
            project,
        })
    }

    pub fn project(&self) -> &Path {
        &self.project
    }

    pub fn model_id(&self) -> String {
        match self.mode {
            // The mock accepts any id; using the real one keeps the two modes
            // as close as possible.
            Mode::Mock | Mode::Real => REAL_MODEL.to_string(),
        }
    }

    pub fn mock(&self) -> &MockLlm {
        self.mock
            .as_ref()
            .expect("this case is mock-only; guard it with mode.is_mock()")
    }

    /// Opens a session on the built-in agent, ready to receive a prompt.
    pub async fn session(&self, agent_id: &str) -> Result<String> {
        let reply = self
            .client
            .call(Request::SessionCreate {
                workspace_id: self.workspace.id.clone(),
                agent_id: agent_id.to_string(),
                model_id: Some(self.model_id()),
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
                    })
                    .await?;
                Ok(summary.id)
            }
            other => anyhow::bail!("expected a session, got {other:?}"),
        }
    }

    pub async fn send(&self, session_id: &str, text: &str) -> Result<()> {
        self.client
            .call(Request::SessionSend {
                session_id: session_id.to_string(),
                text: text.to_string(),
                attachments: vec![],
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
        self.daemon.shutdown().await;
        if let Some(mock) = self.mock {
            if let Ok(mock) = Arc::try_unwrap(mock) {
                mock.shutdown();
            }
        }
    }
}

/// Locates the agent binary cargo just built.
fn agent_binary() -> Result<PathBuf> {
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
    let candidate = target_dir.join(if cfg!(windows) {
        "genet-agent.exe"
    } else {
        "genet-agent"
    });
    if !candidate.is_file() {
        anyhow::bail!(
            "the agent binary is missing at {}; run `cargo build --workspace` first",
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
